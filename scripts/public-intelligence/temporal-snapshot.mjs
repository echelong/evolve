// Phase 5K.5 - TEMPORAL SNAPSHOT: write-once storage and deep verification of a
// derived temporal index over a set of authenticated 5K.3 runs.
//
// IDENTITY vs AUTHENTICATION (kept deliberately separate):
//   temporalSnapshotId = "tsnap-" + first 32 hex of SHA-256(canonical{
//                         kind, temporalPolicyVersion, corpusPolicyVersion,
//                         sorted runManifestFingerprints }).
//                       Same authenticated run set + same policy => same id,
//                       regardless of run order, discovery order, or when the
//                       snapshot was built. `createdAt` does NOT participate.
//   snapshotFingerprint = SHA-256 of the complete canonical manifest minus that
//                       field. It DOES cover createdAt.
//
// BACKWARD COMPATIBILITY. This is a NEW, separately versioned artifact
// ('5K.5.0' / 'temporal-snapshot-1'). It is written to its own directory tree
// ('temporal-corpora/') and never overwrites or invalidates a 5K.4 corpus
// snapshot ('corpora/'). A 5K.4 snapshot remains verifiable and unchanged after
// 5K.5 exists; richer semantics being available is not a reason to reject
// history.
//
// 5K.5.1 - REPRODUCIBLE TEMPORAL REVISION EVIDENCE.
//
// A provider-declared revision exists ONLY because a revision-evidence sidecar
// was supplied when the index was built: `providerRevisionTimestamp` on every
// derived record, the PROVIDER_DECLARED_CONTENT_REVISION classification and the
// revision-chain link all come from that sidecar and from nothing else. A
// snapshot that records such a corpus but does not record the sidecar is
// therefore not reproducible: its verifier rebuilds without the proof and gets
// UNVERIFIED_CONTENT_DIVERGENCE where the snapshot says revision.
//
// The repair is additive and is exactly the pattern 5K.7-5K.9 already use: the
// sidecar is persisted beside the derived records as
// `source-revision-evidence.ndjson`, and the manifest binds it with
// `revisionEvidenceCount` + `revisionEvidenceDigest` (a fingerprint over the
// canonical, validated, fingerprint-sorted evidence array).
//
//   - the two binding fields are OPTIONAL on read, so a snapshot written before
//     5K.5.1 - which has neither the fields nor the file - still verifies
//     whenever nothing it stores depends on revision evidence;
//   - a snapshot whose stored records DO depend on revision evidence and which
//     declares no binding fails closed in the verifier rather than being
//     silently reconstructed;
//   - the file is governed, write-once, mode 0444, and empty (`0` bytes) when a
//     corpus carries no declared revision - absence of evidence is recorded as
//     an empty sidecar, never as a missing one.
//
// Corpus storage never touches a run directory and never writes under .evolve.
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { canonical, digest, PUBLIC_INTELLIGENCE_CLASSIFICATION, isValidTimestamp } from './definition.mjs';
import { failClosed } from './observation.mjs';
import { assertSafeRuntimeRoot } from './run-store.mjs';
import {
  PUBLIC_INTELLIGENCE_5K4_DEFAULT_POLICY, authenticateRun, buildMembershipRecord, validateCorpusPolicy,
} from './corpus-membership.mjs';
import {
  PUBLIC_INTELLIGENCE_5K5_PHASE, PUBLIC_INTELLIGENCE_5K5_SCHEMA_VERSION,
  PUBLIC_INTELLIGENCE_5K5_TEMPORAL_POLICY_VERSION,
} from './temporal-projection.mjs';
import { buildTemporalCorpus, computeTemporalAccounting, checkTemporalAccounting } from './temporal-corpus.mjs';
import { canonicalRevisionEvidence } from './revision-chain.mjs';

export const PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_RECORD_TYPE = 'public_temporal_snapshot';
export const PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_POLICY_VERSION = 'temporal-snapshot-1';
export const PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_FILES = Object.freeze({
  content: 'content-records.ndjson',
  observations: 'observation-records.ndjson',
  states: 'observation-states.ndjson',
  revisions: 'revisions.ndjson',
  // 5K.5.1: the governed source definition of every provider-declared revision
  // the derived records carry. Same filename 5K.7/5K.8/5K.9 already persist.
  revisionEvidence: 'source-revision-evidence.ndjson',
  snapshot: 'temporal-snapshot.json',
});
const SNAPSHOT_ID = /^tsnap-[0-9a-f]{32}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;

