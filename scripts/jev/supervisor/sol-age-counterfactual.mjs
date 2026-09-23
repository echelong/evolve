/**
 * Phase 5I-PS.2c — SOL age-gate counterfactual aggregates.
 *
 * DIAGNOSTIC COUNTERFACTUAL • NOT A TRADING RULE. Observer-only: never imported
 * by the engine or the Jev packet builder, never read by the opportunity path.
 * The failure set is re-derived here from the copied production failure list by
 * removing ONLY `pool_too_old`; a supplied score is ignored whenever any other
 * failure remains. Compact bounded aggregates only — no per-evaluation rows.
 */
import { BIN_WIDTH, distribution } from "./sol-funnel.mjs";

export const SOL_AGE_COUNTERFACTUAL_LABEL = "DIAGNOSTIC COUNTERFACTUAL • NOT A TRADING RULE";
const POOL_TOO_OLD = "pool_too_old";
const NAMED_REMAINING = new Set(["buy_pressure", "momentum"]);
const COUNTERS = [
  "solAgeCounterfactualEvaluations",
  "solProductionPassesGates", "solFailsPoolTooOld", "solFailsWithoutPoolTooOld",
  "solFailsOnlyPoolTooOld",
  "solStillFailsWithoutPoolAge", "solStillFailsBuyPressure", "solStillFailsMomentum", "solStillFailsOther",
  "solPassesWithoutPoolAge",
  "solCounterfactualScored", "solCounterfactualScoredFromAgeOnly", "solCounterfactualScoredFromProductionPass",
  "solCounterfactualAboveThreshold", "solCounterfactualBelowThreshold", "solCounterfactualExactlyThreshold",
  "solCounterfactualNonFiniteScoreOrThreshold",
  "malformedFacts",
];
// Exclusive partition of every evaluation that failed `pool_too_old`.
const OVERLAP_BUCKETS = [
  "POOL_AGE_ONLY", "POOL_AGE_PLUS_BUY_PRESSURE", "POOL_AGE_PLUS_MOMENTUM",
  "POOL_AGE_PLUS_BUY_PRESSURE_PLUS_MOMENTUM", "POOL_AGE_PLUS_OTHER",
];
const SAMPLE_LIMIT = 32;
const SPECIES_LIMIT = 64;
const COMBINATION_LIMIT = 64;
const SPECIES_FIELDS = [
  "evaluations", "failsOnlyPoolTooOld", "stillFailsWithoutPoolAge", "passesWithoutPoolAge",
  "aboveThreshold", "belowThreshold", "exactThreshold",
];

function overlapBucket(remaining) {
  if (remaining.some((gate) => !NAMED_REMAINING.has(gate))) return "POOL_AGE_PLUS_OTHER";
  const buy = remaining.includes("buy_pressure"), momentum = remaining.includes("momentum");
  if (buy && momentum) return "POOL_AGE_PLUS_BUY_PRESSURE_PLUS_MOMENTUM";
  if (buy) return "POOL_AGE_PLUS_BUY_PRESSURE";
  if (momentum) return "POOL_AGE_PLUS_MOMENTUM";
  return "POOL_AGE_ONLY";
}

