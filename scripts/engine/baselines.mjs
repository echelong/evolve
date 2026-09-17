/**
 * Baseline strategies.
 *
 * Evolution only means something if it beats trivial rules. Every baseline here:
 *
 *   - replays the same dataset window as the evolutionary run
 *   - sees only the current tick's observations (identical look-ahead rules)
 *   - pays exactly the same simulated fees, slippage, adverse buffer, and
 *     liquidity caps through `paper.mjs`
 *   - is scored with the same metrics and robustness formula
 *
 * No baseline trades real money, and none of them can see the future.
 */

import { createSeededRandom } from "../lib/random.mjs";
import { DEFAULT_EVIDENCE, evaluateMetrics, summarizeAgent } from "./metrics.mjs";
import { simulateEntry, simulateExit } from "./paper.mjs";

export const BASELINE = Object.freeze({
  NO_TRADE: "no-trade",
  RANDOM: "random",
  MOMENTUM: "momentum",
  BUY_AND_HOLD: "buy-and-hold-like",
});

export const BASELINE_DESCRIPTIONS = Object.freeze({
  [BASELINE.NO_TRADE]: "Holds 100 paper cash for the whole window. Pays nothing, trades nothing.",
  [BASELINE.RANDOM]: "Enters a uniformly random eligible token with fixed probability per tick, fixed exits.",
  [BASELINE.MOMENTUM]: "Enters the strongest 5m momentum eligible token above a fixed threshold, fixed exits.",
  [BASELINE.BUY_AND_HOLD]: "Buys the deepest-liquidity eligible token once and holds it to the window end.",
});

const FIXED_EXITS = Object.freeze({
  stopLoss: 0.08,
  takeProfit: 0.2,
  maxHold: 24,
});

const FIXED_RULES = Object.freeze({
  momentumThreshold: 0.2,
  buyPressureThreshold: 0.5,
});

/** Minimal paper portfolio sharing the agent accounting shape. */
function createPortfolio({ startingCash, friction, riskFraction = 0.1, maxPositionFraction = 0.28 }) {
  const account = {
    cash: startingCash,
    equity: startingCash,
    maxEquity: startingCash,
    maxDrawdown: 0,
    costs: 0,
    trades: 0,
    wins: 0,
    losses: 0,
    exposureTicks: 0,
    observations: 0,
    ledger: [],
    position: null,
  };

  function mark(byMint) {
    if (account.position) {
      const market = byMint.get(account.position.mint);
      const price = market && market.price > 0 ? market.price : account.position.lastMarkPrice;
      account.position.markPrice = price;
      account.position.lastMarkPrice = price;
      account.equity = account.cash + price * account.position.qty;
    } else {
      account.equity = account.cash;
    }
    account.maxEquity = Math.max(account.maxEquity, account.equity);
    const drawdown =
      account.maxEquity > 0 ? Math.max(0, (account.maxEquity - account.equity) / account.maxEquity) : 0;
    account.maxDrawdown = Math.max(account.maxDrawdown, drawdown);
    return account.equity;
  }

  function canOpen(market) {
    if (!market) return false;
    if (!(market.price > 0) || !(market.liquidity > 0)) return false;
    if (market.fresh !== true) return false;
    return true;
  }

  function open(market, at) {
    if (account.position || !canOpen(market)) return false;
    const notional = Math.min(
      account.cash * riskFraction,
      account.cash * maxPositionFraction,
      market.liquidity * friction.maxLiquidityFraction,
    );
    if (!Number.isFinite(notional) || notional <= 0) return false;

    const fill = simulateEntry({
      price: market.price,
      notionalUsd: notional,
      liquidityUsd: market.liquidity,
      friction,
    });
    if (!fill.ok) return false;

    account.cash -= fill.cashSpent;
    account.costs += fill.frictionUsd;
    account.position = {
      mint: market.mint,
      symbol: market.symbol,
      qty: fill.qty,
      cost: fill.cashSpent,
      entryRefPrice: fill.referencePrice,
      entryLiquidity: market.liquidity,
      lastMarkPrice: market.price,
      markPrice: market.price,
      costFriction: fill.frictionUsd,
      held: 0,
      entryAt: at,
    };
    return true;
  }

  function close(byMint, reason, at) {
    const position = account.position;
    if (!position) return false;
    const market = byMint.get(position.mint) ?? null;
    const price = market && market.price > 0 ? market.price : position.lastMarkPrice;
    const fill = simulateExit({
      qty: position.qty,
      price,
      liquidityUsd: market?.liquidity ?? position.entryLiquidity,
      referencePrice: position.entryRefPrice,
      friction,
    });
    if (!fill.ok) return false;

    account.cash += fill.netProceeds;
    const net = fill.netProceeds - position.cost;
    account.costs += Math.max(0, fill.frictionUsd);
    account.trades += 1;
    if (net >= 0) account.wins += 1;
    else account.losses += 1;
    account.ledger.push({
      mint: position.mint,
      symbol: position.symbol,
      reason,
      net,
      gross: fill.grossPnl,
      cost: position.costFriction + fill.frictionUsd,
      heldTicks: position.held,
      closedAt: at,
    });
    account.position = null;
    mark(byMint);
    return true;
  }

  return { account, mark, open, close, canOpen };
}

