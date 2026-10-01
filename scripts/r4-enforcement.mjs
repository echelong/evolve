// R4 pre-capture enforcement (implementation controls only).
//
// Every function here enforces an already-frozen R4 rule. None of them chooses
// a scientific value; all scientific values come from the canonical frozen
// specification (`scripts/r4-protocol-spec.mjs`) and the canonical tracked seal.
//
// Round-2 hardening (enforcement only — no scientific value changed):
//   * unknown analysis option keys fail, not just frozen override keys;
//   * cohort membership is an evaluator OUTPUT derived mechanically from attempt
//     records and verified attestations, never a caller-supplied `plan.membership`;
//   * the canonical reference builder requires verified canonical membership and
//     authenticates every source;
//   * exposure provenance reloads authenticated evidence from disk and refuses
//     non-evidence session objects;
//   * the outcome-run binding independently derives the expected source session
//     ids from canonical membership.
import path from 'node:path';
import { digest, canonical } from './market-intelligence/definition.mjs';
import { R4_SPEC, captureSpecDigest } from './r4-protocol-spec.mjs';
import { R4_EXCLUSIONS, isR4Excluded, assertR4NotExcluded } from './r4-exclusions.mjs';
import { R4_COHORT_SPEC, buildAuthorizedCohortPlan, evaluateCohortProgress, mechanicalT0 } from './r4-cohort-plan.mjs';
import { R4_ATTESTATION_RECORD_TYPE, verifySessionAttestation } from './r4-attestation.mjs';
import { attemptAuthorityForGovernance } from './r4-attempt-history.mjs';
import { readSourceSession, CLASSIFICATION, R4_SOURCE_POLICY, R4_AUTHENTICATED_SESSION } from './market-outcomes/index.mjs';
import { selectAllEligibleReferences } from './market-outcomes/reference-selection.mjs';
import { assembleAnalysisRows, runPrimaryAnalysis, kendallTauB } from './market-outcomes/primary-analysis.mjs';

const fail = code => { throw new Error(code); };

/**
 * MISSED ATTEMPT-1 WINDOW GOVERNANCE AMENDMENT: an ABSENT approval epoch means
 * the historical legacy epoch 1, so a hand-built authority object that predates
 * approval epochs is not silently re-interpreted as a renewal.
 */
const epochOf = value => (value === null || value === undefined ? 1 : value);

/**
 * The seal IDENTITY an attempt must be verified against.
 *
 * `verifySessionAttestation` binds an attestation to a seal's fingerprint,
 * protocol commit, protocol tree, spec digest and capture-spec digest. After a
 * post-start continuation those are NOT all the same object: a grandfathered
 * pre-boundary attempt legitimately carries the HISTORICAL seal's identity, while
 * a post-boundary attempt carries the current one. The scientific values those
 * checks enforce (`specDigest`, `captureSpecDigest`, `spec`, `exclusions`,
 * `providers`, `cohortPlan`) are frozen and identical across both generations —
 * the continuation is enforcement-only — so the historical identity is projected
 * onto the current seal object and only its Git identity fields are replaced.
 *
 * Nothing here relaxes verification: every field the attestation is checked
 * against is still the canonical frozen value, and the Git identity is still the
 * authenticated per-attempt authority.
 */
function sealIdentityFor(perAttempt, currentSeal) {
  if (!currentSeal || typeof currentSeal !== 'object') fail('R4_GOVERNANCE_CURRENT_SEAL_REQUIRED');
  return Object.freeze({
    ...currentSeal,
    fingerprint: perAttempt.sealFingerprint,
    protocolCommit: perAttempt.protocolCommit,
    protocolTree: perAttempt.protocolTree,
  });
}

export const R4_ANALYSIS_RECORD_TYPE = 'r4_real_primary_analysis';
export const R4_OUTCOME_BINDING_RECORD_TYPE = 'r4_outcome_run_binding';
export const R4_SESSION_DIR_ROOT = '.evolve/market-intelligence/sessions';

/** What a real R4 cohort source must prove (docs/R4-PREREGISTRATION.md §D1/§D2). */
export const R4_SESSION_ELIGIBILITY_REQUIREMENTS = Object.freeze([
  'not on the frozen methods-only exclusions list',
  'authenticated source session (manifest fingerprint + per-file digests)',
  'authenticated real-R4 session attestation',
  'matching seal fingerprint',
  'matching protocol commit',
  'matching seal authority commit',
  'matching pre-capture approval commit A',
  'matching approval epoch (the latest valid epoch; earlier epochs cannot authorize attempt 1)',
  'attempt index in 1..maxAttempts',
  'exact sealed 45-minute reference window',
  'exact sealed provider configuration',
  'exact capture mode r4-revisits',
  'session complete / duration reached',
  'storage.sessionBoundReached === false',
  'E1: revisit coverage pending === 0 (terminal reference failures permitted)',
  'membership in the verified canonical cohort membership',
]);

