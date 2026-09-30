// R4 missed-window approval renewal — immutable approval EPOCHS (enforcement only).
//
// MISSED ATTEMPT-1 WINDOW GOVERNANCE AMENDMENT. The already-frozen R4 rule says
// that a missed attempt-1 start window is NOT re-anchored and requires a NEW
// independent approval/authorization commit before another T0 can exist
// (docs/R4-PREREGISTRATION.md, "PRE-CAPTURE GOVERNANCE ENFORCEMENT AMENDMENT").
// That rule was correct but only ONE `P -> S -> A` approval was representable, so
// after the single approval's window expired there was no already-defined
// canonical way to create another approval without rewriting history.
//
// This module makes that already-required reauthorization OPERATIONALLY
// REPEATABLE. No scientific rule is changed: 6 completed sessions, 8 maximum
// attempts, 45-minute sessions, `--r4-revisits`, `COHORT_DRAIN_ONLY`, providers,
// universe, freshness, alignment, horizon, tolerance, Policy A/B, E1, reference
// selection, exposure, outcome and the whole analysis are untouched. The missed
// attempt-1 window consumed ZERO attempts.
//
// Approval epochs
// ===============
// An approval epoch is an ADDITIVE Git commit that introduces only approval
// governance artifacts and whose direct parent is a canonical seal commit:
//
//   P_1 -> S_1 -> A_1                       epoch 1 (the legacy single approval)
//   ... A_1 -> P_2 -> S_2 -> A_2            epoch 2 (a renewal, possibly re-sealed)
//   ... A_2 -> A_3                          epoch 3 (a same-seal renewal)
//
//   * epoch 1 is the historical `governance/r4/r4-precapture-approval.json`
//     (schemaVersion 1, unchanged and never rewritten);
//   * epoch N >= 2 lives at `governance/r4/approvals/approval-000N.json`
//     (schemaVersion 2) together with its independent review record
//     `governance/r4/approvals/approval-000N.review.json`.
//
// A renewal binds its IMMEDIATE predecessor (commit + fingerprint + T0 + window
// end + MISSED window status), the protocol/seal it is created against, a NEW
// independent reauthorization review (schemaVersion 1, record type
// `r4_precapture_reauthorization_review`, verdict READY_TO_REAUTHORIZE_COHORT)
// and the proof that ZERO real R4 attempt artifacts existed.
//
// `resolveApprovalEpochChain` is the canonical resolver. It walks Git itself and
// accepts no caller-supplied authority, epoch, T0, window or offset, so no CLI
// option and no market-data input can choose a start time (anti-hand-picking).
// T0_N is mechanical: the first whole UTC hour at least 30 minutes after A_N's
// Git committer timestamp. Only the LATEST epoch may authorize attempt 1; every
// earlier epoch's window is permanently expired.
//
// This module reads Git and the working tree only. It starts nothing, captures
// nothing, writes nothing and holds no trading authority.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { digest, canonical } from './market-intelligence/definition.mjs';
import {
  R4_REPO_ROOT, R4_TRACKED_SEAL_PATH, gitParents, gitShowFile, gitCommitterTimestamp, gitChangedFiles,
} from './r4-authority.mjs';
import { R4_PRECAPTURE_APPROVAL_PATH, R4_ATTEMPT1_START_WINDOW_MS } from './r4-protocol-spec.mjs';
import { mechanicalT0 } from './r4-cohort-plan.mjs';
import { R4_EXCLUSIONS } from './r4-exclusions.mjs';
import { R4_ATTEMPT_AUTH_DIR, R4_ATTESTATION_DIR, R4_CAPTURE_SESSION_ROOT } from './r4-capability.mjs';

export const R4_APPROVAL_EPOCH_RECORD_TYPE = 'r4_precapture_approval';
export const R4_APPROVAL_EPOCH_LEGACY_SCHEMA_VERSION = 1;
export const R4_APPROVAL_EPOCH_SCHEMA_VERSION = 2;
export const R4_RENEWAL_REVIEW_RECORD_TYPE = 'r4_precapture_reauthorization_review';
export const R4_RENEWAL_REVIEW_SCHEMA_VERSION = 1;
export const R4_APPROVAL_EPOCH_STATUS = 'APPROVED';
export const R4_RENEWAL_VERDICT = 'READY_TO_REAUTHORIZE_COHORT';
export const R4_WINDOW_STATUS = Object.freeze({ missing: 'MISSED' });
/** The epoch-1 approval artifact path is frozen and may never move. */
export const R4_LEGACY_APPROVAL_PATH = R4_PRECAPTURE_APPROVAL_PATH;
/** Immutable per-epoch approval artifact directory. */
export const R4_APPROVAL_EPOCHS_DIR = 'governance/r4/approvals';
/** Attempt-1 window length (frozen; never a caller input). */
export const R4_APPROVAL_EPOCH_WINDOW_MS = R4_ATTEMPT1_START_WINDOW_MS;

/** Canonical evidence roots that must contain ZERO real R4 attempt artifacts. */
export const R4_OUTCOME_RUN_ROOTS = Object.freeze([
  '.evolve/market-outcomes',
  '.evolve/market-intelligence/outcomes',
  '.evolve/outcomes',
]);

