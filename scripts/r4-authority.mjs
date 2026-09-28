// R4 committed authority chain (enforcement only).
//
// The canonical R4 authority is a TRACKED seal, not a Git-ignored runtime file
// and not a redundant mutable pointer:
//
//   PROTOCOL COMMIT P   contains all code, the full preregistration, the
//                       enforcement modules and the validators. It does NOT
//                       contain the final generated seal.
//   SEAL COMMIT S       adds ONLY the canonical tracked seal. S has P as its
//                       direct parent. The seal content binds P, not S.
//   APPROVAL COMMIT A   adds ONLY the canonical tracked pre-capture approval
//                       artifact. A has S as its direct parent. Real cohort T0 is
//                       derived from A's committer timestamp (see
//                       `scripts/r4-approval.mjs`).
//
// This module reads Git and the working tree only. It starts nothing, captures
// nothing and holds no trading authority.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical } from './market-intelligence/definition.mjs';
import { mechanicalT0 } from './r4-cohort-plan.mjs';
import { R4_TRACKED_SEAL_PATH, R4_PRECAPTURE_APPROVAL_PATH, R4_REQUIRED_BOUND_FILES } from './r4-protocol-spec.mjs';
import { verifyR4Seal } from './r4-preregistration-seal.mjs';

export const R4_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export { R4_TRACKED_SEAL_PATH, R4_PRECAPTURE_APPROVAL_PATH, R4_REQUIRED_BOUND_FILES };
export const R4_REMOTE_MAIN = 'origin/main';

export const sha256Hex = value => createHash('sha256').update(value).digest('hex');
const isSha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);

function git(args, cwd = R4_REPO_ROOT) {
  const result = spawnSync('git', args, { cwd, encoding: 'buffer' });
  if (result.error) throw new Error('R4_AUTHORITY_GIT_UNAVAILABLE');
  if (result.status !== 0) return { ok: false, status: result.status, stdout: null, stderr: String(result.stderr ?? '') };
  return { ok: true, status: 0, stdout: result.stdout, stderr: '' };
}

const gitText = (args, cwd) => { const r = git(args, cwd); return r.ok ? r.stdout.toString('utf8').trim() : null; };

export function gitCommitExists(sha, cwd = R4_REPO_ROOT) {
  if (!isSha(sha)) return false;
  return git(['cat-file', '-e', `${sha}^{commit}`], cwd).ok;
}

export function gitTree(sha, cwd = R4_REPO_ROOT) {
  return gitText(['rev-parse', `${sha}^{tree}`], cwd);
}

