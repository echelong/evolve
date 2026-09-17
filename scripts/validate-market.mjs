#!/usr/bin/env node
/**
 * EVOLVE Phase 2 validation suite.
 *
 * Dependency-free (node:test is not needed): each case is a plain async
 * function, failures are collected, and the process exits non-zero if anything
 * fails. No network access is required — every provider interaction is scripted
 * through an injected fetch implementation.
 *
 * Run with: npm run validate:market
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createSimulation, computeFitness, passesGates } from "./engine/simulation.mjs";
import { randomGenome } from "./engine/genome.mjs";
import { paperGuards, simulateEntry, simulateExit, slippageBpsFor } from "./engine/paper.mjs";
import { createSeededRandom } from "./lib/random.mjs";
import { sanitizeForPublic, serializeForPublic } from "./lib/sanitize.mjs";
import { createMarketConfig } from "./market/config.mjs";
import { createMarketFeed } from "./market/feed.mjs";
import { JupiterTokensClient } from "./market/jupiter.mjs";
import {
  deriveFeatures,
  deriveMarket,
  normalizeJupiterToken,
  safeRatio,
  toFiniteNumber,
} from "./market/normalize.mjs";
import { MarketUniverse } from "./market/universe.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRET_KEY = "sk-live-EVOLVE-SECRET-9f3a77";
const CLOCK_START = 1_760_000_000_000;

const cases = [];

function test(name, fn) {
  cases.push({ name, fn });
}

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    fail(`${message} — expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function assertClose(actual, expected, tolerance, message) {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    fail(`${message} — expected ~${expected} (±${tolerance}), received ${actual}`);
  }
}

function assertFiniteNumbers(value, label, seen = new Set()) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${label} contains a non-finite number: ${value}`);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "number" && !Number.isFinite(entry)) {
      fail(`${label}.${key} is not finite: ${entry}`);
    }
    assertFiniteNumbers(entry, `${label}.${key}`, seen);
  }
}

function makeConfig(overrides = {}) {
  return createMarketConfig(overrides, { loadEnv: false });
}

function jsonResponse(payload, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

/** Scripted fetch: an Error throws, a function is called, anything else returns. */
function scriptedFetch(steps) {
  let index = 0;
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    if (typeof step === "function") return step(url, init);
    if (step instanceof Error) throw step;
    return step;
  };
  impl.calls = calls;
  return impl;
}

function fixtureToken(overrides = {}) {
  return {
    id: "FixtureMint111111111111111111111111111111",
    name: "Fixture Token",
    symbol: "FIX",
    icon: "https://example.invalid/icon.png",
    decimals: 6,
    holderCount: 4200,
    fdv: 2_500_000,
    mcap: 2_000_000,
    usdPrice: 0.042,
    liquidity: 840_000,
    stats5m: {
      priceChange: 8.4,
      holderChange: 1.2,
      liquidityChange: 3.4,
      volumeChange: 42.5,
      buyVolume: 210_000,
      sellVolume: 96_000,
      buyOrganicVolume: 42_000,
      sellOrganicVolume: 18_000,
      numBuys: 640,
      numSells: 380,
      numTraders: 512,
      numOrganicBuyers: 96,
      numNetBuyers: 260,
    },
    firstPool: { id: "PoolFixture111111111111111111111111111111", createdAt: "2026-09-16T00:00:00Z" },
    audit: { freezeAuthorityDisabled: true, mintAuthorityDisabled: true, topHoldersPercentage: 18.4 },
    organicScore: 88.2,
    organicScoreLabel: "high",
    isVerified: true,
    tags: ["verified"],
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-17T00:00:00Z",
    ...overrides,
  };
}

/**
 * Endpoints the static scanner must never find in the codebase. If any of
 * these appear, EVOLVE would have gained a real-execution capability and the
 * paper-only guarantee would be broken.
 */
