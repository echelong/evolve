#!/usr/bin/env node
// Phase 5K.2 - FIRST LIVE PUBLIC PROVIDER ADAPTER (Mastodon) validator.
//
// COMPLETELY OFFLINE. Every provider response here is an in-memory fixture fed
// to the transport through an injected fetch. The global fetch and the socket
// connect primitive are replaced with tripwires, and the suite asserts that
// neither was ever called. No credential is needed, read or written. Writes go
// only to temporary directories. `.evolve` is never touched.
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, readFileSync, rmSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

// ---- network tripwires: installed BEFORE any adapter code runs -------------
let tripwireCalls = 0;
globalThis.fetch = () => { tripwireCalls += 1; throw new Error('TRIPWIRE: validator attempted a real fetch'); };
net.Socket.prototype.connect = function tripwire() { tripwireCalls += 1; throw new Error('TRIPWIRE: validator attempted a socket connect'); };

const {
  PUBLIC_INTELLIGENCE_CLASSIFICATION, PUBLIC_INTELLIGENCE_ALWAYS_FALSE_FLAGS, PUBLIC_INTELLIGENCE_ALWAYS_TRUE_FLAGS,
} = await import('./public-intelligence/definition.mjs');
const OBS = await import('./public-intelligence/index.mjs');
const {
  PUBLIC_INTELLIGENCE_5K1_RAW_SCHEMA, PUBLIC_INTELLIGENCE_5K1_COLLECTOR_MODES, canonicalizeRawObservation,
  ingestPublicObservation, createMemoryStore, createNdjsonStore, dedupIdentity5K1,
} = OBS;
const COMMON = await import('./public-intelligence/providers/common.mjs');
const MAPPER = await import('./public-intelligence/providers/mastodon-mapper.mjs');
const TRANSPORT = await import('./public-intelligence/providers/mastodon-transport.mjs');
const ADAPTER = await import('./public-intelligence/providers/mastodon.mjs');
const { ProviderAdapterError, PROVIDER_ERROR_CODES: CODES } = COMMON;
const { mapStatusToRawObservation } = MAPPER;
const { fetchHashtagTimeline } = TRANSPORT;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R4_HEAD = '1c30264fb87876eeaf229e25c5cdc5adca429b40';
const PROVIDER_DIR = 'scripts/public-intelligence/providers';
const PROVIDER_FILES = ['common', 'mastodon-mapper', 'mastodon-transport', 'mastodon'].map(name => `${PROVIDER_DIR}/${name}.mjs`);
const require = createRequire(import.meta.url);
const espree = require('espree');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const temporary = [];
const tempRoot = () => { const root = mkdtempSync(path.join(tmpdir(), 'evolve-5k2-')); temporary.push(root); return root; };

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MINT_2 = 'So11111111111111111111111111111111111111112';
const HOST = 'fixture.example';
const FETCHED = 1790000000000;
const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const CTX = Object.freeze({ host: HOST, fetchedAt: FETCHED, collectionRunId: 'run-5k2-fixture', collectorMode: 'OFFLINE_FIXTURE' });

const status = (overrides = {}) => ({
  id: '110000000000000001',
  visibility: 'public',
  created_at: '2026-10-01T10:00:00.000Z',
  url: 'https://fixture.example/@alice/110000000000000001',
  uri: 'https://fixture.example/users/alice/statuses/110000000000000001',
  in_reply_to_id: null,
  reblog: null,
  language: 'en',
  content: `<p>watching <a href="https://x.example/t">$ABC</a> mint ${MINT} &amp; more</p>`,
  tags: [{ name: 'solana', url: 'https://fixture.example/tags/solana' }],
  favourites_count: 3, replies_count: 0, reblogs_count: 1,
  account: { id: '42', acct: 'alice', display_name: 'Alice Real Name', note: '<p>bio</p>', avatar: 'https://fixture.example/a.png', followers_count: 9999 },
  ...overrides,
});

function refusedWith(fn, code, reasonFragment) {
  let thrown = null;
  try { fn(); } catch (error) { thrown = error; }
  assert.ok(thrown instanceof ProviderAdapterError, `expected ProviderAdapterError, got ${thrown?.stack ?? 'nothing'}`);
  assert.equal(thrown.code, code);
  if (reasonFragment) assert.ok(JSON.stringify(thrown.details).includes(reasonFragment), `details lack ${reasonFragment}: ${JSON.stringify(thrown.details)}`);
  return thrown;
}
async function refusedAsync(promise, code) {
  let thrown = null;
  try { await promise; } catch (error) { thrown = error; }
  assert.ok(thrown instanceof ProviderAdapterError, `expected ProviderAdapterError, got ${thrown?.stack ?? 'nothing'}`);
  assert.equal(thrown.code, code);
  return thrown;
}

const jsonResponse = (body, init = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, ...init });

/** A scripted fake fetch; records every request it receives. */
function fakeFetch(responder) {
  const calls = [];
  const impl = async (url, init) => { calls.push({ url, init }); return responder(url, init, calls.length); };
  impl.calls = calls;
  return impl;
}
const run = (fetchImpl, bounds = {}, extra = {}) => fetchHashtagTimeline({
  host: HOST, hashtag: 'solana', bounds, fetchImpl, now: () => NOW, ...extra,
});
const pageOf = (start, count) => Array.from({ length: count }, (_, i) =>
  status({ id: String(start - i), url: `https://fixture.example/@a/${start - i}` }));

