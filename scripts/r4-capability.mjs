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
//   3. It persists an IMMUTABLE pre-attempt authorization record that contains
//      ONLY `SHA-256(capability)` — never the raw capability.
//   4. It hands the RAW capability to the capture child over a dedicated
//      inherited file descriptor (fd 3). The raw capability never appears in
//      the environment, in argv, in the repository or in a persisted record,
//      and it is never logged.
//   5. Capture verifies `SHA-256(raw capability) === persisted capability hash`
//      and then ATOMICALLY CLAIMS the authorization before it opens anything.
//
// Round 3 (P1-1, capability replay / double-spend): a capability is SINGLE-USE.
// The canonical attempt state machine is
//
//   AUTHORIZED --claim--> CLAIMED --terminal--> COMPLETED
//                                  \-terminal--> FAILED
//
// with no CLAIMED -> AUTHORIZED transition and no reuse of a CLAIMED capability.
// The consumption boundary is `attempt-N.claim.json`, created with
// `open(O_CREAT | O_EXCL | O_WRONLY)` (Node flag 'wx') and fsync'd together with
// its directory BEFORE capture creates a session directory, a recorder, storage,
// provider objects or any network access. Exactly one process can create it; a
// second process with the same capability fails with
// `R4_CAPABILITY_ALREADY_CLAIMED`. Once claimed, an attempt is permanently
// consumed: a crash after the claim leaves it consumed and (without a valid
// terminal completion) mechanically FAILED. Terminal records live in
// `scripts/r4-attempt-history.mjs`.
//
// Threat model (disclosed, not weakened): this prevents ordinary CLI/API/config
// bypass, replay and accidental or manual masquerading inside the repository's
// execution model. It is NOT claimed to defend against a malicious local user who
// can rewrite code or governance files, attach a debugger, or read another
// process's memory. There is no private-key signing infrastructure in this
// repository.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, digest } from './market-intelligence/definition.mjs';
import { R4_COHORT_SPEC } from './r4-cohort-plan.mjs';

export const R4_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const R4_ATTEMPT_AUTH_DIR = '.evolve/governance/r4-attempts';
export const R4_ATTESTATION_DIR = '.evolve/governance/r4-attestations';
export const R4_CAPTURE_SESSION_ROOT = '.evolve/market-intelligence/sessions';
export const R4_ATTEMPT_AUTH_RECORD_TYPE = 'r4_attempt_authorization';
export const R4_ATTEMPT_CLAIM_RECORD_TYPE = 'r4_attempt_claim';
export const R4_SESSION_RECEIPT_RECORD_TYPE = 'r4_session_capability_receipt';
// SCHEMA VERSIONING for the post-start continuation. A pre-C1 record is
// schemaVersion 1 and legitimately carries NO continuation fields; a post-C1
// record is schemaVersion 2 and MUST carry the exact continuation identity.
// Explicit versions (rather than optional fields) mean a post-C1 record can
// never be mistaken for a pre-C1 one, so evidence cannot be mixed across
// continuation states.
export const R4_ATTEMPT_AUTH_SCHEMA_VERSION_POST_CONTINUATION = 2;
export const R4_ATTEMPT_CLAIM_SCHEMA_VERSION_POST_CONTINUATION = 2;
export const R4_SESSION_RECEIPT_SCHEMA_VERSION_POST_CONTINUATION = 2;
/** Fixed inherited descriptor. The capability is a credential, not an env var. */
export const R4_CAPABILITY_FD = 3;
export const R4_CAPABILITY_BYTES = 32;
export const R4_SESSION_ROLE = 'cohort';
/**
 * Who consumed an authorization. Only a CAPTURE_CHILD claim (which proves the
 * raw capability) can ever lead to COMPLETED. The runner and the explicit
 * recovery mode may consume an authorization that no child claimed, but such a
 * claim is always terminally FAILED.
 */
