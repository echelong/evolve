/**
 * Phase 5I.1 — SESSION ELIGIBILITY, INDEPENDENCE AND PER-SESSION METRICS.
 *
 * A replication session is CLEAN only when it is genuinely the frozen Phase
 * 5I.0b protocol executed once on fresh, unseen data. Every rule below is
 * evaluated from persisted artifacts and the offline replay report — never from
 * a heuristic, and never from the session's predictive performance.
 *
 * NOTHING IS SILENTLY DISCARDED. A session that fails a rule is recorded with
 * its explicit eligibility reasons; a session that overlaps the development
 * experiment (or another session) is CONTAMINATED and excluded from clean
 * aggregation, but preserved in the manifest so the exclusion itself is visible.
 *
 * PAPER ONLY / NO TRADING. No wallet, no signing, no swap, no order, no Arena
 * routing, no DeepSeek routing, no external-agent routing of any kind, and no
 * confidence threshold.
 */

import { digestOf } from "../../../lib/hash.mjs";
import { auditNoProfitabilityFields } from "../metrics.mjs";
import { REPLICATION_EVIDENCE_CLASS, DIRECTION_REPLICATION_FLAGS } from "../evidence.mjs";
import {
  DEVELOPMENT_BARRIER_COMPLETED_AT_MS,
  DEVELOPMENT_BARRIER_LATEST_OBSERVATION_AT_MS,
  CANONICAL_DEVELOPMENT_BARRIER,
} from "./development-barrier.mjs";
import {
  REPLICATION_COMPARISON_IDS,
  REPLICATION_SESSION_CADENCE_SECONDS,
  REPLICATION_SESSION_OBSERVATIONS,
} from "./protocol.mjs";

export const REPLICATION_ELIGIBILITY_VERSION = 1;

export const SESSION_STATUS = Object.freeze({
  CLEAN: "CLEAN",
  CONTAMINATED: "CONTAMINATED",
  INELIGIBLE: "INELIGIBLE",
});

/**
 * Experiments that may NEVER be added as replication evidence:
 *   - the canonical development experiment (§19, stays DEVELOPMENT evidence);
 *   - the two historical v1/v2 canaries (§20, never promoted).
 */
export const PROTECTED_NON_REPLICATION_EXPERIMENT_IDS = Object.freeze([
  CANONICAL_DEVELOPMENT_BARRIER.experimentId,
  "jdir-20260920T060810Z-3a9163",
  "jdir-20260920T062804Z-3a9163",
]);

const CANARY_V1_EXPERIMENT_ID = "jdir-20260920T060810Z-3a9163";
const CANARY_V2_EXPERIMENT_ID = "jdir-20260920T062804Z-3a9163";

/** Field names that would mean a confidence threshold was reintroduced. */
const FORBIDDEN_THRESHOLD_FIELDS = Object.freeze([
  "minConfidence",
  "minconfidence",
  "confidenceThreshold",
  "threshold",
]);

