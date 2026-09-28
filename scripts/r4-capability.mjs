// R4 pre-attempt runner capability (enforcement only).
//
// Independent pre-capture review round 2 (blocker B1) showed that the previous
// trust boundary was spoofable: `R4_SEALED_RUNNER=yes` reached capture directly
// and the attestation interface could mint a verification-passing attestation
// from public authority values without ever executing through the sealed runner.
//
// This module replaces that authorization credential with a real capability:
//
//   1. The verified canonical runner performs every authority/preflight check.
//   2. Immediately before a real attempt it draws a cryptographically random
//      256-bit capability with `crypto.randomBytes`.
//   3. It persists a pre-attempt authorization record that contains ONLY
//      `SHA-256(capability)` — never the raw capability.
//   4. It hands the RAW capability to the capture child over a dedicated
//      inherited file descriptor (fd 3). The raw capability never appears in
//      the environment, in argv, in the repository or in a persisted record,
//      and it is never logged.
//   5. Capture verifies `SHA-256(raw capability) === persisted capability hash`
//      before it opens an R4 session.
//
// Threat model (disclosed, not weakened): this prevents ordinary CLI/API/config
// bypass and accidental or manual masquerading inside the repository's execution
// model. It is NOT claimed to defend against a malicious local user who can
// rewrite code, attach a debugger, or read another process's memory. There is no
// private-key signing infrastructure in this repository.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, readSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, digest } from './market-intelligence/definition.mjs';

export const R4_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const R4_ATTEMPT_AUTH_DIR = '.evolve/governance/r4-attempts';
export const R4_ATTEMPT_AUTH_RECORD_TYPE = 'r4_attempt_authorization';
export const R4_SESSION_RECEIPT_RECORD_TYPE = 'r4_session_capability_receipt';
/** Fixed inherited descriptor. The capability is a credential, not an env var. */
export const R4_CAPABILITY_FD = 3;
export const R4_CAPABILITY_BYTES = 32;
export const R4_SESSION_ROLE = 'cohort';

const fail = code => { throw new Error(code); };
const isSha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);

/** Draw a fresh 256-bit attempt capability. Never persisted in raw form. */
export function createAttemptCapability() {
  return randomBytes(R4_CAPABILITY_BYTES);
}

/** SHA-256 of the raw capability bytes. This is the only form ever persisted. */
export function capabilityHash(capability) {
  if (!Buffer.isBuffer(capability) && !(capability instanceof Uint8Array)) fail('R4_CAPABILITY_INVALID');
  if (capability.length !== R4_CAPABILITY_BYTES) fail('R4_CAPABILITY_LENGTH_INVALID');
  return createHash('sha256').update(Buffer.from(capability)).digest('hex');
}

const authorizationPath = (root, attemptIndex) => path.join(root, `attempt-${attemptIndex}.json`);

/** Build the pre-attempt authorization record. Content blinds the raw capability. */
export function createAttemptAuthorization({ seal, authority, approvalCommit = null, attemptIndex, sessionId, t0, capabilityHash: hash, captureSpecDigest }) {
  if (!seal || typeof seal.fingerprint !== 'string') fail('R4_CAPABILITY_SEAL_INVALID');
  if (!authority || !isSha(authority.protocolCommit) || !isSha(authority.sealAuthorityCommit)) fail('R4_CAPABILITY_AUTHORITY_INVALID');
  if (!Number.isInteger(attemptIndex) || attemptIndex < 1) fail('R4_CAPABILITY_ATTEMPT_INDEX_INVALID');
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(sessionId)) fail('R4_CAPABILITY_SESSION_ID_INVALID');
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) fail('R4_CAPABILITY_HASH_INVALID');
  if (!Number.isSafeInteger(t0) || t0 < 0) fail('R4_CAPABILITY_T0_INVALID');
  if (typeof captureSpecDigest !== 'string' || !/^[0-9a-f]{64}$/.test(captureSpecDigest)) fail('R4_CAPABILITY_CAPTURE_SPEC_INVALID');
  if (approvalCommit !== null && !isSha(approvalCommit)) fail('R4_CAPABILITY_APPROVAL_INVALID');
  const content = {
    schemaVersion: 1, recordType: R4_ATTEMPT_AUTH_RECORD_TYPE, role: R4_SESSION_ROLE,
    capabilityHash: hash, sealFingerprint: seal.fingerprint,
    protocolCommit: authority.protocolCommit, protocolTree: authority.protocolTree ?? seal.protocolTree,
    sealAuthorityCommit: authority.sealAuthorityCommit,
    approvalCommit, attemptIndex, sessionId, t0, t0Iso: new Date(t0).toISOString(), captureSpecDigest,
  };
  return { ...content, fingerprint: digest(content) };
}

