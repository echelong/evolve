// Phase 5K.5 - OBSERVATION STATE: authenticated mutable-counter snapshots.
//
// PURE AND OFFLINE BY CONSTRUCTION. No filesystem, no socket, no clock, no
// environment, no provider SDK.
//
// WHAT THIS IS, AND WHAT IT IS NOT
//
// An observation-state record is a structural snapshot of the provider-supplied
// public counters at one authenticated acquisition. It is research evidence and
// nothing more. There is deliberately NO engagement score, momentum, velocity,
// growth rate, ranking, virality measure or trading signal here, and no such
// value is derivable from these records: this module computes no arithmetic
// across snapshots at all. Two snapshots are simply two authenticated facts.
//
// A COUNTER REGRESSION IS A FACT, NOT A FAILURE. Providers remove interactions,
// moderate activity and recalculate counts, so 10 -> 8 is a legitimate observed
// state change. Nothing here infers a cause, a direction of intent, or an
// integrity verdict from the size or sign of a difference.
//
// MISSINGNESS IS PRESERVED. An absent counter object stays NO_OBSERVATION. An
// absent key inside a supplied object stays absent. Nothing is zero-filled,
// carried forward from an earlier acquisition, or interpolated.
import { canonical, digest, PUBLIC_INTELLIGENCE_CLASSIFICATION } from './definition.mjs';
import { failClosed } from './observation.mjs';
import {
  PUBLIC_INTELLIGENCE_5K5_SCHEMA_VERSION, PUBLIC_INTELLIGENCE_5K5_OBSERVATION_STATE_FIELDS,
  observationStateProjection, observationStateFingerprint5K5, upstreamIdentity5K5,
} from './temporal-projection.mjs';

export const PUBLIC_INTELLIGENCE_5K5_STATE_RECORD_TYPE = 'public_observation_state';

/**
 * The closed state record schema. Structural counters and fingerprints ONLY:
 * no display name, no bio, no avatar, no follower graph, no mention graph, no
 * geolocation, no address and no credential of any kind.
 */
export const PUBLIC_INTELLIGENCE_5K5_STATE_SCHEMA = Object.freeze({
  closed: true,
  fields: Object.freeze([
    'schemaVersion', 'recordType', 'upstreamIdentity', 'provider', 'providerObservationId',
    'fetchedAt', 'runId', 'runManifestFingerprint', 'observationStateFingerprint',
    'status', 'values', 'absentCounters',
    'zeroFillingApplied', 'carryForwardApplied', 'interpolationApplied', 'deltaComputed',
    'classification', 'stateRecordFingerprint',
  ]),
});

/** The disclosure of what this module will never compute. Stated as data. */
export const PUBLIC_INTELLIGENCE_5K5_STATE_SEMANTICS = Object.freeze({
  counterRegressionIsFailure: false,
  counterDirectionImpliesIntent: false,
  growthRateComputed: false,
  velocityComputed: false,
  momentumComputed: false,
  engagementScoreComputed: false,
  popularityComputed: false,
  importanceComputed: false,
  viralityComputed: false,
  rankingComputed: false,
  crossSnapshotArithmeticPerformed: false,
  zeroFillingApplied: false,
  carryForwardApplied: false,
  interpolationApplied: false,
  missingnessExplicit: true,
  structuralCountersOnly: true,
  containsPersonalProfileData: false,
  containsCredentialData: false,
  containsGeolocationData: false,
});

const plain = value => JSON.parse(canonical(value));
const FINGERPRINT = /^[0-9a-f]{64}$/;

/**
 * Builds the observation-state record for ONE acquisition.
 *
 * runId/runManifestFingerprint bind the snapshot to the run that produced it,
 * so a state snapshot can always be traced to immutable evidence on disk.
 */
