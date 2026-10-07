// Phase 5K.9 - OFFLINE DESCRIPTIVE FEATURE VERIFIER.
//
// Trusts nothing stored in the feature snapshot. It:
//   1. REQUIRES every source authority the manifest DECLARES - the verified run
//      corpus, the 5K.5 temporal snapshot, the 5K.7 corroboration snapshot and
//      the 5K.8 lineage snapshot - to be present on disk and to verify green,
//      and resolves each declared source fingerprint to that verified artifact;
//   2. re-authenticates every member run (5K.4) from the run directories;
//   3. rebuilds the verified 5K.5/5K.7/5K.8 derivation and recomputes every
//      feature from scratch, using the revision evidence the snapshot recorded;
//   4. compares that against what the snapshot stores and reports a named
//      failure for every discrepancy. Nothing is ever repaired.
//
// WHY "DECLARED", NOT "PRESENT ON DISK" (5K.9 correction)
//
// A verifier that verifies whichever sources happen to exist, and silently
// skips the rest, accepts a snapshot whose declared source was deleted, moved
// or never written - precisely the substitution it exists to catch. The source
// set this phase derives from is the one its schema NAMES, so each of those
// names must resolve:
//
//   - the snapshot directory is derived from the declared source id, so a
//     missing, renamed or foreign source id is a hard failure;
//   - the source must verify under its OWN verifier, against the same runs;
//   - the declared source fingerprint is RE-DERIVED from the verified artifact's
//     own governed digests, so a green-but-different source cannot stand in for
//     the one that was declared. `sourceTemporalSnapshotFingerprint` is only
//     resolved by a persisted 5K.5 snapshot that verifies and whose content
//     digests are the ones the fingerprint was derived from.
//
// OFFLINE BY CONSTRUCTION: filesystem reads only. No network, no clock, no
// environment, no provider contact, no live market call.
import { existsSync } from 'node:fs';
import { canonical, digest } from './definition.mjs';
import { validateCorpusPolicy, authenticateRun } from './corpus-membership.mjs';
import { temporalCorporaDirectoryOf, loadTemporalArtifacts } from './temporal-snapshot.mjs';
import { verifyTemporalSnapshot } from './temporal-verify.mjs';
import { corroborationCorporaDirectoryOf, loadCorroborationArtifacts } from './corroboration-snapshot.mjs';
import { verifyCorroborationSnapshot } from './corroboration-verify.mjs';
import {
  lineageCorporaDirectoryOf, loadLineageArtifacts, temporalSourceFingerprintOf, corroborationSourceFingerprintOf,
} from './lineage-snapshot.mjs';
import { verifyLineageSnapshot } from './lineage-verify.mjs';
import {
  loadFeatureArtifacts, featureCorporaDirectoryOf, deriveFeatureSnapshotId,
  featureSnapshotFingerprintOf, validateFeatureSnapshotManifest, buildFeatureSnapshotManifest,
  assembleFeatureContent, checkFeatureSnapshotCounts, PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_SCHEMA,
  lineageSourceFingerprintOf,
} from './feature-snapshot.mjs';
import { validateMintFeature } from './feature-extract.mjs';

const guard = (failures, code, fn) => {
  try { return fn(); } catch (error) {
    failures.push(`${code}:${String(error?.message ?? error).split(':').slice(0, 2).join(':').slice(0, 90)}`);
    return undefined;
  }
};

/**
 * REQUIRES one DECLARED source snapshot to be present and green.
 *
 * Never a conditional check: an undeclared-but-present source is ignored, and a
 * declared-but-absent one is a hard failure. Returns the verifier result so the
 * caller can resolve the declared fingerprint against the verified artifact.
 */
function requireSource(failures, label, declaredId, directory, verify) {
  if (!declaredId || !directory) { failures.push(`${label}_SOURCE_LOCATION_INVALID`); return null; }
  if (!existsSync(directory)) { failures.push(`${label}_SOURCE_SNAPSHOT_MISSING`); return null; }
  const result = verify();
  if (!result.ok) { failures.push(`${label}_SOURCE_SNAPSHOT_NOT_VERIFIED:${result.failures[0]}`); return null; }
  return result;
}

