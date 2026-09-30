// R4 post-start CONTINUATION record binding (enforcement only).
//
// This module is the PURE record layer of the post-start continuation authority:
// record types, schema versions, statuses, reason codes, immutable artifact
// paths, fingerprints, the deterministic bound-attempt-history digest, the
// structural validators and the record builders. It performs NO Git access, NO
// evidence-root access, no authority resolution and no execution. The canonical
// Git resolver lives in `scripts/r4-continuation.mjs`, which imports and
// re-exports everything defined here.
//
// WHY IT EXISTS (post-A2 deadlock repair). The frozen R4 protocol authorizes
// exactly one pre-capture approval epoch chain `P -> S -> A` with a single
// scientific T0. Attempt 1 then ran and COMPLETED under A2. The post-A2
// approval-epoch bug made every legitimate post-A2 execution fail, and the only
// escapes were scientifically illegitimate: a false A3 renewal that re-anchored
// T0 and falsely claimed zero attempts, or dropping Attempt 1, which is result
// selection. A THIRD, separate authority is therefore required. It is NOT
// approval epoch A3: it is a CONTINUATION carrying the existing cohort across a
// post-start enforcement repair without a new T0, without a new attempt budget
// and without touching any frozen science.
//
// The future commit graph is
//
//   A2 -> P6 -> S6 -> C1
//        |     |     ` continuation-governance-only commit (this authority)
//        |     ` seal-only commit re-issued over the enforcement repair (P6)
//        ` enforcement-only protocol commit (this code, tests and amendment)
//
// C1 binds, at minimum:
//   * the prior scientific approval A2 (commit, epoch, fingerprint);
//   * the prior runtime seal S5 (commit, fingerprint, protocol commit, tree);
//   * the new runtime P6/S6 (commit, tree, fingerprint);
//   * the UNCHANGED frozen `specDigest` / `captureSpecDigest` and the exact frozen
//     provider configuration of the historical cohort baseline;
//   * the exact pre-boundary attempt history: `attemptsUsed`, `completedCount`,
//     `nextAttemptIndex`, `latestTerminalFingerprint` and an immutable
//     deterministic `historyDigest` over ALL pre-boundary attempt identities
//     (authorization + claim + terminal + attestation/session + authority), never
//     a hand-picked attempt;
//   * a fixed reason code meaning "post-start enforcement repair only";
//   * an independent review (reviewer, model, digest, verdict, blockers[]).
//
// ANTI-RESULT-SELECTION. C1 is derived ONLY from authority/integrity/process
// state and terminal history metadata. It never reads price data, disagreement
// values, references, exposure/outcome values, effect sizes or analysis output.
// It automatically includes ALL pre-boundary attempts; no parameter, option,
// allowlist or list may choose which attempts survive, and there is no restart
// or reset path.
//
// No scientific value is introduced, changed or selectable here.
import { canonical, digest } from './market-intelligence/definition.mjs';
import { R4_SPEC, R4_SPEC_DIGEST, captureSpecDigest } from './r4-protocol-spec.mjs';

const fail = code => { throw new Error(code); };
const isSha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const isDigest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const isStamp = value => Number.isSafeInteger(value) && value >= 0;
const isNonEmptyString = value => typeof value === 'string' && value.trim() !== '';
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const R4_CONTINUATION_RECORD_TYPE = 'r4_poststart_continuation';
export const R4_CONTINUATION_REVIEW_RECORD_TYPE = 'r4_poststart_continuation_review';
export const R4_CONTINUATION_SCHEMA_VERSION = 1;
export const R4_CONTINUATION_REVIEW_SCHEMA_VERSION = 1;
export const R4_CONTINUATION_STATUS = 'CONTINUATION_APPROVED';
/** The ONLY reason a continuation may exist: a post-start enforcement repair. */
export const R4_CONTINUATION_REASON = 'POSTSTART_ENFORCEMENT_REPAIR_CONTINUATION';
export const R4_CONTINUATION_REASON_CODES = Object.freeze([R4_CONTINUATION_REASON]);
export const R4_CONTINUATION_REVIEW_VERDICT = 'READY_TO_CONTINUE_COHORT';
/** C1 NEVER derives a new T0; it inherits the A2 T0 verbatim. */
export const R4_CONTINUATION_T0_SOURCE = 'INHERITED_FROM_BOUND_APPROVAL_EPOCH_T0';
/** The continuation-governance store. Authority is Git ancestry, never a pointer. */
export const R4_CONTINUATION_DIR = 'governance/r4/continuations';
/** Attempt budget is unchanged: 8 total, attempt 1 already consumed one. */
export const R4_CONTINUATION_MAX_ATTEMPTS = R4_SPEC.cohort.maxAttempts;
export const R4_CONTINUATION_TARGET_COMPLETED = R4_SPEC.cohort.targetCompletedSessions;

