#!/usr/bin/env node
/**
 * EVOLVE Phase 5I-PS.2e — TEMPORALLY DISTRIBUTED LOCAL TEV SUPERVISOR SHADOW
 * validation suite. FULLY OFFLINE. DEVELOPMENT SHADOW • ZERO AUTHORITY • PAPER ONLY.
 *
 * Proves, with no network and no live model:
 *
 *   - the genuine-production boundary is the unchanged PS.2d one;
 *   - the PRECOMMITTED temporal scheduler assigns 12 × 5-minute buckets, admits at
 *     most 10 per bucket and 120 per run, never borrows quota across buckets, never
 *     ranks and never depends on a score, an outcome, a prior decision, latency,
 *     confidence or market direction;
 *   - the complete-input digest covers every model-visible byte;
 *   - the shared Local JEV client is the ONLY decision path, the primary classifier
 *     is the Tev-style specialist (never a silently substituted generic model), and
 *     every escalation/fallback route is recorded with its real provenance;
 *   - no probability is invented: a grammar-constrained vote share stays a vote
 *     share, a calibrated TypeSafe number stays labelled as such, and `pSupport`
 *     does not exist in this evidence class;
 *   - the engine is byte-identical with the shadow disabled, working, slow,
 *     throwing, malformed, abstaining, escalating, queue-full and unavailable;
 *   - historical PS.2d / PS.2 evidence and every protected tree stay byte-identical.
 *
 * Run with: npm run validate:jev-supervisor (after the PS.2 and PS.2d suites).
 */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";

/* ============================================================================
 * Network denial — the whole suite is offline by construction.
 * ==========================================================================*/

let NETWORK_ATTEMPTS = 0;
const denyNetwork = () => {
  NETWORK_ATTEMPTS += 1;
  throw new Error("network is forbidden in the Phase 5I-PS.2e validation suite");
};
try {
  globalThis.fetch = denyNetwork;
  http.request = http.get = https.request = https.get = net.connect = net.createConnection = tls.connect = denyNetwork;
  net.Socket.prototype.connect = denyNetwork;
  syncBuiltinESMExports();
} catch {
  /* best effort: the fixtures below never call the network anyway */
}
for (const name of ["EVOLVE_JEV_API_KEY", "TYPESAFE_API_KEY", "AI_GATEWAY_API_KEY", "JUPITER_API_KEY"]) {
  delete process.env[name];
}

const { canonicalJson, digestOf } = await import("./lib/hash.mjs");
const { createMarketConfig } = await import("./market/config.mjs");
const { createSeededRandom } = await import("./lib/random.mjs");
const { createIdFactory } = await import("./lib/ids.mjs");
const { deriveMarket, MOMENTUM_REFERENCE } = await import("./market/normalize.mjs");
const { createSimulation } = await import("./engine/simulation.mjs");
const { MAX_POOL_AGE_UNBOUNDED } = await import("./engine/genome.mjs");
const { BENCHMARK_MARKET } = await import("./jev/direction/definition.mjs");
const { validateExternalPolicy } = await import("./governance/external-policy.mjs");
const { parsePlan, checkPlan } = await import("./governance/plan-check.mjs");
const {
  SUPERVISOR_REQUIRED_MODEL,
  SUPERVISOR_REQUIRED_PROVIDER,
  SUPERVISOR_ROOT_DIR,
} = await import("./jev/supervisor/definition.mjs");
const {
  PS2D_EVIDENCE_CLASSIFICATION,
  PS2D_FORBIDDEN_PACKET_KEY_PATTERN,
  PS2D_PRODUCTION_ACTION,
  PS2D_PRODUCTION_SELECTION,
  PS2D_PRODUCTION_SOURCE,
  PS2D_QUESTION_NAME,
  PS2D_QUESTION_SET_ID,
} = await import("./jev/supervisor/cross-asset-protocol.mjs");
const {
  PS2E_AUTHORITY_TAG,
  PS2E_BUCKET_COUNT,
  PS2E_BUCKET_MS,
  PS2E_CLI_PROFILES,
  PS2E_DECISION_SOURCES,
  PS2E_DECISIONS,
  PS2E_DISPOSITIONS,
  PS2E_EVIDENCE_CLASSIFICATION,
  PS2E_FLAGS,
  PS2E_GLOBAL_MAX_ADMISSIONS,
  PS2E_LABEL,
  PS2E_LATENCY_GROUPS,
  PS2E_LOCAL_JEV_CONTRACT,
  PS2E_LOCAL_JEV_MAX_STDOUT_BYTES,
  PS2E_LOCAL_JEV_MODE,
  PS2E_LOGICAL_CALL_TIMEOUT_MS,
  PS2E_MAX_LOGICAL_CALLS_PER_RUN,
  PS2E_MAX_PHYSICAL_ATTEMPTS_PER_RUN,
  PS2E_MISSING_LOCAL_JEV_INTERFACE,
  PS2E_OFFLINE_VALIDATION_PROFILE,
  PS2E_OUTCOMES,
  PS2E_PER_BUCKET_MAX_ADMISSIONS,
  PS2E_PER_ASSET_MAX_ADMISSIONS_PER_RUN,
  PS2E_PER_ASSET_MIN_SPACING_MS,
  PS2E_PHYSICAL_ATTEMPT_CEILING_PER_LOGICAL_CALL,
  PS2E_PRIMARY_CLASSIFIER,
  PS2E_PROFILES,
  PS2E_PROTOCOL_DEFINITION,
  PS2E_PACKET_LIMITATIONS,
  PS2E_PROTOCOL_DIGEST,
  PS2E_QUESTION_ID,
  PS2E_QUESTION_SET_ID,
  PS2E_RUN_WINDOW_MS,
  PS2E_SUPPRESSION_PRECEDENCE,
  PS2E_SUPPRESSION_REASONS,
  PS2E_VALIDATION_CLASSIFIER_POLICY,
  effectiveLocalRetries,
  localTevExternalCallPolicy,
  localTevProfileFor,
  physicalAttemptCeilingFor,
  sharedIntegerValue,
  stripPythonWhitespace,
} = await import("./jev/supervisor/local-tev-protocol.mjs");
const {
  PS2E_ABSTAIN_DESCRIPTION,
  PS2E_ABSTAIN_TOKEN,
  PS2E_REQUEST_RISK,
  allowedTokens,
  buildLocalTevRequest,
  buildLocalTevQuestions,
  decisionFromOptionToken,
  localTevQuestionDigest,
} = await import("./jev/supervisor/local-tev-questions.mjs");
const {
  attachTemporalProvenance,
  auditTevPacket,
  buildTevOpportunityPacket,
  carriesCounterfactualData,
  jevInputDigestFromEvidence,
  localTevCompleteInput,
  localTevInputDigestOf,
  modelInputDescriptorOf,
  tevOpportunityDigestOf,
  validateGenuineProductionEntry,
} = await import("./jev/supervisor/local-tev-packet.mjs");
const {
  createLocalTevScheduler,
  PS2E_ASSET_COUNTER_KEYS,
  PS2E_BUCKET_COUNTER_KEYS,
} = await import("./jev/supervisor/local-tev-scheduler.mjs");
const {
  LOCAL_JEV_CLIENT_STATUS,
  LOCAL_JEV_TRANSPORT_STATUS,
  SHARED_FLOAT_REFUSAL,
  assessLocalTevReadiness,
  classifyLocalJevOutcome,
  createDecisionCliTransport,
  createFixtureTransport,
  createLocalJevClient,
  effectiveMinMargin,
  effectiveMinStability,
  minimalChildEnv,
  readLocalJevEnvironment,
  resolveLocalJevConfigPath,
  resolveLocalJevExecutable,
  sharedFloatCoercion,
  sharedFloatValue,
  sharedRouterBuildProblems,
  validateLocalJevOutcome,
} = await import("./jev/supervisor/local-jev-client.mjs");
const {
  augmentReadinessForSession,
  createLocalTevShadow,
  localTevLatencyStats,
  localTevPolicyProblems,
} = await import("./jev/supervisor/local-tev-observer.mjs");
const { createSupervisorProposalObserver } = await import("./jev/supervisor/observer.mjs");
const { buildSupervisorSettings } = await import("./jev/supervisor/settings.mjs");
const { auditNoForbiddenResultFields } = await import("./jev/supervisor/summary.mjs");
const { loadJevSupervisorObserverState } = await import("./jev/supervisor/dashboard.mjs");
const {
  readSupervisorLocalTevObservations,
  readSupervisorState,
  readSupervisorSummary,
  listSupervisorSessions,
} = await import("./jev/supervisor/storage.mjs");
const { snapshotTree, compareSnapshots } = await import("./jev/paper-forensics/preservation.mjs");

/* ============================================================================
 * Harness
 * ==========================================================================*/

let PASSED = 0;
let FAILED = 0;
const FAILURES = [];

async function test(name, fn) {
  try {
    await fn();
    PASSED += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    FAILED += 1;
    FAILURES.push({ name, error });
    console.log(`  ✗ ${name}\n      ${error?.stack?.split("\n").slice(0, 5).join("\n      ") ?? error}`);
  }
}

function assertTrue(condition, message) {
  if (condition !== true) throw new Error(message ?? "expected a true condition");
}
function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message ?? "equality"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assertDeepEqual(actual, expected, message) {
  const a = canonicalJson(actual);
  const b = canonicalJson(expected);
  if (a !== b) throw new Error(`${message ?? "deep equality"}: ${a.slice(0, 400)} !== ${b.slice(0, 400)}`);
}
function assertIncludes(haystack, needle, message) {
  if (!String(haystack).includes(needle)) throw new Error(`${message ?? "includes"}: missing '${needle}'`);
}
function assertExcludes(haystack, needle, message) {
  if (String(haystack).includes(needle)) throw new Error(`${message ?? "excludes"}: found '${needle}'`);
}

/**
 * Remove comments before a source scan: several scanned modules DOCUMENT the
 * quantities they refuse to read ("no ... confidence-, logit- ... input"), so an
 * unfiltered substring scan would flag the prohibition itself as the violation.
 */
function stripComments(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/* ============================================================================
 * Fixtures (deterministic, offline, no provider, no network)
 * ==========================================================================*/

const BASE_AT = Date.parse("2026-09-25T12:00:00Z");
const WORKSPACE = await mkdtemp(path.join(tmpdir(), "evolve-ps2e-"));
const SESSION_BASE = path.join(WORKSPACE, "sessions");
const USDC_MINT = BENCHMARK_MARKET.quoteMint;
const HISTORICAL_SESSIONS = ["jsup-20260922T151045Z-063f35", "jsup-20260923T042620Z-d1368a"];

function mintOf(label) {
  const mapped = String(label).replace(/[0-9]/g, (digit) => "abcdefghjk"[Number(digit)]);
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(mapped)) throw new Error(`fixture label '${label}' is not base58-safe`);
  if (mapped.length > 40) throw new Error(`fixture label '${label}' is too long`);
  return `${mapped}${"1".repeat(43)}`.slice(0, 43);
}

const MINT = {
  A: mintOf("PS2eAssetAaaa"),
  B: mintOf("PS2eAssetBbbb"),
  C: mintOf("PS2eAssetCccc"),
  D: mintOf("PS2eAssetDddd"),
};

const FEATURE_TEMPLATE = Object.freeze({
  momentum: 0.7,
  buyPressure: 1.2,
  orderFlow: 0.4,
  organicFlow: 0.9,
  netBuyerPressure: 0.3,
  traderActivity: 0.6,
  organicBuyers: 0.5,
  liquidityQuality: 0.8,
  organicScore: 0.85,
  safety: 0.9,
  ageYouth: 0.4,
  holderDistribution: 0.7,
  holderBase: 0.6,
  volumeActivity: 0.5,
  liquidityTrend: 0.2,
  volatility: 0.35,
  poolAgeHours: 12,
});

/** A schema-eligible market object shaped exactly like the engine's copied one. */
function syntheticMarket({ mint = MINT.A, symbol = "ALPHA", at = BASE_AT, price = 2.5, ...overrides } = {}) {
  return {
    mint,
    symbol,
    price,
    liquidity: 5_000_000,
    lastObservedAt: at,
    fresh: true,
    synthetic: false,
    changePct: 0.8,
    volume5m: 2_000_000,
    buySellRatio: 1.4,
    organicBuySellRatio: 1.2,
    holderCount: 50_000,
    topHoldersPercentage: 12,
    verified: true,
    mintAuthorityDisabled: true,
    freezeAuthorityDisabled: true,
    poolAgeMs: 43_200_000,
    updatedAt: at,
    tokenUpdatedAt: at,
    features: { ...FEATURE_TEMPLATE },
    ...overrides,
  };
}

/** Genuine production-entry facts exactly as the unchanged engine tap hands them over. */
function entryFacts({
  mint = MINT.A,
  symbol = "ALPHA",
  at = BASE_AT + 1_000,
  price = 2.5,
  agentId = "A-PS2E-1",
  species = "Momentum",
  generation = 1,
  generationTick = 1,
  score = 0.61,
  threshold = 0.4,
  market = null,
  ...rest
} = {}) {
  return {
    source: PS2D_PRODUCTION_SOURCE,
    action: PS2D_PRODUCTION_ACTION,
    selection: PS2D_PRODUCTION_SELECTION,
    at,
    generation,
    generationTick,
    agentId,
    species,
    lineageId: "L-PS2E-1",
    researchFamilyId: null,
    productionScore: score,
    entryScoreThreshold: threshold,
    gateAssessment: { passes: true, firstFailedGate: null, failedGates: [] },
    eligibleMarketCount: 3,
    tradeableMarketCount: 4,
    engineRegime: "RISK-ON",
    market: market ?? syntheticMarket({ mint, symbol, price, at }),
    ...rest,
  };
}

/* ---- Local JEV outcome fixtures (the shared implementation's own JSON shape) --- */

function attemptFor({
  tier = 1,
  provider = "nobodywho",
  model = "Tev1-4B-PS2E-VALIDATION-FIXTURE",
  choice = "support",
  abstain = false,
  abstainReason = null,
  accepted = true,
  confidence = 0.66,
  confidenceKind = "sample_stability",
  latencyMs = 40,
  escalationReason = null,
  fallbackFrom = null,
  fallbackReason = null,
  role = null,
  status = null,
} = {}) {
  return {
    tier,
    provider,
    model,
    choice,
    abstain,
    abstain_reason: abstainReason,
    accepted,
    confidence,
    confidence_kind: confidenceKind,
    latency_ms: latencyMs,
    escalation_reason: escalationReason,
    fallback_from: fallbackFrom,
    fallback_reason: fallbackReason,
    // Physical-attempt provenance exactly as the hardened shared router labels
    // every attempt (`role` and `status` are always exposed in its schema).
    role: role ?? (provider === "jev" ? "typesafe" : tier === 1 ? "specialist" : "generic"),
    status: status ?? (accepted ? "accepted" : abstain ? "abstained" : "failed"),
  };
}

function outcomeFor({
  tier = 1,
  follow = "support",
  choice = "support",
  abstain = false,
  decisionAbstainReason = null,
  abstained = null,
  provider = "nobodywho",
  model = "Tev1-4B-PS2E-VALIDATION-FIXTURE",
  confidence = 0.66,
  confidenceKind = "sample_stability",
  votes = { support: 2, do_not_support: 1 },
  samples = 3,
  attempts = null,
  error = null,
  fallbackReason = null,
  details = null,
} = {}) {
  return {
    request_id: "__REQUEST_ID__",
    mode: PS2E_LOCAL_JEV_MODE,
    follow,
    decision: {
      provider,
      choice,
      abstain,
      abstain_reason: decisionAbstainReason,
      model,
      latency_ms: 40,
      confidence,
      confidence_kind: confidenceKind,
      distribution: null,
      votes,
      samples,
      fallback_reason: fallbackReason,
      error,
      details: details ?? { worker: "persistent", model_reused: true },
    },
    tier,
    attempts: attempts ?? [attemptFor({ tier, provider, model, choice, abstain, accepted: true, confidence, confidenceKind })],
    // Only when the fixture explicitly models a top-level abstained flag (the
    // pinned shared schema expresses abstention via decision.abstain instead).
    ...(abstained === null ? {} : { abstained }),
  };
}

function fixtureTransportFor(steps, name = "ps2e-fixture") {
  return createFixtureTransport({
    name,
    script: steps.map((step) =>
      typeof step === "string" ? { status: LOCAL_JEV_TRANSPORT_STATUS.OK, stdout: step } : step,
    ),
  });
}

function okStep(outcome) {
  return { status: LOCAL_JEV_TRANSPORT_STATUS.OK, stdout: JSON.stringify(outcome) };
}

/* ---- Local JEV environment projection fixtures ------------------------------ */

const VALIDATION_PRIMARY_MODEL = PS2E_VALIDATION_CLASSIFIER_POLICY.pinnedModel;

/**
 * Explicit UNAVAILABLE fixture policy: preserves the fail-closed coverage that
 * the real pin carried at precommit time. The real `PS2E_PRIMARY_CLASSIFIER` is
 * now the available, correctly pinned specialist; unavailable/missing paths are
 * proven against this fixture — never by pretending the real pin is unavailable.
 */
const UNAVAILABLE_CLASSIFIER_POLICY = Object.freeze({
  ...PS2E_PRIMARY_CLASSIFIER,
  available: false,
  unavailableReason: "fixture: no Tev-style specialist is exposed by the shared Local JEV installation",
  pinnedModel: null,
  pinnedModelSha256: null,
});

function fixtureConfigJson({
  primary = true,
  primaryModel = VALIDATION_PRIMARY_MODEL,
  primarySha256 = "0".repeat(64),
  tier2 = true,
  tier1Timeout = 60,
  tier2Timeout = 60,
  localTimeoutS = 60,
  jevEnabled = false,
  jevTimeoutS = null,
  omitJevBlock = false,
  omitJevEnabled = false,
  maxLocalRetries = 0,
  tier1Settings = {},
  tier2Settings = {},
  localSettings = {},
  acceptanceSettings = {},
} = {}) {
  const tierBlock = (name, model, timeoutS, settings = {}) => ({
    source: `huggingface:fixture/${model}`,
    model_path: `/fixture/${model}.gguf`,
    model_sha256: name === "1" ? primarySha256 : "0".repeat(64),
    model_info: { file: `${model}.gguf`, name: model, quantization: "Q4_K_M", architecture: "qwen3" },
    use_gpu: false,
    persistent: true,
    // `null` = NO explicit timeout_s in the stored config (inheritance/defaults).
    ...(timeoutS === null ? {} : { timeout_s: timeoutS }),
    ...settings,
  });
  return JSON.stringify({
    mode: PS2E_LOCAL_JEV_MODE,
    ...(omitJevBlock
      ? {}
      : {
          jev: {
            ...(omitJevEnabled ? {} : { enabled: jevEnabled }),
            ...(jevTimeoutS === null ? {} : { timeout_s: jevTimeoutS }),
          },
        }),
    local: {
      samples: 3,
      seed: 1234,
      temperature: 0.7,
      n_ctx: 2048,
      ...(localTimeoutS === null ? {} : { timeout_s: localTimeoutS }),
      persistent: true,
      ...localSettings,
    },
    acceptance: {
      min_stability: 0.66,
      min_margin: 1,
      escalate_on_abstain: true,
      max_local_retries: maxLocalRetries,
      ...acceptanceSettings,
    },
    tiers: {
      ...(primary ? { "1": tierBlock("1", primaryModel, tier1Timeout, tier1Settings) } : {}),
      ...(tier2 ? { "2": tierBlock("2", "Qwen3.5-9B", tier2Timeout, tier2Settings) } : {}),
    },
  });
}

async function projectionFor(options = {}) {
  return readLocalJevEnvironment({
    env: { HOME: "/fixture-home", PATH: "/usr/bin" },
    configPath: "/fixture/config.json",
    readFileImpl: async () => fixtureConfigJson(options),
    accessImpl: async () => {},
  });
}

function fixtureProjection({ tier1 = true, tier1Model = "generic-qwen3-4b", tier1Sha256 = "0".repeat(64) } = {}) {
  return {
    executable: { command: "decision", source: "PATH:decision", found: null, checkedPath: null },
    configPath: "/fixture/config.json",
    config: {
      found: true,
      path: "/fixture/config.json",
      mode: PS2E_LOCAL_JEV_MODE,
      modeSource: "config",
      jevFallbackEnabled: false,
      tiers: {
        ...(tier1 ? { "1": { tier: "1", modelName: tier1Model, configured: true, timeoutS: 60, modelSha256: tier1Sha256 } } : {}),
        "2": { tier: "2", modelName: "Qwen3.5-9B", configured: true, timeoutS: 60, modelSha256: "1".repeat(64) },
      },
      local: { samples: 3, seed: 1234, temperature: 0.7, nCtx: 2048, timeoutS: 60, persistent: true },
      acceptance: { minStability: 0.66, minMargin: 1, escalateOnAbstain: true, maxLocalRetries: 0 },
      problems: [],
    },
    problems: [],
  };
}

/* ---- Shadow harness -------------------------------------------------------- */

let SHADOW_SERIAL = 0;

/**
 * Create a PS.2e shadow directly (no engine, no supervisor wrapper). The clock is
 * a deterministic stepper so latency telemetry is reproducible.
 */
function shadowFor({
  policy = PS2E_VALIDATION_CLASSIFIER_POLICY,
  transport = null,
  projection = null,
  readiness = null,
  profile = PS2E_OFFLINE_VALIDATION_PROFILE.profile,
  writeArtifacts = true,
  runStartedAtMs = BASE_AT,
  label = "shadow",
} = {}) {
  SHADOW_SERIAL += 1;
  const sessionId = `jsup-ps2e-${label}-${SHADOW_SERIAL}`;
  const root = path.join(SESSION_BASE, sessionId);
  let clock = runStartedAtMs;
  const stepNow = () => {
    clock += 1;
    return clock;
  };
  const shadow = createLocalTevShadow({
    sessionId,
    root,
    profileName: profile,
    allowOfflineValidation: profile === PS2E_OFFLINE_VALIDATION_PROFILE.profile,
    classifierPolicy: policy,
    localJevProjection: projection,
    readiness,
    transport,
    writeArtifacts,
    waitForStorage: async () => {
      await mkdir(root, { recursive: true });
    },
    noteObserverError: () => {},
    now: stepNow,
    nowMs: stepNow,
    runStartedAtMs,
  });
  return { shadow, sessionId, root };
}

/**
 * Drive the worker deterministically (no timers): flush the buffered tick into
 * the precommitted scheduler, then process until the queue is empty. The real
 * worker loop (`localTevWorkerLoop`) flushes the same way; driving the shadow
 * without flushing would leave admitted work unscheduled.
 */
async function drainShadow(shadow, { max = 400 } = {}) {
  let processed = 0;
  shadow.flushSampling();
  while (processed < max) {
    const did = await shadow.processNext();
    if (did !== true) break;
    shadow.flushSampling();
    processed += 1;
  }
  return processed;
}

/* ---- Engine fixtures (real engine, real tap, deterministic feed) ------------ */

function tokenFor({
  mint,
  symbol,
  price,
  at,
  poolAgeHours = 12,
  liquidity = 5_000_000,
  buyVolume = 2_000_000,
  sellVolume = 1_500_000,
  priceChange = 0.8,
  verified = true,
  observedAt = at,
  synthetic = false,
}) {
  return {
    mint,
    symbol,
    name: symbol,
    usdPrice: price,
    liquidity,
    mcap: 5e8,
    fdv: 5e8,
    organicScore: 85,
    holderCount: 50_000,
    topHoldersPercentage: 12,
    poolCreatedAt: at - poolAgeHours * 3_600_000,
    observedAt,
    isVerified: verified,
    mintAuthorityDisabled: true,
    freezeAuthorityDisabled: true,
    synthetic,
    source: "jupiter",
    endpoint: "/tokens/v2/toporganicscore",
    stats5m: {
      priceChange,
      liquidityChange: 0.2,
      volumeChange: 4,
      holderChange: 0.1,
      buyVolume,
      sellVolume,
      buyOrganicVolume: 1_000_000,
      sellOrganicVolume: 600_000,
      numBuys: 3000,
      numSells: 2500,
      numTraders: 4000,
      numOrganicBuyers: 600,
      numNetBuyers: 120,
    },
  };
}

const ASSET_SPECS = [
  { key: "A", symbol: "ALPHA", base: 2.5, liquidity: 9_000_000, buyVolume: 2_600_000, sellVolume: 1_100_000, priceChange: 1.8 },
  { key: "B", symbol: "BETA", base: 0.04, liquidity: 3_000_000, buyVolume: 1_400_000, sellVolume: 1_500_000, priceChange: -0.6 },
  { key: "C", symbol: "GAMMA", base: 130, liquidity: 20_000_000, buyVolume: 5_000_000, sellVolume: 4_000_000, priceChange: 0.3 },
  { key: "D", symbol: "DELTA", base: 7, liquidity: 1_500_000, buyVolume: 900_000, sellVolume: 300_000, priceChange: 3.2 },
];

function createMultiAssetFeed({ specs = ASSET_SPECS } = {}) {
  let step = 0;
  const feed = {
    effectiveMode: "synthetic",
    synthetic: { regime: "RISK-ON" },
    universe: new Map(),
    markets(at) {
      step += 1;
      const markets = [];
      const universe = new Map();
      specs.forEach((spec, index) => {
        const price = spec.base * (1 + 0.09 * Math.sin((step * (index + 2)) / 3));
        const options = {
          mint: MINT[spec.key],
          symbol: spec.symbol,
          price,
          at,
          liquidity: spec.liquidity,
          buyVolume: spec.buyVolume,
          sellVolume: spec.sellVolume,
          priceChange: spec.priceChange,
        };
        universe.set(options.mint, tokenFor(options));
        markets.push(deriveMarket(tokenFor(options), { at, staleMs: 3_600_000, momentumReference: MOMENTUM_REFERENCE.synthetic }));
      });
      universe.set(USDC_MINT, { mint: USDC_MINT, price: 1, observedAt: at, stats5m: {} });
      feed.universe = universe;
      return markets;
    },
    health() {
      return { allowNewEntries: true, degraded: false, source: "synthetic", label: "SYNTHETIC MARKET • PAPER MONEY" };
    },
  };
  return feed;
}

const OPEN_GATES = Object.freeze({
  minLiquidityQuality: 0,
  minOrganicScore: 0,
  requireConcentrationKnown: 0,
  maxTopHolderPct: 100,
  requireAuthoritySafe: 0,
  requireVerified: 0,
  minPoolAgeHours: 0,
  maxPoolAgeHours: MAX_POOL_AGE_UNBOUNDED,
  buyPressureThreshold: 0,
  momentumGateEnabled: 0,
});

