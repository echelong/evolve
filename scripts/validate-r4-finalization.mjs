// R4 LIFECYCLE CLOSURE VALIDATOR.
//
// Every scientific-path case runs against an isolated synthetic fixture (a temp
// git repo + temp bare archive + synthetic attestation artifacts). This validator
// NEVER runs the canonical R4 analysis, NEVER calls the result-attestation
// execute path, NEVER generates an outcome, NEVER touches the network, and NEVER
// writes into the real finalization directory. Against the real repository it
// only READS (git state, Stage C, a full re-hash of the frozen evidence
// inventory, file modes, artifact hashes).
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from './market-intelligence/definition.mjs';
import { R4_REQUIRED_BOUND_FILES } from './r4-protocol-spec.mjs';
import {
  R4_CLOSURE_CONSTANTS, R4_CLOSURE_FORBIDDEN_OVERRIDES, R4_CLOSURE_REASON, R4_CLOSURE_STATUS, R4_COPIED_RESULT_FIELDS,
  R4_FINALIZATION_DIR, R4_FINALIZATION_FILE, R4_FINALIZATION_REVIEW_FILE, R4_OUTCOME_IDENTITY_KEYS,
  R4_OUTCOME_IDENTITY_SOURCES, R4_PRECONDITION_STATUS, R4_REPRODUCTION_MODE, R4_REVIEW_VERDICT,
  assertClosure, assertReview, closeR4, copyCohortIdentity, copyScientificResult, importReview, productionContext,
  readOutcomeAuthorization, readOutcomeChain, readResultAttestation, resolveOutcomeIdentities, sealRecord, selfHashes,
  verifyArchiveRepo, verifyClosure, verifyDurableConstants, verifyFrozenInventory,
  verifyPreconditions, verifyProductionState, writeOnce,
} from './r4-finalization.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const FINALIZER = path.join(here, 'r4-finalization.mjs');
const VALIDATOR = fileURLToPath(import.meta.url);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tmp = mkdtempSync(path.join(tmpdir(), 'r4-close-validate-'));
let passed = 0;
const ok = async (name, fn) => { await fn(); passed += 1; console.log(`ok - ${name}`); };
const rejects = (p, re) => assert.rejects(async () => (typeof p === 'function' ? p() : p), re);
const throwsSync = (fn, re) => assert.throws(fn, re);
const H = ch => ch.repeat(64);
const C40 = ch => ch.repeat(40);
/* ------------------------------------------------------------------ fixture */

// Synthetic values only. These are NOT the real R4 scientific result and are used
// exclusively inside throwaway fixtures.
const SYN = Object.freeze({
  availabilityDenominator: 777, resolvedReferenceCount: 555, distinctResolvedMintCount: 33,
  pointEstimate: 0.123456789, ciLower: 0.05, ciUpper: 0.2, bootstrapReplicates: 128, replicatesDefined: 120,
  floorsMet: true, seedDigest: H('1'), exposureRowsDigest: H('2'), spec: 'SYNTHETIC-SPEC-V0',
});
const IDS = ['s1', 's2', 's3', 's4', 's5', 's6'];
let fixtureCounter = 0;

/**
 * Synthetic world: a temp repo (2 commits, origin = bare archive) plus a synthetic
 * immutable result-attestation triple. Nothing scientific is computed here; the
 * synthetic attestation is written directly and the finalizer merely copies from it.
 */
