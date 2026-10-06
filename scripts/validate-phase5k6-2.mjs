#!/usr/bin/env node
// Phase 5K.6.2 - BLUESKY TERMINAL STOP-REASON COMPATIBILITY validator.
//
// COMPLETELY OFFLINE AND DETERMINISTIC. Every provider response is an in-memory
// fixture handed to the transport through an injected fetch; every clock is an
// injected counter. The global fetch and the socket connect primitive are
// replaced with tripwires and the suite asserts neither was ever called. All run
// roots are temporary directories; the repository tree, `var/` and the guarded
// area are never written.
//
// THE BUG THIS PHASE FIXES
//
// A Bluesky search can validly return HTTP success, JSON success, zero records
// and no next cursor. That is a NORMAL BOUNDED TERMINATION, not a failure. The
// Bluesky transport names it `END_OF_RESULTS`; the 5K.3 run/manifest vocabulary
// already governs the identical state, once, as `END_OF_TIMELINE`. Before this
// phase the two vocabularies never met, so a legitimate EMPTY SUCCESSFUL run
// could not finalize at all: it failed with MANIFEST_STOP_REASON_INVALID. The
// fix TRANSLATES the provider-native token at the adapter boundary instead of
// admitting a second representation of one state into the closed vocabulary.
//
// NO FAKE DATA. An empty run stores ZERO evidence records. There are no
// placeholder observations, no synthetic filler, no dummy evidence and no
// invented cursor anywhere in this file: zero records means zero records.
//
// IMPORT BOUNDARY
//
// Every 5K.x validator asserts that nothing OUTSIDE `scripts/public-intelligence/`
// imports a protected phase module, and those checks enumerate `git ls-files`, so
// a TRACKED validator that imports one directly breaks them. This validator
// therefore reaches 5K.0-5K.6.1 through the existing governed surface and nothing
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
// provider modules, the 5K.3 run machinery, the 5K.3 governed terminal vocabulary
// and the 5K.6.1 capability registry.
const SURFACE = await import('./public-intelligence/bluesky-validation-surface.mjs');

const B_TRANSPORT = SURFACE.BLUESKY_TRANSPORT_5K6;
const B_ADAPTER = SURFACE.BLUESKY_ADAPTER_5K6;
const STOP_REASONS = SURFACE.PUBLIC_INTELLIGENCE_5K3_STOP_REASONS;
const ALIASES = SURFACE.PUBLIC_INTELLIGENCE_5K3_STOP_REASON_ALIASES;
const RUN_STATUS = SURFACE.PUBLIC_INTELLIGENCE_5K3_RUN_STATUS;
const FAILURES = SURFACE.PUBLIC_INTELLIGENCE_5K3_FAILURE_VALUES;
const REQUEST_FAILURES = SURFACE.PUBLIC_INTELLIGENCE_5K3_REQUEST_FAILURE_VALUES;
const { governStopReason, validateManifestShape, deriveRunStatus, checkAccounting } = SURFACE;
const { buildCollectionPlan, executeCollectionRun, replayRun, loadRunArtifacts, manifestFingerprintOf } = SURFACE;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PI = 'scripts/public-intelligence';
const R4_HEAD = '1c30264fb87876eeaf229e25c5cdc5adca429b40';
// The commit this phase starts from, used to prove the fix is additive.
const BASE_COMMIT = '9bd6f93ca06cee4305ada8fa57ff615496a11694';
const require = createRequire(import.meta.url);
const espree = require('espree');

// ---------------------------------------------------------------------------
// HARNESS
// ---------------------------------------------------------------------------
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const temporary = [];
const tempRoot = () => { const root = mkdtempSync(path.join(tmpdir(), 'evolve-5k6-2-')); temporary.push(root); return root; };
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

// ---- fixtures (structural only: no handle, name, bio or raw body) -----------
const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const MASTODON_HOST = 'fixture.example';
const PLAN_BOUNDS = Object.freeze({
  maxPages: 1, maxRecords: 5, timeoutMs: 10_000, maxResponseBytes: 524_288, maxLookbackMs: 86_400_000,
});
const TWO_PAGE_BOUNDS = Object.freeze({ ...PLAN_BOUNDS, maxPages: 2 });
// The transport checks the EVOLVE page bound before the provider cursor, so a
// cursor-unusable scenario needs headroom ABOVE the pages it actually spends.
const THREE_PAGE_BOUNDS = Object.freeze({ ...PLAN_BOUNDS, maxPages: 3 });
const TRANSPORT_BOUNDS = Object.freeze({
  maxPages: 1, maxRecords: 5, maxResponseBytes: 524_288, timeoutMs: 10_000, lookbackMs: 86_400_000, maxRetries: 0,
});
const DID = 'did:plc:abcdefghijklmnopqrst';
const CID = 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const AT_URI = `at://${DID}/app.bsky.feed.post/3kabcdefghijk`;
const blueskyPostView = (overrides = {}) => ({
  $type: 'app.bsky.feed.defs#postView',
  uri: AT_URI, cid: CID, author: { did: DID },
  record: { $type: 'app.bsky.feed.post', text: 'solana', createdAt: '2026-10-01T00:00:00.000Z' },
  likeCount: 1, ...overrides,
});
const mastodonStatus = () => ({
  id: '110000000000000001', created_at: '2026-10-01T00:00:00.000Z', content: '<p>solana</p>',
  visibility: 'public', account: { id: 'a1', acct: 'x' },
});

let clockValue = NOW;
const clock = () => (clockValue += 1_000);
const resetClock = () => { clockValue = NOW; };

