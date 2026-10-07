// Phase 5K.9 - DESCRIPTIVE FEATURE SNAPSHOT: closed manifest, deterministic
// identity and write-once storage of an immutable feature view.
//
// IDENTITY vs AUTHENTICATION (kept deliberately separate, exactly as 5K.4-5K.8):
//   snapshotId = "featsnap-" + first 32 hex of SHA-256(canonical{
//                  kind, featurePolicyVersion, lineagePolicyVersion,
//                  corroborationPolicyVersion, temporalPolicyVersion,
//                  corpusPolicyVersion, eligibleStatuses,
//                  sorted runManifestFingerprints }).
//                Same authenticated source set + same policy => same id,
//                regardless of run order, discovery order or build time.
//                `createdAt` does NOT participate.
//   snapshotFingerprint = SHA-256 of the complete canonical manifest minus that
//                field, and DOES cover createdAt.
//
// The source is authenticated evidence, recorded in full: the member run set and
// the provider-declared revision evidence are stored WITH the snapshot, so a
// rebuild in the verifier reproduces the same 5K.5/5K.7/5K.8 derivation rather
// than an approximation of it.
//
// Storage lives under `feature-corpora/`, its own namespace, and never touches a
// run directory and never writes under .evolve.
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { canonical, digest, PUBLIC_INTELLIGENCE_CLASSIFICATION, isValidTimestamp } from './definition.mjs';
import { failClosed } from './observation.mjs';
import { assertSafeRuntimeRoot } from './run-store.mjs';
import { validateCorpusPolicy, PUBLIC_INTELLIGENCE_5K4_DEFAULT_POLICY } from './corpus-membership.mjs';
import { PUBLIC_INTELLIGENCE_5K5_TEMPORAL_POLICY_VERSION } from './temporal-projection.mjs';
import { authenticateRuns } from './temporal-snapshot.mjs';
import { PUBLIC_INTELLIGENCE_5K7_POLICY_VERSION } from './corroboration-definition.mjs';
import { PUBLIC_INTELLIGENCE_5K8_POLICY_VERSION } from './lineage-definition.mjs';
import { assembleLineageContent, deriveLineageSnapshotId } from './lineage-snapshot.mjs';
import {
  PUBLIC_INTELLIGENCE_5K9_PHASE, PUBLIC_INTELLIGENCE_5K9_SCHEMA_VERSION,
  PUBLIC_INTELLIGENCE_5K9_POLICY_VERSION, PUBLIC_INTELLIGENCE_5K9_RECORD_TYPES,
  PUBLIC_INTELLIGENCE_5K9_BUCKET_POLICY, PUBLIC_INTELLIGENCE_5K9_BUCKET_WIDTH_MS,
} from './feature-definition.mjs';
import { extractFeatures, checkFeatureSummary, validateMintFeature } from './feature-extract.mjs';

export const PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_RECORD_TYPE = PUBLIC_INTELLIGENCE_5K9_RECORD_TYPES.SNAPSHOT;
export const PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_FILES = Object.freeze({
  features: 'mint-features.ndjson',
  revisionEvidence: 'source-revision-evidence.ndjson',
  snapshot: 'feature-snapshot.json',
});

const SNAPSHOT_ID = /^featsnap-[0-9a-f]{32}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;

