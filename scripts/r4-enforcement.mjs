// R4 pre-capture enforcement (implementation controls only).
//
// Every function here enforces an already-frozen R4 rule. None of them chooses
// a scientific value; all scientific values come from the canonical frozen
// specification (`scripts/r4-protocol-spec.mjs`) and the canonical tracked seal.
//
// Boundaries enforced:
//   * source eligibility: a real R4 cohort source needs a real authenticated
//     attestation, not a caller-supplied role string;
//   * cohort governance: unique/excluded/authenticated/bounded attempts;
//   * canonical reference set: the primary path builds ALL_ELIGIBLE_REFERENCES
//     itself and binds a deterministic digest;
//   * exposure provenance: `crossSourcePriceRangeBps` is derived from the
//     authenticated reference snapshot, never from a caller;
//   * primary analysis: horizon/tolerance/replicates/cluster/fields/estimator/
//     CI/floors/seed are locked to the frozen spec;
//   * outcome-run binding: seal + protocol + authority + cohort + references.
import { digest, canonical } from './market-intelligence/definition.mjs';
import { R4_SPEC, captureSpecDigest } from './r4-protocol-spec.mjs';
import { R4_EXCLUSIONS, isR4Excluded, assertR4NotExcluded } from './r4-exclusions.mjs';
import { R4_COHORT_SPEC, buildCohortPlan, evaluateCohortProgress, mechanicalT0 } from './r4-cohort-plan.mjs';
import { R4_ATTESTATION_RECORD_TYPE, verifySessionAttestation } from './r4-attestation.mjs';
import { selectAllEligibleReferences } from './market-outcomes/reference-selection.mjs';
import { assembleAnalysisRows, runPrimaryAnalysis, kendallTauB } from './market-outcomes/primary-analysis.mjs';
import { CLASSIFICATION, R4_SOURCE_POLICY } from './market-outcomes/index.mjs';

const fail = code => { throw new Error(code); };

export const R4_ANALYSIS_RECORD_TYPE = 'r4_real_primary_analysis';
export const R4_OUTCOME_BINDING_RECORD_TYPE = 'r4_outcome_run_binding';

/** What a real R4 cohort source must prove (docs/R4-PREREGISTRATION.md §D1/§D2). */
export const R4_SESSION_ELIGIBILITY_REQUIREMENTS = Object.freeze([
  'not on the frozen methods-only exclusions list',
  'authenticated source session (manifest fingerprint + per-file digests)',
  'authenticated real-R4 session attestation',
  'matching seal fingerprint',
  'matching protocol commit',
  'matching seal authority commit',
  'attempt index in 1..maxAttempts',
  'exact sealed 45-minute reference window',
  'exact sealed provider configuration',
  'exact capture mode r4-revisits',
  'session complete / duration reached',
  'storage.sessionBoundReached === false',
  'E1: revisit coverage pending === 0 (terminal reference failures permitted)',
  'membership in the canonical cohort governance plan',
]);

/* ------------------------------------------------------ analysis lock */

const LOCKED_ANALYSIS_KEYS = Object.freeze([
  'replicates', 'bootstrapReplicates', 'horizonMs', 'toleranceMs', 'clusterKey', 'exposureField', 'outcomeField',
  'estimand', 'ciMethod', 'ciLevel', 'quantileMethod', 'minResolvedReferences', 'minResolvedMints',
  'minDefinedReplicates', 'specVersion', 'seedDerivation', 'seedScheme',
]);

/** Reject any attempt to override a locked primary-analysis parameter. */
export function assertNoAnalysisOverrides(options = {}) {
  for (const key of Object.keys(options)) {
    if (LOCKED_ANALYSIS_KEYS.includes(key)) fail(`R4_ANALYSIS_OVERRIDE_FORBIDDEN:${key}`);
  }
  return true;
}

/* ------------------------------------------------- source eligibility */

/**
 * Verify one candidate real-R4 cohort source. `session` must be the object
 * returned by `readSourceSession(..., R4_SOURCE_POLICY)` (so status/reason/
 * sessionBoundReached were already enforced by the source policy), and
 * `attestation` must be the finalized attestation record.
 */
