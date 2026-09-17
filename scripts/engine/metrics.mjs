/**
 * Performance metrics and the robustness score.
 *
 * Every number here is derived from simulated paper accounting: net equity
 * already includes fees and slippage, and per-trade P&L comes from the paper
 * fill engine.
 *
 * Two hard rules:
 *
 *   1. A genome that made money in one lucky trade must not outrank a genome
 *      that made money across many independent observations. Concentration and
 *      single-trade dependence are therefore explicit penalties.
 *   2. Insufficient evidence is reported as `INSUFFICIENT SAMPLE`. A two-trade
 *      "champion" is not a champion, and the code says so rather than inventing
 *      confidence.
 *
 * None of this predicts future profitability. It is a ranking heuristic that
 * penalises the ways a paper backtest most easily lies.
 */

export const RESULT_CLASS = Object.freeze({
  INSUFFICIENT_SAMPLE: "insufficient-sample",
  FAILED_VALIDATION: "failed-validation",
  PASSED_VALIDATION: "passed-validation",
  TEST_COMPLETED: "test-completed",
});

export const INSUFFICIENT_SAMPLE_LABEL = "INSUFFICIENT SAMPLE";

export const DEFAULT_EVIDENCE = Object.freeze({
  minTrades: 20,
  minDistinctMints: 4,
  minObservations: 200,
  minExposureTicks: 40,
});

export const DEFAULT_ROBUSTNESS = Object.freeze({
  returnScale: 0.15,
  drawdownWeight: 0.25,
  costDragWeight: 0.1,
  concentrationWeight: 0.12,
  consistencyWeight: 0.1,
  activityWeight: 0.05,
  returnWeight: 0.4,
  catastrophicReturn: -0.5,
  catastrophicDrawdown: 0.6,
  buckets: 5,
});

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

/**
 * Summarize one agent's simulated paper performance.
 *
 * @param {object} agent live simulation agent (uses equity, cash, costs, trades,
 *   wins, losses, maxDrawdown, exposureTicks, ledger)
 * @param {{ startingCash: number, ledger?: object[] }} options
 */
