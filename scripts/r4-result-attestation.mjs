// R4 RESULT ATTESTATION (mechanism only).
//
// PURPOSE. R4_RESULT_ATTESTATION_REPRODUCTION: one explicitly authorized,
// deterministic re-derivation of the frozen canonical R4 result, persisted as a
// write-once attestation. It is NOT a new experiment, cohort, specification,
// sensitivity analysis, alternative estimator, parameter search or rerun. The
// frozen sealed code alone determines the result.
//
// ANTI-SELECTION. No previously observed scientific result value exists in this
// file or is accepted as input: the attester discovers the result ONLY by
// running the sealed canonical analysis. Only durable PRE-analysis identities
// (archive/seal/approval commits, inventory facts, membership/reference
// digests, outcome-run/authorization fingerprints) are constants here. Nothing
// is ever compared against, or replaced by, an earlier result.
//
// CODE SOURCE. The canonical R4 modules are imported from a fresh temporary
// clone of the archival C1 bare repository (repoRoot), never from production
// main. Evidence is read from the retained real tree (evidenceRoot).
//
// COMMANDS (CLI; no scientific arguments exist):
//   review <genuine-review.json>   import an external exact-byte review
//   verify-preconditions           read-only checks, performs no analysis
//   execute                        claim -> single canonical call -> attestation
//   verify                         verify the immutable attestation (no analysis)
import {
  chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync,
  readdirSync, rmSync, statSync, writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonical, digest } from './market-intelligence/definition.mjs';
import { verifyOutcomeRun } from './market-outcomes/index.mjs';
import { lockedAnalysisParameters } from './r4-enforcement.mjs';
import { R4_REQUIRED_BOUND_FILES } from './r4-protocol-spec.mjs';

const SELF = fileURLToPath(import.meta.url);
export const R4_ATTESTER_REPO_ROOT = path.resolve(path.dirname(SELF), '..');

/* ------------------------------------------------ durable pre-analysis identities */

export const R4_ATTESTATION_CONSTANTS = Object.freeze({
  c1Commit: '1c30264fb87876eeaf229e25c5cdc5adca429b40',
  a2Commit: '9dc30de45ee0fc8c493c2582bae6378dae1fdc7b',
  s6Commit: 'f6583433eba00de1558a9f0c4845e1e7905e9877',
  t0: 1790690400000,
  inventoryFileCount: 109,
  inventoryTotalBytes: 3144793956,
  inventoryAggregateDigest: '40ed7c4a0686d7257cd270a08d7dd70513e7f83e852a895caed0692d920f771d',
  archiveManifestFingerprint: '7b61a3be9fd8ec0252bb52698fcd659d427bcdc60e0fa9254aac4ee8243a023d',
  canonicalMembershipDigest: '7f5de0d51021e2446fcdf0ee4580a56043b8841a05171fd716cfe593faf7418b',
  referenceCount: 3516,
  referenceSetDigest: '08fcf8b6f3a6d9d5498d41c981682185587204e9f648d8190ca42972027cbf94',
  outcomeAuthorizationFingerprint: '958f1c9de87339ceae6c5e15dc315d7c628d0db2a8c635ebd334f4336f6ff7ff',
  outcomeRunId: 'r4-outcome-0001-0126e75ca6d779f6016486e799546385',
  outcomeRunFingerprint: '73deb08124aa5bfce00ca227109a75c353ae52d2247c5768c3f0d7e8df640d58',
});

export const R4_ARCHIVE_PATH = '.evolve/r4-archive/evolve-r4-c1.git';
export const R4_PREP_DIR = '.evolve/governance/r4-finalization-prep';
export const R4_ATTESTATION_DIR = '.evolve/governance/r4-result-attestations';
export const R4_OUTCOME_ROOT = '.evolve/market-outcomes';
export const R4_OUTCOME_AUTHORIZATION_PATH = '.evolve/governance/r4-outcome-authorizations/outcome-authorization-0001.json';
export const R4_INVENTORY_FILE = 'evidence-inventory-0001.json';
export const R4_ARCHIVE_MANIFEST_FILE = 'archive-0001.json';
export const R4_REVIEW_FILE = 'result-attestation-0001.review.json';
export const R4_CLAIM_FILE = 'result-attestation-0001.claim.json';
export const R4_RESULT_FILE = 'result-attestation-0001.json';
export const R4_RESULT_PURPOSE = 'R4_RESULT_ATTESTATION_REPRODUCTION';
export const R4_REVIEW_VERDICT = 'READY_TO_ATTEST_R4_RESULT';
export const R4_INVENTORY_ROOTS = Object.freeze([
  'governance/r4', '.evolve/governance/r4-attempts', '.evolve/governance/r4-attestations',
  '.evolve/governance/r4-outcome-authorizations', '.evolve/market-outcomes',
]);
export const R4_SESSION_ROOT = '.evolve/market-intelligence/sessions';

export const R4_REVIEW_KEYS = Object.freeze(['schemaVersion', 'recordType', 'attestationGeneration', 'verdict', 'reviewerIdentity', 'reviewerModel',
  'reviewedAt', 'implementationHashes', 'archiveManifestFingerprint', 'evidenceInventoryDigest', 'c1Commit', 'outcomeRunFingerprint',
  'noPriorResultValuesAreInputs', 'exactlyOneCanonicalCall', 'blockers', 'fingerprint']);
