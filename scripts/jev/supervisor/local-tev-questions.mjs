/**
 * Phase 5I-PS.2e — the versioned option-token question set of the shared Local
 * JEV classifier, plus the exact request the client sends.
 *
 * This is a NEW, separately versioned question set. The PS.2d TypeSafe
 * `noul` question (`productionProposalSupported`, probability `pSupport`) is NOT
 * reused, NOT reinterpreted and NOT modified; PS.2e asks a narrow, typed,
 * option-token classification question instead.
 *
 * Frozen semantics:
 *
 *   option `support`          the frozen pre-outcome facts support the proposal
 *   option `do_not_support`   they do not
 *   ABSTAIN                   a PROTOCOL/RUNTIME outcome, requested from the
 *                             shared implementation via `allow_abstain`; it is
 *                             NEVER converted into `support` or `do_not_support`
 *
 * There is NO probability question, NO `pSupport`, NO profitability language, NO
 * future-outcome language, NO trading instruction and NO chain-of-thought
 * request. The shared NobodyWho provider decodes every sample under a GBNF
 * grammar whose only sentences are the allowed option ids, so the classifier
 * cannot answer outside this choice set.
 *
 * PAPER ONLY / SHADOW ONLY / DEVELOPMENT EVIDENCE ONLY. ZERO AUTHORITY.
 */

import { digestOf } from "../../lib/hash.mjs";
import {
  PS2E_DECISIONS,
  PS2E_LOCAL_JEV_CALLER,
  PS2E_LOCAL_JEV_MODE,
  PS2E_MAX_FAILURE_REASON_LENGTH,
  PS2E_PHASE,
  PS2E_QUESTION_ID,
  PS2E_QUESTION_NAME,
  PS2E_QUESTION_SET_ID,
  PS2E_QUESTION_SET_VERSION,
} from "./local-tev-protocol.mjs";

/* ============================================================================
 * The question
 * ==========================================================================*/

export const PS2E_QUESTION_TEXT =
  "Using ONLY the frozen pre-outcome facts in this state (information available to the EVOLVE paper engine at or " +
  "before proposalAt, with no future data), which classification is appropriate for EVOLVE's finalized production " +
  "entry proposal to open a long PAPER position in the identified asset (identified by baseMint, priced in USD with " +
  "USDC as the quote numeraire) at the frozen reference price? Answer with exactly one option id.";

export const PS2E_OPTION_TOKENS = Object.freeze({
  SUPPORT: "support",
  DO_NOT_SUPPORT: "do_not_support",
});

export const PS2E_OPTION_CRITERIA = Object.freeze({
  [PS2E_OPTION_TOKENS.SUPPORT]: "The frozen pre-outcome facts support the production entry proposal as stated.",
  [PS2E_OPTION_TOKENS.DO_NOT_SUPPORT]: "The frozen pre-outcome facts do not support the production entry proposal as stated.",
});

export const PS2E_ABSTAIN_TOKEN = "ABSTAIN";

export const PS2E_ABSTAIN_SEMANTICS =
  "ABSTAIN is the shared contract's reserved option (requested through allow_abstain): the classifier could not " +
  "validly decide from the frozen facts. PS.2e records it as the protocol outcome ABSTAIN and never maps it onto " +
  "SUPPORT or DO_NOT_SUPPORT";

export const PS2E_RESPONSE_SEMANTICS = Object.freeze({
  decisionSource: "the shared Local JEV local-first router's accepted tier",
  decisions: Object.freeze([PS2E_DECISIONS.SUPPORT, PS2E_DECISIONS.DO_NOT_SUPPORT, PS2E_DECISIONS.ABSTAIN]),
  supportMeansCorrectness: false,
  nonSupportMeansWrong: false,
  decisionIsForecast: false,
  decisionIsTradingSignal: false,
  probabilityRequested: false,
  probabilityFieldsPresent: false,
  confidenceThresholdApplied: false,
  malformedBecomesDecision: false,
  abstainConvertedToBinary: false,
  outcomeResolved: false,
  thinkingRequired: false,
  essaysOrReasoningRequested: false,
  futureOutcomeLanguagePresent: false,
  profitabilityLanguagePresent: false,
});

/**
 * The frozen request risk level. The shared implementation renders it into the
 * model prompt (`State (risk: ...)`), so it is MODEL-VISIBLE content: it is a
 * fixed constant AND it is covered by the complete-input digest.
 */
export const PS2E_REQUEST_RISK = "medium";

/**
 * The shared decision contract's reserved ABSTAIN option description. The shared
 * implementation renders it into the model prompt as the third option's
 * criterion, so it is MODEL-VISIBLE content and is covered by the
 * complete-input digest (a fixed constant is still digested).
 */
export const PS2E_ABSTAIN_DESCRIPTION = "The evidence in the state is not sufficient to choose one option safely.";

