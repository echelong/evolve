// Phase 5K.7 - CORROBORATION SNAPSHOT: closed manifest, deterministic identity,
// and write-once storage of an immutable cross-provider coverage view.
//
// IDENTITY vs AUTHENTICATION (kept deliberately separate, exactly as 5K.4/5K.5):
//   snapshotId          = "crsnap-" + first 32 hex of SHA-256(canonical{
//                           kind, corroborationPolicyVersion,
//                           temporalPolicyVersion, corpusPolicyVersion,
//                           eligibleStatuses, sorted runManifestFingerprints }).
//                         Same authenticated source set + same policy => same id,
//                         regardless of run order, discovery order or build time.
//                         `createdAt` does NOT participate.
//   snapshotFingerprint = SHA-256 of the complete canonical manifest minus that
//                         field. It DOES cover createdAt: it authenticates this
//                         particular persisted artifact.
//
// THE SOURCE IS AUTHENTICATED EVIDENCE, AND IT IS RECORDED IN FULL.
//
// The reproducible content is derived by re-authenticating every member RUN and
// rebuilding the verified 5K.5 temporal index from it. Because the temporal
// layer's classification depends on the provider-declared revision evidence it
// was given, that evidence is stored WITH the snapshot as a source artifact: a
// rebuild in the verifier therefore reproduces the exact same temporal index
// rather than an approximation of it. Nothing in the revision evidence is any
// richer than a bound raw fingerprint and a provider-declared edit timestamp.
//
// Storage lives under `corroboration-corpora/`, its own namespace, and never
// touches a run directory and never writes under .evolve.
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { canonical, digest, PUBLIC_INTELLIGENCE_CLASSIFICATION, isValidTimestamp } from './definition.mjs';
import { failClosed } from './observation.mjs';
import { assertSafeRuntimeRoot } from './run-store.mjs';
import { validateCorpusPolicy, PUBLIC_INTELLIGENCE_5K4_DEFAULT_POLICY } from './corpus-membership.mjs';
import { PUBLIC_INTELLIGENCE_5K5_TEMPORAL_POLICY_VERSION } from './temporal-projection.mjs';
import { assembleTemporalContent, authenticateRuns, deriveTemporalSnapshotId } from './temporal-snapshot.mjs';
import {
  PUBLIC_INTELLIGENCE_5K7_PHASE, PUBLIC_INTELLIGENCE_5K7_SCHEMA_VERSION,
  PUBLIC_INTELLIGENCE_5K7_POLICY_VERSION, PUBLIC_INTELLIGENCE_5K7_RECORD_TYPES,
  PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_COVERAGE_CLASSIFICATION_VALUES,
  PUBLIC_INTELLIGENCE_5K7_PROVIDER_FAMILIES, snapshotCoverageClassificationFor,
} from './corroboration-definition.mjs';
import { buildCorroborationIndex, checkCorroborationAggregate } from './corroboration-index.mjs';

export const PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_RECORD_TYPE = PUBLIC_INTELLIGENCE_5K7_RECORD_TYPES.SNAPSHOT;
export const PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_FILES = Object.freeze({
  coverage: 'coverage.ndjson',
  observationCoverage: 'observation-coverage.ndjson',
  revisionEvidence: 'source-revision-evidence.ndjson',
  snapshot: 'corroboration-snapshot.json',
});

const SNAPSHOT_ID = /^crsnap-[0-9a-f]{32}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;

export const PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_SCHEMA = Object.freeze({
  closed: true,
  fields: Object.freeze([
    'schemaVersion', 'recordType', 'phase', 'snapshotId',
    'corroborationPolicyVersion', 'temporalPolicyVersion', 'corpusPolicyVersion', 'eligibleStatuses',
    'sourceCorpusFingerprint', 'sourceTemporalSnapshotId', 'sourceTemporalFingerprint', 'sourceRevisionEvidenceFingerprint',
    'sourceRunManifestFingerprints', 'memberRunIds', 'createdAt',
    'upstreamIdentityCount', 'exactMintCount',
    'singleProviderFamilyMintCount', 'multiProviderFamilyMintCount',
    'providerFamilyCounts', 'providerNamespaceCounts',
    'exactMintObservationCount', 'unassociatedObservationCount', 'invalidMintObservationCount', 'ambiguousObservationCount',
    'earliestObservedAt', 'latestObservedAt', 'coverageClassification',
    'coverageDigest', 'recordsDigest', 'observationCoverageDigest', 'classification', 'snapshotFingerprint',
  ]),
  countFields: Object.freeze([
    'upstreamIdentityCount', 'exactMintCount', 'singleProviderFamilyMintCount', 'multiProviderFamilyMintCount',
    'exactMintObservationCount', 'unassociatedObservationCount', 'invalidMintObservationCount', 'ambiguousObservationCount',
  ]),
  digestFields: Object.freeze(['coverageDigest', 'recordsDigest', 'observationCoverageDigest']),
  sourceFingerprintFields: Object.freeze(['sourceCorpusFingerprint', 'sourceTemporalFingerprint', 'sourceRevisionEvidenceFingerprint']),
  nullableTimestampFields: Object.freeze(['earliestObservedAt', 'latestObservedAt']),
});

