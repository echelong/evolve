/**
 * Phase 5I.0b — prediction-quality metrics.
 *
 * This is PREDICTION RESEARCH, not trading research. The metrics are probability
 * scores and descriptive statistics. There is deliberately NO PnL, no Sharpe, no
 * simulated return, no trade count, and NO automated "winner": lower Brier /
 * log loss is better, and the reader decides what that means.
 *
 * Binary scoring rules (frozen):
 *   - outcome HIGHER -> o = 1, outcome LOWER -> o = 0
 *   - outcome TIE    -> retained in provenance and COUNTED, excluded from every
 *                       binary metric (never folded into either class)
 *   - directional accuracy uses the standard 0.50 decision rule
 *     (`pHigher >= 0.5` -> predicted HIGHER). That is a *scoring convention for
 *     one metric*, NOT a runtime confidence threshold: no probability is ever
 *     discarded, and no prediction is ever filtered by confidence.
 *
 * PAPER ONLY / DEVELOPMENT EVIDENCE ONLY.
 */

import { brierScore, absoluteCalibrationError, reliabilityBins } from "../calibration.mjs";
import { digestOf } from "../../lib/hash.mjs";
import { DIRECTION_PHASE } from "./definition.mjs";
import { BASELINE_IDS } from "./baselines.mjs";

export const DIRECTION_METRICS_VERSION = 2;

/** Binary scoring decision rule for directional ACCURACY only (documented, frozen). */
export const ACCURACY_DECISION_RULE = "predictedHigher = pHigher >= 0.5";
export const CALIBRATION_BIN_COUNT = 10;

/**
 * LOG-LOSS NUMERICAL SAFETY EPSILON. It CLAMPS the probability used INSIDE the
 * logarithm only. Stored probabilities are never clamped, never rewritten, and
 * never discarded: `p` stays exactly what the model returned, and the pairs this
 * epsilon had to touch are counted so the adjustment is visible.
 */
export const LOG_LOSS_EPSILON = 1e-15;

/**
 * FROZEN, PRE-DECLARED calibration bins over [0,1]. Fixed width; the final bin is
 * closed at 1.0 so a probability of exactly 1 has a home. This scheme is decided
 * here, before any 5I outcome existed, and is NEVER adapted to outcomes.
 */
export const CALIBRATION_BIN_EDGES = Object.freeze(
  Array.from({ length: CALIBRATION_BIN_COUNT }, (_, index) => ({
    lower: index / CALIBRATION_BIN_COUNT,
    upper: (index + 1) / CALIBRATION_BIN_COUNT,
    lowerInclusive: true,
    upperInclusive: index === CALIBRATION_BIN_COUNT - 1,
    label: index === CALIBRATION_BIN_COUNT - 1 ? `[${index / CALIBRATION_BIN_COUNT}, 1.0]` : `[${index / CALIBRATION_BIN_COUNT}, ${(index + 1) / CALIBRATION_BIN_COUNT})`,
  })),
);

/**
 * Deterministic quantile semantics: NEAREST-RANK on a sorted copy, with the
 * rank clamped to the last element. No interpolation, no randomness.
 */
export const QUANTILE_METHOD = "nearest-rank on a sorted copy, rank clamped to the last element";

export const OUTCOME = Object.freeze({
  HIGHER: "HIGHER",
  LOWER: "LOWER",
  TIE: "TIE",
});

/** Every metric FIELD this phase may emit. Profitability fields are absent by construction. */
export const METRIC_FIELDS = Object.freeze([
  "observationCount",
  "validPredictionCount",
  "invalidPredictionCount",
  "failedJevCount",
  "lateJevCount",
  "staleObservationCount",
  "outcomeUnavailableCount",
  "scoredCount",
  "higherCount",
  "lowerCount",
  "tieCount",
  "brierScore",
  "logLoss",
  "accuracy",
  "meanPHigher",
  "medianPHigher",
  "brierSampleCount",
  "logLossSampleCount",
  "accuracySampleCount",
  "allValidPredictionStats",
  "scoredPredictionStats",
  "calibrationBins",
  "brierDeltas",
  "outcomeOffsetStats",
  "achievedHorizonStats",
  "latency",
  "providerAttemptStatistics",
]);

/**
 * Metric-v2-only report fields, kept in ONE place so the v1 projection is
 * explicit rather than a scattering of special cases. An experiment pinned to
 * metric definition v1 is recomputed with exactly these fields removed, which
 * reproduces its stored v1 `metricsDigest` byte-for-byte.
 */
