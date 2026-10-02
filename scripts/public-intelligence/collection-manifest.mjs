// Phase 5K.3 - RUN MANIFEST + REQUEST RECORDS: closed schemas, accounting
// invariants, run identity and manifest fingerprints.
//
// PURE AND OFFLINE BY CONSTRUCTION. No network, no filesystem, no clock.
//
// RUN IDENTITY
//   runId             = "run-" + first 32 hex of SHA-256(canonical{
//                         collectionPlanFingerprint, startedAt, kind })
//                       It names ONE EXECUTION of ONE PLAN. It is not random:
//                       the same plan started at the same instant is the same
//                       execution identity, so a second attempt collides and is
//                       REFUSED rather than silently creating a twin.
//                       No scientific/result value ever enters it.
//   manifestFingerprint = SHA-256 of the canonical manifest WITHOUT that field.
//                       It authenticates what the run ACTUALLY did and found.
//
// Manifests hold aggregate counts and structural provider metadata only: no
// handle, name, bio, follower count, location, mention graph, header, cookie,
// credential or raw body.
import { PUBLIC_INTELLIGENCE_CLASSIFICATION, canonical, digest, isValidTimestamp } from './definition.mjs';
import { failClosed } from './observation.mjs';
import {
  PUBLIC_INTELLIGENCE_5K3_PHASE, PUBLIC_INTELLIGENCE_5K3_SCHEMA_VERSION, validateCollectionPlan,
  collectionPlanFingerprint,
} from './collection-plan.mjs';

export const PUBLIC_INTELLIGENCE_5K3_MANIFEST_RECORD_TYPE = 'public_collection_run_manifest';
export const PUBLIC_INTELLIGENCE_5K3_REQUEST_RECORD_TYPE = 'public_collection_request_record';

/**
 * Terminal run states. Exactly one applies to every finalized run.
 *
 *  COMPLETED        Every request succeeded, acquisition stopped for a planned
 *                   reason (END_OF_TIMELINE, MAX_PAGES, MAX_RECORDS,
 *                   LOOKBACK_REACHED), there were zero ingest conflicts and zero
 *                   integrity failures. Records the privacy mapper REFUSED are
 *                   expected and are counted, not failures.
 *  PARTIAL          Requests succeeded but acquisition is knowingly incomplete:
 *                   unusable pagination cursor, or one or more ingest conflicts.
 *  RATE_LIMITED     The provider answered 429. Zero retries. Evidence acquired
 *                   before the 429 is kept and counted.
 *  TIMEOUT          A request exceeded timeoutMs. Not retried.
 *  PROVIDER_ERROR   Any other provider/transport failure: network error, auth
 *                   required, 4xx, 5xx, invalid response, oversized response.
 *  REFUSED          A valid plan was refused BEFORE any provider contact (for
 *                   example the run id already exists). Returned in memory only:
 *                   nothing may be written over an existing run.
 *  FAILED_INTEGRITY Ingest or self-verification found an integrity failure.
 *
 * Only COMPLETED means "acquisition ended for a planned reason with nothing
 * unexplained". Every other state may still hold real, valid partial evidence.
 */
export const PUBLIC_INTELLIGENCE_5K3_RUN_STATUS = Object.freeze({
  COMPLETED: 'COMPLETED',
  PARTIAL: 'PARTIAL',
  RATE_LIMITED: 'RATE_LIMITED',
  TIMEOUT: 'TIMEOUT',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  REFUSED: 'REFUSED',
  FAILED_INTEGRITY: 'FAILED_INTEGRITY',
});
export const PUBLIC_INTELLIGENCE_5K3_RUN_STATUS_VALUES = Object.freeze(Object.values(PUBLIC_INTELLIGENCE_5K3_RUN_STATUS));