const plain = value => JSON.parse(canonical(value));

/** Deterministic identity: policy + sorted run manifest fingerprints. No time. */
export function deriveCorroborationSnapshotId(policyInput, runManifestFingerprints) {
  const policy = validateCorpusPolicy(policyInput);
  const sorted = [...runManifestFingerprints].sort();
  for (const fp of sorted) {
    if (!FINGERPRINT.test(fp)) failClosed('PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_ID_FINGERPRINT_INVALID');
  }
  if (new Set(sorted).size !== sorted.length) failClosed('PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_ID_DUPLICATE_RUN');
  return `crsnap-${digest({
    kind: 'public_corroboration_snapshot_identity',
    corroborationPolicyVersion: PUBLIC_INTELLIGENCE_5K7_POLICY_VERSION,
    temporalPolicyVersion: PUBLIC_INTELLIGENCE_5K5_TEMPORAL_POLICY_VERSION,
    corpusPolicyVersion: policy.corpusPolicyVersion,
    eligibleStatuses: policy.eligibleStatuses,
    runManifestFingerprints: sorted,
  }).slice(0, 32)}`;
}

export const corroborationSnapshotFingerprintOf = manifest => {
  const body = { ...manifest };
  delete body.snapshotFingerprint;
  return digest(body);
};

/**
 * Pure assembly of the reproducible corroboration content from authenticated
 * runs. It reuses the untouched 5K.5 temporal assembly, so 5K.7 adds no parallel
 * evidence pipeline and no second normalization path.
 */
export function assembleCorroborationContent(authenticated, policyInput = PUBLIC_INTELLIGENCE_5K4_DEFAULT_POLICY, revisionEvidence = []) {
  const policy = validateCorpusPolicy(policyInput);
  if (!Array.isArray(revisionEvidence)) failClosed('PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_REVISION_EVIDENCE_INVALID');
  const temporal = assembleTemporalContent(authenticated, policy, revisionEvidence);
  const runManifestFingerprints = temporal.memberships.map(member => member.runManifestFingerprint);
  const sourceTemporalSnapshotId = deriveTemporalSnapshotId(policy, runManifestFingerprints);
  const sourceTemporalFingerprint = digest({
    kind: 'public_corroboration_temporal_source',
    contentDigest: temporal.contentDigest,
    observationDigest: temporal.observationDigest,
    stateDigest: temporal.stateDigest,
    revisionDigest: temporal.revisionDigest,
  });
  const index = buildCorroborationIndex(
    { contentRecords: temporal.contentRecords, observationRecords: temporal.observationRecords },
    { sourceSnapshotIds: [sourceTemporalSnapshotId] },
  );
  const content = {
    policy,
    memberships: temporal.memberships,
    // Kept for pure order-invariance tests; never written to any artifact.
    temporalRecords: { contentRecords: temporal.contentRecords, observationRecords: temporal.observationRecords },
    coverageRecords: index.coverageRecords,
    observationCoverageRecords: index.observationCoverageRecords,
    aggregate: index.aggregate,
    revisionEvidence: [...revisionEvidence],
    sourceTemporalSnapshotId,
    sourceTemporalFingerprint,
    sourceCorpusFingerprint: digest(temporal.memberships),
    sourceRevisionEvidenceFingerprint: digest(revisionEvidence),
    coverageDigest: digest(index.aggregate),
    recordsDigest: digest(index.coverageRecords),
    observationCoverageDigest: digest(index.observationCoverageRecords),
  };
  return Object.freeze(content);
}

