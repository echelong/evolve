// Phase 5K.8 - LINEAGE SNAPSHOT: closed manifest, deterministic identity and
// write-once storage of an immutable content-lineage view.
//
// IDENTITY vs AUTHENTICATION (kept deliberately separate, exactly as 5K.4-5K.7):
//   snapshotId = "linsnap-" + first 32 hex of SHA-256(canonical{
//                  kind, lineagePolicyVersion, corroborationPolicyVersion,
//                  temporalPolicyVersion, corpusPolicyVersion, eligibleStatuses,
//                  sorted runManifestFingerprints }).
//                Same authenticated source set + same policy => same id,
//                regardless of run order, discovery order or build time.
//                `createdAt` does NOT participate.
//   snapshotFingerprint = SHA-256 of the complete canonical manifest minus that
//                field. It DOES cover createdAt, so it authenticates this
//                particular persisted artifact.
//
// THE SOURCE IS AUTHENTICATED EVIDENCE, AND IT IS RECORDED IN FULL.
//
// The reproducible content is derived by re-authenticating every member RUN and
// rebuilding the verified 5K.5 temporal index and the 5K.7 corroboration coverage
// view from it. Because the temporal layer's classification depends on the
// provider-declared revision evidence it was given, that evidence is stored WITH
// the snapshot: a rebuild in the verifier therefore reproduces the same index
// rather than an approximation of it.
//
// Storage lives under `lineage-corpora/`, its own namespace, and never touches a
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
import { assembleTemporalContent, authenticateRuns, deriveTemporalSnapshotId } from './temporal-snapshot.mjs';
import { PUBLIC_INTELLIGENCE_5K7_POLICY_VERSION, PUBLIC_INTELLIGENCE_5K7_PROVIDER_FAMILIES } from './corroboration-definition.mjs';
import { buildCorroborationIndex, checkCorroborationAggregate } from './corroboration-index.mjs';
import { deriveCorroborationSnapshotId } from './corroboration-snapshot.mjs';
import {
  PUBLIC_INTELLIGENCE_5K8_PHASE, PUBLIC_INTELLIGENCE_5K8_SCHEMA_VERSION,
  PUBLIC_INTELLIGENCE_5K8_POLICY_VERSION, PUBLIC_INTELLIGENCE_5K8_RECORD_TYPES,
} from './lineage-definition.mjs';
import {
  buildContentVersions, buildLineages, computeLineageAggregate, checkLineageAggregate,
} from './lineage-index.mjs';

export const PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_RECORD_TYPE = PUBLIC_INTELLIGENCE_5K8_RECORD_TYPES.SNAPSHOT;
export const PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_FILES = Object.freeze({
  contentVersions: 'content-versions.ndjson',
  lineages: 'lineages.ndjson',
  revisionEvidence: 'source-revision-evidence.ndjson',
  snapshot: 'lineage-snapshot.json',
});

const SNAPSHOT_ID = /^linsnap-[0-9a-f]{32}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;