/** Closed failure vocabulary. Counts only; never messages, never evidence. */
export const PUBLIC_INTELLIGENCE_5K3_FAILURES = Object.freeze({
  RATE_LIMITED: 'RATE_LIMITED',
  TIMEOUT: 'TIMEOUT',
  NETWORK_ERROR: 'NETWORK_ERROR',
  PROVIDER_AUTH_REQUIRED: 'PROVIDER_AUTH_REQUIRED',
  PROVIDER_4XX: 'PROVIDER_4XX',
  PROVIDER_5XX: 'PROVIDER_5XX',
  INVALID_PROVIDER_RESPONSE: 'INVALID_PROVIDER_RESPONSE',
  OVERSIZED_RESPONSE: 'OVERSIZED_RESPONSE',
  MAPPING_REFUSED: 'MAPPING_REFUSED',
  INGEST_CONFLICT: 'INGEST_CONFLICT',
  INTEGRITY_FAILURE: 'INTEGRITY_FAILURE',
});
export const PUBLIC_INTELLIGENCE_5K3_FAILURE_VALUES = Object.freeze(Object.values(PUBLIC_INTELLIGENCE_5K3_FAILURES));
/** The subset that is a failed provider REQUEST (at most one per run: zero retries). */
export const PUBLIC_INTELLIGENCE_5K3_REQUEST_FAILURE_VALUES = Object.freeze([
  'RATE_LIMITED', 'TIMEOUT', 'NETWORK_ERROR', 'PROVIDER_AUTH_REQUIRED', 'PROVIDER_4XX', 'PROVIDER_5XX',
  'INVALID_PROVIDER_RESPONSE', 'OVERSIZED_RESPONSE',
]);

/** 5K.2 adapter error code -> 5K.3 failure class. Anything else is an integrity failure. */
export const PUBLIC_INTELLIGENCE_5K3_FAILURE_OF_ADAPTER_CODE = Object.freeze({
  PROVIDER_RATE_LIMITED: 'RATE_LIMITED',
  PROVIDER_TIMEOUT: 'TIMEOUT',
  PROVIDER_NETWORK_ERROR: 'NETWORK_ERROR',
  PROVIDER_AUTH_REQUIRED: 'PROVIDER_AUTH_REQUIRED',
  PROVIDER_CLIENT_ERROR_4XX: 'PROVIDER_4XX',
  PROVIDER_SERVER_ERROR_5XX: 'PROVIDER_5XX',
  PROVIDER_MALFORMED_RESPONSE: 'INVALID_PROVIDER_RESPONSE',
  PROVIDER_UNEXPECTED_CONTENT_TYPE: 'INVALID_PROVIDER_RESPONSE',
  PROVIDER_RESPONSE_TOO_LARGE: 'OVERSIZED_RESPONSE',
});

export const PUBLIC_INTELLIGENCE_5K3_STOP_REASONS = Object.freeze([
  'END_OF_TIMELINE', 'MAX_PAGES', 'MAX_RECORDS', 'LOOKBACK_REACHED', 'PAGINATION_CURSOR_UNUSABLE', 'REQUEST_FAILED', 'NOT_STARTED',
]);
const PLANNED_STOP_REASONS = Object.freeze(['END_OF_TIMELINE', 'MAX_PAGES', 'MAX_RECORDS', 'LOOKBACK_REACHED']);

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = value => Number.isSafeInteger(value) && value >= 0;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const REASON_KEY = /^[A-Z][A-Z0-9_]{0,63}$/;

function assertClosed(object, fields, code) {
  if (!isPlainObject(object)) failClosed(`${code}_NOT_AN_OBJECT`);
  const allowed = new Set(fields);
  for (const key of Object.keys(object)) if (!allowed.has(key)) failClosed(`${code}_UNKNOWN_FIELD:${key}`);
  for (const key of fields) if (!Object.hasOwn(object, key)) failClosed(`${code}_FIELD_MISSING:${key}`);
}

// ---------------------------------------------------------------------------
// REQUEST RECORDS
// ---------------------------------------------------------------------------

export const PUBLIC_INTELLIGENCE_5K3_REQUEST_SCHEMA = Object.freeze({
  closed: true,
  fields: Object.freeze([
    'schemaVersion', 'recordType', 'requestIndex', 'provider', 'instance', 'query', 'cursor',
    'requestedAt', 'completedAt', 'outcome', 'httpStatus', 'recordsReturned', 'responseBytes',
    'rateLimit', 'nextCursor',
  ]),
  rateLimitFields: Object.freeze(['retryAfterSeconds', 'rateLimitLimit', 'rateLimitRemaining', 'rateLimitReset']),
  // Structural by construction: these are the ONLY things a request record may say.
  persistsHeaders: false,
  persistsBody: false,
  persistsCredentials: false,
});

const nullableCount = value => value === null || isCount(value);

