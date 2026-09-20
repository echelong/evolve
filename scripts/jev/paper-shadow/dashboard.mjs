/**
 * Jev paper-shadow dashboard state.
 *
 * Builds the compact, bounded `jevPaperShadow` block consumed by
 * `scripts/lib/dashboard-state.mjs` / `/api/state`. Read-only: this module never
 * writes anything, and it only ever reads from `.evolve/jev-paper-shadow/`.
 *
 * Only the compact LATEST `state.json` + `summary.json` are read. Raw packet
 * contents are NEVER exposed — the state file does not contain them, and this
 * loader explicitly whitelists what it forwards.
 *
 * PAPER ONLY / DEVELOPMENT DASHBOARD EXPERIMENT.
 */

import path from "node:path";

import {
  PAPER_SHADOW_ACCOUNTING_NOTE,
  PAPER_SHADOW_CLASSIFICATION,
  PAPER_SHADOW_EQUITY_SERIES_LIMIT,
  PAPER_SHADOW_EXCLUSION_NOTE,
  PAPER_SHADOW_LABEL,
  PAPER_SHADOW_PAPER_ONLY_TAG,
  PAPER_SHADOW_RECENT_DECISION_LIMIT,
  PAPER_SHADOW_ROOT_DIR,
} from "./definition.mjs";
import { listPaperShadowSessions, readPaperShadowState, readPaperShadowSummary } from "./storage.mjs";

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value) {
  return typeof value === "string" ? value : null;
}

function compactDecisionRow(row) {
  return {
    sequence: num(row?.sequence),
    scheduledAt: str(row?.scheduledAt),
    observedAt: str(row?.observedAt),
    referencePrice: num(row?.referencePrice),
    pHigher: num(row?.pHigher),
    modelIntent: str(row?.modelIntent),
    action: str(row?.action),
    actionReason: str(row?.actionReason),
    equity: num(row?.equity),
    netPnl: num(row?.netPnl),
    costs: num(row?.costs),
    marketFeedHealth: str(row?.marketFeedHealth),
  };
}

function compactEquityPoint(point) {
  return { at: str(point?.at), equity: num(point?.equity), price: num(point?.price) };
}

/**
 * Load the newest paper-shadow session's dashboard block, or an
 * `available: false` placeholder when none has ever run in this workspace.
 *
 * @param {string} [root] `.evolve` root
 */