export const PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_SCHEMA = Object.freeze({
  closed: true,
  fields: Object.freeze([
    'schemaVersion', 'recordType', 'phase', 'snapshotId',
    'featurePolicyVersion', 'lineagePolicyVersion', 'corroborationPolicyVersion', 'temporalPolicyVersion',
    'corpusPolicyVersion', 'eligibleStatuses',
    'bucketPolicyVersion', 'bucketWidthMs',
    'sourceCorpusFingerprint', 'sourceTemporalSnapshotId', 'sourceTemporalSnapshotFingerprint',
    'sourceCorroborationSnapshotId', 'sourceCorroborationSnapshotFingerprint',
    'sourceLineageSnapshotId', 'sourceLineageSnapshotFingerprint', 'sourceRevisionEvidenceFingerprint',
    'sourceRunManifestFingerprints', 'memberRunIds', 'createdAt',
    'mintFeatureCount',
    'unassociatedObservationCount', 'invalidMintObservationCount', 'ambiguousObservationCount',
    'exactMintObservationCount',
    'singleProviderFamilyMintCount', 'multiProviderFamilyMintCount',
    'totalUpstreamObservationCount', 'totalContentVersionCount', 'totalStateSnapshotCount', 'totalLineageCount',
    'totalProviderFamilyCount',
    'earliestObservedAt', 'latestObservedAt',
    'featuresDigest', 'summaryDigest',
    'classification', 'snapshotFingerprint',
  ]),
  countFields: Object.freeze([
    'mintFeatureCount', 'unassociatedObservationCount', 'invalidMintObservationCount', 'ambiguousObservationCount',
    'exactMintObservationCount', 'singleProviderFamilyMintCount', 'multiProviderFamilyMintCount',
    'totalUpstreamObservationCount', 'totalContentVersionCount', 'totalStateSnapshotCount', 'totalLineageCount',
    'totalProviderFamilyCount', 'bucketWidthMs',
  ]),
  digestFields: Object.freeze(['featuresDigest', 'summaryDigest']),
  sourceFingerprintFields: Object.freeze([
    'sourceCorpusFingerprint', 'sourceTemporalSnapshotFingerprint', 'sourceCorroborationSnapshotFingerprint',
    'sourceLineageSnapshotFingerprint', 'sourceRevisionEvidenceFingerprint',
  ]),
  nullableTimestampFields: Object.freeze(['earliestObservedAt', 'latestObservedAt']),
});

const plain = value => JSON.parse(canonical(value));

/** Deterministic identity: policy + sorted run manifest fingerprints. No time. */
export function deriveFeatureSnapshotId(policyInput, runManifestFingerprints) {
  const policy = validateCorpusPolicy(policyInput);
  const sorted = [...runManifestFingerprints].sort();
  for (const fingerprint of sorted) {
    if (!FINGERPRINT.test(fingerprint)) failClosed('PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_ID_FINGERPRINT_INVALID');
  }
  if (new Set(sorted).size !== sorted.length) failClosed('PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_ID_DUPLICATE_RUN');
  return `featsnap-${digest({
    kind: 'public_feature_snapshot_identity',
    featurePolicyVersion: PUBLIC_INTELLIGENCE_5K9_POLICY_VERSION,
    lineagePolicyVersion: PUBLIC_INTELLIGENCE_5K8_POLICY_VERSION,
    corroborationPolicyVersion: PUBLIC_INTELLIGENCE_5K7_POLICY_VERSION,
    temporalPolicyVersion: PUBLIC_INTELLIGENCE_5K5_TEMPORAL_POLICY_VERSION,
    corpusPolicyVersion: policy.corpusPolicyVersion,
    eligibleStatuses: policy.eligibleStatuses,
    bucketPolicyVersion: PUBLIC_INTELLIGENCE_5K9_BUCKET_POLICY.bucketPolicyVersion,
    runManifestFingerprints: sorted,
  }).slice(0, 32)}`;
}

export const featureSnapshotFingerprintOf = manifest => {
  const body = { ...manifest };
  delete body.snapshotFingerprint;
  return digest(body);
};

/**
 * THE DERIVATION OF THE LINEAGE SOURCE FINGERPRINT.
 *
 * A lineage snapshot's governed aggregate digests are the whole of what this
 * phase derives from it, so the source fingerprint is a pure function of them.
 * It is defined here, once, so the verifier can re-derive the exact same value
 * from a PERSISTED lineage snapshot manifest rather than trusting the declared
 * number or re-implementing the derivation.
 */
export function lineageSourceFingerprintOf({ sourceLineageSnapshotId, lineageDigest, contentVersionDigest }) {
  return digest({ kind: 'public_feature_lineage_source', sourceLineageSnapshotId, lineageDigest, contentVersionDigest });
}