export const R4_CLAIM_KEYS = Object.freeze(['schemaVersion', 'recordType', 'status', 'generation', 'archiveMainCommit', 'evidenceInventoryDigest',
  'outcomeRunFingerprint', 'reviewFingerprint', 'claimedAt', 'fingerprint']);
export const R4_RESULT_KEYS = Object.freeze(['schemaVersion', 'recordType', 'status', 'purpose', 'generation', 'archiveMainCommit',
  'archiveManifestFingerprint', 'evidenceInventoryDigest', 'evidenceInventoryFileCount', 'evidenceInventoryTotalBytes',
  'scientificApprovalCommit', 'scientificApprovalFingerprint', 'runtimeSealCommit', 'runtimeSealFingerprint', 'continuationCommit',
  'continuationFingerprint', 't0', 'outcomeAuthorizationFingerprint', 'outcomeRunId', 'outcomeRunFingerprint', 'outcomeBindingFingerprint',
  'reviewFingerprint', 'claimFingerprint', 'attestedAt', 'attestedAtIso', 'identity', 'analysis', 'identityDigest', 'analysisDigest', 'fingerprint']);
const INVENTORY_KEYS = ['schemaVersion', 'recordType', 'c1Commit', 'roots', 'files', 'fileCount', 'totalBytes', 'aggregateDigest', 'createdAt', 'fingerprint'];
const MANIFEST_KEYS = ['schemaVersion', 'recordType', 'status', 'c1Commit', 'archivePath', 'archiveMainCommit', 'archiveFsckPassed',
  'archiveCloneSmokePassed', 'archiveCloneHead', 'archiveCloneRemoteMain', 'stageCResolvedFromArchiveClone', 'evidenceInventoryPath',
  'evidenceInventoryDigest', 'evidenceFileCount', 'createdAt', 'fingerprint'];

/** Keys a caller may never influence on the real execute path. */
export const R4_ATTESTATION_FORBIDDEN_OVERRIDES = Object.freeze(['repoRoot', 'evidenceRoot', 'archive', 'c1', 'a2', 's6', 't0', 'membership', 'references',
  'outcomeRun', 'outcomeBinding', 'analysisParameters', 'bootstrapCount', 'seed', 'pointEstimate', 'ci', 'result', 'outputLocation']);

