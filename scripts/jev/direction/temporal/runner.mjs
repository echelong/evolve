/**
 * EVOLVE Phase 5I.1a — THE TEMPORAL-EXTENSION RUNNER.
 *
 * Four explicit, ID-ONLY operations, mirroring the Phase 5I.1 replication runner.
 * There is no daemon, no background process, no "latest", and NO OPERATION HERE
 * EVER LAUNCHES A SESSION:
 *
 *   temporalCreate  writes a manifest that source-pins the canonical Phase 5I.1
 *                   wave and the frozen (identical) protocol digest. Runs nothing.
 *   temporalAdd     reads ONE already-completed fresh `jdir-*` experiment, replays
 *                   it OFFLINE, derives its temporal eligibility + metrics, and
 *                   records it (CLEAN, CONTAMINATED or INELIGIBLE). Runs nothing.
 *   temporalReplay  re-derives every recorded session from its own immutable
 *                   artifacts and proves the manifest/summary still describe it.
 *                   READ ONLY, ZERO NETWORK.
 *   temporalStats   the same derivation plus the combined descriptive view.
 *                   READ ONLY, ZERO NETWORK.
 *
 * The canonical Phase 5I.1 replication tree is READ ONLY here, and is never
 * appended to, re-scored, or rewritten.
 *
 * PAPER ONLY / NO TRADING. No wallet, no signing, no swap, no order, no Arena
 * routing, no DeepSeek routing, no external-agent routing of any kind, and no
 * confidence threshold.
 */

import { digestOf } from "../../../lib/hash.mjs";
import { compactSessionMetrics } from "../replication/eligibility.mjs";
import {
  DIRECTION_REPLICATION_ROOT_DIR,
  REPLICATION_COMPARISON_IDS,
  REPLICATION_PROTOCOL_DIGEST,
  REPLICATION_PROTOCOL_VERSION,
  verifyReplicationProtocol,
} from "../replication/protocol.mjs";
import { readReplicationBundle, replicationRootFor } from "../replication/manifest.mjs";
import { directionExperimentRootFor, readDirectionExperimentBundle } from "../storage.mjs";
import { replayDirectionExperiment } from "../runner.mjs";
import { TEMPORAL_REPLICATION_EVIDENCE_CLASS } from "../evidence.mjs";
import { evaluateTemporalSession, protectedTemporalExperimentReason } from "./eligibility.mjs";
import {
  TEMPORAL_INSUFFICIENT_STATE,
  TEMPORAL_COMPLETE_STATE,
  aggregateTemporalSessions,
  buildCombinedDescriptiveView,
} from "./aggregate.mjs";
import {
  CANONICAL_REPLICATION_BARRIER,
  DIRECTION_TEMPORAL_ROOT_DIR,
  REQUIRED_CLEAN_TEMPORAL_SESSIONS,
  TEMPORAL_INDEPENDENCE_RULES,
  TEMPORAL_PHASE,
  TEMPORAL_PROTOCOL_DIGEST,
  TEMPORAL_PROTOCOL_VERSION,
  TEMPORAL_SELECTION_RULES,
  TEMPORAL_SESSION_OBSERVATIONS,
  utcDateOf,
  verifyTemporalManifest,
} from "./protocol.mjs";
import {
  aggregateDigestOf,
  combinedDigestOf,
  createTemporalManifest,
  createTemporalSessionsDocument,
  isValidTemporalId,
  manifestDigestOf,
  readTemporalBundle,
  readTemporalManifest,
  readTemporalSessions,
  temporalIdFor,
  temporalMetadataSnapshot,
  temporalRootFor,
  sessionsDigestOf,
  writeTemporalManifest,
  writeTemporalSessions,
  writeTemporalSummary,
} from "./manifest.mjs";

export const TEMPORAL_RUNNER_VERSION = 1;

/** A refusal. Nothing was written and nothing was called. */
function fail(message) {
  return {
    ok: false,
    error: message,
    networkCalls: 0,
    providerCalls: 0,
    jevCalls: 0,
    arenaRuns: 0,
    tradingCalls: 0,
    launchedSessions: 0,
  };
}

const SESSION_RECORD_VOLATILE_FIELDS = Object.freeze(["recordDigest", "addedAt", "root"]);

