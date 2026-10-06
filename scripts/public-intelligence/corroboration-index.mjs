// Phase 5K.7 - CROSS-PROVIDER CORROBORATION INDEX (PURE).
//
// PURE AND OFFLINE BY CONSTRUCTION. No filesystem, no socket, no clock, no
// environment, no provider SDK. It reads an already-verified temporal index
// (authenticated 5K.5 content records and observation records) and derives the
// exact-mint coverage layer.
//
// THE RULE THIS MODULE EXISTS TO ENFORCE
//
// A cross-provider subject exists ONLY where an authenticated observation's
// already-verified normalized evidence carries `assetAssociation.status ===
// EXACT_MINT`. Nothing else - not a symbol, ticker, cashtag, hashtag, project
// name, profile, domain, URL, similar text, embedding or fuzzy signal - can
// create a subject or join observations together. UNASSOCIATED, INVALID_MINT and
// AMBIGUOUS evidence remains visible as COVERAGE STATE but can never be promoted
// to an exact subject.
//
// UPSTREAM IDENTITY STAYS PROVIDER-SCOPED. This layer AGGREGATES COVERAGE
// REFERENCES; it never merges evidence. The same text, mint, time and URL on two
// providers remain TWO provider-scoped upstream observations. Nothing here
// deduplicates, reconciles, chooses, weights or ranks.
//
// A NOTE ON THE TWO PROVIDER COUNTS
//
// `providerFamilyCount` counts GOVERNED PLATFORMS (mastodon, bluesky);
// `providerNamespaceCount` counts governed namespace strings
// (`mastodon:<instance>`, `bluesky:public-appview`). Two Mastodon instances
// therefore yield providerNamespaceCount = 2 but providerFamilyCount = 1, and the
// coverage status stays SINGLE_PROVIDER_FAMILY. This is deliberate: two instances
// of one platform are not cross-platform corroboration.
import { PUBLIC_INTELLIGENCE_CLASSIFICATION, canonical, digest } from './definition.mjs';
import { failClosed } from './observation.mjs';
import {
  PUBLIC_INTELLIGENCE_5K7_SCHEMA_VERSION, PUBLIC_INTELLIGENCE_5K7_RECORD_TYPES,
  PUBLIC_INTELLIGENCE_5K7_COVERAGE_STATUS, PUBLIC_INTELLIGENCE_5K7_COVERAGE_STATUS_VALUES,
  PUBLIC_INTELLIGENCE_5K7_PROVIDER_FAMILIES, providerFamilyOf, coverageStatusForFamilyCount,
} from './corroboration-definition.mjs';

export const PUBLIC_INTELLIGENCE_5K7_COVERAGE_RECORD_TYPE = PUBLIC_INTELLIGENCE_5K7_RECORD_TYPES.COVERAGE_RECORD;
export const PUBLIC_INTELLIGENCE_5K7_OBSERVATION_COVERAGE_RECORD_TYPE = 'public_corroboration_observation_coverage';

/** The governed association statuses an upstream identity's head evidence may carry. */
export const PUBLIC_INTELLIGENCE_5K7_ASSOCIATION_STATUSES = Object.freeze(['EXACT_MINT', 'UNASSOCIATED', 'INVALID_MINT', 'AMBIGUOUS']);

/**
 * One structural coverage state per UPSTREAM IDENTITY, derived from the head
 * (earliest) authenticated evidence. It carries REFERENCE IDENTITY ONLY: the
 * upstream identity string, the governed provider namespace, the family, the
 * association status and (only when exact) the exact mint. No post body, no
 * author profile and no credential can appear here.
 */
export const PUBLIC_INTELLIGENCE_5K7_OBSERVATION_COVERAGE_SCHEMA = Object.freeze({
  closed: true,
  fields: Object.freeze([
    'schemaVersion', 'recordType', 'upstreamIdentity', 'providerNamespace', 'providerFamily',
    'associationStatus', 'exactMint', 'classification', 'recordFingerprint',
  ]),
});

