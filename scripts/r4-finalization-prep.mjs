// R4 FINALIZATION PREPARATION — archive + evidence inventory ONLY.
//
// Creates the archival substrate required before a separate, explicitly
// authorized result-attestation task: a bare C1 Git archive, a deterministic
// read-only evidence inventory, an archive manifest and a reproduction recipe.
//
// It performs NO scientific computation: it never runs the canonical analysis,
// never generates outcomes, never contacts a provider and never writes into the
// R4 evidence/governance trees. Every record is written once
// (O_CREAT|O_EXCL), fsynced, directory-fsynced and chmod 0444.
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, digest } from './market-intelligence/definition.mjs';
import { fsyncDirectory, writeDurableExclusive } from './r4-capability.mjs';
import { resolveR4ExecutionAuthority } from './r4-approval.mjs';

export const R4_PREP_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const R4_C1_COMMIT = '1c30264fb87876eeaf229e25c5cdc5adca429b40';
export const R4_ARCHIVE_PATH = '.evolve/r4-archive/evolve-r4-c1.git';
export const R4_PREP_DIR = '.evolve/governance/r4-finalization-prep';
export const R4_INVENTORY_FILE = 'evidence-inventory-0001.json';
export const R4_ARCHIVE_MANIFEST_FILE = 'archive-0001.json';
export const R4_RECIPE_FILE = 'reproduction-recipe-0001.txt';
export const R4_INVENTORY_RECORD_TYPE = 'r4_evidence_inventory';
export const R4_ARCHIVE_RECORD_TYPE = 'r4_archival_c1_manifest';
export const R4_PREP_SCHEMA_VERSION = 1;

/** Directory roots inventoried whole. */
export const R4_INVENTORY_ROOTS = Object.freeze([
  'governance/r4',
  '.evolve/governance/r4-attempts',
  '.evolve/governance/r4-attestations',
  '.evolve/governance/r4-outcome-authorizations',
  '.evolve/market-outcomes',
]);
export const R4_SESSION_ROOT = '.evolve/market-intelligence/sessions';

const TEMP_NAME = /(\.tmp|\.partial|~)$/;
const fail = code => { throw new Error(code); };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (args, { cwd, gitDir } = {}) => execFileSync('git', gitDir ? ['--git-dir', gitDir, ...args] : args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

/* ----------------------------------------------------------------- inventory */

/** Stream-hash a file without loading it into memory (session files are large). */
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

/**
 * Walk `rel` under `evidenceRoot`. Safe symlink semantics: a symbolic link (or any
 * non-regular, non-directory entry) is NEVER followed or silently skipped — the
 * inventory is rejected. A temp-looking file is rejected as well.
 */
function walk(evidenceRoot, rel, out) {
  const abs = path.join(evidenceRoot, rel);
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) fail(`R4_PREP_INVENTORY_SYMLINK_REJECTED:${rel}`);
  if (st.isDirectory()) {
    for (const name of readdirSync(abs).sort()) walk(evidenceRoot, `${rel}/${name}`, out);
    return;
  }
  if (!st.isFile()) fail(`R4_PREP_INVENTORY_NON_REGULAR_REJECTED:${rel}`);
  if (TEMP_NAME.test(rel)) fail(`R4_PREP_INVENTORY_TEMP_FILE_REJECTED:${rel}`);
  out.push({ path: rel, size: st.size, sha256: hashFile(abs) });
}

/** Canonical session directories: exactly the members named by the attestations. */
export function canonicalSessionRoots({ evidenceRoot = R4_PREP_REPO_ROOT } = {}) {
  const dir = path.join(evidenceRoot, '.evolve/governance/r4-attestations');
  const ids = readdirSync(dir).filter(n => n.endsWith('.json')).map(n => n.slice(0, -5)).sort();
  if (ids.length !== 6) fail(`R4_PREP_SESSION_COUNT:${ids.length}`);
  return ids.map(id => `${R4_SESSION_ROOT}/${id}`);
}

