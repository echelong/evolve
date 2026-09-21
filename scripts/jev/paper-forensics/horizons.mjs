/**
 * EVOLVE Phase 5I-PS.1 — forward-return forensic analysis (§6, §7, §8).
 *
 * This is explicitly POST-HOC: for every captured decision the analyzer looks
 * FORWARD at the captured SOL reference prices and measures what happened at
 * five fixed horizons. The future is used ONLY to evaluate — it never feeds a
 * decision (see `counterfactual.mjs`, which is a strictly chronological fold).
 *
 * No price is ever interpolated, no observation is fabricated: when there is no
 * captured event at or after a target horizon, the horizon is marked
 * `available: false` with an explicit reason.
 *
 * Brier score and log loss here are DEVELOPMENT POST-HOC diagnostics. They are
 * NOT Phase 5I evidence and must never be mixed with replication metrics.
 *
 * PAPER ONLY / POST-HOC.
 */

import {
  PAPER_FORENSICS_HORIZONS_SECONDS,
  PAPER_FORENSICS_METRIC_BANNER,
  PAPER_FORENSICS_PROBABILITY_BINS,
  PAPER_FORENSICS_TOLERANCE,
  describe,
  finiteOrNull,
  roundTo,
} from "./definition.mjs";

export const PAPER_FORENSICS_HORIZONS_VERSION = 1;
export const PAPER_FORENSICS_TIE = "TIE";
export const PAPER_FORENSICS_HIGHER = "HIGHER";
export const PAPER_FORENSICS_LOWER = "LOWER";

/** The observation time of one captured decision, in ms since epoch. */
export function observedAtMsOf(event) {
  const observed = Date.parse(String(event?.observedAt ?? ""));
  if (Number.isFinite(observed)) return observed;
  const scheduled = Date.parse(String(event?.scheduledAt ?? ""));
  return Number.isFinite(scheduled) ? scheduled : null;
}

/** HIGHER / LOWER / TIE for one price pair. Never interpolated. */
export function outcomeOf(startPrice, futurePrice) {
  if (!Number.isFinite(startPrice) || !Number.isFinite(futurePrice)) return null;
  if (futurePrice > startPrice) return PAPER_FORENSICS_HIGHER;
  if (futurePrice < startPrice) return PAPER_FORENSICS_LOWER;
  return PAPER_FORENSICS_TIE;
}

/** The Jev intent of one event, or null when it produced no usable probability. */
export function intentOf(event) {
  return event?.modelIntent === PAPER_FORENSICS_HIGHER || event?.modelIntent === PAPER_FORENSICS_LOWER
    ? event.modelIntent
    : null;
}

/**
 * One forward observation for decision `index` at one horizon. The search for
 * the matching observation starts at `index + 1`, so a horizon can never be
 * satisfied by the decision's own event.
 */
export function forwardObservationAt({ events, times, index, horizonSeconds }) {
  const requestedHorizonMs = horizonSeconds * 1_000;
  const startPrice = finiteOrNull(events[index]?.referencePrice);
  const startMs = times[index];
  const base = {
    requestedHorizonMs,
    available: false,
    actualHorizonMs: null,
    startPrice,
    futurePrice: null,
    futureSequence: null,
    futureObservedAt: null,
    forwardReturn: null,
    actualOutcome: null,
    correctDirection: null,
    unavailableReason: null,
  };
  if (startMs === null || !Number.isFinite(startPrice) || startPrice <= 0) {
    return { ...base, unavailableReason: "no_start_observation" };
  }
  const targetMs = startMs + requestedHorizonMs;
  for (let cursor = index + 1; cursor < events.length; cursor += 1) {
    const candidateMs = times[cursor];
    if (candidateMs === null || candidateMs < targetMs) continue;
    const futurePrice = finiteOrNull(events[cursor]?.referencePrice);
    if (!Number.isFinite(futurePrice) || futurePrice <= 0) {
      return { ...base, actualHorizonMs: candidateMs - startMs, futureSequence: events[cursor]?.sequence, unavailableReason: "first_horizon_event_has_no_price" };
    }
    const intent = intentOf(events[index]);
    const actualOutcome = outcomeOf(startPrice, futurePrice);
    return {
      requestedHorizonMs,
      available: true,
      actualHorizonMs: candidateMs - startMs,
      startPrice,
      futurePrice,
      futureSequence: events[cursor]?.sequence ?? cursor + 1,
      futureObservedAt: events[cursor]?.observedAt ?? null,
      forwardReturn: roundTo((futurePrice - startPrice) / startPrice, 12),
      actualOutcome,
      // A TIE is NOT a correct direction: the price did not go where Jev said.
      correctDirection: intent === null ? null : actualOutcome !== PAPER_FORENSICS_TIE && intent === actualOutcome,
      unavailableReason: null,
    };
  }
  return { ...base, unavailableReason: "no_observation_at_or_after_horizon" };
}

