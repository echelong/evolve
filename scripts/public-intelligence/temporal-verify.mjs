// Phase 5K.5 - OFFLINE TEMPORAL SNAPSHOT VERIFIER.
//
// Trusts nothing stored in the snapshot. It re-authenticates every member run
// from the run directories, rebuilds the entire temporal content from scratch,
// and compares that against what the snapshot stores, reporting a named failure
// for every discrepancy. Nothing is ever repaired.
//
// 5K.5.1 - THE REVISION-EVIDENCE SIDECAR IS PART OF THE SOURCE DEFINITION.
//
// A declared revision is reproducible only from the sidecar it came from, so the
// rebuild uses the sidecar STORED WITH the snapshot - never a guess, never an
// empty default. Three cases, all fail-closed:
//
//   BOUND     the manifest declares `revisionEvidenceDigest`. The sidecar file
//             must exist, must match the declared count and digest, and every
//             record in it must satisfy the closed 5K.5 revision-evidence schema
//             before a single record is used.
//   UNBOUND   no binding: this is a snapshot written before 5K.5.1. It stays
//             verifiable exactly as it always was, as long as NOTHING it stores
//             depends on revision evidence.
//   REQUIRED  stored records carry a provider-declared revision timestamp while
//             no binding exists: the evidence is missing and CANNOT be
//             reconstructed. A specific named failure, not a silent empty
//             default, and never a re-derivation from the snapshot's own output.
//
// OFFLINE BY CONSTRUCTION: filesystem reads only. No network, no clock, no env.
//
// This also proves the backward-compatibility claim structurally: because the
// rebuild goes through the untouched 5K.3 run verifier and the untouched 5K.1
// provenance/normalization chain, any drift in historical evidence surfaces here
// rather than being absorbed by 5K.5 semantics.
import { canonical, digest } from './definition.mjs';
import {
  loadTemporalArtifacts, temporalCorporaDirectoryOf, deriveTemporalSnapshotId,
  temporalSnapshotFingerprintOf, validateSnapshotManifest, buildSnapshotManifest,
  assembleTemporalContent, PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_SCHEMA,
  PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_FILES,
} from './temporal-snapshot.mjs';
import { validateCorpusPolicy, authenticateRun } from './corpus-membership.mjs';
import { validateContentRecord, validateObservationRecord, checkTemporalAccounting } from './temporal-corpus.mjs';
import { validateObservationStateRecord } from './observation-state.mjs';
import {
  validateRevisionRecord, validateRevisionEvidence, verifyRevisionChain, verifyConflictedChainStructure,
} from './revision-chain.mjs';

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
    if (canonical(stored.map(record => record[key])) !== canonical(rebuilt.map(record => record[key]))) failures.push(names.order);
  }
}