export function summarizeAgent(agent, { startingCash = 100, ledger = null } = {}) {
  const base = Number.isFinite(startingCash) && startingCash > 0 ? startingCash : 1;
  const trades = Math.max(0, Math.round(finite(agent?.trades, 0)));
  const equity = finite(agent?.equity, base);
  const netPnl = equity - base;
  const ledgerRows = Array.isArray(ledger)
    ? ledger
    : Array.isArray(agent?.ledger)
      ? agent.ledger
      : [];

  const grossWins = ledgerRows
    .filter((row) => finite(row.net, 0) > 0)
    .reduce((sum, row) => sum + finite(row.net, 0), 0);
  const grossLosses = ledgerRows
    .filter((row) => finite(row.net, 0) < 0)
    .reduce((sum, row) => sum + Math.abs(finite(row.net, 0)), 0);

  const perTrade = ledgerRows.map((row) => finite(row.net, 0));
  const meanTrade = perTrade.length > 0 ? perTrade.reduce((a, b) => a + b, 0) / perTrade.length : 0;
  const variance =
    perTrade.length > 1
      ? perTrade.reduce((sum, value) => sum + (value - meanTrade) ** 2, 0) / (perTrade.length - 1)
      : 0;
  const stdDevTrade = Math.sqrt(Math.max(0, variance));

  const downside = perTrade.filter((value) => value < 0);
  const downsideDeviation =
    downside.length > 0
      ? Math.sqrt(downside.reduce((sum, value) => sum + value ** 2, 0) / downside.length)
      : 0;

  const mintPnl = new Map();
  for (const row of ledgerRows) {
    const mint = typeof row.mint === "string" && row.mint.length > 0 ? row.mint : "unknown";
    mintPnl.set(mint, (mintPnl.get(mint) ?? 0) + finite(row.net, 0));
  }

  const positiveTotal = [...mintPnl.values()]
    .filter((value) => value > 0)
    .reduce((sum, value) => sum + value, 0);
  const maxMintPnl = [...mintPnl.values()].reduce((max, value) => Math.max(max, value), 0);
  const maxTradePnl = perTrade.reduce((max, value) => Math.max(max, value), 0);

  const wins = ledgerRows.filter((row) => finite(row.net, 0) > 0).length;

  const equityCurve = [base, ...ledgerRows.map((row, index) => base + cumulative(perTrade, index))];
  const consistency = bucketConsistency(equityCurve, DEFAULT_ROBUSTNESS.buckets);

  // `costs` is the cumulative simulated friction over the measured stage (used
  // for the churn penalty), while `periodCosts` is the friction inside the
  // equity period being measured, so gross return stays a true gross figure.
  const totalCosts = finite(agent?.costs, 0);
  const periodCosts = finite(agent?.periodCosts ?? agent?.costs, 0);

  return {
    startingCash: base,
    finalEquity: round(equity, 2),
    netReturn: round(netPnl / base, 6),
    netPnl: round(netPnl, 2),
    grossReturn: round((netPnl + periodCosts) / base, 6),
    costs: round(totalCosts, 2),
    periodCosts: round(periodCosts, 2),
    costDrag: round(totalCosts / base, 6),
    trades,
    ledgerTrades: ledgerRows.length,
    winRate: trades > 0 ? round(finite(agent?.wins, 0) / trades, 4) : null,
    ledgerWinRate: ledgerRows.length > 0 ? round(wins / ledgerRows.length, 4) : null,
    profitFactor:
      grossLosses > 0 ? round(grossWins / grossLosses, 4) : grossWins > 0 ? null : 0,
    grossWins: round(grossWins, 2),
    grossLosses: round(grossLosses, 2),
    maxDrawdown: round(clamp01(finite(agent?.maxDrawdown, 0)), 6),
    distinctMints: mintPnl.size,
    distinctMintsTraded: ledgerRows.length,
    exposureTicks: Math.max(0, Math.round(finite(agent?.exposureTicks, 0))),
    observations: Math.max(0, Math.round(finite(agent?.observations, 0))),
    meanTradePnl: round(meanTrade, 4),
    tradeVolatility: round(stdDevTrade, 4),
    downsideDeviation: round(downsideDeviation, 4),
    topMintShare: round(positiveTotal > 0 ? maxMintPnl / positiveTotal : 0, 4),
    topTradeShare: round(positiveTotal > 0 ? maxTradePnl / positiveTotal : 0, 4),
    consistency: round(consistency, 4),
    holding: Boolean(agent?.position),
  };
}

function cumulative(values, index) {
  let sum = 0;
  for (let cursor = 0; cursor <= index && cursor < values.length; cursor += 1) sum += values[cursor];
  return sum;
}

/** Share of the equity curve's buckets that end above their start. */
export function bucketConsistency(equityCurve, buckets = 5) {
  if (!Array.isArray(equityCurve) || equityCurve.length < 4 || buckets < 2) return 0.5;
  const size = Math.max(2, Math.floor(equityCurve.length / buckets));
  let profitable = 0;
  let counted = 0;

  for (let index = 0; index + size <= equityCurve.length; index += size) {
    const start = equityCurve[index];
    const end = equityCurve[index + size - 1];
    counted += 1;
    if (end >= start) profitable += 1;
  }

  if (counted === 0) return 0.5;
  return profitable / counted;
}

/** Evidence gate: has this candidate been tested enough to mean anything? */
export function evaluateEvidence(metrics, thresholds = DEFAULT_EVIDENCE) {
  const checks = [
    { key: "trades", required: thresholds.minTrades, actual: metrics.trades, label: "closed paper trades" },
    {
      key: "distinctMints",
      required: thresholds.minDistinctMints,
      actual: metrics.distinctMints,
      label: "distinct token mints traded",
    },
    {
      key: "observations",
      required: thresholds.minObservations,
      actual: metrics.observations,
      label: "market observations",
    },
    {
      key: "exposureTicks",
      required: thresholds.minExposureTicks,
      actual: metrics.exposureTicks,
      label: "ticks exposed to the market",
    },
  ];

  const failed = checks.filter((check) => finite(check.actual, 0) < check.required);

  return {
    sufficient: failed.length === 0,
    label: failed.length === 0 ? "SAMPLE OK" : INSUFFICIENT_SAMPLE_LABEL,
    checks: checks.map((check) => ({
      ...check,
      pass: finite(check.actual, 0) >= check.required,
    })),
    missing: failed.map((check) => ({
      metric: check.key,
      required: check.required,
      actual: finite(check.actual, 0),
      label: check.label,
    })),
  };
}

