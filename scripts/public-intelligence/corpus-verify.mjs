// Phase 5K.4 - OFFLINE SNAPSHOT VERIFIER.
//
// Trusts nothing stored in the snapshot. It re-authenticates every member run
// from the run directories, rebuilds the entire corpus content from scratch, and
// compares that to what the snapshot stores, reporting a named failure for every
// discrepancy. Nothing is repaired.
//
// OFFLINE BY CONSTRUCTION: filesystem reads only. No network, no clock.
import { canonical, digest } from './definition.mjs';
import { PUBLIC_INTELLIGENCE_5K4_SNAPSHOT_FILES, loadSnapshotArtifacts, corporaDirectoryOf, deriveSnapshotId, snapshotFingerprintOf,
  validateSnapshotManifest, checkSnapshotCounts, buildSnapshotManifest, assembleSnapshotContent, PUBLIC_INTELLIGENCE_5K4_SNAPSHOT_SCHEMA } from './corpus-snapshot.mjs';
import { validateCorpusPolicy, authenticateRun, validateMembershipRecord } from './corpus-membership.mjs';
import { validateObservationRecord, validateConflictRecord } from './corpus-index.mjs';

const guard = (failures, code, fn) => { try { return fn(); } catch (error) { failures.push(`${code}:${String(error?.message ?? error).split(':').slice(0, 2).join(':').slice(0, 90)}`); return undefined; } };

/** Compares stored vs rebuilt record sets keyed by `key`, reporting removed / injected / modified. */
function compareSets(failures, stored, rebuilt, key, names) {
  const storedMap = new Map(); const rebuiltMap = new Map();
  for (const record of stored) {
    if (storedMap.has(record[key])) failures.push(`${names.dup}:${String(record[key]).slice(0, 40)}`);
    storedMap.set(record[key], record);
  }
  for (const record of rebuilt) rebuiltMap.set(record[key], record);
  for (const [id, record] of rebuiltMap) {
    if (!storedMap.has(id)) failures.push(`${names.removed}:${String(id).slice(0, 40)}`);
    else if (canonical(storedMap.get(id)) !== canonical(record)) failures.push(`${names.modified}:${String(id).slice(0, 40)}`);
  }
  for (const id of storedMap.keys()) if (!rebuiltMap.has(id)) failures.push(`${names.injected}:${String(id).slice(0, 40)}`);
  if (!failures.some(code => code.startsWith(names.removed) || code.startsWith(names.injected) || code.startsWith(names.dup))) {
    if (canonical(stored.map(record => record[key])) !== canonical(rebuilt.map(record => record[key]))) failures.push(`${names.order}`);
  }
}