export const R4_CLAIMANTS = Object.freeze({
  child: 'CAPTURE_CHILD',
  runnerAbandon: 'RUNNER_UNCLAIMED_ABANDON',
  recovery: 'RECOVERY_UNCLAIMED',
});
const CLAIMANT_SET = new Set(Object.values(R4_CLAIMANTS));

const fail = code => { throw new Error(code); };
const isSha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const isDigest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const isStamp = value => Number.isSafeInteger(value) && value >= 0;

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

/** Deterministic capability-bound session id: unpredictable and manifest-authenticated. */
export function deriveSessionId({ sealFingerprint, approvalCommit, attemptIndex, capabilityHash: hash }) {
  return digest({ purpose: 'R4_ATTEMPT_SESSION', sealFingerprint, approvalCommit, attemptIndex, capabilityHash: hash }).slice(0, 32);
}

/* ------------------------------------------------------------ paths */

export const attemptAuthorizationFile = attemptIndex => `attempt-${attemptIndex}.json`;
export const attemptClaimFile = attemptIndex => `attempt-${attemptIndex}.claim.json`;
export const attemptTerminalFile = attemptIndex => `attempt-${attemptIndex}.terminal.json`;
export const sessionReceiptFile = sessionId => `receipt-${sessionId}.json`;
const attemptDir = ({ root = R4_ATTEMPT_AUTH_DIR, cwd = R4_REPO_ROOT } = {}) => path.resolve(cwd, root);

/* ------------------------------------------------ durable exclusive write */

