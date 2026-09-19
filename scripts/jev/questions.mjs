/**
 * Jev question set v1 (Phase 5D) — FIXED, VERSIONED, never dynamically invented.
 *
 * Two question sets exist:
 *
 *   jev-question-set-v1   candidate-level shadow judgment (questions A-E below)
 *   jev-market-v1         a single shadow regime-classification question over
 *                         the EXISTING EVOLVE regime vocabulary (never a new one)
 *
 * Built with the official SDK's pure question constructors (`noul`, `choice`,
 * `score` from `@typesafe-ai/sdk`) — these are plain factory functions with no
 * network or filesystem effect, so they are equally safe to use when building
 * the request for the real provider and when building the identical request
 * shape the offline mock provider answers against.
 *
 * PAPER ONLY. Answering these questions never trades, routes, or reclassifies
 * anything: EVOLVE persists the answer and moves on unchanged.
 */

import { choice, noul, score } from "@typesafe-ai/sdk";
import { REGIMES } from "../arena/orchestrator.mjs";

export const JEV_CANDIDATE_QUESTION_SET_ID = "jev-question-set-v1";
export const JEV_CANDIDATE_QUESTION_SET_VERSION = 1;

export const JEV_MARKET_QUESTION_SET_ID = "jev-market-v1";
export const JEV_MARKET_QUESTION_SET_VERSION = 1;

/** Bounded vocabulary for `primaryRisk`. Never extended dynamically. */
export const PRIMARY_RISK_VOCAB = Object.freeze([
  "insufficient_trades",
  "insufficient_mint_diversity",
  "concentration",
  "cost_drag",
  "drawdown",
  "stress_fragility",
  "regime_fragility",
  "no_obvious_risk",
]);

/** Bounded vocabulary for `researchDisposition`. SHADOW ONLY — never routes. */
export const RESEARCH_DISPOSITION_VOCAB = Object.freeze([
  "continue_observing",
  "candidate_for_arena",
  "needs_more_evidence",
  "high_risk",
]);

/** Ordered rubric for `evidenceQuality`, index 0..4. */
export const EVIDENCE_QUALITY_LEVELS = Object.freeze(["very weak", "weak", "mixed", "good", "strong"]);

/**
 * Question A — gateFailureRisk (noul).
 * Persist the raw probability. Never thresholded into a real gate.
 */
function gateFailureRiskQuestion() {
  return noul(
    "Based ONLY on the supplied TRAIN evidence, is this candidate at elevated risk of failing one or more " +
      "of EVOLVE's UNCHANGED Arena evidence gates (minimum trades, minimum distinct mints, acceptable maximum " +
      "drawdown, reasonable concentration, stress survival) on UNSEEN evaluation data? This is a prediction to " +
      "calibrate later; it is never itself a gate result.",
    {
      true: "Elevated risk of failing at least one unchanged Arena gate on unseen data.",
      false: "Not at elevated risk of failing an unchanged Arena gate on unseen data.",
    },
  );
}

/** Question B — primaryRisk (choice, bounded vocabulary, descriptions not just labels). */
function primaryRiskQuestion() {
  return choice("If this candidate has one dominant risk visible in the TRAIN evidence, which is it?", {
    insufficient_trades: "Too few TRAIN trades to trust the statistics.",
    insufficient_mint_diversity: "Too few distinct mints traded; results may be idiosyncratic to one or two tokens.",
    concentration: "Returns are concentrated in a small number of trades or mints.",
    cost_drag: "Cost drag (fees/slippage) is a large share of gross TRAIN returns.",
    drawdown: "TRAIN drawdown is large relative to TRAIN returns.",
    stress_fragility: "TRAIN evidence suggests fragility under stressed conditions.",
    regime_fragility: "Performance looks narrowly dependent on a single market regime.",
    no_obvious_risk: "No single dominant risk is visible in the supplied TRAIN evidence.",
  });
}

/** Question C — evidenceQuality (score, small fixed 5-level rubric). */
function evidenceQualityQuestion() {
  return score("Rate the overall quality/strength of the supplied TRAIN evidence for this candidate.", [
    "very weak: evidence is too sparse or noisy to support any conclusion",
    "weak: evidence is thin; conclusions would be fragile",
    "mixed: some supportive evidence, some concerning signals",
    "good: evidence is reasonably solid and internally consistent",
    "strong: evidence is deep, consistent, and internally corroborated",
  ]);
}

/**
 * Question D — generalizationConfidence (noul).
 * Explicitly a prediction to calibrate later. NEVER a profitability probability.
 */
function generalizationConfidenceQuestion() {
  return noul(
    "Does the TRAIN evidence support the hypothesis that this candidate MAY REMAIN ROBUST on unseen market " +
      "windows? This is a prediction to be calibrated later against real outcomes. It must NEVER be interpreted " +
      "as a profitability probability.",
    {
      true: "TRAIN evidence is consistent with robustness on unseen windows.",
      false: "TRAIN evidence does not support robustness on unseen windows.",
    },
  );
}

/**
 * Question E — researchDisposition (choice). SHADOW ONLY: Jev does not route
 * the candidate. EVOLVE's deterministic research lifecycle is unaffected.
 */
function researchDispositionQuestion() {
  return choice(
    "SHADOW ONLY — this answer does not route or change the candidate's research lifecycle. Given only this " +
      "TRAIN evidence, what would be the appropriate next research step?",
    {
      continue_observing: "Keep observing under the current research lifecycle stage; no reason to accelerate or halt.",
      candidate_for_arena: "Evidence looks ready for Arena evaluation.",
      needs_more_evidence: "Not enough TRAIN evidence yet to judge either way.",
      high_risk: "Evidence suggests high risk; extra scrutiny warranted before proceeding further.",
    },
  );
}

/** The fixed candidate-level question set (jev-question-set-v1). Never dynamic. */
export function buildCandidateQuestions() {
  return {
    gateFailureRisk: gateFailureRiskQuestion(),
    primaryRisk: primaryRiskQuestion(),
    evidenceQuality: evidenceQualityQuestion(),
    generalizationConfidence: generalizationConfidenceQuestion(),
    researchDisposition: researchDispositionQuestion(),
  };
}

/**
 * The fixed market-window question set (jev-market-v1).
 *
 * Jev classifies a COMPLETED PAST TRAIN window into EVOLVE's EXISTING regime
 * vocabulary (`arena/orchestrator.mjs` REGIMES) — never a new label. The
 * deterministic regime classifier is never modified or bypassed by this
 * question: the packet handed to Jev intentionally omits the deterministic
 * regime so Jev classifies blind, and the comparison happens afterward
 * (see `scripts/jev/decision-packet.mjs` / `scripts/jev/calibration.mjs`).
 */
export function buildMarketQuestions() {
  const criteria = {};
  for (const regime of REGIMES) {
    criteria[regime] = `The window's aggregate TRAIN statistics look like EVOLVE's existing '${regime}' regime.`;
  }
  return {
    regime: choice(
      "Based only on the supplied aggregate TRAIN-window market statistics, which EXISTING EVOLVE regime label " +
        "best matches this window?",
      criteria,
    ),
  };
}

/** Every question name in the candidate set, for validators and normalization. */
export const CANDIDATE_QUESTION_NAMES = Object.freeze([
  "gateFailureRisk",
  "primaryRisk",
  "evidenceQuality",
  "generalizationConfidence",
  "researchDisposition",
]);

export const MARKET_QUESTION_NAMES = Object.freeze(["regime"]);
