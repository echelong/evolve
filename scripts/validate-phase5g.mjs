#!/usr/bin/env node
/**
 * EVOLVE Phase 5G.0 validation suite — classifier.dev FROZEN external-intelligence
 * classification.
 *
 * Proves the whole chain
 *
 *   frozen capture → integrity check → deterministic bounded text projection
 *     → classifier.dev FAST tier (ONE request) → frozen classification artifact → STOP
 *
 * and everything around it: the pinned endpoint/tier/taxonomy/instructions, the
 * exact fields that may cross the external boundary (title + textExcerpt only),
 * the redaction/URL/bound behaviour, the whitelisted response validation, the
 * bounded transport recovery, the absence of ANY credential, the storage outside
 * the immutable capture, offline replay, the absence of any downstream routing,
 * and the byte-identity of every frozen artifact (real V2 capture, legacy V1
 * capture, Wave 1, Wave 2, cohorts, the six datasets, the evaluation contract).
 *
 * Fully OFFLINE and deterministic: `fetch` is a scripted stub, every delay and
 * random draw is injected, no real classifier.dev request is ever made, no
 * capture is taken, no Agent-Reach / Jev / DeepSeek call is made, no Arena is
 * run, and nothing under the repository's `.evolve/` is written.
 *
 * Run with: npm run validate:phase5g
 */

import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { canonicalJson, digestOf, sha256Hex } from "./lib/hash.mjs";

import { readCaptureManifest, runCapture, verifyCapture, listCaptures } from "./intelligence/capture.mjs";
import { resolveIntelligenceConfig } from "./intelligence/config.mjs";
import { DEFAULT_FEATURE_VERSION, INTELLIGENCE_FEATURE_VERSION, INTELLIGENCE_FEATURE_VERSION_V2, REGISTERED_FEATURE_VERSIONS } from "./intelligence/features.mjs";
import {
  ALLOWED_PACKET_KEYS,
  DEEPSEEK_ROUTING_ACTIVE,
  JEV_ROUTING_ACTIVE,
  auditExternalIntelligencePacket,
  buildExternalIntelligencePacket,
} from "./intelligence/packet.mjs";
import { replayCapture } from "./intelligence/replay.mjs";

import {
  CLASSIFIER_DEFINITION_DIGEST,
  CLASSIFIER_EXCLUDED_FIELDS,
  CLASSIFIER_ID,
  CLASSIFIER_INPUT_FIELDS,
  CLASSIFIER_INPUT_MAX_CHARS,
  CLASSIFIER_INSTRUCTIONS,
  CLASSIFIER_INSTRUCTIONS_DIGEST,
  CLASSIFIER_LABELS,
  CLASSIFIER_VERSION,
  INPUT_PROJECTION_VERSION,
  UnknownClassifierError,
  classifierDefinitionFor,
  projectClassifierInput,
  projectClassifierInputs,
} from "./intelligence/classifier-definition.mjs";
import {
  CLASSIFIER_ATTEMPT_FIELDS,
  CLASSIFIER_DEV_API_VERSION,
  CLASSIFIER_DEV_ENDPOINT,
  CLASSIFIER_DEV_PROVIDER,
  CLASSIFIER_DEV_TIER,
  CLASSIFIER_MAX_INPUTS_PER_REQUEST,
  CLASSIFIER_RETRY_AFTER_MAX_MS,
  CLASSIFIER_STATUS,
  ClassifierRequestError,
  assertClassifierEndpoint,
  assertClassifyRequestBody,
  backoffDelayMs,
  buildClassifyRequestBody,
  createClassifierDevProvider,
  parseRateLimitMetadata,
  parseRetryAfterMs,
  resolveClassifierSettings,
  retryDelayMs,
  validateClassifyResponse,
} from "./intelligence/classifier-dev.mjs";
import {
  CLASSIFICATION_RECORD_FIELDS,
  ClassifierCaptureRefusedError,
  ClassifierTooManyRecordsError,
  assertOutsideCaptureRoot,
  classifierExperimentStats,
  prepareClassification,
  replayClassifierExperiment,
  resultDigestOf,
  runClassification,
} from "./intelligence/classifier-experiment.mjs";

import { JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_ID } from "./jev-external-bridge.mjs";
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

/** Pinned values of the frozen classifier definition. */
const PINNED_LABELS = [
  "technical_activity",
  "project_announcement",
  "exchange_or_listing",
  "liquidity_or_market_structure",
  "security_or_risk",
  "governance_or_admin",
  "community_attention",
  "promotion_or_marketing",
  "unrelated_or_noise",
];
const PINNED_INSTRUCTIONS =
  "Classify the primary research-relevant type of this public external observation. " +
  "Describe what kind of observation it is, not whether an asset should be bought or sold. " +
  "Do not infer price direction, profitability, legitimacy, coordinated manipulation, identity, or intent. " +
  "Choose unrelated_or_noise when none of the other categories clearly applies.";
const PINNED_INSTRUCTIONS_DIGEST = "79be0792a51f421060c6b518471cebc30f1720891ce974165cf776c938fdf048";
const PINNED_PACKET_KEYS = [
  "packetVersion",
  "kind",
  "phase",
  "paperOnly",
  "readOnly",
  "shadowOnly",
  "captureId",
  "captureManifestDigest",
  "provider",
  "syntheticIntelligence",
  "capturedAt",
  "channels",
  "querySetId",
  "counts",
  "health",
  "features",
  "featureVersion",
  "evidenceQuality",
  "routing",
  "packetDigest",
  "note",
];

// Sentinels: unique strings that must (or must not) show up in specific places.
const GATEWAY_KEY_SENTINEL = "gateway-vercel-key-1111111111";
const DIRECT_KEY_SENTINEL = "direct-typesafe-key-0000000000";

/** Identifiers that would betray a real dependency on the classifier (bare "classifier" also appears in unrelated comments). */
const CLASSIFIER_REFERENCE = /classifier-dev|classifier\.dev|reach-signal-type|intelligence-classify|classifier-definition|classifier-experiment|classifierId/i;

/** Detection vocabulary only (a declaration, like the other suites' forbidden lists): none of these may appear in classifier code. */
const FORBIDDEN_TRANSACTION_API = [
  /\bsendTransaction\b/,
  /\bsignTransaction\b/,
  /\bKeypair\b/,
  /\bnew Connection\b/,
  /\bgetLatestBlockhash\b/,
  /\bsimulateTransaction\b/,
];

const CLASSIFIER_SOURCE_FILES = [
  "scripts/intelligence/classifier-definition.mjs",
  "scripts/intelligence/classifier-dev.mjs",
  "scripts/intelligence/classifier-experiment.mjs",
  "scripts/intelligence-classify.mjs",
];

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
async function assertThrows(fn, matcher, message) {
  let thrown = null;
  try {
    await fn();
  } catch (error) {
    thrown = error;
  }
  if (!thrown) fail(`${message} (nothing was thrown)`);
  if (typeof matcher === "function" && !(thrown instanceof matcher)) fail(`${message} (wrong error: ${thrown?.name}: ${thrown?.message})`);
  if (matcher instanceof RegExp && !matcher.test(String(thrown?.message))) fail(`${message} (wrong message: ${thrown?.message})`);
  return thrown;
}
function skip(reason) {
  skips.push(reason);
}
async function exists(target) {
  return stat(target).then(() => true).catch(() => false);
}

/* ============================================================================
 * Fixture plumbing
 * ==========================================================================*/

const ctx = {
  tmp: null,
  captureRoot: null,
  outRoot: null,
  capture: null,
  captureRecords: [],
  saved: null,
  savedCalls: null,
  realCaptureAvailable: false,
  evidenceAvailable: false,
  evidenceBaseline: {},
  sleeps: [],
  sources: new Map(),
};

async function recordSleep(ms) {
  ctx.sleeps.push(ms);
}
function fixedRandom() {
  return 0.5;
}
function resetSleeps() {
  ctx.sleeps.length = 0;
}

/** A recorded, scripted `fetch`. Entries: a Response-descriptor, a thrown error, or a function. */
function scriptedFetch(script) {
  const calls = [];
  const queue = [...script];
  let last = null;
  async function fetchImpl(url, init) {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (queue.length > 0) last = queue.shift();
    const entry = typeof last === "function" ? last(calls[calls.length - 1]) : last;
    if (entry?.throws) throw entry.throws;
    return new Response(entry.body === undefined ? null : typeof entry.body === "string" ? entry.body : JSON.stringify(entry.body), {
      status: entry.status ?? 200,
      headers: entry.headers ?? {},
    });
  }
  fetchImpl.calls = calls;
  return fetchImpl;
}

/** Deterministic classifier stub: the label depends on the INPUT TEXT, so order mistakes are detectable. */
function labelForInput(input) {
  const hash = Number.parseInt(digestOf(input).slice(0, 6), 16);
  return { label: PINNED_LABELS[hash % PINNED_LABELS.length], confidence: 0.5 + (hash % 40) / 100 };
}

function validPayload(body, overrides = {}) {
  const results = body.inputs.map((input) => {
    const { label, confidence } = labelForInput(input);
    const scores = { [label]: confidence };
    if (label !== "unrelated_or_noise") scores.unrelated_or_noise = Math.round((1 - confidence) * 100) / 100;
    return { label, confidence, scores, ms: 3, model: "fast-model-1" };
  });
  return {
    tier: "fast",
    model: "fast-model-1",
    results,
    modelsUsed: ["fast-model-1"],
    usage: { classifications: body.inputs.length, escalated: 0, ms: 12 },
    ...overrides,
  };
}

const okEntry = (extra = {}) => (call) => ({
  status: 200,
  headers: { "ratelimit-limit": "3000", "ratelimit-remaining": "2999", "ratelimit-policy": "3000;w=60" },
  body: validPayload(call.body, extra),
});
const httpEntry = (status, headers = {}, body = { error: "stub", code: "stub" }) => ({ status, headers, body });

function makeProvider(fetchImpl, { settings = {}, random = fixedRandom, now = () => NOW } = {}) {
  return createClassifierDevProvider({
    fetchImpl,
    sleepImpl: recordSleep,
    randomImpl: random,
    now,
    settings: { maxAttempts: 3, backoffBaseMs: 1_000, backoffMaxMs: 30_000, timeoutMs: 5_000, ...settings },
  });
}

/** Provider inputs for direct calls (need not come from a capture). */
const INPUTS = ["Merged a pull request that fixes the RPC client", "Listing announced on an exchange", "buy now moon lambo"];

async function runFixtureClassification({ captureRoot = ctx.captureRoot, captureId = ctx.capture.captureId, outRoot, fetchImpl, save = false, settings } = {}) {
  const provider = makeProvider(fetchImpl, { settings });
  return runClassification({ captureRoot, outRoot: outRoot ?? ctx.outRoot, captureId, provider, save, now: () => NOW });
}

async function readTree(root) {
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
      else out[path.relative(root, full)] = await readFile(full);
    }
  };
  await walk(root);
  return out;
}

async function contentHashes(root) {
  const tree = await readTree(root);
  return Object.fromEntries(Object.entries(tree).map(([file, bytes]) => [file, sha256Hex(bytes)]));
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

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
function importSpecifiers(source) {
  const out = [];
  const pattern = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;
  for (const match of stripComments(source).matchAll(pattern)) out.push(match[1]);
  return out;
}

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [path.join(REPO, "scripts", "intelligence-classify.mjs"), ...args], {
    encoding: "utf8",
    cwd: REPO,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
  });
}

