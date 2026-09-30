// R4 post-start runtime CONTINUATION resolution from Git (stage C, enforcement
// only).
//
// The canonical record layer — record types, schema versions, immutable paths,
// fingerprints, the bound-attempt-history digest, structural validators and the
// record builders — lives in `scripts/r4-continuation-binding.mjs` and is
// re-exported here so callers have a single canonical import site. This module
// adds the Git/evidence resolution on top of it: the C-stage chain walk, the
// continuation Git contract (LIVE remote main == C1 and HEAD == C1), the outcome
// artifact gate and prospective continuation eligibility.
//
// Stage C of the R4 authority chain:
//
//   A2 -> P6 -> S6 -> C1
//
// where A2 is the unchanged scientific approval (commit, epoch, fingerprint and
// T0), P6 the post-repair protocol commit, S6 the new canonical seal commit and
// C1 the canonical continuation record. The full rationale for this stage, and
// the anti-result-selection guarantees it carries, are documented in the binding
// module.
//
// Rules enforced here (all fail closed):
//   * the structural chain may resolve at any time, including after attempt
//     artifacts exist;
//   * every continuation artifact is introduced by exactly ONE commit, whose
//     direct parent is a canonical seal commit (or the previous continuation
//     commit) and whose diff is limited to that generation's governance paths;
//   * the continuation binds the A2 approval identity and T0 EXACTLY; T0 is
//     never re-derived from the continuation commit;
//   * the historical runtime (P5/S5) and its seal artifact are read from Git and
//     must carry the same spec/capture-spec digests as the new seal, proving the
//     science is unchanged;
//   * the bound attempt history is the verified canonical history: exactly the
//     pre-boundary attempts, each by its exact authorization/claim/terminal
//     fingerprint, with no gap, drop, renumber or rewrite;
//   * no outcome artifact may exist and no attempt may be nonterminal;
//   * no caller-supplied authority, generation, T0 or offset is ever accepted.
//
// This module reads Git and the working tree only. It starts nothing, captures
// nothing, writes nothing and holds no trading authority.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { canonical, digest } from './market-intelligence/definition.mjs';
import {
  R4_REPO_ROOT, gitParents, gitShowFile, gitChangedFiles, gitCommitterTimestamp, gitHead,
  assertLiveRemoteMainEquals,
} from './r4-authority.mjs';
import { R4_TRACKED_SEAL_PATH, R4_SPEC, R4_SPEC_DIGEST, captureSpecDigest } from './r4-protocol-spec.mjs';
import { verifyR4Seal } from './r4-preregistration-seal.mjs';
import { R4_OUTCOME_RUN_ROOTS, approvalPathForEpoch, approvalEpochT0 } from './r4-approval-epochs.mjs';
// The pure record layer — record types, schema versions, statuses, reason codes,
// immutable paths, fingerprints, the bound-attempt-history digest, structural
// validators and builders — lives in `scripts/r4-continuation-binding.mjs`. No Git
// or evidence access happens there. It is re-exported below so callers have a
// single canonical import site for the whole continuation authority.
import {
  R4_CONTINUATION_RECORD_TYPE, R4_CONTINUATION_REVIEW_RECORD_TYPE, R4_CONTINUATION_SCHEMA_VERSION,
  R4_CONTINUATION_REVIEW_SCHEMA_VERSION, R4_CONTINUATION_STATUS, R4_CONTINUATION_REASON,
  R4_CONTINUATION_REASON_CODES, R4_CONTINUATION_REVIEW_VERDICT, R4_CONTINUATION_T0_SOURCE,
  R4_CONTINUATION_DIR, R4_CONTINUATION_MAX_ATTEMPTS, R4_CONTINUATION_TARGET_COMPLETED,
  R4_CONTINUATION_FORBIDDEN_OPTION_KEYS, R4_CONTINUATION_INELIGIBLE,
  continuationPathForGeneration, continuationReviewPathForGeneration, continuationGovernancePaths,
  allContinuationGovernancePaths, continuationFingerprint, continuationReviewFingerprint,
  attemptIdentity, attemptHistoryDigest, buildBoundHistory, buildContinuationReviewRecord,
  buildContinuationRecord, assertContinuationReviewRecord, assertContinuationRecord,
  assertNoContinuationOverride, providerBaselineDigest,
} from './r4-continuation-binding.mjs';

