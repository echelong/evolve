// Phase 5K.5 - TEMPORAL CORPUS: the cross-run derived index.
//
// PURE. Takes already AUTHENTICATED 5K.3 runs and produces a derived temporal
// index. No filesystem, no network, no clock. Every timestamp it emits is COPIED
// from an authenticated source record, so reconstruction can never invent one.
//
// WHAT CHANGES FROM 5K.4, AND WHAT DOES NOT
//
//   UNCHANGED: upstream identity is still EXACTLY (provider,
//   providerObservationId). A raw observation is never rewritten, merged away
//   or collapsed. Membership is still every run that saw the post.
//
//   CHANGED: a difference in content evidence is no longer automatically a
//   conflict. It is a revision when - and only when - the provider declared an
//   edit, and a conflict otherwise. A difference in mutable counters is not a
//   conflict at all; it is a second authenticated observation-state snapshot.
//
// "CANONICAL" IS ABOUT IDENTITY, NOT ABOUT SUPERSEDING
//
// The corpus emits ONE canonical content record per upstream identity, and that
// record is an identity anchor, not a mutation. Every authenticated version
// remains individually addressable and individually fingerprinted. There is no
// "latest wins", no "oldest wins", and no destructive update anywhere in this
// module.
import { canonical, digest, PUBLIC_INTELLIGENCE_CLASSIFICATION } from './definition.mjs';
import { failClosed } from './observation.mjs';
import {
  PUBLIC_INTELLIGENCE_5K5_SCHEMA_VERSION, upstreamIdentity5K5, rawObservationFingerprint, contentFingerprint5K5,
  observationStateFingerprint5K5, acquisitionFingerprint5K5,
} from './temporal-projection.mjs';
import { buildObservationState } from './observation-state.mjs';
import {
  PUBLIC_INTELLIGENCE_5K5_TEMPORAL_CLASSIFICATION as T, buildRevisionRecord,
  providerRevisionTimestampOf, classifyTemporal, indexRevisionEvidence,
} from './revision-chain.mjs';

/**
 * The accounting/analytics disclosure, stated as data so a test can assert it
 * without pattern-matching field names. These are declarations of absence, not
 * fields on any record: nothing in this module computes a score, a ranking, a
 * delta, a growth rate or any other judgement about a post.
 */
export const PUBLIC_INTELLIGENCE_5K5_CORPUS_SEMANTICS = Object.freeze({
  scoringApplied: false,
  rankingApplied: false,
  sentimentComputed: false,
  deltaComputed: false,
  growthRateComputed: false,
  velocityComputed: false,
  momentumComputed: false,
  popularityComputed: false,
  importanceComputed: false,
  predictionMade: false,
  tradingInferenceMade: false,
  winnerSelectedOnConflict: false,
  historyOverwritten: false,
  rawEvidenceMutated: false,
  observationStateUpdateIsDuplicate: false,
});

export const PUBLIC_INTELLIGENCE_5K5_CORPUS_RECORD_TYPE = 'public_temporal_content_record';
export const PUBLIC_INTELLIGENCE_5K5_OBSERVATION_RECORD_TYPE = 'public_temporal_observation_record';

const plain = value => JSON.parse(canonical(value));
const FINGERPRINT = /^[0-9a-f]{64}$/;
const byKey = key => (a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);

/**
 * DETERMINISTIC TEMPORAL ORDER.
 *
 * Primary key is the authenticated fetch instant - never a filesystem mtime,
 * never the current time, never directory enumeration order and never Map
 * insertion order. Identical timestamps are broken by the 5K.1 raw fingerprint
 * and then by run identity, both of which are content-addressed and therefore
 * stable across machines and rebuilds.
 */
export function compareTemporal(a, b) {
  if (a.fetchedAt !== b.fetchedAt) return a.fetchedAt < b.fetchedAt ? -1 : 1;
  if (a.rawObservationFingerprint !== b.rawObservationFingerprint) return a.rawObservationFingerprint < b.rawObservationFingerprint ? -1 : 1;
  return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;
}