/** The closed coverage-record schema. Unknown fields are refused. */
export const PUBLIC_INTELLIGENCE_5K7_COVERAGE_RECORD_SCHEMA = Object.freeze({
  closed: true,
  fields: Object.freeze([
    'schemaVersion', 'recordType', 'mint',
    'providerFamilies', 'providerFamilyCount',
    'providerNamespaces', 'providerNamespaceCount',
    'upstreamObservationIdentities', 'upstreamObservationCount',
    'contentVersionCount', 'observationStateSnapshotCount',
    'firstObservedAt', 'lastObservedAt',
    'memberRunIds', 'sourceSnapshotIds',
    'coverageStatus', 'classification', 'recordFingerprint',
  ]),
});

const FINGERPRINT = /^[0-9a-f]{64}$/;
const plain = value => JSON.parse(canonical(value));
const byKey = key => (a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);
const uniqueSorted = values => [...new Set(values)].sort();
const sortedObject = map => Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

const fingerprintOf = (record, field) => {
  const body = { ...record };
  delete body[field];
  return digest(body);
};

/**
 * Validates one coverage record: closed schema, frozen classification, a
 * governed coverage status, and the count/array identities that must hold.
 * Returns the record; a violation throws a named code.
 */
export function validateCoverageRecord(record) {
  const S = PUBLIC_INTELLIGENCE_5K7_COVERAGE_RECORD_SCHEMA;
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    failClosed('PUBLIC_INTELLIGENCE_5K7_COVERAGE_NOT_AN_OBJECT');
  }
  for (const key of Object.keys(record)) {
    if (!S.fields.includes(key)) failClosed(`PUBLIC_INTELLIGENCE_5K7_COVERAGE_UNKNOWN_FIELD:${String(key).slice(0, 48)}`);
  }
  for (const key of S.fields) {
    if (!Object.hasOwn(record, key)) failClosed(`PUBLIC_INTELLIGENCE_5K7_COVERAGE_FIELD_MISSING:${key}`);
  }
  if (record.schemaVersion !== PUBLIC_INTELLIGENCE_5K7_SCHEMA_VERSION || record.recordType !== PUBLIC_INTELLIGENCE_5K7_COVERAGE_RECORD_TYPE) {
    failClosed('PUBLIC_INTELLIGENCE_5K7_COVERAGE_TYPE_INVALID');
  }
  if (typeof record.mint !== 'string' || !record.mint) failClosed('PUBLIC_INTELLIGENCE_5K7_COVERAGE_MINT_INVALID');
  if (!Array.isArray(record.providerFamilies) || !Array.isArray(record.providerNamespaces)) {
    failClosed('PUBLIC_INTELLIGENCE_5K7_COVERAGE_PROVIDER_LISTS_INVALID');
  }
  if (!Array.isArray(record.upstreamObservationIdentities) || !Array.isArray(record.memberRunIds) || !Array.isArray(record.sourceSnapshotIds)) {
    failClosed('PUBLIC_INTELLIGENCE_5K7_COVERAGE_REFERENCE_LISTS_INVALID');
  }
  if (!PUBLIC_INTELLIGENCE_5K7_COVERAGE_STATUS_VALUES.includes(record.coverageStatus)) {
    failClosed('PUBLIC_INTELLIGENCE_5K7_COVERAGE_STATUS_INVALID');
  }
  if (record.providerFamilyCount !== record.providerFamilies.length) failClosed('PUBLIC_INTELLIGENCE_5K7_COVERAGE_FAMILY_COUNT_MISMATCH');
  if (record.providerNamespaceCount !== record.providerNamespaces.length) failClosed('PUBLIC_INTELLIGENCE_5K7_COVERAGE_NAMESPACE_COUNT_MISMATCH');
  if (record.upstreamObservationCount !== record.upstreamObservationIdentities.length) failClosed('PUBLIC_INTELLIGENCE_5K7_COVERAGE_OBSERVATION_COUNT_MISMATCH');
  // Every namespace must belong to exactly one governed family, and the family
  // list must be the exact projection of the namespace list.
  const familiesFromNamespaces = uniqueSorted(record.providerNamespaces.map(providerFamilyOf));
  if (canonical(familiesFromNamespaces) !== canonical(record.providerFamilies)) {
    failClosed('PUBLIC_INTELLIGENCE_5K7_COVERAGE_FAMILY_LIST_DRIFT');
  }
  if (record.providerFamilyCount < 1 || record.providerNamespaceCount < record.providerFamilyCount) {
    failClosed('PUBLIC_INTELLIGENCE_5K7_COVERAGE_PROVIDER_COUNT_INVALID');
  }
  if (record.coverageStatus !== coverageStatusForFamilyCount(record.providerFamilyCount)) {
    failClosed('PUBLIC_INTELLIGENCE_5K7_COVERAGE_STATUS_NE_FAMILY_COUNT');
  }
  if (record.upstreamObservationCount < 1) failClosed('PUBLIC_INTELLIGENCE_5K7_COVERAGE_NO_UPSTREAM_OBSERVATION');
  for (const key of ['contentVersionCount', 'observationStateSnapshotCount']) {
    if (!Number.isSafeInteger(record[key]) || record[key] < 1) failClosed(`PUBLIC_INTELLIGENCE_5K7_COVERAGE_COUNT_INVALID:${key}`);
  }
  for (const key of ['firstObservedAt', 'lastObservedAt']) {
    if (!Number.isSafeInteger(record[key]) || record[key] < 0) failClosed(`PUBLIC_INTELLIGENCE_5K7_COVERAGE_TIMESTAMP_INVALID:${key}`);
  }
  if (record.firstObservedAt > record.lastObservedAt) failClosed('PUBLIC_INTELLIGENCE_5K7_COVERAGE_TIME_INVERTED');
  if (canonical(record.classification) !== canonical(PUBLIC_INTELLIGENCE_CLASSIFICATION)) {
    failClosed('PUBLIC_INTELLIGENCE_5K7_COVERAGE_CLASSIFICATION_OVERRIDE_REFUSED');
  }
  if (record.recordFingerprint !== fingerprintOf(record, 'recordFingerprint')) {
    failClosed('PUBLIC_INTELLIGENCE_5K7_COVERAGE_FINGERPRINT_MISMATCH');
  }
  return record;
}

