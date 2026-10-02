// Phase 5K.1 - INGEST PIPELINE.
//
//   ingestPublicObservation(rawInput, context) -> deterministic result
//
// Nine stages, in this order, each of which can only refuse - never repair:
//
//    1. closed-schema validation            (unknown field -> refuse)
//    2. raw canonicalization               (without altering evidence)
//    3. raw fingerprint                    (anchored to raw evidence)
//    4. exact-mint validation              (only if a mint is claimed)
//    5. normalized projection              (pure function of raw)
//    6. provenance generation              (source identity + fingerprints)
//    7. dedup decision                     (provider-aware, idempotent)
//    8. persistence                        (raw before normalization)
//    9. deterministic return               (frozen, reproducible)
//
// No network call. No provider SDK. No credential. No environment read. No
// clock read: `fetchedAt` is supplied by the caller as evidence, because a
// pipeline that stamps its own clock cannot be replayed deterministically.
//
// OFFLINE BY CONSTRUCTION.
import { canonicalizeRawObservation, failClosed, claimedMintOf, exactClaimedMint } from './observation.mjs';
import { rawObservationFingerprint, verifyProvenance5K1 } from './provenance.mjs';
import { normalizeObservation5K1, normalizedFingerprint5K1 } from './normalize.mjs';
import { dedupIdentity5K1, decideDedup, PUBLIC_INTELLIGENCE_5K1_DEDUP_OUTCOMES } from './dedup.mjs';
import { createMemoryStore, buildEnvelope } from './store.mjs';

/**
 * The ingest contract, stated as data. A caller can read the whole pipeline's
 * guarantees without reading its implementation.
 */
export const PUBLIC_INTELLIGENCE_5K1_INGEST = Object.freeze({
  stageCount: 9,
  stages: Object.freeze([
    'CLOSED_SCHEMA_VALIDATION',
    'RAW_CANONICALIZATION',
    'RAW_FINGERPRINT',
    'EXACT_MINT_VALIDATION',
    'NORMALIZED_PROJECTION',
    'PROVENANCE_GENERATION',
    'DEDUP_DECISION',
    'PERSISTENCE',
    'DETERMINISTIC_RETURN',
  ]),
  networkCalls: 0,
  providerSdks: 0,
  readsEnvironment: false,
  readsClock: false,
  fetchedAtSuppliedByCaller: true,
  rawWrittenBeforeNormalization: true,
  idempotent: true,
  providerAwareDedup: true,
  conflictOverwritesPermitted: false,
  deterministicReturn: true,
});

/** Ingest outcome codes. */
export const PUBLIC_INTELLIGENCE_5K1_INGEST_OUTCOMES = Object.freeze({
  INGESTED: 'INGESTED',
  ALREADY_PRESENT: 'ALREADY_PRESENT',
});

/**
 * Ingests one raw public observation.
 *
 * `context.store` is optional; without it a fresh in-memory store is used, so a
 * single observation can be ingested without any persistence. A caller that
 * wants durability passes a store built by `createNdjsonStore`.
 *
 * The returned object is frozen and is a pure function of (rawInput, store
 * state). Re-ingesting identical evidence returns the identical result.
 */
export function ingestPublicObservation(rawInput, context = {}) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    failClosed('PUBLIC_INTELLIGENCE_5K1_INGEST_CONTEXT_INVALID');
  }
  const store = context.store ?? createMemoryStore();
  if (typeof store?.put !== 'function' || typeof store?.get !== 'function') {
    failClosed('PUBLIC_INTELLIGENCE_5K1_INGEST_STORE_INVALID');
  }

  // STAGE 1 + 2: closed-schema validation, then canonicalization. Validation
  // runs inside canonicalization, so an unknown field is refused before any
  // value is copied.
  const raw = canonicalizeRawObservation(rawInput);

  // STAGE 3: the raw fingerprint, anchored to raw evidence.
  const fingerprint = rawObservationFingerprint(raw);

  // STAGE 4: exact-mint validation, only when a mint is explicitly claimed.
  // This NEVER creates a mint. It can only accept the exact string that is
  // already present in evidence, or refuse it by yielding null. A malformed
  // claim is not an exception: the observation is still valid evidence, it
  // simply has no canonical subject, which the association projection records.
  const claimed = claimedMintOf(raw);
  const exactMint = exactClaimedMint(raw);
  const mintAccepted = claimed !== null && exactMint !== null;

  // STAGE 5 + 6: normalized projection and provenance, both pure functions of
  // raw evidence, both proven not to mutate it.
  const normalized = normalizeObservation5K1(raw);
  if (normalized.rawObservationFingerprint !== fingerprint) {
    failClosed('PUBLIC_INTELLIGENCE_5K1_FINGERPRINT_DISAGREEMENT');
  }
  // Provenance is verified against the raw evidence BEFORE anything is stored.
  // A record that cannot prove its own origin never reaches disk.
  verifyProvenance5K1(normalized.provenance, raw);

  // STAGE 7: provider-aware dedup decision.
  const dedupIdentity = dedupIdentity5K1(raw);
  const existing = store.get(dedupIdentity);
  const decision = decideDedup(normalized, existing);

  if (decision.outcome === PUBLIC_INTELLIGENCE_5K1_DEDUP_OUTCOMES.CONFLICT) {
    // Same upstream identity, different bytes. Refuse rather than overwrite:
    // last-write-wins would silently destroy evidence.
    failClosed('PUBLIC_INTELLIGENCE_5K1_INGEST_CONFLICT_REFUSED');
  }
  if (decision.outcome === PUBLIC_INTELLIGENCE_5K1_DEDUP_OUTCOMES.DUPLICATE) {
    // STAGE 9: idempotent return. Nothing is written a second time.
    return Object.freeze(buildResult({
      outcome: PUBLIC_INTELLIGENCE_5K1_INGEST_OUTCOMES.ALREADY_PRESENT,
      normalized: existing?.normalized ?? normalized,
      stored: false,
      dedupIdentity,
      fingerprint,
      mintAccepted,
      reason: decision.reason,
    }));
  }

  // STAGE 8: persistence. Raw evidence is inside the envelope alongside
  // normalization, and the envelope is written only after provenance verified.
  const envelope = buildEnvelope(normalized);
  const written = store.put(envelope);

  // STAGE 9: deterministic return value.
  return Object.freeze(buildResult({
    outcome: PUBLIC_INTELLIGENCE_5K1_INGEST_OUTCOMES.INGESTED,
    normalized,
    stored: written.stored === true,
    dedupIdentity,
    fingerprint,
    mintAccepted,
    reason: decision.reason,
  }));
}

/** Assembles the frozen, deterministic ingest result. */
function buildResult({ outcome, normalized, stored, dedupIdentity, fingerprint, mintAccepted, reason }) {
  return {
    schemaVersion: normalized.schemaVersion,
    recordType: 'public_social_ingest_result',
    phase: 'PHASE_5K_1',
    outcome,
    stored,
    reason: reason ?? null,
    dedupIdentity,
    rawObservationFingerprint: fingerprint,
    normalizedFingerprint: normalizedFingerprint5K1(normalized),
    provider: normalized.provider,
    providerObservationId: normalized.providerObservationId,
    exactMintAccepted: mintAccepted,
    assetAssociation: normalized.assetAssociation,
    provenance: normalized.provenance,
    classification: normalized.classification,
  };
}