/* ------------------------------------------------------ analysis lock */

const LOCKED_ANALYSIS_KEYS = Object.freeze([
  'replicates', 'bootstrapReplicates', 'horizonMs', 'toleranceMs', 'clusterKey', 'exposureField', 'outcomeField',
  'estimand', 'ciMethod', 'ciLevel', 'quantileMethod', 'minResolvedReferences', 'minResolvedMints',
  'minDefinedReplicates', 'specVersion', 'seedDerivation', 'seedScheme',
]);

/**
 * Reject any attempt to override a locked primary-analysis parameter AND any
 * UNKNOWN option key. There is no silently-ignored option bag: the canonical
 * real interface accepts only the documented input objects.
 */
export function assertNoAnalysisOverrides(options = {}) {
  const allowed = new Set(['exposureRows', 'outcomes', 'seal']);
  for (const key of Object.keys(options)) {
    if (LOCKED_ANALYSIS_KEYS.includes(key)) fail(`R4_ANALYSIS_OVERRIDE_FORBIDDEN:${key}`);
    if (!allowed.has(key)) fail(`R4_ANALYSIS_UNKNOWN_OPTION:${key}`);
  }
  return true;
}

/* ------------------------------------------------- source eligibility */

/**
 * Verify one candidate real-R4 cohort source. `session` must be the object
 * returned by `readSourceSession(..., R4_SOURCE_POLICY)` (so status/reason/
 * sessionBoundReached were already enforced by the source policy) and
 * `attestation` must be the finalized attestation record. `canonicalMembership`
 * is the evaluator-derived membership, never a caller-authored array.
 */
export function verifyR4SourceEligibility({ session, attestation, seal, authority, approvalAuthority = null, attemptIndex = null, canonicalMembership = null, attemptAuthority = null }) {
  if (!session || typeof session !== 'object') fail('R4_SOURCE_INVALID');
  if (typeof session.sessionId !== 'string' || !session.sessionId) fail('R4_SOURCE_INVALID');
  if (session[R4_AUTHENTICATED_SESSION] !== true) fail('R4_SOURCE_NOT_AUTHENTICATED');
  // Hard exclusion first, whatever role was requested.
  assertR4NotExcluded(session.sessionId);
  if (session.role !== R4_COHORT_SPEC.referenceRole) fail('R4_SOURCE_ROLE_INVALID');
  if (!session.policy || session.policy.requireDurationComplete !== true) fail('R4_SOURCE_NOT_DURATION_VERIFIED');
  if (typeof session.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(session.fingerprint)) fail('R4_SOURCE_NOT_AUTHENTICATED');
  if (!attestation || attestation.recordType !== R4_ATTESTATION_RECORD_TYPE) fail('R4_ATTESTATION_REQUIRED');
  // PER-ATTEMPT AUTHORITY. When this session's attempt is grandfathered, its
  // attestation legitimately carries the HISTORICAL seal identity, so evidence
  // verification must use that identity rather than the current one. The
  // `attemptAuthority` supplied here is the authenticated per-attempt projection
  // from `verifyR4AttemptHistory` (see `buildCanonicalReferenceSetFromEvidence`),
  // never a caller-authored map, and verification is otherwise unchanged.
  const effectiveSeal = attemptAuthority === null ? seal : sealIdentityFor(attemptAuthority, seal);
  const effectiveAuthority = attemptAuthority === null ? authority : {
    protocolCommit: attemptAuthority.protocolCommit, protocolTree: attemptAuthority.protocolTree,
    sealAuthorityCommit: attemptAuthority.sealAuthorityCommit };
  const effectiveApproval = attemptAuthority === null ? approvalAuthority : {
    approvalCommit: attemptAuthority.approvalCommit, approvalEpoch: attemptAuthority.approvalEpoch,
    approvalFingerprint: attemptAuthority.approvalFingerprint, t0: attemptAuthority.t0,
    continuationFingerprint: attemptAuthority.continuationFingerprint,
    continuationGeneration: attemptAuthority.continuationGeneration };
  const proof = verifySessionAttestation({ attestation, session, seal: effectiveSeal,
    authority: effectiveAuthority, approvalAuthority: effectiveApproval, attemptIndex });
  if (canonicalMembership !== null) {
    if (!Array.isArray(canonicalMembership)) fail('R4_CANONICAL_MEMBERSHIP_INVALID');
    if (!canonicalMembership.includes(session.sessionId)) fail('R4_SESSION_NOT_IN_CANONICAL_MEMBERSHIP');
  }
  return proof;
}