export const PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_SCHEMA = Object.freeze({
  closed: true,
  fields: Object.freeze([
    'schemaVersion', 'recordType', 'phase', 'snapshotId',
    'lineagePolicyVersion', 'corroborationPolicyVersion', 'temporalPolicyVersion', 'corpusPolicyVersion', 'eligibleStatuses',
    'sourceCorpusFingerprint', 'sourceTemporalSnapshotId', 'sourceTemporalFingerprint',
    'sourceCorroborationSnapshotId', 'sourceCorroborationSnapshotFingerprint', 'sourceRevisionEvidenceFingerprint',
    'sourceRunManifestFingerprints', 'memberRunIds', 'createdAt',
    'contentVersionCount', 'upstreamIdentityCount', 'lineageCount',
    'singleProviderLineageCount', 'multiProviderLineageCount',
    'exactRawMatchLineageCount', 'canonicalMatchLineageCount', 'explicitReferenceLineageCount',
    'distinctLineageCount', 'unresolvedLineageCount', 'crossProviderLineageCount',
    'referenceResolvedVersionCount', 'referenceUnresolvedVersionCount',
    'providerFamilyCounts',
    'earliestObservedAt', 'latestObservedAt',
    'lineageDigest', 'contentVersionDigest', 'recordsDigest',
    'classification', 'snapshotFingerprint',
  ]),
  countFields: Object.freeze([
    'contentVersionCount', 'upstreamIdentityCount', 'lineageCount',
    'singleProviderLineageCount', 'multiProviderLineageCount',
    'exactRawMatchLineageCount', 'canonicalMatchLineageCount', 'explicitReferenceLineageCount',
    'distinctLineageCount', 'unresolvedLineageCount', 'crossProviderLineageCount',
    'referenceResolvedVersionCount', 'referenceUnresolvedVersionCount',
  ]),
  digestFields: Object.freeze(['lineageDigest', 'contentVersionDigest', 'recordsDigest']),
  sourceFingerprintFields: Object.freeze([
    'sourceCorpusFingerprint', 'sourceTemporalFingerprint', 'sourceCorroborationSnapshotFingerprint',
    'sourceRevisionEvidenceFingerprint',
  ]),
  nullableTimestampFields: Object.freeze(['earliestObservedAt', 'latestObservedAt']),
});

const plain = value => JSON.parse(canonical(value));

/** Deterministic identity: policy + sorted run manifest fingerprints. No time. */
export function deriveLineageSnapshotId(policyInput, runManifestFingerprints) {
  const policy = validateCorpusPolicy(policyInput);
  const sorted = [...runManifestFingerprints].sort();
  for (const fingerprint of sorted) {
    if (!FINGERPRINT.test(fingerprint)) failClosed('PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_ID_FINGERPRINT_INVALID');
  }
  if (new Set(sorted).size !== sorted.length) failClosed('PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_ID_DUPLICATE_RUN');
  return `linsnap-${digest({
    kind: 'public_lineage_snapshot_identity',
    lineagePolicyVersion: PUBLIC_INTELLIGENCE_5K8_POLICY_VERSION,
    corroborationPolicyVersion: PUBLIC_INTELLIGENCE_5K7_POLICY_VERSION,
    temporalPolicyVersion: PUBLIC_INTELLIGENCE_5K5_TEMPORAL_POLICY_VERSION,
    corpusPolicyVersion: policy.corpusPolicyVersion,
    eligibleStatuses: policy.eligibleStatuses,
    runManifestFingerprints: sorted,
  }).slice(0, 32)}`;
}

export const lineageSnapshotFingerprintOf = manifest => {
  const body = { ...manifest };
  delete body.snapshotFingerprint;
  return digest(body);
};

/**
 * THE DERIVATION OF A TEMPORAL SOURCE FINGERPRINT.
 *
 * A temporal snapshot's four content digests are the WHOLE of what a
 * corroboration or lineage view derives from it, so the source fingerprint is a
 * pure function of them. It is defined here, once, so a downstream verifier can
 * re-derive the exact same value from a PERSISTED temporal snapshot manifest
 * instead of re-implementing the derivation and risking a second definition.
 */
export function temporalSourceFingerprintOf({ contentDigest, observationDigest, stateDigest, revisionDigest }) {
  return digest({ kind: 'public_lineage_temporal_source', contentDigest, observationDigest, stateDigest, revisionDigest });
}

/**
 * THE DERIVATION OF A CORROBORATION SOURCE FINGERPRINT.
 *
 * The same reasoning, over a corroboration snapshot's governed view digests and
 * its own snapshot identity.
 */
export function corroborationSourceFingerprintOf({ sourceCorroborationSnapshotId, coverageDigest, recordsDigest, observationCoverageDigest }) {
  return digest({
    kind: 'public_lineage_corroboration_source', sourceCorroborationSnapshotId, coverageDigest, recordsDigest, observationCoverageDigest,
  });
}

/** The flattened authenticated envelopes of a run set, for text fingerprints. */
function envelopesOf(authenticated) {
  const envelopes = [];
  for (const auth of authenticated) {
    if (!auth?.artifacts?.observations) failClosed('PUBLIC_INTELLIGENCE_5K8_RUN_OBSERVATIONS_MISSING');
    for (const envelope of auth.artifacts.observations) envelopes.push(envelope);
  }
  return envelopes;
}

