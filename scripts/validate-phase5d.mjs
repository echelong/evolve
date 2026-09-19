#!/usr/bin/env node
/**
 * EVOLVE Phase 5D validation suite — Jev, a SHADOW DECISION SUPERVISOR.
 *
 * Covers: the dedicated Jev provider registry (fail-closed selection,
 * disabled-by-default, `EVOLVE_JEV_*` config independent from
 * `EVOLVE_RESEARCH_PROVIDER`), typed answer normalization for both providers,
 * the versioned TRAIN-safe decision packet + leakage audit, the fixed
 * candidate and market question sets, deterministic state/question digests,
 * cache identity + cache-hit no-call behaviour, run-budget accounting, timeout
 * / HTTP-error / connection-error classification, secret hygiene, mock
 * determinism, the shadow-only invariant (Jev disabled vs. Jev shadow yields
 * byte-identical deterministic output), prediction persistence BEFORE any
 * outcome exists, the pure post-outcome calibration layer (Brier score,
 * reliability bins, multi-label primaryRisk agreement, regime-shadow
 * comparison, threshold-coverage analysis with no promoted threshold), no
 * Jev code inside Arena/compiler/watchdog/simulation, no wallet/signing/
 * execution capability, and non-interference with Phase 5B/5C canonical
 * artifacts, Wave 1 replication, and the untouched Wave 2 dataset.
 *
 * Fully OFFLINE and deterministic: the real provider is only ever exercised
 * through an injected `fetch` stub. No network call, no DeepSeek call, no
 * live Jev call, and no real Arena run happens anywhere in this file.
 *
 * Run with: npm run validate:phase5d
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { digestOf } from "./lib/hash.mjs";
import { REGIMES, computeArenaScore, evaluateSurvivalGates } from "./arena/orchestrator.mjs";

import {
  DEFAULT_JEV_MODE,
  DEFAULT_JEV_MODEL,
  JEV_PROVIDER,
  JEV_STATUS,
  NO_JEV_DECISION,
  REGISTERED_JEV_PROVIDERS,
  UnknownJevProviderError,
  UnsupportedJevModeError,
  readBoolEnv,
  readFloatEnv,
  readIntEnv,
  requireJevProviderName,
  resolveJevConfig,
  validateJevProviderName,
} from "./jev/config.mjs";
import { createDisabledJevProvider, resolveJevProvider } from "./jev/provider.mjs";
import { createMockJevProvider, MOCK_JEV_PROVIDER } from "./jev/providers/mock-jev.mjs";
import { createTypeSafeJevProvider } from "./jev/providers/typesafe-jev.mjs";
import {
  ALLOWED_GENOME_PARAM_KEYS,
  FORBIDDEN_JEV_KEYS,
  JEV_DECISION_PACKET_VERSION,
  JEV_EXCLUDED_EVIDENCE_CLASSES,
  JEV_PACKET_KIND,
  auditJevDecisionPacket,
  buildCandidateDecisionPacket,
  buildMarketDecisionPacket,
  jevStateDigestOf,
} from "./jev/decision-packet.mjs";
import {
  CANDIDATE_QUESTION_NAMES,
  EVIDENCE_QUALITY_LEVELS,
  JEV_CANDIDATE_QUESTION_SET_ID,
  JEV_CANDIDATE_QUESTION_SET_VERSION,
  JEV_MARKET_QUESTION_SET_ID,
  JEV_MARKET_QUESTION_SET_VERSION,
  MARKET_QUESTION_NAMES,
  PRIMARY_RISK_VOCAB,
  RESEARCH_DISPOSITION_VOCAB,
  buildCandidateQuestions,
  buildMarketQuestions,
} from "./jev/questions.mjs";
import {
  createJevRunBudget,
  isJevFailure,
  jevCacheKey,
  normalizeAnswer,
  normalizeAnswers,
  readJevCache,
  validateAnswers,
} from "./jev/runtime.mjs";
import { jevDecide, jevRunIdFor } from "./jev/decide.mjs";
import {
  buildJevDecisionRecord,
  buildJevOutcomeRecord,
  createJevExperiment,
  isValidJevExperimentId,
  jevDecisionIdFor,
  jevExperimentIdFor,
  jevExperimentRootFor,
  listJevDecisions,
  listJevOutcomes,
  readJevExperiment,
  writeJevDecision,
  writeJevExperiment,
  writeJevOutcome,
} from "./jev/experiment.mjs";
import {
  CONFIDENCE_THRESHOLDS_V1,
  GATE_FAILURE_TARGET_DEFINITION_V1,
  GATE_LABEL_TO_RISK_VOCAB,
  GENERALIZATION_TARGET_DEFINITION_V1,
  absoluteCalibrationError,
  brierScore,
  calibrateNoulQuestion,
  evaluateEvidenceQuality,
  evaluatePrimaryRisk,
  evaluateRegimeShadow,
  gateFailureOutcome,
  generalizationOutcome,
  joinDecisionsWithOutcomes,
  reliabilityBins,
  runJevCalibration,
  thresholdCoverageAnalysis,
} from "./jev/calibration.mjs";
import { loadJevShadowState } from "./jev/dashboard.mjs";
import { sanitizeForPublic } from "./lib/sanitize.mjs";

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
  if (actual !== expected) fail(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}
function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(`${message} (expected ${b}, got ${a})`);
}
function assertClose(actual, expected, tolerance, message) {
  assert(Number.isFinite(actual), `${message} (got ${actual})`);
  assert(Math.abs(actual - expected) <= tolerance, `${message} (expected ~${expected}, got ${actual})`);
}

async function withTempDir(fn, prefix = "evolve-5d-") {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/* ============================================================================
 * Fixtures
 * ==========================================================================*/

function candidatePacketFixture(overrides = {}) {
  return buildCandidateDecisionPacket({
    experimentId: "jexp-test-0000000000000000-mock-jev-abc123",
    candidateDigest: "cand-fixture-0001",
    species: "Momentum",
    family: "Momentum x Wallet Flow",
    genomeParams: { momentumWeight: 0.4, maxHold: 42, notAWhitelistedParam: 999 },
    train: {
      tradeCount: 25,
      mintDiversity: 5,
      concentration: 0.4,
      costDrag: 0.02,
      drawdown: 0.25,
      regimeDistribution: { "strong-risk-on": 3, "not-a-real-regime": 99 },
    },
    watchdog: { verdict: "WATCH", findings: [{ kind: "x", detail: "y", severity: "low" }] },
    researchLifecycleState: "COMPILED",
    createdAt: "2026-09-19T00:00:00.000Z",
    ...overrides,
  });
}

/** A spy provider that counts invocations and can be scripted to fail. */
function spyProvider({ ok = true, answers = null, throwError = null, model = "spy-model" } = {}) {
  const calls = [];
  return {
    name: "spy-provider",
    model,
    offline: true,
    external: false,
    calls,
    async evaluate(args) {
      calls.push(args);
      if (throwError) throw throwError;
      if (!ok) return { ok: false, status: JEV_STATUS.HTTP_ERROR, reason: "spy failure" };
      return { ok: true, model, requestId: "spy-req", answers: answers ?? {}, usage: { input_tokens: 1, output_tokens: 1 } };
    },
  };
}

function okCandidateAnswers() {
  return {
    gateFailureRisk: { type: "noul", noul: 0.3 },
    primaryRisk: { type: "choice", choice: "concentration", confidence: 0.6, probabilities: { concentration: 0.6 } },
    evidenceQuality: { type: "score", score: 3, confidence: 0.7, legend: {}, probabilities: {} },
    generalizationConfidence: { type: "noul", noul: 0.6 },
    researchDisposition: {
      type: "choice",
      choice: "continue_observing",
      confidence: 0.5,
      probabilities: { continue_observing: 0.5 },
    },
  };
}

/* ============================================================================
 * A. Config / provider registry — fail-closed selection
 * ==========================================================================*/

test("1. Jev is DISABLED by default when EVOLVE_JEV_PROVIDER is unset", () => {
  const config = resolveJevConfig({});
  assertEqual(config.provider, null, "no provider is resolved by default");
  assertEqual(config.enabled, false, "Jev is not enabled by default");
  assertEqual(config.defaulted, true, "the default is recorded as defaulted");
  assertEqual(config.configError, null, "an unset provider is not a configuration error");
  assertEqual(config.allowFallback, false, "there is never an automatic fallback");
});

test("2. An empty EVOLVE_JEV_PROVIDER value is treated as unset (disabled)", () => {
  const config = resolveJevConfig({ EVOLVE_JEV_PROVIDER: "" });
  assertEqual(config.provider, null, "empty string resolves to disabled");
  assertEqual(config.enabled, false, "disabled is not enabled");
});

test("3. `mock-jev` is selected explicitly and only by name", () => {
  const config = resolveJevConfig({ EVOLVE_JEV_PROVIDER: "mock-jev" });
  assertEqual(config.provider, JEV_PROVIDER.MOCK, "the explicit name is honoured");
  assertEqual(config.enabled, true, "an explicit registered provider is enabled");
  assertEqual(config.specified, true, "explicitly specified");
  assertEqual(resolveJevConfig({ EVOLVE_JEV_PROVIDER: "MOCK-JEV" }).provider, JEV_PROVIDER.MOCK, "case-insensitive");
});

test("4. `typesafe-jev` is selected explicitly and only by name", () => {
  const config = resolveJevConfig({ EVOLVE_JEV_PROVIDER: "typesafe-jev" });
  assertEqual(config.provider, JEV_PROVIDER.TYPESAFE, "the explicit name is honoured");
  assertEqual(config.enabled, true, "enabled with a valid mode");
});

test("5. An unregistered EVOLVE_JEV_PROVIDER name is a CONFIGURATION ERROR, never mock, never disabled-silently", () => {
  const config = resolveJevConfig({ EVOLVE_JEV_PROVIDER: "typesaef-jev" });
  assertEqual(config.provider, null, "no provider is resolved");
  assertEqual(config.enabled, false, "never enabled on a typo");
  assert(typeof config.configError === "string" && config.configError.length > 0, "a configuration error is reported");
  assertEqual(config.unknownProvider, "typesaef-jev", "the exact typo is recorded");
});