/** The flattened authenticated envelopes of a run set, for availability facts. */
export function envelopesOf(authenticated) {
  const envelopes = [];
  for (const auth of authenticated) {
    if (!auth?.artifacts?.observations) failClosed('PUBLIC_INTELLIGENCE_5K9_RUN_OBSERVATIONS_MISSING');
    for (const envelope of auth.artifacts.observations) envelopes.push(envelope);
  }
  return envelopes;
}

/**
 * Pure assembly of the reproducible feature content from authenticated runs. It
 * reuses the untouched 5K.8 lineage assembly - and through it 5K.5 and 5K.7 - so
 * 5K.9 adds no parallel evidence pipeline and no second normalization path.
 */
export function assembleFeatureContent(authenticated, policyInput = PUBLIC_INTELLIGENCE_5K4_DEFAULT_POLICY, revisionEvidence = []) {
  const policy = validateCorpusPolicy(policyInput);
  if (!Array.isArray(revisionEvidence)) failClosed('PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_REVISION_EVIDENCE_INVALID');
  const lineage = assembleLineageContent(authenticated, policy, revisionEvidence);
  const runManifestFingerprints = lineage.memberships.map(member => member.runManifestFingerprint);
  const sourceLineageSnapshotId = deriveLineageSnapshotId(policy, runManifestFingerprints);
  const sourceLineageSnapshotFingerprint = lineageSourceFingerprintOf({
    sourceLineageSnapshotId,
    lineageDigest: lineage.lineageDigest,
    contentVersionDigest: lineage.contentVersionDigest,
  });

  const extracted = extractFeatures({
    temporal: lineage.temporalRecords,
    contentVersions: lineage.contentVersions,
    lineages: lineage.lineages,
    coverageRecords: lineage.coverageRecords,
    observationCoverageRecords: lineage.observationCoverageRecords,
    envelopes: envelopesOf(authenticated),
  });

  return Object.freeze({
    policy,
    memberships: lineage.memberships,
    records: extracted.records,
    summary: extracted.summary,
    sourceCorpusFingerprint: lineage.sourceCorpusFingerprint,
    sourceTemporalSnapshotId: lineage.sourceTemporalSnapshotId,
    sourceTemporalSnapshotFingerprint: lineage.sourceTemporalFingerprint,
    sourceCorroborationSnapshotId: lineage.sourceCorroborationSnapshotId,
    sourceCorroborationSnapshotFingerprint: lineage.sourceCorroborationSnapshotFingerprint,
    sourceLineageSnapshotId,
    sourceLineageSnapshotFingerprint,
    revisionEvidence: [...revisionEvidence],
    sourceRevisionEvidenceFingerprint: digest(revisionEvidence),
    featuresDigest: digest(extracted.records),
    summaryDigest: digest(extracted.summary),
  });
}

/** Authenticates the runs and assembles the content. Offline; reads run directories only. */
export function rebuildFeatureSnapshot({ root, runIds, policy = PUBLIC_INTELLIGENCE_5K4_DEFAULT_POLICY, revisionEvidence = [] }) {
  return assembleFeatureContent(authenticateRuns(root, runIds, policy), policy, revisionEvidence);
}

