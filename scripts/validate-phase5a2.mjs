#!/usr/bin/env node
/**
 * EVOLVE Phase 5A.2 validation suite — research cohort correctness and
 * experimental quality.
 *
 * Covers: CLI boolean parsing, research genome uniqueness (digest identity),
 * deterministic diversification inside declared proposal ranges, research
 * novelty/uniqueness metrics, species reachability and the anti-collapse
 * concentration guard, role-level metrics, first-class Arena provenance,
 * stage/gate status semantics, challenger vs fair cohort modes, exact-identity
 * vs descendant-ancestry, distinct-mint diagnostics, and paper-only safety.
 *
 * Dependency-free and fully offline: the default `mock` research provider needs
 * no LLM API key and no network access. Same convention as validate-arena.mjs /
 * validate-phase41.mjs / validate-phase5a.mjs.
 *
 * Run with: npm run validate:phase5a2
 */

import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseArgs } from "./lib/args.mjs";
import { createSeededRandom } from "./lib/random.mjs";
import { digestOf } from "./lib/hash.mjs";
import { createMarketConfig } from "./market/config.mjs";
import { makeFixture } from "./make-fixture.mjs";
import { SPECIES, GENOME_KEYS, GENE_BOUNDS } from "./engine/genome.mjs";
import { FAMILY_NAMES, CANDIDATE_FAMILIES, resolveFamily } from "./engine/families.mjs";
import {
  ARENA_STAGE,
  CANDIDATE_STATUS,
  DEFAULT_DEPLOYMENT_GATES,
  GATE_STATUS,
  TOURNAMENT_STAGE_ORDER,
  buildDistinctMintDiagnostics,
  buildDatasetRegistry,
  evaluateSurvivalGates,
  explainDistinctMintShortfall,
  registrySummary,
  realEvidenceDatasets,
} from "./arena/orchestrator.mjs";
import { buildEntrantPool, runArenaTournament } from "./arena/tournament.mjs";
import {
  RESEARCH_ARENA_MODE,
  RESEARCH_IDENTITY,
  buildResearchCohort,
  composeFairCohort,
  descendantResearchMeta,
  exactResearchMeta,
  mergeResearchAncestry,
  researchEntrantsFromCohort,
  researchProvenance,
  summarizeResearchCohort,
} from "./arena/research-cohort.mjs";
import {
  RESEARCH_COHORT_DEFAULTS,
  cohortUniquenessVerdict,
  dedupeByGenomeDigest,
  genomeDigestOf,
  ratioEnv,
  speciesConcentrationVerdict,
  speciesDistribution,
  uniqueGenomeRatio,
} from "./research/cohort.mjs";
import { compileProposals, COMPILER_LIMITS, DUPLICATE_GENOME, deterministicInRange, hasDiversifiableRange } from "./research/compiler.mjs";
import { validateProposal, PROPOSAL_SCHEMA_VERSION } from "./research/proposal-schema.mjs";
import {
  ADVISORY_ROLES,
  PROPOSING_ROLES,
  mockProviderPropose,
  resolveProposalTarget,
} from "./research/provider.mjs";
import { runResearchCycle, buildEvidencePacket } from "./research/cycle.mjs";
import {
  MEMORY_OUTCOME,
  MEMORY_STATUS,
  createMemoryRecord,
  appendMemoryRecord,
  listCompiledCandidates,
  readMemoryIndex,
  roleResearchMetrics,
  saveCompiledCandidate,
} from "./research/memory.mjs";
import { isQuarantined, memoryStatusForArenaRow, promoteFromArenaLeaderboard } from "./research/promote.mjs";

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
function assertNoNonFinite(value, label = "root") {
  if (value === null || value === undefined) return;
  if (typeof value === "number") {
    assert(Number.isFinite(value), `non-finite number at ${label}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoNonFinite(item, `${label}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) assertNoNonFinite(item, `${label}.${key}`);
  }
}

/* ============================================================================
 * Fixtures
 * ==========================================================================*/

async function withTempRoot(prefix, fn) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

function tinyConfig(extra = {}) {
  const config = createMarketConfig(
    {
      EVOLVE_MARKET_MODE: "synthetic",
      EVOLVE_WF_TRAIN_MINUTES: "10",
      EVOLVE_WF_VALIDATE_MINUTES: "5",
      EVOLVE_WF_TEST_MINUTES: "5",
      EVOLVE_WF_STEP_MINUTES: "5",
      EVOLVE_MIN_TRADES: "1",
      EVOLVE_MIN_DISTINCT_MINTS: "1",
      EVOLVE_MIN_OBSERVATIONS: "5",
      EVOLVE_MIN_EXPOSURE_TICKS: "2",
      EVOLVE_SYNTHETIC_UNIVERSE: "10",
    },
    { loadEnv: false },
  );
  // createMarketConfig returns a frozen document, so arena gates are merged
  // into a new object rather than assigned onto it.
  return {
    ...config,
    arena: {
      gates: {
        minTrades: 1,
        minDistinctMints: 1,
        minRealDatasets: 0,
        minOosWindows: 1,
        minSeeds: 1,
        minStressSurvived: 0,
        maxDrawdown: 1,
        maxTopMintShare: 1,
        minArenaScore: 0,
        requireNoCatastrophic: false,
        requireMildStressSurvival: false,
      },
    },
    ...extra,
  };
}

async function withFixture(fn, { snapshots = 30, tokenCount = 10, seed = "phase5a2" } = {}) {
  return withTempRoot("evolve-phase5a2-", async (root) => {
    const dir = path.join(root, "fixture");
    await makeFixture({ dir, snapshots, intervalMs: 60_000, seed, tokenCount });
    const registry = await buildDatasetRegistry(root);
    const datasets = registry.map((entry) => ({
      dir: entry.dir,
      id: entry.datasetId,
      fingerprint: entry.fingerprint,
      sourceType: entry.sourceType,
      regimesByWindow: {},
    }));
    return fn({ root, dir, registry, datasets });
  });
}

function validProposal(overrides = {}) {
  return {
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    proposalId: overrides.proposalId ?? "P-5a2-0001",
    authorRole: overrides.authorRole ?? "signal-researcher",
    hypothesis: overrides.hypothesis ?? "Momentum combined with wallet flow persists when organic buyers keep accumulating.",
    targetRegimes: overrides.targetRegimes ?? ["weak-risk-on"],
    abstainRegimes: overrides.abstainRegimes ?? [],
    parentFamilies: overrides.parentFamilies ?? ["Momentum x Wallet Flow"],
    changes: overrides.changes ?? { momentumWeight: [0.3, 0.5], flowWeight: 0.4 },
    rationale: overrides.rationale ?? "derived from observed regime and family statistics in this cycle",
    risks: overrides.risks ?? ["regime dependence"],
    ...(overrides.targetSpecies ? { targetSpecies: overrides.targetSpecies } : {}),
  };
}

const EMPTY_EVIDENCE = buildEvidencePacket({
  snapshot: { species: [], researchRegime: null, topAgents: [], paper: { costs: 0, startingCash: 100 }, stats: { population: 48 } },
  islands: [],
  priorConclusions: [],
  cycle: 1,
});

function providerProposals({ count = 6, seed = "5a2", cycle = 1, evidence = EMPTY_EVIDENCE } = {}) {
  return mockProviderPropose({ evidence, count, seed, cycle });
}

function validatedProviderProposals(options = {}) {
  const out = [];
  for (const raw of providerProposals(options)) {
    const { ok, proposal } = validateProposal(raw);
    if (ok) out.push(proposal);
  }
  return out;
}

/* ============================================================================
 * A. CLI boolean parsing
 * ==========================================================================*/

const ARENA_FLAGS = { booleanFlags: ["research", "no-cache"], valueFlags: ["research-mode", "max-windows"] };

test("1. `--research DATASET` sets research=true and keeps the dataset positional", () => {
  const args = parseArgs(["--research", "DATASET"], ARENA_FLAGS);
  assertEqual(args.research, true, "research must be the boolean true, not the dataset string");
  assertEqual(args._.length, 1, "the dataset must remain a positional argument");
  assertEqual(args._[0], "DATASET", "the positional must be exactly the requested dataset");
});

test("2. `DATASET --research` means the same thing", () => {
  const args = parseArgs(["DATASET", "--research"], ARENA_FLAGS);
  assertEqual(args.research, true, "a trailing boolean flag must still be true");
  assertEqual(args._[0], "DATASET", "the leading dataset must stay positional");
});

test("3. `--research=true DATASET` means the same thing", () => {
  const args = parseArgs(["--research=true", "DATASET"], ARENA_FLAGS);
  assertEqual(args.research, true, "an explicit =true must parse as boolean true");
  assertEqual(args._[0], "DATASET", "the dataset must stay positional");
});

