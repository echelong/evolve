// R4 LIFECYCLE CLOSURE (governance metadata only).
//
// PURPOSE. R4_FINALIZED_AND_ARCHIVED: a single write-once record stating that the
// canonical R4 round is finished and durably archived. It is NOT scientific
// authority, NOT new science, NOT another analysis, NOT A3, NOT C2 and NOT a
// reseal. Scientific authority remains the sealed R4 code plus the retained
// evidence plus the immutable result attestation.
//
// NON-SELECTION. This module NEVER computes, re-derives, re-estimates or chooses
// a scientific result. Every scientific value it records is COPIED MECHANICALLY
// from the immutable result attestation and is then re-checked against that same
// artifact on every verification. There is no estimator, no seed, no bootstrap,
// no retry and no fallback path here. It is impossible for this file to alter or
// select a result: it cannot compute one at all.
//
// SCOPE. Lifecycle/governance metadata only: it binds the frozen authority chain
// (A2 / S6 / C1 / T0), the cohort and outcome identities, the archival C1
// reproduction environment, the frozen evidence inventory and the attested result,
// and it declares the live re-derivation window closed. It grants no trading,
// engine, Arena, promotion or profitability-inference authority.
import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdtempSync, mkdirSync, openSync, closeSync, fsyncSync, readFileSync,
  readdirSync, rmSync, writeSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonical, digest } from './market-intelligence/definition.mjs';
import { R4_REQUIRED_BOUND_FILES } from './r4-protocol-spec.mjs';
import {
  R4_ARCHIVE_PATH, R4_CLAIM_FILE as ATTEST_CLAIM_FILE, R4_OUTCOME_AUTHORIZATION_PATH, R4_OUTCOME_ROOT, R4_PREP_DIR,
  R4_REVIEW_FILE as ATTEST_REVIEW_FILE, R4_RESULT_FILE as ATTEST_RESULT_FILE, productionContext as attestationProductionContext,
  sealRecord, verifyArchiveManifest, verifyArchiveRepo, verifyAttestation, verifyFrozenInventory,
  verifyOutcomeRunIdentity, writeOnce,
} from './r4-result-attestation.mjs';

const SELF = fileURLToPath(import.meta.url);
export const R4_FINALIZER_REPO_ROOT = path.resolve(path.dirname(SELF), '..');
/* ------------------------------------------------- durable pre-closure identities */
// Every value here is a PRE-closure fact: an authority commit/fingerprint, a cohort
// or outcome identity, an archive/inventory fact, or an attestation fingerprint.
// No scientific RESULT value is ever a constant here. `referenceCount` and
// `attemptsUsed` are pre-analysis cohort identities (fixed before any outcome or
// result existed), used only to cross-check what the attestation reports.
export const R4_CLOSURE_CONSTANTS = Object.freeze({
  c1Commit: '1c30264fb87876eeaf229e25c5cdc5adca429b40',
  c1Fingerprint: 'b2ebb644f4a768d0ec84829c43848310b3db67b450190a1d0007be03efa0ec5c',
  a2Commit: '9dc30de45ee0fc8c493c2582bae6378dae1fdc7b',
  a2Epoch: 2,
  a2Fingerprint: 'a177be24986b0dfe511b40d16346a14b71c097db347f6d98fd622fa5d893c60d',
  s6Commit: 'f6583433eba00de1558a9f0c4845e1e7905e9877',
  s6Fingerprint: 'f4bda437fb48e1782fe7a42c9683b87dd5d3c15cb503b9099bc424ed6fbfc0c4',
  t0: 1790690400000,
  attemptsUsed: 6,
  referenceCount: 3516,
  canonicalMembershipDigest: '7f5de0d51021e2446fcdf0ee4580a56043b8841a05171fd716cfe593faf7418b',
  referenceSetDigest: '08fcf8b6f3a6d9d5498d41c981682185587204e9f648d8190ca42972027cbf94',
  outcomeAuthorizationFingerprint: '958f1c9de87339ceae6c5e15dc315d7c628d0db2a8c635ebd334f4336f6ff7ff',
  outcomeRunId: 'r4-outcome-0001-0126e75ca6d779f6016486e799546385',
  outcomeRunFingerprint: '73deb08124aa5bfce00ca227109a75c353ae52d2247c5768c3f0d7e8df640d58',
  outcomeBindingFingerprint: '78e7dfd27745a00b9d08701bf97bfac54d13446090165557fc886f92866354e9',
  archiveManifestFingerprint: '7b61a3be9fd8ec0252bb52698fcd659d427bcdc60e0fa9254aac4ee8243a023d',
  evidenceInventoryFileCount: 109,
  evidenceInventoryTotalBytes: 3144793956,
  evidenceInventoryDigest: '40ed7c4a0686d7257cd270a08d7dd70513e7f83e852a895caed0692d920f771d',
  resultAttestationReviewFingerprint: 'e8d4f17655f6fa4bc5aa13c943fc330320fbfefef99fab5fbaadd8f62c919863',
  resultAttestationClaimFingerprint: 'd618a22b5f5614b1c638c2edfd721fb44d6c6f6536cd1a6d905c328d6a3eb1c1',
  resultAttestationFingerprint: '4352e054dd2f2f35df40c69577b7bb72b4ec96c887d8ec6e664f8b078a458b55',
  resultIdentityDigest: '480dc0fcb60c796d62307457270df1f2b4205f60862458e2bb4a85992dd7f65d',
  resultAnalysisDigest: '52939d34fb8ef17294fcc9306b11f63130fce0b2e61ed7ddcf05c818da27ca78',
});

export const R4_ATTESTATION_DIR = '.evolve/governance/r4-result-attestations';
export const R4_FINALIZATION_DIR = '.evolve/governance/r4-finalization';
export const R4_FINALIZATION_REVIEW_FILE = 'finalization-0001.review.json';
export const R4_FINALIZATION_FILE = 'finalization-0001.json';
export const R4_CLOSURE_STATUS = 'R4_FINALIZED_AND_ARCHIVED';
/** Pre-closure readiness wording. NEVER claims R4 is finalized. */
export const R4_PRECONDITION_STATUS = 'READY_TO_CLOSE_R4';
export const R4_CLOSURE_REASON = 'CANONICAL_R4_COMPLETE_POST_OUTCOME_POST_ANALYSIS_ATTESTATION';
export const R4_REVIEW_VERDICT = 'READY_TO_CLOSE_R4';
export const R4_REPRODUCTION_MODE = 'ARCHIVED_C1_REMOTE';
export const R4_OUTCOME_CONSUMPTION_PATH =
  '.evolve/governance/r4-outcome-authorizations/outcome-authorization-0001.consumption.json';
export const R4_OUTCOME_MANIFEST_FILE = 'manifest.json';

/**
 * The four outcome identities of the closure record, and the AUTHENTICATED disk
 * artifact each one is derived from. `attestationIdentity: true` means the value
 * also has to be present in the immutable result-attestation identity block.
 * `onDisk: null` means the value exists ONLY inside the immutable attestation
 * (the binding fingerprint is a derived join, not a persisted standalone file),
 * so the attestation plus the frozen constants are its only two sources.
 * No field is invented: each entry names a real record already on disk.
 */