export const METRIC_V2_ONLY_FIELDS = Object.freeze([
  "allValidPredictionStats",
  "scoredPredictionStats",
  "outcomeOffsetStats",
  "achievedHorizonStats",
]);

/** The per-forecaster denominator fields introduced in metric definition v2. */
export const METRIC_V2_FORECASTER_FIELDS = Object.freeze([
  "brierSampleCount",
  "logLossSampleCount",
  "accuracySampleCount",
]);

/**
 * Natural-log loss with the frozen numerical-safety epsilon. The CLAMPED value
 * is used inside the logarithm only; `entry.p` itself is never modified.
 */
export function logLoss(pairs, epsilon = LOG_LOSS_EPSILON) {
  const valid = (pairs ?? []).filter(
    (entry) => Number.isFinite(entry.p) && (entry.o === 0 || entry.o === 1),
  );
  if (valid.length === 0) return null;
  const sum = valid.reduce((acc, entry) => {
    const p = Math.min(1 - epsilon, Math.max(epsilon, entry.p));
    return acc + -(entry.o * Math.log(p) + (1 - entry.o) * Math.log(1 - p));
  }, 0);
  return sum / valid.length;
}

/** Directional accuracy under the frozen 0.50 decision rule. */
export function accuracy(pairs) {
  const valid = (pairs ?? []).filter((entry) => Number.isFinite(entry.p) && (entry.o === 0 || entry.o === 1));
  if (valid.length === 0) return null;
  const correct = valid.filter((entry) => (entry.p >= 0.5 ? 1 : 0) === entry.o).length;
  return correct / valid.length;
}