/** Verifies a stored feature snapshot against the run directories under `root`. */
export function verifyFeatureSnapshot(root, snapshotId) {
  const failures = [];
  const done = () => Object.freeze({ ok: failures.length === 0, failures: Object.freeze([...failures]) });
  const directory = guard(failures, 'SNAPSHOT_LOCATION', () => featureCorporaDirectoryOf(root, snapshotId));
  if (!directory) return done();
  const stored = loadFeatureArtifacts(directory);
  failures.push(...stored.loadProblems);
  if (stored.extraFiles.length) failures.push(`EXTRA_FILES:${stored.extraFiles.join(',').slice(0, 80)}`);
  if (!stored.manifest) { failures.push('SNAPSHOT_MANIFEST_MISSING'); return done(); }

  const manifest = guard(failures, 'SNAPSHOT_MANIFEST_INVALID', () => validateFeatureSnapshotManifest(stored.manifest));
  if (!manifest) return done();
  if (manifest.snapshotFingerprint !== featureSnapshotFingerprintOf(manifest)) failures.push('SNAPSHOT_FINGERPRINT_MISMATCH');
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
  const derivedId = guard(failures, 'SNAPSHOT_ID', () => deriveFeatureSnapshotId(policy, manifest.sourceRunManifestFingerprints));
  if (derivedId !== undefined && derivedId !== manifest.snapshotId) failures.push('SNAPSHOT_ID_NE_DERIVED');

  // 1. every source authority the manifest DECLARES must be present and green.
  const temporalDirectory = guard(failures, 'SOURCE_TEMPORAL_LOCATION', () => temporalCorporaDirectoryOf(root, manifest.sourceTemporalSnapshotId));
  const corroborationDirectory = guard(failures, 'SOURCE_CORROBORATION_LOCATION', () => corroborationCorporaDirectoryOf(root, manifest.sourceCorroborationSnapshotId));
  const lineageDirectory = guard(failures, 'SOURCE_LINEAGE_LOCATION', () => lineageCorporaDirectoryOf(root, manifest.sourceLineageSnapshotId));
  const temporalSource = requireSource(failures, 'TEMPORAL', manifest.sourceTemporalSnapshotId, temporalDirectory,
    () => verifyTemporalSnapshot(root, manifest.sourceTemporalSnapshotId));
  const corroborationSource = requireSource(failures, 'CORROBORATION', manifest.sourceCorroborationSnapshotId, corroborationDirectory,
    () => verifyCorroborationSnapshot(root, manifest.sourceCorroborationSnapshotId));
  const lineageSource = requireSource(failures, 'LINEAGE', manifest.sourceLineageSnapshotId, lineageDirectory,
    () => verifyLineageSnapshot(root, manifest.sourceLineageSnapshotId));

  // 1a. each declared source FINGERPRINT must RESOLVE to that verified artifact.
  //     The value is re-derived here from the source's own governed digests, so
  //     "some snapshot with this id verifies" is not enough - it must be the one
  //     whose content the declared fingerprint was derived from.
  if (temporalSource) {
    const source = guard(failures, 'SOURCE_TEMPORAL_MANIFEST', () => loadTemporalArtifacts(temporalDirectory).manifest);
    const resolved = source ? temporalSourceFingerprintOf(source) : null;
    if (resolved !== manifest.sourceTemporalSnapshotFingerprint) failures.push('SOURCE_TEMPORAL_FINGERPRINT_UNRESOLVED');
  }
  if (corroborationSource) {
    const source = guard(failures, 'SOURCE_CORROBORATION_MANIFEST', () => loadCorroborationArtifacts(corroborationDirectory).manifest);
    const resolved = source ? corroborationSourceFingerprintOf({
      sourceCorroborationSnapshotId: source.snapshotId,
      coverageDigest: source.coverageDigest,
      recordsDigest: source.recordsDigest,
      observationCoverageDigest: source.observationCoverageDigest,
    }) : null;
    if (resolved !== manifest.sourceCorroborationSnapshotFingerprint) failures.push('SOURCE_CORROBORATION_FINGERPRINT_UNRESOLVED');
  }
  if (lineageSource) {
    const source = guard(failures, 'SOURCE_LINEAGE_MANIFEST', () => loadLineageArtifacts(lineageDirectory).manifest);
    const resolved = source ? lineageSourceFingerprintOf({
      sourceLineageSnapshotId: source.snapshotId,
      lineageDigest: source.lineageDigest,
      contentVersionDigest: source.contentVersionDigest,
    }) : null;
    if (resolved !== manifest.sourceLineageSnapshotFingerprint) failures.push('SOURCE_LINEAGE_FINGERPRINT_UNRESOLVED');
  }

  // 2. re-authenticate every member run from the run directories.
  const authenticated = [];
  const fingerprintSet = new Set(manifest.sourceRunManifestFingerprints);
  for (const runId of manifest.memberRunIds) {
    const auth = authenticateRun(root, runId, policy);
    if (!auth.ok) { failures.push(`RUN_NOT_ADMITTED:${runId}:${auth.reasons[0]}`); continue; }
    if (!fingerprintSet.has(auth.artifacts.manifest.manifestFingerprint)) failures.push(`RUN_MANIFEST_FINGERPRINT_CHANGED:${runId}`);
    authenticated.push(auth);
  }
  if (authenticated.length !== manifest.memberRunIds.length) return done();

  // 3. recompute everything deterministically. This is also the VERIFIED CORPUS
  //    SOURCE authority: every member run was re-authenticated against its own
  //    manifest fingerprint above, and the derived corpus fingerprint is
  //    compared to the declared one below.
  const content = guard(failures, 'REBUILD', () => assembleFeatureContent(authenticated, policy, stored.revisionEvidence));
  if (!content) return done();
  if (content.sourceTemporalSnapshotId !== manifest.sourceTemporalSnapshotId) failures.push('SOURCE_TEMPORAL_ID_DRIFT');
  if (content.sourceTemporalSnapshotFingerprint !== manifest.sourceTemporalSnapshotFingerprint) failures.push('SOURCE_TEMPORAL_FINGERPRINT_DRIFT');
  if (content.sourceCorroborationSnapshotId !== manifest.sourceCorroborationSnapshotId) failures.push('SOURCE_CORROBORATION_ID_DRIFT');
  if (content.sourceCorroborationSnapshotFingerprint !== manifest.sourceCorroborationSnapshotFingerprint) failures.push('SOURCE_CORROBORATION_FINGERPRINT_DRIFT');
  if (content.sourceLineageSnapshotId !== manifest.sourceLineageSnapshotId) failures.push('SOURCE_LINEAGE_ID_DRIFT');
  if (content.sourceLineageSnapshotFingerprint !== manifest.sourceLineageSnapshotFingerprint) failures.push('SOURCE_LINEAGE_FINGERPRINT_DRIFT');
  if (content.sourceCorpusFingerprint !== manifest.sourceCorpusFingerprint) failures.push('SOURCE_CORPUS_FINGERPRINT_DRIFT');

  // 4. every stored record must satisfy the closed schema and match the rebuild.
  const storedByMint = new Map();
  const rebuiltByMint = new Map();
  for (const record of stored.features) {
    if (storedByMint.has(record.mint)) failures.push(`FEATURE_DUPLICATED:${String(record.mint).slice(0, 48)}`);
    guard(failures, 'FEATURE_RECORD_INVALID', () => validateMintFeature(record));
    storedByMint.set(record.mint, record);
  }
  for (const record of content.records) rebuiltByMint.set(record.mint, record);
  for (const [mint, record] of rebuiltByMint) {
    if (!storedByMint.has(mint)) failures.push(`FEATURE_REMOVED:${String(mint).slice(0, 48)}`);
    else if (canonical(storedByMint.get(mint)) !== canonical(record)) failures.push(`FEATURE_MODIFIED:${String(mint).slice(0, 48)}`);
  }
  for (const mint of storedByMint.keys()) if (!rebuiltByMint.has(mint)) failures.push(`FEATURE_INJECTED:${String(mint).slice(0, 48)}`);
  if (canonical(stored.features.map(record => record.mint)) !== canonical([...stored.features.map(record => record.mint)].sort())) {
    failures.push('FEATURE_ORDER_NONCANONICAL');
  }

  // 5. digests and manifest fields.
  if (manifest.featuresDigest !== digest(stored.features)) failures.push('DIGEST_DRIFT:featuresDigest:artifact');
  if (manifest.summaryDigest !== digest(content.summary)) failures.push('DIGEST_DRIFT:summaryDigest:rebuild');
  if (content.featuresDigest !== digest(content.records)) failures.push('DIGEST_DRIFT:featuresDigest:rebuild');
  const rebuilt = buildFeatureSnapshotManifest(content, manifest.createdAt);
  for (const field of PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_SCHEMA.fields) {
    if (field === 'snapshotFingerprint' || canonical(manifest[field]) === canonical(rebuilt[field])) continue;
    if (PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_SCHEMA.digestFields.includes(field)) failures.push(`DIGEST_DRIFT:${field}`);
    else if (PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_SCHEMA.countFields.includes(field)) failures.push(`COUNT_DRIFT:${field}`);
    else if (field === 'classification') failures.push('CLASSIFICATION_MISMATCH');
    else failures.push(`MANIFEST_FIELD_DRIFT:${field}`);
  }
  for (const code of checkFeatureSnapshotCounts(manifest)) failures.push(code);
  return done();
}