export {
  R4_CONTINUATION_RECORD_TYPE, R4_CONTINUATION_REVIEW_RECORD_TYPE, R4_CONTINUATION_SCHEMA_VERSION,
  R4_CONTINUATION_REVIEW_SCHEMA_VERSION, R4_CONTINUATION_STATUS, R4_CONTINUATION_REASON,
  R4_CONTINUATION_REASON_CODES, R4_CONTINUATION_REVIEW_VERDICT, R4_CONTINUATION_T0_SOURCE,
  R4_CONTINUATION_DIR, R4_CONTINUATION_MAX_ATTEMPTS, R4_CONTINUATION_TARGET_COMPLETED,
  R4_CONTINUATION_FORBIDDEN_OPTION_KEYS, R4_CONTINUATION_INELIGIBLE,
  continuationPathForGeneration, continuationReviewPathForGeneration, continuationGovernancePaths,
  allContinuationGovernancePaths, continuationFingerprint, continuationReviewFingerprint,
  attemptIdentity, attemptHistoryDigest, buildBoundHistory, buildContinuationReviewRecord,
  buildContinuationRecord, assertContinuationReviewRecord, assertContinuationRecord,
  assertNoContinuationOverride, providerBaselineDigest,
};

const fail = code => { throw new Error(code); };
const isSha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const isDigest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const isStamp = value => Number.isSafeInteger(value) && value >= 0;
const isNonEmptyString = value => typeof value === 'string' && value.trim() !== '';
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const gitText = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'buffer' });
  if (r.status !== 0) return null;
  return r.stdout.toString('utf8').trim();
};

/* -------------------------------------------------- outcome artifact gate */

/**
 * Any canonical outcome run present in the evidence root. A continuation is a
 * POST-CAPTURE governance act, so it is illegal once an outcome run exists: the
 * continuation must never be created to react to results.
 */
export function listOutcomeArtifacts({ cwd = R4_REPO_ROOT } = {}) {
  const found = [];
  const listDir = dir => { try { return readdirSync(dir).sort(); } catch { return null; } };
  for (const root of R4_OUTCOME_RUN_ROOTS) {
    for (const name of listDir(path.resolve(cwd, root)) ?? []) {
      if (existsSync(path.resolve(cwd, root, name, 'manifest.json'))) found.push(`${root}/${name}`);
    }
  }
  return found;
}

/* ------------------------------------------------------------- eligibility */

/**
 * Continuation eligibility. Based ONLY on authority/integrity/process state and
 * terminal history metadata — never on price data, disagreement, references,
 * future outcomes, effect sizes or analysis. The inputs are the VERIFIED history
 * and the resolved authority; there is no discretionary input at all.
 */
export function evaluateContinuationEligibility({ verified, continuation = 1, now = Date.now() } = {}) {
  if (!isPlainObject(verified) || !Array.isArray(verified.attempts) || verified.attempts.length === 0) {
    return { eligible: false, reason: R4_CONTINUATION_INELIGIBLE.boundaryEmpty };
  }
  if (!Number.isInteger(continuation) || continuation < 1) fail('R4_CONTINUATION_GENERATION_INVALID');
  const last = verified.attempts.at(-1);
  if (!last?.isTerminal) {
    return { eligible: false, reason: R4_CONTINUATION_INELIGIBLE.nonterminalAttempt, blockingAttempt: last?.index ?? null, blockingState: last?.state ?? null };
  }
  if (verified.completedCount >= R4_CONTINUATION_TARGET_COMPLETED) {
    return { eligible: false, reason: R4_CONTINUATION_INELIGIBLE.targetReached, completedCount: verified.completedCount };
  }
  if (verified.attemptsUsed >= R4_CONTINUATION_MAX_ATTEMPTS) {
    return { eligible: false, reason: R4_CONTINUATION_INELIGIBLE.targetReached, attemptsUsed: verified.attemptsUsed };
  }
  // The bound history is derived from EVERY attempt, unconditionally.
  const boundHistory = buildBoundHistory(verified);
  return {
    eligible: true, reason: null, continuation, now, boundHistory,
    attemptsUsed: boundHistory.attemptsUsed, completedCount: boundHistory.completedCount,
    nextAttemptIndex: boundHistory.nextAttemptIndex, historyDigest: boundHistory.historyDigest,
    requiredVerdict: R4_CONTINUATION_REVIEW_VERDICT, requiredReason: R4_CONTINUATION_REASON,
    maxAttempts: R4_CONTINUATION_MAX_ATTEMPTS, newAttemptBudget: 0, reanchorsT0: false,
  };
}