// ---- AST helpers -----------------------------------------------------------
function parseModule(relative) {
  const source = readFileSync(path.join(REPO_ROOT, relative), 'utf8');
  const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const found = { identifiers: [], stringLiterals: [], importSources: [], dynamicImports: [], memberObjects: [] };
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === 'Identifier') found.identifiers.push(node.name);
    if (node.type === 'Literal' && typeof node.value === 'string') found.stringLiterals.push(node.value);
    if (node.type === 'ImportDeclaration' && node.source?.value) found.importSources.push(node.source.value);
    if (node.type === 'ExportAllDeclaration' && node.source?.value) found.importSources.push(node.source.value);
    if (node.type === 'ExportNamedDeclaration' && node.source?.value) found.importSources.push(node.source.value);
    if (node.type === 'ImportExpression' && node.source?.value) found.dynamicImports.push(node.source.value);
    if (node.type === 'MemberExpression' && node.object?.type === 'Identifier') found.memberObjects.push(node.object.name);
    for (const value of Object.values(node)) if (value && typeof value === 'object') walk(value);
  };
  walk(ast);
  return { source, found };
}
const existsSafe = candidate => { try { return statSync(candidate).isFile(); } catch { return false; } };
function importClosure(entry) {
  const seen = new Set(); const queue = [entry];
  while (queue.length) {
    const current = queue.shift();
    if (seen.has(current) || !existsSafe(path.join(REPO_ROOT, current))) continue;
    seen.add(current);
    const { found } = parseModule(current);
    for (const source of [...found.importSources, ...found.dynamicImports]) {
      if (source.startsWith('.')) queue.push(path.normalize(path.join(path.dirname(current), source)));
    }
  }
  return [...seen].sort();
}
const closure5K2 = [...new Set(PROVIDER_FILES.flatMap(importClosure))].sort();
const NETWORK_BUILTINS = ['node:http', 'node:https', 'node:http2', 'node:net', 'node:tls', 'node:dgram', 'node:dns',
  'node:child_process', 'node:worker_threads', 'node:cluster', 'http', 'https', 'net', 'tls', 'dgram', 'dns', 'child_process'];
const NETWORK_IDENTIFIERS = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'AbortController', 'setTimeout', 'sleep'];
const WALLET_MODULES = ['@solana/web3.js', '@solana/spl-token', 'solana', 'tweetnacl', 'ed25519-hd-keypairs', 'bs58'];
const SIGNING_OR_RPC_WRITE = ['sendRawTransaction', 'sendTransaction', 'sendAndConfirmTransaction', 'signTransaction',
  'signAllTransactions', 'partialSign', 'Keypair', 'VersionedTransaction', 'Transaction', 'SystemProgram', 'splToken',
  'requestAirdrop', 'confirmTransaction', 'rpc'];
const gitOut = (...args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });

