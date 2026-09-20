#!/usr/bin/env node
/**
 * EVOLVE Phase 5I-PS — Jev-assisted PAPER SHADOW dashboard experiment
 * validation suite. FULLY OFFLINE.
 *
 * NOTHING HERE TOUCHES THE NETWORK OR A PROVIDER. Every session is driven
 * through the runner with:
 *   - a virtual clock (`now`/`sleep`),
 *   - an injected deterministic observation source,
 *   - a scripted deterministic provider.
 *
 * The suite NEVER creates canonical 5I evidence: every session lives in a temp
 * directory, and the REAL `.evolve/jev-direction` tree is asserted byte-unchanged
 * at the end of the run.
 *
 * Run with: npm run validate:jev-paper
 */

import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { digestOf } from "./lib/hash.mjs";
import { sanitizeForPublic } from "./lib/sanitize.mjs";
import { simulateEntry, simulateExit } from "./engine/paper.mjs";
import { resolveJevConfig } from "./jev/config.mjs";
import { buildDirectionQuestions, DIRECTION_QUESTION_NAME } from "./jev/direction/questions.mjs";
import { BENCHMARK_MARKET } from "./jev/direction/definition.mjs";
import {
  PAPER_SHADOW_ACCOUNTING_NOTE,
  PAPER_SHADOW_ACTIONS,
  PAPER_SHADOW_CLASSIFICATION,
  PAPER_SHADOW_DEFAULT_CADENCE_MS,
  PAPER_SHADOW_DEFAULT_DURATION_MINUTES,
  PAPER_SHADOW_EVENTS_FILE,
  PAPER_SHADOW_EXCLUSION_NOTE,
  PAPER_SHADOW_LABEL,
  PAPER_SHADOW_POSITION_FRACTION,
  PAPER_SHADOW_ROOT_DIR,
  PAPER_SHADOW_SESSION_FILE,
  PAPER_SHADOW_STARTING_CASH,
  PAPER_SHADOW_STATE_FILE,
  PAPER_SHADOW_SUMMARY_FILE,
  assertPaperShadowWriteTarget,
  isValidPaperShadowSessionId,
  paperShadowSessionIdFor,
} from "./jev/paper-shadow/definition.mjs";
import { enforcePaperShadowProviderPins } from "./jev/paper-shadow/settings.mjs";
import {
  PAPER_SHADOW_POLICY_DEFINITION,
  decidePaperAction,
  modelIntentFromProbability,
} from "./jev/paper-shadow/policy.mjs";
import {
  applyPaperEntry,
  applyPaperExit,
  createPaperAccount,
  markAccount,
} from "./jev/paper-shadow/account.mjs";
import {
  listPaperShadowSessions,
  readPaperShadowEvents,
  readPaperShadowState,
  readPaperShadowSummary,
} from "./jev/paper-shadow/storage.mjs";
import { runPaperShadow } from "./jev/paper-shadow/runner.mjs";
import { loadJevPaperShadowState } from "./jev/paper-shadow/dashboard.mjs";

/* ============================================================================
 * Harness
 * ==========================================================================*/

let PASSED = 0;
let FAILED = 0;
const FAILURES = [];

function test(name, fn) {
  try {
    fn();
    PASSED += 1;
    console.log(`  \u2713 ${name}`);
  } catch (error) {
    FAILED += 1;
    FAILURES.push({ name, error });
    console.log(`  \u2717 ${name}\n      ${error?.message ?? error}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    PASSED += 1;
    console.log(`  \u2713 ${name}`);
  } catch (error) {
    FAILED += 1;
    FAILURES.push({ name, error });
    console.log(`  \u2717 ${name}\n      ${error?.message ?? error}`);
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

function assertClose(actual, expected, tolerance, message) {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message ?? "closeness"}: expected ~${expected}, got ${actual}`);
  }
}

function assertIncludes(haystack, needle, message) {
  if (!String(haystack).includes(needle)) throw new Error(`${message ?? "includes"}: ${needle} not found`);
}

function assertExcludes(haystack, needle, message) {
  if (String(haystack).includes(needle)) throw new Error(`${message ?? "excludes"}: ${needle} unexpectedly found`);
}

function assertThrows(fn, message) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(message ?? "expected a throw");
}

/* ============================================================================
 * Fixtures
 * ==========================================================================*/

const FRICTION = Object.freeze({
  startingCash: PAPER_SHADOW_STARTING_CASH,
  baseFeeBps: 10,
  minSlippageBps: 20,
  slippageImpact: 0.6,
  slippageCapBps: 400,
  adverseBufferBps: 8,
  maxLiquidityFraction: 0.02,
  maxPositionFraction: 0.28,
});

function createClock(start = 1_750_000_000_000) {
  let time = start;
  return {
    now: () => time,
    sleep: async (ms) => {
      time += Math.max(0, ms);
    },
    advance: (ms) => {
      time += ms;
    },
    get: () => time,
    set: (value) => {
      time = value;
    },
  };
}

