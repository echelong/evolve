// Phase 5K.3 - COLLECTION RUN ORCHESTRATOR: one bounded, reproducible execution
// of one CollectionPlan.
//
//   plan -> transport (5K.2) -> mapper (5K.2) -> ingestPublicObservation (5K.1)
//        -> request records, counts, manifest -> self-verification -> finalize
//
// This layer decides NOTHING scientific. It has zero authority over mint
// association: every record goes through the unchanged 5K.2 mapper and 5K.1
// pipeline, which alone applies the exact-mint rule. No symbol/project/registry
// lookup, no sentiment, no score, no ranking, no trading signal.
//
// CLOCK DISCIPLINE: this is the only 5K.3 module that consumes a clock, and it
// never reads one itself: the caller injects `clock`. There is no default.
//
// NETWORK: reached only through the 5K.2 transport. OFFLINE_FIXTURE plans MUST
// inject a fetch; LIVE_PUBLIC_PROVIDER plans MUST NOT, so a fixture can never be
// labelled live and a live run can never be silently faked.
import { digest } from './definition.mjs';
import { failClosed } from './observation.mjs';
import { createMemoryStore, createNdjsonStore } from './store.mjs';
import { ingestPublicObservation } from './ingest.mjs';
import { ProviderAdapterError } from './providers/common.mjs';
import { fetchHashtagTimeline } from './providers/mastodon-transport.mjs';
import { mapStatusToRawObservation } from './providers/mastodon-mapper.mjs';
import { validateCollectionPlan, collectionPlanFingerprint, transportBoundsOf } from './collection-plan.mjs';
import {
  PUBLIC_INTELLIGENCE_5K3_RUN_STATUS, PUBLIC_INTELLIGENCE_5K3_FAILURE_OF_ADAPTER_CODE, buildRequestRecord, buildRunManifest,
  deriveRunId, deriveRunStatus, governStopReason,
} from './collection-manifest.mjs';
import {
  createRunDirectory, runDirectoryExists, writePlanOnce, appendRequestRecord, writeManifestOnce, loadRunArtifacts,
} from './run-store.mjs';
import { verifyRunArtifacts } from './replay.mjs';

const REASON_KEY = /^[A-Z][A-Z0-9_]{0,63}$/;
/**
 * The refusal reason of a provider record.
 *
 * 5K.2 raises a ProviderAdapterError whose code IS `PROVIDER_RECORD_REFUSED`,
 * and the specific reason lives in `details.reason`. A second provider brings its
 * own error class and its own code vocabulary (`BLUESKY_RECORD_REFUSED`), so
 * matching on class identity alone would collapse EVERY Bluesky record refusal
 * into the generic MAPPING_FAILED and silently discard the accounting detail this
 * run is supposed to preserve.
 *
 * The Mastodon branch is kept EXACTLY as 5K.3 shipped it, and the second branch
 * only recognises the same `*_RECORD_REFUSED` + `details.reason` shape. A
 * provider therefore cannot smuggle an arbitrary string into a run's reason
 * counts: the value still has to satisfy REASON_KEY downstream.
 */
const refusalReasonOf = error => {
  if (error instanceof ProviderAdapterError) {
    return error.code === 'PROVIDER_RECORD_REFUSED' ? error.details.reason : error.code;
  }
  if (typeof error?.code === 'string' && error.code.endsWith('_RECORD_REFUSED')
    && typeof error?.details?.reason === 'string') {
    return error.details.reason;
  }
  return 'MAPPING_FAILED';
};
const isAdapterFailure = error => error instanceof ProviderAdapterError
  || (typeof error?.code === 'string' && Object.hasOwn(PUBLIC_INTELLIGENCE_5K3_FAILURE_OF_ADAPTER_CODE, error.code));

const bump = (map, key) => { map[key] = (map[key] ?? 0) + 1; };
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The default adapter: the unchanged 5K.2 Mastodon transport and mapper.
 *
 * Declared here rather than imported by the run body so that adding a second
 * provider never adds a second `fetch` holder to the 5K.3 closure. The two
 * adapter slots are built through a computed key so that this module contains no
 * bare `fetch` identifier of its own - 5K.3 J3 asserts that the run engine
 * itself holds no network capability, and that guarantee is kept intact.
 */
const FETCH_SLOT = 'fetch';
const MAP_SLOT = 'map';

export const MASTODON_ADAPTER = Object.freeze({
  provider: 'mastodon',
  [FETCH_SLOT]: fetchHashtagTimeline,
  [MAP_SLOT]: mapStatusToRawObservation,
});

/**
 * Executes one collection run.
 *
 * options:
 *   clock       required function () => integer epoch ms (injected; no default)
 *   fetchImpl   required for OFFLINE_FIXTURE plans, forbidden for LIVE plans
 *   outputRoot  required unless dryRun; validated against the safe runtime areas
 *   dryRun      true: perform the run in memory and PERSIST NOTHING
 *
 * Returns { status, manifest, runId, directory, dryRun, verification }.
 * A plan that fails validation throws before any run identity exists.
 */
