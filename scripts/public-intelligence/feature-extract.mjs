// Phase 5K.9 - DESCRIPTIVE FEATURE EXTRACTION (PURE).
//
// PURE AND OFFLINE BY CONSTRUCTION. No filesystem, no socket, no clock, no
// environment, no LLM, no price feed. It reads already-VERIFIED derived content -
// 5K.5 temporal records, 5K.7 corroboration records, 5K.8 content versions and
// lineages - plus the authenticated raw envelopes those fingerprints came from,
// and MEASURES what is there.
//
// Every number this module emits is an exact measurement of authenticated
// evidence. Nothing is weighted, normalized, standardized or combined. There is
// no score, no rank, no confidence and no interpretation: `providerFamilyCount`
// is how many families contributed, not how strong the evidence is.
import { canonical, digest, PUBLIC_INTELLIGENCE_CLASSIFICATION } from './definition.mjs';
import { failClosed } from './observation.mjs';
import { PUBLIC_INTELLIGENCE_5K7_COVERAGE_STATUS } from './corroboration-definition.mjs';
import { PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS } from './lineage-definition.mjs';
import { rawObservationFingerprint as rawObservationFingerprint5K1 } from './provenance.mjs';
import { PUBLIC_INTELLIGENCE_5K5_TEMPORAL_CLASSIFICATION as T } from './revision-chain.mjs';
import {
  PUBLIC_INTELLIGENCE_5K9_SCHEMA_VERSION, PUBLIC_INTELLIGENCE_5K9_RECORD_TYPES,
  PUBLIC_INTELLIGENCE_5K9_ENGAGEMENT_COUNTERS, PUBLIC_INTELLIGENCE_5K9_LINEAGE_COVERAGE_STATUS_VALUES,
  PUBLIC_INTELLIGENCE_5K9_COVERAGE_STATUS_VALUES, PUBLIC_INTELLIGENCE_5K9_PROVIDER_FAMILIES,
  lineageCoverageStatusFor, bucketStartOf, bucketEndOf,
} from './feature-definition.mjs';

export const PUBLIC_INTELLIGENCE_5K9_MINT_FEATURE_RECORD_TYPE = PUBLIC_INTELLIGENCE_5K9_RECORD_TYPES.MINT_FEATURE;

