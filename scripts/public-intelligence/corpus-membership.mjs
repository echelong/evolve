// Phase 5K.4 - CORPUS POLICY, RUN DISCOVERY, RUN AUTHENTICATION, MEMBERSHIP.
//
// A corpus never rewrites a run. It READS finalized 5K.3 runs, authenticates each
// one end to end, and records a closed membership entry bound to the run's own
// manifest fingerprint. If the underlying manifest changes, membership is invalid.
//
// OFFLINE BY CONSTRUCTION: filesystem reads only. No network, no clock, no env.
// RESEARCH/OBSERVER-ONLY (5K.0): classification is inherited, never widened.
import { lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { PUBLIC_INTELLIGENCE_CLASSIFICATION, canonical, digest } from './definition.mjs';
import { failClosed } from './observation.mjs';
import { runDirectoryOf, assertSafeRuntimeRoot, loadRunArtifacts } from './run-store.mjs';
import { verifyRunArtifacts } from './replay.mjs';

export const PUBLIC_INTELLIGENCE_5K4_PHASE = 'PHASE_5K_4';
export const PUBLIC_INTELLIGENCE_5K4_SCHEMA_VERSION = '5K.4.0';
export const PUBLIC_INTELLIGENCE_5K4_CORPUS_POLICY_VERSION = 'corpus-policy-1';
export const PUBLIC_INTELLIGENCE_5K4_MEMBERSHIP_RECORD_TYPE = 'public_corpus_membership';

/**
 * Run statuses that may EVER be admitted by a policy. Everything else
 * (RATE_LIMITED, TIMEOUT, PROVIDER_ERROR, FAILED_INTEGRITY, REFUSED) can never
 * enter a corpus, whatever a policy says: a policy listing them is refused.
 */
export const PUBLIC_INTELLIGENCE_5K4_ADMISSIBLE_STATUSES = Object.freeze(['COMPLETED', 'PARTIAL']);

/** The conservative default: COMPLETED only. PARTIAL requires an explicit policy. */
export const PUBLIC_INTELLIGENCE_5K4_DEFAULT_POLICY = Object.freeze({
  corpusPolicyVersion: PUBLIC_INTELLIGENCE_5K4_CORPUS_POLICY_VERSION,
  eligibleStatuses: Object.freeze(['COMPLETED']),
});

/** Validates a closed policy and returns it in canonical (sorted, frozen) form. */
export function validateCorpusPolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) failClosed('PUBLIC_INTELLIGENCE_5K4_POLICY_INVALID');
  for (const key of Object.keys(policy)) {
    if (!['corpusPolicyVersion', 'eligibleStatuses'].includes(key)) failClosed(`PUBLIC_INTELLIGENCE_5K4_POLICY_UNKNOWN_FIELD:${key}`);
  }
  if (policy.corpusPolicyVersion !== PUBLIC_INTELLIGENCE_5K4_CORPUS_POLICY_VERSION) failClosed('PUBLIC_INTELLIGENCE_5K4_POLICY_VERSION_INVALID');
  if (!Array.isArray(policy.eligibleStatuses) || policy.eligibleStatuses.length === 0) failClosed('PUBLIC_INTELLIGENCE_5K4_POLICY_STATUSES_INVALID');
  const statuses = [...new Set(policy.eligibleStatuses)].sort();
  if (statuses.length !== policy.eligibleStatuses.length) failClosed('PUBLIC_INTELLIGENCE_5K4_POLICY_STATUSES_DUPLICATED');
  for (const status of statuses) {
    if (!PUBLIC_INTELLIGENCE_5K4_ADMISSIBLE_STATUSES.includes(status)) failClosed(`PUBLIC_INTELLIGENCE_5K4_POLICY_STATUS_NEVER_ELIGIBLE:${String(status).slice(0, 32)}`);
  }
  if (!statuses.includes('COMPLETED')) failClosed('PUBLIC_INTELLIGENCE_5K4_POLICY_MUST_INCLUDE_COMPLETED');
  return Object.freeze({ corpusPolicyVersion: policy.corpusPolicyVersion, eligibleStatuses: Object.freeze(statuses) });
}

/** Builds a policy; `includePartial` is the single explicit switch that admits PARTIAL runs. */
export const buildCorpusPolicy = ({ includePartial = false } = {}) => validateCorpusPolicy({
  corpusPolicyVersion: PUBLIC_INTELLIGENCE_5K4_CORPUS_POLICY_VERSION,
  eligibleStatuses: includePartial ? ['COMPLETED', 'PARTIAL'] : ['COMPLETED'],
});

export const corpusPolicyFingerprint = policy => digest(validateCorpusPolicy(policy));

const RUN_DIRECTORY = /^run-[0-9a-f]{32}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// RUN AUTHENTICATION
// ---------------------------------------------------------------------------

