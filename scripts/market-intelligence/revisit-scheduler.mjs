// Dex work is ordered by earliest revisit deadline, then mint. Passive work
// uses only capacity left after reserving each reference whose target falls
// before this provider window resets. This uses no market values.
export function planDexRevisits({ queue, at, budget, readyMints = [], ordinaryDue = false, maxPassive = 2, safetyMs }) {
  const entries = queue.entries();
  const ready = new Set(readyMints);
  const latestStart = entry => entry.deadlineAt - safetyMs;
  const due = [...new Set(entries.filter(e => e.targetAt <= at && at <= latestStart(e) && ready.has(e.mint)).map(e => e.mint))];
  const available = !budget.busy && budget.usableAt <= at ? budget.remaining : 0;
  const targetedMints = due.slice(0, available);
  // Reserve every scheduled reference in this window. Same-mint references may
  // coalesce at service time, but counting them separately here is safe when
  // their target times straddle a request already in flight.
  const reserved = entries.filter(e => e.targetAt <= budget.resetAt && at <= latestStart(e) &&
    !(e.targetAt <= at && targetedMints.includes(e.mint))).length;
  const passiveDexLimit = ordinaryDue ? Math.max(0, Math.min(maxPassive, available - targetedMints.length - reserved)) : 0;
  const nextAt = Math.min(...entries.map(e => e.targetAt > at ? e.targetAt : Infinity), budget.usableAt > at ? budget.usableAt : Infinity);
  return { targetedMints, passiveDexLimit, nextAt, reserved, available };
}

// The HTTP timeout bounds the provider request. The provider spacing may be
// waited inside transport; five seconds covers normalization, durable recorder
// writes and snapshot construction. A start past this point is a deadline miss.
export const dexRevisitSafetyMs = config => config.timeoutMs + config.spacingMs + 5000;
