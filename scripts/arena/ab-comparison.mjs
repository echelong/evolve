/**
 * Phase 5A.3 A/B comparison reporting (PAPER ONLY).
 *
 * Consumes the candidate rows produced by `runArenaTournament` and produces:
 *
 *   - per-cohort size / diversity / convergence accounting
 *   - per-cohort Arena performance (score, rank, funnel counts)
 *   - per-cohort paper trading evidence (medians of the observed metrics)
 *   - per-cohort robustness (stress survival, regime coverage, failed gates)
 *   - per-cohort distinct-mint diagnostics (research vs conventional)
 *   - role-level research lineage metrics
 *   - descriptive statistics + an OPTIONAL deterministic bootstrap CI
 *
 * Statistical honesty rules baked into the output:
 *   - no "statistically significant" claim is ever emitted (the field exists
 *     and is explicitly null with an explanation)
 *   - no profitability claim, no forward-looking language
 *   - every comparison reports its own sample size and limitations
 *
 * Nothing here executes, signs, or trades anything. PAPER ONLY.
 */

import { createSeededRandom } from "../lib/random.mjs";
import { computeGenomeMetrics, DEFAULT_DEPLOYMENT_GATES } from "./orchestrator.mjs";
import { AB_COHORT, AB_DEFAULTS, convergenceStats, normalizeLineage } from "../research/ab-cohort.mjs";

export const AB_COMPARISON_VERSION = 1;

const DISTINCT_MINT_GATE = "minimum distinct mints";

function round6(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 1e6) / 1e6;
}

