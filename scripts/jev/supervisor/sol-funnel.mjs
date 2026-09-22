/** PS.2b observer-only aggregates. Never imported by the engine or packet builder. */
const COUNTERS = [
  "engineTicksObserved", "ticksWithSolInByMint", "ticksWithoutSolInByMint",
  "ticksWithSolInFeedUniverse", "ticksWithFreshSol", "ticksWithEntriesAllowed",
  "ticksWithSolInTradeable", "ticksWithoutSolInTradeable", "flatAgentEntryScans",
  "solAgentEvaluations", "solPassesGates", "solFailsGates", "solScored",
  "solAboveEntryThreshold", "solBelowEntryThreshold", "solExactlyEntryThreshold",
  "solNonFiniteScoreOrThreshold",
  "solOpportunityCandidatesBeforeDedup", "solOpportunityCaptured",
  "solOpportunitySuppressedByAgentGenerationDedup", "solOpportunityCaptureErrors",
  "scoreMarginNegative", "scoreMarginZero", "scoreMarginPositive",
];
const SAMPLE_LIMIT = 32;
const BIN_WIDTH = 0.0001;
const SPECIES_LIMIT = 64;
// Kinds the engine and the PS.2a observer actually emit. Anything else is
// ignored rather than inventing an empty species row.
const OBSERVED_KINDS = new Set(["evaluation", "score", "captured", "suppressed", "capture_error"]);
// scoreMarket is in [-1,1], genome entry thresholds in [0.05,0.85].
// [-2,2] covers scores, thresholds and margins without changing any gate.
function distribution() {
  const bins = new Map();
  let count = 0, sum = 0, min = Infinity, max = -Infinity, outsideRange = 0;
  return {
    add(value) {
      count++; sum += value; min = Math.min(min, value); max = Math.max(max, value);
      if (value < -2 || value > 2) { outsideRange++; return; }
      const index = Math.floor((value + 2) / BIN_WIDTH);
      const bin = bins.get(index) ?? { count: 0, min: value, max: value };
      bin.count++; bin.min = Math.min(bin.min, value); bin.max = Math.max(bin.max, value);
      bins.set(index, bin);
    },
    snapshot() {
      let median = null;
      if (count && !outsideRange) {
        const ranks = [Math.floor((count - 1) / 2), Math.floor(count / 2)];
        let seen = 0, total = 0;
        for (const [, bin] of [...bins].sort((a, b) => a[0] - b[0])) {
          for (const rank of ranks) if (rank >= seen && rank < seen + bin.count) total += (bin.min + bin.max) / 2;
          seen += bin.count;
        }
        median = total / 2;
      }
      return { count, mean: count ? sum / count : null, median, min: count ? min : null, max: count ? max : null, outsideRange };
    },
  };
}