export function temporalSessionRecordDigestOf(record) {
  if (!record || typeof record !== "object") return null;
  const subject = {};
  for (const [key, value] of Object.entries(record)) {
    if (SESSION_RECORD_VOLATILE_FIELDS.includes(key)) continue;
    subject[key] = value;
  }
  return digestOf(subject);
}

/* ============================================================================
 * Derive ONE temporal session record from the referenced immutable experiment
 * ==========================================================================*/

export async function deriveTemporalSessionRecord({
  sessionId,
  baseRoot = null,
  expected,
  otherSessions = [],
  temporalId = null,
  sessionIndex = null,
}) {
  const root = directionExperimentRootFor(baseRoot, sessionId);
  const bundle = await readDirectionExperimentBundle(root);
  if (!bundle.experiment) {
    return { ok: false, error: `no Phase 5I experiment at ${root}`, sessionId, root };
  }
  const replay = await replayDirectionExperiment({ experimentId: sessionId, baseRoot });
  const protocol = verifyReplicationProtocol(bundle.experiment);
  const eligibility = evaluateTemporalSession({
    sessionId,
    experiment: bundle.experiment,
    summary: bundle.summary,
    predictions: bundle.predictions,
    outcomes: bundle.outcomes,
    replay,
    protocol,
    expected,
    otherSessions,
  });
  const metrics = compactSessionMetrics(replay);
  const timing = eligibility.timing;
  const record = {
    temporalRunnerVersion: TEMPORAL_RUNNER_VERSION,
    temporalId,
    sessionIndex,
    sessionId,
    root,
    experimentId: bundle.experiment.experimentId,
    evidenceClass: bundle.experiment.evidenceClass,
    metricsDigest: bundle.summary?.metricsDigest ?? null,
    protocolDigest: protocol.digest,
    protocolExpectedDigest: protocol.expectedDigest,
    protocolOk: protocol.ok,
    protocolDifferences: protocol.differences,
    protocolUnchangedFromReplication: protocol.digest === TEMPORAL_PROTOCOL_DIGEST,
    // ---- §9 the canonical Phase 5I.1 reference (read only) ------------------
    canonicalReplicationId: CANONICAL_REPLICATION_BARRIER.replicationId,
    canonicalReplicationDigest: CANONICAL_REPLICATION_BARRIER.manifestContentDigest,
    canonicalReplicationAggregateDigest: CANONICAL_REPLICATION_BARRIER.aggregateMetricsDigest,
    canonicalReplicationSessionRecordsDigest: CANONICAL_REPLICATION_BARRIER.sessionRecordsDigest,
    canonicalReplicationProtocolDigest: CANONICAL_REPLICATION_BARRIER.protocolDigest,
    // ---- §5 temporal identity + timing (persisted verbatim) -----------------
    sessionStartedAt: timing.sessionStartedAt,
    sessionCompletedAt: timing.sessionCompletedAt,
    earliestObservationAt: timing.earliestObservationAt,
    latestObservationAt: timing.latestObservationAt,
    utcDate: timing.utcDate,
    gapFromPreviousEligibleSessionMs: timing.gapFromPreviousEligibleSessionMs,
    overlapWithDevelopment: timing.overlapWithDevelopment,
    overlapWithCanonicalReplication: timing.overlapWithCanonicalReplication,
    overlapWithTemporalExtensionSession: timing.overlapWithTemporalExtensionSession,
    temporalEligibilityReasons: eligibility.temporalEligibilityReasons,
    selectionBasis: eligibility.selectionBasis,
    timingNotSelectedFromObservedPerformance: true,
    timingNotSelectedFromMarketView: true,
    status: eligibility.status,
    eligible: eligibility.eligible,
    reasons: eligibility.reasons,
    contaminationReasons: eligibility.contaminationReasons,
    ineligibilityReasons: eligibility.ineligibilityReasons,
    checks: eligibility.checks,
    timing,
    windowMs: timing.windowMs,
    counts: replay.counts ?? null,
    lookahead: {
      ok: replay.lookaheadAudit?.ok === true,
      recomputationPairs: replay.lookaheadAudit?.recomputationPairs ?? null,
    },
    replayOk: replay.ok === true,
    metrics,
  };
  return { ok: true, record: { ...record, recordDigest: temporalSessionRecordDigestOf(record) }, replay, eligibility, protocol };
}

