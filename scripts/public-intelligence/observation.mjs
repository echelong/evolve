// Phase 5K.1 - RAW PUBLIC OBSERVATION: closed schema + immutable canonicalization.
//
// This module is OFFLINE BY CONSTRUCTION. It opens no socket, imports no
// provider SDK, reads no credential, reads no environment variable, starts no
// process and writes no file. It only describes, validates and freezes the raw
// public evidence that a *future* provider adapter (5K.2+) would hand it.
//
// POST-R4 BY CONSTRUCTION and RESEARCH/OBSERVER-ONLY BY CONSTRUCTION, exactly
// as frozen by Phase 5K.0. Nothing here imports the engine, Arena, promotion,
// wallet, signer or any R4 module.
//
// CORE RULE: raw evidence is preserved character-for-character. Normalization
// READS raw evidence and never writes back to it. A rawText byte that came in
// is the rawText byte that stays.
import {
  PUBLIC_INTELLIGENCE_CLASSIFICATION, PUBLIC_INTELLIGENCE_SCHEMA_VERSION,
  PUBLIC_INTELLIGENCE_RECORD_TYPES, PUBLIC_INTELLIGENCE_MISSINGNESS,
  PUBLIC_INTELLIGENCE_REJECTED_ASSOCIATION_METHODS, PUBLIC_INTELLIGENCE_ENGAGEMENT,
  assertClosedSchema, assertObserverOnlyClassification, assertTimestamp,
  isValidTimestamp, canonicalMintAddress,
} from './definition.mjs';

/** 5K.1 extends 5K.0's schema version without forking it. */
export const PUBLIC_INTELLIGENCE_5K1_PHASE = 'PHASE_5K_1';

/** Fails closed. Every refusal in this module is a thrown code, never a default. */
export const failClosed = code => { throw new Error(code); };

// ---------------------------------------------------------------------------
// 1. CLOSED RAW OBSERVATION SCHEMA
// ---------------------------------------------------------------------------

/**
 * The 5K.1 raw observation record. Closed schema: unknown fields are refused so
 * an upstream rename can never silently change a research number.
 *
 * `rawText` is stored verbatim. `rawMetadata` is stored as received and is
 * deep-frozen at the canonicalization boundary, so it is immutable from the
 * moment of ingestion onward.
 */
export const PUBLIC_INTELLIGENCE_5K1_RAW_SCHEMA = Object.freeze({
  schemaVersion: PUBLIC_INTELLIGENCE_SCHEMA_VERSION,
  recordType: PUBLIC_INTELLIGENCE_RECORD_TYPES.RAW_SOCIAL_OBSERVATION,
  closed: true,
  fields: Object.freeze([
    'schemaVersion',
    'recordType',
    'provider',
    'providerObservationId',
    'providerAuthorId',
    'sourceType',
    'sourceUrl',
    'publishedAt',
    'observedAt',
    'fetchedAt',
    'rawText',
    'rawMetadata',
    'claimedMint',
    'collectionContext',
    'classification',
  ]),
  // Optional means "may be explicitly null", never "may be absent" and never
  // "may be defaulted". Missingness stays explicit.
  optionalFields: Object.freeze([
    'providerAuthorId', 'sourceUrl', 'publishedAt', 'observedAt', 'claimedMint',
  ]),
  // Fields that would breach the public-only privacy boundary. Naming one is a
  // hard refusal, at any depth, in the record or inside rawMetadata.
  forbiddenFields: Object.freeze([
    'email', 'emailAddress', 'phone', 'phoneNumber', 'mobileNumber',
    'privateMessage', 'directMessage', 'groupMessage', 'dmContent',
    'sessionCookie', 'cookie', 'cookies', 'accessToken', 'refreshToken',
    'bearerToken', 'apiKey', 'apiSecret', 'clientSecret', 'password',
    'privateKey', 'secretKey', 'mnemonic', 'seedPhrase', 'credential',
    'authorization', 'authHeader', 'browserSession', 'deviceFingerprint',
    'ipAddress', 'realName', 'legalName', 'homeAddress', 'geoLocation',
    'birthDate', 'deviceId', 'profileImageUrl', 'followerList', 'followingList',
    'contactList', 'contactDiscovery', 'locationHistory', 'ipHistory',
    'subscriberCount', 'mutualConnections',
  ]),
});