// ===========================================================================
// A. GOVERNANCE
// ===========================================================================
test('A1 5K.0 classification is researchOnly and observerOnly', () => {
  assert.equal(PUBLIC_INTELLIGENCE_CLASSIFICATION.researchOnly, true);
  assert.equal(PUBLIC_INTELLIGENCE_CLASSIFICATION.observerOnly, true);
  for (const flag of PUBLIC_INTELLIGENCE_ALWAYS_TRUE_FLAGS) assert.equal(PUBLIC_INTELLIGENCE_CLASSIFICATION[flag], true);
});
test('A2 every authority flag is false on every mapped record', () => {
  const raw = mapStatusToRawObservation(status(), CTX);
  for (const flag of PUBLIC_INTELLIGENCE_ALWAYS_FALSE_FLAGS) {
    assert.equal(PUBLIC_INTELLIGENCE_CLASSIFICATION[flag], false);
    assert.equal(raw.classification[flag], false);
  }
  assert.equal(raw.classification.profitabilityInferencePermitted, false);
});
test('A3 mapped record is exactly the closed 5K.1 raw schema and carries no signal fields', () => {
  const raw = mapStatusToRawObservation(status(), CTX);
  assert.deepEqual(Object.keys(raw).sort(), [...PUBLIC_INTELLIGENCE_5K1_RAW_SCHEMA.fields].sort());
  const serialized = JSON.stringify(raw).toLowerCase();
  for (const word of ['sentiment', 'recommendation', 'alphascore', 'tradescore', 'marketscore', 'confidence', 'ranking', 'prediction']) {
    assert.ok(!serialized.includes(`"${word}`), `signal-like field ${word}`);
  }
});
test('A4 the adapter terminates at the 5K.1 ingestion boundary (no downstream stage)', () => {
  const { found } = parseModule(`${PROVIDER_DIR}/mastodon.mjs`);
  assert.ok(found.importSources.includes('../index.mjs'));
  for (const source of closure5K2) {
    assert.ok(/^scripts\/public-intelligence\//.test(source) || source === 'scripts/market-intelligence/definition.mjs', `unexpected closure member ${source}`);
  }
});

// ===========================================================================
// B. TRANSPORT ISOLATION
// ===========================================================================
test('B1 mapper and common perform no network and reference no network identifier', () => {
  for (const file of [`${PROVIDER_DIR}/mastodon-mapper.mjs`, `${PROVIDER_DIR}/common.mjs`]) {
    const { found } = parseModule(file);
    for (const id of NETWORK_IDENTIFIERS) assert.ok(!found.identifiers.includes(id), `${file} references ${id}`);
    assert.ok(!found.identifiers.includes('Date') || file.endsWith('common.mjs'), `${file} reads a clock`);
    for (const source of found.importSources) assert.ok(!NETWORK_BUILTINS.includes(source), `${file} imports ${source}`);
  }
  const mapper = parseModule(`${PROVIDER_DIR}/mastodon-mapper.mjs`).found;
  assert.ok(!mapper.identifiers.includes('Date'), 'mapper must not read a clock');
  assert.ok(!mapper.memberObjects.includes('process'), 'mapper must not read env/argv');
});
test('B2 the transport is the only 5K.2 module that references fetch or timers', () => {
  const holders = PROVIDER_FILES.filter(file => parseModule(file).found.identifiers.includes('fetch'));
  assert.deepEqual(holders, [`${PROVIDER_DIR}/mastodon-transport.mjs`]);
  const timers = PROVIDER_FILES.filter(file => parseModule(file).found.identifiers.includes('setTimeout'));
  assert.deepEqual(timers, [`${PROVIDER_DIR}/mastodon-transport.mjs`]);
});
test('B3 the transport maps and ingests nothing', () => {
  const { found } = parseModule(`${PROVIDER_DIR}/mastodon-transport.mjs`);
  assert.deepEqual([...found.importSources].sort(), ['./common.mjs']);
  assert.ok(!found.identifiers.includes('ingestPublicObservation'));
  assert.ok(!found.identifiers.includes('mapStatusToRawObservation'));
});
test('B4 the 5K.1 ingestion core stays network-free', () => {
  for (const file of ['observation', 'provenance', 'normalize', 'dedup', 'store', 'ingest', 'definition']
    .map(name => `scripts/public-intelligence/${name}.mjs`)) {
    const { found } = parseModule(file);
    for (const id of ['fetch', 'XMLHttpRequest', 'WebSocket', 'AbortController']) assert.ok(!found.identifiers.includes(id), `${file} references ${id}`);
    for (const source of found.importSources) assert.ok(!NETWORK_BUILTINS.includes(source), `${file} imports ${source}`);
  }
});
test('B5 the composition module reaches the network only through the transport', () => {
  const { found } = parseModule(`${PROVIDER_DIR}/mastodon.mjs`);
  assert.ok(!found.identifiers.includes('fetch'));
  assert.ok(!found.memberObjects.includes('globalThis'));
  for (const source of found.importSources) assert.ok(!NETWORK_BUILTINS.includes(source));
});

// ===========================================================================
// C. BOUNDED NETWORK
// ===========================================================================
test('C1 hard ceilings are finite and retries are fixed at zero', () => {
  for (const [key, value] of Object.entries(COMMON.PROVIDER_HARD_CEILINGS)) {
    assert.ok(Number.isFinite(value) && value >= 0, key);
  }
  assert.equal(COMMON.PROVIDER_HARD_CEILINGS.maxRetries, 0);
  assert.equal(TRANSPORT.MASTODON_TRANSPORT.maxRetries, 0);
  assert.equal(TRANSPORT.MASTODON_TRANSPORT.sleeps, false);
});
test('C2 bounds refuse zero, negative, fractional, infinite, over-ceiling and unknown values', () => {
  for (const [key, value] of [['maxPages', 0], ['maxRecords', -1], ['timeoutMs', 1.5], ['maxResponseBytes', Infinity],
    ['maxPages', COMMON.PROVIDER_HARD_CEILINGS.maxPages + 1], ['lookbackMs', COMMON.PROVIDER_HARD_CEILINGS.lookbackMs + 1],
    ['maxRetries', 1], ['maxRecords', 'many']]) {
    refusedWith(() => COMMON.resolveBounds({ [key]: value }), CODES.BOUNDS_INVALID);
  }
  refusedWith(() => COMMON.resolveBounds({ unlimited: true }), CODES.BOUNDS_INVALID, 'unknown-key');
  assert.deepEqual({ ...COMMON.resolveBounds({}) }, { ...COMMON.PROVIDER_DEFAULT_BOUNDS });
});
test('C3 max records is enforced', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(pageOf(900, 40)));
  const result = await run(fetchImpl, { maxRecords: 7, maxPages: 5 });
  assert.equal(result.records.length, 7);
  assert.equal(result.stopReason, 'MAX_RECORDS');
  assert.equal(fetchImpl.calls.length, 1);
});
test('C4 max pages is enforced and pagination follows the last id, not provider URLs', async () => {
  const fetchImpl = fakeFetch((url, init, n) => jsonResponse(pageOf(1000 - (n - 1) * 40, 40)));
  const result = await run(fetchImpl, { maxPages: 2, maxRecords: 200 });
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(result.pagesFetched, 2);
  assert.equal(result.stopReason, 'MAX_PAGES');
  assert.equal(new URL(fetchImpl.calls[1].url).searchParams.get('max_id'), '961');
  assert.equal(new URL(fetchImpl.calls[1].url).host, HOST);
});
test('C5 timeout fails cleanly and is not retried', async () => {
  const fetchImpl = fakeFetch((url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }));
  const error = await refusedAsync(run(fetchImpl, { timeoutMs: 20 }), CODES.TIMEOUT);
  assert.equal(error.code, 'PROVIDER_TIMEOUT');
  assert.equal(fetchImpl.calls.length, 1);
});
test('C6 response-size ceiling: declared length and streamed body are both enforced', async () => {
  const declared = fakeFetch(() => jsonResponse('[]', { headers: { 'content-type': 'application/json', 'content-length': '999999' } }));
  await refusedAsync(run(declared, { maxResponseBytes: 1000 }), CODES.RESPONSE_TOO_LARGE);
  const streamed = fakeFetch(() => jsonResponse(JSON.stringify([{ id: '1', pad: 'x'.repeat(5000) }])));
  await refusedAsync(run(streamed, { maxResponseBytes: 1000 }), CODES.RESPONSE_TOO_LARGE);
});
test('C7 retry behavior is bounded: rate limit, 5xx and network error each cost exactly one request', async () => {
  for (const responder of [() => new Response('', { status: 429 }), () => new Response('', { status: 503 }),
    () => { throw new TypeError('fetch failed'); }]) {
    const fetchImpl = fakeFetch(responder);
    await run(fetchImpl).catch(() => {});
    assert.equal(fetchImpl.calls.length, 1);
  }
});
test('C8 lookback window stops pagination and drops older records', async () => {
  const old = status({ id: '5', created_at: '2026-09-01T00:00:00.000Z' });
  const fetchImpl = fakeFetch(() => jsonResponse([status({ id: '9' }), old]));
  const result = await run(fetchImpl, { lookbackMs: 60 * 60 * 1000 * 24, maxPages: 3 });
  assert.equal(result.stopReason, 'LOOKBACK_REACHED');
  assert.deepEqual(result.records.map(record => record.id), ['9']);
  assert.equal(fetchImpl.calls.length, 1);
});
test('C9 requests are anonymous, GET-only, https, redirect-refusing and credential-free', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse([]));
  const result = await run(fetchImpl);
  assert.equal(result.stopReason, 'END_OF_TIMELINE');
  const { url, init } = fetchImpl.calls[0];
  assert.ok(url.startsWith(`https://${HOST}/api/v1/timelines/tag/solana?`));
  assert.equal(init.method, 'GET');
  assert.equal(init.redirect, 'error');
  assert.equal(init.credentials, 'omit');
  const headerNames = Object.keys(init.headers).map(name => name.toLowerCase());
  assert.deepEqual(headerNames.sort(), ['accept', 'user-agent']);
  assert.equal(TRANSPORT.MASTODON_TRANSPORT.authenticated, false);
  assert.equal(TRANSPORT.MASTODON_TRANSPORT.credentialsSent, false);
});
test('C10 only public DNS hosts and plain hashtags are accepted', () => {
  for (const host of ['127.0.0.1', 'localhost', '10.0.0.1', 'a.local', 'host:8080', 'user@host.example', 'host.example/path',
    'a.internal', '[::1]', '', 'x', 'evil.example#', 'a b.example']) {
    refusedWith(() => TRANSPORT.assertPublicHost(host), CODES.HOST_INVALID);
  }
  assert.equal(TRANSPORT.assertPublicHost('Mastodon.Social'), 'mastodon.social');
  for (const tag of ['', 'a b', 'a/b', '../x', 'a?b', '#solana', 'x'.repeat(65)]) {
    refusedWith(() => TRANSPORT.assertHashtag(tag), CODES.QUERY_INVALID);
  }
});