/* ============================================================================
 * The canonical Phase 5I.1 reference (READ ONLY)
 * ==========================================================================*/

async function readCanonicalReplication({ canonicalRoot = null } = {}) {
  const root = replicationRootFor(canonicalRoot ?? DIRECTION_REPLICATION_ROOT_DIR, CANONICAL_REPLICATION_BARRIER.replicationId);
  const bundle = await readReplicationBundle(root);
  return {
    root,
    present: bundle.manifest !== null,
    summary: bundle.summary,
    manifest: bundle.manifest,
    aggregateMetricsDigest: bundle.summary?.aggregateMetricsDigest ?? CANONICAL_REPLICATION_BARRIER.aggregateMetricsDigest,
    sessionRecordsDigest: bundle.summary?.sessionRecordsDigest ?? CANONICAL_REPLICATION_BARRIER.sessionRecordsDigest,
    manifestContentDigest: bundle.manifest?.manifestContentDigest ?? CANONICAL_REPLICATION_BARRIER.manifestContentDigest,
  };
}

/* ============================================================================
 * Summary
 * ==========================================================================*/

export async function buildTemporalSummary({
  manifest,
  sessions = [],
  canonical = null,
  now = () => Date.now(),
}) {
  const eligible = sessions.filter((entry) => entry.status === "CLEAN");
  const excluded = sessions.filter((entry) => entry.status !== "CLEAN");
  const aggregation = aggregateTemporalSessions(sessions, {
    status:
      eligible.length >= REQUIRED_CLEAN_TEMPORAL_SESSIONS ? TEMPORAL_COMPLETE_STATE : TEMPORAL_INSUFFICIENT_STATE,
    excludedSessions: excluded,
    requiredCleanSessions: REQUIRED_CLEAN_TEMPORAL_SESSIONS,
  });

  const summary = {
    schemaVersion: 1,
    summaryVersion: 1,
    phase: TEMPORAL_PHASE,
    protocolPhase: "5I.0b",
    artifactKind: "DIRECTION_TEMPORAL_EXTENSION_SUMMARY",
    temporalId: manifest.temporalId,
    evidenceClass: TEMPORAL_REPLICATION_EVIDENCE_CLASS,
    developmentOnly: false,
    replicationOnly: true,
    temporalExtensionOnly: true,
    noProfitabilityInference: true,
    noTradingInference: true,
    noDeploymentInference: true,
    paperOnly: true,
    shadowOnly: true,
    developmentExperimentId: manifest.developmentExperimentId,
    developmentMetricsDigest: manifest.developmentMetricsDigest,
    // ---- §9 the canonical Phase 5I.1 reference -----------------------------
    canonicalReplicationId: CANONICAL_REPLICATION_BARRIER.replicationId,
    canonicalReplicationDigest: CANONICAL_REPLICATION_BARRIER.manifestContentDigest,
    canonicalReplicationAggregateDigest: CANONICAL_REPLICATION_BARRIER.aggregateMetricsDigest,
    canonicalReplicationSessionRecordsDigest: CANONICAL_REPLICATION_BARRIER.sessionRecordsDigest,
    canonicalReplicationProtocolDigest: CANONICAL_REPLICATION_BARRIER.protocolDigest,
    canonicalReplicationStatus: CANONICAL_REPLICATION_BARRIER.status,
    canonicalReplicationCleanSessionCount: CANONICAL_REPLICATION_BARRIER.cleanSessionCount,
    canonicalArtifactsPresent: canonical?.present === true,
    canonicalResultImmutable: true,
    canonicalResultIndependentlyReproducible: true,
    // ---- §10 the protocol contract (SAME digest as Phase 5I.1) -------------
    temporalProtocolVersion: TEMPORAL_PROTOCOL_VERSION,
    temporalProtocolDigest: TEMPORAL_PROTOCOL_DIGEST,
    protocolDigest: TEMPORAL_PROTOCOL_DIGEST,
    protocolUnchangedFromReplication: TEMPORAL_PROTOCOL_DIGEST === REPLICATION_PROTOCOL_DIGEST,
    replicationProtocolVersion: REPLICATION_PROTOCOL_VERSION,
    // ---- §5 independence + selection rules --------------------------------
    independenceRules: { ...TEMPORAL_INDEPENDENCE_RULES },
    temporalSelectionRules: { ...TEMPORAL_SELECTION_RULES },
    selectionBasis: TEMPORAL_SELECTION_RULES.selectionBasis,
    timingNotSelectedFromObservedPerformance: true,
    timingNotSelectedFromMarketView: true,
    violationPreservedNeverSilentlyExcluded: true,
    // ---- §13 aggregation ---------------------------------------------------
    status: aggregation.status,
    cleanSessionCount: aggregation.cleanSessionCount,
    cleanSessionIds: aggregation.cleanSessionIds,
    totalSessionCount: aggregation.totalSessionCount,
    requiredCleanSessions: aggregation.requiredCleanSessions,
    primaryInferenceUnit: aggregation.primaryInferenceUnit,
    equalWeightedByEligibleSession: true,
    equalWeightPerCleanSession: true,
    noObservationLevelPseudoReplication: true,
    observationsNeverPooled: true,
    perSession: sessions.map((entry) => ({
      sessionId: entry.sessionId,
      status: entry.status,
      metricsDigest: entry.metricsDigest ?? null,
      protocolOk: entry.protocolOk === true,
      utcDate: entry.utcDate ?? null,
      gapFromPreviousEligibleSessionMs: entry.gapFromPreviousEligibleSessionMs ?? null,
      overlapWithDevelopment: entry.overlapWithDevelopment === true,
      overlapWithCanonicalReplication: entry.overlapWithCanonicalReplication === true,
      overlapWithTemporalExtensionSession: entry.overlapWithTemporalExtensionSession === true,
      temporalEligibilityReasons: entry.temporalEligibilityReasons ?? [],
      jev: entry.metrics?.jev ?? null,
      deltas: entry.metrics?.deltas ?? null,
      counts: entry.counts ?? null,
      timing: entry.timing ?? null,
      recordDigest: entry.recordDigest ?? null,
      reasons: entry.reasons ?? [],
    })),
    excludedSessions: excluded.map((entry) => ({
      sessionId: entry.sessionId,
      status: entry.status,
      temporalEligibilityReasons: entry.temporalEligibilityReasons ?? [],
      reasons: entry.reasons ?? [],
    })),
    comparisons: aggregation.comparisons,
    absolute: aggregation.absolute,
    bootstrap: aggregation.bootstrap,
    bootstrapState: aggregation.bootstrapState,
    deltaSignConvention: aggregation.deltaSignConvention,
    comparisonsReported: REPLICATION_COMPARISON_IDS.length,
    sessionSize: TEMPORAL_SESSION_OBSERVATIONS,
    winner: null,
    noAutomatedWinner: true,
    noNewWinnerField: true,
    significanceClaimed: false,
    profitabilityInference: false,
    tradingInference: false,
    deploymentInference: false,
    automaticPromotionToPhase5I2: false,
    noJevCacheInPredictivePath: true,
    singleAssetOnly: true,
    crossAssetTestingDeferredTo: "5I.1b",
    sessionRecordsDigest: sessionsDigestOf(sessions),
    createdAt: manifest.createdAt ?? null,
    computedAt: new Date(now()).toISOString(),
    note:
      "Phase 5I.1a temporal-extension summary. It aggregates ONLY CLEAN temporal-extension sessions, equal-weighted by session, " +
      "under the SAME frozen protocol digest as the canonical Phase 5I.1 wave. It contains no winner, no significance claim, no " +
      "profitability/trading/deployment inference, and it never rewrites or re-scores the canonical result.",
  };

  const combinedView = buildCombinedDescriptiveView({
    canonicalSummary: canonical?.summary ?? null,
    canonicalBundlePresent: canonical?.present === true,
    temporalSummary: { ...summary, perSession: summary.perSession },
  });

  return {
    ...summary,
    combinedView,
    combinedViewDigest: combinedDigestOf(combinedView),
    aggregateMetricsDigest: aggregateDigestOf(summary),
  };
}

