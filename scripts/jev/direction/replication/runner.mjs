/**
 * Phase 5I.1 — THE REPLICATION WAVE RUNNER.
 *
 * Four explicit, ID-ONLY operations. There is no daemon, no background process,
 * no "latest", and — critically — NO OPERATION HERE EVER LAUNCHES A SESSION:
 *
 *   replicationCreate  writes a manifest that source-pins the completed
 *                      canonical Phase 5I.0b development barrier and the frozen
 *                      replication protocol digest. It runs nothing.
 *   replicationAdd     reads ONE already-completed fresh `jdir-*` experiment,
 *                      replays it OFFLINE, derives its eligibility + metrics, and
 *                      records it (CLEAN, CONTAMINATED or INELIGIBLE) in the
 *                      manifest. It runs nothing.
 *   replicationReplay  re-derives every recorded session from its own immutable
 *                      artifacts and proves the manifest/summary still describe
 *                      it. READ ONLY, ZERO NETWORK.
 *   replicationStats   the same derivation, reported for a human. READ ONLY,
 *                      ZERO NETWORK.
 *
 * The operator runs each 120-observation session manually, reviews its integrity,
 * and only then adds it here (§18).
 *
 * PAPER ONLY / NO TRADING. No wallet, no signing, no swap, no order, no Arena
 * routing, no DeepSeek routing, no external-agent routing of any kind, and no
 * confidence threshold.
 */

import { digestOf } from "../../../lib/hash.mjs";
import { directionExperimentRootFor, readDirectionExperimentBundle } from "../storage.mjs";
import { replayDirectionExperiment } from "../runner.mjs";
import { CANONICAL_DEVELOPMENT_BARRIER, verifyCanonicalDevelopmentBarrier } from "./development-barrier.mjs";
import {
  compactSessionMetrics,
  evaluateReplicationSession,
  protectedExperimentReason,
} from "./eligibility.mjs";
import {
  aggregateReplicationSessions,
  REPLICATION_COMPLETE_STATE,
  REPLICATION_INSUFFICIENT_STATE,
} from "./aggregate.mjs";
import {
  DIRECTION_REPLICATION_ROOT_DIR,
  REPLICATION_COMPARISON_IDS,
  REPLICATION_DELTA_METRICS,
  REPLICATION_PROTOCOL_CONTRACT,
  REPLICATION_PROTOCOL_DIGEST,
  REPLICATION_PROTOCOL_VERSION,
  REPLICATION_SESSION_OBSERVATIONS,
  REQUIRED_CLEAN_REPLICATION_SESSIONS,
  verifyReplicationProtocol,
} from "./protocol.mjs";
import {
  aggregateDigestOf,
  createReplicationManifest,
  createSessionsDocument,
  isValidReplicationId,
  manifestDigestOf,
  readReplicationBundle,
  readReplicationManifest,
  readReplicationSessions,
  replicationIdFor,
  replicationMetadataSnapshot,
  replicationRootFor,
  sessionsDigestOf,
  writeReplicationManifest,
  writeReplicationSessions,
  writeReplicationSummary,
} from "./manifest.mjs";

export const REPLICATION_RUNNER_VERSION = 1;

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

/**
 * The fields a session record digest must ignore: the digest itself, when it was
 * recorded, and its filesystem location. Everything semantic (ids, counts,
 * metrics, eligibility reasons, timings) stays inside the digest.
 */
const SESSION_RECORD_VOLATILE_FIELDS = Object.freeze(["recordDigest", "addedAt", "root"]);

export function sessionRecordDigestOf(record) {
  if (!record || typeof record !== "object") return null;
  const subject = {};
  for (const [key, value] of Object.entries(record)) {
    if (SESSION_RECORD_VOLATILE_FIELDS.includes(key)) continue;
    subject[key] = value;
  }
  return digestOf(subject);
}

/**
 * Derive ONE session record from the referenced immutable experiment.
 *
 * READ ONLY: the experiment's own artifacts are read and replayed, never
 * rewritten, and its raw observations are never duplicated into the manifest.
 */