/** The closed canonical content record schema. */
export const PUBLIC_INTELLIGENCE_5K5_CONTENT_RECORD_SCHEMA = Object.freeze({
  closed: true,
  fields: Object.freeze([
    'schemaVersion', 'recordType', 'upstreamIdentity', 'provider', 'providerObservationId',
    'contentFingerprint', 'publishedAt', 'firstSeenAt', 'lastSeenAt',
    'versionCount', 'revisionCount', 'observationCount', 'stateSnapshotCount', 'conflicted',
    'observationStateSnapshots', 'contentVersions', 'revisionChain',
    'memberRunIds', 'memberRunManifestFingerprints',
    'assetAssociation', 'missingness', 'classification', 'contentRecordFingerprint',
  ]),
  versionFields: Object.freeze(['versionIndex', 'contentFingerprint', 'rawObservationFingerprint', 'fetchedAt', 'runId', 'classification']),
});

/** The closed per-observation record schema. */
export const PUBLIC_INTELLIGENCE_5K5_OBSERVATION_RECORD_SCHEMA = Object.freeze({
  closed: true,
  fields: Object.freeze([
    'schemaVersion', 'recordType', 'upstreamIdentity', 'provider', 'providerObservationId',
    'contentFingerprint', 'rawObservationFingerprint', 'normalizedObservationFingerprint',
    'observationStateFingerprint', 'acquisitionFingerprint',
    'runId', 'runManifestFingerprint', 'fetchedAt', 'observedAt', 'publishedAt',
    'temporalClassification', 'providerRevisionTimestamp',
    'assetAssociation', 'classification', 'observationRecordFingerprint',
  ]),
});

const fingerprintOf = (record, field) => { const body = { ...record }; delete body[field]; return digest(body); };

// ---------------------------------------------------------------------------
// BUILD
// ---------------------------------------------------------------------------

/**
 * Builds the temporal corpus index from AUTHENTICATED runs.
 *
 * runs: [{ manifest, observations: [envelope...] }] in any order.
 *
 * Returns { contentRecords, observationRecords, states, revisions, accounting }.
 * Canonical JSON everywhere, arrays sorted, nothing dependent on input order.
 */
