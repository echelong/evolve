// R4 single canonical production analysis orchestrator (enforcement only).
//
// `runCanonicalR4Analysis` is the ONLY supported way to produce a real R4
// primary analysis. It performs, in order:
//
//   1. load/verify the authority chain (P -> S -> A);
//   2. verify the canonical cohort membership (evaluator OUTPUT, never input);
//   3. reload each member from authenticated evidence on disk;
//   4. build/verify the canonical ALL_ELIGIBLE_REFERENCES set;
//   5. load/verify the canonical outcome-run binding — `verifyOutcomeRunBinding`
//      can never be bypassed before the primary analysis;
//   6. verify the exact sourceSessionIds against canonical membership;
//   7. derive/certify exposures from authenticated evidence;
//   8. run the locked primary analysis (no overrides, no unknown options);
//   9. bind the result to seal/cohort/reference/outcome identities.
//
// Low-level helpers remain importable for synthetic tests, but none of them is
// this entrypoint: a caller that skips a step simply cannot produce the result
// object this function returns.
import { digest } from './market-intelligence/definition.mjs';
import { verifyOutcomeRun } from './market-outcomes/index.mjs';
import {
  deriveCanonicalCohortMembership, buildCanonicalReferenceSetFromEvidence, certifyExposureRowsFromEvidence,
  verifyOutcomeRunBinding, verifyCanonicalReferenceSet, runRealR4PrimaryAnalysis, R4_SESSION_DIR_ROOT,
  R4_ANALYSIS_RECORD_TYPE,
} from './r4-enforcement.mjs';
import { R4_AUTHORIZATION_CHAIN } from './r4-attestation.mjs';
import { R4_SPEC } from './r4-protocol-spec.mjs';

export { R4_ANALYSIS_RECORD_TYPE, R4_AUTHORIZATION_CHAIN };

const fail = code => { throw new Error(code); };

export function runCanonicalR4Analysis({
  authorityResolution, plan, attempts, attestations = [], references = null,
  outcomeRunBinding, outcomeRunDir = null, outcomes = null,
  sessionRoot = R4_SESSION_DIR_ROOT, cwd = process.cwd(), readSession = undefined,
  readOutcomes = null,
} = {}) {
  // 1. authority chain -------------------------------------------------------
  if (!authorityResolution || authorityResolution.stage !== 'A') fail('R4_CANONICAL_ANALYSIS_REQUIRES_APPROVAL_AUTHORITY');
  const { seal, authority } = authorityResolution;
  const approvalAuthority = authorityResolution;
  if (approvalAuthority.approvalCommit == null || !Number.isSafeInteger(approvalAuthority.t0)) fail('R4_CANONICAL_ANALYSIS_REQUIRES_APPROVAL_AUTHORITY');

  // 2. canonical cohort membership (evaluator output) -----------------------
  const { canonicalMembership } = deriveCanonicalCohortMembership({ plan, attempts, seal, authority, attestations, approvalAuthority });
  if (canonicalMembership.length === 0) fail('R4_CANONICAL_MEMBERSHIP_EMPTY');

  // 3 + 4. reload authenticated evidence, build canonical references --------
  const canonicalSet = buildCanonicalReferenceSetFromEvidence({
    seal, authority, approvalAuthority, canonicalMembership, attestations, sessionRoot, cwd,
    ...(readSession ? { readSession } : {}),
  });
  if (references !== null) verifyCanonicalReferenceSet({ references, canonicalReferences: canonicalSet.references });

  // 5. canonical outcome-run binding (never bypassable) ---------------------
  if (!outcomeRunBinding) fail('R4_CANONICAL_ANALYSIS_OUTCOME_BINDING_REQUIRED');
  const bindingProof = verifyOutcomeRunBinding({ binding: outcomeRunBinding, seal, authority, approvalAuthority,
    cohortMembership: canonicalMembership, references: canonicalSet.references });
  if (!Array.isArray(bindingProof.sourceSessionIds) || bindingProof.sourceSessionIds.length === 0) fail('R4_CANONICAL_ANALYSIS_SOURCE_SESSION_IDS_MISSING');

  // 6 + outcome evidence load ----------------------------------------------
  let resolvedOutcomes = outcomes;
  let outcomeManifest = null;
  if (outcomeRunDir !== null) {
    outcomeManifest = verifyOutcomeRun(outcomeRunDir);
    resolvedOutcomes = readOutcomes ? readOutcomes(outcomeRunDir) : null;
    if (!Array.isArray(resolvedOutcomes)) fail('R4_CANONICAL_ANALYSIS_OUTCOME_READER_REQUIRED');
  }
  if (!Array.isArray(resolvedOutcomes) || resolvedOutcomes.length === 0) fail('R4_CANONICAL_ANALYSIS_OUTCOMES_REQUIRED');

  // 7. certified exposures from authenticated evidence ----------------------
  const exposure = certifyExposureRowsFromEvidence({ seal, authority, approvalAuthority, canonicalMembership,
    references: canonicalSet.references, attestations, sessionRoot, cwd, ...(readSession ? { readSession } : {}) });

  // 8. locked primary analysis ---------------------------------------------
  const analysis = runRealR4PrimaryAnalysis({ exposureRows: exposure.rows, outcomes: resolvedOutcomes, seal });

  // 9. bind identities ------------------------------------------------------
  const identity = {
    schemaVersion: 1, recordType: 'r4_canonical_analysis_result', interface: 'R4_CANONICAL_ANALYSIS',
    authorizationChain: R4_AUTHORIZATION_CHAIN, sealFingerprint: seal.fingerprint,
    protocolCommit: seal.protocolCommit, protocolTree: seal.protocolTree, authorityCommit: authority.sealAuthorityCommit,
    approvalCommit: approvalAuthority.approvalCommit, t0: approvalAuthority.t0,
    canonicalMembership: [...canonicalMembership].sort(),
    canonicalMembershipDigest: digest([...canonicalMembership].sort()),
    referenceSetDigest: canonicalSet.digest, exposureRowsDigest: digest(exposure.rows),
    outcomeBindingFingerprint: outcomeRunBinding.fingerprint,
    outcomeRunFingerprint: outcomeManifest?.fingerprint ?? outcomeRunBinding.outcomeRunFingerprint ?? null,
    sourceSessionIds: bindingProof.sourceSessionIds,
    analysisRecordType: R4_ANALYSIS_RECORD_TYPE, analysisSpecVersion: R4_SPEC.analysis.specVersion,
  };
  return { analysis, exposureRows: exposure.rows, references: canonicalSet.references,
    canonicalMembership: [...canonicalMembership].sort(), sessions: canonicalSet.sessions, identity,
    recordType: identity.recordType };
}
