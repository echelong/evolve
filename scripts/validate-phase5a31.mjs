#!/usr/bin/env node
/**
 * EVOLVE Phase 5A.3.1 validation suite — strict species matching for the
 * controlled A/B benchmark.
 *
 * Phase 5A.3 matched the CONVENTIONAL SEEDS to the Research species counts, but
 * pre-evolution (random-species immigrants + score-based selection) then changed
 * both cohorts' species distributions, so a run could request
 * `EVOLVE_ARENA_AB_SPECIES_MATCHED=1`, report `matchMode: "species-matched"` AND
 * report `matched: false` in the same artifact. That artifact was not a valid
 * species-controlled A/B baseline.
 *
 * This suite covers the fix: the requested flag, the reference distribution, the
 * strict freeze invariant, species-preserving evolution (immigrants, crossover,
 * mutation, survivor selection), no cloning, symmetric shortage handling, loud
 * failure on an impossible match, artifact semantics
 * (`requestedMatchMode` / `effectiveMatchMode` / `matched`), and regression of
 * challenger / fair / plain A/B mode and the paper-only guarantee.
 *
 * Dependency-free and fully offline (synthetic fixture datasets, mock research
 * provider). Same convention as validate-phase5a3.mjs.
 *
 * Run with: npm run validate:phase5a31
 */

import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { digestOf } from "./lib/hash.mjs";
import { createMarketConfig } from "./market/config.mjs";
import { makeFixture } from "./make-fixture.mjs";
import { buildDatasetRegistry } from "./arena/orchestrator.mjs";
import { buildEntrantPool, buildSpeciesPreservingPool, runArenaTournament } from "./arena/tournament.mjs";
import { buildAbComparison, summarizeAbForSummary } from "./arena/ab-comparison.mjs";
import { RESEARCH_ARENA_MODE, composeFairCohort, researchEntrantsFromCohort } from "./arena/research-cohort.mjs";
import { compileProposals } from "./research/compiler.mjs";
import { validateProposal } from "./research/proposal-schema.mjs";
import {
  AB_COHORT,
  buildMatchedAbCohort,
  dedupeSeedEntrants,
  describeSpeciesCounts,
  enforceSpeciesMatchInvariant,
  planSpeciesMatchedCohort,
  scaleSpeciesCounts,
  speciesCountsEqual,
  speciesCountsOf,
  speciesMatchControlSeeds,
  speciesMatchRequested,
  speciesMatchedConventionalSeeds,
  speciesMatchVerdict,
  trimSpeciesCounts,
} from "./research/ab-cohort.mjs";
import { ADVISORY_ROLES, PROPOSING_ROLES, mockProviderPropose } from "./research/provider.mjs";

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
function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(`${message} (expected ${b}, got ${a})`);
}

/* ============================================================================
 * Fixtures
 * ==========================================================================*/

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

let sharedFixture = null;
let sharedFixtureRoot = null;

