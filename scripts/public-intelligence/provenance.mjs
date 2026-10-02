// Phase 5K.1 - PROVENANCE: deterministic fingerprints anchored to RAW evidence.
//
// A provenance fingerprint answers four questions about one observation and can
// answer nothing else: WHICH provider, WHICH provider observation id, WHEN it
// was fetched, and WHAT raw evidence was received.
//
// Two rules make provenance worth anything:
//
//   1. Fingerprints are computed over canonical serialization (EVOLVE canonical
//      JSON + SHA-256), so they are reproducible on any machine, forever.
//   2. Fingerprints are ANCHORED TO RAW EVIDENCE. Content is fingerprinted as
//      received, not as interpreted. Normalized content never substitutes for
//      raw content, so a normalization bug cannot launder mutated evidence.
//
// Mutable runtime bookkeeping (storage sequence numbers, ingest wall-clock
// notes) is EXCLUDED from every fingerprint. Without that exclusion, replaying
// the same evidence would produce a different identity, which would make
// deduplication impossible.
//
// OFFLINE BY CONSTRUCTION: no socket, no provider SDK, no environment read.
import {
  PUBLIC_INTELLIGENCE_SCHEMA_VERSION,
  canonical, digest, isValidTimestamp,
} from './definition.mjs';
import { validateRawObservation5K1, failClosed } from './observation.mjs';

/**
 * Fields that describe *runtime bookkeeping* rather than evidence. They are
 * excluded from fingerprints so identity stays a property of the evidence and
 * not of when it happened to be written.
 */
export const PUBLIC_INTELLIGENCE_5K1_NON_EVIDENCE_FIELDS = Object.freeze([
  'ingestSequence',
  'ingestWallClockNote',
  'storageLocation',
  'runtimeScratch',
]);

/** Strips non-evidence runtime fields. The result is a deep, sorted copy. */
function evidenceProjection(value) {
  if (Array.isArray(value)) return value.map(evidenceProjection);
  if (value && typeof value === 'object') {
    const projected = {};
    for (const key of Object.keys(value).sort()) {
      if (PUBLIC_INTELLIGENCE_5K1_NON_EVIDENCE_FIELDS.includes(key)) continue;
      projected[key] = evidenceProjection(value[key]);
    }
    return projected;
  }
  return value;
}

/**
 * The fingerprint contract. Stated as data so a reviewer can read the whole
 * rule set in one place instead of inferring it from the code.
 */
export const PUBLIC_INTELLIGENCE_5K1_FINGERPRINTING = Object.freeze({
  algorithm: 'SHA-256',
  serialization: 'EVOLVE_CANONICAL_JSON',
  serializationSource: 'scripts/market-intelligence/definition.mjs',
  anchoredToRawEvidence: true,
  hashesNormalizedContentOnly: false,
  deterministic: true,
  reproducible: true,
  excludesMutableRuntimeFields: true,
  excludedRuntimeFields: PUBLIC_INTELLIGENCE_5K1_NON_EVIDENCE_FIELDS,
  failsClosedOnUnknownSchemaFields: true,
  providerParticipates: true,
  providerObservationIdParticipates: true,
  fetchedAtParticipates: true,
  rawTextParticipates: true,
  rawMetadataParticipates: true,
  claimedMintParticipates: true,
});

/**
 * THE canonical raw-evidence fingerprint.
 *
 * Covers provider, providerObservationId, fetchedAt, rawText, rawMetadata,
 * claimedMint and every other evidence field of the raw record. Mutating any
 * evidence field - including a single character of rawText - changes it.
 */
export function rawObservationFingerprint(raw) {
  validateRawObservation5K1(raw);
  return digest(evidenceProjection(raw));
}

/** A stable fingerprint over one canonicalized value, used for sub-fields. */
export const contentFingerprint = value => digest(evidenceProjection(value));

/** Digest of the exact raw text as received, character for character. */
export const rawTextFingerprint = raw => contentFingerprint(raw?.rawText ?? null);

/** Digest of the exact raw metadata as received. */
export const rawMetadataFingerprint = raw => contentFingerprint(raw?.rawMetadata ?? null);

// ---------------------------------------------------------------------------
// PROVENANCE RECORD + VERIFICATION
// ---------------------------------------------------------------------------

/**
 * The provenance record carried by every normalized observation. Closed schema:
 * it carries source identity, not interpretation, and nothing more.
 */
export const PUBLIC_INTELLIGENCE_5K1_PROVENANCE_SCHEMA = Object.freeze({
  closed: true,
  fields: Object.freeze([
    'schemaVersion',
    'phase',
    'provider',
    'providerObservationId',
    'providerAuthorId',
    'sourceType',
    'sourceUrl',
    'fetchedAt',
    'observedAt',
    'publishedAt',
    'rawObservationFingerprint',
    'rawTextFingerprint',
    'rawMetadataFingerprint',
    'collectionContext',
    'algorithm',
    'serialization',
  ]),
});