/**
 * Pure assembly of the reproducible lineage content from authenticated runs. It
 * reuses the untouched 5K.5 temporal assembly and the 5K.7 corroboration index,
 * so 5K.8 adds no parallel evidence pipeline and no second normalization path.
 */
export function assembleLineageContent(authenticated, policyInput = PUBLIC_INTELLIGENCE_5K4_DEFAULT_POLICY, revisionEvidence = []) {
  const policy = validateCorpusPolicy(policyInput);
  if (!Array.isArray(revisionEvidence)) failClosed('PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_REVISION_EVIDENCE_INVALID');
  const temporal = assembleTemporalContent(authenticated, policy, revisionEvidence);
  const runManifestFingerprints = temporal.memberships.map(member => member.runManifestFingerprint);
  const sourceTemporalSnapshotId = deriveTemporalSnapshotId(policy, runManifestFingerprints);
  const sourceTemporalFingerprint = temporalSourceFingerprintOf(temporal);

  const corroboration = buildCorroborationIndex(
    { contentRecords: temporal.contentRecords, observationRecords: temporal.observationRecords },
    { sourceSnapshotIds: [sourceTemporalSnapshotId] },
  );
  const sourceCorroborationSnapshotId = deriveCorroborationSnapshotId(policy, runManifestFingerprints);
  const sourceCorroborationSnapshotFingerprint = corroborationSourceFingerprintOf({
    sourceCorroborationSnapshotId,
    coverageDigest: digest(corroboration.aggregate),
    recordsDigest: digest(corroboration.coverageRecords),
    observationCoverageDigest: digest(corroboration.observationCoverageRecords),
  });

  const sourceSnapshotFingerprints = [sourceTemporalFingerprint, sourceCorroborationSnapshotFingerprint];
  const contentVersions = buildContentVersions({
    observationRecords: temporal.observationRecords,
    envelopes: envelopesOf(authenticated),
  });
  const lineages = buildLineages({ contentVersions }, sourceSnapshotFingerprints);
  const aggregate = computeLineageAggregate({ contentVersions, lineages });

  return Object.freeze({
    policy,
    memberships: temporal.memberships,
    temporalRecords: { contentRecords: temporal.contentRecords, observationRecords: temporal.observationRecords },
    coverageRecords: corroboration.coverageRecords,
    observationCoverageRecords: corroboration.observationCoverageRecords,
    corroborationAggregate: corroboration.aggregate,
    contentVersions: Object.freeze(contentVersions),
    lineages,
    aggregate,
    revisionEvidence: [...revisionEvidence],
    sourceTemporalSnapshotId,
    sourceTemporalFingerprint,
    sourceCorroborationSnapshotId,
    sourceCorroborationSnapshotFingerprint,
    sourceCorpusFingerprint: digest(temporal.memberships),
    sourceRevisionEvidenceFingerprint: digest(revisionEvidence),
    lineageDigest: digest(lineages),
    contentVersionDigest: digest(contentVersions),
    recordsDigest: digest(aggregate),
  });
}

/** Authenticates the runs and assembles the content. Offline; reads run directories only. */
export function rebuildLineageSnapshot({ root, runIds, policy = PUBLIC_INTELLIGENCE_5K4_DEFAULT_POLICY, revisionEvidence = [] }) {
  return assembleLineageContent(authenticateRuns(root, runIds, policy), policy, revisionEvidence);
}