test("4. Exact requested dataset count is preserved for every spelling", () => {
  for (const argv of [
    ["--research", "A", "B"],
    ["A", "B", "--research"],
    ["--research=true", "A", "B"],
  ]) {
    const args = parseArgs(argv, ARENA_FLAGS);
    assertEqual(args.research, true, `research must be true for ${JSON.stringify(argv)}`);
    assertEqual(args._.length, 2, `exactly two datasets must be selected for ${JSON.stringify(argv)}`);
    assertEqual(args._.join(","), "A,B", "dataset order must be preserved");
  }
});

test("5. `--research=false` disables research without eating a positional; `--no-research` also works", () => {
  const off = parseArgs(["--research=false", "A"], ARENA_FLAGS);
  assertEqual(off.research, false, "an explicit =false must parse as boolean false");
  assertEqual(off._[0], "A", "the dataset must stay positional");
  const negated = parseArgs(["--no-research", "A"], ARENA_FLAGS);
  assertEqual(negated.research, false, "--no-research must negate a known boolean flag");
  assertEqual(negated._[0], "A", "the dataset must stay positional");
});

test("6. Flags that legitimately take a value still receive one", () => {
  const args = parseArgs(["--research-mode", "fair", "--max-windows", "3", "A"], ARENA_FLAGS);
  assertEqual(args["research-mode"], "fair", "a value flag must keep its value");
  assertEqual(args["max-windows"], "3", "a declared value flag must keep its value");
  assertEqual(args._.join(","), "A", "the dataset stays positional");
  const unknown = parseArgs(["--seed", "abc"], ARENA_FLAGS);
  assertEqual(unknown.seed, "abc", "an unknown flag followed by a token still takes a value (backwards compatible)");
  const lone = parseArgs(["--verbose"], ARENA_FLAGS);
  assertEqual(lone.verbose, true, "an unknown flag with nothing after it is a boolean");
});

/* ============================================================================
 * B. Research genome uniqueness (digest identity)
 * ==========================================================================*/

test("7. Duplicate compiled genomes do not consume multiple cohort slots", () => {
  const genome = { riskFraction: 0.1, stopLoss: 0.05 };
  const digest = digestOf(genome);
  const entries = [
    { familyId: "F-a", proposalId: "P-a", genome },
    { familyId: "F-b", proposalId: "P-b", genome },
    { familyId: "F-c", proposalId: "P-c", genome },
    { familyId: "F-d", proposalId: "P-d", genome: { riskFraction: 0.2 } },
  ];
  const { unique, duplicates, uniqueDigests } = dedupeByGenomeDigest(entries);
  assertEqual(unique.length, 2, "only two genuinely distinct genomes may survive");
  assertEqual(duplicates.length, 2, "the two duplicate artifacts must be reported");
  assertEqual(uniqueDigests.length, 2, "unique digest count must match unique entries");
  assert(unique.every((row) => row.genomeDigest), "every unique entry must carry its canonical genome digest");
  assertEqual(unique[0].genomeDigest, digest, "the first occurrence wins by canonical digest");
});

test("8. Duplicate genome rejection is deterministic", () => {
  const proposals = [
    validProposal({ proposalId: "P-dup-1", changes: { flowWeight: 0.42 } }),
    validProposal({ proposalId: "P-dup-2", changes: { flowWeight: 0.42 } }),
    validProposal({ proposalId: "P-dup-3", changes: { flowWeight: 0.42 } }),
  ];
  const a = compileProposals({ proposals, maxCompilations: 10 });
  const b = compileProposals({ proposals, maxCompilations: 10 });
  assertEqual(JSON.stringify(a), JSON.stringify(b), "identical input must produce identical compiled output and rejections");
  // Scalars cannot be diversified faithfully, so the duplicates are rejected.
  assertEqual(a.compiled.length, 1, "a proposal with no declared range cannot be diversified");
  assertEqual(a.rejected.filter((row) => row.code === DUPLICATE_GENOME).length, 2, "both duplicates must be rejected as DUPLICATE_GENOME");
});

test("9. Deterministic diversification stays inside the declared range and inside compiler bounds", () => {
  const a = validProposal({ proposalId: "P-div-1", changes: { riskFraction: [0.05, 0.1] } });
  const b = validProposal({ proposalId: "P-div-2", changes: { riskFraction: [0.05, 0.1] } });
  const { compiled } = compileProposals({ proposals: [a, b], maxCompilations: 4 });
  assertEqual(compiled.length, 2, "two distinct proposals in the same region must both compile");
  const second = compiled.find((row) => row.proposalId === "P-div-2");
  assert(second, "the second proposal must be represented");
  assertEqual(second.diversified, true, "the second compile must be recorded as a diversification");
  assert(second.genome.riskFraction >= 0.05 && second.genome.riskFraction <= 0.1, "a diversified gene must stay inside the declared range");
  assert(second.genome.riskFraction <= COMPILER_LIMITS.maxRiskFraction, "a diversified gene must respect compiler limits");
  for (const key of Object.keys(second.genome)) {
    assert(GENOME_KEYS.includes(key), `compiled genome has an unknown key: ${key}`);
    const [lo, hi] = GENE_BOUNDS[key];
    assert(second.genome[key] >= lo && second.genome[key] <= hi, `diversified ${key} escapes GENE_BOUNDS`);
  }
});

test("10. Diversification is attributable to the original proposal and reproduces exactly", () => {
  const proposals = [
    validProposal({ proposalId: "P-att-1", parentFamilies: ["Reversal x Liquidity"], changes: { stopLoss: [0.05, 0.09] } }),
    validProposal({ proposalId: "P-att-2", parentFamilies: ["Reversal x Liquidity"], changes: { stopLoss: [0.05, 0.09] } }),
  ];
  const runA = compileProposals({ proposals, maxCompilations: 4 });
  const runB = compileProposals({ proposals, maxCompilations: 4 });
  assertEqual(JSON.stringify(runA.compiled), JSON.stringify(runB.compiled), "diversification must be deterministic for the same input");
  for (const entry of runA.compiled) {
    assertEqual(entry.family, "Reversal x Liquidity", "a diversified genome must keep the original family");
    assert(entry.proposalId.startsWith("P-att-"), "a diversified genome must keep its originating proposal id");
    assertEqual(entry.species, "Reversal", "a diversified genome must keep the family's species");
  }
});

test("11. deterministicInRange / hasDiversifiableRange behave predictably and never invent noise", () => {
  assertEqual(hasDiversifiableRange({ x: [0.1, 0.1], y: 0.5 }), false, "a degenerate range has no room to move");
  assertEqual(hasDiversifiableRange({ x: [0.1, 0.2] }), true, "a real range can be re-drawn faithfully");
  const value = deterministicInRange(0.4, 0.6, "salt");
  assert(value >= 0.4 && value <= 0.6, "a deterministic draw must stay inside the range");
  assertEqual(value, deterministicInRange(0.4, 0.6, "salt"), "the same salt must give the same draw");
  assertEqual(deterministicInRange(0.3, 0.3, "salt"), 0.3, "a degenerate range collapses to its only point");
});

test("12. Compiler stats account for requested, compiled, duplicate, and diversified candidates", () => {
  const proposals = [
    validProposal({ proposalId: "P-stat-1", changes: { riskFraction: [0.04, 0.06] } }),
    validProposal({ proposalId: "P-stat-2", changes: { riskFraction: [0.04, 0.06] } }),
    validProposal({ proposalId: "P-stat-3", parentFamilies: ["Not A Family"] }),
  ];
  const { compiled, rejected, stats } = compileProposals({ proposals, maxCompilations: 5 });
  assertEqual(stats.requested, 3, "requested must count every proposal offered");
  assertEqual(stats.structurallyAccepted, 2, "structurallyAccepted must exclude the unresolvable family");
  assertEqual(stats.compiled, compiled.length, "stats.compiled must match the compiled list");
  assertEqual(stats.uniqueGenomes, compiled.length, "every compiled candidate is a unique genome by construction");
  assertEqual(stats.diversified, 1, "exactly one candidate had to be diversified");
  assertEqual(rejected.length, 1, "the unresolvable family must be reported once");
  assertEqual(rejected[0].code, "COMPILER_REJECTED", "an unresolvable family is a compiler rejection, not a duplicate");
});

/* ============================================================================
 * C. Research novelty metrics
 * ==========================================================================*/

test("13. uniqueGenomeRatio is computed correctly", () => {
  assertEqual(uniqueGenomeRatio({ uniqueDigests: 9, acceptedEntrants: 10 }).ratio, 0.9, "9/10 must be 0.9");
  assertEqual(uniqueGenomeRatio({ uniqueDigests: 0, acceptedEntrants: 0 }).ratio, 0, "an empty cohort is 0 (not NaN)");
  assertEqual(uniqueGenomeRatio({ uniqueDigests: 5, acceptedEntrants: 3 }).uniqueDigests, 3, "unique count cannot exceed accepted entrants");
});