/**
 * CLI/option keys that may never select an approval epoch, a T0, a window or an
 * offset. A caller cannot choose when a cohort starts.
 */
export const R4_APPROVAL_EPOCH_FORBIDDEN_OPTION_KEYS = Object.freeze([
  't0', 'T0', 'epoch', 'approvalEpoch', 'approval-epoch', 'approval_epoch', 'window', 'startAt',
  'start-at', 'date', 'hour', 'offset', 't0OffsetMs', 'windowStart', 'windowEnd', 'anchorAt',
]);

const fail = code => { throw new Error(code); };
const isSha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const isDigest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const isStamp = value => Number.isSafeInteger(value) && value >= 0;
const isNonEmptyString = value => typeof value === 'string' && value.trim() !== '';

const gitText = (args, cwd) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };

/* ------------------------------------------------------------------- paths */

/** Canonical immutable approval artifact path for an epoch (1-based). */
export function approvalPathForEpoch(epoch) {
  if (!Number.isInteger(epoch) || epoch < 1) fail('R4_APPROVAL_EPOCH_NUMBER_INVALID');
  if (epoch === 1) return R4_LEGACY_APPROVAL_PATH;
  return `${R4_APPROVAL_EPOCHS_DIR}/approval-${String(epoch).padStart(4, '0')}.json`;
}

/** Canonical independent reauthorization review artifact path (epoch >= 2). */
export function renewalReviewPathForEpoch(epoch) {
  if (!Number.isInteger(epoch) || epoch < 2) fail('R4_APPROVAL_EPOCH_NUMBER_INVALID');
  return `${R4_APPROVAL_EPOCHS_DIR}/approval-${String(epoch).padStart(4, '0')}.review.json`;
}

/**
 * The ONLY governance paths an approval epoch commit may change. Epoch 1 is the
 * legacy single artifact; a renewal adds its approval artifact AND the
 * independent review record it binds, in one additive commit.
 */
export function approvalGovernancePathsForEpoch(epoch) {
  if (epoch === 1) return Object.freeze([R4_LEGACY_APPROVAL_PATH]);
  return Object.freeze([approvalPathForEpoch(epoch), renewalReviewPathForEpoch(epoch)].sort());
}

/** Every approval-governance path (used to prove no older artifact was touched). */
export function allApprovalGovernancePaths() {
  return Object.freeze([R4_LEGACY_APPROVAL_PATH, R4_APPROVAL_EPOCHS_DIR]);
}

/* ---------------------------------------------------------------- records */

/** Deterministic content digest (the record's own fingerprint excluded). */
export function approvalEpochFingerprint(record) {
  const content = { ...record };
  delete content.fingerprint;
  return digest(content);
}

export function renewalReviewFingerprint(record) {
  const content = { ...record };
  delete content.fingerprint;
  return digest(content);
}

/** Structural validation of a renewal approval record (epoch >= 2). */
export function assertRenewalApprovalRecord(record) {
  if (!record || typeof record !== 'object') fail('R4_APPROVAL_EPOCH_RECORD_INVALID');
  if (record.recordType !== R4_APPROVAL_EPOCH_RECORD_TYPE) fail('R4_APPROVAL_EPOCH_RECORD_TYPE_INVALID');
  if (record.schemaVersion !== R4_APPROVAL_EPOCH_SCHEMA_VERSION) fail('R4_APPROVAL_EPOCH_SCHEMA_INVALID');
  if (record.status !== R4_APPROVAL_EPOCH_STATUS) fail('R4_APPROVAL_EPOCH_STATUS_INVALID');
  if (!Number.isInteger(record.approvalEpoch) || record.approvalEpoch < 2) fail('R4_APPROVAL_EPOCH_NUMBER_INVALID');
  if (!isSha(record.protocolCommit)) fail('R4_APPROVAL_EPOCH_PROTOCOL_COMMIT_INVALID');
  if (!isSha(record.sealCommit)) fail('R4_APPROVAL_EPOCH_SEAL_COMMIT_INVALID');
  if (!isDigest(record.sealFingerprint)) fail('R4_APPROVAL_EPOCH_SEAL_FINGERPRINT_INVALID');
  if (!isSha(record.previousApprovalCommit)) fail('R4_APPROVAL_EPOCH_PREVIOUS_COMMIT_INVALID');
  if (!isDigest(record.previousApprovalFingerprint)) fail('R4_APPROVAL_EPOCH_PREVIOUS_FINGERPRINT_INVALID');
  if (!isStamp(record.previousT0)) fail('R4_APPROVAL_EPOCH_PREVIOUS_T0_INVALID');
  if (!isStamp(record.previousWindowEnd)) fail('R4_APPROVAL_EPOCH_PREVIOUS_WINDOW_END_INVALID');
  if (record.previousWindowStatus !== R4_WINDOW_STATUS.missing) fail('R4_APPROVAL_EPOCH_PREVIOUS_WINDOW_STATUS_INVALID');
  if (record.realAttemptsUsed !== 0 || record.realSessionsCreated !== 0 || record.realOutcomesCreated !== 0) {
    fail('R4_APPROVAL_EPOCH_REAL_ATTEMPTS_NOT_ZERO');
  }
  if (!isDigest(record.reauthorizationReviewDigest)) fail('R4_APPROVAL_EPOCH_RENEWAL_REVIEW_DIGEST_INVALID');
  if (!isNonEmptyString(record.reauthorizationReviewer)) fail('R4_APPROVAL_EPOCH_RENEWAL_REVIEWER_INVALID');
  if (!isNonEmptyString(record.reauthorizationReviewerModel)) fail('R4_APPROVAL_EPOCH_RENEWAL_REVIEWER_MODEL_INVALID');
  if (record.reauthorizationVerdict !== R4_RENEWAL_VERDICT) fail('R4_APPROVAL_EPOCH_RENEWAL_VERDICT_INVALID');
  if (record.approvedAt !== null && !isStamp(record.approvedAt)) fail('R4_APPROVAL_EPOCH_APPROVED_AT_INVALID');
  if (!isDigest(record.fingerprint)) fail('R4_APPROVAL_EPOCH_FINGERPRINT_INVALID');
  if (approvalEpochFingerprint(record) !== record.fingerprint) fail('R4_APPROVAL_EPOCH_FINGERPRINT_MISMATCH');
  return true;
}