/** Persist the authorization record. Only the runner lifecycle calls this. */
export function writeAttemptAuthorization(record, { root = R4_ATTEMPT_AUTH_DIR, cwd = R4_REPO_ROOT } = {}) {
  assertAttemptAuthorization(record);
  const dir = path.resolve(cwd, root);
  mkdirSync(dir, { recursive: true });
  const file = authorizationPath(dir, record.attemptIndex);
  writeFileSync(file, canonical(record) + '\n', { flag: 'wx', mode: 0o600 });
  return { file, fingerprint: record.fingerprint };
}

export function assertAttemptAuthorization(record) {
  if (!record || record.recordType !== R4_ATTEMPT_AUTH_RECORD_TYPE || record.schemaVersion !== 1) fail('R4_CAPABILITY_AUTH_RECORD_INVALID');
  const { fingerprint, ...content } = record;
  if (digest(content) !== fingerprint) fail('R4_CAPABILITY_AUTH_FINGERPRINT_MISMATCH');
  if (typeof record.capabilityHash !== 'string' || !/^[0-9a-f]{64}$/.test(record.capabilityHash)) fail('R4_CAPABILITY_HASH_INVALID');
  if (record.role !== R4_SESSION_ROLE) fail('R4_CAPABILITY_ROLE_INVALID');
  if (!isSha(record.protocolCommit) || !isSha(record.sealAuthorityCommit)) fail('R4_CAPABILITY_AUTHORITY_INVALID');
  if (record.approvalCommit !== null && !isSha(record.approvalCommit)) fail('R4_CAPABILITY_APPROVAL_INVALID');
  return true;
}

export function readAttemptAuthorization({ attemptIndex, root = R4_ATTEMPT_AUTH_DIR, cwd = R4_REPO_ROOT } = {}) {
  try { return JSON.parse(readFileSync(authorizationPath(path.resolve(cwd, root), attemptIndex), 'utf8')); } catch { return null; }
}

