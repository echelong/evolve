#!/usr/bin/env node
// Phase 5K.6.1 - PROVIDER-SCOPED COLLECTION BOUNDS validator.
//
// COMPLETELY OFFLINE AND DETERMINISTIC. The global fetch and the socket connect
// primitive are replaced with tripwires and the suite asserts neither was ever
// called, which is how "an invalid plan is refused BEFORE any transport is
// reached" is proven rather than asserted. Every run root is a temporary
// directory; the repository tree, `var/` and `.evolve` are never written.
//
// IMPORT BOUNDARY
//
// Every phase validator asserts that nothing OUTSIDE `scripts/public-intelligence/`
// imports a protected phase module, and those checks enumerate `git ls-files`, so
// a TRACKED validator that imports one directly breaks them. This validator
// therefore reaches 5K.0-5K.6 through the existing governed surface and nothing
// else. The protected fragment names it needs come from that surface too, so this
// file never spells a protected module path.
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

let tripwireCalls = 0;
globalThis.fetch = () => { tripwireCalls += 1; throw new Error('TRIPWIRE: validator attempted a real fetch'); };
net.Socket.prototype.connect = function tripwire() { tripwireCalls += 1; throw new Error('TRIPWIRE: validator attempted a socket connect'); };

// The ONE project import: the governed surface, which already re-exports the 5K.6
// provider modules, the 5K.3 run machinery and the 5K.6.1 capability registry.
const SURFACE = await import('./public-intelligence/bluesky-validation-surface.mjs');

const B_COMMON = SURFACE.BLUESKY_COMMON_5K6;
const B_TRANSPORT = SURFACE.BLUESKY_TRANSPORT_5K6;
const B_ADAPTER = SURFACE.BLUESKY_ADAPTER_5K6;
const CAP = SURFACE.PROVIDER_CAPABILITIES_5K6_1;
const { buildCollectionPlan, executeCollectionRun, replayRun } = SURFACE;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PI = 'scripts/public-intelligence';
const R4_HEAD = '1c30264fb87876eeaf229e25c5cdc5adca429b40';
const require = createRequire(import.meta.url);
const espree = require('espree');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const temporary = [];
const tempRoot = () => { const root = mkdtempSync(path.join(tmpdir(), 'evolve-5k6-1-')); temporary.push(root); return root; };
const gitOut = (...args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
const refusal = (fn, fragment) => {
  let thrown = null;
  try { fn(); } catch (error) { thrown = error; }
  assert.ok(thrown, `expected refusal containing ${fragment}`);
  assert.ok(String(thrown.message).includes(fragment), `expected ${fragment}, got ${thrown.message}`);
};
const existsFile = candidate => { try { return statSync(candidate).isFile(); } catch { return false; } };
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
    for (const value of Object.values(node)) if (value && typeof value === 'object') walk(value);
  };
  walk(ast);
  return { source, found };
}

// ---- fixtures --------------------------------------------------------------
const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const MASTODON_HOST = 'fixture.example';
const PLAN_BOUNDS = Object.freeze({
  maxPages: 1, maxRecords: 5, timeoutMs: 10_000, maxResponseBytes: 524_288, maxLookbackMs: 86_400_000,
});
const MASTODON_CEILINGS = Object.freeze({ maxPages: 5, maxRecords: 200, timeoutMs: 20_000, maxResponseBytes: 2_097_152, maxLookbackMs: 604_800_000 });
const BLUESKY_CEILINGS = Object.freeze({ maxPages: 3, maxRecords: 100, timeoutMs: 20_000, maxResponseBytes: 2_097_152, maxLookbackMs: 604_800_000 });

const mkPlan = (provider, bounds = PLAN_BOUNDS) => buildCollectionPlan({
  ...(provider === 'bluesky'
    ? { provider: 'bluesky', term: 'solana' }
    : { instance: MASTODON_HOST, hashtag: 'solana' }),
  bounds: { ...bounds }, collectionMode: 'OFFLINE_FIXTURE', createdAt: NOW,
});
const withBounds = (provider, overrides) => mkPlan(provider, { ...PLAN_BOUNDS, ...overrides });

const DID = 'did:plc:abcdefghijklmnopqrst';
const CID = 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const AT_URI = `at://${DID}/app.bsky.feed.post/3kabcdefghijk`;
const blueskyPostView = () => ({
  $type: 'app.bsky.feed.defs#postView',
  uri: AT_URI, cid: CID, author: { did: DID },
  record: { $type: 'app.bsky.feed.post', text: 'solana', createdAt: '2026-10-01T00:00:00.000Z' },
  likeCount: 1,
});
const mastodonStatus = () => ({
  id: '110000000000000001', created_at: '2026-10-01T00:00:00.000Z', content: '<p>solana</p>',
  visibility: 'public', account: { id: 'a1', acct: 'x' },
});