const FORBIDDEN_PATTERNS = [
  /sendTransaction/i,
  /sendRawTransaction/i,
  /signTransaction/i,
  /signAllTransactions/i,
  /partialSign/i,
  /fromSecretKey/i,
  /secretKey/i,
  /privateKey/i,
  /seedPhrase/i,
  /mnemonic/i,
  /wallet-adapter/i,
  /@solana\/web3\.js/i,
  /@solana\/kit/i,
  /new\s+Connection\s*\(/,
  /new\s+Transaction\s*\(/,
  /SystemProgram/i,
  /jup\.ag\/swap/i,
  /api\.jup\.ag\/swap/i,
  /\/swap\/build/i,
  /swap-instructions/i,
  /broadcastTransaction/i,
];

const FORBIDDEN_DEPENDENCIES = [
  "@solana/web3.js",
  "@solana/kit",
  "@solana/wallet-adapter",
  "@jup-ag/api",
  "tweetnacl",
  "bs58",
  "solana-agent-kit",
];

// ---------------------------------------------------------------------------
// 1. Normalization tolerates missing / null / hostile fields
// ---------------------------------------------------------------------------

test("1. Jupiter normalization tolerates missing, null, and hostile fields", () => {
  const minimal = normalizeJupiterToken({ id: "MintOnly111111111111111111111111111111111" });
  assert(minimal !== null, "a token with only an id should normalize");
  assertEqual(minimal.symbol.length > 0, true, "symbol should fall back to the mint prefix");
  assertFiniteNumbers(minimal, "minimal token");
  assertEqual(minimal.usdPrice, null, "missing price must be null, not 0");
  assertEqual(minimal.liquidity, null, "missing liquidity must be null");
  assertEqual(minimal.topHoldersPercentage, null, "missing audit data must be null");

  assertEqual(normalizeJupiterToken(null), null, "null input must not normalize");
  assertEqual(normalizeJupiterToken({}), null, "missing id must not normalize");
  assertEqual(normalizeJupiterToken({ id: "   " }), null, "blank id must not normalize");
  assertEqual(normalizeJupiterToken("garbage"), null, "non-object input must not normalize");

  const hostile = normalizeJupiterToken({
    id: "Hostile1111111111111111111111111111111111",
    name: null,
    symbol: 42,
    decimals: "6",
    usdPrice: Number.NaN,
    liquidity: "Infinity",
    holderCount: "1234",
    mcap: "not-a-number",
    organicScore: -5,
    stats5m: { priceChange: "2.5", buyVolume: Number.POSITIVE_INFINITY, numBuys: "17", numSells: null },
    audit: { topHoldersPercentage: "33.3", mintAuthorityDisabled: null },
    tags: ["verified", 7, null],
  });

  assert(hostile !== null, "hostile token should still normalize");
  assertFiniteNumbers(hostile, "hostile token");
  assertEqual(hostile.usdPrice, null, "NaN price must become null");
  assertEqual(hostile.liquidity, null, "Infinity liquidity must become null");
  assertEqual(hostile.mcap, null, "unparseable mcap must become null");
  assertEqual(hostile.decimals, 6, "numeric strings should parse");
  assertEqual(hostile.holderCount, 1234, "numeric-string holder counts should parse");
  assertEqual(hostile.stats5m.priceChange, 2.5, "numeric-string stats should parse");
  assertEqual(hostile.stats5m.buyVolume, null, "Infinity volume must become null");
  assertEqual(hostile.tags.length, 1, "non-string tags should be dropped");

  assertEqual(safeRatio(1, 0, "fallback"), "fallback", "divide-by-zero must return the fallback");
  assertEqual(safeRatio(5, 2), 2.5, "valid ratios should compute");
  assertEqual(safeRatio(Number.NaN, 2), null, "NaN numerator must not produce a ratio");
  assertEqual(toFiniteNumber("abc"), null, "unparseable strings must be null");
});

// ---------------------------------------------------------------------------
// 2. Pool age comes from first pool creation, not mint creation
// ---------------------------------------------------------------------------

test("2. Pool age uses firstPool.createdAt, not the mint createdAt", () => {
  const at = CLOCK_START;
  const twoHoursAgo = new Date(at - 2 * 3_600_000).toISOString();

  const token = normalizeJupiterToken(
    fixtureToken({
      // Mint created 400 days ago; the first pool opened two hours ago.
      createdAt: new Date(at - 400 * 86_400_000).toISOString(),
      firstPool: { id: "PoolFixture", createdAt: twoHoursAgo },
    }),
    { at },
  );

  assertClose(token.poolCreatedAt, at - 2 * 3_600_000, 1000, "poolCreatedAt must come from firstPool");
  const features = deriveFeatures(token, { at });
  assertClose(features.poolAgeHours, 2, 0.01, "pool age in hours must be ~2");

  const market = deriveMarket(token, { at, staleMs: 60_000 });
  assertClose(market.poolAgeMs / 3_600_000, 2, 0.01, "market pool age must be ~2 hours");
  assert(market.poolAgeMs < 3 * 3_600_000, "mint age must never leak into pool age");

  // Epoch-millisecond and epoch-second timestamps must both work.
  const msToken = normalizeJupiterToken(
    fixtureToken({ firstPool: { id: "p", createdAt: at - 60_000 } }),
    { at },
  );
  assertClose(msToken.poolCreatedAt, at - 60_000, 1, "epoch ms pool timestamps should parse");
  const secToken = normalizeJupiterToken(
    fixtureToken({ firstPool: { id: "p", createdAt: Math.round(at / 1000) - 60 } }),
    { at },
  );
  assertClose(secToken.poolCreatedAt, at - 60_000, 1, "epoch second pool timestamps should parse");

  const noPool = normalizeJupiterToken(fixtureToken({ firstPool: undefined }), { at });
  assertEqual(noPool.poolCreatedAt, null, "missing first pool must yield a null age, not zero");
  assertEqual(deriveFeatures(noPool, { at }).poolAgeHours, null, "unknown age must stay unknown");
});

// ---------------------------------------------------------------------------
// 3. Ratios can never become NaN / Infinity
// ---------------------------------------------------------------------------

test("3. Buy/sell ratios never return NaN or Infinity", () => {
  const zeroSells = normalizeJupiterToken(
    fixtureToken({ stats5m: { buyVolume: 1000, sellVolume: 0, buyOrganicVolume: 500, sellOrganicVolume: 0 } }),
  );
  const zeroSellsMarket = deriveMarket(zeroSells, { at: CLOCK_START });
  assertEqual(zeroSellsMarket.buySellRatio, null, "zero denominator must yield null, not Infinity");
  assertEqual(zeroSellsMarket.buySellRatioSafe, 0, "the safe ratio must be 0");
  assertEqual(zeroSellsMarket.organicBuySellRatio, null, "organic ratio with zero sells must be null");

  const empty = normalizeJupiterToken(fixtureToken({ stats5m: {} }));
  const emptyMarket = deriveMarket(empty, { at: CLOCK_START });
  assertFiniteNumbers(emptyMarket, "market with no 5m stats");
  assertEqual(emptyMarket.buySellRatioSafe, 0, "missing stats must not produce NaN");
  assertClose(emptyMarket.buyPressure, 0.5, 1e-9, "missing flow must fall back to neutral");

  const junk = normalizeJupiterToken(
    fixtureToken({
      usdPrice: 0,
      liquidity: 0,
      stats5m: { buyVolume: 100, sellVolume: "NaN", numBuys: 0, numSells: 0, numNetBuyers: Number.NaN },
    }),
  );
  const junkMarket = deriveMarket(junk, { at: CLOCK_START });
  assertFiniteNumbers(junkMarket, "market built from junk numbers");
  assert(Number.isFinite(junkMarket.changePct), "changePct must always be a finite number");

  const reference = normalizeJupiterToken(fixtureToken());
  const referenceMarket = deriveMarket(reference, { at: CLOCK_START });
  assertFiniteNumbers(referenceMarket, "healthy market");
  assertClose(referenceMarket.buySellRatio, 210_000 / 96_000, 1e-6, "normal ratios must compute");
});

// ---------------------------------------------------------------------------
// 4. Duplicate mints merge
// ---------------------------------------------------------------------------

test("4. Duplicate mints merge into one universe entry", () => {
  const at = CLOCK_START;
  const universe = new MarketUniverse({ max: 50, ttlMs: 600_000, staleMs: 60_000, now: () => at });

  const recent = normalizeJupiterToken(fixtureToken(), { at, endpoint: "/tokens/v2/recent" });
  const trending = normalizeJupiterToken(
    fixtureToken({ liquidity: 1_240_000, stats5m: { buyVolume: 900, sellVolume: 300, numTraders: 900 } }),
    { at: at + 1000, endpoint: "/tokens/v2/toptrending/5m" },
  );

  universe.ingest([recent], { category: "/tokens/v2/recent", at });
  universe.ingest([trending], { category: "/tokens/v2/toptrending/5m", at: at + 1000 });

  assertEqual(universe.size, 1, "the same mint must never occupy two slots");
  const merged = universe.get(recent.mint);
  assertEqual(merged.liquidity, 1_240_000, "the newer observation must win");
  assertEqual(merged.categories.length, 2, "both source categories should be recorded");
  assert(merged.firstSeenAt <= merged.lastSeenAt, "first/last seen bookkeeping must be ordered");
  assert(merged.observationCount >= 1, "observations should be counted");

  // A second identical observation is not an observation-to-observation change.
  const before = universe.get(recent.mint).observationCount;
  universe.ingest([trending], { category: "/tokens/v2/toptrending/5m", at: at + 2000 });
  assertEqual(universe.get(recent.mint).observationCount, before, "identical data is not a new observation");

  // Nulls never overwrite known values.
  const thin = normalizeJupiterToken({ id: recent.mint }, { at: at + 3000 });
  universe.ingest([thin], { category: "/tokens/v2/recent", at: at + 3000 });
  assertEqual(universe.get(recent.mint).liquidity, 1_240_000, "a null field must not erase a known value");
});

// ---------------------------------------------------------------------------
// 5. Universe stays bounded and prefers usable tokens
// ---------------------------------------------------------------------------

test("5. Market universe is bounded, deduplicated, and TTL-evicted", () => {
  let clock = CLOCK_START;
  const universe = new MarketUniverse({ max: 40, ttlMs: 120_000, staleMs: 60_000, now: () => clock });

  const batch = [];
  for (let index = 0; index < 400; index += 1) {
    batch.push(
      normalizeJupiterToken(
        fixtureToken({
          id: `Mint${index.toString().padStart(4, "0")}${"x".repeat(30)}`,
          symbol: `T${index}`,
          liquidity: index < 5 ? 0 : 100_000 + index * 1000,
          usdPrice: index < 3 ? null : 0.001 * (index + 1),
        }),
        { at: clock },
      ),
    );
  }

  universe.ingest(batch, { category: "/tokens/v2/recent", at: clock });
  assert(universe.size <= 40, `universe must stay bounded (got ${universe.size})`);
  assert(universe.summary(clock).evicted > 0, "overflow tokens must be evicted");

  const deep = normalizeJupiterToken(
    fixtureToken({ id: "DeepLiquidityMint11111111111111111111111", liquidity: 9_000_000, usdPrice: 12.5 }),
    { at: clock },
  );
  universe.ingest([deep], { category: "/tokens/v2/toptrending/5m", at: clock });
  assert(universe.get(deep.mint) !== null, "a deep, priced token should always keep its slot");
  assert(universe.size <= 40, "universe must remain bounded after later ingests");

  clock += 121_000;
  universe.prune(clock);
  assertEqual(universe.size, 0, "tokens older than the TTL must be evicted");

  // Duplicate mints inside a single batch still collapse.
  const duplicates = new MarketUniverse({ max: 10, ttlMs: 600_000, now: () => clock });
  duplicates.ingest([deep, deep, deep], { category: "/tokens/v2/recent", at: clock });
  assertEqual(duplicates.size, 1, "duplicate mints within one batch must collapse");
});

// ---------------------------------------------------------------------------
// 6. Stale live feed blocks new entries
// ---------------------------------------------------------------------------

test("6. A stale live feed blocks new paper entries", async () => {
  let clock = CLOCK_START;
  const now = () => clock;
  let healthy = true;

  const fetchImpl = scriptedFetch([
    () =>
      healthy
        ? jsonResponse([
            fixtureToken(),
            fixtureToken({
              id: "PoolTwo1111111111111111111111111111111",
              symbol: "FIX2",
              liquidity: 620_000,
              firstPool: { id: "p2", createdAt: new Date(clock - 90 * 60_000).toISOString() },
            }),
          ])
        : new Error("network down"),
  ]);

  const config = makeConfig({
    EVOLVE_MARKET_MODE: "live",
    JUPITER_API_KEY: SECRET_KEY,
    EVOLVE_LIVE_STALE_MS: "30000",
    EVOLVE_GENERATION_TICKS: "100000",
  });
  const feed = createMarketFeed({ config, fetchImpl, now });
  const simulation = createSimulation({ config, feed, now });

  for (let index = 0; index < 8; index += 1) {
    await feed.advance(clock);
    simulation.advanceTick();
    clock += 900;
  }

  const healthyState = feed.health(clock);
  assertEqual(healthyState.effectiveMode, "live", "live mode must stay live");
  assertEqual(healthyState.stale, false, "a fresh feed must not be stale");
  assertEqual(healthyState.allowNewEntries, true, "a healthy live feed allows entries");

  const holdingsBefore = simulation.population.filter((agent) => agent.position).map((agent) => agent.id);
  assert(holdingsBefore.length > 0, "the fixture market should have opened at least one paper position");

  healthy = false;
  clock += 31_000; // beyond EVOLVE_LIVE_STALE_MS

  for (let index = 0; index < 12; index += 1) {
    await feed.advance(clock);
    simulation.advanceTick();
    clock += 900;
  }

  const staleState = feed.health(clock);
  assertEqual(staleState.stale, true, "the feed must be reported stale");
  assertEqual(staleState.degraded, true, "a stale live feed must be degraded");
  assertEqual(staleState.entriesPaused, true, "new entries must be paused while stale");
  assertEqual(staleState.allowNewEntries, false, "allowNewEntries must be false while stale");
  assertEqual(
    staleState.banner,
    "LIVE FEED DEGRADED • NEW ENTRIES PAUSED",
    "the banner must switch to the degraded string",
  );

  const before = new Set(holdingsBefore);
  const illegal = simulation.population
    .filter((agent) => agent.position && !before.has(agent.id))
    .map((agent) => agent.id);
  assertEqual(illegal.length, 0, "no agent may open a new position on stale data");

  const emptyAgents = simulation.population.filter((agent) => !agent.position);
  assert(
    emptyAgents.every((agent) => agent.status === "PAUSED"),
    "agents without positions must be paused, not scanning",
  );

  // A previously held position may still be marked with its last observed price.
  const stillHeld = simulation.population.filter((agent) => agent.position);
  for (const agent of stillHeld) {
    assert(
      Number.isFinite(agent.position.markPrice) && agent.position.markPrice > 0,
      "retained positions must keep a finite last observed mark",
    );
  }
});

// ---------------------------------------------------------------------------
// 7. Auto mode falls back to synthetic explicitly
// ---------------------------------------------------------------------------

test("7. Auto mode explicitly falls back to synthetic when live is unavailable", async () => {
  let clock = CLOCK_START;
  const now = () => clock;

  const config = makeConfig({
    EVOLVE_MARKET_MODE: "auto",
    JUPITER_API_KEY: SECRET_KEY,
    EVOLVE_AUTO_FALLBACK_FAILURES: "2",
    EVOLVE_SYNTHETIC_RETRY_MS: "600000",
  });
  const fetchImpl = scriptedFetch([new Error("socket hang up")]);
  const feed = createMarketFeed({ config, fetchImpl, now });

  assertEqual(feed.health(clock).effectiveMode, "live", "auto starts by attempting live");

  for (let index = 0; index < 6; index += 1) {
    await feed.advance(clock);
    clock += 20_000;
  }

  const health = feed.health(clock);
  assertEqual(health.effectiveMode, "synthetic", "auto must fall back to synthetic");
  assertEqual(health.fallbackActive, true, "the fallback must be flagged");
  assert(health.fallbackReason !== null, "the fallback must carry an explicit reason");
  assertEqual(health.banner, "SYNTHETIC MARKET • PAPER MONEY", "the banner must say synthetic");
  assertEqual(health.source, "Synthetic", "the source must be labelled synthetic");
  assert(health.tokensTracked > 0, "the synthetic market must supply tokens");
  assertEqual(health.entriesPaused, false, "the paper market remains open in synthetic mode");

  const markets = feed.markets(clock);
  assert(markets.length > 0, "synthetic markets must be available after fallback");
  assert(
    markets.every((market) => market.synthetic === true),
    "every fallback market must be marked synthetic",
  );

  const events = [];
  const probeFeed = createMarketFeed({
    config: makeConfig({ EVOLVE_MARKET_MODE: "auto", EVOLVE_AUTO_FALLBACK_FAILURES: "1" }),
    fetchImpl: scriptedFetch([new Error("offline")]),
    now,
    onEvent: (event) => events.push(event),
  });
  let probeClock = CLOCK_START;
  for (let index = 0; index < 4; index += 1) {
    await probeFeed.advance(probeClock);
    probeClock += 30_000;
  }
  assert(
    events.some((event) => /SYNTHETIC/i.test(event.message)),
    "an explicit fallback event must be emitted",
  );
});

// ---------------------------------------------------------------------------
// 8. Live mode never silently falls back
// ---------------------------------------------------------------------------

test("8. Live mode never silently falls back to synthetic", async () => {
  let clock = CLOCK_START;
  const now = () => clock;

  const config = makeConfig({
    EVOLVE_MARKET_MODE: "live",
    JUPITER_API_KEY: SECRET_KEY,
    EVOLVE_AUTO_FALLBACK_FAILURES: "1",
    EVOLVE_ALLOW_SYNTHETIC_FALLBACK: "true",
  });
  const fetchImpl = scriptedFetch([
    jsonResponse([fixtureToken()]),
    new Error("connection refused"),
    jsonResponse([fixtureToken()], 500),
    jsonResponse([fixtureToken()], 429),
  ]);
  const feed = createMarketFeed({ config, fetchImpl, now });

  for (let index = 0; index < 14; index += 1) {
    await feed.advance(clock);
    clock += 15_000;
  }

  const health = feed.health(clock);
  assertEqual(health.effectiveMode, "live", "forced live mode must never switch to synthetic");
  assertEqual(health.source, "Jupiter Tokens V2", "the live source label must be retained");
  assertEqual(health.banner, "LIVE FEED DEGRADED • NEW ENTRIES PAUSED", "degraded banner expected");
  assertEqual(health.entriesPaused, true, "entries must be paused while degraded");
  assertEqual(feed.synthetic.stepCount, 0, "the synthetic simulator must never run in live mode");

  const markets = feed.markets(clock);
  assert(
    markets.every((market) => market.synthetic !== true),
    "live mode must never serve synthetic market data",
  );

  // Live mode without a key: degraded immediately, no fabricated data.
  const noKeyConfig = makeConfig({ EVOLVE_MARKET_MODE: "live" });
  const noKeyFetch = scriptedFetch([jsonResponse([fixtureToken()])]);
  const noKeyFeed = createMarketFeed({ config: noKeyConfig, fetchImpl: noKeyFetch, now });
  await noKeyFeed.advance(clock);
  const noKeyHealth = noKeyFeed.health(clock);
  assertEqual(noKeyHealth.effectiveMode, "live", "live mode must stay live without a key");
  assertEqual(noKeyHealth.degraded, true, "live mode without a key must be degraded");
  assertEqual(noKeyHealth.entriesPaused, true, "live mode without a key must pause entries");
  assertEqual(noKeyHealth.apiKeyConfigured, false, "apiKeyConfigured must be false");
  assertEqual(noKeyFetch.calls.length, 0, "live mode must not poll without the required key");
});

// ---------------------------------------------------------------------------
// 9. The API key never reaches public state
// ---------------------------------------------------------------------------

test("9. The Jupiter API key never appears in public state, logs, or requests bodies", async () => {
  let clock = CLOCK_START;
  const now = () => clock;
  const config = makeConfig({ EVOLVE_MARKET_MODE: "live", JUPITER_API_KEY: SECRET_KEY });

  assertEqual(JSON.stringify(config).includes(SECRET_KEY), false, "secrets must not be enumerable");
  const enumerableKeys = Object.keys(config);
  assertEqual(enumerableKeys.includes("apiKey"), false, "apiKey must be non-enumerable");
  assertEqual(enumerableKeys.includes("secretValues"), false, "secretValues must be non-enumerable");
  assertEqual(
    Object.keys({ ...config }).includes("apiKey"),
    false,
    "spreading the config must not copy the key",
  );
  assertEqual(config.apiKey, SECRET_KEY, "the client can still read the key for its header");

  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {}, body: init?.body ?? null });
    throw new Error(`provider rejected request with key ${SECRET_KEY}`);
  };

  const feed = createMarketFeed({ config, fetchImpl, now });
  await feed.advance(clock);
  clock += 10_000;
  await feed.advance(clock);

  assertEqual(calls.length > 0, true, "the client should have attempted a request");
  assertEqual(calls[0].headers["x-api-key"], SECRET_KEY, "the key travels server-side in the header");
  assertEqual(calls[0].url.includes(SECRET_KEY), false, "the key must never appear in a URL");
  assertEqual(calls[0].body, null, "observation requests must not send a body");

  const health = feed.health(clock);
  assert(
    health.lastErrorSafe === null || !health.lastErrorSafe.includes(SECRET_KEY),
    "error text must be redacted",
  );

  const snapshot = simulationSnapshotFor(feed, config, now);
  const serialized = serializeForPublic(snapshot, { secrets: config.secretValues });
  assertEqual(serialized.includes(SECRET_KEY), false, "the serialized state must not contain the key");
  assertEqual(serialized.includes("redacted"), true, "leaked error text must be redacted, not dropped");

  const client = new JupiterTokensClient({ config, fetchImpl, now });
  const result = await client.pollOnce(clock);
  assertEqual(result.ok, false, "the failing request must report failure");
  assertEqual(result.error.includes(SECRET_KEY), false, "result errors must be redacted");
});