/**
 * No caller may select a continuation generation, commit, fingerprint, T0,
 * window, boundary, date, hour or offset. Anti-hand-picking, exactly like the
 * approval-epoch resolver.
 */
export const R4_CONTINUATION_FORBIDDEN_OPTION_KEYS = Object.freeze([
  'continuation', 'continuationGeneration', 'continuation-generation', 'continuationGenerationIndex',
  'continuationCommit', 'continuationFingerprint', 'generation', 'attemptAllowlist', 'grandfatheredAttempts',
  'grandfatherAllowlist', 'includeAttempts', 'excludeAttempts', 'attemptSelection', 'selectedAttempts',
  't0', 'T0', 't0Iso', 'window', 'windowStart', 'windowEnd', 'startAt', 'start-at', 'date', 'hour',
  'offset', 't0OffsetMs', 'anchorAt', 'reset', 'restart', 'attemptsUsed', 'completedCount',
]);

export const R4_CONTINUATION_INELIGIBLE = Object.freeze({
  outcomeArtifacts: 'R4_CONTINUATION_OUTCOME_ARTIFACTS_PRESENT',
  nonterminalAttempt: 'R4_CONTINUATION_ATTEMPT_NOT_TERMINAL',
  targetReached: 'R4_CONTINUATION_TARGET_ALREADY_REACHED',
  historyMismatch: 'R4_CONTINUATION_BOUND_HISTORY_MISMATCH',
  boundaryEmpty: 'R4_CONTINUATION_BOUND_HISTORY_EMPTY',
  boundaryNotComplete: 'R4_CONTINUATION_BOUND_HISTORY_NOT_CONSECUTIVE',
  providerDrift: 'R4_CONTINUATION_PROVIDER_CONFIGURATION_DRIFT',
  specDrift: 'R4_CONTINUATION_FROZEN_DIGEST_DRIFT',
  review: 'R4_CONTINUATION_REVIEW_INVALID',
  t0Reanchor: 'R4_CONTINUATION_T0_REANCHOR_FORBIDDEN',
  remoteMismatch: 'R4_CONTINUATION_LIVE_REMOTE_MAIN_MISMATCH',
});

/* ------------------------------------------------------------------ paths */

const generationName = generation => `continuation-${String(generation).padStart(4, '0')}`;

/** Canonical tracked path of a continuation record (generation N). */
export function continuationPathForGeneration(generation) {
  if (!Number.isInteger(generation) || generation < 1) fail('R4_CONTINUATION_GENERATION_INVALID');
  return `${R4_CONTINUATION_DIR}/${generationName(generation)}.json`;
}

/** Canonical tracked path of a continuation review record (generation N). */
export function continuationReviewPathForGeneration(generation) {
  if (!Number.isInteger(generation) || generation < 1) fail('R4_CONTINUATION_GENERATION_INVALID');
  return `${R4_CONTINUATION_DIR}/${generationName(generation)}.review.json`;
}

/** The ONLY paths a continuation commit of generation N may change. */
export function continuationGovernancePaths(generation) {
  return Object.freeze([continuationPathForGeneration(generation), continuationReviewPathForGeneration(generation)]);
}

export function allContinuationGovernancePaths() {
  return Object.freeze([R4_CONTINUATION_DIR]);
}

/* ------------------------------------------------------------- fingerprints */

export function continuationFingerprint(record) {
  const content = { ...record };
  delete content.fingerprint;
  return digest(content);
}

export function continuationReviewFingerprint(record) {
  const content = { ...record };
  delete content.fingerprint;
  return digest(content);
}