export const PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_SCHEMA = Object.freeze({
  closed: true,
  fields: Object.freeze([
    'schemaVersion', 'recordType', 'phase', 'temporalSnapshotId', 'temporalPolicyVersion',
    'snapshotPolicyVersion', 'corpusPolicyVersion', 'eligibleStatuses', 'createdAt',
    'membershipCount', 'runIds', 'runManifestFingerprints',
    'upstreamIdentityCount', 'contentVersionCount', 'observationRecordCount',
    'observationStateSnapshotCount', 'providerDeclaredRevisionCount', 'unverifiedDivergenceCount',
    'conflictedUpstreamIdentityCount', 'duplicateAppearanceCount',
    'associatedVersionCount', 'unassociatedVersionCount', 'invalidMintVersionCount', 'ambiguousVersionCount',
    'accounting', 'contentDigest', 'observationDigest', 'stateDigest', 'revisionDigest',
    'classification', 'snapshotFingerprint',
  ]),
  // ADDITIVE FROM 5K.5.1, and deliberately OPTIONAL. A snapshot written before
  // 5K.5.1 carries neither field and must remain readable; a snapshot written
  // after 5K.5.1 carries BOTH, or it is refused as incomplete. Nothing outside
  // this enumerated set is ever accepted, so the schema stays closed.
  optionalFields: Object.freeze(['revisionEvidenceCount', 'revisionEvidenceDigest']),
  countFields: Object.freeze([
    'membershipCount', 'upstreamIdentityCount', 'contentVersionCount', 'observationRecordCount',
    'observationStateSnapshotCount', 'providerDeclaredRevisionCount', 'unverifiedDivergenceCount',
    'conflictedUpstreamIdentityCount', 'duplicateAppearanceCount',
    'associatedVersionCount', 'unassociatedVersionCount', 'invalidMintVersionCount', 'ambiguousVersionCount',
  ]),
  digestFields: Object.freeze(['contentDigest', 'observationDigest', 'stateDigest', 'revisionDigest']),
});

const plain = value => JSON.parse(canonical(value));

/** Deterministic identity: policy + sorted run manifest fingerprints. No time. */
export function deriveTemporalSnapshotId(policyInput, runManifestFingerprints) {
  const policy = validateCorpusPolicy(policyInput);
  const sorted = [...runManifestFingerprints].sort();
  for (const fp of sorted) if (!FINGERPRINT.test(fp)) failClosed('PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_ID_FINGERPRINT_INVALID');
  if (new Set(sorted).size !== sorted.length) failClosed('PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_ID_DUPLICATE_RUN');
  return `tsnap-${digest({
    kind: 'public_temporal_snapshot_identity',
    temporalPolicyVersion: PUBLIC_INTELLIGENCE_5K5_TEMPORAL_POLICY_VERSION,
    snapshotPolicyVersion: PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_POLICY_VERSION,
    corpusPolicyVersion: policy.corpusPolicyVersion,
    eligibleStatuses: policy.eligibleStatuses,
    runManifestFingerprints: sorted,
  }).slice(0, 32)}`;
}

export const temporalSnapshotFingerprintOf = manifest => {
  const body = { ...manifest };
  delete body.snapshotFingerprint;
  return digest(body);
};

/** Authenticates every requested run under the policy. All-or-nothing. */
export function authenticateRuns(root, runIds, policyInput = PUBLIC_INTELLIGENCE_5K4_DEFAULT_POLICY) {
  const policy = validateCorpusPolicy(policyInput);
  if (!Array.isArray(runIds) || runIds.length === 0) failClosed('PUBLIC_INTELLIGENCE_5K5_RUN_SET_EMPTY');
  const unique = [...new Set(runIds)].sort();
  if (unique.length !== runIds.length) failClosed('PUBLIC_INTELLIGENCE_5K5_RUN_SET_DUPLICATE_RUN_ID');
  const authenticated = [];
  for (const runId of unique) {
    const auth = authenticateRun(root, runId, policy);
    if (!auth.ok) failClosed(`PUBLIC_INTELLIGENCE_5K5_RUN_NOT_ADMITTED:${runId}:${auth.reasons[0]}`);
    authenticated.push(auth);
  }
  return Object.freeze(authenticated);
}