/** Authenticates the runs and assembles the content. Offline; reads run directories only. */
export function rebuildCorroborationSnapshot({ root, runIds, policy = PUBLIC_INTELLIGENCE_5K4_DEFAULT_POLICY, revisionEvidence = [] }) {
  return assembleCorroborationContent(authenticateRuns(root, runIds, policy), policy, revisionEvidence);
}

/** Builds the closed snapshot manifest. `createdAt` is execution metadata only. */
export function buildSnapshotManifest(content, createdAt) {
  if (!isValidTimestamp(createdAt)) failClosed('PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_CREATED_AT_INVALID');
  const A = content.aggregate;
  const runManifestFingerprints = content.memberships.map(member => member.runManifestFingerprint);
  const body = {
    schemaVersion: PUBLIC_INTELLIGENCE_5K7_SCHEMA_VERSION,
    recordType: PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_RECORD_TYPE,
    phase: PUBLIC_INTELLIGENCE_5K7_PHASE,
    snapshotId: deriveCorroborationSnapshotId(content.policy, runManifestFingerprints),
    corroborationPolicyVersion: PUBLIC_INTELLIGENCE_5K7_POLICY_VERSION,
    temporalPolicyVersion: PUBLIC_INTELLIGENCE_5K5_TEMPORAL_POLICY_VERSION,
    corpusPolicyVersion: content.policy.corpusPolicyVersion,
    eligibleStatuses: [...content.policy.eligibleStatuses],
    sourceCorpusFingerprint: content.sourceCorpusFingerprint,
    sourceTemporalSnapshotId: content.sourceTemporalSnapshotId,
    sourceTemporalFingerprint: content.sourceTemporalFingerprint,
    sourceRevisionEvidenceFingerprint: content.sourceRevisionEvidenceFingerprint,
    sourceRunManifestFingerprints: [...runManifestFingerprints].sort(),
    memberRunIds: content.memberships.map(member => member.runId).sort(),
    createdAt,
    upstreamIdentityCount: A.upstreamIdentityCount,
    exactMintCount: A.exactMintCount,
    singleProviderFamilyMintCount: A.singleProviderFamilyMintCount,
    multiProviderFamilyMintCount: A.multiProviderFamilyMintCount,
    providerFamilyCounts: A.providerFamilyCounts,
    providerNamespaceCounts: A.providerNamespaceCounts,
    exactMintObservationCount: A.exactMintObservationCount,
    unassociatedObservationCount: A.unassociatedObservationCount,
    invalidMintObservationCount: A.invalidMintObservationCount,
    ambiguousObservationCount: A.ambiguousObservationCount,
    earliestObservedAt: A.earliestObservedAt,
    latestObservedAt: A.latestObservedAt,
    coverageClassification: snapshotCoverageClassificationFor(A.exactMintCount),
    coverageDigest: content.coverageDigest,
    recordsDigest: content.recordsDigest,
    observationCoverageDigest: content.observationCoverageDigest,
    classification: PUBLIC_INTELLIGENCE_CLASSIFICATION,
  };
  const manifest = plain({ ...body, snapshotFingerprint: digest(body) });
  validateSnapshotManifest(manifest);
  const problems = checkCorroborationAggregate(A, {
    observationCoverageRecords: content.observationCoverageRecords, coverageRecords: content.coverageRecords,
  });
  if (!problems.ok) failClosed(`PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_ACCOUNTING_INCONSISTENT:${problems.problems[0]}`);
  return manifest;
}