/* ============================================================================
 * temporal-create
 * ==========================================================================*/

export async function temporalCreate({
  temporalRoot = null,
  canonicalRoot = null,
  now = () => Date.now(),
  temporalId = null,
  canonicalReplicationId = null,
} = {}) {
  const root = temporalRoot ?? DIRECTION_TEMPORAL_ROOT_DIR;
  const requestedCanonical =
    canonicalReplicationId === null || String(canonicalReplicationId).trim() === ""
      ? CANONICAL_REPLICATION_BARRIER.replicationId
      : String(canonicalReplicationId).trim();
  if (requestedCanonical !== CANONICAL_REPLICATION_BARRIER.replicationId) {
    return fail(
      `the Phase 5I.1a temporal extension names exactly the canonical Phase 5I.1 wave ` +
        `${CANONICAL_REPLICATION_BARRIER.replicationId}; ${requestedCanonical} is not the canonical replication baseline`,
    );
  }

  // The canonical replication wave is READ ONLY when present locally, and
  // cleanly absent-aware in a checkout that does not carry it. It is NEVER
  // written to.
  const canonical = await readCanonicalReplication({ canonicalRoot });
  const problems = [];
  if (canonical.present) {
    if (canonical.manifestContentDigest !== CANONICAL_REPLICATION_BARRIER.manifestContentDigest) {
      problems.push(
        `the canonical Phase 5I.1 manifest digest is ${String(canonical.manifestContentDigest)}; the pinned barrier says ` +
          `${CANONICAL_REPLICATION_BARRIER.manifestContentDigest}`,
      );
    }
    if (canonical.aggregateMetricsDigest !== CANONICAL_REPLICATION_BARRIER.aggregateMetricsDigest) {
      problems.push(
        `the canonical Phase 5I.1 aggregate digest is ${String(canonical.aggregateMetricsDigest)}; the pinned barrier says ` +
          `${CANONICAL_REPLICATION_BARRIER.aggregateMetricsDigest}`,
      );
    }
    if (canonical.sessionRecordsDigest !== CANONICAL_REPLICATION_BARRIER.sessionRecordsDigest) {
      problems.push("the canonical Phase 5I.1 session-records digest does not match the pinned barrier");
    }
  }
  if (problems.length > 0) {
    return { ok: false, error: problems.join("; "), problems, canonicalArtifactsPresent: canonical.present, networkCalls: 0, readOnly: false };
  }

  const id = temporalId ?? temporalIdFor({ createdAt: now() });
  if (!isValidTemporalId(id)) return fail(`invalid temporal-extension id '${id}'`);
  const idRoot = temporalRootFor(root, id);
  const existing = await readTemporalManifest(idRoot);
  if (existing) {
    return fail(`temporal extension ${id} already exists; explicit ids are never reused (a wave is created once)`);
  }

  const manifest = createTemporalManifest({
    temporalId: id,
    createdAt: now(),
    canonicalArtifactsPresent: canonical.present,
  });
  await writeTemporalManifest(idRoot, manifest);
  await writeTemporalSessions(idRoot, createTemporalSessionsDocument({ temporalId: id, sessions: [] }));
  const sessionsDoc = await readTemporalSessions(idRoot);
  const summary = await buildTemporalSummary({
    manifest,
    sessions: sessionsDoc?.sessions ?? [],
    canonical,
    now,
  });
  await writeTemporalSummary(idRoot, summary);

  return {
    ok: true,
    action: "temporal-create",
    temporalId: id,
    root: idRoot,
    canonicalReplicationId: CANONICAL_REPLICATION_BARRIER.replicationId,
    canonicalReplicationDigest: CANONICAL_REPLICATION_BARRIER.manifestContentDigest,
    canonicalReplicationAggregateDigest: CANONICAL_REPLICATION_BARRIER.aggregateMetricsDigest,
    canonicalReplicationSessionRecordsDigest: CANONICAL_REPLICATION_BARRIER.sessionRecordsDigest,
    canonicalArtifactsPresent: canonical.present,
    protocolDigest: TEMPORAL_PROTOCOL_DIGEST,
    manifestDigest: manifestDigestOf(manifest),
    status: summary.status,
    cleanSessionCount: summary.cleanSessionCount,
    totalSessionCount: summary.totalSessionCount,
    requiredCleanSessions: REQUIRED_CLEAN_TEMPORAL_SESSIONS,
    networkCalls: 0,
    providerCalls: 0,
    jevCalls: 0,
    arenaRuns: 0,
    tradingCalls: 0,
    launchedSessions: 0,
    readOnly: false,
    summary,
  };
}