/** Builds the closed snapshot manifest. `createdAt` is execution metadata only. */
export function buildLineageSnapshotManifest(content, createdAt) {
  if (!isValidTimestamp(createdAt)) failClosed('PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_CREATED_AT_INVALID');
  const A = content.aggregate;
  const runManifestFingerprints = content.memberships.map(member => member.runManifestFingerprint);
  const body = {
    schemaVersion: PUBLIC_INTELLIGENCE_5K8_SCHEMA_VERSION,
    recordType: PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_RECORD_TYPE,
    phase: PUBLIC_INTELLIGENCE_5K8_PHASE,
    snapshotId: deriveLineageSnapshotId(content.policy, runManifestFingerprints),
    lineagePolicyVersion: PUBLIC_INTELLIGENCE_5K8_POLICY_VERSION,
    corroborationPolicyVersion: PUBLIC_INTELLIGENCE_5K7_POLICY_VERSION,
    temporalPolicyVersion: PUBLIC_INTELLIGENCE_5K5_TEMPORAL_POLICY_VERSION,
    corpusPolicyVersion: content.policy.corpusPolicyVersion,
    eligibleStatuses: [...content.policy.eligibleStatuses],
    sourceCorpusFingerprint: content.sourceCorpusFingerprint,
    sourceTemporalSnapshotId: content.sourceTemporalSnapshotId,
    sourceTemporalFingerprint: content.sourceTemporalFingerprint,
    sourceCorroborationSnapshotId: content.sourceCorroborationSnapshotId,
    sourceCorroborationSnapshotFingerprint: content.sourceCorroborationSnapshotFingerprint,
    sourceRevisionEvidenceFingerprint: content.sourceRevisionEvidenceFingerprint,
    sourceRunManifestFingerprints: [...runManifestFingerprints].sort(),
    memberRunIds: content.memberships.map(member => member.runId).sort(),
    createdAt,
    contentVersionCount: A.contentVersionCount,
    upstreamIdentityCount: A.upstreamIdentityCount,
    lineageCount: A.lineageCount,
    singleProviderLineageCount: A.singleProviderLineageCount,
    multiProviderLineageCount: A.multiProviderLineageCount,
    exactRawMatchLineageCount: A.exactRawMatchLineageCount,
    canonicalMatchLineageCount: A.canonicalMatchLineageCount,
    explicitReferenceLineageCount: A.explicitReferenceLineageCount,
    distinctLineageCount: A.distinctLineageCount,
    unresolvedLineageCount: A.unresolvedLineageCount,
    crossProviderLineageCount: A.crossProviderLineageCount,
    referenceResolvedVersionCount: A.referenceResolvedVersionCount,
    referenceUnresolvedVersionCount: A.referenceUnresolvedVersionCount,
    providerFamilyCounts: A.providerFamilyCounts,
    earliestObservedAt: A.earliestObservedAt,
    latestObservedAt: A.latestObservedAt,
    lineageDigest: content.lineageDigest,
    contentVersionDigest: content.contentVersionDigest,
    recordsDigest: content.recordsDigest,
    classification: PUBLIC_INTELLIGENCE_CLASSIFICATION,
  };
  const manifest = plain({ ...body, snapshotFingerprint: digest(body) });
  validateLineageSnapshotManifest(manifest);
  const problems = checkLineageAggregate(A, { contentVersions: content.contentVersions, lineages: content.lineages });
  if (!problems.ok) failClosed(`PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_ACCOUNTING_INCONSISTENT:${problems.problems[0]}`);
  const corroborationProblems = checkCorroborationAggregate(content.corroborationAggregate, {
    observationCoverageRecords: content.observationCoverageRecords, coverageRecords: content.coverageRecords,
  });
  if (!corroborationProblems.ok) failClosed(`PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_CORROBORATION_INCONSISTENT:${corroborationProblems.problems[0]}`);
  return manifest;
}