/** Verifies a stored temporal snapshot against the run directories under `root`. */
export function verifyTemporalSnapshot(root, snapshotId) {
  const failures = [];
  const done = () => Object.freeze({ ok: failures.length === 0, failures: Object.freeze([...failures]) });
  const directory = guard(failures, 'SNAPSHOT_LOCATION', () => temporalCorporaDirectoryOf(root, snapshotId));
  if (!directory) return done();
  const stored = loadTemporalArtifacts(directory);
  failures.push(...stored.loadProblems);
  if (stored.extraFiles.length) failures.push(`EXTRA_FILES:${stored.extraFiles.join(',').slice(0, 80)}`);
  if (!stored.manifest) { failures.push('SNAPSHOT_MANIFEST_MISSING'); return done(); }

  const manifest = guard(failures, 'SNAPSHOT_MANIFEST_INVALID', () => validateSnapshotManifest(stored.manifest));
  if (!manifest) return done();
  if (manifest.snapshotFingerprint !== temporalSnapshotFingerprintOf(manifest)) failures.push('SNAPSHOT_FINGERPRINT_MISMATCH');
  if (manifest.temporalSnapshotId !== snapshotId) failures.push('SNAPSHOT_ID_NE_DIRECTORY');

  const policy = guard(failures, 'POLICY_INVALID', () => validateCorpusPolicy({
    corpusPolicyVersion: manifest.corpusPolicyVersion, eligibleStatuses: manifest.eligibleStatuses,
  }));
  if (!policy) return done();
  if (canonical([...manifest.runIds].sort()) !== canonical(manifest.runIds) || new Set(manifest.runIds).size !== manifest.runIds.length) {
    failures.push('RUN_IDS_NOT_SORTED_UNIQUE');
  }
  const derivedId = guard(failures, 'SNAPSHOT_ID', () => deriveTemporalSnapshotId(policy, manifest.runManifestFingerprints));
  if (derivedId !== undefined && derivedId !== manifest.temporalSnapshotId) failures.push('SNAPSHOT_ID_NE_DERIVED');

  // 1. THE REVISION-EVIDENCE SIDECAR. Resolved BEFORE any rebuild, so a missing
  //    or unbound proof is reported as its own specific failure and is never
  //    silently substituted by an empty evidence set.
  const evidenceBound = Object.hasOwn(manifest, 'revisionEvidenceDigest');
  const evidencePresent = !stored.missingFiles.includes(PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_FILES.revisionEvidence);
  // Does anything the snapshot STORES depend on revision evidence? A
  // provider-declared timestamp on any stored observation or revision record can
  // only have come from a sidecar. (Version 0 never carries one, and an ordinary
  // corpus carries none at all, so an affected pre-5K.5.1 snapshot is provable
  // from its own stored records without reading anything else.)
  const evidenceRequired = stored.observationRecords.some(record => record && record.providerRevisionTimestamp !== null)
    || stored.revisions.some(record => record && record.providerRevisionTimestamp !== null);
  let revisionEvidence = [];
  if (evidenceBound) {
    if (!evidencePresent) failures.push('REVISION_EVIDENCE_ARTIFACT_MISSING');
    if (manifest.revisionEvidenceDigest !== digest(stored.revisionEvidence)) failures.push('REVISION_EVIDENCE_DIGEST_DRIFT');
    if (manifest.revisionEvidenceCount !== stored.revisionEvidence.length) failures.push('REVISION_EVIDENCE_COUNT_DRIFT');
    for (const record of stored.revisionEvidence) guard(failures, 'REVISION_EVIDENCE_INVALID', () => validateRevisionEvidence(record));
    if (evidencePresent) revisionEvidence = stored.revisionEvidence;
  } else if (stored.revisionEvidence.length > 0) {
    // Evidence the snapshot does not bind may not enter the rebuild: an
    // unauthenticated sidecar is exactly what a tamper looks like.
    failures.push('REVISION_EVIDENCE_PRESENT_WITHOUT_BINDING');
  } else if (evidenceRequired) {
    // Missing proof is missing, and is never reconstructed from the snapshot's
    // own output or re-derived from the runs.
    failures.push('REVISION_EVIDENCE_REQUIRED_BUT_ABSENT');
  }

  // 2. authenticate every member run from the run directories
  const authenticated = [];
  manifest.runIds.forEach((runId, position) => {
    const auth = authenticateRun(root, runId, policy);
    if (!auth.ok) { failures.push(`RUN_NOT_ADMITTED:${runId}:${auth.reasons[0]}`); return; }
    if (auth.artifacts.manifest.manifestFingerprint !== manifest.runManifestFingerprints[position]) {
      failures.push(`RUN_MANIFEST_FINGERPRINT_CHANGED:${runId}`);
    }
    authenticated.push(auth);
  });
  if (authenticated.length !== manifest.runIds.length) return done();

  // 3. rebuild everything - using exactly the sidecar the snapshot persisted
  const content = guard(failures, 'REBUILD', () => assembleTemporalContent(authenticated, policy, revisionEvidence));
  if (!content) return done();

  for (const record of stored.contentRecords) guard(failures, 'CONTENT_RECORD_INVALID', () => validateContentRecord(record));
  for (const record of stored.observationRecords) guard(failures, 'OBSERVATION_RECORD_INVALID', () => validateObservationRecord(record));
  for (const record of stored.states) guard(failures, 'STATE_RECORD_INVALID', () => validateObservationStateRecord(record));
  for (const record of stored.revisions) guard(failures, 'REVISION_RECORD_INVALID', () => validateRevisionRecord(record));

  compareSets(failures, stored.contentRecords, content.contentRecords, 'upstreamIdentity',
    { removed: 'CONTENT_REMOVED', injected: 'CONTENT_INJECTED', modified: 'CONTENT_MODIFIED', dup: 'CONTENT_DUPLICATED', order: 'CONTENT_ORDER_NONCANONICAL' });
  compareSets(failures, stored.observationRecords, content.observationRecords, 'observationRecordFingerprint',
    { removed: 'OBSERVATION_REMOVED', injected: 'OBSERVATION_INJECTED', modified: 'OBSERVATION_MODIFIED', dup: 'OBSERVATION_DUPLICATED', order: 'OBSERVATION_ORDER_NONCANONICAL' });
  compareSets(failures, stored.states, content.states, 'stateRecordFingerprint',
    { removed: 'STATE_SNAPSHOT_REMOVED', injected: 'STATE_SNAPSHOT_INJECTED', modified: 'STATE_SNAPSHOT_MODIFIED', dup: 'STATE_SNAPSHOT_DUPLICATED', order: 'STATE_ORDER_NONCANONICAL' });
  compareSets(failures, stored.revisions, content.revisions, 'revisionFingerprint',
    { removed: 'REVISION_REMOVED', injected: 'REVISION_INJECTED', modified: 'REVISION_MODIFIED', dup: 'REVISION_DUPLICATED', order: 'REVISION_ORDER_NONCANONICAL' });

  // 4. every revision chain must be internally consistent - and a CONFLICT is
  //    not a broken chain. An identity the content records report as conflicted
  //    has, by definition, no valid provider declaration on some non-first
  //    version, so only its structure is required of it; an identity that is not
  //    conflicted must satisfy every proof-order rule.
  const byIdentity = new Map();
  for (const record of stored.revisions) {
    if (!byIdentity.has(record.upstreamIdentity)) byIdentity.set(record.upstreamIdentity, []);
    byIdentity.get(record.upstreamIdentity).push(record);
  }
  const conflictedIdentities = new Set(stored.contentRecords
    .filter(record => record && record.conflicted === true)
    .map(record => record.upstreamIdentity));
  for (const [identity, records] of byIdentity) {
    const conflicted = conflictedIdentities.has(identity)
      || records.some(record => record && record.providerRevisionTimestamp === null && record.supersedesContentFingerprint !== null);
    const chain = conflicted ? verifyConflictedChainStructure(records) : verifyRevisionChain(records);
    for (const code of chain.failures) failures.push(`${code}:${identity.slice(0, 40)}`);
  }

  // 5. stored artifacts must match the manifest digests, and the manifest the rebuild
  for (const [name, artifact] of [['contentDigest', stored.contentRecords], ['observationDigest', stored.observationRecords],
    ['stateDigest', stored.states], ['revisionDigest', stored.revisions]]) {
    if (manifest[name] !== digest(artifact)) failures.push(`DIGEST_DRIFT:${name}:artifact`);
  }
  const rebuilt = buildSnapshotManifest(content, manifest.createdAt);
  for (const field of [...PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_SCHEMA.fields, ...PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_SCHEMA.optionalFields]) {
    if (field === 'snapshotFingerprint') continue;
    // A pre-5K.5.1 snapshot has no binding fields at all - including on the
    // rebuild it is being compared against. Its absence is not a drift.
    if (!Object.hasOwn(manifest, field)) continue;
    if (canonical(manifest[field]) === canonical(rebuilt[field])) continue;
    if (PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_SCHEMA.digestFields.includes(field)) failures.push(`DIGEST_DRIFT:${field}`);
    else if (PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_SCHEMA.countFields.includes(field)) failures.push(`COUNT_DRIFT:${field}`);
    else if (field === 'classification') failures.push('CLASSIFICATION_MISMATCH');
    else if (field === 'revisionEvidenceDigest' || field === 'revisionEvidenceCount') failures.push(`REVISION_EVIDENCE_BINDING_DRIFT:${field}`);
    else failures.push(`MANIFEST_FIELD_DRIFT:${field}`);
  }
  for (const code of checkTemporalAccounting(content.accounting, content).problems) failures.push(`ACCOUNTING_DRIFT:${code}`);
  return done();
}