// ===========================================================================
// D. MAPPING
// ===========================================================================
test('D1 a valid fixture maps to a 5K.1 raw observation that ingests', () => {
  const raw = mapStatusToRawObservation(status(), CTX);
  const result = ingestPublicObservation(raw, { store: createMemoryStore() });
  assert.equal(result.outcome, 'INGESTED');
  assert.equal(result.assetAssociation.status, 'EXACT_MINT');
});
test('D2 provider id is preserved and namespaced by instance', () => {
  const raw = mapStatusToRawObservation(status(), CTX);
  assert.equal(raw.providerObservationId, '110000000000000001');
  assert.equal(raw.provider, `mastodon:${HOST}`);
  assert.equal(raw.providerAuthorId, `${HOST}:42`);
});
test('D3 source URL is preserved; unsafe URLs become null, never rewritten', () => {
  assert.equal(mapStatusToRawObservation(status(), CTX).sourceUrl, 'https://fixture.example/@alice/110000000000000001');
  assert.equal(mapStatusToRawObservation(status({ url: 'http://fixture.example/x', uri: null }), CTX).sourceUrl, null);
  assert.equal(mapStatusToRawObservation(status({ url: 'https://u:p@fixture.example/x', uri: null }), CTX).sourceUrl, null);
});
test('D4 text is preserved: tags stripped, entities decoded once, breaks kept', () => {
  assert.equal(mapStatusToRawObservation(status(), CTX).rawText, `watching $ABC mint ${MINT} & more`);
  assert.equal(MAPPER.mastodonHtmlToText('<p>a</p><p>b<br>c &amp;lt; &#36;</p>'), 'a\n\nb\nc &lt; $');
  assert.equal(mapStatusToRawObservation(status({ content: '<p>  spaced   text </p>' }), CTX).rawText, '  spaced   text ');
});
test('D5 timestamps stay independent: publishedAt parsed, observedAt null, fetchedAt from context', () => {
  const raw = mapStatusToRawObservation(status(), CTX);
  assert.equal(raw.publishedAt, Date.parse('2026-10-01T10:00:00.000Z'));
  assert.equal(raw.observedAt, null);
  assert.equal(raw.fetchedAt, FETCHED);
});
test('D6 missing created_at stays missing; it is never replaced by fetchedAt', () => {
  const missing = status(); delete missing.created_at;
  const raw = mapStatusToRawObservation(missing, CTX);
  assert.equal(raw.publishedAt, null);
  assert.notEqual(raw.publishedAt, raw.fetchedAt);
  assert.equal(ingestPublicObservation(raw, { store: createMemoryStore() }).outcome, 'INGESTED');
});
test('D7 metadata is minimized to the closed schema; engagement absent stays absent', () => {
  const raw = mapStatusToRawObservation(status(), CTX);
  assert.deepEqual(Object.keys(raw.rawMetadata).sort(), [...OBS.PUBLIC_INTELLIGENCE_5K1_RAW_METADATA_SCHEMA.fields].sort());
  assert.deepEqual({ ...raw.rawMetadata.engagement }, { likes: 3, replies: 0, reposts: 1 });
  assert.deepEqual([...raw.rawMetadata.hashtags], ['#solana']);
  assert.deepEqual([...raw.rawMetadata.mentionedHandles], []);
  const bare = status(); delete bare.favourites_count; delete bare.replies_count; delete bare.reblogs_count;
  assert.equal(mapStatusToRawObservation(bare, CTX).rawMetadata.engagement, null);
});
test('D8 an exact mint explicitly in the text becomes claimedMint', () => {
  const raw = mapStatusToRawObservation(status(), CTX);
  assert.equal(raw.claimedMint, MINT);
  assert.deepEqual([...raw.rawMetadata.candidateMintAddresses], [MINT]);
});
test('D9 symbol, cashtag, hashtag, name and username never produce a mint', () => {
  const raw = mapStatusToRawObservation(status({
    content: '<p>$BONK is the best #BONK token by @bonk_official named Bonk</p>',
    tags: [{ name: 'BONK' }], account: { id: '7', acct: 'bonk' },
  }), CTX);
  assert.equal(raw.claimedMint, null);
  assert.deepEqual([...raw.rawMetadata.candidateMintAddresses], []);
  assert.deepEqual([...raw.rawMetadata.cashtags], ['$BONK']);
  const result = ingestPublicObservation(raw, { store: createMemoryStore() });
  assert.equal(result.assetAssociation.status, 'UNASSOCIATED');
  assert.equal(result.assetAssociation.mint, null);
});
test('D10 a URL slug and a truncated mint do not associate; case is never folded back to the mint', () => {
  const raw = mapStatusToRawObservation(status({
    content: `<p>https://dex.example/token/bonk-coin and ${MINT.slice(0, 20)}</p>`,
  }), CTX);
  assert.equal(raw.claimedMint, null);
  const lowered = mapStatusToRawObservation(status({ content: `<p>${MINT.toLowerCase()}</p>` }), CTX);
  assert.notEqual(lowered.claimedMint, MINT, 'a differently-cased string must never become the canonical mint');
});
test('D11 two distinct explicit mints are never guessed between', () => {
  const raw = mapStatusToRawObservation(status({ content: `<p>${MINT} vs ${MINT_2}</p>` }), CTX);
  assert.equal(raw.claimedMint, null);
  assert.equal(raw.rawMetadata.candidateMintAddresses.length, 2);
  // claimedMint stays null (no guess), so 5K.1 records UNASSOCIATED while the
  // evidence keeps both exact candidates visible to a reviewer.
  const association = ingestPublicObservation(raw, { store: createMemoryStore() }).assetAssociation;
  assert.equal(association.status, 'UNASSOCIATED');
  assert.equal(association.mint, null);
  assert.equal(association.evidence.exactCandidateCount, 2);
  assert.equal(association.evidence.reason, 'EXACT_CANDIDATES_PRESENT_BUT_NOT_CLAIMED');
  const repeated = mapStatusToRawObservation(status({ content: `<p>${MINT} ${MINT}</p>` }), CTX);
  assert.equal(repeated.claimedMint, MINT);
});
test('D12 unknown provider fields cannot bypass the closed raw schema', () => {
  const raw = mapStatusToRawObservation(status({ sentiment: 'bullish', score: 99, alpha: 1, trade_signal: 'buy', unknown_future_field: {} }), CTX);
  const serialized = JSON.stringify(raw);
  for (const word of ['bullish', 'trade_signal', 'unknown_future_field', 'alpha']) assert.ok(!serialized.includes(word), word);
  assert.deepEqual(Object.keys(raw).sort(), [...PUBLIC_INTELLIGENCE_5K1_RAW_SCHEMA.fields].sort());
  assert.throws(() => canonicalizeRawObservation({ ...raw, sentiment: 1 }), /UNKNOWN_FIELD|CLOSED|unknown/i);
});
test('D13 replies map to REPLY, originals to POST; boosts are refused', () => {
  assert.equal(mapStatusToRawObservation(status({ in_reply_to_id: '5' }), CTX).sourceType, 'REPLY');
  assert.equal(mapStatusToRawObservation(status(), CTX).sourceType, 'POST');
  refusedWith(() => mapStatusToRawObservation(status({ reblog: status({ id: '7' }) }), CTX), CODES.RECORD_REFUSED, 'REBLOG_WRAPPER');
});
test('D14 the mapper demands explicit context and never defaults it', () => {
  for (const key of ['host', 'fetchedAt', 'collectionRunId', 'collectorMode']) {
    const context = { ...CTX }; delete context[key];
    refusedWith(() => mapStatusToRawObservation(status(), context), CODES.RECORD_REFUSED);
  }
  refusedWith(() => mapStatusToRawObservation(status(), { ...CTX, collectorMode: 'LIVE_API' }), CODES.RECORD_REFUSED, 'COLLECTOR_MODE');
  refusedWith(() => mapStatusToRawObservation(status(), { ...CTX, fetchedAt: 1.5 }), CODES.RECORD_REFUSED);
});