/** Closed-schema + fingerprint-format validation of the stored manifest. */
export function validateLineageSnapshotManifest(manifest) {
  const S = PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_SCHEMA;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) failClosed('PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_NOT_AN_OBJECT');
  for (const key of Object.keys(manifest)) {
    if (!S.fields.includes(key)) failClosed(`PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_UNKNOWN_FIELD:${String(key).slice(0, 48)}`);
  }
  for (const key of S.fields) if (!Object.hasOwn(manifest, key)) failClosed(`PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_FIELD_MISSING:${key}`);
  if (manifest.schemaVersion !== PUBLIC_INTELLIGENCE_5K8_SCHEMA_VERSION
    || manifest.recordType !== PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_RECORD_TYPE
    || manifest.phase !== PUBLIC_INTELLIGENCE_5K8_PHASE) failClosed('PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_TYPE_INVALID');
  if (manifest.lineagePolicyVersion !== PUBLIC_INTELLIGENCE_5K8_POLICY_VERSION) failClosed('PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_POLICY_VERSION_INVALID');
  if (manifest.corroborationPolicyVersion !== PUBLIC_INTELLIGENCE_5K7_POLICY_VERSION) failClosed('PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_CORROBORATION_POLICY_VERSION_INVALID');
  if (manifest.temporalPolicyVersion !== PUBLIC_INTELLIGENCE_5K5_TEMPORAL_POLICY_VERSION) failClosed('PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_TEMPORAL_POLICY_VERSION_INVALID');
  if (!SNAPSHOT_ID.test(manifest.snapshotId)) failClosed('PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_ID_INVALID');
  if (!/^tsnap-[0-9a-f]{32}$/.test(manifest.sourceTemporalSnapshotId)) failClosed('PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_SOURCE_TEMPORAL_ID_INVALID');
  if (!/^crsnap-[0-9a-f]{32}$/.test(manifest.sourceCorroborationSnapshotId)) failClosed('PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_SOURCE_CORROBORATION_ID_INVALID');
  validateCorpusPolicy({ corpusPolicyVersion: manifest.corpusPolicyVersion, eligibleStatuses: manifest.eligibleStatuses });
  for (const key of [...S.digestFields, ...S.sourceFingerprintFields, 'snapshotFingerprint']) {
    if (!FINGERPRINT.test(manifest[key])) failClosed(`PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_FINGERPRINT_INVALID:${key}`);
  }
  for (const key of S.countFields) {
    if (!Number.isSafeInteger(manifest[key]) || manifest[key] < 0) failClosed(`PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_COUNT_INVALID:${key}`);
  }
  for (const key of S.nullableTimestampFields) {
    if (manifest[key] === null) continue;
    if (!Number.isSafeInteger(manifest[key]) || manifest[key] < 0) failClosed(`PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_TIMESTAMP_INVALID:${key}`);
  }
  if (manifest.crossProviderLineageCount !== manifest.multiProviderLineageCount) failClosed('PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_CROSS_PROVIDER_DRIFT');
  const counts = manifest.providerFamilyCounts;
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) failClosed('PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_COUNTS_INVALID');
  for (const [name, value] of Object.entries(counts)) {
    if (!Number.isSafeInteger(value) || value < 0) failClosed(`PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_COUNTS_INVALID:${name}`);
    if (!PUBLIC_INTELLIGENCE_5K7_PROVIDER_FAMILIES.includes(name)) failClosed('PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_UNKNOWN_PROVIDER_FAMILY');
  }
  for (const key of ['sourceRunManifestFingerprints', 'memberRunIds', 'eligibleStatuses']) {
    if (!Array.isArray(manifest[key])) failClosed(`PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_LIST_INVALID:${key}`);
  }
  if (!isValidTimestamp(manifest.createdAt)) failClosed('PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_CREATED_AT_INVALID');
  if (canonical(manifest.classification) !== canonical(PUBLIC_INTELLIGENCE_CLASSIFICATION)) {
    failClosed('PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_CLASSIFICATION_OVERRIDE_REFUSED');
  }
  return manifest;
}

/** Snapshot count invariants. */
export function checkLineageSnapshotCounts(manifest) {
  const problems = [];
  const check = (condition, code) => { if (!condition) problems.push(code); };
  check(manifest.distinctLineageCount + manifest.exactRawMatchLineageCount + manifest.canonicalMatchLineageCount
    + manifest.explicitReferenceLineageCount + manifest.unresolvedLineageCount === manifest.lineageCount, 'LINEAGE_SNAPSHOT_CLASS_PARTITION');
  check(manifest.singleProviderLineageCount + manifest.multiProviderLineageCount === manifest.lineageCount, 'LINEAGE_SNAPSHOT_PROVIDER_PARTITION');
  check(manifest.contentVersionCount >= manifest.lineageCount, 'LINEAGE_SNAPSHOT_VERSIONS_BELOW_LINEAGES');
  check((manifest.earliestObservedAt === null) === (manifest.lineageCount === 0), 'LINEAGE_SNAPSHOT_EARLIEST_NULLABILITY');
  check((manifest.latestObservedAt === null) === (manifest.lineageCount === 0), 'LINEAGE_SNAPSHOT_LATEST_NULLABILITY');
  return problems;
}