/**
 * Load and verify exactly the given sources as a real R4 cohort. Any excluded,
 * unattested, duplicated or role-forged source fails the whole load.
 */
export function resolveSealedR4Sources({ sources, attestations, seal, authority, approvalAuthority = null, canonicalMembership = null }) {
  if (!Array.isArray(sources) || sources.length === 0) fail('R4_SOURCES_INVALID');
  const bySession = new Map();
  for (const attestation of Array.isArray(attestations) ? attestations : []) {
    if (attestation && typeof attestation.sessionId === 'string') bySession.set(attestation.sessionId, attestation);
  }
  const seen = new Set();
  const verified = [];
  for (const session of sources) {
    if (seen.has(session?.sessionId)) fail('R4_DUPLICATE_SOURCE_SESSION');
    seen.add(session?.sessionId);
    const attestation = bySession.get(session?.sessionId) ?? null;
    const proof = verifyR4SourceEligibility({ session, attestation, seal, authority, approvalAuthority, canonicalMembership });
    verified.push({ session, attestation, proof });
  }
  return verified;
}

/* --------------------------------------------------- cohort governance */

/**
 * The authenticated real-R4 cohort governor. Structural checks come from the
 * frozen `evaluateCohortProgress`; this layer additionally requires an
 * authenticated, seal-bound attestation for every completed attempt.
 *
 * `plan.membership` is NOT consulted: canonical membership is the mechanical
 * output of the attempt records plus their verified attestations. When the
 * verified approval authority is supplied, the plan's T0 anchor is cross-checked
 * against the authority-derived value and may never be caller-chosen.
 */