/** Pure assembly of the reproducible temporal content from authenticated runs. */
export function assembleTemporalContent(authenticated, policyInput = PUBLIC_INTELLIGENCE_5K4_DEFAULT_POLICY, revisionEvidence = []) {
  const policy = validateCorpusPolicy(policyInput);
  // The source of every declared revision is canonicalized BEFORE it is used,
  // so the persisted sidecar and its digest depend on the evidence SET and not
  // on the order a caller collected it in.
  const evidence = Object.freeze(canonicalRevisionEvidence(revisionEvidence));
  const memberships = authenticated.map(auth => buildMembershipRecord(auth, policy))
    .sort((a, b) => (a.runId < b.runId ? -1 : 1));
  const runs = authenticated.map(auth => ({ manifest: auth.artifacts.manifest, observations: auth.artifacts.observations }));
  const index = buildTemporalCorpus(runs, { revisionEvidence: evidence });
  const accounting = { ...computeTemporalAccounting(index), runCount: memberships.length };
  const content = {
    policy,
    memberships,
    contentRecords: index.contentRecords,
    observationRecords: index.observationRecords,
    states: index.states,
    revisions: index.revisions,
    accounting,
    // The reproducible source definition, carried with the derived records so
    // the snapshot can persist it and a verifier can replay it exactly.
    revisionEvidence: evidence,
    revisionEvidenceCount: evidence.length,
    revisionEvidenceDigest: digest(evidence),
    contentDigest: digest(index.contentRecords),
    observationDigest: digest(index.observationRecords),
    stateDigest: digest(index.states),
    revisionDigest: digest(index.revisions),
  };
  return Object.freeze(content);
}

/** Authenticates the runs and assembles the content. Offline; reads runs only. */
export function rebuildTemporalSnapshot({ root, runIds, policy = PUBLIC_INTELLIGENCE_5K4_DEFAULT_POLICY, revisionEvidence = [] }) {
  return assembleTemporalContent(authenticateRuns(root, runIds, policy), policy, revisionEvidence);
}

/** Builds the closed snapshot manifest and refuses to emit an inconsistent one. */
export function buildSnapshotManifest(content, createdAt) {
  const A = content.accounting;
  const body = {
    schemaVersion: PUBLIC_INTELLIGENCE_5K5_SCHEMA_VERSION,
    recordType: PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_RECORD_TYPE,
    phase: PUBLIC_INTELLIGENCE_5K5_PHASE,
    temporalSnapshotId: deriveTemporalSnapshotId(content.policy, content.memberships.map(m => m.runManifestFingerprint)),
    temporalPolicyVersion: PUBLIC_INTELLIGENCE_5K5_TEMPORAL_POLICY_VERSION,
    snapshotPolicyVersion: PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_POLICY_VERSION,
    corpusPolicyVersion: content.policy.corpusPolicyVersion,
    eligibleStatuses: content.policy.eligibleStatuses,
    createdAt,
    membershipCount: content.memberships.length,
    runIds: content.memberships.map(m => m.runId),
    runManifestFingerprints: content.memberships.map(m => m.runManifestFingerprint),
    upstreamIdentityCount: A.upstreamIdentityCount,
    contentVersionCount: A.contentVersionCount,
    observationRecordCount: A.observationRecordCount,
    observationStateSnapshotCount: A.observationStateSnapshotCount,
    providerDeclaredRevisionCount: A.providerDeclaredRevisionCount,
    unverifiedDivergenceCount: A.unverifiedDivergenceCount,
    conflictedUpstreamIdentityCount: A.conflictedUpstreamIdentityCount,
    duplicateAppearanceCount: A.duplicateAppearanceCount,
    associatedVersionCount: A.associatedVersionCount,
    unassociatedVersionCount: A.unassociatedVersionCount,
    invalidMintVersionCount: A.invalidMintVersionCount,
    ambiguousVersionCount: A.ambiguousVersionCount,
    accounting: A,
    contentDigest: content.contentDigest,
    observationDigest: content.observationDigest,
    stateDigest: content.stateDigest,
    revisionDigest: content.revisionDigest,
    // 5K.5.1: the binding to the persisted revision-evidence sidecar. Always
    // emitted by THIS code, optional on read for snapshots written before it.
    revisionEvidenceCount: content.revisionEvidenceCount,
    revisionEvidenceDigest: content.revisionEvidenceDigest,
    classification: PUBLIC_INTELLIGENCE_CLASSIFICATION,
  };
  const manifest = plain({ ...body, snapshotFingerprint: digest(body) });
  validateSnapshotManifest(manifest);
  const problems = checkTemporalAccounting(A, content);
  if (!problems.ok) failClosed(`PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_ACCOUNTING_INCONSISTENT:${problems.problems[0]}`);
  return manifest;
}

