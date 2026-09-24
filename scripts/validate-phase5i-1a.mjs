#!/usr/bin/env node
/**
 * EVOLVE Phase 5I.1a validation suite — FULLY OFFLINE.
 *
 * TEMPORAL REPLICATION EXTENSION of the frozen Phase 5I.0b direct-TypeSafe Jev
 * short-horizon directional protocol.
 *
 * The suite proves, without any network call, any provider, any credential and
 * without writing a single byte under the real `.evolve` tree:
 *
 *   A  the frozen temporal contract and protocol-digest PRESERVATION
 *   B  the temporal manifest is SEPARATE and never touches the canonical wave
 *   C  the canonical Phase 5I.1 result is byte-unchanged and independently
 *      reproducible (manifest digest, aggregate digest, sessionRecordsDigest)
 *   D  the temporal session evidence class + unchanged predictive semantics
 *   E  the STRICTER temporal-independence rules, one case each
 *   F  wave sequencing: fewer than 3 CLEAN reports insufficient; exactly 3 CLEAN
 *      completes the temporal extension; violations are preserved
 *   G  the aggregate is equal-weighted by CLEAN session and never pools
 *      observations; the bootstrap is the SAME deterministic session-level one
 *   H  the combined descriptive view (canonical 3 + temporal 3 = 6)
 *   I  zero network / zero launch for every replay and stats pass
 *   J  isolation: no money path, no trading logic, no JevCache in the predictive
 *      path, no winner field, no promotion, single asset only
 *   K  CLI behaviour, including the `--temporal-session` pre-run guards
 *
 * Run with: npm run validate:phase5i1a
 */

import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { canonicalJson, digestOf } from "./lib/hash.mjs";
import { createMarketConfig } from "./market/config.mjs";
import {
  BASELINE_DEFINITION_DIGEST,
  BASELINE_DEFINITION_VERSION,
} from "./jev/direction/baselines.mjs";
import {
  BENCHMARK_MARKET,
  DEFAULT_OUTCOME_RESOLUTION_POLICY,
  DIRECTION_EVIDENCE_CLASS,
  DIRECTION_EXPERIMENTS_DIR,
  DIRECTION_PHASE,
  DIRECTION_ROOT_DIR,
  HORIZON_SECONDS,
  RECOMMENDED_ENDPOINT_ORDER,
  REFERENCE_PRICE_DEFINITION_DIGEST,
  REQUIRED_MODEL,
  REQUIRED_PROVIDER,
  REQUIRED_UPSTREAM_PROVIDER,
  STALENESS_POLICY_DIGEST,
  isReplicationAction,
  isTemporalAction,
  resolveDirectionAction,
} from "./jev/direction/definition.mjs";
import {
  DIRECTION_FEATURE_DEFINITION_DIGEST,
  DIRECTION_FEATURE_DEFINITION_VERSION,
} from "./jev/direction/features.mjs";
import {
  DIRECTION_METRIC_DEFINITION_DIGEST,
  DIRECTION_METRICS_VERSION,
  auditNoProfitabilityFields,
} from "./jev/direction/metrics.mjs";
import {
  DIRECTION_QUESTION_SET_ID,
  DIRECTION_QUESTION_SET_VERSION,
  buildDirectionQuestions,
  directionQuestionDigest,
} from "./jev/direction/questions.mjs";
import { DIRECTION_PACKET_KIND, DIRECTION_PACKET_VERSION } from "./jev/direction/packet.mjs";
import { createDirectionFixtureProvider } from "./jev/direction/fixture-provider.mjs";
import { buildDirectionRunSettings } from "./jev/direction/settings.mjs";
import { createJevRunBudget } from "./jev/runtime.mjs";
import {
  directionExperimentRootFor,
  readDirectionExperimentBundle,
} from "./jev/direction/storage.mjs";
import { createSolDirectionObservationSource } from "./jev/direction/observation.mjs";
import { replayDirectionExperiment, runDirectionBenchmark } from "./jev/direction/runner.mjs";
import {
  DIRECTION_REPLICATION_ROOT_DIR,
  REPLICATION_PROTOCOL_CONTRACT,
  REPLICATION_PROTOCOL_DIGEST,
  REPLICATION_SOURCE_GUARD,
  protocolDigestOfExperiment,
  verifyReplicationProtocol,
  verifyReplicationSourceGuard,
} from "./jev/direction/replication/protocol.mjs";
import {
  aggregateDigestOf as replicationAggregateDigestOf,
  readReplicationBundle,
} from "./jev/direction/replication/manifest.mjs";
import { replicationReplay } from "./jev/direction/replication/runner.mjs";
import {
  REPLICATION_EVIDENCE_CLASS,
  TEMPORAL_REPLICATION_EVIDENCE_CLASS,
  TEMPORAL_REPLICATION_EVIDENCE_PROFILE,
} from "./jev/direction/evidence.mjs";
import {
  CANONICAL_REPLICATION_BARRIER,
  DIRECTION_TEMPORAL_ROOT_DIR,
  REQUIRED_CLEAN_TEMPORAL_SESSIONS,
  TEMPORAL_FORBIDDEN_SELECTION_FIELDS,
  TEMPORAL_INDEPENDENCE_RULES,
  TEMPORAL_INFERENCE_UNIT,
  TEMPORAL_MINIMUM_GAP_MS,
  TEMPORAL_PHASE,
  TEMPORAL_PROTOCOL_DIGEST,
  TEMPORAL_SELECTION_RULES,
  TEMPORAL_SESSION_CADENCE_SECONDS,
  TEMPORAL_SESSION_OBSERVATIONS,
  auditTemporalTimingSelection,
  utcDateOf,
  verifyTemporalManifest,
} from "./jev/direction/temporal/protocol.mjs";
import {
  TEMPORAL_COMPLETE_STATE,
  TEMPORAL_INSUFFICIENT_STATE,
  aggregateTemporalSessions,
  buildCombinedDescriptiveView,
} from "./jev/direction/temporal/aggregate.mjs";
import {
  TEMPORAL_PROTECTED_EXPERIMENT_IDS,
  SESSION_STATUS,
  evaluateTemporalSession,
  protectedTemporalExperimentReason,
} from "./jev/direction/temporal/eligibility.mjs";
import {
  aggregateDigestOf,
  createTemporalManifest,
  createTemporalSessionsDocument,
  isValidTemporalId,
  manifestDigestOf,
  readTemporalManifest,
  readTemporalSessions,
  temporalIdFor,
  temporalMetadataSnapshot,
  temporalRootFor,
} from "./jev/direction/temporal/manifest.mjs";
import {
  temporalAdd,
  temporalCreate,
  temporalReplay,
  temporalStats,
} from "./jev/direction/temporal/runner.mjs";
import {
  REPLICATION_BOOTSTRAP_ALPHA,
  REPLICATION_BOOTSTRAP_PRNG,
  REPLICATION_BOOTSTRAP_RESAMPLES,
  REPLICATION_BOOTSTRAP_SEED,
  REPLICATION_BOOTSTRAP_STATE,
  mulberry32,
} from "./jev/direction/replication/aggregate.mjs";

const REPO = process.cwd();
const REAL_DIRECTION_ROOT = path.join(REPO, DIRECTION_ROOT_DIR);
const REAL_EXPERIMENTS_ROOT = path.join(REPO, DIRECTION_EXPERIMENTS_DIR);
const REAL_REPLICATION_ROOT = path.join(REPO, DIRECTION_REPLICATION_ROOT_DIR);

const CANONICAL_DEVELOPMENT_EXPERIMENT_ID = "jdir-20260920T063311Z-3a9163";
const CANONICAL_DEV_METRICS_DIGEST = "984cc26dd9f247dbd625dc8c7bfb07d82600ed9a353fe7ef2bba423cc79f29ba";

/* ============================================================================
 * Test harness
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
  assertTrue(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${message} (expected ~${expected}, got ${actual})`);
}
function assertIncludes(haystack, needle, message) {
  if (!String(haystack).includes(needle)) fail(`${message} (looked for ${JSON.stringify(needle)})`);
}
function assertExcludes(haystack, needle, message) {
  if (String(haystack).includes(needle)) fail(`${message} (found ${JSON.stringify(needle)})`);
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
 * Offline market fixture (identical shape to the Phase 5I.0b harness)
 * ==========================================================================*/

const FIXTURE_T0 = Date.parse("2026-09-20T00:00:00.000Z");
const FIXTURE_CYCLE_MS = 30_000;
const FIXTURE_PRICES = Object.freeze([100.0, 100.0, 100.5, 99.0, 99.0, 100.2, 98.5, 100.2, 99.9]);

function fixturePriceAt(clockMs, prices = FIXTURE_PRICES, t0 = FIXTURE_T0) {
  const step = Math.max(0, Math.floor((clockMs - t0) / FIXTURE_CYCLE_MS));
  return prices[Math.min(step, prices.length - 1)];
}

function fixtureSolToken(price) {
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
  };
}

const FIXTURE_NOISE_TOKEN = {
  id: "SomeOtherMint111111111111111111111111111111",
  symbol: "NOISE",
  usdPrice: 0.5,
  liquidity: 30_000,
  stats5m: { priceChange: 0.2, buyVolume: 10, sellVolume: 12, numBuys: 3, numSells: 4 },
};

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

function createFixtureHarness({ t0 = FIXTURE_T0, prices = FIXTURE_PRICES, solOnAllEndpoints = false } = {}) {
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
    return { status: 200, async json() { return tokens; } };
  };
  const config = createMarketConfigForFixture();
  // The fixture observation source is constructed through the SAME factory the
  // real CLI uses; only `fetchImpl`/`now`/`sleep` are injected.
  const source = createSolDirectionObservationSource({ config, fetchImpl, now, sleep });
  return { shared, now, sleep, fetchImpl, config, source, t0, prices };
}

const FIXTURE_PIN_RESULT = Object.freeze({
  resolution: Object.freeze({ provider: "mock-jev" }),
  model: "direction-fixture-jev-v1",
  identity: Object.freeze({ upstreamProvider: "evolve-mock", gatewayUsed: false, transport: "offline" }),
  questionDigest: directionQuestionDigest(),
  offlineFixture: true,
  providerImplementation: "direction-fixture-jev-v1",
  observationEndpoints: RECOMMENDED_ENDPOINT_ORDER,
});

const TEMPORAL_FIXTURE_PIN_RESULT = Object.freeze({
  resolution: Object.freeze({ provider: REQUIRED_PROVIDER }),
  model: REQUIRED_MODEL,
  identity: Object.freeze({ upstreamProvider: REQUIRED_UPSTREAM_PROVIDER, gatewayUsed: false, transport: "offline-fixture" }),
  questionDigest: directionQuestionDigest(),
  offlineFixture: false,
  providerImplementation: REQUIRED_PROVIDER,
  observationEndpoints: RECOMMENDED_ENDPOINT_ORDER,
});

const FIXTURE_SETTINGS_OVERRIDES = Object.freeze({
  market: "SOL-USDC",
  "cadence-seconds": "30",
  "tolerance-ms": "10000",
  "max-runtime-minutes": "90",
});