export const compareBytewise = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function aggregateDigest(files) {
  return digest(files.map(({ path: p, size, sha256: h }) => ({ path: p, size, sha256: h })));
}

export function buildInventoryFiles({ evidenceRoot = R4_PREP_REPO_ROOT, roots = null } = {}) {
  const list = roots ?? [...R4_INVENTORY_ROOTS, ...canonicalSessionRoots({ evidenceRoot })];
  const files = [];
  for (const root of list) walk(evidenceRoot, root, files);
  files.sort((a, b) => compareBytewise(a.path, b.path));
  for (let i = 1; i < files.length; i += 1) if (files[i].path === files[i - 1].path) fail(`R4_PREP_INVENTORY_DUPLICATE:${files[i].path}`);
  return { roots: list, files };
}

const INVENTORY_KEYS = ['schemaVersion', 'recordType', 'c1Commit', 'roots', 'files', 'fileCount', 'totalBytes', 'aggregateDigest', 'createdAt', 'fingerprint'];
const MANIFEST_KEYS = ['schemaVersion', 'recordType', 'status', 'c1Commit', 'archivePath', 'archiveMainCommit', 'archiveFsckPassed',
  'archiveCloneSmokePassed', 'archiveCloneHead', 'archiveCloneRemoteMain', 'stageCResolvedFromArchiveClone', 'evidenceInventoryPath',
  'evidenceInventoryDigest', 'evidenceFileCount', 'createdAt', 'fingerprint'];

const withFingerprint = body => ({ ...body, fingerprint: digest(body) });
const assertClosed = (record, keys, what) => {
  const got = Object.keys(record).sort().join();
  if (got !== [...keys].sort().join()) fail(`R4_PREP_${what}_SCHEMA_NOT_CLOSED`);
};

export function createInventoryRecord({ evidenceRoot = R4_PREP_REPO_ROOT, now = Date.now } = {}) {
  const { roots, files } = buildInventoryFiles({ evidenceRoot });
  return withFingerprint({
    schemaVersion: R4_PREP_SCHEMA_VERSION, recordType: R4_INVENTORY_RECORD_TYPE, c1Commit: R4_C1_COMMIT,
    roots, files, fileCount: files.length, totalBytes: files.reduce((n, f) => n + f.size, 0),
    aggregateDigest: aggregateDigest(files), createdAt: now(),
  });
}

export function assertInventoryRecord(record) {
  assertClosed(record, INVENTORY_KEYS, 'INVENTORY');
  if (record.recordType !== R4_INVENTORY_RECORD_TYPE || record.schemaVersion !== R4_PREP_SCHEMA_VERSION) fail('R4_PREP_INVENTORY_TYPE');
  if (record.c1Commit !== R4_C1_COMMIT) fail('R4_PREP_INVENTORY_C1_MISMATCH');
  const sorted = [...record.files].sort((a, b) => compareBytewise(a.path, b.path));
  if (canonical(sorted) !== canonical(record.files)) fail('R4_PREP_INVENTORY_NOT_SORTED');
  for (const f of record.files) assertClosed(f, ['path', 'size', 'sha256'], 'INVENTORY_ENTRY');
  if (record.fileCount !== record.files.length) fail('R4_PREP_INVENTORY_COUNT');
  if (record.totalBytes !== record.files.reduce((n, f) => n + f.size, 0)) fail('R4_PREP_INVENTORY_BYTES');
  if (record.aggregateDigest !== aggregateDigest(record.files)) fail('R4_PREP_INVENTORY_AGGREGATE');
  const { fingerprint, ...body } = record;
  if (fingerprint !== digest(body)) fail('R4_PREP_INVENTORY_FINGERPRINT');
  return record;
}

/**
 * Re-walk `evidenceRoot` and compare to a recorded inventory. Detects modified,
 * added and removed files. Returns the live aggregate digest on success.
 */