// ===========================================================================
// E. PRIVACY
// ===========================================================================
test('E1 credential-like text is refused, and the refusal never echoes the value', () => {
  const secrets = ['Authorization: Bearer abcdefghijklmnop1234567890', 'Bearer abcdefghijklmnop1234567890',
    '-----BEGIN PRIVATE KEY-----', 'api_key=abcdef1234567890', `eyJhbGciOiJI.eyJzdWIiOiIx.abcdefghijk`,
    '5'.repeat(88)];
  for (const secret of secrets) {
    const error = refusedWith(() => mapStatusToRawObservation(status({ content: `<p>${secret}</p>` }), CTX), CODES.RECORD_REFUSED, 'CREDENTIAL_LIKE_TEXT');
    assert.ok(!JSON.stringify(error.details).includes(secret.slice(0, 12)));
  }
});
test('E2 credential, cookie and private key names are refused at any depth', () => {
  for (const key of ['access_token', 'accessToken', 'Cookie', 'set-cookie', 'refresh_token', 'api_key', 'private_key', 'password', 'authorization']) {
    refusedWith(() => mapStatusToRawObservation(status({ account: { id: '42', nested: { [key]: 'x' } } }), CTX), CODES.RECORD_REFUSED, 'REFUSED_KEY_PRESENT');
  }
});
test('E3 cookies and tokens are never present in any adapter output or request', async () => {
  const raw = mapStatusToRawObservation(status(), CTX);
  assert.ok(!/cookie|authorization|bearer|accesstoken|refreshtoken/i.test(JSON.stringify(raw)));
  const fetchImpl = fakeFetch(() => jsonResponse([]));
  await run(fetchImpl);
  assert.ok(!JSON.stringify(fetchImpl.calls[0].init).match(/cookie|authorization|bearer|token/i));
  for (const file of PROVIDER_FILES) {
    const { found } = parseModule(file);
    assert.ok(!found.memberObjects.includes('process') || file.endsWith('/mastodon.mjs'), `${file} touches process`);
  }
});
test('E4 private message types and non-public visibility are refused', () => {
  for (const visibility of ['direct', 'private', 'unlisted', undefined, null, 'PUBLIC']) {
    refusedWith(() => mapStatusToRawObservation(status({ visibility }), CTX), CODES.RECORD_REFUSED, 'NON_PUBLIC_VISIBILITY');
  }
  for (const type of ['direct', 'conversation', 'mention', 'dm']) {
    refusedWith(() => mapStatusToRawObservation(status({ type }), CTX), CODES.RECORD_REFUSED, 'PRIVATE_RECORD_TYPE');
  }
  assert.ok(COMMON.PROVIDER_REFUSED_KEYS.includes('privatemessage'));
});
test('E5 geolocation and address fields are not carried', () => {
  const raw = mapStatusToRawObservation(status({
    location: 'Berlin', geo: { lat: 52.5, lon: 13.4 }, place: { name: 'Home' }, coordinates: [1, 2], address: '1 Main St',
  }), CTX);
  const serialized = JSON.stringify(raw);
  for (const word of ['Berlin', '52.5', 'Home', 'Main St', 'coordinates']) assert.ok(!serialized.includes(word), word);
  refusedWith(() => mapStatusToRawObservation(status({ geoLocation: { lat: 1 } }), CTX), CODES.RECORD_REFUSED, 'REFUSED_KEY_PRESENT');
  refusedWith(() => mapStatusToRawObservation(status({ homeAddress: 'x' }), CTX), CODES.RECORD_REFUSED, 'REFUSED_KEY_PRESENT');
});
test('E6 unnecessary personal fields are discarded (handle, name, bio, avatar, follower counts)', () => {
  const serialized = JSON.stringify(mapStatusToRawObservation(status(), CTX));
  for (const personal of ['alice', 'Alice Real Name', 'bio', 'a.png', '9999', 'followers']) {
    assert.ok(!serialized.includes(personal) || personal === 'alice' && serialized.includes('/@alice/'), `leaked ${personal}`);
  }
  assert.deepEqual([...Object.keys(mapStatusToRawObservation(status(), CTX)).filter(key => /acct|display|avatar|note/i.test(key))], []);
});
test('E7 the consumed-field allowlist is explicit and contains no personal field', () => {
  for (const field of MAPPER.MASTODON_CONSUMED_FIELDS) {
    assert.ok(!/acct|display_name|note|avatar|header|email|location|geo|follow/i.test(field), field);
  }
});