export function createSolAgeCounterfactual() {
  const counters = Object.fromEntries(COUNTERS.map((key) => [key, 0]));
  const overlapCounts = Object.fromEntries(OVERLAP_BUCKETS.map((key) => [key, 0]));
  const exactFailureCombinationCounts = {}, stillFailsGateCounts = {}, species = {};
  const score = distribution(), threshold = distribution(), margin = distribution();
  let scoredSamples = [];

  function speciesRow(label) {
    const name = typeof label === "string" ? label : "UNKNOWN";
    const key = Object.hasOwn(species, name) || Object.keys(species).length < SPECIES_LIMIT ? name : "OTHER";
    if (!Object.hasOwn(species, key)) {
      Object.defineProperty(species, key, {
        enumerable: true,
        value: { species: key, ...Object.fromEntries(SPECIES_FIELDS.map((field) => [field, 0])) },
      });
    }
    return species[key];
  }
  function countInto(map, key, limit = Infinity, overflow = null) {
    const target = Object.hasOwn(map, key) || Object.keys(map).length < limit ? key : overflow;
    if (!Object.hasOwn(map, target)) Object.defineProperty(map, target, { enumerable: true, writable: true, value: 0 });
    map[target] += 1;
  }

  function observe(facts) {
    const failedGates = facts?.failedGates;
    if (!Array.isArray(failedGates) || !failedGates.every((gate) => typeof gate === "string")) {
      counters.malformedFacts += 1;
      return;
    }
    const gates = [...failedGates];
    const remaining = gates.filter((gate) => gate !== POOL_TOO_OLD);
    const failsAge = remaining.length !== gates.length;
    const row = speciesRow(facts.species);

    counters.solAgeCounterfactualEvaluations += 1;
    row.evaluations += 1;
    countInto(exactFailureCombinationCounts, gates.length ? gates.join("+") : "PASS", COMBINATION_LIMIT, "OTHER_COMBINATION");

    if (gates.length === 0) counters.solProductionPassesGates += 1;
    else if (failsAge) counters.solFailsPoolTooOld += 1;
    else counters.solFailsWithoutPoolTooOld += 1;
    if (failsAge) overlapCounts[overlapBucket(remaining)] += 1;
    const ageOnly = failsAge && remaining.length === 0;
    if (ageOnly) { counters.solFailsOnlyPoolTooOld += 1; row.failsOnlyPoolTooOld += 1; }

    if (remaining.length > 0) {
      counters.solStillFailsWithoutPoolAge += 1;
      row.stillFailsWithoutPoolAge += 1;
      if (remaining.includes("buy_pressure")) counters.solStillFailsBuyPressure += 1;
      if (remaining.includes("momentum")) counters.solStillFailsMomentum += 1;
      if (remaining.some((gate) => !NAMED_REMAINING.has(gate))) counters.solStillFailsOther += 1;
      for (const gate of new Set(remaining)) countInto(stillFailsGateCounts, gate);
      return; // Scoring happens ONLY when no counterfactual failure remains.
    }

    counters.solPassesWithoutPoolAge += 1;
    row.passesWithoutPoolAge += 1;
    counters.solCounterfactualScored += 1;
    counters[ageOnly ? "solCounterfactualScoredFromAgeOnly" : "solCounterfactualScoredFromProductionPass"] += 1;
    const solScore = facts.counterfactualScore, entryScoreThreshold = facts.entryScoreThreshold;
    if (!Number.isFinite(solScore) || !Number.isFinite(entryScoreThreshold)) {
      counters.solCounterfactualNonFiniteScoreOrThreshold += 1;
      return;
    }
    const scoreMargin = solScore - entryScoreThreshold;
    score.add(solScore); threshold.add(entryScoreThreshold); margin.add(scoreMargin);
    // Existing EVOLVE semantics: `score >= entryScoreThreshold` is at/above.
    // Equality is a subset of above, never below.
    if (solScore >= entryScoreThreshold) { counters.solCounterfactualAboveThreshold += 1; row.aboveThreshold += 1; }
    else { counters.solCounterfactualBelowThreshold += 1; row.belowThreshold += 1; }
    if (scoreMargin === 0) { counters.solCounterfactualExactlyThreshold += 1; row.exactThreshold += 1; }
    scoredSamples = [...scoredSamples, {
      species: row.species, ageOnly, counterfactualScore: solScore, entryScoreThreshold, scoreMargin,
    }].slice(-SAMPLE_LIMIT);
  }

  return {
    observe,
    snapshot() {
      const s = score.snapshot(), t = threshold.snapshot(), m = margin.snapshot();
      return structuredClone({
        version: "5I-PS.2c",
        label: SOL_AGE_COUNTERFACTUAL_LABEL,
        counterfactualRule: "remove ONLY the pool_too_old GATE failure from the production failure list; every other failure kept (including pool_too_young when a genome's min age exceeds its max); score only when none remain",
        scoreConvention: "existing scoreMarket unchanged: its ageWeight x ageYouth term still applies; only the gate is ignored",
        productionPassInclusion: "solPassesWithoutPoolAge, solCounterfactualScored and above/below include evaluations that already pass production; see solCounterfactualScoredFromAgeOnly / FromProductionPass",
        independence: "counts are per agent per scan, autocorrelated, not independent samples",
        thresholdConvention: "above means score >= entryScoreThreshold (includes equality); exactly is the equality subset of above",
        ...counters,
        overlapCounts, exactFailureCombinationCounts, stillFailsGateCounts,
        species: Object.values(species).sort((a, b) => (a.species < b.species ? -1 : a.species > b.species ? 1 : 0)),
        scoredSamples,
        solCounterfactualMeanScore: s.mean, solCounterfactualMedianScore: s.median,
        solCounterfactualMinScore: s.min, solCounterfactualMaxScore: s.max,
        solCounterfactualMeanThreshold: t.mean, solCounterfactualMedianThreshold: t.median,
        solCounterfactualMeanMargin: m.mean, solCounterfactualMedianMargin: m.median,
        solCounterfactualMinMargin: m.min, solCounterfactualMaxMargin: m.max,
        medianMethod: "fixed histogram bin midrange; average central ranks; approximate",
        medianAbsoluteErrorBound: BIN_WIDTH / 2,
        medianOutOfRangeCounts: { score: s.outsideRange, threshold: t.outsideRange, margin: m.outsideRange },
        sampleLimit: SAMPLE_LIMIT,
        combinationLimit: COMBINATION_LIMIT,
      });
    },
  };
}