export function assertContinuationEligible(options = {}) {
  const result = evaluateContinuationEligibility(options);
  if (!result.eligible) fail(result.reason);
  return result;
}

/**
 * The full eligibility gate, including the evidence-root checks that depend on
 * the filesystem (outcome runs). Split from `evaluateContinuationEligibility`
 * so the pure function above stays trivially testable.
 */
export function assertContinuationEligibleInEvidenceRoot({ verified, continuation = 1, now = Date.now(), cwd = R4_REPO_ROOT } = {}) {
  const outcomes = listOutcomeArtifacts({ cwd });
  if (outcomes.length) return { eligible: false, reason: R4_CONTINUATION_INELIGIBLE.outcomeArtifacts, outcomeRuns: outcomes };
  return evaluateContinuationEligibility({ verified, continuation, now });
}

/* ------------------------------------------------------------ Git discovery */

const commitsTouching = (file, cwd) => (gitText(['log', '--format=%H', '--', file], cwd) ?? '').split('\n').filter(Boolean);

const readArtifactFromWorktree = (file, cwd) => {
  try { return JSON.parse(readFileSync(path.resolve(cwd, file), 'utf8')); } catch { return null; }
};

const readArtifactAt = (commit, file, cwd) => {
  const bytes = gitShowFile(commit, file, cwd);
  if (bytes === null) return null;
  try { return JSON.parse(bytes.toString('utf8')); } catch { return null; }
};

/** Highest continuation generation present in the working tree (0 = none). */
export function latestContinuationGeneration({ cwd = R4_REPO_ROOT, dir = R4_CONTINUATION_DIR } = {}) {
  let names;
  try { names = readdirSync(path.resolve(cwd, dir)); } catch { return 0; }
  const generations = names
    .map(name => /^continuation-([0-9]{4})\.json$/.exec(name))
    .filter(Boolean)
    .map(match => Number(match[1]))
    .filter(generation => generation >= 1);
  return generations.length ? Math.max(...generations) : 0;
}

/**
 * C1's commit shape. C is a GOVERNANCE-ONLY commit:
 *   * it is introduced by exactly ONE commit (never edited or deleted later);
 *   * that commit has a single parent, which must be the canonical seal commit
 *     S that C binds as `newRuntime.sealCommit`, so the graph is A2 -> P6 -> S6 -> C1;
 *   * its diff is limited to that generation's continuation-governance paths;
 *   * the review record is added by the SAME commit.
 */
export function assertContinuationCommitShape({ cwd, commit, generation }) {
  const recordPath = continuationPathForGeneration(generation);
  const reviewPath = continuationReviewPathForGeneration(generation);
  const parents = gitParents(commit, cwd);
  if (parents.length !== 1) fail('R4_CONTINUATION_COMMIT_PARENT_INVALID');
  const changed = gitChangedFiles(parents[0], commit, cwd);
  const allowed = new Set(continuationGovernancePaths(generation));
  for (const file of changed) if (!allowed.has(file)) fail(`R4_CONTINUATION_GOVERNANCE_SCOPE_VIOLATION:${file}`);
  if (!changed.includes(recordPath)) fail('R4_CONTINUATION_RECORD_NOT_IN_COMMIT');
  if (!changed.includes(reviewPath)) fail('R4_CONTINUATION_REVIEW_NOT_IN_COMMIT');
  return { ok: true, parentCommit: parents[0], changed, allowedPaths: [...allowed].sort() };
}

function isStrictAncestor(ancestor, descendant, cwd) {
  if (!isSha(ancestor) || !isSha(descendant) || ancestor === descendant) return false;
  const count = Number(gitText(['rev-list', '--ancestry-path', '--count', ancestor + '..' + descendant], cwd));
  return Number.isInteger(count) && count >= 1;
}