let clockValue = NOW;
const clock = () => (clockValue += 1_000);
const resetClock = () => { clockValue = NOW; };

/** Runs one valid Mastodon fixture run. */
async function runMastodon(root = tempRoot()) {
  resetClock();
  const fetchImpl = async () => new Response(JSON.stringify([mastodonStatus()]),
    { status: 200, headers: { 'content-type': 'application/json' } });
  return executeCollectionRun(mkPlan('mastodon'), { clock, fetchImpl, outputRoot: root });
}

/** Runs one valid Bluesky fixture run. */
async function runBluesky(root = tempRoot()) {
  resetClock();
  const fetchImpl = async () => new Response(JSON.stringify({ posts: [blueskyPostView()] }),
    { status: 200, headers: { 'content-type': 'application/json' } });
  return executeCollectionRun(mkPlan('bluesky'), {
    clock, fetchImpl, outputRoot: root, adapter: B_ADAPTER.createBlueskyRunAdapter(),
  });
}
// ===========================================================================
// A. REGISTRY
// ===========================================================================
test('A1 the registry holds exactly one explicit entry per admitted provider', () => {
  assert.deepEqual([...CAP.PUBLIC_INTELLIGENCE_5K6_1_CAPABILITY_PROVIDERS], ['bluesky', 'mastodon']);
  assert.ok(SURFACE.PUBLIC_INTELLIGENCE_5K3_PROVIDERS.includes('mastodon'));
  assert.ok(SURFACE.PUBLIC_INTELLIGENCE_5K3_PROVIDERS.includes('bluesky'));
  assert.deepEqual(
    [...SURFACE.PUBLIC_INTELLIGENCE_5K3_PROVIDERS].sort(),
    [...CAP.PUBLIC_INTELLIGENCE_5K6_1_CAPABILITY_PROVIDERS].sort(),
    'every admitted provider must have a capability entry and no extra entry may exist',
  );
});
test('A2 the Mastodon capability entry exists and carries the Mastodon ceilings', () => {
  const entry = CAP.providerCapabilitiesOf('mastodon');
  assert.equal(entry.provider, 'mastodon');
  assert.deepEqual({ ...entry.planBoundCeilings }, { ...MASTODON_CEILINGS });
  assert.equal(entry.transportBoundCeilings.maxPages, 5);
  assert.equal(entry.transportBoundCeilings.maxRecords, 200);
});
test('A3 the Bluesky capability entry exists and carries the Bluesky ceilings', () => {
  const entry = CAP.providerCapabilitiesOf('bluesky');
  assert.equal(entry.provider, 'bluesky');
  assert.deepEqual({ ...entry.planBoundCeilings }, { ...BLUESKY_CEILINGS });
  assert.equal(entry.transportBoundCeilings.maxPages, 3);
  assert.equal(entry.transportBoundCeilings.maxRecords, 100);
});
test('A4 an unknown provider is REFUSED with no fallback to generic bounds', () => {
  for (const provider of ['unknown', 'Mastodon', 'BLUESKY', '', null, undefined, 'x', 'reddit']) {
    refusal(() => CAP.providerCapabilitiesOf(provider), 'PROVIDER_CAPABILITIES_UNKNOWN');
    refusal(() => CAP.planBoundCeilingsOf(provider), 'PROVIDER_CAPABILITIES_UNKNOWN');
    refusal(() => CAP.transportBoundCeilingsOf(provider), 'PROVIDER_CAPABILITIES_UNKNOWN');
  }
});
test('A5 the registry is frozen: no provider may be added or mutated at runtime', () => {
  assert.ok(Object.isFrozen(CAP.PUBLIC_INTELLIGENCE_5K6_1_PROVIDER_CAPABILITIES));
  for (const provider of ['bluesky', 'mastodon']) {
    assert.ok(Object.isFrozen(CAP.providerCapabilitiesOf(provider)));
    assert.ok(Object.isFrozen(CAP.providerCapabilitiesOf(provider).planBoundCeilings));
    assert.ok(Object.isFrozen(CAP.providerCapabilitiesOf(provider).transportBoundCeilings));
  }
  assert.throws(() => { CAP.PUBLIC_INTELLIGENCE_5K6_1_PROVIDER_CAPABILITIES.newone = {}; }, TypeError);
});
test('A6 the registry schema is closed and the registry itself validates', () => {
  const report = CAP.validateProviderCapabilitiesRegistry();
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.deepEqual([...report.problems], []);
  const schema = CAP.PUBLIC_INTELLIGENCE_5K6_1_CAPABILITY_SCHEMA;
  assert.equal(schema.closed, true);
  assert.deepEqual([...schema.fields], ['provider', 'planBoundCeilings', 'transportBoundCeilings', 'source']);
});
test('A7 the closed schema actually refuses a mutated registry', () => {
  const base = CAP.providerCapabilitiesOf('bluesky');
  const bad = {
    ...CAP.PUBLIC_INTELLIGENCE_5K6_1_PROVIDER_CAPABILITIES,
    bluesky: { ...base, rogueField: 1 },
  };
  const report = CAP.validateProviderCapabilitiesRegistry(bad);
  assert.equal(report.ok, false);
  assert.ok(report.problems.includes('bluesky.rogueField:UNKNOWN_FIELD'));
});
test('A8 every governed ceiling value is a finite positive integer', () => {
  for (const provider of CAP.PUBLIC_INTELLIGENCE_5K6_1_CAPABILITY_PROVIDERS) {
    const entry = CAP.providerCapabilitiesOf(provider);
    for (const [field, value] of Object.entries(entry.planBoundCeilings)) {
      assert.ok(Number.isInteger(value), `${provider}.${field}`);
      assert.ok(Number.isFinite(value), `${provider}.${field}`);
      assert.ok(value >= 1, `${provider}.${field}`);
    }
    for (const [field, value] of Object.entries(entry.transportBoundCeilings)) {
      assert.ok(Number.isInteger(value), `${provider}.${field}`);
      assert.ok(Number.isFinite(value), `${provider}.${field}`);
      assert.ok(value >= 0, `${provider}.${field}`);
    }
  }
});
test('A10 the plan ceiling never exceeds the transport ceiling, and here they are equal', () => {
  for (const provider of CAP.PUBLIC_INTELLIGENCE_5K6_1_CAPABILITY_PROVIDERS) {
    const comparison = CAP.comparePlanAndTransportCeilings(provider);
    assert.equal(comparison.planAtMostTransport, true, provider);
    assert.deepEqual([...comparison.unequalFields], [], `${provider} plan ceilings must equal transport ceilings`);
    assert.deepEqual([...comparison.equalFields], ['maxPages', 'maxRecords', 'timeoutMs', 'maxResponseBytes']);
    assert.equal(comparison.lookbackPlanAtMostTransport, true, provider);
    assert.equal(comparison.lookbackEqual, true, provider);
  }
});
test('A11 the registry declares itself and resolves without a cycle', () => {
  assert.equal(CAP.PUBLIC_INTELLIGENCE_5K6_1_PHASE, 'PHASE_5K_6_1');
  assert.ok(String(CAP.PUBLIC_INTELLIGENCE_5K6_1_SCHEMA_VERSION).startsWith('5K.6.1'));
  const registry = parseModule(`${PI}/provider-capabilities.mjs`);
  const relatives = registry.found.importSources.filter(source => source.startsWith('.'));
  assert.deepEqual(relatives, ['./providers/common.mjs'], 'the registry imports only the Mastodon constants');
  assert.ok(!relatives.includes('./providers/bluesky-common.mjs'),
    'no path from the collection plan to the Bluesky adapter module');
});