test("14. Uniqueness warning/failure triggers below the configured ratio, and stays quiet above it", () => {
  const ok = cohortUniquenessVerdict({ uniqueDigests: 30, acceptedEntrants: 33, minUniqueRatio: 0.9 });
  assertEqual(ok.ok, true, "30/33 (0.909) clears a 0.90 minimum");
  assertEqual(ok.warning, null, "a healthy cohort must not be warned about");

  const degraded = cohortUniquenessVerdict({ uniqueDigests: 13, acceptedEntrants: 33, minUniqueRatio: 0.9 });
  assertEqual(degraded.ok, false, "13/33 must fail a 0.90 minimum");
  assertFinite(degraded.ratio, "the ratio must be a finite number");
  assert(degraded.warning.includes("uniqueness"), "the warning must explain the uniqueness shortfall");
  assertEqual(degraded.code, "RESEARCH_UNIQUENESS_WARNING", "non-strict mode warns rather than fails");

  const strict = cohortUniquenessVerdict({ uniqueDigests: 13, acceptedEntrants: 33, minUniqueRatio: 0.9, strict: true });
  assertEqual(strict.code, "RESEARCH_UNIQUENESS_BELOW_MINIMUM", "strict mode must fail loudly");
});

test("15. ratioEnv parses, clamps, and falls back safely", () => {
  assertEqual(ratioEnv("0.95", 0.9), 0.95, "a valid ratio is parsed");
  assertEqual(ratioEnv("1.5", 0.9), 1, "a ratio above 1 clamps to 1");
  assertEqual(ratioEnv("-3", 0.9), 0, "a negative ratio clamps to 0");
  assertEqual(ratioEnv("nonsense", 0.9), 0.9, "an invalid ratio falls back to the default");
  assertEqual(ratioEnv(undefined, RESEARCH_COHORT_DEFAULTS.minUniqueRatio), 0.9, "the documented default is 0.90");
});

test("16. Repeated provider outputs cannot silently consume multiple Arena slots", async () => {
  await withTempRoot("evolve-phase5a2-", async (root) => {
    // Cycle 1 compiles a cohort; cycle 2 receives byte-identical proposal
    // regions and must NOT add a second copy of any genome.
    const evidence = EMPTY_EVIDENCE;
    const first = await runResearchCycle({ root, evidence, cycle: 1, seed: "dupe-slot", proposalsPerCycle: 6, maxCompilations: 6 });
    assert(first.compiled.length > 0, "cycle 1 must compile something");
    const firstDigests = new Set(first.compiled.map((row) => row.genomeDigest));
    assertEqual(firstDigests.size, first.compiled.length, "cycle 1 must be internally unique");

    const second = await runResearchCycle({ root, evidence, cycle: 2, seed: "dupe-slot", proposalsPerCycle: 6, maxCompilations: 6 });
    for (const entry of second.compiled) {
      assert(!firstDigests.has(entry.genomeDigest), `cycle 2 must not re-add a genome already in the cohort (${entry.genomeDigest})`);
    }
    const persisted = await listCompiledCandidates(root);
    const digests = persisted.map((row) => genomeDigestOf(row));
    assertEqual(new Set(digests).size, digests.length, "the persisted cohort must contain no duplicate genome digest");
    assertEqual(digests.length, persisted.length, "every persisted artifact must have a genome digest");
  });
});

test("17. The same seed and evidence reproduce the same research cohort in a clean root", async () => {
  const run = async () =>
    withTempRoot("evolve-phase5a2-", async (root) => {
      const report = await runResearchCycle({ root, evidence: EMPTY_EVIDENCE, cycle: 1, seed: "repro-5a2", proposalsPerCycle: 6, maxCompilations: 6 });
      return report.compiled.map((row) => ({ proposalId: row.proposalId, family: row.family, species: row.species, digest: row.genomeDigest }));
    });
  const a = await run();
  const b = await run();
  assertEqual(JSON.stringify(a), JSON.stringify(b), "same seed/evidence must reproduce identical compiled cohorts");
  assert(a.length >= 5, "the cohort should be a meaningful size");
});

/* ============================================================================
 * D. Species reachability and the anti-collapse guard
 * ==========================================================================*/

test("18. The adversarial critic is advisory-only and never originates a compilable proposal", () => {
  assert(ADVISORY_ROLES.includes("adversarial-critic"), "the critic must be documented as advisory");
  assert(!PROPOSING_ROLES.includes("adversarial-critic"), "the critic must never be in the proposing rotation");
  const proposals = providerProposals({ count: 12 });
  assert(proposals.every((row) => row.authorRole !== "adversarial-critic"), "no proposal may be authored by the critic role");
});

test("19. All six strategy species are reachable through provider + compiler", () => {
  const proposals = validatedProviderProposals({ count: 6 });
  const { compiled } = compileProposals({ proposals, maxCompilations: 12 });
  const species = new Set(compiled.map((row) => row.species));
  for (const name of SPECIES) {
    assert(species.has(name), `species ${name} must be reachable through the research pipeline (got ${[...species].join(", ")})`);
  }
});

test("20. The compiler does not silently default every proposal to Momentum", () => {
  const proposals = validatedProviderProposals({ count: 6 });
  const { compiled } = compileProposals({ proposals, maxCompilations: 12 });
  const momentum = compiled.filter((row) => row.species === "Momentum").length;
  assert(momentum < compiled.length, "a 6-proposal cycle must not compile to 100% Momentum");
  const families = new Set(compiled.map((row) => row.family));
  assert(families.size >= 3, `compiled families must span more than one or two families (got ${[...families].join(", ")})`);
});

test("21. A small compilation cap still spreads across families instead of taking the first N", () => {
  const proposals = familyNames().map((name, index) => validProposal({ proposalId: `P-breadth-${index}`, parentFamilies: [name] }));
  const { compiled } = compileProposals({ proposals, maxCompilations: 3 });
  assertEqual(compiled.length, 3, "the cap must still be honoured");
  assertEqual(new Set(compiled.map((row) => row.family)).size, 3, "three slots must go to three different families");
});

function familyNames() {
  return [...FAMILY_NAMES];
}

test("22. Species concentration verdict flags a concentrated cohort and clears a spread one", () => {
  const spread = SPECIES.map((species) => ({ species }));
  assertEqual(speciesConcentrationVerdict({ entries: spread, maxSpeciesShare: 0.6 }).ok, true, "one of each species is not concentrated");

  const concentrated = Array.from({ length: 10 }, () => ({ species: "Momentum" }));
  const verdict = speciesConcentrationVerdict({ entries: concentrated, maxSpeciesShare: 0.6 });
  assertEqual(verdict.ok, false, "100% Momentum must trip a 0.60 cap");
  assertEqual(verdict.topSpecies, "Momentum", "the concentrator must be named");
  assert(verdict.warning.includes("NOT fabricated"), "the warning must state that diversity is not fabricated");
});

test("23. The concentration guard never fabricates diversity: it flags, and preserves the proposals", () => {
  const proposals = Array.from({ length: 4 }, (_, index) =>
    validProposal({ proposalId: `P-conc-${index}`, parentFamilies: ["Momentum x Wallet Flow"], changes: { riskFraction: [0.05 + index * 0.01, 0.06 + index * 0.01] } }),
  );
  const uncapped = compileProposals({ proposals, maxCompilations: 4 });
  const capped = compileProposals({ proposals, maxCompilations: 4, maxSpeciesShare: 0.25 });
  assertEqual(capped.compiled.length, uncapped.compiled.length, "a diversity guard must not silently drop evidence-backed proposals");
  assertEqual(capped.stats.concentrationWarning, true, "under-filling the cycle would be worse: the concentration must be reported");
  const cappedSpecies = new Set(capped.compiled.map((row) => row.species));
  assertEqual(cappedSpecies.size, 1, "the guard must never convert a proposal into an unrelated species");
  assertEqual(
    JSON.stringify(uncapped.compiled.map((row) => row.genome)),
    JSON.stringify(capped.compiled.map((row) => row.genome)),
    "the guard must not alter the genomes themselves",
  );
});

test("24. Evidence-driven targeting reaches different species than the silent-evidence rotation", () => {
  const rich = buildEvidencePacket({
    snapshot: {
      species: [{ name: "Liquidity", count: 20, avgReturn: 0.4, trades: 40 }, { name: "Momentum", count: 20, avgReturn: -0.2, trades: 5 }],
      researchRegime: "liquidity-expansion",
      topAgents: [],
      paper: { costs: 12, startingCash: 100 },
      stats: { population: 96 },
    },
    islands: [{ name: "Liquidity", population: 40, target: 16, avgReturn: 0.4, trades: 40, extinct: false }],
    priorConclusions: [],
    cycle: 3,
  });
  const signal = resolveProposalTarget({ role: "signal-researcher", index: 0, evidence: rich });
  assertEqual(signal.source, "evidence", "with real species evidence, targeting must be evidence-driven");
  assertEqual(signal.species, "Liquidity", "the strongest evidence-backed species must win");

  const regime = resolveProposalTarget({ role: "regime-researcher", index: 1, evidence: rich });
  assertEqual(regime.species, "Liquidity", "a liquidity-expansion regime targets the Liquidity species");

  const silent = resolveProposalTarget({ role: "signal-researcher", index: 0, evidence: EMPTY_EVIDENCE });
  assertEqual(silent.source, "rotation", "with no evidence at all the fallback rotation is used, and it is explicit");
});

