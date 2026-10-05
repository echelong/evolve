// Phase 5K.3 - OFFLINE REPLAY + RUN VERIFIER.
//
// Consumes ONLY artifacts already on disk (or already loaded). It imports no
// transport, opens no socket and re-fetches nothing. It proves that the stored
// raw evidence deterministically reproduces the stored normalized observations,
// provenance, dedup identities and run accounting, and it reports - never
// repairs - every discrepancy.
//
// OFFLINE BY CONSTRUCTION: no network, no clock, no environment.
import { canonical, digest } from './definition.mjs';
import { canonicalizeRawObservation } from './observation.mjs';
import { rawObservationFingerprint, verifyProvenance5K1 } from './provenance.mjs';
import { normalizeObservation5K1, normalizedFingerprint5K1 } from './normalize.mjs';
import { dedupIdentity5K1 } from './dedup.mjs';
import { createMemoryStore, PUBLIC_INTELLIGENCE_5K1_RECORD_ENVELOPE } from './store.mjs';
import { ingestPublicObservation } from './ingest.mjs';
import { validateCollectionPlan, collectionPlanFingerprint, rawProviderNamespaceOf } from './collection-plan.mjs';
import {
  validateManifestShape, validateRequestRecord, checkAccounting, deriveRunId, manifestFingerprintOf, requestsFingerprint,
} from './collection-manifest.mjs';
import { loadRunArtifacts } from './run-store.mjs';

/** Runs `fn`; a thrown refusal becomes a recorded failure code, never an exception. */
function guarded(failures, code, fn) {
  try { return fn(); } catch (error) {
    failures.push(`${code}:${String(error?.message ?? error).split(':')[0].slice(0, 80)}`);
    return undefined;
  }
}

/**
 * Verifies one loaded run. Pure: the same artifacts always yield the same
 * report. Returns { ok, failures[] }; `ok` is true only with zero failures.
 */
