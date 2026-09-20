/**
 * EVOLVE Phase 5I.1a — TEMPORAL SESSION ELIGIBILITY.
 *
 * A temporal-extension session is CLEAN only when it is genuinely the frozen
 * Phase 5I.0b protocol executed once on fresh, unseen data AND it satisfies the
 * STRICTER Phase 5I.1a temporal-independence rules:
 *
 *   - a different UTC calendar date from every other temporal session;
 *   - at least a 6-hour start-to-completion gap from the previous eligible
 *     temporal session;
 *   - no overlap with the Phase 5I.0b development observation window;
 *   - no overlap with any canonical Phase 5I.1 observation;
 *   - no overlap with another Phase 5I.1a session.
 *
 * The session-timing selection rules ("not chosen because Jev performed well",
 * "not chosen because SOL looked bullish/bearish/volatile") cannot be proven from
 * an artifact alone; they are FROZEN as declarations in `protocol.mjs` and audited
 * here and on every persisted record.
 *
 * NOTHING IS SILENTLY DISCARDED. A session that fails a rule is recorded with its
 * explicit eligibility reasons, and preserved in the manifest as CONTAMINATED or
 * INELIGIBLE.
 *
 * This module re-uses the pure window helpers from the canonical eligibility
 * module and the shared `compactSessionMetrics` projection, but it NEVER calls the
 * canonical `evaluateReplicationSession`: a temporal session carries a DIFFERENT
 * evidence class, and the canonical replication derivation must stay byte-exact.
 *
 * PAPER ONLY / NO TRADING. No wallet, no signing, no swap, no order, no Arena
 * routing, no DeepSeek routing, no external-agent routing of any kind, and no
 * confidence threshold.
 */

import { digestOf } from "../../../lib/hash.mjs";
import { auditNoProfitabilityFields } from "../metrics.mjs";
import { DIRECTION_TEMPORAL_REPLICATION_FLAGS, TEMPORAL_REPLICATION_EVIDENCE_CLASS } from "../evidence.mjs";
import { CANONICAL_DEVELOPMENT_BARRIER } from "../replication/development-barrier.mjs";
import {
  PROTECTED_NON_REPLICATION_EXPERIMENT_IDS,
  SESSION_STATUS,
  sessionObservationWindow,
  windowsOverlap,
} from "../replication/eligibility.mjs";
import {
  CANONICAL_REPLICATION_BARRIER,
  CANONICAL_REPLICATION_COMPLETED_AT_MS,
  CANONICAL_REPLICATION_WINDOWS,
  DEVELOPMENT_WINDOW_MS,
  TEMPORAL_MINIMUM_GAP_MS,
  TEMPORAL_PROTOCOL_DIGEST,
  TEMPORAL_SELECTION_RULES,
  TEMPORAL_SESSION_CADENCE_SECONDS,
  TEMPORAL_SESSION_OBSERVATIONS,
  auditTemporalTimingSelection,
  gapFromPreviousEligibleSessionMs,
  utcDateOf,
} from "./protocol.mjs";

export const TEMPORAL_ELIGIBILITY_VERSION = 1;
export { SESSION_STATUS };

/**
 * Experiments that may NEVER be added as temporal-extension evidence: the
 * canonical development experiment, the two historical canaries, and every one of
 * the three canonical Phase 5I.1 session ids (which are ALREADY canonical
 * replication evidence and can never be re-labelled).
 */
export const TEMPORAL_PROTECTED_EXPERIMENT_IDS = Object.freeze([
  ...PROTECTED_NON_REPLICATION_EXPERIMENT_IDS,
  ...CANONICAL_REPLICATION_BARRIER.cleanSessionIds,
]);

const CANONICAL_REPLICATION_SESSION_IDS = new Set(CANONICAL_REPLICATION_BARRIER.cleanSessionIds);

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

/** The observation window a session actually covers (shared with the canonical rule). */
export function temporalSessionWindow(input) {
  return sessionObservationWindow(input);
}

/**
 * Evaluate ONE temporal-extension session's eligibility.
 *
 * @param {{
 *   sessionId: string,
 *   experiment?: object|null,
 *   summary?: object|null,
 *   predictions?: object[],
 *   outcomes?: object[],
 *   replay?: object|null,
 *   protocol?: { ok: boolean, digest: string|null, expectedDigest?: string|null, differences?: object[] }|null,
 *   expected?: object|null,
 *   otherSessions?: object[],
 * }} input
 */
