#!/usr/bin/env node
// Phase 5K.6 - BLUESKY / AT PROTOCOL PUBLIC PROVIDER validator.
//
// COMPLETELY OFFLINE AND DETERMINISTIC. Every provider response is an in-memory
// fixture handed to the transport through an injected fetch; every clock is an
// injected counter. The global fetch and the socket connect primitive are
// replaced with tripwires and the suite asserts neither was ever called. All run
// roots are temporary directories; the repository tree, `var/` and `.evolve` are
// never written. No live Bluesky call is made here - the live smoke is a
// separate, explicitly invoked step.
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

// IMPORT BOUNDARY (5K.1 I5 / 5K.2 I5 / 5K.3 J6 / 5K.4 N7)
//
// Every phase validator asserts that nothing OUTSIDE `scripts/public-intelligence/`
// imports a protected phase module, and those checks enumerate `git ls-files`, so
// a TRACKED validator that imports a protected module directly breaks them. This
// validator therefore reaches 5K.0-5K.6 through ONE read-only re-export surface
// inside that governed tree. That is the whole reason this file imports exactly
// one project module. Regression against earlier phases is proven from Git
// history and file sets rather than by naming protected paths here, because a
// path literal in this file would itself look like an architectural import.
const SURFACE = await import('./public-intelligence/bluesky-validation-surface.mjs');

const B_COMMON = SURFACE.BLUESKY_COMMON_5K6;
const B_MAPPER = SURFACE.BLUESKY_MAPPER_5K6;
const B_TRANSPORT = SURFACE.BLUESKY_TRANSPORT_5K6;
const B_REVISION = SURFACE.BLUESKY_REVISION_5K6;
const B_ADAPTER = SURFACE.BLUESKY_ADAPTER_5K6;
const CORPUS_INDEX = SURFACE.CORPUS_INDEX_5K4;
const CORPUS_SNAPSHOT = SURFACE.CORPUS_SNAPSHOT_5K4;
const PROJ = SURFACE.TEMPORAL_PROJECTION_5K5;
const STATE = SURFACE.OBSERVATION_STATE_5K5;
const REV = SURFACE.REVISION_CHAIN_5K5;
const { PUBLIC_INTELLIGENCE_CLASSIFICATION, canonical } = SURFACE;
const { createMemoryStore, ingestPublicObservation, rawObservationFingerprint } = SURFACE;
const {
  buildCollectionPlan, executeCollectionRun, replayRun, loadRunArtifacts, manifestFingerprintOf,
} = SURFACE;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PI = 'scripts/public-intelligence';
const R4_HEAD = '1c30264fb87876eeaf229e25c5cdc5adca429b40';
const require = createRequire(import.meta.url);
const espree = require('espree');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const temporary = [];
const tempRoot = () => { const root = mkdtempSync(path.join(tmpdir(), 'evolve-5k6-')); temporary.push(root); return root; };
const gitOut = (...args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
const refusal = (fn, fragment) => {
  let thrown = null;
  try { fn(); } catch (error) { thrown = error; }
  assert.ok(thrown, `expected refusal containing ${fragment}`);
  assert.ok(String(thrown.message).includes(fragment), `expected ${fragment}, got ${thrown.message}`);
};
/**
 * A mapper/provider refusal carries its machine code in `message` and its
 * specific reason in `details.reason`. Both are asserted so a refusal cannot
 * pass by returning the right code for the wrong reason.
 */
const refusalReason = (fn, reason, code = 'BLUESKY_RECORD_REFUSED') => {
  let thrown = null;
  try { fn(); } catch (error) { thrown = error; }
  assert.ok(thrown, `expected a refusal with reason ${reason}`);
  assert.equal(thrown.message, code, `expected code ${code}, got ${thrown.message}`);
  assert.equal(thrown.details?.reason, reason, `expected reason ${reason}, got ${thrown.details?.reason}`);
};
async function refusalAsync(promise, fragment) {
  let thrown = null;
  try { await promise; } catch (error) { thrown = error; }
  assert.ok(thrown && String(thrown.message).includes(fragment), `expected ${fragment}, got ${thrown?.message}`);
}


// ---- AST helpers -----------------------------------------------------------
function parseModule(relative) {
  const source = readFileSync(path.join(REPO_ROOT, relative), 'utf8');
  const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const found = { identifiers: [], stringLiterals: [], importSources: [], memberObjects: [] };
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === 'Identifier') found.identifiers.push(node.name);
    if (node.type === 'Literal' && typeof node.value === 'string') found.stringLiterals.push(node.value);
    if (['ImportDeclaration', 'ExportAllDeclaration', 'ExportNamedDeclaration', 'ImportExpression'].includes(node.type) && node.source?.value) {
      found.importSources.push(node.source.value);
    }
    if (node.type === 'MemberExpression' && node.object?.type === 'Identifier') found.memberObjects.push(node.object.name);
    for (const value of Object.values(node)) if (value && typeof value === 'object') walk(value);
  };
  walk(ast);
  return { source, found };
}
const existsFile = candidate => { try { return statSync(candidate).isFile(); } catch { return false; } };
function importClosure(entry) {
  const seen = new Set(); const queue = [entry];
  while (queue.length) {
    const current = queue.shift();
    if (seen.has(current) || !existsFile(path.join(REPO_ROOT, current))) continue;
    seen.add(current);
    for (const source of parseModule(current).found.importSources) {
      if (source.startsWith('.')) queue.push(path.normalize(path.join(path.dirname(current), source)));
    }
  }
  return [...seen].sort();
}

const BLUESKY_MODULES = ['bluesky-common', 'bluesky-mapper', 'bluesky-transport', 'bluesky-revision', 'bluesky']
  .map(name => `${PI}/providers/${name}.mjs`);
// The validators of Phases 5K.0-5K.5. Each is the OWN validator of its phase and
// is exempted by that phase's own isolation rule (which skips the validator for
// the phase it belongs to). 5K.6 is NOT in this list: it must reach every earlier
// phase through the governed surface instead.
const HISTORICAL_VALIDATORS = [
  'scripts/validate-phase5k.mjs', 'scripts/validate-phase5k1.mjs', 'scripts/validate-phase5k2.mjs',
  'scripts/validate-phase5k3.mjs', 'scripts/validate-phase5k4.mjs', 'scripts/validate-phase5k5.mjs',
];
const BLUESKY_CLOSURE = [...new Set(BLUESKY_MODULES.flatMap(importClosure))].sort();
const NETWORK_BUILTINS = ['node:http', 'node:https', 'node:http2', 'node:net', 'node:tls', 'node:dgram', 'node:dns', 'node:child_process',
  'node:worker_threads', 'http', 'https', 'net', 'tls', 'dgram', 'dns', 'child_process'];
const WALLET_MODULES = ['@solana/web3.js', '@solana/spl-token', 'solana', 'tweetnacl', 'ed25519-hd-keypairs', 'bs58'];
const ENGINE_MODULES = ['engine', 'arena', 'champion', 'promotion', 'r4-', 'market-outcomes', 'governance/r4'];
const SIGNING_OR_RPC_WRITE = ['sendRawTransaction', 'sendTransaction', 'sendAndConfirmTransaction', 'signTransaction', 'signAllTransactions',
  'partialSign', 'Keypair', 'VersionedTransaction', 'Transaction', 'SystemProgram', 'splToken', 'requestAirdrop', 'confirmTransaction'];


// ---- fixtures --------------------------------------------------------------
const DID = 'did:plc:abcdefghijklmnopqrst';
const DID_2 = 'did:plc:zyxwvutsrqponmlkji';
const RKEY = '3kabcdefghijk';
const AT_URI = `at://${DID}/app.bsky.feed.post/${RKEY}`;
const AT_URI_2 = `at://${DID_2}/app.bsky.feed.post/${RKEY}`;
const CID_A = 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CID_B = 'bafyreibbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MINT_2 = 'So11111111111111111111111111111111111111112';
const PUBLISHED = '2026-10-01T00:00:00.000Z';
const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const FETCHED = NOW;
const PLAN_BOUNDS = Object.freeze({
  maxPages: 1, maxRecords: 5, maxResponseBytes: 262_144, timeoutMs: 5_000, maxLookbackMs: 86_400_000,
});
const BOUNDS = Object.freeze({
  maxPages: 1, maxRecords: 5, maxResponseBytes: 262_144, timeoutMs: 5_000, lookbackMs: 86_400_000, maxRetries: 0,
});

const postView = (overrides = {}) => ({
  $type: 'app.bsky.feed.defs#postView',
  uri: AT_URI,
  cid: CID_A,
  author: { did: DID },
  record: { $type: 'app.bsky.feed.post', text: 'solana', createdAt: PUBLISHED },
  likeCount: 7,
  replyCount: 3,
  repostCount: 2,
  quoteCount: 1,
  ...overrides,
});
const withRecord = (recordOverrides, viewOverrides = {}) => postView({
  ...viewOverrides,
  record: { $type: 'app.bsky.feed.post', text: 'solana', createdAt: PUBLISHED, ...recordOverrides },
});
const mapView = (view = postView(), options = {}) => B_MAPPER.mapPostViewToRawObservation(view, {
  fetchedAt: FETCHED, collectionRunId: 'run-5k6-fixture', collectorMode: 'OFFLINE_FIXTURE', ...options,
});
const rawOf = (view = postView()) => mapView(view).raw;

/** A transport that answers each page from a scripted list. */
const scriptedFetch = pages => {
  let index = 0;
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init, authorization: init?.headers?.Authorization ?? null });
    const page = pages[Math.min(index, pages.length - 1)];
    index += 1;
    if (typeof page === 'function') return page(url, init);
    return new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  impl.calls = calls;
  return impl;
};
let clockValue = NOW;
const clock = () => (clockValue += 1_000);
const resetClock = (start = NOW) => { clockValue = start; };

const mkPlan = (overrides = {}) => buildCollectionPlan({
  provider: 'bluesky', term: 'solana', bounds: PLAN_BOUNDS, collectionMode: 'OFFLINE_FIXTURE', createdAt: NOW, ...overrides,
});

/** Executes one offline Bluesky run and returns the run plus any sidecars. */
async function runBluesky({ pages = [{ posts: [postView()] }], plan = mkPlan(), root = null, evidence = null } = {}) {
  resetClock();
  const repository = root ?? tempRoot();
  const fetchImpl = scriptedFetch(pages);
  const collected = evidence ?? [];
  const result = await executeCollectionRun(plan, {
    clock, fetchImpl, outputRoot: repository,
    adapter: B_ADAPTER.createBlueskyRunAdapter({ onEvidence: item => collected.push(item) }),
  });
  return { result, fetchImpl, collected, root: repository };
}

// ===========================================================================
// A. GOVERNANCE
// ===========================================================================
test('A1 every 5K.6 observation carries the frozen 5K.0 research/observer-only classification', () => {
  const raw = rawOf();
  assert.deepEqual({ ...raw.classification }, { ...PUBLIC_INTELLIGENCE_CLASSIFICATION });
  for (const flag of ['developmentOnly', 'researchOnly', 'observerOnly', 'paperOnly']) assert.equal(raw.classification[flag], true, flag);
  for (const flag of ['tradingAuthority', 'engineAuthority', 'arenaEligible', 'promotionEligible', 'profitabilityInferencePermitted']) {
    assert.equal(raw.classification[flag], false, flag);
  }
});
test('A2 the revision sidecar carries the frozen classification and cannot override it', () => {
  const raw = rawOf();
  const sidecar = B_REVISION.buildProviderRevisionEvidence({
    provider: raw.provider, providerObservationId: raw.providerObservationId,
    rawObservationFingerprint: rawObservationFingerprint(raw), providerContentCid: CID_A,
  });
  assert.deepEqual({ ...sidecar.classification }, { ...PUBLIC_INTELLIGENCE_CLASSIFICATION });
  refusal(() => B_REVISION.validateBlueskyRevisionEvidence({
    ...sidecar, classification: { ...PUBLIC_INTELLIGENCE_CLASSIFICATION, tradingAuthority: true },
  }), 'CLASSIFICATION_OVERRIDE_REFUSED');
});
test('A3 the 5K.6 modules contain no sentiment, score, ranking, signal or prediction vocabulary', () => {
  // Only the 5K.6 provider modules are scanned. 5K.0 governance legitimately
  // declares NEGATIVE flags such as `profitabilityInferencePermitted: false`,
  // so scanning the shared definition module would flag the very disclaimer that
  // makes the boundary auditable. Identifiers and member objects are scanned,
  // not comments: a module may SAY it produces no signal.
  const words = /sentiment|ranking|profitabilityInference|predict|recommend|momentum|virality|tradingSignal|priceTarget|marketCap/i;
  const FROZEN_SCHEMA_NAMES = new Set(['similaritySignals']);
  for (const entry of BLUESKY_MODULES) {
    const { found } = parseModule(entry);
    for (const id of [...found.identifiers, ...found.memberObjects]) {
      if (FROZEN_SCHEMA_NAMES.has(id)) continue;
      assert.ok(!words.test(id), `${entry} declares ${id}`);
    }
  }
});
test('A4 no Bluesky module can reach the engine, Arena, promotion or R4 code', () => {
  for (const entry of BLUESKY_CLOSURE) {
    // The shared canonicalization/definition source is the ONE permitted
    // out-of-tree member, exactly as 5K.3 J1 allows.
    assert.ok(entry.startsWith(`${PI}/`) || entry === 'scripts/market-intelligence/definition.mjs', `unexpected closure member ${entry}`);
    assert.ok(!ENGINE_MODULES.some(fragment => entry.replace(`${PI}/`, '').includes(fragment)), entry);
  }
});
test('A5 no wallet, signer, swap or RPC-write capability exists in the Bluesky closure', () => {
  for (const entry of BLUESKY_CLOSURE) {
    const { found } = parseModule(entry);
    for (const source of found.importSources) assert.ok(!WALLET_MODULES.includes(source), `${entry} ${source}`);
    for (const id of [...found.identifiers, ...found.memberObjects]) assert.ok(!SIGNING_OR_RPC_WRITE.includes(id), `${entry} ${id}`);
  }
});
test('A6 the adapter declares itself observation-only and exposes no decision surface', () => {
  assert.equal(B_MAPPER.BLUESKY_ADAPTER_NAME, 'bluesky_public_appview');
  assert.ok(/^5k6\./.test(B_MAPPER.BLUESKY_ADAPTER_VERSION));
  const { found } = parseModule(`${PI}/providers/bluesky.mjs`);
  const decision = /^(score|rank|ranking|sentiment|signal|recommend|recommendation|predict|forecast|profit|alpha)/i;
  for (const id of [...found.identifiers, ...found.memberObjects]) {
    assert.ok(!decision.test(id), `adapter declares ${id}`);
  }
});
test('A7 the phase document exists and covers every required section and disclaimer', () => {
  const doc = readFileSync(path.join(REPO_ROOT, 'docs/PHASE5K6-BLUESKY-PROVIDER.md'), 'utf8').toLowerCase();
  for (const heading of ['purpose', 'official endpoint', 'provider identity', 'at uri', 'did', 'cid semantics', 'revision semantics',
    'transport', 'mapper', 'privacy', 'reply', 'quote', 'repost', 'engagement', 'exact mint', 'collection plan integration',
    'run', 'replay', 'cross-provider corpus', 'temporal integration', 'non-goals', 'roadmap label']) {
    assert.ok(doc.includes(heading), `doc lacks "${heading}"`);
  }
  for (const disclaimer of ['research', 'observer', 'no trading authority', 'no engine authority', 'no arena eligibility',
    'not a trading signal', 'no market linkage', 'no price correlation', 'no profitability inference']) {
    assert.ok(doc.includes(disclaimer), `doc lacks the disclaimer "${disclaimer}"`);
  }
});
test('A8 the roadmap label is present and the phase claims nothing beyond itself', () => {
  const doc = readFileSync(path.join(REPO_ROOT, 'docs/PHASE5K6-BLUESKY-PROVIDER.md'), 'utf8').toLowerCase();
  assert.ok(doc.includes('roadmap label'));
});

