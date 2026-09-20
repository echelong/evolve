/**
 * EVOLVE Phase 5I.1a — TEMPORAL-EXTENSION AGGREGATION AND THE COMBINED VIEW.
 *
 * THE PRIMARY INFERENCE UNIT IS THE SESSION. Three 120-observation sessions are
 * three independent datasets, not one 360-observation experiment: they are never
 * concatenated, and an observation is never treated as an independent replicate.
 * Every cross-session figure is EQUAL-WEIGHTED BY ELIGIBLE SESSION.
 *
 * The uncertainty methodology is RE-USED VERBATIM from Phase 5I.1: the same fixed
 * seed, the same 2,000 session-level resamples, the same deterministic PRNG, the
 * same descriptive-percentile-interval semantics. No p-value, no significance
 * label, no winner, no profitability inference.
 *
 * The COMBINED VIEW stacks the canonical 3 CLEAN replication sessions and the 3
 * CLEAN temporal-extension sessions into a six-session DESCRIPTIVE view. It never
 * re-derives, re-scores or re-writes the canonical result: the canonical numbers
 * are read from the canonical summary (or the pinned barrier when absent), and the
 * canonical 3-session result remains immutable and independently reproducible.
 *
 * PAPER ONLY / NO TRADING. No wallet, no signing, no swap, no order, no Arena
 * routing, no DeepSeek routing, no external-agent routing of any kind, and no
 * confidence threshold.
 */

import {
  REPLICATION_BOOTSTRAP_ALPHA,
  REPLICATION_BOOTSTRAP_PRNG,
  REPLICATION_BOOTSTRAP_RESAMPLES,
  REPLICATION_BOOTSTRAP_SEED,
  REPLICATION_BOOTSTRAP_STATE,
  aggregateComparison,
  bootstrapSessionMean,
  stableSessionStats,
} from "../replication/aggregate.mjs";
import { REPLICATION_COMPARISON_IDS } from "../replication/protocol.mjs";
import {
  CANONICAL_REPLICATION_BARRIER,
  REQUIRED_CLEAN_TEMPORAL_SESSIONS,
  TEMPORAL_DELTA_SIGN_CONVENTION,
} from "./protocol.mjs";

export const TEMPORAL_AGGREGATE_VERSION = 1;

/** The explicit insufficient-sample state for the temporal extension. */
export const TEMPORAL_INSUFFICIENT_STATE = "INSUFFICIENT_CLEAN_TEMPORAL_SESSIONS";
/** The state once the designed number of CLEAN temporal sessions exists. */
export const TEMPORAL_COMPLETE_STATE = "CLEAN_TEMPORAL_SESSIONS_COMPLETE";
/** The same descriptive-only bootstrap label Phase 5I.1 uses. */
export const TEMPORAL_BOOTSTRAP_STATE = REPLICATION_BOOTSTRAP_STATE;

/* ============================================================================
 * §13 per-comparison aggregation (identical shape and semantics to Phase 5I.1)
 * ==========================================================================*/

/**
 * Aggregate every frozen comparison and every absolute Jev metric across the
 * CLEAN temporal sessions, equal-weighted by session.
 *
 * @param {object[]} sessions temporal session records
 * @param {{ status?: string, excludedSessions?: object[], requiredCleanSessions?: number }} [context]
 */