/**
 * Run every baseline over one dataset window.
 *
 * @param {{
 *   datasetDir: string,
 *   config: object,
 *   interval: { start: number, end: number },
 *   seed: number | string,
 *   windowLabel?: string,
 *   evidence?: object,
 *   entryProbability?: number,
 * }} options
 */
export async function runBaselines({
  datasetDir,
  config,
  interval,
  seed,
  windowLabel = "W1",
  evidence = DEFAULT_EVIDENCE,
  entryProbability = null,
}) {
  const { openReplayFeed } = await import("../market/replay.mjs");
  const friction = config.paper;
  const startingCash = friction.startingCash;
  const randomEntryProbability =
    entryProbability ?? config.baselines?.randomEntryProbability ?? 0.02;

  const results = [];
  const definitions = [
    { id: BASELINE.NO_TRADE, policy: "none" },
    { id: BASELINE.RANDOM, policy: "random" },
    { id: BASELINE.MOMENTUM, policy: "momentum" },
    { id: BASELINE.BUY_AND_HOLD, policy: "hold" },
  ];

  for (const definition of definitions) {
    const random = createSeededRandom(`${seed}:${definition.id}:${windowLabel}:${interval.start}`);
    const feed = await openReplayFeed({
      datasetDir,
      config,
      speed: "max",
      from: interval.start,
      until: interval.end,
      pacing: false,
      verifyFingerprint: false,
    });

    const portfolio = createPortfolio({
      startingCash,
      friction,
      riskFraction: 0.1,
      maxPositionFraction: friction.maxPositionFraction,
    });

    let ticks = 0;
    let openedOnce = false;

    while (true) {
      const step = await feed.advance();
      if (step.done) break;

      const at = feed.currentTimestamp();
      const markets = feed.markets(at).filter(
        (market) =>
          market.fresh === true &&
          market.price > 0 &&
          market.liquidity >= config.minLiquidityUsd,
      );
      const byMint = new Map(markets.map((market) => [market.mint, market]));
      const account = portfolio.account;
      account.observations += 1;
      ticks += 1;

      if (account.position) {
        account.position.held += 1;
        account.exposureTicks += 1;
        const move =
          account.position.entryRefPrice > 0
            ? account.position.lastMarkPrice / account.position.entryRefPrice - 1
            : 0;
        if (move <= -FIXED_EXITS.stopLoss) portfolio.close(byMint, "STOP", at);
        else if (move >= FIXED_EXITS.takeProfit) portfolio.close(byMint, "TAKE", at);
        else if (account.position.held >= FIXED_EXITS.maxHold) portfolio.close(byMint, "TIME", at);
      }

      if (!account.position && markets.length > 0) {
        if (definition.policy === "random") {
          if (random() < randomEntryProbability) {
            const pick = markets[Math.floor(random() * markets.length)];
            portfolio.open(pick, at);
          }
        } else if (definition.policy === "momentum") {
          const best = markets
            .filter(
              (market) =>
                market.features?.momentum >= FIXED_RULES.momentumThreshold &&
                market.features?.buyPressure >= FIXED_RULES.buyPressureThreshold,
            )
            .reduce((top, market) => (!top || market.features.momentum > top.features.momentum ? market : top), null);
          if (best) portfolio.open(best, at);
        } else if (definition.policy === "hold" && !openedOnce) {
          const deepest = markets.reduce(
            (top, market) => (!top || market.liquidity > top.liquidity ? market : top),
            null,
          );
          if (deepest) {
            openedOnce = portfolio.open(deepest, at);
          }
        }
      }

      portfolio.mark(byMint);
    }

    // Close any residual position at the final observed price so the window's
    // P&L is realised rather than left floating.
    if (portfolio.account.position) {
      const lastAt = feed.currentTimestamp() ?? interval.end;
      const markets = feed.markets(lastAt);
      portfolio.close(new Map(markets.map((market) => [market.mint, market])), "WINDOW-END", lastAt);
    }

    feed.stop();

    const metrics = evaluateMetrics(
      summarizeAgent(portfolio.account, { startingCash }),
      { evidence },
    );

    results.push({
      id: definition.id,
      name: `baseline:${definition.id}`,
      description: BASELINE_DESCRIPTIONS[definition.id],
      windowLabel,
      interval,
      ticks,
      metrics,
      deterministic: definition.id !== BASELINE.RANDOM,
      usesFutureData: false,
    });
  }

  return results;
}

/** Compact comparison table for reports and the dashboard. */
export function summarizeBaselines(baselineResults) {
  return {
    count: baselineResults.length,
    rows: baselineResults.map((entry) => ({
      id: entry.id,
      netReturn: entry.metrics.netReturn,
      robustness: entry.metrics.robustness,
      trades: entry.metrics.trades,
      distinctMints: entry.metrics.distinctMints,
      maxDrawdown: entry.metrics.maxDrawdown,
      costs: entry.metrics.costs,
      classification: entry.metrics.classification,
    })),
  };
}
