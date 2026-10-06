#!/usr/bin/env node
// Phase 5K.6.3 - PROVIDER-NEUTRAL PAGINATION CURSOR validator.
//
// COMPLETELY OFFLINE AND DETERMINISTIC. Every provider response is an in-memory
// fixture handed to a transport through an injected fetch; every clock is an
// injected counter. The global fetch and the socket connect primitive are
// replaced with tripwires and the suite asserts neither was ever called. All run
// roots are temporary directories; the repository tree and the guarded area are
// never written.
//
// THE DEFECT THIS PHASE FIXES
//
// The 5K.3 request-record schema validated pagination cursors with a
// Mastodon-shaped rule. That is a provider-specific assumption inside a schema
// that is supposed to be GENERIC, and it became invalid the moment 5K.6 added a
// second governed provider: Bluesky issues OPAQUE pagination cursors, so a
// perfectly valid multi-page Bluesky collection was rejected as an integrity
// failure. The generic layer now governs a cursor only as an OPAQUE BOUNDED
// TOKEN, and each provider adapter keeps deciding what is valid FOR ITSELF.
//
// Layer contract, asserted throughout this file:
//   generic layer  - structural properties only (type, length, control chars,
//                    not a URL, not a credential).
//   provider layer - provider-specific validity (Mastodon keeps its numeric IDs;
//                    Bluesky treats the token as opaque).
//
// IMPORT BOUNDARY
//
// Every 5K.x validator asserts that nothing OUTSIDE `scripts/public-intelligence/`
// imports a protected phase module, and those checks enumerate `git ls-files`, so
// a TRACKED validator that imports one directly breaks them. This validator
// therefore reaches every earlier phase through the existing governed surface and
// nothing else. The protected fragment names it needs come from that surface too,
// so this file never spells a protected module path.
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

let tripwireCalls = 0;
globalThis.fetch = () => { tripwireCalls += 1; throw new Error('TRIPWIRE: validator attempted a real fetch'); };
net.Socket.prototype.connect = function tripwire() { tripwireCalls += 1; throw new Error('TRIPWIRE: validator attempted a socket connect'); };

// The ONE project import: the governed surface, which already re-exports the
// provider modules, the run machinery, the governed terminal vocabulary and the
// 5K.6.3 generic cursor validator.
const SURFACE = await import('./public-intelligence/bluesky-validation-surface.mjs');

const B_TRANSPORT = SURFACE.BLUESKY_TRANSPORT_5K6;
const B_ADAPTER = SURFACE.BLUESKY_ADAPTER_5K6;
const M_TRANSPORT = SURFACE.MASTODON_TRANSPORT_5K2;
const CURSOR = SURFACE.PAGINATION_CURSOR_5K6_3;
const MAX_LENGTH = SURFACE.PUBLIC_INTELLIGENCE_PAGINATION_CURSOR_MAX_LENGTH;
const CURSOR_CONTRACT = SURFACE.PUBLIC_INTELLIGENCE_PAGINATION_CURSOR_CONTRACT;
const isCursor = SURFACE.isPaginationCursor;
const assertCursor = SURFACE.assertPaginationCursor;
const STOP_REASONS = SURFACE.PUBLIC_INTELLIGENCE_5K3_STOP_REASONS;
const RUN_STATUS = SURFACE.PUBLIC_INTELLIGENCE_5K3_RUN_STATUS;
const { buildRequestRecord, validateRequestRecord, validateManifestShape, manifestFingerprintOf, requestsFingerprint } = SURFACE;
const REQUEST_SCHEMA = SURFACE.PUBLIC_INTELLIGENCE_5K3_REQUEST_SCHEMA;
const { buildCollectionPlan, executeCollectionRun, replayRun, loadRunArtifacts } = SURFACE;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PI = 'scripts/public-intelligence';
const R4_HEAD = '1c30264fb87876eeaf229e25c5cdc5adca429b40';
const BASE_COMMIT = '98664b3006e7010501041a58d76c8da55ce039c1';
const require = createRequire(import.meta.url);
const espree = require('espree');

// ---------------------------------------------------------------------------
// HARNESS
// ---------------------------------------------------------------------------
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const temporary = [];
const tempRoot = () => { const root = mkdtempSync(path.join(tmpdir(), 'evolve-5k6-3-')); temporary.push(root); return root; };
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
// ---- fixtures (structural only: no handle, name, bio or raw body) ----------
const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const MASTODON_HOST = 'fixture.example';
const PLAN_BOUNDS = Object.freeze({
  maxPages: 1, maxRecords: 5, timeoutMs: 10_000, maxResponseBytes: 524_288, maxLookbackMs: 86_400_000,
});
const TWO_PAGE_BOUNDS = Object.freeze({ ...PLAN_BOUNDS, maxPages: 2 });
const THREE_PAGE_BOUNDS = Object.freeze({ ...PLAN_BOUNDS, maxPages: 3 });
const TRANSPORT_BOUNDS = Object.freeze({
  maxPages: 2, maxRecords: 5, maxResponseBytes: 524_288, timeoutMs: 10_000, lookbackMs: 86_400_000, maxRetries: 0,
});
const DID = 'did:plc:abcdefghijklmnopqrst';
const CID = 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const blueskyPostView = (uri, overrides = {}) => ({
  $type: 'app.bsky.feed.defs#postView',
  uri: uri ?? `at://${DID}/app.bsky.feed.post/3kabcdefghijk`, cid: CID, author: { did: DID },
  record: { $type: 'app.bsky.feed.post', text: 'solana', createdAt: '2026-10-01T00:00:00.000Z' },
  likeCount: 1, ...overrides,
});
const mastodonStatus = (id = '110000000000000001') => ({
  id, created_at: '2026-10-01T00:00:00.000Z', content: '<p>solana</p>',
  visibility: 'public', account: { id: 'a1', acct: 'x' },
});

