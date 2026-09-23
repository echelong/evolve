/**
 * Phase 5I-PS.2 — JEV SUPERVISOR OBSERVER dashboard state.
 *
 * Builds the compact, bounded `jevSupervisorObserver` block consumed by
 * `/api/state` and the dashboard panel. READ-ONLY: this module never writes
 * anything, and it only ever reads `.evolve/jev-supervisor-observer/`.
 *
 * Only the compact LATEST `state.json` + `summary.json` are read. Raw proposal
 * records, market-state projections and packet contents are NEVER exposed —
 * `state.json` does not contain them, and this loader explicitly whitelists
 * what it forwards.
 *
 * It is deliberately a SEPARATE top-level dashboard field: it is never merged
 * with `jevShadow` (Phase 5D supervisor health) or `jevPaperShadow` (the
 * isolated 5I-PS paper demo account).
 *
 * PAPER ONLY / DEVELOPMENT EVIDENCE ONLY. NO AUTHORITY.
 */

import path from "node:path";

import {
  SUPERVISOR_CLASSIFICATION,
  SUPERVISOR_ISOLATION_STATEMENT,
  SUPERVISOR_LABEL,
  SUPERVISOR_MAX_UNSUPPORTED_SAMPLE,
  SUPERVISOR_NO_AUTHORITY_TAG,
  SUPERVISOR_ROOT_DIR,
  SUPERVISOR_STATEMENT,
} from "./definition.mjs";
import { listSupervisorSessions, readSupervisorState, readSupervisorSummary } from "./storage.mjs";

/** A live observer whose state file has not moved for this long is reported QUIET. */
export const SUPERVISOR_QUIET_AFTER_MS = 120_000;

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value) {
  return typeof value === "string" ? value : null;
}

function compactRow(row) {
  return {
    rowKind: str(row?.rowKind),
    evidenceType: str(row?.evidenceType),
    at: str(row?.at),
    agentId: str(row?.agentId),
    species: str(row?.species),
    action: str(row?.action),
    reason: str(row?.reason),
    symbol: str(row?.symbol),
    referencePrice: num(row?.referencePrice),
    evolveDirectionalIntent: str(row?.evolveDirectionalIntent),
    directionalComparable: row?.directionalComparable === true,
    pHigher: num(row?.pHigher),
    modelIntent: str(row?.modelIntent),
    agreement: str(row?.agreement),
    exactHalf: row?.exactHalf === true,
    providerStatus: str(row?.providerStatus),
    supported: row?.supported === true,
    executed: row?.executed === true,
    blocked: row?.blocked === true,
    jevEvaluation: str(row?.jevEvaluation),
    // PS.2a SOL opportunity fields (null on an executed-trade row).
    solScore: num(row?.solScore),
    agentEntryThreshold: num(row?.agentEntryThreshold),
    scoreMargin: num(row?.scoreMargin),
    actualSelectedMint: str(row?.actualSelectedMint),
    actualSelectedSymbol: str(row?.actualSelectedSymbol),
    actualSelectedScore: num(row?.actualSelectedScore),
    solWasActuallySelected: row?.solWasActuallySelected === true ? true : row?.solWasActuallySelected === false ? false : null,
    judgmentReused: row?.judgmentReused === true ? true : row?.judgmentReused === false ? false : null,
    judgmentReuseCount: num(row?.judgmentReuseCount),
    jevJudgmentId: str(row?.jevJudgmentId),
    marketObservationId: str(row?.marketObservationId),
  };
}

function observerHealthOf({ status, observerFailures, dropped, updatedAt, now }) {
  if (status !== null && status !== "RUNNING") return "FINALIZED";
  if (Number.isFinite(observerFailures) && observerFailures > 0) return "DEGRADED";
  if (Number.isFinite(dropped) && dropped > 0) return "DEGRADED";
  const updatedMs = Date.parse(updatedAt ?? "");
  if (Number.isFinite(updatedMs) && now - updatedMs > SUPERVISOR_QUIET_AFTER_MS) return "QUIET";
  return "OBSERVING";
}

/**
 * Load the newest supervisor session's dashboard block, or an
 * `available: false` placeholder when none has ever run in this workspace.
 *
 * @param {string} [root] `.evolve` root
 * @param {{ now?: () => number }} [options]
 */