const fail = code => { throw new Error(code); };
const isStamp = v => Number.isSafeInteger(v) && v > 0;
const isHex = (v, n) => typeof v === 'string' && new RegExp(`^[0-9a-f]{${n}}$`).test(v);
const sha256Bytes = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (args, { cwd, gitDir } = {}) => execFileSync('git', gitDir ? ['--git-dir', gitDir, ...args] : args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const closedKeys = (record, keys, what) => {
  if (!record || typeof record !== 'object' || Array.isArray(record)) fail(`R4_ATTEST_${what}_NOT_OBJECT`);
  if (Object.keys(record).sort().join() !== [...keys].sort().join()) fail(`R4_ATTEST_${what}_SCHEMA_NOT_CLOSED`);
};
export const sealRecord = body => ({ ...body, fingerprint: digest(body) });
const checkFingerprint = (record, what) => {
  const { fingerprint, ...body } = record;
  if (!isHex(fingerprint, 64) || digest(body) !== fingerprint) fail(`R4_ATTEST_${what}_FINGERPRINT`);
};
const recordText = record => `${JSON.stringify(record, null, 2)}\n`;

/* ------------------------------------------------------------ write-once records */

/** O_CREAT|O_EXCL, full write, fsync file + directory, chmod 0444, reread. Never overwrites. */
export function writeOnce(file, text) {
  const fd = openSync(file, 'wx', 0o444);
  try {
    const bytes = Buffer.from(text, 'utf8');
    for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  const dfd = openSync(path.dirname(file), 'r');
  try { fsyncSync(dfd); } finally { closeSync(dfd); }
  chmodSync(file, 0o444);
  if ((statSync(file).mode & 0o777) !== 0o444) fail('R4_ATTEST_RECORD_NOT_0444');
  if (readFileSync(file, 'utf8') !== text) fail('R4_ATTEST_RECORD_REREAD_MISMATCH');
  return file;
}

function readRecord(file, what) {
  let st;
  try { st = lstatSync(file); } catch { fail(`R4_ATTEST_${what}_MISSING`); }
  if (!st.isFile()) fail(`R4_ATTEST_${what}_NOT_REGULAR_FILE`);
  if ((st.mode & 0o777) !== 0o444) fail(`R4_ATTEST_${what}_MODE_NOT_0444`);
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { fail(`R4_ATTEST_${what}_UNPARSEABLE`); }
}

/* ------------------------------------------------------------------- context */

/**
 * Production context. Every location and identity is fixed here; the CLI offers
 * no way to change any of them. Tests build their own contexts around temporary
 * synthetic roots.
 */
export function productionContext() {
  return {
    repoRoot: R4_ATTESTER_REPO_ROOT, evidenceRoot: R4_ATTESTER_REPO_ROOT, constants: R4_ATTESTATION_CONSTANTS,
    archiveDir: path.join(R4_ATTESTER_REPO_ROOT, R4_ARCHIVE_PATH), attestDir: path.join(R4_ATTESTER_REPO_ROOT, R4_ATTESTATION_DIR),
    boundFiles: R4_REQUIRED_BOUND_FILES, selfFiles: {
      attester: SELF, validator: path.join(path.dirname(SELF), 'validate-r4-result-attestation.mjs'),
    },
    loadModules: loadArchivedModules, verifyOutcomeRun, lockedParameters: lockedAnalysisParameters, now: () => Date.now(), tmpRoot: tmpdir(),
  };
}

/** Import the canonical R4 modules from the archival clone (never from production). */
export async function loadArchivedModules(cloneDir) {
  const load = async rel => import(pathToFileURL(path.join(cloneDir, rel)).href);
  const [analysis, approval, history, enforcement, outcomes] = await Promise.all([
    load('scripts/r4-canonical-analysis.mjs'), load('scripts/r4-approval.mjs'), load('scripts/r4-attempt-history.mjs'),
    load('scripts/r4-enforcement.mjs'), load('scripts/market-outcomes/index.mjs'),
  ]);
  return { analysis, approval, history, enforcement, outcomes };
}

/* ----------------------------------------------------- production + archive checks */

export function verifyProductionAuthority(ctx) {
  const { c1Commit } = ctx.constants;
  if (git(['rev-parse', 'HEAD'], { cwd: ctx.repoRoot }) !== c1Commit) fail('R4_ATTEST_PRODUCTION_HEAD_NOT_C1');
  const remote = git(['ls-remote', 'origin', 'refs/heads/main'], { cwd: ctx.repoRoot }).split(/\s+/)[0];
  if (remote !== c1Commit) fail('R4_ATTEST_PRODUCTION_REMOTE_MAIN_NOT_C1');
  if (git(['diff', '--name-only', c1Commit, '--', ...ctx.boundFiles], { cwd: ctx.repoRoot }) !== '') fail('R4_ATTEST_BOUND_FILES_CHANGED');
  if (git(['status', '--porcelain', '--', ...ctx.boundFiles], { cwd: ctx.repoRoot }) !== '') fail('R4_ATTEST_BOUND_FILES_DIRTY');
  return { head: c1Commit, remoteMain: remote, boundFileCount: ctx.boundFiles.length };
}

export function verifyArchiveRepo(ctx) {
  let main;
  try { main = git(['rev-parse', '--verify', 'refs/heads/main'], { gitDir: ctx.archiveDir }); } catch { fail('R4_ATTEST_ARCHIVE_MAIN_UNREADABLE'); }
  if (main !== ctx.constants.c1Commit) fail('R4_ATTEST_ARCHIVE_MAIN_NOT_C1');
  try { execFileSync('git', ['--git-dir', ctx.archiveDir, 'fsck', '--full'], { stdio: ['ignore', 'pipe', 'pipe'] }); } catch { fail('R4_ATTEST_ARCHIVE_FSCK_FAILED'); }
  return { archiveMainCommit: main, archiveFsckPassed: true };
}

export function verifyArchiveManifest(ctx) {
  const record = readRecord(path.join(ctx.evidenceRoot, R4_PREP_DIR, R4_ARCHIVE_MANIFEST_FILE), 'ARCHIVE_MANIFEST');
  closedKeys(record, MANIFEST_KEYS, 'ARCHIVE_MANIFEST');
  checkFingerprint(record, 'ARCHIVE_MANIFEST');
  const c = ctx.constants;
  if (record.fingerprint !== c.archiveManifestFingerprint) fail('R4_ATTEST_ARCHIVE_MANIFEST_FINGERPRINT_MISMATCH');
  if (record.recordType !== 'r4_archival_c1_manifest' || record.status !== 'ARCHIVE_READY') fail('R4_ATTEST_ARCHIVE_MANIFEST_TYPE');
  for (const k of ['c1Commit', 'archiveMainCommit', 'archiveCloneHead', 'archiveCloneRemoteMain']) if (record[k] !== c.c1Commit) fail(`R4_ATTEST_ARCHIVE_MANIFEST_${k}`);
  if (record.evidenceInventoryDigest !== c.inventoryAggregateDigest || record.evidenceFileCount !== c.inventoryFileCount) fail('R4_ATTEST_ARCHIVE_MANIFEST_INVENTORY_BINDING');
  return record;
}

/* ----------------------------------------------------------- inventory (verify only) */

function hashFile(file) {
  const hash = createHash('sha256');
  const fd = openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1 << 20);
  try {
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (n === 0) break;
      hash.update(buffer.subarray(0, n));
    }
  } finally { closeSync(fd); }
  return hash.digest('hex');
}

function walk(evidenceRoot, rel, out) {
  const abs = path.join(evidenceRoot, rel);
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) fail(`R4_ATTEST_INVENTORY_SYMLINK:${rel}`);
  if (st.isDirectory()) { for (const name of readdirSync(abs).sort()) walk(evidenceRoot, `${rel}/${name}`, out); return; }
  if (!st.isFile()) fail(`R4_ATTEST_INVENTORY_NON_REGULAR:${rel}`);
  out.push({ path: rel, size: st.size, sha256: hashFile(abs) });
}

