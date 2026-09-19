#!/usr/bin/env node
/**
 * EVOLVE Phase 5F.1 validation suite — RESILIENT JEV TRANSPORT.
 *
 * Proves the EXPLICIT, EVOLVE-OWNED resilience layer that sits strictly BELOW
 * one logical Jev decision:
 *
 *   ONE logical Jev decision
 *     └── 1..N bounded PHYSICAL transport attempts
 *           retry ONLY transient 429 / 5xx / timeout / network failures
 *           bounded exponential backoff + bounded jitter
 *           Retry-After honoured (seconds / HTTP-date / malformed / clamped)
 *           optional same-Jev transport chain (credential-gated, never another model)
 *           persistent, bounded provider-health cooldown (escalating, clamped, resettable)
 *
 * It also re-proves the surrounding invariants: SDK `maxRetries` stays 0, a
 * retried call is still ONE logical decision, every physical attempt is
 * persisted (failed ones included), the external-intelligence bridge keeps its
 * exact semantics (an `escalate_to_deep_research` answer invokes NOTHING), and
 * every frozen artifact — the real V2 capture, the legacy V1 capture, Wave 1,
 * Wave 2, the six replication datasets, the frozen cohorts, and the evaluation
 * contract digest — is byte-unchanged.
 *
 * Fully OFFLINE and deterministic: every delay is injected (zero real time),
 * every random draw is injected, no provider is ever called over the network,
 * no capture is taken, no Agent-Reach/DeepSeek call is made, no Arena is run,
 * and nothing under the repository's `.evolve/` is written.
 *
 * Run with: npm run validate:phase5f1
 */

import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { canonicalJson } from "./lib/hash.mjs";

import { readCaptureManifest, runCapture, verifyCapture } from "./intelligence/capture.mjs";
import { resolveIntelligenceConfig } from "./intelligence/config.mjs";
import { INTELLIGENCE_FEATURE_VERSION_V2 } from "./intelligence/features.mjs";
import { buildExternalIntelligencePacket } from "./intelligence/packet.mjs";
import { replayCapture } from "./intelligence/replay.mjs";

import {
  JEV_STATUS,
  NO_JEV_DECISION,
  parseJevTransportChain,
  resolveJevConfig,
} from "./jev/config.mjs";
import { createMockJevProvider } from "./jev/providers/mock-jev.mjs";
import {
  VERCEL_JEV_MAX_RETRIES,
  VERCEL_JEV_PROVIDER,
  createVercelJevProvider,
} from "./jev/providers/vercel-jev.mjs";
import { createResilientJevProvider, resolveJevProviderChain } from "./jev/provider.mjs";
import {
  JEV_JITTER_RATIO,
  JEV_RETRY_AFTER_MAX_MS,
  RETRYABLE_HTTP_STATUSES,
  RETRYABLE_JEV_STATUSES,
  backoffDelayMs,
  boundedProviderAttempt,
  createResilientJevTransport,
  isRetryableFailure,
  retryAfterMsOf,
} from "./jev/transport.mjs";
import {
  JEV_PROVIDER_HEALTH_DIR,
  JEV_PROVIDER_HEALTH_FIELDS,
  applySuccess,
  cooldownEscalationMs,
  emptyProviderHealth,
  isCooldownActive,
  readProviderHealth,
  writeProviderHealth,
} from "./jev/provider-health.mjs";
import {
  JEV_EXTERNAL_INTELLIGENCE_PACKET_KIND,
  JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_ID,
  buildExternalIntelligenceJevPacket,
  buildExternalIntelligenceQuestions,
  runExternalIntelligenceShadowDecision,
} from "./jev-external-bridge.mjs";
import { createJevRunBudget } from "./jev/runtime.mjs";
import { jevDecide } from "./jev/decide.mjs";

import { evaluationContractDigest } from "./replication/contract.mjs";
import { readFreeze } from "./replication/freeze.mjs";
import { readFrozenCohort } from "./replication/cohorts.mjs";
import {
  CANONICAL_EVALUATION_CONTRACT_DIGEST,
  CANONICAL_HISTORICAL_FREEZE_PATH,
  CANONICAL_WAVE_1_REPLICATION_ID,
  WAVE_1_DATASET_FINGERPRINTS,
  WAVE_1_DATASET_IDS,
  WAVE_2_DATASET_FINGERPRINTS,
  WAVE_2_DATASET_IDS,
} from "./replication/waves.mjs";

const REPO = process.cwd();
const NOW = Date.parse("2026-09-19T14:00:00.000Z");

const REAL_CAPTURE_ROOT = path.join(REPO, ".evolve", "intelligence");
const REAL_V2_CAPTURE_ID = "capture-20260919T130756Z";
const REAL_V2_PINS = Object.freeze({
  manifestDigest: "4e9b460fc190fc1bff793b3fea5f294fcdf1d76d51f19844db7b57431deba1ac",
  recordsDigest: "3774472ca3ad666537ebd193599b4ce9467fc8b1821da7b9c7597ea8917801f1",
  replayDigest: "14f8a36cd694060b76a58c37fad21be55752d3243bde7a982cea224239dcabf3",
  packetDigest: "8997cde24ceee60933c82b668256977bd79457be11f817b2c0fce7c4a09a32fd",
});
const LEGACY_V1_CAPTURE_ID = "capture-20260919T122601Z";
const LEGACY_V1_REPLAY_DIGEST = "b3904fe25071bdb85c555b2f8138ca61f06edf29aaccbc06a037c711d4ef7f07";

const FROZEN_COHORT_DIGESTS = Object.freeze({
  mock: "b26d63a2a0787e954ed7e4e63e668fe4664e58059508145345214facc4e12858",
  deepseek: "13c7c93d707b26f8b92042d488ff0a63f5de3f9f81b8145be4eac7a70cc550a8",
});

const DIRECT_KEY_SENTINEL = "direct-typesafe-key-0000000000";
const GATEWAY_KEY_SENTINEL = "gateway-vercel-key-1111111111";

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
function skip(reason) {
  skips.push(reason);
}
async function exists(target) {
  return stat(target).then(() => true).catch(() => false);
}

/* ============================================================================
 * Fixtures
 * ==========================================================================*/

const ctx = {
  tmp: null,
  healthRoot: null,
  jevBase: null,
  captureRoot: null,
  capture: null,
  externalPacket: null,
  jevPacket: null,
  realCaptureAvailable: false,
  evidenceAvailable: false,
  evidenceBaseline: {},
  clock: { ms: NOW },
  sleeps: [],
  sources: new Map(),
};

/** Deterministic zero-time sleep that RECORDS the requested delay. */
async function recordSleep(ms) {
  ctx.sleeps.push(ms);
}

/** Deterministic jitter sample: factor is exactly 1.0 at 0.5. */
function fixedRandom() {
  return 0.5;
}

function resetClock(ms = NOW) {
  ctx.clock.ms = ms;
  ctx.sleeps.length = 0;
}

// Each transport gets its OWN isolated health store unless a test opts into a
// shared one, so one test's cooldown can never silently gate another test.
let healthSeq = 0;
function freshHealthRoot(tag = "case") {
  healthSeq += 1;
  return path.join(ctx.healthRoot, "isolated", `${tag}-${healthSeq}`);
}

function transportSettings(overrides = {}) {
  return {
    maxAttempts: 3,
    backoffBaseMs: 1_000,
    backoffMaxMs: 30_000,
    cooldownMs: 60_000,
    cooldownMaxMs: 900_000,
    ...overrides,
  };
}

/**
 * A scriptable stub Jev provider. `results` is a queue; a function entry is
 * invoked for its outcome, and once the queue empties the last entry repeats.
 */
function scriptedProvider({ name = VERCEL_JEV_PROVIDER, model = "typesafe-ai/jev", transport = "vercel-ai-gateway", results = [] } = {}) {
  const calls = [];
  let last = { ok: true, model, requestId: "stub-request", answers: {}, usage: { input_tokens: 1, output_tokens: 1 } };
  return {
    name,
    model,
    transport,
    external: true,
    offline: false,
    syntheticDecision: false,
    calls,
    async evaluate(args) {
      calls.push(args);
      if (results.length > 0) last = results.shift();
      const outcome = typeof last === "function" ? last() : last;
      return { ...outcome };
    },
  };
}

const okResult = (requestId = "gen-1") => ({
  ok: true,
  model: "typesafe-ai/jev",
  requestId,
  answers: mockExternalAnswers(),
  usage: { input_tokens: 4, output_tokens: 4 },
  providerMetadata: {
    provider: VERCEL_JEV_PROVIDER,
    model: "typesafe-ai/jev",
    transport: "vercel-ai-gateway",
    providerAttemptCount: 1,
    providerStatus: JEV_STATUS.OK,
    formatVersion: 1,
  },
});

const failResult = (status, httpStatus = null) => ({
  ok: false,
  status,
  reason: `stub ${status}`,
  ...(httpStatus === null ? {} : { httpStatus }),
  providerMetadata: { providerStatus: status, httpStatus, providerAttemptCount: 1, formatVersion: 1 },
});

/** A resilient transport around ONE stub provider, using the real settings shape. */
function makeTransport({ results = [], settings = {}, overrideCooldown = false, healthRoot = undefined, provider = null } = {}) {
  const stub = provider ?? scriptedProvider({ results });
  const transport = createResilientJevTransport({
    providers: [stub],
    settings: transportSettings(settings),
    healthRoot: healthRoot ?? freshHealthRoot("transport"),
    overrideCooldown,
    sleepImpl: recordSleep,
    randomImpl: fixedRandom,
    now: () => ctx.clock.ms,
  });
  return { transport, stub };
}

/** Valid answers for the fixed external-intelligence question set. */
function mockExternalAnswers() {
  return {
    evidenceSufficiency: { type: "noul", noul: 0.3 },
    primaryConcern: { type: "choice", choice: "low_field_coverage", confidence: 0.6, probabilities: { low_field_coverage: 0.6 } },
    evidenceQuality: { type: "score", score: 2, confidence: 0.7, legend: {}, probabilities: { 2: 0.7 } },
    corroborationConfidence: { type: "noul", noul: 0.4 },
    researchDisposition: { type: "choice", choice: "observe", confidence: 0.6, probabilities: { observe: 0.6 } },
  };
}