export function verifyR4SourceEligibility({ session, attestation, seal, authority, attemptIndex = null, cohortPlan = null }) {
  if (!session || typeof session !== 'object') fail('R4_SOURCE_INVALID');
  if (typeof session.sessionId !== 'string' || !session.sessionId) fail('R4_SOURCE_INVALID');
  // Hard exclusion first, whatever role was requested.
  assertR4NotExcluded(session.sessionId);
  if (session.role !== R4_COHORT_SPEC.referenceRole) fail('R4_SOURCE_ROLE_INVALID');
  if (!session.policy || session.policy.requireDurationComplete !== true) fail('R4_SOURCE_NOT_DURATION_VERIFIED');
  if (typeof session.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(session.fingerprint)) fail('R4_SOURCE_NOT_AUTHENTICATED');
  if (!attestation || attestation.recordType !== R4_ATTESTATION_RECORD_TYPE) fail('R4_ATTESTATION_REQUIRED');
  const proof = verifySessionAttestation({ attestation, session, seal, authority, attemptIndex });
  if (cohortPlan) {
    if (!cohortPlan.recordType || cohortPlan.recordType !== 'r4_cohort_plan') fail('R4_PLAN_INVALID');
    if (cohortPlan.sealFingerprint !== seal.fingerprint) fail('R4_PLAN_SEAL_MISMATCH');
    if (!cohortPlan.membership?.includes(session.sessionId)) fail('R4_SESSION_NOT_IN_COHORT_PLAN');
  }
  return proof;
}

/**
 * Load and verify exactly the given sources as a real R4 cohort. Returns the
 * verified sessions and their attestation proofs. Any excluded, unattested,
 * duplicated or role-forged source fails the whole load.
 */
export function resolveSealedR4Sources({ sources, attestations, seal, authority, cohortPlan = null }) {
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
    const proof = verifyR4SourceEligibility({ session, attestation, seal, authority, cohortPlan });
    verified.push({ session, attestation, proof });
  }
  return verified;
}

/* --------------------------------------------------- cohort governance */

/**
 * The authenticated real-R4 cohort governor. Structural checks come from the
 * frozen `evaluateCohortProgress`; this layer additionally requires an
 * authenticated, seal-bound attestation for every completed attempt.
 */
export function evaluateSealedCohortProgress({ plan, attempts, seal, authority, attestations = [] }) {
  if (!plan || plan.recordType !== 'r4_cohort_plan') fail('R4_PLAN_INVALID');
  if (!seal || typeof seal.fingerprint !== 'string') fail('R4_PLAN_SEAL_INVALID');
  if (plan.sealFingerprint !== seal.fingerprint) fail('R4_PLAN_SEAL_MISMATCH');
  if (plan.preregistrationDigest !== seal.preregistration?.sha256) fail('R4_PLAN_PREREGISTRATION_MISMATCH');
  if (plan.spec?.targetCompletedSessions !== R4_SPEC.cohort.targetCompletedSessions) fail('R4_PLAN_SPEC_MISMATCH');
  if (plan.spec?.maxAttempts !== R4_SPEC.cohort.maxAttempts) fail('R4_PLAN_SPEC_MISMATCH');
  // Frozen structural + membership hardening (throws on duplicate/excluded/late).
  const progress = evaluateCohortProgress(plan, attempts);
  const expectedCaptureSpec = captureSpecDigest();
  const byFingerprint = new Map();
  for (const attestation of Array.isArray(attestations) ? attestations : []) {
    if (attestation && typeof attestation.fingerprint === 'string') byFingerprint.set(attestation.fingerprint, attestation);
  }
  for (const attempt of attempts) {
    if (attempt.status !== 'COMPLETED') continue;
    const fingerprint = attempt.attestationFingerprint;
    if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) fail('R4_ATTEMPT_NOT_AUTHENTICATED');
    const attestation = byFingerprint.get(fingerprint);
    if (!attestation) fail('R4_ATTEMPT_ATTESTATION_NOT_FOUND');
    const proof = verifySessionAttestation({
      attestation, session: { sessionId: attempt.sessionId, fingerprint: attestation.sessionFingerprint },
      seal, authority, attemptIndex: attempt.index,
    });
    if (proof.sessionId !== attempt.sessionId) fail('R4_ATTEMPT_SESSION_MISMATCH');
    if (attestation.captureSpecDigest !== expectedCaptureSpec) fail('R4_ATTEMPT_CAPTURE_SPEC_MISMATCH');
    if (attestation.sealFingerprint !== seal.fingerprint) fail('R4_ATTEMPT_SEAL_MISMATCH');
    if (attestation.protocolCommit !== seal.protocolCommit) fail('R4_ATTEMPT_PROTOCOL_COMMIT_MISMATCH');
    if (attestation.authorityCommit !== authority.sealAuthorityCommit) fail('R4_ATTEMPT_AUTHORITY_COMMIT_MISMATCH');
  }
  return { ...progress, authenticatedMembership: progress.membership, captureSpecDigest: expectedCaptureSpec };
}