const aggregate = files => digest(files.map(({ path: p, size, sha256: h }) => ({ path: p, size, sha256: h })));
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * Independently re-hash EVERY frozen inventory entry against disk. Verify only:
 * the inventory is never regenerated or rewritten. Rejects any addition, removal,
 * content/size change, symlink substitution or path change.
 */
export function verifyFrozenInventory(ctx) {
  const c = ctx.constants;
  const record = readRecord(path.join(ctx.evidenceRoot, R4_PREP_DIR, R4_INVENTORY_FILE), 'INVENTORY');
  closedKeys(record, INVENTORY_KEYS, 'INVENTORY');
  checkFingerprint(record, 'INVENTORY');
  if (record.recordType !== 'r4_evidence_inventory' || record.c1Commit !== c.c1Commit) fail('R4_ATTEST_INVENTORY_TYPE');
  if (record.fileCount !== c.inventoryFileCount || record.totalBytes !== c.inventoryTotalBytes || record.aggregateDigest !== c.inventoryAggregateDigest) {
    fail('R4_ATTEST_INVENTORY_DIGEST_MISMATCH');
  }
  if (record.fileCount !== record.files.length || record.totalBytes !== record.files.reduce((n, f) => n + f.size, 0)) fail('R4_ATTEST_INVENTORY_INTERNAL_COUNT');
  if (aggregate(record.files) !== record.aggregateDigest) fail('R4_ATTEST_INVENTORY_AGGREGATE');
  for (const f of record.files) closedKeys(f, ['path', 'size', 'sha256'], 'INVENTORY_ENTRY');
  if (canonical([...record.files].sort(byPath)) !== canonical(record.files)) fail('R4_ATTEST_INVENTORY_NOT_SORTED');
  // Roots: the five fixed roots plus exactly the six attested session directories.
  const attestDir = path.join(ctx.evidenceRoot, '.evolve/governance/r4-attestations');
  const sessions = readdirSync(attestDir).filter(n => n.endsWith('.json')).map(n => `${R4_SESSION_ROOT}/${n.slice(0, -5)}`).sort();
  if (sessions.length !== 6) fail('R4_ATTEST_INVENTORY_SESSION_COUNT');
  if (canonical(record.roots) !== canonical([...R4_INVENTORY_ROOTS, ...sessions])) fail('R4_ATTEST_INVENTORY_ROOTS_MISMATCH');
  const live = [];
  for (const root of record.roots) walk(ctx.evidenceRoot, root, live);
  live.sort(byPath);
  const want = new Map(record.files.map(f => [f.path, f]));
  const have = new Map(live.map(f => [f.path, f]));
  for (const p of have.keys()) if (!want.has(p)) fail(`R4_ATTEST_EVIDENCE_FILE_ADDED:${p}`);
  for (const p of want.keys()) if (!have.has(p)) fail(`R4_ATTEST_EVIDENCE_FILE_REMOVED:${p}`);
  for (const [p, f] of want) if (have.get(p).size !== f.size || have.get(p).sha256 !== f.sha256) fail(`R4_ATTEST_EVIDENCE_FILE_MUTATED:${p}`);
  if (aggregate(live) !== c.inventoryAggregateDigest) fail('R4_ATTEST_INVENTORY_LIVE_DIGEST_MISMATCH');
  return { fileCount: live.length, totalBytes: live.reduce((n, f) => n + f.size, 0), aggregateDigest: aggregate(live) };
}

/* -------------------------------------------------------------- outcome run + review */

function readAuthorizationRecord(ctx) {
  const record = JSON.parse(readFileSync(path.join(ctx.evidenceRoot, R4_OUTCOME_AUTHORIZATION_PATH), 'utf8'));
  checkFingerprint(record, 'OUTCOME_AUTHORIZATION');
  if (record.fingerprint !== ctx.constants.outcomeAuthorizationFingerprint) fail('R4_ATTEST_OUTCOME_AUTHORIZATION_FINGERPRINT_MISMATCH');
  if (record.runId !== ctx.constants.outcomeRunId) fail('R4_ATTEST_OUTCOME_AUTHORIZATION_RUN_MISMATCH');
  return record;
}

export function verifyOutcomeRunIdentity(ctx, verifyRun) {
  const c = ctx.constants;
  const manifest = verifyRun(path.join(ctx.evidenceRoot, R4_OUTCOME_ROOT, c.outcomeRunId));
  if (manifest.fingerprint !== c.outcomeRunFingerprint) fail('R4_ATTEST_OUTCOME_RUN_FINGERPRINT_MISMATCH');
  if (manifest.runId !== c.outcomeRunId) fail('R4_ATTEST_OUTCOME_RUN_ID_MISMATCH');
  if (manifest.sealedCode?.authorizationFingerprint !== c.outcomeAuthorizationFingerprint) fail('R4_ATTEST_OUTCOME_AUTHORIZATION_BINDING_MISMATCH');
  return manifest;
}

export function selfHashes(ctx) {
  return { attester: sha256Bytes(readFileSync(ctx.selfFiles.attester)), validator: sha256Bytes(readFileSync(ctx.selfFiles.validator)) };
}