export async function deriveReplicationSessionRecord({
  sessionId,
  baseRoot = null,
  expected,
  otherSessions = [],
  replicationId = null,
  sessionIndex = null,
}) {
  const root = directionExperimentRootFor(baseRoot, sessionId);
  const bundle = await readDirectionExperimentBundle(root);
  if (!bundle.experiment) {
    return { ok: false, error: `no Phase 5I experiment at ${root}`, sessionId, root };
  }
  const replay = await replayDirectionExperiment({ experimentId: sessionId, baseRoot });
  const protocol = verifyReplicationProtocol(bundle.experiment);
  const eligibility = evaluateReplicationSession({
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
  const record = {
    replicationRunnerVersion: REPLICATION_RUNNER_VERSION,
    replicationId,
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
    status: eligibility.status,
    eligible: eligibility.eligible,
    reasons: eligibility.reasons,
    contaminationReasons: eligibility.contaminationReasons,
    ineligibilityReasons: eligibility.ineligibilityReasons,
    checks: eligibility.checks,
    timing: eligibility.timing,
    windowMs: eligibility.timing.windowMs,
    counts: replay.counts ?? null,
    lookahead: {
      ok: replay.lookaheadAudit?.ok === true,
      recomputationPairs: replay.lookaheadAudit?.recomputationPairs ?? null,
    },
    replayOk: replay.ok === true,
    metrics,
  };
  return { ok: true, record: { ...record, recordDigest: sessionRecordDigestOf(record) }, replay, eligibility, protocol };
}

/** Build the frozen summary for a set of session records. */
export async function buildReplicationSummary({ manifest, sessions = [], now = () => Date.now() }) {
  const eligible = sessions.filter((entry) => entry.status === "CLEAN");
  const excluded = sessions.filter((entry) => entry.status !== "CLEAN");
  const aggregation = aggregateReplicationSessions(sessions, {
    status: eligible.length >= REQUIRED_CLEAN_REPLICATION_SESSIONS ? REPLICATION_COMPLETE_STATE : REPLICATION_INSUFFICIENT_STATE,
    excludedSessions: excluded,
    requiredCleanSessions: REQUIRED_CLEAN_REPLICATION_SESSIONS,
  });
  const summary = {
    schemaVersion: 1,
    phase: CANONICAL_DEVELOPMENT_BARRIER.phase,
    artifactKind: "DIRECTION_REPLICATION_SUMMARY",
    replicationId: manifest.replicationId,
    evidenceClass: manifest.evidenceClass,
    developmentOnly: false,
    replicationOnly: true,
    noProfitabilityInference: true,
    noTradingInference: true,
    noDeploymentInference: true,
    paperOnly: true,
    shadowOnly: true,
    developmentExperimentId: manifest.developmentExperimentId,
    developmentMetricsDigest: manifest.developmentMetricsDigest,
    replicationProtocolVersion: REPLICATION_PROTOCOL_VERSION,
    replicationProtocolDigest: REPLICATION_PROTOCOL_DIGEST,
    status: aggregation.status,
    cleanSessionCount: aggregation.cleanSessionCount,
    cleanSessionIds: aggregation.cleanSessionIds,
    totalSessionCount: aggregation.totalSessionCount,
    requiredCleanSessions: aggregation.requiredCleanSessions,
    primaryInferenceUnit: aggregation.primaryInferenceUnit,
    equalWeightedByEligibleSession: true,
    noObservationLevelPseudoReplication: true,
    perSession: sessions.map((entry) => ({
      sessionId: entry.sessionId,
      status: entry.status,
      metricsDigest: entry.metricsDigest ?? null,
      protocolOk: entry.protocolOk === true,
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
      reasons: entry.reasons ?? [],
    })),
    comparisons: aggregation.comparisons,
    absolute: aggregation.absolute,
    bootstrap: aggregation.bootstrap,
    deltaSignConvention: aggregation.deltaSignConvention,
    comparisonsReported: REPLICATION_COMPARISON_IDS.length,
    deltaMetricsReported: REPLICATION_DELTA_METRICS.length,
    sessionSize: REPLICATION_SESSION_OBSERVATIONS,
    winner: null,
    noAutomatedWinner: true,
    significanceClaimed: false,
    profitabilityInference: false,
    tradingInference: false,
    deploymentInference: false,
    noTuningBetweenSessions: true,
    interruptedWaveIsIncomparable: true,
    minimumWarmupNote:
      "Sessions are aggregated only when CLEAN (eligible, temporally independent, unfinalized-session excluded). A wave of fewer " +
      `than ${REQUIRED_CLEAN_REPLICATION_SESSIONS} CLEAN sessions reports ${REPLICATION_INSUFFICIENT_STATE} and no uncertainty interval.`,
    sessionRecordsDigest: sessionsDigestOf(sessions),
    createdAt: manifest.createdAt ?? null,
    computedAt: new Date(now()).toISOString(),
    note:
      "Phase 5I.1 frozen-protocol replication. This summary describes session-level predictive behavior on fresh unseen SOL/USDC " +
      "sessions. It contains no winner, no significance claim, no profitability, trading or deployment inference, and it gives " +
      "Jev no authority of any kind.",
  };
  return { ...summary, aggregateMetricsDigest: aggregateDigestOf(summary) };
}

/* ============================================================================
 * replication-create
 * ==========================================================================*/

/**
 * §3/§9/§10 create the replication manifest, source-pinning the canonical
 * development barrier. This NEVER launches a session and NEVER starts a run.
 */
export async function replicationCreate({
  replicationRoot = null,
  baseRoot = null,
  developmentExperimentId = null,
  now = () => Date.now(),
  replicationId = null,
}) {
  const root = replicationRoot ?? DIRECTION_REPLICATION_ROOT_DIR;
  const requested = developmentExperimentId === null ? null : String(developmentExperimentId).trim();
  if (requested === null || requested.length === 0) {
    return fail("--replication-create requires an explicit --development <id>; there is no \"latest\"");
  }
  if (requested !== CANONICAL_DEVELOPMENT_BARRIER.experimentId) {
    return fail(
      `the Phase 5I.1 development barrier names exactly ${CANONICAL_DEVELOPMENT_BARRIER.experimentId}; ` +
        `${requested} is not the canonical Phase 5I.0b development experiment, so it cannot be source-pinned as the replication baseline`,
    );
  }

  // The development experiment is VERIFIED READ ONLY when present locally, and
  // cleanly absent-aware in a checkout that does not carry it.
  const developmentRoot = directionExperimentRootFor(baseRoot, requested);
  const bundle = await readDirectionExperimentBundle(developmentRoot);
  let developmentArtifactsPresent = false;
  const problems = [];
  if (bundle.experiment) {
    developmentArtifactsPresent = true;
    const replay = await replayDirectionExperiment({ experimentId: requested, baseRoot });
    const barrier = verifyCanonicalDevelopmentBarrier({
      experiment: bundle.experiment,
      summary: bundle.summary,
      replay,
    });
    if (!barrier.ok) problems.push(...barrier.problems);
    const protocol = verifyReplicationProtocol(bundle.experiment);
    if (!protocol.ok) {
      problems.push(
        `the canonical development experiment does not reproduce the frozen replication protocol digest ` +
          `(${String(protocol.digest)} != ${REPLICATION_PROTOCOL_DIGEST})`,
      );
    }
  }
  if (problems.length > 0) {
    return { ok: false, error: problems.join("; "), problems, developmentArtifactsPresent, networkCalls: 0, readOnly: false };
  }

  const id = replicationId ?? replicationIdFor({ developmentExperimentId: requested, createdAt: now() });
  if (!isValidReplicationId(id)) return fail(`invalid replication id '${id}'`);
  const idRoot = replicationRootFor(root, id);
  const existing = await readReplicationManifest(idRoot);
  if (existing) {
    return fail(`replication ${id} already exists; explicit ids are never reused (a wave is created once)`);
  }

  const manifest = createReplicationManifest({
    replicationId: id,
    development: {
      experimentId: CANONICAL_DEVELOPMENT_BARRIER.experimentId,
      metricsDigest: CANONICAL_DEVELOPMENT_BARRIER.metricsDigest,
      evidenceClass: CANONICAL_DEVELOPMENT_BARRIER.evidenceClass,
      phase: CANONICAL_DEVELOPMENT_BARRIER.phase,
      barrierDigest: digestOf(CANONICAL_DEVELOPMENT_BARRIER),
      interpretation: CANONICAL_DEVELOPMENT_BARRIER.interpretation,
      session: CANONICAL_DEVELOPMENT_BARRIER.session,
      requiredCleanSessions: REQUIRED_CLEAN_REPLICATION_SESSIONS,
    },
    protocol: REPLICATION_PROTOCOL_CONTRACT,
    createdAt: now(),
    developmentArtifactsPresent,
  });
  await writeReplicationManifest(idRoot, manifest);
  await writeReplicationSessions(idRoot, createSessionsDocument({ replicationId: id, sessions: [] }));
  const sessionsDoc = await readReplicationSessions(idRoot);
  const summary = await buildReplicationSummary({ root: idRoot, manifest, sessions: sessionsDoc?.sessions ?? [], now });
  await writeReplicationSummary(idRoot, summary);

  return {
    ok: true,
    action: "replication-create",
    replicationId: id,
    root: idRoot,
    developmentExperimentId: requested,
    developmentArtifactsPresent,
    developmentBarrierDigest: digestOf(CANONICAL_DEVELOPMENT_BARRIER),
    replicationProtocolDigest: REPLICATION_PROTOCOL_DIGEST,
    manifestDigest: manifestDigestOf(manifest),
    status: summary.status,
    cleanSessionCount: summary.cleanSessionCount,
    totalSessionCount: summary.totalSessionCount,
    requiredCleanSessions: REQUIRED_CLEAN_REPLICATION_SESSIONS,
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
 * replication-add
 * ==========================================================================*/

/**
 * §18 add ONE already-completed fresh session. The session is NOT run here; it
 * is read, replayed offline, evaluated and recorded — CLEAN or excluded, with
 * its explicit reasons preserved either way.
 */
export async function replicationAdd({
  replicationId,
  sessionId,
  replicationRoot = null,
  baseRoot = null,
  now = () => Date.now(),
}) {
  const root = replicationRoot ?? DIRECTION_REPLICATION_ROOT_DIR;
  if (!isValidReplicationId(replicationId)) return fail(`invalid replication id '${replicationId}'`);
  const idRoot = replicationRootFor(root, replicationId);
  const manifest = await readReplicationManifest(idRoot);
  if (!manifest) return fail(`no Phase 5I.1 replication at ${idRoot}`);
  const session = String(sessionId ?? "").trim();
  if (session.length === 0) return fail("--replication-add requires an explicit --experiment <id>; there is no \"latest\"");
  if (session.toLowerCase() === "latest" || session.toLowerCase() === "all") {
    return fail(`--experiment ${session} is refused: Phase 5I.1 never guesses which experiment you meant`);
  }
  const protectedReason = protectedExperimentReason(session);
  if (protectedReason !== null) return fail(protectedReason);

  const sessionsDoc = (await readReplicationSessions(idRoot)) ?? createSessionsDocument({ replicationId, sessions: [] });
  const existingSessions = sessionsDoc.sessions ?? [];
  if (existingSessions.some((entry) => entry.sessionId === session)) {
    return fail(`session ${session} is already recorded in replication ${replicationId}; a session is added exactly once`);
  }

  const expected = { ...manifest.expected, protocolDigest: REPLICATION_PROTOCOL_DIGEST };
  const derived = await deriveReplicationSessionRecord({
    sessionId: session,
    baseRoot,
    expected,
    otherSessions: existingSessions,
    replicationId,
    sessionIndex: existingSessions.length,
  });
  if (!derived.ok) return fail(derived.error);

  const record = { ...derived.record, addedAt: new Date(now()).toISOString() };
  let sessions = [...existingSessions, record];

  // ---- SYMMETRIC INDEPENDENCE --------------------------------------------
  // Temporal independence is a property of a PAIR, not of one session. A newly
  // added session whose observation window overlaps an already-recorded CLEAN
  // session contaminates BOTH, so the affected records are RE-DERIVED against the
  // full session set here. That keeps the manifest order-independent and exactly
  // reproducible under `--replication-replay`, and it means the wave can never
  // silently keep a "clean" label that a later session already invalidated.
  for (const overlappingId of derived.eligibility?.timing?.overlappingSessionIds ?? []) {
    const target = sessions.find((entry) => entry.sessionId === overlappingId);
    if (target === undefined || target.status !== "CLEAN") continue;
    const rederived = await deriveReplicationSessionRecord({
      sessionId: overlappingId,
      baseRoot,
      expected,
      otherSessions: sessions,
      replicationId,
      sessionIndex: target.sessionIndex ?? 0,
    });
    if (!rederived.ok) continue;
    const replacement = { ...rederived.record, addedAt: target.addedAt ?? null };
    sessions = sessions.map((entry) => (entry.sessionId === overlappingId ? replacement : entry));
  }
  await writeReplicationSessions(idRoot, createSessionsDocument({ replicationId, sessions }));
  const summary = await buildReplicationSummary({ root: idRoot, manifest, sessions, now });
  await writeReplicationSummary(idRoot, summary);
  await writeReplicationManifest(idRoot, { ...manifest, status: summary.cleanSessionCount >= REQUIRED_CLEAN_REPLICATION_SESSIONS ? "CLEAN_SESSIONS_COMPLETE" : "OPEN", sessionCount: sessions.length });

  return {
    ok: true,
    action: "replication-add",
    replicationId,
    root: idRoot,
    sessionId: session,
    sessionStatus: record.status,
    sessionEligible: record.eligible === true,
    sessionReasons: record.reasons ?? [],
    protocolDigest: record.protocolDigest,
    protocolOk: record.protocolOk === true,
    metricsDigest: record.metricsDigest,
    recordDigest: record.recordDigest,
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

async function rederiveReplication({ replicationId, replicationRoot = null, baseRoot = null, now = () => Date.now() }) {
  const root = replicationRoot ?? DIRECTION_REPLICATION_ROOT_DIR;
  if (!isValidReplicationId(replicationId)) return { ok: false, problems: [`invalid replication id '${replicationId}'`] };
  const idRoot = replicationRootFor(root, replicationId);
  const bundle = await readReplicationBundle(idRoot);
  const problems = [];
  if (!bundle.manifest) return { ok: false, problems: [`no Phase 5I.1 replication at ${idRoot}`], root: idRoot, manifest: null };

  const before = await replicationMetadataSnapshot(idRoot);
  const storedSessions = bundle.sessions?.sessions ?? [];
  const derivedSessions = [];
  for (const stored of storedSessions) {
    const derived = await deriveReplicationSessionRecord({
      sessionId: stored.sessionId,
      baseRoot,
      expected: { ...bundle.manifest.expected, protocolDigest: REPLICATION_PROTOCOL_DIGEST },
      otherSessions: storedSessions,
      replicationId,
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

  const recomputedSummary = await buildReplicationSummary({ root: idRoot, manifest: bundle.manifest, sessions: derivedSessions, now });
  const storedAggregate = bundle.summary?.aggregateMetricsDigest ?? null;
  const recomputedAggregate = recomputedSummary.aggregateMetricsDigest;
  if (storedAggregate !== null && storedAggregate !== recomputedAggregate) {
    problems.push("the stored replication aggregation does not reproduce from the referenced session artifacts");
  }
  if (storedSessions.length > 0 && sessionsDigestOf(derivedSessions) !== sessionsDigestOf(storedSessions)) {
    problems.push("the stored session records do not reproduce from the referenced session artifacts");
  }
  const after = await replicationMetadataSnapshot(idRoot);
  if (digestOf(before) !== digestOf(after)) {
    problems.push("the offline replication pass rewrote the replication tree");
  }

  return {
    ok: problems.length === 0,
    root: idRoot,
    manifest: bundle.manifest,
    sessions: derivedSessions,
    storedSummary: bundle.summary,
    summary: recomputedSummary,
    storedAggregateDigest: storedAggregate,
    recomputedAggregateDigest: recomputedAggregate,
    metricsMatch: storedAggregate !== null && storedAggregate === recomputedAggregate,
    before,
    after,
    problems,
  };
}

/**
 * Offline replay of an entire replication: every session is re-derived from its
 * own immutable artifacts, the aggregation is recomputed, and the tree is proved
 * byte-unchanged. ZERO network, ZERO provider calls, no credentials required.
 */
export async function replicationReplay({ replicationId, replicationRoot = null, baseRoot = null, now = () => Date.now() }) {
  const result = await rederiveReplication({ replicationId, replicationRoot, baseRoot, now });
  if (!result.manifest) {
    return {
      ok: false,
      replicationId,
      root: result.root,
      problems: result.problems,
      readOnly: true,
      sessionsDigestMatches: false,
      manifestDigestMatches: false,
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
  }
  return {
    ...result,
    replicationId,
    evidenceClass: result.manifest.evidenceClass,
    developmentExperimentId: result.manifest.developmentExperimentId,
    developmentMetricsDigest: result.manifest.developmentMetricsDigest,
    replicationProtocolDigest: result.manifest.replicationProtocolDigest,
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
}

/** The same derivation, shaped for human reporting. READ ONLY, zero network. */
export async function replicationStats({ replicationId, replicationRoot = null, baseRoot = null, now = () => Date.now() }) {
  const result = await rederiveReplication({ replicationId, replicationRoot, baseRoot, now });
  if (!result.manifest) {
    return { ok: false, error: result.problems[0] ?? "replication not found", replicationId, root: result.root, readOnly: true };
  }
  return {
    ok: true,
    replicationId,
    root: result.root,
    manifest: result.manifest,
    sessions: result.sessions,
    summary: result.summary,
    storedSummary: result.storedSummary,
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
