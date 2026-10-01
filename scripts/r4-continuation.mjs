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
  assertLiveRemoteMainEquals, verifyR4SealAuthority,
} from './r4-authority.mjs';
import { R4_TRACKED_SEAL_PATH, R4_SPEC, R4_SPEC_DIGEST, captureSpecDigest } from './r4-protocol-spec.mjs';
import { verifyR4Seal, R4_SEAL_RECORD_TYPE } from './r4-preregistration-seal.mjs';
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
  R4_CONTINUATION_OUTCOME_ROOTS,
  R4_CONTINUATION_FORBIDDEN_OPTION_KEYS, R4_CONTINUATION_INELIGIBLE,
  continuationPathForGeneration, continuationReviewPathForGeneration, continuationGovernancePaths,
  allContinuationGovernancePaths, continuationFingerprint, continuationReviewFingerprint,
  attemptIdentity, attemptHistoryDigest, buildBoundHistory, buildContinuationReviewRecord,
  buildContinuationRecord, assertContinuationReviewRecord, assertContinuationRecord,
  assertNoContinuationOverride, assertCreationTimeOutcomeIndependence, providerBaselineDigest,
} from './r4-continuation-binding.mjs';

export {
  R4_CONTINUATION_RECORD_TYPE, R4_CONTINUATION_REVIEW_RECORD_TYPE, R4_CONTINUATION_SCHEMA_VERSION,
  R4_CONTINUATION_REVIEW_SCHEMA_VERSION, R4_CONTINUATION_STATUS, R4_CONTINUATION_REASON,
  R4_CONTINUATION_REASON_CODES, R4_CONTINUATION_REVIEW_VERDICT, R4_CONTINUATION_T0_SOURCE,
  R4_CONTINUATION_DIR, R4_CONTINUATION_MAX_ATTEMPTS, R4_CONTINUATION_TARGET_COMPLETED,
  R4_CONTINUATION_OUTCOME_ROOTS,
  R4_CONTINUATION_FORBIDDEN_OPTION_KEYS, R4_CONTINUATION_INELIGIBLE,
  continuationPathForGeneration, continuationReviewPathForGeneration, continuationGovernancePaths,
  allContinuationGovernancePaths, continuationFingerprint, continuationReviewFingerprint,
  attemptIdentity, attemptHistoryDigest, buildBoundHistory, buildContinuationReviewRecord,
  buildContinuationRecord, assertContinuationReviewRecord, assertContinuationRecord,
  assertNoContinuationOverride, assertCreationTimeOutcomeIndependence, providerBaselineDigest,
};

const fail = code => { throw new Error(code); };
/** The historical seal is a canonical seal record; only its VERIFIER is generation-parameterized. */
const R4_HISTORICAL_SEAL_RECORD_TYPE = R4_SEAL_RECORD_TYPE;
const R4_HISTORICAL_SEAL_SCHEMA_VERSION = 1;
const R4_HISTORICAL_SEAL_STATUS = 'SEALED';
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
export function assertContinuationEligibleInEvidenceRoot(options = {}) {
  // The construction-generation parameter is permitted here (it names the record
  // about to be built); every other override key is refused.
  assertNoContinuationOverride(options, { allowCreationGeneration: true });
  const { verified, continuation = 1, now = Date.now(), cwd = R4_REPO_ROOT } = options;
  // CREATION-TIME outcome gate. A continuation is a post-capture governance act;
  // it must never be created in response to results, so at construction time the
  // canonical outcome roots must be empty. This is enforced in the construction
  // path (and by `assertContinuationRecord`), not merely documented.
  const outcomes = listOutcomeArtifacts({ cwd });
  if (outcomes.length) return { eligible: false, reason: R4_CONTINUATION_INELIGIBLE.outcomeArtifacts, outcomeRuns: outcomes };
  return evaluateContinuationEligibility({ verified, continuation, now });
}

/**
 * RESOLUTION-time outcome independence.
 *
 * Once a valid C1 exists it must stay resolvable forever, including after the
 * cohort finishes and a legitimate outcome run is generated from its six
 * sessions. Conversely, a continuation must never be usable if an outcome run
 * already existed when it was created — that would be a result-driven
 * continuation.
 *
 * The two are separated by the C1 authority time, which is the committer
 * timestamp of the C1 commit itself (an immutable Git fact, never a caller
 * input). Outcome manifests carry a canonical `createdAt`:
 *
 *   createdAt <= C1 authority time  => the run predates C1 => C1 is INVALID
 *   createdAt >  C1 authority time  => the run is a legitimate post-C1 product
 *
 * Only process/integrity metadata is read — the manifest's `createdAt`,
 * `recordType`, `schemaVersion` and `status`. No outcome value, price,
 * disagreement, reference, exposure, effect size or analysis result is ever
 * inspected. A manifest that cannot be read or parsed fails CLOSED, because an
 * unreadable pre-C1 run must never be silently treated as post-C1.
 */
