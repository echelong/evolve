/**
 * Phase 5I-PS.2 — descriptive counters, live state and finalized summary.
 *
 * These are DESCRIPTIVE counts and means only. There is deliberately:
 *
 *   - no winner,
 *   - no supervisor score / ranking,
 *   - no profitability claim of any kind,
 *   - no automatic policy recommendation,
 *   - and no future-outcome / forward-return scoring (that is deliberately
 *     NOT part of PS.2; it belongs to a separate offline analyzer later).
 *
 * PAPER ONLY / DEVELOPMENT EVIDENCE ONLY.
 */

import { supervisorSummaryDigestOf } from "./storage.mjs";
import {
  SUPERVISOR_CLASSIFICATION,
  SUPERVISOR_FEATURE_DEFINITION_DIGEST,
  SUPERVISOR_FEATURE_DEFINITION_VERSION,
  SUPERVISOR_FORBIDDEN_RESULT_KEYS,
  SUPERVISOR_ISOLATION_STATEMENT,
  SUPERVISOR_KIND,
  SUPERVISOR_LABEL,
  SUPERVISOR_MARKET,
  SUPERVISOR_MODE,
  SUPERVISOR_NO_AUTHORITY_TAG,
  SUPERVISOR_PHASE,
  SUPERVISOR_QUEUE_CAPACITY,
  SUPERVISOR_QUESTION_SET_ID,
  SUPERVISOR_QUESTION_SET_VERSION,
  SUPERVISOR_SCHEMA_VERSION,
  SUPERVISOR_STATEMENT,
} from "./definition.mjs";

export const SUPERVISOR_SUMMARY_VERSION = 1;

/** Fresh counter block. Every counter is a plain integer count. */
export function createSupervisorCounters() {
  return {
    proposalsObserved: 0,
    supportedProposals: 0,
    unsupportedProposals: 0,
    unsupportedProposalCount: 0, // explicit alias of `unsupportedProposals`
    marketStateUnavailableProposals: 0,
    directionallyComparable: 0,
    notDirectionallyComparable: 0,
    jevCalls: 0,
    jevOk: 0,
    jevFailures: 0,
    agreementCount: 0,
    disagreementCount: 0,
    exactHalfCount: 0,
    entryComparableCount: 0,
    signalExitComparableCount: 0,
    stopObservations: 0,
    takeObservations: 0,
    timeObservations: 0,
    otherLifecycleExitObservations: 0,
    observerFailures: 0,
    queueDropped: 0,
  };
}

/** Fresh aggregate block (running sums; means are derived, never thresholds). */
export function createSupervisorAggregates() {
  return {
    pHigherSum: 0,
    pHigherCount: 0,
    distanceSum: 0,
    distanceCount: 0,
    latencySumMs: 0,
    latencyCount: 0,
    providerStatusCounts: {},
  };
}

function finite(value, fallback = null) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

/** Observe one valid Jev probability into the aggregate block. */
export function observeProbability(aggregates, pHigher) {
  if (!Number.isFinite(pHigher)) return aggregates;
  aggregates.pHigherSum += pHigher;
  aggregates.pHigherCount += 1;
  const distance = Math.abs(pHigher - 0.5);
  aggregates.distanceSum += distance;
  aggregates.distanceCount += 1;
  return aggregates;
}

/** Observe one provider-call latency (failures included — they are real calls). */
export function observeLatency(aggregates, latencyMs) {
  if (!Number.isFinite(latencyMs) || latencyMs < 0) return aggregates;
  aggregates.latencySumMs += latencyMs;
  aggregates.latencyCount += 1;
  return aggregates;
}

export function observeProviderStatus(aggregates, status) {
  const label = typeof status === "string" && status.length > 0 ? status : "JEV_NO_STATUS";
  aggregates.providerStatusCounts[label] = (aggregates.providerStatusCounts[label] ?? 0) + 1;
  return aggregates;
}

export function meansOf(aggregates) {
  return {
    meanPHigher: aggregates.pHigherCount > 0 ? round(aggregates.pHigherSum / aggregates.pHigherCount) : null,
    meanDistanceFromHalf:
      aggregates.distanceCount > 0 ? round(aggregates.distanceSum / aggregates.distanceCount) : null,
    meanLatencyMs: aggregates.latencyCount > 0 ? round(aggregates.latencySumMs / aggregates.latencyCount, 3) : null,
  };
}

