/**
 * Short, collision-resistant identifiers for agents, events, and trades.
 *
 * Phase 1 used a bare UUID slice; the local counter keeps the dashboard
 * readable (A-000123) while the random suffix prevents collisions across
 * restarts.
 *
 * Phase 3 adds `createIdFactory`: historical replay must be reproducible, and
 * `crypto.randomUUID()` is not. A seeded factory keeps ids deterministic when
 * the call order is deterministic, which is what determinism testing checks.
 */

import { randomUUID } from "node:crypto";

let counter = 0;

export function generateAgentId(prefix = "A") {
  counter = (counter + 1) % 1_000_000;
  const serial = String(counter).padStart(6, "0");
  const suffix = randomUUID().replace(/-/g, "").slice(0, 3).toUpperCase();
  return `${prefix}-${serial}${suffix}`;
}

export function generateEventId() {
  return randomUUID();
}

export function resetIdCounter() {
  counter = 0;
}

/**
 * Deterministic id generator for seeded/replayed runs.
 * Every call advances a serial, so ids depend only on call order.
 */
export function createIdFactory({ prefix = "A", width = 6 } = {}) {
  let serial = 0;
  return function nextId(kind = prefix) {
    serial += 1;
    return `${kind}-${String(serial).padStart(width, "0")}`;
  };
}

/** Deterministic short id for datasets, windows, champions, and experiments. */
export function shortId(prefix, seed, length = 6) {
  let hash = 2166136261;
  const text = `${prefix}:${seed}`;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  let value = hash >>> 0;
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out += alphabet[value % alphabet.length];
    value = Math.floor(value / alphabet.length) + 7;
  }
  return `${prefix}-${out}`;
}