/** Structural + binding checks of an external review. Does not run any analysis. */
export function assertReview(review, ctx) {
  closedKeys(review, R4_REVIEW_KEYS, 'REVIEW');
  checkFingerprint(review, 'REVIEW');
  const c = ctx.constants;
  if (review.schemaVersion !== 1 || review.recordType !== 'r4_result_attestation_review' || review.attestationGeneration !== 1) fail('R4_ATTEST_REVIEW_TYPE');
  if (review.verdict !== R4_REVIEW_VERDICT) fail('R4_ATTEST_REVIEW_VERDICT');
  if (!Array.isArray(review.blockers) || review.blockers.length !== 0) fail('R4_ATTEST_REVIEW_BLOCKERS');
  for (const k of ['reviewerIdentity', 'reviewerModel']) if (typeof review[k] !== 'string' || review[k].trim().length < 2) fail(`R4_ATTEST_REVIEW_${k}`);
  if (!isStamp(review.reviewedAt)) fail('R4_ATTEST_REVIEW_TIME');
  if (review.noPriorResultValuesAreInputs !== true || review.exactlyOneCanonicalCall !== true) fail('R4_ATTEST_REVIEW_DECLARATIONS');
  closedKeys(review.implementationHashes, ['attester', 'validator'], 'REVIEW_HASHES');
  const live = selfHashes(ctx);
  if (review.implementationHashes.attester !== live.attester || review.implementationHashes.validator !== live.validator) fail('R4_ATTEST_REVIEW_IMPLEMENTATION_HASH_MISMATCH');
  if (review.archiveManifestFingerprint !== c.archiveManifestFingerprint) fail('R4_ATTEST_REVIEW_ARCHIVE_MANIFEST_MISMATCH');
  if (review.evidenceInventoryDigest !== c.inventoryAggregateDigest) fail('R4_ATTEST_REVIEW_INVENTORY_MISMATCH');
  if (review.c1Commit !== c.c1Commit) fail('R4_ATTEST_REVIEW_C1_MISMATCH');
  if (review.outcomeRunFingerprint !== c.outcomeRunFingerprint) fail('R4_ATTEST_REVIEW_OUTCOME_RUN_MISMATCH');
  return review;
}

/** Import a genuine external review. Validates and persists it; performs no analysis. */
export function importReview(ctx, reviewPath) {
  if (typeof reviewPath !== 'string' || !reviewPath) fail('R4_ATTEST_REVIEW_PATH_REQUIRED');
  let review;
  try { review = JSON.parse(readFileSync(reviewPath, 'utf8')); } catch { fail('R4_ATTEST_REVIEW_UNREADABLE'); }
  assertReview(review, ctx);
  mkdirSync(ctx.attestDir, { recursive: true });
  const target = path.join(ctx.attestDir, R4_REVIEW_FILE);
  writeOnce(target, recordText(review));
  assertReview(readRecord(target, 'REVIEW'), ctx);
  return review;
}

/* ------------------------------------------------------------- temp clone + stage C */

function withArchiveClone(ctx, fn) {
  const dir = mkdtempSync(path.join(ctx.tmpRoot, 'r4-attest-clone-'));
  const cloneDir = path.join(dir, 'c1');
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  const run = async () => {
    execFileSync('git', ['clone', '--quiet', ctx.archiveDir, cloneDir], { stdio: ['ignore', 'pipe', 'pipe'] });
    const c1 = ctx.constants.c1Commit;
    if (git(['rev-parse', 'HEAD'], { cwd: cloneDir }) !== c1) fail('R4_ATTEST_CLONE_HEAD_NOT_C1');
    if (git(['rev-parse', 'refs/remotes/origin/main'], { cwd: cloneDir }) !== c1) fail('R4_ATTEST_CLONE_ORIGIN_MAIN_NOT_C1');
    return fn(cloneDir);
  };
  return run().finally(cleanup);
}

function resolveStageC(mods, cloneDir, ctx, authorization) {
  const c = ctx.constants;
  const resolution = mods.approval.resolveR4ExecutionAuthority({ cwd: cloneDir, requireApproval: true });
  if (resolution.stage !== 'C') fail('R4_ATTEST_STAGE_NOT_C');
  if (resolution.approvalCommit !== c.a2Commit) fail('R4_ATTEST_A2_MISMATCH');
  if (resolution.authority.sealAuthorityCommit !== c.s6Commit) fail('R4_ATTEST_S6_MISMATCH');
  if (resolution.continuationCommit !== c.c1Commit) fail('R4_ATTEST_C1_MISMATCH');
  if (resolution.t0 !== c.t0) fail('R4_ATTEST_T0_MISMATCH');
  if (resolution.approvalFingerprint !== authorization.scientificApprovalFingerprint) fail('R4_ATTEST_A2_FINGERPRINT_MISMATCH');
  if (resolution.seal.fingerprint !== authorization.runtimeSealFingerprint) fail('R4_ATTEST_S6_FINGERPRINT_MISMATCH');
  if (resolution.continuationFingerprint !== authorization.continuationFingerprint) fail('R4_ATTEST_C1_FINGERPRINT_MISMATCH');
  return resolution;
}

/**
 * Reconstruct the canonical outcome binding mechanically from authenticated
 * evidence and the archived C1 authority. Nothing is caller supplied.
 */
