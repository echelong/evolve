/**
 * Phase 5I.1 — CROSS-SESSION AGGREGATION (§13) AND UNCERTAINTY (§14).
 *
 * THE PRIMARY INFERENCE UNIT IS THE SESSION. Three 120-observation sessions are
 * three independent datasets, not one 360-observation experiment: they are never
 * concatenated, and an observation is never treated as an independent replicate.
 * Every cross-session figure is EQUAL-WEIGHTED BY ELIGIBLE SESSION.
 *
 * A 120-observation session is therefore never weighted more heavily merely
 * because it happens to have slightly more scorable observations, and a session
 * whose comparison value is undefined (`null`) is EXCLUDED from that comparison
 * and counted — never silently scored as zero.
 *
 * §14 UNCERTAINTY: once at least `REQUIRED_CLEAN_REPLICATION_SESSIONS` CLEAN
 * sessions exist, a deterministic session-level bootstrap may be reported. It
 * resamples SESSIONS, never observations; it uses a fixed seed and a fixed
 * deterministic PRNG; its interval is descriptive only; and it produces NO
 * p-value, NO significance label, and NO "statistically proven" language.
 *
 * PAPER ONLY / NO TRADING. No wallet, no signing, no swap, no order, no Arena
 * routing, no DeepSeek routing, no external-agent routing of any kind, and no
 * confidence threshold.
 */

import { medianOf, percentileOf } from "../metrics.mjs";
import { REPLICATION_COMPARISON_IDS, REPLICATION_DELTA_SIGN_CONVENTION } from "./protocol.mjs";

export const REPLICATION_AGGREGATE_VERSION = 1;

/** The explicit insufficient-sample state (§14). */
export const REPLICATION_INSUFFICIENT_STATE = "INSUFFICIENT_CLEAN_REPLICATION_SESSIONS";
/** The state once the designed number of CLEAN sessions exists. */
export const REPLICATION_COMPLETE_STATE = "CLEAN_REPLICATION_SESSIONS_COMPLETE";

/**
 * The explicit, FROZEN label for the descriptive session-resampled bootstrap
 * reported once `REQUIRED_CLEAN_REPLICATION_SESSIONS` CLEAN sessions exist (§14).
 *
 * It is descriptive ONLY: session-resampled, no p-value, no significance claim,
 * no winner and no profitability inference. The label is a REPORTING state, never
 * a metric, and it is deliberately kept OUT of the aggregate evidence digest, so
 * naming the state can never change a stored aggregation's digest.
 */
export const REPLICATION_BOOTSTRAP_STATE = "DESCRIPTIVE_SESSION_BOOTSTRAP";

/* ============================================================================
 * §14 deterministic PRNG + bootstrap
 * ==========================================================================*/

/** Fixed seed. Fixed resample count. Neither is ever chosen from the data. */
export const REPLICATION_BOOTSTRAP_SEED = 20260920;
export const REPLICATION_BOOTSTRAP_RESAMPLES = 2_000;
export const REPLICATION_BOOTSTRAP_ALPHA = 0.05;
export const REPLICATION_BOOTSTRAP_METHOD = "session-level percentile bootstrap (resamples sessions, never observations)";
export const REPLICATION_BOOTSTRAP_PRNG = "mulberry32";

/**
 * Deterministic 32-bit PRNG. Pure function of the seed: the same sessions and
 * the same seed always produce byte-identical intervals.
 */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Resample the SESSIONS with replacement and report a descriptive percentile
 * interval on the resampled mean. No p-value, no significance label.
 *
 * @param {number[]} values one value per CLEAN session
 * @param {{ seed?: number, resamples?: number, alpha?: number }} [options]
 */