function createTemporalFixtureProvider() {
  const base = createDirectionFixtureProvider();
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

async function runFixtureExperiment({
  root,
  experimentId,
  harness,
  maxObservations,
  provider,
  extraSettings = {},
  pinResult = TEMPORAL_FIXTURE_PIN_RESULT,
  evidenceProfile = "temporal",
}) {
  const settings = buildDirectionRunSettings({
    ...FIXTURE_SETTINGS_OVERRIDES,
    "max-observations": String(maxObservations),
    ...extraSettings,
  });
  const result = await runDirectionBenchmark({
    action: "start",
    settings,
    provider,
    source: harness.source,
    baseRoot: root,
    now: harness.now,
    sleep: harness.sleep,
    control: { stopped: false },
    onProgress: () => {},
    budget: createJevRunBudget(maxObservations),
    questions: buildDirectionQuestions(),
    experimentId,
    pinResult,
    evidenceProfile,
  });
  return result;
}

/* ============================================================================
 * The temporal fixture plan (temp tree only)
 *
 * Timestamps are CONSTRUCTED from a calendar schedule, never from a view on
 * performance or on SOL: the three CLEAN sessions simply fall on three different
 * UTC dates, more than six hours apart, after the canonical wave completed.
 * ==========================================================================*/

const TEMPORAL_FIXTURE_PLAN = Object.freeze([
  // FIXTURE CLOCK NOTE:
  // `runner.mjs` intentionally persists summary.finalizedAt using the real
  // wall clock, while these offline fixtures inject deterministic session
  // clocks. Synthetic temporal-independence fixtures therefore use a fixed
  // far-future epoch so advancing wall-clock time cannot alter their gap/date
  // classification. Fixtures that intentionally overlap pinned development
  // or canonical evidence remain on their real 2026 windows.
  // --- temporal-independence violations ----------------------------------------
  { experimentId: "jdir-tfx-dev-overlap", t0: "2026-09-20T06:45:00.000Z", seed: 101, expect: "CONTAMINATED", rule: "development overlap" },
  { experimentId: "jdir-tfx-canonical-overlap", t0: "2026-09-20T12:30:00.000Z", seed: 102, expect: "CONTAMINATED", rule: "canonical-wave overlap" },
  // An overlapping pair: the first is CLEAN when added, the second contaminates BOTH.
  { experimentId: "jdir-tfx-overlap-a", t0: "2099-09-29T02:00:00.000Z", seed: 103, expect: "CONTAMINATED", addAsClean: true, rule: "session overlap" },
  { experimentId: "jdir-tfx-overlap-b", t0: "2099-09-29T02:20:00.000Z", seed: 104, expect: "CONTAMINATED", rule: "session overlap" },
  // A same-UTC-date pair with a >= 6 h gap: isolates the different-date rule.
  { experimentId: "jdir-tfx-date-a", t0: "2099-09-27T00:30:00.000Z", seed: 105, expect: "CONTAMINATED", addAsClean: true, rule: "same UTC date" },
  { experimentId: "jdir-tfx-date-b", t0: "2099-09-27T09:00:00.000Z", seed: 106, expect: "CONTAMINATED", rule: "same UTC date" },
  // Served by the DEVELOPMENT fixture provider and labelled development evidence.
  { experimentId: "jdir-tfx-develop", t0: "2099-09-26T12:00:00.000Z", seed: 107, development: true, expect: "INELIGIBLE", rule: "development evidence" },
  // --- the three CLEAN temporal-extension sessions ------------------------------
  { experimentId: "jdir-tfx-clean-1", t0: "2099-09-22T22:00:00.000Z", seed: 108, expect: "CLEAN" },
  // A different UTC date but only ~1.5 h after clean-1 completed: isolates the gap rule.
  { experimentId: "jdir-tfx-gap", t0: "2099-09-23T01:00:00.000Z", seed: 109, expect: "CONTAMINATED", rule: "minimum gap" },
  { experimentId: "jdir-tfx-clean-2", t0: "2099-09-24T09:00:00.000Z", seed: 110, expect: "CLEAN" },
  { experimentId: "jdir-tfx-clean-3", t0: "2099-09-25T18:00:00.000Z", seed: 111, expect: "CLEAN" },
]);

/** The order sessions are ADDED, chosen so the gap rule has a previous eligible session. */
const TEMPORAL_ADD_ORDER = Object.freeze([
  "jdir-tfx-dev-overlap",
  "jdir-tfx-canonical-overlap",
  "jdir-tfx-overlap-a",
  "jdir-tfx-overlap-b",
  "jdir-tfx-date-a",
  "jdir-tfx-date-b",
  "jdir-tfx-develop",
  "jdir-tfx-clean-1",
  "jdir-tfx-gap",
  "jdir-tfx-clean-2",
  "jdir-tfx-clean-3",
]);

const ctx = {
  tempRoot: null,
  experimentsRoot: null,
  temporalRoot: null,
  expectedPins: null,
  before: {},
  after: {},
  fixtures: new Map(),
  created: null,
  added: [],
  errors: [],
};

async function buildFixtures() {
  ctx.tempRoot = await mkdtemp(path.join(tmpdir(), "phase5i-1a-"));
  ctx.experimentsRoot = path.join(ctx.tempRoot, "temporal-experiments");
  ctx.temporalRoot = path.join(ctx.tempRoot, "temporal");
  // The pins a temporal session is checked against — derived EXACTLY like
  // `--temporal-create` derives them, from the frozen protocol contract.
  ctx.expectedPins = createTemporalManifest({ temporalId: "jtrp-expected-pins" }).expected;

  for (const plan of TEMPORAL_FIXTURE_PLAN) {
    const t0 = Date.parse(plan.t0);
    const prices = buildFixturePriceSchedule({ seed: plan.seed, start: 100 + plan.seed });
    const harness = createFixtureHarness({ t0, prices });
    const development = plan.development === true;
    const result = await runFixtureExperiment({
      root: ctx.experimentsRoot,
      experimentId: plan.experimentId,
      harness,
      maxObservations: TEMPORAL_SESSION_OBSERVATIONS,
      provider: development ? createDirectionFixtureProvider() : createTemporalFixtureProvider(),
      extraSettings: development ? {} : { "temporal-session": true },
      pinResult: development ? FIXTURE_PIN_RESULT : TEMPORAL_FIXTURE_PIN_RESULT,
      evidenceProfile: development ? null : "temporal",
    });
    if (!result.ok) throw new Error(`fixture ${plan.experimentId} failed: ${result.error ?? "unknown"}`);
    const bundle = await readDirectionExperimentBundle(directionExperimentRootFor(ctx.experimentsRoot, plan.experimentId));
    ctx.fixtures.set(plan.experimentId, { plan, t0, result, bundle });
  }
}

async function disposeFixtures() {
  if (ctx.tempRoot) await rm(ctx.tempRoot, { recursive: true, force: true }).catch(() => {});
}

function fixture(experimentId) {
  const entry = ctx.fixtures.get(experimentId);
  if (!entry) throw new Error(`no fixture ${experimentId}`);
  return entry;
}

/** The session-record shape one fixture would contribute to a temporal wave. */
async function temporalEntryFor(experimentId, otherSessions = []) {
  const derived = await deriveFixture(experimentId, otherSessions);
  return {
    sessionId: experimentId,
    status: derived.eligibility.status,
    windowMs: derived.eligibility.timing.windowMs,
    timing: derived.eligibility.timing,
  };
}

let statsCache = null;
/** The read-only stats pass, memoized (the wave is frozen from F1 onward). */
async function cachedTemporalStats() {
  if (statsCache === null) {
    statsCache = await temporalStats({
      temporalRoot: ctx.temporalRoot,
      baseRoot: ctx.experimentsRoot,
      canonicalRoot: REAL_REPLICATION_ROOT,
      temporalId: ctx.created.temporalId,
    });
  }
  return statsCache;
}

async function deriveFixture(experimentId, otherSessions = []) {
  const entry = fixture(experimentId);
  const replay = await replayDirectionExperiment({ experimentId, baseRoot: ctx.experimentsRoot });
  const protocol = verifyReplicationProtocol(entry.bundle.experiment);
  const expected = ctx.expectedPins;
  const eligibility = evaluateTemporalSession({
    sessionId: experimentId,
    experiment: entry.bundle.experiment,
    summary: entry.bundle.summary,
    predictions: entry.bundle.predictions,
    outcomes: entry.bundle.outcomes,
    replay,
    protocol,
    expected,
    otherSessions,
  });
  return { entry, replay, protocol, eligibility };
}

function evaluateMutated({ experimentId, mutate = {}, protocol = null, otherSessions = [] }) {
  const entry = fixture(experimentId);
  const experiment = { ...entry.bundle.experiment, ...(mutate.experiment ?? {}) };
  return evaluateTemporalSession({
    sessionId: experimentId,
    experiment,
    summary: { ...entry.bundle.summary, ...(mutate.summary ?? {}) },
    predictions: entry.bundle.predictions,
    outcomes: entry.bundle.outcomes,
    replay: mutate.replay ?? null,
    protocol: protocol ?? verifyReplicationProtocol(experiment),
    expected: ctx.expectedPins,
    otherSessions,
  });
}

/* ============================================================================
 * PART A — the frozen temporal contract and protocol-digest PRESERVATION
 * ==========================================================================*/

test("A1. the temporal extension is Phase 5I.1a and re-uses the frozen protocol digest verbatim", () => {
  assertEqual(TEMPORAL_PHASE, "5I.1a", "the phase id");
  assertEqual(DIRECTION_PHASE, "5I.0b", "the underlying protocol phase is unchanged");
  assertEqual(
    REPLICATION_PROTOCOL_DIGEST,
    "1cc0661cf207d861e9809b3374ff70ce3a6434a7b49acc17598d5928935a5fb3",
    "the frozen Phase 5I.1 protocol digest is unchanged",
  );
  assertEqual(TEMPORAL_PROTOCOL_DIGEST, REPLICATION_PROTOCOL_DIGEST, "the temporal extension uses the SAME digest");
  assertEqual(TEMPORAL_PROTOCOL_DIGEST.length, 64, "a SHA-256 hex digest");
  assertEqual(TEMPORAL_SESSION_OBSERVATIONS, 120, "120 observations per session");
  assertEqual(TEMPORAL_SESSION_CADENCE_SECONDS, 30, "a 30-second cadence");
  assertEqual(HORIZON_SECONDS, 30, "a 30-second horizon");
  assertEqual(REQUIRED_CLEAN_TEMPORAL_SESSIONS, 3, "exactly 3 CLEAN temporal sessions");
  assertEqual(TEMPORAL_INFERENCE_UNIT, "dataset/session", "the primary inference unit is the session");
});

test("A2. the temporal independence and selection rules are FROZEN in source", () => {
  assertEqual(TEMPORAL_INDEPENDENCE_RULES.distinctUtcCalendarDatePerSession, true, "one session per UTC date");
  assertEqual(TEMPORAL_INDEPENDENCE_RULES.minimumGapFromPreviousEligibleSessionMs, TEMPORAL_MINIMUM_GAP_MS, "the gap rule");
  assertEqual(TEMPORAL_MINIMUM_GAP_MS, 6 * 60 * 60 * 1000, "the gap is 6 hours");
  assertEqual(TEMPORAL_INDEPENDENCE_RULES.requiresNoDevelopmentOverlap, true, "no development overlap");
  assertEqual(TEMPORAL_INDEPENDENCE_RULES.requiresNoCanonicalReplicationOverlap, true, "no canonical-wave overlap");
  assertEqual(TEMPORAL_INDEPENDENCE_RULES.requiresNoTemporalExtensionOverlap, true, "no temporal-session overlap");
  assertEqual(TEMPORAL_INDEPENDENCE_RULES.violationPreservedNeverSilentlyExcluded, true, "violations are preserved");
  assertEqual(TEMPORAL_SELECTION_RULES.selectionBasis, "calendar-schedule", "timing is a calendar schedule");
  assertEqual(TEMPORAL_SELECTION_RULES.timingNotSelectedFromObservedPerformance, true, "not selected on Jev performance");
  assertEqual(TEMPORAL_SELECTION_RULES.timingNotSelectedFromMarketView, true, "not selected on a SOL view");
  assertEqual(TEMPORAL_SELECTION_RULES.noFavorablePerformanceConditioning, true, "no favorable-performance conditioning");
  assertEqual(TEMPORAL_SELECTION_RULES.noBullishBearishVolatilityConditioning, true, "no bullish/bearish/volatility conditioning");
  assertEqual(TEMPORAL_SELECTION_RULES.noPromotionToPhase5I2, true, "no automatic promotion to 5I.2");
  assertEqual(auditTemporalTimingSelection({ selectionBasis: "calendar-schedule", timingNotSelectedFromObservedPerformance: true, timingNotSelectedFromMarketView: true }).ok, true, "a correct declaration audits clean");
  assertEqual(auditTemporalTimingSelection({ selectionBasis: "when-jevs-brier-looked-good", timingNotSelectedFromObservedPerformance: true, timingNotSelectedFromMarketView: true }).ok, false, "any other basis is refused");
  assertEqual(auditTemporalTimingSelection({ selectionBasis: "calendar-schedule", timingNotSelectedFromObservedPerformance: false, timingNotSelectedFromMarketView: true }).ok, false, "a performance-conditioned declaration is refused");
  const poisoned = auditTemporalTimingSelection({ selectionBasis: "calendar-schedule", timingNotSelectedFromObservedPerformance: true, timingNotSelectedFromMarketView: true, bullish: true });
  assertEqual(poisoned.ok, false, "a market-view field is refused");
  assertTrue(TEMPORAL_FORBIDDEN_SELECTION_FIELDS.includes("bullish"), "bullish is a forbidden selection field");
  assertTrue(TEMPORAL_FORBIDDEN_SELECTION_FIELDS.includes("volatilityPick"), "volatility picks are forbidden");
});

test("A3. the canonical Phase 5I.1 barrier is pinned and its source guard still holds", () => {
  assertEqual(CANONICAL_REPLICATION_BARRIER.replicationId, "jrep-20260920T090716Z-97c862", "the canonical replication id");
  assertEqual(CANONICAL_REPLICATION_BARRIER.cleanSessionCount, 3, "3/3 CLEAN canonical sessions");
  assertDeepEqual(
    CANONICAL_REPLICATION_BARRIER.cleanSessionIds,
    ["jdir-20260920T090716Z-3a9163", "jdir-20260920T104154Z-3a9163", "jdir-20260920T121446Z-3a9163"],
    "the canonical session ids",
  );
  assertEqual(CANONICAL_REPLICATION_BARRIER.developmentExperimentId, CANONICAL_DEVELOPMENT_EXPERIMENT_ID, "the canonical development experiment");
  assertEqual(CANONICAL_REPLICATION_BARRIER.developmentMetricsDigest, CANONICAL_DEV_METRICS_DIGEST, "and its metrics digest");
  assertEqual(CANONICAL_REPLICATION_BARRIER.protocolDigest, REPLICATION_PROTOCOL_DIGEST, "the canonical wave's protocol digest");
  assertEqual(CANONICAL_REPLICATION_BARRIER.aggregateMetricsDigest.length, 64, "the aggregate digest is pinned");
  assertEqual(CANONICAL_REPLICATION_BARRIER.sessionRecordsDigest.length, 64, "the session-records digest is pinned");
  assertEqual(CANONICAL_REPLICATION_BARRIER.manifestContentDigest.length, 64, "the manifest digest is pinned");
  assertEqual(verifyReplicationSourceGuard().ok, true, "the frozen source guard still holds (no protocol tune)");
  assertEqual(REPLICATION_SOURCE_GUARD.horizonSeconds, 30, "the guard pins the horizon");
  assertEqual(REPLICATION_SOURCE_GUARD.resolutionToleranceMs, 10_000, "and the outcome tolerance");
  assertEqual(REPLICATION_SOURCE_GUARD.thresholdBound, null, "and no threshold bound");
});

test("A4. utcDateOf and the gap helper are pure and exact", () => {
  assertEqual(utcDateOf("2026-09-22T22:00:00.000Z"), "2026-09-22", "a UTC date is derived in UTC");
  assertEqual(utcDateOf(Date.parse("2026-09-23T00:00:00.000Z")), "2026-09-23", "a millisecond instant works too");
  assertEqual(utcDateOf("not-a-date"), null, "an unparseable instant has no date");
  assertEqual(utcDateOf(null), null, "and neither does an absent one");
});

/* ============================================================================
 * PART B — the temporal manifest is SEPARATE
 * ==========================================================================*/

test("B1. temporal-create writes a manifest in its OWN tree, separate from the canonical wave", async () => {
  const result = await temporalCreate({
    temporalRoot: ctx.temporalRoot,
    canonicalRoot: REAL_REPLICATION_ROOT,
  });
  assertEqual(result.ok, true, `temporal-create succeeded: ${result.error ?? ""}`);
  assertEqual(result.temporalId.startsWith("jtrp-"), true, `the id is a temporal id (${result.temporalId})`);
  assertEqual(isValidTemporalId(result.temporalId), true, "the id is valid");
  assertEqual(isValidTemporalId("jrep-20260920T090716Z-97c862"), false, "a replication id is not a temporal id");
  assertEqual(isValidTemporalId("jdir-20260920T063311Z-3a9163"), false, "a jdir id is not a temporal id");
  assertEqual(result.root.startsWith(ctx.temporalRoot), true, "the manifest lives in the temporal tree");
  assertEqual(result.root.startsWith(path.join(REPO, ".evolve")), false, "and NOT under the real .evolve tree");
  assertEqual(DIRECTION_TEMPORAL_ROOT_DIR !== DIRECTION_REPLICATION_ROOT_DIR, true, "the two trees are distinct paths");
  assertEqual(result.launchedSessions, 0, "temporal-create launched nothing");
  assertEqual(result.networkCalls, 0, "and made zero network calls");
  assertEqual(result.status, TEMPORAL_INSUFFICIENT_STATE, "a wave with no sessions is insufficient");
  ctx.created = result;

  const manifest = await readTemporalManifest(temporalRootFor(ctx.temporalRoot, result.temporalId));
  assertEqual(manifest.artifactKind, "DIRECTION_TEMPORAL_EXTENSION_MANIFEST", "the artifact kind is the temporal one");
  assertEqual(manifest.phase, TEMPORAL_PHASE, "the manifest declares 5I.1a");
  assertEqual(manifest.evidenceClass, TEMPORAL_REPLICATION_EVIDENCE_CLASS, "and the temporal evidence class");
  assertEqual(manifest.temporalExtensionOnly, true, "temporalExtensionOnly");
  assertEqual(manifest.replicationOnly, true, "and replicationOnly");
  assertEqual(manifest.developmentOnly, false, "but not developmentOnly");
  assertEqual(manifest.protocolDigest, TEMPORAL_PROTOCOL_DIGEST, "the SAME protocol digest");
  assertEqual(manifest.protocolUnchangedFromReplication, true, "declared unchanged from Phase 5I.1");
  assertEqual(manifest.manifestContentDigest, manifestDigestOf(manifest), "the manifest digest describes its own content");
  assertEqual(verifyTemporalManifest(manifest).ok, true, `the manifest verifies: ${verifyTemporalManifest(manifest).problems.join("; ")}`);
  const sessionsDocument = await readTemporalSessions(temporalRootFor(ctx.temporalRoot, result.temporalId));
  assertDeepEqual(sessionsDocument, createTemporalSessionsDocument({ temporalId: result.temporalId, sessions: [] }), "the sessions document has exactly the documented shape");
});

test("B2. the temporal manifest source-pins the canonical wave and never rewrites it", async () => {
  const manifest = await readTemporalManifest(temporalRootFor(ctx.temporalRoot, ctx.created.temporalId));
  assertEqual(manifest.canonicalReplicationId, CANONICAL_REPLICATION_BARRIER.replicationId, "the canonical replication id is pinned");
  assertEqual(manifest.canonicalReplicationDigest, CANONICAL_REPLICATION_BARRIER.manifestContentDigest, "and its manifest digest");
  assertEqual(manifest.canonicalReplicationAggregateDigest, CANONICAL_REPLICATION_BARRIER.aggregateMetricsDigest, "and its aggregate digest");
  assertEqual(manifest.canonicalReplicationSessionRecordsDigest, CANONICAL_REPLICATION_BARRIER.sessionRecordsDigest, "and its session-records digest");
  assertEqual(manifest.canonicalReplicationProtocolDigest, REPLICATION_PROTOCOL_DIGEST, "and its protocol digest");
  assertEqual(manifest.canonicalReplicationCleanSessionCount, 3, "and its 3/3 CLEAN count");
  assertEqual(manifest.canonicalResultImmutable, true, "the canonical result is declared immutable");
  assertEqual(manifest.canonicalResultIndependentlyReproducible, true, "and independently reproducible");
  assertEqual(manifest.noNewWinnerField, true, "no new winner field");
  assertEqual(manifest.noPromotionToPhase5I2, true, "no promotion to 5I.2");
  assertEqual(manifest.noTradingLogic, true, "no trading logic");
  assertEqual(manifest.noJevCacheInPredictivePath, true, "no JevCache in the predictive path");
  assertEqual(manifest.singleAssetOnly, true, "single asset only");
  assertEqual(manifest.crossAssetTestingDeferredTo, "5I.1b", "cross-asset testing is deferred");
  assertEqual(manifest.violationPreservedNeverSilentlyExcluded, true, "violations are never silently excluded");
});

test("B3. temporal-create refuses any non-canonical replication baseline and a reused id", async () => {
  const refusal = await temporalCreate({ temporalRoot: ctx.temporalRoot, canonicalReplicationId: "jdir-20260920T063311Z-3a9163" });
  assertEqual(refusal.ok, false, "a non-canonical baseline is refused");
  assertTrue(refusal.error.includes(CANONICAL_REPLICATION_BARRIER.replicationId), "the refusal names the canonical wave");
  const reused = await temporalCreate({ temporalRoot: ctx.temporalRoot, temporalId: ctx.created.temporalId });
  assertEqual(reused.ok, false, "an explicit id is never reused");
  assertTrue(reused.error.includes("already exists"), "and says so");
});

test("B4. temporal-create FAILS CLOSED when the canonical wave's digest was tampered with", async () => {
  const sourceRoot = replicationRootForSafe(REAL_REPLICATION_ROOT, CANONICAL_REPLICATION_BARRIER.replicationId);
  if (!(await exists(sourceRoot))) {
    skip("the canonical Phase 5I.1 wave is absent here — the tamper refusal check was skipped cleanly");
    return;
  }
  const tamperRoot = path.join(ctx.tempRoot, "tampered-replication");
  await cp(REAL_REPLICATION_ROOT, tamperRoot, { recursive: true });
  const target = path.join(tamperRoot, CANONICAL_REPLICATION_BARRIER.replicationId, "summary.json");
  const summary = JSON.parse(await readFile(target, "utf8"));
  summary.aggregateMetricsDigest = digestOf({ tampered: true });
  await writeFile(target, JSON.stringify(summary, null, 2), "utf8");
  const refusal = await temporalCreate({ temporalRoot: path.join(ctx.tempRoot, "tampered-temporal"), canonicalRoot: tamperRoot });
  assertEqual(refusal.ok, false, "a tampered canonical aggregate is refused");
  assertTrue(refusal.error.includes("aggregate digest"), "and the refusal names the aggregate digest");
  assertEqual(await exists(path.join(ctx.tempRoot, "tampered-temporal", temporalIdFor({ createdAt: Date.now() }))), false, "nothing was created by the refusal");
});

function replicationRootForSafe(baseRoot, replicationId) {
  return path.join(baseRoot, replicationId);
}

/* ============================================================================
 * PART C — the canonical Phase 5I.1 result is PRESERVED
 * ==========================================================================*/

test("C1. the canonical jrep manifest, aggregate digest and sessionRecordsDigest are unchanged", async () => {
  const root = path.join(REAL_REPLICATION_ROOT, CANONICAL_REPLICATION_BARRIER.replicationId);
  if (!(await exists(root))) {
    skip("the canonical Phase 5I.1 replication wave is absent here — its digest preservation check was skipped cleanly");
    return;
  }
  const bundle = await readReplicationBundle(root);
  assertEqual(bundle.manifest.replicationId, CANONICAL_REPLICATION_BARRIER.replicationId, "the canonical id");
  assertEqual(bundle.manifest.replicationProtocolDigest, REPLICATION_PROTOCOL_DIGEST, "the canonical protocol digest");
  assertEqual(bundle.manifest.manifestContentDigest, CANONICAL_REPLICATION_BARRIER.manifestContentDigest, "the canonical manifest digest is unchanged");
  assertEqual(manifestDigestOf(bundle.manifest), CANONICAL_REPLICATION_BARRIER.manifestContentDigest, "and it still recomputes");
  assertEqual(bundle.summary.aggregateMetricsDigest, CANONICAL_REPLICATION_BARRIER.aggregateMetricsDigest, "the canonical aggregate digest is unchanged");
  assertEqual(bundle.summary.sessionRecordsDigest, CANONICAL_REPLICATION_BARRIER.sessionRecordsDigest, "the canonical sessionRecordsDigest is unchanged");
  assertEqual(replicationAggregateDigestOf(bundle.summary), bundle.summary.aggregateMetricsDigest, "and the aggregate digest recomputes from its content");
  assertEqual(bundle.summary.cleanSessionCount, 3, "3/3 CLEAN canonical sessions");
  assertDeepEqual(bundle.summary.cleanSessionIds, [...CANONICAL_REPLICATION_BARRIER.cleanSessionIds], "the canonical session ids are unchanged");
  assertEqual(bundle.summary.bootstrapState ?? REPLICATION_BOOTSTRAP_STATE, REPLICATION_BOOTSTRAP_STATE, "the canonical summary still reports the descriptive bootstrap state");
});

test("C2. the canonical wave independently replays to the same 3-session result", async () => {
  const root = path.join(REAL_REPLICATION_ROOT, CANONICAL_REPLICATION_BARRIER.replicationId);
  const sessionsPresent = (await Promise.all(CANONICAL_REPLICATION_BARRIER.cleanSessionIds.map((id) => exists(path.join(REAL_EXPERIMENTS_ROOT, id))))).every(Boolean);
  if (!(await exists(root)) || !sessionsPresent) {
    skip("the canonical Phase 5I.1 wave or its sessions are absent here — the independent replay was skipped cleanly");
    return;
  }
  const report = await replicationReplay({ replicationRoot: REAL_REPLICATION_ROOT, replicationId: CANONICAL_REPLICATION_BARRIER.replicationId });
  assertEqual(report.ok, true, `the canonical wave still replays cleanly: ${JSON.stringify(report.problems)}`);
  assertEqual(report.metricsMatch, true, "the canonical aggregation reproduces byte for byte");
  assertEqual(report.counts.cleanSessions, 3, "3/3 CLEAN");
  assertEqual(report.networkCalls + report.jevCalls + report.providerCalls, 0, "zero network");
  assertEqual(report.replicationProtocolDigest, REPLICATION_PROTOCOL_DIGEST, "the protocol digest is unchanged");
});

test("C3. the temporal extension is a SEPARATE manifest with a SEPARATE evidence class", async () => {
  const manifest = await readTemporalManifest(temporalRootFor(ctx.temporalRoot, ctx.created.temporalId));
  assertEqual(manifest.evidenceClass !== REPLICATION_EVIDENCE_CLASS, true, "the temporal evidence class differs from the canonical one");
  assertEqual(manifest.evidenceClass, TEMPORAL_REPLICATION_EVIDENCE_CLASS, "it is the temporal class");
  assertEqual(TEMPORAL_REPLICATION_EVIDENCE_PROFILE.replicationStatus, "PENDING_TEMPORAL_AGGREGATION", "a temporal session is not a wave result");
  assertEqual(manifest.temporalId !== CANONICAL_REPLICATION_BARRIER.replicationId, true, "the temporal id differs from the canonical id");
  assertEqual(manifest.artifactKind !== "DIRECTION_REPLICATION_MANIFEST", true, "and so does the artifact kind");
});

/* ============================================================================
 * PART D — the temporal session evidence class and unchanged semantics
 * ==========================================================================*/

test("D1. every temporal fixture records the temporal class and the frozen protocol", async () => {
  for (const [experimentId, entry] of ctx.fixtures.entries()) {
    const development = entry.plan.development === true;
    assertEqual(
      entry.bundle.experiment.evidenceClass,
      development ? DIRECTION_EVIDENCE_CLASS : TEMPORAL_REPLICATION_EVIDENCE_CLASS,
      `${experimentId} declares its class`,
    );
    if (!development) {
      assertEqual(entry.bundle.experiment.temporalExtensionOnly, true, `${experimentId} is marked temporalExtensionOnly`);
      assertEqual(entry.bundle.summary.evidenceScope, "TEMPORAL_REPLICATION", `${experimentId} summary scope`);
      assertEqual(entry.bundle.summary.replicationStatus, "PENDING_TEMPORAL_AGGREGATION", `${experimentId} never claims a wave result`);
      assertEqual(protocolDigestOfExperiment(entry.bundle.experiment), TEMPORAL_PROTOCOL_DIGEST, `${experimentId} reproduces the frozen digest`);
    }
  }
});

test("D2. the temporal protocol pins the SAME questions, features, baselines, metrics and outcome policy", async () => {
  const manifest = await readTemporalManifest(temporalRootFor(ctx.temporalRoot, ctx.created.temporalId));
  const expected = manifest.expected;
  assertEqual(expected.questionSetId, DIRECTION_QUESTION_SET_ID, "the question set id");
  assertEqual(expected.questionSetVersion, DIRECTION_QUESTION_SET_VERSION, "the question set version");
  assertEqual(expected.questionDigest, directionQuestionDigest(), "the question digest");
  assertEqual(expected.packetKind, DIRECTION_PACKET_KIND, "the packet kind");
  assertEqual(expected.packetVersion, DIRECTION_PACKET_VERSION, "the packet version");
  assertEqual(expected.featureDefinitionVersion, DIRECTION_FEATURE_DEFINITION_VERSION, "the feature definition version");
  assertEqual(expected.featureDefinitionDigest, DIRECTION_FEATURE_DEFINITION_DIGEST, "the feature digest");
  assertEqual(expected.baselineDefinitionVersion, BASELINE_DEFINITION_VERSION, "the baseline definition version");
  assertEqual(expected.baselineDefinitionDigest, BASELINE_DEFINITION_DIGEST, "the baseline digest");
  assertEqual(expected.metricDefinitionVersion, DIRECTION_METRICS_VERSION, "the metric definition version");
  assertEqual(expected.metricDefinitionDigest, DIRECTION_METRIC_DEFINITION_DIGEST, "the metric digest");
  assertEqual(expected.referencePriceDefinitionDigest, REFERENCE_PRICE_DEFINITION_DIGEST, "the reference-price digest");
  assertEqual(expected.outcomeResolutionPolicyVersion, DEFAULT_OUTCOME_RESOLUTION_POLICY.version, "outcome policy v2");
  assertEqual(expected.outcomeResolutionPolicyDigest, digestOf(DEFAULT_OUTCOME_RESOLUTION_POLICY), "and its digest");
  assertEqual(expected.stalenessPolicyDigest, STALENESS_POLICY_DIGEST, "the staleness policy");
  assertEqual(expected.provider, REQUIRED_PROVIDER, "the direct provider");
  assertEqual(expected.upstreamProvider, REQUIRED_UPSTREAM_PROVIDER, "the direct upstream");
  assertEqual(expected.model, REQUIRED_MODEL, "the pinned model");
  assertEqual(expected.gatewayUsed, false, "gateway false");
  assertEqual(expected.mode, "shadow", "shadow mode");
  assertEqual(expected.sessionSize, 120, "120 observations");
  assertEqual(expected.cadenceSeconds, 30, "a 30-second cadence");
  assertEqual(expected.horizonSeconds, 30, "a 30-second horizon");
  assertEqual(expected.resolutionToleranceMs, 10_000, "the 10000 ms outcome bound");

  // The SAME pins the canonical replication manifest carries.
  const canonicalRoot = path.join(REAL_REPLICATION_ROOT, CANONICAL_REPLICATION_BARRIER.replicationId);
  if (await exists(canonicalRoot)) {
    const canonical = await readReplicationBundle(canonicalRoot);
    for (const key of Object.keys(canonical.manifest.expected)) {
      if (key === "requiredCleanSessions") continue;
      assertDeepEqual(expected[key], canonical.manifest.expected[key], `temporal pin '${key}' equals the canonical replication pin`);
    }
  } else {
    assertDeepEqual(Object.keys(REPLICATION_PROTOCOL_CONTRACT).length > 0, true, "the frozen contract is available for comparison");
  }
});

test("D3. a genuine temporal session is CLEAN and starts after the canonical wave", async () => {
  const derived = await deriveFixture("jdir-tfx-clean-1");
  assertEqual(derived.eligibility.status, SESSION_STATUS.CLEAN, `clean-1 is CLEAN: ${JSON.stringify(derived.eligibility.reasons)}`);
  assertDeepEqual(derived.eligibility.reasons, [], "with zero reasons");
  assertEqual(Object.values(derived.eligibility.checks).every(Boolean), true, "and every individual check passed");
  const timing = derived.eligibility.timing;
  assertEqual(timing.afterCanonicalReplicationCompletion, true, "it started after the canonical wave completed");
  assertEqual(timing.overlapWithDevelopment, false, "it does not overlap development");
  assertEqual(timing.overlapWithCanonicalReplication, false, "it does not overlap the canonical wave");
  assertEqual(timing.overlapWithTemporalExtensionSession, false, "and does not overlap another temporal session");
  assertEqual(timing.utcDate, utcDateOf(fixture("jdir-tfx-clean-1").plan.t0), "its UTC date");
  assertEqual(timing.temporalOverlap, false, "temporalOverlap is false");
  assertEqual(derived.eligibility.selectionBasis, "calendar-schedule", "the selection basis is declared");
  assertEqual(derived.eligibility.timingNotSelectedFromObservedPerformance, true, "timing was not selected on performance");
  assertEqual(derived.eligibility.timingNotSelectedFromMarketView, true, "nor on a market view");
});

/* ============================================================================
 * PART E — the temporal-independence rules, one case each
 * ==========================================================================*/

test("E1. a session overlapping the DEVELOPMENT observation window is CONTAMINATED", async () => {
  const derived = await deriveFixture("jdir-tfx-dev-overlap");
  assertEqual(derived.eligibility.status, SESSION_STATUS.CONTAMINATED, "development overlap contaminates");
  assertEqual(derived.eligibility.timing.overlapWithDevelopment, true, "overlapWithDevelopment is true");
  assertTrue(derived.eligibility.reasons.some((reason) => /development observation window/.test(reason)), "the reason names the development window");
  assertTrue(derived.eligibility.reasons.some((reason) => /before the canonical Phase 5I.1 wave completed/.test(reason)), "and the canonical-completion rule");
});

test("E2. a session overlapping the CANONICAL Phase 5I.1 wave is CONTAMINATED", async () => {
  const derived = await deriveFixture("jdir-tfx-canonical-overlap");
  assertEqual(derived.eligibility.status, SESSION_STATUS.CONTAMINATED, "canonical-wave overlap contaminates");
  assertEqual(derived.eligibility.timing.overlapWithCanonicalReplication, true, "overlapWithCanonicalReplication is true");
  assertTrue(derived.eligibility.timing.overlappingCanonicalSessionIds.includes("jdir-20260920T121446Z-3a9163"), "the canonical session is named");
  assertTrue(derived.eligibility.reasons.some((reason) => /canonical Phase 5I.1 wave/.test(reason)), "and the reason says so");
});

test("E3. a session overlapping ANOTHER temporal session is CONTAMINATED and preserved", async () => {
  const derived = await deriveFixture("jdir-tfx-overlap-b", [await temporalEntryFor("jdir-tfx-overlap-a")]);
  assertEqual(derived.eligibility.status, SESSION_STATUS.CONTAMINATED, "session overlap contaminates");
  assertEqual(derived.eligibility.timing.overlapWithTemporalExtensionSession, true, "overlapWithTemporalExtensionSession is true");
  assertDeepEqual(derived.eligibility.timing.overlappingSessionIds, ["jdir-tfx-overlap-a"], "the overlapping session is named");
  assertTrue(derived.eligibility.reasons.some((reason) => /overlaps another Phase 5I.1a session/.test(reason)), "with the independence reason");
});

test("E4. a session sharing a UTC calendar date is CONTAMINATED: different-date rule enforced", async () => {
  const derived = await deriveFixture("jdir-tfx-date-b", [await temporalEntryFor("jdir-tfx-date-a")]);
  assertEqual(derived.eligibility.status, SESSION_STATUS.CONTAMINATED, "a shared UTC date contaminates");
  assertEqual(derived.eligibility.timing.differentUtcCalendarDate, false, "differentUtcCalendarDate is false");
  assertDeepEqual(derived.eligibility.timing.sameUtcDateSessionIds, ["jdir-tfx-date-a"], "the same-date session is named");
  assertTrue(derived.eligibility.reasons.some((reason) => /different UTC date/.test(reason)), "with the different-date reason");
  // ...and the two sessions really are on the same UTC date.
  assertEqual(utcDateOf(fixture("jdir-tfx-date-a").bundle.experiment.startedAt), utcDateOf(fixture("jdir-tfx-date-a").plan.t0), "date-a is on 2026-09-27");
  assertEqual(utcDateOf(fixture("jdir-tfx-date-b").bundle.experiment.startedAt), utcDateOf(fixture("jdir-tfx-date-b").plan.t0), "date-b is on 2026-09-27");
});

test("E5. a session less than six hours after the previous eligible session is CONTAMINATED", async () => {
  const previous = await temporalEntryFor("jdir-tfx-clean-1");
  assertEqual(previous.status, SESSION_STATUS.CLEAN, "the previous session really is eligible");
  const derived = await deriveFixture("jdir-tfx-gap", [previous]);
  assertEqual(derived.eligibility.status, SESSION_STATUS.CONTAMINATED, "a sub-6h gap contaminates");
  assertEqual(derived.eligibility.timing.minimumGapSatisfied, false, "minimumGapSatisfied is false");
  assertTrue(Number.isFinite(derived.eligibility.timing.gapFromPreviousEligibleSessionMs), "the gap is measured");
  assertEqual(derived.eligibility.timing.gapFromPreviousEligibleSessionMs < TEMPORAL_MINIMUM_GAP_MS, true, "and it is below six hours");
  assertEqual(derived.eligibility.timing.previousEligibleSessionId, "jdir-tfx-clean-1", "the previous eligible session is named");
  assertTrue(derived.eligibility.reasons.some((reason) => /6 hours/.test(reason)), "with the gap reason");
});

test("E6. mock/development evidence, gateway, model and route drift each make a session INELIGIBLE", async () => {
  const cases = [
    ["development class", { experiment: { evidenceClass: DIRECTION_EVIDENCE_CLASS, temporalExtensionOnly: undefined } }],
    ["fixture provider", { experiment: { offlineFixture: true, providerImplementation: "direction-fixture-jev-v1" } }],
    ["mock provider", { experiment: { provider: "mock-jev" } }],
    ["gateway route", { experiment: { gatewayUsed: true } }],
    ["non-direct upstream", { experiment: { upstreamProvider: "somewhere-else" } }],
    ["model alias", { experiment: { model: "jev-latest" } }],
    ["different model", { experiment: { model: "jev-1.12.0" } }],
    ["mode drift", { experiment: { mode: "live" } }],
  ];
  for (const [label, mutate] of cases) {
    const eligibility = evaluateMutated({ experimentId: "jdir-tfx-clean-1", mutate });
    assertEqual(eligibility.status, SESSION_STATUS.INELIGIBLE, `${label} is INELIGIBLE`);
    assertTrue(eligibility.reasons.length > 0, `${label} carries an explicit reason`);
  }
  const developmentFixture = evaluateTemporalSession({
    sessionId: "jdir-tfx-develop",
    experiment: fixture("jdir-tfx-develop").bundle.experiment,
    summary: fixture("jdir-tfx-develop").bundle.summary,
    predictions: fixture("jdir-tfx-develop").bundle.predictions,
    outcomes: fixture("jdir-tfx-develop").bundle.outcomes,
    replay: await replayDirectionExperiment({ experimentId: "jdir-tfx-develop", baseRoot: ctx.experimentsRoot }),
    protocol: verifyReplicationProtocol(fixture("jdir-tfx-develop").bundle.experiment),
    expected: ctx.expectedPins,
  });
  assertEqual(developmentFixture.status, SESSION_STATUS.INELIGIBLE, "development evidence can never be temporal evidence");
  assertTrue(developmentFixture.reasons.some((reason) => reason.includes(TEMPORAL_REPLICATION_EVIDENCE_CLASS)), "the reason names the temporal class");
});

test("E7. protocol / question / feature / baseline / metric / policy drift are all refused", async () => {
  const drifts = [
    ["question set", { experiment: { questionSetId: "jev-microstructure-direction-v2" } }],
    ["question digest", { experiment: { questionDigest: digestOf({ q: "changed" }) } }],
    ["feature definition", { experiment: { featureDefinitionDigest: digestOf({ f: "changed" }) } }],
    ["baseline definition", { experiment: { baselineDefinitionDigest: digestOf({ b: "changed" }) } }],
    ["metric definition", { experiment: { metricDefinitionDigest: digestOf({ m: "changed" }) } }],
    ["reference price", { experiment: { referencePriceDefinitionDigest: digestOf({ p: "changed" }) } }],
    ["outcome policy version", { experiment: { outcomeResolutionPolicyVersion: 1 } }],
    ["staleness policy", { experiment: { stalenessPolicyDigest: digestOf({ s: "changed" }) } }],
    ["horizon", { experiment: { horizonSeconds: 60 } }],
    ["cadence", { experiment: { samplingCadenceMs: 60_000 } }],
    ["session size", { experiment: { maxObservations: 60 } }],
    ["packet version", { experiment: { packetVersion: 2 } }],
  ];
  for (const [label, mutate] of drifts) {
    const eligibility = evaluateMutated({ experimentId: "jdir-tfx-clean-1", mutate });
    assertEqual(eligibility.status === SESSION_STATUS.CLEAN, false, `${label} drift cannot be CLEAN`);
    assertTrue(
      eligibility.reasons.some((reason) => /drifted from the frozen|not the frozen protocol shape/.test(reason)),
      `${label} drift has an explicit frozen-pin reason (got ${JSON.stringify(eligibility.reasons)})`,
    );
  }
  const protocolDrift = evaluateTemporalSession({
    sessionId: "jdir-tfx-clean-1",
    experiment: fixture("jdir-tfx-clean-1").bundle.experiment,
    summary: fixture("jdir-tfx-clean-1").bundle.summary,
    predictions: fixture("jdir-tfx-clean-1").bundle.predictions,
    outcomes: fixture("jdir-tfx-clean-1").bundle.outcomes,
    replay: null,
    protocol: { ok: false, digest: digestOf({ protocol: "changed" }) },
    expected: ctx.expectedPins,
  });
  assertEqual(protocolDrift.status, SESSION_STATUS.INELIGIBLE, "a mismatched protocol digest is INELIGIBLE");
  assertTrue(protocolDrift.reasons.some((reason) => /frozen temporal-extension protocol digest/.test(reason)), "and says so");
});

test("E8. a reintroduced confidence threshold makes a session INELIGIBLE", async () => {
  const thresholded = evaluateMutated({ experimentId: "jdir-tfx-clean-1", mutate: { summary: { noConfidenceThreshold: false } } });
  assertEqual(thresholded.status, SESSION_STATUS.INELIGIBLE, "a summary without the no-threshold rule is INELIGIBLE");
  const fielded = evaluateTemporalSession({
    sessionId: "jdir-tfx-clean-1",
    experiment: { ...fixture("jdir-tfx-clean-1").bundle.experiment, minConfidence: 0.9 },
    summary: fixture("jdir-tfx-clean-1").bundle.summary,
    predictions: fixture("jdir-tfx-clean-1").bundle.predictions,
    outcomes: fixture("jdir-tfx-clean-1").bundle.outcomes,
    replay: null,
    protocol: verifyReplicationProtocol(fixture("jdir-tfx-clean-1").bundle.experiment),
    expected: ctx.expectedPins,
  });
  assertEqual(fielded.status, SESSION_STATUS.INELIGIBLE, "a threshold-shaped field is INELIGIBLE");
  assertTrue(fielded.reasons.some((reason) => /reintroduced a confidence threshold/.test(reason)), "with the threshold reason");
});

test("E9. the canonical development experiment, both canaries and the three canonical replication sessions are protected", () => {
  for (const id of [
    CANONICAL_DEVELOPMENT_EXPERIMENT_ID,
    "jdir-20260920T060810Z-3a9163",
    "jdir-20260920T062804Z-3a9163",
    ...CANONICAL_REPLICATION_BARRIER.cleanSessionIds,
  ]) {
    assertTrue(TEMPORAL_PROTECTED_EXPERIMENT_IDS.includes(id), `${id} is protected`);
    assertTrue(typeof protectedTemporalExperimentReason(id) === "string", `${id} has an explicit refusal reason`);
  }
  assertEqual(protectedTemporalExperimentReason("jdir-something-new"), null, "an ordinary id is not protected");
  assertTrue(protectedTemporalExperimentReason(CANONICAL_REPLICATION_BARRIER.cleanSessionIds[0]).includes("canonical replication evidence"), "a canonical session names its class");
});

/* ============================================================================
 * PART F — wave sequencing: insufficient < 3, complete at exactly 3
 * ==========================================================================*/

test("F1. adding temporal sessions: violations are preserved and the wave completes at exactly 3 CLEAN", async () => {
  const seen = { INSUFFICIENT: 0, COMPLETE: 0 };
  const statusById = new Map();
  for (const experimentId of TEMPORAL_ADD_ORDER) {
    const added = await temporalAdd({
      temporalRoot: ctx.temporalRoot,
      baseRoot: ctx.experimentsRoot,
      canonicalRoot: REAL_REPLICATION_ROOT,
      temporalId: ctx.created.temporalId,
      sessionId: experimentId,
    });
    assertEqual(added.ok, true, `${experimentId} was recorded, not rejected: ${added.error ?? ""}`);
    statusById.set(experimentId, added.sessionStatus);
    assertEqual(added.launchedSessions, 0, `${experimentId}: --temporal-add launched nothing`);
    assertEqual(added.networkCalls, 0, `${experimentId}: zero network`);
    ctx.added.push(added);
    if (added.status === TEMPORAL_INSUFFICIENT_STATE) seen.INSUFFICIENT += 1;
    if (added.status === TEMPORAL_COMPLETE_STATE) seen.COMPLETE += 1;
    // A wave with fewer than 3 CLEAN sessions must NEVER report complete.
    if (added.cleanSessionCount < 3) assertEqual(added.status, TEMPORAL_INSUFFICIENT_STATE, `clean=${added.cleanSessionCount} is insufficient`);
  }

  // The three CLEAN sessions, and only those three.
  for (const id of ["jdir-tfx-clean-1", "jdir-tfx-clean-2", "jdir-tfx-clean-3"]) {
    assertEqual(statusById.get(id), SESSION_STATUS.CLEAN, `${id} is CLEAN`);
  }
  assertEqual(statusById.get("jdir-tfx-dev-overlap"), SESSION_STATUS.CONTAMINATED, "the development-overlap session is CONTAMINATED");
  assertEqual(statusById.get("jdir-tfx-canonical-overlap"), SESSION_STATUS.CONTAMINATED, "the canonical-overlap session is CONTAMINATED");
  assertEqual(statusById.get("jdir-tfx-overlap-b"), SESSION_STATUS.CONTAMINATED, "the overlapping session is CONTAMINATED");
  assertEqual(statusById.get("jdir-tfx-date-b"), SESSION_STATUS.CONTAMINATED, "the same-date session is CONTAMINATED");
  assertEqual(statusById.get("jdir-tfx-gap"), SESSION_STATUS.CONTAMINATED, "the sub-6h-gap session is CONTAMINATED");
  assertEqual(statusById.get("jdir-tfx-develop"), SESSION_STATUS.INELIGIBLE, "the development session is INELIGIBLE");

  const final = ctx.added[ctx.added.length - 1];
  assertEqual(final.cleanSessionCount, REQUIRED_CLEAN_TEMPORAL_SESSIONS, "exactly 3 CLEAN temporal sessions");
  assertEqual(final.status, TEMPORAL_COMPLETE_STATE, "and the temporal extension reports complete");
  assertEqual(final.totalSessionCount, 11, "while every recorded session is preserved");
  assertEqual(seen.INSUFFICIENT > 0, true, "insufficient was reported before completion");
  assertEqual(seen.COMPLETE, 1, "complete was reported exactly once");
});

test("F2. the symmetric independence rule re-derives BOTH members of a conflicting pair", async () => {
  const sessions = (await readTemporalSessions(temporalRootFor(ctx.temporalRoot, ctx.created.temporalId))).sessions;
  for (const id of ["jdir-tfx-overlap-a", "jdir-tfx-overlap-b", "jdir-tfx-date-a", "jdir-tfx-date-b"]) {
    const record = sessions.find((entry) => entry.sessionId === id);
    assertEqual(record.status, SESSION_STATUS.CONTAMINATED, `${id} is CONTAMINATED on the record`);
    assertEqual(record.eligible, false, `${id} is ineligible`);
    assertTrue(record.temporalEligibilityReasons.length > 0, `${id} keeps its temporal reasons`);
  }
  for (const entry of sessions) {
    assertEqual(typeof entry.utcDate === "string", true, `${entry.sessionId} persists its UTC date`);
    assertEqual(Object.hasOwn(entry, "gapFromPreviousEligibleSessionMs"), true, `${entry.sessionId} persists its gap`);
    assertEqual(Object.hasOwn(entry, "overlapWithDevelopment"), true, `${entry.sessionId} persists the development overlap flag`);
    assertEqual(Object.hasOwn(entry, "overlapWithCanonicalReplication"), true, `${entry.sessionId} persists the canonical overlap flag`);
    assertEqual(Object.hasOwn(entry, "overlapWithTemporalExtensionSession"), true, `${entry.sessionId} persists the temporal overlap flag`);
    assertEqual(entry.canonicalReplicationId, CANONICAL_REPLICATION_BARRIER.replicationId, `${entry.sessionId} persists the canonical replication id`);
    assertEqual(entry.selectionBasis, "calendar-schedule", `${entry.sessionId} declares the calendar selection basis`);
    if (entry.evidenceClass === TEMPORAL_REPLICATION_EVIDENCE_CLASS) {
      assertEqual(entry.protocolDigest, TEMPORAL_PROTOCOL_DIGEST, `${entry.sessionId} persists the frozen protocol digest`);
      assertEqual(entry.protocolOk, true, `${entry.sessionId} reproduces the frozen protocol digest`);
    } else {
      assertEqual(entry.evidenceClass, DIRECTION_EVIDENCE_CLASS, `${entry.sessionId} is the development fixture`);
      assertEqual(entry.protocolOk, false, `${entry.sessionId} does not reproduce the frozen protocol digest (mock provider)`);
    }
  }
});

/* ============================================================================
 * PART G — aggregation, equal weight, no pooling, deterministic bootstrap
 * ==========================================================================*/

test("G1. the temporal aggregate is equal-weighted by CLEAN session with no winner and no profitability", async () => {
  const stats = await cachedTemporalStats();
  assertEqual(stats.ok, true, "stats succeed");
  const summary = stats.summary;
  assertEqual(summary.status, TEMPORAL_COMPLETE_STATE, "the temporal extension is complete");
  assertEqual(summary.cleanSessionCount, 3, "3 CLEAN temporal sessions");
  assertDeepEqual(summary.cleanSessionIds, ["jdir-tfx-clean-1", "jdir-tfx-clean-2", "jdir-tfx-clean-3"], "the CLEAN session ids");
  assertEqual(summary.primaryInferenceUnit, "dataset/session", "the primary inference unit");
  assertEqual(summary.equalWeightedByEligibleSession, true, "equal-weighted by eligible session");
  assertEqual(summary.equalWeightPerCleanSession, true, "equal weight per clean session");
  assertEqual(summary.noObservationLevelPseudoReplication, true, "no observation-level pseudo-replication");
  assertEqual(summary.observationsNeverPooled, true, "observations are never pooled");
  assertEqual(summary.sessionSize, 120, "120 observations per session");
  assertEqual(summary.totalSessionCount, 11, "all 11 sessions are preserved");
  assertEqual(summary.excludedSessions.length, 8, "8 sessions are excluded");
  for (const comparisonId of ["neutral-v1", "momentum-v1", "mean-reversion-v1", "volume-flow-imbalance-v1", "momentum-liquidity-v1"]) {
    const block = summary.comparisons[comparisonId];
    for (const metric of ["brier", "logLoss", "accuracy"]) {
      assertEqual(block[metric].sessionCount, 3, `${comparisonId}.${metric} covers 3 sessions`);
      assertEqual(block[metric].values.length, 3, "one value per session, never per observation");
      const recomputed = block[metric].values.reduce((sum, value) => sum + value, 0) / block[metric].values.length;
      assertClose(block[metric].mean, recomputed, `${comparisonId}.${metric} mean is the equal-weighted session mean`, 1e-12);
    }
  }
  assertEqual(summary.winner, null, "no winner");
  assertEqual(summary.noAutomatedWinner, true, "declared");
  assertEqual(summary.noNewWinnerField, true, "no new winner field");
  assertEqual(summary.significanceClaimed, false, "no significance claim");
  assertEqual(summary.profitabilityInference, false, "no profitability inference");
  assertEqual(summary.tradingInference, false, "no trading inference");
  assertEqual(summary.deploymentInference, false, "no deployment inference");
  assertEqual(summary.automaticPromotionToPhase5I2, false, "no automatic promotion");
  const audit = auditNoProfitabilityFields(summary);
  assertEqual(audit.ok, true, `no profitability-shaped field: ${audit.problems.join("; ")}`);
  const serialized = JSON.stringify(summary).toLowerCase();
  for (const token of ["pnl", "sharpe", "sortino", "profitfactor", "expectedreturn", "position", "trade"]) {
    assertExcludes(serialized, token, `the temporal summary contains no ${token}`);
  }
});

test("G2. the bootstrap is the SAME deterministic session-level descriptive one Phase 5I.1 uses", async () => {
  const stats = await cachedTemporalStats();
  const summary = stats.summary;
  assertEqual(summary.bootstrap.available, true, "the interval is available");
  assertEqual(summary.bootstrapState, REPLICATION_BOOTSTRAP_STATE, "the same descriptive state label");
  assertEqual(summary.bootstrap.seed, REPLICATION_BOOTSTRAP_SEED, "the same fixed seed");
  assertEqual(summary.bootstrap.seed, 20260920, "20260920");
  assertEqual(summary.bootstrap.resamples, REPLICATION_BOOTSTRAP_RESAMPLES, "the same resample count");
  assertEqual(summary.bootstrap.resamples, 2000, "2000");
  assertEqual(summary.bootstrap.alpha, REPLICATION_BOOTSTRAP_ALPHA, "the same alpha");
  assertEqual(summary.bootstrap.prng, REPLICATION_BOOTSTRAP_PRNG, "the same deterministic PRNG");
  assertEqual(summary.bootstrap.pValueEmitted, false, "no p-value");
  assertEqual(summary.bootstrap.significanceLabelEmitted, false, "no significance label");
  const again = await temporalStats({ temporalRoot: ctx.temporalRoot, baseRoot: ctx.experimentsRoot, canonicalRoot: REAL_REPLICATION_ROOT, temporalId: ctx.created.temporalId });
  assertDeepEqual(again.summary.bootstrap.comparisons, summary.bootstrap.comparisons, "the intervals reproduce byte for byte");
  assertDeepEqual(again.summary.combinedView.combined.bootstrap.comparisons, summary.combinedView.combined.bootstrap.comparisons, "and the combined intervals reproduce too");
  for (const [key, interval] of Object.entries(summary.bootstrap.comparisons)) {
    assertEqual(interval.sessionCount, 3, `${key} resamples SESSIONS (three)`);
    assertEqual(interval.pValue, null, `${key} carries no p-value`);
    assertEqual(interval.significanceLabel, null, `${key} carries no significance label`);
    assertEqual(interval.statisticallyProven, false, `${key} claims no statistical proof`);
    assertEqual(interval.descriptiveOnly, true, `${key} is descriptive only`);
    assertTrue(interval.lower <= interval.upper, `${key} is ordered`);
  }
});

test("G3. an insufficient temporal wave emits NO interval, and a session-level aggregate never concatenates", () => {
  const oneClean = aggregateTemporalSessions([{ sessionId: "s1", status: SESSION_STATUS.CLEAN, metrics: { jev: { brier: 1, logLoss: 1, accuracy: 1 }, deltas: { "neutral-v1": { brier: -1, logLoss: -1, accuracy: 0 } } } }]);
  assertEqual(oneClean.status, TEMPORAL_INSUFFICIENT_STATE, "one CLEAN session is insufficient");
  assertEqual(oneClean.bootstrap.available, false, "so no interval is emitted");
  assertDeepEqual(oneClean.bootstrap.comparisons, {}, "and none are reported");
  assertEqual(oneClean.bootstrapState, TEMPORAL_INSUFFICIENT_STATE, "the state is the explicit insufficient one");
  const twoClean = aggregateTemporalSessions([
    { sessionId: "s1", status: SESSION_STATUS.CLEAN, metrics: { jev: { brier: 1, logLoss: 1, accuracy: 1 }, deltas: { "neutral-v1": { brier: -1, logLoss: -1, accuracy: 0 } } } },
    { sessionId: "s2", status: SESSION_STATUS.CLEAN, metrics: { jev: { brier: 3, logLoss: 3, accuracy: 3 }, deltas: { "neutral-v1": { brier: 1, logLoss: 1, accuracy: 1 } } } },
    { sessionId: "s3", status: SESSION_STATUS.CONTAMINATED, metrics: { jev: { brier: 999, logLoss: 999, accuracy: 999 }, deltas: { "neutral-v1": { brier: 999, logLoss: 999, accuracy: 999 } } } },
  ]);
  assertEqual(twoClean.status, TEMPORAL_INSUFFICIENT_STATE, "two CLEAN sessions are insufficient");
  assertEqual(twoClean.bootstrap.available, false, "so still no interval");
  assertEqual(twoClean.comparisons["neutral-v1"].brier.sessionCount, 2, "the contaminated session is excluded");
  assertEqual(twoClean.comparisons["neutral-v1"].brier.mean, 0, "and the mean is the equal-weighted session mean");
  assertEqual(twoClean.absolute.brier.mean, 2, "the absolute mean is session-level too");
});

/* ============================================================================
 * PART H — the combined descriptive view
 * ==========================================================================*/

test("H1. the combined view reports canonical 3 + temporal 3 = 6 observed clean sessions", async () => {
  const stats = await cachedTemporalStats();
  const view = stats.combinedView;
  assertEqual(view.canonicalSessionCount, 3, "three canonical sessions");
  assertEqual(view.temporalSessionCount, 3, "three temporal sessions");
  assertEqual(view.totalObservedCleanSessions, 6, "six total observed clean sessions");
  assertEqual(view.primaryInferenceUnit, "dataset/session", "the session is the unit");
  assertEqual(view.equalWeightPerCleanSession, true, "equal weight per clean session");
  assertEqual(view.noObservationLevelPseudoReplication, true, "no observation-level pseudo-replication");
  assertEqual(view.observationsNeverPooled, true, "observations are never pooled into N=360");
  assertEqual(view.canonicalResultImmutable, true, "the canonical result is immutable");
  assertEqual(view.canonicalResultIndependentlyReproducible, true, "and independently reproducible");
  assertEqual(view.canonicalReportedSeparately, true, "and reported separately");
  assertEqual(view.winner, null, "no winner");
  assertEqual(view.noNewWinnerField, true, "no new winner field");
  assertEqual(view.significanceClaimed, false, "no significance claim");
  assertEqual(view.profitabilityInference, false, "no profitability inference");
  assertEqual(view.automaticPromotionToPhase5I2, false, "no automatic promotion");
  assertEqual(view.canonical.aggregateMetricsDigest, CANONICAL_REPLICATION_BARRIER.aggregateMetricsDigest, "the canonical aggregate digest is the pinned one");
  assertEqual(view.canonical.sessionRecordsDigest, CANONICAL_REPLICATION_BARRIER.sessionRecordsDigest, "and the session-records digest");
  assertEqual(view.canonical.manifestContentDigest, CANONICAL_REPLICATION_BARRIER.manifestContentDigest, "and the manifest digest");
  assertEqual(view.temporal.cleanSessionCount, 3, "the temporal side is 3 CLEAN sessions");
  if (view.combined !== null) {
    assertEqual(view.combined.cleanSessionCount, 6, "the combined view has six sessions");
    for (const [comparisonId, block] of Object.entries(view.combined.comparisons)) {
      for (const metric of ["brier", "logLoss", "accuracy"]) {
        assertEqual(block[metric].sessionCount, 6, `${comparisonId}.${metric} covers six sessions`);
      }
    }
    assertEqual(view.combined.bootstrap.comparisons["neutral-v1.brier"].sessionCount, 6, "and the combined bootstrap resamples six sessions");
    assertEqual(view.combined.bootstrap.comparisons["neutral-v1.brier"].descriptiveOnly, true, "still descriptive only");
    assertEqual(view.combined.bootstrap.comparisons["neutral-v1.brier"].pValue, null, "still no p-value");
  } else {
    skip("the canonical per-session detail is absent here — the combined numeric view was skipped cleanly");
  }
});

test("H2. the combined view is derived by BUILDING on both views, never by re-scoring the canonical result", () => {
  const canonicalSummary = {
    status: "CLEAN_REPLICATION_SESSIONS_COMPLETE",
    perSession: [
      { sessionId: "c1", status: "CLEAN", jev: { brier: 0.2, logLoss: 0.6, accuracy: 0.5 }, deltas: { "neutral-v1": { brier: -0.01, logLoss: -0.02, accuracy: 0.1 } } },
      { sessionId: "c2", status: "CLEAN", jev: { brier: 0.3, logLoss: 0.7, accuracy: 0.5 }, deltas: { "neutral-v1": { brier: 0.01, logLoss: 0.02, accuracy: -0.1 } } },
      { sessionId: "c3", status: "CLEAN", jev: { brier: 0.25, logLoss: 0.65, accuracy: 0.5 }, deltas: { "neutral-v1": { brier: -0.005, logLoss: -0.01, accuracy: 0.05 } } },
    ],
  };
  const temporalSummary = {
    status: TEMPORAL_COMPLETE_STATE,
    perSession: [
      { sessionId: "t1", status: "CLEAN", jev: { brier: 0.21, logLoss: 0.61, accuracy: 0.5 }, deltas: { "neutral-v1": { brier: -0.02, logLoss: -0.03, accuracy: 0.2 } } },
      { sessionId: "t2", status: "CONTAMINATED", jev: { brier: 9, logLoss: 9, accuracy: 9 }, deltas: { "neutral-v1": { brier: 9, logLoss: 9, accuracy: 9 } } },
      { sessionId: "t3", status: "CLEAN", jev: { brier: 0.22, logLoss: 0.62, accuracy: 0.5 }, deltas: { "neutral-v1": { brier: 0.004, logLoss: 0.008, accuracy: -0.04 } } },
    ],
  };
  const view = buildCombinedDescriptiveView({ canonicalSummary, temporalSummary, canonicalBundlePresent: true });
  assertEqual(view.canonicalSessionCount, 3, "three canonical CLEAN sessions");
  assertEqual(view.temporalSessionCount, 2, "only the CLEAN temporal sessions count");
  assertEqual(view.totalObservedCleanSessions, 5, "five clean sessions");
  assertDeepEqual(view.combined.cleanSessionIds, ["c1", "c2", "c3", "t1", "t3"], "the contaminated temporal session is excluded");
  assertEqual(view.combined.comparisons["neutral-v1"].brier.sessionCount, 5, "five values for the comparison");
  assertEqual(view.canonical.immutable, true, "the canonical block is immutable");
  assertEqual(view.canonical.independentlyReproducible, true, "and independently reproducible");
  const canonicalBefore = canonicalJson(canonicalSummary);
  buildCombinedDescriptiveView({ canonicalSummary, temporalSummary, canonicalBundlePresent: true });
  assertEqual(canonicalJson(canonicalSummary), canonicalBefore, "building the view never mutates the canonical summary");
});

/* ============================================================================
 * PART I — zero network, zero launch
 * ==========================================================================*/

test("I1. temporal replay and stats are provably zero-network and never launch a session", async () => {
  const root = temporalRootFor(ctx.temporalRoot, ctx.created.temporalId);
  const before = await temporalMetadataSnapshot(root);
  const replay = await temporalReplay({ temporalRoot: ctx.temporalRoot, baseRoot: ctx.experimentsRoot, canonicalRoot: REAL_REPLICATION_ROOT, temporalId: ctx.created.temporalId });
  const stats = await cachedTemporalStats();
  const after = await temporalMetadataSnapshot(root);
  assertEqual(replay.ok, true, `the temporal extension replays cleanly: ${JSON.stringify(replay.problems)}`);
  assertEqual(replay.metricsMatch, true, "the stored aggregation reproduces");
  assertEqual(replay.manifestDigestMatches, true, "the manifest digest reproduces");
  assertEqual(replay.sessionsDigestMatches, true, "the session records reproduce");
  assertDeepEqual(replay.counts, { sessions: 11, cleanSessions: 3, contaminatedSessions: 7, ineligibleSessions: 1 }, "the recorded statuses are exactly as derived");
  for (const [label, report] of [["replay", replay], ["stats", stats]]) {
    assertEqual(report.networkCalls, 0, `${label}: zero network calls`);
    assertEqual(report.providerCalls, 0, `${label}: zero provider calls`);
    assertEqual(report.jevCalls, 0, `${label}: zero Jev calls`);
    assertEqual(report.arenaRuns, 0, `${label}: zero Arena runs`);
    assertEqual(report.tradingCalls, 0, `${label}: zero trading calls`);
    assertEqual(report.launchedSessions, 0, `${label}: launched no session`);
  }
  assertDeepEqual(after, before, "the temporal tree is byte-unchanged by its own replay");
  assertEqual(stats.metricsMatch, true, "stats reproduce the stored summary");
  assertEqual(aggregateDigestOf(stats.summary), stats.summary.aggregateMetricsDigest, "the aggregate digest recomputes from its content");
  assertDeepEqual(after, await temporalMetadataSnapshot(root), "stats wrote nothing");
});

test("I2. temporal-add refuses duplicates, protected ids, unknown targets and \"latest\"", async () => {
  const duplicate = await temporalAdd({ temporalRoot: ctx.temporalRoot, baseRoot: ctx.experimentsRoot, temporalId: ctx.created.temporalId, sessionId: "jdir-tfx-clean-1" });
  assertEqual(duplicate.ok, false, "a session is added exactly once");
  assertTrue(duplicate.error.includes("already recorded"), "and the refusal says so");
  for (const protectedId of TEMPORAL_PROTECTED_EXPERIMENT_IDS) {
    const refusal = await temporalAdd({ temporalRoot: ctx.temporalRoot, baseRoot: ctx.experimentsRoot, temporalId: ctx.created.temporalId, sessionId: protectedId });
    assertEqual(refusal.ok, false, `${protectedId} is refused`);
  }
  const unknownWave = await temporalAdd({ temporalRoot: ctx.temporalRoot, baseRoot: ctx.experimentsRoot, temporalId: "jtrp-20260101T000000Z-abcdef", sessionId: "jdir-tfx-clean-1" });
  assertEqual(unknownWave.ok, false, "an unknown temporal id is refused");
  const unknownSession = await temporalAdd({ temporalRoot: ctx.temporalRoot, baseRoot: ctx.experimentsRoot, temporalId: ctx.created.temporalId, sessionId: "jdir-not-here" });
  assertEqual(unknownSession.ok, false, "an unknown session id is refused");
  assertTrue(unknownSession.error.includes("no Phase 5I experiment"), "with the filesystem reason");
  const latest = await temporalAdd({ temporalRoot: ctx.temporalRoot, baseRoot: ctx.experimentsRoot, temporalId: ctx.created.temporalId, sessionId: "latest" });
  assertEqual(latest.ok, false, "there is no \"latest\"");
  const badId = await temporalAdd({ temporalRoot: ctx.temporalRoot, baseRoot: ctx.experimentsRoot, temporalId: "../escape", sessionId: "jdir-tfx-clean-1" });
  assertEqual(badId.ok, false, "a traversal id is refused");
  const after = await readTemporalSessions(temporalRootFor(ctx.temporalRoot, ctx.created.temporalId));
  assertEqual(after.sessions.length, 11, "no refused call changed the manifest");
});

/* ============================================================================
 * PART J — isolation: no money path, no winner, no promotion
 * ==========================================================================*/

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
  "paperOrder",
]);

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