/**
 * Builds one structural observation-coverage record per upstream identity, from
 * the identity's head (earliest) association. Deterministic and sorted.
 *
 * An identity MAY separately appear in an exact-mint coverage record when a
 * LATER authenticated version introduced an exact mint; the head state remains
 * the identity's earliest observed association and is reported as such rather
 * than reconciled away.
 */
export function buildObservationCoverageRecords(contentRecords = []) {
  const records = [];
  for (const content of contentRecords) {
    const identity = content?.upstreamIdentity;
    if (typeof identity !== 'string' || !identity) failClosed('PUBLIC_INTELLIGENCE_5K7_OBS_COVERAGE_IDENTITY_MISSING');
    const namespace = content?.provider;
    const family = providerFamilyOf(namespace);
    const association = content?.assetAssociation ?? {};
    const status = association.status;
    if (!PUBLIC_INTELLIGENCE_5K7_ASSOCIATION_STATUSES.includes(status)) {
      failClosed(`PUBLIC_INTELLIGENCE_5K7_OBS_COVERAGE_STATUS_INVALID:${String(status).slice(0, 40)}`);
    }
    const exactMint = status === 'EXACT_MINT' ? association.mint ?? null : null;
    if (status === 'EXACT_MINT' && (typeof exactMint !== 'string' || !exactMint)) {
      failClosed('PUBLIC_INTELLIGENCE_5K7_OBS_COVERAGE_EXACT_WITHOUT_MINT');
    }
    if (status !== 'EXACT_MINT' && exactMint !== null) failClosed('PUBLIC_INTELLIGENCE_5K7_OBS_COVERAGE_NON_EXACT_WITH_MINT');
    const body = {
      schemaVersion: PUBLIC_INTELLIGENCE_5K7_SCHEMA_VERSION,
      recordType: PUBLIC_INTELLIGENCE_5K7_OBSERVATION_COVERAGE_RECORD_TYPE,
      upstreamIdentity: identity,
      providerNamespace: namespace,
      providerFamily: family,
      associationStatus: status,
      exactMint,
      classification: PUBLIC_INTELLIGENCE_CLASSIFICATION,
    };
    records.push(plain({ ...body, recordFingerprint: digest(body) }));
  }
  records.sort(byKey('upstreamIdentity'));
  return Object.freeze(records);
}