/** Finite numbers only, sorted ascending. */
export function finiteSorted(values = []) {
  return (Array.isArray(values) ? values : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
}

/** Median of a list (null when empty). */
export function medianValue(values = []) {
  const sorted = finiteSorted(values);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function meanValue(values = []) {
  const sorted = finiteSorted(values);
  if (sorted.length === 0) return null;
  return sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
}

/** Linear-interpolated percentile (p in 0..1) of a sorted-or-unsorted list. */
export function percentileValue(values = [], p = 0.5) {
  const sorted = finiteSorted(values);
  if (sorted.length === 0) return null;
  const clamped = Math.min(1, Math.max(0, Number(p) || 0));
  if (sorted.length === 1) return sorted[0];
  const position = clamped * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

export function quartiles(values = []) {
  return {
    q1: round6(percentileValue(values, 0.25)),
    median: round6(percentileValue(values, 0.5)),
    q3: round6(percentileValue(values, 0.75)),
  };
}

/** Deterministic resample-with-replacement using a seeded generator. */
function resample(values, random) {
  const out = new Array(values.length);
  for (let i = 0; i < values.length; i += 1) out[i] = values[Math.floor(random() * values.length)];
  return out;
}

function interval(values) {
  return {
    low: round6(percentileValue(values, 0.025)),
    high: round6(percentileValue(values, 0.975)),
  };
}

/**
 * Descriptive comparison of two samples, plus an OPTIONAL deterministic
 * bootstrap confidence interval for the difference (research − conventional).
 *
 * The bootstrap uses a fixed seed and a fixed iteration count, so the same
 * cohorts always produce byte-identical intervals. It describes the spread of
 * the observed paper metric; it is NOT a significance test and the output says
 * so.
 */
export function compareDistributions(researchValues = [], conventionalValues = [], options = {}) {
  const iterations = Number.isFinite(Number(options.iterations))
    ? Math.max(0, Math.floor(Number(options.iterations)))
    : AB_DEFAULTS.bootstrapIterations;
  const seed = options.seed ?? AB_DEFAULTS.bootstrapSeed;

  const a = finiteSorted(researchValues);
  const b = finiteSorted(conventionalValues);
  const describe = (values) => ({
    n: values.length,
    median: round6(percentileValue(values, 0.5)),
    mean: round6(meanValue(values)),
    q1: round6(percentileValue(values, 0.25)),
    q3: round6(percentileValue(values, 0.75)),
    min: values.length > 0 ? round6(values[0]) : null,
    max: values.length > 0 ? round6(values[values.length - 1]) : null,
    interquartileRange:
      values.length > 0
        ? round6(percentileValue(values, 0.75) - percentileValue(values, 0.25))
        : null,
  });

  const research = describe(a);
  const conventional = describe(b);
  const difference = {
    median: research.median != null && conventional.median != null ? round6(research.median - conventional.median) : null,
    mean: research.mean != null && conventional.mean != null ? round6(research.mean - conventional.mean) : null,
  };

  let bootstrap = {
    available: false,
    iterations: 0,
    seed,
    medianDifference: null,
    meanDifference: null,
    note: "bootstrap not computed (an empty cohort)",
  };
  if (a.length > 0 && b.length > 0 && iterations > 0) {
    const random = createSeededRandom(`ab-bootstrap:${seed}`);
    const medianDiffs = new Array(iterations);
    const meanDiffs = new Array(iterations);
    for (let i = 0; i < iterations; i += 1) {
      const ra = resample(a, random);
      const rb = resample(b, random);
      medianDiffs[i] = percentileValue(ra, 0.5) - percentileValue(rb, 0.5);
      meanDiffs[i] = meanValue(ra) - meanValue(rb);
    }
    bootstrap = {
      available: true,
      iterations,
      seed,
      medianDifference: { ...interval(medianDiffs), point: difference.median },
      meanDifference: { ...interval(meanDiffs), point: difference.mean },
      note: "deterministic percentile bootstrap (resample with replacement, fixed seed). Descriptive only — this is NOT a significance test and no p-value is claimed.",
    };
  }

  return {
    research,
    conventional,
    difference,
    bootstrap,
    // Explicitly absent: nothing in this module claims statistical significance.
    significance: null,
    significanceNote:
      "No significance test is performed. Sample sizes are small, the observations are paper replays of overlapping historical windows, and no correction for multiple metrics is applied — so a difference here is an observation, not a result.",
  };
}

/* -------------------------------------------------------------------------- */
/* Per-cohort metrics                                                         */
/* -------------------------------------------------------------------------- */

const REACHED_GROUP = new Set(["GROUP", "STRESS", "CHAMPION LEAGUE"]);
const SURVIVED_STRESS = new Set(["STRESS", "CHAMPION LEAGUE"]);

/** Arena performance block for one cohort's candidate rows. */
export function cohortArenaPerformance(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const scores = list.map((row) => row?.score);
  const ranks = list.map((row) => row?.finalRank);
  const within = (limit) => list.filter((row) => Number.isFinite(row?.finalRank) && row.finalRank <= limit).length;
  return {
    entrants: list.length,
    bestScore: scores.length > 0 ? round6(Math.max(...finiteSorted(scores))) : null,
    bestRank: ranks.length > 0 ? Math.min(...finiteSorted(ranks)) : null,
    medianScore: round6(medianValue(scores)),
    meanScore: round6(meanValue(scores)),
    scoreQuartiles: quartiles(scores),
    scoreInterquartileRange: quartiles(scores).q3 - quartiles(scores).q1,
    medianRank: round6(medianValue(ranks)),
    top10Count: within(10),
    top25Count: within(25),
    top50Count: within(50),
    groupCount: list.filter((row) => REACHED_GROUP.has(row?.highestStage)).length,
    stressCount: list.filter((row) => SURVIVED_STRESS.has(row?.highestStage)).length,
    championLeagueCount: list.filter((row) => row?.isChampionLeagueFinalist === true).length,
    deploymentCount: list.filter((row) => row?.deploymentEligible === true).length,
    gatePassedCount: list.filter((row) => row?.gateStatus === "GATES_PASSED").length,
    insufficientEvidenceCount: list.filter((row) => row?.gateStatus === "INSUFFICIENT_EVIDENCE").length,
  };
}

function medianOfEvidence(rows, pick) {
  return round6(medianValue(rows.map((row) => pick(row?.paperEvidence ?? {}))));
}

/** Paper trading evidence medians for one cohort. */
export function cohortTradingEvidence(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  return {
    medianTrades: medianOfEvidence(list, (e) => e.medianTrades),
    medianDistinctMints: medianOfEvidence(list, (e) => e.medianDistinctMints),
    medianTopMintNotionalShare: medianOfEvidence(list, (e) => e.medianTopMintNotionalShare),
    medianDrawdown: medianOfEvidence(list, (e) => e.medianDrawdown),
    medianNetPaperReturn: medianOfEvidence(list, (e) => e.medianNetReturn),
    medianGrossPaperReturn: medianOfEvidence(list, (e) => e.medianGrossReturn),
    medianCostDrag: medianOfEvidence(list, (e) => e.medianCostDrag),
    totalOosRuns: list.reduce((sum, row) => sum + (row?.paperEvidence?.oosRunCount ?? 0), 0),
    totalStressRuns: list.reduce((sum, row) => sum + (row?.paperEvidence?.stressRunCount ?? 0), 0),
  };
}

/** Robustness block: stress survival, regime coverage, OOS behaviour, gates. */
export function cohortRobustness(rows = [], { stressProfiles = ["mild", "moderate"] } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const profiles = (stressProfiles ?? []).filter((name) => name && name !== "none");
  const stressSurvival = {};
  for (const profile of profiles) {
    stressSurvival[profile] = list.filter(
      (row) => row?.paperEvidence?.stressSurvival?.[profile]?.survived === true,
    ).length;
  }
  const regimeRuns = list.map((row) => row?.paperEvidence?.regimeRuns);
  const regimePositive = list.map((row) => row?.paperEvidence?.regimePositive);
  const oosWindows = list.map((row) => row?.paperEvidence?.oosWindows);
  return {
    stressSurvivalCount: list.filter((row) => (row?.paperEvidence?.stressSurvived ?? 0) >= 1).length,
    stressSurvival: stressSurvival,
    mildStressSurvivalCount: stressSurvival.mild ?? 0,
    moderateStressSurvivalCount: stressSurvival.moderate ?? 0,
    medianRegimeRuns: round6(medianValue(regimeRuns)),
    medianPositiveRegimes: round6(medianValue(regimePositive)),
    medianOosWindows: round6(medianValue(oosWindows)),
    medianOosNetReturn: round6(medianValue(list.map((row) => row?.paperEvidence?.medianNetReturn))),
    catastrophicCount: list.filter((row) => (row?.paperEvidence?.catastrophicEvents ?? 0) > 0).length,
  };
}

/** Failed-gate label -> count for one cohort. */
export function failedGateDistribution(rows = []) {
  const out = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    for (const gate of row?.failedGates ?? []) out[gate] = (out[gate] ?? 0) + 1;
  }
  return out;
}

/**
 * Pool the per-candidate distinct-mint diagnostics for one cohort, plus the
 * count of candidates that failed the (unchanged) minimum-distinct-mints gate
 * and a distribution of the recorded rejection reasons.
 */
export function cohortDistinctMintDiagnostics(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const fields = [
    "opportunitiesObserved",
    "eligibleTicks",
    "eligibleMints",
    "mintsEntered",
    "trades",
    "blockedEntries",
    "abstainedTicks",
    "noEligibleTicks",
    "belowThresholdTicks",
    "pausedTicks",
    "distinctMints",
  ];
  const totals = Object.fromEntries(fields.map((field) => [field, 0]));
  const rejectionReasons = {};
  let runsWithDiagnostics = 0;
  for (const row of list) {
    const diagnostics = row?.distinctMintDiagnostics ?? null;
    if (!diagnostics) continue;
    runsWithDiagnostics += 1;
    for (const field of fields) {
      const value = Number(diagnostics[field]);
      if (Number.isFinite(value)) totals[field] += value;
    }
    for (const reason of diagnostics.explanation ?? []) {
      rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
    }
  }
  return {
    candidates: list.length,
    candidatesWithDiagnostics: runsWithDiagnostics,
    ...totals,
    failedMinDistinctMintsGate: list.filter((row) => (row?.failedGates ?? []).includes(DISTINCT_MINT_GATE)).length,
    // The gate itself is never weakened here — this is diagnostics only.
    minDistinctMintsGate: DEFAULT_DEPLOYMENT_GATES.minDistinctMints,
    rejectionReasons,
  };
}

/** Diversity block for one cohort, from its entrant genomes + candidate rows. */
export function cohortDiversity(entrants = [], rows = []) {
  const metrics = computeGenomeMetrics(
    (Array.isArray(entrants) ? entrants : []).map((entrant) => ({
      genome: entrant?.genome,
      species: entrant?.species,
      digest: entrant?.digest,
      lineageId: entrant?.lineageId ?? entrant?.lineage?.lineageId ?? entrant?.digest,
    })),
  );
  const convergence = convergenceStats(rows);
  const genomeDiversity = metrics.populationSize > 0 ? metrics.uniqueGenomes / metrics.populationSize : 0;
  return {
    cohortSize: metrics.populationSize,
    uniqueFinalGenomes: convergence.uniqueFinalGenomes,
    uniqueGenomeRatio: round6(genomeDiversity),
    genomeDiversity: round6(genomeDiversity),
    lineageConcentration: round6(metrics.lineageConcentration),
    pairwiseDistanceSample: round6(metrics.pairwiseDistanceSample),
    descendantConvergence: {
      convergedSlots: convergence.convergenceCount,
      repeatedDigests: convergence.repeatedDigests.length,
      note:
        "Descendants may legitimately converge on the same genome. That is recorded as convergence, never silently de-duplicated.",
    },
    speciesDistribution: metrics.speciesDistribution,
  };
}

/** Role-level RESEARCH lineage metrics (Phase 5A.3, section M). */
export function roleLineageMetrics({
  researchSeeds = [],
  researchRows = [],
  knownRoles = [],
  advisoryRoles = [],
} = {}) {
  const roles = {};
  const ensure = (role) => {
    const key = typeof role === "string" && role.length > 0 ? role : "unknown";
    if (!roles[key]) {
      roles[key] = {
        role: key,
        advisory: (advisoryRoles ?? []).includes(key),
        advisoryMode: (advisoryRoles ?? []).includes(key) ? "ADVISORY" : "PROPOSING",
        startingUniqueSeeds: 0,
        descendantsAtFreeze: 0,
        medianArenaScore: null,
        bestRank: null,
        groupCount: 0,
        stressCount: 0,
        championLeagueCount: 0,
        deploymentCount: 0,
        failedGates: {},
        medianDistinctMints: null,
        medianDrawdown: null,
        medianNetPaperReturn: null,
        _seeds: new Set(),
        _scores: [],
        _ranks: [],
        _mints: [],
        _drawdowns: [],
        _returns: [],
      };
    }
    return roles[key];
  };

  for (const role of knownRoles ?? []) ensure(role);

  for (const seed of Array.isArray(researchSeeds) ? researchSeeds : []) {
    const lineage = normalizeLineage(seed);
    const role = seed?.research?.authorRole ?? lineage.roles?.[0] ?? null;
    if (!role) continue;
    const entry = ensure(role);
    const digest = lineage.seedDigest ?? seed?.digest ?? null;
    if (digest) entry._seeds.add(digest);
  }

  for (const row of Array.isArray(researchRows) ? researchRows : []) {
    const lineage = normalizeLineage(row);
    const rowRoles = lineage.roles?.length > 0 ? lineage.roles : [];
    for (const role of rowRoles) {
      const entry = ensure(role);
      entry.descendantsAtFreeze += 1;
      if (Number.isFinite(row?.score)) entry._scores.push(row.score);
      if (Number.isFinite(row?.finalRank)) entry._ranks.push(row.finalRank);
      if (REACHED_GROUP.has(row?.highestStage)) entry.groupCount += 1;
      if (SURVIVED_STRESS.has(row?.highestStage)) entry.stressCount += 1;
      if (row?.isChampionLeagueFinalist === true) entry.championLeagueCount += 1;
      if (row?.deploymentEligible === true) entry.deploymentCount += 1;
      for (const gate of row?.failedGates ?? []) entry.failedGates[gate] = (entry.failedGates[gate] ?? 0) + 1;
      const mints = row?.paperEvidence?.medianDistinctMints;
      if (Number.isFinite(mints)) entry._mints.push(mints);
      const drawdown = row?.paperEvidence?.medianDrawdown;
      if (Number.isFinite(drawdown)) entry._drawdowns.push(drawdown);
      const net = row?.paperEvidence?.medianNetReturn;
      if (Number.isFinite(net)) entry._returns.push(net);
    }
  }

  const out = {};
  for (const [role, entry] of Object.entries(roles)) {
    out[role] = {
      role: entry.role,
      advisory: entry.advisory,
      advisoryMode: entry.advisoryMode,
      startingUniqueSeeds: entry._seeds.size,
      descendantsAtFreeze: entry.descendantsAtFreeze,
      // A role with no unique seeds and no descendants is reported as advisory /
      // inactive — it is never given a fabricated entrant.
      inactive: entry._seeds.size === 0 && entry.descendantsAtFreeze === 0,
      medianArenaScore: round6(medianValue(entry._scores)),
      bestRank: entry._ranks.length > 0 ? Math.min(...finiteSorted(entry._ranks)) : null,
      groupCount: entry.groupCount,
      stressCount: entry.stressCount,
      championLeagueCount: entry.championLeagueCount,
      deploymentCount: entry.deploymentCount,
      failedGates: entry.failedGates,
      medianDistinctMints: round6(medianValue(entry._mints)),
      medianDrawdown: round6(medianValue(entry._drawdowns)),
      medianNetPaperReturn: round6(medianValue(entry._returns)),
    };
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Full artifact                                                              */
/* -------------------------------------------------------------------------- */

/** Species distribution counts for a set of rows/entrants. */
export function speciesCounts(rows = []) {
  const out = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const species = row?.species;
    if (typeof species !== "string" || species.length === 0) continue;
    out[species] = (out[species] ?? 0) + 1;
  }
  return out;
}

function distributionKeys(counts) {
  return Object.keys(counts ?? {}).sort();
}

/**
 * Compare two species distributions. `matched` is true only when every species
 * count is identical on both sides.
 */
export function speciesMatchVerdict(researchCounts = {}, conventionalCounts = {}) {
  const keys = new Set([...distributionKeys(researchCounts), ...distributionKeys(conventionalCounts)]);
  const deltas = {};
  let matched = true;
  for (const key of keys) {
    const delta = (researchCounts[key] ?? 0) - (conventionalCounts[key] ?? 0);
    deltas[key] = delta;
    if (delta !== 0) matched = false;
  }
  return { matched, deltas };
}

/** Family distribution from research lineage provenance. */
export function familyCounts(rows = []) {
  const out = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const lineage = normalizeLineage(row);
    const families = lineage.researchFamilies?.length > 0
      ? lineage.researchFamilies
      : row?.research?.researchFamily
        ? [row.research.researchFamily]
        : [];
    if (families.length === 0) {
      out.none = (out.none ?? 0) + 1;
      continue;
    }
    for (const family of families) out[family] = (out[family] ?? 0) + 1;
  }
  return out;
}

function roleDistributionFromSeeds(seeds = []) {
  const out = {};
  for (const seed of Array.isArray(seeds) ? seeds : []) {
    const role = seed?.research?.authorRole ?? seed?.lineage?.authorRole ?? seed?.lineage?.roles?.[0] ?? null;
    if (!role) continue;
    out[role] = (out[role] ?? 0) + 1;
  }
  return out;
}

/**
 * Build the `.evolve/arenas/<arena-id>/ab-comparison.json` artifact.
 *
 * @param {{
 *   arenaId: string,
 *   candidateRows: object[],
 *   entrants: object[],
 *   accounting: object,
 *   config: object,
 *   datasets: object[],
 *   seeds: Array<number|string>,
 *   stressProfiles: string[],
 *   knownRoles?: string[],
 *   advisoryRoles?: string[],
 *   bootstrapIterations?: number,
 *   bootstrapSeed?: string,
 * }} options
 */
export function buildAbComparison({
  arenaId = null,
  candidateRows = [],
  entrants = [],
  accounting = {},
  config = {},
  datasets = [],
  seeds = [],
  stressProfiles = [],
  knownRoles = [],
  advisoryRoles = [],
  bootstrapIterations = AB_DEFAULTS.bootstrapIterations,
  bootstrapSeed = AB_DEFAULTS.bootstrapSeed,
} = {}) {
  const rows = Array.isArray(candidateRows) ? candidateRows : [];
  const researchRows = rows.filter((row) => normalizeLineage(row).cohort === AB_COHORT.RESEARCH);
  const conventionalRows = rows.filter((row) => normalizeLineage(row).cohort === AB_COHORT.CONVENTIONAL);
  const list = Array.isArray(entrants) ? entrants : [];
  const researchEntrants = list.filter((entrant) => normalizeLineage(entrant).cohort === AB_COHORT.RESEARCH);
  const conventionalEntrants = list.filter((entrant) => normalizeLineage(entrant).cohort === AB_COHORT.CONVENTIONAL);

  const comparisonOptions = { iterations: bootstrapIterations, seed: bootstrapSeed };
  const compare = (pick) =>
    compareDistributions(
      researchRows.map(pick),
      conventionalRows.map(pick),
      comparisonOptions,
    );

  const researchSpecies = speciesCounts(researchRows);
  const conventionalSpecies = speciesCounts(conventionalRows);
  const speciesVerdict = speciesMatchVerdict(researchSpecies, conventionalSpecies);
  // Phase 5A.3.1: REQUESTED vs EFFECTIVE match mode. The requested mode comes
  // from the run configuration; the effective mode is only ever
  // "species-matched" when the frozen cohorts really are species-identical, so
  // the artifact can never claim species-matched while `matched` is false.
  const requestedMatchMode =
    accounting?.requestedMatchMode ?? (accounting?.speciesMatched === true ? "species-matched" : "unmatched");
  const speciesMatchRequested = requestedMatchMode === "species-matched";
  const speciesMatchRecord = accounting?.speciesMatch ?? null;
  const effectiveMatchMode =
    speciesMatchRequested && speciesVerdict.matched ? "species-matched" : "unmatched";
  const speciesMatchInvariant = {
    requested: speciesMatchRequested,
    requestedMatchMode,
    effectiveMatchMode,
    matched: speciesVerdict.matched,
    referenceCounts: speciesMatchRecord?.referenceCounts ?? null,
    agreedCounts: speciesMatchRecord?.quotas ?? speciesMatchRecord?.counts ?? null,
    shortfall: speciesMatchRecord?.shortfall ?? null,
    symmetricShrink: speciesMatchRecord?.symmetricShrink === true,
    noCloning: speciesMatchRecord?.noCloning === true,
    enforcement: speciesMatchRecord?.enforcement ?? null,
    satisfied: speciesMatchRequested ? speciesVerdict.matched : true,
  };

  const researchDiversity = cohortDiversity(researchEntrants, researchRows);
  const conventionalDiversity = cohortDiversity(conventionalEntrants, conventionalRows);

  const limitations = [
    "PAPER ONLY: every number is simulated paper accounting over recorded/observed historical windows. Nothing here is a profitability claim.",
    "Sample sizes are small; the cohorts are matched by construction but each seed is one deterministic replay, not an independent market draw.",
    "Walk-forward windows overlap by design, so observations within a cohort are not statistically independent.",
    "No significance test is performed and no p-value is claimed. Bootstrap intervals are descriptive.",
    "Research-guided initialization is compared here against a conventional control built by the ordinary Arena entrant-pool construction; a different conventional construction would be a different experiment.",
  ];
  if (speciesMatchRequested && !speciesVerdict.matched) {
    limitations.push(
      "STRICT SPECIES MATCHING WAS REQUESTED BUT IS NOT SATISFIED for the frozen cohorts: this run is NOT a valid species-controlled A/B baseline, and no difference reported here can be attributed to research-guided initialization.",
    );
  } else if (!speciesVerdict.matched) {
    limitations.push(
      "Species composition is NOT matched between cohorts, so part of any observed difference may come from species mix rather than from research-guided initialization (enable species-matched A/B to remove this confound).",
    );
  } else {
    limitations.push(
      `Species composition is enforced identical across cohorts (requested and effective match mode: species-matched; quotas ${JSON.stringify(speciesMatchInvariant.agreedCounts ?? researchSpecies)}). Each species sub-cohort evolved independently with the same resources in both arms.`,
    );
  }
  if (accounting?.downgraded) {
    limitations.push(
      `The matched cohort size was downgraded from the requested ${accounting.requestedPerCohort} to ${accounting.matchedPerCohort} per cohort${accounting.shortageReason ? `: ${accounting.shortageReason}` : ""}. No genome was cloned to fill the gap.`,
    );
  }
  if (accounting?.expandDescendants) {
    limitations.push(
      "Descendant expansion was enabled: cohorts were grown to the requested size by ORDINARY evolution under identical rules, never by duplicating a seed. Descendant ancestry is preserved for attribution.",
    );
  }

  return {
    schemaVersion: AB_COMPARISON_VERSION,
    phase: "5A.3",
    arenaId,
    generatedAt: new Date().toISOString(),
    paperOnly: true,
    researchMode: "ab",
    question:
      "Does research-guided evolution outperform conventional evolution when both cohorts receive equal resources and equal evolutionary treatment?",
    // ---- parity record ---------------------------------------------------
    config: {
      requestedPopulation: accounting?.requestedPopulation ?? null,
      requestedPerCohort: accounting?.requestedPerCohort ?? null,
      matchedPerCohort: accounting?.matchedPerCohort ?? null,
      targetPerCohort: accounting?.targetPerCohort ?? null,
      generations: config.generations ?? null,
      workers: config.workers ?? null,
      seeds: [...seeds],
      stressProfiles: [...stressProfiles],
      survivorFraction: config.survivorFraction ?? null,
      breederShare: config.breederShare ?? null,
      mutationScale: config.mutationScale ?? null,
      crossoverRate: config.crossoverRate ?? null,
      immigrantRate: config.immigrantRate ?? null,
      randomImmigrantShare: config.randomImmigrantShare ?? null,
      championShare: config.championShare ?? null,
      immigrantShare: config.immigrantShare ?? null,
      crossCohortCrossover: false,
      equalStartingSlots: accounting?.symmetricStartingSlots === true,
      equalEvolutionaryRules: true,
      equalScoring: true,
      equalGates: true,
      scoringBonusForEitherCohort: 0,
    },
    datasets: (Array.isArray(datasets) ? datasets : []).map((dataset) => ({
      id: dataset?.id ?? null,
      sourceType: dataset?.sourceType ?? null,
      fingerprint: dataset?.fingerprint ?? null,
    })),
    // ---- cohort construction --------------------------------------------
    cohortConstruction: {
      requested: accounting?.requestedPopulation ?? null,
      requestedPerCohort: accounting?.requestedPerCohort ?? null,
      actualPerCohort: accounting?.matchedPerCohort ?? null,
      actualTotal: (accounting?.startingResearchSeeds ?? 0) + (accounting?.startingConventionalSeeds ?? 0),
      startingResearchSeeds: accounting?.startingResearchSeeds ?? 0,
      startingConventionalSeeds: accounting?.startingConventionalSeeds ?? 0,
      uniqueResearchSeeds: accounting?.uniqueResearchSeeds ?? 0,
      uniqueConventionalSeeds: accounting?.uniqueConventionalSeeds ?? 0,
      seedDuplicatesRejected: accounting?.seedDuplicatesRejected ?? { research: 0, conventional: 0 },
      shortage: accounting?.seedShortage ?? { research: 0, conventional: 0 },
      shortageReason: accounting?.shortageReason ?? null,
      downgraded: accounting?.downgraded === true,
      matchedDowngrade: accounting?.matchedDowngrade ?? 0,
      // Explicit: no seed genome is ever duplicated into a second slot.
      clonedToFillQuota: 0,
      noCloningPolicy: true,
      expandDescendants: accounting?.expandDescendants === true,
      crossCohortCrossover: false,
      symmetricStartingSlots: accounting?.symmetricStartingSlots === true,
      // Phase 5A.3.1: which control was requested, which was actually enforced,
      // and the per-species quotas both arms evolved with.
      requestedMatchMode,
      effectiveMatchMode,
      speciesMatchRequested,
      speciesQuotas: speciesMatchInvariant.agreedCounts,
      speciesShortfall: speciesMatchInvariant.shortfall,
      speciesSymmetricShrink: speciesMatchInvariant.symmetricShrink,
      speciesSubCohortEvolution: speciesMatchRequested ? "independent per-species sub-cohorts, equal resources both arms" : null,
    },
    cohortSize: {
      research: researchRows.length,
      conventional: conventionalRows.length,
      total: rows.length,
      researchUniqueFinalGenomes: researchDiversity.uniqueFinalGenomes,
      conventionalUniqueFinalGenomes: conventionalDiversity.uniqueFinalGenomes,
      researchGenomeDiversity: researchDiversity.genomeDiversity,
      conventionalGenomeDiversity: conventionalDiversity.genomeDiversity,
      researchLineageConcentration: researchDiversity.lineageConcentration,
      conventionalLineageConcentration: conventionalDiversity.lineageConcentration,
      researchDescendantConvergence: researchDiversity.descendantConvergence.convergedSlots,
      conventionalDescendantConvergence: conventionalDiversity.descendantConvergence.convergedSlots,
      equalSize: researchRows.length === conventionalRows.length,
    },
    cohorts: {
      research: {
        arena: cohortArenaPerformance(researchRows),
        trading: cohortTradingEvidence(researchRows),
        robustness: cohortRobustness(researchRows, { stressProfiles }),
        diversity: researchDiversity,
        failedGates: failedGateDistribution(researchRows),
      },
      conventional: {
        arena: cohortArenaPerformance(conventionalRows),
        trading: cohortTradingEvidence(conventionalRows),
        robustness: cohortRobustness(conventionalRows, { stressProfiles }),
        diversity: conventionalDiversity,
        failedGates: failedGateDistribution(conventionalRows),
      },
    },
    // ---- statistical comparison -----------------------------------------
    comparison: {
      arenaScore: compare((row) => row?.score),
      finalRank: compare((row) => row?.finalRank),
      medianNetPaperReturn: compare((row) => row?.paperEvidence?.medianNetReturn),
      medianGrossPaperReturn: compare((row) => row?.paperEvidence?.medianGrossReturn),
      medianCostDrag: compare((row) => row?.paperEvidence?.medianCostDrag),
      medianTrades: compare((row) => row?.paperEvidence?.medianTrades),
      medianDistinctMints: compare((row) => row?.paperEvidence?.medianDistinctMints),
      medianTopMintNotionalShare: compare((row) => row?.paperEvidence?.medianTopMintNotionalShare),
      medianDrawdown: compare((row) => row?.paperEvidence?.medianDrawdown),
      stressSurvived: compare((row) => row?.paperEvidence?.stressSurvived),
      positiveRegimes: compare((row) => row?.paperEvidence?.regimePositive),
    },
    species: {
      research: researchSpecies,
      conventional: conventionalSpecies,
      matched: speciesVerdict.matched,
      deltas: speciesVerdict.deltas,
      // `matchMode` is the EFFECTIVE mode (never claims species-matched unless
      // the frozen cohorts really are species-identical).
      requestedMatchMode,
      effectiveMatchMode,
      matchMode: effectiveMatchMode,
      invariant: speciesMatchInvariant,
      note: speciesVerdict.matched
        ? "Species composition is identical across cohorts."
        : speciesMatchRequested
          ? "Species composition differs across cohorts even though a strict species match was requested; this run is not a valid species-controlled A/B baseline."
          : "Species composition differs across cohorts; species mix is a confound for any observed difference.",
    },
    families: {
      research: familyCounts(researchRows),
      conventional: familyCounts(conventionalRows),
    },
    roles: {
      known: [...knownRoles],
      advisory: [...advisoryRoles],
      // Which originating role seeded each lineage (starting seeds only).
      seedDistribution: roleDistributionFromSeeds(
        researchEntrants.filter((entrant) => normalizeLineage(entrant).exactOriginal),
      ),
      research: roleLineageMetrics({
        researchSeeds: researchEntrants.filter((entrant) => normalizeLineage(entrant).exactOriginal),
        researchRows,
        knownRoles,
        advisoryRoles,
      }),
    },
    distinctMintDiagnostics: {
      research: cohortDistinctMintDiagnostics(researchRows),
      conventional: cohortDistinctMintDiagnostics(conventionalRows),
      note:
        "Diagnostics only. `minimum distinct mints` is unchanged for both cohorts; this section exists to show whether narrow market coverage is a research-specific problem or a general one.",
    },
    lineage: {
      research: lineageBlock(researchRows, {
        startingSeedDigests: accounting?.startingResearchSeeds ?? researchEntrants.length,
      }),
      conventional: lineageBlock(conventionalRows, {
        startingSeedDigests: accounting?.startingConventionalSeeds ?? conventionalEntrants.length,
      }),
    },
    statistics: {
      method: "descriptive medians/means/interquartile ranges plus a deterministic percentile bootstrap of the difference",
      bootstrapIterations,
      bootstrapSeed,
      significance: null,
      significanceNote:
        "No significance claim is made. The bootstrap describes the observed paper metric difference; it is not a hypothesis test.",
    },
    limitations,
    note:
      "Research cohort higher/lower/equal on the observed paper metrics above — with the sample sizes, uncertainty, and limitations listed. This is PAPER research output and does NOT predict future profitability.",
  };
}

function lineageGenerations(rows) {
  const out = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const lineage = normalizeLineage(row);
    const generation = Number.isFinite(lineage.generation) ? String(lineage.generation) : "unknown";
    out[generation] = (out[generation] ?? 0) + 1;
  }
  return out;
}

/**
 * Lineage accounting for one cohort at the freeze point: how many independent
 * seed digests started it, how many seed founders survived to the freeze, how
 * many random immigrants the cohort's own budget injected, how many distinct
 * lineages remain, and — critically — how many cross-cohort crosses happened
 * (which must be zero in the A/B benchmark).
 */
function lineageBlock(rows, { startingSeedDigests = null } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const seedFounders = new Set();
  let immigrantFounders = 0;
  let crossCohortCrossovers = 0;
  let orphansWithoutLineage = 0;
  for (const row of list) {
    const lineage = normalizeLineage(row);
    if (lineage.crossCohort) crossCohortCrossovers += 1;
    if (!lineage.lineageId) {
      orphansWithoutLineage += 1;
      continue;
    }
    if (lineage.founderKind === "seed" && lineage.seedDigest) seedFounders.add(lineage.seedDigest);
    if (lineage.founderKind === "immigrant") immigrantFounders += 1;
  }
  return {
    startingSeedDigests,
    seedFoundersAtFreeze: seedFounders.size,
    immigrantFoundersAtFreeze: immigrantFounders,
    lineages: new Set(list.map((row) => normalizeLineage(row).lineageId).filter(Boolean)).size,
    crossCohortCrossovers,
    orphansWithoutLineage,
    generations: lineageGenerations(list),
  };
}

/** Compact A/B block embedded into `summary.json`. */
export function summarizeAbForSummary(artifact) {
  if (!artifact) return null;
  const research = artifact.cohorts?.research ?? null;
  const conventional = artifact.cohorts?.conventional ?? null;
  const summarizeCohort = (cohort) =>
    cohort
      ? {
          cohortSize: cohort.arena?.entrants ?? 0,
          bestScore: cohort.arena?.bestScore ?? null,
          medianScore: cohort.arena?.medianScore ?? null,
          meanScore: cohort.arena?.meanScore ?? null,
          bestRank: cohort.arena?.bestRank ?? null,
          medianRank: cohort.arena?.medianRank ?? null,
          top10Count: cohort.arena?.top10Count ?? 0,
          top25Count: cohort.arena?.top25Count ?? 0,
          top50Count: cohort.arena?.top50Count ?? 0,
          groupCount: cohort.arena?.groupCount ?? 0,
          stressCount: cohort.arena?.stressCount ?? 0,
          championLeagueCount: cohort.arena?.championLeagueCount ?? 0,
          deploymentCount: cohort.arena?.deploymentCount ?? 0,
          uniqueFinalGenomes: cohort.diversity?.uniqueFinalGenomes ?? 0,
          genomeDiversity: cohort.diversity?.genomeDiversity ?? 0,
          lineageConcentration: cohort.diversity?.lineageConcentration ?? 0,
          medianTrades: cohort.trading?.medianTrades ?? null,
          medianDistinctMints: cohort.trading?.medianDistinctMints ?? null,
          medianDrawdown: cohort.trading?.medianDrawdown ?? null,
          medianNetPaperReturn: cohort.trading?.medianNetPaperReturn ?? null,
          medianGrossPaperReturn: cohort.trading?.medianGrossPaperReturn ?? null,
          medianCostDrag: cohort.trading?.medianCostDrag ?? null,
          medianTopMintNotionalShare: cohort.trading?.medianTopMintNotionalShare ?? null,
          stressSurvivalCount: cohort.robustness?.stressSurvivalCount ?? 0,
          failedGates: cohort.failedGates ?? {},
        }
      : null;
  return {
    version: artifact.schemaVersion,
    question: artifact.question,
    researchMode: artifact.researchMode,
    paperOnly: true,
    // Explicit parity record: what both cohorts did and did not share.
    parity: {
      seeds: [...(artifact.config?.seeds ?? [])],
      stressProfiles: [...(artifact.config?.stressProfiles ?? [])],
      datasetIds: (artifact.datasets ?? []).map((dataset) => dataset.id),
      datasetFingerprints: (artifact.datasets ?? []).map((dataset) => dataset.fingerprint),
      generations: artifact.config?.generations ?? null,
      workers: artifact.config?.workers ?? null,
      equalStartingSlots: artifact.config?.equalStartingSlots === true,
      equalEvolutionaryRules: artifact.config?.equalEvolutionaryRules === true,
      equalScoring: artifact.config?.equalScoring === true,
      equalGates: artifact.config?.equalGates === true,
      crossCohortCrossover: artifact.config?.crossCohortCrossover === true,
      scoringBonusForEitherCohort: artifact.config?.scoringBonusForEitherCohort ?? null,
    },
    cohortConstruction: artifact.cohortConstruction,
    cohortSize: artifact.cohortSize,
    research: summarizeCohort(research),
    conventional: summarizeCohort(conventional),
    comparison: {
      arenaScore: pickComparison(artifact.comparison?.arenaScore),
      finalRank: pickComparison(artifact.comparison?.finalRank),
      medianNetPaperReturn: pickComparison(artifact.comparison?.medianNetPaperReturn),
      medianDistinctMints: pickComparison(artifact.comparison?.medianDistinctMints),
      medianDrawdown: pickComparison(artifact.comparison?.medianDrawdown),
    },
    species: artifact.species,
    outliersNote: artifact.statistics?.significanceNote ?? null,
    limitations: artifact.limitations,
    note: artifact.note,
  };
}

function pickComparison(entry) {
  if (!entry) return null;
  return {
    researchMedian: entry.research?.median ?? null,
    conventionalMedian: entry.conventional?.median ?? null,
    medianDifference: entry.difference?.median ?? null,
    meanDifference: entry.difference?.mean ?? null,
    bootstrapAvailable: entry.bootstrap?.available === true,
    medianDifferenceInterval: entry.bootstrap?.available ? entry.bootstrap.medianDifference : null,
  };
}