function executableCode(source) {
  return codeOnly(source)
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``")
    .replace(/(^|[=(,:;\[!&|?{}])\s*(\/(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n])+\/[a-z]*)/g, "$1REGEX");
}

const TEMPORAL_MODULES = Object.freeze([
  "scripts/jev/direction/temporal/protocol.mjs",
  "scripts/jev/direction/temporal/manifest.mjs",
  "scripts/jev/direction/temporal/eligibility.mjs",
  "scripts/jev/direction/temporal/aggregate.mjs",
  "scripts/jev/direction/temporal/runner.mjs",
]);

test("J1. the temporal modules are offline, contain no money path and no execution/trading logic", async () => {
  for (const relative of TEMPORAL_MODULES) {
    assertTrue(await exists(path.join(REPO, relative)), `${relative} exists`);
    const raw = await readText(relative);
    const source = executableCode(raw);
    for (const token of FORBIDDEN_RUNTIME_TOKENS) {
      assertExcludes(source, token, `${relative} executable code contains no '${token}'`);
    }
    assertExcludes(source, "minConfidence", `${relative} has no minConfidence identifier`);
    assertExcludes(source, "confidenceThreshold:", `${relative} assigns no confidenceThreshold`);
    assertExcludes(source, "fetch(", `${relative} makes no request`);
    assertExcludes(source, "createResilientJevProvider", `${relative} constructs no provider`);
    assertExcludes(raw, "arena/tournament", `${relative} does not import the Arena tournament`);
    assertExcludes(raw, "jev/cache", `${relative} never imports a Jev cache`);
  }
  const runnerSource = await readText("scripts/jev/direction/temporal/runner.mjs");
  assertIncludes(runnerSource, "NO OPERATION HERE", "the runner states that it never launches a session");
  assertIncludes(runnerSource, "READ ONLY, ZERO NETWORK", "and that its read paths are offline");
  assertExcludes(await readText("scripts/evolve-engine.mjs"), "jev/direction", "the engine still never imports the 5I direction modules");
});

test("J2. the combined view and summary never emit a winner, a promotion or a new winner field", async () => {
  const stats = await cachedTemporalStats();
  for (const [label, subject] of [["summary", stats.summary], ["combined view", stats.combinedView]]) {
    assertEqual(subject.winner, null, `${label}: no winner`);
    assertEqual(subject.noAutomatedWinner, true, `${label}: declared`);
    assertEqual(subject.noNewWinnerField, true, `${label}: no new winner field`);
    assertEqual(subject.significanceClaimed, false, `${label}: no significance claim`);
    assertEqual(subject.profitabilityInference, false, `${label}: no profitability inference`);
    assertEqual(subject.automaticPromotionToPhase5I2, false, `${label}: no promotion`);
    const serialized = JSON.stringify(subject).toLowerCase();
    for (const token of ["winnerlabel", "\"winner\": \"", "significant", "suggeststrading", "tradecount"]) {
      assertExcludes(serialized, token, `${label} contains no ${token}`);
    }
  }
});

/* ============================================================================
 * PART K — CLI behaviour
 * ==========================================================================*/

function cliEnv(overrides = {}) {
  return {
    ...process.env,
    EVOLVE_JUPITER_BASE_URL: "http://127.0.0.1:1",
    JUPITER_API_KEY: "",
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

test("K1. the CLI documents the temporal extension and the four temporal commands", () => {
  const help = runCli(["--help"]);
  assertEqual(help.status, 0, "--help exits 0");
  for (const action of ["temporal-create", "temporal-add", "temporal-replay", "temporal-stats"]) {
    assertIncludes(help.stdout, `--${action}`, `help documents --${action}`);
  }
  assertIncludes(help.stdout, "--temporal-session", "and the temporal-session flag");
  assertIncludes(help.stdout, TEMPORAL_REPLICATION_EVIDENCE_CLASS, "and the temporal evidence class");
  assertIncludes(help.stdout, "TEMPORAL EXTENSION", "and names the temporal extension");
  const definition = runCli(["--definition"]);
  assertEqual(definition.status, 0, "--definition exits 0");
  assertIncludes(definition.stdout, TEMPORAL_PROTOCOL_DIGEST, "the temporal digest is the frozen protocol digest");
  assertIncludes(definition.stdout, CANONICAL_REPLICATION_BARRIER.replicationId, "and the canonical wave is named");
});

test("K2. temporal actions resolve exclusively and there is still no --latest", () => {
  assertEqual(isTemporalAction("temporal-create"), true, "temporal-create is a temporal action");
  assertEqual(isTemporalAction("start"), false, "start is not");
  assertEqual(isReplicationAction("temporal-add"), false, "a temporal action is not a replication action");
  assertEqual(resolveDirectionAction({ "temporal-create": true }).action, "temporal-create", "it resolves on its own");
  assertEqual(resolveDirectionAction({ start: true, "temporal-create": true }).error !== null, true, "two actions is an error");
  for (const action of ["temporal-add", "temporal-replay", "temporal-stats"]) {
    const result = runCli([`--${action}`]);
    assertTrue(result.status !== 0, `--${action} without --temporal exits non-zero`);
    assertIncludes(result.stderr, "explicit --temporal", `--${action} demands an explicit id`);
    const latest = runCli([`--${action}`, "--temporal", "latest"]);
    assertTrue(latest.status !== 0, `--${action} --temporal latest exits non-zero`);
    assertIncludes(latest.stderr, "never guesses which temporal", `--${action} refuses latest`);
  }
});

test("K3. `--start --temporal-session` refuses any non-frozen protocol value before running", () => {
  const base = ["--start", "--temporal-session", "--market", "SOL-USDC"];
  const env = { EVOLVE_JEV_PROVIDER: "" };
  const size = runCli([...base, "--max-observations", "60"], env);
  assertTrue(size.status !== 0, "a non-120 session exits non-zero");
  assertIncludes(size.stderr, "exactly 120 observations", "and names the frozen session size");
  const cadence = runCli([...base, "--cadence-seconds", "60"], env);
  assertTrue(cadence.status !== 0, "a non-30 s cadence exits non-zero");
  assertIncludes(cadence.stderr, "frozen 30-second cadence", "and names the frozen cadence");
  const tolerance = runCli([...base, "--tolerance-ms", "5000"], env);
  assertTrue(tolerance.status !== 0, "a v1 outcome bound exits non-zero");
  assertIncludes(tolerance.stderr, "outcome-resolution policy v2", "and names policy v2");
  const mock = runCli([...base, "--allow-mock"], env);
  assertTrue(mock.status !== 0, "--allow-mock exits non-zero for a temporal session");
  assertIncludes(mock.stderr, "must be genuine", "and refuses the fixture");
  const unsafe = runCli([...base, "--allow-unsafe-model"], env);
  assertTrue(unsafe.status !== 0, "--allow-unsafe-model exits non-zero for a temporal session");
  const both = runCli([...base, "--replication-session"], env);
  assertTrue(both.status !== 0, "combining both session flags exits non-zero");
  assertIncludes(both.stderr, "mutually exclusive", "and explains the conflict");
  assertExcludes(size.stdout, "EXPERIMENT_CREATED", "nothing was created by any refusal");
});

test("K4. the temporal CLI works end to end against a temp tree, offline", async () => {
  const cliExperiments = path.join(ctx.tempRoot, "cli-temporal-experiments");
  const cliTemporal = path.join(ctx.tempRoot, "cli-temporal");
  await cp(ctx.experimentsRoot, cliExperiments, { recursive: true });
  const base = ["--out", cliExperiments, "--temporal-out", cliTemporal, "--canonical-replication", REAL_REPLICATION_ROOT];
  const env = { EVOLVE_JEV_PROVIDER: "", EVOLVE_JEV_API_KEY: "" };

  const create = runCli(["--temporal-create", ...base], env);
  assertEqual(create.status, 0, `--temporal-create exits 0 (stderr: ${create.stderr})`);
  assertIncludes(create.stdout, "jtrp-", "it prints the temporal id");
  assertIncludes(create.stdout, TEMPORAL_PROTOCOL_DIGEST, "and the frozen protocol digest");
  assertExcludes(create.stdout, "PREDICTION_FROZEN", "and launched nothing");
  const temporalId = /jtrp-[A-Za-z0-9._-]+/.exec(create.stdout)?.[0] ?? null;
  assertTrue(typeof temporalId === "string", "the temporal id is readable from the output");

  const add = runCli(["--temporal-add", "--temporal", temporalId, "--experiment", "jdir-tfx-clean-1", ...base], env);
  assertEqual(add.status, 0, `--temporal-add exits 0 (stderr: ${add.stderr})`);
  assertIncludes(add.stdout, "CLEAN", "clean-1 is CLEAN");
  assertIncludes(add.stdout, "network           0", "with zero network calls");

  const replay = runCli(["--temporal-replay", "--temporal", temporalId, ...base], env);
  assertEqual(replay.status, 0, `--temporal-replay exits 0 (stderr: ${replay.stderr})`);
  assertIncludes(replay.stdout, "integrity         OK", "the replay reports integrity");
  assertIncludes(replay.stdout, "launched sessions 0", "and launched nothing");

  for (const sessionId of ["jdir-tfx-clean-2", "jdir-tfx-clean-3"]) {
    const more = runCli(["--temporal-add", "--temporal", temporalId, "--experiment", sessionId, ...base], env);
    assertEqual(more.status, 0, `--temporal-add ${sessionId} exits 0 (stderr: ${more.stderr})`);
  }

  const stats = runCli(["--temporal-stats", "--temporal", temporalId, ...base], env);
  assertEqual(stats.status, 0, `--temporal-stats exits 0 (stderr: ${stats.stderr})`);
  assertIncludes(stats.stdout, TEMPORAL_COMPLETE_STATE, "three CLEAN sessions complete the temporal extension");
  assertIncludes(stats.stdout, "DESCRIPTIVE_SESSION_BOOTSTRAP", "and report the descriptive bootstrap state");
  assertIncludes(stats.stdout, "combined view", "and print the combined view");
  assertIncludes(stats.stdout, "NO winner", "and no winner is emitted");
  assertExcludes(stats.stdout, "undefined", "and nothing is printed as undefined");

  const json = runCli(["--temporal-stats", "--temporal", temporalId, ...base, "--json"], env);
  assertEqual(json.status, 0, "--json stats exits 0");
  const payload = JSON.parse(json.stdout);
  assertEqual(payload.summary.primaryInferenceUnit, "dataset/session", "the JSON report keeps the session as the inference unit");
  assertEqual(payload.networkCalls, 0, "and reports zero network calls");
  assertEqual(payload.combinedView.totalObservedCleanSessions >= 3, true, "the combined view is present");
});

/* ============================================================================
 * PART Z — the real trees are byte-unchanged
 * ==========================================================================*/

test("Z1. Phase 5I.1a wrote nothing under ANY real .evolve evidence tree", async () => {
  const directionNow = await metadataSnapshot(REAL_DIRECTION_ROOT);
  const experimentsNow = await metadataSnapshot(REAL_EXPERIMENTS_ROOT);
  const replicationNow = await metadataSnapshot(REAL_REPLICATION_ROOT);
  assertDeepEqual(directionNow, ctx.before.realDirection, "the real jev-direction tree is byte-unchanged");
  assertDeepEqual(experimentsNow, ctx.before.realExperiments, "the real experiment trees (including all three canonical sessions) are byte-unchanged");
  assertDeepEqual(replicationNow, ctx.before.realReplication, "the canonical Phase 5I.1 replication manifest tree is byte-unchanged");
  assertTrue(!(ctx.tempRoot ?? "").includes(path.join(REPO, ".evolve")), "every temporal fixture lived in temp");
  assertEqual(path.join(DIRECTION_ROOT_DIR, "temporal"), DIRECTION_TEMPORAL_ROOT_DIR, "the temporal tree is a sibling of the replication tree");
  assertEqual(DIRECTION_TEMPORAL_ROOT_DIR.startsWith(DIRECTION_ROOT_DIR), true, "and lives under the same root");
});

/* ============================================================================
 * Runner
 * ==========================================================================*/

async function run() {
  let passed = 0;
  const failures = [];
  const started = Date.now();

  ctx.before.realDirection = await metadataSnapshot(REAL_DIRECTION_ROOT);
  ctx.before.realExperiments = await metadataSnapshot(REAL_EXPERIMENTS_ROOT);
  ctx.before.realReplication = await metadataSnapshot(REAL_REPLICATION_ROOT);

  try {
    await buildFixtures();
  } catch (error) {
    console.error("could not build Phase 5I.1a fixtures:", error?.stack ?? error);
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
    realExperiments: await metadataSnapshot(REAL_EXPERIMENTS_ROOT),
    realReplication: await metadataSnapshot(REAL_REPLICATION_ROOT),
  };
  await disposeFixtures();

  console.log(`\nfixtures built in ${fixtureMs}ms`);
  console.log("offline: no network call, no market request, no Jev call, no Arena run, no trading, and nothing");
  console.log("written under .evolve/ — the canonical Phase 5I.1 wave is read only, never appended to.");
  if (skips.length > 0) {
    console.log(`skipped ${skips.length} optional case(s) whose canonical evidence is absent here:`);
    for (const reason of skips) console.log(`  - ${reason}`);
  }
  console.log(
    `EVOLVE Phase ${TEMPORAL_PHASE} temporal-extension validation: ${passed}/${cases.length} checks passed`,
  );

  if (failures.length > 0) {
    console.log("Failed checks:");
    for (const failure of failures) console.log(`  - ${failure.name}`);
    process.exitCode = 1;
  } else {
    console.log("All Phase 5I.1a checks passed. The temporal extension re-uses the frozen Phase 5I.1 protocol digest");
    console.log("verbatim, aggregates ONLY CLEAN temporal sessions equal-weighted by session, and reports the canonical");
    console.log("3-session result separately and immutably.");
    console.log("NO real temporal session was run: every experiment above lived in a temp directory with an injected clock,");
    console.log("market and provider, and the operator runs real sessions manually.");
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
  console.error("phase 5I.1a validation runner crashed:", error);
  await disposeFixtures().catch(() => {});
  process.exitCode = 1;
});
