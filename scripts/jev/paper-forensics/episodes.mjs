/**
 * EVOLVE Phase 5I-PS.1 — trading EPISODE reconstruction, friction decomposition
 * and turnover/churn diagnostics (§9, §10, §11).
 *
 * Every number here is read from the captured event stream or derived from it by
 * the documented accounting identity. Nothing is repaired: when the
 * reconstruction disagrees with the source accounting, the disagreement is
 * REPORTED (and flagged), never corrected.
 *
 * The accounting identity used throughout is exactly:
 *
 *   netPnl = grossPnl - totalCosts
 *   totalCosts = fees + executionCost        (executionCost = slippage + adverse)
 *
 * No causality beyond that identity is ever claimed.
 *
 * PAPER ONLY / POST-HOC.
 */

import { PAPER_FORENSICS_TOLERANCE, describe, finiteOrNull, roundTo } from "./definition.mjs";

export const PAPER_FORENSICS_EPISODES_VERSION = 1;

/** The absolute USD epsilon used when the reconstruction is compared to the source. */
export const PAPER_FORENSICS_ACCOUNT_EPSILON = PAPER_FORENSICS_TOLERANCE.accountUsd;

/** One recorded paper fill, reduced to the fields an episode needs. */
export function fillOf(event, side) {
  const fill = event?.paperFill;
  if (!fill || fill.side !== side) return null;
  return {
    referencePrice: finiteOrNull(fill.referencePrice),
    executedPrice: finiteOrNull(fill.executedPrice),
    qty: finiteOrNull(fill.qty),
    notional: finiteOrNull(fill.notional),
    feeUsd: finiteOrNull(fill.feeUsd),
    slippageBps: finiteOrNull(fill.slippageBps),
    costBps: finiteOrNull(fill.costBps),
    frictionUsd: finiteOrNull(fill.frictionUsd),
  };
}

/** ms between two ISO timestamps, or null when either is unparsable. */
export function elapsedMs(fromIso, toIso) {
  const from = Date.parse(String(fromIso ?? ""));
  const to = Date.parse(String(toIso ?? ""));
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return to - from;
}

/** Percent move between two reference prices, or null when either is unusable. */
export function priceMovePct(entryPrice, exitPrice) {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(exitPrice)) return null;
  return roundTo(100 * (exitPrice - entryPrice) / entryPrice, 12);
}

/**
 * Reconstruct every recorded paper round trip from the captured events (§9).
 *
 * The fold is chronological and streaming: an OPEN is created only by an
 * executed `ENTER` (BUY fill) and closed only by an executed `EXIT` (SELL fill).
 * An unfilled ENTER/EXIT never opens or closes an episode.
 *
 * @param {{ events?: object[] }} input
 */
