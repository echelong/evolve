#!/usr/bin/env node
import { readSourceSession } from './market-outcomes/index.mjs';
import { createRevisitQueue } from './market-intelligence/revisits.mjs';
import { planDexRevisits, dexRevisitSafetyMs } from './market-intelligence/revisit-scheduler.mjs';
import { createIntelligenceConfig } from './market-intelligence/config.mjs';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileHash } from './market-intelligence/storage.mjs';

export async function readJupiterTimes(dir, expectedHash = null) {
  const times = new Map();
  const lines = createInterface({ input: createReadStream(path.join(dir, 'normalized.ndjson')), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"recordType":"market_observation"') || !line.includes('"provider":"jupiter"')) continue;
    const row = JSON.parse(line);
    if (row.recordType !== 'market_observation' || row.provider !== 'jupiter') continue;
    const arr = times.get(row.mint) ?? [];
    arr.push(row.providerObservedAt); times.set(row.mint, arr);
  }
  for (const [mint, values] of times) times.set(mint, [...new Set(values)].sort((a, b) => a - b));
  if (expectedHash && fileHash(path.join(dir, 'normalized.ndjson')) !== expectedHash) throw new Error('SOURCE_CHANGED_DURING_REPLAY');
  return times;
}

function latestAt(times, at) {
  let lo = 0, hi = times.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] <= at) lo = mid + 1; else hi = mid; }
  return times[lo - 1] ?? -Infinity;
}

// Capacity-only replay: Jupiter is assumed available for every due mint. The
// 1.2 s serialized request time and 39 s passive cadence match prior fixtures.
// It reads reference identity/time only and makes no outcome inference.
export function simulate(references, { passiveCadenceMs = 39000, latencyMs = 1200, maxPassive = 2, dexConfig = createIntelligenceConfig({ env: {} }).dex, jupiterTimes = null, trace = false } = {}) {
  const events = [], queue = createRevisitQueue({ onEvent: e => events.push(e) });
  for (const { mint, observedAt } of references) queue.schedule(mint, observedAt);
  if (!references.length) return { references: 0, misses: 0, targetedRequests: 0, passiveAttempts: 0 };
  const first = Math.min(...references.map(r => r.observedAt));
  const end = Math.max(...queue.entries().map(e => e.deadlineAt));
  const safetyMs = dexRevisitSafetyMs(dexConfig);
  let at = first, cycleAt = null, used = 0, nextOrdinaryAt = first;
  let targetedRequests = 0, passiveAttempts = 0, passiveDeferred = 0, ordinaryDeferredNoted = false, maxQueueLagMs = 0, coalescedEntries = 0, idleViolations = 0;
  const requestsByCycle = new Map();
  const requestLog = [];
  while (at <= end + 1 && queue.status().pending) {
    queue.expire(at, safetyMs);
    if (!queue.status().pending) break;
    if (cycleAt === null || at - cycleAt >= dexConfig.pollMs) { cycleAt = null; used = 0; }
    const remaining = dexConfig.maxRequests - used;
    const resetAt = cycleAt === null ? at + dexConfig.pollMs : cycleAt + dexConfig.pollMs;
    const budget = { remaining, resetAt, usableAt: remaining ? at : resetAt, busy: false };
    const ordinaryDue = at >= nextOrdinaryAt;
    const readyMints = queue.due(at).filter(mint => {
      if (!jupiterTimes) return true;
      const last = latestAt(jupiterTimes.get(mint) ?? [], at);
      return last >= Math.min(...queue.targets(mint, at).map(e => e.targetAt)) && at - last <= 15000;
    });
    const plan = planDexRevisits({ queue, at, budget, readyMints, ordinaryDue, maxPassive, safetyMs });
    if (remaining && readyMints.some(mint => queue.targets(mint, at).some(e => at <= e.deadlineAt - safetyMs)) && !plan.targetedMints.length) idleViolations++;
    if (ordinaryDue && !plan.passiveDexLimit && !ordinaryDeferredNoted) { passiveDeferred++; ordinaryDeferredNoted = true; }
    const mint = plan.targetedMints[0];
    if (mint || plan.passiveDexLimit) {
      if (cycleAt === null) cycleAt = at;
      used++;
      if (trace) requestLog.push({ at, mint: mint ?? null, cycleAt });
      requestsByCycle.set(cycleAt, (requestsByCycle.get(cycleAt) ?? 0) + 1);
      if (mint) {
        targetedRequests++;
        const latestJupiter = jupiterTimes ? latestAt(jupiterTimes.get(mint) ?? [], at) : at;
        const targets = queue.targets(mint, at).filter(e => e.targetAt <= latestJupiter), count = targets.length;
        coalescedEntries += Math.max(0, count - 1);
        maxQueueLagMs = Math.max(maxQueueLagMs, ...targets.map(e => at - e.targetAt));
        queue.complete(mint, at + latencyMs, true, { requestStartedAt: at, requestReceivedAt: at + latencyMs, coalescedEntryCount: count, eligibleUntilAt: latestJupiter });
      } else {
        passiveAttempts++;
        if (plan.passiveDexLimit > 1 && used < dexConfig.maxRequests) {
          used++; passiveAttempts++; requestsByCycle.set(cycleAt, requestsByCycle.get(cycleAt) + 1);
          at += latencyMs;
        }
        nextOrdinaryAt = at + passiveCadenceMs;
        ordinaryDeferredNoted = false;
      }
      at += latencyMs;
    } else {
      at += 250;
    }
  }
  const status = queue.status();
  const eligible = e => !jupiterTimes || (jupiterTimes.get(e.mint) ?? []).some(at => at >= e.targetAt && at <= e.deadlineAt - safetyMs);
  return { references: references.length, distinctRevisits: status.scheduled, uniqueMints: new Set(references.map(r => r.mint)).size,
    jupiterEligible: events.filter(e => e.result !== 'scheduled' && eligible(e)).length,
    covered: status.completed, misses: status.failed, targetedRequests, passiveAttempts, passiveDeferred,
    coalescedEntries, maxQueueLagMs, totalDexRequests: targetedRequests + passiveAttempts,
    maxRequestsInProviderCycle: Math.max(0, ...requestsByCycle.values()),
    providerCycleUtilization: [...requestsByCycle.values()].reduce((a, b) => a + b, 0) / (requestsByCycle.size * dexConfig.maxRequests),
    eligibleDeadlineMisses: events.filter(e => e.result === 'failed' && eligible(e)).length,
    unattemptedWhileCapacityAvailable: idleViolations,
    failureCodes: status.failuresByCode,
    ...(trace ? { eligibleFailureExamples: events.filter(e => e.result === 'failed' && eligible(e)).slice(0, 8).map(e => ({ ...e,
      jupiterTimes: (jupiterTimes?.get(e.mint) ?? []).filter(t => t >= e.targetAt && t <= e.deadlineAt),
      nearRequests: requestLog.filter(r => r.at >= e.targetAt - 30000 && r.at <= e.deadlineAt) })) } : {}) };
}