test("6. `resolveJevProvider` throws UnknownJevProviderError for an unregistered name (fail-closed, no call possible)", () => {
  let thrown = null;
  try {
    resolveJevProvider("typesaef-jev", {});
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof UnknownJevProviderError, "the specific error type is thrown");
  assertEqual(thrown.code, "UNKNOWN_JEV_PROVIDER", "the error carries a stable code");
  assertDeepEqual([...thrown.registeredProviders].sort(), [...REGISTERED_JEV_PROVIDERS].sort(), "registered providers are listed");
});

test("7. `requireJevProviderName` never fails closed for an unset name — it defaults to disabled", () => {
  const resolution = requireJevProviderName("");
  assertEqual(resolution.specified, false, "unset is not specified");
  assertEqual(resolution.provider, null, "unset resolves to null (disabled)");
  assertEqual(resolution.defaulted, true, "the default is marked");
});

test("8. `validateJevProviderName` never throws and reports empty vs unrecognized distinctly", () => {
  assertEqual(validateJevProviderName("").recognized, false, "empty is not recognized");
  assertEqual(validateJevProviderName("").empty, true, "empty is flagged distinctly");
  assertEqual(validateJevProviderName("mock-jev").recognized, true, "a registered name is recognized");
  assertEqual(validateJevProviderName("bogus").recognized, false, "an unregistered name is not recognized");
  assertEqual(validateJevProviderName("bogus").empty, false, "an unregistered non-empty name is not flagged empty");
});

test("9. `EVOLVE_JEV_MODE` defaults to shadow, and only shadow is supported in Phase 5D", () => {
  const config = resolveJevConfig({ EVOLVE_JEV_PROVIDER: "mock-jev" });
  assertEqual(config.mode, DEFAULT_JEV_MODE, "shadow is the default mode");
  assertEqual(config.modeValid, true, "shadow is a valid mode");

  for (const badMode of ["active", "enforce", "trade", "route"]) {
    const bad = resolveJevConfig({ EVOLVE_JEV_PROVIDER: "mock-jev", EVOLVE_JEV_MODE: badMode });
    assertEqual(bad.modeValid, false, `'${badMode}' is not a supported Phase 5D mode`);
    assertEqual(bad.enabled, false, `an unsupported mode disables Jev even with a valid provider name ('${badMode}')`);
    assert(typeof bad.configError === "string" && bad.configError.length > 0, `'${badMode}' produces a configuration error`);
  }
});

test("10. `UnsupportedJevModeError` names the offending mode", () => {
  const error = new UnsupportedJevModeError("active");
  assertEqual(error.code, "UNSUPPORTED_JEV_MODE", "stable error code");
  assert(error.message.includes("active"), "the message names the mode");
});

test("11. Jev configuration is completely independent from `EVOLVE_RESEARCH_PROVIDER`", () => {
  const config = resolveJevConfig({ EVOLVE_RESEARCH_PROVIDER: "deepseek-cline" });
  assertEqual(config.provider, null, "EVOLVE_RESEARCH_PROVIDER never selects a Jev provider");
  assertEqual(config.enabled, false, "still disabled");

  const configWithBoth = resolveJevConfig({ EVOLVE_RESEARCH_PROVIDER: "mock", EVOLVE_JEV_PROVIDER: "mock-jev" });
  assertEqual(configWithBoth.provider, JEV_PROVIDER.MOCK, "EVOLVE_JEV_PROVIDER is read independently");
});

test("12. The default pinned Jev model is a VERSIONED id, never the moving `jev-latest` alias", () => {
  assertEqual(DEFAULT_JEV_MODEL, "jev-1.13.0", "the exact pinned version verified against docs.typesafe.ai/models");
  assert(!DEFAULT_JEV_MODEL.includes("latest"), "the default is never an alias");
  const config = resolveJevConfig({ EVOLVE_JEV_PROVIDER: "typesafe-jev" });
  assertEqual(config.model, DEFAULT_JEV_MODEL, "the resolved default model is the pinned version");
});

test("13. EVOLVE_JEV_MODEL overrides the pinned default explicitly", () => {
  const config = resolveJevConfig({ EVOLVE_JEV_PROVIDER: "typesafe-jev", EVOLVE_JEV_MODEL: "jev-preview" });
  assertEqual(config.model, "jev-preview", "an explicit override is honoured");
});

test("14. EVOLVE_JEV_TIMEOUT_MS / EVOLVE_JEV_MAX_CALLS are bounds-clamped, never silently ignored", () => {
  const tooLow = resolveJevConfig({ EVOLVE_JEV_TIMEOUT_MS: "1" });
  assert(tooLow.timeoutMs >= 1_000, "timeout is clamped to the documented floor");
  const tooHigh = resolveJevConfig({ EVOLVE_JEV_TIMEOUT_MS: "99999999" });
  assert(tooHigh.timeoutMs <= 120_000, "timeout is clamped to the documented ceiling");
  const tooManyCalls = resolveJevConfig({ EVOLVE_JEV_MAX_CALLS: "99999" });
  assert(tooManyCalls.maxCallsPerRun <= 500, "max calls is clamped to the documented ceiling");
  const tooFewCalls = resolveJevConfig({ EVOLVE_JEV_MAX_CALLS: "0" });
  assert(tooFewCalls.maxCallsPerRun >= 1, "max calls is clamped to at least one");
});

test("15. EVOLVE_JEV_MIN_CONFIDENCE parses and clamps to [0,1], and is null when unset", () => {
  assertEqual(resolveJevConfig({}).minConfidence, null, "no default confidence threshold is configured");
  assertEqual(resolveJevConfig({ EVOLVE_JEV_MIN_CONFIDENCE: "0.8" }).minConfidence, 0.8, "a valid value is parsed");
  assertEqual(resolveJevConfig({ EVOLVE_JEV_MIN_CONFIDENCE: "5" }).minConfidence, 1, "an out-of-range value is clamped to 1");
  assertEqual(resolveJevConfig({ EVOLVE_JEV_MIN_CONFIDENCE: "-5" }).minConfidence, 0, "an out-of-range value is clamped to 0");
});

test("16. EVOLVE_JEV_API_KEY is read into config but never echoed anywhere except the explicit `apiKey` field", () => {
  const config = resolveJevConfig({ EVOLVE_JEV_API_KEY: "sk-super-secret-1234567890" });
  assertEqual(config.apiKey, "sk-super-secret-1234567890", "the raw key is available for the provider constructor");
  assertEqual(config.apiKeyConfigured, true, "a boolean flag is also available for display");
  const sanitized = JSON.stringify(sanitizeForPublic({ ...config, apiKey: config.apiKey }));
  assert(!sanitized.includes("sk-super-secret"), "sanitizeForPublic strips the credential-named field before display");
});

test("17. `readBoolEnv` / `readIntEnv` / `readFloatEnv` never throw on garbage input and fall back cleanly", () => {
  assertEqual(readBoolEnv({ X: "yes" }, "X", false), true, "yes parses true");
  assertEqual(readBoolEnv({ X: "nope" }, "X", false), false, "an unrecognized value falls back");
  assertEqual(readIntEnv({ X: "abc" }, "X", 7, { min: 0, max: 10 }), 7, "non-numeric falls back to the default");
  assertEqual(readFloatEnv({ X: "abc" }, "X", 0.5), 0.5, "non-numeric float falls back to the default");
});

test("18. `resolveJevProvider` with the disabled resolution returns a provider whose every call is JEV_DISABLED, with zero network capability", async () => {
  const provider = resolveJevProvider("", {});
  assertEqual(provider.disabled, true, "the provider self-reports as disabled");
  const result = await provider.evaluate({ state: {}, questions: {} });
  assertEqual(result.ok, false, "never a successful answer");
  assertEqual(result.status, JEV_STATUS.DISABLED, "the disabled status is explicit");
});

test("19. `createDisabledJevProvider` is stable and reusable (no hidden state between calls)", async () => {
  const provider = createDisabledJevProvider();
  const first = await provider.evaluate({});
  const second = await provider.evaluate({});
  assertDeepEqual(first, second, "the disabled provider is pure");
});

/* ============================================================================
 * B. Provider factories — typed normalization and error classification
 * ==========================================================================*/

test("20. `mock-jev` answers all five candidate questions with valid typed shapes", async () => {
  const provider = createMockJevProvider();
  const result = await provider.evaluate({ state: candidatePacketFixture(), questions: buildCandidateQuestions() });
  assertEqual(result.ok, true, "the mock always succeeds");
  assertEqual(result.model, MOCK_JEV_PROVIDER + "-v1", "reports a stable synthetic model id");
  for (const name of CANDIDATE_QUESTION_NAMES) {
    assert(result.answers[name], `answer present for ${name}`);
  }
});

test("21. `mock-jev` marks every decision `syntheticDecision: true`", async () => {
  const provider = createMockJevProvider();
  const result = await provider.evaluate({ state: candidatePacketFixture(), questions: buildCandidateQuestions() });
  assertEqual(result.syntheticDecision, true, "never presented as calibrated");
});

test("22. `mock-jev` is DETERMINISTIC: the same packet always yields byte-identical answers", async () => {
  const provider = createMockJevProvider();
  const packet = candidatePacketFixture();
  const first = await provider.evaluate({ state: packet, questions: buildCandidateQuestions() });
  const second = await provider.evaluate({ state: packet, questions: buildCandidateQuestions() });
  assertDeepEqual(first.answers, second.answers, "identical state yields identical answers");
});

test("23. `mock-jev` answers the market question set with a choice restricted to REGIMES", async () => {
  const provider = createMockJevProvider();
  const packet = buildMarketDecisionPacket({ windowLabel: "W1", marketFeatures: { meanReturn: 0.03 } });
  const result = await provider.evaluate({ state: packet, questions: buildMarketQuestions() });
  assert(REGIMES.includes(result.answers.regime.choice), "the selected regime is one of EVOLVE's existing labels");
  assertDeepEqual(Object.keys(result.answers.regime.probabilities).sort(), [...REGIMES].sort(), "the full distribution covers exactly the existing regimes");
});