/** Verifies a stored snapshot against the run directories under `root`. Returns { ok, failures }. */
export function verifySnapshot(root, snapshotId) {
  const failures = [];
  const done = () => Object.freeze({ ok: failures.length === 0, failures: Object.freeze([...failures]) });
  const directory = guard(failures, 'SNAPSHOT_LOCATION', () => corporaDirectoryOf(root, snapshotId));
  if (!directory) return done();
  const stored = loadSnapshotArtifacts(directory);
  failures.push(...stored.loadProblems);
  if (stored.extraFiles.length) failures.push(`EXTRA_FILES:${stored.extraFiles.join(',').slice(0, 80)}`);
  if (!stored.present[PUBLIC_INTELLIGENCE_5K4_SNAPSHOT_FILES.snapshot]) { failures.push('SNAPSHOT_MANIFEST_MISSING'); return done(); }
  if (failures.length && !stored.manifest) return done();
  const manifest = guard(failures, 'SNAPSHOT_MANIFEST_INVALID', () => validateSnapshotManifest(stored.manifest));
  if (!manifest) return done();

  if (manifest.snapshotFingerprint !== snapshotFingerprintOf(manifest)) failures.push('SNAPSHOT_FINGERPRINT_MISMATCH');
  if (manifest.snapshotId !== snapshotId) failures.push('SNAPSHOT_ID_NE_DIRECTORY');
  const policy = guard(failures, 'POLICY_INVALID', () => validateCorpusPolicy({ corpusPolicyVersion: manifest.corpusPolicyVersion, eligibleStatuses: manifest.eligibleStatuses }));
  if (!policy) return done();
  if (canonical([...manifest.runIds].sort()) !== canonical(manifest.runIds) || new Set(manifest.runIds).size !== manifest.runIds.length) failures.push('RUN_IDS_NOT_SORTED_UNIQUE');
  const derivedId = guard(failures, 'SNAPSHOT_ID', () => deriveSnapshotId(policy, manifest.runManifestFingerprints));
  if (derivedId !== undefined && derivedId !== manifest.snapshotId) failures.push('SNAPSHOT_ID_NE_DERIVED');

  // 1. authenticate every member run from the run directories
  const authenticated = [];
  manifest.runIds.forEach((runId, position) => {
    const auth = authenticateRun(root, runId, policy);
    if (!auth.ok) { failures.push(`RUN_NOT_ADMITTED:${runId}:${auth.reasons[0]}`); return; }
    if (auth.artifacts.manifest.manifestFingerprint !== manifest.runManifestFingerprints[position]) failures.push(`RUN_MANIFEST_FINGERPRINT_CHANGED:${runId}`);
    authenticated.push(auth);
  });
  if (authenticated.length !== manifest.runIds.length) return done();

  // 2. rebuild everything and compare
  const content = guard(failures, 'REBUILD', () => assembleSnapshotContent(authenticated, policy));
  if (!content) return done();
  for (const record of stored.memberships) guard(failures, 'MEMBERSHIP_RECORD_INVALID', () => validateMembershipRecord(record));
  for (const record of stored.observations) guard(failures, 'OBSERVATION_RECORD_INVALID', () => validateObservationRecord(record));
  for (const record of stored.conflicts) guard(failures, 'CONFLICT_RECORD_INVALID', () => validateConflictRecord(record));
  compareSets(failures, stored.memberships, content.memberships, 'runId',
    { removed: 'MEMBERSHIP_REMOVED', injected: 'MEMBERSHIP_INJECTED', modified: 'MEMBERSHIP_MODIFIED', dup: 'MEMBERSHIP_DUPLICATED', order: 'MEMBERSHIP_ORDER_NONCANONICAL' });
  compareSets(failures, stored.observations, content.observations, 'upstreamIdentity',
    { removed: 'OBSERVATION_REMOVED', injected: 'OBSERVATION_INJECTED', modified: 'OBSERVATION_MODIFIED', dup: 'OBSERVATION_DUPLICATED', order: 'OBSERVATION_ORDER_NONCANONICAL' });
  compareSets(failures, stored.conflicts, content.conflicts, 'upstreamIdentity',
    { removed: 'CONFLICT_SUPPRESSED', injected: 'CONFLICT_INJECTED', modified: 'CONFLICT_MODIFIED', dup: 'CONFLICT_DUPLICATED', order: 'CONFLICT_ORDER_NONCANONICAL' });

  // 3. the stored artifacts must match the manifest's digests, and the manifest the rebuild
  for (const [name, artifact] of [['membershipDigest', stored.memberships], ['observationIndexDigest', stored.observations], ['conflictDigest', stored.conflicts]]) {
    if (manifest[name] !== digest(artifact)) failures.push(`DIGEST_DRIFT:${name}:artifact`);
  }
  const rebuilt = buildSnapshotManifest(content, manifest.createdAt);
  for (const field of PUBLIC_INTELLIGENCE_5K4_SNAPSHOT_SCHEMA.fields) {
    if (field === 'snapshotFingerprint' || canonical(manifest[field]) === canonical(rebuilt[field])) continue;
    if (PUBLIC_INTELLIGENCE_5K4_SNAPSHOT_SCHEMA.digestFields.includes(field)) failures.push(`DIGEST_DRIFT:${field}`);
    else if (PUBLIC_INTELLIGENCE_5K4_SNAPSHOT_SCHEMA.countFields.includes(field)) failures.push(`COUNT_DRIFT:${field}`);
    else if (field === 'classification') failures.push('CLASSIFICATION_MISMATCH');
    else failures.push(`MANIFEST_FIELD_DRIFT:${field}`);
  }
  for (const code of checkSnapshotCounts(manifest)) failures.push(code);
  return done();
}