/** Structural validation of the legacy epoch-1 approval record (unchanged schema). */
export function assertLegacyApprovalEpochRecord(record) {
  if (!record || typeof record !== 'object') fail('R4_APPROVAL_EPOCH_RECORD_INVALID');
  if (record.recordType !== R4_APPROVAL_EPOCH_RECORD_TYPE) fail('R4_APPROVAL_EPOCH_RECORD_TYPE_INVALID');
  if (record.schemaVersion !== R4_APPROVAL_EPOCH_LEGACY_SCHEMA_VERSION) fail('R4_APPROVAL_EPOCH_SCHEMA_INVALID');
  if (record.status !== R4_APPROVAL_EPOCH_STATUS) fail('R4_APPROVAL_EPOCH_STATUS_INVALID');
  if (record.approvalEpoch !== undefined) fail('R4_APPROVAL_EPOCH_NUMBER_INVALID');
  if (record.previousApprovalCommit !== undefined) fail('R4_APPROVAL_EPOCH_PREVIOUS_COMMIT_INVALID');
  if (!isSha(record.protocolCommit) || !isSha(record.sealCommit) || !isDigest(record.sealFingerprint)) fail('R4_APPROVAL_EPOCH_AUTHORITY_INVALID');
  if (!isDigest(record.fingerprint) || approvalEpochFingerprint(record) !== record.fingerprint) fail('R4_APPROVAL_EPOCH_FINGERPRINT_MISMATCH');
  return true;
}

/** Structural validation of an independent reauthorization review record. */
export function assertRenewalReviewRecord(record) {
  if (!record || typeof record !== 'object') fail('R4_RENEWAL_REVIEW_INVALID');
  if (record.recordType !== R4_RENEWAL_REVIEW_RECORD_TYPE) fail('R4_RENEWAL_REVIEW_RECORD_TYPE_INVALID');
  if (record.schemaVersion !== R4_RENEWAL_REVIEW_SCHEMA_VERSION) fail('R4_RENEWAL_REVIEW_SCHEMA_INVALID');
  if (!isNonEmptyString(record.reviewer)) fail('R4_RENEWAL_REVIEW_REVIEWER_INVALID');
  if (!isNonEmptyString(record.model)) fail('R4_RENEWAL_REVIEW_MODEL_INVALID');
  if (!isSha(record.protocolCommit)) fail('R4_RENEWAL_REVIEW_PROTOCOL_COMMIT_INVALID');
  if (!isSha(record.sealCommit)) fail('R4_RENEWAL_REVIEW_SEAL_COMMIT_INVALID');
  if (!isDigest(record.sealFingerprint)) fail('R4_RENEWAL_REVIEW_SEAL_FINGERPRINT_INVALID');
  if (!isSha(record.previousApprovalCommit)) fail('R4_RENEWAL_REVIEW_PREVIOUS_COMMIT_INVALID');
  if (!isDigest(record.previousApprovalFingerprint)) fail('R4_RENEWAL_REVIEW_PREVIOUS_FINGERPRINT_INVALID');
  if (record.previousWindowStatus !== R4_WINDOW_STATUS.missing) fail('R4_RENEWAL_REVIEW_PREVIOUS_WINDOW_STATUS_INVALID');
  if (record.realAttemptsUsed !== 0 || record.realSessionsCreated !== 0 || record.realOutcomesCreated !== 0) {
    fail('R4_RENEWAL_REVIEW_REAL_ATTEMPTS_NOT_ZERO');
  }
  if (record.verdict !== R4_RENEWAL_VERDICT) fail('R4_RENEWAL_REVIEW_VERDICT_INVALID');
  if (!Array.isArray(record.blockers) || record.blockers.length !== 0) fail('R4_RENEWAL_REVIEW_BLOCKERS_INVALID');
  if (!isStamp(record.reviewedAt)) fail('R4_RENEWAL_REVIEW_REVIEWED_AT_INVALID');
  if (!isDigest(record.fingerprint)) fail('R4_RENEWAL_REVIEW_FINGERPRINT_INVALID');
  if (renewalReviewFingerprint(record) !== record.fingerprint) fail('R4_RENEWAL_REVIEW_FINGERPRINT_MISMATCH');
  return true;
}

