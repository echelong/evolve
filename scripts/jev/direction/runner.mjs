/**
 * Phase 5I.0b — the directional benchmark runner.
 *
 * ONE logical prediction per scheduled observation, persisted as an immutable
 * two-stage artifact so retrospective mutation is impossible:
 *
 *   genuine live state observed (pre-t0, whitelisted)
 *     -> packet + packet digest                       (pre-outcome only)
 *     -> ONE logical Jev call (bounded transport retries, same frozen state)
 *     -> prediction.json FROZEN HERE                  <- targetAt is still ahead
 *     -> targetAt passes
 *     -> prediction digest re-verified FROM DISK      (fail closed on mismatch)
 *     -> future reference observed                    (never rebuilds the input)
 *     -> outcome.json
 *
 * Guarantees this module enforces, not merely documents:
 *
 *   - `predictionCompletedAt >= targetAt`  -> `late_prediction`, NOT scored, and
 *     `targetAt` is NEVER moved because Jev was slow;
 *   - a changed prediction artifact        -> `prediction_digest_mismatch`,
 *     `tamperDetected: true`, NOT scored;
 *   - an outcome observed later than the frozen tolerance -> `resolution_lag_exceeded`,
 *     NOT scored;
 *   - a failed Jev call is preserved as a failed observation (with its transport
 *     attempts) rather than retried into a nicer-looking one;
 *   - TIE outcomes are retained and counted, and never folded into a class.
 *
 * Resumable, bounded, safe to interrupt (SIGINT finalizes progress + summary),
 * no daemon, no background process.
 *
 * PAPER ONLY / DEVELOPMENT EVIDENCE ONLY.
 */

import { digestOf } from "../../lib/hash.mjs";
import { classifyRegimeFromMetrics } from "../../arena/orchestrator.mjs";
import { NO_JEV_DECISION } from "../config.mjs";
import { jevDecide } from "../decide.mjs";
import { computeBaselines } from "./baselines.mjs";
import {
  BENCHMARK_MARKET,
  DIRECTION_DEVELOPMENT_FLAGS,
  DIRECTION_EVIDENCE_CLASS,
  DIRECTION_PHASE,
  DIRECTION_ROUTING_FLAGS,
  DIRECTION_SCHEMA_VERSION,
  FORBIDDEN_CANONICAL_PROVIDERS,
  MAX_RECEIPT_STATE_AGE_MS,
  MAX_SOURCE_STATE_AGE_MS,
  DEFAULT_OUTCOME_RESOLUTION_POLICY,
  OUTCOME_UNAVAILABLE_REASON,
  outcomeResolutionPolicyDigestFor,
  outcomeResolutionPolicyFor,
  resolveOutcomeOffset,
  REFERENCE_PRICE_DEFINITION_DIGEST,
  REFERENCE_PRICE_DEFINITION_VERSION,
  REQUIRED_MODEL,
  REQUIRED_PROVIDER,
  STALENESS_POLICY,
  STALENESS_POLICY_DIGEST,
  TARGET_AT_BASIS,
  TIMESTAMP_CAUSAL_CHECKS,
  UNAVAILABLE_FEATURE_FAMILIES_DIGEST,
} from "./definition.mjs";
import {
  DIRECTION_FEATURE_DEFINITION_DIGEST,
  DIRECTION_FEATURE_DEFINITION_VERSION,
  auditDirectionFeatures,
  auditGranularityNames,
  classifyDirectionRegime,
  extractDirectionFeatures,
  extractDirectionFeaturesFromInputs,
  preOutcomeInputDigestOf,
  warmupStatus,
} from "./features.mjs";
import {
  DIRECTION_METRIC_DEFINITION_DIGEST,
  DIRECTION_METRICS_VERSION,
  auditNoProfitabilityFields,
  auditProbabilityPair,
  evaluateDirectionExperiment,
  metricDefinitionDigestForVersion,
  metricDefinitionForVersion,
  metricsDigestOf,
  outcomeLabelOf,
} from "./metrics.mjs";
import { collectOfflineAuditInputs } from "./audit.mjs";
import {
  DIRECTION_ALLOWED_EVIDENCE_CLASS,
  DIRECTION_PACKET_KIND,
  DIRECTION_PACKET_VERSION,
  auditDirectionPacket,
  buildDirectionPacket,
  packetDigestOf,
  packetStateDigestOf,
} from "./packet.mjs";
import { DIRECTION_QUESTION_NAME, DIRECTION_QUESTION_SET_ID, DIRECTION_QUESTION_SET_VERSION } from "./questions.mjs";
import {
  BASELINE_DEFINITION_DIGEST,
  BASELINE_DEFINITION_VERSION,
} from "./baselines.mjs";
import {
  accumulateDirectionCounters,
  accumulateDirectionOutcomeCounters,
  buildDirectionOutcomeRecord,
  buildDirectionPredictionRecord,
  createDirectionExperiment,
  directionExperimentIdFor,
  directionExperimentRootFor,
  directionObservationIdFor,
  listDirectionPredictions,
  listDirectionOutcomes,
  outcomeDigestOf,
  predictionDigestOf,
  readDirectionExperiment,
  readDirectionExperimentBundle,
  readDirectionOutcome,
  readDirectionPrediction,
  readDirectionProgress,
  withOutcomeDigest,
  withPredictionDigest,
  writeDirectionExperiment,
  writeDirectionOutcome,
  writeDirectionPrediction,
  writeDirectionProgress,
  writeDirectionSummary,
} from "./storage.mjs";

export const DIRECTION_RUNNER_VERSION = 1;

/** How many pre-t0 universe snapshots the regime feature is computed over. */
export const REGIME_SNAPSHOT_LIMIT = 12;

/* ============================================================================
 * Waiting (bounded, interruptible, injectable for deterministic fixtures)
 * ==========================================================================*/

/**
 * @param {{ now: () => number, sleep: (ms: number) => Promise<void>, control?: { stopped?: boolean }, sliceMs?: number }} options
 * @returns {(targetMs: number) => Promise<boolean>} false when interrupted before the target
 */
export function createWaitFor({ now, sleep, control = null, sliceMs = 250 }) {
  return async function waitFor(targetMs) {
    while (now() < targetMs) {
      if (control?.stopped === true) return false;
      await sleep(Math.min(sliceMs, Math.max(1, targetMs - now())));
    }
    return true;
  };
}

/** Compact, deterministic regime snapshot (only the fields the classifier reads). */
export function compactRegimeSnapshot(markets) {
  return {
    markets: (Array.isArray(markets) ? markets : []).map((market) => ({
      mint: market?.mint ?? null,
      price: Number.isFinite(market?.price) ? market.price : null,
      liquidity: Number.isFinite(market?.liquidity) ? market.liquidity : null,
      volume5m: Number.isFinite(market?.volume5m) ? market.volume5m : null,
      buySellRatio: Number.isFinite(market?.buySellRatio) ? market.buySellRatio : null,
      organicBuySellRatio: Number.isFinite(market?.organicBuySellRatio) ? market.organicBuySellRatio : null,
      poolAgeMs: Number.isFinite(market?.poolAgeMs) ? market.poolAgeMs : null,
    })),
  };
}

/* ============================================================================
 * Stage 1 — freeze ONE prediction (before targetAt)
 * ==========================================================================*/

/**
 * Ask Jev ONE bounded question about ONE frozen pre-outcome state and write the
 * immutable prediction artifact. Never resolves an outcome.
 *
 * @returns {Promise<{
 *   prediction: object,
 *   historyEntry: { observedAt: string, priceUsd: number } | null,
 *   regimeSnapshot: object | null,
 *   questionsDigest: string,
 * }>}
 */
