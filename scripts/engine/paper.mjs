/**
 * Paper execution.
 *
 * A "fill" here is nothing but an accounting event. There is no wallet, no
 * signer, no RPC call, no order, no transaction, and no on-chain interaction of
 * any kind in this module — and there never will be in EVOLVE. Real SOL cannot
 * be spent by this codebase because the capability does not exist in it.
 *
 * Realistic friction is modelled so that fitness cannot be inflated by
 * frictionless assumptions:
 *
 *   fee            = base fee in basis points of notional
 *   slippage       = max(minimum slippage, liquidity-impact slippage), capped
 *   adverse buffer = small additional execution penalty applied to both sides
 *
 * Buys execute above, and sells below, the observed reference price. Fees are
 * taken out of the filled quantity so an agent's equity is net of costs by
 * construction.
 */

export const PAPER_ONLY = true;

/** Execution guard rails reported to the dashboard. */
export function paperGuards() {
  return {
    paperOnly: true,
    realMoney: false,
    canSpendRealSol: false,
    walletKeysLoaded: false,
    walletConnector: false,
    signingCapability: "not implemented",
    submissionCapability: "not implemented",
    onChainExecution: "not implemented",
    providerCalls: "read-only market observation",
  };
}

function finite(value, fallback = null) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Liquidity-aware slippage in basis points.
 * Impact grows with the fraction of pool liquidity an order consumes.
 */
export function slippageBpsFor({ notionalUsd, liquidityUsd, friction }) {
  const notional = finite(notionalUsd, 0);
  const liquidity = finite(liquidityUsd, 0);

  const floor = Math.max(0, finite(friction?.minSlippageBps, 0));
  const cap = Math.max(floor, finite(friction?.slippageCapBps, floor));
  const impact = Math.max(0, finite(friction?.slippageImpact, 0));

  if (notional <= 0) return floor;
  if (liquidity <= 0) return cap;

  const share = clamp(notional / liquidity, 0, 1);
  const modelled = floor + impact * share * 10_000;
  return clamp(modelled, floor, cap);
}

/** Total per-side execution cost in basis points (slippage + adverse buffer). */
export function executionCostBps({ notionalUsd, liquidityUsd, friction }) {
  const slippage = slippageBpsFor({ notionalUsd, liquidityUsd, friction });
  const adverse = Math.max(0, finite(friction?.adverseBufferBps, 0));
  const cap = Math.max(slippage, finite(friction?.slippageCapBps, slippage));
  return clamp(slippage + adverse, 0, cap + adverse);
}

/**
 * Simulate a buy. `notionalUsd` is the cash the agent commits, including the
 * simulated fee.
 */
export function simulateEntry({ price, notionalUsd, liquidityUsd, friction }) {
  const referencePrice = finite(price);
  const notional = finite(notionalUsd);

  if (referencePrice === null || referencePrice <= 0) {
    return { ok: false, reason: "no-observable-price", qty: 0, cashSpent: 0 };
  }
  if (notional === null || notional <= 0) {
    return { ok: false, reason: "no-notional", qty: 0, cashSpent: 0 };
  }

  const feeBps = Math.max(0, finite(friction?.baseFeeBps, 0));
  const costBps = executionCostBps({ notionalUsd: notional, liquidityUsd, friction });
  const executedPrice = referencePrice * (1 + costBps / 10_000);
  const feeUsd = (notional * feeBps) / 10_000;
  const investable = Math.max(0, notional - feeUsd);
  const qty = executedPrice > 0 ? investable / executedPrice : 0;

  if (!Number.isFinite(qty) || qty <= 0) {
    return { ok: false, reason: "unfillable-quantity", qty: 0, cashSpent: 0 };
  }

  return {
    ok: true,
    reason: null,
    referencePrice,
    executedPrice,
    qty,
    cashSpent: notional,
    feeUsd,
    feeBps,
    costBps,
    slippageBps: slippageBpsFor({ notionalUsd: notional, liquidityUsd, friction }),
    /** Extra USD lost purely to friction versus a frictionless fill. */
    frictionUsd: Math.max(0, notional - qty * referencePrice),
  };
}

/** Simulate a sell of `qty` units at the observed reference price. */
export function simulateExit({ qty, price, liquidityUsd, referencePrice = null, friction }) {
  const units = finite(qty);
  const observed = finite(price);

  if (units === null || units <= 0) {
    return { ok: false, reason: "no-position", netProceeds: 0, qty: 0 };
  }
  if (observed === null || observed <= 0) {
    return { ok: false, reason: "no-observable-price", netProceeds: 0, qty: 0 };
  }

  const notionalUsd = units * observed;
  const feeBps = Math.max(0, finite(friction?.baseFeeBps, 0));
  const costBps = executionCostBps({ notionalUsd, liquidityUsd, friction });
  const executedPrice = observed * (1 - costBps / 10_000);
  const grossProceeds = units * executedPrice;
  const feeUsd = (grossProceeds * feeBps) / 10_000;
  const netProceeds = grossProceeds - feeUsd;

  if (!Number.isFinite(netProceeds)) {
    return { ok: false, reason: "unfillable-proceeds", netProceeds: 0, qty: 0 };
  }

  const entryReference = finite(referencePrice, observed);

  return {
    ok: true,
    reason: null,
    referencePrice: observed,
    executedPrice,
    qty: units,
    grossProceeds,
    feeUsd,
    feeBps,
    costBps,
    slippageBps: slippageBpsFor({ notionalUsd, liquidityUsd, friction }),
    netProceeds: Math.max(0, netProceeds),
    /** Price-only P&L, before any simulated friction. */
    grossPnl: units * (observed - entryReference),
    frictionUsd: Math.max(0, units * observed - netProceeds),
  };
}