test("25. Every proposal family resolves and every target species is a real species", () => {
  const proposals = providerProposals({ count: 12, cycle: 4 });
  for (const raw of proposals) {
    assert(resolveFamily(raw.parentFamilies[0]), `family ${raw.parentFamilies[0]} must resolve`);
    if (raw.targetSpecies) assert(SPECIES.includes(raw.targetSpecies), `targetSpecies ${raw.targetSpecies} must be a real species`);
    const { ok, errors } = validateProposal(raw);
    assert(ok, `provider output must validate (${errors.join("; ")})`);
  }
});

test("26. Phase 5A.2 family additions are deterministic two-preset blends inside the approved set", () => {
  for (const name of ["Genesis Hunter x Momentum", "Wallet Flow x Reversal", "Liquidity x Wallet Flow"]) {
    assert(FAMILY_NAMES.includes(name), `${name} must be an approved family`);
    const family = CANDIDATE_FAMILIES[name];
    assertEqual(family.parents.length, 2, `${name} must blend exactly two presets`);
    assert(family.parents.every((parent) => SPECIES.includes(parent)), `${name} parents must be real species`);
    assert(SPECIES.includes(family.parents[0]), `${name} must have a lead parent species`);
  }
});

/* ============================================================================
 * E. Role-level metrics
 * ==========================================================================*/

test("27. Role-level research metrics are accurate per role", async () => {
  await withTempRoot("evolve-phase5a2-", async (root) => {
    const proposals = validatedProviderProposals({ count: 6 });
    const { compiled } = compileProposals({ proposals, maxCompilations: 12 });
    const signal = compiled.find((row) => row.authorRole === "signal-researcher");
    assert(signal, "the cycle must include a signal-researcher compile");

    await appendMemoryRecord(
      root,
      createMemoryRecord({
        proposalId: signal.proposalId,
        authorRole: signal.authorRole,
        hypothesis: "h",
        candidateFamily: signal.familyId,
        status: MEMORY_STATUS.TESTING,
        outcome: MEMORY_OUTCOME.QUARANTINED,
        watchdog: { status: "QUARANTINED", flags: [{ flag: "single-mint-dominance", detail: "x" }], trades: 4 },
      }),
    );

    const metrics = roleResearchMetrics({
      proposals: proposals.map((proposal) => ({ proposal })),
      compiled,
      memoryRecords: await readMemoryIndex(root, { limit: 100 }),
      arenaRows: [
        { authorRole: "signal-researcher", score: 70, finalRank: 12, failedGates: ["minimum distinct mints"] },
        { authorRole: "signal-researcher", score: 80, finalRank: 3, failedGates: [] },
      ],
    });

    const row = metrics["signal-researcher"];
    assert(row, "metrics must include the signal-researcher");
    assert(row.proposalsGenerated >= 1, "proposalsGenerated must count the role's proposals");
    assert(row.compilationAccepted >= 1, "compilationAccepted must count the role's compiled candidates");
    assert(row.uniqueGenomes >= 1, "uniqueGenomes must count distinct digests");
    assertEqual(row.arenaEntrants, 2, "arenaEntrants must count the role's Arena rows");
    assertFinite(row.medianArenaScore, "medianArenaScore must be finite");
    assertEqual(row.bestArenaRank, 3, "bestArenaRank must be the lowest rank");
    assertEqual(row.gateFailures, 1, "gateFailures must sum the failed gates");
    assertEqual(row.watchdog.QUARANTINED, 1, "the quarantine verdict must be counted for the role");
  });
});

test("28. Role metrics never use Arena score feedback to mutate future proposals", () => {
  // roleResearchMetrics is a pure read-side aggregation: it returns a NEW
  // object and holds no reference to the compiled proposals it summarises.
  const compiled = [{ authorRole: "risk-researcher", familyId: "F-1", genomeDigest: "d1" }];
  const metrics = roleResearchMetrics({ compiled, arenaRows: [{ authorRole: "risk-researcher", score: 99, finalRank: 1 }] });
  assertEqual(compiled[0].familyId, "F-1", "the compiled input must be untouched");
  assert(metrics["risk-researcher"].medianArenaScore === 99, "the score is reported, never fed back");
});

/* ============================================================================
 * F. Arena status semantics + provenance
 * ==========================================================================*/

test("29. Gate status is explicit and separate from the legacy survivor label", () => {
  const passed = evaluateSurvivalGates({
    arenaScore: 70,
    components: { trades: 30, distinctMints: 6, oosWindows: 3, seeds: 2, maxDrawdown: 0.1, topMintShare: 0.2, catastrophicEvents: 0, stressSurvived: 2, stressTotal: 2, evidenceInsufficient: false },
    config: {},
    realDatasetsUsed: 1,
    stressSurvivalByProfile: { mild: { survived: true } },
    strategyType: "generalist",
  });
  assertEqual(passed.gateStatus, GATE_STATUS.GATES_PASSED, "a gate-clearing generalist must report GATES_PASSED");
  assertEqual(passed.status, CANDIDATE_STATUS.DEPLOYMENT_CANDIDATE, "the legacy deployment label must be preserved");
  assertEqual(passed.deploymentEligible, true, "deploymentEligible must be explicit");

  const specialist = evaluateSurvivalGates({
    arenaScore: 70,
    components: { trades: 30, distinctMints: 6, oosWindows: 3, seeds: 2, maxDrawdown: 0.1, topMintShare: 0.2, catastrophicEvents: 0, stressSurvived: 2, stressTotal: 2, evidenceInsufficient: false },
    config: {},
    realDatasetsUsed: 1,
    stressSurvivalByProfile: { mild: { survived: true } },
    strategyType: "specialist",
  });
  assertEqual(specialist.gateStatus, GATE_STATUS.GATES_PASSED, "a specialist that clears every gate still passes the gates");
  assertEqual(specialist.status, CANDIDATE_STATUS.ARENA_SURVIVOR, "the specialist keeps the legacy ARENA SURVIVOR label");
  assertEqual(specialist.deploymentEligible, false, "a specialist is not a deployment candidate — distinct from gate status");
});

test("30. Failed and insufficient-evidence candidates report their own gate status", () => {
  const failed = evaluateSurvivalGates({
    arenaScore: 10,
    components: { trades: 30, distinctMints: 1, oosWindows: 3, seeds: 2, maxDrawdown: 0.1, topMintShare: 0.2, catastrophicEvents: 0, stressSurvived: 2, stressTotal: 2, evidenceInsufficient: false },
    config: {},
    realDatasetsUsed: 1,
    stressSurvivalByProfile: { mild: { survived: true } },
  });
  assertEqual(failed.gateStatus, GATE_STATUS.GATES_FAILED, "a failed gate must report GATES_FAILED");
  assertEqual(failed.deploymentGateStatus, GATE_STATUS.GATES_FAILED, "deploymentGateStatus must mirror it");

  const thin = evaluateSurvivalGates({
    arenaScore: 90,
    components: { trades: 0, distinctMints: 0, oosWindows: 0, seeds: 0, maxDrawdown: 0.1, topMintShare: 0.2, catastrophicEvents: 0, stressSurvived: 0, stressTotal: 0, evidenceInsufficient: true },
    config: {},
    realDatasetsUsed: 1,
    stressSurvivalByProfile: null,
  });
  assertEqual(thin.gateStatus, GATE_STATUS.INSUFFICIENT_EVIDENCE, "thin evidence must be its own status, never GATES_FAILED");
});

test("31. Tournament stage vocabulary is explicit and ordered", () => {
  assertEqual(TOURNAMENT_STAGE_ORDER[0], ARENA_STAGE.QUALIFICATION, "the funnel starts at QUALIFICATION");
  assert(TOURNAMENT_STAGE_ORDER.includes(ARENA_STAGE.CHAMPION_LEAGUE), "the Champion League must be a named stage");
  assert(TOURNAMENT_STAGE_ORDER.includes(ARENA_STAGE.DEPLOYMENT), "DEPLOYMENT must be a named stage");
  assertEqual(new Set(TOURNAMENT_STAGE_ORDER).size, TOURNAMENT_STAGE_ORDER.length, "stage names must be unique");
});

test("32. Research provenance is first-class on the entrant and resolves without digest reconstruction", async () => {
  await withTempRoot("evolve-phase5a2-", async (root) => {
    const proposals = validatedProviderProposals({ count: 6 });
    const { compiled } = compileProposals({ proposals, maxCompilations: 6 });
    const entrants = researchEntrantsFromCohort(compiled);
    assertEqual(entrants.length, compiled.length, "every unique compiled genome becomes exactly one entrant");
    for (const entrant of entrants) {
      const meta = entrant.research;
      assert(meta, "a research entrant must carry provenance");
      assert(meta.familyId, "provenance must carry familyId");
      assert(meta.proposalId, "provenance must carry proposalId");
      assert(meta.authorRole, "provenance must carry authorRole");
      assert(meta.researchFamily, "provenance must carry the research family");
      assertEqual(meta.researchGenomeDigest, entrant.digest, "provenance must carry the exact genome digest");
      assertEqual(meta.identity, RESEARCH_IDENTITY.EXACT, "an unmutated research genome is an EXACT identity");
    }
    void root;
  });
});

