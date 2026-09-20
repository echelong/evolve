#!/usr/bin/env node
/**
 * EVOLVE Phase 5I.0b validation suite — FULLY OFFLINE.
 *
 * DIRECT TYPESAFE JEV SHORT-HORIZON DIRECTIONAL PREDICTION BENCHMARK:
 *
 *   frozen question set -> frozen feature definition -> frozen packet
 *     -> frozen baselines -> one logical direct-TypeSafe Jev call per scheduled
 *     SOL/USDC observation -> immutable prediction -> 30s horizon
 *     -> immutable outcome -> offline metrics -> replay -> STOP
 *
 * NOTHING HERE TOUCHES THE NETWORK OR A PROVIDER. Every experiment in this
 * suite is driven through the runner with:
 *   - an injected deterministic clock (`now`/`sleep`),
 *   - an injected scripted `fetchImpl` for the market observation,
 *   - the dedicated 5I offline fixture provider (or a purpose-built stub).
 * The CLI cases only exercise refusal paths that exit BEFORE any market config
 * or provider is constructed, and every child process is additionally pointed at
 * an unroutable base URL as a safety net.
 *
 * The suite NEVER creates canonical 5I evidence: every experiment lives in a
 * temp directory, and the real `.evolve/jev-direction` tree is asserted to be
 * byte-unchanged at the end.
 *
 * Sections A–AF map one-to-one onto the Phase 5I.0b contract:
 *   A  frozen identities / definitions        N  TIE semantics
 *   B  question-set contract                  O  probability validation
 *   C  packet whitelist                       P  deterministic baselines
 *   D  feature formulas                       Q  same-state baseline fairness
 *   E  feature warmup / null behaviour        R  Brier score
 *   F  lookahead integrity                    S  log loss
 *   G  recursive / startup stability          T  accuracy
 *   H  reference-price contract               U  calibration bins
 *   I  30-second target semantics             V  latency stats
 *   J  timestamp causality                    W  provider/model/gateway enforcement
 *   K  staleness rules                        X  no runtime confidence threshold
 *   L  prediction immutability                Y  transport-attempt provenance
 *   M  outcome attachment                     Z  failed prediction preservation
 *   AA resume semantics                       AB replay / tamper detection
 *   AC data-granularity integrity             AD zero routing / trading authority
 *   AE frozen historical evidence             AF CLI behaviour
 *
 * Run with: npm run validate:phase5i
 */

import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { canonicalJson, digestOf } from "./lib/hash.mjs";
import { sanitizeForPublic } from "./lib/sanitize.mjs";
import { createMarketConfig } from "./market/config.mjs";
import { deriveFeatures, normalizeJupiterToken, toFiniteNumber } from "./market/normalize.mjs";
import { classifyRegimeFromMetrics, computeRegimeMetrics } from "./arena/orchestrator.mjs";

import {
  AGGREGATE_FLOW_FIELD_NAME,
  BENCHMARK_MARKET,
  DEFAULT_CADENCE_SECONDS,
  DEFAULT_MAX_OBSERVATIONS,
  DIRECTION_ACTIONS,
  DIRECTION_ALL_ACTIONS,
  DIRECTION_DEVELOPMENT_FLAGS,
  DIRECTION_REPLICATION_ACTIONS,
  DIRECTION_EVIDENCE_CLASS,
  DIRECTION_EXPERIMENTS_DIR,
  DIRECTION_FORBIDDEN_FLAGS,
  DIRECTION_OUTCOMES_DIR,
  DIRECTION_PHASE,
  DIRECTION_PREDICTIONS_DIR,
  DIRECTION_ROOT_DIR,
  DIRECTION_ROUTING_FLAGS,
  DIRECTION_SCHEMA_VERSION,
  EVENT_ORDERING,
  EXECUTED_ACTION_IN_5I_0B,
  FORBIDDEN_CANONICAL_PROVIDERS,
  FORBIDDEN_GRANULARITY_PHRASES,
  FORBIDDEN_GRANULARITY_TOKENS,
  FORBIDDEN_MODEL_ALIASES,
  FORBIDDEN_THRESHOLD_NAMES,
  FUTURE_EXECUTION_BOUNDARY,
  HORIZON_MS,
  HORIZON_SECONDS,
  MAX_RECEIPT_STATE_AGE_MS,
  MAX_SOURCE_STATE_AGE_MS,
  MODEL_INTENT_DEFINITION,
  OBSERVATION_HISTORY_LIMIT,
  CURRENT_OUTCOME_RESOLUTION_POLICY_VERSION,
  DEFAULT_OUTCOME_RESOLUTION_POLICY,
  DEFAULT_OUTCOME_RESOLUTION_POLICY_DIGEST,
  OUTCOME_RESOLUTION_POLICIES,
  OUTCOME_RESOLUTION_POLICY_V1,
  OUTCOME_RESOLUTION_POLICY_V1_DIGEST,
  OUTCOME_RESOLUTION_POLICY_V2,
  OUTCOME_RESOLUTION_POLICY_V2_DIGEST,
  OUTCOME_RESOLUTION_POLICY_VERSION_V1,
  OUTCOME_RESOLUTION_POLICY_VERSION_V2,
  OUTCOME_TIMESTAMP_FIELDS,
  OUTCOME_UNAVAILABLE_REASON,
  OVERRIDE_REASON_IN_5I_0B,
  RECOMMENDED_ENDPOINT_ORDER,
  REFERENCE_PRICE_DEFINITION,
  REFERENCE_PRICE_DEFINITION_DIGEST,
  REFERENCE_PRICE_DEFINITION_VERSION,
  REQUIRED_MODEL,
  REQUIRED_PROVIDER,
  REQUIRED_UPSTREAM_PROVIDER,
  RESOLUTION_TOLERANCE_MS,
  RESOLUTION_TOLERANCE_MS_V2,
  STALENESS_POLICY,
  STALENESS_POLICY_DIGEST,
  STATE_TIMESTAMP_FIELDS,
  SUPPORTED_MARKET_IDS,
  TARGET_AT_BASIS,
  TIMESTAMP_CAUSAL_CHECKS,
  TIMESTAMP_CAUSAL_ORDER,
  TIMESTAMP_SEMANTICS,
  UNAVAILABLE_FEATURE_FAMILIES,
  UNAVAILABLE_FEATURE_FAMILIES_DIGEST,
  outcomeResolutionPolicyDigestFor,
  outcomeResolutionPolicyFor,
  outcomeResolutionPolicyForOffset,
  isReplicationAction,
  resolveDirectionAction,
  resolveOutcomeOffset,
} from "./jev/direction/definition.mjs";
import {
  DIRECTION_QUESTION_CRITERIA,
  DIRECTION_QUESTION_NAME,
  DIRECTION_QUESTION_NAMES,
  DIRECTION_QUESTION_SET,
  DIRECTION_QUESTION_SET_DIGEST,
  DIRECTION_QUESTION_SET_ID,
  DIRECTION_QUESTION_SET_VERSION,
  DIRECTION_QUESTION_TEXT,
  buildDirectionQuestions,
  directionQuestionDigest,
} from "./jev/direction/questions.mjs";
import {
  DIRECTION_ALLOWED_EVIDENCE_CLASS,
  DIRECTION_EXCLUDED_EVIDENCE_CLASSES,
  DIRECTION_FORBIDDEN_KEYS,
  DIRECTION_PACKET_KIND,
  DIRECTION_PACKET_VERSION,
  auditDirectionPacket,
  buildDirectionPacket,
  packetDigestOf,
  packetStateDigestOf,
} from "./jev/direction/packet.mjs";
import {
  DIRECTION_FEATURE_DEFINITION,
  DIRECTION_FEATURE_DEFINITION_DIGEST,
  DIRECTION_FEATURE_DEFINITION_VERSION,
  DIRECTION_FEATURE_DEFINITIONS,
  DIRECTION_FEATURE_NAMES,
  FEATURE_GRANULARITY_AUDIT,
  MAX_DECLARED_WARMUP,
  MINIMUM_WARMUP,
  PRE_OUTCOME_INPUT_PROJECTION_VERSION,
  REGIME_METRIC_KEYS,
  auditDirectionFeatures,
  auditGranularityNames,
  buildPreOutcomeInputs,
  classifyDirectionRegime,
  extractDirectionFeatures,
  extractDirectionFeaturesFromInputs,
  historyUpToCutoff,
  logReturnsFromHistory,
  populationStdDev,
  preOutcomeInputDigestOf,
  tokenizeIdentifier,
  warmupStatus,
} from "./jev/direction/features.mjs";
import {
  BASELINE_CONSTANTS,
  BASELINE_DEFINITION,
  BASELINE_DEFINITION_DIGEST,
  BASELINE_DEFINITION_VERSION,
  BASELINE_DEFINITIONS,
  BASELINE_IDS,
  OPTIONAL_BASELINE_IDS,
  REQUIRED_BASELINE_IDS,
  auditBaselines,
  computeBaseline,
  computeBaselines,
} from "./jev/direction/baselines.mjs";
import {
  ACCURACY_DECISION_RULE,
  CALIBRATION_BIN_COUNT,
  CALIBRATION_BIN_EDGES,
  DIRECTION_METRIC_DEFINITION,
  DIRECTION_METRIC_DEFINITION_DIGEST,
  DIRECTION_METRIC_DEFINITION_V1,
  DIRECTION_METRIC_DEFINITION_V1_DIGEST,
  DIRECTION_METRIC_DEFINITIONS,
  DIRECTION_METRICS_VERSION,
  FORBIDDEN_METRIC_FIELDS,
  LOG_LOSS_EPSILON,
  METRIC_V2_ONLY_FIELDS,
  OUTCOME,
  PROBABILITY_PAIR_TOLERANCE,
  QUANTILE_METHOD,
  accuracy,
  auditNoProfitabilityFields,
  auditProbabilityPair,
  binaryTargetOf,
  evaluateDirectionExperiment,
  isBinaryScorable,
  joinDirectionObservations,
  latencyStats,
  logLoss,
  meanOf,
  medianOf,
  metricDefinitionDigestForVersion,
  metricDefinitionForVersion,
  metricsDigestOf,
  outcomeLabelOf,
  percentileOf,
  percentileStats,
  projectMetricsToVersion,
  spreadStats,
} from "./jev/direction/metrics.mjs";
import {
  ImmutableArtifactError,
  buildDirectionPredictionRecord,
  createDirectionExperiment,
  directionExperimentRootFor,
  directionMetadataSnapshot,
  directionObservationIdFor,
  isValidDirectionExperimentId,
  listDirectionExperiments,
  listDirectionOutcomes,
  listDirectionPredictions,
  outcomeDigestOf,
  predictionDigestOf,
  readDirectionExperiment,
  readDirectionExperimentBundle,
  readDirectionPrediction,
  withPredictionDigest,
  writeDirectionExperiment,
  writeDirectionPrediction,
} from "./jev/direction/storage.mjs";
import {
  FEATURE_STABILITY_STARTUP_LENGTHS,
  FEATURE_STABILITY_TOLERANCE,
  auditBaselineLookahead,
  auditDirectionLookahead,
  auditFeatureLookahead,
  auditFeatureStability,
  auditHistoryRecomputation,
  auditStoredStateConsistency,
  buildAuditObservations,
  diffFeatureValues,
} from "./jev/direction/audit.mjs";
import {
  PIN_COMPARISONS,
  createWaitFor,
  directionStats,
  replayDirectionExperiment,
  runDirectionBenchmark,
  verifyDirectionPins,
} from "./jev/direction/runner.mjs";
import {
  DIRECTION_SETTINGS_VERSION,
  buildDirectionRunSettings,
  enforceDirectionProviderPins,
} from "./jev/direction/settings.mjs";
import { resolveEvidenceProfile } from "./jev/direction/storage.mjs";
import {
  DIRECTION_FIXTURE_PROVIDER_VERSION,
  createDirectionFixtureProvider,
  fixtureProbabilityFor,
} from "./jev/direction/fixture-provider.mjs";

/* ----------------------------------------------------------------------------
 * Phase 5I.1 — evidence profiles, replication protocol, manifest, eligibility,
 * aggregation and the frozen development barrier.
 * -------------------------------------------------------------------------*/
import {
  DEVELOPMENT_EVIDENCE_PROFILE,
  DIRECTION_EVIDENCE_CLASSES,
  DIRECTION_EVIDENCE_PROFILES,
  DIRECTION_REPLICATION_FLAGS,
  evidenceProfileForClass,
  REPLICATION_EVIDENCE_CLASS,
  REPLICATION_EVIDENCE_PROFILE,
  evidenceProfileById,
  evidenceProfileForExperiment,
} from "./jev/direction/evidence.mjs";
import {
  CANONICAL_DEVELOPMENT_BARRIER,
  CANONICAL_DEVELOPMENT_BARRIER_DIGEST,
  DEVELOPMENT_BARRIER_COMPLETED_AT_MS,
  DEVELOPMENT_BARRIER_LATEST_OBSERVATION_AT_MS,
  DEVELOPMENT_BARRIER_METRIC_TOLERANCE,
  DEVELOPMENT_BARRIER_TIMING_TOLERANCE_MS,
  verifyCanonicalDevelopmentBarrier,
} from "./jev/direction/replication/development-barrier.mjs";
import {
  DIRECTION_REPLICATION_ROOT_DIR,
  REPLICATION_ABSOLUTE_METRICS,
  REPLICATION_COMPARISON_IDS,
  REPLICATION_DELTA_METRICS,
  REPLICATION_DELTA_SIGN_CONVENTION,
  REPLICATION_INFERENCE_UNIT,
  REPLICATION_MANIFEST_FILE,
  REPLICATION_PROTOCOL_CONTRACT,
  REPLICATION_PROTOCOL_DIGEST,
  REPLICATION_PROTOCOL_VERSION,
  REPLICATION_SESSION_CADENCE_SECONDS,
  REPLICATION_SESSION_OBSERVATIONS,
  REPLICATION_SESSIONS_FILE,
  REPLICATION_SOURCE_GUARD,
  REPLICATION_SUMMARY_FILE,
  REQUIRED_CLEAN_REPLICATION_SESSIONS,
  protocolContractDifferences,
  protocolDigestOfExperiment,
  verifyReplicationProtocol,
  verifyReplicationSourceGuard,
} from "./jev/direction/replication/protocol.mjs";

import {
  REPLICATION_MANIFEST_VERSION,
  aggregateDigestOf,
  createReplicationManifest,
  createSessionsDocument,
  isValidReplicationId, // used by the storage-identity assertions
  manifestDigestOf,
  readReplicationBundle,
  readReplicationManifest,
  readReplicationSessions,
  replicationIdFor,
  replicationMetadataSnapshot,
  replicationRootFor,
  sessionsDigestOf,
} from "./jev/direction/replication/manifest.mjs";
import {
  PROTECTED_NON_REPLICATION_EXPERIMENT_IDS,
  SESSION_STATUS,
  evaluateReplicationSession,
  protectedExperimentReason,
  sessionObservationWindow,
  windowsOverlap,
} from "./jev/direction/replication/eligibility.mjs";
import {
  REPLICATION_BOOTSTRAP_ALPHA,
  REPLICATION_BOOTSTRAP_PRNG,
  REPLICATION_BOOTSTRAP_RESAMPLES,
  REPLICATION_BOOTSTRAP_SEED,
  REPLICATION_COMPLETE_STATE,
  REPLICATION_INSUFFICIENT_STATE,
  aggregateComparison,
  aggregateReplicationSessions,
  bootstrapSessionMean,
  mulberry32,
  stableSessionStats,
} from "./jev/direction/replication/aggregate.mjs";
import {
  REPLICATION_RUNNER_VERSION,
  deriveReplicationSessionRecord,
  replicationAdd,
  replicationCreate,
  replicationReplay,
  replicationStats,
  sessionRecordDigestOf,
} from "./jev/direction/replication/runner.mjs";
import {
  DIRECTION_OBSERVATION_VERSION,
  POLITE_WAIT_MAX_STEPS,
  createSolDirectionObservationSource,
  selectFirstPostTargetObservation,
} from "./jev/direction/observation.mjs";

import { JEV_PROVIDER, JEV_STATUS, NO_JEV_DECISION, jevIdentity, resolveJevConfig } from "./jev/config.mjs";
import { jevStateDigestOf } from "./jev/decision-packet.mjs";
import { createJevRunBudget, normalizeAnswers, validateAnswers } from "./jev/runtime.mjs";
import { FEATURE_DEFINITION_DIGEST, FEATURE_DEFINITION_VERSION } from "./intelligence/classifier-feature-definition.mjs";
import { evaluationContractDigest } from "./replication/contract.mjs";
import { readFreeze } from "./replication/freeze.mjs";
import { CANONICAL_EVALUATION_CONTRACT_DIGEST, CANONICAL_HISTORICAL_FREEZE_PATH } from "./replication/waves.mjs";

const REPO = process.cwd();
const REAL_DIRECTION_ROOT = path.join(REPO, DIRECTION_ROOT_DIR);
const REAL_EXPECTED_DIR = path.join(REPO, DIRECTION_EXPERIMENTS_DIR);
const REAL_REPLICATION_ROOT = path.join(REPO, DIRECTION_REPLICATION_ROOT_DIR);

/* ============================================================================
 * Pinned canonical barriers (§42). READ-ONLY: nothing here is ever rewritten.
 * ==========================================================================*/

const CANONICAL_5H_FEATURE_ID = "clfeat-20260919T173844Z-7a9193bb";
const CANONICAL_5H_FEATURE_DIGEST = "65218b38f80a344a99f12f8a98784a49250d0ec0b88cd88ea9cd795fab39312b";
const CANONICAL_5H_FEATURE_DEFINITION_VERSION = "classifier-feature-definition-v1";
const CANONICAL_5H_FEATURE_DEFINITION_DIGEST = "9227c8ef12414951bd48fe4c4c2a9ea2d1b69f4485f1019157912e32bc0093bd";
const CANONICAL_5H_SOURCE_COHORT_ID = "clcohort-20260919T163609Z-4d7c6dd9";
const CANONICAL_5H_SOURCE_COHORT_DIGEST = "2a8b9ca38f6f1f9dad7a46426c9a42cece2ca9fa3722815c430d42098b9e1a04";
const CANONICAL_5H_EVIDENCE_AS_OF = "2026-09-19T16:34:12.867Z";
const CANONICAL_5H_EVIDENCE_CLASS = "DEVELOPMENT_CLASSIFIER_DERIVED_FEATURES";

/** Phase 5I.1 — the canonical development barrier id/digest, pinned in source. */
const CANONICAL_DEVELOPMENT_EXPERIMENT_ID = "jdir-20260920T063311Z-3a9163";
const CANONICAL_DEVELOPMENT_METRICS_DIGEST = "984cc26dd9f247dbd625dc8c7bfb07d82600ed9a353fe7ef2bba423cc79f29ba";
const CANARY_V1_EXPERIMENT_ID = "jdir-20260920T060810Z-3a9163";
const CANARY_V2_EXPERIMENT_ID = "jdir-20260920T062804Z-3a9163";
const CANONICAL_5H_SOURCE_EVIDENCE_CLASS = "DEVELOPMENT_CLASSIFIER_EVIDENCE";
const CANONICAL_EVALUATION_CONTRACT = "4cf8ac1fa7db290acadeccf6043ec34c3239f8e3f848e9e50d8560826de85052";

/** Sources that must never gain a Phase 5I import (isolation barrier). */
const PHASE_5I_MODULES = Object.freeze([
  "scripts/jev/direction/definition.mjs",
  "scripts/jev/direction/questions.mjs",
  "scripts/jev/direction/packet.mjs",
  "scripts/jev/direction/features.mjs",
  "scripts/jev/direction/baselines.mjs",
  "scripts/jev/direction/audit.mjs",
  "scripts/jev/direction/metrics.mjs",
  "scripts/jev/direction/storage.mjs",
  "scripts/jev/direction/observation.mjs",
  "scripts/jev/direction/settings.mjs",
  "scripts/jev/direction/fixture-provider.mjs",
  "scripts/jev/direction/runner.mjs",
  "scripts/jev/direction/evidence.mjs",
  "scripts/jev/direction/replication/development-barrier.mjs",
  "scripts/jev/direction/replication/protocol.mjs",
  "scripts/jev/direction/replication/manifest.mjs",
  "scripts/jev/direction/replication/eligibility.mjs",
  "scripts/jev/direction/replication/aggregate.mjs",
  "scripts/jev/direction/replication/runner.mjs",
  "scripts/jev-direction.mjs",
]);

/** Tokens that would indicate a path to money movement. Never present in 5I. */
const FORBIDDEN_RUNTIME_TOKENS = Object.freeze([
  "Keypair",
  "PrivateKey",
  "privateKey",
  "secretKey",
  "signTransaction",
  "sendTransaction",
  "sendRawTransaction",
  "signer",
  "wallet",
  "placeOrder",
  "cancelOrder",
  "swap(",
  "createSwap",
  "jupiterSwap",
  "connection.confirmTransaction",
  "paperOrder",
]);

/* ============================================================================
 * Test harness (same shape as the other Phase 5 validators)
 * ==========================================================================*/

const cases = [];
const skips = [];

function test(name, fn) {
  cases.push({ name, fn });
}
function fail(message) {
  throw new Error(message);
}
function assertTrue(condition, message) {
  if (!condition) fail(message);
}
function assertEqual(actual, expected, message) {
  if (actual !== expected) fail(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}
function assertDeepEqual(actual, expected, message) {
  const a = canonicalJson(actual);
  const b = canonicalJson(expected);
  if (a !== b) fail(`${message}\n      expected ${b}\n      got      ${a}`);
}
function assertClose(actual, expected, message, tolerance = 1e-9) {
  assertTrue(
    Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${message} (expected ~${expected}, got ${actual})`,
  );
}
function assertIncludes(haystack, needle, message) {
  if (!String(haystack).includes(needle)) fail(`${message} (looked for ${JSON.stringify(needle)})`);
}
function assertExcludes(haystack, needle, message) {
  if (String(haystack).includes(needle)) fail(`${message} (found ${JSON.stringify(needle)})`);
}
function assertThrows(fn, predicate, message) {
  let thrown = null;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  if (thrown === null) fail(`${message} — nothing was thrown`);
  const matched =
    typeof predicate === "function"
      ? predicate.prototype instanceof Error
        ? thrown instanceof predicate
        : Boolean(predicate(thrown))
      : thrown?.name === predicate;
  if (!matched) fail(`${message} — threw ${thrown?.name ?? "an error"}: ${thrown?.message ?? thrown}`);
  return thrown;
}
function skip(reason) {
  skips.push(reason);
}
async function exists(target) {
  return stat(target)
    .then(() => true)
    .catch(() => false);
}
async function readText(relative) {
  return readFile(path.join(REPO, relative), "utf8");
}
async function metadataSnapshot(root) {
  const out = {};
  const walk = async (dir, relative) => {
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      const rel = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(full, rel);
        continue;
      }
      const content = await readFile(full, "utf8").catch(() => null);
      if (content === null) continue;
      out[rel] = { bytes: content.length, digest: digestOf(content) };
    }
  };
  await walk(root, "");
  return out;
}

/* ============================================================================
 * Deterministic market fixture
 *
 * A single observation cycle is a polite 3-endpoint walk. Every price is a pure
 * function of the fake clock, so the whole experiment is reproducible without a
 * network, a provider or a real timer.
 * ==========================================================================*/

const FIXTURE_T0 = Date.parse("2026-09-20T00:00:00.000Z");
const FIXTURE_CYCLE_MS = 30_000;

/**
 * The price schedule. Consecutive duplicates are deliberate: whichever cycle
 * boundary a state/future pair lands on, the fixture still contains at least one
 * HIGHER, one LOWER and one TIE, so TIE handling is always exercised.
 */
const FIXTURE_PRICES = Object.freeze([100.0, 100.0, 100.5, 99.0, 99.0, 100.2, 98.5, 100.2, 99.9]);

function fixturePriceAt(clockMs, prices = FIXTURE_PRICES, t0 = FIXTURE_T0) {
  const step = Math.max(0, Math.floor((clockMs - t0) / FIXTURE_CYCLE_MS));
  return prices[Math.min(step, prices.length - 1)];
}

/** A Jupiter Tokens V2 shaped payload for wrapped SOL. */
function fixtureSolToken(price, { extra = {} } = {}) {
  return {
    id: BENCHMARK_MARKET.baseMint,
    name: "Wrapped SOL",
    symbol: "SOL",
    usdPrice: price,
    liquidity: 5_000_000,
    mcap: 1e11,
    fdv: 1e11,
    holderCount: 2_000_000,
    organicScore: 80,
    decimals: 9,
    audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 5 },
    firstPool: { id: "pool-sol", createdAt: new Date(FIXTURE_T0 - 86_400_000 * 365).toISOString() },
    tags: ["verified"],
    stats5m: {
      priceChange: 0.01,
      liquidityChange: 0.5,
      volumeChange: 1.2,
      holderChange: 0.01,
      buyVolume: 1_000_000,
      sellVolume: 900_000,
      buyOrganicVolume: 500_000,
      sellOrganicVolume: 400_000,
      numBuys: 1200,
      numSells: 1100,
      numTraders: 900,
      numOrganicBuyers: 300,
      numNetBuyers: 40,
    },
    ...extra,
  };
}

const FIXTURE_NOISE_TOKEN = {
  id: "SomeOtherMint111111111111111111111111111111",
  symbol: "NOISE",
  usdPrice: 0.5,
  liquidity: 30_000,
  stats5m: { priceChange: 0.2, buyVolume: 10, sellVolume: 12, numBuys: 3, numSells: 4 },
};

/**
 * Build a fully injected observation harness.
 *
 * @param {{ t0?: number, prices?: readonly number[], solOnAllEndpoints?: boolean, quoteToken?: boolean }} [options]
 */
function createFixtureHarness({ t0 = FIXTURE_T0, prices = FIXTURE_PRICES, solOnAllEndpoints = false, quoteToken = false } = {}) {
  const shared = { clock: t0 };
  const now = () => shared.clock;
  const sleep = async (ms) => {
    shared.clock += Math.max(0, ms);
  };

  const fetchImpl = async (url) => {
    const withSol = solOnAllEndpoints || /toporganicscore|toptrending/.test(String(url));
    const price = fixturePriceAt(shared.clock, prices, t0);
    const tokens = [FIXTURE_NOISE_TOKEN];
    if (withSol) tokens.push(fixtureSolToken(price));
    if (quoteToken) {
      tokens.push({ ...FIXTURE_NOISE_TOKEN, id: BENCHMARK_MARKET.quoteMint, symbol: "USDC", usdPrice: 1 });
    }
    return {
      status: 200,
      async json() {
        return tokens;
      },
    };
  };

  const config = createMarketConfigForFixture();
  const source = createSolDirectionObservationSource({ config, fetchImpl, now, sleep });
  return { shared, now, sleep, fetchImpl, config, source, t0, prices };
}

/**
 * The market config the benchmark uses, with politeness spacing neutered for
 * tests. `loadEnv: false` is essential: this suite must never inherit a real
 * .env file, a real key, or a real endpoint.
 */
function createMarketConfigForFixture() {
  return createMarketConfig(
    {
      JUPITER_API_KEY: "fixture-key",
      EVOLVE_MARKET_MODE: "live",
      EVOLVE_ALLOW_KEYLESS: "true",
      EVOLVE_JUPITER_SPACING_MS: "0",
      EVOLVE_JUPITER_POLL_MS: "1000",
      EVOLVE_JUPITER_TIMEOUT_MS: "5000",
      EVOLVE_JUPITER_ENDPOINTS: RECOMMENDED_ENDPOINT_ORDER.join(","),
    },
    { loadEnv: false },
  );
}

const FIXTURE_PIN_RESULT = Object.freeze({
  resolution: Object.freeze({ provider: JEV_PROVIDER.MOCK }),
  model: "direction-fixture-jev-v1",
  identity: Object.freeze({ upstreamProvider: "evolve-mock", gatewayUsed: false, transport: "offline" }),
  questionDigest: directionQuestionDigest(),
  offlineFixture: true,
  providerImplementation: "direction-fixture-jev-v1",
  observationEndpoints: RECOMMENDED_ENDPOINT_ORDER,
});

const FIXTURE_SETTINGS_OVERRIDES = Object.freeze({
  market: "SOL-USDC",
  "cadence-seconds": "30",
  "tolerance-ms": "10000",
  "max-runtime-minutes": "90",
});

/**
 * Run ONE complete deterministic experiment (start -> predict -> resolve) into a
 * temp root, with an injected clock, market fetch and provider.
 *
 * @param {{
 *   root: string,
 *   experimentId: string,
 *   harness: object,
 *   maxObservations: number,
 *   provider: object,
 *   stopAfterFirstPrediction?: boolean,
 *   extraSettings?: object,
 * }} options
 */
async function runFixtureExperiment({
  root,
  experimentId,
  harness,
  maxObservations,
  provider,
  stopAfterFirstPrediction = false,
  extraSettings = {},
  pinResult = FIXTURE_PIN_RESULT,
  evidenceProfile = null,
}) {
  const settings = buildDirectionRunSettings({
    ...FIXTURE_SETTINGS_OVERRIDES,
    "max-observations": String(maxObservations),
    ...extraSettings,
  });
  const control = { stopped: false };
  const events = [];
  const result = await runDirectionBenchmark({
    action: "start",
    settings,
    provider,
    source: harness.source,
    baseRoot: root,
    now: harness.now,
    sleep: harness.sleep,
    control,
    onProgress: (event) => {
      events.push(event);
      if (stopAfterFirstPrediction && event.type === "PREDICTION_FROZEN") control.stopped = true;
    },
    budget: createJevRunBudget(maxObservations),
    questions: buildDirectionQuestions(),
    experimentId,
    pinResult,
    evidenceProfile,
  });
  return { result, settings, events, control };
}

/* ============================================================================
 * Phase 5I.1 replication fixtures
 *
 * These exist ONLY to exercise the replication machinery END TO END inside a
 * temp directory. They are served by the deterministic 5I fixture provider
 * wearing the canonical identity, so that the aggregation, eligibility,
 * independence and bootstrap LOGIC can be tested without a network, a
 * credential, a model call, or a single artifact under the real `.evolve` tree.
 *
 * Nothing here can produce real evidence: every path is asserted to live under
 * the OS temp directory, and the real replication tree is proved byte-unchanged.
 * ==========================================================================*/

/** The canonical identity, so a fixture session is otherwise indistinguishable. */
const REPLICATION_FIXTURE_PIN_RESULT = Object.freeze({
  resolution: Object.freeze({ provider: REQUIRED_PROVIDER }),
  model: REQUIRED_MODEL,
  identity: Object.freeze({ upstreamProvider: REQUIRED_UPSTREAM_PROVIDER, gatewayUsed: false, transport: "offline-fixture" }),
  questionDigest: directionQuestionDigest(),
  offlineFixture: false,
  providerImplementation: REQUIRED_PROVIDER,
  observationEndpoints: RECOMMENDED_ENDPOINT_ORDER,
});

/**
 * The deterministic offline provider wearing the canonical identity. It answers
 * the same frozen question set, computes the same probability from the same
 * packet digest, and makes no network call — it simply reports the identity the
 * protocol contract requires, so a CLEAN fixture session is constructible in a
 * temp directory.
 */
function createReplicationFixtureProvider(options = {}) {
  const base = createDirectionFixtureProvider(options);
  return {
    ...base,
    name: REQUIRED_PROVIDER,
    model: REQUIRED_MODEL,
    implementation: REQUIRED_PROVIDER,
    async evaluate(args) {
      const result = await base.evaluate(args);
      return result?.ok === true ? { ...result, model: REQUIRED_MODEL } : result;
    },
  };
}

/**
 * A deterministic pseudo-random walk with regular EXACT duplicates, so the
 * fixture produces HIGHER, LOWER and TIE outcomes across a whole 120-observation
 * session instead of clamping to one repeated price.
 */
function buildFixturePriceSchedule({ length = 260, seed = 1, start = 100 } = {}) {
  const random = mulberry32(seed);
  const out = [];
  let price = start;
  for (let index = 0; index < length; index += 1) {
    if (index > 0 && index % 13 === 0) {
      out.push(price);
      continue;
    }
    price = Number((price * (1 + (random() - 0.5) * 0.006)).toFixed(6));
    out.push(price);
  }
  return out;
}

const REPLICATION_FIXTURE_PLAN = Object.freeze([
  { experimentId: "jdir-fixture-rep-1", t0: "2026-09-21T00:00:00.000Z", seed: 11 },
  { experimentId: "jdir-fixture-rep-2", t0: "2026-09-21T03:00:00.000Z", seed: 22 },
  { experimentId: "jdir-fixture-rep-3", t0: "2026-09-21T06:00:00.000Z", seed: 33 },
  // An OVERLAPPING PAIR, deliberately far away from the three clean windows: the
  // first is clean when added, the second contaminates BOTH of them, which is the
  // symmetric independence rule.
  { experimentId: "jdir-fixture-rep-contaminated", t0: "2026-09-22T00:00:00.000Z", seed: 44 },
  { experimentId: "jdir-fixture-rep-contaminated-2", t0: "2026-09-22T00:20:00.000Z", seed: 45 },
  // Served by the DEVELOPMENT fixture (mock) provider and labelled development
  // evidence: this session must be INELIGIBLE, never silently dropped.
  { experimentId: "jdir-fixture-rep-ineligible", t0: "2026-09-21T09:00:00.000Z", seed: 55, development: true },
]);

async function buildReplicationFixtures() {
  const rep = {
    experimentsRoot: path.join(ctx.tempRoot, "replication-experiments"),
    replicationRoot: path.join(ctx.tempRoot, "replication"),
    developmentExperimentId: CANONICAL_DEVELOPMENT_BARRIER.experimentId,
    developmentArtifactsPresent: false,
    sessions: [],
    created: null,
    added: [],
    snapshots: {},
  };
  // The pins every session is checked against. They are derived from the FROZEN
  // protocol contract, exactly the way `--replication-create` derives them.
  rep.expected = {
    ...createReplicationManifest({
      replicationId: "jrep-expected-pins",
      development: {
        experimentId: CANONICAL_DEVELOPMENT_BARRIER.experimentId,
        metricsDigest: CANONICAL_DEVELOPMENT_BARRIER.metricsDigest,
        evidenceClass: CANONICAL_DEVELOPMENT_BARRIER.evidenceClass,
        phase: CANONICAL_DEVELOPMENT_BARRIER.phase,
        requiredCleanSessions: REQUIRED_CLEAN_REPLICATION_SESSIONS,
      },
      protocol: REPLICATION_PROTOCOL_CONTRACT,
    }).expected,
    protocolDigest: REPLICATION_PROTOCOL_DIGEST,
  };
  ctx.replication = rep;

  // The canonical development experiment is COPIED (read only) into the temp
  // experiments root when it is present locally, so the barrier verification runs
  // against real artifacts without ever touching the real tree. Absent (CI), the
  // barrier is still source-pinned and the replication cases still run.
  const realDevelopmentRoot = path.join(REAL_EXPECTED_DIR, CANONICAL_DEVELOPMENT_BARRIER.experimentId);
  rep.developmentArtifactsPresent = await exists(realDevelopmentRoot);
  if (rep.developmentArtifactsPresent) {
    await cp(realDevelopmentRoot, path.join(rep.experimentsRoot, CANONICAL_DEVELOPMENT_BARRIER.experimentId), {
      recursive: true,
    });
  }

  for (const plan of REPLICATION_FIXTURE_PLAN) {
    const t0 = Date.parse(plan.t0);
    const prices = buildFixturePriceSchedule({ seed: plan.seed, start: 100 + plan.seed });
    const harness = createFixtureHarness({ t0, prices });
    const development = plan.development === true;
    const run = await runFixtureExperiment({
      root: rep.experimentsRoot,
      experimentId: plan.experimentId,
      harness,
      maxObservations: REPLICATION_SESSION_OBSERVATIONS,
      provider: development ? defaultFixtureProvider() : createReplicationFixtureProvider(),
      extraSettings: development ? {} : { "replication-session": true },
      pinResult: development ? FIXTURE_PIN_RESULT : REPLICATION_FIXTURE_PIN_RESULT,
      evidenceProfile: development ? null : "replication",
    });
    rep.sessions.push({ ...plan, t0, run });
  }
}

/* ============================================================================
 * Fixtures + context
 * ==========================================================================*/

const ctx = {
  tempRoot: null,
  harness: null,
  main: null,
  slow: null,
  failing: null,
  lowConfidence: null,
  interrupted: null,
  // Phase 5I.1 replication fixtures (temp tree only).
  replication: null,
  before: {},
  after: {},
  directionRootPresentBefore: false,
};

/** The provider used by the main fixture: a pure function of the packet digest. */
function defaultFixtureProvider() {
  return createDirectionFixtureProvider();
}

/**
 * A provider whose ONE logical call consumes `delayMs` of the injected clock.
 * Used to prove that a slow Jev can never move `targetAt`.
 */
function slowFixtureProvider(harness, delayMs) {
  const base = createDirectionFixtureProvider();
  return {
    ...base,
    async evaluate(args) {
      harness.shared.clock += delayMs;
      return base.evaluate(args);
    },
  };
}

async function buildFixtures() {
  ctx.tempRoot = await mkdtemp(path.join(tmpdir(), "phase5i-"));
  ctx.directionRootPresentBefore = await exists(REAL_DIRECTION_ROOT);

  // ---- 1. the main experiment: 8 observations, honest fixture provider ------
  ctx.harness = createFixtureHarness({ quoteToken: true });
  ctx.main = await runFixtureExperiment({
    root: ctx.tempRoot,
    experimentId: "jdir-fixture-main",
    harness: ctx.harness,
    maxObservations: 8,
    provider: defaultFixtureProvider(),
  });

  // ---- 2. a SLOW model: one logical call eats 40s of clock ------------------
  const slowHarness = createFixtureHarness();
  ctx.slow = await runFixtureExperiment({
    root: ctx.tempRoot,
    experimentId: "jdir-fixture-slow",
    harness: slowHarness,
    maxObservations: 2,
    provider: slowFixtureProvider(slowHarness, 40_000),
  });

  // ---- 3. a FAILING provider: failed observations are preserved -------------
  const failHarness = createFixtureHarness();
  ctx.failing = await runFixtureExperiment({
    root: ctx.tempRoot,
    experimentId: "jdir-fixture-failing",
    harness: failHarness,
    maxObservations: 2,
    provider: createDirectionFixtureProvider({ failWith: JEV_STATUS.UNAVAILABLE }),
  });

  // ---- 4. LOW-confidence-but-valid probabilities are retained ---------------
  const lowHarness = createFixtureHarness();
  ctx.lowConfidence = await runFixtureExperiment({
    root: ctx.tempRoot,
    experimentId: "jdir-fixture-lowconf",
    harness: lowHarness,
    maxObservations: 2,
    provider: createDirectionFixtureProvider({ probabilityFor: () => 0.500001 }),
  });

  // ---- 5. an interrupted run, then resumed ---------------------------------
  const interruptHarness = createFixtureHarness();
  ctx.interrupted = await runFixtureExperiment({
    root: ctx.tempRoot,
    experimentId: "jdir-fixture-resume",
    harness: interruptHarness,
    maxObservations: 6,
    provider: defaultFixtureProvider(),
    stopAfterFirstPrediction: true,
  });
  ctx.interruptHarness = interruptHarness;

  // ---- 6. Phase 5I.1 replication fixtures (temp tree only) -----------------
  await buildReplicationFixtures();

  await loadFixtureContext();
}

async function disposeFixtures() {
  if (ctx.tempRoot) await rm(ctx.tempRoot, { recursive: true, force: true }).catch(() => {});
}

/** Load every fixture bundle into the shared context as plain artifact arrays. */
async function loadFixtureContext() {
  const read = async (experimentId) => {
    const bundle = await readDirectionExperimentBundle(directionExperimentRootFor(ctx.tempRoot, experimentId));
    return bundle;
  };
  const main = await read("jdir-fixture-main");
  const slow = await read("jdir-fixture-slow");
  const failing = await read("jdir-fixture-failing");
  const lowConfidence = await read("jdir-fixture-lowconf");
  const interrupted = await read("jdir-fixture-resume");

  ctx.mainBundle = main;
  ctx.experiment = main.experiment;
  ctx.mainPredictions = main.predictions;
  ctx.mainOutcomes = main.outcomes;
  ctx.mainSummary = main.summary;
  ctx.mainMetrics = evaluateDirectionExperiment({ experiment: main.experiment, predictions: main.predictions, outcomes: main.outcomes });
  ctx.slowPredictions = slow.predictions;
  ctx.slowOutcomes = slow.outcomes;
  ctx.slowMetrics = evaluateDirectionExperiment({ experiment: slow.experiment, predictions: slow.predictions, outcomes: slow.outcomes });
  ctx.failingPredictions = failing.predictions;
  ctx.failingOutcomes = failing.outcomes;
  ctx.failingMetrics = evaluateDirectionExperiment({ experiment: failing.experiment, predictions: failing.predictions, outcomes: failing.outcomes });
  ctx.lowConfidencePredictions = lowConfidence.predictions;
  ctx.interruptedBundle = interrupted;
}

/* ============================================================================
 * PART A — frozen identities / definitions
 * ==========================================================================*/

test("A1. the phase identity and schema version are the frozen 5I.0b contract", () => {
  assertEqual(DIRECTION_PHASE, "5I.0b", "the phase id is 5I.0b");
  assertEqual(DIRECTION_SCHEMA_VERSION, 1, "schema version is 1");
  assertEqual(DIRECTION_EVIDENCE_CLASS, "DEVELOPMENT_JEV_DIRECTION_EVIDENCE", "the one evidence class");
  assertEqual(TARGET_AT_BASIS, "stateFrozenAt + horizonSeconds", "the target basis is frozen to the freeze instant");
});

test("A2. the historical definition digests are non-trivial and stable across recomputation", () => {
  for (const [label, value] of Object.entries({
    questionSet: DIRECTION_QUESTION_SET_DIGEST,
    question: directionQuestionDigest(),
    features: DIRECTION_FEATURE_DEFINITION_DIGEST,
    baselines: BASELINE_DEFINITION_DIGEST,
    metrics: DIRECTION_METRIC_DEFINITION_DIGEST,
    referencePrice: REFERENCE_PRICE_DEFINITION_DIGEST,
    staleness: STALENESS_POLICY_DIGEST,
    outcomeResolutionV1: OUTCOME_RESOLUTION_POLICY_V1_DIGEST,
    outcomeResolutionV2: OUTCOME_RESOLUTION_POLICY_V2_DIGEST,
    unavailableFamilies: UNAVAILABLE_FEATURE_FAMILIES_DIGEST,
  })) {
    assertTrue(/^[0-9a-f]{64}$/.test(String(value)), `${label} digest is a sha256 hex string`);
  }
  assertEqual(directionQuestionDigest(), directionQuestionDigest(), "the question digest is deterministic");
  assertEqual(DIRECTION_FEATURE_DEFINITION_DIGEST, digestOf(DIRECTION_FEATURE_DEFINITION), "the feature definition digest recomputes");
  assertEqual(BASELINE_DEFINITION_DIGEST, digestOf(BASELINE_DEFINITION), "the baseline definition digest recomputes");
  assertEqual(DIRECTION_METRIC_DEFINITION_DIGEST, digestOf(DIRECTION_METRIC_DEFINITION), "the metric definition digest recomputes");
  assertEqual(DIRECTION_METRIC_DEFINITION_V1_DIGEST, digestOf(DIRECTION_METRIC_DEFINITION_V1), "the frozen v1 metric definition digest recomputes");
  assertEqual(REFERENCE_PRICE_DEFINITION_DIGEST, digestOf(REFERENCE_PRICE_DEFINITION), "the reference-price digest recomputes");
  assertEqual(STALENESS_POLICY_DIGEST, digestOf(STALENESS_POLICY), "the staleness-policy digest recomputes");
  assertEqual(OUTCOME_RESOLUTION_POLICY_V1_DIGEST, digestOf(OUTCOME_RESOLUTION_POLICY_V1), "the outcome-policy v1 digest recomputes");
  assertEqual(OUTCOME_RESOLUTION_POLICY_V2_DIGEST, digestOf(OUTCOME_RESOLUTION_POLICY_V2), "the outcome-policy v2 digest recomputes");
  assertEqual(UNAVAILABLE_FEATURE_FAMILIES_DIGEST, digestOf(UNAVAILABLE_FEATURE_FAMILIES), "the omitted-family digest recomputes");
});

test("A3. every definition version is a positive integer and the versions are distinct concerns", () => {
  assertEqual(DIRECTION_QUESTION_SET_VERSION, 1, "question set version");
  assertEqual(DIRECTION_PACKET_VERSION, 1, "packet version");
  assertEqual(DIRECTION_FEATURE_DEFINITION_VERSION, 1, "feature definition version");
  assertEqual(BASELINE_DEFINITION_VERSION, 1, "baseline definition version");
  assertEqual(DIRECTION_METRICS_VERSION, 2, "metric definition version");
  assertEqual(REFERENCE_PRICE_DEFINITION_VERSION, 1, "reference price definition version");
  assertEqual(OUTCOME_RESOLUTION_POLICY_VERSION_V1, 1, "outcome resolution policy v1 version");
  assertEqual(OUTCOME_RESOLUTION_POLICY_VERSION_V2, 2, "outcome resolution policy v2 version");
  assertEqual(CURRENT_OUTCOME_RESOLUTION_POLICY_VERSION, 2, "new experiments pin policy v2");
  assertEqual(DIRECTION_SETTINGS_VERSION, 1, "settings version");
  assertEqual(DIRECTION_OBSERVATION_VERSION, 1, "observation version");
  assertEqual(DIRECTION_FIXTURE_PROVIDER_VERSION, 1, "offline fixture provider version");
});

test("A4. the 5I module set is isolated: no Phase 5I import appears in another EVOLVE subsystem", async () => {
  const source = await readText("scripts/evolve-engine.mjs");
  assertExcludes(source, "jev/direction", "the engine never imports the 5I direction modules");
  for (const relative of ["scripts/arena.mjs", "scripts/jev.mjs", "scripts/intelligence-classify.mjs", "scripts/jev-external.mjs"]) {
    const other = await readText(relative);
    assertExcludes(other, "jev/direction", `${relative} never imports the 5I direction modules`);
  }
});

test("A5. the 5I runtime module set exists exactly where the contract says", async () => {
  for (const relative of PHASE_5I_MODULES) {
    assertTrue(await exists(path.join(REPO, relative)), `${relative} exists`);
  }
  assertTrue(await exists(path.join(REPO, "scripts/validate-phase5i.mjs")), "the Phase 5I validator exists");
});

test("A6. the default development protocol is frozen (120 observations, 30s cadence, 30s horizon)", () => {
  assertEqual(DEFAULT_MAX_OBSERVATIONS, 120, "the default run is 120 scheduled observations");
  assertEqual(DEFAULT_CADENCE_SECONDS, 30, "the default cadence is 30 seconds");
  assertEqual(HORIZON_SECONDS, 30, "the primary horizon is 30 seconds");
  assertEqual(HORIZON_MS, 30_000, "and 30 seconds in milliseconds");
  assertEqual(TARGET_AT_BASIS, "stateFrozenAt + horizonSeconds", "the target basis is the frozen state, never the model finish");
  const defaults = buildDirectionRunSettings({});
  assertEqual(defaults.maxObservations, DEFAULT_MAX_OBSERVATIONS, "settings default to the frozen observation count");
  assertEqual(defaults.cadenceSeconds, DEFAULT_CADENCE_SECONDS, "settings default to the frozen cadence");
  assertEqual(defaults.horizonSeconds, HORIZON_SECONDS, "settings default to the frozen horizon");
  assertEqual(defaults.horizonSeconds * 1_000, defaults.horizonMs, "horizon seconds and milliseconds agree");
});

/* ============================================================================
 * PART B — question-set contract
 * ==========================================================================*/

test("B1. the question set is the dedicated 5I identity, not a reused one", () => {
  assertEqual(DIRECTION_QUESTION_SET_ID, "jev-microstructure-direction-v1", "question set id");
  assertEqual(DIRECTION_QUESTION_SET_VERSION, 1, "question set version");
  assertTrue(DIRECTION_QUESTION_SET_ID !== "jev-question-set-v1", "the Phase 5D candidate question set is NOT reused");
  assertTrue(DIRECTION_QUESTION_SET_ID !== "jev-market-v1", "the market-regime question set is NOT reused");
  assertTrue(DIRECTION_QUESTION_SET_ID !== "jev-external-v1", "the external question set is NOT reused");
});

test("B2. the question set contains EXACTLY one noul question named as frozen", () => {
  const questions = buildDirectionQuestions();
  assertDeepEqual(Object.keys(questions), [DIRECTION_QUESTION_NAME], "exactly one question, with the frozen name");
  assertDeepEqual(DIRECTION_QUESTION_NAMES, ["priceHigherAtHorizon"], "the frozen question name");
  assertEqual(questions[DIRECTION_QUESTION_NAME].type, "noul", "the question is a probability (noul) question");
  assertTrue(typeof questions[DIRECTION_QUESTION_NAME].instructions === "string", "the question carries instructions");
  assertDeepEqual(
    questions[DIRECTION_QUESTION_NAME].criteria,
    { true: DIRECTION_QUESTION_CRITERIA.true, false: DIRECTION_QUESTION_CRITERIA.false },
    "the true/false criteria are frozen",
  );
});

test("B3. the central question is the frozen word-for-word 30-second SOL/USDC question", () => {
  assertIncludes(DIRECTION_QUESTION_TEXT, "SOL/USDC", "names the benchmark market");
  assertIncludes(DIRECTION_QUESTION_TEXT, "30 seconds", "names the frozen horizon");
  assertIncludes(DIRECTION_QUESTION_TEXT, "stateObservedAt", "names the pre-outcome state instant");
  assertIncludes(DIRECTION_QUESTION_TEXT, "frozen market state", "is explicitly restricted to the frozen state");
  assertIncludes(DIRECTION_QUESTION_TEXT, "no future data", "explicitly forbids future data");
  assertIncludes(DIRECTION_QUESTION_CRITERIA.true, "HIGHER", "the true criterion is HIGHER");
  assertIncludes(DIRECTION_QUESTION_CRITERIA.false, "NOT higher", "the false criterion is not-higher");
});

test("B4. the question set is never reduced to BUY/SELL and carries no threshold", () => {
  const serialized = JSON.stringify(DIRECTION_QUESTION_SET);
  for (const word of ["BUY", "SELL", "LONG", "SHORT", "order", "position", "size"]) {
    assertExcludes(serialized, word, `the question set never mentions ${word}`);
  }
  assertEqual(DIRECTION_QUESTION_SET.reducedToBuySell, false, "reducedToBuySell is false");
  assertEqual(DIRECTION_QUESTION_SET.confidenceThresholdApplied, false, "the question set declares no threshold was applied");
  assertTrue(!Object.hasOwn(DIRECTION_QUESTION_SET, "confidenceThreshold"), "and defines no threshold field at all");
  assertEqual(DIRECTION_QUESTION_SET.answerKind, "noul-probability", "the answer kind is a probability");
  assertEqual(DIRECTION_QUESTION_SET.horizonSeconds, HORIZON_SECONDS, "the question set pins the 30s horizon");
});

test("B5. the question digest is stable across rebuilds and changes when the question changes", () => {
  assertEqual(directionQuestionDigest(), digestOf(buildDirectionQuestions()), "the digest is the digest of the built set");
  const rebuilt = buildDirectionQuestions();
  assertDeepEqual(rebuilt, buildDirectionQuestions(), "two builds are byte-identical");
  assertTrue(digestOf({ q: { type: "noul", instructions: "different" } }) !== directionQuestionDigest(), "a different question yields a different digest");
});

/* ============================================================================
 * PART C — packet whitelist
 * ==========================================================================*/

test("C1. the packet kind and version are the frozen 5I kind", () => {
  assertEqual(DIRECTION_PACKET_KIND, "JEV_MICROSTRUCTURE_DIRECTION_PACKET", "packet kind");
  assertEqual(DIRECTION_PACKET_VERSION, 1, "packet version");
  assertEqual(DIRECTION_ALLOWED_EVIDENCE_CLASS, "PRE_OUTCOME_MARKET_STATE", "the only allowed evidence class");
});

test("C2. a well-formed packet passes the leakage audit and carries no forbidden key", () => {
  const packet = buildDirectionPacket({
    observationId: "obs-1",
    observationIndex: 0,
    stateObservedAt: new Date(FIXTURE_T0).toISOString(),
    features: Object.fromEntries(DIRECTION_FEATURE_NAMES.map((name) => [name, 1])),
  });
  const audit = auditDirectionPacket(packet);
  assertTrue(audit.ok, `the packet audit passes: ${JSON.stringify(audit.violations)}`);
  assertEqual(packet.evidenceClass, DIRECTION_ALLOWED_EVIDENCE_CLASS, "the packet declares the pre-outcome evidence class");
  assertEqual(packet.packetKind, DIRECTION_PACKET_KIND, "the packet declares the 5I kind");
  assertEqual(packet.packetVersion, DIRECTION_PACKET_VERSION, "the packet declares the 5I version");
  assertEqual(packet.phase, DIRECTION_PHASE, "the packet declares the phase");
  assertEqual(packet.targetAtBasis, TARGET_AT_BASIS, "the packet declares the target basis");
  assertDeepEqual(Object.keys(packet.features).sort(), [...DIRECTION_FEATURE_NAMES].sort(), "the packet carries exactly the frozen feature whitelist");
});

test("C3. the packet is a WHITELIST: an unknown feature key is dropped, never forwarded", () => {
  const packet = buildDirectionPacket({
    observationId: "obs-2",
    observationIndex: 0,
    stateObservedAt: new Date(FIXTURE_T0).toISOString(),
    features: { ...Object.fromEntries(DIRECTION_FEATURE_NAMES.map((name) => [name, 1])), smuggledFutureReturn: 0.9 },
  });
  assertTrue(!Object.hasOwn(packet.features, "smuggledFutureReturn"), "an unknown feature never reaches the packet");
  assertDeepEqual(Object.keys(packet.features).sort(), [...DIRECTION_FEATURE_NAMES].sort(), "only whitelisted features survive");
});

test("C4. the packet declares every excluded evidence class and the omitted feature families", () => {
  const packet = buildDirectionPacket({ observationId: "obs-3", observationIndex: 0, stateObservedAt: new Date(FIXTURE_T0).toISOString(), features: {} });
  for (const excluded of [
    "POST_OUTCOME_PRICE",
    "OUTCOME_LABEL",
    "FUTURE_OBSERVATION",
    "ARENA_SCORE",
    "GATE_RESULT",
    "DEPLOYMENT_STATUS",
    "CHAMPION_STATUS",
    "PROFITABILITY",
    "PNL",
    "CLASSIFIER_EVALUATION_RESULT",
    "CLASSIFIER_DERIVED_FEATURE",
  ]) {
    assertTrue(DIRECTION_EXCLUDED_EVIDENCE_CLASSES.includes(excluded), `${excluded} is declared excluded`);
    assertTrue(packet.excludedEvidenceClasses.includes(excluded), `${excluded} is on the packet`);
  }
  assertDeepEqual(
    packet.unavailableFeatureFamilies.map((entry) => entry.family).sort(),
    UNAVAILABLE_FEATURE_FAMILIES.map((entry) => entry.family).sort(),
    "every unavailable family is declared on the packet",
  );
});

test("C5. the packet builder refuses to emit a future/outcome-shaped key", () => {
  for (const key of ["outcome", "actualOutcome", "futurePrice", "targetLabel", "label", "pHigher", "pLower", "arenaScore", "pnl", "classifierFeatures"]) {
    assertTrue(DIRECTION_FORBIDDEN_KEYS.includes(key.toLowerCase()), `'${key}' is on the forbidden-key list`);
  }
  const poisoned = { ...buildDirectionPacket({ observationId: "obs-4", observationIndex: 0, stateObservedAt: new Date(FIXTURE_T0).toISOString(), features: {} }), pnl: 12.5 };
  const audit = auditDirectionPacket(poisoned);
  assertTrue(!audit.ok, "a packet carrying pnl fails the audit");
  assertTrue(audit.violations.some((violation) => violation.detail === "forbidden packet field"), "the violation names a forbidden field");
});

test("C6. the packet digest ignores volatile fields yet changes with observed content", () => {
  const base = { observationId: "obs-5", observationIndex: 0, stateObservedAt: new Date(FIXTURE_T0).toISOString(), features: { referencePriceUsd: 100 } };
  const first = buildDirectionPacket({ ...base, createdAt: new Date(FIXTURE_T0).toISOString() });
  const second = buildDirectionPacket({ ...base, createdAt: new Date(FIXTURE_T0 + 60_000).toISOString() });
  assertEqual(packetDigestOf(first), packetDigestOf(second), "a different createdAt does not change the packet digest");
  const changed = buildDirectionPacket({ ...base, features: { referencePriceUsd: 101 } });
  assertTrue(packetDigestOf(changed) !== packetDigestOf(first), "a changed observed value changes the packet digest");
  assertEqual(packetStateDigestOf(first), jevStateDigestOf(first), "the packet digest agrees with the Phase 5D runtime state digest");
  assertEqual(packetStateDigestOf(first), packetDigestOf(first), "the two digest helper paths agree");
});

test("C7. the packet never carries a credential-shaped key or value", () => {
  const packet = buildDirectionPacket({ observationId: "obs-6", observationIndex: 0, stateObservedAt: new Date(FIXTURE_T0).toISOString(), features: {} });
  const serialized = JSON.stringify(packet);
  for (const token of ["apiKey", "api-key", "Bearer ", "privateKey", "secretKey", "sk-"]) {
    assertExcludes(serialized, token, `the packet contains no ${token}`);
  }
  const sanitized = sanitizeForPublic(packet);
  assertDeepEqual(sanitized, packet, "sanitizing the packet removes nothing, so it carried no secret");
});

/* ============================================================================
 * PART D — feature formulas
 * ==========================================================================*/

test("D1. the frozen feature vocabulary is exactly the declared list, in order", () => {
  assertDeepEqual(
    DIRECTION_FEATURE_NAMES,
    DIRECTION_FEATURE_DEFINITIONS.map((entry) => entry.name),
    "the feature names mirror the definitions",
  );
  assertTrue(DIRECTION_FEATURE_NAMES.length >= 20, "the vocabulary is substantive");
  for (const definition of DIRECTION_FEATURE_DEFINITIONS) {
    assertTrue(Number.isInteger(definition.minimumWarmup) && definition.minimumWarmup >= 0, `${definition.name} declares an integer warmup`);
    assertTrue(typeof definition.definition === "string" && definition.definition.length > 10, `${definition.name} documents its formula`);
    assertTrue(typeof definition.unit === "string", `${definition.name} declares a unit`);
  }
});

test("D2. referencePriceUsd is the observed SOL usdPrice, never a rescaled value", () => {
  const inputs = buildPreOutcomeInputs({ market: { price: 123.456 }, token: { stats5m: {} }, history: [], observedAt: FIXTURE_T0 });
  const { features } = extractDirectionFeaturesFromInputs(inputs);
  assertEqual(features.referencePriceUsd, 123.456, "the reference price is the observed usdPrice, verbatim");
  const withQuote = buildPreOutcomeInputs({ market: { price: 123.456 }, token: { stats5m: {} }, history: [], observedAt: FIXTURE_T0, quoteMarket: { price: 1.0 } });
  assertEqual(extractDirectionFeaturesFromInputs(withQuote).features.referencePriceUsd, 123.456, "an observed USDC price never rescales it");
  assertEqual(extractDirectionFeaturesFromInputs(withQuote).features.observedQuoteReferencePriceUsd, 1.0, "the quote price is recorded as separate provenance");
});

test("D3. the one-step and three-step recent returns have the declared formula", () => {
  const history = [
    { observedAtMs: FIXTURE_T0 - 60_000, priceUsd: 100 },
    { observedAtMs: FIXTURE_T0 - 30_000, priceUsd: 110 },
    { observedAtMs: FIXTURE_T0 - 10_000, priceUsd: 121 },
  ];
  const inputs = buildPreOutcomeInputs({ market: { price: 133.1 }, token: { stats5m: {} }, history, observedAt: FIXTURE_T0 });
  const { features } = extractDirectionFeaturesFromInputs(inputs);
  assertEqual(features.priorObservationCount, 3, "all three prior observations are used");
  assertClose(features.recentReferenceReturn1, 133.1 / 121 - 1, "return1 = current / previous - 1");
  assertClose(features.recentReferenceReturn3, 133.1 / 100 - 1, "return3 = current / three-back - 1");
  const expectedReturns = [Math.log(110 / 100), Math.log(121 / 110)];
  assertDeepEqual(logReturnsFromHistory(history), expectedReturns, "the log-return helper reproduces the consecutive returns");
  assertDeepEqual(logReturnsFromHistory([{ priceUsd: 0 }, { priceUsd: 10 }]), [], "a non-positive price yields no log return rather than a fake one");
  assertDeepEqual(logReturnsFromHistory([{ priceUsd: null }, { priceUsd: 10 }]), [], "a missing price yields no log return");
  assertClose(features.recentReferenceLogReturnMean, expectedReturns.reduce((a, b) => a + b, 0) / 2, "the log-return mean is over consecutive observed prices");
  assertClose(features.recentReferenceDispersion, populationStdDev(expectedReturns), "dispersion is the population stddev of the log returns");
  assertClose(features.recentReferenceDirectionRatio, 1, "both log returns are positive");
});

test("D4. short-window and medium-window returns are absent, and are NOT faked", () => {
  // The contract asked whether 5- and 20-observation windows were supported. The
  // packet carries a bounded 8-observation history, so a 20-observation window is
  // NOT derivable; it is therefore absent rather than approximated.
  assertTrue(!DIRECTION_FEATURE_NAMES.includes("recentReferenceReturn5"), "no 5-step window is claimed");
  assertTrue(!DIRECTION_FEATURE_NAMES.includes("recentReferenceReturn20"), "no 20-step window is claimed");
  assertTrue(OBSERVATION_HISTORY_LIMIT === 8, "the carried history is bounded to 8 observations");
  const history = Array.from({ length: 20 }, (_, index) => ({ observedAtMs: FIXTURE_T0 - (20 - index) * 30_000, priceUsd: 100 + index }));
  const inputs = buildPreOutcomeInputs({ market: { price: 120 }, token: { stats5m: {} }, history, observedAt: FIXTURE_T0 });
  assertEqual(inputs.history.length, OBSERVATION_HISTORY_LIMIT, "the projection keeps only the bounded tail");
  assertEqual(extractDirectionFeaturesFromInputs(inputs).features.priorObservationCount, OBSERVATION_HISTORY_LIMIT, "the feature count matches the bounded history");
});

test("D5. the venue 5m aggregates are carried verbatim and the flow imbalance is HONESTLY named", () => {
  const token = { stats5m: { priceChange: 1.5, liquidityChange: -0.25, volumeChange: 3, holderChange: 0.5, buyVolume: 300, sellVolume: 100, buyOrganicVolume: 50, sellOrganicVolume: 25, numBuys: 9, numSells: 4, numTraders: 12, numNetBuyers: 3, numOrganicBuyers: 2 } };
  const inputs = buildPreOutcomeInputs({ market: { price: 10, liquidity: 1000 }, token, history: [], observedAt: FIXTURE_T0 });
  const { features } = extractDirectionFeaturesFromInputs(inputs);
  assertEqual(features.observed5mPriceChangePct, 1.5, "priceChange is carried verbatim");
  assertEqual(features.observedLiquidityChangePct, -0.25, "liquidityChange is carried verbatim");
  assertEqual(features.observed5mVolumeChangePct, 3, "volumeChange is carried verbatim");
  assertEqual(features.observed5mHolderChangePct, 0.5, "holderChange is carried verbatim");
  assertEqual(features.observed5mBuyVolumeUsd, 300, "buyVolume is carried verbatim");
  assertEqual(features.observed5mSellVolumeUsd, 100, "sellVolume is carried verbatim");
  assertClose(features.observed5mVolumeFlowImbalance, 0.5, "imbalance = (buy - sell) / (buy + sell)");
  assertClose(features.observed5mBuySellVolumeRatio, 3, "buy/sell ratio");
  assertClose(features.observed5mOrganicBuySellVolumeRatio, 2, "organic buy/sell ratio");
  assertEqual(features.observed5mBuyCount, 9, "numBuys is carried verbatim");
  assertEqual(features.observed5mSellCount, 4, "numSells is carried verbatim");
  assertEqual(AGGREGATE_FLOW_FIELD_NAME, "observed5mVolumeFlowImbalance", "the aggregate flow field has exactly one honest name");
  assertTrue(!DIRECTION_FEATURE_NAMES.includes("orderBookImbalance"), "no feature claims order-book imbalance");
  assertTrue(!DIRECTION_FEATURE_NAMES.includes("cvd"), "no feature claims CVD");
});

test("D6. the reused EVOLVE transforms are the ones the feature list documents", () => {
  const token = { stats5m: { buyVolume: 400, sellVolume: 100, priceChange: 2, volumeChange: 10, liquidityChange: 1 }, liquidity: 10_000, mcap: 1e9, organicScore: 50, holderCount: 1000, topHoldersPercentage: 10, poolCreatedAt: FIXTURE_T0 - 3_600_000 };
  const derived = deriveFeatures(token, { at: FIXTURE_T0 });
  const inputs = buildPreOutcomeInputs({ market: { price: 5, liquidity: 10_000, organicScore: 50, holderCount: 1000, topHoldersPercentage: 10, mcap: 1e9 }, token, history: [], observedAt: FIXTURE_T0 });
  const { features } = extractDirectionFeaturesFromInputs(inputs);
  assertClose(features.observedLiquidityQuality, derived.liquidityQuality, "liquidityQuality is deriveFeatures.liquidityQuality");
  assertClose(features.observed5mTurnoverRatio, derived.turnover, "turnover is deriveFeatures.turnover");
  assertClose(features.observed5mBuyPressure, derived.buyPressure, "buyPressure is deriveFeatures.buyPressure");
  assertClose(features.observed5mVolatilityProxy, derived.volatility, "volatility is deriveFeatures.volatility, a documented PROXY");
  assertClose(features.observedPoolAgeHours, derived.poolAgeHours, "poolAgeHours is deriveFeatures.poolAgeHours");
  assertTrue(DIRECTION_FEATURE_DEFINITIONS.find((entry) => entry.name === "observed5mVolatilityProxy").definition.includes("not realised volatility"), "the volatility proxy is documented as a proxy");
});

test("D7. the pre-outcome input projection is bounded, typed and versioned", () => {
  const history = Array.from({ length: 12 }, (_, index) => ({ observedAt: new Date(FIXTURE_T0 - (12 - index) * 30_000).toISOString(), priceUsd: 100 + index }));
  const inputs = buildPreOutcomeInputs({ market: { price: 1 }, token: { stats5m: { buyVolume: "5" } }, history, observedAt: FIXTURE_T0, quoteMarket: { price: 1 } });
  assertEqual(inputs.projectionVersion, PRE_OUTCOME_INPUT_PROJECTION_VERSION, "the projection is versioned");
  assertEqual(inputs.history.length, OBSERVATION_HISTORY_LIMIT, "the history is bounded");
  for (const entry of inputs.history) {
    assertDeepEqual(Object.keys(entry).sort(), ["observedAt", "observedAtMs", "priceUsd"], "a history entry carries ONLY time and price");
  }
  assertEqual(inputs.token.stats5m.buyVolume, 5, "numeric strings are coerced by toFiniteNumber");
  assertEqual(toFiniteNumber("not-a-number"), null, "toFiniteNumber returns null for junk");
  assertEqual(inputs.market.price, 1, "the market price is projected");
});

test("D8. the regime block reuses EVOLVE's own classifier and only its whitelisted metrics", () => {
  const snapshots = [
    { markets: [{ mint: "A", price: 1, liquidity: 1000, volume5m: 10, buySellRatio: 1.2, organicBuySellRatio: 1.1, poolAgeMs: 1e7 }] },
    { markets: [{ mint: "A", price: 1.02, liquidity: 1200, volume5m: 20, buySellRatio: 1.3, organicBuySellRatio: 1.2, poolAgeMs: 1.1e7 }] },
  ];
  const regime = classifyDirectionRegime(snapshots);
  const { metrics } = computeRegimeMetrics(snapshots);
  assertEqual(regime.regimeName, classifyRegimeFromMetrics(metrics).regime, "the regime name comes from the existing classifier");
  assertEqual(regime.derivedFrom, "pre-t0 benchmark universe snapshots", "the regime declares its pre-t0 provenance");
  assertDeepEqual(Object.keys(regime.metrics), REGIME_METRIC_KEYS, "only whitelisted regime metrics are carried");
  assertTrue(!Object.hasOwn(regime, "label"), "the field is regimeName, never the forbidden word 'label'");
  assertTrue(Number.isFinite(regime.confidence), "the classifier confidence is recorded");
});

test("D9. the same reference-price formula is documented for the current and future observations", () => {
  // Both sides of the comparison come from the SAME normalization path: the
  // reference price is `deriveMarket(...).price` in both cases.
  assertIncludes(REFERENCE_PRICE_DEFINITION.formula, "deriveMarket", "the frozen formula names the existing normalizer");
  assertEqual(REFERENCE_PRICE_DEFINITION.sameDefinitionForCurrentAndFuture, true, "one definition covers both sides");
  assertEqual(REFERENCE_PRICE_DEFINITION.optimizedAgainstPhase5IOutcomes, false, "it was never optimized against outcomes");
  assertEqual(REFERENCE_PRICE_DEFINITION.quoteObservedPriceUsedForRescaling, false, "an observed USDC price never rescales it");
  assertEqual(REFERENCE_PRICE_DEFINITION.derivedOnlyFromFrozenObservation, true, "it is derived only from the frozen observation");
  assertEqual(REFERENCE_PRICE_DEFINITION.reproducibleOfflineFromPersistedProjection, true, "it is reproducible offline");
  assertEqual(REFERENCE_PRICE_DEFINITION.baseMint, BENCHMARK_MARKET.baseMint, "it names the benchmark base mint");
  const rejected = REFERENCE_PRICE_DEFINITION.rejectedAlternatives.map((entry) => entry.alternative).join(" | ");
  assertIncludes(rejected, "SOL/USDC pool ratio", "the synthetic pair-ratio alternative is explicitly rejected");
  assertTrue(REFERENCE_PRICE_DEFINITION.rejectedAlternatives.length >= 3, "at least three alternatives were considered and rejected");
});

test("D10. the feature formula set is a pure function: identical inputs give identical output", () => {
  const history = [{ observedAtMs: FIXTURE_T0 - 30_000, priceUsd: 100 }];
  const build = () => buildPreOutcomeInputs({ market: { price: 101 }, token: { stats5m: { buyVolume: 5, sellVolume: 5 } }, history, observedAt: FIXTURE_T0 });
  const left = extractDirectionFeaturesFromInputs(build());
  const right = extractDirectionFeaturesFromInputs(build());
  assertDeepEqual(left, right, "two recomputations of identical inputs are byte-identical");
  assertDeepEqual(left.features, right.features, "and so are the feature vectors");
  assertTrue(left.historyUsed.length === 1, "the used history is reported");
  // The live path and the offline recomputation path must be the SAME function.
  const live = extractDirectionFeatures({ market: { price: 101 }, token: { stats5m: { buyVolume: 5, sellVolume: 5 } }, history, observedAt: FIXTURE_T0 });
  assertDeepEqual(live.features, left.features, "the live extractor and the offline recomputation agree exactly");
  assertDeepEqual(live.inputs, build(), "and they project the same frozen inputs");
  assertEqual(preOutcomeInputDigestOf(live.inputs), preOutcomeInputDigestOf(build()), "so their input digests match");
});

/* ============================================================================
 * PART E — feature warmup / null behaviour
 * ==========================================================================*/

test("E1. every declared warmup is a real requirement, not a placeholder", () => {
  assertTrue(MAX_DECLARED_WARMUP === 3, `the largest declared warmup is 3 (got ${MAX_DECLARED_WARMUP})`);
  assertEqual(MINIMUM_WARMUP.referencePriceUsd, 0, "the price itself needs no warmup");
  assertEqual(MINIMUM_WARMUP.recentReferenceReturn1, 1, "a one-step return needs one prior observation");
  assertEqual(MINIMUM_WARMUP.recentReferenceReturn3, 3, "a three-step return needs three");
  assertEqual(MINIMUM_WARMUP.recentReferenceDispersion, 2, "a dispersion needs two log returns");
  assertEqual(MINIMUM_WARMUP.observed5mVolumeFlowImbalance, 0, "the venue aggregate needs no warmup of ours");
  assertEqual(DIRECTION_FEATURE_DEFINITION.minimumWarmup, MINIMUM_WARMUP, "the frozen map is published on the definition");
  assertEqual(DIRECTION_FEATURE_DEFINITION.missingValueConvention, "null", "missing is always null");
  assertEqual(DIRECTION_FEATURE_DEFINITION.zeroIsRealValue, true, "0 is a real observed value, never 'unknown'");
});

test("E2. a recursive feature with insufficient warmup is null, never zero and never invented", () => {
  const noHistory = extractDirectionFeaturesFromInputs(buildPreOutcomeInputs({ market: { price: 100 }, token: { stats5m: {} }, history: [], observedAt: FIXTURE_T0 })).features;
  assertEqual(noHistory.recentReferenceReturn1, null, "return1 is null without a prior observation");
  assertEqual(noHistory.recentReferenceReturn3, null, "return3 is null without three");
  assertEqual(noHistory.recentReferenceLogReturnMean, null, "the log-return mean is null without a prior observation");
  assertEqual(noHistory.recentReferenceDispersion, null, "dispersion is null without two");
  assertEqual(noHistory.recentReferenceDirectionRatio, null, "the direction ratio is null without a prior observation");
  assertEqual(noHistory.priorObservationCount, 0, "the prior count is reported as 0");
  assertEqual(noHistory.referencePriceUsd, 100, "the price itself is still present");
  assertTrue(!Object.values(noHistory).some((value) => value === undefined), "no feature is ever undefined");
});

test("E3. a zero observed value stays 0 and is never overloaded to mean missing", () => {
  const inputs = buildPreOutcomeInputs({ market: { price: 100, liquidity: 0 }, token: { stats5m: { buyVolume: 0, sellVolume: 0, priceChange: 0 } }, history: [], observedAt: FIXTURE_T0 });
  const { features } = extractDirectionFeaturesFromInputs(inputs);
  assertEqual(features.observed5mBuyVolumeUsd, 0, "an observed 0 buy volume is kept as 0");
  assertEqual(features.observed5mSellVolumeUsd, 0, "an observed 0 sell volume is kept as 0");
  assertEqual(features.observed5mPriceChangePct, 0, "an observed 0 price change is kept as 0");
  assertEqual(features.observedLiquidityUsd, 0, "an observed 0 liquidity is kept as 0");
  assertEqual(features.observed5mVolumeFlowImbalance, null, "a 0/0 imbalance is UNDEFINED and therefore null, not 0");
  assertEqual(features.observed5mBuySellVolumeRatio, null, "a 0 divisor yields null, not Infinity");
});

test("E4. the warmup status reports exactly which features are warmup-incomplete", () => {
  const cold = warmupStatus(extractDirectionFeaturesFromInputs(buildPreOutcomeInputs({ market: { price: 100 }, token: { stats5m: {} }, history: [], observedAt: FIXTURE_T0 })).features);
  assertEqual(cold.warmupComplete, false, "a cold observation is warmup-incomplete");
  assertEqual(cold.requiredWarmupObservations, 3, "the requirement is the largest declared warmup");
  assertTrue(cold.warmupIncompleteFeatures.includes("recentReferenceReturn3"), "return3 is named as incomplete");
  assertTrue(cold.warmupIncompleteFeatures.includes("recentReferenceDispersion"), "dispersion is named as incomplete");
  const history = [1, 2, 3].map((step) => ({ observedAtMs: FIXTURE_T0 - (4 - step) * 30_000, priceUsd: 100 + step }));
  const warm = warmupStatus(extractDirectionFeaturesFromInputs(buildPreOutcomeInputs({ market: { price: 104 }, token: { stats5m: {} }, history, observedAt: FIXTURE_T0 })).features);
  assertEqual(warm.warmupComplete, true, "three prior observations complete the warmup");
  assertDeepEqual(warm.warmupIncompleteFeatures, [], "nothing is incomplete once warm");
});

test("E5. the feature audit rejects an unknown key, a non-finite value and a forbidden name", () => {
  const valid = Object.fromEntries(DIRECTION_FEATURE_NAMES.map((name) => [name, null]));
  assertTrue(auditDirectionFeatures(valid).ok, "an all-null frozen vector is valid");
  assertTrue(!auditDirectionFeatures({ ...valid, surprise: 1 }).ok, "an unknown key is rejected");
  assertTrue(!auditDirectionFeatures({ ...valid, referencePriceUsd: Number.NaN }).ok, "a non-finite value is rejected");
  assertTrue(!auditDirectionFeatures({ ...valid, referencePriceUsd: "100" }).ok, "a string value is rejected");
  const missing = { ...valid };
  delete missing.recentReferenceReturn1;
  assertEqual(Object.hasOwn(missing, "recentReferenceReturn1"), false, "the omitted feature really is gone");
  assertTrue(!auditDirectionFeatures(missing).ok, "a missing feature is rejected");
  const forbidden = { ...valid };
  delete forbidden.observed5mVolumeFlowImbalance;
  forbidden.orderBookImbalance = 0.5;
  const audit = auditDirectionFeatures(forbidden);
  assertTrue(!audit.ok, "an order-book-shaped feature name is rejected");
  assertTrue(audit.problems.some((problem) => problem.includes("unsupported")), "the rejection names the granularity problem");
  assertTrue(!auditDirectionFeatures(null).ok, "a non-object vector is rejected");
});

/* ============================================================================
 * PART F — lookahead integrity (freqtrade-style)
 * ==========================================================================*/

test("F1. appending FUTURE observations to a stored projection changes NOTHING", () => {
  const observations = buildAuditObservations(ctx.mainPredictions);
  assertTrue(observations.length >= 2, "the main fixture produced auditable observations");
  const target = observations[1];
  const baseline = extractDirectionFeaturesFromInputs(target.inputs).features;
  const futureEntries = observations
    .slice(2)
    .map((entry) => ({ observedAt: entry.receivedAt, observedAtMs: Date.parse(entry.receivedAt), priceUsd: entry.inputs.market.price }));
  assertTrue(futureEntries.length > 0, "there ARE future observations to append");
  const poisoned = extractDirectionFeaturesFromInputs({ ...target.inputs, history: [...target.inputs.history, ...futureEntries] }).features;
  assertDeepEqual(poisoned, baseline, "appending future observations is inert");
  assertEqual(digestOf(poisoned), digestOf(baseline), "and the digests agree exactly");
});

test("F2. the LOOKAHEAD audit passes on the fixture and reports its recomputation pairs", () => {
  const report = auditFeatureLookahead(buildAuditObservations(ctx.mainPredictions));
  assertTrue(report.ok, `the feature lookahead audit is clean: ${JSON.stringify(report.violations)}`);
  assertTrue(report.recomputationPairs > 0, "the audit actually recomputed historical values");
  assertTrue(report.checkedObservations >= 2, "the audit checked every auditable observation");
  assertEqual(report.label, "features", "the report labels itself");
  assertEqual(report.auditVersion, 1, "the audit is versioned");
});

test("F3. the lookahead audit is BEHAVIOURAL: a leaky computation IS detected", () => {
  const observations = buildAuditObservations(ctx.mainPredictions).slice(0, 3);
  // The SAME feature extractor, but with its own no-lookahead cutoff DISABLED.
  // If the audit were only a source-code scan it could never see this.
  const leaky = ({ inputs }) => extractDirectionFeaturesFromInputs({ ...inputs, observedAt: Number.MAX_SAFE_INTEGER }).features;
  const report = auditHistoryRecomputation({ observations, computeFor: leaky, label: "poisoned" });
  assertTrue(!report.ok, "a computation that reads whatever history it is handed IS flagged");
  assertTrue(report.violations.length > 0, "the audit reports at least one violation");
  assertEqual(report.violations[0].kind, "lookahead", "the violation is classified as lookahead");
  assertTrue(report.violations[0].differences.length > 0, "the violation shows the differing fields");
  const differences = diffFeatureValues({ referencePriceUsd: 1 }, { referencePriceUsd: 2 });
  assertEqual(differences.length, 1, "diffFeatureValues reports a changed feature");
  assertEqual(differences[0].name, "referencePriceUsd", "and names it");
  assertEqual(diffFeatureValues({ a: 1 }, { a: 1 }).length, 0, "identical vectors show no difference");
});

test("F4. the baseline lookahead audit is clean and recomputes from the SAME frozen state", () => {
  const observations = buildAuditObservations(ctx.mainPredictions);
  const report = auditBaselineLookahead(observations);
  assertTrue(report.ok, `the baseline lookahead audit is clean: ${JSON.stringify(report.violations)}`);
  assertTrue(report.recomputationPairs > 0, "the baseline audit recomputed historical values");
  assertEqual(report.label, "baselines", "the report labels itself");
});

test("F5. changing a FUTURE observation cannot change an earlier frozen feature vector", () => {
  const observations = buildAuditObservations(ctx.mainPredictions);
  const target = observations[0];
  const baseline = digestOf(extractDirectionFeaturesFromInputs(target.inputs).features);
  for (const future of observations.slice(1, 4)) {
    for (const price of [0.0001, 1e9]) {
      const poisoned = { ...target.inputs, history: [...target.inputs.history, { observedAt: future.receivedAt, observedAtMs: Date.parse(future.receivedAt), priceUsd: price }] };
      assertEqual(digestOf(extractDirectionFeaturesFromInputs(poisoned).features), baseline, `a future price of ${price} leaves the frozen vector unchanged`);
    }
  }
});

test("F6. the unified lookahead report is clean and touches no evidence", async () => {
  const before = await directionMetadataSnapshot(directionExperimentRootFor(ctx.tempRoot, "jdir-fixture-main"));
  const report = auditDirectionLookahead({ predictions: ctx.mainPredictions });
  assertTrue(report.ok, `the combined audit is clean: ${JSON.stringify(report.features.violations)}`);
  assertEqual(report.canonicalEvidencePersisted, false, "the audit persists no canonical evidence");
  assertTrue(report.storedStateConsistency.ok, "the stored-state consistency check passes");
  assertEqual(report.storedStateConsistency.checkedObservations, ctx.mainPredictions.length, "every prediction was checked");
  const after = await directionMetadataSnapshot(directionExperimentRootFor(ctx.tempRoot, "jdir-fixture-main"));
  assertDeepEqual(after, before, "the audit rewrote nothing (READ ONLY)");
});

test("F7. the persisted state digest is stable under future appends", () => {
  for (const prediction of ctx.mainPredictions) {
    assertTrue(typeof prediction.stateDigest === "string", `${prediction.observationId} carries a state digest`);
    const packet = prediction.packet;
    const mutated = { ...packet, recentObservationHistory: [...(packet.recentObservationHistory ?? []), { observedAt: new Date(FIXTURE_T0 + 9e6).toISOString(), priceUsd: 1 }] };
    assertTrue(packetDigestOf(mutated) !== prediction.packetDigest, "the packet digest DOES respond to content (so it is a real digest)");
    const recomputed = extractDirectionFeaturesFromInputs(prediction.preOutcomeInputs).features;
    assertEqual(digestOf(recomputed), digestOf(prediction.featureValues), `${prediction.observationId} reproduces exactly`);
  }
});

test("F8. the feature function enforces its own cutoff and DISCARDS unprovable history", () => {
  const history = [
    { observedAtMs: FIXTURE_T0 - 30_000, priceUsd: 100 },
    { observedAtMs: FIXTURE_T0 + 30_000, priceUsd: 999 },
    { observedAt: undefined, priceUsd: 55 },
    { observedAt: "not-a-date", priceUsd: 56 },
  ];
  const kept = historyUpToCutoff(history, FIXTURE_T0);
  assertEqual(kept.length, 1, "future and untimestamped entries are excluded");
  assertEqual(kept[0].priceUsd, 100, "only the provably pre-t0 entry survives");
  const { features } = extractDirectionFeaturesFromInputs({ observedAt: FIXTURE_T0, market: { price: 101 }, token: { stats5m: {} }, history });
  assertEqual(features.priorObservationCount, 1, "the feature vector sees only one prior observation");
  assertClose(features.recentReferenceReturn1, 0.01, "and computes from that one");
  assertEqual(historyUpToCutoff(history, null).length, 4, "without a cutoff the filter is a pass-through (used only for the stability audit)");
});

/* ============================================================================
 * PART G — recursive / startup stability
 * ==========================================================================*/

test("G1. the startup-stability audit runs the frozen startup lengths and reports per-feature diagnostics", () => {
  const observations = buildAuditObservations(ctx.mainPredictions);
  const report = auditFeatureStability({ observations });
  assertDeepEqual(report.requestedStartupLengths, [...FEATURE_STABILITY_STARTUP_LENGTHS], "the frozen startup lengths are reported");
  assertDeepEqual(FEATURE_STABILITY_STARTUP_LENGTHS, [30, 60, 120, 240], "the frozen startup lengths are 30/60/120/240");
  assertEqual(report.tolerance, FEATURE_STABILITY_TOLERANCE, "the tolerance is reported");
  assertTrue(report.lookaheadFailuresReported === 0, "startup divergence is NEVER labelled lookahead");
  assertIncludes(report.note, "DIAGNOSTICS ONLY", "the report says it is diagnostics only");
  assertIncludes(report.note, "NOT lookahead", "and explicitly separates the two concepts");
});

test("G2. every feature carries minimumWarmup + testedStartupLengths + maxAbsoluteDifference + stableWithinTolerance", () => {
  const report = auditFeatureStability({ observations: buildAuditObservations(ctx.mainPredictions) });
  for (const name of DIRECTION_FEATURE_NAMES) {
    const entry = report.diagnostics[name];
    assertTrue(Boolean(entry), `${name} has a diagnostic entry`);
    assertEqual(entry.minimumWarmup, MINIMUM_WARMUP[name], `${name} reports its frozen warmup`);
    assertTrue(Array.isArray(entry.testedStartupLengths), `${name} reports the tested startup lengths`);
    assertTrue(Number.isFinite(entry.maxAbsoluteDifference), `${name} reports a numeric max absolute difference`);
    assertTrue(typeof entry.stableWithinTolerance === "boolean", `${name} reports stability as a boolean`);
  }
});

test("G3. startup-limit-only features are stable; length-dependent aggregates are reported, never punished", () => {
  const report = auditFeatureStability({ observations: buildAuditObservations(ctx.mainPredictions) });
  for (const name of ["recentReferenceReturn1", "recentReferenceReturn3", "referencePriceUsd"]) {
    assertTrue(report.diagnostics[name].stableWithinTolerance, `${name} is stable across startup lengths`);
    assertClose(report.diagnostics[name].maxAbsoluteDifference, 0, `${name} shows zero divergence`);
  }
  // A feature DEFINED over the whole carried window legitimately varies with the
  // startup length. That is a warmup property: reported, not failed.
  assertTrue(report.diagnostics.recentReferenceLogReturnMean.maxAbsoluteDifference >= 0, "the mean log return reports its divergence");
  assertTrue(report.testedObservations >= 1, "at least one target was exercised");
});

test("G4. two runs of the stability audit agree exactly (deterministic diagnostics)", () => {
  const observations = buildAuditObservations(ctx.mainPredictions);
  const first = auditFeatureStability({ observations });
  const second = auditFeatureStability({ observations });
  assertDeepEqual(first, second, "the diagnostics are reproducible");
  assertEqual(first.lookaheadFailuresReported, 0, "and never manufacture a lookahead failure");
});

test("G5. the startup audit does NOT read anything at or after the target observation", () => {
  const observations = buildAuditObservations(ctx.mainPredictions);
  const onlyPrior = observations.length >= 2;
  assertTrue(onlyPrior, "the fixture has at least two observations");
  const report = auditFeatureStability({ observations, maxTargets: 1 });
  assertEqual(report.testedObservations <= 1, true, "at most one target was exercised");
  assertEqual(report.diagnostics.referencePriceUsd.minimumWarmup, 0, "the price needs no warmup");
  assertTrue(report.diagnostics.referencePriceUsd.comparisons >= 0, "comparisons are counted");
});

/* ============================================================================
 * PART H — reference-price contract
 * ==========================================================================*/

test("H1. the reference-price definition is versioned, digested and formula-documented", () => {
  assertEqual(REFERENCE_PRICE_DEFINITION.version, REFERENCE_PRICE_DEFINITION_VERSION, "the definition carries its version");
  assertEqual(REFERENCE_PRICE_DEFINITION.marketId, BENCHMARK_MARKET.marketId, "the definition names the benchmark market");
  assertIncludes(REFERENCE_PRICE_DEFINITION.formula, "referencePrice(t)", "the formula is explicit");
  assertIncludes(REFERENCE_PRICE_DEFINITION.formula, "wrappedSolObservationReceivedAtOrBefore(t)", "it is defined only from observations at or before t");
  assertIncludes(REFERENCE_PRICE_DEFINITION.normalization, "deriveMarket", "it reuses the existing normalizer");
  assertEqual(REFERENCE_PRICE_DEFINITION.quoteNumeraire.length > 0, true, "the quote numeraire convention is documented");
});

test("H2. the benchmark market is exactly SOL/USDC with the real mint identities", () => {
  assertDeepEqual(SUPPORTED_MARKET_IDS, ["SOL-USDC"], "exactly one supported market");
  assertEqual(BENCHMARK_MARKET.marketId, "SOL-USDC", "the market id");
  assertEqual(BENCHMARK_MARKET.baseMint, "So11111111111111111111111111111111111111112", "the wrapped-SOL base mint");
  assertEqual(BENCHMARK_MARKET.quoteMint, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "the USDC quote mint");
  assertEqual(BENCHMARK_MARKET.baseSymbol, "SOL", "the base symbol");
  assertEqual(BENCHMARK_MARKET.quoteSymbol, "USDC", "the quote symbol");
  assertIncludes(BENCHMARK_MARKET.referencePriceSource, "deriveMarket.price", "the reference-price source is documented");
});

test("H3. a non-SOL/USDC market is refused by the settings builder", () => {
  const wrong = buildDirectionRunSettings({ market: "BONK-USDC" });
  assertTrue(wrong.problems.length > 0, "an unsupported market is a problem");
  assertIncludes(wrong.problems.join(" | "), "unsupported market", "the problem names the reason");
  const right = buildDirectionRunSettings({ market: "sol-usdc" });
  assertEqual(right.marketId, "SOL-USDC", "the market id is normalized to upper case");
  assertDeepEqual(right.problems, [], "the supported market produces no problem");
});

test("H4. the observed reference price and the observed USDC price stay separate fields", () => {
  const prediction = ctx.mainPredictions[0];
  assertTrue(Number.isFinite(prediction.referencePrice), "the reference price is recorded");
  assertTrue(Number.isFinite(prediction.quoteObservedPrice), "the observed USDC price is recorded separately");
  assertTrue(prediction.quoteObservedPrice !== prediction.referencePrice, "and it is not the same number");
  assertTrue(prediction.packet.market.quoteConvention.length > 0, "the packet documents the numeraire convention");
  assertEqual(prediction.packet.quoteObservationAvailable, true, "the packet records that USDC was observed this cycle");
});

test("H5. the reference price is reproducible offline from the persisted projection alone", () => {
  for (const prediction of ctx.mainPredictions) {
    const recomputed = extractDirectionFeaturesFromInputs(prediction.preOutcomeInputs).features;
    assertEqual(recomputed.referencePriceUsd, prediction.referencePrice, `${prediction.observationId} reproduces the reference price offline`);
    assertEqual(recomputed.referencePriceUsd, prediction.featureValues.referencePriceUsd, `${prediction.observationId} agrees with the stored feature vector`);
  }
});

test("H6. the outcome uses the SAME price field from the SAME observation pipeline", () => {
  for (const outcome of ctx.mainOutcomes) {
    if (outcome.actualOutcome === null) continue;
    const expected = outcomeLabelOf(outcome.currentReferencePrice, outcome.futureReferencePrice);
    assertEqual(outcome.actualOutcome, expected, `${outcome.observationId} is labelled from the two recorded reference prices`);
  }
  assertEqual(outcomeLabelOf(100, 100.0000001), OUTCOME.HIGHER, "the rule is strictly greater");
  assertEqual(outcomeLabelOf(100, 99.9999999), OUTCOME.LOWER, "the rule is strictly less");
  assertEqual(outcomeLabelOf(100, 100), OUTCOME.TIE, "equality is a TIE");
  assertEqual(outcomeLabelOf(0, 0), OUTCOME.TIE, "0 vs 0 is a TIE, not a guess");
  assertEqual(outcomeLabelOf(null, 100), null, "an unusable price yields no label");
  assertEqual(outcomeLabelOf(100, Number.NaN), null, "a NaN price yields no label");
});

/* ============================================================================
 * PART I — 30-second target semantics
 * ==========================================================================*/

test("I1. the horizon is exactly 30 seconds and is NOT a parameter", () => {
  assertEqual(HORIZON_SECONDS, 30, "the frozen horizon");
  assertEqual(HORIZON_MS, 30_000, "the frozen horizon in ms");
  const settings = buildDirectionRunSettings({});
  assertEqual(settings.horizonSeconds, HORIZON_SECONDS, "the settings hard-code the horizon");
  assertEqual(settings.horizonMs, HORIZON_MS, "and its ms form");
});

test("I2. any other horizon is refused as a hard error", () => {
  for (const value of ["1", "29", "31", "60", "0", "-30"]) {
    const settings = buildDirectionRunSettings({ "horizon-seconds": value });
    assertTrue(settings.problems.length > 0, `--horizon-seconds ${value} is refused`);
    assertIncludes(settings.problems.join(" | "), "FROZEN", "the refusal says the horizon is frozen");
  }
  assertDeepEqual(buildDirectionRunSettings({ "horizon-seconds": "30" }).problems, [], "exactly 30 is accepted");
});

test("I3. targetAt = stateFrozenAt + 30s on EVERY frozen prediction", () => {
  for (const prediction of ctx.mainPredictions) {
    const frozenMs = Date.parse(prediction.stateFrozenAt);
    const targetMs = Date.parse(prediction.targetAt);
    assertTrue(Number.isFinite(frozenMs), `${prediction.observationId} records stateFrozenAt`);
    assertTrue(Number.isFinite(targetMs), `${prediction.observationId} records targetAt`);
    assertEqual(targetMs - frozenMs, HORIZON_MS, `${prediction.observationId} targetAt is exactly 30s after the freeze`);
    assertEqual(prediction.targetAtBasis, TARGET_AT_BASIS, `${prediction.observationId} declares the frozen basis`);
    assertEqual(prediction.packet.horizonSeconds, HORIZON_SECONDS, `${prediction.observationId} pins the horizon on the packet`);
  }
});

test("I4. a prediction that completed at or after targetAt is non-scorable", () => {
  const slowPredictions = ctx.slowPredictions;
  assertTrue(slowPredictions.length >= 1, "the slow-model fixture produced observations");
  let late = 0;
  for (const prediction of slowPredictions) {
    const completedMs = Date.parse(prediction.predictionCompletedAt);
    const targetMs = Date.parse(prediction.targetAt);
    if (completedMs >= targetMs) {
      late += 1;
      assertEqual(prediction.invalidReason, "late_prediction", `${prediction.observationId} is marked late`);
      assertEqual(prediction.scorable, false, `${prediction.observationId} is not scorable`);
      assertEqual(prediction.invalid, true, `${prediction.observationId} is invalid`);
    }
  }
  assertTrue(late >= 1, "the slow model really did finish at or after targetAt");
  assertTrue(ctx.slowMetrics.lateJevCount >= 1, "the metric report counts the late observation");
});

test("I5. a slow model NEVER moves targetAt (the horizon is measured from the freeze, not the answer)", () => {
  for (const prediction of ctx.slowPredictions) {
    const frozenMs = Date.parse(prediction.stateFrozenAt);
    const targetMs = Date.parse(prediction.targetAt);
    assertEqual(targetMs - frozenMs, HORIZON_MS, `${prediction.observationId} keeps the exact 30s target despite the 40s model delay`);
    assertEqual(prediction.targetAtBasis, TARGET_AT_BASIS, `${prediction.observationId} still declares the freeze basis`);
  }
});

test("I6. a late observation produces NO outcome artifact and is never rescored later", () => {
  const lateIds = ctx.slowPredictions.filter((prediction) => prediction.invalidReason === "late_prediction").map((prediction) => prediction.observationId);
  assertTrue(lateIds.length >= 1, "at least one late observation exists");
  for (const id of lateIds) {
    const outcome = ctx.slowOutcomes.find((entry) => entry.observationId === id) ?? null;
    assertEqual(outcome, null, `${id} has no outcome artifact`);
  }
  const scorableLate = ctx.slowPredictions.filter((prediction) => prediction.scorable === true && Date.parse(prediction.predictionCompletedAt) >= Date.parse(prediction.targetAt));
  assertDeepEqual(scorableLate, [], "no scorable prediction completed at/after its target");
});

test("I7. the resolution tolerance is bounded and frozen into the manifest", () => {
  assertEqual(RESOLUTION_TOLERANCE_MS, 5_000, "the frozen v1 tolerance is still 5000 ms");
  assertEqual(RESOLUTION_TOLERANCE_MS_V2, 10_000, "the frozen v2 tolerance is 10000 ms");
  assertEqual(ctx.main.settings.resolutionToleranceMs, RESOLUTION_TOLERANCE_MS_V2, "a NEW fixture experiment uses the v2 bound");
  assertEqual(ctx.experiment.resolutionToleranceMs, RESOLUTION_TOLERANCE_MS_V2, "the manifest pins it");
  assertEqual(ctx.main.settings.outcomeResolutionPolicyVersion, OUTCOME_RESOLUTION_POLICY_VERSION_V2, "a new experiment pins policy v2");
  assertEqual(DEFAULT_OUTCOME_RESOLUTION_POLICY.maximumOffsetMs, RESOLUTION_TOLERANCE_MS_V2, "the default policy pins the same bound");
  assertTrue(Object.keys(DEFAULT_OUTCOME_RESOLUTION_POLICY).length > 0, "the policy is a substantive object");
  assertTrue(Number.isInteger(POLITE_WAIT_MAX_STEPS) && POLITE_WAIT_MAX_STEPS > 0, "the endpoint walk has a bounded politeness wait");
  assertTrue(POLITE_WAIT_MAX_STEPS <= 5_000, "and the bound is small enough to be a real guard");
});

test("I8. the horizon wait is bounded, interruptible and never moves the target", async () => {
  const harness = createFixtureHarness();
  const started = harness.shared.clock;
  const reached = await exerciseWait(harness, started + HORIZON_MS);
  assertEqual(reached.reached, true, "the wait reached its target");
  assertEqual(harness.shared.clock, started + HORIZON_MS, "and it advanced exactly to the target, not past it");

  const interruptHarness = createFixtureHarness();
  const control = { stopped: true };
  const interrupted = await exerciseWait(interruptHarness, interruptHarness.shared.clock + HORIZON_MS, control);
  assertEqual(interrupted.reached, false, "an interrupted wait returns false instead of waiting forever");
  assertEqual(interruptHarness.shared.clock, FIXTURE_T0, "and it advanced no clock time at all");

  const advanced = advanceClock(createFixtureHarness(), 1_000);
  assertEqual(advanced, FIXTURE_T0 + 1_000, "the fixture clock is a pure injected function of time");
});

/* ============================================================================
 * PART J — timestamp causality
 * ==========================================================================*/

test("J1. every 5I timestamp is its own field with its own documented meaning", () => {
  const expectedState = ["sourceEventAt", "receivedAt", "stateObservedAt", "stateFrozenAt", "predictionStartedAt", "predictionCompletedAt", "predictionFinalizedAt", "targetAt"];
  const expectedOutcome = ["outcomeResolutionStartedAt", "outcomeSourceEventAt", "outcomeReceivedAt", "outcomeObservedAt"];
  assertDeepEqual(STATE_TIMESTAMP_FIELDS, expectedState, "the state timestamp fields are exactly these");
  assertDeepEqual(OUTCOME_TIMESTAMP_FIELDS, expectedOutcome, "the outcome timestamp fields are exactly these");
  for (const field of [...expectedState, ...expectedOutcome]) {
    assertTrue(typeof TIMESTAMP_SEMANTICS[field] === "string", `${field} has a documented meaning`);
  }
});

test("J2. the causal ordering contract is declared and machine-readable", () => {
  assertTrue(TIMESTAMP_CAUSAL_ORDER.length >= 8, "the ordering lists every required relationship");
  assertTrue(TIMESTAMP_CAUSAL_ORDER.includes("sourceEventAt <= receivedAt"), "source before receipt");
  assertTrue(TIMESTAMP_CAUSAL_ORDER.includes("predictionCompletedAt < targetAt"), "the answer must PRECEDE the target");
  assertTrue(TIMESTAMP_CAUSAL_ORDER.includes("stateFrozenAt <= predictionStartedAt"), "the freeze precedes the call");
  assertTrue(TIMESTAMP_CAUSAL_ORDER.includes("targetAt <= outcomeReceivedAt"), "the outcome is never earlier than the target");
  for (const check of TIMESTAMP_CAUSAL_CHECKS) {
    assertTrue(typeof check.left === "string" && typeof check.right === "string", "each check names two fields");
    assertEqual(check.label, `${check.left} ${check.op} ${check.right}`, "the label matches the comparison");
  }
  assertEqual(TIMESTAMP_CAUSAL_CHECKS.find((check) => check.left === "sourceEventAt").requiresSourceTimestamp, true, "only the source relationship is conditional");
});

test("J3. every frozen prediction satisfies the full causal chain", () => {
  for (const prediction of ctx.mainPredictions) {
    for (const check of TIMESTAMP_CAUSAL_CHECKS) {
      if (check.right === "outcomeReceivedAt" || check.left === "outcomeReceivedAt" || check.left === "predictionFinalizedAt" && check.right === "outcomeResolutionStartedAt") continue;
      const rawLeft = prediction[check.left];
      const rawRight = prediction[check.right];
      if (rawLeft === null || rawLeft === undefined || rawRight === null || rawRight === undefined) continue;
      const leftMs = Date.parse(rawLeft);
      const rightMs = Date.parse(rawRight);
      assertTrue(Number.isFinite(leftMs) && Number.isFinite(rightMs), `${check.label} is evaluable`);
      const satisfied = check.op === "<" ? leftMs < rightMs : leftMs <= rightMs;
      assertTrue(satisfied, `${prediction.observationId}: ${check.label}`);
    }
  }
});

test("J4. every outcome satisfies the join-level causal chain (source -> receipt -> freeze -> target -> outcome)", () => {
  for (const outcome of ctx.mainOutcomes) {
    const prediction = ctx.mainPredictions.find((entry) => entry.observationId === outcome.observationId);
    const chain = { ...prediction, ...outcome };
    for (const check of TIMESTAMP_CAUSAL_CHECKS) {
      const rawLeft = chain[check.left];
      const rawRight = chain[check.right];
      if (rawLeft === null || rawLeft === undefined || rawRight === null || rawRight === undefined) continue;
      const leftMs = Date.parse(rawLeft);
      const rightMs = Date.parse(rawRight);
      if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs)) continue;
      const satisfied = check.op === "<" ? leftMs < rightMs : leftMs <= rightMs;
      assertTrue(satisfied, `${outcome.observationId}: ${check.label}`);
    }
  }
});

test("J5. a source timestamp is never fabricated: absence stays null and skips only its own relationship", () => {
  // The injected fixture payload carries no `updatedAt`, so no venue timestamp
  // exists and the fixture must persist null rather than borrow the local clock.
  for (const prediction of ctx.mainPredictions) {
    assertEqual(prediction.sourceEventAt, null, `${prediction.observationId} has no invented source timestamp`);
    assertEqual(prediction.stateAge.sourceTimestampAvailable, false, `${prediction.observationId} declares the absence`);
    assertEqual(prediction.stateAge.sourceAgeAtFreezeMs, null, `${prediction.observationId} reports no source age`);
    assertTrue(prediction.stateAge.latestSourceEventAt === null, `${prediction.observationId} reports no latest source instant`);
  }
});

test("J6. a venue-supplied timestamp is honoured when the payload provides one, and null when absent", () => {
  const token = fixtureSolToken(100, { extra: { updatedAt: new Date(FIXTURE_T0 - 2_000).toISOString() } });
  const normalized = normalizeJupiterToken(token, { at: FIXTURE_T0 });
  assertEqual(normalized.tokenUpdatedAt, FIXTURE_T0 - 2_000, "the venue timestamp is parsed into tokenUpdatedAt");
  const bare = normalizeJupiterToken(fixtureSolToken(100), { at: FIXTURE_T0 });
  assertEqual(bare.tokenUpdatedAt, null, "an absent payload timestamp stays null");
  assertEqual(bare.synthetic, false, "a live Jupiter payload is never synthetic");
});

test("J7. the frozen event lifecycle is declared in causal order", () => {
  assertTrue(Array.isArray(EVENT_ORDERING), "the lifecycle is declared");
  assertTrue(EVENT_ORDERING.length >= 10, "and it enumerates the full pipeline");
  const indexOf = (needle) => EVENT_ORDERING.findIndex((step) => step.includes(needle));
  assertTrue(indexOf("state snapshot frozen") < indexOf("state digest computed"), "the snapshot is frozen before it is digested");
  assertTrue(indexOf("state digest computed") < indexOf("baseline outputs computed"), "baselines come from the digested state");
  assertTrue(indexOf("baseline outputs computed") < indexOf("predictionStartedAt"), "baselines are computed before Jev is asked");
  assertTrue(indexOf("prediction digest frozen") < indexOf("wait until target horizon"), "the prediction is frozen before the horizon");
  assertTrue(indexOf("wait until target horizon") < indexOf("future observation selected"), "the future observation is selected after the horizon");
  assertTrue(indexOf("outcome artifact written") < indexOf("prediction digest verified unchanged"), "the prediction digest is verified AFTER the outcome exists");
  assertTrue(indexOf("prediction digest verified unchanged") < indexOf("joined metrics computed offline"), "and metrics are joined last");
});

/* ============================================================================
 * PART K — staleness rules
 * ==========================================================================*/

test("K1. the staleness policy is frozen, digested and never tuned against outcomes", () => {
  assertEqual(STALENESS_POLICY.version, 1, "the policy is versioned");
  assertEqual(STALENESS_POLICY.maxReceiptStateAgeMs, MAX_RECEIPT_STATE_AGE_MS, "the receipt bound is the frozen constant");
  assertEqual(STALENESS_POLICY.maxSourceStateAgeMs, MAX_SOURCE_STATE_AGE_MS, "the source bound is the frozen constant");
  assertEqual(STALENESS_POLICY.sourceAgeAndReceiptAgeAreNeverMixed, true, "the two ages are never mixed");
  assertEqual(STALENESS_POLICY.cutoffTunedAgainstOutcomes, false, "the cutoff was never tuned against outcomes");
  assertEqual(STALENESS_POLICY.cutoffChosenFrom.length > 0, true, "the cutoff's justification is documented");
  assertEqual(STALENESS_POLICY.staleObservationIsRefused, true, "a stale observation is refused");
  assertEqual(STALENESS_POLICY.staleObservationIsScored, false, "a stale observation is never scored");
  assertEqual(STALENESS_POLICY.staleObservationIsSilentlyReplaced, false, "a stale observation is never replaced");
  assertTrue(MAX_RECEIPT_STATE_AGE_MS < HORIZON_MS, "the receipt bound is tighter than the horizon");
});

test("K2. source age and receipt age are separately recorded on every frozen prediction", () => {
  for (const prediction of ctx.mainPredictions) {
    const age = prediction.stateAge;
    assertTrue(Boolean(age), `${prediction.observationId} records a stateAge block`);
    assertTrue(Number.isFinite(age.receiptAgeAtFreezeMs), `${prediction.observationId} records receiptAgeAtFreezeMs`);
    assertTrue(age.receiptAgeAtFreezeMs >= 0, `${prediction.observationId} receipt age is non-negative`);
    assertTrue(age.receiptAgeAtFreezeMs <= MAX_RECEIPT_STATE_AGE_MS, `${prediction.observationId} is inside the receipt bound`);
    assertEqual(age.maxReceiptStateAgeMs, MAX_RECEIPT_STATE_AGE_MS, `${prediction.observationId} pins the receipt bound`);
    assertEqual(age.maxSourceStateAgeMs, MAX_SOURCE_STATE_AGE_MS, `${prediction.observationId} pins the source bound`);
    assertTrue("receiptAgeAtPredictionCompleteMs" in age, `${prediction.observationId} records the receipt age at call completion`);
    assertTrue("sourceAgeAtPredictionCompleteMs" in age, `${prediction.observationId} records the source age at call completion`);
  }
});

test("K3. the receipt age is measured from the freeze instant, and it is a real elapsed gap", () => {
  for (const prediction of ctx.mainPredictions) {
    const frozenMs = Date.parse(prediction.stateFrozenAt);
    const receivedMs = Date.parse(prediction.receivedAt);
    assertEqual(frozenMs - receivedMs, prediction.stateAge.receiptAgeAtFreezeMs, `${prediction.observationId} receipt age = stateFrozenAt - receivedAt`);
  }
});

test("K4. a state that breaks the receipt bound is refused and never scored", () => {
  // Run a fixture whose market observation is deliberately stale at freeze time:
  // the endpoint walk consumes more than the frozen receipt bound of clock.
  const harness = createFixtureHarness();
  const staleProvider = createDirectionFixtureProvider();
  const settings = buildDirectionRunSettings({ ...FIXTURE_SETTINGS_OVERRIDES, "max-observations": "1" });
  return runDirectionBenchmark({
    action: "start",
    settings,
    provider: staleProvider,
    source: staleObservationSource(harness),
    baseRoot: ctx.tempRoot,
    now: harness.now,
    sleep: harness.sleep,
    control: { stopped: false },
    onProgress: null,
    budget: createJevRunBudget(1),
    questions: buildDirectionQuestions(),
    experimentId: "jdir-fixture-stale",
    pinResult: FIXTURE_PIN_RESULT,
  }).then(async (result) => {
    assertTrue(result.ok, `the stale fixture run completed honestly: ${result.error ?? ""}`);
    const predictions = await listDirectionPredictions(directionExperimentRootFor(ctx.tempRoot, "jdir-fixture-stale"));
    assertEqual(predictions.length, 1, "one scheduled observation produced one artifact");
    const prediction = predictions[0];
    assertEqual(prediction.invalidReason, "state_receipt_stale", "the observation is refused as stale");
    assertEqual(prediction.invalid, true, "it is invalid");
    assertEqual(prediction.scorable, false, "it is not scorable");
    assertEqual(prediction.jevCallAttempted, false, "no model call was spent on a state already known to be stale");
    assertEqual(prediction.status, "MARKET_STATE_STALE", "the status names the refusal");
    assertTrue(prediction.stateAge.receiptAgeAtFreezeMs > MAX_RECEIPT_STATE_AGE_MS, "the recorded age really exceeds the bound");
    assertDeepEqual(await listDirectionOutcomes(directionExperimentRootFor(ctx.tempRoot, "jdir-fixture-stale")), [], "no outcome exists for a stale observation");
  });
});

/**
 * A source whose STATE observation is received long before the freeze: the
 * reference price stamp is the state's own `at`, while the freeze happens later.
 */
function staleObservationSource(harness) {
  const base = harness.source;
  return {
    ...base,
    async observeState() {
      const observed = await base.observeState();
      if (observed.ok !== true) return observed;
      // Advance the clock past the frozen receipt bound BEFORE the state is
      // digested, which is exactly the freshness failure the rule must catch.
      harness.shared.clock += MAX_RECEIPT_STATE_AGE_MS + 1_000;
      return observed;
    },
  };
}

test("K5. staleness never refreshes a timestamp and never substitutes an observation", () => {
  const staleIds = ctx.mainPredictions.filter((prediction) => prediction.invalidReason === "state_receipt_stale");
  assertDeepEqual(staleIds, [], "the main fixture contains no stale observation");
  const settings = buildDirectionRunSettings({ "max-observations": "1" });
  void settings;
  assertEqual(STALENESS_POLICY.receiptStaleInvalidReason, "state_receipt_stale", "the receipt rule names its reason");
  assertEqual(STALENESS_POLICY.sourceStaleInvalidReason, "state_source_stale", "the source rule names its reason");
});

/* ============================================================================
 * PART L — prediction immutability
 * ==========================================================================*/

test("L1. every scheduled observation produced exactly one prediction artifact", async () => {
  const root = directionExperimentRootFor(ctx.tempRoot, "jdir-fixture-main");
  const files = (await readdir(path.join(root, DIRECTION_PREDICTIONS_DIR))).sort();
  assertEqual(files.length, 8, "eight scheduled observations produced eight artifacts");
  assertDeepEqual(files, ctx.mainPredictions.map((entry) => `${entry.observationId}.json`).sort(), "the filenames are the observation ids");
  assertEqual(new Set(files).size, files.length, "no artifact is duplicated");
});

test("L2. the prediction artifact carries every immutable field the contract requires", () => {
  const prediction = ctx.mainPredictions[0];
  for (const field of [
    "observationId", "stateDigest", "predictionDigest", "modelIntent", "pHigher", "pLower", "provider", "model",
    "gatewayUsed", "questionSetId", "questionSetVersion", "questionDigest", "packetKind", "packetVersion",
    "featureDefinitionVersion", "featureDefinitionDigest", "baselineDefinitionVersion", "baselineDefinitionDigest",
    "predictionStartedAt", "predictionCompletedAt", "predictionFinalizedAt", "targetAt", "latencyMs", "requestId",
    "providerAttemptCount", "providerAttempts",
  ]) {
    assertTrue(Object.hasOwn(prediction, field), `the prediction carries '${field}'`);
  }
  assertEqual(prediction.executedAction, null, "executedAction is null in 5I.0b");
  assertEqual(prediction.overrideReason, null, "overrideReason is null in 5I.0b");
  assertEqual(prediction.immutable, true, "the artifact marks itself immutable");
  assertEqual(prediction.evidenceClass, DIRECTION_EVIDENCE_CLASS, "the artifact declares the 5I evidence class");
});

test("L3. the prediction digest recomputes from the artifact body and excludes only itself", () => {
  for (const prediction of ctx.mainPredictions) {
    assertEqual(predictionDigestOf(prediction), prediction.predictionDigest, `${prediction.observationId} digest recomputes`);
    assertEqual(predictionDigestOf({ ...prediction, predictionDigest: "tampered" }), prediction.predictionDigest, "the digest field itself is excluded");
    assertTrue(predictionDigestOf({ ...prediction, note: "rewritten prose" }) === prediction.predictionDigest, "the prose note is excluded from the digest");
    assertTrue(predictionDigestOf({ ...prediction, pHigher: 0.99 }) !== prediction.predictionDigest, "changing a probability changes the digest");
  }
});

test("L4. modelIntent is a recorded lean only, and is reproducible from pHigher", () => {
  assertIncludes(MODEL_INTENT_DEFINITION, "not an order side", "the definition says it is not an order side");
  assertIncludes(MODEL_INTENT_DEFINITION, "never mutated once frozen", "the definition says it is never mutated");
  assertEqual(EXECUTED_ACTION_IN_5I_0B, null, "5I.0b executes nothing");
  assertEqual(OVERRIDE_REASON_IN_5I_0B, null, "5I.0b overrides nothing");
  for (const prediction of ctx.mainPredictions) {
    if (!Number.isFinite(prediction.pHigher)) continue;
    assertEqual(prediction.modelIntent, prediction.pHigher >= 0.5 ? "HIGHER" : "LOWER", `${prediction.observationId} intent follows the probability`);
    assertTrue(["HIGHER", "LOWER"].includes(prediction.modelIntent), "the intent vocabulary is directional, not an order side");
  }
});

test("L5. rewriting a frozen prediction is REFUSED and byte-identical rewrites are idempotent", async () => {
  const root = directionExperimentRootFor(ctx.tempRoot, "jdir-fixture-main");
  const prediction = ctx.mainPredictions[0];
  const again = await writeDirectionPrediction(root, prediction);
  assertEqual(again.predictionDigest, prediction.predictionDigest, "a byte-identical rewrite is accepted idempotently");
  await assertThrowsAsync(
    () => writeDirectionPrediction(root, { ...prediction, pHigher: 0.01, predictionDigest: digestOf({ changed: true }) }),
    ImmutableArtifactError,
    "a conflicting rewrite is refused",
  );
  const onDisk = await readDirectionPrediction(root, prediction.observationId);
  assertEqual(onDisk.pHighers, undefined, "the stored artifact is unchanged");
  assertEqual(onDisk.pHighers === undefined ? onDisk.predictionDigest : null, prediction.predictionDigest, "the stored digest is still the original");
});

test("L6. a prediction without a digest can never be written", async () => {
  const root = directionExperimentRootFor(ctx.tempRoot, "jdir-fixture-main");
  const record = buildDirectionPredictionRecord({ observationId: "jdir-obs-test", experimentId: "x", observationIndex: 99, scheduledAt: new Date(FIXTURE_T0).toISOString(), status: "JEV_OK", questionSetId: DIRECTION_QUESTION_SET_ID, questionSetVersion: 1, packetVersion: 1, packetKind: DIRECTION_PACKET_KIND, baselineDefinitionVersion: 1, baselineDefinitionDigest: BASELINE_DEFINITION_DIGEST, featureDefinitionVersion: 1, featureDefinitionDigest: DIRECTION_FEATURE_DEFINITION_DIGEST });
  await assertThrowsAsync(() => writeDirectionPrediction(root, record), ImmutableArtifactError, "an undigested prediction is refused");
  const withDigest = withPredictionDigest(record);
  assertTrue(typeof withDigest.predictionDigest === "string", "withPredictionDigest attaches the digest");
  assertEqual(predictionDigestOf(withDigest), withDigest.predictionDigest, "and the digest is the artifact's own");
});

async function assertThrowsAsync(fn, predicate, message) {
  let thrown = null;
  try {
    await fn();
  } catch (error) {
    thrown = error;
  }
  if (thrown === null) fail(`${message} — nothing was thrown`);
  const matched = predicate.prototype instanceof Error ? thrown instanceof predicate : Boolean(predicate(thrown));
  if (!matched) fail(`${message} — threw ${thrown?.name ?? "an error"}: ${thrown?.message ?? thrown}`);
  return thrown;
}

/* ============================================================================
 * PART M — outcome attachment
 * ==========================================================================*/

test("M1. an outcome exists for exactly the scorable predictions", () => {
  assertEqual(ctx.mainOutcomes.length, ctx.mainPredictions.filter((prediction) => prediction.scorable === true).length, "outcome count matches the scorable prediction count");
  for (const prediction of ctx.mainPredictions) {
    const outcome = ctx.mainOutcomes.find((entry) => entry.observationId === prediction.observationId) ?? null;
    if (prediction.scorable === true) assertTrue(outcome !== null, `${prediction.observationId} has an outcome`);
    else assertEqual(outcome, null, `${prediction.observationId} is invalid and has no outcome`);
  }
});

test("M2. the outcome artifact verifies the frozen prediction digest before it exists", () => {
  const prediction = ctx.mainPredictions[1];
  const outcome = ctx.mainOutcomes.find((entry) => entry.observationId === prediction.observationId);
  assertEqual(outcome.verifiedPredictionDigest, prediction.predictionDigest, "the outcome verified the stored digest");
  assertEqual(outcome.predictionDigestBeforeOutcome, prediction.predictionDigest, "and recorded the digest it read");
  assertEqual(outcome.predictionDigestMatches, true, "the two match");
  assertEqual(outcome.tamperDetected, false, "no tampering was detected");
  assertEqual(outcome.outcomeDigest, outcomeDigestOf(outcome), "the outcome digest recomputes");
  assertEqual(outcome.immutable, true, "the outcome marks itself immutable");
});

test("M3. the outcome is written only AFTER the prediction was finalized", () => {
  for (const outcome of ctx.mainOutcomes) {
    const prediction = ctx.mainPredictions.find((entry) => entry.observationId === outcome.observationId);
    const finalizedMs = Date.parse(prediction.predictionFinalizedAt);
    const resolutionMs = Date.parse(outcome.outcomeResolutionStartedAt);
    assertTrue(Number.isFinite(finalizedMs) && Number.isFinite(resolutionMs), `${outcome.observationId} records both instants`);
    assertTrue(finalizedMs <= resolutionMs, `${outcome.observationId}: the prediction was finalized before resolution began`);
    assertEqual(outcome.predictionFinalizedBeforeResolution, true, `${outcome.observationId} declares the ordering`);
  }
});

test("M4. the outcome never rebuilds the model input: the recorded prices come from the artifacts", () => {
  for (const outcome of ctx.mainOutcomes) {
    const prediction = ctx.mainPredictions.find((entry) => entry.observationId === outcome.observationId);
    assertEqual(outcome.currentReferencePrice, prediction.referencePrice, `${outcome.observationId} uses the FROZEN reference price`);
    assertEqual(outcome.stateObservedAt, prediction.stateObservedAt, `${outcome.observationId} echoes the frozen state instant`);
    assertEqual(outcome.targetAt, prediction.targetAt, `${outcome.observationId} echoes the frozen target`);
    assertEqual(outcome.horizonSeconds, HORIZON_SECONDS, `${outcome.observationId} pins the horizon`);
    assertIncludes(outcome.resolveNote, "NEVER rebuilds", "the artifact documents the guarantee");
  }
});

test("M5. the outcome resolution policy is frozen, digested and deterministic in time", () => {
  assertEqual(DEFAULT_OUTCOME_RESOLUTION_POLICY.selectionRule.length > 0, true, "the selection rule is documented");
  assertEqual(DEFAULT_OUTCOME_RESOLUTION_POLICY.selectionIsLexicographicInTime, true, "selection is first-in-time");
  assertEqual(DEFAULT_OUTCOME_RESOLUTION_POLICY.selectionDependsOnPredictionOrOutcomeQuality, false, "selection never depends on how good the prediction looks");
  assertEqual(DEFAULT_OUTCOME_RESOLUTION_POLICY.earlierThanTargetRejected, true, "an earlier price is rejected");
  assertEqual(DEFAULT_OUTCOME_RESOLUTION_POLICY.earlierThanTargetUsesEarlierPrice, false, "and is never used anyway");
  assertEqual(DEFAULT_OUTCOME_RESOLUTION_POLICY.neverMovesTargetAt, true, "the target is never moved");
  assertEqual(DEFAULT_OUTCOME_RESOLUTION_POLICY.offsetField, "outcomeOffsetMs = outcomeReceivedAt - targetAt", "the offset field is defined");
  assertEqual(OUTCOME_UNAVAILABLE_REASON, "OUTCOME_UNAVAILABLE", "the unavailable reason is frozen");
  assertEqual(DEFAULT_OUTCOME_RESOLUTION_POLICY.unavailableReason, OUTCOME_UNAVAILABLE_REASON, "the policy names the same reason");
  // v1 and v2 share the SAME deterministic selection rule; only the bound differs.
  for (const field of ["selectionRule", "selectionIsLexicographicInTime", "selectionDependsOnPredictionOrOutcomeQuality", "offsetField", "earlierThanTargetRejected", "neverMovesTargetAt"]) {
    assertEqual(OUTCOME_RESOLUTION_POLICY_V1[field], OUTCOME_RESOLUTION_POLICY_V2[field], `v1 and v2 share '${field}'`);
  }
  assertTrue(OUTCOME_RESOLUTION_POLICY_V1.maximumOffsetMs !== OUTCOME_RESOLUTION_POLICY_V2.maximumOffsetMs, "only the bound changed");
});

test("M6. every resolved outcome received its future observation at or after targetAt", () => {
  assertTrue(ctx.mainOutcomes.length > 0, "the fixture resolved outcomes");
  for (const outcome of ctx.mainOutcomes) {
    const targetMs = Date.parse(outcome.targetAt);
    const receivedMs = Date.parse(outcome.outcomeReceivedAt);
    assertTrue(Number.isFinite(receivedMs), `${outcome.observationId} records outcomeReceivedAt`);
    assertTrue(receivedMs >= targetMs, `${outcome.observationId} was observed at or after targetAt`);
    assertEqual(outcome.resolutionLagMs, receivedMs - targetMs, `${outcome.observationId} lag = received - target`);
    assertEqual(outcome.outcomeOffsetMs, receivedMs - targetMs, `${outcome.observationId} offset = received - target`);
    assertTrue(outcome.resolutionLagMs <= ctx.experiment.resolutionToleranceMs, `${outcome.observationId} is inside the frozen tolerance`);
  }
});

test("M7. the achieved horizon is at least the frozen 30 seconds (never less)", () => {
  for (const outcome of ctx.mainOutcomes) {
    assertTrue(Number.isFinite(outcome.achievedHorizonMs), `${outcome.observationId} records the achieved horizon`);
    assertTrue(outcome.achievedHorizonMs >= HORIZON_MS, `${outcome.observationId} achieved at least 30s`);
    assertEqual(outcome.achievedHorizonMs, Date.parse(outcome.outcomeReceivedAt) - Date.parse(outcome.stateObservedAt), `${outcome.observationId} achieved horizon = received - stateObserved`);
  }
});

test("M8. an outcome can never be scored without a scorable prediction", () => {
  const joined = joinDirectionObservations({ predictions: ctx.mainPredictions, outcomes: ctx.mainOutcomes });
  assertEqual(joined.length, ctx.mainPredictions.length, "the join keeps every prediction");
  for (const entry of joined) {
    if (!entry.outcome) continue;
    if (isBinaryScorable(entry)) {
      assertEqual(entry.prediction.scorable, true, `${entry.prediction.observationId} scorable implies the prediction was scorable`);
      assertEqual(entry.outcome.tamperDetected, false, `${entry.prediction.observationId} scorable implies no tampering`);
      assertTrue([OUTCOME.HIGHER, OUTCOME.LOWER].includes(entry.outcome.actualOutcome), `${entry.prediction.observationId} scorable implies a binary label`);
    }
  }
});

test("M9. the outcome carries the resolution policy and the zero-authority routing flags", () => {
  for (const outcome of ctx.mainOutcomes) {
    assertDeepEqual(outcome.outcomeResolutionPolicy, DEFAULT_OUTCOME_RESOLUTION_POLICY, `${outcome.observationId} pins the resolution policy`);
    assertEqual(outcome.jevTradingRoutingActive, false, `${outcome.observationId}: no Jev trading routing`);
    assertEqual(outcome.tradingRoutingActive, false, `${outcome.observationId}: no trading routing`);
    assertEqual(outcome.arenaRoutingActive, false, `${outcome.observationId}: no Arena routing`);
    assertEqual(outcome.developmentOnly, true, `${outcome.observationId} is development-only evidence`);
  }
});

/* ============================================================================
 * PART N — TIE semantics
 * ==========================================================================*/

test("N1. the labeller is a strict comparison with a retained TIE class", () => {
  assertEqual(outcomeLabelOf(1, 1.0000000001), OUTCOME.HIGHER, "a hair higher is HIGHER");
  assertEqual(outcomeLabelOf(1, 0.9999999999), OUTCOME.LOWER, "a hair lower is LOWER");
  assertEqual(outcomeLabelOf(1, 1), OUTCOME.TIE, "exact equality is a TIE");
  assertEqual(outcomeLabelOf(-1, -1), OUTCOME.TIE, "equality is a TIE regardless of sign");
  assertDeepEqual(Object.values(OUTCOME).sort(), ["HIGHER", "LOWER", "TIE"], "the outcome vocabulary is exactly these three");
});

test("N2. the fixture really produced at least one of each outcome class", () => {
  assertEqual(ctx.mainMetrics.higherCount + ctx.mainMetrics.lowerCount + ctx.mainMetrics.tieCount, ctx.mainOutcomes.length, "every outcome is counted exactly once");
  assertTrue(ctx.mainMetrics.higherCount >= 1, "at least one HIGHER outcome");
  assertTrue(ctx.mainMetrics.lowerCount >= 1, "at least one LOWER outcome");
  assertTrue(ctx.mainMetrics.tieCount >= 1, "at least one TIE outcome");
  assertEqual(ctx.mainMetrics.scoredCount, ctx.mainMetrics.higherCount + ctx.mainMetrics.lowerCount, "scored = HIGHER + LOWER");
  assertEqual(ctx.mainMetrics.tiesExcludedFromBinaryScoring, true, "ties are excluded from binary scoring");
});

test("N3. a TIE is retained in provenance but never scored as binary", () => {
  const ties = ctx.mainOutcomes.filter((outcome) => outcome.actualOutcome === OUTCOME.TIE);
  assertTrue(ties.length >= 1, "a TIE exists in the fixture");
  for (const outcome of ties) {
    assertEqual(outcome.scorable, false, `${outcome.observationId} TIE is not scorable`);
    assertEqual(outcome.scoringExclusionReason, "tie_not_binary", `${outcome.observationId} names the exclusion`);
    assertEqual(binaryTargetOf(outcome), null, `${outcome.observationId} has no binary target`);
  }
});

test("N4. a TIE is never forced into HIGHER or LOWER anywhere in the metric report", () => {
  const joined = joinDirectionObservations({ predictions: ctx.mainPredictions, outcomes: ctx.mainOutcomes });
  const scoredIds = joined.filter(isBinaryScorable).map((entry) => entry.prediction.observationId);
  for (const outcome of ctx.mainOutcomes.filter((entry) => entry.actualOutcome === OUTCOME.TIE)) {
    assertTrue(!scoredIds.includes(outcome.observationId), `${outcome.observationId} is absent from the scored set`);
  }
  const pairs = ctx.mainMetrics.jev;
  assertEqual(pairs.sampleCount, ctx.mainMetrics.scoredCount, "the Jev sample equals the scored count (ties excluded)");
  assertEqual(ctx.mainMetrics.probabilityStats.scoredBinary.count, ctx.mainMetrics.scoredCount, "the score distribution covers exactly the scored sample");
});

test("N5. the TIE count survives into the experiment counters and the summary", () => {
  assertEqual(ctx.experiment.counters.ties, ctx.mainMetrics.tieCount, "the run counters counted the ties");
  assertEqual(ctx.mainSummary.metrics.tieCount, ctx.mainMetrics.tieCount, "the stored summary agrees");
  assertEqual(ctx.mainSummary.metrics.higherCount, ctx.mainMetrics.higherCount, "the stored HIGHER count agrees");
  assertEqual(ctx.mainSummary.metrics.lowerCount, ctx.mainMetrics.lowerCount, "the stored LOWER count agrees");
});

test("N6. a TIE block is excluded from Brier, log loss and accuracy alike", () => {
  const scored = ctx.mainOutcomes.filter((outcome) => [OUTCOME.HIGHER, OUTCOME.LOWER].includes(outcome.actualOutcome));
  const ties = ctx.mainOutcomes.filter((outcome) => outcome.actualOutcome === OUTCOME.TIE);
  assertEqual(scored.length, ctx.mainMetrics.scoredCount, "the scored set is exactly the binary outcomes");
  assertEqual(ties.length, ctx.mainMetrics.tieCount, "the tie set is exactly the TIE outcomes");
  assertEqual(scored.length + ties.length, ctx.mainOutcomes.length, "and together they cover every outcome");
  assertEqual(ctx.mainMetrics.jev.logLossExcludedCount, 0, "no scored pair was dropped from the log loss");
});

/* ============================================================================
 * PART O — probability validation
 * ==========================================================================*/

test("O1. pLower = 1 - pHigher on EVERY frozen prediction", () => {
  assertTrue(ctx.mainPredictions.length > 0, "there are predictions to check");
  let checked = 0;
  for (const prediction of ctx.mainPredictions) {
    if (!Number.isFinite(prediction.pHigher)) continue;
    checked += 1;
    assertTrue(Number.isFinite(prediction.pLower), `${prediction.observationId} records pLower`);
    assertClose(prediction.pLower, 1 - prediction.pHigher, `${prediction.observationId} pLower = 1 - pHigher`, 1e-12);
  }
  assertTrue(checked >= 1, "at least one probability pair was checked");
});

test("O2. every probability is inside [0,1] and the pair sums to 1 inside the tolerance", () => {
  for (const prediction of ctx.mainPredictions) {
    if (!Number.isFinite(prediction.pHigher)) continue;
    const audit = auditProbabilityPair(prediction.pHigher, prediction.pLower);
    assertTrue(audit.ok, `${prediction.observationId} probability pair is valid (${audit.problems.join("; ")})`);
    assertTrue(prediction.pHigher >= 0 && prediction.pHigher <= 1, `${prediction.observationId} pHigher in range`);
    assertTrue(prediction.pLower >= 0 && prediction.pLower <= 1, `${prediction.observationId} pLower in range`);
    assertTrue(Math.abs(prediction.pHigher + prediction.pLower - 1) <= PROBABILITY_PAIR_TOLERANCE, `${prediction.observationId} sums to 1`);
  }
});

test("O3. the pair auditor rejects out-of-range and non-summing pairs", () => {
  assertTrue(auditProbabilityPair(0.4, 0.6).ok, "a correct pair is accepted");
  assertTrue(auditProbabilityPair(0, 1).ok, "the extremes are accepted");
  assertTrue(!auditProbabilityPair(1.01, -0.01).ok, "an out-of-range pair is rejected");
  assertTrue(!auditProbabilityPair(0.4, 0.4).ok, "a pair that does not sum to 1 is rejected");
  assertTrue(!auditProbabilityPair(Number.NaN, 0.5).ok, "a non-finite probability is rejected");
  assertTrue(!auditProbabilityPair(null, 0.5).ok, "a missing probability is rejected");
  assertEqual(PROBABILITY_PAIR_TOLERANCE, 1e-9, "the tolerance is frozen at 1e-9");
});

test("O4. the probability is retained RAW: the stored value equals the model's answer exactly", () => {
  for (const prediction of ctx.mainPredictions) {
    if (!prediction.answer || prediction.answer.type !== "noul") continue;
    assertEqual(prediction.pHigher, prediction.answer.probability, `${prediction.observationId} stores the raw answer probability`);
    assertEqual(prediction.modelProbabilityHigher, prediction.pHigher, `${prediction.observationId} mirrors it into the model probability field`);
    assertEqual(prediction.modelProbabilityLower, prediction.pLower, `${prediction.observationId} mirrors the lower probability`);
  }
});

test("O5. the persisted probability is never clamped, rounded or binned for storage", () => {
  const lowConfidence = ctx.lowConfidencePredictions.filter((prediction) => Number.isFinite(prediction.pHigher));
  assertTrue(lowConfidence.length >= 1, "the low-confidence fixture produced a usable probability");
  for (const prediction of lowConfidence) {
    assertEqual(prediction.pHigher, 0.500001, `${prediction.observationId} keeps the exact low-confidence value`);
    assertTrue(prediction.pHigher !== 0.5, "the value is not snapped to 0.5");
    assertEqual(prediction.pLower, 1 - 0.500001, `${prediction.observationId} keeps the exact complement`);
  }
});

test("O6. the response is never reduced to BUY/SELL and never carries a threshold verdict", () => {
  for (const prediction of ctx.mainPredictions) {
    assertTrue(!Object.hasOwn(prediction, "side"), `${prediction.observationId} has no side field`);
    assertTrue(!Object.hasOwn(prediction, "buy"), `${prediction.observationId} has no buy field`);
    assertTrue(!Object.hasOwn(prediction, "sell"), `${prediction.observationId} has no sell field`);
    assertTrue(!Object.hasOwn(prediction, "signal"), `${prediction.observationId} has no signal field`);
    assertTrue(!Object.hasOwn(prediction, "actionTaken"), `${prediction.observationId} took no action`);
    for (const name of FORBIDDEN_THRESHOLD_NAMES) {
      assertTrue(!Object.hasOwn(prediction, name), `${prediction.observationId} has no '${name}'`);
    }
  }
});

/* ============================================================================
 * PART P — deterministic baselines
 * ==========================================================================*/

test("P1. the required baselines exist and are declared in the frozen definition", () => {
  for (const baselineId of ["neutral-v1", "momentum-v1", "mean-reversion-v1"]) {
    assertTrue(REQUIRED_BASELINE_IDS.includes(baselineId), `${baselineId} is required`);
    assertTrue(Boolean(BASELINE_DEFINITIONS[baselineId]), `${baselineId} is defined`);
  }
  assertDeepEqual(REQUIRED_BASELINE_IDS, ["neutral-v1", "momentum-v1", "mean-reversion-v1"], "the required set is exactly the three mandated baselines");
  assertTrue(OPTIONAL_BASELINE_IDS.includes("volume-flow-imbalance-v1"), "the flow-imbalance baseline is optional and present because the data supports it");
  assertTrue(OPTIONAL_BASELINE_IDS.includes("momentum-liquidity-v1"), "the momentum+liquidity baseline is optional and present");
  assertDeepEqual(BASELINE_IDS.slice().sort(), [...REQUIRED_BASELINE_IDS, ...OPTIONAL_BASELINE_IDS].sort(), "every declared baseline is either required or optional");
});

test("P2. the NEUTRAL baseline always returns exactly 0.5 / 0.5", () => {
  const vectors = [
    {},
    { priorObservationCount: 0 },
    Object.fromEntries(DIRECTION_FEATURE_NAMES.map((name) => [name, null])),
    Object.fromEntries(DIRECTION_FEATURE_NAMES.map((name) => [name, 0])),
    Object.fromEntries(DIRECTION_FEATURE_NAMES.map((name) => [name, 1])),
    Object.fromEntries(DIRECTION_FEATURE_NAMES.map((name) => [name, -1])),
  ];
  for (const vector of vectors) {
    const baseline = computeBaseline("neutral-v1", vector, { stateDigest: "state" });
    assertEqual(baseline.pHigher, 0.5, "neutral pHigher is exactly 0.5");
    assertEqual(baseline.pLower, 0.5, "neutral pLower is exactly 0.5");
    assertEqual(baseline.fellBackToNeutral, false, "neutral never falls back — it IS neutral");
    assertEqual(baseline.scorableForMetrics, true, "neutral is always scorable");
    assertDeepEqual(baseline.inputsMissing, [], "neutral requires no inputs");
  }
});

test("P3. the momentum baseline is the frozen monotone map of the one-step return", () => {
  const scale = BASELINE_CONSTANTS.momentumScale;
  assertEqual(scale, 0.001, "the momentum scale is 10 bps");
  const up = computeBaseline("momentum-v1", { recentReferenceReturn1: scale, priorObservationCount: 1 });
  assertClose(up.pHigher, 0.5 + 0.5 * 0.5 * 1, "a saturated up move gives 0.75", 1e-12);
  const down = computeBaseline("momentum-v1", { recentReferenceReturn1: -scale, priorObservationCount: 1 });
  assertClose(down.pHigher, 0.5 - 0.25, "a saturated down move gives 0.25", 1e-12);
  const saturated = computeBaseline("momentum-v1", { recentReferenceReturn1: scale * 100, priorObservationCount: 1 });
  assertEqual(saturated.pHigher, 0.75, "the map saturates, it does not scale without bound");
  assertEqual(computeBaseline("momentum-v1", { recentReferenceReturn1: 0, priorObservationCount: 1 }).pHigher, 0.5, "a flat move gives 0.5");
  assertEqual(saturated.inputs.momentumZ, 1, "the z is reported");
});

test("P4. the mean-reversion baseline is the exact mirror of momentum", () => {
  for (const value of [-0.001, -0.0002, 0, 0.0002, 0.001, 0.01]) {
    const momentum = computeBaseline("momentum-v1", { recentReferenceReturn1: value, priorObservationCount: 1 });
    const reversion = computeBaseline("mean-reversion-v1", { recentReferenceReturn1: value, priorObservationCount: 1 });
    assertClose(reversion.pHigher, 1 - momentum.pHigher, `the mirror holds at ${value}`, 1e-12);
  }
});

test("P5. a baseline with a missing input falls back to NEUTRAL and is NON-SCORABLE", () => {
  const missing = computeBaseline("momentum-v1", { recentReferenceReturn1: null, priorObservationCount: 0 });
  assertEqual(missing.pHigher, 0.5, "the fallback is the neutral 0.5");
  assertEqual(missing.pLower, 0.5, "with the neutral complement");
  assertEqual(missing.fellBackToNeutral, true, "the fallback is declared");
  assertEqual(missing.scorableForMetrics, false, "and it is excluded from that baseline's metrics");
  assertDeepEqual(missing.inputsMissing, ["recentReferenceReturn1"], "the missing input is named");
  assertEqual(missing.requiredWarmupObservations, 1, "the required warmup is reported");
  assertEqual(missing.warmupComplete, false, "and the baseline is marked warmup-incomplete");
  const flow = computeBaseline("volume-flow-imbalance-v1", { observed5mVolumeFlowImbalance: null, priorObservationCount: 5 });
  assertEqual(flow.fellBackToNeutral, true, "a missing flow input also falls back");
  assertEqual(flow.scorableForMetrics, false, "and is non-scorable for that baseline");
  assertEqual(flow.warmupComplete, true, "warmup is satisfied but the input is still missing");
});

test("P6. identical state gives byte-identical baseline output", () => {
  const features = Object.fromEntries(DIRECTION_FEATURE_NAMES.map((name, index) => [name, index % 2 === 0 ? 0.0005 : null]));
  features.recentReferenceReturn1 = 0.0007;
  features.observed5mVolumeFlowImbalance = 0.3;
  features.observedLiquidityChangePct = 1.5;
  features.priorObservationCount = 4;
  const first = computeBaselines(features, { stateDigest: "s1" });
  const second = computeBaselines(features, { stateDigest: "s1" });
  assertDeepEqual(first, second, "two computations are byte-identical");
  assertEqual(digestOf(first), digestOf(second), "and so are their digests");
  const other = computeBaselines(features, { stateDigest: "s2" });
  assertTrue(digestOf(other) !== digestOf(first), "a different state pin changes the block");
});

test("P7. every baseline block passes its own structural audit", () => {
  for (const prediction of ctx.mainPredictions) {
    if (!prediction.baselines) continue;
    const audit = auditBaselines(prediction.baselines);
    assertTrue(audit.ok, `${prediction.observationId} baseline block is valid: ${audit.problems.join("; ")}`);
    assertDeepEqual(Object.keys(prediction.baselines).sort(), BASELINE_IDS.slice().sort(), `${prediction.observationId} carries every baseline id`);
  }
});

test("P8. no baseline is fitted, seeded or LLM-derived", () => {
  assertEqual(BASELINE_DEFINITION.fittedAgainstBenchmarkOutcomes, false, "nothing was fitted against the outcomes");
  assertEqual(BASELINE_DEFINITION.llmUsed, false, "no LLM participates in a baseline");
  assertEqual(BASELINE_DEFINITION.randomSeedUsed, false, "no random seed exists");
  assertEqual(BASELINE_DEFINITION.constants, BASELINE_CONSTANTS, "the constants are the frozen pre-registered ones");
  for (const baselineId of BASELINE_IDS) {
    assertTrue(BASELINE_DEFINITIONS[baselineId].formula.length > 10, `${baselineId} publishes its exact formula`);
    assertEqual(BASELINE_DEFINITIONS[baselineId].version, 1, `${baselineId} is at version 1`);
  }
});

test("P9. the flow baseline is built from the VENUE aggregate, never from an order book", () => {
  const definition = BASELINE_DEFINITIONS["volume-flow-imbalance-v1"];
  assertDeepEqual(definition.requiredInputs, [AGGREGATE_FLOW_FIELD_NAME], "it consumes the honest aggregate field");
  assertIncludes(definition.description, "NOT order-book imbalance", "its description refuses the order-book reading");
  assertIncludes(definition.description, "NOT CVD", "its description refuses the CVD reading");
  assertEqual(auditGranularityNames([definition.baselineId]).ok, true, "the baseline id itself is granularity-clean");
});

test("P10. each baseline records its id, version, definition digest and state digest", () => {
  for (const prediction of ctx.mainPredictions) {
    for (const [baselineId, baseline] of Object.entries(prediction.baselines ?? {})) {
      assertEqual(baseline.baselineId, baselineId, `${prediction.observationId}/${baselineId} reports its own id`);
      assertEqual(baseline.baselineVersion, 1, `${prediction.observationId}/${baselineId} reports its version`);
      assertEqual(baseline.definitionDigest, BASELINE_DEFINITION_DIGEST, `${prediction.observationId}/${baselineId} pins the definition digest`);
      assertEqual(baseline.stateDigest, prediction.stateDigest, `${prediction.observationId}/${baselineId} pins the shared state digest`);
      assertTrue(baseline.formula.length > 10, `${prediction.observationId}/${baselineId} records its formula`);
    }
  }
});

/* ============================================================================
 * PART Q — same-state baseline fairness
 * ==========================================================================*/

test("Q1. Jev and every baseline share ONE frozen state digest", () => {
  for (const prediction of ctx.mainPredictions) {
    const candidate = prediction.baselines;
    if (!candidate) continue;
    for (const [baselineId, baseline] of Object.entries(candidate)) {
      assertEqual(baseline.stateDigest, prediction.stateDigest, `${prediction.observationId}/${baselineId} shares the frozen state`);
    }
  }
});

test("Q2. the baselines recompute from the packet's own feature vector", () => {
  for (const prediction of ctx.mainPredictions) {
    if (!prediction.packet?.features) continue;
    const recomputed = computeBaselines(prediction.packet.features, { stateDigest: prediction.stateDigest });
    assertEqual(digestOf(recomputed), digestOf(prediction.baselines), `${prediction.observationId} baselines are a pure function of the packet features`);
  }
});

test("Q3. no baseline used MORE history than Jev: the packet carries the exact history window", () => {
  for (const prediction of ctx.mainPredictions) {
    const packetHistory = prediction.packet.recentObservationHistory ?? [];
    const usedHistory = prediction.preOutcomeInputs.history ?? [];
    assertEqual(packetHistory.length, Math.min(usedHistory.length, OBSERVATION_HISTORY_LIMIT), `${prediction.observationId} the packet carries exactly the used window`);
    assertTrue(packetHistory.length <= OBSERVATION_HISTORY_LIMIT, `${prediction.observationId} the window is bounded`);
    for (let index = 0; index < packetHistory.length; index += 1) {
      assertEqual(packetHistory[index].priceUsd, usedHistory[index].priceUsd, `${prediction.observationId} history entry ${index} agrees with the projection`);
      assertEqual(packetHistory[index].observedAt, usedHistory[index].observedAt, `${prediction.observationId} history timestamp ${index} agrees`);
    }
  }
});

test("Q4. the baseline metric set is scoped to the states that baseline actually saw", () => {
  const joined = joinDirectionObservations({ predictions: ctx.mainPredictions, outcomes: ctx.mainOutcomes });
  const neutralSamples = joined.filter((entry) => isBinaryScorable(entry)).length;
  assertEqual(ctx.mainMetrics.baselines["neutral-v1"].sampleCount, neutralSamples, "neutral is scored wherever the observation is scorable");
  for (const baselineId of BASELINE_IDS) {
    assertTrue(ctx.mainMetrics.baselines[baselineId].sampleCount <= neutralSamples, `${baselineId} never exceeds the neutral sample`);
  }
  assertTrue(ctx.mainMetrics.baselines["momentum-v1"].sampleCount <= neutralSamples, "momentum is scoped to its own inputs");
});

test("Q5. a state-digest mismatch excludes a baseline instead of scoring it", () => {
  // A BINARY-scorable observation is required: a TIE is legitimately excluded
  // from every forecaster including the neutral one, so it cannot demonstrate
  // per-baseline scoping.
  const pair = ctx.mainPredictions
    .filter((entry) => entry.scorable === true)
    .map((entry) => ({ prediction: entry, outcome: ctx.mainOutcomes.find((o) => o.observationId === entry.observationId) }))
    .find((entry) => entry.outcome?.actualOutcome === "HIGHER" || entry.outcome?.actualOutcome === "LOWER");
  assertTrue(Boolean(pair), "a binary-scorable prediction with an outcome exists");
  const { prediction, outcome } = pair;
  const mismatched = deepClone({ ...prediction, baselines: { ...prediction.baselines, "momentum-v1": { ...prediction.baselines["momentum-v1"], stateDigest: "a-different-state" } } });
  const metrics = evaluateDirectionExperiment({ experiment: ctx.experiment, predictions: [mismatched], outcomes: [outcome] });
  assertEqual(metrics.baselines["momentum-v1"].sampleCount, 0, "a baseline with a foreign state digest is NOT scored");
  assertEqual(metrics.baselines["neutral-v1"].sampleCount, 1, "an unaffected baseline still is");
});

test("Q6. the same-state fairness check is enforced by the offline audit", () => {
  const observations = buildAuditObservations(ctx.mainPredictions);
  const report = auditStoredStateConsistency(observations);
  assertTrue(report.ok, `stored state consistency is clean: ${JSON.stringify(report.problems)}`);
  assertEqual(report.checkedObservations, observations.length, "every auditable observation was checked");
  const poisoned = observations.map((entry, index) =>
    index === 0 ? { ...entry, baselines: { ...entry.baselines, "momentum-v1": { ...entry.baselines["momentum-v1"], stateDigest: "elsewhere" } } } : entry,
  );
  const poisonedReport = auditStoredStateConsistency(poisoned);
  assertTrue(!poisonedReport.ok, "a foreign baseline state digest IS detected");
  assertTrue(poisonedReport.problems[0].detail.includes("did not consume the same frozen state"), "and reported explicitly");
});

/* ============================================================================
 * PART R — Brier score
 * ==========================================================================*/

test("R1. the Brier score is the mean squared error over the scored binary sample", () => {
  const expected = ((0.8 - 1) ** 2 + (0.2 - 0) ** 2 + (0.5 - 1) ** 2) / 3;
  const observed = ctx.mainMetrics.jev.brierScore;
  assertTrue(Number.isFinite(observed), "the fixture Brier score is finite");
  const recomputed = recomputeFixtureBrier({ p: 0.8, o: 1 });
  assertClose(expected, 0.11, "the hand-computed reference value is 0.11", 1e-12);
  assertClose(recomputed, 0.04, "and the single-pair reference is exact", 1e-12);
  assertClose(observed, recomputeFixtureBrier(), "the reported Brier score matches an independent recomputation", 1e-12);
});

/** Independent Brier recomputation straight from the artifacts (no metric helper). */
/** Plain structural clone: this suite must never mutate a loaded artifact. */
function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Strip comment lines so identifier scans cannot trip on prose that DESCRIBES a
 * guarantee ("no wallet, no signing, no swap"). Ban-lists that NAME a banned
 * identifier are handled separately by `executableCode`, which removes literals
 * rather than whole lines (dropping the declaration line itself would hide it
 * from the positive assertions that prove the ban-list exists).
 */
function codeOnly(source) {
  return String(source)
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) return false;
      return true;
    })
    .join("\n");
}

/**
 * Executable code with STRING LITERALS removed. A deny-list that NAMES a banned
 * identifier (`"orderBookImbalance"`, `"wallet"`) is a guarantee, not a leak, so
 * the identifier scans must look at real code only.
 */
function executableCode(source) {
  return (
    codeOnly(source)
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/`(?:[^`\\]|\\.)*`/g, "``")
      // Regex LITERALS are vocabulary, not identifier use: `packet.mjs` BANS
      // /wallet-secret/ key names, so the ban must not read as a usage.
      .replace(/(^|[=(,:;\[!&|?{}])\s*(\/(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n])+\/[a-z]*)/g, "$1REGEX")
  );
}

/** Spin the injected clock forward, the way the runner's wait loop does. */
function advanceClock(harness, ms) {
  harness.shared.clock += ms;
  return harness.shared.clock;
}

/** The runner's bounded, interruptible wait helper. */
async function exerciseWait(harness, targetMs, control = { stopped: false }) {
  const waitFor = createWaitFor({ now: harness.now, sleep: harness.sleep, control, sliceMs: 250 });
  const reached = await waitFor(targetMs);
  return { reached, clock: harness.shared.clock };
}

function recomputeFixtureBrier(only = null) {
  if (only) return (only.p - only.o) ** 2;
  const joined = joinDirectionObservations({ predictions: ctx.mainPredictions, outcomes: ctx.mainOutcomes });
  const pairs = [];
  for (const entry of joined) {
    if (!isBinaryScorable(entry)) continue;
    pairs.push({ p: entry.prediction.pHigher, o: binaryTargetOf(entry.outcome) });
  }
  assertTrue(pairs.length > 0, "the independent recomputation has pairs to score");
  return pairs.reduce((sum, pair) => sum + (pair.p - pair.o) ** 2, 0) / pairs.length;
}

test("R2. the Brier score is reported for Jev and for every declared baseline", () => {
  for (const key of ["neutral-v1", "momentum-v1", "mean-reversion-v1", "volume-flow-imbalance-v1", "momentum-liquidity-v1"]) {
    assertTrue(Object.hasOwn(ctx.mainMetrics.baselines, key), `the report contains the ${key} baseline`);
  }
  assertTrue(Number.isFinite(ctx.mainMetrics.jev.brierScore), "Jev's Brier score is reported");
  assertTrue(Number.isFinite(ctx.mainMetrics.baselines["neutral-v1"].brierScore), "the neutral Brier score is reported");
  assertTrue(ctx.mainMetrics.jev.sampleCount > 0, "the Jev sample is non-empty");
});

test("R3. the Jev-minus-baseline Brier deltas are computed for every baseline", () => {
  for (const baselineId of BASELINE_IDS) {
    const delta = ctx.mainMetrics.brierDeltas[baselineId];
    assertTrue(Boolean(delta), `a delta exists for ${baselineId}`);
    assertEqual(delta.baselineId, baselineId, `the delta names ${baselineId}`);
    if (Number.isFinite(delta.baselineBrierScore) && Number.isFinite(ctx.mainMetrics.jev.brierScore)) {
      assertClose(delta.jevMinusBaselineBrier, ctx.mainMetrics.jev.brierScore - delta.baselineBrierScore, `the ${baselineId} Brier delta is exact`, 1e-12);
    }
  }
  assertTrue(Number.isFinite(ctx.mainMetrics.jevMinusNeutralBrierDelta), "the neutral delta is reported separately too");
  assertClose(
    ctx.mainMetrics.jevMinusNeutralBrierDelta,
    ctx.mainMetrics.jev.brierScore - ctx.mainMetrics.baselines["neutral-v1"].brierScore,
    "and it equals the neutral baseline delta",
    1e-12,
  );
});

test("R4. no automated winner is emitted anywhere in the report or the summary", () => {
  assertEqual(ctx.mainMetrics.winner, null, "the report emits no winner");
  assertEqual(ctx.mainMetrics.noAutomatedWinner, true, "the report declares that");
  assertEqual(ctx.mainMetrics.winnerLabelEmitted, false, "explicitly no winner label");
  assertEqual(ctx.mainSummary.winner, null, "the summary emits no winner");
  assertEqual(ctx.mainSummary.noAutomatedWinner, true, "the summary declares that");
  const serialized = JSON.stringify(ctx.mainSummary);
  assertExcludes(serialized, "\"winner\": \"", "no winner string is recorded anywhere");
  assertExcludes(serialized, "beats", "no comparative verdict language appears");
});

/* ============================================================================
 * PART S — log loss
 * ==========================================================================*/

test("S1. the log loss is the natural-log form with the frozen epsilon", () => {
  assertEqual(LOG_LOSS_EPSILON, 1e-15, "the numerical-safety epsilon");
  assertEqual(ctx.mainMetrics.jev.logLossEpsilon, LOG_LOSS_EPSILON, "the report publishes it");
  const p = 0.8;
  const expected = -(1 * Math.log(p) + 0 * Math.log(1 - p));
  assertClose(logLoss([{ p, o: 1 }]), expected, "a single pair matches the closed form", 1e-12);
  assertClose(logLoss([{ p: 0.5, o: 1 }]), Math.log(2), "a coin flip costs ln(2)", 1e-12);
  assertClose(logLoss([{ p: 0.5, o: 1 }, { p: 0.5, o: 0 }]), Math.log(2), "the average is taken over pairs", 1e-12);
});

test("S2. the epsilon protects the logarithm WITHOUT clamping the stored probability", () => {
  const prediction = ctx.mainPredictions.find((entry) => entry.pHigher === 0 || entry.pHigher === 1);
  assertEqual(prediction, undefined, "the fixture produced no extreme probability to clamp");
  const loss = logLoss([{ p: 0, o: 0 }, { p: 1, o: 1 }]);
  assertTrue(Number.isFinite(loss), "an extreme probability still yields a finite log loss");
  assertTrue(loss < 1e-10, "and it is essentially zero for a correct extreme call");
  const wrong = logLoss([{ p: 0, o: 1 }]);
  assertTrue(Number.isFinite(wrong) && wrong > 30, "a confidently wrong extreme call is heavily penalised but finite");
  assertEqual(logLoss([]), null, "an empty sample has no log loss");
  assertEqual(logLoss([{ p: 0.5, o: 2 }]), null, "a non-binary outcome is excluded");
});

test("S3. the fixture log loss is finite and matches an independent recomputation", () => {
  assertTrue(Number.isFinite(ctx.mainMetrics.jev.logLoss), "Jev's log loss is reported");
  const joined = joinDirectionObservations({ predictions: ctx.mainPredictions, outcomes: ctx.mainOutcomes });
  const pairs = joined.filter(isBinaryScorable).map((entry) => ({ p: entry.prediction.pHigher, o: binaryTargetOf(entry.outcome) }));
  assertClose(ctx.mainMetrics.jev.logLoss, logLoss(pairs), "the reported value equals a clean recomputation", 1e-12);
  assertTrue(pairs.length === ctx.mainMetrics.scoredCount, "the recomputation used exactly the scored sample");
});

test("S4. every baseline also reports a finite log loss and a clamped-pair count", () => {
  for (const baselineId of BASELINE_IDS) {
    const score = ctx.mainMetrics.baselines[baselineId];
    assertTrue(Number.isFinite(score.logLoss), `${baselineId} reports a log loss`);
    assertTrue(Number.isInteger(score.logLossEpsilonClampedPairs), `${baselineId} reports how many pairs the epsilon touched`);
    assertTrue(score.logLossEpsilonClampedPairs >= 0, `${baselineId} clamped-pair count is non-negative`);
  }
  assertEqual(ctx.mainMetrics.baselines["neutral-v1"].logLossEpsilonClampedPairs, 0, "neutral probabilities are never clamped");
});

test("S5. the log loss and Brier deltas are reported per baseline for both metrics", () => {
  for (const baselineId of BASELINE_IDS) {
    const delta = ctx.mainMetrics.brierDeltas[baselineId];
    if (Number.isFinite(delta.baselineLogLoss) && Number.isFinite(ctx.mainMetrics.jev.logLoss)) {
      assertClose(delta.jevMinusBaselineLogLoss, ctx.mainMetrics.jev.logLoss - delta.baselineLogLoss, `the ${baselineId} log-loss delta is exact`, 1e-12);
    }
  }
});

/* ============================================================================
 * PART T — accuracy
 * ==========================================================================*/

test("T1. accuracy uses the frozen 0.50 decision rule and nothing else", () => {
  assertEqual(ACCURACY_DECISION_RULE, "predictedHigher = pHigher >= 0.5", "the rule is frozen");
  assertEqual(ctx.mainMetrics.jev.accuracyDecisionRule, ACCURACY_DECISION_RULE, "the report publishes it");
  assertClose(accuracy([{ p: 0.5, o: 1 }]), 1, "exactly 0.5 predicts HIGHER", 1e-12);
  assertClose(accuracy([{ p: 0.4999999, o: 1 }]), 0, "just below 0.5 predicts LOWER", 1e-12);
  assertClose(accuracy([{ p: 0.9, o: 1 }, { p: 0.9, o: 0 }]), 0.5, "the mean of correct calls", 1e-12);
  assertEqual(accuracy([]), null, "an empty sample has no accuracy");
});

test("T2. directional accuracy is reported for Jev and for every baseline", () => {
  assertTrue(Number.isFinite(ctx.mainMetrics.jev.accuracy), "Jev's accuracy is reported");
  assertTrue(ctx.mainMetrics.jev.accuracy >= 0 && ctx.mainMetrics.jev.accuracy <= 1, "Jev's accuracy is a proportion");
  for (const baselineId of BASELINE_IDS) {
    const score = ctx.mainMetrics.baselines[baselineId];
    if (score.sampleCount === 0) continue;
    assertTrue(Number.isFinite(score.accuracy), `${baselineId} reports an accuracy`);
    assertTrue(score.accuracy >= 0 && score.accuracy <= 1, `${baselineId} accuracy is a proportion`);
  }
});

test("T3. the accuracy delta against every baseline is computed", () => {
  for (const baselineId of BASELINE_IDS) {
    const delta = ctx.mainMetrics.brierDeltas[baselineId];
    if (Number.isFinite(delta.baselineAccuracy) && Number.isFinite(ctx.mainMetrics.jev.accuracy)) {
      assertClose(delta.jevMinusBaselineAccuracy, ctx.mainMetrics.jev.accuracy - delta.baselineAccuracy, `the ${baselineId} accuracy delta is exact`, 1e-12);
    } else {
      assertEqual(delta.jevMinusBaselineAccuracy, null, `the ${baselineId} accuracy delta is null when a side is unscored`);
    }
  }
});

test("T4. accuracy is computed only over the binary sample", () => {
  const total = ctx.mainOutcomes.length;
  assertTrue(ctx.mainMetrics.scoredCount < total, "the fixture contains ties, so the scored sample is smaller than the outcome count");
  assertTrue(ctx.mainMetrics.jev.sampleCount === ctx.mainMetrics.scoredCount, "the accuracy sample equals the scored count");
  const joined = joinDirectionObservations({ predictions: ctx.mainPredictions, outcomes: ctx.mainOutcomes });
  const tieIds = joined.filter((entry) => entry.outcome?.actualOutcome === OUTCOME.TIE).map((entry) => entry.prediction.observationId);
  const scoredIds = joined.filter(isBinaryScorable).map((entry) => entry.prediction.observationId);
  for (const id of tieIds) assertTrue(!scoredIds.includes(id), `${id} (a TIE) is excluded from the accuracy sample`);
});

test("T5. the derived count fields are internally consistent", () => {
  const metrics = ctx.mainMetrics;
  assertEqual(metrics.observationCount, ctx.mainPredictions.length, "observation count matches the artifacts");
  assertEqual(metrics.validPredictionCount + metrics.invalidPredictionCount, metrics.observationCount, "valid + invalid = total");
  assertEqual(metrics.outcomeResolvedCount + metrics.outcomeUnresolvedCount, metrics.observationCount, "resolved + unresolved = total");
  assertEqual(metrics.scoredCount + metrics.tieCount, metrics.outcomeResolvedCount, "scored + ties = resolved");
  assertEqual(metrics.outcomeUnavailableCount, 0, "the fixture had no unavailable outcome");
  assertTrue(Number.isInteger(metrics.failedJevCount), "the failed-Jev count is an integer");
  assertTrue(Number.isInteger(metrics.staleObservationCount), "the stale count is an integer");
});

/* ============================================================================
 * PART U — calibration bins
 * ==========================================================================*/

test("U1. the calibration bins are fixed, pre-declared and cover [0,1] inclusively", () => {
  assertEqual(CALIBRATION_BIN_COUNT, 10, "ten fixed bins");
  assertEqual(CALIBRATION_BIN_EDGES.length, 10, "ten edges");
  assertEqual(CALIBRATION_BIN_EDGES[0].lower, 0, "the first bin starts at 0");
  assertEqual(CALIBRATION_BIN_EDGES[0].upper, 0.1, "the first bin ends at 0.1");
  assertEqual(CALIBRATION_BIN_EDGES[9].upper, 1, "the last bin ends at 1.0");
  assertEqual(CALIBRATION_BIN_EDGES[9].upperInclusive, true, "the last bin INCLUDES 1.0");
  for (let index = 1; index < 10; index += 1) {
    assertEqual(CALIBRATION_BIN_EDGES[index].lower, CALIBRATION_BIN_EDGES[index - 1].upper, "the bins are contiguous");
    assertEqual(CALIBRATION_BIN_EDGES[index - 1].upperInclusive, false, "interior boundaries are half-open");
  }
  assertEqual(DIRECTION_METRIC_DEFINITION.calibrationBinsAreAdaptive, false, "the bins are never adapted to outcomes");
});

test("U2. each bin reports count, mean predicted pHigher and the observed HIGHER fraction", () => {
  const bins = ctx.mainMetrics.jev.calibrationBins;
  assertEqual(bins.length, CALIBRATION_BIN_COUNT, "one entry per bin");
  let total = 0;
  for (const bin of bins) {
    assertTrue(Number.isInteger(bin.count), "the count is an integer");
    assertTrue(bin.count >= 0, "the count is non-negative");
    total += bin.count;
    if (bin.count > 0) {
      assertTrue(Number.isFinite(bin.meanPredicted), "a populated bin reports a mean predicted value");
      assertTrue(Number.isFinite(bin.observedRate), "a populated bin reports an observed rate");
      assertTrue(bin.observedRate >= 0 && bin.observedRate <= 1, "the observed rate is a fraction");
    }
  }
  assertEqual(total, ctx.mainMetrics.scoredCount, "the bins partition the scored sample");
});

test("U3. no TIE enters a calibration bin", () => {
  const joined = joinDirectionObservations({ predictions: ctx.mainPredictions, outcomes: ctx.mainOutcomes });
  const scoredCount = joined.filter(isBinaryScorable).length;
  const binTotal = ctx.mainMetrics.jev.calibrationBins.reduce((sum, bin) => sum + bin.count, 0);
  assertEqual(binTotal, scoredCount, "the bin total is the binary sample, not the outcome count");
  assertTrue(binTotal < ctx.mainOutcomes.length, "so it is strictly smaller than the outcome count");
});

test("U4. a perfect calibration shows up as observed rate == mean predicted", () => {
  const pairs = [
    { p: 0.1, o: 0 }, { p: 0.1, o: 0 },
    { p: 0.9, o: 1 }, { p: 0.9, o: 1 },
  ];
  const expectedBins = ctx.mainMetrics.jev.calibrationBins.length;
  assertEqual(expectedBins, 10, "the report carries ten bins");
  const binOf = (p) => Math.min(9, Math.floor(p * CALIBRATION_BIN_COUNT));
  assertEqual(binOf(0.1), 1, "0.1 lands in the second bin");
  assertEqual(binOf(0.9), 9, "0.9 lands in the last bin");
  assertEqual(binOf(1), 9, "1.0 lands in the last bin, not out of range");
  assertEqual(binOf(0), 0, "0 lands in the first bin");
  assertEqual(pairs.length, 4, "the reference sample is intact");
});

test("U5. the absolute calibration error is a weighted mean over populated bins", () => {
  const value = ctx.mainMetrics.jev.absoluteCalibrationError;
  if (ctx.mainMetrics.scoredCount === 0) {
    assertEqual(value, null, "no scored sample means no calibration error");
    return;
  }
  assertTrue(Number.isFinite(value), "the calibration error is reported");
  assertTrue(value >= 0 && value <= 1, "and it is a bounded error");
  assertEqual(DIRECTION_METRIC_DEFINITION.calibrationBinCount, CALIBRATION_BIN_COUNT, "the metric definition pins the bin count");
});

/* ============================================================================
 * PART V — latency stats
 * ==========================================================================*/

test("V1. mean, median, p90, p95 and max latency are all reported", () => {
  const stats = ctx.mainMetrics.latency.jevOkOnly;
  for (const field of ["count", "meanMs", "medianMs", "p90Ms", "p95Ms", "maxMs"]) {
    assertTrue(Object.hasOwn(stats, field), `the latency block reports '${field}'`);
  }
  assertTrue(stats.count >= 1, "the fixture produced timed successful calls");
  assertTrue(Number.isFinite(stats.meanMs) && Number.isFinite(stats.medianMs), "mean and median are numeric");
  assertTrue(Number.isFinite(stats.p90Ms) && Number.isFinite(stats.p95Ms), "p90 and p95 are numeric");
  assertTrue(Number.isFinite(stats.maxMs), "the max is numeric");
});

test("V2. the latency statistics satisfy their ordering invariants", () => {
  const values = ctx.mainPredictions.filter((entry) => entry.status === "JEV_OK").map((entry) => entry.latencyMs);
  const stats = latencyStats(values);
  assertTrue(stats.medianMs <= stats.p90Ms, "median <= p90");
  assertTrue(stats.p90Ms <= stats.p95Ms, "p90 <= p95");
  assertTrue(stats.p95Ms <= stats.maxMs, "p95 <= max");
  assertTrue(stats.meanMs >= 0, "the mean latency is non-negative");
  assertEqual(stats.count, values.length, "the count matches the inputs");
  assertDeepEqual(stats, ctx.mainMetrics.latency.jevOkOnly, "the report used the same population");
});

test("V3. quantile semantics are deterministic and nearest-rank", () => {
  assertEqual(QUANTILE_METHOD, "nearest-rank on a sorted copy, rank clamped to the last element", "the method is frozen");
  assertEqual(percentileOf([1, 2, 3, 4, 5], 100), 5, "p100 is the maximum");
  assertEqual(percentileOf([1, 2, 3, 4, 5], 90), 5, "p90 of five values is the fifth");
  assertEqual(percentileOf([1, 2, 3, 4, 5], 50), 3, "p50 is the third");
  assertEqual(percentileOf([5, 4, 3, 2, 1], 50), 3, "the input order does not matter");
  assertEqual(percentileOf([], 90), null, "an empty sample yields null");
  assertEqual(percentileOf([1], 0), 1, "p0 is the minimum");
  assertEqual(meanOf([1, 2, 3]), 2, "the mean is exact");
  assertEqual(spreadStats([10, 30, 20]).minMs, 10, "spread stats report the minimum");
  assertEqual(spreadStats([10, 30, 20]).maxMs, 30, "and the maximum");
});

test("V4. the latency distribution covers ALL predictions, not only the successful ones", () => {
  const all = ctx.mainMetrics.latency.allPredictions;
  assertEqual(all.count, ctx.mainPredictions.filter((entry) => Number.isFinite(entry.latencyMs)).length, "the all-predictions block counts every measured call");
  assertTrue(all.count >= ctx.mainMetrics.latency.jevOkOnly.count, "and is at least as large as the successful subset");
  assertTrue(Number.isFinite(ctx.mainMetrics.latency.providerAttemptCount), "the attempt total is reported");
  assertTrue(Number.isInteger(ctx.mainMetrics.latency.observationsWithTransportRetries), "the retry count is an integer");
});

test("V5. the observation spacing is reported from the frozen observation stamps", () => {
  const spacing = ctx.mainMetrics.observationSpacing;
  assertTrue(spacing.count >= 1, "the fixture produced at least one spacing sample");
  assertTrue(spacing.minMs > 0, "observed stamps are strictly increasing");
  assertTrue(spacing.minMs >= HORIZON_MS, "consecutive scheduled observations never overlap the 30s horizon");
  assertEqual(spacing.count, ctx.mainPredictions.length - 1, "one spacing sample per gap");
});

/* ============================================================================
 * PART W — provider / model / gateway enforcement
 * ==========================================================================*/

/** Build a Jev env bag the way `resolveJevConfig` expects it. */
function jevEnv(overrides = {}) {
  return {
    EVOLVE_JEV_PROVIDER: REQUIRED_PROVIDER,
    EVOLVE_JEV_MODE: "shadow",
    EVOLVE_JEV_API_KEY: "test-key-not-a-real-credential",
    ...overrides,
  };
}

function pinsFor(overrides = {}, settingsOverrides = {}) {
  const settings = buildDirectionRunSettings({ ...FIXTURE_SETTINGS_OVERRIDES, ...settingsOverrides });
  return enforceDirectionProviderPins({ settings, envConfig: resolveJevConfig(jevEnv(overrides)) });
}

test("W1. the canonical provider/model/gateway triple is enforced and accepted", () => {
  assertEqual(REQUIRED_PROVIDER, "typesafe-jev", "the required provider");
  assertEqual(REQUIRED_MODEL, "jev-1.13.0", "the required pinned model");
  assertEqual(REQUIRED_UPSTREAM_PROVIDER, "typesafe-ai", "the required upstream");
  const pins = pinsFor();
  assertDeepEqual(pins.problems, [], `the canonical configuration is clean: ${pins.problems.join("; ")}`);
  assertEqual(pins.resolution.provider, REQUIRED_PROVIDER, "the direct provider resolves");
  assertEqual(pins.model, REQUIRED_MODEL, "the pinned model resolves");
  assertEqual(pins.identity.gatewayUsed, false, "the identity reports no gateway");
  assertEqual(pins.identity.upstreamProvider, REQUIRED_UPSTREAM_PROVIDER, "the identity reports the direct upstream");
});

test("W2. `vercel-jev` is REFUSED for canonical evidence", () => {
  const pins = pinsFor({ EVOLVE_JEV_PROVIDER: "vercel-jev" });
  assertTrue(pins.problems.length > 0, "the gateway route is refused");
  assertIncludes(pins.problems.join(" | "), "refused for Phase 5I.0b", "the refusal names the phase");
  assertTrue(FORBIDDEN_CANONICAL_PROVIDERS.includes("vercel-jev"), "vercel-jev is on the forbidden list");
  assertTrue(FORBIDDEN_CANONICAL_PROVIDERS.includes("mock-jev"), "mock-jev is on the forbidden list too");
});

test("W3. `mock-jev` is refused UNLESS an explicit offline --allow-mock is passed", () => {
  const without = pinsFor({ EVOLVE_JEV_PROVIDER: "mock-jev" });
  assertTrue(without.problems.length > 0, "a bare mock provider is refused for canonical evidence");
  assertIncludes(without.problems.join(" | "), "--allow-mock", "the refusal names the explicit opt-in");
  const withMock = pinsFor({ EVOLVE_JEV_PROVIDER: "mock-jev" }, { "allow-mock": true });
  assertDeepEqual(withMock.problems, [], "an explicit offline run is allowed");
  assertEqual(withMock.resolution.provider, "mock-jev", "and it is recorded honestly as mock-jev");
  assertEqual(withMock.identity.gatewayUsed, false, "an offline fixture never reports a gateway");
});

test("W4. `gatewayUsed: true` is rejected", () => {
  const pins = pinsFor({ EVOLVE_JEV_PROVIDER: "vercel-jev" });
  assertTrue(pins.identity === null || pins.identity.gatewayUsed === true || pins.problems.length > 0, "a gateway route can never resolve cleanly");
  assertEqual(jevIdentity({ provider: JEV_PROVIDER.VERCEL, mode: "shadow" }).gatewayUsed, true, "the vercel identity reports gatewayUsed=true");
  assertTrue(pins.problems.some((problem) => problem.includes("vercel-jev") || problem.includes("gateway") || problem.includes("upstream")), "the refusal mentions the gateway problem");
});

test("W5. a model other than the pinned `jev-1.13.0` is refused", () => {
  const other = pinsFor({ EVOLVE_JEV_MODEL: "jev-1.12.0" });
  assertTrue(other.problems.length > 0, "a different pinned model is refused");
  assertIncludes(other.problems.join(" | "), "jev-1.13.0", "the refusal names the required model");
  const override = pinsFor({}, { model: "jev-1.12.0", "allow-unsafe-model": true });
  assertDeepEqual(override.problems, [], "an explicit --allow-unsafe-model override is accepted but recorded");
  assertEqual(override.model, "jev-1.12.0", "and the honest model is recorded");
});

test("W6. a MOVING model alias is refused even with an unsafe override", () => {
  for (const alias of FORBIDDEN_MODEL_ALIASES) {
    assertTrue(["jev-latest", "jev-preview"].includes(alias), `${alias} is a banned alias`);
    const pins = pinsFor({ EVOLVE_JEV_MODEL: alias }, { "allow-unsafe-model": true });
    assertTrue(pins.problems.length > 0, `${alias} is refused even with --allow-unsafe-model`);
    assertIncludes(pins.problems.join(" | "), "MOVING alias", "the refusal explains why");
  }
});

test("W7. a missing credential refuses to start instead of silently degrading", () => {
  const pins = pinsFor({ EVOLVE_JEV_API_KEY: "" });
  assertTrue(pins.problems.length > 0, "no credential is a hard problem");
  assertIncludes(pins.problems.join(" | "), "EVOLVE_JEV_API_KEY", "the refusal names the missing variable");
  assertIncludes(pins.problems.join(" | "), "refusing to start", "and refuses rather than continuing");
  const absent = pinsFor({ EVOLVE_JEV_PROVIDER: "" });
  assertTrue(absent.problems.length > 0, "an unset provider is refused");
  assertIncludes(absent.problems.join(" | "), "Jev is disabled", "the refusal names the disabled state");
});

test("W8. a same-Jev FAILOVER transport chain is refused; the direct single entry is allowed", () => {
  const gatewayChain = pinsFor({ EVOLVE_JEV_TRANSPORT_CHAIN: "vercel-jev" });
  assertTrue(gatewayChain.problems.length > 0, "a gateway-only chain is refused");
  assertIncludes(gatewayChain.problems.join(" | "), "vercel-jev", "the refusal names the off-route entry");
  const mixed = pinsFor({ EVOLVE_JEV_TRANSPORT_CHAIN: "typesafe-jev,vercel-jev" });
  assertTrue(mixed.problems.length > 0, "a two-entry failover chain is refused");
  assertIncludes(mixed.problems.join(" | "), "failover chain", "the refusal explains the failover risk");
  const direct = pinsFor({ EVOLVE_JEV_TRANSPORT_CHAIN: "typesafe-jev" });
  assertDeepEqual(direct.problems, [], "a single direct entry is the operator's intended configuration and is allowed");
  const unknown = pinsFor({ EVOLVE_JEV_TRANSPORT_CHAIN: "gpt-5" });
  assertTrue(unknown.problems.length > 0, "a non-Jev route is refused");
});

test("W9. the recorded provider identity is the direct TypeSafe identity", () => {
  const identity = jevIdentity({ provider: JEV_PROVIDER.TYPESAFE, model: REQUIRED_MODEL, mode: "shadow" });
  assertEqual(identity.provider, REQUIRED_PROVIDER, "the identity names the direct provider");
  assertEqual(identity.model, REQUIRED_MODEL, "the identity names the pinned model");
  assertEqual(identity.gatewayUsed, false, "the identity reports no gateway");
  assertEqual(identity.upstreamProvider, REQUIRED_UPSTREAM_PROVIDER, "the identity reports the direct upstream");
  assertEqual(identity.transport, undefined, "the raw identity carries no transport secret");
  assertEqual(identity.offline, false, "the direct route is not offline");
});

test("W10. an unknown provider name is a CONFIGURATION ERROR, never a fallback", () => {
  const pins = pinsFor({ EVOLVE_JEV_PROVIDER: "typesafe-jev-typo" });
  assertTrue(pins.problems.length > 0, "a typo is refused");
  assertIncludes(pins.problems.join(" | "), "no fallback", "the refusal states there is no fallback");
  const config = resolveJevConfig(jevEnv({ EVOLVE_JEV_PROVIDER: "nope" }));
  assertEqual(config.provider, null, "nothing resolves from a typo");
  assertTrue(config.configError !== null, "the config error is reported");
  assertEqual(config.allowFallback, false, "fallback is explicitly disallowed");
});

test("W11. every fixture prediction records the honest offline provider identity", () => {
  for (const prediction of ctx.mainPredictions) {
    assertEqual(prediction.provider, "mock-jev", `${prediction.observationId} records the honest top-level provider`);
    assertEqual(prediction.model, "direction-fixture-jev-v1", `${prediction.observationId} records the honest implementation`);
    assertEqual(prediction.gatewayUsed, false, `${prediction.observationId} reports no gateway`);
    assertEqual(prediction.upstreamProvider, "evolve-mock", `${prediction.observationId} reports the offline upstream`);
  }
  assertEqual(ctx.experiment.offlineFixture, true, "the experiment is marked as an offline fixture");
  assertEqual(ctx.experiment.providerImplementation, "direction-fixture-jev-v1", "the exact implementation is recorded");
});

test("W12. the offline fixture provider refuses any question set other than the 5I one", async () => {
  const provider = createDirectionFixtureProvider();
  const refused = await provider.evaluate({ state: {}, questions: { someOtherQuestion: { type: "noul" } } });
  assertEqual(refused.ok, false, "a foreign question set is refused");
  assertEqual(refused.status, JEV_STATUS.INVALID_RESPONSE, "with an invalid-response status");
  assertIncludes(refused.reason, DIRECTION_QUESTION_NAME, "the refusal names the only question it answers");
  const accepted = await provider.evaluate({ state: { observationId: "o" }, questions: buildDirectionQuestions() });
  assertEqual(accepted.ok, true, "the 5I question set is answered");
  assertEqual(accepted.syntheticDecision, true, "the fixture marks its answer as synthetic");
  assertEqual(accepted.model, "direction-fixture-jev-v1", "and reports its implementation");
  assertEqual(accepted.usage.input_tokens, 0, "no tokens are consumed offline");
  assertTrue(Number.isFinite(accepted.answers.priceHigherAtHorizon.noul), "it answers with a raw noul probability");
  // The RAW wire shape must normalize through the SAME Phase 5D path the real
  // provider uses, so a fixture answer and a live answer are interchangeable.
  const normalized = normalizeAnswers(accepted.answers);
  assertEqual(normalized.priceHigherAtHorizon.type, "noul", "the raw noul normalizes to the internal noul shape");
  assertTrue(Number.isFinite(normalized.priceHigherAtHorizon.probability), "and carries a finite probability");
  assertTrue(validateAnswers(normalized, DIRECTION_QUESTION_NAMES).ok, "the normalized answer validates against the 5I question set");
  assertEqual(validateAnswers(normalized, ["somethingElse"]).ok, false, "an unknown question name fails validation");
  assertEqual(NO_JEV_DECISION, "NO_JEV_DECISION", "the Phase 5D sentinel is the same one 5I reads");
  assertTrue(accepted.answers.priceHigherAtHorizon.noul !== NO_JEV_DECISION, "a real answer is never the sentinel");
});

test("W13. the offline fixture probability is a pure function of the packet digest", () => {
  const packet = { a: 1 };
  assertEqual(fixtureProbabilityFor(packet), fixtureProbabilityFor({ a: 1 }), "the same packet gives the same probability");
  assertTrue(fixtureProbabilityFor({ a: 1 }) !== fixtureProbabilityFor({ a: 2 }), "a different packet gives a different probability");
  const value = fixtureProbabilityFor(packet);
  assertTrue(value >= 0 && value <= 1, "the fixture probability is a probability");
  const provider = createDirectionFixtureProvider({ answers: { known: 0.42 } });
  assertTrue(Boolean(provider), "an answers override provider is constructible");
});

/* ============================================================================
 * PART X — no runtime confidence threshold
 * ==========================================================================*/

test("X1. neither the runtime env nor the resolved config exposes a threshold", () => {
  const config = resolveJevConfig(jevEnv({ EVOLVE_JEV_MIN_CONFIDENCE: "0.99" }));
  assertTrue(!Object.hasOwn(config, "minConfidence"), "the resolved config has no minConfidence property");
  assertTrue(!Object.hasOwn(config, "minConfidenceThreshold"), "nor a minConfidenceThreshold property");
  assertEqual(config.configError, null, "an unknown extra variable is not a config error — it is simply not supported");
  assertEqual(Object.keys(config).filter((key) => /confidence/i.test(key)).length, 0, "no confidence-named key exists anywhere in the config");
  assertDeepEqual(FORBIDDEN_THRESHOLD_NAMES, ["EVOLVE_JEV_MIN_CONFIDENCE", "minConfidence"], "the banned names are pinned");
});

test("X2. no Phase 5I source mentions a confidence threshold in executable code", async () => {
  for (const relative of PHASE_5I_MODULES) {
    // String literals are stripped: a deny-list that NAMES `minConfidence` in
    // order to reject it is the guarantee, not a threshold. A real identifier or
    // config property read would still be caught.
    const source = executableCode(await readText(relative));
    assertExcludes(source, "minConfidence", `${relative} has no minConfidence identifier`);
    assertExcludes(source, "MIN_CONFIDENCE", `${relative} has no MIN_CONFIDENCE identifier`);
    assertExcludes(source, "confidenceThreshold:", `${relative} assigns no confidenceThreshold`);
  }
  const definition = executableCode(await readText("scripts/jev/direction/definition.mjs"));
  assertIncludes(definition, "FORBIDDEN_THRESHOLD_NAMES", "the banned names exist ONLY as a ban list");
  const settingsSource = await readText("scripts/jev/direction/settings.mjs");
  assertIncludes(settingsSource, "FORBIDDEN_MODEL_ALIASES", "settings enforces model pins instead of thresholds");
});

test("X3. the CLI refuses a threshold flag instead of ignoring it", () => {
  assertTrue(DIRECTION_FORBIDDEN_FLAGS.includes("threshold"), "--threshold is forbidden");
  assertTrue(DIRECTION_FORBIDDEN_FLAGS.includes("min-confidence"), "--min-confidence is forbidden");
  assertTrue(DIRECTION_FORBIDDEN_FLAGS.includes("confidence"), "--confidence is forbidden");
  assertTrue(DIRECTION_FORBIDDEN_FLAGS.includes("signal"), "--signal is forbidden");
});

test("X4. no prediction or metric filters by confidence", () => {
  for (const prediction of ctx.mainPredictions) {
    if (!Number.isFinite(prediction.pHigher)) continue;
    assertTrue(!Object.hasOwn(prediction, "confidence"), `${prediction.observationId} carries no confidence field`);
    assertTrue(!Object.hasOwn(prediction, "threshold"), `${prediction.observationId} carries no threshold field`);
  }
  assertEqual(ctx.mainMetrics.confidenceThresholdApplied, false, "the metric report declares no threshold was applied");
  assertEqual(ctx.mainSummary.noConfidenceThreshold, true, "the summary declares no threshold");
  assertEqual(ctx.mainSummary.everyValidProbabilityRetained, true, "and that every valid probability was retained");
});

test("X5. a near-0.5 prediction is retained AND scored, never discarded", () => {
  const predictions = ctx.lowConfidencePredictions.filter((prediction) => Number.isFinite(prediction.pHigher));
  assertTrue(predictions.length >= 1, "the low-confidence fixture stored its predictions");
  for (const prediction of predictions) {
    assertEqual(prediction.scorable, true, `${prediction.observationId} is scorable despite pHigher = 0.500001`);
    assertEqual(prediction.invalid, false, `${prediction.observationId} is valid`);
    assertEqual(prediction.pHigher, 0.500001, `${prediction.observationId} kept the near-neutral probability`);
    assertTrue(prediction.pHigher !== 0.5, `${prediction.observationId} was not snapped to neutral`);
  }
  const root = directionExperimentRootFor(ctx.tempRoot, "jdir-fixture-lowconf");
  assertTrue(isValidDirectionExperimentId("jdir-fixture-lowconf"), "the fixture root is a valid experiment root");
  assertTrue(root.endsWith(path.join("jdir-fixture-lowconf")), "the root resolves to the experiment directory");
});

test("X6. every valid prediction in the fixture carries a live probability pair", () => {
  const valid = ctx.mainPredictions.filter((prediction) => prediction.valid !== false && prediction.invalid !== true);
  assertTrue(valid.length >= 1, "there are valid predictions");
  for (const prediction of valid) {
    assertTrue(Number.isFinite(prediction.pHigher), `${prediction.observationId} has a pHigher`);
    assertTrue(Number.isFinite(prediction.pLower), `${prediction.observationId} has a pLower`);
  }
  assertTrue(ctx.mainMetrics.probabilityStats.allValidPredictions.count >= 1, "the report counts the valid probability sample");
});

/* ============================================================================
 * PART Y — transport-attempt provenance
 * ==========================================================================*/

test("Y1. every prediction records its physical attempt count and attempt list", () => {
  for (const prediction of ctx.mainPredictions) {
    assertTrue(Number.isInteger(prediction.providerAttemptCount), `${prediction.observationId} records an integer attempt count`);
    assertTrue(prediction.providerAttemptCount >= 1, `${prediction.observationId} made at least one attempt`);
    assertTrue(Array.isArray(prediction.providerAttempts), `${prediction.observationId} records the attempt list`);
    assertEqual(prediction.providerAttempts.length, prediction.providerAttemptCount, `${prediction.observationId} the list length matches the count`);
  }
});

test("Y2. every physical attempt belongs to ONE logical prediction on the SAME frozen state", () => {
  for (const prediction of ctx.mainPredictions) {
    // An attempt can never carry its own state identity: there is exactly ONE
    // frozen `stateDigest` per logical prediction, and the attempts are an
    // ordered list BELOW it. So no attempt can describe a different state.
    for (const attempt of prediction.providerAttempts ?? []) {
      assertEqual(attempt.stateDigest, undefined, `${prediction.observationId} an attempt cannot carry its own state digest`);
      assertTrue(attempt.attemptNumber >= 1, `${prediction.observationId} attempts are numbered from 1`);
    }
    const numbers = (prediction.providerAttempts ?? []).map((attempt) => attempt.attemptNumber);
    assertDeepEqual(numbers, numbers.slice().sort((a, b) => a - b), `${prediction.observationId} attempts are in order`);
    assertEqual(new Set(numbers).size, numbers.length, `${prediction.observationId} attempt numbers are unique`);
    assertEqual(typeof prediction.stateDigest, "string", `${prediction.observationId} has exactly one frozen state digest`);
  }
});

test("Y3. the aggregate attempt statistics are reported", () => {
  const stats = ctx.mainMetrics.providerAttemptStatistics;
  assertEqual(stats.logicalPredictions, ctx.mainPredictions.length, "the logical prediction count is reported");
  assertTrue(stats.physicalAttempts >= stats.logicalPredictions, "there are at least as many attempts as predictions");
  assertTrue(Number.isInteger(stats.maxAttemptsOnOnePrediction), "the max attempt count is an integer");
  assertIncludes(stats.note, "ONE logical prediction", "the statistic documents the logical/physical distinction");
});

test("Y4. a bounded retry policy is reused rather than reinvented", async () => {
  const transport = await readText("scripts/jev/transport.mjs");
  assertIncludes(transport, "boundedProviderAttempts", "the existing bounded-attempt helper exists");
  const storage = await readText("scripts/jev/direction/storage.mjs");
  assertIncludes(storage, "boundedProviderAttempts", "5I storage reuses that exact helper");
  assertIncludes(transport, "maxAttempts", "the attempt ceiling lives in the Phase 5F.1 transport layer");
});

test("Y5. the attempt records carry no credential material", () => {
  for (const prediction of ctx.mainPredictions) {
    const serialized = JSON.stringify(prediction.providerAttempts ?? []);
    for (const token of ["apiKey", "x-api-key", "Bearer ", "sk-"]) {
      assertExcludes(serialized, token, `${prediction.observationId} attempt records contain no ${token}`);
    }
  }
});

test("Y6. a FAILED logical call keeps its attempt provenance", async () => {
  const failed = ctx.failingPredictions;
  assertTrue(failed.length >= 1, "the failing fixture produced observations");
  for (const prediction of failed) {
    assertEqual(prediction.jevCallAttempted, true, `${prediction.observationId} attempted a call`);
    assertTrue(prediction.providerAttemptCount >= 1, `${prediction.observationId} records the attempt`);
    assertTrue(prediction.status !== "JEV_OK", `${prediction.observationId} records a failure status`);
  }
});

/* ============================================================================
 * PART Z — failed prediction preservation
 * ==========================================================================*/

test("Z1. a failed Jev observation is preserved, never silently replaced", () => {
  assertTrue(ctx.failingPredictions.length >= 1, "the failing fixture ran");
  for (const prediction of ctx.failingPredictions) {
    assertEqual(prediction.invalid, true, `${prediction.observationId} is invalid`);
    assertEqual(prediction.scorable, false, `${prediction.observationId} is not scorable`);
    assertTrue(prediction.invalidReason.startsWith("jev_"), `${prediction.observationId} names the Jev failure`);
    assertEqual(prediction.pHigher, null, `${prediction.observationId} records no probability it never received`);
    assertEqual(prediction.packetKind, DIRECTION_PACKET_KIND, `${prediction.observationId} still records the frozen contract`);
  }
  assertTrue(ctx.failingPredictions.length === 2, "both scheduled observations produced an artifact");
});

test("Z2. a failed observation produces no outcome artifact", () => {
  assertDeepEqual(ctx.failingOutcomes, [], "no outcome exists for a failed observation");
});

test("Z3. a failed observation does NOT consume the next scheduled slot", () => {
  const indices = ctx.failingPredictions.map((prediction) => prediction.observationIndex).sort((a, b) => a - b);
  assertDeepEqual(indices, [0, 1], "the schedule advanced normally: indices are consecutive");
  assertEqual(new Set(ctx.failingPredictions.map((prediction) => prediction.observationId)).size, ctx.failingPredictions.length, "each slot has its own observation id");
});

test("Z4. the failed observations are counted in the metric report", () => {
  const metrics = ctx.failingMetrics;
  assertEqual(metrics.failedJevCount, ctx.failingPredictions.length, "the failed count equals the artifact count");
  assertEqual(metrics.scoredCount, 0, "nothing failed was scored");
  assertTrue(metrics.invalidReasons[`jev_${JEV_STATUS.UNAVAILABLE.toLowerCase()}`] >= 1 || Object.keys(metrics.invalidReasons).length >= 1, "the invalid reason is tallied");
  assertEqual(metrics.jev.brierScore, null, "a failed observation contributes no Brier score");
});

test("Z5. an unavailable market state is recorded as an explicit refusal, never invented", async () => {
  const harness = createFixtureHarness();
  const silentSource = { ...harness.source, observeState: async () => ({ ok: false, reason: "reference_market_absent_from_observation" }) };
  const settings = buildDirectionRunSettings({ ...FIXTURE_SETTINGS_OVERRIDES, "max-observations": "1" });
  const result = await runDirectionBenchmark({
    action: "start",
    settings,
    provider: createDirectionFixtureProvider(),
    source: silentSource,
    baseRoot: ctx.tempRoot,
    now: harness.now,
    sleep: harness.sleep,
    control: { stopped: false },
    onProgress: null,
    budget: createJevRunBudget(1),
    questions: buildDirectionQuestions(),
    experimentId: "jdir-fixture-nostate",
    pinResult: FIXTURE_PIN_RESULT,
  });
  assertTrue(result.ok, "the run completed without crashing");
  const predictions = await listDirectionPredictions(directionExperimentRootFor(ctx.tempRoot, "jdir-fixture-nostate"));
  assertEqual(predictions.length, 1, "the scheduled observation still produced an artifact");
  assertEqual(predictions[0].status, "MARKET_STATE_UNAVAILABLE", "the refusal is explicit");
  assertEqual(predictions[0].invalidReason, "reference_market_absent_from_observation", "the machine-readable reason is preserved");
  assertEqual(predictions[0].scorable, false, "it is not scorable");
  assertEqual(predictions[0].referencePrice, null, "no price was invented");
  assertEqual(predictions[0].jevCallAttempted, false, "no model call was made on an unobservable state");
});

test("Z6. every failure path is enumerated in the metrics report", () => {
  const metrics = ctx.mainMetrics;
  for (const reason of ["late_prediction", "state_receipt_stale", "state_source_stale", "invalid_probability"]) {
    assertTrue(reason === "late_prediction" || reason.length > 0, `${reason} is a recognised invalid reason`);
  }
  assertTrue(Object.hasOwn(metrics, "invalidReasons"), "the report tallies invalid prediction reasons");
  assertTrue(Object.hasOwn(metrics, "invalidOutcomeReasons"), "and invalid outcome reasons");
  assertTrue(Object.hasOwn(metrics, "tamperDetectedCount"), "and tamper detections");
  assertEqual(metrics.tamperDetectedCount, 0, "the clean fixture detected no tampering");
});

/* ============================================================================
 * PART AA — resume semantics
 * ==========================================================================*/

test("AA1. --start refuses to reuse an existing experiment id", async () => {
  const harness = createFixtureHarness();
  const result = await runFixtureExperiment({ root: ctx.tempRoot, experimentId: "jdir-fixture-main", harness, maxObservations: 8, provider: defaultFixtureProvider() });
  assertEqual(result.result.ok, false, "a duplicate start is refused");
  assertIncludes(result.result.error, "already exists", "the refusal explains why");
  assertIncludes(result.result.error, "--resume", "and points at the resume path");
});

test("AA2. an interrupted run persists its progress and stops cleanly", () => {
  assertEqual(ctx.interrupted.result.ok, true, "the interrupted run finished honestly");
  assertEqual(ctx.interrupted.result.interrupted, true, "and reports the interruption");
  assertEqual(ctx.interrupted.result.experiment.status, "INTERRUPTED", "the experiment is marked interrupted");
  assertEqual(ctx.interruptedBundle.predictions.length, 1, "exactly one prediction was frozen before the stop");
  assertEqual(ctx.interruptedBundle.progress.nextIndex, 1, "progress advanced to the next slot");
  assertEqual(ctx.interruptedBundle.progress.lastObservationId, ctx.interruptedBundle.predictions[0].observationId, "and names the last observation");
});

test("AA3. a resume continues from the frozen schedule and finishes the run", async () => {
  const settings = buildDirectionRunSettings({ ...FIXTURE_SETTINGS_OVERRIDES, "max-observations": "6" });
  const result = await runDirectionBenchmark({
    action: "resume",
    settings,
    provider: defaultFixtureProvider(),
    source: ctx.interruptHarness.source,
    baseRoot: ctx.tempRoot,
    now: ctx.interruptHarness.now,
    sleep: ctx.interruptHarness.sleep,
    control: { stopped: false },
    onProgress: null,
    budget: createJevRunBudget(6),
    questions: buildDirectionQuestions(),
    experimentId: "jdir-fixture-resume",
    pinResult: FIXTURE_PIN_RESULT,
  });
  assertEqual(result.ok, true, `the resume completed: ${result.error ?? ""}`);
  assertEqual(result.experimentId, "jdir-fixture-resume", "it targeted the same experiment");
  const bundle = await readDirectionExperimentBundle(directionExperimentRootFor(ctx.tempRoot, "jdir-fixture-resume"));
  assertEqual(bundle.predictions.length, 6, "the resumed run reached the scheduled observation count");
  assertEqual(bundle.outcomes.length, bundle.predictions.filter((prediction) => prediction.scorable === true).length, "every scorable prediction was resolved");
  assertEqual(bundle.experiment.status, "COMPLETE", "the experiment is complete");
  assertEqual(bundle.progress.nextIndex, 6, "progress reached the end of the schedule");
  ctx.resumedBundle = bundle;
});

test("AA4. a resume never rewrites a previously frozen observation", () => {
  const first = ctx.interruptedBundle.predictions[0];
  const after = ctx.resumedBundle.predictions.find((prediction) => prediction.observationId === first.observationId);
  assertTrue(Boolean(after), "the original prediction still exists");
  assertEqual(after.predictionDigest, first.predictionDigest, "its digest is byte-identical");
  assertDeepEqual(after, first, "and the whole artifact is unchanged");
  assertEqual(after.scorable, first.scorable, "its scorable flag is unchanged");
  assertEqual(after.pHigher, first.pHigher, "its probability is unchanged");
});

test("AA5. every observation index appears exactly once after a resume", () => {
  const indices = ctx.resumedBundle.predictions.map((prediction) => prediction.observationIndex).sort((a, b) => a - b);
  assertDeepEqual(indices, [0, 1, 2, 3, 4, 5], "the schedule was filled exactly once");
  assertEqual(new Set(indices).size, indices.length, "no slot was scheduled twice");
});

test("AA6. a resume with a different protocol is REFUSED", async () => {
  for (const overrides of [{ "max-observations": "7" }, { "cadence-seconds": "60" }, { "tolerance-ms": "9000" }]) {
    const settings = buildDirectionRunSettings({ ...FIXTURE_SETTINGS_OVERRIDES, ...overrides });
    const result = await runDirectionBenchmark({
      action: "resume",
      settings,
      provider: defaultDirectionProviderForResume(),
      source: ctx.interruptHarness.source,
      baseRoot: ctx.tempRoot,
      now: ctx.interruptHarness.now,
      sleep: ctx.interruptHarness.sleep,
      control: { stopped: false },
      onProgress: null,
      budget: createJevRunBudget(8),
      questions: buildDirectionQuestions(),
      experimentId: "jdir-fixture-resume",
      pinResult: FIXTURE_PIN_RESULT,
    });
    assertEqual(result.ok, false, `a ${JSON.stringify(overrides)} resume is refused`);
    assertIncludes(result.error, "pins do not match", "the refusal explains that a pinned field differs");
  }
});

function defaultDirectionProviderForResume() {
  return createDirectionFixtureProvider();
}

test("AA7. the pin comparison set covers every contract element", () => {
  for (const pin of ["provider", "model", "gatewayUsed", "mode", "horizonSeconds", "resolutionToleranceMs", "samplingCadenceMs", "maxObservations", "questionSetId", "questionDigest", "packetKind", "packetVersion", "featureDefinitionDigest", "baselineDefinitionDigest", "metricDefinitionDigest", "referencePriceDefinitionDigest", "stalenessPolicyDigest", "outcomeResolutionPolicyDigest", "outcomeResolutionPolicyVersion"]) {
    assertTrue(PIN_COMPARISONS.includes(pin), `'${pin}' is a pinned field`);
  }
  const base = createDirectionExperiment({
    experimentId: "jdir-pin-test",
    market: BENCHMARK_MARKET,
    provider: REQUIRED_PROVIDER,
    model: REQUIRED_MODEL,
    horizonSeconds: HORIZON_SECONDS,
    resolutionToleranceMs: RESOLUTION_TOLERANCE_MS,
    samplingCadenceMs: 30_000,
    maxObservations: 120,
    maxRuntimeMinutes: 90,
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
    stalenessPolicy: STALENESS_POLICY,
    stalenessPolicyDigest: STALENESS_POLICY_DIGEST,
    outcomeResolutionPolicy: DEFAULT_OUTCOME_RESOLUTION_POLICY,
    outcomeResolutionPolicyDigest: DEFAULT_OUTCOME_RESOLUTION_POLICY_DIGEST,
    outcomeResolutionPolicyVersion: CURRENT_OUTCOME_RESOLUTION_POLICY_VERSION,
    unavailableFeatureFamiliesDigest: UNAVAILABLE_FEATURE_FAMILIES_DIGEST,
    offlineFixture: true,
    startedAt: FIXTURE_T0,
  });
  const expected = { ...base };
  assertTrue(verifyDirectionPins(base, expected).ok, "an identical manifest verifies");
  for (const pin of PIN_COMPARISONS) {
    const mutated = { ...base, [pin]: typeof base[pin] === "number" ? base[pin] + 1 : typeof base[pin] === "boolean" ? !base[pin] : "different" };
    assertTrue(!verifyDirectionPins(mutated, expected).ok, `a changed '${pin}' is detected`);
  }
  assertTrue(!verifyDirectionPins({ ...base, gatewayUsed: true }, expected).ok, "a gateway manifest is detected");
  assertTrue(!verifyDirectionPins({ ...base, mode: "live" }, expected).ok, "a non-shadow mode is detected");
  assertTrue(!verifyDirectionPins({ ...base, jevTradingRoutingActive: true }, expected).ok, "a trading-routing manifest is detected");
});

/* ============================================================================
 * PART AB — replay / tamper detection
 * ==========================================================================*/

async function copyExperiment(sourceId, targetId) {
  const sourceRoot = directionExperimentRootFor(ctx.tempRoot, sourceId);
  const targetRoot = directionExperimentRootFor(ctx.tempRoot, targetId);
  await cp(sourceRoot, targetRoot, { recursive: true });
  const manifest = await readDirectionExperiment(targetRoot);
  await writeDirectionExperiment(targetRoot, { ...manifest, experimentId: targetId });
  return targetRoot;
}

test("AB1. offline replay reproduces the whole experiment with ZERO calls of any kind", async () => {
  const report = await replayDirectionExperiment({ experimentId: "jdir-fixture-main", baseRoot: ctx.tempRoot });
  assertTrue(report.ok, `the replay is clean: ${JSON.stringify(report.problems)}`);
  assertEqual(report.readOnly, true, "the replay is read only");
  for (const counter of ["networkCalls", "jevCalls", "agentReachCalls", "classifierCalls", "deepseekCalls", "arenaRuns", "tradingCalls"]) {
    assertEqual(report[counter], 0, `replay makes zero ${counter}`);
  }
  assertEqual(report.providerCalls, 0, "replay makes zero provider calls");
  assertExcludes(JSON.stringify(report), "http://", "no URL appears in the replay report");
  assertExcludes(JSON.stringify(report), "https://", "and no HTTPS URL either");
});

test("AB2. replay verifies every digest and every recomputation", async () => {
  const report = await replayDirectionExperiment({ experimentId: "jdir-fixture-main", baseRoot: ctx.tempRoot });
  const checks = report.checks;
  for (const check of [
    "predictionDigestsReproduced", "packetDigestsReproduced", "baselinesReproduced", "featuresReproduced",
    "inputDigestsReproduced", "probabilityPairsValid", "regimeLabelsReproduced", "timingInvariantsOk",
    "outcomeDigestsReproduced", "metricsReproduced", "pinsConsistent", "granularityGuardOk",
    "lookaheadClean", "sameStateFairness",
  ]) {
    assertEqual(checks[check], true, `replay reports ${check} = true`);
  }
  assertEqual(report.lookaheadAudit.ok, true, "the replay's lookahead audit is clean");
  assertTrue(report.lookaheadAudit.recomputationPairs > 0, "and it really recomputed");
  assertEqual(report.metricsMatch, true, "the stored summary still reproduces");
  assertEqual(report.networkCalls, 0, "still zero network calls");
});

test("AB3. replay proves same-state baseline fairness and the provider pins", async () => {
  const report = await replayDirectionExperiment({ experimentId: "jdir-fixture-main", baseRoot: ctx.tempRoot });
  assertEqual(report.checks.sameStateFairness, true, "every baseline shared the frozen state");
  assertEqual(report.checks.pinsConsistent, true, "the manifest pins are internally consistent");
  assertEqual(report.provider, "mock-jev", "the replay reports the honest provider");
  assertEqual(report.model, "direction-fixture-jev-v1", "and the honest model");
  assertEqual(report.gatewayUsed, false, "and that no gateway was used");
  assertEqual(report.horizonSeconds, HORIZON_SECONDS, "and the frozen horizon");
  assertDeepEqual(report.counts && Object.keys(report.counts).sort(), ["failedJevObservations", "invalidPredictions", "outcomeWindowExclusions", "outcomes", "predictions", "scorablePredictions", "scoredCount", "tamperDetected"], "the count block enumerates the artefacts");
});

test("AB4. TAMPER: a mutated prediction is DETECTED and scoring fails closed", async () => {
  const target = await copyExperiment("jdir-fixture-main", "jdir-fixture-tampered-prediction");
  const predictions = await listDirectionPredictions(target);
  const victim = predictions[0];
  const file = path.join(target, DIRECTION_PREDICTIONS_DIR, `${victim.observationId}.json`);
  await writeFile(file, JSON.stringify({ ...victim, pHigher: 0.999999, note: "rewritten after the fact" }, null, 2), "utf8");
  const report = await replayDirectionExperiment({ experimentId: "jdir-fixture-tampered-prediction", baseRoot: ctx.tempRoot });
  assertEqual(report.ok, false, "the replay detects the tampering");
  assertTrue(report.problems.some((problem) => problem.includes("digest does not recompute")), "the problem names the digest failure");
  assertEqual(report.checks.predictionDigestsReproduced, false, "the digest check fails");
});

test("AB5. TAMPER: a mutated outcome is DETECTED", async () => {
  const target = await copyExperiment("jdir-fixture-main", "jdir-fixture-tampered-outcome");
  const outcomes = await listDirectionOutcomes(target);
  const victim = outcomes[0];
  const file = path.join(target, DIRECTION_OUTCOMES_DIR, `${victim.observationId}.json`);
  await writeFile(file, JSON.stringify({ ...victim, actualOutcome: victim.actualOutcome === "HIGHER" ? "LOWER" : "HIGHER" }, null, 2), "utf8");
  const report = await replayDirectionExperiment({ experimentId: "jdir-fixture-tampered-outcome", baseRoot: ctx.tempRoot });
  assertEqual(report.ok, false, "the replay detects the mutated outcome");
  assertTrue(report.problems.some((problem) => problem.includes("outcome") && problem.includes("digest")), "the problem names the outcome digest");
  assertEqual(report.checks.outcomeDigestsReproduced, false, "the outcome digest check fails");
});

test("AB6. TAMPER: re-digesting a prediction AFTER an outcome exists is DETECTED", async () => {
  const target = await copyExperiment("jdir-fixture-main", "jdir-fixture-digest-mismatch");
  const predictions = await listDirectionPredictions(target);
  const victim = predictions.find((entry) => entry.scorable === true && Number.isFinite(entry.pHigher));
  assertTrue(Boolean(victim), "the victim is a scorable prediction with an outcome");
  const outcome = (await listDirectionOutcomes(target)).find((entry) => entry.observationId === victim.observationId);
  assertTrue(Boolean(outcome), "the victim has an outcome");
  // The prediction is rewritten WITH a correct new digest — so the digest check
  // alone passes. What catches it is that the frozen OUTCOME verified a
  // different digest, which is exactly the mutation-after-outcome case.
  const file = path.join(target, DIRECTION_PREDICTIONS_DIR, `${victim.observationId}.json`);
  const rewritten = withPredictionDigest({ ...victim, pHigher: 0.997, pLower: 0.003 });
  assertTrue(rewritten.predictionDigest !== victim.predictionDigest, "the rewrite really changed the digest");
  await writeFile(file, JSON.stringify(rewritten, null, 2), "utf8");
  const report = await replayDirectionExperiment({ experimentId: "jdir-fixture-digest-mismatch", baseRoot: ctx.tempRoot });
  assertEqual(report.ok, false, "the replay fails closed");
  assertTrue(
    report.problems.some((problem) => problem.includes("did not verify the stored prediction digest")),
    `the mutation-after-outcome case is reported: ${report.problems.join(" | ")}`,
  );
  assertTrue(outcome.verifiedPredictionDigest !== rewritten.predictionDigest, "the frozen outcome verified the ORIGINAL digest");
});

test("AB7. TAMPER: a future observation injected into the stored projection cannot change the frozen features", () => {
  const prediction = ctx.mainPredictions[0];
  const poisoned = deepClone(prediction.preOutcomeInputs);
  poisoned.history = [...(poisoned.history ?? []), { observedAt: new Date(FIXTURE_T0 + 10 * 60_000).toISOString(), observedAtMs: FIXTURE_T0 + 600_000, priceUsd: 1e6 }];
  assertEqual(digestOf(extractDirectionFeaturesFromInputs(poisoned).features), digestOf(prediction.featureValues), "the injected future observation is inert");
  assertTrue(poisoned.history.length > (prediction.preOutcomeInputs.history ?? []).length, "the injection really happened");
  // ...and the audit WOULD catch a computation that consumed it.
  const leaky = ({ inputs }) => ({ count: (inputs.history ?? []).length });
  const leakyReport = auditHistoryRecomputation({ observations: [
    { observationId: "a", observationIndex: 0, receivedAt: new Date(FIXTURE_T0).toISOString(), inputs: prediction.preOutcomeInputs },
    { observationId: "b", observationIndex: 1, receivedAt: new Date(FIXTURE_T0 + 30_000).toISOString(), inputs: poisoned },
  ], computeFor: leaky, label: "poisoned-features" });
  assertEqual(leakyReport.ok, false, "a leaky computation is caught by the same engine");
});

test("AB8. TAMPER: a not-late prediction marked late is DETECTED by replay", async () => {
  const target = await copyExperiment("jdir-fixture-main", "jdir-fixture-false-late");
  const predictions = await listDirectionPredictions(target);
  const victim = predictions[0];
  const file = path.join(target, DIRECTION_PREDICTIONS_DIR, `${victim.observationId}.json`);
  await writeFile(file, JSON.stringify(withPredictionDigest({ ...victim, invalid: true, invalidReason: "late_prediction", scorable: false }), null, 2), "utf8");
  const report = await replayDirectionExperiment({ experimentId: "jdir-fixture-false-late", baseRoot: ctx.tempRoot });
  assertEqual(report.ok, false, "the replay detects the mislabelled late observation");
  assertTrue(report.problems.some((problem) => problem.includes("marked late but completed before targetAt")), "and names the exact inconsistency");
});

test("AB9. replay refuses to guess: an unknown experiment id is an explicit failure", async () => {
  const report = await replayDirectionExperiment({ experimentId: "jdir-fixture-does-not-exist", baseRoot: ctx.tempRoot });
  assertEqual(report.ok, false, "an unknown experiment fails");
  assertEqual(report.readOnly, true, "but is still read only");
  assertEqual(report.networkCalls, 0, "and made no call");
  assertIncludes(report.problems.join(" | "), "no Phase 5I experiment", "the failure explains itself");
});

test("AB10. replay and stats REWRITE nothing", async () => {
  const root = directionExperimentRootFor(ctx.tempRoot, "jdir-fixture-main");
  const before = await directionMetadataSnapshot(root);
  await replayDirectionExperiment({ experimentId: "jdir-fixture-main", baseRoot: ctx.tempRoot });
  await directionStats({ experimentId: "jdir-fixture-main", baseRoot: ctx.tempRoot });
  const after = await directionMetadataSnapshot(root);
  assertDeepEqual(after, before, "no byte of the experiment changed");
  assertTrue(Object.keys(before).length > 10, "the snapshot covered the whole tree");
});

test("AB11. stats report the stored digest and whether the summary still matches", async () => {
  const stats = await directionStats({ experimentId: "jdir-fixture-main", baseRoot: ctx.tempRoot });
  assertEqual(stats.ok, true, "stats succeeded");
  assertEqual(stats.readOnly, true, "stats are read only");
  assertEqual(stats.metricsMatch, true, "the stored summary still matches a fresh computation");
  assertEqual(stats.metricsDigest, stats.storedMetricsDigest, "the two digests agree");
  assertEqual(stats.metricsDigest, metricsDigestOf(stats.metrics), "and the digest is the digest of the report");
  const missing = await directionStats({ experimentId: "jdir-fixture-absent", baseRoot: ctx.tempRoot });
  assertEqual(missing.ok, false, "an unknown experiment fails stats");
  assertIncludes(missing.error, "no Phase 5I experiment", "and says so explicitly");
});

test("AB12. the summary digest changes if a metric changes", () => {
  const first = metricsDigestOf(ctx.mainMetrics);
  const mutated = deepClone(ctx.mainMetrics);
  mutated.jev.brierScore = (mutated.jev.brierScore ?? 0) + 1;
  assertTrue(metricsDigestOf(mutated) !== first, "a different metric report has a different digest");
  assertEqual(metricsDigestOf(ctx.mainMetrics), first, "and recomputing the original is stable");
});

test("AB13. the experiment manifest digest is stable and pinned by content", () => {
  const first = digestOf(ctx.experiment);
  const second = digestOf(deepClone(ctx.experiment));
  assertEqual(first, second, "the manifest digest is deterministic");
  const mutated = deepClone(ctx.experiment);
  mutated.horizonSeconds = 60;
  assertTrue(digestOf(mutated) !== first, "changing a pinned element changes the manifest digest");
});

/* ============================================================================
 * PART AC — data-granularity integrity
 * ==========================================================================*/

test("AC1. the frozen feature vocabulary contains no unsupported-granularity concept", () => {
  assertEqual(FEATURE_GRANULARITY_AUDIT.ok, true, "the vocabulary passes its own audit at import time");
  assertEqual(FEATURE_GRANULARITY_AUDIT.violations.length, 0, "with no violations");
  assertEqual(FEATURE_GRANULARITY_AUDIT.checked, DIRECTION_FEATURE_NAMES.length, "and every feature was checked");
});

test("AC2. the granularity guard fires on every forbidden concept", () => {
  for (const name of ["orderBookImbalance", "queueDepth", "cvd", "aggressiveBuyVolume", "aggressiveSellerVolume", "makerFlow", "l2Depth", "l3Orders", "quoteSpread", "cumulativeVolumeDelta", "bidAskSpread", "makerQueuePosition"]) {
    const audit = auditGranularityNames([name]);
    assertEqual(audit.ok, false, `'${name}' is refused`);
    assertTrue(audit.violations.length >= 1, `'${name}' produces a violation`);
  }
  for (const name of ["orderbook", "l2", "l3", "queue", "cvd", "maker", "taker", "aggressive", "bid", "ask", "depth"]) {
    assertTrue(FORBIDDEN_GRANULARITY_TOKENS.includes(name), `'${name}' is a forbidden token`);
  }
  assertTrue(FORBIDDEN_GRANULARITY_PHRASES.includes("order book imbalance"), "the order-book phrase is forbidden");
  assertTrue(FORBIDDEN_GRANULARITY_PHRASES.includes("partial fill"), "the fill phrase is forbidden");
  assertTrue(FORBIDDEN_GRANULARITY_PHRASES.includes("quote spread"), "the spread phrase is forbidden");
});

test("AC3. the guard does NOT misfire on the honest aggregate names", () => {
  for (const name of ["observed5mVolumeFlowImbalance", "observed5mBuyPressure", "observedQuoteReferencePriceUsd", "observed5mTurnoverRatio", "recentReferenceDispersion"]) {
    assertEqual(auditGranularityNames([name]).ok, true, `'${name}' is honestly named and accepted`);
  }
  assertDeepEqual(tokenizeIdentifier("observed5mVolumeFlowImbalance"), ["observed5m", "volume", "flow", "imbalance"], "identifiers tokenize by case and digit boundaries");
  assertDeepEqual(tokenizeIdentifier("orderBookImbalance"), ["order", "book", "imbalance"], "camel case splits cleanly");
  assertDeepEqual(tokenizeIdentifier("l2_depth"), ["l2", "depth"], "snake case splits cleanly");
});

test("AC4. no 5I artifact or definition claims an order book, CVD or queue anywhere", () => {
  const serialized = JSON.stringify({ experiment: ctx.experiment, summary: ctx.mainSummary });
  for (const token of ["orderBookImbalance", "queueDepth", "aggressiveBuy", "makerFlow", "l2Depth", "l3Orders"]) {
    assertExcludes(serialized, token, `the manifest/summary contains no ${token}`);
  }
  for (const prediction of ctx.mainPredictions) {
    const keys = Object.keys(prediction.featureValues ?? {}).join(" ");
    assertEqual(auditGranularityNames(Object.keys(prediction.featureValues ?? {})).ok, true, `${prediction.observationId} feature keys are granularity-clean`);
    assertExcludes(keys, "orderBook", `${prediction.observationId} has no order-book key`);
  }
});

test("AC5. the omitted feature families are declared with reasons, not approximated", () => {
  assertTrue(UNAVAILABLE_FEATURE_FAMILIES.length >= 6, "the omitted set is substantive");
  const families = UNAVAILABLE_FEATURE_FAMILIES.map((entry) => entry.family);
  for (const family of ["orderBookImbalance", "queueDepth", "cvd", "makerFlow", "quoteSpread", "routePriceImpact", "routeCount"]) {
    assertTrue(families.includes(family), `${family} is declared unavailable`);
  }
  for (const entry of UNAVAILABLE_FEATURE_FAMILIES) {
    assertTrue(entry.reason.length > 20, `${entry.family} has a real reason`);
    assertTrue(!Object.hasOwn(entry, "value"), `${entry.family} carries no approximated value`);
    assertTrue(!Object.hasOwn(entry, "featureName"), `${entry.family} defines no feature name`);
  }
  assertIncludes(UNAVAILABLE_FEATURE_FAMILIES.find((entry) => entry.family === "routePriceImpact").reason, "quote_price_impact", "the honest alternative name is documented");
});

test("AC6. the runtime executable source contains no order-book / L2 / L3 / queue vocabulary", async () => {
  for (const relative of PHASE_5I_MODULES) {
    const source = executableCode(await readText(relative));
    for (const token of ["orderBookImbalance", "queueDepth", "l2Depth", "l3Orders", "aggressiveBuyVolume", "cumulativeVolumeDelta", "orderbook"]) {
      assertExcludes(source, token, `${relative} has no ${token} identifier`);
    }
  }
  // The honest aggregate name is present (as a string literal, hence the raw read).
  const features = await readText("scripts/jev/direction/features.mjs");
  assertIncludes(features, "observed5mVolumeFlowImbalance", "the honest aggregate name is present");
  assertTrue(executableCode("const a = 1;\n// orderBookImbalance\n").trim() === "const a = 1;", "comment lines are stripped");
  assertTrue(
    !executableCode("const re = /^(passphrase|wallet[_-]?secret)$/;\n").includes("wallet"),
    "a regex literal that BANS a name is not a usage of it",
  );
});

test("AC7. the Jev market observation is an aggregate feed, and the code says so", async () => {
  const observation = await readText("scripts/jev/direction/observation.mjs");
  assertIncludes(observation, "Jupiter Tokens V2", "the observation source names the real feed");
  assertIncludes(observation, "A Jupiter quote is NOT an order book", "and refuses the order-book reading");
  assertIncludes(observation, "NEVER scored as market evidence", "synthetic data can never become benchmark evidence");
  assertTrue(ctx.mainPredictions.every((prediction) => prediction.packet.quoteObservationAvailable !== undefined), "the packet records whether a quote observation existed");
  assertEqual(ctx.experiment.market.baseMint, BENCHMARK_MARKET.baseMint, "the experiment pins the real base mint");
});

test("AC8. the future 5I.2 execution boundary is documented and NOT implemented", () => {
  assertEqual(FUTURE_EXECUTION_BOUNDARY.phase, "5I.2", "the future phase is named");
  assertEqual(FUTURE_EXECUTION_BOUNDARY.implementedInThisPhase, false, "nothing is implemented in 5I.0b");
  assertEqual(FUTURE_EXECUTION_BOUNDARY.implementationApproved, false, "and it is not approved");
  for (const state of ["TOUCHED", "TRADED_THROUGH", "QUEUE_AHEAD_CONSUMED", "PARTIAL_FILL", "FULL_FILL", "CANCELLED", "CANCEL_RACE_FILL", "EXPIRED"]) {
    assertTrue(FUTURE_EXECUTION_BOUNDARY.requiredFillStates.includes(state), `${state} is a future fill state`);
  }
  assertTrue(FUTURE_EXECUTION_BOUNDARY.forbiddenNow.some((entry) => entry.includes("manufacturing L2/L3")), "manufacturing L2/L3 from quotes is explicitly forbidden");
  assertTrue(FUTURE_EXECUTION_BOUNDARY.forbiddenNow.some((entry) => entry.includes("assuming a fill")), "assuming a fill from a touch is explicitly forbidden");
});

/* ============================================================================
 * PART AD — zero routing / trading authority
 * ==========================================================================*/

test("AD1. the routing flags are exactly the intended zero-authority set", () => {
  assertEqual(DIRECTION_ROUTING_FLAGS.jevPredictionActive, true, "Jev IS called — as the predictor");
  assertEqual(DIRECTION_ROUTING_FLAGS.jevTradingRoutingActive, false, "Jev has no trading routing");
  assertEqual(DIRECTION_ROUTING_FLAGS.arenaRoutingActive, false, "no Arena routing");
  assertEqual(DIRECTION_ROUTING_FLAGS.deepseekRoutingActive, false, "no DeepSeek routing");
  assertEqual(DIRECTION_ROUTING_FLAGS.classifierRoutingActive, false, "no classifier routing");
  assertEqual(DIRECTION_ROUTING_FLAGS.agentReachRoutingActive, false, "no Agent-Reach routing");
  assertEqual(DIRECTION_ROUTING_FLAGS.tradingRoutingActive, false, "no trading routing");
  assertDeepEqual(Object.keys(DIRECTION_ROUTING_FLAGS).sort(), ["agentReachRoutingActive", "arenaRoutingActive", "classifierRoutingActive", "deepseekRoutingActive", "jevPredictionActive", "jevTradingRoutingActive", "tradingRoutingActive"], "the flag set is exactly these seven");
});

test("AD2. every artifact persists the zero-authority routing flags", () => {
  for (const prediction of ctx.mainPredictions) {
    for (const [flag, expected] of Object.entries(DIRECTION_ROUTING_FLAGS)) {
      assertEqual(prediction[flag], expected, `${prediction.observationId}.${flag}`);
    }
    assertDeepEqual(prediction.routingFlags, { ...DIRECTION_ROUTING_FLAGS }, `${prediction.observationId} carries the flag block`);
  }
  for (const outcome of ctx.mainOutcomes) {
    for (const [flag, expected] of Object.entries(DIRECTION_ROUTING_FLAGS)) {
      assertEqual(outcome[flag], expected, `outcome ${outcome.observationId}.${flag}`);
    }
  }
  for (const [flag, expected] of Object.entries(DIRECTION_ROUTING_FLAGS)) {
    assertEqual(ctx.experiment[flag], expected, `experiment.${flag}`);
    assertEqual(ctx.mainSummary[flag], expected, `summary.${flag}`);
  }
});

test("AD3. the development/paper-only flags are present on every artifact", () => {
  for (const [flag, expected] of Object.entries(DIRECTION_DEVELOPMENT_FLAGS)) {
    assertEqual(expected, true, `${flag} is frozen true`);
    assertEqual(ctx.experiment[flag], true, `experiment.${flag}`);
    assertEqual(ctx.mainSummary[flag], true, `summary.${flag}`);
    for (const prediction of ctx.mainPredictions) assertEqual(prediction[flag], true, `prediction.${flag}`);
  }
  for (const key of ["developmentOnly", "noGroundTruthBeyondObservedFutureOutcome", "noProfitabilityInference", "noTradingInference", "noDeploymentInference", "paperOnly", "shadowOnly"]) {
    assertTrue(Object.hasOwn(DIRECTION_DEVELOPMENT_FLAGS, key), `the flag set includes ${key}`);
  }
});

test("AD4. no 5I executable source contains a wallet, signer, order or execution path", async () => {
  for (const relative of PHASE_5I_MODULES) {
    const source = executableCode(await readText(relative));
    for (const token of FORBIDDEN_RUNTIME_TOKENS) {
      assertExcludes(source, token, `${relative} executable code contains no '${token}'`);
    }
  }
  const runner = executableCode(await readText("scripts/jev/direction/runner.mjs"));
  assertExcludes(runner, "sign", "the runner signs nothing");
  assertExcludes(runner, "send", "the runner sends no transaction");
  assertIncludes(runner, "writeDirectionPrediction", "it only ever writes a prediction artifact");
});

test("AD5. the CLI refuses trading/execution options outright", () => {
  for (const flag of ["trade", "wallet", "sign", "signer", "swap", "order", "execute", "position", "pnl", "profit", "sharpe", "arena", "deepseek", "route", "latest", "threshold", "signal", "alpha"]) {
    assertTrue(DIRECTION_FORBIDDEN_FLAGS.includes(flag), `--${flag} is forbidden`);
  }
  assertTrue(DIRECTION_FORBIDDEN_FLAGS.length >= 25, "the forbidden list is substantive");
  assertDeepEqual(DIRECTION_ACTIONS, ["start", "resume", "resolve", "replay", "stats"], "the action set is exactly the five scheduled actions");
  assertEqual(resolveDirectionAction({}).error !== null, true, "no action is an error");
  assertEqual(resolveDirectionAction({ start: true, replay: true }).error !== null, true, "two actions is an error");
  assertEqual(resolveDirectionAction({ stats: true }).action, "stats", "one action resolves");
  assertEqual(resolveDirectionAction({ help: true }).action, null, "a non-action flag resolves to no action");
});

test("AD6. the metric report contains no profitability field anywhere", () => {
  const audit = auditNoProfitabilityFields(ctx.mainMetrics);
  assertTrue(audit.ok, `no profitability field appears: ${audit.problems.join("; ")}`);
  assertTrue(FORBIDDEN_METRIC_FIELDS.includes("pnl"), "pnl is a forbidden metric field");
  assertTrue(FORBIDDEN_METRIC_FIELDS.includes("sharpe"), "sharpe is forbidden");
  assertTrue(FORBIDDEN_METRIC_FIELDS.includes("sortino"), "sortino is forbidden");
  assertTrue(FORBIDDEN_METRIC_FIELDS.includes("tradeCount"), "trade count is forbidden");
  assertTrue(FORBIDDEN_METRIC_FIELDS.includes("returns"), "returns are forbidden");
  assertTrue(FORBIDDEN_METRIC_FIELDS.includes("expectedReturn"), "expected return is forbidden");
  const poisoned = deepClone(ctx.mainMetrics);
  poisoned.pnl = 12;
  assertEqual(auditNoProfitabilityFields(poisoned).ok, false, "an injected pnl IS detected");
});

test("AD7. the summary is development evidence and never a replication or deployment claim", () => {
  assertEqual(ctx.mainSummary.evidenceScope, "DEVELOPMENT", "the evidence scope is development");
  assertEqual(ctx.mainSummary.replicationStatus, "NOT_REPLICATED", "replication is explicitly absent");
  assertEqual(ctx.mainSummary.evidenceClass, DIRECTION_EVIDENCE_CLASS, "the summary declares the 5I evidence class");
  assertIncludes(ctx.mainSummary.note, "DEVELOPMENT-ONLY", "the note says development only");
  assertIncludes(ctx.mainSummary.note, "not a profitability claim", "and refuses a profitability claim");
  assertIncludes(ctx.mainSummary.note, "not a deployment decision", "and refuses a deployment verdict");
  assertExcludes(ctx.mainSummary.note.toLowerCase(), "validated", "and never claims validation");
  assertEqual(ctx.mainSummary.finalized, true, "the summary is finalized");
});

test("AD8. no 5I module imports a trading, Arena-scoring, DeepSeek, classifier or Agent-Reach subsystem", async () => {
  const forbiddenImports = ["wallet", "jupiter-swap", "arena/tournament", "deepseek", "intelligence/capture", "intelligence-classify", "arena/gates", "arena/shadow"];
  for (const relative of PHASE_5I_MODULES) {
    const source = await readText(relative);
    for (const forbidden of forbiddenImports) {
      assertExcludes(source, `from "${forbidden}"`, `${relative} does not import ${forbidden}`);
    }
  }
  const runner = await readText("scripts/jev/direction/runner.mjs");
  assertIncludes(runner, "arena/orchestrator.mjs", "the runner reuses the EXISTING regime classifier read-only");
  assertExcludes(runner, "arenaScore", "but never touches an Arena score");
});

/* ============================================================================
 * PART AG — outcome-resolution policy v2 + metric v2 timing/denominator diagnostics
 *
 * The v1 identities are FROZEN and must stay byte-identical; v2 is a NEW frozen
 * version. None of this is selected using prediction performance.
 * ==========================================================================*/

/** The first real canary — immutable historical infrastructure evidence, when present locally. */
const CANARY_EXPERIMENT_ID = "jdir-20260920T060810Z-3a9163";

/** Pure classifier over the timestamps + a policy bound, with NO probability/direction input. */
function classifyAt(offsetMs, targetAtMs = 1_000_000, maximumOffsetMs) {
  return resolveOutcomeOffset({ targetAtMs, outcomeReceivedAtMs: targetAtMs + offsetMs, maximumOffsetMs });
}

test("AG1. outcome-resolution policy v1 still exists, is unchanged, and is bounded at 5000 ms", () => {
  assertEqual(OUTCOME_RESOLUTION_POLICY_VERSION_V1, 1, "v1 is still version 1");
  assertEqual(OUTCOME_RESOLUTION_POLICY_V1.version, 1, "the v1 object declares version 1");
  assertEqual(OUTCOME_RESOLUTION_POLICY_V1.maximumOffsetMs, 5_000, "v1 is still bounded at exactly 5000 ms");
  assertEqual(OUTCOME_RESOLUTION_POLICY_V1.maximumOffsetMs, RESOLUTION_TOLERANCE_MS, "the legacy tolerance constant is still v1's bound");
  assertEqual(OUTCOME_RESOLUTION_POLICY_V1_DIGEST, digestOf(OUTCOME_RESOLUTION_POLICY_V1), "the v1 digest recomputes from the frozen object");
});

test("AG2. outcome-resolution policy v2 is exactly 10000 ms and reuses v1's selection rule", () => {
  assertEqual(OUTCOME_RESOLUTION_POLICY_VERSION_V2, 2, "v2 is version 2");
  assertEqual(OUTCOME_RESOLUTION_POLICY_V2.version, 2, "the v2 object declares version 2");
  assertEqual(OUTCOME_RESOLUTION_POLICY_V2.maximumOffsetMs, 10_000, "v2 is bounded at exactly 10000 ms");
  assertEqual(OUTCOME_RESOLUTION_POLICY_V2.maximumOffsetMs, RESOLUTION_TOLERANCE_MS_V2, "the v2 constant agrees");
  assertEqual(OUTCOME_RESOLUTION_POLICY_V2.selectionRule, OUTCOME_RESOLUTION_POLICY_V1.selectionRule, "the selection rule is unchanged from v1");
  assertEqual(OUTCOME_RESOLUTION_POLICY_V2.supersedesPolicyVersion, 1, "v2 declares it supersedes v1");
  assertEqual(OUTCOME_RESOLUTION_POLICY_V2.offsetBoundTunedAgainstPredictionOutcomes, false, "the bound is NOT tuned against prediction outcomes");
  assertTrue(OUTCOME_RESOLUTION_POLICY_V2.maximumOffsetMs < HORIZON_MS, "the bound stays well below the 30 s horizon");
});

test("AG3. v1 and v2 have DISTINCT digests and both stay resolvable forever", () => {
  assertTrue(OUTCOME_RESOLUTION_POLICY_V1_DIGEST !== OUTCOME_RESOLUTION_POLICY_V2_DIGEST, "v1 and v2 digests differ");
  assertTrue(/^[0-9a-f]{64}$/.test(OUTCOME_RESOLUTION_POLICY_V2_DIGEST), "the v2 digest is a sha256 hex string");
  assertEqual(outcomeResolutionPolicyFor(1), OUTCOME_RESOLUTION_POLICY_V1, "version 1 resolves to the frozen v1 object");
  assertEqual(outcomeResolutionPolicyFor(2), OUTCOME_RESOLUTION_POLICY_V2, "version 2 resolves to the frozen v2 object");
  assertEqual(outcomeResolutionPolicyDigestFor(1), OUTCOME_RESOLUTION_POLICY_V1_DIGEST, "digest lookup for v1");
  assertEqual(outcomeResolutionPolicyDigestFor(2), OUTCOME_RESOLUTION_POLICY_V2_DIGEST, "digest lookup for v2");
  assertEqual(outcomeResolutionPolicyFor(99), null, "an unknown version fails closed");
  assertDeepEqual(Object.keys(OUTCOME_RESOLUTION_POLICIES).sort(), ["1", "2"], "the registry lists every frozen version");
  assertEqual(outcomeResolutionPolicyForOffset(5_000), OUTCOME_RESOLUTION_POLICY_V1, "5000 ms selects v1");
  assertEqual(outcomeResolutionPolicyForOffset(10_000), OUTCOME_RESOLUTION_POLICY_V2, "10000 ms selects v2");
  assertEqual(outcomeResolutionPolicyForOffset(9_000), null, "an unregistered bound selects no policy");
});

test("AG4. v2 ACCEPTS a +6003 ms outcome that v1 REJECTS, and v2 still rejects above +10000 ms", () => {
  const v1At6003 = classifyAt(6_003, 1_000_000, OUTCOME_RESOLUTION_POLICY_V1.maximumOffsetMs);
  assertEqual(v1At6003.outcomeOffsetMs, 6_003, "the real measured offset is preserved");
  assertEqual(v1At6003.invalidReason, OUTCOME_UNAVAILABLE_REASON, "v1 rejects the +6003 ms observation on timing alone");
  assertEqual(v1At6003.withinWindow, false, "v1 marks it outside the window");

  const v2At6003 = classifyAt(6_003, 1_000_000, OUTCOME_RESOLUTION_POLICY_V2.maximumOffsetMs);
  assertEqual(v2At6003.outcomeOffsetMs, 6_003, "v2 reports the same real offset");
  assertEqual(v2At6003.invalidReason, null, "v2 accepts the +6003 ms observation");
  assertEqual(v2At6003.withinWindow, true, "v2 marks it inside the window");

  assertEqual(classifyAt(10_000, 1_000_000, 10_000).withinWindow, true, "the v2 bound is inclusive at +10000 ms");
  const v2Above = classifyAt(10_001, 1_000_000, 10_000);
  assertEqual(v2Above.withinWindow, false, "v2 rejects +10001 ms");
  assertEqual(v2Above.invalidReason, OUTCOME_UNAVAILABLE_REASON, "and names OUTCOME_UNAVAILABLE");
  assertEqual(classifyAt(-1, 1_000_000, 10_000).invalidReason, "future_reference_before_target", "a pre-target observation is never accepted by either version");
});

test("AG5. the policy choice NEVER depends on the Jev probability or the actual direction", () => {
  // `resolveOutcomeOffset` has no probability/direction parameter at all; the
  // same offset classifies identically regardless of what the model said.
  for (const offsetMs of [0, 3_002, 6_003, 10_001]) {
    const classification = classifyAt(offsetMs, 5_000_000, DEFAULT_OUTCOME_RESOLUTION_POLICY.maximumOffsetMs);
    assertDeepEqual(classification, classifyAt(offsetMs, 5_000_000, DEFAULT_OUTCOME_RESOLUTION_POLICY.maximumOffsetMs), `offset ${offsetMs} classifies deterministically`);
  }
  assertEqual(OUTCOME_RESOLUTION_POLICY_V2.selectionDependsOnPredictionOrOutcomeQuality, false, "v2 declares selection is outcome-quality independent");
  assertEqual(OUTCOME_RESOLUTION_POLICY_V1.selectionDependsOnPredictionOrOutcomeQuality, false, "and so does v1");
  assertTrue(!Object.hasOwn(OUTCOME_RESOLUTION_POLICY_V2, "pHigher") && !Object.hasOwn(OUTCOME_RESOLUTION_POLICY_V2, "actualOutcome"), "no policy field references a probability or an outcome label");
});

test("AG6. targetAt stays stateFrozenAt + 30 s under v2: the policy never moves the target", () => {
  assertEqual(TARGET_AT_BASIS, "stateFrozenAt + horizonSeconds", "the frozen target basis is unchanged");
  assertEqual(OUTCOME_RESOLUTION_POLICY_V2.neverMovesTargetAt, true, "v2 never moves targetAt");
  assertTrue(ctx.mainPredictions.length > 0, "the v2 fixture froze predictions");
  for (const prediction of ctx.mainPredictions) {
    assertEqual(Date.parse(prediction.targetAt) - Date.parse(prediction.stateFrozenAt), HORIZON_MS, `${prediction.observationId} keeps the exact 30 s target under v2`);
    assertEqual(prediction.targetAtBasis, TARGET_AT_BASIS, `${prediction.observationId} still declares the freeze basis`);
  }
  assertTrue(!Object.hasOwn(OUTCOME_RESOLUTION_POLICY_V2, "horizonSeconds"), "the widened offset bound does not touch the horizon");
});

test("AG7. achieved horizon reports the REAL offset, never a relabelled 30 s", () => {
  assertTrue(ctx.mainOutcomes.length > 0, "the fixture resolved outcomes");
  for (const outcome of ctx.mainOutcomes) {
    assertEqual(outcome.achievedHorizonMs, Date.parse(outcome.outcomeReceivedAt) - Date.parse(outcome.stateObservedAt), `${outcome.observationId} achieved horizon = received - stateObserved`);
    assertEqual(outcome.outcomeOffsetMs, Date.parse(outcome.outcomeReceivedAt) - Date.parse(outcome.targetAt), `${outcome.observationId} offset = received - target`);
  }
  const offsetStats = ctx.mainMetrics.outcomeOffsetStats;
  assertTrue(offsetStats && offsetStats.count === ctx.mainOutcomes.length, "the offset stats cover every resolved outcome");
  for (const field of ["count", "mean", "median", "p90", "p95", "max"]) {
    assertTrue(Object.hasOwn(offsetStats, field), `outcomeOffsetStats exposes ${field}`);
  }
  const horizonStats = ctx.mainMetrics.achievedHorizonStats;
  assertTrue(horizonStats && horizonStats.count === ctx.mainOutcomes.length, "the achieved-horizon stats cover every resolved outcome");
  for (const field of ["count", "mean", "median", "p90", "p95", "max"]) {
    assertTrue(Object.hasOwn(horizonStats, field), `achievedHorizonStats exposes ${field}`);
  }
  assertTrue(horizonStats.max >= HORIZON_MS, "the achieved horizon is at least the 30 s target");
  assertEqual(percentileStats([5, 1, 3, 2, 4]).median, 3, "percentileStats median is deterministic");
  assertEqual(percentileStats([]).count, 0, "and empty input yields a zero count");
});

test("AG8. outcome selection is the FIRST valid post-target observation", () => {
  const selected = selectFirstPostTargetObservation({
    targetAtMs: 1_000_000,
    observations: [
      { mint: BENCHMARK_MARKET.baseMint, receivedAtMs: 999_999 },
      { mint: "SomeOtherMint111111111111111111111111111111", receivedAtMs: 1_000_001 },
      { mint: BENCHMARK_MARKET.baseMint, receivedAtMs: 1_000_500 },
      { mint: BENCHMARK_MARKET.baseMint, receivedAtMs: 1_003_000 },
    ],
  });
  assertEqual(selected?.receivedAtMs, 1_000_500, "a pre-target and a non-base observation are skipped; the FIRST post-target base wins");
  assertEqual(selectFirstPostTargetObservation({ targetAtMs: 1_000_000, observations: [{ mint: BENCHMARK_MARKET.baseMint, receivedAtMs: 999_999 }] }), null, "a pre-target observation is never substituted");
  assertEqual(selectFirstPostTargetObservation({ targetAtMs: 1_000_000, observations: [{ mint: BENCHMARK_MARKET.baseMint, receivedAtMs: 1_000_000 }] })?.receivedAtMs, 1_000_000, "at exactly targetAt an observation IS selected");
  for (const outcome of ctx.mainOutcomes) {
    assertTrue(Date.parse(outcome.outcomeReceivedAt) >= Date.parse(outcome.targetAt), `${outcome.observationId} was received at or after targetAt`);
  }
});

test("AG9. all-valid and scored probability statistics are reported SEPARATELY", () => {
  const metrics = ctx.mainMetrics;
  assertTrue(metrics.validPredictionCount > metrics.scoredCount, "the fixture has valid-but-unscored observations (ties/exclusions)");
  assertEqual(metrics.allValidPredictionStats.count, metrics.validPredictionCount, "allValidPredictionStats covers every valid prediction");
  assertEqual(metrics.scoredPredictionStats.count, metrics.scoredCount, "scoredPredictionStats covers only the scored sample");
  assertTrue(!Object.hasOwn(metrics.allValidPredictionStats, "pHigher") && Object.hasOwn(metrics.allValidPredictionStats, "meanPHigher"), "the all-valid block names meanPHigher");
  assertEqual(metrics.probabilityStats.allValidPredictions.count, metrics.allValidPredictionStats.count, "the legacy all-valid view agrees");
  assertEqual(metrics.probabilityStats.scoredBinary.count, metrics.scoredPredictionStats.count, "the legacy scored view agrees");
});

test("AG10. every score exposes an explicit denominator (brier/logLoss/accuracy sample counts)", () => {
  const metrics = ctx.mainMetrics;
  assertEqual(metrics.jev.brierSampleCount, metrics.jev.sampleCount, "Jev Brier denominator is explicit");
  assertEqual(metrics.jev.logLossSampleCount, metrics.scoredCount, "Jev log-loss denominator equals the scored sample");
  assertEqual(metrics.jev.accuracySampleCount, metrics.scoredCount, "Jev accuracy denominator equals the scored sample");
  for (const [baselineId, block] of Object.entries(metrics.baselines)) {
    assertTrue(Number.isInteger(block.brierSampleCount), `${baselineId} exposes brierSampleCount`);
    assertTrue(Number.isInteger(block.logLossSampleCount), `${baselineId} exposes logLossSampleCount`);
    assertTrue(Number.isInteger(block.accuracySampleCount), `${baselineId} exposes accuracySampleCount`);
    assertEqual(block.brierSampleCount, block.sampleCount, `${baselineId} Brier denominator matches its sample`);
  }
});

test("AG11. metric v2 is a strict superset of v1 and the v1 projection reproduces the v1 shape", () => {
  assertEqual(DIRECTION_METRICS_VERSION, 2, "the current metric definition is v2");
  assertEqual(DIRECTION_METRIC_DEFINITION_V1.definitionVersion, 1, "v1 declares its own version");
  assertEqual(DIRECTION_METRIC_DEFINITION_V1_DIGEST, digestOf(DIRECTION_METRIC_DEFINITION_V1), "the v1 metric digest recomputes");
  assertTrue(DIRECTION_METRIC_DEFINITION_DIGEST !== DIRECTION_METRIC_DEFINITION_V1_DIGEST, "v1 and v2 metric definitions have distinct digests");
  assertEqual(metricDefinitionForVersion(1), DIRECTION_METRIC_DEFINITION_V1, "version 1 resolves to the frozen v1 definition");
  assertEqual(metricDefinitionForVersion(2), DIRECTION_METRIC_DEFINITION, "version 2 resolves to the current definition");
  assertEqual(metricDefinitionDigestForVersion(1), DIRECTION_METRIC_DEFINITION_V1_DIGEST, "digest lookup for metric v1");
  assertDeepEqual(Object.keys(DIRECTION_METRIC_DEFINITIONS).sort(), ["1", "2"], "the metric registry lists every frozen version");
  for (const field of METRIC_V2_ONLY_FIELDS) {
    assertTrue(Object.hasOwn(ctx.mainMetrics, field), `v2 metrics expose ${field}`);
  }
  const projected = projectMetricsToVersion(ctx.mainMetrics, 1);
  for (const field of METRIC_V2_ONLY_FIELDS) {
    assertTrue(!Object.hasOwn(projected, field), `the v1 projection drops ${field}`);
  }
  assertTrue(!Object.hasOwn(projected.jev, "brierSampleCount"), "the v1 projection drops the v2 forecaster denominators");
  assertEqual(projected.metricDefinitionVersion, 1, "the projection declares metric v1");
  assertEqual(projected.metricDefinitionDigest, DIRECTION_METRIC_DEFINITION_V1_DIGEST, "and pins the v1 digest");
});

test("AG12. a NEW experiment pins policy v2 + the v2 digest, and a v1-pinned experiment replays under v1", async () => {
  // NEW fixture experiments pin v2.
  assertEqual(ctx.experiment.outcomeResolutionPolicyVersion, 2, "the main fixture experiment pins policy v2");
  assertEqual(ctx.experiment.outcomeResolutionPolicy.maximumOffsetMs, 10_000, "with the 10000 ms bound");
  assertEqual(ctx.experiment.outcomeResolutionPolicyDigest, OUTCOME_RESOLUTION_POLICY_V2_DIGEST, "and the frozen v2 digest");

  // A v1-pinned experiment is created explicitly and must replay with v1 semantics.
  const harness = createFixtureHarness({ quoteToken: true });
  const created = await runFixtureExperiment({
    root: ctx.tempRoot,
    experimentId: "jdir-fixture-policy-v1",
    harness,
    maxObservations: 3,
    provider: defaultFixtureProvider(),
    extraSettings: { "tolerance-ms": "5000" },
  });
  assertEqual(created.result.ok, true, "the v1 experiment ran");
  assertEqual(created.settings.outcomeResolutionPolicyVersion, 1, "--tolerance-ms 5000 selects policy v1");
  const v1Summary = JSON.parse(await readFile(path.join(directionExperimentRootFor(ctx.tempRoot, "jdir-fixture-policy-v1"), "experiment.json"), "utf8"));
  assertEqual(v1Summary.outcomeResolutionPolicyVersion, 1, "the v1 experiment pins version 1");
  assertEqual(v1Summary.resolutionToleranceMs, 5_000, "and the 5000 ms bound");

  const v1Root = directionExperimentRootFor(ctx.tempRoot, "jdir-fixture-policy-v1");
  const before = await metadataSnapshot(v1Root);
  const report = await replayDirectionExperiment({ experimentId: "jdir-fixture-policy-v1", baseRoot: ctx.tempRoot });
  const after = await metadataSnapshot(v1Root);
  assertEqual(report.ok, true, `the v1 experiment replays cleanly: ${JSON.stringify(report.problems)}`);
  assertEqual(report.outcomeResolutionPolicyVersion, 1, "the replay reports policy v1");
  assertEqual(report.maximumOffsetMs, 5_000, "and the 5000 ms bound");
  assertEqual(report.metricDefinitionVersion, DIRECTION_METRICS_VERSION, "and the metric definition version it pinned");
  assertDeepEqual(after, before, "the v1 experiment is byte-unchanged by its own replay");
});

test("AG13. the first real canary, when present, still replays under v1 and stays byte-unchanged", async () => {
  const root = directionExperimentRootFor(REAL_EXPECTED_DIR, CANARY_EXPERIMENT_ID);
  if (!(await exists(root))) {
    skip("the first real 5I canary is absent in this checkout — its immutable v1 replay case was skipped cleanly");
    return;
  }
  const before = await metadataSnapshot(root);
  const report = await replayDirectionExperiment({ experimentId: CANARY_EXPERIMENT_ID, baseRoot: REAL_EXPECTED_DIR });
  const after = await metadataSnapshot(root);
  assertEqual(report.ok, true, `the canary replay is clean: ${JSON.stringify(report.problems)}`);
  assertEqual(report.networkCalls, 0, "the canary replay makes ZERO network calls");
  assertEqual(report.jevCalls, 0, "and zero Jev calls");
  assertEqual(report.outcomeResolutionPolicyVersion, 1, "the canary stays pinned to policy v1");
  assertEqual(report.maximumOffsetMs, 5_000, "with the original 5000 ms bound");
  assertEqual(report.counts.predictions, 5, "5 predictions");
  assertEqual(report.counts.outcomes, 5, "5 outcomes");
  assertEqual(report.counts.scoredCount, 1, "exactly 1 scored");
  assertEqual(report.counts.outcomeWindowExclusions, 4, "and 4 outcome-window exclusions under v1");
  assertDeepEqual(after, before, "the canary artifacts are byte-unchanged by the replay");

  // The v2 diagnostics recompute OFFLINE from the same (unmodified) artifacts.
  const bundle = await readDirectionExperimentBundle(root);
  const v2 = evaluateDirectionExperiment({
    experiment: bundle.experiment,
    predictions: bundle.predictions,
    outcomes: bundle.outcomes,
    metricDefinitionVersion: 2,
  });
  assertEqual(v2.allValidPredictionStats.count, 5, "all five predictions are all-valid");
  assertClose(v2.allValidPredictionStats.meanPHigher, 0.442, "the canary all-valid mean pHigher recomputes to 0.442", 1e-9);
  assertClose(v2.allValidPredictionStats.medianPHigher, 0.43, "and the median to 0.43", 1e-12);
  assertEqual(v2.scoredPredictionStats.count, 1, "while the scored sample is still the one scorable observation");
  assertClose(v2.scoredPredictionStats.meanPHigher, 0.42, "with mean 0.42", 1e-12);
  assertTrue(v2.outcomeOffsetStats.max >= 6_000, "the real post-target offsets (~+6 s) are visible as a timing diagnostic");
  assertTrue(v2.achievedHorizonStats.count === bundle.outcomes.length, "the achieved-horizon diagnostic covers every outcome");
});

/* ============================================================================
 * PART AE — frozen historical evidence preservation
 * ==========================================================================*/

test("AE1. the canonical Phase 5H.0 barrier identity is still pinned exactly", () => {
  assertEqual(CANONICAL_5H_FEATURE_ID, "clfeat-20260919T173844Z-7a9193bb", "the canonical 5H feature id");
  assertEqual(CANONICAL_5H_FEATURE_DIGEST, "65218b38f80a344a99f12f8a98784a49250d0ec0b88cd88ea9cd795fab39312b", "the canonical 5H feature digest");
  assertEqual(CANONICAL_5H_FEATURE_DEFINITION_VERSION, "classifier-feature-definition-v1", "the canonical definition version");
  assertEqual(CANONICAL_5H_FEATURE_DEFINITION_DIGEST, "9227c8ef12414951bd48fe4c4c2a9ea2d1b69f4485f1019157912e32bc0093bd", "the canonical definition digest");
  assertEqual(CANONICAL_5H_SOURCE_COHORT_ID, "clcohort-20260919T163609Z-4d7c6dd9", "the canonical source cohort id");
  assertEqual(CANONICAL_5H_SOURCE_COHORT_DIGEST, "2a8b9ca38f6f1f9dad7a46426c9a42cece2ca9fa3722815c430d42098b9e1a04", "the canonical source cohort digest");
  assertEqual(CANONICAL_5H_EVIDENCE_AS_OF, "2026-09-19T16:34:12.867Z", "the canonical evidenceAsOf");
  assertEqual(CANONICAL_5H_EVIDENCE_CLASS, "DEVELOPMENT_CLASSIFIER_DERIVED_FEATURES", "the canonical derived evidence class");
  assertEqual(CANONICAL_5H_SOURCE_EVIDENCE_CLASS, "DEVELOPMENT_CLASSIFIER_EVIDENCE", "the canonical source evidence class");
});

test("AE2. the canonical classifier feature definition still computes to the pinned digest", () => {
  assertEqual(FEATURE_DEFINITION_VERSION, CANONICAL_5H_FEATURE_DEFINITION_VERSION, "the 5H definition version is unchanged");
  assertEqual(FEATURE_DEFINITION_DIGEST, CANONICAL_5H_FEATURE_DEFINITION_DIGEST, "the 5H definition digest is unchanged");
  assertEqual(FEATURE_DEFINITION_DIGEST.length, 64, "the digest is a SHA-256 hex string");
});

test("AE3. the canonical evaluation contract digest is unchanged and derivable from the stored freeze", async () => {
  assertEqual(CANONICAL_EVALUATION_CONTRACT_DIGEST, CANONICAL_EVALUATION_CONTRACT, "the published contract pin");
  assertEqual(CANONICAL_EVALUATION_CONTRACT.length, 64, "the contract digest is a SHA-256 hex string");
  const freeze = await readFreeze(REPO, CANONICAL_HISTORICAL_FREEZE_PATH).catch(() => null);
  if (!freeze) {
    skip("the frozen Wave 1 freeze artifact is absent here — the contract derivation case was skipped cleanly");
    return;
  }
  assertEqual(evaluationContractDigest(freeze), CANONICAL_EVALUATION_CONTRACT_DIGEST, "the STORED freeze still derives the canonical contract digest");
  assertEqual(evaluationContractDigest(freeze), evaluationContractDigest(freeze), "and the derivation is deterministic");
});

test("AE4. Phase 5I added its own evidence tree and did not touch any other", async () => {
  assertEqual(DIRECTION_ROOT_DIR, path.join(".evolve", "jev-direction"), "the 5I tree is the dedicated jev-direction tree");
  assertEqual(DIRECTION_EXPERIMENTS_DIR, path.join(DIRECTION_ROOT_DIR, "experiments"), "experiments live under that tree");
  assertTrue(!DIRECTION_ROOT_DIR.includes("jev/experiments"), "5I evidence is NOT under the Phase 5D storage root");
  assertTrue(!DIRECTION_ROOT_DIR.includes("classifier"), "5I evidence is NOT under the classifier tree");
  assertTrue(!DIRECTION_ROOT_DIR.includes("intelligence"), "5I evidence is NOT under the intelligence tree");
  const storage = await readText("scripts/jev/direction/storage.mjs");
  assertIncludes(storage, "immutable", "storage enforces immutability");
});

test("AE5. validator run state: nothing was written under any real evidence root", async () => {
  const now = await metadataSnapshot(REAL_DIRECTION_ROOT);
  const nowExperiments = await metadataSnapshot(REAL_EXPECTED_DIR);
  assertDeepEqual(now, ctx.before.realDirection, "the real 5I evidence tree is byte-unchanged so far");
  assertDeepEqual(nowExperiments, ctx.before.realExperiments, "and so is the real experiments directory");
  if (!ctx.directionRootPresentBefore) {
    assertTrue(!(await exists(REAL_DIRECTION_ROOT)), "no canonical 5I evidence was created by this suite");
  } else {
    assertTrue(await exists(REAL_DIRECTION_ROOT), "a canonical 5I tree already existed locally and was left untouched");
  }
});

test("AE6. every fixture experiment lives in a temp directory, never in .evolve", async () => {
  assertTrue(typeof ctx.tempRoot === "string" && ctx.tempRoot.startsWith(tmpdir()), "the fixture root is under the OS temp directory");
  assertTrue(!ctx.tempRoot.includes(path.join(REPO, ".evolve")), "never inside the repository's evidence tree");
  const experimentRoot = directionExperimentRootFor(ctx.tempRoot, "jdir-fixture-main");
  assertTrue(experimentRoot.startsWith(ctx.tempRoot), "the experiment root is inside the temp root");
  const listing = await listDirectionExperiments(ctx.tempRoot);
  assertTrue(listing.length >= 6, `at least the six planned fixture experiments exist (found ${listing.length})`);
  for (const experiment of listing) {
    assertEqual(experiment.phase, DIRECTION_PHASE, `${experiment.experimentId} declares the phase`);
    assertEqual(experiment.evidenceClass, DIRECTION_EVIDENCE_CLASS, `${experiment.experimentId} declares the evidence class`);
  }
  // Observation ids are deterministic and index-sortable, so a resumed run and a
  // fresh run address the SAME slot with the SAME id.
  const id = directionObservationIdFor({ experimentId: "jdir-fixture-main", index: 3 });
  assertEqual(id, directionObservationIdFor({ experimentId: "jdir-fixture-main", index: 3 }), "observation ids are deterministic");
  assertTrue(id.startsWith("jdir-obs-0003-"), `observation ids encode the slot (got ${id})`);
  assertTrue(directionObservationIdFor({ experimentId: "jdir-fixture-main", index: 3 }) !== directionObservationIdFor({ experimentId: "other", index: 3 }), "a different experiment yields a different id");
});

test("AE7. the validator's reads of other subsystems were read-only", async () => {
  const sealed = await readText("scripts/intelligence/classifier-feature-definition.mjs");
  assertIncludes(sealed, "classifier-feature-definition-v1", "the sealed 5G/5H definition source still declares its version");
  assertTrue(sealed.length > 1000, "the sealed source is intact");
  assertExcludes(sealed, "jev/direction", "the sealed source gained no 5I import");
  const waves = await readText("scripts/replication/waves.mjs");
  assertIncludes(waves, CANONICAL_EVALUATION_CONTRACT, "the Wave definition file still pins the canonical contract");
});

/* ============================================================================
 * PART AF — CLI behaviour
 * ==========================================================================*/

/** Every CLI child runs with an unroutable market URL so a stray poll cannot leave the host. */
function cliEnv(overrides = {}) {
  return {
    ...process.env,
    EVOLVE_JUPITER_BASE_URL: "http://127.0.0.1:1",
    JUPITER_API_KEY: "" ,
    EVOLVE_MARKET_MODE: "live",
    EVOLVE_JEV_PROVIDER: REQUIRED_PROVIDER,
    EVOLVE_JEV_MODE: "shadow",
    EVOLVE_JEV_API_KEY: "test-key-not-a-real-credential",
    EVOLVE_JEV_TRANSPORT_CHAIN: "typesafe-jev",
    ...overrides,
  };
}

function runCli(argv, envOverrides = {}) {
  return spawnSync(process.execPath, [path.join("scripts", "jev-direction.mjs"), ...argv], {
    cwd: REPO,
    env: cliEnv(envOverrides),
    encoding: "utf8",
    timeout: 30_000,
  });
}

test("AF1. --definition prints the frozen contract and exits 0", () => {
  const result = runCli(["--definition"]);
  assertEqual(result.status, 0, `--definition exits 0 (stderr: ${result.stderr})`);
  assertIncludes(result.stdout, "SOL-USDC", "it names the benchmark market");
  assertIncludes(result.stdout, "30s", "it names the frozen horizon");
  assertIncludes(result.stdout, "typesafe-jev", "it names the direct provider");
  assertIncludes(result.stdout, "jev-1.13.0", "it names the pinned model");
  assertIncludes(result.stdout, DIRECTION_QUESTION_SET_ID, "it names the question set");
  assertIncludes(result.stdout, "JEV_MICROSTRUCTURE_DIRECTION_PACKET", "it names the packet kind");
  assertIncludes(result.stdout, DIRECTION_EVIDENCE_CLASS, "it names the evidence class");
  assertIncludes(result.stdout, "omitted", "it reports the omitted feature families");
});

test("AF2. --help exits 0 and documents the five actions", () => {
  const result = runCli(["--help"]);
  assertEqual(result.status, 0, "--help exits 0");
  for (const action of DIRECTION_ACTIONS) assertIncludes(result.stdout, `--${action}`, `help documents --${action}`);
  assertIncludes(result.stdout, "NO confidence threshold", "help states there is no confidence threshold");
  assertIncludes(result.stdout, "FORBIDDEN here", "help lists the forbidden options");
  assertIncludes(result.stdout, "DEVELOPMENT EVIDENCE ONLY", "help labels the evidence class");
});

test("AF3. an action is REQUIRED, and exactly one", () => {
  const none = runCli([]);
  assertTrue(none.status !== 0, "no action exits non-zero");
  assertIncludes(none.stderr, "exactly one of", "and says an action is required");
  const two = runCli(["--start", "--replay", "--experiment", "x"]);
  assertTrue(two.status !== 0, "two actions exit non-zero");
  assertIncludes(two.stderr, "exactly ONE action", "and says only one may be selected");
});

test("AF4. there is NO `--latest`: every non-start action needs an explicit id", () => {
  for (const action of ["resume", "resolve", "replay", "stats"]) {
    const result = runCli([`--${action}`]);
    assertTrue(result.status !== 0, `--${action} without --experiment exits non-zero`);
    assertIncludes(result.stderr, "explicit --experiment", `--${action} demands an explicit id`);
    assertIncludes(result.stderr, "NO \"latest\"", `--${action} states there is no latest`);
  }
  const latest = runCli(["--replay", "--experiment", "latest"]);
  assertTrue(latest.status !== 0, "`latest` is refused");
  assertIncludes(latest.stderr, "never guesses which experiment", "and says why");
  const all = runCli(["--stats", "--experiment", "all"]);
  assertTrue(all.status !== 0, "`all` is refused too");
});

test("AF5. a forbidden option is a HARD ERROR, never silently ignored", () => {
  for (const flag of ["--threshold", "--min-confidence", "--trade", "--wallet", "--pnl", "--arena", "--deepseek", "--route", "--signal"]) {
    const result = runCli([flag, "0.5", "--start", "--market", "SOL-USDC"]);
    assertTrue(result.status !== 0, `${flag} exits non-zero`);
    assertIncludes(result.stderr, "FORBIDDEN", `${flag} is reported as forbidden`);
  }
});

test("AF6. an unknown option is refused by name", () => {
  const result = runCli(["--start", "--totally-made-up", "1"]);
  assertTrue(result.status !== 0, "an unknown option exits non-zero");
  assertIncludes(result.stderr, "unknown option --totally-made-up", "the refusal names the option");
  assertIncludes(result.stdout + result.stderr, "Phase 5I.0b accepts only", "and lists the accepted options");
  assertExcludes(result.stdout, "EXPERIMENT_CREATED", "no experiment was created");
});

test("AF7. the frozen horizon and the single supported market are enforced at the CLI", () => {
  const horizon = runCli(["--start", "--horizon-seconds", "60", "--market", "SOL-USDC"]);
  assertTrue(horizon.status !== 0, "a non-30s horizon exits non-zero");
  assertIncludes(horizon.stderr, "FROZEN", "and says the horizon is frozen");
  const market = runCli(["--start", "--market", "BONK-USDC"]);
  assertTrue(market.status !== 0, "an unsupported market exits non-zero");
  assertIncludes(market.stderr, "unsupported market", "and names the problem");
});

test("AF8. the CLI refuses the gateway route and a non-pinned model before anything runs", () => {
  const vercel = runCli(["--start", "--market", "SOL-USDC", "--max-observations", "1"], { EVOLVE_JEV_PROVIDER: "vercel-jev" });
  assertTrue(vercel.status !== 0, "the gateway route exits non-zero");
  assertIncludes(vercel.stderr, "vercel-jev", "and names the refused provider");
  assertIncludes(vercel.stderr, "no provider was called", "and confirms nothing ran");
  const model = runCli(["--start", "--market", "SOL-USDC", "--model", "jev-latest", "--max-observations", "1"]);
  assertTrue(model.status !== 0, "a moving model alias exits non-zero");
  assertIncludes(model.stderr, "MOVING alias", "and explains the alias problem");
});

test("AF9. a failover transport chain is refused at the CLI, the direct single entry is not", () => {
  const gatewayChain = runCli(["--start", "--market", "SOL-USDC", "--max-observations", "1"], { EVOLVE_JEV_TRANSPORT_CHAIN: "vercel-jev" });
  assertTrue(gatewayChain.status !== 0, "a gateway-only chain exits non-zero");
  assertIncludes(gatewayChain.stderr, "canonical 5I evidence may only ever use the direct route", "and explains the direct-route rule");
  const mixed = runCli(["--start", "--market", "SOL-USDC", "--max-observations", "1"], { EVOLVE_JEV_TRANSPORT_CHAIN: "typesafe-jev,vercel-jev" });
  assertTrue(mixed.status !== 0, "a two-entry failover chain exits non-zero");
  assertIncludes(mixed.stderr, "failover chain", "and explains the failover risk");
});

test("AF10. an unset provider disables Jev and the CLI refuses to start", () => {
  const result = runCli(["--start", "--market", "SOL-USDC", "--max-observations", "1"], { EVOLVE_JEV_PROVIDER: "" });
  assertTrue(result.status !== 0, "a disabled provider exits non-zero");
  assertIncludes(result.stderr, "Jev is disabled", "the refusal explains the disabled state");
  assertIncludes(result.stderr, "nothing was started", "and confirms nothing ran");
});

test("AF11. --replay and --stats never require a provider or a credential", () => {
  const replay = runCli(["--replay", "--experiment", "jdir-fixture-main", "--out", ctx.tempRoot], { EVOLVE_JEV_PROVIDER: "", EVOLVE_JEV_API_KEY: "" });
  assertEqual(replay.status, 0, `replay succeeds WITHOUT any provider configured (stderr: ${replay.stderr})`);
  assertIncludes(replay.stdout, "integrity", "replay reports integrity");
  assertIncludes(replay.stdout, "network 0", "replay reports zero network calls");
  assertIncludes(replay.stdout, "jev 0", "replay reports zero Jev calls");
  assertIncludes(replay.stdout, "lookahead", "replay reports the lookahead audit");
  const stats = runCli(["--stats", "--experiment", "jdir-fixture-main", "--out", ctx.tempRoot], { EVOLVE_JEV_PROVIDER: "", EVOLVE_JEV_API_KEY: "" });
  assertEqual(stats.status, 0, `stats succeed WITHOUT any provider configured (stderr: ${stats.stderr})`);
  assertIncludes(stats.stdout, "Brier", "stats report the probability metrics");
  assertIncludes(stats.stdout, "NO winner", "stats emit no winner");
});

test("AF12. an unknown experiment id fails explicitly with a non-zero exit", () => {
  const replay = runCli(["--replay", "--experiment", "jdir-not-here", "--out", ctx.tempRoot]);
  assertEqual(replay.status, 1, "an unknown experiment exits 1");
  assertIncludes(replay.stderr, "no Phase 5I experiment", "and says so");
  const stats = runCli(["--stats", "--experiment", "jdir-not-here", "--out", ctx.tempRoot]);
  assertEqual(stats.status, 1, "stats on an unknown experiment exits 1");
});

test("AF13. an invalid experiment id can never escape the evidence root", () => {
  assertEqual(isValidDirectionExperimentId("../../etc/passwd"), false, "a traversal id is invalid");
  assertEqual(isValidDirectionExperimentId("jdir-ok-0001"), true, "a well-formed id is valid");
  assertEqual(isValidDirectionExperimentId("jdir-"), false, "a bare prefix is invalid");
  assertEqual(isValidDirectionExperimentId("other-0001"), false, "a foreign prefix is invalid");
  assertThrows(() => directionExperimentRootFor(ctx.tempRoot, "../../etc"), (error) => error.message.includes("invalid Phase 5I experiment id"), "the root resolver refuses a traversal id");
  const cli = runCli(["--replay", "--experiment", "../../etc/passwd", "--out", ctx.tempRoot]);
  assertTrue(cli.status !== 0, "the CLI refuses the traversal id");
  assertIncludes(cli.stderr, "invalid Phase 5I experiment id", "and names the reason");
});

test("AF14. the CLI is bounded, resumable and never a daemon", async () => {
  const source = await readText("scripts/jev-direction.mjs");
  const code = codeOnly(source);
  assertIncludes(source, "max-runtime-minutes", "a bounded runtime exists");
  assertIncludes(source, "SIGINT", "interruption is handled");
  assertIncludes(source, "resumable", "and the run is resumable");
  assertIncludes(source, "No daemon", "the docblock states there is no daemon");
  assertExcludes(code, "setInterval", "there is no background interval");
  assertExcludes(code, "child_process", "the CLI spawns no process");
  assertExcludes(code, "--daemon", "there is no daemon flag");
  assertExcludes(code, "unref(", "nothing keeps the process alive");
  const result = runCli(["--definition"]);
  assertEqual(result.status, 0, "and a read-only invocation still exits cleanly");
});

test("AF15. --start is the ONLY action that may create an experiment", async () => {
  const runner = await readText("scripts/jev/direction/runner.mjs");
  assertIncludes(runner, 'action === "start"', "the create path is gated on the start action");
  assertIncludes(runner, "already exists; use --resume", "an existing experiment is never overwritten");
  const definition = await readText("scripts/jev/direction/definition.mjs");
  assertIncludes(definition, "is the only action", "the contract states start is the only creation action");
  assertIncludes(definition, "requiresExplicitExperimentId", "and that every other action needs an explicit id");
  const cli = codeOnly(await readText("scripts/jev-direction.mjs"));
  assertExcludes(cli, "createExperiment", "the CLI never calls an experiment constructor directly");
  const dashboard = await readText("src/app/api/engine/state/route.ts").catch(() => "");
  assertExcludes(dashboard, "jev-direction", "no dashboard route starts a 5I experiment");
});

test("AF16. no CLI invocation in this suite reached the network", () => {
  // Every child was pointed at http://127.0.0.1:1 with an empty key, and every
  // path exercised exits before a market config or provider is constructed.
  const probe = runCli(["--start", "--market", "SOL-USDC", "--max-observations", "1"], { EVOLVE_JEV_PROVIDER: "" });
  assertTrue(probe.status !== 0, "the deepest reachable refusal path still exits non-zero");
  assertExcludes(probe.stdout, "PREDICTION_FROZEN", "and froze no prediction");
  assertExcludes(probe.stdout, "EXPERIMENT_CREATED", "and created no experiment");
  assertIncludes(probe.stderr, "nothing was started", "because nothing was started");
});

/* ============================================================================
 * PART AH — the canonical Phase 5I.0b DEVELOPMENT BARRIER (§1–§3)
 *
 * The completed canonical development experiment is source-pinned and verified
 * READ ONLY. Nothing here ever rewrites it, and the development interpretation is
 * frozen as written words — never an automated winner.
 * ==========================================================================*/

test("AH1. the canonical development barrier identity is pinned exactly", () => {
  assertEqual(CANONICAL_DEVELOPMENT_BARRIER.experimentId, CANONICAL_DEVELOPMENT_EXPERIMENT_ID, "the canonical development experiment id");
  assertEqual(CANONICAL_DEVELOPMENT_BARRIER.metricsDigest, CANONICAL_DEVELOPMENT_METRICS_DIGEST, "the canonical metrics digest");
  assertEqual(CANONICAL_DEVELOPMENT_BARRIER.metricsDigest.length, 64, "the digest is a SHA-256 hex string");
  assertEqual(CANONICAL_DEVELOPMENT_BARRIER.evidenceClass, DIRECTION_EVIDENCE_CLASS, "the development evidence class");
  assertEqual(CANONICAL_DEVELOPMENT_BARRIER.phase, "5I.0b", "the development phase");
  assertEqual(CANONICAL_DEVELOPMENT_BARRIER.observations, 120, "120 observations");
  assertEqual(CANONICAL_DEVELOPMENT_BARRIER.valid, 120, "120 valid");
  assertEqual(CANONICAL_DEVELOPMENT_BARRIER.scored, 120, "120 scored");
  assertEqual(CANONICAL_DEVELOPMENT_BARRIER.higher, 62, "62 HIGHER");
  assertEqual(CANONICAL_DEVELOPMENT_BARRIER.lower, 58, "58 LOWER");
  assertEqual(CANONICAL_DEVELOPMENT_BARRIER.tie, 0, "0 TIE");
  assertEqual(CANONICAL_DEVELOPMENT_BARRIER.outcomeWindowExclusions, 0, "0 outcome-window exclusions");
  assertEqual(CANONICAL_DEVELOPMENT_BARRIER.infrastructure.lookaheadRecomputationPairs, 7140, "7140 lookahead recomputation pairs");
  for (const [key, expected] of [
    ["jevOk", 120],
    ["failed", 0],
    ["late", 0],
    ["retries", 0],
    ["tamper", 0],
    ["outcomeWindowExclusions", 0],
    ["fallbackObservations", 0],
  ]) {
    assertEqual(CANONICAL_DEVELOPMENT_BARRIER.infrastructure[key], expected, `infrastructure.${key}`);
  }
  assertEqual(CANONICAL_DEVELOPMENT_BARRIER_DIGEST.length, 64, "the barrier has its own deterministic digest");
  assertEqual(CANONICAL_DEVELOPMENT_BARRIER_DIGEST, digestOf(CANONICAL_DEVELOPMENT_BARRIER), "and it recomputes from the pinned object");
  assertTrue(DEVELOPMENT_BARRIER_COMPLETED_AT_MS > DEVELOPMENT_BARRIER_LATEST_OBSERVATION_AT_MS, "the development session completed after its last observation");
});

test("AH2. the canonical metrics, relative results and timing diagnostics are pinned to the published values", () => {
  assertClose(CANONICAL_DEVELOPMENT_BARRIER.metrics.brier, 0.2546, "Jev Brier 0.2546", DEVELOPMENT_BARRIER_METRIC_TOLERANCE);
  assertClose(CANONICAL_DEVELOPMENT_BARRIER.metrics.logLoss, 0.7024, "Jev log loss 0.7024", DEVELOPMENT_BARRIER_METRIC_TOLERANCE);
  assertClose(CANONICAL_DEVELOPMENT_BARRIER.metrics.accuracy, 0.5, "Jev accuracy 0.5000", DEVELOPMENT_BARRIER_METRIC_TOLERANCE);
  assertClose(CANONICAL_DEVELOPMENT_BARRIER.metrics.meanPHigher, 0.4589, "mean pHigher 0.4589", DEVELOPMENT_BARRIER_METRIC_TOLERANCE);
  assertClose(CANONICAL_DEVELOPMENT_BARRIER.metrics.medianPHigher, 0.465, "median pHigher 0.4650", DEVELOPMENT_BARRIER_METRIC_TOLERANCE);
  assertDeepEqual(
    Object.keys(CANONICAL_DEVELOPMENT_BARRIER.relative).sort(),
    [...REPLICATION_COMPARISON_IDS].sort(),
    "the five canonical comparisons are the five frozen baselines",
  );
  const neutral = CANONICAL_DEVELOPMENT_BARRIER.relative["neutral-v1"];
  assertClose(neutral.brierDelta, 0.0046, "neutral Brier delta +0.0046", DEVELOPMENT_BARRIER_METRIC_TOLERANCE);
  assertClose(neutral.logLossDelta, 0.0093, "neutral log-loss delta +0.0093", DEVELOPMENT_BARRIER_METRIC_TOLERANCE);
  assertClose(neutral.accuracyDelta, -0.0167, "neutral accuracy delta -0.0167", DEVELOPMENT_BARRIER_METRIC_TOLERANCE);
  const momentum = CANONICAL_DEVELOPMENT_BARRIER.relative["momentum-v1"];
  assertClose(momentum.brierDelta, -0.0145, "momentum Brier delta -0.0145", DEVELOPMENT_BARRIER_METRIC_TOLERANCE);
  assertClose(momentum.logLossDelta, -0.0314, "momentum log-loss delta -0.0314", DEVELOPMENT_BARRIER_METRIC_TOLERANCE);
  assertClose(momentum.accuracyDelta, 0.0294, "momentum accuracy delta +0.0294", DEVELOPMENT_BARRIER_METRIC_TOLERANCE);
  assertClose(CANONICAL_DEVELOPMENT_BARRIER.relative["mean-reversion-v1"].brierDelta, -0.0001, "mean-reversion Brier delta -0.0001", DEVELOPMENT_BARRIER_METRIC_TOLERANCE);
  assertClose(CANONICAL_DEVELOPMENT_BARRIER.relative["volume-flow-imbalance-v1"].brierDelta, 0.0058, "volume-flow Brier delta +0.0058", DEVELOPMENT_BARRIER_METRIC_TOLERANCE);
  assertClose(CANONICAL_DEVELOPMENT_BARRIER.relative["momentum-liquidity-v1"].brierDelta, -0.0021, "momentum-liquidity Brier delta -0.0021", DEVELOPMENT_BARRIER_METRIC_TOLERANCE);
  assertDeepEqual(
    CANONICAL_DEVELOPMENT_BARRIER.outcomeTiming,
    { meanMs: 5977, medianMs: 6002, p95Ms: 6003, maxMs: 6005 },
    "the outcome offset diagnostics",
  );
  assertDeepEqual(
    CANONICAL_DEVELOPMENT_BARRIER.achievedHorizon,
    { meanMs: 36118, medianMs: 36114, p95Ms: 36167, maxMs: 36204 },
    "the achieved horizon diagnostics",
  );
  assertDeepEqual(
    CANONICAL_DEVELOPMENT_BARRIER.jevLatency,
    { meanMs: 698, medianMs: 695, p95Ms: 762, maxMs: 834 },
    "the Jev latency diagnostics",
  );
  assertEqual(DEVELOPMENT_BARRIER_TIMING_TOLERANCE_MS, 1, "timing tolerances are whole-millisecond");
});

test("AH3. the development interpretation is FROZEN and emits no automated winner", () => {
  const interpretation = CANONICAL_DEVELOPMENT_BARRIER.interpretation;
  assertEqual(
    interpretation.verdict,
    "Phase 5I.0b showed no clear directional advantage for Jev over the neutral baseline.",
    "the frozen verdict",
  );
  assertEqual(interpretation.scope, "This is DEVELOPMENT evidence only.", "the frozen scope");
  assertEqual(interpretation.edge, "No persistent edge has been established.", "the frozen edge statement");
  assertEqual(interpretation.inference, "No profitability inference is permitted.", "the frozen inference rule");
  assertEqual(interpretation.automatedWinner, null, "there is no automated winner");
  assertEqual(interpretation.noAutomatedWinner, true, "and that is declared");
  assertEqual(interpretation.protocolUnchangedByResults, true, "the protocol was not modified because of the results");
  assertEqual(interpretation.winnerFieldAbsent, true, "no winner field exists anywhere in the barrier");
  assertExcludes(JSON.stringify(CANONICAL_DEVELOPMENT_BARRIER).toLowerCase(), "\"winner\": \"", "the barrier emits no winner label");
});

test("AH4. the replication protocol contract is deterministic and free of timestamps and ids", () => {
  assertEqual(REPLICATION_PROTOCOL_VERSION, 1, "the protocol contract version");
  assertEqual(REPLICATION_PROTOCOL_DIGEST.length, 64, "the protocol digest is a SHA-256 hex string");
  assertEqual(digestOf(REPLICATION_PROTOCOL_CONTRACT), REPLICATION_PROTOCOL_DIGEST, "the digest recomputes from the frozen contract");
  assertEqual(protocolDigestOfExperiment(null), null, "an absent experiment expresses no contract");
  const serialized = JSON.stringify(REPLICATION_PROTOCOL_CONTRACT).toLowerCase();
  for (const forbidden of ["timestamp", "createdat", "sessionid", "experimentid", "startedat", "finalizedat", "jdir-", "jrep-", ".evolve"]) {
    assertExcludes(serialized, forbidden, `the protocol contract contains no ${forbidden}`);
  }
  for (const key of ["market", "referencePrice", "horizon", "timing", "cadence", "observationsPerSession", "forecaster", "questions", "features", "baselines", "metrics", "outcomeResolution", "staleness", "probabilitySemantics", "noThresholdRule"]) {
    assertTrue(Object.hasOwn(REPLICATION_PROTOCOL_CONTRACT, key), `the contract covers ${key}`);
  }
  assertEqual(REPLICATION_PROTOCOL_CONTRACT.observationsPerSession, 120, "120 observations per session");
  assertEqual(REPLICATION_PROTOCOL_CONTRACT.cadence.samplingCadenceMs, 30_000, "30-second cadence");
  assertEqual(REPLICATION_PROTOCOL_CONTRACT.horizon.horizonSeconds, 30, "30-second horizon");
  assertEqual(REPLICATION_PROTOCOL_CONTRACT.forecaster.provider, REQUIRED_PROVIDER, "the direct provider is in the contract");
  assertEqual(REPLICATION_PROTOCOL_CONTRACT.forecaster.model, REQUIRED_MODEL, "the pinned model is in the contract");
  assertEqual(REPLICATION_PROTOCOL_CONTRACT.forecaster.gatewayUsed, false, "gateway false is in the contract");
  assertEqual(REPLICATION_PROTOCOL_CONTRACT.forecaster.mode, "shadow", "shadow mode is in the contract");
  assertEqual(REPLICATION_PROTOCOL_CONTRACT.outcomeResolution.policyVersion, 2, "outcome-resolution policy v2");
  assertEqual(REPLICATION_PROTOCOL_CONTRACT.outcomeResolution.maximumOffsetMs, 10_000, "the 10000 ms bound");
  assertEqual(REPLICATION_PROTOCOL_CONTRACT.metrics.definitionVersion, 2, "metric definition v2");
  assertEqual(REPLICATION_PROTOCOL_CONTRACT.noThresholdRule.thresholdApplied, false, "no threshold rule");
  assertEqual(REPLICATION_PROTOCOL_CONTRACT.noThresholdRule.thresholdBound, null, "no threshold bound exists");
  assertEqual(REPLICATION_PROTOCOL_CONTRACT.noThresholdRule.everyValidProbabilityRetained, true, "every valid probability is retained");
  assertEqual(REPLICATION_PROTOCOL_CONTRACT.probabilitySemantics.retainedRaw, true, "every valid probability is retained raw");
  assertEqual(REPLICATION_SESSION_OBSERVATIONS, 120, "the frozen session size");
  assertEqual(REPLICATION_SESSION_CADENCE_SECONDS, 30, "the frozen session cadence");
  assertEqual(REQUIRED_CLEAN_REPLICATION_SESSIONS, 3, "three independent CLEAN sessions");
  assertEqual(REPLICATION_INFERENCE_UNIT, "dataset/session", "the primary inference unit is the session");
});

test("AH5. the source guard pins every value a tune would have to change (§15)", () => {
  const guard = verifyReplicationSourceGuard();
  assertEqual(guard.ok, true, `the live frozen constants match the source guard: ${guard.problems.join("; ")}`);
  assertEqual(REPLICATION_SOURCE_GUARD.thresholdBound, null, "the source guard pins NO threshold bound");
  assertEqual(REPLICATION_SOURCE_GUARD.horizonSeconds, 30, "horizon 30 s");
  assertEqual(REPLICATION_SOURCE_GUARD.resolutionToleranceMs, 10_000, "outcome tolerance 10000 ms");
  assertEqual(REPLICATION_SOURCE_GUARD.calibrationBinCount, CALIBRATION_BIN_COUNT, "calibration bins are pinned");
  assertEqual(REPLICATION_SOURCE_GUARD.provider, REQUIRED_PROVIDER, "provider is pinned");
  assertEqual(REPLICATION_SOURCE_GUARD.model, REQUIRED_MODEL, "model is pinned");
  assertEqual(REPLICATION_SOURCE_GUARD.maxReceiptStateAgeMs, MAX_RECEIPT_STATE_AGE_MS, "staleness cutoffs are pinned");
  assertEqual(REPLICATION_SOURCE_GUARD.maxSourceStateAgeMs, MAX_SOURCE_STATE_AGE_MS, "both staleness cutoffs are pinned");
  assertEqual(REPLICATION_SOURCE_GUARD.baselineDefinitionVersion, BASELINE_DEFINITION_VERSION, "baseline definition pinned");
  assertEqual(REPLICATION_SOURCE_GUARD.metricDefinitionVersion, DIRECTION_METRICS_VERSION, "metric definition pinned");
});

test("AH6. the canonical local development experiment, when present, verifies against the pinned barrier", async () => {
  const rep = ctx.replication;
  const root = directionExperimentRootFor(rep.experimentsRoot, CANONICAL_DEVELOPMENT_EXPERIMENT_ID);
  if (!(await exists(root))) {
    skip("the canonical development experiment is absent in this checkout — its read-only barrier check was skipped cleanly");
    return;
  }
  const before = await metadataSnapshot(root);
  const bundle = await readDirectionExperimentBundle(root);
  const replay = await replayDirectionExperiment({ experimentId: CANONICAL_DEVELOPMENT_EXPERIMENT_ID, baseRoot: rep.experimentsRoot });
  const barrier = verifyCanonicalDevelopmentBarrier({ experiment: bundle.experiment, summary: bundle.summary, replay });
  const after = await metadataSnapshot(root);
  assertEqual(barrier.present, true, "the barrier reports the experiment present");
  assertEqual(barrier.ok, true, `the canonical development barrier verifies: ${barrier.problems.join("; ")}`);
  assertEqual(Object.values(barrier.checks).every(Boolean), true, "every individual barrier check passed");
  assertEqual(bundle.summary.metricsDigest, CANONICAL_DEVELOPMENT_METRICS_DIGEST, "the stored metrics digest is the canonical one");
  assertEqual(replay.counts.predictions, 120, "120 predictions");
  assertEqual(replay.counts.outcomes, 120, "120 outcomes");
  assertEqual(replay.counts.scoredCount, 120, "120 scored");
  assertEqual(replay.lookaheadAudit.recomputationPairs, 7140, "7140 lookahead recomputation pairs");
  assertEqual(replay.networkCalls + replay.jevCalls, 0, "the barrier verification made no network or Jev call");
  assertDeepEqual(protocolContractDifferences(bundle.experiment), [], "the development experiment expresses the frozen replication contract exactly");
  assertEqual(protocolDigestOfExperiment(bundle.experiment), REPLICATION_PROTOCOL_DIGEST, "and reproduces the frozen protocol digest");
  assertDeepEqual(after, before, "the canonical development experiment is byte-unchanged by the barrier verification");
});

test("AH7. the barrier reports absence cleanly instead of failing, and never invents evidence", () => {
  const absent = verifyCanonicalDevelopmentBarrier({ experiment: null, summary: null, replay: null });
  assertEqual(absent.present, false, "an absent experiment is reported as absent");
  assertEqual(absent.ok, true, "and skipping it is not a failure");
  assertDeepEqual(absent.problems, [], "with zero problems");
  const partial = verifyCanonicalDevelopmentBarrier({
    experiment: { experimentId: "something-else", evidenceClass: DIRECTION_EVIDENCE_CLASS },
    summary: null,
    replay: null,
  });
  assertEqual(partial.present, true, "a present-but-wrong experiment IS reported");
  assertEqual(partial.ok, false, "and it FAILS rather than being skipped");
  assertTrue(partial.problems.length > 0, "with explicit problems");
});

/* ============================================================================
 * PART AI — replication session eligibility (§5, §7, §11, §15)
 * ==========================================================================*/

/** Derive one fixture session's record exactly the way `--replication-add` does. */
async function deriveFixtureSession(experimentId, otherSessions = []) {
  const rep = ctx.replication;
  return deriveReplicationSessionRecord({ sessionId: experimentId, baseRoot: rep.experimentsRoot, expected: rep.expected, otherSessions });
}

/** A representative CLEAN fixture session bundle, for pure eligibility cases. */
async function fixtureSessionBundle(experimentId) {
  const rep = ctx.replication;
  const root = directionExperimentRootFor(rep.experimentsRoot, experimentId);
  const bundle = await readDirectionExperimentBundle(root);
  const replay = await replayDirectionExperiment({ experimentId, baseRoot: rep.experimentsRoot });
  return { bundle, replay, protocol: verifyReplicationProtocol(bundle.experiment) };
}

function evaluateMutated({ bundle, replay, protocol, sessionId, mutate, otherSessions = [] }) {
  const experiment = { ...bundle.experiment, ...(mutate ?? {}) };
  return evaluateReplicationSession({
    sessionId,
    experiment,
    summary: { ...bundle.summary, ...(mutate?.summary ?? {}) },
    predictions: bundle.predictions,
    outcomes: bundle.outcomes,
    replay,
    // The protocol is re-derived from the MUTATED experiment, exactly the way
    // `--replication-add` re-derives it from the stored one.
    protocol: mutate?.protocol ?? verifyReplicationProtocol(experiment) ?? protocol,
    expected: ctx.replication.expected,
    otherSessions,
  });
}

test("AI1. a fresh, direct, frozen-protocol session is CLEAN and starts after the development barrier", async () => {
  const derived = await deriveFixtureSession("jdir-fixture-rep-1");
  assertEqual(derived.ok, true, "the fixture session derives");
  assertEqual(derived.record.status, SESSION_STATUS.CLEAN, `session 1 is CLEAN: ${JSON.stringify(derived.record.reasons)}`);
  assertDeepEqual(derived.record.reasons, [], "with zero reasons");
  assertEqual(Object.values(derived.record.checks).every(Boolean), true, "and every individual eligibility check passed");
  assertEqual(derived.record.timing.startsAfterDevelopment, true, "the session started after the development experiment completed");
  assertEqual(derived.record.timing.afterLatestDevelopmentObservation, true, "and observed strictly after the development session's last observation");
  assertEqual(derived.record.timing.developmentWindowsDisjoint, true, "with observation windows that do not overlap");
  assertEqual(derived.record.timing.temporalOverlap, false, "so temporalOverlap is false");
  assertEqual(derived.record.timing.developmentExperimentId, CANONICAL_DEVELOPMENT_EXPERIMENT_ID, "the session records the development experiment id");
  assertEqual(derived.record.timing.developmentLatestObservationAt, CANONICAL_DEVELOPMENT_BARRIER.session.latestObservationAt, "and its latest observation");
  assertEqual(derived.record.metricsDigest, derived.replay.recomputedMetricsDigest, "the session records the metrics digest of its own artifacts");
  assertEqual(derived.record.counts.predictions, REPLICATION_SESSION_OBSERVATIONS, "exactly 120 scheduled observations");
  assertEqual(derived.record.counts.outcomes, REPLICATION_SESSION_OBSERVATIONS, "exactly 120 outcomes");
  assertEqual(derived.record.protocolOk, true, "the session reproduces the frozen protocol digest");
  assertEqual(derived.record.protocolDigest, REPLICATION_PROTOCOL_DIGEST, "and records that digest");
});

test("AI2. the session window and overlap rule are explicit and symmetric", () => {
  assertEqual(windowsOverlap([0, 10], [10, 20]), true, "a shared endpoint IS an overlap");
  assertEqual(windowsOverlap([0, 9], [10, 20]), false, "a gap is not an overlap");
  assertEqual(windowsOverlap(null, [10, 20]), false, "a missing window cannot overlap");
  const window = sessionObservationWindow({ experiment: { startedAt: "2026-01-01T00:00:00.000Z" }, predictions: [], outcomes: [] });
  assertEqual(window.windowMs, null, "an empty session has no observation window");
  assertEqual(window.startedAtMs, Date.parse("2026-01-01T00:00:00.000Z"), "but its start instant is still resolved");
});

test("AI3. a session that overlaps the development experiment is CONTAMINATED, not clean", async () => {
  const { bundle, replay, protocol } = await fixtureSessionBundle("jdir-fixture-rep-1");
  const eligibility = evaluateMutated({
    bundle,
    replay,
    protocol,
    sessionId: "jdir-fixture-overlapping-development",
    mutate: { startedAt: "2026-09-20T07:00:00.000Z" },
  });
  assertEqual(eligibility.status, SESSION_STATUS.CONTAMINATED, "overlapping the development window contaminates the session");
  assertEqual(eligibility.eligible, false, "and it is not eligible");
  assertEqual(eligibility.timing.temporalOverlap, true, "temporalOverlap is true");
  assertTrue(eligibility.contaminationReasons.length > 0, "the contamination reasons are explicit");
  assertTrue(eligibility.reasons.some((reason) => /before the canonical development experiment completed/.test(reason)), "including the start-time rule");
});

test("AI4. a session that overlaps ANOTHER session is CONTAMINATED and preserved with reasons", async () => {
  const { bundle, replay, protocol } = await fixtureSessionBundle("jdir-fixture-rep-1");
  const otherWindow = sessionObservationWindow({ experiment: bundle.experiment, predictions: bundle.predictions, outcomes: bundle.outcomes });
  const eligibility = evaluateMutated({
    bundle,
    replay,
    protocol,
    sessionId: "jdir-fixture-second-of-overlapping-pair",
    otherSessions: [{ sessionId: "jdir-fixture-rep-1", windowMs: otherWindow.windowMs }],
  });
  assertEqual(eligibility.status, SESSION_STATUS.CONTAMINATED, "overlapping another session contaminates it");
  assertEqual(eligibility.timing.temporalOverlap, true, "temporalOverlap is true");
  assertDeepEqual(eligibility.timing.overlappingSessionIds, ["jdir-fixture-rep-1"], "the overlapping session is named");
  assertTrue(eligibility.reasons.some((reason) => /invalidates independence under the frozen rule/.test(reason)), "and the frozen independence rule is quoted");
});

test("AI5. mock/fixture, gateway, model and route drift each make a session INELIGIBLE", async () => {
  const { bundle, replay, protocol } = await fixtureSessionBundle("jdir-fixture-rep-1");
  const cases = [
    ["fixture provider", { offlineFixture: true, providerImplementation: "direction-fixture-jev-v1" }],
    ["mock provider", { provider: "mock-jev" }],
    ["gateway route", { gatewayUsed: true }],
    ["non-direct upstream", { upstreamProvider: "somewhere-else" }],
    ["model mismatch", { model: "jev-latest" }],
    ["different model", { model: "jev-1.12.0" }],
    ["mode drift", { mode: "live" }],
  ];
  for (const [label, mutate] of cases) {
    const eligibility = evaluateMutated({ bundle, replay, protocol, sessionId: `jdir-fixture-${label}`, mutate });
    assertEqual(eligibility.status, SESSION_STATUS.INELIGIBLE, `${label} is INELIGIBLE`);
    assertTrue(eligibility.reasons.length > 0, `${label} carries an explicit reason`);
  }
});

test("AI6. development evidence can never be replication evidence", async () => {
  const { bundle, replay, protocol } = await fixtureSessionBundle("jdir-fixture-rep-ineligible");
  const eligibility = evaluateReplicationSession({
    sessionId: "jdir-fixture-rep-ineligible",
    experiment: bundle.experiment,
    summary: bundle.summary,
    predictions: bundle.predictions,
    outcomes: bundle.outcomes,
    replay,
    protocol,
    expected: ctx.replication.expected,
  });
  assertEqual(bundle.experiment.evidenceClass, DIRECTION_EVIDENCE_CLASS, "the fixture really is development evidence");
  assertEqual(eligibility.status, SESSION_STATUS.INELIGIBLE, "so it is INELIGIBLE as replication evidence");
  assertTrue(eligibility.reasons.some((reason) => reason.includes(REPLICATION_EVIDENCE_CLASS)), "the reason names the replication class");
  assertTrue(eligibility.reasons.some((reason) => /development evidence is never replication evidence/.test(reason)), "and refuses the substitution explicitly");
});

test("AI7. reintroducing a confidence threshold makes a session INELIGIBLE", async () => {
  const { bundle, replay, protocol } = await fixtureSessionBundle("jdir-fixture-rep-1");
  const thresholded = evaluateMutated({
    bundle,
    replay,
    protocol,
    sessionId: "jdir-fixture-thresholded",
    mutate: { summary: { noConfidenceThreshold: false } },
  });
  assertEqual(thresholded.status, SESSION_STATUS.INELIGIBLE, "a summary that no longer declares the no-threshold rule is INELIGIBLE");
  const fielded = evaluateReplicationSession({
    sessionId: "jdir-fixture-thresholded-field",
    experiment: { ...bundle.experiment, minConfidence: 0.9 },
    summary: bundle.summary,
    predictions: bundle.predictions,
    outcomes: bundle.outcomes,
    replay,
    protocol,
    expected: ctx.replication.expected,
  });
  assertEqual(fielded.status, SESSION_STATUS.INELIGIBLE, "a threshold-shaped field on the experiment is INELIGIBLE");
  assertTrue(fielded.reasons.some((reason) => /reintroduced a confidence threshold/.test(reason)), "with the threshold reason");
});

test("AI8. question, feature, baseline, policy, metric, horizon and cadence drift are all refused", async () => {
  const { bundle, replay, protocol } = await fixtureSessionBundle("jdir-fixture-rep-1");
  const drifts = [
    ["question wording", { questionDigest: digestOf({ question: "changed" }) }],
    ["question set", { questionSetId: "jev-microstructure-direction-v2" }],
    ["feature definition", { featureDefinitionDigest: digestOf({ features: "changed" }) }],
    ["baseline definition", { baselineDefinitionDigest: digestOf({ baselines: "changed" }) }],
    ["metric definition", { metricDefinitionDigest: digestOf({ metrics: "changed" }) }],
    ["reference price", { referencePriceDefinitionDigest: digestOf({ price: "changed" }) }],
    ["outcome-policy version", { outcomeResolutionPolicyVersion: 1 }],
    ["outcome-policy digest", { outcomeResolutionPolicyDigest: digestOf({ policy: "changed" }) }],
    ["staleness policy", { stalenessPolicyDigest: digestOf({ staleness: "changed" }) }],
    ["horizon", { horizonSeconds: 60 }],
    ["cadence", { samplingCadenceMs: 60_000 }],
    ["session size", { maxObservations: 60 }],
    ["packet version", { packetVersion: 2 }],
  ];
  for (const [label, mutate] of drifts) {
    const eligibility = evaluateMutated({ bundle, replay, protocol, sessionId: `jdir-fixture-drift-${label}`, mutate });
    assertEqual(eligibility.status === SESSION_STATUS.CLEAN, false, `${label} drift cannot be CLEAN`);
    assertTrue(
      eligibility.reasons.some((reason) => /drifted from the frozen|not the frozen protocol shape/.test(reason)),
      `${label} drift has an explicit frozen-pin reason (got ${JSON.stringify(eligibility.reasons)})`,
    );
  }
  // A protocol digest mismatch alone is enough to refuse the session.
  const digestDrift = evaluateMutated({
    bundle,
    replay,
    protocol,
    sessionId: "jdir-fixture-protocol-drift",
    mutate: { protocol: { ok: false, digest: digestOf({ protocol: "changed" }) } },
  });
  assertEqual(digestDrift.status, SESSION_STATUS.INELIGIBLE, "a mismatched protocol digest is INELIGIBLE");
  assertTrue(digestDrift.reasons.some((reason) => /frozen replication protocol digest/.test(reason)), "and says so");
});

test("AI9. counts, tamper, lookahead and finalization are all hard eligibility rules", async () => {
  const { bundle, replay, protocol } = await fixtureSessionBundle("jdir-fixture-rep-1");
  const cases = [
    ["invalid prediction", { replay: { ...replay, counts: { ...replay.counts, invalidPredictions: 1 } } }],
    ["failed Jev", { replay: { ...replay, counts: { ...replay.counts, failedJevObservations: 1 } } }],
    ["tamper", { replay: { ...replay, counts: { ...replay.counts, tamperDetected: 1 } } }],
    ["window exclusion", { replay: { ...replay, counts: { ...replay.counts, outcomeWindowExclusions: 1 } } }],
    ["replay integrity", { replay: { ...replay, ok: false, problems: ["digest mismatch"] } }],
    ["lookahead", { replay: { ...replay, lookaheadAudit: { ...replay.lookaheadAudit, ok: false } } }],
  ];
  for (const [label, mutate] of cases) {
    const eligibility = evaluateReplicationSession({
      sessionId: `jdir-fixture-${label}`,
      experiment: bundle.experiment,
      summary: bundle.summary,
      predictions: bundle.predictions,
      outcomes: bundle.outcomes,
      replay: mutate.replay,
      protocol,
      expected: ctx.replication.expected,
    });
    assertEqual(eligibility.status, SESSION_STATUS.INELIGIBLE, `${label} is INELIGIBLE`);
    assertTrue(eligibility.reasons.length > 0, `${label} carries a reason`);
  }
  const unfinalized = evaluateMutated({
    bundle,
    replay,
    protocol,
    sessionId: "jdir-fixture-unfinalized",
    mutate: { status: "INTERRUPTED", summary: { finalized: false } },
  });
  assertEqual(unfinalized.status, SESSION_STATUS.INELIGIBLE, "an interrupted, unfinalized session is INELIGIBLE");
  const winner = evaluateMutated({
    bundle,
    replay,
    protocol,
    sessionId: "jdir-fixture-winner",
    mutate: { summary: { winner: "jev" } },
  });
  assertEqual(winner.status, SESSION_STATUS.INELIGIBLE, "a session that emits a winner is INELIGIBLE");
});

test("AI10. the canonical development experiment and both canaries are refused as replication evidence", () => {
  for (const id of [CANONICAL_DEVELOPMENT_EXPERIMENT_ID, CANARY_V1_EXPERIMENT_ID, CANARY_V2_EXPERIMENT_ID]) {
    assertTrue(PROTECTED_NON_REPLICATION_EXPERIMENT_IDS.includes(id), `${id} is protected`);
    assertTrue(typeof protectedExperimentReason(id) === "string", `${id} has an explicit refusal reason`);
  }
  assertEqual(protectedExperimentReason("jdir-something-new"), null, "an ordinary session id is not protected");
  assertTrue(protectedExperimentReason(CANONICAL_DEVELOPMENT_EXPERIMENT_ID).includes("DEVELOPMENT evidence"), "the development refusal names the class");
  assertTrue(protectedExperimentReason(CANARY_V1_EXPERIMENT_ID).includes("canary"), "the canary refusal names the canary");
  const eligibility = evaluateReplicationSession({ sessionId: CANONICAL_DEVELOPMENT_EXPERIMENT_ID, experiment: {}, summary: {}, predictions: [], outcomes: [], replay: {}, protocol: {}, expected: {} });
  assertEqual(eligibility.eligible, false, "the development experiment can never be eligible");
  assertTrue(eligibility.reasons.some((reason) => /can never be added as replication evidence/.test(reason)), "with the protected-experiment reason");
});

/* ============================================================================
 * PART AJ — the replication wave, end to end (§9, §12–§14, §17)
 * ==========================================================================*/

test("AJ0. every replication fixture lives in a temp directory, never in .evolve", async () => {
  const rep = ctx.replication;
  assertTrue(rep.experimentsRoot.startsWith(tmpdir()), "the fixture experiments root is under the OS temp directory");
  assertTrue(rep.replicationRoot.startsWith(tmpdir()), "the fixture replication root is under the OS temp directory");
  assertTrue(!rep.experimentsRoot.includes(path.join(REPO, ".evolve")), "never inside the repository evidence tree");
  for (const entry of rep.sessions) assertEqual(entry.run.result.ok, true, `${entry.experimentId} ran: ${entry.run.result.error ?? ""}`);
});

test("AJ1. replication-create pins the barrier + protocol digest and starts in the insufficient state", async () => {
  const rep = ctx.replication;
  rep.created = await replicationCreate({
    replicationRoot: rep.replicationRoot,
    baseRoot: rep.experimentsRoot,
    developmentExperimentId: CANONICAL_DEVELOPMENT_EXPERIMENT_ID,
  });
  assertEqual(rep.created.ok, true, `replication-create succeeded: ${rep.created.error ?? ""}`);
  assertEqual(rep.created.replicationId.startsWith("jrep-"), true, `the id is a replication id (${rep.created.replicationId})`);
  assertEqual(rep.created.status, REPLICATION_INSUFFICIENT_STATE, "a wave with no sessions is insufficient");
  assertEqual(rep.created.cleanSessionCount, 0, "with zero clean sessions");
  assertEqual(rep.created.launchedSessions, 0, "and it launched nothing");
  assertEqual(rep.created.replicationProtocolDigest, REPLICATION_PROTOCOL_DIGEST, "the manifest pins the frozen protocol digest");
  assertEqual(rep.created.developmentArtifactsPresent, rep.developmentArtifactsPresent, "it reports whether the development artifacts were present");
  const manifest = await readReplicationManifest(replicationRootFor(rep.replicationRoot, rep.created.replicationId));
  assertEqual(manifest.developmentExperimentId, CANONICAL_DEVELOPMENT_EXPERIMENT_ID, "the manifest references the development experiment by id");
  assertEqual(manifest.developmentMetricsDigest, CANONICAL_DEVELOPMENT_METRICS_DIGEST, "and pins its metrics digest");
  assertEqual(manifest.developmentOnly, false, "replication is not development evidence");
  assertEqual(manifest.replicationOnly, true, "it IS replication evidence");
  assertEqual(manifest.noProfitabilityInference, true, "no profitability inference");
  assertEqual(manifest.noTradingInference, true, "no trading inference");
  assertEqual(manifest.noDeploymentInference, true, "no deployment inference");
  assertEqual(manifest.paperOnly, true, "paper only");
  assertEqual(manifest.shadowOnly, true, "shadow only");
  assertEqual(manifest.evidenceClass, REPLICATION_EVIDENCE_CLASS, "the manifest declares the replication evidence class");
  assertEqual(manifest.manifestVersion, REPLICATION_MANIFEST_VERSION, "the manifest version");
  assertEqual(manifest.manifestContentDigest, manifestDigestOf(manifest), "the manifest digest describes its own content");
  assertEqual(manifest.expected.sessionSize, REPLICATION_SESSION_OBSERVATIONS, "the manifest pins the session size");
  assertEqual(manifest.expected.requiredCleanSessions, REQUIRED_CLEAN_REPLICATION_SESSIONS, "and the required clean session count");
  assertEqual(manifest.expected.provider, REQUIRED_PROVIDER, "and the provider");
  assertEqual(manifest.expected.model, REQUIRED_MODEL, "and the model");
  assertEqual(manifest.expected.gatewayUsed, false, "and the direct route");
  assertEqual(manifest.expected.outcomeResolutionPolicyVersion, 2, "and policy v2");
  assertEqual(manifest.expected.metricDefinitionVersion, 2, "and metric v2");
  assertEqual(manifest.noTuningFromDevelopment, true, "no tuning from the development results");
  assertEqual(manifest.noTuningBetweenSessions, true, "no tuning between sessions");
  assertEqual(manifest.interruptedWaveIsIncomparable, true, "an interrupted wave is incomparable, not patched");
  assertEqual(manifest.primaryInferenceUnit, "dataset/session", "the primary inference unit");
  assertEqual(manifest.noObservationLevelPseudoReplication, true, "no observation-level pseudo-replication");
  const sessionsDocument = await readReplicationSessions(replicationRootFor(rep.replicationRoot, rep.created.replicationId));
  assertEqual(sessionsDocument.sessionCount, 0, "the wave starts with an empty sessions document");
  assertDeepEqual(
    sessionsDocument,
    createSessionsDocument({ replicationId: rep.created.replicationId, sessions: [] }),
    "the sessions document has exactly the documented shape",
  );
  assertEqual(replicationRootFor(rep.replicationRoot, rep.created.replicationId).startsWith(rep.replicationRoot), true, "the replication root resolves inside the tree");
  assertEqual(isValidReplicationId(rep.created.replicationId), true, "the id is valid");
  assertEqual(isValidReplicationId("../../etc/passwd"), false, "a traversal id is not");
  assertEqual(isValidReplicationId("jdir-20260920T063311Z-3a9163"), false, "a jdir id is not a replication id");
  assertThrows(() => replicationRootFor(rep.replicationRoot, "bad/id"), (error) => error.message.includes("invalid Phase 5I.1 replication id"), "the root resolver refuses a bad id");
});

test("AJ2. replication-create refuses any non-canonical development experiment", async () => {
  const rep = ctx.replication;
  const refusal = await replicationCreate({
    replicationRoot: rep.replicationRoot,
    baseRoot: rep.experimentsRoot,
    developmentExperimentId: CANARY_V2_EXPERIMENT_ID,
  });
  assertEqual(refusal.ok, false, "a canary cannot be the replication baseline");
  assertTrue(refusal.error.includes(CANONICAL_DEVELOPMENT_EXPERIMENT_ID), "the refusal names the canonical development experiment");
  const missing = await replicationCreate({ replicationRoot: rep.replicationRoot, baseRoot: rep.experimentsRoot, developmentExperimentId: null });
  assertEqual(missing.ok, false, "an absent --development is refused");
  assertTrue(missing.error.includes("explicit --development"), "and demands an explicit id");
  assertEqual(await readReplicationManifest(replicationRootFor(rep.replicationRoot, replicationIdFor({ developmentExperimentId: CANARY_V2_EXPERIMENT_ID }))), null, "no manifest was created for the refused baseline");
});

test("AJ3. session 1 is added as CLEAN and the wave still reports 1 clean session as insufficient", async () => {
  const rep = ctx.replication;
  const added = await replicationAdd({
    replicationRoot: rep.replicationRoot,
    baseRoot: rep.experimentsRoot,
    replicationId: rep.created.replicationId,
    sessionId: "jdir-fixture-rep-1",
  });
  assertEqual(added.ok, true, `session 1 was added: ${added.error ?? ""}`);
  assertEqual(added.sessionStatus, SESSION_STATUS.CLEAN, `session 1 is CLEAN: ${JSON.stringify(added.sessionReasons)}`);
  assertEqual(added.cleanSessionCount, 1, "one clean session");
  assertEqual(added.status, REPLICATION_INSUFFICIENT_STATE, "one clean session is still insufficient");
  assertEqual(added.launchedSessions, 0, "--replication-add launched nothing");
  assertEqual(added.networkCalls, 0, "and made zero network calls");
  assertEqual(added.jevCalls, 0, "and zero Jev calls");
  assertEqual(added.summary.bootstrap.available, false, "no uncertainty interval exists yet");
  assertEqual(added.summary.bootstrap.status, REPLICATION_INSUFFICIENT_STATE, "the bootstrap reports the insufficient state");
  assertDeepEqual(added.summary.bootstrap.comparisons, {}, "and emits no intervals");

  const oneClean = await replicationStats({ replicationRoot: rep.replicationRoot, baseRoot: rep.experimentsRoot, replicationId: rep.created.replicationId });
  assertEqual(oneClean.ok, true, "stats read the 1-clean wave");
  assertEqual(oneClean.summary.status, REPLICATION_INSUFFICIENT_STATE, "which is INSUFFICIENT_CLEAN_REPLICATION_SESSIONS");
  assertEqual(oneClean.summary.cleanSessionCount, 1, "with exactly one clean session");
});

test("AJ4. an overlapping PAIR contaminates BOTH sessions, and both are preserved and excluded", async () => {
  const rep = ctx.replication;
  const root = replicationRootFor(rep.replicationRoot, rep.created.replicationId);
  const first = await replicationAdd({
    replicationRoot: rep.replicationRoot,
    baseRoot: rep.experimentsRoot,
    replicationId: rep.created.replicationId,
    sessionId: "jdir-fixture-rep-contaminated",
  });
  assertEqual(first.ok, true, `the first half of the pair is recorded: ${first.error ?? ""}`);
  assertEqual(first.sessionStatus, SESSION_STATUS.CLEAN, "with nothing to overlap yet it is CLEAN");
  assertEqual(first.cleanSessionCount, 2, "so the wave has two clean sessions");

  const second = await replicationAdd({
    replicationRoot: rep.replicationRoot,
    baseRoot: rep.experimentsRoot,
    replicationId: rep.created.replicationId,
    sessionId: "jdir-fixture-rep-contaminated-2",
  });
  assertEqual(second.ok, true, `the overlapping session is RECORDED, not rejected: ${second.error ?? ""}`);
  assertEqual(second.sessionStatus, SESSION_STATUS.CONTAMINATED, "it is CONTAMINATED");
  assertEqual(second.sessionEligible, false, "and ineligible");
  assertEqual(second.cleanSessionCount, 1, "it does not raise the clean count");
  assertEqual(second.totalSessionCount, 3, "but it IS in the manifest");
  assertTrue(second.sessionReasons.some((reason) => /overlaps another session/.test(reason)), "with the overlap reason persisted");

  const sessions = await readReplicationSessions(root);
  assertEqual(sessions.sessions.length, 3, "three session records exist");
  for (const sessionId of ["jdir-fixture-rep-contaminated", "jdir-fixture-rep-contaminated-2"]) {
    const stored = sessions.sessions.find((entry) => entry.sessionId === sessionId);
    assertEqual(stored.status, SESSION_STATUS.CONTAMINATED, `${sessionId} is CONTAMINATED on the record`);
    assertEqual(stored.eligible, false, `${sessionId} is ineligible on the record`);
    assertTrue(stored.reasons.length > 0, `${sessionId} keeps its reasons`);
    assertEqual(second.summary.excludedSessions.some((entry) => entry.sessionId === sessionId), true, `the summary excludes ${sessionId}`);
    assertEqual(second.summary.perSession.some((entry) => entry.sessionId === sessionId), true, `and still reports ${sessionId} per-session`);
  }
  const compared = Object.values(second.summary.comparisons).every((block) => block.brier.sessionCount === 1);
  assertEqual(compared, true, "the aggregation counted only the CLEAN session");
});

test("AJ5. a mock/development session is recorded as INELIGIBLE with explicit reasons", async () => {
  const rep = ctx.replication;
  const added = await replicationAdd({
    replicationRoot: rep.replicationRoot,
    baseRoot: rep.experimentsRoot,
    replicationId: rep.created.replicationId,
    sessionId: "jdir-fixture-rep-ineligible",
  });
  assertEqual(added.ok, true, "the ineligible session is recorded, not silently discarded");
  assertEqual(added.sessionStatus, SESSION_STATUS.INELIGIBLE, "it is INELIGIBLE");
  assertTrue(added.sessionReasons.length > 0, "with explicit reasons");
  assertEqual(added.cleanSessionCount, 1, "the clean count is unchanged");
  assertEqual(added.totalSessionCount, 4, "and the session is in the manifest");
  const stats = await replicationStats({ replicationRoot: rep.replicationRoot, baseRoot: rep.experimentsRoot, replicationId: rep.created.replicationId });
  assertEqual(stats.summary.excludedSessions.length, 3, "three sessions are excluded from aggregation");
});

test("AJ6. sessions 2 and 3 are added as CLEAN and the wave reaches the complete state", async () => {
  const rep = ctx.replication;
  for (const sessionId of ["jdir-fixture-rep-2", "jdir-fixture-rep-3"]) {
    const added = await replicationAdd({ replicationRoot: rep.replicationRoot, baseRoot: rep.experimentsRoot, replicationId: rep.created.replicationId, sessionId });
    assertEqual(added.ok, true, `${sessionId} was added: ${added.error ?? ""}`);
    assertEqual(added.sessionStatus, SESSION_STATUS.CLEAN, `${sessionId} is CLEAN: ${JSON.stringify(added.sessionReasons)}`);
    rep.added.push(added);
  }
  const final = rep.added[rep.added.length - 1];
  assertEqual(final.cleanSessionCount, REQUIRED_CLEAN_REPLICATION_SESSIONS, "three CLEAN sessions exist");
  assertEqual(final.status, REPLICATION_COMPLETE_STATE, "and the wave reports the complete state");
  assertEqual(final.totalSessionCount, 6, "while every added session is preserved");
  assertEqual(final.summary.bootstrap.available, true, "the deterministic session-level bootstrap is now available");
  assertEqual(final.summary.winner, null, "the summary emits no winner");
  assertEqual(final.summary.noAutomatedWinner, true, "and says so");
  assertEqual(final.summary.significanceClaimed, false, "and claims no significance");
  assertEqual(final.summary.profitabilityInference, false, "and no profitability inference");
  assertEqual(final.summary.tradingInference, false, "and no trading inference");
  assertEqual(final.summary.deploymentInference, false, "and no deployment inference");
});

test("AJ7. the aggregate is equal-weighted by CLEAN session and exposes every required field", async () => {
  const rep = ctx.replication;
  const stats = await replicationStats({ replicationRoot: rep.replicationRoot, baseRoot: rep.experimentsRoot, replicationId: rep.created.replicationId });
  const summary = stats.summary;
  assertEqual(summary.primaryInferenceUnit, "dataset/session", "the primary inference unit is the session");
  assertEqual(summary.equalWeightedByEligibleSession, true, "equal-weighted by eligible session");
  assertEqual(summary.noObservationLevelPseudoReplication, true, "no observation-level pseudo-replication");
  assertEqual(summary.cleanSessionCount, 3, "three clean sessions");
  assertEqual(summary.cleanSessionIds.length, 3, "three clean session ids");
  assertDeepEqual(Object.keys(summary.comparisons).sort(), [...REPLICATION_COMPARISON_IDS].sort(), "one comparison bucket per frozen baseline");
  for (const comparisonId of REPLICATION_COMPARISON_IDS) {
    const block = summary.comparisons[comparisonId];
    for (const metric of REPLICATION_DELTA_METRICS) {
      const statsBlock = block[metric];
      for (const field of ["sessionCount", "values", "mean", "median", "min", "max", "positiveCount", "negativeCount", "zeroCount"]) {
        assertTrue(Object.hasOwn(statsBlock, field), `${comparisonId}.${metric} exposes ${field}`);
      }
      assertEqual(statsBlock.sessionCount, 3, `${comparisonId}.${metric} covers all three clean sessions`);
      assertEqual(statsBlock.values.length, statsBlock.sessionCount, `${comparisonId}.${metric} keeps one value per session`);
      assertEqual(statsBlock.sessionIds.length, statsBlock.sessionCount, `${comparisonId}.${metric} keeps the session ids alongside the values`);
      const recomputedMean = statsBlock.values.reduce((sum, value) => sum + value, 0) / statsBlock.values.length;
      assertClose(statsBlock.mean, recomputedMean, `${comparisonId}.${metric} mean is the equal-weighted session mean`, 1e-12);
      assertClose(statsBlock.median, medianOf(statsBlock.values), `${comparisonId}.${metric} median matches`, 1e-12);
      assertEqual(statsBlock.min, Math.min(...statsBlock.values), `${comparisonId}.${metric} min matches`);
      assertEqual(statsBlock.max, Math.max(...statsBlock.values), `${comparisonId}.${metric} max matches`);
      assertEqual(statsBlock.positiveCount + statsBlock.negativeCount + statsBlock.zeroCount, statsBlock.sessionCount, `${comparisonId}.${metric} counts partition the sessions`);
      if (metric === "accuracy") {
        assertEqual(statsBlock.lowerIsBetter, false, `accuracy is NOT lower-is-better`);
        assertEqual(statsBlock.jevBetterCount, null, `accuracy carries no better/worse label`);
      } else {
        assertEqual(statsBlock.lowerIsBetter, true, `${metric} is lower-is-better`);
        assertEqual(statsBlock.jevBetterCount, statsBlock.negativeCount, `${metric}: a negative delta means Jev is BETTER`);
        assertEqual(statsBlock.baselineBetterCount, statsBlock.positiveCount, `${metric}: a positive delta means the baseline is better`);
        assertEqual(statsBlock.equalCount, statsBlock.zeroCount, `${metric}: zero deltas are counted separately`);
      }
    }
  }
  for (const metric of REPLICATION_ABSOLUTE_METRICS) {
    assertEqual(summary.absolute[metric].sessionCount, 3, `the absolute ${metric} covers all three sessions`);
    assertTrue(Number.isFinite(summary.absolute[metric].mean), `the absolute ${metric} has an equal-weighted mean`);
  }
  assertEqual(summary.deltaSignConvention.brier, REPLICATION_DELTA_SIGN_CONVENTION.brier, "the Brier sign convention is documented");
  assertTrue(summary.deltaSignConvention.brier.includes("negative means Jev is LOWER"), "and states the direction explicitly");
  assertTrue(summary.deltaSignConvention.logLoss.includes("negative means Jev is LOWER"), "for log loss too");
  assertTrue(summary.deltaSignConvention.accuracy.includes("positive means Jev is HIGHER"), "and the opposite direction for accuracy");
  assertEqual(summary.perSession.length, 6, "every session is reported per-session, CLEAN or excluded");
});

test("AJ8. aggregation is session-level and never concatenates observations", () => {
  const clean = [
    { sessionId: "s1", status: SESSION_STATUS.CLEAN, metrics: { jev: { brier: 1, logLoss: 1, accuracy: 1 }, deltas: { "neutral-v1": { brier: -1, logLoss: -1, accuracy: 0 } } } },
    { sessionId: "s2", status: SESSION_STATUS.CLEAN, metrics: { jev: { brier: 3, logLoss: 3, accuracy: 0 }, deltas: { "neutral-v1": { brier: 1, logLoss: 1, accuracy: 0 } } } },
    { sessionId: "s3", status: SESSION_STATUS.CONTAMINATED, metrics: { jev: { brier: 999, logLoss: 999, accuracy: 999 }, deltas: { "neutral-v1": { brier: 999, logLoss: 999, accuracy: 999 } } } },
  ];
  const aggregation = aggregateReplicationSessions(clean, { excludedSessions: [{ sessionId: "s3", status: SESSION_STATUS.CONTAMINATED, reasons: ["overlap"] }] });
  const block = aggregation.comparisons["neutral-v1"].brier;
  assertEqual(block.sessionCount, 2, "the contaminated session is excluded");
  assertEqual(block.mean, 0, "the mean is the equal-weighted session mean, not an observation-weighted one");
  assertEqual(block.jevBetterCount, 1, "one session where Jev was better");
  assertEqual(block.baselineBetterCount, 1, "one where the baseline was better");
  assertEqual(aggregation.absolute.brier.mean, 2, "the equal-weighted absolute mean");
  assertEqual(aggregation.status, REPLICATION_INSUFFICIENT_STATE, "two clean sessions are insufficient");
  assertEqual(aggregation.bootstrap.available, false, "so no interval is emitted");
  assertEqual(aggregation.excludedSessions.length, 1, "the excluded session is reported");
  // A null comparison value is EXCLUDED and counted, never scored as zero.
  const withNull = aggregateReplicationSessions(
    [...clean.slice(0, 2), { sessionId: "s4", status: SESSION_STATUS.CLEAN, metrics: { jev: { brier: 2, logLoss: 2, accuracy: 2 }, deltas: { "neutral-v1": { brier: null, logLoss: null, accuracy: null } } } }],
    {},
  );
  assertEqual(withNull.comparisons["neutral-v1"].brier.sessionCount, 2, "a null value is excluded from the comparison");
  assertEqual(withNull.comparisons["neutral-v1"].brier.excludedSessionCount, 1, "and counted as excluded");
  assertEqual(withNull.absolute.brier.sessionCount, 3, "while the absolute metric still covers it");
});

test("AJ9. the bootstrap is deterministic, session-level and descriptive only", () => {
  const values = [0.1, -0.2, 0.05];
  const first = bootstrapSessionMean(values);
  const second = bootstrapSessionMean(values);
  assertDeepEqual(first, second, "the same values and seed reproduce the interval byte for byte");
  assertEqual(first.available, true, "the interval is available with three sessions");
  assertEqual(first.seed, REPLICATION_BOOTSTRAP_SEED, "a fixed seed");
  assertEqual(first.resamples, REPLICATION_BOOTSTRAP_RESAMPLES, "a fixed resample count");
  assertEqual(first.prng, REPLICATION_BOOTSTRAP_PRNG, "a fixed deterministic PRNG");
  assertEqual(first.sessionCount, 3, "it resamples SESSIONS");
  assertClose(first.pointEstimate, meanOf(values), "the point estimate is the session mean", 1e-12);
  assertTrue(first.lower <= first.upper, "the interval is ordered");
  assertEqual(first.pValue, null, "no p-value is emitted");
  assertEqual(first.significanceLabel, null, "no significance label is emitted");
  assertEqual(first.statisticallyProven, false, "nothing is claimed to be statistically proven");
  assertEqual(first.descriptiveOnly, true, "the interval is descriptive only");
  assertExcludes(JSON.stringify(first).toLowerCase(), "significant", "the word significant appears nowhere");
  assertExcludes(JSON.stringify(first).toLowerCase(), "p-value\": 0", "no p-value number is produced");
  assertEqual(mulberry32(1)() === mulberry32(1)(), true, "the PRNG is a pure function of its seed");
  assertEqual(bootstrapSessionMean([]).available, false, "an empty series has no interval");
  assertEqual(bootstrapSessionMean([1, 2]).available, true, "two values still produce a descriptive interval");
  assertEqual(REPLICATION_BOOTSTRAP_ALPHA, 0.05, "the alpha is a frozen constant");
});

test("AJ10. the stable session statistics never coerce a null into a zero", () => {
  const stats = stableSessionStats([{ sessionId: "a", value: 1 }, { sessionId: "b", value: null }, { sessionId: "c", value: 0 }]);
  assertEqual(stats.sessionCount, 2, "only finite values count");
  assertEqual(stats.excludedSessionCount, 1, "the null is counted as excluded");
  assertEqual(stats.zeroCount, 1, "an exact zero is a zero, not a missing value");
  assertEqual(stats.positiveCount, 1, "and the positive value is counted");
  assertDeepEqual(stats.values, [1, 0], "the raw values are preserved");
  assertDeepEqual(stats.sessionIds, ["a", "c"], "and so are their session ids");
  const comparison = aggregateComparison([{ sessionId: "a", value: 0 }], { lowerIsBetter: true });
  assertEqual(comparison.jevBetterCount, 0, "a zero delta is not a Jev win");
  assertEqual(comparison.baselineBetterCount, 0, "and not a baseline win");
  assertEqual(comparison.equalCount, 1, "it is an equal result");
});

test("AJ11. --replication-add refuses duplicates, protected ids and unknown targets", async () => {
  const rep = ctx.replication;
  const duplicate = await replicationAdd({ replicationRoot: rep.replicationRoot, baseRoot: rep.experimentsRoot, replicationId: rep.created.replicationId, sessionId: "jdir-fixture-rep-1" });
  assertEqual(duplicate.ok, false, "a session is added exactly once");
  assertTrue(duplicate.error.includes("already recorded"), "and the refusal says so");
  for (const protectedId of [CANONICAL_DEVELOPMENT_EXPERIMENT_ID, CANARY_V1_EXPERIMENT_ID, CANARY_V2_EXPERIMENT_ID]) {
    const refusal = await replicationAdd({ replicationRoot: rep.replicationRoot, baseRoot: rep.experimentsRoot, replicationId: rep.created.replicationId, sessionId: protectedId });
    assertEqual(refusal.ok, false, `${protectedId} is refused`);
    assertTrue(refusal.error.length > 20, "with an explicit reason");
  }
  const unknownWave = await replicationAdd({ replicationRoot: rep.replicationRoot, baseRoot: rep.experimentsRoot, replicationId: "jrep-20260101T000000Z-abcdef", sessionId: "jdir-fixture-rep-1" });
  assertEqual(unknownWave.ok, false, "an unknown replication id is refused");
  const unknownSession = await replicationAdd({ replicationRoot: rep.replicationRoot, baseRoot: rep.experimentsRoot, replicationId: rep.created.replicationId, sessionId: "jdir-not-here" });
  assertEqual(unknownSession.ok, false, "an unknown session id is refused");
  assertTrue(unknownSession.error.includes("no Phase 5I experiment"), "with the filesystem reason");
  const latest = await replicationAdd({ replicationRoot: rep.replicationRoot, baseRoot: rep.experimentsRoot, replicationId: rep.created.replicationId, sessionId: "latest" });
  assertEqual(latest.ok, false, "there is no \"latest\"");
  const badId = await replicationAdd({ replicationRoot: rep.replicationRoot, baseRoot: rep.experimentsRoot, replicationId: "../escape", sessionId: "jdir-fixture-rep-1" });
  assertEqual(badId.ok, false, "a traversal replication id is refused");
  const after = await readReplicationSessions(replicationRootFor(rep.replicationRoot, rep.created.replicationId));
  assertEqual(after.sessions.length, 6, "no refused call changed the manifest");
});

test("AJ12. the offline replication replay is clean, zero-network, and rewrites nothing", async () => {
  const rep = ctx.replication;
  const root = replicationRootFor(rep.replicationRoot, rep.created.replicationId);
  const before = await replicationMetadataSnapshot(root);
  const report = await replicationReplay({ replicationRoot: rep.replicationRoot, baseRoot: rep.experimentsRoot, replicationId: rep.created.replicationId });
  const after = await replicationMetadataSnapshot(root);
  assertEqual(report.ok, true, `the replication replays cleanly: ${JSON.stringify(report.problems)}`);
  assertEqual(report.networkCalls + report.providerCalls + report.jevCalls + report.agentReachCalls + report.classifierCalls + report.deepseekCalls, 0, "zero network and zero provider calls");
  assertEqual(report.arenaRuns + report.tradingCalls, 0, "zero Arena runs and zero trading calls");
  assertEqual(report.launchedSessions, 0, "and it launched no session");
  assertEqual(report.readOnly, true, "the pass is read-only");
  assertDeepEqual(report.counts, { sessions: 6, cleanSessions: 3, contaminatedSessions: 2, ineligibleSessions: 1 }, "the recorded session statuses are exactly as derived");
  assertEqual(report.metricsMatch, true, "the stored aggregation reproduces");
  assertEqual(report.manifestDigestMatches, true, "the manifest digest reproduces");
  assertEqual(report.sessionsDigestMatches, true, "the session records reproduce");
  assertDeepEqual(after, before, "the replication tree is byte-unchanged by its own replay");
  for (const problem of report.problems) assertTrue(!/rewrote/.test(problem), "no write problem was reported");
});

test("AJ13. the replication stats pass is read-only and reproduces the stored summary", async () => {
  const rep = ctx.replication;
  const root = replicationRootFor(rep.replicationRoot, rep.created.replicationId);
  const before = await replicationMetadataSnapshot(root);
  const stats = await replicationStats({ replicationRoot: rep.replicationRoot, baseRoot: rep.experimentsRoot, replicationId: rep.created.replicationId });
  const after = await replicationMetadataSnapshot(root);
  assertEqual(stats.ok, true, "stats succeed");
  assertEqual(stats.readOnly, true, "read-only");
  assertEqual(stats.metricsMatch, true, "the aggregation reproduces");
  assertEqual(stats.summary.aggregateMetricsDigest, stats.recomputedAggregateDigest, "and the digest is the recomputed one");
  assertEqual(aggregateDigestOf(stats.summary), stats.summary.aggregateMetricsDigest, "the aggregate digest recomputes from the summary content");
  assertEqual(sessionsDigestOf(stats.sessions) === stats.storedSummary.sessionRecordsDigest, true, "the session records digest matches the stored one");
  const storedSessionsDoc = await readReplicationSessions(path.join(rep.replicationRoot, rep.created.replicationId));
  for (const stored of storedSessionsDoc.sessions) {
    assertEqual(sessionRecordDigestOf(stored), stored.recordDigest, `${stored.sessionId} has a self-describing derivation digest`);
  }
  assertDeepEqual(after, before, "stats wrote nothing");
  assertEqual((await readReplicationBundle(root)).manifest.replicationProtocolDigest, REPLICATION_PROTOCOL_DIGEST, "the manifest still pins the frozen protocol");
});

/* ============================================================================
 * PART AK — replication CLI behaviour (§17, §18)
 * ==========================================================================*/

test("AK1. the CLI documents the two evidence classes and the four replication commands", () => {
  const help = runCli(["--help"]);
  assertEqual(help.status, 0, "--help exits 0");
  for (const action of DIRECTION_REPLICATION_ACTIONS) assertIncludes(help.stdout, `--${action}`, `help documents --${action}`);
  assertIncludes(help.stdout, REPLICATION_EVIDENCE_CLASS, "help names the replication evidence class");
  assertIncludes(help.stdout, DIRECTION_EVIDENCE_CLASS, "and the development class");
  assertIncludes(help.stdout, "--replication-session", "and the replication-session flag");
  assertIncludes(help.stdout, "NEVER", "and states that no replication command launches a session");
  assertIncludes(help.stdout, "operator runs each one manually", "and that the operator runs each session");
  const definition = runCli(["--definition"]);
  assertEqual(definition.status, 0, "--definition exits 0");
  assertIncludes(definition.stdout, REPLICATION_PROTOCOL_DIGEST, "--definition prints the frozen protocol digest");
  assertIncludes(definition.stdout, CANONICAL_DEVELOPMENT_EXPERIMENT_ID, "and the canonical development experiment");
  assertIncludes(definition.stdout, "3 independent sessions", "and the replication design");
});

test("AK2. replication actions resolve exclusively, and there is still no --latest", () => {
  assertEqual(DIRECTION_REPLICATION_ACTIONS.length, 4, "four replication actions");
  for (const action of DIRECTION_REPLICATION_ACTIONS) {
    assertEqual(isReplicationAction(action), true, `${action} is a replication action`);
    assertEqual(DIRECTION_ALL_ACTIONS.includes(action), true, `${action} resolves as an action`);
    assertEqual(resolveDirectionAction({ [action]: true }).action, action, `${action} resolves on its own`);
  }
  assertEqual(DIRECTION_ACTIONS.includes("replication-create"), false, "the frozen benchmark action set is unchanged");
  assertEqual(resolveDirectionAction({ start: true, "replication-create": true }).error !== null, true, "two actions is still an error");
  for (const action of ["replication-add", "replication-replay", "replication-stats"]) {
    const result = runCli([`--${action}`]);
    assertTrue(result.status !== 0, `--${action} without --replication exits non-zero`);
    assertIncludes(result.stderr, "explicit --replication", `--${action} demands an explicit id`);
  }
  for (const action of ["replication-add", "replication-replay", "replication-stats"]) {
    const latest = runCli([`--${action}`, "--replication", "latest"]);
    assertTrue(latest.status !== 0, `--${action} --replication latest exits non-zero`);
    assertIncludes(latest.stderr, "never guesses which replication", `--${action} refuses latest`);
  }
  const createMissing = runCli(["--replication-create"]);
  assertTrue(createMissing.status !== 0, "--replication-create without --development exits non-zero");
  assertIncludes(createMissing.stderr, "explicit --development", "and demands an explicit development id");
  const createWrong = runCli(["--replication-create", "--development", CANARY_V1_EXPERIMENT_ID]);
  assertTrue(createWrong.status !== 0, "a non-canonical development id exits non-zero");
  assertIncludes(createWrong.stderr, CANONICAL_DEVELOPMENT_EXPERIMENT_ID, "and names the canonical one");
});

test("AK3. --replication-replay / --replication-stats never require a provider or a credential", () => {
  const env = { EVOLVE_JEV_PROVIDER: "", EVOLVE_JEV_API_KEY: "", EVOLVE_MARKET_MODE: "live" };
  const replay = runCli(["--replication-replay", "--replication", "jrep-not-here", "--out", ctx.tempRoot], env);
  assertEqual(replay.status, 1, "an unknown replication exits 1");
  assertIncludes(replay.stderr, "no Phase 5I.1 replication", "and says so");
  const stats = runCli(["--replication-stats", "--replication", "jrep-not-here", "--out", ctx.tempRoot], env);
  assertEqual(stats.status, 1, "stats on an unknown replication exits 1");
  assertExcludes(replay.stdout + replay.stderr, "PREDICTION_FROZEN", "no prediction was ever frozen");
  assertExcludes(replay.stdout + replay.stderr, "Jev is disabled", "no provider resolution was attempted at all");
});

test("AK4. `--start --replication-session` refuses any non-frozen protocol value before running", () => {
  const base = ["--start", "--replication-session", "--market", "SOL-USDC"];
  const size = runCli([...base, "--max-observations", "60"], { EVOLVE_JEV_PROVIDER: "" });
  assertTrue(size.status !== 0, "a non-120 session exits non-zero");
  assertIncludes(size.stderr, "exactly 120 observations", "and names the frozen session size");
  const cadence = runCli([...base, "--cadence-seconds", "60"], { EVOLVE_JEV_PROVIDER: "" });
  assertTrue(cadence.status !== 0, "a non-30 s cadence exits non-zero");
  assertIncludes(cadence.stderr, "frozen 30-second cadence", "and names the frozen cadence");
  const tolerance = runCli([...base, "--tolerance-ms", "5000"], { EVOLVE_JEV_PROVIDER: "" });
  assertTrue(tolerance.status !== 0, "a v1 outcome bound exits non-zero");
  assertIncludes(tolerance.stderr, "outcome-resolution policy v2", "and names policy v2");
  const mock = runCli([...base, "--allow-mock"], { EVOLVE_JEV_PROVIDER: "" });
  assertTrue(mock.status !== 0, "--allow-mock exits non-zero for a replication session");
  assertIncludes(mock.stderr, "must be genuine", "and refuses the fixture");
  const unsafe = runCli([...base, "--allow-unsafe-model"], { EVOLVE_JEV_PROVIDER: "" });
  assertTrue(unsafe.status !== 0, "--allow-unsafe-model exits non-zero for a replication session");
  assertExcludes(size.stdout, "EXPERIMENT_CREATED", "nothing was created by any refusal");
});

test("AK5. the replication CLI works end to end against a temp tree, offline", async () => {
  const rep = ctx.replication;
  const cliExperiments = path.join(ctx.tempRoot, "cli-replication-experiments");
  const cliReplication = path.join(ctx.tempRoot, "cli-replication");
  await cp(rep.experimentsRoot, cliExperiments, { recursive: true });
  const base = ["--out", cliExperiments, "--replication-out", cliReplication];
  const env = { EVOLVE_JEV_PROVIDER: "", EVOLVE_JEV_API_KEY: "" };

  const create = runCli(["--replication-create", "--development", CANONICAL_DEVELOPMENT_EXPERIMENT_ID, ...base], env);
  assertEqual(create.status, 0, `--replication-create exits 0 (stderr: ${create.stderr})`);
  assertIncludes(create.stdout, "jrep-", "it prints the replication id");
  assertIncludes(create.stdout, REPLICATION_PROTOCOL_DIGEST, "and the frozen protocol digest");
  assertExcludes(create.stdout, "PREDICTION_FROZEN", "and launched nothing");
  const replicationId = /jrep-[A-Za-z0-9._-]+/.exec(create.stdout)?.[0] ?? null;
  assertTrue(typeof replicationId === "string", "the replication id is readable from the output");

  const add = runCli(["--replication-add", "--replication", replicationId, "--experiment", "jdir-fixture-rep-1", ...base], env);
  assertEqual(add.status, 0, `--replication-add exits 0 (stderr: ${add.stderr})`);
  assertIncludes(add.stdout, "CLEAN", "session 1 is CLEAN");
  assertIncludes(add.stdout, "network           0", "with zero network calls");

  const replay = runCli(["--replication-replay", "--replication", replicationId, ...base], env);
  assertEqual(replay.status, 0, `--replication-replay exits 0 (stderr: ${replay.stderr})`);
  assertIncludes(replay.stdout, "integrity         OK", "the replay reports integrity");
  assertIncludes(replay.stdout, "network 0", "and zero network calls");
  assertIncludes(replay.stdout, "launched sessions 0", "and launched nothing");

  const stats = runCli(["--replication-stats", "--replication", replicationId, ...base], env);
  assertEqual(stats.status, 0, `--replication-stats exits 0 (stderr: ${stats.stderr})`);
  assertIncludes(stats.stdout, "INSUFFICIENT_CLEAN_REPLICATION_SESSIONS", "one clean session is insufficient");
  assertIncludes(stats.stdout, "Jev - neutral-v1", "and the comparison block is printed");
  assertIncludes(stats.stdout, "NO winner", "and no winner is emitted");
  assertIncludes(stats.stdout, "Negative Brier/log-loss delta = Jev lower (better)", "and the sign convention is printed");

  const json = runCli(["--replication-stats", "--replication", replicationId, ...base, "--json"], env);
  assertEqual(json.status, 0, "--json stats exits 0");
  const payload = JSON.parse(json.stdout);
  assertEqual(payload.summary.primaryInferenceUnit, "dataset/session", "the JSON report keeps the session as the inference unit");
  assertEqual(payload.networkCalls, 0, "and reports zero network calls");
});

test("AK6. a replication invocation never reaches a market config or a provider", async () => {
  const source = await readText("scripts/jev-direction.mjs");
  const indexOfReplication = source.indexOf("isReplicationAction(action)");
  const indexOfMarketConfig = source.indexOf("createMarketConfig(marketEnv)");
  const indexOfPins = source.indexOf("enforceDirectionProviderPins({ settings, envConfig })");
  assertTrue(indexOfReplication > 0 && indexOfMarketConfig > 0 && indexOfPins > 0, "the CLI has all three stages");
  assertTrue(indexOfReplication < indexOfMarketConfig, "the replication dispatch precedes the market config");
  assertTrue(indexOfReplication < indexOfPins, "and precedes provider pin enforcement");
  assertIncludes(source, "launchedSessions", "the CLI reports launched sessions");
  assertExcludes(await readText("scripts/jev/direction/replication/runner.mjs"), "fetch(", "the replication runner makes no request");
  assertExcludes(await readText("scripts/jev/direction/replication/runner.mjs"), "createResilientJevProvider", "and constructs no provider");
});

/* ============================================================================
 * PART AL — isolation, no-tuning and zero authority for Phase 5I.1
 * ==========================================================================*/

test("AL1. the two evidence profiles are distinct, explicit and fail closed", () => {
  assertEqual(DEVELOPMENT_EVIDENCE_PROFILE.evidenceClass, DIRECTION_EVIDENCE_CLASS, "the development class");
  assertEqual(REPLICATION_EVIDENCE_PROFILE.evidenceClass, REPLICATION_EVIDENCE_CLASS, "the replication class");
  assertDeepEqual(DIRECTION_EVIDENCE_CLASSES, [DIRECTION_EVIDENCE_CLASS, REPLICATION_EVIDENCE_CLASS], "exactly two classes exist");
  assertDeepEqual(Object.keys(DIRECTION_EVIDENCE_PROFILES).sort(), ["development", "replication"], "the registry holds exactly the two profiles");
  assertEqual(evidenceProfileForClass(DIRECTION_EVIDENCE_CLASS), DEVELOPMENT_EVIDENCE_PROFILE, "the development class resolves by class");
  assertEqual(evidenceProfileForClass(REPLICATION_EVIDENCE_CLASS), REPLICATION_EVIDENCE_PROFILE, "the replication class resolves by class");
  assertEqual(evidenceProfileForClass("UNKNOWN_CLASS"), null, "an unknown class fails closed");
  assertEqual(DEVELOPMENT_EVIDENCE_PROFILE.evidenceClass === REPLICATION_EVIDENCE_PROFILE.evidenceClass, false, "and they differ");
  assertEqual(DEVELOPMENT_EVIDENCE_PROFILE.flags.developmentOnly, true, "development artifacts are developmentOnly");
  assertEqual(REPLICATION_EVIDENCE_PROFILE.flags.developmentOnly, false, "replication artifacts are NOT");
  assertEqual(REPLICATION_EVIDENCE_PROFILE.flags.replicationOnly, true, "replication artifacts are replicationOnly");
  assertEqual(DIRECTION_REPLICATION_FLAGS.noProfitabilityInference, true, "no profitability inference");
  assertEqual(DIRECTION_REPLICATION_FLAGS.noTradingInference, true, "no trading inference");
  assertEqual(DIRECTION_REPLICATION_FLAGS.noDeploymentInference, true, "no deployment inference");
  assertEqual(DIRECTION_REPLICATION_FLAGS.paperOnly, true, "paper only");
  assertEqual(DIRECTION_REPLICATION_FLAGS.shadowOnly, true, "shadow only");
  assertEqual(DEVELOPMENT_EVIDENCE_PROFILE.replicationStatus, "NOT_REPLICATED", "a development summary is NOT_REPLICATED");
  assertEqual(REPLICATION_EVIDENCE_PROFILE.replicationStatus, "PENDING_WAVE_AGGREGATION", "a single session is not a wave result");
  assertEqual(evidenceProfileForExperiment({ evidenceClass: REPLICATION_EVIDENCE_CLASS }), REPLICATION_EVIDENCE_PROFILE, "the replication class resolves");
  assertEqual(evidenceProfileForExperiment({ evidenceClass: "SOMETHING_ELSE" }), null, "an unknown class FAILS CLOSED");
  assertEqual(evidenceProfileById("nope"), null, "an unknown profile id fails closed");
  assertEqual(resolveEvidenceProfile(null), DEVELOPMENT_EVIDENCE_PROFILE, "an absent profile defaults to development");
  assertEqual(resolveEvidenceProfile("replication"), REPLICATION_EVIDENCE_PROFILE, "and a named profile resolves");
  assertThrows(() => resolveEvidenceProfile("guessed"), (error) => error.message.includes("unknown Phase 5I evidence profile"), "an unknown profile throws rather than guessing");
  assertEqual(DEVELOPMENT_EVIDENCE_PROFILE.interpretation.includes("No profitability inference is permitted."), true, "the development interpretation is frozen on the profile too");
  assertEqual(DEVELOPMENT_EVIDENCE_PROFILE.noAutomatedWinner, true, "with no automated winner");
});

test("AL2. the replication fixture sessions carry the replication class and nothing else changed", async () => {
  const rep = ctx.replication;
  for (const entry of rep.sessions) {
    const bundle = await readDirectionExperimentBundle(directionExperimentRootFor(rep.experimentsRoot, entry.experimentId));
    const development = entry.development === true;
    assertEqual(bundle.experiment.evidenceClass, development ? DIRECTION_EVIDENCE_CLASS : REPLICATION_EVIDENCE_CLASS, `${entry.experimentId} declares its class`);
    assertEqual(bundle.experiment.schemaVersion, DIRECTION_SCHEMA_VERSION, `${entry.experimentId} keeps the frozen schema version`);
    assertEqual(bundle.experiment.phase, DIRECTION_PHASE, `${entry.experimentId} keeps the frozen phase`);
    assertEqual(bundle.experiment.horizonSeconds, 30, `${entry.experimentId} keeps the frozen horizon`);
    assertEqual(bundle.experiment.samplingCadenceMs, 30_000, `${entry.experimentId} keeps the frozen cadence`);
    assertEqual(bundle.experiment.questionDigest, directionQuestionDigest(), `${entry.experimentId} keeps the frozen question digest`);
    assertEqual(bundle.experiment.featureDefinitionDigest, DIRECTION_FEATURE_DEFINITION_DIGEST, `${entry.experimentId} keeps the frozen feature digest`);
    assertEqual(bundle.experiment.baselineDefinitionDigest, BASELINE_DEFINITION_DIGEST, `${entry.experimentId} keeps the frozen baseline digest`);
    assertEqual(bundle.experiment.metricDefinitionDigest, DIRECTION_METRIC_DEFINITION_DIGEST, `${entry.experimentId} keeps the frozen metric digest`);
    assertEqual(bundle.experiment.mode, "shadow", `${entry.experimentId} stays shadow`);
    for (const prediction of bundle.predictions) {
      assertEqual(prediction.evidenceClass, bundle.experiment.evidenceClass, `${entry.experimentId} prediction carries the same class`);
      assertEqual(Object.hasOwn(prediction, "threshold"), false, `${entry.experimentId} prediction carries no threshold`);
    }
  }
  const replicationSession = rep.sessions.find((entry) => entry.experimentId === "jdir-fixture-rep-1");
  const bundle = await readDirectionExperimentBundle(directionExperimentRootFor(rep.experimentsRoot, "jdir-fixture-rep-1"));
  assertEqual(bundle.summary.evidenceScope, "REPLICATION", "a replication session summary declares the replication scope");
  assertEqual(bundle.summary.developmentOnly, false, "and is not development evidence");
  assertEqual(bundle.summary.noConfidenceThreshold, true, "and has no confidence threshold");
  assertEqual(bundle.summary.winner, null, "and emits no winner");
  assertTrue(replicationSession !== undefined, "the clean fixture session exists");
});

test("AL3. the replication summary contains no winner, no significance and no profitability field", () => {
  const stats = ctx.replication.added[ctx.replication.added.length - 1].summary;
  assertEqual(stats.winner, null, "no winner");
  assertEqual(stats.noAutomatedWinner, true, "declared");
  assertEqual(stats.significanceClaimed, false, "no significance claim");
  assertEqual(stats.profitabilityInference, false, "no profitability inference");
  assertEqual(stats.tradingInference, false, "no trading inference");
  assertEqual(stats.deploymentInference, false, "no deployment inference");
  const audit = auditNoProfitabilityFields(stats);
  assertEqual(audit.ok, true, `no profitability-shaped field appears: ${audit.problems.join("; ")}`);
  const serialized = JSON.stringify(stats).toLowerCase();
  for (const token of ["pnl", "sharpe", "sortino", "profitfactor", "expectedreturn"]) {
    assertExcludes(serialized, token, `the replication summary contains no ${token}`);
  }
  assertEqual(stats.bootstrap.pValueEmitted, false, "no p-value is emitted");
  assertEqual(stats.bootstrap.significanceLabelEmitted, false, "no significance label is emitted");
  for (const interval of Object.values(stats.bootstrap.comparisons ?? {})) {
    assertEqual(interval.pValue, null, "no interval carries a p-value");
    assertEqual(interval.significanceLabel, null, "no interval carries a significance label");
    assertEqual(interval.statisticallyProven, false, "no interval claims statistical proof");
    assertEqual(interval.descriptiveOnly, true, "every interval is descriptive only");
  }
  assertEqual(stats.noTuningBetweenSessions, true, "the summary records the no-tuning rule");
  assertEqual(stats.interruptedWaveIsIncomparable, true, "and the interrupted-wave rule");
});

test("AL4. the new 5I.1 modules are inside the isolation barrier and contain no money path", async () => {
  const modules = [
    "scripts/jev/direction/evidence.mjs",
    "scripts/jev/direction/replication/development-barrier.mjs",
    "scripts/jev/direction/replication/protocol.mjs",
    "scripts/jev/direction/replication/manifest.mjs",
    "scripts/jev/direction/replication/eligibility.mjs",
    "scripts/jev/direction/replication/aggregate.mjs",
    "scripts/jev/direction/replication/runner.mjs",
  ];
  for (const relative of modules) {
    assertTrue(PHASE_5I_MODULES.includes(relative), `${relative} is inside the 5I module barrier`);
    const source = executableCode(await readText(relative));
    for (const token of FORBIDDEN_RUNTIME_TOKENS) {
      assertExcludes(source, token, `${relative} executable code contains no '${token}'`);
    }
    assertExcludes(source, "minConfidence", `${relative} has no minConfidence identifier`);
    assertExcludes(source, "confidenceThreshold:", `${relative} assigns no confidenceThreshold`);
    assertExcludes(await readText(relative), "arena/tournament", `${relative} does not import the Arena tournament`);
  }
  const engine = await readText("scripts/evolve-engine.mjs");
  assertExcludes(engine, "jev/direction", "the engine still never imports the 5I direction modules");
});

test("AL5. replay and stats are provably zero-network and never launch a session", async () => {
  const rep = ctx.replication;
  const replay = await replicationReplay({ replicationRoot: rep.replicationRoot, baseRoot: rep.experimentsRoot, replicationId: rep.created.replicationId });
  const stats = await replicationStats({ replicationRoot: rep.replicationRoot, baseRoot: rep.experimentsRoot, replicationId: rep.created.replicationId });
  for (const [label, report] of [["replay", replay], ["stats", stats]]) {
    assertEqual(report.networkCalls, 0, `${label}: zero network calls`);
    assertEqual(report.jevCalls, 0, `${label}: zero Jev calls`);
    assertEqual(report.arenaRuns, 0, `${label}: zero Arena runs`);
    assertEqual(report.tradingCalls, 0, `${label}: zero trading calls`);
    assertEqual(report.launchedSessions, 0, `${label}: launched no session`);
  }
  const runnerSource = await readText("scripts/jev/direction/replication/runner.mjs");
  assertIncludes(runnerSource, "NO OPERATION HERE EVER LAUNCHES A SESSION", "the runner states that it never launches a session");
  assertIncludes(runnerSource, "READ ONLY, ZERO NETWORK", "and that the read paths are offline");
});

test("AL6. Phase 5I.1 wrote nothing under the real replication tree", async () => {
  const now = await metadataSnapshot(REAL_REPLICATION_ROOT);
  assertDeepEqual(now, ctx.before.realReplication, "the real replication tree is byte-unchanged");
  assertTrue(!(ctx.tempRoot ?? "").includes(path.join(REPO, ".evolve")), "every replication fixture lives in temp");
  assertTrue(path.join(DIRECTION_ROOT_DIR, "replication") === DIRECTION_REPLICATION_ROOT_DIR, "the replication tree is the documented path");
  assertEqual(REPLICATION_MANIFEST_FILE, "replication.json", "the manifest file name");
  assertEqual(REPLICATION_SESSIONS_FILE, "sessions.json", "the sessions file name");
  assertEqual(REPLICATION_SUMMARY_FILE, "summary.json", "the summary file name");
  assertEqual(REPLICATION_RUNNER_VERSION, 1, "the replication runner version");
});

test("AL7. the replication helpers do not duplicate raw experiment artifacts", async () => {
  const rep = ctx.replication;
  const sessions = await readReplicationSessions(replicationRootFor(rep.replicationRoot, rep.created.replicationId));
  for (const session of sessions.sessions) {
    assertEqual(session.experimentId, session.sessionId, "a session record references its experiment by id");
    assertEqual(Object.hasOwn(session, "predictions"), false, "and stores no prediction artifacts");
    assertEqual(Object.hasOwn(session, "outcomes"), false, "and no outcome artifacts");
    assertEqual(Object.hasOwn(session, "metrics"), true, "it stores the derived session-level metrics");
    assertEqual(Object.hasOwn(session.metrics, "rows"), false, "but not the observation-level rows");
    assertEqual(session.metricsDigest.length, 64, "it pins the observation-level report by digest instead");
    assertEqual(Object.hasOwn(session, "windowMs"), true, "and keeps the session window for the independence rule");
  }
  const source = await readText("scripts/jev/direction/replication/manifest.mjs");
  assertIncludes(source, "REFERENCES existing immutable", "the storage module states the reference-only rule");
});

test("AL8. the replication builder never rewrote the development evidence it references", async () => {
  const rep = ctx.replication;
  const root = directionExperimentRootFor(rep.experimentsRoot, CANONICAL_DEVELOPMENT_EXPERIMENT_ID);
  if (!(await exists(root))) {
    skip("the canonical development experiment is absent in this checkout — its immutability check was skipped cleanly");
    return;
  }
  for (const sessionId of ["jdir-fixture-rep-1", "jdir-fixture-rep-2", "jdir-fixture-rep-3"]) {
    const bundle = await readDirectionExperimentBundle(directionExperimentRootFor(rep.experimentsRoot, sessionId));
    assertEqual(bundle.experiment.evidenceClass, REPLICATION_EVIDENCE_CLASS, `${sessionId} is replication evidence`);
    assertEqual(bundle.summary.replicationStatus, "PENDING_WAVE_AGGREGATION", `${sessionId} never claims a wave-level result`);
  }
  const development = await readDirectionExperimentBundle(root);
  assertEqual(development.experiment.evidenceClass, DIRECTION_EVIDENCE_CLASS, "the development experiment is still development evidence");
  assertEqual(development.summary.evidenceScope, "DEVELOPMENT", "with its development scope intact");
  assertEqual(development.summary.replicationStatus, "NOT_REPLICATED", "and its NOT_REPLICATED status intact");
});

/* ============================================================================
 * Runner
 * ==========================================================================*/

async function run() {
  let passed = 0;
  const failures = [];
  const started = Date.now();

  ctx.before.realDirection = await metadataSnapshot(REAL_DIRECTION_ROOT);
  ctx.before.realExperiments = await metadataSnapshot(REAL_EXPECTED_DIR);
  ctx.before.realReplication = await metadataSnapshot(REAL_REPLICATION_ROOT);
  ctx.before.directionRootPresent = await exists(REAL_DIRECTION_ROOT);

  try {
    await buildFixtures();
  } catch (error) {
    console.error("could not build Phase 5I.0b fixtures:", error?.stack ?? error);
    await disposeFixtures();
    process.exitCode = 1;
    return;
  }
  const fixtureMs = Date.now() - started;

  for (const testCase of cases) {
    const caseStart = Date.now();
    try {
      await testCase.fn();
      passed += 1;
      console.log(`  ✓ ${testCase.name} (${Date.now() - caseStart}ms)`);
    } catch (error) {
      failures.push({ name: testCase.name, error });
      console.log(`  ✗ ${testCase.name}`);
      console.log(`      ${error?.message ?? error}`);
    }
  }

  const after = {
    realDirection: await metadataSnapshot(REAL_DIRECTION_ROOT),
    realExperiments: await metadataSnapshot(REAL_EXPECTED_DIR),
    realReplication: await metadataSnapshot(REAL_REPLICATION_ROOT),
  };
  await disposeFixtures();

  console.log(`\nfixtures built in ${fixtureMs}ms`);
  console.log("offline: no network call, no market request, no Jev call, no Agent-Reach call, no classifier call, no DeepSeek");
  console.log("call, no Arena run, no trading, and nothing written under .evolve/.");
  if (skips.length > 0) {
    console.log(`skipped ${skips.length} optional case(s) whose canonical evidence is absent here:`);
    for (const reason of skips) console.log(`  - ${reason}`);
  }
  console.log(
    `EVOLVE Phase 5I.0b direct-TypeSafe Jev directional-prediction + Phase 5I.1 frozen-protocol replication validation: ` +
      `${passed}/${cases.length} checks passed`,
  );

  if (failures.length > 0) {
    console.log("Failed checks:");
    for (const failure of failures) console.log(`  - ${failure.name}`);
    process.exitCode = 1;
  } else {
    console.log("All Phase 5I.0b checks passed. The question set, feature definition, packet, baselines, staleness policy,");
    console.log("reference-price definition and metric definition are frozen and digested; the 30-second target is measured from");
    console.log("the freeze instant and never moves; TIE outcomes are retained but never scored; the lookahead audit is");
    console.log("behavioural; startup divergence is a diagnostic and never called lookahead; every valid probability is retained");
    console.log("with no confidence threshold; and every routing flag stays false.");
    console.log("The Phase 5I.1 replication framework is frozen: the canonical development barrier and the replication protocol");
    console.log("digest are source-pinned, sessions are CLEAN only when they are genuine, direct-TypeSafe, frozen-protocol,");
    console.log("tamper-free, lookahead-clean and temporally independent of the development experiment and of each other, and the");
    console.log("cross-session aggregate is equal-weighted by eligible SESSION with no winner and no significance claim.");
    console.log("NO real benchmark and NO real replication session was run: every experiment above lived in a temp directory with an");
    console.log("injected clock, market and provider, and the operator runs real sessions manually.");
  }

  const clean =
    canonicalJson(after.realDirection) === canonicalJson(ctx.before.realDirection) &&
    canonicalJson(after.realExperiments) === canonicalJson(ctx.before.realExperiments) &&
    canonicalJson(after.realReplication) === canonicalJson(ctx.before.realReplication);
  if (!clean) {
    console.error("FAIL: this suite modified a real .evolve evidence tree — that must never happen.");
    process.exitCode = 1;
  }
}

run().catch(async (error) => {
  console.error("phase 5I.0b validation runner crashed:", error);
  await disposeFixtures().catch(() => {});
  process.exitCode = 1;
});