/**
 * A continuation record must agree with its independent review record on every
 * bound identity, must still bind the IMMUTABLE prior approval and prior seal
 * artifacts as they exist in Git, and must NOT re-anchor T0.
 */
export function verifyContinuationBinding({ record, review, commit, sealPath = R4_TRACKED_SEAL_PATH, cwd = R4_REPO_ROOT }) {
  if (review.continuation !== record.continuation) fail('R4_CONTINUATION_REVIEW_GENERATION_MISMATCH');
  if (record.reviewDigest !== review.fingerprint) fail('R4_CONTINUATION_REVIEW_DIGEST_MISMATCH');
  if (review.priorApprovalEpoch !== record.priorApproval.approvalEpoch
    || review.priorApprovalCommit !== record.priorApproval.approvalCommit
    || review.priorApprovalFingerprint !== record.priorApproval.approvalFingerprint) fail('R4_CONTINUATION_REVIEW_PRIOR_APPROVAL_MISMATCH');
  if (review.priorSealCommit !== record.priorSeal.sealCommit || review.priorSealFingerprint !== record.priorSeal.sealFingerprint) {
    fail('R4_CONTINUATION_REVIEW_PRIOR_SEAL_MISMATCH');
  }
  if (review.protocolCommit !== record.newRuntime.protocolCommit || review.protocolTree !== record.newRuntime.protocolTree
    || review.sealCommit !== record.newRuntime.sealCommit || review.sealFingerprint !== record.newRuntime.sealFingerprint) {
    fail('R4_CONTINUATION_REVIEW_NEW_RUNTIME_MISMATCH');
  }
  if (review.boundHistoryDigest !== record.boundHistory.historyDigest) fail('R4_CONTINUATION_REVIEW_HISTORY_MISMATCH');
  if (review.attemptsUsed !== record.boundHistory.attemptsUsed || review.completedCount !== record.boundHistory.completedCount
    || review.nextAttemptIndex !== record.boundHistory.nextAttemptIndex) fail('R4_CONTINUATION_REVIEW_HISTORY_MISMATCH');
  if (record.continuationReviewer !== review.reviewer || record.continuationReviewerModel !== review.model) fail('R4_CONTINUATION_REVIEW_IDENTITY_MISMATCH');
  if (record.continuationVerdict !== review.verdict) fail('R4_CONTINUATION_REVIEW_VERDICT_MISMATCH');
  if (record.reanchorsT0 !== false || record.t0Source !== R4_CONTINUATION_T0_SOURCE) fail(R4_CONTINUATION_INELIGIBLE.t0Reanchor);
  // The independent review may never postdate the continuation commit.
  if (review.reviewedAt > gitCommitterTimestamp(commit, cwd)) fail('R4_CONTINUATION_REVIEW_AFTER_COMMIT');

  // The prior scientific approval is still the IMMUTABLE tracked artifact in Git.
  const approvalArtifact = readArtifactAt(record.priorApproval.approvalCommit, approvalPathForEpoch(record.priorApproval.approvalEpoch), cwd);
  if (approvalArtifact === null) fail('R4_CONTINUATION_PRIOR_APPROVAL_ARTIFACT_MISSING');
  const approvalContent = { ...approvalArtifact };
  delete approvalContent.fingerprint;
  if (digest(approvalContent) !== record.priorApproval.approvalFingerprint) fail('R4_CONTINUATION_PRIOR_APPROVAL_FINGERPRINT_MISMATCH');
  const priorApprovalTimestamp = gitCommitterTimestamp(record.priorApproval.approvalCommit, cwd);
  if (!isStamp(priorApprovalTimestamp) || record.t0 !== approvalEpochT0(priorApprovalTimestamp)) {
    fail(R4_CONTINUATION_INELIGIBLE.t0Reanchor);
  }

  // The prior seal artifact is still the immutable tracked seal in Git.
  const priorSealArtifact = readArtifactAt(record.priorSeal.sealCommit, sealPath, cwd);
  if (priorSealArtifact === null) fail('R4_CONTINUATION_PRIOR_SEAL_ARTIFACT_MISSING');
  if (priorSealArtifact.fingerprint !== record.priorSeal.sealFingerprint) fail('R4_CONTINUATION_PRIOR_SEAL_MISMATCH');
  if (priorSealArtifact.protocolCommit !== record.priorSeal.protocolCommit) fail('R4_CONTINUATION_PRIOR_SEAL_PROTOCOL_MISMATCH');
  if (priorSealArtifact.specDigest !== record.specDigest || priorSealArtifact.captureSpecDigest !== record.captureSpecDigest) {
    fail(R4_CONTINUATION_INELIGIBLE.specDrift);
  }
  // The prior seal must be an ANCESTOR of the new protocol commit: the repair
  // supersedes S5 (unavoidable — which is why A2 stops being the RUNTIME
  // authority), but it may not silently drop it.
  if (!isStrictAncestor(record.priorSeal.sealCommit, record.newRuntime.protocolCommit, cwd)) fail('R4_CONTINUATION_PRIOR_SEAL_NOT_ANCESTOR');
  return { ok: true, priorApprovalArtifact: approvalArtifact, priorSealArtifact };
}