// ---------------------------------------------------------------------------
// 10. Paper execution applies cost and slippage
// ---------------------------------------------------------------------------

test("10. Paper execution applies fees and liquidity-dependent slippage", () => {
  const friction = makeConfig({}).paper;

  const floor = slippageBpsFor({ notionalUsd: 1, liquidityUsd: 1e9, friction });
  assertClose(floor, friction.minSlippageBps, 0.01, "tiny orders pay the minimum slippage");

  const impact = slippageBpsFor({ notionalUsd: 20_000, liquidityUsd: 100_000, friction });
  assert(impact > friction.minSlippageBps, "large orders must pay impact slippage");
  assert(impact <= friction.slippageCapBps, "slippage must respect the configured cap");

  const capped = slippageBpsFor({ notionalUsd: 10_000_000, liquidityUsd: 1000, friction });
  assert(capped <= friction.slippageCapBps, "slippage must never exceed the cap");
  assert(Number.isFinite(capped), "slippage must stay finite for absurd inputs");

  const entry = simulateEntry({ price: 1, notionalUsd: 50, liquidityUsd: 1_000_000, friction });
  assertEqual(entry.ok, true, "a normal entry must fill");
  assert(entry.executedPrice > 1, "buys must execute above the observed price");
  assert(entry.feeUsd > 0, "a fee must be charged");
  assert(entry.frictionUsd > 0, "friction must be non-zero");
  assert(entry.qty * 1 < 50, "frictionless notional must not be handed back as quantity");

  const exit = simulateExit({ qty: entry.qty, price: 1, liquidityUsd: 1_000_000, referencePrice: 1, friction });
  assertEqual(exit.ok, true, "a normal exit must fill");
  assert(exit.executedPrice < 1, "sells must execute below the observed price");
  const roundTrip = exit.netProceeds - entry.cashSpent;
  assert(roundTrip < 0, "a flat round trip must lose money to simulated friction");
  assertClose(exit.grossPnl, 0, 1e-9, "price-only P&L must be flat at an unchanged price");

  const blocked = simulateEntry({ price: 0, notionalUsd: 50, liquidityUsd: 1000, friction });
  assertEqual(blocked.ok, false, "an unpriceable token must never fill");
  const blockedExit = simulateExit({ qty: 1, price: Number.NaN, liquidityUsd: 1000, friction });
  assertEqual(blockedExit.ok, false, "an unpriceable exit must never fill");

  const guards = paperGuards();
  assertEqual(guards.paperOnly, true, "guards must declare paper-only");
  assertEqual(guards.canSpendRealSol, false, "guards must declare that real SOL cannot be spent");
  assertEqual(guards.signingCapability, "not implemented", "guards must declare no signing capability");
  assertEqual(guards.submissionCapability, "not implemented", "guards must declare no submission capability");
});