function escalationAnswers() {
  return {
    ...mockExternalAnswers(),
    researchDisposition: {
      type: "choice",
      choice: "escalate_to_deep_research",
      confidence: 0.91,
      probabilities: { escalate_to_deep_research: 0.91 },
    },
  };
}

async function buildFixtures() {
  ctx.tmp = await mkdtemp(path.join(tmpdir(), "evolve-phase5f1-"));
  ctx.healthRoot = path.join(ctx.tmp, "provider-health");
  ctx.jevBase = path.join(ctx.tmp, "jev", "experiments");
  ctx.captureRoot = path.join(ctx.tmp, "captures");
  await mkdir(ctx.healthRoot, { recursive: true });
  await mkdir(ctx.jevBase, { recursive: true });

  ctx.capture = await runCapture({
    root: ctx.captureRoot,
    config: resolveIntelligenceConfig({ EVOLVE_INTELLIGENCE_PROVIDER: "mock" }),
    candidates: [{ symbol: "PHASE5F1FIXTURE", name: "Phase 5F.1 Fixture", mint: "F51Mint1111111111111111111111111111111111" }],
    provider: "mock",
    now: NOW,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  const replay = await replayCapture({ root: ctx.captureRoot, captureId: ctx.capture.captureId, asOf: null });
  ctx.externalPacket = buildExternalIntelligencePacket({ replay });
  // The bridge's own whitelist projection is what `jevDecide` receives.
  ctx.jevPacket = buildExternalIntelligenceJevPacket({ externalPacket: ctx.externalPacket });

  ctx.realCaptureAvailable = await exists(path.join(REAL_CAPTURE_ROOT, "2026-09-19", REAL_V2_CAPTURE_ID));
  ctx.evidenceAvailable =
    (await exists(path.join(REPO, ".evolve", "replication"))) && (await exists(path.join(REPO, ".evolve", "history")));
  if (ctx.evidenceAvailable) {
    ctx.evidenceBaseline = {
      waves: await metadataSnapshot(path.join(REPO, ".evolve", "replication", "waves")),
      cohorts: await metadataSnapshot(path.join(REPO, ".evolve", "replication", "cohorts")),
      history: await metadataSnapshot(path.join(REPO, ".evolve", "history")),
      intelligence: await metadataSnapshot(REAL_CAPTURE_ROOT),
      jev: await metadataSnapshot(path.join(REPO, ".evolve", "jev")),
    };
  }
  for (const file of [
    "scripts/jev/transport.mjs",
    "scripts/jev/provider-health.mjs",
    "scripts/jev/provider.mjs",
    "scripts/jev/decide.mjs",
    "scripts/jev/runtime.mjs",
    "scripts/jev/providers/vercel-jev.mjs",
    "scripts/jev/providers/typesafe-jev.mjs",
    "scripts/jev-external.mjs",
    "scripts/jev.mjs",
    "scripts/jev-external-bridge.mjs",
  ]) {
    ctx.sources.set(file, await readFile(file, "utf8"));
  }
}

async function disposeFixtures() {
  if (ctx.tmp) await rm(ctx.tmp, { recursive: true, force: true });
}

async function metadataSnapshot(root) {
  const out = {};
  const walk = async (dir) => {
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        const info = await stat(full);
        out[path.relative(root, full)] = `${info.size}:${info.mtimeMs}`;
      }
    }
  };
  await walk(root);
  return out;
}

function datasetDirFor(datasetId) {
  const stamp = datasetId.slice("session-".length, "session-".length + 8);
  const day = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
  return path.join(REPO, ".evolve", "history", day, datasetId);
}

async function datasetFingerprint(datasetId) {
  const manifest = JSON.parse(await readFile(path.join(datasetDirFor(datasetId), "manifest.json"), "utf8"));
  return manifest?.fingerprint?.combined ?? null;
}

/* ============================================================================
 * PART 1 — retry classification
 * ==========================================================================*/

test("1. SDK maxRetries remains 0 — EVOLVE owns every retry", async () => {
  assertEqual(VERCEL_JEV_MAX_RETRIES, 0, "the pinned constant is still 0");
  const seen = [];
  const provider = createVercelJevProvider({
    gatewayApiKey: GATEWAY_KEY_SENTINEL,
    evaluateImpl: async (args) => {
      seen.push(args);
      return okResult();
    },
  });
  await provider.evaluate({ state: {}, questions: buildExternalIntelligenceQuestions() });
  assertEqual(seen.length, 1, "exactly one SDK evaluation call");
  assertEqual(seen[0].maxRetries, 0, "the request still sends maxRetries: 0");
});

test("2. a first-attempt success is exactly ONE physical attempt", async () => {
  resetClock();
  const { transport, stub } = makeTransport({ results: [okResult()] });
  const outcome = await transport.evaluate({ state: {}, questions: {} });
  assertEqual(outcome.ok, true, "the decision succeeded");
  assertEqual(stub.calls.length, 1, "one provider call");
  assertEqual(stub.calls.length, 1, "exactly one attempt");
  assertEqual(outcome.providerAttemptCount, 1, "providerAttemptCount is 1");
  assertEqual(outcome.providerAttempts.length, 1, "one attempt record");
  assertEqual(outcome.providerAttempts[0].successful, true, "the attempt is marked successful");
  assertEqual(ctx.sleeps.length, 0, "no delay was needed");
});

test("3. 429 then success = two attempts", async () => {
  resetClock();
  const { transport, stub } = makeTransport({ results: [failResult(JEV_STATUS.RATE_LIMIT, 429), okResult()] });
  const outcome = await transport.evaluate({ state: {}, questions: {} });
  assertEqual(outcome.ok, true, "eventually OK");
  assertEqual(stub.calls.length, 2, "two physical attempts");
  assertEqual(outcome.providerAttempts[0].status, JEV_STATUS.RATE_LIMIT, "attempt 1 was a rate limit");
  assertEqual(outcome.providerAttempts[1].status, JEV_STATUS.OK, "attempt 2 succeeded");
});

test("4. 503 then success = two attempts", async () => {
  resetClock();
  const { transport } = makeTransport({ results: [failResult(JEV_STATUS.UNAVAILABLE, 503), okResult()] });
  const outcome = await transport.evaluate({ state: {}, questions: {} });
  assertEqual(outcome.ok, true, "eventually OK");
  assertEqual(outcome.providerAttempts.length, 2, "two attempts");
  assertEqual(outcome.providerAttempts[0].httpStatus, 503, "the 503 is recorded");
  assertEqual(outcome.providerAttempts[1].successful, true, "attempt 2 succeeded");
});

test("5. timeout then success = two attempts", async () => {
  resetClock();
  const { transport } = makeTransport({ results: [failResult(JEV_STATUS.TIMEOUT), okResult()] });
  const outcome = await transport.evaluate({ state: {}, questions: {} });
  assertEqual(outcome.ok, true, "eventually OK");
  assertEqual(outcome.providerAttempts.length, 2, "two attempts");
  assertEqual(outcome.providerAttempts[0].status, JEV_STATUS.TIMEOUT, "a timeout is retryable");
});

test("6. network unavailable then success = two attempts", async () => {
  resetClock();
  const { transport } = makeTransport({ results: [failResult(JEV_STATUS.UNAVAILABLE), okResult()] });
  const outcome = await transport.evaluate({ state: {}, questions: {} });
  assertEqual(outcome.ok, true, "eventually OK");
  assertEqual(outcome.providerAttempts.length, 2, "two attempts");
  assertEqual(outcome.providerAttempts[0].status, JEV_STATUS.UNAVAILABLE, "network unavailability is retryable");
});

test("7. 429, 503, success = three attempts (one logical decision)", async () => {
  resetClock();
  const { transport } = makeTransport({
    results: [failResult(JEV_STATUS.RATE_LIMIT, 429), failResult(JEV_STATUS.UNAVAILABLE, 503), okResult()],
  });
  const outcome = await transport.evaluate({ state: {}, questions: {} });
  assertEqual(outcome.ok, true, "eventually OK");
  assertEqual(outcome.providerAttemptCount, 3, "three physical attempts");
  assertDeepEqual(
    outcome.providerAttempts.map((attempt) => attempt.status),
    [JEV_STATUS.RATE_LIMIT, JEV_STATUS.UNAVAILABLE, JEV_STATUS.OK],
    "all three attempts recorded in order",
  );
});

test("8. attempts stop after the configured maximum (no unbounded retry)", async () => {
  resetClock();
  const { transport, stub } = makeTransport({ settings: { maxAttempts: 3 }, results: [failResult(JEV_STATUS.RATE_LIMIT, 429)] });
  const outcome = await transport.evaluate({ state: {}, questions: {} });
  assertEqual(outcome.ok, false, "still failed");
  assertEqual(stub.calls.length, 3, "exactly three attempts, then stop");
  assertEqual(ctx.sleeps.length, 2, "two delays for three attempts");
});

test("9. HTTP 400 is NOT retried", async () => {
  resetClock();
  const { transport, stub } = makeTransport({ results: [failResult(JEV_STATUS.CONFIG_ERROR, 400)] });
  const outcome = await transport.evaluate({ state: {}, questions: {} });
  assertEqual(stub.calls.length, 1, "no retry");
  assertEqual(outcome.providerAttempts[0].retryable, false, "the attempt is marked non-retryable");
  assertEqual(ctx.sleeps.length, 0, "no delay");
});

test("10. HTTP 401 is NOT retried", async () => {
  resetClock();
  const { transport, stub } = makeTransport({ results: [failResult(JEV_STATUS.AUTH_ERROR, 401)] });
  await transport.evaluate({ state: {}, questions: {} });
  assertEqual(stub.calls.length, 1, "an authentication failure is never retried");
});

test("11. HTTP 402 is NOT retried", async () => {
  resetClock();
  const { transport, stub } = makeTransport({ results: [failResult(JEV_STATUS.HTTP_ERROR, 402)] });
  await transport.evaluate({ state: {}, questions: {} });
  assertEqual(stub.calls.length, 1, "a payment-required failure is never retried");
});