// `git show --format=%ct` reports UNIX seconds; every consumer of this value
// (mechanical T0, approval T0, attestation T0) works in milliseconds, so convert
// exactly once here. A seconds value must never leak into T0 arithmetic.
export function gitCommitterTimestamp(sha, cwd = R4_REPO_ROOT) {
  const value = gitText(['show', '-s', '--format=%ct', sha], cwd);
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

export function gitCommitterIso(sha, cwd = R4_REPO_ROOT) {
  const value = gitText(['show', '-s', '--format=%cI', sha], cwd);
  return value || null;
}

export function gitParents(sha, cwd = R4_REPO_ROOT) {
  const value = gitText(['show', '-s', '--format=%P', sha], cwd);
  return value ? value.split(/\s+/).filter(Boolean) : [];
}

export function gitHead(cwd = R4_REPO_ROOT) {
  return gitText(['rev-parse', 'HEAD'], cwd);
}

/** Names of the paths that differ between `from` and `to`, sorted. */
export function gitChangedFiles(from, to, cwd = R4_REPO_ROOT) {
  return (gitText(['diff', '--name-only', from, to], cwd) ?? '').split('\n').filter(Boolean).sort();
}

/** Blob hash of `file` in the working tree (or null when absent). */
export function gitWorkingTreeBlob(file, cwd = R4_REPO_ROOT) {
  const r = git(['hash-object', '--', file], cwd);
  return r.ok ? r.stdout.toString('utf8').trim() : null;
}

/** Blob hash of `file` at `commit` (or null when the path does not exist there). */
export function gitBlobAt(commit, file, cwd = R4_REPO_ROOT) {
  return gitText(['rev-parse', `${commit}:${file}`], cwd);
}

/** Bytes of `file` at `commit`, or null when the path does not exist there. */
export function gitShowFile(commit, file, cwd = R4_REPO_ROOT) {
  const r = git(['show', `${commit}:${file}`], cwd);
  return r.ok ? r.stdout : null;
}

/** Digest map for `files` at `commit`. A missing path maps to null. */
export function protocolFileDigests(commit, files, cwd = R4_REPO_ROOT) {
  const out = {};
  for (const file of files) {
    const bytes = gitShowFile(commit, file, cwd);
    out[file] = bytes === null ? null : sha256Hex(bytes);
  }
  return out;
}

/** Deterministic discovery of the seal authority commit S for protocol commit P. */
export function findSealAuthorityCommit({ protocolCommit, seal = null, sealPath = R4_TRACKED_SEAL_PATH, cwd = R4_REPO_ROOT } = {}) {
  if (!isSha(protocolCommit)) return { found: false, reason: 'PROTOCOL_COMMIT_INVALID' };
  const log = gitText(['log', '--format=%H', '--', sealPath], cwd);
  const candidates = log ? log.split('\n').filter(Boolean) : [];
  const matches = [];
  for (const candidate of candidates) {
    const parents = gitParents(candidate, cwd);
    if (parents[0] !== protocolCommit) continue;
    if (seal) {
      const bytes = gitShowFile(candidate, sealPath, cwd);
      if (bytes === null) continue;
      let parsed;
      try { parsed = JSON.parse(bytes.toString('utf8')); } catch { continue; }
      const expected = { ...seal };
      delete expected.fingerprint;
      const actual = { ...parsed };
      delete actual.fingerprint;
      if (canonical(expected) !== canonical(actual)) continue;
    }
    matches.push(candidate);
  }
  if (matches.length === 0) return { found: false, reason: 'SEAL_COMMIT_NOT_FOUND' };
  if (matches.length > 1) return { found: false, reason: 'SEAL_COMMIT_AMBIGUOUS', matches };
  return { found: true, sealAuthorityCommit: matches[0] };
}

export function remoteContains(commit, remote = R4_REMOTE_MAIN, cwd = R4_REPO_ROOT) {
  if (!isSha(commit)) return { available: false, contains: false };
  if (!git(['rev-parse', '--verify', `refs/remotes/${remote}`], cwd).ok) return { available: false, contains: false };
  const contains = git(['merge-base', '--is-ancestor', commit, remote], cwd).ok;
  return { available: true, contains };
}

/**
 * MANDATORY remote authority. There is no flag that disables this: a commit that
 * is not present on `origin/main` may never anchor a real R4 attempt.
 */
export function assertRemoteContains(commit, { remote = R4_REMOTE_MAIN, cwd = R4_REPO_ROOT, what = 'AUTHORITY_COMMIT' } = {}) {
  const result = remoteContains(commit, remote, cwd);
  if (!result.available) throw new Error('R4_AUTHORITY_REMOTE_UNAVAILABLE');
  if (!result.contains) throw new Error(`R4_AUTHORITY_REMOTE_MISSING:${what}`);
  return true;
}

/**
 * Live worktree integrity. The process executes the WORKING TREE, so committed
 * authority alone is not enough: HEAD must equal the required authority commit
 * and every canonical runtime dependency must be byte-identical to its authority
 * version. A tracked working-tree change to a runtime dependency fails.
 *
 * This is repository integrity enforcement. It does not claim to defeat
 * arbitrary malicious code replacement.
 */
export function assertWorktreeIntegrity({
  cwd = R4_REPO_ROOT, requiredCommit = null, files = R4_REQUIRED_BOUND_FILES, sealPath = R4_TRACKED_SEAL_PATH,
} = {}) {
  const head = gitHead(cwd);
  if (requiredCommit && head !== requiredCommit) throw new Error('R4_WORKTREE_HEAD_NOT_AUTHORITY_COMMIT');
  const target = requiredCommit ?? head;
  if (!isSha(target)) throw new Error('R4_WORKTREE_HEAD_INVALID');
  const changed = [];
  for (const file of files) {
    if (file === sealPath) continue; // the seal is verified by the authority contract itself
    const working = gitWorkingTreeBlob(file, cwd);
    const committed = gitBlobAt(target, file, cwd);
    if (committed === null) throw new Error(`R4_WORKTREE_BOUND_FILE_MISSING:${file}`);
    if (working === null || working !== committed) changed.push(file);
  }
  if (changed.length) throw new Error(`R4_WORKTREE_RUNTIME_MODIFIED:${changed.join(',')}`);
  return { ok: true, head, requiredCommit: target, verifiedFiles: files.length };
}

/**
 * S must differ from P only by the canonical seal artifact(s), and A must differ
 * from S only by the canonical approval artifact(s).
 */
export function assertSealCommitShape({ cwd = R4_REPO_ROOT, protocolCommit, sealAuthorityCommit, sealPath = R4_TRACKED_SEAL_PATH } = {}) {
  const changed = gitChangedFiles(protocolCommit, sealAuthorityCommit, cwd);
  if (canonical(changed) !== canonical([sealPath])) throw new Error('R4_AUTHORITY_SEAL_COMMIT_SHAPE_INVALID');
  return { ok: true, changed };
}

export function assertApprovalCommitShape({ cwd = R4_REPO_ROOT, sealAuthorityCommit, approvalCommit, approvalPath = R4_PRECAPTURE_APPROVAL_PATH } = {}) {
  const changed = gitChangedFiles(sealAuthorityCommit, approvalCommit, cwd);
  if (canonical(changed) !== canonical([approvalPath])) throw new Error('R4_AUTHORITY_APPROVAL_COMMIT_SHAPE_INVALID');
  return { ok: true, changed };
}

/**
 * Enforce the external canonical contract for a seal. Internal self-consistency
 * is NOT sufficient: the seal must be bound to a real Git protocol commit whose
 * tree, bound-file digests and seal authority commit all agree.
 *
 * `requireRemote` remains a parameter for the canonical seal validator, which
 * legitimately runs before the seal is pushed. Every path capable of real
 * execution calls `assertRemoteContains` unconditionally instead.
 */
export function verifyR4SealAuthority(seal, {
  cwd = R4_REPO_ROOT,
  requiredFiles = null,
  sealPath = R4_TRACKED_SEAL_PATH,
  requireSealCommit = true,
  requireHead = true,
  requireRemote = false,
} = {}) {
  if (!seal || typeof seal !== 'object') throw new Error('R4_AUTHORITY_SEAL_INVALID');
  const protocolCommit = seal.protocolCommit;
  if (!isSha(protocolCommit)) throw new Error('R4_AUTHORITY_PROTOCOL_COMMIT_INVALID');
  if (typeof seal.protocolTree !== 'string' || !/^[0-9a-f]{40}$/.test(seal.protocolTree)) throw new Error('R4_AUTHORITY_PROTOCOL_TREE_INVALID');
  if (!gitCommitExists(protocolCommit, cwd)) throw new Error('R4_AUTHORITY_PROTOCOL_COMMIT_MISSING');
  if (gitTree(protocolCommit, cwd) !== seal.protocolTree) throw new Error('R4_AUTHORITY_PROTOCOL_TREE_MISMATCH');

  const files = requiredFiles ?? Object.keys(seal.boundFiles ?? {});
  const digests = protocolFileDigests(protocolCommit, files, cwd);
  for (const file of files) {
    if (digests[file] === null) throw new Error(`R4_AUTHORITY_BOUND_FILE_MISSING:${file}`);
    const recorded = seal.boundFiles?.[file]?.sha256;
    if (recorded !== digests[file]) throw new Error(`R4_AUTHORITY_BOUND_FILE_MISMATCH:${file}`);
  }

  let sealAuthorityCommit = null;
  if (requireSealCommit) {
    const discovery = findSealAuthorityCommit({ protocolCommit, seal, sealPath, cwd });
    if (!discovery.found) throw new Error(`R4_AUTHORITY_${discovery.reason}`);
    sealAuthorityCommit = discovery.sealAuthorityCommit;
    if (requireHead) {
      const head = gitHead(cwd);
      if (head !== sealAuthorityCommit) throw new Error('R4_AUTHORITY_HEAD_NOT_SEAL_COMMIT');
    }
    if (requireRemote) {
      const remote = remoteContains(sealAuthorityCommit, R4_REMOTE_MAIN, cwd);
      if (!remote.available) throw new Error('R4_AUTHORITY_REMOTE_UNAVAILABLE');
      if (!remote.contains) throw new Error('R4_AUTHORITY_REMOTE_MISSING_SEAL_COMMIT');
    }
  }
  return {
    ok: true, protocolCommit, protocolTree: seal.protocolTree, sealAuthorityCommit,
    boundFileCount: files.length,
    sealCommitterTimestamp: sealAuthorityCommit ? gitCommitterTimestamp(sealAuthorityCommit, cwd) : null,
    sealCommitterIso: sealAuthorityCommit ? gitCommitterIso(sealAuthorityCommit, cwd) : null,
  };
}

/** T0 remains a purely mechanical function of an authority commit timestamp. */
export function authorityT0(authorityCommittedAtMs) {
  return mechanicalT0(authorityCommittedAtMs);
}

/** Read the canonical tracked seal from the working tree, or from Git at `ref`. */
export function readTrackedSeal({ cwd = R4_REPO_ROOT, ref = null, sealPath = R4_TRACKED_SEAL_PATH } = {}) {
  if (ref) {
    const bytes = gitShowFile(ref, sealPath, cwd);
    if (bytes === null) return null;
    return JSON.parse(bytes.toString('utf8'));
  }
  try { return JSON.parse(readFileSync(path.resolve(cwd, sealPath), 'utf8')); } catch { return null; }
}

/**
 * Load and fully verify the canonical tracked seal: internal consistency plus the
 * external Git two-commit authority contract. This is the single entrypoint the
 * sealed runner and the canonical validator use.
 */
export function loadCanonicalTrackedSeal({
  cwd = R4_REPO_ROOT, sealPath = R4_TRACKED_SEAL_PATH,
  requireSealCommit = true, requireHead = true, requireRemote = false, load = undefined,
} = {}) {
  const seal = readTrackedSeal({ cwd, sealPath });
  if (!seal) throw new Error('R4_AUTHORITY_SEAL_MISSING');
  verifyR4Seal(seal, load ? { load } : {});
  const authority = verifyR4SealAuthority(seal, { cwd, sealPath, requiredFiles: Object.keys(seal.boundFiles ?? {}),
    requireSealCommit, requireHead, requireRemote });
  return { seal, authority };
}

/**
 * True when the tracked seal on disk no longer matches the canonical
 * specification/bound set of THIS revision (i.e. it is superseded and awaiting
 * re-issue as a new S). Used only to let the canonical validator report a
 * pre-reissue dry run instead of a false failure; real execution never tolerates
 * a superseded seal.
 */
export function isCanonicalSealSuperseded({ cwd = R4_REPO_ROOT, sealPath = R4_TRACKED_SEAL_PATH } = {}) {
  const seal = readTrackedSeal({ cwd, sealPath });
  if (!seal) return false;
  try { verifyR4Seal(seal); return false; } catch { return true; }
}