// ---------------------------------------------------------------------------
// 11. Fitness uses net performance
// ---------------------------------------------------------------------------

test("11. Fitness is computed from net performance after simulated costs", () => {
  const startingCash = 100;
  const base = {
    equity: 110,
    maxDrawdown: 0.05,
    trades: 10,
    wins: 6,
    costs: 0,
  };

  const noCosts = computeFitness(base, startingCash);
  const withCosts = computeFitness({ ...base, costs: 10 }, startingCash);
  assert(withCosts < noCosts, "costs must reduce fitness");

  // The documented net formula must be reproduced exactly.
  const expected =
    ((110 - startingCash) / startingCash) * 100 - 0.05 * 45 + 0.6 * 8 + (10 / 12) * 2 - (10 / startingCash) * 15;
  assertClose(withCosts, expected, 1e-9, "fitness must follow the documented net formula");

  // Gross-positive but cost-eaten: net equity is well below the starting bankroll.
  const costEaten = computeFitness({ ...base, equity: 88, costs: 8 }, startingCash);
  assert(costEaten < 0, "a net-losing agent must have negative fitness");

  const winner = computeFitness({ ...base, equity: 125, costs: 2 }, startingCash);
  assert(winner > noCosts, "a better net equity must win");

  assertEqual(Number.isFinite(computeFitness({ equity: Number.NaN, costs: Number.NaN }, startingCash)), true, "fitness must stay finite");

  // End-to-end: paper costs are reported and genuinely drag equity.
  finalCheck: {
    const config = makeConfig({ EVOLVE_MARKET_MODE: "synthetic", EVOLVE_GENERATION_TICKS: "60" });
    const feed = createMarketFeed({ config, fetchImpl: scriptedFetch([new Error("offline")]) });
    const simulation = createSimulation({ config, feed, random: createSeededRandom("fitness") });

    for (let index = 0; index < 200; index += 1) {
      feed.advance();
      simulation.advanceTick();
    }

    const snapshot = simulation.snapshot();
    assert(snapshot.stats.trades > 0, "the paper population should have traded");
    assert(snapshot.paper.costs > 0, "simulated costs must be reported");
    assert(
      snapshot.paper.grossPnl > snapshot.paper.netPnl,
      "net P&L must sit below gross P&L by the simulated costs",
    );
    assertFiniteNumbers(snapshot.paper, "paper summary");

    const traded = simulation.population.filter((agent) => agent.trades > 0);
    assert(traded.length > 0, "some agents must have completed trades");
    for (const agent of traded) {
      assert(agent.costs > 0, "every traded agent must carry simulated costs");
      assert(
        agent.netPnl <= agent.grossPnl,
        "net P&L can never exceed gross P&L once friction is applied",
      );
      assert(Number.isFinite(agent.fitness), "fitness must stay finite");
    }
  }
});