/** Builds the closed snapshot manifest. `createdAt` is execution metadata only. */
export function buildFeatureSnapshotManifest(content, createdAt) {
  if (!isValidTimestamp(createdAt)) failClosed('PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_CREATED_AT_INVALID');
  const S = content.summary;
  const runManifestFingerprints = content.memberships.map(member => member.runManifestFingerprint);
  const body = {
    schemaVersion: PUBLIC_INTELLIGENCE_5K9_SCHEMA_VERSION,
    recordType: PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_RECORD_TYPE,
    phase: PUBLIC_INTELLIGENCE_5K9_PHASE,
    snapshotId: deriveFeatureSnapshotId(content.policy, runManifestFingerprints),
    featurePolicyVersion: PUBLIC_INTELLIGENCE_5K9_POLICY_VERSION,
    lineagePolicyVersion: PUBLIC_INTELLIGENCE_5K8_POLICY_VERSION,
    corroborationPolicyVersion: PUBLIC_INTELLIGENCE_5K7_POLICY_VERSION,
    temporalPolicyVersion: PUBLIC_INTELLIGENCE_5K5_TEMPORAL_POLICY_VERSION,
    corpusPolicyVersion: content.policy.corpusPolicyVersion,
    eligibleStatuses: [...content.policy.eligibleStatuses],
    bucketPolicyVersion: PUBLIC_INTELLIGENCE_5K9_BUCKET_POLICY.bucketPolicyVersion,
    bucketWidthMs: PUBLIC_INTELLIGENCE_5K9_BUCKET_WIDTH_MS,
    sourceCorpusFingerprint: content.sourceCorpusFingerprint,
    sourceTemporalSnapshotId: content.sourceTemporalSnapshotId,
    sourceTemporalSnapshotFingerprint: content.sourceTemporalSnapshotFingerprint,
    sourceCorroborationSnapshotId: content.sourceCorroborationSnapshotId,
    sourceCorroborationSnapshotFingerprint: content.sourceCorroborationSnapshotFingerprint,
    sourceLineageSnapshotId: content.sourceLineageSnapshotId,
    sourceLineageSnapshotFingerprint: content.sourceLineageSnapshotFingerprint,
    sourceRevisionEvidenceFingerprint: content.sourceRevisionEvidenceFingerprint,
    sourceRunManifestFingerprints: [...runManifestFingerprints].sort(),
    memberRunIds: content.memberships.map(member => member.runId).sort(),
    createdAt,
    mintFeatureCount: S.mintFeatureCount,
    unassociatedObservationCount: S.unassociatedObservationCount,
    invalidMintObservationCount: S.invalidMintObservationCount,
    ambiguousObservationCount: S.ambiguousObservationCount,
    exactMintObservationCount: S.exactMintObservationCount,
    singleProviderFamilyMintCount: S.singleProviderFamilyMintCount,
    multiProviderFamilyMintCount: S.multiProviderFamilyMintCount,
    totalUpstreamObservationCount: S.totalUpstreamObservationCount,
    totalContentVersionCount: S.totalContentVersionCount,
    totalStateSnapshotCount: S.totalStateSnapshotCount,
    totalLineageCount: S.totalLineageCount,
    totalProviderFamilyCount: S.totalProviderFamilyCount,
    earliestObservedAt: S.earliestObservedAt,
    latestObservedAt: S.latestObservedAt,
    featuresDigest: content.featuresDigest,
    summaryDigest: content.summaryDigest,
    classification: PUBLIC_INTELLIGENCE_CLASSIFICATION,
  };
  const manifest = plain({ ...body, snapshotFingerprint: digest(body) });
  validateFeatureSnapshotManifest(manifest);
  const problems = checkFeatureSummary(S, { records: content.records });
  if (!problems.ok) failClosed(`PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_SUMMARY_INCONSISTENT:${problems.problems[0]}`);
  return manifest;
}