export async function freezeDirectionObservation({
  experiment,
  settings,
  state,
  observationId,
  observationIndex,
  scheduledAtMs,
  provider,
  questions,
  root,
  budget = null,
  now = () => Date.now(),
  history = [],
  regimeSnapshots = [],
}) {
  const baseRecordInput = {
    observationId,
    experimentId: experiment.experimentId,
    observationIndex,
    scheduledAt: new Date(scheduledAtMs).toISOString(),
    provider: provider?.name ?? experiment.provider,
    model: provider?.model ?? experiment.model,
    upstreamProvider: experiment.upstreamProvider ?? null,
    gatewayUsed: experiment.gatewayUsed === true,
    questionSetId: DIRECTION_QUESTION_SET_ID,
    questionSetVersion: DIRECTION_QUESTION_SET_VERSION,
    questionDigest: experiment.questionDigest ?? null,
    packetVersion: DIRECTION_PACKET_VERSION,
    packetKind: DIRECTION_PACKET_KIND,
    baselineDefinitionVersion: BASELINE_DEFINITION_VERSION,
    baselineDefinitionDigest: BASELINE_DEFINITION_DIGEST,
    featureDefinitionVersion: DIRECTION_FEATURE_DEFINITION_VERSION,
    featureDefinitionDigest: DIRECTION_FEATURE_DEFINITION_DIGEST,
  };

  // ---- the market state itself was not observable: record, do not invent ----
  if (state.ok !== true) {
    const record = withPredictionDigest(
      buildDirectionPredictionRecord({
        ...baseRecordInput,
        status: "MARKET_STATE_UNAVAILABLE",
        reason: state.reason ?? null,
        invalid: true,
        invalidReason: state.reason ?? "market_state_unavailable",
        scorable: false,
        jevCallAttempted: false,
      }),
    );
    await writeDirectionPrediction(root, record);
    return { prediction: record, historyEntry: null, regimeSnapshot: null, questionsDigest: null };
  }

  const featureVector = extractDirectionFeatures({
    market: state.market,
    token: state.token,
    history,
    observedAt: state.stateObservedAtMs,
    quoteMarket: state.quoteMarket,
    momentumReference: settings.momentumReference,
  });
  const featureAudit = auditDirectionFeatures(featureVector.features);
  if (!featureAudit.ok) {
    throw new Error(`refusing to freeze a state with a malformed feature vector: ${featureAudit.problems.join("; ")}`);
  }
  const warmup = warmupStatus(featureVector.features);

  const regimeSnapshot = compactRegimeSnapshot(state.universeMarkets);
  const regime = classifyDirectionRegime([...regimeSnapshots, regimeSnapshot].slice(-REGIME_SNAPSHOT_LIMIT));

  // ---- FREEZE INSTANT + multi-timestamp staleness accounting ----------------
  // `stateFrozenAt` is when EVOLVE completed the immutable model/baseline input
  // state, and it is the SOLE basis of `targetAt` (never the receipt instant, and
  // never moved because a model was slow). Source age and receipt age are
  // computed SEPARATELY and never mixed; a state with no venue timestamp keeps
  // `null` rather than borrowing the local receipt clock.
  const stateFrozenAtMs = now();
  const receivedAtMs = Number.isFinite(state.receivedAtMs) ? state.receivedAtMs : state.stateObservedAtMs;
  const latestSourceEventAtMs = Number.isFinite(state.sourceEventAtMs) ? state.sourceEventAtMs : null;
  const stateAge = {
    sourceTimestampAvailable: latestSourceEventAtMs !== null,
    latestSourceEventAt: latestSourceEventAtMs === null ? null : new Date(latestSourceEventAtMs).toISOString(),
    sourceAgeAtFreezeMs: latestSourceEventAtMs === null ? null : Math.max(0, stateFrozenAtMs - latestSourceEventAtMs),
    receiptAgeAtFreezeMs: Math.max(0, stateFrozenAtMs - receivedAtMs),
    sourceAgeAtPredictionCompleteMs: null,
    receiptAgeAtPredictionCompleteMs: null,
    maxReceiptStateAgeMs: MAX_RECEIPT_STATE_AGE_MS,
    maxSourceStateAgeMs: MAX_SOURCE_STATE_AGE_MS,
  };

  const packet = buildDirectionPacket({
    experimentId: experiment.experimentId,
    observationId,
    observationIndex,
    market: settings.market ?? BENCHMARK_MARKET,
    horizonSeconds: settings.horizonSeconds,
    sourceEventAt: state.sourceEventAt ?? null,
    receivedAt: new Date(receivedAtMs).toISOString(),
    stateObservedAt: state.stateObservedAt,
    stateAge,
    features: featureVector.features,
    recentObservationHistory: featureVector.historyUsed,
    regime,
    universe: {
      observedMarkets: state.universeSummary?.tracked ?? null,
      usableMarkets: state.universeSummary?.usable ?? null,
      source: state.health?.source ?? null,
      endpoints: state.health?.endpoints ?? [],
      synthetic: false,
    },
    quoteObservationAvailable: state.quoteObservationAvailable === true,
    createdAt: new Date(now()).toISOString(),
    generatedBy: { phase: DIRECTION_PHASE, runner: DIRECTION_RUNNER_VERSION },
  });

  const packetAudit = auditDirectionPacket(packet);
  if (!packetAudit.ok) {
    throw new Error(
      `refusing to send a Phase 5I packet that failed the leakage audit: ${JSON.stringify(packetAudit.violations)}`,
    );
  }

  const stateDigest = packetStateDigestOf(packet);
  const packetDigest = packetDigestOf(packet);
  if (stateDigest !== packetDigest) {
    throw new Error("packet digest and state digest disagree; refusing to freeze an inconsistent packet");
  }

  // Baselines consume the EXACT frozen state Jev's packet was built from: same
  // feature vector AND the same `stateDigest`, which is what a replay verifies.
  const baselines = computeBaselines(featureVector.features, { stateDigest });
  const preOutcomeInputDigest = preOutcomeInputDigestOf(featureVector.inputs);
  const questionsDigest = digestOf(questions);
  const targetAtMs = stateFrozenAtMs + settings.horizonMs;

  const sharedStateFields = {
    sourceEventAt: state.sourceEventAt ?? null,
    receivedAt: new Date(receivedAtMs).toISOString(),
    stateObservedAt: state.stateObservedAt,
    stateFrozenAt: new Date(stateFrozenAtMs).toISOString(),
    stateAge,
    targetAt: new Date(targetAtMs).toISOString(),
    targetAtBasis: TARGET_AT_BASIS,
    packet,
    stateDigest,
    featureValues: featureVector.features,
    preOutcomeInputs: featureVector.inputs,
    preOutcomeInputDigest,
    warmup,
    regime,
    baselines,
    referencePrice: Number.isFinite(state.market?.price) ? state.market.price : null,
    quoteObservedPrice: Number.isFinite(state.quoteMarket?.price) ? state.quoteMarket.price : null,
  };

  // ---- STALENESS GATE: decided BEFORE any model call, from the frozen rule ---
  // A stale scheduled observation is refused as-is. It is never refreshed, never
  // moved, and never replaced by a later observation pretending to be this one.
  const receiptStale = stateAge.receiptAgeAtFreezeMs > MAX_RECEIPT_STATE_AGE_MS;
  const sourceStale = stateAge.sourceAgeAtFreezeMs !== null && stateAge.sourceAgeAtFreezeMs > MAX_SOURCE_STATE_AGE_MS;
  if (receiptStale || sourceStale) {
    const staleReason = receiptStale ? "state_receipt_stale" : "state_source_stale";
    const measuredMs = receiptStale ? stateAge.receiptAgeAtFreezeMs : stateAge.sourceAgeAtFreezeMs;
    const record = withPredictionDigest(
      buildDirectionPredictionRecord({
        ...baseRecordInput,
        ...sharedStateFields,
        status: "MARKET_STATE_STALE",
        reason:
          `the frozen state was ${measuredMs}ms old at freeze, beyond the frozen cutoff; this scheduled observation is ` +
          "refused rather than refreshed or replaced",
        invalid: true,
        invalidReason: staleReason,
        scorable: false,
        jevCallAttempted: false,
      }),
    );
    await writeDirectionPrediction(root, record);
    // The price itself is a genuine observation, so it still joins the pre-t0
    // history. Only the PREDICTION was refused.
    return {
      prediction: record,
      historyEntry: { observedAt: state.stateObservedAt, priceUsd: state.market.price },
      regimeSnapshot,
      questionsDigest: null,
    };
  }

  const { run, decision } = await jevDecide({
    provider,
    packet,
    questions,
    questionSetId: DIRECTION_QUESTION_SET_ID,
    questionSetVersion: DIRECTION_QUESTION_SET_VERSION,
    decisionPacketVersion: DIRECTION_PACKET_VERSION,
    experimentId: experiment.experimentId,
    root,
    cacheEnabled: false,
    budget,
    now,
    salt: observationId,
  });

  const answer = decision === NO_JEV_DECISION ? null : decision?.[DIRECTION_QUESTION_NAME] ?? null;
  const pHigher = answer && answer.type === "noul" && Number.isFinite(answer.probability) ? answer.probability : null;
  const completedAtMs = Date.parse(run.completedAt);

  // The prediction artifact is finalized only AFTER the model answered. It can
  // never be finalized at or after `targetAt` and still count.
  const predictionFinalizedAtMs = Math.max(
    stateFrozenAtMs,
    Number.isFinite(completedAtMs) ? completedAtMs : stateFrozenAtMs,
    now(),
  );

  const observationStateAge = {
    ...stateAge,
    sourceAgeAtPredictionCompleteMs:
      latestSourceEventAtMs === null || !Number.isFinite(completedAtMs) ? null : Math.max(0, completedAtMs - latestSourceEventAtMs),
    receiptAgeAtPredictionCompleteMs: Number.isFinite(completedAtMs) ? Math.max(0, completedAtMs - receivedAtMs) : null,
  };

  const pLower = Number.isFinite(pHigher) ? 1 - pHigher : null;

  // Order matters: a slow model is a "late_prediction" (a timing fact), and only
  // a malformed probability is an "invalid_probability" (a model-output fact).
  let invalidReason = null;
  if (run.status !== "JEV_OK") invalidReason = `jev_${String(run.status).toLowerCase()}`;
  else if (Number.isFinite(completedAtMs) && completedAtMs >= targetAtMs) invalidReason = "late_prediction";
  else if (predictionFinalizedAtMs >= targetAtMs) invalidReason = "late_prediction";
  else if (!auditProbabilityPair(pHigher, pLower).ok) invalidReason = "invalid_probability";

  const invalid = invalidReason !== null;

  // Every logical prediction records at least ONE physical attempt. A provider
  // that reports its own attempt list wins; otherwise the single attempt this
  // call made is derived from the run record (the pre-5F.1 behaviour, kept
  // explicit rather than an empty list that would hide the call entirely).
  const providerAttempts =
    Array.isArray(run.providerAttempts) && run.providerAttempts.length > 0
      ? run.providerAttempts
      : [
          {
            attemptNumber: 1,
            provider: run.provider ?? baseRecordInput.provider,
            model: run.model ?? baseRecordInput.model,
            startedAt: run.startedAt ?? null,
            completedAt: run.completedAt ?? null,
            latencyMs: run.latencyMs ?? null,
            status: run.status,
            successful: run.status === "JEV_OK",
          },
        ];

  const modelIntent = !Number.isFinite(pHigher) ? null : pHigher >= 0.5 ? "HIGHER" : "LOWER";

  const record = withPredictionDigest(
    buildDirectionPredictionRecord({
      ...baseRecordInput,
      ...sharedStateFields,
      stateAge: observationStateAge,
      predictionStartedAt: run.startedAt ?? null,
      predictionCompletedAt: run.completedAt ?? null,
      predictionFinalizedAt: new Date(predictionFinalizedAtMs).toISOString(),
      latencyMs: run.latencyMs ?? null,
      status: run.status,
      reason: run.reason ?? null,
      invalid,
      invalidReason,
      // A valid prediction is one that completed BEFORE targetAt with a usable
      // probability. Whether its OUTCOME is scorable is decided later.
      scorable: !invalid,
      jevCallAttempted: true,
      requestId: run.requestId ?? null,
      // The RAW probability is retained even on a failure path, so a discarded
      // observation is never silently stripped of what the model actually said.
      pHigher,
      pLower,
      modelIntent,
      answer: answer ? { type: answer.type, probability: answer.probability ?? null } : null,
      providerAttempts,
      providerAttemptCount: providerAttempts.length,
      cacheHit: run.cacheHit === true,
    }),
  );

  await writeDirectionPrediction(root, record);
  return {
    prediction: record,
    historyEntry: { observedAt: state.stateObservedAt, priceUsd: state.market.price },
    regimeSnapshot,
    questionsDigest,
  };
}