test("33. Exact research identity is distinguishable from descendant ancestry", () => {
  const parent = { genome: {}, research: exactResearchMeta({ familyId: "F-1", proposalId: "P-1", authorRole: "signal-researcher", genome: {} }) };
  const ancestry = mergeResearchAncestry(parent);
  assert(ancestry, "a research parent must produce ancestry");
  assertEqual(ancestry.familyIds[0], "F-1", "ancestry must carry the ancestor family id");

  const descendant = descendantResearchMeta(ancestry);
  assertEqual(descendant.identity, RESEARCH_IDENTITY.DESCENDANT, "a bred child is a DESCENDANT");
  assertEqual(descendant.researchGenomeDigest, null, "a descendant must NOT claim an exact original genome digest");
  assertEqual(descendant.familyId, null, "a descendant must not claim the original family id as its own");
  assertEqual(descendant.researchAncestorFamilyIds[0], "F-1", "ancestry is preserved separately from identity");

  const conventional = mergeResearchAncestry({ genome: {}, origin: "evolved" });
  assertEqual(conventional, null, "a conventional lineage carries no research ancestry");
});

test("34. Bred children of research seeds inherit ancestry, never exact identity", () => {
  const researchSeed = {
    genome: { riskFraction: 0.1 },
    species: "Momentum",
    origin: "research",
    digest: "seed-digest",
    research: exactResearchMeta({ familyId: "F-seed", proposalId: "P-seed", authorRole: "regime-researcher", genome: { riskFraction: 0.1 } }),
  };
  const pool = buildEntrantPool({ champions: [researchSeed, researchSeed], population: 12, seed: "ancestry", championShare: 0.2 });
  const exact = pool.filter((entrant) => entrant.research?.identity === RESEARCH_IDENTITY.EXACT);
  const descendants = pool.filter((entrant) => entrant.research?.identity === RESEARCH_IDENTITY.DESCENDANT);
  assert(exact.length >= 1, "the unchanged research seed must still be an exact original");
  assert(descendants.length >= 1, "bred children must be labelled descendants");
  for (const child of descendants) {
    assertEqual(child.research.researchGenomeDigest, null, "a descendant must not carry the original digest");
    assert(child.research.researchAncestorFamilyIds.includes("F-seed"), "a descendant must carry the ancestor family id");
    assert(child.researchAncestry.familyIds.includes("F-seed"), "the entrant-level ancestry must be preserved too");
    assertEqual(child.research.authorRole, null, "a descendant must not claim the original author as its own");
    assertEqual(child.research.researchAncestorRoles[0], "regime-researcher", "ancestor roles are preserved as lineage attribution");
    const provenance = researchProvenance(child);
    assertEqual(provenance.identity, RESEARCH_IDENTITY.DESCENDANT, "lineage attribution must not change the identity");
    assertEqual(provenance.authorRole, "regime-researcher", "role metrics may attribute a descendant to its ancestor role");
    assertEqual(provenance.researchGenomeDigest, null, "lineage attribution must not fabricate an exact digest");
  }
  const immigrants = pool.filter((entrant) => entrant.origin === "immigrant");
  assert(immigrants.every((entrant) => !entrant.research), "random immigrants must never be labelled research descendants");
});

/* ============================================================================
 * G. Promotion and quarantine
 * ==========================================================================*/

test("35. Promotion reads explicit stage/gate information first", () => {
  const passed = memoryStatusForArenaRow({ gateStatus: GATE_STATUS.GATES_PASSED, deploymentEligible: true });
  assertEqual(passed.status, MEMORY_STATUS.SHADOW_ELIGIBLE, "an explicit deployment-eligible row promotes to SHADOW_ELIGIBLE");
  const survivor = memoryStatusForArenaRow({ gateStatus: GATE_STATUS.GATES_PASSED, deploymentEligible: false });
  assertEqual(survivor.status, MEMORY_STATUS.ARENA_SURVIVOR, "a gate-passing non-deployment row becomes ARENA_SURVIVOR");
  const failed = memoryStatusForArenaRow({ gateStatus: GATE_STATUS.GATES_FAILED });
  assertEqual(failed.status, MEMORY_STATUS.PROMISING, "a gate-failing row cannot reach deployment status");
  assert(failed.basis.includes("explicit"), "the decision must be traceable to explicit gate information");
});

test("36. A legacy leaderboard row (no gate fields) still promotes correctly", () => {
  const legacy = memoryStatusForArenaRow({ status: "DEPLOYMENT CANDIDATE" });
  assertEqual(legacy.status, MEMORY_STATUS.SHADOW_ELIGIBLE, "the legacy status string remains a supported fallback");
  assert(legacy.basis.includes("legacy"), "the fallback must say so");
  const unknown = memoryStatusForArenaRow({});
  assertEqual(unknown.status, MEMORY_STATUS.PROMISING, "an unlabelled row may only be PROMISING");
});

test("37. Promotion still requires a real Arena match and quarantine still blocks it", async () => {
  await withTempRoot("evolve-phase5a2-", async (root) => {
    const genomeA = { riskFraction: 0.13 };
    const genomeB = { riskFraction: 0.17 };
    await saveCompiledCandidate(root, { familyId: "F-5a2-a", proposalId: "P-a", genome: genomeA, authorRole: "signal-researcher" });
    await saveCompiledCandidate(root, { familyId: "F-5a2-b", proposalId: "P-b", genome: genomeB, authorRole: "risk-researcher" });

    const quarantined = createMemoryRecord({
      proposalId: "P-b",
      authorRole: "risk-researcher",
      hypothesis: "h",
      candidateFamily: "F-5a2-b",
      status: MEMORY_STATUS.TESTING,
      outcome: MEMORY_OUTCOME.QUARANTINED,
      watchdog: { status: "QUARANTINED", flags: [{ flag: "single-mint-dominance", detail: "x" }] },
    });
    await appendMemoryRecord(root, quarantined);
    const memoryRecords = await readMemoryIndex(root, { limit: 100 });
    assert(isQuarantined(memoryRecords, "F-5a2-b"), "the quarantine must be detectable from structured evidence");

    const result = await promoteFromArenaLeaderboard({
      root,
      leaderboardRows: [
        { digest: digestOf(genomeA), gateStatus: GATE_STATUS.GATES_PASSED, deploymentEligible: true, finalRank: 1 },
        { digest: digestOf(genomeB), gateStatus: GATE_STATUS.GATES_PASSED, deploymentEligible: true, finalRank: 2 },
      ],
      memoryRecords,
    });
    assert(result.promoted.some((row) => row.familyId === "F-5a2-a" && row.to === MEMORY_STATUS.SHADOW_ELIGIBLE), "a matched, clean candidate must promote");
    assert(result.skipped.some((row) => row.familyId === "F-5a2-b"), "a QUARANTINED candidate must never promote, even with explicit gate passes");
  });
});

/* ============================================================================
 * H. Challenger vs fair cohort modes
 * ==========================================================================*/

function researchEntriesForCohort(count = 4) {
  const proposals = validatedProviderProposals({ count: Math.max(count, 6) }).slice(0, count);
  const { compiled } = compileProposals({ proposals, maxCompilations: count + 4 });
  return compiled;
}

test("38. CHALLENGER remains the documented default mode and appends research to a fixed population", () => {
  assertEqual(RESEARCH_ARENA_MODE.CHALLENGER, "challenger", "challenger must be the named default mode");
  assertEqual(RESEARCH_ARENA_MODE.FAIR, "fair", "fair must be the named equal-treatment mode");
  const conventional = buildEntrantPool({ champions: [], population: 12, seed: "challenger" });
  assertEqual(conventional.length, 12, "the conventional population is exactly the requested size");
  const research = researchEntrantsFromCohort(researchEntriesForCohort(3));
  const entrants = [...conventional, ...research];
  assertEqual(entrants.length, 15, "challenger mode appends research on top of the requested population");
  assertEqual(entrants.filter((row) => row.origin === "research").length, 3, "the appended research entrants keep their origin");
});

test("39. FAIR mode builds one mixed cohort with both lineages present", () => {
  const conventional = buildEntrantPool({ champions: [], population: 12, seed: "fair" });
  const research = researchEntrantsFromCohort(researchEntriesForCohort(5));
  const composed = composeFairCohort({ population: 12, researchEntrants: research, conventionalEntrants: conventional, researchShare: 0.5 });
  assertEqual(composed.entrants.length, 12, "a fair cohort is exactly the requested population — not population + research");
  assertEqual(composed.accounting.startingResearchSeeds, 5, "the accounting must report the research seed count");
  assertEqual(composed.accounting.startingConventionalSeeds, 7, "the accounting must report the conventional seed count");
  assert(composed.entrants.some((row) => row.origin === "research"), "the mixed cohort must contain research lineage");
  assert(composed.entrants.some((row) => row.origin !== "research"), "the mixed cohort must contain conventional lineage");
});