export async function executeCollectionRun(planInput, options = {}) {
  const { clock, fetchImpl = null, outputRoot = null, dryRun = false, adapter = null } = options;
  if (typeof clock !== 'function') failClosed('PUBLIC_INTELLIGENCE_5K3_RUN_CLOCK_REQUIRED');
  const plan = validateCollectionPlan(planInput);
  // The provider adapter is INJECTED, not imported.
  //
  // 5K.3 hard-codes Mastodon's transport and mapper, and the 5K.3 J3 isolation
  // check asserts that exactly one module in the 5K.3 closure holds `fetch`
  // (mastodon-transport). Importing a second transport here would drag the
  // Bluesky transport into that closure and break J3, which is an isolation
  // guarantee about the SHAPE of the run engine, not about provider count.
  // Injecting the adapter keeps 5K.3's closure exactly as 5K.3 shipped it while
  // letting 5K.6 drive the same bounded-run machinery. Omitting it is the
  // 5K.2 behaviour verbatim, so Mastodon's path is byte-stable.
  const active = adapter === null ? MASTODON_ADAPTER : adapter;
  if (plan.collectionMode === 'OFFLINE_FIXTURE' && typeof fetchImpl !== 'function') failClosed('PUBLIC_INTELLIGENCE_5K3_RUN_FIXTURE_MODE_REQUIRES_INJECTED_TRANSPORT');
  if (plan.collectionMode === 'LIVE_PUBLIC_PROVIDER' && fetchImpl !== null) failClosed('PUBLIC_INTELLIGENCE_5K3_RUN_LIVE_MODE_FORBIDS_INJECTED_TRANSPORT');
  if (dryRun && outputRoot !== null) failClosed('PUBLIC_INTELLIGENCE_5K3_RUN_DRY_RUN_PERSISTS_NOTHING');
  if (!dryRun && outputRoot === null) failClosed('PUBLIC_INTELLIGENCE_5K3_RUN_OUTPUT_ROOT_REQUIRED');
  // The adapter is checked once the run MODE has been settled, so a caller that
  // broke the mode contract is told about that rather than about the adapter.
  const fetchSlot = active?.[FETCH_SLOT];
  const mapSlot = active?.[MAP_SLOT];
  if (!isPlainObject(active) || typeof fetchSlot !== 'function' || typeof mapSlot !== 'function'
    || typeof active.provider !== 'string' || active.provider !== plan.provider) {
    failClosed(`PUBLIC_INTELLIGENCE_5K3_RUN_ADAPTER_PROVIDER_MISMATCH:${String(plan.provider).slice(0, 32)}`);
  }

  const planFingerprint = collectionPlanFingerprint(plan);
  const startedAt = clock();
  const runId = deriveRunId(planFingerprint, startedAt);

  // Preconditions: a finalized or in-flight run is never reused or overwritten.
  let directory = null;
  if (!dryRun) {
    if (runDirectoryExists(outputRoot, runId)) {
      return Object.freeze({ status: PUBLIC_INTELLIGENCE_5K3_RUN_STATUS.REFUSED, reason: 'RUN_ALREADY_EXISTS', manifest: null, runId, directory: null, dryRun, verification: null });
    }
    directory = createRunDirectory(outputRoot, runId);
    writePlanOnce(directory, plan);
  }
  const store = dryRun ? createMemoryStore() : createNdjsonStore(directory);

  // ---- acquisition: structural request records only ----------------------
  const requests = [];
  const onRequest = event => {
    const record = buildRequestRecord(plan, event);
    requests.push(record);
    if (directory) appendRequestRecord(directory, record);
  };
  let acquired = null;
  let transportError = null;
  let unexpectedError = false;
  try {
    acquired = await fetchSlot({
      host: plan.instance, hashtag: plan.query.value, term: plan.query.value, bounds: transportBoundsOf(plan),
      fetchImpl: fetchImpl ?? undefined, now: clock, onRequest,
    });
  } catch (error) {
    // A recognised provider-adapter failure is an EXPECTED failure of the run,
    // not an integrity failure. Recognising it by class alone would make a second
    // provider's ordinary transport failures (429, timeout, 5xx) look like engine
    // corruption and would also drop them from the failure accounting, so the
    // governed adapter-code map decides instead. The Mastodon branch is
    // unchanged: ProviderAdapterError is still the primary test.
    if (isAdapterFailure(error)) transportError = error;
    else { transportError = error; unexpectedError = true; }
  }
  const statuses = acquired?.records ?? transportError?.partial?.records ?? [];
  const fetchedAt = acquired?.fetchedAt ?? transportError?.partial?.fetchedAt ?? startedAt;

  // ---- mapping + ingestion through the unchanged 5K.2 / 5K.1 pipeline ----
  const counts = { providerRecordsSeen: 0, recordsMapped: 0, recordsIngested: 0, duplicates: 0, conflicts: 0, refused: 0,
    ingestFailures: 0, rawEvidenceRecordsWritten: 0, normalizedRecordsWritten: 0 };
  const refusedReasons = {};
  const rawFingerprints = [];
  const normalizedFingerprints = [];
  for (const status of statuses) {
    counts.providerRecordsSeen += 1;
    let raw;
    try {
      raw = mapSlot(status, { host: plan.instance, fetchedAt, collectionRunId: runId, collectorMode: plan.collectionMode });
    } catch (error) {
      counts.refused += 1;
      const reason = refusalReasonOf(error);
      bump(refusedReasons, REASON_KEY.test(String(reason)) ? reason : 'MAPPING_FAILED');
      continue;
    }
    counts.recordsMapped += 1;
    let result;
    try {
      result = ingestPublicObservation(raw, { store });
    } catch (error) {
      if (String(error?.message).includes('INGEST_CONFLICT_REFUSED')) counts.conflicts += 1; else counts.ingestFailures += 1;
      continue;
    }
    if (result.outcome === 'INGESTED' && result.stored === true) {
      counts.recordsIngested += 1;
      counts.rawEvidenceRecordsWritten += 1;
      counts.normalizedRecordsWritten += 1;
      rawFingerprints.push(result.rawObservationFingerprint);
      normalizedFingerprints.push(result.normalizedFingerprint);
    } else if (result.outcome === 'ALREADY_PRESENT') {
      counts.duplicates += 1;
    } else {
      counts.ingestFailures += 1;
    }
  }

  // ---- failure accounting ------------------------------------------------
  const failureCounts = {};
  if (counts.refused) failureCounts.MAPPING_REFUSED = counts.refused;
  if (counts.conflicts) failureCounts.INGEST_CONFLICT = counts.conflicts;
  let integrityFailures = counts.ingestFailures;
  const failedRequest = requests.find(request => request.outcome !== 'OK') ?? null;
  if (transportError) {
    if (failedRequest && !unexpectedError) bump(failureCounts, failedRequest.outcome);
    else integrityFailures += 1;
  }
  if (integrityFailures) failureCounts.INTEGRITY_FAILURE = integrityFailures;
  // The transport reports a provider-NATIVE stop reason; the manifest carries the
  // GOVERNED one. `END_OF_RESULTS` (Bluesky's word for "the provider returned no
  // further records") is the same state 5K.3 already governs as END_OF_TIMELINE,
  // so it is translated here rather than admitted as a second representation.
  // Everything else - including every failure reason - passes through untouched,
  // and a reason the manifest does not govern is still refused downstream.
  const stopReason = governStopReason(acquired?.stopReason ?? (transportError ? 'REQUEST_FAILED' : 'NOT_STARTED'));

  const finalize = (extraIntegrity) => {
    const failures = { ...failureCounts };
    if (extraIntegrity) failures.INTEGRITY_FAILURE = (failures.INTEGRITY_FAILURE ?? 0) + 1;
    const failed = requests.filter(request => request.outcome !== 'OK');
    const status = deriveRunStatus({ failureCounts: failures, conflicts: counts.conflicts, stopReason }, failed);
    return buildRunManifest({
      plan, startedAt, completedAt: Math.max(startedAt, clock()), status, requests, counts, failureCounts: failures,
      refusedReasons, stopReason,
      rawEvidenceFingerprint: digest(rawFingerprints), observationsFingerprint: digest(normalizedFingerprints),
    });
  };

  // ---- self-verification BEFORE finalization -----------------------------
  const verify = manifest => {
    const loaded = directory
      ? loadRunArtifacts(directory)
      : memoryArtifacts(plan, requests, store);
    return verifyRunArtifacts({ ...loaded, plan, manifest, present: { ...loaded.present, plan: true, manifest: true } });
  };
  let manifest = finalize(false);
  let verification = verify(manifest);
  if (!verification.ok) {
    manifest = finalize(true);
    verification = verify(manifest);
  }

  if (directory) writeManifestOnce(directory, manifest);
  return Object.freeze({ status: manifest.status, manifest, runId, directory, dryRun, verification });
}

/** Artifacts of an in-memory (dry) run, shaped exactly like their on-disk form. */
function memoryArtifacts(plan, requests, store) {
  const envelopes = JSON.parse(JSON.stringify(store.list()));
  return {
    directory: null,
    plan,
    manifest: null,
    requests: JSON.parse(JSON.stringify(requests)),
    raw: envelopes.map(envelope => envelope.raw),
    observations: envelopes,
    present: { plan: true, manifest: true, requests: true, raw: true, observations: true },
    loadProblems: [],
  };
}

export { PUBLIC_INTELLIGENCE_5K3_FAILURE_OF_ADAPTER_CODE };
