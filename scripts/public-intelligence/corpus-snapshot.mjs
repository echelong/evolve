// Phase 5K.4 - CORPUS SNAPSHOT: closed manifest, deterministic identity, and
// write-once storage of an immutable view over a set of authenticated runs.
//
// IDENTITY vs AUTHENTICATION (kept deliberately separate):
//   snapshotId          = "snap-" + first 32 hex of SHA-256(canonical{
//                           kind, corpusPolicyVersion, eligibleStatuses,
//                           sorted runManifestFingerprints }).
//                         Same authenticated run set + same policy => same id,
//                         regardless of run order, discovery order, or when the
//                         snapshot was built. `createdAt` does NOT participate.
//   snapshotFingerprint = SHA-256 of the complete canonical manifest minus that
//                         field. It DOES cover createdAt: it authenticates this
//                         particular persisted manifest.
//   Reproducible content = memberships, observations, conflicts, counts, digests.
//   Execution-instance metadata = createdAt (and the fingerprint that covers it).
//
// Corpus storage never touches a run directory and never writes under .evolve.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PUBLIC_INTELLIGENCE_CLASSIFICATION, canonical, digest, isValidTimestamp } from './definition.mjs';
import { failClosed } from './observation.mjs';
import { assertSafeRuntimeRoot } from './run-store.mjs';
import {
  PUBLIC_INTELLIGENCE_5K4_PHASE, PUBLIC_INTELLIGENCE_5K4_SCHEMA_VERSION, PUBLIC_INTELLIGENCE_5K4_DEFAULT_POLICY,
  validateCorpusPolicy, authenticateRun, buildMembershipRecord,
} from './corpus-membership.mjs';
import { buildCorpusIndex, computeCoverage } from './corpus-index.mjs';

export const PUBLIC_INTELLIGENCE_5K4_SNAPSHOT_RECORD_TYPE = 'public_corpus_snapshot';
export const PUBLIC_INTELLIGENCE_5K4_SNAPSHOT_FILES = Object.freeze({
  membership: 'membership.ndjson', observations: 'observations.ndjson', conflicts: 'conflicts.ndjson', snapshot: 'snapshot.json',
});
const SNAPSHOT_ID = /^snap-[0-9a-f]{32}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;

export const PUBLIC_INTELLIGENCE_5K4_SNAPSHOT_SCHEMA = Object.freeze({
  closed: true,
  fields: Object.freeze([
    'schemaVersion', 'recordType', 'phase', 'snapshotId', 'corpusPolicyVersion', 'eligibleStatuses', 'createdAt',
    'membershipCount', 'runIds', 'runManifestFingerprints', 'providerCounts', 'statusCounts', 'partialRunCount',
    'rawRecordsReferenced', 'normalizedRecordsReferenced',
    'uniqueUpstreamObservations', 'canonicalObservationCount', 'duplicateAppearancesAcrossRuns',
    'conflictedUpstreamIdentities', 'conflictedAppearances',
    'associatedObservationCount', 'unassociatedObservationCount', 'invalidMintObservationCount', 'ambiguousObservationCount',
    'coverage', 'membershipDigest', 'observationIndexDigest', 'conflictDigest', 'classification', 'snapshotFingerprint',
  ]),
  countFields: Object.freeze([
    'membershipCount', 'partialRunCount', 'rawRecordsReferenced', 'normalizedRecordsReferenced', 'uniqueUpstreamObservations',
    'canonicalObservationCount', 'duplicateAppearancesAcrossRuns', 'conflictedUpstreamIdentities', 'conflictedAppearances',
    'associatedObservationCount', 'unassociatedObservationCount', 'invalidMintObservationCount', 'ambiguousObservationCount',
  ]),
  digestFields: Object.freeze(['membershipDigest', 'observationIndexDigest', 'conflictDigest']),
});

const plain = value => JSON.parse(canonical(value));

/** Deterministic identity: policy + sorted run manifest fingerprints. No time. */
export function deriveSnapshotId(policyInput, runManifestFingerprints) {
  const policy = validateCorpusPolicy(policyInput);
  const sorted = [...runManifestFingerprints].sort();
  for (const fp of sorted) if (!FINGERPRINT.test(fp)) failClosed('PUBLIC_INTELLIGENCE_5K4_SNAPSHOT_ID_FINGERPRINT_INVALID');
  if (new Set(sorted).size !== sorted.length) failClosed('PUBLIC_INTELLIGENCE_5K4_SNAPSHOT_ID_DUPLICATE_RUN');
  return `snap-${digest({ kind: 'public_corpus_snapshot_identity', corpusPolicyVersion: policy.corpusPolicyVersion, eligibleStatuses: policy.eligibleStatuses, runManifestFingerprints: sorted }).slice(0, 32)}`;
}