export function buildTemporalCorpus(runs, { revisionEvidence = [] } = {}) {
  // 0. Index the additive revision-evidence sidecars, bound to raw fingerprints.
  //    Records captured before 5K.5 simply have none, and stay conservative.
  const preliminary = [];
  for (const run of runs) for (const envelope of run.observations) preliminary.push(rawObservationFingerprint(envelope.raw));
  const revisionIndex = indexRevisionEvidence(revisionEvidence, new Set(preliminary));

  // 1. Flatten every authenticated observation into one deterministic stream.
  const appearances = [];
  for (const run of runs) {
    for (const envelope of run.observations) {
      const raw = envelope.raw;
      const normalized = envelope.normalized;
      appearances.push({
        raw,
        normalized,
        runId: run.manifest.runId,
        runManifestFingerprint: run.manifest.manifestFingerprint,
        upstreamIdentity: upstreamIdentity5K5(raw),
        provider: raw.provider,
        providerObservationId: raw.providerObservationId,
        // 5K.1's raw fingerprint, untouched and authoritative.
        rawObservationFingerprint: rawObservationFingerprint(raw),
        normalizedObservationFingerprint: digest(normalized),
        contentFingerprint: contentFingerprint5K5(raw),
        observationStateFingerprint: observationStateFingerprint5K5(raw),
        acquisitionFingerprint: acquisitionFingerprint5K5(raw),
        fetchedAt: raw.fetchedAt,
        observedAt: raw.observedAt ?? null,
        publishedAt: raw.publishedAt ?? null,
        providerRevisionTimestamp: providerRevisionTimestampOf(revisionIndex, rawObservationFingerprint(raw)),
        assetAssociation: {
          status: normalized.assetAssociation.status,
          mint: normalized.assetAssociation.mint,
          method: normalized.assetAssociation.method,
        },
        missingness: normalized.missingness,
      });
    }
  }

  // 2. Group by upstream identity. Never across identities, never across providers.
  const groups = new Map();
  for (const appearance of appearances) {
    if (!groups.has(appearance.upstreamIdentity)) groups.set(appearance.upstreamIdentity, []);
    groups.get(appearance.upstreamIdentity).push(appearance);
  }

  const contentRecords = [];
  const observationRecords = [];
  const states = [];
  const revisions = [];

  for (const upstreamIdentity of [...groups.keys()].sort()) {
    const ordered = groups.get(upstreamIdentity).sort(compareTemporal);

    // 3. Walk the chain in temporal order, assigning a classification to each
    //    authenticated acquisition.
    const seenStates = new Set();
    const versions = [];
    let previous = null;
    const observations = [];
    for (const appearance of ordered) {
      const classification = classifyTemporal(previous, appearance);
      const state = buildObservationState(appearance.raw, {
        runId: appearance.runId, runManifestFingerprint: appearance.runManifestFingerprint,
      });
      states.push(state);
      if (!seenStates.has(appearance.observationStateFingerprint)) seenStates.add(appearance.observationStateFingerprint);
      observations.push({ appearance, classification, state });
      previous = {
        contentFingerprint: appearance.contentFingerprint,
        observationStateFingerprint: appearance.observationStateFingerprint,
        fetchedAt: appearance.fetchedAt,
        providerRevisionTimestamp: appearance.providerRevisionTimestamp,
      };
    }

    // 4. Content versions are DISTINCT content fingerprints in first-seen order.
    //    Every version is retained; none overwrites another.
    const versionIndexByContent = new Map();
    for (const { appearance, classification } of observations) {
      if (!versionIndexByContent.has(appearance.contentFingerprint)) {
        versionIndexByContent.set(appearance.contentFingerprint, versions.length);
        versions.push({
          versionIndex: versions.length,
          contentFingerprint: appearance.contentFingerprint,
          rawObservationFingerprint: appearance.rawObservationFingerprint,
          fetchedAt: appearance.fetchedAt,
          runId: appearance.runId,
          classification,
        });
      }
    }

    // 5. The revision chain. A chain that contains ANY unverified divergence is
    //    not a chain: it is a conflict, and no version is discarded.
    const head = observations[0].appearance;
    const chainRecords = [];
    for (let index = 0; index < versions.length; index += 1) {
      const version = versions[index];
      const superseding = observations.find(({ appearance }) => appearance.contentFingerprint === version.contentFingerprint);
      const previousVersion = index === 0 ? null : versions[index - 1];
      chainRecords.push(buildRevisionRecord({
        upstreamIdentity,
        provider: head.provider,
        providerObservationId: head.providerObservationId,
        versionIndex: index,
        contentFingerprint: version.contentFingerprint,
        rawObservationFingerprint: version.rawObservationFingerprint,
        // The FIRST version is not a revision and therefore carries no revision
        // timestamp, even if the provider has since edited the post.
        providerRevisionTimestamp: index === 0 ? null : superseding.appearance.providerRevisionTimestamp,
        runId: version.runId,
        runManifestFingerprint: head.runManifestFingerprint,
        fetchedAt: version.fetchedAt,
        supersedesContentFingerprint: previousVersion === null ? null : previousVersion.contentFingerprint,
      }));
    }
    revisions.push(...chainRecords);

    // 6. A conflict is any identity carrying at least one UNVERIFIED divergence.
    const hasConflict = observations.some(({ classification }) => classification === T.UNVERIFIED_CONTENT_DIVERGENCE);

    for (const { appearance, classification } of observations) {
      const observationBody = {
        schemaVersion: PUBLIC_INTELLIGENCE_5K5_SCHEMA_VERSION,
        recordType: PUBLIC_INTELLIGENCE_5K5_OBSERVATION_RECORD_TYPE,
        upstreamIdentity,
        provider: appearance.provider,
        providerObservationId: appearance.providerObservationId,
        contentFingerprint: appearance.contentFingerprint,
        rawObservationFingerprint: appearance.rawObservationFingerprint,
        normalizedObservationFingerprint: appearance.normalizedObservationFingerprint,
        observationStateFingerprint: appearance.observationStateFingerprint,
        acquisitionFingerprint: appearance.acquisitionFingerprint,
        runId: appearance.runId,
        runManifestFingerprint: appearance.runManifestFingerprint,
        fetchedAt: appearance.fetchedAt,
        observedAt: appearance.observedAt,
        publishedAt: appearance.publishedAt,
        temporalClassification: classification,
        providerRevisionTimestamp: appearance.providerRevisionTimestamp,
        assetAssociation: appearance.assetAssociation,
        classification: PUBLIC_INTELLIGENCE_CLASSIFICATION,
      };
      observationRecords.push(plain({ ...observationBody, observationRecordFingerprint: digest(observationBody) }));
    }

    // 7. The canonical content record: ONE per upstream identity. It anchors a
    //    stable content identity; it does not supersede any version.
    const body = {
      schemaVersion: PUBLIC_INTELLIGENCE_5K5_SCHEMA_VERSION,
      recordType: PUBLIC_INTELLIGENCE_5K5_CORPUS_RECORD_TYPE,
      upstreamIdentity,
      provider: head.provider,
      providerObservationId: head.providerObservationId,
      contentFingerprint: head.contentFingerprint,
      publishedAt: head.publishedAt,
      firstSeenAt: ordered[0].fetchedAt,
      lastSeenAt: ordered[ordered.length - 1].fetchedAt,
      versionCount: versions.length,
      revisionCount: versions.length - 1,
      observationCount: ordered.length,
      stateSnapshotCount: seenStates.size,
      observationStateSnapshots: [...seenStates].sort(),
      contentVersions: versions,
      revisionChain: chainRecords.map(record => ({
        versionIndex: record.versionIndex,
        contentFingerprint: record.contentFingerprint,
        supersedesContentFingerprint: record.supersedesContentFingerprint,
        providerRevisionTimestamp: record.providerRevisionTimestamp,
        revisionFingerprint: record.revisionFingerprint,
      })),
      // Whether this identity is conflicted. Recorded, never acted upon: no version
      // is dropped, merged or deprioritised because of it.
      conflicted: hasConflict,
      memberRunIds: [...new Set(ordered.map(a => a.runId))].sort(),
      memberRunManifestFingerprints: [...new Set(ordered.map(a => a.runManifestFingerprint))].sort(),
      // Copied verbatim from verified normalized evidence. Never inferred, never
      // altered, and never influenced by an engagement counter.
      assetAssociation: head.assetAssociation,
      missingness: head.missingness,
      classification: PUBLIC_INTELLIGENCE_CLASSIFICATION,
    };
    contentRecords.push(plain({ ...body, contentRecordFingerprint: digest(body) }));
  }

  contentRecords.sort(byKey('upstreamIdentity'));
  observationRecords.sort((a, b) => (a.upstreamIdentity < b.upstreamIdentity ? -1 : a.upstreamIdentity > b.upstreamIdentity ? 1 : compareTemporal(a, b)));
  states.sort((a, b) => (a.upstreamIdentity < b.upstreamIdentity ? -1 : a.upstreamIdentity > b.upstreamIdentity ? 1 : compareTemporal(a, b)));
  revisions.sort((a, b) => (a.upstreamIdentity < b.upstreamIdentity ? -1 : a.upstreamIdentity > b.upstreamIdentity ? 1 : a.versionIndex - b.versionIndex));

  return Object.freeze({
    contentRecords: Object.freeze(contentRecords),
    observationRecords: Object.freeze(observationRecords),
    states: Object.freeze(states),
    revisions: Object.freeze(revisions),
    accounting: computeTemporalAccounting({ contentRecords, observationRecords, states, revisions }),
  });
}

