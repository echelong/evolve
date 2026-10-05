// Phase 5K.5 - TEMPORAL PROJECTION: the explicit field classification, and the
// derived CONTENT / OBSERVATION-STATE / ACQUISITION projections.
//
// PURE AND OFFLINE BY CONSTRUCTION. No filesystem, no socket, no clock, no
// environment, no provider SDK. It reads an already AUTHENTICATED raw record
// and derives fingerprints from it.
//
// THE RULE THIS MODULE EXISTS TO ENFORCE
//
// 5K.4 compared raw evidence across runs after deleting exactly two keys
// (`fetchedAt`, `collectionContext`) and called every remaining difference a
// conflict. That was safe but too coarse: an engagement counter that moved from
// 10 to 14 is a fact about the same post, not a corruption of it.
//
// 5K.5 therefore separates three things that 5K.4 collapsed into one:
//
//   UPSTREAM IDENTITY   (provider, providerObservationId) - unchanged 5K.1 rule.
//   CONTENT             stable, content-bearing public post evidence.
//   OBSERVATION STATE   provider-supplied counters that may legitimately move.
//
// plus two non-evidence classes:
//
//   ACQUISITION         when and how we fetched it. Never content.
//   DERIVED             EVOLVE's own governance/version stamps.
//
// NO DELETION OF RAW PROVENANCE: `rawObservationFingerprint` is 5K.1's, is
// imported unchanged, and remains authoritative for what was received. The
// fingerprints below are ADDITIONAL derived views over the same immutable bytes.
//
// FIELD CLASSIFICATION IS CLOSED AND EXHAUSTIVE. Every field of the 5K.1 raw
// schema, of its raw metadata, of its collection context, of the engagement
// counter set and of the 5K.1 normalized schema is classified here, in one
// place, as exactly one of five classes. `classifyField` refuses any name that
// is not in the tables, and `assertFieldClassificationComplete` refuses any
// table that drifts from the 5K.1 schemas it mirrors. Nothing falls through
// implicitly and unknown fields fail closed.
//
// ZERO authority over mint: `claimedMint` is CONTENT (so an explicit mint
// evidence change is a content event), and the exact-mint rule itself is
// untouched - 5K.1 still decides EXACT_MINT / UNASSOCIATED / AMBIGUOUS.
import {
  PUBLIC_INTELLIGENCE_5K1_RAW_SCHEMA, PUBLIC_INTELLIGENCE_5K1_RAW_METADATA_SCHEMA,
  PUBLIC_INTELLIGENCE_5K1_COLLECTION_CONTEXT_SCHEMA, failClosed,
} from './observation.mjs';
import { PUBLIC_INTELLIGENCE_5K1_NORMALIZED_SCHEMA } from './normalize.mjs';
import { rawObservationFingerprint } from './provenance.mjs';
import { canonical, digest, PUBLIC_INTELLIGENCE_CLASSIFICATION } from './definition.mjs';

export const PUBLIC_INTELLIGENCE_5K5_PHASE = 'PHASE_5K_5';
export const PUBLIC_INTELLIGENCE_5K5_SCHEMA_VERSION = '5K.5.0';
/** Governed policy name. Any change to any projection is a new policy name. */
export const PUBLIC_INTELLIGENCE_5K5_TEMPORAL_POLICY_VERSION = 'temporal-policy-1';

/**
 * The closed field classes. There are five, there is no default, and there is
 * no sixth.
 */
export const PUBLIC_INTELLIGENCE_5K5_FIELD_CLASS = Object.freeze({
  IDENTITY: 'IDENTITY',
  CONTENT: 'CONTENT',
  OBSERVATION_STATE: 'OBSERVATION_STATE',
  ACQUISITION: 'ACQUISITION',
  DERIVED: 'DERIVED',
});
export const PUBLIC_INTELLIGENCE_5K5_FIELD_CLASSES = Object.freeze(
  Object.keys(PUBLIC_INTELLIGENCE_5K5_FIELD_CLASS).map(key => PUBLIC_INTELLIGENCE_5K5_FIELD_CLASS[key]),
);

const C = PUBLIC_INTELLIGENCE_5K5_FIELD_CLASS;