export const snapshotFingerprintOf = manifest => { const body = { ...manifest }; delete body.snapshotFingerprint; return digest(body); };

// ---------------------------------------------------------------------------
// CONTENT (pure) - the reproducible part
// ---------------------------------------------------------------------------

/** Authenticates every requested run under the policy. All-or-nothing: any failure throws. */
export function authenticateRuns(root, runIds, policyInput = PUBLIC_INTELLIGENCE_5K4_DEFAULT_POLICY) {
  const policy = validateCorpusPolicy(policyInput);
  if (!Array.isArray(runIds) || runIds.length === 0) failClosed('PUBLIC_INTELLIGENCE_5K4_RUN_SET_EMPTY');
  const unique = [...new Set(runIds)].sort();
  if (unique.length !== runIds.length) failClosed('PUBLIC_INTELLIGENCE_5K4_RUN_SET_DUPLICATE_RUN_ID');
  const authenticated = [];
  for (const runId of unique) {
    const auth = authenticateRun(root, runId, policy);
    if (!auth.ok) failClosed(`PUBLIC_INTELLIGENCE_5K4_RUN_NOT_ADMITTED:${runId}:${auth.reasons[0]}`);
    authenticated.push(auth);
  }
  return Object.freeze(authenticated);
}

/** Pure assembly of the reproducible corpus content from authenticated runs. */
export function assembleSnapshotContent(authenticated, policyInput = PUBLIC_INTELLIGENCE_5K4_DEFAULT_POLICY) {
  const policy = validateCorpusPolicy(policyInput);
  const memberships = authenticated.map(auth => buildMembershipRecord(auth, policy)).sort((a, b) => (a.runId < b.runId ? -1 : 1));
  const runs = authenticated.map(auth => ({ manifest: auth.artifacts.manifest, observations: auth.artifacts.observations }));
  const index = buildCorpusIndex(runs);
  const coverage = computeCoverage(memberships, index, runs);
  const content = {
    policy, memberships, observations: index.observations, conflicts: index.conflicts, coverage,
    membershipDigest: digest(memberships), observationIndexDigest: digest(index.observations), conflictDigest: digest(index.conflicts),
  };
  return Object.freeze(content);
}

/** Authenticates the runs and assembles the content. Offline; reads run directories only. */
export function rebuildCorpusSnapshot({ root, runIds, policy = PUBLIC_INTELLIGENCE_5K4_DEFAULT_POLICY }) {
  return assembleSnapshotContent(authenticateRuns(root, runIds, policy), policy);
}

/**
 * Snapshot count invariants:
 *   rawRecordsReferenced = normalizedRecordsReferenced
 *                        = canonicalObservations + duplicateAppearances + conflictedAppearances
 *   uniqueUpstreamObservations = canonicalObservations + conflictedUpstreamIdentities
 *   Σ association counts = canonicalObservations
 */
export function checkSnapshotCounts(manifest) {
  const problems = [];
  const m = manifest;
  const check = (condition, code) => { if (!condition) problems.push(code); };
  check(m.rawRecordsReferenced === m.canonicalObservationCount + m.duplicateAppearancesAcrossRuns + m.conflictedAppearances, 'COUNT_INVARIANT_RAW_REFERENCED');
  check(m.normalizedRecordsReferenced === m.rawRecordsReferenced, 'COUNT_INVARIANT_NORMALIZED_REFERENCED');
  check(m.uniqueUpstreamObservations === m.canonicalObservationCount + m.conflictedUpstreamIdentities, 'COUNT_INVARIANT_UNIQUE');
  check(m.associatedObservationCount + m.unassociatedObservationCount + m.invalidMintObservationCount + m.ambiguousObservationCount === m.canonicalObservationCount, 'COUNT_INVARIANT_ASSOCIATION');
  check(m.membershipCount === m.runIds.length && m.runIds.length === m.runManifestFingerprints.length, 'COUNT_INVARIANT_MEMBERSHIP');
  return problems;
}