export function aggregateTemporalSessions(
  sessions = [],
  { status = null, excludedSessions = [], requiredCleanSessions = REQUIRED_CLEAN_TEMPORAL_SESSIONS } = {},
) {
  const clean = (sessions ?? []).filter((entry) => entry?.status === "CLEAN");
  const cleanSessionIds = clean.map((entry) => entry.sessionId);

  const comparisons = {};
  for (const comparisonId of REPLICATION_COMPARISON_IDS) {
    comparisons[comparisonId] = {
      comparisonId,
      brier: aggregateComparison(
        clean.map((session) => ({ sessionId: session.sessionId, value: session.metrics?.deltas?.[comparisonId]?.brier ?? null })),
        { lowerIsBetter: true },
      ),
      logLoss: aggregateComparison(
        clean.map((session) => ({ sessionId: session.sessionId, value: session.metrics?.deltas?.[comparisonId]?.logLoss ?? null })),
        { lowerIsBetter: true },
      ),
      accuracy: aggregateComparison(
        clean.map((session) => ({ sessionId: session.sessionId, value: session.metrics?.deltas?.[comparisonId]?.accuracy ?? null })),
        { lowerIsBetter: false },
      ),
    };
  }

  const absolute = {
    brier: stableSessionStats(clean.map((session) => ({ sessionId: session.sessionId, value: session.metrics?.jev?.brier ?? null }))),
    logLoss: stableSessionStats(clean.map((session) => ({ sessionId: session.sessionId, value: session.metrics?.jev?.logLoss ?? null }))),
    accuracy: stableSessionStats(clean.map((session) => ({ sessionId: session.sessionId, value: session.metrics?.jev?.accuracy ?? null }))),
  };

  const bootstrapAvailable = clean.length >= requiredCleanSessions;
  const bootstrapState = bootstrapAvailable ? TEMPORAL_BOOTSTRAP_STATE : TEMPORAL_INSUFFICIENT_STATE;
  const bootstrap = {
    status: bootstrapAvailable ? TEMPORAL_COMPLETE_STATE : TEMPORAL_INSUFFICIENT_STATE,
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
    aggregateVersion: TEMPORAL_AGGREGATE_VERSION,
    status: status ?? (clean.length >= requiredCleanSessions ? TEMPORAL_COMPLETE_STATE : TEMPORAL_INSUFFICIENT_STATE),
    primaryInferenceUnit: "dataset/session",
    unitOfReplication: "session",
    equalWeightedByEligibleSession: true,
    equalWeightPerCleanSession: true,
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
    deltaSignConvention: { ...TEMPORAL_DELTA_SIGN_CONVENTION },
    comparisons,
    absolute,
    bootstrap,
    bootstrapState,
    winner: null,
    noAutomatedWinner: true,
    noNewWinnerField: true,
    significanceClaimed: false,
    profitabilityInference: false,
    tradingInference: false,
    deploymentInference: false,
    automaticPromotionToPhase5I2: false,
  };
}

/* ============================================================================
 * §13/§14 the COMBINED DESCRIPTIVE VIEW (canonical 3 + temporal 3 = 6)
 * ==========================================================================*/

/**
 * Project the CLEAN per-session values out of a stored Phase 5I.1 / 5I.1a
 * summary-shaped bundle. Returns `null` when the summary carries no per-session
 * detail (the pinned-barrier fallback path).
 */
function projectCleanSessionValues(summary) {
  const perSession = Array.isArray(summary?.perSession) ? summary.perSession : null;
  if (perSession === null) return null;
  const clean = perSession.filter((entry) => entry?.status === "CLEAN");
  const comparisons = {};
  for (const comparisonId of REPLICATION_COMPARISON_IDS) {
    comparisons[comparisonId] = {
      brier: clean.map((entry) => ({ sessionId: entry.sessionId, value: entry.deltas?.[comparisonId]?.brier ?? null })),
      logLoss: clean.map((entry) => ({ sessionId: entry.sessionId, value: entry.deltas?.[comparisonId]?.logLoss ?? null })),
      accuracy: clean.map((entry) => ({ sessionId: entry.sessionId, value: entry.deltas?.[comparisonId]?.accuracy ?? null })),
    };
  }
  return {
    cleanSessionIds: clean.map((entry) => entry.sessionId),
    comparisons,
    absolute: {
      brier: clean.map((entry) => ({ sessionId: entry.sessionId, value: entry.jev?.brier ?? null })),
      logLoss: clean.map((entry) => ({ sessionId: entry.sessionId, value: entry.jev?.logLoss ?? null })),
      accuracy: clean.map((entry) => ({ sessionId: entry.sessionId, value: entry.jev?.accuracy ?? null })),
    },
  };
}

function comparisonBlockFromValueSets(sets) {
  const comparisons = {};
  for (const comparisonId of REPLICATION_COMPARISON_IDS) {
    comparisons[comparisonId] = {
      comparisonId,
      brier: aggregateComparison(
        sets.flatMap((set) => set.comparisons[comparisonId].brier),
        { lowerIsBetter: true },
      ),
      logLoss: aggregateComparison(
        sets.flatMap((set) => set.comparisons[comparisonId].logLoss),
        { lowerIsBetter: true },
      ),
      accuracy: aggregateComparison(
        sets.flatMap((set) => set.comparisons[comparisonId].accuracy),
        { lowerIsBetter: false },
      ),
    };
  }
  const absolute = {
    brier: stableSessionStats(sets.flatMap((set) => set.absolute.brier)),
    logLoss: stableSessionStats(sets.flatMap((set) => set.absolute.logLoss)),
    accuracy: stableSessionStats(sets.flatMap((set) => set.absolute.accuracy)),
  };
  const bootstrap = { comparisons: {}, absolute: {} };
  for (const comparisonId of REPLICATION_COMPARISON_IDS) {
    for (const metric of ["brier", "logLoss", "accuracy"]) {
      bootstrap.comparisons[`${comparisonId}.${metric}`] = bootstrapSessionMean(comparisons[comparisonId][metric].values);
    }
  }
  for (const metric of ["brier", "logLoss", "accuracy"]) {
    bootstrap.absolute[metric] = bootstrapSessionMean(absolute[metric].values);
  }
  return { comparisons, absolute, bootstrap };
}