/** Closed-schema + fingerprint validation of one observation-coverage record. */
export function validateObservationCoverageRecord(record) {
  const S = PUBLIC_INTELLIGENCE_5K7_OBSERVATION_COVERAGE_SCHEMA;
  if (!record || typeof record !== 'object' || Array.isArray(record)) failClosed('PUBLIC_INTELLIGENCE_5K7_OBS_COVERAGE_NOT_AN_OBJECT');
  for (const key of Object.keys(record)) {
    if (!S.fields.includes(key)) failClosed(`PUBLIC_INTELLIGENCE_5K7_OBS_COVERAGE_UNKNOWN_FIELD:${String(key).slice(0, 48)}`);
  }
  for (const key of S.fields) if (!Object.hasOwn(record, key)) failClosed(`PUBLIC_INTELLIGENCE_5K7_OBS_COVERAGE_FIELD_MISSING:${key}`);
  if (record.schemaVersion !== PUBLIC_INTELLIGENCE_5K7_SCHEMA_VERSION || record.recordType !== PUBLIC_INTELLIGENCE_5K7_OBSERVATION_COVERAGE_RECORD_TYPE) {
    failClosed('PUBLIC_INTELLIGENCE_5K7_OBS_COVERAGE_TYPE_INVALID');
  }
  if (typeof record.upstreamIdentity !== 'string' || !record.upstreamIdentity) failClosed('PUBLIC_INTELLIGENCE_5K7_OBS_COVERAGE_IDENTITY_MISSING');
  if (providerFamilyOf(record.providerNamespace) !== record.providerFamily) failClosed('PUBLIC_INTELLIGENCE_5K7_OBS_COVERAGE_FAMILY_DRIFT');
  if (!PUBLIC_INTELLIGENCE_5K7_ASSOCIATION_STATUSES.includes(record.associationStatus)) failClosed('PUBLIC_INTELLIGENCE_5K7_OBS_COVERAGE_STATUS_INVALID');
  if (record.associationStatus === 'EXACT_MINT') {
    if (typeof record.exactMint !== 'string' || !record.exactMint) failClosed('PUBLIC_INTELLIGENCE_5K7_OBS_COVERAGE_EXACT_WITHOUT_MINT');
  } else if (record.exactMint !== null) failClosed('PUBLIC_INTELLIGENCE_5K7_OBS_COVERAGE_NON_EXACT_WITH_MINT');
  if (canonical(record.classification) !== canonical(PUBLIC_INTELLIGENCE_CLASSIFICATION)) failClosed('PUBLIC_INTELLIGENCE_5K7_OBS_COVERAGE_CLASSIFICATION_OVERRIDE_REFUSED');
  if (record.recordFingerprint !== fingerprintOf(record, 'recordFingerprint')) failClosed('PUBLIC_INTELLIGENCE_5K7_OBS_COVERAGE_FINGERPRINT_MISMATCH');
  return record;
}

