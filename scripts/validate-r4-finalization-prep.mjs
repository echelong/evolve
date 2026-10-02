// R4 FINALIZATION PREP VALIDATOR. Mutation cases use isolated temp trees/copies;
// the real evidence is only READ (inventory re-walk) and never written.
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  R4_ARCHIVE_MANIFEST_FILE, R4_ARCHIVE_PATH, R4_C1_COMMIT, R4_INVENTORY_FILE, R4_PREP_DIR, R4_PREP_REPO_ROOT, R4_RECIPE_FILE, R4_SESSION_ROOT,
  aggregateDigest, archiveCloneSmoke, assertInventoryRecord, assertManifestRecord, buildInventoryFiles, createInventoryRecord,
  verifyArchive, verifyInventoryAgainstDisk, writeReadOnlyRecord,
} from './r4-finalization-prep.mjs';
import { resolveR4ExecutionAuthority } from './r4-approval.mjs';
import { R4_REQUIRED_BOUND_FILES } from './r4-protocol-spec.mjs';

const root = R4_PREP_REPO_ROOT;
const git = (args, opts = {}) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const tmp = mkdtempSync(path.join(tmpdir(), 'r4-prep-validate-'));
let passed = 0;
const ok = (name, fn) => { fn(); passed += 1; console.log(`ok - ${name}`); };
const archiveDir = path.join(root, R4_ARCHIVE_PATH);
const prepDir = path.join(root, R4_PREP_DIR);
const rejects = (fn, re) => assert.throws(fn, re);

/** Synthetic evidence tree with the same layout (six attestations/sessions). */
function fixtureTree(dir, { order = 'asc' } = {}) {
  const ids = ['a1', 'b2', 'c3', 'd4', 'e5', 'f6'];
  for (const r of ['governance/r4', '.evolve/governance/r4-attempts', '.evolve/governance/r4-outcome-authorizations', '.evolve/market-outcomes/run', '.evolve/governance/r4-attestations']) mkdirSync(path.join(dir, r), { recursive: true });
  const seq = order === 'asc' ? ids : [...ids].reverse();
  for (const id of seq) {
    writeFileSync(path.join(dir, `.evolve/governance/r4-attestations/${id}.json`), `{"id":"${id}"}`);
    mkdirSync(path.join(dir, R4_SESSION_ROOT, id), { recursive: true });
    writeFileSync(path.join(dir, R4_SESSION_ROOT, id, 'frames.ndjson'), `frames-${id}\n`);
  }
  writeFileSync(path.join(dir, 'governance/r4/seal.json'), '{"seal":1}');
  writeFileSync(path.join(dir, '.evolve/market-outcomes/run/summary.json'), '{"x":1}');
  return dir;
}
const first = path.join(tmp, 'ev1');