function isFiniteMs(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The observation window a session actually covers. */
export function sessionObservationWindow({ experiment = null, predictions = [], outcomes = [] } = {}) {
  const startedAtMs = isFiniteMs(experiment?.startedAt);
  const observedMs = [
    ...predictions.map((entry) => isFiniteMs(entry?.stateObservedAt) ?? isFiniteMs(entry?.scheduledAt)),
    ...outcomes.map((entry) => isFiniteMs(entry?.outcomeReceivedAt) ?? isFiniteMs(entry?.outcomeObservedAt)),
  ].filter((value) => value !== null);
  const earliestObservationAtMs = observedMs.length > 0 ? Math.min(...observedMs) : null;
  const latestObservationAtMs = observedMs.length > 0 ? Math.max(...observedMs) : null;
  return {
    startedAtMs,
    earliestObservationAtMs,
    latestObservationAtMs,
    windowMs:
      earliestObservationAtMs !== null && latestObservationAtMs !== null
        ? [earliestObservationAtMs, latestObservationAtMs]
        : null,
  };
}

/** Two closed intervals overlap (touching endpoints count as overlap). */
export function windowsOverlap(a, b) {
  if (!a || !b) return false;
  return a[0] <= b[1] && b[0] <= a[1];
}

/**
 * Session-level metrics, derived EXACTLY as Phase 5I.0b derives them. Only
 * numeric summaries are projected: the observation-level detail stays in the
 * referenced immutable `jdir-*` experiment.
 */
export function compactSessionMetrics(replay) {
  const metrics = replay?.recomputedMetrics ?? null;
  if (metrics === null) return null;
  const baselines = {};
  for (const [baselineId, block] of Object.entries(metrics.baselines ?? {})) {
    if (!REPLICATION_COMPARISON_IDS.includes(baselineId)) continue;
    baselines[baselineId] = {
      brier: block.brierScore ?? null,
      logLoss: block.logLoss ?? null,
      accuracy: block.accuracy ?? null,
      sampleCount: block.sampleCount ?? null,
      brierSampleCount: block.brierSampleCount ?? null,
      logLossSampleCount: block.logLossSampleCount ?? null,
      accuracySampleCount: block.accuracySampleCount ?? null,
    };
  }
  const deltas = {};
  for (const [baselineId, block] of Object.entries(metrics.brierDeltas ?? {})) {
    if (!REPLICATION_COMPARISON_IDS.includes(baselineId)) continue;
    deltas[baselineId] = {
      brier: block.jevMinusBaselineBrier ?? null,
      logLoss: block.jevMinusBaselineLogLoss ?? null,
      accuracy: block.jevMinusBaselineAccuracy ?? null,
    };
  }
  return {
    observationCount: metrics.observationCount ?? null,
    validPredictionCount: metrics.validPredictionCount ?? null,
    scoredCount: metrics.scoredCount ?? null,
    higherCount: metrics.higherCount ?? null,
    lowerCount: metrics.lowerCount ?? null,
    tieCount: metrics.tieCount ?? null,
    jev: {
      brier: metrics.jev?.brierScore ?? null,
      logLoss: metrics.jev?.logLoss ?? null,
      accuracy: metrics.jev?.accuracy ?? null,
      brierSampleCount: metrics.jev?.brierSampleCount ?? null,
      logLossSampleCount: metrics.jev?.logLossSampleCount ?? null,
      accuracySampleCount: metrics.jev?.accuracySampleCount ?? null,
      meanPHigher: metrics.allValidPredictionStats?.meanPHigher ?? null,
      medianPHigher: metrics.allValidPredictionStats?.medianPHigher ?? null,
    },
    baselines,
    deltas,
    counts: replay?.counts ?? null,
    lookahead: {
      ok: replay?.lookaheadAudit?.ok === true,
      recomputationPairs: replay?.lookaheadAudit?.recomputationPairs ?? null,
    },
    timing: {
      outcomeOffset: metrics.outcomeOffsetStats ?? null,
      achievedHorizon: metrics.achievedHorizonStats ?? null,
      jevLatency: metrics.latency?.jevOkOnly ?? null,
    },
    metricsDigest: replay?.recomputedMetricsDigest ?? null,
  };
}

/**
 * Evaluate ONE session's eligibility.
 *
 * @param {{
 *   sessionId: string,
 *   experiment?: object|null,
 *   summary?: object|null,
 *   predictions?: object[],
 *   outcomes?: object[],
 *   replay?: object|null,
 *   protocol?: { ok: boolean, digest: string|null }|null,
 *   expected?: object|null,
 *   otherSessions?: object[],
 * }} input
 * @returns {{
 *   sessionId: string,
 *   status: string,
 *   eligible: boolean,
 *   reasons: string[],
 *   contaminationReasons: string[],
 *   ineligibilityReasons: string[],
 *   checks: object,
 *   timing: object,
 * }}
 */
export function evaluateReplicationSession({
  sessionId,
  experiment = null,
  summary = null,
  predictions = [],
  outcomes = [],
  replay = null,
  protocol = null,
  expected = null,
  otherSessions = [],
} = {}) {
  const ineligibilityReasons = [];
  const contaminationReasons = [];
  const checks = {};
  const check = (name, condition, reason) => {
    checks[name] = condition === true;
    if (condition !== true && typeof reason === "string") ineligibilityReasons.push(reason);
    return condition === true;
  };
  const contaminate = (name, condition, reason) => {
    checks[name] = condition === true;
    if (condition !== true) contaminationReasons.push(reason);
    return condition === true;
  };

  const window = sessionObservationWindow({ experiment, predictions, outcomes });

  // ---- §19/§20 protected experiments --------------------------------------
  check(
    "notProtectedExperiment",
    !PROTECTED_NON_REPLICATION_EXPERIMENT_IDS.includes(sessionId),
    sessionId === CANONICAL_DEVELOPMENT_BARRIER.experimentId
      ? "the canonical development experiment is DEVELOPMENT evidence and can never be added as replication evidence"
      : sessionId === CANARY_V1_EXPERIMENT_ID || sessionId === CANARY_V2_EXPERIMENT_ID
        ? "a historical canary may never be promoted to replication evidence"
        : "this experiment id is protected",
  );

  // ---- §11 evidence class -------------------------------------------------
  check(
    "replicationEvidenceClass",
    experiment?.evidenceClass === REPLICATION_EVIDENCE_CLASS,
    `session declares evidence class ${JSON.stringify(experiment?.evidenceClass ?? null)}; a CLEAN replication session must be ` +
      `${REPLICATION_EVIDENCE_CLASS} (development evidence is never replication evidence)`,
  );
  check(
    "replicationFlags",
    DIRECTION_REPLICATION_FLAGS.developmentOnly === false &&
      experiment?.developmentOnly === false &&
      experiment?.replicationOnly === true &&
      experiment?.noProfitabilityInference === true &&
      experiment?.noTradingInference === true &&
      experiment?.noDeploymentInference === true &&
      experiment?.paperOnly === true &&
      experiment?.shadowOnly === true,
    "session does not carry the replication manifest flags (developmentOnly=false, replicationOnly=true, no-profitability/trading/deployment, paper+shadow)",
  );

  // ---- real observations, never fixtures/mock ------------------------------
  check(
    "realObservations",
    experiment?.offlineFixture !== true &&
      replay?.provider !== "mock-jev" &&
      experiment?.provider === "typesafe-jev" &&
      experiment?.providerImplementation !== "direction-fixture-jev-v1",
    "session was produced by an offline fixture/mock provider, not by genuine live observations",
  );
  check(
    "directTypeSafe",
    experiment?.gatewayUsed === false && replay?.gatewayUsed === false && experiment?.upstreamProvider === "typesafe-ai",
    "session was not produced on the direct TypeSafe route (gatewayUsed must be false)",
  );
  check(
    "pinnedModel",
    experiment?.model === "jev-1.13.0" && replay?.model === "jev-1.13.0",
    `session does not pin the frozen model jev-1.13.0 (got ${JSON.stringify(experiment?.model ?? null)})`,
  );

  // ---- §5 the frozen protocol (fail closed) -------------------------------
  check(
    "frozenProtocolDigest",
    protocol?.ok === true &&
      expected?.protocolDigest !== undefined &&
      protocol?.digest === expected?.protocolDigest,
    `session does not reproduce the frozen replication protocol digest (got ${JSON.stringify(protocol?.digest ?? null)}, ` +
      `expected ${JSON.stringify(expected?.protocolDigest ?? null)})`,
  );
  check(
    "horizonAndCadence",
    experiment?.horizonSeconds === 30 &&
      experiment?.samplingCadenceMs === REPLICATION_SESSION_CADENCE_SECONDS * 1_000 &&
      experiment?.maxObservations === REPLICATION_SESSION_OBSERVATIONS,
    `session is not the frozen protocol shape (horizon ${String(experiment?.horizonSeconds)}s, cadence ` +
      `${String(experiment?.samplingCadenceMs)}ms, session size ${String(experiment?.maxObservations)})`,
  );

  // ---- §11 correct policy versions / digests ------------------------------
  for (const [label, actual, wanted] of [
    ["question set id", experiment?.questionSetId, expected?.questionSetId],
    ["question set version", experiment?.questionSetVersion, expected?.questionSetVersion],
    ["question digest", experiment?.questionDigest, expected?.questionDigest],
    ["packet kind", experiment?.packetKind, expected?.packetKind],
    ["packet version", experiment?.packetVersion, expected?.packetVersion],
    ["feature definition version", experiment?.featureDefinitionVersion, expected?.featureDefinitionVersion],
    ["feature definition digest", experiment?.featureDefinitionDigest, expected?.featureDefinitionDigest],
    ["baseline definition version", experiment?.baselineDefinitionVersion, expected?.baselineDefinitionVersion],
    ["baseline definition digest", experiment?.baselineDefinitionDigest, expected?.baselineDefinitionDigest],
    ["metric definition version", experiment?.metricDefinitionVersion, expected?.metricDefinitionVersion],
    ["metric definition digest", experiment?.metricDefinitionDigest, expected?.metricDefinitionDigest],
    ["reference-price definition version", experiment?.referencePriceDefinitionVersion, expected?.referencePriceDefinitionVersion],
    ["reference-price definition digest", experiment?.referencePriceDefinitionDigest, expected?.referencePriceDefinitionDigest],
    ["outcome-resolution policy version", experiment?.outcomeResolutionPolicyVersion, expected?.outcomeResolutionPolicyVersion],
    ["outcome-resolution policy digest", experiment?.outcomeResolutionPolicyDigest, expected?.outcomeResolutionPolicyDigest],
    ["staleness policy digest", experiment?.stalenessPolicyDigest, expected?.stalenessPolicyDigest],
  ]) {
    check(
      `frozen.${label}`,
      wanted !== undefined && wanted !== null && digestOf(actual ?? null) === digestOf(wanted),
      `session drifted from the frozen ${label} (got ${JSON.stringify(actual ?? null)}, expected ${JSON.stringify(wanted ?? null)})`,
    );
  }

  // ---- §11/§15 NO confidence threshold may be reintroduced ----------------
  const thresholdViolations = [];
  for (const [label, subject] of [
    ["experiment", experiment],
    ["summary", summary],
    ["metrics", summary?.metrics ?? replay?.recomputedMetrics ?? null],
  ]) {
    if (!subject || typeof subject !== "object") continue;
    for (const key of FORBIDDEN_THRESHOLD_FIELDS) {
      if (Object.hasOwn(subject, key)) thresholdViolations.push(`${label}.${key}`);
    }
  }
  check(
    "noConfidenceThreshold",
    thresholdViolations.length === 0 &&
      summary?.noConfidenceThreshold === true &&
      summary?.everyValidProbabilityRetained === true &&
      (summary?.metrics?.confidenceThresholdApplied ?? null) === false,
    `session reintroduced a confidence threshold (${thresholdViolations.join(", ") || "declared threshold semantics are missing"})`,
  );

  // ---- §11 counts ---------------------------------------------------------
  const counts = replay?.counts ?? {};
  check(
    "sessionSize",
    counts.predictions === REPLICATION_SESSION_OBSERVATIONS && counts.outcomes === REPLICATION_SESSION_OBSERVATIONS,
    `session has ${String(counts.predictions)} prediction(s) and ${String(counts.outcomes)} outcome(s); the frozen protocol schedules ` +
      `${REPLICATION_SESSION_OBSERVATIONS} of each`,
  );
  check(
    "noFailedObservations",
    (counts.invalidPredictions ?? null) === 0 && (counts.failedJevObservations ?? null) === 0,
    "session contains invalid or failed Jev observations (a fallback substituted for a real prediction)",
  );
  check(
    "noLatePredictions",
    (summary?.metrics?.lateJevCount ?? null) === 0,
    "session contains late predictions",
  );
  check(
    "noWindowExclusions",
    (counts.outcomeWindowExclusions ?? null) === 0 && (summary?.metrics?.outcomeUnavailableCount ?? null) === 0,
    "session contains outcome-window exclusions",
  );
  check(
    "completeBinarySample",
    (counts.scorablePredictions ?? null) === REPLICATION_SESSION_OBSERVATIONS &&
      (summary?.metrics?.scoredCount ?? null) ===
        REPLICATION_SESSION_OBSERVATIONS - (summary?.metrics?.tieCount ?? 0),
    "session does not have a complete binary sample (every non-TIE observation must be scorable and scored)",
  );

  // ---- §11 replay integrity, lookahead, tamper ---------------------------
  check("replayIntegrity", replay?.ok === true, `session replay is not clean: ${(replay?.problems ?? []).join("; ")}`);
  check(
    "lookaheadClean",
    replay?.lookaheadAudit?.ok === true && (replay?.checks?.lookaheadClean ?? null) === true,
    "session lookahead audit is not clean",
  );
  check(
    "noTamper",
    (counts.tamperDetected ?? null) === 0 && (summary?.metrics?.tamperDetectedCount ?? null) === 0,
    "session reports tampered artifacts",
  );

  // ---- §11 finalized + no automated winner --------------------------------
  check(
    "finalized",
    summary?.finalized === true && experiment?.status === "COMPLETE",
    `session is not finalized (experiment status ${JSON.stringify(experiment?.status ?? null)}, summary.finalized ${String(summary?.finalized ?? null)})`,
  );
  check(
    "noAutomatedWinner",
    (summary?.winner ?? null) === null && summary?.noAutomatedWinner === true && (summary?.metrics?.winnerLabelEmitted ?? null) === false,
    "session emits an automated winner label",
  );
  const profitabilityAudit = summary ? auditNoProfitabilityFields(summary) : { ok: true, problems: [] };
  check(
    "noProfitabilityFields",
    profitabilityAudit.ok === true,
    `session summary contains profitability-shaped fields: ${(profitabilityAudit.problems ?? []).join("; ")}`,
  );

  // ---- §7 TEMPORAL INDEPENDENCE ------------------------------------------
  const sessionWindow = window.windowMs;
  const developmentWindow = [
    isFiniteMs(CANONICAL_DEVELOPMENT_BARRIER.session.earliestObservationAt) ?? DEVELOPMENT_BARRIER_LATEST_OBSERVATION_AT_MS,
    isFiniteMs(CANONICAL_DEVELOPMENT_BARRIER.session.latestObservationAt) ?? DEVELOPMENT_BARRIER_LATEST_OBSERVATION_AT_MS,
  ];
  const startsAfterDevelopment =
    window.startedAtMs !== null && window.startedAtMs >= DEVELOPMENT_BARRIER_COMPLETED_AT_MS;
  const developmentWindowsDisjoint = !windowsOverlap(sessionWindow, developmentWindow);
  const afterLatestDevelopmentObservation =
    window.earliestObservationAtMs !== null && window.earliestObservationAtMs > DEVELOPMENT_BARRIER_LATEST_OBSERVATION_AT_MS;

  contaminate(
    "startsAfterDevelopment",
    startsAfterDevelopment,
    `session started at ${String(experiment?.startedAt ?? null)}, before the canonical development experiment completed at ` +
      `${CANONICAL_DEVELOPMENT_BARRIER.session.completedAt}`,
  );
  contaminate(
    "afterDevelopmentObservation",
    afterLatestDevelopmentObservation,
    `session's earliest observation ${String(new Date(window.earliestObservationAtMs ?? 0).toISOString())} is not after the ` +
      `development experiment's latest observation ${CANONICAL_DEVELOPMENT_BARRIER.session.latestObservationAt}`,
  );
  contaminate(
    "developmentWindowsDisjoint",
    developmentWindowsDisjoint,
    "session observation window overlaps the canonical development observation window",
  );

  const overlapping = (otherSessions ?? [])
    .filter((entry) => entry && entry.sessionId !== sessionId)
    .filter((entry) => windowsOverlap(sessionWindow, entry.windowMs ?? null))
    .map((entry) => entry.sessionId);
  contaminate(
    "independentFromOtherSessions",
    overlapping.length === 0,
    `session observation window overlaps another session (${overlapping.join(", ")}), which invalidates independence under the frozen rule`,
  );

  const temporalOverlap = contaminationReasons.length > 0;
  const status =
    temporalOverlap === true
      ? SESSION_STATUS.CONTAMINATED
      : ineligibilityReasons.length > 0
        ? SESSION_STATUS.INELIGIBLE
        : SESSION_STATUS.CLEAN;

  return {
    eligibilityVersion: REPLICATION_ELIGIBILITY_VERSION,
    sessionId,
    status,
    eligible: status === SESSION_STATUS.CLEAN,
    reasons: [...contaminationReasons, ...ineligibilityReasons],
    contaminationReasons,
    ineligibilityReasons,
    checks,
    timing: {
      sessionStartedAt: experiment?.startedAt ?? null,
      sessionCompletedAt: summary?.finalizedAt ?? null,
      earliestObservationAt:
        window.earliestObservationAtMs === null ? null : new Date(window.earliestObservationAtMs).toISOString(),
      latestObservationAt:
        window.latestObservationAtMs === null ? null : new Date(window.latestObservationAtMs).toISOString(),
      windowMs: sessionWindow,
      developmentExperimentId: CANONICAL_DEVELOPMENT_BARRIER.experimentId,
      developmentLatestObservationAt: CANONICAL_DEVELOPMENT_BARRIER.session.latestObservationAt,
      developmentCompletedAt: CANONICAL_DEVELOPMENT_BARRIER.session.completedAt,
      startsAfterDevelopment,
      developmentWindowsDisjoint,
      afterLatestDevelopmentObservation,
      overlappingSessionIds: overlapping,
      temporalOverlap,
    },
  };
}

/** Refuse a session id that must never enter a replication manifest. */
export function protectedExperimentReason(sessionId) {
  if (sessionId === CANONICAL_DEVELOPMENT_BARRIER.experimentId) {
    return "the canonical Phase 5I.0b development experiment is DEVELOPMENT evidence and is never promoted to replication evidence";
  }
  if (sessionId === CANARY_V1_EXPERIMENT_ID || sessionId === CANARY_V2_EXPERIMENT_ID) {
    return "a historical Phase 5I canary is immutable infrastructure evidence and is never promoted to replication evidence";
  }
  return null;
}
