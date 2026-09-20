/**
 * Phase 5I.1 — THE FROZEN REPLICATION PROTOCOL CONTRACT.
 *
 * Phase 5I.1 answers exactly ONE question, frozen here before any replication
 * session exists:
 *
 *   "Does the exact Phase 5I.0b direct-TypeSafe Jev directional protocol
 *    reproduce its predictive behavior on multiple fresh, unseen SOL/USDC market
 *    sessions?"
 *
 * The protocol is LOCKED. 5I.1 is replication, not development. Nothing in this
 * module can be tuned from the Phase 5I.0b results, and nothing in it may drift
 * between replication sessions.
 *
 * ONE DETERMINISTIC DIGEST (`REPLICATION_PROTOCOL_DIGEST`) covers every
 * predictive semantic. It is derived from the FROZEN SOURCE CONSTANTS — not from
 * an experiment artifact, and never from a timestamp or a session id — and
 * `protocolContractFromExperiment()` must reproduce that same digest for BOTH
 * the canonical development experiment and every replication session.
 *
 * Any mismatch is FAIL CLOSED. There is no "compatible enough".
 *
 * INCLUDED IN THE CONTRACT (the complete predictive semantics):
 *   market + mints + quote convention + reference-price definition/digest;
 *   horizon + target basis; cadence; observations per session;
 *   provider / upstream provider / model / gateway flag / shadow mode;
 *   question set id + version + digest + packet kind + packet version;
 *   feature-definition version + digest;
 *   baseline-definition version + digest;
 *   metric-definition version + digest;
 *   outcome-resolution policy version + digest + bound + selection rule;
 *   staleness policy version + digest + both cutoffs;
 *   probability semantics; and the no-threshold rule.
 *
 * EXCLUDED (deliberately): every timestamp, every session/experiment id, every
 * file path, and the observation-endpoint order (environment configuration that
 * selects WHICH markets are observed — the feature and packet digests already
 * pin the transform applied to whatever is observed).
 *
 * PAPER ONLY / NO TRADING. No wallet, no signing, no swap, no order, no Arena
 * routing, no DeepSeek routing, no external-agent routing of any kind, and no
 * confidence threshold.
 */

import path from "node:path";

import { digestOf } from "../../../lib/hash.mjs";
import { BASELINE_DEFINITION_DIGEST, BASELINE_DEFINITION_VERSION } from "../baselines.mjs";
import {
  BENCHMARK_MARKET,
  DEFAULT_CADENCE_SECONDS,
  DEFAULT_MAX_OBSERVATIONS,
  DEFAULT_OUTCOME_RESOLUTION_POLICY,
  DIRECTION_ROOT_DIR,
  HORIZON_SECONDS,
  REFERENCE_PRICE_DEFINITION_DIGEST,
  REFERENCE_PRICE_DEFINITION_VERSION,
  REQUIRED_GATEWAY_USED,
  REQUIRED_MODEL,
  REQUIRED_PROVIDER,
  REQUIRED_UPSTREAM_PROVIDER,
  STALENESS_POLICY,
  STALENESS_POLICY_DIGEST,
  TARGET_AT_BASIS,
} from "../definition.mjs";
import { DIRECTION_FEATURE_DEFINITION_DIGEST, DIRECTION_FEATURE_DEFINITION_VERSION } from "../features.mjs";
import {
  ACCURACY_DECISION_RULE,
  CALIBRATION_BIN_COUNT,
  DIRECTION_METRIC_DEFINITION_DIGEST,
  DIRECTION_METRICS_VERSION,
} from "../metrics.mjs";
import { DIRECTION_PACKET_KIND, DIRECTION_PACKET_VERSION } from "../packet.mjs";
import {
  DIRECTION_QUESTION_SET_ID,
  DIRECTION_QUESTION_SET_VERSION,
  directionQuestionDigest,
} from "../questions.mjs";

export const REPLICATION_PROTOCOL_VERSION = 1;

/** The replication tree, a sibling of the development experiments tree. */
export const DIRECTION_REPLICATION_ROOT_DIR = path.join(DIRECTION_ROOT_DIR, "replication");
export const REPLICATION_MANIFEST_FILE = "replication.json";
export const REPLICATION_SESSIONS_FILE = "sessions.json";
export const REPLICATION_SUMMARY_FILE = "summary.json";