test("12. HTTP 403 is NOT retried", async () => {
  resetClock();
  const { transport, stub } = makeTransport({ results: [failResult(JEV_STATUS.AUTH_ERROR, 403)] });
  await transport.evaluate({ state: {}, questions: {} });
  assertEqual(stub.calls.length, 1, "a forbidden failure is never retried");
});

test("13. HTTP 404 is NOT retried", async () => {
  resetClock();
  const { transport, stub } = makeTransport({ results: [failResult(JEV_STATUS.CONFIG_ERROR, 404)] });
  await transport.evaluate({ state: {}, questions: {} });
  assertEqual(stub.calls.length, 1, "an unknown model/route is never retried");
});

test("14. HTTP 422 is NOT retried", async () => {
  resetClock();
  const { transport, stub } = makeTransport({ results: [failResult(JEV_STATUS.CONFIG_ERROR, 422)] });
  await transport.evaluate({ state: {}, questions: {} });
  assertEqual(stub.calls.length, 1, "a rejected question schema is never retried");
});

test("15. a malformed typed response is NOT retried", async () => {
  resetClock();
  const { transport, stub } = makeTransport({ results: [failResult(JEV_STATUS.INVALID_RESPONSE, 200)] });
  await transport.evaluate({ state: {}, questions: {} });
  assertEqual(stub.calls.length, 1, "a schema problem is never retried");
});

test("16. a configuration error is NOT retried", async () => {
  resetClock();
  const { transport, stub } = makeTransport({ results: [failResult(JEV_STATUS.CONFIG_ERROR)] });
  await transport.evaluate({ state: {}, questions: {} });
  assertEqual(stub.calls.length, 1, "a config error is never retried");
});

test("17. an authentication error is NOT retried", async () => {
  resetClock();
  const { transport, stub } = makeTransport({ results: [failResult(JEV_STATUS.AUTH_ERROR)] });
  await transport.evaluate({ state: {}, questions: {} });
  assertEqual(stub.calls.length, 1, "a revoked key is never retried");
});

test("18. the retryable/non-retryable sets are exactly as documented", () => {
  assertDeepEqual([...RETRYABLE_HTTP_STATUSES], [429, 500, 502, 503, 504], "retryable HTTP statuses");
  assertDeepEqual(
    [...RETRYABLE_JEV_STATUSES],
    [JEV_STATUS.RATE_LIMIT, JEV_STATUS.TIMEOUT, JEV_STATUS.UNAVAILABLE],
    "retryable Jev statuses",
  );
  for (const [status, httpStatus, expected] of [
    [JEV_STATUS.RATE_LIMIT, 429, true],
    [JEV_STATUS.UNAVAILABLE, 502, true],
    [JEV_STATUS.UNAVAILABLE, 503, true],
    [JEV_STATUS.UNAVAILABLE, 504, true],
    [JEV_STATUS.TIMEOUT, null, true],
    [JEV_STATUS.UNAVAILABLE, null, true],
    [JEV_STATUS.HTTP_ERROR, 500, true],
    [JEV_STATUS.HTTP_ERROR, 503, true],
    [JEV_STATUS.CONFIG_ERROR, 400, false],
    [JEV_STATUS.AUTH_ERROR, 401, false],
    [JEV_STATUS.HTTP_ERROR, 402, false],
    [JEV_STATUS.AUTH_ERROR, 403, false],
    [JEV_STATUS.CONFIG_ERROR, 404, false],
    [JEV_STATUS.CONFIG_ERROR, 422, false],
    [JEV_STATUS.INVALID_RESPONSE, null, false],
    [JEV_STATUS.CONFIG_ERROR, null, false],
    [JEV_STATUS.AUTH_ERROR, null, false],
    [JEV_STATUS.INTERNAL_ERROR, 500, false],
    [JEV_STATUS.COOLDOWN, null, false],
    [JEV_STATUS.DISABLED, null, false],
  ]) {
    assertEqual(
      isRetryableFailure({ status, httpStatus }),
      expected,
      `${status} + HTTP ${httpStatus ?? "n/a"} retryable === ${expected}`,
    );
  }
});

/* ============================================================================
 * PART 2 — Retry-After
 * ==========================================================================*/

test("19. a Retry-After of integer seconds is parsed", () => {
  assertEqual(retryAfterMsOf({ responseHeaders: { "retry-after": "12" } }), 12_000, "seconds parse to ms");
  assertEqual(retryAfterMsOf({ headers: { "Retry-After": "3" } }), 3_000, "header casing does not matter");
  assertEqual(retryAfterMsOf({ retryAfter: 5 }), 5_000, "a numeric retryAfter is seconds");
  assertEqual(retryAfterMsOf({ retryAfterMs: 1_500 }), 1_500, "an explicit retryAfterMs wins");
  const headers = new Map([["retry-after", "7"]]);
  assertEqual(
    retryAfterMsOf({ headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null } }),
    7_000,
    "a Headers-like get() shape is supported",
  );
});

test("20. a Retry-After HTTP-date is parsed", () => {
  const nowMs = NOW;
  const now = () => nowMs;
  const date = new Date(nowMs + 45_000).toUTCString();
  assertEqual(retryAfterMsOf({ responseHeaders: { "retry-after": date } }, { now }), 45_000, "an HTTP-date parses to a delta");
  const past = new Date(nowMs - 30_000).toUTCString();
  assertEqual(retryAfterMsOf({ responseHeaders: { "retry-after": past } }, { now }), 0, "a past date clamps to 0");
});

test("21. a malformed Retry-After is ignored (null, not NaN)", () => {
  for (const value of ["soon", "", "  ", "12.5.3x", "not-a-date"]) {
    assertEqual(retryAfterMsOf({ responseHeaders: { "retry-after": value } }), null, `'${value}' is ignored`);
  }
  assertEqual(retryAfterMsOf(null), null, "nothing at all yields null");
  assertEqual(retryAfterMsOf({}), null, "an empty error yields null");
  assertEqual(retryAfterMsOf({ retryAfterMs: Number.NaN }), null, "NaN is rejected");
});

test("22. an externally supplied Retry-After is CLAMPED to a sane maximum", () => {
  assertEqual(retryAfterMsOf({ retryAfterMs: 10_000_000 }), JEV_RETRY_AFTER_MAX_MS, "clamped to the default ceiling");
  assertEqual(retryAfterMsOf({ responseHeaders: { "retry-after": "99999" } }), JEV_RETRY_AFTER_MAX_MS, "seconds are clamped too");
  assertEqual(retryAfterMsOf({ retryAfterMs: 5_000 }, { maxMs: 1_000 }), 1_000, "an explicit ceiling is honoured");
  assertEqual(retryAfterMsOf({ retryAfterMs: -50 }), 0, "a negative value clamps to 0");
});

test("23. a RetryError-style wrapper is unwrapped (bounded)", () => {
  const wrapped = { name: "AI_RetryError", lastError: { responseHeaders: { "retry-after": "9" } } };
  assertEqual(retryAfterMsOf(wrapped), 9_000, "the nested cause is found");
  const tooDeep = { lastError: { lastError: { lastError: { lastError: { retryAfterMs: 1 } } } } };
  assertEqual(retryAfterMsOf(tooDeep), null, "unwrapping is depth-bounded");
});

test("24. no raw headers are persisted — only the bounded number", () => {
  const outcome = failResult(JEV_STATUS.RATE_LIMIT, 429);
  outcome.responseHeaders = { "retry-after": "4", authorization: "Bearer leak", "set-cookie": "session=leak" };
  const { transport } = makeTransport({ results: [outcome, okResult()] });
  return transport.evaluate({ state: {}, questions: {} }).then((result) => {
    const attempt = result.providerAttempts[0];
    assertEqual(attempt.retryAfterMs, 4_000, "the number is recorded");
    const serialized = canonicalJson(result.providerAttempts);
    for (const forbidden of ["retry-after", "authorization", "Bearer", "set-cookie", "session=leak"]) {
      assertTrue(!serialized.includes(forbidden), `the attempt records never contain '${forbidden}'`);
    }
  });
});

/* ============================================================================
 * PART 3 — backoff and jitter
 * ==========================================================================*/

test("25. the fallback backoff schedule is used when no Retry-After exists", async () => {
  resetClock();
  const { transport } = makeTransport({ results: [failResult(JEV_STATUS.RATE_LIMIT, 429)] });
  await transport.evaluate({ state: {}, questions: {} });
  assertDeepEqual(ctx.sleeps, [1_000, 2_000], "~1s after attempt 1, ~2s after attempt 2");
});

test("26. a Retry-After hint replaces the schedule for that wait", async () => {
  resetClock();
  const first = failResult(JEV_STATUS.RATE_LIMIT, 429);
  first.retryAfterMs = 3_000;
  const { transport } = makeTransport({ results: [first, okResult()] });
  await transport.evaluate({ state: {}, questions: {} });
  assertDeepEqual(ctx.sleeps, [3_000], "the server hint is used instead of the schedule");
});

test("27. backoff is exponential and bounded", () => {
  const bounded = backoffDelayMs(20, { baseMs: 1_000, maxMs: 30_000, randomImpl: () => 0.5 });
  assertEqual(bounded, 30_000, "the exponential term is clamped to the ceiling");
  assertEqual(backoffDelayMs(1, { baseMs: 1_000, maxMs: 30_000, randomImpl: () => 0.5 }), 1_000, "attempt 1 -> base");
  assertEqual(backoffDelayMs(2, { baseMs: 1_000, maxMs: 30_000, randomImpl: () => 0.5 }), 2_000, "attempt 2 -> 2x base");
  assertEqual(backoffDelayMs(3, { baseMs: 1_000, maxMs: 30_000, randomImpl: () => 0.5 }), 4_000, "attempt 3 -> 4x base");
  assertEqual(backoffDelayMs(1, { baseMs: 0, maxMs: 30_000, randomImpl: () => 0.5 }), 0, "a zero base is allowed (tests)");
});

