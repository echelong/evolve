// R4 sealed-session attestation (enforcement only).
//
// A REAL R4 cohort session may not be identified by a caller-supplied
// `role='cohort'` string, and — after independent pre-capture review round 2
// (blocker B1) — it may not be minted from public authority values either. It
// must carry an authenticated attestation record created and finalized ONLY by
// the sealed cohort runner's lifecycle, bound to a cryptographically random
// pre-attempt runner capability that was persisted in blinded form and handed to
// capture over an inherited descriptor.
//
// The attestation binds the session to:
//
//   * the canonical tracked seal fingerprint
//   * the protocol commit P and its tree
//   * the seal authority commit S
//   * the pre-capture approval commit A (the real T0 anchor)
//   * the pre-attempt authorization fingerprint and the blinded capability hash
//   * the attempt index (1..maxAttempts) and the authorization-derived session id
//   * role = cohort
//   * the sealed 45-minute reference window
//   * the sealed provider configuration and capture mode
//   * the authenticated session manifest fingerprint
//
// There is no exported interface that mints a valid attestation from public
// fields alone: `createSessionAttestation` and `finalizeSessionAttestation` both
// require a live capability proof whose blinded hash matches a persisted
// pre-attempt authorization record. Verification remains publicly callable.
//
// Trust model (disclosed, not weakened): the EVOLVE evidence chain authenticates
// CONTENT (per-file SHA-256 plus canonical fingerprints) and governance records
// authenticate a declared operator identity. There is no private-key signing
// infrastructure. This prevents ordinary CLI/API/config bypass and
// accidental/manual masquerading inside the repository's execution model; it does
// NOT claim to defend against a malicious local user who can rewrite code,
// attach a debugger or steal another process's memory.
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { digest, canonical } from './market-intelligence/definition.mjs';
import { R4_SPEC, captureSpecDigest } from './r4-protocol-spec.mjs';
import { isR4Excluded } from './r4-exclusions.mjs';
import { assertAttemptProof, R4_SESSION_ROLE, R4_CAPABILITY_FD } from './r4-capability.mjs';

export const R4_ATTESTATION_RECORD_TYPE = 'r4_cohort_session_attestation';
export { R4_SESSION_ROLE, R4_CAPABILITY_FD };
export const R4_ATTESTATION_DIR = '.evolve/governance/r4-attestations';
export const R4_AUTHORIZATION_CHAIN = 'P_S_A';

const fail = code => { throw new Error(code); };
const attestationFingerprint = record => digest(record);
const isSha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);

function assertAttemptIndex(attemptIndex) {
  if (!Number.isInteger(attemptIndex) || attemptIndex < 1 || attemptIndex > R4_SPEC.cohort.maxAttempts) fail('R4_ATTESTATION_ATTEMPT_INDEX_INVALID');
}

/**
 * Open an attestation for a real R4 cohort attempt. Only the sealed runner
 * lifecycle can satisfy the capability requirement: `proof` must come from
 * `proveCapability` over a capability whose SHA-256 matches a persisted
 * pre-attempt authorization record.
 */