function reconstructBinding(mods, resolution, ctx, manifest) {
  const c = ctx.constants;
  const { seal, authority } = resolution;
  const approvalAuthority = Object.freeze({ approvalCommit: resolution.approvalCommit, approvalEpoch: resolution.approvalEpoch ?? null,
    approvalFingerprint: resolution.approvalFingerprint, t0: resolution.t0 });
  const continuation = resolution.continuationContext ?? null;
  const { history: h, enforcement: e } = mods;
  const verified = h.verifyR4AttemptHistory(h.loadR4AttemptHistory({ cwd: ctx.evidenceRoot }), {
    seal, authority, approvalCommit: approvalAuthority.approvalCommit, approvalEpoch: approvalAuthority.approvalEpoch,
    approvalFingerprint: approvalAuthority.approvalFingerprint, t0: approvalAuthority.t0, continuation });
  const plan = e.planSealedCohort({ seal, approvalAuthority });
  const attestations = h.historyAttestations(verified);
  const { canonicalMembership } = e.deriveCanonicalCohortMembership({ plan, attempts: h.historyToCohortAttempts(verified), seal, authority,
    attestations, approvalAuthority, continuation });
  const set = e.buildCanonicalReferenceSetFromEvidence({ seal, authority, approvalAuthority, canonicalMembership, attestations,
    sessionRoot: e.R4_SESSION_DIR_ROOT, cwd: ctx.evidenceRoot, attemptAuthorities: h.historyAttemptAuthorityIndex(verified), continuation });
  if (digest([...canonicalMembership].sort()) !== c.canonicalMembershipDigest) fail('R4_ATTEST_MEMBERSHIP_DIGEST_MISMATCH');
  if (set.references.length !== c.referenceCount) fail('R4_ATTEST_REFERENCE_COUNT_MISMATCH');
  if (set.digest !== c.referenceSetDigest) fail('R4_ATTEST_REFERENCE_SET_DIGEST_MISMATCH');
  return e.buildOutcomeRunBinding({ seal, authority, approvalAuthority, cohortMembership: canonicalMembership, references: set.references, outcomeRun: manifest });
}

/* ---------------------------------------------------------------- preconditions */

/**
 * Every deterministic pre-analysis check. Read-only; performs no analysis and
 * writes nothing (the temporary clone it creates is removed again).
 */
export async function verifyPreconditions(ctx) {
  const early = verifyStaticPreconditions(ctx);
  return withArchiveClone(ctx, async cloneDir => {
    const pre = await verifyPreconditionsInClone(ctx, cloneDir, early);
    return { ...pre, stage: pre.resolution.stage, outcomeBindingFingerprint: pre.binding.fingerprint };
  });
}

function verifyStaticPreconditions(ctx) {
  const production = verifyProductionAuthority(ctx);
  const archive = verifyArchiveRepo(ctx);
  const archiveManifest = verifyArchiveManifest(ctx);
  const inventory = verifyFrozenInventory(ctx);
  const authorization = readAuthorizationRecord(ctx);
  return { production, archive, archiveManifest, inventory, authorization };
}

/* ---------------------------------------------------------------- claim + result */

export function assertClaim(claim, ctx) {
  closedKeys(claim, R4_CLAIM_KEYS, 'CLAIM');
  checkFingerprint(claim, 'CLAIM');
  const c = ctx.constants;
  if (claim.schemaVersion !== 1 || claim.recordType !== 'r4_result_attestation_claim' || claim.status !== 'CLAIMED' || claim.generation !== 1) fail('R4_ATTEST_CLAIM_TYPE');
  if (claim.archiveMainCommit !== c.c1Commit || claim.evidenceInventoryDigest !== c.inventoryAggregateDigest || claim.outcomeRunFingerprint !== c.outcomeRunFingerprint) fail('R4_ATTEST_CLAIM_BINDING');
  if (!isHex(claim.reviewFingerprint, 64) || !isStamp(claim.claimedAt)) fail('R4_ATTEST_CLAIM_FIELDS');
  return claim;
}

const isTrue = v => v === true;
const isFalse = v => v === false;
const CLASSIFICATION_TRUE = ['developmentOnly', 'researchOnly', 'paperOnly', 'observerOnly'];
const CLASSIFICATION_FALSE = ['tradingAuthority', 'engineAuthority', 'arenaEligible', 'promotionEligible', 'profitabilityInferencePermitted'];
const RAW_KEYS = ['sessions', 'outcomes', 'exposureRows', 'references', 'rows'];

