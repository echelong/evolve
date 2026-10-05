#!/usr/bin/env node
// Phase 5K.6 - BLUESKY ADAPTER ENTRY POINT (the second real public provider).
//
//   transport (network)  ->  mapper (pure)  ->  ingestPublicObservation (5K.1)
//                        ->  additive provider revision evidence (5K.5/5K.6)
//
// The adapter terminates at the unchanged 5K.1 ingestion boundary. It produces
// no signal, sentiment, score, ranking, recommendation, wallet/engine/Arena
// action or profitability inference. It sends and stores NO credential: the
// AppView endpoint it uses is public and unauthenticated.
//
// REVISION EVIDENCE (Bluesky-specific, provider-neutral downstream)
//
// The AT Protocol repository spec states that updating a record changes its CID
// while the path - and hence the AT URI - stays the same. A CID change under an
// unchanged AT URI is therefore PROVIDER-DECLARED evidence of a content
// revision, and it is stronger evidence than a provider edit timestamp because
// it is content-addressed rather than self-reported.
//
// 5K.6 emits that as the additive, fingerprint-bound evidence record 5K.5 already
// consumes. The record is bound to the unchanged 5K.1 `rawObservationFingerprint`,
// so it can never be replayed onto different evidence.
import { pathToFileURL } from 'node:url';
import { ingestPublicObservation, createMemoryStore, createNdjsonStore } from '../index.mjs';
import { fetchBlueskySearch } from './bluesky-transport.mjs';
import { mapPostViewToRawObservation, providerContentCidOf, classifyBlueskySourceType } from './bluesky-mapper.mjs';
import { BlueskyAdapterError, BLUESKY_PROVIDER_NAMESPACE } from './bluesky-common.mjs';
import { rawObservationFingerprint } from '../provenance.mjs';
import { buildProviderRevisionEvidence } from './bluesky-revision.mjs';

export { mapPostViewToRawObservation, providerContentCidOf, classifyBlueskySourceType };

/**
 * Acquires bounded public Bluesky posts, maps each to a 5K.1 raw observation,
 * ingests them into a caller-supplied store, and returns the additive provider
 * revision evidence bound to each ingested observation.
 *
 * options: { term, bounds, collectionRunId, store?, fetchImpl?, now? }
 * A record the mapper refuses is counted by reason; it never aborts the run.
 */
export async function fetchPublicBlueskyObservations(options) {
  const { term, bounds, collectionRunId, store, fetchImpl, now } = options ?? {};
  const acquired = await fetchBlueskySearch({ term, bounds, fetchImpl, now });
  const observations = [];
  const revisionEvidence = [];
  const refused = [];
  const ingestOutcomes = {};
  for (const record of acquired.records) {
    let mapped;
    try {
      mapped = mapPostViewToRawObservation(record, {
        fetchedAt: acquired.fetchedAt,
        collectionRunId,
        collectorMode: 'LIVE_PUBLIC_PROVIDER',
      });
    } catch (error) {
      const reason = error instanceof BlueskyAdapterError
        ? (error.code === 'BLUESKY_RECORD_REFUSED' ? error.details.reason : error.code)
        : 'MAPPING_FAILED';
      refused.push(reason);
      continue;
    }
    observations.push(mapped.raw);
    // The CID sidecar is bound to the exact immutable raw evidence it describes.
    revisionEvidence.push(buildProviderRevisionEvidence({
      provider: mapped.raw.provider,
      providerObservationId: mapped.raw.providerObservationId,
      rawObservationFingerprint: rawObservationFingerprint(mapped.raw),
      providerContentCid: mapped.providerContentCid,
    }));
    if (store) {
      const result = ingestPublicObservation(mapped.raw, { store });
      ingestOutcomes[result.outcome] = (ingestOutcomes[result.outcome] ?? 0) + 1;
    }
  }
  return Object.freeze({
    observations,
    revisionEvidence,
    refused,
    ingestOutcomes,
    pagesFetched: acquired.pagesFetched,
    requestsMade: acquired.requestsMade,
    stopReason: acquired.stopReason,
    rateLimit: acquired.rateLimit,
    fetchedAt: acquired.fetchedAt,
  });
}

