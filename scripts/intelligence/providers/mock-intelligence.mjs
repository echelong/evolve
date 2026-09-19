/**
 * Phase 5E — deterministic MOCK intelligence provider (PAPER ONLY).
 *
 * Used for offline tests and for exercising the whole capture → freeze → replay
 * → features → packet pipeline without touching the internet. It is
 * DETERMINISTIC given (channel, query, limit, clock), touches no network, spawns
 * no subprocess, and marks every record `syntheticIntelligence: true` so mock
 * evidence can never be mistaken for a real observation.
 *
 * PAPER ONLY. No wallet, no network, no posting.
 */

import { digestOf } from "../../lib/hash.mjs";

export const MOCK_INTELLIGENCE_PROVIDER = "mock-intelligence";
export const MOCK_INTELLIGENCE_VERSION = "mock-intelligence-v1";
/** Records the mock returns per query (bounded, deterministic). */
export const MOCK_RECORDS_PER_QUERY = 4;

/** Deterministic pseudo-random value in [0, 1) from a string seed. */
function unitFrom(seed, salt) {
  const digest = digestOf({ seed, salt });
  return Number.parseInt(digest.slice(0, 8), 16) / 0xffffffff;
}

/**
 * Build the deterministic raw records for one query.
 *
 * @param {{
 *   channel: string, query: string, limit?: number, now?: number,
 *   authorPool?: number, duplicateText?: boolean,
 * }} options
 */
export function mockRecordsForQuery({
  channel,
  query,
  limit = MOCK_RECORDS_PER_QUERY,
  now = Date.now(),
  authorPool = 3,
  duplicateText = false,
} = {}) {
  const count = Math.max(1, Math.min(limit, MOCK_RECORDS_PER_QUERY));
  const records = [];
  for (let index = 0; index < count; index += 1) {
    const seed = digestOf({ channel, query, index });
    const authorIndex = index % authorPool;
    const engagement = Math.round(unitFrom(seed, "engagement") * 500);
    const publishedAt = new Date(now - (index + 1) * 600_000).toISOString();
    const text = duplicateText
      ? `${query} — synthetic intelligence fixture text`
      : `${query} — synthetic ${channel} observation ${index} (engagement ${engagement})`;
    records.push({
      id: `${channel}-${seed.slice(0, 12)}`,
      url: `https://example.test/${channel}/${seed.slice(0, 10)}`,
      publishedAt,
      author: `fixture-author-${authorIndex}`,
      title: `Synthetic ${channel} fixture ${index}`,
      text,
      engagement,
      likes: Math.round(engagement / 2),
      replies: Math.round(engagement / 10),
      sourceVersion: MOCK_INTELLIGENCE_VERSION,
    });
  }
  return records;
}

/**
 * The mock provider executes a read-only operation WITHOUT any I/O.
 *
 * @param {{ op: string, channel?: string|null, query?: string|null, limit?: number, now?: number,
 *           fixture?: string|null, authorPool?: number, duplicateText?: boolean }} call
 */
export function executeMockIntelligence(call = {}) {
  const { op, channel = null, query = null, limit = MOCK_RECORDS_PER_QUERY, now = Date.now() } = call;
  if (op === "health") {
    return {
      ok: true,
      provider: MOCK_INTELLIGENCE_PROVIDER,
      syntheticIntelligence: true,
      records: [],
      health: { status: "ok", backend: MOCK_INTELLIGENCE_PROVIDER, backendVersion: MOCK_INTELLIGENCE_VERSION },
      error: null,
    };
  }
  if (op === "version") {
    return { ok: true, records: [], version: MOCK_INTELLIGENCE_VERSION, error: null, syntheticIntelligence: true };
  }
  if (op !== "search" && op !== "read") {
    return { ok: false, records: [], error: `mock provider supports search/read/health/version (got '${op}')`, syntheticIntelligence: true };
  }
  if (!channel) {
    return { ok: false, records: [], error: "the mock provider needs a channel", syntheticIntelligence: true };
  }
  if (call.fixture !== undefined && call.fixture !== null && call.fixture !== "" && call.fixture !== "synthetic") {
    return { ok: false, records: [], error: `unknown mock fixture '${call.fixture}' (only 'synthetic' exists)`, syntheticIntelligence: true };
  }
  return {
    ok: true,
    provider: MOCK_INTELLIGENCE_PROVIDER,
    syntheticIntelligence: true,
    backendVersion: MOCK_INTELLIGENCE_VERSION,
    records: mockRecordsForQuery({
      channel,
      query: query ?? channel,
      limit,
      now,
      authorPool: call.authorPool,
      duplicateText: call.duplicateText,
    }),
    error: null,
  };
}

export const MOCK_INTELLIGENCE = Object.freeze({
  name: MOCK_INTELLIGENCE_PROVIDER,
  version: MOCK_INTELLIGENCE_VERSION,
  deterministic: true,
  external: false,
  subprocess: false,
  network: false,
  syntheticIntelligence: true,
  execute: executeMockIntelligence,
});

export default MOCK_INTELLIGENCE;