/* ============================================================================
 * temporal-add
 * ==========================================================================*/

export async function temporalAdd({
  temporalId,
  sessionId,
  temporalRoot = null,
  baseRoot = null,
  canonicalRoot = null,
  now = () => Date.now(),
} = {}) {
  const root = temporalRoot ?? DIRECTION_TEMPORAL_ROOT_DIR;
  if (!isValidTemporalId(temporalId)) return fail(`invalid temporal-extension id '${temporalId}'`);
  const idRoot = temporalRootFor(root, temporalId);
  const manifest = await readTemporalManifest(idRoot);
  if (!manifest) return fail(`no Phase 5I.1a temporal extension at ${idRoot}`);
  const session = String(sessionId ?? "").trim();
  if (session.length === 0) return fail("--temporal-add requires an explicit --experiment <id>; there is no \"latest\"");
  if (session.toLowerCase() === "latest" || session.toLowerCase() === "all") {
    return fail(`--experiment ${session} is refused: Phase 5I.1a never guesses which experiment you meant`);
  }
  const protectedReason = protectedTemporalExperimentReason(session);
  if (protectedReason !== null) return fail(protectedReason);

  const sessionsDoc = (await readTemporalSessions(idRoot)) ?? createTemporalSessionsDocument({ temporalId, sessions: [] });
  const existingSessions = sessionsDoc.sessions ?? [];
  if (existingSessions.some((entry) => entry.sessionId === session)) {
    return fail(`session ${session} is already recorded in temporal extension ${temporalId}; a session is added exactly once`);
  }

  const expected = { ...manifest.expected, protocolDigest: TEMPORAL_PROTOCOL_DIGEST };
  const derived = await deriveTemporalSessionRecord({
    sessionId: session,
    baseRoot,
    expected,
    otherSessions: existingSessions,
    temporalId,
    sessionIndex: existingSessions.length,
  });
  if (!derived.ok) return fail(derived.error);

  const record = { ...derived.record, addedAt: new Date(now()).toISOString() };
  let sessions = [...existingSessions, record];

  // ---- FULL SET RE-DERIVATION -------------------------------------------
  // Temporal independence is a property of the WHOLE session set, not of one
  // session: a new session can invalidate an already-recorded CLEAN one (overlap,
  // or a shared UTC calendar date) and it also changes every earlier session's
  // "previous eligible session" gap. Each stored record is therefore RE-DERIVED
  // against the FULL stored set here, which makes the stored records a pure
  // function of that set and exactly reproducible under `--temporal-replay`.
  const rederivedAll = [];
  for (let index = 0; index < sessions.length; index += 1) {
    const stored = sessions[index];
    const rederived = await deriveTemporalSessionRecord({
      sessionId: stored.sessionId,
      baseRoot,
      expected,
      otherSessions: sessions,
      temporalId,
      sessionIndex: index,
    });
    if (!rederived.ok) {
      rederivedAll.push(stored);
      continue;
    }
    rederivedAll.push({ ...rederived.record, addedAt: stored.addedAt ?? null });
  }
  sessions = rederivedAll;
  const finalRecord = sessions.find((entry) => entry.sessionId === session) ?? record;
  await writeTemporalSessions(idRoot, createTemporalSessionsDocument({ temporalId, sessions }));
  const canonical = await readCanonicalReplication({ canonicalRoot });
  const summary = await buildTemporalSummary({ manifest, sessions, canonical, now });
  await writeTemporalSummary(idRoot, summary);
  await writeTemporalManifest(idRoot, {
    ...manifest,
    status: summary.cleanSessionCount >= REQUIRED_CLEAN_TEMPORAL_SESSIONS ? "CLEAN_SESSIONS_COMPLETE" : "OPEN",
    sessionCount: sessions.length,
  });

  return {
    ok: true,
    action: "temporal-add",
    temporalId,
    root: idRoot,
    sessionId: session,
    sessionStatus: finalRecord.status,
    sessionEligible: finalRecord.eligible === true,
    sessionReasons: finalRecord.reasons ?? [],
    temporalEligibilityReasons: finalRecord.temporalEligibilityReasons ?? [],
    utcDate: finalRecord.utcDate,
    gapFromPreviousEligibleSessionMs: finalRecord.gapFromPreviousEligibleSessionMs,
    overlapWithDevelopment: finalRecord.overlapWithDevelopment,
    overlapWithCanonicalReplication: finalRecord.overlapWithCanonicalReplication,
    overlapWithTemporalExtensionSession: finalRecord.overlapWithTemporalExtensionSession,
    protocolDigest: finalRecord.protocolDigest,
    protocolOk: finalRecord.protocolOk === true,
    metricsDigest: finalRecord.metricsDigest,
    recordDigest: finalRecord.recordDigest,
    cleanSessionCount: summary.cleanSessionCount,
    totalSessionCount: summary.totalSessionCount,
    status: summary.status,
    networkCalls: 0,
    providerCalls: 0,
    jevCalls: 0,
    arenaRuns: 0,
    tradingCalls: 0,
    launchedSessions: 0,
    readOnly: false,
    summary,
  };
}