export function createSessionAttestation({ seal, authority, approvalAuthority, proof, cohortId = null }) {
  if (!seal || typeof seal !== 'object' || typeof seal.fingerprint !== 'string') fail('R4_ATTESTATION_SEAL_INVALID');
  if (!authority || authority.sealAuthorityCommit == null) fail('R4_ATTESTATION_AUTHORITY_INVALID');
  if (!approvalAuthority || !isSha(approvalAuthority.approvalCommit) || !Number.isSafeInteger(approvalAuthority.t0)) fail('R4_ATTESTATION_APPROVAL_INVALID');
  if (!proof || typeof proof !== 'object') fail('R4_ATTESTATION_CAPABILITY_REQUIRED');
  assertAttemptProof(proof);
  if (proof.sealFingerprint !== seal.fingerprint) fail('R4_ATTESTATION_SEAL_MISMATCH');
  if (proof.protocolCommit !== seal.protocolCommit) fail('R4_ATTESTATION_PROTOCOL_COMMIT_MISMATCH');
  if (proof.sealAuthorityCommit !== authority.sealAuthorityCommit) fail('R4_ATTESTATION_AUTHORITY_COMMIT_MISMATCH');
  if (proof.approvalCommit !== approvalAuthority.approvalCommit) fail('R4_ATTESTATION_APPROVAL_COMMIT_MISMATCH');
  if (proof.t0 !== approvalAuthority.t0) fail('R4_ATTESTATION_T0_MISMATCH');
  if (proof.captureSpecDigest !== captureSpecDigest()) fail('R4_ATTESTATION_CAPTURE_SPEC_MISMATCH');
  const attemptIndex = proof.attemptIndex;
  assertAttemptIndex(attemptIndex);
  const sessionId = proof.sessionId;
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(sessionId)) fail('R4_ATTESTATION_SESSION_ID_INVALID');
  if (isR4Excluded(sessionId)) fail('R4_EXCLUDED_SESSION');
  const content = {
    schemaVersion: 1, recordType: R4_ATTESTATION_RECORD_TYPE, role: R4_SESSION_ROLE, status: 'OPEN',
    authorizationChain: R4_AUTHORIZATION_CHAIN, approvalCommit: approvalAuthority.approvalCommit,
    authorizationFingerprint: proof.authorizationFingerprint, capabilityHash: proof.capabilityHash,
    sealFingerprint: seal.fingerprint, protocolCommit: seal.protocolCommit, protocolTree: seal.protocolTree,
    authorityCommit: authority.sealAuthorityCommit, specDigest: seal.specDigest, captureSpecDigest: seal.captureSpecDigest,
    attemptIndex, sessionId, cohortId: cohortId ?? `r4-cohort-${String(seal.fingerprint).slice(0, 12)}`,
    t0: approvalAuthority.t0, t0Iso: new Date(approvalAuthority.t0).toISOString(),
    referenceWindowMinutes: R4_SPEC.cohort.referenceMinutes,
    referenceWindowMs: R4_SPEC.capture.referenceWindowMs, captureMode: R4_SPEC.cohort.captureMode,
    captureFlag: R4_SPEC.cohort.captureFlag, providers: R4_SPEC.providers,
    sessionFingerprint: null, revisitCoverage: null, sessionParametersImmutable: true,
  };
  return { ...content, fingerprint: attestationFingerprint(content) };
}

function normalizeCoverage(coverage) {
  if (coverage === null || coverage === undefined) return null;
  if (typeof coverage !== 'object') fail('R4_ATTESTATION_REVISIT_COVERAGE_INVALID');
  const out = {};
  for (const key of ['scheduled', 'completed', 'failed', 'pending']) {
    const value = coverage[key];
    if (!Number.isInteger(value) || value < 0) fail('R4_ATTESTATION_REVISIT_COVERAGE_INVALID');
    out[key] = value;
  }
  return out;
}

/**
 * Bind the authenticated session manifest fingerprint (and the bounded-drain
 * revisit coverage) to an open attestation. Requires the same capability proof
 * as creation: a caller without the raw runner capability cannot finalize.
 */
export function finalizeSessionAttestation(attestation, { sessionFingerprint, revisitCoverage = null, proof } = {}) {
  if (!attestation || attestation.recordType !== R4_ATTESTATION_RECORD_TYPE) fail('R4_ATTESTATION_INVALID');
  if (attestation.status !== 'OPEN') fail('R4_ATTESTATION_STATE_INVALID');
  if (!proof || typeof proof !== 'object') fail('R4_ATTESTATION_CAPABILITY_REQUIRED');
  assertAttemptProof(proof, { attemptIndex: attestation.attemptIndex, sessionId: attestation.sessionId });
  if (proof.authorizationFingerprint !== attestation.authorizationFingerprint || proof.capabilityHash !== attestation.capabilityHash) fail('R4_ATTESTATION_CAPABILITY_MISMATCH');
  if (typeof sessionFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(sessionFingerprint)) fail('R4_ATTESTATION_SESSION_FINGERPRINT_INVALID');
  const coverage = normalizeCoverage(revisitCoverage);
  const content = { ...attestation };
  delete content.fingerprint;
  const next = { ...content, status: 'FINALIZED', sessionFingerprint, revisitCoverage: coverage };
  return { ...next, fingerprint: attestationFingerprint(next) };
}