// ---------------------------------------------------------------------------
// SNAPSHOT ACCOUNTING
// ---------------------------------------------------------------------------

/**
 * Temporal accounting. These numbers describe WHAT WAS COLLECTED and how the
 * evidence relates across runs. They are not popularity, importance, sentiment,
 * momentum or market relevance, and no downstream consumer may treat them as
 * such.
 *
 * A CRUCIAL WORDING RULE: an observation-state update is NOT a duplicate. A
 * second run that saw the same post with a different counter value carries
 * newly observed state and is counted as a state snapshot, never as a
 * redundant appearance.
 */
export function computeTemporalAccounting({ contentRecords, observationRecords, states, revisions }) {
  const classificationCounts = {};
  for (const name of Object.values(T)) classificationCounts[name] = 0;
  let conflictedIdentities = 0;
  for (const record of contentRecords) {
    // Conflicted means: some version BEYOND the first has no provider-declared
    // proof. Version 0 is never a revision and so never carries a timestamp.
    const unproven = record.revisionChain
      .filter(entry => entry.supersedesContentFingerprint !== null)
      .some(entry => entry.providerRevisionTimestamp === null);
    if (unproven) conflictedIdentities += 1;
  }
  // Mint association is counted per distinct CONTENT VERSION, not per identity:
  // a revision that changes explicit mint evidence yields two versions with two
  // associations, and neither is rewritten into the other.
  let associatedVersionCount = 0;
  let unassociatedVersionCount = 0;
  let invalidMintVersionCount = 0;
  let ambiguousVersionCount = 0;
  const countedVersions = new Set();
  for (const record of observationRecords) {
    const versionKey = `${record.upstreamIdentity}|${record.contentFingerprint}`;
    if (countedVersions.has(versionKey)) continue;
    countedVersions.add(versionKey);
    const association = record.assetAssociation.status;
    if (association === 'EXACT_MINT') associatedVersionCount += 1;
    else if (association === 'UNASSOCIATED') unassociatedVersionCount += 1;
    else if (association === 'INVALID_MINT') invalidMintVersionCount += 1;
    else if (association === 'AMBIGUOUS') ambiguousVersionCount += 1;
  }
  for (const record of observationRecords) {
    classificationCounts[record.temporalClassification] += 1;
  }
  const identityCount = contentRecords.length;
  const versionCount = contentRecords.reduce((sum, record) => sum + record.versionCount, 0);
  const observationCount = observationRecords.length;
  const stateSnapshotCount = states.length;
  const uniqueStateFingerprints = new Set(states.map(state => state.observationStateFingerprint)).size;
  const revisionCount = revisions.filter(record => record.versionIndex > 0).length;
  const providerDeclaredRevisionCount = classificationCounts[T.PROVIDER_DECLARED_CONTENT_REVISION] ?? 0;
  // Every declared revision must correspond to exactly one chain link, and every
  // unproven link must correspond to exactly one divergence.

  const unverifiedDivergenceCount = classificationCounts[T.UNVERIFIED_CONTENT_DIVERGENCE] ?? 0;
  // A duplicate appearance is one that adds NO new information at all: not a new
  // content version, not a new observation state, not a new membership.
  const duplicateAppearances = observationCount
    - (classificationCounts[T.FIRST_OBSERVATION] ?? 0)
    - (classificationCounts[T.SAME_CONTENT_UPDATED_STATE] ?? 0)
    - (classificationCounts[T.PROVIDER_DECLARED_CONTENT_REVISION] ?? 0)
    - (classificationCounts[T.UNVERIFIED_CONTENT_DIVERGENCE] ?? 0);
  return plain({
    runCount: null,
    upstreamIdentityCount: identityCount,
    contentVersionCount: versionCount,
    observationRecordCount: observationCount,
    observationStateSnapshotCount: stateSnapshotCount,
    distinctObservationStateFingerprints: uniqueStateFingerprints,
    firstObservationCount: classificationCounts[T.FIRST_OBSERVATION] ?? 0,
    sameContentSameStateCount: classificationCounts[T.SAME_CONTENT_SAME_STATE] ?? 0,
    sameContentUpdatedStateCount: classificationCounts[T.SAME_CONTENT_UPDATED_STATE] ?? 0,
    providerDeclaredRevisionCount,
    unverifiedDivergenceCount,
    revisionChainLinkCount: revisionCount,
    duplicateAppearanceCount: duplicateAppearances,
    conflictedUpstreamIdentityCount: conflictedIdentities,
    associatedVersionCount,
    unassociatedVersionCount,
    invalidMintVersionCount,
    ambiguousVersionCount,
    temporalClassificationCounts: classificationCounts,
  });
}