/** Structural validation of the scientific portions and their bindings. Never recomputes the analysis. */
export function assertResult(result, ctx) {
  closedKeys(result, R4_RESULT_KEYS, 'RESULT');
  checkFingerprint(result, 'RESULT');
  const c = ctx.constants;
  if (result.schemaVersion !== 1 || result.recordType !== 'r4_result_attestation' || result.status !== 'ATTESTED' || result.purpose !== R4_RESULT_PURPOSE || result.generation !== 1) fail('R4_ATTEST_RESULT_TYPE');
  const bindings = { archiveMainCommit: c.c1Commit, archiveManifestFingerprint: c.archiveManifestFingerprint, evidenceInventoryDigest: c.inventoryAggregateDigest,
    evidenceInventoryFileCount: c.inventoryFileCount, evidenceInventoryTotalBytes: c.inventoryTotalBytes, scientificApprovalCommit: c.a2Commit,
    runtimeSealCommit: c.s6Commit, continuationCommit: c.c1Commit, t0: c.t0, outcomeAuthorizationFingerprint: c.outcomeAuthorizationFingerprint,
    outcomeRunId: c.outcomeRunId, outcomeRunFingerprint: c.outcomeRunFingerprint };
  for (const [k, v] of Object.entries(bindings)) if (result[k] !== v) fail(`R4_ATTEST_RESULT_BINDING:${k}`);
  for (const k of ['scientificApprovalFingerprint', 'runtimeSealFingerprint', 'continuationFingerprint', 'outcomeBindingFingerprint', 'reviewFingerprint', 'claimFingerprint']) {
    if (!isHex(result[k], 64)) fail(`R4_ATTEST_RESULT_FIELD:${k}`);
  }
  if (!isStamp(result.attestedAt) || result.attestedAtIso !== new Date(result.attestedAt).toISOString()) fail('R4_ATTEST_RESULT_TIME');
  const { identity, analysis } = result;
  if (!identity || typeof identity !== 'object' || !analysis || typeof analysis !== 'object') fail('R4_ATTEST_RESULT_SCIENTIFIC_PORTIONS_MISSING');
  for (const raw of RAW_KEYS) if (raw in identity || raw in analysis || raw in result) fail(`R4_ATTEST_RESULT_RAW_PAYLOAD:${raw}`);
  if (result.identityDigest !== digest(identity)) fail('R4_ATTEST_RESULT_IDENTITY_DIGEST');
  if (result.analysisDigest !== digest(analysis)) fail('R4_ATTEST_RESULT_ANALYSIS_DIGEST');
  // identity binds the frozen authority chain (A2 / S6 / C1 continuation, stage C)
  const idBindings = { authorityStage: 'C', approvalCommit: c.a2Commit, authorityCommit: c.s6Commit, t0: c.t0, canonicalMembershipDigest: c.canonicalMembershipDigest,
    referenceSetDigest: c.referenceSetDigest, outcomeRunFingerprint: c.outcomeRunFingerprint, outcomeBindingFingerprint: result.outcomeBindingFingerprint,
    approvalFingerprint: result.scientificApprovalFingerprint, sealFingerprint: result.runtimeSealFingerprint, continuationFingerprint: result.continuationFingerprint };
  for (const [k, v] of Object.entries(idBindings)) if (identity[k] !== v) fail(`R4_ATTEST_RESULT_IDENTITY_BINDING:${k}`);
  if (analysis.sealFingerprint !== result.runtimeSealFingerprint) fail('R4_ATTEST_RESULT_ANALYSIS_SEAL');
  if (analysis.referenceSetDigest !== c.referenceSetDigest) fail('R4_ATTEST_RESULT_ANALYSIS_REFERENCE_SET');
  // locked R4 parameters + research-only classification
  if (canonical(analysis.lockedParameters) !== canonical(ctx.lockedParameters())) fail('R4_ATTEST_RESULT_LOCKED_PARAMETERS');
  for (const k of CLASSIFICATION_TRUE) if (!isTrue(analysis[k])) fail(`R4_ATTEST_RESULT_CLASSIFICATION:${k}`);
  for (const k of CLASSIFICATION_FALSE) if (!isFalse(analysis[k])) fail(`R4_ATTEST_RESULT_CLASSIFICATION:${k}`);
  return result;
}

/**
 * EXECUTE (single use). Preflight -> review -> claim (O_EXCL) -> exactly one
 * canonical call -> write-once attestation -> preservation re-check. No retry:
 * a failure after the claim leaves CLAIMED_ABANDONED and needs a new reviewed
 * generation.
 */
