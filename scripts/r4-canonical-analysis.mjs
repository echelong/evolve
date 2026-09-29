// R4 single canonical production analysis orchestrator (enforcement only).
//
// `runCanonicalR4Analysis` is the ONLY supported way to produce a real R4
// primary analysis. It performs, in order:
//
//   1. INDEPENDENTLY resolve and verify the authority chain P -> S -> A from Git
//      (`resolveR4ExecutionAuthority({ requireApproval: true })`: canonical seal,
//      S shape, approval binding, A's direct parent S, approval-only diff, LIVE
//      remote main == A, HEAD == A, worktree integrity, T0 from A);
//   2. load and authenticate the canonical attempt history from the evidence
//      root, derive the cohort plan, attempts and attestations from it, and
//      derive the canonical cohort membership (evaluator OUTPUT, never input);
//   3. reload each member from authenticated evidence on disk;
//   4. build/verify the canonical ALL_ELIGIBLE_REFERENCES set;
//   5. verify the outcome-run binding against the INTERNALLY resolved authority —
//      `verifyOutcomeRunBinding` can never be bypassed before the analysis;
//   6. verify the exact sourceSessionIds against canonical membership;
//   7. derive/certify exposures from authenticated evidence;
//   8. run the locked primary analysis (no overrides, no unknown options);
//   9. bind the result to seal/cohort/reference/outcome identities.
//
// Round 3 (P1-3): the caller can no longer supply authority. `authorityResolution`,
// `stage`, an approval SHA, T0, a seal/authority object, a plan, attempt records,
// attestations or a session reader are REJECTED as inputs. The caller may supply
// only concrete locations (repository root, evidence root, outcome-run directory)
// and the outcome binding/outcomes, all of which are then authenticated against
// the authority this function resolved itself.
//
// Low-level helpers remain importable for synthetic tests, but none of them is
// this entrypoint: a caller that skips a step simply cannot produce the result
// object this function returns.
import { digest } from './market-intelligence/definition.mjs';
import { verifyOutcomeRun } from './market-outcomes/index.mjs';
import {
  deriveCanonicalCohortMembership, buildCanonicalReferenceSetFromEvidence, certifyExposureRowsFromEvidence,
  verifyOutcomeRunBinding, verifyCanonicalReferenceSet, runRealR4PrimaryAnalysis, planSealedCohort, R4_SESSION_DIR_ROOT,
  R4_ANALYSIS_RECORD_TYPE,
} from './r4-enforcement.mjs';
import { R4_AUTHORIZATION_CHAIN } from './r4-attestation.mjs';
import { R4_SPEC } from './r4-protocol-spec.mjs';
import { R4_REPO_ROOT } from './r4-authority.mjs';
import { resolveR4ExecutionAuthority } from './r4-approval.mjs';
import { loadR4AttemptHistory, verifyR4AttemptHistory, historyToCohortAttempts, historyAttestations } from './r4-attempt-history.mjs';

export { R4_ANALYSIS_RECORD_TYPE, R4_AUTHORIZATION_CHAIN };

const fail = code => { throw new Error(code); };

/** Authority facts and history a caller may never supply to the canonical path. */
export const R4_CANONICAL_ANALYSIS_FORBIDDEN_INPUTS = Object.freeze([
  'authorityResolution', 'stage', 'approvalCommit', 'approvalAuthority', 'approvalFingerprint', 'approval', 'authority', 'seal', 't0',
  'plan', 'attempts', 'attestations', 'readSession', 'sessionRoot', 'cwd',
]);
const FORBIDDEN = new Set(R4_CANONICAL_ANALYSIS_FORBIDDEN_INPUTS);
/** Locations and outcome evidence only; every one is authenticated below. */
export const R4_CANONICAL_ANALYSIS_INPUTS = Object.freeze([
  'repoRoot', 'evidenceRoot', 'outcomeRunBinding', 'outcomeRunDir', 'outcomes', 'readOutcomes', 'references',
]);
const ALLOWED = new Set(R4_CANONICAL_ANALYSIS_INPUTS);