/**
 * Robustness score.
 *
 *   raw = 0.40 * saturate(netReturn / returnScale)     net return, saturating
 *       - 0.25 * maxDrawdown                            pain taken to get there
 *       - 0.10 * min(1, costDrag / returnScale)          friction dependence
 *       - 0.12 * max(topMintShare, topTradeShare)        single-name / single-trade luck
 *       + 0.10 * (2 * consistency - 1)                   time-consistency of P&L
 *       + 0.05 * min(1, trades / minTrades)              evidence of activity
 *       - 0.20 * catastrophic                           tail blow-up penalty
 *
 *   score = 100 * clamp(raw, -1, 1) * confidence
 *
 *   confidence = min(1, sqrt(evidenceCoverage / 4))  where each of the four
 *   evidence gates contributes 1 when met, so a candidate that barely clears the
 *   gates is scaled down rather than trusted.
 *
 * Where `saturate(x) = tanh(x)`. Score range is roughly -100..100.
 */
export function robustnessScore(metrics, { evidence = null, options = {} } = {}) {
  const o = { ...DEFAULT_ROBUSTNESS, ...options };
  const netReturn = finite(metrics.netReturn, 0);
  const saturate = Math.tanh(netReturn / o.returnScale);

  const drawdown = clamp01(finite(metrics.maxDrawdown, 0));
  const costDrag = clamp01(finite(metrics.costDrag, 0) / o.returnScale);
  const concentration = clamp01(
    Math.max(finite(metrics.topMintShare, 0), finite(metrics.topTradeShare, 0)),
  );
  const consistency = 2 * clamp01(finite(metrics.consistency, 0.5)) - 1;
  const activity = Math.min(1, finite(metrics.trades, 0) / Math.max(1, o.minTrades ?? DEFAULT_EVIDENCE.minTrades));
  const catastrophic =
    netReturn <= o.catastrophicReturn || drawdown >= o.catastrophicDrawdown ? 1 : 0;

  const raw =
    o.returnWeight * saturate -
    o.drawdownWeight * drawdown -
    o.costDragWeight * costDrag -
    o.concentrationWeight * concentration +
    o.consistencyWeight * consistency +
    o.activityWeight * activity -
    0.2 * catastrophic;

  const coverage = evidence
    ? evidence.checks.filter((check) => check.pass).length / Math.max(1, evidence.checks.length)
    : 1;
  const confidence = Math.min(1, Math.sqrt(coverage));

  return {
    score: 100 * Math.min(1, Math.max(-1, raw)) * confidence,
    raw: round(raw, 6),
    components: {
      returnTerm: round(o.returnWeight * saturate, 6),
      drawdownTerm: round(-o.drawdownWeight * drawdown, 6),
      costDragTerm: round(-o.costDragWeight * costDrag, 6),
      concentrationTerm: round(-o.concentrationWeight * concentration, 6),
      consistencyTerm: round(o.consistencyWeight * consistency, 6),
      activityTerm: round(o.activityWeight * activity, 6),
      catastrophicTerm: round(-0.2 * catastrophic, 6),
    },
    confidence: round(confidence, 4),
    catastrophic: catastrophic === 1,
    formula: "0.40*tanh(netReturn/scale) - 0.25*maxDrawdown - 0.10*costDrag - 0.12*concentration + 0.10*consistency + 0.05*activity - 0.20*catastrophic, scaled by evidence confidence, x100",
    scale: o.returnScale,
  };
}