export function buildObservationState(raw, { runId, runManifestFingerprint } = {}) {
  if (!raw || typeof raw !== 'object') failClosed('PUBLIC_INTELLIGENCE_5K5_STATE_REQUIRES_RAW_EVIDENCE');
  const projection = observationStateProjection(raw);
  const body = {
    schemaVersion: PUBLIC_INTELLIGENCE_5K5_SCHEMA_VERSION,
    recordType: PUBLIC_INTELLIGENCE_5K5_STATE_RECORD_TYPE,
    upstreamIdentity: upstreamIdentity5K5(raw),
    provider: raw.provider,
    providerObservationId: raw.providerObservationId,
    fetchedAt: raw.fetchedAt,
    runId: runId ?? null,
    runManifestFingerprint: runManifestFingerprint ?? null,
    observationStateFingerprint: observationStateFingerprint5K5(raw),
    status: projection.status,
    // Structural counters only, exactly as supplied. Absent keys stay absent.
    values: projection.values,
    absentCounters: projection.absentCounters,
    zeroFillingApplied: false,
    carryForwardApplied: false,
    interpolationApplied: false,
    // Recorded so a reader can see at a glance that no cross-snapshot
    // comparison is offered by this record.
    deltaComputed: false,
    classification: PUBLIC_INTELLIGENCE_CLASSIFICATION,
  };
  return plain({ ...body, stateRecordFingerprint: digest(body) });
}

/** Closed-schema + fingerprint validation of a stored state record. */
export function validateObservationStateRecord(record) {
  const S = PUBLIC_INTELLIGENCE_5K5_STATE_SCHEMA;
  if (!record || typeof record !== 'object' || Array.isArray(record)) failClosed('PUBLIC_INTELLIGENCE_5K5_STATE_NOT_AN_OBJECT');
  for (const key of Object.keys(record)) {
    if (S.fields.includes(key)) continue;
    failClosed(`PUBLIC_INTELLIGENCE_5K5_STATE_UNKNOWN_FIELD:${String(key).slice(0, 40)}`);
  }
  for (const key of S.fields) if (!Object.hasOwn(record, key)) failClosed(`PUBLIC_INTELLIGENCE_5K5_STATE_FIELD_MISSING:${key}`);
  if (record.schemaVersion !== PUBLIC_INTELLIGENCE_5K5_SCHEMA_VERSION || record.recordType !== PUBLIC_INTELLIGENCE_5K5_STATE_RECORD_TYPE) {
    failClosed('PUBLIC_INTELLIGENCE_5K5_STATE_TYPE_INVALID');
  }
  if (!FINGERPRINT.test(record.observationStateFingerprint)) failClosed('PUBLIC_INTELLIGENCE_5K5_STATE_FINGERPRINT_INVALID');
  if (!['OBSERVED', 'NO_OBSERVATION'].includes(record.status)) failClosed('PUBLIC_INTELLIGENCE_5K5_STATE_STATUS_INVALID');
  if (record.status === 'NO_OBSERVATION') {
    // Missing stays missing: values must be null, never {} and never zeros.
    if (record.values !== null) failClosed('PUBLIC_INTELLIGENCE_5K5_STATE_MISSING_MADE_VALUES');
  } else if (record.values === null || typeof record.values !== 'object' || Array.isArray(record.values)) {
    failClosed('PUBLIC_INTELLIGENCE_5K5_STATE_OBSERVED_WITHOUT_VALUES');
  } else {
    for (const key of Object.keys(record.values)) {
      if (!PUBLIC_INTELLIGENCE_5K5_OBSERVATION_STATE_FIELDS.includes(key)) failClosed(`PUBLIC_INTELLIGENCE_5K5_STATE_COUNTER_UNGOVERNED:${key}`);
      const value = record.values[key];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) failClosed(`PUBLIC_INTELLIGENCE_5K5_STATE_COUNTER_INVALID:${key}`);
    }
  }
  for (const key of ['zeroFillingApplied', 'carryForwardApplied', 'interpolationApplied', 'deltaComputed']) {
    if (record[key] !== false) failClosed(`PUBLIC_INTELLIGENCE_5K5_STATE_DISALLOWED_OPERATION:${key}`);
  }
  if (canonical(record.classification) !== canonical(PUBLIC_INTELLIGENCE_CLASSIFICATION)) {
    failClosed('PUBLIC_INTELLIGENCE_5K5_STATE_CLASSIFICATION_OVERRIDE_REFUSED');
  }
  const expected = digest((() => { const b = { ...record }; delete b.stateRecordFingerprint; return b; })());
  if (record.stateRecordFingerprint !== expected) failClosed('PUBLIC_INTELLIGENCE_5K5_STATE_FINGERPRINT_MISMATCH');
  return record;
}