/** Validates one request record. Closed, structural, bounded. */
export function validateRequestRecord(record, plan = null) {
  assertClosed(record, PUBLIC_INTELLIGENCE_5K3_REQUEST_SCHEMA.fields, 'PUBLIC_INTELLIGENCE_5K3_REQUEST');
  if (record.schemaVersion !== PUBLIC_INTELLIGENCE_5K3_SCHEMA_VERSION) failClosed('PUBLIC_INTELLIGENCE_5K3_REQUEST_SCHEMA_VERSION_INVALID');
  if (record.recordType !== PUBLIC_INTELLIGENCE_5K3_REQUEST_RECORD_TYPE) failClosed('PUBLIC_INTELLIGENCE_5K3_REQUEST_RECORD_TYPE_INVALID');
  if (!isCount(record.requestIndex)) failClosed('PUBLIC_INTELLIGENCE_5K3_REQUEST_INDEX_INVALID');
  if (typeof record.provider !== 'string' || typeof record.instance !== 'string') failClosed('PUBLIC_INTELLIGENCE_5K3_REQUEST_PROVIDER_INVALID');
  assertClosed(record.query, ['type', 'value'], 'PUBLIC_INTELLIGENCE_5K3_REQUEST_QUERY');
  if (record.cursor !== null && !/^[0-9]{1,32}$/.test(String(record.cursor))) failClosed('PUBLIC_INTELLIGENCE_5K3_REQUEST_CURSOR_INVALID');
  if (!isValidTimestamp(record.requestedAt) || !isValidTimestamp(record.completedAt)) failClosed('PUBLIC_INTELLIGENCE_5K3_REQUEST_TIMESTAMP_INVALID');
  if (record.completedAt < record.requestedAt) failClosed('PUBLIC_INTELLIGENCE_5K3_REQUEST_TIME_REVERSED');
  if (record.outcome !== 'OK' && !PUBLIC_INTELLIGENCE_5K3_REQUEST_FAILURE_VALUES.includes(record.outcome)) {
    failClosed('PUBLIC_INTELLIGENCE_5K3_REQUEST_OUTCOME_INVALID');
  }
  if (record.httpStatus !== null && !(Number.isInteger(record.httpStatus) && record.httpStatus >= 100 && record.httpStatus <= 599)) {
    failClosed('PUBLIC_INTELLIGENCE_5K3_REQUEST_HTTP_STATUS_INVALID');
  }
  if (!nullableCount(record.recordsReturned) || !nullableCount(record.responseBytes)) failClosed('PUBLIC_INTELLIGENCE_5K3_REQUEST_COUNT_INVALID');
  if (record.outcome === 'OK' && (record.recordsReturned === null || record.responseBytes === null)) {
    failClosed('PUBLIC_INTELLIGENCE_5K3_REQUEST_OK_REQUIRES_COUNTS');
  }
  if (plan && record.responseBytes !== null && record.responseBytes > plan.bounds.maxResponseBytes) {
    failClosed('PUBLIC_INTELLIGENCE_5K3_REQUEST_RESPONSE_BYTES_EXCEED_CEILING');
  }
  if (record.rateLimit !== null) {
    assertClosed(record.rateLimit, PUBLIC_INTELLIGENCE_5K3_REQUEST_SCHEMA.rateLimitFields, 'PUBLIC_INTELLIGENCE_5K3_REQUEST_RATE_LIMIT');
    for (const key of ['retryAfterSeconds', 'rateLimitLimit', 'rateLimitRemaining']) {
      if (record.rateLimit[key] !== null && !(typeof record.rateLimit[key] === 'number' && Number.isFinite(record.rateLimit[key]))) {
        failClosed('PUBLIC_INTELLIGENCE_5K3_REQUEST_RATE_LIMIT_VALUE_INVALID');
      }
    }
    const reset = record.rateLimit.rateLimitReset;
    if (reset !== null && !(typeof reset === 'string' && reset.length <= 40)) failClosed('PUBLIC_INTELLIGENCE_5K3_REQUEST_RATE_LIMIT_VALUE_INVALID');
  }
  if (record.nextCursor !== null && !/^[0-9]{1,32}$/.test(String(record.nextCursor))) failClosed('PUBLIC_INTELLIGENCE_5K3_REQUEST_NEXT_CURSOR_INVALID');
  return record;
}

