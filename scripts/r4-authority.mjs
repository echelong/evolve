// R4 two-commit authority chain (enforcement only).
//
// The canonical R4 authority is a TRACKED seal, not a Git-ignored runtime file:
//
//   PROTOCOL COMMIT P   contains all code, the full preregistration, the
//                       enforcement modules and validators. It does NOT contain
//                       the final generated seal.
//   SEAL COMMIT S       adds ONLY the canonical tracked seal (plus a
//                       deterministic pointer). S has P as its direct parent.
//                       The seal content binds P, not S.
//
// Runtime authority is therefore:
//   protocol commit   = P
//   seal authority    = S
//
// T0 uses the COMMITTER TIMESTAMP of S. The seal never contains S's own SHA.
//
// This module reads Git only. It starts nothing, captures nothing and holds no
// trading authority.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical } from './market-intelligence/definition.mjs';
import { mechanicalT0 } from './r4-cohort-plan.mjs';
import { R4_TRACKED_SEAL_PATH, R4_AUTHORITY_POINTER_PATH } from './r4-protocol-spec.mjs';
import { verifyR4Seal } from './r4-preregistration-seal.mjs';

export const R4_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export { R4_TRACKED_SEAL_PATH, R4_AUTHORITY_POINTER_PATH };
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

export function gitCommitterTimestamp(sha, cwd = R4_REPO_ROOT) {
  const value = gitText(['show', '-s', '--format=%ct', sha], cwd);
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
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
  if (!git(['rev-parse', '--verify', `refs/remotes/${remote}`], cwd).ok) return { available: false, contains: null };
  const contains = git(['merge-base', '--is-ancestor', commit, remote], cwd).ok;
  return { available: true, contains };
}

/**
 * Enforce the external canonical contract for a seal. Internal self-consistency
 * is NOT sufficient: the seal must be bound to a real Git protocol commit whose
 * tree, bound-file digests and (when required) seal authority commit all agree.
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

/** Read the canonical tracked seal from the working tree, or from Git at `ref`. */
/** T0 is the mechanical first whole UTC hour at least 30 minutes after S. */
export function authorityT0(sealCommitterTimestamp) {
  return mechanicalT0(sealCommitterTimestamp);
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
