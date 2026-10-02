// R4 RESULT ATTESTATION VALIDATOR.
//
// Every scientific-path case runs against an isolated synthetic fixture (a temp
// git repo + temp bare archive + synthetic evidence tree and STUB canonical
// modules). This validator NEVER runs the real canonical analysis, NEVER imports
// a real review, and NEVER writes into the real attestation directory. Against
// the real repository it only READS (git state, Stage C resolution, a full
// re-hash of the frozen evidence inventory, file modes).
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from './market-intelligence/definition.mjs';
import { lockedAnalysisParameters } from './r4-enforcement.mjs';
import { R4_REQUIRED_BOUND_FILES } from './r4-protocol-spec.mjs';
import { resolveR4ExecutionAuthority } from './r4-approval.mjs';
import {
  R4_ARCHIVE_MANIFEST_FILE, R4_ATTESTATION_CONSTANTS, R4_ATTESTATION_DIR, R4_ATTESTATION_FORBIDDEN_OVERRIDES, R4_CLAIM_FILE, R4_INVENTORY_FILE,
  R4_PREP_DIR, R4_RESULT_FILE, R4_REVIEW_FILE, R4_SESSION_ROOT, assertResult, executeAttestation, importReview, productionContext, sealRecord,
  selfHashes, verifyArchiveRepo, verifyAttestation, verifyFrozenInventory, verifyPreconditions, verifyProductionAuthority, writeOnce,
} from './r4-result-attestation.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const ATTESTER = path.join(here, 'r4-result-attestation.mjs');
const VALIDATOR = fileURLToPath(import.meta.url);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tmp = mkdtempSync(path.join(tmpdir(), 'r4-attest-validate-'));
let passed = 0;
const ok = async (name, fn) => { await fn(); passed += 1; console.log(`ok - ${name}`); };
const rejects = (promiseOrFn, re) => assert.rejects(async () => (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn), re);
const throwsSync = (fn, re) => assert.throws(fn, re);

/* ------------------------------------------------------------------ fixture */

const IDS = ['a1', 'b2', 'c3', 'd4', 'e5', 'f6'];
const H = ch => ch.repeat(64);
let fixtureCounter = 0;

function walkFiles(base, rel, out) {
  const abs = path.join(base, rel);
  const st = statSync(abs);
  if (st.isDirectory()) { for (const n of readdirSync(abs).sort()) walkFiles(base, `${rel}/${n}`, out); return; }
  out.push({ path: rel, size: st.size, sha256: sha(readFileSync(abs)) });
}

/**
 * Synthetic world: repo (2 commits, origin = bare archive), evidence tree, frozen
 * inventory + archive manifest, outcome authorization record, stub canonical modules.
 */