// ---------------------------------------------------------------------------
// 12. No real execution path exists anywhere in the repo
// ---------------------------------------------------------------------------

test("12. No real transaction-execution path exists in the codebase", async () => {
  const roots = ["scripts", "src"];
  const extensions = new Set([".mjs", ".ts", ".tsx", ".js", ".jsx"]);
  const findings = [];

  async function walk(dir) {
    const entries = await readdir(path.join(PROJECT_ROOT, dir), { withFileTypes: true });
    for (const entry of entries) {
      const relative = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        await walk(relative);
        continue;
      }
      if (!extensions.has(path.extname(entry.name))) continue;
      // Validation suites contain these patterns as detection rules, and as
      // strings they must be able to describe what they forbid.
      if (/^validate-.+\.mjs$/.test(entry.name)) continue;

      const text = await readFile(path.join(PROJECT_ROOT, relative), "utf8");
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(text)) findings.push(`${relative} matched ${pattern}`);
      }
    }
  }

  for (const root of roots) await walk(root);

  const packageJson = JSON.parse(await readFile(path.join(PROJECT_ROOT, "package.json"), "utf8"));
  const dependencies = Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies });
  for (const dependency of FORBIDDEN_DEPENDENCIES) {
    if (dependencies.includes(dependency)) findings.push(`package.json depends on ${dependency}`);
  }

  assert(
    findings.length === 0,
    `real-execution capability detected:\n    ${findings.join("\n    ")}`,
  );

  // And the source of truth for observation is read-only.
  const jupiterSource = await readFile(path.join(PROJECT_ROOT, "scripts/market/jupiter.mjs"), "utf8");
  assert(/method:\s*"GET"/.test(jupiterSource), "the provider client must only issue GET requests");
  assert(
    !/method:\s*"(POST|PUT|PATCH|DELETE)"/.test(jupiterSource),
    "the provider client must never issue a write request",
  );
});