/**
 * The accounting equations. Every one is an identity over the derived records,
 * so any drift between the records and the summary is a hard failure rather
 * than a silently reconciled number.
 */
export function checkTemporalAccounting(accounting, { contentRecords, observationRecords, states }) {
  const problems = [];
  const check = (condition, code) => { if (!condition) problems.push(code); };
  const A = accounting;
  check(A.upstreamIdentityCount === contentRecords.length, 'ACCOUNTING_UPSTREAM_IDENTITY_DRIFT');
  check(A.contentVersionCount === contentRecords.reduce((sum, r) => sum + r.versionCount, 0), 'ACCOUNTING_CONTENT_VERSION_DRIFT');
  check(A.observationRecordCount === observationRecords.length, 'ACCOUNTING_OBSERVATION_DRIFT');
  check(A.observationStateSnapshotCount === states.length, 'ACCOUNTING_STATE_SNAPSHOT_DRIFT');
  // Every observation is either the identity's first, or a same-content
  // repeat, a same-content state update, a declared revision, or a conflict.
  check(A.sameContentSameStateCount + A.sameContentUpdatedStateCount
    + A.providerDeclaredRevisionCount + A.unverifiedDivergenceCount
    === A.observationRecordCount - A.firstObservationCount, 'ACCOUNTING_POST_FIRST_DECOMPOSITION');
  const classified = Object.values(A.temporalClassificationCounts).reduce((sum, n) => sum + n, 0);
  check(classified === A.observationRecordCount, 'ACCOUNTING_CLASSIFICATION_PARTITION');
  // One first observation per upstream identity, exactly.
  check(A.firstObservationCount === A.upstreamIdentityCount, 'ACCOUNTING_FIRST_OBSERVATION_NOT_ONE_PER_IDENTITY');
  // Declared revisions are exactly the proven links in the chains.
  check(A.providerDeclaredRevisionCount === (A.revisionChainLinkCount - A.unverifiedDivergenceCount), 'ACCOUNTING_DECLARED_REVISION_CHAIN_MISMATCH');
  check(A.providerDeclaredRevisionCount + A.unverifiedDivergenceCount === A.revisionChainLinkCount, 'ACCOUNTING_CHAIN_LINK_COVERAGE');
  // Each identity contributes at least one version; versions are never merged away.
  check(A.contentVersionCount >= A.upstreamIdentityCount, 'ACCOUNTING_VERSIONS_BELOW_IDENTITIES');
  // A state snapshot exists for every observation.
  check(A.observationStateSnapshotCount === A.observationRecordCount, 'ACCOUNTING_STATE_SNAPSHOT_PER_OBSERVATION');
  // Duplicate appearances can never be negative or exceed the total.
  check(A.duplicateAppearanceCount >= 0 && A.duplicateAppearanceCount <= A.observationRecordCount, 'ACCOUNTING_DUPLICATE_RANGE');
  // Every content version carries exactly one inherited mint association status.
  check(A.associatedVersionCount + A.unassociatedVersionCount + A.invalidMintVersionCount
    + A.ambiguousVersionCount === A.contentVersionCount, 'ACCOUNTING_ASSOCIATION_COVERS_EVERY_VERSION');
  check(A.firstObservationCount + A.duplicateAppearanceCount + A.sameContentUpdatedStateCount
    + A.providerDeclaredRevisionCount + A.unverifiedDivergenceCount === A.observationRecordCount, 'ACCOUNTING_OBSERVATION_DECOMPOSITION');
  return Object.freeze({ ok: problems.length === 0, problems: Object.freeze(problems) });
}