/* ============================================================================
 * §5 the frozen replication settings (exact 5I.0b protocol values)
 * ==========================================================================*/

/** Observations per canonical session. A replication session is exactly this. */
export const REPLICATION_SESSION_OBSERVATIONS = DEFAULT_MAX_OBSERVATIONS;
/** Sampling cadence, in seconds. */
export const REPLICATION_SESSION_CADENCE_SECONDS = DEFAULT_CADENCE_SECONDS;
/** How many CLEAN, independent sessions the wave is designed around (§8). */
export const REQUIRED_CLEAN_REPLICATION_SESSIONS = 3;
/** §8: the PRIMARY inference unit is the dataset/session, never the observation. */
export const REPLICATION_INFERENCE_UNIT = "dataset/session";

/* ============================================================================
 * §10 the protocol contract
 * ==========================================================================*/

/**
 * Build the contract from the FROZEN SOURCE CONSTANTS. This is the authority:
 * the digest below is derived from expressible semantic values only, so it can
 * never depend on a timestamp, a session id, or a file on disk.
 */
export function protocolContractFromSource() {
  return {
    protocolVersion: REPLICATION_PROTOCOL_VERSION,
    market: {
      marketId: BENCHMARK_MARKET.marketId,
      baseMint: BENCHMARK_MARKET.baseMint,
      quoteMint: BENCHMARK_MARKET.quoteMint,
      quoteConvention: BENCHMARK_MARKET.quoteConvention,
      referencePriceSource: BENCHMARK_MARKET.referencePriceSource,
    },
    referencePrice: {
      definitionVersion: REFERENCE_PRICE_DEFINITION_VERSION,
      definitionDigest: REFERENCE_PRICE_DEFINITION_DIGEST,
    },
    horizon: {
      horizonSeconds: HORIZON_SECONDS,
      targetAtBasis: TARGET_AT_BASIS,
    },
    timing: {
      resolutionToleranceMs: DEFAULT_OUTCOME_RESOLUTION_POLICY.maximumOffsetMs,
      outcomeOffsetField: DEFAULT_OUTCOME_RESOLUTION_POLICY.offsetField,
      predictionMustCompleteBeforeTarget: true,
      predictionIsNeverRewritten: true,
    },
    cadence: {
      samplingCadenceMs: REPLICATION_SESSION_CADENCE_SECONDS * 1_000,
    },
    observationsPerSession: REPLICATION_SESSION_OBSERVATIONS,
    forecaster: {
      provider: REQUIRED_PROVIDER,
      upstreamProvider: REQUIRED_UPSTREAM_PROVIDER,
      model: REQUIRED_MODEL,
      gatewayUsed: REQUIRED_GATEWAY_USED,
      mode: "shadow",
    },
    questions: {
      questionSetId: DIRECTION_QUESTION_SET_ID,
      questionSetVersion: DIRECTION_QUESTION_SET_VERSION,
      questionDigest: directionQuestionDigest(),
      packetKind: DIRECTION_PACKET_KIND,
      packetVersion: DIRECTION_PACKET_VERSION,
    },
    features: {
      definitionVersion: DIRECTION_FEATURE_DEFINITION_VERSION,
      definitionDigest: DIRECTION_FEATURE_DEFINITION_DIGEST,
    },
    baselines: {
      definitionVersion: BASELINE_DEFINITION_VERSION,
      definitionDigest: BASELINE_DEFINITION_DIGEST,
    },
    metrics: {
      definitionVersion: DIRECTION_METRICS_VERSION,
      definitionDigest: DIRECTION_METRIC_DEFINITION_DIGEST,
    },
    outcomeResolution: {
      policyVersion: DEFAULT_OUTCOME_RESOLUTION_POLICY.version,
      policyDigest: digestOf(DEFAULT_OUTCOME_RESOLUTION_POLICY),
      maximumOffsetMs: DEFAULT_OUTCOME_RESOLUTION_POLICY.maximumOffsetMs,
      selectionRule: DEFAULT_OUTCOME_RESOLUTION_POLICY.selectionRule,
      offsetField: DEFAULT_OUTCOME_RESOLUTION_POLICY.offsetField,
      neverMovesTargetAt: DEFAULT_OUTCOME_RESOLUTION_POLICY.neverMovesTargetAt,
      neverSubstitutesALaterScheduledObservationForAFailedOne:
        DEFAULT_OUTCOME_RESOLUTION_POLICY.neverSubstitutesALaterScheduledObservationForAFailedOne,
    },
    staleness: {
      policyVersion: STALENESS_POLICY.version,
      policyDigest: STALENESS_POLICY_DIGEST,
      maxReceiptStateAgeMs: STALENESS_POLICY.maxReceiptStateAgeMs,
      maxSourceStateAgeMs: STALENESS_POLICY.maxSourceStateAgeMs,
    },
    probabilitySemantics: {
      target: "P(referencePrice(targetAt) > referencePrice(stateFrozenAt))",
      field: "pHigher",
      retainedRaw: true,
      neverSnappedToNeutral: true,
      decisionRule: ACCURACY_DECISION_RULE,
      tiePolicy: "retained and counted, excluded from binary scoring",
      calibrationAppliedAtScoringTime: false,
    },
    noThresholdRule: {
      thresholdApplied: false,
      everyValidProbabilityRetained: true,
      thresholdBound: null,
    },
  };
}

