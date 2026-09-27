#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync, renameSync, unlinkSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { EVIDENCE, canonical, digest, redact } from './market-intelligence/definition.mjs';
import { createIntelligenceConfig, observation, normalizeGmgn, normalizeDex, normalizeJupiterMarkets, normalizeLaunchEvent, createGmgnProvider, createDexProvider, createLaunchObserver, aggregate, disagreement, createStorage, manifestFingerprint, createIntelligenceRecorder, FEATURE_NAMES,
  readSummary, sessionCapacityMiB, SESSION_CAPACITY_MIB, SESSION_FINALIZATION_RESERVE_BYTES, FINALIZATION_RECORD_MAX_BYTES } from './market-intelligence/index.mjs';
import { SAFE_FAILURE_CODES, safeFailureCode, failureLine, doctorReport } from './market-intelligence.mjs';
import { FILE_HASH_CHUNK_BYTES, hashFileDescriptor, fileHash } from './market-intelligence/storage.mjs';
import { GMGN_ROUTES } from './market-intelligence/providers/gmgn.mjs';
import { DEX_ROUTES } from './market-intelligence/providers/dexscreener.mjs';
import { createObservationTransport } from './market-intelligence/providers/http.mjs';
import { loadMarketIntelligenceDashboard } from './market-intelligence/dashboard.mjs';
import { AGENT_REACH_PIN } from './intelligence/config.mjs';
import { normalizeJupiterToken, deriveMarket } from './market/normalize.mjs';
import { createMarketConfig, createMarketFeed } from './market/index.mjs';
import { jupiterAdapterPayload } from './market-intelligence/normalize.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const at = 1800000000000;
const mint = 'So11111111111111111111111111111111111111112';
const other = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const key = 'fixture-credential-DO-NOT-PERSIST';
const FORBIDDEN_SIGNING = /^(signTransaction|signAllTransactions|sign|signer|privateKey|secretKey|mnemonic)$/i;
const FORBIDDEN_EXECUTION = /^(swap|sendTransaction|sendRawTransaction|submitOrder|placeOrder|takeProfit|stopLoss|copyTrade)$/i;
const FORBIDDEN_FIXTURE_FIELDS = { privateKey: 'not retained' };
const config = createIntelligenceConfig({ env: {} });
const gmgnPayload = { code: 0, data: { address: mint, name: 'fixture', symbol: 'SAME', price: { price: '2', volume_5m: '100', volume_1h: '500', buys_5m: 3, sells_5m: 1 }, dev: { creator_address: other }, liquidity: '1000', circulating_supply: '50', holder_count: 25, creation_timestamp: at / 1000 - 30,
  launchpad: 'pump', launchpad_status: 1, launchpad_progress: 0.5, stat: { top_10_holder_rate: 0.2, creator_hold_rate: 0.05 }, wallet_tags_stat: { smart_wallets: 3, renowned_wallets: 2, sniper_wallets: 1, bundler_wallets: 4, rat_trader_wallets: 0, whale_wallets: 2 } } };
const result = (payload, kind = 'info', receivedAt = at) => ({ payload, kind, receivedAt, endpoint: GMGN_ROUTES[kind]?.path ?? '/fixture', requestIdentity: mint });
const g = () => normalizeGmgn(result(gmgnPayload), { mint })[0];
const dexPayload = [{ chainId: 'solana', pairAddress: mint, dexId: 'fixture', baseToken: { address: mint, symbol: 'SAME' }, quoteToken: { address: other }, priceUsd: '2.2', liquidity: { usd: 900 }, marketCap: 99, fdv: 100,
  volume: { m5: 110, h1: 700, h6: 1000, h24: 2000 }, txns: { m5: { buys: 3, sells: 1 } }, priceChange: { m5: 1, h1: 2 }, pairCreatedAt: at - 60000, boosts: { active: 1 } }];