export function verifyInventoryAgainstDisk(record, { evidenceRoot = R4_PREP_REPO_ROOT } = {}) {
  assertInventoryRecord(record);
  const { files } = buildInventoryFiles({ evidenceRoot, roots: record.roots });
  const want = new Map(record.files.map(f => [f.path, f]));
  const have = new Map(files.map(f => [f.path, f]));
  for (const p of have.keys()) if (!want.has(p)) fail(`R4_PREP_EVIDENCE_FILE_ADDED:${p}`);
  for (const p of want.keys()) if (!have.has(p)) fail(`R4_PREP_EVIDENCE_FILE_REMOVED:${p}`);
  for (const [p, f] of want) {
    const h = have.get(p);
    if (h.size !== f.size || h.sha256 !== f.sha256) fail(`R4_PREP_EVIDENCE_FILE_MUTATED:${p}`);
  }
  return aggregateDigest(files);
}

/* ------------------------------------------------------------------- archive */

export function createArchive({ repoRoot = R4_PREP_REPO_ROOT, archivePath = R4_ARCHIVE_PATH } = {}) {
  const dest = path.resolve(repoRoot, archivePath);
  mkdirSync(path.dirname(dest), { recursive: true });
  // An existing archive is reused (and verified by the caller), never overwritten;
  // `git clone --bare` itself refuses a non-empty destination.
  if (existsSync(dest)) return dest;
  execFileSync('git', ['clone', '--bare', '--no-hardlinks', '--quiet', repoRoot, dest], { stdio: ['ignore', 'pipe', 'pipe'] });
  return dest;
}

/** Verify the archive's main ref and `git fsck --full`. Throws on either failure. */
export function verifyArchive({ archiveDir, expectCommit = R4_C1_COMMIT }) {
  let main;
  try { main = git(['rev-parse', '--verify', 'refs/heads/main'], { gitDir: archiveDir }); } catch { fail('R4_PREP_ARCHIVE_MAIN_UNREADABLE'); }
  if (main !== expectCommit) fail('R4_PREP_ARCHIVE_MAIN_MISMATCH');
  try { execFileSync('git', ['--git-dir', archiveDir, 'fsck', '--full'], { stdio: ['ignore', 'pipe', 'pipe'] }); } catch { fail('R4_PREP_ARCHIVE_FSCK_FAILED'); }
  return { archiveMainCommit: main, archiveFsckPassed: true };
}

/**
 * Clone the archive into `cloneDir` (owned by the caller), check HEAD and
 * origin/main equal C1 and that Stage C resolves with repoRoot = the clone.
 * The caller removes `cloneDir`.
 */
