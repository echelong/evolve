/**
 * Phase 5I-PS.2 — bounded asynchronous observer queue.
 *
 * The ONLY structure standing between the passive proposal tap and the
 * asynchronous Jev observer. Its whole contract is:
 *
 *   - `push` is SYNCHRONOUS, allocation-bounded and never throws. It returns
 *     `true` when the item was accepted and `false` when the queue is at its
 *     frozen capacity, in which case the observer work is DROPPED explicitly
 *     (the caller records the drop).
 *   - `shift` is SYNCHRONOUS and is only ever called by the observer worker.
 *   - NOTHING in this module returns a Promise, so the simulation cannot wait
 *     on it even by accident.
 *
 * The capacity is a FROZEN constant from `definition.mjs`, chosen before any
 * live run and never derived from observed performance.
 *
 * PAPER ONLY / DEVELOPMENT EVIDENCE ONLY.
 */

export const SUPERVISOR_QUEUE_VERSION = 1;

/**
 * @param {{ capacity: number, onDrop?: ((item: unknown, depth: number) => void)|null }} options
 */
export function createBoundedObserverQueue({ capacity, onDrop = null } = {}) {
  const max = Number.isFinite(capacity) && capacity > 0 ? Math.floor(capacity) : 1;
  /** @type {unknown[]} */
  let items = [];
  let highWatermark = 0;
  let dropped = 0;
  let pushed = 0;

  function push(item) {
    if (items.length >= max) {
      dropped += 1;
      if (typeof onDrop === "function") {
        // The observer's drop bookkeeping must never be able to throw into the
        // engine's synchronous path.
        try {
          onDrop(item, items.length);
        } catch {
          /* observer-only */
        }
      }
      return false;
    }
    items.push(item);
    pushed += 1;
    if (items.length > highWatermark) highWatermark = items.length;
    return true;
  }

  function shift() {
    return items.length > 0 ? items.shift() : null;
  }

  function drain() {
    const drained = items;
    items = [];
    return drained;
  }

  function clear() {
    const count = items.length;
    items = [];
    return count;
  }

  return {
    version: SUPERVISOR_QUEUE_VERSION,
    capacity: max,
    push,
    shift,
    drain,
    clear,
    get depth() {
      return items.length;
    },
    get highWatermark() {
      return highWatermark;
    },
    get dropped() {
      return dropped;
    },
    get pushed() {
      return pushed;
    },
  };
}