/* ============================================================================
 * Stage 2 — resolve ONE outcome (after targetAt, never rebuilding the input)
 * ==========================================================================*/

/**
 * Resolve the outcome of an already-frozen prediction. The Jev input is NEVER
 * rebuilt: this function reads the stored artifact, verifies its digest, and only
 * then observes the future reference price.
 *
 * @returns {Promise<{ outcome: object|null, skipped: boolean, reason: string|null }>}
 */
export async function resolveDirectionObservation({
  experiment,
  prediction,
  settings,
  source,
  root,
  now = () => Date.now(),
  waitFor,
}) {
  const targetAtMs = Date.parse(prediction.targetAt);
  if (!Number.isFinite(targetAtMs)) return { outcome: null, skipped: true, reason: "target_at_unparseable" };

  // The bound comes from the experiment's OWN pinned policy version, never from
  // whatever the current default happens to be. An old v1 experiment therefore
  // resolves under exactly the rule it was frozen with.
  const policy = outcomePolicyOf(experiment);
  const maximumOffsetMs = policy.maximumOffsetMs;

  if (typeof waitFor === "function") {
    const waited = await waitFor(targetAtMs);
    if (!waited) return { outcome: null, skipped: true, reason: "interrupted_before_target" };
  }

  // ---- FAIL CLOSED: verify the frozen prediction digest from disk --------
  const stored = await readDirectionPrediction(root, prediction.observationId);
  const storedDigest = stored?.predictionDigest ?? null;
  const recomputedDigest = stored ? predictionDigestOf(stored) : null;
  const digestMatches = storedDigest !== null && storedDigest === recomputedDigest && storedDigest === prediction.predictionDigest;

  const resolutionStartedAtMs = now();
  const common = {
    observationId: prediction.observationId,
    experimentId: experiment.experimentId,
    observationIndex: prediction.observationIndex,
    stateObservedAt: prediction.stateObservedAt,
    stateFrozenAt: prediction.stateFrozenAt ?? null,
    targetAt: prediction.targetAt,
    horizonSeconds: settings.horizonSeconds,
    predictionCompletedAt: prediction.predictionCompletedAt,
    predictionFinalizedAt: prediction.predictionFinalizedAt ?? null,
    outcomeResolutionStartedAt: new Date(resolutionStartedAtMs).toISOString(),
    predictionDigestBeforeOutcome: stored?.predictionDigest ?? null,
    verifiedPredictionDigest: recomputedDigest ?? storedDigest,
  };

  if (!digestMatches) {
    const record = withOutcomeDigest(
      buildDirectionOutcomeRecord({
        ...common,
        // No future price is even LOOKED AT when the prediction no longer matches
        // what was frozen: scoring stops here.
        outcomeObservedAt: new Date(now()).toISOString(),
        tamperDetected: true,
        scorable: false,
        invalidReason: stored === null ? "prediction_artifact_missing" : "prediction_digest_mismatch",
        resolvedAt: now(),
        outcomeResolutionPolicy: policy,
      }),
    );
    await writeDirectionOutcome(root, record);
    return { outcome: record, skipped: false, reason: "prediction_digest_mismatch" };
  }

  // The future reference is the FIRST genuine wrapped-SOL observation received at
  // or after targetAt (the walk stops at it). A pre-target observation is never
  // selected as a substitute.
  const future = await source.observeFuture({ targetAtMs });
  if (future.ok !== true) {
    const record = withOutcomeDigest(
      buildDirectionOutcomeRecord({
        ...common,
        outcomeObservedAt: new Date(now()).toISOString(),
        scorable: false,
        invalidReason: OUTCOME_UNAVAILABLE_REASON,
        unavailableDetail: `unresolved_${future.reason ?? "future_reference_unavailable"}`,
        resolvedAt: now(),
        outcomeResolutionPolicy: policy,
      }),
    );
    await writeDirectionOutcome(root, record);
    return { outcome: record, skipped: false, reason: OUTCOME_UNAVAILABLE_REASON };
  }

  const outcomeReceivedAtMs = future.outcomeReceivedAtMs;
  // The resolution lag is measured on the observation EVOLVE RECEIVED, never on
  // the later instant the artifact happened to be written (which would inflate
  // the lag by our own bookkeeping time).
  const resolutionLagMs = outcomeReceivedAtMs - targetAtMs;
  const stateObservedMs = Date.parse(prediction.stateObservedAt);
  const achievedHorizonMs = Number.isFinite(stateObservedMs) ? outcomeReceivedAtMs - stateObservedMs : null;

  // Bounded-window decision via the ONE pure classifier: it depends only on the
  // timestamps and the pinned policy bound — never on pHigher or the direction.
  let invalidReason = resolveOutcomeOffset({ outcomeReceivedAtMs, targetAtMs, maximumOffsetMs }).invalidReason;

  // The current price comes from the FROZEN prediction artifact — the resolver
  // never re-reads (and never rebuilds) the model input.
  const currentPrice = Number.isFinite(prediction.referencePrice) ? prediction.referencePrice : null;
  const futurePrice = Number.isFinite(future.price) ? future.price : null;
  const actualOutcome = outcomeLabelOf(currentPrice, futurePrice);
  if (actualOutcome === null) invalidReason = invalidReason ?? "reference_price_unusable";

  const scorable = invalidReason === null && (actualOutcome === "HIGHER" || actualOutcome === "LOWER");

  const record = withOutcomeDigest(
    buildDirectionOutcomeRecord({
      ...common,
      outcomeSourceEventAt: future.outcomeSourceEventAt ?? null,
      outcomeReceivedAt: future.outcomeReceivedAt,
      outcomeObservedAt: new Date(now()).toISOString(),
      achievedHorizonMs,
      resolutionLagMs,
      outcomeOffsetMs: resolutionLagMs,
      currentReferencePrice: currentPrice,
      futureReferencePrice: futurePrice,
      actualOutcome,
      scorable,
      invalidReason,
      tamperDetected: false,
      resolvedAt: now(),
      outcomeResolutionPolicy: policy,
    }),
  );
  await writeDirectionOutcome(root, record);
  return { outcome: record, skipped: false, reason: invalidReason };
}

/* ============================================================================
 * Experiment-level orchestration
 * ==========================================================================*/

/** The frozen outcome-resolution policy an experiment is pinned to (fail-closed to the current default). */
function outcomePolicyOf(experiment) {
  const version = experiment?.outcomeResolutionPolicyVersion ?? experiment?.outcomeResolutionPolicy?.version ?? null;
  return outcomeResolutionPolicyFor(version) ?? DEFAULT_OUTCOME_RESOLUTION_POLICY;
}

function pinsFromSettings({ settings, experimentId, pinResult, now }) {
  return {
    experimentId,
    market: settings.market,
    provider: pinResult.resolution.provider,
    model: pinResult.model,
    upstreamProvider: pinResult.identity?.upstreamProvider ?? null,
    gatewayUsed: pinResult.identity?.gatewayUsed === true,
    mode: "shadow",
    offlineFixture: pinResult.offlineFixture === true,
    providerImplementation: pinResult.providerImplementation ?? null,
    observationEndpoints: Array.isArray(pinResult.observationEndpoints) ? [...pinResult.observationEndpoints] : null,
    horizonSeconds: settings.horizonSeconds,
    resolutionToleranceMs: settings.resolutionToleranceMs,
    samplingCadenceMs: settings.cadenceMs,
    maxObservations: settings.maxObservations,
    maxRuntimeMinutes: settings.maxRuntimeMinutes,
    questionSetId: DIRECTION_QUESTION_SET_ID,
    questionSetVersion: DIRECTION_QUESTION_SET_VERSION,
    questionDigest: pinResult.questionDigest,
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
    stalenessPolicy: STALENESS_POLICY,
    stalenessPolicyDigest: STALENESS_POLICY_DIGEST,
    outcomeResolutionPolicy: settings.outcomeResolutionPolicy ?? DEFAULT_OUTCOME_RESOLUTION_POLICY,
    outcomeResolutionPolicyDigest:
      settings.outcomeResolutionPolicyDigest ?? outcomeResolutionPolicyDigestFor(settings.outcomeResolutionPolicyVersion),
    outcomeResolutionPolicyVersion:
      settings.outcomeResolutionPolicyVersion ?? (settings.outcomeResolutionPolicy ?? DEFAULT_OUTCOME_RESOLUTION_POLICY).version,
    unavailableFeatureFamiliesDigest: UNAVAILABLE_FEATURE_FAMILIES_DIGEST,
    routingFlags: DIRECTION_ROUTING_FLAGS,
    startedAt: now(),
    providerConfigNote: pinResult.identity
      ? `transport=${pinResult.identity.transport ?? "unknown"}; gatewayUsed=${pinResult.identity.gatewayUsed === true}`
      : null,
  };
}