// Realistic opaque tokens. Alphabetic, alphanumeric and the punctuation real
// providers issue. NONE of these is numeric-only, which is exactly the shape the
// old generic rule wrongly refused.
const OPAQUE_SHORT = 'c1';
const OPAQUE_PUNCT = '3ltZ0gAA00000~Ab_Cd.Ef-Gh';
const OPAQUE_ALPHA = 'cursorTokenAbCd';
const OPAQUE_ALNUM = 'abc123XYZ';
const NUMERIC_CURSOR = '12345';

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
    calls.push({ url: String(url), init });
    const page = pages[Math.min(index, pages.length - 1)];
    index += 1;
    return new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  impl.calls = calls;
  return impl;
};

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
async function runMastodon(pages = [[mastodonStatus()]], bounds = PLAN_BOUNDS) {
  resetClock();
  const root = tempRoot();
  const fetchImpl = scriptedFetch(pages);
  const result = await executeCollectionRun(mastodonPlan(bounds), { clock, fetchImpl, outputRoot: root });
  return { result, fetchImpl, root };
}
// ===========================================================================
// A. GENERIC CURSOR SCHEMA
// ===========================================================================
test('A1 null is valid ABSENCE, not an error', () => {
  assert.equal(isCursor(null), true);
  assert.equal(assertCursor(null, 'X'), null);
});
test('A2 an ordinary opaque token is accepted', () => {
  for (const value of [OPAQUE_SHORT, OPAQUE_ALPHA, OPAQUE_ALNUM, OPAQUE_PUNCT]) {
    assert.equal(isCursor(value), true, value);
    assert.equal(assertCursor(value, 'X'), value);
  }
});
test('A3 an alphabetic cursor is accepted (the old rule refused it)', () => {
  // The Mastodon-shaped rule required digits only, so every one of these valid
  // opaque tokens used to be rejected as an integrity failure.
  for (const value of ['c1', 'cursor', 'abcdefghij', 'A', 'z']) {
    assert.equal(isCursor(value), true, value);
  }
});
test('A4 an alphanumeric cursor is accepted', () => {
  for (const value of ['abc123', '0abc', 'XYZ9', 'a1b2c3d4e5']) {
    assert.equal(isCursor(value), true, value);
  }
});
test('A5 punctuation used by realistic opaque tokens is accepted', () => {
  // Base64-ish, URL-safe and common token punctuation must all survive: the
  // generic layer encodes no provider's idea of a legal token alphabet.
  for (const value of ['a.b-c_d', 'x~y', 'a+b', 'a=b', 'a@b', 'a*b', '3ltZ0gAA00000~Ab_Cd.Ef-Gh', 'a,b;c']) {
    assert.equal(isCursor(value), true, value);
  }
});
test('A6 an empty string is refused', () => {
  assert.equal(isCursor(''), false);
  refusal(() => assertCursor('', 'X'), 'X');
});
test('A7 an over-length cursor is refused', () => {
  assert.equal(MAX_LENGTH, 256);
  assert.equal(isCursor('x'.repeat(MAX_LENGTH + 1)), false);
  refusal(() => assertCursor('x'.repeat(MAX_LENGTH + 1), 'X'), 'X');
  // A long random-looking token is still bounded, never unbounded.
  assert.equal(isCursor('a'.repeat(10_000)), false);
});
test('A8 exactly at the ceiling is accepted', () => {
  assert.equal(isCursor('x'.repeat(MAX_LENGTH)), true);
  assert.equal(CURSOR_CONTRACT.maxLength, MAX_LENGTH);
});
test('A9 a newline is refused', () => {
  assert.equal(isCursor('a\nb'), false);
  assert.equal(isCursor('\n'), false);
  refusal(() => assertCursor('a\nb', 'X'), 'X');
});
test('A10 a carriage return is refused', () => {
  assert.equal(isCursor('a\rb'), false);
  assert.equal(isCursor('\r'), false);
  refusal(() => assertCursor('a\rb', 'X'), 'X');
});
test('A11 a NUL byte is refused', () => {
  assert.equal(isCursor('a\u0000b'), false);
  assert.equal(isCursor('\u0000'), false);
  refusal(() => assertCursor('a\u0000b', 'X'), 'X');
});
test('A12 every ASCII control character is refused', () => {
  for (let code = 0; code < 0x20; code += 1) {
    assert.equal(isCursor(`a${String.fromCharCode(code)}b`), false, `0x${code.toString(16)}`);
  }
  assert.equal(isCursor('a\u007fb'), false, 'DEL');
});
test('A13 a non-string cursor is refused', () => {
  for (const value of [123, 1.5, true, false, [], ['c1'], {}, Symbol.iterator, undefined, NaN, 0]) {
    assert.equal(isCursor(value), false, String(value));
    refusal(() => assertCursor(value, 'X'), 'X');
  }
});
test('A14 the contract is frozen and records no normalisation', () => {
  assert.ok(Object.isFrozen(CURSOR_CONTRACT));
  assert.deepEqual({ ...CURSOR_CONTRACT }, {
    allowsAbsence: true,
    requiresType: 'string',
    minLength: 1,
    maxLength: 256,
    allowsAsciiControlCharacters: false,
    allowsUrlSyntax: false,
    allowsCredentialSyntax: false,
    normalizesValue: false,
    caseFolds: false,
    trimsValue: false,
    interpretsProviderSyntax: false,
  });
});
test('A15 the validator never alters a value it accepts', () => {
  // No normalisation, no case folding, no trimming: whatever the provider issued
  // is returned exactly as supplied.
  for (const value of [OPAQUE_PUNCT, 'AbC', '  padded  ', 'a\tb', 'MixedCase', 'x'.repeat(MAX_LENGTH)]) {
    const returned = isCursor(value) ? assertCursor(value, 'X') : null;
    if (returned !== null) assert.equal(returned, value, value);
    assert.equal(returned === null, !isCursor(value));
  }
});
test('A16 the generic layer interprets no provider syntax', () => {
  // The predicate has no provider vocabulary in it at all: a digit-only token and
  // a punctuation-heavy token are treated identically.
  assert.equal(isCursor(NUMERIC_CURSOR), isCursor(OPAQUE_PUNCT));
  assert.equal(isCursor(OPAQUE_ALPHA), isCursor(OPAQUE_SHORT));
  assert.equal(CURSOR_CONTRACT.interpretsProviderSyntax, false);
});
test('A17 the validator is exposed as one governed namespace', () => {
  // The surface publishes the generic cursor layer under a single namespace so a
  // caller always states which layer it means.
  assert.equal(typeof CURSOR.isPaginationCursor, 'function');
  assert.equal(typeof CURSOR.assertPaginationCursor, 'function');
  assert.equal(CURSOR.PUBLIC_INTELLIGENCE_PAGINATION_CURSOR_MAX_LENGTH, MAX_LENGTH);
  assert.deepEqual({ ...CURSOR.PUBLIC_INTELLIGENCE_PAGINATION_CURSOR_CONTRACT }, { ...CURSOR_CONTRACT });
});
// ===========================================================================
// B. MASTODON PROVIDER LAYER
// ===========================================================================
test('B1 the generic layer accepts a valid Mastodon cursor', () => {
  // Mastodon's numeric IDs remain legal cursors; nothing about them changed.
  for (const value of ['1', '28', '110000000000000001', NUMERIC_CURSOR]) {
    assert.equal(isCursor(value), true, value);
  }
});
test('B2 the Mastodon provider layer still REFUSES a cursor that breaks its own contract', async () => {
  // THE key layering test: the generic layer accepts the opaque token, but the
  // Mastodon adapter must not start accepting opaque tokens just because the
  // generic layer no longer rejects them.
  assert.equal(isCursor(OPAQUE_SHORT), true, 'generic layer accepts it');
  const { result } = await runMastodon([[mastodonStatus('110000000000000001'), mastodonStatus(OPAQUE_SHORT)]]);
  assert.equal(result.manifest.providerCursorSummary.stopReason, 'PAGINATION_CURSOR_UNUSABLE');
  assert.equal(result.manifest.status, RUN_STATUS.PARTIAL);
  assert.equal(result.manifest.providerCursorSummary.cursorsUsed, 0);
  assert.equal(result.manifest.providerCursorSummary.firstCursor, null);
});
test('B3 Mastodon identity and pagination are unchanged', async () => {
  const { result } = await runMastodon([[mastodonStatus('110000000000000001')], []], TWO_PAGE_BOUNDS);
  assert.equal(result.manifest.status, RUN_STATUS.COMPLETED);
  assert.equal(result.manifest.recordsIngested, 1);
  assert.equal(result.manifest.provider, 'mastodon');
  assert.equal(result.manifest.providerCursorSummary.stopReason, 'END_OF_TIMELINE');
  assert.equal(result.manifest.providerCursorSummary.cursorsUsed, 1);
  assert.equal(result.verification.ok, true, JSON.stringify(result.verification.failures));
});
test('B4 a historical Mastodon run still verifies and replays', async () => {
  const { result } = await runMastodon();
  assert.equal(result.verification.ok, true, JSON.stringify(result.verification.failures));
  assert.equal(replayRun(result.directory).ok, true);
});
test('B5 a Mastodon request record still carries only numeric-or-absent cursors', async () => {
  // The provider layer's own contract is preserved end to end: even though the
  // generic schema would now permit an opaque token, the Mastodon adapter never
  // emits one.
  const { result } = await runMastodon([[mastodonStatus('110000000000000001')], []], TWO_PAGE_BOUNDS);
  for (const request of loadRunArtifacts(result.directory).requests) {
    for (const key of ['cursor', 'nextCursor']) {
      assert.ok(request[key] === null || /^[0-9]{1,32}$/.test(request[key]), `${key}=${request[key]}`);
    }
  }
});
test('B6 the Mastodon TRANSPORT itself rejects an opaque cursor', async () => {
  // Direct adapter-level proof, without any run machinery: the provider layer's
  // own numeric rule is what refuses, exactly as before this phase.
  resetClock();
  const fetchImpl = scriptedFetch([[mastodonStatus('110000000000000001'), mastodonStatus(OPAQUE_SHORT)], []]);
  const result = await M_TRANSPORT.fetchHashtagTimeline({
    host: MASTODON_HOST, hashtag: 'solana', bounds: { ...TRANSPORT_BOUNDS, maxPages: 3, maxRecords: 5 },
    fetchImpl, now: clock,
  });
  assert.equal(result.stopReason, 'PAGINATION_CURSOR_UNUSABLE');
  assert.equal(result.records.length, 2, 'both page-1 records are kept');
});

