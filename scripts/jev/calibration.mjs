/**
 * Jev calibration layer (Phase 5D) — the most important part of this subsystem.
 *
 * This module is a PURE, POST-OUTCOME evaluator. It joins a previously
 * timestamped Jev prediction with a LATER deterministic Arena outcome and
 * reports how calibrated/useful the prediction actually was.
 *
 * Hard invariants:
 *
 *   - Jev is NEVER called again here. This module imports no provider, no
 *     registry, no runtime HTTP code — only plain data in, plain data out.
 *   - Target definitions are pre-registered constants (`*_TARGET_DEFINITION_V1`),
 *     never re-derived from "whichever definition makes Jev look best".
 *   - `primaryRisk` is evaluated as a MULTI-LABEL membership question (does the
 *     selected risk appear in the actual failed-gate set?), never forced into a
 *     single fake ground-truth label.
 *   - Threshold analysis (`thresholdCoverageAnalysis`) is OFFLINE ANALYSIS ONLY.
 *     No threshold produced here is ever promoted to an operational gate.
 *
 * PAPER ONLY.
 */

export const JEV_CALIBRATION_VERSION = 1;

/**
 * Pre-registered BEFORE any Phase 5D calibration run. `gateResult` is whatever
 * `evaluateSurvivalGates()` (scripts/arena/orchestrator.mjs) produced for the
 * candidate: `{ status, gates: [{label, pass, detail}], passed, failed, total }`.
 */
export const GATE_FAILURE_TARGET_DEFINITION_V1 =
  "gateFailureRisk-target-v1: outcome = 1 iff the candidate's unchanged deterministic Arena gate evaluation " +
  "(evaluateSurvivalGates) reports gateResult.failed > 0 (at least one applicable gate failed), else 0.";

/**
 * Pre-registered BEFORE any Phase 5D calibration run. Tied 1:1 to the SAME
 * deterministic gate-evaluation status EVOLVE already computes, so the target
 * cannot be picked after the fact to flatter Jev.
 */
export const GENERALIZATION_TARGET_DEFINITION_V1 =
  "generalizationConfidence-target-v1: outcome = 1 iff gateResult.status is 'ARENA_SURVIVOR' or " +
  "'DEPLOYMENT_CANDIDATE' (the candidate cleared every currently-applicable unchanged gate), else 0. This is a " +
  "generalization-under-the-existing-gate-set target; it is NEVER a profitability claim.";

/** Fixed offline analysis thresholds. NEVER promoted to an operational gate in Phase 5D. */
export const CONFIDENCE_THRESHOLDS_V1 = Object.freeze([0.5, 0.6, 0.7, 0.8, 0.9]);

/** Maps an unchanged Arena gate LABEL to the bounded `primaryRisk` vocabulary word it corresponds to. */
export const GATE_LABEL_TO_RISK_VOCAB = Object.freeze({
  "minimum total trades": "insufficient_trades",
  "minimum distinct mints": "insufficient_mint_diversity",
  "reasonable concentration": "concentration",
  "acceptable maximum drawdown": "drawdown",
  "stress profiles survived": "stress_fragility",
  "survives mild stress": "stress_fragility",
  "no catastrophic failures": "stress_fragility",
});

/* ============================================================================
 * Outcome targets
 * ==========================================================================*/

export function gateFailureOutcome(gateResult) {
  if (!gateResult || !Number.isFinite(gateResult.failed)) return null;
  return gateResult.failed > 0;
}

export function generalizationOutcome(gateResult) {
  if (!gateResult || typeof gateResult.status !== "string") return null;
  return gateResult.status === "ARENA_SURVIVOR" || gateResult.status === "DEPLOYMENT_CANDIDATE";
}

/* ============================================================================
 * Join
 * ==========================================================================*/

/** Pure join: a decision (a prior, timestamped prediction) with its later outcome, by decisionId only. */
export function joinDecisionsWithOutcomes({ decisions = [], outcomes = [] }) {
  const outcomeById = new Map((outcomes ?? []).filter((o) => o?.decisionId).map((o) => [o.decisionId, o]));
  return (decisions ?? [])
    .filter((d) => d?.decisionId && outcomeById.has(d.decisionId))
    .map((d) => ({ decision: d, outcome: outcomeById.get(d.decisionId) }));
}

/* ============================================================================
 * Scoring primitives
 * ==========================================================================*/

/** Mean squared error between predicted probability and the 0/1 outcome. */
export function brierScore(pairs) {
  const valid = (pairs ?? []).filter((entry) => Number.isFinite(entry.p) && (entry.o === 0 || entry.o === 1));
  if (valid.length === 0) return null;
  const sum = valid.reduce((acc, entry) => acc + (entry.p - entry.o) ** 2, 0);
  return sum / valid.length;
}