/**
 * Which projection a class participates in. Stated as data so a reviewer can
 * read the whole rule set in one place instead of inferring it from code.
 *
 * IDENTITY carries no projection of its own: upstream identity is the scope
 * every projection is anchored to, never a member of a projection body.
 */
export const PUBLIC_INTELLIGENCE_5K5_PROJECTION_MEMBERSHIP = Object.freeze({
  [C.IDENTITY]: Object.freeze([]),
  [C.CONTENT]: Object.freeze(['content']),
  [C.OBSERVATION_STATE]: Object.freeze(['observationState']),
  [C.ACQUISITION]: Object.freeze(['acquisition']),
  [C.DERIVED]: Object.freeze([]),
});

// ---------------------------------------------------------------------------
// 1. FIELD CLASSIFICATION (closed, exhaustive, fail-closed)
// ---------------------------------------------------------------------------

/**
 * Raw record fields.
 *
 * providerAuthorId is CONTENT, not IDENTITY. Mastodon cannot re-assign the
 * author of an existing status, so an author change under an unchanged
 * providerObservationId is an upstream inconsistency about the same post, and
 * that is a content event rather than a different identity. Upstream identity
 * stays EXACTLY (provider, providerObservationId), per the 5K.1 rule.
 */
export const PUBLIC_INTELLIGENCE_5K5_RAW_FIELD_CLASSIFICATION = Object.freeze({
  schemaVersion: C.DERIVED,
  recordType: C.DERIVED,
  provider: C.IDENTITY,
  providerObservationId: C.IDENTITY,
  providerAuthorId: C.CONTENT,
  sourceType: C.CONTENT,
  sourceUrl: C.CONTENT,
  publishedAt: C.CONTENT,
  observedAt: C.ACQUISITION,
  fetchedAt: C.ACQUISITION,
  rawText: C.CONTENT,
  rawMetadata: C.CONTENT,
  claimedMint: C.CONTENT,
  collectionContext: C.ACQUISITION,
  classification: C.DERIVED,
});

/**
 * Raw metadata fields.
 *
 * `engagement` is the ONLY observation-state member. Every other metadata field
 * is a minimized, provider-declared description of the post's content, so it is
 * CONTENT. Nothing becomes mutable merely because it happens to change: the
 * mutable set is exactly the provider-supplied counter object, and a change to
 * `hashtags` or `language` remains a content event.
 */
export const PUBLIC_INTELLIGENCE_5K5_RAW_METADATA_FIELD_CLASSIFICATION = Object.freeze({
  language: C.CONTENT,
  engagement: C.OBSERVATION_STATE,
  cashtags: C.CONTENT,
  hashtags: C.CONTENT,
  mentionedHandles: C.CONTENT,
  claimedSymbol: C.CONTENT,
  claimedTokenName: C.CONTENT,
  candidateMintAddresses: C.CONTENT,
  similaritySignals: C.CONTENT,
  fixtureNote: C.CONTENT,
});

/** Collection context is acquisition metadata in full: which run, which adapter. */
export const PUBLIC_INTELLIGENCE_5K5_COLLECTION_CONTEXT_FIELD_CLASSIFICATION = Object.freeze({
  collectionRunId: C.ACQUISITION,
  adapterName: C.ACQUISITION,
  adapterVersion: C.ACQUISITION,
  collectorMode: C.ACQUISITION,
});

/**
 * The entire governed mutable state set: the provider-supplied public counters
 * 5K.0 froze. They may differ between two acquisitions of the same post without
 * that being a content divergence. There is no other mutable field.
 */
export const PUBLIC_INTELLIGENCE_5K5_OBSERVATION_STATE_FIELDS = Object.freeze(
  PUBLIC_INTELLIGENCE_5K1_RAW_METADATA_SCHEMA.engagementFields,
);

/**
 * Normalized record fields. Every one of them is an EVOLVE projection of raw
 * evidence, so all are DERIVED, except those that merely COPY a raw field, which
 * keep the class of the field they copy. This table exists so that "every
 * retained raw/normalized field is classified" is literally true and checkable,
 * and so drift in either direction is a hard refusal.
 */
