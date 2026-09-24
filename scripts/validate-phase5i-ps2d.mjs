#!/usr/bin/env node
/**
 * EVOLVE Phase 5I-PS.2d — CROSS-ASSET PRODUCTION SHADOW validation suite.
 * FULLY OFFLINE. DEVELOPMENT SHADOW • ZERO AUTHORITY.
 *
 * Proves that the passive supervisor can consume a bounded, deterministic,
 * prospectively frozen sample of GENUINE EVOLVE production entry proposals
 * across assets without changing anything in EVOLVE:
 *
 *   - only the finalized production entry proposal is eligible (never exits,
 *     unselected markets, below-threshold selections, gate failures, PS.2a/b/c
 *     facts or counterfactual passes);
 *   - the complete-input digest covers every model-visible byte;
 *   - the sampler is deterministic, asset-independent outside the global cap,
 *     and never random, performance-, outcome- or Jev-dependent;
 *   - the engine is byte-identical with the supervisor disabled, working, slow,
 *     throwing, malformed and queue-full, and for any Jev answer;
 *   - SOL paths, historical sessions and every protected tree are unchanged.
 *
 * NOTHING HERE TOUCHES THE NETWORK, A PROVIDER, A WALLET OR A CHAIN. Every
 * provider is a local async function and every session lives in a temp dir.
 *
 * Run with: npm run validate:jev-supervisor (after the PS.2 suite).
 */

import { cp, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
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
  throw new Error("network is forbidden in the Phase 5I-PS.2d validation suite");
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

const { canonicalJson, digestOf, sha256Hex } = await import("./lib/hash.mjs");
const { createMarketConfig } = await import("./market/config.mjs");
const { createSeededRandom } = await import("./lib/random.mjs");
const { createIdFactory } = await import("./lib/ids.mjs");
const { deriveMarket, MOMENTUM_REFERENCE } = await import("./market/normalize.mjs");
const { createSimulation, assessPoolAgeCounterfactual } = await import("./engine/simulation.mjs");
const { MAX_POOL_AGE_UNBOUNDED } = await import("./engine/genome.mjs");
const { DIRECTION_QUESTION_NAME, DIRECTION_QUESTION_SET_ID } = await import("./jev/direction/questions.mjs");
const { BENCHMARK_MARKET } = await import("./jev/direction/definition.mjs");
const { JEV_RETRY_AFTER_MAX_MS, createResilientJevTransport, resolveJevTransportSettings } = await import("./jev/transport.mjs");
const { JEV_STATUS } = await import("./jev/config.mjs");
const { externalPolicyRecord } = await import("./governance/external-policy.mjs");
const { AUTOMATIC_PROMOTION_PROHIBITED } = await import("./governance/definition.mjs");
const {
  SUPERVISOR_QUESTION_SET_ID,
  SUPERVISOR_REQUIRED_MODEL,
  SUPERVISOR_REQUIRED_PROVIDER,
  SUPERVISOR_ROOT_DIR,
} = await import("./jev/supervisor/definition.mjs");
const protocol = await import("./jev/supervisor/cross-asset-protocol.mjs");
const {
  PS2D_AUTHORITY_TAG,
  PS2D_CLI_PROFILES,
  PS2D_EVIDENCE_CLASSIFICATION,
  PS2D_FEATURE_KEYS,
  PS2D_FLAGS,
  PS2D_FORBIDDEN_PACKET_KEY_PATTERN,
  PS2D_LABEL,
  PS2D_MAX_PERSISTED_ASSET_ROWS,
  PS2D_OFFLINE_VALIDATION_PROFILE,
  PS2D_PER_ASSET_MAX_JEV_CALLS_PER_RUN,
  PS2D_PER_ASSET_MIN_SPACING_MS,
  PS2D_PRODUCTION_ACTION,
  PS2D_PRODUCTION_SELECTION,
  PS2D_PRODUCTION_SOURCE,
  PS2D_PROFILES,
  PS2D_PROTOCOL_DIGEST,
  PS2D_QUESTION_NAME,
  PS2D_QUESTION_SET_ID,
  PS2D_QUESTION_SET_VERSION,
  PS2D_QUOTE_NUMERAIRE_MINT,
  PS2D_RETRY_CAP,
  PS2D_STANCES,
  PS2D_SUPPRESSION_PRECEDENCE,
  PS2D_TIMEOUT_MS,
  crossAssetExternalCallPolicy,
  crossAssetProfileFor,
} = protocol;
const {
  auditCrossAssetPacket,
  buildCrossAssetPacket,
  crossAssetCompleteInput,
  crossAssetIdentityOf,
  crossAssetInputDigestOf,
  validateGenuineProductionEntry,
} = await import("./jev/supervisor/cross-asset-packet.mjs");
const {
  PS2D_RESPONSE_CONTRACT,
  buildCrossAssetQuestions,
  crossAssetQuestionDigest,
  stanceFromProbability,
  validateCrossAssetTypedResponse,
} = await import("./jev/supervisor/cross-asset-questions.mjs");
const { createCrossAssetSampler } = await import("./jev/supervisor/cross-asset-sampler.mjs");
const { createSupervisorProposalObserver } = await import("./jev/supervisor/observer.mjs");
const { crossAssetPolicyProblems } = await import("./jev/supervisor/cross-asset-observer.mjs");
const {
  listSupervisorSessions,
  readSupervisorCrossAssetObservations,
  readSupervisorLines,
  readSupervisorSession,
  readSupervisorState,
  readSupervisorSummary,
} = await import("./jev/supervisor/storage.mjs");
const { auditNoForbiddenResultFields } = await import("./jev/supervisor/summary.mjs");
const { buildSupervisorSettings } = await import("./jev/supervisor/settings.mjs");
const { loadJevSupervisorObserverState } = await import("./jev/supervisor/dashboard.mjs");
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
    console.log(`  ✗ ${name}\n      ${error?.stack?.split("\n").slice(0, 4).join("\n      ") ?? error}`);
  }
}

function assert(condition, message) {
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

/* ============================================================================
 * Fixtures (deterministic, offline, no wall clock, no provider)
 * ==========================================================================*/

const BASE_AT = Date.parse("2026-09-24T12:00:00Z");
const WORKSPACE = await mkdtemp(path.join(tmpdir(), "evolve-ps2d-"));
const SESSION_BASE = path.join(WORKSPACE, "sessions");
const SOL_MINT = BENCHMARK_MARKET.baseMint;
const USDC_MINT = BENCHMARK_MARKET.quoteMint;
const HISTORICAL_SESSIONS = ["jsup-20260922T151045Z-063f35", "jsup-20260923T042620Z-d1368a"];

/**
 * A well-formed base58 43-character mint for a label. Digits are mapped to
 * letters (so indexes stay distinct) and a label with a non-base58 character
 * is refused rather than silently producing an invalid fixture mint.
 */
function mintOf(label) {
  const mapped = String(label).replace(/[0-9]/g, (digit) => "abcdefghjk"[Number(digit)]);
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(mapped)) throw new Error(`fixture label '${label}' is not base58-safe`);
  if (mapped.length > 40) throw new Error(`fixture label '${label}' is too long`);
  return `${mapped}${"1".repeat(43)}`.slice(0, 43);
}

const MINT = {
  A: mintOf("PS2dAssetAaaa"),
  B: mintOf("PS2dAssetBbbb"),
  C: mintOf("PS2dAssetCccc"),
  D: mintOf("PS2dAssetDddd"),
};

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

function marketFor(options) {
  return deriveMarket(tokenFor(options), {
    at: options.at,
    staleMs: 3_600_000,
    momentumReference: MOMENTUM_REFERENCE.synthetic,
  });
}

const ASSET_SPECS = [
  { key: "A", symbol: "ALPHA", base: 2.5, liquidity: 9_000_000, buyVolume: 2_600_000, sellVolume: 1_100_000, priceChange: 1.8 },
  { key: "B", symbol: "BETA", base: 0.04, liquidity: 3_000_000, buyVolume: 1_400_000, sellVolume: 1_500_000, priceChange: -0.6 },
  { key: "C", symbol: "GAMMA", base: 130, liquidity: 20_000_000, buyVolume: 5_000_000, sellVolume: 4_000_000, priceChange: 0.3 },
  { key: "D", symbol: "DELTA", base: 7, liquidity: 1_500_000, buyVolume: 900_000, sellVolume: 300_000, priceChange: 3.2 },
];

/** A multi-asset feed with deterministic price paths (entries AND exits occur). */
function createMultiAssetFeed({ specs = ASSET_SPECS, extra = null } = {}) {
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
          mint: spec.mint ?? MINT[spec.key],
          symbol: spec.symbol,
          price,
          at,
          liquidity: spec.liquidity,
          buyVolume: spec.buyVolume,
          sellVolume: spec.sellVolume,
          priceChange: spec.priceChange,
          poolAgeHours: spec.poolAgeHours ?? 12,
          verified: spec.verified ?? true,
        };
        universe.set(options.mint, tokenFor(options));
        markets.push(marketFor(options));
      });
      if (typeof extra === "function") markets.push(...extra(at, step, universe));
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

/**
 * Run the REAL engine on a fixture feed. The genome override is applied the
 * same way in every variant, so equivalence comparisons stay exact.
 */