export async function executeAttestation(ctx) {
  const claimPath = path.join(ctx.attestDir, R4_CLAIM_FILE);
  const resultPath = path.join(ctx.attestDir, R4_RESULT_FILE);
  if (existsSync(claimPath) || existsSync(resultPath)) fail('R4_ATTEST_GENERATION_1_ALREADY_CLAIMED');
  const review = assertReview(readRecord(path.join(ctx.attestDir, R4_REVIEW_FILE), 'REVIEW'), ctx);
  const early = verifyStaticPreconditions(ctx);
  return withArchiveClone(ctx, async cloneDir => {
    const pre = await verifyPreconditionsInClone(ctx, cloneDir, early);
    const claim = sealRecord({ schemaVersion: 1, recordType: 'r4_result_attestation_claim', status: 'CLAIMED', generation: 1,
      archiveMainCommit: pre.archive.archiveMainCommit, evidenceInventoryDigest: pre.inventory.aggregateDigest,
      outcomeRunFingerprint: pre.manifest.fingerprint, reviewFingerprint: review.fingerprint, claimedAt: ctx.now() });
    writeOnce(claimPath, recordText(claim));
    let result;
    try {
      const outcomeRunDir = path.join(ctx.evidenceRoot, R4_OUTCOME_ROOT, ctx.constants.outcomeRunId);
      const readOutcomes = dir => readFileSync(path.join(dir, 'outcomes.ndjson'), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
      result = pre.mods.analysis.runCanonicalR4Analysis({ repoRoot: cloneDir, evidenceRoot: ctx.evidenceRoot, outcomeRunBinding: pre.binding, outcomeRunDir, readOutcomes });
    } catch (error) {
      throw new Error(`R4_ATTEST_CLAIMED_ABANDONED:${error.message}`, { cause: error });
    }
    const { identity, analysis } = result;
    const attestedAt = ctx.now();
    const record = sealRecord({ schemaVersion: 1, recordType: 'r4_result_attestation', status: 'ATTESTED', purpose: R4_RESULT_PURPOSE, generation: 1,
      archiveMainCommit: pre.archive.archiveMainCommit, archiveManifestFingerprint: pre.archiveManifest.fingerprint,
      evidenceInventoryDigest: pre.inventory.aggregateDigest, evidenceInventoryFileCount: pre.inventory.fileCount,
      evidenceInventoryTotalBytes: pre.inventory.totalBytes, scientificApprovalCommit: identity.approvalCommit,
      scientificApprovalFingerprint: identity.approvalFingerprint, runtimeSealCommit: identity.authorityCommit,
      runtimeSealFingerprint: identity.sealFingerprint, continuationCommit: pre.resolution.continuationCommit,
      continuationFingerprint: identity.continuationFingerprint, t0: identity.t0,
      outcomeAuthorizationFingerprint: pre.authorization.fingerprint, outcomeRunId: pre.manifest.runId,
      outcomeRunFingerprint: pre.manifest.fingerprint, outcomeBindingFingerprint: identity.outcomeBindingFingerprint,
      reviewFingerprint: review.fingerprint, claimFingerprint: claim.fingerprint, attestedAt, attestedAtIso: new Date(attestedAt).toISOString(),
      identity, analysis, identityDigest: digest(identity), analysisDigest: digest(analysis) });
    assertResult(record, ctx);
    writeOnce(resultPath, recordText(record));
    assertResult(readRecord(resultPath, 'RESULT'), ctx);
    verifyFrozenInventory(ctx); // preservation check after the write
    return record;
  });
}

async function verifyPreconditionsInClone(ctx, cloneDir, early) {
  const mods = await ctx.loadModules(cloneDir);
  const manifest = verifyOutcomeRunIdentity(ctx, mods.outcomes.verifyOutcomeRun);
  const resolution = resolveStageC(mods, cloneDir, ctx, early.authorization);
  const binding = reconstructBinding(mods, resolution, ctx, manifest);
  return { ...early, manifest, resolution, binding, mods };
}

/* ------------------------------------------------------------------------ verify */

/** Verify the immutable attested result. Recomputes nothing scientific. */
export function verifyAttestation(ctx) {
  const review = assertReview(readRecord(path.join(ctx.attestDir, R4_REVIEW_FILE), 'REVIEW'), ctx);
  const claim = assertClaim(readRecord(path.join(ctx.attestDir, R4_CLAIM_FILE), 'CLAIM'), ctx);
  const result = assertResult(readRecord(path.join(ctx.attestDir, R4_RESULT_FILE), 'RESULT'), ctx);
  if (claim.reviewFingerprint !== review.fingerprint || result.reviewFingerprint !== review.fingerprint) fail('R4_ATTEST_REVIEW_BINDING');
  if (result.claimFingerprint !== claim.fingerprint) fail('R4_ATTEST_CLAIM_BINDING');
  verifyArchiveRepo(ctx);
  verifyArchiveManifest(ctx);
  verifyFrozenInventory(ctx);
  verifyOutcomeRunIdentity(ctx, ctx.verifyOutcomeRun);
  return { review: review.fingerprint, claim: claim.fingerprint, result: result.fingerprint };
}

/* --------------------------------------------------------------------------- CLI */

async function main(argv) {
  const [command, ...rest] = argv;
  const ctx = productionContext();
  if (command === 'review') {
    if (rest.length !== 1 || rest[0].startsWith('-')) fail('R4_ATTEST_CLI_USAGE');
    const review = importReview(ctx, rest[0]);
    return { imported: R4_REVIEW_FILE, fingerprint: review.fingerprint };
  }
  if (rest.length !== 0) fail(`R4_ATTEST_CLI_OVERRIDE_REJECTED:${rest[0]}`);
  if (command === 'verify-preconditions') {
    const pre = await verifyPreconditions(ctx);
    return { ok: true, stage: pre.stage, archiveMainCommit: pre.archive.archiveMainCommit, archiveFsckPassed: pre.archive.archiveFsckPassed,
      inventory: pre.inventory, outcomeRunFingerprint: pre.manifest.fingerprint, outcomeBindingFingerprint: pre.outcomeBindingFingerprint,
      boundFileCount: pre.production.boundFileCount };
  }
  if (command === 'execute') {
    const record = await executeAttestation(ctx);
    return { attested: R4_RESULT_FILE, fingerprint: record.fingerprint, identityDigest: record.identityDigest, analysisDigest: record.analysisDigest };
  }
  if (command === 'verify') return verifyAttestation(ctx);
  return fail('R4_ATTEST_CLI_USAGE');
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main(process.argv.slice(2)).then(out => console.log(JSON.stringify(out, null, 2)), error => { console.error(error.message); process.exit(1); });
}