// ===========================================================================
// F. DEDUP
// ===========================================================================
test('F1 the same provider id maps to the same dedup identity and ingests idempotently', () => {
  const a = mapStatusToRawObservation(status(), CTX);
  const b = mapStatusToRawObservation(status(), CTX);
  assert.equal(dedupIdentity5K1(a), dedupIdentity5K1(b));
  const store = createMemoryStore();
  assert.equal(ingestPublicObservation(a, { store }).outcome, 'INGESTED');
  assert.equal(ingestPublicObservation(b, { store }).outcome, 'ALREADY_PRESENT');
});
test('F2 distinct provider ids stay distinct even with identical text', () => {
  const a = mapStatusToRawObservation(status({ id: '1' }), CTX);
  const b = mapStatusToRawObservation(status({ id: '2' }), CTX);
  assert.equal(a.rawText, b.rawText);
  assert.notEqual(dedupIdentity5K1(a), dedupIdentity5K1(b));
  const store = createMemoryStore();
  assert.equal(ingestPublicObservation(a, { store }).stored, true);
  assert.equal(ingestPublicObservation(b, { store }).stored, true);
});
test('F3 the instance namespace is preserved: same id on two instances never collapses', () => {
  const a = mapStatusToRawObservation(status(), CTX);
  const b = mapStatusToRawObservation(status(), { ...CTX, host: 'other.example' });
  assert.notEqual(a.provider, b.provider);
  assert.notEqual(dedupIdentity5K1(a), dedupIdentity5K1(b));
});