export const PIN_COMPARISONS = Object.freeze([
  "provider",
  "model",
  "offlineFixture",
  "observationEndpoints",
  "gatewayUsed",
  "mode",
  "horizonSeconds",
  "resolutionToleranceMs",
  "samplingCadenceMs",
  "maxObservations",
  "questionSetId",
  "questionSetVersion",
  "questionDigest",
  "packetKind",
  "packetVersion",
  "featureDefinitionVersion",
  "featureDefinitionDigest",
  "baselineDefinitionVersion",
  "baselineDefinitionDigest",
  "metricDefinitionVersion",
  "metricDefinitionDigest",
  "referencePriceDefinitionVersion",
  "referencePriceDefinitionDigest",
  "stalenessPolicyDigest",
  "outcomeResolutionPolicyDigest",
  "outcomeResolutionPolicyVersion",
  "unavailableFeatureFamiliesDigest",
]);

/**
 * Value comparison for pinned fields. Scalars compare by identity; arrays and
 * policy objects compare by canonical content digest, so a pinned policy is
 * verified by VALUE (and a mutation of any element is caught) rather than by
 * object identity, which is never stable across processes.
 */
function samePinValue(a, b) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a === "object" || typeof b === "object") return digestOf(a) === digestOf(b);
  return false;
}

/** Every pinned field must match, or a resume/replay is refused. */
export function verifyDirectionPins(experiment, expected) {
  const problems = [];
  for (const key of PIN_COMPARISONS) {
    if (!samePinValue(experiment?.[key], expected?.[key])) {
      problems.push(`pin '${key}' differs (experiment ${JSON.stringify(experiment?.[key])} != requested ${JSON.stringify(expected?.[key])})`);
    }
  }
  if (experiment?.market?.marketId !== expected?.market?.marketId) {
    problems.push(`pin 'market.marketId' differs (${experiment?.market?.marketId} != ${expected?.market?.marketId})`);
  }
  if (experiment?.gatewayUsed !== false) problems.push("experiment does not pin gatewayUsed=false");
  if (experiment?.mode !== "shadow") problems.push("experiment does not pin mode=shadow");
  if (experiment?.evidenceClass !== DIRECTION_EVIDENCE_CLASS) {
    problems.push("experiment does not declare the Phase 5I development evidence class");
  }
  for (const flag of [
    "jevTradingRoutingActive",
    "arenaRoutingActive",
    "deepseekRoutingActive",
    "classifierRoutingActive",
    "agentReachRoutingActive",
    "tradingRoutingActive",
  ]) {
    if (experiment?.[flag] !== false) problems.push(`experiment routing flag '${flag}' is not false`);
  }
  if (experiment?.jevPredictionActive !== true) problems.push("experiment does not declare jevPredictionActive=true");
  return { ok: problems.length === 0, problems };
}

/** Build the finalized summary (metrics + identity pins + development flags). */
export async function finalizeDirectionSummary({ root, experiment, predictions, outcomes, status }) {
  // The SAME optional audit inputs the replay and `--stats` recompute, so the
  // written `metricsDigest` reproduces exactly on a later read.
  const { featureStability, lookaheadAudit } = collectOfflineAuditInputs(predictions);
  // The summary is computed under the DEFINITION VERSIONS THE EXPERIMENT PINNED,
  // so finalizing an older experiment never silently re-scores it under the
  // current default definitions.
  const metricDefinitionVersion = experiment.metricDefinitionVersion ?? DIRECTION_METRICS_VERSION;
  const metrics = evaluateDirectionExperiment({
    experiment,
    predictions,
    outcomes,
    featureStability,
    lookaheadAudit,
    metricDefinitionVersion,
  });
  const profitabilityAudit = auditNoProfitabilityFields(metrics);
  if (!profitabilityAudit.ok) {
    throw new Error(
      `refusing to write a Phase 5I summary whose metrics contain profitability-shaped fields: ${profitabilityAudit.problems.join("; ")}`,
    );
  }
  const summary = {
    schemaVersion: DIRECTION_SCHEMA_VERSION,
    phase: DIRECTION_PHASE,
    summaryKind: "DIRECTION_SUMMARY",
    evidenceClass: DIRECTION_EVIDENCE_CLASS,
    ...DIRECTION_DEVELOPMENT_FLAGS,
    ...DIRECTION_ROUTING_FLAGS,
    experimentId: experiment.experimentId,
    status,
    market: experiment.market,
    // ---- pinned contract, mirrored so a summary is self-describing ----------
    referencePriceDefinitionVersion: experiment.referencePriceDefinitionVersion,
    referencePriceDefinitionDigest: experiment.referencePriceDefinitionDigest,
    provider: experiment.provider,
    model: experiment.model,
    upstreamProvider: experiment.upstreamProvider ?? null,
    gatewayUsed: experiment.gatewayUsed === true,
    mode: experiment.mode ?? "shadow",
    horizonSeconds: experiment.horizonSeconds,
    targetAtBasis: TARGET_AT_BASIS,
    resolutionToleranceMs: experiment.resolutionToleranceMs,
    samplingCadenceMs: experiment.samplingCadenceMs,
    maxObservations: experiment.maxObservations,
    questionSetId: experiment.questionSetId,
    questionSetVersion: experiment.questionSetVersion,
    questionDigest: experiment.questionDigest,
    packetKind: experiment.packetKind,
    packetVersion: experiment.packetVersion,
    featureDefinitionVersion: experiment.featureDefinitionVersion,
    featureDefinitionDigest: experiment.featureDefinitionDigest,
    baselineDefinitionVersion: experiment.baselineDefinitionVersion,
    baselineDefinitionDigest: experiment.baselineDefinitionDigest,
    metricDefinitionVersion,
    metricDefinitionDigest: metricDefinitionDigestForVersion(metricDefinitionVersion),
    stalenessPolicy: STALENESS_POLICY,
    stalenessPolicyDigest: STALENESS_POLICY_DIGEST,
    outcomeResolutionPolicy: outcomePolicyOf(experiment),
    outcomeResolutionPolicyDigest: outcomeResolutionPolicyDigestFor(outcomePolicyOf(experiment).version),
    outcomeResolutionPolicyVersion: outcomePolicyOf(experiment).version,
    unavailableFeatureFamiliesDigest: experiment.unavailableFeatureFamiliesDigest,
    startedAt: experiment.startedAt,
    finalizedAt: new Date().toISOString(),
    finalized: true,
    metrics,
    metricsDigest: metricsDigestOf(metrics),
    profitabilityFieldAudit: { ok: profitabilityAudit.ok, violations: profitabilityAudit.problems },
    winner: null,
    noAutomatedWinner: true,
    noConfidenceThreshold: true,
    everyValidProbabilityRetained: true,
    evidenceScope: "DEVELOPMENT",
    replicationStatus: "NOT_REPLICATED",
    note:
      "DEVELOPMENT-ONLY directional prediction evidence. Not a trading strategy, not a profitability claim, not a " +
      "deployment decision. A later Phase 5I.1 must use fresh unseen data before anything is described as replicated.",
  };
  await writeDirectionSummary(root, summary);
  return summary;
}

/**
 * Run the benchmark loop for `start` / `resume` / `resolve`.
 *
 * @param {{
 *   action: "start"|"resume"|"resolve",
 *   settings: object,
 *   provider: object,
 *   source: object,
 *   baseRoot?: string|null,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   control?: { stopped?: boolean }|null,
 *   onProgress?: ((event: object) => void)|null,
 *   budget?: object|null,
 *   questions: object,
 *   experimentId?: string|null,
 *   pinResult: object,
 * }} options
 */