test("28. jitter is bounded (±25%) and never identical across draws", () => {
  const low = backoffDelayMs(2, { baseMs: 1_000, maxMs: 30_000, randomImpl: () => 0, jitterRatio: JEV_JITTER_RATIO });
  const mid = backoffDelayMs(2, { baseMs: 1_000, maxMs: 30_000, randomImpl: () => 0.5, jitterRatio: JEV_JITTER_RATIO });
  const high = backoffDelayMs(2, { baseMs: 1_000, maxMs: 30_000, randomImpl: () => 0.999999, jitterRatio: JEV_JITTER_RATIO });
  assertEqual(low, 1_500, "the low bound is 75% of 2s");
  assertEqual(mid, 2_000, "the midpoint is the exponential value");
  assertTrue(high <= 2_500, "the high bound never exceeds 125% of 2s");
  assertTrue(high > mid, "different draws give different delays (no synchronized retry storm)");
  assertEqual(backoffDelayMs(5, { baseMs: 1_000, maxMs: 3_000, randomImpl: () => 0.999999 }), 3_000, "jitter never escapes the ceiling");
});

test("29. injected sleep causes NO real delay and is observable", async () => {
  resetClock();
  const started = Date.now();
  const { transport } = makeTransport({ results: [failResult(JEV_STATUS.RATE_LIMIT, 429)] });
  await transport.evaluate({ state: {}, questions: {} });
  assertDeepEqual(ctx.sleeps, [1_000, 2_000], "both delays were requested through the injected sleep");
  assertTrue(Date.now() - started < 1_000, "wall-clock time was not actually spent");
});

/* ============================================================================
 * PART 4 — attempt provenance and logical/physical budgets
 * ==========================================================================*/

test("30. every attempt is persisted, and failed attempts survive an eventual success", async () => {
  resetClock();
  const { transport } = makeTransport({ results: [failResult(JEV_STATUS.RATE_LIMIT, 429), failResult(JEV_STATUS.UNAVAILABLE, 503), okResult()] });
  const outcome = await transport.evaluate({ state: {}, questions: {} });
  assertEqual(outcome.providerAttempts.length, 3, "three attempt records");
  assertDeepEqual(
    outcome.providerAttempts.map((attempt) => attempt.successful),
    [false, false, true],
    "the failed attempts are retained after the success",
  );
  assertDeepEqual(
    outcome.providerAttempts.map((attempt) => attempt.attemptNumber),
    [1, 2, 3],
    "attempt numbers are sequential",
  );
  const serialized = canonicalJson(outcome.providerAttempts);
  for (const field of ["attemptNumber", "provider", "model", "transport", "startedAt", "completedAt", "latencyMs", "status", "httpStatus", "retryable", "retryAfterMs", "backoffMs", "generationId", "successful"]) {
    assertTrue(serialized.includes(`"${field}"`), `the attempt schema carries '${field}'`);
  }
});

test("31. the attempt schema is a strict whitelist (no forbidden extras)", () => {
  const attempt = boundedProviderAttempt({
    attemptNumber: 1,
    provider: VERCEL_JEV_PROVIDER,
    model: "typesafe-ai/jev",
    transport: "vercel-ai-gateway",
    startedAt: "2026-09-19T14:00:00.000Z",
    completedAt: "2026-09-19T14:00:00.100Z",
    latencyMs: 100,
    status: JEV_STATUS.RATE_LIMIT,
    httpStatus: 429,
    retryable: true,
    retryAfterMs: 5_000,
    backoffMs: 5_000,
    generationId: "gen-1",
    successful: false,
    apiKey: "sk-leak",
    authorization: "Bearer leak",
    headers: { cookie: "leak" },
    state: { raw: "leak" },
    questions: { raw: "leak" },
    rawResponse: { leak: true },
  });
  assertDeepEqual(
    Object.keys(attempt).sort(),
    [
      "attemptNumber",
      "backoffMs",
      "completedAt",
      "generationId",
      "httpStatus",
      "latencyMs",
      "model",
      "provider",
      "retryAfterMs",
      "retryable",
      "startedAt",
      "status",
      "successful",
      "transport",
    ],
    "exactly the documentable fields survive",
  );
  const serialized = canonicalJson(attempt);
  for (const forbidden of ["apiKey", "authorization", "Bearer", "cookie", "rawResponse", "sk-leak"]) {
    assertTrue(!serialized.includes(forbidden), `'${forbidden}' can never enter provenance`);
  }
});

test("32. `providerAttemptCount` is exact through `jevDecide`, and failed attempts are persisted on disk", async () => {
  resetClock();
  const stub = scriptedProvider({
    results: [failResult(JEV_STATUS.RATE_LIMIT, 429), failResult(JEV_STATUS.UNAVAILABLE, 503), okResult()],
  });
  const transport = createResilientJevTransport({
    providers: [stub],
    settings: transportSettings(),
    healthRoot: freshHealthRoot("direct-transport"),
    sleepImpl: recordSleep,
    randomImpl: fixedRandom,
    now: () => ctx.clock.ms,
  });
  const { run, decision } = await jevDecide({
    provider: transport,
    packet: ctx.jevPacket,
    questions: buildExternalIntelligenceQuestions(),
    questionSetId: JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_ID,
    questionSetVersion: 1,
    decisionPacketVersion: 1,
    root: null,
    budget: createJevRunBudget(1),
    now: () => ctx.clock.ms,
  });
  assertEqual(run.status, JEV_STATUS.OK, `the logical decision succeeded (${run.reason})`);
  assertEqual(decision === NO_JEV_DECISION, false, "a decision was returned");
  assertEqual(run.providerAttemptCount, 3, "providerAttemptCount is exactly 3");
  assertEqual(run.providerAttempts.length, 3, "all three attempts are on the run record");
  assertEqual(run.providerAttempts.filter((attempt) => attempt.successful === false).length, 2, "two failed attempts are retained");
  assertEqual(run.providerMetadata.providerAttemptCount, run.providerAttemptCount, "provider metadata agrees with the run record");
});

test("33. an all-failed logical decision is still ONE attempt-counted NO_JEV_DECISION", async () => {
  resetClock();
  const stub = scriptedProvider({ results: [failResult(JEV_STATUS.RATE_LIMIT, 429)] });
  const transport = createResilientJevTransport({
    providers: [stub],
    settings: transportSettings(),
    healthRoot: freshHealthRoot("direct-transport"),
    sleepImpl: recordSleep,
    randomImpl: fixedRandom,
    now: () => ctx.clock.ms,
  });
  const budget = createJevRunBudget(1);
  const { run, decision } = await jevDecide({
    provider: transport,
    packet: ctx.jevPacket,
    questions: buildExternalIntelligenceQuestions(),
    questionSetId: JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_ID,
    questionSetVersion: 1,
    decisionPacketVersion: 1,
    root: null,
    budget,
    now: () => ctx.clock.ms,
  });
  assertEqual(run.status, JEV_STATUS.RATE_LIMIT, "the final status is the last attempt's status");
  assertEqual(decision, NO_JEV_DECISION, "no decision was fabricated");
  assertEqual(run.providerAttemptCount, 3, "three physical attempts");
  assertEqual(run.providerAttempts.length, 3, "and all three are recorded");
  assertDeepEqual(
    run.providerAttempts.map((attempt) => attempt.status),
    [JEV_STATUS.RATE_LIMIT, JEV_STATUS.RATE_LIMIT, JEV_STATUS.RATE_LIMIT],
    "no failed attempt is discarded",
  );
  assertEqual(budget.used, 1, "LOGICAL budget used is exactly 1");
  assertEqual(budget.max, 1, "LOGICAL budget maximum is unchanged");
});

test("34. a provider that reports no attempts still counts as exactly one physical attempt", async () => {
  resetClock();
  const { run } = await jevDecide({
    provider: createMockJevProvider(),
    packet: ctx.jevPacket,
    questions: buildExternalIntelligenceQuestions(),
    questionSetId: JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_ID,
    questionSetVersion: 1,
    decisionPacketVersion: 1,
    root: null,
    budget: createJevRunBudget(1),
    now: () => ctx.clock.ms,
  });
  assertEqual(run.status, JEV_STATUS.OK, "the mock succeeds");
  assertEqual(run.providerAttemptCount, 1, "an ordinary one-attempt run stays at 1");
  assertEqual(run.providerAttempts, null, "no invented attempt records");
});

test("35. a cache hit, a disabled provider and an exhausted budget make ZERO attempts", async () => {
  resetClock();
  const provider = createMockJevProvider();
  const base = {
    provider,
    packet: ctx.jevPacket,
    questions: buildExternalIntelligenceQuestions(),
    questionSetId: JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_ID,
    questionSetVersion: 1,
    decisionPacketVersion: 1,
    cacheEnabled: true,
    now: () => ctx.clock.ms,
  };
  const first = await jevDecide({ ...base, root: path.join(ctx.jevBase, "cache"), budget: createJevRunBudget(2), salt: "f51-cache" });
  assertEqual(first.run.providerAttemptCount, 1, "the live call is one attempt");
  const second = await jevDecide({ ...base, root: path.join(ctx.jevBase, "cache"), budget: createJevRunBudget(2), salt: "f51-cache" });
  assertEqual(second.run.cacheHit, true, "the second call is a cache hit");
  assertEqual(second.run.providerAttemptCount, 0, "a cache hit makes no attempt");

  const exhausted = createJevRunBudget(1);
  exhausted.consume();
  const budgeted = await jevDecide({ ...base, root: null, budget: exhausted, cacheEnabled: false });
  assertEqual(budgeted.run.status, JEV_STATUS.BUDGET_EXCEEDED, "the budget is enforced");
  assertEqual(budgeted.run.providerAttemptCount, 0, "no attempt was made");
});

/* ============================================================================
 * PART 5 — provider-health cooldown
 * ==========================================================================*/

test("36. an exhausted transient logical decision opens a cooldown", async () => {
  resetClock();
  const healthRoot = freshHealthRoot("cooldown-created");
  await writeProviderHealth(healthRoot, emptyProviderHealth({ provider: VERCEL_JEV_PROVIDER, model: "typesafe-ai/jev" }));
  const { transport } = makeTransport({ results: [failResult(JEV_STATUS.RATE_LIMIT, 429)], healthRoot });
  const outcome = await transport.evaluate({ state: {}, questions: {} });
  assertEqual(outcome.ok, false, "the call failed");
  const health = await readProviderHealth(healthRoot, VERCEL_JEV_PROVIDER);
  assertEqual(health.consecutiveTransientFailures, 1, "the transient streak incremented");
  assertEqual(health.lastFailureStatus, JEV_STATUS.RATE_LIMIT, "the failure status is recorded");
  assertEqual(Date.parse(health.cooldownUntil), NOW + 60_000, "a 60s cooldown was opened");
  assertEqual(isCooldownActive(health, NOW + 1), true, "the cooldown is active");
});