/** THE deterministic protocol digest. No timestamps, no session ids, ever. */
export const REPLICATION_PROTOCOL_CONTRACT = Object.freeze(protocolContractFromSource());
export const REPLICATION_PROTOCOL_DIGEST = digestOf(REPLICATION_PROTOCOL_CONTRACT);

/**
 * Rebuild the SAME contract from a stored experiment artifact. Every field is
 * read from semantic pins the experiment already carries — never from its id,
 * its timestamps, or any file path — so a development experiment and a
 * replication session must produce the identical digest.
 *
 * Returns `null` when the experiment is missing the pins needed to express the
 * contract at all: an unresolvable contract is FAIL CLOSED, never a pass.
 */
export function protocolContractFromExperiment(experiment) {
  if (!experiment || typeof experiment !== "object") return null;
  const market = experiment.market ?? null;
  const policy = experiment.outcomeResolutionPolicy ?? null;
  const staleness = experiment.stalenessPolicy ?? null;
  if (market === null || policy === null) return null;
  return {
    protocolVersion: REPLICATION_PROTOCOL_VERSION,
    market: {
      marketId: market.marketId ?? null,
      baseMint: market.baseMint ?? null,
      quoteMint: market.quoteMint ?? null,
      quoteConvention: market.quoteConvention ?? null,
      referencePriceSource: market.referencePriceSource ?? null,
    },
    referencePrice: {
      definitionVersion: experiment.referencePriceDefinitionVersion ?? null,
      definitionDigest: experiment.referencePriceDefinitionDigest ?? null,
    },
    horizon: {
      horizonSeconds: experiment.horizonSeconds ?? null,
      targetAtBasis: TARGET_AT_BASIS,
    },
    timing: {
      resolutionToleranceMs: policy.maximumOffsetMs ?? null,
      outcomeOffsetField: policy.offsetField ?? null,
      predictionMustCompleteBeforeTarget: true,
      predictionIsNeverRewritten: true,
    },
    cadence: {
      samplingCadenceMs: experiment.samplingCadenceMs ?? null,
    },
    observationsPerSession: experiment.maxObservations ?? null,
    forecaster: {
      provider: experiment.provider ?? null,
      upstreamProvider: experiment.upstreamProvider ?? null,
      model: experiment.model ?? null,
      gatewayUsed: experiment.gatewayUsed === true,
      mode: experiment.mode ?? null,
    },
    questions: {
      questionSetId: experiment.questionSetId ?? null,
      questionSetVersion: experiment.questionSetVersion ?? null,
      questionDigest: experiment.questionDigest ?? null,
      packetKind: experiment.packetKind ?? null,
      packetVersion: experiment.packetVersion ?? null,
    },
    features: {
      definitionVersion: experiment.featureDefinitionVersion ?? null,
      definitionDigest: experiment.featureDefinitionDigest ?? null,
    },
    baselines: {
      definitionVersion: experiment.baselineDefinitionVersion ?? null,
      definitionDigest: experiment.baselineDefinitionDigest ?? null,
    },
    metrics: {
      definitionVersion: experiment.metricDefinitionVersion ?? null,
      definitionDigest: experiment.metricDefinitionDigest ?? null,
    },
    outcomeResolution: {
      policyVersion: policy.version ?? null,
      policyDigest: experiment.outcomeResolutionPolicyDigest ?? null,
      maximumOffsetMs: policy.maximumOffsetMs ?? null,
      selectionRule: policy.selectionRule ?? null,
      offsetField: policy.offsetField ?? null,
      neverMovesTargetAt: policy.neverMovesTargetAt ?? null,
      neverSubstitutesALaterScheduledObservationForAFailedOne:
        policy.neverSubstitutesALaterScheduledObservationForAFailedOne ?? null,
    },
    staleness: {
      policyVersion: staleness?.version ?? null,
      policyDigest: experiment.stalenessPolicyDigest ?? null,
      maxReceiptStateAgeMs: staleness?.maxReceiptStateAgeMs ?? null,
      maxSourceStateAgeMs: staleness?.maxSourceStateAgeMs ?? null,
    },
    probabilitySemantics: {
      target: "P(referencePrice(targetAt) > referencePrice(stateFrozenAt))",
      field: "pHigher",
      retainedRaw: true,
      neverSnappedToNeutral: true,
      decisionRule: ACCURACY_DECISION_RULE,
      tiePolicy: "retained and counted, excluded from binary scoring",
      calibrationAppliedAtScoringTime: false,
    },
    noThresholdRule: {
      thresholdApplied: false,
      everyValidProbabilityRetained: true,
      thresholdBound: null,
    },
  };
}