/* ---------------------------------------------------------- history digest */

/**
 * The identity of ONE pre-boundary attempt, derived from VERIFIED history only.
 * Every field is a durable governance fingerprint or a Git SHA, never a
 * scientific value, price, reference or outcome.
 */
export function attemptIdentity(attempt) {
  if (!isPlainObject(attempt) || !Number.isInteger(attempt.index) || attempt.index < 1) fail('R4_CONTINUATION_ATTEMPT_IDENTITY_INVALID');
  const authorization = attempt.authorization;
  if (!isPlainObject(authorization) || !isDigest(authorization.fingerprint)) fail('R4_CONTINUATION_ATTEMPT_IDENTITY_INVALID');
  return Object.freeze({
    index: attempt.index,
    sessionId: authorization.sessionId,
    cohortStatus: attempt.cohortStatus,
    authorizationFingerprint: authorization.fingerprint,
    claimFingerprint: attempt.claim?.fingerprint ?? null,
    terminalFingerprint: attempt.terminal?.fingerprint ?? null,
    attestationFingerprint: attempt.attestation?.fingerprint ?? null,
    sessionFingerprint: attempt.terminal?.sessionFingerprint ?? attempt.attestation?.sessionFingerprint ?? null,
    sealFingerprint: authorization.sealFingerprint,
    protocolCommit: authorization.protocolCommit,
    protocolTree: authorization.protocolTree,
    sealAuthorityCommit: authorization.sealAuthorityCommit,
    approvalCommit: authorization.approvalCommit,
    approvalEpoch: authorization.approvalEpoch ?? null,
    approvalFingerprint: authorization.approvalFingerprint ?? null,
    t0: authorization.t0,
  });
}

/**
 * Immutable deterministic history digest over ALL pre-boundary attempts. The
 * caller passes EVERY attempt at or below the boundary; a partial list is
 * rejected by `assertBoundHistoryShape`, so no attempt can be dropped from the
 * digest by choosing a shorter input.
 */
/**
 * The digest of the exact frozen provider baseline the continuation carries.
 * It is derived from `R4_SPEC.providers` and must never change: a continuation
 * repairs the runtime, not the science.
 */
export function providerBaselineDigest() {
  return digest(R4_SPEC.providers);
}


export function attemptHistoryDigest(attempts) {
  if (!Array.isArray(attempts) || attempts.length === 0) fail(R4_CONTINUATION_INELIGIBLE.boundaryEmpty);
  return digest({
    purpose: 'R4_POSTSTART_CONTINUATION_BOUND_HISTORY',
    attempts: attempts.map(entry => ({ ...entry })),
  });
}

function assertBoundHistoryShape(boundHistory) {
  if (!isPlainObject(boundHistory)) fail('R4_CONTINUATION_BOUND_HISTORY_INVALID');
  const { attemptsUsed, completedCount, nextAttemptIndex, latestTerminalFingerprint, historyDigest, attemptIdentities } = boundHistory;
  if (!Number.isInteger(attemptsUsed) || attemptsUsed < 1) fail(R4_CONTINUATION_INELIGIBLE.boundaryEmpty);
  if (!Number.isInteger(completedCount) || completedCount < 0 || completedCount > attemptsUsed) fail('R4_CONTINUATION_BOUND_HISTORY_INVALID');
  if (nextAttemptIndex !== attemptsUsed + 1) fail('R4_CONTINUATION_BOUND_HISTORY_INVALID');
  if (!isDigest(latestTerminalFingerprint)) fail('R4_CONTINUATION_BOUND_HISTORY_INVALID');
  if (!isDigest(historyDigest)) fail('R4_CONTINUATION_BOUND_HISTORY_INVALID');
  if (!Array.isArray(attemptIdentities) || attemptIdentities.length !== attemptsUsed) fail(R4_CONTINUATION_INELIGIBLE.boundaryNotComplete);
  attemptIdentities.forEach((entry, i) => {
    if (!isPlainObject(entry) || entry.index !== i + 1) fail(R4_CONTINUATION_INELIGIBLE.boundaryNotComplete);
    if (!isNonEmptyString(entry.sessionId)) fail('R4_CONTINUATION_BOUND_HISTORY_INVALID');
    if (!isDigest(entry.authorizationFingerprint)) fail('R4_CONTINUATION_BOUND_HISTORY_INVALID');
    if (entry.claimFingerprint !== null && !isDigest(entry.claimFingerprint)) fail('R4_CONTINUATION_BOUND_HISTORY_INVALID');
    if (entry.terminalFingerprint !== null && !isDigest(entry.terminalFingerprint)) fail('R4_CONTINUATION_BOUND_HISTORY_INVALID');
    if (entry.attestationFingerprint !== null && !isDigest(entry.attestationFingerprint)) fail('R4_CONTINUATION_BOUND_HISTORY_INVALID');
    if (entry.sessionFingerprint !== null && !isDigest(entry.sessionFingerprint)) fail('R4_CONTINUATION_BOUND_HISTORY_INVALID');
    if (!isDigest(entry.sealFingerprint) || !isSha(entry.protocolCommit) || !isSha(entry.sealAuthorityCommit)) fail('R4_CONTINUATION_BOUND_HISTORY_INVALID');
    if (entry.approvalCommit !== null && !isSha(entry.approvalCommit)) fail('R4_CONTINUATION_BOUND_HISTORY_INVALID');
    if (!isStamp(entry.t0)) fail('R4_CONTINUATION_BOUND_HISTORY_INVALID');
  });
  if (attemptHistoryDigest(attemptIdentities) !== historyDigest) fail('R4_CONTINUATION_BOUND_HISTORY_DIGEST_MISMATCH');
  return true;
}