/** The fixture capture holds four record shapes, cycling: rich, text-only, title-only, EMPTY. */
function fixtureRaw(index) {
  const kind = index % 4;
  const base = {
    id: `fixture-record-${index}`,
    url: `https://sentinel.example/u/URL-SENT-${index}`,
    publishedAt: "2026-09-19T12:00:00.000Z",
    author: `AUTHOR-SENT-${index}`,
    engagement: 4_242 + index,
  };
  if (kind === 0) {
    return {
      ...base,
      title: `Repo update TITLE-SENT-${index}`,
      text: `Merged a PR, see https://github.com/x/y/pull/${index} and note api_key=SUPERSECRET${index}${index}${index} then www.docs.example/guide.  extra   spaces\n\nnext line EXCERPT-SENT-${index}`,
    };
  }
  if (kind === 1) return { ...base, text: `Exchange listing announced EXCERPT-SENT-${index}` };
  if (kind === 2) return { ...base, title: `Governance vote scheduled TITLE-SENT-${index}` };
  return { ...base };
}

async function buildFixtures() {
  ctx.tmp = await mkdtemp(path.join(tmpdir(), "evolve-phase5g-"));
  ctx.captureRoot = path.join(ctx.tmp, "captures");
  ctx.outRoot = path.join(ctx.tmp, "classifier");
  await mkdir(ctx.captureRoot, { recursive: true });

  let calls = 0;
  ctx.capture = await runCapture({
    root: ctx.captureRoot,
    config: resolveIntelligenceConfig({ EVOLVE_INTELLIGENCE_PROVIDER: "mock" }),
    candidates: [{ symbol: "PHASE5GFIXTURE", name: "Phase 5G Fixture", mint: "F51Mint1111111111111111111111111111111111" }],
    provider: "mock",
    now: NOW,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    executor: async () => {
      const raw = fixtureRaw(calls);
      calls += 1;
      return { ok: true, records: [raw], backendVersion: "fixture", syntheticIntelligence: true };
    },
  });
  ctx.captureRecords = ctx.capture.records;

  // ONE saved experiment, reused by the replay/storage cases.
  ctx.savedCalls = scriptedFetch([okEntry()]);
  ctx.saved = await runFixtureClassification({ fetchImpl: ctx.savedCalls, save: true });

  ctx.realCaptureAvailable = await exists(path.join(REAL_CAPTURE_ROOT, "2026-09-19", REAL_V2_CAPTURE_ID));
  ctx.evidenceAvailable = (await exists(path.join(REPO, ".evolve", "replication"))) && (await exists(path.join(REPO, ".evolve", "history")));
  ctx.evidenceBaseline = {
    waves: await metadataSnapshot(path.join(REPO, ".evolve", "replication", "waves")),
    cohorts: await metadataSnapshot(path.join(REPO, ".evolve", "replication", "cohorts")),
    history: await metadataSnapshot(path.join(REPO, ".evolve", "history")),
    intelligence: await metadataSnapshot(REAL_CAPTURE_ROOT),
    jev: await metadataSnapshot(path.join(REPO, ".evolve", "jev")),
    jevHealth: await metadataSnapshot(path.join(REPO, ".evolve", "jev", "provider-health")),
    classifier: await metadataSnapshot(path.join(REPO, ".evolve", "classifier")),
  };

  for (const file of [
    ...CLASSIFIER_SOURCE_FILES,
    "scripts/intelligence/packet.mjs",
    "scripts/intelligence/features.mjs",
    "scripts/intelligence/capture.mjs",
    "scripts/jev-external-bridge.mjs",
    "scripts/jev-external.mjs",
    "scripts/jev.mjs",
    "scripts/jev/decide.mjs",
    "scripts/jev/provider.mjs",
    "scripts/jev/questions.mjs",
    "scripts/jev/runtime.mjs",
    "scripts/jev/experiment.mjs",
    "scripts/jev/transport.mjs",
    "scripts/jev/provider-health.mjs",
    "scripts/jev/providers/vercel-jev.mjs",
    "scripts/jev/providers/typesafe-jev.mjs",
    "scripts/arena.mjs",
    "scripts/research.mjs",
    "scripts/evolve-engine.mjs",
  ]) {
    ctx.sources.set(file, await readFile(file, "utf8").catch(() => ""));
  }
}

async function disposeFixtures() {
  if (ctx.tmp) await rm(ctx.tmp, { recursive: true, force: true });
}

const eligibleRecords = () => ctx.captureRecords.filter((record) => projectClassifierInput(record).ok);

/* ============================================================================
 * PART 1 — endpoint, tier, taxonomy, instructions (1-11)
 * ==========================================================================*/

test("1. the provider endpoint is exactly the versioned /v1/classify route", async () => {
  assertEqual(CLASSIFIER_DEV_ENDPOINT, "https://classifier.dev/v1/classify", "the pinned endpoint");
  assertEqual(new URL(CLASSIFIER_DEV_ENDPOINT).pathname, "/v1/classify", "the pinned pathname");
  assertEqual(assertClassifierEndpoint(CLASSIFIER_DEV_ENDPOINT), CLASSIFIER_DEV_ENDPOINT, "the pinned endpoint validates");
  for (const bad of ["https://classifier.dev/", "https://classifier.dev", "https://classifier.dev/classify", "https://classifier.dev/v2/classify", "http://classifier.dev/v1/classify", "https://evil.example/v1/classify", "https://classifier.dev/v1/classify?x=1"]) {
    await assertThrows(() => assertClassifierEndpoint(bad), ClassifierRequestError, `endpoint '${bad}' is refused`);
  }
  const fetchImpl = scriptedFetch([okEntry()]);
  await makeProvider(fetchImpl).classify({ inputs: INPUTS });
  assertEqual(fetchImpl.calls.length, 1, "one request");
  assertEqual(fetchImpl.calls[0].url, "https://classifier.dev/v1/classify", "the request URL is exactly /v1/classify");
  assertEqual(fetchImpl.calls[0].init.method, "POST", "the method is POST");
  assertEqual(fetchImpl.calls[0].init.redirect, "manual", "redirects are never followed");
});

test("2. the API major is pinned to v1", async () => {
  assertEqual(CLASSIFIER_DEV_API_VERSION, "v1", "the API version constant");
  assertTrue(CLASSIFIER_DEV_ENDPOINT.includes("/v1/"), "the endpoint carries the major version");
  assertEqual(makeProvider(scriptedFetch([])).apiVersion, "v1", "the provider reports v1");
  assertEqual(ctx.saved.experiment.endpointVersion, "v1", "the stored experiment records v1");
});

test("3. the FAST tier is the only tier", async () => {
  assertEqual(CLASSIFIER_DEV_TIER, "fast", "the pinned tier");
  const body = buildClassifyRequestBody({ inputs: INPUTS });
  assertEqual(body.tier, "fast", "the request body tier");
  assertEqual(ctx.savedCalls.calls[0].body.tier, "fast", "the tier that actually crossed the boundary");
  assertEqual(ctx.saved.experiment.requestedTier, "fast", "the stored requested tier");
  assertEqual(ctx.saved.experiment.returnedTier, "fast", "the stored returned tier");
});

test("4. the smart tier is rejected everywhere", async () => {
  await assertThrows(() => buildClassifyRequestBody({ inputs: INPUTS, tier: "smart" }), ClassifierRequestError, "a smart request body cannot be built");
  await assertThrows(() => assertClassifyRequestBody({ ...buildClassifyRequestBody({ inputs: INPUTS }), tier: "smart" }), ClassifierRequestError, "a smart body is refused");
  await assertThrows(() => assertClassifyRequestBody({ ...buildClassifyRequestBody({ inputs: INPUTS }), tier: "SMART" }), ClassifierRequestError, "case variants are refused");
  await assertThrows(() => createClassifierDevProvider({ tier: "smart" }), ClassifierRequestError, "a smart provider cannot be created");
  await assertThrows(() => validateClassifyResponse({ ...validPayload({ inputs: INPUTS }), tier: "smart" }, { inputCount: 3 }), /tier/, "a smart RESPONSE is refused");
  await assertThrows(
    () => validateClassifyResponse({ ...validPayload({ inputs: INPUTS }), usage: { classifications: 3, escalated: 1, ms: 1 } }, { inputCount: 3 }),
    /escalation/,
    "a smart-tier escalation is refused",
  );
  const run = runCli(["--capture", "capture-20260919T130756Z", "--classifier", CLASSIFIER_ID, "--provider", "classifier-dev", "--tier", "smart"]);
  assertEqual(run.status, 1, "the CLI refuses --tier smart");
  assertTrue(/smart/i.test(run.stderr), "the CLI says why");
});

test("5. multi-label classification is disabled", async () => {
  const body = buildClassifyRequestBody({ inputs: INPUTS });
  assertEqual(body.multi, false, "multi is false");
  assertTrue(!("max_labels" in body), "max_labels is never sent");
  await assertThrows(() => assertClassifyRequestBody({ ...body, multi: true }), /multi/, "multi:true is refused");
  await assertThrows(() => assertClassifyRequestBody({ ...body, max_labels: 2 }), /not allowed/, "max_labels is refused");
  assertEqual(ctx.savedCalls.calls[0].body.multi, false, "multi:false crossed the boundary");
  assertEqual(runCli(["--stats", "--multi"]).status, 1, "the CLI refuses --multi");
});

test("6. the taxonomy id is pinned", async () => {
  assertEqual(CLASSIFIER_ID, "reach-signal-type-v1", "the classifier id");
  assertEqual(classifierDefinitionFor("reach-signal-type-v1").classifierId, "reach-signal-type-v1", "resolved by id");
  assertEqual(ctx.saved.experiment.classifierId, "reach-signal-type-v1", "stored on the experiment");
});

test("7. the taxonomy version is pinned", async () => {
  assertEqual(CLASSIFIER_VERSION, 1, "the classifier version");
  assertEqual(ctx.saved.experiment.classifierVersion, 1, "stored on the experiment");
  assertTrue(ctx.saved.records.every((record) => record.classifierVersion === 1), "stored on every record");
});

test("8. the taxonomy is EXACTLY the nine pinned labels", async () => {
  assertDeepEqual([...CLASSIFIER_LABELS], PINNED_LABELS, "the frozen labels, in order");
  assertEqual(CLASSIFIER_LABELS.length, 9, "nine labels");
  assertTrue(Object.isFrozen(CLASSIFIER_LABELS), "the label list is frozen");
  assertDeepEqual(ctx.savedCalls.calls[0].body.labels, PINNED_LABELS, "the labels that crossed the boundary");
});

test("9. dynamic labels are refused", async () => {
  const body = buildClassifyRequestBody({ inputs: INPUTS });
  await assertThrows(() => assertClassifyRequestBody({ ...body, labels: [...PINNED_LABELS, "scam"] }), /dynamic labels/, "an added label is refused");
  await assertThrows(() => assertClassifyRequestBody({ ...body, labels: PINNED_LABELS.slice(1) }), /dynamic labels/, "a removed label is refused");
  await assertThrows(() => assertClassifyRequestBody({ ...body, labels: [...PINNED_LABELS].reverse() }), /dynamic labels/, "a reordered taxonomy is refused");
  await assertThrows(() => classifierDefinitionFor("custom-classifier"), UnknownClassifierError, "an unknown classifier is refused");
  assertEqual(runCli(["--stats", "--labels", "a,b"]).status, 1, "the CLI refuses --labels");
  // A caller cannot smuggle labels through the builder.
  assertDeepEqual(buildClassifyRequestBody({ inputs: INPUTS, labels: ["x", "y"] }).labels, PINNED_LABELS, "extra builder arguments never override the taxonomy");
});