export async function loadJevPaperShadowState(root = path.join(process.cwd(), ".evolve")) {
  const baseRoot = path.join(root, "jev-paper-shadow");
  const sessions = await listPaperShadowSessions(baseRoot);

  if (sessions.length === 0) {
    return {
      available: false,
      ...PAPER_SHADOW_CLASSIFICATION,
      label: PAPER_SHADOW_LABEL,
      accountingNote: PAPER_SHADOW_ACCOUNTING_NOTE,
      exclusionNote: PAPER_SHADOW_EXCLUSION_NOTE,
      paperOnlyTag: PAPER_SHADOW_PAPER_ONLY_TAG,
      root: PAPER_SHADOW_ROOT_DIR,
      note: "No Jev paper-shadow session has been run in this workspace yet (npm run jev:paper).",
    };
  }

  const sessionId = sessions[sessions.length - 1];
  const sessionRoot = path.join(baseRoot, sessionId);
  const state = await readPaperShadowState(sessionRoot);
  const summary = await readPaperShadowSummary(sessionRoot);

  if (!state && !summary) {
    return {
      available: false,
      sessionId,
      ...PAPER_SHADOW_CLASSIFICATION,
      label: PAPER_SHADOW_LABEL,
      accountingNote: PAPER_SHADOW_ACCOUNTING_NOTE,
      exclusionNote: PAPER_SHADOW_EXCLUSION_NOTE,
      paperOnlyTag: PAPER_SHADOW_PAPER_ONLY_TAG,
      root: PAPER_SHADOW_ROOT_DIR,
      note: "The newest Jev paper-shadow session has no readable state yet.",
    };
  }

  const account = state?.account ?? {};
  const counters = state?.counters ?? {};
  const recent = Array.isArray(state?.recentDecisions) ? state.recentDecisions : [];
  const equitySeries = Array.isArray(state?.equitySeries) ? state.equitySeries : [];

  return {
    available: true,
    ...PAPER_SHADOW_CLASSIFICATION,
    label: PAPER_SHADOW_LABEL,
    accountingNote: PAPER_SHADOW_ACCOUNTING_NOTE,
    exclusionNote: PAPER_SHADOW_EXCLUSION_NOTE,
    paperOnlyTag: PAPER_SHADOW_PAPER_ONLY_TAG,
    root: PAPER_SHADOW_ROOT_DIR,
    sessionId: str(state?.sessionId) ?? sessionId,
    status: str(state?.status) ?? str(summary?.status),
    provider: str(state?.provider),
    model: str(state?.model),
    upstream: str(state?.upstream),
    gatewayUsed: state?.gatewayUsed === true,
    mode: str(state?.mode) ?? "shadow",
    cacheEnabled: state?.cacheEnabled === true,
    market: str(state?.market?.marketId),
    symbol: str(state?.market?.baseSymbol),
    mint: str(state?.market?.baseMint),
    quoteSymbol: str(state?.market?.quoteSymbol),
    startedAt: str(state?.startedAt),
    updatedAt: str(state?.updatedAt),
    lastUpdate: str(state?.lastUpdate),
    marketFeedHealth: str(state?.marketFeedHealth),
    pHigher: num(state?.pHigher),
    pLower: num(state?.pLower),
    modelIntent: str(state?.modelIntent),
    accountState: str(state?.accountState),
    paperAction: str(state?.paperAction),
    actionReason: str(state?.actionReason),
    cash: num(account.cash),
    positionQty: num(account.positionQty),
    positionEntryPrice: num(account.positionEntryPrice),
    positionMarkPrice: num(account.positionMarkPrice),
    positionValue: num(account.positionValue),
    equity: num(account.equity),
    grossPnl: num(account.grossPnl),
    netPnl: num(account.netPnl),
    unrealizedPnl: num(account.unrealizedPnl),
    realizedPnl: num(account.realizedPnl),
    costs: num(account.costs),
    returnPct: num(account.returnPct),
    maxDrawdown: num(account.maxDrawdown),
    entries: num(account.enterCount) ?? num(counters.enterCount),
    exits: num(account.exitCount) ?? num(counters.exitCount),
    paperTrades: (num(account.enterCount) ?? 0) + (num(account.exitCount) ?? 0),
    winningClosedTrades: num(account.winningClosedTrades),
    losingClosedTrades: num(account.losingClosedTrades),
    decisions: num(counters.decisions),
    jevCalls: (num(counters.jevOk) ?? 0) + (num(counters.jevFailures) ?? 0),
    jevFailures: num(counters.jevFailures),
    jevOk: num(counters.jevOk),
    holdCount: num(counters.holdCount),
    cashCount: num(counters.cashCount),
    higherCount: num(counters.higherCount),
    lowerCount: num(counters.lowerCount),
    meanLatencyMs:
      num(counters.jevLatencyCount) && counters.jevLatencyCount > 0
        ? Math.round(counters.jevLatencySumMs / counters.jevLatencyCount)
        : num(summary?.meanJevLatencyMs),
    meanPHigher: num(summary?.meanPHigher),
    minPHigher: num(summary?.minPHigher),
    maxPHigher: num(summary?.maxPHigher),
    recentDecisions: recent.slice(-PAPER_SHADOW_RECENT_DECISION_LIMIT).map(compactDecisionRow),
    equitySeries: equitySeries.slice(-PAPER_SHADOW_EQUITY_SERIES_LIMIT).map(compactEquityPoint),
    summary: summary
      ? {
          decisions: num(summary.decisions),
          jevOk: num(summary.jevOk),
          jevFailures: num(summary.jevFailures),
          higherCount: num(summary.higherCount),
          lowerCount: num(summary.lowerCount),
          enterCount: num(summary.enterCount),
          exitCount: num(summary.exitCount),
          holdCount: num(summary.holdCount),
          cashCount: num(summary.cashCount),
          paperTrades: num(summary.paperTrades),
          winningClosedTrades: num(summary.winningClosedTrades),
          losingClosedTrades: num(summary.losingClosedTrades),
          startingCash: num(summary.startingCash),
          endingCash: num(summary.endingCash),
          endingPositionValue: num(summary.endingPositionValue),
          endingEquity: num(summary.endingEquity),
          grossPnl: num(summary.grossPnl),
          netPnl: num(summary.netPnl),
          totalCosts: num(summary.totalCosts),
          maxDrawdown: num(summary.maxDrawdown),
          meanJevLatencyMs: num(summary.meanJevLatencyMs),
          meanPHigher: num(summary.meanPHigher),
          minPHigher: num(summary.minPHigher),
          maxPHigher: num(summary.maxPHigher),
          summaryDigest: str(summary.summaryDigest),
          finalizedAt: str(summary.finalizedAt),
        }
      : null,
    note:
      "Deterministic simulated paper accounting for an isolated Jev-controlled account. No winner and no " +
      "profitability verdict: positive paper P&L is not proof of profitability.",
  };
}

export const JEV_PAPER_SHADOW_ROOT = PAPER_SHADOW_ROOT_DIR;