/**
 * Builds the corroboration index from a VERIFIED temporal index.
 *
 * Inputs:
 *   contentRecords     - 5K.5 canonical content records (one per upstream identity)
 *   observationRecords - 5K.5 observation records (one per authenticated acquisition)
 *   sourceSnapshotIds  - the authenticated source snapshot identities this index
 *                        is derived from (sorted, de-duplicated here)
 *
 * A content record's `assetAssociation` is the identity's HEAD (earliest)
 * association; it is used ONLY to partition identities for the missingness
 * counters. Every coverage record is built from the per-acquisition observation
 * records, so no version's evidence is discarded.
 */
export function buildCorroborationIndex({ contentRecords = [], observationRecords = [] } = {}, { sourceSnapshotIds = [] } = {}) {
  if (!Array.isArray(contentRecords) || !Array.isArray(observationRecords)) {
    failClosed('PUBLIC_INTELLIGENCE_5K7_INDEX_INPUT_INVALID');
  }
  const snapshots = uniqueSorted(sourceSnapshotIds);
  for (const id of snapshots) {
    if (typeof id !== 'string' || !id) failClosed('PUBLIC_INTELLIGENCE_5K7_INDEX_SOURCE_SNAPSHOT_INVALID');
  }

  const groups = new Map();
  for (const record of observationRecords) {
    const association = record?.assetAssociation;
    if (association?.status !== 'EXACT_MINT') continue;
    const mint = association.mint;
    if (typeof mint !== 'string' || !mint) failClosed('PUBLIC_INTELLIGENCE_5K7_INDEX_EXACT_MINT_WITHOUT_MINT');
    if (typeof record.provider !== 'string' || !record.provider) failClosed('PUBLIC_INTELLIGENCE_5K7_INDEX_OBSERVATION_PROVIDER_MISSING');
    // Fail closed on a namespace 5K.7 does not govern, rather than guessing.
    const family = providerFamilyOf(record.provider);
    const identity = record.upstreamIdentity;
    if (typeof identity !== 'string' || !identity) failClosed('PUBLIC_INTELLIGENCE_5K7_INDEX_OBSERVATION_IDENTITY_MISSING');
    if (!Number.isSafeInteger(record.fetchedAt) || record.fetchedAt < 0) failClosed('PUBLIC_INTELLIGENCE_5K7_INDEX_OBSERVATION_FETCHED_AT_INVALID');
    for (const key of ['contentFingerprint', 'observationStateFingerprint']) {
      if (!FINGERPRINT.test(String(record[key]))) failClosed(`PUBLIC_INTELLIGENCE_5K7_INDEX_OBSERVATION_${key.toUpperCase()}_INVALID`);
    }
    if (!groups.has(mint)) groups.set(mint, []);
    groups.get(mint).push({
      provider: record.provider,
      family,
      identity,
      contentFingerprint: record.contentFingerprint,
      observationStateFingerprint: record.observationStateFingerprint,
      fetchedAt: record.fetchedAt,
      runId: record.runId ?? null,
    });
  }

  const coverageRecords = [];
  for (const mint of [...groups.keys()].sort()) {
    const contributions = groups.get(mint);
    const providerNamespaces = uniqueSorted(contributions.map(c => c.provider));
    const providerFamilies = uniqueSorted(contributions.map(c => c.family));
    const upstreamObservationIdentities = uniqueSorted(contributions.map(c => c.identity));
    const contentVersions = new Set(contributions.map(c => `${c.identity}\u0000${c.contentFingerprint}`));
    const stateSnapshots = new Set(contributions.map(c => c.observationStateFingerprint));
    const memberRunIds = uniqueSorted(contributions.map(c => c.runId).filter(id => typeof id === 'string' && id));
    const observed = contributions.map(c => c.fetchedAt);
    const providerFamilyCount = providerFamilies.length;
    const providerNamespaceCount = providerNamespaces.length;
    const body = {
      schemaVersion: PUBLIC_INTELLIGENCE_5K7_SCHEMA_VERSION,
      recordType: PUBLIC_INTELLIGENCE_5K7_COVERAGE_RECORD_TYPE,
      mint,
      providerFamilies,
      providerFamilyCount,
      providerNamespaces,
      providerNamespaceCount,
      upstreamObservationIdentities,
      upstreamObservationCount: upstreamObservationIdentities.length,
      contentVersionCount: contentVersions.size,
      observationStateSnapshotCount: stateSnapshots.size,
      firstObservedAt: Math.min(...observed),
      lastObservedAt: Math.max(...observed),
      memberRunIds,
      sourceSnapshotIds: snapshots,
      coverageStatus: coverageStatusForFamilyCount(providerFamilyCount),
      classification: PUBLIC_INTELLIGENCE_CLASSIFICATION,
    };
    const record = plain({ ...body, recordFingerprint: digest(body) });
    validateCoverageRecord(record);
    coverageRecords.push(record);
  }
  coverageRecords.sort(byKey('mint'));

  const observationCoverageRecords = buildObservationCoverageRecords(contentRecords);
  const aggregate = computeCorroborationAggregate({ observationCoverageRecords, coverageRecords });
  return Object.freeze({
    coverageRecords: Object.freeze(coverageRecords),
    observationCoverageRecords,
    aggregate,
  });
}