export function listAttemptAuthorizations({ root = R4_ATTEMPT_AUTH_DIR, cwd = R4_REPO_ROOT } = {}) {
  const dir = path.resolve(cwd, root);
  try {
    return readdirSync(dir).filter(name => /^attempt-\d+\.json$/.test(name)).sort()
      .map(name => { try { return JSON.parse(readFileSync(path.join(dir, name), 'utf8')); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/** Build a proof object from a raw capability plus the persisted record. */
export function proveCapability({ capability, record }) {
  assertAttemptAuthorization(record);
  const hash = capabilityHash(capability);
  const expected = Buffer.from(record.capabilityHash, 'hex');
  const actual = Buffer.from(hash, 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) fail('R4_CAPABILITY_MISMATCH');
  return Object.freeze({ capability: Buffer.from(capability), capabilityHash: hash,
    authorizationFingerprint: record.fingerprint, sessionId: record.sessionId, attemptIndex: record.attemptIndex,
    t0: record.t0, approvalCommit: record.approvalCommit, sealFingerprint: record.sealFingerprint,
    protocolCommit: record.protocolCommit, sealAuthorityCommit: record.sealAuthorityCommit,
    captureSpecDigest: record.captureSpecDigest });
}

export function assertAttemptProof(proof, { attemptIndex = null, sessionId = null } = {}) {
  if (!proof || typeof proof !== 'object') fail('R4_CAPABILITY_PROOF_REQUIRED');
  if (typeof proof.capabilityHash !== 'string' || !/^[0-9a-f]{64}$/.test(proof.capabilityHash)) fail('R4_CAPABILITY_PROOF_INVALID');
  if (typeof proof.authorizationFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(proof.authorizationFingerprint)) fail('R4_CAPABILITY_PROOF_INVALID');
  if (!Buffer.isBuffer(proof.capability) || capabilityHash(proof.capability) !== proof.capabilityHash) fail('R4_CAPABILITY_PROOF_INVALID');
  if (attemptIndex !== null && proof.attemptIndex !== attemptIndex) fail('R4_CAPABILITY_ATTEMPT_MISMATCH');
  if (sessionId !== null && proof.sessionId !== sessionId) fail('R4_CAPABILITY_SESSION_MISMATCH');
  return true;
}

/**
 * Child side: find the persisted authorization whose blinded hash matches the
 * raw capability read from the inherited descriptor. Exactly one must match.
 */
export function resolveCapabilityRecord({ capability, root = R4_ATTEMPT_AUTH_DIR, cwd = R4_REPO_ROOT } = {}) {
  const hash = capabilityHash(capability);
  const matches = listAttemptAuthorizations({ root, cwd }).filter(record => record.capabilityHash === hash);
  if (matches.length === 0) fail('R4_CAPABILITY_NOT_AUTHORIZED');
  if (matches.length > 1) fail('R4_CAPABILITY_AMBIGUOUS');
  return matches[0];
}

/** Read the whole inherited descriptor. Missing/empty means "no capability". */
export function readCapabilityFromDescriptor(fd = R4_CAPABILITY_FD) {
  try {
    const chunks = [];
    const buffer = Buffer.alloc(4096);
    for (let read; (read = readSync(fd, buffer, 0, buffer.length, null)) > 0;) chunks.push(Buffer.from(buffer.subarray(0, read)));
    const bytes = Buffer.concat(chunks);
    return bytes.length ? bytes : null;
  } catch { return null; }
}

/**
 * Capture side: acquire the sealed-runner capability context. Returns `null`
 * when no capability is present (a direct/unsealed invocation), so the caller
 * can refuse. Throws when a capability exists but is not authorized.
 */
export function acquireRunnerCapability({ fd = R4_CAPABILITY_FD, root = R4_ATTEMPT_AUTH_DIR, cwd = R4_REPO_ROOT } = {}) {
  const capability = readCapabilityFromDescriptor(fd);
  if (!capability) return null;
  const record = resolveCapabilityRecord({ capability, root, cwd });
  return proveCapability({ capability, record });
}

/** Receipt written by capture after finalization so the runner can finalize. */
export function createSessionReceipt({ authorizationFingerprint, capabilityHash: hash, sessionId, sessionFingerprint, revisitCoverage = null }) {
  if (typeof sessionFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(sessionFingerprint)) fail('R4_RECEIPT_SESSION_FINGERPRINT_INVALID');
  const content = { schemaVersion: 1, recordType: R4_SESSION_RECEIPT_RECORD_TYPE, authorizationFingerprint, capabilityHash: hash,
    sessionId, sessionFingerprint, revisitCoverage };
  return { ...content, fingerprint: digest(content) };
}

export function writeSessionReceipt(receipt, { root = R4_ATTEMPT_AUTH_DIR, cwd = R4_REPO_ROOT } = {}) {
  const dir = path.resolve(cwd, root);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `receipt-${receipt.sessionId}.json`);
  writeFileSync(file, canonical(receipt) + '\n', { flag: 'wx', mode: 0o600 });
  return { file, fingerprint: receipt.fingerprint };
}

export function readSessionReceipt(sessionId, { root = R4_ATTEMPT_AUTH_DIR, cwd = R4_REPO_ROOT } = {}) {
  try { return JSON.parse(readFileSync(path.join(path.resolve(cwd, root), `receipt-${sessionId}.json`), 'utf8')); } catch { return null; }
}

export function assertSessionReceipt(receipt, { proof, record }) {
  if (!receipt || receipt.recordType !== R4_SESSION_RECEIPT_RECORD_TYPE || receipt.schemaVersion !== 1) fail('R4_RECEIPT_INVALID');
  const { fingerprint, ...content } = receipt;
  if (digest(content) !== fingerprint) fail('R4_RECEIPT_FINGERPRINT_MISMATCH');
  if (receipt.capabilityHash !== record.capabilityHash) fail('R4_RECEIPT_CAPABILITY_MISMATCH');
  if (receipt.authorizationFingerprint !== record.fingerprint) fail('R4_RECEIPT_AUTHORIZATION_MISMATCH');
  if (receipt.sessionId !== record.sessionId) fail('R4_RECEIPT_SESSION_MISMATCH');
  if (receipt.sessionId !== proof.sessionId) fail('R4_RECEIPT_SESSION_MISMATCH');
  return true;
}