export function planSealedCohort({ seal, sealCommittedAt, attemptCount = R4_SPEC.cohort.maxAttempts }) {
  if (!seal || typeof seal.fingerprint !== 'string') fail('R4_PLAN_SEAL_INVALID');
  if (attemptCount !== R4_SPEC.cohort.maxAttempts) fail('R4_PLAN_ATTEMPT_COUNT_INVALID');
  if (!Number.isSafeInteger(sealCommittedAt) || sealCommittedAt < 0) fail('R4_PLAN_SEAL_COMMIT_TIME_INVALID');
  return buildCohortPlan({ sealFingerprint: seal.fingerprint, preregistrationDigest: seal.preregistration.sha256,
    sealCommittedAt });
}

/* ------------------------------------------------- canonical references */

/** Deterministic digest of a canonical `{sessionId, snapshotDigest}` reference list. */
export function referenceSetDigest(references) {
  if (!Array.isArray(references) || references.length === 0) fail('R4_REFERENCE_SET_INVALID');
  return digest(references.map(reference => ({ sessionId: reference.sessionId, snapshotDigest: reference.snapshotDigest })));
}

/**
 * Build the canonical reference set for real R4. The caller may only supply the
 * authenticated eligible source sessions selected by the cohort governor — never
 * a reference list. ALL_ELIGIBLE_REFERENCES is run here.
 */
export function buildCanonicalReferenceSet({ sessions }) {
  if (!Array.isArray(sessions) || sessions.length === 0) fail('R4_REFERENCE_SOURCES_INVALID');
  const seen = new Set();
  for (const session of sessions) {
    if (!session || typeof session.sessionId !== 'string') fail('R4_REFERENCE_SOURCES_INVALID');
    assertR4NotExcluded(session.sessionId);
    if (session.role !== R4_COHORT_SPEC.referenceRole) fail('R4_REFERENCE_SOURCE_ROLE_INVALID');
    if (seen.has(session.sessionId)) fail('R4_DUPLICATE_SOURCE_SESSION');
    seen.add(session.sessionId);
  }
  const references = selectAllEligibleReferences(sessions);
  return { references, digest: referenceSetDigest(references), sessionIds: [...seen].sort() };
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
 * reference from the authenticated reference snapshot. A caller-supplied
 * exposure value never reaches this path: the rows are constructed here.
 */
export function certifyExposureRows({ references, sessions }) {
  if (!Array.isArray(references) || references.length === 0) fail('R4_EXPOSURE_REFERENCES_INVALID');
  const bySession = new Map();
  for (const session of Array.isArray(sessions) ? sessions : []) bySession.set(session.sessionId, session);
  const rows = references.map(reference => {
    const session = bySession.get(reference.sessionId);
    if (!session) fail('R4_EXPOSURE_SESSION_MISSING');
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
      referenceObservedAt: snapshot.snapshot.observedAt, exposureValue: exposure.value };
  });
  rows.sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0) || (a.snapshotDigest < b.snapshotDigest ? -1 : a.snapshotDigest > b.snapshotDigest ? 1 : 0));
  return { rows, digest: digest(rows) };
}