export function evaluateSealedCohortProgress({ plan, attempts, seal, authority, attestations = [], approvalAuthority = null, continuation = null }) {
  if (!plan || plan.recordType !== 'r4_cohort_plan') fail('R4_PLAN_INVALID');
  if (!seal || typeof seal.fingerprint !== 'string') fail('R4_PLAN_SEAL_INVALID');
  if (plan.sealFingerprint !== seal.fingerprint) fail('R4_PLAN_SEAL_MISMATCH');
  if (plan.preregistrationDigest !== seal.preregistration?.sha256) fail('R4_PLAN_PREREGISTRATION_MISMATCH');
  if (plan.spec?.targetCompletedSessions !== R4_SPEC.cohort.targetCompletedSessions) fail('R4_PLAN_SPEC_MISMATCH');
  if (plan.spec?.maxAttempts !== R4_SPEC.cohort.maxAttempts) fail('R4_PLAN_SPEC_MISMATCH');
  if (approvalAuthority) {
    if (!Number.isSafeInteger(approvalAuthority.t0)) fail('R4_PLAN_APPROVAL_AUTHORITY_INVALID');
    if (plan.t0 !== approvalAuthority.t0) fail('R4_PLAN_T0_MISMATCH');
    if ((plan.approvalCommit ?? null) !== (approvalAuthority.approvalCommit ?? null)) fail('R4_PLAN_APPROVAL_COMMIT_MISMATCH');
    if (epochOf(plan.approvalEpoch) !== epochOf(approvalAuthority.approvalEpoch)) fail('R4_PLAN_APPROVAL_EPOCH_MISMATCH');
    if ((plan.approvalFingerprint ?? null) !== (approvalAuthority.approvalFingerprint ?? null)) fail('R4_PLAN_APPROVAL_FINGERPRINT_MISMATCH');
  }
  // Frozen structural + membership hardening (throws on duplicate/excluded/late).
  const progress = evaluateCohortProgress(plan, attempts);
  const expectedCaptureSpec = captureSpecDigest();
  const byFingerprint = new Map();
  for (const attestation of Array.isArray(attestations) ? attestations : []) {
    if (attestation && typeof attestation.fingerprint === 'string') byFingerprint.set(attestation.fingerprint, attestation);
  }
  const authenticated = [];
  for (const attempt of attempts) {
    if (attempt.status !== 'COMPLETED') continue;
    const fingerprint = attempt.attestationFingerprint;
    if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) fail('R4_ATTEMPT_NOT_AUTHENTICATED');
    const attestation = byFingerprint.get(fingerprint);
    if (!attestation) fail('R4_ATTEMPT_ATTESTATION_NOT_FOUND');
    // PER-ATTEMPT AUTHORITY. Every completed attempt is verified against the
    // authority it was ACTUALLY authorized under, taken from the authenticated
    // projection `verifyR4AttemptHistory` attached to the attempt — never from the
    // current seal. A grandfathered pre-boundary attempt therefore keeps its
    // historical S5/A2 identity and a post-boundary attempt carries current S6/C1,
    // and BOTH may sit in canonical membership at the same time. With no
    // continuation in force this authority is the current one, so the
    // pre-continuation behaviour is byte-for-byte unchanged.
    const perAttempt = attemptAuthorityForGovernance(attempt, { continuationActive: continuation !== null });
    const effectiveSeal = perAttempt === null ? seal : sealIdentityFor(perAttempt, seal);
    const effectiveAuthority = perAttempt === null
      ? authority
      : { protocolCommit: perAttempt.protocolCommit, protocolTree: perAttempt.protocolTree, sealAuthorityCommit: perAttempt.sealAuthorityCommit };
    const effectiveApproval = perAttempt === null ? approvalAuthority : {
      approvalCommit: perAttempt.approvalCommit, approvalEpoch: perAttempt.approvalEpoch,
      approvalFingerprint: perAttempt.approvalFingerprint, t0: perAttempt.t0,
      continuationFingerprint: perAttempt.continuationFingerprint,
      continuationGeneration: perAttempt.continuationGeneration };
    const proof = verifySessionAttestation({
      attestation, session: { sessionId: attempt.sessionId, fingerprint: attestation.sessionFingerprint },
      seal: effectiveSeal, authority: effectiveAuthority, approvalAuthority: effectiveApproval, attemptIndex: attempt.index,
    });
    if (proof.sessionId !== attempt.sessionId) fail('R4_ATTEMPT_SESSION_MISMATCH');
    if (attestation.captureSpecDigest !== expectedCaptureSpec) fail('R4_ATTEMPT_CAPTURE_SPEC_MISMATCH');
    if (attestation.sealFingerprint !== effectiveSeal.fingerprint) fail('R4_ATTEMPT_SEAL_MISMATCH');
    if (attestation.protocolCommit !== effectiveSeal.protocolCommit) fail('R4_ATTEMPT_PROTOCOL_COMMIT_MISMATCH');
    if (attestation.authorityCommit !== effectiveAuthority.sealAuthorityCommit) fail('R4_ATTEMPT_AUTHORITY_COMMIT_MISMATCH');
    if (effectiveApproval && attestation.approvalCommit !== effectiveApproval.approvalCommit) fail('R4_ATTEMPT_APPROVAL_COMMIT_MISMATCH');
    if (effectiveApproval && epochOf(attestation.approvalEpoch) !== epochOf(effectiveApproval.approvalEpoch)) fail('R4_ATTEMPT_APPROVAL_EPOCH_MISMATCH');
    // The approval fingerprint is enforced by `verifySessionAttestation` above,
    // against the same `effectiveApproval`; repeating it here would be unreachable.
    authenticated.push(attempt.sessionId);
  }
  // Canonical membership is an OUTPUT. It is derived from the completed attempts
  // in attempt order, after each carrying a verified attestation.
  const canonicalMembership = [...authenticated];
  if (canonical(progress.membership) !== canonical(canonicalMembership)) fail('R4_CANONICAL_MEMBERSHIP_INCONSISTENT');
  return { ...progress, authenticatedMembership: canonicalMembership, canonicalMembership, captureSpecDigest: expectedCaptureSpec };
}

/** Canonical membership as an explicit evaluator output. */
export function deriveCanonicalCohortMembership({ plan, attempts, seal, authority, attestations = [], approvalAuthority = null, continuation = null }) {
  const progress = evaluateSealedCohortProgress({ plan, attempts, seal, authority, attestations, approvalAuthority, continuation });
  return { canonicalMembership: progress.canonicalMembership, progress };
}

/**
 * CANONICAL plan builder. T0 is taken ONLY from the verified approval authority.
 * There is no caller-supplied time argument and `sealCommittedAt` is not used.
 */
export function planSealedCohort({ seal, approvalAuthority, attemptCount = R4_SPEC.cohort.maxAttempts }) {
  if (!seal || typeof seal.fingerprint !== 'string') fail('R4_PLAN_SEAL_INVALID');
  if (attemptCount !== R4_SPEC.cohort.maxAttempts) fail('R4_PLAN_ATTEMPT_COUNT_INVALID');
  if (!approvalAuthority || !Number.isSafeInteger(approvalAuthority.t0)) fail('R4_PLAN_APPROVAL_AUTHORITY_INVALID');
  return buildAuthorizedCohortPlan({ seal, approvalAuthority });
}

/* ------------------------------------------------- canonical references */

/** Deterministic digest of a canonical `{sessionId, snapshotDigest}` reference list. */
export function referenceSetDigest(references) {
  if (!Array.isArray(references) || references.length === 0) fail('R4_REFERENCE_SET_INVALID');
  return digest(references.map(reference => ({ sessionId: reference.sessionId, snapshotDigest: reference.snapshotDigest })));
}

