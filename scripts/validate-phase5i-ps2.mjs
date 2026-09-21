#!/usr/bin/env node
/**
 * EVOLVE Phase 5I-PS.2 — JEV SUPERVISOR OBSERVER validation suite. FULLY OFFLINE.
 *
 * Proves that Jev, in the role originally intended for EVOLVE (an OUTSIDE
 * decision supervisor observing deterministic EVOLVE paper decisions), has
 * ZERO authority:
 *
 *   - the passive proposal tap freezes a proposal BEFORE paper execution and
 *     attaches the execution result AFTER it;
 *   - the asynchronous observer can never delay, block or alter the engine
 *     (proven by observer-disabled/observer-enabled equivalence with a normal,
 *     throwing, malformed, failing and deliberately slow observer);
 *   - classification, agreement semantics, exact-half metadata and the absence
 *     of any confidence threshold are frozen before results;
 *   - only SOL-USDC is evaluated; every other asset is skipped with NO call;
 *   - the provider pins are direct-TypeSafe only, fail closed, with no gateway,
 *     no cache, no fallback and no mock;
 *   - the bounded queue drops observer work explicitly and never slows the
 *     engine;
 *   - storage is isolated and the canonical 5I tree, its replication/temporal
 *     subtrees, Paper Shadow, the forensic analyzer tree, the Shadow League and
 *     the Arena are byte-identical before and after.
 *
 * NOTHING HERE TOUCHES THE NETWORK, A PROVIDER, A WALLET OR A CHAIN. Every
 * fixture provider is a local async function, every session is written to a
 * temp directory, and no live observer session is ever started.
 *
 * Run with: npm run validate:jev-supervisor
 */

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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
  throw new Error("network is forbidden in the Phase 5I-PS.2 validation suite");
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

const { digestOf } = await import("./lib/hash.mjs");
const { sanitizeForPublic } = await import("./lib/sanitize.mjs");
const { createMarketConfig } = await import("./market/config.mjs");
const { createSeededRandom } = await import("./lib/random.mjs");
const { createIdFactory } = await import("./lib/ids.mjs");
const { createMarketFeed } = await import("./market/feed.mjs");
const { deriveMarket, MOMENTUM_REFERENCE } = await import("./market/normalize.mjs");
const { createSimulation } = await import("./engine/simulation.mjs");
const { DIRECTION_QUESTION_NAME } = await import("./jev/direction/questions.mjs");
const { BENCHMARK_MARKET } = await import("./jev/direction/definition.mjs");
const { resolveJevConfig } = await import("./jev/config.mjs");
const {
  SUPERVISOR_ACTIONS,
  SUPERVISOR_AGREEMENT,
  SUPERVISOR_AGREEMENT_NO_INTENT_REASON,
  SUPERVISOR_CACHE_ENABLED,
  SUPERVISOR_CLASSIFICATION,
  SUPERVISOR_DEFAULT_DURATION_MINUTES,
  SUPERVISOR_DIRECTIONAL_INTENTS,
  SUPERVISOR_DURATION_BOUNDS,
  SUPERVISOR_EXACT_HALF,
  SUPERVISOR_FORBIDDEN_PROVIDERS,
  SUPERVISOR_FORBIDDEN_WRITE_ROOTS,
  SUPERVISOR_ISOLATION_STATEMENT,
  SUPERVISOR_KIND,
  SUPERVISOR_LABEL,
  SUPERVISOR_LIFECYCLE_EXIT_REASONS,
  SUPERVISOR_MARKET_ID,
  SUPERVISOR_MAX_JEV_CALLS,
  SUPERVISOR_MODE,
  SUPERVISOR_NO_AUTHORITY_TAG,
  SUPERVISOR_PHASE,
  SUPERVISOR_PURPOSE,
  SUPERVISOR_QUEUE_CAPACITY,
  SUPERVISOR_REASONS,
  SUPERVISOR_REQUIRED_GATEWAY_USED,
  SUPERVISOR_REQUIRED_MODEL,
  SUPERVISOR_REQUIRED_PROVIDER,
  SUPERVISOR_REQUIRED_UPSTREAM_PROVIDER,
  SUPERVISOR_ROOT_DIR,
  SUPERVISOR_STATEMENT,
  SUPERVISOR_SUPPORTED_MARKET_IDS,
  SUPERVISOR_SUPPORTED_MINTS,
  SUPERVISOR_QUOTE_MINT,
  SUPERVISOR_UNSUPPORTED_MARKET_REASON,
  SUPERVISOR_EVIDENCE_TYPES,
  SUPERVISOR_MAX_UNSUPPORTED_SAMPLE,
  SUPERVISOR_PHASE_EXTENSION,
  SUPERVISOR_ROW_KINDS,
  SUPERVISOR_SOL_DEDUP_RULE,
  SUPERVISOR_SOL_OPPORTUNITY_EVIDENCE_TYPE,
  SUPERVISOR_SOL_QUEUE_CAPACITY,
  assertSupervisorWriteTarget,
  isValidSupervisorSessionId,
  supervisorSessionIdFor,
  supervisorSessionRootFor,
} = await import("./jev/supervisor/definition.mjs");
const {
  SUPERVISOR_TAP_DEFINITION,
  SUPERVISOR_SOL_TAP_DEFINITION,
  agreementFor,
  buildProposalFacts,
  classifyProposal,
  deepFreeze,
  distanceFromHalfOf,
  exactlyHalfOf,
  freezeExecution,
  isSupportedMint,
  marketIdForMint,
  modelIntentFromProbability,
  proposalDigestOf,
  solOpportunityDedupKey,
} = await import("./jev/supervisor/tap.mjs");
const { createBoundedObserverQueue } = await import("./jev/supervisor/queue.mjs");
const {
  ensureSupervisorDir,
  listSupervisorSessions,
  readSupervisorLines,
  readSupervisorSession,
  readSupervisorSolJudgments,
  readSupervisorSolOpportunities,
  readSupervisorState,
  readSupervisorSummary,
  supervisorSummaryDigestOf,
  SUPERVISOR_WRITE_FILES,
} = await import("./jev/supervisor/storage.mjs");
const { auditNoForbiddenResultFields, buildSupervisorSummary } = await import("./jev/supervisor/summary.mjs");
const { evaluateSupervisorProviderPins, createSupervisorProposalObserver } = await import(
  "./jev/supervisor/observer.mjs"
);
const { buildSupervisorSettings, enforceSupervisorProviderPins } = await import(
  "./jev/supervisor/settings.mjs"
);
const { loadJevSupervisorObserverState } = await import("./jev/supervisor/dashboard.mjs");
const { PAPER_SHADOW_ROOT_DIR } = await import("./jev/paper-shadow/definition.mjs");
const { PAPER_FORENSICS_ROOT_DIR } = await import("./jev/paper-forensics/definition.mjs");
const {
  snapshotTree,
  compareSnapshots,
  preservationProof,
  snapshotPreservationTargets,
} = await import("./jev/paper-forensics/preservation.mjs");

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
    console.log(`  \u2713 ${name}`);
  } catch (error) {
    FAILED += 1;
    FAILURES.push({ name, error });
    console.log(`  \u2717 ${name}\n      ${error?.stack?.split("\n").slice(0, 4).join("\n      ") ?? error}`);
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

function assertClose(actual, expected, tolerance, message) {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message ?? "closeness"}: expected ~${expected}, got ${actual}`);
  }
}

function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message ?? "deep equality"}: expected ${b}, got ${a}`);
}

function assertIncludes(haystack, needle, message) {
  if (!String(haystack).includes(needle)) throw new Error(`${message ?? "includes"}: ${needle} not found`);
}

function assertExcludes(haystack, needle, message) {
  if (String(haystack).includes(needle)) throw new Error(`${message ?? "excludes"}: ${needle} unexpectedly found`);
}

function assertThrows(fn, pattern, message) {
  let threw = false;
  try {
    fn();
  } catch (error) {
    threw = true;
    if (pattern && !pattern.test(String(error?.message ?? error))) {
      throw new Error(`${message ?? "throw"}: unexpected message ${error?.message}`);
    }
  }
  if (!threw) throw new Error(message ?? "expected a throw");
}

async function assertRejects(fn, pattern, message) {
  let threw = false;
  try {
    await fn();
  } catch (error) {
    threw = true;
    if (pattern && !pattern.test(String(error?.message ?? error))) {
      throw new Error(`${message ?? "rejection"}: unexpected message ${error?.message}`);
    }
  }
  if (!threw) throw new Error(message ?? "expected a rejection");
}

/* ============================================================================
 * Fixtures (deterministic, offline, no wall clock, no provider)
 * ==========================================================================*/

const SOL_MINT = BENCHMARK_MARKET.baseMint;
const USDC_MINT = BENCHMARK_MARKET.quoteMint;
const UNSOL_MINT = "BonkFixtureMint1111111111111111111111111111";
const BASE_AT = Date.parse("2026-09-21T12:00:00Z");
const WORKSPACE = await mkdtemp(path.join(tmpdir(), "evolve-ps2-"));
const SESSION_BASE = path.join(WORKSPACE, "sessions");
const DASHBOARD_ROOT = path.join(WORKSPACE, "evolve-root");
const DASHBOARD_BASE = path.join(DASHBOARD_ROOT, "jev-supervisor-observer");
const FAKE_SECRET = "sk-FIXTURE-PS2-SECRET-1234";

function solToken(at, price, { mint = SOL_MINT, symbol = "SOL" } = {}) {
  return {
    mint,
    symbol,
    name: symbol === "SOL" ? "Wrapped SOL" : symbol,
    usdPrice: price,
    liquidity: 25_000_000,
    mcap: 110e9,
    fdv: 110e9,
    organicScore: 92,
    holderCount: 1_200_000,
    topHoldersPercentage: 2.5,
    poolCreatedAt: at - 20 * 3_600_000,
    observedAt: at,
    isVerified: true,
    mintAuthorityDisabled: true,
    freezeAuthorityDisabled: true,
    source: "jupiter",
    endpoint: "/tokens/v2/toporganicscore",
    stats5m: {
      priceChange: 0.6,
      liquidityChange: 0.1,
      volumeChange: 3,
      holderChange: 0.05,
      buyVolume: 2_100_000,
      sellVolume: 1_700_000,
      buyOrganicVolume: 1_600_000,
      sellOrganicVolume: 800_000,
      numBuys: 5400,
      numSells: 4500,
      numTraders: 8600,
      numOrganicBuyers: 950,
      numNetBuyers: 240,
    },
  };
}

function solMarket(at, price, options = {}) {
  return deriveMarket(solToken(at, price, options), {
    at,
    staleMs: 3_600_000,
    momentumReference: MOMENTUM_REFERENCE.synthetic,
  });
}

/** Deterministic lifecycle price path: flat -> crash -> spike (STOP/TAKE/TIME). */
function lifecyclePriceAt(step) {
  if (step <= 25) return 200;
  if (step <= 30) return 100;
  return 260;
}

function createFixtureFeed({ priceAt = lifecyclePriceAt, mint = SOL_MINT, symbol = "SOL" } = {}) {
  let step = 0;
  const feed = {
    effectiveMode: "synthetic",
    synthetic: { regime: "RISK-ON" },
    universe: new Map(),
    markets(at) {
      step += 1;
      const price = priceAt(step);
      const token = solToken(at, price, { mint, symbol });
      feed.universe = new Map([
        [mint, token],
        [USDC_MINT, { mint: USDC_MINT, price: 1, observedAt: at, stats5m: {} }],
      ]);
      return [solMarket(at, price, { mint, symbol })];
    },
    health() {
      return {
        allowNewEntries: true,
        degraded: false,
        source: "synthetic",
        label: "SYNTHETIC MARKET \u2022 PAPER MONEY",
      };
    },
  };
  return feed;
}