/* ------------------------------------------------- locked primary analysis */

/**
 * Canonical real-R4 primary analysis. Every scientific parameter is derived from
 * the frozen spec; the function accepts no overrides. `exposureRows` must come
 * from `certifyExposureRows`, and `outcomes` from a Policy-A outcome run over
 * the same canonical references.
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

/** Bind an outcome run to the seal, authority, cohort membership and references. */
export function buildOutcomeRunBinding({ seal, authority, cohortMembership, references, outcomeRun = null }) {
  if (!seal || typeof seal.fingerprint !== 'string') fail('R4_BINDING_SEAL_INVALID');
  if (!authority || typeof authority.sealAuthorityCommit !== 'string') fail('R4_BINDING_AUTHORITY_INVALID');
  if (!Array.isArray(cohortMembership) || cohortMembership.length === 0) fail('R4_BINDING_COHORT_INVALID');
  const content = {
    schemaVersion: 1, recordType: R4_OUTCOME_BINDING_RECORD_TYPE, ...CLASSIFICATION,
    sealFingerprint: seal.fingerprint, protocolCommit: seal.protocolCommit, protocolTree: seal.protocolTree,
    authorityCommit: authority.sealAuthorityCommit, cohortMembershipDigest: digest([...cohortMembership].sort()),
    referenceSetDigest: referenceSetDigest(references),
    sourceSessionIds: [...new Set(references.map(reference => reference.sessionId))].sort(),
    policyA: R4_SPEC.outcome.policyA, horizonMs: R4_SPEC.outcome.horizonMs, toleranceMs: R4_SPEC.outcome.toleranceMs,
    exposureField: R4_SPEC.analysis.exposureField, outcomeField: R4_SPEC.analysis.outcomeField,
    outcomeRunFingerprint: outcomeRun?.fingerprint ?? null,
  };
  return { ...content, fingerprint: digest(content) };
}

/** Reject an outcome run whose bindings do not match the seal/cohort/references. */
export function verifyOutcomeRunBinding({ binding, seal, authority, cohortMembership, references }) {
  if (!binding || binding.recordType !== R4_OUTCOME_BINDING_RECORD_TYPE || binding.schemaVersion !== 1) fail('R4_BINDING_INVALID');
  const { fingerprint, ...content } = binding;
  if (digest(content) !== fingerprint) fail('R4_BINDING_FINGERPRINT_MISMATCH');
  if (binding.sealFingerprint !== seal.fingerprint) fail('R4_BINDING_SEAL_MISMATCH');
  if (binding.protocolCommit !== seal.protocolCommit) fail('R4_BINDING_PROTOCOL_COMMIT_MISMATCH');
  if (binding.protocolTree !== seal.protocolTree) fail('R4_BINDING_PROTOCOL_TREE_MISMATCH');
  if (binding.authorityCommit !== authority.sealAuthorityCommit) fail('R4_BINDING_AUTHORITY_COMMIT_MISMATCH');
  if (binding.cohortMembershipDigest !== digest([...cohortMembership].sort())) fail('R4_BINDING_COHORT_MISMATCH');
  if (binding.referenceSetDigest !== referenceSetDigest(references)) fail('R4_BINDING_REFERENCE_SET_MISMATCH');
  if (binding.policyA !== R4_SPEC.outcome.policyA) fail('R4_BINDING_POLICY_A_MISMATCH');
  if (binding.horizonMs !== R4_SPEC.outcome.horizonMs || binding.toleranceMs !== R4_SPEC.outcome.toleranceMs) fail('R4_BINDING_OUTCOME_CONSTANT_MISMATCH');
  return { ok: true, fingerprint: binding.fingerprint };
}

/* ------------------------------------------------------------------ misc */

export { R4_EXCLUSIONS, isR4Excluded, captureSpecDigest, mechanicalT0, R4_SOURCE_POLICY };
