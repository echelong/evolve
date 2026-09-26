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
  SUPERVISOR_EVIDENCE_TYPES,
  SUPERVISOR_EXECUTED_TRADE_EVIDENCE_TYPE,
  SUPERVISOR_FEATURE_DEFINITION_DIGEST,
  SUPERVISOR_FEATURE_DEFINITION_VERSION,
  SUPERVISOR_FORBIDDEN_RESULT_KEYS,
  SUPERVISOR_ISOLATION_STATEMENT,
  SUPERVISOR_KIND,
  SUPERVISOR_LABEL,
  SUPERVISOR_MARKET,
  SUPERVISOR_MAX_UNSUPPORTED_SAMPLE,
  SUPERVISOR_MODE,
  SUPERVISOR_NO_AUTHORITY_TAG,
  SUPERVISOR_PHASE,
  SUPERVISOR_QUEUE_CAPACITY,
  SUPERVISOR_QUESTION_SET_ID,
  SUPERVISOR_QUESTION_SET_VERSION,
  SUPERVISOR_ROW_KINDS,
  SUPERVISOR_SCHEMA_VERSION,
  SUPERVISOR_SOL_DEDUP_RULE,
  SUPERVISOR_SOL_OPPORTUNITY_EVIDENCE_TYPE,
  SUPERVISOR_SOL_QUEUE_CAPACITY,
  SUPERVISOR_STATEMENT,
} from "./definition.mjs";

export const SUPERVISOR_SUMMARY_VERSION = 1;