/**
 * Resolve the canonical continuation chain from Git. This is the ONLY way a
 * continuation is ever selected: it accepts no caller-supplied generation,
 * commit, fingerprint or T0, so no CLI option and no market-data input can
 * choose one.
 *
 * Returns `{ chain: [], latest: null }` when no continuation exists (the
 * pre-continuation A-stage behaviour is then unchanged), otherwise the
 * validated latest continuation. Structural rules, all fail closed:
 *   * consecutive generations from 1, never forked and never skipped;
 *   * each generation's record and review are valid and mutually bound;
 *   * each record binds its prior approval, prior seal, new runtime, frozen
 *     digests, provider configuration, bound history and T0 inheritance;
 *   * the record's `newRuntime` IS the seal commit the continuation descends from.
 */
export function resolveContinuationChain({
  cwd = R4_REPO_ROOT, sealPath = R4_TRACKED_SEAL_PATH, seal = null, authority = null,
  verifySealBinding = true,
} = {}) {
  const chain = [];
  for (let generation = 1; ; generation++) {
    const recordPath = continuationPathForGeneration(generation);
    const record = readArtifactFromWorktree(recordPath, cwd);
    if (record === null) {
      if (generation === 1) break;
      if (readArtifactFromWorktree(continuationReviewPathForGeneration(generation), cwd) !== null) {
        fail('R4_CONTINUATION_RECORD_MISSING');
      }
      break;
    }
    if (record.continuation !== generation) fail('R4_CONTINUATION_GENERATION_INVALID');
    const touching = commitsTouching(recordPath, cwd);
    if (touching.length === 0) fail('R4_CONTINUATION_COMMIT_NOT_FOUND');
    if (touching.length > 1) fail(`R4_CONTINUATION_HISTORY_MODIFIED:${recordPath}`);
    const commit = touching[0];
    const shape = assertContinuationCommitShape({ cwd, commit, generation });
    const committed = readArtifactAt(commit, recordPath, cwd);
    if (committed === null) fail('R4_CONTINUATION_RECORD_UNREADABLE');
    if (canonical(committed) !== canonical(record)) fail(`R4_CONTINUATION_HISTORY_MODIFIED:${recordPath}`);

    assertContinuationRecord(record);
    const reviewPath = continuationReviewPathForGeneration(generation);
    const review = readArtifactAt(commit, reviewPath, cwd);
    if (review === null) fail('R4_CONTINUATION_REVIEW_MISSING');
    assertContinuationReviewRecord(review);
    verifyContinuationBinding({ record, review, commit, sealPath, cwd });

    // The record's newRuntime IS the seal commit the continuation descends from.
    if (shape.parentCommit !== record.newRuntime.sealCommit) fail('R4_CONTINUATION_SEAL_COMMIT_MISMATCH');
    const sealArtifact = readArtifactAt(record.newRuntime.sealCommit, sealPath, cwd);
    if (!sealArtifact) fail('R4_CONTINUATION_SEAL_ARTIFACT_MISSING');
    if (sealArtifact.recordType !== 'r4_preregistration_seal' || sealArtifact.fingerprint !== record.newRuntime.sealFingerprint) {
      fail('R4_CONTINUATION_SEAL_MISMATCH');
    }
    if (sealArtifact.protocolCommit !== record.newRuntime.protocolCommit) fail('R4_CONTINUATION_PROTOCOL_COMMIT_MISMATCH');
    // When the caller supplies the resolved canonical seal/authority, the
    // continuation must be bound to it exactly: that is what makes C (not A2)
    // the current RUNTIME authority while the SCIENTIFIC identity stays A2.
    if (verifySealBinding && seal && authority) {
      if (seal.fingerprint !== record.newRuntime.sealFingerprint
        || seal.protocolCommit !== record.newRuntime.protocolCommit
        || seal.protocolTree !== record.newRuntime.protocolTree) fail('R4_CONTINUATION_NOT_CURRENT_SEAL');
      if (authority.sealAuthorityCommit !== record.newRuntime.sealCommit) fail('R4_CONTINUATION_NOT_CURRENT_SEAL');
    }

    const committerTimestamp = gitCommitterTimestamp(commit, cwd);
    if (!isStamp(committerTimestamp)) fail('R4_CONTINUATION_COMMITTER_TIMESTAMP_INVALID');
    // The historical seal artifact, read from Git and verified, is what a
    // GRANDATHERED pre-boundary attempt is checked against: an old attempt is
    // verified against the authority it was ACTUALLY authorized under, not
    // against the current seal.
    chain.push(Object.freeze({
      generation, commit, parentCommit: shape.parentCommit, path: recordPath, record, reviewPath, review,
      fingerprint: continuationFingerprint(record), reviewFingerprint: continuationReviewFingerprint(review),
      committerTimestamp, changed: Object.freeze([...shape.changed]),
      priorSeal: readHistoricalSealArtifact({ cwd, record, sealPath }),
      priorApprovalArtifact: readArtifactAt(record.priorApproval.approvalCommit, approvalPathForEpoch(record.priorApproval.approvalEpoch), cwd),
    }));
  }
  const latest = chain.at(-1) ?? null;
  return Object.freeze({ chain: Object.freeze(chain), latest, latestGeneration: latest?.generation ?? 0 });
}