/** Builds the closed snapshot manifest. `createdAt` is execution metadata only. */
export function buildSnapshotManifest(content, createdAt) {
  if (!isValidTimestamp(createdAt)) failClosed('PUBLIC_INTELLIGENCE_5K4_SNAPSHOT_CREATED_AT_INVALID');
  const { policy, memberships, coverage } = content;
  const runManifestFingerprints = memberships.map(member => member.runManifestFingerprint);
  const body = {
    schemaVersion: PUBLIC_INTELLIGENCE_5K4_SCHEMA_VERSION,
    recordType: PUBLIC_INTELLIGENCE_5K4_SNAPSHOT_RECORD_TYPE,
    phase: PUBLIC_INTELLIGENCE_5K4_PHASE,
    snapshotId: deriveSnapshotId(policy, runManifestFingerprints),
    corpusPolicyVersion: policy.corpusPolicyVersion,
    eligibleStatuses: [...policy.eligibleStatuses],
    createdAt,
    membershipCount: memberships.length,
    runIds: memberships.map(member => member.runId),
    runManifestFingerprints: memberships.map(member => member.runManifestFingerprint),
    providerCounts: coverage.providerCounts,
    statusCounts: coverage.statusCounts,
    partialRunCount: coverage.partialRuns,
    rawRecordsReferenced: memberships.reduce((sum, member) => sum + member.rawRecordCount, 0),
    normalizedRecordsReferenced: memberships.reduce((sum, member) => sum + member.normalizedRecordCount, 0),
    uniqueUpstreamObservations: coverage.uniqueUpstreamObservations,
    canonicalObservationCount: coverage.canonicalObservationCount,
    duplicateAppearancesAcrossRuns: coverage.duplicateAppearancesAcrossRuns,
    conflictedUpstreamIdentities: coverage.conflictedUpstreamIdentities,
    conflictedAppearances: coverage.conflictedAppearances,
    associatedObservationCount: coverage.associationCounts.EXACT_MINT,
    unassociatedObservationCount: coverage.associationCounts.UNASSOCIATED,
    invalidMintObservationCount: coverage.associationCounts.INVALID_MINT,
    ambiguousObservationCount: coverage.associationCounts.AMBIGUOUS,
    coverage,
    membershipDigest: content.membershipDigest,
    observationIndexDigest: content.observationIndexDigest,
    conflictDigest: content.conflictDigest,
    classification: PUBLIC_INTELLIGENCE_CLASSIFICATION,
  };
  const manifest = plain({ ...body, snapshotFingerprint: digest(body) });
  validateSnapshotManifest(manifest);
  const problems = checkSnapshotCounts(manifest);
  if (problems.length) failClosed(`PUBLIC_INTELLIGENCE_5K4_SNAPSHOT_COUNTS_INCONSISTENT:${problems[0]}`);
  return manifest;
}

/** Closed-schema + fingerprint-format validation (no cross-checking against runs). */
export function validateSnapshotManifest(manifest) {
  const S = PUBLIC_INTELLIGENCE_5K4_SNAPSHOT_SCHEMA;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) failClosed('PUBLIC_INTELLIGENCE_5K4_SNAPSHOT_NOT_AN_OBJECT');
  for (const key of Object.keys(manifest)) if (!S.fields.includes(key)) failClosed(`PUBLIC_INTELLIGENCE_5K4_SNAPSHOT_UNKNOWN_FIELD:${key}`);
  for (const key of S.fields) if (!Object.hasOwn(manifest, key)) failClosed(`PUBLIC_INTELLIGENCE_5K4_SNAPSHOT_FIELD_MISSING:${key}`);
  if (manifest.schemaVersion !== PUBLIC_INTELLIGENCE_5K4_SCHEMA_VERSION || manifest.recordType !== PUBLIC_INTELLIGENCE_5K4_SNAPSHOT_RECORD_TYPE || manifest.phase !== PUBLIC_INTELLIGENCE_5K4_PHASE) {
    failClosed('PUBLIC_INTELLIGENCE_5K4_SNAPSHOT_TYPE_INVALID');
  }
  if (!SNAPSHOT_ID.test(manifest.snapshotId)) failClosed('PUBLIC_INTELLIGENCE_5K4_SNAPSHOT_ID_INVALID');
  validateCorpusPolicy({ corpusPolicyVersion: manifest.corpusPolicyVersion, eligibleStatuses: manifest.eligibleStatuses });
  for (const key of [...S.digestFields, 'snapshotFingerprint']) if (!FINGERPRINT.test(manifest[key])) failClosed(`PUBLIC_INTELLIGENCE_5K4_SNAPSHOT_FINGERPRINT_INVALID:${key}`);
  for (const key of S.countFields) if (!Number.isSafeInteger(manifest[key]) || manifest[key] < 0) failClosed(`PUBLIC_INTELLIGENCE_5K4_SNAPSHOT_COUNT_INVALID:${key}`);
  if (!isValidTimestamp(manifest.createdAt)) failClosed('PUBLIC_INTELLIGENCE_5K4_SNAPSHOT_CREATED_AT_INVALID');
  if (!Array.isArray(manifest.runIds) || !Array.isArray(manifest.runManifestFingerprints)) failClosed('PUBLIC_INTELLIGENCE_5K4_SNAPSHOT_RUN_LISTS_INVALID');
  if (canonical(manifest.classification) !== canonical(PUBLIC_INTELLIGENCE_CLASSIFICATION)) failClosed('PUBLIC_INTELLIGENCE_5K4_SNAPSHOT_CLASSIFICATION_OVERRIDE_REFUSED');
  return manifest;
}