export function assertNoPreContinuationOutcomeArtifacts({ cwd = R4_REPO_ROOT, continuationAuthorityAt } = {}) {
  if (!isStamp(continuationAuthorityAt)) fail('R4_CONTINUATION_OUTCOME_GATE_TIME_INVALID');
  const runs = listOutcomeArtifacts({ cwd });
  const preExisting = [];
  for (const run of runs) {
    const manifestPath = path.resolve(cwd, run, 'manifest.json');
    let manifest;
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { fail('R4_CONTINUATION_OUTCOME_MANIFEST_UNREADABLE'); }
    if (!isPlainObject(manifest)) fail('R4_CONTINUATION_OUTCOME_MANIFEST_UNREADABLE');
    // Structural integrity of the manifest as a PROCESS artifact. A manifest that
    // is not a finalized canonical outcome manifest cannot be dated, and an
    // undatable run is treated as pre-existing (fail closed).
    if (manifest.recordType !== 'outcome_manifest' || manifest.schemaVersion !== 1 || manifest.status !== 'finalized') {
      fail('R4_CONTINUATION_OUTCOME_MANIFEST_UNVERIFIABLE');
    }
    if (!isStamp(manifest.createdAt)) fail('R4_CONTINUATION_OUTCOME_MANIFEST_UNVERIFIABLE');
    if (manifest.createdAt <= continuationAuthorityAt) preExisting.push(run);
  }
  if (preExisting.length) {
    return { ok: false, reason: R4_CONTINUATION_INELIGIBLE.outcomeArtifacts, outcomeRuns: preExisting };
  }
  return { ok: true, outcomeRuns: runs, continuationAuthorityAt };
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
export function resolveContinuationChain(options = {}) {
  // PROGRAMMATIC OVERRIDE GUARD. The CLI guard in `parseRunnerArgs` only covers
  // argv; this is the single programmatic entrypoint through which every
  // continuation is ever selected, so a caller-supplied generation, commit,
  // fingerprint, T0, boundary, offset, reset or attempt allowlist is refused here
  // too. Only the resolution context keys are ever accepted.
  assertNoContinuationOverride(options);
  const {
    cwd = R4_REPO_ROOT, sealPath = R4_TRACKED_SEAL_PATH, seal = null, authority = null,
    verifySealBinding = true,
  } = options;
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
    // OUTCOME INDEPENDENCE AT RESOLUTION. The C1 authority time is this commit's
    // own committer timestamp — an immutable Git fact, never a caller input. A
    // canonical outcome run that already existed at that moment would prove the
    // continuation was created in response to results, so C1 is invalid. A run
    // created later is a legitimate product of the cohort this C1 carries and
    // must NOT retroactively invalidate it. Only manifest process metadata is
    // read; no outcome value is ever inspected.
    const outcomeGate = assertNoPreContinuationOutcomeArtifacts({ cwd, continuationAuthorityAt: committerTimestamp });
    if (!outcomeGate.ok) fail(`${R4_CONTINUATION_INELIGIBLE.outcomeArtifacts}:${outcomeGate.outcomeRuns.join(',')}`);
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
 * A HISTORICAL seal is authenticated against the Git snapshot IT SEALED, never
 * against the current runtime.
 *
 * The current canonical `verifyR4Seal` deliberately pins a seal to the CURRENT
 * generation: it compares `seal.artifactAuthority` and the bound-file SET against
 * the live `R4_ARTIFACT_AUTHORITY` / `R4_REQUIRED_BOUND_FILES` constants, and
 * hashes bound files out of the CURRENT worktree. That is exactly right for the
 * live S6 seal and exactly wrong for S5: an enforcement-only repair legitimately
 * changes both the artifact-authority schema and the bound-file set, so
 * re-verifying S5 with the current verifier rejects a perfectly valid historical
 * seal (R4_SEAL_ARTIFACT_AUTHORITY_DRIFT / R4_SEAL_BOUND_FILE_SET_DRIFT /
 * R4_SEAL_FILE_DIGEST_MISMATCH) and would make the post-start continuation
 * permanently unresolvable — B1.
 *
 * The two verifiers are therefore kept strictly separate and neither is
 * weakened:
 *
 *   CURRENT seal   -> verifyR4Seal(...)                  (unchanged, canonical)
 *   HISTORICAL seal-> verifyHistoricalSealArtifact(...)  (this function)
 *
 * A historical seal is trusted only for what is immutable about it:
 *   1. its own self-fingerprint over its own content;
 *   2. its record type / schema / status;
 *   3. the exact identity the continuation bound (fingerprint, seal commit,
 *      protocol commit, protocol tree);
 *   4. every bound-file digest re-computed from the blobs AT ITS OWN
 *      `protocolCommit` in Git, over ITS OWN recorded bound-file set — never the
 *      current file set and never the current worktree;
 *   5. Git discovery of the seal-authority commit for that protocol commit,
 *      which must equal the bound `priorSeal.sealCommit` exactly.
 *
 * It never consults market data, outcome values, effect sizes or analysis, and
 * it can never make a CURRENT seal acceptable: a seal claiming the current
 * protocol commit still has to satisfy the current canonical verifier at the
 * current runtime.
 */
export function verifyHistoricalSealArtifact(seal, { cwd = R4_REPO_ROOT, sealPath = R4_TRACKED_SEAL_PATH, expected = null } = {}) {
  if (!isPlainObject(seal)) fail('R4_HISTORICAL_SEAL_INVALID');
  // 1. immutable self-fingerprint.
  const { fingerprint, ...content } = seal;
  if (!isDigest(fingerprint) || digest(content) !== fingerprint) fail('R4_HISTORICAL_SEAL_FINGERPRINT_MISMATCH');
  // 2. structural identity of the seal record itself.
  if (seal.recordType !== R4_HISTORICAL_SEAL_RECORD_TYPE) fail('R4_HISTORICAL_SEAL_RECORD_TYPE_INVALID');
  if (seal.schemaVersion !== R4_HISTORICAL_SEAL_SCHEMA_VERSION) fail('R4_HISTORICAL_SEAL_SCHEMA_INVALID');
  if (seal.status !== R4_HISTORICAL_SEAL_STATUS) fail('R4_HISTORICAL_SEAL_STATUS_INVALID');
  // 4a. the historical seal must describe an immutable Git snapshot.
  if (!isSha(seal.protocolCommit) || !isSha(seal.protocolTree)) fail('R4_HISTORICAL_SEAL_GIT_IDENTITY_INVALID');
  if (seal.git?.protocolCommit !== seal.protocolCommit || seal.git?.protocolTree !== seal.protocolTree) {
    fail('R4_HISTORICAL_SEAL_GIT_IDENTITY_DRIFT');
  }
  if (!isPlainObject(seal.boundFiles) || Object.keys(seal.boundFiles).length === 0) {
    fail('R4_HISTORICAL_SEAL_BOUND_FILES_INVALID');
  }
  // 3. the identity the continuation bound must equal the artifact's own.
  if (isPlainObject(expected)) {
    if (seal.fingerprint !== expected.sealFingerprint) fail('R4_HISTORICAL_SEAL_FINGERPRINT_MISMATCH');
    if (seal.protocolCommit !== expected.protocolCommit) fail('R4_HISTORICAL_SEAL_PROTOCOL_MISMATCH');
    if (seal.protocolTree !== expected.protocolTree) fail('R4_HISTORICAL_SEAL_PROTOCOL_TREE_MISMATCH');
  }
  // 4b + 5. every historical bound-file digest, re-computed from the blobs AT the
  // historical protocol commit, over the historical seal's OWN bound-file set.
  // `requireHead`/`requireRemote` are false because the historical protocol
  // commit is by construction neither HEAD nor live remote main any more; the
  // seal-commit identity check below is the binding that must hold.
  let authority;
  try {
    authority = verifyR4SealAuthority(seal, {
      cwd, sealPath, requiredFiles: Object.keys(seal.boundFiles),
      requireSealCommit: true, requireHead: false, requireRemote: false,
    });
  } catch (error) {
    fail(`R4_HISTORICAL_SEAL_UNVERIFIABLE:${String(error?.message ?? error).split(':')[0]}`);
  }
  if (isPlainObject(expected) && isSha(expected.sealCommit)
    && authority.sealAuthorityCommit !== expected.sealCommit) {
    fail('R4_HISTORICAL_SEAL_COMMIT_MISMATCH');
  }
  return Object.freeze({ ok: true, fingerprint: seal.fingerprint, protocolCommit: seal.protocolCommit,
    protocolTree: seal.protocolTree, sealAuthorityCommit: authority.sealAuthorityCommit,
    boundFileCount: authority.boundFileCount });
}

/**
 * The immutable historical seal artifact a continuation binds as `priorSeal`,
 * read from Git and authenticated against the snapshot it sealed. Grandfathered
 * pre-boundary attempts are authenticated against THIS authority, so a new seal
 * can never make an old attempt fail for the wrong reason.
 */
export function readHistoricalSealArtifact({ cwd = R4_REPO_ROOT, record, sealPath = R4_TRACKED_SEAL_PATH } = {}) {
  if (!isPlainObject(record?.priorSeal)) fail('R4_CONTINUATION_PRIOR_SEAL_INVALID');
  const priorSeal = record.priorSeal;
  if (!isSha(priorSeal.sealCommit) || !isDigest(priorSeal.sealFingerprint)
    || !isSha(priorSeal.protocolCommit) || !isSha(priorSeal.protocolTree)) {
    fail('R4_CONTINUATION_PRIOR_SEAL_INVALID');
  }
  const artifact = readArtifactAt(priorSeal.sealCommit, sealPath, cwd);
  if (artifact === null) fail('R4_CONTINUATION_PRIOR_SEAL_ARTIFACT_MISSING');
  verifyHistoricalSealArtifact(artifact, { cwd, sealPath, expected: {
    sealFingerprint: priorSeal.sealFingerprint, sealCommit: priorSeal.sealCommit,
    protocolCommit: priorSeal.protocolCommit, protocolTree: priorSeal.protocolTree } });
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
