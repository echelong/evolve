/**
 * Phase 5I-PS.2d — generic cross-asset question contract + typed response.
 *
 * The existing supervisor question (`jev-microstructure-direction-v1`) asks about
 * the SOL/USDC reference price and is intrinsically SOL-specific. It is NOT
 * reused, reinterpreted or modified here. This is a NEW, separately versioned
 * set with ONE `noul` question about EVOLVE's own finalized production proposal.
 *
 * RESPONSE MEANING (frozen):
 *   pSupport = the probability Jev reports that the supplied frozen pre-outcome
 *              facts support EVOLVE's production proposal as stated.
 *   stance   = SUPPORTS_PROPOSAL (p > 0.5) | DOES_NOT_SUPPORT_PROPOSAL (p < 0.5)
 *              | EXACTLY_HALF (p === 0.5); exact comparisons, no tolerance.
 *
 * A stance is Jev's report about the frozen facts ONLY. It is not correctness,
 * not a forecast checked against an outcome (PS.2d never resolves outcomes), not
 * agreement-as-truth, not disagreement-as-truth, and never a trading signal. The
 * packet contains EVOLVE's own proposal, so the response is anchored by design
 * and is not comparable with SOL direction evidence.
 *
 * PAPER ONLY / SHADOW ONLY / DEVELOPMENT EVIDENCE ONLY.
 */

import { noul } from "@typesafe-ai/sdk";

import { digestOf } from "../../lib/hash.mjs";
import {
  PS2D_MAX_FAILURE_REASON_LENGTH,
  PS2D_PHASE,
  PS2D_QUESTION_NAME,
  PS2D_QUESTION_SET_ID,
  PS2D_QUESTION_SET_VERSION,
  PS2D_STANCES,
} from "./cross-asset-protocol.mjs";

export const PS2D_QUESTION_TEXT =
  "Using ONLY the frozen pre-outcome facts supplied with this request (information available to the EVOLVE paper " +
  "engine at or before proposalAt, with no future data), do these facts support EVOLVE's production proposal to " +
  "open a long PAPER position in the identified asset (identified by baseMint, priced in USD with USDC as the quote " +
  "numeraire) at the frozen reference price?";

export const PS2D_QUESTION_CRITERIA = Object.freeze({
  true: "The supplied pre-outcome facts support the production proposal as stated.",
  false: "The supplied pre-outcome facts do not support the production proposal as stated.",
});

/** Deterministic: the same call always produces the same plain-data structure. */
export function buildCrossAssetQuestions() {
  return {
    [PS2D_QUESTION_NAME]: noul(PS2D_QUESTION_TEXT, {
      true: PS2D_QUESTION_CRITERIA.true,
      false: PS2D_QUESTION_CRITERIA.false,
    }),
  };
}

export function crossAssetQuestionDigest() {
  return digestOf(buildCrossAssetQuestions());
}

export const PS2D_RESPONSE_CONTRACT = Object.freeze({
  phase: PS2D_PHASE,
  questionSetId: PS2D_QUESTION_SET_ID,
  questionSetVersion: PS2D_QUESTION_SET_VERSION,
  questionName: PS2D_QUESTION_NAME,
  answerKind: "noul-probability",
  answerNames: Object.freeze([PS2D_QUESTION_NAME]),
  probabilityRange: Object.freeze([0, 1]),
  stanceRule: "SUPPORTS_PROPOSAL iff p > 0.5; DOES_NOT_SUPPORT_PROPOSAL iff p < 0.5; EXACTLY_HALF iff p === 0.5",
  stanceIsCorrectness: false,
  supportImpliesCorrectness: false,
  nonSupportImpliesCorrectness: false,
  outcomeResolved: false,
  malformedBecomesStance: false,
  confidenceThresholdApplied: false,
  reducedToBuySell: false,
});

export const PS2D_RESPONSE_CONTRACT_DIGEST = digestOf(PS2D_RESPONSE_CONTRACT);

/** The frozen stance rule. `null` for anything that is not a valid probability. */
export function stanceFromProbability(pSupport) {
  if (typeof pSupport !== "number" || !Number.isFinite(pSupport) || pSupport < 0 || pSupport > 1) return null;
  if (pSupport > 0.5) return PS2D_STANCES.SUPPORTS;
  if (pSupport < 0.5) return PS2D_STANCES.DOES_NOT_SUPPORT;
  return PS2D_STANCES.EXACTLY_HALF;
}

function boundedReason(text) {
  return String(text ?? "").slice(0, PS2D_MAX_FAILURE_REASON_LENGTH);
}

/**
 * STRICT typed-response validation over a `jevDecide` result. Exactly one answer
 * named `productionProposalSupported`, type `noul`, finite probability in [0, 1].
 * Everything else is a failure — never a stance, never agreement/disagreement.
 *
 * @returns {{ ok: boolean, status: string, pSupport: number|null, stance: string|null,
 *   failureReason: string|null, typedResponse: object|null }}
 */
export function validateCrossAssetTypedResponse(decided, { okStatus = "JEV_OK" } = {}) {
  const run = decided?.run ?? null;
  const providerStatus = typeof run?.status === "string" ? run.status : null;
  if (providerStatus !== okStatus) {
    return {
      ok: false,
      status: providerStatus ?? "JEV_NO_STATUS",
      pSupport: null,
      stance: null,
      failureReason: boundedReason(run?.reason ?? `Jev returned ${providerStatus ?? "no status"}`),
      typedResponse: null,
    };
  }
  const answers = decided?.decision;
  const names = answers && typeof answers === "object" ? Object.keys(answers).sort() : [];
  const shape = { answerNames: names.slice(0, 4), answerCount: names.length };
  const malformed = (reason, extra = {}) => ({
    ok: false,
    status: "PS2D_INVALID_TYPED_RESPONSE",
    pSupport: null,
    stance: null,
    failureReason: boundedReason(reason),
    typedResponse: { ...shape, ...extra },
  });
  if (names.length !== 1 || names[0] !== PS2D_QUESTION_NAME) {
    return malformed(`expected exactly one answer named '${PS2D_QUESTION_NAME}'`);
  }
  const answer = answers[PS2D_QUESTION_NAME];
  const type = typeof answer?.type === "string" ? answer.type.slice(0, 16) : null;
  if (type !== "noul") return malformed(`answer type must be 'noul', got '${type}'`, { type });
  const probability = answer.probability;
  if (typeof probability !== "number" || !Number.isFinite(probability)) {
    return malformed("noul answer has no finite probability", { type });
  }
  if (probability < 0 || probability > 1) {
    return malformed("noul probability is outside [0, 1]", { type, probability });
  }
  return {
    ok: true,
    status: okStatus,
    pSupport: probability,
    stance: stanceFromProbability(probability),
    failureReason: null,
    typedResponse: { questionName: PS2D_QUESTION_NAME, type: "noul", probability },
  };
}