/**
 * Build the bound-history block from VERIFIED history. EVERY attempt present is
 * included unconditionally: there is no parameter, option, allowlist or list
 * that could select which attempts survive. A `boundaryIndex` that is shorter
 * than the real history is refused, because the omitted attempts would then be
 * dropped rather than grandfathered.
 */
export function buildBoundHistory(verified, boundaryIndex = null) {
  if (!isPlainObject(verified) || !Array.isArray(verified.attempts)) fail('R4_CONTINUATION_BOUND_HISTORY_INVALID');
  const attempts = verified.attempts;
  if (attempts.length === 0) fail(R4_CONTINUATION_INELIGIBLE.boundaryEmpty);
  if (boundaryIndex !== null
    && (!Number.isInteger(boundaryIndex) || boundaryIndex < 1 || boundaryIndex !== attempts.length)) {
    fail(R4_CONTINUATION_INELIGIBLE.boundaryNotComplete);
  }
  // The LAST attempt must be terminal, otherwise a continuation could be created
  // while an attempt is still running and would freeze a non-terminal state.
  const last = attempts.at(-1);
  if (!last?.isTerminal) fail(R4_CONTINUATION_INELIGIBLE.nonterminalAttempt);
  const identities = attempts.map(attemptIdentity);
  return Object.freeze({
    attemptsUsed: attempts.length,
    completedCount: verified.completedCount,
    nextAttemptIndex: verified.attemptsUsed + 1,
    latestTerminalFingerprint: last.terminal.fingerprint,
    historyDigest: attemptHistoryDigest(identities),
    attemptIdentities: identities.map(entry => ({ ...entry })),
  });
}

/* ----------------------------------------------------------------- records */

export function buildContinuationReviewRecord({
  continuation, protocolCommit, protocolTree, sealCommit, sealFingerprint,
  priorApprovalEpoch, priorApprovalCommit, priorApprovalFingerprint, priorSealCommit, priorSealFingerprint,
  boundHistoryDigest, attemptsUsed, completedCount, nextAttemptIndex,
  reviewer, model, reviewedAt, verdict = R4_CONTINUATION_REVIEW_VERDICT, blockers = [],
} = {}) {
  const content = {
    schemaVersion: R4_CONTINUATION_REVIEW_SCHEMA_VERSION, recordType: R4_CONTINUATION_REVIEW_RECORD_TYPE,
    continuation, reason: R4_CONTINUATION_REASON, protocolCommit, protocolTree, sealCommit, sealFingerprint,
    priorApprovalEpoch, priorApprovalCommit, priorApprovalFingerprint, priorSealCommit, priorSealFingerprint,
    boundHistoryDigest, attemptsUsed, completedCount, nextAttemptIndex,
    verdict, reviewer, model, reviewedAt, blockers: [...blockers],
  };
  return { ...content, fingerprint: continuationReviewFingerprint(content) };
}

