import { PRIMARY_HORIZON_MS, RESOLUTION_TOLERANCE_MS, snapshotMissingReason } from '../market-outcomes/index.mjs';

// The queue contains only structural reference identity and time. No price,
// prediction, or subsequent market value is retained or used for ordering.
export function createRevisitQueue({ maxPending = 10000 } = {}) {
  const pending = new Map();
  const failures = [];
  const failuresByCode = {};
  let scheduled = 0, completed = 0, failed = 0;
  function fail(entry, code) {
    failed++;
    failuresByCode[code] = (failuresByCode[code] ?? 0) + 1;
    if (failures.length < 32) failures.push({ ...entry, code });
  }
  const key = (mint, targetAt) => `${mint}:${targetAt}`;
  const ordered = () => [...pending.values()].sort((a, b) => a.targetAt - b.targetAt || a.mint.localeCompare(b.mint));
  return Object.freeze({
    add(snapshot) {
      if (snapshotMissingReason(snapshot) !== null) return false;
      return this.schedule(snapshot.mint, snapshot.observedAt);
    },
    schedule(mint, observedAt) {
      if (typeof mint !== 'string' || !Number.isSafeInteger(observedAt) || observedAt < 0) throw new Error('REVISIT_REFERENCE_INVALID');
      const targetAt = observedAt + PRIMARY_HORIZON_MS;
      if (!Number.isSafeInteger(targetAt)) throw new Error('REVISIT_TIMESTAMP_BOUND');
      const id = key(mint, targetAt);
      if (pending.has(id)) return false;
      if (pending.size >= maxPending) throw new Error('REVISIT_QUEUE_BOUND');
      pending.set(id, { mint, targetAt, deadlineAt: targetAt + RESOLUTION_TOLERANCE_MS });
      scheduled++;
      return true;
    },
    due(at, limit = Infinity) {
      return [...new Set(ordered().filter(x => x.targetAt <= at && at <= x.deadlineAt).map(x => x.mint))].slice(0, limit);
    },
    targets(mint, at) { return ordered().filter(x => x.mint === mint && x.targetAt <= at && at <= x.deadlineAt); },
    nextAt() { return ordered()[0]?.targetAt ?? null; },
    // A request attempt closes its due work. Its observation can still be
    // invalid; the coverage ledger records that separately and fails closed.
    complete(mint, at, condition) {
      for (const entry of ordered().filter(x => x.mint === mint && x.targetAt <= at)) {
        pending.delete(key(entry.mint, entry.targetAt));
        if (at > entry.deadlineAt || !(typeof condition === 'function' ? condition(entry) : condition)) fail(entry, at > entry.deadlineAt ? 'REVISIT_DEADLINE_MISSED' : 'REVISIT_TWO_SOURCE_UNAVAILABLE');
        else completed++;
      }
    },
    expire(at) {
      for (const entry of ordered().filter(x => at > x.deadlineAt)) {
        pending.delete(key(entry.mint, entry.targetAt));
        fail(entry, 'REVISIT_DEADLINE_MISSED');
      }
    },
    status() { return { scheduled, completed, failed, pending: pending.size, failuresByCode: { ...failuresByCode }, failures: [...failures], nextAt: this.nextAt() }; },
  });
}