test("37. an active cooldown prevents ANY network invocation", async () => {
  resetClock();
  const healthRoot = freshHealthRoot("cooldown-blocks");
  await writeProviderHealth(healthRoot, {
    ...emptyProviderHealth({ provider: VERCEL_JEV_PROVIDER, model: "typesafe-ai/jev" }),
    consecutiveTransientFailures: 1,
    cooldownUntil: new Date(NOW + 60_000).toISOString(),
  });
  const { transport, stub } = makeTransport({ results: [okResult()], healthRoot });
  const outcome = await transport.evaluate({ state: {}, questions: {} });
  assertEqual(outcome.ok, false, "the call fails safely");
  assertEqual(outcome.status, JEV_STATUS.COOLDOWN, "the explicit JEV_COOLDOWN status");
  assertEqual(stub.calls.length, 0, "the provider was never called");
  assertEqual(outcome.providerAttemptCount, 0, "zero physical attempts");
  assertDeepEqual(outcome.providerAttempts, [], "no attempt record is invented");
  assertTrue(/cooldown/i.test(outcome.reason), "the reason names the cooldown");
});

test("38. an explicit override is the ONLY way past an active cooldown", async () => {
  resetClock();
  const healthRoot = freshHealthRoot("cooldown-override");
  await writeProviderHealth(healthRoot, {
    ...emptyProviderHealth({ provider: VERCEL_JEV_PROVIDER, model: "typesafe-ai/jev" }),
    consecutiveTransientFailures: 2,
    cooldownUntil: new Date(NOW + 120_000).toISOString(),
  });
  const { transport, stub } = makeTransport({ results: [okResult()], overrideCooldown: true, healthRoot });
  const outcome = await transport.evaluate({ state: {}, questions: {} });
  assertEqual(outcome.ok, true, "the override lets the call through");
  assertEqual(stub.calls.length, 1, "exactly one call was made");
  assertEqual(outcome.cooldownOverridden, true, "the override is visible in provenance");
});

test("39. cooldown expiry permits a future logical call", async () => {
  resetClock();
  const healthRoot = freshHealthRoot("cooldown-expiry");
  await writeProviderHealth(healthRoot, {
    ...emptyProviderHealth({ provider: VERCEL_JEV_PROVIDER, model: "typesafe-ai/jev" }),
    consecutiveTransientFailures: 1,
    cooldownUntil: new Date(NOW + 60_000).toISOString(),
  });
  const health = await readProviderHealth(healthRoot, VERCEL_JEV_PROVIDER);
  assertEqual(isCooldownActive(health, NOW + 59_000), true, "still cooling down");
  assertEqual(isCooldownActive(health, NOW + 61_000), false, "expired");
  ctx.clock.ms = NOW + 61_000;
  const { transport, stub } = makeTransport({ results: [okResult()], healthRoot });
  const outcome = await transport.evaluate({ state: {}, questions: {} });
  assertEqual(outcome.ok, true, "the provider is callable again after the window");
  assertEqual(stub.calls.length, 1, "one call");
  const after = await readProviderHealth(healthRoot, VERCEL_JEV_PROVIDER);
  assertEqual(after.cooldownUntil, null, "the cooldown is cleared after the successful call");
});

test("40. a successful JEV_OK resets the transient streak and clears the cooldown", async () => {
  const success = applySuccess(
    {
      ...emptyProviderHealth({ provider: VERCEL_JEV_PROVIDER, model: "typesafe-ai/jev" }),
      consecutiveTransientFailures: 4,
      cooldownUntil: new Date(NOW + 500_000).toISOString(),
      lastFailureStatus: JEV_STATUS.RATE_LIMIT,
      lastFailureAt: new Date(NOW).toISOString(),
    },
    { now: NOW + 1 },
  );
  assertEqual(success.consecutiveTransientFailures, 0, "the streak is reset");
  assertEqual(success.cooldownUntil, null, "the cooldown is cleared");
  assertEqual(success.lastSuccessAt, new Date(NOW + 1).toISOString(), "the success is timestamped");

  resetClock(NOW + 100);
  const healthRoot = freshHealthRoot("reset-on-success");
  await writeProviderHealth(healthRoot, {
    ...emptyProviderHealth({ provider: VERCEL_JEV_PROVIDER, model: "typesafe-ai/jev" }),
    consecutiveTransientFailures: 4,
    cooldownUntil: new Date(NOW + 500_000).toISOString(),
  });
  const { transport } = makeTransport({ results: [okResult()], overrideCooldown: true, healthRoot });
  await transport.evaluate({ state: {}, questions: {} });
  const stored = await readProviderHealth(healthRoot, VERCEL_JEV_PROVIDER);
  assertEqual(stored.consecutiveTransientFailures, 0, "the persisted streak is reset by a real success");
  assertEqual(stored.cooldownUntil, null, "and the persisted cooldown is cleared");
});

test("41. cooldown escalation is geometric and CLAMPED", () => {
  assertEqual(cooldownEscalationMs(1, { baseCooldownMs: 60_000, maxCooldownMs: 900_000 }), 60_000, "first -> 60s");
  assertEqual(cooldownEscalationMs(2, { baseCooldownMs: 60_000, maxCooldownMs: 900_000 }), 120_000, "second -> 120s");
  assertEqual(cooldownEscalationMs(3, { baseCooldownMs: 60_000, maxCooldownMs: 900_000 }), 240_000, "third -> 240s");
  assertEqual(cooldownEscalationMs(5, { baseCooldownMs: 60_000, maxCooldownMs: 900_000 }), 900_000, "clamped at 15 minutes");
  assertEqual(cooldownEscalationMs(50, { baseCooldownMs: 60_000, maxCooldownMs: 900_000 }), 900_000, "never indefinite");
  assertTrue(cooldownEscalationMs(9, { baseCooldownMs: 60_000, maxCooldownMs: 900_000 }) <= 900_000, "always bounded");
});

test("42. repeated exhausted runs escalate the persisted cooldown, clamped", async () => {
  resetClock();
  const healthRoot = freshHealthRoot("escalation");
  await writeProviderHealth(healthRoot, emptyProviderHealth({ provider: VERCEL_JEV_PROVIDER, model: "typesafe-ai/jev" }));
  const base = { cooldownMs: 60_000, cooldownMaxMs: 240_000 };
  const windows = [];
  for (let run = 1; run <= 6; run += 1) {
    resetClock(NOW + run * 10_000);
    const { transport } = makeTransport({ results: [failResult(JEV_STATUS.RATE_LIMIT, 429)], settings: base, overrideCooldown: true, healthRoot });
    await transport.evaluate({ state: {}, questions: {} });
    const health = await readProviderHealth(healthRoot, VERCEL_JEV_PROVIDER);
    windows.push(Date.parse(health.cooldownUntil) - (NOW + run * 10_000));
  }
  assertDeepEqual(windows.slice(0, 3), [60_000, 120_000, 240_000], "the window escalates 60s -> 120s -> 240s");
  for (const window of windows) assertTrue(window <= 240_000, "the window never exceeds the configured maximum");
});

test("43. an auth error does NOT trigger a transient cooldown", async () => {
  resetClock();
  const healthRoot = freshHealthRoot("auth-no-cooldown");
  await writeProviderHealth(healthRoot, emptyProviderHealth({ provider: VERCEL_JEV_PROVIDER, model: "typesafe-ai/jev" }));
  const { transport, stub } = makeTransport({ results: [failResult(JEV_STATUS.AUTH_ERROR, 401)], healthRoot });
  await transport.evaluate({ state: {}, questions: {} });
  assertEqual(stub.calls.length, 1, "not retried");
  const health = await readProviderHealth(healthRoot, VERCEL_JEV_PROVIDER);
  assertEqual(health.consecutiveTransientFailures, 0, "the transient streak is untouched");
  assertEqual(health.cooldownUntil, null, "no cooldown was opened");
  assertEqual(isCooldownActive(health, NOW + 1), false, "the provider is immediately callable again");
});

test("44. a config error does NOT trigger a transient cooldown", async () => {
  resetClock();
  const healthRoot = freshHealthRoot("config-no-cooldown");
  await writeProviderHealth(healthRoot, emptyProviderHealth({ provider: VERCEL_JEV_PROVIDER, model: "typesafe-ai/jev" }));
  const { transport, stub } = makeTransport({ results: [failResult(JEV_STATUS.CONFIG_ERROR, 400)], healthRoot });
  await transport.evaluate({ state: {}, questions: {} });
  assertEqual(stub.calls.length, 1, "not retried");
  const health = await readProviderHealth(healthRoot, VERCEL_JEV_PROVIDER);
  assertEqual(health.consecutiveTransientFailures, 0, "no transient streak");
  assertEqual(health.cooldownUntil, null, "no cooldown");
});

test("45. the provider-health artifact contains no secrets and only the eight documented fields", async () => {
  const healthRoot = freshHealthRoot("health-artifact");
  await writeProviderHealth(healthRoot, {
    ...emptyProviderHealth({ provider: VERCEL_JEV_PROVIDER, model: "typesafe-ai/jev" }),
    consecutiveTransientFailures: 2,
    lastFailureStatus: JEV_STATUS.RATE_LIMIT,
    lastFailureAt: new Date(NOW).toISOString(),
    cooldownUntil: new Date(NOW + 120_000).toISOString(),
    lastSuccessAt: new Date(NOW - 60_000).toISOString(),
  });
  const health = await readProviderHealth(healthRoot, VERCEL_JEV_PROVIDER);
  assertTrue(health !== null, "the artifact was written");
  assertDeepEqual(Object.keys(health).sort(), [...JEV_PROVIDER_HEALTH_FIELDS].sort(), "exactly the documented fields");
  assertEqual(health.provider, VERCEL_JEV_PROVIDER, "the provider is named");
  assertEqual(health.formatVersion, 1, "the format is versioned");
  const text = await readFile(path.join(healthRoot, `${VERCEL_JEV_PROVIDER}.json`), "utf8");
  for (const forbidden of [
    DIRECT_KEY_SENTINEL,
    GATEWAY_KEY_SENTINEL,
    "Bearer",
    "Authorization",
    "sk-",
    "cookie",
    "apiKey",
    "gatewayApiKey",
    "EVOLVE_JEV_API_KEY",
    "AI_GATEWAY_API_KEY",
  ]) {
    assertTrue(!text.includes(forbidden), `the health artifact never contains '${forbidden}'`);
  }
  assertEqual(JEV_PROVIDER_HEALTH_DIR, path.join(".evolve", "jev", "provider-health"), "it lives under the Jev subsystem");
});