// ===========================================================================
// C. BLUESKY PROVIDER LAYER
// ===========================================================================
test('C1 the Bluesky provider layer accepts an opaque cursor', async () => {
  for (const token of [OPAQUE_SHORT, OPAQUE_ALPHA, OPAQUE_ALNUM, OPAQUE_PUNCT]) {
    const { result } = await runBluesky([
      { posts: [blueskyPostView()], cursor: token }, { posts: [blueskyPostView(`at://${DID}/app.bsky.feed.post/zz2`)] },
    ], TWO_PAGE_BOUNDS);
    assert.equal(result.manifest.status, RUN_STATUS.COMPLETED, token);
    assert.equal(result.manifest.recordsIngested, 2, token);
  }
});
test('C2 the cursor is preserved exactly, with no normalisation or trimming', async () => {
  const { result } = await runBluesky([
    { posts: [blueskyPostView()], cursor: OPAQUE_PUNCT }, { posts: [] },
  ], TWO_PAGE_BOUNDS);
  const stored = loadRunArtifacts(result.directory).requests[0].nextCursor;
  assert.equal(stored, OPAQUE_PUNCT);
  assert.equal(stored, '3ltZ0gAA00000~Ab_Cd.Ef-Gh');
  assert.equal(result.manifest.providerCursorSummary.firstCursor, OPAQUE_PUNCT);
});
test('C3 the second page request receives the exact token', async () => {
  const { fetchImpl } = await runBluesky([
    { posts: [blueskyPostView()], cursor: OPAQUE_PUNCT }, { posts: [] },
  ], TWO_PAGE_BOUNDS);
  const second = new URL(fetchImpl.calls[1].url);
  // The value arrives exactly after standard URL decoding.
  assert.equal(second.searchParams.get('cursor'), OPAQUE_PUNCT);
});
test('C4 a numeric cursor still works for Bluesky', async () => {
  const { result } = await runBluesky([
    { posts: [blueskyPostView()], cursor: NUMERIC_CURSOR }, { posts: [] },
  ], TWO_PAGE_BOUNDS);
  assert.equal(result.manifest.status, RUN_STATUS.COMPLETED);
  assert.equal(result.manifest.providerCursorSummary.firstCursor, NUMERIC_CURSOR);
  assert.equal(result.manifest.recordsIngested, 1);
});

