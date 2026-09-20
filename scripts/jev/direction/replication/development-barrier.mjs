/**
 * Phase 5I.1 — THE CANONICAL PHASE 5I.0b DEVELOPMENT BARRIER (source-pinned).
 *
 * The completed canonical development experiment is FROZEN historical identity.
 * Its id, digest, counts, metrics, timing and interpretation are pinned HERE, in
 * source control, BEFORE the Phase 5I.1 replication framework can read anything.
 * Nothing in Phase 5I.1 may rewrite the experiment; verification is READ ONLY
 * and, when the local experiment directory is absent (a clean CI checkout), the
 * filesystem-specific checks skip cleanly instead of failing.
 *
 * §2 THE DEVELOPMENT INTERPRETATION IS FROZEN. It is a written verdict, not an
 * automated one, and it is never replaced by a winner/loser label:
 *
 *   Phase 5I.0b showed no clear directional advantage for Jev over the neutral
 *   baseline. This is DEVELOPMENT evidence only. No persistent edge has been
 *   established. No profitability inference is permitted.
 *
 * The predictive protocol was NOT modified because of these results (§15). Any
 * change to question wording, feature formulas, horizon, outcome tolerance,
 * baseline coefficients, staleness cutoffs, calibration bins, metric formulas,
 * the confidence threshold or the provider/model would require a NEW DEVELOPMENT
 * phase — never a Phase 5I.1 replication edit.
 *
 * PAPER ONLY / DEVELOPMENT EVIDENCE ONLY. No wallet, no signing, no swap, no
 * order, no Arena routing, no DeepSeek routing, no external-agent routing of any
 * kind, no trading, and no confidence threshold.
 */

import { digestOf } from "../../../lib/hash.mjs";
import {
  BASELINE_DEFINITION_DIGEST,
  BASELINE_DEFINITION_VERSION,
} from "../baselines.mjs";
import {
  DIRECTION_EVIDENCE_CLASS,
  HORIZON_SECONDS,
  OUTCOME_RESOLUTION_POLICY_VERSION_V2,
  REFERENCE_PRICE_DEFINITION_DIGEST,
  REFERENCE_PRICE_DEFINITION_VERSION,
  REQUIRED_GATEWAY_USED,
  REQUIRED_MODEL,
  REQUIRED_PROVIDER,
  REQUIRED_UPSTREAM_PROVIDER,
  STALENESS_POLICY_DIGEST,
  TARGET_AT_BASIS,
  outcomeResolutionPolicyDigestFor,
} from "../definition.mjs";
import {
  DIRECTION_FEATURE_DEFINITION_DIGEST,
  DIRECTION_FEATURE_DEFINITION_VERSION,
} from "../features.mjs";
import {
  DIRECTION_METRIC_DEFINITION_DIGEST,
  DIRECTION_METRICS_VERSION,
  metricsDigestOf,
} from "../metrics.mjs";
import { DIRECTION_PACKET_KIND, DIRECTION_PACKET_VERSION } from "../packet.mjs";
import {
  DIRECTION_QUESTION_SET_ID,
  DIRECTION_QUESTION_SET_VERSION,
  directionQuestionDigest,
} from "../questions.mjs";

/** Tolerance for a PUBLISHED (4-decimal) metric value against the stored one. */
export const DEVELOPMENT_BARRIER_METRIC_TOLERANCE = 1e-4;
/** Tolerance for a PUBLISHED whole-millisecond timing statistic. */
export const DEVELOPMENT_BARRIER_TIMING_TOLERANCE_MS = 1;

/**
 * THE canonical development barrier. Every field is the published Phase 5I.0b
 * result, quoted verbatim from the completed experiment:
 *
 *   experimentId  jdir-20260920T063311Z-3a9163
 *   metricsDigest 984cc26dd9f247dbd625dc8c7bfb07d82600ed9a353fe7ef2bba423cc79f29ba
 */