/** Build the FUTURE independent reauthorization review record (never written here). */
export function buildRenewalReviewRecord({
  reviewer, model, protocolCommit, sealCommit, sealFingerprint, previousApprovalCommit,
  previousApprovalFingerprint, realAttemptsUsed = 0, realSessionsCreated = 0, realOutcomesCreated = 0,
  verdict = R4_RENEWAL_VERDICT, blockers = [], reviewedAt,
}) {
  const content = {
    schemaVersion: R4_RENEWAL_REVIEW_SCHEMA_VERSION, recordType: R4_RENEWAL_REVIEW_RECORD_TYPE,
    reviewer, model, protocolCommit, sealCommit, sealFingerprint, previousApprovalCommit,
    previousApprovalFingerprint, previousWindowStatus: R4_WINDOW_STATUS.missing,
    realAttemptsUsed, realSessionsCreated, realOutcomesCreated, verdict, blockers, reviewedAt,
  };
  return { ...content, fingerprint: digest(content) };
}

/** Build the FUTURE renewal approval record (never written here). */
export function buildRenewalApprovalRecord({
  approvalEpoch, protocolCommit, sealCommit, sealFingerprint, previousApprovalCommit,
  previousApprovalFingerprint, previousT0, previousWindowEnd, reauthorizationReviewDigest,
  reauthorizationReviewer, reauthorizationReviewerModel, realAttemptsUsed = 0, realSessionsCreated = 0,
  realOutcomesCreated = 0, status = R4_APPROVAL_EPOCH_STATUS, approvedAt = null,
}) {
  const content = {
    schemaVersion: R4_APPROVAL_EPOCH_SCHEMA_VERSION, recordType: R4_APPROVAL_EPOCH_RECORD_TYPE, status,
    approvalEpoch, protocolCommit, sealCommit, sealFingerprint, previousApprovalCommit,
    previousApprovalFingerprint, previousT0, previousWindowEnd, previousWindowStatus: R4_WINDOW_STATUS.missing,
    realAttemptsUsed, realSessionsCreated, realOutcomesCreated, reauthorizationReviewDigest,
    reauthorizationReviewer, reauthorizationReviewerModel, reauthorizationVerdict: R4_RENEWAL_VERDICT, approvedAt,
  };
  return { ...content, fingerprint: digest(content) };
}

/* -------------------------------------------------- zero-artifact evidence */

/**
 * Prove that the evidence root contains ZERO real R4 attempt artifacts:
 * no pre-attempt authorization, no claim, no terminal record, no capability
 * receipt, no session attestation, no R4 cohort session and no outcome run.
 * The five frozen methods-only exclusion sessions are NOT R4 artifacts and are
 * skipped. Read-only: nothing under `.evolve` is created, moved or removed.
 */
export function listRealR4AttemptArtifacts({ cwd = R4_REPO_ROOT } = {}) {
  const artifacts = [];
  const listDir = dir => { try { return readdirSync(dir).sort(); } catch { return null; } };
  const attemptDir = path.resolve(cwd, R4_ATTEMPT_AUTH_DIR);
  for (const name of listDir(attemptDir) ?? []) {
    if (!statSync(path.join(attemptDir, name)).isFile()) { artifacts.push(`${R4_ATTEMPT_AUTH_DIR}/${name}`); continue; }
    if (/^attempt-[1-9][0-9]*\.json$/.test(name)) artifacts.push(`${R4_ATTEMPT_AUTH_DIR}/${name} (authorization)`);
    else if (/^attempt-[1-9][0-9]*\.claim\.json$/.test(name)) artifacts.push(`${R4_ATTEMPT_AUTH_DIR}/${name} (claim)`);
    else if (/^attempt-[1-9][0-9]*\.terminal\.json$/.test(name)) artifacts.push(`${R4_ATTEMPT_AUTH_DIR}/${name} (terminal)`);
    else if (/^receipt-/.test(name)) artifacts.push(`${R4_ATTEMPT_AUTH_DIR}/${name} (capability receipt)`);
    else artifacts.push(`${R4_ATTEMPT_AUTH_DIR}/${name} (unknown attempt artifact)`);
  }
  const attestationDir = path.resolve(cwd, R4_ATTESTATION_DIR);
  for (const name of listDir(attestationDir) ?? []) artifacts.push(`${R4_ATTESTATION_DIR}/${name} (session attestation)`);
  const sessionDir = path.resolve(cwd, R4_CAPTURE_SESSION_ROOT);
  const excluded = new Set(R4_EXCLUSIONS);
  for (const name of listDir(sessionDir) ?? []) {
    if (excluded.has(name)) continue;
    artifacts.push(`${R4_CAPTURE_SESSION_ROOT}/${name} (R4 cohort session)`);
  }
  for (const root of R4_OUTCOME_RUN_ROOTS) {
    const dir = path.resolve(cwd, root);
    for (const name of listDir(dir) ?? []) {
      const manifest = path.join(dir, name, 'manifest.json');
      if (!existsSync(manifest)) continue;
      artifacts.push(`${root}/${name} (outcome run)`);
    }
  }
  return artifacts;
}