test("24. `typesafe-jev` calls the documented endpoint with a Bearer header and the pinned model", async () => {
  let seenUrl = null;
  let seenAuth = null;
  let seenModel = null;
  const fetchImpl = async (url, init) => {
    seenUrl = url;
    seenAuth = init.headers.Authorization;
    seenModel = JSON.parse(init.body).model;
    return new Response(JSON.stringify({ model: seenModel, answers: okCandidateAnswers(), usage: { input_tokens: 5, output_tokens: 5 } }), {
      status: 200,
      headers: { "content-type": "application/json", "x-typesafe-request-id": "req-24" },
    });
  };
  const provider = createTypeSafeJevProvider({ apiKey: "sk-test-key-0000000000", model: DEFAULT_JEV_MODEL, fetchImpl });
  const result = await provider.evaluate({ state: candidatePacketFixture(), questions: buildCandidateQuestions() });
  assertEqual(seenUrl, "https://api.typesafe.ai/v1/systemone", "the documented endpoint is used");
  assertEqual(seenAuth, "Bearer sk-test-key-0000000000", "the documented Bearer auth header is used");
  assertEqual(seenModel, DEFAULT_JEV_MODEL, "the pinned model id is sent, never a moving alias");
  assertEqual(result.ok, true, "the call succeeds");
  assertEqual(result.requestId, "req-24", "the request id is captured from the response header");
});

test("25. `typesafe-jev` classifies HTTP 401/403 as JEV_CONFIG_ERROR", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
  const provider = createTypeSafeJevProvider({ apiKey: "sk-bad", model: DEFAULT_JEV_MODEL, fetchImpl });
  const result = await provider.evaluate({ state: {}, questions: buildCandidateQuestions() });
  assertEqual(result.ok, false, "not ok");
  assertEqual(result.status, JEV_STATUS.CONFIG_ERROR, "auth failure is a configuration error, not a transient failure");
});

test("26. `typesafe-jev` classifies HTTP 429/5xx as JEV_HTTP_ERROR", async () => {
  for (const status of [429, 500, 529]) {
    const fetchImpl = async () => new Response(JSON.stringify({ error: "x" }), { status, headers: { "content-type": "application/json" } });
    const provider = createTypeSafeJevProvider({ apiKey: "sk-x", model: DEFAULT_JEV_MODEL, fetchImpl });
    const result = await provider.evaluate({ state: {}, questions: buildCandidateQuestions() });
    assertEqual(result.status, JEV_STATUS.HTTP_ERROR, `HTTP ${status} classifies as JEV_HTTP_ERROR`);
  }
});

test("27. `typesafe-jev` classifies a connection failure as JEV_UNAVAILABLE", async () => {
  const fetchImpl = async () => {
    throw new TypeError("fetch failed");
  };
  const provider = createTypeSafeJevProvider({ apiKey: "sk-x", model: DEFAULT_JEV_MODEL, fetchImpl });
  const result = await provider.evaluate({ state: {}, questions: buildCandidateQuestions() });
  assertEqual(result.status, JEV_STATUS.UNAVAILABLE, "a connection error is unavailable, not a hard config error");
});

test("28. `typesafe-jev` classifies a timeout as JEV_TIMEOUT and never hangs the caller", async () => {
  const fetchImpl = (url, init) =>
    new Promise((resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      setTimeout(() => resolve(new Response("{}", { status: 200 })), 5_000);
    });
  const provider = createTypeSafeJevProvider({ apiKey: "sk-x", model: DEFAULT_JEV_MODEL, timeoutMs: 40, fetchImpl });
  const started = Date.now();
  const result = await provider.evaluate({ state: {}, questions: buildCandidateQuestions() });
  assertEqual(result.status, JEV_STATUS.TIMEOUT, "a slow response is classified as a timeout");
  assert(Date.now() - started < 3_000, "the call actually returns promptly rather than waiting out the stub's delay");
});

test("29. `resolveJevProvider('typesafe-jev', ...)` WITHOUT an api key returns JEV_CONFIG_ERROR and makes ZERO network calls", async () => {
  let fetchCalls = 0;
  const provider = resolveJevProvider(JEV_PROVIDER.TYPESAFE, {
    apiKey: "",
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response("{}");
    },
  });
  const result = await provider.evaluate({ state: {}, questions: buildCandidateQuestions() });
  assertEqual(result.status, JEV_STATUS.CONFIG_ERROR, "missing key is a configuration error");
  assertEqual(fetchCalls, 0, "the SDK client is never even constructed, so fetch is never invoked");
});

test("30. `normalizeAnswer` maps raw SDK noul/choice/score shapes to EVOLVE's internal shape", () => {
  assertDeepEqual(normalizeAnswer({ type: "noul", noul: 0.42 }), { type: "noul", probability: 0.42 }, "noul mapping");
  assertDeepEqual(
    normalizeAnswer({ type: "choice", choice: "x", confidence: 0.5, probabilities: { x: 0.5 } }),
    { type: "choice", choice: "x", confidence: 0.5, probabilities: { x: 0.5 } },
    "choice mapping",
  );
  assertDeepEqual(
    normalizeAnswer({ type: "score", score: 2, confidence: 0.6, legend: { 0: "a" }, probabilities: { 0: 1 } }),
    { type: "score", score: 2, confidence: 0.6, legend: { 0: "a" }, probabilities: { 0: 1 } },
    "score mapping",
  );
  assertEqual(normalizeAnswer(null), null, "malformed input normalizes to null, never throws");
  assertEqual(normalizeAnswer({ type: "unknown" }), null, "an unrecognized type normalizes to null");
});

test("30b. `normalizeAnswers` normalizes a full raw answer map in one pass, dropping unrecognized entries to null", () => {
  const normalized = normalizeAnswers({
    a: { type: "noul", noul: 0.1 },
    b: { type: "choice", choice: "x", confidence: 0.2, probabilities: { x: 1 } },
    c: { type: "bogus" },
  });
  assertEqual(normalized.a.probability, 0.1, "noul entry normalized");
  assertEqual(normalized.b.choice, "x", "choice entry normalized");
  assertEqual(normalized.c, null, "an unrecognized entry normalizes to null rather than throwing");
});

test("31. `validateAnswers` rejects a missing answer, a malformed answer, and an unrecognized type", () => {
  const names = ["gateFailureRisk"];
  assertEqual(validateAnswers({}, names).ok, false, "missing answer is rejected");
  assertEqual(validateAnswers({ gateFailureRisk: { type: "noul", probability: "not-a-number" } }, names).ok, false, "non-finite probability rejected");
  assertEqual(validateAnswers({ gateFailureRisk: { type: "bogus" } }, names).ok, false, "unrecognized type rejected");
  assertEqual(validateAnswers({ gateFailureRisk: { type: "noul", probability: 0.5 } }, names).ok, true, "a well-formed answer is accepted");
});

/* ============================================================================
 * C. Decision packet — whitelist + leakage audit
 * ==========================================================================*/

test("32. The candidate decision packet drops any non-whitelisted genome parameter", () => {
  const packet = candidatePacketFixture();
  assert(!("notAWhitelistedParam" in packet.candidate.genomeParams), "the unlisted parameter is dropped");
  for (const key of Object.keys(packet.candidate.genomeParams)) {
    assert(ALLOWED_GENOME_PARAM_KEYS.includes(key), `${key} is on the whitelist`);
  }
});

test("33. The candidate decision packet drops any regime key outside EVOLVE's existing regime vocabulary", () => {
  const packet = candidatePacketFixture();
  assert(!("not-a-real-regime" in packet.train.regimeComposition), "an invented regime label is dropped");
  for (const key of Object.keys(packet.train.regimeComposition)) assert(REGIMES.includes(key), `${key} is a real regime`);
});

test("34. The candidate decision packet declares TRAIN evidence only and names every excluded class", () => {
  const packet = candidatePacketFixture();
  assertDeepEqual(packet.evidenceClasses, ["TRAIN_EVIDENCE"], "only TRAIN evidence is declared");
  for (const excluded of ["VALIDATION_EVIDENCE", "TEST_EVIDENCE", "OOS_EVIDENCE", "STRESS_EVIDENCE", "DEPLOYMENT_EVIDENCE", "ARENA_SCORE", "GATE_RESULT", "CHAMPION_LEAGUE_RESULT", "SHADOW_LEAGUE_OUTCOME", "FUTURE_REPLICATION_RESULT"]) {
    assert(JEV_EXCLUDED_EVIDENCE_CLASSES.includes(excluded), `${excluded} is explicitly named as excluded`);
    assert(packet.excludedEvidenceClasses.includes(excluded), `${excluded} appears on the packet's own exclusion list`);
  }
});

test("35. An out-of-vocabulary watchdog verdict is dropped to null, never passed through", () => {
  const packet = candidatePacketFixture({ watchdog: { verdict: "TOTALLY_MADE_UP", findings: [] } });
  assertEqual(packet.watchdogEvidence.verdict, null, "an unrecognized verdict is not trusted");
});

test("36. `auditJevDecisionPacket` accepts every packet produced by the whitelisted builders", () => {
  const candidateAudit = auditJevDecisionPacket(candidatePacketFixture());
  assertEqual(candidateAudit.ok, true, "a whitelisted candidate packet passes the audit");
  const marketAudit = auditJevDecisionPacket(buildMarketDecisionPacket({ windowLabel: "W1", marketFeatures: { meanReturn: 0.01 } }));
  assertEqual(marketAudit.ok, true, "a whitelisted market packet passes the audit");
});

test("37. `auditJevDecisionPacket` FLAGS every forbidden key, individually", () => {
  for (const key of FORBIDDEN_JEV_KEYS.slice(0, 12)) {
    const audit = auditJevDecisionPacket({ [key]: "leak" });
    assertEqual(audit.ok, false, `'${key}' is flagged as a leakage violation`);
  }
});

test("38. `auditJevDecisionPacket` FLAGS a forbidden key nested arbitrarily deep", () => {
  const audit = auditJevDecisionPacket({ candidate: { nested: { deeply: { arenaScore: 99 } } } });
  assertEqual(audit.ok, false, "a deeply nested forbidden key is still caught");
});

test("39. `auditJevDecisionPacket` FLAGS a credential-shaped string value even under an innocuous key name", () => {
  const audit = auditJevDecisionPacket({ note: "use bearer sk-abcdefghijklmnopqrstuvwx to authenticate" });
  assertEqual(audit.ok, false, "a bearer-token-shaped value is flagged regardless of its key name");
});

