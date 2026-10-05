// Phase 5K.4 - CROSS-RUN OBSERVATION INDEX, CONFLICTS, COVERAGE.
//
// PURE. Takes already AUTHENTICATED runs and produces the derived research index.
// No filesystem, no network, no clock: every timestamp it emits is copied from an
// authenticated source record, so reconstruction cannot invent one.
//
// UPSTREAM IDENTITY is the unchanged 5K.1 identity (provider, providerObservationId)
// and nothing else: never text, URL, mint, timestamp, author or a text hash.
//
// EVIDENCE CONTENT FINGERPRINT. Raw fingerprints can never match across runs,
// because every raw record embeds its own acquisition context (`fetchedAt` and
// `collectionContext.collectionRunId`). Two runs fetching the same unchanged post
// therefore differ in exactly those fields and no others. Cross-run "identical
// evidence" is defined as: identical after removing ONLY the acquisition context.
// Text, metadata (including engagement counters), publishedAt, URL, author and
// claimed mint all remain part of the comparison. Any divergence is a CONFLICT;
// it is never merged and no version is ever chosen.
//
// This module has ZERO authority over mint association: it copies assetAssociation
// from the verified normalized observation and never alters it.
import { PUBLIC_INTELLIGENCE_CLASSIFICATION, canonical, digest } from './definition.mjs';
import { failClosed } from './observation.mjs';
import { PUBLIC_INTELLIGENCE_5K4_SCHEMA_VERSION } from './corpus-membership.mjs';
import { rawProviderNamespaceOf } from './collection-plan.mjs';

export const PUBLIC_INTELLIGENCE_5K4_OBSERVATION_RECORD_TYPE = 'public_corpus_observation';
export const PUBLIC_INTELLIGENCE_5K4_CONFLICT_RECORD_TYPE = 'public_corpus_conflict';
export const PUBLIC_INTELLIGENCE_5K4_CONFLICT_TYPES = Object.freeze(['UPSTREAM_IDENTITY_CONTENT_DIVERGENCE']);
/** The ONLY raw fields excluded from cross-run content comparison. */
export const PUBLIC_INTELLIGENCE_5K4_ACQUISITION_FIELDS = Object.freeze(['fetchedAt', 'collectionContext']);

export function evidenceContentFingerprint(raw) {
  const content = {};
  for (const key of Object.keys(raw).sort()) {
    if (!PUBLIC_INTELLIGENCE_5K4_ACQUISITION_FIELDS.includes(key)) content[key] = raw[key];
  }
  return digest({ kind: 'publicCorpusEvidenceContent5K4', content });
}

const byKey = (key) => (a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);
const plain = value => JSON.parse(canonical(value));
const withFingerprint = (body, field) => plain({ ...body, [field]: digest(body) });

export const PUBLIC_INTELLIGENCE_5K4_OBSERVATION_SCHEMA = Object.freeze({
  closed: true,
  fields: Object.freeze([
    'schemaVersion', 'recordType', 'upstreamIdentity', 'provider', 'providerObservationId',
    'evidenceContentFingerprint', 'rawObservationFingerprint', 'normalizedObservationFingerprint', 'provenanceFingerprint',
    'publishedAt', 'firstSeenAt', 'lastSeenAt', 'appearanceCount', 'appearances',
    'memberRunIds', 'memberRunManifestFingerprints', 'assetAssociation', 'engagement', 'missingness',
    'classification', 'observationFingerprint',
  ]),
  appearanceFields: Object.freeze(['runId', 'runManifestFingerprint', 'fetchedAt', 'rawObservationFingerprint', 'normalizedObservationFingerprint', 'provenanceFingerprint']),
});
export const PUBLIC_INTELLIGENCE_5K4_CONFLICT_SCHEMA = Object.freeze({
  closed: true,
  fields: Object.freeze([
    'schemaVersion', 'recordType', 'conflictType', 'upstreamIdentity', 'provider', 'providerObservationId',
    'conflictingContentFingerprints', 'conflictingRawFingerprints', 'runIds', 'appearances', 'conflictFingerprint',
  ]),
});

function assertClosedRecord(record, fields, code) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) failClosed(`${code}_NOT_AN_OBJECT`);
  for (const key of Object.keys(record)) if (!fields.includes(key)) failClosed(`${code}_UNKNOWN_FIELD:${key}`);
  for (const key of fields) if (!Object.hasOwn(record, key)) failClosed(`${code}_FIELD_MISSING:${key}`);
}
const fingerprintOf = (record, field) => { const body = { ...record }; delete body[field]; return digest(body); };