const FINGERPRINT = /^[0-9a-f]{64}$/;
const plain = value => JSON.parse(canonical(value));
const byKey = key => (a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);
const uniqueSorted = values => [...new Set(values)].sort();
const sortedKeys = object => Object.fromEntries(Object.entries(object).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const fingerprintOf = (record, field) => { const body = { ...record }; delete body[field]; return digest(body); };

/** The CLOSED per-counter engagement summary. Nullable extrema when unobserved. */
export const PUBLIC_INTELLIGENCE_5K9_ENGAGEMENT_COUNTER_SCHEMA = Object.freeze({
  closed: true,
  fields: Object.freeze(['counter', 'observedCount', 'missingCount', 'minObservedValue', 'maxObservedValue', 'firstObservedValue', 'lastObservedValue']),
  nullableFields: Object.freeze(['minObservedValue', 'maxObservedValue', 'firstObservedValue', 'lastObservedValue']),
});

/** The CLOSED per-provider-family block. Counts and timestamps only. */
export const PUBLIC_INTELLIGENCE_5K9_FAMILY_FEATURE_SCHEMA = Object.freeze({
  closed: true,
  fields: Object.freeze([
    'providerNamespaceCount', 'upstreamObservationCount', 'contentVersionCount',
    'observationStateSnapshotCount', 'memberRunCount', 'firstObservedAt', 'lastObservedAt',
    'publishedAtAvailableCount', 'publishedAtMissingCount',
    'engagementObservationCount', 'engagementMissingCount', 'engagement',
  ]),
});

/** The CLOSED sparse temporal bucket. Structural counts only. */
export const PUBLIC_INTELLIGENCE_5K9_TEMPORAL_BUCKET_SCHEMA = Object.freeze({
  closed: true,
  fields: Object.freeze(['bucketStart', 'bucketEnd', 'upstreamObservationCount', 'contentVersionCount', 'stateSnapshotCount']),
});

/** The CLOSED per-category availability pair. */
export const PUBLIC_INTELLIGENCE_5K9_AVAILABILITY_SCHEMA = Object.freeze({
  closed: true,
  fields: Object.freeze(['available', 'missing']),
});

export const PUBLIC_INTELLIGENCE_5K9_MISSINGNESS_CATEGORIES = Object.freeze(
  ['publishedAt', 'observedAt', 'providerAuthorId', 'sourceUrl', 'engagement'],
);

/** The CLOSED missingness block. */
export const PUBLIC_INTELLIGENCE_5K9_MISSINGNESS_SCHEMA = Object.freeze({
  closed: true,
  fields: Object.freeze([...PUBLIC_INTELLIGENCE_5K9_MISSINGNESS_CATEGORIES, 'absentTreatedAsZero', 'observationSilentlyDropped']),
});

/** The CLOSED per-mint descriptive feature record. Unknown fields are refused. */
export const PUBLIC_INTELLIGENCE_5K9_MINT_FEATURE_SCHEMA = Object.freeze({
  closed: true,
  fields: Object.freeze([
    'schemaVersion', 'recordType', 'mint',
    'providerFamilyCount', 'providerNamespaceCount',
    'upstreamObservationCount', 'contentVersionCount', 'observationStateSnapshotCount', 'memberRunCount',
    'contentLineageCount', 'exactRawMatchLineageCount', 'canonicalMatchLineageCount',
    'explicitReferenceLineageCount', 'distinctContentLineageCount', 'unresolvedLineageCount',
    'providerDeclaredRevisionCount', 'unverifiedDivergenceCount', 'stateChangeCount',
    'firstObservedAt', 'lastObservedAt', 'observationWindowMs',
    'publishedAtAvailableCount', 'publishedAtMissingCount',
    'engagementObservationCount', 'engagementMissingCount',
    'coverageStatus', 'lineageCoverageStatus',
    'providerFamilies', 'temporalBuckets', 'missingness', 'classification', 'featureFingerprint',
  ]),
  countFields: Object.freeze([
    'providerFamilyCount', 'providerNamespaceCount', 'upstreamObservationCount', 'contentVersionCount',
    'observationStateSnapshotCount', 'memberRunCount', 'contentLineageCount', 'exactRawMatchLineageCount',
    'canonicalMatchLineageCount', 'explicitReferenceLineageCount', 'distinctContentLineageCount',
    'unresolvedLineageCount', 'providerDeclaredRevisionCount', 'unverifiedDivergenceCount', 'stateChangeCount',
    'publishedAtAvailableCount', 'publishedAtMissingCount', 'engagementObservationCount', 'engagementMissingCount',
  ]),
});

// ---------------------------------------------------------------------------
// AUTHENTICATED ENVELOPE INDEX (availability and provider-supplied counters)
// ---------------------------------------------------------------------------

/**
 * Indexes the authenticated envelopes by their 5K.1 raw fingerprint, recording
 * ONLY structural availability and the provider-supplied counters. No body,
 * handle, display name or URL is retained.
 */
export function buildAvailabilityIndex(envelopes = []) {
  const index = new Map();
  for (const envelope of envelopes) {
    const raw = envelope?.raw;
    if (!raw || typeof raw !== 'object') failClosed('PUBLIC_INTELLIGENCE_5K9_ENVELOPE_INVALID');
    const engagement = raw.rawMetadata?.engagement ?? null;
    if (engagement !== null && (typeof engagement !== 'object' || Array.isArray(engagement))) {
      failClosed('PUBLIC_INTELLIGENCE_5K9_ENGAGEMENT_NOT_AN_OBJECT');
    }
    const counters = {};
    for (const counter of PUBLIC_INTELLIGENCE_5K9_ENGAGEMENT_COUNTERS) {
      counters[counter] = engagement !== null && Object.hasOwn(engagement, counter) ? engagement[counter] : null;
    }
    const entry = {
      publishedAt: raw.publishedAt === null || raw.publishedAt === undefined ? null : raw.publishedAt,
      observedAt: raw.observedAt === null || raw.observedAt === undefined ? null : raw.observedAt,
      providerAuthorId: raw.providerAuthorId === null || raw.providerAuthorId === undefined ? null : raw.providerAuthorId,
      sourceUrl: raw.sourceUrl === null || raw.sourceUrl === undefined ? null : raw.sourceUrl,
      engagementSupplied: engagement !== null,
      counters,
    };
    index.set(rawObservationFingerprint5K1(raw), entry);
  }
  return index;
}

const availabilityOf = index => ({
  publishedAt: { available: index.publishedAt === null ? 0 : 1, missing: index.publishedAt === null ? 1 : 0 },
  observedAt: { available: index.observedAt === null ? 0 : 1, missing: index.observedAt === null ? 1 : 0 },
  providerAuthorId: { available: index.providerAuthorId === null ? 0 : 1, missing: index.providerAuthorId === null ? 1 : 0 },
  sourceUrl: { available: index.sourceUrl === null ? 0 : 1, missing: index.sourceUrl === null ? 1 : 0 },
  engagement: { available: index.engagementSupplied ? 1 : 0, missing: index.engagementSupplied ? 0 : 1 },
});

/** Sums a list of availability pairs into one category pair. */
const sumAvailability = entries => {
  const total = { available: 0, missing: 0 };
  for (const entry of entries) { total.available += entry.available; total.missing += entry.missing; }
  return total;
};

// ---------------------------------------------------------------------------
// ENGAGEMENT SUMMARIES (per family, field by field)
// ---------------------------------------------------------------------------

/**
 * One provider-supplied counter summary over a set of ORDERED observations.
 * Absent counters are counted as missing and never filled with zero; a
 * provider-supplied zero is an ordinary observed value.
 */
export function summariseCounter(counter, observations) {
  if (!PUBLIC_INTELLIGENCE_5K9_ENGAGEMENT_COUNTERS.includes(counter)) {
    failClosed(`PUBLIC_INTELLIGENCE_5K9_COUNTER_UNKNOWN:${String(counter).slice(0, 40)}`);
  }
  if (!Array.isArray(observations)) failClosed('PUBLIC_INTELLIGENCE_5K9_COUNTER_OBSERVATIONS_INVALID');
  const values = observations
    .map(observation => ({ value: observation.counters[counter], fetchedAt: observation.fetchedAt, fingerprint: observation.rawObservationFingerprint, runId: observation.runId }))
    .filter(entry => entry.value !== null);
  const numbers = values.map(entry => entry.value);
  const ordered = [...values].sort((a, b) => (a.fetchedAt - b.fetchedAt
    || (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0)
    || ((a.runId ?? '') < (b.runId ?? '') ? -1 : (a.runId ?? '') > (b.runId ?? '') ? 1 : 0)));
  return plain({
    counter,
    observedCount: numbers.length,
    missingCount: observations.length - numbers.length,
    minObservedValue: numbers.length ? Math.min(...numbers) : null,
    maxObservedValue: numbers.length ? Math.max(...numbers) : null,
    firstObservedValue: ordered.length ? ordered[0].value : null,
    lastObservedValue: ordered.length ? ordered[ordered.length - 1].value : null,
  });
}

/** Every governed counter, field by field, in sorted-name order. */
export function summariseEngagement(observations) {
  const engagement = {};
  for (const counter of PUBLIC_INTELLIGENCE_5K9_ENGAGEMENT_COUNTERS) {
    engagement[counter] = summariseCounter(counter, observations);
  }
  return sortedKeys(engagement);
}

// ---------------------------------------------------------------------------
// EXTRACTION
// ---------------------------------------------------------------------------

/**
 * Extracts the per-mint descriptive feature records and the snapshot-level
 * missingness/aggregate summary from VERIFIED 5K.4/5K.5/5K.7/5K.8 content.
 */
export function extractFeatures({
  temporal = {}, contentVersions = [], lineages = [],
  coverageRecords = [], observationCoverageRecords = [], envelopes = [],
} = {}) {
  const observationRecords = temporal.observationRecords ?? [];
  if (!Array.isArray(observationRecords) || !Array.isArray(contentVersions) || !Array.isArray(lineages)) {
    failClosed('PUBLIC_INTELLIGENCE_5K9_EXTRACT_INPUT_INVALID');
  }
  const availability = buildAvailabilityIndex(envelopes);

  const versionByKey = new Map();
  for (const version of contentVersions) {
    versionByKey.set(`${version.upstreamIdentity}\u0000${version.contentFingerprint}`, version);
  }

  // Group every authenticated observation under the mint its version carries.
  const byMint = new Map();
  for (const record of observationRecords) {
    const key = `${record.upstreamIdentity}\u0000${record.contentFingerprint}`;
    const version = versionByKey.get(key);
    const exact = record.assetAssociation?.status === 'EXACT_MINT';
    if (!version) {
      // Every authenticated observation has a content version. A missing one is
      // drift, and an EXACT_MINT observation without a version is a hard refusal.
      if (exact) failClosed(`PUBLIC_INTELLIGENCE_5K9_EXACT_OBSERVATION_WITHOUT_VERSION:${String(record.upstreamIdentity).slice(0, 64)}`);
      continue;
    }
    if (version.exactMintSubject === null) continue;
    const mint = version.exactMintSubject;
    if (!byMint.has(mint)) byMint.set(mint, []);
    byMint.get(mint).push({
      record,
      version,
      providerNamespace: version.providerNamespace,
      providerFamily: version.providerFamily,
      fetchedAt: record.fetchedAt,
      runId: record.runId ?? null,
      rawObservationFingerprint: record.rawObservationFingerprint,
      stateFingerprint: record.observationStateFingerprint,
      temporalClassification: record.temporalClassification,
    });
  }

  const coverageByMint = new Map(coverageRecords.map(record => [record.mint, record]));
  const lineagesByMint = new Map();
  for (const lineage of lineages) {
    for (const mint of lineage.exactMintSubjects) {
      if (!lineagesByMint.has(mint)) lineagesByMint.set(mint, []);
      lineagesByMint.get(mint).push(lineage);
    }
  }

  const records = [];
  const usedLineageIds = new Set();
  for (const mint of [...byMint.keys()].sort()) {
    const contributions = byMint.get(mint);
    const coverage = coverageByMint.get(mint);
    if (!coverage) failClosed(`PUBLIC_INTELLIGENCE_5K9_MINT_NOT_IN_COVERAGE:${mint.slice(0, 64)}`);
    const mintLineages = lineagesByMint.get(mint) ?? [];
    for (const lineage of mintLineages) usedLineageIds.add(lineage.lineageId);
    records.push(buildMintFeature({ mint, contributions, coverage, mintLineages, availability }));
  }

  const summary = buildFeatureSummary({ records, observationCoverageRecords, usedLineageIds });
  return Object.freeze({ records: Object.freeze(records), summary });
}

/**
 * The deterministic order of two authenticated observations: acquisition time,
 * then raw observation fingerprint, then member run. It NEVER consults a feature
 * value, so neither input order nor run order nor filesystem order can change a
 * measurement.
 */
function compareObservationOrder(a, b) {
  if (a.fetchedAt !== b.fetchedAt) return a.fetchedAt - b.fetchedAt;
  if (a.rawObservationFingerprint !== b.rawObservationFingerprint) {
    return a.rawObservationFingerprint < b.rawObservationFingerprint ? -1 : 1;
  }
  const left = a.runId ?? '';
  const right = b.runId ?? '';
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The distinct member runs of a set of authenticated observations. */
const memberRunCountOf = entries => uniqueSorted(entries.map(entry => entry.runId)
  .filter(runId => typeof runId === 'string' && runId)).length;

function buildMintFeature({ mint, contributions, coverage, mintLineages, availability }) {
  const withAvailability = contributions.map(contribution => {
    const entry = availability.get(contribution.rawObservationFingerprint);
    if (!entry) failClosed(`PUBLIC_INTELLIGENCE_5K9_OBSERVATION_AVAILABILITY_UNAVAILABLE:${mint.slice(0, 48)}`);
    return {
      ...contribution,
      counters: entry.counters,
      engagementSupplied: entry.engagementSupplied,
      availability: availabilityOf(entry),
    };
  });

  // ONE AUTHENTICATED OBSERVATION INSTANCE = ONE (upstream identity, content
  // version, observation state) triple. A repeat acquisition of an UNCHANGED
  // post is the SAME observation and is counted once; a provider-declared
  // revision or an engagement state change is a NEW observation. Nothing is
  // dropped and nothing is merged across identities or provider families.
  const instanceByKey = new Map();
  for (const entry of withAvailability) {
    const key = [entry.record.upstreamIdentity, entry.version.contentFingerprint, entry.stateFingerprint].join('\u0000');
    const existing = instanceByKey.get(key);
    if (!existing || compareObservationOrder(entry, existing) < 0) instanceByKey.set(key, entry);
  }
  const instances = [...instanceByKey.values()].sort(compareObservationOrder);

  const familiesPresent = uniqueSorted(instances.map(entry => entry.providerFamily));
  const providerFamilies = {};
  for (const family of familiesPresent) {
    const familyEntries = instances.filter(entry => entry.providerFamily === family);
    const familyAvailability = {
      publishedAt: sumAvailability(familyEntries.map(entry => entry.availability.publishedAt)),
      engagement: sumAvailability(familyEntries.map(entry => entry.availability.engagement)),
    };
    providerFamilies[family] = plain({
      providerNamespaceCount: uniqueSorted(familyEntries.map(entry => entry.providerNamespace)).length,
      upstreamObservationCount: familyEntries.length,
      contentVersionCount: uniqueSorted(familyEntries.map(entry => entry.version.contentVersionFingerprint)).length,
      observationStateSnapshotCount: familyEntries.length,
      memberRunCount: memberRunCountOf(familyEntries),
      firstObservedAt: Math.min(...familyEntries.map(entry => entry.fetchedAt)),
      lastObservedAt: Math.max(...familyEntries.map(entry => entry.fetchedAt)),
      publishedAtAvailableCount: familyAvailability.publishedAt.available,
      publishedAtMissingCount: familyAvailability.publishedAt.missing,
      engagementObservationCount: familyAvailability.engagement.available,
      engagementMissingCount: familyAvailability.engagement.missing,
      engagement: summariseEngagement(familyEntries),
    });
  }

  const mintAvailability = {
    publishedAt: sumAvailability(instances.map(entry => entry.availability.publishedAt)),
    observedAt: sumAvailability(instances.map(entry => entry.availability.observedAt)),
    providerAuthorId: sumAvailability(instances.map(entry => entry.availability.providerAuthorId)),
    sourceUrl: sumAvailability(instances.map(entry => entry.availability.sourceUrl)),
    engagement: sumAvailability(instances.map(entry => entry.availability.engagement)),
  };

  const lineageClassCount = name => mintLineages.filter(lineage => lineage.lineageClass === name).length;
  const firstObservedAt = Math.min(...instances.map(entry => entry.fetchedAt));
  const lastObservedAt = Math.max(...instances.map(entry => entry.fetchedAt));

  const bucketKeys = uniqueSorted(instances.map(entry => String(bucketStartOf(entry.fetchedAt))));
  const temporalBuckets = bucketKeys.map(key => {
    const start = Number(key);
    const inBucket = instances.filter(entry => bucketStartOf(entry.fetchedAt) === start);
    return plain({
      bucketStart: start,
      bucketEnd: bucketEndOf(start),
      upstreamObservationCount: uniqueSorted(inBucket.map(entry => entry.record.upstreamIdentity)).length,
      contentVersionCount: uniqueSorted(inBucket.map(entry => entry.version.contentVersionFingerprint)).length,
      stateSnapshotCount: uniqueSorted(inBucket.map(entry => entry.stateFingerprint)).length,
    });
  }).sort(byKey('bucketStart'));

  const body = {
    schemaVersion: PUBLIC_INTELLIGENCE_5K9_SCHEMA_VERSION,
    recordType: PUBLIC_INTELLIGENCE_5K9_MINT_FEATURE_RECORD_TYPE,
    mint,
    providerFamilyCount: familiesPresent.length,
    providerNamespaceCount: uniqueSorted(instances.map(entry => entry.providerNamespace)).length,
    // Each distinct authenticated observation instance carries EXACTLY one
    // observation-state snapshot, so the two measurements coincide by
    // construction. They are both reported: neither is derived from the other.
    upstreamObservationCount: instances.length,
    contentVersionCount: uniqueSorted(instances.map(entry => entry.version.contentVersionFingerprint)).length,
    observationStateSnapshotCount: instances.length,
    memberRunCount: memberRunCountOf(instances),
    contentLineageCount: mintLineages.length,
    exactRawMatchLineageCount: lineageClassCount(PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS.EXACT_RAW_TEXT_MATCH),
    canonicalMatchLineageCount: lineageClassCount(PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS.CANONICAL_TEXT_MATCH),
    explicitReferenceLineageCount: lineageClassCount(PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS.EXPLICIT_CROSS_POST_REFERENCE),
    distinctContentLineageCount: lineageClassCount(PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS.DISTINCT_CONTENT),
    unresolvedLineageCount: lineageClassCount(PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS.UNRESOLVED),
    providerDeclaredRevisionCount: instances.filter(entry => entry.temporalClassification === T.PROVIDER_DECLARED_CONTENT_REVISION).length,
    unverifiedDivergenceCount: instances.filter(entry => entry.temporalClassification === T.UNVERIFIED_CONTENT_DIVERGENCE).length,
    stateChangeCount: instances.filter(entry => entry.temporalClassification === T.SAME_CONTENT_UPDATED_STATE).length,
    firstObservedAt,
    lastObservedAt,
    observationWindowMs: lastObservedAt - firstObservedAt,
    publishedAtAvailableCount: mintAvailability.publishedAt.available,
    publishedAtMissingCount: mintAvailability.publishedAt.missing,
    engagementObservationCount: instances.filter(entry => entry.engagementSupplied).length,
    engagementMissingCount: instances.filter(entry => !entry.engagementSupplied).length,
    coverageStatus: coverage.coverageStatus,
    lineageCoverageStatus: lineageCoverageStatusFor(mintLineages.length),
    providerFamilies: sortedKeys(providerFamilies),
    temporalBuckets,
    missingness: plain({
      publishedAt: mintAvailability.publishedAt,
      observedAt: mintAvailability.observedAt,
      providerAuthorId: mintAvailability.providerAuthorId,
      sourceUrl: mintAvailability.sourceUrl,
      engagement: mintAvailability.engagement,
      absentTreatedAsZero: false,
      observationSilentlyDropped: false,
    }),
    classification: PUBLIC_INTELLIGENCE_CLASSIFICATION,
  };
  const record = plain({ ...body, featureFingerprint: digest(body) });
  validateMintFeature(record);
  return record;
}

/** The snapshot-level summary. Aggregate structural counts only. */
export function buildFeatureSummary({ records, observationCoverageRecords = [], usedLineageIds = new Set() }) {
  const headCounts = { EXACT_MINT: 0, UNASSOCIATED: 0, INVALID_MINT: 0, AMBIGUOUS: 0 };
  for (const record of observationCoverageRecords) {
    if (Object.hasOwn(headCounts, record?.associationStatus)) headCounts[record.associationStatus] += 1;
  }
  const earliest = records.length ? Math.min(...records.map(record => record.firstObservedAt)) : null;
  const latest = records.length ? Math.max(...records.map(record => record.lastObservedAt)) : null;
  return plain({
    mintFeatureCount: records.length,
    unassociatedObservationCount: headCounts.UNASSOCIATED,
    invalidMintObservationCount: headCounts.INVALID_MINT,
    ambiguousObservationCount: headCounts.AMBIGUOUS,
    exactMintObservationCount: headCounts.EXACT_MINT,
    singleProviderFamilyMintCount: records.filter(record => record.coverageStatus === PUBLIC_INTELLIGENCE_5K7_COVERAGE_STATUS.SINGLE_PROVIDER_FAMILY).length,
    multiProviderFamilyMintCount: records.filter(record => record.coverageStatus === PUBLIC_INTELLIGENCE_5K7_COVERAGE_STATUS.MULTI_PROVIDER_FAMILY).length,
    totalUpstreamObservationCount: records.reduce((sum, record) => sum + record.upstreamObservationCount, 0),
    totalContentVersionCount: records.reduce((sum, record) => sum + record.contentVersionCount, 0),
    totalStateSnapshotCount: records.reduce((sum, record) => sum + record.observationStateSnapshotCount, 0),
    totalLineageCount: usedLineageIds.size,
    totalProviderFamilyCount: records.reduce((sum, record) => sum + record.providerFamilyCount, 0),
    singleProviderFamilyMintCountObserved: records.filter(record => record.providerFamilyCount === 1).length,
    multiProviderFamilyMintCountObserved: records.filter(record => record.providerFamilyCount >= 2).length,
    earliestObservedAt: earliest,
    latestObservedAt: latest,
  });
}

/** The summary invariants. Every one is an identity over the derived records. */
export function checkFeatureSummary(summary, { records = [] } = {}) {
  const problems = [];
  const check = (condition, code) => { if (!condition) problems.push(code); };
  const S = summary;
  check(S.mintFeatureCount === records.length, 'FEATURE_SUMMARY_MINT_COUNT_DRIFT');
  check(S.singleProviderFamilyMintCount + S.multiProviderFamilyMintCount === S.mintFeatureCount, 'FEATURE_SUMMARY_COVERAGE_PARTITION');
  check(S.singleProviderFamilyMintCountObserved + S.multiProviderFamilyMintCountObserved === S.mintFeatureCount, 'FEATURE_SUMMARY_FAMILY_PARTITION');
  check(S.totalUpstreamObservationCount === records.reduce((sum, record) => sum + record.upstreamObservationCount, 0), 'FEATURE_SUMMARY_OBSERVATION_DRIFT');
  check(S.totalContentVersionCount === records.reduce((sum, record) => sum + record.contentVersionCount, 0), 'FEATURE_SUMMARY_VERSION_DRIFT');
  check(S.totalStateSnapshotCount === records.reduce((sum, record) => sum + record.observationStateSnapshotCount, 0), 'FEATURE_SUMMARY_STATE_DRIFT');
  check(S.totalLineageCount <= records.reduce((sum, record) => sum + record.contentLineageCount, 0), 'FEATURE_SUMMARY_LINEAGE_EXCEEDS_MEMBERSHIP');
  check((S.earliestObservedAt === null) === (S.mintFeatureCount === 0), 'FEATURE_SUMMARY_EARLIEST_NULLABILITY');
  check((S.latestObservedAt === null) === (S.mintFeatureCount === 0), 'FEATURE_SUMMARY_LATEST_NULLABILITY');
  if (S.earliestObservedAt !== null && S.latestObservedAt !== null) check(S.earliestObservedAt <= S.latestObservedAt, 'FEATURE_SUMMARY_TIME_INVERTED');
  for (const record of records) {
    check(record.distinctContentLineageCount + record.exactRawMatchLineageCount + record.canonicalMatchLineageCount
      + record.explicitReferenceLineageCount + record.unresolvedLineageCount === record.contentLineageCount,
    'FEATURE_RECORD_LINEAGE_CLASS_PARTITION');
    check(record.firstObservedAt + record.observationWindowMs === record.lastObservedAt, 'FEATURE_RECORD_WINDOW_MISMATCH');
    check(record.publishedAtAvailableCount + record.publishedAtMissingCount === record.upstreamObservationCount, 'FEATURE_RECORD_PUBLISHED_PARTITION');
    check(record.engagementObservationCount + record.engagementMissingCount === record.upstreamObservationCount, 'FEATURE_RECORD_ENGAGEMENT_PARTITION');
  }
  return Object.freeze({ ok: problems.length === 0, problems: Object.freeze(problems) });
}

// ---------------------------------------------------------------------------
// VALIDATION
// ---------------------------------------------------------------------------

function validateCounterSummary(counter, summary) {
  const S = PUBLIC_INTELLIGENCE_5K9_ENGAGEMENT_COUNTER_SCHEMA;
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) failClosed('PUBLIC_INTELLIGENCE_5K9_COUNTER_NOT_AN_OBJECT');
  for (const key of Object.keys(summary)) if (!S.fields.includes(key)) failClosed(`PUBLIC_INTELLIGENCE_5K9_COUNTER_UNKNOWN_FIELD:${String(key).slice(0, 40)}`);
  for (const key of S.fields) if (!Object.hasOwn(summary, key)) failClosed(`PUBLIC_INTELLIGENCE_5K9_COUNTER_FIELD_MISSING:${counter}.${key}`);
  if (summary.counter !== counter) failClosed(`PUBLIC_INTELLIGENCE_5K9_COUNTER_NAME_MISMATCH:${counter}`);
  if (!PUBLIC_INTELLIGENCE_5K9_ENGAGEMENT_COUNTERS.includes(counter)) failClosed(`PUBLIC_INTELLIGENCE_5K9_COUNTER_UNKNOWN:${String(counter).slice(0, 40)}`);
  for (const key of ['observedCount', 'missingCount']) {
    if (!Number.isSafeInteger(summary[key]) || summary[key] < 0) failClosed(`PUBLIC_INTELLIGENCE_5K9_COUNTER_COUNT_INVALID:${counter}.${key}`);
  }
  for (const key of S.nullableFields) {
    if (summary[key] === null) continue;
    if (!Number.isSafeInteger(summary[key]) || summary[key] < 0) failClosed(`PUBLIC_INTELLIGENCE_5K9_COUNTER_VALUE_INVALID:${counter}.${key}`);
  }
  // An unobserved counter reports no extrema; an observed counter reports them all.
  const extrema = S.nullableFields.map(key => summary[key]);
  if (summary.observedCount === 0 && extrema.some(value => value !== null)) failClosed(`PUBLIC_INTELLIGENCE_5K9_COUNTER_EXTREMA_WITHOUT_OBSERVATION:${counter}`);
  if (summary.observedCount > 0 && extrema.some(value => value === null)) failClosed(`PUBLIC_INTELLIGENCE_5K9_COUNTER_OBSERVATION_WITHOUT_EXTREMA:${counter}`);
  if (summary.observedCount > 0 && summary.minObservedValue > summary.maxObservedValue) failClosed(`PUBLIC_INTELLIGENCE_5K9_COUNTER_EXTREMA_INVERTED:${counter}`);
  return summary;
}

function validateFamilyBlock(family, block) {
  const S = PUBLIC_INTELLIGENCE_5K9_FAMILY_FEATURE_SCHEMA;
  if (!PUBLIC_INTELLIGENCE_5K9_PROVIDER_FAMILIES.includes(family)) failClosed(`PUBLIC_INTELLIGENCE_5K9_FAMILY_UNKNOWN:${String(family).slice(0, 40)}`);
  if (!block || typeof block !== 'object' || Array.isArray(block)) failClosed('PUBLIC_INTELLIGENCE_5K9_FAMILY_NOT_AN_OBJECT');
  for (const key of Object.keys(block)) if (!S.fields.includes(key)) failClosed(`PUBLIC_INTELLIGENCE_5K9_FAMILY_UNKNOWN_FIELD:${family}.${String(key).slice(0, 40)}`);
  for (const key of S.fields) if (!Object.hasOwn(block, key)) failClosed(`PUBLIC_INTELLIGENCE_5K9_FAMILY_FIELD_MISSING:${family}.${key}`);
  for (const key of ['providerNamespaceCount', 'upstreamObservationCount', 'contentVersionCount', 'observationStateSnapshotCount', 'memberRunCount',
    'publishedAtAvailableCount', 'publishedAtMissingCount', 'engagementObservationCount', 'engagementMissingCount']) {
    if (!Number.isSafeInteger(block[key]) || block[key] < 0) failClosed(`PUBLIC_INTELLIGENCE_5K9_FAMILY_COUNT_INVALID:${family}.${key}`);
  }
  for (const key of ['firstObservedAt', 'lastObservedAt']) {
    if (!Number.isSafeInteger(block[key]) || block[key] < 0) failClosed(`PUBLIC_INTELLIGENCE_5K9_FAMILY_TIMESTAMP_INVALID:${family}.${key}`);
  }
  if (block.firstObservedAt > block.lastObservedAt) failClosed(`PUBLIC_INTELLIGENCE_5K9_FAMILY_TIME_INVERTED:${family}`);
  if (block.publishedAtAvailableCount + block.publishedAtMissingCount !== block.upstreamObservationCount) {
    failClosed(`PUBLIC_INTELLIGENCE_5K9_FAMILY_PUBLISHED_PARTITION:${family}`);
  }
  if (block.engagementObservationCount + block.engagementMissingCount !== block.upstreamObservationCount) {
    failClosed(`PUBLIC_INTELLIGENCE_5K9_FAMILY_ENGAGEMENT_PARTITION:${family}`);
  }
  const counters = Object.keys(block.engagement);
  if (canonical(counters) !== canonical([...PUBLIC_INTELLIGENCE_5K9_ENGAGEMENT_COUNTERS])) {
    failClosed(`PUBLIC_INTELLIGENCE_5K9_FAMILY_COUNTER_SET_DRIFT:${family}`);
  }
  for (const counter of counters) validateCounterSummary(counter, block.engagement[counter]);
  return block;
}

/** Closed-schema + fingerprint validation of one per-mint feature record. */
export function validateMintFeature(record) {
  const S = PUBLIC_INTELLIGENCE_5K9_MINT_FEATURE_SCHEMA;
  if (!record || typeof record !== 'object' || Array.isArray(record)) failClosed('PUBLIC_INTELLIGENCE_5K9_FEATURE_NOT_AN_OBJECT');
  for (const key of Object.keys(record)) {
    if (!S.fields.includes(key)) failClosed(`PUBLIC_INTELLIGENCE_5K9_FEATURE_UNKNOWN_FIELD:${String(key).slice(0, 48)}`);
  }
  for (const key of S.fields) if (!Object.hasOwn(record, key)) failClosed(`PUBLIC_INTELLIGENCE_5K9_FEATURE_FIELD_MISSING:${key}`);
  if (record.schemaVersion !== PUBLIC_INTELLIGENCE_5K9_SCHEMA_VERSION || record.recordType !== PUBLIC_INTELLIGENCE_5K9_MINT_FEATURE_RECORD_TYPE) {
    failClosed('PUBLIC_INTELLIGENCE_5K9_FEATURE_TYPE_INVALID');
  }
  if (typeof record.mint !== 'string' || !record.mint) failClosed('PUBLIC_INTELLIGENCE_5K9_FEATURE_MINT_INVALID');
  for (const key of S.countFields) {
    // An unassociated identity can only exist through a synthetic source, which
    // this layer never turns into a mint, so a mint record is never empty.
    if (!Number.isSafeInteger(record[key]) || record[key] < 0) failClosed(`PUBLIC_INTELLIGENCE_5K9_FEATURE_COUNT_INVALID:${key}`);
  }
  if (record.providerFamilyCount < 1 || record.upstreamObservationCount < 1) failClosed('PUBLIC_INTELLIGENCE_5K9_FEATURE_EMPTY_SUBJECT');
  if (!PUBLIC_INTELLIGENCE_5K9_COVERAGE_STATUS_VALUES.includes(record.coverageStatus)) failClosed('PUBLIC_INTELLIGENCE_5K9_FEATURE_COVERAGE_STATUS_INVALID');
  if (!PUBLIC_INTELLIGENCE_5K9_LINEAGE_COVERAGE_STATUS_VALUES.includes(record.lineageCoverageStatus)) failClosed('PUBLIC_INTELLIGENCE_5K9_FEATURE_LINEAGE_STATUS_INVALID');
  if (record.lineageCoverageStatus !== lineageCoverageStatusFor(record.contentLineageCount)) failClosed('PUBLIC_INTELLIGENCE_5K9_FEATURE_LINEAGE_STATUS_NE_COUNT');
  if (record.coverageStatus !== (record.providerFamilyCount >= 2
    ? PUBLIC_INTELLIGENCE_5K7_COVERAGE_STATUS.MULTI_PROVIDER_FAMILY
    : PUBLIC_INTELLIGENCE_5K7_COVERAGE_STATUS.SINGLE_PROVIDER_FAMILY)) {
    failClosed('PUBLIC_INTELLIGENCE_5K9_FEATURE_COVERAGE_STATUS_NE_FAMILY_COUNT');
  }
  if (record.providerNamespaceCount < record.providerFamilyCount) failClosed('PUBLIC_INTELLIGENCE_5K9_FEATURE_NAMESPACE_BELOW_FAMILY');
  if (record.memberRunCount < 1) failClosed('PUBLIC_INTELLIGENCE_5K9_FEATURE_MEMBER_RUN_COUNT_INVALID');
  for (const key of ['firstObservedAt', 'lastObservedAt']) {
    if (!Number.isSafeInteger(record[key]) || record[key] < 0) failClosed(`PUBLIC_INTELLIGENCE_5K9_FEATURE_TIMESTAMP_INVALID:${key}`);
  }
  if (record.firstObservedAt > record.lastObservedAt) failClosed('PUBLIC_INTELLIGENCE_5K9_FEATURE_TIME_INVERTED');
  if (record.observationWindowMs !== record.lastObservedAt - record.firstObservedAt) failClosed('PUBLIC_INTELLIGENCE_5K9_FEATURE_WINDOW_MISMATCH');
  if (record.publishedAtAvailableCount + record.publishedAtMissingCount !== record.upstreamObservationCount) {
    failClosed('PUBLIC_INTELLIGENCE_5K9_FEATURE_PUBLISHED_PARTITION');
  }
  if (record.engagementObservationCount + record.engagementMissingCount !== record.upstreamObservationCount) {
    failClosed('PUBLIC_INTELLIGENCE_5K9_FEATURE_ENGAGEMENT_PARTITION');
  }
  const families = Object.keys(record.providerFamilies);
  if (families.length !== record.providerFamilyCount) failClosed('PUBLIC_INTELLIGENCE_5K9_FEATURE_FAMILY_COUNT_MISMATCH');
  if (canonical(families) !== canonical([...families].sort())) failClosed('PUBLIC_INTELLIGENCE_5K9_FEATURE_FAMILY_ORDER_NONCANONICAL');
  let familyObservations = 0;
  for (const family of families) {
    validateFamilyBlock(family, record.providerFamilies[family]);
    familyObservations += record.providerFamilies[family].upstreamObservationCount;
  }
  if (familyObservations !== record.upstreamObservationCount) failClosed('PUBLIC_INTELLIGENCE_5K9_FEATURE_FAMILY_OBSERVATION_PARTITION');
  const buckets = record.temporalBuckets;
  if (!Array.isArray(buckets) || buckets.length === 0) failClosed('PUBLIC_INTELLIGENCE_5K9_FEATURE_BUCKETS_INVALID');
  let previousStart = -1;
  for (const bucket of buckets) {
    for (const key of Object.keys(bucket)) {
      if (!PUBLIC_INTELLIGENCE_5K9_TEMPORAL_BUCKET_SCHEMA.fields.includes(key)) failClosed(`PUBLIC_INTELLIGENCE_5K9_BUCKET_UNKNOWN_FIELD:${String(key).slice(0, 40)}`);
    }
    for (const key of PUBLIC_INTELLIGENCE_5K9_TEMPORAL_BUCKET_SCHEMA.fields) if (!Object.hasOwn(bucket, key)) failClosed(`PUBLIC_INTELLIGENCE_5K9_BUCKET_FIELD_MISSING:${key}`);
    if (bucket.bucketStart !== bucketStartOf(bucket.bucketStart)) failClosed('PUBLIC_INTELLIGENCE_5K9_BUCKET_NOT_ALIGNED');
    if (bucket.bucketEnd !== bucket.bucketStart + 900_000) failClosed('PUBLIC_INTELLIGENCE_5K9_BUCKET_WIDTH_INVALID');
    if (bucket.bucketStart <= previousStart) failClosed('PUBLIC_INTELLIGENCE_5K9_BUCKET_ORDER_NONCANONICAL');
    previousStart = bucket.bucketStart;
    for (const key of ['upstreamObservationCount', 'contentVersionCount', 'stateSnapshotCount']) {
      if (!Number.isSafeInteger(bucket[key]) || bucket[key] < 0) failClosed(`PUBLIC_INTELLIGENCE_5K9_BUCKET_COUNT_INVALID:${key}`);
    }
  }
  const missingness = record.missingness;
  for (const key of Object.keys(missingness)) {
    if (!PUBLIC_INTELLIGENCE_5K9_MISSINGNESS_SCHEMA.fields.includes(key)) failClosed(`PUBLIC_INTELLIGENCE_5K9_MISSINGNESS_UNKNOWN_FIELD:${String(key).slice(0, 40)}`);
  }
  for (const key of PUBLIC_INTELLIGENCE_5K9_MISSINGNESS_SCHEMA.fields) if (!Object.hasOwn(missingness, key)) failClosed(`PUBLIC_INTELLIGENCE_5K9_MISSINGNESS_FIELD_MISSING:${key}`);
  for (const category of PUBLIC_INTELLIGENCE_5K9_MISSINGNESS_CATEGORIES) {
    const pair = missingness[category];
    for (const key of Object.keys(pair)) {
      if (!PUBLIC_INTELLIGENCE_5K9_AVAILABILITY_SCHEMA.fields.includes(key)) failClosed(`PUBLIC_INTELLIGENCE_5K9_AVAILABILITY_UNKNOWN_FIELD:${category}.${String(key).slice(0, 32)}`);
    }
    for (const key of PUBLIC_INTELLIGENCE_5K9_AVAILABILITY_SCHEMA.fields) if (!Object.hasOwn(pair, key)) failClosed(`PUBLIC_INTELLIGENCE_5K9_AVAILABILITY_FIELD_MISSING:${category}.${key}`);
    if (!Number.isSafeInteger(pair.available) || pair.available < 0) failClosed(`PUBLIC_INTELLIGENCE_5K9_AVAILABILITY_INVALID:${category}.available`);
    if (!Number.isSafeInteger(pair.missing) || pair.missing < 0) failClosed(`PUBLIC_INTELLIGENCE_5K9_AVAILABILITY_INVALID:${category}.missing`);
    if (pair.available + pair.missing !== record.upstreamObservationCount) failClosed(`PUBLIC_INTELLIGENCE_5K9_AVAILABILITY_PARTITION:${category}`);
  }
  if (missingness.absentTreatedAsZero !== false) failClosed('PUBLIC_INTELLIGENCE_5K9_MISSINGNESS_ZERO_SUBSTITUTION_CLAIMED');
  if (missingness.observationSilentlyDropped !== false) failClosed('PUBLIC_INTELLIGENCE_5K9_MISSINGNESS_DROP_CLAIMED');
  if (canonical(record.classification) !== canonical(PUBLIC_INTELLIGENCE_CLASSIFICATION)) failClosed('PUBLIC_INTELLIGENCE_5K9_FEATURE_CLASSIFICATION_OVERRIDE_REFUSED');
  if (!FINGERPRINT.test(record.featureFingerprint)) failClosed('PUBLIC_INTELLIGENCE_5K9_FEATURE_FINGERPRINT_INVALID');
  if (record.featureFingerprint !== fingerprintOf(record, 'featureFingerprint')) failClosed('PUBLIC_INTELLIGENCE_5K9_FEATURE_FINGERPRINT_MISMATCH');
  return record;
}

/** The governed provider families of a feature record, for external checks. */
export const featureProviderFamilies = record => Object.keys(record.providerFamilies);