/**
 * The immutable historical seal artifact a continuation binds as `priorSeal`,
 * read from Git and fully verified with the canonical seal validator. Grandfathered
 * pre-boundary attempts are authenticated against THIS authority, so a new seal
 * can never make an old attempt fail for the wrong reason.
 */
export function readHistoricalSealArtifact({ cwd = R4_REPO_ROOT, record, sealPath = R4_TRACKED_SEAL_PATH } = {}) {
  if (!isPlainObject(record?.priorSeal)) fail('R4_CONTINUATION_PRIOR_SEAL_INVALID');
  const artifact = readArtifactAt(record.priorSeal.sealCommit, sealPath, cwd);
  if (artifact === null) fail('R4_CONTINUATION_PRIOR_SEAL_ARTIFACT_MISSING');
  if (artifact.fingerprint !== record.priorSeal.sealFingerprint) fail('R4_CONTINUATION_PRIOR_SEAL_MISMATCH');
  if (artifact.protocolCommit !== record.priorSeal.protocolCommit) fail('R4_CONTINUATION_PRIOR_SEAL_PROTOCOL_MISMATCH');
  try { verifyR4Seal(artifact); } catch { fail('R4_CONTINUATION_PRIOR_SEAL_UNVERIFIABLE'); }
  return artifact;
}

/** Convenience: the latest valid continuation only (null when none exists). */
export function resolveLatestContinuation(options = {}) {
  const { latest, chain, latestGeneration } = resolveContinuationChain(options);
  if (!latest) return { latest: null, chain, latestGeneration: 0 };
  return { latest, chain, latestGeneration };
}

/**
 * The C-stage Git contract: the continuation commit must be the LIVE remote
 * main exactly and HEAD exactly. There is no flag that disables this.
 */
export function assertContinuationGitContract({ commit, cwd = R4_REPO_ROOT, requireRemote = true, requireHead = true } = {}) {
  if (!isSha(commit)) fail('R4_CONTINUATION_COMMIT_INVALID');
  let remote = null;
  if (requireRemote) remote = assertLiveRemoteMainEquals(commit, { cwd, what: 'CONTINUATION_COMMIT_C' });
  if (requireHead && gitHead(cwd) !== commit) fail('R4_CONTINUATION_HEAD_NOT_CONTINUATION_COMMIT');
  return { ok: true, continuationCommit: commit, remoteSha: remote?.remoteSha ?? null };
}