export const PUBLIC_INTELLIGENCE_5K5_NORMALIZED_FIELD_CLASSIFICATION = Object.freeze({
  schemaVersion: C.DERIVED,
  recordType: C.DERIVED,
  phase: C.DERIVED,
  rawObservationFingerprint: C.DERIVED,
  raw: C.DERIVED,
  provider: C.IDENTITY,
  providerObservationId: C.IDENTITY,
  providerAuthorId: C.CONTENT,
  sourceType: C.CONTENT,
  sourceUrl: C.CONTENT,
  dedupIdentity: C.DERIVED,
  canonicalText: C.DERIVED,
  canonicalTextFingerprint: C.DERIVED,
  normalizedAuthorIdentity: C.DERIVED,
  publishedAt: C.CONTENT,
  observedAt: C.ACQUISITION,
  fetchedAt: C.ACQUISITION,
  availabilityAt: C.ACQUISITION,
  assetAssociation: C.DERIVED,
  engagement: C.OBSERVATION_STATE,
  missingness: C.DERIVED,
  provenance: C.DERIVED,
  classification: C.DERIVED,
});

/** Namespaced lookups, so a caller cannot classify `publishedAt` in the wrong scope. */
const TABLES = Object.freeze({
  raw: PUBLIC_INTELLIGENCE_5K5_RAW_FIELD_CLASSIFICATION,
  rawMetadata: PUBLIC_INTELLIGENCE_5K5_RAW_METADATA_FIELD_CLASSIFICATION,
  collectionContext: PUBLIC_INTELLIGENCE_5K5_COLLECTION_CONTEXT_FIELD_CLASSIFICATION,
  engagement: Object.freeze(Object.fromEntries(
    PUBLIC_INTELLIGENCE_5K5_OBSERVATION_STATE_FIELDS.map(name => [name, C.OBSERVATION_STATE]),
  )),
  normalized: PUBLIC_INTELLIGENCE_5K5_NORMALIZED_FIELD_CLASSIFICATION,
});
export const PUBLIC_INTELLIGENCE_5K5_FIELD_CLASSIFICATION_TABLES = Object.freeze(Object.keys(TABLES));

/**
 * Classifies one field. An unclassified field is a hard refusal, never a
 * default and never a silent pass.
 */
export function classifyField(scope, name) {
  const table = TABLES[scope];
  if (!table) failClosed(`PUBLIC_INTELLIGENCE_5K5_FIELD_SCOPE_UNKNOWN:${String(scope).slice(0, 40)}`);
  const fieldClass = table[name];
  if (fieldClass === undefined) failClosed(`PUBLIC_INTELLIGENCE_5K5_FIELD_UNCLASSIFIED:${scope}.${String(name).slice(0, 40)}`);
  if (!PUBLIC_INTELLIGENCE_5K5_FIELD_CLASSES.includes(fieldClass)) {
    failClosed(`PUBLIC_INTELLIGENCE_5K5_FIELD_CLASS_INVALID:${scope}.${String(name).slice(0, 40)}`);
  }
  return fieldClass;
}

const exactTable = (table, sourceFields, scope) => {
  if (canonical(Object.keys(table).sort()) !== canonical([...sourceFields].sort())) {
    failClosed(`PUBLIC_INTELLIGENCE_5K5_FIELD_TABLE_DRIFT:${scope}`);
  }
};

/**
 * Fails closed if any governed 5K.1 schema grows a field that 5K.5 has not
 * classified, or if a table names a field that does not exist. This is what
 * makes "no field may fall through implicitly" enforceable rather than a claim.
 */
export function assertFieldClassificationComplete() {
  exactTable(TABLES.raw, PUBLIC_INTELLIGENCE_5K1_RAW_SCHEMA.fields, 'raw');
  exactTable(TABLES.rawMetadata, PUBLIC_INTELLIGENCE_5K1_RAW_METADATA_SCHEMA.fields, 'rawMetadata');
  exactTable(TABLES.collectionContext, PUBLIC_INTELLIGENCE_5K1_COLLECTION_CONTEXT_SCHEMA.fields, 'collectionContext');
  exactTable(TABLES.engagement, PUBLIC_INTELLIGENCE_5K5_OBSERVATION_STATE_FIELDS, 'engagement');
  exactTable(TABLES.normalized, PUBLIC_INTELLIGENCE_5K1_NORMALIZED_SCHEMA.fields, 'normalized');
  return true;
}