/**
 * Builds deterministic provenance for one canonical raw observation.
 *
 * `publishedAt` is carried verbatim, INCLUDING when it is null. Provenance never
 * substitutes fetchedAt for a missing publishedAt, because that substitution is
 * exactly the look-ahead that 5K.0 forbids.
 */
export function buildProvenance(raw) {
  validateRawObservation5K1(raw);
  return Object.freeze({
    schemaVersion: PUBLIC_INTELLIGENCE_SCHEMA_VERSION,
    phase: 'PHASE_5K_1',
    provider: raw.provider,
    providerObservationId: raw.providerObservationId,
    providerAuthorId: raw.providerAuthorId,
    sourceType: raw.sourceType,
    sourceUrl: raw.sourceUrl,
    fetchedAt: raw.fetchedAt,
    observedAt: raw.observedAt,
    publishedAt: raw.publishedAt,
    rawObservationFingerprint: rawObservationFingerprint(raw),
    rawTextFingerprint: rawTextFingerprint(raw),
    rawMetadataFingerprint: rawMetadataFingerprint(raw),
    collectionContext: raw.collectionContext,
    algorithm: PUBLIC_INTELLIGENCE_5K1_FINGERPRINTING.algorithm,
    serialization: PUBLIC_INTELLIGENCE_5K1_FINGERPRINTING.serialization,
  });
}

/**
 * A normalized observation must trace back to EXACTLY the raw evidence it
 * claims. Any tampering with the recorded source identity or fingerprints fails
 * closed; a mismatch is never repaired, downgraded or ignored.
 */
export function verifyProvenance5K1(provenance, raw) {
  if (!provenance || typeof provenance !== 'object') failClosed('PUBLIC_INTELLIGENCE_5K1_PROVENANCE_MISSING');
  validateRawObservation5K1(raw);

  const allowed = new Set(PUBLIC_INTELLIGENCE_5K1_PROVENANCE_SCHEMA.fields);
  for (const key of Object.keys(provenance)) {
    if (!allowed.has(key)) failClosed(`PUBLIC_INTELLIGENCE_5K1_PROVENANCE_UNKNOWN_FIELD:${key}`);
  }
  for (const field of PUBLIC_INTELLIGENCE_5K1_PROVENANCE_SCHEMA.fields) {
    if (provenance[field] === undefined) failClosed(`PUBLIC_INTELLIGENCE_5K1_PROVENANCE_FIELD_MISSING:${field}`);
  }

  // Each provenance claim is re-derived from raw evidence and compared. A single
  // mismatch is a tamper, and every mismatch is fatal.
  const checks = [
    ['provider', provenance.provider, raw.provider],
    ['providerObservationId', provenance.providerObservationId, raw.providerObservationId],
    ['providerAuthorId', provenance.providerAuthorId, raw.providerAuthorId],
    ['sourceType', provenance.sourceType, raw.sourceType],
    ['sourceUrl', provenance.sourceUrl, raw.sourceUrl],
    ['fetchedAt', provenance.fetchedAt, raw.fetchedAt],
    ['observedAt', provenance.observedAt, raw.observedAt],
    ['publishedAt', provenance.publishedAt, raw.publishedAt],
    ['rawObservationFingerprint', provenance.rawObservationFingerprint, rawObservationFingerprint(raw)],
    ['rawTextFingerprint', provenance.rawTextFingerprint, rawTextFingerprint(raw)],
    ['rawMetadataFingerprint', provenance.rawMetadataFingerprint, rawMetadataFingerprint(raw)],
  ];
  for (const [field, claimed, actual] of checks) {
    if (canonical(claimed) !== canonical(actual)) {
      failClosed(`PUBLIC_INTELLIGENCE_5K1_PROVENANCE_MISMATCH:${field}`);
    }
  }
  if (canonical(provenance.collectionContext) !== canonical(raw.collectionContext)) {
    failClosed('PUBLIC_INTELLIGENCE_5K1_PROVENANCE_MISMATCH:collectionContext');
  }
  if (provenance.algorithm !== PUBLIC_INTELLIGENCE_5K1_FINGERPRINTING.algorithm) {
    failClosed('PUBLIC_INTELLIGENCE_5K1_PROVENANCE_ALGORITHM_MISMATCH');
  }
  if (provenance.serialization !== PUBLIC_INTELLIGENCE_5K1_FINGERPRINTING.serialization) {
    failClosed('PUBLIC_INTELLIGENCE_5K1_PROVENANCE_SERIALIZATION_MISMATCH');
  }
  if (!isValidTimestamp(provenance.fetchedAt)) {
    failClosed('PUBLIC_INTELLIGENCE_5K1_PROVENANCE_FETCHED_AT_INVALID');
  }
  return true;
}