async function runEngine({
  observer = null,
  feed = null,
  ticks = 60,
  populationSize = 16,
  generationTicks = 30,
  stepMs = 15_000,
  genomeOverride = { ...OPEN_GATES, entryScoreThreshold: -0.2 },
  agentMutation = null,
  yieldsPerTick = 0,
  seedLabel = "ps2d-engine",
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
    feed: feed ?? createMultiAssetFeed(),
    now: () => clock,
    random,
    ids: createIdFactory(),
    evolution: { enabled: true, ...config.evolution },
    proposalObserver: observer,
  });
  for (const agent of simulation.population) {
    if (genomeOverride) agent.genome = { ...agent.genome, ...genomeOverride };
    if (typeof agentMutation === "function") agentMutation(agent);
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

/**
 * Deterministic TypeSafe-shaped fixture provider. It answers EVERY asked
 * question name, so the SOL direction question and the PS.2d question can share
 * one provider in a single observer. NEVER touches the network.
 */
function fixtureProvider({ probability = 0.62, behavior = "ok", onEvaluate = null, name = SUPERVISOR_REQUIRED_PROVIDER } = {}) {
  const calls = { count: 0, payloads: [], ps2d: 0 };
  const provider = {
    name,
    model: SUPERVISOR_REQUIRED_MODEL,
    offline: false,
    external: true,
    gatewayUsed: false,
    async evaluate({ state, questions }) {
      calls.count += 1;
      const names = Object.keys(questions ?? {});
      if (names.includes(PS2D_QUESTION_NAME)) calls.ps2d += 1;
      calls.payloads.push({ state, questions, names });
      if (typeof onEvaluate === "function") {
        const custom = await onEvaluate({ state, questions, names, calls });
        if (custom !== undefined) return custom;
      }
      if (behavior === "throw") throw new Error("fixture provider threw");
      if (behavior === "fail") return { ok: false, status: JEV_STATUS.UNAVAILABLE, reason: "fixture unavailable" };
      if (behavior === "malformed") {
        return {
          ok: true,
          requestId: "req-malformed",
          model: SUPERVISOR_REQUIRED_MODEL,
          answers: Object.fromEntries(names.map((entry) => [entry, { type: "noul", noul: "not-a-number" }])),
        };
      }
      return {
        ok: true,
        requestId: `req-${calls.count}`,
        model: SUPERVISOR_REQUIRED_MODEL,
        answers: Object.fromEntries(names.map((entry) => [entry, { type: "noul", noul: probability }])),
        usage: { inputTokens: 120, outputTokens: 4 },
      };
    },
  };
  return { provider, calls };
}

let SESSION_SERIAL = 0;
function observerFor({ label, provider, profile = "full", writeArtifacts = true, baseRoot = SESSION_BASE, crossAsset, ...rest }) {
  SESSION_SERIAL += 1;
  const sessionId = `jsup-ps2d-${label}-${SESSION_SERIAL}`;
  return createSupervisorProposalObserver({
    sessionId,
    sessionRoot: path.join(baseRoot, sessionId),
    baseRoot,
    provider,
    writeArtifacts,
    finalizeTimeoutMs: 200,
    crossAsset:
      crossAsset === undefined
        ? profile === null
          ? null
          : { profile, allowOfflineValidation: profile === PS2D_OFFLINE_VALIDATION_PROFILE.profile }
        : crossAsset,
    ...rest,
  });
}

async function settleCrossAsset(observer, { timeoutMs = 8_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let stable = 0;
  while (Date.now() < deadline) {
    const block = observer.snapshot().crossAssetShadow;
    const done =
      block === null ||
      (block.bufferedEligibleOpportunities === 0 &&
        block.queue.depth === 0 &&
        block.counters.processed === block.counters.queuedForJev);
    if (done) {
      stable += 1;
      if (stable >= 3) return;
    } else stable = 0;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Genuine tap facts exactly as the engine hands them over (copied). */
function entryFacts({
  mint = MINT.A,
  symbol = "ALPHA",
  at = BASE_AT,
  price = 2.5,
  agentId = "A-PS2D-1",
  species = "Momentum",
  generation = 1,
  generationTick = 3,
  score = 0.61,
  threshold = 0.4,
  observedAt = at,
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
    lineageId: "L-PS2D-1",
    researchFamilyId: null,
    productionScore: score,
    entryScoreThreshold: threshold,
    gateAssessment: { passes: true, firstFailedGate: null, failedGates: [] },
    eligibleMarketCount: 3,
    tradeableMarketCount: 4,
    engineRegime: "RISK-ON",
    market: market ?? marketFor({ mint, symbol, price, at, observedAt }),
    ...rest,
  };
}

/** Schema-eligible sampler inputs for pure-sampler tests. */
function samplerInput(mint, atMs, { symbol = null, digest = null } = {}) {
  const identity = crossAssetIdentityOf({ mint, symbol });
  return { identity, jevInputDigest: digest ?? digestOf({ mint, atMs }), atMs };
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
const TREES_BEFORE = Object.fromEntries(
  await Promise.all(PROTECTED_TREES.map(async (root) => [root, await snapshotTree(root)])),
);
const SUPERVISOR_SESSIONS_BEFORE = await listSupervisorSessions(SUPERVISOR_ROOT_DIR);

const PS2D_SOURCE_FILES = [
  "cross-asset-protocol.mjs",
  "cross-asset-packet.mjs",
  "cross-asset-questions.mjs",
  "cross-asset-sampler.mjs",
  "cross-asset-observer.mjs",
].map((name) => path.join("scripts", "jev", "supervisor", name));
const PS2D_SOURCES = Object.fromEntries(
  await Promise.all(PS2D_SOURCE_FILES.map(async (file) => [file, await readFile(file, "utf8")])),
);
const SIMULATION_SOURCE = await readFile(path.join("scripts", "engine", "simulation.mjs"), "utf8");
const CLI_SOURCE = await readFile(path.join("scripts", "jev-supervisor.mjs"), "utf8");
const PAGE_SOURCE = await readFile(path.join("src", "app", "page.tsx"), "utf8");
const PACKAGE_JSON = JSON.parse(await readFile("package.json", "utf8"));

console.log(`\n${PS2D_LABEL} (Phase 5I-PS.2d) — ${PS2D_AUTHORITY_TAG}\n`);

/* ============================================================================
 * 1. Frozen protocol, classification and question contract
 * ==========================================================================*/

await test("frozen protocol: classification flags, no CLEAN_JEV_DIRECTION_* reuse", () => {
  assertEqual(PS2D_EVIDENCE_CLASSIFICATION, "DEVELOPMENT_CROSS_ASSET_SUPERVISOR_SHADOW");
  for (const key of ["developmentOnly", "paperOnly", "shadowOnly", "noProfitabilityInference", "noTradingInference", "noDeploymentInference", "noAuthorityPromotion", "zeroAuthority"]) {
    assertEqual(PS2D_FLAGS[key], true, `${key} must be true`);
  }
  for (const key of ["canonicalEvidence", "replicationEvidence", "temporalReplicationEvidence", "automaticPromotionPermitted", "solDirectionEvidenceGeneralized", "outcomeResolved"]) {
    assertEqual(PS2D_FLAGS[key], false, `${key} must be false`);
  }
  assert(Object.isFrozen(PS2D_FLAGS));
  for (const [file, text] of Object.entries(PS2D_SOURCES)) {
    assert(!/["'`]CLEAN_JEV_DIRECTION/.test(text), `${file} must not use a CLEAN_JEV_DIRECTION classification value`);
  }
  assertEqual(PS2D_LABEL, "CROSS-ASSET PRODUCTION SHADOW");
  assertEqual(PS2D_AUTHORITY_TAG, "DEVELOPMENT SHADOW • ZERO AUTHORITY");
  assertEqual(PS2D_PROTOCOL_DIGEST, digestOf(protocol.PS2D_PROTOCOL_DEFINITION));
});

await test("frozen sampling constants live in ONE protocol module (conservative development bounds)", () => {
  assertEqual(PS2D_PROFILES.full.globalMaxJevCallsPerRun, 120);
  assertEqual(PS2D_PROFILES.canary.globalMaxJevCallsPerRun, 20);
  assertEqual(PS2D_PER_ASSET_MAX_JEV_CALLS_PER_RUN, 10);
  assertEqual(PS2D_PER_ASSET_MIN_SPACING_MS, 60_000);
  assertEqual(PS2D_PROFILES.full.queueCapacity, PS2D_PROFILES.full.globalMaxJevCallsPerRun);
  assertEqual(PS2D_PROFILES.canary.queueCapacity, PS2D_PROFILES.canary.globalMaxJevCallsPerRun);
  assertDeepEqual([...PS2D_CLI_PROFILES], ["canary", "full"]);
  assertDeepEqual([...PS2D_SUPPRESSION_PRECEDENCE], ["suppressedDuplicateDigest", "suppressedPerAssetCap", "suppressedAssetCooldown", "suppressedGlobalCap"]);
  const protocolSource = PS2D_SOURCES[PS2D_SOURCE_FILES[0]];
  for (const literal of ["PS2D_PER_ASSET_MAX_JEV_CALLS_PER_RUN = 10;", "PS2D_PER_ASSET_MIN_SPACING_MS = 60_000;", "globalMaxJevCallsPerRun: 120,", "globalMaxJevCallsPerRun: 20,"]) {
    assertIncludes(protocolSource, literal, "constants are frozen source literals");
  }
  for (const file of PS2D_SOURCE_FILES.slice(1)) {
    assert(!/=\s*(10|60_000|120)\s*;/.test(PS2D_SOURCES[file]), `${file} must not redefine a sampling constant`);
  }
  assertEqual(crossAssetProfileFor("offline-validation"), null, "the validation profile is never reachable implicitly");
  assertEqual(crossAssetProfileFor("full").globalMaxJevCallsPerRun, 120);
  assertEqual(crossAssetProfileFor("bogus"), null);
});

await test("generic question contract is NEW and versioned; the SOL question set is untouched", () => {
  assertEqual(PS2D_QUESTION_SET_ID, "jev-cross-asset-production-proposal-v1");
  assertEqual(PS2D_QUESTION_SET_VERSION, 1);
  assert(PS2D_QUESTION_SET_ID !== SUPERVISOR_QUESTION_SET_ID && PS2D_QUESTION_SET_ID !== DIRECTION_QUESTION_SET_ID);
  const questions = buildCrossAssetQuestions();
  assertDeepEqual(Object.keys(questions), [PS2D_QUESTION_NAME]);
  assertEqual(digestOf(questions), crossAssetQuestionDigest(), "deterministic question digest");
  assertExcludes(JSON.stringify(questions), "SOL/USDC", "the generic question is not SOL-specific");
  assert(!Object.keys(questions).includes(DIRECTION_QUESTION_NAME));
  assertEqual(PS2D_RESPONSE_CONTRACT.stanceIsCorrectness, false);
  assertEqual(PS2D_RESPONSE_CONTRACT.supportImpliesCorrectness, false);
  assertEqual(PS2D_RESPONSE_CONTRACT.nonSupportImpliesCorrectness, false);
  assertEqual(PS2D_RESPONSE_CONTRACT.outcomeResolved, false);
  assertEqual(PS2D_RESPONSE_CONTRACT.malformedBecomesStance, false);
});

await test("typed response: exact stance rule, strict shape, malformed never becomes a stance", () => {
  const ok = (p) => ({ run: { status: "JEV_OK" }, decision: { [PS2D_QUESTION_NAME]: { type: "noul", probability: p } } });
  assertEqual(validateCrossAssetTypedResponse(ok(0.7)).stance, PS2D_STANCES.SUPPORTS);
  assertEqual(validateCrossAssetTypedResponse(ok(0.2)).stance, PS2D_STANCES.DOES_NOT_SUPPORT);
  assertEqual(validateCrossAssetTypedResponse(ok(0.5)).stance, PS2D_STANCES.EXACTLY_HALF);
  assertEqual(validateCrossAssetTypedResponse(ok(0.5000000001)).stance, PS2D_STANCES.SUPPORTS, "exact comparison, no tolerance");
  assertEqual(validateCrossAssetTypedResponse(ok(0)).stance, PS2D_STANCES.DOES_NOT_SUPPORT);
  assertEqual(validateCrossAssetTypedResponse(ok(1)).stance, PS2D_STANCES.SUPPORTS);
  const malformed = [
    ok(1.3),
    ok(-0.1),
    ok(Number.NaN),
    ok(null),
    { run: { status: "JEV_OK" }, decision: {} },
    { run: { status: "JEV_OK" }, decision: { [PS2D_QUESTION_NAME]: { type: "choice", choice: "yes" } } },
    { run: { status: "JEV_OK" }, decision: { [PS2D_QUESTION_NAME]: { type: "noul", probability: 0.6 }, extra: { type: "noul", probability: 0.1 } } },
    { run: { status: "JEV_OK" }, decision: { [DIRECTION_QUESTION_NAME]: { type: "noul", probability: 0.6 } } },
    { run: { status: "JEV_OK" }, decision: "NO_JEV_DECISION" },
    { run: { status: "JEV_INVALID_RESPONSE", reason: "bad" }, decision: "NO_JEV_DECISION" },
    { run: { status: "JEV_TIMEOUT" }, decision: "NO_JEV_DECISION" },
    null,
  ];
  for (const [index, decided] of malformed.entries()) {
    const verdict = validateCrossAssetTypedResponse(decided);
    assertEqual(verdict.ok, false, `malformed case ${index} must fail`);
    assertEqual(verdict.stance, null, `malformed case ${index} never becomes a stance`);
    assertEqual(verdict.pSupport, null);
  }
  assertEqual(stanceFromProbability(Number.POSITIVE_INFINITY), null);
});

/* ============================================================================
 * 2. Genuineness boundary (tests 1–4)
 * ==========================================================================*/

await test("(1) a genuine production proposal becomes PS.2d eligible", () => {
  const facts = entryFacts();
  assertDeepEqual(validateGenuineProductionEntry(facts), { genuine: true, reason: null });
  const built = buildCrossAssetPacket(facts);
  assertEqual(built.ok, true, built.reason);
  assertEqual(built.packet.market.baseMint, MINT.A);
  assertEqual(built.packet.market.quoteMint, PS2D_QUOTE_NUMERAIRE_MINT);
  assertEqual(built.packet.market.marketId, `${MINT.A}/${PS2D_QUOTE_NUMERAIRE_MINT}`);
  assertEqual(built.packet.production.scoreMargin, facts.productionScore - facts.entryScoreThreshold);
  assertEqual(Object.isFrozen(built.packet.production.features), true, "packets are deep-frozen at capture");
  const equality = entryFacts({ score: 0.4, threshold: 0.4 });
  assertEqual(validateGenuineProductionEntry(equality).genuine, true, "the unchanged production test is >= (equality is actionable)");
});

await test("(2) PS.2c counterfactual / non-production events can never become eligible", () => {
  const genome = { ...OPEN_GATES, maxPoolAgeHours: 1, entryScoreThreshold: 0 };
  const market = marketFor({ mint: MINT.A, symbol: "ALPHA", price: 2.5, at: BASE_AT, poolAgeHours: 49 });
  const cf = assessPoolAgeCounterfactual(genome, market, { minLiquidityUsd: 100 });
  assertEqual(cf.productionPasses, false);
  assertEqual(cf.counterfactualPasses, true, "fixture: SOL-style age-only failure passes ONLY counterfactually");
  const cases = [
    [{ kind: "age_counterfactual", species: "Momentum", ...cf }, "counterfactual_input_rejected"],
    [entryFacts({ counterfactualPasses: true }), "counterfactual_input_rejected"],
    [entryFacts({ gateAssessment: { passes: true, failedGates: [], counterfactualFailedGates: [] } }), "counterfactual_input_rejected"],
    [entryFacts({ gateAssessment: { passes: cf.counterfactualPasses, failedGates: cf.failedGates } }), "production_gates_failed"],
    [entryFacts({ source: "PS2C_AGE_COUNTERFACTUAL" }), "not_production_source"],
    [entryFacts({ source: "SOL_OPPORTUNITY" }), "not_production_source"],
    [entryFacts({ action: "EXIT_LONG" }), "not_entry_action"],
    [entryFacts({ selection: "SCORED_NOT_SELECTED" }), "not_production_selection"],
  ];
  for (const [facts, reason] of cases) assertEqual(validateGenuineProductionEntry(facts).reason, reason);
});

await test("(3) failed production gates can never become eligible", () => {
  for (const gateAssessment of [
    { passes: false, failedGates: ["pool_too_old"] },
    { passes: true, failedGates: ["momentum"] },
    { passes: false, failedGates: [] },
    { passes: true },
    null,
  ]) {
    assertEqual(validateGenuineProductionEntry(entryFacts({ gateAssessment })).reason, "production_gates_failed");
  }
});

await test("(4) below-threshold events can never become eligible", () => {
  assertEqual(validateGenuineProductionEntry(entryFacts({ score: 0.3999, threshold: 0.4 })).reason, "below_entry_threshold");
  assertEqual(validateGenuineProductionEntry(entryFacts({ score: Number.NaN })).reason, "non_finite_score_or_threshold");
  assertEqual(validateGenuineProductionEntry(entryFacts({ threshold: null })).reason, "non_finite_score_or_threshold");
});

/* ============================================================================
 * 3. Complete-input digest (tests 5–6)
 * ==========================================================================*/

function completeInputFor(packet, overrides = {}) {
  return crossAssetCompleteInput({
    provider: SUPERVISOR_REQUIRED_PROVIDER,
    model: SUPERVISOR_REQUIRED_MODEL,
    questionSetId: PS2D_QUESTION_SET_ID,
    questionSetVersion: PS2D_QUESTION_SET_VERSION,
    questions: buildCrossAssetQuestions(),
    packet,
    ...overrides,
  });
}

function leafPaths(value, trail = []) {
  if (value === null || typeof value !== "object") return [trail];
  const entries = Array.isArray(value) ? value.map((entry, index) => [index, entry]) : Object.entries(value);
  if (entries.length === 0) return [trail];
  return entries.flatMap(([key, entry]) => leafPaths(entry, [...trail, key]));
}

function mutateAt(value, trail) {
  const copy = structuredClone(value);
  if (trail.length === 0) return copy;
  let cursor = copy;
  for (const key of trail.slice(0, -1)) cursor = cursor[key];
  const last = trail[trail.length - 1];
  const current = cursor[last];
  if (typeof current === "number") cursor[last] = current === 0 ? 1e-12 : current * (1 + 1e-9) + (current > 0 ? 0 : -1e-12);
  else if (typeof current === "string") cursor[last] = `${current}​`;
  else if (typeof current === "boolean") cursor[last] = !current;
  else if (current === null) cursor[last] = 0;
  else if (Array.isArray(current)) cursor[last] = [...current, "x"];
  else if (typeof current === "object") cursor[last] = { ...current, extra: 1 };
  return copy;
}

await test("(5) the complete-input digest changes for EVERY model-visible leaf mutation", () => {
  const built = buildCrossAssetPacket(entryFacts());
  const packet = structuredClone(built.packet);
  const baseDigest = crossAssetInputDigestOf(completeInputFor(packet));
  const paths = leafPaths(packet);
  assert(paths.length >= 50, `the packet must expose its full leaf set (got ${paths.length})`);
  const seen = new Set([baseDigest]);
  for (const trail of paths) {
    const mutated = mutateAt(packet, trail);
    const digest = crossAssetInputDigestOf(completeInputFor(mutated));
    assert(digest !== baseDigest, `mutating packet.${trail.join(".")} must change the digest`);
    assert(!seen.has(digest), `packet.${trail.join(".")} mutation collided with another digest`);
    seen.add(digest);
  }
  const questions = buildCrossAssetQuestions();
  for (const trail of leafPaths(questions)) {
    const digest = crossAssetInputDigestOf(completeInputFor(packet, { questions: mutateAt(questions, trail) }));
    assert(digest !== baseDigest, `mutating questions.${trail.join(".")} must change the digest`);
  }
  for (const overrides of [{ model: "jev-1.12.0" }, { provider: "mock-jev" }, { questionSetVersion: 2 }, { questionSetId: "other" }]) {
    assert(crossAssetInputDigestOf(completeInputFor(packet, overrides)) !== baseDigest, JSON.stringify(overrides));
  }
  const removed = structuredClone(packet);
  delete removed.market.symbol;
  assert(crossAssetInputDigestOf(completeInputFor(removed)) !== baseDigest, "removing a key changes the digest");
  const retyped = structuredClone(packet);
  retyped.production.generationLike = "1";
  assert(crossAssetInputDigestOf(completeInputFor(retyped)) !== baseDigest);
  const stringNumber = structuredClone(packet);
  stringNumber.proposal.generation = String(stringNumber.proposal.generation);
  assert(crossAssetInputDigestOf(completeInputFor(stringNumber)) !== baseDigest, "type changes are model-visible");
});

await test("(6) byte-identical canonical packets reproduce the digest", () => {
  const facts = entryFacts();
  const first = buildCrossAssetPacket(facts);
  const second = buildCrossAssetPacket(structuredClone(facts));
  const digest = crossAssetInputDigestOf(completeInputFor(first.packet));
  assertEqual(crossAssetInputDigestOf(completeInputFor(second.packet)), digest, "rebuilt from equal facts");
  assertEqual(crossAssetInputDigestOf(completeInputFor(JSON.parse(JSON.stringify(first.packet)))), digest, "JSON round trip");
  const reordered = Object.fromEntries(Object.entries(structuredClone(first.packet)).reverse());
  assertEqual(crossAssetInputDigestOf(completeInputFor(reordered)), digest, "key order is canonicalized");
  assertEqual(digest, sha256Hex(canonicalJson(completeInputFor(first.packet))), "digest = sha256 of the canonical complete input");
});

/* ============================================================================
 * 4. Deterministic sampler (tests 7–13, 15, 16, 28 at module level)
 * ==========================================================================*/

await test("(7) duplicate complete-input digests are suppressed (first precedence)", () => {
  const sampler = createCrossAssetSampler({ profile: PS2D_PROFILES.full });
  const input = samplerInput(MINT.A, BASE_AT, { digest: "d".repeat(64) });
  assertEqual(sampler.decide(input).admitted, true);
  const later = { ...input, atMs: BASE_AT + 10 * PS2D_PER_ASSET_MIN_SPACING_MS };
  assertEqual(sampler.decide(later).reason, "suppressedDuplicateDigest", "a re-sent identical input is suppressed even after cooldown");
  const other = samplerInput(MINT.B, BASE_AT, { digest: "d".repeat(64) });
  assertEqual(sampler.decide(other).reason, "suppressedDuplicateDigest", "duplicates are defined by the complete input");
  assertEqual(sampler.snapshot().counters.suppressedDuplicateDigest, 2);
});

await test("(8) per-asset cooldown: < 60s suppressed, exactly 60s admitted (engine time)", () => {
  const sampler = createCrossAssetSampler({ profile: PS2D_PROFILES.full });
  assertEqual(sampler.decide(samplerInput(MINT.A, BASE_AT)).admitted, true, "first eligible opportunity of an asset is admitted");
  assertEqual(sampler.decide(samplerInput(MINT.A, BASE_AT + 59_999)).reason, "suppressedAssetCooldown");
  assertEqual(sampler.decide(samplerInput(MINT.A, BASE_AT + 60_000)).admitted, true);
  assertEqual(sampler.decide(samplerInput(MINT.A, BASE_AT + 60_001)).reason, "suppressedAssetCooldown", "spacing is measured from the last ADMISSION");
});

await test("(9) per-asset cap: at most 10 admissions per asset per run", () => {
  const sampler = createCrossAssetSampler({ profile: PS2D_PROFILES.full });
  for (let i = 0; i < 10; i += 1) assertEqual(sampler.decide(samplerInput(MINT.A, BASE_AT + i * 60_000)).admitted, true);
  assertEqual(sampler.decide(samplerInput(MINT.A, BASE_AT + 10 * 60_000)).reason, "suppressedPerAssetCap");
  assertEqual(sampler.decide(samplerInput(MINT.A, BASE_AT + 10 * 60_000 + 1)).reason, "suppressedPerAssetCap", "cap precedes cooldown");
  assertEqual(sampler.decide(samplerInput(MINT.B, BASE_AT + 10 * 60_000)).admitted, true, "another asset is unaffected");
});

await test("(10) global cap: canary 20 and full 120, suppression reason explicit", () => {
  for (const [name, cap] of [["canary", 20], ["full", 120]]) {
    const sampler = createCrossAssetSampler({ profile: PS2D_PROFILES[name] });
    for (let i = 0; i < cap; i += 1) assertEqual(sampler.decide(samplerInput(mintOf(`Gcap${name === "full" ? "F" : "C"}${i}x`), BASE_AT)).admitted, true);
    assertEqual(sampler.decide(samplerInput(mintOf(`Gcap${name === "full" ? "F" : "C"}Zzz`), BASE_AT)).reason, "suppressedGlobalCap");
    const snap = sampler.snapshot();
    assertEqual(snap.counters.admittedBySampler, cap);
    assertEqual(snap.counters.suppressedGlobalCap, 1);
  }
});

function decisionStream(sequence, profile = PS2D_PROFILES.full) {
  const sampler = createCrossAssetSampler({ profile });
  const decisions = sequence.map((input) => sampler.decide(input));
  return { decisions, snapshot: sampler.snapshot() };
}

function mixedSequence() {
  const sequence = [];
  for (let tick = 0; tick < 40; tick += 1) {
    for (const key of ["A", "B", "C", "D"]) sequence.push(samplerInput(MINT[key], BASE_AT + tick * 15_000, { symbol: key }));
  }
  return sequence;
}

await test("(11) deterministic encounter order: same stream ⇒ identical decisions; order is the only driver", () => {
  const first = decisionStream(mixedSequence());
  const second = decisionStream(mixedSequence());
  assertDeepEqual(first.decisions, second.decisions);
  assertEqual(first.snapshot.aggregateDigest, second.snapshot.aggregateDigest);
  // With a small global cap, WHICH assets are admitted is decided purely by encounter order.
  const capProfile = PS2D_PROFILES.canary;
  const burst = Array.from({ length: 30 }, (_, i) => samplerInput(mintOf(`Seq${i}x`), BASE_AT));
  const forward = decisionStream(burst, capProfile).decisions.map((entry) => entry.admitted);
  const reversed = decisionStream([...burst].reverse(), capProfile).decisions.map((entry) => entry.admitted).reverse();
  assertEqual(forward.slice(0, 20).every(Boolean), true);
  assertEqual(reversed.slice(10).every(Boolean), true);
  assert(canonicalJson(forward) !== canonicalJson(reversed), "reordering the stream changes the sample (order-driven, not asset-picked)");
});

await test("(12) no random sampling: sources carry no randomness and Math.random is irrelevant", () => {
  for (const [file, text] of Object.entries(PS2D_SOURCES)) {
    for (const pattern of [/Math\.random/, /createSeededRandom/, /randomUUID/, /getRandomValues/, /\brandom\s*\(/]) {
      assert(!pattern.test(text), `${file} must not use randomness (${pattern})`);
    }
  }
  const sampler = PS2D_SOURCES[path.join("scripts", "jev", "supervisor", "cross-asset-sampler.mjs")];
  assert(!/Date\.now|new Date\(\)/.test(sampler), "the sampler never reads the wall clock");
  const original = Math.random;
  const baseline = decisionStream(mixedSequence()).decisions;
  try {
    Math.random = () => {
      throw new Error("randomness used");
    };
    assertDeepEqual(decisionStream(mixedSequence()).decisions, baseline);
  } finally {
    Math.random = original;
  }
});

await test("(13) asset A cannot suppress asset B except through the explicit global cap", () => {
  const onlyB = [];
  const withFloodA = [];
  for (let tick = 0; tick < 50; tick += 1) {
    const at = BASE_AT + tick * 20_000;
    const b = samplerInput(MINT.B, at);
    onlyB.push(b);
    for (let k = 0; k < 3; k += 1) withFloodA.push(samplerInput(MINT.A, at + k, { digest: digestOf({ flood: tick, k }) }));
    withFloodA.push(b);
  }
  const bAlone = decisionStream(onlyB).decisions;
  const bWithA = decisionStream(withFloodA).decisions.filter((_, index) => index % 4 === 3);
  assertDeepEqual(bWithA, bAlone.map((entry, index) => ({ ...entry, admissionOrdinal: bWithA[index].admissionOrdinal })), "B's decisions are independent of A");
  const aDecisions = decisionStream(withFloodA).decisions.filter((_, index) => index % 4 !== 3);
  assert(aDecisions.some((entry) => entry.reason === "suppressedAssetCooldown"));
  assert(aDecisions.some((entry) => entry.reason === "suppressedPerAssetCap"));
  // Through the global cap, and ONLY through it, A can starve B — and it is named.
  const capped = createCrossAssetSampler({ profile: PS2D_PROFILES.canary });
  for (let i = 0; i < 20; i += 1) capped.decide(samplerInput(mintOf(`Fd${i}x`), BASE_AT));
  assertEqual(capped.decide(samplerInput(MINT.B, BASE_AT)).reason, "suppressedGlobalCap");
});

await test("(15) symbol collision cannot merge different mints", () => {
  const sampler = createCrossAssetSampler({ profile: PS2D_PROFILES.full });
  assertEqual(sampler.decide(samplerInput(MINT.A, BASE_AT, { symbol: "PEPE" })).admitted, true);
  assertEqual(sampler.decide(samplerInput(MINT.B, BASE_AT + 1, { symbol: "PEPE" })).admitted, true, "same symbol, different mint: independent");
  const snap = sampler.snapshot();
  assertEqual(snap.totalAssetCount, 2);
  assertEqual(new Set(snap.assetRows.map((row) => row.marketId)).size, 2);
  assert(snap.assetRows.every((row) => row.symbol === "PEPE"));
  assert(crossAssetIdentityOf({ mint: MINT.A, symbol: "X" }).marketId !== crossAssetIdentityOf({ mint: MINT.B, symbol: "X" }).marketId);
});

await test("(16) same mint with descriptive symbol variation keeps one stable identity", () => {
  const sampler = createCrossAssetSampler({ profile: PS2D_PROFILES.full });
  assertEqual(sampler.decide(samplerInput(MINT.C, BASE_AT, { symbol: "WIF" })).admitted, true);
  assertEqual(sampler.decide(samplerInput(MINT.C, BASE_AT + 1_000, { symbol: "wif" })).reason, "suppressedAssetCooldown", "cooldown is shared across symbols");
  sampler.decide(samplerInput(MINT.C, BASE_AT + 2_000, { symbol: "dogwifhat" }));
  const snap = sampler.snapshot();
  assertEqual(snap.totalAssetCount, 1);
  assertDeepEqual(snap.assetRows[0].symbolVariants, ["WIF", "wif", "dogwifhat"]);
  assertEqual(snap.assetRows[0].symbol, "WIF", "the first observed symbol is kept; symbols never change identity");
  assertEqual(crossAssetIdentityOf({ mint: MINT.C, symbol: "a" }).marketId, crossAssetIdentityOf({ mint: MINT.C, symbol: "b" }).marketId);
});

/* ============================================================================
 * 5. Schema fail-closed + packet content (tests 14, 17, 18)
 * ==========================================================================*/

await test("(14) malformed schema fails closed with an explicit reason, never queued", () => {
  const stale = entryFacts();
  stale.market = { ...stale.market, fresh: false };
  const cases = [
    [entryFacts({ mint: "not-a-mint" }), "invalid_base_mint"],
    [entryFacts({ mint: "0OIl".repeat(10) }), "invalid_base_mint"],
    [entryFacts({ mint: USDC_MINT, symbol: "USDC" }), "base_equals_quote_numeraire"],
    [entryFacts({ market: { ...marketFor({ mint: MINT.A, symbol: "A", price: 1, at: BASE_AT }), synthetic: true } }), "synthetic_market"],
    [stale, "market_not_fresh"],
    [entryFacts({ market: { ...marketFor({ mint: MINT.A, symbol: "A", price: 1, at: BASE_AT }), price: Number.NaN } }), "invalid_reference_price"],
    [entryFacts({ market: { ...marketFor({ mint: MINT.A, symbol: "A", price: 1, at: BASE_AT }), liquidity: 0 } }), "invalid_liquidity"],
    [{ ...entryFacts(), at: Number.NaN }, "invalid_proposal_time"],
    [entryFacts({ market: { ...marketFor({ mint: MINT.A, symbol: "A", price: 1, at: BASE_AT }), lastObservedAt: null } }), "missing_market_observed_at"],
    [entryFacts({ observedAt: BASE_AT + 1 }), "observed_after_proposal"],
    [entryFacts({ agentId: "" }), "missing_agent_identity"],
    [entryFacts({ generation: 1.5 }), "missing_agent_identity"],
    [entryFacts({ market: { ...marketFor({ mint: MINT.A, symbol: "A", price: 1, at: BASE_AT }), features: { momentum: 0 } } }), "non_finite_feature"],
    [entryFacts({ symbol: "sk-ABCDEFGHIJKLMNOPQRSTUVWX" }), "packet_audit_failed"],
  ];
  for (const [facts, reason] of cases) {
    assertEqual(validateGenuineProductionEntry(facts).genuine, true, `${reason}: fixture is genuine`);
    const built = buildCrossAssetPacket(facts);
    assertEqual(built.ok, false, `${reason} must fail closed`);
    assertEqual(built.reason, reason);
    assertEqual(built.packet, null);
  }
  for (const garbage of [null, "facts", 7, [], new Map(), { factCopyFailed: true }]) {
    assertEqual(validateGenuineProductionEntry(garbage).genuine, false);
  }
});

await test("(17) no future, outcome or execution field can enter a packet; packets are pre-outcome", () => {
  const facts = entryFacts();
  const built = buildCrossAssetPacket(facts);
  const keys = leafPaths(built.packet).map((trail) => trail.filter((entry) => typeof entry === "string"));
  for (const trail of keys) {
    for (const key of trail) assert(!PS2D_FORBIDDEN_PACKET_KEY_PATTERN.test(key), `forbidden key in packet: ${trail.join(".")}`);
  }
  for (const forbidden of ["executedPrice", "netProceeds", "fillSide", "qty", "notional", "exitPrice", "forwardReturn", "horizon", "outcome"]) {
    assertExcludes(JSON.stringify(built.packet), `"${forbidden}"`);
  }
  assert(Date.parse(built.packet.market.marketObservedAt) <= Date.parse(built.packet.proposal.proposalAt), "no market state after the proposal");
  assertEqual(auditCrossAssetPacket(built.packet).ok, true);
  const tainted = structuredClone(built.packet);
  tainted.market.futurePrice = 3;
  assertEqual(auditCrossAssetPacket(tainted).ok, false, "the audit detects a future field");
  const tainted2 = structuredClone(built.packet);
  tainted2.production.realizedPnl = 1;
  assertEqual(auditCrossAssetPacket(tainted2).ok, false);
  // Mutating the caller-owned market AFTER capture cannot change the frozen packet.
  const before = canonicalJson(built.packet);
  facts.market.price = 999;
  facts.market.features.momentum = 1;
  assertEqual(canonicalJson(built.packet), before);
  assertDeepEqual(PS2D_FEATURE_KEYS.slice().sort(), Object.keys(built.packet.production.features).sort());
});

await test("(18) no PS.2c counterfactual field can enter a packet", () => {
  const built = buildCrossAssetPacket(entryFacts());
  const text = JSON.stringify(built.packet);
  for (const forbidden of ["counterfactual", "solAgeCounterfactual", "pool_too_old", "productionPasses", "ageOnly"]) {
    assertExcludes(text.toLowerCase(), forbidden.toLowerCase());
  }
  assertDeepEqual(built.packet.production.gates, { allPassed: true, failedGates: [] });
  const cfPacket = structuredClone(built.packet);
  cfPacket.production.counterfactualScore = 0.9;
  assertEqual(auditCrossAssetPacket(cfPacket).ok, false);
});

/* ============================================================================
 * 6. Engine: genuineness 1:1, observational inertness (tests 19–23)
 * ==========================================================================*/

console.log(`\n  … engine equivalence, observer, dashboard and preservation proofs …\n`);

const BASELINE = await runEngine({ observer: null });

await test("engine fixture exercises multi-asset entries, exits and a generation transition", () => {
  const trades = BASELINE.snapshot.recentTrades;
  assert(trades.length > 0, "exits must occur");
  assert(new Set(trades.map((trade) => trade.mint)).size >= 2, "more than one asset must be traded");
  assert(new Set(BASELINE.generations).size >= 2, "a generation transition must occur");
});

await test("(1) engine: every genuine opportunity is 1:1 with a PS.2 ENTER_LONG proposal; exits never count", async () => {
  const { provider, calls } = fixtureProvider();
  const observer = observerFor({ label: "one-to-one", provider, writeArtifacts: false });
  const entries = [];
  const exits = [];
  const taps = [];
  const freeze = observer.freezeProposal;
  observer.freezeProposal = (facts) => {
    if (facts.action === "ENTER_LONG") entries.push([facts.agentId, facts.at, facts.market?.mint, facts.agentScore]);
    else exits.push(facts.reason);
    return freeze(facts);
  };
  const tap = observer.observeProductionEntry;
  observer.observeProductionEntry = (facts) => {
    taps.push([facts.agentId, facts.at, facts.market?.mint, facts.productionScore]);
    return tap(facts);
  };
  observer.start();
  const run = await runEngine({ observer, yieldsPerTick: 1 });
  await settleCrossAsset(observer);
  await observer.finalize();
  assertEngineIdentical(BASELINE, run, "PS.2d enabled");
  assert(entries.length > 0 && exits.length > 0);
  assertDeepEqual(taps, entries, "the PS.2d tap fires exactly for the finalized production entry proposals");
  const block = observer.snapshot().crossAssetShadow;
  assertEqual(block.counters.productionEntryFactsReceived, entries.length);
  assertEqual(block.counters.genuineProductionOpportunitiesObserved, entries.length);
  assertEqual(block.counters.nonGenuineRejected, 0);
  assertEqual(block.counters.schemaEligible, entries.length, "all fixture assets are schema-eligible");
  assert(block.counters.uniqueAssetsObserved >= 2, "cross-asset coverage");
  assert(block.counters.admittedBySampler > 0 && block.counters.admittedBySampler < entries.length, "sampling bounds bite");
  assertEqual(block.counters.jevCalls, block.counters.admittedBySampler);
  assertEqual(calls.ps2d, block.counters.jevCalls);
  assertEqual(block.counters.jevOk, block.counters.jevCalls);
  for (const [name, holds] of Object.entries(block.accountingIdentities)) assertEqual(holds, true, `identity ${name}`);
});

await test("(1b) blocked paper entries remain genuine (the proposal was final before execution)", async () => {
  const { provider } = fixtureProvider();
  const observer = observerFor({ label: "blocked", provider, writeArtifacts: false });
  let blockedEntries = 0;
  const record = observer.recordExecution;
  observer.recordExecution = (handle, execution) => {
    if (execution?.blockedReason === "size_below_minimum_order") blockedEntries += 1;
    return record(handle, execution);
  };
  observer.start();
  await runEngine({ observer, ticks: 12, agentMutation: (agent) => { agent.cash = 0.01; } });
  await observer.finalize();
  const block = observer.snapshot().crossAssetShadow;
  assert(blockedEntries > 0, "fixture: entries must be blocked by paper sizing");
  assertEqual(block.counters.genuineProductionOpportunitiesObserved, blockedEntries, "execution results never decide eligibility");
});

await test("(3/4) engine: gate-failing and below-threshold markets never become opportunities", async () => {
  // Asset D is unverified; genomes require verification → D fails production gates.
  const feed = createMultiAssetFeed({ specs: ASSET_SPECS.map((spec) => (spec.key === "D" ? { ...spec, verified: false } : spec)) });
  const { provider } = fixtureProvider();
  const observer = observerFor({ label: "gated", provider, writeArtifacts: false });
  observer.start();
  await runEngine({ observer, feed, genomeOverride: { ...OPEN_GATES, requireVerified: 1, entryScoreThreshold: -0.2 }, ticks: 20 });
  await observer.finalize();
  const rows = observer.snapshot().crossAssetShadow.assetRows;
  assert(rows.length > 0);
  assert(rows.every((row) => row.baseMint !== MINT.D), "a gate-failing asset is never an opportunity");
  // Unreachable threshold → no production entry at all → zero opportunities.
  const { provider: p2, calls } = fixtureProvider();
  const high = observerFor({ label: "threshold", provider: p2, writeArtifacts: false });
  high.start();
  await runEngine({ observer: high, genomeOverride: { ...OPEN_GATES, entryScoreThreshold: 2 }, ticks: 10 });
  await high.finalize();
  const hb = high.snapshot().crossAssetShadow;
  assertEqual(hb.counters.productionEntryFactsReceived, 0);
  assertEqual(hb.counters.genuineProductionOpportunitiesObserved, 0);
  assertEqual(calls.count, 0);
});

await test("(2) engine: a PS.2c age-only SOL counterfactual pass never becomes a PS.2d opportunity", async () => {
  const sol = { key: "SOL", mint: SOL_MINT, symbol: "SOL", base: 200, liquidity: 25_000_000, buyVolume: 3_000_000, sellVolume: 1_000_000, priceChange: 1, poolAgeHours: 49 };
  const feed = createMultiAssetFeed({ specs: [sol, ASSET_SPECS[0]] });
  const { provider } = fixtureProvider();
  const observer = observerFor({ label: "ps2c-sol", provider, writeArtifacts: false });
  observer.start();
  await runEngine({ observer, feed, genomeOverride: { ...OPEN_GATES, maxPoolAgeHours: 48, entryScoreThreshold: -0.2 }, ticks: 20 });
  await observer.finalize();
  const snapshot = observer.snapshot();
  assert(snapshot.solAgeCounterfactual.solFailsOnlyPoolTooOld > 0, "PS.2c sees SOL age-only failures");
  assert(snapshot.solAgeCounterfactual.solPassesWithoutPoolAge > 0, "SOL would pass counterfactually");
  const rows = snapshot.crossAssetShadow.assetRows;
  assert(rows.length > 0, "the genuine rival asset is observed");
  assert(rows.every((row) => row.baseMint !== SOL_MINT), "SOL never becomes a PS.2d opportunity through PS.2c");
  assertEqual(snapshot.solFunnel.solPassesGates, 0, "production still rejects SOL");
});

async function variantRun(label, { provider, profile = "full", mutateObserver = null, yieldsPerTick = 1, finalize = true } = {}) {
  const observer = observerFor({ label, provider, profile, writeArtifacts: false });
  if (typeof mutateObserver === "function") mutateObserver(observer);
  observer.start();
  const run = await runEngine({ observer, yieldsPerTick });
  if (finalize) await observer.finalize();
  return { run, observer };
}

await test("(19) disabled / working / slow / throwing / malformed / queue-full: identical production state", async () => {
  const results = {};
  results.disabledObserver = await variantRun("disabled", { provider: fixtureProvider().provider, profile: null });
  results.working = await variantRun("working", { provider: fixtureProvider().provider });
  let release = null;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  results.slow = await variantRun("slow", {
    provider: fixtureProvider({ onEvaluate: async () => { await gate; return undefined; } }).provider,
    finalize: false,
  });
  results.throwingProvider = await variantRun("throwing-provider", { provider: fixtureProvider({ behavior: "throw" }).provider });
  results.throwingTap = await variantRun("throwing-tap", {
    provider: fixtureProvider().provider,
    mutateObserver: (observer) => {
      observer.observeProductionEntry = () => {
        throw new Error("PS.2d tap failure");
      };
    },
  });
  results.malformedProvider = await variantRun("malformed-provider", { provider: fixtureProvider({ behavior: "malformed" }).provider });
  results.mutatingTap = await variantRun("mutating-tap", {
    provider: fixtureProvider().provider,
    mutateObserver: (observer) => {
      const original = observer.observeProductionEntry;
      observer.observeProductionEntry = (facts) => {
        // A hostile consumer mutates everything it was handed: copies only.
        facts.market.price = -1;
        facts.market.features.momentum = 99;
        facts.gateAssessment.failedGates.push("mutated");
        facts.productionScore = -99;
        original(facts);
        return { best: null, bestScore: 1e9, veto: true };
      };
    },
  });
  results.queueFull = await variantRun("queue-full", {
    provider: fixtureProvider({ onEvaluate: () => new Promise(() => {}) }).provider,
    profile: PS2D_OFFLINE_VALIDATION_PROFILE.profile,
  });
  for (const [label, { run }] of Object.entries(results)) assertEngineIdentical(BASELINE, run, label);
  const disabled = results.disabledObserver.observer;
  assertEqual(typeof disabled.observeProductionEntry, "undefined", "a disabled observer exposes no PS.2d tap");
  assertEqual(disabled.snapshot().crossAssetShadow, null);
  const slowBlock = results.slow.observer.snapshot().crossAssetShadow;
  assert(slowBlock.counters.admittedBySampler > 1 && slowBlock.counters.jevOk === 0, "slow Jev: the engine finished while calls were pending");
  release();
  await results.slow.observer.finalize();
  const throwingBlock = results.throwingProvider.observer.snapshot().crossAssetShadow;
  assert(throwingBlock.counters.jevFailures > 0 && throwingBlock.counters.jevOk === 0);
  const malformedBlock = results.malformedProvider.observer.snapshot().crossAssetShadow;
  assert(malformedBlock.counters.jevFailures > 0);
  assertEqual(malformedBlock.counters.stanceSupports + malformedBlock.counters.stanceDoesNotSupport + malformedBlock.counters.stanceExactlyHalf, 0, "malformed never becomes a stance");
  const queueFull = results.queueFull.observer.snapshot().crossAssetShadow;
  assert(queueFull.counters.queueDropped > 0, "the queue-full variant must actually drop");
  assertEqual(queueFull.queue.capacity, PS2D_OFFLINE_VALIDATION_PROFILE.queueCapacity);
  for (const [name, holds] of Object.entries(queueFull.accountingIdentities)) assertEqual(holds, true, `queue-full identity ${name}`);
});

await test("(20) queue overflow is explicit, bounded, counted — and cannot affect the engine", async () => {
  const { provider } = fixtureProvider({ onEvaluate: () => new Promise(() => {}) });
  const observer = observerFor({ label: "overflow", provider, profile: PS2D_OFFLINE_VALIDATION_PROFILE.profile });
  observer.start();
  const run = await runEngine({ observer, yieldsPerTick: 1 });
  assertEngineIdentical(BASELINE, run, "overflow");
  await observer.finalize();
  const block = observer.summary().crossAssetShadow;
  const c = block.counters;
  assertEqual(c.admittedBySampler, PS2D_OFFLINE_VALIDATION_PROFILE.globalMaxJevCallsPerRun);
  assertEqual(c.admittedBySampler, c.queuedForJev + c.queueDropped);
  assert(block.queue.highWatermark <= PS2D_OFFLINE_VALIDATION_PROFILE.queueCapacity);
  assertEqual(c.inFlightAtFinalize, 1, "the hung call is recorded in flight, never waited for");
  assertEqual(c.jevCalls, c.jevOk + c.jevFailures + c.inFlightAtFinalize);
  assertEqual(c.unsentAtFinalize + c.processed, c.queuedForJev, "queued items are flushed unsent, never sent late");
  const records = await readSupervisorCrossAssetObservations(observer.sessionRoot);
  assertEqual(records.records.length, c.admittedBySampler, "one record per admitted observation, every disposition");
  assertEqual((await readSupervisorSession(observer.sessionRoot)).finalizeTimedOut, true, "a hung call is reported as a finalize timeout");
  const dispositions = records.records.map((record) => record.disposition);
  assert(dispositions.includes("QUEUE_DROPPED") && dispositions.includes("UNSENT_AT_FINALIZE") && dispositions.includes("IN_FLIGHT_AT_FINALIZE"));
});

await test("(21/22/23) Jev answers (p=0, p=1, malformed) cannot alter actions, best/bestScore, selection, evolution or fitness", async () => {
  const runs = [];
  for (const [label, options] of [["p0", { probability: 0 }], ["p1", { probability: 1 }], ["bad", { behavior: "malformed" }]]) {
    const { provider } = fixtureProvider(options);
    const { run, observer } = await variantRun(`answer-${label}`, { provider, yieldsPerTick: 2 });
    runs.push({ label, run, block: observer.snapshot().crossAssetShadow });
  }
  for (const { label, run } of runs) assertEngineIdentical(BASELINE, run, label);
  assert(runs[0].block.counters.stanceDoesNotSupport > 0, "p=0 answers were received during the run");
  assert(runs[1].block.counters.stanceSupports > 0, "p=1 answers were received during the run");
  assertDeepEqual(
    runs[0].run.selectionLog.map((tick) => tick.map((agent) => agent[2])),
    runs[1].run.selectionLog.map((tick) => tick.map((agent) => agent[2])),
    "bestScore (position.entryScore) identical for opposite answers",
  );
  assertDeepEqual(
    runs[0].run.simulation.population.map((agent) => digestOf(agent.genome)),
    runs[2].run.simulation.population.map((agent) => digestOf(agent.genome)),
    "genomes identical",
  );
});

await test("the engine tap is passive: lazy copies, protected, never awaited, return value discarded", () => {
  const start = SIMULATION_SOURCE.indexOf("function freezeProposalForObserver");
  const end = SIMULATION_SOURCE.indexOf("// --- Phase 5A: strategy islands");
  const region = SIMULATION_SOURCE.slice(start, end);
  assertIncludes(region, "function observeProductionEntry(makeFacts)");
  assertExcludes(region, "await");
  assertExcludes(region, "Promise");
  assertEqual(/jev/i.test(SIMULATION_SOURCE), false, "the engine never names the consumer");
  const call = SIMULATION_SOURCE.indexOf("observeProductionEntry(() => ({");
  const bestScoreSet = SIMULATION_SOURCE.lastIndexOf("ctx.bestScore = bestScore;", call);
  const open = SIMULATION_SOURCE.indexOf("if (!openPosition(agent, best, ctx))", call);
  assert(call > 0 && bestScoreSet > 0 && bestScoreSet < call && open > call, "tap sits after the final decision and before execution");
  const lineStart = SIMULATION_SOURCE.lastIndexOf("\n", call);
  assertEqual(SIMULATION_SOURCE.slice(lineStart + 1, call).trim(), "", "the tap return value is never assigned or read");
  const thunk = SIMULATION_SOURCE.slice(call, open);
  for (const literal of [`"${PS2D_PRODUCTION_SOURCE}"`, `"${PS2D_PRODUCTION_ACTION}"`, `"${PS2D_PRODUCTION_SELECTION}"`, "assessGates(agent.genome, best, ctx)", "structuredClone(best)"]) {
    assertIncludes(thunk, literal);
  }
  for (const forbidden of ["now()", "random", "nextId", "await"]) assertExcludes(thunk, forbidden);
  assertEqual((SIMULATION_SOURCE.match(/observeProductionEntry\(\(\) =>/g) ?? []).length, 1, "exactly one production-entry tap site");
  assertEqual((SIMULATION_SOURCE.match(/openPosition\(agent, best, ctx\)/g) ?? []).length, 1, "openPosition has exactly one caller");
});

/* ============================================================================
 * 7. SOL paths and historical sessions (tests 24, 25)
 * ==========================================================================*/

function solOpportunityInput() {
  const market = marketFor({ mint: SOL_MINT, symbol: "SOL", price: 200, at: BASE_AT, poolAgeHours: 20 });
  return {
    at: BASE_AT,
    generation: 1,
    generationTick: 1,
    agentId: "A-SOL-1",
    species: "Momentum",
    lineageId: "L-SOL-1",
    researchFamilyId: null,
    market,
    universeToken: tokenFor({ mint: SOL_MINT, symbol: "SOL", price: 200, at: BASE_AT, poolAgeHours: 20 }),
    byMint: new Map([[SOL_MINT, market], [USDC_MINT, { mint: USDC_MINT, price: 1 }]]),
    solScore: 0.8,
    agentEntryThreshold: 0.4,
  };
}

await test("(24) PS.2a SOL packet, question set and complete-input digest are unchanged with PS.2d enabled", async () => {
  async function capture(profile) {
    const { provider, calls } = fixtureProvider();
    const baseRoot = path.join(WORKSPACE, `sol-${profile ?? "off"}`);
    const observer = createSupervisorProposalObserver({
      sessionId: "jsup-ps2d-sol-compare",
      sessionRoot: path.join(baseRoot, "jsup-ps2d-sol-compare"),
      baseRoot,
      provider,
      finalizeTimeoutMs: 200,
      crossAsset: profile === null ? null : { profile },
    });
    observer.start();
    const handle = observer.observeSolOpportunity(solOpportunityInput());
    observer.recordSolSelection(handle, { actualSelectedMint: SOL_MINT });
    const deadline = Date.now() + 5_000;
    while (observer.snapshot().counters.solOpportunities < 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    await observer.finalize();
    const records = await readSupervisorLines(path.join(observer.sessionRoot, "sol-opportunities.ndjson"));
    return { payload: calls.payloads[0], record: records.records[0], state: await readSupervisorState(observer.sessionRoot), calls };
  }
  const off = await capture(null);
  const on = await capture("full");
  assertEqual(on.calls.ps2d, 0, "a SOL opportunity is never sent through the PS.2d question");
  assertDeepEqual(on.payload.state, off.payload.state, "SOL packet bytes");
  assertDeepEqual(on.payload.questions, off.payload.questions, "SOL question set");
  for (const field of ["jevInputDigest", "preOutcomeInputDigest", "packetDigest", "stateDigest", "marketObservationId"]) {
    assertEqual(on.record[field], off.record[field], `PS.2a ${field}`);
  }
  assertEqual(on.state.questionDigest, off.state.questionDigest);
  assert(on.state.questionDigest !== digestOf(buildCrossAssetQuestions()));
  for (const id of HISTORICAL_SESSIONS) {
    if (!SUPERVISOR_SESSIONS_BEFORE.includes(id)) continue;
    const historical = await readSupervisorSummary(path.join(SUPERVISOR_ROOT_DIR, id));
    assertEqual(on.state.questionDigest, historical.questionDigest, `the SOL question digest still equals ${id}'s recorded digest`);
    assertEqual(on.state.questionSetId, historical.questionSetId);
  }
});

await test("(24b) PS.2 SOL executed-proposal judgments are byte-identical with PS.2d enabled (generic path has no SOL special case)", async () => {
  const solSpec = { key: "SOL", mint: SOL_MINT, symbol: "SOL", base: 200, liquidity: 25_000_000, buyVolume: 3_000_000, sellVolume: 1_000_000, priceChange: 1, poolAgeHours: 20 };
  async function judgments(profile) {
    const { provider } = fixtureProvider();
    const baseRoot = path.join(WORKSPACE, `ps2-${profile ?? "off"}`);
    const observer = createSupervisorProposalObserver({
      sessionId: "jsup-ps2d-ps2-compare",
      sessionRoot: path.join(baseRoot, "jsup-ps2d-ps2-compare"),
      baseRoot,
      provider,
      finalizeTimeoutMs: 200,
      now: () => BASE_AT,
      crossAsset: profile === null ? null : { profile },
    });
    observer.start();
    // Synchronous engine run (no yields): the worker cannot interleave, so the
    // comparison is timing-independent; 15 ticks keeps PS.2 below its queue bound.
    await runEngine({ observer, feed: createMultiAssetFeed({ specs: [solSpec] }), ticks: 15, yieldsPerTick: 0 });
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const snap = observer.snapshot();
      const xa = snap.crossAssetShadow;
      if (snap.queue.depth === 0 && snap.pendingDrafts === 0 && (xa === null || xa.queue.depth === 0)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await observer.finalize();
    const lines = await readSupervisorLines(path.join(observer.sessionRoot, "judgments.ndjson"));
    return {
      dropped: observer.snapshot().queue.dropped,
      rows: lines.records
        .map((record) => [record.sequence, record.proposalDigest, record.packetDigest, record.preOutcomeInputDigest, record.stateDigest, record.pHigher, record.agreement])
        .sort((a, b) => a[0] - b[0]),
      block: observer.snapshot().crossAssetShadow,
    };
  }
  const off = await judgments(null);
  const on = await judgments("full");
  assert(off.rows.length > 0, "SOL executed proposals must be judged in the fixture");
  assertEqual(on.dropped, off.dropped, "identical (deterministic) PS.2 queue behaviour");
  assertEqual(on.rows.length, off.rows.length, "same number of PS.2 SOL judgments");
  const columns = ["sequence", "proposalDigest", "packetDigest", "preOutcomeInputDigest", "stateDigest", "pHigher", "agreement"];
  on.rows.forEach((row, index) => {
    columns.forEach((column, c) => assertEqual(row[c], off.rows[index][c], `PS.2 SOL judgment ${index} ${column}`));
  });
  assert(on.block.assetRows.some((row) => row.baseMint === SOL_MINT), "a genuine SOL entry IS a generic PS.2d opportunity (no special case either way)");
});

await test("(25) historical sessions stay readable, unchanged and free of PS.2d fields", async () => {
  const present = HISTORICAL_SESSIONS.filter((id) => SUPERVISOR_SESSIONS_BEFORE.includes(id));
  for (const id of present) {
    const root = path.join(SUPERVISOR_ROOT_DIR, id);
    const summary = await readSupervisorSummary(root);
    const state = await readSupervisorState(root);
    const session = await readSupervisorSession(root);
    assertEqual(summary.sessionId, id);
    for (const doc of [summary, state, session]) assertEqual(Object.hasOwn(doc, "crossAssetShadow"), false, `${id} is never back-filled`);
    const copyRoot = path.join(WORKSPACE, `historical-${id}`);
    await cp(root, path.join(copyRoot, "jev-supervisor-observer", id), { recursive: true });
    const block = await loadJevSupervisorObserverState(copyRoot, { now: () => BASE_AT });
    assertEqual(block.available, true);
    assertEqual(block.sessionId, id);
    assertEqual(block.crossAssetShadow, null, "absence is read as not-run");
    assertEqual(block.jevCalls, summary.jevCalls);
  }
  if (SUPERVISOR_SESSIONS_BEFORE.includes("jsup-20260922T151045Z-063f35")) {
    const summary = await readSupervisorSummary(path.join(SUPERVISOR_ROOT_DIR, "jsup-20260922T151045Z-063f35"));
    assertEqual(summary.solFunnel.solAgentEvaluations, 54202);
  }
  if (SUPERVISOR_SESSIONS_BEFORE.includes("jsup-20260923T042620Z-d1368a")) {
    const summary = await readSupervisorSummary(path.join(SUPERVISOR_ROOT_DIR, "jsup-20260923T042620Z-d1368a"));
    assertEqual(summary.solAgeCounterfactual.solAgeCounterfactualEvaluations, 53880);
    assertEqual(summary.jevCalls, 0);
  }
});

/* ============================================================================
 * 8. External-call governance (test 26)
 * ==========================================================================*/

await test("(26) external-call policy: evidence-bearing, no fallback, fail closed, bounded", () => {
  for (const name of PS2D_CLI_PROFILES) {
    const policy = crossAssetExternalCallPolicy(PS2D_PROFILES[name], { provider: SUPERVISOR_REQUIRED_PROVIDER, model: SUPERVISOR_REQUIRED_MODEL });
    const record = externalPolicyRecord({ candidate: policy, evidenceBearing: true });
    assertEqual(record.validation.status, "PASS", record.validation.problems.join("; "));
    assertEqual(policy.fallback, "none");
    assertEqual(policy.failClosed, true);
    assertEqual(policy.authorityLevel, "SHADOW");
    assertEqual(policy.maxCallsPerRun, PS2D_PROFILES[name].globalMaxJevCallsPerRun);
    assertEqual(policy.timeoutMs, PS2D_TIMEOUT_MS);
    assertEqual(policy.retryCap, PS2D_RETRY_CAP);
    assert(PS2D_RETRY_CAP >= 0 && PS2D_RETRY_CAP <= 1);
    assert(policy.circuitBreaker.failureThreshold > 0 && policy.circuitBreaker.cooldownMs > 0);
    for (const tampered of [{ fallback: "mock-jev" }, { failClosed: false }, { retryCap: 9 }, { maxCallsPerRun: 5000 }, { authorityLevel: "DEPLOYMENT" }]) {
      assertEqual(externalPolicyRecord({ candidate: { ...policy, ...tampered }, evidenceBearing: true }).validation.status, "FAIL", JSON.stringify(tampered));
    }
  }
  assertIncludes(CLI_SOURCE, "config: { ...envConfig, transportChain: [], ...PS2D_TRANSPORT_SETTINGS }", "frozen transport spread LAST");
  const hostileEnv = { maxAttemptsPerCall: 5, maxAttempts: 5, backoffBaseMs: 600_000, backoffMaxMs: 600_000, cooldownMs: 3_600_000, cooldownMaxMs: 3_600_000 };
  const resolved = resolveJevTransportSettings({ ...hostileEnv, transportChain: [], ...protocol.PS2D_TRANSPORT_SETTINGS });
  for (const [key, value] of Object.entries(protocol.PS2D_TRANSPORT_SETTINGS)) {
    assertEqual(resolved[key === "maxAttemptsPerCall" ? "maxAttempts" : key], value, `env cannot override PS.2d ${key}`);
  }
  assertEqual(protocol.PS2D_RETRY_AFTER_CEILING_MS, JEV_RETRY_AFTER_MAX_MS, "declared Retry-After ceiling matches the transport");
  assertEqual(protocol.PS2D_WORST_CASE_CALL_MS, 2 * PS2D_TIMEOUT_MS + JEV_RETRY_AFTER_MAX_MS);
  const gate = CLI_SOURCE.indexOf("validateExternalPolicy(");
  assert(gate > 0 && gate < CLI_SOURCE.indexOf("await ensureSupervisorDir(sessionRoot"), "the CLI validates the policy before any artifact exists");
  for (const name of PS2D_CLI_PROFILES) {
    const policy = crossAssetExternalCallPolicy(PS2D_PROFILES[name], { provider: SUPERVISOR_REQUIRED_PROVIDER, model: SUPERVISOR_REQUIRED_MODEL });
    assertDeepEqual(crossAssetPolicyProblems(policy, PS2D_PROFILES[name]), []);
    for (const tampered of [{ fallback: "vercel-jev" }, { failClosed: false }, { maxCallsPerRun: 999 }, { authorityLevel: "OBSERVE+" }, { retryCap: 7 }]) {
      assert(crossAssetPolicyProblems({ ...policy, ...tampered }, PS2D_PROFILES[name]).length > 0, `runtime self-check refuses ${JSON.stringify(tampered)}`);
    }
  }
  assertIncludes(CLI_SOURCE, "timeoutMs: PS2D_TIMEOUT_MS");
  assertIncludes(CLI_SOURCE, "PS2D_PROVIDER_HEALTH_DIR");
  assertExcludes(CLI_SOURCE.slice(CLI_SOURCE.indexOf("let crossAsset = null")), "vercel");
});

await test("(26b) pins fail closed: a forbidden provider is never called; no fallback route exists", async () => {
  const { provider, calls } = fixtureProvider({ name: "mock-jev" });
  const observer = observerFor({ label: "pins", provider: fixtureProvider().provider, crossAsset: { profile: "full", provider } });
  observer.start();
  observer.observeProductionEntry(entryFacts());
  await settleCrossAsset(observer);
  await observer.finalize();
  assertEqual(calls.count, 0);
  const block = observer.summary().crossAssetShadow;
  assertEqual(block.pinsOk, false);
  assertEqual(block.counters.skippedPinMismatch, 1);
  assertEqual(block.counters.jevCalls, 0);
  const records = await readSupervisorCrossAssetObservations(observer.sessionRoot);
  assertEqual(records.records[0].disposition, "SKIPPED_PIN_MISMATCH");
  assertEqual(records.records[0].stance, null);
});

await test("(26c) malformed output is never retried; transient failures retry at most retryCap", async () => {
  async function attemptsFor(outcome) {
    let attempts = 0;
    const transport = createResilientJevTransport({
      providers: [{ name: SUPERVISOR_REQUIRED_PROVIDER, model: SUPERVISOR_REQUIRED_MODEL, external: true, async evaluate() { attempts += 1; return outcome; } }],
      settings: { maxAttemptsPerCall: protocol.PS2D_MAX_TRANSPORT_ATTEMPTS, backoffBaseMs: 0, backoffMaxMs: 0 },
      healthRoot: null,
      sleepImpl: async () => {},
      randomImpl: () => 0,
    });
    await transport.evaluate({ state: {}, questions: {} });
    return attempts;
  }
  assertEqual(await attemptsFor({ ok: true, answers: { [PS2D_QUESTION_NAME]: { type: "noul", noul: "x" } } }), 1, "malformed: one attempt");
  assertEqual(await attemptsFor({ ok: false, status: JEV_STATUS.TIMEOUT, reason: "t" }), PS2D_RETRY_CAP + 1, "transient: bounded retries");
  assertEqual(await attemptsFor({ ok: false, status: JEV_STATUS.CONFIG_ERROR, reason: "c" }), 1, "non-retryable: one attempt");
});

await test("(26e) a transport-cooldown answer is NOT a Jev call, NOT a failure and never trips the breaker", async () => {
  const { provider, calls } = fixtureProvider({
    onEvaluate: () => ({ ok: false, status: JEV_STATUS.COOLDOWN, reason: "cooldown active; no network call was made" }),
  });
  const observer = observerFor({ label: "transport-cooldown", provider });
  observer.start();
  for (let i = 0; i < 8; i += 1) observer.observeProductionEntry(entryFacts({ mint: mintOf(`Cdn${i}x`), agentId: `A-CDN-${i}` }));
  await settleCrossAsset(observer);
  await observer.finalize();
  const block = observer.summary().crossAssetShadow;
  assertEqual(calls.ps2d, 8, "fixture: every item reached the (cooling-down) transport");
  assertEqual(block.counters.skippedTransportCooldown, 8);
  assertEqual(block.counters.jevCalls, 0, "no network call was made, so no Jev call is counted");
  assertEqual(block.counters.jevFailures, 0);
  assertEqual(block.circuitBreaker.trips, 0, "transport cooldowns never feed the PS.2d breaker");
  for (const [name, holds] of Object.entries(block.accountingIdentities)) assertEqual(holds, true, `identity ${name}`);
  const records = await readSupervisorCrossAssetObservations(observer.sessionRoot);
  assert(records.records.every((record) => record.disposition === "SKIPPED_TRANSPORT_COOLDOWN" && record.stance === null));
  assertEqual((await readSupervisorSession(observer.sessionRoot)).finalizeTimedOut, false);
});

await test("(26d) circuit breaker: 5 consecutive failures open it; skipped items make NO call", async () => {
  let clock = BASE_AT;
  const { provider, calls } = fixtureProvider({ behavior: "fail" });
  const observer = observerFor({ label: "breaker", provider, now: () => clock });
  observer.start();
  for (let i = 0; i < 8; i += 1) observer.observeProductionEntry(entryFacts({ mint: mintOf(`Brk${i}x`), agentId: `A-BRK-${i}` }));
  await settleCrossAsset(observer);
  let block = observer.snapshot().crossAssetShadow;
  assertEqual(calls.ps2d, 5, "exactly the threshold number of failing calls");
  assertEqual(block.counters.skippedCircuitOpen, 3);
  assertEqual(block.circuitBreaker.open, true);
  clock += protocol.PS2D_CIRCUIT_BREAKER.cooldownMs;
  observer.observeProductionEntry(entryFacts({ mint: mintOf("BrkHafpen"), agentId: "A-BRK-H" }));
  await settleCrossAsset(observer);
  block = observer.snapshot().crossAssetShadow;
  assertEqual(calls.ps2d, 6, "half-open: one probe call after the cooldown");
  assertEqual(block.circuitBreaker.trips, 2, "a failed probe re-opens immediately");
  await observer.finalize();
});

/* ============================================================================
 * 9. Records, storage bounds, reporting, dashboard (tests 27–30)
 * ==========================================================================*/

await test("records: every sent payload is exactly the digested complete input", async () => {
  const { provider, calls } = fixtureProvider();
  const observer = observerFor({ label: "records", provider });
  observer.start();
  await runEngine({ observer, yieldsPerTick: 1 });
  await settleCrossAsset(observer);
  await observer.finalize();
  const records = (await readSupervisorCrossAssetObservations(observer.sessionRoot)).records;
  const sent = calls.payloads.filter((payload) => payload.names.includes(PS2D_QUESTION_NAME));
  assertEqual(records.length, sent.length);
  const byDigest = new Map(records.map((record) => [record.jevInputDigest, record]));
  for (const payload of sent) {
    const digest = crossAssetInputDigestOf(completeInputFor(payload.state, { questions: payload.questions }));
    const record = byDigest.get(digest);
    assert(record !== undefined, "the digest of what the provider received must match a record");
    assertEqual(canonicalJson(record.packet), canonicalJson(payload.state), "persisted packet = sent packet");
    assertEqual(record.packetDigest, digestOf(payload.state));
  }
  for (const record of records) {
    assertEqual(record.evidenceClassification, PS2D_EVIDENCE_CLASSIFICATION);
    assertEqual(record.canonicalEvidence, false);
    assertEqual(record.noAuthorityPromotion, true);
    assertEqual(record.disposition, "JEV_OK");
    assertEqual(record.stanceIsCorrectness, false);
    assertEqual(record.typedResponse.questionName, PS2D_QUESTION_NAME);
    assertDeepEqual(record.usage, { inputTokens: 120, outputTokens: 4 });
    assertEqual(record.protocolDigest, PS2D_PROTOCOL_DIGEST);
  }
  const text = await readFile(path.join(observer.sessionRoot, "cross-asset-observations.ndjson"), "utf8");
  for (const forbidden of ["apiKey", "authorization", "EVOLVE_JEV_API_KEY", "rawResponse\""]) assertExcludes(text, forbidden);
  const session = await readSupervisorSession(observer.sessionRoot);
  const summary = await readSupervisorSummary(observer.sessionRoot);
  const audit = auditNoForbiddenResultFields(summary);
  assertEqual(audit.ok, true, `summary.json carries no winner/rank/profit/outcome keys: ${audit.problems.join(", ")}`);
  for (const [name, holds] of Object.entries(summary.crossAssetShadow.accountingIdentities)) assertEqual(holds, true, `persisted identity ${name}`);
  assertEqual(session.crossAssetShadow.profile, "full");
  assertDeepEqual(session.crossAssetShadow.externalCallPolicyProblems, []);
  assertEqual(session.crossAssetShadow.externalCallPolicy.fallback, "none");
  assertEqual(NETWORK_ATTEMPTS, 0);
});

await test("(11c) within a tick, population (fitness-ranked) order cannot decide which proposal is sampled", async () => {
  // Several agents propose the SAME asset in the same tick; after breeding the
  // engine's population order is fitness-ranked, so order must not matter.
  const tick = (generation, generationTick, at) =>
    ["A-ELITE", "A-SURVIVOR", "A-NEWBORN", "A-IMMIGRANT"].map((agentId, index) =>
      entryFacts({ agentId, at, generation, generationTick, score: 0.5 + index / 100, mint: index % 2 ? MINT.B : MINT.A }),
    );
  const sequences = [
    [...tick(1, 1, BASE_AT), ...tick(1, 2, BASE_AT + 30_000), ...tick(1, 3, BASE_AT + 90_000)],
    [...tick(1, 1, BASE_AT).reverse(), ...tick(1, 2, BASE_AT + 30_000).reverse(), ...tick(1, 3, BASE_AT + 90_000).reverse()],
    [...tick(1, 1, BASE_AT).slice(2), ...tick(1, 1, BASE_AT).slice(0, 2), ...tick(1, 2, BASE_AT + 30_000), ...tick(1, 3, BASE_AT + 90_000).reverse()],
  ];
  const outcomes = [];
  for (const [index, sequence] of sequences.entries()) {
    const { provider } = fixtureProvider();
    const observer = observerFor({ label: `order-${index}`, provider, writeArtifacts: false });
    for (const facts of sequence) observer.observeProductionEntry(facts);
    await observer.finalize();
    const block = observer.summary().crossAssetShadow;
    outcomes.push(canonicalJson({ counters: block.counters, rows: block.assetRows, digest: block.aggregateDigest }));
  }
  assertEqual(outcomes[1], outcomes[0], "reversed within-tick order: identical sample");
  assertEqual(outcomes[2], outcomes[0], "rotated within-tick order: identical sample");
});

await test("(11d) sampling decisions do not depend on WHEN a complete tick is flushed", async () => {
  const facts = [];
  for (let t = 0; t < 24; t += 1) {
    for (let k = 0; k < 5; k += 1) {
      facts.push(entryFacts({ agentId: `A-${k}`, at: BASE_AT + t * 20_000, generation: 1 + Math.floor(t / 10), generationTick: t % 10, mint: [MINT.A, MINT.B, MINT.C][(t + k) % 3] }));
    }
  }
  const SAMPLING_FIELDS = ["productionEntryFactsReceived", "genuineProductionOpportunitiesObserved", "schemaEligible", "suppressedDuplicateDigest", "suppressedPerAssetCap", "suppressedAssetCooldown", "suppressedGlobalCap", "admittedBySampler"];
  const ROW_FIELDS = ["marketId", "productionOpportunities", "schemaEligible", "suppressedDuplicateDigest", "suppressedPerAssetCap", "suppressedAssetCooldown", "suppressedGlobalCap", "admitted", "lastAdmittedAt"];
  const results = [];
  let workerFlushes = 0;
  for (const withWorker of [false, true]) {
    const { provider } = fixtureProvider();
    const observer = observerFor({ label: `flush-${withWorker}`, provider, writeArtifacts: false, profile: "canary" });
    if (withWorker) observer.start();
    let lastKey = null;
    for (const entry of facts) {
      const key = `${entry.generation}:${entry.generationTick}`;
      if (withWorker && lastKey !== null && key !== lastKey) {
        // Between two synchronous engine ticks the worker loop may run and flush.
        await new Promise((resolve) => setTimeout(resolve, 40));
        if (observer.snapshot().crossAssetShadow.bufferedEligibleOpportunities === 0) workerFlushes += 1;
      }
      lastKey = key;
      observer.observeProductionEntry(entry);
    }
    await observer.finalize();
    const block = observer.summary().crossAssetShadow;
    results.push(canonicalJson({
      counters: Object.fromEntries(SAMPLING_FIELDS.map((field) => [field, block.counters[field]])),
      rows: block.assetRows.map((row) => Object.fromEntries(ROW_FIELDS.map((field) => [field, row[field]]))),
    }));
  }
  assert(workerFlushes > 10, `the worker must really flush between ticks (${workerFlushes})`);
  assertEqual(results[1], results[0], "worker-timed flushes and tap-timed flushes make identical decisions");
});

await test("(11b) engine: two identical runs produce the identical PS.2d sample", async () => {
  const digests = [];
  for (let i = 0; i < 2; i += 1) {
    const { provider } = fixtureProvider();
    const observer = observerFor({ label: `repeat-${i}`, provider, writeArtifacts: false, now: () => BASE_AT });
    observer.start();
    await runEngine({ observer });
    await observer.finalize();
    const block = observer.summary().crossAssetShadow;
    digests.push([block.aggregateDigest, canonicalJson(block.counters), canonicalJson(block.assetRows)]);
  }
  assertDeepEqual(digests[0], digests[1]);
});

await test("(27) runtime writes stay bounded (records ≤ cap, rows ≤ bound, overflow explicit)", async () => {
  const { provider } = fixtureProvider();
  const observer = observerFor({ label: "bounded", provider, profile: "canary" });
  observer.start();
  for (let i = 0; i < 400; i += 1) observer.observeProductionEntry(entryFacts({ mint: mintOf(`Bnd${i}x`), agentId: `A-B-${i}`, at: BASE_AT + i }));
  await settleCrossAsset(observer);
  await observer.finalize();
  const records = await readSupervisorCrossAssetObservations(observer.sessionRoot);
  assertEqual(records.records.length, PS2D_PROFILES.canary.globalMaxJevCallsPerRun);
  const summary = await readSupervisorSummary(observer.sessionRoot);
  const block = summary.crossAssetShadow;
  assertEqual(block.totalAssetCount, 400);
  assertEqual(block.rowsStored, PS2D_MAX_PERSISTED_ASSET_ROWS);
  assertEqual(block.rowsTruncated, 400 - PS2D_MAX_PERSISTED_ASSET_ROWS);
  assertEqual(block.truncatedRowsAggregate.productionOpportunities, 400 - PS2D_MAX_PERSISTED_ASSET_ROWS, "no silent truncation");
  assertEqual(typeof block.aggregateDigest, "string");
  const stateBytes = (await stat(path.join(observer.sessionRoot, "state.json"))).size;
  const summaryBytes = (await stat(path.join(observer.sessionRoot, "summary.json"))).size;
  assert(stateBytes < 96_000, `state.json stays compact (${stateBytes} bytes)`);
  assert(summaryBytes < 256_000, `summary.json stays bounded (${summaryBytes} bytes)`);
  const files = await readdir(observer.sessionRoot);
  assertDeepEqual(files.filter((file) => /cross-asset/.test(file)), ["cross-asset-observations.ndjson"], "one PS.2d file only");
  const tracker = createCrossAssetSampler({ profile: PS2D_PROFILES.full, maxTrackedAssets: 16 });
  for (let i = 0; i < 64; i += 1) tracker.decide(samplerInput(mintOf(`Trk${i}x`), BASE_AT));
  const snap = tracker.snapshot();
  assertEqual(snap.totalAssetCount, 16);
  assertEqual(snap.overflowActive, true);
  assertEqual(snap.overflowAggregate.productionOpportunities, 48, "overflow assets are aggregated explicitly");
  assertEqual(snap.counters.uniqueAssetsObservedIsUpperBound, true);
});

await test("(28) per-asset reporting: every genuine asset, encounter order, never ranked", () => {
  const sampler = createCrossAssetSampler({ profile: PS2D_PROFILES.full });
  sampler.decide(samplerInput(MINT.A, BASE_AT));
  for (let i = 0; i < 25; i += 1) sampler.decide(samplerInput(MINT.B, BASE_AT + i * 61_000));
  sampler.noteSchemaIneligible({ identity: crossAssetIdentityOf({ mint: MINT.C, symbol: "C" }), reason: "invalid_liquidity", atMs: BASE_AT });
  const snap = sampler.snapshot();
  assertDeepEqual(snap.assetRows.map((row) => row.baseMint), [MINT.A, MINT.B, MINT.C], "encounter order, not count order");
  assertEqual(snap.assetRows[2].jevCalls, 0, "never-sent assets are persisted too");
  assertEqual(snap.assetRows[2].schemaIneligible, 1);
  assertEqual(snap.assetRowOrder, "ENCOUNTER_ORDER_NOT_RANKED");
  assertEqual(auditNoForbiddenResultFields(snap).ok, true);
  for (const row of snap.assetRows) {
    for (const key of Object.keys(row)) assert(!/rank|best|winner|score|profit|pnl|return/i.test(key), `row key '${key}' must not rank or judge`);
  }
});

await test("(29) dashboard: separate CROSS-ASSET PRODUCTION SHADOW block, zero-authority label, neutral table", async () => {
  const root = path.join(WORKSPACE, "dashboard-root");
  const { provider } = fixtureProvider();
  const observer = observerFor({ label: "dashboard", provider, baseRoot: path.join(root, "jev-supervisor-observer") });
  observer.start();
  await runEngine({ observer, yieldsPerTick: 1 });
  await settleCrossAsset(observer);
  await observer.finalize();
  const block = (await loadJevSupervisorObserverState(root, { now: () => BASE_AT })).crossAssetShadow;
  assertEqual(block.label, "CROSS-ASSET PRODUCTION SHADOW");
  assertEqual(block.authorityTag, "DEVELOPMENT SHADOW • ZERO AUTHORITY");
  assertEqual(block.zeroAuthority, true);
  assertEqual(block.winner, null);
  assertEqual(block.assetsRanked, false);
  for (const field of ["genuineProductionOpportunitiesObserved", "uniqueAssetsObserved", "schemaEligible", "queuedForJev", "jevOk", "jevFailures", "suppressedAssetCooldown", "suppressedDuplicateDigest", "suppressedPerAssetCap", "suppressedGlobalCap"]) {
    assertEqual(typeof block.counters[field], "number", `dashboard counter ${field}`);
  }
  assert(Number.isFinite(block.queue.highWatermark) && Number.isFinite(block.queue.dropped) && Number.isFinite(block.queue.depth));
  assert(block.assetRows.length > 0 && block.assetRows.length <= protocol.PS2D_MAX_DASHBOARD_ASSET_ROWS);
  assertEqual(auditNoForbiddenResultFields(block).ok, true);
  const stateText = await readFile(path.join(observer.sessionRoot, "state.json"), "utf8");
  for (const forbidden of ['"packetDigest":', '"preOutcomeInputDigest":', '"marketState":', '"packet":']) assertExcludes(stateText, forbidden, "state.json stays compact");
  const start = PAGE_SOURCE.indexOf("{observer.crossAssetShadow && (");
  const end = PAGE_SOURCE.indexOf("\n            )}\n", start);
  assert(start > 0 && end > start);
  const panel = PAGE_SOURCE.slice(start, end);
  assertIncludes(panel, "CROSS-ASSET PRODUCTION SHADOW");
  assertIncludes(panel, "DEVELOPMENT SHADOW • ZERO AUTHORITY");
  for (const label of ["Production opportunities", "Assets observed", "Schema eligible", "Queued", "Jev OK", "Jev failed", "Suppressed by cooldown", "Suppressed by duplicate", "Suppressed by per-asset cap", "Suppressed by global cap", "Queue depth / high water / dropped", "Jev calls made", "Skipped without a call", "Unsent / in flight at finalize", "Provider pins / circuit breaker"]) {
    assertIncludes(panel, label);
  }
  assertExcludes(panel, "positive", "no green winner presentation");
  assertExcludes(panel, "negative", "no red loser presentation");
  const withoutNegations = panel.replace("no winner, no ranking", "").replace("not ranked", "");
  for (const forbidden of [/profit/i, /\bwinners?\b/i, /\bbest\b/i, /\branked\b/i, /\branking\b/i, /\btop\b/i, /recommend/i]) {
    assert(!forbidden.test(withoutNegations), `forbidden framing ${forbidden}`);
  }
});

await test("(30) no automatic authority promotion path exists", () => {
  assertEqual(PS2D_FLAGS.noAuthorityPromotion, true);
  assertEqual(PS2D_FLAGS.automaticPromotionPermitted, false);
  assertEqual(AUTOMATIC_PROMOTION_PROHIBITED.automaticPromotionPermitted, false);
  for (const [file, text] of Object.entries(PS2D_SOURCES)) {
    assert(!/function\s+\w*promot/i.test(text), `${file} must not define a promotion function`);
    assert(!/authorityLevel:\s*"(?!SHADOW")/.test(text), `${file} must not declare authority beyond SHADOW`);
    for (const flag of ["jevHasTradingAuthority: true", "canonicalEvidence: true", "replicationEvidence: true", "temporalReplicationEvidence: true"]) {
      assertExcludes(text, flag);
    }
  }
});

await test("CLI: --cross-asset takes a frozen profile NAME only; absent means disabled", () => {
  assertEqual(buildSupervisorSettings({}).crossAssetProfile, null);
  assertEqual(buildSupervisorSettings({ "cross-asset": "canary" }).crossAssetProfile, "canary");
  assertEqual(buildSupervisorSettings({ "cross-asset": "FULL" }).crossAssetProfile, "full");
  for (const bad of ["offline-validation", "200", "true", ""]) {
    const settings = buildSupervisorSettings({ "cross-asset": bad });
    assert(settings.problems.some((entry) => entry.includes("invalid --cross-asset")), `'${bad}' must be refused`);
  }
  assertIncludes(CLI_SOURCE, "crossAsset,");
  assertIncludes(PACKAGE_JSON.scripts["validate:jev-supervisor"], "node scripts/validate-phase5i-ps2.mjs");
  assertIncludes(PACKAGE_JSON.scripts["validate:jev-supervisor"], "node scripts/validate-phase5i-ps2d.mjs");
});

/* ============================================================================
 * 10. Preservation: every protected tree byte-identical
 * ==========================================================================*/

await test("preservation: every protected evidence tree is byte-identical", async () => {
  for (const root of PROTECTED_TREES) {
    const comparison = compareSnapshots(TREES_BEFORE[root], await snapshotTree(root));
    assertEqual(comparison.identical, true, `${root}: ${JSON.stringify({ added: comparison.added, removed: comparison.removed, changed: comparison.changed })}`);
  }
  assertDeepEqual(await listSupervisorSessions(SUPERVISOR_ROOT_DIR), SUPERVISOR_SESSIONS_BEFORE, "no supervisor session created or removed");
  assertEqual(NETWORK_ATTEMPTS, 0, "the whole suite stayed offline");
});

/* ============================================================================
 * Report
 * ==========================================================================*/

await rm(WORKSPACE, { recursive: true, force: true }).catch(() => {});

console.log(`\n${PS2D_LABEL} (Phase 5I-PS.2d) — ${PS2D_AUTHORITY_TAG}`);
console.log(`  ${PASSED} passed, ${FAILED} failed${FAILED > 0 ? "" : " — production state unchanged, zero authority"}`);
if (FAILED > 0) {
  for (const failure of FAILURES) console.log(`  FAILED: ${failure.name}`);
}
// Hung fixture providers must never keep the process (or CI) alive.
process.exit(FAILED === 0 ? 0 : 1);