/** Closed-schema + fingerprint-format validation of the stored manifest. */
export function validateSnapshotManifest(manifest) {
  const S = PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_SCHEMA;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) failClosed('PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_NOT_AN_OBJECT');
  for (const key of Object.keys(manifest)) {
    if (!S.fields.includes(key) && !S.optionalFields.includes(key)) failClosed(`PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_UNKNOWN_FIELD:${String(key).slice(0, 40)}`);
  }
  for (const key of S.fields) if (!Object.hasOwn(manifest, key)) failClosed(`PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_FIELD_MISSING:${key}`);
  // The additive revision-evidence binding is ALL-OR-NOTHING: a snapshot either
  // carries both fields (5K.5.1+) or neither (written before 5K.5.1).
  const binding = S.optionalFields.filter(key => Object.hasOwn(manifest, key));
  if (binding.length !== 0 && binding.length !== S.optionalFields.length) failClosed('PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_REVISION_BINDING_INCOMPLETE');
  if (binding.length === S.optionalFields.length) {
    if (!FINGERPRINT.test(manifest.revisionEvidenceDigest)) failClosed('PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_REVISION_EVIDENCE_DIGEST_INVALID');
    if (!Number.isSafeInteger(manifest.revisionEvidenceCount) || manifest.revisionEvidenceCount < 0) {
      failClosed('PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_REVISION_EVIDENCE_COUNT_INVALID');
    }
  }
  if (manifest.schemaVersion !== PUBLIC_INTELLIGENCE_5K5_SCHEMA_VERSION
    || manifest.recordType !== PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_RECORD_TYPE
    || manifest.phase !== PUBLIC_INTELLIGENCE_5K5_PHASE) failClosed('PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_TYPE_INVALID');
  if (!SNAPSHOT_ID.test(manifest.temporalSnapshotId)) failClosed('PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_ID_INVALID');
  if (manifest.temporalPolicyVersion !== PUBLIC_INTELLIGENCE_5K5_TEMPORAL_POLICY_VERSION) failClosed('PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_POLICY_VERSION_INVALID');
  validateCorpusPolicy({ corpusPolicyVersion: manifest.corpusPolicyVersion, eligibleStatuses: manifest.eligibleStatuses });
  for (const key of [...S.digestFields, 'snapshotFingerprint']) if (!FINGERPRINT.test(manifest[key])) failClosed(`PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_FINGERPRINT_INVALID:${key}`);
  for (const key of S.countFields) if (!Number.isSafeInteger(manifest[key]) || manifest[key] < 0) failClosed(`PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_COUNT_INVALID:${key}`);
  if (!isValidTimestamp(manifest.createdAt)) failClosed('PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_CREATED_AT_INVALID');
  if (!Array.isArray(manifest.runIds) || !Array.isArray(manifest.runManifestFingerprints)) failClosed('PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_RUN_LISTS_INVALID');
  if (canonical(manifest.classification) !== canonical(PUBLIC_INTELLIGENCE_CLASSIFICATION)) failClosed('PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_CLASSIFICATION_OVERRIDE_REFUSED');
  return manifest;
}

// ---------------------------------------------------------------------------
// STORAGE (write-once, own namespace, never .evolve)
// ---------------------------------------------------------------------------