/** Fixed-width reliability bins over [0,1]. */
export function reliabilityBins(pairs, binCount = 10) {
  const bins = Array.from({ length: binCount }, (_, index) => ({
    binStart: index / binCount,
    binEnd: (index + 1) / binCount,
    count: 0,
    sumP: 0,
    sumO: 0,
  }));
  for (const entry of pairs ?? []) {
    if (!Number.isFinite(entry.p)) continue;
    let index = Math.floor(entry.p * binCount);
    if (index >= binCount) index = binCount - 1;
    if (index < 0) index = 0;
    bins[index].count += 1;
    bins[index].sumP += entry.p;
    bins[index].sumO += entry.o;
  }
  return bins.map((bin) => ({
    ...bin,
    meanPredicted: bin.count > 0 ? bin.sumP / bin.count : null,
    observedRate: bin.count > 0 ? bin.sumO / bin.count : null,
  }));
}

/** Weighted-by-bin-size mean absolute gap between predicted and observed — a single scalar calibration error. */
export function absoluteCalibrationError(pairs, binCount = 10) {
  const bins = reliabilityBins(pairs, binCount).filter((bin) => bin.count > 0);
  const total = bins.reduce((acc, bin) => acc + bin.count, 0);
  if (total === 0) return null;
  return bins.reduce((acc, bin) => acc + (bin.count / total) * Math.abs(bin.meanPredicted - bin.observedRate), 0);
}

/* ============================================================================
 * Per-question calibration
 * ==========================================================================*/

/** Calibrate one `noul` question (gateFailureRisk / generalizationConfidence) against its pre-registered target. */
export function calibrateNoulQuestion({ joined, questionName, outcomeFn, targetDefinition }) {
  const pairs = [];
  for (const { decision, outcome } of joined) {
    if (decision?.status !== "JEV_OK") continue;
    const answer = decision.answers?.[questionName];
    if (!answer || answer.type !== "noul" || !Number.isFinite(answer.probability)) continue;
    const target = outcomeFn(outcome?.gateResult ?? null);
    if (target === null || target === undefined) continue;
    pairs.push({ p: answer.probability, o: target ? 1 : 0, decisionId: decision.decisionId });
  }
  const meanPredictedProbability = pairs.length > 0 ? pairs.reduce((acc, x) => acc + x.p, 0) / pairs.length : null;
  const observedOutcomeRate = pairs.length > 0 ? pairs.reduce((acc, x) => acc + x.o, 0) / pairs.length : null;
  return {
    questionName,
    targetDefinition,
    predictionCount: pairs.length,
    brierScore: brierScore(pairs),
    absoluteCalibrationError: absoluteCalibrationError(pairs),
    reliabilityBins: reliabilityBins(pairs),
    meanPredictedProbability,
    observedOutcomeRate,
  };
}

/**
 * Evaluate `primaryRisk` as a MULTI-LABEL membership question: candidates can
 * fail several gates at once, so this reports whether the selected label
 * appears in the actual failed-gate set — never a forced single-label accuracy.
 */
export function evaluatePrimaryRisk({ joined }) {
  const rows = [];
  for (const { decision, outcome } of joined) {
    if (decision?.status !== "JEV_OK") continue;
    const answer = decision.answers?.primaryRisk;
    if (!answer || answer.type !== "choice") continue;
    const failedLabels = (outcome?.gateResult?.gates ?? []).filter((gate) => gate?.pass === false).map((gate) => gate.label);
    const failedVocab = [...new Set(failedLabels.map((label) => GATE_LABEL_TO_RISK_VOCAB[label]).filter(Boolean))];
    rows.push({
      decisionId: decision.decisionId,
      selected: answer.choice,
      failedGateLabels: failedLabels,
      failedRiskVocab: failedVocab,
      appearsInFailedSet: failedVocab.includes(answer.choice),
      probabilities: answer.probabilities ?? {},
    });
  }
  const withAnyFailure = rows.filter((row) => row.failedRiskVocab.length > 0);
  const agreementRateWhenGatesFailed =
    withAnyFailure.length > 0 ? withAnyFailure.filter((row) => row.appearsInFailedSet).length / withAnyFailure.length : null;
  return {
    predictionCount: rows.length,
    rows,
    agreementRateWhenGatesFailed,
    note: "Multi-label membership only. Candidates can fail multiple gates; no fake single-label ground truth is forced.",
  };
}

/**
 * Descriptive comparison of the `evidenceQuality` score against a predefined
 * deterministic evidence-quality outcome function, if one is supplied. Levels
 * are the fixed pre-registered rubric text from `scripts/jev/questions.mjs` and
 * are never retuned after seeing results.
 */
export function evaluateEvidenceQuality({ joined, deterministicQualityFn = null }) {
  const rows = [];
  for (const { decision, outcome } of joined) {
    if (decision?.status !== "JEV_OK") continue;
    const answer = decision.answers?.evidenceQuality;
    if (!answer || answer.type !== "score") continue;
    rows.push({
      decisionId: decision.decisionId,
      jevScore: answer.score,
      deterministicScore: typeof deterministicQualityFn === "function" ? deterministicQualityFn(outcome) : null,
    });
  }
  return {
    predictionCount: rows.length,
    rows,
    note: "Descriptive comparison only. Rubric levels are fixed and pre-registered; never retuned after results.",
  };
}