/**
 * Build the canonical reference set for real R4. The caller may only supply the
 * authenticated eligible source sessions selected by the cohort governor plus the
 * verified canonical membership it derived — never a reference list.
 * ALL_ELIGIBLE_REFERENCES is run here.
 */
export function buildCanonicalReferenceSet({ sessions, canonicalMembership }) {
  if (!Array.isArray(sessions) || sessions.length === 0) fail('R4_REFERENCE_SOURCES_INVALID');
  if (!Array.isArray(canonicalMembership) || canonicalMembership.length === 0) fail('R4_CANONICAL_MEMBERSHIP_REQUIRED');
  const membership = new Set(canonicalMembership);
  const seen = new Set();
  for (const session of sessions) {
    if (!session || typeof session.sessionId !== 'string') fail('R4_REFERENCE_SOURCES_INVALID');
    if (session[R4_AUTHENTICATED_SESSION] !== true) fail('R4_REFERENCE_SOURCE_NOT_AUTHENTICATED');
    if (!membership.has(session.sessionId)) fail('R4_REFERENCE_SOURCE_NOT_IN_MEMBERSHIP');
    assertR4NotExcluded(session.sessionId);
    if (session.role !== R4_COHORT_SPEC.referenceRole) fail('R4_REFERENCE_SOURCE_ROLE_INVALID');
    if (seen.has(session.sessionId)) fail('R4_DUPLICATE_SOURCE_SESSION');
    seen.add(session.sessionId);
  }
  const missing = [...membership].filter(sessionId => !seen.has(sessionId)).sort();
  if (missing.length) fail(`R4_REFERENCE_SOURCE_MEMBERSHIP_INCOMPLETE:${missing.join(',')}`);
  const references = selectAllEligibleReferences(sessions);
  return { references, digest: referenceSetDigest(references), sessionIds: [...seen].sort(), canonicalMembership: [...membership].sort() };
}

/**
 * REAL path: reload each canonical member from authenticated evidence on disk,
 * verify its attestation, and only then build ALL_ELIGIBLE_REFERENCES. Arbitrary
 * caller session objects never reach the canonical path.
 */
export function buildCanonicalReferenceSetFromEvidence({
  seal, authority, approvalAuthority = null, canonicalMembership, attestations = [],
  sessionRoot = R4_SESSION_DIR_ROOT, cwd = process.cwd(), readSession = readSourceSession,
  attemptAuthorities = null, continuation = null,
}) {
  if (!Array.isArray(canonicalMembership) || canonicalMembership.length === 0) fail('R4_CANONICAL_MEMBERSHIP_REQUIRED');
  if (new Set(canonicalMembership).size !== canonicalMembership.length) fail('R4_CANONICAL_MEMBERSHIP_DUPLICATE');
  // PER-SESSION AUTHORITY INDEX. Built from the AUTHENTICATED per-attempt authority
  // projection produced by `verifyR4AttemptHistory`, keyed by session id. This is
  // what lets a grandfathered pre-boundary session (historical S5/A2) and a
  // post-boundary session (current S6/C1) both enter canonical reference/source
  // verification simultaneously without either being reinterpreted.
  //
  // It is required whenever a continuation is in force: without it a caller could
  // make a historical session be verified under the current seal (or vice versa).
  // It is never a caller-authored authority map — `r4-canonical-analysis.mjs` builds
  // it from verified history via `historyAttemptAuthorityIndex`.
  const index = new Map();
  if (attemptAuthorities !== null) {
    if (attemptAuthorities instanceof Map) for (const [k, v] of attemptAuthorities) index.set(k, v);
    else if (Array.isArray(attemptAuthorities)) for (const entry of attemptAuthorities) index.set(entry.sessionId, entry);
    else fail('R4_ATTEMPT_AUTHORITY_INDEX_INVALID');
  }
  if (continuation !== null && index.size === 0) fail('R4_ATTEMPT_AUTHORITY_INDEX_REQUIRED');
  const bySession = new Map();
  for (const attestation of Array.isArray(attestations) ? attestations : []) {
    if (attestation && typeof attestation.sessionId === 'string') bySession.set(attestation.sessionId, attestation);
  }
  const sessions = [];
  const verified = [];
  for (const sessionId of [...canonicalMembership].sort()) {
    const dir = path.resolve(cwd, sessionRoot, sessionId);
    const session = readSession({ dir, role: R4_COHORT_SPEC.referenceRole }, R4_SOURCE_POLICY);
    const attestation = bySession.get(sessionId) ?? null;
    // Only a session whose attempt is COMPLETED in authenticated history may carry
    // an authority; a membership entry with no authenticated authority is refused.
    const attemptAuthority = index.get(sessionId) ?? null;
    if (continuation !== null && attemptAuthority === null) fail('R4_ATTEMPT_AUTHORITY_MISSING_FOR_SESSION');
    const proof = verifyR4SourceEligibility({ session, attestation, seal, authority, approvalAuthority,
      canonicalMembership, attemptAuthority, attemptIndex: attemptAuthority?.index ?? null });
    sessions.push(session);
    verified.push({ session, attestation, proof });
  }
  const set = buildCanonicalReferenceSet({ sessions, canonicalMembership });
  return { ...set, sessions, verified };
}