/** Digest the contract a stored experiment expresses, or `null`. */
export function protocolDigestOfExperiment(experiment) {
  const contract = protocolContractFromExperiment(experiment);
  return contract === null ? null : digestOf(contract);
}

/** Every leaf path whose value differs between the frozen contract and an experiment. */
export function protocolContractDifferences(experiment) {
  const actual = protocolContractFromExperiment(experiment);
  if (actual === null) return [{ path: "<contract>", expected: "resolvable", actual: null }];
  const differences = [];
  const walk = (expected, seen, prefix) => {
    if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
      for (const [key, value] of Object.entries(expected)) {
        walk(value, seen?.[key], prefix === "" ? key : `${prefix}.${key}`);
      }
      return;
    }
    if (digestOf(expected ?? null) !== digestOf(seen ?? null)) {
      differences.push({ path: prefix, expected: expected ?? null, actual: seen ?? null });
    }
  };
  walk(REPLICATION_PROTOCOL_CONTRACT, actual, "");
  return differences;
}

/**
 * §5/§11 FAIL-CLOSED protocol verification for ONE session experiment. Returns
 * `{ ok, digest, expectedDigest, differences }` — never throws, never repairs.
 */
export function verifyReplicationProtocol(experiment) {
  const digest = protocolDigestOfExperiment(experiment);
  const differences = protocolContractDifferences(experiment);
  return {
    ok: digest === REPLICATION_PROTOCOL_DIGEST && differences.length === 0,
    digest,
    expectedDigest: REPLICATION_PROTOCOL_DIGEST,
    differences,
  };
}

/* ============================================================================
 * §9/§15 THE SOURCE GUARD — nothing replication-related may drift
 *
 * This is a set of STATIC expectations over the frozen definitions the protocol
 * is built from. It exists so a future edit that changes question wording,
 * feature formulas, horizon, outcome tolerance, baseline coefficients, staleness
 * cutoffs, calibration bins, metric formulas, the confidence threshold or the
 * provider/model CANNOT pass as a replication-only change: it changes the
 * protocol digest and trips this guard, and it therefore requires a NEW
 * development phase rather than a Phase 5I.1 edit.
 * ==========================================================================*/

export const REPLICATION_SOURCE_GUARD = Object.freeze({
  phase: "5I.0b",
  market: "SOL-USDC",
  baseMint: "So11111111111111111111111111111111111111112",
  quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  provider: REQUIRED_PROVIDER,
  model: REQUIRED_MODEL,
  gatewayUsed: false,
  mode: "shadow",
  horizonSeconds: 30,
  cadenceSeconds: 30,
  observationsPerSession: 120,
  resolutionToleranceMs: 10_000,
  questionSetId: "jev-microstructure-direction-v1",
  questionSetVersion: 1,
  featureDefinitionVersion: 1,
  baselineDefinitionVersion: 1,
  metricDefinitionVersion: 2,
  outcomeResolutionPolicyVersion: 2,
  maxReceiptStateAgeMs: 15_000,
  maxSourceStateAgeMs: 900_000,
  calibrationBinCount: 10,
  thresholdBound: null,
});