/**
 * Verify an attestation against the canonical seal, the Git authority chain, the
 * approval anchor and an authenticated session. Throws a fixed code on mismatch.
 */
export function verifySessionAttestation({ attestation, session, seal, authority, approvalAuthority = null, authorizationRecord = null, attemptIndex = null }) {
  if (!attestation || typeof attestation !== 'object' || attestation.recordType !== R4_ATTESTATION_RECORD_TYPE || attestation.schemaVersion !== 1) fail('R4_ATTESTATION_INVALID');
  const { fingerprint, ...content } = attestation;
  if (attestationFingerprint(content) !== fingerprint) fail('R4_ATTESTATION_FINGERPRINT_MISMATCH');
  if (attestation.status !== 'FINALIZED') fail('R4_ATTESTATION_NOT_FINALIZED');
  if (attestation.role !== R4_SESSION_ROLE) fail('R4_ATTESTATION_ROLE_INVALID');
  if (attestation.authorizationChain !== R4_AUTHORIZATION_CHAIN) fail('R4_ATTESTATION_AUTHORIZATION_CHAIN_INVALID');
  if (!isSha(attestation.approvalCommit)) fail('R4_ATTESTATION_APPROVAL_COMMIT_INVALID');
  if (typeof attestation.capabilityHash !== 'string' || !/^[0-9a-f]{64}$/.test(attestation.capabilityHash)) fail('R4_ATTESTATION_CAPABILITY_HASH_INVALID');
  if (typeof attestation.authorizationFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(attestation.authorizationFingerprint)) fail('R4_ATTESTATION_AUTHORIZATION_FINGERPRINT_INVALID');
  if (!seal || typeof seal.fingerprint !== 'string') fail('R4_ATTESTATION_SEAL_INVALID');
  if (attestation.sealFingerprint !== seal.fingerprint) fail('R4_ATTESTATION_SEAL_MISMATCH');
  if (attestation.protocolCommit !== seal.protocolCommit) fail('R4_ATTESTATION_PROTOCOL_COMMIT_MISMATCH');
  if (attestation.protocolTree !== seal.protocolTree) fail('R4_ATTESTATION_PROTOCOL_TREE_MISMATCH');
  if (attestation.specDigest !== seal.specDigest) fail('R4_ATTESTATION_SPEC_DIGEST_MISMATCH');
  if (attestation.captureSpecDigest !== seal.captureSpecDigest || attestation.captureSpecDigest !== captureSpecDigest()) fail('R4_ATTESTATION_CAPTURE_SPEC_MISMATCH');
  if (!authority || attestation.authorityCommit !== authority.sealAuthorityCommit) fail('R4_ATTESTATION_AUTHORITY_COMMIT_MISMATCH');
  assertAttemptIndex(attestation.attemptIndex);
  if (attemptIndex !== null && attestation.attemptIndex !== attemptIndex) fail('R4_ATTESTATION_ATTEMPT_INDEX_MISMATCH');
  if (attestation.referenceWindowMinutes !== R4_SPEC.cohort.referenceMinutes) fail('R4_ATTESTATION_REFERENCE_WINDOW_MISMATCH');
  if (attestation.captureMode !== R4_SPEC.cohort.captureMode || attestation.captureFlag !== R4_SPEC.cohort.captureFlag) fail('R4_ATTESTATION_CAPTURE_MODE_MISMATCH');
  if (canonical(attestation.providers) !== canonical(R4_SPEC.providers)) fail('R4_ATTESTATION_PROVIDER_MISMATCH');
  // T0 must equal the authority-derived anchor: the verified approval commit A,
  // or (for offline verification) the persisted pre-attempt authorization record.
  const expectedT0 = approvalAuthority?.t0 ?? authorizationRecord?.t0 ?? null;
  if (expectedT0 !== null && attestation.t0 !== expectedT0) fail('R4_ATTESTATION_T0_MISMATCH');
  if (approvalAuthority && attestation.approvalCommit !== approvalAuthority.approvalCommit) fail('R4_ATTESTATION_APPROVAL_COMMIT_MISMATCH');
  if (authorizationRecord) {
    if (authorizationRecord.capabilityHash !== attestation.capabilityHash) fail('R4_ATTESTATION_AUTHORIZATION_CAPABILITY_MISMATCH');
    if (authorizationRecord.fingerprint !== attestation.authorizationFingerprint) fail('R4_ATTESTATION_AUTHORIZATION_MISMATCH');
    if (authorizationRecord.sessionId !== attestation.sessionId) fail('R4_ATTESTATION_AUTHORIZATION_SESSION_MISMATCH');
    if (authorizationRecord.attemptIndex !== attestation.attemptIndex) fail('R4_ATTESTATION_AUTHORIZATION_ATTEMPT_MISMATCH');
    if (authorizationRecord.approvalCommit !== attestation.approvalCommit) fail('R4_ATTESTATION_AUTHORIZATION_APPROVAL_MISMATCH');
  }
  if (!session || typeof session !== 'object') fail('R4_ATTESTATION_SESSION_INVALID');
  if (attestation.sessionId !== session.sessionId) fail('R4_ATTESTATION_SESSION_ID_MISMATCH');
  if (attestation.sessionFingerprint !== session.fingerprint) fail('R4_ATTESTATION_SESSION_FINGERPRINT_MISMATCH');
  if (isR4Excluded(session.sessionId)) fail('R4_EXCLUDED_SESSION');
  // E1_REFERENCE_LEVEL_MISSINGNESS: unfinished scheduler work (pending after the
  // complete bounded drain) stays session-fatal, so it disqualifies the source.
  if (attestation.revisitCoverage !== null && attestation.revisitCoverage.pending !== 0) fail('R4_ATTESTATION_REVISIT_PENDING');
  return { ok: true, attemptIndex: attestation.attemptIndex, sessionId: session.sessionId, sessionFingerprint: attestation.sessionFingerprint,
    captureSpecDigest: attestation.captureSpecDigest, attestationFingerprint: fingerprint,
    authorizationFingerprint: attestation.authorizationFingerprint, capabilityHash: attestation.capabilityHash };
}

/** The only write performed by this module: the governance attestation store. */
export function writeSessionAttestation(attestation, { root = R4_ATTESTATION_DIR } = {}) {
  if (!attestation || attestation.recordType !== R4_ATTESTATION_RECORD_TYPE) fail('R4_ATTESTATION_INVALID');
  mkdirSync(root, { recursive: true });
  const file = path.join(root, `${attestation.sessionId}.json`);
  writeFileSync(file, canonical(attestation) + '\n');
  return { file, fingerprint: attestation.fingerprint };
}

export function readSessionAttestation(sessionId, { root = R4_ATTESTATION_DIR } = {}) {
  try { return JSON.parse(readFileSync(path.join(root, `${sessionId}.json`), 'utf8')); } catch { return null; }
}

export function listSessionAttestations({ root = R4_ATTESTATION_DIR } = {}) {
  try {
    return readdirSync(root).filter(name => name.endsWith('.json')).sort()
      .map(name => { try { return JSON.parse(readFileSync(path.join(root, name), 'utf8')); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}