export function runCanonicalR4Analysis(options = {}) {
  if (!options || typeof options !== 'object') fail('R4_CANONICAL_ANALYSIS_OPTIONS_INVALID');
  for (const key of Object.keys(options)) {
    if (FORBIDDEN.has(key)) fail(`R4_CANONICAL_ANALYSIS_AUTHORITY_INPUT_FORBIDDEN:${key}`);
    if (!ALLOWED.has(key)) fail(`R4_CANONICAL_ANALYSIS_UNKNOWN_OPTION:${key}`);
  }
  const {
    repoRoot = R4_REPO_ROOT, evidenceRoot = repoRoot, outcomeRunBinding, outcomeRunDir = null, outcomes = null,
    readOutcomes = null, references = null,
  } = options;

  // 1. authority chain, resolved and verified HERE from Git -------------------
  const resolution = resolveR4ExecutionAuthority({ cwd: repoRoot, requireApproval: true });
  if (resolution.stage !== 'A') fail('R4_CANONICAL_ANALYSIS_REQUIRES_APPROVAL_AUTHORITY');
  const { seal, authority } = resolution;
  // MISSED ATTEMPT-1 WINDOW GOVERNANCE AMENDMENT: the resolved approval EPOCH is
  // carried with the authority so every downstream binding (plan, attestation,
  // outcome-run binding and this result's identity) binds the actual epoch under
  // which attempt 1 began. A later approval epoch can therefore never rewrite
  // which approval governed an existing capture.
  const approvalAuthority = Object.freeze({ approvalCommit: resolution.approvalCommit,
    approvalEpoch: resolution.approvalEpoch ?? null, approvalFingerprint: resolution.approvalFingerprint ?? null,
    t0: resolution.t0 });

  // 2. authenticated attempt history -> canonical cohort membership ----------
  const verifiedHistory = verifyR4AttemptHistory(loadR4AttemptHistory({ cwd: evidenceRoot }), {
    seal, authority, approvalCommit: approvalAuthority.approvalCommit, approvalEpoch: approvalAuthority.approvalEpoch,
    approvalFingerprint: approvalAuthority.approvalFingerprint, t0: approvalAuthority.t0 });
  const plan = planSealedCohort({ seal, approvalAuthority });
  const attempts = historyToCohortAttempts(verifiedHistory);
  const attestations = historyAttestations(verifiedHistory);
  const { canonicalMembership } = deriveCanonicalCohortMembership({ plan, attempts, seal, authority, attestations, approvalAuthority });
  if (canonicalMembership.length === 0) fail('R4_CANONICAL_MEMBERSHIP_EMPTY');

  // 3 + 4. reload authenticated evidence, build canonical references --------
  const canonicalSet = buildCanonicalReferenceSetFromEvidence({
    seal, authority, approvalAuthority, canonicalMembership, attestations, sessionRoot: R4_SESSION_DIR_ROOT, cwd: evidenceRoot,
  });
  if (references !== null) verifyCanonicalReferenceSet({ references, canonicalReferences: canonicalSet.references });

  // 5. canonical outcome-run binding against the INTERNAL authority ---------
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
    references: canonicalSet.references, attestations, sessionRoot: R4_SESSION_DIR_ROOT, cwd: evidenceRoot });

  // 8. locked primary analysis ---------------------------------------------
  const analysis = runRealR4PrimaryAnalysis({ exposureRows: exposure.rows, outcomes: resolvedOutcomes, seal });

  // 9. bind identities ------------------------------------------------------
  const identity = {
    schemaVersion: 1, recordType: 'r4_canonical_analysis_result', interface: 'R4_CANONICAL_ANALYSIS',
    authorizationChain: R4_AUTHORIZATION_CHAIN, authoritySource: 'RESOLVED_FROM_GIT_LIVE_REMOTE',
    sealFingerprint: seal.fingerprint, protocolCommit: seal.protocolCommit, protocolTree: seal.protocolTree,
    authorityCommit: authority.sealAuthorityCommit, approvalCommit: resolution.approvalCommit,
    approvalEpoch: resolution.approvalEpoch ?? null, approvalFingerprint: resolution.approvalFingerprint ?? null,
    liveRemoteMain: resolution.remoteSha,
    t0: resolution.t0, attemptsUsed: verifiedHistory.attemptsUsed,
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