function createFixtureSource(clock, options = {}) {
  const price = options.price ?? 100;
  const liquidity = options.liquidity ?? 5_000_000;
  const staleMs = options.staleMs ?? 0;
  const ok = options.ok ?? true;
  const degraded = options.degraded ?? false;
  const reason = options.reason ?? null;
  const missingPrice = options.missingPrice ?? false;
  const markets = options.markets ?? null;
  let call = 0;

  return {
    async observeState() {
      const nowMs = clock.now();
      const observed = nowMs - staleMs;
      const observedPrice = missingPrice ? null : price;
      call += 1;
      return {
        ok,
        reason,
        stateObservedAt: new Date(observed).toISOString(),
        stateObservedAtMs: observed,
        receivedAt: new Date(observed).toISOString(),
        sourceEventAt: null,
        sourceEventAtMs: null,
        market: {
          mint: BENCHMARK_MARKET.baseMint,
          price: observedPrice,
          liquidity,
          synthetic: false,
          source: "Jupiter Tokens V2",
        },
        token: { mint: BENCHMARK_MARKET.baseMint, stats5m: {}, liquidity },
        quoteMarket: { mint: BENCHMARK_MARKET.quoteMint, price: 1 },
        universeMarkets:
          markets ??
          [{ mint: BENCHMARK_MARKET.baseMint, price: observedPrice, liquidity, volume5m: 1000, buySellRatio: 1.2, organicBuySellRatio: 1.1, poolAgeMs: 3_600_000 }],
        universeSummary: { tracked: 5, usable: 3, fresh: 3, max: 150 },
        health: { source: "Jupiter Tokens V2", endpoints: [], degraded },
        quoteObservationAvailable: true,
        callCount: call,
      };
    },
  };
}

function createScriptedProvider({ probabilities = [], failWith = null, latencyMs = 25 } = {}) {
  let index = 0;
  return {
    name: "typesafe-jev",
    model: "jev-1.13.0",
    upstream: "typesafe-ai",
    offline: false,
    external: true,
    async evaluate() {
      if (typeof failWith === "string") {
        return { ok: false, status: failWith, reason: "scripted failure" };
      }
      const probability = probabilities[Math.min(index, probabilities.length - 1)] ?? 0.6;
      index += 1;
      return {
        ok: true,
        model: "jev-1.13.0",
        requestId: `req-${index}`,
        latencyMs,
        usage: { input_tokens: 0, output_tokens: 0 },
        answers: { [DIRECTION_QUESTION_NAME]: { type: "noul", noul: probability } },
      };
    },
  };
}

async function makeTempRoot(prefix = "jev-paper-shadow-") {
  return mkdtemp(path.join(tmpdir(), prefix));
}

function makeSettings(overrides = {}) {
  const cadenceMs = overrides.cadenceMs ?? PAPER_SHADOW_DEFAULT_CADENCE_MS;
  const decisions = overrides.decisions ?? 4;
  return {
    version: 1,
    marketId: "SOL-USDC",
    durationMinutes: PAPER_SHADOW_DEFAULT_DURATION_MINUTES,
    durationMs: overrides.durationMs ?? decisions * cadenceMs,
    cadenceMs,
    startingCash: PAPER_SHADOW_STARTING_CASH,
    positionFraction: PAPER_SHADOW_POSITION_FRACTION,
    intentThreshold: 0.5,
    sessionId: overrides.sessionId ?? null,
    baseRoot: overrides.baseRoot ?? null,
    problems: [],
  };
}

async function runSession(options = {}) {
  const root = options.root ?? (await makeTempRoot());
  const clock = options.clock ?? createClock();
  const settings = makeSettings({ cadenceMs: options.cadenceMs, decisions: options.decisions, baseRoot: root, sessionId: options.sessionId });
  const source = options.source ?? createFixtureSource(clock, options.sourceOptions ?? {});
  const provider = options.provider ?? createScriptedProvider({ probabilities: options.probabilities ?? [0.7] });
  const startedAtMs = clock.get();
  const result = await runPaperShadow({
    settings,
    provider,
    source,
    questions: buildDirectionQuestions(),
    friction: FRICTION,
    baseRoot: root,
    now: clock.now,
    sleep: clock.sleep,
    control: options.control ?? null,
    resume: options.resume === true,
    priorState: options.priorState ?? { startedAtMs, sessionId: settings.sessionId },
  });
  return { root, clock, settings, result, startedAtMs };
}

/* ============================================================================
 * Read-only helpers
 * ==========================================================================*/

async function snapshotTree(root) {
  const out = [];
  const walk = async (dir, rel) => {
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      const relative = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(absolute, relative);
        continue;
      }
      const content = await readFile(absolute, "utf8");
      out.push(`${relative}:${digestOf(content)}`);
    }
  };
  await walk(root, "");
  return out;
}

const CANONICAL_5I_ROOT = path.join(".evolve", "jev-direction");
const CANONICAL_REPLICATION_ID = "jrep-20260920T090716Z-97c862";
const CANONICAL_TEMPORAL_ID = "jtrp-20260920T151033Z-f1c16a";

/* ============================================================================
 * Main
 * ==========================================================================*/

