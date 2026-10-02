#!/usr/bin/env node
// Phase 5K.2 - MASTODON ADAPTER (the first live public provider).
//
//   transport (network)  ->  mapper (pure)  ->  ingestPublicObservation (5K.1)
//
// The adapter terminates at the 5K.1 ingestion boundary. It produces no signal,
// sentiment, score, ranking, recommendation, wallet/engine/Arena action or
// profitability inference. It sends and stores no credential: the endpoint it
// uses is public and unauthenticated.
//
// The only entry point that touches the network is the explicit `smoke` CLI
// command below (or a caller invoking `fetchPublicObservations` directly).
// Normal validators never call it with a live fetch.
import { pathToFileURL } from 'node:url';
import { ingestPublicObservation, createMemoryStore, createNdjsonStore } from '../index.mjs';
import { fetchHashtagTimeline } from './mastodon-transport.mjs';
import { mapStatusToRawObservation } from './mastodon-mapper.mjs';
import { ProviderAdapterError } from './common.mjs';

export { mapStatusToRawObservation } from './mastodon-mapper.mjs';

/**
 * Acquires bounded public statuses, maps each to a 5K.1 raw observation, and
 * (optionally) ingests them into a caller-supplied store.
 *
 * options: host, hashtag, bounds, collectionRunId, store?, fetchImpl?, now?
 * A record the mapper refuses is counted by reason; it never aborts the run and
 * is never repaired.
 */
export async function fetchPublicObservations(options) {
  const { host, hashtag, bounds, collectionRunId, store, fetchImpl, now } = options ?? {};
  const acquired = await fetchHashtagTimeline({ host, hashtag, bounds, fetchImpl, now });
  const lowerHost = host.toLowerCase();
  const observations = [];
  const refused = [];
  const ingestOutcomes = {};
  for (const record of acquired.records) {
    let raw;
    try {
      raw = mapStatusToRawObservation(record, {
        host: lowerHost,
        fetchedAt: acquired.fetchedAt,
        collectionRunId,
        collectorMode: 'LIVE_PUBLIC_PROVIDER',
      });
    } catch (error) {
      const reason = error instanceof ProviderAdapterError
        ? (error.code === 'PROVIDER_RECORD_REFUSED' ? error.details.reason : error.code)
        : 'MAPPING_FAILED';
      refused.push(reason);
      continue;
    }
    observations.push(raw);
    if (store) {
      const result = ingestPublicObservation(raw, { store });
      ingestOutcomes[result.outcome] = (ingestOutcomes[result.outcome] ?? 0) + 1;
    }
  }
  return Object.freeze({
    observations,
    refused,
    ingestOutcomes,
    pagesFetched: acquired.pagesFetched,
    stopReason: acquired.stopReason,
    rateLimit: acquired.rateLimit,
    fetchedAt: acquired.fetchedAt,
  });
}

// ---------------------------------------------------------------------------
// EXPLICIT LIVE SMOKE TEST:  node scripts/public-intelligence/providers/mastodon.mjs smoke
//   [--host mastodon.social] [--hashtag solana] [--out <absolute temp dir>]
// Tiny bounds, no persistent write unless --out is given, redacted structure only.
// ---------------------------------------------------------------------------
const SMOKE_BOUNDS = Object.freeze({
  maxPages: 1, maxRecords: 5, maxResponseBytes: 512 * 1024, timeoutMs: 10_000, lookbackMs: 24 * 60 * 60 * 1000, maxRetries: 0,
});

function argValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

async function smoke(args) {
  const host = argValue(args, '--host', 'mastodon.social');
  const hashtag = argValue(args, '--hashtag', 'solana');
  const out = argValue(args, '--out', null);
  const store = out ? createNdjsonStore(out) : createMemoryStore();
  const collectionRunId = `smoke-5k2-${Date.now()}`;
  try {
    const result = await fetchPublicObservations({ host, hashtag, bounds: SMOKE_BOUNDS, collectionRunId, store });
    const statuses = {};
    for (const raw of result.observations) {
      const key = raw.claimedMint === null ? 'claimedMintNull' : 'claimedMintSet';
      statuses[key] = (statuses[key] ?? 0) + 1;
    }
    // Redacted structural metadata ONLY: no text, no URLs, no ids, no authors.
    console.log(JSON.stringify({
      smoke: 'PASS',
      host, hashtag,
      pagesFetched: result.pagesFetched,
      stopReason: result.stopReason,
      mapped: result.observations.length,
      refusedReasons: result.refused,
      ingestOutcomes: result.ingestOutcomes,
      mintClaims: statuses,
      rateLimitRemaining: result.rateLimit?.rateLimitRemaining ?? null,
      persisted: out ? 'explicit-temp-output' : 'none',
    }, null, 2));
  } catch (error) {
    if (error instanceof ProviderAdapterError) {
      console.error(JSON.stringify({ smoke: 'FAIL', code: error.code, details: error.details }, null, 2));
    } else {
      console.error(JSON.stringify({ smoke: 'FAIL', code: 'UNEXPECTED', message: String(error?.message ?? error).slice(0, 200) }));
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'smoke') await smoke(process.argv.slice(3));
  else { console.error('usage: mastodon.mjs smoke [--host H] [--hashtag T] [--out DIR]'); process.exitCode = 2; }
}