/**
 * Coverage accounting.
 *
 * These numbers describe WHAT WAS COLLECTED and how evidence relates across
 * providers. They are NOT popularity, importance, sentiment, strength or market
 * relevance, and no consumer may read them as such.
 *
 * The missingness counters partition UPSTREAM IDENTITIES by the association of
 * their head (earliest) authenticated evidence, so an identity is counted
 * exactly once. An identity MAY separately appear in an exact-mint coverage
 * record if a LATER authenticated version introduced an exact mint; that is
 * reported honestly rather than reconciled away.
 */
export function computeCorroborationAggregate({ observationCoverageRecords = [], coverageRecords = [] } = {}) {
  const headCounts = { EXACT_MINT: 0, UNASSOCIATED: 0, INVALID_MINT: 0, AMBIGUOUS: 0 };
  for (const record of observationCoverageRecords) {
    const status = record?.associationStatus;
    if (Object.hasOwn(headCounts, status)) headCounts[status] += 1;
  }
  const providerFamilyCounts = {};
  const providerNamespaceCounts = {};
  for (const record of coverageRecords) {
    for (const family of record.providerFamilies) providerFamilyCounts[family] = (providerFamilyCounts[family] ?? 0) + 1;
    for (const namespace of record.providerNamespaces) providerNamespaceCounts[namespace] = (providerNamespaceCounts[namespace] ?? 0) + 1;
  }
  let earliest = null;
  let latest = null;
  for (const record of coverageRecords) {
    earliest = earliest === null ? record.firstObservedAt : Math.min(earliest, record.firstObservedAt);
    latest = latest === null ? record.lastObservedAt : Math.max(latest, record.lastObservedAt);
  }
  const single = coverageRecords.filter(record => record.coverageStatus === PUBLIC_INTELLIGENCE_5K7_COVERAGE_STATUS.SINGLE_PROVIDER_FAMILY).length;
  const multi = coverageRecords.filter(record => record.coverageStatus === PUBLIC_INTELLIGENCE_5K7_COVERAGE_STATUS.MULTI_PROVIDER_FAMILY).length;
  return plain({
    upstreamIdentityCount: observationCoverageRecords.length,
    exactMintCount: coverageRecords.length,
    singleProviderFamilyMintCount: single,
    multiProviderFamilyMintCount: multi,
    providerFamilyCounts: sortedObject(providerFamilyCounts),
    providerNamespaceCounts: sortedObject(providerNamespaceCounts),
    exactMintObservationCount: headCounts.EXACT_MINT,
    unassociatedObservationCount: headCounts.UNASSOCIATED,
    invalidMintObservationCount: headCounts.INVALID_MINT,
    ambiguousObservationCount: headCounts.AMBIGUOUS,
    earliestObservedAt: earliest,
    latestObservedAt: latest,
  });
}

