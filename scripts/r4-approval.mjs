// R4 pre-capture approval commit (A) — schema, Git validator, T0 and window.
//
// This is the prospective governance enforcement amendment made after
// independent pre-capture review round 2 and BEFORE any cohort attempt. It
// replaces the implicit "unlimited late start by omission" behaviour with an
// independent approval authority chain:
//
//   P -> S -> A
//
//   P  protocol implementation commit (contains all code and this module)
//   S  canonical tracked seal commit, direct child of P
//   A  PRE-CAPTURE APPROVAL COMMIT, created ONLY after a later independent
//      review returns READY_TO_AUTHORIZE_COHORT
//
// A must: have S as its direct parent; contain no source-code change; contain no
// scientific-protocol change; add only the canonical tracked approval artifact;
// bind S SHA, seal fingerprint, reviewer/model, verdict, review report digest and
// approval status; and be the LIVE `refs/heads/main` of the authoritative remote
// `origin` (queried with `git ls-remote`, never the cached tracking ref).
//
// Real cohort T0 is then the first whole UTC hour at least 30 minutes after A's
// Git committer timestamp. Attempt 1 may start only inside [T0, T0 + 5 minutes).
// A missed window is NOT re-anchored: it requires a new independently approved
// authorization commit.
//
// This module reads Git only. It starts nothing, captures nothing and (unless the
// caller explicitly asks) writes nothing.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  R4_REPO_ROOT, R4_TRACKED_SEAL_PATH, gitParents, gitShowFile, gitCommitterTimestamp, gitHead,
  gitCommitExists, loadCanonicalTrackedSeal, assertWorktreeIntegrity, assertSealCommitShape,
  assertLiveRemoteMainEquals, isCanonicalSealSuperseded,
} from './r4-authority.mjs';
import { digest, canonical } from './market-intelligence/definition.mjs';
import { mechanicalT0, R4_COHORT_SPEC } from './r4-cohort-plan.mjs';

export const R4_APPROVAL_RECORD_TYPE = 'r4_precapture_approval';
export const R4_APPROVAL_PATH = 'governance/r4/r4-precapture-approval.json';
export const R4_APPROVAL_VERDICT = 'READY_TO_AUTHORIZE_COHORT';
export const R4_APPROVAL_STATUS = 'APPROVED';
export const R4_APPROVAL_SCHEMA_VERSION = 1;
/** Attempt 1 may start only inside [T0, T0 + this window). */
export const R4_ATTEMPT1_WINDOW_MS = R4_COHORT_SPEC.attempt1StartWindowMs;
/** Approved governance paths that may appear in diff(S, A). */
export const R4_APPROVED_GOVERNANCE_PATHS = Object.freeze([R4_APPROVAL_PATH]);

const fail = code => { throw new Error(code); };
const isSha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const isDigest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const gitText = (args, cwd) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };

/** Deterministic content digest of an approval record (its own fingerprint field excluded). */
export function approvalFingerprint(record) {
  const content = { ...record };
  delete content.fingerprint;
  return digest(content);
}

/** Build the FUTURE tracked approval artifact. The real file is never created here. */
export function buildApprovalRecord({ seal, authority, reviewer, reviewerModel, reviewVerdict, reviewReportDigest, status = R4_APPROVAL_STATUS, approvedAt = null }) {
  if (!seal || typeof seal.fingerprint !== 'string') fail('R4_APPROVAL_SEAL_INVALID');
  if (!authority || !isSha(authority.sealAuthorityCommit)) fail('R4_APPROVAL_AUTHORITY_INVALID');
  const content = {
    schemaVersion: R4_APPROVAL_SCHEMA_VERSION, recordType: R4_APPROVAL_RECORD_TYPE, status,
    protocolCommit: authority.protocolCommit ?? seal.protocolCommit, sealCommit: authority.sealAuthorityCommit,
    sealFingerprint: seal.fingerprint, reviewer, reviewerModel, reviewVerdict, reviewReportDigest, approvedAt,
  };
  return { ...content, fingerprint: digest(content) };
}