export function archiveCloneSmoke({ archiveDir, cloneDir, expectCommit = R4_C1_COMMIT, resolve = resolveR4ExecutionAuthority }) {
  execFileSync('git', ['clone', '--quiet', archiveDir, cloneDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  const archiveCloneHead = git(['rev-parse', 'HEAD'], { cwd: cloneDir });
  const archiveCloneRemoteMain = git(['rev-parse', 'refs/remotes/origin/main'], { cwd: cloneDir });
  if (archiveCloneHead !== expectCommit) fail('R4_PREP_CLONE_HEAD_MISMATCH');
  if (archiveCloneRemoteMain !== expectCommit) fail('R4_PREP_CLONE_REMOTE_MAIN_MISMATCH');
  const resolution = resolve({ cwd: cloneDir, requireApproval: true });
  if (resolution.stage !== 'C') fail(`R4_PREP_CLONE_STAGE_NOT_C:${resolution.stage}`);
  return { archiveCloneSmokePassed: true, archiveCloneHead, archiveCloneRemoteMain, stageCResolvedFromArchiveClone: true };
}

export function createManifestRecord({ archive, smoke, inventory, inventoryPath, now = Date.now }) {
  return withFingerprint({
    schemaVersion: R4_PREP_SCHEMA_VERSION, recordType: R4_ARCHIVE_RECORD_TYPE, status: 'ARCHIVE_READY', c1Commit: R4_C1_COMMIT,
    archivePath: R4_ARCHIVE_PATH, archiveMainCommit: archive.archiveMainCommit, archiveFsckPassed: archive.archiveFsckPassed,
    archiveCloneSmokePassed: smoke.archiveCloneSmokePassed, archiveCloneHead: smoke.archiveCloneHead,
    archiveCloneRemoteMain: smoke.archiveCloneRemoteMain, stageCResolvedFromArchiveClone: smoke.stageCResolvedFromArchiveClone,
    evidenceInventoryPath: inventoryPath, evidenceInventoryDigest: inventory.aggregateDigest, evidenceFileCount: inventory.fileCount,
    createdAt: now(),
  });
}

export function assertManifestRecord(record) {
  assertClosed(record, MANIFEST_KEYS, 'MANIFEST');
  if (record.recordType !== R4_ARCHIVE_RECORD_TYPE || record.status !== 'ARCHIVE_READY') fail('R4_PREP_MANIFEST_TYPE');
  for (const k of ['c1Commit', 'archiveMainCommit', 'archiveCloneHead', 'archiveCloneRemoteMain']) if (record[k] !== R4_C1_COMMIT) fail(`R4_PREP_MANIFEST_${k}`);
  for (const k of ['archiveFsckPassed', 'archiveCloneSmokePassed', 'stageCResolvedFromArchiveClone']) if (record[k] !== true) fail(`R4_PREP_MANIFEST_${k}`);
  const { fingerprint, ...body } = record;
  if (fingerprint !== digest(body)) fail('R4_PREP_MANIFEST_FINGERPRINT');
  return record;
}

/* -------------------------------------------------------------------- writes */

/** Write once (O_CREAT|O_EXCL), fsync file + dir, chmod 0444, reread and verify. */
export function writeReadOnlyRecord(file, text) {
  writeDurableExclusive(file, text, { mode: 0o444 });
  chmodSync(file, 0o444);
  fsyncDirectory(path.dirname(file));
  if ((statSync(file).mode & 0o777) !== 0o444) fail('R4_PREP_RECORD_NOT_0444');
  if (readFileSync(file, 'utf8') !== text) fail('R4_PREP_RECORD_REREAD_MISMATCH');
  return file;
}
export const recordText = record => `${JSON.stringify(record, null, 2)}\n`;

export function reproductionRecipe({ inventory, archivePath = R4_ARCHIVE_PATH }) {
  return `EVOLVE R4 REPRODUCTION RECIPE 0001
==================================

Identities already on disk (no scientific result values are recorded here):
  C1 (runtime authority commit)   ${R4_C1_COMMIT}
  A2 (scientific approval)        9dc30de45ee0fc8c493c2582bae6378dae1fdc7b
  S6 (runtime seal)               f6583433eba00de1558a9f0c4845e1e7905e9877
  T0                              1790690400000
  canonicalMembershipDigest       7f5de0d51021e2446fcdf0ee4580a56043b8841a05171fd716cfe593faf7418b
  referenceCount                  3516
  referenceSetDigest              08fcf8b6f3a6d9d5498d41c981682185587204e9f648d8190ca42972027cbf94
  outcomeAuthorizationFingerprint 958f1c9de87339ceae6c5e15dc315d7c628d0db2a8c635ebd334f4336f6ff7ff
  outcomeRunFingerprint           73deb08124aa5bfce00ca227109a75c353ae52d2247c5768c3f0d7e8df640d58
  evidence inventory digest       ${inventory.aggregateDigest}
  evidence file count             ${inventory.fileCount}

Roles (do not conflate them):
  repoRoot     = the ARCHIVAL C1 CLONE (code + Git authority)
  evidenceRoot = the RETAINED REAL EVOLVE checkout (the .evolve evidence tree)

Steps
 1. Clone the archive into a fresh directory:
      git clone ${archivePath} <scratch>/r4-c1-clone
 2. Verify HEAD == origin/main == C1:
      git -C <scratch>/r4-c1-clone rev-parse HEAD refs/remotes/origin/main
    both must print ${R4_C1_COMMIT}. Stage C must resolve with
    resolveR4ExecutionAuthority({ cwd: <scratch>/r4-c1-clone, requireApproval: true }).
 3. Use the retained real EVOLVE checkout as evidenceRoot. Do not copy or edit it.
 4. Verify the evidence inventory digest: re-walk evidenceRoot with
    verifyInventoryAgainstDisk(<.evolve/governance/r4-finalization-prep/${R4_INVENTORY_FILE}>)
    from scripts/r4-finalization-prep.mjs; any modified, added or removed file aborts.
 5. Verify the finalized outcome run (verifyOutcomeAuthorization and verifyOutcomeRun
    against evidenceRoot) without regenerating it.
 6. Reconstruct the canonical outcome binding from authenticated evidence only
    (resolveCanonicalOutcomeFacts with cwd = repoRoot, evidenceRoot = evidenceRoot).
    Never accept operator-supplied tau/CI/digest values.
 7. Invoke runCanonicalR4Analysis exactly once (repoRoot = archival clone,
    evidenceRoot = retained real evidence root).
 8. Persist the resulting canonical analysis into a future result-attestation
    artifact (a separate, explicitly authorized task; not created by this prep).
 9. Once the frozen result-attestation artifact exists, compare the independently
    derived result against it field by field. Any difference fails reproduction.

This prep step itself executed no analysis, generated no outcomes and wrote
nothing into R4 evidence or governance.
`;
}

/* ----------------------------------------------------------------------- CLI */

export function runFinalizationPrep({ repoRoot = R4_PREP_REPO_ROOT, scratch }) {
  const prepDir = path.resolve(repoRoot, R4_PREP_DIR);
  const archiveDir = createArchive({ repoRoot });
  const archive = verifyArchive({ archiveDir });
  const cloneDir = path.join(scratch, 'r4-c1-smoke-clone');
  const smoke = archiveCloneSmoke({ archiveDir, cloneDir });
  mkdirSync(prepDir, { recursive: true });
  const inventory = createInventoryRecord({ evidenceRoot: repoRoot });
  const inventoryPath = `${R4_PREP_DIR}/${R4_INVENTORY_FILE}`;
  writeReadOnlyRecord(path.join(prepDir, R4_INVENTORY_FILE), recordText(inventory));
  assertInventoryRecord(JSON.parse(readFileSync(path.join(prepDir, R4_INVENTORY_FILE), 'utf8')));
  const manifest = createManifestRecord({ archive, smoke, inventory, inventoryPath });
  writeReadOnlyRecord(path.join(prepDir, R4_ARCHIVE_MANIFEST_FILE), recordText(manifest));
  assertManifestRecord(JSON.parse(readFileSync(path.join(prepDir, R4_ARCHIVE_MANIFEST_FILE), 'utf8')));
  writeReadOnlyRecord(path.join(prepDir, R4_RECIPE_FILE), reproductionRecipe({ inventory }));
  return { archive, smoke, inventory, manifest, cloneDir };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const scratch = process.argv[2];
  if (!scratch) { console.error('usage: node scripts/r4-finalization-prep.mjs <scratch-dir>'); process.exit(2); }
  const out = runFinalizationPrep({ scratch });
  console.log(JSON.stringify({ archive: out.archive, smoke: out.smoke, fileCount: out.inventory.fileCount,
    totalBytes: out.inventory.totalBytes, aggregateDigest: out.inventory.aggregateDigest,
    manifestFingerprint: out.manifest.fingerprint, cloneDir: out.cloneDir }, null, 2));
}