/** Closed-schema + fingerprint-format validation of the stored manifest. */
export function validateSnapshotManifest(manifest) {
  const S = PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_SCHEMA;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) failClosed('PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_NOT_AN_OBJECT');
  for (const key of Object.keys(manifest)) {
    if (!S.fields.includes(key)) failClosed(`PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_UNKNOWN_FIELD:${String(key).slice(0, 48)}`);
  }
  for (const key of S.fields) {
    if (!Object.hasOwn(manifest, key)) failClosed(`PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_FIELD_MISSING:${key}`);
  }
  if (manifest.schemaVersion !== PUBLIC_INTELLIGENCE_5K7_SCHEMA_VERSION
    || manifest.recordType !== PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_RECORD_TYPE
    || manifest.phase !== PUBLIC_INTELLIGENCE_5K7_PHASE) failClosed('PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_TYPE_INVALID');
  if (manifest.corroborationPolicyVersion !== PUBLIC_INTELLIGENCE_5K7_POLICY_VERSION) failClosed('PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_POLICY_VERSION_INVALID');
  if (manifest.temporalPolicyVersion !== PUBLIC_INTELLIGENCE_5K5_TEMPORAL_POLICY_VERSION) failClosed('PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_TEMPORAL_POLICY_VERSION_INVALID');
  if (!SNAPSHOT_ID.test(manifest.snapshotId)) failClosed('PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_ID_INVALID');
  if (!/^tsnap-[0-9a-f]{32}$/.test(manifest.sourceTemporalSnapshotId)) failClosed('PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_SOURCE_TEMPORAL_ID_INVALID');
  validateCorpusPolicy({ corpusPolicyVersion: manifest.corpusPolicyVersion, eligibleStatuses: manifest.eligibleStatuses });
  for (const key of [...S.digestFields, ...S.sourceFingerprintFields, 'snapshotFingerprint']) {
    if (!FINGERPRINT.test(manifest[key])) failClosed(`PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_FINGERPRINT_INVALID:${key}`);
  }
  for (const key of S.countFields) {
    if (!Number.isSafeInteger(manifest[key]) || manifest[key] < 0) failClosed(`PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_COUNT_INVALID:${key}`);
  }
  for (const key of S.nullableTimestampFields) {
    if (manifest[key] === null) continue;
    if (!Number.isSafeInteger(manifest[key]) || manifest[key] < 0) failClosed(`PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_TIMESTAMP_INVALID:${key}`);
  }
  if (!PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_COVERAGE_CLASSIFICATION_VALUES.includes(manifest.coverageClassification)) {
    failClosed('PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_COVERAGE_CLASSIFICATION_INVALID');
  }
  if (manifest.coverageClassification !== snapshotCoverageClassificationFor(manifest.exactMintCount)) {
    failClosed('PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_COVERAGE_CLASSIFICATION_NE_COUNT');
  }
  for (const [key, counts] of [['providerFamilyCounts', manifest.providerFamilyCounts], ['providerNamespaceCounts', manifest.providerNamespaceCounts]]) {
    if (!counts || typeof counts !== 'object' || Array.isArray(counts)) failClosed(`PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_COUNTS_INVALID:${key}`);
    for (const [name, value] of Object.entries(counts)) {
      if (!Number.isSafeInteger(value) || value < 0) failClosed(`PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_COUNTS_INVALID:${key}.${name}`);
    }
  }
  for (const family of Object.keys(manifest.providerFamilyCounts)) {
    if (!PUBLIC_INTELLIGENCE_5K7_PROVIDER_FAMILIES.includes(family)) failClosed('PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_UNKNOWN_PROVIDER_FAMILY');
  }
  for (const key of ['sourceRunManifestFingerprints', 'memberRunIds', 'eligibleStatuses']) {
    if (!Array.isArray(manifest[key])) failClosed(`PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_LIST_INVALID:${key}`);
  }
  if (!isValidTimestamp(manifest.createdAt)) failClosed('PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_CREATED_AT_INVALID');
  if (canonical(manifest.classification) !== canonical(PUBLIC_INTELLIGENCE_CLASSIFICATION)) {
    failClosed('PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_CLASSIFICATION_OVERRIDE_REFUSED');
  }
  return manifest;
}

/**
 * Snapshot count invariants:
 *   single + multi = exactMintCount
 *   exact + unassociated + invalid + ambiguous = upstreamIdentityCount
 *   earliestObservedAt/latestObservedAt are null exactly when there is no
 *   exact-mint evidence, and ordered otherwise.
 */
export function checkSnapshotCounts(manifest) {
  const problems = [];
  const check = (condition, code) => { if (!condition) problems.push(code); };
  check(manifest.singleProviderFamilyMintCount + manifest.multiProviderFamilyMintCount === manifest.exactMintCount, 'COUNT_INVARIANT_STATUS_PARTITION');
  check(manifest.exactMintObservationCount + manifest.unassociatedObservationCount + manifest.invalidMintObservationCount
    + manifest.ambiguousObservationCount === manifest.upstreamIdentityCount, 'COUNT_INVARIANT_MISSINGNESS_PARTITION');
  check((manifest.earliestObservedAt === null) === (manifest.exactMintCount === 0), 'COUNT_INVARIANT_EARLIEST_NULLABILITY');
  check((manifest.latestObservedAt === null) === (manifest.exactMintCount === 0), 'COUNT_INVARIANT_LATEST_NULLABILITY');
  if (manifest.earliestObservedAt !== null && manifest.latestObservedAt !== null) {
    check(manifest.earliestObservedAt <= manifest.latestObservedAt, 'COUNT_INVARIANT_TIME_INVERTED');
  }
  return problems;
}