/** Clip a probability into the log-safe interval (never evaluates ln(0)). */
export function clipProbability(value) {
  const bound = PAPER_FORENSICS_TOLERANCE.probabilityClip;
  return Math.min(1 - bound, Math.max(bound, value));
}

/** Brier score and log loss of one (pHigher, outcome) sample set. */
export function scoreProbabilitySamples(samples) {
  const scored = (Array.isArray(samples) ? samples : []).filter(
    (sample) =>
      Number.isFinite(sample?.pHigher) &&
      (sample?.actualOutcome === PAPER_FORENSICS_HIGHER ||
        sample?.actualOutcome === PAPER_FORENSICS_LOWER ||
        sample?.actualOutcome === PAPER_FORENSICS_TIE),
  );
  if (scored.length === 0) {
    return { count: 0, brierScore: null, logLoss: null, clippedCount: 0, higherOutcomeRate: null };
  }
  let brier = 0;
  let logLoss = 0;
  let clippedCount = 0;
  let higher = 0;
  for (const sample of scored) {
    // The target is "did the price go HIGHER": a TIE did not go higher.
    const y = sample.actualOutcome === PAPER_FORENSICS_HIGHER ? 1 : 0;
    if (y === 1) higher += 1;
    const probability = sample.pHigher;
    brier += (probability - y) ** 2;
    const clipped = clipProbability(probability);
    if (clipped !== probability) clippedCount += 1;
    logLoss += -(y * Math.log(clipped) + (1 - y) * Math.log(1 - clipped));
  }
  return {
    count: scored.length,
    brierScore: roundTo(brier / scored.length, 12),
    logLoss: roundTo(logLoss / scored.length, 12),
    clippedCount,
    higherOutcomeRate: roundTo(higher / scored.length, 12),
  };
}

/** One horizon's aggregate metrics (§7). */
export function computeHorizonMetrics(decisions, horizonSeconds) {
  const key = String(horizonSeconds);
  const rows = decisions.map((decision) => ({
    ...decision.horizons[key],
    pHigher: decision.pHigher,
    jevIntent: decision.modelIntent,
  }));
  const available = rows.filter((row) => row.available === true);
  const higherOutcomes = available.filter((row) => row.actualOutcome === PAPER_FORENSICS_HIGHER).length;
  const lowerOutcomes = available.filter((row) => row.actualOutcome === PAPER_FORENSICS_LOWER).length;
  const tieOutcomes = available.filter((row) => row.actualOutcome === PAPER_FORENSICS_TIE).length;
  const directional = available.filter(row => row.jevIntent !== null);
  const correct = directional.filter((row) => row.correctDirection === true).length;
  const nonTie = directional.filter(row => row.actualOutcome !== PAPER_FORENSICS_TIE).length;
  const afterHigher = available.filter((row) => row.jevIntent === PAPER_FORENSICS_HIGHER);
  const afterLower = available.filter((row) => row.jevIntent === PAPER_FORENSICS_LOWER);
  const score = scoreProbabilitySamples(available);
  const higherReturns = describe(afterHigher.map((row) => row.forwardReturn));
  const lowerReturns = describe(afterLower.map((row) => row.forwardReturn));

  return {
    requestedHorizonSeconds: horizonSeconds,
    requestedHorizonMs: horizonSeconds * 1_000,
    n: available.length,
    unavailable: rows.length - available.length,
    higherOutcomes,
    lowerOutcomes,
    tieOutcomes,
    directionalSampleCount: directional.length,
    directionalAccuracy: directional.length > 0 ? roundTo(correct / directional.length, 12) : null,
    directionalAccuracyExcludingTies: nonTie > 0 ? roundTo(correct / nonTie, 12) : null,
    directionalAccuracyBasis: "correct directions / available observations with Jev intent (a TIE is not a correct direction)",
    brierScore: score.brierScore,
    logLoss: score.logLoss,
    scoredCount: score.count,
    clippedProbabilityCount: score.clippedCount,
    higherOutcomeRate: score.higherOutcomeRate,
    higherIntentCount: afterHigher.length,
    lowerIntentCount: afterLower.length,
    meanForwardReturnAfterJevHigher: higherReturns.mean,
    meanForwardReturnAfterJevLower: lowerReturns.mean,
    medianForwardReturnAfterJevHigher: higherReturns.median,
    medianForwardReturnAfterJevLower: lowerReturns.median,
    meanForwardReturnAll: describe(available.map((row) => row.forwardReturn)).mean,
    actualHorizonMs: describe(available.map((row) => row.actualHorizonMs)),
    interpolationUsed: false,
    fabricatedObservations: 0,
    banner: PAPER_FORENSICS_METRIC_BANNER,
  };
}