export function assertNoRealR4AttemptArtifacts({ cwd = R4_REPO_ROOT } = {}) {
  const artifacts = listRealR4AttemptArtifacts({ cwd });
  if (artifacts.length) fail(`R4_APPROVAL_EPOCH_ATTEMPT_ARTIFACTS_PRESENT:${artifacts.slice(0, 5).join(',')}`);
  return { ok: true, artifacts };
}

/* ------------------------------------------------------------ eligibility */

/** T0 is a purely mechanical function of an approval commit timestamp. */
export function approvalEpochT0(approvalCommitterTimestampMs) {
  if (!isStamp(approvalCommitterTimestampMs)) fail('R4_APPROVAL_EPOCH_T0_INPUT_INVALID');
  return mechanicalT0(approvalCommitterTimestampMs);
}

export const R4_APPROVAL_EPOCH_INELIGIBLE = Object.freeze({
  beforeWindowEnd: 'R4_RENEWAL_WINDOW_NOT_ELAPSED',
  artifactsPresent: 'R4_APPROVAL_EPOCH_ATTEMPT_ARTIFACTS_PRESENT',
  notLatest: 'R4_RENEWAL_PREVIOUS_EPOCH_NOT_LATEST',
});

/**
 * Missed-window eligibility for a renewal. A renewal is allowed ONLY if the
 * previous approval's attempt-1 window has fully elapsed AND the evidence root
 * contains zero real R4 attempt artifacts. Once any attempt authorization
 * exists, cohort attempt accounting (not approval renewal) governs.
 */
export function evaluateRenewalEligibility({ previousEpoch, latestEpoch = null, now = Date.now(), cwd = R4_REPO_ROOT } = {}) {
  if (!previousEpoch || !Number.isInteger(previousEpoch.epoch) || !isStamp(previousEpoch.t0)) fail('R4_RENEWAL_PREVIOUS_EPOCH_INVALID');
  if (latestEpoch && latestEpoch.epoch !== previousEpoch.epoch) return { eligible: false, reason: R4_APPROVAL_EPOCH_INELIGIBLE.notLatest, previousEpoch };
  const windowEnd = previousEpoch.t0 + R4_APPROVAL_EPOCH_WINDOW_MS;
  if (now < windowEnd) return { eligible: false, reason: R4_APPROVAL_EPOCH_INELIGIBLE.beforeWindowEnd, previousEpoch, windowEnd };
  const artifacts = listRealR4AttemptArtifacts({ cwd });
  if (artifacts.length) return { eligible: false, reason: R4_APPROVAL_EPOCH_INELIGIBLE.artifactsPresent, previousEpoch, windowEnd, artifacts };
  return { eligible: true, reason: null, previousEpoch, previousWindowStatus: R4_WINDOW_STATUS.missing, windowEnd,
    cwd: path.resolve(cwd), requiredNewIndependentReview: true, requiredVerdict: R4_RENEWAL_VERDICT };
}

export function assertRenewalEligible(options = {}) {
  const result = evaluateRenewalEligibility(options);
  if (!result.eligible) fail(result.reason);
  return result;
}

/** Caller-supplied authority is never accepted by the epoch resolver. */
export function assertNoApprovalEpochOverride(options = {}) {
  for (const key of Object.keys(options ?? {})) {
    if (R4_APPROVAL_EPOCH_FORBIDDEN_OPTION_KEYS.includes(key)) fail(`R4_APPROVAL_EPOCH_OVERRIDE_FORBIDDEN:${key}`);
  }
  return true;
}

/* -------------------------------------------------------- Git discovery */

const commitsTouching = (file, cwd) => (gitText(['log', '--format=%H', '--', file], cwd) ?? '').split('\n').filter(Boolean);

/** A seal commit S is a commit whose direct parent P changed only the seal path. */
function sealCommitIdentity({ sealCommit, sealPath, cwd }) {
  const parents = gitParents(sealCommit, cwd);
  if (parents.length !== 1) return null;
  const protocolCommit = parents[0];
  const changed = gitChangedFiles(protocolCommit, sealCommit, cwd);
  if (canonical(changed) !== canonical([sealPath])) return null;
  return { protocolCommit, sealCommit };
}

function readArtifactFromWorktree(file, cwd) {
  try { return JSON.parse(readFileSync(path.resolve(cwd, file), 'utf8')); } catch { return null; }
}

function readArtifactAt(commit, file, cwd) {
  const bytes = gitShowFile(commit, file, cwd);
  if (bytes === null) return null;
  try { return JSON.parse(bytes.toString('utf8')); } catch { return null; }
}