// ---------------------------------------------------------------------------
// 13. Synthetic mode works offline and without a key
// ---------------------------------------------------------------------------

test("13. Synthetic mode works without internet access or an API key", async () => {
  let clock = CLOCK_START;
  const now = () => clock;
  let fetchCallCount = 0;

  const config = makeConfig({ EVOLVE_MARKET_MODE: "synthetic", EVOLVE_GENERATION_TICKS: "40" });
  const feed = createMarketFeed({
    config,
    fetchImpl: async () => {
      fetchCallCount += 1;
      throw new Error("no network available");
    },
    now,
    random: createSeededRandom("synthetic"),
  });
  const simulation = createSimulation({ config, feed, now, random: createSeededRandom("synthetic") });

  for (let index = 0; index < 400; index += 1) {
    await feed.advance(clock);
    simulation.advanceTick();
    clock += 900;
  }

  const health = feed.health(clock);
  assertEqual(fetchCallCount, 0, "synthetic mode must never touch the network");
  assertEqual(health.effectiveMode, "synthetic", "synthetic mode must stay synthetic");
  assertEqual(health.degraded, false, "synthetic mode is never degraded");
  assertEqual(health.entriesPaused, false, "synthetic mode keeps entries open");
  assertEqual(health.banner, "SYNTHETIC MARKET • PAPER MONEY", "synthetic banner expected");
  assertEqual(health.apiKeyConfigured, false, "no key is needed");

  const snapshot = simulation.snapshot();
  assert(snapshot.markets.length > 0, "synthetic markets must be produced");
  assert(
    snapshot.markets.every((market) => market.synthetic === true),
    "every synthetic market must be labelled synthetic",
  );
  assert(snapshot.generation > 1, "generations must advance offline");
  assert(snapshot.stats.terminatedTotal > 0, "selection must terminate agents offline");
  assert(snapshot.stats.bornTotal > snapshot.stats.population, "births must accumulate offline");
  assertFiniteNumbers(snapshot, "offline snapshot");
});