/** Deterministic: the same call always produces the same plain-data structure. */
export function buildLocalTevQuestions() {
  return {
    questionSetId: PS2E_QUESTION_SET_ID,
    questionSetVersion: PS2E_QUESTION_SET_VERSION,
    questionId: PS2E_QUESTION_ID,
    questionName: PS2E_QUESTION_NAME,
    question: PS2E_QUESTION_TEXT,
    risk: PS2E_REQUEST_RISK,
    options: {
      [PS2E_OPTION_TOKENS.SUPPORT]: PS2E_OPTION_CRITERIA[PS2E_OPTION_TOKENS.SUPPORT],
      [PS2E_OPTION_TOKENS.DO_NOT_SUPPORT]: PS2E_OPTION_CRITERIA[PS2E_OPTION_TOKENS.DO_NOT_SUPPORT],
    },
    optionTokens: [PS2E_OPTION_TOKENS.SUPPORT, PS2E_OPTION_TOKENS.DO_NOT_SUPPORT],
    allowAbstain: true,
    abstainToken: PS2E_ABSTAIN_TOKEN,
    abstainDescription: PS2E_ABSTAIN_DESCRIPTION,
    abstainSemantics: PS2E_ABSTAIN_SEMANTICS,
    responseSemantics: PS2E_RESPONSE_SEMANTICS,
  };
}

export function localTevQuestionDigest() {
  return digestOf(buildLocalTevQuestions());
}

export const PS2E_OPTION_TOKEN_COUNT = 3; // support | do_not_support | ABSTAIN

/** Every token the grammar admits. */
export function allowedTokens() {
  return [PS2E_OPTION_TOKENS.SUPPORT, PS2E_OPTION_TOKENS.DO_NOT_SUPPORT, PS2E_ABSTAIN_TOKEN];
}

/**
 * The frozen option-token → decision rule. `null` for anything else: an unknown
 * token is never mapped onto a decision.
 */
export function decisionFromOptionToken(token) {
  if (token === PS2E_OPTION_TOKENS.SUPPORT) return PS2E_DECISIONS.SUPPORT;
  if (token === PS2E_OPTION_TOKENS.DO_NOT_SUPPORT) return PS2E_DECISIONS.DO_NOT_SUPPORT;
  if (token === PS2E_ABSTAIN_TOKEN) return PS2E_DECISIONS.ABSTAIN;
  return null;
}

function boundedReason(text) {
  return String(text ?? "").slice(0, PS2E_MAX_FAILURE_REASON_LENGTH);
}

/* ============================================================================
 * The request the shared Local JEV implementation receives
 * ==========================================================================*/

/**
 * Build the ONE request object the shared `decision ask` contract accepts.
 *
 * `state` is the finalized packet itself (the shared contract takes an object),
 * so the classifier sees exactly the digested payload and nothing else.
 */
export function buildLocalTevRequest({ requestId, packet, risk = PS2E_REQUEST_RISK }) {
  return {
    id: requestId,
    question_id: PS2E_QUESTION_ID,
    state: packet,
    question: PS2E_QUESTION_TEXT,
    choices: {
      [PS2E_OPTION_TOKENS.SUPPORT]: PS2E_OPTION_CRITERIA[PS2E_OPTION_TOKENS.SUPPORT],
      [PS2E_OPTION_TOKENS.DO_NOT_SUPPORT]: PS2E_OPTION_CRITERIA[PS2E_OPTION_TOKENS.DO_NOT_SUPPORT],
    },
    allow_abstain: true,
    risk,
  };
}

/**
 * Deterministic request id: `<sessionId>-tev<globalAdmissionIndex>`. The shared
 * implementation echoes it back, which proves the answer belongs to this exact
 * request (a mismatched echo is a malformed answer, never a decision).
 */
export function localTevRequestIdFor({ sessionId, globalAdmissionIndex }) {
  return `${sessionId}-tev${globalAdmissionIndex}`;
}

/** The client's frozen CLI invocation (recorded for provenance). */
export const PS2E_LOCAL_JEV_INVOCATION = Object.freeze({
  argv: Object.freeze(["ask", "--caller", PS2E_LOCAL_JEV_CALLER, "--mode", PS2E_LOCAL_JEV_MODE]),
  stdin: "one JSON request object",
  stdout: "one JSON outcome object",
  mode: PS2E_LOCAL_JEV_MODE,
});

export const PS2E_CLIENT_RESPONSE_PROBLEM_REASONS = Object.freeze([
  "not_json",
  "not_an_object",
  "request_id_mismatch",
  "mode_mismatch",
  "skipped_by_shared_router",
  "shared_router_error",
  "invalid_request_rejected",
  "decision_shape_invalid",
  "attempt_shape_invalid",
  "follow_outside_option_set",
]);

export function boundedClientProblem(text) {
  return boundedReason(text);
}

export const PS2E_QUESTION_PHASE = PS2E_PHASE;