test("46. an unsafe provider name is refused by the health store", async () => {
  let threw = false;
  try {
    await writeProviderHealth(freshHealthRoot("unsafe"), { ...emptyProviderHealth({}), provider: "../../etc/passwd" });
  } catch {
    threw = true;
  }
  assertEqual(threw, true, "a traversal-shaped provider name is refused");
});

/* ============================================================================
 * PART 6 — optional same-Jev transport chain and credential separation
 * ==========================================================================*/

test("47. the transport chain is DISABLED by default (single selected provider)", async () => {
  const config = resolveJevConfig({ EVOLVE_JEV_PROVIDER: VERCEL_JEV_PROVIDER, AI_GATEWAY_API_KEY: GATEWAY_KEY_SENTINEL });
  assertDeepEqual(config.transportChain, [], "no chain unless explicitly requested");
  assertEqual(config.transportChainConfigured, false, "and it is not configured");
  const resolved = createResilientJevProvider({
    selectedProvider: VERCEL_JEV_PROVIDER,
    config,
    healthRoot: freshHealthRoot("default-chain"),
    sleepImpl: recordSleep,
    randomImpl: fixedRandom,
    now: () => ctx.clock.ms,
  });
  assertEqual(resolved.wrapped, true, "a real external provider IS wrapped");
  assertDeepEqual(resolved.chain.chainNames, [VERCEL_JEV_PROVIDER], "the chain is exactly the selected provider");
});

test("48. a malformed or non-Jev chain is a CONFIGURATION ERROR", () => {
  for (const bad of ["gpt-4o", "claude-3-opus", "gemini-pro", "mock-jev", "vercel-jve"]) {
    const parsed = parseJevTransportChain(bad);
    assertEqual(parsed.error === null, false, `'${bad}' is refused`);
    assertDeepEqual(parsed.chain, [], "no chain is produced");
    const config = resolveJevConfig({ EVOLVE_JEV_PROVIDER: VERCEL_JEV_PROVIDER, EVOLVE_JEV_TRANSPORT_CHAIN: bad });
    assertTrue(typeof config.configError === "string" && config.configError.length > 0, `'${bad}' is a config error`);
    assertEqual(config.enabled, false, "a typo never enables a call");
  }
  assertDeepEqual(parseJevTransportChain("vercel-jev,typesafe-jev").chain, ["vercel-jev", "typesafe-jev"], "a valid chain parses");
  assertDeepEqual(parseJevTransportChain("VERCEL-JEV").chain, ["vercel-jev"], "case-insensitive and de-duplicated");
  assertDeepEqual(parseJevTransportChain("") .chain, [], "an empty value is the default");
});

test("49. the direct TypeSafe fallback requires its OWN separate EVOLVE_JEV_API_KEY", () => {
  // Gateway-only: the direct route must be SKIPPED, never attempted with the gateway key.
  const gatewayOnly = resolveJevProviderChain({
    selectedProvider: VERCEL_JEV_PROVIDER,
    chain: ["vercel-jev", "typesafe-jev"],
    config: { apiKey: "", gatewayApiKey: GATEWAY_KEY_SENTINEL, model: "typesafe-ai/jev" },
  });
  assertDeepEqual(gatewayOnly.chainNames, [VERCEL_JEV_PROVIDER], "only the gateway route is callable");
  assertEqual(gatewayOnly.skipped.length, 1, "the direct route is reported as skipped");
  assertEqual(gatewayOnly.skipped[0].provider, "typesafe-jev", "the skipped route is named");
  assertTrue(/EVOLVE_JEV_API_KEY/.test(gatewayOnly.skipped[0].reason), "the reason names the missing variable");

  // Direct-only: the gateway route must be SKIPPED, never attempted with the direct key.
  const directOnly = resolveJevProviderChain({
    selectedProvider: "typesafe-jev",
    chain: ["typesafe-jev", "vercel-jev"],
    config: { apiKey: DIRECT_KEY_SENTINEL, gatewayApiKey: "", model: "jev-1.13.0" },
  });
  assertDeepEqual(directOnly.chainNames, ["typesafe-jev"], "only the direct route is callable");
  assertEqual(directOnly.skipped.length, 1, "the gateway route is reported as skipped");
  assertEqual(directOnly.skipped[0].provider, VERCEL_JEV_PROVIDER, "the skipped route is named");
  assertTrue(/AI_GATEWAY_API_KEY/.test(directOnly.skipped[0].reason), "the reason names the missing variable");

  // Neither credential: nothing is callable.
  const none = resolveJevProviderChain({ selectedProvider: VERCEL_JEV_PROVIDER, chain: ["vercel-jev", "typesafe-jev"], config: {} });
  assertDeepEqual(none.chainNames, [VERCEL_JEV_PROVIDER], "no credential, no extra route");
  assertEqual(none.skipped.length, 1, "the unusable route is reported");
});