// ---------------------------------------------------------------------------
// 14. Dashboard state serializes cleanly and stays safe
// ---------------------------------------------------------------------------

test("14. Dashboard state serializes cleanly with no secrets or non-finite numbers", async () => {
  let clock = CLOCK_START;
  const config = makeConfig({
    EVOLVE_MARKET_MODE: "live",
    JUPITER_API_KEY: SECRET_KEY,
    EVOLVE_GENERATION_TICKS: "30",
  });
  const feed = createMarketFeed({
    config,
    fetchImpl: scriptedFetch([jsonResponse([fixtureToken()])]),
    now: () => clock,
    random: createSeededRandom("state"),
  });
  const simulation = createSimulation({ config, feed, now: () => clock, random: createSeededRandom("state") });

  for (let index = 0; index < 60; index += 1) {
    await feed.advance(clock);
    simulation.advanceTick();
    clock += 900;
  }

  const snapshot = {
    ...simulation.snapshot(),
    config: sanitizeForPublic({ requestedMode: config.requestedMode, apiKeyConfigured: config.apiKeyConfigured }),
  };

  const serialized = serializeForPublic(snapshot, { secrets: config.secretValues });
  assertEqual(serialized.includes(SECRET_KEY), false, "serialized state must not contain the key");
  assertEqual(/NaN/.test(serialized), false, "serialized state must not contain NaN");
  assertEqual(/Infinity/.test(serialized), false, "serialized state must not contain Infinity");
  assertEqual(/undefined/.test(serialized), false, "serialized state must not contain undefined");
  assert(serialized.length > 1000, "the snapshot should carry real content");

  const parsed = JSON.parse(serialized);
  assert(parsed.marketFeed, "the snapshot must expose marketFeed health");
  assertEqual(typeof parsed.marketFeed.banner, "string", "a banner string must be present");
  assertEqual(typeof parsed.marketFeed.effectiveMode, "string", "an effective mode must be present");
  assertEqual(parsed.marketFeed.apiKeyConfigured, true, "health may report key presence, never the key");
  assertEqual(parsed.paperOnly, true, "the snapshot must declare paper-only mode");
  assertEqual(parsed.guards.submissionCapability, "not implemented", "guards must deny submission");
  assertEqual(parsed.guards.paperOnly, true, "guards must declare paper-only");
  assert(Array.isArray(parsed.markets), "markets must be an array");
  assert(Array.isArray(parsed.topAgents), "agents must be an array");
  assert(Array.isArray(parsed.species), "species must be an array");
  assertFiniteNumbers(parsed, "parsed snapshot");

  // Booleans and health flags must survive: the dashboard renders them, and a
  // sanitizer that silently dropped them would hide the degraded state.
  const flags = sanitizeForPublic(
    {
      healthy: true,
      entriesPaused: false,
      apiKeyConfigured: true,
      keyless: false,
      apiKey: SECRET_KEY,
      apiKeySource: "JUPITER_API_KEY",
    },
    { secrets: [SECRET_KEY] },
  );
  assertEqual(flags.healthy, true, "true booleans must survive sanitization");
  assertEqual(flags.entriesPaused, false, "false booleans must survive sanitization");
  assertEqual(flags.keyless, false, "false booleans must survive sanitization");
  assertEqual(flags.apiKeyConfigured, true, "apiKeyConfigured must survive sanitization");
  assertEqual("apiKey" in flags, false, "the exact apiKey field must be dropped");
  assertEqual(flags.apiKeySource, "JUPITER_API_KEY", "non-secret metadata may be reported");

  // The dashboard route must reuse the very same sanitizer rather than its own
  // drifting copy.
  const routeSource = await readFile(
    path.join(PROJECT_ROOT, "src/app/api/state/route.ts"),
    "utf8",
  );
  assert(
    /scripts\/lib\/sanitize\.mjs/.test(routeSource),
    "the state route must import the shared sanitizer",
  );

  // A hostile object must not be able to smuggle a credential into state.
  const hostile = sanitizeForPublic(
    {
      apiKey: SECRET_KEY,
      authorization: `Bearer ${SECRET_KEY}`,
      nested: { api_key: SECRET_KEY, ok: 1 },
      message: `request failed with ${SECRET_KEY}`,
      bad: { value: Number.NaN },
    },
    { secrets: [SECRET_KEY] },
  );
  assertEqual(JSON.stringify(hostile).includes(SECRET_KEY), false, "sensitive keys must be stripped");
  assertEqual(hostile.bad.value, null, "non-finite numbers must become null");
});