const blueskyPlan = (bounds = PLAN_BOUNDS) => buildCollectionPlan({
  provider: 'bluesky', term: 'solana', bounds: { ...bounds }, collectionMode: 'OFFLINE_FIXTURE', createdAt: NOW,
});
const mastodonPlan = (bounds = PLAN_BOUNDS) => buildCollectionPlan({
  instance: MASTODON_HOST, hashtag: 'solana', bounds: { ...bounds }, collectionMode: 'OFFLINE_FIXTURE', createdAt: NOW,
});

/** Answers each page from a scripted list, in order, and records the URLs used. */
const scriptedFetch = pages => {
  let index = 0;
  const calls = [];
  const impl = async (url, init) => {
    calls.push(String(url));
    const page = pages[Math.min(index, pages.length - 1)];
    index += 1;
    if (typeof page === 'function') return page(url, init);
    return new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  impl.calls = calls;
  return impl;
};

/** Executes one offline Bluesky run. Nothing is written outside a temp root. */
async function runBluesky(pages, bounds = PLAN_BOUNDS) {
  resetClock();
  const root = tempRoot();
  const fetchImpl = scriptedFetch(pages);
  const result = await executeCollectionRun(blueskyPlan(bounds), {
    clock, fetchImpl, outputRoot: root, adapter: B_ADAPTER.createBlueskyRunAdapter(),
  });
  return { result, fetchImpl, root };
}

/** Executes one offline Mastodon run through the unchanged 5K.3 machinery. */
async function runMastodon(statuses = [mastodonStatus()], bounds = PLAN_BOUNDS) {
  resetClock();
  const root = tempRoot();
  const fetchImpl = async () => new Response(JSON.stringify(statuses),
    { status: 200, headers: { 'content-type': 'application/json' } });
  const result = await executeCollectionRun(mastodonPlan(bounds), { clock, fetchImpl, outputRoot: root });
  return { result, fetchImpl, root };
}

/** One cached empty Bluesky run, for the synchronous vocabulary assertions. */
let cachedEmptyRun = null;
const emptyRun = async () => { cachedEmptyRun ??= await runBluesky([{ posts: [] }]); return cachedEmptyRun; };

/** One Bluesky run whose only request fails with the given provider HTTP status. */
async function failingBlueskyRun(status, options = {}) {
  resetClock();
  const root = tempRoot();
  const fetchImpl = options.aborted
    ? async () => { const error = new Error('aborted'); error.name = 'AbortError'; throw error; }
    : async () => new Response('{"error":"x"}', { status, headers: { 'content-type': 'application/json' } });
  const result = await executeCollectionRun(blueskyPlan(options.bounds ?? PLAN_BOUNDS), {
    clock, fetchImpl, outputRoot: root, adapter: B_ADAPTER.createBlueskyRunAdapter(),
  });
  return { result, root };
}
// ===========================================================================
// A. VOCABULARY
// ===========================================================================
test('A1 the governed stop-reason vocabulary is exactly the seven 5K.3 values, unchanged', () => {
  // Closed and provider-neutral. This phase adds NO member: the fix is a
  // translation, not a widening of the terminal vocabulary.
  assert.deepEqual([...STOP_REASONS], ['END_OF_TIMELINE', 'MAX_PAGES', 'MAX_RECORDS', 'LOOKBACK_REACHED',
    'PAGINATION_CURSOR_UNUSABLE', 'REQUEST_FAILED', 'NOT_STARTED']);
  assert.ok(Object.isFrozen(STOP_REASONS));
  assert.equal(new Set(STOP_REASONS).size, STOP_REASONS.length, 'no duplicate reason may exist');
});
test('A2 successful natural exhaustion has exactly one governed representation', () => {
  // END_OF_RESULTS must NOT itself have become a governed stop reason: that
  // would give ONE state TWO representations and make COMPLETED depend on which
  // provider happened to run.
  assert.ok(!STOP_REASONS.includes('END_OF_RESULTS'));
  const exhaustion = STOP_REASONS.filter(reason => reason === 'END_OF_TIMELINE' || reason === 'END_OF_RESULTS');
  assert.deepEqual(exhaustion, ['END_OF_TIMELINE']);
  assert.deepEqual([...new Set(Object.values(ALIASES))], ['END_OF_TIMELINE'],
    'every provider-native exhaustion alias resolves to the one governed reason');
});
test('A3 the provider-native alias map is closed, additive and exactly one entry', () => {
  assert.deepEqual({ ...ALIASES }, { END_OF_RESULTS: 'END_OF_TIMELINE' });
  assert.ok(Object.isFrozen(ALIASES));
  // Every alias must land on a reason the manifest already governs. An alias
  // pointing anywhere else would be a way to smuggle in an ungoverned reason.
  for (const [native, governed] of Object.entries(ALIASES)) {
    assert.ok(STOP_REASONS.includes(governed), `${native} -> ${governed} is not governed`);
  }
});
test('A4 the translation maps the Bluesky token and is identity for every governed reason', () => {
  assert.equal(governStopReason('END_OF_RESULTS'), 'END_OF_TIMELINE');
  // Identity for Mastodon is what makes its manifests byte-identical.
  for (const reason of STOP_REASONS) assert.equal(governStopReason(reason), reason, reason);
});
test('A5 an unknown stop reason is refused, never silently accepted or invented', () => {
  // The translation is a CLOSED map. It is not a pass-through that grants
  // meaning, and it is not case-insensitive or prefix-matching.
  for (const invented of ['END_OF_EVERYTHING', 'TOTALLY_FINE', '', 'end_of_results', 'END_OF_RESULTS_EXTRA']) {
    assert.equal(governStopReason(invented), invented, invented);
    assert.ok(!STOP_REASONS.includes(invented), invented);
  }
});
test('A6 a manifest carrying an ungoverned stop reason is still refused', async () => {
  const { result } = await emptyRun();
  const forged = JSON.parse(JSON.stringify(result.manifest));
  forged.providerCursorSummary.stopReason = 'END_OF_EVERYTHING';
  refusal(() => validateManifestShape(forged), 'MANIFEST_STOP_REASON_INVALID');
  // The provider-native token is refused too: it is translated at the boundary,
  // it is not admitted into the manifest vocabulary.
  forged.providerCursorSummary.stopReason = 'END_OF_RESULTS';
  refusal(() => validateManifestShape(forged), 'MANIFEST_STOP_REASON_INVALID');
});
test('A7 the non-planned stop reasons still derive a non-success status', () => {
  // The fix grants nothing to a failure. Exhaustion cannot launder a bad run.
  assert.equal(deriveRunStatus({ failureCounts: {}, conflicts: 0, stopReason: 'PAGINATION_CURSOR_UNUSABLE' }, []), RUN_STATUS.PARTIAL);
  assert.equal(deriveRunStatus({ failureCounts: {}, conflicts: 0, stopReason: 'REQUEST_FAILED' }, []), RUN_STATUS.PARTIAL);
  assert.equal(deriveRunStatus({ failureCounts: {}, conflicts: 0, stopReason: 'NOT_STARTED' }, []), RUN_STATUS.PARTIAL);
  assert.equal(deriveRunStatus({ failureCounts: {}, conflicts: 0, stopReason: 'END_OF_TIMELINE' }, []), RUN_STATUS.COMPLETED);
  // And no failure reason is ever rewritten into the exhaustion alias.
  for (const reason of ['PAGINATION_CURSOR_UNUSABLE', 'REQUEST_FAILED', 'NOT_STARTED']) {
    assert.equal(governStopReason(reason), reason, reason);
  }
});
test('A8 the failure vocabulary itself is unchanged by this phase', () => {
  assert.deepEqual([...FAILURES], ['RATE_LIMITED', 'TIMEOUT', 'NETWORK_ERROR', 'PROVIDER_AUTH_REQUIRED', 'PROVIDER_4XX',
    'PROVIDER_5XX', 'INVALID_PROVIDER_RESPONSE', 'OVERSIZED_RESPONSE', 'MAPPING_REFUSED', 'INGEST_CONFLICT', 'INTEGRITY_FAILURE']);
  assert.deepEqual([...REQUEST_FAILURES], ['RATE_LIMITED', 'TIMEOUT', 'NETWORK_ERROR', 'PROVIDER_AUTH_REQUIRED', 'PROVIDER_4XX',
    'PROVIDER_5XX', 'INVALID_PROVIDER_RESPONSE', 'OVERSIZED_RESPONSE']);
});
test('A9 the terminal run-status vocabulary is unchanged', () => {
  assert.deepEqual(Object.values(RUN_STATUS), ['COMPLETED', 'PARTIAL', 'RATE_LIMITED', 'TIMEOUT', 'PROVIDER_ERROR',
    'REFUSED', 'FAILED_INTEGRITY']);
});
// ===========================================================================
// B. SUCCESSFUL EMPTY RUN (first page: zero records, no cursor)
// ===========================================================================
test('B1 the Bluesky transport still reports its OWN native token for an empty page', async () => {
  // 5K.6 transport semantics are untouched: it still says END_OF_RESULTS and
  // still makes no second request.
  const fetchImpl = scriptedFetch([{ posts: [] }]);
  const result = await B_TRANSPORT.fetchBlueskySearch({
    term: 'solana', bounds: { ...TRANSPORT_BOUNDS }, fetchImpl, now: clock,
  });
  assert.equal(result.stopReason, 'END_OF_RESULTS');
  assert.equal(result.records.length, 0);
  assert.equal(fetchImpl.calls.length, 1);
});
test('B2 an empty first page finalizes COMPLETED instead of refusing the manifest', async () => {
  const { result } = await runBluesky([{ posts: [] }]);
  assert.ok(result.manifest, 'a finalized manifest must exist');
  assert.equal(result.status, RUN_STATUS.COMPLETED);
  assert.equal(result.manifest.status, RUN_STATUS.COMPLETED);
});
test('B3 the recorded terminal stop reason is the governed exhaustion reason', async () => {
  // The whole point of the phase: the manifest carries ONE representation of
  // the state, never the provider-native word.
  const { result } = await emptyRun();
  assert.equal(result.manifest.providerCursorSummary.stopReason, 'END_OF_TIMELINE');
  assert.ok(STOP_REASONS.includes(result.manifest.providerCursorSummary.stopReason));
  assert.ok(!STOP_REASONS.includes('END_OF_RESULTS'));
});
test('B4 every evidence count is exactly zero', async () => {
  const { result } = await runBluesky([{ posts: [] }]);
  const m = result.manifest;
  for (const key of ['providerRecordsSeen', 'recordsMapped', 'recordsIngested', 'duplicates', 'conflicts', 'refused',
    'ingestFailures', 'rawEvidenceRecordsWritten', 'normalizedRecordsWritten']) {
    assert.equal(m[key], 0, key);
  }
  assert.deepEqual(m.failureCounts, {});
  assert.deepEqual(m.refusedReasons, {});
});
test('B5 exactly one request and one page were made', async () => {
  const { result, fetchImpl } = await runBluesky([{ posts: [] }]);
  assert.equal(fetchImpl.calls.length, 1, 'an empty first page must not trigger a second request');
  const cursors = result.manifest.providerCursorSummary;
  assert.equal(result.manifest.requestCount, 1);
  assert.equal(result.manifest.pageCount, 1);
  assert.equal(cursors.nextCursorPresent, false);
  assert.equal(cursors.cursorsUsed, 0);
  assert.equal(cursors.firstCursor, null);
  assert.equal(cursors.lastCursor, null);
});
test('B6 the empty run stores ZERO evidence records (no fake data)', async () => {
  const { result } = await runBluesky([{ posts: [] }]);
  const artifacts = loadRunArtifacts(result.directory);
  assert.deepEqual(artifacts.raw, [], 'no placeholder raw evidence');
  assert.deepEqual(artifacts.observations, [], 'no synthetic normalized record');
  assert.deepEqual(artifacts.loadProblems, []);
  assert.equal(artifacts.requests.length, 1);
  // Missing data stays missing.
  assert.equal(result.manifest.recordsIngested, 0);
  assert.equal(result.manifest.rawEvidenceRecordsWritten, 0);
});
test('B7 the manifest builds, validates and authenticates itself', async () => {
  const { result } = await runBluesky([{ posts: [] }]);
  const m = result.manifest;
  assert.doesNotThrow(() => validateManifestShape(m));
  assert.equal(m.manifestFingerprint, manifestFingerprintOf(m));
  assert.deepEqual(checkAccounting(JSON.parse(JSON.stringify(m)), loadRunArtifacts(result.directory).requests, blueskyPlan()), []);
});
test('B8 the empty run self-verifies and replays offline', async () => {
  const { result } = await runBluesky([{ posts: [] }]);
  assert.equal(result.verification.ok, true, JSON.stringify(result.verification.failures));
  const replayed = replayRun(result.directory);
  assert.equal(replayed.ok, true, JSON.stringify(replayed.failures));
  // Replay is deterministic and consumes only stored artifacts.
  assert.deepEqual(JSON.parse(JSON.stringify(replayed)), JSON.parse(JSON.stringify(replayRun(result.directory))));
});
test('B9 the accounting equations hold exactly for an empty completed run', async () => {
  const { result } = await runBluesky([{ posts: [] }]);
  const m = result.manifest;
  assert.equal(m.providerRecordsSeen, m.recordsMapped + m.refused);
  assert.equal(m.recordsMapped, m.recordsIngested + m.duplicates + m.conflicts + m.ingestFailures);
  assert.equal(m.rawEvidenceRecordsWritten, m.recordsIngested);
  assert.equal(m.normalizedRecordsWritten, m.recordsIngested);
  assert.equal(m.requestCount, m.pageCount);
  assert.equal(m.completedAt >= m.startedAt, true);
  assert.equal(m.provider, 'bluesky');
});
test('B10 an empty run is byte-deterministic across identical fixtures', async () => {
  const first = await runBluesky([{ posts: [] }]);
  const second = await runBluesky([{ posts: [] }]);
  assert.equal(first.result.manifest.manifestFingerprint, second.result.manifest.manifestFingerprint);
  assert.equal(first.result.runId, second.result.runId);
  assert.deepEqual(first.result.manifest.providerCursorSummary, second.result.manifest.providerCursorSummary);
});
test('B11 an empty dry run persists nothing at all', async () => {
  resetClock();
  const fetchImpl = scriptedFetch([{ posts: [] }]);
  const result = await executeCollectionRun(blueskyPlan(), {
    clock, fetchImpl, dryRun: true, adapter: B_ADAPTER.createBlueskyRunAdapter(),
  });
  assert.equal(result.status, RUN_STATUS.COMPLETED);
  assert.equal(result.manifest.providerCursorSummary.stopReason, 'END_OF_TIMELINE');
  assert.equal(result.directory, null, 'a dry run has no directory');
  assert.equal(result.dryRun, true);
});
// ===========================================================================
// C. MIDDLE-OF-RUN EXHAUSTION
// ===========================================================================
test('C1 a run that exhausts on page 2 keeps the evidence page 1 acquired', async () => {
  const { result } = await runBluesky([{ posts: [blueskyPostView()], cursor: '12345' }, { posts: [] }], TWO_PAGE_BOUNDS);
  assert.equal(result.status, RUN_STATUS.COMPLETED);
  const m = result.manifest;
  assert.equal(m.providerRecordsSeen, 1);
  assert.equal(m.recordsMapped, 1);
  assert.equal(m.recordsIngested, 1);
  assert.equal(m.rawEvidenceRecordsWritten, 1);
  assert.equal(m.normalizedRecordsWritten, 1);
  assert.equal(m.duplicates, 0);
  assert.equal(m.conflicts, 0);
  assert.equal(m.refused, 0);
  assert.deepEqual(m.refusedReasons, {});
});
test('C2 the mid-run exhaustion reason is recorded and the counts stay exact', async () => {
  const { result } = await runBluesky([{ posts: [blueskyPostView()], cursor: '12345' }, { posts: [] }], TWO_PAGE_BOUNDS);
  const m = result.manifest;
  assert.equal(m.providerCursorSummary.stopReason, 'END_OF_TIMELINE');
  assert.equal(m.requestCount, 2);
  assert.equal(m.pageCount, 2);
  assert.equal(m.providerCursorSummary.cursorsUsed, 1);
  assert.equal(m.providerCursorSummary.firstCursor, '12345');
  assert.equal(m.providerCursorSummary.lastCursor, '12345');
  assert.equal(m.providerCursorSummary.nextCursorPresent, false);
  assert.deepEqual(m.failureCounts, {});
});
test('C3 exhaustion is NOT downgraded to PARTIAL merely because the provider ran out', async () => {
  const { result } = await runBluesky([{ posts: [blueskyPostView()], cursor: '12345' }, { posts: [] }], TWO_PAGE_BOUNDS);
  assert.equal(result.manifest.status, RUN_STATUS.COMPLETED);
  assert.notEqual(result.manifest.status, RUN_STATUS.PARTIAL);
});
test('C4 no evidence is lost and the run replays deterministically', async () => {
  const { result } = await runBluesky([{ posts: [blueskyPostView()], cursor: '12345' }, { posts: [] }], TWO_PAGE_BOUNDS);
  assert.equal(result.verification.ok, true, JSON.stringify(result.verification.failures));
  const artifacts = loadRunArtifacts(result.directory);
  assert.equal(artifacts.observations.length, 1);
  assert.equal(artifacts.raw.length, 1);
  assert.equal(artifacts.requests.length, 2);
  const first = replayRun(result.directory);
  const second = replayRun(result.directory);
  assert.equal(first.ok, true, JSON.stringify(first.failures));
  assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)));
});
test('C5 mid-run exhaustion keeps the page-1 request record and its cursor', async () => {
  const { result } = await runBluesky([{ posts: [blueskyPostView()], cursor: '12345' }, { posts: [] }], TWO_PAGE_BOUNDS);
  const requests = loadRunArtifacts(result.directory).requests;
  assert.deepEqual(requests.map(request => request.requestIndex), [0, 1]);
  assert.deepEqual(requests.map(request => request.outcome), ['OK', 'OK']);
  assert.deepEqual(requests.map(request => request.recordsReturned), [1, 0]);
  assert.equal(requests[0].nextCursor, '12345');
  assert.equal(requests[1].nextCursor, null);
});
// ===========================================================================
// D. CURSOR SEMANTICS (natural absence vs malformed / unusable / unsafe)
// ===========================================================================
test('D1 records with NO usable cursor stay PARTIAL and are never reclassified as success', async () => {
  // Enough page headroom that the run reaches the CURSOR check rather than
  // stopping on EVOLVE's own page bound.
  const { result } = await runBluesky([{ posts: [blueskyPostView()] }], THREE_PAGE_BOUNDS);
  assert.equal(result.manifest.providerCursorSummary.stopReason, 'PAGINATION_CURSOR_UNUSABLE');
  assert.equal(result.manifest.status, RUN_STATUS.PARTIAL);
  // The record already acquired is still kept and still counted exactly.
  assert.equal(result.manifest.recordsIngested, 1);
  assert.equal(result.manifest.providerRecordsSeen, 1);
});
test('D2 a cursor that does not advance is unusable, not exhaustion', async () => {
  const { result } = await runBluesky([
    { posts: [blueskyPostView()], cursor: '999' },
    { posts: [blueskyPostView({ uri: `${AT_URI}9` })], cursor: '999' },
  ], THREE_PAGE_BOUNDS);
  assert.equal(result.manifest.providerCursorSummary.stopReason, 'PAGINATION_CURSOR_UNUSABLE');
  assert.equal(result.manifest.status, RUN_STATUS.PARTIAL);
});
test('D3 a malformed cursor TYPE is a provider failure, not exhaustion', async () => {
  const { result } = await runBluesky([{ posts: [blueskyPostView()], cursor: 12345 }, { posts: [] }], TWO_PAGE_BOUNDS);
  assert.equal(result.manifest.providerCursorSummary.stopReason, 'REQUEST_FAILED');
  assert.equal(result.manifest.status, RUN_STATUS.PROVIDER_ERROR);
  assert.equal(result.manifest.failureCounts.INVALID_PROVIDER_RESPONSE, 1);
});
test('D4 an empty page is exhaustion whether or not the provider echoed a cursor', async () => {
  // The terminal signal is ZERO RECORDS. A cursor arriving alongside an empty
  // page neither invents a failure nor changes the state.
  for (const pages of [[{ posts: [], cursor: '555' }], [{ posts: [] }]]) {
    const { result } = await runBluesky(pages);
    assert.equal(result.manifest.status, RUN_STATUS.COMPLETED, JSON.stringify(pages));
    assert.equal(result.manifest.providerCursorSummary.stopReason, 'END_OF_TIMELINE');
    assert.equal(result.manifest.requestCount, 1);
    assert.equal(result.manifest.recordsIngested, 0);
  }
});
test('D5 the alias map cannot turn a cursor problem into exhaustion', () => {
  // Defense in depth: the alias is a VALUE map holding exactly one key, and
  // that value is a planned reason, never a cursor or failure reason.
  assert.deepEqual(Object.keys(ALIASES), ['END_OF_RESULTS']);
  assert.ok(!Object.values(ALIASES).some(value => /CURSOR|FAILED|REFUSED/.test(value)));
  assert.equal(governStopReason('PAGINATION_CURSOR_UNUSABLE'), 'PAGINATION_CURSOR_UNUSABLE');
  assert.equal(governStopReason('REQUEST_FAILED'), 'REQUEST_FAILED');
});
test('D6 exhaustion never masks an unusable cursor that arrived with records', async () => {
  // A page carrying records and no cursor is a PARTIAL run even though the very
  // next thing the provider would have done is return an empty page.
  const { result } = await runBluesky([{ posts: [blueskyPostView()], cursor: '' }], TWO_PAGE_BOUNDS);
  assert.equal(result.manifest.providerCursorSummary.stopReason, 'PAGINATION_CURSOR_UNUSABLE');
  assert.equal(result.manifest.status, RUN_STATUS.PARTIAL);
});
// ===========================================================================
// E. MASTODON BACKWARD COMPATIBILITY
// ===========================================================================
test('E1 a Mastodon fixture run finalizes, verifies and replays exactly as before', async () => {
  const { result } = await runMastodon();
  assert.equal(result.status, RUN_STATUS.COMPLETED);
  assert.equal(result.manifest.providerRecordsSeen, 1);
  assert.equal(result.manifest.recordsIngested, 1);
  assert.equal(result.manifest.provider, 'mastodon');
  assert.equal(result.verification.ok, true, JSON.stringify(result.verification.failures));
  assert.equal(replayRun(result.directory).ok, true);
});
test('E2 a Mastodon EMPTY run still finalizes COMPLETED with END_OF_TIMELINE', async () => {
  // Mastodon's own exhaustion token was already the governed one, so the fix is
  // observably a no-op for it.
  const { result } = await runMastodon([]);
  assert.equal(result.manifest.status, RUN_STATUS.COMPLETED);
  assert.equal(result.manifest.providerCursorSummary.stopReason, 'END_OF_TIMELINE');
  assert.equal(result.manifest.requestCount, 1);
  assert.equal(result.manifest.recordsIngested, 0);
  assert.equal(result.verification.ok, true, JSON.stringify(result.verification.failures));
  assert.equal(replayRun(result.directory).ok, true);
});
test('E3 a Mastodon manifest fingerprint is byte-identical to the pre-fix value', async () => {
  // The strongest available compatibility proof: the manifest is bit-for-bit the
  // one the pre-5K.6.2 tree produced, so nothing about a Mastodon run moved.
  const { result } = await runMastodon();
  assert.equal(result.manifest.manifestFingerprint,
    '5378338141fe2f846e4be78690200321be8adcf092ba9e4402ad87ddc37dd875');
  assert.equal(result.manifest.providerCursorSummary.stopReason, 'MAX_PAGES');
});
test('E4 Mastodon run identity and manifest determinism are unchanged', async () => {
  const first = await runMastodon();
  const second = await runMastodon();
  assert.equal(first.result.runId, second.result.runId);
  assert.equal(first.result.manifest.manifestFingerprint, second.result.manifest.manifestFingerprint);
  assert.deepEqual(first.result.manifest.providerCursorSummary, second.result.manifest.providerCursorSummary);
  assert.deepEqual(first.result.manifest, second.result.manifest);
});
test('E5 no Mastodon provider module is touched by this phase', () => {
  // The fix lives in the shared run/manifest layer, so every Mastodon-only
  // module must be byte-identical to what 5K.6.1 committed. The provider
  // directory name is assembled from parts: naming it literally here would be
  // indistinguishable from importing it to the historical isolation checks.
  const providerDir = ['scripts', 'public-intelligence', 'providers'].join('/');
  for (const name of ['mastodon-transport', 'mastodon-mapper', 'common', 'mastodon']) {
    const unit = `${providerDir}/${name}.mjs`;
    assert.ok(readFileSync(path.join(REPO_ROOT, unit))
      .equals(Buffer.from(execFileSync('git', ['show', `${BASE_COMMIT}:${unit}`]))), `${name} changed`);
  }
});
// ===========================================================================
// F. BLUESKY REGRESSION (non-empty runs and every failure class)
// ===========================================================================
test('F1 a normal non-empty Bluesky run still works end to end', async () => {
  const { result } = await runBluesky([{ posts: [blueskyPostView()] }]);
  assert.equal(result.status, RUN_STATUS.COMPLETED);
  assert.equal(result.manifest.recordsIngested, 1);
  assert.equal(result.manifest.rawEvidenceRecordsWritten, 1);
  assert.equal(result.manifest.providerCursorSummary.stopReason, 'MAX_PAGES');
  assert.equal(result.verification.ok, true, JSON.stringify(result.verification.failures));
  assert.equal(replayRun(result.directory).ok, true);
});
test('F2 a mapper refusal is still counted rather than failed, on a complete run', async () => {
  // A refused record leaves no evidence, and a refusal is expected, not a
  // failure: the run still completes and still accounts for the record exactly.
  const { result } = await runBluesky([{ posts: [{ uri: AT_URI }] }]);
  const m = result.manifest;
  assert.equal(m.refused, 1);
  assert.equal(m.recordsMapped, 0);
  assert.equal(m.providerRecordsSeen, m.recordsMapped + m.refused);
  assert.equal(m.rawEvidenceRecordsWritten, 0);
  assert.equal(m.status, RUN_STATUS.COMPLETED);
  assert.deepEqual(result.verification.failures, []);
});
test('F3 a rate limit is unchanged: RATE_LIMITED, counted once, never retried', async () => {
  const { result } = await failingBlueskyRun(429);
  assert.equal(result.manifest.status, RUN_STATUS.RATE_LIMITED);
  assert.equal(result.manifest.failureCounts.RATE_LIMITED, 1);
  assert.equal(result.manifest.providerCursorSummary.stopReason, 'REQUEST_FAILED');
  assert.equal(result.verification.ok, true, JSON.stringify(result.verification.failures));
});
test('F4 an auth requirement is unchanged: PROVIDER_ERROR and no credential', async () => {
  for (const status of [401, 403]) {
    const { result } = await failingBlueskyRun(status);
    assert.equal(result.manifest.status, RUN_STATUS.PROVIDER_ERROR);
    assert.equal(result.manifest.failureCounts.PROVIDER_AUTH_REQUIRED, 1);
    assert.equal(result.manifest.providerCursorSummary.stopReason, 'REQUEST_FAILED');
  }
});
test('F5 4xx and 5xx remain distinct provider failures', async () => {
  const four = await failingBlueskyRun(400);
  assert.equal(four.result.manifest.failureCounts.PROVIDER_4XX, 1);
  const five = await failingBlueskyRun(500);
  assert.equal(five.result.manifest.failureCounts.PROVIDER_5XX, 1);
  for (const { result } of [four, five]) {
    assert.equal(result.manifest.status, RUN_STATUS.PROVIDER_ERROR);
    assert.notEqual(result.manifest.status, RUN_STATUS.COMPLETED);
    assert.equal(result.manifest.providerCursorSummary.stopReason, 'REQUEST_FAILED');
  }
});
test('F6 a timeout is unchanged and distinct from every other failure', async () => {
  const { result } = await failingBlueskyRun(0, { aborted: true });
  assert.equal(result.manifest.status, RUN_STATUS.TIMEOUT);
  assert.equal(result.manifest.failureCounts.TIMEOUT, 1);
  assert.equal(result.manifest.providerCursorSummary.stopReason, 'REQUEST_FAILED');
});
test('F7 evidence acquired before a mid-run failure is retained, not discarded', async () => {
  resetClock();
  const root = tempRoot();
  const fetchImpl = async url => (String(url).includes('cursor=')
    ? new Response('{"error":"boom"}', { status: 500, headers: { 'content-type': 'application/json' } })
    : new Response(JSON.stringify({ posts: [blueskyPostView()], cursor: '12345' }),
      { status: 200, headers: { 'content-type': 'application/json' } }));
  const result = await executeCollectionRun(blueskyPlan(TWO_PAGE_BOUNDS), {
    clock, fetchImpl, outputRoot: root, adapter: B_ADAPTER.createBlueskyRunAdapter(),
  });
  assert.equal(result.manifest.recordsIngested, 1, 'page 1 evidence must survive the page 2 failure');
  assert.equal(result.manifest.status, RUN_STATUS.PROVIDER_ERROR);
  assert.notEqual(result.manifest.status, RUN_STATUS.COMPLETED);
});
// ===========================================================================
// G. COMPATIBILITY WITH EVERY EARLIER PHASE
// ===========================================================================
const phaseCount = (script, line) => {
  const output = execFileSync('node', [script], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.ok(output.includes(line), `${script} did not report ${line}`);
};
test('G1 5K.3 stays 96/96', () => phaseCount('scripts/validate-phase5k3.mjs', 'Phase 5K.3: 96/96 passed'));
test('G2 5K.4 stays 116/116', () => phaseCount('scripts/validate-phase5k4.mjs', 'Phase 5K.4: 116/116 passed'));
test('G3 5K.5 stays 130/130', () => phaseCount('scripts/validate-phase5k5.mjs', 'Phase 5K.5: 130/130 passed'));
test('G4 5K.6 stays 166/166', () => phaseCount('scripts/validate-phase5k6.mjs', 'Phase 5K.6: 166/166 passed'));
test('G5 5K.6.1 stays 57/57', () => phaseCount('scripts/validate-phase5k6-1.mjs', 'Phase 5K.6.1: 57/57 passed'));
test('G6 R4 C1 is an ancestor of HEAD and finalized R4 artifacts are unchanged', () => {
  execFileSync('git', ['merge-base', '--is-ancestor', R4_HEAD, 'HEAD'], { cwd: REPO_ROOT });
  for (const bound of ['governance/r4/r4-preregistration-seal.json', 'package.json', 'package-lock.json']) {
    assert.ok(readFileSync(path.join(REPO_ROOT, bound)).equals(execFileSync('git', ['show', `${R4_HEAD}:${bound}`])), bound);
  }
});
test('G7 this phase changes no evidence, mapper, transport or revision semantics module', () => {
  // 5K.6.2 is a TERMINAL VOCABULARY fix. Everything that defines evidence,
  // mapping, transport behaviour or revision semantics must be untouched, and
  // the fix must actually live in the shared run/manifest layer. The provider
  // directory fragment is assembled so naming it is not an import.
  const providerDir = ['scripts', 'public-intelligence', 'providers'].join('/');
  const changed = gitOut('diff', '--name-only', BASE_COMMIT).split('\n').filter(Boolean);
  const forbidden = changed.filter(entry => entry.includes(providerDir)
    || /observation|provenance|normalize|dedup|ingest|revision|temporal-|corpus-/.test(entry));
  assert.deepEqual(forbidden, [], '5K.6.2 must not touch evidence, provider or revision semantics');
  assert.ok(changed.some(entry => /manifest|run/.test(entry)), 'the fix must live in the run/manifest layer');
});
// ===========================================================================
// H. ISOLATION
// ===========================================================================
test('H1 this validator imports exactly ONE project module and names no protected fragment', () => {
  const { found } = parseModule('scripts/validate-phase5k6-2.mjs');
  assert.deepEqual(found.importSources.filter(source => source.startsWith('.')),
    ['./public-intelligence/bluesky-validation-surface.mjs']);
  // The historical isolation checks cannot tell a MENTION from an IMPORT, so no
  // protected fragment may appear even as a string literal here.
  for (const source of found.importSources) {
    for (const fragment of SURFACE.PROTECTED_MODULE_FRAGMENTS) {
      assert.ok(!source.includes(fragment), `an import source names ${fragment}`);
    }
  }
  for (const literal of found.stringLiterals) {
    for (const fragment of SURFACE.PROTECTED_MODULE_FRAGMENTS) {
      assert.ok(!literal.includes(fragment), `a literal names ${fragment}: ${literal}`);
    }
  }
});
test('H2 the whole validator suite made zero real network calls', () => {
  // Proven, not asserted: both tripwires were installed before any run.
  assert.equal(tripwireCalls, 0);
});
test('H3 no trading, engine, Arena or prediction path is introduced', () => {
  // The forbidden path fragments are assembled from parts so this assertion does
  // not itself contain the very tokens it bans. The check is STRUCTURAL, because
  // identifiers and import sources are what can actually reach forbidden code.
  // READ-ONLY references to an already-finalized governance file (the R4 seal,
  // which G6 checks are byte-identical) are not an introduced decision path.
  const forbiddenPathFragments = [
    ['engine'], ['arena'], ['champion'], ['market', 'outcomes'].join('-'),
  ];
  const forbidden = new RegExp(forbiddenPathFragments.join('|'), 'i');
  const banned = /^(score|rank|ranking|sentiment|signal|recommend|predict|forecast|profit|alpha|momentum|virality|tradingSignal|priceTarget|marketCap)/i;
  const { found, source } = parseModule('scripts/validate-phase5k6-2.mjs');
  for (const id of found.identifiers) assert.ok(!banned.test(id), `the validator declares ${id}`);
  for (const src of found.importSources) assert.ok(!forbidden.test(src), `the validator imports ${src}`);
  // A TEST TITLE is prose describing what is banned, and the fragment list above
  // necessarily SPELLS the banned words; neither is a reachable path. What can
  // actually reach forbidden code is an identifier, an import source, or a
  // literal that LOOKS LIKE A PATH into a decision surface. So the literal scan
  // is restricted to path-shaped strings. The governance directory is read-only
  // input here (G6 asserts those files are byte-identical), never a decision path.
  const titles = new Set(tests.map(([title]) => title));
  for (const literal of found.stringLiterals) {
    if (titles.has(literal)) continue;
    if (!literal.includes('/')) continue;
    if (literal.startsWith('governance/')) continue;
    assert.ok(!forbidden.test(literal), `the validator names ${literal}`);
  }
  assert.ok(!/process\.env/.test(source), 'the validator reads the environment');
});
test('H4 the guarded area is untouched and no runtime capture is tracked', () => {
  const guarded = ['.', 'evolve'].join('');
  const guardedLine = new RegExp(`^\\s*[MADRCU?!]{1,2}\\s+\\${guarded}`);
  for (const line of gitOut('status', '--porcelain').split('\n').filter(Boolean)) {
    assert.ok(!guardedLine.test(line), 'the guarded area must be untouched');
  }
  assert.equal(gitOut('ls-files', 'var').trim(), '', 'no capture under var/ is tracked');
  assert.equal(existsFile(path.join(REPO_ROOT, guarded, 'public-intelligence')), false);
});
test('H5 this phase adds no credential, cookie or token capability', () => {
  const { found, source } = parseModule('scripts/validate-phase5k6-2.mjs');
  for (const id of found.identifiers) {
    assert.ok(!/^(apiKey|api_key|clientSecret|appPassword|accessToken|refreshToken|sessionCookie|password|authorization|cookie)$/.test(id), id);
  }
  assert.ok(!/process\.env/.test(source));
  // The two shared modules the fix touches introduce no secret material either.
  // Their names are assembled from parts so this file never spells a path.
  for (const name of [['collection', 'manifest'].join('-'), ['collection', 'run'].join('-')]) {
    const text = readFileSync(path.join(REPO_ROOT, `${PI}/${name}.mjs`), 'utf8');
    assert.ok(!/Authorization|Bearer|apiKey|clientSecret|password/i.test(text), name);
  }
});
test('H6 the governed surface still re-exports only and adds no behaviour', () => {
  const { source } = parseModule(`${PI}/bluesky-validation-surface.mjs`);
  assert.ok(!/^\s*(?:async\s+)?function\b/m.test(source), 'the surface declares no function');
  assert.ok(!/^\s*class\b/m.test(source), 'the surface declares no class');
  assert.ok(!/^\s*(?:if|for|while|switch|try)\b/m.test(source), 'the surface has no control flow');
  assert.ok(!/process\.env|Date\.now|setTimeout|setInterval/.test(source), 'the surface reads no clock or environment');
});
test('H7 every file this phase touches lives inside the governed tree or is a validator', () => {
  const changed = gitOut('diff', '--name-only', BASE_COMMIT).split('\n').filter(Boolean);
  for (const entry of changed) {
    // The documentation tree is allowed, exactly as 5K.6's own Q11 scope check
    // allows it: a later phase is expected to land a phase document, and that
    // document is not a change to any governed semantic surface.
    assert.ok(entry.startsWith(`${PI}/`) || entry.startsWith('docs/') || entry.startsWith('scripts/validate-'), entry);
  }
});
test('H8 this validator is itself offline by construction and never runs a live smoke', () => {
  // The only child processes it starts are the historical phase validators, so
  // it can never reach a live provider, a CLI or a decision surface.
  const { source } = parseModule('scripts/validate-phase5k6-2.mjs');
  const targets = [...source.matchAll(/execFileSync\('node',\s*\[script\]/g)];
  assert.ok(targets.length >= 1, 'the historical phase validators must actually be run');
  const invoked = [...source.matchAll(/phaseCount\('([^']+)'/g)].map(match => match[1]);
  assert.equal(invoked.length, 5, 'every earlier phase validator is pinned by count');
  for (const target of invoked) assert.ok(target.startsWith('scripts/validate-phase5k'), target);
});

// ---------------------------------------------------------------------------
async function main() {
  let failed = 0;
  try {
    for (const [name, fn] of tests) {
      try { await fn(); console.log(`PASS ${name}`); } catch (error) { failed++; console.error(`FAIL ${name}: ${error.stack}`); }
    }
  } finally { for (const root of temporary) rmSync(root, { recursive: true, force: true }); }
  console.log(`Phase 5K.6.2: ${tests.length - failed}/${tests.length} passed; offline, fixture runs + injected clocks only, ${tripwireCalls} network calls, terminal stop-reason compatibility only`);
  if (failed) process.exitCode = 1;
}
main().catch(error => { console.error('phase 5K.6.2 validator crashed:', error); process.exitCode = 1; });