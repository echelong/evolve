/**
 * `mock-jev` — deterministic, offline Jev provider (Phase 5D).
 *
 * Returns typed answers in the SAME internal normalized shape as the real
 * `typesafe-jev` provider (see `scripts/jev/runtime.mjs#normalizeAnswer`), so
 * every downstream consumer (persistence, dashboard, calibration) is provider-
 * agnostic. Every answer is marked `syntheticDecision: true` at the run-record
 * level — a mock probability is NEVER presented as calibrated.
 *
 * Determinism: the same (state digest, question set) always produces the same
 * answer, computed with pure functions over the packet content — no RNG seeded
 * by wall-clock, no network, no filesystem access beyond what the caller does.
 *
 * The real provider must be selected EXPLICITLY (`EVOLVE_JEV_PROVIDER=typesafe-jev`);
 * this module is never a silent fallback for it.
 *
 * PAPER ONLY.
 */

import { digestOf } from "../../lib/hash.mjs";
import { PRIMARY_RISK_VOCAB, RESEARCH_DISPOSITION_VOCAB } from "../questions.mjs";
import {
  EXTERNAL_EVIDENCE_QUALITY_LEVELS,
  PRIMARY_CONCERN_VOCAB,
  RESEARCH_DISPOSITION_VOCAB as EXTERNAL_RESEARCH_DISPOSITION_VOCAB,
} from "../../jev-external-bridge.mjs";
import { REGIMES } from "../../arena/orchestrator.mjs";

export const MOCK_JEV_PROVIDER = "mock-jev";
export const MOCK_JEV_MODEL = "mock-jev-v1";