/** Closed-schema + fingerprint validation of one stored content record. */
export function validateContentRecord(record) {
  const S = PUBLIC_INTELLIGENCE_5K5_CONTENT_RECORD_SCHEMA;
  if (!record || typeof record !== 'object' || Array.isArray(record)) failClosed('PUBLIC_INTELLIGENCE_5K5_CONTENT_NOT_AN_OBJECT');
  for (const key of Object.keys(record)) if (!S.fields.includes(key)) failClosed(`PUBLIC_INTELLIGENCE_5K5_CONTENT_UNKNOWN_FIELD:${String(key).slice(0, 40)}`);
  for (const key of S.fields) if (!Object.hasOwn(record, key)) failClosed(`PUBLIC_INTELLIGENCE_5K5_CONTENT_FIELD_MISSING:${key}`);
  if (record.schemaVersion !== PUBLIC_INTELLIGENCE_5K5_SCHEMA_VERSION || record.recordType !== PUBLIC_INTELLIGENCE_5K5_CORPUS_RECORD_TYPE) failClosed('PUBLIC_INTELLIGENCE_5K5_CONTENT_TYPE_INVALID');
  for (const key of ['contentFingerprint', 'contentRecordFingerprint']) if (!FINGERPRINT.test(record[key])) failClosed(`PUBLIC_INTELLIGENCE_5K5_CONTENT_FINGERPRINT_INVALID:${key}`);
  for (const version of record.contentVersions) {
    for (const key of Object.keys(version)) if (!S.versionFields.includes(key)) failClosed(`PUBLIC_INTELLIGENCE_5K5_CONTENT_VERSION_UNKNOWN_FIELD:${String(key).slice(0, 40)}`);
    for (const key of S.versionFields) if (!Object.hasOwn(version, key)) failClosed(`PUBLIC_INTELLIGENCE_5K5_CONTENT_VERSION_FIELD_MISSING:${key}`);
    if (!Object.values(T).includes(version.classification)) failClosed('PUBLIC_INTELLIGENCE_5K5_CONTENT_VERSION_CLASSIFICATION_INVALID');
  }
  if (record.contentVersions.length !== record.versionCount) failClosed('PUBLIC_INTELLIGENCE_5K5_CONTENT_VERSION_COUNT_MISMATCH');
  if (record.revisionChain.length !== record.versionCount) failClosed('PUBLIC_INTELLIGENCE_5K5_CONTENT_CHAIN_LENGTH_MISMATCH');
  if (canonical(record.classification) !== canonical(PUBLIC_INTELLIGENCE_CLASSIFICATION)) failClosed('PUBLIC_INTELLIGENCE_5K5_CONTENT_CLASSIFICATION_OVERRIDE_REFUSED');
  if (record.contentRecordFingerprint !== fingerprintOf(record, 'contentRecordFingerprint')) failClosed('PUBLIC_INTELLIGENCE_5K5_CONTENT_FINGERPRINT_MISMATCH');
  return record;
}

