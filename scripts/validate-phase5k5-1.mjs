#!/usr/bin/env node
// Phase 5K.5.1 - REPRODUCIBLE TEMPORAL REVISION EVIDENCE validator.
//
// WHAT THIS VALIDATOR IS FOR
//
// 5K.5 classifies a content change as PROVIDER_DECLARED_CONTENT_REVISION only
// when a provider-declared edit timestamp was supplied as a separate, bound
// revision-evidence sidecar at build time. The COMMITTED 5K.5 snapshot persisted
// the derived records but NOT that sidecar, so `verifyTemporalSnapshot` rebuilt
// the corpus without the proof and a snapshot containing a declared revision (or
// simply an unverified divergence, whose chain link carries no declaration)
// could never verify. This validator proves the compatibility repair:
//
//   - a provider-declared revision is reproducible from the PERSISTED artifact;
//   - an unverified divergence persists the absence of proof as an authenticated
//     empty sidecar instead of losing it;
//   - snapshots written before the repair keep verifying when their contents do
//     not depend on revision evidence, and fail closed BY NAME when they do;
//   - the sidecar digest is authenticated, tamper-evident and write-once;
//   - the rebuild is deterministic, offline, market-free and .evolve-free.
//
// COMPLETELY OFFLINE AND DETERMINISTIC. Runs are produced with injected counter
// clocks and in-memory fixture fetches; the global fetch and the socket connect
// primitive are replaced with tripwires and asserted never called. Every root is
// a temporary directory; the repository tree, `var/` and `.evolve` are never
// written. 5K.5 semantics are NOT redesigned here: temporal version identity,
// SAME_CONTENT_UPDATED_STATE, provider-declared revision semantics,
// UNVERIFIED_CONTENT_DIVERGENCE, raw evidence fingerprints and every historical
// snapshot that needs no revision evidence are all preserved, and this validator
// asserts each of them on the repaired artifacts.
//
// IMPORT BOUNDARY
//
// Every 5K.x validator asserts that nothing OUTSIDE `scripts/public-intelligence/`
// imports a protected phase module, and those checks enumerate `git ls-files`, so
// a TRACKED validator that reaches a protected module directly breaks them. This
// validator therefore imports exactly ONE project module - the governed 5K.5
// temporal surface - and names no protected module path of any other phase.
import assert from 'node:assert/strict';
import net from 'node:net';
import {
  chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

let tripwireCalls = 0;
globalThis.fetch = () => { tripwireCalls += 1; throw new Error('TRIPWIRE: validator attempted a real fetch'); };
net.Socket.prototype.connect = function tripwire() { tripwireCalls += 1; throw new Error('TRIPWIRE: validator attempted a socket connect'); };

// The ONE project import: the governed 5K.1-5K.5 temporal surface.
const SURFACE = await import('./public-intelligence/temporal-validation-surface.mjs');

const RUNS = SURFACE.RUNS_5K3;
const MAPPER = SURFACE;
const REV = SURFACE.REVISION_CHAIN_5K5;
const SNAP = SURFACE.TEMPORAL_SNAPSHOT_5K5;
const VERIFY = SURFACE.TEMPORAL_VERIFY_5K5;
const { PUBLIC_INTELLIGENCE_CLASSIFICATION, canonical, digest } = SURFACE;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PI = 'scripts/public-intelligence';
const TEMPORAL_MODULES = ['temporal-projection', 'observation-state', 'revision-chain', 'temporal-corpus', 'temporal-query', 'temporal-snapshot', 'temporal-verify']
  .map(name => `${PI}/${name}.mjs`);
const require = createRequire(import.meta.url);
const espree = require('espree');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const temporary = [];
const tempRoot = () => { const root = mkdtempSync(path.join(tmpdir(), 'evolve-5k5-1-')); temporary.push(root); return root; };
const file = (dir, name) => path.join(dir, name);
const refusal = (fn, fragment) => {
  let thrown = null;
  try { fn(); } catch (error) { thrown = error; }
  assert.ok(thrown, `expected refusal containing ${fragment}`);
  assert.ok(String(thrown.message).includes(fragment), `expected ${fragment}, got ${thrown.message}`);
};
const hasFailure = (result, prefix) => result.failures.some(code => code.startsWith(prefix));
const readNd = target => readFileSync(target, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
const verifyOf = ctx => VERIFY.verifyTemporalSnapshot(ctx.root, ctx.id);

// ---------------------------------------------------------------------------
// FIXTURES (structural only: no handle, name, bio or credential)
// ---------------------------------------------------------------------------
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MINT_2 = 'So11111111111111111111111111111111111111112';
const T0 = 1790000000000;
const HOST = 'fixture.example';
const BOUNDS = Object.freeze({ maxPages: 2, maxRecords: 10, timeoutMs: 5000, maxResponseBytes: 100_000, maxLookbackMs: 3 * 24 * 60 * 60 * 1000 });
const DEFAULT_POLICY = SURFACE.PUBLIC_INTELLIGENCE_5K4_DEFAULT_POLICY;
const DECLARED_EDIT_AT = T0 + 50_000;

const status = (id, over = {}) => ({
  id: String(id), visibility: 'public', created_at: '2026-10-01T10:00:00.000Z', url: `https://${HOST}/@alice/${id}`,
  in_reply_to_id: null, reblog: null, language: 'en', content: `<p>post ${id} mint ${MINT}</p>`, tags: [{ name: 'solana' }],
  favourites_count: 3, replies_count: 0, reblogs_count: 1,
  account: { id: '42', acct: 'alice', display_name: 'Alice Real Name', note: '<p>private bio</p>', followers_count: 777 },
  ...over,
});

const makeClock = start => { let t = start; return () => { t += 10; return t; }; };
const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const pagedFetch = pages => { let calls = 0; return async () => json(pages[calls++] ?? []); };

/** Produces ONE immutable 5K.3 run in `root` (real plan -> transport -> mapper -> ingest). */
async function makeRun(root, { start = T0, pages = [[status(30)]] } = {}) {
  const plan = RUNS.buildCollectionPlan({
    instance: HOST, hashtag: 'solana', bounds: { ...BOUNDS }, collectionMode: 'OFFLINE_FIXTURE', createdAt: start,
  });
  return RUNS.executeCollectionRun(plan, { clock: makeClock(start), fetchImpl: pagedFetch(pages), outputRoot: root });
}

/** Builds the governed sidecar for one authenticated raw observation of a run. */
function sidecarFor(directory, providerObservationId, editedAt) {
  const raw = readNd(file(directory, 'raw-evidence.ndjson'))
    .find(record => record.providerObservationId === providerObservationId);
  assert.ok(raw, `the fixture run carries observation ${providerObservationId}`);
  return REV.buildRevisionEvidence({
    provider: raw.provider, providerObservationId: raw.providerObservationId,
    rawObservationFingerprint: SURFACE.rawObservationFingerprint(raw), editedAt,
  });
}

/**
 * A REAL two-run corpus carrying all three claims at once:
 *   30 - provider-declared revision (an edit the provider declared, with proof)
 *   31 - unverified divergence (different content, no declaration at all)
 *   32 - ordinary engagement update (same content, new counter)
 *
 * `evidence` selects whether the declared-revision sidecar is supplied; `shuffled`
 * reverses the run order handed to the builder, which must change nothing.
 */
async function revisionCorpus({ evidence = 'declared', shuffled = false } = {}) {
  const root = tempRoot();
  const a = await makeRun(root, { start: T0, pages: [[status(30, { favourites_count: 10 }), status(31), status(32)]] });
  const b = await makeRun(root, { start: T0 + 100_000, pages: [[
    status(30, { content: `<p>post 30 revised ${MINT_2}</p>`, favourites_count: 11 }),
    status(31, { content: '<p>post 31 diverged with no provider proof</p>' }),
    status(32, { favourites_count: 12 }),
  ]] });
  const sidecar = sidecarFor(b.directory, '30', DECLARED_EDIT_AT);
  const revisionEvidence = evidence === 'declared' ? [sidecar] : evidence === 'none' ? [] : evidence;
  const runIds = [a.runId, b.runId];
  const built = SNAP.buildAndStoreTemporalSnapshot({
    root, runIds: shuffled ? [...runIds].reverse() : runIds, policy: DEFAULT_POLICY, revisionEvidence, createdAt: T0 + 1_000_000,
  });
  return { root, runIds, a, b, sidecar, revisionEvidence, result: built, id: built.temporalSnapshotId, dir: built.directory, manifest: built.manifest };
}

/** A REAL two-run corpus with NO content change anywhere: counters only. */
async function ordinaryCorpus() {
  const root = tempRoot();
  const a = await makeRun(root, { start: T0, pages: [[status(30, { favourites_count: 10 }), status(31)]] });
  const b = await makeRun(root, { start: T0 + 100_000, pages: [[status(30, { favourites_count: 14 }), status(31)]] });
  const runIds = [a.runId, b.runId];
  const built = SNAP.buildAndStoreTemporalSnapshot({ root, runIds, policy: DEFAULT_POLICY, createdAt: T0 + 1_000_000 });
  return { root, runIds, result: built, id: built.temporalSnapshotId, dir: built.directory, manifest: built.manifest };
}

const EVIDENCE_FILE = 'source-revision-evidence.ndjson';

/** Rewrites the stored manifest exactly as a tamperer with the signing key would. */
function editManifest(dir, fn, { resign = true } = {}) {
  const target = file(dir, 'temporal-snapshot.json');
  chmodSync(target, 0o644);
  const manifest = JSON.parse(readFileSync(target, 'utf8'));
  fn(manifest);
  if (resign) manifest.snapshotFingerprint = SNAP.temporalSnapshotFingerprintOf(manifest);
  writeFileSync(target, `${canonical(manifest)}\n`);
  chmodSync(target, 0o444);
  return manifest;
}

/**
 * Re-shapes a stored snapshot into EXACTLY what pre-5K.5.1 code produced: the
 * derived records, and a manifest with no binding fields and no sidecar file.
 */
function stripToLegacy(dir) {
  rmSync(file(dir, EVIDENCE_FILE));
  editManifest(dir, manifest => {
    delete manifest.revisionEvidenceCount;
    delete manifest.revisionEvidenceDigest;
  });
}

function parseModule(relative) {
  const source = readFileSync(path.join(REPO_ROOT, relative), 'utf8');
  const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const found = { identifiers: [], stringLiterals: [], importSources: [] };
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === 'Identifier') found.identifiers.push(node.name);
    if (node.type === 'Literal' && typeof node.value === 'string') found.stringLiterals.push(node.value);
    if (['ImportDeclaration', 'ExportAllDeclaration', 'ExportNamedDeclaration', 'ImportExpression'].includes(node.type) && node.source?.value) {
      found.importSources.push(node.source.value);
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(ast);
  return { source, found };
}

// ===========================================================================
// A. REPRODUCTION: A DECLARED REVISION SURVIVES THE SNAPSHOT
// ===========================================================================
test('A1 a provider-declared revision snapshot persists its revision evidence', async () => {
  const ctx = await revisionCorpus();
  assert.equal(ctx.result.outcome, 'CREATED');
  assert.equal(ctx.manifest.providerDeclaredRevisionCount, 1);
  assert.equal(ctx.manifest.unverifiedDivergenceCount, 1);
  assert.equal(ctx.manifest.revisionEvidenceCount, 1);
  assert.equal(ctx.manifest.revisionEvidenceDigest, digest([ctx.sidecar]));
  const stored = SNAP.loadTemporalArtifacts(ctx.dir);
  assert.equal(stored.revisionEvidence.length, 1);
  assert.equal(ctx.manifest.revisionEvidenceDigest, digest(stored.revisionEvidence));
  REV.validateRevisionEvidence(stored.revisionEvidence[0]);
  assert.equal(stored.revisionEvidence[0].rawObservationFingerprint, ctx.sidecar.rawObservationFingerprint);
  assert.equal(stored.revisionEvidence[0].providerRevisionTimestamp, DECLARED_EDIT_AT);
});
test('A2 the declared revision and the divergence are both reproduced exactly', async () => {
  const ctx = await revisionCorpus();
  const stored = SNAP.loadTemporalArtifacts(ctx.dir);
  const byId = id => stored.observationRecords.filter(record => record.providerObservationId === id).sort((a, b) => a.fetchedAt - b.fetchedAt);
  const revised = byId('30');
  assert.equal(revised.length, 2, 'both authenticated versions are retained');
  assert.equal(revised[1].temporalClassification, 'PROVIDER_DECLARED_CONTENT_REVISION');
  assert.equal(revised[1].providerRevisionTimestamp, DECLARED_EDIT_AT);
  const diverged = byId('31');
  assert.equal(diverged.length, 2);
  assert.equal(diverged[1].temporalClassification, 'UNVERIFIED_CONTENT_DIVERGENCE');
  assert.equal(diverged[1].providerRevisionTimestamp, null, 'proof is never invented for the divergence');
  // The sidecar binds exactly ONE observation, and it is the declared one.
  assert.ok(stored.revisionEvidence.every(record => record.providerObservationId === '30'));
  const conflict = stored.contentRecords.find(record => record.providerObservationId === '31');
  assert.equal(conflict.conflicted, true);
  assert.equal(conflict.versionCount, 2, 'a conflicted identity keeps every version and selects no winner');
  // The declared chain is a genuine revision chain, not a conflict in disguise.
  assert.equal(REV.verifyRevisionChain(stored.revisions.filter(record => record.providerObservationId === '30')).ok, true);
  assert.equal(REV.verifyConflictedChainStructure(stored.revisions.filter(record => record.providerObservationId === '31')).ok, true);
});
test('A3 the mixed revision + divergence snapshot verifies green offline', async () => {
  const ctx = await revisionCorpus();
  const verification = verifyOf(ctx);
  assert.deepEqual(verification.failures, []);
  assert.equal(verification.ok, true);
});
test('A4 the snapshot is fully reproducible from its own persisted artifacts', async () => {
  const ctx = await revisionCorpus();
  const stored = SNAP.loadTemporalArtifacts(ctx.dir);
  const rebuilt = SNAP.rebuildTemporalSnapshot({
    root: ctx.root, runIds: ctx.runIds, policy: DEFAULT_POLICY, revisionEvidence: stored.revisionEvidence,
  });
  assert.equal(canonical(rebuilt.contentRecords), canonical(stored.contentRecords));
  assert.equal(canonical(rebuilt.observationRecords), canonical(stored.observationRecords));
  assert.equal(canonical(rebuilt.states), canonical(stored.states));
  assert.equal(canonical(rebuilt.revisions), canonical(stored.revisions));
  assert.equal(digest(stored.contentRecords), ctx.manifest.contentDigest);
  assert.equal(digest(stored.observationRecords), ctx.manifest.observationDigest);
  assert.equal(digest(stored.states), ctx.manifest.stateDigest);
  assert.equal(digest(stored.revisions), ctx.manifest.revisionDigest);
  assert.equal(ctx.manifest.revisionEvidenceCount, stored.revisionEvidence.length);
});
test('A5 an ordinary corpus persists an EMPTY authenticated sidecar and verifies', async () => {
  const ctx = await ordinaryCorpus();
  assert.equal(ctx.manifest.providerDeclaredRevisionCount, 0);
  assert.equal(ctx.manifest.unverifiedDivergenceCount, 0);
  assert.equal(ctx.manifest.revisionEvidenceCount, 0);
  assert.equal(ctx.manifest.revisionEvidenceDigest, digest([]));
  const stored = SNAP.loadTemporalArtifacts(ctx.dir);
  assert.deepEqual(stored.revisionEvidence, []);
  assert.ok(!stored.missingFiles.includes(EVIDENCE_FILE), 'the sidecar is recorded as present and empty');
  assert.equal(verifyOf(ctx).ok, true);
});

// ===========================================================================
// B. DIVERGENCE: THE ABSENCE OF PROOF IS PERSISTED, NOT LOST
// ===========================================================================
test('B1 an unproved divergence persists as a missing declaration, never as proof', async () => {
  // With NO evidence supplied, identity 30 (different text) is a divergence too:
  // two conflicted identities and zero declared revisions.
  const ctx = await revisionCorpus({ evidence: 'none' });
  assert.equal(ctx.manifest.providerDeclaredRevisionCount, 0);
  assert.equal(ctx.manifest.unverifiedDivergenceCount, 2);
  assert.equal(ctx.manifest.conflictedUpstreamIdentityCount, 2);
  assert.equal(ctx.manifest.revisionEvidenceCount, 0);
  const stored = SNAP.loadTemporalArtifacts(ctx.dir);
  assert.deepEqual(stored.revisionEvidence, []);
  assert.ok(!stored.missingFiles.includes(EVIDENCE_FILE));
  for (const record of stored.observationRecords) {
    if (record.temporalClassification === 'UNVERIFIED_CONTENT_DIVERGENCE') assert.equal(record.providerRevisionTimestamp, null);
  }
  assert.equal(verifyOf(ctx).ok, true, 'the divergence snapshot still verifies');
});

// ===========================================================================
// C. BACKWARD COMPATIBILITY
// ===========================================================================
test('C1 an ordinary snapshot in its pre-5K.5.1 shape still verifies unchanged', async () => {
  const ctx = await ordinaryCorpus();
  stripToLegacy(ctx.dir);
  const stored = SNAP.loadTemporalArtifacts(ctx.dir);
  assert.equal(Object.hasOwn(stored.manifest, 'revisionEvidenceDigest'), false);
  assert.equal(existsSync(file(ctx.dir, EVIDENCE_FILE)), false);
  const verification = verifyOf(ctx);
  assert.deepEqual(verification.failures, []);
  assert.equal(verification.ok, true, 'a snapshot that needs no revision evidence is never invalidated');
});
test('C2 a pre-5K.5.1 snapshot whose contents NEED evidence fails closed by name', async () => {
  const ctx = await revisionCorpus();
  stripToLegacy(ctx.dir);
  const verification = verifyOf(ctx);
  assert.equal(verification.ok, false);
  assert.equal(verification.failures[0], 'REVISION_EVIDENCE_REQUIRED_BUT_ABSENT');
});
test('C3 the unproved-divergence snapshot is unaffected by the repair', async () => {
  const ctx = await revisionCorpus({ evidence: 'none' });
  stripToLegacy(ctx.dir);
  const verification = verifyOf(ctx);
  assert.equal(verification.ok, true, verification.failures.join(','));
});
test('C4 a sidecar the manifest does not bind never enters the rebuild', async () => {
  const ctx = await revisionCorpus();
  editManifest(ctx.dir, manifest => {
    delete manifest.revisionEvidenceCount;
    delete manifest.revisionEvidenceDigest;
  });
  const verification = verifyOf(ctx);
  assert.equal(verification.ok, false);
  assert.ok(hasFailure(verification, 'REVISION_EVIDENCE_PRESENT_WITHOUT_BINDING'), verification.failures.join(','));
});
test('C5 the stored binding is all-or-nothing inside the closed schema', async () => {
  const ctx = await revisionCorpus();
  editManifest(ctx.dir, manifest => { delete manifest.revisionEvidenceCount; });
  assert.ok(hasFailure(verifyOf(ctx), 'SNAPSHOT_MANIFEST_INVALID'));
  const other = await revisionCorpus();
  editManifest(other.dir, manifest => { manifest.revisionEvidenceSource = 'MASTODON_STATUS_EDITED_AT'; });
  const verification = verifyOf(other);
  assert.equal(verification.ok, false);
  assert.ok(hasFailure(verification, 'SNAPSHOT_MANIFEST_INVALID'), verification.failures.join(','));
});

// ===========================================================================
// D. AUTHENTICATION, TAMPER AND REMOVAL
// ===========================================================================
test('D1 a tampered sidecar record is rejected', async () => {
  const ctx = await revisionCorpus();
  const target = file(ctx.dir, EVIDENCE_FILE);
  const records = readNd(target);
  chmodSync(target, 0o644);
  writeFileSync(target, `${canonical({ ...records[0], providerRevisionTimestamp: records[0].providerRevisionTimestamp + 1 })}\n`);
  const verification = verifyOf(ctx);
  assert.equal(verification.ok, false);
  assert.ok(hasFailure(verification, 'REVISION_EVIDENCE_DIGEST_DRIFT'), verification.failures.join(','));
  assert.ok(hasFailure(verification, 'REVISION_EVIDENCE_INVALID'));
});
test('D2 a RE-FINGERPRINTED record is still caught by the declared file digest', async () => {
  const ctx = await revisionCorpus();
  const target = file(ctx.dir, EVIDENCE_FILE);
  const record = readNd(target)[0];
  const body = { ...record, providerRevisionTimestamp: record.providerRevisionTimestamp + 1 };
  delete body.revisionEvidenceFingerprint;
  chmodSync(target, 0o644);
  writeFileSync(target, `${canonical({ ...body, revisionEvidenceFingerprint: digest(body) })}\n`);
  const verification = verifyOf(ctx);
  assert.equal(verification.ok, false);
  assert.ok(hasFailure(verification, 'REVISION_EVIDENCE_DIGEST_DRIFT'), verification.failures.join(','));
  assert.ok(!hasFailure(verification, 'REVISION_EVIDENCE_INVALID'), 'the record itself is internally valid: the FILE digest is what refuses it');
});
test('D3 evidence swapped wholesale is detected in the rebuild', async () => {
  const ctx = await revisionCorpus();
  const target = file(ctx.dir, EVIDENCE_FILE);
  const record = readNd(target)[0];
  const body = { ...record, providerRevisionTimestamp: record.providerRevisionTimestamp + 10_000 };
  delete body.revisionEvidenceFingerprint;
  const swapped = [{ ...body, revisionEvidenceFingerprint: digest(body) }];
  chmodSync(target, 0o644);
  writeFileSync(target, `${canonical(swapped[0])}\n`);
  editManifest(ctx.dir, manifest => {
    manifest.revisionEvidenceCount = swapped.length;
    manifest.revisionEvidenceDigest = digest(swapped);
  });
  const verification = verifyOf(ctx);
  assert.equal(verification.ok, false);
  assert.ok(hasFailure(verification, 'CONTENT_MODIFIED') || hasFailure(verification, 'OBSERVATION_REMOVED'), verification.failures.join(','));
});
test('D4 removing the sidecar from a bound snapshot fails closed', async () => {
  const ctx = await revisionCorpus();
  rmSync(file(ctx.dir, EVIDENCE_FILE));
  const verification = verifyOf(ctx);
  assert.equal(verification.ok, false);
  assert.ok(hasFailure(verification, 'REVISION_EVIDENCE_ARTIFACT_MISSING'), verification.failures.join(','));
});
test('D5 an extra ungoverned sidecar file is refused', async () => {
  const ctx = await revisionCorpus();
  writeFileSync(file(ctx.dir, 'revision-evidence-extra.ndjson'), '{}\n');
  assert.ok(hasFailure(verifyOf(ctx), 'EXTRA_FILES'));
});
test('D6 the evidence the snapshot authenticates is exactly its own', async () => {
  const left = await revisionCorpus();
  const right = await ordinaryCorpus();
  // A snapshot may not be re-pointed at another snapshot's evidence: the count
  // and digest are authenticated by the manifest fingerprint.
  const foreign = readFileSync(file(left.dir, EVIDENCE_FILE), 'utf8');
  const target = file(right.dir, 'temporal-snapshot.json');
  chmodSync(target, 0o644);
  const manifest = JSON.parse(readFileSync(target, 'utf8'));
  manifest.revisionEvidenceCount = 1;
  manifest.revisionEvidenceDigest = digest([JSON.parse(foreign)]);
  writeFileSync(target, `${canonical(manifest)}\n`);
  assert.ok(hasFailure(verifyOf(right), 'SNAPSHOT_FINGERPRINT_MISMATCH'));
});

// ===========================================================================
// E. DETERMINISM AND WRITE-ONCE
// ===========================================================================
test('E1 the same sources yield byte-identical artifacts in a different build', async () => {
  const left = await revisionCorpus();
  const right = await revisionCorpus({ shuffled: true });
  assert.equal(left.id, right.id, 'the snapshot identity ignores run order');
  for (const name of Object.values(SNAP.PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_FILES)) {
    assert.equal(readFileSync(file(left.dir, name), 'utf8'), readFileSync(file(right.dir, name), 'utf8'), name);
  }
});
test('E2 the persisted sidecar is a canonical, validated, fingerprint-sorted set', async () => {
  const ctx = await revisionCorpus();
  const records = readNd(file(ctx.dir, EVIDENCE_FILE));
  const fingerprints = records.map(record => record.rawObservationFingerprint);
  assert.deepEqual(fingerprints, [...fingerprints].sort());
  const second = sidecarFor(ctx.b.directory, '31', DECLARED_EDIT_AT + 1_000);
  const canonicalForm = REV.canonicalRevisionEvidence([second, ...records]);
  assert.deepEqual(canonicalForm.map(record => record.rawObservationFingerprint), [...canonicalForm.map(record => record.rawObservationFingerprint)].sort());
  refusal(() => REV.canonicalRevisionEvidence([records[0], records[0]]), 'REV_EVIDENCE_DUPLICATE_BINDING');
  refusal(() => REV.canonicalRevisionEvidence([{ ...records[0], providerRevisionTimestamp: DECLARED_EDIT_AT + 1 }]), 'REV_EVIDENCE_FINGERPRINT_MISMATCH');
  refusal(() => REV.canonicalRevisionEvidence([{ ...records[0], extra: 1 }]), 'REV_EVIDENCE_UNKNOWN_FIELD');
  refusal(() => REV.canonicalRevisionEvidence('not-an-array'), 'REV_EVIDENCE_LIST_REQUIRED');
});
test('E3 a different evidence set can never overwrite a stored snapshot', async () => {
  const ctx = await revisionCorpus();
  const before = readFileSync(file(ctx.dir, EVIDENCE_FILE), 'utf8');
  refusal(() => SNAP.buildAndStoreTemporalSnapshot({
    root: ctx.root, runIds: ctx.runIds, policy: DEFAULT_POLICY, revisionEvidence: [], createdAt: T0 + 2_000_000,
  }), 'SNAPSHOT_EXISTS_DIFFERENT');
  assert.equal(readFileSync(file(ctx.dir, EVIDENCE_FILE), 'utf8'), before, 'the refusal wrote nothing');
});
test('E4 rebuilding the identical corpus reports ALREADY_EXISTS_IDENTICAL', async () => {
  const ctx = await revisionCorpus();
  const again = SNAP.buildAndStoreTemporalSnapshot({
    root: ctx.root, runIds: ctx.runIds, policy: DEFAULT_POLICY, revisionEvidence: ctx.revisionEvidence, createdAt: T0 + 3_000_000,
  });
  assert.equal(again.outcome, 'ALREADY_EXISTS_IDENTICAL');
  assert.equal(again.directory, ctx.dir);
});
test('E5 every stored artifact, including the sidecar, is read-only on disk', async () => {
  const ctx = await revisionCorpus();
  for (const name of Object.values(SNAP.PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_FILES)) {
    assert.equal(statSync(file(ctx.dir, name)).mode & 0o777, 0o444, name);
  }
});

// ===========================================================================
// F. OFFLINE, MARKET-FREE AND .evolve-FREE
// ===========================================================================
test('F1 no temporal module reaches a socket, engine, market or wallet surface', () => {
  const network = ['node:http', 'node:https', 'node:http2', 'node:net', 'node:tls', 'node:dgram', 'node:dns', 'node:child_process'];
  const banned = /^(signTransaction|sendTransaction|executeSwap|privateKey|secretKey|signer|walletAddress|priceUsd|getPrice|marketCap)$/;
  for (const entry of TEMPORAL_MODULES) {
    const { found, source } = parseModule(entry);
    for (const source_ of found.importSources) {
      assert.ok(!network.includes(source_), `${entry} imports ${source_}`);
      assert.ok(!/engine|arena|wallet|signer|swap|rpc|market|price|feed/i.test(source_), `${entry} imports ${source_}`);
    }
    for (const identifier of found.identifiers) assert.ok(!banned.test(identifier), `${entry}:${identifier}`);
    assert.ok(!/\bpriceUsd\b|\bmarketCap\b|\bfutureReturn\b/.test(source), `${entry} names a market field`);
  }
});
test('F2 no stored artifact carries a score, sentiment, trend or market field', async () => {
  const ctx = await revisionCorpus();
  const words = /sentiment|score|rank|signal|momentum|popular|importance|velocity|growth|virality|profit|alpha|recommend|predict|confidence|price|market/i;
  const walk = value => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        if (key === 'classification') continue;
        assert.ok(!words.test(key), `an artifact carries ${key}`);
        walk(inner);
      }
    }
    return undefined;
  };
  walk(ctx.manifest);
  const stored = SNAP.loadTemporalArtifacts(ctx.dir);
  for (const collection of [stored.contentRecords, stored.observationRecords, stored.states, stored.revisions, stored.revisionEvidence]) {
    collection.forEach(walk);
  }
  for (const flag of ['tradingAuthority', 'engineAuthority', 'arenaEligible', 'promotionEligible', 'profitabilityInferencePermitted']) {
    assert.equal(PUBLIC_INTELLIGENCE_CLASSIFICATION[flag], false, flag);
  }
  assert.deepEqual([...REV.PUBLIC_INTELLIGENCE_5K5_REVISION_EVIDENCE_SOURCES], ['MASTODON_STATUS_EDITED_AT']);
});
test('F3 the sidecar duplicates no post body, profile field or credential', async () => {
  const ctx = await revisionCorpus();
  const text = readFileSync(file(ctx.dir, EVIDENCE_FILE), 'utf8').toLowerCase();
  for (const leak of ['post 30', 'revised', 'diverged', 'alice', 'display_name', 'followers', 'avatar', 'bio', 'note',
    'token', 'cookie', 'authorization', 'bearer', 'password', 'secret', 'http://', 'https://', MINT.toLowerCase()]) {
    assert.ok(!text.includes(leak), `the sidecar leaked ${leak}`);
  }
  const record = SNAP.loadTemporalArtifacts(ctx.dir).revisionEvidence[0];
  assert.deepEqual(Object.keys(record).sort(), [...REV.PUBLIC_INTELLIGENCE_5K5_REVISION_EVIDENCE_SCHEMA.fields].sort());
  assert.equal(Object.hasOwn(record, 'rawText'), false);
  assert.equal(Object.hasOwn(record, 'providerAuthorId'), false);
});
test('F4 .evolve is never written and the storage guard refuses it by name', async () => {
  const ctx = await ordinaryCorpus();
  assert.equal(existsSync(path.join(ctx.root, '.evolve')), false);
  refusal(() => SNAP.temporalCorporaDirectoryOf(path.join(ctx.root, '.evolve', 'public-intelligence'), `tsnap-${'a'.repeat(32)}`),
    'STORE_PATH_FORBIDDEN');
  for (const name of Object.values(SNAP.PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_FILES)) {
    assert.ok(!readFileSync(file(ctx.dir, name), 'utf8').includes('.evolve'), name);
  }
});
test('F5 the validator made zero real network calls', () => assert.equal(tripwireCalls, 0));

// ---------------------------------------------------------------------------
async function main() {
  let failed = 0;
  try {
    for (const [name, fn] of tests) {
      try { await fn(); console.log(`PASS ${name}`); } catch (error) { failed++; console.error(`FAIL ${name}: ${error.stack}`); }
    }
  } finally { for (const root of temporary) rmSync(root, { recursive: true, force: true }); }
  console.log(`Phase 5K.5.1: ${tests.length - failed}/${tests.length} passed; offline, fixture runs + injected clocks only, ${tripwireCalls} network calls, revision evidence reproducible from persisted snapshots`);
  if (failed) process.exitCode = 1;
}
main().catch(error => { console.error('phase 5K.5.1 validator crashed:', error); process.exitCode = 1; });