/** Closed-schema + fingerprint-format validation of the stored manifest. */
export function validateFeatureSnapshotManifest(manifest) {
  const S = PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_SCHEMA;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) failClosed('PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_NOT_AN_OBJECT');
  for (const key of Object.keys(manifest)) {
    if (!S.fields.includes(key)) failClosed(`PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_UNKNOWN_FIELD:${String(key).slice(0, 48)}`);
  }
  for (const key of S.fields) if (!Object.hasOwn(manifest, key)) failClosed(`PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_FIELD_MISSING:${key}`);
  if (manifest.schemaVersion !== PUBLIC_INTELLIGENCE_5K9_SCHEMA_VERSION
    || manifest.recordType !== PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_RECORD_TYPE
    || manifest.phase !== PUBLIC_INTELLIGENCE_5K9_PHASE) failClosed('PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_TYPE_INVALID');
  if (manifest.featurePolicyVersion !== PUBLIC_INTELLIGENCE_5K9_POLICY_VERSION) failClosed('PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_POLICY_VERSION_INVALID');
  if (manifest.lineagePolicyVersion !== PUBLIC_INTELLIGENCE_5K8_POLICY_VERSION) failClosed('PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_LINEAGE_POLICY_VERSION_INVALID');
  if (manifest.corroborationPolicyVersion !== PUBLIC_INTELLIGENCE_5K7_POLICY_VERSION) failClosed('PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_CORROBORATION_POLICY_VERSION_INVALID');
  if (manifest.temporalPolicyVersion !== PUBLIC_INTELLIGENCE_5K5_TEMPORAL_POLICY_VERSION) failClosed('PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_TEMPORAL_POLICY_VERSION_INVALID');
  if (manifest.bucketPolicyVersion !== PUBLIC_INTELLIGENCE_5K9_BUCKET_POLICY.bucketPolicyVersion) failClosed('PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_BUCKET_POLICY_VERSION_INVALID');
  if (manifest.bucketWidthMs !== PUBLIC_INTELLIGENCE_5K9_BUCKET_WIDTH_MS) failClosed('PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_BUCKET_WIDTH_INVALID');
  if (!SNAPSHOT_ID.test(manifest.snapshotId)) failClosed('PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_ID_INVALID');
  if (!/^tsnap-[0-9a-f]{32}$/.test(manifest.sourceTemporalSnapshotId)) failClosed('PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_SOURCE_TEMPORAL_ID_INVALID');
  if (!/^crsnap-[0-9a-f]{32}$/.test(manifest.sourceCorroborationSnapshotId)) failClosed('PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_SOURCE_CORROBORATION_ID_INVALID');
  if (!/^linsnap-[0-9a-f]{32}$/.test(manifest.sourceLineageSnapshotId)) failClosed('PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_SOURCE_LINEAGE_ID_INVALID');
  validateCorpusPolicy({ corpusPolicyVersion: manifest.corpusPolicyVersion, eligibleStatuses: manifest.eligibleStatuses });
  for (const key of [...S.digestFields, ...S.sourceFingerprintFields, 'snapshotFingerprint']) {
    if (!FINGERPRINT.test(manifest[key])) failClosed(`PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_FINGERPRINT_INVALID:${key}`);
  }
  for (const key of S.countFields) {
    if (!Number.isSafeInteger(manifest[key]) || manifest[key] < 0) failClosed(`PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_COUNT_INVALID:${key}`);
  }
  for (const key of S.nullableTimestampFields) {
    if (manifest[key] === null) continue;
    if (!Number.isSafeInteger(manifest[key]) || manifest[key] < 0) failClosed(`PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_TIMESTAMP_INVALID:${key}`);
  }
  for (const key of ['sourceRunManifestFingerprints', 'memberRunIds', 'eligibleStatuses']) {
    if (!Array.isArray(manifest[key])) failClosed(`PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_LIST_INVALID:${key}`);
  }
  if (manifest.singleProviderFamilyMintCount + manifest.multiProviderFamilyMintCount !== manifest.mintFeatureCount) {
    failClosed('PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_COVERAGE_PARTITION');
  }
  if (manifest.totalProviderFamilyCount < manifest.mintFeatureCount) failClosed('PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_FAMILY_TOTAL_BELOW_MINTS');
  if (!isValidTimestamp(manifest.createdAt)) failClosed('PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_CREATED_AT_INVALID');
  if (canonical(manifest.classification) !== canonical(PUBLIC_INTELLIGENCE_CLASSIFICATION)) {
    failClosed('PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_CLASSIFICATION_OVERRIDE_REFUSED');
  }
  return manifest;
}

/** The snapshot count invariants. */
export function checkFeatureSnapshotCounts(manifest) {
  const problems = [];
  const check = (condition, code) => { if (!condition) problems.push(code); };
  check(manifest.singleProviderFamilyMintCount + manifest.multiProviderFamilyMintCount === manifest.mintFeatureCount, 'FEATURE_SNAPSHOT_COVERAGE_PARTITION');
  check((manifest.earliestObservedAt === null) === (manifest.mintFeatureCount === 0), 'FEATURE_SNAPSHOT_EARLIEST_NULLABILITY');
  check((manifest.latestObservedAt === null) === (manifest.mintFeatureCount === 0), 'FEATURE_SNAPSHOT_LATEST_NULLABILITY');
  check(manifest.totalContentVersionCount >= manifest.mintFeatureCount, 'FEATURE_SNAPSHOT_VERSIONS_BELOW_MINTS');
  check(manifest.totalUpstreamObservationCount >= manifest.mintFeatureCount, 'FEATURE_SNAPSHOT_OBSERVATIONS_BELOW_MINTS');
  check(manifest.totalStateSnapshotCount >= manifest.totalUpstreamObservationCount, 'FEATURE_SNAPSHOT_STATES_BELOW_OBSERVATIONS');
  check(manifest.totalLineageCount <= manifest.mintFeatureCount + manifest.totalContentVersionCount, 'FEATURE_SNAPSHOT_LINEAGE_RANGE');
  return problems;
}