export async function runDirectionBenchmark({
  action,
  settings,
  provider,
  source,
  baseRoot = null,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  control = null,
  onProgress = null,
  budget = null,
  questions,
  experimentId = null,
  pinResult,
}) {
  const waitFor = createWaitFor({ now, sleep, control });
  const emit = (event) => {
    if (typeof onProgress === "function") onProgress(event);
  };

  let root = null;
  let experiment = null;

  if (action === "start") {
    const id = experimentId ?? directionExperimentIdFor({ marketId: settings.marketId, startedAt: now() });
    root = directionExperimentRootFor(baseRoot, id);
    const existing = await readDirectionExperiment(root);
    if (existing) {
      return { ok: false, error: `experiment ${id} already exists; use --resume (explicit ids are never reused)`, experimentId: id, root };
    }
    const pins = pinsFromSettings({ settings, experimentId: id, pinResult, now });
    experiment = createDirectionExperiment({ ...pins, experimentId: id });
    await writeDirectionExperiment(root, experiment);
    await writeDirectionProgress(root, {
      schemaVersion: DIRECTION_SCHEMA_VERSION,
      runnerVersion: DIRECTION_RUNNER_VERSION,
      nextIndex: 0,
      nextScheduledAtMs: now(),
      history: [],
      regimeSnapshots: [],
      lastObservationId: null,
    });
    emit({ type: "EXPERIMENT_CREATED", experimentId: id, root, action });
  } else {
    if (!experimentId) return { ok: false, error: `${action} requires an explicit --experiment <id>`, experimentId: null, root: null };
    root = directionExperimentRootFor(baseRoot, experimentId);
    experiment = await readDirectionExperiment(root);
    if (!experiment) return { ok: false, error: `no Phase 5I experiment at ${root}`, experimentId, root };
    const pins = pinsFromSettings({ settings, experimentId, pinResult, now });
    const verified = verifyDirectionPins(experiment, pins);
    if (!verified.ok) {
      return { ok: false, error: `experiment pins do not match this invocation: ${verified.problems.join("; ")}`, experimentId, root };
    }
    emit({ type: action.toUpperCase(), experimentId, root });
  }

  const budgetGuard =
    budget ?? { exhausted: () => false, consume: () => true, max: null, used: 0, remaining: null };

  const runStartedMs = now();
  const runtimeExceeded = () => now() - runStartedMs > settings.maxRuntimeMs;
  const stopRequested = () => control?.stopped === true || runtimeExceeded();

  let progress = (await readDirectionProgress(root)) ?? {
    schemaVersion: DIRECTION_SCHEMA_VERSION,
    runnerVersion: DIRECTION_RUNNER_VERSION,
    nextIndex: 0,
    nextScheduledAtMs: now(),
    history: [],
    regimeSnapshots: [],
    lastObservationId: null,
  };

  let interrupted = false;
  let finalStatus = "COMPLETE";

  const persistProgress = async (patch = {}) => {
    progress = { ...progress, ...patch, updatedAt: new Date().toISOString() };
    await writeDirectionProgress(root, progress);
  };

  const recordResolvedOutcome = async (outcome) => {
    experiment = { ...experiment, counters: accumulateDirectionOutcomeCounters(experiment.counters, outcome) };
    await writeDirectionExperiment(root, experiment);
  };

  /**
   * Resolve every frozen, scorable prediction that has no outcome yet.
   *
   * Used by `--resolve` AND as the crash-recovery sweep at the head of a
   * `--resume`: an interrupted run may have frozen an observation whose outcome
   * was never written (the interruption landed between the freeze and the
   * target horizon). That observation is resolved HERE from its own frozen
   * artifact — never re-predicted, never rewritten, never re-scheduled.
   */
  const resolvePendingOutcomes = async () => {
    // Only predictions that were validly frozen and have no outcome yet are
    // considered. Nothing new is ever predicted here.
    const predictions = await listDirectionPredictions(root);
    const outcomes = await listDirectionOutcomes(root);
    const resolvedIds = new Set(outcomes.map((entry) => entry.observationId));
    let resolved = 0;
    let refused = 0;
    for (const prediction of predictions) {
      if (prediction.scorable !== true || resolvedIds.has(prediction.observationId)) continue;
      if (stopRequested()) {
        interrupted = true;
        break;
      }
      const targetAtMs = Date.parse(prediction.targetAt);
      const withinWindow = Number.isFinite(targetAtMs) && now() <= targetAtMs + outcomePolicyOf(experiment).maximumOffsetMs;
      if (!withinWindow) {
        // Resolved too late to be an honest reading of the frozen 30-second
        // horizon: OUTCOME_UNAVAILABLE. The prediction artifact is untouched.
        const record = withOutcomeDigest(
          buildDirectionOutcomeRecord({
            observationId: prediction.observationId,
            experimentId: experiment.experimentId,
            observationIndex: prediction.observationIndex,
            stateObservedAt: prediction.stateObservedAt,
            stateFrozenAt: prediction.stateFrozenAt ?? null,
            targetAt: prediction.targetAt,
            horizonSeconds: settings.horizonSeconds,
            predictionCompletedAt: prediction.predictionCompletedAt,
            predictionFinalizedAt: prediction.predictionFinalizedAt ?? null,
            outcomeResolutionStartedAt: new Date(now()).toISOString(),
            outcomeObservedAt: new Date(now()).toISOString(),
            predictionDigestBeforeOutcome: prediction.predictionDigest ?? null,
            verifiedPredictionDigest: predictionDigestOf(await readDirectionPrediction(root, prediction.observationId)) ?? null,
            scorable: false,
            invalidReason: OUTCOME_UNAVAILABLE_REASON,
            unavailableDetail: "resolution_window_missed",
            tamperDetected: false,
            resolvedAt: now(),
            outcomeResolutionPolicy: outcomePolicyOf(experiment),
          }),
        );
        await writeDirectionOutcome(root, record);
        refused += 1;
        await recordResolvedOutcome(record);
        emit({ type: "OUTCOME_REFUSED", observationId: prediction.observationId, reason: OUTCOME_UNAVAILABLE_REASON });
        continue;
      }
      const result = await resolveDirectionObservation({ experiment, prediction, settings, source, root, now, waitFor });
      if (result.skipped) {
        interrupted = true;
        break;
      }
      resolved += 1;
      await recordResolvedOutcome(result.outcome);
      emit({ type: "OUTCOME_RESOLVED", observationId: prediction.observationId, actualOutcome: result.outcome?.actualOutcome ?? null });
    }
    return { resolved, refused, scanned: predictions.length };
  };

  if (action === "resolve") {
    const report = await resolvePendingOutcomes();
    experiment = { ...experiment, status: interrupted ? "INTERRUPTED" : "RESOLVED", finalized: true };
    await writeDirectionExperiment(root, experiment);
    const refreshed = await readDirectionExperimentBundle(root);
    const summary = await finalizeDirectionSummary({
      root,
      experiment: refreshed.experiment ?? experiment,
      predictions: refreshed.predictions,
      outcomes: refreshed.outcomes,
      status: experiment.status,
    });
    return {
      ok: true,
      action,
      experimentId: experiment.experimentId,
      root,
      experiment,
      summary,
      metrics: summary.metrics,
      interrupted,
      error: null,
      report,
    };
  }

  if (action === "resume") {
    // Crash recovery (§23). A previous interrupted run may have frozen an
    // observation and stopped before its outcome existed. Those are resolved
    // here, before any new slot is scheduled; a resolution that is too late to
    // be an honest reading of the 30s horizon becomes OUTCOME_UNAVAILABLE rather
    // than a fabricated price.
    await resolvePendingOutcomes();
  }

  // ---- start / resume: one observation at a time --------------------------
  let predictionsWritten = 0;
  let invalidWritten = 0;
  let outcomesResolved = 0;

  while (progress.nextIndex < settings.maxObservations) {
    if (stopRequested()) {
      interrupted = true;
      finalStatus = "INTERRUPTED";
      break;
    }

    const index = progress.nextIndex;
    const observationId = directionObservationIdFor({ experimentId: experiment.experimentId, index });
    const scheduledMs = Math.max(now(), progress.nextScheduledAtMs ?? now());

    const waited = await waitFor(scheduledMs);
    if (!waited) {
      interrupted = true;
      finalStatus = "INTERRUPTED";
      break;
    }

    // Crash recovery: a prediction from an interrupted run may already exist for
    // this index. It is NEVER rewritten — it is either resolved or refused.
    const pending = await readDirectionPrediction(root, observationId);
    if (pending) {
      if (pending.scorable === true && (await readDirectionOutcome(root, observationId)) === null) {
        const result = await resolveDirectionObservation({ experiment, prediction: pending, settings, source, root, now, waitFor });
        if (result.skipped) {
          interrupted = true;
          finalStatus = "INTERRUPTED";
          break;
        }
        outcomesResolved += 1;
        await recordResolvedOutcome(result.outcome);
        emit({ type: "OUTCOME_RESOLVED", observationId, actualOutcome: result.outcome?.actualOutcome ?? null });
      }
      await persistProgress({
        nextIndex: index + 1,
        nextScheduledAtMs: scheduledMs + settings.cadenceMs,
        lastObservationId: observationId,
      });
      continue;
    }

    const state = await source.observeState();
    const frozen = await freezeDirectionObservation({
      experiment,
      settings,
      state,
      observationId,
      observationIndex: index,
      scheduledAtMs: scheduledMs,
      provider,
      questions,
      root,
      budget: budgetGuard,
      now,
      history: progress.history ?? [],
      regimeSnapshots: progress.regimeSnapshots ?? [],
    });

    const prediction = frozen.prediction;
    predictionsWritten += 1;
    if (prediction.invalid === true) invalidWritten += 1;

    experiment = {
      ...experiment,
      counters: accumulateDirectionCounters(experiment.counters, prediction),
    };
    await writeDirectionExperiment(root, experiment);

    emit({
      type: prediction.invalid ? "PREDICTION_INVALID" : "PREDICTION_FROZEN",
      observationId,
      observationIndex: index,
      status: prediction.status,
      invalidReason: prediction.invalidReason,
      pHigher: prediction.pHigher,
      latencyMs: prediction.latencyMs,
      referencePrice: prediction.referencePrice,
    });

    const history = frozen.historyEntry ? [...(progress.history ?? []), frozen.historyEntry].slice(-64) : (progress.history ?? []);
    const regimeSnapshots = frozen.regimeSnapshot
      ? [...(progress.regimeSnapshots ?? []), frozen.regimeSnapshot].slice(-REGIME_SNAPSHOT_LIMIT)
      : (progress.regimeSnapshots ?? []);
    await persistProgress({
      nextIndex: index + 1,
      nextScheduledAtMs: scheduledMs + settings.cadenceMs,
      history,
      regimeSnapshots,
      lastObservationId: observationId,
    });

    if (prediction.scorable !== true) continue;

    if (stopRequested()) {
      interrupted = true;
      finalStatus = "INTERRUPTED";
      break;
    }

    const resolvedResult = await resolveDirectionObservation({
      experiment,
      prediction,
      settings,
      source,
      root,
      now,
      waitFor,
    });
    if (resolvedResult.skipped) {
      interrupted = true;
      finalStatus = "INTERRUPTED";
      break;
    }
    outcomesResolved += 1;
    await recordResolvedOutcome(resolvedResult.outcome);
    emit({
      type: "OUTCOME_RESOLVED",
      observationId,
      actualOutcome: resolvedResult.outcome?.actualOutcome ?? null,
      scorable: resolvedResult.outcome?.scorable === true,
      resolutionLagMs: resolvedResult.outcome?.resolutionLagMs ?? null,
      invalidReason: resolvedResult.outcome?.invalidReason ?? null,
    });
  }

  experiment = { ...experiment, status: finalStatus };
  await writeDirectionExperiment(root, experiment);

  const bundle = await readDirectionExperimentBundle(root);
  const summary = await finalizeDirectionSummary({
    root,
    experiment: bundle.experiment ?? experiment,
    predictions: bundle.predictions,
    outcomes: bundle.outcomes,
    status: finalStatus,
  });

  return {
    ok: true,
    action,
    experimentId: experiment.experimentId,
    root,
    experiment,
    summary,
    metrics: summary.metrics,
    interrupted,
    error: null,
    report: { predictionsWritten, invalidWritten, outcomesResolved, nextIndex: progress.nextIndex },
  };
}