export function validateObservationRecord(record) {
  assertClosedRecord(record, PUBLIC_INTELLIGENCE_5K4_OBSERVATION_SCHEMA.fields, 'PUBLIC_INTELLIGENCE_5K4_OBSERVATION');
  if (record.recordType !== PUBLIC_INTELLIGENCE_5K4_OBSERVATION_RECORD_TYPE) failClosed('PUBLIC_INTELLIGENCE_5K4_OBSERVATION_TYPE_INVALID');
  if (canonical(record.classification) !== canonical(PUBLIC_INTELLIGENCE_CLASSIFICATION)) failClosed('PUBLIC_INTELLIGENCE_5K4_OBSERVATION_CLASSIFICATION_OVERRIDE_REFUSED');
  for (const appearance of record.appearances) assertClosedRecord(appearance, PUBLIC_INTELLIGENCE_5K4_OBSERVATION_SCHEMA.appearanceFields, 'PUBLIC_INTELLIGENCE_5K4_APPEARANCE');
  if (record.observationFingerprint !== fingerprintOf(record, 'observationFingerprint')) failClosed('PUBLIC_INTELLIGENCE_5K4_OBSERVATION_FINGERPRINT_MISMATCH');
  return record;
}
export function validateConflictRecord(record) {
  assertClosedRecord(record, PUBLIC_INTELLIGENCE_5K4_CONFLICT_SCHEMA.fields, 'PUBLIC_INTELLIGENCE_5K4_CONFLICT');
  if (!PUBLIC_INTELLIGENCE_5K4_CONFLICT_TYPES.includes(record.conflictType)) failClosed('PUBLIC_INTELLIGENCE_5K4_CONFLICT_TYPE_INVALID');
  if (record.conflictFingerprint !== fingerprintOf(record, 'conflictFingerprint')) failClosed('PUBLIC_INTELLIGENCE_5K4_CONFLICT_FINGERPRINT_MISMATCH');
  return record;
}

/**
 * Builds the observation index + conflicts from AUTHENTICATED runs.
 *
 * runs: [{ manifest, observations: [envelope...] }] (any order - canonicalized here).
 * Output arrays are sorted by upstreamIdentity; appearances by (fetchedAt, runId).
 */