/** Projects a transport observer event into a closed request record. */
export function buildRequestRecord(plan, event) {
  const rl = event.rateLimit;
  return validateRequestRecord({
    schemaVersion: PUBLIC_INTELLIGENCE_5K3_SCHEMA_VERSION,
    recordType: PUBLIC_INTELLIGENCE_5K3_REQUEST_RECORD_TYPE,
    requestIndex: event.requestIndex,
    provider: plan.provider,
    instance: plan.instance,
    query: { type: plan.query.type, value: plan.query.value },
    cursor: event.cursor ?? null,
    requestedAt: event.requestedAt,
    completedAt: event.completedAt,
    outcome: event.outcome === 'OK' ? 'OK' : (PUBLIC_INTELLIGENCE_5K3_FAILURE_OF_ADAPTER_CODE[event.outcome] ?? 'INVALID_PROVIDER_RESPONSE'),
    httpStatus: event.httpStatus ?? null,
    recordsReturned: event.recordsReturned ?? null,
    responseBytes: event.responseBytes ?? null,
    // Whitelisted copy: no other header can ever ride along.
    rateLimit: rl ? {
      retryAfterSeconds: rl.retryAfterSeconds ?? null,
      rateLimitLimit: rl.rateLimitLimit ?? null,
      rateLimitRemaining: rl.rateLimitRemaining ?? null,
      rateLimitReset: rl.rateLimitReset ?? null,
    } : null,
    nextCursor: event.nextCursor ?? null,
  }, plan);
}

/** Fingerprint over the ordered request sequence: detects removal, reorder, edit. */
export const requestsFingerprint = requests => digest(requests);

// ---------------------------------------------------------------------------
// MANIFEST
// ---------------------------------------------------------------------------

export const PUBLIC_INTELLIGENCE_5K3_MANIFEST_SCHEMA = Object.freeze({
  closed: true,
  fields: Object.freeze([
    'schemaVersion', 'recordType', 'phase', 'runId', 'collectionPlanFingerprint', 'provider', 'instance', 'query',
    'startedAt', 'completedAt', 'status',
    'requestCount', 'pageCount',
    'providerRecordsSeen', 'recordsMapped', 'recordsIngested', 'duplicates', 'conflicts', 'refused', 'ingestFailures',
    'rawEvidenceRecordsWritten', 'normalizedRecordsWritten',
    'failureCounts', 'refusedReasons', 'providerCursorSummary',
    'requestsFingerprint', 'rawEvidenceFingerprint', 'observationsFingerprint',
    'classification', 'manifestFingerprint',
  ]),
  cursorSummaryFields: Object.freeze(['firstCursor', 'lastCursor', 'cursorsUsed', 'stopReason', 'nextCursorPresent']),
});

/**
 * ACCOUNTING INVARIANTS, derived from the real 5K.1 ingest semantics:
 * every mapped record ends in exactly one of {stored, ALREADY_PRESENT, conflict
 * throw, other throw}; a stored record writes exactly one raw line and one
 * normalized line; a duplicate writes nothing.
 *
 *  (1) providerRecordsSeen = recordsMapped + refused
 *  (2) recordsMapped       = recordsIngested + duplicates + conflicts + ingestFailures
 *  (3) rawEvidenceRecordsWritten = recordsIngested = normalizedRecordsWritten
 *  (4) requestCount = pageCount + failedRequests;  failedRequests <= 1 (zero retries)
 *  (5) failureCounts.MAPPING_REFUSED = refused = sum(refusedReasons)
 *      failureCounts.INGEST_CONFLICT = conflicts
 *      failureCounts.INTEGRITY_FAILURE >= ingestFailures
 *  (6) sum of failed-request failure classes = failedRequests
 *  (7) providerRecordsSeen <= sum(recordsReturned) and <= plan maxRecords;
 *      requestCount <= plan maxPages
 *  (8) startedAt <= completedAt
 *  (9) status is consistent with the counts above (see checkStatusConsistency)
 */