/* ============================================================================
 * Offline replay / stats (READ ONLY, zero network)
 * ==========================================================================*/

async function rederiveTemporal({ temporalId, temporalRoot = null, baseRoot = null, canonicalRoot = null, now = () => Date.now() }) {
  const root = temporalRoot ?? DIRECTION_TEMPORAL_ROOT_DIR;
  if (!isValidTemporalId(temporalId)) return { ok: false, problems: [`invalid temporal-extension id '${temporalId}'`] };
  const idRoot = temporalRootFor(root, temporalId);
  const bundle = await readTemporalBundle(idRoot);
  const problems = [];
  if (!bundle.manifest) return { ok: false, problems: [`no Phase 5I.1a temporal extension at ${idRoot}`], root: idRoot, manifest: null };

  // Fail closed on a manifest whose frozen declarations drifted.
  const manifestAudit = verifyTemporalManifest(bundle.manifest);
  if (!manifestAudit.ok) problems.push(...manifestAudit.problems);

  const before = await temporalMetadataSnapshot(idRoot);
  const storedSessions = bundle.sessions?.sessions ?? [];
  const derivedSessions = [];
  for (const stored of storedSessions) {
    const derived = await deriveTemporalSessionRecord({
      sessionId: stored.sessionId,
      baseRoot,
      expected: { ...bundle.manifest.expected, protocolDigest: TEMPORAL_PROTOCOL_DIGEST },
      otherSessions: storedSessions,
      temporalId,
      sessionIndex: stored.sessionIndex ?? 0,
    });
    if (!derived.ok) {
      problems.push(`session ${stored.sessionId}: ${derived.error}`);
      derivedSessions.push(stored);
      continue;
    }
    const fresh = { ...derived.record, addedAt: stored.addedAt ?? null };
    if (derived.record.recordDigest !== stored.recordDigest) {
      problems.push(
        `session ${stored.sessionId}: recorded derivation digest ${String(stored.recordDigest ?? "none")} does not reproduce ` +
          `(recomputed ${String(derived.record.recordDigest ?? "none")})`,
      );
    }
    derivedSessions.push(fresh);
  }

  const canonical = await readCanonicalReplication({ canonicalRoot });
  const recomputedSummary = await buildTemporalSummary({ manifest: bundle.manifest, sessions: derivedSessions, canonical, now });
  const storedAggregate = bundle.summary?.aggregateMetricsDigest ?? null;
  const recomputedAggregate = recomputedSummary.aggregateMetricsDigest;
  if (storedAggregate !== null && storedAggregate !== recomputedAggregate) {
    problems.push("the stored temporal aggregation does not reproduce from the referenced session artifacts");
  }
  if (storedSessions.length > 0 && sessionsDigestOf(derivedSessions) !== sessionsDigestOf(storedSessions)) {
    problems.push("the stored temporal session records do not reproduce from the referenced session artifacts");
  }
  if (canonical.present) {
    if (canonical.manifestContentDigest !== CANONICAL_REPLICATION_BARRIER.manifestContentDigest) {
      problems.push("the canonical Phase 5I.1 manifest digest drifted from the pinned barrier");
    }
    if (canonical.aggregateMetricsDigest !== CANONICAL_REPLICATION_BARRIER.aggregateMetricsDigest) {
      problems.push("the canonical Phase 5I.1 aggregate digest drifted from the pinned barrier");
    }
    if (canonical.sessionRecordsDigest !== CANONICAL_REPLICATION_BARRIER.sessionRecordsDigest) {
      problems.push("the canonical Phase 5I.1 session-records digest drifted from the pinned barrier");
    }
  }
  const after = await temporalMetadataSnapshot(idRoot);
  if (digestOf(before) !== digestOf(after)) {
    problems.push("the offline temporal pass rewrote the temporal tree");
  }

  return {
    ok: problems.length === 0,
    root: idRoot,
    manifest: bundle.manifest,
    sessions: derivedSessions,
    storedSummary: bundle.summary,
    summary: recomputedSummary,
    canonical,
    storedAggregateDigest: storedAggregate,
    recomputedAggregateDigest: recomputedAggregate,
    metricsMatch: storedAggregate !== null && storedAggregate === recomputedAggregate,
    before,
    after,
    problems,
  };
}