export function buildContinuationRecord({
  continuation, protocolCommit, protocolTree, sealCommit, sealFingerprint,
  priorApprovalEpoch, priorApprovalCommit, priorApprovalFingerprint, priorSealCommit, priorSealFingerprint,
  priorSealProtocolCommit, priorSealProtocolTree,
  specDigest, captureSpecDigest: capture, providers,
  boundHistory, reviewDigest, continuationReviewer, continuationReviewerModel,
  continuationVerdict = R4_CONTINUATION_REVIEW_VERDICT, t0, maxAttempts = R4_CONTINUATION_MAX_ATTEMPTS,
  targetCompletedSessions = R4_CONTINUATION_TARGET_COMPLETED, reason = R4_CONTINUATION_REASON,
  status = R4_CONTINUATION_STATUS, continuedAt = null,
} = {}) {
  const content = {
    schemaVersion: R4_CONTINUATION_SCHEMA_VERSION, recordType: R4_CONTINUATION_RECORD_TYPE, status, reason,
    continuation,
    priorApproval: { approvalEpoch: priorApprovalEpoch, approvalCommit: priorApprovalCommit, approvalFingerprint: priorApprovalFingerprint },
    priorSeal: { sealCommit: priorSealCommit, sealFingerprint: priorSealFingerprint, protocolCommit: priorSealProtocolCommit, protocolTree: priorSealProtocolTree },
    newRuntime: { protocolCommit, protocolTree, sealCommit, sealFingerprint },
    specDigest, captureSpecDigest: capture, providers,
    boundHistory: {
      attemptsUsed: boundHistory.attemptsUsed, completedCount: boundHistory.completedCount,
      nextAttemptIndex: boundHistory.nextAttemptIndex, latestTerminalFingerprint: boundHistory.latestTerminalFingerprint,
      historyDigest: boundHistory.historyDigest, attemptIdentities: boundHistory.attemptIdentities.map(entry => ({ ...entry })),
    },
    t0, t0Iso: new Date(t0).toISOString(), t0Source: R4_CONTINUATION_T0_SOURCE, reanchorsT0: false,
    maxAttempts, targetCompletedSessions, newAttemptBudget: 0, discretionaryAttemptsPermitted: false,
    outcomeDependentExtensionPermitted: false, outcomeArtifactsPresentAtCreation: false,
    allPreBoundaryAttemptsGrandfathered: true,
    reviewDigest: reviewDigest, continuationReviewer, continuationReviewerModel, continuationVerdict,
    continuedAt,
  };
  return { ...content, fingerprint: continuationFingerprint(content) };
}

