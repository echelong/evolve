/**
 * Phase 5I.0b — the fixed Jev question set for the directional benchmark.
 *
 * A NEW, dedicated, versioned question set. It does NOT reuse the Phase 5D
 * candidate-risk questions (`jev-question-set-v1`) and it does NOT reuse the
 * market-regime question set (`jev-market-v1`).
 *
 *   jev-microstructure-direction-v1
 *
 * ONE `noul` (probability) question, built with the official SDK's pure
 * question constructor — no network, no filesystem effect — so the identical
 * request shape can be built for the real provider and for offline fixtures.
 *
 * The persisted output is the raw PROBABILITY. It is never reduced to
 * BUY/SELL/UP/DOWN, never thresholded, and Jev never chooses the horizon, the
 * target definition, or whether an observation is scored.
 *
 * PAPER ONLY / DEVELOPMENT EVIDENCE ONLY. Answering this question trades
 * nothing, routes nothing, and changes nothing in EVOLVE.
 */

import { noul } from "@typesafe-ai/sdk";

import { digestOf } from "../../lib/hash.mjs";
import { DIRECTION_PHASE, HORIZON_SECONDS } from "./definition.mjs";

export const DIRECTION_QUESTION_SET_ID = "jev-microstructure-direction-v1";
export const DIRECTION_QUESTION_SET_VERSION = 1;

/** The single question name. Kept boring on purpose: it is a probability, not a signal. */
export const DIRECTION_QUESTION_NAME = "priceHigherAtHorizon";

export const DIRECTION_QUESTION_NAMES = Object.freeze([DIRECTION_QUESTION_NAME]);

/**
 * The central question, frozen word for word before the first real observation.
 *
 * NOTE ON `false`: the `false` criterion is "NOT higher (lower or equal to)".
 * That is the question Jev is asked. It is NOT the scoring rule — a TIE outcome
 * is excluded from binary scoring entirely (see `metrics.mjs`), and no tie is
 * silently folded into either class.
 */
export const DIRECTION_QUESTION_TEXT =
  `Using ONLY the frozen market state supplied with this request (information observed at or before ` +
  `stateObservedAt, with no future data), will the ${"SOL/USDC"} reference price be HIGHER ` +
  `${HORIZON_SECONDS} seconds after stateObservedAt than its reference price at stateObservedAt?`;

export const DIRECTION_QUESTION_CRITERIA = Object.freeze({
  true: `The SOL/USDC reference price ${HORIZON_SECONDS} seconds after stateObservedAt is HIGHER than at stateObservedAt.`,
  false: `The SOL/USDC reference price ${HORIZON_SECONDS} seconds after stateObservedAt is NOT higher than at stateObservedAt (lower or equal).`,
});

/**
 * Build the fixed question set. Deterministic: the same call always produces the
 * same plain-data structure, which is what makes the question digest stable.
 */
export function buildDirectionQuestions() {
  return {
    [DIRECTION_QUESTION_NAME]: noul(DIRECTION_QUESTION_TEXT, {
      true: DIRECTION_QUESTION_CRITERIA.true,
      false: DIRECTION_QUESTION_CRITERIA.false,
    }),
  };
}

/** Digest of the frozen question set — persisted with every prediction. */
export function directionQuestionDigest() {
  return digestOf(buildDirectionQuestions());
}

/**
 * Frozen description of the question set for artifacts and the CLI
 * (`--definition`-style output). Contains no confidence threshold and no
 * action vocabulary.
 */
export const DIRECTION_QUESTION_SET = Object.freeze({
  phase: DIRECTION_PHASE,
  questionSetId: DIRECTION_QUESTION_SET_ID,
  questionSetVersion: DIRECTION_QUESTION_SET_VERSION,
  horizonSeconds: HORIZON_SECONDS,
  answerKind: "noul-probability",
  questionName: DIRECTION_QUESTION_NAME,
  questionText: DIRECTION_QUESTION_TEXT,
  criteria: DIRECTION_QUESTION_CRITERIA,
  reducedToBuySell: false,
  // Explicit declaration of ABSENCE: no threshold is applied to the answer.
  confidenceThresholdApplied: false,
});

export const DIRECTION_QUESTION_SET_DIGEST = digestOf(DIRECTION_QUESTION_SET);