export function verifyRunArtifacts(artifacts) {
  const failures = [];
  failures.push(...artifacts.loadProblems);
  if (!artifacts.present.manifest) { failures.push('MANIFEST_MISSING_UNFINALIZED_RUN'); return report(failures); }
  if (!artifacts.present.plan) { failures.push('PLAN_MISSING'); return report(failures); }
  if (failures.length) return report(failures);

  // 1. plan + 2. manifest shape, fingerprints, classification
  const plan = guarded(failures, 'PLAN_INVALID', () => validateCollectionPlan(artifacts.plan));
  const manifest = guarded(failures, 'MANIFEST_INVALID', () => validateManifestShape(artifacts.manifest));
  if (!plan || !manifest) return report(failures);

  const planFingerprint = collectionPlanFingerprint(plan);
  if (manifest.collectionPlanFingerprint !== planFingerprint) failures.push('PLAN_FINGERPRINT_MISMATCH');
  if (manifest.manifestFingerprint !== manifestFingerprintOf(manifest)) failures.push('MANIFEST_FINGERPRINT_MISMATCH');
  if (manifest.runId !== guarded(failures, 'RUN_ID', () => deriveRunId(planFingerprint, manifest.startedAt))) failures.push('RUN_ID_MISMATCH');
  if (manifest.provider !== plan.provider || manifest.instance !== plan.instance
    || canonical(manifest.query) !== canonical(plan.query)) failures.push('MANIFEST_PLAN_IDENTITY_MISMATCH');

  // 3. request sequence
  const requests = artifacts.requests;
  requests.forEach((request, position) => {
    guarded(failures, 'REQUEST_INVALID', () => validateRequestRecord(request, plan));
    if (request.requestIndex !== position) failures.push('REQUEST_SEQUENCE_GAP_OR_DUPLICATE');
    if (position > 0 && requests[position - 1].completedAt > request.requestedAt) failures.push('REQUEST_TIME_NOT_MONOTONIC');
    if (request.provider !== plan.provider || request.instance !== plan.instance) failures.push('REQUEST_IDENTITY_MISMATCH');
  });
  if (requests.length !== manifest.requestCount) failures.push('REQUEST_COUNT_MISMATCH');
  if (manifest.requestsFingerprint !== requestsFingerprint(requests)) failures.push('REQUESTS_FINGERPRINT_MISMATCH');

  // 4. accounting + terminal status
  if (failures.every(code => !code.startsWith('REQUEST_INVALID'))) failures.push(...checkAccounting(manifest, requests, plan));

  // 5. stored raw evidence
  const rawLines = artifacts.raw;
  if (rawLines.length !== manifest.rawEvidenceRecordsWritten) failures.push('RAW_COUNT_MISMATCH');
  const raws = rawLines.map(line => guarded(failures, 'RAW_INVALID', () => canonicalizeRawObservation(line)));
  const rawFingerprints = raws.map(raw => (raw ? rawObservationFingerprint(raw) : null));
  if (manifest.rawEvidenceFingerprint !== digest(rawFingerprints)) failures.push('RAW_EVIDENCE_FINGERPRINT_MISMATCH');
  raws.forEach(raw => {
    if (!raw) return;
    if (raw.collectionContext.collectionRunId !== manifest.runId) failures.push('RAW_RUN_ID_MISMATCH');
    if (raw.collectionContext.collectorMode !== plan.collectionMode) failures.push('RAW_COLLECTOR_MODE_MISMATCH');
    // The namespace comes from the governed provider registry. Mastodon's stays
    // `${provider}:${instance}` verbatim; a provider with a host-free namespace
    // (Bluesky) governs its own. Evidence whose namespace does not match its plan
    // is still a hard failure.
    if (raw.provider !== rawProviderNamespaceOf(plan)) failures.push('RAW_PROVIDER_MISMATCH');
  });

  // 6. stored normalized observations
  const envelopes = artifacts.observations;
  if (envelopes.length !== manifest.normalizedRecordsWritten) failures.push('OBSERVATION_COUNT_MISMATCH');
  const expectedNormalized = [];
  const seenIdentities = new Set();
  envelopes.forEach((envelope, position) => {
    const raw = raws[position];
    const envelopeFields = PUBLIC_INTELLIGENCE_5K1_RECORD_ENVELOPE.fields;
    if (Object.keys(envelope).sort().join() !== [...envelopeFields].sort().join()) failures.push('OBSERVATION_ENVELOPE_SCHEMA_MISMATCH');
    if (!raw) { failures.push('OBSERVATION_WITHOUT_RAW'); return; }
    if (canonical(envelope.raw) !== canonical(raw)) failures.push('OBSERVATION_RAW_DIFFERS_FROM_RAW_STREAM');
    guarded(failures, 'PROVENANCE', () => verifyProvenance5K1(envelope.normalized.provenance, raw));
    const identity = dedupIdentity5K1(raw);
    if (envelope.dedupIdentity !== identity || envelope.normalized.dedupIdentity !== identity) failures.push('DEDUP_IDENTITY_MISMATCH');
    if (seenIdentities.has(identity)) failures.push('DEDUP_IDENTITY_DUPLICATED_IN_STORE');
    seenIdentities.add(identity);
    const derived = guarded(failures, 'NORMALIZE', () => normalizeObservation5K1(raw));
    const derivedFingerprint = derived ? normalizedFingerprint5K1(derived) : null;
    if (derived && normalizedFingerprint5K1(envelope.normalized) !== derivedFingerprint) failures.push('NORMALIZED_FINGERPRINT_MISMATCH');
    if (envelope.rawObservationFingerprint !== rawFingerprints[position]) failures.push('ENVELOPE_RAW_FINGERPRINT_MISMATCH');
    expectedNormalized.push(derivedFingerprint);
  });
  if (manifest.observationsFingerprint !== digest(expectedNormalized)) failures.push('OBSERVATIONS_FINGERPRINT_MISMATCH');

  // 7. deterministic replay: raw evidence alone must reproduce every stored record
  if (!failures.some(code => code.startsWith('RAW_INVALID'))) {
    const store = createMemoryStore();
    raws.forEach((raw, position) => {
      const result = guarded(failures, 'REPLAY_INGEST', () => ingestPublicObservation(raw, { store }));
      if (!result) return;
      if (result.outcome !== 'INGESTED' || result.stored !== true) failures.push('REPLAY_OUTCOME_NOT_INGESTED');
      if (envelopes[position] && result.normalizedFingerprint !== expectedNormalized[position]) failures.push('REPLAY_NORMALIZED_FINGERPRINT_MISMATCH');
    });
    if (store.count() !== manifest.recordsIngested) failures.push('REPLAY_COUNT_MISMATCH');
  }
  return report(failures);
}

const report = failures => Object.freeze({ ok: failures.length === 0, failures: Object.freeze([...failures]) });

/** Loads a run directory and verifies it. Zero network calls by construction. */
export function replayRun(directory) {
  return verifyRunArtifacts(loadRunArtifacts(directory));
}

/** Throws unless the run verifies. */
export function assertRunVerified(directory) {
  const result = replayRun(directory);
  if (!result.ok) throw new Error(`PUBLIC_INTELLIGENCE_5K3_RUN_VERIFICATION_FAILED:${result.failures[0]}`);
  return result;
}