/**
 * The accounting equations. Every one is an identity over the derived records,
 * so any drift between the records and the summary is a hard failure rather
 * than a silently reconciled number.
 */
export function checkCorroborationAggregate(aggregate, { observationCoverageRecords = [], coverageRecords = [] } = {}) {
  const problems = [];
  const check = (condition, code) => { if (!condition) problems.push(code); };
  const A = aggregate;
  check(A.upstreamIdentityCount === observationCoverageRecords.length, 'AGGREGATE_UPSTREAM_IDENTITY_DRIFT');
  check(A.exactMintCount === coverageRecords.length, 'AGGREGATE_EXACT_MINT_DRIFT');
  check(A.singleProviderFamilyMintCount + A.multiProviderFamilyMintCount === A.exactMintCount, 'AGGREGATE_STATUS_PARTITION');
  check(A.exactMintObservationCount + A.unassociatedObservationCount + A.invalidMintObservationCount
    + A.ambiguousObservationCount === A.upstreamIdentityCount, 'AGGREGATE_MISSINGNESS_PARTITION');
  check(Object.keys(A.providerFamilyCounts).every(family => PUBLIC_INTELLIGENCE_5K7_PROVIDER_FAMILIES.includes(family)),
    'AGGREGATE_UNKNOWN_PROVIDER_FAMILY');
  for (const record of coverageRecords) {
    if (record.coverageStatus === PUBLIC_INTELLIGENCE_5K7_COVERAGE_STATUS.MULTI_PROVIDER_FAMILY && record.providerFamilyCount < 2) {
      problems.push('AGGREGATE_MULTI_WITHOUT_TWO_FAMILIES');
    }
    if (record.coverageStatus === PUBLIC_INTELLIGENCE_5K7_COVERAGE_STATUS.SINGLE_PROVIDER_FAMILY && record.providerFamilyCount !== 1) {
      problems.push('AGGREGATE_SINGLE_WITHOUT_ONE_FAMILY');
    }
  }
  return Object.freeze({ ok: problems.length === 0, problems: Object.freeze(problems) });
}

/**
 * The coverage-gap view. This reports WHERE EXACT-MINT EVIDENCE IS ABSENT and
 * interprets none of it: absence from one provider is never treated as evidence
 * of absence. Every interpretation flag is reported false.
 */
export function computeCoverageGaps({ coverageRecords = [], aggregate = null } = {}) {
  const A = aggregate ?? computeCorroborationAggregate({ coverageRecords });
  const familiesWithEvidence = uniqueSorted(coverageRecords.flatMap(record => record.providerFamilies));
  const familiesWithoutEvidence = PUBLIC_INTELLIGENCE_5K7_PROVIDER_FAMILIES.filter(family => !familiesWithEvidence.includes(family));
  const mintsMissingFamily = family => coverageRecords
    .filter(record => !record.providerFamilies.includes(family))
    .map(record => record.mint)
    .sort();
  return plain({
    governedProviderFamilies: [...PUBLIC_INTELLIGENCE_5K7_PROVIDER_FAMILIES],
    providerFamiliesWithExactMintEvidence: familiesWithEvidence,
    providerFamiliesWithoutExactMintEvidence: familiesWithoutEvidence,
    mintsWithoutMastodonEvidence: mintsMissingFamily('mastodon'),
    mintsWithoutBlueskyEvidence: mintsMissingFamily('bluesky'),
    unassociatedObservationCount: A.unassociatedObservationCount,
    invalidMintObservationCount: A.invalidMintObservationCount,
    ambiguousObservationCount: A.ambiguousObservationCount,
    absenceImpliesAbsence: false,
    gapInterpreted: false,
    gapScored: false,
  });
}