function makeFixture({ constants = {}, attestationOutcome = {}, outcomeRunStub = null } = {}) {
  const dir = path.join(tmp, `fx${fixtureCounter += 1}`);
  const repo = path.join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  sh('git', ['init', '-q', '-b', 'main'], repo);
  sh('git', ['config', 'user.email', 't@example.invalid'], repo);
  sh('git', ['config', 'user.name', 'T'], repo);
  writeFileSync(path.join(repo, 'bound.txt'), 'v1\n');
  sh('git', ['add', '.'], repo); sh('git', ['commit', '-qm', 'one'], repo);
  const parent = sh('git', ['rev-parse', 'HEAD'], repo);
  writeFileSync(path.join(repo, 'bound.txt'), 'v2\n');
  sh('git', ['commit', '-qam', 'two'], repo);
  const c1 = sh('git', ['rev-parse', 'HEAD'], repo);
  const archive = path.join(dir, 'archive.git');
  sh('git', ['clone', '-q', '--bare', '--no-local', repo, archive]);
  sh('git', ['--git-dir', archive, 'repack', '-adq']);
  sh('git', ['remote', 'add', 'origin', archive], repo);
  sh('git', ['fetch', '-q', 'origin'], repo);

  // ---- authenticated durable outcome chain (authorization -> consumption -> run)
  // The finalizer must derive its outcome identities from THESE, not from its own
  // constants. Each record is self-sealed, so a constant can never self-validate.
  const write0444 = (rel, rec) => {
    const p = path.join(repo, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, `${JSON.stringify(rec, null, 2)}\n`);
    chmodSync(p, 0o444);
    return p;
  };
  const authorization = sealRecord({ schemaVersion: 1, recordType: 'r4_outcome_authorization', status: 'AUTHORIZED',
    blocked: false, authorizationGeneration: 1, runId: 'synthetic-run', attemptsUsed: 6, completedCount: 6,
    targetCompletedSessions: 6, maxAttempts: 8, canonicalMembership: [...IDS],
    canonicalMembershipDigest: digest([...IDS].sort()), referenceCount: SYN.availabilityDenominator,
    referenceSetDigest: H('5'), createdAt: 500, issuedAt: 500 });
  const manifest = sealRecord({ schemaVersion: 1, recordType: 'outcome_manifest', runId: 'synthetic-run',
    files: { 'outcomes.ndjson': H('p'), 'summary.json': H('q') }, recordCount: 0, resolvedCount: 0,
    sealedCode: { authorizationFingerprint: authorization.fingerprint, sealFingerprint: H('3') } });
  const consumption = sealRecord({ schemaVersion: 1, recordType: 'r4_outcome_authorization_consumption', status: 'CONSUMED',
    authorizationFingerprint: authorization.fingerprint, runId: 'synthetic-run',
    outcomeRunFingerprint: manifest.fingerprint, outcomeManifestFingerprint: manifest.fingerprint, consumedAt: 800 });
  const authzPath = write0444('.evolve/governance/r4-outcome-authorizations/outcome-authorization-0001.json', authorization);
  write0444('.evolve/governance/r4-outcome-authorizations/outcome-authorization-0001.consumption.json', consumption);
  const manifestPath = write0444(`.evolve/market-outcomes/${manifest.runId}/manifest.json`, manifest);

  const attestDir = path.join(repo, '.evolve/governance/r4-result-attestations');
  mkdirSync(attestDir, { recursive: true });
  const review = sealRecord({ schemaVersion: 1, recordType: 'r4_result_attestation_review', attestationGeneration: 1,
    verdict: 'READY_TO_ATTEST_R4_RESULT', reviewerIdentity: 'synthetic', reviewerModel: 'synthetic', reviewedAt: 1_000,
    implementationHashes: { attester: H('a'), validator: H('b') }, archiveManifestFingerprint: H('c'),
    evidenceInventoryDigest: H('d'), c1Commit: c1, outcomeRunFingerprint: manifest.fingerprint,
    noPriorResultValuesAreInputs: true, exactlyOneCanonicalCall: true, blockers: [] });
  const claim = sealRecord({ schemaVersion: 1, recordType: 'r4_result_attestation_claim', status: 'CLAIMED', generation: 1,
    archiveMainCommit: c1, evidenceInventoryDigest: H('d'), outcomeRunFingerprint: manifest.fingerprint,
    reviewFingerprint: review.fingerprint, claimedAt: 2_000 });
  // `attestationOutcome` lets a test present a DIFFERENT immutable attestation
  // while the durable chain and the finalizer constants stay correct.
  const ao = { outcomeAuthorizationFingerprint: authorization.fingerprint, outcomeRunId: 'synthetic-run',
    outcomeRunFingerprint: manifest.fingerprint, outcomeBindingFingerprint: H('6'), ...attestationOutcome };
  const identity = { schemaVersion: 1, recordType: 'r4_canonical_analysis_result', authorityStage: 'C',
    approvalCommit: 'a'.repeat(40), approvalEpoch: 2, approvalFingerprint: H('f'), authorityCommit: 'b'.repeat(40),
    sealFingerprint: H('3'), continuationFingerprint: H('4'), t0: 1700000000000, attemptsUsed: 6,
    canonicalMembership: [...IDS].sort(), canonicalMembershipDigest: digest([...IDS].sort()),
    referenceSetDigest: H('5'), exposureRowsDigest: SYN.exposureRowsDigest,
    outcomeBindingFingerprint: ao.outcomeBindingFingerprint, outcomeRunFingerprint: ao.outcomeRunFingerprint };
  const analysis = { schemaVersion: 1, recordType: 'r4_real_primary_analysis', developmentOnly: true, researchOnly: true,
    paperOnly: true, observerOnly: true, tradingAuthority: false, engineAuthority: false, arenaEligible: false,
    promotionEligible: false, profitabilityInferencePermitted: false, specVersion: SYN.spec,
    bootstrapReplicates: SYN.bootstrapReplicates, seedDigest: SYN.seedDigest,
    availabilityDenominator: SYN.availabilityDenominator, resolvedReferenceCount: SYN.resolvedReferenceCount,
    distinctResolvedMintCount: SYN.distinctResolvedMintCount, floorsMet: SYN.floorsMet,
    pointEstimate: SYN.pointEstimate, replicatesDefined: SYN.replicatesDefined,
    ciLower: SYN.ciLower, ciUpper: SYN.ciUpper, referenceSetDigest: H('5'), exposureRowsDigest: SYN.exposureRowsDigest };
  const attestResult = sealRecord({ schemaVersion: 1, recordType: 'r4_result_attestation', status: 'ATTESTED',
    purpose: 'R4_RESULT_ATTESTATION_REPRODUCTION', generation: 1, archiveMainCommit: c1,
    archiveManifestFingerprint: H('c'), evidenceInventoryDigest: H('d'), evidenceInventoryFileCount: 1,
    evidenceInventoryTotalBytes: 1, scientificApprovalCommit: 'a'.repeat(40), scientificApprovalFingerprint: H('f'),
    runtimeSealCommit: 'b'.repeat(40), runtimeSealFingerprint: H('3'), continuationCommit: c1,
    continuationFingerprint: H('4'), t0: 1700000000000, outcomeAuthorizationFingerprint: ao.outcomeAuthorizationFingerprint,
    outcomeRunId: ao.outcomeRunId, outcomeRunFingerprint: ao.outcomeRunFingerprint,
    outcomeBindingFingerprint: ao.outcomeBindingFingerprint,
    reviewFingerprint: review.fingerprint, claimFingerprint: claim.fingerprint, attestedAt: 3_000,
    attestedAtIso: new Date(3_000).toISOString(), identity, analysis,
    identityDigest: digest(identity), analysisDigest: digest(analysis) });

  for (const [name, rec] of [['result-attestation-0001.review.json', review], ['result-attestation-0001.claim.json', claim],
    ['result-attestation-0001.json', attestResult]]) {
    writeFileSync(path.join(attestDir, name), `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o444 });
    chmodSync(path.join(attestDir, name), 0o444);
  }
  const fx = { dir, repo, archive, parent, c1, attestDir, review, claim, attestResult, identity, analysis,
    authorization, consumption, manifest, authzPath, manifestPath };
  const k = Object.freeze({
    c1Commit: c1, c1Fingerprint: H('4'), a2Commit: 'a'.repeat(40), a2Epoch: 2, a2Fingerprint: H('f'),
    s6Commit: 'b'.repeat(40), s6Fingerprint: H('3'), t0: 1700000000000, attemptsUsed: 6,
    referenceCount: SYN.availabilityDenominator, canonicalMembershipDigest: identity.canonicalMembershipDigest,
    referenceSetDigest: H('5'),
    // The durable EXPECTED identities. They match the on-disk chain by default;
    // `constants` lets a test move the constant away from authenticated disk.
    outcomeAuthorizationFingerprint: authorization.fingerprint, outcomeRunId: 'synthetic-run',
    outcomeRunFingerprint: manifest.fingerprint, outcomeBindingFingerprint: H('6'),
    archiveManifestFingerprint: H('c'),
    evidenceInventoryFileCount: 1, evidenceInventoryTotalBytes: 1, evidenceInventoryDigest: H('d'),
    resultAttestationReviewFingerprint: review.fingerprint, resultAttestationClaimFingerprint: claim.fingerprint,
    resultAttestationFingerprint: attestResult.fingerprint, resultIdentityDigest: digest(identity),
    resultAnalysisDigest: digest(analysis), ...constants,
  });
  let clock = 10_000;
  const counters = { verifyAttestation: 0, archive: 0, inventory: 0, outcomeRun: 0 };
  const stageC = { stage: 'C', approvalCommit: 'a'.repeat(40), approvalEpoch: 2, approvalFingerprint: H('f'),
    authority: { sealAuthorityCommit: 'b'.repeat(40) }, seal: { fingerprint: H('3') },
    continuationCommit: c1, continuationFingerprint: H('4'), t0: 1700000000000 };
  const ctx = {
    repoRoot: repo, evidenceRoot: repo, constants: k, attestDir, archiveDir: archive,
    closureDir: path.join(repo, R4_FINALIZATION_DIR), boundFiles: ['bound.txt'],
    selfFiles: { finalizer: FINALIZER, validator: VALIDATOR },
    attestationContext: () => ({}),
    loadStageCModule: async () => ({ resolveR4ExecutionAuthority: () => stageC }),
    verifyAttestation: () => { counters.verifyAttestation += 1; return { review: review.fingerprint, claim: claim.fingerprint, result: attestResult.fingerprint }; },
    verifyArchiveRepo: () => { counters.archive += 1; return { archiveMainCommit: c1, archiveFsckPassed: true }; },
    verifyArchiveManifest: () => ({ fingerprint: H('c'), archiveMainCommit: c1 }),
    verifyFrozenInventory: () => { counters.inventory += 1; return { fileCount: 1, totalBytes: 1, aggregateDigest: H('d') }; },
    // Re-reads the manifest from disk, exactly as the sealed attester's
    // verifyOutcomeRun does. Runs no analysis and generates nothing.
    verifyOutcomeRunIdentity: () => {
      counters.outcomeRun += 1;
      return outcomeRunStub ? outcomeRunStub() : JSON.parse(readFileSync(manifestPath, 'utf8'));
    },
    now: () => (clock += 1000), tmpRoot: dir,
  };
  fx.ctx = ctx; fx.constants = k; fx.counters = counters;
  return fx;
}

const reviewFor = (fx, overrides = {}) => {
  const base = { schemaVersion: 1, recordType: 'r4_finalization_review', closureGeneration: 1, verdict: R4_REVIEW_VERDICT,
    reviewerIdentity: 'synthetic-reviewer', reviewerModel: 'synthetic-model', reviewedAt: 9_000,
    implementationHashes: selfHashes(fx.ctx), archiveManifestFingerprint: fx.constants.archiveManifestFingerprint,
    evidenceInventoryDigest: fx.constants.evidenceInventoryDigest, c1Commit: fx.constants.c1Commit,
    resultAttestationFingerprint: fx.constants.resultAttestationFingerprint,
    closureCopiesResultWithoutRecomputation: true, closureIsLifecycleMetadataOnly: true, blockers: [], ...overrides };
  return sealRecord(base);
};
const stageReview = (fx, overrides) => {
  const p = path.join(fx.dir, `review-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify(reviewFor(fx, overrides)));
  return p;
};
async function closed() {
  const fx = makeFixture();
  importReview(fx.ctx, stageReview(fx));
  fx.closure = await closeR4(fx.ctx);
  return fx;
}
const closureFile = fx => path.join(fx.ctx.closureDir, R4_FINALIZATION_FILE);
const rewrite = (file, mutate, { reseal = true, mode = 0o444 } = {}) => {
  const rec = JSON.parse(readFileSync(file, 'utf8'));
  mutate(rec);
  const { fingerprint, ...body } = rec;
  const out = reseal ? sealRecord(body) : rec;
  chmodSync(file, 0o644); writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`); chmodSync(file, mode);
};

/** Overwrite a record wholesale with an already-sealed value (no reseal). */
const writeRecord = (file, rec) => {
  chmodSync(file, 0o644); writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`); chmodSync(file, 0o444);
};
/* -------------------------------------------------------------------- cases */