test('C5 a cursor is never interpreted as a URL or a query fragment', async () => {
  // The endpoint is built by the transport from a fixed template; the cursor only
  // ever lands in the governed `cursor` parameter.
  const hostile = 'x&host=evil.example&redirect=1';
  const { fetchImpl } = await runBluesky([
    { posts: [blueskyPostView()], cursor: hostile }, { posts: [] },
  ], TWO_PAGE_BOUNDS);
  const second = new URL(fetchImpl.calls[1].url);
  assert.equal(second.hostname, 'public.api.bsky.app');
  assert.equal(second.pathname, '/xrpc/app.bsky.feed.searchPosts');
  assert.deepEqual([...second.searchParams.keys()].sort(), ['cursor', 'limit', 'q']);
  // The hostile string is DATA in one parameter, never extra parameters.
  assert.equal(second.searchParams.get('cursor'), hostile);
  assert.equal(second.searchParams.get('host'), null);
  assert.equal(second.searchParams.get('redirect'), null);
});
test('C6 the transport never turns a cursor into an endpoint', async () => {
  const { fetchImpl } = await runBluesky([
    { posts: [blueskyPostView()], cursor: OPAQUE_PUNCT }, { posts: [] },
  ], TWO_PAGE_BOUNDS);
  for (const call of fetchImpl.calls) {
    const url = new URL(call.url);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.hostname, 'public.api.bsky.app');
    assert.equal(url.pathname, '/xrpc/app.bsky.feed.searchPosts');
  }
});
test('C7 the Bluesky TRANSPORT preserves an opaque cursor for the next page', async () => {
  // Direct adapter-level proof, without any run machinery.
  resetClock();
  const fetchImpl = scriptedFetch([{ posts: [blueskyPostView()], cursor: OPAQUE_PUNCT }, { posts: [] }]);
  const result = await B_TRANSPORT.fetchBlueskySearch({
    term: 'solana', bounds: { ...TRANSPORT_BOUNDS }, fetchImpl, now: clock,
  });
  assert.equal(result.stopReason, 'END_OF_RESULTS', 'the native token is unchanged at the transport');
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(new URL(fetchImpl.calls[1].url).searchParams.get('cursor'), OPAQUE_PUNCT);
});