/** Where a public observation came from. Provider-shaped but provider-neutral. */
export const PUBLIC_INTELLIGENCE_5K1_SOURCE_TYPES = Object.freeze([
  'POST', 'REPLY', 'THREAD_ITEM', 'PROFILE_BIO',
]);

/**
 * 5K.1 has no live provider. `collectorMode` is pinned so that a live adapter
 * cannot be smuggled in behind an unchanged schema version.
 */
export const PUBLIC_INTELLIGENCE_5K1_COLLECTOR_MODES = Object.freeze(['OFFLINE_FIXTURE']);

/**
 * Phase 5K.2 adds exactly one additional mode, declared separately so the 5K.1
 * constant above stays byte-for-byte what 5K.1 froze. It labels evidence that a
 * bounded, read-only, public-data transport acquired. Any other value (for
 * example `LIVE_API`) is still refused.
 */
export const PUBLIC_INTELLIGENCE_5K2_LIVE_COLLECTOR_MODES = Object.freeze(['LIVE_PUBLIC_PROVIDER']);
const ALLOWED_COLLECTOR_MODES = Object.freeze([
  ...PUBLIC_INTELLIGENCE_5K1_COLLECTOR_MODES,
  ...PUBLIC_INTELLIGENCE_5K2_LIVE_COLLECTOR_MODES,
]);

/** Collection provenance, carried with the evidence, closed schema. */
export const PUBLIC_INTELLIGENCE_5K1_COLLECTION_CONTEXT_SCHEMA = Object.freeze({
  closed: true,
  fields: Object.freeze(['collectionRunId', 'adapterName', 'adapterVersion', 'collectorMode']),
});

/**
 * Provider-supplied metadata is ALSO closed, at the top level and inside
 * `engagement`. Provider isolation is structural, not advisory.
 */
export const PUBLIC_INTELLIGENCE_5K1_RAW_METADATA_SCHEMA = Object.freeze({
  closed: true,
  fields: Object.freeze([
    'language',
    'engagement',
    'cashtags',
    'hashtags',
    'mentionedHandles',
    'claimedSymbol',
    'claimedTokenName',
    'candidateMintAddresses',
    'similaritySignals',
    'fixtureNote',
  ]),
  optionalFields: Object.freeze([
    'language', 'engagement', 'cashtags', 'hashtags', 'mentionedHandles',
    'claimedSymbol', 'claimedTokenName', 'candidateMintAddresses',
    'similaritySignals', 'fixtureNote',
  ]),
  engagementFields: Object.freeze([
    'likes', 'replies', 'reposts', 'quotes', 'views', 'bookmarks',
  ]),
});

/**
 * Non-canonical identity signals that can appear in evidence and are therefore
 * refused as identity. Listing them makes the refusal auditable, not implicit.
 */
export const PUBLIC_INTELLIGENCE_5K1_REJECTED_IDENTITY_SIGNALS = Object.freeze([
  ...PUBLIC_INTELLIGENCE_REJECTED_ASSOCIATION_METHODS,
]);

export const PUBLIC_INTELLIGENCE_5K1_MISSINGNESS = PUBLIC_INTELLIGENCE_MISSINGNESS;
export const PUBLIC_INTELLIGENCE_5K1_ENGAGEMENT = PUBLIC_INTELLIGENCE_ENGAGEMENT;
export const PUBLIC_INTELLIGENCE_5K1_CLASSIFICATION = PUBLIC_INTELLIGENCE_CLASSIFICATION;

// ---------------------------------------------------------------------------
// 2. IMMUTABLE CANONICALIZATION
// ---------------------------------------------------------------------------

const FORBIDDEN_FIELD_SET = new Set(PUBLIC_INTELLIGENCE_5K1_RAW_SCHEMA.forbiddenFields);

/**
 * Deep-canonicalizes one JSON value into an immutable, finite, JSON-safe clone.
 * Rejects undefined, NaN, Infinity, functions, symbols and forbidden keys at
 * ANY depth. Nothing is coerced: a value that is not representable is refused.
 */