/** A caller-supplied reference list that differs from the canonical set fails. */
export function verifyCanonicalReferenceSet({ references, canonicalReferences }) {
  if (!Array.isArray(canonicalReferences) || canonicalReferences.length === 0) fail('R4_CANONICAL_REFERENCE_SET_MISSING');
  const canonicalList = canonicalReferences.map(reference => ({ sessionId: reference.sessionId, snapshotDigest: reference.snapshotDigest }));
  const supplied = Array.isArray(references) ? references.map(reference => ({ sessionId: reference.sessionId, snapshotDigest: reference.snapshotDigest })) : null;
  if (supplied === null || canonical(supplied) !== canonical(canonicalList)) fail('R4_REFERENCE_SET_MISMATCH');
  return referenceSetDigest(canonicalList);
}

/* ---------------------------------------------------- exposure provenance */

/**
 * Derive the primary exposure `crossSourcePriceRangeBps` for each canonical
 * reference from the authenticated reference snapshot. A caller-supplied exposure
 * value never reaches this path: the rows are constructed here. Only evidence-
 * loaded sessions (authenticated by `readSourceSession`) are accepted, so a
 * fabricated in-memory session cannot certify an exposure, mint or timestamp.
 */
export function certifyExposureRows({ references, sessions }) {
  if (!Array.isArray(references) || references.length === 0) fail('R4_EXPOSURE_REFERENCES_INVALID');
  const bySession = new Map();
  for (const session of Array.isArray(sessions) ? sessions : []) bySession.set(session.sessionId, session);
  const rows = references.map(reference => {
    const session = bySession.get(reference.sessionId);
    if (!session) fail('R4_EXPOSURE_SESSION_MISSING');
    if (session[R4_AUTHENTICATED_SESSION] !== true) fail('R4_EXPOSURE_SESSION_NOT_AUTHENTICATED');
    if (typeof session.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(session.fingerprint)) fail('R4_EXPOSURE_SESSION_NOT_AUTHENTICATED');
    assertR4NotExcluded(session.sessionId);
    const matches = session.snapshotsByDigest?.get(reference.snapshotDigest) ?? [];
    if (matches.length !== 1) fail('R4_EXPOSURE_REFERENCE_NOT_UNIQUE');
    const snapshot = matches[0];
    if (snapshot.validationReason !== null) fail('R4_EXPOSURE_REFERENCE_INVALID');
    if (snapshot.sessionId !== reference.sessionId) fail('R4_EXPOSURE_SESSION_MISMATCH');
    const exposure = snapshot.snapshot?.exposure;
    if (!exposure || exposure.field !== R4_SPEC.analysis.exposureField) fail('R4_EXPOSURE_FIELD_MISMATCH');
    if (!Number.isFinite(exposure.value)) fail('R4_EXPOSURE_VALUE_INVALID');
    if (exposure.contributorDigest !== exposure.disagreementDigest) fail('R4_EXPOSURE_PROVENANCE_MISMATCH');
    if (typeof snapshot.snapshot?.normalizedPayloadDigest !== 'string') fail('R4_EXPOSURE_PROVENANCE_MISSING');
    return { sessionId: reference.sessionId, snapshotDigest: reference.snapshotDigest, mint: snapshot.snapshot.mint,
      referenceObservedAt: snapshot.snapshot.observedAt, exposureValue: exposure.value,
      sourceFingerprint: session.fingerprint, normalizedPayloadDigest: snapshot.snapshot.normalizedPayloadDigest };
  });
  rows.sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0) || (a.snapshotDigest < b.snapshotDigest ? -1 : a.snapshotDigest > b.snapshotDigest ? 1 : 0));
  return { rows, digest: digest(rows) };
}

/**
 * REAL path: reload the canonical members from authenticated evidence on disk,
 * then certify the exposure rows. In-memory caller sessions are never trusted.
 */