const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
const finalizerSource = stripComments(readFileSync(FINALIZER, 'utf8'));
const slice = (start, end) => { const a = finalizerSource.indexOf(start); const b = finalizerSource.indexOf(end, a + 1); assert.ok(a >= 0 && b > a, `slice ${start}`); return finalizerSource.slice(a, b); };
const closeBody = slice('export async function closeR4', 'export async function verifyClosure');
const verifyClosureBody = slice('export async function verifyClosure', 'async function main');

const realClosureDir = path.join(root, R4_FINALIZATION_DIR);
const realClosureExisted = existsSync(realClosureDir);
const boundBefore = sh('git', ['status', '--porcelain', '--', ...R4_REQUIRED_BOUND_FILES], root);
const realAttestDir = path.join(root, '.evolve/governance/r4-result-attestations');
const attestBefore = readdirSync(realAttestDir).map(n => [n, sha(readFileSync(path.join(realAttestDir, n)))]);
const prepDir = path.join(root, '.evolve/governance/r4-finalization-prep');
const prepBefore = readdirSync(prepDir).map(n => [n, sha(readFileSync(path.join(prepDir, n)))]);

try {
  const cases = [];
  const t = (name, fn) => cases.push([name, fn]);

  t('1 accepted synthetic path: review -> close -> verify, result copied from attestation', async () => {
    const fx = await closed();
    assert.equal(fx.closure.status, R4_CLOSURE_STATUS);
    assert.equal(fx.closure.closureReason, R4_CLOSURE_REASON);
    assert.equal(fx.closure.authorityStage, 'C');
    assert.equal(fx.closure.pointEstimate, SYN.pointEstimate);
    assert.equal(fx.closure.ciLower, SYN.ciLower);
    assert.equal(fx.closure.seedDigest, SYN.seedDigest);
    assert.equal(fx.closure.resultAttestationFingerprint, fx.attestResult.fingerprint);
    assert.equal(fx.closure.resultIdentityDigest, digest(fx.identity));
    assert.equal(fx.closure.resultAnalysisDigest, digest(fx.analysis));
    assert.equal(statSync(closureFile(fx)).mode & 0o777, 0o444);
    const v = await verifyClosure(fx.ctx);
    assert.equal(v.closure, fx.closure.fingerprint);
  });

  t('2 lifecycle-only: no analysis, no attestation execute, no outcome generation, no network', async () => {
    assert.doesNotMatch(finalizerSource, /runCanonicalR4Analysis|runRealR4PrimaryAnalysis|runPrimaryAnalysis/);
    assert.doesNotMatch(finalizerSource, /executeAttestation/);
    assert.doesNotMatch(finalizerSource, /generateOutcome|generateOutcomes|generateR4Outcome/);
    assert.doesNotMatch(finalizerSource, /fetch\(|https?:\/\/|axios|got\(|undici|node-fetch/);
    assert.doesNotMatch(finalizerSource, /jupiter|gmgn|apiKey|API_KEY/i);
    assert.doesNotMatch(closeBody, /\b(for|while|do)\s*[({]|\bretry\b|setTimeout|setInterval/);
    const fx = await closed();
    assert.equal(fx.counters.verifyAttestation, 1, 'attestation verified exactly once at close');
    assert.ok(verifyClosureBody.includes('assertClosure'));
  });

  t('3 C1 / A2 / S6 / T0 mismatch rejected', async () => {
    const bad = async (over, re) => {
      const g = await closed();
      rewrite(closureFile(g), r => Object.assign(r, over), { reseal: false });
      await rejects(verifyClosure(g.ctx), re);
    };
    await bad({ c1Commit: C40('9') }, /CLOSURE_BINDING:c1Commit|CLOSURE_FINGERPRINT/);
    await bad({ a2Commit: C40('9') }, /CLOSURE_BINDING:a2Commit|CLOSURE_FINGERPRINT/);
    await bad({ s6Commit: C40('9') }, /CLOSURE_BINDING:s6Commit|CLOSURE_FINGERPRINT/);
    await bad({ t0: 1 }, /CLOSURE_BINDING:t0|CLOSURE_FINGERPRINT/);
  });

  t('4 HEAD / origin-main / stage drift rejected', async () => {
    const g = await closed();
    rewrite(closureFile(g), r => { r.headAtClosure = C40('9'); }, { reseal: false });
    await rejects(verifyClosure(g.ctx), /CLOSURE_HEAD|CLOSURE_FINGERPRINT/);
    const h = await closed();
    rewrite(closureFile(h), r => { r.originMainAtClosure = C40('9'); }, { reseal: false });
    await rejects(verifyClosure(h.ctx), /CLOSURE_ORIGIN_MAIN|CLOSURE_FINGERPRINT/);
    const i = await closed();
    rewrite(closureFile(i), r => { r.authorityStage = 'B'; }, { reseal: false });
    await rejects(verifyClosure(i.ctx), /CLOSURE_BINDING:authorityStage|CLOSURE_FINGERPRINT/);
  });

  t('5 production HEAD / origin drift rejected', async () => {
    // HEAD moved off the frozen commit
    const fx = makeFixture();
    sh('git', ['checkout', '-q', '-b', 'other', fx.parent], fx.repo);
    throwsSync(() => verifyProductionState(fx.ctx), /R4_CLOSE_PRODUCTION_HEAD_NOT_C1/);
    // origin/main no longer points at C1 (a real bare repo serving an older commit)
    const g = makeFixture();
    sh('git', ['--git-dir', g.archive, 'update-ref', 'refs/heads/main', g.parent]);
    sh('git', ['fetch', '-q', 'origin'], g.repo);
    throwsSync(() => verifyProductionState(g.ctx), /R4_CLOSE_PRODUCTION_REMOTE_MAIN_NOT_C1/);
    // a bound file changed on disk
    const h = makeFixture();
    writeFileSync(path.join(h.repo, 'bound.txt'), 'v3\n');
    throwsSync(() => verifyProductionState(h.ctx), /R4_CLOSE_BOUND_FILES_(CHANGED|DIRTY)/);
  });

  t('6 attemptsUsed / completedCount drift rejected', async () => {
    const g = await closed();
    rewrite(closureFile(g), r => { r.attemptsUsed = 5; }, { reseal: false });
    await rejects(verifyClosure(g.ctx), /CLOSURE_BINDING:attemptsUsed|CLOSURE_FINGERPRINT/);
    const h = await closed();
    rewrite(closureFile(h), r => { r.completedCount = 5; }, { reseal: false });
    await rejects(verifyClosure(h.ctx), /CLOSURE_BINDING:completedCount|CLOSURE_FINGERPRINT/);
  });

  t('7 membership / reference-count / reference-digest drift rejected', async () => {
    const g = await closed();
    rewrite(closureFile(g), r => { r.canonicalMembership = [...IDS, 's7'].sort(); }, { reseal: false });
    await rejects(verifyClosure(g.ctx), /CLOSURE_MEMBERSHIP|CLOSURE_FINGERPRINT/);
    const h = await closed();
    rewrite(closureFile(h), r => { r.referenceCount = 999; }, { reseal: false });
    await rejects(verifyClosure(h.ctx), /CLOSURE_BINDING:referenceCount|CLOSURE_FINGERPRINT/);
    const i = await closed();
    rewrite(closureFile(i), r => { r.referenceSetDigest = H('9'); }, { reseal: false });
    await rejects(verifyClosure(i.ctx), /CLOSURE_BINDING:referenceSetDigest|CLOSURE_FINGERPRINT/);
  });

  t('8 outcome authorization / run / binding drift rejected', async () => {
    const g = await closed();
    rewrite(closureFile(g), r => { r.outcomeAuthorizationFingerprint = H('9'); }, { reseal: false });
    await rejects(verifyClosure(g.ctx), /CLOSURE_BINDING:outcomeAuthorizationFingerprint|CLOSURE_FINGERPRINT/);
    const h = await closed();
    rewrite(closureFile(h), r => { r.outcomeRunFingerprint = H('9'); }, { reseal: false });
    await rejects(verifyClosure(h.ctx), /CLOSURE_BINDING:outcomeRunFingerprint|CLOSURE_FINGERPRINT/);
    const i = await closed();
    rewrite(closureFile(i), r => { r.outcomeBindingFingerprint = H('9'); }, { reseal: false });
    await rejects(verifyClosure(i.ctx), /CLOSURE_BINDING:outcomeBindingFingerprint|CLOSURE_FINGERPRINT/);
  });

  t('9 archive manifest / inventory drift rejected', async () => {
    const g = await closed();
    rewrite(closureFile(g), r => { r.archiveManifestFingerprint = H('9'); }, { reseal: false });
    await rejects(verifyClosure(g.ctx), /CLOSURE_BINDING:archiveManifestFingerprint|CLOSURE_FINGERPRINT/);
    const h = await closed();
    rewrite(closureFile(h), r => { r.evidenceInventoryDigest = H('9'); }, { reseal: false });
    await rejects(verifyClosure(h.ctx), /CLOSURE_BINDING:evidenceInventoryDigest|CLOSURE_FINGERPRINT/);
    const i = await closed();
    rewrite(closureFile(i), r => { r.archiveVerified = false; }, { reseal: false });
    await rejects(verifyClosure(i.ctx), /CLOSURE_BINDING:archiveVerified|CLOSURE_FINGERPRINT/);
  });

  t('10 result-attestation review / claim / fingerprint / digest drift rejected', async () => {
    const g = await closed();
    rewrite(closureFile(g), r => { r.resultAttestationReviewFingerprint = H('9'); }, { reseal: false });
    await rejects(verifyClosure(g.ctx), /CLOSURE_BINDING:resultAttestationReviewFingerprint|CLOSURE_FINGERPRINT/);
    const h = await closed();
    rewrite(closureFile(h), r => { r.resultAttestationClaimFingerprint = H('9'); }, { reseal: false });
    await rejects(verifyClosure(h.ctx), /CLOSURE_BINDING:resultAttestationClaimFingerprint|CLOSURE_FINGERPRINT/);
    const i = await closed();
    rewrite(closureFile(i), r => { r.resultAttestationFingerprint = H('9'); }, { reseal: false });
    await rejects(verifyClosure(i.ctx), /CLOSURE_BINDING:resultAttestationFingerprint|CLOSURE_FINGERPRINT/);
    const j = await closed();
    rewrite(closureFile(j), r => { r.resultIdentityDigest = H('9'); }, { reseal: false });
    await rejects(verifyClosure(j.ctx), /CLOSURE_BINDING:resultIdentityDigest|CLOSURE_FINGERPRINT/);
    const k2 = await closed();
    rewrite(closureFile(k2), r => { r.resultAnalysisDigest = H('9'); }, { reseal: false });
    await rejects(verifyClosure(k2.ctx), /CLOSURE_BINDING:resultAnalysisDigest|CLOSURE_FINGERPRINT/);
  });

  t('11 copied scientific drift rejected for every copied field', async () => {
    for (const k of R4_COPIED_RESULT_FIELDS) {
      const g = await closed();
      rewrite(closureFile(g), r => {
        r[k] = typeof SYN[k] === 'number' && !Number.isInteger(SYN[k]) ? SYN[k] + 0.5
          : typeof SYN[k] === 'number' ? SYN[k] + 1 : H('9');
      });
      await rejects(verifyClosure(g.ctx), new RegExp(`RESULT_COPY_DRIFT:${k}`));
    }
  });

  t('12 copied point estimate / CI / mint count / seed / exposure / bootstrap / floors drift rejected', async () => {
    const drift = async (k, v) => {
      const g = await closed();
      rewrite(closureFile(g), r => { r[k] = v; });
      await rejects(verifyClosure(g.ctx), new RegExp(`RESULT_COPY_DRIFT:${k}`));
    };
    await drift('pointEstimate', 0.9);
    await drift('ciLower', 0.9);
    await drift('ciUpper', 0.9);
    await drift('distinctResolvedMintCount', 999);
    await drift('seedDigest', H('8'));
    await drift('exposureRowsDigest', H('8'));
    await drift('bootstrapReplicates', 7);
    await drift('floorsMet', false);
  });

  t('13 classification can never widen authority', async () => {
    for (const key of ['tradingAuthority', 'profitabilityInferencePermitted', 'engineAuthority',
      'promotionEligible', 'arenaEligible']) {
      const g = await closed();
      rewrite(closureFile(g), r => { r[key] = true; });
      await rejects(verifyClosure(g.ctx), new RegExp(`CLASSIFICATION:${key}`));
    }
    const h = await closed();
    rewrite(closureFile(h), r => { r.researchOnly = false; });
    await rejects(verifyClosure(h.ctx), /CLASSIFICATION:researchOnly/);
  });

  t('14 lifecycle declarations cannot be weakened', async () => {
    const g = await closed();
    rewrite(closureFile(g), r => { r.liveRederivationWindowClosed = false; });
    await rejects(verifyClosure(g.ctx), /LIVE_WINDOW_NOT_CLOSED/);
    const h = await closed();
    rewrite(closureFile(h), r => { r.futureCanonicalReproductionMode = 'LIVE_MAIN'; });
    await rejects(verifyClosure(h.ctx), /REPRODUCTION_MODE/);
    const i = await closed();
    rewrite(closureFile(i), r => { r.productionMainMayAdvanceAfterClosure = false; });
    await rejects(verifyClosure(i.ctx), /MAIN_ADVANCE/);
    const j = await closed();
    rewrite(closureFile(j), r => { r.noFurtherCanonicalR4ExecutionRequired = false; });
    await rejects(verifyClosure(j.ctx), /FURTHER_EXECUTION/);
    assert.equal(R4_REPRODUCTION_MODE, 'ARCHIVED_C1_REMOTE');
  });

  t('15 unknown field / fingerprint tamper rejected', async () => {
    const g = await closed();
    rewrite(closureFile(g), r => { r.operatorNote = 'x'; });
    await rejects(verifyClosure(g.ctx), /CLOSURE_SCHEMA_NOT_CLOSED/);
    const h = await closed();
    rewrite(closureFile(h), r => { r.closedAt += 1; }, { reseal: false });
    await rejects(verifyClosure(h.ctx), /CLOSURE_FINGERPRINT/);
  });

  t('16 write-once semantics: duplicate O_EXCL, mode != 0444, missing review', async () => {
    const g = await closed();
    throwsSync(() => writeOnce(closureFile(g), 'x'), /EEXIST/);
    await rejects(closeR4(g.ctx), /ALREADY_CLOSED/);
    chmodSync(closureFile(g), 0o644);
    await rejects(verifyClosure(g.ctx), /CLOSURE_MODE_NOT_0444/);
    const h = makeFixture();
    rmSync(path.join(h.ctx.closureDir, R4_FINALIZATION_REVIEW_FILE), { force: true });
    await rejects(closeR4(h.ctx), /REVIEW_MISSING/);
  });

  t('17 review: wrong verdict / blocker / hash mismatch / unknown field rejected', async () => {
    const fx = makeFixture();
    const imp = o => importReview(fx.ctx, stageReview(fx, o));
    throwsSync(() => imp({ verdict: 'READY' }), /REVIEW_VERDICT/);
    throwsSync(() => imp({ blockers: ['x'] }), /REVIEW_BLOCKERS/);
    throwsSync(() => imp({ implementationHashes: { finalizer: H('0'), validator: selfHashes(fx.ctx).validator } }), /IMPLEMENTATION_HASH_MISMATCH/);
    throwsSync(() => imp({ implementationHashes: { finalizer: selfHashes(fx.ctx).finalizer, validator: H('0') } }), /IMPLEMENTATION_HASH_MISMATCH/);
    throwsSync(() => imp({ resultAttestationFingerprint: H('0') }), /REVIEW_ATTEST_MISMATCH/);
    throwsSync(() => imp({ evidenceInventoryDigest: H('0') }), /REVIEW_INVENTORY_MISMATCH/);
    throwsSync(() => imp({ closureIsLifecycleMetadataOnly: false }), /REVIEW_DECLARATIONS/);
    throwsSync(() => imp({ extra: 1 }), /SCHEMA_NOT_CLOSED/);
    assert.equal(existsSync(path.join(fx.ctx.closureDir, R4_FINALIZATION_REVIEW_FILE)), false);
  });

  t('18 CLI rejects every forbidden override (no real closure written)', async () => {
    for (const key of R4_CLOSURE_FORBIDDEN_OVERRIDES) {
      for (const cmd of ['close', 'verify-preconditions', 'verify']) {
        const r = spawnSync(process.execPath, [FINALIZER, cmd, `--${key}=1`], { encoding: 'utf8', timeout: 120_000 });
        assert.notEqual(r.status, 0, `${cmd} --${key}`);
        assert.match(r.stderr, /R4_CLOSE_CLI_OVERRIDE_REJECTED/);
      }
    }
    assert.equal(existsSync(realClosureDir), realClosureExisted);
  });

  t('19 attestation drift in the source artifacts fails the closure path', async () => {
    // a tampered-but-resealed attestation no longer matches the frozen fingerprint
    const fx = await closed();
    rewrite(path.join(fx.attestDir, 'result-attestation-0001.json'), r => { r.pointEstimate = 1; });
    await rejects(verifyClosure(fx.ctx), /ATTEST_FINGERPRINT_MISMATCH/);
    // a tampered record carrying a stale self-fingerprint is refused too
    const k = await closed();
    rewrite(path.join(k.attestDir, 'result-attestation-0001.json'), r => { r.pointEstimate = 1; }, { reseal: false });
    await rejects(verifyClosure(k.ctx), /ATTEST_RESULT_FINGERPRINT/);
    const g = await closed();
    rmSync(path.join(g.attestDir, 'result-attestation-0001.claim.json'), { force: true });
    await rejects(verifyClosure(g.ctx), /ATTEST_CLAIM_MISSING/);
    const h = await closed();
    chmodSync(path.join(h.attestDir, 'result-attestation-0001.json'), 0o644);
    await rejects(verifyClosure(h.ctx), /ATTEST_RESULT_MODE_NOT_0444/);
  });

  t('20 real result attestation still verifies; three artifacts immutable', async () => {
    const ctx = productionContext();
    const att = readResultAttestation(ctx);
    assert.equal(att.result.fingerprint, R4_CLOSURE_CONSTANTS.resultAttestationFingerprint);
    assert.equal(att.claim.fingerprint, R4_CLOSURE_CONSTANTS.resultAttestationClaimFingerprint);
    assert.equal(att.review.fingerprint, R4_CLOSURE_CONSTANTS.resultAttestationReviewFingerprint);
    assert.equal(att.result.identityDigest, R4_CLOSURE_CONSTANTS.resultIdentityDigest);
    assert.equal(att.result.analysisDigest, R4_CLOSURE_CONSTANTS.resultAnalysisDigest);
    for (const n of ['result-attestation-0001.review.json', 'result-attestation-0001.claim.json', 'result-attestation-0001.json']) {
      assert.equal(statSync(path.join(realAttestDir, n)).mode & 0o777, 0o444, n);
    }
    // the real result is READ, never recomputed: it equals the attested values
    const copied = copyScientificResult(att);
    for (const k of R4_COPIED_RESULT_FIELDS) assert.ok(copied[k] !== undefined, k);
    assert.equal(copyCohortIdentity(att, ctx).completedCount, 6);
  });

  t('21 real archive remains C1 and fsck-valid; 71 bound files unchanged; HEAD/origin C1', () => {
    const c1 = R4_CLOSURE_CONSTANTS.c1Commit;
    assert.equal(verifyArchiveRepo(productionContext().attestationContext()).archiveMainCommit, c1);
    assert.equal(R4_REQUIRED_BOUND_FILES.length, 71);
    assert.equal(sh('git', ['diff', '--name-only', c1, '--', ...R4_REQUIRED_BOUND_FILES], root), '');
    assert.equal(sh('git', ['status', '--porcelain', '--', ...R4_REQUIRED_BOUND_FILES], root), boundBefore);
    assert.equal(boundBefore, '');
    assert.equal(sh('git', ['rev-parse', 'HEAD'], root), c1);
    assert.match(sh('git', ['ls-remote', 'origin', 'refs/heads/main'], root), new RegExp(`^${c1}\\s`));
  });

  t('22 real 109-file evidence inventory still verifies by full re-hash', () => {
    const live = verifyFrozenInventory(productionContext().attestationContext());
    assert.equal(live.fileCount, 109);
    assert.equal(live.totalBytes, 3144793956);
    assert.equal(live.aggregateDigest, R4_CLOSURE_CONSTANTS.evidenceInventoryDigest);
  });

  t('23 no real finalization artifacts were created', () => {
    assert.equal(existsSync(realClosureDir), realClosureExisted);
    for (const f of [R4_FINALIZATION_REVIEW_FILE, R4_FINALIZATION_FILE]) {
      assert.equal(existsSync(path.join(realClosureDir, f)), false, f);
    }
  });

  t('24 real attestation + prep artifacts unchanged and still 0444', () => {
    const after = readdirSync(realAttestDir).map(n => [n, sha(readFileSync(path.join(realAttestDir, n)))]);
    assert.deepEqual(after, attestBefore);
    for (const [n] of after) assert.equal(statSync(path.join(realAttestDir, n)).mode & 0o777, 0o444);
    assert.deepEqual(readdirSync(prepDir).map(n => [n, sha(readFileSync(path.join(prepDir, n)))]), prepBefore);
    for (const [n] of prepBefore) assert.equal(statSync(path.join(prepDir, n)).mode & 0o777, 0o444);
  });

  /* ================= BLOCKER REGRESSION: outcome identity cross-check ================= */

  t('25 outcome identities are DERIVED from authenticated artifacts, not copied from constants', async () => {
    const fx = await closed();
    const chain = readOutcomeChain(fx.ctx);
    assert.equal(chain.outcomeAuthorizationFingerprint, fx.authorization.fingerprint);
    assert.equal(chain.outcomeRunId, fx.authorization.runId);
    assert.equal(chain.outcomeRunFingerprint, fx.manifest.fingerprint);
    assert.equal(chain.consumption.outcomeRunFingerprint, fx.manifest.fingerprint);
    assert.equal(chain.manifest.sealedCode.authorizationFingerprint, fx.authorization.fingerprint);
    assert.equal(fx.closure.outcomeAuthorizationFingerprint, chain.outcomeAuthorizationFingerprint);
    assert.equal(fx.closure.outcomeRunId, chain.outcomeRunId);
    assert.equal(fx.closure.outcomeRunFingerprint, chain.outcomeRunFingerprint);
    assert.equal(fx.closure.outcomeBindingFingerprint, fx.attestResult.identity.outcomeBindingFingerprint);
    assert.deepEqual([...R4_OUTCOME_IDENTITY_KEYS], ['outcomeAuthorizationFingerprint', 'outcomeRunId',
      'outcomeRunFingerprint', 'outcomeBindingFingerprint']);
    for (const k of R4_OUTCOME_IDENTITY_KEYS) assert.ok(R4_OUTCOME_IDENTITY_SOURCES[k], k);
    // only the binding fingerprint has no standalone file; it is attestation-sourced
    assert.equal(R4_OUTCOME_IDENTITY_SOURCES.outcomeBindingFingerprint.onDisk, null);
    assert.equal(R4_OUTCOME_IDENTITY_SOURCES.outcomeRunFingerprint.onDisk, 'OUTCOME_MANIFEST');
    assert.equal(R4_OUTCOME_IDENTITY_SOURCES.outcomeAuthorizationFingerprint.onDisk, 'OUTCOME_AUTHORIZATION');
    assert.equal(R4_OUTCOME_IDENTITY_SOURCES.outcomeRunId.onDisk, 'OUTCOME_AUTHORIZATION');
  });

  t('26 REGRESSION 1: attestation identity outcomeRunFingerprint != finalizer constant -> fail', async () => {
    const fx = makeFixture({ attestationOutcome: { outcomeRunFingerprint: H('9') } });
    assert.equal(fx.constants.outcomeRunFingerprint, fx.manifest.fingerprint, 'constant is correct');
    assert.notEqual(fx.attestResult.identity.outcomeRunFingerprint, fx.constants.outcomeRunFingerprint);
    importReview(fx.ctx, stageReview(fx));
    await rejects(closeR4(fx.ctx), /OUTCOME_IDENTITY_(ATTEST_SPLIT|DISK_ATTEST_MISMATCH|CONSTANT_MISMATCH|UNRESOLVED):outcomeRunFingerprint/);
    assert.equal(existsSync(closureFile(fx)), false, 'no closure written');
  });

  t('27 REGRESSION 2: attestation identity outcomeBindingFingerprint != finalizer constant -> fail', async () => {
    const fx = makeFixture({ attestationOutcome: { outcomeBindingFingerprint: H('9') } });
    assert.equal(fx.constants.outcomeBindingFingerprint, H('6'), 'constant is correct');
    assert.notEqual(fx.attestResult.identity.outcomeBindingFingerprint, fx.constants.outcomeBindingFingerprint);
    importReview(fx.ctx, stageReview(fx));
    await rejects(closeR4(fx.ctx), /OUTCOME_IDENTITY_CONSTANT_MISMATCH:outcomeBindingFingerprint/);
    assert.equal(existsSync(closureFile(fx)), false);
  });

  t('28 REGRESSION 3: durable outcome authorization fingerprint != finalizer constant -> fail', async () => {
    const good = makeFixture();
    const fx = makeFixture({ constants: { outcomeAuthorizationFingerprint: H('9') } });
    assert.equal(fx.authorization.fingerprint, good.authorization.fingerprint, 'disk record unchanged');
    assert.notEqual(fx.constants.outcomeAuthorizationFingerprint, fx.authorization.fingerprint);
    importReview(fx.ctx, stageReview(fx));
    await rejects(closeR4(fx.ctx), /OUTCOME_IDENTITY_CONSTANT_MISMATCH:outcomeAuthorizationFingerprint/);
    assert.equal(existsSync(closureFile(fx)), false);
  });

  t('29 REGRESSION 4: durable outcome run ID != finalizer constant -> fail', async () => {
    const fx = makeFixture({ constants: { outcomeRunId: 'wrong-run-id' } });
    assert.equal(fx.authorization.runId, 'synthetic-run', 'disk record unchanged');
    assert.notEqual(fx.constants.outcomeRunId, fx.authorization.runId);
    importReview(fx.ctx, stageReview(fx));
    await rejects(closeR4(fx.ctx), /OUTCOME_IDENTITY_CONSTANT_MISMATCH:outcomeRunId/);
    assert.equal(existsSync(closureFile(fx)), false);
  });

  t('30 REGRESSION 5: closure record outcome identities != authenticated sources -> verify fails', async () => {
    for (const key of R4_OUTCOME_IDENTITY_KEYS) {
      const fx = await closed();
      const good = fx.closure[key];
      // reseal so the record is internally consistent: only the SOURCE disagrees
      rewrite(closureFile(fx), r => { r[key] = key === 'outcomeRunId' ? 'substituted-run' : H('9'); });
      assert.notEqual(JSON.parse(readFileSync(closureFile(fx), 'utf8'))[key], good);
      await rejects(verifyClosure(fx.ctx), new RegExp(`CLOSURE_OUTCOME_IDENTITY:${key}`));
    }
  });

  t('31 REGRESSION (exact reviewer finding): constants correct + attestation binding fp altered -> close refuses', async () => {
    // The independent review's synthetic probe, reproduced exactly: all four
    // R4_CLOSURE_CONSTANTS stay CORRECT, the immutable attestation's binding
    // fingerprint is ALTERED, and closeR4 must REFUSE.
    const reference = makeFixture();
    const correctBinding = reference.constants.outcomeBindingFingerprint;
    const fx = makeFixture({ attestationOutcome: { outcomeBindingFingerprint: H('9') } });
    assert.equal(fx.constants.outcomeAuthorizationFingerprint, fx.authorization.fingerprint);
    assert.equal(fx.constants.outcomeRunId, fx.authorization.runId);
    assert.equal(fx.constants.outcomeRunFingerprint, fx.manifest.fingerprint);
    assert.equal(fx.constants.outcomeBindingFingerprint, correctBinding);
    assert.notEqual(fx.attestResult.identity.outcomeBindingFingerprint, fx.constants.outcomeBindingFingerprint);
    importReview(fx.ctx, stageReview(fx));
    let refused = null;
    try { await closeR4(fx.ctx); } catch (e) { refused = e.message; }
    assert.ok(refused, 'closeR4 must refuse');
    assert.match(refused, /OUTCOME_IDENTITY_CONSTANT_MISMATCH:outcomeBindingFingerprint/);
    assert.equal(existsSync(closureFile(fx)), false, 'no closure record may be written');
    // the pre-fix behaviour (comparing only to constants) is provably gone
    assert.doesNotMatch(closeBody, /outcomeRunFingerprint: ctx\.constants\.outcomeRunFingerprint/);
    assert.doesNotMatch(closeBody, /outcomeBindingFingerprint: ctx\.constants\.outcomeBindingFingerprint/);
    assert.match(closeBody, /outcomeRunFingerprint: pre\.outcome\.outcomeRunFingerprint/);
    assert.match(closeBody, /outcomeBindingFingerprint: pre\.outcome\.outcomeBindingFingerprint/);
  });

  t('32 outcome chain corruption on disk fails closed (any single source)', async () => {
    const a = await closed();
    rewrite(a.authzPath, r => { r.runId = 'other-run'; }, { reseal: false });
    await rejects(verifyClosure(a.ctx), /OUTCOME_AUTHORIZATION_FINGERPRINT/);
    // a resealed consumption record that no longer names the same run
    const b = await closed();
    rewrite(path.join(b.repo, '.evolve/governance/r4-outcome-authorizations/outcome-authorization-0001.consumption.json'),
      r => { r.runId = 'other-run'; });
    await rejects(verifyClosure(b.ctx), /OUTCOME_CONSUMPTION_RUN_ID/);
    // a manifest + consumption pair that agree with each other but no longer
    // point at the authenticated outcome authorization
    const b2 = await closed();
    const { fingerprint: staleFp, ...origBody } = JSON.parse(readFileSync(b2.manifestPath, 'utf8'));
    const forged = sealRecord({ ...origBody, sealedCode: { authorizationFingerprint: H('8'), sealFingerprint: H('3') } });
    assert.equal(digest(origBody) === staleFp, true, 'sanity: original manifest is self-consistent');
    writeRecord(b2.manifestPath, forged);
    rewrite(path.join(b2.repo, '.evolve/governance/r4-outcome-authorizations/outcome-authorization-0001.consumption.json'), r => {
      r.outcomeRunFingerprint = forged.fingerprint; r.outcomeManifestFingerprint = forged.fingerprint;
    });
    await rejects(verifyClosure(b2.ctx), /OUTCOME_MANIFEST_AUTHORIZATION/);
    const c = await closed();
    rewrite(c.manifestPath, r => { r.runId = 'other-run'; }, { reseal: false });
    await rejects(verifyClosure(c.ctx), /OUTCOME_MANIFEST_FINGERPRINT/);
    // an outcome run the sealed attester cannot independently re-derive
    const d = await closed();
    d.ctx.verifyOutcomeRunIdentity = () => ({ runId: 'other-run', fingerprint: H('9') });
    await rejects(verifyClosure(d.ctx), /OUTCOME_RUN_NOT_INDEPENDENTLY_VERIFIED/);
    const e = await closed();
    rmSync(path.join(e.repo, '.evolve/governance/r4-outcome-authorizations/outcome-authorization-0001.consumption.json'), { force: true });
    await rejects(verifyClosure(e.ctx), /OUTCOME_CONSUMPTION_MISSING/);
    const g = await closed();
    chmodSync(g.authzPath, 0o644);
    await rejects(verifyClosure(g.ctx), /OUTCOME_AUTHORIZATION_MODE_NOT_0444/);
  });

  t('33 advisory A: completedCount is derived from membership length, not aliased to attemptsUsed', async () => {
    const fx = await closed();
    assert.equal(fx.closure.attemptsUsed, 6);
    assert.equal(fx.closure.completedCount, 6);
    assert.equal(fx.closure.completedCount, fx.closure.canonicalMembership.length);
    const cohort = copyCohortIdentity(readResultAttestation(fx.ctx), fx.ctx);
    assert.equal(cohort.completedCount, 6);
    assert.equal(cohort.attemptsUsed, 6);
    // the finalizer asserts the equality explicitly rather than implying it
    assert.match(finalizerSource, /attemptsUsed !== completedCount\) fail\('R4_CLOSE_COHORT_ATTEMPTS_NOT_COMPLETED'\)/);
    assert.doesNotMatch(finalizerSource, /completedCount: identity\.attemptsUsed/);
    assert.doesNotMatch(finalizerSource, /completedCount: c\.attemptsUsed/);
    assert.match(finalizerSource, /completedCount = identity\.canonicalMembership\.length/);
    // a membership shorter than attemptsUsed is refused (counts no longer alias)
    const h = makeFixture();
    const hAtt = readResultAttestation(h.ctx);
    const drifted = { ...hAtt, result: { ...hAtt.result, identity: { ...hAtt.result.identity, attemptsUsed: 7 } } };
    throwsSync(() => copyCohortIdentity(drifted, h.ctx), /COHORT_ATTEMPTS_MISMATCH/);
    // ...and so is an inflated membership
    const i = makeFixture();
    const iAtt = readResultAttestation(i.ctx);
    const grown = { ...iAtt, result: { ...iAtt.result,
      identity: { ...iAtt.result.identity, canonicalMembership: [...IDS, 's7'].sort(),
        canonicalMembershipDigest: digest([...IDS, 's7'].sort()) } } };
    throwsSync(() => copyCohortIdentity(grown, i.ctx), /COHORT_(COMPLETED_COUNT_MISMATCH|AUTHORIZATION_MEMBERSHIP)/);
  });

  t('34 advisory B: closure binds the finalization review fingerprint', async () => {
    const fx = await closed();
    const reviewFile = path.join(fx.ctx.closureDir, R4_FINALIZATION_REVIEW_FILE);
    const review = JSON.parse(readFileSync(reviewFile, 'utf8'));
    assert.equal(fx.closure.finalizationReviewFingerprint, review.fingerprint);
    // the closure fingerprint covers it: flipping the field breaks the record
    const g = await closed();
    rewrite(closureFile(g), r => { r.finalizationReviewFingerprint = H('9'); }, { reseal: false });
    await rejects(verifyClosure(g.ctx), /CLOSURE_FINGERPRINT/);
    // wrong review fingerprint, correctly resealed -> binding check fails
    const h = await closed();
    rewrite(closureFile(h), r => { r.finalizationReviewFingerprint = H('9'); });
    await rejects(verifyClosure(h.ctx), /CLOSURE_REVIEW_BINDING/);
    // a malformed fingerprint is rejected too
    const i = await closed();
    rewrite(closureFile(i), r => { r.finalizationReviewFingerprint = 'nope'; });
    await rejects(verifyClosure(i.ctx), /CLOSURE_REVIEW_FINGERPRINT_MALFORMED/);
    // a SUBSTITUTED review with the same verdict but a different fingerprint fails
    const j = await closed();
    const { fingerprint: _dropped, ...reviewBody } = review;
    const substituted = sealRecord({ ...reviewBody, reviewerIdentity: 'substituted-reviewer' });
    assert.equal(substituted.verdict, review.verdict, 'same verdict');
    assert.notEqual(substituted.fingerprint, review.fingerprint, 'different fingerprint');
    writeRecord(path.join(j.ctx.closureDir, R4_FINALIZATION_REVIEW_FILE), substituted);
    await rejects(verifyClosure(j.ctx), /CLOSURE_REVIEW_BINDING/);
    // a closure cannot be asserted without its review at all
    throwsSync(() => assertClosure(fx.closure, readResultAttestation(fx.ctx), fx.ctx, null), /CLOSURE_REVIEW_REQUIRED/);
  });

  t('35 advisory C: finalization review must not predate the completed attestation', async () => {
    const fx = makeFixture();
    const att = readResultAttestation(fx.ctx);
    const stale = reviewFor(fx, { reviewedAt: att.result.attestedAt - 1 });
    throwsSync(() => assertReview(stale, fx.ctx, att), /REVIEW_PREDATES_ATTESTATION/);
    // exactly at attestedAt is accepted (non-strict ordering)
    const boundary = reviewFor(fx, { reviewedAt: att.result.attestedAt });
    assert.equal(assertReview(boundary, fx.ctx, att).reviewedAt, att.result.attestedAt);
    // the real close path refuses a stale persisted review
    importReview(fx.ctx, stageReview(fx, { reviewedAt: att.result.attestedAt - 1 }));
    await rejects(closeR4(fx.ctx), /REVIEW_PREDATES_ATTESTATION/);
    assert.equal(existsSync(closureFile(fx)), false);
    // a review that predates the attestation can never produce a closure
    const g = makeFixture();
    importReview(g.ctx, stageReview(g, { reviewedAt: 2_999 }));
    await rejects(closeR4(g.ctx), /REVIEW_PREDATES_ATTESTATION/);
    await rejects(verifyClosure(g.ctx), /REVIEW_PREDATES_ATTESTATION|CLOSURE_MISSING/);
    assert.equal(existsSync(closureFile(g)), false);
    // chronology comes from RECORD timestamps only; filesystem mtime is never used
    assert.doesNotMatch(finalizerSource, /mtime|birthtime|ctime/);
    assert.match(finalizerSource, /att\.result\.attestedAt <= review\.reviewedAt/);
    // the accepted path really is attestation-then-review
    const good = await closed();
    const ga = readResultAttestation(good.ctx);
    const gr = JSON.parse(readFileSync(path.join(good.ctx.closureDir, R4_FINALIZATION_REVIEW_FILE), 'utf8'));
    assert.ok(ga.result.attestedAt <= gr.reviewedAt, 'attestedAt <= reviewedAt');
    assert.ok(gr.reviewedAt <= good.closure.closedAt, 'reviewedAt <= closedAt');
  });

  t('36 advisory D: durable constants are cross-checked against authenticated disk state', async () => {
    const fx = await closed();
    const pre = await verifyPreconditions(fx.ctx);
    const k = fx.constants;
    const stageC = { approvalCommit: k.a2Commit, approvalEpoch: k.a2Epoch, approvalFingerprint: k.a2Fingerprint,
      sealFingerprint: k.s6Fingerprint, continuationCommit: k.c1Commit, t0: k.t0 };
    const call = over => verifyDurableConstants(fx.ctx, { production: pre.production, stageC: { ...stageC, ...over },
      att: pre.att, attVerify: pre.attestation, outcome: pre.outcome });
    // happy path: the constant set agrees with every RESOLVED artifact
    assert.equal(call({}), true);
    // C1 constant vs resolved archive main / Stage-C continuation / production
    throwsSync(() => call({ continuationCommit: C40('7') }), /CONSTANT_C1_STAGE_C/);
    // A2 / S6 / T0 constants
    for (const [over, re] of [[{ approvalCommit: C40('7') }, /CONSTANT_A2$/], [{ approvalFingerprint: H('9') }, /CONSTANT_A2$/],
      [{ approvalEpoch: 9 }, /CONSTANT_A2_EPOCH/], [{ sealFingerprint: H('9') }, /CONSTANT_S6/], [{ t0: 1 }, /CONSTANT_T0/]]) {
      throwsSync(() => call(over), re);
    }
    // outcome identity constants vs the immutable outcome chain
    for (const key of R4_OUTCOME_IDENTITY_KEYS) {
      throwsSync(() => verifyDurableConstants(fx.ctx, { production: pre.production, stageC,
        att: pre.att, attVerify: pre.attestation, outcome: { ...pre.outcome, [key]: H('9') } }),
      new RegExp(`CONSTANT_OUTCOME_IDENTITY:${key}`));
    }
    // a constant may never merely validate itself: every comparison is against a
    // RESOLVED artifact value, never `constant === constant`
    assert.match(finalizerSource, /export function verifyDurableConstants/);
    assert.match(finalizerSource, /archive\.archiveMainCommit !== c\.c1Commit/);
    assert.match(finalizerSource, /manifest\.fingerprint !== c\.archiveManifestFingerprint/);
    assert.match(finalizerSource, /inventory\.aggregateDigest !== c\.evidenceInventoryDigest/);
    assert.match(finalizerSource, /att\.result\.fingerprint !== c\.resultAttestationFingerprint/);
    assert.doesNotMatch(slice('export function verifyDurableConstants', 'export async function verifyPreconditions'),
      /c\.\w+ !== c\.\w+/);
    // the real close path fails when a constant drifts off authenticated disk
    const g = makeFixture({ constants: { evidenceInventoryDigest: H('9') } });
    importReview(g.ctx, stageReview(g));
    await rejects(closeR4(g.ctx), /CONSTANT_INVENTORY_DIGEST/);
    const h = makeFixture();
    h.ctx.verifyArchiveManifest = () => ({ fingerprint: H('9'), archiveMainCommit: h.c1 });
    importReview(h.ctx, stageReview(h));
    await rejects(closeR4(h.ctx), /CONSTANT_ARCHIVE_MANIFEST/);
    const i = makeFixture();
    i.ctx.verifyArchiveRepo = () => ({ archiveMainCommit: C40('7'), archiveFsckPassed: true });
    importReview(i.ctx, stageReview(i));
    await rejects(closeR4(i.ctx), /CONSTANT_C1_ARCHIVE_MAIN/);
    const j = makeFixture();
    j.ctx.verifyAttestation = () => ({ review: j.review.fingerprint, claim: j.claim.fingerprint, result: H('9') });
    importReview(j.ctx, stageReview(j));
    await rejects(closeR4(j.ctx), /CONSTANT_ATTEST_INDEPENDENT_VERIFY|ATTEST_VERIFY_MISMATCH/);
    // against the REAL repository every durable constant still agrees with disk
    const real = productionContext();
    const realPre = await verifyPreconditions(real);
    assert.equal(realPre.outcome.outcomeAuthorizationFingerprint, R4_CLOSURE_CONSTANTS.outcomeAuthorizationFingerprint);
    assert.equal(realPre.outcome.outcomeRunId, R4_CLOSURE_CONSTANTS.outcomeRunId);
    assert.equal(realPre.outcome.outcomeRunFingerprint, R4_CLOSURE_CONSTANTS.outcomeRunFingerprint);
    assert.equal(realPre.outcome.outcomeBindingFingerprint, R4_CLOSURE_CONSTANTS.outcomeBindingFingerprint);
    const realAuthz = readOutcomeAuthorization(real);
    assert.equal(realAuthz.fingerprint, R4_CLOSURE_CONSTANTS.outcomeAuthorizationFingerprint);
    assert.equal(realAuthz.runId, R4_CLOSURE_CONSTANTS.outcomeRunId);
  });

  t('37 precondition wording never claims R4 is finalized; only the closure record may', async () => {
    assert.equal(R4_PRECONDITION_STATUS, 'READY_TO_CLOSE_R4');
    assert.equal(R4_CLOSURE_STATUS, 'R4_FINALIZED_AND_ARCHIVED');
    assert.notEqual(R4_PRECONDITION_STATUS, R4_CLOSURE_STATUS);
    const preBranch = slice("if (command === 'verify-preconditions')", "if (command === 'close')");
    assert.doesNotMatch(preBranch, /status: R4_CLOSURE_STATUS/);
    assert.match(preBranch, /status: R4_PRECONDITION_STATUS/);
    assert.match(preBranch, /preconditionsSatisfied: true/);
    assert.match(preBranch, /r4Finalized: false/);
    // R4_CLOSURE_STATUS survives only in the closure record, its assertion and the export
    const uses = finalizerSource.split('R4_CLOSURE_STATUS').length - 1;
    assert.ok(uses <= 3, `R4_CLOSURE_STATUS referenced ${uses} times`);
    // the accepted synthetic path still yields the real closure status
    const fx = await closed();
    assert.equal(fx.closure.status, R4_CLOSURE_STATUS);
    assert.equal(JSON.parse(readFileSync(closureFile(fx), 'utf8')).status, R4_CLOSURE_STATUS);
    // and the real repository does not claim to be finalized either
    const real = productionContext();
    assert.equal(existsSync(path.join(real.closureDir, R4_FINALIZATION_FILE)), false);
    assert.equal(existsSync(path.join(real.closureDir, R4_FINALIZATION_REVIEW_FILE)), false);
    assert.equal(existsSync(real.closureDir), realClosureExisted);
  });

  for (const [name, fn] of cases) await ok(name, fn);
  console.log(`PASS ${passed} case groups`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}