/**
 * OFFLINE analysis of hypothetical confidence thresholds for one `noul`
 * question. Analysis only — no threshold produced here is ever promoted to an
 * operational gate in Phase 5D.
 */
export function thresholdCoverageAnalysis({ joined, questionName, outcomeFn, thresholds = CONFIDENCE_THRESHOLDS_V1 }) {
  const pairs = [];
  for (const { decision, outcome } of joined) {
    if (decision?.status !== "JEV_OK") continue;
    const answer = decision.answers?.[questionName];
    if (!answer || answer.type !== "noul" || !Number.isFinite(answer.probability)) continue;
    const target = outcomeFn(outcome?.gateResult ?? null);
    if (target === null || target === undefined) continue;
    const confidence = Math.max(answer.probability, 1 - answer.probability);
    pairs.push({ p: answer.probability, o: target ? 1 : 0, confidence, predictedYes: answer.probability >= 0.5 });
  }
  return (thresholds ?? CONFIDENCE_THRESHOLDS_V1).map((threshold) => {
    const covered = pairs.filter((entry) => entry.confidence >= threshold);
    const coverage = pairs.length > 0 ? covered.length / pairs.length : null;
    const correct = covered.filter((entry) => (entry.predictedYes ? 1 : 0) === entry.o).length;
    return {
      threshold,
      coveredCount: covered.length,
      totalCount: pairs.length,
      coverage,
      abstentionRate: coverage === null ? null : 1 - coverage,
      accuracy: covered.length > 0 ? correct / covered.length : null,
      brierScore: covered.length > 0 ? brierScore(covered) : null,
    };
  });
}

/* ============================================================================
 * Regime shadow comparison (no outcome wait needed — ground truth already exists)
 * ==========================================================================*/

/**
 * Compare Jev's blind regime classification against EVOLVE's deterministic
 * classifier for the SAME completed TRAIN window. Unlike the candidate
 * questions, no later outcome is needed: the deterministic label was already
 * known at decision time and is recorded on the decision itself
 * (`deterministicComparators.deterministicRegime`) — it was never shown to Jev.
 */
export function evaluateRegimeShadow({ decisions = [] }) {
  const rows = [];
  for (const decision of decisions) {
    if (decision?.status !== "JEV_OK" || decision?.packetKind !== "JEV_MARKET_DECISION_PACKET") continue;
    const answer = decision.answers?.regime;
    if (!answer || answer.type !== "choice") continue;
    const deterministicRegime = decision.deterministicComparators?.deterministicRegime ?? null;
    rows.push({
      decisionId: decision.decisionId,
      deterministicRegime,
      jevRegime: answer.choice,
      jevDistribution: answer.probabilities ?? {},
      confidence: answer.confidence ?? null,
      agreement: deterministicRegime !== null ? deterministicRegime === answer.choice : null,
    });
  }
  const withDeterministic = rows.filter((row) => row.deterministicRegime !== null);
  const agreementRate =
    withDeterministic.length > 0 ? withDeterministic.filter((row) => row.agreement === true).length / withDeterministic.length : null;
  return {
    predictionCount: rows.length,
    rows,
    agreementRate,
    note: "Shadow comparison only. The deterministic regime classifier is authoritative and unchanged by this comparison.",
  };
}

/* ============================================================================
 * Full report
 * ==========================================================================*/

/**
 * Run the full Phase 5D calibration report. PURE: takes plain decision and
 * outcome records, calls no provider, makes no network request.
 */
export function runJevCalibration({ decisions = [], outcomes = [] }) {
  const joined = joinDecisionsWithOutcomes({ decisions, outcomes });
  return {
    schemaVersion: JEV_CALIBRATION_VERSION,
    predictionCount: joined.length,
    gateFailureRisk: calibrateNoulQuestion({
      joined,
      questionName: "gateFailureRisk",
      outcomeFn: gateFailureOutcome,
      targetDefinition: GATE_FAILURE_TARGET_DEFINITION_V1,
    }),
    generalizationConfidence: calibrateNoulQuestion({
      joined,
      questionName: "generalizationConfidence",
      outcomeFn: generalizationOutcome,
      targetDefinition: GENERALIZATION_TARGET_DEFINITION_V1,
    }),
    primaryRisk: evaluatePrimaryRisk({ joined }),
    evidenceQuality: evaluateEvidenceQuality({ joined }),
    thresholdAnalysis: {
      gateFailureRisk: thresholdCoverageAnalysis({ joined, questionName: "gateFailureRisk", outcomeFn: gateFailureOutcome }),
      generalizationConfidence: thresholdCoverageAnalysis({
        joined,
        questionName: "generalizationConfidence",
        outcomeFn: generalizationOutcome,
      }),
    },
    regimeShadow: evaluateRegimeShadow({ decisions }),
    noThresholdPromoted: true,
    note:
      "OFFLINE ANALYSIS ONLY. No Jev provider call is made during calibration. No threshold produced here is " +
      "promoted to an operational gate in Phase 5D — a bad Jev result here is an acceptable, expected outcome.",
  };
}