export const R4_OUTCOME_IDENTITY_SOURCES = Object.freeze({
  outcomeAuthorizationFingerprint: Object.freeze({
    onDisk: 'OUTCOME_AUTHORIZATION', attestationIdentity: false, hex: true,
  }),
  outcomeRunId: Object.freeze({ onDisk: 'OUTCOME_AUTHORIZATION', attestationIdentity: false, hex: false }),
  outcomeRunFingerprint: Object.freeze({
    onDisk: 'OUTCOME_MANIFEST', attestationIdentity: true, hex: true,
  }),
  outcomeBindingFingerprint: Object.freeze({ onDisk: null, attestationIdentity: true, hex: true }),
});
/** The four closure outcome-identity keys, in closed-schema order. */
export const R4_OUTCOME_IDENTITY_KEYS = Object.freeze(Object.keys(R4_OUTCOME_IDENTITY_SOURCES));
/** Closed schema of the lifecycle closure record. No field may be added or removed. */
export const R4_FINALIZATION_KEYS = Object.freeze([
  'schemaVersion', 'recordType', 'status', 'closureReason',
  'a2Commit', 'a2Epoch', 'a2Fingerprint', 's6Commit', 's6Fingerprint', 'c1Commit', 'c1Fingerprint', 't0',
  'authorityStage', 'headAtClosure', 'originMainAtClosure',
  'attemptsUsed', 'completedCount', 'canonicalMembership', 'canonicalMembershipDigest',
  'referenceCount', 'referenceSetDigest',
  'outcomeAuthorizationFingerprint', 'outcomeRunId', 'outcomeRunFingerprint', 'outcomeBindingFingerprint',
  'archiveManifestFingerprint', 'archiveMainCommit', 'archiveVerified',
  'evidenceInventoryDigest', 'evidenceInventoryFileCount', 'evidenceInventoryTotalBytes',
  'resultAttestationReviewFingerprint', 'resultAttestationClaimFingerprint', 'resultAttestationFingerprint',
  'resultIdentityDigest', 'resultAnalysisDigest', 'finalizationReviewFingerprint',
  'analysisSpecVersion', 'availabilityDenominator', 'resolvedReferenceCount', 'distinctResolvedMintCount',
  'pointEstimate', 'ciLower', 'ciUpper', 'bootstrapReplicates', 'replicatesDefined', 'floorsMet',
  'seedDigest', 'exposureRowsDigest',
  'developmentOnly', 'researchOnly', 'paperOnly', 'observerOnly',
  'tradingAuthority', 'engineAuthority', 'arenaEligible', 'promotionEligible', 'profitabilityInferencePermitted',
  'liveRederivationWindowClosed', 'futureCanonicalReproductionMode', 'productionMainMayAdvanceAfterClosure',
  'noFurtherCanonicalR4ExecutionRequired', 'closedAt', 'closedAtIso', 'fingerprint',
]);

/** Closed schema of the external review required before the closure may be written. */
export const R4_FINALIZATION_REVIEW_KEYS = Object.freeze([
  'schemaVersion', 'recordType', 'closureGeneration', 'verdict', 'reviewerIdentity', 'reviewerModel', 'reviewedAt',
  'implementationHashes', 'archiveManifestFingerprint', 'evidenceInventoryDigest', 'c1Commit',
  'resultAttestationFingerprint', 'closureCopiesResultWithoutRecomputation', 'closureIsLifecycleMetadataOnly',
  'blockers', 'fingerprint',
]);

/** Scientific fields COPIED from the attestation. This module has no other result input. */
export const R4_COPIED_RESULT_FIELDS = Object.freeze([
  'analysisSpecVersion', 'availabilityDenominator', 'resolvedReferenceCount', 'distinctResolvedMintCount',
  'pointEstimate', 'ciLower', 'ciUpper', 'bootstrapReplicates', 'replicatesDefined', 'floorsMet',
  'seedDigest', 'exposureRowsDigest',
]);

/** Keys a caller may never influence on the real close path. */
export const R4_CLOSURE_FORBIDDEN_OVERRIDES = Object.freeze([
  'repoRoot', 'evidenceRoot', 'archive', 'c1', 'a2', 's6', 't0', 'authority', 'stage', 'membership', 'references',
  'referenceCount', 'attempts', 'completed', 'outcome', 'outcomeRun', 'outcomeBinding', 'analysis', 'analysisParameters',
  'seed', 'bootstrapCount', 'pointEstimate', 'ci', 'result', 'closure', 'closedAt', 'outputLocation',
]);