export function createSolFunnel() {
  const counters = Object.fromEntries(COUNTERS.map((key) => [key, 0]));
  const gateFailureCounts = {}, firstFailedGateCounts = {}, species = {};
  const score = distribution(), threshold = distribution(), margin = distribution();
  let latestPresence = null, presenceSamples = [], scoreSamples = [];
  function increment(key, row = null) {
    counters[key]++;
    if (row) row[key] = (row[key] ?? 0) + 1;
  }
  function observe(facts) {
    if (facts.kind === "tick") {
      increment("engineTicksObserved");
      increment(facts.inByMint ? "ticksWithSolInByMint" : "ticksWithoutSolInByMint");
      increment(facts.inTradeable ? "ticksWithSolInTradeable" : "ticksWithoutSolInTradeable");
      if (facts.inFeedUniverse) increment("ticksWithSolInFeedUniverse");
      if (facts.fresh) increment("ticksWithFreshSol");
      if (facts.allowNewEntries) increment("ticksWithEntriesAllowed");
      // The same tick facts under the spec's explicit presence vocabulary, so a
      // reader does not have to know the engine's internal names.
      latestPresence = {
        ...facts,
        solObservedInUniverse: facts.inByMint === true,
        solPresentInTradeable: facts.inTradeable === true,
        solFresh: facts.fresh === true,
        solReferencePrice: facts.referencePrice ?? null,
        solLiquidity: facts.liquidity ?? null,
      };
      presenceSamples = [...presenceSamples, latestPresence].slice(-SAMPLE_LIMIT);
      return;
    }
    if (facts.kind === "scan") { increment("flatAgentEntryScans"); return; }
    if (!OBSERVED_KINDS.has(facts.kind)) return;
    // Actual engine species are a fixed vocabulary; backstop arbitrary callers.
    const label = typeof facts.species === "string" ? facts.species : "UNKNOWN";
    const key = Object.hasOwn(species, label) || Object.keys(species).length < SPECIES_LIMIT ? label : "OTHER";
    if (!Object.hasOwn(species, key)) Object.defineProperty(species, key, { enumerable: true, value: {
      species: key, solAgentEvaluations: 0, solPassesGates: 0, solFailsGates: 0,
      solAboveEntryThreshold: 0, solBelowEntryThreshold: 0, solExactlyEntryThreshold: 0,
      solOpportunityCandidatesBeforeDedup: 0, solOpportunityCaptured: 0,
      solOpportunitySuppressedByAgentGenerationDedup: 0,
    } });
    const row = species[key];
    if (facts.kind === "evaluation") {
      increment("solAgentEvaluations", row);
      increment(facts.passes ? "solPassesGates" : "solFailsGates", row);
      if (!Array.isArray(facts.failedGates)) return;
      for (const reason of facts.failedGates) gateFailureCounts[reason] = (gateFailureCounts[reason] ?? 0) + 1;
      if (facts.firstFailedGate) firstFailedGateCounts[facts.firstFailedGate] = (firstFailedGateCounts[facts.firstFailedGate] ?? 0) + 1;
    } else if (facts.kind === "score") {
      increment("solScored");
      const solScore = facts.solScore, entryScoreThreshold = facts.entryScoreThreshold;
      if (!Number.isFinite(solScore) || !Number.isFinite(entryScoreThreshold)) {
        increment("solNonFiniteScoreOrThreshold"); return;
      }
      const scoreMargin = solScore - entryScoreThreshold;
      score.add(solScore); threshold.add(entryScoreThreshold); margin.add(scoreMargin);
      const marginBucket = scoreMargin < 0 ? "scoreMarginNegative" : scoreMargin > 0 ? "scoreMarginPositive" : "scoreMarginZero";
      increment(marginBucket);
      // Equality is ACTIONABLE in EVOLVE (`score >= entryScoreThreshold`), so it
      // is a first-class bucket and is never counted as below threshold.
      if (scoreMargin === 0) increment("solExactlyEntryThreshold", row);
      const aboveThreshold = solScore >= entryScoreThreshold;
      increment(aboveThreshold ? "solAboveEntryThreshold" : "solBelowEntryThreshold", row);
      if (aboveThreshold) increment("solOpportunityCandidatesBeforeDedup", row);
      scoreSamples = [...scoreSamples, { solScore, entryScoreThreshold, scoreMargin }].slice(-SAMPLE_LIMIT);
    } else if (facts.kind === "captured") increment("solOpportunityCaptured", row);
    else if (facts.kind === "suppressed") increment("solOpportunitySuppressedByAgentGenerationDedup", row);
    else if (facts.kind === "capture_error") increment("solOpportunityCaptureErrors", row);
  }
  return {
    observe,
    snapshot() {
      const s = score.snapshot(), t = threshold.snapshot(), m = margin.snapshot();
      return structuredClone({
        version: "5I-PS.2b", gateConvention: "all evaluable failed gates plus firstFailedGate in original order",
        ...counters,
        // Spec-name aliases. Derived here from the single canonical counter, so
        // no second accumulator exists and the two can never drift.
        ticksWithSolObservedInUniverse: counters.ticksWithSolInByMint,
        ticksWithoutSolObservedInUniverse: counters.ticksWithoutSolInByMint,
        opportunitiesSuppressedByAgentGenerationDedup: counters.solOpportunitySuppressedByAgentGenerationDedup,
        gateFailureCounts, firstFailedGateCounts,
        species: Object.values(species), latestPresence, presenceSamples, scoreSamples,
        meanSolScore: s.mean, medianSolScore: s.median, minSolScore: s.min, maxSolScore: s.max,
        meanEntryThreshold: t.mean, medianEntryThreshold: t.median,
        meanScoreMargin: m.mean, medianScoreMargin: m.median, minScoreMargin: m.min, maxScoreMargin: m.max,
        medianMethod: "fixed histogram bin midrange; average central ranks; approximate",
        medianAbsoluteErrorBound: BIN_WIDTH / 2,
        medianOutOfRangeCounts: { solScore: s.outsideRange, entryThreshold: t.outsideRange, scoreMargin: m.outsideRange },
        sampleLimit: SAMPLE_LIMIT,
      });
    },
  };
}