// ---------------------------------------------------------------------------
// BOUNDED-RUN ADAPTER (5K.3 integration)
// ---------------------------------------------------------------------------
// 5K.3's run engine takes an INJECTED adapter rather than importing a transport,
// which is what lets 5K.6 reuse the unchanged run/manifest/replay machinery
// without dragging a second `fetch` holder into the 5K.3 closure.
//
// The adapter speaks 5K.3's shape: `map(record, context) -> raw observation`.
// The provider CID is captured on the SIDE (`evidenceFor`) so it never has to be
// pushed into the frozen 5K.1 raw schema.
const MAP_SLOT = 'map';
const FETCH_SLOT = 'fetch';
const PROVIDER_SLOT = 'provider';

/**
 * Builds the 5K.3 adapter for the Bluesky provider.
 *
 * `onEvidence` receives the fingerprint-bound revision sidecar for every record
 * that maps successfully, so the caller keeps provider-native CID evidence
 * WITHOUT the frozen 5K.1 schema having to learn about CIDs.
 */
export function createBlueskyRunAdapter({ onEvidence = null } = {}) {
  return Object.freeze({
    [PROVIDER_SLOT]: 'bluesky',
    [FETCH_SLOT]: options => fetchBlueskySearch(options),
    [MAP_SLOT]: (view, context) => {
      const mapped = mapPostViewToRawObservation(view, context);
      if (onEvidence) {
        onEvidence(buildProviderRevisionEvidence({
          provider: mapped.raw.provider,
          providerObservationId: mapped.raw.providerObservationId,
          rawObservationFingerprint: rawObservationFingerprint(mapped.raw),
          providerContentCid: mapped.providerContentCid,
        }));
      }
      return mapped.raw;
    },
  });
}


// ---------------------------------------------------------------------------
// EXPLICIT LIVE SMOKE TEST:
//   node scripts/public-intelligence/providers/bluesky.mjs smoke
//     [--term solana] [--records 5] [--pages 1] [--out <absolute temp dir>]
// Tiny bounds, no persistent write unless --out is given, structural counts
// ONLY: no text, no AT URI, no DID, no handle, no URLs.
// ---------------------------------------------------------------------------
const SMOKE_BOUNDS = Object.freeze({
  maxPages: 1, maxRecords: 5, maxResponseBytes: 512 * 1024, timeoutMs: 15_000, lookbackMs: 24 * 60 * 60 * 1000, maxRetries: 0,
});

function argValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

async function smoke(args) {
  const term = argValue(args, '--term', 'solana');
  const out = argValue(args, '--out', null);
  const store = out ? createNdjsonStore(out) : createMemoryStore();
  const collectionRunId = `smoke-5k6-${Date.now()}`;
  try {
    const result = await fetchPublicBlueskyObservations({ term, bounds: SMOKE_BOUNDS, collectionRunId, store });
    const associationStatuses = {};
    for (const raw of result.observations) {
      const outcome = ingestPublicObservation(raw, { store }).outcome;
      associationStatuses[outcome] = (associationStatuses[outcome] ?? 0) + 1;
    }
    console.log(JSON.stringify({
      smoke: 'PASS',
      provider: BLUESKY_PROVIDER_NAMESPACE,
      term,
      pagesFetched: result.pagesFetched,
      requestsMade: result.requestsMade,
      stopReason: result.stopReason,
      mapped: result.observations.length,
      revisionEvidenceRecords: result.revisionEvidence.length,
      refusedReasons: result.refused,
      associationStatuses,
      rateLimitRemaining: result.rateLimit?.rateLimitRemaining ?? null,
      credentialsSent: false,
      persisted: out ? 'explicit-temp-output' : 'none',
    }, null, 2));
  } catch (error) {
    if (error instanceof BlueskyAdapterError) {
      console.error(JSON.stringify({ smoke: 'FAIL', code: error.code, details: error.details }, null, 2));
    } else {
      console.error(JSON.stringify({ smoke: 'FAIL', code: 'UNEXPECTED', message: String(error?.message ?? error).slice(0, 200) }));
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'smoke') await smoke(process.argv.slice(3));
  else { console.error('usage: bluesky.mjs smoke [--term T] [--records N] [--pages N] [--out DIR]'); process.exitCode = 2; }
}