export function checkAccounting(manifest, requests, plan) {
  const problems = [];
  const m = manifest;
  const failed = requests.filter(request => request.outcome !== 'OK');
  const okPages = requests.length - failed.length;
  const check = (condition, code) => { if (!condition) problems.push(code); };

  check(m.providerRecordsSeen === m.recordsMapped + m.refused, 'ACCOUNTING_SEEN_NE_MAPPED_PLUS_REFUSED');
  check(m.recordsMapped === m.recordsIngested + m.duplicates + m.conflicts + m.ingestFailures, 'ACCOUNTING_MAPPED_NE_OUTCOMES');
  check(m.rawEvidenceRecordsWritten === m.recordsIngested, 'ACCOUNTING_RAW_WRITTEN_NE_INGESTED');
  check(m.normalizedRecordsWritten === m.recordsIngested, 'ACCOUNTING_NORMALIZED_WRITTEN_NE_INGESTED');
  check(m.requestCount === requests.length, 'ACCOUNTING_REQUEST_COUNT_NE_RECORDS');
  check(m.pageCount === okPages, 'ACCOUNTING_PAGE_COUNT_NE_OK_REQUESTS');
  check(failed.length <= 1, 'ACCOUNTING_MORE_THAN_ONE_FAILED_REQUEST');
  const fc = m.failureCounts;
  check((fc.MAPPING_REFUSED ?? 0) === m.refused, 'ACCOUNTING_MAPPING_REFUSED_COUNT_DRIFT');
  check(Object.values(m.refusedReasons).reduce((sum, n) => sum + n, 0) === m.refused, 'ACCOUNTING_REFUSED_REASONS_DRIFT');
  check((fc.INGEST_CONFLICT ?? 0) === m.conflicts, 'ACCOUNTING_CONFLICT_COUNT_DRIFT');
  check((fc.INTEGRITY_FAILURE ?? 0) >= m.ingestFailures, 'ACCOUNTING_INTEGRITY_COUNT_DRIFT');
  const requestFailureTotal = PUBLIC_INTELLIGENCE_5K3_REQUEST_FAILURE_VALUES.reduce((sum, key) => sum + (fc[key] ?? 0), 0);
  check(requestFailureTotal === failed.length, 'ACCOUNTING_REQUEST_FAILURE_COUNT_DRIFT');
  for (const request of failed) check((fc[request.outcome] ?? 0) >= 1, 'ACCOUNTING_REQUEST_FAILURE_CLASS_DRIFT');
  const returned = requests.reduce((sum, request) => sum + (request.recordsReturned ?? 0), 0);
  check(m.providerRecordsSeen <= returned, 'ACCOUNTING_SEEN_EXCEEDS_RETURNED');
  check(m.providerRecordsSeen <= plan.bounds.maxRecords, 'ACCOUNTING_SEEN_EXCEEDS_PLAN_MAX_RECORDS');
  check(m.requestCount <= plan.bounds.maxPages, 'ACCOUNTING_REQUESTS_EXCEED_PLAN_MAX_PAGES');
  check(m.startedAt <= m.completedAt, 'ACCOUNTING_TIME_REVERSED');
  problems.push(...checkStatusConsistency(m, failed));
  return problems;
}

/**
 * The ONE place that maps counts to a terminal status. The orchestrator uses it
 * to choose the status and the verifier uses it to re-derive and compare, so a
 * manifest can never claim a kinder status than its own numbers support.
 */
export function deriveRunStatus({ failureCounts, conflicts, stopReason }, failedRequests) {
  const S = PUBLIC_INTELLIGENCE_5K3_RUN_STATUS;
  if ((failureCounts.INTEGRITY_FAILURE ?? 0) > 0) return S.FAILED_INTEGRITY;
  const failedOutcome = failedRequests[0]?.outcome ?? null;
  if (failedOutcome === 'RATE_LIMITED') return S.RATE_LIMITED;
  if (failedOutcome === 'TIMEOUT') return S.TIMEOUT;
  if (failedOutcome !== null) return S.PROVIDER_ERROR;
  if (conflicts > 0 || !PLANNED_STOP_REASONS.includes(stopReason)) return S.PARTIAL;
  return S.COMPLETED;
}

/** Terminal status must be the one the counts imply. Never softened. */
export function checkStatusConsistency(manifest, failedRequests) {
  const problems = [];
  const expected = deriveRunStatus({
    failureCounts: manifest.failureCounts, conflicts: manifest.conflicts, stopReason: manifest.providerCursorSummary.stopReason,
  }, failedRequests);
  if (manifest.status !== expected) problems.push(`STATUS_INCONSISTENT:${manifest.status}!=${expected}`);
  if (manifest.status === PUBLIC_INTELLIGENCE_5K3_RUN_STATUS.COMPLETED && failedRequests.length > 0) problems.push('STATUS_COMPLETED_WITH_FAILED_REQUEST');
  return problems;
}