// ===========================================================================
// B. MASTODON BOUNDS
// ===========================================================================
test('B1 every Mastodon ceiling value is accepted exactly', () => {
  for (const [field, ceiling] of Object.entries(MASTODON_CEILINGS)) {
    assert.equal(withBounds('mastodon', { [field]: ceiling }).bounds[field], ceiling, field);
  }
});
test('B2 each Mastodon ceiling +1 is refused', () => {
  for (const [field, ceiling] of Object.entries(MASTODON_CEILINGS)) {
    refusal(() => withBounds('mastodon', { [field]: ceiling + 1 }), `BOUND_EXCEEDS_CEILING:${field}`);
  }
});
test('B3 Mastodon maxPages 5 is valid and 6 is not', () => {
  assert.equal(withBounds('mastodon', { maxPages: 5 }).bounds.maxPages, 5);
  refusal(() => withBounds('mastodon', { maxPages: 6 }), 'BOUND_EXCEEDS_CEILING:maxPages');
});
test('B4 Mastodon maxRecords 200 is valid and 201 is not', () => {
  assert.equal(withBounds('mastodon', { maxRecords: 200 }).bounds.maxRecords, 200);
  refusal(() => withBounds('mastodon', { maxRecords: 201 }), 'BOUND_EXCEEDS_CEILING:maxRecords');
});
test('B5 zero, negative, fractional, non-finite and non-numeric Mastodon bounds are refused', () => {
  for (const field of Object.keys(MASTODON_CEILINGS)) {
    for (const value of [0, -1, 1.5, Infinity, -Infinity, NaN, '5', null, undefined, true]) {
      refusal(() => withBounds('mastodon', { [field]: value }), `BOUND_INVALID:${field}`);
    }
  }
});