export function reconstructEpisodes({ events = [] } = {}) {
  const episodes = [];
  let previousRealizedPnl = 0;
  let previousCosts = 0;
  let open = null;

  for (const event of events) {
    const realizedPnl = finiteOrNull(event?.realizedPnl);
    const costs = finiteOrNull(event?.costs);

    if (event?.action === "ENTER") {
      const fill = fillOf(event, "BUY");
      if (fill !== null) {
        open = {
          entrySequence: event.sequence ?? null,
          entryObservedAt: event?.observedAt ?? null,
          entryScheduledAt: event?.scheduledAt ?? null,
          entryReferencePrice: fill.referencePrice,
          entryExecutedPrice: fill.executedPrice,
          entryQty: fill.qty,
          entryNotional: fill.notional,
          entryFeeUsd: fill.feeUsd,
          entryPHigher: finiteOrNull(event?.pHigher),
          entryIntent: event?.modelIntent ?? null,
          entryStateDigest: event?.stateDigest ?? null,
          entryPacketDigest: event?.packetDigest ?? null,
          decisionCountInEpisode: 1,
          holdCountInEpisode: 0,
          realizedPnlBefore: previousRealizedPnl,
          costsBefore: previousCosts,
        };
      }
    } else if (open !== null) {
      open.decisionCountInEpisode += 1;
      if (event?.action === "HOLD") open.holdCountInEpisode += 1;
      if (event?.action === "EXIT") {
        const fill = fillOf(event, "SELL");
        if (fill !== null) {
          const grossPnl = fill.qty * (fill.referencePrice - open.entryReferencePrice);
          const netPnl = Number.isFinite(realizedPnl) ? realizedPnl - open.realizedPnlBefore : grossPnl;
          const totalCosts = Number.isFinite(costs) ? costs - open.costsBefore : null;
          const fees =
            (Number.isFinite(open.entryFeeUsd) ? open.entryFeeUsd : 0) +
            (Number.isFinite(fill.feeUsd) ? fill.feeUsd : 0);
          episodes.push({
            status: "COMPLETE",
            ...open,
            exitSequence: event.sequence ?? null,
            exitObservedAt: event?.observedAt ?? null,
            exitReferencePrice: fill.referencePrice,
            exitExecutedPrice: fill.executedPrice,
            exitQty: fill.qty,
            exitNotional: fill.notional,
            exitFeeUsd: fill.feeUsd,
            exitPHigher: finiteOrNull(event?.pHigher),
            exitIntent: event?.modelIntent ?? null,
            holdingMs: elapsedMs(open.entryObservedAt, event?.observedAt),
            decisionsHeld:
              Number.isFinite(event?.sequence) && Number.isFinite(open.entrySequence)
                ? event.sequence - open.entrySequence
                : null,
            referencePriceMovePct: priceMovePct(open.entryReferencePrice, fill.referencePrice),
            priceOnlyQty: fill.qty,
            priceOnlyGrossPnl:
              Number.isFinite(fill.qty) && Number.isFinite(fill.referencePrice) && Number.isFinite(open.entryReferencePrice)
                ? roundTo(fill.qty * (fill.referencePrice - open.entryReferencePrice), 12)
                : null,
            grossPnl: roundTo(grossPnl, 12),
            netPnl: roundTo(netPnl, 12),
            totalCosts: roundTo(totalCosts, 12),
            fees: roundTo(fees, 12),
            executionCost: roundTo(totalCosts === null ? null : totalCosts - fees, 12),
          });
          open = null;
        }
      }
    }

    if (Number.isFinite(realizedPnl)) previousRealizedPnl = realizedPnl;
    if (Number.isFinite(costs)) previousCosts = costs;
  }

  const lastEvent = events[events.length - 1] ?? null;
  if (open !== null) {
    const lastMark = finiteOrNull(lastEvent?.positionMarkPrice);
    episodes.push({
      status: "OPEN_AT_SESSION_END",
      ...open,
      exitSequence: null,
      exitObservedAt: lastEvent?.observedAt ?? null,
      exitReferencePrice: lastMark,
      exitExecutedPrice: null,
      exitQty: null,
      exitNotional: null,
      exitFeeUsd: null,
      exitPHigher: null,
      exitIntent: null,
      holdingMs: elapsedMs(open.entryObservedAt, lastEvent?.observedAt),
      decisionsHeld:
        Number.isFinite(lastEvent?.sequence) && Number.isFinite(open.entrySequence)
          ? lastEvent.sequence - open.entrySequence
          : null,
      referencePriceMovePct: priceMovePct(open.entryReferencePrice, lastMark),
      priceOnlyQty: finiteOrNull(lastEvent?.positionQty),
      priceOnlyGrossPnl: null,
      grossPnl: null,
      netPnl: null,
      totalCosts: null,
      fees: Number.isFinite(open.entryFeeUsd) ? roundTo(open.entryFeeUsd, 12) : null,
      executionCost: null,
      note: "the position was never closed inside the captured session; no round-trip P&L is inferred for it",
    });
  }

  return episodes;
}

