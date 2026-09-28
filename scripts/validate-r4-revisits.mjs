#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRevisitQueue } from './market-intelligence/revisits.mjs';
import { aggregate } from './market-intelligence/aggregate.mjs';
import { observation } from './market-intelligence/normalize.mjs';
import { snapshotMissingReason } from './market-outcomes/index.mjs';
import { createDexProvider } from './market-intelligence/providers/dexscreener.mjs';
import { createIntelligenceConfig } from './market-intelligence/config.mjs';
import { simulate } from './simulate-r4-revisits.mjs';
import { revisitExitFailure } from './market-intelligence.mjs';
import { createIntelligenceRecorder } from './market-intelligence/recorder.mjs';
import { MarketUniverse } from './market/universe.mjs';
import { normalizeJupiterMarkets } from './market-intelligence/normalize.mjs';

const t = 1800000000000;
const mint = 'So11111111111111111111111111111111111111112';
const other = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
function snapshot(time, prices = [2, 2.1], gap = 1200) {
  const records = ['jupiter', 'dexscreener'].map((provider, i) => {
    const receivedAt = time + i * gap;
    const normalized = { priceUsd: prices[i], provider, liquidityUsd: null, volumes: { m5: null, h1: null }, transactions: { m5: { buys: null, sells: null } }, priceChanges: { m5: null, h1: null }, pairCreatedAt: null };
    return observation({ provider, endpoint: provider, mint, payload: { provider, time, price: prices[i] }, normalized, receivedAt, observedAt: receivedAt, staleMs: 60000 });
  });
  return aggregate(records, { observedAt: time + gap + 100 })[0];
}

const reference = snapshot(t);
assert.equal(snapshotMissingReason(reference), null);
const q = createRevisitQueue();
assert.equal(q.add(reference), true);
assert.equal(q.status().pending, 1);
assert.equal(revisitExitFailure(q)?.message, 'REVISIT_COVERAGE_FAILED', 'interrupted session cannot silently finalize pending queue');
assert.equal(q.status().nextAt, reference.observedAt + 300000);
assert.deepEqual(q.due(reference.observedAt + 299999), []);
assert.deepEqual(q.due(reference.observedAt + 300000), [mint]);
assert.deepEqual(q.due(reference.observedAt + 360000), [mint]);
q.expire(reference.observedAt + 360000);
assert.equal(q.status().pending, 1);
q.expire(reference.observedAt + 360001);
assert.deepEqual(q.status().failures.map(x => x.code), ['REVISIT_DEADLINE_MISSED']);
assert.equal(revisitExitFailure(q)?.message, 'REVISIT_COVERAGE_FAILED');
const boundedFailures = createRevisitQueue();
for (let i = 0; i < 100; i++) boundedFailures.schedule(mint, t + i);
boundedFailures.expire(t + 500000);
assert.equal(boundedFailures.status().failed, 100);
assert.equal(boundedFailures.status().failures.length, 32, 'failure examples stay bounded');

const a = createRevisitQueue(), b = createRevisitQueue();
for (const s of [reference, snapshot(t, [9, 8])]) a.add(s);
for (const s of [snapshot(t, [9, 8]), reference]) b.add(s);
assert.deepEqual(a.status(), b.status(), 'prices and insertion order do not affect scheduling');
assert.equal(a.status().pending, 1, 'same mint and time deduplicated');
assert.equal(a.schedule(mint, reference.observedAt + 1000), true);
assert.deepEqual(a.due(reference.observedAt + 301000), [mint], 'overlapping due work shares one mint request');
a.complete(mint, reference.observedAt + 301000, () => true);
assert.equal(a.status().pending, 0);
assert.deepEqual(a.status().failures, []);
assert.equal(revisitExitFailure(a), null);
assert.throws(() => { const bounded = createRevisitQueue({ maxPending: 1 }); bounded.schedule(mint, t); bounded.schedule(other, t); }, /REVISIT_QUEUE_BOUND/);

const future = snapshot(reference.observedAt + 300000);
assert.equal(snapshotMissingReason(future), null);
assert(future.disagreement.metrics.contributors.price.every(p => p.providerObservedAt >= reference.observedAt + 300000));
assert(future.observedAt - Math.min(...future.disagreement.metrics.contributors.price.map(p => p.providerObservedAt)) <= 60000);
assert(Math.max(...future.disagreement.metrics.contributors.price.map(p => p.providerObservedAt)) - Math.min(...future.disagreement.metrics.contributors.price.map(p => p.providerObservedAt)) <= 15000);
assert.equal(snapshotMissingReason(snapshot(t + 300000, [2, 2.1], 15000)), null, '15-second alignment boundary is inclusive');
assert.notEqual(snapshotMissingReason(snapshot(t + 300000, [2, 2.1], 15001)), null, 'one millisecond beyond alignment fails');
const simultaneous = ['jupiter', 'dexscreener'].map(provider => observation({ provider, endpoint: provider, mint,
  payload: { provider, time: t }, normalized: { priceUsd: 2, provider, liquidityUsd: null, volumes: { m5: null, h1: null }, transactions: { m5: { buys: null, sells: null } }, priceChanges: { m5: null, h1: null } },
  receivedAt: t, observedAt: t, staleMs: 60000 }));
