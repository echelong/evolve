/**
 * Short, collision-resistant identifiers for agents, events, and trades.
 *
 * Phase 1 used a bare UUID slice; the local counter keeps the dashboard
 * readable (A-000123) while the random suffix prevents collisions across
 * restarts.
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