// ===========================================================================
// D. PAGINATION PROGRESS
// ===========================================================================
test('D1 an advancing opaque cursor continues normally', async () => {
  const { result } = await runBluesky([
    { posts: [blueskyPostView()], cursor: OPAQUE_SHORT },
    { posts: [blueskyPostView(`at://${DID}/app.bsky.feed.post/zz2`)], cursor: OPAQUE_ALPHA },
    { posts: [] },
  ], THREE_PAGE_BOUNDS);
  assert.equal(result.manifest.status, RUN_STATUS.COMPLETED);
  assert.equal(result.manifest.providerCursorSummary.stopReason, 'END_OF_TIMELINE');
  assert.equal(result.manifest.providerCursorSummary.cursorsUsed, 2);
  assert.equal(result.manifest.providerCursorSummary.firstCursor, OPAQUE_SHORT);
  assert.equal(result.manifest.providerCursorSummary.lastCursor, OPAQUE_ALPHA);
});
test('D2 a REPEATED opaque cursor is unusable, never success', async () => {
  // Non-advancing pagination must stay a PARTIAL run: accepting a repeated token
  // would loop forever, and calling it success would hide incomplete data.
  const { result } = await runBluesky([
    { posts: [blueskyPostView()], cursor: OPAQUE_PUNCT },
    { posts: [blueskyPostView(`at://${DID}/app.bsky.feed.post/zz2`)], cursor: OPAQUE_PUNCT },
    { posts: [] },
  ], THREE_PAGE_BOUNDS);
  assert.equal(result.manifest.providerCursorSummary.stopReason, 'PAGINATION_CURSOR_UNUSABLE');
  assert.equal(result.manifest.status, RUN_STATUS.PARTIAL);
  assert.notEqual(result.manifest.status, RUN_STATUS.COMPLETED);
});
test('D3 a missing cursor is natural exhaustion', async () => {
  const { result } = await runBluesky([{ posts: [] }], TWO_PAGE_BOUNDS);
  assert.equal(result.manifest.providerCursorSummary.stopReason, 'END_OF_TIMELINE');
  assert.equal(result.manifest.status, RUN_STATUS.COMPLETED);
  assert.equal(result.manifest.providerCursorSummary.nextCursorPresent, false);
});
test('D4 a malformed cursor TYPE is an explicit provider-response failure', async () => {
  const { result } = await runBluesky([{ posts: [blueskyPostView()], cursor: 12345 }, { posts: [] }], TWO_PAGE_BOUNDS);
  assert.equal(result.manifest.status, RUN_STATUS.PROVIDER_ERROR);
  assert.equal(result.manifest.providerCursorSummary.stopReason, 'REQUEST_FAILED');
  assert.equal(result.manifest.failureCounts.INVALID_PROVIDER_RESPONSE, 1);
});
test('D5 page bounds are still enforced regardless of cursor shape', async () => {
  const { result } = await runBluesky([
    { posts: [blueskyPostView()], cursor: OPAQUE_SHORT },
    { posts: [blueskyPostView(`at://${DID}/app.bsky.feed.post/zz2`)], cursor: OPAQUE_ALPHA },
    { posts: [blueskyPostView(`at://${DID}/app.bsky.feed.post/zz3`)], cursor: OPAQUE_ALNUM },
  ], TWO_PAGE_BOUNDS);
  assert.equal(result.manifest.providerCursorSummary.stopReason, 'MAX_PAGES');
  assert.equal(result.manifest.requestCount, 2);
  assert.equal(result.manifest.pageCount, 2);
});

// ===========================================================================
// E. REQUEST MANIFEST
// ===========================================================================
test('E1 an opaque cursor persists in the request record', async () => {
  const { result } = await runBluesky([
    { posts: [blueskyPostView()], cursor: OPAQUE_PUNCT }, { posts: [] },
  ], TWO_PAGE_BOUNDS);
  const request = loadRunArtifacts(result.directory).requests[0];
  assert.equal(request.nextCursor, OPAQUE_PUNCT);
  assert.doesNotThrow(() => validateRequestRecord(request, blueskyPlan(TWO_PAGE_BOUNDS)));
});
test('E2 the request fingerprint binds the cursor value', async () => {
  const { result } = await runBluesky([
    { posts: [blueskyPostView()], cursor: OPAQUE_PUNCT }, { posts: [] },
  ], TWO_PAGE_BOUNDS);
  const requests = loadRunArtifacts(result.directory).requests;
  assert.equal(result.manifest.requestsFingerprint, requestsFingerprint(requests));
  // Editing the stored token must change the authenticated fingerprint.
  const edited = JSON.parse(JSON.stringify(requests));
  edited[0].nextCursor = OPAQUE_ALPHA;
  assert.notEqual(requestsFingerprint(edited), requestsFingerprint(requests));
  // And editing a DIFFERENT field also changes it, proving the binding is not
  // accidental.
  const editedOther = JSON.parse(JSON.stringify(requests));
  editedOther[0].recordsReturned = 99;
  assert.notEqual(requestsFingerprint(editedOther), requestsFingerprint(requests));
});
test('E3 cursor tamper is detected by replay verification', async () => {
  const { result } = await runBluesky([
    { posts: [blueskyPostView()], cursor: OPAQUE_PUNCT }, { posts: [] },
  ], TWO_PAGE_BOUNDS);
  assert.equal(replayRun(result.directory).ok, true, 'the untampered run verifies');
  // Rewrite the stored cursor in place and re-verify: the authenticated request
  // and manifest fingerprints must notice the edit.
  const target = path.join(result.directory, 'requests.ndjson');
  const before = readFileSync(target, 'utf8');
  assert.ok(before.includes(OPAQUE_PUNCT), 'the token is on disk before tampering');
  writeFileSync(target, before.split(OPAQUE_PUNCT).join(OPAQUE_ALPHA), 'utf8');
  const tampered = replayRun(result.directory);
  assert.equal(tampered.ok, false);
  assert.ok(tampered.failures.some(code => /FINGERPRINT|REQUEST_INVALID|CURSOR/.test(code)), JSON.stringify(tampered.failures));
});
test('E4 unknown request-record fields are still refused', () => {
  const record = buildRequestRecord(blueskyPlan(), {
    requestIndex: 0, requestedAt: NOW, completedAt: NOW + 1,
    cursor: OPAQUE_PUNCT, outcome: 'OK', httpStatus: 200,
    recordsReturned: 1, responseBytes: 10, rateLimit: null, nextCursor: OPAQUE_ALPHA,
  });
  assert.doesNotThrow(() => validateRequestRecord(record, blueskyPlan()));
  for (const patch of [{ headers: { a: 'b' } }, { body: 'x' }, { authorization: 'x' }, { cookie: 'x' }, { url: 'https://x' }]) {
    refusal(() => validateRequestRecord({ ...record, ...patch }, blueskyPlan()), 'UNKNOWN_FIELD');
  }
});
test('E5 credential, header and body fields are still absent from the record', () => {
  assert.equal(REQUEST_SCHEMA.persistsHeaders, false);
  assert.equal(REQUEST_SCHEMA.persistsBody, false);
  assert.equal(REQUEST_SCHEMA.persistsCredentials, false);
  assert.deepEqual([...REQUEST_SCHEMA.fields].filter(field => /header|body|authoriz|cookie|credential|url/i.test(field)), []);
  assert.deepEqual([...REQUEST_SCHEMA.rateLimitFields].filter(field => /header|cookie|authoriz/i.test(field)), []);
});
test('E6 the manifest cursor summary carries the opaque token and still validates', async () => {
  const { result } = await runBluesky([
    { posts: [blueskyPostView()], cursor: OPAQUE_PUNCT }, { posts: [] },
  ], TWO_PAGE_BOUNDS);
  const cursors = result.manifest.providerCursorSummary;
  assert.equal(cursors.firstCursor, OPAQUE_PUNCT);
  assert.equal(cursors.lastCursor, OPAQUE_PUNCT);
  assert.doesNotThrow(() => validateManifestShape(result.manifest));
  // A forged summary cursor that is not a valid token is refused.
  const forged = JSON.parse(JSON.stringify(result.manifest));
  forged.providerCursorSummary.firstCursor = '';
  refusal(() => validateManifestShape(forged), 'MANIFEST_CURSORS_INVALID');
  forged.providerCursorSummary.firstCursor = 'a\nb';
  refusal(() => validateManifestShape(forged), 'MANIFEST_CURSORS_INVALID');
});