try {
  const headBefore = git(['rev-parse', 'HEAD']);
  const evidenceBefore = readFileSync(path.join(prepDir, R4_INVENTORY_FILE), 'utf8');

  ok('archive main is exact C1 + fsck passes', () => {
    assert.equal(git(['--git-dir', archiveDir, 'rev-parse', 'refs/heads/main']), R4_C1_COMMIT);
    assert.deepEqual(verifyArchive({ archiveDir }), { archiveMainCommit: R4_C1_COMMIT, archiveFsckPassed: true });
  });
  ok('archive clone: HEAD, origin/main exact C1; Stage C resolves from the clone', () => {
    const clone = path.join(tmp, 'clone');
    const res = archiveCloneSmoke({ archiveDir, cloneDir: clone });
    assert.equal(res.archiveCloneHead, R4_C1_COMMIT);
    assert.equal(res.archiveCloneRemoteMain, R4_C1_COMMIT);
    assert.equal(res.stageCResolvedFromArchiveClone, true);
    rmSync(clone, { recursive: true, force: true });
  });
  ok('wrong archive main rejected', () => {
    const copy = path.join(tmp, 'wrongmain.git');
    execFileSync('git', ['clone', '--bare', '--quiet', archiveDir, copy]);
    git(['--git-dir', copy, 'update-ref', 'refs/heads/main', `${R4_C1_COMMIT}~1`]);
    rejects(() => verifyArchive({ archiveDir: copy }), /R4_PREP_ARCHIVE_MAIN_MISMATCH/);
  });
  ok('corrupt archive rejected', () => {
    const copy = path.join(tmp, 'corrupt.git');
    execFileSync('git', ['clone', '--bare', '--quiet', '--no-hardlinks', archiveDir, copy]);
    const packDir = path.join(copy, 'objects/pack');
    for (const f of readdirSync(packDir).filter(n => n.endsWith('.pack'))) {
      chmodSync(path.join(packDir, f), 0o644);
      truncateSync(path.join(packDir, f), 64);
    }
    rejects(() => verifyArchive({ archiveDir: copy }), /R4_PREP_ARCHIVE_(FSCK_FAILED|MAIN_UNREADABLE|MAIN_MISMATCH)/);
  });
  ok('evidence mutation / addition / removal detected (isolated copy)', () => {
    fixtureTree(first);
    const rec = createInventoryRecord({ evidenceRoot: first });
    assert.equal(verifyInventoryAgainstDisk(rec, { evidenceRoot: first }), rec.aggregateDigest);
    for (const [label, mutate, re] of [
      ['mutate', d => writeFileSync(path.join(d, 'governance/r4/seal.json'), '{"seal":2}'), /FILE_MUTATED/],
      ['add', d => writeFileSync(path.join(d, 'governance/r4/extra.json'), '{}'), /FILE_ADDED/],
      ['remove', d => rmSync(path.join(d, 'governance/r4/seal.json')), /FILE_REMOVED/],
    ]) {
      const d = path.join(tmp, `ev-${label}`);
      cpSync(first, d, { recursive: true });
      mutate(d);
      rejects(() => verifyInventoryAgainstDisk(rec, { evidenceRoot: d }), re);
    }
  });
  ok('inventory order and aggregate digest are deterministic', () => {
    const second = fixtureTree(path.join(tmp, 'ev2'), { order: 'desc' });
    const a = buildInventoryFiles({ evidenceRoot: first });
    const b = buildInventoryFiles({ evidenceRoot: second });
    assert.deepEqual(a.files, b.files);
    assert.equal(aggregateDigest(a.files), aggregateDigest(b.files));
    assert.deepEqual(a.files.map(f => f.path), [...a.files.map(f => f.path)].sort());
  });
  ok('symlink in evidence is rejected, not followed', () => {
    const d = path.join(tmp, 'ev-link');
    cpSync(first, d, { recursive: true });
    symlinkSync('/etc/hostname', path.join(d, 'governance/r4/link'));
    rejects(() => buildInventoryFiles({ evidenceRoot: d }), /SYMLINK_REJECTED/);
  });
  ok('duplicate creation rejected, record is 0444', () => {
    const f = path.join(tmp, 'once.json');
    writeReadOnlyRecord(f, '{}\n');
    assert.equal(statSync(f).mode & 0o777, 0o444);
    rejects(() => writeReadOnlyRecord(f, '{}\n'), /EEXIST/);
  });
  ok('real records are 0444, verify, and schemas are closed', () => {
    for (const n of [R4_INVENTORY_FILE, R4_ARCHIVE_MANIFEST_FILE, R4_RECIPE_FILE]) assert.equal(statSync(path.join(prepDir, n)).mode & 0o777, 0o444);
    const inv = JSON.parse(evidenceBefore);
    const man = JSON.parse(readFileSync(path.join(prepDir, R4_ARCHIVE_MANIFEST_FILE), 'utf8'));
    assertInventoryRecord(inv); assertManifestRecord(man);
    assert.equal(man.evidenceInventoryDigest, inv.aggregateDigest);
    assert.equal(man.evidenceFileCount, inv.fileCount);
    rejects(() => assertManifestRecord({ ...man, tau: 0.1 }), /SCHEMA_NOT_CLOSED/);
    rejects(() => assertInventoryRecord({ ...inv, extra: 1 }), /SCHEMA_NOT_CLOSED/);
    rejects(() => assertManifestRecord({ ...man, archiveMainCommit: 'f'.repeat(40) }), /R4_PREP_MANIFEST_archiveMainCommit/);
  });
  ok('no analysis / outcome generation / network in prep sources', () => {
    const src = readFileSync(path.join(root, 'scripts/r4-finalization-prep.mjs'), 'utf8');
    const forbidden = [['run', 'Canonical', 'R4Analysis('], ['generate', 'Outcome', 'Run('], ['fe', 'tch('], ['node:', 'http'], ['node:', 'net'], ['r4-canonical', '-analysis'], ['r4-outcome', '-generate']].map(p => p.join(''));
    for (const word of forbidden) assert.ok(!src.includes(word), `forbidden token ${word}`);
  });
  ok('real evidence unchanged: full re-walk matches the frozen inventory', () => {
    assert.equal(verifyInventoryAgainstDisk(JSON.parse(evidenceBefore)), JSON.parse(evidenceBefore).aggregateDigest);
  });
  ok('all 71 bound files unchanged vs C1', () => {
    assert.equal(R4_REQUIRED_BOUND_FILES.length, 71);
    assert.equal(git(['diff', '--name-only', R4_C1_COMMIT, '--', ...R4_REQUIRED_BOUND_FILES]), '');
    assert.equal(git(['status', '--porcelain', '--', ...R4_REQUIRED_BOUND_FILES]), '');
  });
  ok('production Stage C resolves; HEAD and live origin/main remain C1', () => {
    assert.equal(resolveR4ExecutionAuthority({ cwd: root, requireApproval: true }).stage, 'C');
    assert.equal(git(['rev-parse', 'HEAD']), R4_C1_COMMIT);
    assert.equal(headBefore, R4_C1_COMMIT);
    assert.match(git(['ls-remote', 'origin', 'refs/heads/main']), new RegExp(`^${R4_C1_COMMIT}\\s`));
  });
  console.log(`PASS ${passed} checks`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