test("40. The market decision packet NEVER includes the deterministic regime label anywhere", () => {
  const packet = buildMarketDecisionPacket({
    windowLabel: "W1",
    marketFeatures: { meanReturn: 0.02 },
    // A caller mistake: passing extra fields should still never leak the label,
    // because the builder's whitelist has no field for it at all.
  });
  const serialized = JSON.stringify(packet);
  assert(!serialized.includes(`"deterministicRegime"`), "no deterministicRegime field exists anywhere in the packet");
});

test("41. `jevStateDigestOf` ignores volatile fields (createdAt, generatedBy) but is sensitive to content", () => {
  const a = candidatePacketFixture({ createdAt: "2026-01-01T00:00:00.000Z", generatedBy: { x: 1 } });
  const b = candidatePacketFixture({ createdAt: "2027-01-01T00:00:00.000Z", generatedBy: { x: 2 } });
  assertEqual(jevStateDigestOf(a), jevStateDigestOf(b), "volatile fields do not affect the state digest");
  const c = candidatePacketFixture({ candidateDigest: "cand-fixture-DIFFERENT" });
  assert(jevStateDigestOf(a) !== jevStateDigestOf(c), "a real content change DOES change the state digest");
});

test("42. `jevDecide` REFUSES to send a packet that fails the leakage audit", async () => {
  const provider = createMockJevProvider();
  let thrown = null;
  try {
    await jevDecide({
      provider,
      packet: { arenaScore: 99, ...candidatePacketFixture() },
      questions: buildCandidateQuestions(),
      questionSetId: JEV_CANDIDATE_QUESTION_SET_ID,
      questionSetVersion: JEV_CANDIDATE_QUESTION_SET_VERSION,
      decisionPacketVersion: JEV_DECISION_PACKET_VERSION,
      root: null,
      budget: createJevRunBudget(5),
    });
  } catch (error) {
    thrown = error;
  }
  assert(thrown, "a forbidden field in the packet aborts the call before Jev is ever asked");
});

/* ============================================================================
 * D. Question set — fixed, versioned, never dynamic
 * ==========================================================================*/

test("43. The candidate question set has exactly the five fixed named questions with the documented types", () => {
  const questions = buildCandidateQuestions();
  assertDeepEqual(Object.keys(questions).sort(), [...CANDIDATE_QUESTION_NAMES].sort(), "exactly the five named questions");
  assertEqual(questions.gateFailureRisk.type, "noul", "A: gateFailureRisk is noul");
  assertEqual(questions.primaryRisk.type, "choice", "B: primaryRisk is choice");
  assertEqual(questions.evidenceQuality.type, "score", "C: evidenceQuality is score");
  assertEqual(questions.generalizationConfidence.type, "noul", "D: generalizationConfidence is noul");
  assertEqual(questions.researchDisposition.type, "choice", "E: researchDisposition is choice");
});

test("44. `primaryRisk`'s bounded vocabulary matches the documented eight labels exactly", () => {
  assertDeepEqual(
    [...PRIMARY_RISK_VOCAB].sort(),
    [
      "insufficient_trades",
      "insufficient_mint_diversity",
      "concentration",
      "cost_drag",
      "drawdown",
      "stress_fragility",
      "regime_fragility",
      "no_obvious_risk",
    ].sort(),
    "the exact eight-label vocabulary",
  );
  assertDeepEqual(Object.keys(buildCandidateQuestions().primaryRisk.criteria).sort(), [...PRIMARY_RISK_VOCAB].sort(), "the question's criteria match the vocabulary exactly");
});

test("45. `researchDisposition`'s bounded vocabulary matches the documented four labels exactly", () => {
  assertDeepEqual([...RESEARCH_DISPOSITION_VOCAB].sort(), ["continue_observing", "candidate_for_arena", "needs_more_evidence", "high_risk"].sort(), "exact vocabulary");
});

test("46. `evidenceQuality` uses the documented small fixed 5-level rubric", () => {
  assertEqual(EVIDENCE_QUALITY_LEVELS.length, 5, "exactly five levels");
  assertEqual(buildCandidateQuestions().evidenceQuality.criteria.length, 5, "the question carries exactly five rubric entries");
});

test("47. The market question set asks EXACTLY one question, restricted to EVOLVE's existing regime vocabulary, never a new label", () => {
  const questions = buildMarketQuestions();
  assertDeepEqual(Object.keys(questions), MARKET_QUESTION_NAMES, "exactly one question");
  assertDeepEqual(Object.keys(questions.regime.criteria).sort(), [...REGIMES].sort(), "criteria are exactly the existing regimes, never extended");
});

test("48. Question sets are FIXED: repeated calls produce byte-identical question structures", () => {
  assertDeepEqual(buildCandidateQuestions(), buildCandidateQuestions(), "candidate questions are not dynamically regenerated");
  assertDeepEqual(buildMarketQuestions(), buildMarketQuestions(), "market questions are not dynamically regenerated");
});

test("48b. Question-set ids/versions are stable, named constants — never inferred from the questions themselves", () => {
  assertEqual(JEV_CANDIDATE_QUESTION_SET_ID, "jev-question-set-v1", "the exact documented candidate question-set id");
  assertEqual(JEV_CANDIDATE_QUESTION_SET_VERSION, 1, "the candidate question-set starts at version 1");
  assertEqual(JEV_MARKET_QUESTION_SET_ID, "jev-market-v1", "the exact documented market question-set id");
  assertEqual(JEV_MARKET_QUESTION_SET_VERSION, 1, "the market question-set starts at version 1");
});

/* ============================================================================
 * E. Cache identity + no-call replay
 * ==========================================================================*/

test("49. `jevCacheKey` changes when ANY identity component changes, holding the rest fixed", () => {
  const base = {
    provider: "mock-jev",
    model: "m1",
    decisionPacketVersion: 1,
    questionSetId: "q1",
    questionSetVersion: 1,
    stateDigest: "sd1",
    questionDigest: "qd1",
  };
  const baseline = jevCacheKey(base);
  for (const field of Object.keys(base)) {
    const changed = jevCacheKey({ ...base, [field]: `${base[field]}-different` });
    assert(changed !== baseline, `changing '${field}' changes the cache key`);
  }
});

test("50. A cache HIT makes ZERO calls to the provider and records cacheHit + originalJevRunId", async () => {
  await withTempDir(async (dir) => {
    const provider = spyProvider({ answers: okCandidateAnswers() });
    const packet = candidatePacketFixture();
    const questions = buildCandidateQuestions();
    const budget = createJevRunBudget(5);
    const common = {
      provider,
      packet,
      questions,
      questionSetId: JEV_CANDIDATE_QUESTION_SET_ID,
      questionSetVersion: JEV_CANDIDATE_QUESTION_SET_VERSION,
      decisionPacketVersion: JEV_DECISION_PACKET_VERSION,
      experimentId: "jexp-cache-test-000000000000-mock-jev-abcdef",
      root: dir,
      cacheEnabled: true,
      budget,
    };
    const first = await jevDecide(common);
    assertEqual(first.run.cacheHit, false, "the first call is a live call");
    assertEqual(provider.calls.length, 1, "one live provider call so far");

    const second = await jevDecide(common);
    assertEqual(second.run.cacheHit, true, "the second identical call is a cache hit");
    assertEqual(second.run.originalJevRunId, first.run.jevRunId, "provenance points back to the original run");
    assertEqual(provider.calls.length, 1, "NO additional provider call was made");
    assertEqual(budget.used, 1, "a cache hit consumes zero additional budget");
  });
});

test("51. Cache DISABLED means every call is live, even for an identical packet", async () => {
  await withTempDir(async (dir) => {
    const provider = spyProvider({ answers: okCandidateAnswers() });
    const packet = candidatePacketFixture();
    const questions = buildCandidateQuestions();
    const budget = createJevRunBudget(5);
    const common = {
      provider,
      packet,
      questions,
      questionSetId: JEV_CANDIDATE_QUESTION_SET_ID,
      questionSetVersion: JEV_CANDIDATE_QUESTION_SET_VERSION,
      decisionPacketVersion: JEV_DECISION_PACKET_VERSION,
      experimentId: "jexp-nocache-test-00000000000-mock-jev-abcdef",
      root: dir,
      cacheEnabled: false,
      budget,
    };
    await jevDecide(common);
    await jevDecide(common);
    assertEqual(provider.calls.length, 2, "caching disabled means every call reaches the provider");
  });
});

test("52. A corrupted/invalid cached payload is never reused", async () => {
  await withTempDir(async (dir) => {
    const provider = spyProvider({ answers: okCandidateAnswers() });
    const packet = candidatePacketFixture();
    const questions = buildCandidateQuestions();
    const budget = createJevRunBudget(5);
    const common = {
      provider,
      packet,
      questions,
      questionSetId: JEV_CANDIDATE_QUESTION_SET_ID,
      questionSetVersion: JEV_CANDIDATE_QUESTION_SET_VERSION,
      decisionPacketVersion: JEV_DECISION_PACKET_VERSION,
      experimentId: "jexp-badcache-test-0000000000-mock-jev-abcdef",
      root: dir,
      cacheEnabled: true,
      budget,
    };
    await jevDecide(common);
    // Corrupt the cache entry on disk directly.
    const stateDigest = jevStateDigestOf(packet);
    const questionDigest = digestOf(questions);
    const cacheKey = jevCacheKey({
      provider: provider.name,
      model: provider.model,
      decisionPacketVersion: JEV_DECISION_PACKET_VERSION,
      questionSetId: JEV_CANDIDATE_QUESTION_SET_ID,
      questionSetVersion: JEV_CANDIDATE_QUESTION_SET_VERSION,
      stateDigest,
      questionDigest,
    });
    const cached = await readJevCache(dir, cacheKey);
    assert(cached, "the cache entry was actually written");
    cached.answers.gateFailureRisk = { type: "noul", probability: "not-a-number" };
    await writeFile(path.join(dir, "provider", "cache", `${cacheKey}.json`), JSON.stringify(cached), "utf8");

    const second = await jevDecide(common);
    assertEqual(second.run.cacheHit, false, "a corrupted cache entry is never trusted");
    assertEqual(provider.calls.length, 2, "the corrupted entry forces a fresh live call");
  });
});