test("10. the instruction text is pinned", async () => {
  assertEqual(CLASSIFIER_INSTRUCTIONS, PINNED_INSTRUCTIONS, "the frozen instruction text");
  assertEqual(ctx.savedCalls.calls[0].body.instructions, PINNED_INSTRUCTIONS, "the instructions that crossed the boundary");
  await assertThrows(() => assertClassifyRequestBody({ ...buildClassifyRequestBody({ inputs: INPUTS }), instructions: "Say whether this token will pump." }), /instructions/, "custom instructions are refused");
});

test("11. the instructions digest is stable", async () => {
  assertEqual(CLASSIFIER_INSTRUCTIONS_DIGEST, PINNED_INSTRUCTIONS_DIGEST, "the pinned digest");
  assertEqual(digestOf(PINNED_INSTRUCTIONS), PINNED_INSTRUCTIONS_DIGEST, "recomputed from the text");
  assertEqual(ctx.saved.experiment.instructionsDigest, PINNED_INSTRUCTIONS_DIGEST, "stored on the experiment");
  assertEqual(ctx.saved.experiment.classifierDefinitionDigest, CLASSIFIER_DEFINITION_DIGEST, "the whole definition digest is stored too");
});

/* ============================================================================
 * PART 2 — input projection (12-27)
 * ==========================================================================*/

test("12. the input projection version is pinned", async () => {
  assertEqual(INPUT_PROJECTION_VERSION, "classifier-input-projection-v1", "the projection version");
  assertEqual(ctx.saved.experiment.inputProjectionVersion, "classifier-input-projection-v1", "stored on the experiment");
  assertTrue(ctx.saved.records.every((record) => record.inputProjectionVersion === INPUT_PROJECTION_VERSION), "stored on every record");
});

test("13. ONLY title and textExcerpt enter the classifier input", async () => {
  assertDeepEqual([...CLASSIFIER_INPUT_FIELDS], ["title", "textExcerpt"], "the allowed input fields");
  const accessed = new Set();
  const spy = new Proxy(
    { title: "T-only", textExcerpt: "X-only", query: "Q", canonicalUrl: "U", authorId: "A", captureId: "C" },
    {
      get(target, key) {
        accessed.add(String(key));
        return target[key];
      },
    },
  );
  const projected = projectClassifierInput(spy);
  assertEqual(projected.input, "T-only\nX-only", "title and excerpt, joined deterministically");
  assertDeepEqual([...accessed].sort(), ["textExcerpt", "title"], "the projection READ nothing but title and textExcerpt");
  assertEqual(projectClassifierInput({ title: "Only title" }).input, "Only title", "title alone");
  assertEqual(projectClassifierInput({ textExcerpt: "Only text" }).input, "Only text", "excerpt alone");
});

test("14. the query is excluded from the classifier input", async () => {
  const inputs = projectClassifierInputs(ctx.captureRecords).items.map((item) => item.input).join("\n");
  const queries = [...new Set(ctx.captureRecords.map((record) => record.query))];
  assertTrue(queries.length > 0 && queries.every((query) => typeof query === "string" && query.length > 0), "the fixture records DO carry a query");
  for (const query of queries) assertTrue(!inputs.includes(query), `query '${query}' is absent from every input`);
  assertTrue(!inputs.includes("F51Mint"), "the candidate mint (query material) is absent");
  assertTrue(CLASSIFIER_EXCLUDED_FIELDS.includes("query") && CLASSIFIER_EXCLUDED_FIELDS.includes("queryId"), "query/queryId are in the pinned exclusion list");
  assertTrue(!ctx.captureRecords.some((record) => projectClassifierInput({ ...record, title: null, textExcerpt: null }).ok), "a record with no title/excerpt is never rescued by its query");
});

test("15. URL metadata is excluded from the classifier input", async () => {
  const inputs = projectClassifierInputs(ctx.captureRecords).items.map((item) => item.input).join("\n");
  assertTrue(!inputs.includes("sentinel.example"), "canonicalUrl/canonicalId host is absent");
  assertTrue(!inputs.includes("URL-SENT"), "the record URL path is absent");
  assertTrue(!inputs.includes("fixture-record"), "canonicalId is absent");
  assertTrue(CLASSIFIER_EXCLUDED_FIELDS.includes("canonicalUrl") && CLASSIFIER_EXCLUDED_FIELDS.includes("canonicalId"), "both are in the pinned exclusion list");
});

test("16. the author is excluded from the classifier input", async () => {
  const inputs = projectClassifierInputs(ctx.captureRecords).items.map((item) => item.input).join("\n");
  assertTrue(!inputs.includes("AUTHOR-SENT"), "authorId is absent");
  assertTrue(CLASSIFIER_EXCLUDED_FIELDS.includes("authorId"), "authorId is in the pinned exclusion list");
});

test("17. the capture id (and other provenance) is excluded from the text", async () => {
  const inputs = projectClassifierInputs(ctx.captureRecords).items.map((item) => item.input).join("\n");
  for (const value of [ctx.capture.captureId, "mint-", "mock", "fixture", "4242", "2026-09-19", ...ctx.captureRecords.slice(0, 3).map((record) => record.rawDigest)]) {
    assertTrue(!inputs.includes(value), `provenance value '${value}' never reaches the text`);
  }
  assertDeepEqual(
    [...CLASSIFIER_EXCLUDED_FIELDS].sort(),
    ["authorId", "backend", "canonicalId", "canonicalUrl", "captureId", "engagement", "publishedAt", "query", "queryId", "rawDigest"],
    "the exact pinned exclusion list",
  );
});