/** Compact one dashboard row from a persisted judgment. */
export function compactSupervisorRow(judgment) {
  return {
    at: judgment?.observerCompletedAt ?? judgment?.observerStartedAt ?? judgment?.proposal?.timestamp ?? null,
    agentId: judgment?.proposal?.agentId ?? null,
    species: judgment?.proposal?.species ?? null,
    action: judgment?.proposal?.action ?? null,
    reason: judgment?.proposal?.reason ?? null,
    mint: judgment?.proposal?.market?.mint ?? null,
    symbol: judgment?.proposal?.market?.symbol ?? null,
    referencePrice: finite(judgment?.proposal?.market?.referencePrice),
    evolveDirectionalIntent: judgment?.proposal?.evolveDirectionalIntent ?? null,
    directionalComparable: judgment?.proposal?.directionalComparable === true,
    pHigher: finite(judgment?.pHigher),
    pLower: finite(judgment?.pLower),
    modelIntent: judgment?.modelIntent ?? null,
    agreement: judgment?.agreement ?? null,
    exactHalf: judgment?.exactlyHalf === true,
    providerStatus: judgment?.providerStatus ?? null,
    supported: judgment?.supported === true,
    executed: judgment?.evolveExecution?.executed === true,
    blocked: judgment?.evolveExecution?.blocked === true,
  };
}

/** The shared header every supervisor artifact carries. */
export function supervisorHeader({ sessionId, status = "RUNNING", updatedAt = null, lastProposalAt = null, lastJudgmentAt = null } = {}) {
  return {
    schemaVersion: SUPERVISOR_SCHEMA_VERSION,
    phase: SUPERVISOR_PHASE,
    kind: SUPERVISOR_KIND,
    sessionId,
    ...SUPERVISOR_CLASSIFICATION,
    label: SUPERVISOR_LABEL,
    noAuthorityTag: SUPERVISOR_NO_AUTHORITY_TAG,
    statement: SUPERVISOR_STATEMENT,
    isolationStatement: SUPERVISOR_ISOLATION_STATEMENT,
    status,
    market: {
      marketId: SUPERVISOR_MARKET.marketId,
      displayName: SUPERVISOR_MARKET.displayName,
      baseSymbol: SUPERVISOR_MARKET.baseSymbol,
      quoteSymbol: SUPERVISOR_MARKET.quoteSymbol,
      baseMint: SUPERVISOR_MARKET.baseMint,
      quoteMint: SUPERVISOR_MARKET.quoteMint,
    },
    provider: null,
    model: null,
    upstream: null,
    gatewayUsed: false,
    mode: SUPERVISOR_MODE,
    cacheEnabled: false,
    questionSetId: SUPERVISOR_QUESTION_SET_ID,
    questionSetVersion: SUPERVISOR_QUESTION_SET_VERSION,
    questionDigest: null,
    featureDefinitionVersion: SUPERVISOR_FEATURE_DEFINITION_VERSION,
    featureDefinitionDigest: SUPERVISOR_FEATURE_DEFINITION_DIGEST,
    updatedAt,
    lastProposalAt,
    lastJudgmentAt,
  };
}

/** Live `state.json` — the compact document the dashboard reads. */
export function buildSupervisorState({
  session,
  counters,
  aggregates,
  queue,
  status = "RUNNING",
  recentRows = [],
  droppedRecords = [],
  lastProposalAt = null,
  lastJudgmentAt = null,
  updatedAt = null,
  lastObserverError = null,
} = {}) {
  return {
    ...supervisorHeader({
      sessionId: session?.sessionId ?? null,
      status,
      updatedAt,
      lastProposalAt,
      lastJudgmentAt,
    }),
    provider: session?.provider ?? null,
    model: session?.model ?? null,
    upstream: session?.upstream ?? null,
    gatewayUsed: false,
    mode: SUPERVISOR_MODE,
    cacheEnabled: false,
    questionSetId: SUPERVISOR_QUESTION_SET_ID,
    questionSetVersion: SUPERVISOR_QUESTION_SET_VERSION,
    questionDigest: session?.questionDigest ?? null,
    startedAt: session?.startedAt ?? null,
    counters: { ...counters },
    means: meansOf(aggregates),
    providerStatusCounts: { ...aggregates.providerStatusCounts },
    queue: {
      capacity: SUPERVISOR_QUEUE_CAPACITY,
      depth: queue?.depth ?? 0,
      highWatermark: queue?.highWatermark ?? 0,
      dropped: queue?.dropped ?? 0,
      pushed: queue?.pushed ?? 0,
    },
    recentRows: recentRows.slice(-24),
    droppedRecords: droppedRecords.slice(-32),
    lastObserverError,
    winner: null,
    noAutomatedWinner: true,
    policyRecommendationEmitted: false,
    futureOutcomeScoringIncluded: false,
    note: SUPERVISOR_STATEMENT,
  };
}