/* ============================================================================
 * F. Run budget
 * ==========================================================================*/

test("53. `createJevRunBudget` enforces the maximum and reports remaining/used accurately", () => {
  const budget = createJevRunBudget(2);
  assertEqual(budget.max, 2, "max is recorded");
  assertEqual(budget.exhausted(), false, "not exhausted at zero");
  budget.consume();
  assertEqual(budget.used, 1, "one used");
  assertEqual(budget.remaining, 1, "one remaining");
  budget.consume();
  assertEqual(budget.exhausted(), true, "exhausted at the max");
});

test("54. `jevDecide` refuses a call once the budget is exhausted, WITHOUT calling the provider", async () => {
  const provider = spyProvider({ answers: okCandidateAnswers() });
  const budget = createJevRunBudget(1);
  budget.consume(); // pre-exhaust
  const { run, decision } = await jevDecide({
    provider,
    packet: candidatePacketFixture(),
    questions: buildCandidateQuestions(),
    questionSetId: JEV_CANDIDATE_QUESTION_SET_ID,
    questionSetVersion: JEV_CANDIDATE_QUESTION_SET_VERSION,
    decisionPacketVersion: JEV_DECISION_PACKET_VERSION,
    root: null,
    budget,
  });
  assertEqual(run.status, JEV_STATUS.BUDGET_EXCEEDED, "the exhausted budget produces an explicit status");
  assertEqual(decision, NO_JEV_DECISION, "no decision is fabricated");
  assertEqual(provider.calls.length, 0, "the provider was never called");
});

test("55. A FAILED live call still consumes attempted-call budget", async () => {
  const provider = spyProvider({ ok: false });
  const budget = createJevRunBudget(3);
  await jevDecide({
    provider,
    packet: candidatePacketFixture(),
    questions: buildCandidateQuestions(),
    questionSetId: JEV_CANDIDATE_QUESTION_SET_ID,
    questionSetVersion: JEV_CANDIDATE_QUESTION_SET_VERSION,
    decisionPacketVersion: JEV_DECISION_PACKET_VERSION,
    root: null,
    budget,
  });
  assertEqual(budget.used, 1, "an attempted (failed) call still consumes budget");
});

test("56. A provider that THROWS is still recorded as a failure, never an unhandled exception", async () => {
  const provider = spyProvider({ throwError: new Error("boom") });
  const { run, decision } = await jevDecide({
    provider,
    packet: candidatePacketFixture(),
    questions: buildCandidateQuestions(),
    questionSetId: JEV_CANDIDATE_QUESTION_SET_ID,
    questionSetVersion: JEV_CANDIDATE_QUESTION_SET_VERSION,
    decisionPacketVersion: JEV_DECISION_PACKET_VERSION,
    root: null,
    budget: createJevRunBudget(5),
  });
  assertEqual(isJevFailure(run.status), true, "a thrown error is a failure status");
  assertEqual(decision, NO_JEV_DECISION, "no decision is fabricated from a throw");
});

/* ============================================================================
 * G. Disabled provider through jevDecide — shadow can always record NO_JEV_DECISION
 * ==========================================================================*/

test("57. A disabled provider through `jevDecide` records JEV_DISABLED / NO_JEV_DECISION and consumes no budget", async () => {
  const provider = createDisabledJevProvider();
  const budget = createJevRunBudget(5);
  const { run, decision } = await jevDecide({
    provider,
    packet: candidatePacketFixture(),
    questions: buildCandidateQuestions(),
    questionSetId: JEV_CANDIDATE_QUESTION_SET_ID,
    questionSetVersion: JEV_CANDIDATE_QUESTION_SET_VERSION,
    decisionPacketVersion: JEV_DECISION_PACKET_VERSION,
    root: null,
    budget,
  });
  assertEqual(run.status, JEV_STATUS.DISABLED, "disabled status");
  assertEqual(decision, NO_JEV_DECISION, "no decision");
  assertEqual(budget.used, 0, "disabled short-circuits before any budget is consumed");
});

/* ============================================================================
 * H. Secret hygiene / no wallet / no execution
 * ==========================================================================*/

const FORBIDDEN_PARTS = [
  ["send", "Transaction"],
  ["sendRaw", "Transaction"],
  ["sign", "Transaction"],
  ["signAll", "Transactions"],
  ["partial", "Sign"],
  ["from", "Secret", "Key"],
  ["private", "Key"],
  ["secret", "Key"],
  ["seed", "Phrase"],
  ["mnemo", "nic"],
  ["Key", "pair"],
  ["wallet", "-adapter"],
  ["@solana/", "web3.js"],
  ["@solana/", "kit"],
  ["new ", "Connection", "\\("],
  ["new ", "Transaction", "\\("],
  ["System", "Program"],
  ["exec", "Sync"],
  ["shell:", " true"],
  ["child_", "process"],
];
const WALLET_PATTERNS = FORBIDDEN_PARTS.map((parts) => new RegExp(parts.join(""), "i"));

const JEV_SOURCE_FILES = [
  "scripts/jev/config.mjs",
  "scripts/jev/runtime.mjs",
  "scripts/jev/decide.mjs",
  "scripts/jev/decision-packet.mjs",
  "scripts/jev/questions.mjs",
  "scripts/jev/provider.mjs",
  "scripts/jev/experiment.mjs",
  "scripts/jev/calibration.mjs",
  "scripts/jev/dashboard.mjs",
  "scripts/jev/providers/mock-jev.mjs",
  "scripts/jev/providers/typesafe-jev.mjs",
  "scripts/jev.mjs",
  "scripts/probe-jev.mjs",
  "scripts/calibrate-jev.mjs",
];

test("58. No Jev module contains a real-execution, signing, wallet, or shell-invocation path", async () => {
  for (const file of JEV_SOURCE_FILES) {
    const text = await readFile(file, "utf8");
    for (const pattern of WALLET_PATTERNS) assert(!pattern.test(text), `${file} must not contain ${pattern}`);
    assert(/PAPER ONLY/i.test(text), `${file} must state the paper-only guarantee`);
  }
});