const d = () => normalizeDex(result(dexPayload, 'pairs'))[0];
const event = { observedAt: at, chain: 'solana', platform: 'pump_fun', mint, sourceKind: 'logs', slot: 42, transactionSignature: 'fixture-observed-signature', metadata: { symbol: 'SAME' } };
const record = (provider, normalized, time = at) => observation({ provider, endpoint: '/fixture', mint, payload: normalized, normalized, receivedAt: time, observedAt: at, providerObservedAt: time, staleMs: 60000 });
const temporary = [];
function store(options = {}) { const root = mkdtempSync(path.join(tmpdir(), 'evolve-5j-')); temporary.push(root); return createStorage({ root, startedAt: at, sessionId: 'fixture', ...options }); }
const response = (payload, status = 200, headers = {}) => new Response(JSON.stringify(payload), { status, headers });
const frozenSnapshot = records => aggregate(records, { observedAt: at });
const require = createRequire(import.meta.url);
const espree = require('espree');
function walk(node, fn) {
  if (!node || typeof node !== 'object') return;
  if (node.type) fn(node);
  for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(v => walk(v, fn)); else if (value && typeof value === 'object') walk(value, fn);
}
function files(root) { return readdirSync(root, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(root, e.name)) : [path.join(root, e.name)]); }
const modules = files('scripts/market-intelligence').filter(p => p.endsWith('.mjs'));
function audit(pattern) {
  for (const file of modules) {
    const ast = espree.parse(readFileSync(file, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' });
    walk(ast, node => {
      if (node.type === 'Identifier' && pattern.test(node.name)) assert.fail(`${file}: forbidden capability ${node.name}`);
      if (node.type === 'Literal' && typeof node.value === 'string' && pattern.test(node.value) && !file.endsWith('definition.mjs')) assert.fail(`${file}: forbidden capability literal`);
    });
  }
}
const sealed = 'e86456246f58521741b02bf99f9e33fe6ab04c6b';
function unchanged(paths) { for (const p of paths) assert.equal(readFileSync(p, 'utf8'), execFileSync('git', ['show', `${sealed}:${p}`], { encoding: 'utf8' })); }

test('1 GMGN documented nested normalization fixture and provider labels', () => {
  const r = g(); assert.equal(r.normalized.creatorAddress, other); assert.equal(r.normalized.tradeActivity['5m'].buys, 3); assert.equal(r.normalized.marketVolumes['1h'], 500); assert.equal(r.normalized.priceUsd, 2); assert.equal(r.normalized.topHolderPct, 20); assert.equal(r.normalized.creatorHoldingPct, 5);
  assert.deepEqual(r.normalized.walletTags[0], { provider: 'gmgn', providerLabel: 'smart_degen', count: 3 });
  const s = normalizeGmgn(result({ code: 0, data: { rug_ratio: 0.3, renounced_mint: false, renounced_freeze_account: true, is_honeypot: '' } }, 'security'), { mint })[0];
  assert.equal(s.normalized.rugRatio, 0.3); assert.equal(s.normalized.honeypot, null); assert.equal(s.normalized.securityWarnings.length, 1);
  assert.equal(frozenSnapshot([g(), s])[0].features.gmgnSecurityWarningCount, 1);
});
test('2 GMGN missing key disables without request', async () => {
  const provider = createGmgnProvider({ config: config.gmgn, fetchImpl: () => { throw new Error('must not request'); } });
  assert.equal(provider.health().state, 'DISABLED_NO_KEY'); assert.equal((await provider.observe('info', mint)).unavailable, 'DISABLED_NO_KEY');
});
test('3 GMGN secrets nonenumerable and safe failures', async () => {
  const c = createIntelligenceConfig({ env: { EVOLVE_GMGN_API_KEY: key, GMGN_API_KEY: 'wrong' } });
  assert.equal(c.gmgn.apiKey, key); assert(!canonical(c).includes(key)); assert(!JSON.stringify({ ...c.gmgn }).includes(key));
  const p = createGmgnProvider({ config: c.gmgn, fetchImpl: async () => { throw new Error(key); }, now: () => at });
  const r = await p.observe('info', mint); assert(!JSON.stringify([p, p.health(), r]).includes(key));
});
test('4 GMGN explicit origin/method/endpoint allowlist', async () => {
  const c = createIntelligenceConfig({ env: { EVOLVE_GMGN_API_KEY: key } });
  const calls = [];
  const p = createGmgnProvider({ config: c.gmgn, fetchImpl: async (url, init) => { calls.push([url, init]); return response(gmgnPayload); }, now: () => at, sleep: async () => {} });
  await assert.rejects(p.observe('undeclared', mint)); await assert.rejects(p.observe('info', '../route'));
  await p.observe('info', mint); await p.observe('trenches');
  assert.equal(calls[0][0].pathname, '/v1/token/info'); assert.equal(calls[0][1].method, 'GET'); assert.equal(calls[0][1].redirect, 'error');
  assert.equal(calls[1][0].pathname, '/v1/trenches'); assert.equal(calls[1][1].method, 'POST');
  assert.equal(calls[0][0].searchParams.get('chain'), 'sol'); assert.equal(calls[0][1].headers['X-APIKEY'], key);
  for (const baseUrl of ['https://evil.example', 'https://openapi.gmgn.ai/v1/trade', 'https://user@openapi.gmgn.ai']) assert.throws(() => createGmgnProvider({ config: { ...c.gmgn, apiKey: key, baseUrl } }));
});
test('5 Dex normalization fixture retains pair/base/quote and windows', () => { const p = d().normalized; assert.equal(p.priceUsd, 2.2); assert.equal(p.pairAddress, mint); assert.equal(p.quoteToken.address, other); assert.equal(p.volumes.h24, 2000); assert.equal(p.transactions.m5.buys, 3); assert.equal(p.boostsActive, 1); });
test('6 Dex rate limits/backoff/cache preserve receipt and bounded concurrency', async () => {
  let time = at, calls = 0; const waits = [];
  const p = createDexProvider({ config: { ...config.dex, cacheMs: 100, pollMs: 1000 }, now: () => time,
    sleep: async ms => { waits.push(ms); time += ms; }, fetchImpl: async () => { calls++; return calls === 1 ? response({}, 429, { 'retry-after': '120' }) : response(dexPayload); } });
  assert.equal((await p.observe(mint)).unavailable, 'HTTP_429'); assert.equal((await p.observe(mint)).unavailable, 'BACKOFF'); assert.equal(calls, 1);
  time += 120001; const r = await p.observe(mint); time += 1; assert.equal((await p.observe(mint)).receivedAt, r.receivedAt); assert.equal(calls, 2);
  time += 101; await p.observe(other); assert(waits[0] > 0); assert.equal(p.health().concurrencyLimit, 1);
  let release; const blocking = createDexProvider({ config: config.dex, now: () => at, fetchImpl: () => new Promise(resolve => { release = resolve; }) });
  const active = blocking.observe(mint); assert.equal((await blocking.observe(other)).unavailable, 'BUSY'); release(response(dexPayload)); await active;
});
test('7 Dex malformed payload and bounded oversized response', async () => {
  assert.deepEqual(normalizeDex(result({ pairs: [] }, 'pairs')), []);
  assert.deepEqual(normalizeDex(result([null, {}, { chainId: 'ethereum', baseToken: { address: mint } }], 'pairs')), []);
  const p = createDexProvider({ config: config.dex, fetchImpl: async () => response({ wrong: 1 }), now: () => at });
  assert.equal((await p.observe(mint)).unavailable, 'MALFORMED_PAYLOAD');
  const huge = createDexProvider({ config: config.dex, fetchImpl: async () => response('x'.repeat(300000)), now: () => at });
  assert.equal((await huge.observe(mint)).unavailable, 'PAYLOAD_TOO_LARGE');
});
test('8 Pump.fun and LetsBonk decoded launch fixture with unavailable fields', () => {
  const r = normalizeLaunchEvent(event, { receivedAt: at }); assert.equal(r.normalized.platform, 'pump_fun'); assert.equal(r.normalized.creator, null); assert.equal(r.normalized.programId, null); assert.equal(r.normalized.rawDigest, digest(event));
  assert.equal(normalizeLaunchEvent({ ...event, platform: 'lets_bonk' }, { receivedAt: at }).normalized.platform, 'lets_bonk');
});
test('9 launch duplicate suppression and bounded identity capacity', async () => { const p = createLaunchObserver({ maxSeen: 1 }); assert(p.ingest(event, { receivedAt: at })); assert.equal(p.ingest(event, { receivedAt: at + 1 }), null); assert.equal(p.health().duplicates, 1); assert.equal(p.ingest({ ...event, mint: other }, { receivedAt: at }), null); assert.equal((await p.poll()).length, 1); assert.deepEqual(await p.poll(), []); });
test('10 canonical mint join copies Jupiter without mutation', () => {
  const raw = { id: mint, usdPrice: 2, liquidity: 1000, stats5m: { buyVolume: 20, sellVolume: 10 } };
  const market = deriveMarket(normalizeJupiterToken(raw, { at }), { at }); const before = canonical(market);
  const j = normalizeJupiterMarkets([market], { observedAt: at }); assert.equal(frozenSnapshot([...j, g(), d()]).length, 1); assert.equal(canonical(market), before);
  assert.deepEqual(normalizeJupiterMarkets([{ ...market, synthetic: true }], { observedAt: at }), []);
});
test('11 symbol collisions never join and quote token is not canonical base', () => {
  const r = structuredClone(d()); r.mint = other; r.normalized.baseToken.address = other;
  assert.equal(frozenSnapshot([g(), r]).length, 2);
  assert.deepEqual(normalizeDex({ ...result(dexPayload), requestIdentity: other }), []);
});
test('12 independent provider and receipt timestamps', () => {
  const r = observation({ provider: 'fixture', endpoint: '/fixture', mint, payload: {}, normalized: {}, providerObservedAt: at - 10000, receivedAt: at - 100, observedAt: at, staleMs: 5000 });
  assert.equal(r.providerObservedAt, at - 10000); assert.equal(r.capturedAt, at - 100); assert.equal(r.staleness.ageMs, 10000);
});
test('13 stale sources excluded from features and price comparisons', () => {
  const stale = record('gmgn', { priceUsd: 1, createdAt: at - 5000, walletTags: [] }, at - 70000);
  assert.equal(frozenSnapshot([stale, d()])[0].features.gmgnSmartMoneyCount, null);
  assert.equal(disagreement([stale, d()], { observedAt: at }).metrics.priceRangeBps, null);
});
test('14 no-lookahead rejects future receipt/provider/consumption and future creation', () => {
  assert.throws(() => record('gmgn', {}, at + 1), /NO_LOOKAHEAD/);
  assert.throws(() => frozenSnapshot([{ ...g(), receivedAt: at + 1 }]), /NO_LOOKAHEAD/);
  assert.throws(() => normalizeLaunchEvent({ ...event, observedAt: at + 1 }, { receivedAt: at }), /NO_LOOKAHEAD/);
  const future = structuredClone(gmgnPayload); future.data.creation_timestamp = at / 1000 + 100;
  assert.equal(normalizeGmgn(result(future), { mint })[0].normalized.createdAt, null);
});
test('15 missing values are null, genuine provider zero remains zero', () => {
  const f = frozenSnapshot([g()])[0].features; assert.equal(f.gmgnRatTraderCount, 0); assert.equal(f.gmgnRugRatio, null); assert.equal(f.dexBuys5m, null);
});
test('16 deterministic descriptive disagreement and unique source counts', () => {
  const r = disagreement([g(), d()], { observedAt: at }).metrics;
  assert.equal(r.sourceCount, 2); assert.equal(r.priceMedianUsd, 2.1); assert(Math.abs(r.priceRangeBps - 952.38095238) < 0.00001); assert.equal(r.contributors.price.length, 2);
  const compatible = [record('one', { priceUsd: 2, liquidityUsd: 100, liquidityScope: 'pair:A', volume5mUsd: 10, volumeWindowMs: 300000, volumeScope: 'pair:A' }), record('two', { priceUsd: 3, liquidityUsd: 200, liquidityScope: 'pair:A', volume5mUsd: 20, volumeWindowMs: 300000, volumeScope: 'pair:A' })];
  const m = disagreement(compatible, { observedAt: at }).metrics; assert.equal(m.liquidityMaxRatio, 2); assert.equal(m.volumeDisagreementRatio, 2);
  assert.equal(disagreement([d(), d()], { observedAt: at }).metrics.priceRangeBps, null);
  const nonpositive = record('invalid-price', { priceUsd: 0 });
  assert.equal(disagreement([g(), d(), nonpositive], { observedAt: at }).metrics.contributors.price.length, 2);
});
test('17 incompatible windows/scopes and unaligned timestamps refused', () => {
  const a = record('a', { priceUsd: 1, volume5mUsd: 10, volumeScope: 'same', volumeWindowMs: 300000 });
  const b = record('b', { priceUsd: 2, volume5mUsd: 20, volumeScope: 'same', volumeWindowMs: 86400000 });
  assert.equal(disagreement([a, b], { observedAt: at }).metrics.volumeComparable, false);
  assert.equal(disagreement([g(), d()], { observedAt: at }).metrics.liquidityComparable, false);
  assert.equal(disagreement([a, { ...b, providerObservedAt: at - 20000 }], { observedAt: at, alignmentMs: 1000 }).metrics.priceRangeBps, null);
});
test('18 canonical digests stable under object order and replay reconstruction', () => { assert.equal(digest({ z: 1, a: { b: 2, a: 3 } }), digest({ a: { a: 3, b: 2 }, z: 1 })); assert.equal(digest(g()), digest(JSON.parse(canonical(g())))); assert.equal(canonical(frozenSnapshot([g(), d()])), canonical(frozenSnapshot([d(), g()]))); });
test('19 manifest fingerprints stable under input order, files verified', () => {
  assert.equal(manifestFingerprint({ b: '2', a: '1' }), manifestFingerprint({ a: '1', b: '2' }));
  const manifests = [store(), store()].map(s => { s.writeObservation(g(), gmgnPayload); s.writeSnapshot(frozenSnapshot([g()])[0]); return s.finalize({ endedAt: at }); });
  assert.equal(manifests[0].fingerprint, manifests[1].fingerprint);
});
test('20 raw/session storage bounds fail before appending', () => { const s = store({ maxRawBytes: 100 }); assert.throws(() => s.writeObservation(g(), gmgnPayload), /RAW_STORAGE_BOUND/); assert.equal(readFileSync(path.join(s.dir, 'normalized.ndjson'), 'utf8'), ''); const bounded = store({ maxSessionBytes: 17000 }); assert.throws(() => bounded.writeObservation(g(), gmgnPayload), /SESSION_STORAGE_BOUND/); });
test('21 prior sessions never reopened or amended', () => {
  const s = store(); s.writeObservation(g(), gmgnPayload); const manifest = s.finalize({ endedAt: at });
  const before = readFileSync(path.join(s.dir, 'manifest.json'), 'utf8');
  assert.throws(() => s.writeObservation(g(), gmgnPayload), /finalized/); assert.throws(() => s.finalize(), /finalized/);
  assert.throws(() => createStorage({ root: path.dirname(path.dirname(s.dir)), sessionId: 'fixture' }));
  assert.equal(readFileSync(path.join(s.dir, 'manifest.json'), 'utf8'), before); assert.equal(manifest.fingerprint, manifestFingerprint(manifest.files));
});
test('22 existing Jupiter client/feed/config/normalize/universe unchanged', () => unchanged(['config', 'feed', 'jupiter', 'normalize', 'universe', 'index'].map(n => `scripts/market/${n}.mjs`)));
test('23 existing market validation unchanged', () => unchanged(['scripts/validate-market.mjs']));
test('24 existing replay unchanged', () => unchanged(['scripts/market/replay.mjs', 'scripts/replay.mjs', 'scripts/smoke-replay.mjs']));
test('25 zero trading authority in all observation/snapshot/disagreement records', () => {
  for (const r of [g(), d(), normalizeLaunchEvent(event, { receivedAt: at }), ...frozenSnapshot([g()]), disagreement([g()], { observedAt: at })]) assert.equal(r.tradingAuthority, false);
  assert.equal(EVIDENCE.paperOnly, true);
});
test('26 no signing capability in provider/module AST', () => audit(FORBIDDEN_SIGNING));
test('27 no execution endpoints/functions in module AST', () => { audit(FORBIDDEN_EXECUTION); for (const r of Object.values(GMGN_ROUTES)) assert(!/\/trade\/|\/cooking\//.test(r.path)); assert.equal(Object.keys(DEX_ROUTES).join(','), 'pairs'); });
test('28 no wallet credentials or requirement', async () => { const p = createLaunchObserver(); assert.equal((await p.start()).unavailable, 'DISABLED_UNVERIFIED_TRANSPORT'); assert.deepEqual(await p.poll(), []); assert.equal(config.launch.transportImplemented, false); audit(/^(wallet|Keypair|Wallet)$/); });
test('29 secrets excluded recursively from persisted raw and normalized output', async () => {
  const c = createIntelligenceConfig({ env: { EVOLVE_GMGN_API_KEY: key } });
  const payload = { ...gmgnPayload, metadata: { apiKey: key, description: `prefix ${key}`, ...FORBIDDEN_FIXTURE_FIELDS } };
  const p = createGmgnProvider({ config: c.gmgn, now: () => at, fetchImpl: async () => response(payload) });
  const r = await p.observe('info', mint); const s = store({ secrets: c.secrets });
  s.writeObservation(normalizeGmgn(r, { mint })[0], r.payload); s.finalize({ endedAt: at, health: { text: key, apiKey: key } });
  for (const f of files(s.dir)) { const body = readFileSync(f, 'utf8'); assert(!body.includes(key)); assert(!body.includes('not retained')); }
  assert.deepEqual(redact({ authorization: key, nested: { description: key } }, [key]), { nested: { description: '[REDACTED]' } });
});
test('30 provider errors independently recorded while other source survives', async () => {
  const s = store(); const recorder = createIntelligenceRecorder({ config, storage: s, now: () => at,
    dex: { observe: async () => result(dexPayload, 'pairs'), health: () => ({ state: 'HEALTHY', errors: 0 }) },
    gmgn: { observe: async () => { throw new Error('fixture failure'); }, health: () => ({ state: 'DEGRADED', errors: 1 }) },
    launch: { poll: async () => { throw new Error('fixture launch failure'); }, health: () => ({ state: 'DEGRADED', errors: 1, events: 0 }), stop: () => {} } });
  const captured = await recorder.capture({ mints: [mint] }); assert.equal(captured.snapshots[0].features.dexLiquidityUsd, 900); assert(captured.errors > 0);
  const manifest = recorder.finalize(); assert(manifest.errorCounts.gmgn > 0); assert(manifest.errorCounts['launch-observer'] > 0);
});
test('31 unavailable provider cannot fabricate data and empty responses recorded raw', async () => {
  const s = store(); const r = createIntelligenceRecorder({ config, storage: s, now: () => at,
    dex: { observe: async () => result([], 'pairs'), health: () => ({ errors: 0 }) } });
  const c = await r.capture({ mints: [mint] }); assert.deepEqual(c.snapshots, []); r.finalize(); assert(readFileSync(path.join(s.dir, 'raw/dexscreener.ndjson'), 'utf8').includes('"payload":[]'));
});
test('32 all research features development-only with exact contributor identities', () => {
  const s = frozenSnapshot([g(), d()])[0]; assert.equal(s.developmentOnly, true); assert.equal(s.observerOnly, true); assert.deepEqual(Object.keys(s.features), [...FEATURE_NAMES]); assert.equal(s.contributors.dexLiquidityUsd.normalizedPayloadDigest, d().normalizedPayloadDigest);
});
function noConsumption(paths) { for (const file of paths) assert(!/market-intelligence|gmgnSmartMoneyCount|crossSourcePriceRangeBps/.test(readFileSync(file, 'utf8')), file); }
test('33 no feature reaches production gates', () => noConsumption(files('scripts/engine')));
test('34 no feature reaches fitness', () => unchanged(['scripts/engine/simulation.mjs', 'scripts/engine/genome.mjs']));
test('35 no feature reaches Arena or research promotion', () => noConsumption([...files('scripts/arena'), ...files('scripts/research')]));


test('36 GMGN pool/participant/Trenches route fixtures preserve exact scopes', () => {
  const pool = normalizeGmgn(result({ code: 0, data: { address: other, price: '2', liquidity: 55, creation_timestamp: at / 1000 - 2 } }, 'pool'), { mint })[0];
  assert.equal(pool.mint, mint); assert.equal(pool.normalized.liquidityScope, `pair:${other}`); assert.equal(pool.normalized.poolCreatedAt, at - 2000);
  const participants = normalizeGmgn(result({ code: 0, data: { list: [{ address: other, amount_percentage: '0.1', tags: ['smart_degen'] }] } }, 'holders'), { mint })[0];
  assert.equal(participants.normalized.participants[0].holdingRatio, 0.1); assert.equal(participants.normalized.walletTags, null);
  const trenches = normalizeGmgn(result({ code: 0, data: { new_creation: [{ address: mint, created_timestamp: at / 1000 - 1, usd_market_cap: 100, volume_1h: 55, buys_24h: 2, smart_degen_count: 4, renowned_count: 2, rug_ratio: 0.1, launchpad_platform: 'Pump.fun' }] } }, 'trenches'))[0];
  assert.equal(trenches.normalized.marketCapUsd, 100); assert.equal(trenches.normalized.marketVolumes['1h'], 55); assert.equal(trenches.normalized.tradeActivity['24h'].buys, 2); assert.equal(trenches.normalized.createdAt, at - 1000); assert.equal(trenches.normalized.priceUsd, null); assert.equal(trenches.normalized.launchPhase, 'new_creation');
  assert.equal(frozenSnapshot([trenches])[0].features.gmgnSmartMoneyCount, 4);
  assert.equal(normalizeGmgn(result({ code: 0, data: {} }, 'security'), { mint })[0].normalized.securityWarnings, null);
});
test('37 timeout covers request and safe error output', async () => {
  const p = createDexProvider({ config: { ...config.dex, timeoutMs: 5 }, now: () => at,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error(key)))) });
  assert.equal((await p.observe(mint)).unavailable, 'OBSERVATION_FAILED'); assert(!JSON.stringify(p.health()).includes(key));
});
test('38 generic transport cannot add execution methods or origins', async () => {
  assert.throws(() => createObservationTransport({ config: { ...config.dex, baseUrl: 'https://evil.example' }, origin: 'https://evil.example', routes: {} }));
  let called = false;
  const p = createObservationTransport({ config: config.dex, origin: 'https://api.dexscreener.com', routes: { invented: { method: 'POST', path: '/token-pairs/v1/solana/' + mint } }, now: () => at, fetchImpl: async () => { called = true; return response([]); } });
  assert.equal((await p.read('invented', mint)).unavailable, 'OBSERVATION_FAILED'); assert.equal(called, false);
});
test('39 public dashboard exposes summary counts/enums only', () => {
  const s = store(); s.writeObservation(g(), gmgnPayload); s.finalize({ endedAt: at, health: { jupiter: { effectiveMode: 'live', healthy: false, degraded: true }, gmgn: { state: key, apiKey: key }, launch: { state: 'DISABLED_UNVERIFIED_TRANSPORT' } }, metrics: { mintsJoined: 1, freshJoined: 0, launchEvents: 0, providerErrors: 0, priceRangeBps: { max: 20 }, arbitrary: key } });
  const publicState = loadMarketIntelligenceDashboard(path.dirname(path.dirname(s.dir)));
  assert.equal(publicState.state, 'FINALIZED_SESSION'); assert.equal(publicState.maxPriceRangeBps, 20); assert(!JSON.stringify(publicState).includes(key)); assert.equal(publicState.providers.find(p => p.provider === 'gmgn').state, 'UNAVAILABLE');
  assert.equal(publicState.providers.find(p => p.provider === 'jupiter').state, 'DEGRADED');
  const file = path.join(s.dir, 'summary.json'); const summary = JSON.parse(readFileSync(file, 'utf8')); summary.metrics.mintsJoined = 999; writeFileSync(file, canonical(summary));
  assert.equal(loadMarketIntelligenceDashboard(path.dirname(path.dirname(s.dir))).state, 'NO_FINALIZED_SESSION');
});
test('40 source changes/missing pair fields never mix different DEX pairs', () => {
  const first = d(); first.normalized.liquidityUsd = null; first.normalized.pairCreatedAt = null;
  const second = structuredClone(d()); second.normalized.pairAddress = other; second.normalized.priceUsd = 9;
  first.providerObservedAt += 0; second.providerObservedAt -= 1;
  const s = frozenSnapshot([first, second])[0]; assert.equal(s.features.dexLiquidityUsd, null); assert.equal(s.features.dexVolume5mUsd, first.normalized.volumes.m5);
});
test('41 GMGN request budget and key fallback are deterministic', async () => {
  const c = createIntelligenceConfig({ env: { GMGN_API_KEY: key, EVOLVE_GMGN_MAX_REQUESTS_PER_CYCLE: '1' } });
  assert.equal(c.gmgn.maxRequests, 2, 'configured 1 resolves to the floor of 2');
  let calls = 0;
  const p = createGmgnProvider({ config: c.gmgn, now: () => at, fetchImpl: async () => { calls++; return response(gmgnPayload); } });
  await p.observe('info', mint); await p.observe('security', mint);
  assert.equal((await p.observe('pool', mint)).unavailable, 'CYCLE_BUDGET'); assert.equal(calls, 2);
});

test('42 existing external-intelligence CLI install path stays equivalent', () => assert.equal(AGENT_REACH_PIN.localInstallDir, path.join('.tools', 'agent-reach')));

const hashBytes = value => createHash('sha256').update(value).digest('hex');
// Independent serializer for expected fixture hashes; do not call the production
// canonical/digest or manifest fingerprint helpers to verify their own output.
function expectedJson(value) {
  if (Array.isArray(value)) return `[${value.map(expectedJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${expectedJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function tempRoot() { const root = mkdtempSync(path.join(tmpdir(), 'evolve-5j-remediation-')); temporary.push(root); return root; }
function inertStorage() { return { dir: '/temporary/in-memory-fixture', writeRawResponse() {}, writeObservation() {}, writeSnapshot() {}, error() {}, finalize() {} }; }
const disabledDex = { observe: async () => ({ unavailable: 'DISABLED' }), health: () => ({ state: 'DISABLED', errors: 0 }) };
async function realFeedFixture({ delayMs = 0 } = {}) {
  let time = at;
  const feed = createMarketFeed({ config: createMarketConfig({ JUPITER_API_KEY: key, EVOLVE_MARKET_MODE: 'live' }, { loadEnv: false }),
    now: () => time, fetchImpl: async () => ({ status: 200, json: async () => { time += delayMs; return [{ id: mint, usdPrice: 2, liquidity: 100000 }]; } }) });
  await feed.advance();
  return { feed, now: () => time, advance: ms => { time += ms; } };
}
test('43 real feed/universe missing icon and optional fields capture successfully', async () => {
  const fixture = await realFeedFixture(); const [market] = fixture.feed.markets();
  assert.equal(market.icon, undefined); assert.equal(market.holderCount, null);
  const before = Object.getOwnPropertyDescriptors(market), payload = jupiterAdapterPayload(market);
  assert.equal(payload.icon, null); assert.equal(payload.holderCount, null);
  assert.deepEqual(Object.getOwnPropertyDescriptors(market), before);
  const s = store(); const recorder = createIntelligenceRecorder({ config, feed: fixture.feed, storage: s, now: fixture.now, dex: disabledDex });
  const capture = await recorder.capture(); assert.equal(capture.providers.jupiter, 1); assert.equal(capture.errors, 0);
  recorder.finalize(); fixture.feed.stop();
  const raw = JSON.parse(readFileSync(path.join(s.dir, 'raw/jupiter.ndjson'), 'utf8').trim());
  const normalized = readFileSync(path.join(s.dir, 'normalized.ndjson'), 'utf8').trim().split('\n').map(JSON.parse).find(r => r.provider === 'jupiter');
  assert.equal(raw.payload.icon, null); assert.equal(normalized.normalized.holderCount, null);
  assert.equal(raw.rawResponseDigest, hashBytes(expectedJson(raw.payload)));
  assert.equal(normalized.rawResponseDigest, raw.rawResponseDigest);
  assert.equal(normalized.normalizedPayloadDigest, hashBytes(expectedJson(normalized.normalized)));
  assert.equal(normalizeJupiterMarkets([market], { observedAt: at })[0].rawResponseDigest, raw.rawResponseDigest);
});
test('44 Jupiter adapter preserves array order/null semantics and isolates nonfinite/nondata', async () => {
  const optional = { icon: undefined, extra: undefined, items: [undefined, 0, null, 'x'], nested: { absent: undefined } };
  assert.deepEqual(jupiterAdapterPayload(optional), { icon: null, extra: null, items: [null, 0, null, 'x'], nested: { absent: null } });
  assert.equal(optional.icon, undefined);
  for (const value of [NaN, Infinity, -Infinity, () => {}, 1n, new Date(at)]) assert.throws(() => jupiterAdapterPayload({ value }));
  const fixture = await realFeedFixture(), market = fixture.feed.markets()[0]; let invoked = false;
  const recorder = createIntelligenceRecorder({ config, storage: inertStorage(), now: fixture.now, dex: disabledDex });
  const capture = await recorder.capture({ markets: [market, { ...market, mint: other, icon: () => { invoked = true; } }] });
  fixture.feed.stop(); assert.equal(invoked, false); assert.equal(capture.errors, 1); assert.equal(capture.providers.jupiter, 1); assert.equal(capture.snapshots[0].mint, mint);
});
test('45 delayed real Jupiter response retains source time but receipt/capture follow parsing', async () => {
  const fixture = await realFeedFixture({ delayMs: 5000 }); const s = store();
  const recorder = createIntelligenceRecorder({ config, feed: fixture.feed, storage: s, now: fixture.now, dex: disabledDex });
  await recorder.capture(); recorder.finalize(); fixture.feed.stop();
  const r = readFileSync(path.join(s.dir, 'normalized.ndjson'), 'utf8').trim().split('\n').map(JSON.parse).find(r => r.provider === 'jupiter');
  assert.equal(r.providerObservedAt, at); assert.equal(r.receivedAt, at + 5000); assert.equal(r.capturedAt, at + 5000); assert.equal(r.observedAt, at + 5000);
  assert.equal(r.timestampBasis, 'feed_request_start_and_local_copy'); assert(r.limitations.some(l => l.includes('unavailable')));
  assert.throws(() => aggregate([r], { observedAt: at + 4999 }), /NO_LOOKAHEAD/);
});
test('46 repeated Jupiter feed reads preserve first-copy receipt/raw digest and stale exclusion', async () => {
  const fixture = await realFeedFixture({ delayMs: 5000 }); const s = store();
  const recorder = createIntelligenceRecorder({ config, feed: fixture.feed, storage: s, now: fixture.now, dex: disabledDex });
  await recorder.capture(); fixture.advance(70000); const second = await recorder.capture();
  const raws = readFileSync(path.join(s.dir, 'raw/jupiter.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(raws.length, 1); assert.equal(raws[0].capturedAt, at + 5000);
  const sources = second.snapshots[0].staleness.sourceObservations;
  assert.equal(sources[0].receivedAt, at + 5000); assert.equal(sources[0].rawResponseDigest, raws[0].rawResponseDigest);
  assert.equal(second.snapshots[0].features.crossSourceFreshCount, 0);
  // A newly available source field is new copied evidence even if the legacy
  // feed timestamp did not change. Never assign it the old local receipt.
  await recorder.capture({ markets: [{ ...fixture.feed.markets()[0], icon: 'newly-available' }] });
  recorder.finalize(); fixture.feed.stop();
  const updated = readFileSync(path.join(s.dir, 'raw/jupiter.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(updated.length, 2); assert.equal(updated[1].timestamp, at + 75000); assert.equal(updated[1].capturedAt, at + 75000); assert.equal(updated[1].payload.icon, 'newly-available');
});
test('47 GMGN eventual mint and route coverage independent of universe/budget factors', async () => {
  const routes = ['info', 'security', 'pool', 'holders', 'traders'];
  for (const size of [5, 6, 10, 25, 30, 31, 32, 37]) for (const budget of [2, 3, 6, 11]) {
    const identities = Array.from({ length: size }, (_, i) => `${'1'.repeat(32)}${(i + 1).toString().split('').map(digit => '123456789A'[Number(digit)]).join('')}`);
    const seen = new Map(), calls = [], dexCalls = []; let time = at;
    const c = { ...config, gmgn: { ...config.gmgn, maxRequests: budget }, dex: { ...config.dex, maxRequests: 6 } };
    const recorder = createIntelligenceRecorder({ config: c, storage: inertStorage(), now: () => time,
      gmgn: { observe: async (kind, identity) => { calls.push([kind, identity]); return { kind, endpoint: GMGN_ROUTES[kind].path, requestIdentity: identity ?? null, receivedAt: time, payload: { code: 0, data: kind === 'trenches' ? { new_creation: [] } : { address: identity, list: [] } } }; }, health: () => ({ errors: 0 }) },
      dex: { observe: async identity => { dexCalls.push(identity); return { unavailable: 'DISABLED' }; }, health: () => ({ errors: 0 }) } });
    const cycles = Math.ceil(size * routes.length / Math.min(size, budget - 1)) + routes.length;
    for (let cycle = 0; cycle < cycles; cycle++) {
      time += 30000; const previous = calls.length; const capture = await recorder.capture({ mints: identities }); assert.equal(capture.errors, 0);
      const requests = calls.slice(previous); assert(requests.length <= budget); assert.equal(requests.filter(([kind]) => kind === 'trenches').length, 1);
      assert(requests.filter(([, identity]) => identity).length <= budget - 1);
      for (const [kind, identity] of requests) if (identity) { if (!seen.has(identity)) seen.set(identity, new Set()); seen.get(identity).add(kind); }
    }
    assert.equal(seen.size, size, `mint coverage size=${size} budget=${budget}`);
    for (const identity of identities) assert.deepEqual([...seen.get(identity)].sort(), [...routes].sort(), `route coverage size=${size} budget=${budget}`);
    assert.equal(new Set(dexCalls).size, size);
  }
});
test('48 GMGN coverage schedule deterministic and route memory follows bounded eligible universe', async () => {
  async function schedule() {
    const calls = []; const recorder = createIntelligenceRecorder({ config, storage: inertStorage(), now: () => at, dex: disabledDex,
      gmgn: { observe: async (kind, identity) => { calls.push([kind, identity]); return { unavailable: 'DISABLED' }; }, health: () => ({}) } });
    for (let i = 0; i < 12; i++) await recorder.capture({ mints: i < 6 ? [mint, other] : [other] });
    await assert.rejects(recorder.capture({ mints: Array.from({ length: 10001 }, (_, i) => String(i)) }), /IDENTITY_BOUND/);
    return calls;
  }
  assert.deepEqual(await schedule(), await schedule());
});
const rawFixture = { payload: {}, receivedAt: at, endpoint: '/fixture', requestIdentity: mint };
test('49 raw provider traversal/absolute inputs and prior-session target rejected', () => {
  const root = tempRoot(); const prior = createStorage({ root, sessionId: 'old', startedAt: at }); prior.writeObservation(g(), gmgnPayload); prior.finalize({ endedAt: at });
  const before = Object.fromEntries(files(prior.dir).map(f => [f, hashBytes(readFileSync(f))]));
  const current = createStorage({ root, sessionId: 'new', startedAt: at });
  for (const provider of ['../../old/raw/gmgn', '/tmp/x', '../gmgn', 'unknown', '__proto__']) assert.throws(() => current.writeRawResponse(rawFixture, provider), /PROVIDER_FORBIDDEN/);
  current.finalize({ endedAt: at });
  assert.deepEqual(Object.fromEntries(files(prior.dir).map(f => [f, hashBytes(readFileSync(f))])), before);
});
test('50 session traversal and absolute session identities rejected before writes', () => {
  const root = tempRoot();
  for (const sessionId of ['../old', '/tmp/x', 'a/b', '..', 'a\\b']) assert.throws(() => createStorage({ root, sessionId }), /Invalid session/);
  assert.deepEqual(readdirSync(root), []);
});
test('51 existing sessions symlink cannot redirect session creation', () => {
  const root = tempRoot(), outside = tempRoot(); symlinkSync(outside, path.join(root, 'sessions'), 'dir');
  assert.throws(() => createStorage({ root, sessionId: 'fixture' }), /SYMLINK_FORBIDDEN/); assert.deepEqual(readdirSync(outside), []);
});
test('52 session child directory symlink blocks appends', () => {
  const s = store(), outside = tempRoot(); const rawDir = path.join(s.dir, 'raw'); renameSync(rawDir, path.join(s.dir, 'original-raw')); symlinkSync(outside, rawDir, 'dir');
  assert.throws(() => s.writeRawResponse(rawFixture, 'gmgn'), /SYMLINK_FORBIDDEN/); assert.deepEqual(readdirSync(outside), []);
});
test('53 raw destination symlink cannot append to external or prior evidence', () => {
  const s = store(), outside = tempRoot(), target = path.join(outside, 'evidence.ndjson'); writeFileSync(target, 'unchanged\n');
  const file = path.join(s.dir, 'raw/gmgn.ndjson'); unlinkSync(file); symlinkSync(target, file);
  assert.throws(() => s.writeRawResponse(rawFixture, 'gmgn'), /SYMLINK_FORBIDDEN/); assert.equal(readFileSync(target, 'utf8'), 'unchanged\n');
});
test('54 finalized storage rejects all append methods and reopening', () => {
  const s = store(); const snapshot = frozenSnapshot([g()])[0]; s.finalize({ endedAt: at });
  const before = Object.fromEntries(files(s.dir).map(f => [f, hashBytes(readFileSync(f))]));
  for (const operation of [() => s.writeRawResponse(rawFixture, 'gmgn'), () => s.writeObservation(g(), gmgnPayload), () => s.writeSnapshot(snapshot), () => s.error('gmgn', 'FIXTURE', at)]) assert.throws(operation, /finalized/);
  assert.throws(() => createStorage({ root: path.dirname(path.dirname(s.dir)), sessionId: 'fixture' }));
  assert.deepEqual(Object.fromEntries(files(s.dir).map(f => [f, hashBytes(readFileSync(f))])), before);
});
test('55 replaced regular append target fails its original file identity check', () => {
  const s = store(), file = path.join(s.dir, 'raw/gmgn.ndjson'); renameSync(file, file + '.original'); writeFileSync(file, 'replacement\n');
  assert.throws(() => s.writeRawResponse(rawFixture, 'gmgn'), /IDENTITY_MISMATCH/); assert.equal(readFileSync(file, 'utf8'), 'replacement\n');
});
test('56 finalization rejects destination and temporary symlinks', () => {
  for (const name of ['summary.json', 'summary.json.tmp', 'manifest.json', 'manifest.json.tmp']) {
    const s = store(), outside = tempRoot(), target = path.join(outside, 'protected'); writeFileSync(target, 'unchanged'); symlinkSync(target, path.join(s.dir, name));
    assert.throws(() => s.finalize({ endedAt: at }), /SYMLINK_FORBIDDEN/); assert.equal(readFileSync(target, 'utf8'), 'unchanged');
  }
});
function permutations(items) { return items.length ? items.flatMap((item, i) => permutations(items.filter((_, j) => j !== i)).map(rest => [item, ...rest])) : [[]]; }
test('57 repeated payload observations retain provenance and serialization under every permutation', () => {
  const payload = d().normalized;
  const rs = [record('gmgn', payload, at - 2), record('gmgn', payload, at - 1), record('dexscreener', payload, at - 1)];
  const serialized = permutations(rs).map(input => expectedJson(aggregate(input, { observedAt: at })));
  assert.equal(new Set(serialized).size, 1);
  const snapshot = JSON.parse(serialized[0])[0], sources = snapshot.staleness.sourceObservations;
  assert.equal(sources.length, 3); assert.equal(new Set(sources.map(s => s.observationDigest)).size, 3);
  assert.deepEqual(sources.map(s => s.providerObservedAt).sort(), [at - 2, at - 1, at - 1]);
  for (const { observationDigest, ...source } of sources) assert.equal(observationDigest, hashBytes(expectedJson(source)));
  assert.equal(snapshot.normalizedPayloadDigest, hashBytes(expectedJson({ features: snapshot.features, contributors: snapshot.contributors, sourceObservations: sources })));
  assert.equal(new Set(permutations(rs).map(input => aggregate(input, { observedAt: at })[0].normalizedPayloadDigest)).size, 1);
});
test('58 repeated-payload permutations produce identical on-disk manifests', () => {
  const rs = [record('gmgn', { priceUsd: 2 }, at - 1), record('gmgn', { priceUsd: 2 }, at)];
  const hashes = permutations(rs).map(input => { const s = store(); s.writeSnapshot(aggregate(input, { observedAt: at })[0]); return s.finalize({ endedAt: at }).fingerprint; });
  assert.equal(new Set(hashes).size, 1);
});
test('59 missing price cannot gate matching liquidity or volume evidence', () => {
  const rs = [record('a', { priceUsd: null, liquidityUsd: 100, liquidityScope: 'pair:A', volume5mUsd: 10, volumeScope: 'pair:A', volumeWindowMs: 300000 }), record('b', { priceUsd: 2, liquidityUsd: 200, liquidityScope: 'pair:A', volume5mUsd: 40, volumeScope: 'pair:A', volumeWindowMs: 300000 })];
  const m = disagreement(rs, { observedAt: at }).metrics;
  assert.equal(m.priceMedianUsd, null); assert.equal(m.liquidityComparable, true); assert.equal(m.liquidityMedianUsd, (100 + 200) / 2); assert.equal(m.liquidityMaxRatio, 200 / 100);
  assert.equal(m.volumeComparable, true); assert.equal(m.volumeDisagreementRatio, 40 / 10); assert.equal(m.contributors.liquidity.length, 2); assert.equal(m.contributors.volume.length, 2);
});
test('60 missing liquidity cannot gate price; missing volume cannot gate holders', () => {
  const m = disagreement([record('a', { priceUsd: 2, liquidityUsd: null, volume5mUsd: null, holderCount: 100 }), record('b', { priceUsd: 4, liquidityUsd: 200, volume5mUsd: null, holderCount: 125 })], { observedAt: at }).metrics;
  assert.equal(m.priceMedianUsd, (2 + 4) / 2); assert.equal(m.priceRangeBps, (4 - 2) / 3 * 10000); assert.equal(m.priceMaxDeviationBps, 1 / 3 * 10000);
  assert.equal(m.holderCountRange, 125 - 100); assert.equal(m.contributors.holders.length, 2); assert.equal(m.volumeComparable, false);
});
test('61 stale records removed independently while valid metric contributors remain', () => {
  const m = disagreement([record('a', { priceUsd: 1, liquidityUsd: 99999, liquidityScope: 'pair:A' }, at - 70000), record('b', { priceUsd: 2, liquidityUsd: 100, liquidityScope: 'pair:A' }), record('c', { priceUsd: null, liquidityUsd: 200, liquidityScope: 'pair:A' })], { observedAt: at }).metrics;
  assert.equal(m.priceMedianUsd, null); assert.equal(m.liquidityMaxRatio, 2); assert.deepEqual(m.contributors.liquidity.map(s => s.provider), ['b', 'c']); assert.equal(m.freshSourceCount, 2);
});
test('62 cross-source age rejects one provider and selects one timestamp per distinct provider', () => {
  const a = record('a', { priceUsd: 2 }, at - 1000), older = record('a', { priceUsd: 2 }, at - 2000), b = record('b', { priceUsd: 2 }, at - 500);
  assert.equal(disagreement([a, older], { observedAt: at }).metrics.sourceAgeSpreadMs, null);
  assert.equal(aggregate([a, older], { observedAt: at })[0].features.crossSourceAgeSpreadMs, null);
  assert.equal(disagreement([a, b], { observedAt: at }).metrics.sourceAgeSpreadMs, 500);
  for (const input of permutations([a, older, b])) { const m = disagreement(input, { observedAt: at }).metrics; assert.equal(m.sourceAgeSpreadMs, 500); assert.equal(m.contributors.age.length, 2); }
});
test('63 manifest hashes/fingerprint/counts independently recomputed from actual files', () => {
  const s = store(); s.writeObservation(g(), gmgnPayload); s.writeObservation(d(), dexPayload); s.writeSnapshot(frozenSnapshot([g(), d()])[0]); s.error('gmgn', 'FIXTURE', at); s.finalize({ endedAt: at });
  const manifest = JSON.parse(readFileSync(path.join(s.dir, 'manifest.json'), 'utf8'));
  const actual = Object.fromEntries(files(s.dir).filter(f => path.basename(f) !== 'manifest.json').map(f => [path.relative(s.dir, f).split(path.sep).join('/'), hashBytes(readFileSync(f))]));
  assert.deepEqual(manifest.files, actual); assert.equal(manifest.fingerprint, hashBytes(expectedJson(actual))); assert(!Object.hasOwn(actual, 'manifest.json'));
  for (const [name, count] of Object.entries(manifest.fileRecordCounts)) assert.equal(readFileSync(path.join(s.dir, name), 'utf8').trim().split('\n').length, count);
  assert.equal(manifest.recordCount, 3); assert.equal(manifest.fileRecordCounts['normalized.ndjson'], 3); assert.equal(manifest.errorCounts.gmgn, 1);
});

// GMGN cadence fairness: cursors advance only for provider-serviced or attempted
// calls, so eventual coverage must hold at every capture frequency.
const ROUTE_KINDS = ['info', 'security', 'pool', 'holders', 'traders'];
const kindForPath = pathname => pathname === '/v1/trenches' ? 'trenches' : pathname === '/v1/token/info' ? 'info' : pathname === '/v1/token/security' ? 'security'
  : pathname === '/v1/token/pool_info' ? 'pool' : pathname === '/v1/market/token_top_holders' ? 'holders' : pathname === '/v1/market/token_top_traders' ? 'traders' : null;
const stressIdentities = size => Array.from({ length: size }, (_, i) => `${'1'.repeat(32)}${(i + 1).toString().split('').map(digit => '123456789A'[Number(digit)]).join('')}`);
async function cadenceCoverage({ size, budget, frequency, cacheMs = 0 }) {
  let time = at;
  const requested = new Map();
  const provider = createGmgnProvider({
    config: { ...config.gmgn, apiKey: key, maxRequests: budget, pollMs: 30000, cacheMs, spacingMs: 0, timeoutMs: 1000 },
    now: () => time, sleep: async () => {},
    fetchImpl: async url => {
      const kind = kindForPath(url.pathname), id = url.searchParams.get('address') ?? null;
      if (id && kind) { if (!requested.has(id)) requested.set(id, new Set()); requested.get(id).add(kind); }
      return response({ code: 0, data: kind === 'trenches' ? { new_creation: [] } : { address: id, list: [] } });
    },
  });
  const recorder = createIntelligenceRecorder({ config: { ...config, gmgn: { ...config.gmgn, maxRequests: budget }, dex: { ...config.dex, maxRequests: 1 } },
    storage: inertStorage(), now: () => time, dex: disabledDex, gmgn: provider });
  const idents = stressIdentities(size);
  const maxWindows = 5 * size + 5;
  let windows = 0;
  for (; windows < maxWindows; windows++) {
    for (let f = 0; f < frequency; f++) { await recorder.capture({ mints: idents }); time += Math.floor(30000 / frequency); }
    time += 1;
    if (idents.every(m => requested.get(m)?.size === ROUTE_KINDS.length)) break;
  }
  recorder.finalize();
  return { windows: windows + 1, requested };
}
test('64 GMGN eventual coverage holds at every capture cadence (real provider budget)', async () => {
  let worst = 0, worstCase = '';
  for (const size of [1, 5, 10, 30, 31, 37]) for (const budget of [2, 3, 6, 11]) for (const frequency of [1, 2, 5, 6, 10, 30]) {
    const { windows, requested } = await cadenceCoverage({ size, budget, frequency });
    const label = `size=${size} budget=${budget} F=${frequency}`;
    assert.equal(requested.size, size, `no mint starvation: ${label}`);
    for (const [id, routes] of requested) assert.deepEqual([...routes].sort(), [...ROUTE_KINDS].sort(), `no endpoint-family starvation: ${label} mint=${id.slice(0, 8)}`);
    if (windows > worst) { worst = windows; worstCase = label; }
  }
  console.log(`  worst-case full coverage: ${worst} windows (${worstCase})`);
  for (const [size, budget, frequency] of [[1, 2, 5], [5, 6, 5]]) {
    const { requested } = await cadenceCoverage({ size, budget, frequency });
    for (const [id, routes] of requested) assert.deepEqual([...routes].sort(), [...ROUTE_KINDS].sort(), `prior failing case now passes: size=${size} budget=${budget} F=${frequency} mint=${id.slice(0, 8)}`);
  }
});
test('65 blocked GMGN results never advance cursors; the pending route is retried, not skipped', async () => {
  const script = ['attempt', 'BACKOFF', 'BACKOFF', 'attempt', 'BUSY', 'attempt', 'CYCLE_BUDGET', 'attempt', 'attempt', 'attempt'];
  const calls = [];
  const recorder = createIntelligenceRecorder({ config: { ...config, gmgn: { ...config.gmgn, maxRequests: 6 }, dex: { ...config.dex, maxRequests: 1 } },
    storage: inertStorage(), now: () => at, dex: disabledDex,
    gmgn: { observe: async (kind, id) => {
      if (kind === 'trenches') return { kind, endpoint: GMGN_ROUTES[kind].path, requestIdentity: null, receivedAt: at, payload: { code: 0, data: { new_creation: [] } } };
      const outcome = script.shift() ?? 'attempt';
      calls.push([kind, id ?? null, outcome]);
      return outcome === 'attempt' ? { kind, endpoint: GMGN_ROUTES[kind].path, requestIdentity: id ?? null, receivedAt: at, payload: { code: 0, data: { address: id, list: [] } } }
        : { unavailable: outcome, requestAttempted: false };
    }, health: () => ({ errors: 0 }) } });
  for (let i = 0; i < 10; i++) await recorder.capture({ mints: [mint] });
  recorder.finalize();
  assert.deepEqual(calls, [
    ['info', mint, 'attempt'], ['security', mint, 'BACKOFF'], ['security', mint, 'BACKOFF'], ['security', mint, 'attempt'], ['pool', mint, 'BUSY'],
    ['pool', mint, 'attempt'], ['holders', mint, 'CYCLE_BUDGET'], ['holders', mint, 'attempt'], ['traders', mint, 'attempt'], ['info', mint, 'attempt'],
  ]);
  assert.deepEqual(calls.filter(([, , outcome]) => outcome === 'attempt').map(([kind]) => kind), ['info', 'security', 'pool', 'holders', 'traders', 'info']);

  // mint cursor fairness: a mint blocked mid-capture is serviced first next capture
  const minted = [];
  const mintScript = ['attempt', 'BUSY', 'attempt', 'attempt'];
  const second = createIntelligenceRecorder({ config: { ...config, gmgn: { ...config.gmgn, maxRequests: 6 } }, storage: inertStorage(), now: () => at, dex: disabledDex,
    gmgn: { observe: async (kind, id) => {
      if (kind === 'trenches') return { kind, endpoint: GMGN_ROUTES[kind].path, requestIdentity: null, receivedAt: at, payload: { code: 0, data: { new_creation: [] } } };
      const outcome = mintScript.shift() ?? 'attempt';
      minted.push([kind, id, outcome]);
      return outcome === 'attempt' ? { kind, endpoint: GMGN_ROUTES[kind].path, requestIdentity: id, receivedAt: at, payload: { code: 0, data: { address: id, list: [] } } } : { unavailable: outcome, requestAttempted: false };
    }, health: () => ({ errors: 0 }) } });
  const pair = stressIdentities(2), [firstMint, secondMint] = pair;
  await second.capture({ mints: pair }); await second.capture({ mints: pair });
  assert.deepEqual(minted, [['info', firstMint, 'attempt'], ['info', secondMint, 'BUSY'], ['info', secondMint, 'attempt'], ['security', firstMint, 'attempt']]);
});
test('66 an attempted HTTP failure progresses the route (fairness, no hammering)', async () => {
  let directCalls = 0;
  const direct = createGmgnProvider({ config: { ...config.gmgn, apiKey: key, maxRequests: 6, cacheMs: 0, spacingMs: 0 },
    now: () => at, sleep: async () => {}, fetchImpl: async () => { directCalls++; return response({}, 500); } });
  const failed = await direct.observe('info', mint);
  assert.equal(failed.unavailable, 'HTTP_500'); assert.equal(failed.requestAttempted, true);
  const blocked = await direct.observe('security', mint);
  assert.equal(blocked.unavailable, 'BACKOFF'); assert.equal(blocked.requestAttempted, false);
  assert.equal(directCalls, 1);

  let time = at, calls = 0; const requested = [];
  const provider = createGmgnProvider({ config: { ...config.gmgn, apiKey: key, maxRequests: 6, cacheMs: 0, spacingMs: 0 }, now: () => time, sleep: async () => {},
    fetchImpl: async url => {
      calls++;
      const kind = kindForPath(url.pathname), id = url.searchParams.get('address') ?? null;
      if (id) requested.push(kind);
      return calls === 1 ? response({}, 500) : response({ code: 0, data: kind === 'trenches' ? { new_creation: [] } : { address: id, list: [] } });
    } });
  const recorder = createIntelligenceRecorder({ config: { ...config, gmgn: { ...config.gmgn, maxRequests: 6 } }, storage: inertStorage(), now: () => time, dex: disabledDex, gmgn: provider });
  for (let window = 0; window < 5; window++) { await recorder.capture({ mints: [mint] }); time += 30001; }
  recorder.finalize();
  assert.equal(requested[0], 'info', 'first attempt is the failed route');
  assert.equal(requested[1], 'security', 'failed route is not retried; the next route is attempted');
  assert.deepEqual([...new Set(requested)].sort(), [...ROUTE_KINDS].sort());
});
test('67 cache-served results keep GMGN progression without stalling', async () => {
  let used = 0;
  const direct = createGmgnProvider({ config: { ...config.gmgn, apiKey: key, cacheMs: 60000, spacingMs: 0 }, now: () => at, sleep: async () => {},
    fetchImpl: async () => { used++; return response({ code: 0, data: { address: mint, list: [] } }); } });
  const first = await direct.observe('info', mint), cachedValue = await direct.observe('info', mint);
  assert.equal(first.requestAttempted, true); assert.equal(cachedValue.requestAttempted, false);
  assert.equal(cachedValue.servedFromCache, true); assert.equal(used, 1); assert.equal(cachedValue.receivedAt, first.receivedAt);

  let time = at; const log = [];
  const provider = createGmgnProvider({ config: { ...config.gmgn, apiKey: key, maxRequests: 2, pollMs: 30000, cacheMs: 300000, spacingMs: 0 }, now: () => time, sleep: async () => {},
    fetchImpl: async url => response({ code: 0, data: url.pathname === '/v1/trenches' ? { new_creation: [] } : { address: url.searchParams.get('address'), list: [] } }) });
  const recorder = createIntelligenceRecorder({ config: { ...config, gmgn: { ...config.gmgn, maxRequests: 2 } }, storage: inertStorage(), now: () => time, dex: disabledDex,
    gmgn: { observe: async (kind, id) => { const r = await provider.observe(kind, id); if (id) log.push([kind, r.unavailable ?? (r.servedFromCache ? 'CACHE' : 'REQUEST')]); return r; }, health: provider.health } });
  for (let window = 0; window < 10; window++) { await recorder.capture({ mints: [mint] }); time += 30001; }
  recorder.finalize();
  assert.deepEqual(log.map(([kind]) => kind), [...ROUTE_KINDS, ...ROUTE_KINDS]);
  assert.deepEqual(log.slice(0, 5).map(([, state]) => state), ['REQUEST', 'REQUEST', 'REQUEST', 'REQUEST', 'REQUEST']);
  assert.deepEqual(log.slice(5).map(([, state]) => state), ['CACHE', 'CACHE', 'CACHE', 'CACHE', 'CACHE']);
});
test('68 GMGN cycle budget has a floor of two, so token routes always keep a slot', async () => {
  const floor = createIntelligenceConfig({ env: { EVOLVE_GMGN_MAX_REQUESTS_PER_CYCLE: '1' } });
  assert.equal(floor.gmgn.maxRequests, 2);
  assert.equal(createIntelligenceConfig({ env: { EVOLVE_GMGN_MAX_REQUESTS_PER_CYCLE: '0' } }).gmgn.maxRequests, 2);
  assert.equal(createIntelligenceConfig({ env: { EVOLVE_GMGN_MAX_REQUESTS_PER_CYCLE: '30' } }).gmgn.maxRequests, 30);
  let time = at; const requested = [];
  const provider = createGmgnProvider({ config: { ...floor.gmgn, apiKey: key, cacheMs: 0, spacingMs: 0 }, now: () => time, sleep: async () => {},
    fetchImpl: async url => { const kind = kindForPath(url.pathname); requested.push(kind); return response({ code: 0, data: kind === 'trenches' ? { new_creation: [] } : { address: url.searchParams.get('address'), list: [] } }); } });
  const recorder = createIntelligenceRecorder({ config: { ...config, gmgn: floor.gmgn }, storage: inertStorage(), now: () => time, dex: disabledDex, gmgn: provider });
  for (let window = 0; window < 5; window++) { await recorder.capture({ mints: [mint] }); time += 30001; }
  recorder.finalize();
  assert.equal(requested.filter(k => k === 'trenches').length, 5, 'one Trenches slot per window');
  assert.deepEqual([...new Set(requested.filter(k => ROUTE_KINDS.includes(k)))].sort(), [...ROUTE_KINDS].sort(), 'token-route slot rotates all five routes');
});
test('69 DexScreener budget and state cannot influence GMGN progression', async () => {
  const run = async dexMax => {
    const calls = [];
    const recorder = createIntelligenceRecorder({ config: { ...config, gmgn: { ...config.gmgn, maxRequests: 6 }, dex: { ...config.dex, maxRequests: dexMax } },
      storage: inertStorage(), now: () => at,
      dex: { observe: async id => ({ kind: 'pairs', endpoint: '/token-pairs/v1/solana/x', requestIdentity: id, receivedAt: at, payload: [] }), health: () => ({ errors: 0 }) },
      gmgn: { observe: async (kind, id) => { calls.push([kind, id ?? null]); return { kind, endpoint: GMGN_ROUTES[kind].path, requestIdentity: id ?? null, receivedAt: at, payload: { code: 0, data: { address: id, list: [] } } }; }, health: () => ({ errors: 0 }) } });
    const idents = stressIdentities(10);
    for (let i = 0; i < 6; i++) await recorder.capture({ mints: idents });
    recorder.finalize();
    return calls;
  };
  assert.deepEqual(await run(1), await run(30));
});
test('70 universe shrink keeps GMGN cursors bounded and coverage intact', async () => {
  let time = at; const requested = new Map();
  const provider = createGmgnProvider({ config: { ...config.gmgn, apiKey: key, maxRequests: 6, pollMs: 30000, cacheMs: 0, spacingMs: 0 }, now: () => time, sleep: async () => {},
    fetchImpl: async url => {
      const kind = kindForPath(url.pathname), id = url.searchParams.get('address');
      if (id) { if (!requested.has(id)) requested.set(id, new Set()); requested.get(id).add(kind); }
      return response({ code: 0, data: kind === 'trenches' ? { new_creation: [] } : { address: id, list: [] } });
    } });
  const recorder = createIntelligenceRecorder({ config: { ...config, gmgn: { ...config.gmgn, maxRequests: 6 } }, storage: inertStorage(), now: () => time, dex: disabledDex, gmgn: provider });
  const big = stressIdentities(37), small = big.slice(0, 3);
  for (let i = 0; i < 4; i++) { await recorder.capture({ mints: big }); time += 30001; }
  requested.clear();
  for (let i = 0; i < 40 && !small.every(m => requested.get(m)?.size === ROUTE_KINDS.length); i++) { await recorder.capture({ mints: small }); time += 30001; }
  recorder.finalize();
  assert.deepEqual([...requested.keys()].sort(), [...small].sort(), 'no stale-mint selections after shrink');
  for (const m of small) assert.deepEqual([...requested.get(m)].sort(), [...ROUTE_KINDS].sort(), `shrunk mint keeps all five routes: ${m.slice(0, 8)}`);
});

// Phase 5J.1 capture capacity: the first governed shakedown reached the fixed
// 64 MiB append ceiling (~67 MiB in ~12 minutes) and finalized incomplete.
// Capacity is now bounded configuration. Fixtures inject a small cap into
// temporary storage; nothing here reads or writes 512 MiB or existing evidence.
const MIB = 1024 * 1024, SMALL_CAP = 64 * 1024, SMALL_USABLE = SMALL_CAP - 16384;
const LIVE_SESSIONS = path.resolve('.evolve/market-intelligence/sessions');
// Finalized live sessions are immutable, so their bytes are compared across the whole run
// (an in-progress capture beside validation may still append to its own unfinalized session).
function finalizedEvidence() {
  if (!existsSync(LIVE_SESSIONS)) return {};
  return Object.fromEntries(readdirSync(LIVE_SESSIONS).filter(id => existsSync(path.join(LIVE_SESSIONS, id, 'manifest.json'))).sort()
    .map(id => [id, Object.fromEntries(files(path.join(LIVE_SESSIONS, id)).sort().map(f => [path.relative(LIVE_SESSIONS, f), hashBytes(readFileSync(f))]))]));
}
const liveEvidenceBefore = finalizedEvidence();
const sessionBytes = dir => files(dir).filter(f => !['summary.json', 'manifest.json'].includes(path.basename(f))).reduce((n, f) => n + statSync(f).size, 0);
const treeBytes = dir => files(dir).reduce((n, f) => n + statSync(f).size, 0);
const treeHashes = dir => Object.fromEntries(files(dir).sort().map(f => [path.relative(dir, f), hashBytes(readFileSync(f))]));
// A DexScreener-sized raw response: unknown fields are retained raw, never normalized.
const paddedDex = [{ ...dexPayload[0], fixturePadding: 'p'.repeat(12000) }];
const paddedObservation = () => normalizeDex(result(paddedDex, 'pairs'))[0];
function appendSize(write) { const probe = store({ maxSessionBytes: SMALL_CAP }); const before = sessionBytes(probe.dir); write(probe); return sessionBytes(probe.dir) - before; }
// Fill a small-cap session with deterministic observations until the next one cannot fit.
function boundedSession() {
  const s = store({ maxSessionBytes: SMALL_CAP }), size = appendSize(p => p.writeObservation(paddedObservation(), paddedDex));
  const start = sessionBytes(s.dir), fits = Math.floor((SMALL_USABLE - start) / size);
  for (let i = 1; i <= fits; i++) { s.writeObservation(paddedObservation(), paddedDex); assert.equal(sessionBytes(s.dir), start + i * size); }
  const hashes = treeHashes(s.dir), bytes = sessionBytes(s.dir);
  assert.throws(() => s.writeObservation(paddedObservation(), paddedDex), { message: 'SESSION_STORAGE_BOUND' });
  assert.deepEqual(treeHashes(s.dir), hashes, 'a bounded append writes nothing'); assert.equal(sessionBytes(s.dir), bytes);
  return { s, size, start, fits, bytes };
}

test('71 default session capacity is 512 MiB; raw bound and reserve unchanged', () => {
  const c = createIntelligenceConfig({ env: {} });
  assert.equal(c.maxSessionMiB, 512); assert.equal(c.maxSessionBytes, 512 * MIB); assert.equal(c.maxRawBytes, 256 * 1024);
  assert.deepEqual({ ...SESSION_CAPACITY_MIB }, { default: 512, min: 64, max: 2048 });
  const s = store(); assert.equal(JSON.parse(readFileSync(path.join(s.dir, 'session.json'), 'utf8')).maxSessionBytes, 512 * MIB);
  assert.equal(s.finalize({ endedAt: at }).storage.maxSessionBytes, 512 * MIB);
});
const capacityCases = [[undefined, 512], ['64', 64], ['512', 512], ['2048', 2048], ['1', 64], ['99999', 2048]];
const capacity = value => createIntelligenceConfig({ env: value === undefined ? {} : { EVOLVE_INTELLIGENCE_MAX_SESSION_MIB: value } });
function assertCapacity(value, mib) {
  const c = capacity(value);
  assert.equal(c.maxSessionMiB, mib, `${JSON.stringify(value)} -> ${mib} MiB`); assert.equal(c.maxSessionBytes, mib * MIB);
  assert(Number.isSafeInteger(c.maxSessionBytes) && c.maxSessionBytes >= 64 * MIB && c.maxSessionBytes <= 2048 * MIB, 'finite positive bounded capacity');
}
test('72 capacity lower clamp: 1/0 -> 64 MiB; 64 stays 64 MiB', () => {
  for (const [value, mib] of capacityCases.filter(([, mib]) => mib === 64)) assertCapacity(value, mib);
  assertCapacity('0', 64); assertCapacity(' 1 ', 64);
});
test('73 capacity upper clamp: 99999/huge -> 2048 MiB; 512/2048 preserved', () => {
  for (const [value, mib] of capacityCases.filter(([, mib]) => mib !== 64)) assertCapacity(value, mib);
  assertCapacity('9'.repeat(400), 2048); assertCapacity('1024', 1024);
});
test('74 invalid capacity falls back to 512 MiB; never NaN, Infinity or negative', () => {
  for (const value of ['', '   ', 'abc', 'NaN', 'Infinity', '-Infinity', '-5', '-64', '12.5', '1e3', '0x200', '64MiB', '+512'])
    assertCapacity(value, 512);
  for (const value of [undefined, null, 'NaN', 'Infinity', '-1', '1e309']) assert.equal(sessionCapacityMiB(value), 512);
  // Storage also refuses caps that would disable its bound, before creating anything.
  for (const maxSessionBytes of [NaN, Infinity, -Infinity, -1, 0, 1.5, SESSION_FINALIZATION_RESERVE_BYTES]) {
    const root = tempRoot();
    assert.throws(() => createStorage({ root, sessionId: 'fixture', maxSessionBytes }), { message: 'SESSION_STORAGE_BOUND_INVALID' });
    assert.deepEqual(readdirSync(root), []);
  }
});
test('75 finalization reserve is an explicit 16 KiB constant covering both finalization records', () => {
  assert.equal(SESSION_FINALIZATION_RESERVE_BYTES, 16 * 1024); assert.equal(FINALIZATION_RECORD_MAX_BYTES, 8 * 1024);
  assert(SESSION_FINALIZATION_RESERVE_BYTES >= 2 * FINALIZATION_RECORD_MAX_BYTES, 'summary + manifest fit the reserve');
  const ast = espree.parse(readFileSync('scripts/market-intelligence/storage.mjs', 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' });
  const magic = []; walk(ast, node => { if (node.type === 'Literal' && [16384, 8192, 67108864].includes(node.value)) magic.push(node.value); });
  assert.deepEqual(magic, [], 'capacity arithmetic uses named constants');
});
test('76 exact SESSION_STORAGE_BOUND reproduction at maxSessionBytes - finalizationReserveBytes', () => {
  const { s, size, start, fits, bytes } = boundedSession();
  assert(fits >= 2, 'records append normally below the threshold');
  assert.equal(bytes, start + fits * size); assert(bytes <= SMALL_USABLE && bytes + size > SMALL_USABLE, 'next append crosses the usable ceiling');
  // The incident class: unused headroom remained, but less than one DexScreener-sized append.
  const headroom = SMALL_USABLE - bytes; assert(headroom > 0 && headroom < size, `headroom ${headroom} < append ${size}`);
  // The threshold is exact: smaller records still fit until bytes + next would exceed it.
  const errorSize = appendSize(p => p.error('dexscreener', 'FIXTURE', at)), smallFits = Math.floor(headroom / errorSize);
  for (let i = 0; i < smallFits; i++) s.error('dexscreener', 'FIXTURE', at);
  assert.equal(sessionBytes(s.dir), bytes + smallFits * errorSize);
  assert.throws(() => s.error('dexscreener', 'FIXTURE', at), { message: 'SESSION_STORAGE_BOUND' });
  assert.throws(() => s.writeSnapshot(frozenSnapshot([d()])[0]), { message: 'SESSION_STORAGE_BOUND' });
});
test('77 bounded session still finalizes incomplete with exact storage telemetry', () => {
  const { s, bytes } = boundedSession();
  const manifest = s.finalize({ endedAt: at, reason: 'capture failed' });
  assert.equal(manifest.status, 'incomplete'); assert.equal(manifest.reason, 'capture failed');
  const summary = JSON.parse(readFileSync(path.join(s.dir, 'summary.json'), 'utf8'));
  assert.deepEqual(summary.storage, { bytesBeforeFinalization: bytes, maxSessionBytes: SMALL_CAP, finalizationReserveBytes: 16384,
    usableSessionBytes: SMALL_USABLE, utilizationRatio: Math.round(bytes / SMALL_USABLE * 1e6) / 1e6, sessionBoundReached: true });
  assert.equal(summary.bytesBeforeFinalization, bytes); assert.equal(sessionBytes(s.dir), bytes);
  assert(summary.storage.utilizationRatio > 0 && summary.storage.utilizationRatio <= 1);
  assert(treeBytes(s.dir) <= SMALL_CAP, 'finalized session including summary and manifest stays within the hard cap');
  assert.throws(() => s.writeObservation(paddedObservation(), paddedDex), /Session finalized/);
  const unbounded = store({ maxSessionBytes: SMALL_CAP }); unbounded.writeObservation(g(), gmgnPayload);
  const complete = unbounded.finalize({ endedAt: at }); assert.equal(complete.status, 'complete'); assert.equal(complete.storage.sessionBoundReached, false);
});
test('78 bounded incomplete manifest remains valid and is served as incomplete', () => {
  const { s, fits } = boundedSession(); s.finalize({ endedAt: at, reason: 'capture failed' });
  const manifest = JSON.parse(readFileSync(path.join(s.dir, 'manifest.json'), 'utf8'));
  const actual = Object.fromEntries(files(s.dir).filter(f => path.basename(f) !== 'manifest.json').map(f => [path.relative(s.dir, f).split(path.sep).join('/'), hashBytes(readFileSync(f))]));
  assert.deepEqual(manifest.files, actual); assert.equal(manifest.fingerprint, hashBytes(expectedJson(actual)));
  for (const [name, count] of Object.entries(manifest.fileRecordCounts)) assert.equal(readFileSync(path.join(s.dir, name), 'utf8').trim().split('\n').length, count);
  assert.equal(manifest.fileRecordCounts['raw/dexscreener.ndjson'], fits); assert.equal(manifest.recordCount, fits);
  const { recordType, files: hashes, fingerprint, ...summary } = manifest;
  assert.equal(recordType, 'manifest'); assert(hashes && fingerprint);
  assert.deepEqual(JSON.parse(readFileSync(path.join(s.dir, 'summary.json'), 'utf8')), { ...summary, recordType: 'summary' });
  const publicState = loadMarketIntelligenceDashboard(path.dirname(path.dirname(s.dir)));
  assert.equal(publicState.state, 'FINALIZED_SESSION'); assert.equal(publicState.captureStatus, 'incomplete');
});
test('79 recorder capture reaching the bound fails closed and finalizes incomplete', async () => {
  let time = at;
  const dex = { observe: async m => ({ payload: paddedDex, kind: 'pairs', receivedAt: time, endpoint: DEX_ROUTES.pairs.path(m), requestIdentity: m }), health: () => ({ state: 'HEALTHY', errors: 0 }) };
  const s = store({ maxSessionBytes: SMALL_CAP });
  const recorder = createIntelligenceRecorder({ config: { ...config, dex: { ...config.dex, maxRequests: 1 } }, storage: s, now: () => time, dex });
  let captures = 0, failure = null;
  for (let i = 0; i < 100 && !failure; i++) { try { await recorder.capture({ mints: [mint] }); captures++; time += 30001; } catch (e) { failure = e; } }
  assert(captures >= 2, 'captures proceed normally below the bound'); assert.equal(failure?.message, 'SESSION_STORAGE_BOUND');
  assert.equal(failureLine('capture', failure), '[EVOLVE 5J] capture failed: SESSION_STORAGE_BOUND');
  const manifest = recorder.finalize('capture failed');
  assert.equal(manifest.status, 'incomplete'); assert.equal(manifest.storage.sessionBoundReached, true); assert.equal(manifest.storage.maxSessionBytes, SMALL_CAP);
  assert(manifest.storage.bytesBeforeFinalization <= SMALL_USABLE); assert.equal(manifest.bytesBeforeFinalization, sessionBytes(s.dir));
  assert(treeBytes(s.dir) <= SMALL_CAP);
});
test('80 CLI prints allowlisted failure codes only', () => {
  assert.deepEqual([...SAFE_FAILURE_CODES].sort(), ['FINALIZATION_STORAGE_BOUND', 'NO_LOOKAHEAD_TIMESTAMP', 'RAW_STORAGE_BOUND', 'SESSION_STORAGE_BOUND',
    'SESSION_STORAGE_IDENTITY_BOUND', 'SESSION_STORAGE_RECEIPT_BOUND']);
  for (const code of SAFE_FAILURE_CODES) { assert.equal(safeFailureCode(new Error(code)), code); assert.equal(failureLine('capture', new Error(code)), `[EVOLVE 5J] capture failed: ${code}`); }
  assert.equal(failureLine('probe', new Error('RAW_STORAGE_BOUND')), '[EVOLVE 5J] probe failed: RAW_STORAGE_BOUND');
  // Each code is produced by a real bound, not a fabricated label.
  assert.throws(() => store({ maxRawBytes: 100 }).writeObservation(g(), gmgnPayload), { message: 'RAW_STORAGE_BOUND' });
  assert.throws(() => store().finalize({ endedAt: at, metrics: { fixture: 'x'.repeat(9000) } }), { message: 'FINALIZATION_STORAGE_BOUND' });
  assert.throws(() => aggregate([g()], { observedAt: at - 1 }), { message: 'NO_LOOKAHEAD_TIMESTAMP' });
});
test('81 unknown and non-code failures are redacted to OBSERVATION_FAILED', () => {
  const leaks = [new Error(`https://openapi.gmgn.ai/v1/token/info?api_key=${key}`), new Error(`SESSION_STORAGE_BOUND ${key}`), new Error('session_storage_bound'),
    new Error(JSON.stringify(gmgnPayload)), new TypeError('fetch failed'), 'SESSION_STORAGE_BOUND', null, undefined, { message: 42 }, { message: ['SESSION_STORAGE_BOUND'] }];
  for (const error of leaks) { assert.equal(safeFailureCode(error), 'OBSERVATION_FAILED'); assert(!failureLine('capture', error).includes(key)); }
  assert.equal(failureLine(`https://leak.example/?key=${key}`, new Error('x')), '[EVOLVE 5J] command failed: OBSERVATION_FAILED');
  const cli = spawnSync(process.execPath, ['scripts/market-intelligence.mjs', `https://leak.example/?api_key=${key}`], { encoding: 'utf8', timeout: 30000 });
  assert.equal(cli.status, 1, 'nonzero exit preserved');
  assert.equal(cli.stderr, '[EVOLVE 5J] command failed: OBSERVATION_FAILED\nMarket intelligence command failed; no engine state changed.\n');
  assert(!`${cli.stdout}${cli.stderr}`.includes(key) && !`${cli.stdout}${cli.stderr}`.includes('leak.example'));
});
test('82 doctor exposes bounded storage capacity without paths or secrets', () => {
  const c = createIntelligenceConfig({ env: { EVOLVE_INTELLIGENCE_MAX_SESSION_MIB: '1024', EVOLVE_GMGN_API_KEY: key } });
  const report = doctorReport({ config: c, gmgn: createGmgnProvider({ config: c.gmgn }), dex: createDexProvider({ config: c.dex }), launch: createLaunchObserver({ config: c.launch }) });
  assert.deepEqual(report.storage, { maxSessionMiB: 1024, maxSessionBytes: 1024 * MIB, finalizationReserveBytes: 16384 });
  const text = JSON.stringify(report); for (const unsafe of [key, '.evolve', process.cwd(), tmpdir()]) assert(!text.includes(unsafe), 'doctor exposes no path or secret');
  const cli = spawnSync(process.execPath, ['scripts/market-intelligence.mjs', 'doctor'], { encoding: 'utf8', timeout: 30000, env: { ...process.env, EVOLVE_INTELLIGENCE_MAX_SESSION_MIB: '99999' } });
  assert.equal(cli.status, 0); assert.deepEqual(JSON.parse(cli.stdout).storage, { maxSessionMiB: 2048, maxSessionBytes: 2048 * MIB, finalizationReserveBytes: 16384 });
  assert(!cli.stdout.includes('.evolve') && !cli.stdout.includes(process.cwd()));
});
test('83 pre-5J.1 summaries remain readable; new summaries keep every prior field', () => {
  const PRIOR = ['bytesBeforeFinalization', 'developmentOnly', 'endedAt', 'errorCounts', 'evidenceClassification', 'fileRecordCounts', 'firstObservedAt', 'futureOutcomeIncluded', 'health',
    'lastObservedAt', 'metrics', 'observerOnly', 'paperOnly', 'providerCounts', 'reason', 'recordCount', 'recordType', 'schemaVersion', 'sessionId', 'startedAt', 'status', 'tradingAuthority', 'uniqueMintCount'];
  const s = store(); s.writeObservation(g(), gmgnPayload); s.finalize({ endedAt: at, metrics: { mintsJoined: 1, providerErrors: 0 } });
  const summaryFile = path.join(s.dir, 'summary.json'), manifestFile = path.join(s.dir, 'manifest.json');
  const current = JSON.parse(readFileSync(summaryFile, 'utf8'));
  assert.deepEqual(Object.keys(current).filter(k => k !== 'storage').sort(), PRIOR); assert.equal(current.bytesBeforeFinalization, current.storage.bytesBeforeFinalization);
  // Re-express the same session in the sealed pre-5J.1 shape (no storage section) with a consistent manifest.
  const { storage, ...prior } = current; assert(storage);
  const body = expectedJson(prior) + '\n'; writeFileSync(summaryFile, body);
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')); delete manifest.storage;
  manifest.files['summary.json'] = hashBytes(body); manifest.fingerprint = hashBytes(expectedJson(manifest.files)); writeFileSync(manifestFile, expectedJson(manifest) + '\n');
  const root = path.dirname(path.dirname(s.dir)), publicState = loadMarketIntelligenceDashboard(root);
  assert.equal(publicState.state, 'FINALIZED_SESSION'); assert.equal(publicState.captureStatus, 'complete'); assert.equal(publicState.mintsJoined, 1);
  const [read] = readSummary(root); assert.equal(read.storage, undefined); assert.equal(read.bytesBeforeFinalization, current.bytesBeforeFinalization);
});
function assertTemporaryOnlyAndEvidenceUnchanged() {
  for (const root of temporary) { assert(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)); assert(!path.resolve(root).startsWith(path.resolve('.evolve'))); }
  assert.deepEqual(finalizedEvidence(), liveEvidenceBefore);
}
test('84 capacity fixtures use temporary storage only; finalized evidence byte-identical', assertTemporaryOnlyAndEvidenceUnchanged);