test("40. FAIR mode never clones a genome to fill a missing research quota", () => {
  const conventional = buildEntrantPool({ champions: [], population: 20, seed: "fair-short" });
  const research = researchEntrantsFromCohort(researchEntriesForCohort(2));
  const composed = composeFairCohort({ population: 20, researchEntrants: research, conventionalEntrants: conventional, researchShare: 0.5 });
  const digests = composed.entrants.map((row) => row.digest ?? digestOf(row.genome));
  assertEqual(new Set(digests).size, digests.length, "a fair cohort must contain no duplicated genome");
  assertEqual(composed.accounting.startingResearchSeeds, 2, "only the two real research seeds may be used");
  assertEqual(composed.accounting.requestedResearchSeeds, 10, "the requested research quota is still reported");
  assertEqual(composed.accounting.researchShortage, 8, "the shortfall must be reported, not hidden");
  assertEqual(composed.accounting.clonedToFillQuota, 0, "cloning to fill a quota must be explicitly zero");
  assertEqual(composed.accounting.startingConventionalSeeds, 18, "the shortfall is absorbed by conventional seeds");
});

test("41. FAIR mode gives both lineages the same pre-evolution builder and preserves ancestry", () => {
  const conventional = buildEntrantPool({ champions: [], population: 10, seed: "fair-eq" });
  const research = researchEntrantsFromCohort(researchEntriesForCohort(4));
  const mixed = composeFairCohort({ population: 10, researchEntrants: research, conventionalEntrants: conventional, researchShare: 0.5 }).entrants;
  // The same builder is applied to the whole mixed pool — there is no
  // research-only or conventional-only path.
  const next = buildEntrantPool({ champions: mixed, population: 10, seed: "fair-eq:next", championShare: 0.6 });
  assertEqual(next.length, 10, "the next fair generation keeps the exact population");
  const researchLineage = next.filter((row) => row.research || row.origin === "research");
  assert(researchLineage.length >= 1, "research lineage must survive fair-mode pre-evolution");
  assert(
    next.some((row) => !row.research && row.origin !== "research"),
    "conventional lineage must also survive fair-mode pre-evolution",
  );
});

/* ============================================================================
 * I. Live Arena accounting + provenance + diagnostics
 * ==========================================================================*/

test("42. An Arena run accounts for every entrant exactly and identifies the final eight explicitly", async () => {
  await withFixture(async ({ datasets }) => {
    const conventional = buildEntrantPool({ champions: [], population: 10, seed: "acct" });
    const research = researchEntrantsFromCohort(researchEntriesForCohort(4));
    const entrants = [...conventional, ...research];

    const result = await runArenaTournament({
      datasets,
      config: tinyConfig(),
      entrants,
      seeds: ["acct-1"],
      stressProfiles: ["mild"],
      maxWindows: 1,
      workers: 0,
      useCache: false,
      researchCohort: { proposalsAvailable: 6, compiledArtifacts: 6, uniqueCompiledGenomes: 4, duplicateCompiledGenomes: 2 },
      researchMode: RESEARCH_ARENA_MODE.CHALLENGER,
      researchEnabled: true,
      minUniqueRatio: 0.9,
      maxSpeciesShare: 0.6,
    });

    assertEqual(result.candidateRows.length, entrants.length, "every entrant must appear exactly once in the candidate rows");
    assertEqual(result.summary.funnel.QUALIFICATION.entered, entrants.length, "the funnel must account for every entrant");
    const ranks = result.candidateRows.map((row) => row.finalRank).sort((a, b) => a - b);
    assertEqual(ranks.join(","), entrants.map((_, index) => index + 1).join(","), "ranks must be a dense 1..n permutation");

    assert(result.summary.championLeague.length <= 8, "the Champion League must be at most eight");
    for (const row of result.summary.championLeague) {
      assertFinite(row.score, "a finalist must have a finite score");
      assert(typeof row.digest === "string", "a finalist must be identified by digest");
    }
    const finalistDigests = new Set(result.summary.championLeague.map((row) => row.digest));
    for (const row of result.candidateRows) {
      assertEqual(row.isChampionLeagueFinalist, finalistDigests.has(row.digest), "the finalist flag must exactly match the explicit list");
      assert(row.gateStatus === null || Object.values(GATE_STATUS).includes(row.gateStatus), `gateStatus ${row.gateStatus} must be a defined value`);
    }
    assertNoNonFinite(result.summary.researchSummary, "researchSummary");
  });
});

test("43. Research provenance survives into candidates.json, the leaderboard, and the research summary", async () => {
  await withFixture(async ({ datasets }) => {
    await withTempRoot("evolve-phase5a2-arenas-", async (arenasDir) => {
      const conventional = buildEntrantPool({ champions: [], population: 8, seed: "prov" });
      const research = researchEntrantsFromCohort(researchEntriesForCohort(4));
      const entrants = [...conventional, ...research];
      const arenaId = "arena-5a2-provenance";

      const result = await runArenaTournament({
        datasets,
        config: tinyConfig(),
        entrants,
        seeds: ["prov-1"],
        stressProfiles: ["mild"],
        maxWindows: 1,
        workers: 0,
        useCache: false,
        arenaId,
        arenasDir,
        researchCohort: { proposalsAvailable: 6, compiledArtifacts: 6, uniqueCompiledGenomes: 4, duplicateCompiledGenomes: 2 },
        researchMode: RESEARCH_ARENA_MODE.CHALLENGER,
        researchEnabled: true,
      });

      const candidatesFile = JSON.parse(await readFile(path.join(arenasDir, arenaId, "candidates.json"), "utf8"));
      const researchRows = candidatesFile.filter((row) => row.research?.isResearch);
      assertEqual(researchRows.length, research.length, "candidates.json must carry every research entrant");
      for (const row of researchRows) {
        assert(row.research.familyId, "candidates.json provenance must carry familyId");
        assert(row.research.proposalId, "candidates.json provenance must carry proposalId");
        assertEqual(row.research.identity, RESEARCH_IDENTITY.EXACT, "an unmutated research candidate must be an exact identity");
        assertEqual(row.research.researchGenomeDigest, row.digest, "the provenance digest must match the candidate digest");
      }

      const leaderboardFile = JSON.parse(await readFile(path.join(arenasDir, arenaId, "leaderboard.json"), "utf8"));
      const leaderboardResearch = leaderboardFile.filter((row) => row.research?.isResearch);
      assert(leaderboardResearch.length > 0, "the leaderboard must carry research provenance too");
      for (const row of leaderboardResearch) {
        assert(row.research.proposalId, "leaderboard provenance must carry the proposal id");
        assertFinite(row.finalRank, "leaderboard rows must expose an explicit final rank");
      }

      const summaryFile = JSON.parse(await readFile(path.join(arenasDir, arenaId, "summary.json"), "utf8"));
      const summary = summaryFile.researchSummary;
      assert(summary, "summary.json must contain a research section");
      for (const field of [
        "enabled",
        "mode",
        "proposalsAvailable",
        "compiledArtifacts",
        "uniqueCompiledGenomes",
        "duplicateCompiledGenomes",
        "researchEntrants",
        "uniqueResearchEntrants",
        "uniqueRatio",
        "speciesDistribution",
        "familyDistribution",
        "roleDistribution",
        "bestResearchRank",
        "medianResearchRank",
        "bestResearchScore",
        "medianResearchScore",
        "researchTop8Count",
        "researchTop50Count",
        "researchGroupCount",
        "failedGateCounts",
        "exactOriginalResearchSurvivors",
        "descendantResearchSurvivors",
      ]) {
        assert(summary[field] !== undefined, `researchSummary must expose ${field}`);
      }
      assertEqual(summary.duplicateCompiledGenomes, 2, "the duplicate artifact count must be reported");
      assertEqual(summary.researchEntrants, research.length, "the research entrant count must match this run");
      assertEqual(summary.uniqueResearchEntrants, research.length, "research entrants must be unique by digest");
      assertEqual(result.summary.researchSummary.researchEntrants, research.length, "the in-memory summary must agree");
    });
  });
});