/* ============================================================================
 * Offline replay (READ ONLY, zero network, zero provider calls)
 * ==========================================================================*/

/**
 * Recompute the whole experiment from its own persisted artifacts and prove its
 * integrity. Nothing is written, no provider is called, no market is touched.
 */
export async function replayDirectionExperiment({ experimentId, baseRoot = null }) {
  const root = directionExperimentRootFor(baseRoot, experimentId);
  const bundle = await readDirectionExperimentBundle(root);
  const problems = [];
  const experiment = bundle.experiment;

  if (!experiment) {
    return {
      schemaVersion: DIRECTION_SCHEMA_VERSION,
      phase: DIRECTION_PHASE,
      experimentId,
      root,
      ok: false,
      problems: [`no Phase 5I experiment at ${root}`],
      readOnly: true,
      networkCalls: 0,
      providerCalls: 0,
      jevCalls: 0,
      agentReachCalls: 0,
      classifierCalls: 0,
      deepseekCalls: 0,
      arenaRuns: 0,
      tradingCalls: 0,
    };
  }

  const predictionDigestsReproduced = [];
  const packetDigestsReproduced = [];
  const baselinesReproduced = [];
  const featuresReproduced = [];
  const inputDigestsReproduced = [];
  const probabilityPairsAudited = [];
  const granularityAudits = [];
  const timingInvariants = [];
  const outcomeDigestsReproduced = [];
  const regimeLabelsReproduced = [];

  for (const prediction of bundle.predictions) {
    predictionDigestsReproduced.push(predictionDigestOf(prediction) === prediction.predictionDigest);
    if (predictionDigestOf(prediction) !== prediction.predictionDigest) {
      problems.push(`prediction ${prediction.observationId}: digest does not recompute from the artifact body`);
    }

    if (prediction.packet) {
      const dagree = packetDigestOf(prediction.packet) === prediction.packetDigest;
      packetDigestsReproduced.push(dagree);
      if (!dagree) problems.push(`prediction ${prediction.observationId}: packet digest does not recompute`);
      if (packetStateDigestOf(prediction.packet) !== prediction.stateDigest) {
        problems.push(`prediction ${prediction.observationId}: state digest differs from the packet digest`);
      }
      const audit = auditDirectionPacket(prediction.packet);
      if (!audit.ok) problems.push(`prediction ${prediction.observationId}: packet failed the leakage audit (${audit.violations.length})`);
      if (prediction.packet.evidenceClass !== DIRECTION_ALLOWED_EVIDENCE_CLASS) {
        problems.push(`prediction ${prediction.observationId}: unexpected evidence class on the packet`);
      }
      if (prediction.packet.packetKind !== DIRECTION_PACKET_KIND) {
        problems.push(`prediction ${prediction.observationId}: unexpected packet kind`);
      }

      // ---- feature recomputation from the PERSISTED pre-outcome projection ---
      // The vector must be a pure function of the frozen inputs EVOLVE recorded,
      // not merely self-consistent with itself.
      if (prediction.preOutcomeInputs) {
        const recomputedFeatures = extractDirectionFeaturesFromInputs(prediction.preOutcomeInputs).features;
        const sameFeatures = digestOf(recomputedFeatures) === digestOf(prediction.featureValues);
        featuresReproduced.push(sameFeatures);
        if (!sameFeatures) {
          problems.push(`prediction ${prediction.observationId}: features do not recompute from the persisted pre-outcome inputs`);
        }
        if (prediction.preOutcomeInputDigest !== null && prediction.preOutcomeInputDigest !== undefined) {
          const sameInputs = preOutcomeInputDigestOf(prediction.preOutcomeInputs) === prediction.preOutcomeInputDigest;
          inputDigestsReproduced.push(sameInputs);
          if (!sameInputs) problems.push(`prediction ${prediction.observationId}: pre-outcome input digest does not recompute`);
        }
      } else {
        problems.push(`prediction ${prediction.observationId}: no persisted pre-outcome input projection`);
      }

      if (prediction.featureValues) {
        const recomputedBaselines = computeBaselines(prediction.featureValues, { stateDigest: prediction.stateDigest ?? null });
        const same = digestOf(recomputedBaselines) === digestOf(prediction.baselines);
        baselinesReproduced.push(same);
        if (!same) problems.push(`prediction ${prediction.observationId}: baselines do not recompute from the frozen features`);
        // SAME-STATE FAIRNESS: every baseline must name the SAME frozen state pin
        // as the packet Jev was asked about.
        for (const [baselineId, baseline] of Object.entries(prediction.baselines ?? {})) {
          if (baseline?.stateDigest !== prediction.stateDigest) {
            problems.push(`prediction ${prediction.observationId}: baseline '${baselineId}' does not share the frozen state digest`);
          }
        }
      }

      // A probability pair must be internally consistent and in range.
      if (prediction.pHigher !== null || prediction.pLower !== null) {
        const pair = auditProbabilityPair(prediction.pHigher, prediction.pLower);
        probabilityPairsAudited.push(pair.ok);
        if (!pair.ok) problems.push(`prediction ${prediction.observationId}: probability pair is invalid (${pair.problems.join("; ")})`);
      }
      if (prediction.executedAction !== null || prediction.overrideReason !== null) {
        problems.push(`prediction ${prediction.observationId}: Phase 5I.0b must keep executedAction/overrideReason null`);
      }
      // Explicit zero-authority routing flags on every artifact.
      for (const flag of [
        "jevTradingRoutingActive",
        "arenaRoutingActive",
        "deepseekRoutingActive",
        "classifierRoutingActive",
        "agentReachRoutingActive",
        "tradingRoutingActive",
      ]) {
        if (prediction[flag] !== false) problems.push(`prediction ${prediction.observationId}: routing flag '${flag}' is not false`);
      }
      if (prediction.jevPredictionActive !== true) {
        problems.push(`prediction ${prediction.observationId}: jevPredictionActive is not true`);
      }
      // §14 staleness accounting must be present and internally consistent.
      if (!prediction.stateAge || !Number.isFinite(prediction.stateAge.receiptAgeAtFreezeMs)) {
        problems.push(`prediction ${prediction.observationId}: receipt staleness was not recorded`);
      } else if (prediction.stateAge.receiptAgeAtFreezeMs > experiment.stalenessPolicy?.maxReceiptStateAgeMs) {
        if (prediction.scorable === true) {
          problems.push(`prediction ${prediction.observationId}: a stale state was scored`);
        }
      }
      if (prediction.sourceEventAt !== null && prediction.stateAge?.sourceAgeAtFreezeMs === null) {
        problems.push(`prediction ${prediction.observationId}: a source timestamp exists but no source age was recorded`);
      }
      if (prediction.sourceEventAt === null && prediction.stateAge?.sourceAgeAtFreezeMs !== null) {
        problems.push(`prediction ${prediction.observationId}: a source age was invented without a source timestamp`);
      }

      const regime = prediction.packet.regime;
      if (regime?.metrics) {
        const recomputed = classifyRegimeFromMetrics(regime.metrics);
        const same = recomputed.regime === regime.regimeName;
        regimeLabelsReproduced.push(same);
        if (!same) problems.push(`prediction ${prediction.observationId}: regime label is not reproducible from the packet metrics`);
      }
    }

    // Timing invariants. `targetAt` is anchored on `stateFrozenAt` (the frozen
    // basis, TARGET_AT_BASIS), NOT on `stateObservedAt`, which is a distinct
    // recorded instant (receipt of the reference observation).
    const stateMs = Date.parse(prediction.stateObservedAt);
    const frozenMs = Date.parse(prediction.stateFrozenAt);
    const startedMs = Date.parse(prediction.predictionStartedAt);
    const completedMs = Date.parse(prediction.predictionCompletedAt);
    const targetMs = Date.parse(prediction.targetAt);
    let timingOk = true;
    if (Number.isFinite(stateMs) && Number.isFinite(frozenMs) && stateMs > frozenMs) {
      timingOk = false;
      problems.push(`prediction ${prediction.observationId}: stateObservedAt is after stateFrozenAt`);
    }
    if (Number.isFinite(stateMs) && Number.isFinite(startedMs) && startedMs < stateMs) {
      timingOk = false;
      problems.push(`prediction ${prediction.observationId}: prediction started before the state was observed`);
    }
    if (Number.isFinite(frozenMs) && Number.isFinite(startedMs) && startedMs < frozenMs) {
      timingOk = false;
      problems.push(`prediction ${prediction.observationId}: prediction started before the state was frozen`);
    }
    if (Number.isFinite(startedMs) && Number.isFinite(completedMs) && completedMs < startedMs) {
      timingOk = false;
      problems.push(`prediction ${prediction.observationId}: prediction completed before it started`);
    }
    if (Number.isFinite(frozenMs) && Number.isFinite(targetMs) && targetMs !== frozenMs + experiment.horizonSeconds * 1_000) {
      timingOk = false;
      problems.push(`prediction ${prediction.observationId}: targetAt is not stateFrozenAt + ${experiment.horizonSeconds}s`);
    }
    if (Number.isFinite(completedMs) && Number.isFinite(targetMs)) {
      if (prediction.scorable === true && completedMs >= targetMs) {
        timingOk = false;
        problems.push(`prediction ${prediction.observationId}: a scorable prediction completed at/after targetAt`);
      }
      if (prediction.invalidReason === "late_prediction" && completedMs < targetMs) {
        timingOk = false;
        problems.push(`prediction ${prediction.observationId}: marked late but completed before targetAt`);
      }
    }
    timingInvariants.push(timingOk);

    if (prediction.provider !== experiment.provider || prediction.model !== experiment.model) {
      problems.push(`prediction ${prediction.observationId}: provider/model pins differ from the experiment`);
    }
    if (prediction.gatewayUsed !== false) {
      problems.push(`prediction ${prediction.observationId}: gatewayUsed is not false`);
    }
    if (prediction.evidenceClass !== DIRECTION_EVIDENCE_CLASS || prediction.developmentOnly !== true) {
      problems.push(`prediction ${prediction.observationId}: development evidence class/flags are wrong`);
    }
    for (const key of ["minConfidence", "minconfidence", "confidenceThreshold", "threshold"]) {
      if (Object.hasOwn(prediction, key) || (prediction.baselines && Object.hasOwn(prediction.baselines, key))) {
        problems.push(`prediction ${prediction.observationId}: forbidden confidence-threshold field '${key}'`);
      }
    }
  }

  const predictionsById = new Map(bundle.predictions.map((entry) => [entry.observationId, entry]));
  for (const outcome of bundle.outcomes) {
    const prediction = predictionsById.get(outcome.observationId) ?? null;
    const reproduced = outcomeDigestOf(outcome) === outcome.outcomeDigest;
    outcomeDigestsReproduced.push(reproduced);
    if (!reproduced) problems.push(`outcome ${outcome.observationId}: digest does not recompute from the artifact body`);

    if (!prediction) {
      problems.push(`outcome ${outcome.observationId}: has no prediction artifact`);
      continue;
    }
    if (outcome.tamperDetected !== true) {
      if (outcome.verifiedPredictionDigest !== prediction.predictionDigest) {
        problems.push(`outcome ${outcome.observationId}: did not verify the stored prediction digest`);
      }
      if (outcome.predictionDigestMatches !== true) {
        problems.push(`outcome ${outcome.observationId}: predictionDigestMatches is not true`);
      }
    }

    const targetMs = Date.parse(outcome.targetAt);
    const observedMs = Date.parse(outcome.outcomeObservedAt);
    const receivedMs = Date.parse(outcome.outcomeReceivedAt);
    if (Number.isFinite(observedMs) && Number.isFinite(targetMs) && observedMs < targetMs) {
      problems.push(`outcome ${outcome.observationId}: outcome artifact finalized before targetAt`);
    }
    if (Number.isFinite(receivedMs) && Number.isFinite(targetMs)) {
      if (receivedMs < targetMs) problems.push(`outcome ${outcome.observationId}: outcome observation precedes targetAt`);
      // The lag is defined on the RECEIVED observation, never on our own
      // artifact-writing instant and never on `stateObservedAt`.
      if (Number.isFinite(outcome.resolutionLagMs) && outcome.resolutionLagMs !== receivedMs - targetMs) {
        problems.push(`outcome ${outcome.observationId}: resolutionLagMs does not equal outcomeReceivedAt - targetAt`);
      }
      if (Number.isFinite(outcome.outcomeOffsetMs) && outcome.outcomeOffsetMs !== receivedMs - targetMs) {
        problems.push(`outcome ${outcome.observationId}: outcomeOffsetMs does not equal outcomeReceivedAt - targetAt`);
      }
      if (outcome.scorable === true && Number.isFinite(outcome.resolutionLagMs) && outcome.resolutionLagMs > outcomePolicyOf(experiment).maximumOffsetMs) {
        problems.push(`outcome ${outcome.observationId}: scored beyond the frozen resolution tolerance`);
      }
      if (Number.isFinite(outcome.achievedHorizonMs) && Number.isFinite(Date.parse(outcome.stateObservedAt))) {
        if (outcome.achievedHorizonMs !== receivedMs - Date.parse(outcome.stateObservedAt)) {
          problems.push(`outcome ${outcome.observationId}: achievedHorizonMs does not equal outcomeReceivedAt - stateObservedAt`);
        }
      }
    }
    if (outcome.predictionBeforeTarget === false) {
      problems.push(`outcome ${outcome.observationId}: prediction did not complete before targetAt`);
    }
    if (outcome.predictionFinalizedBeforeResolution === false) {
      problems.push(`outcome ${outcome.observationId}: the prediction was not finalized before resolution began`);
    }

    // ---- explicit timestamp causality chain ---------------------------------
    // Evaluated on the JOINED view (prediction + outcome), because the chain
    // spans the freeze, the model call and the resolution. A relationship whose
    // fields are unavailable (`null`) is skipped rather than assumed satisfied.
    const chain = { ...prediction, ...outcome };
    for (const check of TIMESTAMP_CAUSAL_CHECKS) {
      const rawLeft = chain[check.left];
      const rawRight = chain[check.right];
      if (rawLeft === null || rawLeft === undefined || rawRight === null || rawRight === undefined) continue;
      const leftMs = Date.parse(rawLeft);
      const rightMs = Date.parse(rawRight);
      if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs)) continue;
      const satisfied = check.op === "<" ? leftMs < rightMs : leftMs <= rightMs;
      if (!satisfied) problems.push(`outcome ${outcome.observationId}: timestamp causality violated (${check.label})`);
    }

    // Outcome label consistency with the two recorded prices.
    const { currentReferencePrice: current, futureReferencePrice: future, actualOutcome } = outcome;
    if (actualOutcome !== null && Number.isFinite(current) && Number.isFinite(future)) {
      const expectedLabel = future > current ? "HIGHER" : future < current ? "LOWER" : "TIE";
      if (expectedLabel !== actualOutcome) {
        problems.push(`outcome ${outcome.observationId}: label ${actualOutcome} contradicts the recorded prices`);
      }
    }
    if (actualOutcome === "TIE" && outcome.scorable === true) {
      problems.push(`outcome ${outcome.observationId}: a TIE was scored as binary`);
    }
    if (outcome.scorable === true && prediction.scorable !== true) {
      problems.push(`outcome ${outcome.observationId}: scored an unscorable prediction`);
    }
  }

  for (const prediction of bundle.predictions) {
    const outcome = bundle.outcomes.find((entry) => entry.observationId === prediction.observationId) ?? null;
    if (prediction.scorable === true && outcome === null) {
      problems.push(`prediction ${prediction.observationId}: scorable prediction has no outcome`);
    }
    if (prediction.scorable !== true && outcome !== null) {
      problems.push(`prediction ${prediction.observationId}: an invalid prediction was resolved as an outcome`);
    }
  }

  // ---- experiment pins: the frozen contract must be internally consistent -----
  const pins = verifyDirectionPins(experiment, {
    provider: experiment.provider,
    model: experiment.model,
    offlineFixture: experiment.offlineFixture === true,
    observationEndpoints: experiment.observationEndpoints ?? null,
    gatewayUsed: experiment.gatewayUsed === true,
    mode: experiment.mode ?? "shadow",
    horizonSeconds: experiment.horizonSeconds,
    resolutionToleranceMs: experiment.resolutionToleranceMs,
    samplingCadenceMs: experiment.samplingCadenceMs,
    maxObservations: experiment.maxObservations,
    questionSetId: experiment.questionSetId,
    questionSetVersion: experiment.questionSetVersion,
    questionDigest: experiment.questionDigest,
    packetKind: experiment.packetKind,
    packetVersion: experiment.packetVersion,
    featureDefinitionVersion: experiment.featureDefinitionVersion,
    featureDefinitionDigest: experiment.featureDefinitionDigest,
    baselineDefinitionVersion: experiment.baselineDefinitionVersion,
    baselineDefinitionDigest: experiment.baselineDefinitionDigest,
    metricDefinitionVersion: experiment.metricDefinitionVersion,
    metricDefinitionDigest: experiment.metricDefinitionDigest,
    referencePriceDefinitionVersion: experiment.referencePriceDefinitionVersion,
    referencePriceDefinitionDigest: experiment.referencePriceDefinitionDigest,
    stalenessPolicyDigest: experiment.stalenessPolicyDigest,
    outcomeResolutionPolicyDigest: experiment.outcomeResolutionPolicyDigest,
    outcomeResolutionPolicyVersion: experiment.outcomeResolutionPolicyVersion,
    unavailableFeatureFamiliesDigest: experiment.unavailableFeatureFamiliesDigest,
    market: experiment.market,
  });
  if (!pins.ok) problems.push(...pins.problems);
  if (experiment.referencePriceDefinitionDigest !== REFERENCE_PRICE_DEFINITION_DIGEST) {
    problems.push("experiment does not pin the current reference-price definition digest");
  }
  if (experiment.stalenessPolicyDigest !== STALENESS_POLICY_DIGEST) {
    problems.push("experiment does not pin the current staleness-policy digest");
  }
  // ---- version-aware policy/definition integrity ---------------------------
  // An old experiment is verified against the FROZEN definition it pinned, not
  // against today's default: replaying v1 must succeed with v1 semantics.
  const outcomePolicy = outcomePolicyOf(experiment);
  if (outcomeResolutionPolicyFor(experiment.outcomeResolutionPolicy?.version) === null) {
    problems.push(`experiment pins an unknown outcome-resolution policy version ${JSON.stringify(experiment.outcomeResolutionPolicy?.version ?? null)}`);
  }
  if (experiment.outcomeResolutionPolicyDigest !== outcomeResolutionPolicyDigestFor(outcomePolicy.version)) {
    problems.push("experiment does not pin the frozen outcome-resolution-policy digest for its own version");
  }
  if (digestOf(experiment.outcomeResolutionPolicy ?? null) !== experiment.outcomeResolutionPolicyDigest) {
    problems.push("experiment outcome-resolution policy object does not match its pinned digest");
  }
  const metricDefinitionVersion = experiment.metricDefinitionVersion ?? DIRECTION_METRICS_VERSION;
  if (metricDefinitionForVersion(metricDefinitionVersion) === null) {
    problems.push(`experiment pins an unknown metric-definition version ${JSON.stringify(metricDefinitionVersion)}`);
  }
  if (experiment.metricDefinitionDigest !== metricDefinitionDigestForVersion(metricDefinitionVersion)) {
    problems.push("experiment does not pin the frozen metric-definition digest for its own version");
  }

  // ---- canonical provider/model/transport enforcement -----------------------
  if (experiment.offlineFixture !== true) {
    if (experiment.provider !== REQUIRED_PROVIDER) problems.push(`experiment provider '${experiment.provider}' is not ${REQUIRED_PROVIDER}`);
    if (experiment.model !== REQUIRED_MODEL) problems.push(`experiment model '${experiment.model}' is not ${REQUIRED_MODEL}`);
    if (experiment.gatewayUsed !== false) problems.push("experiment was not produced on the direct (non-gateway) route");
    for (const forbidden of FORBIDDEN_CANONICAL_PROVIDERS) {
      if (experiment.provider === forbidden) problems.push(`experiment used the forbidden canonical provider '${forbidden}'`);
    }
  }
  if (experiment.gatewayUsed !== false) problems.push("gatewayUsed is true: canonical 5I evidence must use the direct route");
  if (experiment.evidenceClass !== DIRECTION_EVIDENCE_CLASS) problems.push("experiment evidence class is not the 5I development class");
  for (const flag of [
    "developmentOnly",
    "noProfitabilityInference",
    "noTradingInference",
    "noDeploymentInference",
  ]) {
    if (experiment[flag] !== true) problems.push(`experiment development flag '${flag}' is not true`);
  }
  if (experiment.noGroundTruthBeyondObservedFutureOutcome !== true) {
    problems.push("experiment does not declare noGroundTruthBeyondObservedFutureOutcome");
  }
  if (experiment.paperOnly !== true || experiment.shadowOnly !== true) {
    problems.push("experiment does not declare paperOnly + shadowOnly");
  }

  // ---- granularity guard over the frozen feature vocabulary ----------------
  const vocabularyAudit = auditGranularityNames(
    bundle.predictions.flatMap((prediction) => Object.keys(prediction.featureValues ?? {})),
  );
  granularityAudits.push(vocabularyAudit.ok);
  for (const violation of vocabularyAudit.violations) {
    problems.push(`frozen feature vocabulary names unsupported ${violation.kind} '${violation.detail}'`);
  }

  // ---- offline LOOKAHEAD + recursive/startup stability audits ---------------
  // Bounded and behavioural: future observations are appended to a stored
  // pre-outcome projection and the historical value is RECOMPUTED, so this is a
  // real leakage test rather than a source-code scan. It writes nothing.
  const offlineAudits = collectOfflineAuditInputs(bundle.predictions);
  const lookahead = offlineAudits.lookahead;
  if (!lookahead.ok) {
    problems.push(`lookahead audit FAILED: ${lookahead.features.violations.length} feature and ${lookahead.baselines.violations.length} baseline violation(s)`);
  }
  if (!lookahead.storedStateConsistency.ok) {
    problems.push(`stored-state consistency FAILED: ${lookahead.storedStateConsistency.problems.length} problem(s)`);
  }
  const featureStability = offlineAudits.featureStability;

  if (bundle.summary) {
    const profitability = auditNoProfitabilityFields(bundle.summary);
    if (!profitability.ok) problems.push(`summary contains profitability-shaped fields: ${profitability.problems.join("; ")}`);
    if (bundle.summary.evidenceScope !== "DEVELOPMENT") problems.push("summary evidenceScope is not DEVELOPMENT");
    if (bundle.summary.replicationStatus !== "NOT_REPLICATED") problems.push("summary claims a replication status it cannot have");
    if (bundle.summary.noConfidenceThreshold !== true) problems.push("summary does not declare the absence of a confidence threshold");
    if (bundle.summary.winner !== null || bundle.summary.noAutomatedWinner !== true) {
      problems.push("summary emits a winner label");
    }
    for (const flag of ["jevTradingRoutingActive", "arenaRoutingActive", "deepseekRoutingActive", "classifierRoutingActive", "agentReachRoutingActive", "tradingRoutingActive"]) {
      if (bundle.summary[flag] !== false) problems.push(`summary routing flag '${flag}' is not false`);
    }
  }

  const recomputedMetrics = evaluateDirectionExperiment({
    experiment,
    predictions: bundle.predictions,
    outcomes: bundle.outcomes,
    featureStability,
    lookaheadAudit: {
      ok: lookahead.ok,
      featureViolations: lookahead.features.violations.length,
      baselineViolations: lookahead.baselines.violations.length,
    },
    metricDefinitionVersion,
  });
  const recomputedMetricsDigest = metricsDigestOf(recomputedMetrics);
  const storedMetricsDigest = bundle.summary?.metricsDigest ?? null;
  const metricsMatch = storedMetricsDigest !== null && storedMetricsDigest === recomputedMetricsDigest;
  if (bundle.summary && !metricsMatch) {
    problems.push("summary metricsDigest does not reproduce from the artifacts");
  }

  return {
    schemaVersion: DIRECTION_SCHEMA_VERSION,
    phase: DIRECTION_PHASE,
    replayVersion: DIRECTION_RUNNER_VERSION,
    experimentId,
    root,
    ok: problems.length === 0,
    problems,
    readOnly: true,
    networkCalls: 0,
    providerCalls: 0,
    evidenceClass: experiment.evidenceClass,
    provider: experiment.provider,
    model: experiment.model,
    gatewayUsed: experiment.gatewayUsed === true,
    horizonSeconds: experiment.horizonSeconds,
    // The policy the experiment was FROZEN with, so a replay proves which bound
    // it applied — an old v1 experiment still reports 5000 ms.
    outcomeResolutionPolicyVersion: experiment.outcomeResolutionPolicyVersion ?? experiment.outcomeResolutionPolicy?.version ?? null,
    maximumOffsetMs: outcomePolicy.maximumOffsetMs,
    metricDefinitionVersion,
    counts: {
      predictions: bundle.predictions.length,
      outcomes: bundle.outcomes.length,
      scorablePredictions: bundle.predictions.filter((entry) => entry.scorable === true).length,
      scoredCount: bundle.outcomes.filter((entry) => entry.scorable === true).length,
      outcomeWindowExclusions: bundle.outcomes.filter((entry) => entry.invalidReason === OUTCOME_UNAVAILABLE_REASON).length,
      invalidPredictions: bundle.predictions.filter((entry) => entry.invalid === true).length,
      failedJevObservations: bundle.predictions.filter((entry) => entry.status !== "JEV_OK").length,
      tamperDetected: bundle.outcomes.filter((entry) => entry.tamperDetected === true).length,
    },
    checks: {
      predictionDigestsReproduced: predictionDigestsReproduced.every(Boolean),
      packetDigestsReproduced: packetDigestsReproduced.every(Boolean),
      baselinesReproduced: baselinesReproduced.every(Boolean),
      featuresReproduced: featuresReproduced.every(Boolean),
      inputDigestsReproduced: inputDigestsReproduced.every(Boolean),
      probabilityPairsValid: probabilityPairsAudited.every(Boolean),
      regimeLabelsReproduced: regimeLabelsReproduced.every(Boolean),
      timingInvariantsOk: timingInvariants.every(Boolean),
      outcomeDigestsReproduced: outcomeDigestsReproduced.every(Boolean),
      metricsReproduced: metricsMatch,
      pinsConsistent: pins.ok,
      granularityGuardOk: granularityAudits.every(Boolean),
      lookaheadClean: lookahead.ok,
      sameStateFairness: lookahead.storedStateConsistency.ok,
    },
    lookaheadAudit:
      Object.freeze({
        ok: lookahead.ok,
        featureViolations: lookahead.features.violations.length,
        baselineViolations: lookahead.baselines.violations.length,
        recomputationPairs: lookahead.features.recomputationPairs,
      }),
    featureStability: Object.freeze({
      testedObservations: featureStability.testedObservations,
      tolerance: featureStability.tolerance,
      unstableFeatureCount: Object.values(featureStability.diagnostics ?? {}).filter((entry) => entry.stableWithinTolerance !== true).length,
    }),
    storedMetricsDigest,
    recomputedMetricsDigest,
    metricsMatch,
    recomputedMetrics,
    summaryPresent: bundle.summary !== null,
    networkCalls: 0,
    jevCalls: 0,
    agentReachCalls: 0,
    classifierCalls: 0,
    deepseekCalls: 0,
    arenaRuns: 0,
    tradingCalls: 0,
  };
}