// Phase 5J.1 review: finalization hashes evidence through one fixed buffer, and a
// session's own metadata must fit its usable capacity before anything is created.
const INCIDENT_SESSION = '1790507032018-6854248b-5e29-49fc-9dec-aef8ab398593';
const INCIDENT_FINGERPRINT = '5fbb0a04fc572318f8c47f0f5e4f0eaace26d453778d179bf7b8ae56b814e82d';
// xorshift32 stream: deterministic, and its state never repeats at these sizes, so unlike
// a short repeating pattern a misplaced or repeated chunk read changes the digest.
function deterministicBytes(size) {
  const bytes = Buffer.alloc(size); let x = 0x5a17;
  for (let i = 0; i < size; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; bytes[i] = x & 0xff; }
  return bytes;
}
// SHA-256 of deterministicBytes(2 MiB + 4099) from coreutils sha256sum, independent of node:crypto.
const KNOWN_MULTI_CHUNK_SHA256 = 'ee4b1b3abbfa2cb4d008dbb5205756869f24a699ef0612c0a6814d32ce79eddf';
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const directoryHashes = dir => Object.fromEntries(files(dir).filter(f => path.basename(f) !== 'manifest.json').map(f => [path.relative(dir, f).split(path.sep).join('/'), hashBytes(readFileSync(f))]));
const sessionEncoding = (sessionId, maxSessionBytes) => expectedJson({ schemaVersion: 1, recordType: 'session', ...EVIDENCE, sessionId, startedAt: at, maxRawBytes: 262144, maxSessionBytes }) + '\n';