test("44. Research counts (top-50, GROUP, failed gates) are accurate against the full candidate set", async () => {
  await withFixture(async ({ datasets }) => {
    const conventional = buildEntrantPool({ champions: [], population: 9, seed: "counts" });
    const research = researchEntrantsFromCohort(researchEntriesForCohort(4));
    const result = await runArenaTournament({
      datasets,
      config: tinyConfig(),
      entrants: [...conventional, ...research],
      seeds: ["counts-1"],
      stressProfiles: ["mild"],
      maxWindows: 1,
      workers: 0,
      useCache: false,
      researchCohort: { proposalsAvailable: 6, compiledArtifacts: 6, uniqueCompiledGenomes: 4, duplicateCompiledGenomes: 2 },
      researchEnabled: true,
    });

    const summary = result.summary.researchSummary;
    const researchRows = result.candidateRows.filter((row) => row.research.isResearch);
    assertEqual(summary.researchTop50Count, researchRows.filter((row) => row.finalRank <= 50).length, "top-50 count must match the rows");
    assertEqual(
      summary.researchGroupCount,
      researchRows.filter((row) => row.highestStage && row.highestStage !== ARENA_STAGE.QUALIFICATION).length,
      "the GROUP-reached count must match the stage data",
    );
    const expectedGateFailures = {};
    for (const row of researchRows) for (const gate of row.failedGates) expectedGateFailures[gate] = (expectedGateFailures[gate] ?? 0) + 1;
    assertEqual(JSON.stringify(summary.failedGateCounts), JSON.stringify(expectedGateFailures), "failed gate counts must match the rows");
    assertEqual(
      summary.researchTop8Count,
      researchRows.filter((row) => row.isChampionLeagueFinalist).length,
      "the top-8 research count must match the explicit finalist flag",
    );
  });
});

test("45. Every candidate exposes highestStage, eliminatedAtStage, finalRank, and a deployment gate status", async () => {
  await withFixture(async ({ datasets }) => {
    const result = await runArenaTournament({
      datasets,
      config: tinyConfig(),
      entrants: buildEntrantPool({ champions: [], population: 10, seed: "stages" }),
      seeds: ["stages-1"],
      stressProfiles: ["mild"],
      maxWindows: 1,
      workers: 0,
      useCache: false,
    });
    for (const row of result.candidateRows) {
      assertFinite(row.finalRank, "finalRank must be a finite number for every candidate");
      assert(
        ["GATES_PASSED", "GATES_FAILED", "INSUFFICIENT_EVIDENCE"].includes(row.gateStatus),
        `every candidate must carry an explicit gate status (got ${row.gateStatus})`,
      );
      assert(
        row.highestStage === null || TOURNAMENT_STAGE_ORDER.includes(row.highestStage),
        `highestStage must be a known stage or null (got ${row.highestStage})`,
      );
      if (row.highestStage === ARENA_STAGE.CHAMPION_LEAGUE) {
        assertEqual(row.eliminatedAtStage, null, "a finalist is not eliminated");
      } else {
        assert(row.eliminatedAtStage, "an eliminated candidate must name the stage that culled it");
      }
    }
  });
});

test("46. Distinct-mint diagnostics explain a thin mint count and stay silent when the gate passes", () => {
  const thin = buildDistinctMintDiagnostics({
    components: { distinctMints: 1 },
    evidenceRuns: [
      {
        metrics: {
          mintDiagnostics: {
            opportunitiesObserved: 400,
            eligibleTicks: 3,
            eligibleMints: 1,
            mintsEntered: 1,
            trades: 2,
            blockedEntries: 1,
            abstainedTicks: 12,
            noEligibleTicks: 40,
            belowThresholdTicks: 120,
            pausedTicks: 5,
            topMintNotionalShare: 0.9,
          },
        },
      },
    ],
  });
  assertEqual(thin.eligibleMints, 1, "eligible mints must be pooled");
  assertEqual(thin.distinctMints, 1, "the distinct-mint count must be reported");
  assert(thin.explanation.length > 0, "a thin cohort must receive at least one explanation");
  assert(thin.explanation.some((line) => line.includes("narrow")), "a narrow eligible universe must be named as a cause");

  const reasons = explainDistinctMintShortfall({ distinctMints: 6, eligibleMints: 9 }, 4);
  assertEqual(reasons.length, 0, "a candidate that clears the gate must not be given a shortfall narrative");
});

test("47. A full Arena run carries live distinct-mint diagnostics for its candidates", async () => {
  await withFixture(async ({ datasets }) => {
    const result = await runArenaTournament({
      datasets,
      config: tinyConfig(),
      entrants: buildEntrantPool({ champions: [], population: 8, seed: "diag" }),
      seeds: ["diag-1"],
      stressProfiles: ["mild"],
      maxWindows: 1,
      workers: 0,
      useCache: false,
    });
    const rowsWithDiagnostics = result.candidateRows.filter((row) => row.distinctMintDiagnostics);
    assert(rowsWithDiagnostics.length > 0, "evaluated candidates must carry distinct-mint diagnostics");
    for (const row of rowsWithDiagnostics) {
      assertFinite(row.distinctMintDiagnostics.opportunitiesObserved, "opportunitiesObserved must be finite");
      assertFinite(row.distinctMintDiagnostics.distinctMints, "distinctMints must be finite");
      assert(Array.isArray(row.distinctMintDiagnostics.explanation), "the diagnostics must carry an explanation list");
    }
  });
});

test("48. The minimum distinct-mints gate itself is unchanged (diagnostics only)", () => {
  assertEqual(DEFAULT_DEPLOYMENT_GATES.minDistinctMints, 4, "the distinct-mint gate must not be tuned to make candidates pass");
  assert(Object.isFrozen(DEFAULT_DEPLOYMENT_GATES), "the gate table must stay frozen");
});

/* ============================================================================
 * J. Determinism, evidence accounting, and paper-only safety
 * ==========================================================================*/

test("49. A research Arena run is deterministic across worker counts", async () => {
  await withFixture(async ({ datasets }) => {
    const entrants = [...buildEntrantPool({ champions: [], population: 8, seed: "det5a2" }), ...researchEntrantsFromCohort(researchEntriesForCohort(3))];
    const run = async (workers) =>
      runArenaTournament({
        datasets,
        config: tinyConfig(),
        entrants,
        seeds: ["det-1"],
        stressProfiles: ["mild"],
        maxWindows: 1,
        workers,
        useCache: false,
        researchEnabled: true,
      });
    const inline = await run(0);
    const threaded = await run(2);
    const scores = (result) => result.candidateRows.map((row) => `${row.digest}:${row.score}`).join("|");
    assertEqual(scores(inline), scores(threaded), "worker count must not change any score");
    assertEqual(
      JSON.stringify(inline.summary.researchSummary.speciesDistribution),
      JSON.stringify(threaded.summary.researchSummary.speciesDistribution),
      "worker count must not change the research summary",
    );
  });
});

test("50. Real vs synthetic evidence accounting is preserved", async () => {
  await withFixture(async ({ registry }) => {
    const summary = registrySummary(registry);
    assertEqual(summary.real.count, 0, "a synthetic fixture must never be counted as real evidence");
    assertEqual(summary.synthetic.count, 1, "the fixture must be counted as synthetic evidence");
    assertEqual(realEvidenceDatasets(registry).length, 0, "no real dataset may be claimed");
    assert(summary.synthetic.syntheticDataHours >= 0, "synthetic duration must be reported separately");
  });
});

test("51. buildResearchCohort reads the persisted cohort and reports duplicate artifacts", async () => {
  await withTempRoot("evolve-phase5a2-", async (root) => {
    const genome = { riskFraction: 0.21 };
    await saveCompiledCandidate(root, { familyId: "F-persist-a", proposalId: "P-a", genome, authorRole: "signal-researcher" });
    await saveCompiledCandidate(root, { familyId: "F-persist-b", proposalId: "P-b", genome, authorRole: "regime-researcher" });
    await saveCompiledCandidate(root, { familyId: "F-persist-c", proposalId: "P-c", genome: { riskFraction: 0.22 }, authorRole: "risk-researcher" });
    const cohort = await buildResearchCohort(root);
    assertEqual(cohort.compiledArtifacts, 3, "all three artifacts must be read");
    assertEqual(cohort.uniqueCompiledGenomes, 2, "only two genomes are genuinely unique");
    assertEqual(cohort.duplicateCompiledGenomes, 1, "the duplicate artifact must be reported, not silently included");
    assertEqual(cohort.uniqueDigests.length, 2, "unique digests must match unique genomes");
  });
});

test("52. summarizeResearchCohort reports zero (not NaN) for an empty research cohort", () => {
  const summary = summarizeResearchCohort({
    enabled: false,
    mode: null,
    cohort: null,
    candidates: [{ digest: "d1", species: "Momentum", score: 40, finalRank: 1, gateStatus: GATE_STATUS.GATES_FAILED, failedGates: [] }],
  });
  assertEqual(summary.enabled, false, "the summary must report that research was disabled");
  assertEqual(summary.researchEntrants, 0, "a conventional-only run has no research entrants");
  assertEqual(summary.uniqueRatio, 0, "the ratio must be 0, never NaN");
  assertEqual(summary.bestResearchRank, null, "there is no research rank to report");
  assertEqual(summary.researchTop8Count, 0, "counts must be zero, never NaN");
  assertNoNonFinite(summary, "researchSummary");
});