/**
 * Authenticates ONE run end to end. Nothing is trusted: not the directory name,
 * not the manifest counts. The run must (a) sit in a directory named after its
 * own manifest run id, (b) pass the full 5K.3 verification (plan, request
 * sequence, manifest, raw evidence, normalized observations, replay, accounting,
 * classification), and (c) have a status the policy admits.
 *
 * Returns { ok, reasons[], runId, status, artifacts }. Never throws on a bad run.
 */
export function authenticateRun(root, runId, policyInput = PUBLIC_INTELLIGENCE_5K4_DEFAULT_POLICY) {
  const policy = validateCorpusPolicy(policyInput);
  const reasons = [];
  let directory;
  try { directory = runDirectoryOf(root, runId); } catch (error) {
    return Object.freeze({ ok: false, reasons: Object.freeze([`RUN_ID_OR_ROOT_REFUSED:${String(error.message).split(':')[0].slice(-60)}`]), runId, status: null, artifacts: null });
  }
  let stat = null;
  try { stat = lstatSync(directory); } catch { /* absent */ }
  if (!stat) return Object.freeze({ ok: false, reasons: Object.freeze(['RUN_MISSING']), runId, status: null, artifacts: null });
  if (stat.isSymbolicLink() || !stat.isDirectory()) return Object.freeze({ ok: false, reasons: Object.freeze(['RUN_NOT_A_PLAIN_DIRECTORY']), runId, status: null, artifacts: null });

  const artifacts = loadRunArtifacts(directory);
  const verification = verifyRunArtifacts(artifacts);
  if (!verification.ok) reasons.push(...verification.failures.map(code => `RUN_VERIFICATION:${code}`));
  const manifest = artifacts.manifest;
  const status = manifest && typeof manifest === 'object' ? manifest.status ?? null : null;
  if (manifest && manifest.runId !== runId) reasons.push('RUN_DIRECTORY_NAME_NE_MANIFEST_RUN_ID');
  if (status !== null && !policy.eligibleStatuses.includes(status)) reasons.push(`RUN_STATUS_NOT_ELIGIBLE:${String(status).slice(0, 32)}`);
  if (verification.ok) {
    if (canonical(manifest.classification) !== canonical(PUBLIC_INTELLIGENCE_CLASSIFICATION)) reasons.push('RUN_CLASSIFICATION_MISMATCH');
  }
  return Object.freeze({ ok: reasons.length === 0, reasons: Object.freeze(reasons), runId, status, artifacts: reasons.length === 0 ? artifacts : null });
}

// ---------------------------------------------------------------------------
// MEMBERSHIP
// ---------------------------------------------------------------------------

export const PUBLIC_INTELLIGENCE_5K4_MEMBERSHIP_SCHEMA = Object.freeze({
  closed: true,
  fields: Object.freeze([
    'schemaVersion', 'recordType', 'corpusPolicyVersion', 'runId', 'runManifestFingerprint', 'collectionPlanFingerprint',
    'provider', 'instance', 'query', 'startedAt', 'completedAt', 'status', 'partial',
    'rawRecordCount', 'normalizedRecordCount', 'providerRecordsSeen', 'membershipFingerprint',
  ]),
});

export const membershipFingerprintOf = record => {
  const body = { ...record };
  delete body.membershipFingerprint;
  return digest(body);
};

/** Builds the membership record for an AUTHENTICATED run. */
export function buildMembershipRecord(authentication, policyInput = PUBLIC_INTELLIGENCE_5K4_DEFAULT_POLICY) {
  const policy = validateCorpusPolicy(policyInput);
  if (!authentication?.ok || !authentication.artifacts) failClosed('PUBLIC_INTELLIGENCE_5K4_MEMBERSHIP_REQUIRES_AUTHENTICATED_RUN');
  const m = authentication.artifacts.manifest;
  const body = {
    schemaVersion: PUBLIC_INTELLIGENCE_5K4_SCHEMA_VERSION,
    recordType: PUBLIC_INTELLIGENCE_5K4_MEMBERSHIP_RECORD_TYPE,
    corpusPolicyVersion: policy.corpusPolicyVersion,
    runId: m.runId,
    runManifestFingerprint: m.manifestFingerprint,
    collectionPlanFingerprint: m.collectionPlanFingerprint,
    provider: m.provider,
    instance: m.instance,
    query: { type: m.query.type, value: m.query.value },
    startedAt: m.startedAt,
    completedAt: m.completedAt,
    status: m.status,
    // A non-COMPLETED member is always visibly marked; it is never presented as complete.
    partial: m.status !== 'COMPLETED',
    rawRecordCount: m.rawEvidenceRecordsWritten,
    normalizedRecordCount: m.normalizedRecordsWritten,
    providerRecordsSeen: m.providerRecordsSeen,
  };
  return JSON.parse(canonical({ ...body, membershipFingerprint: digest(body) }));
}