/**
 * Resolve the canonical approval epoch chain from Git.
 *
 * Structural rules (all fail closed):
 *   * an epoch artifact may be introduced by exactly ONE commit — editing or
 *     deleting an older approval artifact is rejected;
 *   * that commit's direct parent must be a canonical seal commit;
 *   * its diff is limited to the epoch's approval-governance paths;
 *   * epochs are consecutive from 1, never forked and never skipped;
 *   * every renewal binds its IMMEDIATE predecessor (commit, fingerprint, T0,
 *     window end, MISSED status) and a valid independent reauthorization review;
 *   * zero real attempt artifacts are enforced prospectively by
 *     `evaluateRenewalEligibility` / `assertRenewalEligible` before a renewal is
 *     created. Chain resolution must remain valid after that renewal authorizes
 *     legitimate cohort attempts;
 *   * every renewal is committed only AFTER the previous window fully elapsed;
 *   * a renewal's parent seal must descend from the previous approval commit.
 *
 * `verifySealBinding: false` is used by the live execution path, which
 * independently verifies the LATEST epoch's record against the CURRENT canonical
 * seal via `verifyApprovalBinding`; epoch >= 2 records are always required to bind
 * the seal artifact at their own seal commit.
 */
export function resolveApprovalEpochChain({
  cwd = R4_REPO_ROOT, sealPath = R4_TRACKED_SEAL_PATH, legacyApprovalPath = R4_LEGACY_APPROVAL_PATH,
  verifySealBinding = true, now = Date.now(),
} = {}) {
  const chain = [];
  for (let epoch = 1; ; epoch++) {
    const artifactPath = epoch === 1 ? legacyApprovalPath : approvalPathForEpoch(epoch);
    const record = readArtifactFromWorktree(artifactPath, cwd);
    if (record === null) {
      if (epoch === 1) fail('R4_APPROVAL_MISSING');
      break;
    }
    const touching = commitsTouching(artifactPath, cwd);
    if (touching.length === 0) fail('R4_APPROVAL_APPROVAL_COMMIT_NOT_FOUND');
    if (touching.length > 1) fail(`R4_APPROVAL_EPOCH_HISTORY_MODIFIED:${artifactPath}`);
    const commit = touching[0];
    const parents = gitParents(commit, cwd);
    if (parents.length !== 1) fail('R4_APPROVAL_APPROVAL_COMMIT_NOT_FOUND');
    const parentCommit = parents[0];
    // The approval's direct parent is either the canonical seal commit (epoch 1,
    // and every renewal that follows an enforcement re-seal) or the IMMEDIATE
    // PREVIOUS approval commit (a same-generation renewal, for which the rule is
    // `parent(new approval commit) == previous approval commit`). Anything else
    // is not an approval commit.
    let identity = sealCommitIdentity({ sealCommit: parentCommit, sealPath, cwd });
    if (!identity && epoch > 1 && parentCommit === chain[epoch - 2].commit) {
      identity = { protocolCommit: chain[epoch - 2].protocolCommit, sealCommit: chain[epoch - 2].sealCommit };
    }
    if (!identity) fail('R4_APPROVAL_APPROVAL_COMMIT_NOT_FOUND');
    const sealCommit = identity.sealCommit;
    const allowed = approvalGovernancePathsForEpoch(epoch);
    const changed = gitChangedFiles(parentCommit, commit, cwd);
    for (const file of changed) if (!allowed.includes(file)) fail(`R4_APPROVAL_GOVERNANCE_SCOPE_VIOLATION:${file}`);
    const recordAtCommit = readArtifactAt(commit, artifactPath, cwd);
    if (recordAtCommit === null) fail('R4_APPROVAL_EPOCH_RECORD_UNREADABLE');
    if (canonical(recordAtCommit) !== canonical(record)) fail(`R4_APPROVAL_EPOCH_HISTORY_MODIFIED:${artifactPath}`);
    const committerTimestamp = gitCommitterTimestamp(commit, cwd);
    if (!isStamp(committerTimestamp)) fail('R4_APPROVAL_EPOCH_COMMITTER_TIMESTAMP_INVALID');
    const entry = { epoch, commit, parentCommit, path: artifactPath, record, fingerprint: approvalEpochFingerprint(record),
      sealCommit, protocolCommit: identity.protocolCommit, committerTimestamp,
      t0: approvalEpochT0(committerTimestamp), t0Iso: new Date(approvalEpochT0(committerTimestamp)).toISOString() };

    if (epoch === 1) {
      assertLegacyApprovalEpochRecord(record);
      if (record.protocolCommit !== identity.protocolCommit || record.sealCommit !== sealCommit) fail('R4_APPROVAL_EPOCH_AUTHORITY_INVALID');
      if (verifySealBinding) bindRecordToSealArtifact({ entry, sealPath, cwd });
      entry.windowEnd = entry.t0 + R4_APPROVAL_EPOCH_WINDOW_MS;
    } else {
      assertRenewalApprovalRecord(record);
      const previous = chain[epoch - 2];
      if (record.approvalEpoch !== epoch) fail('R4_APPROVAL_EPOCH_NUMBER_INVALID');
      if (record.sealCommit !== sealCommit || record.protocolCommit !== identity.protocolCommit) fail('R4_APPROVAL_EPOCH_AUTHORITY_INVALID');
      bindRecordToSealArtifact({ entry, sealPath, cwd });
      const reviewPath = renewalReviewPathForEpoch(epoch);
      const review = readArtifactAt(commit, reviewPath, cwd);
      if (review === null) fail('R4_APPROVAL_EPOCH_RENEWAL_REVIEW_MISSING');
      assertRenewalReviewRecord(review);
      verifyRenewalBinding({ record, review, previous, commit, cwd });
      // Additive linear history: every renewal descends from the previous
      // approval commit, so approval forks are impossible. This is a
      // pedigree/ancestry-path proof, NOT remote proof.
      if (!(Number(gitText(['rev-list', '--ancestry-path', '--count', `${previous.commit}..${commit}`], cwd)) >= 1)) {
        fail('R4_APPROVAL_EPOCH_CHAIN_BROKEN');
      }
      entry.review = review;
      entry.reviewPath = reviewPath;
      entry.reviewFingerprint = renewalReviewFingerprint(review);
      entry.windowEnd = entry.t0 + R4_APPROVAL_EPOCH_WINDOW_MS;
    }
    entry.windowStatus = now >= entry.windowEnd ? R4_WINDOW_STATUS.missing : now < entry.t0 ? 'BEFORE_T0' : 'OPEN';
    chain.push(Object.freeze(entry));
  }
  // Do NOT require the evidence root to remain empty after a renewal has been
  // accepted. Once the latest approval authorizes the cohort, its own attempt
  // artifacts are expected and must not invalidate the immutable Git approval
  // chain. The zero-artifact gate is prospective and lives in renewal
  // eligibility above; authenticated attempt history governs post-approval use.
  const latest = chain.at(-1) ?? null;
  return Object.freeze({ chain: Object.freeze(chain), latest, latestEpoch: latest?.epoch ?? 0 });
}