/** Offline replay of an entire temporal extension. ZERO network. */
export async function temporalReplay({ temporalId, temporalRoot = null, baseRoot = null, canonicalRoot = null, now = () => Date.now() }) {
  const result = await rederiveTemporal({ temporalId, temporalRoot, baseRoot, canonicalRoot, now });
  const zero = {
    readOnly: true,
    networkCalls: 0,
    providerCalls: 0,
    jevCalls: 0,
    agentReachCalls: 0,
    classifierCalls: 0,
    deepseekCalls: 0,
    arenaRuns: 0,
    tradingCalls: 0,
    launchedSessions: 0,
  };
  if (!result.manifest) {
    return { ...zero, ok: false, temporalId, root: result.root, problems: result.problems, sessionsDigestMatches: false, manifestDigestMatches: false };
  }
  return {
    ...result,
    ...zero,
    temporalId,
    evidenceClass: result.manifest.evidenceClass,
    canonicalReplicationId: result.manifest.canonicalReplicationId,
    canonicalReplicationDigest: result.manifest.canonicalReplicationDigest,
    canonicalReplicationAggregateDigest: result.manifest.canonicalReplicationAggregateDigest,
    canonicalReplicationSessionRecordsDigest: result.manifest.canonicalReplicationSessionRecordsDigest,
    protocolDigest: result.manifest.protocolDigest,
    storedManifestDigest: result.manifest.manifestContentDigest ?? null,
    recomputedManifestDigest: manifestDigestOf(result.manifest),
    manifestDigestMatches:
      result.manifest.manifestContentDigest === undefined ||
      result.manifest.manifestContentDigest === manifestDigestOf(result.manifest),
    sessionsDigestMatches: sessionsDigestOf(result.sessions) === (result.storedSummary?.sessionRecordsDigest ?? null),
    counts: {
      sessions: result.sessions.length,
      cleanSessions: result.sessions.filter((entry) => entry.status === "CLEAN").length,
      contaminatedSessions: result.sessions.filter((entry) => entry.status === "CONTAMINATED").length,
      ineligibleSessions: result.sessions.filter((entry) => entry.status === "INELIGIBLE").length,
    },
  };
}