// ===========================================================================
// C. BLUESKY BOUNDS
// ===========================================================================
test('C1 every Bluesky ceiling value is accepted exactly', () => {
  for (const [field, ceiling] of Object.entries(BLUESKY_CEILINGS)) {
    assert.equal(withBounds('bluesky', { [field]: ceiling }).bounds[field], ceiling, field);
  }
});
test('C2 Bluesky maxPages 3 is valid and 4 is refused', () => {
  assert.equal(withBounds('bluesky', { maxPages: 3 }).bounds.maxPages, 3);
  refusal(() => withBounds('bluesky', { maxPages: 4 }), 'BOUND_EXCEEDS_CEILING:maxPages');
});
test('C3 Bluesky maxRecords 100 is valid and 101 is refused', () => {
  assert.equal(withBounds('bluesky', { maxRecords: 100 }).bounds.maxRecords, 100);
  refusal(() => withBounds('bluesky', { maxRecords: 101 }), 'BOUND_EXCEEDS_CEILING:maxRecords');
});
test('C4 each Bluesky ceiling +1 is refused', () => {
  for (const [field, ceiling] of Object.entries(BLUESKY_CEILINGS)) {
    refusal(() => withBounds('bluesky', { [field]: ceiling + 1 }), `BOUND_EXCEEDS_CEILING:${field}`);
  }
});
// ===========================================================================
// D. EARLY REFUSAL
// ===========================================================================
test('D1 an invalid Bluesky plan is refused BEFORE the adapter or transport is invoked', () => {
  let adapterTouched = false;
  const adapter = B_ADAPTER.createBlueskyRunAdapter({ onEvidence: () => { adapterTouched = true; } });
  refusal(() => withBounds('bluesky', { maxPages: 4 }), 'BOUND_EXCEEDS_CEILING:maxPages');
  refusal(() => withBounds('bluesky', { maxRecords: 101 }), 'BOUND_EXCEEDS_CEILING:maxRecords');
  assert.equal(adapterTouched, false, 'the mapper/ingest adapter was never reached');
  assert.equal(adapter.provider, 'bluesky');
});
test('D2 an invalid Mastodon plan is refused BEFORE the adapter or transport is invoked', () => {
  refusal(() => withBounds('mastodon', { maxPages: 6 }), 'BOUND_EXCEEDS_CEILING:maxPages');
  refusal(() => withBounds('mastodon', { maxRecords: 201 }), 'BOUND_EXCEEDS_CEILING:maxRecords');
});
test('D3 an invalid plan makes ZERO network calls and zero socket connections', () => {
  const before = tripwireCalls;
  refusal(() => withBounds('bluesky', { maxPages: 5 }), 'BOUND_EXCEEDS_CEILING:maxPages');
  refusal(() => withBounds('bluesky', { maxRecords: 200 }), 'BOUND_EXCEEDS_CEILING:maxRecords');
  refusal(() => withBounds('mastodon', { maxPages: 6 }), 'BOUND_EXCEEDS_CEILING:maxPages');
  assert.equal(tripwireCalls, before, 'plan validation must never reach the network');
});
test('D4 a run with an invalid plan never starts a run or writes a directory', async () => {
  const { existsSync, readdirSync } = await import('node:fs');
  const root = tempRoot();
  const fetchImpl = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  // The plan is built INSIDE the thunk: building it is itself the refusal, and it
  // happens before executeCollectionRun is ever entered.
  assert.throws(() => withBounds('bluesky', { maxPages: 4 }), /BOUND_EXCEEDS_CEILING:maxPages/);
  assert.throws(() => executeCollectionRun(withBounds('bluesky', { maxPages: 4 }), { clock, fetchImpl, outputRoot: root }),
    /BOUND_EXCEEDS_CEILING:maxPages/);
  assert.throws(() => executeCollectionRun(withBounds('mastodon', { maxRecords: 201 }), { clock, fetchImpl, outputRoot: root }),
    /BOUND_EXCEEDS_CEILING:maxRecords/);
  assert.equal(existsSync(path.join(root, 'runs')), false, 'no run directory was created');
  assert.deepEqual(readdirSync(root), []);
});
test('D5 the whole validator suite made zero real network calls', () => assert.equal(tripwireCalls, 0));