async function fixture() {
  if (sharedFixture) return sharedFixture;
  sharedFixtureRoot = await mkdtemp(path.join(tmpdir(), "evolve-phase5a31-"));
  const dir = path.join(sharedFixtureRoot, "fixture");
  await makeFixture({ dir, snapshots: 30, intervalMs: 60_000, seed: "phase5a31", tokenCount: 10 });
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

/** The reported failing shape: 12 Reversal + 1 Wallet Flow, 13 unique genomes. */
function reportedResearchSeeds() {
  return Array.from({ length: 13 }, (_, index) => ({
    genome: { riskFraction: 0.05 + index * 0.0021, stopLoss: 0.04 + index * 0.0004, momentumWeight: 0.2 },
    species: index < 12 ? "Reversal" : "Wallet Flow",
    origin: "research",
    research: {
      origin: "research",
      identity: "exact",
      familyId: `F-reported-${index}`,
      proposalId: `P-reported-${index}`,
      authorRole: PROPOSING_ROLES[index % PROPOSING_ROLES.length],
      researchFamily: "Reversal x Wallet Flow",
      researchGenomeDigest: null,
    },
  }));
}

/** Research seeds with an explicit species list (one genome per entry). */
function seedsForSpecies(speciesList = []) {
  return speciesList.map((species, index) => ({
    genome: { riskFraction: 0.05 + index * 0.0017, stopLoss: 0.03 + index * 0.0003, flowWeight: 0.25 },
    species,
    origin: "research",
    research: {
      origin: "research",
      identity: "exact",
      familyId: `F-species-${index}`,
      proposalId: `P-species-${index}`,
      authorRole: PROPOSING_ROLES[index % PROPOSING_ROLES.length],
      researchFamily: species,
      researchGenomeDigest: null,
    },
  }));
}

function speciesCountsOfRows(rows = []) {
  return speciesCountsOf(rows);
}

/** Real offline research seeds (compiled mock-provider proposals). */
function compiledResearchSeeds(count = 6, seed = "5a31") {
  const proposals = [];
  for (const raw of mockProviderPropose({ evidence: { cycle: 1 }, count: Math.max(count, 6), seed, cycle: 1 })) {
    const { ok, proposal } = validateProposal(raw);
    if (ok) proposals.push(proposal);
  }
  const { compiled } = compileProposals({ proposals, maxCompilations: count + 6 });
  return researchEntrantsFromCohort(compiled).slice(0, count);
}

/**
 * One generation of STRICT pre-evolution: a global screen ordering (here the
 * digest order, exactly as the tournament's leaderboard is deterministic per
 * input) followed by the quota-preserving pool rebuild the Arena uses.
 */
function strictGeneration({ pool, quotas, seed, label = AB_COHORT.RESEARCH }) {
  const ranked = [...pool].sort((a, b) =>
    String(a.digest ?? digestOf(a.genome)).localeCompare(String(b.digest ?? digestOf(b.genome))),
  );
  const survivors = ranked.slice(0, Math.max(2, Math.ceil(pool.length * 0.3)));
  return buildSpeciesPreservingPool({
    champions: survivors,
    members: pool,
    quotas,
    seed,
    championShare: 0.35,
    immigrantShare: 0.15,
    cohort: label,
  });
}

function evolveStrict({ pool, quotas, generations = 30, label = AB_COHORT.RESEARCH, seedPrefix = "strict" }) {
  let current = pool;
  const history = [current];
  for (let gen = 1; gen < generations; gen += 1) {
    current = strictGeneration({ pool: current, quotas, seed: `${seedPrefix}:gen${gen}`, label });
    history.push(current);
  }
  return { pool: current, history };
}

/* ============================================================================
 * 1-2. Requested mode
 * ==========================================================================*/

test("1. `EVOLVE_ARENA_AB_SPECIES_MATCHED=1` enables strict species-matched mode", async () => {
  assertEqual(speciesMatchRequested({ EVOLVE_ARENA_AB_SPECIES_MATCHED: "1" }), true, "only the exact value 1 enables it");
  assertEqual(speciesMatchRequested({}), false, "unset means unmatched");
  assertEqual(speciesMatchRequested({ EVOLVE_ARENA_AB_SPECIES_MATCHED: "0" }), false, "0 means unmatched");
  assertEqual(speciesMatchRequested({ EVOLVE_ARENA_AB_SPECIES_MATCHED: "true" }), false, "loose truthiness is not accepted");
  // The CLI must go through the shared parser so the flag cannot drift.
  const arenaSource = await readFile("scripts/arena.mjs", "utf8");
  assert(arenaSource.includes("speciesMatchRequested(process.env)"), "arena.mjs must parse the flag via the helper");
  assert(
    !/process\.env\.EVOLVE_ARENA_AB_SPECIES_MATCHED\s*===/.test(arenaSource),
    "arena.mjs must not re-implement the flag comparison",
  );
});

test("2. Requested and effective match mode are reported separately", async () => {
  const { datasets } = await fixture();
  const plan = planSpeciesMatchedCohort({ researchSeeds: reportedResearchSeeds(), requestedPerCohort: 13, seed: "mode" });
  const built = buildMatchedAbCohort({
    requestedPopulation: 26,
    researchSeeds: plan.research,
    conventionalSeeds: plan.conventional,
  });
  const entrants = [...built.research, ...built.conventional];
  const result = await runArenaTournament({
    datasets,
    config: tinyConfig(),
    entrants,
    seeds: ["mode-1"],
    stressProfiles: ["mild", "moderate"],
    maxWindows: 1,
    workers: 0,
    useCache: false,
    arenaId: "phase5a31-mode",
    researchEnabled: true,
    researchMode: RESEARCH_ARENA_MODE.AB,
    abAccounting: {
      ...built.accounting,
      requestedMatchMode: "species-matched",
      speciesMatched: true,
      speciesMatch: {
        requested: true,
        matched: true,
        referenceCounts: plan.requestedCounts,
        quotas: plan.counts,
        noCloning: true,
      },
    },
    abConfig: { generations: 1, workers: 0, survivorFraction: 0.3, breederShare: 0.35 },
    abRoles: { known: [...PROPOSING_ROLES, ...ADVISORY_ROLES], advisory: [...ADVISORY_ROLES] },
    abSpeciesMatched: true,
  });
  const species = result.summary.abComparison.species;
  assertEqual(species.requestedMatchMode, "species-matched", "the requested mode must be reported");
  assertEqual(species.effectiveMatchMode, "species-matched", "an exact freeze reports an effective species match");
  assertEqual(species.matched, true, "the freeze verdict must be true");
  assertEqual(species.matchMode, species.effectiveMatchMode, "matchMode is an alias of the effective mode");
  assertEqual(species.invariant.satisfied, true, "the invariant must be reported as satisfied");
  assertEqual(
    result.summary.abComparison.cohortConstruction.requestedMatchMode,
    "species-matched",
    "the cohort construction block must state the requested mode",
  );
});

/* ============================================================================
 * 3-6. The freeze invariant and the reported species mix
 * ==========================================================================*/

test("3. Species distributions are EXACTLY equal at the formal freeze", () => {
  const plan = planSpeciesMatchedCohort({ researchSeeds: reportedResearchSeeds(), requestedPerCohort: 100, seed: "freeze" });
  assertEqual(plan.ok, true, "the reported shape must plan successfully");
  const research = plan.research;
  const conventional = plan.conventional;
  const invariant = enforceSpeciesMatchInvariant({
    research,
    conventional,
    expectedCounts: plan.counts,
    requested: true,
  });
  assertEqual(invariant.ok, true, `the freeze invariant must pass: ${invariant.reason}`);
  assertDeepEqual(invariant.researchCounts, invariant.conventionalCounts, "counts must be byte-identical");
  assertEqual(speciesCountsEqual(speciesCountsOf(research), speciesCountsOf(conventional)), true, "counts must be equal");
  assertEqual(invariant.matched, true, "matched must be true");
  assertEqual(invariant.expectedSatisfied, true, "the agreed quotas must be met exactly");
  assertEqual(invariant.sharedDigests.length, 0, "no genome may appear in both cohorts");
});

test("4. 12 Reversal + 1 Wallet Flow produces the same Conventional counts", () => {
  const research = reportedResearchSeeds();
  const plan = planSpeciesMatchedCohort({ researchSeeds: research, requestedPerCohort: 100, seed: "reported" });
  assertDeepEqual(plan.requestedCounts, { Reversal: 12, "Wallet Flow": 1 }, "the reference is the natural research mix");
  assertDeepEqual(speciesCountsOfRows(plan.research), { Reversal: 12, "Wallet Flow": 1 }, "research keeps its own mix");
  assertDeepEqual(
    speciesCountsOfRows(plan.conventional),
    { Reversal: 12, "Wallet Flow": 1 },
    "the conventional control must match exactly",
  );
  assertEqual(plan.matchedPerCohort, 13, "both arms freeze at 13");
  assertEqual(plan.research.length, plan.conventional.length, "both arms must have equal size");
  // The same shape through the compatibility entry point.
  const legacy = speciesMatchedConventionalSeeds({ researchSeeds: research, population: 13, seed: "reported" });
  assertDeepEqual(speciesCountsOfRows(legacy), { Reversal: 12, "Wallet Flow": 1 }, "compat entry point stays species-exact");
});

test("5. No Momentum appears if the Research cohort contains no Momentum", () => {
  const plan = planSpeciesMatchedCohort({ researchSeeds: reportedResearchSeeds(), requestedPerCohort: 13, seed: "no-momentum" });
  assert(!("Momentum" in speciesCountsOfRows(plan.conventional)), "no Momentum may be substituted in");
  const { pool } = evolveStrict({
    pool: plan.conventional.map((entry) => ({ ...entry, digest: digestOf(entry.genome) })),
    quotas: plan.counts,
    generations: 30,
    seedPrefix: "no-momentum",
  });
  assert(!("Momentum" in speciesCountsOfRows(pool)), "30 generations may not introduce Momentum");
  assert(!("Momentum" in speciesCountsOfRows(plan.research)), "research itself has no Momentum");
});

test("6. No Liquidity appears if the Research cohort contains no Liquidity", () => {
  const plan = planSpeciesMatchedCohort({
    researchSeeds: seedsForSpecies(["Reversal", "Reversal", "Wallet Flow"]),
    requestedPerCohort: 3,
    seed: "no-liquidity",
  });
  assert(!("Liquidity" in speciesCountsOfRows(plan.conventional)), "no Liquidity may be substituted in");
  const { history } = evolveStrict({
    pool: plan.conventional.map((entry) => ({ ...entry, digest: digestOf(entry.genome) })),
    quotas: plan.counts,
    generations: 30,
    seedPrefix: "no-liquidity",
  });
  for (const generation of history) {
    for (const entry of generation) {
      assert(entry.species in plan.counts, `generation member species ${entry.species} must be a quota species`);
      assert(entry.species !== "Liquidity", "Liquidity may never appear");
    }
  }
});

/* ============================================================================
 * 7-8. No cloning, unique digests
 * ==========================================================================*/

test("7. No genome is ever cloned to fill a species quota", () => {
  const plan = planSpeciesMatchedCohort({ researchSeeds: reportedResearchSeeds(), requestedPerCohort: 13, seed: "cloning" });
  assertEqual(plan.cloningToFillQuota, 0, "the plan must declare zero cloning");
  assertEqual(plan.substitutedSpecies, 0, "the plan must declare zero species substitution");
  assertEqual(plan.noCloning, true, "the no-cloning policy must be explicit");
  const researcherDigests = new Set(plan.research.map((entry) => digestOf(entry.genome)));
  for (const entry of plan.conventional) {
    assert(!researcherDigests.has(digestOf(entry.genome)), "a control may never be a copy of a research genome");
  }
  // Re-entering an elite genome is not cloning: one genome, one slot.
  const single = buildSpeciesPreservingPool({
    champions: [{ genome: { riskFraction: 0.3, stopLoss: 0.05 }, species: "Wallet Flow", origin: "seed" }],
    members: [{ genome: { riskFraction: 0.3, stopLoss: 0.05 }, species: "Wallet Flow", origin: "seed" }],
    quotas: { "Wallet Flow": 1 },
    seed: "single",
  });
  assertEqual(single.length, 1, "a one-slot species keeps one slot");
  assertEqual(single[0].species, "Wallet Flow", "the slot keeps its species");
});

test("8. Every seed digest stays unique at the independent seed stage", () => {
  const plan = planSpeciesMatchedCohort({ researchSeeds: reportedResearchSeeds(), requestedPerCohort: 13, seed: "digests" });
  const unique = (rows) => new Set(rows.map((entry) => digestOf(entry.genome))).size;
  assertEqual(unique(plan.research), plan.research.length, "research seeds must be digest-unique");
  assertEqual(unique(plan.conventional), plan.conventional.length, "conventional controls must be digest-unique");
  const invariant = enforceSpeciesMatchInvariant({ research: plan.research, conventional: plan.conventional });
  assertEqual(invariant.duplicateDigests.research.length, 0, "no duplicate research digest");
  assertEqual(invariant.duplicateDigests.conventional.length, 0, "no duplicate conventional digest");
  assertEqual(invariant.sharedDigests.length, 0, "no digest shared across cohorts");
  // Duplicate research genomes are rejected, never turned into extra slots.
  const deduped = dedupeSeedEntrants([...reportedResearchSeeds(), reportedResearchSeeds()[0]]);
  assertEqual(deduped.unique.length, 13, "a duplicate digest consumes no slot");
  assertEqual(deduped.duplicates.length, 1, "the duplicate must be reported");
});

/* ============================================================================
 * 9-10. Shortage and impossible match
 * ==========================================================================*/

test("9. A species shortage shrinks BOTH cohorts symmetrically and substitutes nothing", () => {
  const requested = { Reversal: 2, Momentum: 1 };
  const probe = speciesMatchControlSeeds({ counts: requested, seed: "shortage", maxAttemptsPerGenome: 1 });
  const momentumDigest = probe.seeds.find((entry) => entry.species === "Momentum").digest;
  const plan = planSpeciesMatchedCohort({
    researchSeeds: seedsForSpecies(["Reversal", "Reversal", "Momentum"]),
    requestedPerCohort: 3,
    seed: "shortage",
    maxAttemptsPerGenome: 1,
    extraAvoidDigests: [momentumDigest],
  });
  assertEqual(plan.ok, true, "a partially achievable match still builds a matched cohort");
  assertEqual(plan.symmetricShrink, true, "the shortage must be reported as a symmetric shrink");
  assertEqual(speciesCountsEqual(plan.shortfall, { Momentum: 1 }), true, "the unattainable quota must be reported by species");
  assertEqual(speciesCountsEqual(plan.counts, { Reversal: 2, Momentum: 0 }), true, "the agreed counts must be the achievable ones");
  assertEqual(plan.counts.Momentum, 0, "the unattainable species keeps no slot");
  assertEqual(plan.matchedPerCohort, 2, "both cohorts shrink to the achievable size");
  assertEqual(plan.research.length, 2, "research shrinks by the same amount");
  assertEqual(plan.conventional.length, 2, "conventional shrinks by the same amount");
  assertDeepEqual(
    speciesCountsOfRows(plan.research),
    speciesCountsOfRows(plan.conventional),
    "the shrunk cohorts must still be species-identical",
  );
  assertEqual(plan.cloningToFillQuota, 0, "the shortfall is never filled by cloning");
  assertEqual(plan.substitutedSpecies, 0, "the shortfall is never filled by another species");
  const invariant = enforceSpeciesMatchInvariant({
    research: plan.research,
    conventional: plan.conventional,
    expectedCounts: plan.counts,
  });
  assertEqual(invariant.ok, true, `the shrunk cohorts must pass the invariant: ${invariant.reason}`);
});

test("10. An impossible match fails loudly instead of reporting a species match", async () => {
  const noSpecies = planSpeciesMatchedCohort({
    researchSeeds: [{ genome: { riskFraction: 0.1 }, origin: "research" }],
    requestedPerCohort: 1,
    seed: "impossible-species",
  });
  assertEqual(noSpecies.ok, false, "research seeds without species identity cannot be matched");
  assert(/species identity/.test(noSpecies.error), "the failure must name the missing species identity");
  assertEqual(noSpecies.conventional.length, 0, "no control may be built from a broken reference");

  const probe = speciesMatchControlSeeds({ counts: { Momentum: 1 }, seed: "impossible", maxAttemptsPerGenome: 1 });
  const impossible = planSpeciesMatchedCohort({
    researchSeeds: seedsForSpecies(["Momentum"]),
    requestedPerCohort: 1,
    seed: "impossible",
    maxAttemptsPerGenome: 1,
    extraAvoidDigests: probe.seeds.map((entry) => entry.digest),
  });
  assertEqual(impossible.ok, false, "an unattainable quota must fail the plan");
  assert(/never substituted|never cloned/.test(impossible.error), "the failure must state the no-substitution policy");
  assertEqual(impossible.conventional.length, 0, "no partial control may be reported as a match");

  const empty = planSpeciesMatchedCohort({ researchSeeds: [], requestedPerCohort: 5, seed: "empty" });
  assertEqual(empty.ok, false, "an empty research cohort cannot be matched");

  // The CLI must check the freeze invariant BEFORE the shared tournament, and
  // must refuse to continue when either check fails.
  const arenaSource = await readFile("scripts/arena.mjs", "utf8");
  const invariantIndex = arenaSource.indexOf("enforceSpeciesMatchInvariant(");
  // The FORMAL evaluation is the last tournament call; earlier calls are the
  // cheap pre-evolution screens, which by design run after the seed plan and
  // before the freeze check.
  const tournamentIndex = arenaSource.lastIndexOf("await runArenaTournament(");
  assert(invariantIndex > 0 && tournamentIndex > 0, "both the invariant and the tournament call must exist");
  assert(invariantIndex < tournamentIndex, "the freeze invariant must be checked before evaluation");
  assert(arenaSource.includes("species match invariant: FAIL"), "the CLI must fail the invariant loudly");
  assert(arenaSource.includes("A/B SPECIES-MATCH FAILED"), "the CLI must fail an impossible plan loudly");
  const planIndex = arenaSource.indexOf("A/B SPECIES-MATCH FAILED");
  assert(planIndex < tournamentIndex, "an impossible species match must fail before evaluation");
});

/* ============================================================================
 * 11-12. Artifact semantics
 * ==========================================================================*/

async function artifactFor({ requested = true, mismatch = false } = {}) {
  const { datasets } = await fixture();
  const plan = planSpeciesMatchedCohort({
    researchSeeds: reportedResearchSeeds(),
    requestedPerCohort: 13,
    seed: "artifact",
  });
  const built = buildMatchedAbCohort({
    requestedPopulation: 26,
    researchSeeds: plan.research,
    conventionalSeeds: plan.conventional,
  });
  const entrants = [...built.research, ...built.conventional];
  const result = await runArenaTournament({
    datasets,
    config: tinyConfig(),
    entrants,
    seeds: ["artifact-1"],
    stressProfiles: ["mild", "moderate"],
    maxWindows: 1,
    workers: 0,
    useCache: false,
    researchEnabled: true,
    researchMode: RESEARCH_ARENA_MODE.AB,
    abAccounting: built.accounting,
    abConfig: { generations: 1, workers: 0 },
    abRoles: { known: [...PROPOSING_ROLES, ...ADVISORY_ROLES], advisory: [...ADVISORY_ROLES] },
  });
  const rows = result.candidateRows.map((row) => ({ ...row }));
  if (mismatch) {
    const index = rows.findIndex((row) => row.cohort === AB_COHORT.CONVENTIONAL);
    rows[index] = { ...rows[index], species: rows[index].species === "Momentum" ? "Liquidity" : "Momentum" };
  }
  const accounting = {
    ...built.accounting,
    requestedMatchMode: requested ? "species-matched" : "unmatched",
    speciesMatched: requested,
    speciesMatch: requested
      ? { requested: true, matched: !mismatch, referenceCounts: plan.requestedCounts, quotas: plan.counts, noCloning: true }
      : null,
  };
  const artifact = buildAbComparison({
    candidateRows: rows,
    entrants,
    accounting,
    config: { generations: 1 },
    datasets: result.summary.datasets,
    seeds: result.summary.seeds,
    stressProfiles: result.summary.stressProfiles,
    knownRoles: [...PROPOSING_ROLES, ...ADVISORY_ROLES],
    advisoryRoles: [...ADVISORY_ROLES],
    bootstrapIterations: 200,
    bootstrapSeed: "phase5a31-artifact",
  });
  return { artifact, rows, accounting, plan, built };
}

test("11. The artifact can never report species-matched while `matched=false`", async () => {
  const { artifact } = await artifactFor({ requested: true, mismatch: true });
  assertEqual(artifact.species.matched, false, "the frozen cohorts really do differ");
  assertEqual(artifact.species.requestedMatchMode, "species-matched", "the request must still be recorded");
  assertEqual(artifact.species.effectiveMatchMode, "unmatched", "the effective mode may not claim a match");
  assertEqual(artifact.species.matchMode, "unmatched", "the legacy alias may not claim a match either");
  assertEqual(artifact.species.invariant.satisfied, false, "the invariant must be reported as unsatisfied");
  assert(
    artifact.limitations.some((line) => line.includes("NOT a valid species-controlled A/B baseline")),
    "the artifact must say the run is not a valid species-controlled baseline",
  );
  assert(
    !/species composition is identical/i.test(artifact.species.note),
    "the note may not claim identical species composition",
  );
  assertEqual(artifact.cohortConstruction.effectiveMatchMode, "unmatched", "construction block must agree");
});

test("12. Normal (unmatched) A/B mode still allows a differing species mix", async () => {
  const { artifact } = await artifactFor({ requested: false, mismatch: true });
  assertEqual(artifact.species.requestedMatchMode, "unmatched", "no species match was requested");
  assertEqual(artifact.species.effectiveMatchMode, "unmatched", "effective mode is honest");
  assertEqual(artifact.species.matched, false, "the mix really does differ");
  assertEqual(artifact.species.invariant.satisfied, true, "an unmatched run is not an invariant violation");
  assert(
    artifact.limitations.some((line) => line.includes("enable species-matched A/B to remove this confound")),
    "an unmatched mix must still be reported as a confound/limitation",
  );
  assert(
    !artifact.limitations.some((line) => line.includes("NOT a valid species-controlled A/B baseline")),
    "an unmatched run must not be framed as a broken strict baseline",
  );
  const summarized = summarizeAbForSummary(artifact);
  assertEqual(summarized.species.requestedMatchMode, "unmatched", "summary.json carries the requested mode");
  assertEqual(summarized.species.effectiveMatchMode, "unmatched", "summary.json carries the effective mode");
});

test("13. Match mode semantics survive an exact strict run (positive control)", async () => {
  const { artifact } = await artifactFor({ requested: true, mismatch: false });
  assertEqual(artifact.species.matched, true, "the strict plan freezes species-identical");
  assertEqual(artifact.species.requestedMatchMode, "species-matched", "requested mode");
  assertEqual(artifact.species.effectiveMatchMode, "species-matched", "effective mode matches");
  assertEqual(artifact.species.matchMode, "species-matched", "alias agrees");
  assertEqual(
    speciesCountsEqual(artifact.species.research, artifact.species.conventional),
    true,
    `both distributions are identical (research ${JSON.stringify(artifact.species.research)}, conventional ${JSON.stringify(artifact.species.conventional)})`,
  );
  assert(
    artifact.limitations.some((line) => line.includes("enforced identical across cohorts")),
    "the artifact must state that the match was enforced, not assumed",
  );
  assertEqual(artifact.cohortConstruction.clonedToFillQuota, 0, "no cloning");
  assertEqual(artifact.cohortConstruction.speciesSymmetricShrink, false, "no shrink was needed here");
});

/* ============================================================================
 * 14-15. Challenger / fair modes unaffected
 * ==========================================================================*/

test("14. CHALLENGER mode is unaffected by the species-match flag", async () => {
  const build = () =>
    buildEntrantPool({ champions: compiledResearchSeeds(4, "challenger"), population: 12, seed: "challenger-pool", championShare: 0.2, immigrantShare: 0.15 });
  const before = build();
  process.env.EVOLVE_ARENA_AB_SPECIES_MATCHED = "1";
  try {
    const after = build();
    assertEqual(JSON.stringify(after), JSON.stringify(before), "the flag must not change ordinary pool construction");
  } finally {
    delete process.env.EVOLVE_ARENA_AB_SPECIES_MATCHED;
  }
  // Species matching is an A/B-only control: the plan is not consulted elsewhere.
  const arenaSource = await readFile("scripts/arena.mjs", "utf8");
  assert(
    arenaSource.indexOf("planSpeciesMatchedCohort(") > arenaSource.indexOf("RESEARCH_ARENA_MODE.AB"),
    "the strict plan must live inside the A/B branch",
  );
});

test("15. FAIR mode is unaffected by the species-match flag", () => {
  const compose = () =>
    composeFairCohort({
      population: 12,
      researchEntrants: compiledResearchSeeds(6, "fair"),
      conventionalEntrants: buildEntrantPool({ champions: [], population: 12, seed: "fair-pool" }),
      researchShare: 0.5,
    });
  const before = compose();
  process.env.EVOLVE_ARENA_AB_SPECIES_MATCHED = "1";
  try {
    const after = compose();
    assertEqual(JSON.stringify(after.accounting), JSON.stringify(before.accounting), "fair accounting must not change");
    assertEqual(JSON.stringify(after.entrants), JSON.stringify(before.entrants), "fair entrants must not change");
  } finally {
    delete process.env.EVOLVE_ARENA_AB_SPECIES_MATCHED;
  }
  assertEqual(before.entrants.length, 12, "fair mode still builds one mixed cohort of the requested size");
  assertEqual(before.accounting.startingResearchSeeds, 6, "fair research slots are unchanged");
  assert(!("speciesMatch" in before.accounting), "fair mode carries no strict species-match record");
  assert(!("speciesQuotas" in before.accounting), "fair mode carries no species quotas");
});

/* ============================================================================
 * 16-19. Species survive evolution: pre-evolution, immigrants, crossover, mutation
 * ==========================================================================*/

test("16. Pre-evolution cannot break a strict species match", () => {
  const plan = planSpeciesMatchedCohort({ researchSeeds: reportedResearchSeeds(), requestedPerCohort: 13, seed: "evo" });
  const quotas = plan.counts;
  const tagged = buildMatchedAbCohort({
    requestedPopulation: 26,
    researchSeeds: plan.research,
    conventionalSeeds: plan.conventional,
  });
  const evolvedResearch = evolveStrict({
    pool: tagged.research,
    quotas,
    generations: 30,
    label: AB_COHORT.RESEARCH,
    seedPrefix: "evo-r",
  });
  const evolvedConventional = evolveStrict({
    pool: tagged.conventional,
    quotas,
    generations: 30,
    label: AB_COHORT.CONVENTIONAL,
    seedPrefix: "evo-c",
  });
  assertEqual(evolvedResearch.pool.length, 13, "the cohort size must be preserved");
  assertEqual(evolvedConventional.pool.length, 13, "the cohort size must be preserved");
  assertDeepEqual(
    speciesCountsOfRows(evolvedResearch.pool),
    { Reversal: 12, "Wallet Flow": 1 },
    "30 generations of pre-evolution must not move the research species distribution",
  );
  assertDeepEqual(
    speciesCountsOfRows(evolvedConventional.pool),
    { Reversal: 12, "Wallet Flow": 1 },
    "30 generations of pre-evolution must not move the conventional species distribution",
  );
  const invariant = enforceSpeciesMatchInvariant({
    research: evolvedResearch.pool,
    conventional: evolvedConventional.pool,
    expectedCounts: quotas,
    requested: true,
  });
  assertEqual(invariant.ok, true, `the post-evolution freeze invariant must pass: ${invariant.reason}`);
  for (const generation of [...evolvedResearch.history, ...evolvedConventional.history]) {
    for (const entry of generation) {
      assert(entry.species in quotas, `${entry.species} must be an agreed quota species`);
    }
  }
});

test("17. Immigrants cannot break a strict species match", () => {
  const plan = planSpeciesMatchedCohort({ researchSeeds: reportedResearchSeeds(), requestedPerCohort: 13, seed: "imm" });
  const quotas = plan.counts;
  const tagged = buildMatchedAbCohort({
    requestedPopulation: 26,
    researchSeeds: plan.research,
    conventionalSeeds: plan.conventional,
  });
  const { history } = evolveStrict({
    pool: tagged.conventional,
    quotas,
    generations: 30,
    label: AB_COHORT.CONVENTIONAL,
    seedPrefix: "imm",
  });
  let immigrants = 0;
  for (const generation of history) {
    for (const entry of generation) {
      const founderKind = entry.lineage?.founderKind ?? null;
      if (founderKind === "immigrant") {
        immigrants += 1;
        assert(entry.species in quotas, `an immigrant of species ${entry.species} would break the match`);
      }
      assert(entry.species in quotas, "no generation may contain a non-quota species");
    }
  }
  assert(immigrants > 0, "the immigrant/exploration budget must still be spent (not silently disabled)");
  assertDeepEqual(speciesCountsOfRows(history[history.length - 1]), quotas, "the final generation keeps the quotas");
});

test("18. Crossover and mutation cannot change species identity", () => {
  const plan = planSpeciesMatchedCohort({ researchSeeds: reportedResearchSeeds(), requestedPerCohort: 13, seed: "xover" });
  const quotas = plan.counts;
  const tagged = buildMatchedAbCohort({
    requestedPopulation: 26,
    researchSeeds: plan.research,
    conventionalSeeds: plan.conventional,
  });
  const { pool: evolved } = evolveStrict({
    pool: tagged.conventional,
    quotas,
    generations: 20,
    label: AB_COHORT.CONVENTIONAL,
    seedPrefix: "xover",
  });
  let descendants = 0;
  for (const entry of evolved) {
    assert(entry.species in quotas, `${entry.species} is not an agreed species`);
    const lineage = entry.lineage ?? null;
    if (lineage) {
      assertEqual(lineage.crossCohort, false, "a strict cohort may never cross cohorts");
      if (lineage.founderKind === "descendant") {
        descendants += 1;
        assertEqual(lineage.cohort, AB_COHORT.CONVENTIONAL, "a child stays in its own cohort");
      }
    }
  }
  assert(descendants > 0, "bred descendants must exist, otherwise this proves nothing");
  // A single-species pool can never invent a second species, however long it runs.
  const singleSpecies = buildEntrantPool({ champions: [], population: 6, seed: "single-species-base" })
    .slice(0, 6)
    .map((entry, index) => ({
      ...entry,
      species: "Momentum",
      digest: `single-${index}`,
      genome: { ...entry.genome, riskFraction: 0.1 + index * 0.01 },
    }));
  const single = evolveStrict({
    pool: singleSpecies,
    quotas: { Momentum: 6 },
    generations: 15,
    seedPrefix: "single",
  });
  assertDeepEqual(speciesCountsOfRows(single.pool), { Momentum: 6 }, "mutation must never invent a species");
});

/* ============================================================================
 * 20. Equal resources
 * ==========================================================================*/

test("19. Strict matching preserves the equal-resource guarantees", async () => {
  const plan = planSpeciesMatchedCohort({ researchSeeds: reportedResearchSeeds(), requestedPerCohort: 13, seed: "equal" });
  const quotas = plan.counts;
  const scaled = scaleSpeciesCounts(quotas, 40);
  assertEqual(
    Object.values(scaled).reduce((acc, count) => acc + count, 0),
    40,
    "quota scaling must sum exactly to the target",
  );
  assertDeepEqual(
    Object.keys(scaled).sort(),
    Object.keys(quotas).sort(),
    "quota scaling must never invent or drop a species",
  );
  const tagged = buildMatchedAbCohort({
    requestedPopulation: 26,
    researchSeeds: plan.research,
    conventionalSeeds: plan.conventional,
  });
  const budgetFor = (label) => {
    const research = buildSpeciesPreservingPool({
      champions: tagged.conventional,
      members: tagged.conventional,
      quotas: scaled,
      seed: `equal:${label}`,
      cohort: label,
    });
    return {
      size: research.length,
      perSpecies: speciesCountsOfRows(research),
      evolved: research.filter((entry) => entry.lineage?.founderKind === "descendant").length,
      immigrants: research.filter((entry) => entry.lineage?.founderKind === "immigrant").length,
      reentries: research.filter((entry) => entry.lineage?.founderKind === "seed").length,
    };
  };
  const researchBudget = budgetFor(AB_COHORT.RESEARCH);
  const conventionalBudget = budgetFor(AB_COHORT.CONVENTIONAL);
  assertEqual(researchBudget.size, conventionalBudget.size, "both arms must get the same cohort size");
  assertEqual(
    speciesCountsEqual(researchBudget.perSpecies, conventionalBudget.perSpecies),
    true,
    "both arms must get the same per-species quotas",
  );
  assertEqual(speciesCountsEqual(researchBudget.perSpecies, scaled), true, "the quotas must be met exactly");
  assertEqual(researchBudget.evolved, conventionalBudget.evolved, "identical crossover/mutation opportunity count");
  assertEqual(researchBudget.immigrants, conventionalBudget.immigrants, "identical immigrant/exploration budget");
  assertEqual(researchBudget.reentries, conventionalBudget.reentries, "identical survivor/re-entry budget");

  // The artifact's parity record must still hold in strict mode.
  const { artifact } = await artifactFor({ requested: true, mismatch: false });
  for (const key of ["equalStartingSlots", "equalEvolutionaryRules", "equalScoring", "equalGates"]) {
    assertEqual(artifact.config[key], true, `${key} must remain true`);
  }
  assertEqual(artifact.config.scoringBonusForEitherCohort, 0, "neither cohort may receive a bonus");
  assertEqual(artifact.config.crossCohortCrossover, false, "cross-cohort crossover stays disabled");
  assertEqual(
    artifact.cohortConstruction.speciesSubCohortEvolution,
    "independent per-species sub-cohorts, equal resources both arms",
    "the artifact must state how the match was enforced",
  );
});

/* ============================================================================
 * 21-23. Pure helpers and regressions
 * ==========================================================================*/

test("20. Species helpers are deterministic, exact, and never fabricate species", () => {
  const a = planSpeciesMatchedCohort({ researchSeeds: reportedResearchSeeds(), requestedPerCohort: 13, seed: "determinism" });
  const b = planSpeciesMatchedCohort({ researchSeeds: reportedResearchSeeds(), requestedPerCohort: 13, seed: "determinism" });
  assertEqual(JSON.stringify(a.conventional), JSON.stringify(b.conventional), "the same seed must build the same controls");
  assertEqual(a.matchedPerCohort, b.matchedPerCohort, "the same seed must build the same size");
  const verdict = speciesMatchVerdict({ Reversal: 12, "Wallet Flow": 1 }, { Reversal: 12, Momentum: 1 });
  assertEqual(verdict.matched, false, "a differing species is a mismatch");
  assertEqual(verdict.deltas["Wallet Flow"], 1, "the delta is per species");
  assertEqual(speciesMatchVerdict({}, { Momentum: 1 }).matched, false, "a one-sided species is a mismatch");
  const trimmed = trimSpeciesCounts(
    [
      { species: "Reversal", id: "r1" },
      { species: "Momentum", id: "m1" },
      { species: "Reversal", id: "r2" },
    ],
    { Reversal: 1 },
  );
  assertDeepEqual(trimmed, [{ species: "Reversal", id: "r1" }], "trimming keeps the natural order and drops other species");
  assertEqual(typeof describeSpeciesCounts({ A: 1 }), "string", "the one-line species summary must exist");
});

test("21. An unmatched run may never be labelled species-matched anywhere", async () => {
  const { artifact } = await artifactFor({ requested: true, mismatch: true });
  const serialized = JSON.stringify(artifact);
  const speciesBlock = JSON.stringify(artifact.species);
  assert(speciesBlock.includes("\"matched\":false"), "the mismatch must be recorded");
  assert(!/"matchMode":"species-matched"/.test(speciesBlock), "the effective match mode may not claim a match");
  assert(
    !/"effectiveMatchMode":"species-matched"/.test(speciesBlock),
    "effectiveMatchMode may not claim a match when the cohorts differ",
  );
  assert(serialized.includes("\"requestedMatchMode\":\"species-matched\""), "the request itself is still recorded honestly");
});

test("22. Non-strict pool construction is unchanged (random species still explored)", () => {
  const pool = buildEntrantPool({
    champions: [{ genome: { riskFraction: 0.2 }, species: "Momentum" }],
    population: 24,
    seed: "unchanged-pool",
    championShare: 0.35,
    immigrantShare: 0.15,
  });
  const species = Object.keys(speciesCountsOfRows(pool));
  assert(species.includes("Momentum"), "the ordinary builder keeps its champion species");
  assert(species.length > 1, `the ordinary builder must keep drawing from several species (got ${species.join(", ")})`);
  assert(pool.length === 24, "the ordinary builder keeps the requested population");
  const quotaPool = buildSpeciesPreservingPool({
    champions: [{ genome: { riskFraction: 0.2 }, species: "Momentum" }],
    members: [{ genome: { riskFraction: 0.2 }, species: "Momentum" }],
    quotas: { Momentum: 4, Reversal: 2 },
    seed: "quota-pool",
  });
  assertEqual(quotaPool.length, 6, "the quota builder must sum to the quotas");
  assertDeepEqual(speciesCountsOfRows(quotaPool), { Momentum: 4, Reversal: 2 }, "the quota builder must honor each quota");
});

test("23. The strict species-match path is PAPER ONLY (no execution, signing, or wallet path)", async () => {
  const files = [
    "scripts/research/ab-cohort.mjs",
    "scripts/arena/ab-comparison.mjs",
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
  const source = await readFile("scripts/research/ab-cohort.mjs", "utf8");
  assert(!/process\.env/.test(source), "the species-match module must not read the environment directly");
  assert(source.includes("PAPER"), "the module must state the paper-only policy");
});

test("24. Strict freeze counts are exact for a fully offline strict A/B run", async () => {
  const { datasets } = await fixture();
  const plan = planSpeciesMatchedCohort({ researchSeeds: reportedResearchSeeds(), requestedPerCohort: 13, seed: "end-to-end" });
  assertEqual(plan.matchedPerCohort, 13, "the reported shape plans at 13 per cohort");
  const built = buildMatchedAbCohort({
    requestedPopulation: 26,
    researchSeeds: plan.research,
    conventionalSeeds: plan.conventional,
  });
  const quotas = plan.counts;
  const researchPool = buildSpeciesPreservingPool({
    champions: built.research,
    members: built.research,
    quotas,
    seed: "end-to-end:r",
    cohort: AB_COHORT.RESEARCH,
  });
  const conventionalPool = buildSpeciesPreservingPool({
    champions: built.conventional,
    members: built.conventional,
    quotas,
    seed: "end-to-end:c",
    cohort: AB_COHORT.CONVENTIONAL,
  });
  const freeze = enforceSpeciesMatchInvariant({
    research: researchPool,
    conventional: conventionalPool,
    expectedCounts: quotas,
    requested: true,
  });
  assertEqual(freeze.ok, true, `the offline strict freeze must pass: ${freeze.reason}`);
  assertDeepEqual(freeze.researchCounts, { Reversal: 12, "Wallet Flow": 1 }, "research freezes at the natural mix");
  assertDeepEqual(freeze.conventionalCounts, { Reversal: 12, "Wallet Flow": 1 }, "conventional freezes at the same mix");

  const result = await runArenaTournament({
    datasets,
    config: tinyConfig(),
    entrants: [...researchPool, ...conventionalPool],
    seeds: ["end-to-end-1"],
    stressProfiles: ["mild", "moderate"],
    maxWindows: 1,
    workers: 0,
    useCache: false,
    arenaId: "phase5a31-end-to-end",
    researchEnabled: true,
    researchMode: RESEARCH_ARENA_MODE.AB,
    abAccounting: {
      ...built.accounting,
      requestedMatchMode: "species-matched",
      speciesMatched: true,
      speciesMatch: { requested: true, matched: true, referenceCounts: plan.requestedCounts, quotas, noCloning: true },
    },
    abConfig: { generations: 1, workers: 0 },
    abRoles: { known: [...PROPOSING_ROLES, ...ADVISORY_ROLES], advisory: [...ADVISORY_ROLES] },
    abSpeciesMatched: true,
  });
  const species = result.summary.abComparison.species;
  assertEqual(species.matched, true, "the evaluated cohorts must be species-identical");
  assertEqual(species.effectiveMatchMode, "species-matched", "effective mode must be species-matched");
  assertDeepEqual(species.research, { Reversal: 12, "Wallet Flow": 1 }, "every research row is accounted for");
  assertDeepEqual(species.conventional, { Reversal: 12, "Wallet Flow": 1 }, "every conventional row is accounted for");
  assertEqual(result.candidateRows.length, 26, "both cohorts were evaluated");
  for (const row of result.candidateRows) {
    assert(row.species === "Reversal" || row.species === "Wallet Flow", `${row.species} may not appear anywhere`);
  }
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

  console.log(`\nEVOLVE Phase 5A.3.1 validation: ${passed}/${cases.length} checks passed`);

  if (failures.length > 0) {
    console.log("Failed checks:");
    for (const failure of failures) console.log(`  - ${failure.name}`);
    process.exitCode = 1;
  } else {
    console.log("All Phase 5A.3.1 checks passed.");
    console.log(
      "PAPER RESEARCH ONLY. Strict species matching makes the frozen cohorts species-identical by construction; it does not create significance, profitability, or deployment eligibility.",
    );
  }
}

run().catch(async (error) => {
  await disposeFixture();
  console.error("phase 5a.3.1 validation runner crashed:", error);
  process.exitCode = 1;
});

export { cases };