/** Closed-schema + fingerprint validation of one stored observation record. */
export function validateObservationRecord(record) {
  const S = PUBLIC_INTELLIGENCE_5K5_OBSERVATION_RECORD_SCHEMA;
  if (!record || typeof record !== 'object' || Array.isArray(record)) failClosed('PUBLIC_INTELLIGENCE_5K5_OBS_OBSERVATION_NOT_AN_OBJECT');
  for (const key of Object.keys(record)) if (!S.fields.includes(key)) failClosed(`PUBLIC_INTELLIGENCE_5K5_OBS_OBSERVATION_UNKNOWN_FIELD:${String(key).slice(0, 40)}`);
  for (const key of S.fields) if (!Object.hasOwn(record, key)) failClosed(`PUBLIC_INTELLIGENCE_5K5_OBS_OBSERVATION_FIELD_MISSING:${key}`);
  if (record.temporalClassification !== null && !Object.values(T).includes(record.temporalClassification)) {
    failClosed('PUBLIC_INTELLIGENCE_5K5_OBS_OBSERVATION_CLASSIFICATION_INVALID');
  }
  if (canonical(record.classification) !== canonical(PUBLIC_INTELLIGENCE_CLASSIFICATION)) failClosed('PUBLIC_INTELLIGENCE_5K5_OBS_OBSERVATION_CLASSIFICATION_OVERRIDE_REFUSED');
  if (record.observationRecordFingerprint !== fingerprintOf(record, 'observationRecordFingerprint')) failClosed('PUBLIC_INTELLIGENCE_5K5_OBS_OBSERVATION_FINGERPRINT_MISMATCH');
  return record;
}