function bindRecordToSealArtifact({ entry, sealPath, cwd }) {
  const sealArtifact = readArtifactAt(entry.sealCommit, sealPath, cwd);
  if (!sealArtifact) fail('R4_APPROVAL_EPOCH_SEAL_ARTIFACT_MISSING');
  if (sealArtifact.recordType !== 'r4_preregistration_seal' || typeof sealArtifact.fingerprint !== 'string') fail('R4_APPROVAL_EPOCH_SEAL_ARTIFACT_INVALID');
  if (entry.record.sealFingerprint !== sealArtifact.fingerprint) fail('R4_APPROVAL_EPOCH_SEAL_MISMATCH');
}

/** Verify that a renewal binds its immediate predecessor and its review exactly. */
export function verifyRenewalBinding({ record, review, previous, commit, cwd = R4_REPO_ROOT }) {
  if (record.previousApprovalCommit !== previous.commit) fail('R4_APPROVAL_EPOCH_PREVIOUS_COMMIT_MISMATCH');
  if (record.previousApprovalFingerprint !== previous.fingerprint) fail('R4_APPROVAL_EPOCH_PREVIOUS_FINGERPRINT_MISMATCH');
  if (record.approvalEpoch !== previous.epoch + 1) fail('R4_APPROVAL_EPOCH_SKIPPED');
  if (record.previousT0 !== previous.t0) fail('R4_APPROVAL_EPOCH_PREVIOUS_T0_MISMATCH');
  if (record.previousWindowEnd !== previous.t0 + R4_APPROVAL_EPOCH_WINDOW_MS) fail('R4_APPROVAL_EPOCH_PREVIOUS_WINDOW_END_MISMATCH');
  if (record.previousWindowStatus !== R4_WINDOW_STATUS.missing) fail('R4_APPROVAL_EPOCH_PREVIOUS_WINDOW_STATUS_INVALID');
  // The renewal may only be authorized AFTER the previous window fully elapsed.
  const committerTimestamp = gitCommitterTimestamp(commit, cwd);
  if (!isStamp(committerTimestamp) || committerTimestamp < record.previousWindowEnd) fail('R4_APPROVAL_EPOCH_RENEWAL_BEFORE_WINDOW_END');
  // The independent reauthorization review is bound by digest and must agree on
  // every identity it attests.
  //
  // Reviewer INDEPENDENCE is the canonical (reviewer, model) PAIR, extracted with
  // explicit per-schema accessors (see `reviewerIdentityFromRenewalReview` /
  // `reviewerIdentityFromApproval`). Never fall through to another record shape
  // and never compare only the reviewer or only the model: the review schema
  // carries `model`, the epoch-1 approval carries `reviewerModel` and a renewal
  // approval carries `reauthorizationReviewer{,Model}`.
  const renewalReviewer = reviewerIdentityFromRenewalReview(review);
  const previousReviewer = reviewerIdentityFromApproval(previous.record);
  if (renewalReviewer.key === previousReviewer.key) fail('R4_APPROVAL_EPOCH_RENEWAL_REVIEWER_NOT_INDEPENDENT');
  if (record.reauthorizationReviewDigest !== renewalReviewFingerprint(review)) fail('R4_APPROVAL_EPOCH_RENEWAL_REVIEW_DIGEST_MISMATCH');
  if (record.reauthorizationVerdict !== review.verdict) fail('R4_APPROVAL_EPOCH_RENEWAL_VERDICT_MISMATCH');
  if (record.reauthorizationReviewer !== review.reviewer) fail('R4_APPROVAL_EPOCH_RENEWAL_REVIEWER_MISMATCH');
  if (record.reauthorizationReviewerModel !== review.model) fail('R4_APPROVAL_EPOCH_RENEWAL_REVIEWER_MODEL_MISMATCH');
  if (review.protocolCommit !== record.protocolCommit || review.sealCommit !== record.sealCommit
    || review.sealFingerprint !== record.sealFingerprint) fail('R4_APPROVAL_EPOCH_RENEWAL_AUTHORITY_MISMATCH');
  if (review.previousApprovalCommit !== record.previousApprovalCommit
    || review.previousApprovalFingerprint !== record.previousApprovalFingerprint) fail('R4_APPROVAL_EPOCH_RENEWAL_PREVIOUS_MISMATCH');
  if (review.realAttemptsUsed !== 0 || review.realSessionsCreated !== 0 || review.realOutcomesCreated !== 0) fail('R4_RENEWAL_REVIEW_REAL_ATTEMPTS_NOT_ZERO');
  if (review.reviewedAt < record.previousWindowEnd) fail('R4_APPROVAL_EPOCH_RENEWAL_BEFORE_WINDOW_END');
  if (review.reviewedAt > committerTimestamp) fail('R4_APPROVAL_EPOCH_RENEWAL_REVIEW_AFTER_COMMIT');
  return { ok: true, previousEpoch: previous.epoch, epoch: record.approvalEpoch };
}