async function runFixtureSimulation({
  observer = null,
  seedLabel = "ps2-equivalence",
  populationSize = 24,
  generationTicks = 40,
  ticks = 48,
  priceAt = lifecyclePriceAt,
  yieldsPerTick = 0,
  feed: feedOverride = null,
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
  const now = () => clock;
  const feed = feedOverride ?? createFixtureFeed({ priceAt });
  const simulation = createSimulation({
    config,
    feed,
    now,
    random,
    // A deterministic id factory: agent/event/trade ids depend only on call
    // order, so observer-on and observer-off runs are byte-comparable.
    ids: createIdFactory(),
    evolution: { enabled: true, ...config.evolution },
    proposalObserver: observer ?? null,
  });
  for (let i = 0; i < ticks; i += 1) {
    simulation.advanceTick();
    clock += config.engine.tickMs;
    // The engine never waits for the observer. A caller may still choose to
    // yield the event loop between ticks (exactly as the CLI's tick timer does
    // in production), which lets the observer worker catch up WITHOUT changing
    // a single engine decision.
    for (let y = 0; y < yieldsPerTick; y += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return { config, simulation, snapshot: simulation.snapshot(), now };
}

function engineDigest(run) {
  return digestOf({
    snapshot: run.snapshot,
    genomes: run.simulation.population.map((agent) => digestOf(agent.genome)),
  });
}

function assertEngineIdentical(baseline, candidate, label) {
  assertEqual(
    JSON.stringify(candidate.snapshot),
    JSON.stringify(baseline.snapshot),
    `${label}: the complete EVOLVE snapshot must be byte-identical`,
  );
  assertEqual(engineDigest(candidate), engineDigest(baseline), `${label}: the engine digest must be identical`);
}

/** A deterministic fixture TypeSafe-shaped provider. NEVER touches the network. */
function fixtureProvider({ probability = 0.62, behavior = "ok", onEvaluate = null, reason = null } = {}) {
  const calls = { count: 0, packets: [], payloads: [] };
  const provider = {
    name: SUPERVISOR_REQUIRED_PROVIDER,
    model: SUPERVISOR_REQUIRED_MODEL,
    offline: false,
    external: true,
    gatewayUsed: false,
    async evaluate({ state: packet, questions }) {
      calls.count += 1;
      calls.packets.push(packet);
      calls.payloads.push({ state: packet, questions, model: SUPERVISOR_REQUIRED_MODEL });
      if (typeof onEvaluate === "function") {
        const custom = await onEvaluate(packet, calls);
        if (custom !== undefined) return custom;
      }
      if (behavior === "throw") throw new Error("fixture provider threw");
      if (behavior === "fail") {
        return { ok: false, status: "JEV_UNAVAILABLE", reason: reason ?? "fixture unavailable" };
      }
      if (behavior === "malformed") {
        return {
          ok: true,
          requestId: "req-malformed",
          model: SUPERVISOR_REQUIRED_MODEL,
          answers: { [DIRECTION_QUESTION_NAME]: { type: "noul", noul: "not-a-number" } },
        };
      }
      return {
        ok: true,
        requestId: `req-${calls.count}`,
        model: SUPERVISOR_REQUIRED_MODEL,
        answers: { [DIRECTION_QUESTION_NAME]: { type: "noul", noul: probability } },
        providerMetadata: { fixture: true },
      };
    },
  };
  return { provider, calls };
}

function observerFor({ sessionId, baseRoot = SESSION_BASE, provider, ...rest }) {
  return createSupervisorProposalObserver({
    sessionId,
    sessionRoot: path.join(baseRoot, sessionId),
    baseRoot,
    provider,
    ...rest,
  });
}

/** Tap-level facts exactly as the simulation hands them over. */
function proposalFacts({
  at = BASE_AT,
  action = SUPERVISOR_ACTIONS.ENTER_LONG,
  reason = SUPERVISOR_REASONS.ENTRY_SIGNAL,
  mint = SOL_MINT,
  symbol = "SOL",
  price = 200,
  agentId = "A-PS2-001",
  species = "Momentum",
  position = null,
  paperCashBefore = 100,
  intendedPaperNotional = 20,
} = {}) {
  const market = solMarket(at, price, { mint, symbol });
  const token = solToken(at, price, { mint, symbol });
  const byMint = new Map([
    [mint, market],
    [USDC_MINT, { mint: USDC_MINT, price: 1 }],
  ]);
  return {
    action,
    reason,
    at,
    generation: 2,
    generationTick: 5,
    agentId,
    species,
    lineageId: "L-PS2-1",
    researchFamilyId: null,
    market,
    universeToken: token,
    byMint,
    agentScore: 0.66,
    entryScoreThreshold: 0.45,
    paperCashBefore,
    intendedPaperNotional,
    referencePrice: price,
    liquidityUsd: market.liquidity,
    position,
  };
}

/** Tap-level SOL opportunity facts exactly as the engine hands them over. */
function solOpportunityInput({
  at = BASE_AT,
  generation = 1,
  generationTick = 1,
  agentId = "A-SOL-1",
  species = "Momentum",
  lineageId = "L-SOL-1",
  researchFamilyId = null,
  solScore = 0.8,
  threshold = 0.4,
  price = 200,
  mint = SOL_MINT,
  symbol = "SOL",
} = {}) {
  const market = solMarket(at, price, { mint, symbol });
  const token = solToken(at, price, { mint, symbol });
  const byMint = new Map([
    [mint, market],
    [USDC_MINT, { mint: USDC_MINT, price: 1 }],
  ]);
  return {
    at,
    generation,
    generationTick,
    agentId,
    species,
    lineageId,
    researchFamilyId,
    market,
    universeToken: token,
    byMint,
    solScore,
    agentEntryThreshold: threshold,
  };
}

/**
 * A feed where SOL is PRESENT but STALE (it fails the freshness gate inside
 * `passesGates`, so it is never tradeable and never scored) while another fresh
 * market keeps the engine trading normally.
 */
function createGatedSolFeed() {
  const feed = {
    effectiveMode: "synthetic",
    synthetic: { regime: "RISK-ON" },
    universe: new Map(),
    markets(at) {
      const token = solToken(at, 200);
      feed.universe = new Map([
        [SOL_MINT, token],
        [USDC_MINT, { mint: USDC_MINT, price: 1, observedAt: at, stats5m: {} }],
      ]);
      const staleSol = deriveMarket(
        { ...token, observedAt: at - 30 * 60_000 },
        { at, staleMs: 1_000, momentumReference: MOMENTUM_REFERENCE.synthetic },
      );
      const other = solMarket(at, 6, { mint: UNSOL_MINT, symbol: "OTHER" });
      return [staleSol, other];
    },
    health() {
      return { allowNewEntries: true, degraded: false, source: "synthetic", label: "SYNTHETIC MARKET \u2022 PAPER MONEY" };
    },
  };
  return feed;
}

/**
 * A feed with TWO fresh, tradeable markets: wrapped SOL and another asset. SOL
 * can be actionable for an agent while the OTHER token is the higher-scoring
 * market — exactly the case PS.2a exists to observe.
 */
function createTwoMarketFeed() {
  let step = 0;
  const feed = {
    effectiveMode: "synthetic",
    synthetic: { regime: "RISK-ON" },
    universe: new Map(),
    markets(at) {
      step += 1;
      const solPrice = 200 + (step % 3);
      const token = solToken(at, solPrice);
      feed.universe = new Map([
        [SOL_MINT, token],
        [USDC_MINT, { mint: USDC_MINT, price: 1, observedAt: at, stats5m: {} }],
      ]);
      return [solMarket(at, solPrice), solMarket(at, 6, { mint: UNSOL_MINT, symbol: "OTHER" })];
    },
    health() {
      return { allowNewEntries: true, degraded: false, source: "synthetic", label: "SYNTHETIC MARKET \u2022 PAPER MONEY" };
    },
  };
  return feed;
}

const ENTRY_EXECUTION = {
  executed: true,
  blocked: false,
  fillSide: "BUY",
  referencePrice: 200,
  executedPrice: 200.4,
  notional: 20,
  qty: 0.0998,
  feesUsd: 0.02,
  frictionUsd: 0.05,
  costBps: 25,
};

const EXIT_EXECUTION = {
  executed: true,
  blocked: false,
  fillSide: "SELL",
  referencePrice: 205,
  executedPrice: 204.6,
  notional: 20.4,
  netProceeds: 20.33,
  qty: 0.0998,
  feesUsd: 0.02,
  frictionUsd: 0.05,
  costBps: 25,
};

async function settleObserver(observer, { timeoutMs = 8_000, expected = null, expectedSol = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  let stable = 0;
  while (Date.now() < deadline) {
    const snapshot = observer.snapshot();
    const processed = snapshot.counters.proposalsObserved;
    const solProcessed = snapshot.counters.solOpportunities;
    const done =
      snapshot.queue.depth === 0 &&
      snapshot.pendingDrafts === 0 &&
      snapshot.solQueue.depth === 0 &&
      snapshot.pendingSolDrafts === 0 &&
      (expected === null || processed >= expected) &&
      (expectedSol === null || solProcessed >= expectedSol);
    if (done) {
      stable += 1;
      if (stable >= 3) return snapshot;
    } else {
      stable = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return observer.snapshot();
}

/** Observe one tap-level proposal through a real observer and finalize it. */
async function observeOne({
  sessionId,
  provider,
  facts = proposalFacts(),
  execution = ENTRY_EXECUTION,
  baseRoot = SESSION_BASE,
  observerOptions = {},
} = {}) {
  const observer = observerFor({ sessionId, baseRoot, provider, ...observerOptions });
  observer.start();
  const handle = observer.freezeProposal(facts);
  observer.recordExecution(handle, execution);
  await settleObserver(observer, { expected: 1 });
  await observer.finalize({ status: "COMPLETE" });
  const root = path.join(baseRoot, sessionId);
  return {
    observer,
    root,
    sessionId,
    proposals: await readSupervisorLines(path.join(root, "proposals.ndjson")),
    judgments: await readSupervisorLines(path.join(root, "judgments.ndjson")),
    state: await readSupervisorState(root),
    snapshot: observer.snapshot(),
    summary: observer.summary(),
  };
}

/* ============================================================================
 * Preservation snapshots BEFORE anything runs
 * ==========================================================================*/

const PAPER_SHADOW_SESSION_ID = "jpaper-20260920T154342Z-4734bb";
const PRESERVATION_BEFORE = await snapshotPreservationTargets({ sessionId: PAPER_SHADOW_SESSION_ID });
const SUPERVISOR_SESSIONS_BEFORE = await listSupervisorSessions(SUPERVISOR_ROOT_DIR);
const TREES_BEFORE = {
  supervisor: await snapshotTree(SUPERVISOR_ROOT_DIR),
  paperShadow: await snapshotTree(PAPER_SHADOW_ROOT_DIR),
  forensics: await snapshotTree(PAPER_FORENSICS_ROOT_DIR),
  shadow: await snapshotTree(path.join(".evolve", "shadow")),
  arenas: await snapshotTree(path.join(".evolve", "arenas")),
};

/* ============================================================================
 * Source inventory (used by the structural safety proofs)
 * ==========================================================================*/

const SUPERVISOR_DIR = path.join("scripts", "jev", "supervisor");
const SUPERVISOR_SOURCE_FILES = [
  path.join("scripts", "jev-supervisor.mjs"),
  ...(await readdir(SUPERVISOR_DIR))
    .filter((name) => name.endsWith(".mjs"))
    .sort()
    .map((name) => path.join(SUPERVISOR_DIR, name)),
];
const SUPERVISOR_SOURCES = await Promise.all(
  SUPERVISOR_SOURCE_FILES.map(async (file) => ({ file, text: await readFile(file, "utf8") })),
);
const SOURCE_BY_FILE = Object.fromEntries(SUPERVISOR_SOURCES.map((entry) => [entry.file, entry.text]));
const SIMULATION_SOURCE = await readFile(path.join("scripts", "engine", "simulation.mjs"), "utf8");
const ROUTE_SOURCE = await readFile(path.join("src", "app", "api", "state", "route.ts"), "utf8");
const PAGE_SOURCE = await readFile(path.join("src", "app", "page.tsx"), "utf8");
const PACKAGE_JSON = JSON.parse(await readFile("package.json", "utf8"));

console.log(`\n${SUPERVISOR_LABEL} (Phase ${SUPERVISOR_PHASE}) \u2014 ${SUPERVISOR_NO_AUTHORITY_TAG}\n`);

/* ============================================================================
 * 1. Frozen definition, classification and agreement semantics
 * ==========================================================================*/

await test("frozen definition: identity, classification, non-authority flags", () => {
  assertEqual(SUPERVISOR_PHASE, "5I-PS.2");
  assertEqual(SUPERVISOR_KIND, "JEV_SUPERVISOR_OBSERVER");
  assertEqual(SUPERVISOR_PURPOSE, "JEV_SUPERVISOR_OBSERVER");
  assertEqual(SUPERVISOR_LABEL, "JEV SUPERVISOR OBSERVER");
  assertEqual(SUPERVISOR_NO_AUTHORITY_TAG, "NO AUTHORITY \u2022 PAPER ONLY");
  assertIncludes(SUPERVISOR_STATEMENT, "Jev observes completed EVOLVE paper decisions.");
  assertIncludes(SUPERVISOR_STATEMENT, "It cannot approve, reject, resize, delay, or alter trades.");
  assertIncludes(SUPERVISOR_STATEMENT, "Development evidence only.");
  assertEqual(SUPERVISOR_CLASSIFICATION.developmentOnly, true);
  assertEqual(SUPERVISOR_CLASSIFICATION.observerOnly, true);
  assertEqual(SUPERVISOR_CLASSIFICATION.paperOnly, true);
  for (const key of [
    "jevHasTradingAuthority",
    "jevHasEvolutionAuthority",
    "jevHasSelectionAuthority",
    "jevHasArenaAuthority",
    "jevHasDeploymentAuthority",
    "canonicalEvidence",
    "replicationEvidence",
    "temporalReplicationEvidence",
    "profitabilityInferencePermitted",
    "parameterSelectionPermitted",
  ]) {
    assertEqual(SUPERVISOR_CLASSIFICATION[key], false, `${key} must be false`);
  }
});

await test("frozen provider pins: direct TypeSafe only, no gateway, no cache", () => {
  assertEqual(SUPERVISOR_REQUIRED_PROVIDER, "typesafe-jev");
  assertEqual(SUPERVISOR_REQUIRED_MODEL, "jev-1.13.0");
  assertEqual(SUPERVISOR_REQUIRED_UPSTREAM_PROVIDER, "typesafe-ai");
  assertEqual(SUPERVISOR_REQUIRED_GATEWAY_USED, false);
  assertEqual(SUPERVISOR_MODE, "shadow");
  assertEqual(SUPERVISOR_CACHE_ENABLED, false);
  assertDeepEqual([...SUPERVISOR_FORBIDDEN_PROVIDERS], ["mock-jev", "vercel-jev"]);
});

await test("market scope: SOL-USDC only, using the existing identity", () => {
  assertEqual(SUPERVISOR_MARKET_ID, "SOL-USDC");
  assertDeepEqual([...SUPERVISOR_SUPPORTED_MARKET_IDS], ["SOL-USDC"]);
  assertDeepEqual([...SUPERVISOR_SUPPORTED_MINTS], [SOL_MINT]);
  assertEqual(SUPERVISOR_QUOTE_MINT, USDC_MINT);
  assertEqual(isSupportedMint(SOL_MINT), true);
  assertEqual(isSupportedMint(USDC_MINT), false, "USDC is provenance/quote only, never a supported trading market");
  assertEqual(isSupportedMint(UNSOL_MINT), false);
  assertEqual(isSupportedMint(null), false);
});

await test("classification: ENTER_LONG+ENTRY_SIGNAL is comparable HIGHER", () => {
  const classification = classifyProposal({ action: "ENTER_LONG", reason: "ENTRY_SIGNAL" });
  assertEqual(classification.directionalComparable, true);
  assertEqual(classification.evolveDirectionalIntent, "HIGHER");
  assertEqual(classification.reason, "ENTRY_SIGNAL");
});

await test("classification: EXIT_LONG+SIGNAL is comparable LOWER", () => {
  const classification = classifyProposal({ action: "EXIT_LONG", reason: "SIGNAL" });
  assertEqual(classification.directionalComparable, true);
  assertEqual(classification.evolveDirectionalIntent, "LOWER");
  assertEqual(classification.reason, "SIGNAL");
});

await test("classification: STOP/TAKE/TIME (+ engine settlements) are NOT directional", () => {
  for (const reason of ["STOP", "TAKE", "TIME", "GEN-END", "STAGE-END"]) {
    assert(SUPERVISOR_LIFECYCLE_EXIT_REASONS.includes(reason), `${reason} must be a frozen lifecycle reason`);
    const classification = classifyProposal({ action: "EXIT_LONG", reason });
    assertEqual(classification.directionalComparable, false, `${reason} must not be directionally comparable`);
    assertEqual(classification.evolveDirectionalIntent, null, `${reason} must carry no EVOLVE directional intent`);
    const agreement = agreementFor({
      directionalComparable: classification.directionalComparable,
      evolveDirectionalIntent: classification.evolveDirectionalIntent,
      modelIntent: "HIGHER",
    });
    assertEqual(agreement.agreement, SUPERVISOR_AGREEMENT.NOT_DIRECTIONALLY_COMPARABLE);
  }
});

await test("agreement semantics: the four comparable combinations", () => {
  const cases = [
    ["HIGHER", "HIGHER", SUPERVISOR_AGREEMENT.AGREE],
    ["HIGHER", "LOWER", SUPERVISOR_AGREEMENT.DISAGREE],
    ["LOWER", "LOWER", SUPERVISOR_AGREEMENT.AGREE],
    ["LOWER", "HIGHER", SUPERVISOR_AGREEMENT.DISAGREE],
  ];
  for (const [evolveIntent, jevIntent, expected] of cases) {
    const { agreement } = agreementFor({
      directionalComparable: true,
      evolveDirectionalIntent: evolveIntent,
      modelIntent: jevIntent,
    });
    assertEqual(agreement, expected, `EVOLVE ${evolveIntent} + Jev ${jevIntent}`);
  }
});

await test("agreement semantics: no Jev intent is a failure record, never agree/disagree", () => {
  const result = agreementFor({
    directionalComparable: true,
    evolveDirectionalIntent: "HIGHER",
    modelIntent: null,
  });
  assertEqual(result.agreement, null);
  assertEqual(result.agreementReason, SUPERVISOR_AGREEMENT_NO_INTENT_REASON);
});

await test("model intent and exact-half metadata reuse the frozen rule (no threshold)", () => {
  assertEqual(modelIntentFromProbability(0.62), SUPERVISOR_DIRECTIONAL_INTENTS.HIGHER);
  assertEqual(modelIntentFromProbability(0.4999), SUPERVISOR_DIRECTIONAL_INTENTS.LOWER);
  assertEqual(modelIntentFromProbability(SUPERVISOR_EXACT_HALF), SUPERVISOR_DIRECTIONAL_INTENTS.HIGHER);
  assertEqual(modelIntentFromProbability(Number.NaN), null);
  assertEqual(exactlyHalfOf(SUPERVISOR_EXACT_HALF), true);
  assertEqual(exactlyHalfOf(0.5000000001), false, "exact comparison only, no tolerance");
  assertClose(distanceFromHalfOf(0.62), 0.12, 1e-12);
  assertClose(distanceFromHalfOf(0.38), 0.12, 1e-12);
  assertEqual(distanceFromHalfOf(null), null);
  assertEqual(SUPERVISOR_TAP_DEFINITION.distanceFromHalfIsAThreshold, false);
  assertEqual(SUPERVISOR_TAP_DEFINITION.confidenceThresholdApplied, false);
  assertEqual(SUPERVISOR_TAP_DEFINITION.evolvesDesiredActionSentToJev, false);
  assertEqual(SUPERVISOR_TAP_DEFINITION.classificationFrozenBeforeResults, true);
  assertExcludes(SUPERVISOR_TAP_DEFINITION.agreementRule, "confidence");
});

await test("proposal facts are deeply frozen and execution defaults fail closed", () => {
  const facts = deepFreeze({ a: { b: 1 } });
  assertEqual(Object.isFrozen(facts), true);
  assertEqual(Object.isFrozen(facts.a), true);
  assertThrows(() => {
    facts.a.b = 2;
  }, null, "mutating a frozen proposal must throw in strict mode");
  const missing = freezeExecution(null);
  assertEqual(missing.executed, false);
  assertEqual(missing.blocked, false);
  assertEqual(missing.blockedReason, "execution_result_missing");
  const filled = freezeExecution(ENTRY_EXECUTION);
  assertEqual(filled.executed, true);
  assertEqual(filled.fillSide, "BUY");
  assertEqual(filled.notional, 20);
  assertEqual(Object.isFrozen(filled), true);
});

await test("no confidence threshold / uncertainty zone anywhere in the subsystem", () => {
  for (const { file, text } of SUPERVISOR_SOURCES) {
    const hits = text.match(/minConfidence|confidenceThreshold(?!Applied)|uncertaintyZone|distanceThreshold/gi) ?? [];
    if (file.endsWith("definition.mjs")) {
      assert(hits.length <= 3, "the frozen forbidden-name list is the only permitted mention");
    } else {
      assertEqual(hits.length, 0, `${file} must not introduce a confidence threshold`);
    }
    assert(/distanceFromHalf/.test(text) ? !/distanceFromHalf\s*[<>]=?/.test(text) : true, `${file}: distanceFromHalf is never a cutoff`);
  }
});

/* ============================================================================
 * 2. Isolation: storage roots, session identity, write guards
 * ==========================================================================*/

await test("forbidden write roots cover every protected tree", () => {
  const required = [
    path.join(".evolve", "jev-direction"),
    path.join(".evolve", "jev-direction", "replication"),
    path.join(".evolve", "jev-direction", "temporal"),
    path.join(".evolve", "jev-paper-shadow"),
    path.join(".evolve", "jev-paper-forensics"),
    path.join(".evolve", "shadow"),
    path.join(".evolve", "arenas"),
  ];
  for (const root of required) {
    assert(SUPERVISOR_FORBIDDEN_WRITE_ROOTS.includes(root), `${root} must be a forbidden write root`);
    assertThrows(() => assertSupervisorWriteTarget(path.join(root, "ps2-intruder")), /protected tree/, root);
  }
  assertEqual(assertSupervisorWriteTarget(path.join(SUPERVISOR_ROOT_DIR, "jsup-test")), true);
  assertThrows(
    () => assertSupervisorWriteTarget(path.join(SESSION_BASE, "jsup-test"), path.join(SESSION_BASE, "other")),
    /outside the supervisor base tree/,
  );
});

await test("session identity: jsup-<UTC timestamp>-<short digest>, no path escape", () => {
  const sessionId = supervisorSessionIdFor({ startedAt: BASE_AT, salt: "validate" });
  assert(/^jsup-\d{8}T\d{6}Z-[a-f0-9]{6}$/.test(sessionId), `unexpected session id ${sessionId}`);
  assertEqual(isValidSupervisorSessionId(sessionId), true);
  assertEqual(isValidSupervisorSessionId("../evil"), false);
  assertEqual(isValidSupervisorSessionId("jpaper-20260920T154342Z-4734bb"), false);
  assertThrows(() => supervisorSessionRootFor(SESSION_BASE, "../evil"), /invalid Jev supervisor session id/);
  assertThrows(() => supervisorSessionRootFor(SESSION_BASE, ""), /invalid Jev supervisor session id/);
  const root = supervisorSessionRootFor(SESSION_BASE, sessionId);
  assertEqual(root.startsWith(SESSION_BASE), true);
});

await test("queue capacity is a frozen positive source literal, never performance-derived", () => {
  assert(Number.isInteger(SUPERVISOR_QUEUE_CAPACITY) && SUPERVISOR_QUEUE_CAPACITY > 0);
  assertIncludes(SOURCE_BY_FILE[path.join(SUPERVISOR_DIR, "definition.mjs")], `SUPERVISOR_QUEUE_CAPACITY = ${SUPERVISOR_QUEUE_CAPACITY};`);
  assert(SUPERVISOR_MAX_JEV_CALLS > 0, "an absolute per-session Jev call ceiling must exist");
  assertEqual(typeof SUPERVISOR_WRITE_FILES, "object");
});

/* ============================================================================
 * 3. Bounded queue
 * ==========================================================================*/

await test("bounded queue: synchronous push/shift, explicit drop at capacity", () => {
  const dropped = [];
  const queue = createBoundedObserverQueue({ capacity: 3, onDrop: (item, depth) => dropped.push({ item, depth }) });
  assertEqual(queue.capacity, 3);
  assertEqual(queue.push({ id: 1 }), true);
  assertEqual(queue.push({ id: 2 }), true);
  assertEqual(queue.push({ id: 3 }), true);
  assertEqual(queue.highWatermark, 3);
  assertEqual(queue.push({ id: 4 }), false, "an overflow push must report the drop explicitly");
  assertEqual(queue.dropped, 1);
  assertEqual(dropped.length, 1);
  assertDeepEqual(queue.shift(), { id: 1 }, "shift must be synchronous");
  assertEqual(queue.depth, 2);
  assertEqual(queue.push({ id: 5 }), true, "draining frees capacity");
  const drained = queue.drain();
  assertEqual(drained.length, 3);
  assertEqual(queue.depth, 0);
  assertEqual(typeof queue.push({ id: 6 }), "boolean", "push never returns a promise");
});

await test("bounded queue: a throwing onDrop callback can never reach the engine", () => {
  const queue = createBoundedObserverQueue({
    capacity: 1,
    onDrop: () => {
      throw new Error("observer-only bookkeeping failure");
    },
  });
  queue.push("a");
  assertEqual(queue.push("b"), false);
  assertEqual(queue.dropped, 1);
});

console.log(`\n  \u2026 running observer, equivalence, dashboard and preservation proofs \u2026\n`);

/* ============================================================================
 * 4. Observer behaviour on the one supported market, and the unsupported path
 * ==========================================================================*/

async function observeMany({
  sessionId,
  baseRoot = SESSION_BASE,
  provider,
  items,
  observerOptions = {},
  status = "COMPLETE",
}) {
  const observer = observerFor({ sessionId, baseRoot, provider, ...observerOptions });
  observer.start();
  for (const item of items) {
    const handle = observer.freezeProposal(item.facts);
    observer.recordExecution(handle, item.execution ?? ENTRY_EXECUTION);
  }
  await settleObserver(observer, { expected: items.length });
  await observer.finalize({ status });
  const root = path.join(baseRoot, sessionId);
  return {
    observer,
    root,
    sessionId,
    proposals: await readSupervisorLines(path.join(root, "proposals.ndjson")),
    judgments: await readSupervisorLines(path.join(root, "judgments.ndjson")),
    state: await readSupervisorState(root),
    summary: await readSupervisorSummary(root),
    session: await readSupervisorSession(root),
    snapshot: observer.snapshot(),
  };
}

await test("entry capture: every frozen proposal field, execution attached after", async () => {
  const { provider, calls } = fixtureProvider({ probability: 0.62 });
  const result = await observeOne({ sessionId: "jsup-fixture-entry", provider });
  assertEqual(result.proposals.records.length, 1);
  const record = result.proposals.records[0];
  assertEqual(record.recordType, "PROPOSAL");
  assertEqual(record.purpose, "JEV_SUPERVISOR_OBSERVER");
  assertEqual(record.observerOnly, true);
  assertEqual(record.paperOnly, true);
  assertEqual(record.canonicalEvidence, false);
  assertEqual(record.supported, true);
  assertEqual(record.jevEvaluation, "EVALUATED");
  const proposal = record.proposal;
  assertEqual(typeof proposal.proposalId, "string");
  assertEqual(proposal.action, "ENTER_LONG");
  assertEqual(proposal.reason, "ENTRY_SIGNAL");
  assertEqual(proposal.directionalComparable, true);
  assertEqual(proposal.evolveDirectionalIntent, "HIGHER");
  assertEqual(proposal.generation, 2);
  assertEqual(proposal.generationTick, 5);
  assertEqual(proposal.agentId, "A-PS2-001");
  assertEqual(proposal.species, "Momentum");
  assertEqual(proposal.lineageId, "L-PS2-1");
  assertEqual(proposal.market.mint, SOL_MINT);
  assertEqual(proposal.market.symbol, "SOL");
  assertEqual(proposal.market.referencePrice, 200);
  assertEqual(proposal.market.liquidity, 25_000_000);
  assertEqual(proposal.agentScore, 0.66);
  assertEqual(proposal.entryScoreThreshold, 0.45);
  assertEqual(proposal.paperCashBefore, 100);
  assertEqual(proposal.intendedPaperNotional, 20);
  assertEqual(typeof proposal.proposalFrozenAt, "string");
  assertEqual(typeof proposal.timestamp, "string");
  const execution = record.evolveExecution;
  assertEqual(execution.executed, true);
  assertEqual(execution.blocked, false);
  assertEqual(execution.fillSide, "BUY");
  assertEqual(execution.referencePrice, 200);
  assertEqual(execution.executedPrice, 200.4);
  assertEqual(execution.notional, 20);
  assertEqual(execution.qty, 0.0998);
  assertEqual(execution.feesUsd, 0.02);
  assertEqual(execution.frictionUsd, 0.05);
  assertEqual(execution.costBps, 25);
  assertEqual(record.executionCompletedBeforeObserverStart, true);
  assertEqual(calls.count, 1);
});

await test("Jev is asked about MARKET STATE only: the proposal never leaks into the packet", async () => {
  const { provider, calls } = fixtureProvider({ probability: 0.62 });
  await observeOne({ sessionId: "jsup-fixture-noleak", provider });
  assertEqual(calls.packets.length, 1);
  const packet = calls.packets[0];
  assertEqual(packet.market.marketId, "SOL-USDC");
  assertEqual(packet.market.baseMint, SOL_MINT);
  assertEqual(packet.market.quoteMint, USDC_MINT);
  const serialized = JSON.stringify(packet);
  for (const leaked of ["ENTER_LONG", "ENTRY_SIGNAL", "EXIT_LONG", "evolveDirectionalIntent", "proposalId", "AGREE", "DISAGREE"]) {
    assertExcludes(serialized, leaked, `the packet must not carry '${leaked}'`);
  }
  assert(packet.features && typeof packet.features === "object", "the packet must carry the frozen feature vector");
  assertEqual(typeof packet.preOutcomeInputDigest, "string");
});

await test("judgment: full provenance, agreement AGREE, EVOLVE execution first", async () => {
  const { provider } = fixtureProvider({ probability: 0.62 });
  const result = await observeOne({ sessionId: "jsup-fixture-judgment", provider });
  assertEqual(result.judgments.records.length, 1);
  const judgment = result.judgments.records[0];
  assertEqual(judgment.recordType, "JUDGMENT");
  assertEqual(judgment.proposalId, result.proposals.records[0].proposal.proposalId);
  assertEqual(judgment.agreement, "AGREE");
  assertEqual(judgment.modelIntent, "HIGHER");
  assertEqual(judgment.pHigher, 0.62);
  assertClose(judgment.pLower, 0.38, 1e-12);
  assertEqual(judgment.exactlyHalf, false);
  assertClose(judgment.distanceFromHalf, 0.12, 1e-12);
  assertEqual(judgment.provider, "typesafe-jev");
  assertEqual(judgment.model, "jev-1.13.0");
  assertEqual(judgment.upstream, "typesafe-ai");
  assertEqual(judgment.gatewayUsed, false);
  assertEqual(judgment.cacheEnabled, false);
  assertEqual(judgment.providerStatus, "JEV_OK");
  assertEqual(typeof judgment.requestId, "string");
  assert(Number.isFinite(judgment.latencyMs), "latency must be recorded");
  assertEqual(typeof judgment.stateDigest, "string");
  assertEqual(typeof judgment.packetDigest, "string");
  assertEqual(typeof judgment.questionSetId, "string");
  assert(Number.isFinite(judgment.questionSetVersion));
  assertEqual(typeof judgment.questionDigest, "string");
  assert(Number.isFinite(judgment.featureDefinitionVersion));
  assertEqual(typeof judgment.featureDefinitionDigest, "string");
  assertEqual(judgment.confidenceThresholdApplied, false);
  assertEqual(judgment.evolveExecutionPrecededObservation, true);
  assertEqual(judgment.executionCompletedBeforeObserverStart, true);
  assertEqual(judgment.evolveExecution.executed, true);
  assertEqual(judgment.observerOnly, true);
  assertEqual(judgment.jevHasTradingAuthority, false);
  assertEqual(judgment.profitabilityInferencePermitted, false);
  assertIncludes(judgment.note, "Agreement/disagreement record only");
});

await test("agreement: a LOWER Jev intent on an entry is a DISAGREE", async () => {
  const { provider } = fixtureProvider({ probability: 0.35 });
  const result = await observeOne({ sessionId: "jsup-fixture-disagree", provider });
  const judgment = result.judgments.records[0];
  assertEqual(judgment.modelIntent, "LOWER");
  assertEqual(judgment.agreement, "DISAGREE");
  assertEqual(result.summary.disagreementCount, 1);
  assertEqual(result.summary.agreementCount, 0);
});

await test("exact 0.50: existing model intent retained, exactlyHalf marked, no uncertainty zone", async () => {
  const { provider } = fixtureProvider({ probability: 0.5 });
  const result = await observeOne({ sessionId: "jsup-fixture-exacthalf", provider });
  const judgment = result.judgments.records[0];
  assertEqual(judgment.pHigher, 0.5);
  assertEqual(judgment.exactlyHalf, true);
  assertEqual(judgment.distanceFromHalf, 0);
  assertEqual(judgment.modelIntent, "HIGHER");
  assertEqual(judgment.agreement, "AGREE");
  assertEqual(judgment.confidenceThresholdApplied, false);
  assertEqual(result.summary.exactHalfCount, 1);
  assertEqual(result.state.counters.exactHalfCount, 1);
  assertEqual(result.snapshot.counters.exactHalfCount, 1);
});

await test("SIGNAL exit capture: comparable LOWER, agree/disagree by Jev intent", async () => {
  const facts = proposalFacts({
    action: "EXIT_LONG",
    reason: "SIGNAL",
    position: { mint: SOL_MINT, symbol: "SOL", qty: 0.1, cost: 20, entryRefPrice: 198, entryPrice: 198.2, entryLiquidity: 2e7, heldTicks: 3, entryAt: BASE_AT, entryScore: 0.6 },
  });
  const agree = await observeOne({ sessionId: "jsup-fixture-signal-agree", provider: fixtureProvider({ probability: 0.3 }).provider, facts, execution: EXIT_EXECUTION });
  assertEqual(agree.judgments.records[0].agreement, "AGREE");
  assertEqual(agree.proposals.records[0].proposal.evolveDirectionalIntent, "LOWER");
  assertEqual(agree.proposals.records[0].evolveExecution.fillSide, "SELL");
  assertEqual(agree.summary.signalExitComparableCount, 1);
  assertEqual(agree.summary.entryComparableCount, 0);
  const disagree = await observeOne({ sessionId: "jsup-fixture-signal-disagree", provider: fixtureProvider({ probability: 0.7 }).provider, facts, execution: EXIT_EXECUTION });
  assertEqual(disagree.judgments.records[0].agreement, "DISAGREE");
});

await test("STOP/TAKE/TIME capture: lifecycle exits are NOT directionally comparable", async () => {
  const items = ["STOP", "TAKE", "TIME"].map((reason, index) => ({
    facts: proposalFacts({
      at: BASE_AT + index * 1_000,
      action: "EXIT_LONG",
      reason,
      agentId: `A-PS2-EXIT-${reason}`,
      position: { mint: SOL_MINT, symbol: "SOL", qty: 0.1, cost: 20, entryRefPrice: 200, entryPrice: 200, entryLiquidity: 2e7, heldTicks: 5, entryAt: BASE_AT, entryScore: 0.6 },
    }),
    execution: EXIT_EXECUTION,
  }));
  const result = await observeMany({ sessionId: "jsup-fixture-lifecycle", provider: fixtureProvider({ probability: 0.9 }).provider, items });
  assertEqual(result.proposals.records.length, 3);
  for (const record of result.proposals.records) {
    assertEqual(record.proposal.directionalComparable, false);
    assertEqual(record.proposal.evolveDirectionalIntent, null);
  }
  assertEqual(result.judgments.records.length, 3);
  for (const judgment of result.judgments.records) {
    assertEqual(judgment.agreement, "NOT_DIRECTIONALLY_COMPARABLE");
    assertEqual(judgment.agreementReason, null);
  }
  assertEqual(result.summary.stopObservations, 1);
  assertEqual(result.summary.takeObservations, 1);
  assertEqual(result.summary.timeObservations, 1);
  assertEqual(result.summary.directionallyComparable, 0);
  assertEqual(result.summary.notDirectionallyComparable, 3);
  assertEqual(result.summary.agreementCount, 0);
  assertEqual(result.summary.disagreementCount, 0);
  assertEqual(result.summary.jevCalls, 3, "a lifecycle exit is still observed, just never agree/disagree");
});

await test("unsupported market: counted + sampled, NO proposal record, NO Jev call, no queue use", async () => {
  const { provider, calls } = fixtureProvider();
  const facts = proposalFacts({ mint: UNSOL_MINT, symbol: "BONK", agentId: "A-PS2-BONK" });
  const result = await observeOne({ sessionId: "jsup-fixture-unsupported", provider, facts });
  assertEqual(result.proposals.records.length, 0, "an unsupported proposal is never written as a full proposal record");
  assertEqual(result.judgments.records.length, 0, "no judgment may exist for an unsupported market");
  assertEqual(calls.count, 0, "another asset is NEVER reinterpreted through the SOL question set");
  const snapshot = result.snapshot;
  assertEqual(snapshot.counters.executedTradeProposals, 1);
  assertEqual(snapshot.counters.unsupportedProposals, 1);
  assertEqual(snapshot.counters.unsupportedProposalCount, 1);
  assertEqual(snapshot.counters.unsupportedRecentSampleCount, 1);
  assertEqual(snapshot.counters.supportedProposals, 0);
  assertEqual(snapshot.counters.proposalsObserved, 0, "an unsupported proposal never enters the Jev work queue");
  assertEqual(snapshot.counters.jevCalls, 0);
  assertEqual(snapshot.queue.depth, 0);
  assertEqual(snapshot.queue.dropped, 0, "unsupported traffic can never cause a queue drop");
  assertEqual(snapshot.counters.jevOk + snapshot.counters.jevFailures, 0);
  const sample = snapshot.unsupportedRecentSample;
  assertEqual(sample.length, 1);
  assertEqual(sample[0].mint, UNSOL_MINT);
  assertEqual(sample[0].marketId, null, "an arbitrary asset identity is never SOL-USDC");
  assertEqual(sample[0].supported, false);
  assertEqual(sample[0].unsupportedReason, SUPERVISOR_UNSUPPORTED_MARKET_REASON);
  assertEqual(result.summary.unsupportedProposals, 1);
  assertEqual(result.summary.unsupportedRecentSampleCount, 1);
  assertEqual(result.summary.supportedProposals, 0);
  assertEqual(result.summary.jevCalls, 0);
});

await test("real synthetic universe: every proposal unsupported, engine trades normally, zero Jev calls", async () => {
  const { provider, calls } = fixtureProvider();
  const observer = observerFor({ sessionId: "jsup-fixture-synthetic-universe", provider });
  observer.start();
  const config = createMarketConfig(
    {
      EVOLVE_MARKET_MODE: "synthetic",
      EVOLVE_POPULATION_SIZE: "24",
      EVOLVE_GENERATION_TICKS: "15",
      EVOLVE_SYNTHETIC_UNIVERSE: "16",
    },
    { loadEnv: false },
  );
  const random = createSeededRandom("ps2-synthetic-universe");
  let clock = BASE_AT;
  const now = () => clock;
  const feed = createMarketFeed({
    config,
    fetchImpl: async () => {
      throw new Error("offline fixture only");
    },
    now,
    random,
  });
  const simulation = createSimulation({
    config,
    feed,
    now,
    random,
    ids: createIdFactory(),
    evolution: { enabled: true, ...config.evolution },
    proposalObserver: observer,
  });
  for (let i = 0; i < 60; i += 1) {
    await feed.advance(clock);
    simulation.advanceTick();
    clock += config.engine.tickMs;
  }
  const snapshot = simulation.snapshot();
  await settleObserver(observer);
  await observer.finalize({ status: "COMPLETE" });
  const observed = observer.snapshot();
  assert(observed.counters.executedTradeProposals > 0, "the passive tap must observe the engine's own proposals");
  assertEqual(observed.counters.supportedProposals, 0);
  assert(observed.counters.unsupportedProposals > 0);
  assertEqual(observed.counters.unsupportedProposals, observed.counters.executedTradeProposals);
  assertEqual(observed.counters.proposalsObserved, 0, "unsupported work never enters the Jev queue");
  assertEqual(observed.queue.depth, 0);
  assertEqual(observed.queue.dropped, 0, "unsupported traffic must never cause a queue drop");
  assertEqual(observed.counters.jevCalls, 0);
  assertEqual(calls.count, 0);
  assertEqual(observed.counters.solOpportunities, 0, "no SOL market exists in the synthetic universe");
  assertEqual(observed.counters.agreementCount + observed.counters.disagreementCount, 0);
  assert(snapshot.recentTrades.length > 0, "the paper engine must keep trading normally");
  const proposals = await readSupervisorLines(path.join(SESSION_BASE, "jsup-fixture-synthetic-universe", "proposals.ndjson"));
  const judgments = await readSupervisorLines(path.join(SESSION_BASE, "jsup-fixture-synthetic-universe", "judgments.ndjson"));
  assertEqual(proposals.records.length, 0, "no full market-state record is written for an unsupported proposal");
  assertEqual(judgments.records.length, 0);
  const sample = observed.unsupportedRecentSample;
  assert(sample.length > 0);
  assertEqual(sample.length <= SUPERVISOR_MAX_UNSUPPORTED_SAMPLE, true, "the unsupported sample stays bounded");
  for (const entry of sample) {
    assertEqual(entry.marketId, null, "an arbitrary asset is never serialized as SOL-USDC");
    assertEqual(entry.supported, false);
  }
});

await test("provider pins: a forbidden provider produces a failure record and NO call", async () => {
  const { provider, calls } = fixtureProvider({ behavior: "ok" });
  const wrongProvider = { ...provider, name: "mock-jev", model: "mock-jev-v1" };
  const result = await observeOne({ sessionId: "jsup-fixture-pinmismatch", provider: wrongProvider });
  assertEqual(calls.count, 0, "no fallback provider may ever be called");
  const record = result.proposals.records[0];
  assertEqual(record.jevEvaluation, "EVALUATED");
  assertEqual(record.providerStatus, "JEV_PIN_MISMATCH");
  assertIncludes(record.failureReason, "refused");
  assertEqual(record.pHigher, null);
  assertEqual(record.agreement, null, "a pin mismatch is never agreement or disagreement");
  const judgment = result.judgments.records[0];
  assertEqual(judgment.agreement, null);
  assertEqual(judgment.agreementReason, SUPERVISOR_AGREEMENT_NO_INTENT_REASON);
  assertEqual(judgment.pHigher, null);
  assertEqual(judgment.providerStatus, "JEV_PIN_MISMATCH");
  assertEqual(result.summary.jevCalls, 0);
  assertEqual(result.summary.jevFailures, 1);
  assertEqual(result.summary.observerFailures, 0, "a pin mismatch is a Jev failure, not an observer crash");
});

await test("provider failure: failure record, no intent, no agreement, execution untouched", async () => {
  const { provider } = fixtureProvider({ behavior: "fail" });
  const result = await observeOne({ sessionId: "jsup-fixture-providerfail", provider });
  const judgment = result.judgments.records[0];
  assertEqual(judgment.providerStatus, "JEV_UNAVAILABLE");
  assertEqual(judgment.pHigher, null);
  assertEqual(judgment.modelIntent, null);
  assertEqual(judgment.agreement, null);
  assert(result.summary.jevFailures >= 1);
  assertEqual(judgment.evolveExecution.executed, true, "the paper execution is recorded as it happened");
});

await test("malformed Jev answer: INVALID_RESPONSE, no intent, never agreement", async () => {
  const { provider } = fixtureProvider({ behavior: "malformed" });
  const result = await observeOne({ sessionId: "jsup-fixture-malformed", provider });
  const judgment = result.judgments.records[0];
  assertEqual(judgment.providerStatus, "JEV_INVALID_RESPONSE");
  assertEqual(judgment.pHigher, null);
  assertEqual(judgment.agreement, null);
  assertEqual(judgment.agreementReason, SUPERVISOR_AGREEMENT_NO_INTENT_REASON);
  assertEqual(result.summary.agreementCount + result.summary.disagreementCount, 0);
});

await test("observer failure: a throwing provider is a contained Jev failure record", async () => {
  const { provider } = fixtureProvider({ behavior: "throw" });
  const result = await observeOne({ sessionId: "jsup-fixture-throwingprovider", provider });
  const judgment = result.judgments.records[0];
  assertEqual(judgment.providerStatus, "JEV_UNAVAILABLE", "jevDecide contains the throw as a provider failure");
  assertIncludes(judgment.failureReason, "provider threw");
  assert(result.summary.jevFailures >= 1);
  assertEqual(judgment.agreement, null);
  assertEqual(judgment.evolveExecution.executed, true);
});

await test("provider failure reasons are redacted before they are persisted", async () => {
  const { provider } = fixtureProvider({ behavior: "fail", reason: `api_key=${FAKE_SECRET} rejected` });
  const result = await observeOne({ sessionId: "jsup-fixture-redaction", provider });
  const persisted = JSON.stringify(result.proposals.records) + JSON.stringify(result.judgments.records);
  assertExcludes(persisted, FAKE_SECRET, "a credential-shaped diagnostic must be redacted");
  assertIncludes(persisted, "[redacted]");
});

await test("proposal immutability: digest recomputes, no rewrite, no temp leftovers", async () => {
  const { provider } = fixtureProvider({ probability: 0.62 });
  const result = await observeOne({ sessionId: "jsup-fixture-immutable", provider });
  const record = result.proposals.records[0];
  assertEqual(record.proposalDigest, proposalDigestOf(record.proposal), "the frozen proposal digest must recompute");
  const built = buildProposalFacts(
    {
      action: "ENTER_LONG",
      reason: "ENTRY_SIGNAL",
      at: BASE_AT,
      agentId: "A-FROZEN",
      market: solMarket(BASE_AT, 200),
      byMint: new Map([[SOL_MINT, solMarket(BASE_AT, 200)]]),
    },
    { proposalId: "jsup-frozen-p000001", sessionId: "jsup-frozen" },
  );
  assertEqual(Object.isFrozen(built), true, "built proposal facts are frozen");
  assertEqual(Object.isFrozen(built.marketState), true, "the frozen market state is frozen");
  assertThrows(() => {
    built.action = "EXIT_LONG";
  }, null, "a frozen proposal cannot be mutated");
  const firstRead = await readFile(path.join(result.root, "proposals.ndjson"), "utf8");
  const secondRead = await readFile(path.join(result.root, "proposals.ndjson"), "utf8");
  assertEqual(secondRead, firstRead, "append-only: a proposal is never rewritten in place");
  const entries = await readdir(result.root);
  assertEqual(entries.includes("session.json"), true);
  assertEqual(entries.includes("proposals.ndjson"), true);
  assertEqual(entries.includes("judgments.ndjson"), true);
  assertEqual(entries.includes("state.json"), true);
  assertEqual(entries.includes("summary.json"), true);
  assertEqual(entries.filter((name) => name.includes(".tmp")).length, 0, "no temp files may survive");
  assertEqual(result.proposals.malformed, 0);
  assertEqual(result.judgments.malformed, 0);
});

await test("judgment linkage: one judgment per evaluated proposal, unique sequences", async () => {
  const { provider } = fixtureProvider({ probability: 0.55 });
  const items = [
    { facts: proposalFacts({ at: BASE_AT, agentId: "A-LINK-1" }) },
    { facts: proposalFacts({ at: BASE_AT + 1_000, agentId: "A-LINK-2", action: "EXIT_LONG", reason: "STOP", position: { mint: SOL_MINT, symbol: "SOL", qty: 0.1, cost: 20, entryRefPrice: 200, entryPrice: 200, entryLiquidity: 2e7, heldTicks: 4, entryAt: BASE_AT, entryScore: 0.6 } }), execution: EXIT_EXECUTION },
    { facts: proposalFacts({ at: BASE_AT + 2_000, agentId: "A-LINK-3", mint: UNSOL_MINT, symbol: "BONK" }) },
  ];
  const result = await observeMany({ sessionId: "jsup-fixture-linkage", provider, items });
  const proposalIds = result.proposals.records.map((record) => record.proposal.proposalId);
  assertEqual(new Set(proposalIds).size, proposalIds.length, "proposal ids must be unique");
  assertEqual(result.judgments.records.length, 2, "only EVALUATED proposals get a judgment");
  for (const judgment of result.judgments.records) {
    assert(proposalIds.includes(judgment.proposalId), "every judgment must reference exactly one frozen proposal");
    const record = result.proposals.records.find((entry) => entry.proposal.proposalId === judgment.proposalId);
    assert(record !== undefined);
    assertEqual(judgment.proposal.action, record.proposal.action);
    assertEqual(judgment.proposal.reason, record.proposal.reason);
    assertEqual(judgment.proposal.directionalComparable, record.proposal.directionalComparable);
    assertEqual(judgment.proposal.evolveDirectionalIntent, record.proposal.evolveDirectionalIntent);
    assertEqual(judgment.proposalDigest, record.proposalDigest);
  }
  const sequences = result.judgments.records.map((judgment) => judgment.sequence);
  assertEqual(new Set(sequences).size, sequences.length, "judgment sequences must be unique");
});

await test("bounded queue at capacity: observer work is dropped explicitly and recorded", async () => {
  const sessionId = "jsup-fixture-queue-full";
  const { provider } = fixtureProvider();
  const observer = observerFor({
    sessionId,
    provider,
    sleep: (ms) => (ms > 30 ? Promise.resolve() : new Promise(() => {})),
    finalizeTimeoutMs: 50,
  });
  observer.start();
  const total = SUPERVISOR_QUEUE_CAPACITY + 2;
  for (let index = 0; index < total; index += 1) {
    const handle = observer.freezeProposal(proposalFacts({ at: BASE_AT + index * 1_000, agentId: `A-QUEUE-${index}` }));
    observer.recordExecution(handle, ENTRY_EXECUTION);
  }
  const snapshot = observer.snapshot();
  assertEqual(snapshot.queue.capacity, SUPERVISOR_QUEUE_CAPACITY);
  assertEqual(snapshot.queue.depth, SUPERVISOR_QUEUE_CAPACITY);
  assertEqual(snapshot.queue.highWatermark, SUPERVISOR_QUEUE_CAPACITY);
  assertEqual(snapshot.queue.dropped, 2);
  assertEqual(snapshot.counters.queueDropped, 2);
  assertEqual(snapshot.counters.proposalsSeenByTap, total);
  await observer.finalize({ status: "COMPLETE" });
  const root = path.join(SESSION_BASE, sessionId);
  const lines = await readSupervisorLines(path.join(root, "proposals.ndjson"));
  const drops = lines.records.filter((record) => record.recordType === "PROPOSAL_DROPPED");
  assertEqual(drops.length, 2, "each dropped observation must be recorded explicitly");
  for (const drop of drops) {
    assertEqual(drop.dropReason, "QUEUE_FULL");
    assertEqual(typeof drop.proposalId, "string");
    assertIncludes(drop.note, "never slowed");
  }
  const state = await readSupervisorState(root);
  assertEqual(state.queue.dropped, 2);
  assertEqual(state.droppedRecords.length, 2);
  assertEqual(state.counters.queueDropped, 2);
  const summary = await readSupervisorSummary(root);
  assertEqual(summary.queueDropped, 2);
  assertEqual(summary.queueHighWatermark, SUPERVISOR_QUEUE_CAPACITY);
});

/* ============================================================================
 * 5. Zero authority: deterministic engine equivalence under every observer
 * ==========================================================================*/

const BASELINE_RUN = await runFixtureSimulation({ observer: null });
const BASELINE_TRADES = BASELINE_RUN.snapshot.recentTrades.length;
assert(BASELINE_TRADES > 0, "the equivalence fixture must trade");

await test("equivalence: observer disabled vs enabled (deterministic fixture observer)", async () => {
  const { provider, calls } = fixtureProvider({ probability: 0.62 });
  const sessionId = "jsup-fixture-equivalence";
  const observer = observerFor({ sessionId, provider });
  observer.start();
  const enabled = await runFixtureSimulation({ observer });
  assertEngineIdentical(BASELINE_RUN, enabled, "observer enabled");
  assertEqual(enabled.snapshot.recentTrades.length, BASELINE_TRADES);
  const seen = observer.snapshot().counters.proposalsSeenByTap;
  assert(seen > 0, "the tap must have frozen the engine's proposals");
  await settleObserver(observer, { expected: seen, timeoutMs: 3_000 });
  await observer.finalize({ status: "COMPLETE" });
  const snapshot = observer.snapshot();
  // The engine loop is synchronous, so the observer catches up only afterwards
  // and the fixed queue cap may drop work — explicitly, and in counted form.
  assertEqual(snapshot.counters.proposalsObserved + snapshot.queue.dropped, seen, "every proposal is observed or explicitly dropped");
  assert(snapshot.counters.jevCalls > 0, "the fixture provider must have been asked");
  assertEqual(
    calls.count,
    snapshot.counters.jevCalls + snapshot.counters.jevCallsForSolStates,
    "total provider calls = executed-trade calls + SOL-state calls",
  );
  const droppedRecords = snapshot.droppedRecords ?? [];
  for (const drop of droppedRecords) assertEqual(drop.dropReason, "QUEUE_FULL");
  assert(snapshot.counters.supportedProposals > 0, "the SOL fixture proposals must be supported");
  const summary = observer.summary();
  assert(
    summary.entryComparableCount > 0 || summary.signalExitComparableCount > 0,
    "the run must contain direction-comparable proposals",
  );
  assertEqual(summary.proposalsObserved, summary.supportedProposals + summary.unsupportedProposals);
  const proposals = await readSupervisorLines(path.join(SESSION_BASE, sessionId, "proposals.ndjson"));
  const exits = proposals.records.filter((record) => record.proposal?.action === "EXIT_LONG");
  assert(exits.length > 0, "the engine must have produced exits");
  let unmatched = 0;
  for (const trade of enabled.snapshot.recentTrades) {
    const matched = exits.some(
      (record) =>
        record.proposal.agentId === trade.agentId &&
        record.proposal.reason === trade.reason &&
        record.evolveExecution?.executed === true,
    );
    if (!matched) unmatched += 1;
  }
  assert(
    unmatched <= summary.queueDropped,
    `only explicitly dropped observations may lack a proposal record (${unmatched} unmatched, ${summary.queueDropped} dropped)`,
  );
  for (const reason of new Set(exits.map((record) => record.proposal.reason))) {
    assert(
      ["SIGNAL", "STOP", "TAKE", "TIME", "GEN-END", "STAGE-END"].includes(reason),
      `the observer may only ever see the engine's own deterministic reasons (got '${reason}')`,
    );
  }
});

await test("equivalence: a throwing observer changes nothing", async () => {
  const throwing = {
    freezeProposal() {
      throw new Error("observer boom");
    },
    recordExecution() {
      throw new Error("observer boom");
    },
  };
  const run = await runFixtureSimulation({ observer: throwing });
  assertEngineIdentical(BASELINE_RUN, run, "throwing observer");
});

await test("equivalence: a throwing recordExecution changes nothing", async () => {
  const throwing = {
    freezeProposal() {
      return { proposalId: "throwing-handle" };
    },
    recordExecution() {
      throw new Error("recordExecution boom");
    },
  };
  const run = await runFixtureSimulation({ observer: throwing });
  assertEngineIdentical(BASELINE_RUN, run, "throwing recordExecution");
});

await test("equivalence: a malformed Jev result changes nothing", async () => {
  const { provider } = fixtureProvider({ behavior: "malformed" });
  const observer = observerFor({ sessionId: "jsup-fixture-equiv-malformed", provider });
  observer.start();
  const run = await runFixtureSimulation({ observer });
  assertEngineIdentical(BASELINE_RUN, run, "malformed Jev result");
  const seen = observer.snapshot().counters.proposalsSeenByTap;
  await settleObserver(observer, { expected: seen, timeoutMs: 3_000 });
  await observer.finalize({ status: "COMPLETE" });
  const summary = observer.summary();
  assert(summary.jevFailures > 0, "the malformed answers must be recorded as failures");
  assertEqual(summary.agreementCount + summary.disagreementCount, 0);
});

await test("equivalence: a failing Jev changes nothing", async () => {
  const { provider } = fixtureProvider({ behavior: "fail" });
  const observer = observerFor({ sessionId: "jsup-fixture-equiv-failing", provider });
  observer.start();
  const run = await runFixtureSimulation({ observer });
  assertEngineIdentical(BASELINE_RUN, run, "failing Jev");
  const seen = observer.snapshot().counters.proposalsSeenByTap;
  await settleObserver(observer, { expected: seen, timeoutMs: 3_000 });
  await observer.finalize({ status: "COMPLETE" });
  const summary = observer.summary();
  assert(summary.jevFailures > 0);
  assertEqual(summary.agreementCount + summary.disagreementCount, 0);
  assertEqual(
    summary.jevFailures,
    summary.proposalsObserved - summary.unsupportedProposals,
    "every processed supported proposal failed, and none leaked into a trade",
  );
});

await test("equivalence: a slow Jev response never blocks simulation progression", async () => {
  let release = null;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let started = 0;
  const { provider, calls } = fixtureProvider({
    onEvaluate: async () => {
      started += 1;
      await gate;
      return {
        ok: true,
        requestId: "req-slow",
        model: SUPERVISOR_REQUIRED_MODEL,
        answers: { [DIRECTION_QUESTION_NAME]: { type: "noul", noul: 0.6 } },
      };
    },
  });
  const observer = observerFor({ sessionId: "jsup-fixture-equiv-slow", provider });
  observer.start();
  const run = await runFixtureSimulation({ observer });
  // The whole engine run completed synchronously; only now may the worker start
  // the first Jev call, and that call is still pending.
  assertEngineIdentical(BASELINE_RUN, run, "slow Jev");
  assertEqual(started, 0, "no Jev call may run inside the synchronous engine loop");
  assertEqual(observer.snapshot().counters.proposalsObserved, 0, "nothing is processed while the engine runs");
  const seen = observer.snapshot().counters.proposalsSeenByTap;
  assert(seen > 0);
  // Let the worker begin its first call, then verify the engine is already done.
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert(started >= 1, "the observer must have started a call");
  assertEqual(calls.count, started);
  assertEqual(observer.snapshot().counters.jevOk, 0, "the call is still pending");
  assertEqual(observer.isFinalized(), false);
  assertEngineIdentical(BASELINE_RUN, run, "slow Jev, after the call started");
  release();
  await settleObserver(observer, { expected: seen, timeoutMs: 3_000 });
  await observer.finalize({ status: "COMPLETE" });
  assert(observer.snapshot().counters.jevOk > 0, "the observer catches up once Jev answers");
});

await test("equivalence: an interleaved run processes every proposal and still changes nothing", async () => {
  const { provider, calls } = fixtureProvider({ probability: 0.62 });
  const sessionId = "jsup-fixture-interleaved";
  const observer = observerFor({ sessionId, provider });
  observer.start();
  const interleavedOptions = {
    seedLabel: "ps2-interleaved",
    populationSize: 24,
    generationTicks: 40,
    ticks: 48,
    yieldsPerTick: 24,
  };
  const interleaved = await runFixtureSimulation({ observer, ...interleavedOptions });
  const interleavedBaseline = await runFixtureSimulation({ observer: null, ...interleavedOptions });
  assertEngineIdentical(interleavedBaseline, interleaved, "interleaved observer");
  const seen = observer.snapshot().counters.proposalsSeenByTap;
  assert(seen > 0);
  await settleObserver(observer, { expected: seen, timeoutMs: 10_000 });
  await observer.finalize({ status: "COMPLETE" });
  const snapshot = observer.snapshot();
  assertEqual(snapshot.counters.proposalsObserved, seen, "an interleaved engine lets the observer keep up");
  assertEqual(snapshot.queue.dropped, 0, "no drop is needed when the engine yields between ticks");
  assertEqual(
    calls.count,
    snapshot.counters.jevCalls + snapshot.counters.jevCallsForSolStates,
    "total provider calls = executed-trade calls + SOL-state calls",
  );
  assert(snapshot.counters.jevOk > 0);
  // With nothing dropped, the linkage is exact: every executed paper trade has
  // a retained, executed exit proposal with the SAME agent and the SAME
  // deterministic reason (the reason is passed through verbatim).
  const records = await readSupervisorLines(path.join(SESSION_BASE, sessionId, "proposals.ndjson"));
  const exits = records.records.filter(
    (record) => record.recordType === "PROPOSAL" && record.proposal?.action === "EXIT_LONG" && record.evolveExecution?.executed === true,
  );
  assert(exits.length > 0);
  assert(interleaved.snapshot.recentTrades.length > 0);
  for (const trade of interleaved.snapshot.recentTrades) {
    const matched = exits.some(
      (record) => record.proposal.agentId === trade.agentId && record.proposal.reason === trade.reason,
    );
    assert(matched, `every trade must have a matching executed exit proposal (${trade.agentId}/${trade.reason})`);
  }
  const engineReasons = new Set(interleaved.snapshot.recentTrades.map((trade) => trade.reason));
  for (const reason of engineReasons) {
    assertEqual(reason, reason.trim(), "the existing deterministic reason must be captured exactly");
    assert(
      ["SIGNAL", "STOP", "TAKE", "TIME", "GEN-END", "STAGE-END"].includes(reason),
      `unexpected engine exit reason '${reason}'`,
    );
  }
  assert(
    engineReasons.has("TIME") || engineReasons.has("STOP") || engineReasons.has("TAKE") || engineReasons.has("GEN-END"),
    "the lifecycle fixture must produce at least one lifecycle exit",
  );
});

/* ============================================================================
 * 5b. Phase 5I-PS.2a — SOL opportunity capture, dedup and unsupported bypass
 * ==========================================================================*/

async function runSolFixture({
  sessionId,
  provider,
  seedLabel = "ps2a-sol",
  populationSize = 24,
  generationTicks = 20,
  ticks = 60,
  yieldsPerTick = 6,
  feed = null,
} = {}) {
  const observer = observerFor({ sessionId, provider });
  observer.start();
  const run = await runFixtureSimulation({ observer, seedLabel, populationSize, generationTicks, ticks, yieldsPerTick, feed });
  const seen = observer.snapshot().counters.proposalsSeenByTap;
  const expectedSol = observer.snapshot().counters.solOpportunityProposals;
  await settleObserver(observer, { expected: seen, expectedSol, timeoutMs: 20_000 });
  await observer.finalize({ status: "COMPLETE" });
  const root = path.join(SESSION_BASE, sessionId);
  return {
    observer,
    run,
    snapshot: observer.snapshot(),
    summary: observer.summary(),
    opportunities: (await readSupervisorSolOpportunities(root)).records,
    solJudgments: (await readSupervisorSolJudgments(root)).records,
    proposals: (await readSupervisorLines(path.join(root, "proposals.ndjson"))).records,
  };
}

await test("frozen PS.2a definition: evidence class, dedup rule and semantics", () => {
  assertEqual(SUPERVISOR_PHASE_EXTENSION, "5I-PS.2a");
  assertEqual(SUPERVISOR_SOL_OPPORTUNITY_EVIDENCE_TYPE, "EVOLVE_SOL_OPPORTUNITY");
  assertEqual(SUPERVISOR_EVIDENCE_TYPES.EXECUTED_TRADE, "EXECUTED_TRADE");
  assertEqual(SUPERVISOR_EVIDENCE_TYPES.EVOLVE_SOL_OPPORTUNITY, "EVOLVE_SOL_OPPORTUNITY");
  assert(SUPERVISOR_SOL_QUEUE_CAPACITY > 0);
  assert(SUPERVISOR_MAX_UNSUPPORTED_SAMPLE > 0);
  assertEqual(SUPERVISOR_ROW_KINDS.SOL_OPPORTUNITY, "SOL OPPORTUNITY");
  assertEqual(SUPERVISOR_ROW_KINDS.EXECUTED_ENTRY, "EXECUTED ENTRY");
  assertEqual(SUPERVISOR_ROW_KINDS.EXECUTED_EXIT, "EXECUTED EXIT");
  assertEqual(SUPERVISOR_ROW_KINDS.NOT_COMPARABLE, "NOT COMPARABLE");
  assertIncludes(SUPERVISOR_SOL_DEDUP_RULE, "at most one EVOLVE_SOL_OPPORTUNITY per agent per generation");
  assertIncludes(SUPERVISOR_SOL_DEDUP_RULE, "first actionable SOL observation kept");
  assertEqual(SUPERVISOR_SOL_TAP_DEFINITION.isExecutedTrade, false);
  assertEqual(SUPERVISOR_SOL_TAP_DEFINITION.evolveDirectionalIntent, "HIGHER");
  assertEqual(SUPERVISOR_SOL_TAP_DEFINITION.directionalComparable, true);
  assertEqual(SUPERVISOR_SOL_TAP_DEFINITION.newTradingThresholdIntroduced, false);
  assertEqual(SUPERVISOR_SOL_TAP_DEFINITION.agentEntryThresholdIsTheExistingGenomeThreshold, true);
  assertEqual(SUPERVISOR_SOL_TAP_DEFINITION.recordInfluencesMarketSelection, false);
  assertEqual(SUPERVISOR_SOL_TAP_DEFINITION.agentAnchoringSentToJev, false);
  assertEqual(SUPERVISOR_SOL_TAP_DEFINITION.dedupDependsOnJevOutputOrFuturePrice, false);
  assertEqual(SUPERVISOR_SOL_TAP_DEFINITION.confidenceThresholdApplied, false);
});

await test("market identity: SOL-USDC only for the wrapped-SOL mint; arbitrary assets stay null", () => {
  assertEqual(marketIdForMint(SOL_MINT), "SOL-USDC");
  assertEqual(marketIdForMint(UNSOL_MINT), null);
  assertEqual(marketIdForMint(null), null);
  // REMARC/Stamp-style unsupported proposals: a real non-SOL mint can NEVER be
  // serialized with the canonical SOL market id.
  const remarcMint = "REMARCFixtureMint11111111111111111111111111111";
  const stampMint = "StampFixtureMint111111111111111111111111111111";
  for (const [mint, symbol] of [[remarcMint, "REMARC"], [stampMint, "STAMP"]]) {
    const facts = buildProposalFacts(
      {
        action: "ENTER_LONG",
        reason: "ENTRY_SIGNAL",
        at: BASE_AT,
        agentId: `A-${symbol}`,
        market: solMarket(BASE_AT, 200, { mint, symbol }),
        byMint: new Map(),
      },
      { proposalId: `jsup-frozen-${symbol}`, sessionId: "jsup-frozen" },
    );
    assertEqual(facts.market.mint, mint);
    assertEqual(facts.market.marketId, null, `an unsupported ${symbol} proposal may never serialize as SOL-USDC`);
  }
  const solFacts = buildProposalFacts(
    { action: "ENTER_LONG", reason: "ENTRY_SIGNAL", at: BASE_AT, agentId: "A-SOL", market: solMarket(BASE_AT, 200), byMint: new Map() },
    { proposalId: "jsup-frozen-sol", sessionId: "jsup-frozen" },
  );
  assertEqual(solFacts.market.marketId, "SOL-USDC", "the wrapped-SOL proposal keeps the canonical identity");
});

await test("SOL tap point: strictly after passesGates + scoring, threshold-exact, comparison untouched", () => {
  const src = SIMULATION_SOURCE;
  const stepIdx = src.indexOf("function stepAgent");
  const gateIdx = src.indexOf("if (!passesGates(agent.genome, market, ctx)) continue;", stepIdx);
  const scoreIdx = src.indexOf("const score = scoreMarket(agent.genome, market);", gateIdx);
  const tapIdx = src.indexOf("solOpportunityHandle = freezeSolOpportunityForObserver(", scoreIdx);
  const compareIdx = src.indexOf("if (score > bestScore) {", tapIdx);
  assert(stepIdx > 0 && gateIdx > stepIdx && scoreIdx > gateIdx && tapIdx > scoreIdx, "the tap must sit after gates and scoring");
  assert(compareIdx > tapIdx, "the tap must not disturb the best/bestScore comparison");
  assertIncludes(src, "market.mint === solOpportunityMint &&");
  assertIncludes(src, "score >= agent.genome.entryScoreThreshold");
  assertIncludes(src, "let solOpportunityHandle = null;");
  assertIncludes(src, "bestScore = score;");
  assertIncludes(src, "best = market;");
  assertIncludes(src, "const solOpportunityMint =");
});

await test("SOL opportunity dedup: one per agent per generation, first kept, reset next generation", async () => {
  const { provider } = fixtureProvider({ probability: 0.62 });
  const sessionId = "jsup-fixture-sol-dedup";
  const observer = observerFor({ sessionId, provider });
  observer.start();
  const first = observer.observeSolOpportunity(solOpportunityInput({ generation: 1, agentId: "A-DEDUP", solScore: 0.9 }));
  observer.recordSolSelection(first, { actualSelectedMint: SOL_MINT, actualSelectedSymbol: "SOL", actualSelectedScore: 0.9 });
  const repeated = observer.observeSolOpportunity(solOpportunityInput({ at: BASE_AT + 1_000, generation: 1, agentId: "A-DEDUP", solScore: 0.7 }));
  assertEqual(repeated, null, "a repeated actionable SOL observation for the same agent/generation is suppressed");
  const nextGen = observer.observeSolOpportunity(solOpportunityInput({ at: BASE_AT + 2_000, generation: 2, agentId: "A-DEDUP", solScore: 0.8 }));
  assert(nextGen !== null, "the next generation is eligible again");
  observer.recordSolSelection(nextGen, { actualSelectedMint: SOL_MINT, actualSelectedSymbol: "SOL", actualSelectedScore: 0.8 });
  const live = observer.snapshot();
  assertEqual(live.counters.solOpportunityObservations, 3);
  assertEqual(live.counters.solOpportunityProposals, 2);
  assertEqual(live.counters.opportunitiesSuppressedByAgentGenerationDedup, 1);
  await settleObserver(observer, { expectedSol: 2 });
  await observer.finalize({ status: "COMPLETE" });
  const records = (await readSupervisorSolOpportunities(path.join(SESSION_BASE, sessionId))).records;
  assertEqual(records.length, 2);
  assertEqual(records[0].solScore, 0.9, "the FIRST actionable observation is the one kept");
  assertEqual(records[0].generation, 1);
  assertEqual(records[1].generation, 2);
  assertEqual(solOpportunityDedupKey({ agentId: "A-DEDUP", generation: 1 }), "A-DEDUP::1");
});

await test("SOL judgment dedup: two agents on the same frozen state share ONE Jev judgment", async () => {
  const { provider, calls } = fixtureProvider({ probability: 0.62 });
  const sessionId = "jsup-fixture-sol-shared";
  const observer = observerFor({ sessionId, provider });
  observer.start();
  const a = observer.observeSolOpportunity(solOpportunityInput({ agentId: "A-SHARE-1" }));
  observer.recordSolSelection(a, { actualSelectedMint: SOL_MINT, actualSelectedSymbol: "SOL", actualSelectedScore: 0.8 });
  const b = observer.observeSolOpportunity(solOpportunityInput({ agentId: "A-SHARE-2" }));
  observer.recordSolSelection(b, { actualSelectedMint: UNSOL_MINT, actualSelectedSymbol: "BONK", actualSelectedScore: 0.95 });
  await settleObserver(observer, { expectedSol: 2 });
  await observer.finalize({ status: "COMPLETE" });
  const snapshot = observer.snapshot();
  assertEqual(snapshot.counters.solOpportunities, 2);
  assertEqual(snapshot.counters.uniqueSolMarketStates, 1);
  assertEqual(snapshot.counters.jevCallsForSolStates, 1);
  assertEqual(calls.count, 1, "one Jev call for the one frozen SOL state");
  assertEqual(snapshot.counters.reusedJevJudgments, 1);
  const records = (await readSupervisorSolOpportunities(path.join(SESSION_BASE, sessionId))).records;
  assertEqual(records.length, 2, "call dedup never merges or discards an opportunity record");
  assertEqual(records[0].stateDigest, records[1].stateDigest);
  assertEqual(records[0].jevInputDigest, records[1].jevInputDigest);
  assertEqual(records[0].jevInputDigest, digestOf(calls.payloads[0]));
  assertEqual(records[0].jevJudgmentId, records[1].jevJudgmentId);
  assertEqual(records[0].judgmentReused, false);
  assertEqual(records[1].judgmentReused, true);
  assertEqual(records[1].judgmentReuseCount, 1);
  assertEqual(records[0].marketObservationId, records[1].marketObservationId);
  assertEqual(records[0].agreement, "AGREE");
  assertEqual(records[1].agreement, "AGREE");
  assertEqual(records[0].solWasActuallySelected, true);
  assertEqual(records[1].solWasActuallySelected, false, "BONK was selected, but SOL was still actionable");
  assertEqual(records[1].actualSelectedMint, UNSOL_MINT);
  const judgments = await readSupervisorSolJudgments(path.join(SESSION_BASE, sessionId));
  assertEqual(judgments.records.length, 1);
  assertEqual(judgments.records[0].recordType, "SOL_JUDGMENT");
  assertEqual(judgments.records[0].evidenceType, "EVOLVE_SOL_OPPORTUNITY");
  assertEqual(judgments.records[0].gatewayUsed, false);
  assertEqual(judgments.records[0].cacheEnabled, false);
});

// Seed history through the real synchronous tap; never inject worker state.
function captureHistory(observer, { at = BASE_AT - 1_000, price = 190 } = {}) {
  const handle = observer.freezeProposal(proposalFacts({ at, price }));
  observer.recordExecution(handle, ENTRY_EXECUTION);
}

async function frozenSolScenario({ label, afterCapture = false, delayMs = 0 } = {}) {
  const sessionId = "jsup-fixture-frozen-input";
  const baseRoot = path.join(SESSION_BASE, label);
  const { provider, calls } = fixtureProvider();
  let clock = BASE_AT;
  const observer = observerFor({ sessionId, baseRoot, provider, now: () => clock });
  captureHistory(observer);
  const input = solOpportunityInput();
  const handle = observer.observeSolOpportunity(input);
  if (afterCapture) {
    captureHistory(observer, { at: BASE_AT - 500, price: 80 });
    input.market.price = 999;
    input.universeToken.stats5m.priceChange = 999;
    input.byMint.get(USDC_MINT).price = 99;
  }
  clock += delayMs;
  observer.recordSolSelection(handle, { actualSelectedMint: SOL_MINT });
  observer.start();
  await settleObserver(observer, { expected: afterCapture ? 2 : 1, expectedSol: 1 });
  await observer.finalize();
  const record = (await readSupervisorSolOpportunities(path.join(baseRoot, sessionId))).records[0];
  const payload = calls.payloads.find((entry) => entry.state.observationId === null);
  assert(payload !== undefined, "the SOL payload must reach the fixture");
  assertEqual(record.jevInputDigest, digestOf(payload), "identity hashes the exact supplied payload");
  return { record, payload };
}

await test("SOL complete-input reuse: two agents, same nonempty frozen history", async () => {
  const sessionId = "jsup-fixture-sol-history-shared";
  const { provider, calls } = fixtureProvider();
  const observer = observerFor({ sessionId, provider });
  captureHistory(observer);
  for (const agentId of ["A-HISTORY-1", "A-HISTORY-2"]) {
    const handle = observer.observeSolOpportunity(solOpportunityInput({ agentId }));
    observer.recordSolSelection(handle, { actualSelectedMint: SOL_MINT });
  }
  observer.start();
  await settleObserver(observer, { expected: 1, expectedSol: 2 });
  await observer.finalize();
  const records = (await readSupervisorSolOpportunities(path.join(SESSION_BASE, sessionId))).records;
  const payloads = calls.payloads.filter((entry) => entry.state.observationId === null);
  assertEqual(records.length, 2);
  assertEqual(payloads.length, 1);
  assertEqual(payloads[0].state.recentObservationHistory.length, 1);
  assertEqual(records[0].jevInputDigest, records[1].jevInputDigest);
  assertEqual(records[0].jevJudgmentId, records[1].jevJudgmentId);
  assertEqual(records[1].judgmentReuseCount, 1);
  assertEqual(observer.snapshot().counters.reusedJevJudgments, 1);
});

await test("SOL complete-input non-reuse: same current state, different captured history", async () => {
  const sessionId = "jsup-fixture-sol-history-diff";
  const { provider, calls } = fixtureProvider();
  const observer = observerFor({ sessionId, provider });
  captureHistory(observer);
  const first = observer.observeSolOpportunity(solOpportunityInput({ agentId: "A-HIST-1" }));
  observer.recordSolSelection(first, { actualSelectedMint: SOL_MINT });
  captureHistory(observer, { at: BASE_AT - 500, price: 80 });
  const second = observer.observeSolOpportunity(solOpportunityInput({ agentId: "A-HIST-2" }));
  observer.recordSolSelection(second, { actualSelectedMint: SOL_MINT });
  observer.start();
  await settleObserver(observer, { expected: 2, expectedSol: 2 });
  await observer.finalize();
  const records = (await readSupervisorSolOpportunities(path.join(SESSION_BASE, sessionId))).records;
  const payloads = calls.payloads.filter((entry) => entry.state.observationId === null);
  assertEqual(records.length, 2);
  assertEqual(payloads.length, 2);
  assertEqual(records[0].stateDigest, records[1].stateDigest);
  assert(records[0].preOutcomeInputDigest !== records[1].preOutcomeInputDigest);
  assert(records[0].jevInputDigest !== records[1].jevInputDigest);
  assert(records[0].jevJudgmentId !== records[1].jevJudgmentId);
  assertEqual(payloads[0].state.recentObservationHistory.length, 1);
  assertEqual(payloads[1].state.recentObservationHistory.length, 2);
  assertEqual(observer.snapshot().counters.reusedJevJudgments, 0);
});

await test("SOL identity excludes agent score, threshold, species and selected token", async () => {
  const sessionId = "jsup-fixture-sol-metadata";
  const { provider, calls } = fixtureProvider();
  const observer = observerFor({ sessionId, provider });
  for (const [index, agentId] of ["A-META-1", "A-META-2"].entries()) {
    const handle = observer.observeSolOpportunity(solOpportunityInput({
      agentId, solScore: index ? 0.99 : 0.6, threshold: index ? 0.7 : 0.4,
      species: index ? "OtherSpecies" : "Momentum", generationTick: index + 1,
    }));
    observer.recordSolSelection(handle, { actualSelectedMint: index ? UNSOL_MINT : SOL_MINT });
  }
  observer.start();
  await settleObserver(observer, { expectedSol: 2 });
  await observer.finalize();
  const records = (await readSupervisorSolOpportunities(path.join(SESSION_BASE, sessionId))).records;
  assertEqual(records.length, 2);
  assertEqual(calls.count, 1);
  assertEqual(records[0].jevInputDigest, records[1].jevInputDigest);
  assertEqual(records[0].jevJudgmentId, records[1].jevJudgmentId);
  assert(records[0].scoreMargin !== records[1].scoreMargin);
  for (const forbidden of ["agentId", "species", "solScore", "agentEntryThreshold", "scoreMargin", "actualSelected", "evolveDirectionalIntent"]) {
    assertExcludes(JSON.stringify(calls.payloads), forbidden);
  }
});

await test("SOL capture freezes history and caller-owned state before asynchronous processing", async () => {
  const baseline = await frozenSolScenario({ label: "freeze-baseline" });
  const changed = await frozenSolScenario({ label: "freeze-mutated", afterCapture: true });
  assertEqual(JSON.stringify(changed.payload), JSON.stringify(baseline.payload));
  assertEqual(changed.record.jevInputDigest, baseline.record.jevInputDigest);
  assertEqual(changed.record.packetDigest, baseline.record.packetDigest);
  assertEqual(Object.isFrozen(changed.payload.state.recentObservationHistory[0]), true);
});

await test("SOL queue delay cannot alter packet bytes or complete-input digest", async () => {
  const immediate = await frozenSolScenario({ label: "queue-immediate" });
  const delayed = await frozenSolScenario({ label: "queue-delayed", delayMs: 86_400_000 });
  assertEqual(JSON.stringify(delayed.payload), JSON.stringify(immediate.payload));
  assertEqual(delayed.record.jevInputDigest, immediate.record.jevInputDigest);
  assertEqual(delayed.record.packetDigest, immediate.record.packetDigest);
});

await test("SOL identity includes frozen regime inputs even when current SOL state matches", async () => {
  const sessionId = "jsup-fixture-sol-regime-input";
  const { provider, calls } = fixtureProvider();
  const observer = observerFor({ sessionId, provider });
  for (const [index, agentId] of ["A-REGIME-1", "A-REGIME-2"].entries()) {
    const input = solOpportunityInput({ agentId });
    input.byMint.set(UNSOL_MINT, solMarket(BASE_AT, index ? 80 : 20, { mint: UNSOL_MINT, symbol: "OTHER" }));
    const handle = observer.observeSolOpportunity(input);
    observer.recordSolSelection(handle, { actualSelectedMint: SOL_MINT });
  }
  observer.start();
  await settleObserver(observer, { expectedSol: 2 });
  await observer.finalize();
  const records = (await readSupervisorSolOpportunities(path.join(SESSION_BASE, sessionId))).records;
  assertEqual(records.length, 2);
  assertEqual(records[0].stateDigest, records[1].stateDigest);
  assert(records[0].preOutcomeInputDigest !== records[1].preOutcomeInputDigest);
  assert(records[0].jevInputDigest !== records[1].jevInputDigest);
  assertEqual(calls.count, 2);
  assertEqual(observer.snapshot().counters.reusedJevJudgments, 0);
});

await test("SOL question payload is copied and frozen before caller mutation", async () => {
  const { buildDirectionQuestions } = await import("./jev/direction/questions.mjs");
  const questions = buildDirectionQuestions();
  const before = JSON.stringify(questions);
  const { provider, calls } = fixtureProvider();
  const sessionId = "jsup-fixture-sol-frozen-questions";
  const observer = observerFor({ sessionId, provider, questions });
  const first = observer.observeSolOpportunity(solOpportunityInput({ agentId: "A-Q-1" }));
  observer.recordSolSelection(first, { actualSelectedMint: SOL_MINT });
  questions[DIRECTION_QUESTION_NAME] = { type: "noul", question: "mutated question" };
  const second = observer.observeSolOpportunity(solOpportunityInput({ agentId: "A-Q-2" }));
  observer.recordSolSelection(second, { actualSelectedMint: SOL_MINT });
  observer.start();
  await settleObserver(observer, { expectedSol: 2 });
  await observer.finalize();
  assertEqual(calls.count, 1);
  assertEqual(JSON.stringify(calls.payloads[0].questions), before);
  assertEqual(Object.isFrozen(calls.payloads[0].questions), true);
  const records = (await readSupervisorSolOpportunities(path.join(SESSION_BASE, sessionId))).records;
  assertEqual(records[0].jevInputDigest, digestOf(calls.payloads[0]));
  assertEqual(records[1].jevInputDigest, records[0].jevInputDigest);
});

await test("SOL judgment dedup: a changed SOL state produces a separate Jev judgment", async () => {
  const { provider, calls } = fixtureProvider({ probability: 0.62 });
  const sessionId = "jsup-fixture-sol-statechange";
  const observer = observerFor({ sessionId, provider });
  observer.start();
  const a = observer.observeSolOpportunity(solOpportunityInput({ agentId: "A-STATE-1", price: 200 }));
  observer.recordSolSelection(a, { actualSelectedMint: SOL_MINT, actualSelectedSymbol: "SOL", actualSelectedScore: 0.8 });
  const b = observer.observeSolOpportunity(solOpportunityInput({ agentId: "A-STATE-2", price: 260 }));
  observer.recordSolSelection(b, { actualSelectedMint: SOL_MINT, actualSelectedSymbol: "SOL", actualSelectedScore: 0.8 });
  await settleObserver(observer, { expectedSol: 2 });
  await observer.finalize({ status: "COMPLETE" });
  const snapshot = observer.snapshot();
  assertEqual(snapshot.counters.uniqueSolMarketStates, 2);
  assertEqual(snapshot.counters.jevCallsForSolStates, 2);
  assertEqual(snapshot.counters.reusedJevJudgments, 0);
  assertEqual(calls.count, 2);
  const records = (await readSupervisorSolOpportunities(path.join(SESSION_BASE, sessionId))).records;
  assert(records[0].stateDigest !== records[1].stateDigest, "a changed SOL state changes the digest");
  assert(records[0].jevJudgmentId !== records[1].jevJudgmentId, "a changed SOL state triggers a separate judgment");
});

await test("SOL dedup is decided by agent/generation only, never by the Jev answer", async () => {
  const { provider } = fixtureProvider({ behavior: "fail" });
  const observer = observerFor({ sessionId: "jsup-fixture-sol-dedup-fail", provider });
  observer.start();
  const a = observer.observeSolOpportunity(solOpportunityInput({ agentId: "A-NOJEV" }));
  observer.recordSolSelection(a, { actualSelectedMint: SOL_MINT, actualSelectedSymbol: "SOL", actualSelectedScore: 0.8 });
  const b = observer.observeSolOpportunity(solOpportunityInput({ at: BASE_AT + 5_000, generation: 2, agentId: "A-NOJEV" }));
  assert(b !== null, "eligibility is decided by agent/generation, never by the failing Jev result");
  observer.recordSolSelection(b, { actualSelectedMint: SOL_MINT, actualSelectedSymbol: "SOL", actualSelectedScore: 0.8 });
  await settleObserver(observer, { expectedSol: 2 });
  await observer.finalize({ status: "COMPLETE" });
  assertEqual(observer.snapshot().counters.solOpportunityProposals, 2);
});

await test("SOL opportunity captured: exact fields, one per agent/generation, threshold-exact", async () => {
  const { provider } = fixtureProvider({ probability: 0.62 });
  const result = await runSolFixture({ sessionId: "jsup-fixture-sol-captured", provider, seedLabel: "ps2a-captured" });
  const records = result.opportunities;
  assert(records.length > 0, "the SOL fixture must produce at least one actionable SOL opportunity");
  assertEqual(result.snapshot.counters.solOpportunities, records.length);
  assertEqual(result.snapshot.counters.solOpportunityProposals, records.length);
  const seenKeys = new Set();
  for (const record of records) {
    assertEqual(record.recordType, "SOL_OPPORTUNITY");
    assertEqual(record.evidenceType, "EVOLVE_SOL_OPPORTUNITY");
    assertEqual(record.isExecutedTrade, false);
    assertEqual(record.phase, "5I-PS.2");
    assertEqual(record.phaseExtension, "5I-PS.2a");
    assertEqual(record.solMint, SOL_MINT);
    assertEqual(record.passesGates, true);
    assertEqual(record.actionable, true);
    assertEqual(record.evolveDirectionalIntent, "HIGHER");
    assertEqual(record.directionalComparable, true);
    assert(record.solScore >= record.agentEntryThreshold, "below-threshold SOL is never captured");
    assertClose(record.scoreMargin, record.solScore - record.agentEntryThreshold, 1e-9);
    assertEqual(typeof record.timestamp, "string");
    assert(Number.isFinite(record.generation));
    const key = `${record.agentId}::${record.generation}`;
    assertEqual(seenKeys.has(key), false, "at most one opportunity per agent per generation");
    seenKeys.add(key);
    assertEqual(typeof record.stateDigest, "string");
    assertEqual(typeof record.packetDigest, "string");
    assertEqual(typeof record.jevJudgmentId, "string");
    assertEqual(typeof record.marketObservationId, "string");
    assertEqual(Object.hasOwn(record, "actualSelectedMint"), true);
    assertEqual(Object.hasOwn(record, "actualSelectedSymbol"), true);
    assertEqual(Object.hasOwn(record, "actualSelectedScore"), true);
    assertEqual(Object.hasOwn(record, "solWasActuallySelected"), true);
    assertEqual(record.canonicalEvidence, false);
    assertEqual(record.profitabilityInferencePermitted, false);
  }
  assertEqual(
    result.snapshot.counters.solActuallySelected + result.snapshot.counters.solNotSelected,
    records.length,
  );
  const generations = new Set(records.map((record) => record.generation));
  assert(generations.size >= 2, "eligibility spans generations, and is restored on generation change");
  assert(
    result.snapshot.counters.opportunitiesSuppressedByAgentGenerationDedup > 0,
    "the agent/generation dedup rule must actually suppress repeats",
  );
});

await test("SOL gated out: a stale/gated SOL market is never captured while EVOLVE keeps trading", async () => {
  const { provider } = fixtureProvider({ probability: 0.62 });
  const observer = observerFor({ sessionId: "jsup-fixture-sol-gated", provider });
  observer.start();
  const run = await runFixtureSimulation({
    observer,
    feed: createGatedSolFeed(),
    seedLabel: "ps2a-gated",
    generationTicks: 20,
    ticks: 60,
    yieldsPerTick: 6,
  });
  const seen = observer.snapshot().counters.proposalsSeenByTap;
  await settleObserver(observer, { expected: seen, expectedSol: 0, timeoutMs: 15_000 });
  await observer.finalize({ status: "COMPLETE" });
  const snapshot = observer.snapshot();
  assertEqual(snapshot.counters.solOpportunityObservations, 0, "SOL that fails the gates is never captured");
  assertEqual(snapshot.counters.solOpportunities, 0);
  assertEqual(snapshot.counters.jevCallsForSolStates, 0);
  assert(run.snapshot.recentTrades.length > 0, "EVOLVE keeps trading the other fresh market");
  assert(
    run.snapshot.recentTrades.every((trade) => trade.mint !== SOL_MINT),
    "SOL is never traded while it fails the gates",
  );
});

await test("anti-anchoring: the Jev packet carries SOL market state only, no agent/proposal facts", async () => {
  const { provider, calls } = fixtureProvider({ probability: 0.62 });
  const result = await runSolFixture({ sessionId: "jsup-fixture-sol-noleak", provider, seedLabel: "ps2a-noleak" });
  assert(result.opportunities.length > 0);
  assert(calls.packets.length > 0);
  const agentIds = new Set(result.opportunities.map((record) => record.agentId));
  for (const packet of calls.packets) {
    const serialized = JSON.stringify(packet);
    for (const leaked of [
      "agentId",
      "species",
      "solScore",
      "agentEntryThreshold",
      "scoreMargin",
      "actionable",
      "actualSelected",
      "solWasActuallySelected",
      "evolveDirectionalIntent",
      "passesGates",
      "opportunityId",
      "EVOLVE_SOL_OPPORTUNITY",
      "SOL_OPPORTUNITY",
    ]) {
      assertExcludes(serialized, leaked, `the packet must not carry '${leaked}'`);
    }
    for (const agentId of agentIds) {
      assertExcludes(serialized, agentId, "the packet must not name the agent");
    }
  }
});

await test("unsupported load: thousands bypass the Jev queue with zero calls and zero drops", async () => {
  const { provider, calls } = fixtureProvider();
  const observer = observerFor({
    sessionId: "jsup-fixture-unsupported-load",
    provider,
    sleep: (ms) => (ms > 30 ? Promise.resolve() : new Promise(() => {})),
    finalizeTimeoutMs: 50,
  });
  observer.start();
  const total = 5_000;
  for (let index = 0; index < total; index += 1) {
    const handle = observer.freezeProposal({
      action: "ENTER_LONG",
      reason: "ENTRY_SIGNAL",
      at: BASE_AT + index,
      generation: 1,
      agentId: `A-UNS-${index}`,
      market: { mint: UNSOL_MINT, symbol: "BONK" },
    });
    observer.recordExecution(handle, ENTRY_EXECUTION);
  }
  const snapshot = observer.snapshot();
  assertEqual(snapshot.counters.executedTradeProposals, total, "the exact unsupported count is retained");
  assertEqual(snapshot.counters.unsupportedProposals, total);
  assertEqual(snapshot.counters.unsupportedRecentSampleCount, total);
  assertEqual(snapshot.unsupportedRecentSample.length, SUPERVISOR_MAX_UNSUPPORTED_SAMPLE, "only a bounded recent sample is retained");
  assertEqual(snapshot.counters.proposalsObserved, 0);
  assertEqual(snapshot.counters.jevCalls, 0);
  assertEqual(calls.count, 0, "unsupported traffic makes no Jev call");
  assertEqual(snapshot.queue.depth, 0, "unsupported traffic does not consume the Jev queue");
  assertEqual(snapshot.queue.highWatermark, 0);
  assertEqual(snapshot.queue.dropped, 0, "unsupported traffic cannot create a queue drop");
  assertEqual(snapshot.counters.queueDropped, 0);
  await observer.finalize({ status: "COMPLETE" });
  const lines = await readSupervisorLines(path.join(SESSION_BASE, "jsup-fixture-unsupported-load", "proposals.ndjson"));
  assertEqual(lines.missing === true || lines.records.length === 0, true, "no full record is written for unsupported traffic");
});

await test("observability: summary timestamps reflect final observer state", async () => {
  const { provider } = fixtureProvider({ probability: 0.62 });
  const result = await observeOne({ sessionId: "jsup-fixture-summary-times", provider });
  const proposalAt = result.proposals.records[0].proposal.timestamp;
  const judgmentAt = result.judgments.records[0].observerCompletedAt;
  assertEqual(result.summary.lastProposalAt, proposalAt, "the finalized summary must reflect the last proposal");
  assertEqual(result.summary.lastJudgmentAt, judgmentAt, "the finalized summary must reflect the last judgment");
  assertEqual(result.state.lastProposalAt, result.summary.lastProposalAt);
  assertEqual(result.state.lastJudgmentAt, result.summary.lastJudgmentAt);
});

await test("equivalence: enabling SOL opportunity capture never changes EVOLVE selection", async () => {
  const { provider } = fixtureProvider({ probability: 0.62 });
  const observer = observerFor({ sessionId: "jsup-fixture-sol-equivalence", provider });
  observer.start();
  const enabled = await runFixtureSimulation({ observer, feed: createTwoMarketFeed(), seedLabel: "ps2a-eq", generationTicks: 20, ticks: 60, yieldsPerTick: 6 });
  const baseline = await runFixtureSimulation({ observer: null, feed: createTwoMarketFeed(), seedLabel: "ps2a-eq", generationTicks: 20, ticks: 60 });
  assertEngineIdentical(baseline, enabled, "SOL opportunity capture enabled");
  assertEqual(
    JSON.stringify(enabled.snapshot.recentTrades),
    JSON.stringify(baseline.snapshot.recentTrades),
    "the selected markets and fills are byte-identical",
  );
  const seen = observer.snapshot().counters.proposalsSeenByTap;
  const expectedSol = observer.snapshot().counters.solOpportunityProposals;
  await settleObserver(observer, { expected: seen, expectedSol, timeoutMs: 15_000 });
  await observer.finalize({ status: "COMPLETE" });
  const snapshot = observer.snapshot();
  assert(snapshot.counters.solOpportunities > 0, "the two-market fixture must capture SOL opportunities");
  assertEqual(
    snapshot.counters.solActuallySelected + snapshot.counters.solNotSelected,
    snapshot.counters.solOpportunities,
    "every opportunity truthfully records whether SOL was selected",
  );
});

await test("equivalence: a throwing SOL opportunity observer changes nothing", async () => {
  const throwing = {
    freezeProposal() {
      return { proposalId: "sol-throwing-handle" };
    },
    recordExecution() {},
    solMint: SOL_MINT,
    observeSolOpportunity() {
      throw new Error("observeSolOpportunity boom");
    },
    recordSolSelection() {
      throw new Error("recordSolSelection boom");
    },
  };
  const run = await runFixtureSimulation({ observer: throwing });
  assertEngineIdentical(BASELINE_RUN, run, "throwing SOL observer");
});

console.log(`\n  \u2026 dashboard, settings, sanitizer and preservation proofs \u2026\n`);

/* ============================================================================
 * 6. Dashboard block (compact, read-only, never merged)
 * ==========================================================================*/

const DASHBOARD_SESSION_ID = "jsup-fixture-dashboard";
const dashboardProvider = fixtureProvider({ probability: 0.62 });
const DASHBOARD_RESULT = await observeMany({
  sessionId: DASHBOARD_SESSION_ID,
  baseRoot: DASHBOARD_BASE,
  provider: dashboardProvider.provider,
  items: [
    { facts: proposalFacts({ at: BASE_AT, agentId: "A-DASH-ENTRY" }) },
    { facts: proposalFacts({ at: BASE_AT + 1_000, agentId: "A-DASH-ENTRY-2" }) },
    { facts: proposalFacts({ at: BASE_AT + 2_000, agentId: "A-DASH-SIGNAL", action: "EXIT_LONG", reason: "SIGNAL", position: { mint: SOL_MINT, symbol: "SOL", qty: 0.1, cost: 20, entryRefPrice: 200, entryPrice: 200, entryLiquidity: 2e7, heldTicks: 3, entryAt: BASE_AT, entryScore: 0.6 } }), execution: EXIT_EXECUTION },
    { facts: proposalFacts({ at: BASE_AT + 3_000, agentId: "A-DASH-STOP", action: "EXIT_LONG", reason: "STOP", position: { mint: SOL_MINT, symbol: "SOL", qty: 0.1, cost: 20, entryRefPrice: 210, entryPrice: 210, entryLiquidity: 2e7, heldTicks: 5, entryAt: BASE_AT, entryScore: 0.6 } }), execution: EXIT_EXECUTION },
    { facts: proposalFacts({ at: BASE_AT + 4_000, agentId: "A-DASH-TAKE", action: "EXIT_LONG", reason: "TAKE", position: { mint: SOL_MINT, symbol: "SOL", qty: 0.1, cost: 20, entryRefPrice: 190, entryPrice: 190, entryLiquidity: 2e7, heldTicks: 6, entryAt: BASE_AT, entryScore: 0.6 } }), execution: EXIT_EXECUTION },
    { facts: proposalFacts({ at: BASE_AT + 5_000, agentId: "A-DASH-TIME", action: "EXIT_LONG", reason: "TIME", position: { mint: SOL_MINT, symbol: "SOL", qty: 0.1, cost: 20, entryRefPrice: 200, entryPrice: 200, entryLiquidity: 2e7, heldTicks: 30, entryAt: BASE_AT, entryScore: 0.6 } }), execution: EXIT_EXECUTION },
    { facts: proposalFacts({ at: BASE_AT + 6_000, agentId: "A-DASH-UNSUPPORTED", mint: UNSOL_MINT, symbol: "BONK" }) },
  ],
});
await observeOne({
  sessionId: "jsup-fixture-dashboard-half",
  baseRoot: DASHBOARD_BASE,
  provider: fixtureProvider({ probability: 0.5 }).provider,
});
assertEqual(DASHBOARD_RESULT.proposals.records.length, 6, "the unsupported BONK proposal is counted, not written");
assertEqual(DASHBOARD_RESULT.summary.unsupportedProposals, 1, "the unsupported BONK proposal is still counted");
assertEqual(DASHBOARD_RESULT.summary.agreementCount, 2, "both entries AGREE with Jev HIGHER");
assertEqual(DASHBOARD_RESULT.summary.disagreementCount, 1, "a LOWER exit against Jev HIGHER DISAGREES");

await test("dashboard: separate top-level block with authority warning, counts and rows", async () => {
  const block = await loadJevSupervisorObserverState(DASHBOARD_ROOT, { now: () => BASE_AT + 10 * 60_000 });
  assertEqual(block.available, true);
  assertEqual(block.noAuthorityTag, "NO AUTHORITY \u2022 PAPER ONLY");
  assertEqual(block.label, "JEV SUPERVISOR OBSERVER");
  assertEqual(block.statement, SUPERVISOR_STATEMENT);
  assertEqual(block.isolationStatement, SUPERVISOR_ISOLATION_STATEMENT);
  assertEqual(block.observerOnly, true);
  assertEqual(block.paperOnly, true);
  assertEqual(block.canonicalEvidence, false);
  assertEqual(block.jevHasTradingAuthority, false);
  assertEqual(block.jevHasEvolutionAuthority, false);
  assertEqual(block.jevHasSelectionAuthority, false);
  assertEqual(block.jevHasArenaAuthority, false);
  assertEqual(block.gatewayUsed, false);
  assertEqual(block.cacheEnabled, false);
  assertEqual(block.mode, "shadow");
  assertEqual(block.provider, SUPERVISOR_REQUIRED_PROVIDER);
  assertEqual(block.model, SUPERVISOR_REQUIRED_MODEL);
  assertEqual(block.sessionId, "jsup-fixture-dashboard-half", "the newest session wins");
  assertEqual(typeof block.observerHealth, "string");
  assertEqual(block.winner, null);
  assertEqual(block.noAutomatedWinner, true);
  assertEqual(block.supervisorScore, null);
  assert(Number.isFinite(block.proposalsObserved));
  assert(Number.isFinite(block.supportedProposals));
  assert(Number.isFinite(block.unsupportedProposals));
  assert(Number.isFinite(block.jevCalls));
  assert(Number.isFinite(block.jevFailures));
  assert(Number.isFinite(block.agreementCount));
  assert(Number.isFinite(block.disagreementCount));
  assert(Number.isFinite(block.exactHalfCount));
  assert(Number.isFinite(block.meanPHigher));
  assert(Number.isFinite(block.meanDistanceFromHalf));
  assert(Number.isFinite(block.meanLatencyMs));
  assert(Number.isFinite(block.queueDepth));
  assert(Number.isFinite(block.queueDropped));
  assertEqual(block.exactHalfCount, 1);
  assertEqual(block.queueDropped, 0);
  assertExcludes(Object.keys(block).join(","), "jevShadow", "never merged with the Phase 5D supervisor health block");
  assertExcludes(Object.keys(block).join(","), "jevPaperShadow", "never merged with the 5I-PS paper demo account");
  assert(Array.isArray(block.recentRows));
});

await test("dashboard rows: time/agent/species/action/reason/price/intent/p/intent/agreement/executed", async () => {
  const block = await loadJevSupervisorObserverState(DASHBOARD_ROOT, { now: () => BASE_AT });
  assert(block.recentRows.length >= 1);
  for (const row of block.recentRows) {
    for (const key of [
      "at",
      "agentId",
      "species",
      "action",
      "reason",
      "symbol",
      "referencePrice",
      "evolveDirectionalIntent",
      "pHigher",
      "modelIntent",
      "agreement",
      "executed",
    ]) {
      assert(Object.hasOwn(row, key), `row must expose '${key}'`);
    }
  }
  // Read the older session's own state to check STOP/TAKE/TIME rows (the newest
  // session in this workspace is the single exact-half observation).
  const state = await readSupervisorState(path.join(DASHBOARD_BASE, DASHBOARD_SESSION_ID));
  for (const row of state.recentRows) {
    if (["STOP", "TAKE", "TIME"].includes(row.reason)) {
      assertEqual(row.agreement, "NOT_DIRECTIONALLY_COMPARABLE", `${row.reason} must never agree/disagree`);
      assertEqual(row.directionalComparable, false);
      assertEqual(row.evolveDirectionalIntent, null);
    }
  }
});

await test("dashboard: no session yet is an explicit placeholder, never an error", async () => {
  const block = await loadJevSupervisorObserverState(path.join(WORKSPACE, "empty-root"));
  assertEqual(block.available, false);
  assertEqual(block.noAuthorityTag, "NO AUTHORITY \u2022 PAPER ONLY");
  assertEqual(block.jevHasTradingAuthority, false);
  assertIncludes(block.note, "No Jev supervisor observer session");
  assertEqual((await listSupervisorSessions(path.join(WORKSPACE, "empty-root", "jev-supervisor-observer"))).length, 0);
});

await test("dashboard state is compact: no raw market state, packet or credentials", async () => {
  const stateText = await readFile(path.join(DASHBOARD_BASE, DASHBOARD_SESSION_ID, "state.json"), "utf8");
  for (const forbidden of ['"marketState":', '"regimeSnapshot":', '"preOutcomeInputDigest":', '"packetDigest":', "apiKey", "authorization", FAKE_SECRET, "EVOLVE_JEV_API_KEY"]) {
    assertExcludes(stateText, forbidden, `state.json must not expose '${forbidden}'`);
  }
  assertIncludes(stateText, "marketStateUnavailableProposals", "compact counters are fine");
  const block = await loadJevSupervisorObserverState(DASHBOARD_ROOT, { now: () => BASE_AT });
  const sanitized = sanitizeForPublic(block, { secrets: [FAKE_SECRET] });
  const sanitizedText = JSON.stringify(sanitized);
  assertExcludes(sanitizedText, FAKE_SECRET);
  assertExcludes(sanitizedText, "apiKey");
  assertEqual(sanitized.available, true);
  const unit = sanitizeForPublic({ apiKey: FAKE_SECRET, note: `key ${FAKE_SECRET}`, provider: "typesafe-jev" }, { secrets: [FAKE_SECRET] });
  assertEqual(unit.apiKey, undefined, "a credential-named field is dropped outright");
  assertEqual(unit.provider, "typesafe-jev");
  assertIncludes(unit.note, "[redacted]");
  assertExcludes(JSON.stringify(unit), FAKE_SECRET);
});

const DASHBOARD_SOL_SESSION_ID = "jsup-fixture-dashboard-sol";
{
  const observer = observerFor({
    sessionId: DASHBOARD_SOL_SESSION_ID,
    baseRoot: DASHBOARD_BASE,
    provider: fixtureProvider({ probability: 0.62 }).provider,
  });
  observer.start();
  const handle = observer.freezeProposal(proposalFacts({ at: BASE_AT, agentId: "A-DASH-SOL-ENTRY" }));
  observer.recordExecution(handle, ENTRY_EXECUTION);
  const solHandle = observer.observeSolOpportunity(
    solOpportunityInput({ agentId: "A-DASH-SOL-OPP", solScore: 0.9, threshold: 0.4 }),
  );
  observer.recordSolSelection(solHandle, {
    actualSelectedMint: UNSOL_MINT,
    actualSelectedSymbol: "BONK",
    actualSelectedScore: 0.95,
  });
  await settleObserver(observer, { expected: 1, expectedSol: 1, timeoutMs: 8_000 });
  await observer.finalize({ status: "COMPLETE" });
}

await test("dashboard: PS.2a SOL opportunities and unsupported sample are exposed and separated", async () => {
  const block = await loadJevSupervisorObserverState(DASHBOARD_ROOT, { now: () => BASE_AT });
  assertEqual(block.available, true);
  assertEqual(block.sessionId, DASHBOARD_SOL_SESSION_ID, "the newest session wins");
  assertEqual(block.noAuthorityTag, "NO AUTHORITY \u2022 PAPER ONLY");
  assertEqual(block.jevHasTradingAuthority, false);
  assertEqual(block.executedTradeProposals, 1);
  assertEqual(block.solOpportunities, 1);
  assertEqual(block.solActuallySelected, 0);
  assertEqual(block.solNotSelected, 1);
  assertEqual(block.uniqueSolMarketStates, 1);
  assertEqual(block.jevCallsForSolStates, 1);
  assertEqual(block.reusedJevJudgments, 0);
  assertEqual(block.solAgreementCount, 1);
  assertEqual(block.unsupportedProposals, 0);
  assertEqual(block.unsupportedRecentSampleCount, 0);
  assert(Array.isArray(block.unsupportedRecentSample));
  assert(Array.isArray(block.recentRows));
  assert(block.recentRows.some((row) => row.rowKind === "SOL OPPORTUNITY"));
  assert(block.recentRows.some((row) => row.rowKind === "EXECUTED ENTRY"));
  const solRow = block.recentRows.find((row) => row.rowKind === "SOL OPPORTUNITY");
  assertEqual(solRow.executed, false, "a SOL OPPORTUNITY is never presented as an executed trade");
  assertEqual(solRow.solWasActuallySelected, false);
  assertEqual(solRow.actualSelectedSymbol, "BONK");
  assert(Number.isFinite(solRow.solScore));
  assert(Number.isFinite(solRow.agentEntryThreshold));
  assert(Number.isFinite(solRow.scoreMargin));
  assert(Number.isFinite(block.solQueueHighWatermark));
  assert(Number.isFinite(block.solQueueDropped));
  assertEqual(block.winner, null);
  assertEqual(block.supervisorScore, null);
});

/* ============================================================================
 * 7. Settings, fail-closed pins, CLI wiring
 * ==========================================================================*/

await test("settings: bounded duration, one market, forbidden flags are hard errors", () => {
  const defaults = buildSupervisorSettings({});
  assertEqual(defaults.durationMinutes, SUPERVISOR_DEFAULT_DURATION_MINUTES);
  assertEqual(defaults.durationMinutes, 60);
  assertEqual(defaults.marketId, "SOL-USDC");
  assertDeepEqual(defaults.problems, []);
  assertEqual(buildSupervisorSettings({ minutes: "0" }).durationMinutes, SUPERVISOR_DURATION_BOUNDS.min);
  assertEqual(buildSupervisorSettings({ minutes: "99999" }).durationMinutes, SUPERVISOR_DURATION_BOUNDS.max);
  assertEqual(buildSupervisorSettings({ minutes: "nonsense" }).durationMinutes, 60);
  for (const flag of ["threshold", "min-confidence", "trade", "wallet", "sign", "swap", "order", "position-size", "pnl", "profit", "signal", "alpha", "queue-capacity"]) {
    const settings = buildSupervisorSettings({ [flag]: "1" });
    assert(settings.problems.length > 0, `--${flag} must be refused`);
    assertIncludes(settings.problems.join(" "), "not a supervisor observer option");
  }
  assert(buildSupervisorSettings({ market: "BONK-USDC" }).problems.some((entry) => entry.includes("unsupported market")));
  assert(buildSupervisorSettings({ session: "nope" }).problems.some((entry) => entry.includes("invalid --session")));
  assert(buildSupervisorSettings({ bogus: "1" }).problems.some((entry) => entry.includes("unknown option")));
  assert(buildSupervisorSettings({ _: ["stray"] }).problems.some((entry) => entry.includes("positional")));
});

await test("pins: direct TypeSafe accepted, nothing else, and never a fallback", () => {
  const good = resolveJevConfig({ EVOLVE_JEV_PROVIDER: "typesafe-jev", EVOLVE_JEV_API_KEY: "fixture-key" });
  const accepted = enforceSupervisorProviderPins({ envConfig: good });
  assertEqual(accepted.ok, true, accepted.problems.join("; "));
  assertEqual(accepted.provider, "typesafe-jev");
  assertEqual(accepted.model, "jev-1.13.0");
  assertEqual(accepted.cacheEnabled, false);
  assertEqual(accepted.identity.gatewayUsed, false);
  assertEqual(accepted.identity.upstreamProvider, "typesafe-ai");
  const refused = [
    ["missing credential", resolveJevConfig({ EVOLVE_JEV_PROVIDER: "typesafe-jev" })],
    ["mock provider", resolveJevConfig({ EVOLVE_JEV_PROVIDER: "mock-jev" })],
    ["vercel gateway provider", resolveJevConfig({ EVOLVE_JEV_PROVIDER: "vercel-jev", AI_GATEWAY_API_KEY: "fixture" })],
    ["unknown provider", resolveJevConfig({ EVOLVE_JEV_PROVIDER: "gpt-4" })],
    ["unset provider", resolveJevConfig({})],
    ["moving model alias", resolveJevConfig({ EVOLVE_JEV_PROVIDER: "typesafe-jev", EVOLVE_JEV_API_KEY: "fixture", EVOLVE_JEV_MODEL: "jev-latest" })],
    ["wrong pinned model", resolveJevConfig({ EVOLVE_JEV_PROVIDER: "typesafe-jev", EVOLVE_JEV_API_KEY: "fixture", EVOLVE_JEV_MODEL: "jev-1.12.0" })],
    ["failover chain", resolveJevConfig({ EVOLVE_JEV_PROVIDER: "typesafe-jev", EVOLVE_JEV_API_KEY: "fixture", EVOLVE_JEV_TRANSPORT_CHAIN: "vercel-jev,typesafe-jev" })],
  ];
  for (const [label, envConfig] of refused) {
    const verdict = enforceSupervisorProviderPins({ envConfig });
    assertEqual(verdict.ok, false, `${label} must be refused`);
    assert(verdict.problems.length > 0, `${label} must explain itself`);
  }
  const override = enforceSupervisorProviderPins({ envConfig: good, modelOverride: "jev-0.0.1" });
  assertEqual(override.ok, false, "a model override must still be pinned");
  assertEqual(enforceSupervisorProviderPins({}).ok, false);
});

await test("pins: provider identity matrix, fail closed on every mismatch", () => {
  const { provider } = fixtureProvider();
  assertEqual(evaluateSupervisorProviderPins({ provider }).ok, true);
  assertEqual(evaluateSupervisorProviderPins({ provider: null }).ok, false);
  assertEqual(evaluateSupervisorProviderPins({ provider: { ...provider, name: "mock-jev", model: "mock-jev-v1" } }).ok, false);
  assertEqual(evaluateSupervisorProviderPins({ provider: { ...provider, name: "vercel-jev" } }).ok, false);
  assertEqual(evaluateSupervisorProviderPins({ provider: { ...provider, model: "jev-1.12.0" } }).ok, false);
  assertEqual(evaluateSupervisorProviderPins({ provider: { ...provider, gatewayUsed: true } }).ok, false);
  assertEqual(evaluateSupervisorProviderPins({ provider, upstream: "openai" }).ok, false);
  const verdict = evaluateSupervisorProviderPins({ provider: { ...provider, gatewayUsed: true } });
  assert(verdict.problems.some((entry) => entry.includes("gateway")));
  assert(!JSON.stringify(verdict).includes("fixture-key"), "a pin verdict never carries a credential");
});

await test("CLI wiring: fail-closed start, bounded run, non-blocking observer, Ctrl+C finalize", async () => {
  const cli = SOURCE_BY_FILE[path.join("scripts", "jev-supervisor.mjs")];
  assertIncludes(cli, "enforceSupervisorProviderPins");
  assertIncludes(cli, "refusing to start");
  assertIncludes(cli, "process.exitCode = 2");
  assertIncludes(cli, "observer.start();");
  assertExcludes(cli, "await observer.start");
  assertIncludes(cli, "simulationOptions: { proposalObserver: observer }");
  assertIncludes(cli, "onShutdown");
  assertIncludes(cli, "setTimeout");
  assertIncludes(cli, 'signal === "SIGINT" || signal === "SIGTERM" ? "INTERRUPTED" : "COMPLETE"');
  assertIncludes(cli, "await startEngine(");
  assertExcludes(cli, "child_process");
  assertExcludes(cli, "currentPrice");
  assertExcludes(cli, "currentPosition");
});

await test("package scripts and API route / dashboard panel integration", async () => {
  assertEqual(PACKAGE_JSON.scripts["jev:supervisor"], "node scripts/jev-supervisor.mjs");
  assertEqual(PACKAGE_JSON.scripts["validate:jev-supervisor"], "node scripts/validate-phase5i-ps2.mjs");
  assertIncludes(PACKAGE_JSON.scripts["dev:jev-supervisor"], "npm:jev:supervisor");
  assertIncludes(PACKAGE_JSON.scripts["dev:jev-supervisor"], "npm:dev");
  assertIncludes(PACKAGE_JSON.scripts.validate, "validate:jev-supervisor");
  assertIncludes(ROUTE_SOURCE, "loadJevSupervisorObserverState");
  assertIncludes(ROUTE_SOURCE, "{ ...body, jevPaperShadow }");
  assertIncludes(ROUTE_SOURCE, "{ ...composed, jevSupervisorObserver }");
  assertIncludes(PAGE_SOURCE, "jevSupervisorObserver");
  assertIncludes(PAGE_SOURCE, "JEV SUPERVISOR OBSERVER");
  assertIncludes(PAGE_SOURCE, "NO AUTHORITY");
  assertIncludes(PAGE_SOURCE, "Jev observes completed EVOLVE paper decisions.");
  assertIncludes(PAGE_SOURCE, "NOT COMPARABLE");
});

await test("finalization: idempotent, status recorded, bounded and complete summary", async () => {
  const sessionId = "jsup-fixture-finalize";
  const { provider } = fixtureProvider({ probability: 0.5 });
  const observer = observerFor({ sessionId, provider });
  observer.start();
  const handle = observer.freezeProposal(proposalFacts());
  observer.recordExecution(handle, ENTRY_EXECUTION);
  await settleObserver(observer, { expected: 1 });
  const first = await observer.finalize({ status: "COMPLETE" });
  const second = await observer.finalize({ status: "COMPLETE" });
  assertEqual(observer.isFinalized(), true);
  assertEqual(JSON.stringify(second), JSON.stringify(first), "finalize must be idempotent");
  const root = path.join(SESSION_BASE, sessionId);
  const session = await readSupervisorSession(root);
  assertEqual(session.status, "COMPLETE");
  assertEqual(session.finalizeTimedOut, false);
  assertEqual(typeof session.finalizedAt, "string");
  assertEqual(session.gatewayUsed, false);
  assertEqual(session.cacheEnabled, false);
  assertEqual(session.mode, "shadow");
  assertEqual(session.provider, SUPERVISOR_REQUIRED_PROVIDER);
  assertEqual(session.model, SUPERVISOR_REQUIRED_MODEL);
  assertEqual(session.pinsOk, true);
  assertEqual(session.isolation.writesOnlyInsideSessionRoot, true);
  assertEqual(session.isolation.canonicalEvidence, false);
  assertEqual(session.queueCapacity, SUPERVISOR_QUEUE_CAPACITY);
  const summary = await readSupervisorSummary(root);
  for (const key of [
    "proposalsObserved",
    "supportedProposals",
    "unsupportedProposals",
    "directionallyComparable",
    "notDirectionallyComparable",
    "jevCalls",
    "jevOk",
    "jevFailures",
    "agreementCount",
    "disagreementCount",
    "exactHalfCount",
    "entryComparableCount",
    "signalExitComparableCount",
    "stopObservations",
    "takeObservations",
    "timeObservations",
    "meanPHigher",
    "meanDistanceFromHalf",
    "meanLatencyMs",
    "queueHighWatermark",
    "queueDropped",
  ]) {
    assert(Object.hasOwn(summary, key), `summary must expose '${key}'`);
  }
  assertEqual(summary.exactHalfCount, 1);
  assertClose(summary.meanPHigher, 0.5, 1e-9);
  assertClose(summary.meanDistanceFromHalf, 0, 1e-9);
  assertEqual(summary.winner, null);
  assertEqual(summary.noAutomatedWinner, true);
  assertEqual(Object.hasOwn(summary, "supervisorScore"), false, "no supervisor score key may exist at all");
  assertEqual(summary.profitabilityClaim, false);
  assertEqual(summary.policyRecommendationEmitted, false);
  assertEqual(summary.resultDrivenTuningApplied, false);
  assertEqual(summary.confidenceThresholdApplied, false);
  assertEqual(summary.futureOutcomeScoringIncluded, false);
  assertEqual(summary.summaryDigest, supervisorSummaryDigestOf(summary));
  assertEqual(auditNoForbiddenResultFields(summary).ok, true, JSON.stringify(auditNoForbiddenResultFields(summary).problems));
  assertEqual(auditNoForbiddenResultFields(await readSupervisorState(root)).ok, true);
  assertEqual(auditNoForbiddenResultFields(first).ok, true);
});

await test("finalization: an interrupted run records INTERRUPTED and a complete summary", async () => {
  const sessionId = "jsup-fixture-interrupted";
  const { provider } = fixtureProvider({ probability: 0.62 });
  const result = await observeMany({ sessionId, provider, items: [{ facts: proposalFacts() }], status: "INTERRUPTED" });
  assertEqual(result.session.status, "INTERRUPTED");
  assertEqual(result.summary.status, "INTERRUPTED");
  assertEqual(result.summary.finalizedAt !== null, true);
  assertEqual(typeof result.summary.summaryDigest, "string");
});

await test("summary builder is descriptive only and rejects forbidden result keys", () => {
  const summary = buildSupervisorSummary({
    session: { sessionId: "jsup-fixture-summary", provider: "typesafe-jev", model: "jev-1.13.0" },
    counters: { proposalsObserved: 0 },
    aggregates: { pHigherSum: 0, pHigherCount: 0, distanceSum: 0, distanceCount: 0, latencySumMs: 0, latencyCount: 0, providerStatusCounts: {} },
    queue: { highWatermark: 0, dropped: 0 },
  });
  assertEqual(summary.winner, null);
  assertEqual(summary.futureOutcomeScoringIncluded, false);
  assertEqual(Object.hasOwn(summary, "supervisorScore"), false);
  assertEqual(auditNoForbiddenResultFields(summary).ok, true);
  const tainted = { ...summary, pnl: 1 };
  assertEqual(auditNoForbiddenResultFields(tainted).ok, false, "a profitability key must be detectable");
  assertEqual(auditNoForbiddenResultFields({ nested: { recommendation: "deploy" } }).ok, false);
});

/* ============================================================================
 * 8. Capability and locality proofs
 * ==========================================================================*/

await test("no wallet, signing, swap, order-execution, RPC or process capability", async () => {
  // A declaration-shaped DENY list (the same safety-vocabulary exemption the
  // history validator documents): these patterns are the guard, never a
  // capability.
  const FORBIDDEN_CAPABILITY_PATTERNS = [
    /\bKeypair\b/,
    /sendTransaction/,
    /sendRawTransaction/,
    /signTransaction/,
    /signAllTransactions/,
    /VersionedTransaction/,
    /swapTransaction/,
    /partialSign/,
    /fromSecretKey/,
    /child_process/,
    /execSync/,
    /\bspawn\b/,
    /\bfork\b/,
    /detached:/,
    /new\s+Connection/,
  ];
  for (const { file, text } of SUPERVISOR_SOURCES) {
    const hits = FORBIDDEN_CAPABILITY_PATTERNS.filter((pattern) => pattern.test(text));
    assertEqual(hits.length, 0, `${file} must not contain execution capability`);
    const imports = text
      .split("\n")
      .filter((line) => /^\s*(import|const\s+\w+\s*=\s*require)/.test(line))
      .join("\n");
    assertEqual(/solana|web3|jupiter|ethers|viem|@ai-sdk/.test(imports), false, `${file} must not import a chain or execution library`);
  }
  const observerSource = SOURCE_BY_FILE[path.join(SUPERVISOR_DIR, "observer.mjs")];
  assertEqual(/engine\/simulation|engine\/paper|evolve-engine/.test(observerSource), false, "the observer must not import the engine");
});

await test("the simulation tap is passive, synchronous and never awaited", async () => {
  const start = SIMULATION_SOURCE.indexOf("function freezeProposalForObserver");
  const end = SIMULATION_SOURCE.indexOf("// --- Phase 5A: strategy islands");
  assert(start > 0 && end > start, "the tap region must exist");
  const region = SIMULATION_SOURCE.slice(start, end);
  assertExcludes(region, "await", "the tap must never await observer work");
  assertExcludes(region, "Promise", "the tap must never hold a promise");
  assertIncludes(region, "catch", "a throwing observer must be contained");
  assertEqual(/jev/i.test(SIMULATION_SOURCE), false, "the engine must not even name Jev (Phase 5D check 63)");
  assertIncludes(SIMULATION_SOURCE, "const exitHandle = freezeProposalForObserver(");
  assertIncludes(SIMULATION_SOURCE, "const entryHandle = freezeProposalForObserver(");
  const entryFreeze = SIMULATION_SOURCE.indexOf("const entryHandle = freezeProposalForObserver(");
  const entryFill = SIMULATION_SOURCE.indexOf("const fill = simulateEntry(", entryFreeze);
  assert(entryFreeze > 0 && entryFill > entryFreeze, "the entry proposal must be frozen BEFORE paper execution");
  const exitFreeze = SIMULATION_SOURCE.indexOf("const exitHandle = freezeProposalForObserver(");
  const exitFill = SIMULATION_SOURCE.indexOf("const fill = simulateExit(", exitFreeze);
  assert(exitFreeze > 0 && exitFill > exitFreeze, "the exit proposal must be frozen BEFORE paper execution");
  const engineSource = await readFile(path.join("scripts", "evolve-engine.mjs"), "utf8");
  assertIncludes(engineSource, "simulationOptions = null");
  assertIncludes(engineSource, "onShutdown = null");
  assertIncludes(engineSource, "stop: (reason = \"STOP\") => shutdown(reason)");
  assertIncludes(engineSource, "process.once(\"SIGINT\"");
});

await test("storage guard: the observer can never write into a protected tree", async () => {
  for (const root of SUPERVISOR_FORBIDDEN_WRITE_ROOTS) {
    await assertRejects(() => ensureSupervisorDir(path.join(root, "ps2-intruder-session"), root), /protected tree/);
  }
  const ok = await ensureSupervisorDir(path.join(SESSION_BASE, "jsup-fixture-guard"), SESSION_BASE);
  assertEqual(ok.startsWith(SESSION_BASE), true);
  const sibling = await ensureSupervisorDir(path.join(SESSION_BASE, "jsup-fixture-guard-2"), SESSION_BASE);
  assertEqual(sibling.endsWith("jsup-fixture-guard-2"), true);
});

await test("session artifacts never contain a credential or a raw provider payload", async () => {
  const root = path.join(SESSION_BASE, "jsup-fixture-entry");
  for (const file of ["session.json", "proposals.ndjson", "judgments.ndjson", "state.json", "summary.json"]) {
    const text = await readFile(path.join(root, file), "utf8");
    for (const forbidden of ["apiKey", "authorization", "EVOLVE_JEV_API_KEY", FAKE_SECRET, "rawResponse"]) {
      assertExcludes(text, forbidden, `${file} must not contain '${forbidden}'`);
    }
  }
  assertEqual(NETWORK_ATTEMPTS, 0, "the whole suite must stay offline");
});

/* ============================================================================
 * 9. Preservation: canonical 5I, temporal, Paper Shadow, forensics, trees
 * ==========================================================================*/

await test("preservation: canonical Phase 5I tree + sealed sessions byte-identical", async () => {
  const after = await snapshotPreservationTargets({ sessionId: PAPER_SHADOW_SESSION_ID });
  const proof = preservationProof({ before: PRESERVATION_BEFORE, after });
  assertEqual(proof.ok, true, JSON.stringify({ source: proof.sourceSession, canonical: proof.canonicalTree, sealed: proof.sealedSessions }));
  assertEqual(proof.sourceSession.identical, true);
  assertEqual(proof.canonicalTree.identical, true);
  assertEqual(proof.sealedSessions.length, 2);
  assertEqual(proof.sealedSessionsUntouched, true);
  for (const sealed of proof.sealedSessions) {
    assertEqual(sealed.present, true, `${sealed.id} (${sealed.label}) must still be present`);
    assertEqual(sealed.unchanged, true, `${sealed.id} must be untouched`);
  }
  assertIncludes(proof.sealedSessions[0].id, "jrep-20260920T090716Z-97c862");
  assertIncludes(proof.sealedSessions[1].id, "jtrp-20260920T151033Z-f1c16a");
});

await test("preservation: Paper Shadow, forensics, shadow and arena trees byte-identical", async () => {
  const comparisons = {
    paperShadow: compareSnapshots(TREES_BEFORE.paperShadow, await snapshotTree(PAPER_SHADOW_ROOT_DIR)),
    forensics: compareSnapshots(TREES_BEFORE.forensics, await snapshotTree(PAPER_FORENSICS_ROOT_DIR)),
    shadow: compareSnapshots(TREES_BEFORE.shadow, await snapshotTree(path.join(".evolve", "shadow"))),
    arenas: compareSnapshots(TREES_BEFORE.arenas, await snapshotTree(path.join(".evolve", "arenas"))),
  };
  for (const [label, comparison] of Object.entries(comparisons)) {
    assertEqual(comparison.identical, true, `${label}: ${JSON.stringify(comparison)}`);
  }
});

await test("preservation: supervisor tree byte-identical and run-1 session preserved", async () => {
  const after = await snapshotTree(SUPERVISOR_ROOT_DIR);
  const comparison = compareSnapshots(TREES_BEFORE.supervisor, after);
  assertEqual(comparison.identical, true, `the supervisor tree must be untouched: ${JSON.stringify(comparison)}`);
  const sessionsAfter = await listSupervisorSessions(SUPERVISOR_ROOT_DIR);
  assertDeepEqual(sessionsAfter, SUPERVISOR_SESSIONS_BEFORE, "validation must not create or remove a supervisor session");
  // The first live PS.2 session must survive byte-for-byte, including its
  // original (now-fixed) instrumentation bugs.
  if (SUPERVISOR_SESSIONS_BEFORE.includes("jsup-20260921T093854Z-16c76b")) {
    const root = path.join(SUPERVISOR_ROOT_DIR, "jsup-20260921T093854Z-16c76b");
    const summary = await readSupervisorSummary(root);
    assertEqual(summary.sessionId, "jsup-20260921T093854Z-16c76b");
    assertEqual(summary.schemaVersion, 1, "run #1 keeps its original schema version");
    assertEqual(summary.unsupportedProposals, 42311, "run #1 is preserved, never rewritten");
    assertEqual(summary.lastProposalAt, null, "run #1's original summary is preserved byte-for-byte");
  }
});

/* ============================================================================
 * Report
 * ==========================================================================*/

await rm(WORKSPACE, { recursive: true, force: true }).catch(() => {});

console.log(`\n${SUPERVISOR_LABEL} (Phase ${SUPERVISOR_PHASE}) — ${SUPERVISOR_NO_AUTHORITY_TAG}`);
console.log(`  ${PASSED} passed, ${FAILED} failed${FAILED > 0 ? "" : " — Jev has zero authority"}`);
if (FAILED > 0) {
  for (const failure of FAILURES) console.log(`  FAILED: ${failure.name}`);
}
// A deliberately hard exit: an observer worker parked on an injected sleep must
// never keep the validation process (or CI) alive.
process.exit(FAILED === 0 ? 0 : 1);