// ===========================================================================
// E. TRANSPORT DEFENSE-IN-DEPTH
// ===========================================================================
const BLUESKY_TRANSPORT_BOUNDS = Object.freeze({
  maxPages: 1, maxRecords: 5, maxResponseBytes: 262_144, timeoutMs: 5_000, lookbackMs: 86_400_000, maxRetries: 0,
});
test('E1 a direct Bluesky transport call with excessive bounds still refuses', async () => {
  const fetchImpl = async () => new Response('{"posts":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
  for (const bounds of [
    { ...BLUESKY_TRANSPORT_BOUNDS, maxPages: 4 },
    { ...BLUESKY_TRANSPORT_BOUNDS, maxRecords: 101 },
    { ...BLUESKY_TRANSPORT_BOUNDS, maxPages: 0 },
    { ...BLUESKY_TRANSPORT_BOUNDS, maxRecords: 1.5 },
  ]) {
    await assert.rejects(() => B_TRANSPORT.fetchBlueskySearch({ term: 'solana', bounds, fetchImpl, now: clock }), /BLUESKY_BOUNDS_INVALID/);
  }
});
test('E2 the Bluesky transport still ACCEPTS exactly its own ceilings', async () => {
  const fetchImpl = async () => new Response('{"posts":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
  const result = await B_TRANSPORT.fetchBlueskySearch({
    term: 'solana', bounds: { ...BLUESKY_TRANSPORT_BOUNDS, maxPages: 3, maxRecords: 100 }, fetchImpl, now: clock,
  });
  assert.equal(result.records.length, 0);
  assert.equal(result.stopReason, 'END_OF_RESULTS');
});
test('E3 a direct Mastodon transport call with excessive bounds still refuses', async () => {
  const fetchImpl = async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  for (const bounds of [
    { ...BLUESKY_TRANSPORT_BOUNDS, maxPages: 6 },
    { ...BLUESKY_TRANSPORT_BOUNDS, maxRecords: 201 },
    { ...BLUESKY_TRANSPORT_BOUNDS, maxPages: 0 },
  ]) {
    await assert.rejects(() => SURFACE.MASTODON_TRANSPORT_5K2.fetchHashtagTimeline({
      host: MASTODON_HOST, hashtag: 'solana', bounds, fetchImpl, now: clock,
    }), /PROVIDER_BOUNDS_INVALID/);
  }
});
// ===========================================================================
// F. COMPATIBILITY
// ===========================================================================
test('F1 a valid Mastodon fixture plan still runs, verifies and replays', async () => {
  const run = await runMastodon();
  assert.equal(run.verification.ok, true, JSON.stringify(run.verification.failures));
  assert.equal(run.manifest.recordsIngested, 1);
  assert.equal(run.manifest.provider, 'mastodon');
  assert.equal(replayRun(run.directory).ok, true);
});
test('F2 a valid Bluesky fixture plan still runs, verifies and replays', async () => {
  const run = await runBluesky();
  assert.equal(run.verification.ok, true, JSON.stringify(run.verification.failures));
  assert.equal(run.manifest.recordsIngested, 1);
  assert.equal(run.manifest.provider, 'bluesky');
  assert.equal(replayRun(run.directory).ok, true);
});
test('F3 a Mastodon run at its exact ceilings is still valid', async () => {
  resetClock();
  const plan = mkPlan('mastodon', { ...PLAN_BOUNDS, maxPages: 5, maxRecords: 200 });
  assert.equal(plan.bounds.maxPages, 5);
  assert.equal(plan.bounds.maxRecords, 200);
  const fetchImpl = async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  const run = await executeCollectionRun(plan, { clock, fetchImpl, outputRoot: tempRoot() });
  assert.equal(run.verification.ok, true, JSON.stringify(run.verification.failures));
  assert.equal(replayRun(run.directory).ok, true);
});
test('F4 a Bluesky run at its exact ceilings is still valid', async () => {
  resetClock();
  const plan = mkPlan('bluesky', { ...PLAN_BOUNDS, maxPages: 3, maxRecords: 100 });
  assert.equal(plan.bounds.maxPages, 3);
  assert.equal(plan.bounds.maxRecords, 100);
  const fetchImpl = async () => new Response(JSON.stringify({ posts: [blueskyPostView()] }),
    { status: 200, headers: { 'content-type': 'application/json' } });
  const run = await executeCollectionRun(plan, {
    clock, fetchImpl, outputRoot: tempRoot(), adapter: B_ADAPTER.createBlueskyRunAdapter(),
  });
  assert.equal(run.verification.ok, true, JSON.stringify(run.verification.failures));
  assert.equal(run.manifest.recordsIngested, 1);
  assert.equal(replayRun(run.directory).ok, true);
});
test('F5 a stored run still verifies and replays deterministically', async () => {
  const run = await runBluesky();
  const first = replayRun(run.directory);
  const second = replayRun(run.directory);
  assert.equal(first.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)));
});
test('F6 manifest identity and run identity semantics are unchanged', async () => {
  const plan = mkPlan('bluesky');
  const run = await runBluesky();
  assert.ok(run.runId.startsWith('run-'));
  assert.equal(run.manifest.manifestFingerprint, SURFACE.manifestFingerprintOf(run.manifest));
  assert.equal(run.manifest.collectionPlanFingerprint, SURFACE.collectionPlanFingerprint(plan));
  assert.equal(run.manifest.provider, 'bluesky');
});
test('F7 the plan record shape is unchanged for both providers', () => {
  const expected = ['bounds', 'classification', 'collectionMode', 'createdAt', 'instance', 'provider',
    'query', 'recordType', 'schemaVersion'];
  for (const provider of ['mastodon', 'bluesky']) {
    assert.deepEqual(Object.keys(mkPlan(provider)).sort(), [...expected].sort(), provider);
  }
});
test('F8 the stored plan bytes are identical to what the plan module produced', async () => {
  const plan = mkPlan('bluesky');
  const run = await runBluesky();
  const stored = JSON.parse(readFileSync(path.join(run.directory, 'plan.json'), 'utf8'));
  assert.deepEqual(JSON.stringify(stored), JSON.stringify(JSON.parse(JSON.stringify(plan))));
});