// ---------------------------------------------------------------------------
// 2. PROJECTIONS
// ---------------------------------------------------------------------------

const classifyInto = (scope, names, klass) => Object.freeze(
  names.filter(name => classifyField(scope, name) === klass).sort(),
);

/** The exact CONTENT field set, derived from the classification tables. */
export const PUBLIC_INTELLIGENCE_5K5_CONTENT_FIELDS = classifyInto('raw', PUBLIC_INTELLIGENCE_5K1_RAW_SCHEMA.fields, C.CONTENT);
export const PUBLIC_INTELLIGENCE_5K5_CONTENT_METADATA_FIELDS = classifyInto(
  'rawMetadata', PUBLIC_INTELLIGENCE_5K1_RAW_METADATA_SCHEMA.fields, C.CONTENT,
);
export const PUBLIC_INTELLIGENCE_5K5_ACQUISITION_FIELDS = classifyInto('raw', PUBLIC_INTELLIGENCE_5K1_RAW_SCHEMA.fields, C.ACQUISITION);
export const PUBLIC_INTELLIGENCE_5K5_IDENTITY_FIELDS = classifyInto('raw', PUBLIC_INTELLIGENCE_5K1_RAW_SCHEMA.fields, C.IDENTITY);

const plain = value => JSON.parse(canonical(value));

/**
 * The CONTENT projection: a closed, minimized, deterministic view of the
 * content-bearing evidence. Acquisition fields, the mutable counter object and
 * EVOLVE's own governance stamps are excluded BY CONSTRUCTION OF THE
 * CLASSIFICATION, not by an ad-hoc strip list.
 *
 * The post body is never copied into a derived index - a caller receives a
 * digest of this projection, never the text.
 */
export function contentProjection(raw) {
  const metadata = {};
  for (const field of PUBLIC_INTELLIGENCE_5K5_CONTENT_METADATA_FIELDS) metadata[field] = raw.rawMetadata?.[field] ?? null;
  const content = {};
  for (const field of PUBLIC_INTELLIGENCE_5K5_CONTENT_FIELDS) {
    if (field === 'rawMetadata') continue;
    content[field] = raw[field] ?? null;
  }
  return plain({ content, metadata });
}

/**
 * The ACQUISITION projection. This is the formal replacement for 5K.4's ad-hoc
 * "strip fetchedAt and collectionContext" behaviour: the excluded set is now
 * derived from an exhaustive field classification and is auditable.
 */
export function acquisitionProjection(raw) {
  return plain({
    observedAt: raw.observedAt ?? null,
    fetchedAt: raw.fetchedAt,
    collectionContext: raw.collectionContext,
  });
}

/**
 * The OBSERVATION-STATE projection.
 *
 * Missingness is preserved exactly and is never repaired: an absent counter
 * object stays NO_OBSERVATION with `values: null`, an absent key inside a
 * supplied object stays absent and is listed in `absentCounters`, and nothing is
 * ever filled with 0, carried forward from an earlier acquisition, or
 * interpolated.
 */
export function observationStateProjection(raw) {
  const supplied = raw.rawMetadata?.engagement ?? null;
  if (supplied === null || supplied === undefined) {
    return plain({
      status: 'NO_OBSERVATION',
      values: null,
      absentCounters: [...PUBLIC_INTELLIGENCE_5K5_OBSERVATION_STATE_FIELDS].sort(),
    });
  }
  if (typeof supplied !== 'object' || Array.isArray(supplied)) {
    failClosed('PUBLIC_INTELLIGENCE_5K5_OBSERVATION_STATE_NOT_AN_OBJECT');
  }
  for (const key of Object.keys(supplied)) classifyField('engagement', key);
  const values = {};
  const absent = [];
  for (const key of [...PUBLIC_INTELLIGENCE_5K5_OBSERVATION_STATE_FIELDS].sort()) {
    if (!Object.hasOwn(supplied, key)) { absent.push(key); continue; }
    const value = supplied[key];
    // Structural counters only: never a derived, computed or inferred value.
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      failClosed(`PUBLIC_INTELLIGENCE_5K5_OBSERVATION_STATE_COUNTER_INVALID:${key}`);
    }
    values[key] = value;
  }
  return plain({ status: 'OBSERVED', values, absentCounters: absent });
}