/**
 * Compare the LIVE frozen constants against the static source guard. Any
 * difference means the predictive protocol changed and Phase 5I.1 must not
 * silently absorb it.
 *
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function verifyReplicationSourceGuard() {
  const problems = [];
  const guard = REPLICATION_SOURCE_GUARD;
  const expect = (label, actual, expected) => {
    if (digestOf(actual ?? null) !== digestOf(expected ?? null)) {
      problems.push(`${label} changed: ${JSON.stringify(actual ?? null)} != ${JSON.stringify(expected ?? null)}`);
    }
  };
  expect("market", BENCHMARK_MARKET.marketId, guard.market);
  expect("base mint", BENCHMARK_MARKET.baseMint, guard.baseMint);
  expect("quote mint", BENCHMARK_MARKET.quoteMint, guard.quoteMint);
  expect("provider", REQUIRED_PROVIDER, guard.provider);
  expect("model", REQUIRED_MODEL, guard.model);
  expect("gatewayUsed", REQUIRED_GATEWAY_USED, guard.gatewayUsed);
  expect("horizon seconds", HORIZON_SECONDS, guard.horizonSeconds);
  expect("cadence seconds", REPLICATION_SESSION_CADENCE_SECONDS, guard.cadenceSeconds);
  expect("observations per session", REPLICATION_SESSION_OBSERVATIONS, guard.observationsPerSession);
  expect("resolution tolerance", DEFAULT_OUTCOME_RESOLUTION_POLICY.maximumOffsetMs, guard.resolutionToleranceMs);
  expect("question set id", DIRECTION_QUESTION_SET_ID, guard.questionSetId);
  expect("question set version", DIRECTION_QUESTION_SET_VERSION, guard.questionSetVersion);
  expect("feature definition version", DIRECTION_FEATURE_DEFINITION_VERSION, guard.featureDefinitionVersion);
  expect("baseline definition version", BASELINE_DEFINITION_VERSION, guard.baselineDefinitionVersion);
  expect("metric definition version", DIRECTION_METRICS_VERSION, guard.metricDefinitionVersion);
  expect("outcome-resolution policy version", DEFAULT_OUTCOME_RESOLUTION_POLICY.version, guard.outcomeResolutionPolicyVersion);
  expect("max receipt state age", STALENESS_POLICY.maxReceiptStateAgeMs, guard.maxReceiptStateAgeMs);
  expect("max source state age", STALENESS_POLICY.maxSourceStateAgeMs, guard.maxSourceStateAgeMs);
  expect("calibration bin count", CALIBRATION_BIN_COUNT, guard.calibrationBinCount);
  expect("threshold bound", null, guard.thresholdBound);
  expect("threshold rule", REPLICATION_PROTOCOL_CONTRACT.noThresholdRule.thresholdApplied, false);
  return { ok: problems.length === 0, problems };
}

/* ============================================================================
 * §12 the five frozen comparisons and the three reported metrics
 * ==========================================================================*/

/** Baseline ids the canonical development result compared against, in order. */
export const REPLICATION_COMPARISON_IDS = Object.freeze([
  "neutral-v1",
  "momentum-v1",
  "mean-reversion-v1",
  "volume-flow-imbalance-v1",
  "momentum-liquidity-v1",
]);

/**
 * SIGN CONVENTION — unchanged from Phase 5I.0b, and asserted by validation so it
 * can never invert:
 *
 *   negative Brier delta    = Jev has a LOWER Brier score than the baseline
 *   negative log-loss delta = Jev has a LOWER log loss than the baseline
 *   accuracy delta is Jev minus baseline (higher is better)
 */
export const REPLICATION_DELTA_SIGN_CONVENTION = Object.freeze({
  brier: "jevMinusBaselineBrier; negative means Jev is LOWER (better)",
  logLoss: "jevMinusBaselineLogLoss; negative means Jev is LOWER (better)",
  accuracy: "jevMinusBaselineAccuracy; positive means Jev is HIGHER (better)",
});

/** The three relative metrics derived per session, per comparison. */
export const REPLICATION_DELTA_METRICS = Object.freeze(["brier", "logLoss", "accuracy"]);

/** Absolute per-session Jev metrics reported alongside the deltas. */
export const REPLICATION_ABSOLUTE_METRICS = Object.freeze(["brier", "logLoss", "accuracy"]);
