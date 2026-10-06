// Phase 5K.7 - OFFLINE CORROBORATION SNAPSHOT VERIFIER.
//
// Trusts nothing stored in the corroboration snapshot. It re-authenticates every
// member run from the run directories, rebuilds the verified 5K.5 temporal index
// and the whole corroboration coverage view from scratch - using the revision
// evidence the snapshot recorded as part of its source definition - and compares
// that against what the snapshot stores, reporting a named failure for every
// discrepancy. Nothing is ever repaired.
//
// OFFLINE BY CONSTRUCTION: filesystem reads only. No network, no clock, no
// environment.
import { canonical, digest } from './definition.mjs';
import { validateCorpusPolicy, authenticateRun } from './corpus-membership.mjs';
import {
  loadCorroborationArtifacts, corroborationCorporaDirectoryOf, deriveCorroborationSnapshotId,
  corroborationSnapshotFingerprintOf, validateSnapshotManifest, buildSnapshotManifest,
  assembleCorroborationContent, checkSnapshotCounts, PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_SCHEMA,
} from './corroboration-snapshot.mjs';
import { validateCoverageRecord, validateObservationCoverageRecord } from './corroboration-index.mjs';

const guard = (failures, code, fn) => {
  try { return fn(); } catch (error) {
    failures.push(`${code}:${String(error?.message ?? error).split(':').slice(0, 2).join(':').slice(0, 90)}`);
    return undefined;
  }
};

/** Compares stored vs rebuilt record sets keyed by `key`, reporting every drift class. */
function compareSets(failures, stored, rebuilt, key, names) {
  const storedMap = new Map();
  const rebuiltMap = new Map();
  for (const record of stored) {
    if (storedMap.has(record[key])) failures.push(`${names.dup}:${String(record[key]).slice(0, 48)}`);
    storedMap.set(record[key], record);
  }
  for (const record of rebuilt) rebuiltMap.set(record[key], record);
  for (const [id, record] of rebuiltMap) {
    if (!storedMap.has(id)) failures.push(`${names.removed}:${String(id).slice(0, 48)}`);
    else if (canonical(storedMap.get(id)) !== canonical(record)) failures.push(`${names.modified}:${String(id).slice(0, 48)}`);
  }
  for (const id of storedMap.keys()) if (!rebuiltMap.has(id)) failures.push(`${names.injected}:${String(id).slice(0, 48)}`);
  if (!failures.some(code => code.startsWith(names.removed) || code.startsWith(names.injected) || code.startsWith(names.dup))) {
    if (canonical(stored.map(record => record[key])) !== canonical(rebuilt.map(record => record[key]))) failures.push(names.order);
  }
}