async function main() {
  console.log("Phase 5I-PS — Jev-assisted PAPER SHADOW dashboard experiment (offline)\n");

  const beforeCanonical = await snapshotTree(CANONICAL_5I_ROOT);

  const tempDirs = [];
  async function track() {
    const dir = await makeTempRoot();
    tempDirs.push(dir);
    return dir;
  }

  /* ---- A. classification + identity -------------------------------------- */
  console.log("A. Classification, identity, and frozen constants");
  await testAsync("session.json persists the exact classification", async () => {
    const root = await track();
    const { result } = await runSession({ root, probabilities: [0.7], decisions: 1 });
    const session = JSON.parse(await readFile(path.join(root, result.sessionId, PAPER_SHADOW_SESSION_FILE), "utf8"));
    for (const [key, value] of Object.entries(PAPER_SHADOW_CLASSIFICATION)) {
      assertEqual(session[key], value, `classification ${key}`);
    }
  });

  test("session ids follow jpaper-<UTC timestamp>-<digest>", () => {
    const id = paperShadowSessionIdFor({ startedAt: Date.UTC(2026, 8, 20, 15, 10, 33), salt: "" });
    assertTrue(/^jpaper-\d{8}T\d{6}Z-[0-9a-z]{6}$/.test(id), `unexpected session id ${id}`);
    assertTrue(isValidPaperShadowSessionId(id), "session id must validate");
    assertTrue(!isValidPaperShadowSessionId("jdir-20260920T151033Z-abcdef"), "a 5I id must not validate");
  });

  test("frozen constants are the documented defaults", () => {
    assertEqual(PAPER_SHADOW_STARTING_CASH, 100, "starting cash");
    assertEqual(PAPER_SHADOW_POSITION_FRACTION, 0.25, "position fraction");
    assertEqual(PAPER_SHADOW_DEFAULT_DURATION_MINUTES, 60, "default duration");
    assertEqual(PAPER_SHADOW_DEFAULT_CADENCE_MS, 30000, "default cadence");
    assertEqual(PAPER_SHADOW_LABEL, "JEV PAPER SHADOW • DEVELOPMENT ONLY", "label");
    assertIncludes(PAPER_SHADOW_ACCOUNTING_NOTE, "Not replication evidence", "accounting note");
    assertIncludes(PAPER_SHADOW_EXCLUSION_NOTE, "excluded from replication/Arena/deployment evidence", "exclusion note");
  });

  /* ---- B. policy ---------------------------------------------------------- */
  console.log("\nB. Deterministic paper policy");
  test("HIGHER while flat => ENTER", () => {
    const d = decidePaperAction({ hasPosition: false, modelIntent: "HIGHER", feedOk: true, price: 100 });
    assertEqual(d.action, PAPER_SHADOW_ACTIONS.ENTER, "action");
  });
  test("HIGHER while long => HOLD", () => {
    const d = decidePaperAction({ hasPosition: true, modelIntent: "HIGHER", feedOk: true, price: 100 });
    assertEqual(d.action, PAPER_SHADOW_ACTIONS.HOLD, "action");
  });
  test("LOWER while long => EXIT", () => {
    const d = decidePaperAction({ hasPosition: true, modelIntent: "LOWER", feedOk: true, price: 100 });
    assertEqual(d.action, PAPER_SHADOW_ACTIONS.EXIT, "action");
  });
  test("LOWER while flat => CASH", () => {
    const d = decidePaperAction({ hasPosition: false, modelIntent: "LOWER", feedOk: true, price: 100 });
    assertEqual(d.action, PAPER_SHADOW_ACTIONS.CASH, "action");
  });
  test("Jev failure (no intent) => NO_ACTION", () => {
    const d = decidePaperAction({ hasPosition: false, modelIntent: null, feedOk: true, price: 100 });
    assertEqual(d.action, PAPER_SHADOW_ACTIONS.NO_ACTION, "action");
    assertEqual(d.reason, "jev_unavailable", "reason");
  });
  test("degraded feed => NO_ACTION even when long", () => {
    const d = decidePaperAction({ hasPosition: true, modelIntent: "LOWER", feedOk: false, price: 100 });
    assertEqual(d.action, PAPER_SHADOW_ACTIONS.NO_ACTION, "action");
  });
  test("missing price => NO_ACTION", () => {
    const d = decidePaperAction({ hasPosition: false, modelIntent: "HIGHER", feedOk: true, price: null });
    assertEqual(d.action, PAPER_SHADOW_ACTIONS.NO_ACTION, "action");
    assertEqual(d.reason, "missing_price", "reason");
  });
  test("the frozen boundary is 0.50 with NO hysteresis", () => {
    assertEqual(modelIntentFromProbability(0.5), "HIGHER", "0.50 boundary");
    assertEqual(modelIntentFromProbability(0.5000001), "HIGHER", "just above boundary");
    assertEqual(modelIntentFromProbability(0.4999999), "LOWER", "just below boundary");
    assertEqual(modelIntentFromProbability(Number.NaN), null, "NaN has no intent");
    assertEqual(PAPER_SHADOW_POLICY_DEFINITION.hysteresis, false, "no hysteresis");
    assertEqual(PAPER_SHADOW_POLICY_DEFINITION.confidenceThreshold, false, "no confidence threshold");
    assertEqual(PAPER_SHADOW_POLICY_DEFINITION.maximumOpenPositions, 1, "one position maximum");
  });

  /* ---- C. account model --------------------------------------------------- */
  console.log("\nC. Paper account model (reuses the engine paper machinery)");
  test("a new account starts flat at the starting cash", () => {
    const account = createPaperAccount({ startingCash: 100 });
    assertEqual(account.equity, 100, "equity");
    assertEqual(account.positionQty, 0, "flat");
  });
  test("an entry commits exactly 25% of available cash and pays engine friction", () => {
    const account = createPaperAccount({ startingCash: 100 });
    const result = applyPaperEntry({ account, price: 100, liquidityUsd: 5_000_000, friction: FRICTION, positionFraction: 0.25 });
    assertTrue(result.ok, "entry must fill");
    const expected = simulateEntry({ price: 100, notionalUsd: 25, liquidityUsd: 5_000_000, friction: FRICTION });
    assertClose(result.fill.feeUsd, expected.feeUsd, 1e-9, "fee must come from the engine paper module");
    assertClose(result.account.cash, 75, 1e-9, "cash spent");
    assertClose(result.account.positionQty, expected.qty, 1e-12, "quantity");
    assertTrue(result.account.costs > 0, "costs must be recorded");
  });
  test("an entry is capped by the configured liquidity fraction", () => {
    const account = createPaperAccount({ startingCash: 100 });
    const result = applyPaperEntry({ account, price: 100, liquidityUsd: 100, friction: FRICTION, positionFraction: 0.25 });
    assertTrue(result.ok, "entry must fill");
    // 2% of 100 = 2 USD max notional (well below the 25 USD cash fraction).
    assertClose(result.fill.cashSpent, 2, 1e-9, "liquidity-capped notional");
  });
  test("a round trip is net of fees and slippage, and classifies the trade", () => {
    let account = createPaperAccount({ startingCash: 100 });
    account = applyPaperEntry({ account, price: 100, liquidityUsd: 5_000_000, friction: FRICTION, positionFraction: 0.25 }).account;
    const exit = applyPaperExit({ account, price: 110, liquidityUsd: 5_000_000, friction: FRICTION });
    assertTrue(exit.ok, "exit must fill");
    assertTrue(exit.tradeNetPnl > 0, "a 10% price rise must be a winning trade after costs");
    assertEqual(exit.account.winningClosedTrades, 1, "winning trade counted");
    assertEqual(exit.account.losingClosedTrades, 0, "no losing trade");
    const expectedExit = simulateExit({ qty: account.positionQty, price: 110, liquidityUsd: 5_000_000, referencePrice: 100, friction: FRICTION });
    assertClose(exit.account.realizedPnl, expectedExit.netProceeds - 25, 1e-9, "realized P&L");
  });
  test("mark-to-market equity and drawdown are tracked", () => {
    let account = createPaperAccount({ startingCash: 100 });
    account = applyPaperEntry({ account, price: 100, liquidityUsd: 5_000_000, friction: FRICTION, positionFraction: 0.25 }).account;
    const up = markAccount(account, { markPrice: 150 });
    assertTrue(up.equity > 100, "equity rises with the mark");
    const down = markAccount(up, { markPrice: 80 });
    assertTrue(down.maxDrawdown > 0, "drawdown must be recorded");
    assertClose(down.netPnl, down.equity - 100, 1e-9, "net P&L == equity - starting cash");
  });
  test("a missing mark retains the last legitimate mark", () => {
    let account = createPaperAccount({ startingCash: 100 });
    account = applyPaperEntry({ account, price: 100, liquidityUsd: 5_000_000, friction: FRICTION, positionFraction: 0.25 }).account;
    const marked = markAccount(account, { markPrice: 120 });
    const retained = markAccount(marked, { markPrice: null });
    assertEqual(retained.positionMarkPrice, 120, "mark retained");
    assertEqual(retained.equity, marked.equity, "equity unchanged without a new mark");
  });

  /* ---- D. runner behaviour ----------------------------------------------- */
  console.log("\nD. Runner behaviour (deterministic, injected provider)");
  await testAsync("HIGHER while flat produces an ENTER fill", async () => {
    const { root, result } = await runSession({ probabilities: [0.9], decisions: 1 });
    const events = await readPaperShadowEvents(path.join(root, result.sessionId));
    assertEqual(events.length, 1, "one event");
    assertEqual(events[0].action, PAPER_SHADOW_ACTIONS.ENTER, "action");
    assertEqual(events[0].paperFill.side, "BUY", "fill side");
    assertEqual(events[0].previousAccountState, "FLAT", "previous state");
    assertTrue(events[0].paperFill.feeUsd > 0, "fee paid");
    assertTrue(events[0].paperFill.slippageBps >= FRICTION.minSlippageBps, "slippage floor respected");
  });
  await testAsync("HIGHER while long produces a HOLD", async () => {
    const { root, result } = await runSession({ probabilities: [0.9], decisions: 2 });
    const events = await readPaperShadowEvents(path.join(root, result.sessionId));
    assertEqual(events[0].action, PAPER_SHADOW_ACTIONS.ENTER, "first is entry");
    assertEqual(events[1].action, PAPER_SHADOW_ACTIONS.HOLD, "second is hold");
    assertEqual(events[1].paperFill, null, "hold has no fill");
  });
  await testAsync("LOWER while long produces an EXIT", async () => {
    const { root, result } = await runSession({ probabilities: [0.9, 0.1], decisions: 2 });
    const events = await readPaperShadowEvents(path.join(root, result.sessionId));
    assertEqual(events[1].action, PAPER_SHADOW_ACTIONS.EXIT, "exit action");
    assertEqual(events[1].paperFill.side, "SELL", "sell fill");
    assertEqual(events[1].previousAccountState, "LONG", "previous state");
    assertEqual(events[1].positionQty, 0, "flat after exit");
  });
  await testAsync("LOWER while flat produces CASH with no fill", async () => {
    const { root, result } = await runSession({ probabilities: [0.1], decisions: 1 });
    const events = await readPaperShadowEvents(path.join(root, result.sessionId));
    assertEqual(events[0].action, PAPER_SHADOW_ACTIONS.CASH, "cash action");
    assertEqual(events[0].paperFill, null, "no fill");
  });
  await testAsync("a Jev failure produces NO_ACTION and never trades", async () => {
    const { root, result } = await runSession({ provider: createScriptedProvider({ failWith: "JEV_UNAVAILABLE" }), decisions: 2 });
    const events = await readPaperShadowEvents(path.join(root, result.sessionId));
    assertEqual(events[0].action, PAPER_SHADOW_ACTIONS.NO_ACTION, "no action on failure");
    assertEqual(events[0].paperFill, null, "no fill on failure");
    assertEqual(events[0].modelIntent, null, "no intent");
    assertEqual(events[0].status, "JEV_UNAVAILABLE", "status recorded");
    const summary = await readPaperShadowSummary(path.join(root, result.sessionId));
    assertEqual(summary.enterCount, 0, "no entries");
    assertEqual(summary.jevFailures, 2, "failures counted");
  });
  await testAsync("a stale feed produces FEED_DEGRADED and no new entry", async () => {
    const root = await track();
    const clock = createClock();
    const source = createFixtureSource(clock, { staleMs: 60_000 });
    const { result } = await runSession({ root, clock, source, probabilities: [0.99], decisions: 2 });
    const events = await readPaperShadowEvents(path.join(root, result.sessionId));
    assertEqual(events[0].marketFeedHealth, "FEED_DEGRADED", "feed health");
    assertEqual(events[0].action, PAPER_SHADOW_ACTIONS.NO_ACTION, "no action");
    assertEqual(events[0].actionReason, "feed_degraded", "reason");
    assertEqual(events[0].jevCallAttempted, false, "Jev is not asked from a stale state");
    const summary = await readPaperShadowSummary(path.join(root, result.sessionId));
    assertEqual(summary.enterCount, 0, "no entries opened");
  });
  await testAsync("a stale feed retains an existing LONG position (no forced exit)", async () => {
    const root = await track();
    const clock = createClock();
    // Decision 1: fresh and HIGHER => ENTER. Decision 2: stale => NO_ACTION, still long.
    let call = 0;
    const source = {
      async observeState() {
        const nowMs = clock.now();
        const stale = call > 0 ? 60_000 : 0;
        call += 1;
        const observed = nowMs - stale;
        return {
          ok: true,
          reason: null,
          stateObservedAt: new Date(observed).toISOString(),
          stateObservedAtMs: observed,
          receivedAt: new Date(observed).toISOString(),
          market: { mint: BENCHMARK_MARKET.baseMint, price: 100, liquidity: 5_000_000, synthetic: false, source: "Jupiter Tokens V2" },
          token: { mint: BENCHMARK_MARKET.baseMint, stats5m: {}, liquidity: 5_000_000 },
          quoteMarket: null,
          universeMarkets: [],
          universeSummary: { tracked: 1, usable: 1, fresh: 1, max: 150 },
          health: { source: "Jupiter Tokens V2", endpoints: [], degraded: false },
          quoteObservationAvailable: true,
        };
      },
    };
    const { result } = await runSession({ root, clock, source, probabilities: [0.9, 0.1], decisions: 2 });
    const events = await readPaperShadowEvents(path.join(root, result.sessionId));
    assertEqual(events[0].action, PAPER_SHADOW_ACTIONS.ENTER, "first is entry");
    assertEqual(events[1].action, PAPER_SHADOW_ACTIONS.NO_ACTION, "second is no action");
    assertEqual(events[1].positionQty, events[0].positionQty, "position retained through the degraded feed");
  });
  await testAsync("a missing price produces NO_ACTION", async () => {
    const { root, result } = await runSession({ sourceOptions: { missingPrice: true }, probabilities: [0.99], decisions: 1 });
    const events = await readPaperShadowEvents(path.join(root, result.sessionId));
    assertEqual(events[0].action, PAPER_SHADOW_ACTIONS.NO_ACTION, "no action");
    assertEqual(events[0].actionReason, "missing_price", "reason");
  });

  /* ---- E. capture schema / summary ---------------------------------------- */
  console.log("\nE. Event capture and summary");
  await testAsync("event records carry the full decision schema", async () => {
    const { root, result } = await runSession({ probabilities: [0.7], decisions: 1 });
    const [event] = await readPaperShadowEvents(path.join(root, result.sessionId));
    const required = [
      "sequence",
      "scheduledAt",
      "observedAt",
      "stateFrozenAt",
      "market",
      "symbol",
      "mint",
      "referencePrice",
      "liquidityUsd",
      "provider",
      "model",
      "status",
      "requestId",
      "latencyMs",
      "pHigher",
      "pLower",
      "modelIntent",
      "stateDigest",
      "packetDigest",
      "previousAccountState",
      "action",
      "actionReason",
      "paperFill",
      "cash",
      "positionQty",
      "positionEntryPrice",
      "positionMarkPrice",
      "grossPnl",
      "netPnl",
      "unrealizedPnl",
      "realizedPnl",
      "costs",
      "equity",
      "returnPct",
      "maxDrawdown",
      "marketFeedHealth",
    ];
    for (const key of required) {
      assertTrue(Object.hasOwn(event, key), `event is missing '${key}'`);
    }
    assertTrue(typeof event.stateDigest === "string" && event.stateDigest.length === 64, "state digest");
    assertTrue(typeof event.packetDigest === "string" && event.packetDigest.length === 64, "packet digest");
  });
  await testAsync("events are appended in strict sequence order", async () => {
    const { root, result } = await runSession({ probabilities: [0.7], decisions: 5 });
    const events = await readPaperShadowEvents(path.join(root, result.sessionId));
    assertEqual(events.length, 5, "event count");
    for (let index = 0; index < events.length; index += 1) {
      assertEqual(events[index].sequence, index + 1, `sequence ${index}`);
    }
  });
  await testAsync("summary carries the required fields and no winner/verdict", async () => {
    const { root, result } = await runSession({ probabilities: [0.9, 0.1], decisions: 2 });
    const summary = await readPaperShadowSummary(path.join(root, result.sessionId));
    const required = [
      "decisions",
      "jevOk",
      "jevFailures",
      "higherCount",
      "lowerCount",
      "enterCount",
      "exitCount",
      "holdCount",
      "cashCount",
      "paperTrades",
      "winningClosedTrades",
      "losingClosedTrades",
      "startingCash",
      "endingCash",
      "endingPositionValue",
      "endingEquity",
      "grossPnl",
      "netPnl",
      "totalCosts",
      "maxDrawdown",
      "meanJevLatencyMs",
      "meanPHigher",
      "minPHigher",
      "maxPHigher",
    ];
    for (const key of required) assertTrue(Object.hasOwn(summary, key), `summary is missing '${key}'`);
    assertEqual(summary.paperTrades, summary.enterCount + summary.exitCount, "paperTrades == entries + exits");
    assertEqual(summary.winner, undefined, "no winner field");
    assertEqual(summary.profitable, undefined, "no profitability verdict");
    assertTrue(typeof summary.summaryDigest === "string", "summary digest");
  });
  await testAsync("the storage layout is exactly the documented four files", async () => {
    const { root, result } = await runSession({ probabilities: [0.7], decisions: 1 });
    const files = (await readdir(path.join(root, result.sessionId))).filter((name) => !name.startsWith("provider-health"));
    const expected = [PAPER_SHADOW_EVENTS_FILE, PAPER_SHADOW_SESSION_FILE, PAPER_SHADOW_STATE_FILE, PAPER_SHADOW_SUMMARY_FILE].sort();
    assertEqual(JSON.stringify(files.sort()), JSON.stringify(expected), "session tree files");
  });
  await testAsync("state.json publishes a bounded recent-decision table and equity series", async () => {
    const { root, result } = await runSession({ probabilities: [0.7], decisions: 3 });
    const state = await readPaperShadowState(path.join(root, result.sessionId));
    assertTrue(Array.isArray(state.recentDecisions), "recent decisions");
    assertTrue(state.recentDecisions.length <= 20, "bounded rows");
    assertEqual(state.equitySeries.length, 3, "equity points");
    assertEqual(state.marketFeedHealth, "LIVE", "feed health");
  });

  /* ---- F. resume + interrupt --------------------------------------------- */
  console.log("\nF. Restart / read state, and Ctrl+C finalize");
  await testAsync("resuming continues the sequence and preserves the account", async () => {
    const root = await track();
    const clock = createClock();
    const first = await runSession({ root, clock, probabilities: [0.9], decisions: 2 });
    const firstEvents = await readPaperShadowEvents(path.join(root, first.result.sessionId));
    assertEqual(firstEvents.length, 2, "first run decisions");
    const firstState = await readPaperShadowState(path.join(root, first.result.sessionId));

    const second = await runPaperShadow({
      settings: makeSettings({ cadenceMs: PAPER_SHADOW_DEFAULT_CADENCE_MS, decisions: 4, baseRoot: root, sessionId: first.result.sessionId }),
      provider: createScriptedProvider({ probabilities: [0.9] }),
      source: createFixtureSource(clock, {}),
      questions: buildDirectionQuestions(),
      friction: FRICTION,
      baseRoot: root,
      now: clock.now,
      sleep: clock.sleep,
      resume: true,
      priorState: { ...firstState, startedAtMs: first.startedAtMs, sessionId: first.result.sessionId },
    });

    const events = await readPaperShadowEvents(path.join(root, second.sessionId));
    assertEqual(events.length, 4, "resumed run appends two more events");
    assertEqual(events[2].sequence, 3, "sequence continues");
    const summary = await readPaperShadowSummary(path.join(root, second.sessionId));
    assertEqual(summary.decisions, 4, "total decisions");
    assertEqual(summary.enterCount, 1, "the account was preserved across the restart");
  });
  await testAsync("an interrupt finalizes the summary cleanly", async () => {
    const root = await track();
    const clock = createClock();
    const control = { stopped: false };
    // Stop after the first decision by flipping the control during the run.
    const source = {
      async observeState() {
        control.stopped = true;
        return createFixtureSource(clock, {}).observeState();
      },
    };
    const { result } = await runSession({ root, clock, source, probabilities: [0.9], decisions: 10, control });
    assertEqual(result.session.status, "INTERRUPTED", "status");
    assertEqual(result.interrupted, true, "interrupted flag");
    const summary = await readPaperShadowSummary(path.join(root, result.sessionId));
    assertEqual(summary.status, "INTERRUPTED", "summary status");
    assertTrue(summary.decisions >= 1, "at least one decision was recorded before the stop");
  });

  /* ---- G. security -------------------------------------------------------- */
  console.log("\nG. Provider enforcement and secret safety");
  test("direct typesafe-jev with the pinned model is accepted", () => {
    const envConfig = resolveJevConfig({
      EVOLVE_JEV_PROVIDER: "typesafe-jev",
      EVOLVE_JEV_API_KEY: "test-key-12345678",
      EVOLVE_JEV_MODEL: "jev-1.13.0",
    });
    const pins = enforcePaperShadowProviderPins({ envConfig });
    assertTrue(pins.ok, `expected ok, got: ${pins.problems.join("; ")}`);
    assertEqual(pins.provider, "typesafe-jev", "provider");
    assertEqual(pins.model, "jev-1.13.0", "model");
    assertEqual(pins.identity.gatewayUsed, false, "gateway");
  });
  test("mock-jev is refused", () => {
    const envConfig = resolveJevConfig({ EVOLVE_JEV_PROVIDER: "mock-jev", EVOLVE_JEV_API_KEY: "test-key-12345678" });
    assertTrue(!enforcePaperShadowProviderPins({ envConfig }).ok, "mock must be refused");
  });
  test("vercel-jev (the AI Gateway) is refused", () => {
    const envConfig = resolveJevConfig({
      EVOLVE_JEV_PROVIDER: "vercel-jev",
      AI_GATEWAY_API_KEY: "gateway-key-1234",
    });
    assertTrue(!enforcePaperShadowProviderPins({ envConfig }).ok, "gateway route must be refused");
  });
  test("a disabled provider is refused", () => {
    const envConfig = resolveJevConfig({});
    assertTrue(!enforcePaperShadowProviderPins({ envConfig }).ok, "disabled must be refused");
  });
  test("an unknown provider name is refused", () => {
    const envConfig = resolveJevConfig({ EVOLVE_JEV_PROVIDER: "banana" });
    assertTrue(!enforcePaperShadowProviderPins({ envConfig }).ok, "unknown must be refused");
  });
  test("a failover transport chain to the gateway is refused", () => {
    const envConfig = resolveJevConfig({
      EVOLVE_JEV_PROVIDER: "typesafe-jev",
      EVOLVE_JEV_API_KEY: "test-key-12345678",
      EVOLVE_JEV_TRANSPORT_CHAIN: "vercel-jev,typesafe-jev",
      AI_GATEWAY_API_KEY: "gateway-key-1234",
    });
    assertTrue(!enforcePaperShadowProviderPins({ envConfig }).ok, "chain must be refused");
  });
  test("a non-pinned / moving model alias is refused", () => {
    const envConfig = resolveJevConfig({
      EVOLVE_JEV_PROVIDER: "typesafe-jev",
      EVOLVE_JEV_API_KEY: "test-key-12345678",
      EVOLVE_JEV_MODEL: "jev-latest",
    });
    assertTrue(!enforcePaperShadowProviderPins({ envConfig }).ok, "moving alias must be refused");
  });
  test("a missing direct-TypeSafe credential is refused", () => {
    const envConfig = resolveJevConfig({ EVOLVE_JEV_PROVIDER: "typesafe-jev" });
    assertTrue(!enforcePaperShadowProviderPins({ envConfig }).ok, "missing key must be refused");
  });
  await testAsync("no credential is ever persisted to session, state, or events", async () => {
    const root = await track();
    const secret = "sk-paper-shadow-secret-abcdef0123456789";
    const { result } = await runSession({ root, probabilities: [0.7], decisions: 1 });
    const sessionDir = path.join(root, result.sessionId);
    const sessionText = await readFile(path.join(sessionDir, PAPER_SHADOW_SESSION_FILE), "utf8");
    const stateText = await readFile(path.join(sessionDir, PAPER_SHADOW_STATE_FILE), "utf8");
    const summaryText = await readFile(path.join(sessionDir, PAPER_SHADOW_SUMMARY_FILE), "utf8");
    const eventsText = await readFile(path.join(sessionDir, PAPER_SHADOW_EVENTS_FILE), "utf8");
    for (const text of [sessionText, stateText, summaryText, eventsText]) assertExcludes(text, secret, "secret leaked");
    assertExcludes(sessionText, "apiKey", "credential field leaked");
  });
  test("the sanitizer strips credential-shaped fields", () => {
    // Built by concatenation so this validation file itself never contains a
    // real credential-shaped literal (the repository's own no-wallet guard
    // scans every line of every script for them).
    const credentialKey = ["private", "Key"].join("");
    const payload = { apiKey: "sk-secret-1234", apiKeyConfigured: true, nested: { ok: 1 } };
    payload.nested[credentialKey] = "x";
    const sanitized = sanitizeForPublic(payload);
    assertEqual(sanitized.apiKey, undefined, "apiKey dropped");
    assertEqual(sanitized.nested[credentialKey], undefined, "credential field dropped");
    assertEqual(sanitized.apiKeyConfigured, true, "non-secret boolean kept");
  });

  /* ---- H. dashboard contract --------------------------------------------- */
  console.log("\nH. Dashboard state contract");
  await testAsync("loadJevPaperShadowState reads the newest session compactly", async () => {
    const root = await track();
    const evolveRoot = path.join(root, "evolve");
    const { result } = await runSession({ root: path.join(evolveRoot, "jev-paper-shadow"), probabilities: [0.7], decisions: 2 });
    const block = await loadJevPaperShadowState(evolveRoot);
    assertTrue(block.available, "available");
    assertEqual(block.sessionId, result.sessionId, "session id");
    assertEqual(block.provider, "typesafe-jev", "provider");
    assertEqual(block.model, "jev-1.13.0", "model");
    assertEqual(block.gatewayUsed, false, "gateway used");
    assertTrue(Array.isArray(block.recentDecisions), "recent decisions");
    assertEqual(block.canonicalEvidence, false, "not canonical evidence");
    assertEqual(block.replicationEvidence, false, "not replication evidence");
    assertEqual(block.arenaEligible, false, "not arena eligible");
    assertEqual(block.deploymentEligible, false, "not deployment eligible");
  });
  await testAsync("the dashboard block never carries raw packet contents", async () => {
    const root = await track();
    const evolveRoot = path.join(root, "evolve");
    await runSession({ root: path.join(evolveRoot, "jev-paper-shadow"), probabilities: [0.7], decisions: 1 });
    const block = await loadJevPaperShadowState(evolveRoot);
    const text = JSON.stringify(block);
    assertExcludes(text, "unavailableFeatureFamilies", "no packet vocabulary");
    assertExcludes(text, "recentObservationHistory", "no packet history");
    assertExcludes(text, "packetDigest", "no raw packet digest");
    assertExcludes(text, "excludedEvidenceClasses", "no packet exclusion list");
  });
  await testAsync("the dashboard block is loaded from a temp `.evolve` without touching the sealed contract", async () => {
    const root = await track();
    const evolveRoot = path.join(root, "evolve");
    await mkdir(evolveRoot, { recursive: true });
    await runSession({ root: path.join(evolveRoot, "jev-paper-shadow"), probabilities: [0.7], decisions: 1 });
    const block = await loadJevPaperShadowState(evolveRoot);
    assertTrue(block.available, "available");
    assertEqual(block.sessionId !== null, true, "session id present");
  });
  await testAsync("the API route attaches jevPaperShadow as its own field, never merged", async () => {
    const route = await readFile(path.join("src", "app", "api", "state", "route.ts"), "utf8");
    assertIncludes(route, "loadJevPaperShadowState", "route loads the paper-shadow block");
    assertIncludes(route, "jevPaperShadow", "route exposes the field");
    assertIncludes(route, "{ ...body, jevPaperShadow }", "attached onto the state document");
    assertIncludes(route, "never merged into `jevShadow`", "documented separation from jevShadow");
  });
  await testAsync("the dashboard UI and route reference jevPaperShadow (TypeScript shape)", async () => {
    const page = await readFile(path.join("src", "app", "page.tsx"), "utf8");
    assertIncludes(page, "jevPaperShadow", "page.tsx state field");
    assertIncludes(page, "JevPaperShadowPanel", "page.tsx panel component");
    assertIncludes(page, "JEV PAPER SHADOW", "page.tsx panel label");
    assertIncludes(page, "ResponsiveContainer", "page.tsx equity chart");
    const route = await readFile(path.join("src", "app", "api", "state", "route.ts"), "utf8");
    assertIncludes(route, "jev-paper-shadow", "route doc");
    // The byte-frozen Phase 5H.0 sealed contract file must NOT change.
    const contract = await readFile(path.join("scripts", "lib", "dashboard-state.mjs"), "utf8");
    assertExcludes(contract, "jevPaperShadow", "the sealed contract stays byte-identical");
  });

  /* ---- I. isolation ------------------------------------------------------- */
  console.log("\nI. Isolation from canonical 5I / Arena / Shadow trees");
  test("the write guard refuses a Phase 5I evidence path", () => {
    assertThrows(() => assertPaperShadowWriteTarget(path.join(CANONICAL_5I_ROOT, "experiments", "x")), "5I path refused");
    assertThrows(() => assertPaperShadowWriteTarget(path.join(".evolve", "shadow", "c.json")), "shadow path refused");
    assertThrows(() => assertPaperShadowWriteTarget(path.join(".evolve", "arenas", "a.json")), "arena path refused");
    assertTrue(assertPaperShadowWriteTarget(path.join(PAPER_SHADOW_ROOT_DIR, "jpaper-x", "state.json")), "own tree allowed");
  });
  await testAsync("a session writes only inside its own temp base root", async () => {
    const root = await track();
    const { result } = await runSession({ root, probabilities: [0.7], decisions: 2 });
    const sessions = await listPaperShadowSessions(root);
    assertEqual(sessions.length, 1, "exactly one session tree");
    assertEqual(sessions[0], result.sessionId, "session id matches");
  });
  await testAsync("no wallet / signing / trading capability exists in the subsystem", async () => {
    const files = [
      path.join("scripts", "jev-paper.mjs"),
      ...(await readdir(path.join("scripts", "jev", "paper-shadow"))).filter((n) => n.endsWith(".mjs")).map((n) => path.join("scripts", "jev", "paper-shadow", n)),
    ];
    // Tokens are assembled from parts so this file's own source never contains a
    // real forbidden literal (the repository guard scans every script line).
    const token = (...parts) => parts.join("");
    const forbidden = [
      new RegExp(`\\b${token("sign", "Transaction")}\\b`),
      new RegExp(`\\b${token("send", "Transaction")}\\b`),
      new RegExp(`\\b${token("sign", "Message")}\\b`),
      new RegExp(`\\bnew ${token("Key", "pair")}\\b`),
      new RegExp(`\\b${token("wallet", "Adapter")}\\b`),
      new RegExp(`\\b${token("place", "Order")}\\b`),
      new RegExp(`\\b${token("submit", "Order")}\\b`),
      new RegExp(`\\bnew ${token("Con", "nection")}\\b`),
      new RegExp(`${token("@solana", "/web3")}`),
    ];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const pattern of forbidden) {
        assertTrue(!pattern.test(text), `${file} matches forbidden capability ${pattern}`);
      }
    }
  });

  /* ---- Cleanup + canonical barrier --------------------------------------- */
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });

  const afterCanonical = await snapshotTree(CANONICAL_5I_ROOT);
  console.log("\nJ. Canonical 5I evidence barriers");
  test("the canonical Phase 5I tree is byte-identical after this suite", () => {
    assertEqual(JSON.stringify(afterCanonical), JSON.stringify(beforeCanonical), "jev-direction tree changed");
  });
  await testAsync("the named canonical replication/temporal sessions are present and untouched", async () => {
    if (beforeCanonical.length === 0) {
      console.log("      (no .evolve/jev-direction in this checkout — barrier asserted via the write guard only)");
      return;
    }
    const paths = beforeCanonical.map((entry) => entry.split(":")[0]);
    const replicationPresent = paths.some((entry) => entry.includes(CANONICAL_REPLICATION_ID));
    const temporalPresent = paths.some((entry) => entry.includes(CANONICAL_TEMPORAL_ID));
    assertTrue(replicationPresent, `canonical replication ${CANONICAL_REPLICATION_ID} missing`);
    assertTrue(temporalPresent, `canonical temporal ${CANONICAL_TEMPORAL_ID} missing`);
  });

  console.log("");
  console.log(`Phase 5I-PS validation: ${PASSED} passed, ${FAILED} failed`);
  if (FAILED > 0) {
    for (const failure of FAILURES) console.error(`  \u2717 ${failure.name}: ${failure.error?.stack ?? failure.error}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("validation crashed:", error?.stack ?? error);
  process.exitCode = 1;
});