// ---------------------------------------------------------------------------
// STORAGE (write-once, own namespace, never .evolve)
// ---------------------------------------------------------------------------

/** 5K.9 snapshots live under `feature-corpora/`, in their own namespace. */
export function featureCorporaDirectoryOf(root, snapshotId) {
  if (!SNAPSHOT_ID.test(snapshotId)) failClosed('PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_ID_INVALID');
  return path.join(assertSafeRuntimeRoot(root), 'feature-corpora', snapshotId);
}

const lines = records => records.map(record => `${canonical(record)}\n`).join('');

/** Loads a stored snapshot directory. Never throws on a bad file; reports it. */
export function loadFeatureArtifacts(directory) {
  const F = PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_FILES;
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
    features: readNdjson(F.features),
    revisionEvidence: readNdjson(F.revisionEvidence),
    extraFiles: extra,
    loadProblems: problems,
  };
}

/**
 * Builds and stores a feature snapshot, write-once.
 *  - new id            -> written to a private build directory, then renamed atomically
 *  - existing id, same reproducible content -> ALREADY_EXISTS_IDENTICAL (nothing written)
 *  - existing id, different content          -> refused (nothing written)
 */
export function buildAndStoreFeatureSnapshot({ root, runIds, policy = PUBLIC_INTELLIGENCE_5K4_DEFAULT_POLICY, revisionEvidence = [], createdAt }) {
  const content = rebuildFeatureSnapshot({ root, runIds, policy, revisionEvidence });
  const manifest = buildFeatureSnapshotManifest(content, createdAt);
  const final = featureCorporaDirectoryOf(root, manifest.snapshotId);
  if (existsSync(final)) {
    if (lstatSync(final).isSymbolicLink()) failClosed('PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_EXISTS_NOT_A_PLAIN_DIRECTORY');
    const stored = loadFeatureArtifacts(final);
    const same = stored.manifest
      && canonical({ ...stored.manifest, createdAt: 0, snapshotFingerprint: '' }) === canonical({ ...manifest, createdAt: 0, snapshotFingerprint: '' })
      && canonical(stored.features) === canonical(content.records)
      && canonical(stored.revisionEvidence) === canonical(content.revisionEvidence);
    if (!same) failClosed('PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_EXISTS_DIFFERENT');
    return Object.freeze({ outcome: 'ALREADY_EXISTS_IDENTICAL', snapshotId: manifest.snapshotId, directory: final, manifest: stored.manifest });
  }
  const parent = path.dirname(final);
  mkdirSync(parent, { recursive: true });
  const building = path.join(parent, `.building-${manifest.snapshotId}`);
  mkdirSync(building); // exclusive: a stale or concurrent build refuses
  const F = PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_FILES;
  const write = (name, text) => writeFileSync(path.join(building, name), text, { flag: 'wx', mode: 0o444 });
  write(F.features, lines(content.records));
  write(F.revisionEvidence, lines(content.revisionEvidence));
  write(F.snapshot, `${canonical(manifest)}\n`);
  for (const name of Object.values(F)) chmodSync(path.join(building, name), 0o444);
  renameSync(building, final); // atomic; fails if `final` appeared meanwhile
  return Object.freeze({ outcome: 'CREATED', snapshotId: manifest.snapshotId, directory: final, manifest });
}

/** Validates every stored feature record against the closed schema. */
export function validateStoredFeatures(records) {
  for (const record of records) validateMintFeature(record);
  return records;
}