// ---------------------------------------------------------------------------
// 3. DERIVED FINGERPRINTS (additional views; the raw fingerprint is untouched)
// ---------------------------------------------------------------------------

const body = (kind, payload) => digest({
  kind, temporalPolicyVersion: PUBLIC_INTELLIGENCE_5K5_TEMPORAL_POLICY_VERSION, ...payload,
});

/** Deterministic CONTENT fingerprint. Anchored to raw evidence, never to normalization. */
export const contentFingerprint5K5 = raw => body('publicTemporalContent5K5', { content: contentProjection(raw) });

/** Deterministic OBSERVATION-STATE fingerprint. Identical counters and missingness => identical digest. */
export const observationStateFingerprint5K5 = raw => body('publicTemporalObservationState5K5', {
  state: observationStateProjection(raw),
});

/** Deterministic ACQUISITION fingerprint. Never participates in any content decision. */
export const acquisitionFingerprint5K5 = raw => body('publicTemporalAcquisition5K5', {
  acquisition: acquisitionProjection(raw),
});

/**
 * The fingerprint contract, as data.
 *
 * `rawObservationFingerprint` is named here ONLY to record that 5K.5 adopts
 * 5K.1's function unchanged. It is re-exported from provenance.mjs, never
 * replaced, never redefined, and never omitted from any derived record.
 */
export const PUBLIC_INTELLIGENCE_5K5_FINGERPRINTING = Object.freeze({
  algorithm: 'SHA-256',
  serialization: 'EVOLVE_CANONICAL_JSON',
  temporalPolicyVersion: PUBLIC_INTELLIGENCE_5K5_TEMPORAL_POLICY_VERSION,
  rawObservationFingerprint: 'REUSED_UNCHANGED_FROM_5K1',
  rawFingerprintReplaced: false,
  rawFingerprintOmittedFromAnyRecord: false,
  rawEvidenceMutable: false,
  derivedFingerprints: Object.freeze(['contentFingerprint', 'observationStateFingerprint', 'acquisitionFingerprint']),
  fetchedAtParticipatesInContent: false,
  observedAtParticipatesInContent: false,
  collectionContextParticipatesInContent: false,
  engagementParticipatesInContent: false,
  engagementParticipatesInState: true,
  rawTextParticipatesInContent: true,
  claimedMintParticipatesInContent: true,
  publishedAtParticipatesInContent: true,
  providerAuthorIdParticipatesInContent: true,
  deduplicationByEngagementSimilarityPermitted: false,
  unknownFieldParticipates: false,
});

/** Re-exported verbatim. 5K.1 owns this; 5K.5 only ever calls it. */
export { rawObservationFingerprint };

/** The upstream identity of a record: exactly (provider, providerObservationId). */
export const upstreamIdentity5K5 = raw => `${raw.provider}:${raw.providerObservationId}`;

/** One derived temporal view over one authenticated raw record. No body is retained. */
export function temporalView5K5(raw, { runId, runManifestFingerprint } = {}) {
  return plain({
    upstreamIdentity: upstreamIdentity5K5(raw),
    provider: raw.provider,
    providerObservationId: raw.providerObservationId,
    rawObservationFingerprint: rawObservationFingerprint(raw),
    contentFingerprint: contentFingerprint5K5(raw),
    observationStateFingerprint: observationStateFingerprint5K5(raw),
    acquisitionFingerprint: acquisitionFingerprint5K5(raw),
    publishedAt: raw.publishedAt ?? null,
    fetchedAt: raw.fetchedAt,
    runId: runId ?? null,
    runManifestFingerprint: runManifestFingerprint ?? null,
    classification: PUBLIC_INTELLIGENCE_CLASSIFICATION,
  });
}