export const CANONICAL_DEVELOPMENT_BARRIER = Object.freeze({
  experimentId: "jdir-20260920T063311Z-3a9163",
  metricsDigest: "984cc26dd9f247dbd625dc8c7bfb07d82600ed9a353fe7ef2bba423cc79f29ba",
  evidenceClass: DIRECTION_EVIDENCE_CLASS,
  phase: "5I.0b",
  schemaVersion: 1,

  // ---- frozen counts -------------------------------------------------------
  observations: 120,
  valid: 120,
  scored: 120,
  higher: 62,
  lower: 58,
  tie: 0,
  outcomeWindowExclusions: 0,
  invalidPredictions: 0,

  // ---- canonical Jev metrics (published, 4 decimals) -----------------------
  metrics: Object.freeze({
    brier: 0.2546,
    logLoss: 0.7024,
    accuracy: 0.5,
    meanPHigher: 0.4589,
    medianPHigher: 0.465,
  }),

  // ---- canonical relative results (published, 4 decimals) ------------------
  // SIGN CONVENTION (unchanged, and documented here so it can never drift):
  //   negative Brier delta    = Jev Brier LOWER than the baseline (better)
  //   negative log-loss delta = Jev log loss LOWER than the baseline (better)
  //   accuracy delta is a plain difference (Jev minus baseline); higher is better
  relative: Object.freeze({
    "neutral-v1": Object.freeze({ brierDelta: 0.0046, logLossDelta: 0.0093, accuracyDelta: -0.0167 }),
    "momentum-v1": Object.freeze({ brierDelta: -0.0145, logLossDelta: -0.0314, accuracyDelta: 0.0294 }),
    "mean-reversion-v1": Object.freeze({ brierDelta: -0.0001, logLossDelta: -0.0011, accuracyDelta: -0.0294 }),
    "volume-flow-imbalance-v1": Object.freeze({ brierDelta: 0.0058, logLossDelta: 0.0118, accuracyDelta: 0.0083 }),
    "momentum-liquidity-v1": Object.freeze({ brierDelta: -0.0021, logLossDelta: -0.0042, accuracyDelta: 0.0294 }),
  }),

  // ---- infrastructure ------------------------------------------------------
  infrastructure: Object.freeze({
    jevOk: 120,
    failed: 0,
    late: 0,
    retries: 0,
    tamper: 0,
    outcomeWindowExclusions: 0,
    lookaheadRecomputationPairs: 7140,
    fallbackObservations: 0,
  }),

  // ---- timing diagnostics (published whole milliseconds) -------------------
  outcomeTiming: Object.freeze({ meanMs: 5977, medianMs: 6002, p95Ms: 6003, maxMs: 6005 }),
  achievedHorizon: Object.freeze({ meanMs: 36118, medianMs: 36114, p95Ms: 36167, maxMs: 36204 }),
  jevLatency: Object.freeze({ meanMs: 698, medianMs: 695, p95Ms: 762, maxMs: 834 }),

  // ---- session window (freshness baseline for §7) ---------------------------
  session: Object.freeze({
    startedAt: "2026-09-20T06:33:11.480Z",
    earliestObservationAt: "2026-09-20T06:33:14.486Z",
    latestObservationAt: "2026-09-20T08:03:19.759Z",
    completedAt: "2026-09-20T08:03:20.869Z",
  }),

  // ---- the frozen protocol pins the experiment carried ---------------------
  pins: Object.freeze({
    provider: REQUIRED_PROVIDER,
    upstreamProvider: REQUIRED_UPSTREAM_PROVIDER,
    model: REQUIRED_MODEL,
    gatewayUsed: REQUIRED_GATEWAY_USED,
    mode: "shadow",
    horizonSeconds: HORIZON_SECONDS,
    targetAtBasis: TARGET_AT_BASIS,
    samplingCadenceMs: 30_000,
    maxObservations: 120,
    questionSetId: DIRECTION_QUESTION_SET_ID,
    questionSetVersion: DIRECTION_QUESTION_SET_VERSION,
    questionDigest: directionQuestionDigest(),
    packetKind: DIRECTION_PACKET_KIND,
    packetVersion: DIRECTION_PACKET_VERSION,
    featureDefinitionVersion: DIRECTION_FEATURE_DEFINITION_VERSION,
    featureDefinitionDigest: DIRECTION_FEATURE_DEFINITION_DIGEST,
    baselineDefinitionVersion: BASELINE_DEFINITION_VERSION,
    baselineDefinitionDigest: BASELINE_DEFINITION_DIGEST,
    metricDefinitionVersion: DIRECTION_METRICS_VERSION,
    metricDefinitionDigest: DIRECTION_METRIC_DEFINITION_DIGEST,
    referencePriceDefinitionVersion: REFERENCE_PRICE_DEFINITION_VERSION,
    referencePriceDefinitionDigest: REFERENCE_PRICE_DEFINITION_DIGEST,
    outcomeResolutionPolicyVersion: OUTCOME_RESOLUTION_POLICY_VERSION_V2,
    outcomeResolutionPolicyDigest: outcomeResolutionPolicyDigestFor(OUTCOME_RESOLUTION_POLICY_VERSION_V2),
    outcomeResolutionMaximumOffsetMs: 10_000,
    stalenessPolicyDigest: STALENESS_POLICY_DIGEST,
  }),

  /** §2 — the frozen interpretation. Never re-derived, never automated. */
  interpretation: Object.freeze({
    verdict:
      "Phase 5I.0b showed no clear directional advantage for Jev over the neutral baseline.",
    scope: "This is DEVELOPMENT evidence only.",
    edge: "No persistent edge has been established.",
    inference: "No profitability inference is permitted.",
    automatedWinner: null,
    noAutomatedWinner: true,
    protocolUnchangedByResults: true,
    winnerFieldAbsent: true,
  }),
});