/**
 * The complete forward-return forensic analysis (§6) plus horizon metrics (§7).
 *
 * @param {{ events?: object[], horizonsSeconds?: number[] }} input
 */
export function analyzeHorizons({ events = [], horizonsSeconds = PAPER_FORENSICS_HORIZONS_SECONDS } = {}) {
  const horizons = [...horizonsSeconds];
  const times = events.map((event) => observedAtMsOf(event));
  const decisions = events.map((event, index) => {
    const perHorizon = {};
    for (const horizonSeconds of horizons) {
      perHorizon[String(horizonSeconds)] = forwardObservationAt({ events, times, index, horizonSeconds });
    }
    return {
      sequence: event?.sequence ?? index + 1,
      observedAt: event?.observedAt ?? null,
      observedAtMs: times[index],
      referencePrice: finiteOrNull(event?.referencePrice),
      pHigher: finiteOrNull(event?.pHigher),
      modelIntent: intentOf(event),
      horizons: perHorizon,
    };
  });

  return {
    version: PAPER_FORENSICS_HORIZONS_VERSION,
    postHoc: true,
    horizonsSeconds: horizons,
    horizonMatchingRule: "the FIRST captured event at or after the target horizon (no interpolation, no fabrication)",
    interpolationUsed: false,
    fabricatedObservations: 0,
    decisionsObserved: events.length,
    horizonMetrics: horizons.map((horizonSeconds) => computeHorizonMetrics(decisions, horizonSeconds)),
    decisions,
    banner: PAPER_FORENSICS_METRIC_BANNER,
    notes: [
      "Forward returns are measured on the captured reference prices; they describe what happened, not what would have been earned.",
      "Brier score and log loss are DEVELOPMENT POST-HOC diagnostics and are NEVER Phase 5I evidence.",
    ],
  };
}

/**
 * Probability-bucket diagnostics (§8). Descriptive only: no bucket is labelled
 * profitable/good/optimal/best, and no threshold is derived from them.
 */
export function analyzeProbabilityBuckets({ decisions = [] } = {}) {
  const buckets = [];
  for (const bin of PAPER_FORENSICS_PROBABILITY_BINS) {
    const inBin = decisions.filter((decision) => {
      const value = decision.pHigher;
      if (!Number.isFinite(value)) return false;
      return probabilityBinMatches(bin, value);
    });
    const with30 = inBin.filter((decision) => decision.horizons?.["30"]?.available === true);
    const correct30 = with30.filter((decision) => decision.horizons["30"].correctDirection === true).length;
    const higher30 = with30.filter((decision) => decision.horizons["30"].actualOutcome === PAPER_FORENSICS_HIGHER).length;
    const meanReturn = (horizonSeconds) => {
      const rows = inBin
        .map((decision) => decision.horizons?.[String(horizonSeconds)])
        .filter((row) => row?.available === true && Number.isFinite(row.forwardReturn));
      return rows.length > 0 ? describe(rows.map((row) => row.forwardReturn)).mean : null;
    };
    buckets.push({
      id: bin.id,
      label: bin.label,
      n: inBin.length,
      nWith30sObservation: with30.length,
      meanPHigher: describe(inBin.map((decision) => decision.pHigher)).mean,
      higherOutcomeRate: with30.length > 0 ? roundTo(higher30 / with30.length, 12) : null,
      directionalAccuracy: with30.length > 0 ? roundTo(correct30 / with30.length, 12) : null,
      meanForwardReturn30s: meanReturn(30),
      meanForwardReturn60s: meanReturn(60),
      meanForwardReturn120s: meanReturn(120),
      meanForwardReturn300s: meanReturn(300),
      basis: "outcome rate and directional accuracy use the 30 s horizon; returns are per fixed horizon",
      labelPolicy: "descriptive only — no bucket is profitable/good/optimal/best/winning",
    });
  }
  return {
    binsFrozen: true,
    binCount: PAPER_FORENSICS_PROBABILITY_BINS.length,
    buckets,
    thresholdDerived: null,
    thresholdDerivationPermitted: false,
    notes: [
      "Buckets are descriptive development diagnostics; no trading threshold may be derived from them.",
      "Buckets are NOT a validated calibration curve and make no profitability claim.",
    ],
  };
}

/** One bin membership test, shared with the signal histogram bins. */
function probabilityBinMatches(bin, value) {
  if (bin.exactly !== undefined) return value === bin.exactly;
  const aboveLower =
    bin.lowerInclusive === undefined
      ? bin.lowerExclusive === undefined || value > bin.lowerExclusive
      : value >= bin.lowerInclusive;
  const belowUpper = bin.upperExclusive === undefined || value < bin.upperExclusive;
  return aboveLower && belowUpper;
}