// ---------------------------------------------------------------------------
// STORAGE (write-once)
// ---------------------------------------------------------------------------

export function corporaDirectoryOf(root, snapshotId) {
  if (!SNAPSHOT_ID.test(snapshotId)) failClosed('PUBLIC_INTELLIGENCE_5K4_SNAPSHOT_ID_INVALID');
  return path.join(assertSafeRuntimeRoot(root), 'corpora', snapshotId);
}

const lines = records => records.map(record => `${canonical(record)}\n`).join('');

/** Loads a stored snapshot directory. Never throws on a bad file; reports it. */
export function loadSnapshotArtifacts(directory) {
  const F = PUBLIC_INTELLIGENCE_5K4_SNAPSHOT_FILES;
  const problems = [];
  const present = {};
  const readNdjson = name => {
    const target = path.join(directory, name);
    present[name] = existsSync(target);
    if (!present[name]) return [];
    const out = [];
    for (const line of readFileSync(target, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { problems.push(`LOAD_MALFORMED:${name}`); return []; }
    }
    return out;
  };
  let manifest = null;
  const manifestPath = path.join(directory, F.snapshot);
  present[F.snapshot] = existsSync(manifestPath);
  if (present[F.snapshot]) { try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { problems.push(`LOAD_MALFORMED:${F.snapshot}`); } }
  const extra = existsSync(directory) ? readdirSync(directory).filter(name => !Object.values(F).includes(name)).sort() : [];
  return {
    directory, manifest, memberships: readNdjson(F.membership), observations: readNdjson(F.observations), conflicts: readNdjson(F.conflicts),
    present, extraFiles: extra, loadProblems: problems,
  };
}

/**
 * Builds and stores a snapshot, write-once.
 *  - new id            -> written into a private build directory, then renamed atomically
 *  - existing id, same reproducible content -> ALREADY_EXISTS_IDENTICAL (nothing written)
 *  - existing id, different content          -> refused (nothing written)
 */
export function buildAndStoreSnapshot({ root, runIds, policy = PUBLIC_INTELLIGENCE_5K4_DEFAULT_POLICY, createdAt }) {
  const content = rebuildCorpusSnapshot({ root, runIds, policy });
  const manifest = buildSnapshotManifest(content, createdAt);
  const final = corporaDirectoryOf(root, manifest.snapshotId);
  if (existsSync(final)) {
    if (lstatSync(final).isSymbolicLink()) failClosed('PUBLIC_INTELLIGENCE_5K4_SNAPSHOT_EXISTS_NOT_A_PLAIN_DIRECTORY');
    const stored = loadSnapshotArtifacts(final);
    const same = stored.manifest
      && canonical({ ...stored.manifest, createdAt: 0, snapshotFingerprint: '' }) === canonical({ ...manifest, createdAt: 0, snapshotFingerprint: '' })
      && canonical(stored.memberships) === canonical(content.memberships)
      && canonical(stored.observations) === canonical(content.observations)
      && canonical(stored.conflicts) === canonical(content.conflicts);
    if (!same) failClosed('PUBLIC_INTELLIGENCE_5K4_SNAPSHOT_EXISTS_DIFFERENT');
    return Object.freeze({ outcome: 'ALREADY_EXISTS_IDENTICAL', snapshotId: manifest.snapshotId, directory: final, manifest: stored.manifest });
  }
  const parent = path.dirname(final);
  mkdirSync(parent, { recursive: true });
  const building = path.join(parent, `.building-${manifest.snapshotId}`);
  mkdirSync(building); // exclusive: a stale or concurrent build refuses
  const F = PUBLIC_INTELLIGENCE_5K4_SNAPSHOT_FILES;
  const write = (name, text) => writeFileSync(path.join(building, name), text, { flag: 'wx', mode: 0o444 });
  write(F.membership, lines(content.memberships));
  write(F.observations, lines(content.observations));
  write(F.conflicts, lines(content.conflicts));
  write(F.snapshot, `${canonical(manifest)}\n`);
  for (const name of Object.values(F)) chmodSync(path.join(building, name), 0o444);
  renameSync(building, final); // atomic; fails if `final` appeared meanwhile
  return Object.freeze({ outcome: 'CREATED', snapshotId: manifest.snapshotId, directory: final, manifest });
}