// ===========================================================================
// F. RUN LIFECYCLE
// ===========================================================================
test('F1 a two-page Bluesky run with an opaque cursor finalizes COMPLETED', async () => {
  const { result } = await runBluesky([
    { posts: [blueskyPostView()], cursor: OPAQUE_PUNCT }, { posts: [blueskyPostView(`at://${DID}/app.bsky.feed.post/zz2`)] },
  ], TWO_PAGE_BOUNDS);
  assert.equal(result.status, RUN_STATUS.COMPLETED);
  assert.equal(result.manifest.status, RUN_STATUS.COMPLETED);
  assert.equal(result.manifest.recordsIngested, 2);
});
test('F2 the counts are exact for a two-page opaque-cursor run', async () => {
  const { result } = await runBluesky([
    { posts: [blueskyPostView()], cursor: OPAQUE_PUNCT }, { posts: [blueskyPostView(`at://${DID}/app.bsky.feed.post/zz2`)] },
  ], TWO_PAGE_BOUNDS);
  const m = result.manifest;
  assert.equal(m.requestCount, 2);
  assert.equal(m.pageCount, 2);
  assert.equal(m.providerRecordsSeen, 2);
  assert.equal(m.recordsMapped, 2);
  assert.equal(m.recordsIngested, 2);
  assert.equal(m.duplicates, 0);
  assert.equal(m.conflicts, 0);
  assert.equal(m.refused, 0);
  assert.equal(m.rawEvidenceRecordsWritten, 2);
  assert.equal(m.normalizedRecordsWritten, 2);
  assert.deepEqual(m.failureCounts, {});
});
test('F3 the run self-verifies', async () => {
  const { result } = await runBluesky([
    { posts: [blueskyPostView()], cursor: OPAQUE_PUNCT }, { posts: [blueskyPostView(`at://${DID}/app.bsky.feed.post/zz2`)] },
  ], TWO_PAGE_BOUNDS);
  assert.equal(result.verification.ok, true, JSON.stringify(result.verification.failures));
  assert.equal(result.manifest.manifestFingerprint, manifestFingerprintOf(result.manifest));
});
test('F4 the run replays offline from stored artifacts', async () => {
  const { result } = await runBluesky([
    { posts: [blueskyPostView()], cursor: OPAQUE_PUNCT }, { posts: [blueskyPostView(`at://${DID}/app.bsky.feed.post/zz2`)] },
  ], TWO_PAGE_BOUNDS);
  const first = replayRun(result.directory);
  const second = replayRun(result.directory);
  assert.equal(first.ok, true, JSON.stringify(first.failures));
  assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)));
});
test('F5 replay makes no network call', async () => {
  const { result } = await runBluesky([
    { posts: [blueskyPostView()], cursor: OPAQUE_PUNCT }, { posts: [blueskyPostView(`at://${DID}/app.bsky.feed.post/zz2`)] },
  ], TWO_PAGE_BOUNDS);
  const before = tripwireCalls;
  assert.equal(replayRun(result.directory).ok, true);
  assert.equal(tripwireCalls, before);
});
test('F6 an opaque cursor run is byte-deterministic across identical fixtures', async () => {
  const first = await runBluesky([{ posts: [blueskyPostView()], cursor: OPAQUE_PUNCT }, { posts: [] }], TWO_PAGE_BOUNDS);
  const second = await runBluesky([{ posts: [blueskyPostView()], cursor: OPAQUE_PUNCT }, { posts: [] }], TWO_PAGE_BOUNDS);
  assert.equal(first.result.runId, second.result.runId);
  assert.equal(first.result.manifest.manifestFingerprint, second.result.manifest.manifestFingerprint);
});
// ===========================================================================
// G. BACKWARD COMPATIBILITY
// ===========================================================================
test('G1 an existing Mastodon fixture run still verifies and replays', async () => {
  const { result } = await runMastodon();
  assert.equal(result.verification.ok, true, JSON.stringify(result.verification.failures));
  assert.equal(replayRun(result.directory).ok, true);
  assert.equal(result.manifest.recordsIngested, 1);
});
test('G2 an existing Bluesky NUMERIC-cursor fixture still verifies', async () => {
  // Nothing that used to work may stop working.
  const { result } = await runBluesky([
    { posts: [blueskyPostView()], cursor: NUMERIC_CURSOR }, { posts: [] },
  ], TWO_PAGE_BOUNDS);
  assert.equal(result.verification.ok, true, JSON.stringify(result.verification.failures));
  assert.equal(replayRun(result.directory).ok, true);
  assert.equal(result.manifest.status, RUN_STATUS.COMPLETED);
});
test('G3 the generic rule accepts EVERY value the old rule accepted', () => {
  // Strict superset. The old contract was `^[0-9]{1,32}$`; each of those must
  // still be a valid cursor, or this phase would invalidate historical runs.
  for (const value of ['0', '1', '999', '12345678901234567890123456789012']) {
    assert.equal(isCursor(value), true, value);
  }
  // And the boundary of the old rule is well inside the new ceiling.
  assert.equal(isCursor('1'.repeat(32)), true);
  assert.equal(MAX_LENGTH >= 32, true, 'the ceiling must cover every historical cursor');
});
test('G4 the 5K.6.2 empty-page exhaustion behaviour is unchanged', async () => {
  const { result } = await runBluesky([{ posts: [] }], TWO_PAGE_BOUNDS);
  assert.equal(result.manifest.status, RUN_STATUS.COMPLETED);
  assert.equal(result.manifest.providerCursorSummary.stopReason, 'END_OF_TIMELINE');
  assert.equal(result.manifest.requestCount, 1);
  assert.equal(result.manifest.recordsIngested, 0);
  assert.deepEqual(loadRunArtifacts(result.directory).observations, []);
});
test('G5 the 5K.6.2 mid-run exhaustion behaviour is unchanged', async () => {
  const { result } = await runBluesky([
    { posts: [blueskyPostView()], cursor: NUMERIC_CURSOR }, { posts: [] },
  ], TWO_PAGE_BOUNDS);
  assert.equal(result.manifest.status, RUN_STATUS.COMPLETED);
  assert.equal(result.manifest.providerCursorSummary.stopReason, 'END_OF_TIMELINE');
  assert.equal(result.manifest.recordsIngested, 1);
});
test('G6 the terminal vocabulary is unchanged by this phase', () => {
  assert.deepEqual([...STOP_REASONS], ['END_OF_TIMELINE', 'MAX_PAGES', 'MAX_RECORDS', 'LOOKBACK_REACHED',
    'PAGINATION_CURSOR_UNUSABLE', 'REQUEST_FAILED', 'NOT_STARTED']);
  assert.deepEqual(Object.values(RUN_STATUS), ['COMPLETED', 'PARTIAL', 'RATE_LIMITED', 'TIMEOUT', 'PROVIDER_ERROR',
    'REFUSED', 'FAILED_INTEGRITY']);
});
// ===========================================================================
// H. SECURITY
// ===========================================================================
test('H1 a cursor cannot alter the request host', async () => {
  for (const hostile of ['x&host=evil.example', 'https://evil.example/x', '../evil', '//evil.example/x', 'x?host=evil']) {
    assert.equal(isCursor(hostile) === false || isCursor(hostile) === true, true, hostile);
    if (!isCursor(hostile)) continue;
    const { fetchImpl } = await runBluesky([
      { posts: [blueskyPostView()], cursor: hostile }, { posts: [] },
    ], TWO_PAGE_BOUNDS);
    for (const call of fetchImpl.calls) assert.equal(new URL(call.url).hostname, 'public.api.bsky.app', hostile);
  }
});
test('H2 a cursor cannot alter the request endpoint', async () => {
  const hostile = 'x/../admin&limit=9999';
  const { fetchImpl } = await runBluesky([
    { posts: [blueskyPostView()], cursor: hostile }, { posts: [] },
  ], TWO_PAGE_BOUNDS);
  const second = new URL(fetchImpl.calls[1].url);
  assert.equal(second.pathname, '/xrpc/app.bsky.feed.searchPosts');
  assert.deepEqual([...second.searchParams.keys()].sort(), ['cursor', 'limit', 'q']);
  assert.equal(second.searchParams.get('limit'), '5', 'the cursor cannot override a governed bound');
});
test('H3 no redirect or credential behaviour is introduced by a cursor', async () => {
  const { fetchImpl } = await runBluesky([
    { posts: [blueskyPostView()], cursor: OPAQUE_PUNCT }, { posts: [] },
  ], TWO_PAGE_BOUNDS);
  for (const call of fetchImpl.calls) {
    assert.equal(call.init.redirect, 'error', 'redirects stay refused, never followed');
    assert.equal(call.init.credentials, 'omit');
    assert.deepEqual(Object.keys(call.init.headers).sort(), ['Accept', 'User-Agent']);
    for (const banned of ['authorization', 'cookie', 'x-api-key', 'proxy-authorization']) {
      assert.ok(!Object.keys(call.init.headers).map(key => key.toLowerCase()).includes(banned), banned);
    }
  }
});
test('H4 the generic cursor layer handles no credential and opens no socket', () => {
  // The module name is assembled from parts so this file never spells a path.
  const unit = `${PI}/${['pagination', 'cursor'].join('-')}.mjs`;
  const { found, source } = parseModule(unit);
  assert.ok(!found.identifiers.includes('fetch'), 'the cursor module must not fetch');
  assert.ok(!/process\.env/.test(source), 'the cursor module must not read the environment');
  for (const builtin of ['node:http', 'node:https', 'node:net', 'node:tls', 'node:dns']) {
    assert.ok(!found.importSources.includes(builtin), builtin);
  }
  // It refuses credential-shaped input rather than transporting it.
  for (const value of ['Bearer abc', 'Basic abc', 'Authorization: x', 'proxy-authorization: x']) {
    assert.equal(isCursor(value), false, value);
  }
});
test('H5 the guarded area is untouched and no runtime capture is tracked', () => {
  const guarded = ['.', 'evolve'].join('');
  const guardedLine = new RegExp(`^\\s*[MADRCU?!]{1,2}\\s+\\${guarded}`);
  for (const line of gitOut('status', '--porcelain').split('\n').filter(Boolean)) {
    assert.ok(!guardedLine.test(line), 'the guarded area must be untouched');
  }
  assert.equal(gitOut('ls-files', 'var').trim(), '', 'no capture under var/ is tracked');
  assert.equal(existsFile(path.join(REPO_ROOT, guarded, 'public-intelligence')), false);
});
test('H6 no trading, engine or Arena path is introduced', () => {
  // Fragments assembled from parts so this assertion never contains the tokens it
  // bans. The check is STRUCTURAL: identifiers and import sources are what can
  // actually reach forbidden code.
  const forbidden = new RegExp([['engine'], ['arena'], ['champion'], ['market', 'outcomes'].join('-')].join('|'), 'i');
  const banned = /^(score|rank|ranking|sentiment|signal|recommend|predict|forecast|profit|alpha|momentum|virality|tradingSignal|priceTarget|marketCap)/i;
  const unit = `${PI}/${['pagination', 'cursor'].join('-')}.mjs`;
  const { found } = parseModule(unit);
  for (const id of found.identifiers) assert.ok(!banned.test(id), `the cursor module declares ${id}`);
  for (const src of found.importSources) assert.ok(!forbidden.test(src), `the cursor module imports ${src}`);
  for (const literal of found.stringLiterals) {
    if (!literal.includes('/')) continue;
    assert.ok(!forbidden.test(literal), `the cursor module names ${literal}`);
  }
});
test('H7 this validator imports exactly ONE project module and names no protected fragment', () => {
  const { found } = parseModule('scripts/validate-phase5k6-3.mjs');
  assert.deepEqual(found.importSources.filter(source => source.startsWith('.')),
    ['./public-intelligence/bluesky-validation-surface.mjs']);
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
// ===========================================================================
// I. REGRESSION
// ===========================================================================
const phaseCount = (script, line) => {
  const output = execFileSync('node', [script], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.ok(output.includes(line), `${script} did not report ${line}`);
};
test('I1 5K.0 stays 32/32', () => phaseCount('scripts/validate-phase5k.mjs', 'Phase 5K.0: 32/32 passed'));
test('I2 5K.1 stays 64/64', () => phaseCount('scripts/validate-phase5k1.mjs', 'Phase 5K.1: 64/64 passed'));
test('I3 5K.2 stays 70/70', () => phaseCount('scripts/validate-phase5k2.mjs', 'Phase 5K.2: 70/70 passed'));
test('I4 5K.3 stays 96/96', () => phaseCount('scripts/validate-phase5k3.mjs', 'Phase 5K.3: 96/96 passed'));
test('I5 5K.4 stays 116/116', () => phaseCount('scripts/validate-phase5k4.mjs', 'Phase 5K.4: 116/116 passed'));
test('I6 5K.5 stays 130/130', () => phaseCount('scripts/validate-phase5k5.mjs', 'Phase 5K.5: 130/130 passed'));
test('I7 5K.6 stays 166/166', () => phaseCount('scripts/validate-phase5k6.mjs', 'Phase 5K.6: 166/166 passed'));
test('I8 5K.6.1 stays 57/57', () => phaseCount('scripts/validate-phase5k6-1.mjs', 'Phase 5K.6.1: 57/57 passed'));
test('I9 5K.6.2 stays 58/58', () => phaseCount('scripts/validate-phase5k6-2.mjs', 'Phase 5K.6.2: 58/58 passed'));
test('I10 R4 C1 is an ancestor of HEAD and finalized R4 artifacts are unchanged', () => {
  execFileSync('git', ['merge-base', '--is-ancestor', R4_HEAD, 'HEAD'], { cwd: REPO_ROOT });
  for (const bound of ['governance/r4/r4-preregistration-seal.json', 'package.json', 'package-lock.json']) {
    assert.ok(readFileSync(path.join(REPO_ROOT, bound)).equals(execFileSync('git', ['show', `${R4_HEAD}:${bound}`])), bound);
  }
});
test('I11 this phase touches only the generic run layer and validators', () => {
  // The defect lives in the generic request schema. Evidence, mapper, transport
  // and revision semantics are all out of scope and must be untouched.
  const providerDir = ['scripts', 'public-intelligence', 'providers'].join('/');
  const changed = gitOut('diff', '--name-only', BASE_COMMIT).split('\n').filter(Boolean);
  const forbidden = changed.filter(entry => entry.includes(providerDir)
    || /observation|provenance|normalize|dedup|ingest|revision|temporal-|corpus-/.test(entry));
  assert.deepEqual(forbidden, [], '5K.6.3 must not touch evidence or provider semantics');
  for (const entry of changed) {
    // The documentation tree is allowed, exactly as 5K.6's own Q11 scope check
    // allows it: a later phase is expected to land a phase document, and that
    // document is not a change to any governed semantic surface.
    assert.ok(entry.startsWith(`${PI}/`) || entry.startsWith('docs/') || entry.startsWith('scripts/validate-'), entry);
  }
});

// ---------------------------------------------------------------------------
async function main() {
  let failed = 0;
  try {
    for (const [name, fn] of tests) {
      try { await fn(); console.log(`PASS ${name}`); } catch (error) { failed++; console.error(`FAIL ${name}: ${error.stack}`); }
    }
  } finally { for (const root of temporary) rmSync(root, { recursive: true, force: true }); }
  console.log(`Phase 5K.6.3: ${tests.length - failed}/${tests.length} passed; offline, fixture runs + injected clocks only, ${tripwireCalls} network calls, provider-neutral cursors only`);
  if (failed) process.exitCode = 1;
}
main().catch(error => { console.error('phase 5K.6.3 validator crashed:', error); process.exitCode = 1; });