/**
 * FRICTION DECOMPOSITION (§10) — one of the primary purposes of the analyzer.
 *
 * The decomposition is a pure accounting identity over the captured stream:
 *
 *   totalGrossPnl = sum(closed episode gross P&L) + open-position price movement
 *   totalCosts    = recorded cost total (final.costs)
 *   totalNetPnl   = totalGrossPnl - totalCosts
 *
 * `adverseReferencePriceMovement` is the sum of the NEGATIVE
 * reference-price-only P&L of closed episodes. `simulatedFrictionContribution`
 * is the recorded cost total. Neither is a causal claim: they are the two terms
 * of the identity.
 */
export function decomposeFriction({ events = [], episodes = [], summary = null } = {}) {
  const closed = episodes.filter((episode) => episode.status === "COMPLETE");
  const finalEvent = events[events.length - 1] ?? null;

  const sumOf = (values) => values.filter((value) => Number.isFinite(value)).reduce((total, value) => total + value, 0);
  const closedGrossPnl = sumOf(closed.map((episode) => episode.grossPnl));
  const totalGrossPnl = closedGrossPnl + (finiteOrNull(finalEvent?.unrealizedPnl) ?? 0);
  const closedNetPnl = sumOf(closed.map((episode) => episode.netPnl));
  const totalNetPnl = finiteOrNull(finalEvent?.netPnl);
  const totalCosts = sumOf(events.map((event) => event.paperFill?.frictionUsd));
  const fees = sumOf(events.map((event) => event.paperFill?.feeUsd));
  const executionCost = totalCosts - fees;
  const priceOnly = closed.map((episode) => episode.priceOnlyGrossPnl).filter((value) => Number.isFinite(value));

  const startingBankroll = finiteOrNull(summary?.startingCash);
  const tradedNotional = sumOf(events.map((event) => event.paperFill?.notional));

  const adversePriceMovementLoss = priceOnly.reduce((total, value) => total + Math.min(0, value), 0);
  const favourablePriceMovementGain = priceOnly.reduce((total, value) => total + Math.max(0, value), 0);

  const breakEvens = closed.map((episode) => ({
    entrySequence: episode.entrySequence,
    exitSequence: episode.exitSequence,
    observedBreakEvenMovementPct:
      Number.isFinite(episode.totalCosts) && Number.isFinite(episode.entryNotional) && episode.entryNotional > 0
        ? roundTo(100 * episode.totalCosts / (episode.entryQty * episode.entryReferencePrice), 12)
        : null,
    basis: "100 * recorded round-trip costs / (entry quantity * entry reference price)",
  }));

  const deltas = {
    grossPnl: Math.abs(closedGrossPnl - ((finiteOrNull(finalEvent?.grossPnl) ?? Number.NaN) - (finiteOrNull(finalEvent?.unrealizedPnl) ?? 0))),
    totalCosts: Math.abs(totalCosts - (finiteOrNull(finalEvent?.costs) ?? Number.NaN)),
    netPnl: Math.abs(closedNetPnl - (finiteOrNull(finalEvent?.realizedPnl) ?? Number.NaN)),
  };
  const reproduction = {
    grossPnl: Number.isFinite(deltas.grossPnl) && deltas.grossPnl <= PAPER_FORENSICS_ACCOUNT_EPSILON,
    totalCosts: Number.isFinite(deltas.totalCosts) && deltas.totalCosts <= PAPER_FORENSICS_ACCOUNT_EPSILON,
    netPnl: Number.isFinite(deltas.netPnl) && deltas.netPnl <= PAPER_FORENSICS_ACCOUNT_EPSILON,
    maxAbsoluteDelta: roundTo(
      Math.max(deltas.grossPnl, deltas.totalCosts, deltas.netPnl),
      12,
    ),
    toleranceUsd: PAPER_FORENSICS_ACCOUNT_EPSILON,
  };
  const flags = [];
  if (!reproduction.grossPnl) {
    flags.push("gross P&L reconstructed by episode disagrees with the recorded realized gross P&L");
  }
  if (!reproduction.totalCosts) flags.push("cost total reconstructed by episode disagrees with the recorded cost total");
  if (!reproduction.netPnl) {
    flags.push("net P&L reconstructed by episode disagrees with the recorded realized P&L");
  }

  return {
    version: PAPER_FORENSICS_EPISODES_VERSION,
    accountingIdentity: "netPnl = grossPnl - totalCosts ; totalCosts = fees + executionCost",
    closedRoundTrips: closed.length,
    openEpisodes: episodes.length - closed.length,
    totalGrossPnl: roundTo(totalGrossPnl, 12),
    totalSimulatedCosts: roundTo(totalCosts, 12),
    totalNetPnl: roundTo(totalNetPnl, 12),
    grossPriceMovementContribution: roundTo(totalGrossPnl, 12),
    simulatedFrictionContribution: roundTo(-totalCosts, 12),
    accountingIdentityResidual: roundTo(totalNetPnl - (totalGrossPnl - totalCosts), 12),
    fees: roundTo(fees, 12),
    executionSlippageAdverseCost: roundTo(executionCost, 12),
    executionCostBreakdown: {
      note:
        "executionCost is the recorded round-trip cost total minus the recorded fees (slippage plus the adverse execution buffer)",
      slippageIncluded: true,
      adverseBufferIncluded: true,
    },
    costOverStartingBankroll:
      Number.isFinite(startingBankroll) && startingBankroll > 0 ? roundTo(totalCosts / startingBankroll, 12) : null,
    costOverTradedNotional: tradedNotional > 0 ? roundTo(totalCosts / tradedNotional, 12) : null,
    startingBankroll,
    tradedNotional: roundTo(tradedNotional, 12),
    adverseReferencePriceMovement: roundTo(adversePriceMovementLoss, 12),
    favourablePriceMovementGain: roundTo(favourablePriceMovementGain, 12),
    
    priceMovementAttributionNote:
      "These two terms are the two sides of the accounting identity, not a causal decomposition. No claim is made that friction or direction alone caused the outcome.",
    observedBreakEvenMovement: {
      definition: "approximate reference-price movement required to offset one episode's recorded round-trip costs",
      unit: "percent of entry reference price; approximate descriptive cost offset",
      episodes: breakEvens,
      descriptive: describe(breakEvens.map((entry) => entry.observedBreakEvenMovementPct)),
      notARecommendedThreshold: true,
      note: "Reported as an observation only. It is never a recommended threshold and no policy is derived from it.",
    },
    reproduction,
    flags,
    disagreementWithSourceAccounting: flags.length > 0,
  };
}