/** Fresh counter block. Every counter is a plain integer count. */
export function createSupervisorCounters() {
  return {
    // ---- executed-trade proposals (PS.2) ----------------------------------
    proposalsObserved: 0, // legacy: supported proposals processed by worker
    totalExecutionProposalsObserved: 0, // all execution attempts seen by tap
    supportedProposals: 0,
    unsupportedProposals: 0,
    unsupportedProposalCount: 0, // explicit alias of `unsupportedProposals`
    unsupportedRecentSampleCount: 0,
    executedTradeProposals: 0,
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
    // ---- SOL opportunities (PS.2a) ----------------------------------------
    // Distinct from executed trades: an opportunity is NOT a trade.
    solOpportunityObservations: 0,
    solOpportunityProposals: 0,
    solOpportunities: 0,
    solActuallySelected: 0,
    solNotSelected: 0,
    solAgreementCount: 0,
    solDisagreementCount: 0,
    solExactHalfCount: 0,
    opportunitiesSuppressedByAgentGenerationDedup: 0,
    uniqueSolMarketStates: 0,
    jevCallsForSolStates: 0,
    reusedJevJudgments: 0,
    solJevOk: 0,
    solJevFailures: 0,
    solQueueDropped: 0,
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
    // PS.2a SOL-state judgments are aggregated SEPARATELY from executed trades.
    solPHigherSum: 0,
    solPHigherCount: 0,
    solLatencySumMs: 0,
    solLatencyCount: 0,
    solProviderStatusCounts: {},
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

/** Observe one valid SOL-state Jev probability into the SOL aggregate block. */
export function observeSolProbability(aggregates, pHigher) {
  if (!Number.isFinite(pHigher)) return aggregates;
  aggregates.solPHigherSum += pHigher;
  aggregates.solPHigherCount += 1;
  return aggregates;
}

/** Observe one SOL-state Jev call latency (failures included — they are real calls). */
export function observeSolLatency(aggregates, latencyMs) {
  if (!Number.isFinite(latencyMs) || latencyMs < 0) return aggregates;
  aggregates.solLatencySumMs += latencyMs;
  aggregates.solLatencyCount += 1;
  return aggregates;
}

export function observeSolProviderStatus(aggregates, status) {
  const label = typeof status === "string" && status.length > 0 ? status : "JEV_NO_STATUS";
  aggregates.solProviderStatusCounts[label] = (aggregates.solProviderStatusCounts[label] ?? 0) + 1;
  return aggregates;
}

/** Derived means for SOL-state judgments only. */
export function solMeansOf(aggregates) {
  return {
    solMeanPHigher: aggregates.solPHigherCount > 0 ? round(aggregates.solPHigherSum / aggregates.solPHigherCount) : null,
    solMeanLatencyMs:
      aggregates.solLatencyCount > 0 ? round(aggregates.solLatencySumMs / aggregates.solLatencyCount, 3) : null,
  };
}

/**
 * The row kind a dashboard row carries. There are exactly four, and a SOL
 * OPPORTUNITY is always distinguishable from a real EXECUTED TRADE.
 */
export function rowKindOf({ evidenceType = null, action = null, directionalComparable = null } = {}) {
  if (evidenceType === SUPERVISOR_EVIDENCE_TYPES.EVOLVE_SOL_OPPORTUNITY) return SUPERVISOR_ROW_KINDS.SOL_OPPORTUNITY;
  if (action === "EXIT_LONG" && directionalComparable !== true) return SUPERVISOR_ROW_KINDS.NOT_COMPARABLE;
  if (action === "EXIT_LONG") return SUPERVISOR_ROW_KINDS.EXECUTED_EXIT;
  return SUPERVISOR_ROW_KINDS.EXECUTED_ENTRY;
}

/** Compact one dashboard row from a persisted executed-proposal judgment. */
export function compactSupervisorRow(judgment) {
  const evidenceType = SUPERVISOR_EXECUTED_TRADE_EVIDENCE_TYPE;
  const action = judgment?.proposal?.action ?? null;
  const directionalComparable = judgment?.proposal?.directionalComparable === true;
  return {
    rowKind: rowKindOf({ evidenceType, action, directionalComparable }),
    evidenceType,
    at: judgment?.observerCompletedAt ?? judgment?.observerStartedAt ?? judgment?.proposal?.timestamp ?? null,
    agentId: judgment?.proposal?.agentId ?? null,
    species: judgment?.proposal?.species ?? null,
    action,
    reason: judgment?.proposal?.reason ?? null,
    mint: judgment?.proposal?.market?.mint ?? null,
    symbol: judgment?.proposal?.market?.symbol ?? null,
    referencePrice: finite(judgment?.proposal?.market?.referencePrice),
    evolveDirectionalIntent: judgment?.proposal?.evolveDirectionalIntent ?? null,
    directionalComparable,
    pHigher: finite(judgment?.pHigher),
    pLower: finite(judgment?.pLower),
    modelIntent: judgment?.modelIntent ?? null,
    agreement: judgment?.agreement ?? null,
    exactHalf: judgment?.exactlyHalf === true,
    providerStatus: judgment?.providerStatus ?? null,
    supported: judgment?.supported === true,
    executed: judgment?.evolveExecution?.executed === true,
    blocked: judgment?.evolveExecution?.blocked === true,
    solScore: null,
    agentEntryThreshold: null,
    scoreMargin: null,
    actualSelectedMint: null,
    actualSelectedSymbol: null,
    actualSelectedScore: null,
    solWasActuallySelected: null,
    judgmentReused: null,
    judgmentReuseCount: null,
    jevJudgmentId: null,
    marketObservationId: null,
  };
}

/** Compact one dashboard row from a PS.2a SOL opportunity record. */
export function compactSolOpportunityRow({
  opportunity = null,
  judgmentSummary = null,
  agreement = null,
  exactlyHalf = false,
} = {}) {
  return {
    rowKind: SUPERVISOR_ROW_KINDS.SOL_OPPORTUNITY,
    evidenceType: SUPERVISOR_SOL_OPPORTUNITY_EVIDENCE_TYPE,
    at: opportunity?.timestamp ?? null,
    agentId: opportunity?.agentId ?? null,
    species: opportunity?.species ?? null,
    action: "SOL_OPPORTUNITY",
    reason: "ACTIONABLE_SOL",
    mint: opportunity?.solMint ?? null,
    symbol: opportunity?.symbol ?? null,
    referencePrice: finite(opportunity?.referencePrice),
    evolveDirectionalIntent: opportunity?.evolveDirectionalIntent ?? null,
    directionalComparable: opportunity?.directionalComparable === true,
    pHigher: finite(judgmentSummary?.pHigher),
    pLower: finite(judgmentSummary?.pLower),
    modelIntent: judgmentSummary?.modelIntent ?? null,
    agreement,
    exactHalf: exactlyHalf === true,
    providerStatus: judgmentSummary?.providerStatus ?? null,
    supported: true,
    executed: false,
    blocked: false,
    solScore: finite(opportunity?.solScore),
    agentEntryThreshold: finite(opportunity?.agentEntryThreshold),
    scoreMargin: finite(opportunity?.scoreMargin),
    actualSelectedMint: opportunity?.actualSelectedMint ?? null,
    actualSelectedSymbol: opportunity?.actualSelectedSymbol ?? null,
    actualSelectedScore: finite(opportunity?.actualSelectedScore),
    solWasActuallySelected: opportunity?.solWasActuallySelected === true,
    judgmentReused: judgmentSummary?.judgmentReused === true,
    judgmentReuseCount: finite(judgmentSummary?.judgmentReuseCount),
    jevJudgmentId: judgmentSummary?.jevJudgmentId ?? null,
    marketObservationId: opportunity?.marketObservationId ?? null,
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
  solQueue = null,
  status = "RUNNING",
  recentRows = [],
  droppedRecords = [],
  unsupportedRecentSample = [],
  solFunnel = null,
  solAgeCounterfactual = null,
  crossAssetShadow = null,
  localTevShadow = null,
  lastProposalAt = null,
  lastJudgmentAt = null,
  lastSolOpportunityAt = null,
  lastSolJudgmentAt = null,
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
    counters: {
      ...counters,
      // Derived, not accumulated: the persisted count IS the bounded sample
      // length, so it can never drift from what the artifact actually holds.
      unsupportedRecentSampleCount: unsupportedRecentSample.slice(-SUPERVISOR_MAX_UNSUPPORTED_SAMPLE).length,
    },
    solFunnel,
    solAgeCounterfactual,
    // PS.2d appears ONLY in sessions that enabled it; older/disabled sessions
    // keep exactly their previous shape.
    ...(crossAssetShadow !== null ? { crossAssetShadow } : {}),
    // PS.2e (Local Tev) likewise appears ONLY in sessions that enabled it.
    ...(localTevShadow !== null ? { localTevShadow } : {}),
    means: meansOf(aggregates),
    solMeans: solMeansOf(aggregates),
    providerStatusCounts: { ...aggregates.providerStatusCounts },
    solProviderStatusCounts: { ...aggregates.solProviderStatusCounts },
    queue: {
      capacity: SUPERVISOR_QUEUE_CAPACITY,
      depth: queue?.depth ?? 0,
      highWatermark: queue?.highWatermark ?? 0,
      dropped: queue?.dropped ?? 0,
      pushed: queue?.pushed ?? 0,
    },
    // The PS.2a SOL opportunity queue is SEPARATE from the executed-proposal
    // queue, so unsupported/SOL traffic can never consume its capacity.
    solQueue: {
      capacity: SUPERVISOR_SOL_QUEUE_CAPACITY,
      depth: solQueue?.depth ?? 0,
      highWatermark: solQueue?.highWatermark ?? 0,
      dropped: solQueue?.dropped ?? 0,
      pushed: solQueue?.pushed ?? 0,
    },
    solDedupRule: SUPERVISOR_SOL_DEDUP_RULE,
    unsupportedRecentSample: Array.isArray(unsupportedRecentSample)
      ? unsupportedRecentSample.slice(-SUPERVISOR_MAX_UNSUPPORTED_SAMPLE)
      : [],
    lastSolOpportunityAt,
    lastSolJudgmentAt,
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
  solQueue = null,
  status = "COMPLETE",
  finalizedAt = null,
  lastProposalAt = null,
  lastJudgmentAt = null,
  lastSolOpportunityAt = null,
  lastSolJudgmentAt = null,
  unsupportedRecentSample = [],
  solFunnel = null,
  solAgeCounterfactual = null,
  crossAssetShadow = null,
  localTevShadow = null,
  recentRowCount = 0,
  droppedRecordCount = 0,
} = {}) {
  const means = meansOf(aggregates);
  const solMeans = solMeansOf(aggregates);
  const summary = {
    ...supervisorHeader({
      sessionId: session?.sessionId ?? null,
      status,
      updatedAt: finalizedAt,
      // Fix PS.2 run-1: the finalized summary must reflect the FINAL observer
      // state, not the null defaults the header was constructed with.
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
    finalizedAt,
    // ---- required descriptive counts ---------------------------------------
    proposalsObserved: counters.proposalsObserved,
    totalExecutionProposalsObserved: counters.totalExecutionProposalsObserved,
    proposalCounterSemantics: "proposalsObserved = legacy worker-processed supported proposals; totalExecutionProposalsObserved = all execution proposals at tap, including unsupported and blocked attempts; executedTradeProposals is its legacy alias, not a fill count",
    solFunnel,
    solAgeCounterfactual,
    ...(crossAssetShadow !== null ? { crossAssetShadow } : {}),
    ...(localTevShadow !== null ? { localTevShadow } : {}),
    supportedProposals: counters.supportedProposals,
    unsupportedProposals: counters.unsupportedProposals,
    unsupportedProposalCount: counters.unsupportedProposals,
    unsupportedRecentSampleCount: unsupportedRecentSample.slice(-SUPERVISOR_MAX_UNSUPPORTED_SAMPLE).length,
    executedTradeProposals: counters.executedTradeProposals,
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
    // ---- PS.2a SOL opportunities (separate from executed trades) ----------
    solOpportunityObservations: counters.solOpportunityObservations,
    solOpportunityProposals: counters.solOpportunityProposals,
    solOpportunities: counters.solOpportunities,
    solActuallySelected: counters.solActuallySelected,
    solNotSelected: counters.solNotSelected,
    solAgreementCount: counters.solAgreementCount,
    solDisagreementCount: counters.solDisagreementCount,
    solExactHalfCount: counters.solExactHalfCount,
    opportunitiesSuppressedByAgentGenerationDedup: counters.opportunitiesSuppressedByAgentGenerationDedup,
    uniqueSolMarketStates: counters.uniqueSolMarketStates,
    jevCallsForSolStates: counters.jevCallsForSolStates,
    reusedJevJudgments: counters.reusedJevJudgments,
    solJevOk: counters.solJevOk,
    solJevFailures: counters.solJevFailures,
    solQueueHighWatermark: solQueue?.highWatermark ?? 0,
    solQueueDropped: solQueue?.dropped ?? counters.solQueueDropped ?? 0,
    solDedupRule: SUPERVISOR_SOL_DEDUP_RULE,
    unsupportedRecentSample: Array.isArray(unsupportedRecentSample)
      ? unsupportedRecentSample.slice(-SUPERVISOR_MAX_UNSUPPORTED_SAMPLE)
      : [],
    lastSolOpportunityAt,
    lastSolJudgmentAt,
    meanPHigher: means.meanPHigher,
    meanDistanceFromHalf: means.meanDistanceFromHalf,
    meanLatencyMs: means.meanLatencyMs,
    latencySampleCount: aggregates.latencyCount,
    probabilitySampleCount: aggregates.pHigherCount,
    providerStatusCounts: { ...aggregates.providerStatusCounts },
    solMeanPHigher: solMeans.solMeanPHigher,
    solMeanLatencyMs: solMeans.solMeanLatencyMs,
    solLatencySampleCount: aggregates.solLatencyCount,
    solProbabilitySampleCount: aggregates.solPHigherCount,
    solProviderStatusCounts: { ...aggregates.solProviderStatusCounts },
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