export function buildCorpusIndex(runs) {
  const ordered = [...runs].sort((a, b) => (a.manifest.runId < b.manifest.runId ? -1 : 1));
  const groups = new Map();
  for (const run of ordered) {
    for (const envelope of run.observations) {
      const raw = envelope.raw;
      const normalized = envelope.normalized;
      const identity = envelope.dedupIdentity;
      const appearance = {
        runId: run.manifest.runId,
        runManifestFingerprint: run.manifest.manifestFingerprint,
        fetchedAt: raw.fetchedAt,
        rawObservationFingerprint: envelope.rawObservationFingerprint,
        normalizedObservationFingerprint: digest(normalized),
        provenanceFingerprint: digest(normalized.provenance),
        evidenceContentFingerprint: evidenceContentFingerprint(raw),
        raw,
        normalized,
      };
      if (!groups.has(identity)) groups.set(identity, []);
      groups.get(identity).push(appearance);
    }
  }

  const observations = [];
  const conflicts = [];
  for (const identity of [...groups.keys()].sort()) {
    const appearances = groups.get(identity).sort((a, b) => (a.fetchedAt - b.fetchedAt) || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
    const publicAppearance = a => ({
      runId: a.runId, runManifestFingerprint: a.runManifestFingerprint, fetchedAt: a.fetchedAt,
      rawObservationFingerprint: a.rawObservationFingerprint, normalizedObservationFingerprint: a.normalizedObservationFingerprint,
      provenanceFingerprint: a.provenanceFingerprint,
    });
    const contentFingerprints = [...new Set(appearances.map(a => a.evidenceContentFingerprint))].sort();
    const head = appearances[0];
    if (contentFingerprints.length > 1) {
      conflicts.push(withFingerprint({
        schemaVersion: PUBLIC_INTELLIGENCE_5K4_SCHEMA_VERSION,
        recordType: PUBLIC_INTELLIGENCE_5K4_CONFLICT_RECORD_TYPE,
        conflictType: 'UPSTREAM_IDENTITY_CONTENT_DIVERGENCE',
        upstreamIdentity: identity,
        provider: head.raw.provider,
        providerObservationId: head.raw.providerObservationId,
        conflictingContentFingerprints: contentFingerprints,
        conflictingRawFingerprints: [...new Set(appearances.map(a => a.rawObservationFingerprint))].sort(),
        runIds: [...new Set(appearances.map(a => a.runId))].sort(),
        appearances: appearances.map(a => ({ ...publicAppearance(a), evidenceContentFingerprint: a.evidenceContentFingerprint })),
      }, 'conflictFingerprint'));
      continue; // a conflict is NEVER transformed into a canonical observation
    }
    const association = head.normalized.assetAssociation;
    observations.push(withFingerprint({
      schemaVersion: PUBLIC_INTELLIGENCE_5K4_SCHEMA_VERSION,
      recordType: PUBLIC_INTELLIGENCE_5K4_OBSERVATION_RECORD_TYPE,
      upstreamIdentity: identity,
      provider: head.raw.provider,
      providerObservationId: head.raw.providerObservationId,
      evidenceContentFingerprint: contentFingerprints[0],
      // Reference pointers: the earliest appearance by (fetchedAt, runId). All
      // appearances carry content-identical evidence, so this selects NO content.
      rawObservationFingerprint: head.rawObservationFingerprint,
      normalizedObservationFingerprint: head.normalizedObservationFingerprint,
      provenanceFingerprint: head.provenanceFingerprint,
      publishedAt: head.raw.publishedAt,
      firstSeenAt: appearances[0].fetchedAt,
      lastSeenAt: appearances[appearances.length - 1].fetchedAt,
      appearanceCount: appearances.length,
      appearances: appearances.map(publicAppearance),
      memberRunIds: [...new Set(appearances.map(a => a.runId))].sort(),
      memberRunManifestFingerprints: [...new Set(appearances.map(a => a.runManifestFingerprint))].sort(),
      // Copied verbatim from verified normalized evidence; never inferred or altered.
      assetAssociation: { status: association.status, mint: association.mint, method: association.method },
      engagement: head.normalized.engagement,
      missingness: head.normalized.missingness,
      classification: PUBLIC_INTELLIGENCE_CLASSIFICATION,
    }, 'observationFingerprint'));
  }
  observations.sort(byKey('upstreamIdentity'));
  conflicts.sort(byKey('upstreamIdentity'));
  return Object.freeze({ observations: Object.freeze(observations), conflicts: Object.freeze(conflicts) });
}

const bump = (map, key, by = 1) => { map[key] = (map[key] ?? 0) + by; };
const sortedObject = map => Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/**
 * Coverage accounting. EVIDENCE COVERAGE ONLY: these numbers describe what was
 * collected. They are not popularity, importance, sentiment or market relevance.
 * Missing values stay null; nothing is defaulted to zero.
 */
export function computeCoverage(memberships, index, runs) {
  const association = { EXACT_MINT: 0, UNASSOCIATED: 0, INVALID_MINT: 0, AMBIGUOUS: 0 };
  const providers = {};
  const queries = {};
  const statuses = {};
  let duplicateAppearances = 0;
  let canonicalAppearances = 0;
  let publishedMin = null; let publishedMax = null; let fetchedMin = null; let fetchedMax = null;
  const widen = (value, which) => {
    if (value === null) return;
    if (which === 'published') { publishedMin = publishedMin === null ? value : Math.min(publishedMin, value); publishedMax = publishedMax === null ? value : Math.max(publishedMax, value); } else {
      fetchedMin = fetchedMin === null ? value : Math.min(fetchedMin, value); fetchedMax = fetchedMax === null ? value : Math.max(fetchedMax, value);
    }
  };
  for (const membership of memberships) {
    bump(statuses, membership.status);
    bump(queries, `${membership.query.type}:${membership.query.value}`);
    // Keyed by the GOVERNED raw provider namespace, which is what every
    // observation in this corpus also carries, so run and observation counts
    // unify into one row per provider. For Mastodon this is exactly
    // `mastodon:<instance>` as before. A provider whose namespace is host-free
    // (Bluesky) would otherwise produce TWO rows - one from its runs and one from
    // its evidence - and the run-level row would claim a namespace no observation
    // ever carries.
    const key = rawProviderNamespaceOf(membership);
    providers[key] ??= { runs: 0, appearances: 0, canonicalObservations: 0, conflictedIdentities: 0 };
    providers[key].runs += 1;
  }
  for (const observation of index.observations) {
    association[observation.assetAssociation.status] = (association[observation.assetAssociation.status] ?? 0) + 1;
    duplicateAppearances += observation.appearanceCount - 1;
    canonicalAppearances += observation.appearanceCount;
    providers[observation.provider] ??= { runs: 0, appearances: 0, canonicalObservations: 0, conflictedIdentities: 0 };
    providers[observation.provider].canonicalObservations += 1;
    providers[observation.provider].appearances += observation.appearanceCount;
    widen(observation.publishedAt, 'published');
    for (const appearance of observation.appearances) widen(appearance.fetchedAt, 'fetched');
  }
  let conflictedAppearances = 0;
  for (const conflict of index.conflicts) {
    conflictedAppearances += conflict.appearances.length;
    providers[conflict.provider] ??= { runs: 0, appearances: 0, canonicalObservations: 0, conflictedIdentities: 0 };
    providers[conflict.provider].conflictedIdentities += 1;
    providers[conflict.provider].appearances += conflict.appearances.length;
    for (const appearance of conflict.appearances) widen(appearance.fetchedAt, 'fetched');
  }
  return plain({
    runCount: memberships.length,
    completedRuns: statuses.COMPLETED ?? 0,
    partialRuns: statuses.PARTIAL ?? 0,
    providerCounts: sortedObject(providers),
    queryCounts: sortedObject(queries),
    statusCounts: sortedObject(statuses),
    providerRecordsSeen: runs.reduce((sum, run) => sum + run.manifest.providerRecordsSeen, 0),
    canonicalObservationCount: index.observations.length,
    conflictedUpstreamIdentities: index.conflicts.length,
    uniqueUpstreamObservations: index.observations.length + index.conflicts.length,
    canonicalAppearances,
    duplicateAppearancesAcrossRuns: duplicateAppearances,
    conflictedAppearances,
    associationCounts: association,
    earliestPublishedAt: publishedMin, latestPublishedAt: publishedMax,
    earliestFetchedAt: fetchedMin, latestFetchedAt: fetchedMax,
  });
}