/** Evaluate metrics + robustness + evidence in one call. */
export function evaluateMetrics(metrics, { evidence = DEFAULT_EVIDENCE, robustness = {} } = {}) {
  const gate = evaluateEvidence(metrics, evidence);
  const score = robustnessScore(metrics, { evidence: gate, options: robustness });
  return {
    ...metrics,
    evidence: gate,
    robustness: gate.sufficient ? round(score.score, 4) : null,
    robustnessDetail: score,
    classification: gate.sufficient ? RESULT_CLASS.PASSED_VALIDATION : RESULT_CLASS.INSUFFICIENT_SAMPLE,
  };
}

/** Aggregate the same metric across several seeds without hiding the worst one. */
export function aggregateSeeds(runs) {
  const usable = runs.filter(Boolean);
  if (usable.length === 0) {
    return {
      seeds: 0,
      medianNetReturn: null,
      meanNetReturn: null,
      worstNetReturn: null,
      bestNetReturn: null,
      medianRobustness: null,
      worstRobustness: null,
      medianMaxDrawdown: null,
      worstMaxDrawdown: null,
      totalTrades: 0,
      medianTrades: null,
      insufficientSeeds: 0,
    };
  }

  const sortedReturns = usable.map((run) => finite(run.netReturn, 0)).sort((a, b) => a - b);
  const robustnessValues = usable
    .map((run) => run.robustness)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  const drawdowns = usable.map((run) => finite(run.maxDrawdown, 0)).sort((a, b) => a - b);
  const trades = usable.map((run) => finite(run.trades, 0)).sort((a, b) => a - b);

  const median = (values) =>
    values.length === 0 ? null : round(values[Math.floor(values.length / 2)], 6);

  return {
    seeds: usable.length,
    medianNetReturn: median(sortedReturns),
    meanNetReturn: round(
      sortedReturns.reduce((sum, value) => sum + value, 0) / sortedReturns.length,
      6,
    ),
    worstNetReturn: sortedReturns[0] ?? null,
    bestNetReturn: sortedReturns[sortedReturns.length - 1] ?? null,
    medianRobustness: median(robustnessValues),
    worstRobustness: robustnessValues[0] ?? null,
    bestRobustness: robustnessValues[robustnessValues.length - 1] ?? null,
    medianMaxDrawdown: median(drawdowns),
    worstMaxDrawdown: drawdowns[drawdowns.length - 1] ?? null,
    totalTrades: trades.reduce((sum, value) => sum + value, 0),
    medianTrades: median(trades),
    insufficientSeeds: usable.filter((run) => run.robustness === null).length,
  };
}

/**
 * Stage-level accounting view of a live agent.
 *
 * The simulation resets each agent's bankroll every generation (that is what
 * natural selection selects on), which would also erase the evidence needed to
 * judge whether a genome is more than lucky. The stage view therefore measures
 * the two things separately:
 *
 *   equity / maxDrawdown   the current generation, net of simulated costs
 *   trades / mints / costs cumulative over the agent's whole life in the stage
 *
 * A genome that made one big win must still show the trades, distinct mints and
 * exposure that would justify calling it tested.
 */
export function stageView(agent) {
  if (!agent) return null;
  return {
    equity: agent.equity,
    cash: agent.cash,
    costs: agent.stageCosts ?? agent.costs,
    periodCosts: agent.periodCosts ?? agent.costs,
    trades: agent.stageTrades ?? agent.trades,
    wins: agent.stageWins ?? agent.wins,
    losses: agent.stageLosses ?? agent.losses,
    maxDrawdown: Math.max(finite(agent.maxDrawdown, 0), finite(agent.stageMaxDrawdown, 0)),
    exposureTicks: agent.stageExposureTicks ?? agent.exposureTicks,
    observations: agent.stageObservations ?? agent.observations,
    realizedPnl: agent.stagePnl ?? agent.realizedPnl,
    position: agent.position,
    ledger: agent.stageLedger ?? agent.ledger,
  };
}

/** Metrics for a whole replay stage, from an agent's cumulative accounting. */
export function summarizeStage(agent, { startingCash = 100 } = {}) {
  return summarizeAgent(stageView(agent), { startingCash });
}

export { round as roundMetric, clamp01 };