export function bootstrapSessionMean(values, { seed = REPLICATION_BOOTSTRAP_SEED, resamples = REPLICATION_BOOTSTRAP_RESAMPLES, alpha = REPLICATION_BOOTSTRAP_ALPHA } = {}) {
  const list = (values ?? []).filter((value) => Number.isFinite(value));
  if (list.length === 0) {
    return {
      available: false,
      reason: REPLICATION_INSUFFICIENT_STATE,
      sessionCount: 0,
      values: [],
    };
  }
  const random = mulberry32(seed);
  const means = [];
  for (let draw = 0; draw < resamples; draw += 1) {
    let sum = 0;
    for (let index = 0; index < list.length; index += 1) {
      sum += list[Math.min(list.length - 1, Math.floor(random() * list.length))];
    }
    means.push(sum / list.length);
  }
  const lowerPercentile = (alpha / 2) * 100;
  const upperPercentile = (1 - alpha / 2) * 100;
  return {
    available: true,
    method: REPLICATION_BOOTSTRAP_METHOD,
    prng: REPLICATION_BOOTSTRAP_PRNG,
    seed,
    resamples,
    alpha,
    sessionCount: list.length,
    values: list,
    pointEstimate: list.reduce((sum, value) => sum + value, 0) / list.length,
    lower: percentileOf(means, lowerPercentile),
    upper: percentileOf(means, upperPercentile),
    intervalKind: "descriptive percentile interval over resampled session means",
    pValue: null,
    significanceLabel: null,
    statisticallyProven: false,
    descriptiveOnly: true,
    interpretation:
      "Descriptive only. This interval describes the spread of the resampled session mean across these sessions; it is " +
      "not a significance test and it establishes nothing about future behaviour.",
  };
}

/* ============================================================================
 * §13 per-comparison aggregation
 * ==========================================================================*/

/**
 * Count/mean/median/min/max plus positive/negative/zero counts for one session
 * level series. `null` entries are excluded and counted, never coerced.
 */
export function stableSessionStats(entries = []) {
  const usable = (entries ?? []).filter((entry) => entry !== null && entry !== undefined && Number.isFinite(entry.value));
  const values = usable.map((entry) => entry.value);
  return {
    sessionCount: values.length,
    values,
    sessionIds: usable.map((entry) => entry.sessionId),
    excludedSessionCount: (entries ?? []).length - values.length,
    mean: values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length,
    median: medianOf(values),
    min: values.length === 0 ? null : Math.min(...values),
    max: values.length === 0 ? null : Math.max(...values),
    positiveCount: values.filter((value) => value > 0).length,
    negativeCount: values.filter((value) => value < 0).length,
    zeroCount: values.filter((value) => value === 0).length,
  };
}

/**
 * Aggregate ONE comparison over sessions.
 *
 * `lowerIsBetter` is true for Brier and log loss, where a NEGATIVE delta means
 * Jev is LOWER (better). For those two metrics the report also carries the exact
 * better/worse/equal counts, so the sign convention can never quietly invert.
 * Accuracy is NOT scored with a better/worse label.
 */
export function aggregateComparison(entries = [], { lowerIsBetter = true } = {}) {
  const stats = stableSessionStats(entries);
  const base = {
    ...stats,
    lowerIsBetter: lowerIsBetter === true,
    signConvention: lowerIsBetter === true ? "negative delta = Jev LOWER (better)" : "positive delta = Jev HIGHER (better)",
  };
  if (lowerIsBetter !== true) {
    return { ...base, jevBetterCount: null, baselineBetterCount: null, equalCount: stats.zeroCount };
  }
  return {
    ...base,
    jevBetterCount: stats.negativeCount,
    baselineBetterCount: stats.positiveCount,
    equalCount: stats.zeroCount,
  };
}

/**
 * Aggregate every frozen comparison and every absolute Jev metric across the
 * CLEAN sessions, equal-weighted by session.
 *
 * @param {object[]} sessions eligible (CLEAN) session records
 * @param {{ status?: string, excludedSessions?: object[] }} [context]
 */