// ---------------------------------------------------------------------------
// STORAGE (write-once, own namespace, never .evolve)
// ---------------------------------------------------------------------------

/** 5K.8 snapshots live under `lineage-corpora/`, in their own namespace. */
export function lineageCorporaDirectoryOf(root, snapshotId) {
  if (!SNAPSHOT_ID.test(snapshotId)) failClosed('PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_ID_INVALID');
  return path.join(assertSafeRuntimeRoot(root), 'lineage-corpora', snapshotId);
}

const lines = records => records.map(record => `${canonical(record)}\n`).join('');

/** Loads a stored snapshot directory. Never throws on a bad file; reports it. */
export function loadLineageArtifacts(directory) {
  const F = PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_FILES;
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
    contentVersions: readNdjson(F.contentVersions),
    lineages: readNdjson(F.lineages),
    revisionEvidence: readNdjson(F.revisionEvidence),
    extraFiles: extra,
    loadProblems: problems,
  };
}

/**
 * Builds and stores a lineage snapshot, write-once.
 *  - new id            -> written to a private build directory, then renamed atomically
 *  - existing id, same reproducible content -> ALREADY_EXISTS_IDENTICAL (nothing written)
 *  - existing id, different content          -> refused (nothing written)
 */
export function buildAndStoreLineageSnapshot({ root, runIds, policy = PUBLIC_INTELLIGENCE_5K4_DEFAULT_POLICY, revisionEvidence = [], createdAt }) {
  const content = rebuildLineageSnapshot({ root, runIds, policy, revisionEvidence });
  const manifest = buildLineageSnapshotManifest(content, createdAt);
  const final = lineageCorporaDirectoryOf(root, manifest.snapshotId);
  if (existsSync(final)) {
    if (lstatSync(final).isSymbolicLink()) failClosed('PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_EXISTS_NOT_A_PLAIN_DIRECTORY');
    const stored = loadLineageArtifacts(final);
    const same = stored.manifest
      && canonical({ ...stored.manifest, createdAt: 0, snapshotFingerprint: '' }) === canonical({ ...manifest, createdAt: 0, snapshotFingerprint: '' })
      && canonical(stored.contentVersions) === canonical(content.contentVersions)
      && canonical(stored.lineages) === canonical(content.lineages)
      && canonical(stored.revisionEvidence) === canonical(content.revisionEvidence);
    if (!same) failClosed('PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_EXISTS_DIFFERENT');
    return Object.freeze({ outcome: 'ALREADY_EXISTS_IDENTICAL', snapshotId: manifest.snapshotId, directory: final, manifest: stored.manifest });
  }
  const parent = path.dirname(final);
  mkdirSync(parent, { recursive: true });
  const building = path.join(parent, `.building-${manifest.snapshotId}`);
  mkdirSync(building); // exclusive: a stale or concurrent build refuses
  const F = PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_FILES;
  const write = (name, text) => writeFileSync(path.join(building, name), text, { flag: 'wx', mode: 0o444 });
  write(F.contentVersions, lines(content.contentVersions));
  write(F.lineages, lines(content.lineages));
  write(F.revisionEvidence, lines(content.revisionEvidence));
  write(F.snapshot, `${canonical(manifest)}\n`);
  for (const name of Object.values(F)) chmodSync(path.join(building, name), 0o444);
  renameSync(building, final); // atomic; fails if `final` appeared meanwhile
  return Object.freeze({ outcome: 'CREATED', snapshotId: manifest.snapshotId, directory: final, manifest });
}