/**
 * TURNOVER / CHURN DIAGNOSTICS (§11).
 *
 * Descriptive counters that let a reader distinguish directional failure,
 * signal instability, excessive turnover and friction domination. The four
 * readings are reported SIDE BY SIDE and no explanation is selected
 * automatically: `selectedExplanation` is always null and the artifact states
 * that explicitly.
 */
export function analyzeChurn({ events = [], episodes = [], summary = null, signal = null } = {}) {
  const closed = episodes.filter((episode) => episode.status === "COMPLETE");
  const entries = events.filter((event) => event?.action === "ENTER").length;
  const exits = events.filter((event) => event?.action === "EXIT").length;
  const holdMs = closed.map((episode) => episode.holdingMs).filter((value) => Number.isFinite(value));
  const holdDescriptive = describe(holdMs);

  // ---- time in market / flat, from the captured per-decision account state ----
  const times = events.map((event) => Date.parse(String(event?.observedAt ?? "")));
  let timeLongMs = 0;
  let timeFlatMs = 0;
  let timeUnmeasurableMs = 0;
  for (let index = 0; index < events.length - 1; index += 1) {
    const span = times[index + 1] - times[index];
    if (!Number.isFinite(span) || span < 0) {
      timeUnmeasurableMs += Math.max(0, Number.isFinite(span) ? 0 : 0);
      continue;
    }
    const qty = finiteOrNull(events[index]?.positionQty) ?? 0;
    if (qty > 0) timeLongMs += span;
    else timeFlatMs += span;
  }
  const spanTotal = timeLongMs + timeFlatMs;

  const entryEvents = events.filter((event) => event?.action === "ENTER");
  const entriesAtExactlyHalf = entryEvents.filter(
    (event) => finiteOrNull(event?.pHigher) === 0.5,
  ).length;
  const exitLagCounts = (thresholdMs) =>
    closed.filter((episode) => Number.isFinite(episode.holdingMs) && episode.holdingMs <= thresholdMs).length;

  const perRoundTrip = (field) => describe(closed.map((episode) => episode[field]));
  const netPerRoundTrip = perRoundTrip("netPnl");

  // ---- the four candidate readings, measured, never chosen -------------------
  const directionalReading = {
    reading: "adverse_reference_moves",
    measuredBy: "closed round trips whose reference-price move was unfavourable",
    value: closed.filter((episode) => Number.isFinite(episode.referencePriceMovePct) && episode.referencePriceMovePct < 0).length,
    denominator: closed.length,
  };
  const instabilityReading = {
    reading: "intent_flips",
    measuredBy: "intent flips in the captured stream",
    value: finiteOrNull(signal?.intentFlips),
    denominator: events.length,
  };
  const turnoverReading = {
    reading: "round_trips_per_hour",
    measuredBy: "closed round trips per captured hour",
    value: spanTotal > 0 ? roundTo((closed.length / spanTotal) * 3_600_000, 12) : null,
    denominator: null,
  };
  const frictionReading = {
    reading: "cost_to_absolute_gross_pnl",
    measuredBy: "recorded round-trip costs compared with the absolute recorded gross P&L",
    value: (() => {
      const gross = Math.abs(Number(summary?.grossPnl ?? 0));
      const costs = Number(summary?.totalCosts ?? 0);
      return Number.isFinite(gross) && gross > 0 && Number.isFinite(costs) ? roundTo(costs / gross, 12) : null;
    })(),
    denominator: null,
  };

  return {
    version: PAPER_FORENSICS_EPISODES_VERSION,
    paperEntries: entries,
    paperExits: exits,
    roundTrips: closed.length,
    openAtSessionEnd: episodes.length - closed.length,
    sourceEnterCount: summary?.enterCount ?? null,
    sourceExitCount: summary?.exitCount ?? null,
    entriesMatchSource: summary?.enterCount === entries,
    exitsMatchSource: summary?.exitCount === exits,
    meanHoldMs: holdDescriptive.mean,
    medianHoldMs: holdDescriptive.median,
    minHoldMs: holdDescriptive.min,
    maxHoldMs: holdDescriptive.max,
    holdMsSamples: holdMs.length,
    timeLongMs,
    timeFlatMs,
    timeLongShare: spanTotal > 0 ? roundTo(timeLongMs / spanTotal, 12) : null,
    timeFlatShare: spanTotal > 0 ? roundTo(timeFlatMs / spanTotal, 12) : null,
    timeUnmeasurableMs,
    intentFlips: finiteOrNull(signal?.intentFlips),
    entriesCausedByExactly050: entriesAtExactlyHalf,
    exitsWithin30sOfEntry: exitLagCounts(30_000),
    exitsWithin60sOfEntry: exitLagCounts(60_000),
    exitsWithin90sOfEntry: exitLagCounts(90_000),
    costPerRoundTrip: perRoundTrip("totalCosts"),
    grossPnlPerRoundTrip: perRoundTrip("grossPnl"),
    netPnlPerRoundTrip: netPerRoundTrip,
    netRoundTripsNegative: closed.filter((episode) => Number.isFinite(episode.netPnl) && episode.netPnl < 0).length,
    netRoundTripsPositive: closed.filter((episode) => Number.isFinite(episode.netPnl) && episode.netPnl > 0).length,
    netRoundTripsExactlyZero: closed.filter((episode) => finiteOrNull(episode.netPnl) === 0).length,
    candidateReadings: [directionalReading, instabilityReading, turnoverReading, frictionReading],
    selectedExplanation: null,
    selectionPerformed: false,
    note:
      "The four readings are reported side by side as measurements. The analyzer does not choose one as the verdict, and no policy, threshold, or recommendation is derived from them.",
  };
}