export function assertContinuationReviewRecord(record) {
  if (!isPlainObject(record)) fail(R4_CONTINUATION_INELIGIBLE.review);
  if (record.recordType !== R4_CONTINUATION_REVIEW_RECORD_TYPE) fail('R4_CONTINUATION_REVIEW_RECORD_TYPE_INVALID');
  if (record.schemaVersion !== R4_CONTINUATION_REVIEW_SCHEMA_VERSION) fail('R4_CONTINUATION_REVIEW_SCHEMA_INVALID');
  if (record.reason !== R4_CONTINUATION_REASON) fail('R4_CONTINUATION_REVIEW_REASON_INVALID');
  if (!Number.isInteger(record.continuation) || record.continuation < 1) fail('R4_CONTINUATION_GENERATION_INVALID');
  if (!isSha(record.protocolCommit) || !isSha(record.sealCommit) || !isDigest(record.sealFingerprint)) fail('R4_CONTINUATION_REVIEW_AUTHORITY_INVALID');
  if (!Number.isInteger(record.priorApprovalEpoch) || record.priorApprovalEpoch < 1) fail('R4_CONTINUATION_REVIEW_AUTHORITY_INVALID');
  if (!isSha(record.priorApprovalCommit) || !isDigest(record.priorApprovalFingerprint)) fail('R4_CONTINUATION_REVIEW_AUTHORITY_INVALID');
  if (!isSha(record.priorSealCommit) || !isDigest(record.priorSealFingerprint)) fail('R4_CONTINUATION_REVIEW_AUTHORITY_INVALID');
  if (!isDigest(record.boundHistoryDigest)) fail(R4_CONTINUATION_INELIGIBLE.review);
  if (!Number.isInteger(record.attemptsUsed) || record.attemptsUsed < 1) fail(R4_CONTINUATION_INELIGIBLE.review);
  if (!Number.isInteger(record.completedCount) || record.completedCount < 0) fail(R4_CONTINUATION_INELIGIBLE.review);
  if (record.nextAttemptIndex !== record.attemptsUsed + 1) fail(R4_CONTINUATION_INELIGIBLE.review);
  if (record.verdict !== R4_CONTINUATION_REVIEW_VERDICT) fail('R4_CONTINUATION_REVIEW_VERDICT_INVALID');
  if (!isNonEmptyString(record.reviewer) || !isNonEmptyString(record.model)) fail(R4_CONTINUATION_INELIGIBLE.review);
  if (!isStamp(record.reviewedAt)) fail(R4_CONTINUATION_INELIGIBLE.review);
  if (!Array.isArray(record.blockers) || record.blockers.length !== 0) fail('R4_CONTINUATION_REVIEW_BLOCKERS_PRESENT');
  if (!isDigest(record.fingerprint) || continuationReviewFingerprint(record) !== record.fingerprint) fail('R4_CONTINUATION_REVIEW_FINGERPRINT_MISMATCH');
  return true;
}

/**
 * Structural validation of a continuation record (schemaVersion 1).
 *
 * Everything here is a SELF-CONSISTENT check of the record shape. The
 * cross-artifact checks that need Git — that the bound approval really is an
 * epoch of the immutable chain, that the bound prior seal really is S5 with the
 * same frozen digests, that the continuation commit really is the live remote
 * main and HEAD — live in `scripts/r4-continuation.mjs`.
 *
 * The scientific facts are checked here against the LIVE frozen values, so a
 * continuation that claims a different spec, capture spec or provider baseline
 * is rejected even before Git is consulted.
 */
