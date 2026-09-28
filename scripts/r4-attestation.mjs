// R4 sealed-session attestation (enforcement only).
//
// A REAL R4 cohort session may not be identified by a caller-supplied
// `role='cohort'` string. It must carry an authenticated attestation record,
// created only by the sealed cohort runner, that binds the session to:
//
//   * the canonical tracked seal fingerprint
//   * the protocol commit P and its tree
//   * the seal authority commit S
//   * the sealed specification digest and capture-specification digest
//   * the attempt index (1..maxAttempts)
//   * role = cohort
//   * the cohort id and T0 derived from S's committer timestamp
//   * the sealed 45-minute reference window
//   * the sealed provider configuration
//   * capture mode = r4-revisits
//   * the authenticated session manifest fingerprint
//
// Trust model (disclosed, not weakened): the EVOLVE evidence chain authenticates
// CONTENT (per-file SHA-256 plus canonical fingerprints) and governance records
// authenticate a declared operator identity. There is no private-key signing
// infrastructure anywhere in this repository, so this attestation is a
// governance record in the governance root bound to authenticated content
// digests and to the Git authority chain, exactly like every other governance
// record. It is strictly stronger than a caller-supplied role string, which is
// what the independent pre-capture review required.
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { digest, canonical } from './market-intelligence/definition.mjs';
import { R4_SPEC, captureSpecDigest } from './r4-protocol-spec.mjs';
import { authorityT0 } from './r4-authority.mjs';
import { isR4Excluded } from './r4-exclusions.mjs';

export const R4_ATTESTATION_RECORD_TYPE = 'r4_cohort_session_attestation';
export const R4_SESSION_ROLE = 'cohort';
export const R4_ATTESTATION_DIR = '.evolve/governance/r4-attestations';

const fail = code => { throw new Error(code); };
const attestationFingerprint = record => digest(record);

function assertAttemptIndex(attemptIndex) {
  if (!Number.isInteger(attemptIndex) || attemptIndex < 1 || attemptIndex > R4_SPEC.cohort.maxAttempts) fail('R4_ATTESTATION_ATTEMPT_INDEX_INVALID');
}

/**
 * Open an attestation for a real R4 cohort attempt. Only the sealed cohort
 * runner may call this. `seal` is the canonical tracked seal and `authority` is
 * the verified authority resolution for it.
 */
export function createSessionAttestation({ seal, authority, attemptIndex, sessionId, cohortId = null }) {
  if (!seal || typeof seal !== 'object' || typeof seal.fingerprint !== 'string') fail('R4_ATTESTATION_SEAL_INVALID');
  if (!authority || authority.sealAuthorityCommit == null) fail('R4_ATTESTATION_AUTHORITY_INVALID');
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(sessionId)) fail('R4_ATTESTATION_SESSION_ID_INVALID');
  if (isR4Excluded(sessionId)) fail('R4_EXCLUDED_SESSION');
  assertAttemptIndex(attemptIndex);
  const t0 = authorityT0(authority.sealCommitterTimestamp);
  const content = {
    schemaVersion: 1, recordType: R4_ATTESTATION_RECORD_TYPE, role: R4_SESSION_ROLE, status: 'OPEN',
    sealFingerprint: seal.fingerprint, protocolCommit: seal.protocolCommit, protocolTree: seal.protocolTree,
    authorityCommit: authority.sealAuthorityCommit, specDigest: seal.specDigest, captureSpecDigest: seal.captureSpecDigest,
    attemptIndex, sessionId, cohortId: cohortId ?? `r4-cohort-${String(seal.fingerprint).slice(0, 12)}`,
    t0, t0Iso: new Date(t0).toISOString(), referenceWindowMinutes: R4_SPEC.cohort.referenceMinutes,
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
 * revisit coverage) to an open attestation. `revisitCoverage` is recorded from
 * the live queue at finalize time so the E1 `pending === 0` requirement travels
 * with the session's authenticated identity.
 */
export function finalizeSessionAttestation(attestation, { sessionFingerprint, revisitCoverage = null }) {
  if (!attestation || attestation.recordType !== R4_ATTESTATION_RECORD_TYPE) fail('R4_ATTESTATION_INVALID');
  if (attestation.status !== 'OPEN') fail('R4_ATTESTATION_STATE_INVALID');
  if (typeof sessionFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(sessionFingerprint)) fail('R4_ATTESTATION_SESSION_FINGERPRINT_INVALID');
  const coverage = normalizeCoverage(revisitCoverage);
  const content = { ...attestation };
  delete content.fingerprint;
  const next = { ...content, status: 'FINALIZED', sessionFingerprint, revisitCoverage: coverage };
  return { ...next, fingerprint: attestationFingerprint(next) };
}

/**
 * Verify an attestation against the canonical seal, the Git authority chain and
 * an authenticated session. Throws a fixed code on any mismatch.
 */
export function verifySessionAttestation({ attestation, session, seal, authority, attemptIndex = null }) {
  if (!attestation || typeof attestation !== 'object' || attestation.recordType !== R4_ATTESTATION_RECORD_TYPE || attestation.schemaVersion !== 1) fail('R4_ATTESTATION_INVALID');
  const { fingerprint, ...content } = attestation;
  if (attestationFingerprint(content) !== fingerprint) fail('R4_ATTESTATION_FINGERPRINT_MISMATCH');
  if (attestation.status !== 'FINALIZED') fail('R4_ATTESTATION_NOT_FINALIZED');
  if (attestation.role !== R4_SESSION_ROLE) fail('R4_ATTESTATION_ROLE_INVALID');
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
  const expectedT0 = authorityT0(authority.sealCommitterTimestamp);
  if (attestation.t0 !== expectedT0) fail('R4_ATTESTATION_T0_MISMATCH');
  if (!session || typeof session !== 'object') fail('R4_ATTESTATION_SESSION_INVALID');
  if (attestation.sessionId !== session.sessionId) fail('R4_ATTESTATION_SESSION_ID_MISMATCH');
  if (attestation.sessionFingerprint !== session.fingerprint) fail('R4_ATTESTATION_SESSION_FINGERPRINT_MISMATCH');
  if (isR4Excluded(session.sessionId)) fail('R4_EXCLUDED_SESSION');
  // E1_REFERENCE_LEVEL_MISSINGNESS: unfinished scheduler work (pending after the
  // complete bounded drain) stays session-fatal, so it disqualifies the source.
  if (attestation.revisitCoverage !== null && attestation.revisitCoverage.pending !== 0) fail('R4_ATTESTATION_REVISIT_PENDING');
  return { ok: true, attemptIndex: attestation.attemptIndex, sessionId: session.sessionId, sessionFingerprint: attestation.sessionFingerprint,
    captureSpecDigest: attestation.captureSpecDigest, attestationFingerprint: fingerprint };
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