/** Deterministic digest of the whole barrier (provenance for the pin itself). */
export const CANONICAL_DEVELOPMENT_BARRIER_DIGEST = digestOf(CANONICAL_DEVELOPMENT_BARRIER);

/** The barrier's freshness anchor: no replication session may start before this. */
export const DEVELOPMENT_BARRIER_COMPLETED_AT_MS = Date.parse(CANONICAL_DEVELOPMENT_BARRIER.session.completedAt);
export const DEVELOPMENT_BARRIER_LATEST_OBSERVATION_AT_MS = Date.parse(
  CANONICAL_DEVELOPMENT_BARRIER.session.latestObservationAt,
);

function close(actual, expected, tolerance) {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
}

/** Compare two artifact byte-metadata snapshots field by field. */
export function barrierByteSnapshotsMatch(before, after) {
  return digestOf(before ?? null) === digestOf(after ?? null);
}

/**
 * Verify the canonical development experiment against the pinned barrier.
 *
 * READ ONLY. Every check is a comparison; nothing is written, nothing is
 * repaired, nothing is recomputed into the artifact. A missing local experiment
 * is reported as `present: false` with zero problems, so a clean CI checkout
 * skips the filesystem-specific checks cleanly instead of failing.
 *
 * @param {{
 *   experiment?: object|null,
 *   summary?: object|null,
 *   replay?: object|null,
 * }} bundle
 * @returns {{ present: boolean, ok: boolean, checks: object, problems: string[] }}
 */