test('85 streaming file hash uses a fixed 1 MiB buffer and equals whole-file SHA-256 at every chunk boundary', () => {
  assert.equal(FILE_HASH_CHUNK_BYTES, MIB); const C = FILE_HASH_CHUNK_BYTES, dir = tempRoot();
  for (const size of [0, 1, C - 1, C, C + 1, 2 * C + 4099, 3 * C + 7]) {
    const file = path.join(dir, `evidence-${size}.bin`), bytes = deterministicBytes(size); writeFileSync(file, bytes);
    const oracle = hashBytes(bytes);
    assert.equal(fileHash(file), oracle, `fileHash ${size} bytes`);
    const fd = openSync(file, 'r');
    try {
      assert.equal(hashFileDescriptor(fd), oracle, `descriptor ${size} bytes`);
      // A tiny caller buffer forces many partial chunks through the same loop.
      assert.equal(hashFileDescriptor(fd, Buffer.alloc(7)), oracle, `7-byte chunks ${size} bytes`);
      if (size > 200) {
        // Positional reads: an advanced descriptor offset neither changes the digest nor is moved by hashing.
        const probe = Buffer.alloc(100); assert.equal(readSync(fd, probe, 0, 100, null), 100);
        assert.equal(hashFileDescriptor(fd), oracle, `offset-independent ${size} bytes`);
        assert.equal(readSync(fd, probe, 0, 100, null), 100); assert.deepEqual(probe, bytes.subarray(100, 200));
      }
    } finally { closeSync(fd); }
    if (size === 0) assert.equal(oracle, EMPTY_SHA256);
    if (size === 2 * C + 4099) assert.equal(oracle, KNOWN_MULTI_CHUNK_SHA256);
  }
});
test('86 finalization re-hashes multi-chunk evidence; every manifest hash and the fingerprint independently match', () => {
  const s = store({ maxRawBytes: 2 * MIB }), padding = deterministicBytes(700 * 1024).toString('hex');
  for (let index = 0; index < 3; index++) s.writeRawResponse({ ...rawFixture, payload: { index, padding } }, 'dexscreener');
  s.writeObservation(g(), gmgnPayload); s.writeObservation(d(), dexPayload); s.writeSnapshot(frozenSnapshot([g(), d()])[0]); s.error('gmgn', 'FIXTURE', at);
  const manifest = s.finalize({ endedAt: at });
  assert(statSync(path.join(s.dir, 'raw/dexscreener.ndjson')).size > 4 * FILE_HASH_CHUNK_BYTES, 'evidence spans several hash chunks');
  const actual = directoryHashes(s.dir);
  assert.deepEqual(manifest.files, actual); assert.equal(manifest.fingerprint, hashBytes(expectedJson(actual)));
  assert.deepEqual(JSON.parse(readFileSync(path.join(s.dir, 'manifest.json'), 'utf8')).files, actual);
  for (const [file, hash] of Object.entries(actual)) assert.equal(fileHash(path.join(s.dir, file)), hash);
});
// Isolated child: finalize a >= 32 MiB evidence file and sample array-buffer usage at
// every hash update, the moment a whole-file read would be resident. Post-GC retention
// alone cannot see the defect (the whole-file buffer is garbage once hashed).
const LARGE_EVIDENCE_RECORDS = 32, FINALIZATION_MEMORY_GROWTH_LIMIT = 4 * MIB;
const largeEvidenceChild = `
import { createHash } from 'node:crypto';
import { createStorage } from ${JSON.stringify(pathToFileURL(path.resolve('scripts/market-intelligence/storage.mjs')).href)};
const [root, records, at, mint] = JSON.parse(process.argv[1]), MIB = 1024 * 1024;
const padding = Array.from({ length: MIB / 64 - 8 }, (_, i) => createHash('sha256').update('evolve-5j1-' + i).digest('hex')).join('');
const s = createStorage({ root, sessionId: 'large-evidence', startedAt: at, maxRawBytes: 2 * MIB });
for (let index = 0; index < records; index++) s.writeRawResponse({ payload: { index, padding }, receivedAt: at, endpoint: '/fixture', requestIdentity: mint }, 'dexscreener');
const Hash = Object.getPrototypeOf(createHash('sha256')), update = Hash.update, arrayBuffers = () => process.memoryUsage().arrayBuffers;
gc(); gc(); const before = arrayBuffers(); let peak = before, updates = 0;
Hash.update = function (...args) { updates++; peak = Math.max(peak, arrayBuffers()); return update.apply(this, args); };
const manifest = s.finalize({ endedAt: at });
const unreclaimed = arrayBuffers(); Hash.update = update; gc(); gc(); const retained = arrayBuffers();
console.log(JSON.stringify({ dir: s.dir, updates, peakGrowth: peak - before, unreclaimedGrowth: unreclaimed - before, retainedGrowth: retained - before, manifest }));
`;
test('87 finalizing a 32 MiB evidence file keeps array-buffer growth under 4 MiB (isolated --expose-gc child)', () => {
  const root = tempRoot();
  const child = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', largeEvidenceChild, JSON.stringify([root, LARGE_EVIDENCE_RECORDS, at, mint])], { encoding: 'utf8', timeout: 120000 });
  assert.equal(child.status, 0, child.stderr);
  const { dir, updates, peakGrowth, unreclaimedGrowth, retainedGrowth, manifest } = JSON.parse(child.stdout);
  assert(path.resolve(dir).startsWith(path.resolve(root) + path.sep));
  const large = path.join(dir, 'raw/dexscreener.ndjson'), size = statSync(large).size;
  assert(size >= 32 * MIB, `fixture ${size} bytes`); assert(FINALIZATION_MEMORY_GROWTH_LIMIT * 8 <= size, 'a whole-file read cannot pass the limit');
  assert(updates > 0, 'array-buffer usage was sampled during hashing');
  for (const [label, growth] of Object.entries({ peakGrowth, unreclaimedGrowth, retainedGrowth }))
    assert(Number.isSafeInteger(growth) && growth < FINALIZATION_MEMORY_GROWTH_LIMIT, `${label} ${growth} bytes for a ${size}-byte evidence file`);
  assert(updates >= size / FILE_HASH_CHUNK_BYTES, 'the large file was hashed chunk by chunk');
  const actual = directoryHashes(dir);
  assert.equal(manifest.files['raw/dexscreener.ndjson'], hashBytes(readFileSync(large)));
  assert.deepEqual(manifest.files, actual); assert.equal(manifest.fingerprint, hashBytes(expectedJson(actual)));
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')), manifest);
});
test('88 manifest hashing reads only the identity-verified descriptor; no whole-file reads remain', () => {
  const ast = espree.parse(readFileSync('scripts/market-intelligence/storage.mjs', 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' });
  const named = name => ast.body.find(node => (node.declaration ?? node).id?.name === name || node.declaration?.declarations?.some(v => v.id.name === name));
  const uses = (node, name) => { let found = false; walk(node, n => { if (n.type === 'Identifier' && n.name === name) found = true; }); return found; };
  for (const node of ast.body) if (node.type !== 'ImportDeclaration' && node !== named('readSummary')) assert(!uses(node, 'readFileSync'), 'only readSummary may read a whole file');
  assert(uses(named('hashFileDescriptor'), 'readSync') && uses(named('fileHash'), 'hashFileDescriptor'));
  assert(uses(named('createStorage'), 'hashFileDescriptor') && !uses(named('createStorage'), 'fileHash'), 'finalization hashes its verified descriptor, never a reopened path');
  // Identity defenses still guard the hashing open: replaced or symlinked evidence fails and no manifest is written.
  const replaced = store(); replaced.writeObservation(g(), gmgnPayload);
  const evidence = path.join(replaced.dir, 'normalized.ndjson'); renameSync(evidence, evidence + '.original'); writeFileSync(evidence, readFileSync(evidence + '.original'));
  assert.throws(() => replaced.finalize({ endedAt: at }), /IDENTITY_MISMATCH/); assert(!existsSync(path.join(replaced.dir, 'manifest.json')));
  const linked = store(), outside = tempRoot(), target = path.join(outside, 'evidence.ndjson'); writeFileSync(target, 'unchanged\n');
  const raw = path.join(linked.dir, 'raw/gmgn.ndjson'); unlinkSync(raw); symlinkSync(target, raw);
  assert.throws(() => linked.finalize({ endedAt: at }), /SYMLINK_FORBIDDEN/); assert(!existsSync(path.join(linked.dir, 'manifest.json')));
  assert.equal(readFileSync(target, 'utf8'), 'unchanged\n');
});
test('89 preserved finalized manifests re-verify byte-for-byte under streaming hashing', () => {
  if (!existsSync(LIVE_SESSIONS)) return;
  for (const id of readdirSync(LIVE_SESSIONS).filter(id => existsSync(path.join(LIVE_SESSIONS, id, 'manifest.json')))) {
    const dir = path.join(LIVE_SESSIONS, id), manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    for (const [file, hash] of Object.entries(manifest.files)) assert.equal(fileHash(path.join(dir, file)), hash, `${id}/${file}`);
    assert.equal(manifestFingerprint(manifest.files), manifest.fingerprint); assert.equal(hashBytes(expectedJson(manifest.files)), manifest.fingerprint);
    if (id === INCIDENT_SESSION) assert.equal(manifest.fingerprint, INCIDENT_FINGERPRINT);
  }
});
test('90 a cap leaving less usable space than session.json is rejected before any directory or file exists', () => {
  const parent = tempRoot(), root = path.join(parent, 'market-intelligence');
  for (const maxSessionBytes of [SESSION_FINALIZATION_RESERVE_BYTES + 1, SESSION_FINALIZATION_RESERVE_BYTES + 100]) {
    assert.throws(() => createStorage({ root, sessionId: 'fixture', startedAt: at, maxSessionBytes }), { message: 'SESSION_STORAGE_BOUND_INVALID' });
    assert.deepEqual(readdirSync(parent), [], 'no root, sessions, session, raw or evidence file created');
  }
  const existing = tempRoot();
  assert.throws(() => createStorage({ root: existing, sessionId: 'fixture', startedAt: at, maxSessionBytes: SESSION_FINALIZATION_RESERVE_BYTES + 1 }), { message: 'SESSION_STORAGE_BOUND_INVALID' });
  assert.deepEqual(readdirSync(existing), []);
});
test('91 exact metadata-fit boundary: reserve + encoded session.json succeeds, one byte less is rejected', () => {
  for (const sessionId of ['fixture', 'b'.repeat(100)]) {
    // The cap is itself encoded in session.json, so derive the boundary as a fixed point.
    let cap = SESSION_FINALIZATION_RESERVE_BYTES + 1;
    for (let i = 0; i < 8; i++) cap = SESSION_FINALIZATION_RESERVE_BYTES + Buffer.byteLength(sessionEncoding(sessionId, cap));
    const body = sessionEncoding(sessionId, cap), metadataBytes = Buffer.byteLength(body);
    assert.equal(cap, SESSION_FINALIZATION_RESERVE_BYTES + metadataBytes);
    assert.equal(Buffer.byteLength(sessionEncoding(sessionId, cap - 1)), metadataBytes, 'one byte less leaves one byte too little usable space');
    const below = tempRoot();
    assert.throws(() => createStorage({ root: below, sessionId, startedAt: at, maxSessionBytes: cap - 1 }), { message: 'SESSION_STORAGE_BOUND_INVALID' });
    assert.deepEqual(readdirSync(below), []);
    const s = createStorage({ root: tempRoot(), sessionId, startedAt: at, maxSessionBytes: cap });
    assert.equal(readFileSync(path.join(s.dir, 'session.json'), 'utf8'), body); assert.equal(sessionBytes(s.dir), cap - SESSION_FINALIZATION_RESERVE_BYTES);
    const hashes = treeHashes(s.dir);
    assert.throws(() => s.error('dexscreener', 'FIXTURE', at), { message: 'SESSION_STORAGE_BOUND' }); assert.deepEqual(treeHashes(s.dir), hashes);
    const manifest = s.finalize({ endedAt: at, reason: 'capture failed' });
    assert.equal(manifest.status, 'incomplete'); assert.equal(manifest.storage.usableSessionBytes, metadataBytes); assert.equal(manifest.storage.utilizationRatio, 1);
    assert.equal(manifest.storage.sessionBoundReached, true); assert(treeBytes(s.dir) <= cap, 'metadata, summary and manifest fit the hard cap');
    assert.deepEqual(manifest.files, directoryHashes(s.dir));
  }
});
test('92 finalization-memory and tiny-cap fixtures use temporary storage only; finalized evidence byte-identical', assertTemporaryOnlyAndEvidenceUnchanged);

let failed = 0;
try {
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`PASS ${name}`); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.stack}`); }
  }
} finally { temporary.forEach(root => rmSync(root, { recursive: true, force: true })); }
console.log(`Phase 5J: ${tests.length - failed}/${tests.length} passed; offline fixtures only`);
if (failed) process.exitCode = 1;