/* -------------------------------------------------- reviewer independence */

/** The canonical reviewer identity: the (reviewer, model) PAIR plus its key. */
const reviewerIdentity = (reviewer, model) => Object.freeze({ reviewer, model, key: `${reviewer}\u0000${model}` });

/**
 * Canonical reviewer identity of an INDEPENDENT REAUTHORIZATION REVIEW record
 * (recordType `r4_precapture_reauthorization_review`, schemaVersion 1).
 *
 * The review schema stores the model in `record.model`. It is NOT
 * `record.reviewerModel` and NOT `record.reauthorizationReviewerModel`; reading
 * those instead silently yields an empty model segment and makes the
 * independence guard unreachable. Extraction is therefore schema-explicit: an
 * incompatible record shape is rejected, never guessed.
 */
export function reviewerIdentityFromRenewalReview(record) {
  if (!record || typeof record !== 'object') fail('R4_RENEWAL_REVIEW_INVALID');
  if (record.recordType !== R4_RENEWAL_REVIEW_RECORD_TYPE) fail('R4_RENEWAL_REVIEW_RECORD_TYPE_INVALID');
  if (record.schemaVersion !== R4_RENEWAL_REVIEW_SCHEMA_VERSION) fail('R4_RENEWAL_REVIEW_SCHEMA_INVALID');
  if (!isNonEmptyString(record.reviewer)) fail('R4_RENEWAL_REVIEW_REVIEWER_INVALID');
  if (!isNonEmptyString(record.model)) fail('R4_RENEWAL_REVIEW_MODEL_INVALID');
  return reviewerIdentity(record.reviewer, record.model);
}

/**
 * Canonical reviewer identity of an APPROVAL record, i.e. the review that
 * authorized that approval epoch:
 *   * epoch 1 (schemaVersion 1, the historical A1) -> `reviewer` / `reviewerModel`;
 *   * epoch >= 2 (schemaVersion 2, a renewal)       -> `reauthorizationReviewer` /
 *     `reauthorizationReviewerModel`.
 */
export function reviewerIdentityFromApproval(approval) {
  if (!approval || typeof approval !== 'object') fail('R4_APPROVAL_EPOCH_RECORD_INVALID');
  if (approval.recordType !== R4_APPROVAL_EPOCH_RECORD_TYPE) fail('R4_APPROVAL_EPOCH_RECORD_TYPE_INVALID');
  if (approval.schemaVersion === R4_APPROVAL_EPOCH_LEGACY_SCHEMA_VERSION) {
    if (!isNonEmptyString(approval.reviewer)) fail('R4_APPROVAL_REVIEWER_INVALID');
    if (!isNonEmptyString(approval.reviewerModel)) fail('R4_APPROVAL_REVIEWER_MODEL_INVALID');
    return reviewerIdentity(approval.reviewer, approval.reviewerModel);
  }
  if (approval.schemaVersion === R4_APPROVAL_EPOCH_SCHEMA_VERSION) {
    if (!isNonEmptyString(approval.reauthorizationReviewer)) fail('R4_APPROVAL_EPOCH_RENEWAL_REVIEWER_INVALID');
    if (!isNonEmptyString(approval.reauthorizationReviewerModel)) fail('R4_APPROVAL_EPOCH_RENEWAL_REVIEWER_MODEL_INVALID');
    return reviewerIdentity(approval.reauthorizationReviewer, approval.reauthorizationReviewerModel);
  }
  return fail('R4_APPROVAL_EPOCH_SCHEMA_INVALID');
}

/** Convenience: the latest valid approval epoch only. */
export function resolveLatestApprovalEpoch(options = {}) {
  assertNoApprovalEpochOverride(options);
  const { latest, chain } = resolveApprovalEpochChain(options);
  if (!latest) fail('R4_APPROVAL_MISSING');
  return { latest, chain, latestEpoch: latest.epoch };
}