/** Structural validation of an approval artifact. */
export function assertApprovalRecord(record) {
  if (!record || typeof record !== 'object') fail('R4_APPROVAL_INVALID');
  if (record.recordType !== R4_APPROVAL_RECORD_TYPE) fail('R4_APPROVAL_RECORD_TYPE_INVALID');
  if (record.schemaVersion !== R4_APPROVAL_SCHEMA_VERSION) fail('R4_APPROVAL_SCHEMA_VERSION_INVALID');
  if (record.status !== R4_APPROVAL_STATUS) fail('R4_APPROVAL_STATUS_INVALID');
  if (!isSha(record.protocolCommit)) fail('R4_APPROVAL_PROTOCOL_COMMIT_INVALID');
  if (!isSha(record.sealCommit)) fail('R4_APPROVAL_SEAL_COMMIT_INVALID');
  if (!isDigest(record.sealFingerprint)) fail('R4_APPROVAL_SEAL_FINGERPRINT_INVALID');
  if (typeof record.reviewer !== 'string' || !record.reviewer.trim()) fail('R4_APPROVAL_REVIEWER_INVALID');
  if (typeof record.reviewerModel !== 'string' || !record.reviewerModel.trim()) fail('R4_APPROVAL_REVIEWER_MODEL_INVALID');
  if (record.reviewVerdict !== R4_APPROVAL_VERDICT) fail('R4_APPROVAL_VERDICT_INVALID');
  if (!isDigest(record.reviewReportDigest)) fail('R4_APPROVAL_REVIEW_DIGEST_INVALID');
  if (!isDigest(record.fingerprint)) fail('R4_APPROVAL_FINGERPRINT_INVALID');
  if (approvalFingerprint(record) !== record.fingerprint) fail('R4_APPROVAL_FINGERPRINT_MISMATCH');
  return true;
}

/** Content binding: the approval must name the verified seal/authority exactly. */
export function verifyApprovalBinding({ approval, seal, authority }) {
  assertApprovalRecord(approval);
  if (!seal || approval.sealFingerprint !== seal.fingerprint) fail('R4_APPROVAL_SEAL_MISMATCH');
  if (approval.protocolCommit !== (authority.protocolCommit ?? seal.protocolCommit)) fail('R4_APPROVAL_PROTOCOL_MISMATCH');
  if (authority.sealAuthorityCommit && approval.sealCommit !== authority.sealAuthorityCommit) fail('R4_APPROVAL_SEAL_COMMIT_MISMATCH');
  return true;
}

/**
 * Discover the approval commit A: the commit that added the canonical approval
 * artifact, with S as its DIRECT parent and byte-identical artifact content.
 */
export function findApprovalCommit({ sealAuthorityCommit, approval = null, approvalPath = R4_APPROVAL_PATH, cwd = R4_REPO_ROOT } = {}) {
  if (!isSha(sealAuthorityCommit)) return { found: false, reason: 'SEAL_COMMIT_INVALID' };
  const log = gitText(['log', '--format=%H', '--', approvalPath], cwd);
  const candidates = log ? log.split('\n').filter(Boolean) : [];
  const matches = [];
  for (const candidate of candidates) {
    if (gitParents(candidate, cwd)[0] !== sealAuthorityCommit) continue;
    if (approval) {
      const bytes = gitShowFile(candidate, approvalPath, cwd);
      if (bytes === null) continue;
      let parsed;
      try { parsed = JSON.parse(bytes.toString('utf8')); } catch { continue; }
      if (canonical(parsed) !== canonical(approval)) continue;
    }
    matches.push(candidate);
  }
  if (matches.length === 0) return { found: false, reason: 'APPROVAL_COMMIT_NOT_FOUND' };
  if (matches.length > 1) return { found: false, reason: 'APPROVAL_COMMIT_AMBIGUOUS', matches };
  return { found: true, approvalCommit: matches[0] };
}