/**
 * Build the combined descriptive view. The canonical result is READ, never
 * recomputed: when its artifacts are absent the view reports it as unavailable and
 * falls back to the source-pinned canonical count/digests, so the canonical
 * 3-session result is never re-derived from anything.
 *
 * @param {{
 *   canonicalSummary?: object|null,
 *   canonicalBundlePresent?: boolean,
 *   temporalSummary?: object|null,
 * }} input
 */
export function buildCombinedDescriptiveView({
  canonicalSummary = null,
  canonicalBundlePresent = false,
  temporalSummary = null,
} = {}) {
  const canonicalValues = projectCleanSessionValues(canonicalSummary);
  const temporalValues = projectCleanSessionValues(temporalSummary);
  const canonicalCount = canonicalValues?.cleanSessionIds.length ?? CANONICAL_REPLICATION_BARRIER.cleanSessionCount;
  const temporalCount = temporalValues?.cleanSessionIds.length ?? 0;

  const canonicalBlock = {
    role: "canonical-replication",
    available: canonicalValues !== null,
    artifactsPresent: canonicalBundlePresent === true,
    cleanSessionCount: canonicalCount,
    cleanSessionIds:
      canonicalValues?.cleanSessionIds ?? [...CANONICAL_REPLICATION_BARRIER.cleanSessionIds],
    requiredCleanSessions: CANONICAL_REPLICATION_BARRIER.requiredCleanSessions,
    aggregateMetricsDigest: CANONICAL_REPLICATION_BARRIER.aggregateMetricsDigest,
    sessionRecordsDigest: CANONICAL_REPLICATION_BARRIER.sessionRecordsDigest,
    manifestContentDigest: CANONICAL_REPLICATION_BARRIER.manifestContentDigest,
    protocolDigest: CANONICAL_REPLICATION_BARRIER.protocolDigest,
    status: canonicalSummary?.status ?? CANONICAL_REPLICATION_BARRIER.status,
    immutable: true,
    independentlyReproducible: true,
    comparisons: canonicalValues?.comparisons ?? null,
    absolute: canonicalValues?.absolute ?? null,
  };

  const temporalBlock = {
    role: "temporal-extension",
    available: temporalValues !== null,
    artifactsPresent: temporalSummary !== null,
    cleanSessionCount: temporalCount,
    cleanSessionIds: temporalValues?.cleanSessionIds ?? [],
    requiredCleanSessions: REQUIRED_CLEAN_TEMPORAL_SESSIONS,
    status: temporalSummary?.status ?? TEMPORAL_INSUFFICIENT_STATE,
    comparisons: temporalValues?.comparisons ?? null,
    absolute: temporalValues?.absolute ?? null,
  };

  let combined = null;
  if (canonicalValues !== null && temporalValues !== null) {
    const sets = [canonicalValues, temporalValues];
    const { comparisons, absolute, bootstrap } = comparisonBlockFromValueSets(sets);
    combined = {
      cleanSessionCount: canonicalValues.cleanSessionIds.length + temporalValues.cleanSessionIds.length,
      cleanSessionIds: [...canonicalValues.cleanSessionIds, ...temporalValues.cleanSessionIds],
      comparisons,
      absolute,
      bootstrap,
      deltaSignConvention: { ...TEMPORAL_DELTA_SIGN_CONVENTION },
    };
  }

  return {
    viewVersion: 1,
    primaryInferenceUnit: "dataset/session",
    equalWeightPerCleanSession: true,
    noObservationLevelPseudoReplication: true,
    observationsNeverPooled: true,
    canonicalSessionCount: canonicalCount,
    temporalSessionCount: temporalCount,
    totalObservedCleanSessions: canonicalCount + temporalCount,
    canonical: canonicalBlock,
    temporal: temporalBlock,
    combined,
    combinedBootstrapState:
      combined === null ? TEMPORAL_INSUFFICIENT_STATE : TEMPORAL_BOOTSTRAP_STATE,
    canonicalResultImmutable: true,
    canonicalResultIndependentlyReproducible: true,
    canonicalReportedSeparately: true,
    winner: null,
    noAutomatedWinner: true,
    noNewWinnerField: true,
    significanceClaimed: false,
    profitabilityInference: false,
    tradingInference: false,
    deploymentInference: false,
    automaticPromotionToPhase5I2: false,
    note:
      "Descriptive combined view across the canonical Phase 5I.1 CLEAN sessions and the Phase 5I.1a temporal-extension CLEAN " +
      "sessions. Sessions are the unit; observations are never pooled into an N=360 sample. The canonical 3-session result is " +
      "READ, not recomputed, and remains immutable and independently reproducible. No winner, no significance, no profitability.",
  };
}