/** A small deterministic PRNG seeded from a digest — no wall-clock, no crypto RNG. */
function seededRandom(seedDigest) {
  let state = parseInt(seedDigest.slice(0, 8), 16) || 1;
  return function next() {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

function pickWeighted(vocab, weights) {
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let best = vocab[0];
  let bestWeight = -Infinity;
  for (let index = 0; index < vocab.length; index += 1) {
    if (weights[index] > bestWeight) {
      bestWeight = weights[index];
      best = vocab[index];
    }
  }
  const probabilities = {};
  for (let index = 0; index < vocab.length; index += 1) probabilities[vocab[index]] = weights[index] / total;
  return { choice: best, probabilities, confidence: probabilities[best] };
}

/**
 * Deterministically answer the candidate question set from the packet's TRAIN
 * evidence. Heuristics only — never a real risk assessment.
 */
function answerCandidateQuestions(packet) {
  const train = packet?.train ?? {};
  const trades = Number.isFinite(train.tradeCount) ? train.tradeCount : 0;
  const mints = Number.isFinite(train.mintDiversity) ? train.mintDiversity : 0;
  const concentration = Number.isFinite(train.concentration) ? train.concentration : 0;
  const costDrag = Number.isFinite(train.costDrag) ? train.costDrag : 0;
  const drawdown = Number.isFinite(train.drawdown) ? train.drawdown : 0;
  const regimeCount = Object.keys(train.regimeComposition ?? {}).length;
  const watchdogVerdict = packet?.watchdogEvidence?.verdict ?? "NORMAL";

  const random = seededRandom(digestOf(packet));

  // gateFailureRisk: a simple bounded heuristic over thin evidence / weak metrics.
  let riskScore = 0;
  if (trades < 20) riskScore += 0.3;
  if (mints < 4) riskScore += 0.25;
  if (concentration > 0.5) riskScore += 0.2;
  if (drawdown > 0.5) riskScore += 0.2;
  if (watchdogVerdict === "QUARANTINED") riskScore += 0.3;
  if (watchdogVerdict === "WATCH") riskScore += 0.1;
  riskScore = Math.min(0.95, Math.max(0.05, riskScore + (random() - 0.5) * 0.1));

  // primaryRisk: whichever bounded metric looks worst, else no_obvious_risk.
  const weights = [
    trades < 20 ? 1 - trades / 20 : 0.05, // insufficient_trades
    mints < 4 ? 1 - mints / 4 : 0.05, // insufficient_mint_diversity
    concentration, // concentration
    costDrag * 5, // cost_drag
    drawdown, // drawdown
    watchdogVerdict === "QUARANTINED" ? 0.9 : watchdogVerdict === "WATCH" ? 0.4 : 0.05, // stress_fragility
    regimeCount <= 1 ? 0.6 : 0.1, // regime_fragility
    0.15, // no_obvious_risk (baseline)
  ];
  const primary = pickWeighted(PRIMARY_RISK_VOCAB, weights);

  // evidenceQuality: 0..4 score from breadth of evidence.
  let qualityScore = 0;
  if (trades >= 20) qualityScore += 1;
  if (trades >= 60) qualityScore += 0.5;
  if (mints >= 4) qualityScore += 1;
  if (mints >= 10) qualityScore += 0.5;
  if (regimeCount >= 2) qualityScore += 1;
  qualityScore = Math.max(0, Math.min(4, qualityScore));
  const qualityProbabilities = {};
  for (let level = 0; level <= 4; level += 1) {
    qualityProbabilities[level] = Math.max(0, 1 - Math.abs(level - qualityScore) / 2);
  }
  const qualityTotal = Object.values(qualityProbabilities).reduce((a, b) => a + b, 0) || 1;
  for (const key of Object.keys(qualityProbabilities)) qualityProbabilities[key] /= qualityTotal;

  // generalizationConfidence: inverse-ish of risk, evidence-quality weighted.
  const generalization = Math.min(0.95, Math.max(0.05, (1 - riskScore) * 0.6 + (qualityScore / 4) * 0.4));

  // researchDisposition
  const dispositionWeights = [
    trades < 20 || mints < 4 ? 0.15 : 0.55, // continue_observing
    riskScore < 0.35 && qualityScore >= 2 ? 0.6 : 0.1, // candidate_for_arena
    qualityScore < 1.5 ? 0.6 : 0.1, // needs_more_evidence
    riskScore > 0.65 || watchdogVerdict === "QUARANTINED" ? 0.6 : 0.1, // high_risk
  ];
  const disposition = pickWeighted(RESEARCH_DISPOSITION_VOCAB, dispositionWeights);

  return {
    // NOTE: the field is `noul` (not `probability`) to match the raw SDK wire
    // shape (`NoulResponse.noul`) exactly — `runtime.mjs#normalizeAnswer`
    // applies the SAME normalization step to both providers' raw output, so a
    // mismatch here would silently make every mock decision look invalid.
    gateFailureRisk: { type: "noul", noul: Number(riskScore.toFixed(4)) },
    primaryRisk: {
      type: "choice",
      choice: primary.choice,
      confidence: Number(primary.confidence.toFixed(4)),
      probabilities: primary.probabilities,
    },
    evidenceQuality: {
      type: "score",
      score: Number(qualityScore.toFixed(4)),
      confidence: Number((qualityProbabilities[Math.round(qualityScore)] ?? 0.5).toFixed(4)),
      legend: { 0: "very weak", 1: "weak", 2: "mixed", 3: "good", 4: "strong" },
      probabilities: qualityProbabilities,
    },
    generalizationConfidence: { type: "noul", noul: Number(generalization.toFixed(4)) },
    researchDisposition: {
      type: "choice",
      choice: disposition.choice,
      confidence: Number(disposition.confidence.toFixed(4)),
      probabilities: disposition.probabilities,
    },
  };
}

/** Deterministically classify a market packet into EVOLVE's existing regime vocabulary. */
function answerMarketQuestions(packet) {
  const features = packet?.marketFeatures ?? {};
  const random = seededRandom(digestOf(packet));
  const weights = REGIMES.map((regime) => {
    let weight = 0.1 + random() * 0.05;
    const meanReturn = features.meanReturn ?? 0;
    const dispersion = features.dispersion ?? 0;
    const launchHeavyRatio = features.launchHeavyRatio ?? 0;
    const liquidityChange = features.liquidityChange ?? 0;
    const activityPerSnapshot = features.activityPerSnapshot ?? 0;
    if (regime === "strong-risk-on" && meanReturn > 0.02) weight += 0.6;
    if (regime === "weak-risk-on" && meanReturn > 0 && meanReturn <= 0.02) weight += 0.5;
    if (regime === "sideways-chop" && Math.abs(meanReturn) < 0.005 && dispersion < 0.3) weight += 0.5;
    if (regime === "high-volatility" && dispersion >= 0.3) weight += 0.6;
    if (regime === "liquidity-expansion" && liquidityChange > 0.05) weight += 0.5;
    if (regime === "liquidity-contraction" && liquidityChange < -0.05) weight += 0.5;
    if (regime === "broad-selloff" && meanReturn < -0.02) weight += 0.6;
    if (regime === "launch-heavy" && launchHeavyRatio > 0.3) weight += 0.5;
    if (regime === "low-activity" && activityPerSnapshot < 1) weight += 0.4;
    return Math.max(0.01, weight);
  });
  const picked = pickWeighted(REGIMES, weights);
  return {
    regime: {
      type: "choice",
      choice: picked.choice,
      confidence: Number(picked.confidence.toFixed(4)),
      probabilities: Object.fromEntries(Object.entries(picked.probabilities).map(([k, v]) => [k, Number(v.toFixed(4))])),
    },
  };
}

/**
 * Deterministically answer the external bounded-evidence question set from the
 * bounded Jev projection.
 *
 * Heuristics only — never a real research assessment, never a routing signal.
 * Every ratio is optional: a missing (null) field is treated as "not observed",
 * never as a positive signal.
 */
function answerExternalQuestionSet(packet) {
  const features = packet?.features ?? {};
  const counts = packet?.counts ?? {};
  const records = Number.isFinite(counts.records) ? counts.records : 0;
  const failures = Number.isFinite(counts.failures) ? counts.failures : 0;
  const sourceCount = Number.isFinite(features.sourceCount) ? features.sourceCount : 0;
  const coordinationCount = Number.isFinite(features.coordinationIndicatorCount)
    ? features.coordinationIndicatorCount
    : 0;
  const fetchFailureRate = Number.isFinite(features.fetchFailureRate) ? features.fetchFailureRate : 0;
  const coverages = [
    features.authorCoverage,
    features.textCoverage,
    features.linkCoverage,
    features.publishedAtCoverage,
    features.engagementCoverage,
  ].filter((value) => Number.isFinite(value));
  const coverageAvg = coverages.length > 0 ? coverages.reduce((sum, value) => sum + value, 0) / coverages.length : 0;

  const random = seededRandom(digestOf(packet));
  let breadth = 0;
  if (records >= 5) breadth += 0.3;
  if (records >= 20) breadth += 0.2;
  if (sourceCount >= 2) breadth += 0.2;
  breadth += 0.3 * coverageAvg;
  breadth = Math.min(0.98, Math.max(0.02, breadth + (random() - 0.5) * 0.05));

  const sufficiency = Math.min(0.98, Math.max(0.02, breadth));
  const corroboration = Math.min(0.98, Math.max(0.02, breadth - 0.2 * coordinationCount - failures * 0.1));

  let qualityScore = Math.round(breadth * 4);
  qualityScore = Math.max(0, Math.min(4, qualityScore));
  const qualityProbabilities = {};
  for (let level = 0; level <= 4; level += 1) {
    qualityProbabilities[level] = Math.max(0, 1 - Math.abs(level - qualityScore) / 2);
  }
  const qualityTotal = Object.values(qualityProbabilities).reduce((a, b) => a + b, 0) || 1;
  for (const key of Object.keys(qualityProbabilities)) qualityProbabilities[key] /= qualityTotal;

  const concern = pickWeighted(PRIMARY_CONCERN_VOCAB, [
    records < 5 ? 0.8 : 0.05, // insufficient_sample
    records > 0 && sourceCount <= 1 ? 0.7 : 0.05, // source_concentration
    coverageAvg < 0.5 ? 0.7 : 0.05, // low_field_coverage
    coordinationCount > 0 ? 0.85 : 0.05, // coordination_pattern
    failures > 0 || fetchFailureRate > 0 ? 0.8 : 0.05, // fetch_instability
    0.15, // no_obvious_concern (baseline)
  ]);

  const disposition = pickWeighted(EXTERNAL_RESEARCH_DISPOSITION_VOCAB, [
    0.15, // ignore
    records < 5 ? 0.8 : 0.45, // observe
    breadth >= 0.7 && coordinationCount === 0 ? 0.8 : 0.05, // escalate_to_deep_research
  ]);

  return {
    evidenceSufficiency: { type: "noul", noul: Number(sufficiency.toFixed(4)) },
    primaryConcern: {
      type: "choice",
      choice: concern.choice,
      confidence: Number(concern.confidence.toFixed(4)),
      probabilities: concern.probabilities,
    },
    evidenceQuality: {
      type: "score",
      score: Number(qualityScore.toFixed(4)),
      confidence: Number((qualityProbabilities[qualityScore] ?? 0.5).toFixed(4)),
      legend: Object.fromEntries(EXTERNAL_EVIDENCE_QUALITY_LEVELS.map((entry, index) => [index, entry])),
      probabilities: qualityProbabilities,
    },
    corroborationConfidence: { type: "noul", noul: Number(corroboration.toFixed(4)) },
    researchDisposition: {
      type: "choice",
      choice: disposition.choice,
      confidence: Number(disposition.confidence.toFixed(4)),
      probabilities: disposition.probabilities,
    },
  };
}

/**
 * Create the mock-jev provider. Conforms to the narrow contract:
 * `evaluate({ state, questions, context })`.
 *
 * The candidate and market branches are UNCHANGED. A third branch answers the
 * external bounded-evidence question set, detected by its unique question name
 * (`evidenceSufficiency`) so it can never be confused with either of the other
 * two sets.
 */
export function createMockJevProvider() {
  return {
    name: MOCK_JEV_PROVIDER,
    model: MOCK_JEV_MODEL,
    offline: true,
    external: false,
    syntheticDecision: true,
    async evaluate({ state, questions, context = {} } = {}) {
      const questionNames = Object.keys(questions ?? {});
      const isExternal = questionNames.includes("evidenceSufficiency");
      const isMarket = !isExternal && questionNames.length === 1 && questionNames[0] === "regime";
      const answers = isExternal
        ? answerExternalQuestionSet(state)
        : isMarket
          ? answerMarketQuestions(state)
          : answerCandidateQuestions(state);
      return {
        ok: true,
        model: MOCK_JEV_MODEL,
        requestId: `mock-${digestOf({ state, questions, context }).slice(0, 16)}`,
        answers,
        usage: { input_tokens: 0, output_tokens: 0 },
        syntheticDecision: true,
      };
    },
  };
}