// ===========================================================================
// G. ERRORS
// ===========================================================================
test('G1 malformed JSON fails', async () => {
  await refusedAsync(run(fakeFetch(() => jsonResponse('{not json'))), CODES.MALFORMED_RESPONSE);
});
test('G2 a non-array JSON body fails', async () => {
  await refusedAsync(run(fakeFetch(() => jsonResponse({ error: 'x' }))), CODES.MALFORMED_RESPONSE);
});
test('G3 an unexpected content type fails (HTML challenge pages are not parsed)', async () => {
  const error = await refusedAsync(run(fakeFetch(() => new Response('<html>captcha</html>', { status: 200, headers: { 'content-type': 'text/html' } }))), CODES.UNEXPECTED_CONTENT_TYPE);
  assert.equal(error.details.contentType, 'text/html');
});
test('G4 oversized responses fail', async () => {
  await refusedAsync(run(fakeFetch(() => jsonResponse(JSON.stringify(pageOf(100, 40)))), { maxResponseBytes: 2000 }), CODES.RESPONSE_TOO_LARGE);
});
test('G5 a rate limit is explicit, carries retry metadata, and does not sleep', async () => {
  const started = Date.now();
  const error = await refusedAsync(run(fakeFetch(() => new Response('', { status: 429, headers: {
    'retry-after': '120', 'x-ratelimit-limit': '300', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2026-10-01T12:05:00.000Z' } }))), CODES.RATE_LIMITED);
  assert.deepEqual({ ...error.details }, { status: 429, retryAfterSeconds: 120, rateLimitLimit: 300, rateLimitRemaining: 0, rateLimitReset: '2026-10-01T12:05:00.000Z' });
  assert.ok(Date.now() - started < 1000, 'must not wait out a rate limit');
});
test('G6 5xx, auth-required and other 4xx are distinct explicit states', async () => {
  const five = await refusedAsync(run(fakeFetch(() => new Response('', { status: 503 }))), CODES.SERVER_ERROR_5XX);
  assert.equal(five.details.status, 503);
  await refusedAsync(run(fakeFetch(() => new Response('', { status: 401 }))), CODES.AUTH_REQUIRED);
  await refusedAsync(run(fakeFetch(() => new Response('', { status: 403 }))), CODES.AUTH_REQUIRED);
  await refusedAsync(run(fakeFetch(() => new Response('', { status: 404 }))), CODES.CLIENT_ERROR_4XX);
  await refusedAsync(run(fakeFetch(() => { throw new TypeError('fetch failed'); })), CODES.NETWORK_ERROR);
});
test('G7 malformed timestamps fail, including calendar overflow and zoneless forms', () => {
  for (const created_at of ['yesterday', '2026-02-31T00:00:00.000Z', '2026-10-01 10:00:00', '2026-10-01T10:00:00', 1790000000, '', '2026-13-01T00:00:00Z', '2026-10-01T25:00:00Z']) {
    refusedWith(() => mapStatusToRawObservation(status({ created_at }), CTX), 'PROVIDER_TIMESTAMP_MALFORMED');
  }
  assert.equal(COMMON.parseProviderTimestamp('2026-10-01T10:00:00+02:00'), Date.parse('2026-10-01T08:00:00Z'));
});
test('G8 a missing or non-stable provider id fails; text is never an identity', () => {
  for (const id of [undefined, null, '', 'abc', 12345, '1'.repeat(40)]) {
    refusedWith(() => mapStatusToRawObservation(status({ id }), CTX), CODES.RECORD_REFUSED, 'PROVIDER_ID_MISSING_OR_INVALID');
  }
  const textOnly = { visibility: 'public', content: '<p>no id here</p>', created_at: '2026-10-01T10:00:00.000Z' };
  refusedWith(() => mapStatusToRawObservation(textOnly, CTX), CODES.RECORD_REFUSED, 'PROVIDER_ID_MISSING_OR_INVALID');
});
test('G9 a non-object record is a malformed response', () => {
  for (const value of [null, 'text', 7, [], undefined]) refusedWith(() => mapStatusToRawObservation(value, CTX), CODES.MALFORMED_RESPONSE);
});
test('G10 the composition counts refused records by reason and keeps good ones', async () => {
  const body = [status({ id: '3' }), status({ id: '2', visibility: 'direct' }), status({ id: '1', created_at: 'bad' })];
  const result = await ADAPTER.fetchPublicObservations({
    host: HOST, hashtag: 'solana', bounds: { maxPages: 1 }, collectionRunId: 'run-g10',
    store: createMemoryStore(), fetchImpl: fakeFetch(() => jsonResponse(body)), now: () => NOW,
  });
  assert.equal(result.observations.length, 1);
  assert.deepEqual([...result.refused].sort(), ['NON_PUBLIC_VISIBILITY', 'PROVIDER_TIMESTAMP_MALFORMED'].sort());
  assert.deepEqual({ ...result.ingestOutcomes }, { INGESTED: 1 });
  assert.equal(result.observations[0].collectionContext.collectorMode, 'LIVE_PUBLIC_PROVIDER');
  assert.equal(result.observations[0].fetchedAt, NOW);
});

// ===========================================================================
// H. OFFLINE GUARANTEES
// ===========================================================================
test('H1 the validator made zero real network calls', () => {
  assert.equal(tripwireCalls, 0);
});
test('H2 no credential or environment variable is read by any adapter module', () => {
  for (const file of PROVIDER_FILES) {
    const { source, found } = parseModule(file);
    assert.ok(!/process\.env/.test(source), `${file} reads the environment`);
    assert.ok(!found.identifiers.includes('env'), `${file} references env`);
  }
});
test('H3 the smoke command is explicit and the validator never invokes it', () => {
  const { source } = parseModule(`${PROVIDER_DIR}/mastodon.mjs`);
  assert.ok(/argv\[2\] === 'smoke'/.test(source));
  const self = parseModule('scripts/validate-phase5k2.mjs').found;
  const command = ['sm', 'oke'].join('');
  assert.ok(!self.stringLiterals.includes(command), 'validator must not pass the live command');
  assert.ok(!self.stringLiterals.some(literal => !literal.startsWith('./') && literal.includes(['providers', 'mastodon.mjs'].join('/'))), 'validator must not execute the adapter CLI');
});
test('H4 temporary NDJSON storage works end to end and the repository tree is unchanged', async () => {
  const before = gitOut('status', '--porcelain');
  const directory = tempRoot();
  const store = createNdjsonStore(directory);
  const result = await ADAPTER.fetchPublicObservations({
    host: HOST, hashtag: 'solana', bounds: { maxPages: 1 }, collectionRunId: 'run-h4',
    store, fetchImpl: fakeFetch(() => jsonResponse(pageOf(50, 3))), now: () => NOW,
  });
  assert.equal(result.observations.length, 3);
  assert.equal(readdirSync(directory).length, 2);
  assert.ok(!directory.startsWith(REPO_ROOT));
  assert.equal(gitOut('status', '--porcelain'), before);
});
test('H5 the smoke bounds are tiny and explicit', () => {
  const { source } = parseModule(`${PROVIDER_DIR}/mastodon.mjs`);
  assert.ok(/maxPages: 1, maxRecords: 5/.test(source));
  assert.ok(/--out/.test(source) && /persisted: out \?/.test(source));
});

// ===========================================================================
// I. ARCHITECTURAL ISOLATION
// ===========================================================================
test('I1 no adapter module imports trading, engine, Arena, promotion or R4 code', () => {
  for (const entry of closure5K2) {
    assert.ok(!/(^|\/)(engine|arena|governance|champions|promotion)(\/|\.|-|$)/.test(entry.replace('scripts/public-intelligence/', '')), entry);
    assert.ok(!/scripts\/(evolve-engine|evolve-governance|arena|champions|experiment|intelligence)\.mjs$/.test(entry), entry);
    assert.ok(!/(r4-|market-outcomes)/.test(entry), entry);
  }
});
test('I2 no wallet, signer, swap or RPC-write capability is imported or referenced', () => {
  for (const file of closure5K2) {
    const { found } = parseModule(file);
    for (const source of [...found.importSources, ...found.dynamicImports]) assert.ok(!WALLET_MODULES.includes(source), `${file} ${source}`);
    for (const id of [...found.identifiers, ...found.memberObjects]) assert.ok(!SIGNING_OR_RPC_WRITE.includes(id), `${file} ${id}`);
  }
});
test('I3 adapter modules import no builtin beyond node:url (and fs/path/crypto only via 5K.1 storage)', () => {
  const allowed = new Set(['node:url', 'node:fs', 'node:path', 'node:crypto']);
  for (const file of closure5K2) {
    for (const source of parseModule(file).found.importSources) {
      if (source.startsWith('node:')) assert.ok(allowed.has(source), `${file} imports ${source}`);
    }
  }
  for (const file of PROVIDER_FILES.filter(entry => !entry.endsWith('/mastodon.mjs'))) {
    assert.deepEqual(parseModule(file).found.importSources.filter(source => source.startsWith('node:')), [], file);
  }
});
test('I4 no adapter module can write under .evolve', () => {
  for (const file of PROVIDER_FILES) {
    const { found } = parseModule(file);
    for (const literal of found.stringLiterals) assert.ok(!literal.includes('.evolve'), `${file} mentions .evolve`);
    assert.ok(!found.identifiers.some(id => /^(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|rm|rmSync)$/.test(id)), `${file} writes files directly`);
  }
});
test('I5 no engine, Arena or governance script imports the adapter', () => {
  const listed = gitOut('ls-files', 'scripts').split('\n').filter(file => file.endsWith('.mjs'));
  for (const file of listed) {
    if (file === 'scripts/validate-phase5k2.mjs' || file.startsWith('scripts/public-intelligence/')) continue;
    assert.ok(!/public-intelligence\/providers/.test(readFileSync(path.join(REPO_ROOT, file), 'utf8')), `${file} imports a provider adapter`);
  }
});
test('I6 .evolve is untouched', () => {
  for (const line of gitOut('status', '--porcelain').split('\n').filter(Boolean)) {
    assert.equal(/^\s*[MADRCU?!]{1,2}\s+\.evolve/.test(line), false, '.evolve must be untouched');
  }
  assert.equal(existsSafe(path.join(REPO_ROOT, '.evolve', 'public-intelligence')), false);
});

// ===========================================================================
// J. REGRESSION
// ===========================================================================
test('J1 the 5K.0 validator stays 32/32', () => {
  const output = execFileSync('node', ['scripts/validate-phase5k.mjs'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.ok(output.includes('Phase 5K.0: 32/32 passed'), output.split('\n').slice(-3).join('|'));
});
test('J2 the 5K.1 validator stays 64/64', () => {
  const output = execFileSync('node', ['scripts/validate-phase5k1.mjs'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.ok(output.includes('Phase 5K.1: 64/64 passed'), output.split('\n').slice(-3).join('|'));
});
test('J3 R4 C1 is an ancestor of HEAD and R4 bound artifacts are unchanged', () => {
  execFileSync('git', ['merge-base', '--is-ancestor', R4_HEAD, 'HEAD'], { cwd: REPO_ROOT });
  for (const bound of ['governance/r4/r4-preregistration-seal.json', 'package.json', 'package-lock.json']) {
    const was = execFileSync('git', ['show', `${R4_HEAD}:${bound}`], { cwd: REPO_ROOT });
    assert.ok(readFileSync(path.join(REPO_ROOT, bound)).equals(was), bound);
  }
});
test('J4 5K.0 governance is unmodified and the 5K.1 collector-mode constant is untouched', () => {
  const committed = execFileSync('git', ['show', 'HEAD:scripts/public-intelligence/definition.mjs'], { cwd: REPO_ROOT });
  assert.ok(readFileSync(path.join(REPO_ROOT, 'scripts/public-intelligence/definition.mjs')).equals(committed));
  for (const frozen of ['docs/PHASE5K-PUBLIC-SOCIAL-INTELLIGENCE.md', 'docs/PHASE5K1-INGESTION-PROVENANCE.md', 'scripts/validate-phase5k.mjs', 'scripts/validate-phase5k1.mjs']) {
    assert.equal(gitOut('diff', '--name-only', 'HEAD', '--', frozen).trim(), '', `${frozen} modified`);
  }
  assert.deepEqual([...PUBLIC_INTELLIGENCE_5K1_COLLECTOR_MODES], ['OFFLINE_FIXTURE']);
});
test('J5 the live collector mode is additive: LIVE_PUBLIC_PROVIDER is allowed, other values stay refused', () => {
  const raw = mapStatusToRawObservation(status(), { ...CTX, collectorMode: 'LIVE_PUBLIC_PROVIDER' });
  assert.equal(raw.collectionContext.collectorMode, 'LIVE_PUBLIC_PROVIDER');
  for (const mode of ['LIVE_API', 'LIVE', 'live_public_provider', '', null]) {
    assert.throws(() => canonicalizeRawObservation({ ...raw, collectionContext: { ...raw.collectionContext, collectorMode: mode } }), /COLLECTOR_MODE_INVALID/);
  }
});
test('J6 the phase document exists and covers every required section', () => {
  const doc = readFileSync(path.join(REPO_ROOT, 'docs/PHASE5K2-FIRST-PROVIDER.md'), 'utf8');
  for (const heading of ['Provider chosen', 'Why it was chosen', 'Public-data boundary', 'Transport contract', 'Mapper contract',
    'Rate limits', 'Pagination bounds', 'Credential handling', 'Privacy exclusions', 'Timestamp mapping', 'Provider ID semantics',
    'Mint extraction rule', 'Error states', 'Live smoke-test procedure', 'Non-goals', 'Why no trading path exists', 'roadmap label']) {
    assert.ok(doc.toLowerCase().includes(heading.toLowerCase()), `doc lacks "${heading}"`);
  }
});

// ---------------------------------------------------------------------------
// RUNNER
// ---------------------------------------------------------------------------
async function main() {
  let failed = 0;
  try {
    for (const [name, fn] of tests) {
      try { await fn(); console.log(`PASS ${name}`); } catch (error) { failed++; console.error(`FAIL ${name}: ${error.stack}`); }
    }
  } finally { for (const root of temporary) rmSync(root, { recursive: true, force: true }); }
  console.log(`Phase 5K.2: ${tests.length - failed}/${tests.length} passed; offline, fixtures only, ${tripwireCalls} network calls, no credentials`);
  if (failed) process.exitCode = 1;
}
main().catch(error => { console.error('phase 5K.2 validator crashed:', error); process.exitCode = 1; });