export function verifyCanonicalDevelopmentBarrier({ experiment = null, summary = null, replay = null } = {}) {
  const barrier = CANONICAL_DEVELOPMENT_BARRIER;
  const problems = [];
  const checks = {};
  const check = (name, condition, message) => {
    checks[name] = condition === true;
    if (condition !== true) problems.push(message);
    return condition;
  };

  if (!experiment) {
    return { present: false, ok: true, checks: { experimentPresent: false }, problems: [] };
  }

  // ---- identity -----------------------------------------------------------
  check(
    "experimentId",
    experiment.experimentId === barrier.experimentId,
    `canonical development experiment id is ${String(experiment.experimentId)}; pinned ${barrier.experimentId}`,
  );
  check(
    "evidenceClass",
    experiment.evidenceClass === barrier.evidenceClass,
    `canonical development evidence class is ${String(experiment.evidenceClass)}; pinned ${barrier.evidenceClass}`,
  );
  check(
    "metricsDigest",
    summary?.metricsDigest === barrier.metricsDigest,
    `canonical metrics digest is ${String(summary?.metricsDigest)}; pinned ${barrier.metricsDigest}`,
  );

  // ---- counts -------------------------------------------------------------
  const counters = experiment.counters ?? {};
  check(
    "observationsScheduled",
    counters.observationsScheduled === barrier.observations,
    `canonical scheduled observations ${String(counters.observationsScheduled)} != ${barrier.observations}`,
  );
  check(
    "predictionsFrozen",
    counters.predictionsFrozen === barrier.valid,
    `canonical frozen predictions ${String(counters.predictionsFrozen)} != ${barrier.valid}`,
  );
  check(
    "scoredCount",
    replay?.counts?.scoredCount === barrier.scored,
    `canonical scored count ${String(replay?.counts?.scoredCount)} != ${barrier.scored}`,
  );
  check(
    "higherCount",
    replay?.recomputedMetrics?.higherCount === barrier.higher,
    `canonical HIGHER count ${String(replay?.recomputedMetrics?.higherCount)} != ${barrier.higher}`,
  );
  check(
    "lowerCount",
    replay?.recomputedMetrics?.lowerCount === barrier.lower,
    `canonical LOWER count ${String(replay?.recomputedMetrics?.lowerCount)} != ${barrier.lower}`,
  );
  check(
    "tieCount",
    replay?.recomputedMetrics?.tieCount === barrier.tie,
    `canonical TIE count ${String(replay?.recomputedMetrics?.tieCount)} != ${barrier.tie}`,
  );
  check(
    "outcomeWindowExclusions",
    (replay?.counts?.outcomeWindowExclusions ?? null) === barrier.outcomeWindowExclusions,
    `canonical outcome-window exclusions ${String(replay?.counts?.outcomeWindowExclusions)} != ${barrier.outcomeWindowExclusions}`,
  );

  // ---- provider / model / route / policy versions --------------------------
  check(
    "provider",
    experiment.provider === barrier.pins.provider,
    `canonical provider ${String(experiment.provider)} != ${barrier.pins.provider}`,
  );
  check(
    "upstreamProvider",
    experiment.upstreamProvider === barrier.pins.upstreamProvider,
    `canonical upstream provider ${String(experiment.upstreamProvider)} != ${barrier.pins.upstreamProvider}`,
  );
  check(
    "model",
    experiment.model === barrier.pins.model,
    `canonical model ${String(experiment.model)} != ${barrier.pins.model}`,
  );
  check(
    "directTypeSafe",
    experiment.gatewayUsed === false && experiment.offlineFixture !== true,
    "canonical development experiment is not direct TypeSafe (gatewayUsed=false, offlineFixture=false)",
  );
  check(
    "mode",
    experiment.mode === barrier.pins.mode,
    `canonical mode ${String(experiment.mode)} != ${barrier.pins.mode}`,
  );
  check(
    "outcomeResolutionPolicyV2",
    experiment.outcomeResolutionPolicyVersion === OUTCOME_RESOLUTION_POLICY_VERSION_V2 &&
      experiment.outcomeResolutionPolicyDigest === barrier.pins.outcomeResolutionPolicyDigest &&
      experiment.resolutionToleranceMs === barrier.pins.outcomeResolutionMaximumOffsetMs,
    "canonical development experiment does not pin frozen outcome-resolution policy v2 (10000 ms)",
  );
  check(
    "metricDefinitionV2",
    experiment.metricDefinitionVersion === DIRECTION_METRICS_VERSION &&
      experiment.metricDefinitionDigest === DIRECTION_METRIC_DEFINITION_DIGEST,
    "canonical development experiment does not pin metric definition v2",
  );
  check(
    "questionSetFrozen",
    experiment.questionSetId === barrier.pins.questionSetId &&
      experiment.questionSetVersion === barrier.pins.questionSetVersion &&
      experiment.questionDigest === barrier.pins.questionDigest,
    "canonical development experiment does not pin the frozen question set",
  );
  check(
    "featureDefinitionFrozen",
    experiment.featureDefinitionVersion === barrier.pins.featureDefinitionVersion &&
      experiment.featureDefinitionDigest === DIRECTION_FEATURE_DEFINITION_DIGEST,
    "canonical development experiment does not pin the frozen feature definition",
  );
  check(
    "baselineDefinitionFrozen",
    experiment.baselineDefinitionVersion === barrier.pins.baselineDefinitionVersion &&
      experiment.baselineDefinitionDigest === BASELINE_DEFINITION_DIGEST,
    "canonical development experiment does not pin the frozen baseline definition",
  );
  check(
    "referencePriceFrozen",
    experiment.referencePriceDefinitionVersion === barrier.pins.referencePriceDefinitionVersion &&
      experiment.referencePriceDefinitionDigest === REFERENCE_PRICE_DEFINITION_DIGEST,
    "canonical development experiment does not pin the frozen reference-price definition",
  );
  check(
    "stalenessFrozen",
    experiment.stalenessPolicyDigest === STALENESS_POLICY_DIGEST,
    "canonical development experiment does not pin the frozen staleness policy",
  );
  check(
    "targetHorizon30s",
    experiment.horizonSeconds === barrier.pins.horizonSeconds &&
      experiment.samplingCadenceMs === barrier.pins.samplingCadenceMs,
    "canonical development experiment is not the frozen 30 s horizon / 30 s cadence protocol",
  );
  check(
    "noConfidenceThreshold",
    summary?.noConfidenceThreshold === true &&
      summary?.everyValidProbabilityRetained === true &&
      summary?.metrics?.confidenceThresholdApplied === false,
    "canonical development summary reintroduced a confidence threshold",
  );

  // ---- canonical metrics + relative results -------------------------------
  const metrics = summary?.metrics ?? replay?.recomputedMetrics ?? null;
  if (metrics) {
    check(
      "jevBrier",
      close(metrics.jev?.brierScore, barrier.metrics.brier, DEVELOPMENT_BARRIER_METRIC_TOLERANCE),
      `canonical Jev Brier ${String(metrics.jev?.brierScore)} != ${barrier.metrics.brier}`,
    );
    check(
      "jevLogLoss",
      close(metrics.jev?.logLoss, barrier.metrics.logLoss, DEVELOPMENT_BARRIER_METRIC_TOLERANCE),
      `canonical Jev log loss ${String(metrics.jev?.logLoss)} != ${barrier.metrics.logLoss}`,
    );
    check(
      "jevAccuracy",
      close(metrics.jev?.accuracy, barrier.metrics.accuracy, DEVELOPMENT_BARRIER_METRIC_TOLERANCE),
      `canonical Jev accuracy ${String(metrics.jev?.accuracy)} != ${barrier.metrics.accuracy}`,
    );
    check(
      "meanPHigher",
      close(metrics.allValidPredictionStats?.meanPHigher, barrier.metrics.meanPHigher, DEVELOPMENT_BARRIER_METRIC_TOLERANCE),
      `canonical mean pHigher ${String(metrics.allValidPredictionStats?.meanPHigher)} != ${barrier.metrics.meanPHigher}`,
    );
    check(
      "medianPHigher",
      close(metrics.allValidPredictionStats?.medianPHigher, barrier.metrics.medianPHigher, DEVELOPMENT_BARRIER_METRIC_TOLERANCE),
      `canonical median pHigher ${String(metrics.allValidPredictionStats?.medianPHigher)} != ${barrier.metrics.medianPHigher}`,
    );
    for (const [baselineId, expected] of Object.entries(barrier.relative)) {
      const delta = metrics.brierDeltas?.[baselineId] ?? null;
      check(
        `relative.${baselineId}.brier`,
        close(delta?.jevMinusBaselineBrier, expected.brierDelta, DEVELOPMENT_BARRIER_METRIC_TOLERANCE),
        `canonical vs ${baselineId}: Brier delta ${String(delta?.jevMinusBaselineBrier)} != ${expected.brierDelta}`,
      );
      check(
        `relative.${baselineId}.logLoss`,
        close(delta?.jevMinusBaselineLogLoss, expected.logLossDelta, DEVELOPMENT_BARRIER_METRIC_TOLERANCE),
        `canonical vs ${baselineId}: log-loss delta ${String(delta?.jevMinusBaselineLogLoss)} != ${expected.logLossDelta}`,
      );
      check(
        `relative.${baselineId}.accuracy`,
        close(delta?.jevMinusBaselineAccuracy, expected.accuracyDelta, DEVELOPMENT_BARRIER_METRIC_TOLERANCE),
        `canonical vs ${baselineId}: accuracy delta ${String(delta?.jevMinusBaselineAccuracy)} != ${expected.accuracyDelta}`,
      );
    }

    // ---- timing diagnostics (infrastructure only, never tuned against) -----
    const timing = [
      ["outcomeTiming", metrics.outcomeOffsetStats, barrier.outcomeTiming, (block) => ({ meanMs: block.mean, medianMs: block.median, p95Ms: block.p95, maxMs: block.max })],
      ["achievedHorizon", metrics.achievedHorizonStats, barrier.achievedHorizon, (block) => ({ meanMs: block.mean, medianMs: block.median, p95Ms: block.p95, maxMs: block.max })],
      ["jevLatency", metrics.latency?.jevOkOnly, barrier.jevLatency, (block) => ({ meanMs: block.meanMs, medianMs: block.medianMs, p95Ms: block.p95Ms, maxMs: block.maxMs })],
    ];
    for (const [name, block, expected, project] of timing) {
      const projected = block ? project(block) : {};
      for (const [key, expectedValue] of Object.entries(expected)) {
        check(
          `${name}.${key}`,
          close(projected[key], expectedValue, DEVELOPMENT_BARRIER_TIMING_TOLERANCE_MS),
          `canonical ${name} ${key} ${String(projected[key])} != ${expectedValue}`,
        );
      }
    }

    // ---- infrastructure integrity ------------------------------------------
    check(
      "zeroFailures",
      (metrics.failedJevCount ?? null) === barrier.infrastructure.failed &&
        (metrics.lateJevCount ?? null) === barrier.infrastructure.late &&
        (metrics.tamperDetectedCount ?? null) === barrier.infrastructure.tamper,
      "canonical development experiment does not report zero failed/late/tamper observations",
    );
    check(
      "zeroRetries",
      (metrics.latency?.observationsWithTransportRetries ?? null) === barrier.infrastructure.retries,
      `canonical Jev transport retries ${String(metrics.latency?.observationsWithTransportRetries)} != ${barrier.infrastructure.retries}`,
    );
    check(
      "lookaheadClean",
      metrics.lookaheadAudit?.ok === true &&
        (metrics.lookaheadAudit?.featureViolations ?? null) === 0 &&
        (metrics.lookaheadAudit?.baselineViolations ?? null) === 0,
      "canonical development lookahead audit is not clean",
    );
    check(
      "noAutomatedWinner",
      metrics.winner === null && metrics.noAutomatedWinner === true && metrics.winnerLabelEmitted === false,
      "canonical development metrics emit an automated winner",
    );
  } else {
    check("metricsPresent", false, "canonical development metrics are unavailable");
  }

  // ---- replay-level integrity ---------------------------------------------
  if (replay) {
    check("replayOk", replay.ok === true, `canonical replay is not clean: ${(replay.problems ?? []).join("; ")}`);
    check("replayZeroNetwork", replay.networkCalls === 0 && replay.jevCalls === 0, "canonical replay touched the network");
    check(
      "replayLookahead",
      replay.lookaheadAudit?.ok === true &&
        replay.lookaheadAudit?.recomputationPairs === barrier.infrastructure.lookaheadRecomputationPairs,
      `canonical replay lookahead recomputation pairs ${String(replay.lookaheadAudit?.recomputationPairs)} != ${barrier.infrastructure.lookaheadRecomputationPairs}`,
    );
    check(
      "replayZeroTamper",
      (replay.counts?.tamperDetected ?? null) === 0 && (replay.counts?.failedJevObservations ?? null) === 0,
      "canonical replay reports tampered or failed observations",
    );
    check(
      "replayZeroFallback",
      (replay.counts?.invalidPredictions ?? null) === 0,
      "canonical replay reports invalid (fallback) predictions",
    );
    check(
      "replayMetricsReproduced",
      replay.metricsMatch === true,
      "canonical stored metricsDigest does not reproduce from the artifacts",
    );
  }

  return { present: true, ok: problems.length === 0, checks, problems };
}

/** Mirror of the pinned metrics digest, exported for cross-checks. */
export function canonicalDevelopmentMetricsDigest() {
  return CANONICAL_DEVELOPMENT_BARRIER.metricsDigest;
}

/** Digest helper used by validators to prove a metrics report is the canonical one. */
export function developmentMetricsDigestOf(metrics) {
  return metricsDigestOf(metrics);
}