export {
  sealRecord, writeOnce, verifyArchiveRepo, verifyAttestation, verifyFrozenInventory,
  attestationProductionContext as attestationContext,
};
const fail = code => { throw new Error(code); };
const isStamp = v => Number.isSafeInteger(v) && v > 0;
const isHex = (v, n) => typeof v === 'string' && new RegExp(`^[0-9a-f]{${n}}$`).test(v);
const isCommit = v => isHex(v, 40);
const sha256Bytes = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (args, { cwd, gitDir } = {}) => execFileSync('git', gitDir ? ['--git-dir', gitDir, ...args] : args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const closedKeys = (record, keys, what) => {
  if (!record || typeof record !== 'object' || Array.isArray(record)) fail(`R4_CLOSE_${what}_NOT_OBJECT`);
  if (Object.keys(record).sort().join() !== [...keys].sort().join()) fail(`R4_CLOSE_${what}_SCHEMA_NOT_CLOSED`);
};
const checkFingerprint = (record, what) => {
  const { fingerprint, ...body } = record;
  if (!isHex(fingerprint, 64) || digest(body) !== fingerprint) fail(`R4_CLOSE_${what}_FINGERPRINT`);
};
const recordText = record => `${JSON.stringify(record, null, 2)}\n`;

const isTrue = v => v === true;
const isFalse = v => v === false;
/** Research-only flags must stay true; authority flags must stay false, forever. */
const RESEARCH_TRUE = ['developmentOnly', 'researchOnly', 'paperOnly', 'observerOnly'];
const RESEARCH_FALSE = ['tradingAuthority', 'engineAuthority', 'arenaEligible', 'promotionEligible', 'profitabilityInferencePermitted'];

/** Read an immutable 0444 record. Never creates, never repairs. */
function readRecord(file, what) {
  let st;
  try { st = lstatSync(file); } catch { fail(`R4_CLOSE_${what}_MISSING`); }
  if (!st.isFile()) fail(`R4_CLOSE_${what}_NOT_REGULAR_FILE`);
  if ((st.mode & 0o777) !== 0o444) fail(`R4_CLOSE_${what}_MODE_NOT_0444`);
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { fail(`R4_CLOSE_${what}_UNPARSEABLE`); }
}

/* --------------------------------------------------------------- context */

export function productionContext() {
  return {
    repoRoot: R4_FINALIZER_REPO_ROOT, evidenceRoot: R4_FINALIZER_REPO_ROOT, constants: R4_CLOSURE_CONSTANTS,
    attestDir: path.join(R4_FINALIZER_REPO_ROOT, R4_ATTESTATION_DIR),
    archiveDir: path.join(R4_FINALIZER_REPO_ROOT, R4_ARCHIVE_PATH),
    closureDir: path.join(R4_FINALIZER_REPO_ROOT, R4_FINALIZATION_DIR),
    boundFiles: R4_REQUIRED_BOUND_FILES,
    selfFiles: { finalizer: SELF, validator: path.join(path.dirname(SELF), 'validate-r4-finalization.mjs') },
    verifyAttestation, verifyArchiveRepo, verifyArchiveManifest, verifyFrozenInventory, verifyOutcomeRunIdentity,
    now: () => Date.now(), tmpRoot: tmpdir(),
    loadStageCModule: cloneDir => import(pathToFileURL(path.join(cloneDir, 'scripts/r4-approval.mjs')).href),
    attestationContext: () => attestationProductionContext(),
  };
}

export function selfHashes(ctx) {
  return { finalizer: sha256Bytes(readFileSync(ctx.selfFiles.finalizer)), validator: sha256Bytes(readFileSync(ctx.selfFiles.validator)) };
}

/* ------------------------------------------------------- production + archive */

/** HEAD, live origin/main and the 71 bound files, all at closure time. */
export function verifyProductionState(ctx) {
  const c = ctx.constants;
  const head = git(['rev-parse', 'HEAD'], { cwd: ctx.repoRoot });
  if (head !== c.c1Commit) fail('R4_CLOSE_PRODUCTION_HEAD_NOT_C1');
  const remoteMain = git(['ls-remote', 'origin', 'refs/heads/main'], { cwd: ctx.repoRoot }).split(/\s+/)[0];
  if (remoteMain !== c.c1Commit) fail('R4_CLOSE_PRODUCTION_REMOTE_MAIN_NOT_C1');
  if (git(['diff', '--name-only', c.c1Commit, '--', ...ctx.boundFiles], { cwd: ctx.repoRoot }) !== '') fail('R4_CLOSE_BOUND_FILES_CHANGED');
  if (git(['status', '--porcelain', '--', ...ctx.boundFiles], { cwd: ctx.repoRoot }) !== '') fail('R4_CLOSE_BOUND_FILES_DIRTY');
  return { head, originMain: remoteMain, boundFileCount: ctx.boundFiles.length };
}

/**
 * Stage C, resolved INDEPENDENTLY from a fresh temporary clone of the archival C1
 * bare repository (never from production main). This is the durable authority and
 * does not change when production main advances.
 */
function withArchiveClone(ctx, fn) {
  const dir = mkdtempSync(path.join(ctx.tmpRoot, 'r4-close-clone-'));
  const cloneDir = path.join(dir, 'c1');
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  const run = async () => {
    execFileSync('git', ['clone', '--quiet', ctx.archiveDir, cloneDir], { stdio: ['ignore', 'pipe', 'pipe'] });
    const c1 = ctx.constants.c1Commit;
    if (git(['rev-parse', 'HEAD'], { cwd: cloneDir }) !== c1) fail('R4_CLOSE_CLONE_HEAD_NOT_C1');
    if (git(['rev-parse', 'refs/remotes/origin/main'], { cwd: cloneDir }) !== c1) fail('R4_CLOSE_CLONE_ORIGIN_MAIN_NOT_C1');
    return fn(cloneDir);
  };
  return run().finally(cleanup);
}

export async function verifyArchivedStageC(ctx) {
  const c = ctx.constants;
  return withArchiveClone(ctx, async cloneDir => {
    // The authority resolver is supplied by the context: production loads it from
    // the archival clone itself; tests inject a stub. Never from production main.
    const { resolveR4ExecutionAuthority } = await ctx.loadStageCModule(cloneDir);
    const r = resolveR4ExecutionAuthority({ cwd: cloneDir, requireApproval: true });
    if (r.stage !== 'C') fail('R4_CLOSE_STAGE_NOT_C');
    if (r.approvalCommit !== c.a2Commit) fail('R4_CLOSE_A2_MISMATCH');
    if (r.approvalFingerprint !== c.a2Fingerprint) fail('R4_CLOSE_A2_FINGERPRINT_MISMATCH');
    if (r.authority.sealAuthorityCommit !== c.s6Commit) fail('R4_CLOSE_S6_MISMATCH');
    if (r.seal.fingerprint !== c.s6Fingerprint) fail('R4_CLOSE_S6_FINGERPRINT_MISMATCH');
    if (r.continuationCommit !== c.c1Commit) fail('R4_CLOSE_C1_MISMATCH');
    if (r.continuationFingerprint !== c.c1Fingerprint) fail('R4_CLOSE_C1_FINGERPRINT_MISMATCH');
    if (r.t0 !== c.t0) fail('R4_CLOSE_T0_MISMATCH');
    return { stage: r.stage, approvalCommit: r.approvalCommit, approvalEpoch: r.approvalEpoch, t0: r.t0,
      approvalFingerprint: r.approvalFingerprint, sealFingerprint: r.seal.fingerprint,
      continuationCommit: r.continuationCommit, continuationFingerprint: r.continuationFingerprint };
  });
}

/* ------------------------------------------- result attestation (read only) */

/**
 * Read the immutable generation-1 result attestation and its review + claim.
 * The attestation itself is re-verified through the sealed C1 attester (which
 * recomputes no science and runs no analysis); this module then re-reads the
 * three artifacts to COPY the result. Nothing is computed here.
 */
export function readResultAttestation(ctx) {
  const review = readRecord(path.join(ctx.attestDir, ATTEST_REVIEW_FILE), 'ATTEST_REVIEW');
  const claim = readRecord(path.join(ctx.attestDir, ATTEST_CLAIM_FILE), 'ATTEST_CLAIM');
  const result = readRecord(path.join(ctx.attestDir, ATTEST_RESULT_FILE), 'ATTEST_RESULT');
  const c = ctx.constants;
  // each artifact must be internally well-formed before its identity is trusted
  checkFingerprint(review, 'ATTEST_REVIEW');
  checkFingerprint(claim, 'ATTEST_CLAIM');
  checkFingerprint(result, 'ATTEST_RESULT');
  if (result.fingerprint !== c.resultAttestationFingerprint) fail('R4_CLOSE_ATTEST_FINGERPRINT_MISMATCH');
  if (claim.fingerprint !== c.resultAttestationClaimFingerprint) fail('R4_CLOSE_ATTEST_CLAIM_MISMATCH');
  if (review.fingerprint !== c.resultAttestationReviewFingerprint) fail('R4_CLOSE_ATTEST_REVIEW_MISMATCH');
  if (result.claimFingerprint !== claim.fingerprint || result.reviewFingerprint !== review.fingerprint) fail('R4_CLOSE_ATTEST_LINK');
  if (result.identityDigest !== c.resultIdentityDigest || result.analysisDigest !== c.resultAnalysisDigest) fail('R4_CLOSE_ATTEST_DIGEST_MISMATCH');
  if (claim.reviewFingerprint !== review.fingerprint) fail('R4_CLOSE_ATTEST_CLAIM_REVIEW_LINK');
  // chronology: review -> claim -> attestation
  if (!(review.reviewedAt <= claim.claimedAt && claim.claimedAt <= result.attestedAt)) fail('R4_CLOSE_ATTEST_CHRONOLOGY');
  return { review, claim, result };
}

/* ------------------------------------------------- outcome identity chain */
/*
 * SOURCE OF TRUTH. The four closure outcome identities are NOT taken from the
 * finalizer's constants. They are resolved MECHANICALLY from authenticated,
 * write-once records that already exist on disk, and only then compared against
 * R4_CLOSURE_CONSTANTS, which acts as an EXPECTED identity set and never as an
 * independent source of truth.
 *
 *   outcomeAuthorizationFingerprint <- outcome-authorization-0001.json.fingerprint
 *   outcomeRunId                     <- outcome-authorization-0001.json.runId
 *   outcomeRunFingerprint            <- market-outcomes/<runId>/manifest.json.fingerprint
 *   outcomeBindingFingerprint        <- (no standalone file) immutable attestation
 *                                       identity.outcomeBindingFingerprint
 *
 * Every record is re-sealed from its own bytes (its fingerprint must equal the
 * digest of its body), so a constant can never validate itself, and the
 * authorization / consumption / manifest cross-links must all agree.
 */

/**
 * Read and self-verify the immutable outcome-authorization, consumption and
 * outcome-run manifest records. Read-only: never creates, repairs or regenerates.
 * Returns the disk-resolved outcome identities plus the records themselves.
 */
/**
 * Read and self-verify the immutable outcome-authorization record. Read-only:
 * never creates, repairs or regenerates. This is the authenticated durable
 * cohort/outcome state the closure is cross-checked against.
 */
export function readOutcomeAuthorization(ctx) {
  const authz = readRecord(path.join(ctx.evidenceRoot, R4_OUTCOME_AUTHORIZATION_PATH), 'OUTCOME_AUTHORIZATION');
  checkFingerprint(authz, 'OUTCOME_AUTHORIZATION');
  if (authz.recordType !== 'r4_outcome_authorization' || authz.status !== 'AUTHORIZED') fail('R4_CLOSE_OUTCOME_AUTHORIZATION_TYPE');
  if (!isStamp(authz.issuedAt) || authz.issuedAt !== authz.createdAt) fail('R4_CLOSE_OUTCOME_AUTHORIZATION_TIME');
  if (authz.blocked !== false || typeof authz.runId !== 'string' || !authz.runId) fail('R4_CLOSE_OUTCOME_AUTHORIZATION_RUN_ID');
  return authz;
}

export function readOutcomeChain(ctx) {
  const authz = readOutcomeAuthorization(ctx);

  const consumption = readRecord(path.join(ctx.evidenceRoot, R4_OUTCOME_CONSUMPTION_PATH), 'OUTCOME_CONSUMPTION');
  checkFingerprint(consumption, 'OUTCOME_CONSUMPTION');
  if (consumption.recordType !== 'r4_outcome_authorization_consumption' || consumption.status !== 'CONSUMED') {
    fail('R4_CLOSE_OUTCOME_CONSUMPTION_TYPE');
  }

  // The run directory is NAMED by the run id, so the name is itself a binding.
  const runDir = path.join(ctx.evidenceRoot, R4_OUTCOME_ROOT, authz.runId);
  if (path.basename(runDir) !== authz.runId) fail('R4_CLOSE_OUTCOME_RUN_ID_PATH');
  const manifest = readRecord(path.join(runDir, R4_OUTCOME_MANIFEST_FILE), 'OUTCOME_MANIFEST');
  checkFingerprint(manifest, 'OUTCOME_MANIFEST');
  if (manifest.recordType !== 'outcome_manifest') fail('R4_CLOSE_OUTCOME_MANIFEST_TYPE');

  // cross-links: consumption -> authorization, manifest -> run id + authorization
  if (consumption.runId !== authz.runId) fail('R4_CLOSE_OUTCOME_CONSUMPTION_RUN_ID');
  if (consumption.authorizationFingerprint !== authz.fingerprint) fail('R4_CLOSE_OUTCOME_CONSUMPTION_AUTHORIZATION');
  if (manifest.runId !== authz.runId) fail('R4_CLOSE_OUTCOME_MANIFEST_RUN_ID');
  if (manifest.sealedCode?.authorizationFingerprint !== authz.fingerprint) fail('R4_CLOSE_OUTCOME_MANIFEST_AUTHORIZATION');
  if (consumption.outcomeRunFingerprint !== manifest.fingerprint) fail('R4_CLOSE_OUTCOME_CONSUMPTION_RUN_FINGERPRINT');
  if (consumption.outcomeManifestFingerprint !== manifest.fingerprint) fail('R4_CLOSE_OUTCOME_CONSUMPTION_MANIFEST_FINGERPRINT');
  if (!(authz.issuedAt <= consumption.consumedAt)) fail('R4_CLOSE_OUTCOME_CONSUMPTION_CHRONOLOGY');

  // Independent re-derivation of the outcome run by the sealed C1 attester: it
  // re-reads the outcome bytes and recomputes the manifest identity. Runs no
  // analysis and generates nothing.
  const attCtx = ctx.attestationContext();
  const verified = ctx.verifyOutcomeRunIdentity(attCtx, attCtx.verifyOutcomeRun);
  if (verified.runId !== authz.runId || verified.fingerprint !== manifest.fingerprint) fail('R4_CLOSE_OUTCOME_RUN_NOT_INDEPENDENTLY_VERIFIED');
  if (verified.sealedCode?.authorizationFingerprint !== authz.fingerprint) fail('R4_CLOSE_OUTCOME_AUTHORIZATION_NOT_INDEPENDENTLY_VERIFIED');

  return {
    outcomeAuthorizationFingerprint: authz.fingerprint,
    outcomeRunId: authz.runId,
    outcomeRunFingerprint: manifest.fingerprint,
    authorization: authz, consumption, manifest,
  };
}

/**
 * Resolve the four closure outcome identities from their authenticated sources
 * and require them to agree with the immutable attestation AND with the durable
 * expected identities. Fails closed on the first disagreement.
 */
export function resolveOutcomeIdentities(att, ctx) {
  const chain = readOutcomeChain(ctx);
  const c = ctx.constants;
  const { identity } = att.result;
  // A. the disk-resolved identity for each key that HAS a disk artifact
  const fromDisk = {
    outcomeAuthorizationFingerprint: chain.outcomeAuthorizationFingerprint,
    outcomeRunId: chain.outcomeRunId,
    outcomeRunFingerprint: chain.outcomeRunFingerprint,
  };
  // B. the immutable attestation view of the same keys
  const fromAttestation = {
    outcomeAuthorizationFingerprint: att.result.outcomeAuthorizationFingerprint,
    outcomeRunId: att.result.outcomeRunId,
    outcomeRunFingerprint: att.result.outcomeRunFingerprint,
    outcomeBindingFingerprint: att.result.outcomeBindingFingerprint,
  };
  for (const key of R4_OUTCOME_IDENTITY_KEYS) {
    const spec = R4_OUTCOME_IDENTITY_SOURCES[key];
    if (spec.hex && !isHex(fromAttestation[key], 64)) fail(`R4_CLOSE_OUTCOME_IDENTITY_NOT_HEX:${key}`);
    // the attestation identity block must carry the key where the schema says it does
    if (spec.attestationIdentity && identity[key] !== fromAttestation[key]) fail(`R4_CLOSE_OUTCOME_IDENTITY_ATTEST_SPLIT:${key}`);
    // disk <-> attestation
    if (spec.onDisk && fromDisk[key] !== fromAttestation[key]) fail(`R4_CLOSE_OUTCOME_IDENTITY_DISK_ATTEST_MISMATCH:${key}`);
    // disk/attestation <-> durable expected identity (a constant never self-validates)
    if (fromAttestation[key] !== c[key]) fail(`R4_CLOSE_OUTCOME_IDENTITY_CONSTANT_MISMATCH:${key}`);
  }
  // the binding fingerprint has no standalone file: the attestation IS its source
  const resolved = {
    outcomeAuthorizationFingerprint: fromDisk.outcomeAuthorizationFingerprint,
    outcomeRunId: fromDisk.outcomeRunId,
    outcomeRunFingerprint: fromDisk.outcomeRunFingerprint,
    outcomeBindingFingerprint: fromAttestation.outcomeBindingFingerprint,
  };
  for (const key of R4_OUTCOME_IDENTITY_KEYS) {
    if (resolved[key] !== fromAttestation[key] || resolved[key] !== c[key]) fail(`R4_CLOSE_OUTCOME_IDENTITY_UNRESOLVED:${key}`);
  }
  return { ...resolved, chain };
}

/**
 * Copy the scientific result MECHANICALLY out of the attestation. This is a pure
 * projection: it reads fields and returns them. It performs no arithmetic, no
 * estimation and no selection. Classification flags are copied too and then
 * re-asserted by assertClosure, so a closure can never widen authority.
 */
export function copyScientificResult(att) {
  const { identity, analysis } = att.result;
  if (!identity || typeof identity !== 'object' || !analysis || typeof analysis !== 'object') fail('R4_CLOSE_ATTEST_SCIENTIFIC_PORTIONS_MISSING');
  return {
    analysisSpecVersion: analysis.specVersion,
    availabilityDenominator: analysis.availabilityDenominator,
    resolvedReferenceCount: analysis.resolvedReferenceCount,
    distinctResolvedMintCount: analysis.distinctResolvedMintCount,
    pointEstimate: analysis.pointEstimate,
    ciLower: analysis.ciLower,
    ciUpper: analysis.ciUpper,
    bootstrapReplicates: analysis.bootstrapReplicates,
    replicatesDefined: analysis.replicatesDefined,
    floorsMet: analysis.floorsMet,
    seedDigest: analysis.seedDigest,
    exposureRowsDigest: analysis.exposureRowsDigest,
    developmentOnly: analysis.developmentOnly,
    researchOnly: analysis.researchOnly,
    paperOnly: analysis.paperOnly,
    observerOnly: analysis.observerOnly,
    tradingAuthority: analysis.tradingAuthority,
    engineAuthority: analysis.engineAuthority,
    arenaEligible: analysis.arenaEligible,
    promotionEligible: analysis.promotionEligible,
    profitabilityInferencePermitted: analysis.profitabilityInferencePermitted,
  };
}

/** Cohort identities, also read from the attestation identity (never invented). */
export function copyCohortIdentity(att, ctx) {
  const { identity, analysis } = att.result;
  const membership = identity.canonicalMembership;
  if (!Array.isArray(membership) || membership.length === 0) fail('R4_CLOSE_ATTEST_MEMBERSHIP_MISSING');
  if (canonical([...membership].sort()) !== canonical(membership)) fail('R4_CLOSE_ATTEST_MEMBERSHIP_NOT_SORTED');
  const referenceCount = analysis.availabilityDenominator;
  // LIFECYCLE BOOKKEEPING ONLY (no science). The two counts are derived from
  // DISTINCT attestation fields and are not aliases of one another:
  //   attemptsUsed    = how many canonical attempts the cohort consumed
  //   completedCount  = how many canonical sessions are in the membership
  // They are required to be equal here, and that equality is asserted explicitly
  // rather than being implied by assigning one from the other.
  const attemptsUsed = identity.attemptsUsed;
  const completedCount = identity.canonicalMembership.length;
  if (!isStamp(attemptsUsed) || !Number.isSafeInteger(completedCount) || completedCount === 0) fail('R4_CLOSE_COHORT_COUNTS_MISSING');
  if (attemptsUsed !== ctx.constants.attemptsUsed) fail('R4_CLOSE_COHORT_ATTEMPTS_MISMATCH');
  if (completedCount !== ctx.constants.attemptsUsed) fail('R4_CLOSE_COHORT_COMPLETED_COUNT_MISMATCH');
  if (attemptsUsed !== completedCount) fail('R4_CLOSE_COHORT_ATTEMPTS_NOT_COMPLETED');
  // Cross-check against the durable PRE-analysis cohort identities.
  if (referenceCount !== ctx.constants.referenceCount) fail('R4_CLOSE_COHORT_REFERENCE_COUNT_MISMATCH');
  if (digest([...membership].sort()) !== identity.canonicalMembershipDigest) fail('R4_CLOSE_COHORT_MEMBERSHIP_DIGEST_MISMATCH');
  if (identity.canonicalMembershipDigest !== ctx.constants.canonicalMembershipDigest) fail('R4_CLOSE_COHORT_MEMBERSHIP_DIGEST_CONSTANT');
  if (identity.referenceSetDigest !== ctx.constants.referenceSetDigest) fail('R4_CLOSE_COHORT_REFERENCE_SET_DIGEST_CONSTANT');
  // Cross-check the same lifecycle state against the AUTHENTICATED durable
  // outcome-authorization record, not against the constants alone.
  const authz = readOutcomeAuthorization(ctx);
  if (authz.attemptsUsed !== attemptsUsed || authz.completedCount !== completedCount) fail('R4_CLOSE_COHORT_AUTHORIZATION_COUNT_MISMATCH');
  if (authz.targetCompletedSessions !== completedCount) fail('R4_CLOSE_COHORT_AUTHORIZATION_TARGET_MISMATCH');
  if (authz.canonicalMembershipDigest !== identity.canonicalMembershipDigest) fail('R4_CLOSE_COHORT_AUTHORIZATION_MEMBERSHIP_DIGEST');
  if (canonical([...authz.canonicalMembership].sort()) !== canonical(membership)) fail('R4_CLOSE_COHORT_AUTHORIZATION_MEMBERSHIP');
  if (authz.referenceCount !== referenceCount || authz.referenceSetDigest !== identity.referenceSetDigest) fail('R4_CLOSE_COHORT_AUTHORIZATION_REFERENCES');
  return {
    attemptsUsed,
    completedCount,
    canonicalMembership: [...membership],
    canonicalMembershipDigest: identity.canonicalMembershipDigest,
    referenceCount,
    referenceSetDigest: identity.referenceSetDigest,
  };
}
/* ---------------------------------------------------------------- review */

/** Structural + binding validation of an external closure review. Runs no analysis. */
export function assertReview(review, ctx, att = null) {
  closedKeys(review, R4_FINALIZATION_REVIEW_KEYS, 'REVIEW');
  checkFingerprint(review, 'REVIEW');
  const c = ctx.constants;
  if (review.schemaVersion !== 1 || review.recordType !== 'r4_finalization_review' || review.closureGeneration !== 1) fail('R4_CLOSE_REVIEW_TYPE');
  if (review.verdict !== R4_REVIEW_VERDICT) fail('R4_CLOSE_REVIEW_VERDICT');
  if (!Array.isArray(review.blockers) || review.blockers.length !== 0) fail('R4_CLOSE_REVIEW_BLOCKERS');
  for (const k of ['reviewerIdentity', 'reviewerModel']) if (typeof review[k] !== 'string' || review[k].trim().length < 2) fail(`R4_CLOSE_REVIEW_${k}`);
  if (!isStamp(review.reviewedAt)) fail('R4_CLOSE_REVIEW_TIME');
  // CHRONOLOGY (Advisory C). The finalization review must be no earlier than the
  // completed result attestation it authorizes. Uses ONLY the immutable record
  // timestamps; filesystem mtime is never consulted.
  if (att && !(att.result.attestedAt <= review.reviewedAt)) fail('R4_CLOSE_REVIEW_PREDATES_ATTESTATION');
  if (review.closureCopiesResultWithoutRecomputation !== true || review.closureIsLifecycleMetadataOnly !== true) fail('R4_CLOSE_REVIEW_DECLARATIONS');
  closedKeys(review.implementationHashes, ['finalizer', 'validator'], 'REVIEW_HASHES');
  const live = selfHashes(ctx);
  if (review.implementationHashes.finalizer !== live.finalizer || review.implementationHashes.validator !== live.validator) fail('R4_CLOSE_REVIEW_IMPLEMENTATION_HASH_MISMATCH');
  if (review.archiveManifestFingerprint !== c.archiveManifestFingerprint) fail('R4_CLOSE_REVIEW_ARCHIVE_MANIFEST_MISMATCH');
  if (review.evidenceInventoryDigest !== c.evidenceInventoryDigest) fail('R4_CLOSE_REVIEW_INVENTORY_MISMATCH');
  if (review.c1Commit !== c.c1Commit) fail('R4_CLOSE_REVIEW_C1_MISMATCH');
  if (review.resultAttestationFingerprint !== c.resultAttestationFingerprint) fail('R4_CLOSE_REVIEW_ATTEST_MISMATCH');
  return review;
}

/** Import a genuine external review. Validates, persists write-once, revalidates. */
export function importReview(ctx, reviewPath) {
  if (typeof reviewPath !== 'string' || !reviewPath) fail('R4_CLOSE_REVIEW_PATH_REQUIRED');
  let review;
  try { review = JSON.parse(readFileSync(reviewPath, 'utf8')); } catch { fail('R4_CLOSE_REVIEW_UNREADABLE'); }
  assertReview(review, ctx);
  mkdirSync(ctx.closureDir, { recursive: true });
  const target = path.join(ctx.closureDir, R4_FINALIZATION_REVIEW_FILE);
  writeOnce(target, recordText(review));
  assertReview(readRecord(target, 'REVIEW'), ctx);
  return review;
}

/* --------------------------------------------------------- closure validation */

/**
 * Validate a closure record. Never computes anything scientific: every copied
 * value is compared back against the immutable attestation.
 */
export function assertClosure(closure, att, ctx, review) {
  closedKeys(closure, R4_FINALIZATION_KEYS, 'CLOSURE');
  checkFingerprint(closure, 'CLOSURE');
  const c = ctx.constants;
  if (closure.schemaVersion !== 1 || closure.recordType !== 'r4_finalization_closure') fail('R4_CLOSE_CLOSURE_TYPE');
  if (closure.status !== R4_CLOSURE_STATUS || closure.closureReason !== R4_CLOSURE_REASON) fail('R4_CLOSE_CLOSURE_STATUS');
  const bindings = {
    a2Commit: c.a2Commit, a2Epoch: c.a2Epoch, a2Fingerprint: c.a2Fingerprint, s6Commit: c.s6Commit, s6Fingerprint: c.s6Fingerprint,
    c1Commit: c.c1Commit, c1Fingerprint: c.c1Fingerprint, t0: c.t0, authorityStage: 'C',
    archiveManifestFingerprint: c.archiveManifestFingerprint, archiveMainCommit: c.c1Commit, archiveVerified: true,
    evidenceInventoryDigest: c.evidenceInventoryDigest, evidenceInventoryFileCount: c.evidenceInventoryFileCount,
    evidenceInventoryTotalBytes: c.evidenceInventoryTotalBytes,
    resultAttestationReviewFingerprint: c.resultAttestationReviewFingerprint,
    resultAttestationClaimFingerprint: c.resultAttestationClaimFingerprint,
    resultAttestationFingerprint: c.resultAttestationFingerprint,
    resultIdentityDigest: c.resultIdentityDigest, resultAnalysisDigest: c.resultAnalysisDigest,
    referenceSetDigest: c.referenceSetDigest, canonicalMembershipDigest: c.canonicalMembershipDigest,
    // NOTE: `completedCount` is deliberately absent here. It is not an alias of
    // attemptsUsed; it is re-derived from the attested membership length below.
    attemptsUsed: c.attemptsUsed, referenceCount: c.referenceCount,
  };
  for (const [k, v] of Object.entries(bindings)) if (closure[k] !== v) fail(`R4_CLOSE_CLOSURE_BINDING:${k}`);

  // --- outcome identities: verified against AUTHENTICATED SOURCE ARTIFACTS ---
  // The closure's four outcome identities are re-resolved here from the outcome
  // authorization record, the outcome consumption record, the outcome run
  // manifest and the immutable attestation identity. Comparing them to
  // R4_CLOSURE_CONSTANTS alone is explicitly NOT sufficient.
  const outcome = resolveOutcomeIdentities(att, ctx);
  for (const key of R4_OUTCOME_IDENTITY_KEYS) {
    if (closure[key] !== outcome[key]) fail(`R4_CLOSE_CLOSURE_OUTCOME_IDENTITY:${key}`);
  }

  // --- lifecycle counts: re-derived, not copied ---
  const cohort = copyCohortIdentity(att, ctx);
  if (closure.attemptsUsed !== cohort.attemptsUsed) fail('R4_CLOSE_CLOSURE_ATTEMPTS_USED');
  if (closure.completedCount !== cohort.completedCount) fail('R4_CLOSE_CLOSURE_COMPLETED_COUNT');
  if (closure.attemptsUsed !== 6 || closure.completedCount !== 6) fail('R4_CLOSE_CLOSURE_COUNTS_NOT_SIX');
  if (canonical(closure.canonicalMembership) !== canonical(cohort.canonicalMembership)) fail('R4_CLOSE_CLOSURE_MEMBERSHIP_NOT_ATTESTED');

  // --- the closure must bind the exact review that authorized it ---
  if (!review) fail('R4_CLOSE_CLOSURE_REVIEW_REQUIRED');
  if (!isHex(closure.finalizationReviewFingerprint, 64)) fail('R4_CLOSE_CLOSURE_REVIEW_FINGERPRINT_MALFORMED');
  if (closure.finalizationReviewFingerprint !== review.fingerprint) fail('R4_CLOSE_CLOSURE_REVIEW_BINDING');
  if (closure.resultAttestationFingerprint !== att.result.fingerprint) fail('R4_CLOSE_CLOSURE_ATTESTATION_BINDING');

  if (!isCommit(closure.headAtClosure) || closure.headAtClosure !== closure.c1Commit) fail('R4_CLOSE_CLOSURE_HEAD');
  if (!isCommit(closure.originMainAtClosure) || closure.originMainAtClosure !== closure.c1Commit) fail('R4_CLOSE_CLOSURE_ORIGIN_MAIN');
  if (canonical([...closure.canonicalMembership].sort()) !== canonical(closure.canonicalMembership)) fail('R4_CLOSE_CLOSURE_MEMBERSHIP_SORT');
  if (digest([...closure.canonicalMembership].sort()) !== closure.canonicalMembershipDigest) fail('R4_CLOSE_CLOSURE_MEMBERSHIP_DIGEST');
  if (closure.canonicalMembership.length !== closure.completedCount) fail('R4_CLOSE_CLOSURE_COMPLETED_COUNT');
  if (!isStamp(closure.closedAt) || closure.closedAtIso !== new Date(closure.closedAt).toISOString()) fail('R4_CLOSE_CLOSURE_TIME');
  // copied scientific values must equal the attestation EXACTLY
  const copied = copyScientificResult(att);
  for (const k of R4_COPIED_RESULT_FIELDS) {
    if (canonical(closure[k]) !== canonical(copied[k])) fail(`R4_CLOSE_RESULT_COPY_DRIFT:${k}`);
  }
  for (const k of RESEARCH_TRUE) if (!isTrue(closure[k])) fail(`R4_CLOSE_CLASSIFICATION:${k}`);
  for (const k of RESEARCH_FALSE) if (!isFalse(closure[k])) fail(`R4_CLOSE_CLASSIFICATION:${k}`);
  // lifecycle declarations
  if (closure.liveRederivationWindowClosed !== true) fail('R4_CLOSE_LIVE_WINDOW_NOT_CLOSED');
  if (closure.futureCanonicalReproductionMode !== R4_REPRODUCTION_MODE) fail('R4_CLOSE_REPRODUCTION_MODE');
  if (closure.productionMainMayAdvanceAfterClosure !== true) fail('R4_CLOSE_MAIN_ADVANCE');
  if (closure.noFurtherCanonicalR4ExecutionRequired !== true) fail('R4_CLOSE_FURTHER_EXECUTION');
  return closure;
}

/* ------------------------------------------------------------ preconditions */

/**
 * Advisory D. R4_CLOSURE_CONSTANTS is an EXPECTED identity set, not a source of
 * truth. Every durable constant is re-derived from, and required to equal,
 * authenticated disk state. A constant is never allowed to validate itself.
 * Any mismatch fails here, BEFORE a closure record can be written.
 */
export function verifyDurableConstants(ctx, { production, stageC, att, attVerify, outcome }) {
  const c = ctx.constants;
  // C1: resolved archive main, Stage-C continuation commit, live production HEAD
  const archive = ctx.verifyArchiveRepo(ctx.attestationContext());
  if (archive.archiveMainCommit !== c.c1Commit) fail('R4_CLOSE_CONSTANT_C1_ARCHIVE_MAIN');
  if (archive.archiveFsckPassed !== true) fail('R4_CLOSE_CONSTANT_ARCHIVE_FSCK');
  if (stageC.continuationCommit !== c.c1Commit) fail('R4_CLOSE_CONSTANT_C1_STAGE_C');
  if (production.head !== c.c1Commit || production.originMain !== c.c1Commit) fail('R4_CLOSE_CONSTANT_C1_PRODUCTION');
  if (production.boundFileCount !== ctx.boundFiles.length) fail('R4_CLOSE_CONSTANT_BOUND_FILE_COUNT');
  // A2 / S6 / T0, resolved independently from the archival C1 clone
  if (stageC.approvalCommit !== c.a2Commit || stageC.approvalFingerprint !== c.a2Fingerprint) fail('R4_CLOSE_CONSTANT_A2');
  if (stageC.approvalEpoch !== c.a2Epoch) fail('R4_CLOSE_CONSTANT_A2_EPOCH');
  if (stageC.sealFingerprint !== c.s6Fingerprint) fail('R4_CLOSE_CONSTANT_S6');
  if (stageC.t0 !== c.t0) fail('R4_CLOSE_CONSTANT_T0');
  // archive manifest, resolved from the immutable prep artifact
  const manifest = ctx.verifyArchiveManifest(ctx.attestationContext());
  if (manifest.fingerprint !== c.archiveManifestFingerprint) fail('R4_CLOSE_CONSTANT_ARCHIVE_MANIFEST');
  if (manifest.archiveMainCommit !== c.c1Commit) fail('R4_CLOSE_CONSTANT_ARCHIVE_MANIFEST_C1');
  // inventory constants, against the immutable inventory artifact
  const inventory = ctx.verifyFrozenInventory(ctx.attestationContext());
  if (inventory.aggregateDigest !== c.evidenceInventoryDigest) fail('R4_CLOSE_CONSTANT_INVENTORY_DIGEST');
  if (inventory.fileCount !== c.evidenceInventoryFileCount) fail('R4_CLOSE_CONSTANT_INVENTORY_FILE_COUNT');
  if (inventory.totalBytes !== c.evidenceInventoryTotalBytes) fail('R4_CLOSE_CONSTANT_INVENTORY_TOTAL_BYTES');
  // attestation fingerprints, against the immutable attestation records
  if (att.result.fingerprint !== c.resultAttestationFingerprint) fail('R4_CLOSE_CONSTANT_ATTEST_FINGERPRINT');
  if (att.claim.fingerprint !== c.resultAttestationClaimFingerprint) fail('R4_CLOSE_CONSTANT_ATTEST_CLAIM_FINGERPRINT');
  if (att.review.fingerprint !== c.resultAttestationReviewFingerprint) fail('R4_CLOSE_CONSTANT_ATTEST_REVIEW_FINGERPRINT');
  if (att.result.identityDigest !== c.resultIdentityDigest) fail('R4_CLOSE_CONSTANT_IDENTITY_DIGEST');
  if (att.result.analysisDigest !== c.resultAnalysisDigest) fail('R4_CLOSE_CONSTANT_ANALYSIS_DIGEST');
  if (attVerify.result !== c.resultAttestationFingerprint) fail('R4_CLOSE_CONSTANT_ATTEST_INDEPENDENT_VERIFY');
  // outcome identities, against the immutable outcome/attestation chain
  for (const key of R4_OUTCOME_IDENTITY_KEYS) {
    if (outcome[key] !== c[key]) fail(`R4_CLOSE_CONSTANT_OUTCOME_IDENTITY:${key}`);
  }
  return true;
}

/** Every read-only check that must hold before a closure may be written. */
export async function verifyPreconditions(ctx) {
  const production = verifyProductionState(ctx);
  const stageC = await verifyArchivedStageC(ctx);
  const attVerify = ctx.verifyAttestation(ctx.attestationContext());
  const att = readResultAttestation(ctx);
  // The sealed C1 attester must independently confirm the attestation chain.
  if (attVerify.result !== ctx.constants.resultAttestationFingerprint) fail('R4_CLOSE_ATTEST_VERIFY_MISMATCH');
  if (attVerify.claim !== ctx.constants.resultAttestationClaimFingerprint) fail('R4_CLOSE_ATTEST_VERIFY_CLAIM_MISMATCH');
  if (attVerify.review !== ctx.constants.resultAttestationReviewFingerprint) fail('R4_CLOSE_ATTEST_VERIFY_REVIEW_MISMATCH');
  // the closure must be strictly later than the attestation it depends on
  const copied = copyScientificResult(att);
  const cohort = copyCohortIdentity(att, ctx);
  // Advisory D: the durable constants are an EXPECTED identity set, never an
  // independent source of truth. Each is re-checked against authenticated disk
  // state (archive repo, archive manifest, frozen inventory, attestation chain,
  // outcome authorization/consumption/manifest records) before any closure.
  const outcome = resolveOutcomeIdentities(att, ctx);
  verifyDurableConstants(ctx, { production, stageC, att, attVerify, outcome });
  return { production, stageC: stageC.stage, attestation: attVerify, result: copied, cohort, att, outcome };
}

/* ------------------------------------------------------------------ close */

/**
 * CLOSE (single use). An external review is already persisted; verify every
 * precondition, then write the closure ONCE (O_EXCL) and re-verify from disk.
 * There is no retry, no repair-in-place and no recomputation.
 */
export async function closeR4(ctx) {
  const target = path.join(ctx.closureDir, R4_FINALIZATION_FILE);
  if (existsSync(target)) fail('R4_CLOSE_ALREADY_CLOSED');
  const reviewPath = path.join(ctx.closureDir, R4_FINALIZATION_REVIEW_FILE);
  const pre = await verifyPreconditions(ctx);
  // The review is validated against the completed attestation, so a stale review
  // that predates the attestation is refused before anything else happens.
  const review = assertReview(readRecord(reviewPath, 'REVIEW'), ctx, pre.att);
  const closedAt = ctx.now();
  if (closedAt <= pre.att.result.attestedAt) fail('R4_CLOSE_NOT_AFTER_ATTESTATION');
  if (!(pre.att.result.attestedAt <= review.reviewedAt)) fail('R4_CLOSE_REVIEW_PREDATES_ATTESTATION');
  if (!(review.reviewedAt <= closedAt)) fail('R4_CLOSE_REVIEW_CHRONOLOGY');
  const closure = sealRecord({
    schemaVersion: 1, recordType: 'r4_finalization_closure', status: R4_CLOSURE_STATUS, closureReason: R4_CLOSURE_REASON,
    a2Commit: ctx.constants.a2Commit, a2Epoch: ctx.constants.a2Epoch, a2Fingerprint: ctx.constants.a2Fingerprint,
    s6Commit: ctx.constants.s6Commit, s6Fingerprint: ctx.constants.s6Fingerprint,
    c1Commit: ctx.constants.c1Commit, c1Fingerprint: ctx.constants.c1Fingerprint, t0: ctx.constants.t0,
    authorityStage: pre.stageC, headAtClosure: pre.production.head, originMainAtClosure: pre.production.originMain,
    attemptsUsed: pre.cohort.attemptsUsed, completedCount: pre.cohort.completedCount,
    canonicalMembership: pre.cohort.canonicalMembership, canonicalMembershipDigest: pre.cohort.canonicalMembershipDigest,
    referenceCount: pre.cohort.referenceCount, referenceSetDigest: pre.cohort.referenceSetDigest,
    outcomeAuthorizationFingerprint: pre.outcome.outcomeAuthorizationFingerprint,
    outcomeRunId: pre.outcome.outcomeRunId, outcomeRunFingerprint: pre.outcome.outcomeRunFingerprint,
    outcomeBindingFingerprint: pre.outcome.outcomeBindingFingerprint,
    archiveManifestFingerprint: ctx.constants.archiveManifestFingerprint,
    archiveMainCommit: ctx.constants.c1Commit, archiveVerified: true,
    evidenceInventoryDigest: ctx.constants.evidenceInventoryDigest,
    evidenceInventoryFileCount: ctx.constants.evidenceInventoryFileCount,
    evidenceInventoryTotalBytes: ctx.constants.evidenceInventoryTotalBytes,
    resultAttestationReviewFingerprint: pre.att.review.fingerprint,
    resultAttestationClaimFingerprint: pre.att.claim.fingerprint,
    resultAttestationFingerprint: pre.att.result.fingerprint,
    resultIdentityDigest: pre.att.result.identityDigest, resultAnalysisDigest: pre.att.result.analysisDigest,
    finalizationReviewFingerprint: review.fingerprint,
    ...pre.result,
    liveRederivationWindowClosed: true, futureCanonicalReproductionMode: R4_REPRODUCTION_MODE,
    productionMainMayAdvanceAfterClosure: true, noFurtherCanonicalR4ExecutionRequired: true,
    closedAt, closedAtIso: new Date(closedAt).toISOString(),
  });
  assertClosure(closure, pre.att, ctx, review);
  if (!(review.reviewedAt <= closedAt)) fail('R4_CLOSE_REVIEW_CHRONOLOGY');
  writeOnce(target, recordText(closure));
  assertClosure(readRecord(target, 'CLOSURE'), readResultAttestation(ctx), ctx, readRecord(reviewPath, 'REVIEW'));
  return closure;
}

/* ----------------------------------------------------------------- verify */

/**
 * Verify the immutable closure. Recomputes no science and runs no analysis: it
 * re-reads the attestation and re-checks every copied value against it.
 */
export async function verifyClosure(ctx) {
  const att = readResultAttestation(ctx);
  const review = assertReview(readRecord(path.join(ctx.closureDir, R4_FINALIZATION_REVIEW_FILE), 'REVIEW'), ctx, att);
  const closure = readRecord(path.join(ctx.closureDir, R4_FINALIZATION_FILE), 'CLOSURE');
  assertClosure(closure, att, ctx, review);
  if (!(review.reviewedAt <= closure.closedAt)) fail('R4_CLOSE_CHRONOLOGY');
  ctx.verifyArchiveRepo(ctx.attestationContext());
  ctx.verifyFrozenInventory(ctx.attestationContext());
  return { review: review.fingerprint, closure: closure.fingerprint, status: closure.status, attestation: att.result.fingerprint,
    outcomeRunFingerprint: closure.outcomeRunFingerprint, outcomeBindingFingerprint: closure.outcomeBindingFingerprint };
}

/* -------------------------------------------------------------------- CLI */

async function main(argv) {
  const [command, ...rest] = argv;
  const ctx = productionContext();
  if (command === 'review') {
    if (rest.length !== 1 || rest[0].startsWith('-')) fail('R4_CLOSE_CLI_USAGE');
    const review = importReview(ctx, rest[0]);
    return { imported: R4_FINALIZATION_REVIEW_FILE, fingerprint: review.fingerprint };
  }
  if (rest.length !== 0) fail(`R4_CLOSE_CLI_OVERRIDE_REJECTED:${rest[0]}`);
  if (command === 'verify-preconditions') {
    const pre = await verifyPreconditions(ctx);
    // This command does NOT close R4 and must never claim it did. It reports
    // readiness only; R4_CLOSURE_STATUS is used by the closure record alone.
    return { ok: true, preconditionsSatisfied: true, status: R4_PRECONDITION_STATUS, r4Finalized: false,
      closureRecordExists: existsSync(path.join(ctx.closureDir, R4_FINALIZATION_FILE)),
      stage: pre.stageC, head: pre.production.head,
      originMain: pre.production.originMain, boundFileCount: pre.production.boundFileCount,
      attestation: pre.attestation, referenceCount: pre.cohort.referenceCount,
      attemptsUsed: pre.cohort.attemptsUsed, completedCount: pre.cohort.completedCount,
      outcomeAuthorizationFingerprint: pre.outcome.outcomeAuthorizationFingerprint,
      outcomeRunId: pre.outcome.outcomeRunId, outcomeRunFingerprint: pre.outcome.outcomeRunFingerprint,
      outcomeBindingFingerprint: pre.outcome.outcomeBindingFingerprint,
      archivedResultIdentityDigest: pre.att.result.identityDigest };
  }
  if (command === 'close') {
    const closure = await closeR4(ctx);
    return { closed: R4_FINALIZATION_FILE, fingerprint: closure.fingerprint, status: closure.status };
  }
  if (command === 'verify') return verifyClosure(ctx);
  return fail('R4_CLOSE_CLI_USAGE');
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main(process.argv.slice(2)).then(out => console.log(JSON.stringify(out, null, 2)), error => { console.error(error.message); process.exit(1); });
}
