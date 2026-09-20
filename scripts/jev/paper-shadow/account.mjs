/**
 * Jev paper-shadow PAPER ACCOUNT.
 *
 * This is ONE isolated simulated account. It reuses EVOLVE's existing paper fill
 * machinery verbatim (`scripts/engine/paper.mjs`: `simulateEntry`,
 * `simulateExit`, `slippageBpsFor`, `executionCostBps`) — the SAME base fee,
 * minimum slippage, liquidity impact, adverse execution buffer, and liquidity
 * constraint the evolutionary engine uses. There is no second friction model.
 *
 * The model is deliberately plain and serializable so a session's account state
 * round-trips through `state.json` exactly.
 *
 * PAPER ONLY. A "fill" is an accounting event: no wallet, no signer, no RPC, no
 * order, no transaction, and no real money.
 */

import { simulateEntry, simulateExit } from "../../engine/paper.mjs";

export const PAPER_SHADOW_ACCOUNT_VERSION = 1;

function finite(value, fallback = null) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** A brand-new flat account. Equity begins exactly at the starting cash. */
export function createPaperAccount({ startingCash }) {
  const cash = finite(startingCash, 0) ?? 0;
  return {
    version: PAPER_SHADOW_ACCOUNT_VERSION,
    startingCash: cash,
    cash,
    positionQty: 0,
    positionEntryPrice: null,
    positionEntryNotional: 0,
    positionMarkPrice: null,
    realizedPnl: 0,
    realizedGrossPnl: 0,
    costs: 0,
    enterCount: 0,
    exitCount: 0,
    winningClosedTrades: 0,
    losingClosedTrades: 0,
    peakEquity: cash,
    maxDrawdown: 0,
    // Derived snapshot fields (recomputed below; persisted for cheap reading).
    positionValue: 0,
    equity: cash,
    grossPnl: 0,
    netPnl: 0,
    unrealizedPnl: 0,
    returnPct: 0,
  };
}

/** True when the account holds an open SOL position. */
export function hasOpenPosition(account) {
  return finite(account?.positionQty, 0) > 0;
}

/**
 * Recompute the derived snapshot from the last legitimate mark. A missing or
 * non-finite mark NEVER invents a price: the previous mark is retained.
 */
export function markAccount(account, { markPrice = null } = {}) {
  const qty = finite(account.positionQty, 0) ?? 0;
  const entry = finite(account.positionEntryPrice, null);
  const previousMark = finite(account.positionMarkPrice, null);
  const observedMark = finite(markPrice, null);
  const mark = observedMark !== null && observedMark > 0 ? observedMark : previousMark;

  const positionValue = qty > 0 && mark !== null ? qty * mark : 0;
  const equity = (finite(account.cash, 0) ?? 0) + positionValue;
  const unrealizedPnl = qty > 0 && mark !== null && entry !== null ? qty * (mark - entry) : 0;
  const startingCash = finite(account.startingCash, 0) ?? 0;
  const netPnl = equity - startingCash;
  const grossPnl = (finite(account.realizedGrossPnl, 0) ?? 0) + unrealizedPnl;

  const peakEquity = Math.max(finite(account.peakEquity, equity) ?? equity, equity);
  const drawdown = peakEquity > 0 ? Math.max(0, (peakEquity - equity) / peakEquity) : 0;

  return {
    ...account,
    positionMarkPrice: mark,
    positionValue,
    equity,
    grossPnl,
    netPnl,
    unrealizedPnl,
    returnPct: startingCash > 0 ? netPnl / startingCash : 0,
    peakEquity,
    maxDrawdown: Math.max(finite(account.maxDrawdown, 0) ?? 0, drawdown),
  };
}

/**
 * Simulate a paper entry that commits `positionFraction` of currently available
 * paper cash (also capped by the configured fraction of observed liquidity).
 *
 * @returns {{ ok: boolean, reason: string|null, account: object, fill: object|null }}
 */