assert.equal(snapshotMissingReason(aggregate(simultaneous, { observedAt: t + 60000 })[0]), null, '60-second freshness boundary is inclusive');
assert.notEqual(snapshotMissingReason(aggregate(simultaneous, { observedAt: t + 60001 })[0]), null, 'one millisecond beyond freshness fails');

let clock = t, calls = 0;
const config = createIntelligenceConfig({ env: {} });
const dex = createDexProvider({ config: { ...config.dex, cacheMs: 30000 }, now: () => clock,
  sleep: async ms => { clock += ms; }, fetchImpl: async () => {
    calls++;
    return new Response(JSON.stringify([{ chainId: 'solana', pairAddress: mint, baseToken: { address: mint }, priceUsd: '2' }]), { status: 200 });
  } });
await dex.observe(mint);
await dex.observe(mint);
assert.equal(calls, 1, 'ordinary passive cache remains active');
await dex.observe(mint, { fresh: true });
assert.equal(calls, 2, 'targeted revisit bypasses transport cache');

const universe = new MarketUniverse({ max: 150, now: () => t });
const token = { mint, usdPrice: 2, liquidity: 100, source: 'Jupiter Tokens V2', synthetic: false, observedAt: t };
universe.ingest([token], { at: t });
universe.ingest([{ ...token, observedAt: t + 300000 }], { at: t + 300000 });
assert.equal(universe.get(mint).observedAt, t, 'engine changed-value timestamp retains its prior meaning');
assert.equal(universe.get(mint).lastSeenAt, t + 300000, 'real same-value list inclusion has fresh local fetch time');
const [freshCopy] = normalizeJupiterMarkets([{ mint, source: 'Jupiter Tokens V2', synthetic: false, price: 2, liquidity: 100, lastObservedAt: t, lastFetchedAt: universe.get(mint).lastSeenAt }], { observedAt: t + 300100, receivedAt: t + 300100 });
assert.equal(freshCopy.providerObservedAt, t + 300000);
assert.equal(freshCopy.timestampBasis, 'feed_last_seen_request_start_and_local_copy');

const order = [];
const storage = { writeObservation() {}, writeRawResponse() {}, writeSnapshot() {}, error() {}, finalize() { return {}; }, dir: '/tmp/fixture' };
const fakeDex = { async observe(identity, options) { order.push([identity, options.fresh]); return { payload: [], receivedAt: t, endpoint: `/token-pairs/v1/solana/${identity}`, requestIdentity: identity, requestAttempted: true }; }, health() { return { state: 'HEALTHY' }; } };
const fakeGmgn = { async observe() { return { unavailable: 'DISABLED_NO_KEY' }; }, health() { return { state: 'DISABLED_NO_KEY' }; } };
const fakeLaunch = { async poll() { return []; }, health() { return { events: 0 }; }, stop() {} };
const recorder = createIntelligenceRecorder({ config, storage, dex: fakeDex, gmgn: fakeGmgn, launch: fakeLaunch, now: () => t });
await recorder.capture({ markets: [], mints: [mint, other], targetedMints: [other], passiveDexLimit: 1 });
assert.deepEqual(order, [[other, true], [mint, false]], 'targeted request has deterministic priority');
order.length = 0;
await recorder.capture({ markets: [], mints: [mint, other] });
assert.equal(order.length, 2, 'ordinary passive capture retains both requests');
assert(order.every(([, fresh]) => fresh === false));

const refs = Array.from({ length: 196 }, (_, i) => ({ mint: i % 2 ? mint : other, observedAt: t + i * 9000 }));
const result = simulate(refs);
assert.equal(result.references, 196);
assert.equal(result.futureWindowOpportunities, 196);
const burst = simulate(Array.from({ length: 20 }, (_, i) => ({ mint: `${mint}${i}`, observedAt: t })));
assert(burst.misses > 0, 'overload is surfaced, not hidden');
console.log('R4 revisit scheduler: offline behavioral fixtures passed');
