#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { EVIDENCE, canonical, digest, redact } from './market-intelligence/definition.mjs';
import { createIntelligenceConfig, observation, normalizeGmgn, normalizeDex, normalizeJupiterMarkets, normalizeLaunchEvent, createGmgnProvider, createDexProvider, createLaunchObserver, aggregate, disagreement, createStorage, manifestFingerprint, createIntelligenceRecorder, FEATURE_NAMES } from './market-intelligence/index.mjs';
import { GMGN_ROUTES } from './market-intelligence/providers/gmgn.mjs';
import { DEX_ROUTES } from './market-intelligence/providers/dexscreener.mjs';
import { createObservationTransport } from './market-intelligence/providers/http.mjs';
import { loadMarketIntelligenceDashboard } from './market-intelligence/dashboard.mjs';
import { AGENT_REACH_PIN } from './intelligence/config.mjs';
import { normalizeJupiterToken, deriveMarket } from './market/normalize.mjs';

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
  let calls = 0;
  const p = createGmgnProvider({ config: c.gmgn, now: () => at, fetchImpl: async () => { calls++; return response(gmgnPayload); } });
  await p.observe('info', mint); assert.equal((await p.observe('security', mint)).unavailable, 'CYCLE_BUDGET'); assert.equal(calls, 1);
});

test('42 existing external-intelligence CLI install path stays equivalent', () => assert.equal(AGENT_REACH_PIN.localInstallDir, path.join('.tools', 'agent-reach')));

let failed = 0;
try {
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`PASS ${name}`); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.stack}`); }
  }
} finally { temporary.forEach(root => rmSync(root, { recursive: true, force: true })); }
console.log(`Phase 5J: ${tests.length - failed}/${tests.length} passed; offline fixtures only`);
if (failed) process.exitCode = 1;