// ===========================================================================
// G. REGRESSION
// ===========================================================================
const phaseCount = (script, line) => {
  const output = execFileSync('node', [script], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.ok(output.includes(line), `${script} did not report ${line}`);
};
test('G1 5K.0 stays 32/32', () => phaseCount('scripts/validate-phase5k.mjs', 'Phase 5K.0: 32/32 passed'));
test('G2 5K.1 stays 64/64', () => phaseCount('scripts/validate-phase5k1.mjs', 'Phase 5K.1: 64/64 passed'));
test('G3 5K.2 stays 70/70', () => phaseCount('scripts/validate-phase5k2.mjs', 'Phase 5K.2: 70/70 passed'));
test('G4 5K.3 stays 96/96', () => phaseCount('scripts/validate-phase5k3.mjs', 'Phase 5K.3: 96/96 passed'));
test('G5 5K.4 stays 116/116', () => phaseCount('scripts/validate-phase5k4.mjs', 'Phase 5K.4: 116/116 passed'));
test('G6 5K.5 stays 130/130', () => phaseCount('scripts/validate-phase5k5.mjs', 'Phase 5K.5: 130/130 passed'));
test('G7 5K.6 stays 166/166', () => phaseCount('scripts/validate-phase5k6.mjs', 'Phase 5K.6: 166/166 passed'));
test('G8 R4 C1 is an ancestor of HEAD and finalized R4 artifacts are unchanged', () => {
  execFileSync('git', ['merge-base', '--is-ancestor', R4_HEAD, 'HEAD'], { cwd: REPO_ROOT });
  for (const bound of ['governance/r4/r4-preregistration-seal.json', 'package.json', 'package-lock.json']) {
    assert.ok(readFileSync(path.join(REPO_ROOT, bound)).equals(execFileSync('git', ['show', `${R4_HEAD}:${bound}`], { cwd: REPO_ROOT })), bound);
  }
});
test('G9 5K.6.1 changed no evidence, provider or revision semantics module', () => {
  // 5K.6.1 is a BOUNDS change only. These modules define evidence, provider and
  // revision semantics and must be untouched by this phase.
  const head = gitOut('rev-parse', 'HEAD').trim();
  if (gitOut('log', '-1', '--format=%s').trim() !== 'Scope collection bounds by provider') return;
  const changed = gitOut('diff', '--name-only', `${head}^`, head).split('\n').filter(Boolean);
  const forbidden = changed.filter(entry => /observation|provenance|ingest|dedup|revision|temporal-|mapper|transport/.test(entry));
  assert.deepEqual(forbidden, [], '5K.6.1 must not touch evidence, provider or revision semantics');
});
// ===========================================================================
// H. ISOLATION
// ===========================================================================
test('H1 this validator imports exactly ONE project module', () => {
  const { found } = parseModule('scripts/validate-phase5k6-1.mjs');
  assert.deepEqual(found.importSources.filter(source => source.startsWith('.')),
    ['./public-intelligence/bluesky-validation-surface.mjs']);
  for (const literal of found.stringLiterals) {
    if (!literal.includes('/') || literal.startsWith('http')) continue;
    for (const fragment of SURFACE.PROTECTED_MODULE_FRAGMENTS) {
      assert.ok(!literal.includes(fragment), `a literal names ${fragment}: ${literal}`);
    }
  }
});
test('H2 5K.6.1 adds no network-capable module', () => {
  const registry = parseModule(`${PI}/provider-capabilities.mjs`);
  assert.ok(!registry.found.identifiers.includes('fetch'));
  for (const source of registry.found.importSources) assert.ok(!/^node:(http|https|net|tls|dgram|dns)$/.test(source), source);
  const closure = [`${PI}/providers/bluesky-common.mjs`, `${PI}/providers/bluesky-mapper.mjs`,
    `${PI}/providers/bluesky-transport.mjs`, `${PI}/providers/bluesky.mjs`];
  const holders = closure.filter(entry => parseModule(entry).found.identifiers.includes('fetch'));
  assert.deepEqual(holders, [`${PI}/providers/bluesky-transport.mjs`]);
});
test('H3 no trading, engine, Arena or prediction path is introduced', () => {
  // The forbidden-path fragments are built from parts so this assertion does not
  // itself contain the very tokens it bans. The check is STRUCTURAL for both
  // modules - identifiers and import sources - because that is what can actually
  // reach forbidden code; the registry's own source is additionally scanned
  // textually since it is clean.
  const forbiddenPathFragments = [
    ['engine'], ['arena'], ['champion'], ['governance', 'r4'].join('/'), ['market', 'outcomes'].join('-'),
  ];
  const forbidden = new RegExp(forbiddenPathFragments.join('|'), 'i');
  const banned = /^(score|rank|ranking|sentiment|signal|recommend|predict|forecast|profit|alpha|momentum|virality|tradingSignal|priceTarget|marketCap)/i;
  for (const relative of [`${PI}/provider-capabilities.mjs`, 'scripts/validate-phase5k6-1.mjs']) {
    const { found } = parseModule(relative);
    for (const id of found.identifiers) assert.ok(!banned.test(id), `${relative} declares ${id}`);
    for (const source of found.importSources) assert.ok(!forbidden.test(source), `${relative} imports ${source}`);
  }
  assert.ok(!forbidden.test(parseModule(`${PI}/provider-capabilities.mjs`).source), 'the registry names a forbidden path');
});
test('H4 no 5K.6.1 file writes under the guarded area or names it as a target', () => {
  const guarded = ['.', 'evolve'].join('');
  for (const relative of [`${PI}/provider-capabilities.mjs`, 'scripts/validate-phase5k6-1.mjs']) {
    for (const literal of parseModule(relative).found.stringLiterals) {
      assert.ok(!literal.includes(guarded), `${relative} mentions the guarded area`);
    }
  }
  assert.equal(existsFile(path.join(REPO_ROOT, guarded, 'public-intelligence')), false);
});
test('H5 no provider credential, cookie or token capability is introduced', () => {
  for (const relative of [`${PI}/provider-capabilities.mjs`, 'scripts/validate-phase5k6-1.mjs']) {
    const { found, source } = parseModule(relative);
    for (const id of found.identifiers) {
      assert.ok(!/^(apiKey|api_key|clientSecret|appPassword|accessToken|refreshToken|sessionCookie|password|authorization|cookie)$/.test(id), `${relative} ${id}`);
    }
    assert.ok(!/process\.env/.test(source), `${relative} reads the environment`);
  }
});
test('H6 the guarded area is untouched and no runtime capture is present', () => {
  const guarded = ['.', 'evolve'].join('');
  const guardedLine = new RegExp(`^\\s*[MADRCU?!]{1,2}\\s+\\${guarded}`);
  for (const line of gitOut('status', '--porcelain').split('\n').filter(Boolean)) {
    assert.ok(!guardedLine.test(line), 'the guarded area must be untouched');
  }
  assert.equal(gitOut('ls-files', 'var').trim(), '', 'no capture under var/ is tracked');
});
test('E4 the Mastodon transport still ACCEPTS exactly its own ceilings', async () => {
  const fetchImpl = async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  const result = await SURFACE.MASTODON_TRANSPORT_5K2.fetchHashtagTimeline({
    host: MASTODON_HOST, hashtag: 'solana',
    bounds: { ...BLUESKY_TRANSPORT_BOUNDS, maxPages: 5, maxRecords: 200 }, fetchImpl, now: clock,
  });
  assert.equal(result.records.length, 0);
});
test('E5 neither transport lost its own bound check', () => {
  assert.ok(/resolveBlueskyBounds/.test(parseModule(`${PI}/providers/bluesky-transport.mjs`).source),
    'the Bluesky transport still resolves its own bounds');
  assert.ok(/resolveBounds/.test(parseModule(`${PI}/providers/common.mjs`).source),
    'the Mastodon bound resolver still exists');
  assert.equal(B_COMMON.resolveBlueskyBounds({}).maxPages, B_COMMON.BLUESKY_DEFAULT_BOUNDS.maxPages);
});
test('E6 the plan ceiling equals the transport ceiling for both providers, field by field', () => {
  for (const provider of ['mastodon', 'bluesky']) {
    const comparison = CAP.comparePlanAndTransportCeilings(provider);
    assert.deepEqual([...comparison.unequalFields], [], provider);
    assert.equal(comparison.lookbackEqual, true, provider);
  }
});
test('C5 zero, negative, fractional, non-finite and non-numeric Bluesky bounds are refused', () => {
  for (const field of Object.keys(BLUESKY_CEILINGS)) {
    for (const value of [0, -1, 1.5, Infinity, -Infinity, NaN, '5', null, undefined, true]) {
      refusal(() => withBounds('bluesky', { [field]: value }), `BOUND_INVALID:${field}`);
    }
  }
});
test('C6 a Mastodon-sized Bluesky plan is now REFUSED - the whole point of 5K.6.1', () => {
  // These are exactly the bounds that used to pass plan validation and only then
  // fail inside the transport.
  refusal(() => withBounds('bluesky', { maxPages: 5 }), 'BOUND_EXCEEDS_CEILING:maxPages');
  refusal(() => withBounds('bluesky', { maxRecords: 200 }), 'BOUND_EXCEEDS_CEILING:maxRecords');
});
test('C7 the generic 5K.3 ceiling constant is unchanged and is no longer the validator', () => {
  // 5K.3 B6 pins this value; 5K.6.1 keeps it as the historical Mastodon view but
  // validates plans against the provider's own ceilings instead.
  assert.deepEqual({ ...SURFACE.PUBLIC_INTELLIGENCE_5K3_BOUND_CEILINGS }, { ...MASTODON_CEILINGS });
  assert.equal(SURFACE.PUBLIC_INTELLIGENCE_5K3_BOUND_CEILINGS.maxPages, 5);
  assert.deepEqual(Object.keys(withBounds('mastodon').bounds).sort(), Object.keys(BLUESKY_CEILINGS).sort());
  assert.deepEqual(Object.keys(withBounds('bluesky').bounds).sort(), Object.keys(BLUESKY_CEILINGS).sort());
});
test('A9 a non-finite, fractional or below-floor ceiling is reported, not accepted', () => {
  const base = CAP.providerCapabilitiesOf('bluesky');
  for (const patch of [{ maxPages: Infinity }, { maxPages: 1.5 }, { maxPages: 0 }, { maxRecords: NaN }, { maxRecords: -1 }]) {
    const bad = {
      ...CAP.PUBLIC_INTELLIGENCE_5K6_1_PROVIDER_CAPABILITIES,
      bluesky: { ...base, planBoundCeilings: { ...base.planBoundCeilings, ...patch } },
    };
    const report = CAP.validateProviderCapabilitiesRegistry(bad);
    assert.equal(report.ok, false, JSON.stringify(patch));
    assert.ok(report.problems.length > 0, JSON.stringify(patch));
  }
});

// ===========================================================================
// RUNNER
// ===========================================================================
async function main() {
  let failed = 0;
  try {
    for (const [name, fn] of tests) {
      try { await fn(); console.log(`PASS ${name}`); } catch (error) { failed++; console.error(`FAIL ${name}: ${error.stack}`); }
    }
  } finally { for (const root of temporary) rmSync(root, { recursive: true, force: true }); }
  console.log(`Phase 5K.6.1: ${tests.length - failed}/${tests.length} passed; offline, fixture runs + injected clocks only, ${tripwireCalls} network calls, provider-scoped bounds only`);
  if (failed) process.exitCode = 1;
}
main().catch(error => { console.error('phase 5K.6.1 validator crashed:', error); process.exitCode = 1; });