test("53. Research provenance normalisation never mislabels a conventional candidate", () => {
  const conventional = researchProvenance({ origin: "evolved", species: "Momentum" });
  assertEqual(conventional.isResearch, false, "a conventional candidate is not research");
  assertEqual(conventional.identity, null, "a conventional candidate has no research identity");

  const exact = researchProvenance({ origin: "research", research: exactResearchMeta({ familyId: "F", proposalId: "P", genome: {} }) });
  assertEqual(exact.isResearch, true, "a research entrant is research");
  assertEqual(exact.identity, RESEARCH_IDENTITY.EXACT, "an exact research genome keeps its identity");

  const descendant = researchProvenance({ origin: "evolved", researchAncestry: { familyIds: ["F"], proposalIds: ["P"] } });
  assertEqual(descendant.isResearch, true, "a descendant of research lineage is still research-lineage");
  assertEqual(descendant.identity, RESEARCH_IDENTITY.DESCENDANT, "a descendant must never be labelled exact");
  assertEqual(descendant.researchGenomeDigest, null, "a descendant has no exact original digest");
});

/* ============================================================================
 * K. Lifecycle outcomes
 * ==========================================================================*/

test("54. The lifecycle vocabulary is complete and internally consistent", () => {
  for (const key of [
    "PROPOSED",
    "REJECTED_SCHEMA",
    "REJECTED_COMPILER",
    "REJECTED_DUPLICATE",
    "TESTING",
    "WATCH",
    "QUARANTINED",
    "ARENA_EVALUATED",
    "PROMISING",
    "ARENA_SURVIVOR",
    "SHADOW_ELIGIBLE",
  ]) {
    assert(MEMORY_OUTCOME[key] === key, `MEMORY_OUTCOME must define ${key}`);
  }
  // Coarse statuses are unchanged so no existing reader breaks.
  assertEqual(MEMORY_STATUS.PROPOSED, "PROPOSED", "the coarse status vocabulary must remain compatible");
  assertEqual(MEMORY_STATUS.SHADOW_ELIGIBLE, "SHADOW_ELIGIBLE", "the coarse status vocabulary must remain compatible");
});

test("55. A research cycle records explicit outcomes for schema, duplicate, and compiled candidates", async () => {
  await withTempRoot("evolve-phase5a2-", async (root) => {
    const report = await runResearchCycle({ root, evidence: EMPTY_EVIDENCE, cycle: 1, seed: "lifecycle", proposalsPerCycle: 6, maxCompilations: 4 });
    assertEqual(report.proposed, 6, "the cycle must propose what it was asked for");
    assert(report.compiled.length > 0, "the cycle must compile something");
    assertEqual(report.outcomes[MEMORY_OUTCOME.PROPOSED], 6, "every raw proposal must be counted as PROPOSED");
    assertEqual(report.outcomes[MEMORY_OUTCOME.COMPILED], report.compiled.length, "every compiled candidate must be counted as COMPILED");

    const records = await readMemoryIndex(root, { limit: 100 });
    assert(records.length > 0, "the cycle must persist memory records");
    for (const record of records) {
      assert(
        [MEMORY_STATUS.PROPOSED, MEMORY_STATUS.TESTING, MEMORY_STATUS.REJECTED].includes(record.status),
        `a research cycle may only write PROPOSED/TESTING/REJECTED (got ${record.status})`,
      );
      assert(typeof record.outcome === "string" && record.outcome.length > 0, "every record must carry an explicit outcome");
    }
    const compiledRecords = records.filter((record) => record.outcome === MEMORY_OUTCOME.COMPILED);
    assert(compiledRecords.length > 0, "compiled candidates must be recorded with the COMPILED outcome");
    for (const record of compiledRecords) {
      assert(record.genomeDigest, "a compiled memory record must carry the canonical genome digest");
      assert(record.species, "a compiled memory record must carry the species");
    }
  });
});

test("56. Duplicate rejection is recorded in research memory, not silently dropped", async () => {
  await withTempRoot("evolve-phase5a2-", async (root) => {
    // A provider whose two proposals declare NO range: they compile to the
    // same genome and there is no faithful room to diversify, so the second
    // must be rejected as DUPLICATE_GENOME and remembered.
    const fixedProvider = {
      name: "duplicate-fixture",
      offline: true,
      propose: () => [
        validProposal({ proposalId: "P-dup-mem-1", changes: { flowWeight: 0.31 } }),
        validProposal({ proposalId: "P-dup-mem-2", changes: { flowWeight: 0.31 } }),
      ],
    };

    const report = await runResearchCycle({
      root,
      evidence: EMPTY_EVIDENCE,
      cycle: 1,
      seed: "dupe-memory",
      provider: fixedProvider,
      proposalsPerCycle: 2,
      maxCompilations: 4,
    });

    assertEqual(report.compiled.length, 1, "only the first genome may compile");
    assertEqual(report.rejectedDuplicates, 1, "the collision must be reported as a duplicate rejection");
    assertEqual(report.outcomes[MEMORY_OUTCOME.REJECTED_DUPLICATE], 1, "the lifecycle outcome must be REJECTED_DUPLICATE");

    const records = await readMemoryIndex(root, { limit: 100 });
    const duplicates = records.filter((record) => record.outcome === MEMORY_OUTCOME.REJECTED_DUPLICATE);
    assertEqual(duplicates.length, 1, "the duplicate rejection must be persisted in research memory");
    assert(duplicates[0].conclusion.toLowerCase().includes("duplicate"), "the memory record must name the duplicate reason");
  });
});

/* ============================================================================
 * L. Paper-only safety
 * ==========================================================================*/

test("57. No Phase 5A.2 module contains a real-execution, signing, or wallet path", async () => {
  const files = [
    "scripts/lib/args.mjs",
    "scripts/research/cohort.mjs",
    "scripts/research/compiler.mjs",
    "scripts/research/cycle.mjs",
    "scripts/research/provider.mjs",
    "scripts/research/promote.mjs",
    "scripts/research/memory.mjs",
    "scripts/arena/research-cohort.mjs",
    "scripts/arena/orchestrator.mjs",
    "scripts/arena/tournament.mjs",
    "scripts/arena.mjs",
  ];
  const FORBIDDEN = [
    /sendTransaction/i,
    /sendRawTransaction/i,
    /signTransaction/i,
    /fromSecretKey/i,
    /privateKey/i,
    /secretKey/i,
    /seedPhrase/i,
    /mnemonic/i,
    /wallet-adapter/i,
    /@solana\/web3\.js/i,
    /@solana\/kit/i,
    /new\s+Connection\s*\(/,
    /Keypair/i,
  ];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const pattern of FORBIDDEN) {
      assert(!pattern.test(text), `${file} must not contain ${pattern}`);
    }
  }
});

test("58. Research candidates are ordinary genomes: species-specific bounds still hold", () => {
  const proposals = validatedProviderProposals({ count: 6 });
  const { compiled } = compileProposals({ proposals, maxCompilations: 12 });
  for (const entry of compiled) {
    assert(SPECIES.includes(entry.species), "a compiled candidate must carry a real species");
    for (const key of Object.keys(entry.genome)) {
      const [lo, hi] = GENE_BOUNDS[key];
      const value = entry.genome[key];
      assert(value >= lo && value <= hi, `compiled ${key}=${value} escapes GENE_BOUNDS for species ${entry.species}`);
    }
    assertEqual(entry.compilerVersion, 2, "compiled entries must record the Phase 5A.2 compiler version");
  }
});

test("59. speciesDistribution helper counts compiled species correctly", () => {
  const rows = [{ species: "Momentum" }, { species: "Momentum" }, { species: "Liquidity" }, { species: undefined }];
  assertEqual(JSON.stringify(speciesDistribution(rows)), JSON.stringify({ Momentum: 2, Liquidity: 1 }), "distribution must count only real species labels");
});

test("60. An explicit targetSpecies is validated and reaches the compiled genome's species", () => {
  const proposal = validProposal({ proposalId: "P-species-1", parentFamilies: ["Momentum x Wallet Flow"], targetSpecies: "Experimental" });
  const { ok, proposal: validated } = validateProposal(proposal);
  assert(ok, "a real targetSpecies must validate");
  assertEqual(validated.targetSpecies, "Experimental", "targetSpecies must survive validation");
  const { compiled } = compileProposals({ proposals: [validated] });
  assertEqual(compiled.length, 1, "the proposal must compile");
  assertEqual(compiled[0].species, "Experimental", "the explicit targetSpecies must decide the compiled species");

  const bogus = validateProposal({ ...proposal, targetSpecies: "Not A Species" });
  assert(!bogus.ok, "a bogus targetSpecies must be rejected");
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

  console.log(`\nEVOLVE Phase 5A.2 validation: ${passed}/${cases.length} checks passed`);

  if (failures.length > 0) {
    console.log("Failed checks:");
    for (const failure of failures) console.log(`  - ${failure.name}`);
    process.exitCode = 1;
  } else {
    console.log("All Phase 5A.2 checks passed.");
    console.log(
      "PAPER RESEARCH ONLY. Nothing here is a profitability claim; zero Deployment Candidates and zero research survivors remain acceptable outcomes."
    );
  }
}

run().catch((error) => {
  console.error("phase 5a.2 validation runner crashed:", error);
  process.exitCode = 1;
});

export { cases };
void createSeededRandom;