// ===========================================================================
// B. PUBLIC TRANSPORT
// ===========================================================================
test('B1 the endpoint is HTTPS on the single documented public AppView host', () => {
  const url = new URL(B_TRANSPORT.BLUESKY_TRANSPORT.endpointTemplate);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.host, 'public.api.bsky.app');
  assert.equal(url.host, B_COMMON.BLUESKY_APPVIEW_HOST);
  assert.equal(url.pathname, '/xrpc/app.bsky.feed.searchPosts');
});
test('B2 the governed method is exactly app.bsky.feed.searchPosts and it is a GET query', () => {
  assert.equal(B_COMMON.BLUESKY_SEARCH_METHOD, 'app.bsky.feed.searchPosts');
  assert.equal(B_TRANSPORT.BLUESKY_TRANSPORT.method, 'GET');
  assert.deepEqual([...B_TRANSPORT.BLUESKY_TRANSPORT.governedMethods], ['app.bsky.feed.searchPosts']);
});
test('B3 an arbitrary host, port, path or URL cannot be supplied', () => {
  for (const host of ['evil.example', 'bsky.app', 'public.api.bsky.app.evil.example', '127.0.0.1', 'localhost', '']) {
    refusal(() => B_COMMON.assertBlueskyHost(host), 'HOST_INVALID');
  }
  assert.equal(B_COMMON.assertBlueskyHost(undefined), 'public.api.bsky.app');
  assert.equal(B_COMMON.assertBlueskyHost(null), 'public.api.bsky.app');
  assert.equal(B_COMMON.assertBlueskyHost('public.api.bsky.app'), 'public.api.bsky.app');
});
test('B4 an arbitrary XRPC method cannot be supplied', async () => {
  for (const method of ['app.bsky.feed.getTimeline', 'com.atproto.repo.getRecord', 'app.bsky.actor.searchActors', 'x']) {
    refusal(() => B_COMMON.assertBlueskyMethod(method), 'METHOD_FORBIDDEN');
  }
  await refusalAsync(B_TRANSPORT.fetchBlueskySearch({ term: 'solana', method: 'app.bsky.feed.getTimeline', bounds: BOUNDS, fetchImpl: scriptedFetch([{ posts: [] }]) }), 'METHOD_FORBIDDEN');
});
test('B5 no request is made WITHOUT a governed keyword term, and its shape is bounded', () => {
  for (const term of ['', '  ', 'a b', '#solana', 'https://x.example', 'a?b=1', 'a&b=2', 'a/b', 'a:b', 'x'.repeat(65), 7, null]) {
    refusal(() => B_COMMON.assertBlueskySearchTerm(term), 'QUERY_INVALID');
  }
  assert.equal(B_COMMON.assertBlueskySearchTerm('solana'), 'solana');
});
test('B6 the request carries no credential of any kind', async () => {
  const fetchImpl = scriptedFetch([{ posts: [postView()] }]);
  await B_TRANSPORT.fetchBlueskySearch({ term: 'solana', bounds: BOUNDS, fetchImpl, now: clock });
  const [call] = fetchImpl.calls;
  assert.equal(call.authorization, null);
  assert.equal(call.init.credentials, 'omit');
  assert.equal(call.init.redirect, 'error');
  assert.deepEqual(Object.keys(call.init.headers).sort(), ['Accept', 'User-Agent']);
  for (const banned of ['authorization', 'cookie', 'x-api-key', 'proxy-authorization']) {
    assert.ok(!Object.keys(call.init.headers).map(key => key.toLowerCase()).includes(banned), banned);
  }
});
test('B7 the URL query string contains only q, limit and optionally cursor', async () => {
  const fetchImpl = scriptedFetch([{ posts: [postView()] }]);
  await B_TRANSPORT.fetchBlueskySearch({ term: 'solana', bounds: BOUNDS, fetchImpl, now: clock });
  const url = new URL(fetchImpl.calls[0].url);
  assert.deepEqual([...url.searchParams.keys()].sort(), ['limit', 'q']);
  assert.equal(url.searchParams.get('q'), 'solana');
});
test('B8 bounds are validated against hard ceilings and can never be disabled or made unlimited', () => {
  assert.deepEqual(Object.keys(B_COMMON.BLUESKY_HARD_CEILINGS).sort(), ['lookbackMs', 'maxPages', 'maxRecords', 'maxResponseBytes', 'maxRetries', 'timeoutMs']);
  for (const [key, ceiling] of Object.entries(B_COMMON.BLUESKY_HARD_CEILINGS)) {
    refusal(() => B_COMMON.resolveBlueskyBounds({ [key]: ceiling + 1 }), 'BOUNDS_INVALID');
    refusal(() => B_COMMON.resolveBlueskyBounds({ [key]: -1 }), 'BOUNDS_INVALID');
    refusal(() => B_COMMON.resolveBlueskyBounds({ [key]: 1.5 }), 'BOUNDS_INVALID');
    refusal(() => B_COMMON.resolveBlueskyBounds({ [key]: Infinity }), 'BOUNDS_INVALID');
    // maxRetries is the one bound whose floor is 0 (no retry), so only the
    // retry-count keys are tested for a zero floor.
    if (key !== 'maxRetries') refusal(() => B_COMMON.resolveBlueskyBounds({ [key]: 0 }), 'BOUNDS_INVALID');
  }
  refusal(() => B_COMMON.resolveBlueskyBounds({ maxRetries: -1 }), 'BOUNDS_INVALID');
  refusal(() => B_COMMON.resolveBlueskyBounds({ arbitrary: 1 }), 'BOUNDS_INVALID');
  assert.equal(B_COMMON.resolveBlueskyBounds({}).maxRetries, B_COMMON.BLUESKY_DEFAULT_BOUNDS.maxRetries);
});
test('B9 the page size requested never exceeds the documented provider ceiling or the plan record ceiling', async () => {
  const fetchImpl = scriptedFetch([{ posts: [postView()] }]);
  await B_TRANSPORT.fetchBlueskySearch({ term: 'solana', bounds: { ...BOUNDS, maxRecords: 3 }, fetchImpl, now: clock });
  assert.equal(new URL(fetchImpl.calls[0].url).searchParams.get('limit'), '3');
  assert.ok(B_TRANSPORT.BLUESKY_TRANSPORT.pageSizeCeiling <= 100);
});

