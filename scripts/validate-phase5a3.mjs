#!/usr/bin/env node
/**
 * EVOLVE Phase 5A.3 validation suite — controlled Research vs Conventional A/B
 * benchmarking.
 *
 * Covers: A/B mode parsing, matched cohort sizing, symmetric shortage handling,
 * the no-cloning policy, unique-seed enforcement on both sides, cohort/lineage
 * attribution through evolution, disabled cross-cohort crossover, evolution /
 * scoring / dataset / stress / gate parity, every headline A/B metric, the
 * role-lineage report, distinct-mint diagnostics, the statistical summary and
 * its deterministic bootstrap, the output artifact, regression of the existing
 * challenger / fair / normal arena modes, worker-count determinism, evidence
 * separation, promotion/quarantine rules, and paper-only safety.
 *
 * Dependency-free and fully offline (mock research provider, synthetic fixture
 * datasets). Same convention as validate-arena.mjs / validate-phase41.mjs /
 * validate-phase5a.mjs / validate-phase5a2.mjs.
 *
 * Run with: npm run validate:phase5a3
 */

import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseArgs } from "./lib/args.mjs";
import { digestOf } from "./lib/hash.mjs";
import { createMarketConfig } from "./market/config.mjs";
import { makeFixture } from "./make-fixture.mjs";
import {
  DEFAULT_DEPLOYMENT_GATES,
  STRESS_PROFILES,
  TOURNAMENT_STAGE_ORDER,
  ARENA_STAGE,
  GATE_STATUS,
  buildDatasetRegistry,
  computeGenomeMetrics,
  registrySummary,
  realEvidenceDatasets,
} from "./arena/orchestrator.mjs";
import { buildEntrantPool, runArenaTournament } from "./arena/tournament.mjs";
import {
  AB_COMPARISON_VERSION,
  buildAbComparison,
  cohortArenaPerformance,
  cohortDistinctMintDiagnostics,
  cohortTradingEvidence,
  compareDistributions,
  medianValue,
  percentileValue,
  quartiles,
  roleLineageMetrics,
  speciesMatchVerdict,
  summarizeAbForSummary,
} from "./arena/ab-comparison.mjs";
import {
  RESEARCH_ARENA_MODE,
  composeFairCohort,
  researchEntrantsFromCohort,
} from "./arena/research-cohort.mjs";
import { compileProposals } from "./research/compiler.mjs";
import { validateProposal } from "./research/proposal-schema.mjs";
import {
  AB_COHORT,
  AB_DEFAULTS,
  COHORT_IDENTITY,
  buildMatchedAbCohort,
  childLineage,
  convergenceStats,
  dedupeSeedEntrants,
  describeAbCohorts,
  normalizeLineage,
  seedLineageId,
  speciesMatchedConventionalSeeds,
} from "./research/ab-cohort.mjs";
import { ADVISORY_ROLES, PROPOSING_ROLES, mockProviderPropose } from "./research/provider.mjs";
import {
  MEMORY_OUTCOME,
  MEMORY_STATUS,
  appendMemoryRecord,
  createMemoryRecord,
  readMemoryIndex,
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
function assertClose(actual, expected, message, tolerance = 1e-6) {
  assert(
    Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${message} (expected ~${expected}, got ${actual})`,
  );
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

/** One shared synthetic fixture for the whole suite (kept small and offline). */
let sharedFixture = null;
let sharedFixtureRoot = null;

async function fixture() {
  if (sharedFixture) return sharedFixture;
  sharedFixtureRoot = await mkdtemp(path.join(tmpdir(), "evolve-phase5a3-"));
  const dir = path.join(sharedFixtureRoot, "fixture");
  await makeFixture({ dir, snapshots: 30, intervalMs: 60_000, seed: "phase5a3", tokenCount: 10 });
  const registry = await buildDatasetRegistry(sharedFixtureRoot);
  const datasets = registry.map((entry) => ({
    dir: entry.dir,
    id: entry.datasetId,
    fingerprint: entry.fingerprint,
    sourceType: entry.sourceType,
    regimesByWindow: {},
  }));
  sharedFixture = { root: sharedFixtureRoot, dir, registry, datasets };
  return sharedFixture;
}

async function disposeFixture() {
  if (sharedFixtureRoot) await rm(sharedFixtureRoot, { recursive: true, force: true }).catch(() => {});
  sharedFixture = null;
  sharedFixtureRoot = null;
}

const EMPTY_EVIDENCE = { cycle: 1 };

function validatedProposals({ count = 6, seed = "5a3", cycle = 1 } = {}) {
  const out = [];
  for (const raw of mockProviderPropose({ evidence: EMPTY_EVIDENCE, count, seed, cycle })) {
    const { ok, proposal } = validateProposal(raw);
    if (ok) out.push(proposal);
  }
  return out;
}

function researchSeedsFor(count = 6, seed = "5a3") {
  const proposals = validatedProposals({ count: Math.max(count, 6), seed });
  const { compiled } = compileProposals({ proposals, maxCompilations: count + 6 });
  return researchEntrantsFromCohort(compiled).slice(0, count);
}

/** Synthetic research-flavoured seeds with distinct genomes (deterministic). */
function syntheticResearchSeeds(count, prefix = "ab-research") {
  return Array.from({ length: count }, (_, index) => ({
    genome: { riskFraction: 0.05 + index * 0.001, stopLoss: 0.03 + index * 0.0005 },
    species: ["Momentum", "Reversal", "Liquidity", "Wallet Flow", "Experimental", "Genesis Hunter"][index % 6],
    origin: "research",
    research: {
      origin: "research",
      identity: "exact",
      familyId: `${prefix}-F${index}`,
      proposalId: `${prefix}-P${index}`,
      authorRole: PROPOSING_ROLES[index % PROPOSING_ROLES.length],
      researchFamily: "Momentum x Wallet Flow",
      researchGenomeDigest: null,
    },
  }));
}

function syntheticConventionalSeeds(count, prefix = "ab-conventional") {
  return Array.from({ length: count }, (_, index) => ({
    genome: { riskFraction: 0.2 + index * 0.001, stopLoss: 0.05 + index * 0.0005 },
    species: ["Liquidity", "Momentum", "Reversal", "Genesis Hunter", "Wallet Flow", "Experimental"][index % 6],
    origin: "immigrant",
    label: `${prefix}-${index}`,
  }));
}

/** Build a small matched A/B entrant list for the integration tests. */
function abEntrants({ requested = 12, researchCount = 6, conventionalCount = 12 } = {}) {
  const built = buildMatchedAbCohort({
    requestedPopulation: requested,
    researchSeeds: syntheticResearchSeeds(researchCount),
    conventionalSeeds: syntheticConventionalSeeds(conventionalCount),
  });
  assert(built.ok, "fixture cohort must build");
  return { built, entrants: [...built.research, ...built.conventional] };
}

async function runAbTournament({ entrants, built, workers = 0, arenasDir = null, arenaId = null, seeds = ["ab-1"] } = {}) {
  const { datasets } = await fixture();
  return runArenaTournament({
    datasets,
    config: tinyConfig(),
    entrants,
    seeds,
    stressProfiles: ["mild", "moderate"],
    maxWindows: 1,
    workers,
    useCache: false,
    arenaId,
    arenasDir,
    researchEnabled: true,
    researchMode: RESEARCH_ARENA_MODE.AB,
    abAccounting: built.accounting,
    abConfig: {
      generations: 1,
      workers,
      survivorFraction: 0.3,
      breederShare: 0.35,
      mutationScale: 0.07,
      crossoverRate: 0.48,
      immigrantRate: 0.1,
      randomImmigrantShare: 0.15,
      championShare: 0.35,
      immigrantShare: 0.15,
    },
    abRoles: { known: [...PROPOSING_ROLES, ...ADVISORY_ROLES], advisory: [...ADVISORY_ROLES] },
  });
}

const median = (values) => {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const rowsFor = (result, cohort) => result.candidateRows.filter((row) => row.cohort === cohort);

/* ============================================================================
 * A. A/B mode parsing and matched construction
 * ==========================================================================*/

const ARENA_FLAGS = {
  booleanFlags: ["research", "no-cache", "strict-research-uniqueness"],
  valueFlags: ["research-mode", "max-windows"],
};

test("1. `--research-mode ab` parses as a value flag and leaves the dataset positional", () => {
  const args = parseArgs(["--research-mode", "ab", "DATASET"], ARENA_FLAGS);
  assertEqual(args["research-mode"], "ab", "the ab mode must survive parsing");
  assertEqual(args._.join(","), "DATASET", "the dataset must stay positional");
});

test("2. A/B is a named research mode alongside challenger and fair", () => {
  assertEqual(RESEARCH_ARENA_MODE.AB, "ab", "ab must be the named mode");
  assertEqual(RESEARCH_ARENA_MODE.CHALLENGER, "challenger", "challenger must remain");
  assertEqual(RESEARCH_ARENA_MODE.FAIR, "fair", "fair must remain");
  assertEqual(new Set(Object.values(RESEARCH_ARENA_MODE)).size, 3, "the three modes must stay distinct");
});

test("3. A 50/50 A/B request produces two equal requested arms", () => {
  const built = buildMatchedAbCohort({
    requestedPopulation: 200,
    researchSeeds: syntheticResearchSeeds(70),
    conventionalSeeds: syntheticConventionalSeeds(150),
  });
  assertEqual(built.accounting.requestedPerCohort, 100, "200 requested at 50/50 is 100 per cohort");
  assertEqual(built.accounting.startingResearchSeeds, 70, "the smaller side still caps the match");
  assertEqual(built.accounting.startingConventionalSeeds, 70, "arms must stay equal");
  assertEqual(built.accounting.symmetricStartingSlots, true, "starting slots must be symmetric");
});

test("4. A shortage downgrades BOTH cohorts symmetrically (never 42 vs 158)", () => {
  const built = buildMatchedAbCohort({
    requestedPopulation: 200,
    researchSeeds: syntheticResearchSeeds(42),
    conventionalSeeds: syntheticConventionalSeeds(158),
  });
  assertEqual(built.accounting.startingResearchSeeds, 42, "research gets its 42 available seeds");
  assertEqual(built.accounting.startingConventionalSeeds, 42, "conventional must be trimmed to the same 42");
  assertEqual(built.accounting.seedShortage.research, 58, "the research seed shortfall must be reported");
  assertEqual(built.accounting.seedShortage.conventional, 0, "conventional was not short of seeds — it was trimmed for symmetry");
  assertEqual(built.accounting.matchedDowngrade, 58, "the symmetric downgrade must be quantified for both arms");
  assertEqual(built.accounting.requestedPerCohort - built.accounting.startingConventionalSeeds, 58, "conventional lost exactly the symmetric amount");
  assertEqual(built.accounting.downgraded, true, "the downgrade must be explicit");
  assertEqual(built.accounting.matchedDowngrade, 58, "the downgrade must be quantified");
  assert(built.accounting.shortageReason.includes("42"), "the reason must name the real unique seed count");
});

test("5. A/B never clones a genome to fill a missing slot", () => {
  const research = syntheticResearchSeeds(5);
  const duplicated = [...research, { ...research[0] }, { ...research[1] }];
  const built = buildMatchedAbCohort({
    requestedPopulation: 20,
    researchSeeds: duplicated,
    conventionalSeeds: syntheticConventionalSeeds(10),
  });
  const digests = [...built.research, ...built.conventional].map((entry) => entry.digest);
  assertEqual(new Set(digests).size, digests.length, "no genome may occupy two slots");
  assertEqual(built.accounting.cloningToFillQuota, 0, "cloning to fill a quota must be explicitly zero");
  assertEqual(built.accounting.startingResearchSeeds, 5, "only the 5 genuinely unique research seeds may be used");
  assertEqual(built.accounting.startingConventionalSeeds, 5, "conventional must match the shrunk research arm");
});

test("6. Duplicate research seed digests are rejected, counted, and consume no slot", () => {
  const research = syntheticResearchSeeds(4);
  const seeds = [...research, research[0], research[2]];
  const { unique, duplicates } = dedupeSeedEntrants(seeds);
  assertEqual(unique.length, 4, "only unique digests may survive");
  assertEqual(duplicates.length, 2, "both duplicates must be reported");
  assert(duplicates.every((row) => row.reason === "DUPLICATE_SEED_DIGEST"), "the reason must be explicit");
  const built = buildMatchedAbCohort({
    requestedPopulation: 10,
    researchSeeds: seeds,
    conventionalSeeds: syntheticConventionalSeeds(5),
  });
  assertEqual(built.accounting.seedDuplicatesRejected.research, 2, "the accounting must report research duplicates");
});

test("7. Duplicate conventional seed digests are rejected, counted, and consume no slot", () => {
  const conventional = syntheticConventionalSeeds(4);
  const built = buildMatchedAbCohort({
    requestedPopulation: 10,
    researchSeeds: syntheticResearchSeeds(5),
    conventionalSeeds: [...conventional, conventional[1], conventional[3]],
  });
  assertEqual(built.accounting.seedDuplicatesRejected.conventional, 2, "the accounting must report conventional duplicates");
  assertEqual(built.accounting.startingConventionalSeeds, 4, "only unique conventional seeds occupy slots");
  assertEqual(built.accounting.startingResearchSeeds, 4, "research is trimmed symmetrically");
});

test("8. A/B refuses to run when either side has no unique seed at all", () => {
  const none = buildMatchedAbCohort({
    requestedPopulation: 20,
    researchSeeds: [],
    conventionalSeeds: syntheticConventionalSeeds(10),
  });
  assertEqual(none.ok, false, "an empty research arm cannot be a matched cohort");
  assert(none.error, "the failure must carry a reason");
  const otherNone = buildMatchedAbCohort({
    requestedPopulation: 20,
    researchSeeds: syntheticResearchSeeds(10),
    conventionalSeeds: [],
  });
  assertEqual(otherNone.ok, false, "an empty conventional arm cannot be a matched cohort");
});

test("9. The one-line cohort summary is exact and usable in startup output", () => {
  const built = buildMatchedAbCohort({
    requestedPopulation: 200,
    researchSeeds: syntheticResearchSeeds(84),
    conventionalSeeds: syntheticConventionalSeeds(84),
  });
  assertEqual(describeAbCohorts(built.accounting), "research=84 conventional=84 total=168", "the summary must be exact");
});

test("10. Descendant expansion is opt-in and never exceeds the requested arm", () => {
  const off = buildMatchedAbCohort({
    requestedPopulation: 40,
    researchSeeds: syntheticResearchSeeds(10),
    conventionalSeeds: syntheticConventionalSeeds(40),
  });
  assertEqual(off.accounting.expandDescendants, false, "expansion must be off by default");
  assertEqual(off.accounting.targetPerCohort, 10, "without expansion the target is the matched seed count");

  const on = buildMatchedAbCohort({
    requestedPopulation: 40,
    researchSeeds: syntheticResearchSeeds(10),
    conventionalSeeds: syntheticConventionalSeeds(40),
    expandDescendants: true,
  });
  assertEqual(on.accounting.targetPerCohort, 20, "expansion grows toward the requested arm size");
  assertEqual(on.accounting.startingResearchSeeds, 10, "expansion must not change the seed accounting");
  assertEqual(on.accounting.cloningToFillQuota, 0, "expansion is evolution, never cloning");
});

/* ============================================================================
 * B. Cohort identity, lineage and independence
 * ==========================================================================*/

test("11. Research seeds carry cohort=research and exact-original identity", () => {
  const built = buildMatchedAbCohort({
    requestedPopulation: 10,
    researchSeeds: syntheticResearchSeeds(3),
    conventionalSeeds: syntheticConventionalSeeds(3),
  });
  for (const seed of built.research) {
    assertEqual(seed.cohort, AB_COHORT.RESEARCH, "every research seed must carry its cohort");
    assertEqual(seed.lineage.identity, COHORT_IDENTITY.EXACT_ORIGINAL, "a starting seed is an exact original");
    assertEqual(seed.lineage.generation, 0, "a starting seed is generation 0");
    assertEqual(seed.lineage.parentLineageIds.length, 0, "a starting seed has no parents");
    assert(seed.lineage.seedDigest, "the original seed digest must be recorded");
    assertEqual(seed.lineageId, seedLineageId(AB_COHORT.RESEARCH, seed.digest), "the lineage id must be digest-derived");
  }
});

test("12. Conventional seeds carry cohort=conventional and exact-original identity", () => {
  const built = buildMatchedAbCohort({
    requestedPopulation: 10,
    researchSeeds: syntheticResearchSeeds(3),
    conventionalSeeds: syntheticConventionalSeeds(3),
  });
  for (const seed of built.conventional) {
    assertEqual(seed.cohort, AB_COHORT.CONVENTIONAL, "every conventional seed must carry its cohort");
    assertEqual(seed.lineage.identity, COHORT_IDENTITY.EXACT_ORIGINAL, "a starting seed is an exact original");
    assertEqual(seed.lineage.researchFamilies.length, 0, "a conventional seed has no research ancestry");
  }
});

test("13. Breeders and descendants preserve the RESEARCH cohort", () => {
  const { entrants } = abEntrants({ requested: 12, researchCount: 6, conventionalCount: 12 });
  const research = entrants.filter((entry) => entry.cohort === AB_COHORT.RESEARCH);
  const pool = buildEntrantPool({
    champions: research,
    population: research.length,
    seed: "ab-research-breed",
    championShare: 0.5,
    cohort: AB_COHORT.RESEARCH,
  });
  assert(pool.length > 0, "the research cohort must breed");
  for (const entry of pool) {
    assertEqual(entry.cohort, AB_COHORT.RESEARCH, "research lineage must never become conventional");
    assert(entry.lineage, "every descendant must carry lineage");
    assertEqual(entry.lineage.cohort, AB_COHORT.RESEARCH, "lineage cohort must match");
  }
  assert(
    pool.some((entry) => entry.lineage.identity === COHORT_IDENTITY.DESCENDANT),
    "breeding must produce descendants",
  );
});

test("14. Breeders and descendants preserve the CONVENTIONAL cohort", () => {
  const { entrants } = abEntrants({ requested: 12, researchCount: 6, conventionalCount: 12 });
  const conventional = entrants.filter((entry) => entry.cohort === AB_COHORT.CONVENTIONAL);
  const pool = buildEntrantPool({
    champions: conventional,
    population: conventional.length,
    seed: "ab-conv-breed",
    championShare: 0.5,
    cohort: AB_COHORT.CONVENTIONAL,
  });
  for (const entry of pool) {
    assertEqual(entry.cohort, AB_COHORT.CONVENTIONAL, "conventional lineage must never become research");
    assertEqual(entry.lineage.cohort, AB_COHORT.CONVENTIONAL, "lineage cohort must match");
    assertEqual(entry.research ?? null, null, "a conventional descendant must not be labelled research");
  }
});

test("15. A descendant records parents, generation, and the ORIGINAL seed digest", () => {
  const built = buildMatchedAbCohort({
    requestedPopulation: 8,
    researchSeeds: syntheticResearchSeeds(2),
    conventionalSeeds: syntheticConventionalSeeds(2),
  });
  const [a, b] = built.research;
  const lineage = childLineage(a, b);
  assertEqual(lineage.generation, 1, "a child is one generation past its parents");
  assertEqual(lineage.identity, COHORT_IDENTITY.DESCENDANT, "a child is a descendant, never an exact original");
  assertEqual(lineage.parentLineageIds.length, 2, "both parent lineages must be recorded");
  assert(lineage.parentLineageIds.includes(a.lineageId), "the first parent lineage must be recorded");
  assert(lineage.parentLineageIds.includes(b.lineageId), "the second parent lineage must be recorded");
  assert(lineage.seedDigests.includes(a.lineage.seedDigest), "the original seed digest must survive");
  assertEqual(lineage.crossCohort, false, "two parents in the same cohort are not a cross-cohort cross");
});

test("16. Cross-cohort crossover is detectable and the A/B benchmark never allows it", () => {
  const built = buildMatchedAbCohort({
    requestedPopulation: 8,
    researchSeeds: syntheticResearchSeeds(2),
    conventionalSeeds: syntheticConventionalSeeds(2),
  });
  const cross = childLineage(built.research[0], built.conventional[0]);
  assertEqual(cross.crossCohort, true, "a research x conventional child must be flagged");
  assertEqual(built.accounting.crossCohortCrossover, false, "A/B must declare cross-cohort crossover disabled");
});

test("17. Cohort-separated breeding never produces a cross-cohort child", () => {
  const { entrants } = abEntrants({ requested: 16, researchCount: 8, conventionalCount: 16 });
  const research = entrants.filter((entry) => entry.cohort === AB_COHORT.RESEARCH);
  const conventional = entrants.filter((entry) => entry.cohort === AB_COHORT.CONVENTIONAL);
  const researchPool = buildEntrantPool({
    champions: research,
    population: research.length,
    seed: "sep-r",
    championShare: 0.5,
    cohort: AB_COHORT.RESEARCH,
  });
  const conventionalPool = buildEntrantPool({
    champions: conventional,
    population: conventional.length,
    seed: "sep-c",
    championShare: 0.5,
    cohort: AB_COHORT.CONVENTIONAL,
  });
  for (const entry of [...researchPool, ...conventionalPool]) {
    assertEqual(entry.lineage.crossCohort, false, "no A/B descendant may ever be a cross-cohort cross");
  }
});

test("18. Lineage ids are deterministic: the same seeds always build the same lineages", () => {
  const build = () =>
    buildMatchedAbCohort({
      requestedPopulation: 12,
      researchSeeds: syntheticResearchSeeds(6),
      conventionalSeeds: syntheticConventionalSeeds(12),
    });
  const a = build();
  const b = build();
  const ids = (built) => [...built.research, ...built.conventional].map((entry) => entry.lineageId);
  assertEqual(JSON.stringify(ids(a)), JSON.stringify(ids(b)), "lineage ids must be reproducible");
});

test("19. Convergence is recorded, never silently de-duplicated", () => {
  const rows = [
    { digest: "d1" },
    { digest: "d1" },
    { digest: "d2" },
    { digest: "d3" },
    { digest: "d1" },
  ];
  const stats = convergenceStats(rows);
  assertEqual(stats.occupiedSlots, 5, "every slot must be counted");
  assertEqual(stats.uniqueFinalGenomes, 3, "unique genomes must be counted separately");
  assertEqual(stats.convergenceCount, 2, "descendant convergence must be counted, not removed");
  assertEqual(stats.repeatedDigests.length, 1, "the converged digest must be named");
});

test("20. normalizeLineage reads both cohorts and never mislabels one as the other", () => {
  const built = buildMatchedAbCohort({
    requestedPopulation: 6,
    researchSeeds: syntheticResearchSeeds(2, "norm-r"),
    conventionalSeeds: syntheticConventionalSeeds(2, "norm-c"),
  });
  const research = normalizeLineage(built.research[0]);
  const conventional = normalizeLineage(built.conventional[0]);
  assertEqual(research.cohort, AB_COHORT.RESEARCH, "research must stay research");
  assertEqual(conventional.cohort, AB_COHORT.CONVENTIONAL, "conventional must stay conventional");
  assertEqual(research.exactOriginal, true, "an untouched seed is exact-original");
  assertEqual(conventional.researchFamilies.length, 0, "conventional has no research ancestry");
  const child = normalizeLineage({ cohort: AB_COHORT.CONVENTIONAL, lineage: childLineage(built.conventional[0]) });
  assertEqual(child.descendant, true, "a bred child is a descendant");
  assertEqual(child.cohort, AB_COHORT.CONVENTIONAL, "a conventional child stays conventional");
});

test("21. The species-matched conventional control is deterministic and species-exact", () => {
  const research = syntheticResearchSeeds(6);
  const a = speciesMatchedConventionalSeeds({ researchSeeds: research, population: 6, seed: "match" });
  const b = speciesMatchedConventionalSeeds({ researchSeeds: research, population: 6, seed: "match" });
  assertEqual(JSON.stringify(a), JSON.stringify(b), "species matching must be deterministic");
  const tally = (rows) => {
    const counts = rows.reduce((acc, row) => ({ ...acc, [row.species]: (acc[row.species] ?? 0) + 1 }), {});
    return Object.fromEntries(Object.entries(counts).sort(([x], [y]) => x.localeCompare(y)));
  };
  assertEqual(JSON.stringify(tally(a)), JSON.stringify(tally(research)), "species counts must match the research cohort");
  assertEqual(JSON.stringify(tally(b)), JSON.stringify(tally(a)), "species matching must be reproducible");
});

/* ============================================================================
 * C. Parity: evolution, scoring, datasets, stress, gates
 * ==========================================================================*/

test("22. Both cohorts receive identical structural evolutionary treatment", () => {
  const tagged = buildMatchedAbCohort({
    requestedPopulation: 24,
    researchSeeds: syntheticResearchSeeds(12, "parity-r"),
    conventionalSeeds: syntheticConventionalSeeds(12, "parity-c"),
  });
  const research = tagged.research;
  const conventional = tagged.conventional;
  const researchPool = buildEntrantPool({
    champions: research,
    population: 12,
    seed: "parity-r",
    championShare: 0.35,
    immigrantShare: 0.15,
    cohort: AB_COHORT.RESEARCH,
  });
  const conventionalPool = buildEntrantPool({
    champions: conventional,
    population: 12,
    seed: "parity-c",
    championShare: 0.35,
    immigrantShare: 0.15,
    cohort: AB_COHORT.CONVENTIONAL,
  });
  assertEqual(researchPool.length, conventionalPool.length, "equal starting slots must stay equal after breeding");
  const budget = (rows) => ({
    evolved: rows.filter((row) => row.lineage?.generation === 1).length,
    immigrantFounders: rows.filter((row) => row.lineage?.founderKind === "immigrant").length,
    seedReentries: rows.filter((row) => row.lineage?.founderKind === "seed").length,
  });
  assertEqual(
    JSON.stringify(budget(researchPool)),
    JSON.stringify(budget(conventionalPool)),
    "champion/evolved/immigrant budgets must be identical for both cohorts",
  );
  assert(
    budget(researchPool).evolved > 0 && budget(researchPool).immigrantFounders > 0,
    "the identical budget must actually include both evolved and immigrant slots",
  );
  for (const entry of [...researchPool, ...conventionalPool]) {
    assert(entry.cohort, "every bred A/B entrant must carry its cohort");
    assert(entry.lineage, "every bred A/B entrant must carry its lineage");
  }
});

test("23. AB_DEFAULTS documents an equal-resource, no-bonus configuration", () => {
  assertEqual(AB_DEFAULTS.researchShare, 0.5, "A/B must start symmetric");
  assertEqual(AB_DEFAULTS.expandDescendants, false, "descendant expansion must be opt-in");
  assert(AB_DEFAULTS.bootstrapIterations > 0, "a deterministic bootstrap iteration count must exist");
  assert(typeof AB_DEFAULTS.bootstrapSeed === "string" && AB_DEFAULTS.bootstrapSeed.length > 0, "the bootstrap needs a fixed seed");
});

test("24. A cohort label has NO effect on any candidate's Arena score", async () => {
  const built = buildMatchedAbCohort({
    requestedPopulation: 8,
    researchSeeds: syntheticResearchSeeds(4, "score-r"),
    conventionalSeeds: syntheticConventionalSeeds(4, "score-c"),
  });
  const first = await runAbTournament({ entrants: [...built.research, ...built.conventional], built });
  const swappedBuilt = {
    accounting: built.accounting,
  };
  const swapped = await runAbTournament({
    entrants: [...built.conventional, ...built.research].map((entry) => ({
      ...entry,
      cohort: entry.cohort === AB_COHORT.RESEARCH ? AB_COHORT.CONVENTIONAL : AB_COHORT.RESEARCH,
    })),
    built: swappedBuilt,
  });
  const scores = (result) => new Map(result.candidateRows.map((row) => [row.digest, row.score]));
  const a = scores(first);
  const b = scores(swapped);
  for (const [digest, score] of a) {
    assertEqual(b.get(digest), score, `score must not depend on cohort label (${digest})`);
  }
  // Gate outcomes must be label-independent too: the SAME genome must receive
  // the same gate verdict whether it is filed under research or conventional.
  const verdicts = (result) =>
    new Map(result.candidateRows.map((row) => [row.digest, `${row.gateStatus}|${(row.failedGates ?? []).join(",")}`]));
  const va = verdicts(first);
  const vb = verdicts(swapped);
  for (const [digest, verdict] of va) {
    assertEqual(vb.get(digest), verdict, `gate outcome must not depend on cohort label (${digest})`);
  }
});

test("25. Both cohorts see the identical seed list, datasets, windows and stress profiles", async () => {
  const { built, entrants } = abEntrants({ requested: 12, researchCount: 6, conventionalCount: 12 });
  const result = await runAbTournament({ entrants, built, seeds: ["ab-parity-1", "ab-parity-2"] });
  const ab = result.summary.abComparison;
  assert(ab.parity, "the compact A/B block must carry parity data");
  assertEqual(JSON.stringify(ab.parity.seeds), JSON.stringify(result.summary.seeds), "the A/B config must record the run's exact seeds");
  assertEqual(ab.parity.seeds.length, 2, "both seeds must be visible");
  assertEqual(JSON.stringify(ab.parity.stressProfiles), JSON.stringify(result.summary.stressProfiles), "stress profiles must match");
  assertEqual(
    JSON.stringify(ab.parity.datasetIds),
    JSON.stringify(result.summary.datasets.map((dataset) => dataset.id)),
    "dataset identity must be shared",
  );
  assert(
    ab.parity.datasetFingerprints.every((fingerprint) => fingerprint),
    "dataset fingerprints must be recorded for reproducibility",
  );
  assertEqual(ab.parity.equalScoring, true, "the artifact must assert equal scoring");
  assertEqual(ab.parity.equalGates, true, "the artifact must assert equal gates");
  assertEqual(ab.parity.equalEvolutionaryRules, true, "the artifact must assert equal evolutionary rules");
  assertEqual(ab.parity.equalStartingSlots, true, "the artifact must assert equal starting slots");
  assertEqual(ab.parity.scoringBonusForEitherCohort, 0, "no cohort may receive a scoring bonus");
  assertEqual(ab.parity.crossCohortCrossover, false, "cross-cohort crossover must be recorded as disabled");
});

test("26. The A/B run applies the unchanged gate table to both cohorts", async () => {
  await withTempRoot("evolve-phase5a3-gates-", async (arenasDir) => {
    const { built, entrants } = abEntrants({ requested: 12, researchCount: 6, conventionalCount: 12 });
    const arenaId = "arena-5a3-gates";
    await runAbTournament({ entrants, built, arenasDir, arenaId });
    const manifest = JSON.parse(await readFile(path.join(arenasDir, arenaId, "manifest.json"), "utf8"));
    const expectedGates = { ...DEFAULT_DEPLOYMENT_GATES, ...tinyConfig().arena.gates };
    for (const [key, value] of Object.entries(expectedGates)) {
      assertEqual(manifest.deploymentGates[key], value, `A/B must apply exactly the configured ${key} gate`);
    }
    assertEqual("researchGates" in manifest.deploymentGates, false, "no research-only gate set may exist");
    assertEqual("conventionalGates" in manifest.deploymentGates, false, "no conventional-only gate set may exist");
    const artifactResearch = JSON.parse(await readFile(path.join(arenasDir, arenaId, "ab-comparison.json"), "utf8"));
    assertEqual(
      artifactResearch.distinctMintDiagnostics.research.minDistinctMintsGate,
      artifactResearch.distinctMintDiagnostics.conventional.minDistinctMintsGate,
      "the distinct-mint gate must be identical for both cohorts",
    );
  });
});

test("27. The tournament funnel uses one rule set for every entrant", async () => {
  const { built, entrants } = abEntrants({ requested: 12, researchCount: 6, conventionalCount: 12 });
  const result = await runAbTournament({ entrants, built });
  for (const stage of Object.values(result.summary.funnel)) {
    assert(typeof stage.rule === "string" && stage.rule.length > 0, "every funnel stage must document its rule");
  }
  for (const row of result.candidateRows) {
    assert(
      row.highestStage === null || TOURNAMENT_STAGE_ORDER.includes(row.highestStage),
      "every candidate must use the shared stage vocabulary",
    );
  }
});

/* ============================================================================
 * D. Headline metrics
 * ==========================================================================*/

test("28. Cohort totals are exact and equal for a matched run", async () => {
  const { built, entrants } = abEntrants({ requested: 12, researchCount: 6, conventionalCount: 12 });
  const result = await runAbTournament({ entrants, built });
  const ab = result.summary.abComparison;
  assertEqual(ab.cohortSize.research, 6, "the research cohort must be exactly the matched size");
  assertEqual(ab.cohortSize.conventional, 6, "the conventional cohort must be exactly the matched size");
  assertEqual(ab.cohortSize.total, 12, "the cohorts must account for every entrant");
  assertEqual(ab.cohortSize.equalSize, true, "the cohorts must be equal");
  assertEqual(ab.cohortSize.research + ab.cohortSize.conventional, result.candidateRows.length, "totals must be exact");
});

test("29. top-10 counts are exact per cohort", async () => {
  const { built, entrants } = abEntrants({ requested: 12, researchCount: 6, conventionalCount: 12 });
  const result = await runAbTournament({ entrants, built });
  const ab = result.summary.abComparison;
  for (const [cohort, block] of [["research", ab.research], ["conventional", ab.conventional]]) {
    const expected = rowsFor(result, cohort).filter((row) => row.finalRank <= 10).length;
    assertEqual(block.top10Count, expected, `${cohort} top-10 count must match the rows`);
  }
});

test("30. top-25 counts are exact per cohort", async () => {
  const { built, entrants } = abEntrants({ requested: 12, researchCount: 6, conventionalCount: 12 });
  const result = await runAbTournament({ entrants, built });
  for (const [cohort, block] of [["research", result.summary.abComparison.research], ["conventional", result.summary.abComparison.conventional]]) {
    const expected = rowsFor(result, cohort).filter((row) => row.finalRank <= 25).length;
    assertEqual(block.top25Count, expected, `${cohort} top-25 count must match the rows`);
  }
});

test("31. top-50 counts are exact per cohort", async () => {
  const { built, entrants } = abEntrants({ requested: 12, researchCount: 6, conventionalCount: 12 });
  const result = await runAbTournament({ entrants, built });
  for (const [cohort, block] of [["research", result.summary.abComparison.research], ["conventional", result.summary.abComparison.conventional]]) {
    const expected = rowsFor(result, cohort).filter((row) => row.finalRank <= 50).length;
    assertEqual(block.top50Count, expected, `${cohort} top-50 count must match the rows`);
  }
});

test("32. GROUP counts are exact per cohort", async () => {
  const { built, entrants } = abEntrants({ requested: 12, researchCount: 6, conventionalCount: 12 });
  const result = await runAbTournament({ entrants, built });
  const reached = new Set([ARENA_STAGE.GROUP, ARENA_STAGE.STRESS, ARENA_STAGE.CHAMPION_LEAGUE]);
  for (const [cohort, block] of [["research", result.summary.abComparison.research], ["conventional", result.summary.abComparison.conventional]]) {
    const expected = rowsFor(result, cohort).filter((row) => reached.has(row.highestStage)).length;
    assertEqual(block.groupCount, expected, `${cohort} GROUP count must match the rows`);
  }
});

test("33. STRESS counts are exact per cohort", async () => {
  const { built, entrants } = abEntrants({ requested: 12, researchCount: 6, conventionalCount: 12 });
  const result = await runAbTournament({ entrants, built });
  const survived = new Set([ARENA_STAGE.STRESS, ARENA_STAGE.CHAMPION_LEAGUE]);
  for (const [cohort, block] of [["research", result.summary.abComparison.research], ["conventional", result.summary.abComparison.conventional]]) {
    const expected = rowsFor(result, cohort).filter((row) => survived.has(row.highestStage)).length;
    assertEqual(block.stressCount, expected, `${cohort} STRESS count must match the rows`);
  }
});

test("34. Champion League counts are exact per cohort", async () => {
  const { built, entrants } = abEntrants({ requested: 14, researchCount: 7, conventionalCount: 14 });
  const result = await runAbTournament({ entrants, built });
  for (const [cohort, block] of [["research", result.summary.abComparison.research], ["conventional", result.summary.abComparison.conventional]]) {
    const expected = rowsFor(result, cohort).filter((row) => row.isChampionLeagueFinalist === true).length;
    assertEqual(block.championLeagueCount, expected, `${cohort} Champion League count must match the rows`);
  }
  assertEqual(
    result.summary.abComparison.research.championLeagueCount + result.summary.abComparison.conventional.championLeagueCount,
    result.summary.championLeague.length,
    "the final eight must be fully attributed to the two cohorts",
  );
});

test("35. Deployment counts are exact per cohort", async () => {
  const { built, entrants } = abEntrants({ requested: 12, researchCount: 6, conventionalCount: 12 });
  const result = await runAbTournament({ entrants, built });
  for (const [cohort, block] of [["research", result.summary.abComparison.research], ["conventional", result.summary.abComparison.conventional]]) {
    const expected = rowsFor(result, cohort).filter((row) => row.deploymentEligible === true).length;
    assertEqual(block.deploymentCount, expected, `${cohort} deployment count must match the rows`);
    assertEqual(block.deploymentCount, 0, "a synthetic fixture must not manufacture a deployment candidate");
  }
});

test("36. Median and mean Arena scores are exact per cohort", async () => {
  const { built, entrants } = abEntrants({ requested: 14, researchCount: 7, conventionalCount: 14 });
  const result = await runAbTournament({ entrants, built });
  for (const [cohort, block] of [["research", result.summary.abComparison.research], ["conventional", result.summary.abComparison.conventional]]) {
    const scores = rowsFor(result, cohort).map((row) => row.score);
    assertClose(block.medianScore, median(scores), `${cohort} median score must match`, 1e-6);
    assertClose(block.meanScore, scores.reduce((a, b) => a + b, 0) / scores.length, `${cohort} mean score must match`, 1e-6);
    assertEqual(block.bestScore, Math.max(...scores), `${cohort} best score must match`);
    assertEqual(block.bestRank, Math.min(...rowsFor(result, cohort).map((row) => row.finalRank)), `${cohort} best rank must match`);
  }
});

test("37. Trading-evidence medians are derived from the candidates' own paper metrics", async () => {
  const { built, entrants } = abEntrants({ requested: 12, researchCount: 6, conventionalCount: 12 });
  const result = await runAbTournament({ entrants, built });
  for (const [cohort, block] of [["research", result.summary.abComparison.research], ["conventional", result.summary.abComparison.conventional]]) {
    const rows = rowsFor(result, cohort);
    assertClose(block.medianTrades, median(rows.map((row) => row.paperEvidence.medianTrades)), `${cohort} median trades must match`, 1e-6);
    assertClose(block.medianDistinctMints, median(rows.map((row) => row.paperEvidence.medianDistinctMints)), `${cohort} median distinct mints must match`, 1e-6);
    assertClose(block.medianDrawdown, median(rows.map((row) => row.paperEvidence.medianDrawdown)), `${cohort} median drawdown must match`, 1e-6);
    assertClose(block.medianNetPaperReturn, median(rows.map((row) => row.paperEvidence.medianNetReturn)), `${cohort} median net paper return must match`, 1e-6);
  }
  assertEqual(result.summary.abComparison.research.medianTrades != null, true, "trading medians must be present");
});

test("38. Robustness counts (stress survival, regime coverage) are exact per cohort", async () => {
  const { built, entrants } = abEntrants({ requested: 12, researchCount: 6, conventionalCount: 12 });
  const result = await runAbTournament({ entrants, built });
  for (const [cohort, block] of [["research", result.summary.abComparison.research], ["conventional", result.summary.abComparison.conventional]]) {
    const rows = rowsFor(result, cohort);
    const expected = rows.filter((row) => (row.paperEvidence.stressSurvived ?? 0) >= 1).length;
    assertEqual(block.stressSurvivalCount, expected, `${cohort} stress-survival count must match the rows`);
  }
});

test("39. Diversity metrics (unique ratio, lineage concentration, species mix) are exact", async () => {
  const { built, entrants } = abEntrants({ requested: 12, researchCount: 6, conventionalCount: 12 });
  const result = await runAbTournament({ entrants, built });
  const ab = result.summary.abComparison;
  for (const [cohort, block, pool] of [
    ["research", ab.research, built.research],
    ["conventional", ab.conventional, built.conventional],
  ]) {
    const rows = rowsFor(result, cohort);
    const unique = new Set(rows.map((row) => row.digest)).size;
    assertEqual(block.uniqueFinalGenomes, unique, `${cohort} unique final genomes must match`);
    assertClose(block.genomeDiversity, unique / rows.length, `${cohort} genome diversity must match`, 1e-6);
    const expected = computeGenomeMetrics(
      pool.map((entry) => ({
        genome: entry.genome,
        species: entry.species,
        digest: entry.digest,
        lineageId: entry.lineageId,
      })),
    );
    assertClose(block.lineageConcentration, expected.lineageConcentration, `${cohort} lineage concentration must match`, 1e-6);
  }
});

test("40. Species distribution is reported per cohort and compared", async () => {
  const { built, entrants } = abEntrants({ requested: 12, researchCount: 6, conventionalCount: 12 });
  const result = await runAbTournament({ entrants, built });
  const ab = result.summary.abComparison;
  const tally = (rows) =>
    rows.reduce((acc, row) => ({ ...acc, [row.species]: (acc[row.species] ?? 0) + 1 }), {});
  assertEqual(JSON.stringify(ab.species.research), JSON.stringify(tally(rowsFor(result, "research"))), "research species mix must match");
  assertEqual(JSON.stringify(ab.species.conventional), JSON.stringify(tally(rowsFor(result, "conventional"))), "conventional species mix must match");
  assert(typeof ab.species.matched === "boolean", "the match verdict must be reported");
  assert(ab.species.matchMode, "the match mode must be named");
});

test("41. speciesMatchVerdict only reports a match when every count agrees", () => {
  const matched = speciesMatchVerdict({ Momentum: 3, Reversal: 2 }, { Momentum: 3, Reversal: 2 });
  assertEqual(matched.matched, true, "identical counts must match");
  const mismatched = speciesMatchVerdict({ Momentum: 3, Reversal: 2 }, { Momentum: 4, Reversal: 1 });
  assertEqual(mismatched.matched, false, "different counts must not match");
  assertEqual(mismatched.deltas.Momentum, -1, "the delta must be computed per species");
  const missing = speciesMatchVerdict({ Momentum: 1 }, {});
  assertEqual(missing.matched, false, "a species that exists on only one side is a mismatch");
});

test("42. Failed-gate distribution is reported per cohort and never softened", async () => {
  const { built, entrants } = abEntrants({ requested: 12, researchCount: 6, conventionalCount: 12 });
  const result = await runAbTournament({ entrants, built });
  const artifact = buildAbComparison({
    candidateRows: result.candidateRows,
    entrants,
    accounting: { ...built.accounting, speciesMatched: false },
    config: {},
    datasets: result.summary.datasets,
    seeds: result.summary.seeds,
    stressProfiles: result.summary.stressProfiles,
  });
  for (const cohort of ["research", "conventional"]) {
    const rows = rowsFor(result, cohort);
    const expected = {};
    for (const row of rows) for (const gate of row.failedGates) expected[gate] = (expected[gate] ?? 0) + 1;
    assertEqual(
      JSON.stringify(artifact.cohorts[cohort].failedGates),
      JSON.stringify(expected),
      `${cohort} failed-gate distribution must match the rows`,
    );
  }
});

test("43. Distinct-mint diagnostics are reported separately for research and conventional", () => {
  const researchRows = [
    {
      cohort: AB_COHORT.RESEARCH,
      distinctMintDiagnostics: {
        opportunitiesObserved: 100,
        eligibleMints: 3,
        mintsEntered: 2,
        distinctMints: 2,
        trades: 4,
        explanation: ["the eligible universe itself was narrow (3 mints ever passed the genome's gates)"],
      },
      failedGates: ["minimum distinct mints"],
    },
  ];
  const conventionalRows = [
    {
      cohort: AB_COHORT.CONVENTIONAL,
      distinctMintDiagnostics: {
        opportunitiesObserved: 120,
        eligibleMints: 9,
        mintsEntered: 7,
        distinctMints: 7,
        trades: 20,
        explanation: [],
      },
      failedGates: [],
    },
  ];
  const research = cohortDistinctMintDiagnostics(researchRows);
  const conventional = cohortDistinctMintDiagnostics(conventionalRows);
  assertEqual(research.opportunitiesObserved, 100, "research opportunities must be pooled");
  assertEqual(research.eligibleMints, 3, "research eligible mints must be pooled");
  assertEqual(research.mintsEntered, 2, "research traded mints must be pooled");
  assertEqual(research.failedMinDistinctMintsGate, 1, "the failed gate must be counted");
  assertEqual(conventional.failedMinDistinctMintsGate, 0, "the conventional control passed its gate");
  assertEqual(research.minDistinctMintsGate, DEFAULT_DEPLOYMENT_GATES.minDistinctMints, "the gate must be unchanged");
  assertEqual(conventional.minDistinctMintsGate, DEFAULT_DEPLOYMENT_GATES.minDistinctMints, "the same gate applies to both");
});

test("44. `minimum distinct mints` is NOT weakened by the A/B comparison", async () => {
  assertEqual(DEFAULT_DEPLOYMENT_GATES.minDistinctMints, 4, "the deployment gate must still be 4");
  assert(Object.isFrozen(DEFAULT_DEPLOYMENT_GATES), "the gate table must stay frozen");
  const { built, entrants } = abEntrants({ requested: 10, researchCount: 5, conventionalCount: 10 });
  const result = await runAbTournament({ entrants, built });
  const ab = result.summary.abComparison;
  assertEqual(ab.cohortConstruction.actualPerCohort, 5, "the fixture must have run");
  void ab;
});

test("45. Role-lineage metrics attribute descendants to their originating research role", async () => {
  const { built, entrants } = abEntrants({ requested: 12, researchCount: 6, conventionalCount: 12 });
  const result = await runAbTournament({ entrants, built });
  const artifact = buildAbComparison({
    candidateRows: result.candidateRows,
    entrants,
    accounting: built.accounting,
    config: {},
    datasets: result.summary.datasets,
    seeds: result.summary.seeds,
    stressProfiles: result.summary.stressProfiles,
    knownRoles: [...PROPOSING_ROLES, ...ADVISORY_ROLES],
    advisoryRoles: [...ADVISORY_ROLES],
  });
  const roles = artifact.roles.research;
  let seeded = 0;
  for (const [role, block] of Object.entries(roles)) {
    assertEqual(block.role, role, "the role must be keyed by its own name");
    assertFinite(block.startingUniqueSeeds, "startingUniqueSeeds must be a finite count");
    assertFinite(block.descendantsAtFreeze, "descendantsAtFreeze must be a finite count");
    seeded += block.startingUniqueSeeds;
    if (block.descendantsAtFreeze > 0) {
      assertFinite(block.medianArenaScore, `${role} must report a median Arena score when it has descendants`);
      assert(block.bestRank === null || Number.isFinite(block.bestRank), `${role} best rank must be finite or null`);
      assertFinite(block.medianDistinctMints, `${role} median distinct mints must be finite`);
      assertFinite(block.medianDrawdown, `${role} median drawdown must be finite`);
    }
  }
  assertEqual(seeded, 6, "every research seed must be attributed to exactly one originating role");
});

test("46. Advisory roles are marked advisory and never fabricated", () => {
  const metrics = roleLineageMetrics({
    researchSeeds: [],
    researchRows: [],
    knownRoles: [...PROPOSING_ROLES, ...ADVISORY_ROLES],
    advisoryRoles: [...ADVISORY_ROLES],
  });
  const critic = metrics["adversarial-critic"];
  assert(critic, "the advisory critic must be reported, not hidden");
  assertEqual(critic.advisory, true, "the critic must be marked advisory");
  assertEqual(critic.advisoryMode, "ADVISORY", "the mode must be explicit");
  assertEqual(critic.startingUniqueSeeds, 0, "an advisory role originates no seed");
  assertEqual(critic.descendantsAtFreeze, 0, "no entrant may be fabricated for an advisory role");
  assertEqual(critic.inactive, true, "an advisory role with no seeds is inactive");
});

test("47. Median metrics and quartiles are computed correctly", () => {
  assertEqual(medianValue([1, 2, 3]), 2, "odd-length median");
  assertEqual(medianValue([1, 2, 3, 4]), 2.5, "even-length median must interpolate");
  assertEqual(medianValue([]), null, "an empty sample has no median");
  assertEqual(percentileValue([0, 10], 0.25), 2.5, "percentiles must interpolate");
  const q = quartiles([1, 2, 3, 4, 5]);
  assertEqual(q.median, 3, "the median must be reported");
  assertEqual(q.q1, 2, "Q1 must be reported");
  assertEqual(q.q3, 4, "Q3 must be reported");
});

/* ============================================================================
 * E. Statistical summary
 * ==========================================================================*/

test("48. Descriptive differences (median, mean, IQR) are correct", () => {
  const comparison = compareDistributions([10, 20, 30], [1, 2, 3], { iterations: 0 });
  assertEqual(comparison.research.median, 20, "research median must be reported");
  assertEqual(comparison.conventional.median, 2, "conventional median must be reported");
  assertEqual(comparison.difference.median, 18, "the median difference must be research minus conventional");
  assertEqual(comparison.difference.mean, 18, "the mean difference must be reported");
  assertEqual(comparison.research.interquartileRange, 10, "the research IQR must be reported");
  assertEqual(comparison.research.n, 3, "the research sample size must be reported");
});

test("49. The statistical summary never claims significance or profitability", async () => {
  const { built, entrants } = abEntrants({ requested: 10, researchCount: 5, conventionalCount: 10 });
  const result = await runAbTournament({ entrants, built });
  const artifact = buildAbComparison({
    candidateRows: result.candidateRows,
    entrants,
    accounting: built.accounting,
    config: {},
    datasets: result.summary.datasets,
    seeds: result.summary.seeds,
    stressProfiles: result.summary.stressProfiles,
    bootstrapIterations: 200,
    bootstrapSeed: "phase5a3-ci",
  });
  assertEqual(artifact.statistics.significance, null, "no significance claim may be made");
  assert(artifact.statistics.significanceNote.includes("not a hypothesis test"), "the note must say so");
  assertEqual(artifact.paperOnly, true, "the artifact must be marked paper-only");
  assert(artifact.limitations.length >= 4, "the artifact must list its limitations");
  assert(
    artifact.limitations.some((line) => line.includes("PAPER ONLY")),
    "the limitations must state paper-only explicitly",
  );
  assertEqual(artifact.schemaVersion, AB_COMPARISON_VERSION, "the artifact schema version must be recorded");
});

test("50. The bootstrap is deterministic and reproducible for a fixed seed", () => {
  const a = compareDistributions([10, 20, 30, 40], [1, 2, 3, 4], { iterations: 500, seed: "fixed" });
  const b = compareDistributions([10, 20, 30, 40], [1, 2, 3, 4], { iterations: 500, seed: "fixed" });
  assertEqual(JSON.stringify(a.bootstrap), JSON.stringify(b.bootstrap), "the same seed must reproduce the same interval");
  assertEqual(a.bootstrap.available, true, "a bootstrap must be available for two non-empty samples");
  assertEqual(a.bootstrap.iterations, 500, "the iteration count must be recorded");
  assertEqual(a.bootstrap.seed, "fixed", "the seed must be recorded");
  assert(
    a.bootstrap.medianDifference.low <= a.bootstrap.medianDifference.high,
    "the interval bounds must be ordered",
  );
});

test("51. An empty or one-sided cohort makes the bootstrap explicitly unavailable, not wrong", () => {
  const comparison = compareDistributions([1, 2, 3], [], { iterations: 100, seed: "x" });
  assertEqual(comparison.bootstrap.available, false, "a one-sided cohort cannot be bootstrapped");
  assertEqual(comparison.conventional.median, null, "an empty cohort has no median");
  assertEqual(comparison.difference.median, null, "an empty cohort cannot produce a difference");
});

/* ============================================================================
 * F. Output artifacts
 * ==========================================================================*/

test("52. `ab-comparison.json` is written with the full artifact and summary.json carries a compact A/B block", async () => {
  await withTempRoot("evolve-phase5a3-arenas-", async (arenasDir) => {
    const { built, entrants } = abEntrants({ requested: 12, researchCount: 6, conventionalCount: 12 });
    const arenaId = "arena-5a3-ab";
    const result = await runAbTournament({ entrants, built, arenasDir, arenaId });
    const artifact = JSON.parse(await readFile(path.join(arenasDir, arenaId, "ab-comparison.json"), "utf8"));
    for (const field of [
      "schemaVersion",
      "arenaId",
      "paperOnly",
      "researchMode",
      "question",
      "config",
      "datasets",
      "cohortConstruction",
      "cohortSize",
      "cohorts",
      "comparison",
      "species",
      "families",
      "roles",
      "distinctMintDiagnostics",
      "lineage",
      "statistics",
      "limitations",
      "note",
    ]) {
      assert(artifact[field] !== undefined, `ab-comparison.json must expose ${field}`);
    }
    assertEqual(artifact.arenaId, arenaId, "the artifact must record its arena id");
    assertEqual(artifact.researchMode, "ab", "the artifact must record A/B mode");
    assertEqual(artifact.cohortConstruction.clonedToFillQuota, 0, "the artifact must record zero cloning");
    assertEqual(artifact.lineage.research.crossCohortCrossovers, 0, "the artifact must record zero cross-cohort crosses");
    assertEqual(artifact.lineage.conventional.crossCohortCrossovers, 0, "the artifact must record zero cross-cohort crosses");
    assertNoNonFinite(artifact, "ab-comparison.json");

    const summaryFile = JSON.parse(await readFile(path.join(arenasDir, arenaId, "summary.json"), "utf8"));
    const compact = summaryFile.abComparison;
    assert(compact, "summary.json must carry a compact A/B section");
    assertEqual(compact.researchMode, "ab", "the compact section must record the mode");
    assertEqual(compact.cohortSize.research, 6, "the compact section must record the cohort size");
    assert(compact.research && compact.conventional, "both cohorts must be summarised");
    assertEqual(compact.research.cohortSize + compact.conventional.cohortSize, 12, "the compact totals must be exact");
    assert(compact.comparison.arenaScore, "the compact section must carry the score comparison");
    assertEqual(result.summary.abComparison.version, AB_COMPARISON_VERSION, "the in-memory summary must match");
  });
});

test("53. A non-A/B run writes no ab-comparison.json and no A/B summary block", async () => {
  await withTempRoot("evolve-phase5a3-nonab-", async (arenasDir) => {
    const { datasets } = await fixture();
    const arenaId = "arena-5a3-normal";
    const result = await runArenaTournament({
      datasets,
      config: tinyConfig(),
      entrants: buildEntrantPool({ champions: [], population: 8, seed: "normal" }),
      seeds: ["normal-1"],
      stressProfiles: ["mild"],
      maxWindows: 1,
      workers: 0,
      useCache: false,
      arenaId,
      arenasDir,
    });
    assertEqual(result.summary.abComparison, null, "a normal run must not report A/B comparison");
    let missing = false;
    try {
      await readFile(path.join(arenasDir, arenaId, "ab-comparison.json"), "utf8");
    } catch {
      missing = true;
    }
    assert(missing, "a normal run must not write ab-comparison.json");
  });
});

test("54. summarizeAbForSummary is compact, exact, and survives JSON round-tripping", () => {
  const artifact = {
    schemaVersion: 1,
    question: "q",
    researchMode: "ab",
    cohortConstruction: { requestedPerCohort: 10, actualPerCohort: 5 },
    cohortSize: { research: 5, conventional: 5, total: 10 },
    cohorts: {
      research: { arena: { entrants: 5, bestScore: 9, medianScore: 5, meanScore: 5, bestRank: 1, medianRank: 3, top10Count: 5, top25Count: 5, top50Count: 5, groupCount: 2, stressCount: 2, championLeagueCount: 1, deploymentCount: 0 }, diversity: { uniqueFinalGenomes: 5, genomeDiversity: 1, lineageConcentration: 0.2 }, trading: { medianDistinctMints: 2, medianDrawdown: 0.1, medianNetPaperReturn: 0.01 }, robustness: { stressSurvivalCount: 5 }, failedGates: {} },
      conventional: { arena: { entrants: 5 }, diversity: {}, trading: {}, robustness: {}, failedGates: {} },
    },
    comparison: { arenaScore: { research: { median: 5 }, conventional: { median: 4 }, difference: { median: 1, mean: 1 }, bootstrap: { available: true, medianDifference: { low: 0, high: 2 } } } },
    species: { matched: true },
    statistics: { significanceNote: "n" },
    limitations: ["PAPER ONLY"],
    note: "note",
  };
  const compact = summarizeAbForSummary(artifact);
  assertEqual(compact.research.cohortSize, 5, "the compact research size must match");
  assertEqual(compact.comparison.arenaScore.medianDifference, 1, "the compact difference must match");
  const roundTripped = JSON.parse(JSON.stringify(compact));
  assertEqual(JSON.stringify(roundTripped), JSON.stringify(compact), "the compact block must survive JSON");
  assertEqual(summarizeAbForSummary(null), null, "a missing artifact summarises to null");
});

/* ============================================================================
 * G. Regression of existing modes
 * ==========================================================================*/

test("55. CHALLENGER mode is unchanged: it still appends research to a fixed population", () => {
  const conventional = buildEntrantPool({ champions: [], population: 12, seed: "challenger-reg" });
  assertEqual(conventional.length, 12, "the conventional population is exactly the requested size");
  const research = researchSeedsFor(3, "challenger-reg");
  const entrants = [...conventional, ...research];
  assertEqual(entrants.length, 12 + research.length, "challenger appends on top of the requested population");
  assertEqual(entrants.filter((row) => row.origin === "research").length, research.length, "the appended research keeps its origin");
});

test("56. FAIR mode is unchanged: one mixed cohort of the requested size", () => {
  const conventional = buildEntrantPool({ champions: [], population: 12, seed: "fair-reg" });
  const research = researchSeedsFor(5, "fair-reg");
  const composed = composeFairCohort({ population: 12, researchEntrants: research, conventionalEntrants: conventional, researchShare: 0.5 });
  assertEqual(composed.entrants.length, 12, "a fair cohort is exactly the requested population");
  assertEqual(composed.accounting.startingResearchSeeds, research.length, "the research seed count must be reported");
  assertEqual(composed.accounting.clonedToFillQuota, 0, "fair mode must also never clone");
  assertEqual("researchShortage" in composed.accounting, true, "fair mode must still report a research shortage");
});

test("57. A normal arena run is unchanged: no cohort tags, no A/B artifacts", async () => {
  const { datasets } = await fixture();
  const result = await runArenaTournament({
    datasets,
    config: tinyConfig(),
    entrants: buildEntrantPool({ champions: [], population: 8, seed: "normal-reg" }),
    seeds: ["normal-reg-1"],
    stressProfiles: ["mild"],
    maxWindows: 1,
    workers: 0,
    useCache: false,
  });
  assertEqual(result.summary.abComparison, null, "normal mode must not produce an A/B comparison");
  for (const row of result.candidateRows) {
    assertEqual(row.cohort, null, "normal mode must not tag a cohort");
    assertEqual(row.lineage, null, "normal mode must not tag a lineage");
  }
  assertEqual(result.summary.funnel.QUALIFICATION.entered, 8, "the funnel must account for every entrant");
});

test("58. Worker-count determinism is preserved, including the A/B comparison", async () => {
  const { built, entrants } = abEntrants({ requested: 12, researchCount: 6, conventionalCount: 12 });
  const inline = await runAbTournament({ entrants, built, workers: 0 });
  const threaded = await runAbTournament({ entrants, built, workers: 2 });
  const rows = (result) => result.candidateRows.map((row) => `${row.cohort}:${row.digest}:${row.score}`).join("|");
  assertEqual(rows(inline), rows(threaded), "worker count must not change any score or cohort tag");
  // The worker count is recorded in the parity block, so compare everything
  // else: the cohorts' metrics and the statistical comparison must be identical.
  const stable = (result) => {
    const ab = JSON.parse(JSON.stringify(result.summary.abComparison));
    delete ab.parity.workers;
    return JSON.stringify(ab);
  };
  assertEqual(stable(inline), stable(threaded), "worker count must not change the A/B comparison");
});

test("59. Real vs synthetic evidence separation is preserved", async () => {
  const { registry } = await fixture();
  const summary = registrySummary(registry);
  assertEqual(summary.real.count, 0, "a synthetic fixture must never be counted as real evidence");
  assertEqual(summary.synthetic.count, 1, "the fixture must be counted as synthetic evidence");
  assertEqual(realEvidenceDatasets(registry).length, 0, "no real dataset may be claimed");
});

test("60. Research promotion rules are preserved under A/B accounting", async () => {
  await withTempRoot("evolve-phase5a3-promote-", async (root) => {
    const genome = { riskFraction: 0.31 };
    await saveCompiledCandidate(root, { familyId: "F-5a3", proposalId: "P-5a3", genome, authorRole: "signal-researcher" });
    const result = await promoteFromArenaLeaderboard({
      root,
      leaderboardRows: [{ digest: digestOf(genome), gateStatus: GATE_STATUS.GATES_PASSED, deploymentEligible: true, finalRank: 1 }],
      memoryRecords: [],
    });
    assert(
      result.promoted.some((row) => row.familyId === "F-5a3" && row.to === MEMORY_STATUS.SHADOW_ELIGIBLE),
      "a matched, clean candidate must still promote",
    );
    const unmatched = await promoteFromArenaLeaderboard({
      root,
      leaderboardRows: [{ digest: "not-a-match", gateStatus: GATE_STATUS.GATES_PASSED, deploymentEligible: true }],
      memoryRecords: [],
    });
    assertEqual(unmatched.promoted.length, 0, "an unmatched genome must never promote");
  });
});

test("61. Watchdog quarantine still blocks promotion", async () => {
  await withTempRoot("evolve-phase5a3-quarantine-", async (root) => {
    const genome = { riskFraction: 0.37 };
    await saveCompiledCandidate(root, { familyId: "F-5a3-q", proposalId: "P-q", genome, authorRole: "risk-researcher" });
    await appendMemoryRecord(
      root,
      createMemoryRecord({
        proposalId: "P-q",
        authorRole: "risk-researcher",
        hypothesis: "h",
        candidateFamily: "F-5a3-q",
        status: MEMORY_STATUS.TESTING,
        outcome: MEMORY_OUTCOME.QUARANTINED,
        watchdog: { status: "QUARANTINED", flags: [{ flag: "single-mint-dominance", detail: "x" }] },
      }),
    );
    const records = await readMemoryIndex(root, { limit: 50 });
    assert(isQuarantined(records, "F-5a3-q"), "the quarantine must be detectable");
    const promoted = await promoteFromArenaLeaderboard({
      root,
      leaderboardRows: [{ digest: digestOf(genome), gateStatus: GATE_STATUS.GATES_PASSED, deploymentEligible: true }],
      memoryRecords: records,
    });
    assertEqual(promoted.promoted.length, 0, "a quarantined candidate must never promote");
    assertEqual(memoryStatusForArenaRow({ gateStatus: GATE_STATUS.GATES_PASSED }).status, MEMORY_STATUS.ARENA_SURVIVOR, "gate-passing non-deployment rows still map correctly");
  });
});

/* ============================================================================
 * H. Standalone metric helpers and paper-only safety
 * ==========================================================================*/

test("62. cohortArenaPerformance is exact for a hand-built row set", () => {
  const rows = [
    { score: 10, finalRank: 1, highestStage: ARENA_STAGE.CHAMPION_LEAGUE, isChampionLeagueFinalist: true, deploymentEligible: true, gateStatus: "GATES_PASSED" },
    { score: 4, finalRank: 12, highestStage: ARENA_STAGE.GROUP, isChampionLeagueFinalist: false, deploymentEligible: false, gateStatus: "GATES_FAILED" },
    { score: 7, finalRank: 30, highestStage: ARENA_STAGE.STRESS, isChampionLeagueFinalist: false, deploymentEligible: false, gateStatus: "GATES_FAILED" },
  ];
  const block = cohortArenaPerformance(rows);
  assertEqual(block.entrants, 3, "every row must be counted");
  assertEqual(block.bestScore, 10, "best score");
  assertEqual(block.bestRank, 1, "best rank");
  assertEqual(block.top10Count, 1, "top-10");
  assertEqual(block.top50Count, 3, "top-50");
  assertEqual(block.groupCount, 3, "GROUP reached");
  assertEqual(block.stressCount, 2, "STRESS survived");
  assertEqual(block.championLeagueCount, 1, "Champion League");
  assertEqual(block.deploymentCount, 1, "deployments");
  assertEqual(block.medianScore, 7, "median score");
  assertEqual(block.scoreQuartiles.q1, 5.5, "Q1 must interpolate");
});

test("63. cohortTradingEvidence pools the candidate medians", () => {
  const rows = [
    { paperEvidence: { medianTrades: 10, medianDistinctMints: 2, medianNetReturn: 0.02, medianGrossReturn: 0.03, medianCostDrag: 0.01, medianDrawdown: 0.1, medianTopMintNotionalShare: 0.9, oosRunCount: 2, stressRunCount: 1 } },
    { paperEvidence: { medianTrades: 20, medianDistinctMints: 4, medianNetReturn: 0.04, medianGrossReturn: 0.05, medianCostDrag: 0.02, medianDrawdown: 0.2, medianTopMintNotionalShare: 0.5, oosRunCount: 3, stressRunCount: 2 } },
  ];
  const block = cohortTradingEvidence(rows);
  assertEqual(block.medianTrades, 15, "median trades");
  assertEqual(block.medianDistinctMints, 3, "median distinct mints");
  assertEqual(block.medianNetPaperReturn, 0.03, "median net paper return");
  assertEqual(block.medianGrossPaperReturn, 0.04, "median gross paper return");
  assertEqual(block.medianCostDrag, 0.015, "median cost drag");
  assertEqual(block.medianDrawdown, 0.15, "median drawdown");
  assertEqual(block.totalOosRuns, 5, "OOS run total");
  assertEqual(block.totalStressRuns, 3, "stress run total");
});

test("64. Every A/B output value is finite or null — never NaN or Infinity", async () => {
  const { built, entrants } = abEntrants({ requested: 12, researchCount: 6, conventionalCount: 12 });
  const result = await runAbTournament({ entrants, built });
  assertNoNonFinite(result.summary.abComparison, "summary.abComparison");
  const artifact = buildAbComparison({
    candidateRows: result.candidateRows,
    entrants,
    accounting: built.accounting,
    config: { generations: 1 },
    datasets: result.summary.datasets,
    seeds: result.summary.seeds,
    stressProfiles: result.summary.stressProfiles,
  });
  assertNoNonFinite(artifact, "ab artifact");
  assertEqual(artifact.cohortSize.equalSize, true, "the cohorts must be reported equal");
});

test("65. An A/B artifact records zero cross-cohort crossovers even with lineage-bearing entrants", async () => {
  const { built, entrants } = abEntrants({ requested: 12, researchCount: 6, conventionalCount: 12 });
  const result = await runAbTournament({ entrants, built });
  const artifact = buildAbComparison({
    candidateRows: result.candidateRows,
    entrants,
    accounting: built.accounting,
    config: {},
    datasets: result.summary.datasets,
    seeds: result.summary.seeds,
    stressProfiles: result.summary.stressProfiles,
  });
  assertEqual(artifact.lineage.research.crossCohortCrossovers, 0, "research must have no cross-cohort crosses");
  assertEqual(artifact.lineage.conventional.crossCohortCrossovers, 0, "conventional must have no cross-cohort crosses");
  assertEqual(artifact.lineage.research.orphansWithoutLineage, 0, "every research entrant must carry a lineage");
  assertEqual(artifact.lineage.conventional.orphansWithoutLineage, 0, "every conventional entrant must carry a lineage");
  assert(artifact.lineage.research.lineages > 0, "the lineage count must be reported");
});

test("66. Research and conventional descendants stay attributed in the artifact lineage blocks", async () => {
  const built = buildMatchedAbCohort({
    requestedPopulation: 16,
    researchSeeds: syntheticResearchSeeds(8, "attr-r"),
    conventionalSeeds: syntheticConventionalSeeds(16, "attr-c"),
  });
  const research = built.research;
  const conventional = built.conventional;
  const researchPool = buildEntrantPool({ champions: research, population: 8, seed: "attr-rp", championShare: 0.5 });
  const conventionalPool = buildEntrantPool({ champions: conventional, population: 8, seed: "attr-cp", championShare: 0.5 });
  const entrants = [...researchPool, ...conventionalPool];
  assert(entrants.some((entry) => entry.lineage.identity === COHORT_IDENTITY.DESCENDANT), "breeding must create descendants");
  const result = await runAbTournament({ entrants, built });
  const artifact = buildAbComparison({
    candidateRows: result.candidateRows,
    entrants,
    accounting: built.accounting,
    config: {},
    datasets: result.summary.datasets,
    seeds: result.summary.seeds,
    stressProfiles: result.summary.stressProfiles,
  });
  assertEqual(artifact.lineage.research.startingSeedDigests, 8, "every research seed digest must be accounted for");
  assertEqual(artifact.lineage.conventional.startingSeedDigests, 8, "every conventional seed digest must be accounted for");
  const generations = Object.keys(artifact.lineage.research.generations);
  assert(generations.includes("0"), "generation 0 must be present");
  assert(generations.includes("1"), "the descendant generation must be present");
});

test("67. Stress profile definitions used by the A/B report are the real ones", () => {
  assert(STRESS_PROFILES.mild && STRESS_PROFILES.moderate, "mild and moderate stress profiles must exist");
  assert(!("research" in STRESS_PROFILES), "no research-specific stress profile may exist");
  assert(!("conventional" in STRESS_PROFILES), "no conventional-specific stress profile may exist");
});

test("68. No Phase 5A.3 module contains a real-execution, signing, or wallet path", async () => {
  const files = [
    "scripts/research/ab-cohort.mjs",
    "scripts/arena/ab-comparison.mjs",
    "scripts/arena/research-cohort.mjs",
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

test("69. A/B mode is PAPER ONLY: the artifact never claims profit or safety", async () => {
  const { built, entrants } = abEntrants({ requested: 10, researchCount: 5, conventionalCount: 10 });
  const result = await runAbTournament({ entrants, built });
  const artifact = buildAbComparison({
    candidateRows: result.candidateRows,
    entrants,
    accounting: built.accounting,
    config: {},
    datasets: result.summary.datasets,
    seeds: result.summary.seeds,
    stressProfiles: result.summary.stressProfiles,
  });
  const serialized = JSON.stringify(artifact).toLowerCase();
  for (const claim of ["profitable", "guaranteed", "statistically significant", "will make money", "predicts future"]) {
    assert(!serialized.includes(claim), `the artifact must not claim "${claim}"`);
  }
  assert(artifact.note.toLowerCase().includes("paper"), "the note must state paper-only");
  assert(artifact.note.toLowerCase().includes("does not predict"), "the note must disclaim prediction");
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

  await disposeFixture();

  console.log(`\nEVOLVE Phase 5A.3 validation: ${passed}/${cases.length} checks passed`);

  if (failures.length > 0) {
    console.log("Failed checks:");
    for (const failure of failures) console.log(`  - ${failure.name}`);
    process.exitCode = 1;
  } else {
    console.log("All Phase 5A.3 checks passed.");
    console.log(
      "PAPER RESEARCH ONLY. A/B cohorts are matched by construction, but a difference here is an observation — not statistical significance, not a profitability claim, and not a deployment decision."
    );
  }
}

run().catch(async (error) => {
  await disposeFixture();
  console.error("phase 5a.3 validation runner crashed:", error);
  process.exitCode = 1;
});

export { cases };