/** Finalized `summary.json` — descriptive counts and means only. */
export function buildSupervisorSummary({
  session,
  counters,
  aggregates,
  queue,
  status = "COMPLETE",
  finalizedAt = null,
  recentRowCount = 0,
  droppedRecordCount = 0,
} = {}) {
  const means = meansOf(aggregates);
  const summary = {
    ...supervisorHeader({
      sessionId: session?.sessionId ?? null,
      status,
      updatedAt: finalizedAt,
    }),
    provider: session?.provider ?? null,
    model: session?.model ?? null,
    upstream: session?.upstream ?? null,
    gatewayUsed: false,
    mode: SUPERVISOR_MODE,
    cacheEnabled: false,
    questionSetId: SUPERVISOR_QUESTION_SET_ID,
    questionSetVersion: SUPERVISOR_QUESTION_SET_VERSION,
    questionDigest: session?.questionDigest ?? null,
    startedAt: session?.startedAt ?? null,
    finalizedAt,
    // ---- required descriptive counts ---------------------------------------
    proposalsObserved: counters.proposalsObserved,
    supportedProposals: counters.supportedProposals,
    unsupportedProposals: counters.unsupportedProposals,
    unsupportedProposalCount: counters.unsupportedProposals,
    marketStateUnavailableProposals: counters.marketStateUnavailableProposals,
    directionallyComparable: counters.directionallyComparable,
    notDirectionallyComparable: counters.notDirectionallyComparable,
    jevCalls: counters.jevCalls,
    jevOk: counters.jevOk,
    jevFailures: counters.jevFailures,
    agreementCount: counters.agreementCount,
    disagreementCount: counters.disagreementCount,
    exactHalfCount: counters.exactHalfCount,
    entryComparableCount: counters.entryComparableCount,
    signalExitComparableCount: counters.signalExitComparableCount,
    stopObservations: counters.stopObservations,
    takeObservations: counters.takeObservations,
    timeObservations: counters.timeObservations,
    otherLifecycleExitObservations: counters.otherLifecycleExitObservations,
    observerFailures: counters.observerFailures,
    queueHighWatermark: queue?.highWatermark ?? 0,
    queueDropped: queue?.dropped ?? counters.queueDropped ?? 0,
    meanPHigher: means.meanPHigher,
    meanDistanceFromHalf: means.meanDistanceFromHalf,
    meanLatencyMs: means.meanLatencyMs,
    latencySampleCount: aggregates.latencyCount,
    probabilitySampleCount: aggregates.pHigherCount,
    providerStatusCounts: { ...aggregates.providerStatusCounts },
    recentRowCount,
    droppedRecordCount,
    // ---- explicit non-claims ----------------------------------------------
    winner: null,
    noAutomatedWinner: true,
    profitabilityClaim: false,
    policyRecommendationEmitted: false,
    parameterSelectionPermitted: false,
    resultDrivenTuningApplied: false,
    confidenceThresholdApplied: false,
    futureOutcomeScoringIncluded: false,
    note:
      "Descriptive observation counts only. No winner, no supervisor score, no profitability claim, and no automatic " +
      "policy recommendation. Jev has zero authority over EVOLVE.",
  };
  return { ...summary, summaryDigest: supervisorSummaryDigestOf(summary) };
}

/**
 * Recursively report every forbidden result key. Used by the summary/state
 * writer path AND the validator, so "no winner / no score / no profitability
 * claim / no forward-return analysis" is enforced structurally.
 */
export function auditNoForbiddenResultFields(report) {
  const problems = [];
  const seen = new WeakSet();
  const walk = (value, pathLabel) => {
    if (value === null || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    for (const [key, entry] of Object.entries(value)) {
      if (SUPERVISOR_FORBIDDEN_RESULT_KEYS.includes(key.toLowerCase())) problems.push(`${pathLabel}.${key}`);
      walk(entry, `${pathLabel}.${key}`);
    }
  };
  walk(report ?? null, "report");
  return { ok: problems.length === 0, problems };
}