export function assertContinuationRecord(record) {
  if (!isPlainObject(record)) fail(R4_CONTINUATION_INELIGIBLE.review);
  if (record.recordType !== R4_CONTINUATION_RECORD_TYPE) fail('R4_CONTINUATION_RECORD_TYPE_INVALID');
  if (record.schemaVersion !== R4_CONTINUATION_SCHEMA_VERSION) fail('R4_CONTINUATION_SCHEMA_INVALID');
  if (record.status !== R4_CONTINUATION_STATUS) fail('R4_CONTINUATION_STATUS_INVALID');
  // The ONLY reason a continuation may exist.
  if (!R4_CONTINUATION_REASON_CODES.includes(record.reason)) fail('R4_CONTINUATION_REASON_INVALID');
  if (!Number.isInteger(record.continuation) || record.continuation < 1) fail('R4_CONTINUATION_GENERATION_INVALID');
  // NEW RUNTIME (P6/S6).
  const runtime = record.newRuntime;
  if (!isPlainObject(runtime) || !isSha(runtime.protocolCommit) || !isSha(runtime.protocolTree)
    || !isSha(runtime.sealCommit) || !isDigest(runtime.sealFingerprint)) fail('R4_CONTINUATION_NEW_RUNTIME_INVALID');
  // PRIOR SCIENTIFIC APPROVAL (A2) — never a new approval, never a new epoch.
  const prior = record.priorApproval;
  if (!isPlainObject(prior) || !Number.isInteger(prior.approvalEpoch) || prior.approvalEpoch < 1
    || !isSha(prior.approvalCommit) || !isDigest(prior.approvalFingerprint)) fail('R4_CONTINUATION_PRIOR_APPROVAL_INVALID');
  // PRIOR RUNTIME (P5/S5).
  const priorSeal = record.priorSeal;
  if (!isPlainObject(priorSeal) || !isSha(priorSeal.sealCommit) || !isDigest(priorSeal.sealFingerprint)
    || !isSha(priorSeal.protocolCommit) || !isSha(priorSeal.protocolTree)) fail('R4_CONTINUATION_PRIOR_SEAL_INVALID');
  // UNCHANGED SCIENCE. These are compared to the live frozen values, not merely
  // to each other: a continuation may not move any frozen scientific constant.
  if (!isDigest(record.specDigest) || record.specDigest !== R4_SPEC_DIGEST) fail(R4_CONTINUATION_INELIGIBLE.specDrift);
  if (!isDigest(record.captureSpecDigest) || record.captureSpecDigest !== captureSpecDigest()) fail(R4_CONTINUATION_INELIGIBLE.specDrift);
  if (!isDigest(record.providers) || record.providers !== providerBaselineDigest()) fail(R4_CONTINUATION_INELIGIBLE.providerDrift);
  // FROZEN BUDGET, unchanged; a continuation adds no attempt budget.
  if (record.maxAttempts !== R4_CONTINUATION_MAX_ATTEMPTS) fail('R4_CONTINUATION_MAX_ATTEMPTS_DRIFT');
  if (record.targetCompletedSessions !== R4_CONTINUATION_TARGET_COMPLETED) fail('R4_CONTINUATION_TARGET_DRIFT');
  if (record.newAttemptBudget !== 0) fail('R4_CONTINUATION_NEW_ATTEMPT_BUDGET_FORBIDDEN');
  if (record.discretionaryAttemptsPermitted !== false) fail('R4_CONTINUATION_DISCRETIONARY_ATTEMPTS_FORBIDDEN');
  // ANTI-RESULT-SELECTION / OUTCOME INDEPENDENCE.
  if (record.outcomeDependentExtensionPermitted !== false) fail('R4_CONTINUATION_OUTCOME_DEPENDENT_EXTENSION_FORBIDDEN');
  if (record.outcomeArtifactsPresentAtCreation !== false) fail(R4_CONTINUATION_INELIGIBLE.outcomeArtifacts);
  if (record.allPreBoundaryAttemptsGrandfathered !== true) fail('R4_CONTINUATION_ATTEMPT_SELECTION_FORBIDDEN');
  // T0: inherited from the bound approval epoch, never re-anchored.
  if (!isStamp(record.t0)) fail('R4_CONTINUATION_T0_INVALID');
  if (record.t0Source !== R4_CONTINUATION_T0_SOURCE) fail(R4_CONTINUATION_INELIGIBLE.t0Reanchor);
  if (record.reanchorsT0 !== false) fail(R4_CONTINUATION_INELIGIBLE.t0Reanchor);
  if (record.t0Iso !== new Date(record.t0).toISOString()) fail('R4_CONTINUATION_T0_ISO_MISMATCH');
  if (record.continuedAt !== null && !isStamp(record.continuedAt)) fail('R4_CONTINUATION_CONTINUED_AT_INVALID');
  // ALL pre-boundary attempt history is bound, consecutively, with no selection.
  assertBoundHistoryShape(record.boundHistory);
  if (record.boundHistory.nextAttemptIndex !== record.boundHistory.attemptsUsed + 1) fail(R4_CONTINUATION_INELIGIBLE.boundaryNotComplete);
  // INDEPENDENT REVIEW.
  if (!isDigest(record.reviewDigest)) fail(R4_CONTINUATION_INELIGIBLE.review);
  if (!isNonEmptyString(record.continuationReviewer)) fail(R4_CONTINUATION_INELIGIBLE.review);
  if (!isNonEmptyString(record.continuationReviewerModel)) fail(R4_CONTINUATION_INELIGIBLE.review);
  if (record.continuationVerdict !== R4_CONTINUATION_REVIEW_VERDICT) fail('R4_CONTINUATION_VERDICT_INVALID');
  if (!isDigest(record.fingerprint) || continuationFingerprint(record) !== record.fingerprint) {
    fail('R4_CONTINUATION_FINGERPRINT_MISMATCH');
  }
  return true;
}

/** Caller-supplied continuation/T0/generation/attempt-selection is refused. */
export function assertNoContinuationOverride(options = {}) {
  for (const key of Object.keys(options ?? {})) {
    if (R4_CONTINUATION_FORBIDDEN_OPTION_KEYS.includes(key)) fail(`R4_CONTINUATION_OVERRIDE_FORBIDDEN:${key}`);
  }
  return true;
}
