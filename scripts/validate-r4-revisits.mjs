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
import { planDexRevisits, dexRevisitSafetyMs } from './market-intelligence/revisit-scheduler.mjs';

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
assert.equal(dex.budget(clock).remaining, config.dex.maxRequests - 2);
const budgetClock = t + 1000;
const budgetDex = createDexProvider({ config: { ...config.dex, maxRequests: 1, pollMs: 30000, spacingMs: 1 }, now: () => clock,
  fetchImpl: async () => new Response('[]', { status: 200 }) });
clock = budgetClock;
await budgetDex.observe(mint);
assert.equal(budgetDex.budget(clock).remaining, 0);
assert.equal(budgetDex.budget(clock).usableAt, budgetClock + 30000, 'budget reset is anchored to actual first request');
clock = budgetClock + 30000;
assert.equal(budgetDex.budget(clock).remaining, 1);
// Legacy path: passive work can consume the last slot 10 ms before reset;
// `now + pollMs` would then block an already-due target past its safe start.
const legacyDeniedAt = budgetClock + 29990;
const legacyBlockedUntil = legacyDeniedAt + config.dex.pollMs;
const dueTargetAt = budgetClock - 5000;
assert(legacyBlockedUntil > dueTargetAt + 60000 - dexRevisitSafetyMs(config.dex));
assert(budgetDex.budget(legacyDeniedAt).usableAt < dueTargetAt + 60000 - dexRevisitSafetyMs(config.dex));

const safety = dexRevisitSafetyMs(config.dex);
const planQueue = createRevisitQueue();
planQueue.schedule(mint, t);
planQueue.schedule(other, t + 1000);
const target = t + 300000;
const available = { remaining: 2, resetAt: target + 30000, usableAt: target, busy: false };
let plan = planDexRevisits({ queue: planQueue, at: target, budget: available, readyMints: [mint], ordinaryDue: true, safetyMs: safety });
assert.deepEqual(plan.targetedMints, [mint], 'due targeted work precedes passive work');
assert.equal(plan.passiveDexLimit, 0, 'future target reserves remaining provider slot');
plan = planDexRevisits({ queue: planQueue, at: target + 1000, budget: available, readyMints: [other, mint], ordinaryDue: true, safetyMs: safety });
assert.deepEqual(plan.targetedMints, [mint, other], 'earliest deadline wins regardless of ready input order');
assert.equal(plan.available, 2, 'eligible ready work with available budget cannot leave lane idle');
assert.equal(plan.passiveDexLimit, 0);
assert.deepEqual(planDexRevisits({ queue: planQueue, at: target, budget: { ...available, remaining: 0, usableAt: target + 7000 }, readyMints: [mint], safetyMs: safety }).targetedMints, []);
assert.equal(planDexRevisits({ queue: planQueue, at: target, budget: { ...available, remaining: 0, usableAt: target + 7000 }, readyMints: [mint], safetyMs: safety }).nextAt, target + 1000);
planQueue.expire(target + 61000 - safety + 1, safety);
assert.equal(planQueue.status().failed, 2, 'unsafe start is classified as a deadline miss');

const coalescedEvents = [];
const coalesced = createRevisitQueue({ onEvent: e => coalescedEvents.push(e) });
coalesced.schedule(mint, t);
coalesced.schedule(mint, t + 1000);
coalesced.complete(mint, t + 301000, () => true, { requestStartedAt: t + 301000, requestReceivedAt: t + 302000, coalescedEntryCount: 2 });
assert.equal(coalesced.status().completed, 2);
assert.equal(coalescedEvents.filter(e => e.result === 'completed').length, 2);
assert.deepEqual(coalescedEvents.filter(e => e.result === 'completed').map(e => e.targetAt), [t + 300000, t + 301000]);
const late = createRevisitQueue();
late.schedule(mint, t);
late.complete(mint, t + 360001, true, { requestStartedAt: t + 359000 });
assert.equal(late.status().failuresByCode.REVISIT_DEADLINE_MISSED, 1, 'slow response and snapshot after hard deadline fail closed');
const earlyStart = createRevisitQueue();
earlyStart.schedule(mint, t);
earlyStart.schedule(mint, t + 500);
earlyStart.complete(mint, t + 300600, true, { requestStartedAt: t + 300000 });
assert.equal(earlyStart.status().pending, 1, 'later same-mint target is not closed by a pre-target request');
const failedDex = createDexProvider({ config: { ...config.dex, maxRequests: 1 }, now: () => clock,
  fetchImpl: async () => new Response('failure', { status: 500 }) });
clock = t;
const failure = await failedDex.observe(mint, { fresh: true });
assert.equal(failure.requestAttempted, true, 'provider failure still counts as an attempted request');
assert.equal(failedDex.budget(clock).remaining, 0);
assert(failedDex.budget(clock).usableAt >= t + config.dex.pollMs, 'budget and backoff both constrain next request');
const restarted = createRevisitQueue();
restarted.schedule(mint, t);
assert.equal(restarted.status().pending, 1, 'restart never fabricates a successful revisit');

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
order.length = 0;
const unsafe = await recorder.capture({ markets: [], targetedMints: [mint], targetedLatestStart: { [mint]: t - 1 }, passiveDexLimit: 0 });
assert.equal(unsafe.revisitResults[mint].unavailable, 'DEADLINE_UNSAFE');
assert.equal(order.length, 0, 'recorder never starts a targeted request after the safety cutoff');

const refs = Array.from({ length: 196 }, (_, i) => ({ mint: i % 2 ? mint : other, observedAt: t + i * 9000 }));
const result = simulate(refs);
assert.equal(result.references, 196);
assert.equal(result.covered, 196);
const burst = simulate(Array.from({ length: 20 }, (_, i) => ({ mint: `${mint}${i}`, observedAt: t })));
assert(burst.misses > 0, 'overload is surfaced, not hidden');
assert.equal(burst.unattemptedWhileCapacityAvailable, 0);
const sameMintBurst = simulate(Array.from({ length: 100 }, (_, i) => ({ mint, observedAt: t + i * 100 })));
assert(sameMintBurst.coalescedEntries > 0);
assert.equal(sameMintBurst.misses, 0);
const doubled = simulate([...refs, ...refs.map(r => ({ ...r, observedAt: r.observedAt + 1000 }))]);
assert.equal(doubled.references, 392);
assert.equal(doubled.unattemptedWhileCapacityAvailable, 0);
assert(doubled.maxRequestsInProviderCycle <= config.dex.maxRequests);
const capacityBound = simulate([
  ...Array.from({ length: 6 }, (_, i) => ({ mint: `${mint}${i}`, observedAt: t })),
  ...Array.from({ length: 7 }, (_, i) => ({ mint: `${mint}${i}`, observedAt: t + 14000 })),
], { maxPassive: 0 });
assert(capacityBound.misses >= 1, 'seven distinct due mints competing for six slots reveal a capacity lower bound');
const resumed = simulate([{ mint, observedAt: t }]);
assert(resumed.passiveAttempts > 0, 'passive capture resumes when targeted pressure clears');
console.log('R4 revisit scheduler: offline behavioral fixtures passed');