export function certifyExposureRowsFromEvidence({
  seal, authority, approvalAuthority = null, canonicalMembership, references, attestations = [],
  sessionRoot = R4_SESSION_DIR_ROOT, cwd = process.cwd(), readSession = readSourceSession,
  attemptAuthorities = null, continuation = null,
}) {
  if (!Array.isArray(references) || references.length === 0) fail('R4_EXPOSURE_REFERENCES_INVALID');
  const referenceSessionIds = [...new Set(references.map(reference => reference.sessionId))].sort();
  const membership = new Set(canonicalMembership ?? []);
  for (const sessionId of referenceSessionIds) if (!membership.has(sessionId)) fail('R4_EXPOSURE_REFERENCE_NOT_IN_MEMBERSHIP');
  const evidence = buildCanonicalReferenceSetFromEvidence({ seal, authority, approvalAuthority, canonicalMembership: referenceSessionIds, attestations, sessionRoot, cwd, readSession, attemptAuthorities, continuation });
  const certified = certifyExposureRows({ references, sessions: evidence.sessions });
  return { ...certified, sessions: evidence.sessions, verified: evidence.verified };
}

/* ------------------------------------------------- locked primary analysis */

/**
 * Canonical real-R4 primary analysis. Every scientific parameter is derived from
 * the frozen spec; the function accepts no overrides and no unknown options.
 */
export function runRealR4PrimaryAnalysis(options = {}) {
  assertNoAnalysisOverrides(options);
  const { exposureRows, outcomes, seal } = options;
  if (!Array.isArray(exposureRows) || exposureRows.length === 0) fail('R4_ANALYSIS_EXPOSURE_ROWS_INVALID');
  if (!Array.isArray(outcomes) || outcomes.length === 0) fail('R4_ANALYSIS_OUTCOMES_INVALID');
  if (!seal || typeof seal.fingerprint !== 'string') fail('R4_ANALYSIS_SEAL_INVALID');
  const references = exposureRows.map(row => ({ sessionId: row.sessionId, snapshotDigest: row.snapshotDigest, exposureValue: row.exposureValue }));
  const rows = assembleAnalysisRows({ references, outcomes });
  const referenceIdentities = references.map(reference => `${reference.sessionId}/${reference.snapshotDigest}`);
  const result = runPrimaryAnalysis({
    rows, referenceIdentities, sealFingerprint: seal.fingerprint,
    replicates: R4_SPEC.analysis.bootstrapReplicates,
    horizonMs: R4_SPEC.outcome.horizonMs,
    toleranceMs: R4_SPEC.outcome.toleranceMs,
  });
  return { ...result, recordType: R4_ANALYSIS_RECORD_TYPE, interface: 'R4_SEALED_PRIMARY_ANALYSIS',
    referenceSetDigest: referenceSetDigest(references), exposureRowsDigest: digest(exposureRows),
    lockedParameters: lockedAnalysisParameters() };
}

export function lockedAnalysisParameters() {
  return Object.freeze({
    specVersion: R4_SPEC.analysis.specVersion, horizonMs: R4_SPEC.outcome.horizonMs, toleranceMs: R4_SPEC.outcome.toleranceMs,
    bootstrapReplicates: R4_SPEC.analysis.bootstrapReplicates, clusterKey: R4_SPEC.analysis.clusterKey,
    exposureField: R4_SPEC.analysis.exposureField, outcomeField: R4_SPEC.analysis.outcomeField,
    estimand: R4_SPEC.analysis.estimand, ciLevel: R4_SPEC.analysis.ciLevel, ciMethod: R4_SPEC.analysis.ciMethod,
    quantileMethod: R4_SPEC.analysis.quantileMethod, minResolvedReferences: R4_SPEC.analysis.minResolvedReferences,
    minResolvedMints: R4_SPEC.analysis.minResolvedMints, minDefinedReplicates: R4_SPEC.analysis.minDefinedReplicates,
    seedScheme: R4_SPEC.analysis.seedScheme,
  });
}

export { kendallTauB };

/* ------------------------------------------------- outcome-run binding */

/** Expected source session ids derived from the canonical references. */
export function deriveSourceSessionIds({ references }) {
  if (!Array.isArray(references) || references.length === 0) fail('R4_BINDING_REFERENCE_SET_INVALID');
  return [...new Set(references.map(reference => reference.sessionId))].sort();
}