/**
 * Enforce the A Git contract: direct parent S, diff(S, A) limited to approved
 * governance paths, LIVE remote main exactly equal to A, and HEAD equal to A.
 *
 * Round 3 (P2-1): the remote proof is a live `git ls-remote` of
 * `origin refs/heads/main` that must equal A exactly — never the cached
 * `refs/remotes/origin/main` and never mere ancestry.
 */
export function verifyApprovalGitContract({
  sealAuthorityCommit, approval, approvalPath = R4_APPROVAL_PATH, cwd = R4_REPO_ROOT,
  requireRemote = true, requireHead = true,
} = {}) {
  const discovery = findApprovalCommit({ sealAuthorityCommit, approval, approvalPath, cwd });
  if (!discovery.found) fail(`R4_APPROVAL_${discovery.reason}`);
  const approvalCommit = discovery.approvalCommit;
  const changed = (gitText(['diff', '--name-only', sealAuthorityCommit, approvalCommit], cwd) ?? '').split('\n').filter(Boolean).sort();
  if (changed.length === 0) fail('R4_APPROVAL_EMPTY_DIFF');
  const allowed = new Set(R4_APPROVED_GOVERNANCE_PATHS);
  for (const file of changed) if (!allowed.has(file)) fail(`R4_APPROVAL_GOVERNANCE_SCOPE_VIOLATION:${file}`);
  let remote = null;
  if (requireRemote) remote = assertLiveRemoteMainEquals(approvalCommit, { cwd, what: 'APPROVAL_COMMIT_A' });
  if (requireHead && gitHead(cwd) !== approvalCommit) fail('R4_APPROVAL_HEAD_NOT_APPROVAL_COMMIT');
  return { ok: true, approvalCommit, changed, remoteSha: remote?.remoteSha ?? null,
    approvalCommitterTimestamp: gitCommitterTimestamp(approvalCommit, cwd),
    committerIso: gitText(['show', '-s', '--format=%cI', approvalCommit], cwd) };
}

/** Real-cohort T0: first whole UTC hour >= A's committer timestamp + 30 min. */
export function approvalT0(approvalCommitterTimestampMs) {
  if (!Number.isSafeInteger(approvalCommitterTimestampMs) || approvalCommitterTimestampMs < 0) fail('R4_APPROVAL_T0_INPUT_INVALID');
  return mechanicalT0(approvalCommitterTimestampMs);
}

export const R4_START_WINDOW = Object.freeze({ before: 'BEFORE_T0', open: 'OPEN', expired: 'WINDOW_MISSED' });

/** [T0, T0 + 5 min): attempt 1 may start. Any missed window needs a new A. */
export function evaluateAttemptStartWindow({ t0, now, windowMs = R4_ATTEMPT1_WINDOW_MS }) {
  if (!Number.isSafeInteger(t0) || !Number.isSafeInteger(now)) fail('R4_START_WINDOW_INPUT_INVALID');
  if (now < t0) return { state: R4_START_WINDOW.before, t0, t0Iso: new Date(t0).toISOString(), startBy: t0 + windowMs };
  if (now >= t0 + windowMs) return { state: R4_START_WINDOW.expired, t0, t0Iso: new Date(t0).toISOString(), startBy: t0 + windowMs };
  return { state: R4_START_WINDOW.open, t0, t0Iso: new Date(t0).toISOString(), startBy: t0 + windowMs, startedAt: now };
}

/**
 * Attempt start gate. Attempt 1 must be inside the predeclared window; a missed
 * window is terminal for this authorization (no re-anchoring, no roll-forward,
 * no new hour). Later attempts are replacement sessions of a cohort whose start
 * was already window-authorized.
 */