/** Deterministic run identity. No randomness; no result value. */
export function deriveRunId(planFingerprint, startedAt) {
  if (!FINGERPRINT.test(planFingerprint)) failClosed('PUBLIC_INTELLIGENCE_5K3_RUN_ID_PLAN_FINGERPRINT_INVALID');
  if (!isValidTimestamp(startedAt)) failClosed('PUBLIC_INTELLIGENCE_5K3_RUN_ID_STARTED_AT_INVALID');
  return `run-${digest({ kind: 'public_collection_run_identity', collectionPlanFingerprint: planFingerprint, startedAt }).slice(0, 32)}`;
}

export function manifestFingerprintOf(manifest) {
  const body = { ...manifest };
  delete body.manifestFingerprint;
  return digest(body);
}

/** Validates the manifest's closed schema, types and fingerprint format. */
export function validateManifestShape(manifest) {
  assertClosed(manifest, PUBLIC_INTELLIGENCE_5K3_MANIFEST_SCHEMA.fields, 'PUBLIC_INTELLIGENCE_5K3_MANIFEST');
  if (manifest.schemaVersion !== PUBLIC_INTELLIGENCE_5K3_SCHEMA_VERSION) failClosed('PUBLIC_INTELLIGENCE_5K3_MANIFEST_SCHEMA_VERSION_INVALID');
  if (manifest.recordType !== PUBLIC_INTELLIGENCE_5K3_MANIFEST_RECORD_TYPE) failClosed('PUBLIC_INTELLIGENCE_5K3_MANIFEST_RECORD_TYPE_INVALID');
  if (manifest.phase !== PUBLIC_INTELLIGENCE_5K3_PHASE) failClosed('PUBLIC_INTELLIGENCE_5K3_MANIFEST_PHASE_INVALID');
  if (!/^run-[0-9a-f]{32}$/.test(manifest.runId)) failClosed('PUBLIC_INTELLIGENCE_5K3_MANIFEST_RUN_ID_INVALID');
  for (const key of ['collectionPlanFingerprint', 'requestsFingerprint', 'rawEvidenceFingerprint', 'observationsFingerprint', 'manifestFingerprint']) {
    if (!FINGERPRINT.test(manifest[key])) failClosed(`PUBLIC_INTELLIGENCE_5K3_MANIFEST_FINGERPRINT_INVALID:${key}`);
  }
  if (!PUBLIC_INTELLIGENCE_5K3_RUN_STATUS_VALUES.includes(manifest.status)) failClosed('PUBLIC_INTELLIGENCE_5K3_MANIFEST_STATUS_INVALID');
  if (!isValidTimestamp(manifest.startedAt) || !isValidTimestamp(manifest.completedAt)) failClosed('PUBLIC_INTELLIGENCE_5K3_MANIFEST_TIMESTAMP_INVALID');
  for (const key of ['requestCount', 'pageCount', 'providerRecordsSeen', 'recordsMapped', 'recordsIngested', 'duplicates', 'conflicts',
    'refused', 'ingestFailures', 'rawEvidenceRecordsWritten', 'normalizedRecordsWritten']) {
    if (!isCount(manifest[key])) failClosed(`PUBLIC_INTELLIGENCE_5K3_MANIFEST_COUNT_INVALID:${key}`);
  }
  if (!isPlainObject(manifest.failureCounts)) failClosed('PUBLIC_INTELLIGENCE_5K3_MANIFEST_FAILURE_COUNTS_INVALID');
  for (const [key, value] of Object.entries(manifest.failureCounts)) {
    if (!PUBLIC_INTELLIGENCE_5K3_FAILURE_VALUES.includes(key) || !isCount(value) || value === 0) failClosed(`PUBLIC_INTELLIGENCE_5K3_MANIFEST_FAILURE_COUNTS_INVALID:${key}`);
  }
  if (!isPlainObject(manifest.refusedReasons)) failClosed('PUBLIC_INTELLIGENCE_5K3_MANIFEST_REFUSED_REASONS_INVALID');
  for (const [key, value] of Object.entries(manifest.refusedReasons)) {
    if (!REASON_KEY.test(key) || !isCount(value) || value === 0) failClosed('PUBLIC_INTELLIGENCE_5K3_MANIFEST_REFUSED_REASONS_INVALID');
  }
  assertClosed(manifest.providerCursorSummary, PUBLIC_INTELLIGENCE_5K3_MANIFEST_SCHEMA.cursorSummaryFields, 'PUBLIC_INTELLIGENCE_5K3_MANIFEST_CURSORS');
  const cursors = manifest.providerCursorSummary;
  if (!PUBLIC_INTELLIGENCE_5K3_STOP_REASONS.includes(cursors.stopReason)) failClosed('PUBLIC_INTELLIGENCE_5K3_MANIFEST_STOP_REASON_INVALID');
  if (!isCount(cursors.cursorsUsed) || typeof cursors.nextCursorPresent !== 'boolean') failClosed('PUBLIC_INTELLIGENCE_5K3_MANIFEST_CURSORS_INVALID');
  for (const key of ['firstCursor', 'lastCursor']) {
    if (cursors[key] !== null && !/^[0-9]{1,32}$/.test(String(cursors[key]))) failClosed('PUBLIC_INTELLIGENCE_5K3_MANIFEST_CURSORS_INVALID');
  }
  if (canonical(manifest.classification) !== canonical(PUBLIC_INTELLIGENCE_CLASSIFICATION)) {
    failClosed('PUBLIC_INTELLIGENCE_5K3_MANIFEST_CLASSIFICATION_OVERRIDE_REFUSED');
  }
  return manifest;
}