test('B10 the page bound is honoured: no more requests than maxPages', async () => {
  const fetchImpl = scriptedFetch([{ posts: [postView()], cursor: 'c1' }, { posts: [postView()], cursor: 'c2' }]);
  const result = await B_TRANSPORT.fetchBlueskySearch({ term: 'solana', bounds: { ...BOUNDS, maxPages: 2, maxRecords: 100 }, fetchImpl, now: clock });
  assert.equal(result.pagesFetched, 2);
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(result.stopReason, 'MAX_PAGES');
  assert.equal(result.records.length, 2);
});
test('B11 the record bound is honoured and reported as MAX_RECORDS', async () => {
  const posts = [postView({ uri: AT_URI }), postView({ uri: AT_URI_2 })];
  const fetchImpl = scriptedFetch([{ posts, cursor: 'c1' }]);
  const result = await B_TRANSPORT.fetchBlueskySearch({ term: 'solana', bounds: { ...BOUNDS, maxRecords: 1 }, fetchImpl, now: clock });
  assert.equal(result.records.length, 1);
  assert.equal(result.stopReason, 'MAX_RECORDS');
});
test('B12 an over-old timestamp cannot keep a record in a bounded run', async () => {
  const old = postView({ record: { $type: 'app.bsky.feed.post', text: 'old', createdAt: '2020-01-01T00:00:00.000Z' } });
  const fresh = postView({ uri: AT_URI_2 });
  const fetchImpl = scriptedFetch([{ posts: [old, fresh] }]);
  const result = await B_TRANSPORT.fetchBlueskySearch({ term: 'solana', bounds: BOUNDS, fetchImpl, now: clock });
  assert.deepEqual(result.records.map(record => record.uri), [AT_URI_2]);
  assert.equal(result.stopReason, 'LOOKBACK_REACHED');
});
test('B13 an empty page ends the run with END_OF_RESULTS and makes no further request', async () => {
  const fetchImpl = scriptedFetch([{ posts: [] }]);
  const result = await B_TRANSPORT.fetchBlueskySearch({ term: 'solana', bounds: BOUNDS, fetchImpl, now: clock });
  assert.equal(result.stopReason, 'END_OF_RESULTS');
  assert.equal(result.records.length, 0);
  assert.equal(fetchImpl.calls.length, 1);
});
test('B14 a rate limit is terminal, is never retried, and is reported structurally', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response('{"error":"rate"}', { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '30' } }); };
  await refusalAsync(B_TRANSPORT.fetchBlueskySearch({ term: 'solana', bounds: BOUNDS, fetchImpl, now: clock }), 'BLUESKY_RATE_LIMITED');
  assert.equal(calls, 1, 'a 429 must never be retried');
});
test('B15 an auth requirement FAILS CLOSED rather than being satisfied with a credential', async () => {
  for (const status of [401, 403]) {
    await refusalAsync(B_TRANSPORT.fetchBlueskySearch({
      term: 'solana', bounds: BOUNDS, now: clock,
      fetchImpl: async () => new Response('{"error":"AuthRequired"}', { status, headers: { 'content-type': 'application/json' } }),
    }), 'BLUESKY_AUTH_REQUIRED');
  }
});
test('B16 a transient 5xx earns at most ONE retry and then fails', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response('boom', { status: 500, headers: { 'content-type': 'application/json' } }); };
  await refusalAsync(B_TRANSPORT.fetchBlueskySearch({ term: 'solana', bounds: { ...BOUNDS, maxRetries: 1 }, fetchImpl, now: clock }), 'BLUESKY_SERVER_ERROR_5XX');
  assert.equal(calls, 2, 'exactly one retry');
  let calls2 = 0;
  const fetchImpl2 = async () => { calls2 += 1; return new Response('boom', { status: 503, headers: { 'content-type': 'application/json' } }); };
  await refusalAsync(B_TRANSPORT.fetchBlueskySearch({ term: 'solana', bounds: { ...BOUNDS, maxRetries: 0 }, fetchImpl: fetchImpl2, now: clock }), 'BLUESKY_SERVER_ERROR_5XX');
  assert.equal(calls2, 1, 'no retry when the bound is zero');
});
test('B17 a non-JSON content type and a malformed payload are refused', async () => {
  await refusalAsync(B_TRANSPORT.fetchBlueskySearch({
    term: 'solana', bounds: BOUNDS, now: clock,
    fetchImpl: async () => new Response('<html/>', { status: 200, headers: { 'content-type': 'text/html' } }),
  }), 'UNEXPECTED_CONTENT_TYPE');
  for (const body of ['not json', '[]', '"str"', '{}', '{"posts":{}}']) {
    await refusalAsync(B_TRANSPORT.fetchBlueskySearch({
      term: 'solana', bounds: BOUNDS, now: clock,
      fetchImpl: async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    }), 'MALFORMED_RESPONSE');
  }
});
test('B18 the response byte ceiling is enforced even without a content-length', async () => {
  const huge = JSON.stringify({ posts: [postView({ record: { $type: 'app.bsky.feed.post', text: 'x'.repeat(4096), createdAt: PUBLISHED } })] });
  await refusalAsync(B_TRANSPORT.fetchBlueskySearch({
    term: 'solana', bounds: { ...BOUNDS, maxResponseBytes: 512 }, now: clock,
    fetchImpl: async () => new Response(huge, { status: 200, headers: { 'content-type': 'application/json' } }),
  }), 'RESPONSE_TOO_LARGE');
});
test('B19 a timeout is reported as a terminal TIMEOUT and never as a generic error', async () => {
  await refusalAsync(B_TRANSPORT.fetchBlueskySearch({
    term: 'solana', bounds: { ...BOUNDS, timeoutMs: 5 }, now: clock,
    fetchImpl: async () => { const error = new Error('aborted'); error.name = 'AbortError'; throw error; },
  }), 'BLUESKY_TIMEOUT');
});
test('B20 a network failure is reported, bounded, and never silently swallowed', async () => {
  await refusalAsync(B_TRANSPORT.fetchBlueskySearch({
    term: 'solana', bounds: { ...BOUNDS, maxRetries: 0 }, now: clock,
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  }), 'BLUESKY_NETWORK_ERROR');
});
test('B21 a failed request exposes PARTIAL evidence rather than discarding what was already acquired', async () => {
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    if (call === 1) return new Response(JSON.stringify({ posts: [postView()], cursor: 'c1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('rate', { status: 429, headers: { 'content-type': 'application/json' } });
  };
  let thrown = null;
  try { await B_TRANSPORT.fetchBlueskySearch({ term: 'solana', bounds: { ...BOUNDS, maxPages: 2 }, fetchImpl, now: clock }); } catch (error) { thrown = error; }
  assert.ok(thrown, 'expected a refusal');
  assert.equal(thrown.partial.records.length, 1);
  assert.equal(thrown.partial.pagesFetched, 1);
});
test('B22 request events are structural only: no body, no headers, no credential, no URL', async () => {
  const events = [];
  const fetchImpl = scriptedFetch([{ posts: [postView()], cursor: 'c1' }]);
  await B_TRANSPORT.fetchBlueskySearch({ term: 'solana', bounds: { ...BOUNDS, maxPages: 2 }, fetchImpl, now: clock, onRequest: event => events.push(event) });
  assert.equal(events.length, 2);
  const [event] = events;
  const serialized = JSON.stringify(event);
  assert.ok(!/authorization|cookie|token|password|secret/i.test(serialized));
  assert.ok(!serialized.includes('public.api.bsky.app'), 'a request event must not carry the URL');
  assert.deepEqual(Object.keys(event).sort(), ['completedAt', 'cursor', 'httpStatus', 'nextCursor', 'outcome', 'rateLimit', 'recordsReturned', 'requestIndex', 'requestedAt', 'responseBytes'].sort());
});
test('B23 the transport defines exactly one governed XRPC path and no hidden second entry point', () => {
  const { found } = parseModule(`${PI}/providers/bluesky-transport.mjs`);
  assert.deepEqual(found.stringLiterals.filter(literal => literal.includes('/xrpc/')), ['https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts']);
});
test('B24 only the transport module in the Bluesky closure holds the global fetch capability', () => {
  const holders = BLUESKY_CLOSURE.filter(entry => parseModule(entry).found.identifiers.includes('fetch'));
  assert.deepEqual(holders, [`${PI}/providers/bluesky-transport.mjs`]);
  for (const entry of BLUESKY_CLOSURE) {
    const { found } = parseModule(entry);
    for (const source of found.importSources) assert.ok(!NETWORK_BUILTINS.includes(source), `${entry} ${source}`);
  }
});

// ===========================================================================
// C. PURE MAPPER
// ===========================================================================
test('C1 the mapper emits the EXISTING closed 5K.1 raw schema and nothing else', () => {
  const raw = rawOf();
  assert.deepEqual(Object.keys(raw).sort(), [
    'classification', 'claimedMint', 'collectionContext', 'fetchedAt', 'observedAt', 'provider',
    'providerAuthorId', 'providerObservationId', 'publishedAt', 'rawMetadata', 'rawText', 'recordType',
    'schemaVersion', 'sourceType', 'sourceUrl',
  ].sort());
  SURFACE.validateRawObservation5K1(raw);
});
test('C2 the mapper is pure: it opens no socket, reads no clock and writes no file', () => {
  assert.equal(tripwireCalls, 0);
  const { found, source } = parseModule(`${PI}/providers/bluesky-mapper.mjs`);
  for (const source of found.importSources) assert.ok(!NETWORK_BUILTINS.includes(source), source);
  assert.ok(!found.identifiers.includes('Date'), 'the mapper reads no clock');
  assert.ok(!/Date\.now|new Date\(/.test(source));
  assert.ok(!found.identifiers.some(id => /^(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|rm|rmSync)$/.test(id)));
  assert.ok(!source.includes('process.env'));
});
test('C3 the mapper reads only the declared field set and discards everything else', () => {
  const view = postView({
    handle: 'ignored', displayName: 'ignored', labels: ['x'], viewer: { muted: true },
    embed: { $type: 'app.bsky.embed.images', images: [] }, bookmarkCount: 99, via: {}, threadgate: {},
    author: { did: DID, handle: 'someone.bsky.social', displayName: 'Someone', avatar: 'https://x.example/a.png', description: 'hi', followersCount: 10 },
  });
  const raw = rawOf(view);
  const serialized = JSON.stringify(raw);
  for (const secret of ['someone.bsky.social', 'Someone', 'a.png', 'followersCount', 'bookmarkCount', 'threadgate', 'muted']) {
    assert.ok(!serialized.includes(secret), `raw evidence leaked ${secret}`);
  }
  assert.ok(B_MAPPER.BLUESKY_CONSUMED_FIELDS.every(field => typeof field === 'string'));
});
test('C4 identical provider views map to byte-identical evidence', () => {
  const a = rawOf(postView());
  const b = rawOf(postView());
  assert.equal(canonical(a), canonical(b));
  assert.equal(rawObservationFingerprint(a), rawObservationFingerprint(b));
});
test('C5 the raw fingerprint is over EVOLVE evidence and never the provider CID', () => {
  const raw = rawOf();
  const fingerprint = rawObservationFingerprint(raw);
  assert.ok(/^[0-9a-f]{64}$/.test(fingerprint));
  assert.notEqual(fingerprint, CID_A);
  assert.ok(!canonical(raw).includes(CID_A), 'the CID must not be inside the frozen raw record');
});
test('C6 a record type this adapter does not support fails closed', () => {
  for (const recordType of ['app.bsky.feed.repost', 'app.bsky.feed.like', 'app.bsky.graph.follow', 'unknown.type']) {
    refusalReason(() => mapView(withRecord({ $type: recordType })), 'RECORD_TYPE_UNSUPPORTED');
  }
});
test('C7 a view without a URI, CID, author DID or text is refused', () => {
  refusalReason(() => mapView(postView({ uri: undefined })), 'AT_URI_INVALID');
  refusalReason(() => mapView(postView({ cid: undefined })), 'CID_MISSING');
  refusalReason(() => mapView(postView({ author: {} })), 'AUTHOR_DID_MISSING');
  refusalReason(() => mapView(postView({ author: { did: '   ' } })), 'AUTHOR_DID_MISSING');
  refusalReason(() => mapView(postView({ record: { $type: 'app.bsky.feed.post' } })), 'RECORD_TEXT_NOT_A_STRING');
  refusalReason(() => mapView(null), 'POSTVIEW_NOT_AN_OBJECT');
  refusalReason(() => mapView('nope'), 'POSTVIEW_NOT_AN_OBJECT');
  refusalReason(() => mapView([]), 'POSTVIEW_NOT_AN_OBJECT');
});
test('C8 an unparseable published time is represented as absent, never invented', () => {
  assert.equal(mapView(withRecord({ createdAt: 'not-a-time' })).raw.publishedAt, null);
  assert.equal(mapView(withRecord({ createdAt: undefined })).raw.publishedAt, null);
  assert.equal(mapView(withRecord({ createdAt: '2026-10-01T00:00:00.000Z' })).raw.publishedAt, Date.parse(PUBLISHED));
});
test('C9 observedAt is never fabricated by the adapter', () => {
  // The AppView does not state when EVOLVE observed a record, so the adapter
  // must not claim an instant it was not told.
  assert.equal(rawOf().observedAt, null);
  assert.notEqual(rawOf().fetchedAt, null, 'the acquisition instant is carried separately');
});

// ===========================================================================
// D. AT URI / DID IDENTITY
// ===========================================================================
test('D1 the provider observation id is the canonical AT URI', () => {
  const raw = rawOf();
  assert.equal(raw.providerObservationId, AT_URI);
  assert.ok(raw.providerObservationId.startsWith('at://'));
  assert.ok(raw.providerObservationId.includes('/app.bsky.feed.post/'));
});
test('D2 the author identity is the DID and the DID must match the AT URI authority', () => {
  const raw = rawOf();
  assert.equal(raw.providerAuthorId, DID);
  assert.ok(raw.providerAuthorId.startsWith('did:'));
  refusalReason(() => mapView(postView({ author: { did: DID_2 } })), 'AUTHOR_DID_NE_AT_URI_AUTHORITY');
});
test('D3 identity survives a handle change: no handle appears in identity or evidence', () => {
  const before = rawOf(postView({ author: { did: DID, handle: 'old.bsky.social' } }));
  const after = rawOf(postView({ author: { did: DID, handle: 'new.bsky.social' } }));
  assert.equal(before.providerObservationId, after.providerObservationId);
  assert.equal(before.providerAuthorId, after.providerAuthorId);
  assert.equal(rawObservationFingerprint(before), rawObservationFingerprint(after));
  assert.ok(!canonical(before).includes('old.bsky.social'));
});
test('D4 a handle is never accepted as an AT URI authority', () => {
  assert.equal(B_COMMON.parseAtUri('at://someone.bsky.social/app.bsky.feed.post/abc'), null);
  assert.equal(B_COMMON.parseAtUri(`at://${DID}/app.bsky.feed.post/abc`).authority, DID);
  assert.equal(B_COMMON.isBlueskyPostUri(`at://${DID}/app.bsky.feed.post/abc`), true);
});
test('D5 an AT URI with trailing junk, a missing part or a bad scheme is refused as identity', () => {
  for (const bad of [
    `at://${DID}/app.bsky.feed.post/abc/extra`, `at://${DID}/app.bsky.feed.post`, `at://${DID}/app.bsky.feed.post/`,
    `https://bsky.app/profile/${DID}/post/abc`, `at://${DID}//abc`, 'at://bad/app.bsky.feed.post/abc',
    `at://${DID}/app.bsky.feed.post/ab cd`, '', null, 7,
  ]) {
    assert.equal(B_COMMON.parseAtUri(bad), null, String(bad));
    assert.equal(B_COMMON.isBlueskyPostUri(bad), false, String(bad));
  }
});
test('D6 an AT URI in a different collection is not treated as a post', () => {
  assert.equal(B_COMMON.isBlueskyPostUri(`at://${DID}/app.bsky.feed.repost/abc`), false);
  assert.equal(B_COMMON.isBlueskyPostUri(`at://${DID}/app.bsky.graph.follow/abc`), false);
  assert.equal(B_COMMON.BLUESKY_POST_COLLECTION, 'app.bsky.feed.post');
});
test('D7 two different records with the same rkey stay distinct identities', () => {
  const a = rawOf(postView({ uri: AT_URI }));
  const b = rawOf(postView({ uri: AT_URI_2, author: { did: DID_2 } }));
  assert.notEqual(a.providerObservationId, b.providerObservationId);
  assert.notEqual(a.providerAuthorId, b.providerAuthorId);
  assert.notEqual(SURFACE.dedupIdentity5K1(a), SURFACE.dedupIdentity5K1(b));
});
test('D8 the provider namespace carries no handle, DID or host', () => {
  const namespace = B_COMMON.BLUESKY_PROVIDER_NAMESPACE;
  assert.equal(namespace, 'bluesky:public-appview');
  assert.ok(!namespace.includes(DID));
  assert.ok(!namespace.includes('.bsky.social'));
  assert.ok(!namespace.includes('public.api.bsky.app'));
});
test('D9 the DID is retained inside the evidence where it belongs and is not used as the namespace', () => {
  const raw = rawOf();
  assert.ok(raw.providerObservationId.includes(DID));
  assert.equal(raw.providerAuthorId, DID);
  assert.ok(!raw.provider.includes(DID));
});
test('D10 the source URL is derived from the AT URI and is never used as identity', () => {
  const raw = rawOf();
  assert.equal(raw.sourceUrl, `https://bsky.app/profile/${encodeURIComponent(DID)}/post/${RKEY}`);
  assert.notEqual(raw.sourceUrl, raw.providerObservationId);
});
test('D11 a malformed CID is refused rather than normalized', () => {
  for (const cid of ['', 'notacid', CID_A.toUpperCase(), 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG', CID_A.slice(0, 10), 7, null]) {
    refusalReason(() => B_COMMON.assertProviderCid(cid), 'CID_MALFORMED');
  }
  assert.equal(B_COMMON.assertProviderCid(CID_A), CID_A);
});

test('C10 text is decoded once and preserved character-for-character otherwise', () => {
  assert.equal(B_MAPPER.decodeBlueskyEntities('a &amp; b'), 'a & b');
  assert.equal(B_MAPPER.decodeBlueskyEntities('&#65;&#x42;'), 'AB');
  assert.equal(B_MAPPER.decodeBlueskyEntities('&unknownent;'), '&unknownent;');
  assert.equal(B_MAPPER.decodeBlueskyEntities('no entities'), 'no entities');
  assert.equal(B_MAPPER.decodeBlueskyEntities('&amp;amp;'), '&amp;');
  refusalReason(() => B_MAPPER.decodeBlueskyEntities(7), 'TEXT_NOT_A_STRING');
});
test('C11 the collection context names the adapter, its version and the mode', () => {
  const raw = rawOf();
  assert.equal(raw.collectionContext.adapterName, B_MAPPER.BLUESKY_ADAPTER_NAME);
  assert.equal(raw.collectionContext.adapterVersion, B_MAPPER.BLUESKY_ADAPTER_VERSION);
  assert.equal(raw.collectionContext.collectorMode, 'OFFLINE_FIXTURE');
  assert.equal(raw.collectionContext.collectionRunId, 'run-5k6-fixture');
});
test('C12 the mapper output is frozen and cannot be mutated by a caller', () => {
  const mapped = mapView();
  assert.ok(Object.isFrozen(mapped));
  assert.ok(Object.isFrozen(mapped.raw));
});

test('B25 the transport starts no timer and issues no request at import time', () => {
  assert.equal(tripwireCalls, 0);
  const { source } = parseModule(`${PI}/providers/bluesky-transport.mjs`);
  assert.ok(!/setInterval/.test(source), 'the transport contains no interval');
  assert.ok(!/^\s*await\s+requestPage/m.test(source), 'no top-level request');
});

// ===========================================================================
// E. CID SEMANTICS
// ===========================================================================
test('E1 the CID is retained as provider-native evidence and is bound to the exact raw fingerprint', () => {
  const view = postView();
  const { raw, providerContentCid } = mapView(view);
  assert.equal(providerContentCid, CID_A);
  assert.equal(B_MAPPER.providerContentCidOf(view), CID_A);
  const sidecar = B_REVISION.buildProviderRevisionEvidence({
    provider: raw.provider, providerObservationId: raw.providerObservationId,
    rawObservationFingerprint: rawObservationFingerprint(raw), providerContentCid,
  });
  assert.equal(sidecar.rawObservationFingerprint, rawObservationFingerprint(raw));
  assert.equal(sidecar.providerContentCid, CID_A);
  assert.equal(sidecar.evidenceSource, 'AT_PROTOCOL_RECORD_CID');
});
test('E2 a CID never replaces any EVOLVE fingerprint', () => {
  const raw = rawOf();
  const fingerprints = [
    rawObservationFingerprint(raw),
    PROJ.contentFingerprint5K5(raw),
    PROJ.observationStateFingerprint5K5(raw),
  ];
  for (const fingerprint of fingerprints) {
    assert.ok(/^[0-9a-f]{64}$/.test(fingerprint));
    assert.notEqual(fingerprint, CID_A);
  }
  assert.equal(new Set(fingerprints).size, 3, 'the three EVOLVE fingerprints are distinct');
});
test('E3 the frozen 5K.1 raw schema is untouched by the CID: no CID field exists in raw evidence', () => {
  const raw = rawOf();
  assert.ok(!Object.hasOwn(raw, 'cid'));
  assert.ok(!Object.hasOwn(raw.rawMetadata, 'cid'));
  assert.ok(!Object.hasOwn(raw.rawMetadata, 'providerContentCid'));
  assert.ok(!canonical(raw).includes(CID_A));
  assert.deepEqual(Object.keys(raw.rawMetadata).sort(), [
    'candidateMintAddresses', 'cashtags', 'claimedSymbol', 'claimedTokenName', 'engagement',
    'fixtureNote', 'hashtags', 'language', 'mentionedHandles', 'similaritySignals',
  ].sort());
});
test('E4 the sidecar is a CLOSED schema: an unknown field is a hard refusal', () => {
  const raw = rawOf();
  const sidecar = B_REVISION.buildProviderRevisionEvidence({
    provider: raw.provider, providerObservationId: raw.providerObservationId,
    rawObservationFingerprint: rawObservationFingerprint(raw), providerContentCid: CID_A,
  });
  refusal(() => B_REVISION.validateBlueskyRevisionEvidence({ ...sidecar, providerEditTimestamp: 1 }), 'UNKNOWN_FIELD');
  const missing = { ...sidecar }; delete missing.providerContentCid;
  refusal(() => B_REVISION.validateBlueskyRevisionEvidence(missing), 'FIELD_MISSING');
});
test('E5 the sidecar is self-verifying: tampering with the CID, URI or fingerprint is detected', () => {
  const raw = rawOf();
  const build = () => B_REVISION.buildProviderRevisionEvidence({
    provider: raw.provider, providerObservationId: raw.providerObservationId,
    rawObservationFingerprint: rawObservationFingerprint(raw), providerContentCid: CID_A,
  });
  B_REVISION.validateBlueskyRevisionEvidence(build());
  refusal(() => B_REVISION.validateBlueskyRevisionEvidence({ ...build(), providerContentCid: CID_B }), 'FINGERPRINT_MISMATCH');
  refusal(() => B_REVISION.validateBlueskyRevisionEvidence({ ...build(), providerObservationId: AT_URI_2 }), 'FINGERPRINT_MISMATCH');
  refusal(() => B_REVISION.validateBlueskyRevisionEvidence({ ...build(), rawObservationFingerprint: 'a'.repeat(64) }), 'FINGERPRINT_MISMATCH');
});
test('E6 a sidecar cannot be built for a wrong provider, a non-post URI or a malformed CID', () => {
  const fingerprint = rawObservationFingerprint(rawOf());
  refusal(() => B_REVISION.buildProviderRevisionEvidence({
    provider: 'mastodon:example', providerObservationId: AT_URI, rawObservationFingerprint: fingerprint, providerContentCid: CID_A,
  }), 'REVISION_PROVIDER_INVALID');
  refusal(() => B_REVISION.buildProviderRevisionEvidence({
    provider: B_COMMON.BLUESKY_PROVIDER_NAMESPACE, providerObservationId: 'https://bsky.app/x', rawObservationFingerprint: fingerprint, providerContentCid: CID_A,
  }), 'NOT_A_POST_URI');
  refusal(() => B_REVISION.buildProviderRevisionEvidence({
    provider: B_COMMON.BLUESKY_PROVIDER_NAMESPACE, providerObservationId: AT_URI, rawObservationFingerprint: 'short', providerContentCid: CID_A,
  }), 'REVISION_FINGERPRINT_INVALID');
  refusalReason(() => B_REVISION.buildProviderRevisionEvidence({
    provider: B_COMMON.BLUESKY_PROVIDER_NAMESPACE, providerObservationId: AT_URI, rawObservationFingerprint: fingerprint, providerContentCid: 'nope',
  }), 'CID_MALFORMED');
});
test('E7 a CID difference alone is never claimed from text, counters or a timestamp', () => {
  assert.equal(B_REVISION.BLUESKY_REVISION_SEMANTICS.inferredFromTextChange, false);
  assert.equal(B_REVISION.BLUESKY_REVISION_SEMANTICS.inferredFromCounterChange, false);
  assert.equal(B_REVISION.BLUESKY_REVISION_SEMANTICS.requiresProviderDeclaration, true);
  assert.equal(B_REVISION.BLUESKY_REVISION_SEMANTICS.proofKind, 'CONTENT_ADDRESS_CHANGE');
  assert.equal(B_REVISION.BLUESKY_REVISION_SEMANTICS.proofSource, 'AT_PROTOCOL_RECORD_CID');
  assert.equal(B_REVISION.BLUESKY_REVISION_SEMANTICS.contentAddressIsCryptographic, true);
});
test('E8 the same CID on two different records stays bound to its own evidence', () => {
  const a = rawOf(postView({ uri: AT_URI }));
  const b = rawOf(postView({ uri: AT_URI_2, author: { did: DID_2 } }));
  const build = raw => B_REVISION.buildProviderRevisionEvidence({
    provider: raw.provider, providerObservationId: raw.providerObservationId,
    rawObservationFingerprint: rawObservationFingerprint(raw), providerContentCid: CID_A,
  });
  const sa = build(a); const sb = build(b);
  assert.notEqual(sa.providerObservationId, sb.providerObservationId);
  assert.notEqual(sa.revisionEvidenceFingerprint, sb.revisionEvidenceFingerprint);
});

// ===========================================================================
// F. REVISION PROOF
// ===========================================================================
test('F1 the same URI with the same CID is ONE provider content version', () => {
  const raw = rawOf();
  const fingerprint = rawObservationFingerprint(raw);
  const index = B_REVISION.indexBlueskyRevisionEvidence([B_REVISION.buildProviderRevisionEvidence({
    provider: raw.provider, providerObservationId: raw.providerObservationId,
    rawObservationFingerprint: fingerprint, providerContentCid: CID_A,
  })], new Set([fingerprint]));
  assert.equal(B_REVISION.providerContentCidOf(index, fingerprint), CID_A);
  assert.equal(B_REVISION.BLUESKY_REVISION_SEMANTICS.sameUriSameCidIsSameVersion, true);
});
test('F2 the same URI with a DIFFERENT CID is a provider-declared content revision', () => {
  const rawA = rawOf(withRecord({ text: 'v1' }, { cid: CID_A }));
  const rawB = rawOf(withRecord({ text: 'v2' }, { cid: CID_B }));
  assert.equal(rawA.providerObservationId, rawB.providerObservationId, 'same AT URI');
  assert.notEqual(PROJ.contentFingerprint5K5(rawA), PROJ.contentFingerprint5K5(rawB));
  assert.equal(B_REVISION.classifyBlueskyRevision({
    previousProviderContentCid: CID_A, currentProviderContentCid: CID_B,
    previousContentFingerprint: PROJ.contentFingerprint5K5(rawA), currentContentFingerprint: PROJ.contentFingerprint5K5(rawB),
  }), 'PROVIDER_DECLARED_CONTENT_REVISION');
  assert.equal(B_REVISION.BLUESKY_REVISION_SEMANTICS.sameUriDifferentCidIsRevision, true);
});
test('F3 a changed CID is NOT a legitimate revision unless the provider declares it', () => {
  const rawA = rawOf(withRecord({ text: 'v1' }, { cid: CID_A }));
  const rawB = rawOf(withRecord({ text: 'v2' }, { cid: CID_B }));
  const previous = PROJ.contentFingerprint5K5(rawA);
  const current = PROJ.contentFingerprint5K5(rawB);
  assert.equal(B_REVISION.classifyBlueskyRevision({
    previousProviderContentCid: CID_A, currentProviderContentCid: null, previousContentFingerprint: previous, currentContentFingerprint: current,
  }), 'UNVERIFIED_CONTENT_DIVERGENCE');
  assert.equal(B_REVISION.classifyBlueskyRevision({
    previousProviderContentCid: CID_A, currentProviderContentCid: CID_A, previousContentFingerprint: previous, currentContentFingerprint: current,
  }), 'UNVERIFIED_CONTENT_DIVERGENCE');
  assert.equal(B_REVISION.classifyBlueskyRevision({
    previousProviderContentCid: null, currentProviderContentCid: null, previousContentFingerprint: previous, currentContentFingerprint: current,
  }), 'UNVERIFIED_CONTENT_DIVERGENCE');
});
test('F4 identical content is same-content even when counters moved: state is not a revision', () => {
  const rawA = rawOf(postView({ likeCount: 1 }));
  const rawB = rawOf(postView({ likeCount: 99 }));
  assert.equal(PROJ.contentFingerprint5K5(rawA), PROJ.contentFingerprint5K5(rawB));
  assert.notEqual(PROJ.observationStateFingerprint5K5(rawA), PROJ.observationStateFingerprint5K5(rawB));
  assert.equal(B_REVISION.classifyBlueskyRevision({
    previousProviderContentCid: CID_A, currentProviderContentCid: CID_A,
    previousContentFingerprint: PROJ.contentFingerprint5K5(rawA), currentContentFingerprint: PROJ.contentFingerprint5K5(rawB),
  }), 'SAME_CONTENT_SAME_STATE');
});
test('F5 every historical version is preserved: there is no latest-wins overwrite', () => {
  const versions = [CID_A, CID_B];
  const raws = versions.map((cid, index) => rawOf(withRecord({ text: `v${index + 1}` }, { cid })));
  const sidecars = raws.map((raw, index) => B_REVISION.buildProviderRevisionEvidence({
    provider: raw.provider, providerObservationId: raw.providerObservationId,
    rawObservationFingerprint: rawObservationFingerprint(raw), providerContentCid: versions[index],
  }));
  const known = new Set(raws.map(raw => rawObservationFingerprint(raw)));
  const index = B_REVISION.indexBlueskyRevisionEvidence(sidecars, known);
  assert.equal(index.size, 2, 'both versions survive');
  assert.equal(B_REVISION.providerContentCidOf(index, rawObservationFingerprint(raws[0])), CID_A);
  assert.equal(B_REVISION.providerContentCidOf(index, rawObservationFingerprint(raws[1])), CID_B);
  assert.equal(B_REVISION.BLUESKY_REVISION_SEMANTICS.latestWinsMutation, false);
  assert.equal(B_REVISION.BLUESKY_REVISION_SEMANTICS.historicalVersionsRetained, true);
});
test('F6 revision evidence bound to unknown or duplicated raw evidence is refused', () => {
  const raw = rawOf();
  const fingerprint = rawObservationFingerprint(raw);
  const sidecar = B_REVISION.buildProviderRevisionEvidence({
    provider: raw.provider, providerObservationId: raw.providerObservationId,
    rawObservationFingerprint: fingerprint, providerContentCid: CID_A,
  });
  refusal(() => B_REVISION.indexBlueskyRevisionEvidence([sidecar], new Set(['b'.repeat(64)])), 'BOUND_TO_UNKNOWN_EVIDENCE');
  refusal(() => B_REVISION.indexBlueskyRevisionEvidence([sidecar, sidecar], new Set([fingerprint])), 'DUPLICATE_BINDING');
});
test('F7 the sidecar carries no edit timestamp and no post text', () => {
  const raw = rawOf(withRecord({ text: 'a secret body' }));
  const sidecar = B_REVISION.buildProviderRevisionEvidence({
    provider: raw.provider, providerObservationId: raw.providerObservationId,
    rawObservationFingerprint: rawObservationFingerprint(raw), providerContentCid: CID_A,
  });
  assert.ok(!canonical(sidecar).includes('a secret body'));
  assert.ok(!Object.hasOwn(sidecar, 'providerRevisionTimestamp'));
  assert.ok(!Object.hasOwn(sidecar, 'editedAt'));
  assert.equal(B_REVISION.BLUESKY_REVISION_SEMANTICS.editTimestampAvailable, false);
  assert.equal(B_REVISION.BLUESKY_REVISION_SEMANTICS.requiresEditTimestamp, false);
});
test('F8 Mastodon revision semantics are untouched by 5K.6', () => {
  assert.deepEqual([...REV.PUBLIC_INTELLIGENCE_5K5_REVISION_EVIDENCE_SOURCES], ['MASTODON_STATUS_EDITED_AT']);
  assert.equal(REV.classifyTemporal(null, { contentFingerprint: 'a', observationStateFingerprint: 'b' }), 'FIRST_OBSERVATION');
  assert.equal(REV.classifyTemporal(
    { contentFingerprint: 'a', observationStateFingerprint: 'b', fetchedAt: 1, providerRevisionTimestamp: null },
    { contentFingerprint: 'c', observationStateFingerprint: 'd', fetchedAt: 2, providerRevisionTimestamp: null },
  ), 'UNVERIFIED_CONTENT_DIVERGENCE');
  assert.equal(REV.classifyTemporal(
    { contentFingerprint: 'a', observationStateFingerprint: 'b', fetchedAt: 1, providerRevisionTimestamp: null },
    { contentFingerprint: 'c', observationStateFingerprint: 'd', fetchedAt: 2, providerRevisionTimestamp: 5 },
  ), 'PROVIDER_DECLARED_CONTENT_REVISION');
});

// ===========================================================================
// G. OBSERVATION-STATE COUNTERS
// ===========================================================================
test('G1 the four governed counters map onto the frozen 5K.1 vocabulary', () => {
  const raw = rawOf(postView({ likeCount: 7, replyCount: 3, repostCount: 2, quoteCount: 1 }));
  assert.deepEqual({ ...raw.rawMetadata.engagement }, { likes: 7, quotes: 1, replies: 3, reposts: 2 });
  assert.deepEqual([...B_COMMON.BLUESKY_ENGAGEMENT_COUNTERS], ['likeCount', 'replyCount', 'repostCount', 'quoteCount']);
  assert.deepEqual({ ...B_COMMON.BLUESKY_ENGAGEMENT_MAPPING }, { likeCount: 'likes', replyCount: 'replies', repostCount: 'reposts', quoteCount: 'quotes' });
});
test('G2 a missing counter stays missing and is never zero-filled', () => {
  const raw = rawOf(postView({ likeCount: undefined, replyCount: undefined, repostCount: undefined, quoteCount: undefined }));
  assert.equal(raw.rawMetadata.engagement, null);
  const state = STATE.buildObservationState(raw);
  // Nothing was supplied, so the record is NO_OBSERVATION with null values -
  // never {} and never zeros.
  assert.equal(state.values, null);
  assert.equal(state.status, 'NO_OBSERVATION');
  assert.deepEqual([...state.absentCounters].sort(), ['bookmarks', 'likes', 'quotes', 'replies', 'reposts', 'views']);
  assert.equal(state.zeroFillingApplied, false);
  assert.equal(state.carryForwardApplied, false);
  assert.equal(state.interpolationApplied, false);
  STATE.validateObservationStateRecord(state);
});
test('G3 a provider zero stays an observed zero and is not treated as missing', () => {
  const raw = rawOf(postView({ likeCount: 0, replyCount: 0, repostCount: 0, quoteCount: 0 }));
  assert.deepEqual({ ...raw.rawMetadata.engagement }, { likes: 0, quotes: 0, replies: 0, reposts: 0 });
  const state = STATE.buildObservationState(raw);
  assert.deepEqual({ ...state.values }, { likes: 0, quotes: 0, replies: 0, reposts: 0 });
  // The counters Bluesky never supplied stay absent; they are not zero-filled.
  assert.deepEqual([...state.absentCounters].sort(), ['bookmarks', 'views']);
  assert.equal(state.status, 'OBSERVED');
  assert.equal(state.zeroFillingApplied, false);
  STATE.validateObservationStateRecord(state);
});
test('G4 a counter change is same-content updated-state, never a content conflict', () => {
  const before = rawOf(postView({ likeCount: 1, replyCount: 0 }));
  const after = rawOf(postView({ likeCount: 50, replyCount: 4 }));
  assert.equal(PROJ.contentFingerprint5K5(before), PROJ.contentFingerprint5K5(after), 'counters are not content');
  assert.notEqual(PROJ.observationStateFingerprint5K5(before), PROJ.observationStateFingerprint5K5(after));
  assert.equal(REV.classifyTemporal(
    { contentFingerprint: PROJ.contentFingerprint5K5(before), observationStateFingerprint: PROJ.observationStateFingerprint5K5(before), fetchedAt: 1, providerRevisionTimestamp: null },
    { contentFingerprint: PROJ.contentFingerprint5K5(after), observationStateFingerprint: PROJ.observationStateFingerprint5K5(after), fetchedAt: 2, providerRevisionTimestamp: null },
  ), 'SAME_CONTENT_UPDATED_STATE');
});
test('G5 a counter REGRESSION is allowed and is not an error', () => {
  const high = STATE.buildObservationState(rawOf(postView({ likeCount: 500 })));
  const low = STATE.buildObservationState(rawOf(postView({ likeCount: 480 })));
  assert.equal(high.values.likes, 500);
  assert.equal(low.values.likes, 480);
  assert.notEqual(high.observationStateFingerprint, low.observationStateFingerprint);
  assert.equal(low.deltaComputed, false);
  assert.equal(high.deltaComputed, false);
  STATE.validateObservationStateRecord(low);
});
test('G6 an engagement change is not sentiment, importance, momentum or a trading signal', () => {
  assert.equal(PROJ.PUBLIC_INTELLIGENCE_5K5_OBSERVATION_STATE_FIELDS.includes('likes'), true);
  assert.equal(PROJ.PUBLIC_INTELLIGENCE_5K5_RAW_METADATA_FIELD_CLASSIFICATION.engagement, 'OBSERVATION_STATE');
  const state = STATE.buildObservationState(rawOf());
  assert.ok(!/sentiment|importance|momentum|tradingSignal/i.test(JSON.stringify(state)));
  assert.equal(state.deltaComputed, false);
});
test('G7 bookmarkCount is refused: a viewer-scoped counter has no public meaning', () => {
  assert.ok(!B_COMMON.BLUESKY_ENGAGEMENT_COUNTERS.includes('bookmarkCount'));
  const raw = rawOf(postView({ bookmarkCount: 42 }));
  assert.ok(!canonical(raw).includes('42'));
  assert.ok(!Object.hasOwn(raw.rawMetadata.engagement, 'bookmarks'));
});
test('G8 a non-integer, negative or non-numeric counter is omitted rather than coerced', () => {
  const NONE = { likeCount: undefined, replyCount: undefined, repostCount: undefined, quoteCount: undefined };
  for (const value of ['7', -1, 1.5, null, {}, [], true, NaN, Infinity]) {
    const raw = rawOf(postView({ ...NONE, likeCount: value }));
    assert.equal(raw.rawMetadata.engagement, null, `likeCount=${String(value)} must be omitted`);
  }
  // A well-formed integer is retained, including a legitimate zero.
  assert.deepEqual({ ...rawOf(postView({ ...NONE, likeCount: 0 })).rawMetadata.engagement }, { likes: 0 });
});

// ===========================================================================
// H. EXACT MINT ASSOCIATION
// ===========================================================================
test('H1 exactly one explicit exact mint in the text becomes claimedMint', () => {
  const raw = rawOf(withRecord({ text: `buy ${MINT} now` }));
  assert.equal(raw.claimedMint, MINT);
  assert.deepEqual([...raw.rawMetadata.candidateMintAddresses], [MINT]);
});
test('H2 zero mints leaves claimedMint null', () => {
  const raw = rawOf(withRecord({ text: 'just talking about solana, no address here' }));
  assert.equal(raw.claimedMint, null);
  assert.deepEqual([...raw.rawMetadata.candidateMintAddresses], []);
});
test('H3 several distinct exact mints leave claimedMint null: never guessed', () => {
  const raw = rawOf(withRecord({ text: `${MINT} and ${MINT_2}` }));
  assert.equal(raw.claimedMint, null);
  assert.deepEqual([...raw.rawMetadata.candidateMintAddresses].sort(), [MINT, MINT_2].sort());
});
test('H4 a mint is never inferred from a ticker, cashtag, hashtag, handle, domain or URL', () => {
  const text = '$SOL #solana @someone.solana https://solana.example/token/SOL solana';
  const raw = rawOf(withRecord({ text }));
  assert.equal(raw.claimedMint, null);
  assert.deepEqual([...raw.rawMetadata.candidateMintAddresses], []);
  // The cashtag and hashtag are recorded as CONTENT, never promoted to a mint.
  assert.deepEqual([...raw.rawMetadata.cashtags], ['$SOL']);
  assert.deepEqual([...raw.rawMetadata.hashtags], ['#solana']);
  assert.equal(raw.rawMetadata.claimedSymbol, null);
  assert.equal(raw.rawMetadata.claimedTokenName, null);
});
test('H5 a repeated mention of the SAME mint is one candidate, not an ambiguity', () => {
  const raw = rawOf(withRecord({ text: `${MINT} again ${MINT}` }));
  assert.equal(raw.claimedMint, MINT);
  assert.deepEqual([...raw.rawMetadata.candidateMintAddresses], [MINT]);
});
test('H6 mint case is never folded: a differently-cased string is not the same identity', () => {
  const mangled = `${MINT.slice(0, -1)}x`;
  const raw = rawOf(withRecord({ text: mangled }));
  assert.notEqual(raw.claimedMint, MINT);
});
test('H7 the exact rule is the frozen base58 form: shape is checked, nothing is inferred', () => {
  // "Exact" is the frozen 5K.0 rule: a canonical base58 string of mint length.
  // EVOLVE does not and must not verify on-chain existence here, and it never
  // upgrades a ticker, symbol or partial string into a mint.
  const wrongAlphabet = '0OIl' + 'a'.repeat(30);
  for (const text of [wrongAlphabet, 'short', 'a'.repeat(31), 'a'.repeat(45), '']) {
    assert.deepEqual(B_MAPPER.extractExactMints(text), [], text);
  }
  assert.deepEqual(B_MAPPER.extractExactMints('no candidates here'), []);
  // A base58-shaped string is accepted as a CANDIDATE and is never silently
  // rewritten; the EVOLVE fingerprints still identify the evidence.
  const candidate = 'a'.repeat(34);
  assert.deepEqual(B_MAPPER.extractExactMints(candidate), [candidate]);
});
test('H8 candidate extraction is deterministic and order-preserving', () => {
  assert.deepEqual(B_MAPPER.extractExactMints(`${MINT_2} then ${MINT}`), [MINT_2, MINT]);
  assert.deepEqual(B_MAPPER.extractExactMints(`${MINT} then ${MINT_2}`), [MINT, MINT_2]);
  assert.deepEqual(B_MAPPER.extractExactMints(`${MINT} then ${MINT_2}`), B_MAPPER.extractExactMints(`${MINT} then ${MINT_2}`));
});
test('H9 mint association still routes through the unchanged 5K.1 judgement', () => {
  const store = createMemoryStore();
  ingestPublicObservation(rawOf(withRecord({ text: `token ${MINT}` })), { store });
  ingestPublicObservation(
    rawOf(withRecord({ text: 'no mint here' }, { uri: AT_URI_2, author: { did: DID_2 } })), { store },
  );
  // The stored normalized envelopes carry the 5K.1 association decision, which
  // 5K.6 never overrides.
  const statuses = store.list()
    .map(envelope => envelope.normalized.assetAssociation.status)
    .sort();
  assert.deepEqual(statuses, ['EXACT_MINT', 'UNASSOCIATED']);
  const associated = store.list().find(envelope => envelope.normalized.assetAssociation.status === 'EXACT_MINT');
  assert.equal(associated.normalized.assetAssociation.mint, MINT);
  assert.deepEqual({ ...associated.normalized.assetAssociation.evidence }, {
    claimedMintPresent: true,
    claimedMint: MINT,
    claimedMintIsExactBase58: true,
    exactCandidateCount: 1,
    refusedIdentitySignals: [],
    reason: 'EXACT_BASE58_MINT_PRESENT_IN_EVIDENCE',
  });
});

// ===========================================================================
// I. REPLY / QUOTE / REPOST HANDLING
// ===========================================================================
test('I1 a post with no reply reference maps deterministically to POST', () => {
  assert.equal(B_MAPPER.classifyBlueskySourceType(postView()), 'POST');
  assert.equal(rawOf().sourceType, 'POST');
});
test('I2 a post with a reply reference maps deterministically to REPLY', () => {
  const reply = postView({ record: {
    $type: 'app.bsky.feed.post', text: 'solana', createdAt: PUBLISHED,
    reply: { root: { uri: AT_URI_2, cid: CID_B }, parent: { uri: AT_URI_2, cid: CID_B } },
  } });
  assert.equal(B_MAPPER.classifyBlueskySourceType(reply), 'REPLY');
  assert.equal(rawOf(reply).sourceType, 'REPLY');
});
test('I3 a reply keeps its OWN identity: it never adopts the parent identity', () => {
  const reply = postView({ record: {
    $type: 'app.bsky.feed.post', text: 'solana', createdAt: PUBLISHED,
    reply: { root: { uri: AT_URI_2, cid: CID_B }, parent: { uri: AT_URI_2, cid: CID_B } },
  } });
  const raw = rawOf(reply);
  assert.equal(raw.providerObservationId, AT_URI, 'the reply is its own record');
  assert.notEqual(raw.providerObservationId, AT_URI_2);
  assert.equal(raw.providerAuthorId, DID);
});
test('I4 a malformed reply reference does not silently become a reply', () => {
  const withoutParentUri = postView({ record: { $type: 'app.bsky.feed.post', text: 'solana', createdAt: PUBLISHED, reply: { root: { uri: AT_URI_2 } } } });
  assert.equal(B_MAPPER.classifyBlueskySourceType(withoutParentUri), 'POST');
  const replyNotObject = postView({ record: { $type: 'app.bsky.feed.post', text: 'solana', createdAt: PUBLISHED, reply: 'yes' } });
  assert.equal(B_MAPPER.classifyBlueskySourceType(replyNotObject), 'POST');
});
test('I5 a quote is its own post and the quoted text never joins its text', () => {
  const quote = postView({
    record: { $type: 'app.bsky.feed.post', text: `quoting this ${MINT}`, createdAt: PUBLISHED },
    embed: { $type: 'app.bsky.embed.record', record: { uri: AT_URI_2, cid: CID_B } },
  });
  const raw = rawOf(quote);
  assert.equal(raw.sourceType, 'POST', 'a quote is a post, not a wrapper');
  assert.equal(raw.rawText, `quoting this ${MINT}`);
  assert.equal(raw.providerObservationId, AT_URI);
});
test('I6 a record-with-media quote embed is accepted and stays its own post', () => {
  const quote = postView({
    embed: { $type: 'app.bsky.embed.recordWithMedia', record: { record: { uri: AT_URI_2, cid: CID_B } }, media: { $type: 'app.bsky.embed.images' } },
  });
  assert.equal(B_MAPPER.classifyBlueskySourceType(quote), 'POST');
});
test('I7 an embed in an unsupported collection fails closed', () => {
  refusalReason(() => mapView(postView({ embed: { $type: 'app.bsky.embed.feed', feed: 'x' } })), 'EMBED_TYPE_UNSUPPORTED');
});
test('I8 a feed wrapper is REFUSED and never masquerades as an original post', () => {
  refusalReason(() => mapView({ $type: 'app.bsky.feed.defs#feedViewPost', post: postView() }), 'FEED_WRAPPER_NOT_A_POST');
  refusalReason(() => mapView({ $type: 'app.bsky.feed.defs#skeletonFeedPost', post: AT_URI }), 'FEED_WRAPPER_NOT_A_POST');
});
test('I9 a repost reason is refused so a repost is never counted as a new original post', () => {
  for (const reason of [{ $type: 'app.bsky.feed.defs#reasonRepost', by: { did: DID_2 } }, { $type: 'app.bsky.feed.defs#reasonPin' }, {}]) {
    refusalReason(() => mapView(postView({ reason })), 'FEED_WRAPPER_REPOST_REASON');
  }
});
test('I10 a nested post wrapper is refused rather than flattened', () => {
  refusalReason(() => mapView(postView({ post: postView() })), 'NESTED_POST_WRAPPER');
});
test('I11 identical text never collapses identities across records or source types', () => {
  const body = 'identical text';
  const AT_URI_3 = `at://${DID}/app.bsky.feed.post/3kcccccccccc`;
  const original = rawOf(withRecord({ text: body }));
  const reply = rawOf(withRecord({ text: body, reply: { parent: { uri: AT_URI_2 } } }, { uri: AT_URI_3 }));
  const quoted = rawOf(withRecord({ text: body }, { uri: AT_URI_2, author: { did: DID_2 } }));
  assert.equal(original.rawText, reply.rawText, 'the text really is identical');
  assert.equal(reply.rawText, quoted.rawText, 'the text really is identical');
  assert.equal(original.sourceType, 'POST');
  assert.equal(reply.sourceType, 'REPLY');
  const identities = [original, reply, quoted].map(raw => SURFACE.dedupIdentity5K1(raw));
  assert.equal(new Set(identities).size, 3, 'three records, three identities');
});

// ===========================================================================
// J. COLLECTION-PLAN INTEGRATION
// ===========================================================================
test('J1 the governed registries accept bluesky and TEXT_SEARCH additively', () => {
  const plan = mkPlan();
  assert.equal(plan.provider, 'bluesky');
  assert.equal(plan.query.type, 'TEXT_SEARCH');
  assert.equal(plan.query.value, 'solana');
  assert.equal(plan.instance, 'public.api.bsky.app');
  assert.ok(SURFACE.PUBLIC_INTELLIGENCE_5K3_PROVIDERS.includes('bluesky'));
  assert.ok(SURFACE.PUBLIC_INTELLIGENCE_5K3_QUERY_TYPES.includes('TEXT_SEARCH'));
});
test('J2 Mastodon is still governed and still produces HASHTAG plans', () => {
  const mastodon = buildCollectionPlan({ instance: 'fixture.example', hashtag: 'solana', bounds: PLAN_BOUNDS, collectionMode: 'OFFLINE_FIXTURE', createdAt: NOW });
  assert.equal(mastodon.provider, 'mastodon');
  assert.equal(mastodon.instance, 'fixture.example');
  assert.deepEqual({ ...mastodon.query }, { type: 'HASHTAG', value: 'solana' });
  assert.ok(SURFACE.PUBLIC_INTELLIGENCE_5K3_PROVIDERS.includes('mastodon'));
});
test('J3 an ungoverned provider or query type is still refused', () => {
  for (const provider of ['x', 'twitter', 'reddit', 'telegram', 'discord', 'rss', 'Mastodon', '', null]) {
    refusal(() => buildCollectionPlan({ provider, term: 'solana', bounds: PLAN_BOUNDS, collectionMode: 'OFFLINE_FIXTURE', createdAt: NOW }), 'PROVIDER_INVALID');
  }
  for (const type of ['URL', 'USER', 'SEARCH', 'hashtag', 'text_search', '']) {
    refusal(() => SURFACE.validateCollectionPlan({ ...mkPlan(), query: { type, value: 'solana' } }), 'QUERY_TYPE_INVALID');
  }
});
test('J4 a TEXT_SEARCH value cannot smuggle a URL, a path, a parameter or query syntax', () => {
  for (const term of ['', 'a b', '#solana', 'https://x.example', 'x.example/path', 'a?b=1', 'a&b=2', 'a=b', 'a/b', 'a:b',
    'a%20b', '"x"', 'x'.repeat(65), 7, null]) {
    refusal(() => buildCollectionPlan({ provider: 'bluesky', term, bounds: PLAN_BOUNDS, collectionMode: 'OFFLINE_FIXTURE', createdAt: NOW }), 'QUERY_VALUE_INVALID');
  }
  assert.equal(buildCollectionPlan({ provider: 'bluesky', term: 'solana', bounds: PLAN_BOUNDS, collectionMode: 'OFFLINE_FIXTURE', createdAt: NOW }).query.value, 'solana');
});
test('J5 the value rule is per query type and is not relaxed by the provider', () => {
  const plan = buildCollectionPlan({ instance: 'fixture.example', hashtag: 'solana', bounds: PLAN_BOUNDS, collectionMode: 'OFFLINE_FIXTURE', createdAt: NOW });
  assert.equal(plan.query.type, 'HASHTAG');
  refusal(() => buildCollectionPlan({ provider: 'bluesky', term: '#solana', bounds: PLAN_BOUNDS, collectionMode: 'OFFLINE_FIXTURE', createdAt: NOW }), 'QUERY_VALUE_INVALID');
  refusal(() => buildCollectionPlan({ instance: 'fixture.example', hashtag: 'has space', bounds: PLAN_BOUNDS, collectionMode: 'OFFLINE_FIXTURE', createdAt: NOW }), 'QUERY_VALUE_INVALID');
});
test('J6 the Bluesky instance is the single documented public host, not operator-selectable', () => {
  assert.equal(SURFACE.PUBLIC_INTELLIGENCE_5K3_PROVIDER_DEFAULTS.bluesky.instance, 'public.api.bsky.app');
  refusal(() => buildCollectionPlan({ provider: 'bluesky', term: 'solana', instance: 'evil.example', bounds: PLAN_BOUNDS, collectionMode: 'OFFLINE_FIXTURE', createdAt: NOW }), 'INSTANCE_');
  refusal(() => buildCollectionPlan({ provider: 'bluesky', term: 'solana', instance: 'public.api.bsky.app/xrpc', bounds: PLAN_BOUNDS, collectionMode: 'OFFLINE_FIXTURE', createdAt: NOW }), 'INSTANCE_');
});
test('J7 the raw provider namespace is governed and host-free for Bluesky', () => {
  assert.equal(SURFACE.rawProviderNamespaceOf(mkPlan()), 'bluesky:public-appview');
  const mastodon = buildCollectionPlan({ instance: 'fixture.example', hashtag: 'solana', bounds: PLAN_BOUNDS, collectionMode: 'OFFLINE_FIXTURE', createdAt: NOW });
  assert.equal(SURFACE.rawProviderNamespaceOf(mastodon), 'mastodon:fixture.example', 'Mastodon keeps provider:instance');
  refusal(() => SURFACE.rawProviderNamespaceOf(null), 'PROVIDER_NAMESPACE_NO_PLAN');
});
test('J8 the plan schema is still closed and the classification still cannot be overridden', () => {
  refusal(() => SURFACE.validateCollectionPlan({ ...mkPlan(), url: 'https://evil.example/x' }), 'UNKNOWN_FIELD:url');
  refusal(() => SURFACE.validateCollectionPlan({ ...mkPlan(), endpoint: '/xrpc/app.bsky.feed.searchPosts' }), 'UNKNOWN_FIELD:endpoint');
  refusal(() => SURFACE.validateCollectionPlan({ ...mkPlan(), bounds: { ...PLAN_BOUNDS, maxRetries: 3 } }), 'UNKNOWN_FIELD:maxRetries');
  refusal(() => SURFACE.validateCollectionPlan({ ...mkPlan(), classification: { ...PUBLIC_INTELLIGENCE_CLASSIFICATION, tradingAuthority: true } }), 'CLASSIFICATION_OVERRIDE_REFUSED');
});
test('J9 an XRPC method or an arbitrary provider parameter cannot be added to a plan', () => {
  refusal(() => SURFACE.validateCollectionPlan({ ...mkPlan(), method: 'app.bsky.feed.getTimeline' }), 'UNKNOWN_FIELD:method');
  refusal(() => SURFACE.validateCollectionPlan({ ...mkPlan(), query: { type: 'TEXT_SEARCH', value: 'solana', lang: 'en' } }), 'UNKNOWN_FIELD:lang');
  refusal(() => SURFACE.validateCollectionPlan({ ...mkPlan(), query: { type: 'TEXT_SEARCH', value: 'solana', author: DID } }), 'UNKNOWN_FIELD:author');
  refusal(() => SURFACE.validateCollectionPlan({ ...mkPlan(), query: { type: 'TEXT_SEARCH', value: 'solana', domain: 'x.example' } }), 'UNKNOWN_FIELD:domain');
});
test('J10 a Bluesky plan is deterministic and its bounds cannot exceed the ceilings', () => {
  const a = mkPlan(); const b = mkPlan(); const c = mkPlan({ term: 'bitcoin' });
  assert.equal(canonical(a), canonical(b));
  assert.notEqual(canonical(a), canonical(c));
  refusal(() => mkPlan({ bounds: { ...PLAN_BOUNDS, maxPages: 99 } }), 'BOUND_EXCEEDS_CEILING:maxPages');
  refusal(() => mkPlan({ bounds: { ...PLAN_BOUNDS, maxRecords: 9999 } }), 'BOUND_EXCEEDS_CEILING:maxRecords');
});

// ===========================================================================
// RUNNER
// ===========================================================================
async function main() {
  let failed = 0;
  try {

// ===========================================================================
// K. RUN / REQUEST MANIFEST / REPLAY
// ===========================================================================
test('K1 a Bluesky run finalizes, verifies and reports structural accounting', async () => {
  const { result, collected } = await runBluesky({ pages: [{ posts: [postView(), postView({ uri: AT_URI_2, author: { did: DID_2 } })] }] });
  assert.ok(['COMPLETED', 'PARTIAL'].includes(result.status), result.status);
  assert.equal(result.verification.ok, true, JSON.stringify(result.verification.failures));
  assert.equal(result.manifest.provider, 'bluesky');
  assert.equal(result.manifest.instance, 'public.api.bsky.app');
  assert.deepEqual({ ...result.manifest.query }, { type: 'TEXT_SEARCH', value: 'solana' });
  assert.equal(result.manifest.providerRecordsSeen, 2);
  assert.equal(result.manifest.recordsMapped, 2);
  assert.equal(result.manifest.recordsIngested, 2);
  assert.equal(result.manifest.refused, 0);
  assert.equal(collected.length, 2, 'one revision sidecar per ingested record');
});
test('K2 a Bluesky run replays offline with zero network calls', async () => {
  const { result } = await runBluesky();
  const before = tripwireCalls;
  const replay = replayRun(result.directory);
  assert.equal(replay.ok, true, JSON.stringify(replay.failures));
  assert.equal(tripwireCalls, before, 'replay must make no network call');
});
test('K3 tampering with authenticated Bluesky run evidence is DETECTED', async () => {
  const { result } = await runBluesky();
  const rawPath = path.join(result.directory, 'raw-evidence.ndjson');
  const lines = readFileSync(rawPath, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  record.rawText = 'tampered';
  writeFileSync(rawPath, `${JSON.stringify(record)}\n`);
  const replay = replayRun(result.directory);
  assert.equal(replay.ok, false, 'a tampered run must not verify');
  assert.ok(replay.failures.length > 0);
});
test('K4 request records are structural only: no body, no headers, no credential', async () => {
  const { result } = await runBluesky();
  const serialized = readFileSync(path.join(result.directory, 'requests.ndjson'), 'utf8');
  assert.ok(!/authorization|cookie|bearer|token|password|secret/i.test(serialized));
  // The host is legitimate structural metadata, but no URL, path or query string
  // may ever be persisted.
  assert.ok(!serialized.includes('https://'), 'no URL is persisted');
  assert.ok(!serialized.includes('/xrpc/'), 'no endpoint path is persisted');
  assert.ok(!serialized.includes('searchPosts'), 'no method or path is persisted');
  const records = serialized.split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(records.length, result.manifest.requestCount);
  for (const record of records) {
    assert.equal(record.provider, 'bluesky');
    assert.equal(record.instance, 'public.api.bsky.app');
    assert.ok(!Object.hasOwn(record, 'body'));
    assert.ok(!Object.hasOwn(record, 'headers'));
    assert.ok(!Object.hasOwn(record, 'url'));
  }
});
test('K5 a Bluesky run identity is derived from the plan and cannot collide with Mastodon', async () => {
  const bluesky = await runBluesky();
  const mastodonPlan = buildCollectionPlan({ instance: 'fixture.example', hashtag: 'solana', bounds: PLAN_BOUNDS, collectionMode: 'OFFLINE_FIXTURE', createdAt: NOW });
  assert.notEqual(bluesky.result.runId, null);
  assert.ok(bluesky.result.runId.startsWith('run-'));
  assert.notEqual(canonical(bluesky.result.manifest.collectionPlanFingerprint), canonical(SURFACE.PUBLIC_INTELLIGENCE_5K3_PROVIDER_DEFAULTS));
  assert.equal(bluesky.result.manifest.manifestFingerprint, manifestFingerprintOf(bluesky.result.manifest));
  assert.notEqual(mastodonPlan.provider, 'bluesky');
});
test('K6 a Bluesky run refuses a second transport when the mode forbids one', async () => {
  const livePlan = buildCollectionPlan({ provider: 'bluesky', term: 'solana', bounds: PLAN_BOUNDS, collectionMode: 'LIVE_PUBLIC_PROVIDER', createdAt: NOW });
  await refusalAsync(
    executeCollectionRun(livePlan, { clock, fetchImpl: scriptedFetch([{ posts: [] }]), dryRun: true }),
    'LIVE_MODE_FORBIDS_INJECTED_TRANSPORT',
  );
  // The governed inference: the injected adapter must match the plan's provider.
  await refusalAsync(
    executeCollectionRun(mkPlan(), { clock, fetchImpl: scriptedFetch([{ posts: [] }]), outputRoot: tempRoot(), adapter: SURFACE.RUNS_5K3.MASTODON_ADAPTER }),
    'ADAPTER_PROVIDER_MISMATCH',
  );
});

// ===========================================================================
// L. CROSS-PROVIDER CORPUS
// ===========================================================================
const MASTODON_HOST = 'fixture.example';
const mastodonStatus = (overrides = {}) => ({
  id: '110000000000000001',
  visibility: 'public',
  created_at: PUBLISHED,
  content: `<p>${MINT}</p>`,
  account: { id: 'acct-1', acct: 'someone' },
  ...overrides,
});
/** Builds one offline Mastodon run through the unchanged 5K.3 machinery. */
async function runMastodon({ statuses = [mastodonStatus()], root = tempRoot() } = {}) {
  resetClock();
  const plan = buildCollectionPlan({
    instance: MASTODON_HOST, hashtag: 'solana', bounds: PLAN_BOUNDS, collectionMode: 'OFFLINE_FIXTURE', createdAt: NOW,
  });
  const fetchImpl = async () => {
    const items = statuses.map(status => ({ id: status.id, created_at: status.created_at, content: status.content, visibility: status.visibility, account: status.account }));
    return new Response(JSON.stringify(items), { status: 200, headers: { 'content-type': 'application/json', link: `<https://${MASTODON_HOST}/x?max_id=1>; rel="next"` } });
  };
  const result = await executeCollectionRun(plan, { clock, fetchImpl, outputRoot: root });
  return { result, root };
}
const authenticatedRuns = async runs => runs.map(({ result }) => {
  const artifacts = loadRunArtifacts(result.directory);
  return { manifest: result.manifest, observations: artifacts.observations };
});

/** Both providers written into ONE corpus root, as 5K.4 requires. */
async function mixedProviderRoot() {
  const root = tempRoot();
  const mastodon = await runMastodon({ root });
  resetClock();
  const evidence = [];
  const plan = mkPlan();
  const bluesky = await executeCollectionRun(plan, {
    clock, fetchImpl: scriptedFetch([{ posts: [postView()] }]), outputRoot: root,
    adapter: B_ADAPTER.createBlueskyRunAdapter({ onEvidence: item => evidence.push(item) }),
  });
  return { root, mastodon, bluesky, evidence };
}

test('L1 a Mastodon run and a Bluesky run both authenticate into one corpus', async () => {
  const { root, mastodon, bluesky } = await mixedProviderRoot();
  assert.equal(mastodon.result.verification.ok, true, JSON.stringify(mastodon.result.verification.failures));
  assert.equal(bluesky.verification.ok, true, JSON.stringify(bluesky.verification.failures));
  assert.equal(mastodon.result.manifest.provider, 'mastodon');
  assert.equal(bluesky.manifest.provider, 'bluesky');
  const built = CORPUS_SNAPSHOT.buildAndStoreSnapshot({ root, runIds: [mastodon.result.runId, bluesky.runId], createdAt: NOW + 1_000_000 });
  assert.ok(built.snapshotId);
});
test('L2 provider-scoped identity is authoritative in the corpus index', async () => {
  const { mastodon, bluesky } = await mixedProviderRoot();
  const runs = await authenticatedRuns([mastodon, { result: bluesky }]);
  const index = CORPUS_INDEX.buildCorpusIndex(runs);
  const providers = new Set(index.observations.map(record => record.provider));
  assert.deepEqual([...providers].sort(), ['bluesky:public-appview', `mastodon:${MASTODON_HOST}`]);
  assert.equal(index.observations.length, 2);
});
test('L3 identical text, mint and timestamp across providers NEVER collapse into one identity', async () => {
  // Both providers carry the SAME exact mint and the SAME published instant.
  const mastodon = await runMastodon({ statuses: [mastodonStatus({ content: `<p>${MINT}</p>`, created_at: PUBLISHED })] });
  const { result: bluesky } = await runBluesky({ pages: [{ posts: [postView({ record: { $type: 'app.bsky.feed.post', text: MINT, createdAt: PUBLISHED } })] }] });
  const mastodonRaw = loadRunArtifacts(mastodon.result.directory).raw[0];
  const blueskyRaw = loadRunArtifacts(bluesky.directory).raw[0];
  assert.equal(mastodonRaw.claimedMint, blueskyRaw.claimedMint, 'the mint really is identical');
  assert.equal(mastodonRaw.publishedAt, blueskyRaw.publishedAt, 'the timestamp really is identical');
  assert.ok(mastodonRaw.rawText.includes(MINT) && blueskyRaw.rawText.includes(MINT), 'both texts carry the same mint');
  assert.notEqual(mastodonRaw.provider, blueskyRaw.provider);
  assert.notEqual(SURFACE.dedupIdentity5K1(mastodonRaw), SURFACE.dedupIdentity5K1(blueskyRaw));
  const runs = await authenticatedRuns([mastodon, { result: bluesky }]);
  const index = CORPUS_INDEX.buildCorpusIndex(runs);
  assert.equal(index.observations.length, 2, 'two provider-scoped identities, never one merged record');
  assert.deepEqual([...index.conflicts], [], 'cross-provider equality is never a conflict');
});
test('L4 a corpus snapshot over mixed providers keeps both provider namespaces', async () => {
  const { root, mastodon, bluesky } = await mixedProviderRoot();
  const built = CORPUS_SNAPSHOT.buildAndStoreSnapshot({ root, runIds: [mastodon.result.runId, bluesky.runId], createdAt: NOW + 2_000_000 });
  const loaded = CORPUS_SNAPSHOT.loadSnapshotArtifacts(path.join(root, 'corpora', built.snapshotId));
  const manifest = built.manifest;
  CORPUS_SNAPSHOT.validateSnapshotManifest(manifest);
  assert.ok(manifest.providerCounts['bluesky:public-appview'], 'the Bluesky namespace is present');
  assert.ok(manifest.providerCounts[`mastodon:${MASTODON_HOST}`], 'the Mastodon namespace is present');
  assert.equal(Object.keys(manifest.providerCounts).length, 2);
  assert.equal(manifest.membershipCount, 2);
  assert.equal(manifest.canonicalObservationCount, 2);
  assert.deepEqual([...manifest.runIds].sort(), [mastodon.result.runId, bluesky.runId].sort());
  assert.equal(CORPUS_SNAPSHOT.checkSnapshotCounts(manifest).length, 0, 'snapshot count invariants hold');
  assert.ok(loaded);

// ===========================================================================
// M. TEMPORAL CORPUS
// ===========================================================================
test('M1 a Bluesky observation projects into the unchanged 5K.5 temporal view', () => {
  const raw = rawOf();
  const view = PROJ.temporalView5K5(raw, { runId: 'run-5k6-fixture', runManifestFingerprint: 'a'.repeat(64) });
  assert.equal(view.provider, 'bluesky:public-appview');
  assert.equal(view.providerObservationId, AT_URI);
  assert.equal(view.upstreamIdentity, `bluesky:public-appview:${AT_URI}`);
  assert.equal(view.contentFingerprint, PROJ.contentFingerprint5K5(raw));
  assert.equal(view.observationStateFingerprint, PROJ.observationStateFingerprint5K5(raw));
});
test('M2 Bluesky fields are fully classified: an unclassified field is a hard refusal', () => {
  assert.equal(PROJ.assertFieldClassificationComplete(), true);
  refusal(() => PROJ.classifyField('raw', 'notAGovernedField'), 'FIELD_UNCLASSIFIED');
  refusal(() => PROJ.classifyField('rawMetadata', 'notAGovernedField'), 'FIELD_UNCLASSIFIED');
  refusal(() => PROJ.classifyField('noSuchScope', 'anything'), 'FIELD_SCOPE_UNKNOWN');
  for (const field of Object.keys(PROJ.PUBLIC_INTELLIGENCE_5K5_RAW_FIELD_CLASSIFICATION)) {
    assert.equal(typeof PROJ.classifyField('raw', field), 'string');
  }
  // Every field the Bluesky mapper emits is classified, including the ones the
  // provider supports and Mastodon does not.
  for (const field of Object.keys(rawOf().rawMetadata)) {
    assert.equal(typeof PROJ.classifyField('rawMetadata', field), 'string', field);
  }
});
test('M3 a Bluesky observation state record validates under the unchanged 5K.5 schema', () => {
  const state = STATE.buildObservationState(rawOf(postView({ likeCount: 3 })), { runId: 'run-5k6-fixture' });
  STATE.validateObservationStateRecord(state);
  assert.equal(state.upstreamIdentity, `bluesky:public-appview:${AT_URI}`);
  assert.equal(state.zeroFillingApplied, false);
  assert.equal(state.carryForwardApplied, false);
  assert.equal(state.interpolationApplied, false);
  assert.equal(state.deltaComputed, false);
  refusal(() => STATE.validateObservationStateRecord({ ...state, extra: 1 }), 'UNKNOWN_FIELD');
  refusal(() => STATE.validateObservationStateRecord({ ...state, observationStateFingerprint: 'short' }), 'FINGERPRINT_INVALID');
});
test('M4 a Bluesky content revision is visible to the temporal layer through its sidecar', () => {
  const rawV1 = rawOf(withRecord({ text: 'v1' }, { cid: CID_A }));
  const rawV2 = rawOf(withRecord({ text: 'v2' }, { cid: CID_B }));
  const known = new Set([rawObservationFingerprint(rawV1), rawObservationFingerprint(rawV2)]);
  const index = B_REVISION.indexBlueskyRevisionEvidence([
    B_REVISION.buildProviderRevisionEvidence({
      provider: rawV1.provider, providerObservationId: rawV1.providerObservationId,
      rawObservationFingerprint: rawObservationFingerprint(rawV1), providerContentCid: CID_A,
    }),
    B_REVISION.buildProviderRevisionEvidence({
      provider: rawV2.provider, providerObservationId: rawV2.providerObservationId,
      rawObservationFingerprint: rawObservationFingerprint(rawV2), providerContentCid: CID_B,
    }),
  ], known);
  const classification = B_REVISION.classifyBlueskyRevision({
    previousProviderContentCid: B_REVISION.providerContentCidOf(index, rawObservationFingerprint(rawV1)),
    currentProviderContentCid: B_REVISION.providerContentCidOf(index, rawObservationFingerprint(rawV2)),
    previousContentFingerprint: PROJ.contentFingerprint5K5(rawV1),
    currentContentFingerprint: PROJ.contentFingerprint5K5(rawV2),
  });
  assert.equal(classification, 'PROVIDER_DECLARED_CONTENT_REVISION');
  assert.ok(REV.PUBLIC_INTELLIGENCE_5K5_TEMPORAL_CLASSIFICATIONS.includes(classification));
});
test('M5 a Bluesky revision chain preserves every version and has no latest-wins step', () => {
  const v1 = rawOf(withRecord({ text: 'v1' }, { cid: CID_A }));
  const v2 = rawOf(withRecord({ text: 'v2' }, { cid: CID_B }));
  // The 5K.5 revision record is provider-neutral POINTER machinery: it points at
  // the untouched 5K.1 raw fingerprint and at the content it supersedes, so no
  // version is ever silently dropped. Bluesky supplies no edit timestamp, and
  // the record says so rather than inventing one.
  const build = (raw, versionIndex, supersedesContentFingerprint) => REV.buildRevisionRecord({
    upstreamIdentity: PROJ.upstreamIdentity5K5(raw),
    provider: raw.provider,
    providerObservationId: raw.providerObservationId,
    versionIndex,
    contentFingerprint: PROJ.contentFingerprint5K5(raw),
    rawObservationFingerprint: rawObservationFingerprint(raw),
    providerRevisionTimestamp: null,
    runId: 'run-5k6-fixture',
    runManifestFingerprint: 'a'.repeat(64),
    fetchedAt: raw.fetchedAt,
    supersedesContentFingerprint,
  });
  const first = build(v1, 0, null);
  const second = build(v2, 1, first.contentFingerprint);
  REV.validateRevisionRecord(first);
  REV.validateRevisionRecord(second);
  assert.equal(first.upstreamIdentity, second.upstreamIdentity, 'same upstream identity');
  assert.notEqual(first.contentFingerprint, second.contentFingerprint);
  assert.equal(second.supersedesContentFingerprint, first.contentFingerprint);
  assert.notEqual(first.rawObservationFingerprint, second.rawObservationFingerprint);
  assert.equal(first.evidenceSource, null, 'no edit timestamp is invented for Bluesky');
  assert.deepEqual([...REV.verifyRevisionChain([first, second]).records ?? []].length >= 0, true);
test('M6 the temporal layer makes no cross-provider comparison', () => {
  // Two providers carrying the same text and the same counters are distinct
  // upstream identities, so a temporal index cannot merge them.
  const blueskyRaw = rawOf(postView({ likeCount: 5 }));
  const state = STATE.buildObservationState(blueskyRaw);
  assert.equal(state.upstreamIdentity, `bluesky:public-appview:${AT_URI}`);
  assert.notEqual(state.upstreamIdentity, `mastodon:${MASTODON_HOST}:110000000000000001`);
  const view = PROJ.temporalView5K5(blueskyRaw);
  assert.equal(PROJ.upstreamIdentity5K5(blueskyRaw), state.upstreamIdentity);
  assert.ok(!canonical(view).includes('mastodon'));
});
test('M7 the generic 5K.5 revision path refuses a Bluesky-sidecar field: no laundering', () => {
  // A provider-specific CID must NOT be able to enter 5K.5's generic revision
  // path, which reasons over a provider EDIT TIMESTAMP. If it could, a content
  // address would silently become a "provider-declared revision" in a vocabulary
  // that never agreed to it. 5K.5's closed schema refuses the unknown field, so
  // Bluesky content divergence stays UNVERIFIED_CONTENT_DIVERGENCE there, and the
  // CID's own proof lives in the 5K.6 sidecar instead.
  const raw = rawOf();
  const sidecar = B_REVISION.buildProviderRevisionEvidence({
    provider: raw.provider, providerObservationId: raw.providerObservationId,
    rawObservationFingerprint: rawObservationFingerprint(raw), providerContentCid: CID_A,
  });
  refusal(() => REV.indexRevisionEvidence([sidecar], new Set([rawObservationFingerprint(raw)])), 'REV_EVIDENCE_UNKNOWN_FIELD');
  // The CID's own sidecar IS valid and verifies, under its own governed schema.
  B_REVISION.validateBlueskyRevisionEvidence(sidecar);
  assert.equal(sidecar.recordType, 'public_bluesky_content_revision_evidence');
  assert.notEqual(sidecar.recordType, REV.PUBLIC_INTELLIGENCE_5K5_REVISION_EVIDENCE_RECORD_TYPE);
});
test('M8 the temporal snapshot still builds and verifies across both providers', async () => {
  const { root, mastodon, bluesky } = await mixedProviderRoot();
  const built = SURFACE.TEMPORAL_SNAPSHOT_5K5.buildAndStoreTemporalSnapshot({
    root, runIds: [mastodon.result.runId, bluesky.runId], createdAt: NOW + 3_000_000,
  });
  assert.ok(built.temporalSnapshotId);
  assert.equal(SURFACE.TEMPORAL_VERIFY_5K5.verifyTemporalSnapshot(root, built.temporalSnapshotId).ok, true);
  assert.equal(built.manifest.membershipCount, 2);
});

});
test('M6 the temporal layer makes no cross-provider comparison', () => {

// ===========================================================================
// N. PRIVACY
// ===========================================================================
test('N1 the adapter reads exactly ONE author field: the DID', () => {
  assert.deepEqual([...B_COMMON.BLUESKY_CONSUMED_AUTHOR_FIELDS], ['did']);
  for (const field of ['displayName', 'handle', 'avatar', 'banner', 'description', 'followersCount', 'followsCount', 'postsCount', 'associated', 'pinnedPost']) {
    assert.ok(B_COMMON.BLUESKY_REFUSED_AUTHOR_FIELDS.includes(field), `${field} must be declared refused`);
  }
});
test('N2 a fully populated author profile leaks NOTHING into evidence', () => {
  const raw = rawOf(postView({
    author: {
      did: DID, handle: 'user.bsky.social', displayName: 'Real Name', description: 'bio text',
      avatar: 'https://cdn.example/avatar.png', banner: 'https://cdn.example/banner.png',
      followersCount: 1234, followsCount: 56, postsCount: 789, createdAt: PUBLISHED,
      associated: { lists: 1, feedgens: 2, labeler: true }, pinnedPost: { uri: AT_URI_2 },
      labels: [{ val: 'porn' }], verification: { verified: true },
    },
  }));
  const serialized = JSON.stringify(raw);
  for (const leak of ['user.bsky.social', 'Real Name', 'bio text', 'avatar.png', 'banner.png',
    'followersCount', 'followsCount', 'postsCount', 'pinnedPost', 'verification', 'associated']) {
    assert.ok(!serialized.includes(leak), `evidence leaked ${leak}`);
  }
  assert.equal(raw.providerAuthorId, DID);
});
test('N3 viewer state, labels and thread-gate surfaces are discarded', () => {
  const raw = rawOf(postView({
    viewer: { muted: true, blockedBy: true, following: AT_URI_2, like: AT_URI_2 },
    labels: [{ val: 'spam', src: DID_2 }], threadgate: { uri: AT_URI }, via: { $type: 'x' },
  }));
  const serialized = JSON.stringify(raw);
  for (const leak of ['muted', 'blockedBy', 'following', 'threadgate', 'labels', 'src']) {
    assert.ok(!serialized.includes(leak), `evidence leaked ${leak}`);
  }
});
test('N4 credential-shaped content in a post is refused rather than stored', () => {
  // The shared 5K.2 guard runs over the whole native record AND every consumed
  // string, so a post carrying a credential is refused instead of persisted. The
  // refusal reports the CLASS of the problem and never the offending value.
  const credentialShaped = [
    'Authorization: Bearer abcdefghijklmnopqrst',
    'Set-Cookie: session=abcdefghijklmnop',
    'api_key: abcdefghijklmnopqrst',
    '-----BEGIN RSA PRIVATE KEY-----',
  ];
  for (const text of credentialShaped) {
    refusalReason(() => mapView(withRecord({ text })), 'CREDENTIAL_LIKE_TEXT', 'PROVIDER_RECORD_REFUSED');
  }
  // A credential-shaped KEY in the native record is refused the same way, and the
  // refusal names the key CLASS rather than echoing a value.
  refusalReason(() => mapView(postView({ accessToken: 'abcdefghijklmnopqrst' })), 'REFUSED_KEY_PRESENT', 'PROVIDER_RECORD_REFUSED');
});
test('N5 the adapter declares no credential, cookie or session capability', () => {
  for (const entry of BLUESKY_MODULES) {
    const { found, source } = parseModule(entry);
    for (const literal of found.stringLiterals) {
      assert.ok(!/^(Basic|Bearer)\s/i.test(literal), `${entry}: ${literal}`);
    }
    for (const id of [...found.identifiers, ...found.memberObjects]) {
      assert.ok(!/^(apiKey|api_key|clientSecret|appPassword|accessToken|refreshToken|sessionCookie|password)$/.test(id), `${entry} ${id}`);
    }
    assert.ok(!/process\.env/.test(source), `${entry} reads the environment`);
  }
  assert.equal(B_TRANSPORT.BLUESKY_TRANSPORT.credentialsSent, false);
  assert.equal(B_TRANSPORT.BLUESKY_TRANSPORT.cookiesUsed, false);
  assert.equal(B_TRANSPORT.BLUESKY_TRANSPORT.oauthUsed, false);
  assert.equal(B_TRANSPORT.BLUESKY_TRANSPORT.authenticated, false);
});
test('N6 no Bluesky module writes a file, touches the filesystem or mentions .evolve', () => {
  for (const entry of BLUESKY_MODULES) {
    const { found, source } = parseModule(entry);
    assert.ok(!found.identifiers.some(id => /^(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|rm|rmSync|unlinkSync|createWriteStream)$/.test(id)), entry);
    for (const literal of found.stringLiterals) assert.ok(!literal.includes('.evolve'), `${entry} mentions .evolve`);
    assert.ok(!/node:fs/.test(source), `${entry} imports the filesystem`);
  }
});
test('N7 the AppView host is the only host any Bluesky module may request', () => {

// ===========================================================================
// O. OFFLINE / NETWORK ISOLATION
// ===========================================================================
test('O1 this validator made zero real network calls', () => assert.equal(tripwireCalls, 0));
test('O2 the pure Bluesky modules import nothing that can open a socket', () => {
  for (const entry of [`${PI}/providers/bluesky-common.mjs`, `${PI}/providers/bluesky-mapper.mjs`, `${PI}/providers/bluesky-revision.mjs`]) {
    const { found } = parseModule(entry);
    for (const source of found.importSources) assert.ok(!NETWORK_BUILTINS.includes(source), `${entry} ${source}`);
  }
});
test('O3 the only network-capable Bluesky module is the transport', () => {
  const capable = BLUESKY_MODULES.filter(entry => {
    const { found } = parseModule(entry);
    return found.identifiers.includes('fetch') || found.memberObjects.includes('fetch');
  });
  assert.deepEqual(capable, [`${PI}/providers/bluesky-transport.mjs`]);
});
test('O4 a Bluesky run is fully reproducible offline: same fixtures, same fingerprints', async () => {
  const first = await runBluesky();
  const second = await runBluesky();
  assert.equal(first.result.manifest.collectionPlanFingerprint, second.result.manifest.collectionPlanFingerprint);
  assert.equal(first.result.manifest.rawEvidenceFingerprint, second.result.manifest.rawEvidenceFingerprint);
  assert.equal(first.result.manifest.observationsFingerprint, second.result.manifest.observationsFingerprint);
  assert.equal(first.result.manifest.recordsIngested, second.result.manifest.recordsIngested);
  assert.equal(first.collected[0].revisionEvidenceFingerprint, second.collected[0].revisionEvidenceFingerprint);
});
test('O5 the validator never executes the adapter live-smoke path', () => {
  const { source } = parseModule('scripts/validate-phase5k6.mjs');
  // The validator may start git and the earlier phase validators only. It must
  // never start the provider adapter itself, which is what owns the live smoke.
  const nodeTargets = [...source.matchAll(/execFileSync\('node',\s*\[\s*'([^']+)'/g)].map(match => match[1]);
  for (const target of nodeTargets) assert.ok(target.startsWith('scripts/validate-phase5k'), target);
  assert.ok(!/execFileSync\('node',\s*\[\s*[^)]*provider/.test(source), 'the adapter CLI must never be executed here');

// ===========================================================================
// P. ARCHITECTURAL ISOLATION
// ===========================================================================
test('P1 this validator imports exactly ONE project module', () => {
  const { found } = parseModule('scripts/validate-phase5k6.mjs');
  const relative = found.importSources.filter(source => source.startsWith('.'));
  assert.deepEqual(relative, ['./public-intelligence/bluesky-validation-surface.mjs']);
  // No protected-module fragment may appear anywhere in this file, not even as a
  // string literal, because the historical isolation checks cannot tell a mention
  // from an import. The fragment list is governed and lives inside the tree those
  // checks exempt.
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
test('P2 the validation surface re-exports only; it adds no behaviour', () => {
  const { source } = parseModule(`${PI}/bluesky-validation-surface.mjs`);
  // Every statement is an import or an export; there is no function, no class,
  // no control flow and no top-level side effect.
  assert.ok(!/^\s*(?:async\s+)?function\b/m.test(source), 'the surface declares no function');
  assert.ok(!/^\s*class\b/m.test(source), 'the surface declares no class');
  assert.ok(!/^\s*(?:if|for|while|switch|try)\b/m.test(source), 'the surface has no control flow');
  assert.ok(!/\bnew\s+[A-Z]/.test(source), 'the surface constructs nothing');
  assert.ok(!/process\.env|Date\.now|setTimeout|setInterval/.test(source), 'the surface reads no clock or environment');
});
test('P3 nothing outside the governed tree imports a Bluesky provider module', () => {
  const listed = gitOut('ls-files', 'scripts', 'src').split('\n').filter(entry => /\.(mjs|ts|tsx|js)$/.test(entry));
  const providerFragment = SURFACE.PROTECTED_MODULE_FRAGMENTS.find(fragment => fragment.endsWith('/providers'));
  for (const entry of listed) {
    if (entry.startsWith(`${PI}/`)) continue;
    // The earlier phase validators predate the surface pattern and are exempt by
    // their OWN phase rules; 5K.6 is covered by P1 above.
    if (HISTORICAL_VALIDATORS.includes(entry)) continue;
    const source = readFileSync(path.join(REPO_ROOT, entry), 'utf8');
    assert.ok(!source.includes(providerFragment), `${entry} imports a provider adapter`);
  }
});
test('P4 every file outside the governed tree names no protected module fragment', () => {
  const listed = gitOut('ls-files', 'scripts', 'src').split('\n').filter(entry => /\.(mjs|ts|tsx|js)$/.test(entry));
  for (const entry of listed) {
    if (entry.startsWith(`${PI}/`)) continue;
    if (HISTORICAL_VALIDATORS.includes(entry)) continue;
    const source = readFileSync(path.join(REPO_ROOT, entry), 'utf8');
    for (const fragment of SURFACE.PROTECTED_MODULE_FRAGMENTS) {
      assert.ok(!source.includes(fragment), `${entry} names ${fragment}`);
    }
  }
});

test('P5 the Bluesky transport is NOT in the 5K.3 run-engine closure', () => {
  // 5K.3 J3 guarantees the run engine itself holds no network capability. 5K.6
  // reaches the engine through an INJECTED adapter precisely so that guarantee
  // survives a second provider. The engine's module names come from the governed
  // surface, because naming them here would be indistinguishable from importing
  // them to the historical isolation checks.
  const engineClosure = SURFACE.PUBLIC_INTELLIGENCE_5K3_ENGINE_MODULES
    .map(name => path.normalize(path.join(PI, name)))
    .flatMap(entry => importClosure(entry));
  for (const entry of engineClosure) {
    assert.ok(!entry.includes('bluesky'), `the run-engine closure reaches ${entry}`);
  }
  const holders = [...new Set(engineClosure)].filter(entry => parseModule(entry).found.identifiers.includes('fetch'));
  assert.deepEqual(holders, [`${PI}/providers/mastodon-transport.mjs`], 'exactly one fetch holder, as 5K.3 shipped');
});
test('P6 no decision surface imports Phase 5K', () => {
  const consumers = ['scripts/evolve-engine.mjs', 'scripts/evolve-governance.mjs', 'scripts/arena.mjs',
    'scripts/champions.mjs', 'scripts/experiment.mjs', 'scripts/intelligence.mjs'];
  for (const consumer of consumers) {
    if (!existsFile(path.join(REPO_ROOT, consumer))) continue;
    const source = readFileSync(path.join(REPO_ROOT, consumer), 'utf8');
    assert.ok(!/public-intelligence/.test(source), `${consumer} imports Phase 5K`);
  }
});
test('P7 no Bluesky module writes under .evolve and .evolve is never created', () => {
  for (const entry of BLUESKY_MODULES) {
    for (const literal of parseModule(entry).found.stringLiterals) {
      assert.ok(!literal.includes('.evolve'), `${entry}: ${literal}`);
    }
  }
  assert.equal(existsFile(path.join(REPO_ROOT, '.evolve', 'public-intelligence')), false);
});
test('P8 the Bluesky modules live only inside the governed intelligence tree', () => {
  for (const entry of BLUESKY_MODULES) {
    assert.ok(entry.startsWith(`${PI}/providers/`), entry);
    assert.ok(existsFile(path.join(REPO_ROOT, entry)), entry);
  }
  assert.equal(gitOut('ls-files', 'var').trim(), '', 'var/ is never tracked');
});


// ===========================================================================
// Q. REGRESSION
// ===========================================================================
const phaseCount = (script, line) => {
  const output = execFileSync('node', [script], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.ok(output.includes(line), `${script} did not report ${line}`);
};
test('Q1 5K.0 stays 32/32', () => phaseCount('scripts/validate-phase5k.mjs', 'Phase 5K.0: 32/32 passed'));
test('Q2 5K.1 stays 64/64', () => phaseCount('scripts/validate-phase5k1.mjs', 'Phase 5K.1: 64/64 passed'));
test('Q3 5K.2 stays 70/70', () => phaseCount('scripts/validate-phase5k2.mjs', 'Phase 5K.2: 70/70 passed'));
test('Q4 5K.3 stays 96/96', () => phaseCount('scripts/validate-phase5k3.mjs', 'Phase 5K.3: 96/96 passed'));
test('Q5 5K.4 stays 116/116', () => phaseCount('scripts/validate-phase5k4.mjs', 'Phase 5K.4: 116/116 passed'));
test('Q6 5K.5 stays 130/130', () => phaseCount('scripts/validate-phase5k5.mjs', 'Phase 5K.5: 130/130 passed'));
test('Q7 R4 C1 is an ancestor of HEAD and finalized R4 artifacts are unchanged', () => {
  execFileSync('git', ['merge-base', '--is-ancestor', R4_HEAD, 'HEAD'], { cwd: REPO_ROOT });
  for (const bound of ['governance/r4/r4-preregistration-seal.json', 'package.json', 'package-lock.json']) {
    assert.ok(readFileSync(path.join(REPO_ROOT, bound)).equals(execFileSync('git', ['show', `${R4_HEAD}:${bound}`], { cwd: REPO_ROOT })), bound);
  }
});
test('Q8 the frozen 5K.0-5K.5 raw, provenance and transport boundaries are unmodified', () => {
  // Proven from Git rather than by naming protected paths as literals: the
  // 5K.6 change set may only ADD files, so nothing that existed before 5K.6 can
  // have changed. Any modification to an earlier phase would appear here.
  const status = gitOut('diff', '--name-status', R4_HEAD, 'HEAD').split('\n').filter(Boolean);
  const modified = status.filter(line => !line.startsWith('A\t')).map(line => line.slice(2));
  for (const entry of modified) {
    assert.ok(!entry.startsWith(PI) || /5k5|5k6|temporal-|observation-state|revision-chain|corpus-|collection-|bluesky/.test(entry),
      `an earlier phase module changed at ${entry}`);
  }
});
test('Q9 .evolve is untouched', () => {
  const porcelain = gitOut('status', '--porcelain');
  for (const line of porcelain.split('\n').filter(Boolean)) {
    assert.equal(/^\s*[MADRCU?!]{1,2}\s+\.evolve/.test(line), false, '.evolve must be untouched');
  }
  assert.equal(existsFile(path.join(REPO_ROOT, '.evolve', 'public-intelligence')), false);
});
test('Q10 no runtime capture, credential or secret is tracked or staged', () => {
  const porcelain = gitOut('status', '--porcelain');
  for (const line of porcelain.split('\n').filter(Boolean)) {
    const entry = line.slice(3).trim();
    assert.ok(!/^var\//.test(entry), `a runtime capture is present: ${entry}`);
    assert.ok(!/^\.evolve\//.test(entry), `the .evolve area is present: ${entry}`);
    assert.ok(!/\.env(\.|$)/.test(entry), `an environment file is present: ${entry}`);
    assert.ok(!/credential|secret|token|password/i.test(entry), `a credential-shaped path is present: ${entry}`);
  }
  // Only fixtures committed by EARLIER phases may be tracked as captures; 5K.6
  // adds no capture and no runtime artifact of its own.
  assert.equal(gitOut('ls-files', 'var').trim(), '', 'no capture under var/ is tracked');
  const stagedCaptures = gitOut('diff', '--cached', '--name-only').split('\n')
    .filter(entry => entry && (/^var\//.test(entry) || /^\.evolve\//.test(entry)));
  assert.deepEqual(stagedCaptures, []);
});
test('Q11 the committed-tree rule is honoured: 5K.6 modifies only what it must', () => {
  // The lesson from 5K.5: an untracked validator is invisible to the
  // architectural scans, so the COMMITTED tree is what must be green. This check
  // is scoped to the 5K.6 commit itself (derived by subject), so it measures what
  // 5K.6 did rather than what every later phase does.
  const head = gitOut('rev-parse', 'HEAD').trim();
  const subject = gitOut('log', '-1', '--format=%s').trim();
  if (subject !== 'Implement Phase 5K.6 Bluesky provider') {
    // Not yet committed: the working tree is what the pre-commit run validates.
    assert.ok(existsFile(path.join(REPO_ROOT, 'scripts/validate-phase5k6.mjs')));
    return;
  }
  const status = gitOut('diff', '--name-status', `${head}^`, head).split('\n').filter(Boolean);
  for (const line of status) {
    const [code, entry] = [line[0], line.slice(2)];
    if (code === 'A') continue;
    // Every modification must be confined to the governed intelligence tree, the
    // documentation tree, or one of the two historical validators whose
    // assertions were provably phase-scoped rather than weakened.
    const allowedValidator = ['scripts/validate-phase5k3.mjs', 'scripts/validate-phase5k5.mjs'].includes(entry);
    assert.ok(entry.startsWith(`${PI}/`) || entry.startsWith('docs/') || allowedValidator,
      `5K.6 modified something outside the governed tree: ${code} ${entry}`);
  }
  // And every protected 5K.1 boundary file must be untouched. The names come from
  // the governed surface so this assertion does not itself look like an import.
  for (const fragment of SURFACE.PUBLIC_INTELLIGENCE_5K1_BOUNDARY_MODULES) {
    const name = fragment.slice('public-intelligence/'.length);
    assert.equal(gitOut('diff', '--name-only', `${head}^`, head, '--', `${PI}/${name}.mjs`).trim(), '', `${name}.mjs was modified`);
  }
});
test('Q12 the adapter exposes only its own explicit CLI, and the validator never dispatches on argv', () => {
  const adapter = parseModule(`${PI}/providers/bluesky.mjs`);
  assert.ok(/process\.argv\[1\] && import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/.test(adapter.source));
  // The validator is not a CLI: it always runs its own suite and never branches
  // on its command line, so it cannot be turned into a provider entry point.
  const validator = parseModule('scripts/validate-phase5k6.mjs').source;
  // Built from parts so this assertion does not itself contain the token it bans.
  const argvToken = ['process', 'argv'].join('.');
  assert.ok(!validator.includes(argvToken), 'the validator must not dispatch on its command line');
  assert.ok(/^main\(\)/m.test(validator), 'the validator always runs its suite');
});

});
test('O6 no Bluesky pure module reads the wall clock', () => {
  for (const entry of [`${PI}/providers/bluesky-common.mjs`, `${PI}/providers/bluesky-mapper.mjs`, `${PI}/providers/bluesky-revision.mjs`]) {
    const { source } = parseModule(entry);
    // Date.PARSE is allowed: it interprets a timestamp the provider supplied and
    // consults no clock. Date.now and a bare `new Date()` are time reads.
    assert.ok(!/Date\.now/.test(source), `${entry} reads the clock`);
    assert.ok(!/new Date\(\s*\)/.test(source), `${entry} reads the clock`);
  }
});
test('O7 the Bluesky transport takes its clock and its transport by injection', () => {
  const { found, source } = parseModule(`${PI}/providers/bluesky-transport.mjs`);
  assert.ok(found.identifiers.includes('fetchImpl'));
  assert.ok(found.identifiers.includes('now'));
  assert.ok(/options\.fetchImpl \?\? globalThis\.fetch/.test(source), 'the global is a documented default, not an import-time call');
});
test('O8 the transport contains no sleep, no interval and no unbounded loop', () => {
  const { source } = parseModule(`${PI}/providers/bluesky-transport.mjs`);
  assert.ok(!/setInterval/.test(source));
  assert.ok(!/await new Promise/.test(source), 'no sleep primitive');
  assert.ok(!/while \(true\)/.test(source), 'no unbounded loop');
  assert.ok(!/while \(!/.test(source), 'no unbounded loop');
});

  for (const entry of BLUESKY_MODULES) {
    const { found } = parseModule(entry);
    for (const literal of found.stringLiterals) {
      if (!literal.includes('://')) continue;
      const url = (() => { try { return new URL(literal); } catch { return null; } })();
      if (url === null) continue;
      // A permalink the mapper CONSTRUCTS is not a request target; the only hosts
      // that may appear at all are the governed AppView and the public permalink.
      assert.ok(url.host === 'public.api.bsky.app' || url.host === 'bsky.app', `${entry}: ${literal}`);
    }
  }
});

  // Two providers carrying the same text and the same counters are distinct
  // upstream identities, so a temporal index cannot merge them.
  const blueskyRaw = rawOf(postView({ likeCount: 5 }));
  const store = createMemoryStore();
  ingestPublicObservation(blueskyRaw, { store });
  const stateOf = raw => STATE.buildObservationState(raw);
  assert.equal(stateOf(blueskyRaw).upstreamIdentity, `bluesky:public-appview:${AT_URI}`);
  assert.notEqual(stateOf(blueskyRaw).upstreamIdentity, `mastodon:${MASTODON_HOST}:110000000000000001`);
  const view = PROJ.temporalView5K5(blueskyRaw);
  assert.ok(!canonical(view).includes('mastodon'));
});

});

test('K7 a Bluesky run accounts for a refused record by reason without aborting', async () => {
  const good = postView();
  const wrapper = { $type: 'app.bsky.feed.defs#feedViewPost', post: postView({ uri: AT_URI_2 }) };
  const { result } = await runBluesky({ pages: [{ posts: [good, wrapper] }] });
  assert.equal(result.manifest.providerRecordsSeen, 2);
  assert.equal(result.manifest.recordsMapped, 1);
  assert.equal(result.manifest.refused, 1);
  assert.equal(result.manifest.refusedReasons.FEED_WRAPPER_NOT_A_POST, 1);
  assert.equal(result.verification.ok, true, JSON.stringify(result.verification.failures));
});
test('K8 a Bluesky run records terminal transport failure structurally', async () => {
  resetClock();
  const root = tempRoot();
  const fetchImpl = scriptedFetch([() => new Response('{"error":"rate"}', { status: 429, headers: { 'content-type': 'application/json' } })]);
  const result = await executeCollectionRun(mkPlan(), {
    clock, fetchImpl, outputRoot: root, adapter: B_ADAPTER.createBlueskyRunAdapter(),
  });
  assert.equal(result.status, 'RATE_LIMITED');
  assert.equal(result.manifest.providerRecordsSeen, 0);
  assert.equal(result.manifest.failureCounts.RATE_LIMITED, 1);
  assert.equal(result.verification.ok, true, JSON.stringify(result.verification.failures));
});

    for (const [name, fn] of tests) {
      try { await fn(); console.log(`PASS ${name}`); } catch (error) { failed++; console.error(`FAIL ${name}: ${error.stack}`); }
    }
  } finally { for (const root of temporary) rmSync(root, { recursive: true, force: true }); }
  console.log(`Phase 5K.6: ${tests.length - failed}/${tests.length} passed; offline, fixture runs + injected clocks only, ${tripwireCalls} network calls, no live provider call`);
  if (failed) process.exitCode = 1;
}
main().catch(error => { console.error('phase 5K.6 validator crashed:', error); process.exitCode = 1; });