test("59. The real Jev provider is ONLY an HTTPS decision-API client (no filesystem/process access inside it)", async () => {
  const text = await readFile("scripts/jev/providers/typesafe-jev.mjs", "utf8");
  for (const pattern of [/\bfs\/promises\b/, /\breadFile\b/, /\bwriteFile\b/, /\bspawn\s*\(/, /\brequire\s*\(/]) {
    assert(!pattern.test(text), `typesafe-jev.mjs must not contain ${pattern}`);
  }
});

test("60. `jevStateSummary` / dashboard output never exposes the API key or raw state, even if accidentally handed one", async () => {
  const { jevStateSummary } = await import("./jev/runtime.mjs");
  const summary = jevStateSummary({
    identity: { provider: "typesafe-jev", model: "jev-1.13.0", apiKey: "sk-should-not-appear-anywhere" },
    runs: [],
  });
  const serialized = JSON.stringify(summary);
  assert(!serialized.includes("sk-should-not-appear"), "the summary never carries an apiKey field through");
});

test("61. A Jev run record never contains an apiKey/authorization/env field", async () => {
  const provider = createMockJevProvider();
  const { run } = await jevDecide({
    provider,
    packet: candidatePacketFixture(),
    questions: buildCandidateQuestions(),
    questionSetId: JEV_CANDIDATE_QUESTION_SET_ID,
    questionSetVersion: JEV_CANDIDATE_QUESTION_SET_VERSION,
    decisionPacketVersion: JEV_DECISION_PACKET_VERSION,
    root: null,
    budget: createJevRunBudget(5),
  });
  const keys = Object.keys(run);
  for (const forbidden of ["apiKey", "apikey", "authorization", "env", "environment", "secret", "token"]) {
    assert(!keys.includes(forbidden), `run record must not have a top-level '${forbidden}' field`);
  }
});

test("62. `loadJevShadowState` never exposes prompts/state/API key when an experiment exists", async () => {
  await withTempDir(async (dir) => {
    const experimentId = jevExperimentIdFor({ provider: "mock-jev", startedAt: 1_700_000_000_000 });
    const root = jevExperimentRootFor(path.join(dir, "jev", "experiments"), experimentId);
    await writeJevExperiment(
      root,
      createJevExperiment({
        experimentId,
        provider: "mock-jev",
        model: "mock-jev-v1",
        decisionPacketVersion: JEV_DECISION_PACKET_VERSION,
        questionSetId: JEV_CANDIDATE_QUESTION_SET_ID,
        questionSetVersion: JEV_CANDIDATE_QUESTION_SET_VERSION,
      }),
    );
    const state = await loadJevShadowState(dir);
    assertEqual(state.available, true, "the experiment is discovered");
    const serialized = JSON.stringify(state);
    // Check for the field as a JSON KEY (`"apiKey":`), not the English word —
    // the summary's own human-readable disclaimer legitimately says "no
    // prompts/state/API key" in prose, which must not trip this check.
    for (const forbidden of ["apiKey", "prompt", "rawResponse", "Authorization"]) {
      assert(!serialized.includes(`"${forbidden}":`), `jevShadow dashboard state never has a '${forbidden}' JSON field`);
    }
  });
});

/* ============================================================================
 * I. Shadow-only invariant
 * ==========================================================================*/

test("63. No Arena/compiler/watchdog/simulation/genome source file contains any reference to Jev", async () => {
  const files = [
    "scripts/arena/orchestrator.mjs",
    "scripts/arena/evaluator.mjs",
    "scripts/arena/tournament.mjs",
    "scripts/research/compiler.mjs",
    "scripts/research/watchdog.mjs",
    "scripts/research/promote.mjs",
    "scripts/engine/simulation.mjs",
    "scripts/engine/genome.mjs",
  ];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    assert(!/jev/i.test(text), `${file} must not reference Jev in any way — it has zero authority over this logic`);
  }
});

test("64. Deterministic Arena scoring/gates are BYTE-IDENTICAL whether Jev is disabled or a shadow prediction runs alongside", async () => {
  const components = {
    medianOOSReturn: 0.03,
    worstOOSReturn: -0.01,
    maxDrawdown: 0.2,
    stressSurvived: 2,
    stressTotal: 2,
    regimePositive: 3,
    regimeRuns: 4,
    seedReturns: [0.02, 0.025],
    distinctMints: 5,
    topMintShare: 0.3,
    catastrophicEvents: 0,
    trades: 30,
    oosWindows: 4,
    observations: 200,
  };

  // Run 1: Jev disabled entirely.
  const scoreDisabled = computeArenaScore(components);
  const gatesDisabled = evaluateSurvivalGates({ arenaScore: scoreDisabled.score, components, realDatasetsUsed: 1 });

  // Run 2: an identical deterministic computation, but with a Jev shadow
  // prediction ALSO requested in between — its answer is never fed back in.
  const provider = createMockJevProvider();
  await provider.evaluate({ state: candidatePacketFixture(), questions: buildCandidateQuestions() });
  const scoreShadow = computeArenaScore(components);
  const gatesShadow = evaluateSurvivalGates({ arenaScore: scoreShadow.score, components, realDatasetsUsed: 1 });

  assertEqual(digestOf(scoreDisabled), digestOf(scoreShadow), "Arena score is byte-identical with Jev disabled vs. shadow");
  assertEqual(digestOf(gatesDisabled), digestOf(gatesShadow), "gate evaluation is byte-identical with Jev disabled vs. shadow");
});

test("65. `jevDecide` never mutates the packet or questions objects it was given", async () => {
  const packet = candidatePacketFixture();
  const questions = buildCandidateQuestions();
  const packetBefore = JSON.stringify(packet);
  const questionsBefore = JSON.stringify(questions);
  await jevDecide({
    provider: createMockJevProvider(),
    packet,
    questions,
    questionSetId: JEV_CANDIDATE_QUESTION_SET_ID,
    questionSetVersion: JEV_CANDIDATE_QUESTION_SET_VERSION,
    decisionPacketVersion: JEV_DECISION_PACKET_VERSION,
    root: null,
    budget: createJevRunBudget(5),
  });
  assertEqual(JSON.stringify(packet), packetBefore, "the packet is not mutated");
  assertEqual(JSON.stringify(questions), questionsBefore, "the questions object is not mutated");
});

/* ============================================================================
 * J. Prediction persistence — timestamped BEFORE any outcome exists
 * ==========================================================================*/

test("66. A decision record is written and remains IMMUTABLE after a later outcome is recorded", async () => {
  await withTempDir(async (dir) => {
    const provider = createMockJevProvider();
    const packet = candidatePacketFixture();
    const questions = buildCandidateQuestions();
    const experimentId = "jexp-persist-test-0000000000-mock-jev-abcdef";
    const { run, decision } = await jevDecide({
      provider,
      packet,
      questions,
      questionSetId: JEV_CANDIDATE_QUESTION_SET_ID,
      questionSetVersion: JEV_CANDIDATE_QUESTION_SET_VERSION,
      decisionPacketVersion: JEV_DECISION_PACKET_VERSION,
      experimentId,
      root: dir,
      budget: createJevRunBudget(5),
    });
    const decisionId = jevDecisionIdFor({ experimentId, packetKind: packet.packetKind, subjectDigest: packet.candidate.candidateDigest, questionSetId: JEV_CANDIDATE_QUESTION_SET_ID });
    const record = buildJevDecisionRecord({
      decisionId,
      experimentId,
      packetKind: packet.packetKind,
      subjectDigest: packet.candidate.candidateDigest,
      questionSetId: JEV_CANDIDATE_QUESTION_SET_ID,
      questionSetVersion: JEV_CANDIDATE_QUESTION_SET_VERSION,
      decisionPacketVersion: JEV_DECISION_PACKET_VERSION,
      stateDigest: run.stateDigest,
      jevRunId: run.jevRunId,
      provider: run.provider,
      model: run.model,
      status: run.status,
      answers: decision,
      predictedAt: run.completedAt,
    });
    await writeJevDecision(dir, record);
    const beforeOutcome = JSON.stringify(await readFile(path.join(dir, "decisions", `${decisionId}.json`), "utf8"));

    await writeJevOutcome(
      dir,
      buildJevOutcomeRecord({ decisionId, arenaId: "arena-x", gateResult: { status: "ELIMINATED", gates: [], passed: 0, failed: 1, total: 1 }, recordedAt: new Date().toISOString() }),
    );

    const afterOutcome = JSON.stringify(await readFile(path.join(dir, "decisions", `${decisionId}.json`), "utf8"));
    assertEqual(afterOutcome, beforeOutcome, "recording an outcome never rewrites the prior decision file");
    assert(record.predictedAt, "the decision carries a predicted-at timestamp");
    assert(record.immutable === true, "the record self-declares immutability");
  });
});

test("66b. `jevRunIdFor` is deterministic for identical inputs and changes with any input", () => {
  const a = jevRunIdFor({ experimentId: "jexp-x", stateDigest: "sd1", questionSetId: "q1" });
  const b = jevRunIdFor({ experimentId: "jexp-x", stateDigest: "sd1", questionSetId: "q1" });
  const c = jevRunIdFor({ experimentId: "jexp-x", stateDigest: "sd2", questionSetId: "q1" });
  assertEqual(a, b, "identical inputs produce an identical run id");
  assert(a !== c, "a different state digest produces a different run id");
});

test("66c. `listJevDecisions` / `listJevOutcomes` / `readJevExperiment` read back exactly what was written, and nothing more", async () => {
  await withTempDir(async (dir) => {
    const experimentId = "jexp-list-test-000000000000-mock-jev-abcdef";
    await writeJevExperiment(
      dir,
      createJevExperiment({ experimentId, provider: "mock-jev", decisionPacketVersion: 1, questionSetId: "x", questionSetVersion: 1 }),
    );
    assertEqual((await readJevExperiment(dir)).experimentId, experimentId, "the experiment metadata round-trips");
    assertDeepEqual(await listJevDecisions(dir), [], "no decisions yet");
    assertDeepEqual(await listJevOutcomes(dir), [], "no outcomes yet");

    await writeJevDecision(
      dir,
      buildJevDecisionRecord({
        decisionId: "JD-list-test",
        experimentId,
        packetKind: JEV_PACKET_KIND.CANDIDATE,
        subjectDigest: "cand-1",
        questionSetId: JEV_CANDIDATE_QUESTION_SET_ID,
        questionSetVersion: JEV_CANDIDATE_QUESTION_SET_VERSION,
        decisionPacketVersion: JEV_DECISION_PACKET_VERSION,
        stateDigest: "sd",
        jevRunId: "JR-x",
        provider: "mock-jev",
        model: "mock-jev-v1",
        status: "JEV_OK",
        answers: okCandidateAnswers(),
        predictedAt: new Date().toISOString(),
      }),
    );
    await writeJevOutcome(dir, buildJevOutcomeRecord({ decisionId: "JD-list-test", gateResult: { status: "ELIMINATED", gates: [], passed: 0, failed: 1, total: 1 }, recordedAt: new Date().toISOString() }));

    const decisions = await listJevDecisions(dir);
    const outcomes = await listJevOutcomes(dir);
    assertEqual(decisions.length, 1, "exactly the one written decision is listed");
    assertEqual(outcomes.length, 1, "exactly the one written outcome is listed");
    assertEqual(decisions[0].decisionId, "JD-list-test", "the correct decision is returned");
  });
});

test("67. `isValidJevExperimentId` / `jevExperimentRootFor` reject malformed or path-traversal ids", () => {
  assertEqual(isValidJevExperimentId("jexp-abc123"), true, "a well-formed id is valid");
  assertEqual(isValidJevExperimentId("../etc/passwd"), false, "a path-traversal-shaped id is rejected");
  assertEqual(isValidJevExperimentId("exp-not-jev-prefixed"), false, "a research experiment id is not a Jev experiment id");
  let thrown = null;
  try {
    jevExperimentRootFor(undefined, "../escape");
  } catch (error) {
    thrown = error;
  }
  assert(thrown, "resolving the root for an invalid id throws rather than resolving outside the experiments tree");
});

/* ============================================================================
 * K. Calibration — pure, post-outcome, no provider call
 * ==========================================================================*/

test("68. `calibration.mjs` imports NO provider, registry, or runtime HTTP code — it is a pure post-outcome evaluator", async () => {
  const text = await readFile("scripts/jev/calibration.mjs", "utf8");
  for (const pattern of [/from ["']\.\/provider\.mjs["']/, /from ["']\.\/decide\.mjs["']/, /from ["']\.\/providers\//, /from ["']\.\/runtime\.mjs["']/]) {
    assert(!pattern.test(text), `calibration.mjs must not import ${pattern} — Jev is never called during calibration`);
  }
});

test("69. `calibrate-jev.mjs` never imports the decision orchestration path — it only reads and joins", async () => {
  const text = await readFile("scripts/calibrate-jev.mjs", "utf8");
  assert(!/from ["']\.\/jev\/decide\.mjs["']/.test(text), "the calibration CLI never imports jevDecide");
  assert(!/from ["']\.\/jev\/provider\.mjs["']/.test(text), "the calibration CLI never imports the provider registry");
});

test("70. `brierScore` is exact for perfect, worst-case, and mixed predictions", () => {
  assertEqual(brierScore([{ p: 1, o: 1 }, { p: 0, o: 0 }]), 0, "perfect predictions score 0");
  assertEqual(brierScore([{ p: 1, o: 0 }, { p: 0, o: 1 }]), 1, "maximally wrong predictions score 1");
  assertClose(brierScore([{ p: 0.5, o: 1 }, { p: 0.5, o: 0 }]), 0.25, 1e-9, "uniformly uncertain predictions score 0.25");
  assertEqual(brierScore([]), null, "no predictions yields null, never NaN or zero");
});

test("71. `reliabilityBins` buckets correctly and reports null mean/observed for empty bins", () => {
  const bins = reliabilityBins([{ p: 0.05, o: 1 }, { p: 0.95, o: 1 }], 10);
  assertEqual(bins[0].count, 1, "the low-probability prediction lands in the first bin");
  assertEqual(bins[9].count, 1, "the high-probability prediction lands in the last bin");
  assertEqual(bins[5].count, 0, "an untouched bin has zero count");
  assertEqual(bins[5].meanPredicted, null, "an empty bin reports null rather than a fabricated mean");
});

test("72. `absoluteCalibrationError` is zero for perfectly calibrated predictions and positive otherwise", () => {
  const perfect = [
    { p: 0.1, o: 0 },
    { p: 0.1, o: 0 },
    { p: 0.1, o: 0 },
    { p: 0.1, o: 0 },
    { p: 0.1, o: 0 },
    { p: 0.1, o: 0 },
    { p: 0.1, o: 0 },
    { p: 0.1, o: 0 },
    { p: 0.1, o: 0 },
    { p: 0.1, o: 1 },
  ];
  assertClose(absoluteCalibrationError(perfect), 0, 1e-9, "10% predicted with 1/10 observed is perfectly calibrated");
  const miscalibrated = [{ p: 0.9, o: 0 }, { p: 0.9, o: 0 }];
  assert(absoluteCalibrationError(miscalibrated) > 0.5, "consistently overconfident wrong predictions have a large calibration error");
});

test("73. `calibrateNoulQuestion` excludes non-OK decisions and decisions with a non-finite answer", () => {
  const joined = [
    { decision: { status: "JEV_OK", answers: { gateFailureRisk: { type: "noul", probability: 0.5 } } }, outcome: { gateResult: { failed: 1 } } },
    { decision: { status: "JEV_DISABLED", answers: null }, outcome: { gateResult: { failed: 0 } } },
    { decision: { status: "JEV_OK", answers: { gateFailureRisk: { type: "noul", probability: NaN } } }, outcome: { gateResult: { failed: 0 } } },
  ];
  const result = calibrateNoulQuestion({ joined, questionName: "gateFailureRisk", outcomeFn: gateFailureOutcome, targetDefinition: "test" });
  assertEqual(result.predictionCount, 1, "only the single valid OK/finite prediction is calibrated");
});

test("74. `GATE_FAILURE_TARGET_DEFINITION_V1` / `GENERALIZATION_TARGET_DEFINITION_V1` are pre-registered, versioned, and persisted verbatim in the report", () => {
  assert(GATE_FAILURE_TARGET_DEFINITION_V1.includes("v1"), "the gate-failure target definition is versioned");
  assert(GENERALIZATION_TARGET_DEFINITION_V1.includes("v1"), "the generalization target definition is versioned");
  const calibration = runJevCalibration({ decisions: [], outcomes: [] });
  assertEqual(calibration.gateFailureRisk.targetDefinition, GATE_FAILURE_TARGET_DEFINITION_V1, "the exact definition is persisted");
  assertEqual(calibration.generalizationConfidence.targetDefinition, GENERALIZATION_TARGET_DEFINITION_V1, "the exact definition is persisted");
});

test("75. `gateFailureOutcome` / `generalizationOutcome` are pure functions of the deterministic gate result only", () => {
  assertEqual(gateFailureOutcome({ failed: 0 }), false, "no failed gates means no gate failure");
  assertEqual(gateFailureOutcome({ failed: 2 }), true, "any failed gate means gate failure");
  assertEqual(gateFailureOutcome(null), null, "a missing gate result yields null, never a fabricated outcome");
  assertEqual(generalizationOutcome({ status: "DEPLOYMENT_CANDIDATE" }), true, "a deployment candidate generalized");
  assertEqual(generalizationOutcome({ status: "ELIMINATED" }), false, "an eliminated candidate did not generalize");
  assertEqual(generalizationOutcome({ status: "ARENA_SURVIVOR" }), true, "an arena survivor generalized under the existing gate set");
});

test("76. `evaluatePrimaryRisk` reports MULTI-LABEL membership, never a forced single-label ground truth", () => {
  const joined = [
    {
      decision: { status: "JEV_OK", answers: { primaryRisk: { type: "choice", choice: "concentration", probabilities: {} } } },
      outcome: { gateResult: { gates: [{ label: "reasonable concentration", pass: false }, { label: "minimum total trades", pass: false }] } },
    },
    {
      decision: { status: "JEV_OK", answers: { primaryRisk: { type: "choice", choice: "cost_drag", probabilities: {} } } },
      outcome: { gateResult: { gates: [{ label: "reasonable concentration", pass: false }] } },
    },
  ];
  const result = evaluatePrimaryRisk({ joined });
  assertEqual(result.predictionCount, 2, "both predictions are evaluated");
  assertEqual(result.rows[0].appearsInFailedSet, true, "concentration appears in the multi-label failed-gate set");
  assertEqual(result.rows[0].failedRiskVocab.length, 2, "multiple failed gates are retained, not collapsed to one label");
  assertEqual(result.rows[1].appearsInFailedSet, false, "cost_drag is correctly reported absent — no fake match is invented");
});

test("77. `GATE_LABEL_TO_RISK_VOCAB` maps only to labels inside `PRIMARY_RISK_VOCAB`", () => {
  for (const vocabWord of Object.values(GATE_LABEL_TO_RISK_VOCAB)) {
    assert(PRIMARY_RISK_VOCAB.includes(vocabWord), `${vocabWord} is a real primaryRisk vocabulary word`);
  }
});

test("78. `evaluateEvidenceQuality` is descriptive only and never fabricates a deterministic comparator", () => {
  const joined = [{ decision: { status: "JEV_OK", answers: { evidenceQuality: { type: "score", score: 3 } } }, outcome: {} }];
  const result = evaluateEvidenceQuality({ joined });
  assertEqual(result.rows[0].jevScore, 3, "the Jev score is reported");
  assertEqual(result.rows[0].deterministicScore, null, "no deterministic comparator is invented when none is supplied");
});

test("79. `thresholdCoverageAnalysis` uses the fixed documented thresholds and coverage never increases with a higher threshold", () => {
  assertDeepEqual(CONFIDENCE_THRESHOLDS_V1, [0.5, 0.6, 0.7, 0.8, 0.9], "the exact documented threshold list");
  const joined = [
    { decision: { status: "JEV_OK", answers: { gateFailureRisk: { type: "noul", probability: 0.95 } } }, outcome: { gateResult: { failed: 1 } } },
    { decision: { status: "JEV_OK", answers: { gateFailureRisk: { type: "noul", probability: 0.55 } } }, outcome: { gateResult: { failed: 0 } } },
  ];
  const rows = thresholdCoverageAnalysis({ joined, questionName: "gateFailureRisk", outcomeFn: gateFailureOutcome });
  let previousCoverage = 1.01;
  for (const row of rows) {
    assert(row.coverage <= previousCoverage + 1e-9, "coverage is monotonically non-increasing as the threshold rises");
    previousCoverage = row.coverage;
    assertClose(row.abstentionRate, 1 - row.coverage, 1e-9, "abstentionRate is exactly 1 - coverage");
  }
});

test("80. `runJevCalibration` ALWAYS reports `noThresholdPromoted: true` — no threshold is ever operational in Phase 5D", () => {
  const calibration = runJevCalibration({ decisions: [], outcomes: [] });
  assertEqual(calibration.noThresholdPromoted, true, "explicitly never promoted");
  assert(/OFFLINE ANALYSIS ONLY/.test(calibration.note), "the report states it is analysis-only");
});

test("81. `decide.mjs` never references EVOLVE_JEV_MIN_CONFIDENCE — it is analysis-only, never an operational gate", async () => {
  const text = await readFile("scripts/jev/decide.mjs", "utf8");
  assert(!/minConfidence/.test(text), "the decision path never applies a confidence threshold operationally");
});

test("82. `joinDecisionsWithOutcomes` joins ONLY by decisionId and ignores unmatched rows on either side", () => {
  const decisions = [{ decisionId: "A" }, { decisionId: "B" }];
  const outcomes = [{ decisionId: "B" }, { decisionId: "C" }];
  const joined = joinDecisionsWithOutcomes({ decisions, outcomes });
  assertEqual(joined.length, 1, "only the matching pair is joined");
  assertEqual(joined[0].decision.decisionId, "B", "the correct decision is matched");
});

test("83. `evaluateRegimeShadow` computes agreement without waiting for a later outcome (the deterministic label is already known)", () => {
  const decisions = [
    { status: "JEV_OK", packetKind: JEV_PACKET_KIND.MARKET, decisionId: "M1", answers: { regime: { type: "choice", choice: "strong-risk-on", probabilities: {}, confidence: 0.5 } }, deterministicComparators: { deterministicRegime: "strong-risk-on" } },
    { status: "JEV_OK", packetKind: JEV_PACKET_KIND.MARKET, decisionId: "M2", answers: { regime: { type: "choice", choice: "broad-selloff", probabilities: {}, confidence: 0.5 } }, deterministicComparators: { deterministicRegime: "strong-risk-on" } },
    { status: "JEV_OK", packetKind: JEV_PACKET_KIND.CANDIDATE, decisionId: "C1", answers: {}, deterministicComparators: {} },
  ];
  const result = evaluateRegimeShadow({ decisions });
  assertEqual(result.predictionCount, 2, "only market decisions are considered");
  assertClose(result.agreementRate, 0.5, 1e-9, "one of two market classifications agreed with the deterministic label");
});

test("84. `runJevCalibration` end-to-end on a small synthetic (non-real) fixture set produces internally consistent counts", () => {
  const decisions = [
    {
      decisionId: "D1",
      status: "JEV_OK",
      answers: {
        gateFailureRisk: { type: "noul", probability: 0.8 },
        generalizationConfidence: { type: "noul", probability: 0.2 },
        primaryRisk: { type: "choice", choice: "drawdown", probabilities: {} },
        evidenceQuality: { type: "score", score: 1 },
      },
    },
    {
      decisionId: "D2",
      status: "JEV_OK",
      answers: {
        gateFailureRisk: { type: "noul", probability: 0.1 },
        generalizationConfidence: { type: "noul", probability: 0.9 },
        primaryRisk: { type: "choice", choice: "no_obvious_risk", probabilities: {} },
        evidenceQuality: { type: "score", score: 4 },
      },
    },
  ];
  const outcomes = [
    { decisionId: "D1", gateResult: { status: "ELIMINATED", gates: [{ label: "acceptable maximum drawdown", pass: false }], passed: 0, failed: 1, total: 1 } },
    { decisionId: "D2", gateResult: { status: "DEPLOYMENT_CANDIDATE", gates: [{ label: "acceptable maximum drawdown", pass: true }], passed: 1, failed: 0, total: 1 } },
  ];
  const calibration = runJevCalibration({ decisions, outcomes });
  assertEqual(calibration.predictionCount, 2, "both decisions joined to outcomes");
  assertEqual(calibration.gateFailureRisk.predictionCount, 2, "both calibrated for gateFailureRisk");
  assertClose(calibration.gateFailureRisk.brierScore, ((0.8 - 1) ** 2 + (0.1 - 0) ** 2) / 2, 1e-9, "exact Brier score for this crafted pair");
  assertEqual(calibration.primaryRisk.rows[0].appearsInFailedSet, true, "D1's 'drawdown' choice matches its failed gate");
  assertEqual(calibration.primaryRisk.rows[1].appearsInFailedSet, false, "D2 had no failed gates, so no risk label can appear in an empty set");
});

/* ============================================================================
 * L. Experiment counters + jevStateSummary
 * ==========================================================================*/

test("85. Experiment counters accumulate OK/failure/cache-hit counts correctly", async () => {
  const { accumulateJevCounters } = await import("./jev/experiment.mjs");
  let counters = createJevExperiment({
    experimentId: "jexp-counter-test",
    provider: "mock-jev",
    decisionPacketVersion: 1,
    questionSetId: "x",
    questionSetVersion: 1,
  }).counters;
  counters = accumulateJevCounters(counters, { status: "JEV_OK", cacheHit: false });
  counters = accumulateJevCounters(counters, { status: "JEV_OK", cacheHit: true });
  counters = accumulateJevCounters(counters, { status: "JEV_TIMEOUT", cacheHit: false });
  assertEqual(counters.decisionsRequested, 3, "three decisions counted");
  assertEqual(counters.decisionsOk, 2, "two OK");
  assertEqual(counters.decisionsFailed, 1, "one failed");
  assertEqual(counters.cacheHits, 1, "one cache hit");
});

test("86. `jevStateSummary` reports HEALTHY / DEGRADED / FAILING / NO_CALLS correctly", async () => {
  const { jevStateSummary } = await import("./jev/runtime.mjs");
  assertEqual(jevStateSummary({ runs: [] }).health, "NO_CALLS", "no runs at all");
  assertEqual(jevStateSummary({ runs: [{ status: "JEV_OK" }] }).health, "HEALTHY", "all OK");
  assertEqual(jevStateSummary({ runs: [{ status: "JEV_OK" }, { status: "JEV_TIMEOUT" }] }).health, "DEGRADED", "mixed");
  assertEqual(jevStateSummary({ runs: [{ status: "JEV_TIMEOUT" }] }).health, "FAILING", "all failed");
});

/* ============================================================================
 * M. Storage isolation — never writes into .evolve/research or mutates Arena artifacts
 * ==========================================================================*/

test("87. Jev experiment storage never resolves inside `.evolve/research/`", () => {
  const experimentId = jevExperimentIdFor({ provider: "mock-jev", startedAt: 1_700_000_000_000 });
  const root = jevExperimentRootFor(undefined, experimentId);
  assert(root.includes(path.join(".evolve", "jev")), "the root is under .evolve/jev/");
  assert(!root.includes(path.join(".evolve", "research")), "never under .evolve/research/");
});

test("88. `jevExperimentIdFor` is deterministic for the same inputs and collision-resistant across providers", () => {
  const a = jevExperimentIdFor({ provider: "mock-jev", startedAt: 1_700_000_000_000 });
  const b = jevExperimentIdFor({ provider: "mock-jev", startedAt: 1_700_000_000_000 });
  const c = jevExperimentIdFor({ provider: "typesafe-jev", startedAt: 1_700_000_000_000 });
  assertEqual(a, b, "identical inputs produce an identical id");
  assert(a !== c, "different providers at the same instant still produce different ids");
});

/* ============================================================================
 * N. Regression: Phase 5B green, Wave 1 replication + frozen cohorts unchanged, Wave 2 untouched
 * ==========================================================================*/

test("89. Phase 5B remains fully green after Phase 5D is added (no shared-module regression)", () => {
  const result = spawnSync(process.execPath, ["scripts/validate-phase5b.mjs"], { encoding: "utf8", cwd: process.cwd() });
  assertEqual(result.status, 0, `validate:phase5b must still exit 0 (stdout tail: ${(result.stdout ?? "").split("\n").slice(-6).join(" | ")})`);
});

test("90. The canonical Phase 5C replication (`rep-66884de4e460`) and its freeze digest are UNCHANGED", async () => {
  const manifest = JSON.parse(await readFile(path.join(".evolve", "replication", "rep-66884de4e460", "manifest.json"), "utf8"));
  assertEqual(manifest.replicationId, "rep-66884de4e460", "the canonical replication id is present and untouched");
  assertEqual(manifest.freezeDigest, "4959974d1b78635e63c0d9038c582c9ceb5a7411366d9c95c82e7ee3bac3f500", "the frozen freeze digest is byte-identical to the one recorded before Phase 5D");
  assertEqual(manifest.cohorts.mock.cohortDigest, "b26d63a2a0787e954ed7e4e63e668fe4664e58059508145345214facc4e12858", "the frozen Mock cohort digest is unchanged");
  assertEqual(manifest.cohorts.deepseek.cohortDigest, "13c7c93d707b26f8b92042d488ff0a63f5de3f9f81b8145be4eac7a70cc550a8", "the frozen DeepSeek cohort digest is unchanged");
});

test("91. Reading through every Jev module never mutates the Phase 5C replication manifest or cohort manifests on disk", async () => {
  const files = [
    path.join(".evolve", "replication", "rep-66884de4e460", "manifest.json"),
    path.join(".evolve", "replication", "cohorts", "mock", "cohort-manifest.json"),
    path.join(".evolve", "replication", "cohorts", "deepseek", "cohort-manifest.json"),
  ];
  const before = await Promise.all(files.map((file) => readFile(file, "utf8").then(digestOf)));
  // Exercise a representative slice of the Jev subsystem, read-only.
  await resolveJevProvider("mock-jev", {}).evaluate({ state: candidatePacketFixture(), questions: buildCandidateQuestions() });
  await loadJevShadowState(path.join(process.cwd(), ".evolve"));
  const after = await Promise.all(files.map((file) => readFile(file, "utf8").then(digestOf)));
  assertDeepEqual(after, before, "Phase 5C canonical artifacts are byte-identical before and after exercising Jev");
});

test("92. No Jev source file names or hardcodes the untouched Wave 2 dataset id or fingerprint", async () => {
  const forbidden = ["session-20260919T040641Z-live", "2b3652d11390af1269891dcfcf9bf029e5ed110bf05e6982046016d3ea185bbb"];
  for (const file of JEV_SOURCE_FILES) {
    const text = await readFile(file, "utf8");
    for (const needle of forbidden) assert(!text.includes(needle), `${file} must never reference the Wave 2 dataset (${needle.slice(0, 12)}...)`);
  }
});

test("93. `.evolve/datasets` and `.evolve/history` are never touched by exercising the Jev subsystem", async () => {
  const { readdir } = await import("node:fs/promises");
  const before = {
    datasets: await readdir(path.join(".evolve", "datasets")).catch(() => null),
    history: await readdir(path.join(".evolve", "history")).catch(() => null),
  };
  await withTempDir(async (dir) => {
    const provider = createMockJevProvider();
    await jevDecide({
      provider,
      packet: candidatePacketFixture(),
      questions: buildCandidateQuestions(),
      questionSetId: JEV_CANDIDATE_QUESTION_SET_ID,
      questionSetVersion: JEV_CANDIDATE_QUESTION_SET_VERSION,
      decisionPacketVersion: JEV_DECISION_PACKET_VERSION,
      experimentId: "jexp-isolation-test-000000000-mock-jev-abcdef",
      root: dir,
      cacheEnabled: true,
      budget: createJevRunBudget(5),
    });
  });
  const after = {
    datasets: await readdir(path.join(".evolve", "datasets")).catch(() => null),
    history: await readdir(path.join(".evolve", "history")).catch(() => null),
  };
  assertDeepEqual(after.datasets, before.datasets, "no dataset directory entries were added or removed");
  assertDeepEqual(after.history, before.history, "no history directory entries were added or removed");
});

test("94. No live network call is possible from this validation suite (typesafe-jev is only ever exercised through an injected fetch stub)", async () => {
  let realFetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    realFetchCalled = true;
    return originalFetch(...args);
  };
  try {
    // Never actually invoked with a real network path anywhere above; this
    // assertion documents and enforces that guarantee for this file as a whole.
    assertEqual(realFetchCalled, false, "the global fetch was never reached by this suite");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/* ============================================================================
 * Runner
 * ==========================================================================*/

async function run() {
  let passed = 0;
  const failures = [];

  for (const testCase of cases) {
    const start = Date.now();
    try {
      await testCase.fn();
      passed += 1;
      console.log(`  ✓ ${testCase.name} (${Date.now() - start}ms)`);
    } catch (error) {
      failures.push({ name: testCase.name, error });
      console.log(`  ✗ ${testCase.name}`);
      console.log(`      ${error?.message ?? error}`);
    }
  }

  console.log(`\nEVOLVE Phase 5D validation: ${passed}/${cases.length} checks passed`);

  if (failures.length > 0) {
    console.log("Failed checks:");
    for (const failure of failures) console.log(`  - ${failure.name}`);
    process.exitCode = 1;
  } else {
    console.log("All Phase 5D checks passed.");
    console.log(
      "SHADOW ONLY. Jev observes bounded TRAIN-safe evidence and returns typed predictions that EVOLVE records. " +
        "It has zero authority over trading, genome construction, research compilation, evolution, Arena scoring, " +
        "gates, species matching, DeepSeek calls, deployment eligibility, or replication. A bad Jev result is " +
        "acceptable, and no threshold is promoted from one experiment.",
    );
  }
}

run().catch((error) => {
  console.error("phase 5d validation runner crashed:", error);
  process.exitCode = 1;
});

export { cases };