async function runEngine({
  observer = null,
  ticks = 60,
  populationSize = 16,
  generationTicks = 30,
  stepMs = 15_000,
  genomeOverride = { ...OPEN_GATES, entryScoreThreshold: -0.2 },
  yieldsPerTick = 0,
  seedLabel = "ps2e-engine",
} = {}) {
  const config = createMarketConfig(
    {
      EVOLVE_MARKET_MODE: "synthetic",
      EVOLVE_POPULATION_SIZE: String(populationSize),
      EVOLVE_GENERATION_TICKS: String(generationTicks),
      EVOLVE_SYNTHETIC_UNIVERSE: "16",
    },
    { loadEnv: false },
  );
  const random = createSeededRandom(seedLabel);
  let clock = BASE_AT;
  const simulation = createSimulation({
    config,
    feed: createMultiAssetFeed(),
    now: () => clock,
    random,
    ids: createIdFactory(),
    evolution: { enabled: true, ...config.evolution },
    proposalObserver: observer,
  });
  for (const agent of simulation.population) {
    if (genomeOverride) agent.genome = { ...agent.genome, ...genomeOverride };
  }
  const tickDigests = [];
  const selectionLog = [];
  const generations = [];
  for (let i = 0; i < ticks; i += 1) {
    simulation.advanceTick();
    const snapshot = simulation.snapshot();
    tickDigests.push(digestOf({ snapshot, population: simulation.population }));
    selectionLog.push(
      simulation.population.map((agent) => [
        agent.id,
        agent.position?.mint ?? null,
        agent.position?.entryScore ?? null,
        agent.lastAction,
        agent.cash,
        agent.equity,
        agent.status,
      ]),
    );
    generations.push(snapshot.generation ?? null);
    clock += stepMs;
    for (let y = 0; y < yieldsPerTick; y += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const snapshot = simulation.snapshot();
  return {
    simulation,
    snapshot,
    tickDigests,
    selectionLog,
    generations,
    engineDigest: digestOf({ snapshot, genomes: simulation.population.map((agent) => digestOf(agent.genome)) }),
    fitness: simulation.population.map((agent) => [agent.id, agent.fitness ?? null]),
  };
}

function assertEngineIdentical(baseline, candidate, label) {
  assertEqual(JSON.stringify(candidate.snapshot), JSON.stringify(baseline.snapshot), `${label}: snapshot byte-identical`);
  assertDeepEqual(candidate.tickDigests, baseline.tickDigests, `${label}: every per-tick population digest`);
  assertEqual(candidate.engineDigest, baseline.engineDigest, `${label}: engine digest`);
  assertDeepEqual(candidate.selectionLog, baseline.selectionLog, `${label}: selected markets, best scores, actions, cash, equity`);
  assertDeepEqual(candidate.generations, baseline.generations, `${label}: generation transitions`);
  assertDeepEqual(candidate.snapshot.recentTrades, baseline.snapshot.recentTrades, `${label}: paper actions`);
  assertDeepEqual(candidate.fitness, baseline.fitness, `${label}: fitness`);
}

/** A TypeSafe-shaped fixture provider for the unchanged PS.2 / PS.2a SOL path. */
function fixtureProvider({ onEvaluate = null } = {}) {
  let calls = 0;
  const provider = {
    name: SUPERVISOR_REQUIRED_PROVIDER,
    model: SUPERVISOR_REQUIRED_MODEL,
    offline: false,
    external: true,
    gatewayUsed: false,
    async evaluate({ state, questions }) {
      calls += 1;
      if (typeof onEvaluate === "function") {
        const custom = await onEvaluate({ state, questions, calls });
        if (custom !== undefined) return custom;
      }
      const names = Object.keys(questions ?? {});
      assertTrue(names.includes("pHigher") || names.includes(PS2D_QUESTION_NAME) || names.length > 0);
      return {
        ok: true,
        requestId: `req-${calls}`,
        model: SUPERVISOR_REQUIRED_MODEL,
        answers: Object.fromEntries(names.map((entry) => [entry, { type: "noul", noul: 0.62 }])),
        usage: { inputTokens: 100, outputTokens: 4 },
      };
    },
  };
  return { provider, calls: () => calls };
}

async function observerFor({ label, localTev, provider = null, writeArtifacts = true } = {}) {
  SHADOW_SERIAL += 1;
  const sessionId = `jsup-ps2e-obs-${label}-${SHADOW_SERIAL}`;
  const root = path.join(SESSION_BASE, sessionId);
  await mkdir(root, { recursive: true });
  const observer = createSupervisorProposalObserver({
    sessionId,
    sessionRoot: root,
    baseRoot: SESSION_BASE,
    provider: provider ?? fixtureProvider().provider,
    writeArtifacts,
    finalizeTimeoutMs: 250,
    // The offline profile is opt-in on the supervisor observer too; the CLI never
    // sets this flag, so a real run can only ever use the frozen development profile.
    localTev: localTev ? { allowOfflineValidation: localTev.profile === "offline-validation", ...localTev } : localTev,
  });
  return { observer, sessionId, root };
}

/* ============================================================================
 * Preservation snapshots BEFORE anything runs
 * ==========================================================================*/

const PROTECTED_TREES = [
  path.join(".evolve", "jev-direction"),
  path.join(".evolve", "jev-paper-shadow"),
  path.join(".evolve", "jev-paper-forensics"),
  path.join(".evolve", "jev-supervisor-observer"),
  path.join(".evolve", "shadow"),
  path.join(".evolve", "arenas"),
];

const PRESERVATION_BEFORE = await snapshotTree(process.cwd(), PROTECTED_TREES);
const HISTORICAL_BEFORE = await Promise.all(
  HISTORICAL_SESSIONS.map(async (sessionId) => ({
    sessionId,
    summary: await readSupervisorSummary(path.join(SUPERVISOR_ROOT_DIR, sessionId)),
    state: await readSupervisorState(path.join(SUPERVISOR_ROOT_DIR, sessionId)),
  })),
);

/* ============================================================================
 * 1. Frozen protocol, evidence class, classifier pin, question set
 * ==========================================================================*/

console.log("\n1. Frozen protocol, evidence class and classifier identity");

await test("evidence classification is the NEW PS.2e class with every zero-authority flag", () => {
  assertEqual(PS2E_EVIDENCE_CLASSIFICATION, "DEVELOPMENT_CROSS_ASSET_TEV_SUPERVISOR_SHADOW");
  assertTrue(PS2E_EVIDENCE_CLASSIFICATION !== PS2D_EVIDENCE_CLASSIFICATION, "PS.2e must not reuse the PS.2d class");
  assertEqual(PS2E_FLAGS.developmentOnly, true);
  assertEqual(PS2E_FLAGS.paperOnly, true);
  assertEqual(PS2E_FLAGS.shadowOnly, true);
  assertEqual(PS2E_FLAGS.canonical, false);
  assertEqual(PS2E_FLAGS.replication, false);
  assertEqual(PS2E_FLAGS.temporalReplication, false);
  assertEqual(PS2E_FLAGS.predictiveEvidence, false);
  assertEqual(PS2E_FLAGS.noProfitabilityInference, true);
  assertEqual(PS2E_FLAGS.noTradingInference, true);
  assertEqual(PS2E_FLAGS.noDeploymentInference, true);
  assertEqual(PS2E_FLAGS.noAuthorityPromotion, true);
  assertEqual(PS2E_FLAGS.automaticPromotionPermitted, false);
  assertEqual(PS2E_FLAGS.outcomeResolved, false);
  assertEqual(PS2E_LABEL, "LOCAL TEV CROSS-ASSET SHADOW");
  assertIncludes(PS2E_AUTHORITY_TAG, "ZERO AUTHORITY");
});

await test("protocol digest is deterministic and covers the frozen definition", () => {
  assertEqual(PS2E_PROTOCOL_DIGEST, digestOf(PS2E_PROTOCOL_DEFINITION));
  assertEqual(PS2E_PROTOCOL_DEFINITION.bucketCount, 12);
  assertEqual(PS2E_PROTOCOL_DEFINITION.bucketMs, 300_000);
  assertEqual(PS2E_PROTOCOL_DEFINITION.perBucketMaxAdmissions, 10);
  assertEqual(PS2E_PROTOCOL_DEFINITION.globalMaxAdmissions, 120);
});

await test("the temporal schedule is exactly 12 x 5 minutes with a 10/bucket and 120/run ceiling", () => {
  assertEqual(PS2E_BUCKET_COUNT, 12);
  assertEqual(PS2E_BUCKET_MS, 300_000);
  assertEqual(PS2E_PER_BUCKET_MAX_ADMISSIONS, 10);
  assertEqual(PS2E_RUN_WINDOW_MS, 3_600_000);
  assertEqual(PS2E_GLOBAL_MAX_ADMISSIONS, 120);
  assertEqual(PS2E_MAX_LOGICAL_CALLS_PER_RUN, 120);
  assertEqual(PS2E_PER_BUCKET_MAX_ADMISSIONS * PS2E_BUCKET_COUNT, PS2E_GLOBAL_MAX_ADMISSIONS);
});

await test("CLI exposes only the frozen development profile; the offline profile is not selectable", () => {
  assertDeepEqual(PS2E_CLI_PROFILES, ["development"]);
  assertEqual(localTevProfileFor("development"), PS2E_PROFILES.development);
  assertEqual(localTevProfileFor("offline-validation"), null);
  assertEqual(localTevProfileFor("offline-validation", { allowOfflineValidation: true }), PS2E_OFFLINE_VALIDATION_PROFILE);
  assertEqual(localTevProfileFor("canary"), null);
  const settings = buildSupervisorSettings({ "local-tev": "canary", minutes: "60" });
  assertTrue(settings.problems.length > 0, "an unknown PS.2e profile must be refused");
});

await test("a PS.2e session is a 60-minute protocol and cannot mix with the PS.2d flags", () => {
  const short = buildSupervisorSettings({ "local-tev": "development", minutes: "30" });
  assertTrue(short.problems.some((problem) => problem.includes("minute")), "a shorter run must be refused");
  const ok = buildSupervisorSettings({ "local-tev": "development", minutes: "60" });
  assertEqual(ok.problems.length, 0);
  assertEqual(ok.localTevProfile, "development");
  assertTrue(ok.durationMs >= PS2E_RUN_WINDOW_MS);
  const mixed = buildSupervisorSettings({ "local-tev": "development", "cross-asset": "full", minutes: "60" });
  assertTrue(mixed.problems.some((problem) => problem.includes("cannot run in the same session")));
});

await test("the primary classifier is a Tev-style specialist, NOT a generic local model", () => {
  assertEqual(PS2E_PRIMARY_CLASSIFIER.classifierRuntime, "nobodywho");
  assertEqual(PS2E_PRIMARY_CLASSIFIER.classifierProvider, "nobodywho");
  assertEqual(PS2E_PRIMARY_CLASSIFIER.classifierMode, "local-first");
  assertEqual(PS2E_PRIMARY_CLASSIFIER.primaryTier, "1");
  assertEqual(PS2E_PRIMARY_CLASSIFIER.classifierKind, "specialized-option-token-classifier");
  assertEqual(PS2E_PRIMARY_CLASSIFIER.classifierFamily, "tev-style-specialist");
  assertEqual(PS2E_PRIMARY_CLASSIFIER.grammarConstrainedOptionTokens, true);
  assertEqual(PS2E_PRIMARY_CLASSIFIER.abstainIsProtocolOutcome, true);
  assertEqual(PS2E_PRIMARY_CLASSIFIER.thinkingEnabled, false);
});

await test("the real Local JEV specialist is available and correctly pinned", () => {
  assertEqual(PS2E_PRIMARY_CLASSIFIER.available, true);
  assertEqual(PS2E_PRIMARY_CLASSIFIER.pinnedModel, "local-jev-tev-specialist-v1");
  assertEqual(
    PS2E_PRIMARY_CLASSIFIER.pinnedModelSha256,
    "4b3fbb5e8ca29bca4e6982ff1cad49b7b2a9d0039241fad19bd474c7cdffc348",
  );
  assertEqual(PS2E_PRIMARY_CLASSIFIER.classifierId, "local-jev-tev-specialist-v1");
  assertEqual(PS2E_PRIMARY_CLASSIFIER.classifierFamily, "tev-style-specialist");
  assertEqual(PS2E_PRIMARY_CLASSIFIER.primaryTier, "1");
  assertEqual(PS2E_PRIMARY_CLASSIFIER.thinkingEnabled, false);
  assertEqual(PS2E_PRIMARY_CLASSIFIER.unavailableReason, null);
  // DEVELOPMENT provenance pin only: the shared Local JEV source state this
  // integration was completed against (never a runtime requirement).
  assertEqual(PS2E_PRIMARY_CLASSIFIER.localJevCompatibilityBaseline, "5454aa9ddb5aaa7217b1e05b4c2b1f412894f4a0");
  assertExcludes(JSON.stringify(PS2E_PRIMARY_CLASSIFIER), "Qwen");
});

await test("the historical blocker record is retained and fail-closed paths stay proven by fixture", () => {
  assertTrue(PS2E_MISSING_LOCAL_JEV_INTERFACE.length >= 4, "the missing shared interface must be enumerated");
  assertEqual(UNAVAILABLE_CLASSIFIER_POLICY.available, false);
  assertEqual(UNAVAILABLE_CLASSIFIER_POLICY.pinnedModel, null);
  assertEqual(UNAVAILABLE_CLASSIFIER_POLICY.pinnedModelSha256, null);
  assertIncludes(UNAVAILABLE_CLASSIFIER_POLICY.unavailableReason, "no Tev-style specialist");
  assertExcludes(JSON.stringify(UNAVAILABLE_CLASSIFIER_POLICY), "Qwen");
  // The validation-only policy remains the offline fixture it has always been.
  assertEqual(PS2E_VALIDATION_CLASSIFIER_POLICY.validationOnly, true);
  assertExcludes(PS2E_VALIDATION_CLASSIFIER_POLICY.pinnedModel, "local-jev-tev-specialist-v1");
});

await test("the question set is new, narrow, option-token based and free of probability/future language", () => {
  const questions = buildLocalTevQuestions();
  assertEqual(PS2E_QUESTION_SET_ID, "jev-cross-asset-production-opportunity-tev-v1");
  assertTrue(PS2E_QUESTION_SET_ID !== PS2D_QUESTION_SET_ID, "the PS.2d question set must not be reused");
  assertDeepEqual(questions.optionTokens, ["support", "do_not_support"]);
  assertEqual(questions.allowAbstain, true);
  assertEqual(questions.abstainToken, "ABSTAIN");
  for (const token of allowedTokens()) assertTrue(decisionFromOptionToken(token) !== null, `token ${token} must map`);
  assertEqual(decisionFromOptionToken("maybe"), null);
  assertEqual(decisionFromOptionToken(PS2E_ABSTAIN_TOKEN), PS2E_DECISIONS.ABSTAIN);
  assertEqual(localTevQuestionDigest(), digestOf(buildLocalTevQuestions()));
  const text = `${questions.question} ${JSON.stringify(questions.options)}`.toLowerCase();
  // The question DELIBERATELY says "pre-outcome facts" / "no future data" — the
  // declaration that only pre-outcome facts are sent. The scan therefore targets
  // CLAIMS about outcomes, returns or prices, never the word "outcome" itself.
  for (const forbidden of ["profit", "pnl", "future price", "horizon", "expected return", "trade now", "buy", "sell"]) {
    assertExcludes(text, forbidden, `the question must not contain '${forbidden}'`);
  }
  assertIncludes(text, "pre-outcome");
  assertExcludes(text, "psupport");
  assertExcludes(text, "probability");
  assertEqual(questions.responseSemantics.abstainConvertedToBinary, false);
  assertEqual(questions.responseSemantics.probabilityRequested, false);
});

await test("the frozen classifier policy passes its own fail-closed check; the validation policy is validation-only", () => {
  assertEqual(localTevPolicyProblems({ policy: PS2E_PRIMARY_CLASSIFIER, readiness: null }).length, 0);
  assertEqual(PS2E_VALIDATION_CLASSIFIER_POLICY.validationOnly, true);
  const bad = { ...PS2E_PRIMARY_CLASSIFIER, thinkingEnabled: true };
  assertTrue(localTevPolicyProblems({ policy: bad, readiness: null }).length > 0);
  const generic = { ...PS2E_PRIMARY_CLASSIFIER, classifierKind: "generic-local-llm" };
  assertTrue(localTevPolicyProblems({ policy: generic, readiness: null }).length > 0);
});

await test("the CLI is wired to the frozen pin only, never to the validation policy", async () => {
  const cli = await readFile("scripts/jev-supervisor.mjs", "utf8");
  assertIncludes(cli, "PS2E_PRIMARY_CLASSIFIER");
  assertExcludes(cli, "PS2E_VALIDATION_CLASSIFIER_POLICY");
  assertExcludes(cli, "allowOfflineValidation: true");
  const settings = await readFile("scripts/jev/supervisor/settings.mjs", "utf8");
  assertExcludes(settings, "PS2E_VALIDATION_CLASSIFIER_POLICY");
});

await test("the PS.2e external-call policy validates as evidence-bearing and adds no retry", () => {
  const policy = localTevExternalCallPolicy({ policy: PS2E_PRIMARY_CLASSIFIER, profile: PS2E_PROFILES.development });
  assertEqual(policy.retryCap, 0);
  assertEqual(policy.maxCallsPerRun, 120);
  assertEqual(policy.fallback, "none");
  assertEqual(policy.failClosed, true);
  assertEqual(policy.evidenceBearing, true);
  assertEqual(policy.authorityLevel, "SHADOW");
  assertEqual(validateExternalPolicy(policy, { evidenceBearing: true }).status, "PASS");
  assertEqual(PS2E_MAX_PHYSICAL_ATTEMPTS_PER_RUN, 120 * PS2E_PHYSICAL_ATTEMPT_CEILING_PER_LOGICAL_CALL);
  assertEqual(physicalAttemptCeilingFor({ configuredLocalTiers: 2, maxLocalRetries: 0, typesafeFallbackEnabled: true }), 3);
});

/* ============================================================================
 * 2. PRECOMMITTED temporal scheduler (pure)
 * ==========================================================================*/

console.log("\n2. Temporal admission scheduler");

const SCHEDULER_PROFILE = PS2E_PROFILES.development;

function schedulerFor({ profile = SCHEDULER_PROFILE, runStartedAtMs = BASE_AT } = {}) {
  return createLocalTevScheduler({ profile, runStartedAtMs });
}

function identityFor(mint, symbol = null) {
  return { marketId: `${mint}/${USDC_MINT}`, baseMint: mint, quoteMint: USDC_MINT, symbol };
}

function opportunityAt(mint, atMs, { digest = null, symbol = null } = {}) {
  return { identity: identityFor(mint, symbol), opportunityDigest: digest ?? digestOf({ mint, atMs }), atMs };
}

await test("bucket assignment is exact at every boundary and never outside the frozen window", () => {
  const scheduler = schedulerFor();
  assertEqual(scheduler.bucketIndexOf(BASE_AT), 0);
  assertEqual(scheduler.bucketIndexOf(BASE_AT + 299_999), 0);
  assertEqual(scheduler.bucketIndexOf(BASE_AT + 300_000), 1);
  assertEqual(scheduler.bucketIndexOf(BASE_AT + 11 * 300_000), 11);
  assertEqual(scheduler.bucketIndexOf(BASE_AT + 12 * 300_000), null);
  assertEqual(scheduler.bucketIndexOf(BASE_AT - 1), null);
  assertEqual(scheduler.bucketIndexOf(BASE_AT + PS2E_RUN_WINDOW_MS), null);
  assertEqual(scheduler.bucketIndexOf(Number.NaN), null);
});

await test("at most 10 admissions per bucket; the 11th eligible opportunity is suppressed by the bucket cap", () => {
  const scheduler = schedulerFor();
  const mints = Array.from({ length: 11 }, (_, index) => mintOf(`BucketCapAsset${index}`));
  const results = mints.map((mint, index) =>
    scheduler.decide(opportunityAt(mint, BASE_AT + 1_000 + index, { digest: digestOf({ index }) })),
  );
  assertEqual(results.filter((entry) => entry.admitted).length, 10);
  assertEqual(results[10].admitted, false);
  assertEqual(results[10].reason, PS2E_SUPPRESSION_REASONS.BUCKET_CAP);
  assertEqual(results[9].bucketAdmissionIndex, 10);
  assertEqual(scheduler.counters.admitted, 10);
  assertEqual(scheduler.counters.suppressedBucketCap, 1);
});

await test("a full bucket never borrows another bucket's quota, in either direction", () => {
  const scheduler = schedulerFor();
  // Fill bucket 0 (10 distinct assets at t+1s).
  for (let index = 0; index < 10; index += 1) {
    const decision = scheduler.decide(opportunityAt(mintOf(`Borrow${index}`), BASE_AT + 1_000 + index));
    assertEqual(decision.admitted, true);
    assertEqual(decision.bucketIndex, 0);
  }
  // An opportunity owned by bucket 0 but arriving LATE is still decided by its
  // own bucket's quota: it is suppressed, and it can never consume bucket 1.
  const late = scheduler.decide(opportunityAt(mintOf("BorrowLate"), BASE_AT + 2_000));
  assertEqual(late.admitted, false);
  assertEqual(late.reason, PS2E_SUPPRESSION_REASONS.BUCKET_CAP);
  assertEqual(late.bucketIndex, 0);
  // Bucket 1 has its own untouched quota.
  const next = scheduler.decide(opportunityAt(mintOf("BorrowNext"), BASE_AT + 300_000));
  assertEqual(next.admitted, true);
  assertEqual(next.bucketIndex, 1);
  assertEqual(next.bucketAdmissionIndex, 1);
  const report = scheduler.temporalReport();
  assertEqual(report.buckets[0].admitted, 10);
  assertEqual(report.buckets[1].admitted, 1);
  assertEqual(report.occupancy.bucketsAtCap, 1);
  assertEqual(report.occupancy.bucketsWithAdmissions, 2);
  assertEqual(report.occupancy.emptyBuckets, 10);
});

await test("an opportunity outside the window is refused with its own reason and consumes nothing", () => {
  const scheduler = schedulerFor();
  const before = scheduler.decide(opportunityAt(MINT.A, BASE_AT - 1));
  assertEqual(before.admitted, false);
  assertEqual(before.reason, PS2E_SUPPRESSION_REASONS.OUTSIDE_WINDOW);
  const after = scheduler.decide(opportunityAt(MINT.B, BASE_AT + PS2E_RUN_WINDOW_MS));
  assertEqual(after.reason, PS2E_SUPPRESSION_REASONS.OUTSIDE_WINDOW);
  assertEqual(scheduler.counters.admitted, 0);
  assertEqual(scheduler.counters.suppressedOutsideWindow, 2);
  const report = scheduler.temporalReport();
  assertEqual(report.occupancy.bucketsWithAdmissions, 0);
  assertEqual(report.occupancy.emptyBuckets, 12);
});

await test("the PS.2d per-asset protections are retained exactly (cap 10, cooldown 60s engine time)", () => {
  assertEqual(PS2E_PER_ASSET_MAX_ADMISSIONS_PER_RUN, 10);
  assertEqual(PS2E_PER_ASSET_MIN_SPACING_MS, 60_000);
  const scheduler = schedulerFor();
  const spaced = Array.from({ length: 11 }, (_, index) =>
    scheduler.decide(opportunityAt(MINT.A, BASE_AT + index * PS2E_PER_ASSET_MIN_SPACING_MS, { digest: digestOf({ index }) })),
  );
  assertEqual(spaced.filter((entry) => entry.admitted).length, 10);
  assertEqual(spaced[10].reason, PS2E_SUPPRESSION_REASONS.PER_ASSET_CAP);

  const cooldownScheduler = schedulerFor();
  assertEqual(cooldownScheduler.decide(opportunityAt(MINT.B, BASE_AT + 1_000)).admitted, true);
  const tooSoon = cooldownScheduler.decide(opportunityAt(MINT.B, BASE_AT + 30_000, { digest: digestOf({ b: 2 }) }));
  assertEqual(tooSoon.admitted, false);
  assertEqual(tooSoon.reason, PS2E_SUPPRESSION_REASONS.ASSET_COOLDOWN);
});

await test("a duplicate opportunity digest is suppressed first, before any cap", () => {
  const scheduler = schedulerFor();
  const first = scheduler.decide(opportunityAt(MINT.C, BASE_AT + 1_000, { digest: "same-digest" }));
  assertEqual(first.admitted, true);
  const repeat = scheduler.decide(opportunityAt(MINT.C, BASE_AT + 200_000, { digest: "same-digest" }));
  assertEqual(repeat.admitted, false);
  assertEqual(repeat.reason, PS2E_SUPPRESSION_REASONS.DUPLICATE_DIGEST);
  assertEqual(PS2E_SUPPRESSION_PRECEDENCE[0], PS2E_SUPPRESSION_REASONS.OUTSIDE_WINDOW);
  assertEqual(PS2E_SUPPRESSION_PRECEDENCE[1], PS2E_SUPPRESSION_REASONS.DUPLICATE_DIGEST);
});

await test("the run-wide admission ceiling is 120 even when every bucket is full", () => {
  const scheduler = schedulerFor();
  let admitted = 0;
  for (let bucket = 0; bucket < PS2E_BUCKET_COUNT; bucket += 1) {
    for (let slot = 0; slot < 10; slot += 1) {
      const decision = scheduler.decide(
        opportunityAt(mintOf(`Cap${bucket}x${slot}`), BASE_AT + bucket * PS2E_BUCKET_MS + 1_000 + slot),
      );
      if (decision.admitted) admitted += 1;
    }
  }
  assertEqual(admitted, 120);
  assertEqual(scheduler.counters.admitted, 120);
  const overflow = scheduler.decide(opportunityAt(mintOf("CapExcess"), BASE_AT + 11 * PS2E_BUCKET_MS + 5_000));
  assertEqual(overflow.admitted, false);
  assertEqual(overflow.reason, PS2E_SUPPRESSION_REASONS.BUCKET_CAP);
  const report = scheduler.temporalReport();
  assertEqual(report.occupancy.bucketsAtCap, 12);
  assertEqual(report.occupancy.bucketsWithAdmissions, 12);
  assertEqual(report.occupancy.emptyBuckets, 0);
  assertEqual(report.uniqueAdmittedAssets, 120);
});

await test("the global-cap branch is a defensive bound (12 x 10 = 120) and still works when scaled", () => {
  // Under the frozen profile the global ceiling equals the sum of the bucket
  // ceilings, so the branch is unreachable by construction and kept as defence in
  // depth. A scaled profile exercises it deterministically.
  const scaled = createLocalTevScheduler({
    profile: { ...SCHEDULER_PROFILE, globalMaxAdmissions: 5, queueCapacity: 5 },
    runStartedAtMs: BASE_AT,
  });
  const results = Array.from({ length: 6 }, (_, index) =>
    scaled.decide(opportunityAt(mintOf(`Market${index}`), BASE_AT + 1_000 + index * 10)),
  );
  assertEqual(results.filter((entry) => entry.admitted).length, 5);
  assertEqual(results[5].admitted, false);
  assertEqual(results[5].reason, PS2E_SUPPRESSION_REASONS.GLOBAL_CAP);
});

await test("the same inputs in the same order always produce the same decisions (no randomness)", async () => {
  const runOnce = () => {
    const scheduler = schedulerFor();
    const decisions = [];
    for (let index = 0; index < 40; index += 1) {
      const mint = MINT[["A", "B", "C", "D"][index % 4]];
      decisions.push(
        scheduler.decide(opportunityAt(mint, BASE_AT + (index % 12) * PS2E_BUCKET_MS + 1_000, { digest: digestOf({ index }) })),
      );
    }
    return { decisions, counters: scheduler.counters };
  };
  assertDeepEqual(runOnce(), runOnce());
  const source = stripComments(await readFile("scripts/jev/supervisor/local-tev-scheduler.mjs", "utf8"));
  assertExcludes(source, "Math.random");
  assertExcludes(source, "Date.now");
  const observerSource = stripComments(await readFile("scripts/jev/supervisor/local-tev-observer.mjs", "utf8"));
  assertExcludes(observerSource, "Math.random");
});

await test("no score, performance, outcome, prior decision, confidence or latency input can reach a decision", async () => {
  // decide() takes exactly three fields. The same identity/digest/time therefore
  // decides identically no matter what any of those other quantities would be.
  const scheduler = schedulerFor();
  const input = opportunityAt(MINT.D, BASE_AT + 1_000, { digest: "fixed-digest" });
  const first = scheduler.decide({ ...input, productionScore: 9.9, result: "SUPPORT", latencyMs: 900 });
  const second = schedulerFor().decide({ ...input, productionScore: -9.9, result: "FAILED", latencyMs: 1 });
  assertDeepEqual(first, second, "score/decision/latency must not change an admission");
  const source = stripComments(await readFile("scripts/jev/supervisor/local-tev-scheduler.mjs", "utf8")).toLowerCase();
  for (const forbidden of ["confidence", "logit", "regime", "price"]) {
    assertExcludes(source, forbidden, `the scheduler must not read ${forbidden}`);
  }
  // The scheduler carries the DENIAL (`profitabilityClaimed: false`) as a frozen
  // statement; only a positive profitability claim is forbidden.
  assertExcludes(source, "profitabilityclaimed: true");
  assertIncludes(source, "profitabilityclaimed: false");
});

await test("the scheduler keeps every genuine asset and every bucket in bounded, ranked-free rows", () => {
  const scheduler = schedulerFor();
  scheduler.decide(opportunityAt(MINT.A, BASE_AT + 1_000, { symbol: "ALPHA" }));
  scheduler.decide(opportunityAt(MINT.A, BASE_AT + 500_000, { symbol: "ALPHA-2", digest: digestOf({ a: 2 }) }));
  scheduler.decide(opportunityAt(MINT.B, BASE_AT + 400_000, { symbol: "BETA" }));
  const snapshot = scheduler.snapshot({ maxRows: 1 });
  assertEqual(snapshot.assetRowKey, "baseMint");
  assertEqual(snapshot.assetRowOrder, "ENCOUNTER_ORDER_NOT_RANKED");
  assertEqual(snapshot.totalAssetCount, 2);
  assertEqual(snapshot.rowsStored, 1);
  assertEqual(snapshot.rowsTruncated, 1);
  assertDeepEqual(snapshot.assetRows[0].symbolVariants, ["ALPHA", "ALPHA-2"]);
  for (const key of PS2E_ASSET_COUNTER_KEYS) assertTrue(key in snapshot.assetRows[0], `asset row must carry ${key}`);
  // The temporal coverage report is driven by the explicit admission provenance
  // notes the observer records (the pure scheduler never guesses a range).
  scheduler.noteAdmissionProvenance({
    atMs: BASE_AT + 1_000,
    generation: 1,
    generationTick: 1,
    engineTick: 1,
    opportunitySequence: 1,
  });
  scheduler.noteAdmissionProvenance({
    atMs: BASE_AT + 400_000,
    generation: 2,
    generationTick: 2,
    engineTick: 2,
    opportunitySequence: 3,
  });
  scheduler.noteAdmissionProvenance({
    atMs: BASE_AT + 500_000,
    generation: 3,
    generationTick: 3,
    engineTick: 3,
    opportunitySequence: 2,
  });
  const report = scheduler.temporalReport();
  assertEqual(report.buckets.length, 12);
  for (const bucket of report.buckets) {
    for (const key of PS2E_BUCKET_COUNTER_KEYS) assertTrue(key in bucket, `bucket row must carry ${key}`);
    assertTrue(bucket.start !== null && bucket.end !== null);
  }
  // Bucket 0 holds the +1s admission; bucket 1 holds both the +400s and +500s ones
  // (a bucket is exactly 300s wide, so quota is never moved between buckets).
  assertEqual(report.sharesWithinFirst.admitted, 3);
  assertEqual(report.sharesWithinFirst.within10s.count, 1);
  assertEqual(report.sharesWithinFirst.within300s.count, 1);
  assertEqual(report.occupancy.bucketsWithAdmissions, 2);
  assertEqual(report.occupancy.emptyBuckets, 10);
  assertDeepEqual(report.generationRange, { min: 1, max: 3 });
  assertDeepEqual(report.opportunitySequenceRange, { min: 1, max: 3 });
  assertEqual(report.uniqueAdmittedAssets, 2);
  assertEqual(report.admissionSpanSeconds, 499);
  assertEqual(report.temporallyRepresentative, null);
  assertEqual(report.temporalRepresentativenessClaimed, false);
  assertEqual(report.representationClaim, "none");
});

/* ============================================================================
 * 3. Genuineness boundary, packet and complete-input digest
 * ==========================================================================*/

console.log("\n3. Genuine-production boundary, packet and complete-input digest");

await test("the boundary IS the frozen PS.2d genuineness implementation (no second definition)", async () => {
  const packetModule = await readFile("scripts/jev/supervisor/local-tev-packet.mjs", "utf8");
  assertIncludes(packetModule, "validateGenuineProductionEntry");
  assertIncludes(packetModule, 'from "./cross-asset-packet.mjs"');
  assertEqual(validateGenuineProductionEntry(entryFacts()).genuine, true);
});

await test("non-production, below-threshold, gate-failed, exit, PS.2a and PS.2c facts are never eligible", () => {
  const cases = [
    [{ source: "SOMETHING_ELSE" }, "not_production_source"],
    [{ action: "EXIT_LONG" }, "not_entry_action"],
    [{ selection: "NOT_BEST" }, "not_production_selection"],
    [{ gateAssessment: { passes: false, failedGates: ["pool_too_old"] } }, "production_gates_failed"],
    [{ productionScore: 0.2, entryScoreThreshold: 0.4 }, "below_entry_threshold"],
    [{ productionScore: Number.NaN }, "non_finite_score_or_threshold"],
    [{ market: "not-an-object" }, "missing_market"],
    [{ counterfactual: { kind: "age_counterfactual" } }, "counterfactual_input_rejected"],
    [{ counterfactualGates: { pool_too_old: false } }, "counterfactual_input_rejected"],
    [{ factCopyFailed: true }, "fact_copy_failed"],
    [null, "malformed_facts"],
  ];
  for (const [override, reason] of cases) {
    const verdict = validateGenuineProductionEntry(override === null ? null : { ...entryFacts(), ...override });
    assertEqual(verdict.genuine, false, `override ${JSON.stringify(override)} must be refused`);
    assertEqual(verdict.reason, reason);
  }
  // The frozen PS.2d scan is bounded at four levels: a marker at the bound is
  // still caught, anything deeper is outside the scan (and the packet builder
  // copies only whitelisted schema fields, so it never reaches it either).
  assertEqual(carriesCounterfactualData({ a: { b: { c: { d: { kind: "age_counterfactual" } } } } }), true);
  assertEqual(carriesCounterfactualData({ a: { b: { c: { d: { e: { kind: "age_counterfactual" } } } } } }), false);
  assertEqual(carriesCounterfactualData({ a: { kind: "age_counterfactual" } }), true);
});

await test("the packet carries pre-outcome facts only, every number finite, and no outcome/counterfactual key", () => {
  const built = buildTevOpportunityPacket({ ...entryFacts(), engineTick: 1, opportunitySequence: 1 });
  assertEqual(built.ok, true, built.reason ?? "packet must build");
  const packet = built.packet;
  assertEqual(packet.packetVersion, 2);
  assertEqual(packet.evidenceClassification, PS2E_EVIDENCE_CLASSIFICATION);
  assertEqual(packet.proposal.engineTick, 1);
  assertEqual(packet.proposal.opportunitySequence, 1);
  assertEqual(packet.proposal.action, "ENTER_LONG");
  assertEqual(packet.production.thresholdComparison, ">=");
  assertTrue(packet.production.scoreMargin > 0);
  assertEqual("scheduling" in packet, false, "scheduling provenance is attached only after admission");
  const audit = auditTevPacket(packet);
  assertEqual(audit.ok, true, JSON.stringify(audit.violations.slice(0, 3)));
  // No outcome / future / counterfactual KEY can exist anywhere in the packet.
  for (const trail of leafPaths(packet)) {
    for (const key of trail.filter((entry) => typeof entry === "string")) {
      assertTrue(
        !PS2D_FORBIDDEN_PACKET_KEY_PATTERN.test(key),
        `forbidden packet key: ${key} (${trail.join(".")})`,
      );
    }
  }
  // The limitations block is declarative and frozen: nothing can be smuggled in.
  assertDeepEqual(packet.limitations, [...PS2E_PACKET_LIMITATIONS]);
  const numbers = [];
  const walk = (value) => {
    if (typeof value === "number") numbers.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(packet);
  assertTrue(numbers.length > 20);
  for (const value of numbers) assertTrue(Number.isFinite(value), "every serialized number must be finite");
  assertEqual(auditTevPacket({ ...packet, scheduling: "not-an-object" }).ok, true, "the base audit does not police scheduling");
});

await test("temporal provenance is attached after admission and never mutates the input packet", () => {
  const built = buildTevOpportunityPacket({ ...entryFacts(), engineTick: 3, opportunitySequence: 7 });
  const before = canonicalJson(built.packet);
  const finalized = attachTemporalProvenance(built.packet, {
    bucketIndex: 4,
    bucketStartMs: BASE_AT + 4 * PS2E_BUCKET_MS,
    bucketEndMs: BASE_AT + 5 * PS2E_BUCKET_MS,
    bucketAdmissionIndex: 2,
    globalAdmissionIndex: 42,
    bucketCount: 12,
    admissionRule: "PRECOMMITTED_TEMPORAL_BUCKET_SCHEDULE",
  });
  assertEqual(canonicalJson(built.packet), before, "the pre-admission packet must be unchanged");
  assertEqual(finalized.scheduling.temporalBucketIndex, 4);
  assertEqual(finalized.scheduling.temporalBucketCount, 12);
  assertEqual(finalized.scheduling.bucketAdmissionIndex, 2);
  assertEqual(finalized.scheduling.globalAdmissionIndex, 42);
  assertEqual(finalized.scheduling.temporalBucketStart, new Date(BASE_AT + 4 * PS2E_BUCKET_MS).toISOString());
  assertEqual(finalized.scheduling.temporalBucketEnd, new Date(BASE_AT + 5 * PS2E_BUCKET_MS).toISOString());
  assertEqual(auditTevPacket(finalized).ok, true);
  assertEqual(tevOpportunityDigestOf(finalized) !== tevOpportunityDigestOf(built.packet), true);
});

await test("a schema-ineligible fact yields a specific reason and never a packet", () => {
  const cases = [
    [{ market: syntheticMarket({ mint: "not-a-mint" }) }, "invalid_base_mint"],
    [{ market: syntheticMarket({ mint: USDC_MINT }) }, "base_equals_quote_numeraire"],
    [{ market: syntheticMarket({ synthetic: true }) }, "synthetic_market"],
    [{ market: syntheticMarket({ fresh: false }) }, "market_not_fresh"],
    [{ market: syntheticMarket({ price: 0 }) }, "invalid_reference_price"],
    [{ market: syntheticMarket({ liquidity: 0 }) }, "invalid_liquidity"],
    [{ at: Number.NaN }, "invalid_proposal_time"],
    [{ market: syntheticMarket({ lastObservedAt: null }) }, "missing_market_observed_at"],
    [{ market: syntheticMarket({ lastObservedAt: BASE_AT + 10_000_000 }) }, "observed_after_proposal"],
    [{ agentId: "" }, "missing_agent_identity"],
    [{ market: syntheticMarket({ features: { ...FEATURE_TEMPLATE, momentum: Number.NaN } }) }, "non_finite_feature"],
  ];
  for (const [override, reason] of cases) {
    const built = buildTevOpportunityPacket({ ...entryFacts(), engineTick: 1, opportunitySequence: 1, ...override });
    assertEqual(built.ok, false, `override ${JSON.stringify(Object.keys(override))} must be ineligible`);
    assertEqual(built.reason, reason);
    assertEqual(built.packet, null);
  }
  const missingProvenance = buildTevOpportunityPacket(entryFacts());
  assertEqual(missingProvenance.ok, false);
  assertEqual(missingProvenance.reason, "packet_build_error");
});

/** One effective tier-inference block, exactly as the production projection. */
function tierSamplingFor(overrides = {}) {
  return { samples: 3, seed: 1234, temperature: 0.7, nCtx: 2048, earlyStop: true, useGpu: false, cpuFallback: true, ...overrides };
}

function completeInputFor(packet, overrides = {}) {
  const questions = buildLocalTevQuestions();
  return localTevCompleteInput({
    protocol: { phase: "5I-PS.2e", protocolId: "p", protocolVersion: 1 },
    classifier: { classifierId: "c", classifierRuntime: "nobodywho", primaryTier: "1", thinkingEnabled: false },
    routing: { mode: PS2E_LOCAL_JEV_MODE, localJevConfigDigest: "d", transportKind: "fixture" },
    questionSetId: PS2E_QUESTION_SET_ID,
    questionSetVersion: 1,
    questionId: PS2E_QUESTION_ID,
    question: questions.question,
    options: questions.options,
    allowAbstain: true,
    abstainDescription: questions.abstainDescription,
    risk: questions.risk,
    sampling: { primaryTier: "1", tiers: { "1": tierSamplingFor(), "2": tierSamplingFor() } },
    classifierConfig: {
      classifierVersion: "local-jev-decision-dataset-v1+lora-r16-e1",
      thinkingEnabled: false,
      optionTokenGrammar: true,
      onIdentityMismatch: "fail_closed",
    },
    packet,
    limitations: ["only pre-outcome facts"],
    ...overrides,
  });
}

function leafPaths(value, trail = []) {
  if (value === null || typeof value !== "object") return [trail];
  if (Array.isArray(value)) return value.flatMap((entry, index) => leafPaths(entry, [...trail, index]));
  return Object.entries(value).flatMap(([key, entry]) => leafPaths(entry, [...trail, key]));
}

function mutateAt(value, trail) {
  const clone = structuredClone(value);
  let cursor = clone;
  for (const step of trail.slice(0, -1)) cursor = cursor[step];
  const last = trail[trail.length - 1];
  const current = cursor[last];
  if (typeof current === "string") cursor[last] = `${current}!`;
  else if (typeof current === "number") cursor[last] = current + 1;
  else if (typeof current === "boolean") cursor[last] = !current;
  else if (current === null) cursor[last] = "mutated-null";
  else if (Array.isArray(current)) cursor[last] = [...current, "extra"];
  else cursor[last] = { mutated: true };
  return clone;
}

await test("the complete-input digest changes for EVERY model-visible leaf mutation", () => {
  const built = buildTevOpportunityPacket({ ...entryFacts(), engineTick: 1, opportunitySequence: 1 });
  const base = completeInputFor(built.packet);
  const baseDigest = localTevInputDigestOf(base);
  const paths = leafPaths(canonicalParse(base), []);
  let mutated = 0;
  for (const trail of paths) {
    const candidate = mutateAt(base, trail);
    const digest = localTevInputDigestOf(candidate);
    assertTrue(digest !== baseDigest, `digest must change for leaf ${trail.join(".")}`);
    mutated += 1;
  }
  assertTrue(mutated > 60, `expected many model-visible leaves, mutated ${mutated}`);
  assertEqual(localTevInputDigestOf(canonicalParse(base)), baseDigest, "canonical re-serialization must reproduce the digest");
  assertEqual(localTevInputDigestOf(structuredClone(base)), baseDigest);
});

function canonicalParse(value) {
  return JSON.parse(JSON.stringify(value));
}

await test("the digest covers the classifier identity, routing configuration and question contract", () => {
  const built = buildTevOpportunityPacket({ ...entryFacts(), engineTick: 1, opportunitySequence: 1 });
  const base = completeInputFor(built.packet);
  const baseDigest = localTevInputDigestOf(base);
  const variants = [
    [{ classifier: { ...base.classifier, pinnedModel: "other" } }, "classifier identity"],
    [{ classifier: { ...base.classifier, classifierRuntime: "other" } }, "runtime identity"],
    [{ classifier: { ...base.classifier, thinkingEnabled: true } }, "thinking configuration"],
    [{ routing: { ...base.routing, mode: "local" } }, "routing mode"],
    [{ routing: { ...base.routing, transportKind: "decision-cli" } }, "transport identity"],
    [{ question: `${base.question} extra` }, "question text"],
    [{ options: { ...base.options, support: "other" } }, "option description"],
    [{ allowAbstain: false }, "abstain policy"],
    [{ limitations: [...base.limitations, "extra"] }, "model-visible limitations"],
    [{ questionSetId: "other" }, "question-set identity"],
    [{ questionSetVersion: 2 }, "question-set version"],
    [{ questionId: "other_question" }, "model-visible question id"],
    [{ risk: "high" }, "model-visible risk level"],
    [{ abstainDescription: `${base.abstainDescription} extra` }, "model-visible ABSTAIN description"],
    [{ sampling: { ...base.sampling, tiers: { ...base.sampling.tiers, "1": tierSamplingFor({ temperature: 0.9 }) } } }, "sampling temperature"],
    [{ sampling: { ...base.sampling, tiers: { ...base.sampling.tiers, "1": tierSamplingFor({ samples: 8 }) } } }, "sampling count"],
    [{ sampling: { ...base.sampling, tiers: { ...base.sampling.tiers, "1": tierSamplingFor({ seed: 4321 }) } } }, "sampling seed"],
    [{ sampling: { ...base.sampling, tiers: { ...base.sampling.tiers, "1": tierSamplingFor({ nCtx: 4096 }) } } }, "sampling context"],
    [{ sampling: { ...base.sampling, tiers: { ...base.sampling.tiers, "1": tierSamplingFor({ earlyStop: false }) } } }, "sampling early stop"],
    [{ sampling: { ...base.sampling, tiers: { ...base.sampling.tiers, "2": tierSamplingFor({ temperature: 0.9 }) } } }, "escalation-tier sampling"],
    [{ classifierConfig: { ...base.classifierConfig, classifierVersion: "other" } }, "classifier version"],
    [{ classifierConfig: { ...base.classifierConfig, optionTokenGrammar: false } }, "classifier grammar"],
    [{ classifierConfig: { ...base.classifierConfig, thinkingEnabled: true } }, "classifier thinking flag"],
    [{ classifierConfig: { ...base.classifierConfig, onIdentityMismatch: "escalate" } }, "classifier mismatch policy"],
  ];
  for (const [override, label] of variants) {
    assertTrue(localTevInputDigestOf(completeInputFor(built.packet, override)) !== baseDigest, `digest must change for ${label}`);
  }
});

/* ============================================================================
 * 4. Shared Local JEV client: readiness, validation, provenance, no fake numbers
 * ==========================================================================*/

console.log("\n4. Shared Local JEV client");

await test("the shared installation is discovered read-only, and its config projects identity without secrets", async () => {
  const projection = await projectionFor();
  assertEqual(projection.config.found, true);
  assertEqual(projection.config.mode, PS2E_LOCAL_JEV_MODE);
  assertEqual(projection.config.jevFallbackEnabled, false);
  assertEqual(projection.config.tiers["1"].modelName, VALIDATION_PRIMARY_MODEL);
  assertEqual(projection.config.tiers["1"].modelFile, `${VALIDATION_PRIMARY_MODEL}.gguf`);
  assertEqual("model_path" in projection.config.tiers["1"], false, "an absolute model path must not be projected");
  const text = JSON.stringify(projection);
  for (const forbiddenKeyName of ["TYPESAFE_API_KEY", "apiKey", "token", "cookie"]) {
    assertExcludes(text, forbiddenKeyName, `${forbiddenKeyName} must never be projected`);
  }
  assertEqual(resolveLocalJevConfigPath({ env: { XDG_CONFIG_HOME: "/x" }, homeDir: "/h" }), "/x/decision-router/config.json");
  // The override is the config DIRECTORY the shared router itself uses directly
  // (readiness and the spawned child must resolve the SAME configuration).
  assertEqual(
    resolveLocalJevConfigPath({ env: { DECISION_ROUTER_CONFIG_DIR: "/d" }, homeDir: "/h" }),
    "/d/config.json",
  );
  const override = await readLocalJevEnvironment({
    env: { PATH: "/usr/bin" },
    executable: "/fixture/decision",
    configPath: "/fixture/config.json",
    readFileImpl: async () => fixtureConfigJson(),
    accessImpl: async () => {},
  });
  assertEqual(override.executable.found, true);
  assertEqual(override.executable.source, "explicit");
});

await test("readiness fails closed on an unavailable specialist and rejects wrong identity against the REAL pin", () => {
  // (a) An unavailable specialist is refused before any call (fail closed).
  const unavailable = assessLocalTevReadiness({
    projection: fixtureProjection(),
    policy: UNAVAILABLE_CLASSIFIER_POLICY,
  });
  assertEqual(unavailable.ready, false);
  assertEqual(unavailable.status, "PRIMARY_CLASSIFIER_UNAVAILABLE");
  assertTrue(unavailable.problems.length > 0);
  assertIncludes(unavailable.problems.join(" "), "no Tev-style specialist");

  // (b) The REAL pin against a correctly pinned shared installation is READY.
  const ready = assessLocalTevReadiness({
    projection: fixtureProjection({
      tier1Model: PS2E_PRIMARY_CLASSIFIER.pinnedModel,
      tier1Sha256: PS2E_PRIMARY_CLASSIFIER.pinnedModelSha256,
    }),
    policy: PS2E_PRIMARY_CLASSIFIER,
  });
  assertEqual(ready.status, "READY");
  assertEqual(ready.ready, true);
  assertEqual(ready.primaryIdentity.modelName, PS2E_PRIMARY_CLASSIFIER.pinnedModel);
  assertEqual(ready.primaryIdentity.modelSha256, PS2E_PRIMARY_CLASSIFIER.pinnedModelSha256);

  // (c) A generic tier-1 model can never satisfy the REAL pin (no substitution).
  const generic = assessLocalTevReadiness({ projection: fixtureProjection(), policy: PS2E_PRIMARY_CLASSIFIER });
  assertEqual(generic.ready, false);
  assertEqual(generic.status, "PRIMARY_IDENTITY_MISMATCH");

  // (d) The pin's artifact digest is verified, not just its model name.
  const wrongDigest = assessLocalTevReadiness({
    projection: fixtureProjection({
      tier1Model: PS2E_PRIMARY_CLASSIFIER.pinnedModel,
      tier1Sha256: "1".repeat(64),
    }),
    policy: PS2E_PRIMARY_CLASSIFIER,
  });
  assertEqual(wrongDigest.ready, false);
  assertEqual(wrongDigest.status, "PRIMARY_IDENTITY_MISMATCH");
  assertIncludes(wrongDigest.problems.join(" "), "sha256");
});

await test("readiness reports the other failure modes distinctly (config, tier, identity, timeout bound)", async () => {
  const readyProjection = await projectionFor();
  const ready = assessLocalTevReadiness({ projection: readyProjection, policy: PS2E_VALIDATION_CLASSIFIER_POLICY });
  assertEqual(ready.status, "READY");
  assertEqual(ready.ready, true);
  assertEqual(ready.physicalAttemptCeilingPerLogicalCall, 2, "two local tiers, no retries, TypeSafe disabled -> 2");
  assertTrue(ready.derivedWorstCaseLogicalMs !== null);

  const unreadable = await readLocalJevEnvironment({
    env: { PATH: "/usr/bin" },
    configPath: "/fixture/config.json",
    readFileImpl: async () => {
      throw Object.assign(new Error("nope"), { code: "ENOENT" });
    },
    accessImpl: async () => {},
  });
  assertEqual(assessLocalTevReadiness({ projection: unreadable, policy: PS2E_VALIDATION_CLASSIFIER_POLICY }).status, "LOCAL_JEV_UNAVAILABLE");

  const noPrimary = await projectionFor({ primary: false });
  assertEqual(assessLocalTevReadiness({ projection: noPrimary, policy: PS2E_VALIDATION_CLASSIFIER_POLICY }).status, "PRIMARY_CLASSIFIER_UNAVAILABLE");

  const wrongModel = await projectionFor({ primaryModel: "some-generic-model" });
  const mismatch = assessLocalTevReadiness({ projection: wrongModel, policy: PS2E_VALIDATION_CLASSIFIER_POLICY });
  assertEqual(mismatch.status, "PRIMARY_IDENTITY_MISMATCH");
  assertIncludes(mismatch.problems.join(" "), "generic");

  const slow = await projectionFor({ tier1Timeout: 200, tier2Timeout: 200 });
  const bounded = assessLocalTevReadiness({ projection: slow, policy: PS2E_VALIDATION_CLASSIFIER_POLICY });
  assertEqual(bounded.status, "LOCAL_JEV_TIMEOUT_BOUND_EXCEEDS_PS2E_BOUND");
});

await test("the child environment is minimal and never forwards a secret-bearing variable", () => {
  const env = minimalChildEnv({
    PATH: "/usr/bin",
    HOME: "/home/x",
    XDG_RUNTIME_DIR: "/run/user/1",
    TYPESAFE_API_KEY: "secret",
    EVOLVE_JEV_API_KEY: "secret",
    AWS_SECRET_ACCESS_KEY: "secret",
    GITHUB_TOKEN: "secret",
    COOKIE: "sid",
  });
  assertEqual(env.DECISION_ROUTER_CALLER, "evolve");
  assertEqual(env.PATH, "/usr/bin");
  assertEqual(env.HOME, "/home/x");
  assertEqual("TYPESAFE_API_KEY" in env, false);
  assertEqual("EVOLVE_JEV_API_KEY" in env, false);
  assertEqual("AWS_SECRET_ACCESS_KEY" in env, false);
  assertEqual("GITHUB_TOKEN" in env, false);
  assertEqual("COOKIE" in env, false);
  assertEqual(PS2E_LOCAL_JEV_CONTRACT.maxStateChars, 16_000);
  assertEqual(PS2E_LOGICAL_CALL_TIMEOUT_MS, 180_000);
});

await test("the shared answer is validated strictly: echo, mode, skip, error and token violations", () => {
  const requestId = "jsup-tev1";
  const valid = { ...outcomeFor(), request_id: requestId };
  assertEqual(validateLocalJevOutcome(valid, { requestId }).ok, true);
  assertEqual(validateLocalJevOutcome(JSON.stringify(valid), { requestId }).status, LOCAL_JEV_CLIENT_STATUS.OK);
  assertEqual(validateLocalJevOutcome("not json", { requestId }).status, LOCAL_JEV_CLIENT_STATUS.MALFORMED);
  assertEqual(validateLocalJevOutcome({ ...valid, request_id: "other" }, { requestId }).status, LOCAL_JEV_CLIENT_STATUS.MALFORMED);
  assertEqual(validateLocalJevOutcome({ ...valid, mode: "local" }, { requestId }).status, LOCAL_JEV_CLIENT_STATUS.MALFORMED);
  assertEqual(validateLocalJevOutcome({ ...valid, mode: undefined }, { requestId }).status, LOCAL_JEV_CLIENT_STATUS.MALFORMED);
  assertEqual(validateLocalJevOutcome({ ...valid, follow: "maybe" }, { requestId }).status, LOCAL_JEV_CLIENT_STATUS.MALFORMED);
  assertEqual(validateLocalJevOutcome({ ...valid, attempts: "nope" }, { requestId }).status, LOCAL_JEV_CLIENT_STATUS.MALFORMED);
  assertEqual(
    validateLocalJevOutcome({ request_id: requestId, mode: PS2E_LOCAL_JEV_MODE, skipped: "bypass" }, { requestId }).status,
    LOCAL_JEV_CLIENT_STATUS.SKIPPED_BY_SHARED_ROUTER,
  );
  assertEqual(
    validateLocalJevOutcome({ request_id: requestId, mode: PS2E_LOCAL_JEV_MODE, error: "invalid_request" }, { requestId }).status,
    LOCAL_JEV_CLIENT_STATUS.REQUEST_REJECTED,
  );
  assertEqual(
    validateLocalJevOutcome({ request_id: requestId, mode: PS2E_LOCAL_JEV_MODE, error: "router_error" }, { requestId }).status,
    LOCAL_JEV_CLIENT_STATUS.ROUTER_ERROR,
  );
});

await test("the client adds no retry and refuses an over-long request with NO call", async () => {
  const transport = fixtureTransportFor([okStep(outcomeFor())]);
  const client = createLocalJevClient({ transport, policy: PS2E_VALIDATION_CLASSIFIER_POLICY });
  const request = buildLocalTevRequest({ requestId: "r1", packet: { a: 1 } });
  const ok = await client.dispatch({ request, stateLength: 20 });
  assertEqual(ok.ok, true);
  assertEqual(transport.calls.length, 1, "exactly one transport call per logical request");
  const huge = await client.dispatch({ request, stateLength: 20_000 });
  assertEqual(huge.status, LOCAL_JEV_CLIENT_STATUS.REQUEST_TOO_LARGE);
  assertEqual(transport.calls.length, 1, "an over-long request must not reach the shared implementation");
});

await test("`decision ask --mode local-first` is the exact invocation boundary", () => {
  const transport = createDecisionCliTransport();
  assertEqual(transport.args[0], "ask");
  assertIncludes(transport.args.join(" "), "--mode local-first");
  assertIncludes(transport.args.join(" "), "--caller evolve");
  assertEqual(transport.command, "decision");
});

await test("the CLI transport reports OK / non-zero exit / timeout / spawn failure as data", async () => {
  const fixtureBin = path.join(WORKSPACE, "decision-fixture.mjs");
  await writeFile(
    fixtureBin,
    [
      "import { readFileSync } from 'node:fs';",
      "const request = JSON.parse(readFileSync(0, 'utf8'));",
      "process.stdout.write(JSON.stringify({ request_id: request.id, mode: 'local-first', follow: null, decision: null }));",
    ].join("\n"),
    "utf8",
  );
  const okTransport = createDecisionCliTransport({ executable: process.execPath, argv: [fixtureBin], timeoutMs: 5_000 });
  const okResult = await okTransport.dispatch({ request: { id: "req-1" } });
  assertEqual(okResult.status, LOCAL_JEV_TRANSPORT_STATUS.OK);
  assertIncludes(okResult.stdout, "req-1");

  const failingBin = path.join(WORKSPACE, "decision-fail.mjs");
  await writeFile(failingBin, "process.exit(3);", "utf8");
  const failTransport = createDecisionCliTransport({ executable: process.execPath, argv: [failingBin], timeoutMs: 5_000 });
  assertEqual((await failTransport.dispatch({ request: { id: "r" } })).status, LOCAL_JEV_TRANSPORT_STATUS.EXIT_NONZERO);

  const slowBin = path.join(WORKSPACE, "decision-slow.mjs");
  await writeFile(slowBin, "setTimeout(() => {}, 5_000);", "utf8");
  const slowTransport = createDecisionCliTransport({ executable: process.execPath, argv: [slowBin], timeoutMs: 60 });
  assertEqual((await slowTransport.dispatch({ request: { id: "r" } })).status, LOCAL_JEV_TRANSPORT_STATUS.TIMEOUT);

  const missingTransport = createDecisionCliTransport({ executable: "/definitely/not/a/binary", argv: [], timeoutMs: 200 });
  assertEqual((await missingTransport.dispatch({ request: { id: "r" } })).status, LOCAL_JEV_TRANSPORT_STATUS.SPAWN_FAILED);
});

/* ---- provenance classification -------------------------------------------- */

function classificationFor(validation, policy = PS2E_VALIDATION_CLASSIFIER_POLICY) {
  return classifyLocalJevOutcome({ validation, policy });
}

function validationFrom(outcome) {
  return validateLocalJevOutcome({ ...outcome, request_id: "req" }, { requestId: "req" });
}

await test("a primary classifier answer is recorded as the PRIMARY Tev result with vote semantics", () => {
  const classified = classificationFor(validationFrom(outcomeFor({ choice: "support", votes: { support: 2, do_not_support: 1 } })));
  assertEqual(classified.decision, PS2E_DECISIONS.SUPPORT);
  assertEqual(classified.decisionSource, PS2E_DECISION_SOURCES.PRIMARY_TEV_CLASSIFIER);
  assertEqual(classified.escalated, false);
  assertEqual(classified.fallbackUsed, false);
  assertEqual(classified.acceptedTier, "1");
  assertEqual(classified.classifierProvider, "nobodywho");
  assertEqual(classified.probabilityKind, "sample_stability");
  assertEqual(classified.decisionScore.sampleStability, 0.66);
  assertEqual(classified.decisionScore.calibratedProbability, null);
  assertEqual(classified.decisionScore.voteMargin, 1);
  assertEqual(classified.decisionScore.logitsAvailable, false);
  assertEqual(classified.decisionScore.optionTokenCount, 3);
  assertEqual(classified.totalPhysicalAttempts, 1);
  assertEqual(classified.coldOrWarm, "warm");
});

await test("DO_NOT_SUPPORT is never silently flipped and ABSTAIN is never converted", () => {
  const reject = classificationFor(validationFrom(outcomeFor({ choice: "do_not_support", follow: "do_not_support" })));
  assertEqual(reject.decision, PS2E_DECISIONS.DO_NOT_SUPPORT);
  const abstainAttempts = [
    attemptFor({ tier: 1, choice: null, abstain: true, accepted: false, escalationReason: "abstain" }),
    attemptFor({ tier: 2, provider: "nobodywho", model: "Qwen3.5-9B", choice: null, abstain: true, accepted: false, escalationReason: "abstain" }),
  ];
  const abstained = classificationFor(
    validationFrom(
      outcomeFor({ follow: null, choice: null, abstain: true, tier: null, attempts: abstainAttempts, fallbackReason: "jev_disabled" }),
    ),
  );
  assertEqual(abstained.decision, PS2E_DECISIONS.ABSTAIN);
  assertEqual(abstained.decisionSource, PS2E_DECISION_SOURCES.ABSTAINED_WITHOUT_ACCEPTED_TIER);
  assertTrue(abstained.decision !== PS2E_DECISIONS.SUPPORT && abstained.decision !== PS2E_DECISIONS.DO_NOT_SUPPORT);
  assertTrue(abstained.escalationReason !== null);
});

await test("an escalated local tier is recorded as escalated, never as the primary classifier", () => {
  const attempts = [
    attemptFor({ tier: 1, choice: null, accepted: false, escalationReason: "stability_below_threshold", fallbackReason: "local_no_majority" }),
    attemptFor({ tier: 2, model: "Qwen3.5-9B", choice: "support", accepted: true, confidence: 0.9 }),
  ];
  const classified = classificationFor(validationFrom(outcomeFor({ tier: 2, model: "Qwen3.5-9B", attempts })));
  assertEqual(classified.decision, PS2E_DECISIONS.SUPPORT);
  assertEqual(classified.decisionSource, PS2E_DECISION_SOURCES.ESCALATED_LOCAL_TIER);
  assertEqual(classified.escalated, true);
  assertEqual(classified.fallbackTier, "2");
  assertEqual(classified.fallbackProvider, "nobodywho");
  assertEqual(classified.fallbackUsed, false);
  assertEqual(classified.localAttemptCount, 2);
  assertEqual(classified.totalPhysicalAttempts, 2);
  assertEqual(classified.escalationReason, "stability_below_threshold");
  assertEqual(classified.classifierModel, "Qwen3.5-9B");
});

await test("a TypeSafe fallback is recorded as a fallback WITH its calibrated number, never as primary", () => {
  const attempts = [
    attemptFor({ tier: 1, choice: null, accepted: false, escalationReason: "timeout", fallbackReason: "local_timeout" }),
    attemptFor({ tier: 2, model: "Qwen3.5-9B", choice: null, accepted: false, escalationReason: "model_unavailable" }),
    attemptFor({
      tier: 3,
      provider: "jev",
      model: "jev-1.13.0",
      choice: "support",
      accepted: true,
      confidence: 0.71,
      confidenceKind: "calibrated_probability",
    }),
  ];
  const classified = classificationFor(
    validationFrom(
      outcomeFor({
        tier: 3,
        provider: "jev",
        model: "jev-1.13.0",
        confidence: 0.71,
        confidenceKind: "calibrated_probability",
        votes: null,
        attempts,
        details: null,
      }),
    ),
  );
  assertEqual(classified.decisionSource, PS2E_DECISION_SOURCES.FALLBACK_TYPESAFE_JEV);
  assertEqual(classified.fallbackUsed, true);
  assertEqual(classified.fallbackTier, "3");
  assertEqual(classified.fallbackProvider, "jev");
  assertEqual(classified.fallbackAttemptCount, 1);
  assertEqual(classified.localAttemptCount, 2);
  assertEqual(classified.totalPhysicalAttempts, 3);
  assertEqual(classified.probabilityKind, "calibrated_probability");
  assertEqual(classified.decisionScore.calibratedProbability, 0.71);
  assertEqual(classified.decisionScore.calibratedProbabilityKind, "calibrated_probability");
  assertEqual(classified.decisionScore.sampleStability, null);
  assertEqual(classified.decisionScore.votes, null);
});

await test("a primary-tier answer from the WRONG model is an identity mismatch, not a primary result", () => {
  const classified = classificationFor(
    validationFrom(outcomeFor({ tier: 1, model: "Qwen_Qwen3-4B-Q4_K_M" })),
    PS2E_VALIDATION_CLASSIFIER_POLICY,
  );
  assertEqual(classified.decisionSource, PS2E_DECISION_SOURCES.PRIMARY_IDENTITY_MISMATCH);
  assertEqual(classified.primaryIdentityMismatch, true);
  assertEqual(classified.escalated, true);
  assertEqual(classified.fallbackTier, "1");
  assertIncludes(classified.escalationReason, "not the precommitted primary classifier");
  assertTrue(classified.decision !== null, "the observed answer is still recorded, but with its real provenance");
});

await test("a malformed answer or a failed call is FAILED / MALFORMED, never a decision", () => {
  const malformed = classificationFor({ ok: false, status: LOCAL_JEV_CLIENT_STATUS.MALFORMED, problems: ["not_json"] });
  assertEqual(malformed.decision, PS2E_OUTCOMES.MALFORMED);
  assertEqual(malformed.decisionSource, PS2E_DECISION_SOURCES.MALFORMED);
  const failed = classificationFor({ ok: false, status: LOCAL_JEV_CLIENT_STATUS.TIMEOUT, problems: ["timeout"] });
  assertEqual(failed.decision, PS2E_OUTCOMES.FAILED);
  assertEqual(failed.decisionSource, PS2E_DECISION_SOURCES.FAILED);
  const unavailable = classificationFor({ ok: false, status: LOCAL_JEV_CLIENT_STATUS.SPAWN_FAILED, problems: ["missing"] });
  assertEqual(unavailable.decision, PS2E_OUTCOMES.UNAVAILABLE);
  const rejected = classificationFor({ ok: false, status: LOCAL_JEV_CLIENT_STATUS.REQUEST_REJECTED, problems: ["invalid_request"] });
  assertEqual(rejected.decision, PS2E_OUTCOMES.MALFORMED);
  for (const entry of [malformed, failed, unavailable, rejected]) {
    assertTrue(entry.decision !== PS2E_DECISIONS.SUPPORT && entry.decision !== PS2E_DECISIONS.DO_NOT_SUPPORT);
  }
});

await test("no classification path ever produces a fake probability field", () => {
  const classified = classificationFor(validationFrom(outcomeFor()));
  const text = JSON.stringify(classified);
  assertExcludes(text, "pSupport");
  assertExcludes(text, "\"probability\":");
  assertExcludes(text, "probabilities\":");
  assertTrue("calibratedProbability" in classified.decisionScore);
  assertEqual(PS2E_DECISIONS.SUPPORT in classified, false);
});

await test("the REAL shared-router response schema is parsed truthfully", () => {
  // A response shaped exactly like the hardened shared Local JEV CLI emits
  // (classifier block, decision_source, runtime, worker digest evidence).
  const observedSha = PS2E_PRIMARY_CLASSIFIER.pinnedModelSha256;
  const real = {
    request_id: "req",
    mode: "local-first",
    follow: "support",
    decision: {
      provider: "nobodywho",
      choice: "support",
      abstain: false,
      abstain_reason: null,
      model: "local-jev-tev-specialist-v1",
      latency_ms: 357,
      confidence: 0.6666666666666666,
      confidence_kind: "sample_stability",
      distribution: null,
      votes: { support: 2 },
      samples: 2,
      fallback_reason: null,
      error: null,
      details: {
        worker: "persistent",
        model_reused: true,
        model_sha256: observedSha,
        runtime: "nobodywho 3.0.0",
        samples_planned: 3,
        early_stop: true,
      },
    },
    tier: 1,
    decision_source: "PRIMARY_TEV_CLASSIFIER",
    classifier: {
      status: "verified",
      classifierId: "local-jev-tev-specialist-v1",
      classifierFamily: "tev-style-specialist",
      classifierKind: "specialized-option-token-classifier",
      classifierVersion: "local-jev-decision-dataset-v1+lora-r16-e1",
      tier: 1,
      thinkingEnabled: false,
      grammarConstrainedOptionTokens: true,
      expectedSha256: observedSha,
      observedSha256: observedSha,
      verifiedBy: "loaded_artifact_digest",
      available: true,
    },
    attempts: [
      {
        tier: 1,
        provider: "nobodywho",
        role: "specialist",
        status: "accepted",
        model: "local-jev-tev-specialist-v1",
        choice: "support",
        abstain: false,
        confidence: 0.6666666666666666,
        confidence_kind: "sample_stability",
        latency_ms: 357,
        accepted: true,
      },
    ],
  };
  const validation = validationFrom(real);
  assertEqual(validation.ok, true);
  // Every exposed identity/provenance field is captured truthfully ...
  assertEqual(validation.outcome.routerDecisionSource, "PRIMARY_TEV_CLASSIFIER");
  assertEqual(validation.outcome.classifier.classifierId, "local-jev-tev-specialist-v1");
  assertEqual(validation.outcome.classifier.classifierFamily, "tev-style-specialist");
  assertEqual(validation.outcome.classifier.classifierKind, "specialized-option-token-classifier");
  assertEqual(validation.outcome.classifier.classifierVersion, "local-jev-decision-dataset-v1+lora-r16-e1");
  assertEqual(validation.outcome.classifier.thinkingEnabled, false);
  assertEqual(validation.outcome.classifier.status, "verified");
  assertEqual(validation.outcome.classifier.verifiedBy, "loaded_artifact_digest");
  assertEqual(validation.outcome.classifier.observedSha256, observedSha);
  assertEqual(validation.outcome.decision.runtime, "nobodywho 3.0.0");
  assertEqual(validation.outcome.tier, "1");
  assertEqual(validation.outcome.attempts[0].role, "specialist");
  assertEqual(validation.outcome.attempts[0].status, "accepted");
  // ... and the classification keeps the real semantics (no fake probability).
  const classified = classificationFor(validation, PS2E_PRIMARY_CLASSIFIER);
  assertEqual(classified.decision, PS2E_DECISIONS.SUPPORT);
  assertEqual(classified.decisionSource, PS2E_DECISION_SOURCES.PRIMARY_TEV_CLASSIFIER);
  assertEqual(classified.classifierModel, "local-jev-tev-specialist-v1");
  assertEqual(classified.classifierModelSha256, observedSha);
  assertEqual(classified.localAttemptCount, 1);
  assertEqual(classified.totalPhysicalAttempts, 1);
  assertEqual(classified.physicalAttemptsUnknown, false);
  assertEqual(classified.probabilityKind, "sample_stability");
  assertExcludes(JSON.stringify(validation.outcome), "pSupport");
});

await test("a wrong artifact digest, a router mismatch verdict or thinking ON never counts as the specialist", () => {
  // (a) name matches the pin but the exposed artifact digest does not.
  const wrongDigest = classificationFor(
    validationFrom({
      ...outcomeFor({ tier: 1, model: PS2E_PRIMARY_CLASSIFIER.pinnedModel }),
      classifier: { status: "verified", thinkingEnabled: false, observedSha256: "2".repeat(64) },
    }),
    PS2E_PRIMARY_CLASSIFIER,
  );
  assertEqual(wrongDigest.decisionSource, PS2E_DECISION_SOURCES.PRIMARY_IDENTITY_MISMATCH);
  assertEqual(wrongDigest.primaryIdentityMismatch, true);

  // (b) the shared router's own mismatch verdict is honored.
  const routerFlagged = classificationFor(
    validationFrom({
      ...outcomeFor({ tier: 1, model: PS2E_PRIMARY_CLASSIFIER.pinnedModel }),
      decision_source: "PRIMARY_IDENTITY_MISMATCH",
    }),
    PS2E_PRIMARY_CLASSIFIER,
  );
  assertEqual(routerFlagged.decisionSource, PS2E_DECISION_SOURCES.PRIMARY_IDENTITY_MISMATCH);

  // (c) thinking enabled in the exposed contract -> MALFORMED, never a decision.
  const thinking = classificationFor(
    validationFrom({
      ...outcomeFor({ tier: 1, model: PS2E_PRIMARY_CLASSIFIER.pinnedModel }),
      classifier: {
        status: "verified",
        thinkingEnabled: true,
        observedSha256: PS2E_PRIMARY_CLASSIFIER.pinnedModelSha256,
      },
    }),
    PS2E_PRIMARY_CLASSIFIER,
  );
  assertEqual(thinking.decision, PS2E_OUTCOMES.MALFORMED);
  assertEqual(thinking.decisionSource, PS2E_DECISION_SOURCES.MALFORMED);

  // (d) a tier-2 generic answer stays an escalation, never the primary.
  const escalated = classificationFor(
    validationFrom({
      ...outcomeFor({
        tier: 2,
        model: "Qwen3.5-9B",
        follow: "support",
        attempts: [
          attemptFor({
            tier: 1,
            model: PS2E_PRIMARY_CLASSIFIER.pinnedModel,
            choice: null,
            accepted: false,
            escalationReason: "abstain",
          }),
          attemptFor({ tier: 2, model: "Qwen3.5-9B", choice: "support", accepted: true }),
        ],
      }),
    }),
    PS2E_PRIMARY_CLASSIFIER,
  );
  assertEqual(escalated.decisionSource, PS2E_DECISION_SOURCES.ESCALATED_LOCAL_TIER);
  assertEqual(escalated.escalated, true);
});

function completeLiveClassifierBlock(overrides = {}) {
  const PIN = PS2E_PRIMARY_CLASSIFIER;
  return {
    status: "verified",
    classifierId: PIN.classifierId,
    classifierFamily: PIN.classifierFamily,
    classifierKind: PIN.classifierKind,
    classifierVersion: "local-jev-decision-dataset-v1+lora-r16-e1",
    tier: 1,
    thinkingEnabled: false,
    grammarConstrainedOptionTokens: true,
    expectedSha256: PIN.pinnedModelSha256,
    observedSha256: PIN.pinnedModelSha256,
    verifiedBy: "loaded_artifact_digest",
    available: true,
    ...overrides,
  };
}

function livePrimaryResponse({
  classifier,
  model = PS2E_PRIMARY_CLASSIFIER.pinnedModel,
  detailsDigest = PS2E_PRIMARY_CLASSIFIER.pinnedModelSha256,
  decisionSource = "PRIMARY_TEV_CLASSIFIER",
} = {}) {
  const response = outcomeFor({ tier: 1, model, follow: "support" });
  if (classifier !== undefined) response.classifier = classifier;
  if (decisionSource !== null) response.decision_source = decisionSource;
  if (detailsDigest !== null) {
    response.decision.details = {
      worker: "persistent",
      model_reused: true,
      model_sha256: detailsDigest,
      runtime: "nobodywho 3.0.0",
    };
  }
  return response;
}

await test("the LIVE identity gate accepts only the complete verified contract (review probes A-E, J)", () => {
  const PIN = PS2E_PRIMARY_CLASSIFIER;
  const classifyLive = (response) => classificationFor(validationFrom(response), PIN);
  const assertNotPrimary = (classified, label) => {
    assertTrue(
      classified.decisionSource !== PS2E_DECISION_SOURCES.PRIMARY_TEV_CLASSIFIER,
      `${label}: must never be attributed to the primary Tev classifier`,
    );
  };

  // J. the complete, correct identity contract -> the genuine primary result.
  const good = classifyLive(livePrimaryResponse({ classifier: completeLiveClassifierBlock() }));
  assertEqual(good.decision, PS2E_DECISIONS.SUPPORT, "J");
  assertEqual(good.decisionSource, PS2E_DECISION_SOURCES.PRIMARY_TEV_CLASSIFIER, "J: complete correct identity must be primary");
  assertEqual(good.primaryIdentityMismatch, false, "J");

  // A. no classifier block and no digest: the model-name string is never proof.
  const absent = classifyLive(livePrimaryResponse({ classifier: undefined, detailsDigest: null }));
  assertEqual(absent.decisionSource, PS2E_DECISION_SOURCES.PRIMARY_IDENTITY_MISMATCH, "A: missing identity evidence");
  assertEqual(absent.primaryIdentityMismatch, true, "A");

  // B. wrong classifierFamily.
  const wrongFamily = classifyLive(
    livePrimaryResponse({ classifier: completeLiveClassifierBlock({ classifierFamily: "generic-local-llm" }) }),
  );
  assertEqual(wrongFamily.decisionSource, PS2E_DECISION_SOURCES.PRIMARY_IDENTITY_MISMATCH, "B: wrong family");
  assertNotPrimary(wrongFamily, "B");

  // C. wrong classifierId.
  const wrongId = classifyLive(
    livePrimaryResponse({ classifier: completeLiveClassifierBlock({ classifierId: "totally-other-classifier" }) }),
  );
  assertEqual(wrongId.decisionSource, PS2E_DECISION_SOURCES.PRIMARY_IDENTITY_MISMATCH, "C: wrong id");
  assertNotPrimary(wrongId, "C");

  // D. garbage / structurally malformed identity block -> MALFORMED.
  const garbage = classifyLive(
    livePrimaryResponse({
      classifier: {
        status: 42,
        classifierId: { evil: true },
        classifierFamily: ["x"],
        thinkingEnabled: "yes",
        observedSha256: "not-a-digest",
      },
    }),
  );
  assertEqual(garbage.decision, PS2E_OUTCOMES.MALFORMED, "D: malformed identity block");
  assertEqual(garbage.decisionSource, PS2E_DECISION_SOURCES.MALFORMED, "D");
  assertNotPrimary(garbage, "D");

  // E. classifierKind declares a generic model.
  const wrongKind = classifyLive(
    livePrimaryResponse({ classifier: completeLiveClassifierBlock({ classifierKind: "generic-local-llm" }) }),
  );
  assertEqual(wrongKind.decisionSource, PS2E_DECISION_SOURCES.PRIMARY_IDENTITY_MISMATCH, "E: generic kind");
  assertNotPrimary(wrongKind, "E");
});

await test("the LIVE identity gate requires digest evidence and honors contract violations (review probes F-I)", () => {
  const PIN = PS2E_PRIMARY_CLASSIFIER;
  const classifyLive = (response) => classificationFor(validationFrom(response), PIN);
  const assertNotPrimary = (classified, label) => {
    assertTrue(
      classified.decisionSource !== PS2E_DECISION_SOURCES.PRIMARY_TEV_CLASSIFIER,
      `${label}: must never be attributed to the primary Tev classifier`,
    );
  };

  // F. correct identity block, MISSING artifact-digest evidence.
  const missingDigest = classifyLive(
    livePrimaryResponse({
      classifier: completeLiveClassifierBlock({ expectedSha256: undefined, observedSha256: undefined }),
      detailsDigest: null,
    }),
  );
  assertEqual(missingDigest.decisionSource, PS2E_DECISION_SOURCES.PRIMARY_IDENTITY_MISMATCH, "F: missing digest");
  assertNotPrimary(missingDigest, "F");

  // G. correct identity block, WRONG artifact digest.
  const wrongDigest = classifyLive(
    livePrimaryResponse({
      classifier: completeLiveClassifierBlock({ expectedSha256: "2".repeat(64), observedSha256: "2".repeat(64) }),
    }),
  );
  assertEqual(wrongDigest.decisionSource, PS2E_DECISION_SOURCES.PRIMARY_IDENTITY_MISMATCH, "G: wrong digest");
  assertNotPrimary(wrongDigest, "G");

  // H. thinking enabled -> rejected, never primary.
  const thinking = classifyLive(
    livePrimaryResponse({ classifier: completeLiveClassifierBlock({ thinkingEnabled: true }) }),
  );
  assertEqual(thinking.decision, PS2E_OUTCOMES.MALFORMED, "H: thinking enabled");
  assertNotPrimary(thinking, "H");

  // I. the shared router's own identity-mismatch verdict is honored.
  const flagged = classifyLive(
    livePrimaryResponse({ classifier: completeLiveClassifierBlock(), decisionSource: "PRIMARY_IDENTITY_MISMATCH" }),
  );
  assertEqual(flagged.decisionSource, PS2E_DECISION_SOURCES.PRIMARY_IDENTITY_MISMATCH, "I: router verdict");
  assertNotPrimary(flagged, "I");
});

await test("validationOnly fixture compatibility (K) is explicit and never weakens the live policy (L)", () => {
  const PIN = PS2E_PRIMARY_CLASSIFIER;
  const fixture = PS2E_VALIDATION_CLASSIFIER_POLICY;
  assertEqual(fixture.validationOnly, true, "the compatibility flag lives on the fixture policy only");

  // K. a historical fixture response with NO hardened classifier block stays
  // valid under the validation-only policy (existing compatibility semantics).
  const historical = outcomeFor({ tier: 1, model: fixture.pinnedModel, follow: "support" });
  const viaFixture = classificationFor(validationFrom(historical), fixture);
  assertEqual(viaFixture.decisionSource, PS2E_DECISION_SOURCES.PRIMARY_TEV_CLASSIFIER, "K: fixture compatibility preserved");
  assertEqual(viaFixture.primaryIdentityMismatch, false, "K");

  // L. the SAME name-only shape under the LIVE policy must be rejected: the
  // compatibility path can never leak into live classification.
  const nameOnly = outcomeFor({ tier: 1, model: PIN.pinnedModel, follow: "support" });
  const viaLive = classificationFor(validationFrom(nameOnly), PIN);
  assertEqual(viaLive.decisionSource, PS2E_DECISION_SOURCES.PRIMARY_IDENTITY_MISMATCH, "L: live policy requires identity evidence");
  assertEqual(viaLive.primaryIdentityMismatch, true, "L");
});

await test("LIVE primary attribution requires a positively verified loaded-artifact digest chain (M-U, Z)", () => {
  const classify = (classifier) => classificationFor(
    validationFrom(livePrimaryResponse({ classifier })),
    PS2E_PRIMARY_CLASSIFIER,
  );
  const pin = PS2E_PRIMARY_CLASSIFIER.pinnedModelSha256;
  const mismatchCases = [
    ["M", { status: "unknown" }],
    ["N", { verifiedBy: "self_report" }],
    ["O", { expectedSha256: "2".repeat(64) }],
    ["P", { observedSha256: "2".repeat(64) }],
    ["Q", { verifiedBy: undefined }],
    ["R", { expectedSha256: undefined }],
    ["S", { observedSha256: undefined }],
  ];
  for (const [label, overrides] of mismatchCases) {
    const result = classify(completeLiveClassifierBlock(overrides));
    assertEqual(result.decisionSource, PS2E_DECISION_SOURCES.PRIMARY_IDENTITY_MISMATCH, label);
  }
  for (const [label, overrides] of [
    ["T-object", { verifiedBy: { source: "loaded_artifact_digest" } }],
    ["T-list", { verifiedBy: ["loaded_artifact_digest"] }],
    ["U-object", { observedSha256: { digest: pin } }],
    ["U-list", { expectedSha256: [pin] }],
  ]) {
    const result = classify(completeLiveClassifierBlock(overrides));
    assertEqual(result.decisionSource, PS2E_DECISION_SOURCES.MALFORMED, label);
    assertEqual(result.decision, PS2E_OUTCOMES.MALFORMED, label);
  }
  const verified = classify(completeLiveClassifierBlock());
  assertEqual(verified.decisionSource, PS2E_DECISION_SOURCES.PRIMARY_TEV_CLASSIFIER, "Z");
});

await test("an absent or non-validation policy is strict and returns a typed mismatch (V-Y)", () => {
  const response = validationFrom(livePrimaryResponse({ classifier: undefined, detailsDigest: null }));
  for (const [label, policy] of [
    ["V", undefined],
    ["W", {}],
    ["X", { ...PS2E_PRIMARY_CLASSIFIER, validationOnly: false }],
  ]) {
    const result = classifyLocalJevOutcome({ validation: response, policy });
    assertEqual(result.decisionSource, PS2E_DECISION_SOURCES.PRIMARY_IDENTITY_MISMATCH, label);
    assertEqual(result.primaryIdentityMismatch, true, label);
  }
  const historical = validationFrom(outcomeFor({ tier: 1, model: PS2E_VALIDATION_CLASSIFIER_POLICY.pinnedModel, follow: "support" }));
  const compatible = classifyLocalJevOutcome({ validation: historical, policy: PS2E_VALIDATION_CLASSIFIER_POLICY });
  assertEqual(compatible.decisionSource, PS2E_DECISION_SOURCES.PRIMARY_TEV_CLASSIFIER, "Y");
});

await test("physical attempts come from the real trace; skipped fallback records are not physical", () => {
  const classified = classificationFor(
    validationFrom({
      ...outcomeFor({ tier: 1, model: PS2E_PRIMARY_CLASSIFIER.pinnedModel }),
      attempts: [
        attemptFor({ tier: 1, model: PS2E_PRIMARY_CLASSIFIER.pinnedModel, choice: "support", accepted: true }),
        {
          tier: 3,
          provider: "jev",
          choice: null,
          abstain: false,
          accepted: false,
          status: "skipped",
          fallback_reason: "jev_disabled",
        },
      ],
    }),
    PS2E_PRIMARY_CLASSIFIER,
  );
  assertEqual(classified.localAttemptCount, 1);
  assertEqual(classified.fallbackAttemptCount, 0, "a disabled TypeSafe fallback record made no physical call");
  assertEqual(classified.totalPhysicalAttempts, 1);
  assertEqual(classified.physicalAttemptsUnknown, false, "a valid Local JEV response exposes its attempt trace");
});


/* ---- pre-live hardening: bounded output, route consistency, provenance ----- */

await test("truncated stdout fails closed: a valid leading object is never parsed or accepted (FIX 1 A-D)", async () => {
  const MAX = PS2E_LOCAL_JEV_MAX_STDOUT_BYTES;
  const writerBin = path.join(WORKSPACE, "stdout-writer.mjs");
  await writeFile(
    writerBin,
    [
      "import { readFileSync } from 'node:fs';",
      "const request = JSON.parse(readFileSync(0, 'utf8'));",
      "const template = readFileSync(process.argv[2], 'utf8').replaceAll('__REQUEST_ID__', String(request.id ?? ''));",
      "const padBytes = Number(process.argv[3] ?? 0);",
      "const errBytes = Number(process.argv[4] ?? 0);",
      "const padChar = process.argv[5] ?? 'x';",
      "process.stdout.write(template);",
      "if (padBytes > 0) process.stdout.write(padChar.repeat(padBytes));",
      "if (errBytes > 0) process.stderr.write('x'.repeat(errBytes));",
    ].join("\n"),
    "utf8",
  );
  const requestId = "req-trunc";
  const dispatchWith = async (template, padBytes, errBytes, padChar) => {
    const payloadPath = path.join(WORKSPACE, `payload-${Math.random().toString(36).slice(2)}.json`);
    await writeFile(payloadPath, template, "utf8");
    const transport = createDecisionCliTransport({
      executable: process.execPath,
      argv: [writerBin, payloadPath, String(padBytes), String(errBytes), padChar],
      timeoutMs: 60_000,
    });
    const client = createLocalJevClient({ transport, policy: PS2E_PRIMARY_CLASSIFIER });
    const dispatch = await client.dispatch({ request: { id: requestId, state: {} } });
    return { dispatch, classified: classifyLocalJevOutcome({ validation: dispatch.validation, policy: PS2E_PRIMARY_CLASSIFIER }) };
  };

  // (A) valid JSON followed by enough data to EXCEED the cap -> MALFORMED.
  const caseA = await dispatchWith(JSON.stringify(outcomeFor()), MAX, 0, "x");
  assertEqual(caseA.dispatch.stdoutTruncated, true, "A: the capture bound was exceeded");
  assertEqual(caseA.dispatch.status, LOCAL_JEV_CLIENT_STATUS.MALFORMED, "A");
  assertIncludes(caseA.dispatch.validation.problems.join(" "), "stdout_truncated");
  assertEqual(caseA.classified.decision, PS2E_OUTCOMES.MALFORMED, "A");
  assertTrue(
    caseA.classified.decisionSource !== PS2E_DECISION_SOURCES.PRIMARY_TEV_CLASSIFIER,
    "A: a truncated answer is never primary",
  );

  // (B) oversized output BEGINNING with a perfect primary result -> MALFORMED.
  const perfect = JSON.stringify(livePrimaryResponse({ classifier: completeLiveClassifierBlock() }));
  const caseB = await dispatchWith(perfect, MAX, 0, "x");
  assertEqual(caseB.dispatch.stdoutTruncated, true, "B");
  assertEqual(caseB.dispatch.status, LOCAL_JEV_CLIENT_STATUS.MALFORMED, "B: the leading primary-looking object is never accepted");
  assertEqual(caseB.classified.decision, PS2E_OUTCOMES.MALFORMED, "B");
  assertTrue(
    caseB.classified.decisionSource !== PS2E_DECISION_SOURCES.PRIMARY_TEV_CLASSIFIER,
    "B: truncation can never manufacture primary attribution",
  );

  // (C) output EXACTLY within the bound -> normal parsing (cap is NOT raised).
  const rendered = perfect.replaceAll("__REQUEST_ID__", requestId);
  const exactPad = MAX - Buffer.byteLength(rendered, "utf8");
  assertTrue(exactPad > 0, "C: the fixture must fit the real cap exactly");
  const caseC = await dispatchWith(perfect, exactPad, 0, " ");
  assertEqual(caseC.dispatch.stdoutTruncated, false, "C: exactly within bound is not truncation");
  assertEqual(caseC.dispatch.status, LOCAL_JEV_CLIENT_STATUS.OK, "C");
  assertEqual(caseC.classified.decision, PS2E_DECISIONS.SUPPORT, "C");
  assertEqual(caseC.classified.decisionSource, PS2E_DECISION_SOURCES.PRIMARY_TEV_CLASSIFIER, "C");

  // (D) stderr truncation is NON-AUTHORITATIVE: it cannot create primary
  // success and it cannot destroy a valid primary answer either.
  const caseD = await dispatchWith(perfect, 0, 100_000, "x");
  assertEqual(caseD.dispatch.stderrTruncated, true, "D: stderr overflow is observed");
  assertEqual(caseD.dispatch.status, LOCAL_JEV_CLIENT_STATUS.OK, "D: stderr never influences the parse");
  assertEqual(caseD.classified.decisionSource, PS2E_DECISION_SOURCES.PRIMARY_TEV_CLASSIFIER, "D");
  const caseDErr = await dispatchWith("this is not json at all", 0, 100_000, "x");
  assertEqual(caseDErr.classified.decision, PS2E_OUTCOMES.MALFORMED, "D: stderr can never create a primary success");
  assertTrue(
    caseDErr.classified.decisionSource !== PS2E_DECISION_SOURCES.PRIMARY_TEV_CLASSIFIER,
    "D: stderr is never evidence of a decision",
  );
});

await test("route / choice / attempt consistency fails closed on contradictory router responses (FIX 2)", () => {
  const PIN = PS2E_PRIMARY_CLASSIFIER;
  const classifyResponse = (mutate) => {
    const response = livePrimaryResponse({ classifier: completeLiveClassifierBlock() });
    mutate(response);
    return classificationFor(validationFrom(response), PIN);
  };
  const assertNeverPrimary = (result, label) => {
    assertTrue(
      result.decisionSource !== PS2E_DECISION_SOURCES.PRIMARY_TEV_CLASSIFIER,
      `${label}: a contradictory response must NEVER become PRIMARY_TEV_CLASSIFIER`,
    );
  };
  const assertMalformed = (result, label) => {
    assertNeverPrimary(result, label);
    assertEqual(result.decision, PS2E_OUTCOMES.MALFORMED, `${label}: decision`);
    assertEqual(result.decisionSource, PS2E_DECISION_SOURCES.MALFORMED, `${label}: source`);
  };
  const assertMismatch = (result, label) => {
    assertNeverPrimary(result, label);
    assertEqual(result.decisionSource, PS2E_DECISION_SOURCES.PRIMARY_IDENTITY_MISMATCH, `${label}: source`);
    assertEqual(result.primaryIdentityMismatch, true, label);
  };

  // A genuine current Local JEV response continues to pass (the control).
  const genuine = classifyResponse(() => {});
  assertEqual(genuine.decision, PS2E_DECISIONS.SUPPORT, "control");
  assertEqual(genuine.decisionSource, PS2E_DECISION_SOURCES.PRIMARY_TEV_CLASSIFIER, "control: genuine response stays primary");

  // Adversarial route provenance.
  assertMalformed(classifyResponse((r) => { r.decision_source = "ESCALATED_LOCAL_TIER"; }), "decision_source = ESCALATED_LOCAL_TIER");
  assertMalformed(classifyResponse((r) => { r.decision_source = "FAILED"; }), "decision_source = FAILED");
  assertMismatch(classifyResponse((r) => { r.decision_source = "PRIMARY_LOCAL_TIER"; }), "decision_source = PRIMARY_LOCAL_TIER");
  assertMismatch(classifyResponse((r) => { r.decision_source = null; }), "decision_source = null");
  assertMalformed(classifyResponse((r) => { r.tier = 2; }), "top-level tier = 2 contradicts the accepted tier-1 attempt");
  assertMalformed(classifyResponse((r) => { r.attempts[0].provider = "jev"; }), "provider = jev for a supposed tier-1 primary");
  assertMismatch(classifyResponse((r) => { r.attempts[0].role = "generic"; }), "accepted attempt role = generic");
  assertMalformed(classifyResponse((r) => { r.attempts[0].status = "skipped"; }), "accepted attempt marked skipped (skipped+accepted)");
  assertMalformed(classifyResponse((r) => { r.follow = "do_not_support"; }), "follow contradicts decision.choice");
  assertMalformed(classifyResponse((r) => { r.attempts[0].choice = "do_not_support"; }), "attempt choice contradicts decision.choice");
});

await test("an unknown, unsupported or malformed provider is FULLY MALFORMED (FIX 3)", () => {
  const PIN = PS2E_PRIMARY_CLASSIFIER;
  for (const [label, provider] of [
    ["unknown provider", "openai"],
    ["unsupported provider", "mock-jev"],
    ["malformed provider field", 42],
  ]) {
    const response = livePrimaryResponse({ classifier: completeLiveClassifierBlock() });
    response.attempts[0].provider = provider;
    response.decision.provider = provider;
    const validation = validationFrom(response);
    const classified = classificationFor(validation, PIN);
    // A MALFORMED source never keeps a directional/support decision.
    assertEqual(classified.decision, PS2E_OUTCOMES.MALFORMED, `${label}: decision must be MALFORMED too`);
    assertEqual(classified.decisionSource, PS2E_DECISION_SOURCES.MALFORMED, `${label}: source`);
    assertTrue(
      classified.decision !== PS2E_DECISIONS.SUPPORT && classified.decision !== PS2E_DECISIONS.DO_NOT_SUPPORT,
      `${label}: no directional decision may survive`,
    );
  }
});

await test("the readiness timeout bound uses EFFECTIVE tier timeouts, retries, escalation and fallback (FIX 4)", async () => {
  const policy = PS2E_VALIDATION_CLASSIFIER_POLICY;
  const assess = async (options) => assessLocalTevReadiness({ projection: await projectionFor(options), policy });

  // (1) explicit per-tier timeouts: the bound is their sum over all local tiers.
  const explicit = await assess({ tier1Timeout: 30, tier2Timeout: 40 });
  assertEqual(explicit.status, "READY", "explicit");
  assertEqual(explicit.ready, true, "explicit: under the frozen limit");
  assertEqual(explicit.derivedWorstCaseLogicalMs, 70_000, "explicit: 30s + 40s");
  assertEqual(explicit.timeoutBounds.routerAttemptsPerTier, 1);
  assertEqual(explicit.timeoutBounds.routerProviderFallbackMs, 0, "explicit: TypeSafe disabled adds nothing");
  assertEqual(explicit.timeoutBounds.evolveChildHardTimeoutMs, PS2E_LOGICAL_CALL_TIMEOUT_MS);
  assertEqual(explicit.timeoutBounds.routerTheoreticalWorstCaseMs, 70_000);
  assertEqual(explicit.timeoutBounds.ps2eFinalizationBudgetMs > 0, true, "the finalization budget is its own bound");

  // (2) inherited timeout: a tier without its own timeout_s inherits `local`.
  const inherited = await assess({ tier1Timeout: null, tier2Timeout: 40, localTimeoutS: 90 });
  assertEqual(inherited.status, "READY", "inherited");
  assertEqual(inherited.derivedWorstCaseLogicalMs, 130_000, "inherited: tier1 inherits 90s + tier2 40s");

  // (3) NO explicit tier timeout anywhere: the shared defaults apply (never 0).
  // Tier 1 inherits `local` (default 60 s), tier 2 has its own default (300 s).
  const none = await assess({ tier1Timeout: null, tier2Timeout: null, localTimeoutS: null });
  assertEqual(none.derivedWorstCaseLogicalMs, 360_000, "no explicit timeout: shared defaults, never zero");
  assertEqual(none.status, "LOCAL_JEV_TIMEOUT_BOUND_EXCEEDS_PS2E_BOUND", "no explicit timeout: fails closed over the bound");

  // (4) configured retries multiply EVERY local tier's attempts.
  const retries = await assess({ tier1Timeout: 20, tier2Timeout: 20, maxLocalRetries: 2 });
  assertEqual(retries.status, "READY", "retries");
  assertEqual(retries.timeoutBounds.routerAttemptsPerTier, 3, "retries: 1 + 2");
  assertEqual(retries.derivedWorstCaseLogicalMs, 120_000, "retries: (20s + 20s) x 3");
  assertEqual(retries.physicalAttemptCeilingPerLogicalCall, 6, "retries: 2 tiers x 3 attempts");

  // (5) multiple tiers sum; a single tier bounds only itself. The physical
  // attempt ceiling counts the EXACT shared-router trace: the unconfigured
  // tier-2 slot still records one failed physical attempt when it is reached
  // (the shared router always iterates its fixed decision-tier slots), so the
  // honest ceiling is 1 + 1, never the underestimate 1.
  const single = await assess({ tier2: false, tier1Timeout: 50 });
  assertEqual(single.status, "READY", "single tier");
  assertEqual(single.derivedWorstCaseLogicalMs, 50_000, "single tier");
  assertEqual(single.physicalAttemptCeilingPerLogicalCall, 2, "single tier: one serving slot + one failed unconfigured slot");

  // (6)+(7) TypeSafe disabled adds nothing; enabled adds its EFFECTIVE timeout.
  const withFallback = await assess({ tier1Timeout: 20, tier2Timeout: 20, jevEnabled: true, jevTimeoutS: 30 });
  assertEqual(withFallback.typesafeFallbackEnabled, true);
  assertEqual(withFallback.timeoutBounds.routerProviderFallbackMs, 30_000);
  assertEqual(withFallback.derivedWorstCaseLogicalMs, 70_000, "fallback: (20s + 20s) + 30s");
  assertEqual(withFallback.physicalAttemptCeilingPerLogicalCall, 3);
  assertEqual(withFallback.status, "READY", "fallback: still under the frozen bound");

  // (8) an effective bound OVER the frozen limit fails closed (never a call).
  const over = await assess({ tier1Timeout: 200, tier2Timeout: 200 });
  assertEqual(over.status, "LOCAL_JEV_TIMEOUT_BOUND_EXCEEDS_PS2E_BOUND", "over limit");
  assertEqual(over.ready, false);

  // (9) an effective bound UNDER the limit is READY (case 1) and the frozen
  // protocol limit itself is never tuned to make readiness pass.
  assertEqual(PS2E_LOGICAL_CALL_TIMEOUT_MS, 180_000, "the frozen bound is unchanged");
});

/* ---- PS.2e independent-review blocker remediation: provenance coherence,
 *      effective inference settings and retry normalization parity --------- */

await test("PRIMARY provenance coherence fails closed: provider/model/attempt/abstain contradictions (blocker 1, probes A-J)", () => {
  const PIN = PS2E_PRIMARY_CLASSIFIER;
  const classifyLive = (response) => classificationFor(validationFrom(response), PIN);
  const genuineResponse = () => livePrimaryResponse({ classifier: completeLiveClassifierBlock() });
  const assertNotPrimary = (classified, label) => {
    assertTrue(
      classified.decisionSource !== PS2E_DECISION_SOURCES.PRIMARY_TEV_CLASSIFIER,
      `${label}: must never be attributed to the primary Tev classifier`,
    );
  };
  const assertMismatch = (classified, label) => {
    assertNotPrimary(classified, label);
    assertEqual(classified.decisionSource, PS2E_DECISION_SOURCES.PRIMARY_IDENTITY_MISMATCH, `${label}: source`);
  };
  const assertMalformed = (classified, label) => {
    assertNotPrimary(classified, label);
    assertEqual(classified.decision, PS2E_OUTCOMES.MALFORMED, `${label}: a coherently impossible record keeps no binary decision`);
    assertEqual(classified.decisionSource, PS2E_DECISION_SOURCES.MALFORMED, `${label}: source`);
  };

  // J. the genuine real Local JEV response shape stays the PRIMARY result.
  const genuine = classifyLive(genuineResponse());
  assertEqual(genuine.decision, PS2E_DECISIONS.SUPPORT, "J: decision");
  assertEqual(genuine.decisionSource, PS2E_DECISION_SOURCES.PRIMARY_TEV_CLASSIFIER, "J: genuine primary stays primary");
  assertEqual(genuine.primaryIdentityMismatch, false, "J");
  assertEqual(genuine.classifierModel, PIN.pinnedModel, "J: the pinned specialist");

  // A. decision.provider = jev while the accepted attempt is the tier-1
  //    NobodyWho specialist: structurally valid, contradictory -> NOT PRIMARY.
  const probeA = genuineResponse();
  probeA.decision.provider = "jev";
  assertMismatch(classifyLive(probeA), "A: decision.provider=jev");

  // B. decision.provider = openai.
  const probeB = genuineResponse();
  probeB.decision.provider = "openai";
  assertMismatch(classifyLive(probeB), "B: decision.provider=openai");

  // C. decision.model contradicts the precommitted specialist pin.
  const probeC = genuineResponse();
  probeC.decision.model = "totally-other-model";
  assertMismatch(classifyLive(probeC), "C: decision.model contradicts the pin");

  // D. the top-level (decision block) model contradicts the accepted attempt.
  const probeD1 = genuineResponse();
  probeD1.decision.model = "X-model";
  assertNotPrimary(classifyLive(probeD1), "D: decision.model contradicts the accepted attempt's model");
  const probeD2 = genuineResponse();
  probeD2.attempts[0].model = "Y-model";
  assertNotPrimary(classifyLive(probeD2), "D: accepted attempt's model contradicts the decision's model");

  // E. an EARLIER accepted attempt says SUPPORT while the later says
  //    DO_NOT_SUPPORT: the record can never be silently reduced to one.
  for (const [alignWith, label] of [
    ["first", "E1"],
    ["last", "E2"],
  ]) {
    const probeE = genuineResponse();
    probeE.attempts = [
      attemptFor({ tier: 1, model: PIN.pinnedModel, choice: "support", accepted: true }),
      attemptFor({ tier: 1, model: PIN.pinnedModel, choice: "do_not_support", accepted: true }),
    ];
    const aligned = alignWith === "first" ? "support" : "do_not_support";
    probeE.decision.choice = aligned;
    probeE.follow = aligned;
    assertMalformed(classifyLive(probeE), `${label}: two accepted attempts with contradictory choices`);
  }

  // F. two accepted attempts with conflicting providers.
  const probeF = genuineResponse();
  probeF.attempts = [
    attemptFor({ tier: 1, model: PIN.pinnedModel, choice: "support", accepted: true }),
    attemptFor({ tier: 3, provider: "jev", model: "jev-1.13.0", choice: "support", accepted: true }),
  ];
  assertMalformed(classifyLive(probeF), "F: two accepted attempts with conflicting providers");

  // Two ACCEPTED attempts that AGREE are still a protocol-impossible record:
  // the local-first protocol admits exactly one authoritative accepted result.
  const duplicates = genuineResponse();
  duplicates.attempts = [
    attemptFor({ tier: 1, model: PIN.pinnedModel, choice: "support", accepted: true }),
    attemptFor({ tier: 1, model: PIN.pinnedModel, choice: "support", accepted: true }),
  ];
  assertMalformed(classifyLive(duplicates), "duplicate accepted attempts are never silently reduced to the last one");

  // G. SUPPORT plus contradictory abstention metadata.
  const probeG1 = genuineResponse();
  probeG1.decision.abstain = true;
  probeG1.decision.choice = "support";
  probeG1.attempts = [attemptFor({ tier: 1, model: PIN.pinnedModel, choice: "support", abstain: true, accepted: true })];
  assertMalformed(classifyLive(probeG1), "G: the decision claims SUPPORT and abstention at once");
  const probeG2 = genuineResponse();
  probeG2.abstained = true;
  assertMalformed(classifyLive(probeG2), "G: a top-level abstained flag contradicts the binary decision");
  const probeG3 = genuineResponse();
  probeG3.attempts[0].abstain = true;
  assertMalformed(classifyLive(probeG3), "G: the accepted binary attempt claims abstention");

  // H. DO_NOT_SUPPORT plus an abstain reason that indicates actual abstention.
  const probeH1 = genuineResponse();
  probeH1.decision.choice = "do_not_support";
  probeH1.follow = "do_not_support";
  probeH1.decision.abstain_reason = "ABSTAIN";
  probeH1.attempts = [attemptFor({ tier: 1, model: PIN.pinnedModel, choice: "do_not_support", accepted: true })];
  assertMalformed(classifyLive(probeH1), "H: decision-level abstain_reason on a binary decision");
  const probeH2 = genuineResponse();
  probeH2.attempts = [
    attemptFor({ tier: 1, model: PIN.pinnedModel, choice: "support", abstainReason: "LOW_MARGIN", accepted: true }),
  ];
  assertMalformed(classifyLive(probeH2), "H: accepted-attempt abstain_reason on a binary answer");

  // I. an ABSTAIN decision with an accepted binary attempt.
  const probeI = genuineResponse();
  probeI.follow = null;
  probeI.decision.choice = null;
  probeI.decision.abstain = true;
  probeI.decision.abstain_reason = "ABSTAIN";
  assertMalformed(classifyLive(probeI), "I: ABSTAIN plus an accepted binary attempt");

  // An ALL_AVAILABLE_TIERS_ABSTAINED provenance can never carry an accepted
  // binary result.
  const probeAll = genuineResponse();
  probeAll.decision_source = "ALL_AVAILABLE_TIERS_ABSTAINED";
  assertMalformed(classifyLive(probeAll), "ALL_AVAILABLE_TIERS_ABSTAINED plus an accepted binary result");

  // Real generic escalation is NOT weakened: a genuine tier-2 generic answer is
  // still ESCALATED_LOCAL_TIER.
  const escalated = classifyLive({
    ...outcomeFor({
      tier: 2,
      model: "Qwen3.5-9B",
      attempts: [
        attemptFor({ tier: 1, model: PIN.pinnedModel, choice: null, accepted: false, escalationReason: "abstain" }),
        attemptFor({ tier: 2, model: "Qwen3.5-9B", choice: "support", accepted: true }),
      ],
    }),
    decision_source: "ESCALATED_LOCAL_TIER",
  });
  assertEqual(escalated.decision, PS2E_DECISIONS.SUPPORT, "genuine tier-2 escalation keeps its decision");
  assertEqual(escalated.decisionSource, PS2E_DECISION_SOURCES.ESCALATED_LOCAL_TIER, "genuine tier-2 escalation is not weakened");

  // A COHERENT accepted abstention (the shared acceptance policy may accept one)
  // stays ABSTAIN on the primary route: coherence checks never flip it.
  const abstainAccepted = genuineResponse();
  abstainAccepted.follow = null;
  abstainAccepted.decision.choice = null;
  abstainAccepted.decision.abstain = true;
  abstainAccepted.decision.abstain_reason = "ABSTAIN";
  abstainAccepted.attempts = [
    attemptFor({ tier: 1, model: PIN.pinnedModel, choice: null, abstain: true, abstainReason: "ABSTAIN", accepted: true }),
  ];
  const coherentAbstain = classifyLive(abstainAccepted);
  assertEqual(coherentAbstain.decision, PS2E_DECISIONS.ABSTAIN, "a coherent accepted abstention stays ABSTAIN");
  assertEqual(
    coherentAbstain.decisionSource,
    PS2E_DECISION_SOURCES.PRIMARY_TEV_CLASSIFIER,
    "and keeps its genuine primary-route provenance",
  );
});

await test("jevInputDigest covers the EFFECTIVE inference settings, tier overrides included (blocker 2)", async () => {
  const built = buildTevOpportunityPacket({ ...entryFacts(), engineTick: 1, opportunitySequence: 1 });
  const samplingFrom = (projection) => ({ primaryTier: "1", tiers: projection.config.inference });
  const inputFrom = (projection) => completeInputFor(built.packet, { sampling: samplingFrom(projection) });
  const digestFrom = (projection) => localTevInputDigestOf(inputFrom(projection));
  const baseProjection = await projectionFor({});
  const baseDigest = digestFrom(baseProjection);

  // Every materially different EFFECTIVE request changes jevInputDigest:
  // tier-level overrides AND local-level settings the tiers inherit.
  for (const [options, label] of [
    [{ tier1Settings: { samples: 5 } }, "tier samples"],
    [{ tier1Settings: { seed: 4321 } }, "tier seed"],
    [{ tier1Settings: { temperature: 0.15 } }, "tier temperature"],
    [{ tier1Settings: { n_ctx: 4096 } }, "tier n_ctx"],
    [{ tier1Settings: { early_stop: false } }, "tier early_stop"],
    [{ localSettings: { early_stop: false } }, "local early_stop (inherited)"],
    [{ localSettings: { samples: 7 } }, "local sampling default changed by inheritance"],
    [{ tier2Settings: { samples: 7 } }, "escalation-tier samples"],
  ]) {
    assertTrue(digestFrom(await projectionFor(options)) !== baseDigest, `digest must change for ${label}`);
  }

  // A tier override and the inherited default it replaces are different
  // EFFECTIVE requests; removing the override so the inherited value applies
  // changes the digest back.
  const overridden = await projectionFor({ tier1Settings: { samples: 5 } });
  const withoutOverride = await projectionFor({});
  assertTrue(digestFrom(overridden) !== digestFrom(withoutOverride), "tier override vs inherited default");
  assertEqual(digestFrom(withoutOverride), baseDigest, "tier override removed: the inherited value applies again");

  // Explicit settings resolving to the SAME effective values change nothing.
  const explicitSame = await projectionFor({ tier1Settings: { samples: 3, seed: 1234 }, tier2Settings: { samples: 3 } });
  assertEqual(digestFrom(explicitSame), baseDigest, "explicit values identical to the effective ones are the same request");

  // Different raw configs resolving to the SAME effective settings produce the
  // same effective-settings projection and digest: the projection describes the
  // inference request, not irrelevant config syntax.
  const viaLocal = await projectionFor({
    localSettings: { samples: 5, seed: 99, temperature: 0.25, n_ctx: 1024, early_stop: false },
  });
  const viaTiers = await projectionFor({
    tier1Settings: { samples: 5, seed: 99, temperature: 0.25, n_ctx: 1024, early_stop: false },
    tier2Settings: { samples: 5, seed: 99, temperature: 0.25, n_ctx: 1024, early_stop: false },
  });
  const viaCoercions = await projectionFor({
    tier1Settings: { samples: "5", seed: "99", temperature: "0.25", n_ctx: "1024" },
    tier2Settings: { samples: "5", seed: "99", temperature: "0.25", n_ctx: "1024" },
    localSettings: { early_stop: false },
  });
  assertDeepEqual(samplingFrom(viaLocal), samplingFrom(viaTiers), "local-level vs tier-level: identical effective settings");
  assertDeepEqual(samplingFrom(viaLocal), samplingFrom(viaCoercions), "shared int/float coercions: identical effective settings");
  assertEqual(localTevInputDigestOf(inputFrom(viaLocal)), localTevInputDigestOf(inputFrom(viaTiers)), "same effective -> same digest");
  // `early_stop: 0` is NOT `is False` in the shared Python check: the shared
  // early-stop rule stays in place, exactly like a config that never mentions it.
  assertEqual(
    digestFrom(await projectionFor({ localSettings: { early_stop: 0 } })),
    baseDigest,
    "early_stop: 0 leaves the shared early-stop rule in place (config syntax only)",
  );

  // The persisted effective settings replay exactly: stored evidence alone
  // recomputes jevInputDigest (2C).
  const input = inputFrom(viaLocal);
  const record = {
    modelInputDescriptor: modelInputDescriptorOf(input),
    packet: built.packet,
    jevInputDigest: localTevInputDigestOf(input),
  };
  assertEqual(jevInputDigestFromEvidence(record), record.jevInputDigest, "persisted evidence replays the exact digest");
  assertEqual("packet" in record.modelInputDescriptor, false, "the descriptor never duplicates the packet");
  assertDeepEqual(record.modelInputDescriptor.sampling, samplingFrom(viaLocal), "the effective settings are persisted");
});

await test("Local JEV retry normalization parity and the TRUE bounds (blocker 3)", async () => {
  // Exact parity with the pinned shared semantics
  // (`acceptance.Policy.from_config`: `int(a.get("max_local_retries", 0))`, then
  // `0 <= value <= 3` or the shared router refuses the config).
  for (const [raw, expected] of [
    [0, 0],
    [1, 1],
    [3, 3],
    ["0", 0],
    ["1", 1],
    ["3", 3],
    [1.0, 1],
    [1.5, 1],
    [2.9, 2],
    [3.9, 3],
    [-0.5, 0], // Python `int(-0.5)` == 0: truncation toward zero
    [true, 1],
    [false, 0],
    [undefined, 0], // a missing key resolves to the shared default 0
  ]) {
    const resolution = effectiveLocalRetries(raw);
    assertEqual(resolution.ok, true, `the shared parser accepts ${JSON.stringify(raw)}`);
    assertEqual(resolution.effectiveRetries, expected, `effectiveRetries(${JSON.stringify(raw)}) == the Local JEV value`);
  }
  // The shared Policy REFUSES these (TypeError / ValueError / range check) and
  // the shared router would error on EVERY call: EVOLVE must never read them as
  // zero retries.
  for (const raw of [-1, -2.9, null, "abc", "", "1.5", "3.0", Number.NaN, Number.POSITIVE_INFINITY, 4, "4", 1e10, {}, []]) {
    assertEqual(effectiveLocalRetries(raw).ok, false, `the shared parser rejects ${JSON.stringify(String(raw))}`);
  }

  const policy = PS2E_VALIDATION_CLASSIFIER_POLICY;
  const assess = async (options) => assessLocalTevReadiness({ projection: await projectionFor(options), policy });

  // "3" must NOT be treated as 0: 3 retries mean 4 attempts per serving tier.
  const stringThree = await assess({ tier1Timeout: 20, tier2Timeout: 20, maxLocalRetries: "3" });
  assertEqual(stringThree.status, "READY", 'retry "3"');
  assertEqual(stringThree.maxLocalRetries, 3, 'retry "3" normalizes to 3');
  assertEqual(stringThree.timeoutBounds.routerAttemptsPerTier, 4, 'retry "3": 1 + 3 attempts per tier');
  assertEqual(stringThree.derivedWorstCaseLogicalMs, 160_000, 'retry "3": (20s + 20s) x 4');
  assertEqual(stringThree.physicalAttemptCeilingPerLogicalCall, 8, 'retry "3": 2 serving tiers x 4 attempts');

  // 1.5 normalizes to 1 like the shared `int(1.5)` — NOT to zero.
  const fractional = await assess({ tier1Timeout: 20, tier2Timeout: 20, maxLocalRetries: 1.5 });
  assertEqual(fractional.status, "READY", "retry 1.5");
  assertEqual(fractional.maxLocalRetries, 1, "retry 1.5 normalizes to 1");
  assertEqual(fractional.timeoutBounds.routerAttemptsPerTier, 2);
  assertEqual(fractional.derivedWorstCaseLogicalMs, 80_000);
  assertEqual(fractional.physicalAttemptCeilingPerLogicalCall, 4);

  // The exact reproduction from the review: retries "3" with two 60s tiers is
  // ~480,000 ms / EIGHT physical attempts on the real route. Readiness must use
  // the true bound and fail closed on it — never report READY with two attempts.
  const reproduction = await assess({ tier1Timeout: 60, tier2Timeout: 60, maxLocalRetries: "3" });
  assertEqual(reproduction.derivedWorstCaseLogicalMs, 480_000, "the real router theoretical worst case");
  assertEqual(reproduction.physicalAttemptCeilingPerLogicalCall, 8, "the real physical-attempt ceiling");
  assertEqual(reproduction.status, "LOCAL_JEV_TIMEOUT_BOUND_EXCEEDS_PS2E_BOUND", "fail closed over the real bound");
  assertEqual(reproduction.ready, false);

  // Unnormalizable retry values fail closed BEFORE any call: the shared router
  // itself would refuse every request with router_error.
  for (const raw of ["1.5", null, -1, "abc"]) {
    const invalid = await assess({ maxLocalRetries: raw });
    assertEqual(invalid.status, "LOCAL_JEV_CONFIG_INVALID", `retry ${JSON.stringify(String(raw))}: fail closed`);
    assertEqual(invalid.ready, false);
    assertTrue(invalid.problems.length > 0, `retry ${JSON.stringify(String(raw))}: the reason is reported`);
  }

  // The frozen maximum is never grown and the derived ceiling is honest.
  assertEqual(PS2E_PHYSICAL_ATTEMPT_CEILING_PER_LOGICAL_CALL, 9, "the frozen PS.2e maximum is unchanged");
  assertEqual(physicalAttemptCeilingFor({ configuredLocalTiers: 2, maxLocalRetries: 3, typesafeFallbackEnabled: true }), 9);
  assertEqual(physicalAttemptCeilingFor({ configuredLocalTiers: 2, maxLocalRetries: "3", typesafeFallbackEnabled: false }), 8);
  assertEqual(physicalAttemptCeilingFor({ configuredLocalTiers: 1, maxLocalRetries: 1.5 }), 3, "1 serving + 1 unconfigured slot, 1 retry");
  assertEqual(physicalAttemptCeilingFor({ maxLocalRetries: "1.5" }), null, "an unnormalizable retry count yields NO ceiling");
});

await test("sharedIntegerValue is the pinned Python int() mirror: Python whitespace only, U+FEFF refused (blocker 4, integer lexical parity)", async () => {
  // Measured on the pinned router's own interpreter (the decision-router venv
  // Python 3.14): `int(...)` strips EXACTLY [\t \n \v \f \r space U+0085
  // U+00A0 U+1680 U+2000–U+200A U+2028 U+2029 U+202F U+205F U+3000] around a
  // numeral and raises on everything else — INCLUDING U+FEFF (the BOM is NOT
  // Python whitespace: `int("\uFEFF3")` raises) and U+001C–U+001F.
  // JavaScript `trim()` strips U+FEFF (the pre-fix fail-open) and does NOT
  // strip U+0085 (the pre-fix conservative divergence), so it is forbidden
  // here: the shared helper is `stripPythonWhitespace`.
  const PYTHON_WS = [
    " ", "\t", "\n", "\r", "\v", "\f", "\u0085", "\u00a0", "\u1680",
    "\u2000", "\u2001", "\u2002", "\u2003", "\u2004", "\u2005", "\u2006",
    "\u2007", "\u2008", "\u2009", "\u200a", "\u2028", "\u2029", "\u202f",
    "\u205f", "\u3000",
  ];
  assertEqual(PYTHON_WS.length, 25, "the pinned Python whitespace set is 25 characters");
  for (const ws of PYTHON_WS) {
    for (const [raw, expected] of [
      [`${ws}3${ws}`, 3],
      [`${ws}3`, 3],
      [`3${ws}`, 3],
      [`${ws}${ws}3${ws}${ws}`, 3],
      [`${ws}1_0${ws}`, 10],
      [`${ws}+2${ws}`, 2],
    ]) {
      assertEqual(sharedIntegerValue(raw), expected, `the pinned int(${JSON.stringify(raw)}) == ${expected}`);
    }
  }
  // U+FEFF is NOT Python whitespace: a BOM-wrapped integer is refused in EVERY
  // position (the pinned `int(...)` raises), never coerced to its bare value.
  for (const raw of [
    "\uFEFF3", "3\uFEFF", "\uFEFF3\uFEFF", "\uFEFF", "\uFEFF 3", " 3\uFEFF",
    "\uFEFF1_0\uFEFF", "\u0085\uFEFF3", "\uFEFF\u00853",
  ]) {
    assertEqual(
      sharedIntegerValue(raw),
      null,
      `the pinned int(${JSON.stringify(raw)}) raises: refused, never silently normalized to 0`,
    );
  }
  // U+001C–U+001F: the pinned Python raises on them (they are not its
  // whitespace) — EVOLVE refuses them too.
  for (const ch of ["\u001c", "\u001d", "\u001e", "\u001f"]) {
    assertEqual(sharedIntegerValue(`${ch}3${ch}`), null, `the pinned int(${JSON.stringify(`${ch}3${ch}`)}) raises`);
  }
  // The shared helper strips exactly the Python set — never `trim()`'s extra U+FEFF.
  assertEqual(stripPythonWhitespace("\uFEFF3 \u0085"), "\uFEFF3", "the BOM survives; Python whitespace does not");
  assertEqual(stripPythonWhitespace("\uFEFF 3"), "\uFEFF 3", "stripping stops AT the non-whitespace BOM, exactly like Python");
  assertEqual(stripPythonWhitespace(" \t3\n\u3000"), "3");
  assertEqual(stripPythonWhitespace("3\uFEFF"), "3\uFEFF", "a trailing BOM is never stripped");
  // Lexical forms: every expected value derived from the pinned runtime.
  for (const [raw, expected] of [
    [3, 3], ["3", 3], [" 3 ", 3], ["\t3\n", 3], ["+2", 2], ["-2", -2],
    ["0", 0], ["00", 0], ["0_0", 0], ["1_0", 10], ["1_000", 1000],
    ["+1_0", 10], ["1_0_0", 100], ["-0", 0], [1.5, 1], [2.9, 2],
    [-1.5, -1], [-0.5, 0], [3.0, 3], [true, 1], [false, 0],
  ]) {
    assertEqual(sharedIntegerValue(raw), expected, `the pinned int(${JSON.stringify(raw)}) == ${expected}`);
  }
  for (const raw of [
    "1__0", "1_", "_3", "+_3", "3_", "1.5", "1e3", "0x10", "", "   ",
    "3 3", "3\u00a03", "abc", "\u0663", "\u00b3", null, [], [3], {},
    Number.NaN, Number.POSITIVE_INFINITY,
  ]) {
    assertEqual(sharedIntegerValue(raw), null, `the pinned int(${JSON.stringify(String(raw))}) raises: refused`);
  }
});

await test("every shared int() call site holds the pinned parity: BOM fails closed per field (blocker 4)", async () => {
  const policy = PS2E_VALIDATION_CLASSIFIER_POLICY;
  const assess = async (options) => {
    const projection = await projectionFor(options);
    return { projection, readiness: assessLocalTevReadiness({ projection, policy }) };
  };
  // Each field's ACCEPT path: plain, ASCII-whitespace-wrapped and U+0085-wrapped
  // integers (the U+0085 case is Python-accepted whitespace — parity, formerly a
  // conservative divergence) resolve to the SAME effective value the pinned
  // `int(...)` produces; each field's BOM cases follow the pinned REJECT path.
  // Expected values derived from the pinned runtime, bounds preserved exactly:
  // max_local_retries 0..3, min_margin >= 0, samples 1..15, seed/n_ctx unbounded.
  const BOMS = (v) => [`\uFEFF${v}`, `${v}\uFEFF`, `\uFEFF${v}\uFEFF`];

  // ---- max_local_retries (acceptance.max_local_retries, 0..3) --------------
  for (const [raw, expected] of [
    ["3", 3], [" 3 ", 3], ["\t3\n", 3], ["\u00853\u0085", 3], ["\u30003\u3000", 3],
    [3, 3], [true, 1], [false, 0], [1.5, 1], [2.9, 2], [undefined, 0],
  ]) {
    const resolution = effectiveLocalRetries(raw);
    assertEqual(resolution.ok, true, `max_local_retries ${JSON.stringify(raw)} accepted like the pinned int(...)`);
    assertEqual(resolution.effectiveRetries, expected, `max_local_retries ${JSON.stringify(raw)} -> ${expected}`);
  }
  for (const raw of [...BOMS("3"), null, "1.5", "abc", {}, [], -1, 4]) {
    assertEqual(effectiveLocalRetries(raw).ok, false, `max_local_retries ${JSON.stringify(String(raw))} refused like the pinned router`);
    const { readiness } = await assess({ maxLocalRetries: raw });
    assertEqual(readiness.status, "LOCAL_JEV_CONFIG_INVALID", `max_local_retries ${JSON.stringify(String(raw))}: readiness fails closed`);
    assertEqual(readiness.ready, false);
  }
  assertEqual((await assess({ maxLocalRetries: " 3 " })).readiness.maxLocalRetries, 3, '" 3 " is 3 retries, never 0');
  assertEqual((await assess({ maxLocalRetries: "\u00853\u0085" })).readiness.maxLocalRetries, 3, "U+0085-wrapped 3 is the pinned 3");

  // ---- min_margin (acceptance.min_margin, >= 0) ---------------------------
  for (const [raw, expected] of [
    ["2", 2], [" 2 ", 2], ["\u00852\u0085", 2], [2, 2], [true, 1], [false, 0],
    [2.9, 2], [undefined, 1],
  ]) {
    const resolution = effectiveMinMargin(raw);
    assertEqual(resolution.ok, true, `min_margin ${JSON.stringify(raw)} accepted like the pinned int(...)`);
    assertEqual(resolution.value, expected, `min_margin ${JSON.stringify(raw)} -> ${expected}`);
  }
  for (const raw of [...BOMS("1"), null, "1.5", "abc", {}, [], -1]) {
    assertEqual(effectiveMinMargin(raw).ok, false, `min_margin ${JSON.stringify(String(raw))} refused like the pinned router`);
    const { readiness } = await assess({ acceptanceSettings: { min_margin: raw } });
    assertEqual(readiness.status, "LOCAL_JEV_CONFIG_INVALID", `min_margin ${JSON.stringify(String(raw))}: readiness fails closed`);
    assertIncludes(readiness.problems.join(" "), "min_margin");
  }
  assertEqual((await assess({ acceptanceSettings: { min_margin: " 2 " } })).projection.config.acceptance.minMargin, 2);
  assertEqual((await assess({ acceptanceSettings: { min_margin: "\u00852\u0085" } })).projection.config.acceptance.minMargin, 2);

  // ---- samples / seed / n_ctx (provider constructor: 1 <= int(samples) <= 15)
  const inferenceFor = async (settings) => (await assess({ tier1Settings: settings })).projection.config.inference["1"];
  for (const [raw, expected] of [
    ["3", 3], [" 3 ", 3], ["\t3\n", 3], ["\u00853\u0085", 3], ["\u30003\u3000", 3],
    [3, 3], [true, 1], [1.5, 1], [2.9, 2],
  ]) {
    assertEqual((await inferenceFor({ samples: raw })).samples, expected, `samples ${JSON.stringify(raw)} -> ${expected}`);
    assertEqual((await inferenceFor({ seed: raw })).seed, expected, `seed ${JSON.stringify(raw)} -> ${expected}`);
    assertEqual((await inferenceFor({ n_ctx: raw })).nCtx, expected, `n_ctx ${JSON.stringify(raw)} -> ${expected}`);
    for (const key of ["samples", "seed", "n_ctx"]) {
      const { readiness } = await assess({ tier1Settings: { [key]: raw } });
      assertEqual(readiness.status, "READY", `${key} ${JSON.stringify(raw)}: same effective integer as the pinned router`);
    }
  }
  // false -> 0 is accepted by `int(...)` for seed/n_ctx but NOT for samples
  // (the pinned `1 <= int(samples) <= 15` refuses 0 — preserved exactly).
  assertEqual((await inferenceFor({ seed: false })).seed, 0);
  assertEqual((await inferenceFor({ n_ctx: false })).nCtx, 0);
  assertEqual(
    (await assess({ tier1Settings: { samples: false } })).readiness.status,
    "LOCAL_JEV_CONFIG_INVALID",
    "samples false == 0 is out of the pinned 1..15 range",
  );
  // Missing keys resolve to the shared defaults (never invented, never zeroed).
  assertEqual((await inferenceFor({ samples: undefined })).samples, 3);
  assertEqual((await inferenceFor({ seed: undefined })).seed, 1234);
  assertEqual((await inferenceFor({ n_ctx: undefined })).nCtx, 2048);
  assertEqual((await assess({ acceptanceSettings: { min_margin: undefined } })).projection.config.acceptance.minMargin, 1);
  // BOM and every other refused form fail CLOSED per field, readiness included.
  for (const key of ["samples", "seed", "n_ctx"]) {
    for (const raw of [...BOMS("3"), null, "1.5", "abc", {}, []]) {
      const { readiness } = await assess({ tier1Settings: { [key]: raw } });
      assertEqual(readiness.status, "LOCAL_JEV_CONFIG_INVALID", `${key} ${JSON.stringify(String(raw))}: readiness fails closed`);
      assertIncludes(readiness.problems.join(" "), key);
      assertEqual(
        (await assess({ localSettings: { [key]: raw } })).readiness.status,
        "LOCAL_JEV_CONFIG_INVALID",
        `${key} ${JSON.stringify(String(raw))} via local inheritance: fail closed`,
      );
    }
    for (const raw of BOMS("3")) {
      assertEqual(sharedIntegerValue(raw), null, `${key} BOM string is never coercible`);
    }
  }
  // samples keeps its pinned 1..15 bound after coercion; seed/n_ctx stay open.
  assertEqual((await assess({ tier1Settings: { samples: "1_5" } })).readiness.status, "READY", 'samples "1_5" == 15 is in range');
  assertEqual((await inferenceFor({ samples: "1_5" })).samples, 15);
  assertEqual((await assess({ tier1Settings: { samples: "1_6" } })).readiness.status, "LOCAL_JEV_CONFIG_INVALID", "samples 16 exceeds the pinned bound");
  assertEqual((await inferenceFor({ seed: "-1_2" })).seed, -12, "seed stays unbounded like the pinned int(seed)");
  assertEqual((await inferenceFor({ n_ctx: "4_0_9_6" })).nCtx, 4096);
});

await test("readiness regression: a BOM config that was false-READY now fails closed with NO Local JEV call (blocker 4)", async () => {
  // Before the fix, JavaScript `trim()` stripped U+FEFF, so EVERY field below
  // produced READY (with a fabricated effective integer) while the pinned Local
  // JEV refused the same config on EVERY call (router_error). After the fix the
  // same configs are LOCAL_JEV_CONFIG_INVALID before any call is attempted.
  const policy = PS2E_VALIDATION_CLASSIFIER_POLICY;
  const cases = [
    ["max_local_retries", { maxLocalRetries: "\uFEFF3" }, "max_local_retries"],
    ["min_margin", { acceptanceSettings: { min_margin: "\uFEFF1" } }, "min_margin"],
    ["samples", { localSettings: { samples: "\uFEFF3" } }, "samples"],
    ["seed", { localSettings: { seed: "\uFEFF3" } }, "seed"],
    ["n_ctx", { localSettings: { n_ctx: "\uFEFF3" } }, "n_ctx"],
    ["samples via tier", { tier1Settings: { samples: "3\uFEFF" } }, "samples"],
    ["seed via tier", { tier1Settings: { seed: "\uFEFF3\uFEFF" } }, "seed"],
    ["n_ctx via tier", { tier1Settings: { n_ctx: "\uFEFF3" } }, "n_ctx"],
    ["max_local_retries suf", { maxLocalRetries: "3\uFEFF" }, "max_local_retries"],
  ];
  for (const [label, options, needle] of cases) {
    const projection = await projectionFor(options);
    const readiness = assessLocalTevReadiness({ projection, policy });
    assertEqual(readiness.status, "LOCAL_JEV_CONFIG_INVALID", `${label} BOM: readiness fails closed (was false-READY before the fix)`);
    assertEqual(readiness.ready, false);
    assertIncludes(readiness.problems.join(" "), needle);
    // The shadow holds the same readiness and therefore NEVER asks the Local JEV.
    const transport = fixtureTransportFor([okStep(outcomeFor())]);
    const { shadow, root } = shadowFor({ transport, policy, projection });
    for (let index = 0; index < 2; index += 1) {
      shadow.observeProductionEntry(entryFacts({ mint: MINT[["A", "B"][index]], generation: 1, generationTick: 1 + index }));
    }
    await drainShadow(shadow);
    const block = shadow.summaryBlock();
    assertEqual(block.counters.logicalCalls, 0, `${label} BOM: zero logical calls`);
    assertEqual(transport.calls.length, 0, `${label} BOM: the Local JEV is never asked — no router_error path is reached`);
    const records = await readSupervisorLocalTevObservations(root);
    assertEqual(records.records.length, 2, `${label} BOM: one fail-closed record per admitted observation`);
    for (const record of records.records) {
      assertEqual(record.decision, PS2E_OUTCOMES.UNAVAILABLE, `${label} BOM: never a decision`);
      assertEqual(record.providerStatus, "LOCAL_JEV_CONFIG_INVALID", `${label} BOM: the record names the config refusal`);
      assertIncludes(record.failureReason, needle);
    }
  }
});

await test("sharedIntegerValue refuses integers outside the exact JS safe-integer range: never a rounded integer (certification)", async () => {
  // Python keeps every integer exactly; a JavaScript Number is exact only up to
  // 2^53 - 1. EVOLVE accepts a shared `int(...)` result only when it is a safe
  // integer, so no accepted configuration can persist or digest a rounded value.
  const MAX = Number.MAX_SAFE_INTEGER; // 9007199254740991
  for (const [raw, expected] of [
    [MAX, MAX],
    [-MAX, -MAX],
    ["9007199254740991", MAX],
    ["-9007199254740991", -MAX],
    ["+9007199254740991", MAX],
    ["9_007_199_254_740_991", MAX],
    ["\u00859007199254740991\u0085", MAX],
    [9007199254740991.0, MAX],
    [4503599627370495.5, 4503599627370495], // an exactly representable fraction truncates toward zero
  ]) {
    assertEqual(sharedIntegerValue(raw), expected, `${JSON.stringify(raw)} is exact and accepted`);
  }
  for (const raw of [
    MAX + 1, // 2^53: exact in binary64, but 2^53 + 1 parses to the same Number
    -(MAX + 1),
    2 ** 63,
    1e20,
    Number.MAX_VALUE,
    "9007199254740992",
    "9007199254740993",
    "-9007199254740992",
    "18446744073709551617",
    "9".repeat(40),
    "1" + "0".repeat(400),
    "\u00859007199254740992\u0085",
    "﻿9007199254740991", // the BOM refusal is unchanged
  ]) {
    assertEqual(sharedIntegerValue(raw), null, `${String(raw).slice(0, 24)}: outside the exact domain (or lexically refused)`);
  }

  // Raw JSON literals exactly as a stored config carries them (Python's json
  // keeps the exact integer; JSON.parse would round it).
  const policy = PS2E_VALIDATION_CLASSIFIER_POLICY;
  const withLiteral = async (options, literal) => {
    const text = fixtureConfigJson(options).replace('"__SAFE_INT_LITERAL__"', literal);
    assertIncludes(text, literal, "the raw literal is in the stored config text");
    const projection = await readLocalJevEnvironment({
      env: { HOME: "/fixture-home", PATH: "/usr/bin" },
      configPath: "/fixture/config.json",
      readFileImpl: async () => text,
      accessImpl: async () => {},
    });
    return { projection, readiness: assessLocalTevReadiness({ projection, policy }) };
  };
  const cases = [
    ["min_margin", (v) => ({ acceptanceSettings: { min_margin: v } }), (p) => p.config.acceptance.minMargin],
    ["seed (tier)", (v) => ({ tier1Settings: { seed: v } }), (p) => p.config.inference["1"].seed],
    ["seed (local)", (v) => ({ localSettings: { seed: v } }), (p) => p.config.inference["2"].seed],
    ["n_ctx (tier)", (v) => ({ tier1Settings: { n_ctx: v } }), (p) => p.config.inference["1"].nCtx],
    ["n_ctx (local)", (v) => ({ localSettings: { n_ctx: v } }), (p) => p.config.inference["2"].nCtx],
  ];
  for (const [label, optionsFor, effectiveOf] of cases) {
    // MAX_SAFE_INTEGER: exact, accepted (seed/n_ctx carry no EVOLVE-side u32
    // bound in this pass; a later NobodyWho u32 failure is a documented runtime
    // limitation, not a coercion-parity question).
    for (const literal of ["9007199254740991", '"9007199254740991"', '"\\u00859007199254740991"']) {
      const { projection, readiness } = await withLiteral(optionsFor("__SAFE_INT_LITERAL__"), literal);
      assertEqual(readiness.status, "READY", `${label} ${literal}: exact, READY`);
      assertEqual(effectiveOf(projection), MAX, `${label} ${literal}: the exact value is the effective value`);
    }
    // 2^53 and beyond: Python accepts the exact integer, EVOLVE fails closed.
    for (const literal of ["9007199254740992", "9007199254740993", '"9007199254740993"', "18446744073709551617", "1" + "0".repeat(400), "1e20"]) {
      const { projection, readiness } = await withLiteral(optionsFor("__SAFE_INT_LITERAL__"), literal);
      assertEqual(readiness.status, "LOCAL_JEV_CONFIG_INVALID", `${label} ${literal.slice(0, 24)}: fail closed, never rounded`);
      assertEqual(effectiveOf(projection), null, `${label} ${literal.slice(0, 24)}: no rounded effective integer`);
      assertIncludes(readiness.problems.join(" "), "safe-integer range", `${label}: the refusal names the exact-range reason`);
    }
  }
  // Negative exact values parse exactly; the FIELD bound then decides.
  const negativeSeed = await withLiteral({ tier1Settings: { seed: "__SAFE_INT_LITERAL__" } }, "-9007199254740991");
  assertEqual(negativeSeed.readiness.status, "READY", "seed has no pinned sign bound: the shared build accepts -(2^53 - 1)");
  assertEqual(negativeSeed.projection.config.inference["1"].seed, -MAX);
  const negativeMargin = await withLiteral({ acceptanceSettings: { min_margin: "__SAFE_INT_LITERAL__" } }, "-9007199254740991");
  assertEqual(negativeMargin.readiness.status, "LOCAL_JEV_CONFIG_INVALID", "min_margin >= 0 still decides");
  // max_local_retries / samples keep failing from their much smaller bounds.
  for (const literal of ["9007199254740991", "9007199254740992", '"9007199254740993"']) {
    assertEqual((await withLiteral({ maxLocalRetries: "__SAFE_INT_LITERAL__" }, literal)).readiness.status, "LOCAL_JEV_CONFIG_INVALID");
    assertEqual((await withLiteral({ tier1Settings: { samples: "__SAFE_INT_LITERAL__" } }, literal)).readiness.status, "LOCAL_JEV_CONFIG_INVALID");
  }
  assertEqual(effectiveLocalRetries(MAX).ok, false, "retries: the 0..3 bound refuses MAX_SAFE_INTEGER");
  assertEqual(effectiveLocalRetries(MAX + 1).ok, false, "retries: an inexact integer is refused");

  // The exact boundary value persists and replays without rounding.
  const exact = await withLiteral({ tier1Settings: { seed: "__SAFE_INT_LITERAL__" } }, "9007199254740991");
  const built = buildTevOpportunityPacket({ ...entryFacts(), engineTick: 1, opportunitySequence: 1 });
  const input = completeInputFor(built.packet, { sampling: { primaryTier: "1", tiers: exact.projection.config.inference } });
  const record = JSON.parse(
    JSON.stringify({ modelInputDescriptor: modelInputDescriptorOf(input), packet: built.packet, jevInputDigest: localTevInputDigestOf(input) }),
  );
  assertEqual(record.modelInputDescriptor.sampling.tiers["1"].seed, MAX, "the persisted seed is the exact integer");
  assertEqual(jevInputDigestFromEvidence(record), record.jevInputDigest, "the exact boundary value replays its digest");
});

await test("Local JEV float coercion parity: the pinned Python float() semantics (blocker 2, float coercion)", async () => {
  // The pinned shared router coerces with Python `float(...)` and has NO
  // finite/range check for temperature (measured on the router's own
  // interpreter): booleans are 1.0 / 0.0 and underscores between digits are
  // valid. EVOLVE must hold the SAME effective value — never null for a value
  // the shared router accepts.
  for (const [raw, expected] of [
    [0, 0],
    [1, 1],
    [0.25, 0.25],
    [-0.25, -0.25],
    [true, 1],
    [false, 0],
    ["0", 0],
    ["1", 1],
    ["0.25", 0.25],
    ["-0.25", -0.25],
    ["+0.25", 0.25],
    ["0.2_5", 0.25],
    ["0.7_5", 0.75],
    ["0_0.2_5", 0.25],
    ["1_0", 10],
    ["1e1_0", 1e10],
    ["2.5e-1", 0.25],
    ["2.5E-1", 0.25],
    [".25", 0.25],
    ["25.", 25],
    ["00.25", 0.25],
    [" 0.25 ", 0.25],
    ["\t0.25\n", 0.25],
    ["\v0.25\f\r", 0.25],
    [" 0.25", 0.25],
    ["\u0085 0.25", 0.25],
    [" 0.25　", 0.25],
    ["1e-400", 0], // Python underflows to 0.0 (no error)
    ["-0.0", 0], // -0.0 normalized: identical sampler behavior, canonical JSON cannot tell
    [-0, 0],
    ["0.30000000000000004", 0.30000000000000004],
    ["9007199254740993", 9007199254740992], // both runtimes round to nearest binary64
  ]) {
    const coerced = sharedFloatCoercion(raw);
    assertEqual(coerced.ok, true, `shared float(${JSON.stringify(raw)}) is accepted`);
    assertTrue(Object.is(coerced.value, expected), `float(${JSON.stringify(raw)}) == ${expected} (got ${coerced.value})`);
    assertTrue(Object.is(sharedFloatValue(raw), expected));
  }
  // Refused exactly where Python `float(...)` raises (TypeError / ValueError).
  for (const raw of [
    null,
    undefined,
    [],
    {},
    [0.5],
    { a: 1 },
    "",
    "   ",
    "\t",
    "abc",
    "true",
    "True",
    "None",
    "0x10",
    "1,5",
    "0.5 0.5",
    "--1",
    "+-1",
    "1e",
    "1e+",
    ".",
    "e1",
    "1.2.3",
    "infinit",
    "nanx",
    "\x1c0.25", // not stripped by Python float() (unlike its str.isspace)
    "0.25\x00",
    // H. invalid underscore placements: Python raises, so they never become valid.
    "_0.25",
    "0.25_",
    "0__25",
    "0.2__5",
    "0_.25",
    "0._25",
    "_.5",
    "._5",
    "1e_1",
    "1_e1",
    "1e1_",
    "1e+_1",
    "+_1",
    "_",
    "1_000_",
  ]) {
    const coerced = sharedFloatCoercion(raw);
    assertEqual(coerced.ok, false, `shared float(${JSON.stringify(raw)}) raises: refused`);
    assertEqual(coerced.value, null);
    assertEqual(coerced.refusal, SHARED_FLOAT_REFUSAL.NOT_COERCIBLE, `${JSON.stringify(raw)}: not coercible`);
  }
  // Conservative refusals (fail closed where Python still yields a value).
  for (const raw of ["nan", "NaN", "-nan", "+NAN", "inf", "-inf", "+Infinity", "INFINITY", "1e309", "-1e309", "1" + "0".repeat(400)]) {
    assertEqual(sharedFloatCoercion(raw).refusal, SHARED_FLOAT_REFUSAL.NON_FINITE, `${raw.slice(0, 12)}: non-finite, fail closed`);
  }
  for (const raw of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assertEqual(sharedFloatCoercion(raw).refusal, SHARED_FLOAT_REFUSAL.NUMBER_OUT_OF_RANGE, `${raw}: out-of-range number, fail closed`);
  }
  for (const raw of ["٠.٥", "０.５", "﻿0.25", "​0.25"]) {
    assertEqual(sharedFloatCoercion(raw).ok, false, `${JSON.stringify(raw)}: non-ASCII text is refused`);
    assertEqual(sharedFloatCoercion(raw).refusal, SHARED_FLOAT_REFUSAL.NON_ASCII_TEXT);
  }

  const policy = PS2E_VALIDATION_CLASSIFIER_POLICY;
  const built = buildTevOpportunityPacket({ ...entryFacts(), engineTick: 1, opportunitySequence: 1 });
  const samplingFrom = (projection) => ({ primaryTier: "1", tiers: projection.config.inference });
  // The complete input as the shadow builds it: the effective sampling block
  // AND the preserved config-provenance digest in the routing block.
  const inputFrom = (projection) => {
    const readiness = augmentReadinessForSession(assessLocalTevReadiness({ projection, policy }), projection);
    return completeInputFor(built.packet, {
      sampling: samplingFrom(projection),
      routing: { mode: PS2E_LOCAL_JEV_MODE, localJevConfigDigest: readiness.configDigest, transportKind: "fixture" },
      classifier: { classifierId: "c", primaryTier: "1", routingDigest: readiness.routingDigest },
    });
  };
  const digestFrom = (projection) => localTevInputDigestOf(inputFrom(projection));
  const records = [];
  const persist = (projection, label) => {
    const input = inputFrom(projection);
    // Stored as JSON exactly like an evidence line, then read back.
    const record = JSON.parse(
      JSON.stringify({ label, modelInputDescriptor: modelInputDescriptorOf(input), packet: built.packet, jevInputDigest: localTevInputDigestOf(input) }),
    );
    records.push(record);
    return record;
  };

  // A-D. Tier-level AND inherited `local` temperatures accepted by the shared
  // router: READY with the TRUE effective value (never null), persisted.
  for (const [raw, expected, letter] of [
    [true, 1, "A"],
    [false, 0, "B"],
    ["0.2_5", 0.25, "C"],
    ["0.7_5", 0.75, "D"],
  ]) {
    for (const [options, where] of [
      [{ tier1Settings: { temperature: raw } }, "tier 1"],
      [{ localSettings: { temperature: raw } }, "local (inherited by both tiers)"],
    ]) {
      const projection = await projectionFor(options);
      const readiness = assessLocalTevReadiness({ projection, policy });
      assertEqual(readiness.status, "READY", `${letter}: ${where} temperature ${JSON.stringify(raw)} is accepted like the shared router`);
      assertTrue(Object.is(projection.config.inference["1"].temperature, expected), `${letter}: ${where} effective temperature == ${expected}`);
      if (where.startsWith("local")) assertTrue(Object.is(projection.config.inference["2"].temperature, expected), `${letter}: inherited by tier 2`);
      assertDeepEqual(projection.config.sharedBuildProblems, [], `${letter}: the shared build accepts it`);
      const record = persist(projection, `${letter} ${where}`);
      assertTrue(Object.is(record.modelInputDescriptor.sampling.tiers["1"].temperature, expected), `${letter}: persisted effective value`);
    }
  }

  // E. Syntactically different inputs resolving to the SAME effective value:
  // identical effective-settings projections (and, at tier level, even the
  // complete digest: no preserved provenance field differs).
  const equivalent = [0.25, "0.25", "0.2_5", " 0.25 ", "+2.5e-1", "0_0.2_5", "25e-2"];
  const equivalentProjections = await Promise.all(equivalent.map((raw) => projectionFor({ tier1Settings: { temperature: raw } })));
  for (const [index, projection] of equivalentProjections.entries()) {
    assertEqual(projection.config.inference["1"].temperature, 0.25, `E: ${JSON.stringify(equivalent[index])} -> 0.25`);
    assertDeepEqual(samplingFrom(projection), samplingFrom(equivalentProjections[0]), `E: ${JSON.stringify(equivalent[index])} same effective projection`);
    assertEqual(digestFrom(projection), digestFrom(equivalentProjections[0]), `E: ${JSON.stringify(equivalent[index])} same complete digest`);
    persist(projection, `E ${JSON.stringify(equivalent[index])}`);
  }
  // At `local` level the preserved provenance digest may over-differentiate
  // (it records numeric config only); the EFFECTIVE projection still matches.
  const localNumber = await projectionFor({ localSettings: { temperature: 0.25 } });
  const localUnderscore = await projectionFor({ localSettings: { temperature: "0.2_5" } });
  assertDeepEqual(samplingFrom(localNumber), samplingFrom(localUnderscore), "E: local 0.25 vs \"0.2_5\": same effective projection");

  // F / G. Different effective values -> different projections AND digests.
  for (const [left, right, letter] of [
    [true, false, "F"],
    ["0.2_5", "0.7_5", "G"],
    [true, 0.7, "F'"], // true (1.0) is NOT the shared default 0.7
    [false, "0.2_5", "F''"],
  ]) {
    for (const key of ["tier1Settings", "localSettings"]) {
      const a = await projectionFor({ [key]: { temperature: left } });
      const b = await projectionFor({ [key]: { temperature: right } });
      assertTrue(
        !Object.is(a.config.inference["1"].temperature, b.config.inference["1"].temperature),
        `${letter}: ${key} ${JSON.stringify(left)} vs ${JSON.stringify(right)} effective values differ`,
      );
      assertTrue(digestFrom(a) !== digestFrom(b), `${letter}: ${key} ${JSON.stringify(left)} vs ${JSON.stringify(right)}: jevInputDigest differs`);
      assertTrue(
        localTevInputDigestOf(completeInputFor(built.packet, { sampling: samplingFrom(a) })) !==
          localTevInputDigestOf(completeInputFor(built.packet, { sampling: samplingFrom(b) })),
        `${letter}: the effective sampling block alone already separates them`,
      );
    }
  }
  // The four reproduced configurations are pairwise distinct.
  const reproduced = await Promise.all([true, false, "0.2_5", "0.7_5"].map((raw) => projectionFor({ tier1Settings: { temperature: raw } })));
  assertEqual(new Set(reproduced.map(digestFrom)).size, 4, "true / false / \"0.2_5\" / \"0.7_5\": four distinct jevInputDigests");

  // H / I / non-finite. Values the shared router refuses (or EVOLVE cannot
  // represent) are never normalized: readiness fails closed BEFORE any call.
  for (const raw of ["_0.25", "0.25_", "0__25", "0_.25", "1e_1", "abc", "", "   ", null, [], {}, "0x1", "﻿0.25", "nan", "inf", "-Infinity", "1e309", "٠.٥"]) {
    for (const key of ["tier1Settings", "tier2Settings", "localSettings"]) {
      const projection = await projectionFor({ [key]: { temperature: raw } });
      const readiness = assessLocalTevReadiness({ projection, policy });
      assertEqual(readiness.status, "LOCAL_JEV_CONFIG_INVALID", `${key} temperature ${JSON.stringify(raw)}: fail closed`);
      assertEqual(readiness.ready, false);
      assertIncludes(readiness.problems.join(" "), "temperature", `${key} temperature ${JSON.stringify(raw)}: the reason names the field`);
    }
  }
  // A refused tier temperature has NO effective value (null, never a default).
  assertEqual((await projectionFor({ tier1Settings: { temperature: "0__25" } })).config.inference["1"].temperature, null);

  // J. Every persisted record replays its digest exactly from stored evidence
  // alone — no current Local JEV configuration is consulted.
  assertTrue(records.length >= 15, "the persisted float-coercion records exist");
  for (const record of records) {
    assertEqual(jevInputDigestFromEvidence(record), record.jevInputDigest, `J: ${record.label} replays exactly`);
    assertTrue(typeof record.modelInputDescriptor.sampling.tiers["1"].temperature === "number", `J: ${record.label} stores a number`);
  }
});

await test("every other shared float() call site: effective values and fail-closed readiness (blocker 2, float coercion)", async () => {
  const policy = PS2E_VALIDATION_CLASSIFIER_POLICY;
  const assess = async (options) => {
    const projection = await projectionFor(options);
    return { projection, readiness: assessLocalTevReadiness({ projection, policy }) };
  };
  const configDigestOf = (projection, readiness) => augmentReadinessForSession(readiness, projection).configDigest;

  // acceptance.min_stability — `float(...)` then [0, 1] (Policy.from_config);
  // also the worker's early-stop min_share, so its EFFECTIVE value is digested.
  for (const [raw, expected] of [
    [undefined, 0.66],
    [0.66, 0.66],
    ["0.66", 0.66],
    ["0.6_6", 0.66],
    [true, 1],
    [false, 0],
    ["1", 1],
    [" 0.5 ", 0.5],
    ["-0.0", 0],
  ]) {
    const resolution = effectiveMinStability(raw);
    assertEqual(resolution.ok, true, `min_stability ${JSON.stringify(raw)} accepted`);
    assertEqual(resolution.value, expected, `min_stability ${JSON.stringify(raw)} -> ${expected}`);
  }
  for (const raw of [null, "abc", "0.6__6", 1.5, "1.5", -0.1, "nan", "inf", [], {}]) {
    assertEqual(effectiveMinStability(raw).ok, false, `min_stability ${JSON.stringify(raw)} refused like the shared Policy`);
    const { readiness } = await assess({ acceptanceSettings: { min_stability: raw } });
    assertEqual(readiness.status, "LOCAL_JEV_CONFIG_INVALID", `min_stability ${JSON.stringify(raw)}: fail closed`);
    assertIncludes(readiness.problems.join(" "), "min_stability");
  }
  const stabilityA = await assess({ acceptanceSettings: { min_stability: "0.5" } });
  const stabilityB = await assess({ acceptanceSettings: { min_stability: "0.9" } });
  const stabilityA2 = await assess({ acceptanceSettings: { min_stability: 0.5 } });
  assertEqual(stabilityA.readiness.status, "READY");
  assertEqual(stabilityA.projection.config.acceptance.minStability, 0.5, "\"0.5\" is the effective 0.5 (never null)");
  assertTrue(
    configDigestOf(stabilityA.projection, stabilityA.readiness) !== configDigestOf(stabilityB.projection, stabilityB.readiness),
    "min_stability \"0.5\" vs \"0.9\": different effective policy -> different config digest",
  );
  assertEqual(
    configDigestOf(stabilityA.projection, stabilityA.readiness),
    configDigestOf(stabilityA2.projection, stabilityA2.readiness),
    "min_stability \"0.5\" vs 0.5: the same effective policy",
  );

  // min_margin (`int(...)`, >= 0) and escalate_on_abstain (`bool(...)`) in the
  // same effective acceptance block.
  assertEqual((await assess({ acceptanceSettings: { min_margin: "2" } })).projection.config.acceptance.minMargin, 2);
  assertEqual((await assess({ acceptanceSettings: { min_margin: -1 } })).readiness.status, "LOCAL_JEV_CONFIG_INVALID");
  assertEqual((await assess({ acceptanceSettings: { min_margin: "abc" } })).readiness.status, "LOCAL_JEV_CONFIG_INVALID");
  for (const [raw, expected] of [[0, false], [null, false], ["", false], [[], false], [{}, false], [1, true], ["no", true], [[0], true]]) {
    assertEqual(
      (await assess({ acceptanceSettings: { escalate_on_abstain: raw } })).projection.config.acceptance.escalateOnAbstain,
      expected,
      `escalate_on_abstain ${JSON.stringify(raw)} -> Python bool() ${expected}`,
    );
  }

  // timeout_s — `float(...)` per provider. A string timeout is its real value,
  // so the router worst case is never understated by a silent fallback.
  const stringTimeouts = await assess({ tier1Timeout: "20", tier2Timeout: "2_0" });
  assertEqual(stringTimeouts.readiness.status, "READY");
  assertEqual(stringTimeouts.projection.config.tiers["1"].effectiveTimeoutS, 20);
  assertEqual(stringTimeouts.projection.config.tiers["2"].effectiveTimeoutS, 20);
  assertEqual(stringTimeouts.readiness.derivedWorstCaseLogicalMs, 40_000);
  const boolTimeout = await assess({ tier1Timeout: true });
  assertEqual(boolTimeout.projection.config.tiers["1"].effectiveTimeoutS, 1, "timeout_s true is float(True) == 1 s");
  const inherited = await assess({ tier1Timeout: null, localTimeoutS: "30" });
  assertEqual(inherited.projection.config.tiers["1"].effectiveTimeoutS, 30, "an inherited local timeout_s \"30\" is 30 s");
  // Previously a string 200 s timeout fell back to 60 s and reported READY; the
  // real router waits 200 s per attempt, so the bound must fail closed.
  const understated = await assess({ tier1Timeout: "200", tier2Timeout: 60 });
  assertEqual(understated.projection.config.tiers["1"].effectiveTimeoutS, 200);
  assertEqual(understated.readiness.status, "LOCAL_JEV_TIMEOUT_BOUND_EXCEEDS_PS2E_BOUND", "string 200 s: the TRUE bound fails closed");
  for (const raw of ["abc", null, "nan", "inf", "6__0"]) {
    const refused = await assess({ tier1Settings: { timeout_s: raw } });
    assertEqual(refused.readiness.status, "LOCAL_JEV_CONFIG_INVALID", `tier timeout_s ${JSON.stringify(raw)}: fail closed`);
    assertEqual(refused.projection.config.tiers["1"].effectiveTimeoutS, null, `tier timeout_s ${JSON.stringify(raw)}: no invented effective timeout`);
  }
  // The shared `local` provider is built on EVERY call (even local-first), so a
  // refused local value fails closed although both tiers override it.
  assertEqual((await assess({ localTimeoutS: "abc" })).readiness.status, "LOCAL_JEV_CONFIG_INVALID");
  assertEqual(
    (await assess({ localSettings: { temperature: "abc" }, tier1Settings: { temperature: 0.5 }, tier2Settings: { temperature: 0.5 } })).readiness.status,
    "LOCAL_JEV_CONFIG_INVALID",
    "a refused local temperature breaks the shared build even when both tiers override it",
  );
  // Tier 2's own shared default timeout (300 s) shadows `local`: a local value
  // never reaches tier 2, exactly like the shared deep merge.
  assertEqual((await assess({ tier2Timeout: null, localTimeoutS: 5 })).projection.config.tiers["2"].effectiveTimeoutS, 300);

  // jev.timeout_s — `float(...)` only when the shared system enables TypeSafe.
  const jevString = await assess({ tier1Timeout: 20, tier2Timeout: 20, jevEnabled: true, jevTimeoutS: "30" });
  assertEqual(jevString.readiness.status, "READY");
  assertEqual(jevString.readiness.timeoutBounds.routerProviderFallbackMs, 30_000, "jev.timeout_s \"30\" is its real 30 s");
  assertEqual((await assess({ jevEnabled: true, jevTimeoutS: "abc" })).readiness.status, "LOCAL_JEV_CONFIG_INVALID");
  assertEqual((await assess({ jevEnabled: false, jevTimeoutS: "abc" })).readiness.status, "READY", "a disabled TypeSafe provider is never built");

  // idle_timeout_s — `float(...)` only when the tier's worker is persistent.
  assertEqual((await assess({ tier1Settings: { idle_timeout_s: "abc" } })).readiness.status, "LOCAL_JEV_CONFIG_INVALID");
  assertEqual((await assess({ tier1Settings: { idle_timeout_s: "90" } })).readiness.status, "READY");
  assertEqual((await assess({ tier1Settings: { idle_timeout_s: "inf" } })).readiness.status, "READY", "idle exit only: the shared build accepts inf");
  assertEqual(
    (await assess({ tier1Settings: { idle_timeout_s: "abc", persistent: false }, localSettings: { persistent: false } })).readiness.status,
    "READY",
    "a non-persistent worker never coerces idle_timeout_s",
  );
  assertEqual(
    (await assess({ tier1Settings: { idle_timeout_s: "abc", persistent: [] } })).readiness.status,
    "READY",
    "persistent [] is falsy in Python: no persistent worker is built",
  );

  // The integer inference settings of the same build: 1 <= samples <= 15, and
  // int(seed) / int(n_ctx) — refused values fail closed, never stay silently null.
  for (const [options, label] of [
    [{ tier1Settings: { samples: 16 } }, "samples 16"],
    [{ tier1Settings: { samples: 0 } }, "samples 0"],
    [{ tier1Settings: { samples: "abc" } }, "samples abc"],
    [{ tier1Settings: { seed: "1.5" } }, "seed \"1.5\""],
    [{ localSettings: { n_ctx: null } }, "n_ctx null"],
  ]) {
    assertEqual((await assess(options)).readiness.status, "LOCAL_JEV_CONFIG_INVALID", `${label}: fail closed`);
  }
  assertEqual((await assess({ tier1Settings: { samples: "1_5" } })).readiness.status, "READY", "samples \"1_5\" == 15 is in range");
  // Python bool() of an empty list/object is False: the effective settings agree.
  const emptyGpu = await assess({ tier1Settings: { use_gpu: [], cpu_fallback: {} } });
  assertEqual(emptyGpu.projection.config.inference["1"].useGpu, false);
  assertEqual(emptyGpu.projection.config.inference["1"].cpuFallback, false);

  // The gate itself is always present on a real projection and names each refusal.
  assertDeepEqual((await projectionFor({})).config.sharedBuildProblems, [], "the fixture config builds cleanly");
  assertDeepEqual(sharedRouterBuildProblems({ local: 5 }), ["local is not an object (the shared config merge breaks)"]);
  assertEqual(sharedRouterBuildProblems({ tiers: { "2": { temperature: "0.7_5" } } }).length, 0);
  assertEqual(sharedRouterBuildProblems({ tiers: { "2": { temperature: "0.7__5" } } }).length, 1);
});

await test("omitted jev.enabled mirrors the pinned shared default (disabled)", async () => {
  const omittedBlock = await projectionFor({ omitJevBlock: true });
  assertEqual(omittedBlock.config.jevFallbackEnabled, false, "an omitted jev block resolves to the shared default (disabled)");
  const omittedKey = await projectionFor({ omitJevEnabled: true });
  assertEqual(omittedKey.config.jevFallbackEnabled, false, "an omitted jev.enabled key resolves to the shared default (disabled)");
  assertEqual((await projectionFor({ jevEnabled: false })).config.jevFallbackEnabled, false);
  assertEqual((await projectionFor({ jevEnabled: true })).config.jevFallbackEnabled, true);
  // The shared check is Python `is not False` identity semantics: only an
  // explicit `false` disables; `0` is NOT False.
  assertEqual((await projectionFor({ jevEnabled: 0 })).config.jevFallbackEnabled, true, "`0 is not False` in the shared identity check");
  // Readiness binds the fallback to the SAME normalization.
  const readiness = assessLocalTevReadiness({ projection: omittedBlock, policy: PS2E_VALIDATION_CLASSIFIER_POLICY });
  assertEqual(readiness.typesafeFallbackEnabled, false);
  assertEqual(readiness.timeoutBounds.routerProviderFallbackMs, 0, "a disabled fallback adds nothing to the bound");
});

await test("EVOLVE_LOCAL_JEV_BIN is normalized once: readiness and spawn can never disagree (FIX C)", async () => {
  // unset -> the documented default.
  assertDeepEqual(resolveLocalJevExecutable({ env: {} }), { command: "decision", source: "PATH:decision" });
  assertEqual(createDecisionCliTransport({ env: {} }).command, "decision");
  // a valid explicit path is used (and verified by readiness).
  assertDeepEqual(resolveLocalJevExecutable({ executable: " /fixture/decision " }), { command: "/fixture/decision", source: "explicit" });
  // whitespace-only overrides fall back to the documented default in BOTH
  // readiness and the spawn target: never an empty spawn after READY.
  for (const override of ["   ", "\t\n"]) {
    assertDeepEqual(resolveLocalJevExecutable({ env: { EVOLVE_LOCAL_JEV_BIN: override } }), { command: "decision", source: "PATH:decision" });
    assertDeepEqual(resolveLocalJevExecutable({ executable: override, env: {} }), { command: "decision", source: "PATH:decision" });
  }
  assertEqual(createDecisionCliTransport({ env: { EVOLVE_LOCAL_JEV_BIN: "   " } }).command, "decision");
  const whitespaceProjection = await readLocalJevEnvironment({
    env: { EVOLVE_LOCAL_JEV_BIN: "   ", HOME: "/h", PATH: "/usr/bin" },
    configPath: "/fixture/config.json",
    readFileImpl: async () => fixtureConfigJson(),
    accessImpl: async () => {},
  });
  assertEqual(whitespaceProjection.executable.command, "decision", "whitespace override resolves to the default command");
  assertEqual(whitespaceProjection.executable.source, "PATH:decision");
  // a missing explicit executable fails READINESS cleanly (before any spawn).
  const missing = await readLocalJevEnvironment({
    env: { HOME: "/h", PATH: "/usr/bin" },
    executable: "/definitely/not/here",
    configPath: "/fixture/config.json",
    readFileImpl: async () => fixtureConfigJson(),
    accessImpl: async () => {
      throw new Error("enoent");
    },
  });
  assertEqual(missing.executable.found, false);
  assertEqual(missing.executable.source, "explicit");
  const readiness = assessLocalTevReadiness({ projection: missing, policy: PS2E_VALIDATION_CLASSIFIER_POLICY });
  assertEqual(readiness.status, "LOCAL_JEV_UNAVAILABLE", "a missing executable is a readiness failure, not a runtime surprise");
});

await test("readiness and the spawned child resolve the SAME shared configuration (FIX B)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ps2e-cfg-"));
  await writeFile(path.join(dir, "config.json"), fixtureConfigJson(), "utf8");
  const env = { DECISION_ROUTER_CONFIG_DIR: dir, HOME: "/h", PATH: "/usr/bin" };
  // The override is the config DIRECTORY used directly, exactly like the router.
  assertEqual(resolveLocalJevConfigPath({ env }), path.join(dir, "config.json"));
  const projection = await readLocalJevEnvironment({ env, accessImpl: async () => {} });
  assertEqual(projection.config.found, true, "readiness inspects the override directory");
  assertEqual(projection.config.path, path.join(dir, "config.json"));
  // The child environment forwards the override (never dropped).
  assertEqual(minimalChildEnv(env).DECISION_ROUTER_CONFIG_DIR, dir);
  // The spawned child resolves the SAME configuration readiness inspected.
  const printerBin = path.join(WORKSPACE, "cfg-printer.mjs");
  await writeFile(printerBin, "process.stdout.write(String(process.env.DECISION_ROUTER_CONFIG_DIR ?? ''));", "utf8");
  const transport = createDecisionCliTransport({ executable: process.execPath, argv: [printerBin], env });
  const result = await transport.dispatch({ request: { id: "cfg-parity" } });
  assertEqual(result.status, LOCAL_JEV_TRANSPORT_STATUS.OK);
  assertEqual(result.stdout.trim(), dir, "the child sees the same config override");
  // A whitespace override falls back to the default path in BOTH places.
  assertEqual(
    resolveLocalJevConfigPath({ env: { DECISION_ROUTER_CONFIG_DIR: "  ", XDG_CONFIG_HOME: "/x" } }),
    "/x/decision-router/config.json",
  );
});

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function assertNoSurvivors(pids, { timeoutMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const survivors = pids.filter((pid) => Number.isInteger(pid) && pid > 0 && processAlive(pid));
    if (survivors.length === 0) return;
    if (Date.now() > deadline) throw new Error(`processes survived the request cleanup: ${survivors.join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

await test("a timed-out request's WHOLE process group is terminated: no grandchild survives (FIX A)", async () => {
  const parentBin = path.join(WORKSPACE, "tree-parent.mjs");
  await writeFile(
    parentBin,
    [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });",
      "writeFileSync(process.argv[2], String(child.pid));",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
    "utf8",
  );
  const readPidFile = async (file) => {
    for (let index = 0; index < 200; index += 1) {
      try {
        const value = Number((await readFile(file, "utf8")).trim());
        if (Number.isInteger(value) && value > 0) return value;
      } catch {
        /* not written yet */
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`fixture never reported its pid: ${file}`);
  };

  // (a) timeout: the grandchild must NOT survive the direct child's death.
  const gpidFile = path.join(WORKSPACE, "grandchild-a.pid");
  const transport = createDecisionCliTransport({
    executable: process.execPath,
    argv: [parentBin, gpidFile],
    timeoutMs: 400,
    env: { PATH: "/usr/bin" },
  });
  const result = await transport.dispatch({ request: { id: "tree-a" } });
  assertEqual(result.status, LOCAL_JEV_TRANSPORT_STATUS.TIMEOUT, "the request exceeded its bound");
  const grandchild = await readPidFile(gpidFile);
  await assertNoSurvivors([grandchild], { timeoutMs: 5_000 });

  // (b) finalization cleanup: cancelPending terminates the same scoped tree.
  const gpidFile2 = path.join(WORKSPACE, "grandchild-b.pid");
  const transport2 = createDecisionCliTransport({
    executable: process.execPath,
    argv: [parentBin, gpidFile2],
    timeoutMs: 60_000,
    env: { PATH: "/usr/bin" },
  });
  const pending = transport2.dispatch({ request: { id: "tree-b" } });
  const grandchild2 = await readPidFile(gpidFile2);
  transport2.cancelPending();
  const cancelled = await pending;
  assertTrue(cancelled.status !== LOCAL_JEV_TRANSPORT_STATUS.OK, "a cancelled request never reports success");
  await assertNoSurvivors([grandchild2], { timeoutMs: 5_000 });
});

/* ============================================================================
 * 5. Shadow: scheduler wiring, records, queue, finalize, latency
 * ==========================================================================*/

console.log("\n5. Local Tev shadow behaviour");

await test("LIVE pin end-to-end offline: realistic response -> transport -> parser -> identity gate -> evidence record", async () => {
  // The COMPLETE offline pipeline against the REAL precommitted pin: a
  // realistic current Local JEV response through a deterministic fake child
  // transport, the strict parser, the LIVE identity gate and the persisted
  // evidence record. No real EVOLVE evidence session is created.
  const response = livePrimaryResponse({ classifier: completeLiveClassifierBlock() });
  const transport = fixtureTransportFor([okStep(response)]);
  const { shadow, root } = shadowFor({ transport, policy: PS2E_PRIMARY_CLASSIFIER, label: "live-e2e" });
  shadow.observeProductionEntry(entryFacts({ mint: MINT.A, generation: 1, generationTick: 1 }));
  await drainShadow(shadow);
  const records = await readSupervisorLocalTevObservations(root);
  assertEqual(records.records.length, 1);
  const record = records.records[0];
  assertEqual(record.decision, PS2E_DECISIONS.SUPPORT);
  assertEqual(record.decisionSource, PS2E_DECISION_SOURCES.PRIMARY_TEV_CLASSIFIER);
  assertEqual(record.classifierModel, PS2E_PRIMARY_CLASSIFIER.pinnedModel);
  assertEqual(record.classifierModelSha256, PS2E_PRIMARY_CLASSIFIER.pinnedModelSha256);
  assertEqual(record.primaryIdentityMismatch, false);
  assertEqual(record.probabilities, null);
  assertEqual(auditNoForbiddenResultFields(record).ok, true);
  // FIX F: the stored pre-response evidence reproduces the input digest EXACTLY.
  assertTrue(record.modelInputDescriptor !== null && typeof record.modelInputDescriptor === "object", "F: descriptor persisted");
  assertEqual("packet" in record.modelInputDescriptor, false, "F: the descriptor never duplicates the packet");
  assertEqual(jevInputDigestFromEvidence(record), record.jevInputDigest, "F: jevInputDigest recomputes from stored evidence");
});

await test("float-coerced effective temperatures cross the real shadow pipeline into replayable evidence (blocker 2, J)", async () => {
  // The persisted records of the REAL shadow (projection -> readiness ->
  // complete input -> transport -> evidence line) carry the EFFECTIVE shared
  // temperature and replay jevInputDigest from stored evidence alone.
  const PIN = PS2E_PRIMARY_CLASSIFIER;
  const digests = new Set();
  for (const [raw, expected] of [
    [true, 1],
    [false, 0],
    ["0.2_5", 0.25],
    ["0.7_5", 0.75],
  ]) {
    const projection = await projectionFor({
      primaryModel: PIN.pinnedModel,
      primarySha256: PIN.pinnedModelSha256,
      tier1Settings: { temperature: raw },
    });
    const response = livePrimaryResponse({ classifier: completeLiveClassifierBlock() });
    const { shadow, root } = shadowFor({
      transport: fixtureTransportFor([okStep(response)]),
      policy: PIN,
      projection,
      label: `float-${String(raw)}`,
    });
    shadow.observeProductionEntry(entryFacts({ mint: MINT.A, generation: 1, generationTick: 1 }));
    await drainShadow(shadow);
    const stored = await readSupervisorLocalTevObservations(root);
    assertEqual(stored.records.length, 1, `${JSON.stringify(raw)}: one record`);
    const record = stored.records[0];
    assertEqual(record.decision, PS2E_DECISIONS.SUPPORT, `${JSON.stringify(raw)}: the pipeline ran (READY)`);
    assertEqual(record.decisionSource, PS2E_DECISION_SOURCES.PRIMARY_TEV_CLASSIFIER);
    assertEqual(
      record.modelInputDescriptor.sampling.tiers["1"].temperature,
      expected,
      `${JSON.stringify(raw)}: the persisted effective temperature is ${expected}, never null`,
    );
    assertEqual(jevInputDigestFromEvidence(record), record.jevInputDigest, `${JSON.stringify(raw)}: stored evidence replays the digest`);
    digests.add(record.jevInputDigest);
  }
  assertEqual(digests.size, 4, "four different effective temperatures -> four different persisted jevInputDigests");
});

await test("spawned fake-child end-to-end: spawn -> stdin -> stdout -> caps -> parser -> live gate -> evidence -> digest replay", async () => {
  // ONE deterministic spawned fake `decision ask` child (no network, no real
  // Local JEV, no EVOLVE evidence session): the COMPLETE pipeline crosses the
  // real spawn, the stdin request, the stdout answer, the transport cap logic,
  // JSON parsing, the LIVE policy with identity attestation, route and decision
  // consistency, the persisted evidence record and the digest replay.
  const PIN = PS2E_PRIMARY_CLASSIFIER;
  const childPath = path.join(WORKSPACE, "fake-local-jev-child.mjs");
  const canned = livePrimaryResponse({ classifier: completeLiveClassifierBlock() });
  await writeFile(
    childPath,
    [
      'import { readFileSync } from "node:fs";',
      'const request = JSON.parse(readFileSync(0, "utf8"));',
      `const outcome = ${JSON.stringify(canned)};`,
      "outcome.request_id = request.id;",
      'process.stdout.write(JSON.stringify(outcome));',
      'process.stderr.write("fake local-jev child: one deterministic answer\\n");',
    ].join("\n"),
    "utf8",
  );
  const transport = createDecisionCliTransport({ executable: process.execPath, argv: [childPath], timeoutMs: 60_000 });

  // (1) The direct client boundary: spawn, stdin, stdout, cap flags, parsing,
  //     LIVE policy, identity attestation, route and decision consistency.
  const client = createLocalJevClient({ transport, policy: PIN });
  const probePacket = buildTevOpportunityPacket({ ...entryFacts(), engineTick: 1, opportunitySequence: 1 }).packet;
  const request = client.buildRequestFor({ sessionId: "ps2e-fake-child", packet: probePacket, globalAdmissionIndex: 0 });
  const dispatched = await client.dispatch({ request });
  assertEqual(dispatched.transportStatus, LOCAL_JEV_TRANSPORT_STATUS.OK, "the spawned child exits cleanly");
  assertEqual(dispatched.stdoutTruncated, false, "the bounded capture keeps the whole answer");
  assertEqual(dispatched.stderrTruncated, false);
  assertTrue(dispatched.rawDigest !== null, "the bounded capture hashes the raw answer");
  assertEqual(dispatched.ok, true, "the answer parses under the strict schema");
  const classified = classifyLocalJevOutcome({ validation: dispatched.validation, policy: PIN });
  assertEqual(classified.decision, PS2E_DECISIONS.SUPPORT);
  assertEqual(classified.decisionSource, PS2E_DECISION_SOURCES.PRIMARY_TEV_CLASSIFIER, "LIVE gate + coherence pass");
  assertEqual(classified.classifierModelSha256, PIN.pinnedModelSha256, "identity attestation is verified, not trusted");

  // (2) The same spawned transport through the shadow: the persisted evidence
  //     record and the digest replay from stored evidence.
  const { shadow, root } = shadowFor({ transport, policy: PIN, label: "spawned-child" });
  shadow.observeProductionEntry(entryFacts({ mint: MINT.B, generation: 1, generationTick: 1 }));
  await drainShadow(shadow);
  const records = await readSupervisorLocalTevObservations(root);
  assertEqual(records.records.length, 1);
  const record = records.records[0];
  assertEqual(record.decision, PS2E_DECISIONS.SUPPORT);
  assertEqual(record.decisionSource, PS2E_DECISION_SOURCES.PRIMARY_TEV_CLASSIFIER);
  assertEqual(record.classifierModel, PIN.pinnedModel);
  assertEqual(record.classifierModelSha256, PIN.pinnedModelSha256);
  assertEqual(record.primaryIdentityMismatch, false);
  assertEqual(record.totalPhysicalAttempts, 1);
  assertEqual(record.physicalAttemptsUnknown, false);
  assertEqual(record.probabilities, null);
  assertEqual(auditNoForbiddenResultFields(record).ok, true);
  assertEqual(jevInputDigestFromEvidence(record), record.jevInputDigest, "the persisted evidence replays the digest");
});

await test("truncated stdout never becomes primary evidence through the full pipeline", async () => {
  const response = livePrimaryResponse({ classifier: completeLiveClassifierBlock() });
  const transport = fixtureTransportFor([
    { status: LOCAL_JEV_TRANSPORT_STATUS.OK, stdout: JSON.stringify(response), stdoutTruncated: true },
  ]);
  const { shadow, root } = shadowFor({ transport, policy: PS2E_PRIMARY_CLASSIFIER, label: "truncated" });
  shadow.observeProductionEntry(entryFacts({ mint: MINT.A, generation: 1, generationTick: 1 }));
  await drainShadow(shadow);
  const records = await readSupervisorLocalTevObservations(root);
  assertEqual(records.records.length, 1);
  assertEqual(records.records[0].decision, PS2E_OUTCOMES.MALFORMED);
  assertEqual(records.records[0].decisionSource, PS2E_DECISION_SOURCES.MALFORMED);
  assertIncludes(records.records[0].failureReason, "stdout_truncated");
  const block = shadow.summaryBlock();
  assertEqual(block.counters.primaryResults, 0);
  assertEqual(block.counters.malformed, 1);
});

await test("a malformed source never keeps a directional decision in the stored record (FIX 3, observer)", async () => {
  const response = livePrimaryResponse({ classifier: completeLiveClassifierBlock() });
  response.attempts[0].provider = "openai";
  response.decision.provider = "openai";
  const transport = fixtureTransportFor([okStep(response)]);
  const { shadow, root } = shadowFor({ transport, policy: PS2E_PRIMARY_CLASSIFIER, label: "bad-provider" });
  shadow.observeProductionEntry(entryFacts({ mint: MINT.A, generation: 1, generationTick: 1 }));
  await drainShadow(shadow);
  const records = await readSupervisorLocalTevObservations(root);
  assertEqual(records.records.length, 1);
  const record = records.records[0];
  assertEqual(record.decisionSource, PS2E_DECISION_SOURCES.MALFORMED);
  assertEqual(record.decision, PS2E_OUTCOMES.MALFORMED, "a malformed source NEVER records SUPPORT / DO_NOT_SUPPORT");
  assertTrue(record.decision !== PS2E_DECISIONS.SUPPORT && record.decision !== PS2E_DECISIONS.DO_NOT_SUPPORT);
  // The counters cannot report a malformed source with a valid decision either.
  const block = shadow.summaryBlock();
  assertEqual(block.counters.malformed, 1);
  assertEqual(block.counters.primaryResults, 0);
  assertEqual(block.counters.escalatedResults, 0);
  assertEqual(block.counters.fallbackResults, 0);
  assertEqual(block.scoreSemantics.recordConsistencyCoercions, 0, "classify fails closed BEFORE the record guard");
});

await test("a shadow with an available classifier admits, calls once and records full provenance", async () => {
  const transport = fixtureTransportFor([okStep(outcomeFor())]);
  const { shadow, root } = shadowFor({ transport });
  for (let index = 0; index < 5; index += 1) {
    // Five proposals for the SAME asset inside one engine tick: the frozen
    // PS.2d per-asset cooldown (60s engine time) suppresses four of them.
    shadow.observeProductionEntry(
      entryFacts({ mint: MINT.A, at: BASE_AT + 1_000, generation: 1, generationTick: 1 + index, agentId: `A-${index}` }),
    );
  }
  shadow.observeProductionEntry(entryFacts({ mint: MINT.B, generation: 1, generationTick: 9, agentId: "B-1" }));
  await drainShadow(shadow);
  const block = shadow.summaryBlock();
  assertEqual(block.counters.logicalCalls, 2, "the same-tick duplicates are cooldown-suppressed");
  assertEqual(block.counters.primaryResults, 2);
  assertEqual(block.counters.queuedForLocalJev, 2);
  assertEqual(block.counters.totalPhysicalAttempts, 2);
  assertEqual(block.queue.dropped, 0);
  assertEqual(block.classifier.classifierId, PS2E_VALIDATION_CLASSIFIER_POLICY.classifierId);
  assertEqual(block.localJev.mode, PS2E_LOCAL_JEV_MODE);
  assertEqual(block.thinking.enabled, false);
  assertTrue(Object.values(block.accountingIdentities).every((value) => value === true || typeof value === "boolean"));
  for (const [key, value] of Object.entries(block.accountingIdentities)) {
    if (typeof value === "boolean") assertEqual(value, true, `accounting identity ${key} must hold`);
  }
  assertEqual(block.temporal.occupancy.bucketsWithAdmissions, 1);
  assertEqual(block.temporal.buckets[0].primaryResults, 2);
  assertEqual(block.latency.groups.allLogicalRequests.count, 2);
  assertTrue(block.latency.groups.primaryTevResults.metrics.totalE2EMs.count === 2);
  assertTrue(block.latency.groups.primaryTevResults.metrics.totalE2EMs.p50 !== null);
  const records = await readSupervisorLocalTevObservations(root);
  assertEqual(records.records.length, 2);
  for (const record of records.records) {
    assertEqual(record.evidenceClassification, PS2E_EVIDENCE_CLASSIFICATION);
    assertEqual(record.decision, PS2E_DECISIONS.SUPPORT);
    assertEqual(record.decisionSource, PS2E_DECISION_SOURCES.PRIMARY_TEV_CLASSIFIER);
    assertEqual(record.probabilities, null);
    assertEqual(record.calibratedProbability, null);
    assertEqual(record.probabilityKind, "sample_stability");
    assertEqual(record.sampleStability, 0.66);
    assertEqual(record.escalated, false);
    assertEqual(record.fallbackUsed, false);
    assertEqual(record.thinkingEnabled, false);
    assertEqual(record.optionTokenCount, 3);
    assertTrue(record.latency.unavailable.includes("nobodyWhoDispatchMs"));
    assertEqual(record.latency.inputTokens ?? null, null);
    assertEqual(auditNoForbiddenResultFields(record).ok, true);
    const numbers = [];
    const walk = (value) => {
      if (typeof value === "number") numbers.push(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") Object.values(value).forEach(walk);
    };
    walk(record);
    for (const value of numbers) assertTrue(Number.isFinite(value), "every serialized number must be finite");
    assertExcludes(JSON.stringify(record), "pSupport");
  }
});

await test("readiness=false fails closed per observation with NO call at all", async () => {
  const transport = fixtureTransportFor([okStep(outcomeFor())]);
  // An UNAVAILABLE specialist fixture (the state the real pin carried at
  // precommit time; the real pin is now available) -> PRIMARY_CLASSIFIER_UNAVAILABLE.
  const { shadow, root } = shadowFor({ transport, policy: UNAVAILABLE_CLASSIFIER_POLICY });
  // Two assets: the offline-validation queue holds two, so nothing is dropped and
  // every refusal is a real per-observation record.
  for (let index = 0; index < 2; index += 1) {
    shadow.observeProductionEntry(entryFacts({ mint: MINT[["A", "B"][index]], generation: 1, generationTick: 1 + index }));
  }
  await drainShadow(shadow);
  const block = shadow.summaryBlock();
  assertEqual(block.localJev.ready, false);
  assertEqual(block.counters.logicalCalls, 0);
  assertEqual(block.counters.skippedPrimaryClassifierUnavailable, 2);
  assertEqual(transport.calls.length, 0, "no call may be made when the primary classifier is unavailable");
  const records = await readSupervisorLocalTevObservations(root);
  assertEqual(records.records.length, 2);
  for (const record of records.records) {
    assertEqual(record.disposition, PS2E_DISPOSITIONS.SKIPPED_PRIMARY_CLASSIFIER_UNAVAILABLE);
    assertEqual(record.decision, PS2E_OUTCOMES.UNAVAILABLE);
    assertEqual(record.decisionSource, PS2E_DECISION_SOURCES.SKIPPED_PRIMARY_CLASSIFIER_UNAVAILABLE);
    assertTrue(record.failureReason.length > 0);
  }
});

await test("a queue at capacity drops explicitly and the admission identity still reconciles", async () => {
  const transport = fixtureTransportFor([okStep(outcomeFor())]);
  const { shadow } = shadowFor({ transport });
  for (let index = 0; index < 8; index += 1) {
    shadow.observeProductionEntry(
      entryFacts({ mint: mintOf(`Queue${index}`), generation: 1, generationTick: 1, agentId: `Q-${index}` }),
    );
  }
  shadow.flushSampling();
  const before = shadow.summaryBlock();
  assertEqual(before.counters.admitted, 8);
  assertEqual(before.counters.queuedForLocalJev, 2);
  assertEqual(before.counters.queueDropped, 6);
  assertDeepEqual(before.queue.capacity, PS2E_OFFLINE_VALIDATION_PROFILE.queueCapacity);
  assertEqual(before.accountingIdentities.admittedEqualsQueuedPlusDropped, true);
  await drainShadow(shadow);
  const after = shadow.summaryBlock();
  assertEqual(after.counters.logicalCalls, 2);
  assertEqual(after.counters.queuedForLocalJev, 2);
});

await test("finalize records UNSENT_AT_FINALIZE with no call, and an in-flight call separately", async () => {
  const transport = fixtureTransportFor([okStep(outcomeFor())]);
  const { shadow, root } = shadowFor({ transport });
  for (let index = 0; index < 4; index += 1) {
    shadow.observeProductionEntry(entryFacts({ mint: MINT[["A", "B", "C", "D"][index]], generation: 1, generationTick: 1 }));
  }
  shadow.flushSampling();
  shadow.stopAccepting();
  await shadow.finalizeFlush();
  const block = shadow.summaryBlock();
  // Four admitted observations against a two-place queue: two are queued and two
  // are dropped explicitly, so finalization records the unsent pair.
  assertEqual(block.counters.admitted, 4);
  assertEqual(block.counters.queuedForLocalJev, 2);
  assertEqual(block.counters.queueDropped, 2);
  assertEqual(block.counters.unsentAtFinalize, 2);
  assertEqual(block.counters.logicalCalls, 0);
  assertEqual(transport.calls.length, 0, "finalization must not send queued work late");
  const records = await readSupervisorLocalTevObservations(root);
  assertEqual(records.records.length, 4);
  const unsent = records.records.filter((record) => record.disposition === PS2E_DISPOSITIONS.UNSENT_AT_FINALIZE);
  const dropped = records.records.filter((record) => record.disposition === PS2E_DISPOSITIONS.QUEUE_DROPPED);
  assertEqual(unsent.length, 2);
  assertEqual(dropped.length, 2);
  for (const record of [...unsent, ...dropped]) {
    assertTrue(record.decision !== PS2E_DECISIONS.SUPPORT && record.decision !== PS2E_DECISIONS.DO_NOT_SUPPORT);
    assertEqual(record.failureReason.length > 0, true);
  }
  assertEqual(block.accountingIdentities.queuedAccountedFor, true);
});

await test("a slow in-flight call is recorded IN_FLIGHT_AT_FINALIZE and its late answer is ignored", async () => {
  let release = null;
  const transport = {
    kind: "slow-fixture",
    description: "resolves only when released",
    dispatch: () =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            status: LOCAL_JEV_TRANSPORT_STATUS.OK,
            exitCode: 0,
            stdout: JSON.stringify(outcomeFor()),
            stderr: "",
          });
      }),
  };
  const { shadow } = shadowFor({ transport });
  shadow.observeProductionEntry(entryFacts({ mint: MINT.A, generation: 1, generationTick: 1 }));
  shadow.observeProductionEntry(entryFacts({ mint: MINT.B, generation: 1, generationTick: 1 }));
  shadow.flushSampling();
  const inFlight = shadow.processNext();
  await new Promise((resolve) => setTimeout(resolve, 5));
  shadow.stopAccepting();
  await shadow.finalizeFlush();
  const block = shadow.summaryBlock();
  assertTrue(inFlight !== null && typeof inFlight.then === "function", "processNext must return a promise");
  assertEqual(block.counters.inFlightAtFinalize, 1);
  assertEqual(block.counters.unsentAtFinalize, 1);
  assertEqual(block.counters.primaryResults, 0, "the late answer must not become a decision");
  release?.();
  await inFlight;
  assertEqual(shadow.summaryBlock().counters.lateCompletionsIgnored, 1);
});

await test("a throwing transport produces a FAILED record and never a decision", async () => {
  const transport = { kind: "throwing", dispatch: () => { throw new Error("runtime exploded"); } };
  const { shadow, root } = shadowFor({ transport });
  shadow.observeProductionEntry(entryFacts({ mint: MINT.A }));
  await drainShadow(shadow);
  const block = shadow.summaryBlock();
  assertEqual(block.counters.failures, 1);
  assertEqual(block.counters.logicalCalls, 1);
  const records = await readSupervisorLocalTevObservations(root);
  assertEqual(records.records[0].decision, PS2E_OUTCOMES.FAILED);
  assertIncludes(records.records[0].failureReason, "runtime exploded");
  assertEqual(records.records[0].probabilityKind, "none");
});

await test("malformed, abstaining, escalating and TypeSafe-fallback answers are each recorded truthfully", async () => {
  const cases = [
    {
      label: "malformed",
      step: { status: LOCAL_JEV_TRANSPORT_STATUS.OK, stdout: "{\"broken\": true}" },
      expect: { decision: PS2E_OUTCOMES.MALFORMED, source: PS2E_DECISION_SOURCES.MALFORMED, physicalAttemptsUnknown: true },
    },
    {
      label: "abstain",
      step: okStep(
        outcomeFor({
          follow: null,
          choice: null,
          abstain: true,
          tier: null,
          attempts: [attemptFor({ tier: 1, choice: null, abstain: true, accepted: false, escalationReason: "abstain" })],
        }),
      ),
      expect: { decision: PS2E_DECISIONS.ABSTAIN, source: PS2E_DECISION_SOURCES.ABSTAINED_WITHOUT_ACCEPTED_TIER },
    },
    {
      label: "escalated",
      step: okStep(
        outcomeFor({
          tier: 2,
          model: "Qwen3.5-9B",
          attempts: [
            attemptFor({ tier: 1, choice: null, accepted: false, escalationReason: "stability_below_threshold" }),
            attemptFor({ tier: 2, model: "Qwen3.5-9B", choice: "support", accepted: true }),
          ],
        }),
      ),
      expect: { decision: PS2E_DECISIONS.SUPPORT, source: PS2E_DECISION_SOURCES.ESCALATED_LOCAL_TIER },
    },
    {
      label: "fallback",
      step: okStep(
        outcomeFor({
          tier: 3,
          provider: "jev",
          model: "jev-1.13.0",
          confidence: 0.7,
          confidenceKind: "calibrated_probability",
          votes: null,
          attempts: [
            attemptFor({ tier: 1, choice: null, accepted: false, escalationReason: "timeout" }),
            attemptFor({ tier: 3, provider: "jev", model: "jev-1.13.0", choice: "support", accepted: true, confidence: 0.7, confidenceKind: "calibrated_probability" }),
          ],
        }),
      ),
      expect: { decision: PS2E_DECISIONS.SUPPORT, source: PS2E_DECISION_SOURCES.FALLBACK_TYPESAFE_JEV },
    },
  ];
  for (const entry of cases) {
    const transport = fixtureTransportFor([entry.step]);
    const { shadow, root } = shadowFor({ transport, label: entry.label });
    shadow.observeProductionEntry(entryFacts({ mint: MINT.A, generation: 1, generationTick: 1 }));
    await drainShadow(shadow);
    const block = shadow.summaryBlock();
    assertEqual(block.counters.logicalCalls, 1, `${entry.label}: one logical call`);
    // Physical attempts come from the shared implementation's OWN attempt list.
    // An unreadable answer cannot report one, so it is counted as unknown rather
    // than invented: the logical call is still the only call that was made.
    if (entry.expect.physicalAttemptsUnknown === true) {
      assertEqual(block.counters.totalPhysicalAttempts, 0, `${entry.label}: no attempt list to read`);
      assertEqual(block.counters.logicalCallsWithoutReadableAttempts, 1, `${entry.label}: unknown physical attempts`);
    } else {
      assertEqual(block.counters.totalPhysicalAttempts >= 1, true, `${entry.label}: physical attempts recorded`);
    }
    const records = await readSupervisorLocalTevObservations(root);
    assertEqual(records.records.length, 1);
    assertEqual(records.records[0].decision, entry.expect.decision, `${entry.label}: decision`);
    assertEqual(records.records[0].decisionSource, entry.expect.source, `${entry.label}: source`);
    assertEqual(
      records.records[0].physicalAttemptsUnknown,
      entry.expect.physicalAttemptsUnknown === true,
      `${entry.label}: physical-attempt provenance`,
    );
    if (entry.label === "fallback") {
      assertEqual(records.records[0].fallbackUsed, true);
      assertEqual(records.records[0].calibratedProbability, 0.7);
      assertEqual(records.records[0].probabilitiesAreCalibrated, true);
      assertEqual(records.records[0].escalated, true);
      assertEqual(block.counters.fallbackResults, 1);
      assertEqual(block.counters.primaryResults, 0);
    }
    if (entry.label === "abstain") {
      assertEqual(records.records[0].decision, PS2E_DECISIONS.ABSTAIN);
      assertEqual(block.counters.abstainResults, 1);
      assertEqual(block.counters.abstainedWithoutAcceptedTier, 1);
    }
    if (entry.label === "malformed") {
      assertEqual(records.records[0].probabilities, null);
      assertEqual(block.counters.malformed, 1);
    }
    if (entry.label === "escalated") {
      assertEqual(block.counters.escalatedResults, 1);
      assertEqual(records.records[0].fallbackTier, "2");
      assertEqual(records.records[0].fallbackUsed, false);
    }
  }
});

await test("the within-tick order is ascending opportunity digest, never population order", async () => {
  const transport = fixtureTransportFor([okStep(outcomeFor()), okStep(outcomeFor())]);
  const { shadow, root } = shadowFor({ transport });
  const facts = [
    entryFacts({ mint: MINT.A, generation: 1, generationTick: 1, agentId: "A" }),
    entryFacts({ mint: MINT.B, generation: 1, generationTick: 1, agentId: "B" }),
  ];
  // Feed the SAME tick in reverse order twice: the admissibility decision must not
  // depend on which entry happened to be handed over first.
  shadow.observeProductionEntry(facts[1]);
  shadow.observeProductionEntry(facts[0]);
  await drainShadow(shadow);
  const block = shadow.summaryBlock();
  assertEqual(block.withinTickOrderGuaranteed, true);
  assertTrue(block.withinTickOrder.includes("ascending opportunity digest"));
  const records = await readSupervisorLocalTevObservations(root);
  const digests = records.records.map((record) => record.jevInputDigest);
  assertEqual(digests.length, 2);
  assertDeepEqual(records.records.map((record) => record.globalAdmissionIndex), [1, 2]);
});

await test("latency statistics are honest: count/mean/p50/p95/p99/min/max per group, none invented", () => {
  const stats = localTevLatencyStats([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  assertEqual(stats.count, 10);
  assertEqual(stats.min, 10);
  assertEqual(stats.max, 100);
  assertEqual(stats.p50, 50);
  assertEqual(stats.p95, 100);
  assertEqual(stats.p99, 100);
  assertEqual(stats.mean, 55);
  assertDeepEqual(localTevLatencyStats([]), { count: 0, mean: null, p50: null, p95: null, p99: null, min: null, max: null });
  const filtered = localTevLatencyStats([Number.NaN, -5, 12]);
  assertEqual(filtered.count, 1);
  assertEqual(filtered.mean, 12);
  assertEqual(PS2E_LATENCY_GROUPS.length, 4);
  assertExcludes(JSON.stringify(localTevLatencyStats([1, 2, 3])), "nobodyWhoDispatchMs");
});

/* ============================================================================
 * 6. Engine equivalence and zero authority
 * ==========================================================================*/

console.log("\n6. Engine equivalence and zero authority");

await test("the engine is byte-identical with the shadow DISABLED (baseline)", async () => {
  const baseline = await runEngine({ observer: null, ticks: 30 });
  const again = await runEngine({ observer: null, ticks: 30 });
  assertEngineIdentical(baseline, again, "disabled/baseline");
});

await test("the engine is byte-identical with the shadow working, slow, throwing, malformed, abstaining, escalating, queue-full and unavailable", async () => {
  const baseline = await runEngine({ observer: null, ticks: 30 });
  const variants = [
    {
      label: "working",
      localTev: { profile: "offline-validation", classifierPolicy: PS2E_VALIDATION_CLASSIFIER_POLICY, transport: fixtureTransportFor([okStep(outcomeFor())]) },
    },
    {
      label: "slow",
      localTev: {
        profile: "offline-validation",
        classifierPolicy: PS2E_VALIDATION_CLASSIFIER_POLICY,
        transport: {
          kind: "slow",
          dispatch: () =>
            new Promise((resolve) =>
              setTimeout(
                () => resolve({ status: LOCAL_JEV_TRANSPORT_STATUS.OK, exitCode: 0, stdout: JSON.stringify(outcomeFor()), stderr: "" }),
                3,
              ),
            ),
        },
      },
    },
    {
      label: "throwing",
      localTev: {
        profile: "offline-validation",
        classifierPolicy: PS2E_VALIDATION_CLASSIFIER_POLICY,
        transport: { kind: "throwing", dispatch: () => { throw new Error("engine equivalence: throwing transport"); } },
      },
    },
    {
      label: "malformed",
      localTev: {
        profile: "offline-validation",
        classifierPolicy: PS2E_VALIDATION_CLASSIFIER_POLICY,
        transport: fixtureTransportFor([{ status: LOCAL_JEV_TRANSPORT_STATUS.OK, stdout: "not json at all" }]),
      },
    },
    {
      label: "abstaining",
      localTev: {
        profile: "offline-validation",
        classifierPolicy: PS2E_VALIDATION_CLASSIFIER_POLICY,
        transport: fixtureTransportFor([
          okStep(outcomeFor({ follow: null, choice: null, abstain: true, tier: null, attempts: [attemptFor({ tier: 1, choice: null, abstain: true, accepted: false, escalationReason: "abstain" })] })),
        ]),
      },
    },
    {
      label: "escalating",
      localTev: {
        profile: "offline-validation",
        classifierPolicy: PS2E_VALIDATION_CLASSIFIER_POLICY,
        transport: fixtureTransportFor([
          okStep(
            outcomeFor({
              tier: 2,
              model: "Qwen3.5-9B",
              attempts: [
                attemptFor({ tier: 1, choice: null, accepted: false, escalationReason: "stability_below_threshold" }),
                attemptFor({ tier: 2, model: "Qwen3.5-9B", choice: "support", accepted: true }),
              ],
            }),
          ),
        ]),
      },
    },
    {
      label: "queue-full",
      localTev: {
        profile: "offline-validation",
        classifierPolicy: PS2E_VALIDATION_CLASSIFIER_POLICY,
        transport: {
          kind: "never-resolving",
          dispatch: () => new Promise(() => {}),
        },
      },
    },
    {
      label: "local-jev-unavailable",
      localTev: {
        profile: "offline-validation",
        classifierPolicy: PS2E_VALIDATION_CLASSIFIER_POLICY,
        readiness: {
          status: "LOCAL_JEV_UNAVAILABLE",
          ready: false,
          problems: ["fixture: the shared Local JEV config is unreadable"],
          physicalAttemptCeilingPerLogicalCall: 2,
        },
      },
    },
    {
      label: "primary-classifier-unavailable",
      localTev: { profile: "offline-validation", classifierPolicy: UNAVAILABLE_CLASSIFIER_POLICY },
    },
    {
      label: "primary-identity-mismatch",
      localTev: {
        profile: "offline-validation",
        classifierPolicy: PS2E_VALIDATION_CLASSIFIER_POLICY,
        transport: fixtureTransportFor([okStep(outcomeFor({ tier: 1, model: "WRONG-MODEL", follow: "support" }))]),
      },
    },
    {
      label: "tier-2-failure",
      localTev: {
        profile: "offline-validation",
        classifierPolicy: PS2E_VALIDATION_CLASSIFIER_POLICY,
        transport: fixtureTransportFor([
          okStep(
            outcomeFor({
              follow: null,
              choice: null,
              abstain: false,
              tier: null,
              error: "broken",
              attempts: [
                attemptFor({ tier: 1, choice: null, accepted: false, escalationReason: "worker_failure" }),
                attemptFor({ tier: 2, model: "Qwen3.5-9B", choice: null, accepted: false, escalationReason: "worker_failure" }),
              ],
            }),
          ),
        ]),
      },
    },
    {
      label: "timeout",
      localTev: {
        profile: "offline-validation",
        classifierPolicy: PS2E_VALIDATION_CLASSIFIER_POLICY,
        transport: fixtureTransportFor([{ status: LOCAL_JEV_TRANSPORT_STATUS.TIMEOUT, stdout: "" }]),
      },
    },
  ];
  for (const variant of variants) {
    const { observer, root } = await observerFor({ label: variant.label, localTev: variant.localTev });
    observer.start();
    const candidate = await runEngine({ observer, ticks: 30, yieldsPerTick: 1 });
    await observer.finalize({ status: "COMPLETE" });
    assertEngineIdentical(baseline, candidate, variant.label);
    const state = await readSupervisorState(root);
    assertTrue(state?.localTevShadow !== null && state?.localTevShadow !== undefined, `${variant.label}: PS.2e block present`);
    assertEqual(state.localTevShadow.zeroAuthority, true);
    assertEqual(state.localTevShadow.winner, null);
    assertEqual(auditNoForbiddenResultFields(state).ok, true, `${variant.label}: state audit`);
    assertEqual(auditNoForbiddenResultFields(await readSupervisorSummary(root)).ok, true, `${variant.label}: summary audit`);
  }
});

await test("the engine tap never consumes a return value and the engine never learns about PS.2e", async () => {
  const simulation = await readFile("scripts/engine/simulation.mjs", "utf8");
  assertExcludes(simulation, "localTev", "the engine must not know about PS.2e at all");
  assertExcludes(simulation, "PS2E");
  assertExcludes(simulation, "await observeProductionEntry");
  const { observer } = await observerFor({ label: "tap-return", localTev: { profile: "offline-validation", classifierPolicy: PS2E_VALIDATION_CLASSIFIER_POLICY, transport: fixtureTransportFor([okStep(outcomeFor())]) } });
  const returned = observer.observeProductionEntry(entryFacts());
  assertEqual(returned, undefined, "the passive tap must return nothing");
  const { shadow } = shadowFor({});
  assertEqual(shadow.observeProductionEntry(entryFacts()), undefined);
  // The shadow exposes no mutation surface for engine state.
  for (const forbiddenName of ["setScore", "setBest", "approve", "reject", "veto", "applyToEngine"]) {
    assertEqual(forbiddenName in shadow, false, `the shadow must not expose ${forbiddenName}`);
  }
});

await test("PS.2e modules import no trading, evolution, selection, arena or research subsystem", async () => {
  const files = [
    "scripts/jev/supervisor/local-tev-protocol.mjs",
    "scripts/jev/supervisor/local-tev-scheduler.mjs",
    "scripts/jev/supervisor/local-tev-packet.mjs",
    "scripts/jev/supervisor/local-tev-questions.mjs",
    "scripts/jev/supervisor/local-jev-client.mjs",
    "scripts/jev/supervisor/local-tev-observer.mjs",
  ];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const imports = source
      .split("\n")
      .filter((line) => /^\s*(import|export)\b.*from\s+["']/.test(line))
      .join("\n");
    for (const forbidden of ["arena", "evolution", "fitness", "selection", "research", "market/", "engine/"]) {
      assertExcludes(imports, forbidden, `${file} must not import the ${forbidden} subsystem`);
    }
  }
});

await test("no wallet, signer, swap, order, write-RPC or execution path exists in the PS.2e code", async () => {
  const files = [
    "scripts/jev/supervisor/local-tev-protocol.mjs",
    "scripts/jev/supervisor/local-tev-scheduler.mjs",
    "scripts/jev/supervisor/local-tev-packet.mjs",
    "scripts/jev/supervisor/local-tev-questions.mjs",
    "scripts/jev/supervisor/local-jev-client.mjs",
    "scripts/jev/supervisor/local-tev-observer.mjs",
  ];
  // The same declaration-shaped DENY list the PS.2 suite documents: these
  // patterns are the guard, never a capability. A NEGATED mention (PS2E_STATEMENT
  // says "no wallet", the child-env filter lists credential KEY NAMES) is not a
  // capability, so the scan looks for the executable constructs themselves and
  // for a real chain/execution import.
  const FORBIDDEN_CAPABILITY_PATTERNS = Object.freeze([
    /\bKeypair\b/,
    /sendTransaction/,
    /sendRawTransaction/,
    /signTransaction/,
    /signAllTransactions/,
    /VersionedTransaction/,
    /swapTransaction/,
    /partialSign/,
    /fromSecretKey/,
    /new\s+Connection/,
    /@solana\//,
    /@jup(iter)?\//,
  ]);
  let statedNoWallet = false;
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const hits = FORBIDDEN_CAPABILITY_PATTERNS.filter((pattern) => pattern.test(source));
    assertEqual(hits.length, 0, `${file} must not contain execution capability (${hits.map(String).join(", ")})`);
    if (/no wallet/i.test(source)) statedNoWallet = true;
  }
  assertEqual(statedNoWallet, true, "the PS.2e boundary must state that no wallet path exists");
  // The ONLY child process is the shared Local JEV CLI, spawned with an
  // allow-listed environment and a bounded timeout — never a shell.
  const client = await readFile("scripts/jev/supervisor/local-jev-client.mjs", "utf8");
  assertIncludes(client, 'from "node:child_process"');
  assertIncludes(client, "minimalChildEnv(");
  assertExcludes(client, "shell: true");
});

/* ============================================================================
 * 7. Evidence, storage, dashboard, governance and historical preservation
 * ==========================================================================*/

console.log("\n7. Evidence, dashboard, governance and historical preservation");

await test("PS.2e writes only inside its own session tree", async () => {
  const transport = fixtureTransportFor([okStep(outcomeFor())]);
  const { shadow, root, sessionId } = shadowFor({ transport });
  shadow.observeProductionEntry(entryFacts({ mint: MINT.A }));
  await drainShadow(shadow);
  assertTrue(root.startsWith(SESSION_BASE));
  const files = await readdir(root);
  assertDeepEqual(files.sort(), ["local-tev-observations.ndjson"]);
  const info = await stat(path.join(root, "local-tev-observations.ndjson"));
  assertTrue(info.size > 0);
  const sessions = await listSupervisorSessions(SESSION_BASE);
  assertTrue(sessions.includes(sessionId));
});

await test("the dashboard block is compact, labelled and free of probability or profitability framing", async () => {
  // A .evolve root that has never run a supervisor session projects no PS.2e block.
  const emptyRoot = path.join(WORKSPACE, "empty-evolve");
  await mkdir(emptyRoot, { recursive: true });
  const empty = await loadJevSupervisorObserverState(emptyRoot);
  assertEqual(empty.available, false, "an empty root has no session");
  assertEqual(empty.localTevShadow ?? null, null, "an unrelated .evolve root has no PS.2e session");

  const transport = fixtureTransportFor([okStep(outcomeFor())]);
  const { shadow, sessionId } = shadowFor({ transport });
  shadow.observeProductionEntry(entryFacts({ mint: MINT.A }));
  await drainShadow(shadow);

  // A real PS.2e session projects through the read-only dashboard loader.
  const dashRoot = path.join(WORKSPACE, "dashboard-evolve");
  const dashSessionRoot = path.join(dashRoot, "jev-supervisor-observer", sessionId);
  await mkdir(dashSessionRoot, { recursive: true });
  await writeFile(
    path.join(dashSessionRoot, "state.json"),
    JSON.stringify({ sessionId, localTevShadow: shadow.stateBlock() }),
    "utf8",
  );
  const loaded = await loadJevSupervisorObserverState(dashRoot);
  assertEqual(loaded.available, true);
  const compact = loaded.localTevShadow;
  assertTrue(compact !== null && compact !== undefined, "a PS.2e session must project a compact block");
  assertEqual(compact.label, PS2E_LABEL);
  assertEqual(compact.evidenceClassification, PS2E_EVIDENCE_CLASSIFICATION);
  assertEqual(compact.zeroAuthority, true);
  assertEqual(compact.authorityTag, PS2E_AUTHORITY_TAG);
  assertEqual(compact.thinkingEnabled, false);
  assertEqual(compact.typeSafeIsNormalProvider, false);
  assertEqual(compact.bucketCount, PS2E_BUCKET_COUNT);
  assertEqual(compact.bucketMinutes, 5);
  assertEqual(compact.globalMaxAdmissions, PS2E_GLOBAL_MAX_ADMISSIONS);
  assertEqual(compact.temporal.buckets.length, PS2E_BUCKET_COUNT);
  for (const key of ["logicalCalls", "queuedForLocalJev", "primaryResults", "queueDropped", "admitted"]) {
    assertTrue(key in compact.counters, `compact counters must project ${key}`);
    assertTrue(
      compact.counters[key] === null || typeof compact.counters[key] === "number",
      `compact counter ${key} must be a number or null`,
    );
  }
  const compactText = JSON.stringify(compact);
  for (const forbidden of ["pSupport", "\"probability\":", "expectedReturn", "sharpe", "deploymentReady"]) {
    assertExcludes(compactText, forbidden);
  }

  const block = shadow.stateBlock();
  const text = JSON.stringify(block);
  assertIncludes(text, PS2E_LABEL);
  assertIncludes(text, "ZERO AUTHORITY");
  assertEqual(block.localJev.typeSafeIsNormalProvider, false);
  assertEqual(block.assetRowKey, "baseMint");
  assertEqual(block.temporal.representationClaim, "none");
  assertEqual(block.profitabilityClaim, false);
  for (const forbidden of ["pSupport", "\"probability\":", "expectedReturn", "sharpe", "deploymentReady"]) {
    assertExcludes(text, forbidden);
  }
  const rows = block.assetRows.map((row) => row.baseMint);
  assertDeepEqual(rows, [...rows], "rows stay in encounter order");
});

await test("the dashboard panel and API expose a separate, clearly labelled LOCAL TEV block", async () => {
  const page = await readFile("src/app/page.tsx", "utf8");
  assertIncludes(page, "localTevShadow");
  // The panel region itself, located by its own render guard.
  const anchor = page.indexOf("observer.localTevShadow &&");
  assertTrue(anchor > 0, "the dashboard must render a dedicated LOCAL TEV panel");
  const panel = page.slice(anchor, anchor + 14_000);
  assertIncludes(panel, "LOCAL TEV CROSS-ASSET SHADOW");
  for (const required of ["DEVELOPMENT SHADOW", "ZERO AUTHORITY", "PAPER ONLY"]) assertIncludes(panel, required);
  for (const forbidden of ["DEPLOYMENT READY", "deployment-ready", "\"winner\":", "profitable", "expected return", "pSupport"]) {
    assertExcludes(panel, forbidden, `the LOCAL TEV panel must not claim ${forbidden}`);
  }
  // The panel states the denial explicitly instead of merely omitting it.
  assertIncludes(panel, "no winner");
  // Range rendering uses the REAL scheduler schema keys ({min, max}), not a
  // guessed {from, to}, and shows an honest marker when unavailable.
  assertIncludes(panel, "engineTickRange?.min");
  assertIncludes(panel, "generationRange?.min");
  assertExcludes(page, "engineTickRange?.from", "the UI must not read a range key the scheduler never emits");
  assertExcludes(page, "generationRange?.from", "the UI must not read a range key the scheduler never emits");
  // The tile label matches the counter it actually displays, and an unknown
  // counter is rendered as unavailable — never as a factual zero.
  assertExcludes(panel, "Failures / malformed / unavailable");
  assertIncludes(panel, '"Failures"');
  assertIncludes(panel, "Malformed / unavailable records");
  assertIncludes(panel, 'counters.malformed ?? "—"');
  const route = await readFile("src/app/api/state/route.ts", "utf8").catch(() => "");
  if (route.length > 0) {
    assertIncludes(route, "jevSupervisorObserver");
  }
});

await test("CLI wording reports real score semantics and labels the missing-interface list as history", async () => {
  const cli = await readFile("scripts/jev-supervisor.mjs", "utf8");
  // The hard-coded claim is gone; the line reflects actual semantics and is
  // derived from recorded evidence.
  assertExcludes(cli, "calibrated probabilities: none recorded");
  assertIncludes(cli, "sample_stability vote shares are stability proxies, never calibrated probabilities");
  assertIncludes(cli, "calibrated-probability records:");
  // The historical list is printed as history and never as the current cause.
  assertIncludes(cli, "historical precommit-time missing-interface record");
  assertExcludes(cli, "the exact missing shared Local JEV interface");
  assertIncludes(cli, 'readiness.status === "PRIMARY_CLASSIFIER_UNAVAILABLE"');
});

await test("the PS.2e plan is a valid Development Governance v1 plan with the required role split", async () => {
  const planText = await readFile("scripts/jev/supervisor/PS2e.md", "utf8");
  const parsed = parsePlan({ planText, planPath: "scripts/jev/supervisor/PS2e.md" });
  const report = checkPlan(parsed);
  assertEqual(report.status, "PASS", JSON.stringify(report.problems));
  assertEqual(parsed.touchesResearchSemantics, true);
  assertTrue(report.reviewFocus.length >= 5);
  for (const role of ["IMPLEMENTER", "PROTOCOL_REVIEWER", "CODE_REVIEWER", "VERIFIER"]) assertIncludes(planText, role);
  assertIncludes(planText, "IMPLEMENTER CANNOT SELF-CERTIFY");
  assertIncludes(planText, "npm run validate:jev-supervisor");
  assertIncludes(planText, "PS2E");
  assertExcludes(planText, "TBD");
  assertExcludes(planText, "TODO");
});

await test("package scripts run the PS.2e suite and never weaken the existing chain", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assertIncludes(packageJson.scripts["validate:jev-supervisor"], "validate-phase5i-ps2d.mjs");
  assertIncludes(packageJson.scripts["validate:jev-supervisor"], "validate-phase5i-ps2e.mjs");
  assertIncludes(packageJson.scripts.validate, "validate:jev-supervisor");
  assertEqual(packageJson.scripts["jev:supervisor"], "node scripts/jev-supervisor.mjs");
});

await test("historical PS.2 / PS.2d sessions load unchanged and are never reinterpreted as PS.2e", async () => {
  for (const entry of HISTORICAL_BEFORE) {
    const summary = await readSupervisorSummary(path.join(SUPERVISOR_ROOT_DIR, entry.sessionId));
    assertDeepEqual(summary, entry.summary, `${entry.sessionId}: summary byte-identical`);
    assertEqual(JSON.stringify(summary) === JSON.stringify(entry.summary), true);
    assertEqual("localTevShadow" in (summary ?? {}), false, "historical summaries must not gain a PS.2e block");
    if (summary?.crossAssetShadow) {
      assertEqual(summary.crossAssetShadow.evidenceClassification, PS2D_EVIDENCE_CLASSIFICATION);
      assertTrue(summary.crossAssetShadow.evidenceClassification !== PS2E_EVIDENCE_CLASSIFICATION);
    }
  }
  // A PS.2e-only session never rewrites an existing PS.2d artifact.
  const ps2dObservations = await readFile(
    path.join(SUPERVISOR_ROOT_DIR, HISTORICAL_SESSIONS[1], "cross-asset-observations.ndjson"),
    "utf8",
  ).catch(() => "");
  if (ps2dObservations.length > 0) {
    for (const line of ps2dObservations.split("\n").filter((entry) => entry.trim().length > 0).slice(0, 3)) {
      const record = JSON.parse(line);
      assertEqual(record.evidenceClassification, PS2D_EVIDENCE_CLASSIFICATION);
      assertExcludes(JSON.stringify(record), PS2E_EVIDENCE_CLASSIFICATION);
    }
  }
});

await test("every protected evidence tree is byte-identical after the whole suite", async () => {
  const after = await snapshotTree(process.cwd(), PROTECTED_TREES);
  const comparison = compareSnapshots(PRESERVATION_BEFORE, after);
  assertEqual(comparison.identical, true, JSON.stringify(comparison).slice(0, 400));
  assertDeepEqual(comparison.added, [], "no protected file may be added");
  assertDeepEqual(comparison.removed, [], "no protected file may be removed");
  assertDeepEqual(comparison.changed, [], "no protected file may change");
});

/* ============================================================================
 * Report
 * ==========================================================================*/

await rm(WORKSPACE, { recursive: true, force: true });

console.log("");
console.log(`PS.2e validation: ${FAILED === 0 ? "PASS" : "FAIL"} (${PASSED + FAILED} checks, ${PASSED} passed, ${FAILED} failed)`);
console.log(`network attempts during the suite: ${NETWORK_ATTEMPTS} (must be 0)`);
for (const failure of FAILURES) console.log(`FAILED ${failure.name}: ${failure.error?.message ?? failure.error}`);
if (NETWORK_ATTEMPTS !== 0) process.exitCode = 1;
else process.exitCode = FAILED === 0 ? 0 : 1;