/** Derives the cursor summary from the ordered request records. */
export function summarizeCursors(requests, stopReason) {
  const used = requests.map(request => request.cursor).filter(cursor => cursor !== null);
  const last = requests[requests.length - 1] ?? null;
  return {
    firstCursor: used[0] ?? null,
    lastCursor: used[used.length - 1] ?? null,
    cursorsUsed: used.length,
    stopReason,
    nextCursorPresent: last?.nextCursor != null,
  };
}

/**
 * Builds a finalized manifest from a run's accounting. The manifest
 * fingerprint is computed last; the result is deep-frozen. Throws unless the
 * accounting invariants hold, so an inconsistent manifest cannot even be built.
 */
export function buildRunManifest({ plan, startedAt, completedAt, status, requests, counts, failureCounts, refusedReasons,
  stopReason, rawEvidenceFingerprint, observationsFingerprint }) {
  const validPlan = validateCollectionPlan(plan);
  const planFingerprint = collectionPlanFingerprint(validPlan);
  const failed = requests.filter(request => request.outcome !== 'OK');
  const body = {
    schemaVersion: PUBLIC_INTELLIGENCE_5K3_SCHEMA_VERSION,
    recordType: PUBLIC_INTELLIGENCE_5K3_MANIFEST_RECORD_TYPE,
    phase: PUBLIC_INTELLIGENCE_5K3_PHASE,
    runId: deriveRunId(planFingerprint, startedAt),
    collectionPlanFingerprint: planFingerprint,
    provider: validPlan.provider,
    instance: validPlan.instance,
    query: { type: validPlan.query.type, value: validPlan.query.value },
    startedAt,
    completedAt,
    status,
    requestCount: requests.length,
    pageCount: requests.length - failed.length,
    providerRecordsSeen: counts.providerRecordsSeen,
    recordsMapped: counts.recordsMapped,
    recordsIngested: counts.recordsIngested,
    duplicates: counts.duplicates,
    conflicts: counts.conflicts,
    refused: counts.refused,
    ingestFailures: counts.ingestFailures,
    rawEvidenceRecordsWritten: counts.rawEvidenceRecordsWritten,
    normalizedRecordsWritten: counts.normalizedRecordsWritten,
    failureCounts: { ...failureCounts },
    refusedReasons: { ...refusedReasons },
    providerCursorSummary: summarizeCursors(requests, stopReason),
    requestsFingerprint: requestsFingerprint(requests),
    rawEvidenceFingerprint,
    observationsFingerprint,
    classification: PUBLIC_INTELLIGENCE_CLASSIFICATION,
  };
  const manifest = { ...body, manifestFingerprint: manifestFingerprintOf({ ...body, manifestFingerprint: '' }) };
  validateManifestShape(manifest);
  const problems = checkAccounting(manifest, requests, validPlan);
  if (problems.length) failClosed(`PUBLIC_INTELLIGENCE_5K3_MANIFEST_ACCOUNTING_INCONSISTENT:${problems[0]}`);
  return JSON.parse(canonical(manifest));
}