/** Closed-schema validation of a stored membership record (shape + own fingerprint). */
export function validateMembershipRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) failClosed('PUBLIC_INTELLIGENCE_5K4_MEMBERSHIP_NOT_AN_OBJECT');
  const fields = PUBLIC_INTELLIGENCE_5K4_MEMBERSHIP_SCHEMA.fields;
  for (const key of Object.keys(record)) if (!fields.includes(key)) failClosed(`PUBLIC_INTELLIGENCE_5K4_MEMBERSHIP_UNKNOWN_FIELD:${key}`);
  for (const key of fields) if (!Object.hasOwn(record, key)) failClosed(`PUBLIC_INTELLIGENCE_5K4_MEMBERSHIP_FIELD_MISSING:${key}`);
  if (record.schemaVersion !== PUBLIC_INTELLIGENCE_5K4_SCHEMA_VERSION || record.recordType !== PUBLIC_INTELLIGENCE_5K4_MEMBERSHIP_RECORD_TYPE) failClosed('PUBLIC_INTELLIGENCE_5K4_MEMBERSHIP_TYPE_INVALID');
  if (!RUN_DIRECTORY.test(record.runId)) failClosed('PUBLIC_INTELLIGENCE_5K4_MEMBERSHIP_RUN_ID_INVALID');
  for (const key of ['runManifestFingerprint', 'collectionPlanFingerprint', 'membershipFingerprint']) {
    if (!FINGERPRINT.test(record[key])) failClosed(`PUBLIC_INTELLIGENCE_5K4_MEMBERSHIP_FINGERPRINT_INVALID:${key}`);
  }
  if (!PUBLIC_INTELLIGENCE_5K4_ADMISSIBLE_STATUSES.includes(record.status)) failClosed('PUBLIC_INTELLIGENCE_5K4_MEMBERSHIP_STATUS_NOT_ADMISSIBLE');
  if (record.partial !== (record.status !== 'COMPLETED')) failClosed('PUBLIC_INTELLIGENCE_5K4_MEMBERSHIP_PARTIAL_MARK_INVALID');
  for (const key of ['rawRecordCount', 'normalizedRecordCount', 'providerRecordsSeen', 'startedAt', 'completedAt']) {
    if (!Number.isSafeInteger(record[key]) || record[key] < 0) failClosed(`PUBLIC_INTELLIGENCE_5K4_MEMBERSHIP_COUNT_INVALID:${key}`);
  }
  if (record.membershipFingerprint !== membershipFingerprintOf(record)) failClosed('PUBLIC_INTELLIGENCE_5K4_MEMBERSHIP_FINGERPRINT_MISMATCH');
  return record;
}

// ---------------------------------------------------------------------------
// DISCOVERY (read-only, deterministic)
// ---------------------------------------------------------------------------

export const PUBLIC_INTELLIGENCE_5K4_DISCOVERY = Object.freeze({
  ELIGIBLE: 'ELIGIBLE',
  INELIGIBLE_STATUS: 'INELIGIBLE_STATUS',
  INVALID: 'INVALID',
  UNFINALIZED: 'UNFINALIZED',
  IGNORED: 'IGNORED',
});

/**
 * Enumerates `<root>/runs`, sorted by name (never by filesystem order). Entries
 * that do not look like runs (temp files, dot-files, other names) are IGNORED.
 * Anything that LOOKS like a run but fails authentication is reported explicitly
 * as INVALID / UNFINALIZED / INELIGIBLE_STATUS - never silently skipped.
 */
export function discoverRuns(root, policyInput = PUBLIC_INTELLIGENCE_5K4_DEFAULT_POLICY) {
  const policy = validateCorpusPolicy(policyInput);
  const safeRoot = assertSafeRuntimeRoot(root);
  const runsDirectory = path.join(safeRoot, 'runs');
  let names = [];
  try { names = readdirSync(runsDirectory); } catch { return Object.freeze([]); }
  const D = PUBLIC_INTELLIGENCE_5K4_DISCOVERY;
  return Object.freeze([...names].sort().map(name => {
    if (!name.startsWith('run-')) return Object.freeze({ name, classification: D.IGNORED, reasons: Object.freeze(['NOT_A_RUN_NAME']) });
    if (!RUN_DIRECTORY.test(name)) return Object.freeze({ name, classification: D.INVALID, reasons: Object.freeze(['RUN_LIKE_NAME_INVALID']) });
    const auth = authenticateRun(safeRoot, name, policy);
    if (auth.ok) return Object.freeze({ name, classification: D.ELIGIBLE, reasons: Object.freeze([]), status: auth.status });
    if (auth.reasons.includes('RUN_VERIFICATION:MANIFEST_MISSING_UNFINALIZED_RUN')) return Object.freeze({ name, classification: D.UNFINALIZED, reasons: auth.reasons });
    if (auth.reasons.every(reason => reason.startsWith('RUN_STATUS_NOT_ELIGIBLE'))) return Object.freeze({ name, classification: D.INELIGIBLE_STATUS, reasons: auth.reasons, status: auth.status });
    return Object.freeze({ name, classification: D.INVALID, reasons: auth.reasons });
  }));
}