/** The same derivation plus the combined view, shaped for human reporting. */
export async function temporalStats({ temporalId, temporalRoot = null, baseRoot = null, canonicalRoot = null, now = () => Date.now() }) {
  const result = await rederiveTemporal({ temporalId, temporalRoot, baseRoot, canonicalRoot, now });
  if (!result.manifest) {
    return { ok: false, error: result.problems[0] ?? "temporal extension not found", temporalId, root: result.root, readOnly: true };
  }
  return {
    ok: true,
    temporalId,
    root: result.root,
    manifest: result.manifest,
    sessions: result.sessions,
    summary: result.summary,
    combinedView: result.summary.combinedView,
    storedSummary: result.storedSummary,
    canonical: {
      replicationId: CANONICAL_REPLICATION_BARRIER.replicationId,
      present: result.canonical?.present === true,
      manifestContentDigest: CANONICAL_REPLICATION_BARRIER.manifestContentDigest,
      aggregateMetricsDigest: CANONICAL_REPLICATION_BARRIER.aggregateMetricsDigest,
      sessionRecordsDigest: CANONICAL_REPLICATION_BARRIER.sessionRecordsDigest,
    },
    problems: result.problems,
    metricsMatch: result.metricsMatch,
    storedAggregateDigest: result.storedAggregateDigest,
    recomputedAggregateDigest: result.recomputedAggregateDigest,
    readOnly: true,
    networkCalls: 0,
    providerCalls: 0,
    jevCalls: 0,
    arenaRuns: 0,
    tradingCalls: 0,
    launchedSessions: 0,
  };
}

export { utcDateOf };