/** fsync a directory so a just-created entry survives a crash. */
export function fsyncDirectory(dir) {
  const fd = openSync(dir, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * Create `file` atomically and exclusively (`open(O_CREAT | O_EXCL | O_WRONLY)`),
 * write the whole body, fsync the file, then fsync the containing directory.
 * Throws the native EEXIST error when the file already exists. Records are
 * created read-only (0400): governance records are immutable after creation.
 */
export function writeDurableExclusive(file, body, { mode = 0o400 } = {}) {
  const fd = openSync(file, 'wx', mode);
  try {
    const bytes = Buffer.from(body, 'utf8');
    for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  fsyncDirectory(path.dirname(file));
  return file;
}

/* ------------------------------------------------ authorization (AUTHORIZED) */

/** Build the pre-attempt authorization record. Content blinds the raw capability. */
export function createAttemptAuthorization({
  seal, authority, approvalCommit = null, approvalEpoch = null, approvalFingerprint = null,
  attemptIndex, sessionId, t0, capabilityHash: hash, captureSpecDigest,
  authorizedAt = Date.now(), previousTerminalFingerprint = null,
  continuation = null,
}) {
  if (!seal || typeof seal.fingerprint !== 'string') fail('R4_CAPABILITY_SEAL_INVALID');
  if (!authority || !isSha(authority.protocolCommit) || !isSha(authority.sealAuthorityCommit)) fail('R4_CAPABILITY_AUTHORITY_INVALID');
  if (!Number.isInteger(attemptIndex) || attemptIndex < 1) fail('R4_CAPABILITY_ATTEMPT_INDEX_INVALID');
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(sessionId)) fail('R4_CAPABILITY_SESSION_ID_INVALID');
  if (!isDigest(hash)) fail('R4_CAPABILITY_HASH_INVALID');
  if (!isStamp(t0)) fail('R4_CAPABILITY_T0_INVALID');
  if (!isDigest(captureSpecDigest)) fail('R4_CAPABILITY_CAPTURE_SPEC_INVALID');
  if (approvalCommit !== null && !isSha(approvalCommit)) fail('R4_CAPABILITY_APPROVAL_INVALID');
  // Approval EPOCH (missed-window renewal governance): 1 is the historical
  // legacy approval; null means "not bound by this record".
  if (approvalEpoch !== null && (!Number.isInteger(approvalEpoch) || approvalEpoch < 1)) fail('R4_CAPABILITY_APPROVAL_EPOCH_INVALID');
  // Approval FINGERPRINT: the self-contained content digest of the approval
  // artifact located through the resolved Git authority. It is always taken from
  // the independently resolved authority (`resolveR4ExecutionAuthority`); it is
  // never a free-standing caller claim, and it binds `approvalCommit` +
  // `approvalEpoch` so neither can be swapped for another approval.
  if (approvalFingerprint !== null && !isDigest(approvalFingerprint)) fail('R4_CAPABILITY_APPROVAL_FINGERPRINT_INVALID');
  if (!isStamp(authorizedAt)) fail('R4_CAPABILITY_AUTHORIZED_AT_INVALID');
  if (previousTerminalFingerprint !== null && !isDigest(previousTerminalFingerprint)) fail('R4_CAPABILITY_PREVIOUS_TERMINAL_INVALID');
  const content = {
    schemaVersion: continuation === null ? 1 : R4_ATTEMPT_AUTH_SCHEMA_VERSION_POST_CONTINUATION,
    recordType: R4_ATTEMPT_AUTH_RECORD_TYPE, role: R4_SESSION_ROLE, state: 'AUTHORIZED',
    capabilityHash: hash, sealFingerprint: seal.fingerprint,
    protocolCommit: authority.protocolCommit, protocolTree: authority.protocolTree ?? seal.protocolTree,
    sealAuthorityCommit: authority.sealAuthorityCommit,
    approvalCommit, approvalEpoch, approvalFingerprint,
    attemptIndex, sessionId, t0, t0Iso: new Date(t0).toISOString(), captureSpecDigest,
    authorizedAt, previousTerminalFingerprint,
    // POST-START CONTINUATION binding. Absent (schemaVersion 1) for a pre-C1
    // authorization; present and exact for a post-C1 one. The scientific A2
    // approval identity and the original T0 above are UNCHANGED either way.
    ...(continuation === null ? {} : {
      continuation: continuation.generation,
      continuationFingerprint: continuation.fingerprint,
      continuationCommit: continuation.commit,
    }),
  };
  return { ...content, fingerprint: digest(content) };
}

/** Persist the IMMUTABLE authorization record. Only the runner lifecycle calls this. */
export function writeAttemptAuthorization(record, { root = R4_ATTEMPT_AUTH_DIR, cwd = R4_REPO_ROOT } = {}) {
  assertAttemptAuthorization(record);
  const dir = attemptDir({ root, cwd });
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, attemptAuthorizationFile(record.attemptIndex));
  try { writeDurableExclusive(file, canonical(record) + '\n'); }
  catch (error) { if (error?.code === 'EEXIST') fail('R4_ATTEMPT_AUTHORIZATION_EXISTS'); throw error; }
  return { file, fingerprint: record.fingerprint };
}

export function assertAttemptAuthorization(record) {
  if (!record || record.recordType !== R4_ATTEMPT_AUTH_RECORD_TYPE) fail('R4_CAPABILITY_AUTH_RECORD_INVALID');
  // schemaVersion 1 = pre-C1 (no continuation fields); 2 = post-C1 (must carry
  // them). Both are structurally valid; the history verifier decides which one is
  // correct for a given attempt's position relative to the continuation boundary.
  if (record.schemaVersion !== 1 && record.schemaVersion !== R4_ATTEMPT_AUTH_SCHEMA_VERSION_POST_CONTINUATION) fail('R4_CAPABILITY_AUTH_RECORD_INVALID');
  const { fingerprint, ...content } = record;
  if (digest(content) !== fingerprint) fail('R4_CAPABILITY_AUTH_FINGERPRINT_MISMATCH');
  if (record.state !== 'AUTHORIZED') fail('R4_CAPABILITY_AUTH_RECORD_INVALID');
  if (!isDigest(record.capabilityHash)) fail('R4_CAPABILITY_HASH_INVALID');
  if (record.role !== R4_SESSION_ROLE) fail('R4_CAPABILITY_ROLE_INVALID');
  if (!isSha(record.protocolCommit) || !isSha(record.sealAuthorityCommit)) fail('R4_CAPABILITY_AUTHORITY_INVALID');
  if (record.approvalCommit !== null && !isSha(record.approvalCommit)) fail('R4_CAPABILITY_APPROVAL_INVALID');
  if ((record.approvalEpoch ?? null) !== null && (!Number.isInteger(record.approvalEpoch) || record.approvalEpoch < 1)) fail('R4_CAPABILITY_APPROVAL_EPOCH_INVALID');
  if ((record.approvalFingerprint ?? null) !== null && !isDigest(record.approvalFingerprint)) fail('R4_CAPABILITY_APPROVAL_FINGERPRINT_INVALID');
  if (!Number.isInteger(record.attemptIndex) || record.attemptIndex < 1) fail('R4_CAPABILITY_ATTEMPT_INDEX_INVALID');
  if (typeof record.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(record.sessionId)) fail('R4_CAPABILITY_SESSION_ID_INVALID');
  if (!isStamp(record.t0) || !isStamp(record.authorizedAt)) fail('R4_CAPABILITY_AUTH_RECORD_INVALID');
  if (record.previousTerminalFingerprint !== null && !isDigest(record.previousTerminalFingerprint)) fail('R4_CAPABILITY_PREVIOUS_TERMINAL_INVALID');
  // Schema 1 must carry NO continuation fields; schema 2 must carry all three.
  const hasContinuationFields = record.continuationFingerprint !== undefined;
  if (record.schemaVersion === 1 && hasContinuationFields) fail('R4_CAPABILITY_CONTINUATION_FIELDS_UNEXPECTED');
  if (record.schemaVersion === R4_ATTEMPT_AUTH_SCHEMA_VERSION_POST_CONTINUATION) {
    if (!hasContinuationFields || !isDigest(record.continuationFingerprint) || !isSha(record.continuationCommit)
      || !Number.isInteger(record.continuation) || record.continuation < 1) fail('R4_CAPABILITY_CONTINUATION_FIELDS_MISSING');
  }
  return true;
}

export function readAttemptAuthorization({ attemptIndex, root = R4_ATTEMPT_AUTH_DIR, cwd = R4_REPO_ROOT } = {}) {
  try { return JSON.parse(readFileSync(path.join(attemptDir({ root, cwd }), attemptAuthorizationFile(attemptIndex)), 'utf8')); } catch { return null; }
}

export function listAttemptAuthorizations({ root = R4_ATTEMPT_AUTH_DIR, cwd = R4_REPO_ROOT } = {}) {
  const dir = attemptDir({ root, cwd });
  try {
    return readdirSync(dir).filter(name => /^attempt-\d+\.json$/.test(name)).sort()
      .map(name => { try { return JSON.parse(readFileSync(path.join(dir, name), 'utf8')); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/* ---------------------------------------------------------- claim (CLAIMED) */

export function assertAttemptClaim(claim) {
  if (!claim || claim.recordType !== R4_ATTEMPT_CLAIM_RECORD_TYPE) fail('R4_CLAIM_RECORD_INVALID');
  if (claim.schemaVersion !== 1 && claim.schemaVersion !== R4_ATTEMPT_CLAIM_SCHEMA_VERSION_POST_CONTINUATION) fail('R4_CLAIM_RECORD_INVALID');
  const { fingerprint, ...content } = claim;
  if (digest(content) !== fingerprint) fail('R4_CLAIM_FINGERPRINT_MISMATCH');
  if (claim.state !== 'CLAIMED') fail('R4_CLAIM_RECORD_INVALID');
  if (!CLAIMANT_SET.has(claim.claimant)) fail('R4_CLAIM_CLAIMANT_INVALID');
  if (!isDigest(claim.authorizationFingerprint) || !isDigest(claim.capabilityHash) || !isDigest(claim.captureSpecDigest)) fail('R4_CLAIM_RECORD_INVALID');
  if (!Number.isInteger(claim.attemptIndex) || claim.attemptIndex < 1) fail('R4_CLAIM_RECORD_INVALID');
  if (!isStamp(claim.claimedAt) || !isStamp(claim.t0)) fail('R4_CLAIM_RECORD_INVALID');
  if ((claim.approvalEpoch ?? null) !== null && (!Number.isInteger(claim.approvalEpoch) || claim.approvalEpoch < 1)) fail('R4_CAPABILITY_APPROVAL_EPOCH_INVALID');
  if ((claim.approvalFingerprint ?? null) !== null && !isDigest(claim.approvalFingerprint)) fail('R4_CAPABILITY_APPROVAL_FINGERPRINT_INVALID');
  if (claim.schemaVersion === 1 && claim.continuationFingerprint !== undefined) fail('R4_CAPABILITY_CONTINUATION_FIELDS_UNEXPECTED');
  if (claim.schemaVersion === R4_ATTEMPT_CLAIM_SCHEMA_VERSION_POST_CONTINUATION
    && (!isDigest(claim.continuationFingerprint) || !isSha(claim.continuationCommit)
      || !Number.isInteger(claim.continuation) || claim.continuation < 1)) fail('R4_CAPABILITY_CONTINUATION_FIELDS_MISSING');
  return true;
}

/** The claim must bind exactly the authorization it consumed. */
export function assertClaimBindsAuthorization(claim, record) {
  assertAttemptClaim(claim);
  assertAttemptAuthorization(record);
  const fields = ['capabilityHash', 'attemptIndex', 'sessionId', 'sealFingerprint', 'protocolCommit', 'sealAuthorityCommit', 'approvalCommit', 'approvalEpoch', 'approvalFingerprint', 'captureSpecDigest', 't0',
    'continuationFingerprint', 'continuation', 'continuationCommit'];
  if (claim.authorizationFingerprint !== record.fingerprint) fail('R4_CLAIM_AUTHORIZATION_MISMATCH');
  for (const field of fields) if (claim[field] !== record[field]) fail('R4_CLAIM_IDENTITY_MISMATCH');
  return true;
}

export function readAttemptClaim({ attemptIndex, root = R4_ATTEMPT_AUTH_DIR, cwd = R4_REPO_ROOT } = {}) {
  try { return JSON.parse(readFileSync(path.join(attemptDir({ root, cwd }), attemptClaimFile(attemptIndex)), 'utf8')); } catch { return null; }
}

/**
 * ATOMIC single consumption of an authorization (AUTHORIZED -> CLAIMED).
 *
 * The first valid process creates `attempt-N.claim.json` with O_CREAT|O_EXCL and
 * fsyncs it and its directory; every later process — sequential or concurrent —
 * fails with `R4_CAPABILITY_ALREADY_CLAIMED`. A capture child must call this
 * BEFORE it creates a session directory, recorder or storage and before any
 * provider/network access, and must stop on any throw.
 *
 * Defence in depth against a deleted claim: the claim is also refused when any
 * downstream consumption evidence for the attempt already exists (terminal
 * record, session directory, capability receipt or attestation). Deleting a
 * claim and retrying the same attempt is not a supported transition.
 *
 * Attempt 1's effective start is the claim: a capture-child claim of attempt 1
 * must itself fall inside [T0, T0 + 5 min). Attempts 2..8 carry no additional
 * clock rule (none is frozen); their order is enforced at authorization.
 */
export function claimAttemptAuthorization({
  record, capability = null, claimant = R4_CLAIMANTS.child, now = Date.now(),
  root = R4_ATTEMPT_AUTH_DIR, cwd = R4_REPO_ROOT,
  sessionRoot = R4_CAPTURE_SESSION_ROOT, attestationRoot = R4_ATTESTATION_DIR,
} = {}) {
  assertAttemptAuthorization(record);
  if (!CLAIMANT_SET.has(claimant)) fail('R4_CLAIM_CLAIMANT_INVALID');
  if (!isStamp(now)) fail('R4_CLAIM_TIME_INVALID');
  const dir = attemptDir({ root, cwd });
  const persisted = readAttemptAuthorization({ attemptIndex: record.attemptIndex, root, cwd });
  if (!persisted || persisted.fingerprint !== record.fingerprint || canonical(persisted) !== canonical(record)) fail('R4_CLAIM_AUTHORIZATION_NOT_PERSISTED');
  if (claimant === R4_CLAIMANTS.child) {
    const expected = Buffer.from(record.capabilityHash, 'hex');
    const actual = Buffer.from(capabilityHash(capability), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) fail('R4_CAPABILITY_MISMATCH');
  }
  const claimFile = path.join(dir, attemptClaimFile(record.attemptIndex));
  if (existsSync(claimFile)) fail('R4_CAPABILITY_ALREADY_CLAIMED');
  if (existsSync(path.join(dir, attemptTerminalFile(record.attemptIndex)))) fail('R4_CAPABILITY_ALREADY_CLAIMED');
  if (existsSync(path.join(dir, sessionReceiptFile(record.sessionId)))
    || existsSync(path.resolve(cwd, sessionRoot, record.sessionId))
    || existsSync(path.resolve(cwd, attestationRoot, `${record.sessionId}.json`))) fail('R4_CAPABILITY_SESSION_EVIDENCE_EXISTS');
  if (claimant === R4_CLAIMANTS.child && record.attemptIndex === 1) {
    if (now < record.t0) fail('R4_CLAIM_BEFORE_T0');
    if (now >= record.t0 + R4_COHORT_SPEC.attempt1StartWindowMs) fail('R4_CLAIM_ATTEMPT1_START_WINDOW_MISSED');
  }
  const content = {
    schemaVersion: record.continuationFingerprint === undefined ? 1 : R4_ATTEMPT_CLAIM_SCHEMA_VERSION_POST_CONTINUATION,
    recordType: R4_ATTEMPT_CLAIM_RECORD_TYPE, state: 'CLAIMED', claimant,
    authorizationFingerprint: record.fingerprint, capabilityHash: record.capabilityHash,
    attemptIndex: record.attemptIndex, sessionId: record.sessionId, sealFingerprint: record.sealFingerprint,
    protocolCommit: record.protocolCommit, sealAuthorityCommit: record.sealAuthorityCommit,
    approvalCommit: record.approvalCommit, approvalEpoch: record.approvalEpoch ?? null,
    approvalFingerprint: record.approvalFingerprint ?? null,
    captureSpecDigest: record.captureSpecDigest, t0: record.t0,
    claimedAt: now,
    // POST-START CONTINUATION binding, copied verbatim from the authorization it
    // consumes, so a claim can never be moved across continuation states.
    ...(record.continuationFingerprint === undefined ? {} : {
      continuation: record.continuation,
      continuationFingerprint: record.continuationFingerprint,
      continuationCommit: record.continuationCommit,
    }),
  };
  const claim = { ...content, fingerprint: digest(content) };
  try { writeDurableExclusive(claimFile, canonical(claim) + '\n'); }
  catch (error) { if (error?.code === 'EEXIST') fail('R4_CAPABILITY_ALREADY_CLAIMED'); throw error; }
  return Object.freeze(claim);
}

/* --------------------------------------------------------------- proofs */

/** Build a proof object from a raw capability plus the persisted record. */
export function proveCapability({ capability, record }) {
  assertAttemptAuthorization(record);
  const hash = capabilityHash(capability);
  const expected = Buffer.from(record.capabilityHash, 'hex');
  const actual = Buffer.from(hash, 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) fail('R4_CAPABILITY_MISMATCH');
  return Object.freeze({ capability: Buffer.from(capability), capabilityHash: hash,
    authorizationFingerprint: record.fingerprint, sessionId: record.sessionId, attemptIndex: record.attemptIndex,
    t0: record.t0, approvalCommit: record.approvalCommit, approvalEpoch: record.approvalEpoch ?? null,
    approvalFingerprint: record.approvalFingerprint ?? null, sealFingerprint: record.sealFingerprint,
    protocolCommit: record.protocolCommit, sealAuthorityCommit: record.sealAuthorityCommit,
    captureSpecDigest: record.captureSpecDigest,
    ...(record.continuationFingerprint === undefined ? {} : {
      continuation: record.continuation,
      continuationFingerprint: record.continuationFingerprint,
      continuationCommit: record.continuationCommit,
    }) });
}

export function assertAttemptProof(proof, { attemptIndex = null, sessionId = null } = {}) {
  if (!proof || typeof proof !== 'object') fail('R4_CAPABILITY_PROOF_REQUIRED');
  if (!isDigest(proof.capabilityHash)) fail('R4_CAPABILITY_PROOF_INVALID');
  if (!isDigest(proof.authorizationFingerprint)) fail('R4_CAPABILITY_PROOF_INVALID');
  if (!Buffer.isBuffer(proof.capability) || capabilityHash(proof.capability) !== proof.capabilityHash) fail('R4_CAPABILITY_PROOF_INVALID');
  if (attemptIndex !== null && proof.attemptIndex !== attemptIndex) fail('R4_CAPABILITY_ATTEMPT_MISMATCH');
  if (sessionId !== null && proof.sessionId !== sessionId) fail('R4_CAPABILITY_SESSION_MISMATCH');
  if ((proof.approvalFingerprint ?? null) !== null && !isDigest(proof.approvalFingerprint)) fail('R4_CAPABILITY_APPROVAL_FINGERPRINT_INVALID');
  if (proof.continuationFingerprint !== undefined
    && (!isDigest(proof.continuationFingerprint) || !isSha(proof.continuationCommit)
      || !Number.isInteger(proof.continuation) || proof.continuation < 1)) fail('R4_CAPABILITY_PROOF_INVALID');
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
 * Capture side: acquire AND ATOMICALLY CLAIM the sealed-runner capability.
 * Returns `null` when no capability is present (a direct/unsealed invocation),
 * so the caller can refuse. Throws when a capability exists but is not
 * authorized, does not match, or was already claimed (replay / double-spend).
 * The returned proof carries the durable claim it consumed.
 */
export function acquireRunnerCapability({ fd = R4_CAPABILITY_FD, root = R4_ATTEMPT_AUTH_DIR, cwd = R4_REPO_ROOT, now = Date.now() } = {}) {
  const capability = readCapabilityFromDescriptor(fd);
  if (!capability) return null;
  const record = resolveCapabilityRecord({ capability, root, cwd });
  const claim = claimAttemptAuthorization({ record, capability, claimant: R4_CLAIMANTS.child, now, root, cwd });
  const proof = proveCapability({ capability, record });
  return Object.freeze({ ...proof, claimFingerprint: claim.fingerprint, claim });
}

/* ------------------------------------------------------------- receipts */

/** Receipt written by capture after finalization so the runner can finalize. */
export function createSessionReceipt({ authorizationFingerprint, capabilityHash: hash, claimFingerprint = null, sessionId, sessionFingerprint, approvalFingerprint = null, revisitCoverage = null, continuation = null }) {
  if (!isDigest(sessionFingerprint)) fail('R4_RECEIPT_SESSION_FINGERPRINT_INVALID');
  if (approvalFingerprint !== null && !isDigest(approvalFingerprint)) fail('R4_RECEIPT_APPROVAL_FINGERPRINT_INVALID');
  if (continuation !== null && (!Number.isInteger(continuation.generation) || continuation.generation < 1
    || !isDigest(continuation.fingerprint) || !isSha(continuation.commit))) fail('R4_RECEIPT_CONTINUATION_INVALID');
  const content = { schemaVersion: continuation === null ? 1 : R4_SESSION_RECEIPT_SCHEMA_VERSION_POST_CONTINUATION,
    recordType: R4_SESSION_RECEIPT_RECORD_TYPE, authorizationFingerprint, capabilityHash: hash,
    claimFingerprint, sessionId, sessionFingerprint, approvalFingerprint, revisitCoverage,
    // POST-START CONTINUATION binding, so a receipt can never be replayed across
    // continuation states.
    ...(continuation === null ? {} : {
      continuation: continuation.generation,
      continuationFingerprint: continuation.fingerprint,
      continuationCommit: continuation.commit,
    }) };
  return { ...content, fingerprint: digest(content) };
}

export function writeSessionReceipt(receipt, { root = R4_ATTEMPT_AUTH_DIR, cwd = R4_REPO_ROOT } = {}) {
  const dir = attemptDir({ root, cwd });
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, sessionReceiptFile(receipt.sessionId));
  writeDurableExclusive(file, canonical(receipt) + '\n');
  return { file, fingerprint: receipt.fingerprint };
}

export function readSessionReceipt(sessionId, { root = R4_ATTEMPT_AUTH_DIR, cwd = R4_REPO_ROOT } = {}) {
  try { return JSON.parse(readFileSync(path.join(attemptDir({ root, cwd }), sessionReceiptFile(sessionId)), 'utf8')); } catch { return null; }
}

export function assertSessionReceipt(receipt, { proof, record, claim = null }) {
  if (!receipt || receipt.recordType !== R4_SESSION_RECEIPT_RECORD_TYPE) fail('R4_RECEIPT_INVALID');
  if (receipt.schemaVersion !== 1 && receipt.schemaVersion !== R4_SESSION_RECEIPT_SCHEMA_VERSION_POST_CONTINUATION) fail('R4_RECEIPT_INVALID');
  const { fingerprint, ...content } = receipt;
  if (digest(content) !== fingerprint) fail('R4_RECEIPT_FINGERPRINT_MISMATCH');
  if (receipt.capabilityHash !== record.capabilityHash) fail('R4_RECEIPT_CAPABILITY_MISMATCH');
  if (receipt.authorizationFingerprint !== record.fingerprint) fail('R4_RECEIPT_AUTHORIZATION_MISMATCH');
  if (receipt.sessionId !== record.sessionId) fail('R4_RECEIPT_SESSION_MISMATCH');
  if (receipt.sessionId !== proof.sessionId) fail('R4_RECEIPT_SESSION_MISMATCH');
  if (claim && receipt.claimFingerprint !== claim.fingerprint) fail('R4_RECEIPT_CLAIM_MISMATCH');
  // The receipt carries the approval fingerprint explicitly, so a receipt is
  // self-contained with respect to WHICH approval governed the attempt rather
  // than only transitively through `authorizationFingerprint`.
  if ((receipt.approvalFingerprint ?? null) !== (record.approvalFingerprint ?? null)) fail('R4_RECEIPT_APPROVAL_FINGERPRINT_MISMATCH');
  if ((proof.approvalFingerprint ?? null) !== (record.approvalFingerprint ?? null)) fail('R4_RECEIPT_APPROVAL_FINGERPRINT_MISMATCH');
  const expectedContinuation = record.continuationFingerprint ?? null;
  if (expectedContinuation === null) {
    if (receipt.schemaVersion !== 1 || (receipt.continuationFingerprint ?? null) !== null) fail('R4_RECEIPT_CONTINUATION_MISMATCH');
  } else {
    if (receipt.schemaVersion !== R4_SESSION_RECEIPT_SCHEMA_VERSION_POST_CONTINUATION) fail('R4_RECEIPT_CONTINUATION_SCHEMA_REQUIRED');
    if (receipt.continuationFingerprint !== expectedContinuation
      || receipt.continuation !== record.continuation || receipt.continuationCommit !== record.continuationCommit
      || proof.continuationFingerprint !== expectedContinuation || proof.continuation !== record.continuation
      || proof.continuationCommit !== record.continuationCommit) fail('R4_RECEIPT_CONTINUATION_MISMATCH');
    if (claim && (claim.continuationFingerprint !== expectedContinuation || claim.continuation !== record.continuation
      || claim.continuationCommit !== record.continuationCommit)) fail('R4_RECEIPT_CONTINUATION_MISMATCH');
  }
  return true;
}