export function assertAttemptStartAllowed({ attemptIndex, t0, now, windowMs = R4_ATTEMPT1_WINDOW_MS }) {
  const window = evaluateAttemptStartWindow({ t0, now, windowMs });
  if (attemptIndex === 1 && window.state === R4_START_WINDOW.before) fail('R4_COHORT_BEFORE_T0');
  if (attemptIndex === 1 && window.state === R4_START_WINDOW.expired) fail('R4_ATTEMPT1_START_WINDOW_MISSED');
  return window;
}

/** Read the tracked approval artifact from the working tree, or from Git at `ref`. */
export function readApprovalArtifact({ cwd = R4_REPO_ROOT, ref = null, approvalPath = R4_APPROVAL_PATH } = {}) {
  if (ref) {
    const bytes = gitShowFile(ref, approvalPath, cwd);
    if (bytes === null) return null;
    try { return JSON.parse(bytes.toString('utf8')); } catch { return null; }
  }
  try { return JSON.parse(readFileSync(path.resolve(cwd, approvalPath), 'utf8')); } catch { return null; }
}

/**
 * Resolve the full real-execution authority chain for a repository working tree.
 * This function reads Git and the tracked artifacts itself; it accepts no
 * caller-supplied authority fact (stage, approval SHA, T0, seal object).
 *
 * `requireApproval: false` is the S-stage dry run (authority = S): the LIVE
 * remote main must equal S exactly, and live worktree integrity against S is
 * enforced. `requireApproval: true` is the only path capable of `--execute` or
 * of a canonical analysis: it additionally requires the tracked approval
 * artifact, its content binding, S as A's direct parent, an approval-only diff,
 * LIVE remote main == A exactly, HEAD == A, integrity against A, and it derives
 * T0 from A.
 *
 * Fail-closed order (round-3 section 11, steps 1-6): canonical seal/Git
 * authority -> live remote -> HEAD -> worktree -> approval A -> T0. Approval
 * discovery precedes the remote check at the A stage only because the expected
 * live SHA *is* A.
 */
export function resolveR4ExecutionAuthority({
  cwd = R4_REPO_ROOT, sealPath = R4_TRACKED_SEAL_PATH, approvalPath = R4_APPROVAL_PATH, requireApproval = true,
} = {}) {
  if (isCanonicalSealSuperseded({ cwd, sealPath })) fail('R4_AUTHORITY_SEAL_SUPERSEDED');
  const { seal, authority } = loadCanonicalTrackedSeal({ cwd, sealPath, requireSealCommit: true, requireHead: false, requireRemote: false });
  assertSealCommitShape({ cwd, protocolCommit: authority.protocolCommit, sealAuthorityCommit: authority.sealAuthorityCommit, sealPath });
  if (!requireApproval) {
    const remote = assertLiveRemoteMainEquals(authority.sealAuthorityCommit, { cwd, what: 'SEAL_COMMIT_S' });
    assertWorktreeIntegrity({ cwd, requiredCommit: authority.sealAuthorityCommit, sealPath });
    return { stage: 'S', seal, authority, approval: null, approvalCommit: null, approvalCommitterTimestamp: null, t0: null, t0Iso: null,
      remoteSha: remote.remoteSha };
  }
  const approval = readApprovalArtifact({ cwd, approvalPath });
  if (!approval) fail('R4_APPROVAL_MISSING');
  verifyApprovalBinding({ approval, seal, authority });
  const contract = verifyApprovalGitContract({ sealAuthorityCommit: authority.sealAuthorityCommit, approval, approvalPath, cwd, requireRemote: true, requireHead: true });
  assertWorktreeIntegrity({ cwd, requiredCommit: contract.approvalCommit, sealPath });
  const t0 = approvalT0(contract.approvalCommitterTimestamp);
  return Object.freeze({ stage: 'A', seal, authority, approval, approvalCommit: contract.approvalCommit,
    approvalCommitterTimestamp: contract.approvalCommitterTimestamp, approvalCommitterIso: contract.committerIso,
    t0, t0Iso: new Date(t0).toISOString(), remoteSha: contract.remoteSha });
}

export { gitCommitExists };