/** Verifies a stored corroboration snapshot against the run directories under `root`. */
export function verifyCorroborationSnapshot(root, snapshotId) {
  const failures = [];
  const done = () => Object.freeze({ ok: failures.length === 0, failures: Object.freeze([...failures]) });
  const directory = guard(failures, 'SNAPSHOT_LOCATION', () => corroborationCorporaDirectoryOf(root, snapshotId));
  if (!directory) return done();
  const stored = loadCorroborationArtifacts(directory);
  failures.push(...stored.loadProblems);
  if (stored.extraFiles.length) failures.push(`EXTRA_FILES:${stored.extraFiles.join(',').slice(0, 80)}`);
  if (!stored.manifest) { failures.push('SNAPSHOT_MANIFEST_MISSING'); return done(); }

  const manifest = guard(failures, 'SNAPSHOT_MANIFEST_INVALID', () => validateSnapshotManifest(stored.manifest));
  if (!manifest) return done();
  if (manifest.snapshotFingerprint !== corroborationSnapshotFingerprintOf(manifest)) failures.push('SNAPSHOT_FINGERPRINT_MISMATCH');
  if (manifest.snapshotId !== snapshotId) failures.push('SNAPSHOT_ID_NE_DIRECTORY');

  const policy = guard(failures, 'POLICY_INVALID', () => validateCorpusPolicy({
    corpusPolicyVersion: manifest.corpusPolicyVersion, eligibleStatuses: manifest.eligibleStatuses,
  }));
  if (!policy) return done();
  if (canonical([...manifest.memberRunIds].sort()) !== canonical(manifest.memberRunIds)
    || new Set(manifest.memberRunIds).size !== manifest.memberRunIds.length) failures.push('MEMBER_RUN_IDS_NOT_SORTED_UNIQUE');
  if (canonical([...manifest.sourceRunManifestFingerprints].sort()) !== canonical(manifest.sourceRunManifestFingerprints)) {
    failures.push('SOURCE_RUN_FINGERPRINTS_NOT_SORTED');
  }
  if (new Set(manifest.sourceRunManifestFingerprints).size !== manifest.sourceRunManifestFingerprints.length) {
    failures.push('SOURCE_RUN_FINGERPRINTS_NOT_UNIQUE');
  }
  if (manifest.memberRunIds.length !== manifest.sourceRunManifestFingerprints.length) failures.push('MEMBER_RUN_SET_SIZE_MISMATCH');
  if (manifest.sourceRevisionEvidenceFingerprint !== digest(stored.revisionEvidence)) failures.push('SOURCE_REVISION_EVIDENCE_FINGERPRINT_DRIFT');
  const derivedId = guard(failures, 'SNAPSHOT_ID', () => deriveCorroborationSnapshotId(policy, manifest.sourceRunManifestFingerprints));
  if (derivedId !== undefined && derivedId !== manifest.snapshotId) failures.push('SNAPSHOT_ID_NE_DERIVED');

  // 1. authenticate every member run from the run directories
  const authenticated = [];
  const fingerprintSet = new Set(manifest.sourceRunManifestFingerprints);
  for (const runId of manifest.memberRunIds) {
    const auth = authenticateRun(root, runId, policy);
    if (!auth.ok) { failures.push(`RUN_NOT_ADMITTED:${runId}:${auth.reasons[0]}`); continue; }
    if (!fingerprintSet.has(auth.artifacts.manifest.manifestFingerprint)) failures.push(`RUN_MANIFEST_FINGERPRINT_CHANGED:${runId}`);
    authenticated.push(auth);
  }
  if (authenticated.length !== manifest.memberRunIds.length) return done();

  // 2. rebuild everything - with the snapshot's recorded source revision evidence
  const content = guard(failures, 'REBUILD', () => assembleCorroborationContent(authenticated, policy, stored.revisionEvidence));
  if (!content) return done();
  if (content.sourceTemporalSnapshotId !== manifest.sourceTemporalSnapshotId) failures.push('SOURCE_TEMPORAL_ID_DRIFT');
  if (content.sourceTemporalFingerprint !== manifest.sourceTemporalFingerprint) failures.push('SOURCE_TEMPORAL_FINGERPRINT_DRIFT');
  if (content.sourceCorpusFingerprint !== manifest.sourceCorpusFingerprint) failures.push('SOURCE_CORPUS_FINGERPRINT_DRIFT');

  for (const record of stored.coverageRecords) guard(failures, 'COVERAGE_RECORD_INVALID', () => validateCoverageRecord(record));
  for (const record of stored.observationCoverageRecords) guard(failures, 'OBSERVATION_COVERAGE_RECORD_INVALID', () => validateObservationCoverageRecord(record));
  compareSets(failures, stored.coverageRecords, content.coverageRecords, 'mint',
    { removed: 'COVERAGE_REMOVED', injected: 'COVERAGE_INJECTED', modified: 'COVERAGE_MODIFIED', dup: 'COVERAGE_DUPLICATED', order: 'COVERAGE_ORDER_NONCANONICAL' });
  compareSets(failures, stored.observationCoverageRecords, content.observationCoverageRecords, 'upstreamIdentity',
    { removed: 'OBSERVATION_COVERAGE_REMOVED', injected: 'OBSERVATION_COVERAGE_INJECTED', modified: 'OBSERVATION_COVERAGE_MODIFIED', dup: 'OBSERVATION_COVERAGE_DUPLICATED', order: 'OBSERVATION_COVERAGE_ORDER_NONCANONICAL' });

  // 3. stored artifacts must match the manifest's digests, and the manifest the rebuild
  if (manifest.recordsDigest !== digest(stored.coverageRecords)) failures.push('DIGEST_DRIFT:recordsDigest:artifact');
  if (manifest.observationCoverageDigest !== digest(stored.observationCoverageRecords)) failures.push('DIGEST_DRIFT:observationCoverageDigest:artifact');
  if (manifest.coverageDigest !== digest(content.aggregate)) failures.push('DIGEST_DRIFT:coverageDigest:rebuild');

  const rebuilt = buildSnapshotManifest(content, manifest.createdAt);
  for (const field of PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_SCHEMA.fields) {
    if (field === 'snapshotFingerprint' || canonical(manifest[field]) === canonical(rebuilt[field])) continue;
    if (PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_SCHEMA.digestFields.includes(field)) failures.push(`DIGEST_DRIFT:${field}`);
    else if (PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_SCHEMA.countFields.includes(field)) failures.push(`COUNT_DRIFT:${field}`);
    else if (field === 'classification') failures.push('CLASSIFICATION_MISMATCH');
    else if (field === 'coverageClassification') failures.push('COVERAGE_CLASSIFICATION_MISMATCH');
    else failures.push(`MANIFEST_FIELD_DRIFT:${field}`);
  }
  for (const code of checkSnapshotCounts(manifest)) failures.push(code);
  return done();
}