/* ============================================================================
 * Stats (READ ONLY)
 * ==========================================================================*/

/** Compute the metric report for one experiment. Reads artifacts only. */
export async function directionStats({ experimentId, baseRoot = null }) {
  const root = directionExperimentRootFor(baseRoot, experimentId);
  const bundle = await readDirectionExperimentBundle(root);
  if (!bundle.experiment) {
    return { ok: false, error: `no Phase 5I experiment at ${root}`, experimentId, root };
  }
  // Stats recompute the metrics the SAME way finalize and replay do, so
  // `metricsMatch` is a genuine reproducibility check of the stored summary.
  const offlineAudits = collectOfflineAuditInputs(bundle.predictions);
  const metrics = evaluateDirectionExperiment({
    experiment: bundle.experiment,
    predictions: bundle.predictions,
    outcomes: bundle.outcomes,
    featureStability: offlineAudits.featureStability,
    lookaheadAudit: offlineAudits.lookaheadAudit,
    metricDefinitionVersion: bundle.experiment.metricDefinitionVersion ?? DIRECTION_METRICS_VERSION,
  });
  const metricsDigest = metricsDigestOf(metrics);
  return {
    ok: true,
    experimentId,
    root,
    experiment: bundle.experiment,
    summary: bundle.summary,
    metrics,
    metricsDigest,
    storedMetricsDigest: bundle.summary?.metricsDigest ?? null,
    metricsMatch: bundle.summary ? bundle.summary.metricsDigest === metricsDigest : null,
    readOnly: true,
  };
}