/** Deterministic median of a numeric array. */
export function medianOf(values) {
  const list = (values ?? []).filter((value) => Number.isFinite(value)).slice().sort((a, b) => a - b);
  if (list.length === 0) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 === 1 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

/** Nearest-rank percentile (p in 0..100), computed on a sorted copy. */
export function percentileOf(values, percentile) {
  const list = (values ?? []).filter((value) => Number.isFinite(value)).slice().sort((a, b) => a - b);
  if (list.length === 0) return null;
  const rank = Math.max(0, Math.min(100, percentile)) / 100;
  const index = Math.min(list.length - 1, Math.ceil(rank * list.length) - 1);
  return list[Math.max(0, index)];
}

export function meanOf(values) {
  const list = (values ?? []).filter((value) => Number.isFinite(value));
  if (list.length === 0) return null;
  return list.reduce((sum, value) => sum + value, 0) / list.length;
}

/**
 * Generic count/mean/median/p90/p95/max statistics (used for the outcome offset
 * and achieved-horizon timing diagnostics). Nearest-rank quantiles, exactly like
 * `latencyStats`; these are infrastructure timing diagnostics and are NEVER used
 * to optimize a prediction outcome.
 */
export function percentileStats(values) {
  const list = (values ?? []).filter((value) => Number.isFinite(value));
  return {
    count: list.length,
    mean: meanOf(list),
    median: medianOf(list),
    p90: percentileOf(list, 90),
    p95: percentileOf(list, 95),
    max: list.length > 0 ? Math.max(...list) : null,
  };
}

/** mean / median / p90 / p95 / max latency statistics. */
export function latencyStats(values) {
  const list = (values ?? []).filter((value) => Number.isFinite(value));
  return {
    count: list.length,
    meanMs: meanOf(list),
    medianMs: medianOf(list),
    p90Ms: percentileOf(list, 90),
    p95Ms: percentileOf(list, 95),
    maxMs: list.length > 0 ? Math.max(...list) : null,
  };
}

/** min / mean / max descriptive statistics (used for observation spacing and resolution lag). */
export function spreadStats(values) {
  const list = (values ?? []).filter((value) => Number.isFinite(value));
  return {
    count: list.length,
    minMs: list.length > 0 ? Math.min(...list) : null,
    meanMs: meanOf(list),
    maxMs: list.length > 0 ? Math.max(...list) : null,
  };
}

/**
 * METRIC DEFINITION V1 — FROZEN HISTORICAL IDENTITY, byte-preserved so every
 * experiment pinned to metric v1 recomputes its stored `metricsDigest` exactly.
 * It is NEVER edited in place; a change is a NEW version.
 */
export const DIRECTION_METRIC_DEFINITION_V1 = Object.freeze({
  phase: DIRECTION_PHASE,
  definitionVersion: 1,
  target: Object.freeze({ higher: 1, lower: 0, tie: "retained and excluded from binary scoring" }),
  brierFormula: "mean over scored binary pairs of (pHigher - o)^2",
  logLossFormula: "mean over scored binary pairs of -(o*ln(clamp(p)) + (1-o)*ln(1-clamp(p)))",
  logLossEpsilon: LOG_LOSS_EPSILON,
  logLossClampingAppliedToStoredPredictions: false,
  accuracyFormula: "share of scored binary pairs where (pHigher >= 0.5 ? 1 : 0) === o",
  accuracyDecisionRule: ACCURACY_DECISION_RULE,
  calibrationBinCount: CALIBRATION_BIN_COUNT,
  calibrationBinEdges: CALIBRATION_BIN_EDGES,
  calibrationBinsAreAdaptive: false,
  quantileMethod: QUANTILE_METHOD,
  latencyPercentiles: Object.freeze([90, 95]),
  durationFields: Object.freeze([
    "observationCount",
    "validPredictionCount",
    "invalidPredictionCount",
    "failedJevCount",
    "lateJevCount",
    "staleObservationCount",
    "outcomeUnavailableCount",
    "scoredCount",
    "higherCount",
    "lowerCount",
    "tieCount",
    "brierScore",
    "logLoss",
    "accuracy",
    "meanPHigher",
    "medianPHigher",
    "calibrationBins",
    "brierDeltas",
    "latency",
    "providerAttemptStatistics",
  ]),
  profitabilityFieldsIncluded: false,
  automatedWinner: false,
  note:
    "Prediction-quality metrics only. Lower Brier / log loss is better, but NO automated winner is emitted. There is no " +
    "PnL, no Sharpe/Sortino, no trade count, no simulated return and no deployment verdict.",
});

export const DIRECTION_METRIC_DEFINITION_V1_DIGEST = digestOf(DIRECTION_METRIC_DEFINITION_V1);

/**
 * METRIC DEFINITION V2 — the SAME scoring formulas with explicit metric
 * DENOMINATORS (`brierSampleCount` / `logLossSampleCount` /
 * `accuracySampleCount`), an explicit split between all-valid and scored
 * probability statistics, and two infrastructure timing diagnostics (outcome
 * offset + achieved horizon). Every experiment, summary and replay pins this
 * object's digest, so a change to a formula is a NEW metric definition rather
 * than a silent edit.
 */
export const DIRECTION_METRIC_DEFINITION = Object.freeze({
  phase: DIRECTION_PHASE,
  definitionVersion: DIRECTION_METRICS_VERSION,
  target: Object.freeze({ higher: 1, lower: 0, tie: "retained and excluded from binary scoring" }),
  brierFormula: "mean over scored binary pairs of (pHigher - o)^2",
  logLossFormula: "mean over scored binary pairs of -(o*ln(clamp(p)) + (1-o)*ln(1-clamp(p)))",
  logLossEpsilon: LOG_LOSS_EPSILON,
  logLossClampingAppliedToStoredPredictions: false,
  accuracyFormula: "share of scored binary pairs where (pHigher >= 0.5 ? 1 : 0) === o",
  accuracyDecisionRule: ACCURACY_DECISION_RULE,
  sampleDenominators: Object.freeze({
    brierSampleCount: "scored binary pairs used by the Brier mean",
    logLossSampleCount: "scored binary pairs used by the log-loss mean",
    accuracySampleCount: "scored binary pairs used by the accuracy share",
  }),
  probabilityStatsScopes: Object.freeze({
    allValidPredictionStats: "every valid (non-invalid) frozen prediction with a finite pHigher",
    scoredPredictionStats: "only the binary-scorable observations",
  }),
  timingDiagnosticFields: Object.freeze({
    outcomeOffsetStats: "count/mean/median/p90/p95/max of outcomeOffsetMs = outcomeReceivedAt - targetAt",
    achievedHorizonStats:
      "count/mean/median/p90/p95/max of achievedHorizonMs = outcomeReceivedAt - stateObservedAt (the REAL achieved horizon, never a relabelled 30 s)",
  }),
  timingDiagnosticsUsedToOptimizeOutcomes: false,
  calibrationBinCount: CALIBRATION_BIN_COUNT,
  calibrationBinEdges: CALIBRATION_BIN_EDGES,
  calibrationBinsAreAdaptive: false,
  quantileMethod: QUANTILE_METHOD,
  latencyPercentiles: Object.freeze([90, 95]),
  durationFields: Object.freeze([
    "observationCount",
    "validPredictionCount",
    "invalidPredictionCount",
    "failedJevCount",
    "lateJevCount",
    "staleObservationCount",
    "outcomeUnavailableCount",
    "scoredCount",
    "higherCount",
    "lowerCount",
    "tieCount",
    "brierScore",
    "logLoss",
    "accuracy",
    "meanPHigher",
    "medianPHigher",
    "brierSampleCount",
    "logLossSampleCount",
    "accuracySampleCount",
    "allValidPredictionStats",
    "scoredPredictionStats",
    "calibrationBins",
    "brierDeltas",
    "outcomeOffsetStats",
    "achievedHorizonStats",
    "latency",
    "providerAttemptStatistics",
  ]),
  profitabilityFieldsIncluded: false,
  automatedWinner: false,
  note:
    "Prediction-quality metrics only. Lower Brier / log loss is better, but NO automated winner is emitted. There is no " +
    "PnL, no Sharpe/Sortino, no trade count, no simulated return and no deployment verdict.",
});

export const DIRECTION_METRIC_DEFINITION_DIGEST = digestOf(DIRECTION_METRIC_DEFINITION);

/** Version -> frozen metric definition, so an old experiment recomputes under its own version. */
export const DIRECTION_METRIC_DEFINITIONS = Object.freeze({
  1: DIRECTION_METRIC_DEFINITION_V1,
  2: DIRECTION_METRIC_DEFINITION,
});

export const DIRECTION_METRIC_DEFINITION_DIGESTS = Object.freeze({
  1: DIRECTION_METRIC_DEFINITION_V1_DIGEST,
  2: DIRECTION_METRIC_DEFINITION_DIGEST,
});

/** Resolve a frozen metric definition by version; unknown versions resolve to `null` (fail closed). */
export function metricDefinitionForVersion(version) {
  return DIRECTION_METRIC_DEFINITIONS[Number(version)] ?? null;
}

export function metricDefinitionDigestForVersion(version) {
  return DIRECTION_METRIC_DEFINITION_DIGESTS[Number(version)] ?? null;
}

/**
 * The frozen validity rule for a Jev probability pair, kept next to the metrics
 * so "a valid probability" means the same thing everywhere.
 */
export const PROBABILITY_PAIR_TOLERANCE = 1e-9;

export function auditProbabilityPair(pHigher, pLower, tolerance = PROBABILITY_PAIR_TOLERANCE) {
  const problems = [];
  if (!Number.isFinite(pHigher) || pHigher < 0 || pHigher > 1) problems.push("pHigher is not in [0,1]");
  if (!Number.isFinite(pLower) || pLower < 0 || pLower > 1) problems.push("pLower is not in [0,1]");
  if (Number.isFinite(pHigher) && Number.isFinite(pLower) && Math.abs(pHigher + pLower - 1) > tolerance) {
    problems.push("pHigher + pLower is not 1 within tolerance");
  }
  return { ok: problems.length === 0, problems, tolerance };
}

export function probabilityStats(values) {
  const list = (values ?? []).filter((value) => Number.isFinite(value));
  return {
    count: list.length,
    meanPHigher: meanOf(list),
    medianPHigher: medianOf(list),
  };
}

/**
 * Join prediction artifacts with their outcome artifacts (by observationId only).
 * A prediction without an outcome is still returned, so invalid/late/unresolved
 * observations are always visible rather than silently dropped.
 */
export function joinDirectionObservations({ predictions = [], outcomes = [] } = {}) {
  const outcomeById = new Map((outcomes ?? []).filter((entry) => entry?.observationId).map((entry) => [entry.observationId, entry]));
  return (predictions ?? [])
    .filter((prediction) => prediction?.observationId)
    .slice()
    .sort((a, b) => (a.observationIndex ?? 0) - (b.observationIndex ?? 0))
    .map((prediction) => ({ prediction, outcome: outcomeById.get(prediction.observationId) ?? null }));
}

/** True when an observation is eligible for binary scoring, under the frozen rules. */
export function isBinaryScorable({ prediction, outcome }) {
  if (!prediction || prediction.scorable !== true) return false;
  if (!outcome || outcome.scorable !== true) return false;
  if (outcome.tamperDetected === true) return false;
  return outcome.actualOutcome === OUTCOME.HIGHER || outcome.actualOutcome === OUTCOME.LOWER;
}

/**
 * The FROZEN outcome labelling rule (§6): a strict comparison, with the tie
 * RETAINED as its own class. A tie is never folded into HIGHER or LOWER, and no
 * tolerance is applied — the two prices are the venue's own numbers.
 *
 * Exported so the rule has exactly ONE implementation, used by the resolver and
 * tested directly by the validator.
 *
 * @returns {"HIGHER"|"LOWER"|"TIE"|null} `null` when either price is unusable.
 */
export function outcomeLabelOf(currentPrice, futurePrice) {
  if (!Number.isFinite(currentPrice) || !Number.isFinite(futurePrice)) return null;
  if (futurePrice > currentPrice) return OUTCOME.HIGHER;
  if (futurePrice < currentPrice) return OUTCOME.LOWER;
  return OUTCOME.TIE;
}

/** Binary target for one scored observation: HIGHER -> 1, LOWER -> 0. */
export function binaryTargetOf(outcome) {
  if (outcome?.actualOutcome === OUTCOME.HIGHER) return 1;
  if (outcome?.actualOutcome === OUTCOME.LOWER) return 0;
  return null;
}

function pairsForForecaster(joined, probabilityOf) {
  const pairs = [];
  for (const entry of joined) {
    if (!isBinaryScorable(entry)) continue;
    const p = probabilityOf(entry);
    const o = binaryTargetOf(entry.outcome);
    if (!Number.isFinite(p) || o === null) continue;
    pairs.push({ p, o, observationId: entry.prediction.observationId });
  }
  return pairs;
}

/**
 * SAME-STATE FAIRNESS (§30) for a deterministic baseline: a baseline is scored
 * ONLY where it produced a real prediction from the frozen state it shares with
 * Jev. A neutral fallback (missing input / insufficient warmup) is EXCLUDED from
 * that baseline's metrics instead of being scored as a fabricated 0.50 call.
 */
function pairsForBaseline(joined, baselineId) {
  return pairsForForecaster(joined, (entry) => {
    const baseline = entry.prediction.baselines?.[baselineId];
    if (!baseline || baseline.scorableForMetrics !== true) return null;
    if (baseline.stateDigest !== null && entry.prediction.stateDigest !== null && baseline.stateDigest !== entry.prediction.stateDigest) {
      return null;
    }
    return baseline.pHigher;
  });
}

/**
 * Score one forecaster with the primary probability metrics + calibration bins.
 *
 * A probability of exactly 0 or 1 is retained (it is a legitimate model output)
 * but has no finite log loss; `logLossExcludedCount` reports exactly how many
 * such pairs the log-loss number is missing, so the omission is VISIBLE instead
 * of silent.
 */
export function scoreForecaster(pairs) {
  // Every scoring rule below filters to the SAME scored binary pairs (finite p,
  // o in {0,1}); the three denominators are reported EXPLICITLY anyway so a
  // tiny sample can never look more meaningful than it is (N=1 is visible).
  const scoredPairs = (pairs ?? []).filter((entry) => Number.isFinite(entry.p) && (entry.o === 0 || entry.o === 1));
  return {
    sampleCount: pairs.length,
    brierSampleCount: scoredPairs.length,
    logLossSampleCount: scoredPairs.length,
    accuracySampleCount: scoredPairs.length,
    brierScore: brierScore(pairs),
    logLoss: logLoss(pairs),
    logLossEpsilon: LOG_LOSS_EPSILON,
    logLossEpsilonClampedPairs: pairs.filter((entry) => !(entry.p > 0 && entry.p < 1)).length,
    logLossExcludedCount: 0,
    accuracy: accuracy(pairs),
    accuracyDecisionRule: ACCURACY_DECISION_RULE,
    absoluteCalibrationError: absoluteCalibrationError(pairs, CALIBRATION_BIN_COUNT),
    calibrationBins: reliabilityBins(pairs, CALIBRATION_BIN_COUNT),
    calibrationBinEdges: CALIBRATION_BIN_EDGES,
    meanPHigher: meanOf(pairs.map((entry) => entry.p)),
    medianPHigher: medianOf(pairs.map((entry) => entry.p)),
  };
}

function deltaOf(primary, comparator) {
  if (!Number.isFinite(primary) || !Number.isFinite(comparator)) return null;
  return primary - comparator;
}

/**
 * The full 5I metric report. Pure: plain artifacts in, plain numbers out. No
 * network, no provider, no Arena, no trading.
 */
export function evaluateDirectionExperiment({
  experiment = null,
  predictions = [],
  outcomes = [],
  featureStability = null,
  lookaheadAudit = null,
  metricDefinitionVersion = DIRECTION_METRICS_VERSION,
} = {}) {
  const joined = joinDirectionObservations({ predictions, outcomes });

  const jevPairs = pairsForForecaster(joined, (entry) => entry.prediction.pHigher);
  const baselinePairs = {};
  for (const baselineId of BASELINE_IDS) {
    baselinePairs[baselineId] = pairsForBaseline(joined, baselineId);
  }

  const jev = scoreForecaster(jevPairs);
  const baselines = {};
  for (const baselineId of BASELINE_IDS) baselines[baselineId] = scoreForecaster(baselinePairs[baselineId]);

  const invalidReasons = {};
  for (const entry of joined) {
    if (entry.prediction.invalid === true) {
      const reason = typeof entry.prediction.invalidReason === "string" ? entry.prediction.invalidReason : "unknown";
      invalidReasons[reason] = (invalidReasons[reason] ?? 0) + 1;
    }
  }

  const outcomeInvalidReasons = {};
  for (const entry of joined) {
    if (entry.outcome && entry.outcome.scorable !== true) {
      const reason = typeof entry.outcome.invalidReason === "string" ? entry.outcome.invalidReason : "unknown";
      outcomeInvalidReasons[reason] = (outcomeInvalidReasons[reason] ?? 0) + 1;
    }
  }

  const scored = joined.filter(isBinaryScorable);
  const resolved = joined.filter((entry) => entry.outcome !== null);
  const higherCount = resolved.filter((entry) => entry.outcome.actualOutcome === OUTCOME.HIGHER).length;
  const lowerCount = resolved.filter((entry) => entry.outcome.actualOutcome === OUTCOME.LOWER).length;
  const tieCount = resolved.filter((entry) => entry.outcome.actualOutcome === OUTCOME.TIE).length;

  const stateObservedMs = joined
    .map((entry) => Date.parse(entry.prediction.stateObservedAt))
    .filter((value) => Number.isFinite(value));
  const spacingMs = stateObservedMs.slice(1).map((value, index) => value - stateObservedMs[index]);

  const brierDeltas = {};
  for (const baselineId of BASELINE_IDS) {
    brierDeltas[baselineId] = {
      baselineId,
      jevMinusBaselineBrier: deltaOf(jev.brierScore, baselines[baselineId].brierScore),
      jevMinusBaselineLogLoss: deltaOf(jev.logLoss, baselines[baselineId].logLoss),
      jevMinusBaselineAccuracy: deltaOf(jev.accuracy, baselines[baselineId].accuracy),
      baselineBrierScore: baselines[baselineId].brierScore,
      baselineLogLoss: baselines[baselineId].logLoss,
      baselineAccuracy: baselines[baselineId].accuracy,
    };
  }

  const attempts = joined.flatMap((entry) => (Array.isArray(entry.prediction.providerAttempts) ? entry.prediction.providerAttempts : []));

  const report = {
    schemaVersion: DIRECTION_METRICS_VERSION,
    metricDefinitionVersion: DIRECTION_METRICS_VERSION,
    metricDefinitionDigest: DIRECTION_METRIC_DEFINITION_DIGEST,
    phase: DIRECTION_PHASE,
    experimentId: experiment?.experimentId ?? null,
    observationCount: joined.length,
    validPredictionCount: joined.filter((entry) => entry.prediction.invalid !== true).length,
    invalidPredictionCount: joined.filter((entry) => entry.prediction.invalid === true).length,
    failedJevCount: joined.filter((entry) => entry.prediction.status !== "JEV_OK").length,
    lateJevCount: joined.filter((entry) => entry.prediction.invalidReason === "late_prediction").length,
    staleObservationCount: joined.filter((entry) =>
      ["state_receipt_stale", "state_source_stale"].includes(entry.prediction.invalidReason),
    ).length,
    outcomeUnavailableCount: outcomeInvalidReasons.OUTCOME_UNAVAILABLE ?? 0,
    invalidReasons,
    invalidOutcomeReasons: outcomeInvalidReasons,
    outcomeResolvedCount: resolved.length,
    outcomeUnresolvedCount: joined.filter((entry) => entry.outcome === null).length,
    tamperDetectedCount: joined.filter((entry) => entry.outcome?.tamperDetected === true).length,
    scoredCount: scored.length,
    higherCount,
    lowerCount,
    tieCount,
    tiesExcludedFromBinaryScoring: true,
    jev,
    baselines,
    brierDeltas,
    jevMinusNeutralBrierDelta:
      deltaOf(jev.brierScore, baselines["neutral-v1"]?.brierScore ?? null) ?? null,
    warmup: {
      observationsWithCompleteWarmup: joined.filter((entry) => entry.prediction.packet?.warmup?.warmupComplete === true).length,
      observationsWithIncompleteWarmup: joined.filter((entry) => entry.prediction.packet?.warmup?.warmupComplete !== true).length,
      requiredWarmupObservations: experiment?.maxDeclaredWarmup ?? null,
      note:
        "Warmup is declared per feature/baseline and never filled in. A baseline lacking warmup is non-scorable for " +
        "that baseline (see baselines[id].scorableForMetrics), while Jev is still asked the same frozen question.",
    },
    stateStaleness: {
      receiptAgeMs: spreadStats(joined.map((entry) => entry.prediction.stateAge?.receiptAgeAtFreezeMs)),
      sourceAgeMs: spreadStats(joined.map((entry) => entry.prediction.stateAge?.sourceAgeAtFreezeMs)),
      sourceTimestampAvailableCount: joined.filter((entry) => entry.prediction.stateAge?.sourceTimestampAvailable === true).length,
      staleRefusedCount: joined.filter((entry) =>
        ["state_receipt_stale", "state_source_stale"].includes(entry.prediction.invalidReason),
      ).length,
    },
    probabilityStats: {
      scoredBinary: probabilityStats(jevPairs.map((entry) => entry.p)),
      allValidPredictions: probabilityStats(
        joined.filter((entry) => entry.prediction.invalid !== true).map((entry) => entry.prediction.pHigher),
      ),
      baselineNeutral: probabilityStats(baselinePairs["neutral-v1"].map((entry) => entry.p)),
    },
    // §4: the scope of a probability statistic must be EXPLICIT. The all-valid
    // block covers every valid frozen prediction; the scored block covers only
    // the binary-scorable observations. They differ whenever an outcome is
    // excluded, so they are never conflated.
    allValidPredictionStats: probabilityStats(
      joined.filter((entry) => entry.prediction.invalid !== true).map((entry) => entry.prediction.pHigher),
    ),
    scoredPredictionStats: probabilityStats(scored.map((entry) => entry.prediction.pHigher)),
    // §3: infrastructure TIMING diagnostics (never used to optimize outcomes).
    outcomeOffsetStats: percentileStats(
      resolved.map((entry) =>
        Number.isFinite(entry.outcome.outcomeOffsetMs) ? entry.outcome.outcomeOffsetMs : entry.outcome.resolutionLagMs,
      ),
    ),
    achievedHorizonStats: percentileStats(resolved.map((entry) => entry.outcome.achievedHorizonMs)),
    latency: {
      allPredictions: latencyStats(joined.map((entry) => entry.prediction.latencyMs)),
      jevOkOnly: latencyStats(
        joined.filter((entry) => entry.prediction.status === "JEV_OK").map((entry) => entry.prediction.latencyMs),
      ),
      providerAttemptCount: joined.reduce((sum, entry) => sum + (entry.prediction.providerAttemptCount ?? 0), 0),
      observationsWithTransportRetries: joined.filter((entry) => (entry.prediction.providerAttemptCount ?? 0) > 1).length,
      quantileMethod: QUANTILE_METHOD,
    },
    providerAttemptStatistics: {
      logicalPredictions: joined.length,
      physicalAttempts: attempts.length,
      attemptsByStatus: attempts.reduce((acc, attempt) => {
        const status = typeof attempt?.status === "string" ? attempt.status : "UNKNOWN";
        acc[status] = (acc[status] ?? 0) + 1;
        return acc;
      }, {}),
      attemptsByProvider: attempts.reduce((acc, attempt) => {
        const provider = typeof attempt?.provider === "string" ? attempt.provider : "UNKNOWN";
        acc[provider] = (acc[provider] ?? 0) + 1;
        return acc;
      }, {}),
      maxAttemptsOnOnePrediction: joined.reduce((max, entry) => Math.max(max, entry.prediction.providerAttemptCount ?? 0), 0),
      note: "PHYSICAL transport attempts, all belonging to ONE logical prediction on the SAME frozen state.",
    },
    resolutionLag: spreadStats(resolved.map((entry) => entry.outcome.resolutionLagMs)),
    observationSpacing: spreadStats(spacingMs),
    rows: joined.slice(0, 1_000).map((entry) => ({
      observationId: entry.prediction.observationId,
      observationIndex: entry.prediction.observationIndex ?? null,
      stateObservedAt: entry.prediction.stateObservedAt ?? null,
      pHigher: Number.isFinite(entry.prediction.pHigher) ? entry.prediction.pHigher : null,
      pLower: Number.isFinite(entry.prediction.pLower) ? entry.prediction.pLower : null,
      actualOutcome: entry.outcome?.actualOutcome ?? null,
      scorable: isBinaryScorable(entry),
      predictionInvalidReason: entry.prediction.invalidReason ?? null,
      outcomeInvalidReason: entry.outcome?.invalidReason ?? null,
      latencyMs: entry.prediction.latencyMs ?? null,
      resolutionLagMs: entry.outcome?.resolutionLagMs ?? null,
    })),
    // DIAGNOSTICS ONLY (§32): startup-length stability and the offline lookahead
    // audit are reported here, never ranked, and never used to tune anything.
    featureStability,
    lookaheadAudit,
    winner: null,
    noAutomatedWinner: true,
    winnerLabelEmitted: false,
    confidenceThresholdApplied: false,
    profitabilityMetricsIncluded: false,
    executionSimulated: false,
    note:
      "Prediction-quality metrics only. Lower Brier/log loss is better, but NO winner is emitted automatically. " +
      "No PnL, no Sharpe, no simulated returns, no trade count, and no profitability claim of any kind.",
  };
  return projectMetricsToVersion(report, metricDefinitionVersion);
}

/**
 * Project a freshly computed metric report onto a pinned metric-definition
 * version. Metric v2 is a strict SUPERSET of v1 (the v2 additions are new keys
 * only), so a v1 projection is exactly the v1-shaped object and reproduces an
 * experiment pinned to metric v1 byte-for-byte.
 */
export function projectMetricsToVersion(report, version) {
  if (Number(version) === DIRECTION_METRICS_VERSION || Number(version) >= DIRECTION_METRICS_VERSION) return report;
  if (Number(version) !== 1) return report;

  const projected = { ...report };
  for (const field of METRIC_V2_ONLY_FIELDS) delete projected[field];
  const projectForecaster = (block) => {
    if (!block || typeof block !== "object") return block;
    const next = { ...block };
    for (const field of METRIC_V2_FORECASTER_FIELDS) delete next[field];
    return next;
  };
  projected.jev = projectForecaster(report.jev);
  projected.baselines = Object.fromEntries(
    Object.entries(report.baselines ?? {}).map(([id, block]) => [id, projectForecaster(block)]),
  );
  projected.schemaVersion = 1;
  projected.metricDefinitionVersion = 1;
  projected.metricDefinitionDigest = DIRECTION_METRIC_DEFINITION_V1_DIGEST;
  return projected;
}

/** Digest of a metrics report — replay recomputes the report and compares digests. */
export function metricsDigestOf(metrics) {
  return digestOf(metrics ?? null);
}

/**
 * Fields a 5I summary must NEVER contain. Validators assert their absence, which
 * is how "no profitability inference" is enforced structurally rather than by
 * convention.
 */
export const FORBIDDEN_METRIC_FIELDS = Object.freeze([
  "pnl",
  "profit",
  "profitability",
  "sharpe",
  "sharpeRatio",
  "sortino",
  "returns",
  "simulatedReturn",
  "netReturn",
  "expectedReturn",
  "tradeCount",
  "trades",
  "positionSize",
  "deploymentVerdict",
  "deploymentEligible",
  "winnerLabel",
]);

/**
 * Recursively assert a metric report contains none of the fields above. Used by
 * the summary writer path AND the validator, so "no profitability inference" is
 * structural rather than a matter of convention.
 */
export function auditNoProfitabilityFields(report) {
  const problems = [];
  const seen = new WeakSet();
  const walk = (value, pathLabel) => {
    if (value === null || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_METRIC_FIELDS.includes(key)) problems.push(`${pathLabel}.${key}`);
      walk(entry, `${pathLabel}.${key}`);
    }
  };
  walk(report ?? null, "report");
  return { ok: problems.length === 0, problems };
}