test("18. P&L / Arena / Jev state cannot enter the projection", async () => {
  const hostile = {
    title: "Plain public title",
    textExcerpt: "Plain public text",
    pnl: "PNL-SENTINEL-9",
    paperReturn: "RETURN-SENTINEL-9",
    arenaResult: "ARENA-SENTINEL-9",
    gateOutcome: "GATE-SENTINEL-9",
    replication: "REPL-SENTINEL-9",
    jevAnswer: "JEV-SENTINEL-9",
    deepseekOutput: "DEEPSEEK-SENTINEL-9",
    genome: { param: "GENOME-SENTINEL-9" },
    wallet: "WALLET-SENTINEL-9",
    env: { SECRET: "ENV-SENTINEL-9" },
    path: "/home/rio/Projects/evolve/PATH-SENTINEL-9",
  };
  const projected = projectClassifierInput(hostile);
  assertEqual(projected.input, "Plain public title\nPlain public text", "only the two public fields survive");
  assertTrue(!/SENTINEL/.test(projected.input), "no internal state reached the input");
  const source = stripComments(ctx.sources.get("scripts/intelligence/classifier-definition.mjs"));
  for (const token of ["pnl", "arena", "jev", "genome", "wallet", "process.env"]) assertTrue(!new RegExp(token, "i").test(source.replace(/EVOLVE'?s? /g, "")), `the definition module never references '${token}'`);
});

test("19. URLs embedded in text are replaced with a fixed token", async () => {
  const projected = projectClassifierInput({
    title: "See https://evil.example/a?x=1&y=2, and (http://b.example/z) or www.c.example/p.",
    textExcerpt: "Link: [https://d.example/q] and https://e.example/path/to/thing.",
  });
  assertEqual(projected.input, "See [URL], and ([URL]) or [URL].\nLink: [[URL]] and [URL].", "every URL became [URL], punctuation preserved");
  assertTrue(!/https?:|www\./i.test(projected.input), "no URL survives");
  for (const item of projectClassifierInputs(ctx.captureRecords).items) assertTrue(!/https?:\/\/|www\./i.test(item.input), "no fixture input carries a URL");
});

test("20. secret-shaped values are redacted", async () => {
  const projected = projectClassifierInput({
    textExcerpt:
      "config api_key=SUPERSECRETVALUE and Authorization: Bearer abcdef123456 also sk-abcdefghijklmnopqrstuvwxyz012345 " +
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789 AKIAABCDEFGHIJKLMNOP eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij012345",
  });
  for (const secret of ["SUPERSECRETVALUE", "abcdef123456", "sk-abcdef", "ghp_abcdef", "AKIAABCDEFGHIJKLMNOP", "eyJhbGciOiJIUzI1NiJ9"]) {
    assertTrue(!projected.input.includes(secret), `'${secret}' was redacted`);
  }
  assertTrue(projected.input.includes("[redacted]"), "the existing sanitizer's token is used");
  const rich = projectClassifierInputs(ctx.captureRecords).items.map((item) => item.input).join("\n");
  assertTrue(!rich.includes("SUPERSECRET"), "the fixture's api_key value never reaches an input");
});

test("21. the classifier input is bounded", async () => {
  assertEqual(CLASSIFIER_INPUT_MAX_CHARS, 800, "the pinned bound");
  const long = projectClassifierInput({ title: "T".repeat(200), textExcerpt: "word ".repeat(2_000) });
  assertTrue(long.input.length <= 800, `bounded to 800 (got ${long.input.length})`);
  assertEqual(projectClassifierInput({ textExcerpt: "a".repeat(5_000) }).input.length, 800, "an oversized excerpt is cut at exactly 800");
  const emoji = projectClassifierInput({ textExcerpt: `${"a".repeat(799)}😀😀` });
  assertTrue(emoji.input.length <= 800 && !/[\ud800-\udbff]$/.test(emoji.input), "a surrogate pair is never split");
});

test("22. empty input is skipped", async () => {
  for (const record of [{}, { title: null, textExcerpt: null }, { title: "", textExcerpt: "   " }, { title: "\n\t", textExcerpt: "\n" }, null, undefined]) {
    const projected = projectClassifierInput(record);
    assertEqual(projected.ok, false, `${JSON.stringify(record)} is skipped`);
  }
  const { items, skippedEmptyCount } = projectClassifierInputs(ctx.captureRecords);
  assertTrue(skippedEmptyCount > 0, "the fixture capture contains empty records");
  assertEqual(items.length + skippedEmptyCount, ctx.captureRecords.length, "every record is either classified or counted as skipped");
  assertEqual(ctx.saved.experiment.skippedEmptyCount, skippedEmptyCount, "the experiment records the skipped count");
});

test("23. the source recordDigest is preserved", async () => {
  const expected = eligibleRecords().map((record) => record.normalizedDigest);
  assertDeepEqual(ctx.saved.records.map((record) => record.recordDigest), expected, "recordDigest is the source normalizedDigest, in record order");
  assertTrue(ctx.saved.records.length > 0, "records were classified");
});

test("24. inputDigest is deterministic", async () => {
  const first = projectClassifierInputs(ctx.captureRecords).items;
  const second = projectClassifierInputs([...ctx.captureRecords]).items;
  assertDeepEqual(first.map((item) => item.inputDigest), second.map((item) => item.inputDigest), "identical across projections");
  for (const item of first) assertEqual(item.inputDigest, digestOf(item.input), "inputDigest = digestOf(final classifier input)");
  assertDeepEqual(ctx.saved.records.map((record) => record.inputDigest), first.map((item) => item.inputDigest), "and it is what the experiment stored");
});

test("25. no raw classifier input is persisted", async () => {
  const tree = await readTree(ctx.saved.dir);
  const inputs = projectClassifierInputs(ctx.captureRecords).items.map((item) => item.input);
  assertTrue(inputs.length > 0, "there were inputs");
  for (const [file, bytes] of Object.entries(tree)) {
    const text = bytes.toString("utf8");
    for (const input of inputs) assertTrue(!text.includes(input), `${file} does not contain a raw classifier input`);
    assertTrue(!/"inputs?":/.test(text), `${file} has no input field`);
  }
  assertTrue(!("input" in ctx.saved.records[0]), "no input field on a record");
});

test("26. no title is persisted in a classification result", async () => {
  const tree = await readTree(ctx.saved.dir);
  for (const [file, bytes] of Object.entries(tree)) {
    const text = bytes.toString("utf8");
    assertTrue(!text.includes("TITLE-SENT"), `${file} contains no record title`);
    assertTrue(!/"title"\s*:/.test(text), `${file} has no title key`);
  }
});

test("27. no textExcerpt is persisted", async () => {
  const tree = await readTree(ctx.saved.dir);
  for (const [file, bytes] of Object.entries(tree)) {
    const text = bytes.toString("utf8");
    assertTrue(!text.includes("EXCERPT-SENT"), `${file} contains no record excerpt`);
    assertTrue(!/"textExcerpt"\s*:/.test(text), `${file} has no textExcerpt key`);
    assertTrue(!text.includes("sentinel.example") && !text.includes("AUTHOR-SENT"), `${file} has no URL or author either`);
  }
  for (const record of ctx.saved.records) assertDeepEqual(Object.keys(record).sort(), [...CLASSIFICATION_RECORD_FIELDS].sort(), "a record has exactly the whitelisted fields");
});

/* ============================================================================
 * PART 3 — response validation and digests (28-37)
 * ==========================================================================*/

test("28. results map to record order exactly", async () => {
  const items = projectClassifierInputs(ctx.captureRecords).items;
  assertEqual(ctx.savedCalls.calls[0].body.inputs.length, items.length, "ONE request carried every eligible input");
  assertDeepEqual(ctx.savedCalls.calls[0].body.inputs, items.map((item) => item.input), "inputs were sent in record order");
  ctx.saved.records.forEach((record, index) => {
    assertEqual(record.label, labelForInput(items[index].input).label, `result ${index} belongs to input ${index}`);
    assertEqual(record.recordDigest, items[index].recordDigest, `record ${index} is the same source record`);
  });
  // A response that reverses the results is detectable because the labels no longer match their inputs.
  const reversed = validPayload({ inputs: items.map((item) => item.input) });
  reversed.results.reverse();
  const swapped = validateClassifyResponse(reversed, { inputCount: items.length });
  assertTrue(swapped.results.some((row, index) => row.label !== labelForInput(items[index].input).label), "reordering changes the mapping (and is therefore visible to replay checks)");
});

test("29. an unknown response label is rejected (and not retried)", async () => {
  const fetchImpl = scriptedFetch([
    (call) => ({ status: 200, body: validPayload(call.body, { results: call.body.inputs.map(() => ({ label: "definitely_a_scam", confidence: 0.9, scores: {} })) }) }),
  ]);
  resetSleeps();
  const outcome = await makeProvider(fetchImpl).classify({ inputs: INPUTS });
  assertEqual(outcome.ok, false, "rejected");
  assertEqual(outcome.status, CLASSIFIER_STATUS.INVALID_RESPONSE, "an invalid-response status");
  assertEqual(fetchImpl.calls.length, 1, "a malformed answer is never retried");
  assertEqual(ctx.sleeps.length, 0, "no delay");
});

test("30. confidence outside [0, 1] is rejected", async () => {
  for (const confidence of [1.0001, -0.0001, 2, null, "0.9", Number.NaN]) {
    const payload = validPayload({ inputs: INPUTS });
    payload.results[1].confidence = confidence;
    await assertThrows(() => validateClassifyResponse(JSON.parse(JSON.stringify(payload)), { inputCount: 3 }), /confidence/, `confidence ${JSON.stringify(confidence)} is refused`);
  }
  for (const confidence of [0, 1, 0.5]) {
    const payload = validPayload({ inputs: INPUTS });
    payload.results[0].confidence = confidence;
    validateClassifyResponse(payload, { inputCount: 3 });
  }
});

test("31. malformed scores are rejected", async () => {
  const mutations = [
    (row) => (row.scores = [0.1, 0.9]),
    (row) => (row.scores = "0.9"),
    (row) => (row.scores = null),
    (row) => (row.scores = { made_up_label: 0.5 }),
    (row) => (row.scores = { technical_activity: "high" }),
    (row) => (row.scores = { technical_activity: 1.5 }),
    (row) => (row.scores = { technical_activity: -0.1 }),
    (row) => (row.scores = { technical_activity: null }),
    (row) => delete row.scores,
  ];
  for (const [index, mutate] of mutations.entries()) {
    const payload = validPayload({ inputs: INPUTS });
    mutate(payload.results[2]);
    await assertThrows(() => validateClassifyResponse(JSON.parse(JSON.stringify(payload)), { inputCount: 3 }), /score/, `malformed scores #${index} are refused`);
  }
});

test("32. a wrong result count is rejected", async () => {
  const payload = validPayload({ inputs: INPUTS });
  await assertThrows(() => validateClassifyResponse({ ...payload, results: payload.results.slice(0, 2) }, { inputCount: 3 }), /result/, "a partial response is refused");
  await assertThrows(() => validateClassifyResponse({ ...payload, results: [...payload.results, payload.results[0]] }, { inputCount: 3 }), /result/, "an extra result is refused");
  await assertThrows(() => validateClassifyResponse({ ...payload, results: [] }, { inputCount: 3 }), /result/, "an empty response is refused");
  await assertThrows(() => validateClassifyResponse({ ...payload, results: "nope" }, { inputCount: 3 }), /array/, "a non-array is refused");
  const fetchImpl = scriptedFetch([(call) => ({ status: 200, body: validPayload(call.body, { results: validPayload(call.body).results.slice(1) }) })]);
  const outcome = await makeProvider(fetchImpl).classify({ inputs: INPUTS });
  assertEqual(outcome.ok, false, "the provider refuses a partial response end to end");
  assertEqual(outcome.status, CLASSIFIER_STATUS.INVALID_RESPONSE, "as an invalid response");
});

test("33. a valid response is accepted (extra fields ignored)", async () => {
  const payload = validPayload({ inputs: INPUTS });
  payload.somethingNew = { added: true };
  payload.results[0].extraField = "ignored";
  const validated = validateClassifyResponse(payload, { inputCount: 3 });
  assertEqual(validated.results.length, 3, "three results");
  assertTrue(!("somethingNew" in validated) && !("modelsUsed" in validated), "unknown top-level fields are dropped");
  assertDeepEqual(Object.keys(validated.results[0]).sort(), ["confidence", "label", "scores"], "only the whitelisted per-result fields survive");
  assertTrue(!("ms" in validated.results[0]) && !("model" in validated.results[0]), "per-result latency/model are not persisted");
  const fetchImpl = scriptedFetch([okEntry()]);
  const outcome = await makeProvider(fetchImpl).classify({ inputs: INPUTS });
  assertEqual(outcome.ok, true, "accepted end to end");
  assertEqual(outcome.attemptCount, 1, "one attempt");
  assertTrue(!("payload" in outcome) && !("headers" in outcome) && !("body" in outcome), "the raw response is never returned");
});

test("34. the returned model and tier are captured", async () => {
  const fetchImpl = scriptedFetch([okEntry({ model: "fast-model-7" })]);
  const outcome = await makeProvider(fetchImpl).classify({ inputs: INPUTS });
  assertEqual(outcome.model, "fast-model-7", "the model");
  assertEqual(outcome.tier, "fast", "the tier");
  assertEqual(ctx.saved.experiment.returnedModel, "fast-model-1", "the stored returned model");
  assertEqual(ctx.saved.experiment.returnedTier, "fast", "the stored returned tier");
  assertTrue(ctx.saved.records.every((record) => record.model === "fast-model-1" && record.tier === "fast" && record.provider === CLASSIFIER_DEV_PROVIDER), "every record carries model/tier/provider");
});

test("35. resultDigest is deterministic", async () => {
  const first = await runFixtureClassification({ fetchImpl: scriptedFetch([okEntry()]) });
  const second = await runFixtureClassification({ fetchImpl: scriptedFetch([okEntry()]) });
  assertEqual(first.experiment.resultDigest, second.experiment.resultDigest, "same inputs + same answers -> same digest");
  assertEqual(first.experiment.resultDigest, ctx.saved.experiment.resultDigest, "and the saved experiment agrees");
  assertEqual(resultDigestOf(first.records), first.experiment.resultDigest, "= digest over the ordered records");
  const changed = [...first.records];
  changed[0] = { ...changed[0], label: changed[0].label === "unrelated_or_noise" ? "technical_activity" : "unrelated_or_noise" };
  assertTrue(resultDigestOf(changed) !== first.experiment.resultDigest, "changing one label changes the digest");
  assertTrue(resultDigestOf([...first.records].reverse()) !== first.experiment.resultDigest, "ORDER is part of the digest");
});

test("36. stored replay requires zero network calls", async () => {
  const realFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("network is forbidden during replay");
  };
  try {
    const report = await replayClassifierExperiment({ outRoot: ctx.outRoot, captureRoot: ctx.captureRoot, experimentId: ctx.saved.experiment.experimentId });
    const stats = await classifierExperimentStats({ outRoot: ctx.outRoot, experimentId: ctx.saved.experiment.experimentId });
    assertEqual(report.ok, true, `replay is OK (${report.problems.join(" | ")})`);
    assertEqual(report.networkCalls, 0, "replay reports zero network calls");
    assertEqual(stats.networkCalls, 0, "stats reports zero network calls");
  } finally {
    globalThis.fetch = realFetch;
  }
  assertEqual(networkCalls, 0, "fetch was never invoked");
  const replaySource = stripComments(ctx.sources.get("scripts/intelligence/classifier-experiment.mjs"));
  assertTrue(!/\bfetch\s*\(/.test(replaySource), "the experiment module never calls fetch itself");
});

test("37. stored replay reproduces the resultDigest (and detects tampering)", async () => {
  const report = await replayClassifierExperiment({ outRoot: ctx.outRoot, captureRoot: ctx.captureRoot, experimentId: ctx.saved.experiment.experimentId });
  assertEqual(report.resultDigest, ctx.saved.experiment.resultDigest, "the recomputed digest equals the original");
  assertEqual(report.expectedResultDigest, ctx.saved.experiment.resultDigest, "and the stored one");
  assertTrue(Object.values(report.checks).every(Boolean), `every replay check passes: ${JSON.stringify(report.checks)}`);

  // Tamper with a COPY: flip one label. Replay must fail closed.
  const copyRoot = path.join(ctx.tmp, "tamper-classifier");
  await cp(path.join(ctx.outRoot, "experiments", ctx.saved.experiment.experimentId), path.join(copyRoot, "experiments", ctx.saved.experiment.experimentId), { recursive: true });
  const resultsPath = path.join(copyRoot, "experiments", ctx.saved.experiment.experimentId, "results.ndjson");
  const lines = (await readFile(resultsPath, "utf8")).split("\n").filter(Boolean);
  const first = JSON.parse(lines[0]);
  first.label = first.label === "unrelated_or_noise" ? "technical_activity" : "unrelated_or_noise";
  lines[0] = JSON.stringify(first);
  await writeFile(resultsPath, `${lines.join("\n")}\n`, "utf8");
  const tampered = await replayClassifierExperiment({ outRoot: copyRoot, captureRoot: ctx.captureRoot, experimentId: ctx.saved.experiment.experimentId });
  assertEqual(tampered.ok, false, "a tampered result is detected");
  assertEqual(tampered.checks.resultDigest, false, "by the resultDigest check");
});

/* ============================================================================
 * PART 4 — bounded transport recovery (38-46)
 * ==========================================================================*/

test("38. 429 respects Retry-After (seconds, HTTP-date, clamped, malformed)", async () => {
  resetSleeps();
  const fetchImpl = scriptedFetch([httpEntry(429, { "retry-after": "7", "ratelimit-limit": "200", "ratelimit-remaining": "0", "ratelimit-policy": "200;w=60" }), okEntry()]);
  const outcome = await makeProvider(fetchImpl).classify({ inputs: INPUTS });
  assertEqual(outcome.ok, true, "recovered");
  assertEqual(fetchImpl.calls.length, 2, "two attempts");
  assertEqual(ctx.sleeps.length, 1, "one wait");
  assertTrue(ctx.sleeps[0] >= 7_000 && ctx.sleeps[0] <= CLASSIFIER_RETRY_AFTER_MAX_MS, `the wait honours Retry-After (${ctx.sleeps[0]}ms)`);
  assertEqual(outcome.attempts[0].status, CLASSIFIER_STATUS.RATE_LIMIT, "attempt 1 was a rate limit");
  assertEqual(outcome.attempts[0].httpStatus, 429, "with HTTP 429");
  assertEqual(outcome.attempts[0].retryAfterMs, 7_000, "retryAfterMs was recorded as a number");
  assertEqual(outcome.attempts[0].rateLimitLimit, 200, "rate-limit limit parsed");
  assertEqual(outcome.attempts[0].rateLimitRemaining, 0, "rate-limit remaining parsed");
  assertEqual(outcome.attempts[0].rateLimitPolicy, "200;w=60", "rate-limit policy parsed");

  const now = () => NOW;
  assertEqual(parseRetryAfterMs("5", { now }), 5_000, "integer seconds");
  assertEqual(parseRetryAfterMs(new Date(NOW + 9_000).toUTCString(), { now }), 9_000, "HTTP-date");
  assertEqual(parseRetryAfterMs("999999", { now }), 60_000, "clamped to 60s");
  assertEqual(parseRetryAfterMs(new Date(NOW + 3_600_000).toUTCString(), { now }), 60_000, "a far HTTP-date is clamped to 60s");
  assertEqual(parseRetryAfterMs(new Date(NOW - 10_000).toUTCString(), { now }), 0, "a past HTTP-date is 0");
  assertEqual(parseRetryAfterMs("soon", { now }), null, "malformed is ignored");
  assertEqual(parseRetryAfterMs("", { now }), null, "empty is ignored");
  assertEqual(parseRetryAfterMs("-5", { now }), null, "negative is ignored");

  resetSleeps();
  const huge = scriptedFetch([httpEntry(429, { "retry-after": "86400" }), okEntry()]);
  await makeProvider(huge).classify({ inputs: INPUTS });
  assertTrue(ctx.sleeps[0] <= CLASSIFIER_RETRY_AFTER_MAX_MS, "an hour-scale Retry-After is clamped before sleeping");
  resetSleeps();
  const dated = scriptedFetch([httpEntry(429, { "retry-after": new Date(NOW + 11_000).toUTCString() }), okEntry()]);
  await makeProvider(dated).classify({ inputs: INPUTS });
  assertTrue(ctx.sleeps[0] >= 11_000, "an HTTP-date Retry-After is honoured");
});

test("39. 502 (and 503/504) retry", async () => {
  for (const status of [502, 503, 504]) {
    resetSleeps();
    const fetchImpl = scriptedFetch([httpEntry(status), okEntry()]);
    const outcome = await makeProvider(fetchImpl).classify({ inputs: INPUTS });
    assertEqual(outcome.ok, true, `HTTP ${status} recovered`);
    assertEqual(fetchImpl.calls.length, 2, `HTTP ${status} -> two attempts`);
    assertEqual(outcome.attempts[0].status, CLASSIFIER_STATUS.UNAVAILABLE, `HTTP ${status} is classified as upstream-unavailable`);
    assertEqual(outcome.attempts[0].retryable, true, "and retryable");
    assertEqual(ctx.sleeps.length, 1, "one wait");
  }
});

test("40. a timeout retries", async () => {
  resetSleeps();
  const abort = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
  const fetchImpl = scriptedFetch([{ throws: abort }, okEntry()]);
  const outcome = await makeProvider(fetchImpl).classify({ inputs: INPUTS });
  assertEqual(outcome.ok, true, "recovered");
  assertEqual(fetchImpl.calls.length, 2, "two attempts");
  assertEqual(outcome.attempts[0].status, CLASSIFIER_STATUS.TIMEOUT, "classified as a timeout");
  assertEqual(outcome.attempts[0].retryable, true, "retryable");

  // The REAL abort path: the per-attempt timer aborts a fetch that never answers.
  const hanging = async (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  const timedOut = await createClassifierDevProvider({
    fetchImpl: hanging,
    sleepImpl: recordSleep,
    randomImpl: fixedRandom,
    settings: { maxAttempts: 1, backoffBaseMs: 1_000, backoffMaxMs: 30_000, timeoutMs: 5 },
  }).classify({ inputs: INPUTS });
  assertEqual(timedOut.ok, false, "a hanging request fails");
  assertEqual(timedOut.status, CLASSIFIER_STATUS.TIMEOUT, "as a timeout");
});

test("41. a temporary network failure retries", async () => {
  for (const code of ["ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT"]) {
    resetSleeps();
    const failure = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
    const fetchImpl = scriptedFetch([{ throws: failure }, okEntry()]);
    const outcome = await makeProvider(fetchImpl).classify({ inputs: INPUTS });
    assertEqual(outcome.ok, true, `${code} recovered`);
    assertEqual(fetchImpl.calls.length, 2, `${code} -> two attempts`);
    assertEqual(outcome.attempts[0].status, CLASSIFIER_STATUS.NETWORK_ERROR, `${code} is a network error`);
  }
});

test("42. 400 is not retried", async () => {
  resetSleeps();
  const fetchImpl = scriptedFetch([httpEntry(400, {}, { error: "bad tier", code: "bad_tier" })]);
  const outcome = await makeProvider(fetchImpl).classify({ inputs: INPUTS });
  assertEqual(outcome.ok, false, "failed");
  assertEqual(outcome.status, CLASSIFIER_STATUS.BAD_REQUEST, "as a bad request");
  assertEqual(fetchImpl.calls.length, 1, "exactly one attempt");
  assertEqual(ctx.sleeps.length, 0, "no wait");
  assertEqual(outcome.attempts[0].retryable, false, "recorded as non-retryable");
});

test("43. 404 is not retried (nor other 4xx, 500 or malformed JSON)", async () => {
  for (const [status, body, expected] of [
    [404, { error: "nope" }, CLASSIFIER_STATUS.NOT_FOUND],
    [401, { error: "x" }, CLASSIFIER_STATUS.HTTP_ERROR],
    [422, { error: "x" }, CLASSIFIER_STATUS.HTTP_ERROR],
    [500, { error: "x" }, CLASSIFIER_STATUS.HTTP_ERROR],
    [200, "this is not json", CLASSIFIER_STATUS.INVALID_RESPONSE],
    [301, {}, CLASSIFIER_STATUS.HTTP_ERROR],
  ]) {
    resetSleeps();
    const fetchImpl = scriptedFetch([{ status, body, headers: {} }, okEntry()]);
    const outcome = await makeProvider(fetchImpl).classify({ inputs: INPUTS });
    assertEqual(outcome.ok, false, `HTTP ${status} fails`);
    assertEqual(outcome.status, expected, `HTTP ${status} status`);
    assertEqual(fetchImpl.calls.length, 1, `HTTP ${status} is never retried`);
    assertEqual(ctx.sleeps.length, 0, `HTTP ${status} causes no wait`);
  }
});

test("44. max attempts is enforced (and clamped to 1..5)", async () => {
  resetSleeps();
  const always503 = scriptedFetch([httpEntry(503)]);
  const outcome = await makeProvider(always503).classify({ inputs: INPUTS });
  assertEqual(outcome.ok, false, "gives up");
  assertEqual(always503.calls.length, 3, "exactly 3 attempts (the default)");
  assertEqual(outcome.attemptCount, 3, "attemptCount = 3");
  assertEqual(ctx.sleeps.length, 2, "two waits (none after the last attempt)");
  assertEqual(outcome.attempts[2].backoffMs, null, "no backoff after the final attempt");

  const five = scriptedFetch([httpEntry(503)]);
  await makeProvider(five, { settings: { maxAttempts: 5 } }).classify({ inputs: INPUTS });
  assertEqual(five.calls.length, 5, "5 attempts when asked for 5");
  const clamped = scriptedFetch([httpEntry(503)]);
  await makeProvider(clamped, { settings: { maxAttempts: 99 } }).classify({ inputs: INPUTS });
  assertEqual(clamped.calls.length, 5, "99 is clamped to 5");
  const single = scriptedFetch([httpEntry(503)]);
  await makeProvider(single, { settings: { maxAttempts: 0 } }).classify({ inputs: INPUTS });
  assertEqual(single.calls.length, 1, "0 is clamped to 1");

  assertEqual(resolveClassifierSettings({}).maxAttempts, 3, "default 3");
  assertEqual(resolveClassifierSettings({ EVOLVE_CLASSIFIER_MAX_ATTEMPTS: "99" }).maxAttempts, 5, "env 99 -> 5");
  assertEqual(resolveClassifierSettings({ EVOLVE_CLASSIFIER_MAX_ATTEMPTS: "0" }).maxAttempts, 1, "env 0 -> 1");
  assertEqual(resolveClassifierSettings({ EVOLVE_CLASSIFIER_MAX_ATTEMPTS: "abc" }).maxAttempts, 3, "env junk -> 3");
  assertEqual(resolveClassifierSettings({}).backoffBaseMs, 1_000, "default backoff base 1000");
  assertEqual(resolveClassifierSettings({}).backoffMaxMs, 30_000, "default backoff max 30000");
});

test("45. jitter and backoff are bounded", async () => {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const exponential = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
    for (const draw of [0, 0.25, 0.5, 0.75, 0.999999, 1, Number.NaN, -3, 7]) {
      const delay = backoffDelayMs(attempt, { baseMs: 1_000, maxMs: 30_000, randomImpl: () => draw });
      assertTrue(delay >= 0 && delay <= 30_000, `attempt ${attempt} draw ${draw}: ${delay}ms is within [0, 30000]`);
      assertTrue(delay >= Math.round(exponential * 0.75) - 1 || exponential * 0.75 > 30_000, `attempt ${attempt} draw ${draw}: jitter never goes below -25%`);
      const bounded = retryDelayMs(attempt, 120_000, { baseMs: 1_000, maxMs: 30_000, randomImpl: () => draw });
      assertTrue(bounded <= CLASSIFIER_RETRY_AFTER_MAX_MS, `retry delay ${bounded}ms never exceeds the Retry-After ceiling`);
    }
  }
  assertEqual(backoffDelayMs(1, { baseMs: 1_000, maxMs: 30_000, randomImpl: () => 0.5 }), 1_000, "attempt 1 waits ~base at the median draw");
  assertEqual(backoffDelayMs(2, { baseMs: 1_000, maxMs: 30_000, randomImpl: () => 0.5 }), 2_000, "attempt 2 waits ~2x base");
  assertTrue(backoffDelayMs(1, { baseMs: 1_000, maxMs: 30_000, randomImpl: () => 0 }) < backoffDelayMs(1, { baseMs: 1_000, maxMs: 30_000, randomImpl: () => 1 }), "jitter actually varies the delay");
  assertEqual(retryDelayMs(1, null, { baseMs: 1_000, maxMs: 30_000, randomImpl: () => 0.5 }), 1_000, "no Retry-After -> plain backoff");
  assertTrue(ctx.sleeps.every((ms) => ms <= CLASSIFIER_RETRY_AFTER_MAX_MS), "every recorded wait in this suite is bounded");
});

test("46. the validator performs no real delay", async () => {
  resetSleeps();
  const started = Date.now();
  const fetchImpl = scriptedFetch([httpEntry(429, { "retry-after": "45" }), httpEntry(503), okEntry()]);
  const outcome = await makeProvider(fetchImpl, { settings: { backoffBaseMs: 10_000 } }).classify({ inputs: INPUTS });
  const elapsed = Date.now() - started;
  assertEqual(outcome.ok, true, "recovered after two waits");
  assertTrue(ctx.sleeps.reduce((sum, ms) => sum + ms, 0) >= 45_000, "the injected waits total well over 45s of 'virtual' time");
  assertTrue(elapsed < 500, `while only ${elapsed}ms of real time passed`);
});

/* ============================================================================
 * PART 5 — no credentials (47-49)
 * ==========================================================================*/

function headerNames(init) {
  return Object.keys(init.headers ?? {}).map((name) => name.toLowerCase()).sort();
}

test("47. no Authorization header is sent", async () => {
  for (const call of ctx.savedCalls.calls) {
    assertDeepEqual(headerNames(call.init), ["accept", "content-type"], "the EXACT header set");
    for (const forbidden of ["authorization", "x-api-key", "api-key", "cookie", "proxy-authorization"]) assertTrue(!headerNames(call.init).includes(forbidden), `no ${forbidden} header`);
  }
  const serialized = JSON.stringify(ctx.savedCalls.calls.map((call) => ({ url: call.url, headers: call.init.headers, body: call.body })));
  assertTrue(!/bearer/i.test(serialized), "no bearer token anywhere in the outgoing request");
  assertEqual(ctx.savedCalls.calls[0].init.credentials, undefined, "no credentials mode is set");
});

test("48. no gateway key is sent", async () => {
  const before = { gateway: process.env.AI_GATEWAY_API_KEY, jev: process.env.EVOLVE_JEV_API_KEY };
  process.env.AI_GATEWAY_API_KEY = GATEWAY_KEY_SENTINEL;
  process.env.EVOLVE_JEV_API_KEY = DIRECT_KEY_SENTINEL;
  try {
    const fetchImpl = scriptedFetch([okEntry()]);
    await runFixtureClassification({ fetchImpl });
    const serialized = JSON.stringify(fetchImpl.calls.map((call) => ({ url: call.url, init: call.init, body: call.body })));
    assertTrue(!serialized.includes(GATEWAY_KEY_SENTINEL), "the gateway key never crossed the boundary");
    // The settings resolver only ever READS EVOLVE_CLASSIFIER_* keys.
    const accessed = new Set();
    const env = new Proxy(
      { AI_GATEWAY_API_KEY: GATEWAY_KEY_SENTINEL, EVOLVE_JEV_API_KEY: DIRECT_KEY_SENTINEL, EVOLVE_CLASSIFIER_MAX_ATTEMPTS: "2" },
      {
        get(target, key) {
          accessed.add(String(key));
          return target[key];
        },
      },
    );
    const settings = resolveClassifierSettings(env);
    assertEqual(settings.maxAttempts, 2, "classifier settings are still honoured");
    assertTrue([...accessed].every((key) => key.startsWith("EVOLVE_CLASSIFIER_")), `only EVOLVE_CLASSIFIER_* was read (${[...accessed].join(", ")})`);
    assertTrue(!JSON.stringify(settings).includes(GATEWAY_KEY_SENTINEL), "no key in the settings");
  } finally {
    if (before.gateway === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = before.gateway;
    if (before.jev === undefined) delete process.env.EVOLVE_JEV_API_KEY;
    else process.env.EVOLVE_JEV_API_KEY = before.jev;
  }
  for (const file of CLASSIFIER_SOURCE_FILES) assertTrue(!/AI_GATEWAY/.test(ctx.sources.get(file)), `${file} never references the gateway key`);
});

test("49. no direct TypeSafe / Jev key is sent", async () => {
  process.env.EVOLVE_JEV_API_KEY = DIRECT_KEY_SENTINEL;
  process.env.TYPESAFE_API_KEY = DIRECT_KEY_SENTINEL;
  try {
    const fetchImpl = scriptedFetch([okEntry()]);
    await runFixtureClassification({ fetchImpl });
    const serialized = JSON.stringify(fetchImpl.calls.map((call) => ({ url: call.url, init: call.init, body: call.body })));
    assertTrue(!serialized.includes(DIRECT_KEY_SENTINEL), "the direct key never crossed the boundary");
  } finally {
    delete process.env.EVOLVE_JEV_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
  }
  for (const file of CLASSIFIER_SOURCE_FILES) {
    const source = ctx.sources.get(file);
    assertTrue(!/EVOLVE_JEV|TYPESAFE|typesafe/i.test(source), `${file} never references a Jev/TypeSafe credential`);
    // (the experiment module lists "authorization" only as a FORBIDDEN persisted key)
    if (!file.endsWith("classifier-experiment.mjs")) assertTrue(!/authorization/i.test(stripComments(source)), `${file} never builds an Authorization header`);
  }
});

/* ============================================================================
 * PART 6 — storage, integrity, isolation (50-57)
 * ==========================================================================*/

test("50. the classifier experiment is stored OUTSIDE the capture directory", async () => {
  const dir = ctx.saved.dir;
  assertTrue(dir.startsWith(path.join(ctx.outRoot, "experiments", "clexp-")), "under <out>/experiments/clexp-…");
  assertTrue(path.relative(ctx.captureRoot, dir).startsWith(".."), "not inside the capture root");
  assertDeepEqual((await readdir(dir)).sort(), ["experiment.json", "provider", "results.ndjson"], "exactly experiment.json, results.ndjson, provider/");
  assertDeepEqual(await readdir(path.join(dir, "provider", "runs")), ["run-0001.json"], "and provider/runs/*.json");
  const captureDir = path.join(ctx.captureRoot, "2026-09-19", ctx.capture.captureId);
  assertTrue(!(await readdir(captureDir)).some((name) => /classif|clexp|results/.test(name)), "the capture directory gained no classifier file");
  await assertThrows(() => assertOutsideCaptureRoot(ctx.captureRoot, path.join(ctx.captureRoot, "classifier")), /SEPARATE/, "an out root inside the capture root is refused");
  const fetchImpl = scriptedFetch([okEntry()]);
  await assertThrows(
    () => runFixtureClassification({ fetchImpl, save: true, outRoot: path.join(ctx.captureRoot, "2026-09-19", ctx.capture.captureId, "classifier") }),
    /SEPARATE/,
    "saving inside a capture directory is refused",
  );
  assertEqual(fetchImpl.calls.length, 0, "and it is refused BEFORE any network request");
  assertEqual(ctx.saved.experiment.immutable, true, "the experiment is immutable");
  assertEqual(ctx.saved.experiment.shadowOnly, true, "shadow only");
  assertEqual(ctx.saved.experiment.paperOnly, true, "paper only");
  await assertThrows(
    () => runFixtureClassification({ fetchImpl: scriptedFetch([okEntry()]), save: true }),
    /already exists/,
    "an experiment is never overwritten",
  );
});

test("51. the source capture stays byte-identical", async () => {
  const captureDir = path.join(ctx.captureRoot, "2026-09-19", ctx.capture.captureId);
  const before = await contentHashes(captureDir);
  const fetchImpl = scriptedFetch([okEntry()]);
  const isolatedOut = path.join(ctx.tmp, "classifier-51");
  await runFixtureClassification({ fetchImpl, save: true, outRoot: isolatedOut });
  await replayClassifierExperiment({ outRoot: isolatedOut, captureRoot: ctx.captureRoot, experimentId: (await readdir(path.join(isolatedOut, "experiments")))[0] });
  assertDeepEqual(await contentHashes(captureDir), before, "every capture file is byte-identical after classification + replay");
  assertEqual((await verifyCapture(ctx.captureRoot, ctx.capture.captureId)).ok, true, "and it still verifies");
});

test("52. failed capture integrity refuses classification", async () => {
  const root = path.join(ctx.tmp, "captures-tampered");
  await cp(ctx.captureRoot, root, { recursive: true });
  const dir = path.join(root, "2026-09-19", ctx.capture.captureId);

  // (a) records no longer match the frozen manifest
  const recordsPath = path.join(dir, "records.ndjson");
  const original = await readFile(recordsPath, "utf8");
  await writeFile(recordsPath, original.replace("Merged a PR", "Merged a PR!"), "utf8");
  const fetchA = scriptedFetch([okEntry()]);
  const refusedA = await assertThrows(() => runFixtureClassification({ captureRoot: root, fetchImpl: fetchA }), ClassifierCaptureRefusedError, "tampered records are refused");
  assertTrue(/integrity/i.test(refusedA.message), "for an integrity reason");
  assertEqual(fetchA.calls.length, 0, "with ZERO network requests");
  await writeFile(recordsPath, original, "utf8");
  assertEqual((await prepareClassification({ captureRoot: root, captureId: ctx.capture.captureId })).items.length > 0, true, "restored bytes classify again");

  // (b) not immutable / not finalized / missing
  const manifestPath = path.join(dir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, immutable: false }), "utf8");
  await assertThrows(() => prepareClassification({ captureRoot: root, captureId: ctx.capture.captureId }), /not immutable/, "a non-immutable capture is refused");
  await writeFile(manifestPath, JSON.stringify({ ...manifest, finalized: false }), "utf8");
  await assertThrows(() => prepareClassification({ captureRoot: root, captureId: ctx.capture.captureId }), /not finalized/, "a non-finalized capture is refused");
  await writeFile(manifestPath, JSON.stringify({ ...manifest, digests: { ...manifest.digests, recordsDigest: "0".repeat(64) } }), "utf8");
  await assertThrows(() => prepareClassification({ captureRoot: root, captureId: ctx.capture.captureId }), /integrity/, "a manifest that disagrees with the records is refused");
  await assertThrows(() => prepareClassification({ captureRoot: root, captureId: "capture-20990101T000000Z" }), /no capture manifest/, "a missing capture is refused");
  await assertThrows(() => prepareClassification({ captureRoot: root, captureId: "capture-20260919T000000Z/../../etc" }), ClassifierCaptureRefusedError, "a path-traversal capture id is refused");
});

test("53. classification never calls Agent-Reach (and never captures)", async () => {
  const capturesBefore = await listCaptures(ctx.captureRoot);
  const fetchImpl = scriptedFetch([okEntry()]);
  await runFixtureClassification({ fetchImpl });
  assertDeepEqual(await listCaptures(ctx.captureRoot), capturesBefore, "no new capture appeared");
  assertTrue(fetchImpl.calls.every((call) => call.url === CLASSIFIER_DEV_ENDPOINT), "the ONLY request target is classifier.dev");
  for (const file of CLASSIFIER_SOURCE_FILES) {
    const source = ctx.sources.get(file);
    const specs = importSpecifiers(source);
    assertTrue(!specs.some((spec) => /agent-reach|providers\/|\/provider\.mjs|child_process|query-sets/.test(spec)), `${file} imports no Agent-Reach / provider / subprocess module`);
    assertTrue(!/\brunCapture\b|\bresolveIntelligenceProvider\b|\bspawn(?:Sync)?\s*\(|\bexecFile(?:Sync)?\s*\(|\bexec(?:Sync)?\s*\(/.test(stripComments(source)), `${file} never calls a capture/provider/subprocess`);
  }
  const captureImport = /import\s*\{([^}]*)\}\s*from\s*"\.\/capture\.mjs"/.exec(ctx.sources.get("scripts/intelligence/classifier-experiment.mjs"));
  assertDeepEqual(
    captureImport[1].split(",").map((name) => name.trim()).filter(Boolean).sort(),
    ["loadCaptureRecords", "readCaptureManifest", "verifyCapture"],
    "the ONLY capture.mjs imports are the three read-only helpers",
  );
});

test("54. classification never calls Jev (and Jev never imports the classifier)", async () => {
  for (const file of CLASSIFIER_SOURCE_FILES) {
    const source = ctx.sources.get(file);
    assertTrue(!importSpecifiers(source).some((spec) => /jev/i.test(spec)), `${file} imports nothing from Jev`);
    assertTrue(!/\bjevDecide\b|\bcreateVercelJevProvider\b|\bcreateResilientJev|\bJEV_STATUS\b/.test(stripComments(source)), `${file} references no Jev API`);
  }
  for (const [file, source] of ctx.sources) {
    if (!file.includes("jev")) continue;
    assertTrue(!CLASSIFIER_REFERENCE.test(source), `${file} does not reference the classifier`);
  }
  assertTrue(!CLASSIFIER_SOURCE_FILES.some((file) => file.includes("scripts/jev/")), "no classifier module lives under scripts/jev/");
});

test("55. classification never calls DeepSeek", async () => {
  for (const file of CLASSIFIER_SOURCE_FILES) {
    const source = ctx.sources.get(file);
    assertTrue(!importSpecifiers(source).some((spec) => /research|deepseek|cline/i.test(spec)), `${file} imports no research/DeepSeek module`);
    assertTrue(!/\brunResearch\b|\bdeepseek-cline\b|\bcreateResearchProvider\b/i.test(stripComments(source)), `${file} references no DeepSeek API`);
  }
  assertTrue(!CLASSIFIER_REFERENCE.test(ctx.sources.get("scripts/research.mjs")), "the research CLI does not mention the classifier");
});

test("56. classification never calls the Arena", async () => {
  for (const file of CLASSIFIER_SOURCE_FILES) {
    const source = ctx.sources.get(file);
    assertTrue(!importSpecifiers(source).some((spec) => /arena|champion|replication|engine|\/experiment\.mjs$/.test(spec)), `${file} imports no Arena/champion/replication/engine module`);
    assertTrue(!/\brunArena\b|\brunTournament\b|\bevolveGeneration\b/.test(stripComments(source)), `${file} runs no Arena code`);
  }
  assertTrue(!CLASSIFIER_REFERENCE.test(ctx.sources.get("scripts/arena.mjs")), "the Arena CLI does not mention the classifier");
  assertTrue(!CLASSIFIER_REFERENCE.test(ctx.sources.get("scripts/evolve-engine.mjs")), "the engine does not mention the classifier");
});

test("57. classification never touches wallet / trading code", async () => {
  for (const file of CLASSIFIER_SOURCE_FILES) {
    const source = ctx.sources.get(file);
    assertTrue(!importSpecifiers(source).some((spec) => /market|wallet|signer|solana|jupiter|rpc|trade/i.test(spec)), `${file} imports no market/wallet/RPC module`);
    for (const pattern of FORBIDDEN_TRANSACTION_API) assertTrue(!pattern.test(stripComments(source)), `${file} references no transaction API (${pattern})`);
  }
  const persisted = JSON.stringify(ctx.saved.experiment) + JSON.stringify(ctx.saved.records);
  for (const forbidden of ["bullish", "bearish", "expectedReturn", "tradeConfidence", "buyProbability", "sellProbability", "qualityScore", "scamScore", "profitability"]) {
    assertTrue(!persisted.toLowerCase().includes(forbidden.toLowerCase()), `the artifact carries no '${forbidden}'`);
  }
  assertDeepEqual(Object.keys(ctx.saved.experiment.summary).sort(), ["apiVersion", "classifiedCount", "labelCounts", "latencyMs", "meanConfidence", "returnedModel"], "the summary is descriptive counts only");
});

/* ============================================================================
 * PART 7 — no downstream routing (58-63)
 * ==========================================================================*/

test("58. the external-intelligence packet is unchanged", async () => {
  assertDeepEqual([...ALLOWED_PACKET_KEYS], PINNED_PACKET_KEYS, "the packet key whitelist is byte-for-byte the pinned one");
  const replay = await replayCapture({ root: ctx.captureRoot, captureId: ctx.capture.captureId, asOf: null });
  const packet = buildExternalIntelligencePacket({ replay });
  assertTrue(Object.keys(packet).every((key) => PINNED_PACKET_KEYS.includes(key)), "a packet built AFTER classification has only whitelisted keys");
  assertTrue(!/classif/i.test(JSON.stringify(packet)), "no classifier field in the packet");
  assertEqual(auditExternalIntelligencePacket(packet).routingActive, false, "and no routing is active");
  assertTrue(!/classif/i.test(ctx.sources.get("scripts/intelligence/packet.mjs")), "packet.mjs never mentions the classifier");
  if (ctx.realCaptureAvailable) {
    const real = await replayCapture({ root: REAL_CAPTURE_ROOT, captureId: REAL_V2_CAPTURE_ID, asOf: null });
    assertEqual(buildExternalIntelligencePacket({ replay: real }).packetDigest, REAL_V2_PINS.packetDigest, "the real V2 packet digest is EXACTLY the pinned value");
  } else skip(`the real capture ${REAL_V2_CAPTURE_ID} is not present — the pinned packet digest was skipped`);
});

test("59. the external feature version is unchanged", async () => {
  assertEqual(DEFAULT_FEATURE_VERSION, "external-intelligence-features-v2", "new captures still pin V2");
  assertEqual(INTELLIGENCE_FEATURE_VERSION, "external-intelligence-features-v1", "V1 is unchanged");
  assertEqual(INTELLIGENCE_FEATURE_VERSION_V2, "external-intelligence-features-v2", "V2 is unchanged");
  assertDeepEqual([...REGISTERED_FEATURE_VERSIONS], ["external-intelligence-features-v1", "external-intelligence-features-v2"], "no third version was registered");
  assertTrue(!/classif/i.test(ctx.sources.get("scripts/intelligence/features.mjs")), "features.mjs never mentions the classifier");
  const replay = await replayCapture({ root: ctx.captureRoot, captureId: ctx.capture.captureId, asOf: null });
  assertTrue(!/classif/i.test(JSON.stringify(replay.features)), "the feature vector has no classifier field");
  assertEqual(ctx.saved.experiment.featureVersion, "external-intelligence-features-v2", "the experiment merely REFERENCES the capture's pinned version");
});

test("60. the Jev routing flags and question set are unchanged", async () => {
  assertEqual(JEV_ROUTING_ACTIVE, false, "JEV_ROUTING_ACTIVE is still false");
  assertEqual(JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_ID, "jev-external-intelligence-v1", "the Jev question set id is unchanged");
  const replay = await replayCapture({ root: ctx.captureRoot, captureId: ctx.capture.captureId, asOf: null });
  assertEqual(buildExternalIntelligencePacket({ replay }).routing.jevRoutingActive, false, "the packet's Jev routing flag is still false");
  assertTrue(!CLASSIFIER_REFERENCE.test(ctx.sources.get("scripts/jev/questions.mjs")), "the Jev question set never references classifier.dev (its only 'classifier' is the pre-existing regime-classifier comment)");
  assertTrue(!/classif/i.test(ctx.sources.get("scripts/jev-external-bridge.mjs")), "the Jev projection never mentions the classifier");
});

test("61. the DeepSeek routing flags are unchanged", async () => {
  assertEqual(DEEPSEEK_ROUTING_ACTIVE, false, "DEEPSEEK_ROUTING_ACTIVE is still false");
  const replay = await replayCapture({ root: ctx.captureRoot, captureId: ctx.capture.captureId, asOf: null });
  const packet = buildExternalIntelligencePacket({ replay });
  assertEqual(packet.routing.deepseekRoutingActive, false, "the packet's DeepSeek routing flag is still false");
  assertTrue(!/classif/i.test(ctx.sources.get("scripts/jev-external.mjs")), "the Jev external CLI never mentions the classifier");
});

test("62. existing Jev experiments are unchanged", async () => {
  assertDeepEqual(await metadataSnapshot(path.join(REPO, ".evolve", "jev")), ctx.evidenceBaseline.jev, "no existing Jev experiment (or any .evolve/jev file) was touched");
});

test("63. Phase 5F.1 provider-health state is unchanged", async () => {
  assertDeepEqual(await metadataSnapshot(path.join(REPO, ".evolve", "jev", "provider-health")), ctx.evidenceBaseline.jevHealth, "the provider-health artifacts are byte-for-byte untouched");
  for (const file of CLASSIFIER_SOURCE_FILES) assertTrue(!/provider-health|writeProviderHealth|applyTransientExhaustion/.test(ctx.sources.get(file)), `${file} never touches the Jev provider-health store`);
  assertDeepEqual(await metadataSnapshot(path.join(REPO, ".evolve", "classifier")), ctx.evidenceBaseline.classifier, "and this suite wrote nothing into the repository's .evolve/classifier");
});

/* ============================================================================
 * PART 8 — identity barriers (64-68 + the real captures)
 * ==========================================================================*/

test("64. Wave 1 is byte-identical", async () => {
  if (!ctx.evidenceAvailable) return skip("the .evolve replication/history evidence is not present — the Wave 1 case was skipped");
  assertEqual(WAVE_1_DATASET_IDS.length, 3, "Wave 1 is three datasets");
  for (const id of WAVE_1_DATASET_IDS) assertEqual(await datasetFingerprint(id), WAVE_1_DATASET_FINGERPRINTS[id], `${id} still matches its pinned fingerprint`);
  assertEqual(CANONICAL_WAVE_1_REPLICATION_ID, "rep-66884de4e460", "the canonical Wave 1 replication id is unchanged");
  assertEqual(CANONICAL_HISTORICAL_FREEZE_PATH, "phase5c-freeze.json", "the canonical historical freeze path is unchanged");
  assertDeepEqual(await metadataSnapshot(path.join(REPO, ".evolve", "replication", "waves")), ctx.evidenceBaseline.waves, "wave manifests unchanged");
});

test("65. Wave 2 is byte-identical", async () => {
  if (!ctx.evidenceAvailable) return skip("the .evolve replication/history evidence is not present — the Wave 2 case was skipped");
  assertEqual(WAVE_2_DATASET_IDS.length, 3, "Wave 2 is three datasets");
  for (const id of WAVE_2_DATASET_IDS) assertEqual(await datasetFingerprint(id), WAVE_2_DATASET_FINGERPRINTS[id], `${id} still matches its pinned fingerprint`);
});

test("66. the frozen cohorts are unchanged", async () => {
  if (!ctx.evidenceAvailable) return skip("the .evolve replication evidence is not present — the cohort case was skipped");
  const mock = await readFrozenCohort(path.join(REPO, ".evolve", "replication"), "mock");
  const deepseek = await readFrozenCohort(path.join(REPO, ".evolve", "replication"), "deepseek");
  assertEqual(mock.cohortDigest, FROZEN_COHORT_DIGESTS.mock, "the Mock cohort digest is unchanged");
  assertEqual(deepseek.cohortDigest, FROZEN_COHORT_DIGESTS.deepseek, "the DeepSeek cohort digest is unchanged");
  assertEqual(mock.immutable, true, "the Mock cohort is still immutable");
  assertEqual(deepseek.frozen, true, "the DeepSeek cohort is still frozen");
  assertDeepEqual(await metadataSnapshot(path.join(REPO, ".evolve", "replication", "cohorts")), ctx.evidenceBaseline.cohorts, "cohort files unchanged");
});

test("67. the six replication datasets are unchanged", async () => {
  if (!ctx.evidenceAvailable) return skip("the .evolve history evidence is not present — the dataset case was skipped");
  let checked = 0;
  for (const [ids, fingerprints] of [
    [WAVE_1_DATASET_IDS, WAVE_1_DATASET_FINGERPRINTS],
    [WAVE_2_DATASET_IDS, WAVE_2_DATASET_FINGERPRINTS],
  ]) {
    for (const id of ids) {
      assertEqual(await datasetFingerprint(id), fingerprints[id], `${id} matches its pinned fingerprint`);
      checked += 1;
    }
  }
  assertEqual(checked, 6, "exactly six datasets were verified");
  assertDeepEqual(await metadataSnapshot(path.join(REPO, ".evolve", "history")), ctx.evidenceBaseline.history, "recorded datasets unchanged (no byte or mtime moved)");
});

test("68. the evaluation contract digest is EXACTLY the pinned value", async () => {
  assertEqual(CANONICAL_EVALUATION_CONTRACT_DIGEST, "4cf8ac1fa7db290acadeccf6043ec34c3239f8e3f848e9e50d8560826de85052", "the published contract pin is unchanged");
  if (!ctx.evidenceAvailable) return skip("the stored Wave 1 freeze is not present — the derived-contract case was skipped");
  const stored = await readFreeze({ root: path.join(REPO, ".evolve", "replication") });
  assertEqual(evaluationContractDigest(stored), CANONICAL_EVALUATION_CONTRACT_DIGEST, "the STORED freeze still derives the canonical digest");
});

test("69. the real V2 capture and the legacy V1 capture are unchanged", async () => {
  if (!ctx.realCaptureAvailable) return skip(`the real captures are not present — pinned-digest cases were skipped`);
  const manifest = await readCaptureManifest(REAL_CAPTURE_ROOT, REAL_V2_CAPTURE_ID);
  assertEqual(manifest.manifestDigest, REAL_V2_PINS.manifestDigest, "the V2 manifest digest is EXACTLY the pinned value");
  assertEqual(manifest.digests.recordsDigest, REAL_V2_PINS.recordsDigest, "the V2 records digest is EXACTLY the pinned value");
  assertEqual((await verifyCapture(REAL_CAPTURE_ROOT, REAL_V2_CAPTURE_ID)).ok, true, "the V2 capture still verifies");
  assertEqual((await replayCapture({ root: REAL_CAPTURE_ROOT, captureId: REAL_V2_CAPTURE_ID, asOf: null })).replayDigest, REAL_V2_PINS.replayDigest, "the V2 replay digest is EXACTLY the pinned value");
  const legacy = await readCaptureManifest(REAL_CAPTURE_ROOT, LEGACY_V1_CAPTURE_ID);
  assertEqual(legacy.captureSchemaVersion, 1, "the legacy manifest is still schema 1");
  assertEqual((await replayCapture({ root: REAL_CAPTURE_ROOT, captureId: LEGACY_V1_CAPTURE_ID, asOf: null })).replayDigest, LEGACY_V1_REPLAY_DIGEST, "the legacy replay digest is EXACTLY the pinned value");
  assertDeepEqual(await metadataSnapshot(REAL_CAPTURE_ROOT), ctx.evidenceBaseline.intelligence, "no real capture byte moved");
});

/* ============================================================================
 * EXTRA — preflight on the real capture, rate-limit metadata, limits, CLI
 * ==========================================================================*/

test("70. the real V2 capture preflights offline (one GitHub record, zero network)", async () => {
  if (!ctx.realCaptureAvailable) return skip(`the real capture ${REAL_V2_CAPTURE_ID} is not present — its preflight was skipped`);
  const realFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("preflight must be offline");
  };
  try {
    const prepared = await prepareClassification({ captureRoot: REAL_CAPTURE_ROOT, captureId: REAL_V2_CAPTURE_ID });
    assertEqual(prepared.items.length, 1, "exactly one classifiable record");
    assertEqual(prepared.recordCount, 1, "the capture holds one record");
    assertEqual(prepared.skippedEmptyCount, 0, "none skipped");
    assertEqual(prepared.captureManifestDigest, REAL_V2_PINS.manifestDigest, "the manifest identity is the pinned one");
    assertEqual(prepared.featureVersion, "external-intelligence-features-v2", "pinned to V2");
    assertEqual(prepared.items[0].inputDigest, digestOf(prepared.items[0].input), "inputDigest = digest of the final input");
  } finally {
    globalThis.fetch = realFetch;
  }
  assertEqual(networkCalls, 0, "no network call was made");
});

test("71. rate-limit metadata is bounded; unavailable fields are null; raw headers never persist", async () => {
  const now = () => NOW;
  assertDeepEqual(parseRateLimitMetadata({}, { now }), { retryAfterMs: null, rateLimitLimit: null, rateLimitRemaining: null, rateLimitPolicy: null }, "absent headers -> null");
  assertDeepEqual(
    parseRateLimitMetadata(new Headers({ "retry-after": "3", "x-ratelimit-limit": "20000", "x-ratelimit-remaining": "19999" }), { now }),
    { retryAfterMs: 3_000, rateLimitLimit: 20_000, rateLimitRemaining: 19_999, rateLimitPolicy: null },
    "legacy X-RateLimit-* headers are read",
  );
  assertEqual(parseRateLimitMetadata({ "ratelimit-limit": "lots" }, { now }).rateLimitLimit, null, "a malformed number is null");
  assertEqual(parseRateLimitMetadata({ "ratelimit-policy": "<script>alert(1)</script>" }, { now }).rateLimitPolicy, null, "a policy with unexpected characters is dropped");
  const run = JSON.parse(await readFile(path.join(ctx.saved.dir, "provider", "runs", "run-0001.json"), "utf8"));
  for (const attempt of run.attempts) assertDeepEqual(Object.keys(attempt).sort(), [...CLASSIFIER_ATTEMPT_FIELDS].sort(), "an attempt has exactly the whitelisted fields");
  assertEqual(run.attempts[0].rateLimitLimit, 3_000, "the saved attempt carries the parsed limit");
  assertTrue(!/set-cookie|x-request-id|server|content-type/i.test(JSON.stringify(run)), "no raw header name survived into the run record");
});

test("72. more than 1,000 eligible records fail closed (nothing is truncated)", async () => {
  assertEqual(CLASSIFIER_MAX_INPUTS_PER_REQUEST, 1_000, "the pinned request limit");
  const oversized = Array.from({ length: 1_001 }, (_, index) => `input ${index}`);
  await assertThrows(() => buildClassifyRequestBody({ inputs: oversized }), /1001 inputs exceed/, "the request builder refuses 1,001 inputs");
  buildClassifyRequestBody({ inputs: oversized.slice(0, 1_000) });
  const error = new ClassifierTooManyRecordsError(1_001);
  assertTrue(/silently truncating/.test(error.message), "the refusal explains that nothing is truncated");
  await assertThrows(() => makeProvider(scriptedFetch([okEntry()])).classify({ inputs: [] }), ClassifierRequestError, "an empty batch is refused");
  await assertThrows(() => makeProvider(scriptedFetch([okEntry()])).classify({ inputs: ["ok", ""] }), ClassifierRequestError, "an empty input is refused");
});

test("73. the CLI is explicit-only and refuses the disabled/unknown provider", async () => {
  const base = ["--capture", REAL_V2_CAPTURE_ID, "--classifier", CLASSIFIER_ID];
  const disabled = runCli(base);
  assertEqual(disabled.status, 1, "no provider -> refused");
  assertTrue(/DISABLED/.test(disabled.stderr), "with an explanation");
  assertEqual(runCli([...base, "--provider", "disabled"]).status, 1, "--provider disabled -> refused");
  const unknown = runCli([...base, "--provider", "mock"]);
  assertEqual(unknown.status, 1, "an unknown provider is refused with no fallback");
  assertTrue(/no fallback/.test(unknown.stderr), "and says there is no fallback");
  assertEqual(runCli(["--capture", REAL_V2_CAPTURE_ID, "--provider", "classifier-dev"]).status, 1, "a missing classifier is refused");
  assertEqual(runCli([...base, "--provider", "classifier-dev", "--instructions", "x"]).status, 1, "custom instructions are refused");
  assertEqual(runCli(["--stats", "--replay"]).status, 1, "--stats and --replay are exclusive");
  const help = runCli(["--help"]);
  assertEqual(help.status, 0, "--help works");
  assertTrue(/Smart tier|smart/i.test(help.stdout), "and documents that smart tier is refused");
});

test("74. the CLI stats/replay read a stored experiment offline", async () => {
  const stats = runCli(["--stats", "--experiment", ctx.saved.experiment.experimentId, "--out", ctx.outRoot, "--json"]);
  assertEqual(stats.status, 0, `stats exits 0 (${stats.stderr})`);
  const parsedStats = JSON.parse(stats.stdout);
  assertEqual(parsedStats.resultDigest, ctx.saved.experiment.resultDigest, "stats reports the stored digest");
  assertEqual(parsedStats.networkCalls, 0, "stats reports zero network calls");
  const replay = runCli(["--replay", "--experiment", ctx.saved.experiment.experimentId, "--out", ctx.outRoot, "--captures", ctx.captureRoot, "--json"]);
  assertEqual(replay.status, 0, `replay exits 0 (${replay.stderr})`);
  const parsedReplay = JSON.parse(replay.stdout);
  assertEqual(parsedReplay.ok, true, "replay integrity OK");
  assertEqual(parsedReplay.resultDigest, ctx.saved.experiment.resultDigest, "replay reproduces the digest");
  const missing = runCli(["--replay", "--experiment", "clexp-00000000T000000Z-deadbeef", "--out", ctx.outRoot, "--captures", ctx.captureRoot, "--json"]);
  assertEqual(missing.status, 1, "a missing experiment fails closed");
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
    console.error("could not build Phase 5G fixtures:", error?.stack ?? error);
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
  console.log("offline: no real classifier.dev request, no capture, no Agent-Reach / Jev / DeepSeek call, no Arena run, zero real delay.");
  if (skips.length > 0) {
    console.log(`skipped ${skips.length} optional case(s) whose evidence is absent here:`);
    for (const reason of skips) console.log(`  - ${reason}`);
  }
  console.log(`EVOLVE Phase 5G.0 classifier.dev frozen classification validation: ${passed}/${cases.length} checks passed`);

  if (failures.length > 0) {
    console.log("Failed checks:");
    for (const failure of failures) console.log(`  - ${failure.name}`);
    process.exitCode = 1;
  } else {
    console.log("All Phase 5G.0 checks passed. classifier.dev classifies ALREADY-FROZEN public observations through the");
    console.log("versioned /v1/classify endpoint on the FAST tier only, with a fixed taxonomy, a fixed instruction text and a");
    console.log("title+textExcerpt-only projection; validates the answer field by field; retries only transient failures with");
    console.log("bounded backoff; sends no credential; freezes a text-free, replayable artifact outside the capture; and STOPS —");
    console.log("routing nothing to Jev, DeepSeek, the Arena, evolution or trading.");
  }
}

run().catch((error) => {
  console.error("phase 5G validation runner crashed:", error);
  process.exitCode = 1;
});