test("50. the gateway key is NEVER sent to the direct TypeSafe endpoint", async () => {
  let seenAuth = null;
  const chain = resolveJevProviderChain({
    selectedProvider: "typesafe-jev",
    chain: ["typesafe-jev"],
    config: { apiKey: DIRECT_KEY_SENTINEL, gatewayApiKey: GATEWAY_KEY_SENTINEL, model: "jev-1.13.0" },
    fetchImpl: async (url, init) => {
      seenAuth = init?.headers?.Authorization ?? null;
      return new Response(JSON.stringify({ model: "jev-1.13.0", answers: mockExternalAnswers() }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const direct = chain.providers[0];
  assertEqual(direct.name, "typesafe-jev", "the direct provider is selected");
  await direct.evaluate({ state: {}, questions: buildExternalIntelligenceQuestions() });
  assertEqual(seenAuth, `Bearer ${DIRECT_KEY_SENTINEL}`, "the direct route authenticates with its OWN key");
  assertTrue(!String(seenAuth).includes(GATEWAY_KEY_SENTINEL), "the gateway key is never sent to api.typesafe.ai");
});

test("51. the direct key is NEVER sent to the Vercel AI Gateway", async () => {
  let seenArgs = null;
  const chain = resolveJevProviderChain({
    selectedProvider: VERCEL_JEV_PROVIDER,
    chain: ["vercel-jev"],
    config: { apiKey: DIRECT_KEY_SENTINEL, gatewayApiKey: GATEWAY_KEY_SENTINEL, model: "typesafe-ai/jev" },
    evaluateImpl: async (args) => {
      seenArgs = args;
      return okResult();
    },
  });
  const gateway = chain.providers[0];
  assertEqual(gateway.name, VERCEL_JEV_PROVIDER, "the gateway provider is selected");
  const result = await gateway.evaluate({ state: {}, questions: buildExternalIntelligenceQuestions() });
  assertEqual(result.ok, true, "the gateway call succeeds");
  const serialized = canonicalJson({ args: seenArgs, result });
  for (const forbidden of [DIRECT_KEY_SENTINEL, "EVOLVE_JEV_API_KEY"]) {
    assertTrue(!serialized.includes(forbidden), `the direct credential ('${forbidden}') never reaches the gateway route`);
  }
  // Structurally: a chain may only contain a route when THAT route's own variable exists.
  const withoutGatewayCredential = resolveJevProviderChain({
    selectedProvider: "typesafe-jev",
    chain: ["typesafe-jev", "vercel-jev"],
    config: { apiKey: DIRECT_KEY_SENTINEL, gatewayApiKey: "" },
  });
  assertDeepEqual(withoutGatewayCredential.chainNames, ["typesafe-jev"], "a direct key cannot enable the gateway route");
});

test("52. an explicit vercel -> direct chain recovers when Vercel exhausts transient failures", async () => {
  resetClock();
  const healthRoot = freshHealthRoot("chain-recovery");
  const gatewayCalls = [];
  const directCalls = [];
  const resolved = createResilientJevProvider({
    selectedProvider: VERCEL_JEV_PROVIDER,
    config: {
      gatewayApiKey: GATEWAY_KEY_SENTINEL,
      apiKey: DIRECT_KEY_SENTINEL,
      transportChain: ["vercel-jev", "typesafe-jev"],
      maxAttemptsPerCall: 3,
      backoffBaseMs: 1_000,
      backoffMaxMs: 30_000,
      cooldownMs: 60_000,
      cooldownMaxMs: 900_000,
    },
    healthRoot,
    evaluateImpl: async () => {
      gatewayCalls.push(Date.now());
      // A real gateway failure reaches the provider as a THROWN error; the
      // provider classifies it. 429 -> JEV_RATE_LIMIT (transient).
      const error = new Error("gateway rate limit");
      error.statusCode = 429;
      throw error;
    },
    fetchImpl: async () => {
      directCalls.push(Date.now());
      return new Response(JSON.stringify({ model: "jev-1.13.0", answers: mockExternalAnswers() }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    sleepImpl: recordSleep,
    randomImpl: fixedRandom,
    now: () => ctx.clock.ms,
  });
  assertEqual(resolved.wrapped, true, "the chain is wrapped in the resilience layer");
  assertDeepEqual(resolved.chain.chainNames, [VERCEL_JEV_PROVIDER, "typesafe-jev"], "both same-Jev routes are in the chain");
  const outcome = await resolved.provider.evaluate({ state: {}, questions: buildExternalIntelligenceQuestions() });
  assertEqual(outcome.ok, true, "Jev → Jev failover recovered the decision");
  assertEqual(gatewayCalls.length, 3, "the gateway exhausted its bounded attempts first");
  assertEqual(directCalls.length, 1, "then the direct route was tried exactly once");
  assertEqual(outcome.providerAttemptCount, 4, "all four physical attempts are recorded");
  assertDeepEqual(
    outcome.providerAttempts.map((attempt) => attempt.provider),
    [VERCEL_JEV_PROVIDER, VERCEL_JEV_PROVIDER, VERCEL_JEV_PROVIDER, "typesafe-jev"],
    "the actual provider is recorded on every attempt",
  );
  assertDeepEqual(
    outcome.providerAttempts.map((attempt) => attempt.transport),
    ["vercel-ai-gateway", "vercel-ai-gateway", "vercel-ai-gateway", "typesafe-sdk"],
    "the actual transport is recorded on every attempt",
  );
  assertEqual(outcome.succeededProvider, "typesafe-jev", "the path that actually succeeded is recorded");
  const gatewayHealth = await readProviderHealth(healthRoot, VERCEL_JEV_PROVIDER);
  assertEqual(gatewayHealth.consecutiveTransientFailures, 1, "the exhausted route is cooled down");
});

test("53. a NON-transient failure never triggers a same-Jev failover", async () => {
  resetClock();
  const healthRoot = freshHealthRoot("chain-nontransient");
  const directCalls = [];
  const resolved = createResilientJevProvider({
    selectedProvider: VERCEL_JEV_PROVIDER,
    config: {
      gatewayApiKey: GATEWAY_KEY_SENTINEL,
      apiKey: DIRECT_KEY_SENTINEL,
      transportChain: ["vercel-jev", "typesafe-jev"],
      maxAttemptsPerCall: 3,
    },
    healthRoot,
    evaluateImpl: async () => {
      const error = new Error("invalid request");
      error.statusCode = 400;
      throw error;
    },
    fetchImpl: async () => {
      directCalls.push(1);
      return new Response("{}", { status: 200 });
    },
    sleepImpl: recordSleep,
    randomImpl: fixedRandom,
    now: () => ctx.clock.ms,
  });
  const outcome = await resolved.provider.evaluate({ state: {}, questions: buildExternalIntelligenceQuestions() });
  assertEqual(outcome.ok, false, "it still failed");
  assertEqual(outcome.providerAttemptCount, 1, "one attempt only");
  assertEqual(directCalls.length, 0, "a rejected request is not re-sent to another route");
  const health = await readProviderHealth(healthRoot, VERCEL_JEV_PROVIDER);
  assertEqual(health.cooldownUntil, null, "and no transient cooldown was opened");
});

/* ============================================================================
 * PART 7 — scientific identity / isolation barriers
 * ==========================================================================*/

test("54. no non-Jev decision model can ever enter the transport layer", () => {
  // (the transport module documents the same-Jev chain in prose; what matters is
  // that no OTHER model, and no mock, is reachable as a transport)
  const sources = [
    ctx.sources.get("scripts/jev/transport.mjs"),
    ctx.sources.get("scripts/jev/provider.mjs"),
    ctx.sources.get("scripts/jev/provider-health.mjs"),
    ctx.sources.get("scripts/jev-external.mjs"),
    ctx.sources.get("scripts/jev.mjs"),
  ];
  for (const source of sources) {
    for (const pattern of [/openai/i, /anthropic/i, /claude/i, /gemini/i, /\bgpt-/i, /deepseek\.com/i, /api\.deepseek/i, /EVOLVE_DEEPSEEK/]) {
      assertTrue(!pattern.test(source), `no fallback to a non-Jev model (${pattern})`);
    }
  }
  const transportSource = ctx.sources.get("scripts/jev/transport.mjs");
  assertTrue(!/mock-jev/.test(transportSource), "the offline mock is never a transport");
  assertTrue(!/createMockJevProvider/.test(transportSource), "transport.mjs cannot construct the mock");
  assertDeepEqual(parseJevTransportChain("typesafe-jev,vercel-jev").chain, ["typesafe-jev", "vercel-jev"], "same-Jev routes only");
});

test("55. the transport layer cannot trade, sign, or spawn a process", () => {
  // Composed from parts so this guard cannot itself read as the capability it
  // forbids (the same convention the Phase 5F.0 suite uses).
  const FORBIDDEN_TRADING_PATTERNS = [
    new RegExp("child" + "_" + "process", "i"),
    new RegExp("exec" + "Sync", "i"),
    new RegExp("spawn" + "Sync", "i"),
    new RegExp("execFile" + "Sync", "i"),
    new RegExp("private" + "[_-]?key", "i"),
    new RegExp("seed" + "[_-]?phrase", "i"),
    new RegExp("wallet" + "[_-]?adapter", "i"),
    new RegExp("new" + "[^A-Za-z0-9_]{1,4}" + "Connection" + "[^A-Za-z0-9_]{0,4}" + "[(]", "i"),
    new RegExp("send" + "Transaction", "i"),
    new RegExp("sign" + "Transaction", "i"),
  ];
  for (const file of ["scripts/jev/transport.mjs", "scripts/jev/provider-health.mjs", "scripts/jev-external.mjs", "scripts/jev.mjs"]) {
    const source = ctx.sources.get(file);
    for (const pattern of FORBIDDEN_TRADING_PATTERNS) assertTrue(!pattern.test(source), `${file} must not contain ${pattern}`);
  }
  const transportSource = ctx.sources.get("scripts/jev/transport.mjs");
  assertTrue(/PAPER ONLY/i.test(transportSource), "the transport module states the paper-only guarantee");
  assertTrue(/SHADOW ONLY/i.test(transportSource), "and the shadow-only guarantee");
});

test("56. neither the bridge nor the CLI reaches Agent-Reach, research, Arena or DeepSeek", () => {
  for (const file of ["scripts/jev-external-bridge.mjs", "scripts/jev-external.mjs"]) {
    const source = ctx.sources.get(file);
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
    for (const pattern of [/\/arena\//, /\/research\//, /agent-reach/, /deepseek/i, /child_process/]) {
      assertEqual(imports.some((specifier) => pattern.test(specifier)), false, `${file} imports nothing matching ${pattern}`);
    }
    assertTrue(!/deepseek\.com|api\.deepseek|EVOLVE_DEEPSEEK/i.test(source), `${file} names no DeepSeek endpoint or key`);
    assertTrue(!/EVOLVE_RESEARCH_PROVIDER/.test(source), `${file} never selects a research provider`);
  }
});

test("57. the external-intelligence bridge keeps its exact semantics (one logical decision)", async () => {
  resetClock();
  const result = await runExternalIntelligenceShadowDecision({
    externalPacket: ctx.externalPacket,
    provider: createMockJevProvider(),
    budget: createJevRunBudget(1),
    cacheEnabled: false,
    persist: true,
    experimentRootBase: ctx.jevBase,
    now: () => ctx.clock.ms,
    salt: "f51-bridge",
  });
  assertEqual(result.run.status, JEV_STATUS.OK, "the shadow decision succeeds");
  assertEqual(result.experimentId.startsWith("jexp-"), true, "the usual Jev experiment id");
  assertEqual(result.decisionRecord.packetKind, JEV_EXTERNAL_INTELLIGENCE_PACKET_KIND, "the packet kind is unchanged");
  assertEqual(result.decisionRecord.questionSetId, JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_ID, "the question set is unchanged");
  assertEqual(result.run.providerAttemptCount, 1, "the mock run records exactly one logical/physical attempt");
  assertEqual(result.decisionRecord.providerAttemptCount, 1, "and the decision record carries the same count");
  assertEqual(result.decisionRecord.providerAttempts, null, "no invented attempt records for a provider that reports none");

  // ...and a retried bridge decision is STILL one logical decision.
  resetClock();
  const stub = scriptedProvider({ results: [failResult(JEV_STATUS.RATE_LIMIT, 429), okResult()] });
  const transport = createResilientJevTransport({
    providers: [stub],
    settings: transportSettings(),
    healthRoot: freshHealthRoot("direct-transport"),
    sleepImpl: recordSleep,
    randomImpl: fixedRandom,
    now: () => ctx.clock.ms,
  });
  const retried = await runExternalIntelligenceShadowDecision({
    externalPacket: ctx.externalPacket,
    provider: transport,
    budget: createJevRunBudget(1),
    cacheEnabled: false,
    persist: true,
    experimentRootBase: ctx.jevBase,
    now: () => ctx.clock.ms,
    salt: "f51-bridge-retry",
  });
  assertEqual(retried.run.status, JEV_STATUS.OK, "the retried decision succeeds");
  assertEqual(retried.run.providerAttemptCount, 2, "two physical attempts");
  assertEqual(retried.decisionRecord.providerAttemptCount, 2, "the decision record carries both attempts");
  assertEqual(retried.decisionRecord.providerAttempts.length, 2, "including the failed one");
  assertEqual(retried.decisionRecord.subjectDigest, ctx.externalPacket.packetDigest, "the subject digest is unchanged");
});

test("58. an `escalate_to_deep_research` answer still invokes NOTHING", async () => {
  resetClock(NOW + 5_000);
  const before = await metadataSnapshot(path.join(REPO, ".evolve"));
  const stub = scriptedProvider({ results: [{ ok: true, model: "typesafe-ai/jev", requestId: "gen-esc", answers: escalationAnswers() }] });
  const transport = createResilientJevTransport({
    providers: [stub],
    settings: transportSettings(),
    healthRoot: freshHealthRoot("direct-transport"),
    sleepImpl: recordSleep,
    randomImpl: fixedRandom,
    now: () => ctx.clock.ms,
  });
  const result = await runExternalIntelligenceShadowDecision({
    externalPacket: ctx.externalPacket,
    provider: transport,
    budget: createJevRunBudget(1),
    cacheEnabled: false,
    persist: true,
    experimentRootBase: ctx.jevBase,
    now: () => ctx.clock.ms,
    salt: "f51-escalation",
  });
  assertEqual(result.decision.researchDisposition.choice, "escalate_to_deep_research", "the shadow answer IS escalate");
  assertEqual(result.decisionRecord.answers.researchDisposition.choice, "escalate_to_deep_research", "and it is persisted");
  assertEqual(stub.calls.length, 1, "exactly one provider call (the shadow call itself)");
  const after = await metadataSnapshot(path.join(REPO, ".evolve"));
  assertDeepEqual(after, before, "no repository `.evolve` artifact changed while the escalation decision ran");
});

test("59. the run record carries transport provenance and no secret of any kind", async () => {
  resetClock(NOW + 6_000);
  const healthDir = path.join(ctx.healthRoot, "..", "provenance-health");
  const stub = scriptedProvider({
    name: VERCEL_JEV_PROVIDER,
    results: [failResult(JEV_STATUS.RATE_LIMIT, 429), okResult("gen-prov")],
  });
  stub.evaluate = ((original) => async (args) => {
    const outcome = await original(args);
    return { ...outcome, providerMetadata: { ...(outcome.providerMetadata ?? {}), authorization: "Bearer leak", apiKey: "sk-leak" } };
  })(stub.evaluate.bind(stub));
  const transport = createResilientJevTransport({
    providers: [stub],
    settings: transportSettings(),
    healthRoot: healthDir,
    sleepImpl: recordSleep,
    randomImpl: fixedRandom,
    now: () => ctx.clock.ms,
  });
  const { run } = await jevDecide({
    provider: transport,
    packet: ctx.jevPacket,
    questions: buildExternalIntelligenceQuestions(),
    questionSetId: JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_ID,
    questionSetVersion: 1,
    decisionPacketVersion: 1,
    root: null,
    budget: createJevRunBudget(1),
    now: () => ctx.clock.ms,
  });
  assertEqual(run.status, JEV_STATUS.OK, "the decision succeeded");
  assertEqual(run.providerAttemptCount, 2, "two attempts");
  const serialized = canonicalJson(run);
  for (const forbidden of ["Bearer leak", "sk-leak", "authorization", "apiKey", "cookie"]) {
    assertTrue(!serialized.includes(forbidden), `the run record never contains '${forbidden}'`);
  }
  assertTrue(serialized.includes("providerAttempts"), "the attempts are on the run record");
  assertTrue(serialized.includes("providerAttemptCount"), "so is the count");
});

test("60. no provider-health artifact is ever written into the repository", async () => {
  const repoHealth = path.join(REPO, JEV_PROVIDER_HEALTH_DIR);
  const before = await metadataSnapshot(repoHealth);
  resetClock(NOW + 7_000);
  const { transport } = makeTransport({ results: [failResult(JEV_STATUS.RATE_LIMIT, 429)] });
  await transport.evaluate({ state: {}, questions: {} });
  const after = await metadataSnapshot(repoHealth);
  assertDeepEqual(after, before, "the repository health directory is untouched by this suite");
});

/* ============================================================================
 * PART 8 — identity barriers (captures, waves, cohorts, datasets, contract)
 * ==========================================================================*/

test("61. the real V2 capture is byte-identical and replays to its pinned digests", async () => {
  if (!ctx.realCaptureAvailable) {
    skip(`the real capture ${REAL_V2_CAPTURE_ID} is not present — pinned-digest cases were skipped`);
    return;
  }
  const manifest = await readCaptureManifest(REAL_CAPTURE_ROOT, REAL_V2_CAPTURE_ID);
  assertEqual(manifest.captureSchemaVersion, 2, "the real V2 manifest is schema 2");
  assertEqual(manifest.featureVersion, INTELLIGENCE_FEATURE_VERSION_V2, "the real V2 manifest pins V2");
  assertEqual(manifest.manifestDigest, REAL_V2_PINS.manifestDigest, "the manifest digest is EXACTLY the pinned value");
  assertEqual(manifest.digests.recordsDigest, REAL_V2_PINS.recordsDigest, "the records digest is EXACTLY the pinned value");
  const integrity = await verifyCapture(REAL_CAPTURE_ROOT, REAL_V2_CAPTURE_ID);
  assertEqual(integrity.ok, true, `the real V2 capture still verifies (${integrity.reason ?? "ok"})`);
  const replay = await replayCapture({ root: REAL_CAPTURE_ROOT, captureId: REAL_V2_CAPTURE_ID, asOf: null });
  assertEqual(replay.replayDigest, REAL_V2_PINS.replayDigest, "the replay digest is EXACTLY the pinned value");
  const packet = buildExternalIntelligencePacket({ replay });
  assertEqual(packet.packetDigest, REAL_V2_PINS.packetDigest, "the packet digest is EXACTLY the pinned value");
});

test("62. the legacy V1 capture replays to its pinned digest", async () => {
  if (!ctx.realCaptureAvailable) {
    skip(`the legacy capture ${LEGACY_V1_CAPTURE_ID} is not present — its pinned replay case was skipped`);
    return;
  }
  const manifest = await readCaptureManifest(REAL_CAPTURE_ROOT, LEGACY_V1_CAPTURE_ID);
  assertEqual(manifest.captureSchemaVersion, 1, "the legacy manifest is still schema 1");
  assertEqual(manifest.featureVersion, undefined, "the legacy manifest was NOT mutated to add a version pin");
  const replay = await replayCapture({ root: REAL_CAPTURE_ROOT, captureId: LEGACY_V1_CAPTURE_ID, asOf: null });
  assertEqual(replay.replayDigest, LEGACY_V1_REPLAY_DIGEST, "the legacy replay digest is EXACTLY the pinned value");
});

test("63-66. Wave 1, Wave 2, the six datasets and the frozen cohorts are byte-identical", async () => {
  if (!ctx.evidenceAvailable) {
    skip("the .evolve replication/history evidence is not present — identity cases were skipped");
    return;
  }
  let checked = 0;
  for (const wave of [
    { label: "Wave 1", ids: WAVE_1_DATASET_IDS, fingerprints: WAVE_1_DATASET_FINGERPRINTS },
    { label: "Wave 2", ids: WAVE_2_DATASET_IDS, fingerprints: WAVE_2_DATASET_FINGERPRINTS },
  ]) {
    assertEqual(wave.ids.length, 3, `${wave.label} is three datasets`);
    for (const id of wave.ids) {
      assertEqual(await datasetFingerprint(id), wave.fingerprints[id], `${id} still matches its pinned fingerprint`);
      checked += 1;
    }
  }
  assertEqual(checked, 6, "exactly six replication datasets were verified byte-identical");

  const mock = await readFrozenCohort(path.join(REPO, ".evolve", "replication"), "mock");
  const deepseek = await readFrozenCohort(path.join(REPO, ".evolve", "replication"), "deepseek");
  assertEqual(mock.cohortDigest, FROZEN_COHORT_DIGESTS.mock, "the Mock cohort digest is unchanged");
  assertEqual(deepseek.cohortDigest, FROZEN_COHORT_DIGESTS.deepseek, "the DeepSeek cohort digest is unchanged");
  assertEqual(mock.immutable, true, "the Mock cohort is still immutable");
  assertEqual(deepseek.frozen, true, "the DeepSeek cohort is still frozen");

  assertDeepEqual(await metadataSnapshot(path.join(REPO, ".evolve", "replication", "waves")), ctx.evidenceBaseline.waves, "wave manifests unchanged");
  assertDeepEqual(await metadataSnapshot(path.join(REPO, ".evolve", "replication", "cohorts")), ctx.evidenceBaseline.cohorts, "cohorts unchanged");
  assertDeepEqual(await metadataSnapshot(path.join(REPO, ".evolve", "history")), ctx.evidenceBaseline.history, "recorded datasets unchanged");
  assertDeepEqual(await metadataSnapshot(REAL_CAPTURE_ROOT), ctx.evidenceBaseline.intelligence, "the real captures' bytes did not change");
  assertDeepEqual(await metadataSnapshot(path.join(REPO, ".evolve", "jev")), ctx.evidenceBaseline.jev, "no existing Jev experiment was touched");
  assertEqual(CANONICAL_WAVE_1_REPLICATION_ID, "rep-66884de4e460", "the canonical Wave 1 replication id is unchanged");
  assertEqual(CANONICAL_HISTORICAL_FREEZE_PATH, "phase5c-freeze.json", "the canonical historical freeze path is unchanged");
});

test("67. the evaluation contract digest is EXACTLY the pinned value", async () => {
  assertEqual(
    CANONICAL_EVALUATION_CONTRACT_DIGEST,
    "4cf8ac1fa7db290acadeccf6043ec34c3239f8e3f848e9e50d8560826de85052",
    "the published contract pin is unchanged",
  );
  if (!ctx.evidenceAvailable) {
    skip("the stored Wave 1 freeze is not present — the derived-contract case was skipped");
    return;
  }
  const stored = await readFreeze({ root: path.join(REPO, ".evolve", "replication") });
  assertEqual(evaluationContractDigest(stored), CANONICAL_EVALUATION_CONTRACT_DIGEST, "the STORED freeze still derives the canonical digest");
});

/* ============================================================================
 * Runner
 * ==========================================================================*/

async function run() {
  let passed = 0;
  const failures = [];
  const started = Date.now();

  try {
    await buildFixtures();
  } catch (error) {
    console.error("could not build Phase 5F.1 fixtures:", error?.stack ?? error);
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

  await disposeFixtures();

  console.log(`\nfixtures built in ${fixtureMs}ms`);
  console.log("offline: no real Jev call, no network call, no live capture, no Agent-Reach call, no DeepSeek call, no Arena run, zero real delay.");
  if (skips.length > 0) {
    console.log(`skipped ${skips.length} optional case(s) whose evidence is absent here:`);
    for (const reason of skips) console.log(`  - ${reason}`);
  }
  console.log(`EVOLVE Phase 5F.1 resilient Jev transport validation: ${passed}/${cases.length} checks passed`);

  if (failures.length > 0) {
    console.log("Failed checks:");
    for (const failure of failures) console.log(`  - ${failure.name}`);
    process.exitCode = 1;
  } else {
    console.log("All Phase 5F.1 checks passed. ONE logical Jev decision may consume several bounded PHYSICAL");
    console.log("transport attempts, retrying ONLY transient failures with bounded backoff/jitter, honouring a");
    console.log("clamped Retry-After, cooling down a persistently rate-limited provider, and failing safely");
    console.log("instead of calling it again. No other decision model is reachable, failed attempts are never");
    console.log("discarded, and SDK-level retries remain disabled.");
  }
}

run().catch((error) => {
  console.error("phase 5F.1 validation runner crashed:", error);
  process.exitCode = 1;
});