export async function loadJevSupervisorObserverState(root = path.join(process.cwd(), ".evolve"), { now = Date.now } = {}) {
  const baseRoot = path.join(root, "jev-supervisor-observer");
  const sessions = await listSupervisorSessions(baseRoot);

  if (sessions.length === 0) {
    return {
      available: false,
      ...SUPERVISOR_CLASSIFICATION,
      label: SUPERVISOR_LABEL,
      noAuthorityTag: SUPERVISOR_NO_AUTHORITY_TAG,
      statement: SUPERVISOR_STATEMENT,
      isolationStatement: SUPERVISOR_ISOLATION_STATEMENT,
      root: SUPERVISOR_ROOT_DIR,
      note: "No Jev supervisor observer session has been run in this workspace yet (npm run jev:supervisor -- --minutes 60).",
    };
  }

  const sessionId = sessions[sessions.length - 1];
  const sessionRoot = path.join(baseRoot, sessionId);
  const state = await readSupervisorState(sessionRoot);
  const summary = await readSupervisorSummary(sessionRoot);

  if (!state && !summary) {
    return {
      available: false,
      sessionId,
      ...SUPERVISOR_CLASSIFICATION,
      label: SUPERVISOR_LABEL,
      noAuthorityTag: SUPERVISOR_NO_AUTHORITY_TAG,
      statement: SUPERVISOR_STATEMENT,
      isolationStatement: SUPERVISOR_ISOLATION_STATEMENT,
      root: SUPERVISOR_ROOT_DIR,
      note: "The newest Jev supervisor observer session has no readable state yet.",
    };
  }

  const counters = state?.counters ?? {};
  const means = state?.means ?? {};
  const solMeans = state?.solMeans ?? {};
  const queue = state?.queue ?? {};
  const solQueue = state?.solQueue ?? {};
  const rows = Array.isArray(state?.recentRows) ? state.recentRows : [];
  const unsupportedRecentSample = Array.isArray(state?.unsupportedRecentSample)
    ? state.unsupportedRecentSample
    : Array.isArray(summary?.unsupportedRecentSample)
      ? summary.unsupportedRecentSample
      : [];
  const status = str(state?.status) ?? str(summary?.status);
  const observerFailures = num(counters.observerFailures) ?? num(summary?.observerFailures);
  const queueDropped = num(queue.dropped) ?? num(summary?.queueDropped);

  return {
    available: true,
    ...SUPERVISOR_CLASSIFICATION,
    label: SUPERVISOR_LABEL,
    noAuthorityTag: SUPERVISOR_NO_AUTHORITY_TAG,
    statement: SUPERVISOR_STATEMENT,
    isolationStatement: SUPERVISOR_ISOLATION_STATEMENT,
    root: SUPERVISOR_ROOT_DIR,
    sessionId: str(state?.sessionId) ?? sessionId,
    status,
    provider: str(state?.provider) ?? str(summary?.provider),
    model: str(state?.model) ?? str(summary?.model),
    upstream: str(state?.upstream) ?? str(summary?.upstream),
    gatewayUsed: state?.gatewayUsed === true || summary?.gatewayUsed === true,
    mode: str(state?.mode) ?? "shadow",
    cacheEnabled: state?.cacheEnabled === true || summary?.cacheEnabled === true,
    market: str(state?.market?.marketId),
    symbol: str(state?.market?.baseSymbol),
    quoteSymbol: str(state?.market?.quoteSymbol),
    mint: str(state?.market?.baseMint),
    startedAt: str(state?.startedAt) ?? str(summary?.startedAt),
    updatedAt: str(state?.updatedAt),
    finalizedAt: str(summary?.finalizedAt),
    lastProposalAt: str(state?.lastProposalAt),
    lastJudgmentAt: str(state?.lastJudgmentAt),
    observerHealth: observerHealthOf({
      status,
      observerFailures,
      dropped: queueDropped,
      updatedAt: str(state?.updatedAt),
      now: now(),
    }),
    solFunnel: state?.solFunnel ?? summary?.solFunnel ?? null,
    solAgeCounterfactual: state?.solAgeCounterfactual ?? summary?.solAgeCounterfactual ?? null,
    totalExecutionProposalsObserved: num(counters.totalExecutionProposalsObserved) ?? num(summary?.totalExecutionProposalsObserved),
    proposalsObserved: num(counters.proposalsObserved) ?? num(summary?.proposalsObserved),
    supportedProposals: num(counters.supportedProposals) ?? num(summary?.supportedProposals),
    unsupportedProposals: num(counters.unsupportedProposals) ?? num(summary?.unsupportedProposals),
    marketStateUnavailableProposals:
      num(counters.marketStateUnavailableProposals) ?? num(summary?.marketStateUnavailableProposals),
    directionallyComparable: num(counters.directionallyComparable) ?? num(summary?.directionallyComparable),
    notDirectionallyComparable: num(counters.notDirectionallyComparable) ?? num(summary?.notDirectionallyComparable),
    entryComparableCount: num(counters.entryComparableCount) ?? num(summary?.entryComparableCount),
    signalExitComparableCount: num(counters.signalExitComparableCount) ?? num(summary?.signalExitComparableCount),
    stopObservations: num(counters.stopObservations) ?? num(summary?.stopObservations),
    takeObservations: num(counters.takeObservations) ?? num(summary?.takeObservations),
    timeObservations: num(counters.timeObservations) ?? num(summary?.timeObservations),
    otherLifecycleExitObservations:
      num(counters.otherLifecycleExitObservations) ?? num(summary?.otherLifecycleExitObservations),
    jevCalls: num(counters.jevCalls) ?? num(summary?.jevCalls),
    jevOk: num(counters.jevOk) ?? num(summary?.jevOk),
    jevFailures: num(counters.jevFailures) ?? num(summary?.jevFailures),
    agreementCount: num(counters.agreementCount) ?? num(summary?.agreementCount),
    disagreementCount: num(counters.disagreementCount) ?? num(summary?.disagreementCount),
    exactHalfCount: num(counters.exactHalfCount) ?? num(summary?.exactHalfCount),
    exactHalf: num(counters.exactHalfCount) ?? num(summary?.exactHalfCount),
    meanPHigher: num(means.meanPHigher) ?? num(summary?.meanPHigher),
    meanDistanceFromHalf: num(means.meanDistanceFromHalf) ?? num(summary?.meanDistanceFromHalf),
    meanLatencyMs: num(means.meanLatencyMs) ?? num(summary?.meanLatencyMs),
    queueCapacity: num(queue.capacity),
    queueDepth: num(queue.depth),
    queueHighWatermark: num(queue.highWatermark) ?? num(summary?.queueHighWatermark),
    queueDropped,
    observerFailures,
    // ---- PS.2a SOL opportunities (never merged with executed trades) -------
    executedTradeProposals:
      num(counters.executedTradeProposals) ?? num(summary?.executedTradeProposals),
    unsupportedRecentSampleCount:
      num(counters.unsupportedRecentSampleCount) ?? num(summary?.unsupportedRecentSampleCount),
    unsupportedRecentSample: unsupportedRecentSample.slice(-SUPERVISOR_MAX_UNSUPPORTED_SAMPLE).map((entry) => ({
      at: str(entry?.at),
      agentId: str(entry?.agentId),
      action: str(entry?.action),
      reason: str(entry?.reason),
      mint: str(entry?.mint),
      symbol: str(entry?.symbol),
      marketId: str(entry?.marketId),
    })),
    solOpportunityObservations:
      num(counters.solOpportunityObservations) ?? num(summary?.solOpportunityObservations),
    solOpportunityProposals: num(counters.solOpportunityProposals) ?? num(summary?.solOpportunityProposals),
    solOpportunities: num(counters.solOpportunities) ?? num(summary?.solOpportunities),
    solActuallySelected: num(counters.solActuallySelected) ?? num(summary?.solActuallySelected),
    solNotSelected: num(counters.solNotSelected) ?? num(summary?.solNotSelected),
    solAgreementCount: num(counters.solAgreementCount) ?? num(summary?.solAgreementCount),
    solDisagreementCount: num(counters.solDisagreementCount) ?? num(summary?.solDisagreementCount),
    solExactHalfCount: num(counters.solExactHalfCount) ?? num(summary?.solExactHalfCount),
    opportunitiesSuppressedByAgentGenerationDedup:
      num(counters.opportunitiesSuppressedByAgentGenerationDedup) ??
      num(summary?.opportunitiesSuppressedByAgentGenerationDedup),
    uniqueSolMarketStates: num(counters.uniqueSolMarketStates) ?? num(summary?.uniqueSolMarketStates),
    jevCallsForSolStates: num(counters.jevCallsForSolStates) ?? num(summary?.jevCallsForSolStates),
    reusedJevJudgments: num(counters.reusedJevJudgments) ?? num(summary?.reusedJevJudgments),
    solJevOk: num(counters.solJevOk) ?? num(summary?.solJevOk),
    solJevFailures: num(counters.solJevFailures) ?? num(summary?.solJevFailures),
    solQueueCapacity: num(solQueue.capacity),
    solQueueDepth: num(solQueue.depth),
    solQueueHighWatermark: num(solQueue.highWatermark) ?? num(summary?.solQueueHighWatermark),
    solQueueDropped: num(solQueue.dropped) ?? num(summary?.solQueueDropped),
    solMeanPHigher: num(solMeans.solMeanPHigher) ?? num(summary?.solMeanPHigher),
    solMeanLatencyMs: num(solMeans.solMeanLatencyMs) ?? num(summary?.solMeanLatencyMs),
    lastSolOpportunityAt: str(state?.lastSolOpportunityAt),
    lastSolJudgmentAt: str(state?.lastSolJudgmentAt),
    solDedupRule: str(state?.solDedupRule) ?? str(summary?.solDedupRule),
    providerStatusCounts:
      state && typeof state.providerStatusCounts === "object" ? { ...state.providerStatusCounts } : null,
    winner: null,
    noAutomatedWinner: true,
    supervisorScore: null,
    recentRows: rows.slice(-24).map(compactRow),
    summary: summary
      ? {
          status: str(summary.status),
          finalizedAt: str(summary.finalizedAt),
          proposalsObserved: num(summary.proposalsObserved),
          jevCalls: num(summary.jevCalls),
          jevFailures: num(summary.jevFailures),
          agreementCount: num(summary.agreementCount),
          disagreementCount: num(summary.disagreementCount),
          exactHalfCount: num(summary.exactHalfCount),
          meanPHigher: num(summary.meanPHigher),
          meanDistanceFromHalf: num(summary.meanDistanceFromHalf),
          meanLatencyMs: num(summary.meanLatencyMs),
          queueHighWatermark: num(summary.queueHighWatermark),
          queueDropped: num(summary.queueDropped),
          observerFailures: num(summary.observerFailures),
          summaryDigest: str(summary.summaryDigest),
        }
      : null,
    note: SUPERVISOR_STATEMENT,
  };
}