/** 5K.5 snapshots live under `temporal-corpora/`, never beside 5K.4's `corpora/`. */
export function temporalCorporaDirectoryOf(root, snapshotId) {
  if (!SNAPSHOT_ID.test(snapshotId)) failClosed('PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_ID_INVALID');
  return path.join(assertSafeRuntimeRoot(root), 'temporal-corpora', snapshotId);
}

const lines = records => records.map(record => `${canonical(record)}\n`).join('');

/** Loads a stored snapshot directory. Never throws on a bad file; reports it. */
export function loadTemporalArtifacts(directory) {
  const F = PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_FILES;
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
    contentRecords: readNdjson(F.content),
    observationRecords: readNdjson(F.observations),
    states: readNdjson(F.states),
    revisions: readNdjson(F.revisions),
    revisionEvidence: readNdjson(F.revisionEvidence),
    // Which GOVERNED files are absent. A pre-5K.5.1 snapshot legitimately has no
    // sidecar, so absence is reported here and judged by the verifier against
    // what the manifest declares and what the stored records require - it is
    // never inferred from a load that quietly returned nothing.
    missingFiles: existsSync(directory) ? Object.values(F).filter(name => !existsSync(path.join(directory, name))).sort() : Object.values(F).slice().sort(),
    extraFiles: extra,
    loadProblems: problems,
  };
}

/**
 * Builds and stores a temporal snapshot, write-once.
 *  - new id            -> written to a private build directory, then renamed atomically
 *  - existing id, same reproducible content -> ALREADY_EXISTS_IDENTICAL (nothing written)
 *  - existing id, different content          -> refused (nothing written)
 */
export function buildAndStoreTemporalSnapshot({ root, runIds, policy = PUBLIC_INTELLIGENCE_5K4_DEFAULT_POLICY, createdAt, revisionEvidence = [] }) {
  const content = rebuildTemporalSnapshot({ root, runIds, policy, revisionEvidence });
  const manifest = buildSnapshotManifest(content, createdAt);
  const final = temporalCorporaDirectoryOf(root, manifest.temporalSnapshotId);
  if (existsSync(final)) {
    if (lstatSync(final).isSymbolicLink()) failClosed('PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_EXISTS_NOT_A_PLAIN_DIRECTORY');
    const stored = loadTemporalArtifacts(final);
    const same = stored.manifest
      && canonical({ ...stored.manifest, createdAt: 0, snapshotFingerprint: '' }) === canonical({ ...manifest, createdAt: 0, snapshotFingerprint: '' })
      && canonical(stored.contentRecords) === canonical(content.contentRecords)
      && canonical(stored.observationRecords) === canonical(content.observationRecords)
      && canonical(stored.states) === canonical(content.states)
      && canonical(stored.revisions) === canonical(content.revisions)
      && canonical(stored.revisionEvidence) === canonical(content.revisionEvidence);
    if (!same) failClosed('PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_EXISTS_DIFFERENT');
    return Object.freeze({ outcome: 'ALREADY_EXISTS_IDENTICAL', temporalSnapshotId: manifest.temporalSnapshotId, directory: final, manifest: stored.manifest });
  }
  const parent = path.dirname(final);
  mkdirSync(parent, { recursive: true });
  const building = path.join(parent, `.building-${manifest.temporalSnapshotId}`);
  mkdirSync(building); // exclusive: a stale or concurrent build refuses
  const F = PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_FILES;
  const write = (name, text) => writeFileSync(path.join(building, name), text, { flag: 'wx', mode: 0o444 });
  write(F.content, lines(content.contentRecords));
  write(F.observations, lines(content.observationRecords));
  write(F.states, lines(content.states));
  write(F.revisions, lines(content.revisions));
  // Always written, even when empty: a corpus with no declared revision records
  // its ABSENCE of evidence as an empty sidecar rather than a missing one, so a
  // verifier can distinguish "no proof was supplied" from "the proof was lost".
  write(F.revisionEvidence, lines(content.revisionEvidence));
  write(F.snapshot, `${canonical(manifest)}\n`);
  for (const name of Object.values(F)) chmodSync(path.join(building, name), 0o444);
  renameSync(building, final); // atomic; fails if `final` appeared meanwhile
  return Object.freeze({ outcome: 'CREATED', temporalSnapshotId: manifest.temporalSnapshotId, directory: final, manifest });
}