export function aggregateReplicationSessions(sessions = [], { status = null, excludedSessions = [], requiredCleanSessions = 3 } = {}) {
  const clean = (sessions ?? []).filter((entry) => entry?.status === "CLEAN");
  const cleanSessionIds = clean.map((entry) => entry.sessionId);

  const comparisons = {};
  for (const comparisonId of REPLICATION_COMPARISON_IDS) {
    const brier = clean.map((session) => ({
      sessionId: session.sessionId,
      value: session.metrics?.deltas?.[comparisonId]?.brier ?? null,
    }));
    const logLoss = clean.map((session) => ({
      sessionId: session.sessionId,
      value: session.metrics?.deltas?.[comparisonId]?.logLoss ?? null,
    }));
    const accuracy = clean.map((session) => ({
      sessionId: session.sessionId,
      value: session.metrics?.deltas?.[comparisonId]?.accuracy ?? null,
    }));
    comparisons[comparisonId] = {
      comparisonId,
      brier: aggregateComparison(brier, { lowerIsBetter: true }),
      logLoss: aggregateComparison(logLoss, { lowerIsBetter: true }),
      accuracy: aggregateComparison(accuracy, { lowerIsBetter: false }),
    };
  }

  const absolute = {
    brier: stableSessionStats(clean.map((session) => ({ sessionId: session.sessionId, value: session.metrics?.jev?.brier ?? null }))),
    logLoss: stableSessionStats(clean.map((session) => ({ sessionId: session.sessionId, value: session.metrics?.jev?.logLoss ?? null }))),
    accuracy: stableSessionStats(clean.map((session) => ({ sessionId: session.sessionId, value: session.metrics?.jev?.accuracy ?? null }))),
  };

  const bootstrapAvailable = clean.length >= requiredCleanSessions;
  const bootstrapState = bootstrapAvailable ? REPLICATION_BOOTSTRAP_STATE : REPLICATION_INSUFFICIENT_STATE;
  const bootstrap = {
    status: bootstrapAvailable ? REPLICATION_COMPLETE_STATE : REPLICATION_INSUFFICIENT_STATE,
    available: bootstrapAvailable,
    requiredCleanSessions,
    cleanSessionCount: clean.length,
    seed: REPLICATION_BOOTSTRAP_SEED,
    resamples: REPLICATION_BOOTSTRAP_RESAMPLES,
    alpha: REPLICATION_BOOTSTRAP_ALPHA,
    prng: REPLICATION_BOOTSTRAP_PRNG,
    pValueEmitted: false,
    significanceLabelEmitted: false,
    comparisons: {},
    absolute: {},
  };
  if (bootstrapAvailable) {
    for (const comparisonId of REPLICATION_COMPARISON_IDS) {
      for (const metric of ["brier", "logLoss", "accuracy"]) {
        bootstrap.comparisons[`${comparisonId}.${metric}`] = bootstrapSessionMean(comparisons[comparisonId][metric].values);
      }
    }
    for (const metric of ["brier", "logLoss", "accuracy"]) {
      bootstrap.absolute[metric] = bootstrapSessionMean(absolute[metric].values);
    }
  }

  return {
    aggregateVersion: REPLICATION_AGGREGATE_VERSION,
    status: status ?? (clean.length >= requiredCleanSessions ? REPLICATION_COMPLETE_STATE : REPLICATION_INSUFFICIENT_STATE),
    primaryInferenceUnit: "dataset/session",
    unitOfReplication: "session",
    equalWeightedByEligibleSession: true,
    observationLevelPseudoReplication: false,
    observationsConcatenated: false,
    cleanSessionCount: clean.length,
    cleanSessionIds,
    requiredCleanSessions,
    totalSessionCount: (sessions ?? []).length,
    excludedSessions: excludedSessions.map((entry) => ({
      sessionId: entry.sessionId,
      status: entry.status,
      reasons: entry.reasons ?? [],
    })),
    deltaSignConvention: { ...REPLICATION_DELTA_SIGN_CONVENTION },
    comparisons,
    absolute,
    bootstrap,
    bootstrapState,
    winner: null,
    noAutomatedWinner: true,
    significanceClaimed: false,
    profitabilityInference: false,
    tradingInference: false,
    deploymentInference: false,
  };
}