// ---------------------------------------------------------------------------
// STORAGE (write-once, own namespace, never .evolve)
// ---------------------------------------------------------------------------

/** 5K.7 snapshots live under `corroboration-corpora/`, in their own namespace. */
export function corroborationCorporaDirectoryOf(root, snapshotId) {
  if (!SNAPSHOT_ID.test(snapshotId)) failClosed('PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_ID_INVALID');
  return path.join(assertSafeRuntimeRoot(root), 'corroboration-corpora', snapshotId);
}

const lines = records => records.map(record => `${canonical(record)}\n`).join('');

/** Loads a stored snapshot directory. Never throws on a bad file; reports it. */
export function loadCorroborationArtifacts(directory) {
  const F = PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_FILES;
  const problems = [];
  const readNdjson = name => {
    const target = path.join(directory, name);
    if (!existsSync(target)) return [];
    const out = [];
    for (const line of readFileSync(target, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { problems.push(`LOAD_MALFORMED:${name}`); return []; }
    }
    return out;
  };
  let manifest = null;
  const manifestPath = path.join(directory, F.snapshot);
  if (existsSync(manifestPath)) {
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { problems.push(`LOAD_MALFORMED:${F.snapshot}`); }
  }
  const extra = existsSync(directory) ? readdirSync(directory).filter(name => !Object.values(F).includes(name)).sort() : [];
  return {
    directory,
    manifest,
    coverageRecords: readNdjson(F.coverage),
    observationCoverageRecords: readNdjson(F.observationCoverage),
    revisionEvidence: readNdjson(F.revisionEvidence),
    extraFiles: extra,
    loadProblems: problems,
  };
}

/**
 * Builds and stores a corroboration snapshot, write-once.
 *  - new id            -> written to a private build directory, then renamed atomically
 *  - existing id, same reproducible content -> ALREADY_EXISTS_IDENTICAL (nothing written)
 *  - existing id, different content          -> refused (nothing written)
 */
export function buildAndStoreCorroborationSnapshot({ root, runIds, policy = PUBLIC_INTELLIGENCE_5K4_DEFAULT_POLICY, revisionEvidence = [], createdAt }) {
  const content = rebuildCorroborationSnapshot({ root, runIds, policy, revisionEvidence });
  const manifest = buildSnapshotManifest(content, createdAt);
  const final = corroborationCorporaDirectoryOf(root, manifest.snapshotId);
  if (existsSync(final)) {
    if (lstatSync(final).isSymbolicLink()) failClosed('PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_EXISTS_NOT_A_PLAIN_DIRECTORY');
    const stored = loadCorroborationArtifacts(final);
    const same = stored.manifest
      && canonical({ ...stored.manifest, createdAt: 0, snapshotFingerprint: '' }) === canonical({ ...manifest, createdAt: 0, snapshotFingerprint: '' })
      && canonical(stored.coverageRecords) === canonical(content.coverageRecords)
      && canonical(stored.observationCoverageRecords) === canonical(content.observationCoverageRecords)
      && canonical(stored.revisionEvidence) === canonical(content.revisionEvidence);
    if (!same) failClosed('PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_EXISTS_DIFFERENT');
    return Object.freeze({ outcome: 'ALREADY_EXISTS_IDENTICAL', snapshotId: manifest.snapshotId, directory: final, manifest: stored.manifest });
  }
  const parent = path.dirname(final);
  mkdirSync(parent, { recursive: true });
  const building = path.join(parent, `.building-${manifest.snapshotId}`);
  mkdirSync(building); // exclusive: a stale or concurrent build refuses
  const F = PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_FILES;
  const write = (name, text) => writeFileSync(path.join(building, name), text, { flag: 'wx', mode: 0o444 });
  write(F.coverage, lines(content.coverageRecords));
  write(F.observationCoverage, lines(content.observationCoverageRecords));
  write(F.revisionEvidence, lines(content.revisionEvidence));
  write(F.snapshot, `${canonical(manifest)}\n`);
  for (const name of Object.values(F)) chmodSync(path.join(building, name), 0o444);
  renameSync(building, final); // atomic; fails if `final` appeared meanwhile
  return Object.freeze({ outcome: 'CREATED', snapshotId: manifest.snapshotId, directory: final, manifest });
}