export function evaluateTemporalSession({
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

  // ---- §1 protected experiments -------------------------------------------
  check(
    "notProtectedExperiment",
    !TEMPORAL_PROTECTED_EXPERIMENT_IDS.includes(sessionId),
    CANONICAL_REPLICATION_SESSION_IDS.has(sessionId)
      ? "the canonical Phase 5I.1 session is canonical replication evidence and can never be re-labelled as temporal-extension evidence"
      : sessionId === CANONICAL_DEVELOPMENT_BARRIER.experimentId
        ? "the canonical development experiment is DEVELOPMENT evidence and can never be added as temporal-extension evidence"
        : "this experiment id is protected",
  );

  // ---- evidence class (temporal, never development/replication) -----------
  check(
    "temporalEvidenceClass",
    experiment?.evidenceClass === TEMPORAL_REPLICATION_EVIDENCE_CLASS,
    `session declares evidence class ${JSON.stringify(experiment?.evidenceClass ?? null)}; a CLEAN temporal-extension session must ` +
      `be ${TEMPORAL_REPLICATION_EVIDENCE_CLASS} (development and canonical replication evidence are never temporal evidence)`,
  );
  check(
    "temporalFlags",
    DIRECTION_TEMPORAL_REPLICATION_FLAGS.developmentOnly === false &&
      experiment?.developmentOnly === false &&
      experiment?.replicationOnly === true &&
      experiment?.temporalExtensionOnly === true &&
      experiment?.noProfitabilityInference === true &&
      experiment?.noTradingInference === true &&
      experiment?.noDeploymentInference === true &&
      experiment?.paperOnly === true &&
      experiment?.shadowOnly === true,
    "session does not carry the temporal-extension flags (developmentOnly=false, replicationOnly=true, temporalExtensionOnly=true, no-profitability/trading/deployment, paper+shadow)",
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

  // ---- §10 the frozen protocol (SAME digest as Phase 5I.1, fail closed) ----
  check(
    "frozenProtocolDigest",
    protocol?.ok === true && protocol?.digest === TEMPORAL_PROTOCOL_DIGEST,
    `session does not reproduce the frozen temporal-extension protocol digest (got ${JSON.stringify(protocol?.digest ?? null)}, ` +
      `expected ${JSON.stringify(TEMPORAL_PROTOCOL_DIGEST)})`,
  );
  check(
    "horizonAndCadence",
    experiment?.horizonSeconds === 30 &&
      experiment?.samplingCadenceMs === TEMPORAL_SESSION_CADENCE_SECONDS * 1_000 &&
      experiment?.maxObservations === TEMPORAL_SESSION_OBSERVATIONS,
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

  // ---- §11 NO confidence threshold may be reintroduced --------------------
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
    counts.predictions === TEMPORAL_SESSION_OBSERVATIONS && counts.outcomes === TEMPORAL_SESSION_OBSERVATIONS,
    `session has ${String(counts.predictions)} prediction(s) and ${String(counts.outcomes)} outcome(s); the frozen protocol schedules ` +
      `${TEMPORAL_SESSION_OBSERVATIONS} of each`,
  );
  check(
    "noFailedObservations",
    (counts.invalidPredictions ?? null) === 0 && (counts.failedJevObservations ?? null) === 0,
    "session contains invalid or failed Jev observations (a fallback substituted for a real prediction)",
  );
  check("noLatePredictions", (summary?.metrics?.lateJevCount ?? null) === 0, "session contains late predictions");
  check(
    "noWindowExclusions",
    (counts.outcomeWindowExclusions ?? null) === 0 && (summary?.metrics?.outcomeUnavailableCount ?? null) === 0,
    "session contains outcome-window exclusions",
  );
  check(
    "completeBinarySample",
    (counts.scorablePredictions ?? null) === TEMPORAL_SESSION_OBSERVATIONS &&
      (summary?.metrics?.scoredCount ?? null) ===
        TEMPORAL_SESSION_OBSERVATIONS - (summary?.metrics?.tieCount ?? 0),
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

  // ---- §11 finalized + no automated winner -------------------------------
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

  // ---- §5 TEMPORAL INDEPENDENCE ------------------------------------------
  const sessionWindow = window.windowMs;
  const startedAtMs = window.startedAtMs;
  // A session's completion instant is the LATER of "the process said it finished"
  // and "the last observation it actually took". `finalizedAt` is a wall-clock
  // stamp, so it may be EARLIER than the injected session clock in an offline
  // replay; taking the later of the two keeps the value a deterministic function
  // of the session's own artifacts while still reflecting the true completion of
  // a real session.
  const completionCandidates = [isFiniteMs(summary?.finalizedAt), window.latestObservationAtMs].filter((value) =>
    Number.isFinite(value),
  );
  const completedAtMs = completionCandidates.length === 0 ? null : Math.max(...completionCandidates);
  const sessionCompletedAt = completedAtMs === null ? null : new Date(completedAtMs).toISOString();
  const utcDate = utcDateOf(window.earliestObservationAtMs ?? startedAtMs);
  const previousEligible = previousEligibleSession({ otherSessions, sessionId, startedAtMs });
  const gap = gapFromPreviousEligibleSessionMs({
    startedAtMs,
    previousCompletedAtMs: previousEligible?.sessionCompletedAtMs ?? null,
  });
  const minimumGapSatisfied = gap === null ? true : gap >= TEMPORAL_MINIMUM_GAP_MS;

  const overlappingSessionIds = (otherSessions ?? [])
    .filter((entry) => entry && entry.sessionId !== sessionId)
    .filter((entry) => windowsOverlap(sessionWindow, entry.windowMs ?? null))
    .map((entry) => entry.sessionId);
  const sameUtcDateSessionIds = (otherSessions ?? [])
    .filter((entry) => entry && entry.sessionId !== sessionId)
    .filter((entry) => utcDate !== null && utcDateOf(entry.timing?.utcDate ?? entry.utcDate) === utcDate)
    .map((entry) => entry.sessionId);

  const overlappingCanonicalSessionIds = (CANONICAL_REPLICATION_WINDOWS ?? [])
    .filter((entry) => windowsOverlap(sessionWindow, entry.windowMs))
    .map((entry) => entry.sessionId);

  const developmentOverlap = windowsOverlap(sessionWindow, DEVELOPMENT_WINDOW_MS);
  const afterCanonicalCompletion = startedAtMs !== null && startedAtMs >= CANONICAL_REPLICATION_COMPLETED_AT_MS;

  contaminate(
    "afterCanonicalReplicationCompletion",
    afterCanonicalCompletion,
    `session started at ${String(experiment?.startedAt ?? null)}, before the canonical Phase 5I.1 wave completed at ` +
      `${CANONICAL_REPLICATION_BARRIER.sessionWindows[CANONICAL_REPLICATION_BARRIER.cleanSessionIds[2]].sessionCompletedAt}`,
  );
  contaminate(
    "noDevelopmentOverlap",
    !developmentOverlap,
    `session observation window overlaps the Phase 5I.0b development observation window ` +
      `(${CANONICAL_REPLICATION_BARRIER.developmentWindow.earliestObservationAt} .. ` +
      `${CANONICAL_REPLICATION_BARRIER.developmentWindow.latestObservationAt})`,
  );
  contaminate(
    "noCanonicalReplicationOverlap",
    overlappingCanonicalSessionIds.length === 0,
    `session observation window overlaps the canonical Phase 5I.1 wave (${overlappingCanonicalSessionIds.join(", ")}), ` +
      "which invalidates temporal independence",
  );
  contaminate(
    "noTemporalExtensionOverlap",
    overlappingSessionIds.length === 0,
    `session observation window overlaps another Phase 5I.1a session (${overlappingSessionIds.join(", ")}), ` +
      "which invalidates temporal independence",
  );
  contaminate(
    "differentUtcCalendarDate",
    sameUtcDateSessionIds.length === 0,
    `session shares its UTC calendar date ${String(utcDate)} with another Phase 5I.1a session ` +
      `(${sameUtcDateSessionIds.join(", ")}); each temporal-extension session must occur on a different UTC date`,
  );
  contaminate(
    "minimumGapFromPreviousEligibleSession",
    minimumGapSatisfied,
    `session started ${String(gap)} ms after the previous eligible session completed; the frozen temporal-extension rule requires ` +
      `at least ${TEMPORAL_MINIMUM_GAP_MS} ms (6 hours)`,
  );

  // ---- §5 the frozen selection declarations -------------------------------
  const selectionAudit = auditTemporalTimingSelection({
    selectionBasis: TEMPORAL_SELECTION_RULES.selectionBasis,
    timingNotSelectedFromObservedPerformance: true,
    timingNotSelectedFromMarketView: true,
  });
  contaminate(
    "sessionTimingNotSelectedFromPerformanceOrMarketView",
    selectionAudit.ok === true,
    `the temporal-extension selection declaration is not honoured: ${selectionAudit.problems.join("; ")}`,
  );

  const temporalOverlap = contaminationReasons.length > 0;
  const status =
    temporalOverlap === true
      ? SESSION_STATUS.CONTAMINATED
      : ineligibilityReasons.length > 0
        ? SESSION_STATUS.INELIGIBLE
        : SESSION_STATUS.CLEAN;

  const conflictingSessionIds = [...new Set([...overlappingSessionIds, ...sameUtcDateSessionIds])];
  const temporalEligibilityReasons = [...contaminationReasons, ...ineligibilityReasons];

  return {
    eligibilityVersion: TEMPORAL_ELIGIBILITY_VERSION,
    sessionId,
    status,
    eligible: status === SESSION_STATUS.CLEAN,
    reasons: temporalEligibilityReasons,
    temporalEligibilityReasons,
    contaminationReasons,
    ineligibilityReasons,
    checks,
    timing: {
      sessionStartedAt: experiment?.startedAt ?? null,
      sessionCompletedAt,
      earliestObservationAt:
        window.earliestObservationAtMs === null ? null : new Date(window.earliestObservationAtMs).toISOString(),
      latestObservationAt:
        window.latestObservationAtMs === null ? null : new Date(window.latestObservationAtMs).toISOString(),
      utcDate,
      gapFromPreviousEligibleSessionMs: gap,
      previousEligibleSessionId: previousEligible?.sessionId ?? null,
      previousEligibleSessionCompletedAt: previousEligible?.sessionCompletedAt ?? null,
      overlapWithDevelopment: developmentOverlap,
      overlapWithCanonicalReplication: overlappingCanonicalSessionIds.length > 0,
      overlapWithTemporalExtensionSession: overlappingSessionIds.length > 0,
      overlappingSessionIds,
      overlappingCanonicalSessionIds,
      sameUtcDateSessionIds,
      conflictingSessionIds,
      afterCanonicalReplicationCompletion: afterCanonicalCompletion,
      differentUtcCalendarDate: sameUtcDateSessionIds.length === 0,
      minimumGapSatisfied,
      windowMs: sessionWindow,
      startedAtMs,
      latestObservationAtMs: window.latestObservationAtMs,
      completedAtMs,
      sessionCompletedAtMs: completedAtMs,
      temporalOverlap,
      canonicalReplicationId: CANONICAL_REPLICATION_BARRIER.replicationId,
    },
    selectionBasis: TEMPORAL_SELECTION_RULES.selectionBasis,
    timingNotSelectedFromObservedPerformance: true,
    timingNotSelectedFromMarketView: true,
  };
}

/** The most recent CLEAN session that started before `startedAtMs`, or `null`. */
function previousEligibleSession({ otherSessions = [], sessionId, startedAtMs }) {
  if (!Number.isFinite(startedAtMs)) return null;
  let best = null;
  for (const entry of otherSessions ?? []) {
    if (!entry || entry.sessionId === sessionId) continue;
    if (entry.status !== SESSION_STATUS.CLEAN) continue;
    const completedAtMs = isFiniteMs(entry.timing?.sessionCompletedAt) ?? entry.timing?.sessionCompletedAtMs ?? null;
    const entryStartedAtMs = entry.timing?.startedAtMs ?? isFiniteMs(entry.timing?.sessionStartedAt);
    if (!Number.isFinite(completedAtMs) || !Number.isFinite(entryStartedAtMs)) continue;
    if (entryStartedAtMs > startedAtMs) continue;
    if (best === null || completedAtMs > best.sessionCompletedAtMs) {
      best = { sessionId: entry.sessionId, sessionCompletedAtMs: completedAtMs, sessionCompletedAt: entry.timing?.sessionCompletedAt ?? null };
    }
  }
  return best;
}

/** Refuse a session id that must never enter a temporal-extension manifest. */
export function protectedTemporalExperimentReason(sessionId) {
  if (CANONICAL_REPLICATION_SESSION_IDS.has(sessionId)) {
    return "a canonical Phase 5I.1 replication session is already canonical replication evidence and can never be re-labelled as temporal-extension evidence";
  }
  if (sessionId === CANONICAL_DEVELOPMENT_BARRIER.experimentId) {
    return "the canonical Phase 5I.0b development experiment is DEVELOPMENT evidence and is never promoted to temporal-extension evidence";
  }
  if (PROTECTED_NON_REPLICATION_EXPERIMENT_IDS.includes(sessionId)) {
    return "a historical Phase 5I canary is immutable infrastructure evidence and is never promoted to temporal-extension evidence";
  }
  return null;
}

