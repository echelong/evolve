#!/usr/bin/env node
import { readSourceSession } from './market-outcomes/index.mjs';
import { createRevisitQueue } from './market-intelligence/revisits.mjs';

// Offline capacity model: the actual six-request Dex provider cycle, up to two
// passive requests on ordinary 39-second captures, and 1.2-second serialized
// requests. Jupiter figures assume the upstream ranked list contains the mint
// on a poll at service time.
export function simulate(references) {
  const queue = createRevisitQueue();
  for (const { mint, observedAt } of references) queue.schedule(mint, observedAt);
  const events = [...new Map(references.map(({ mint, observedAt }) => {
    const targetAt = observedAt + 300000;
    return [`${mint}:${targetAt}`, { mint, targetAt, deadlineAt: targetAt + 60000 }];
  })).values()].sort((a, b) => a.targetAt - b.targetAt || a.mint.localeCompare(b.mint));
  const start = references.length ? Math.min(...references.map(r => r.observedAt)) : 0;
  const targetedByProviderCycle = new Map();
  let nextRequestAt = start, cycleAt = null, cycleRequests = 0, nextOrdinaryAt = start, covered = 0, misses = [], passiveAttempts = 0;
  function attempt(at, targeted) {
    at = Math.max(at, nextRequestAt);
    if (cycleAt === null || at - cycleAt >= 30000) { cycleAt = at; cycleRequests = 0; }
    if (cycleRequests >= 6) {
      if (!targeted) return null;
      at = Math.max(at, cycleAt + 30000);
      cycleAt = at; cycleRequests = 0;
    }
    cycleRequests++;
    nextRequestAt = at + 1200;
    return at;
  }
  for (const event of events) {
    while (nextOrdinaryAt < event.targetAt) {
      for (let i = 0; i < 2; i++) if (attempt(nextOrdinaryAt, false) !== null) passiveAttempts++;
      nextOrdinaryAt += 39000;
    }
    const at = attempt(event.targetAt, true);
    if (at <= event.deadlineAt) {
      covered++;
      targetedByProviderCycle.set(cycleAt, (targetedByProviderCycle.get(cycleAt) ?? 0) + 1);
    } else misses.push({ ...event, serviceAt: at });
  }
  return { references: references.length, uniqueMints: new Set(references.map(r => r.mint)).size,
    ambientUniverse: 150, distinctRevisits: events.length, futureWindowOpportunities: covered,
    dexFreshnessOpportunities: covered, jupiterFreshnessOpportunitiesConditionalOnUpstreamInclusion: covered,
    alignmentOpportunitiesConditionalOnUpstreamInclusion: covered,
    twoSourceOpportunitiesConditionalOnUpstreamInclusion: covered, misses: misses.length,
    maxTargetedRequestsInProviderCycle: Math.max(0, ...targetedByProviderCycle.values()),
    dexCycleCapacity: 6, passiveAttempts, passiveRequestsPerOrdinaryCapture: 2, ordinaryCaptureCadenceMs: 39000 };
}

if (process.argv[1]?.endsWith('simulate-r4-revisits.mjs')) {
  const dir = process.argv[2];
  if (!dir) throw new Error('Supply read-only finalized shakedown session directory');
  const source = readSourceSession({ dir, role: 'cohort' });
  const references = source.snapshots.filter(s => s.validationReason === null).map(s => ({ mint: s.snapshot.mint, observedAt: s.snapshot.observedAt }));
  console.log(JSON.stringify(simulate(references), null, 2));
}