if (process.argv[1]?.endsWith('simulate-r4-revisits.mjs')) {
  const dir = process.argv[2];
  if (!dir) throw new Error('Supply read-only shakedown session directory');
  const source = readSourceSession({ dir, role: 'cohort' }, { requireDurationComplete: false });
  const references = source.snapshots.filter(s => s.validationReason === null && s.snapshot.observedAt + 360000 <= source.coverage.endedAt)
    .map(s => ({ mint: s.snapshot.mint, observedAt: s.snapshot.observedAt }));
  const jupiterTimes = await readJupiterTimes(dir, source.before['normalized.ndjson']);
  const result = { observedReplay: simulate(references, { jupiterTimes, trace: process.argv.includes('--trace') }) };
  if (process.argv.includes('--stress')) {
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const syntheticMint = i => `So111111111111111111111111111111111111${alphabet[i % alphabet.length]}${alphabet[Math.floor(i / alphabet.length)]}`;
    result.stress = {
      doubledOverlaps: simulate([...references, ...references.map(r => ({ ...r, observedAt: r.observedAt + 1000 }))]),
      oneMintBurst: simulate(Array.from({ length: 100 }, (_, i) => ({ mint: references[0].mint, observedAt: references[0].observedAt + i * 100 }))),
      manyMintBurst: simulate(Array.from({ length: 100 }, (_, i) => ({ mint: syntheticMint(i), observedAt: references[0].observedAt }))),
    };
  }
  console.log(JSON.stringify(result, null, 2));
}