/** Bind an outcome run to the seal, authority, cohort membership and references. */
export function buildOutcomeRunBinding({ seal, authority, approvalAuthority = null, cohortMembership, references, outcomeRun = null }) {
  if (!seal || typeof seal.fingerprint !== 'string') fail('R4_BINDING_SEAL_INVALID');
  if (!authority || typeof authority.sealAuthorityCommit !== 'string') fail('R4_BINDING_AUTHORITY_INVALID');
  if (!Array.isArray(cohortMembership) || cohortMembership.length === 0) fail('R4_BINDING_COHORT_INVALID');
  const content = {
    schemaVersion: 1, recordType: R4_OUTCOME_BINDING_RECORD_TYPE, ...CLASSIFICATION,
    sealFingerprint: seal.fingerprint, protocolCommit: seal.protocolCommit, protocolTree: seal.protocolTree,
    authorityCommit: authority.sealAuthorityCommit, approvalCommit: approvalAuthority?.approvalCommit ?? null,
    approvalEpoch: approvalAuthority?.approvalEpoch ?? null,
    approvalFingerprint: approvalAuthority?.approvalFingerprint ?? null,
    cohortMembershipDigest: digest([...cohortMembership].sort()),
    referenceSetDigest: referenceSetDigest(references),
    sourceSessionIds: deriveSourceSessionIds({ references }),
    policyA: R4_SPEC.outcome.policyA, horizonMs: R4_SPEC.outcome.horizonMs, toleranceMs: R4_SPEC.outcome.toleranceMs,
    exposureField: R4_SPEC.analysis.exposureField, outcomeField: R4_SPEC.analysis.outcomeField,
    outcomeRunFingerprint: outcomeRun?.fingerprint ?? null,
  };
  return { ...content, fingerprint: digest(content) };
}

/**
 * Reject an outcome run whose bindings do not match the seal/cohort/references.
 * The expected source session ids are derived INDEPENDENTLY from the canonical
 * references; the binding's own `sourceSessionIds` list is never trusted. An
 * added, omitted, reordered, excluded or non-member id fails.
 */
export function verifyOutcomeRunBinding({ binding, seal, authority, approvalAuthority = null, cohortMembership, references }) {
  if (!binding || binding.recordType !== R4_OUTCOME_BINDING_RECORD_TYPE || binding.schemaVersion !== 1) fail('R4_BINDING_INVALID');
  const { fingerprint, ...content } = binding;
  if (digest(content) !== fingerprint) fail('R4_BINDING_FINGERPRINT_MISMATCH');
  if (binding.sealFingerprint !== seal.fingerprint) fail('R4_BINDING_SEAL_MISMATCH');
  if (binding.protocolCommit !== seal.protocolCommit) fail('R4_BINDING_PROTOCOL_COMMIT_MISMATCH');
  if (binding.protocolTree !== seal.protocolTree) fail('R4_BINDING_PROTOCOL_TREE_MISMATCH');
  if (binding.authorityCommit !== authority.sealAuthorityCommit) fail('R4_BINDING_AUTHORITY_COMMIT_MISMATCH');
  if (approvalAuthority && (binding.approvalCommit ?? null) !== (approvalAuthority.approvalCommit ?? null)) fail('R4_BINDING_APPROVAL_COMMIT_MISMATCH');
  if (approvalAuthority && epochOf(binding.approvalEpoch) !== epochOf(approvalAuthority.approvalEpoch)) fail('R4_BINDING_APPROVAL_EPOCH_MISMATCH');
  if (approvalAuthority && (binding.approvalFingerprint ?? null) !== (approvalAuthority.approvalFingerprint ?? null)) fail('R4_BINDING_APPROVAL_FINGERPRINT_MISMATCH');
  if (binding.cohortMembershipDigest !== digest([...cohortMembership].sort())) fail('R4_BINDING_COHORT_MISMATCH');
  if (binding.referenceSetDigest !== referenceSetDigest(references)) fail('R4_BINDING_REFERENCE_SET_MISMATCH');
  const expectedSourceSessionIds = deriveSourceSessionIds({ references });
  const membership = new Set(cohortMembership);
  for (const sessionId of expectedSourceSessionIds) {
    if (isR4Excluded(sessionId)) fail('R4_EXCLUDED_SESSION');
    if (!membership.has(sessionId)) fail('R4_BINDING_SESSION_NOT_IN_MEMBERSHIP');
  }
  if (!Array.isArray(binding.sourceSessionIds) || canonical(binding.sourceSessionIds) !== canonical(expectedSourceSessionIds)) fail('R4_BINDING_SESSION_IDS_MISMATCH');
  if (binding.policyA !== R4_SPEC.outcome.policyA) fail('R4_BINDING_POLICY_A_MISMATCH');
  if (binding.horizonMs !== R4_SPEC.outcome.horizonMs || binding.toleranceMs !== R4_SPEC.outcome.toleranceMs) fail('R4_BINDING_OUTCOME_CONSTANT_MISMATCH');
  return { ok: true, fingerprint: binding.fingerprint, sourceSessionIds: expectedSourceSessionIds };
}

/* ------------------------------------------------------------------ misc */

export { R4_EXCLUSIONS, isR4Excluded, captureSpecDigest, mechanicalT0, R4_SOURCE_POLICY };