function canonicalizeValue(value, pointer) {
  if (value === null) return null;
  const kind = typeof value;
  if (kind === 'string' || kind === 'boolean') return value;
  if (kind === 'number') {
    if (!Number.isFinite(value)) failClosed(`PUBLIC_INTELLIGENCE_5K1_NON_FINITE_NUMBER:${pointer}`);
    return value;
  }
  if (kind === 'undefined') failClosed(`PUBLIC_INTELLIGENCE_5K1_UNDEFINED_VALUE:${pointer}`);
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry, index) => canonicalizeValue(entry, `${pointer}[${index}]`)));
  }
  if (kind === 'object') {
    const cloned = {};
    // Sorted keys give a stable enumeration order independent of provider shape.
    for (const key of Object.keys(value).sort()) {
      if (FORBIDDEN_FIELD_SET.has(key)) {
        failClosed(`PUBLIC_INTELLIGENCE_5K1_FORBIDDEN_FIELD_PRESENT:${key}`);
      }
      cloned[key] = canonicalizeValue(value[key], `${pointer}.${key}`);
    }
    return Object.freeze(cloned);
  }
  return failClosed(`PUBLIC_INTELLIGENCE_5K1_UNSUPPORTED_VALUE_TYPE:${kind}`);
}

const cloneFrozen = (value, pointer) => canonicalizeValue(value, pointer);

/** Asserts `object` against a closed field list, refusing unknown fields. */
function assertClosedFields(object, fields, code, pointer) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) {
    failClosed(`${code}:${pointer}`);
  }
  const allowed = new Set(fields);
  for (const key of Object.keys(object)) {
    if (FORBIDDEN_FIELD_SET.has(key)) failClosed(`PUBLIC_INTELLIGENCE_5K1_FORBIDDEN_FIELD_PRESENT:${key}`);
    if (!allowed.has(key)) failClosed(`${code}_UNKNOWN_FIELD:${pointer}.${key}`);
  }
}

/**
 * Engagement is provider-supplied or absent. Absent stays absent: it never
 * becomes 0. A provider-supplied 0 is OBSERVED, not missing.
 */
function validateEngagement(engagement) {
  if (engagement === undefined || engagement === null) return true;
  assertClosedFields(engagement, PUBLIC_INTELLIGENCE_5K1_RAW_METADATA_SCHEMA.engagementFields,
    'PUBLIC_INTELLIGENCE_5K1_ENGAGEMENT', 'engagement');
  for (const key of PUBLIC_INTELLIGENCE_5K1_RAW_METADATA_SCHEMA.engagementFields) {
    const value = engagement[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      failClosed(`PUBLIC_INTELLIGENCE_5K1_ENGAGEMENT_NOT_INTEGER:${key}`);
    }
    if (value < 0) failClosed(`PUBLIC_INTELLIGENCE_5K1_ENGAGEMENT_NEGATIVE:${key}`);
  }
  return true;
}

/**
 * Validates a raw public observation. Every failure throws a code; none of them
 * substitutes a value. In particular a missing publishedAt stays missing and is
 * never replaced by fetchedAt.
 */