// ---------------------------------------------------------------------------
// 15. Engine smoke test (also available as npm run smoke:engine)
// ---------------------------------------------------------------------------

test("15. Synthetic engine smoke run evolves a healthy population", () => {
  const config = makeConfig({
    EVOLVE_MARKET_MODE: "synthetic",
    EVOLVE_GENERATION_TICKS: "30",
    EVOLVE_POPULATION: "48",
  });
  const feed = createMarketFeed({
    config,
    fetchImpl: scriptedFetch([new Error("offline")]),
    random: createSeededRandom("smoke"),
  });
  const simulation = createSimulation({ config, feed, random: createSeededRandom("smoke") });

  for (let tick = 0; tick < 180; tick += 1) {
    feed.advance();
    simulation.advanceTick();
  }

  const snapshot = simulation.snapshot();
  assertEqual(snapshot.generation, 7, "six generation boundaries should have elapsed");
  assertEqual(snapshot.stats.population, 48, "population size must be constant");
  assertEqual(snapshot.stats.alive, 48, "the population must remain full");
  assertEqual(snapshot.species.length, 6, "all six species must exist");
  const extinct = snapshot.species.filter((species) => species.count === 0);
  assert(
    extinct.length <= 1,
    `selection must not broadly wipe species out (extinct: ${extinct.map((species) => species.name).join(", ") || "none"})`,
  );
  assert(
    snapshot.species.filter((species) => species.count > 0).length >= 5,
    "at least five species must persist",
  );

  // Species specialization must be observable against one shared universe:
  // every species needs prey, and conservative genomes must only accept pools
  // far deeper than the launch-hunting genomes accept.
  const markets = feed.markets();
  const acceptedLiquidity = (species) => {
    const accepted = [];
    for (let sample = 0; sample < 12; sample += 1) {
      const genome = randomGenome(species, createSeededRandom(`${species}-${sample}`));
      for (const market of markets) {
        if (passesGates(genome, market, { minLiquidityUsd: 0 })) accepted.push(market.liquidity);
      }
    }
    return accepted;
  };

  const median = (values) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };

  const survivorPools = acceptedLiquidity("Liquidity");
  const genesisPools = acceptedLiquidity("Genesis Hunter");
  assert(survivorPools.length > 0, "conservative genomes need deep-liquidity prey");
  assert(genesisPools.length > 0, "launch genomes need fresh-pool prey");
  assert(
    median(survivorPools) > median(genesisPools) * 3,
    "conservative genomes must specialise in far deeper pools than launch hunters",
  );
  assert(
    snapshot.events.some((event) => event.type === "GENERATION"),
    "generation events must be logged",
  );
  assert(
    snapshot.events.some((event) => event.type === "BIRTH") &&
      snapshot.events.some((event) => event.type === "DEATH"),
    "birth and death events must be logged",
  );
  assert(
    snapshot.topAgents.every((agent) => Number.isFinite(agent.fitness)),
    "every leaderboard fitness must be finite",
  );
  assert(
    snapshot.topAgents.some((agent) => agent.parents.length > 0),
    "genealogy must record parents",
  );
  assertFiniteNumbers(snapshot, "smoke snapshot");
});

/** Helper used by case 9 so the engine can be inspected without persisting. */
function simulationSnapshotFor(feed, config, now) {
  const simulation = createSimulation({ config, feed, now });
  simulation.addEvent("MARKET", `probe failed with ${SECRET_KEY}`);
  for (let index = 0; index < 3; index += 1) simulation.advanceTick();
  return simulation.snapshot();
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run() {
  const failures = [];
  let passed = 0;

  for (const testCase of cases) {
    const started = Date.now();
    try {
      await testCase.fn();
      passed += 1;
      console.log(`  ✓ ${testCase.name} (${Date.now() - started}ms)`);
    } catch (error) {
      failures.push({ name: testCase.name, error });
      console.log(`  ✗ ${testCase.name}`);
      console.log(`      ${error?.message ?? error}`);
    }
  }

  console.log(`\nEVOLVE market validation: ${passed}/${cases.length} checks passed`);
  if (failures.length > 0) {
    console.log("Failed checks:");
    for (const failure of failures) console.log(`  - ${failure.name}`);
    process.exitCode = 1;
    return;
  }
  console.log("All Phase 2 market checks passed. Paper-only guarantees intact.");
}

run().catch((error) => {
  console.error("validation runner crashed:", error);
  process.exitCode = 1;
});