export function applyPaperEntry({ account, price, liquidityUsd, friction, positionFraction }) {
  if (hasOpenPosition(account)) return { ok: false, reason: "already_long", account, fill: null };

  const cashAvailable = Math.max(0, finite(account.cash, 0) ?? 0);
  if (cashAvailable <= 0) return { ok: false, reason: "no_cash", account, fill: null };

  let notional = cashAvailable * positionFraction;
  const maxLiquidityFraction = finite(friction?.maxLiquidityFraction, null);
  const liquidity = finite(liquidityUsd, null);
  if (liquidity !== null && liquidity > 0 && maxLiquidityFraction !== null) {
    notional = Math.min(notional, liquidity * maxLiquidityFraction);
  }
  if (!Number.isFinite(notional) || notional <= 0) {
    return { ok: false, reason: "no_notional", account, fill: null };
  }

  const fill = simulateEntry({ price, notionalUsd: notional, liquidityUsd, friction });
  if (fill.ok !== true) return { ok: false, reason: fill.reason ?? "unfillable", account, fill: null };

  const next = {
    ...account,
    cash: cashAvailable - fill.cashSpent,
    positionQty: fill.qty,
    positionEntryPrice: fill.referencePrice,
    positionEntryNotional: fill.cashSpent,
    positionMarkPrice: fill.referencePrice,
    costs: (finite(account.costs, 0) ?? 0) + fill.frictionUsd,
    enterCount: (finite(account.enterCount, 0) ?? 0) + 1,
  };

  return { ok: true, reason: null, account: markAccount(next, { markPrice: fill.referencePrice }), fill };
}

/**
 * Simulate a paper exit of the whole open position at the observed reference
 * price. No partial exits, no averaging down, no pyramiding.
 *
 * @returns {{ ok: boolean, reason: string|null, account: object, fill: object|null, tradeNetPnl: number|null }}
 */
export function applyPaperExit({ account, price, liquidityUsd, friction }) {
  if (!hasOpenPosition(account)) {
    return { ok: false, reason: "no_position", account, fill: null, tradeNetPnl: null };
  }

  const fill = simulateExit({
    qty: account.positionQty,
    price,
    liquidityUsd,
    referencePrice: account.positionEntryPrice,
    friction,
  });
  if (fill.ok !== true) return { ok: false, reason: fill.reason ?? "unfillable", account, fill: null, tradeNetPnl: null };

  const entryNotional = finite(account.positionEntryNotional, 0) ?? 0;
  const tradeNetPnl = fill.netProceeds - entryNotional;

  const next = {
    ...account,
    cash: (finite(account.cash, 0) ?? 0) + fill.netProceeds,
    positionQty: 0,
    positionEntryPrice: null,
    positionEntryNotional: 0,
    positionMarkPrice: fill.referencePrice,
    realizedPnl: (finite(account.realizedPnl, 0) ?? 0) + tradeNetPnl,
    realizedGrossPnl: (finite(account.realizedGrossPnl, 0) ?? 0) + fill.grossPnl,
    costs: (finite(account.costs, 0) ?? 0) + fill.frictionUsd,
    exitCount: (finite(account.exitCount, 0) ?? 0) + 1,
    // A trade that exactly breaks even (net P&L == 0) is counted in NEITHER
    // bucket: it is not a win and not a loss.
    winningClosedTrades:
      (finite(account.winningClosedTrades, 0) ?? 0) + (tradeNetPnl > 0 ? 1 : 0),
    losingClosedTrades:
      (finite(account.losingClosedTrades, 0) ?? 0) + (tradeNetPnl < 0 ? 1 : 0),
  };

  return { ok: true, reason: null, account: markAccount(next, { markPrice: fill.referencePrice }), fill, tradeNetPnl };
}

/** The bounded paper-fill fields recorded on an event (never a raw provider payload). */
export function compactPaperFill(fill, side) {
  if (!fill || fill.ok !== true) return null;
  return {
    side,
    referencePrice: finite(fill.referencePrice, null),
    executedPrice: finite(fill.executedPrice, null),
    qty: finite(fill.qty, null),
    notional:
      side === "BUY"
        ? finite(fill.cashSpent, null)
        : Number.isFinite(fill.qty) && Number.isFinite(fill.referencePrice)
          ? fill.qty * fill.referencePrice
          : null,
    feeUsd: finite(fill.feeUsd, null),
    slippageBps: finite(fill.slippageBps, null),
    costBps: finite(fill.costBps, null),
    frictionUsd: finite(fill.frictionUsd, null),
  };
}