export function validateRawObservation5K1(raw) {
  // 5K.0's closed-schema guard is reused verbatim, then hardened below.
  assertClosedSchema(raw, PUBLIC_INTELLIGENCE_5K1_RAW_SCHEMA);
  assertObserverOnlyClassification(raw.classification);

  if (raw.schemaVersion !== PUBLIC_INTELLIGENCE_SCHEMA_VERSION) {
    failClosed('PUBLIC_INTELLIGENCE_SCHEMA_VERSION_INVALID');
  }
  if (raw.recordType !== PUBLIC_INTELLIGENCE_RECORD_TYPES.RAW_SOCIAL_OBSERVATION) {
    failClosed('PUBLIC_INTELLIGENCE_RECORD_TYPE_INVALID');
  }
  if (typeof raw.provider !== 'string' || !raw.provider.trim()) {
    failClosed('PUBLIC_INTELLIGENCE_PROVIDER_REQUIRED');
  }
  if (typeof raw.providerObservationId !== 'string' || !raw.providerObservationId.trim()) {
    failClosed('PUBLIC_INTELLIGENCE_5K1_PROVIDER_OBSERVATION_ID_REQUIRED');
  }
  if (!PUBLIC_INTELLIGENCE_5K1_SOURCE_TYPES.includes(raw.sourceType)) {
    failClosed(`PUBLIC_INTELLIGENCE_5K1_SOURCE_TYPE_INVALID:${String(raw.sourceType)}`);
  }

  // Three distinct clocks. Reused from 5K.0 so the discipline is identical.
  assertTimestamp(raw.publishedAt, 'publishedAt', { optional: true });
  assertTimestamp(raw.observedAt, 'observedAt', { optional: true });
  assertTimestamp(raw.fetchedAt, 'fetchedAt');

  // EVOLVE cannot fetch what it had not yet observed. Hard ordering rule.
  if (isValidTimestamp(raw.observedAt) && raw.fetchedAt < raw.observedAt) {
    failClosed('PUBLIC_INTELLIGENCE_5K1_TIMESTAMP_FETCH_BEFORE_OBSERVED');
  }

  // rawText is preserved exactly: any string, including whitespace and
  // newlines, is valid evidence. It is never trimmed, folded or rewritten.
  if (typeof raw.rawText !== 'string') {
    failClosed('PUBLIC_INTELLIGENCE_5K1_RAW_TEXT_NOT_A_STRING');
  }

  if (raw.claimedMint !== null && typeof raw.claimedMint !== 'string') {
    failClosed('PUBLIC_INTELLIGENCE_5K1_CLAIMED_MINT_INVALID_TYPE');
  }
  if (raw.providerAuthorId !== null && typeof raw.providerAuthorId !== 'string') {
    failClosed('PUBLIC_INTELLIGENCE_5K1_AUTHOR_ID_INVALID_TYPE');
  }
  if (raw.sourceUrl !== null && typeof raw.sourceUrl !== 'string') {
    failClosed('PUBLIC_INTELLIGENCE_5K1_SOURCE_URL_INVALID_TYPE');
  }

  assertClosedFields(raw.rawMetadata, PUBLIC_INTELLIGENCE_5K1_RAW_METADATA_SCHEMA.fields,
    'PUBLIC_INTELLIGENCE_5K1_RAW_METADATA', 'rawMetadata');
  validateEngagement(raw.rawMetadata.engagement);

  assertClosedFields(raw.collectionContext, PUBLIC_INTELLIGENCE_5K1_COLLECTION_CONTEXT_SCHEMA.fields,
    'PUBLIC_INTELLIGENCE_5K1_COLLECTION_CONTEXT', 'collectionContext');
  if (typeof raw.collectionContext.collectionRunId !== 'string' || !raw.collectionContext.collectionRunId.trim()) {
    failClosed('PUBLIC_INTELLIGENCE_5K1_COLLECTION_RUN_ID_REQUIRED');
  }
  if (typeof raw.collectionContext.adapterName !== 'string' || !raw.collectionContext.adapterName.trim()) {
    failClosed('PUBLIC_INTELLIGENCE_5K1_ADAPTER_NAME_REQUIRED');
  }
  if (typeof raw.collectionContext.adapterVersion !== 'string' || !raw.collectionContext.adapterVersion.trim()) {
    failClosed('PUBLIC_INTELLIGENCE_5K1_ADAPTER_VERSION_REQUIRED');
  }
  if (!ALLOWED_COLLECTOR_MODES.includes(raw.collectionContext.collectorMode)) {
    failClosed(`PUBLIC_INTELLIGENCE_5K1_COLLECTOR_MODE_INVALID:${String(raw.collectionContext.collectorMode)}`);
  }
  return true;
}

/**
 * Canonicalizes raw evidence WITHOUT altering it.
 *
 * The returned record is a NEW, deep-frozen object. The caller's object is not
 * mutated and is not retained. The only thing that changes between input and
 * output is key enumeration order and immutability, never a value.
 */
export function canonicalizeRawObservation(input) {
  validateRawObservation5K1(input);
  const canonicalRecord = {};
  for (const key of PUBLIC_INTELLIGENCE_5K1_RAW_SCHEMA.fields) {
    canonicalRecord[key] = cloneFrozen(input[key], key);
  }
  return Object.freeze(canonicalRecord);
}

/** Deep structural equality used to prove normalization never wrote back. */
export function rawEvidenceEquals(a, b) {
  if (a === b) return true;
  const encode = value => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(encode).join(',')}]`;
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${encode(value[k])}`).join(',')}}`;
  };
  return encode(a) === encode(b);
}

/** The exact claim an observation makes, for provenance and for validator use. */
export function claimedMintOf(raw) {
  return typeof raw?.claimedMint === 'string' ? raw.claimedMint : null;
}

/**
 * Exact-mint validation of an EXPLICITLY claimed mint. Solana addresses are
 * base58 and case-sensitive, so a differently-cased string is a different
 * identity, never a match. Returns the exact canonical string or null.
 */
export function exactClaimedMint(raw) {
  return canonicalMintAddress(claimedMintOf(raw));
}