function makeFixture({ manifestFingerprint = null, manifestAuthFp = null } = {}) {
  const dir = path.join(tmp, `fx${fixtureCounter += 1}`);
  const repo = path.join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  sh('git', ['init', '-q', '-b', 'main'], repo);
  sh('git', ['config', 'user.email', 't@example.invalid'], repo); sh('git', ['config', 'user.name', 'T'], repo);
  writeFileSync(path.join(repo, 'bound.txt'), 'v1\n'); sh('git', ['add', '.'], repo); sh('git', ['commit', '-qm', 'one'], repo);
  const parent = sh('git', ['rev-parse', 'HEAD'], repo);
  writeFileSync(path.join(repo, 'bound.txt'), 'v2\n'); sh('git', ['commit', '-qam', 'two'], repo);
  const c1 = sh('git', ['rev-parse', 'HEAD'], repo);
  const archive = path.join(dir, 'archive.git');
  sh('git', ['clone', '-q', '--bare', '--no-local', repo, archive]);
  sh('git', ['--git-dir', archive, 'repack', '-adq']);
  sh('git', ['remote', 'add', 'origin', archive], repo);
  sh('git', ['fetch', '-q', 'origin'], repo);

  for (const r of ['governance/r4', '.evolve/governance/r4-attempts', '.evolve/governance/r4-outcome-authorizations', '.evolve/governance/r4-attestations', R4_PREP_DIR]) mkdirSync(path.join(repo, r), { recursive: true });
  const runId = 'synthetic-run-0001';
  mkdirSync(path.join(repo, '.evolve/market-outcomes', runId), { recursive: true });
  writeFileSync(path.join(repo, '.evolve/market-outcomes', runId, 'manifest.json'), '{"synthetic":true}\n');
  writeFileSync(path.join(repo, 'governance/r4/seal.json'), '{"seal":1}\n');
  writeFileSync(path.join(repo, '.evolve/governance/r4-attempts/attempt-1.json'), '{"n":1}\n');
  for (const id of IDS) {
    writeFileSync(path.join(repo, `.evolve/governance/r4-attestations/${id}.json`), `{"id":"${id}"}\n`);
    mkdirSync(path.join(repo, R4_SESSION_ROOT, id), { recursive: true });
    writeFileSync(path.join(repo, R4_SESSION_ROOT, id, 'frames.ndjson'), `frames-${id}\n`);
  }
  const fp = { a2: H('1'), s6: H('2'), c1: H('3'), bind: H('4'), outRun: manifestFingerprint ?? H('5') };
  const auth = sealRecord({ recordType: 'synthetic_outcome_authorization', runId, scientificApprovalFingerprint: fp.a2, runtimeSealFingerprint: fp.s6, continuationFingerprint: fp.c1 });
  writeFileSync(path.join(repo, '.evolve/governance/r4-outcome-authorizations/outcome-authorization-0001.json'), `${JSON.stringify(auth)}\n`);

  const roots = ['governance/r4', '.evolve/governance/r4-attempts', '.evolve/governance/r4-attestations', '.evolve/governance/r4-outcome-authorizations',
    '.evolve/market-outcomes', ...IDS.map(id => `${R4_SESSION_ROOT}/${id}`)];
  const files = [];
  for (const r of roots) walkFiles(repo, r, files);
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  const aggregate = digest(files);
  const inventory = sealRecord({ schemaVersion: 1, recordType: 'r4_evidence_inventory', c1Commit: c1, roots, files, fileCount: files.length,
    totalBytes: files.reduce((n, f) => n + f.size, 0), aggregateDigest: aggregate, createdAt: 1 });
  const manifest = sealRecord({ schemaVersion: 1, recordType: 'r4_archival_c1_manifest', status: 'ARCHIVE_READY', c1Commit: c1, archivePath: 'archive.git',
    archiveMainCommit: c1, archiveFsckPassed: true, archiveCloneSmokePassed: true, archiveCloneHead: c1, archiveCloneRemoteMain: c1,
    stageCResolvedFromArchiveClone: true, evidenceInventoryPath: `${R4_PREP_DIR}/${R4_INVENTORY_FILE}`, evidenceInventoryDigest: aggregate,
    evidenceFileCount: files.length, createdAt: 2 });
  for (const [name, rec] of [[R4_INVENTORY_FILE, inventory], [R4_ARCHIVE_MANIFEST_FILE, manifest]]) {
    writeFileSync(path.join(repo, R4_PREP_DIR, name), `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o444 });
    chmodSync(path.join(repo, R4_PREP_DIR, name), 0o444);
  }
  const membership = [...IDS].sort();
  const constants = Object.freeze({
    c1Commit: c1, a2Commit: 'a'.repeat(40), s6Commit: 'b'.repeat(40), t0: 1700000000000,
    inventoryFileCount: files.length, inventoryTotalBytes: inventory.totalBytes, inventoryAggregateDigest: aggregate,
    archiveManifestFingerprint: manifest.fingerprint, canonicalMembershipDigest: digest(membership), referenceCount: 5, referenceSetDigest: H('6'),
    outcomeAuthorizationFingerprint: auth.fingerprint, outcomeRunId: runId, outcomeRunFingerprint: fp.outRun,
  });
  const counters = { analysis: 0, lastOptions: null };
  const resolution = { stage: 'C', approvalCommit: constants.a2Commit, approvalEpoch: 2, approvalFingerprint: fp.a2, authority: { sealAuthorityCommit: constants.s6Commit },
    seal: { fingerprint: fp.s6 }, continuationCommit: c1, continuationFingerprint: fp.c1, continuationContext: {}, t0: constants.t0 };
  const stubManifest = { fingerprint: fp.outRun, runId, sealedCode: { authorizationFingerprint: manifestAuthFp ?? auth.fingerprint } };
  const mods = {
    approval: { resolveR4ExecutionAuthority: () => resolution },
    history: { loadR4AttemptHistory: () => ({}), verifyR4AttemptHistory: () => ({}), historyAttestations: () => [], historyToCohortAttempts: () => [], historyAttemptAuthorityIndex: () => [] },
    enforcement: { R4_SESSION_DIR_ROOT: 'x', planSealedCohort: () => ({}), deriveCanonicalCohortMembership: () => ({ canonicalMembership: membership }),
      buildCanonicalReferenceSetFromEvidence: () => ({ references: new Array(5).fill({}), digest: constants.referenceSetDigest }),
      buildOutcomeRunBinding: () => ({ fingerprint: fp.bind }) },
    outcomes: { verifyOutcomeRun: () => stubManifest },
    analysis: {
      runCanonicalR4Analysis(options) {
        counters.analysis += 1; counters.lastOptions = options;
        return {
          identity: { authorityStage: 'C', approvalCommit: constants.a2Commit, authorityCommit: constants.s6Commit, t0: constants.t0, approvalFingerprint: fp.a2,
            sealFingerprint: fp.s6, continuationFingerprint: fp.c1, canonicalMembershipDigest: constants.canonicalMembershipDigest, referenceSetDigest: constants.referenceSetDigest,
            outcomeRunFingerprint: fp.outRun, outcomeBindingFingerprint: options.outcomeRunBinding.fingerprint },
          analysis: { sealFingerprint: fp.s6, referenceSetDigest: constants.referenceSetDigest, lockedParameters: lockedAnalysisParameters(), syntheticMarker: 'SYNTH',
            developmentOnly: true, researchOnly: true, paperOnly: true, observerOnly: true, tradingAuthority: false, engineAuthority: false, arenaEligible: false,
            promotionEligible: false, profitabilityInferencePermitted: false },
          sessions: [{ RAW_SESSION_SENTINEL: true }], outcomes: [{ RAW_OUTCOME_SENTINEL: true }], exposureRows: [{ RAW_EXPOSURE_SENTINEL: true }], references: [{ RAW_REF_SENTINEL: true }],
        };
      },
    },
  };
  let clock = 1_800_000_000_000;
  const ctx = { repoRoot: repo, evidenceRoot: repo, constants, archiveDir: archive, attestDir: path.join(repo, R4_ATTESTATION_DIR), boundFiles: ['bound.txt'],
    selfFiles: { attester: ATTESTER, validator: VALIDATOR }, loadModules: async () => mods, verifyOutcomeRun: () => stubManifest,
    lockedParameters: lockedAnalysisParameters, now: () => (clock += 1000), tmpRoot: dir };
  return { dir, repo, archive, parent, c1, ctx, counters, constants, fp, mods };
}

const reviewFor = (ctx, overrides = {}) => {
  const base = { schemaVersion: 1, recordType: 'r4_result_attestation_review', attestationGeneration: 1, verdict: 'READY_TO_ATTEST_R4_RESULT',
    reviewerIdentity: 'synthetic-reviewer', reviewerModel: 'synthetic-model', reviewedAt: 1_800_000_000_000, implementationHashes: selfHashes(ctx),
    archiveManifestFingerprint: ctx.constants.archiveManifestFingerprint, evidenceInventoryDigest: ctx.constants.inventoryAggregateDigest, c1Commit: ctx.constants.c1Commit,
    outcomeRunFingerprint: ctx.constants.outcomeRunFingerprint, noPriorResultValuesAreInputs: true, exactlyOneCanonicalCall: true, blockers: [], ...overrides };
  return sealRecord(base);
};
const stageReview = (fx, overrides) => {
  const p = path.join(fx.dir, `review-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify(reviewFor(fx.ctx, overrides)));
  return p;
};
async function attested() {
  const fx = makeFixture();
  importReview(fx.ctx, stageReview(fx));
  fx.result = await executeAttestation(fx.ctx);
  return fx;
}
const rewrite = (file, mutate, { reseal = true, mode = 0o444 } = {}) => {
  const rec = JSON.parse(readFileSync(file, 'utf8'));
  mutate(rec);
  const { fingerprint, ...body } = rec;
  const out = reseal ? sealRecord(body) : rec;
  chmodSync(file, 0o644); writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`); chmodSync(file, mode);
};
const resultFile = fx => path.join(fx.ctx.attestDir, R4_RESULT_FILE);

/** Source of an exported/declared function, comments stripped. */
const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
const attesterSource = stripComments(readFileSync(ATTESTER, 'utf8'));
const slice = (start, end) => { const a = attesterSource.indexOf(start); const b = attesterSource.indexOf(end, a + 1); assert.ok(a >= 0 && b > a, `slice ${start}`); return attesterSource.slice(a, b); };
const executeBody = slice('export async function executeAttestation', 'async function verifyPreconditionsInClone');
const verifyBody = slice('export function verifyAttestation', 'async function main');
const reviewBody = `${slice('export function assertReview', 'export function importReview')}${slice('export function importReview', 'function withArchiveClone')}`;
const preBody = `${slice('export async function verifyPreconditions', 'export function assertClaim')}${slice('async function verifyPreconditionsInClone', 'export function verifyAttestation')}`;

const prepDir = path.join(root, R4_PREP_DIR);
const realAttestDir = path.join(root, R4_ATTESTATION_DIR);
const prepBefore = readdirSync(prepDir).map(n => [n, sha(readFileSync(path.join(prepDir, n)))]);
const boundBefore = sh('git', ['status', '--porcelain', '--', ...R4_REQUIRED_BOUND_FILES], root);
const realAttestExisted = existsSync(realAttestDir);

try {
  const cases = [];
  const t = (name, fn) => cases.push([name, fn]);

  t('1 accepted synthetic happy path: review -> claim -> single call -> result -> verify', async () => {
    const fx = await attested();
    assert.equal(fx.counters.analysis, 1);
    assert.equal(fx.result.status, 'ATTESTED');
    assert.equal(fx.result.purpose, 'R4_RESULT_ATTESTATION_REPRODUCTION');
    assert.equal(fx.counters.lastOptions.repoRoot.includes('r4-attest-clone-'), true);
    assert.equal(fx.counters.lastOptions.evidenceRoot, fx.repo);
    assert.deepEqual(Object.keys(fx.counters.lastOptions).sort(), ['evidenceRoot', 'outcomeRunBinding', 'outcomeRunDir', 'readOutcomes', 'repoRoot']);
    assert.equal(verifyAttestation(fx.ctx).result, fx.result.fingerprint);
    assert.equal(fx.counters.analysis, 1, 'verify must not analyze');
  });
  t('2 archive main != C1 fails', async () => {
    const fx = makeFixture();
    sh('git', ['--git-dir', fx.archive, 'update-ref', 'refs/heads/main', fx.parent]);
    throwsSync(() => verifyArchiveRepo(fx.ctx), /R4_ATTEST_ARCHIVE_MAIN_NOT_C1/);
    await rejects(verifyPreconditions(fx.ctx), /R4_ATTEST_(PRODUCTION_REMOTE_MAIN_NOT_C1|ARCHIVE_MAIN_NOT_C1)/);
  });
  t('3 origin/main mismatch fails', async () => {
    const fx = makeFixture();
    sh('git', ['--git-dir', fx.archive, 'update-ref', 'refs/heads/main', fx.parent]);
    throwsSync(() => verifyProductionAuthority(fx.ctx), /R4_ATTEST_PRODUCTION_REMOTE_MAIN_NOT_C1/);
  });
  t('4 archive corruption fails fsck', async () => {
    const fx = makeFixture();
    const packs = path.join(fx.archive, 'objects/pack');
    for (const f of readdirSync(packs).filter(n => n.endsWith('.pack'))) { chmodSync(path.join(packs, f), 0o644); truncateSync(path.join(packs, f), 32); }
    throwsSync(() => verifyArchiveRepo(fx.ctx), /R4_ATTEST_ARCHIVE_(FSCK_FAILED|MAIN_UNREADABLE|MAIN_NOT_C1)/);
  });
  t('5 inventory digest mismatch fails', async () => {
    const fx = makeFixture();
    throwsSync(() => verifyFrozenInventory({ ...fx.ctx, constants: { ...fx.constants, inventoryAggregateDigest: H('9') } }), /INVENTORY_DIGEST_MISMATCH/);
  });
  t('6-9 evidence mutation / addition / removal / symlink substitution fail', async () => {
    const mutate = fn => { const fx = makeFixture(); fn(fx); return fx; };
    throwsSync(() => verifyFrozenInventory(mutate(fx => writeFileSync(path.join(fx.repo, 'governance/r4/seal.json'), '{"seal":2}\n')).ctx), /FILE_MUTATED/);
    throwsSync(() => verifyFrozenInventory(mutate(fx => writeFileSync(path.join(fx.repo, 'governance/r4/new.json'), '{}\n')).ctx), /FILE_ADDED/);
    throwsSync(() => verifyFrozenInventory(mutate(fx => rmSync(path.join(fx.repo, 'governance/r4/seal.json'))).ctx), /FILE_REMOVED/);
    throwsSync(() => verifyFrozenInventory(mutate(fx => { rmSync(path.join(fx.repo, 'governance/r4/seal.json')); symlinkSync('/etc/hostname', path.join(fx.repo, 'governance/r4/seal.json')); }).ctx), /SYMLINK/);
    // same-size content change is still caught (hash, not just size)
    throwsSync(() => verifyFrozenInventory(mutate(fx => writeFileSync(path.join(fx.repo, 'governance/r4/seal.json'), '{"seal":9}\n')).ctx), /FILE_MUTATED/);
  });
  t('10 outcome run fingerprint mismatch fails', async () => {
    const fx = makeFixture();
    const wrongRun = () => ({ fingerprint: H('e'), runId: fx.constants.outcomeRunId, sealedCode: { authorizationFingerprint: fx.constants.outcomeAuthorizationFingerprint } });
    const bad = { ...fx.ctx, loadModules: async () => ({ ...fx.mods, outcomes: { verifyOutcomeRun: wrongRun } }) };
    await rejects(verifyPreconditions(bad), /OUTCOME_RUN_FINGERPRINT_MISMATCH/);
  });
  t('11 outcome authorization fingerprint mismatch fails', async () => {
    const fx = makeFixture({ manifestAuthFp: H('d') });
    await rejects(verifyPreconditions(fx.ctx), /OUTCOME_AUTHORIZATION_BINDING_MISMATCH/);
  });
  t('12 review missing fails (no claim created)', async () => {
    const fx = makeFixture();
    await rejects(executeAttestation(fx.ctx), /R4_ATTEST_REVIEW_MISSING/);
    assert.equal(fx.counters.analysis, 0);
    assert.equal(existsSync(path.join(fx.ctx.attestDir, R4_CLAIM_FILE)), false);
  });
  t('13-16 review: wrong verdict / blockers / hash mismatch / inventory mismatch fail', async () => {
    const fx = makeFixture();
    const imp = o => importReview(fx.ctx, stageReview(fx, o));
    throwsSync(() => imp({ verdict: 'READY' }), /REVIEW_VERDICT/);
    throwsSync(() => imp({ blockers: ['x'] }), /REVIEW_BLOCKERS/);
    throwsSync(() => imp({ implementationHashes: { attester: H('0'), validator: selfHashes(fx.ctx).validator } }), /REVIEW_IMPLEMENTATION_HASH_MISMATCH/);
    throwsSync(() => imp({ implementationHashes: { attester: selfHashes(fx.ctx).attester, validator: H('0') } }), /REVIEW_IMPLEMENTATION_HASH_MISMATCH/);
    throwsSync(() => imp({ evidenceInventoryDigest: H('0') }), /REVIEW_INVENTORY_MISMATCH/);
    throwsSync(() => imp({ noPriorResultValuesAreInputs: false }), /REVIEW_DECLARATIONS/);
    throwsSync(() => imp({ extra: 1 }), /SCHEMA_NOT_CLOSED/);
    assert.equal(existsSync(path.join(fx.ctx.attestDir, R4_REVIEW_FILE)), false);
  });
  t('17 claim missing before result fails verify', async () => {
    const fx = await attested();
    rmSync(path.join(fx.ctx.attestDir, R4_CLAIM_FILE));
    throwsSync(() => verifyAttestation(fx.ctx), /CLAIM_MISSING/);
  });
  t('18-19 duplicate claim fails (O_EXCL); existing claim blocks a second execution', async () => {
    const fx = await attested();
    throwsSync(() => writeOnce(path.join(fx.ctx.attestDir, R4_CLAIM_FILE), 'x'), /EEXIST/);
    await rejects(executeAttestation(fx.ctx), /ALREADY_CLAIMED/);
    assert.equal(fx.counters.analysis, 1);
    const abandoned = makeFixture();
    importReview(abandoned.ctx, stageReview(abandoned));
    const failing = { ...abandoned.ctx, loadModules: async () => ({ ...abandoned.mods, analysis: { runCanonicalR4Analysis: () => { abandoned.counters.analysis += 1; throw new Error('boom'); } } }) };
    await rejects(executeAttestation(failing), /CLAIMED_ABANDONED/);
    await rejects(executeAttestation(abandoned.ctx), /ALREADY_CLAIMED/);
    assert.equal(abandoned.counters.analysis, 1, 'no automatic retry after abandonment');
    assert.equal(existsSync(path.join(abandoned.ctx.attestDir, R4_RESULT_FILE)), false);
  });
  t('20-21 claim / result mode != 0444 fails', async () => {
    const fx = await attested();
    chmodSync(path.join(fx.ctx.attestDir, R4_CLAIM_FILE), 0o644);
    throwsSync(() => verifyAttestation(fx.ctx), /CLAIM_MODE_NOT_0444/);
    chmodSync(path.join(fx.ctx.attestDir, R4_CLAIM_FILE), 0o444);
    chmodSync(resultFile(fx), 0o444 | 0o200);
    throwsSync(() => verifyAttestation(fx.ctx), /RESULT_MODE_NOT_0444/);
  });
  t('22-24 result fingerprint / identityDigest / analysisDigest mutation fails', async () => {
    const fx = await attested();
    rewrite(resultFile(fx), r => { r.t0 += 1; }, { reseal: false });
    throwsSync(() => verifyAttestation(fx.ctx), /RESULT_FINGERPRINT/);
    const fy = await attested();
    rewrite(resultFile(fy), r => { r.identityDigest = H('7'); });
    throwsSync(() => verifyAttestation(fy.ctx), /RESULT_IDENTITY_DIGEST/);
    const fz = await attested();
    rewrite(resultFile(fz), r => { r.analysisDigest = H('7'); });
    throwsSync(() => verifyAttestation(fz.ctx), /RESULT_ANALYSIS_DIGEST/);
    const fw = await attested();
    rewrite(resultFile(fw), r => { r.analysis.syntheticMarker = 'TAMPER'; });
    throwsSync(() => verifyAttestation(fw.ctx), /RESULT_ANALYSIS_DIGEST/);
  });
  t('25 unknown fields rejected (result / claim)', async () => {
    const fx = await attested();
    rewrite(resultFile(fx), r => { r.operatorNote = 'x'; });
    throwsSync(() => verifyAttestation(fx.ctx), /RESULT_SCHEMA_NOT_CLOSED/);
    const fy = await attested();
    rewrite(path.join(fy.ctx.attestDir, R4_CLAIM_FILE), r => { r.extra = 1; });
    throwsSync(() => verifyAttestation(fy.ctx), /CLAIM_SCHEMA_NOT_CLOSED/);
  });
  t('26-28 CLI rejects operator-supplied result / parameter / identity overrides (no real execution)', async () => {
    const attestExistedBefore = existsSync(realAttestDir);
    for (const key of R4_ATTESTATION_FORBIDDEN_OVERRIDES) {
      for (const cmd of ['execute', 'verify-preconditions', 'verify']) {
        const r = spawnSync(process.execPath, [ATTESTER, cmd, `--${key}=1`], { encoding: 'utf8', timeout: 60_000 });
        assert.notEqual(r.status, 0, `${cmd} --${key}`);
        assert.match(r.stderr, /R4_ATTEST_CLI_OVERRIDE_REJECTED/);
      }
    }
    for (const key of ['pointEstimate', 'ci', 'result', 'membership', 'references', 'bootstrapCount', 'seed', 'analysisParameters']) assert.ok(R4_ATTESTATION_FORBIDDEN_OVERRIDES.includes(key));
    assert.equal(existsSync(realAttestDir), attestExistedBefore);
  });
  t('29 no retry loop in the execute path', async () => {
    assert.doesNotMatch(executeBody, /\b(for|while|do)\s*[({]|\bretry\b|\.forEach\(|setTimeout|setInterval/);
  });
  t('30 exactly one canonical analysis call in the execute path', async () => {
    const token = /runCanonicalR4Analysis/g;
    assert.equal((attesterSource.match(token) ?? []).length, 1, 'single token in whole attester');
    assert.equal((executeBody.match(/runCanonicalR4Analysis\(/g) ?? []).length, 1);
    assert.equal((attesterSource.match(/executeAttestation\(/g) ?? []).length >= 1, true);
  });
  t('31-32 verify / review / precondition paths contain zero analysis calls (static + dynamic)', async () => {
    for (const body of [verifyBody, reviewBody, preBody]) assert.doesNotMatch(body, /runCanonicalR4Analysis|runRealR4PrimaryAnalysis|runPrimaryAnalysis/);
    const fx = makeFixture();
    importReview(fx.ctx, stageReview(fx));
    await verifyPreconditions(fx.ctx);
    assert.equal(fx.counters.analysis, 0);
    const done = await attested();
    verifyAttestation(done.ctx);
    assert.equal(done.counters.analysis, 1);
  });
  t('33-35 result excludes raw sessions / outcomes / exposure rows', async () => {
    const fx = await attested();
    const text = readFileSync(resultFile(fx), 'utf8');
    for (const s of ['RAW_SESSION_SENTINEL', 'RAW_OUTCOME_SENTINEL', 'RAW_EXPOSURE_SENTINEL', 'RAW_REF_SENTINEL']) assert.ok(!text.includes(s), s);
    const rec = JSON.parse(text);
    for (const k of ['sessions', 'outcomes', 'exposureRows', 'references']) assert.ok(!(k in rec) && !(k in rec.identity) && !(k in rec.analysis));
    rewrite(resultFile(fx), r => { r.identity.sessions = []; r.identityDigest = digest(r.identity); });
    throwsSync(() => verifyAttestation(fx.ctx), /RESULT_RAW_PAYLOAD:sessions/);
  });
  t('36 analysis must retain locked R4 parameters', async () => {
    const fx = await attested();
    assert.deepEqual(JSON.parse(readFileSync(resultFile(fx), 'utf8')).analysis.lockedParameters, JSON.parse(JSON.stringify(lockedAnalysisParameters())));
    rewrite(resultFile(fx), r => { r.analysis.lockedParameters = { ...r.analysis.lockedParameters, bootstrapReplicates: 1 }; r.analysisDigest = digest(r.analysis); });
    throwsSync(() => verifyAttestation(fx.ctx), /RESULT_LOCKED_PARAMETERS/);
  });
  t('37-38 tradingAuthority / profitabilityInferencePermitted cannot become true', async () => {
    for (const key of ['tradingAuthority', 'profitabilityInferencePermitted', 'engineAuthority', 'promotionEligible']) {
      const fx = await attested();
      rewrite(resultFile(fx), r => { r.analysis[key] = true; r.analysisDigest = digest(r.analysis); });
      throwsSync(() => verifyAttestation(fx.ctx), new RegExp(`RESULT_CLASSIFICATION:${key}`));
    }
    const fx = await attested();
    rewrite(resultFile(fx), r => { r.analysis.researchOnly = false; r.analysisDigest = digest(r.analysis); });
    throwsSync(() => assertResult(JSON.parse(readFileSync(resultFile(fx), 'utf8')), fx.ctx), /CLASSIFICATION:researchOnly/);
  });
  t('39 synthetic evidence inventory unchanged after a synthetic attestation', async () => {
    const fx = await attested();
    assert.equal(verifyFrozenInventory(fx.ctx).aggregateDigest, fx.constants.inventoryAggregateDigest);
  });
  t('anti-selection: result identity binding mismatch is refused before any write', async () => {
    const fx = makeFixture();
    importReview(fx.ctx, stageReview(fx));
    const wrong = { ...fx.ctx, loadModules: async () => ({ ...fx.mods, analysis: { runCanonicalR4Analysis: o => {
      const r = fx.mods.analysis.runCanonicalR4Analysis(o); r.identity.approvalCommit = 'c'.repeat(40); return r; } } }) };
    await rejects(executeAttestation(wrong), /RESULT_(IDENTITY_)?BINDING/);
    assert.equal(existsSync(path.join(fx.ctx.attestDir, R4_RESULT_FILE)), false);
  });
  t('static anti-result-selection audit of the attester', async () => {
    const raw = readFileSync(ATTESTER, 'utf8');
    const allowed = new Set(Object.values(R4_ATTESTATION_CONSTANTS).filter(v => typeof v === 'string'));
    for (const lit of raw.match(/\b[0-9a-f]{40,64}\b/g) ?? []) assert.ok(allowed.has(lit), `unrecognised hex literal ${lit}`);
    // No fractional literal (tau / CI style) and no gate on a result field anywhere in code.
    const code = attesterSource.replace(/'[^'\n]*'/g, "''"); // string literals (e.g. the forbidden-override name list) are not code
    assert.doesNotMatch(code, /(?<![\w.'"])-?\d*\.\d{3,}\b/);
    assert.doesNotMatch(code, /\b(pointEstimate|tauB|ciLower|ciUpper|distinctResolvedMintCount|resolvedReferenceCount|exposureRowsDigest|seedDigest|replicatesDefined|floorsMet|bootstrapDefined)\b/);
    assert.doesNotMatch(code, /process\.argv\[[^\]]*\]\.(split|match)|process\.env/);
    // The attester has no input channel for a result: only these argv shapes exist.
    assert.match(attesterSource, /R4_ATTEST_CLI_OVERRIDE_REJECTED/);
  });
  t('40-43 production: 71 bound files unchanged, Stage C resolves, HEAD and live origin/main are C1', async () => {
    const c1 = R4_ATTESTATION_CONSTANTS.c1Commit;
    assert.equal(R4_REQUIRED_BOUND_FILES.length, 71);
    assert.equal(sh('git', ['diff', '--name-only', c1, '--', ...R4_REQUIRED_BOUND_FILES], root), '');
    assert.equal(sh('git', ['status', '--porcelain', '--', ...R4_REQUIRED_BOUND_FILES], root), boundBefore);
    assert.equal(boundBefore, '');
    assert.equal(resolveR4ExecutionAuthority({ cwd: root, requireApproval: true }).stage, 'C');
    assert.equal(sh('git', ['rev-parse', 'HEAD'], root), c1);
    assert.match(sh('git', ['ls-remote', 'origin', 'refs/heads/main'], root), new RegExp(`^${c1}\\s`));
    assert.equal(verifyProductionAuthority(productionContext()).boundFileCount, 71);
  });
  t('real archive: main is C1 and fsck passes; archive manifest frozen', async () => {
    const ctx = productionContext();
    assert.equal(verifyArchiveRepo(ctx).archiveMainCommit, R4_ATTESTATION_CONSTANTS.c1Commit);
    assert.equal(JSON.parse(readFileSync(path.join(prepDir, R4_ARCHIVE_MANIFEST_FILE), 'utf8')).fingerprint, R4_ATTESTATION_CONSTANTS.archiveManifestFingerprint);
  });
  t('real evidence: frozen inventory still matches a full re-hash', async () => {
    const live = verifyFrozenInventory(productionContext());
    assert.equal(live.fileCount, 109);
    assert.equal(live.totalBytes, 3144793956);
    assert.equal(live.aggregateDigest, R4_ATTESTATION_CONSTANTS.inventoryAggregateDigest);
  });
  t('44 no real result-attestation artifacts were created', async () => {
    assert.equal(existsSync(realAttestDir), realAttestExisted);
    for (const f of [R4_REVIEW_FILE, R4_CLAIM_FILE, R4_RESULT_FILE]) assert.equal(existsSync(path.join(realAttestDir, f)), false, f);
  });
  t('45 no existing finalization-prep artifact was modified', async () => {
    const after = readdirSync(prepDir).map(n => [n, sha(readFileSync(path.join(prepDir, n)))]);
    assert.deepEqual(after, prepBefore);
    for (const [n] of after) assert.equal(statSync(path.join(prepDir, n)).mode & 0o777, 0o444);
  });

  for (const [name, fn] of cases) await ok(name, fn);
  console.log(`PASS ${passed} case groups`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
