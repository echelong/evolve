/**
 * EVOLVE Phase 5I-PS.1 — captured `pHigher` stream diagnostics (§5, §8).
 *
 * Descriptive only. The histogram uses the FROZEN bins of `definition.mjs`; no
 * boundary is optimized, added, or removed, and no bucket is ever labelled
 * "profitable", "good", "optimal", "best" or "winning". `pHigher` is a
 * probability: the only admissible reading of its distance from 0.50 is the
 * explicitly named `distanceFromHalf`, which is NOT a confidence measure.
 *
 * PAPER ONLY / POST-HOC.
 */

import {
  PAPER_FORENSICS_INTENT_THRESHOLD,
  PAPER_FORENSICS_PROBABILITY_BINS,
  describe,
  finiteOrNull,
  roundTo,
} from "./definition.mjs";

export const PAPER_FORENSICS_SIGNAL_VERSION = 1;

/** The frozen bin one probability belongs to, or null when it is not finite. */
export function probabilityBinFor(pHigher) {
  const value = finiteOrNull(pHigher);
  if (value === null) return null;
  for (const bin of PAPER_FORENSICS_PROBABILITY_BINS) {
    if (bin.exactly !== undefined) {
      if (value === bin.exactly) return bin.id;
      continue;
    }
    const aboveLower =
      bin.lowerInclusive === undefined
        ? bin.lowerExclusive === undefined || value > bin.lowerExclusive
        : value >= bin.lowerInclusive;
    const belowUpper = bin.upperExclusive === undefined || value < bin.upperExclusive;
    if (aboveLower && belowUpper) return bin.id;
  }
  return null;
}

/** Count the frozen histogram over a probability stream (every bin always present). */
export function buildProbabilityHistogram(probabilities) {
  const counts = new Map(PAPER_FORENSICS_PROBABILITY_BINS.map((bin) => [bin.id, 0]));
  let unclassifiable = 0;
  let total = 0;
  for (const value of probabilities) {
    total += 1;
    const bin = probabilityBinFor(value);
    if (bin === null) unclassifiable += 1;
    else counts.set(bin, counts.get(bin) + 1);
  }
  return {
    bins: PAPER_FORENSICS_PROBABILITY_BINS.map((bin) => ({
      id: bin.id,
      label: bin.label,
      count: counts.get(bin.id) ?? 0,
      share: total > 0 ? roundTo((counts.get(bin.id) ?? 0) / total, 12) : null,
    })),
    unclassifiable,
  };
}

/** Adjacent-pair transitions between two labels (null breaks the pair). */
function countTransitions(labels) {
  let transitions = 0;
  for (let index = 1; index < labels.length; index += 1) {
    const previous = labels[index - 1];
    const current = labels[index];
    if (previous === null || current === null) continue;
    if (previous !== current) transitions += 1;
  }
  return transitions;
}

/** A compact description of a run-length list. */
function describeRuns(lengths) {
  return {
    runCount: lengths.length,
    lengths,
    max: lengths.length > 0 ? Math.max(...lengths) : null,
    mean:
      lengths.length > 0
        ? roundTo(lengths.reduce((total, value) => total + value, 0) / lengths.length, 12)
        : null,
  };
}

/**
 * Full descriptive analysis of the captured probability stream (§5).
 *
 * @param {{ session?: object|null, summary?: object|null, events?: object[] }} input
 */
export function analyzeSignal({ session = null, summary = null, events = [] } = {}) {
  const probabilities = events.map((event) => finiteOrNull(event?.pHigher));
  const finiteProbabilities = probabilities.filter((value) => value !== null);
  const intents = events.map((event) =>
    event?.modelIntent === "HIGHER" || event?.modelIntent === "LOWER" ? event.modelIntent : null,
  );

  const runs = intents.reduce((out, intent) => {
    const value = intent === "HIGHER" ? true : intent === "LOWER" ? false : null;
    if (out.at(-1)?.value === value) out.at(-1).length += 1;
    else out.push({ value, length: 1 });
    return out;
  }, []);
  const higherRunLengths = runs.filter((run) => run.value === true).map((run) => run.length);
  const lowerRunLengths = runs.filter((run) => run.value === false).map((run) => run.length);

  const boundaryLabels = probabilities.map((value) =>
    value === null ? null : value >= PAPER_FORENSICS_INTENT_THRESHOLD ? "HIGHER" : "LOWER",
  );
  const intentFlips = countTransitions(intents);
  const boundaryCrossings = countTransitions(boundaryLabels);

  const histogram = buildProbabilityHistogram(finiteProbabilities);
  const distances = finiteProbabilities.map((value) => Math.abs(value - PAPER_FORENSICS_INTENT_THRESHOLD));
  const descriptive = describe(finiteProbabilities);

  return {
    version: PAPER_FORENSICS_SIGNAL_VERSION,
    sessionId: session?.sessionId ?? null,
    decisions: events.length,
    probabilityCount: finiteProbabilities.length,
    probabilityUnavailable: events.length - finiteProbabilities.length,
    mean: descriptive.mean,
    median: descriptive.median,
    stddev: descriptive.stddev,
    min: descriptive.min,
    max: descriptive.max,
    sum: descriptive.sum,
    pHigherEqualsHalfCount: finiteProbabilities.filter((value) => value === PAPER_FORENSICS_INTENT_THRESHOLD).length,
    higherCount: intents.filter((intent) => intent === "HIGHER").length,
    lowerCount: intents.filter((intent) => intent === "LOWER").length,
    intentUnavailableCount: intents.filter((intent) => intent === null).length,
    summaryHigherCount: summary?.higherCount ?? null,
    summaryLowerCount: summary?.lowerCount ?? null,
    consecutiveHigherRuns: describeRuns(higherRunLengths),
    consecutiveLowerRuns: describeRuns(lowerRunLengths),
    intentFlips,
    boundaryCrossings,
    intentFlipsEqualBoundaryCrossings: intentFlips === boundaryCrossings,
    histogram,
    /** Explicitly named: the ONLY admissible reading of distance from 0.50. */
    distanceFromHalf: {
      mean:
        distances.length > 0
          ? roundTo(distances.reduce((total, value) => total + value, 0) / distances.length, 12)
          : null,
      max: distances.length > 0 ? roundTo(Math.max(...distances), 12) : null,
      min: distances.length > 0 ? roundTo(Math.min(...distances), 12) : null,
      note: "distanceFromHalf is |pHigher - 0.50|. It is NOT a confidence measure and must never be reported as one.",
    },
    binsFrozen: true,
    binLabels: PAPER_FORENSICS_PROBABILITY_BINS.map((bin) => bin.label),
    notes: [
      "Descriptive statistics of a captured stream; no inference, no interval, no p-value, no confidence claim.",
      "The histogram bins are frozen in source and were chosen before any result was observed.",
      "The 0.50 boundary is the frozen recorded policy boundary; it is never swept or re-tuned here.",
    ],
  };
}

