#!/usr/bin/env node
/**
 * EVOLVE Phase 5F.0 validation suite — EXTERNAL INTELLIGENCE → JEV SHADOW BRIDGE.
 *
 * Proves the explicit SHADOW experiment harness and nothing more:
 *
 *   frozen capture → offline replay → audited external-intelligence-packet-v1
 *     → bounded Jev projection (JEV_EXTERNAL_INTELLIGENCE_DECISION_PACKET, v1)
 *     → fixed jev-external-intelligence-v1 question set
 *     → ONE explicit Jev shadow call → immutable Jev experiment record → STOP
 *
 * It asserts the leakage barriers (raw records/text/URLs/credentials/captureAge/
 * deterministic evidenceQuality can never enter the Jev projection), the fixed
 * question set and vocabularies, cache/state identity, budget/timeout behaviour,
 * persistence into the EXISTING Jev experiment storage, and the behavioural
 * isolation guarantee (an `escalate_to_deep_research` shadow answer invokes
 * NOTHING: no DeepSeek, no Agent-Reach, no capture, no Arena, no routing).
 *
 * It also re-proves the identity barriers: the real V2 and legacy V1 captures
 * are byte-untouched and still replay to their pinned digests; Wave 1, Wave 2,
 * the six replication datasets and the frozen cohorts are byte-identical; and
 * the evaluation contract digest is unchanged.
 *
 * Fully OFFLINE and deterministic: no real Jev call, no injected provider other
 * than in-process stubs, no live capture, no network call, no upstream tool
 * executed, no DeepSeek call, no Arena run. No file under the repository's
 * `.evolve/` is ever written by this suite.
 *
 * Run with: npm run validate:phase5f
 */

import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { canonicalJson } from "./lib/hash.mjs";

import {
  CAPTURE_SCHEMA_VERSION,
  listCaptures,
  readCaptureManifest,
  runCapture,
  verifyCapture,
} from "./intelligence/capture.mjs";
import { resolveIntelligenceConfig } from "./intelligence/config.mjs";
import { INTELLIGENCE_FEATURE_VERSION_V2 } from "./intelligence/features.mjs";
import {
  DEEPSEEK_ROUTING_ACTIVE,
  EXTERNAL_INTELLIGENCE_DISPOSITIONS,
  JEV_ROUTING_ACTIVE,
  PacketAuditError,
  assertPacketAllowed,
  auditExternalIntelligencePacket,
  buildExternalIntelligencePacket,
  packetDigest,
} from "./intelligence/packet.mjs";
import { replayCapture, verifyReplayDeterminism } from "./intelligence/replay.mjs";

import {
  JEV_STATUS,
  NO_JEV_DECISION,
  REGISTERED_JEV_PROVIDERS,
  UnknownJevProviderError,
  requireJevProviderName,
  resolveJevConfig,
  resolveJevModelName,
} from "./jev/config.mjs";
import { createDisabledJevProvider, resolveJevProvider } from "./jev/provider.mjs";
import { createMockJevProvider } from "./jev/providers/mock-jev.mjs";
import { createTypeSafeJevProvider } from "./jev/providers/typesafe-jev.mjs";
import {
  VERCEL_JEV_DEFAULT_MODEL,
  VERCEL_JEV_PROVIDER,
  VERCEL_JEV_UPSTREAM_PROVIDER,
  createVercelJevProvider,
  fromEvaluationAnswers,
  toEvaluationQuestions,
} from "./jev/providers/vercel-jev.mjs";
import { JEV_DECISION_PACKET_VERSION, JEV_PACKET_KIND } from "./jev/decision-packet.mjs";
import {
  EXTERNAL_INTELLIGENCE_QUESTION_NAMES,
  EXTERNAL_EVIDENCE_QUALITY_LEVELS,
  ALLOWED_JEV_EXTERNAL_KEYS,
  FORBIDDEN_JEV_EXTERNAL_KEYS,
  JEV_EXTERNAL_FEATURE_KEYS,
  JEV_EXTERNAL_INTELLIGENCE_PACKET_KIND,
  JEV_EXTERNAL_INTELLIGENCE_PACKET_VERSION,
  JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_ID,
  JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_VERSION,
  PRIMARY_CONCERN_VOCAB,
  RESEARCH_DISPOSITION_VOCAB,
  assertExternalPacketProjectable,
  auditExternalIntelligenceJevPacket,
  buildExternalIntelligenceJevPacket,
  buildExternalIntelligenceQuestions,
  externalIntelligenceBridgeIdentity,
  externalIntelligenceComparators,
  runExternalIntelligenceShadowDecision,
} from "./jev-external-bridge.mjs";
import { jevStateDigestOf } from "./jev/decision-packet.mjs";
import { createJevRunBudget, jevCacheKey, listJevProviderRuns, normalizeAnswers, validateAnswers } from "./jev/runtime.mjs";
import { jevDecide } from "./jev/decide.mjs";
import { JEV_EXPERIMENTS_DIR, listJevDecisions, readJevExperiment } from "./jev/experiment.mjs";

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
const NOW = Date.parse("2026-09-19T10:00:00.000Z");

/* Pinned identities of the canonical real captures (infrastructure evidence only). */
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

/* Pinned frozen-cohort identities (Phase 5C.3). */
const FROZEN_COHORT_DIGESTS = Object.freeze({
  mock: "b26d63a2a0787e954ed7e4e63e668fe4664e58059508145345214facc4e12858",
  deepseek: "13c7c93d707b26f8b92042d488ff0a63f5de3f9f81b8145be4eac7a70cc550a8",
});

/** Unique raw markers planted in the fixture capture: they must NEVER reach Jev. */
const RAW_TEXT_MARKER = "RAWTEXTMARKERZZTOP";
const RAW_MINT_MARKER = "RAWMINTMARKERQQQQ";
const RAW_DOMAIN_MARKER = "rawmarker-domain.example";

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
function assertThrows(fn, matcher, message) {
  let thrown = null;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  if (thrown === null) fail(`${message} — nothing was thrown`);
  if (typeof matcher === "function") {
    if (!(thrown instanceof matcher) && thrown?.name !== matcher.name) {
      fail(`${message} — expected ${matcher.name}, got ${thrown?.name}: ${thrown?.message ?? thrown}`);
    }
  } else if (matcher instanceof RegExp) {
    if (!matcher.test(String(thrown?.message ?? thrown))) {
      fail(`${message} — thrown message ${JSON.stringify(String(thrown?.message ?? thrown))} does not match ${matcher}`);
    }
  }
  return thrown;
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
  captureRoot: null,
  jevBase: null,
  capture: null,
  externalPacket: null,
  jevPacket: null,
  realCaptureAvailable: false,
  evidenceAvailable: false,
  evidenceBaseline: {},
  bridgeSources: new Map(),
};

async function buildFixtures() {
  ctx.tmp = await mkdtemp(path.join(tmpdir(), "evolve-phase5f-"));
  ctx.captureRoot = path.join(ctx.tmp, "captures");
  ctx.jevBase = path.join(ctx.tmp, "jev", "experiments");
  await mkdir(ctx.captureRoot, { recursive: true });
  await mkdir(ctx.jevBase, { recursive: true });

  ctx.capture = await runCapture({
    root: ctx.captureRoot,
    config: resolveIntelligenceConfig({ EVOLVE_INTELLIGENCE_PROVIDER: "mock" }),
    candidates: [
      {
        symbol: RAW_TEXT_MARKER,
        name: "Phase 5F Fixture",
        mint: RAW_MINT_MARKER,
        domain: RAW_DOMAIN_MARKER,
        handle: "@rawmarker",
      },
    ],
    provider: "mock",
    now: NOW,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });

  const replay = await replayCapture({ root: ctx.captureRoot, captureId: ctx.capture.captureId, asOf: null });
  ctx.externalPacket = buildExternalIntelligencePacket({ replay });
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
  ctx.bridgeSources = await loadBridgeSources();
}

async function disposeFixtures() {
  if (ctx.tmp) await rm(ctx.tmp, { recursive: true, force: true });
}

async function loadBridgeSources() {
  const map = new Map();
  for (const file of ["scripts/jev-external-bridge.mjs", "scripts/jev-external.mjs"]) {
    map.set(file, await readFile(file, "utf8"));
  }
  return map;
}

/* ============================================================================
 * Static helpers
 * ==========================================================================*/

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

function importsOf(source) {
  const out = [];
  const re = /from\s+"([^"]+)"/g;
  let match;
  while ((match = re.exec(source)) !== null) out.push(match[1]);
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

/** Every file under a root, with its UTF-8 content, for leak checks. */
async function readAllFiles(root) {
  const out = [];
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
      else out.push({ path: path.relative(root, full), text: await readFile(full, "utf8") });
    }
  };
  await walk(root);
  return out;
}

/* ============================================================================
 * Stub providers
 * ==========================================================================*/

/** A spy provider that counts invocations and can be scripted. */
function spyProvider({ ok = true, answers = null, throwError = null } = {}) {
  const calls = [];
  return {
    name: "stub-spy-jev",
    model: "stub-model",
    offline: true,
    external: false,
    syntheticDecision: true,
    calls,
    async evaluate(args) {
      calls.push(args);
      if (throwError) throw throwError;
      if (!ok) return { ok: false, status: JEV_STATUS.HTTP_ERROR, reason: "stub failure" };
      return { ok: true, model: "stub-model", requestId: "stub-req", answers: answers ?? {}, usage: { input_tokens: 1, output_tokens: 1 } };
    },
  };
}

/** A stub provider whose ONLY fixed answer is `escalate_to_deep_research`. */
function escalationProvider() {
  return spyProvider({
    answers: {
      evidenceSufficiency: { type: "noul", noul: 0.08 },
      primaryConcern: {
        type: "choice",
        choice: "insufficient_sample",
        confidence: 0.82,
        probabilities: { insufficient_sample: 0.82 },
      },
      evidenceQuality: { type: "score", score: 0, confidence: 0.7, legend: {}, probabilities: { 0: 0.7 } },
      corroborationConfidence: { type: "noul", noul: 0.05 },
      researchDisposition: {
        type: "choice",
        choice: "escalate_to_deep_research",
        confidence: 0.91,
        probabilities: { escalate_to_deep_research: 0.91 },
      },
    },
  });
}

function mockExternalAnswers() {
  return {
    evidenceSufficiency: { type: "noul", noul: 0.3 },
    primaryConcern: {
      type: "choice",
      choice: "low_field_coverage",
      confidence: 0.6,
      probabilities: { low_field_coverage: 0.6 },
    },
    evidenceQuality: { type: "score", score: 2, confidence: 0.7, legend: {}, probabilities: { 2: 0.7 } },
    corroborationConfidence: { type: "noul", noul: 0.4 },
    researchDisposition: {
      type: "choice",
      choice: "observe",
      confidence: 0.6,
      probabilities: { observe: 0.6 },
    },
  };
}

/* ============================================================================
 * PART 1 — explicit packet kind/version, fixed question set, vocabularies
 * ==========================================================================*/

test("1. the new packet kind is explicit and distinct from candidate/market", () => {
  assertEqual(
    JEV_EXTERNAL_INTELLIGENCE_PACKET_KIND,
    "JEV_EXTERNAL_INTELLIGENCE_DECISION_PACKET",
    "the exact documented packet kind",
  );
  assertTrue(JEV_EXTERNAL_INTELLIGENCE_PACKET_KIND !== JEV_PACKET_KIND.CANDIDATE, "not the candidate kind");
  assertTrue(JEV_EXTERNAL_INTELLIGENCE_PACKET_KIND !== JEV_PACKET_KIND.MARKET, "not the market kind");
  assertEqual(ctx.jevPacket.packetKind, JEV_EXTERNAL_INTELLIGENCE_PACKET_KIND, "the built packet carries the new kind");
});

test("2. the external packet version is explicit, and the candidate/market packet version is NOT bumped", () => {
  assertEqual(JEV_EXTERNAL_INTELLIGENCE_PACKET_VERSION, 1, "the new packet version constant is 1");
  assertEqual(ctx.jevPacket.packetVersion, 1, "the built packet carries version 1");
  assertEqual(JEV_DECISION_PACKET_VERSION, 1, "the existing candidate/market packet version is unchanged");
});

test("3. the question-set id/version are pinned constants", () => {
  assertEqual(JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_ID, "jev-external-intelligence-v1", "the exact documented id");
  assertEqual(JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_VERSION, 1, "the question set starts at version 1");
  assertTrue(
    JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_ID !== "jev-question-set-v1",
    "it is NOT the candidate/TRAIN/Arena set",
  );
  assertTrue(JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_ID !== "jev-market-v1", "it is NOT the market-regime set");
});

test("4. the question set has exactly the five fixed questions with the documented types", () => {
  const questions = buildExternalIntelligenceQuestions();
  assertDeepEqual(
    Object.keys(questions),
    ["evidenceSufficiency", "primaryConcern", "evidenceQuality", "corroborationConfidence", "researchDisposition"],
    "the five fixed questions in fixed order",
  );
  assertDeepEqual([...EXTERNAL_INTELLIGENCE_QUESTION_NAMES], Object.keys(questions), "the exported name list matches");
  assertEqual(questions.evidenceSufficiency.type, "noul", "A: evidenceSufficiency is noul");
  assertEqual(questions.primaryConcern.type, "choice", "B: primaryConcern is choice");
  assertEqual(questions.evidenceQuality.type, "score", "C: evidenceQuality is score");
  assertEqual(questions.corroborationConfidence.type, "noul", "D: corroborationConfidence is noul");
  assertEqual(questions.researchDisposition.type, "choice", "E: researchDisposition is choice");
});

test("5. the question set is FIXED — repeated builds are byte-identical, nothing is generated dynamically", () => {
  assertDeepEqual(buildExternalIntelligenceQuestions(), buildExternalIntelligenceQuestions(), "stable question set");
});

test("6. primaryConcern vocabulary is exactly the documented six labels", () => {
  assertDeepEqual(
    [...PRIMARY_CONCERN_VOCAB].sort(),
    [
      "insufficient_sample",
      "source_concentration",
      "low_field_coverage",
      "coordination_pattern",
      "fetch_instability",
      "no_obvious_concern",
    ].sort(),
    "the exact six-label vocabulary",
  );
  assertDeepEqual(
    Object.keys(buildExternalIntelligenceQuestions().primaryConcern.criteria).sort(),
    [...PRIMARY_CONCERN_VOCAB].sort(),
    "the question criteria match the vocabulary exactly",
  );
  for (const [, description] of Object.entries(buildExternalIntelligenceQuestions().primaryConcern.criteria)) {
    assertTrue(typeof description === "string" && description.length > 0, "every concern has an explicit description");
  }
});

test("7. researchDisposition vocabulary is EXACTLY ignore / observe / escalate_to_deep_research", () => {
  assertDeepEqual([...RESEARCH_DISPOSITION_VOCAB], ["ignore", "observe", "escalate_to_deep_research"], "exact order/vocabulary");
  assertDeepEqual([...EXTERNAL_INTELLIGENCE_DISPOSITIONS], [...RESEARCH_DISPOSITION_VOCAB], "it reuses the existing future vocabulary");
  assertDeepEqual(
    Object.keys(buildExternalIntelligenceQuestions().researchDisposition.criteria),
    ["ignore", "observe", "escalate_to_deep_research"],
    "the question criteria are exactly that vocabulary",
  );
});

test("8. evidenceQuality is a five-level ordered 0..4 rubric, and the question does not leak the deterministic label", () => {
  assertEqual(EXTERNAL_EVIDENCE_QUALITY_LEVELS.length, 5, "exactly five levels");
  const question = buildExternalIntelligenceQuestions().evidenceQuality;
  assertEqual(question.criteria.length, 5, "the question carries five rubric entries");
  assertDeepEqual([...question.criteria], [...EXTERNAL_EVIDENCE_QUALITY_LEVELS], "the rubric is the documented one");
  const text = canonicalJson(question);
  assertTrue(!text.includes("WEAK"), "the question text never states the source packet's deterministic label");
});

/* ============================================================================
 * PART 2 — the projection whitelist and the leakage audit
 * ==========================================================================*/

test("9. the Jev projection has ONLY the allowed top-level keys", () => {
  for (const key of Object.keys(ctx.jevPacket)) {
    assertTrue(ALLOWED_JEV_EXTERNAL_KEYS.includes(key), `'${key}' is on the projection whitelist`);
  }
  assertEqual(ctx.jevPacket.packetKind, JEV_EXTERNAL_INTELLIGENCE_PACKET_KIND, "packetKind present");
  assertEqual(auditExternalIntelligenceJevPacket(ctx.jevPacket).ok, true, "the built packet passes its own audit");
});

test("10. the projection carries a bounded sourceCapture identity and counts", () => {
  assertEqual(ctx.jevPacket.sourceCapture.captureId, ctx.capture.captureId, "capture id is referenced");
  assertEqual(
    ctx.jevPacket.sourceCapture.packetDigest,
    ctx.externalPacket.packetDigest,
    "the SOURCE external packet digest is referenced",
  );
  assertEqual(
    ctx.jevPacket.sourceCapture.captureManifestDigest,
    ctx.externalPacket.captureManifestDigest,
    "the capture manifest digest is referenced",
  );
  assertEqual(ctx.jevPacket.sourceCapture.featureVersion, INTELLIGENCE_FEATURE_VERSION_V2, "the feature version is referenced");
  assertEqual(ctx.jevPacket.counts.records, ctx.externalPacket.counts.records, "record count is a bounded scalar");
  assertDeepEqual(Object.keys(ctx.jevPacket.counts).sort(), ["calls", "channels", "failures", "records", "timeouts"], "counts shape");
});

test("11. the projection carries the bounded feature vector and coordination indicator IDS only (never rules)", () => {
  assertDeepEqual(Object.keys(ctx.jevPacket.features), [...JEV_EXTERNAL_FEATURE_KEYS], "the exact feature whitelist, in order");
  assertEqual(
    ctx.jevPacket.features.coordinationIndicatorCount,
    ctx.externalPacket.features.coordinationIndicators.count,
    "the coordination indicator COUNT is carried",
  );
  assertDeepEqual(
    ctx.jevPacket.features.coordinationIndicatorIds,
    ctx.externalPacket.features.coordinationIndicators.indicators.map((row) => row.id),
    "only the bounded IDs are carried",
  );
  const serialized = canonicalJson(ctx.jevPacket);
  assertTrue(!serialized.includes("coordinationIndicators"), "the indicator block itself (with prose rules) is never carried");
  assertTrue(!/rule/i.test(serialized), "no prose `rule` string is carried");
});

test("12. an external packet that FAILS its own audit is refused BEFORE projection", () => {
  const tampered = { ...ctx.externalPacket, packetDigest: "deadbeef" };
  assertThrows(() => buildExternalIntelligenceJevPacket({ externalPacket: tampered }), PacketAuditError, "a broken digest is refused");
  const unknown = { ...ctx.externalPacket, notARealKey: 1 };
  assertThrows(() => buildExternalIntelligenceJevPacket({ externalPacket: unknown }), PacketAuditError, "an unknown key is refused");
});

test("13. a ROUTING-ACTIVE packet is refused", () => {
  for (const flag of ["jevRoutingActive", "deepseekRoutingActive"]) {
    const routingActive = {
      ...ctx.externalPacket,
      routing: { ...ctx.externalPacket.routing, [flag]: true },
    };
    routingActive.packetDigest = packetDigest(routingActive);
    assertThrows(
      () => buildExternalIntelligenceJevPacket({ externalPacket: routingActive }),
      PacketAuditError,
      `${flag} === true is refused`,
    );
  }
});

test("14. a non-shadow packet, a non-paper packet and a non-read-only packet are each refused", () => {
  for (const field of ["shadowOnly", "paperOnly", "readOnly"]) {
    const mutated = { ...ctx.externalPacket, [field]: false };
    mutated.packetDigest = packetDigest(mutated);
    assertTrue(assertPacketAllowed(mutated).packetDigest === mutated.packetDigest, "the external audit itself still passes");
    assertThrows(
      () => assertExternalPacketProjectable(mutated),
      PacketAuditError,
      `${field} === false is refused`,
    );
  }
});

test("15. raw records, raw text, URLs, author ids and repository names CANNOT enter the Jev packet", () => {
  // The fixture capture DOES contain raw content (text, URL, author, mint) —
  // that is exactly what the whitelist must strip.
  const rawText = ctx.capture.records.map((record) => record.textExcerpt ?? "").join("\n");
  assertTrue(rawText.includes(RAW_TEXT_MARKER), "the frozen capture really does carry the raw text marker");
  assertTrue(ctx.capture.records.some((record) => String(record.canonicalUrl ?? "").startsWith("https://")), "and a raw URL");
  assertTrue(ctx.capture.records.some((record) => typeof record.authorId === "string"), "and a raw author id");

  // 1. The projection of that capture carries NONE of it.
  const serialized = canonicalJson(ctx.jevPacket);
  for (const forbidden of [
    RAW_TEXT_MARKER,
    RAW_MINT_MARKER,
    RAW_DOMAIN_MARKER,
    "https://",
    "http://",
    "fixture-author-",
    "example.test",
    "canonicalUrl",
    "textExcerpt",
    "authorId",
    "rule",
  ]) {
    assertTrue(!serialized.includes(forbidden), `the projection never contains '${forbidden}'`);
  }
  // `counts.records` is a bounded scalar count, never an array of records.
  assertTrue(Array.isArray(ctx.jevPacket.counts.records) === false, "counts.records is a scalar, never a record array");

  // 2. A packet that tries to smuggle raw content under an innocuous nested
  //    name still cannot reach Jev: the feature whitelist drops the whole block.
  const smuggled = { ...ctx.externalPacket };
  smuggled.features = {
    ...smuggled.features,
    extraRawBlock: {
      note: RAW_TEXT_MARKER,
      link: "https://github.com/raw/repo",
      authorId: "raw-author-id",
      rule: "duplicateTextRatio >= 0.5",
    },
  };
  smuggled.packetDigest = packetDigest(smuggled);
  assertEqual(assertPacketAllowed(smuggled) === smuggled, true, "the smuggled packet still passes the EXTERNAL audit (nested unknown keys are allowed)");
  const projected = buildExternalIntelligenceJevPacket({ externalPacket: smuggled });
  const projectedText = canonicalJson(projected);
  for (const forbidden of [RAW_TEXT_MARKER, "https://", "raw-author-id", "extraRawBlock", "duplicateTextRatio >= 0.5"]) {
    assertTrue(!projectedText.includes(forbidden), `the projection drops the smuggled '${forbidden}'`);
  }

  // 3. A packet carrying a FORBIDDEN top-level key is refused before projection.
  assertThrows(
    () =>
      buildExternalIntelligenceJevPacket({
        externalPacket: { ...ctx.externalPacket, records: [{ textExcerpt: RAW_TEXT_MARKER }] },
      }),
    PacketAuditError,
    "a packet carrying raw records is refused by the mandatory external audit",
  );
});

test("16. the audit FLAGS every forbidden key and URL/credential-shaped value when injected directly", () => {
  for (const key of ["records", "textExcerpt", "canonicalUrl", "authorId", "repository", "credential", "apiKey", "captureAgeMs", "evidenceQuality"]) {
    const audit = auditExternalIntelligenceJevPacket({ ...ctx.jevPacket, [key]: "leak" });
    assertTrue(audit.ok === false, `'${key}' is flagged as a leakage violation`);
  }
  assertTrue(auditExternalIntelligenceJevPacket({ ...ctx.jevPacket, extra: "x" }).unknownKeys.includes("extra"), "an unknown key is flagged");
  assertTrue(
    auditExternalIntelligenceJevPacket({ ...ctx.jevPacket, limitations: ["see https://leak.example/x"] }).forbiddenValues.some((row) => row.detail === "url"),
    "a URL in a string value is flagged",
  );
  assertTrue(
    auditExternalIntelligenceJevPacket({ ...ctx.jevPacket, limitations: ["bearer sk-abcdefghijklmnopqrstuvwx"] }).ok === false,
    "a bearer/api-key-shaped value is flagged",
  );
  assertTrue(
    auditExternalIntelligenceJevPacket({ ...ctx.jevPacket, sourceCapture: { ...ctx.jevPacket.sourceCapture, private_key: "x" } }).ok === false,
    "a credential-shaped KEY name is flagged",
  );
  for (const key of FORBIDDEN_JEV_EXTERNAL_KEYS.slice(0, 20)) {
    assertTrue(auditExternalIntelligenceJevPacket({ [key]: "leak" }).ok === false, `forbidden key '${key}' is rejected`);
  }
});

test("17. captureAgeMs is EXCLUDED from the Jev projection and from the Jev state", () => {
  const serialized = canonicalJson(ctx.jevPacket);
  assertTrue(!serialized.includes("captureAgeMs"), "captureAgeMs never appears in the projection");
  assertTrue(!serialized.includes("captureAgeMs"), "and therefore never enters the state digest");
});

test("18. the deterministic evidenceQuality label is WITHHELD from the Jev state", () => {
  assertTrue(!("evidenceQuality" in ctx.jevPacket), "no top-level evidenceQuality field");
  assertTrue(!("evidenceQuality" in (ctx.jevPacket.features ?? {})), "no evidenceQuality in features");
  assertTrue(!("evidenceQuality" in (ctx.jevPacket.sourceCapture ?? {})), "no evidenceQuality in sourceCapture");
  const state = canonicalJson(ctx.jevPacket);
  assertTrue(!state.includes("evidenceQuality"), "the deterministic label is absent from the whole Jev state");
  assertTrue(!state.includes(ctx.externalPacket.evidenceQuality), "the label VALUE is absent too");
});

test("19. the deterministic evidenceQuality IS allowed as post-build comparator metadata", () => {
  const comparators = externalIntelligenceComparators(ctx.externalPacket);
  assertEqual(comparators.externalEvidenceQuality, ctx.externalPacket.evidenceQuality, "the label is recorded as a comparator");
  assertTrue(typeof comparators.externalEvidenceQuality === "string", "the comparator is the deterministic string label");
  assertEqual(comparators.recordCount, ctx.externalPacket.counts.records, "recordCount comparator");
  assertEqual(comparators.coordinationIndicatorCount, ctx.externalPacket.features.coordinationIndicators.count, "coordination comparator");
  assertEqual(comparators.sourceCount, ctx.externalPacket.features.sourceCount, "sourceCount comparator");
  assertEqual(comparators.queryCoverage, ctx.externalPacket.features.queryCoverage, "queryCoverage comparator");
  assertEqual(comparators.fetchFailureRate, ctx.externalPacket.features.fetchFailureRate, "fetchFailureRate comparator");
});

test("20. the projection bridge identity is explicit and digest-stable", () => {
  const identity = externalIntelligenceBridgeIdentity();
  assertEqual(identity.packetKind, JEV_EXTERNAL_INTELLIGENCE_PACKET_KIND, "identity names the packet kind");
  assertEqual(identity.questionSetId, JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_ID, "identity names the question set");
  assertEqual(identity.packetVersion, JEV_EXTERNAL_INTELLIGENCE_PACKET_VERSION, "identity names the packet version");
  assertEqual(identity.digest.length, 64, "the identity digest is a SHA-256 hex string");
  assertDeepEqual(externalIntelligenceBridgeIdentity(), identity, "the identity is deterministic");
});

/* ============================================================================
 * PART 3 — provider reuse (fail-closed selection, unchanged adapters)
 * ==========================================================================*/

test("21. the registered provider set is unchanged, and disabled is the fail-closed default", () => {
  assertDeepEqual([...REGISTERED_JEV_PROVIDERS], ["mock-jev", "typesafe-jev", "vercel-jev"], "same three providers");
  const config = resolveJevConfig({});
  assertEqual(config.provider, null, "unset resolves to no provider");
  assertEqual(config.enabled, false, "disabled by default");
  assertEqual(config.configError, null, "unset is not a configuration error");
  assertEqual(requireJevProviderName("").provider, null, "empty resolves to the disabled provider");
});

test("22. an unknown provider name FAILS CLOSED (never mock, never silently disabled)", async () => {
  assertThrows(() => resolveJevProvider("nope-jev", {}), UnknownJevProviderError, "an unregistered name throws");
  const config = resolveJevConfig({ EVOLVE_JEV_PROVIDER: "nope-jev" });
  assertEqual(config.provider, null, "no provider resolved");
  assertEqual(config.enabled, false, "never enabled on a typo");
  assertTrue(typeof config.configError === "string" && config.configError.length > 0, "a configuration error is reported");
});

test("23. the disabled provider through `jevDecide` records JEV_DISABLED / NO_JEV_DECISION and calls nothing", async () => {
  const budget = createJevRunBudget(1);
  const { run, decision } = await jevDecide({
    provider: createDisabledJevProvider(),
    packet: ctx.jevPacket,
    questions: buildExternalIntelligenceQuestions(),
    questionSetId: JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_ID,
    questionSetVersion: JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_VERSION,
    decisionPacketVersion: JEV_EXTERNAL_INTELLIGENCE_PACKET_VERSION,
    root: null,
    budget,
  });
  assertEqual(run.status, JEV_STATUS.DISABLED, "disabled status");
  assertEqual(decision, NO_JEV_DECISION, "no decision fabricated");
  assertEqual(budget.used, 0, "disabled consumes no budget");
});

test("24. mock answer normalization works for all five external questions", async () => {
  const provider = createMockJevProvider();
  const result = await provider.evaluate({ state: ctx.jevPacket, questions: buildExternalIntelligenceQuestions() });
  assertEqual(result.ok, true, "the mock succeeds");
  assertEqual(result.syntheticDecision, true, "the mock marks the decision synthetic");
  const normalized = normalizeAnswers(result.answers);
  const validated = validateAnswers(normalized, [...EXTERNAL_INTELLIGENCE_QUESTION_NAMES]);
  assertEqual(validated.ok, true, `every external answer normalizes and validates (${validated.reason})`);
  assertTrue(PRIMARY_CONCERN_VOCAB.includes(normalized.primaryConcern.choice), "primaryConcern is in vocabulary");
  assertTrue(RESEARCH_DISPOSITION_VOCAB.includes(normalized.researchDisposition.choice), "researchDisposition is in vocabulary");
  assertTrue(normalized.evidenceQuality.score >= 0 && normalized.evidenceQuality.score <= 4, "evidenceQuality is on the 0..4 scale");
});

test("25. the mock provider's candidate and market branches are UNCHANGED", async () => {
  const provider = createMockJevProvider();
  const candidate = await provider.evaluate({
    state: {
      packetVersion: 1,
      packetKind: JEV_PACKET_KIND.CANDIDATE,
      train: { tradeCount: 25, mintDiversity: 5, concentration: 0.4, drawdown: 0.25, regimeComposition: { "strong-risk-on": 3 } },
      watchdogEvidence: { verdict: "NORMAL", findings: [] },
    },
    questions: { gateFailureRisk: { type: "noul" }, primaryRisk: { type: "choice" }, evidenceQuality: { type: "score" }, generalizationConfidence: { type: "noul" }, researchDisposition: { type: "choice" } },
  });
  assertDeepEqual(
    Object.keys(candidate.answers).sort(),
    ["evidenceQuality", "gateFailureRisk", "generalizationConfidence", "primaryRisk", "researchDisposition"],
    "the candidate branch still returns the candidate answer names",
  );
  const market = await provider.evaluate({ state: { marketFeatures: { meanReturn: 0.03 } }, questions: { regime: { type: "choice" } } });
  assertDeepEqual(Object.keys(market.answers), ["regime"], "the market branch still returns the regime answer");
});

test("26. the typesafe provider adapter is unchanged (documented endpoint, Bearer auth, pinned model)", async () => {
  let seenUrl = null;
  let seenAuth = null;
  let seenModel = null;
  const fetchImpl = async (url, init) => {
    seenUrl = url;
    seenAuth = init.headers.Authorization;
    seenModel = JSON.parse(init.body).model;
    return new Response(JSON.stringify({ model: seenModel, answers: mockExternalAnswers() }), {
      status: 200,
      headers: { "content-type": "application/json", "x-typesafe-request-id": "req-5f" },
    });
  };
  const provider = createTypeSafeJevProvider({ apiKey: "sk-test-key-0000000000", model: "jev-1.13.0", fetchImpl });
  const result = await provider.evaluate({ state: ctx.jevPacket, questions: buildExternalIntelligenceQuestions() });
  assertEqual(seenUrl, "https://api.typesafe.ai/v1/systemone", "the documented endpoint is still used");
  assertEqual(seenAuth, "Bearer sk-test-key-0000000000", "Bearer auth is still used");
  assertEqual(seenModel, "jev-1.13.0", "the pinned model id is still sent");
  assertEqual(result.ok, true, "the call succeeds");
  assertEqual(result.requestId, "req-5f", "the request id is still captured");
});

test("27. the vercel provider adapter is unchanged and carries the external question set through", async () => {
  assertEqual(VERCEL_JEV_PROVIDER, "vercel-jev", "provider name unchanged");
  assertEqual(VERCEL_JEV_UPSTREAM_PROVIDER, "typesafe-ai", "upstream provider unchanged");
  assertEqual(VERCEL_JEV_DEFAULT_MODEL, "typesafe-ai/jev", "canonical model unchanged");
  const questions = buildExternalIntelligenceQuestions();
  const mapped = toEvaluationQuestions(questions);
  assertEqual(mapped.evidenceSufficiency.type, "boolean", "noul maps to the AI SDK boolean type");
  assertEqual(mapped.primaryConcern.type, "choice", "choice is structurally identical");
  assertEqual(mapped.evidenceQuality.type, "score", "score is structurally identical");
  assertDeepEqual([...mapped.evidenceQuality.criteria], [...EXTERNAL_EVIDENCE_QUALITY_LEVELS], "score criteria survive conversion");

  const evaluateImpl = async ({ questions: sent, model }) => {
    assertDeepEqual(Object.keys(sent), [...EXTERNAL_INTELLIGENCE_QUESTION_NAMES], "every question is sent to the gateway");
    return {
      model,
      answers: {
        evidenceSufficiency: { type: "boolean", probability: 0.4 },
        primaryConcern: { type: "choice", choice: "observe", probabilities: { observe: 0.6, ignore: 0.2 } },
        evidenceQuality: { type: "score", score: 2, probabilities: { 2: 0.7, 1: 0.2 } },
        corroborationConfidence: { type: "boolean", probability: 0.3 },
        researchDisposition: { type: "choice", choice: "observe", probabilities: { observe: 0.5 } },
      },
      usage: { inputTokens: 3, outputTokens: 3 },
    };
  };
  const provider = createVercelJevProvider({ gatewayApiKey: "gw-key-000000000000", evaluateImpl });
  const result = await provider.evaluate({ state: ctx.jevPacket, questions });
  assertEqual(result.ok, true, "the gateway call succeeds");
  const converted = fromEvaluationAnswers(
    {
      evidenceSufficiency: { type: "boolean", probability: 0.4 },
      primaryConcern: { type: "choice", choice: "observe", probabilities: { observe: 0.6 } },
      evidenceQuality: { type: "score", score: 2, probabilities: { 2: 0.7 } },
      corroborationConfidence: { type: "boolean", probability: 0.3 },
      researchDisposition: { type: "choice", choice: "observe", probabilities: { observe: 0.5 } },
    },
    questions,
  );
  const validated = validateAnswers(normalizeAnswers(converted), [...EXTERNAL_INTELLIGENCE_QUESTION_NAMES]);
  assertEqual(validated.ok, true, `the gateway answers normalize and validate (${validated.reason})`);
});

test("28. the typesafe timeout classification is preserved", async () => {
  const fetchImpl = (url, init) =>
    new Promise((resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      setTimeout(() => resolve(new Response("{}", { status: 200 })), 5_000);
    });
  const provider = createTypeSafeJevProvider({ apiKey: "sk-x", model: "jev-1.13.0", timeoutMs: 40, fetchImpl });
  const started = Date.now();
  const result = await provider.evaluate({ state: ctx.jevPacket, questions: buildExternalIntelligenceQuestions() });
  assertEqual(result.status, JEV_STATUS.TIMEOUT, "a slow response classifies as JEV_TIMEOUT");
  assertTrue(Date.now() - started < 3_000, "the call returns promptly instead of waiting out the stub");
});

test("29. resolveJevModelName keeps each provider's own canonical default", () => {
  const config = resolveJevConfig({});
  assertEqual(resolveJevModelName(config, { provider: "vercel-jev" }), "typesafe-ai/jev", "vercel default");
  assertEqual(resolveJevModelName(config, { provider: "typesafe-jev" }), "jev-1.13.0", "typesafe default");
  assertEqual(resolveJevModelName(config, { provider: "vercel-jev", override: "custom" }), "custom", "an explicit override wins");
});

/* ============================================================================
 * PART 4 — budget, cache identity, state identity
 * ==========================================================================*/

test("30. the budget is checked BEFORE the provider is invoked", async () => {
  const provider = spyProvider({ answers: mockExternalAnswers() });
  const budget = createJevRunBudget(1);
  budget.consume();
  const { run, decision } = await jevDecide({
    provider,
    packet: ctx.jevPacket,
    questions: buildExternalIntelligenceQuestions(),
    questionSetId: JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_ID,
    questionSetVersion: JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_VERSION,
    decisionPacketVersion: JEV_EXTERNAL_INTELLIGENCE_PACKET_VERSION,
    root: null,
    budget,
  });
  assertEqual(run.status, JEV_STATUS.BUDGET_EXCEEDED, "an exhausted budget is an explicit status");
  assertEqual(decision, NO_JEV_DECISION, "no decision is fabricated");
  assertEqual(provider.calls.length, 0, "the provider was never called");
});

test("31. one live call consumes exactly one budget slot", async () => {
  const provider = spyProvider({ answers: mockExternalAnswers() });
  const budget = createJevRunBudget(3);
  const { run } = await jevDecide({
    provider,
    packet: ctx.jevPacket,
    questions: buildExternalIntelligenceQuestions(),
    questionSetId: JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_ID,
    questionSetVersion: JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_VERSION,
    decisionPacketVersion: JEV_EXTERNAL_INTELLIGENCE_PACKET_VERSION,
    root: null,
    budget,
  });
  assertEqual(run.status, JEV_STATUS.OK, "the call succeeds");
  assertEqual(provider.calls.length, 1, "exactly one provider call");
  assertEqual(budget.used, 1, "exactly one budget slot consumed");
  assertEqual(budget.remaining, 2, "two slots remain");
});

test("32. cache identity includes the new packet version AND the question-set identity", () => {
  const base = {
    provider: "stub-spy-jev",
    model: "stub-model",
    decisionPacketVersion: JEV_EXTERNAL_INTELLIGENCE_PACKET_VERSION,
    questionSetId: JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_ID,
    questionSetVersion: JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_VERSION,
    stateDigest: "sd",
    questionDigest: "qd",
  };
  const baseline = jevCacheKey(base);
  assertTrue(jevCacheKey({ ...base, decisionPacketVersion: 2 }) !== baseline, "a different packet version changes the key");
  assertTrue(jevCacheKey({ ...base, questionSetId: "jev-question-set-v1" }) !== baseline, "a different question set changes the key");
  assertTrue(jevCacheKey({ ...base, questionSetVersion: 2 }) !== baseline, "a different question-set version changes the key");
  assertTrue(jevCacheKey({ ...base, stateDigest: "other" }) !== baseline, "a different state digest changes the key");
  assertTrue(jevCacheKey({ ...base, questionDigest: "other" }) !== baseline, "a different question digest changes the key");
});

test("33. the same capture + packet + questions produce a stable state digest", () => {
  const first = buildExternalIntelligenceJevPacket({ externalPacket: ctx.externalPacket });
  const second = buildExternalIntelligenceJevPacket({ externalPacket: ctx.externalPacket });
  assertEqual(jevStateDigestOf(first), jevStateDigestOf(second), "the state digest is stable");
  assertDeepEqual(first, second, "the projection is byte-identical");
});

test("34. a different capture produces a different state digest (no cache aliasing)", async () => {
  const secondCapture = await runCapture({
    root: ctx.captureRoot,
    config: resolveIntelligenceConfig({ EVOLVE_INTELLIGENCE_PROVIDER: "mock" }),
    candidates: [{ symbol: "OTHERMARKER", name: "Other", mint: "OtherMint11111111111111111111111111111111111" }],
    provider: "mock",
    now: NOW + 60_000,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  const replay = await replayCapture({ root: ctx.captureRoot, captureId: secondCapture.captureId, asOf: null });
  const otherPacket = buildExternalIntelligenceJevPacket({ externalPacket: buildExternalIntelligencePacket({ replay }) });
  assertTrue(jevStateDigestOf(otherPacket) !== jevStateDigestOf(ctx.jevPacket), "a different capture digests differently");
});

/* ============================================================================
 * PART 5 — persistence, decision identity, no raw duplication
 * ==========================================================================*/

test("35. a shadow decision persists into the EXISTING Jev experiment storage", async () => {
  const result = await runExternalIntelligenceShadowDecision({
    externalPacket: ctx.externalPacket,
    provider: createMockJevProvider(),
    budget: createJevRunBudget(1),
    cacheEnabled: true,
    persist: true,
    experimentRootBase: ctx.jevBase,
    now: () => NOW,
  });
  assertEqual(result.run.status, JEV_STATUS.OK, "the mock decision succeeds");
  assertTrue(typeof result.experimentId === "string" && result.experimentId.startsWith("jexp-"), "a normal Jev experiment id");
  assertEqual(result.root, path.join(ctx.jevBase, result.experimentId), "the root is under the standard experiments dir");
  const experiment = await readJevExperiment(result.root);
  assertTrue(experiment !== null, "experiment.json exists");
  assertEqual(experiment.decisionPacketVersion, JEV_EXTERNAL_INTELLIGENCE_PACKET_VERSION, "the experiment records the packet version");
  assertEqual(experiment.questionSetId, JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_ID, "the experiment records the question set");
  const runs = await listJevProviderRuns(result.root);
  assertEqual(runs.length, 1, "exactly one provider run was persisted");
  assertEqual(runs[0].status, JEV_STATUS.OK, "the run status is recorded");
  const decisions = await listJevDecisions(result.root);
  assertEqual(decisions.length, 1, "exactly one immutable decision was persisted");
});

test("36. the decision references the source packet digest, and its identity is the new packet kind + question set", async () => {
  const result = await runExternalIntelligenceShadowDecision({
    externalPacket: ctx.externalPacket,
    provider: createMockJevProvider(),
    budget: createJevRunBudget(1),
    cacheEnabled: false,
    persist: true,
    experimentRootBase: ctx.jevBase,
    now: () => NOW,
    salt: "decision-identity",
  });
  const decision = result.decisionRecord;
  assertEqual(decision.packetKind, JEV_EXTERNAL_INTELLIGENCE_PACKET_KIND, "the decision records the new packet kind");
  assertEqual(decision.subjectDigest, ctx.externalPacket.packetDigest, "the subject digest IS the source external packet digest");
  assertEqual(decision.questionSetId, JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_ID, "the decision records the question set");
  assertEqual(decision.decisionPacketVersion, JEV_EXTERNAL_INTELLIGENCE_PACKET_VERSION, "the decision records the packet version");
  assertEqual(decision.immutable, true, "the decision is immutable");
  assertDeepEqual(
    Object.keys(decision.deterministicComparators).sort(),
    ["coordinationIndicatorCount", "externalEvidenceQuality", "fetchFailureRate", "queryCoverage", "recordCount", "sourceCount"],
    "exactly the six comparator fields are recorded",
  );
  assertEqual(
    decision.deterministicComparators.externalEvidenceQuality,
    ctx.externalPacket.evidenceQuality,
    "the deterministic evidenceQuality is recorded as a comparator",
  );
  assertTrue(
    decision.decisionId === result.run.jevRunId ? false : true,
    "the decision id is derived from kind + subject + question set, not copied from the run",
  );
});

test("37. NO raw intelligence is duplicated into Jev storage", async () => {
  const result = await runExternalIntelligenceShadowDecision({
    externalPacket: ctx.externalPacket,
    provider: createMockJevProvider(),
    budget: createJevRunBudget(1),
    cacheEnabled: true,
    persist: true,
    experimentRootBase: ctx.jevBase,
    now: () => NOW,
    salt: "no-raw-duplication",
  });
  const files = await readAllFiles(result.root);
  assertTrue(files.length > 0, "the experiment root is not empty");
  assertEqual(files.some((file) => file.path.endsWith(".ndjson")), false, "no capture ndjson was copied into Jev storage");
  for (const file of files) {
    assertTrue(!file.text.includes(RAW_TEXT_MARKER), `${file.path} must not contain raw text`);
    assertTrue(!file.text.includes(RAW_MINT_MARKER), `${file.path} must not contain a raw mint`);
    assertTrue(!file.text.includes(RAW_DOMAIN_MARKER), `${file.path} must not contain a raw domain`);
    assertTrue(!file.text.includes("https://example.test"), `${file.path} must not contain a raw URL`);
    assertTrue(!file.text.includes("fixture-author-"), `${file.path} must not contain a raw author id`);
  }
});

test("38. a second identical run is a cache hit with zero additional provider calls", async () => {
  const provider = spyProvider({ answers: mockExternalAnswers() });
  const base = {
    externalPacket: ctx.externalPacket,
    provider,
    budget: createJevRunBudget(5),
    cacheEnabled: true,
    persist: true,
    experimentRootBase: ctx.jevBase,
    now: () => NOW,
    salt: "cache-hit",
  };
  const first = await runExternalIntelligenceShadowDecision(base);
  assertEqual(first.run.cacheHit, false, "the first run is live");
  assertEqual(provider.calls.length, 1, "one live call");
  const second = await runExternalIntelligenceShadowDecision(base);
  assertEqual(second.run.cacheHit, true, "the second identical run is a cache hit");
  assertEqual(provider.calls.length, 1, "no additional provider call");
  assertEqual(second.stateDigest, first.stateDigest, "the state identity is identical");
  assertEqual(second.run.cacheKey, first.run.cacheKey, "the cache identity is identical");
});

/* ============================================================================
 * PART 6 — the strong behavioural isolation test
 * ==========================================================================*/

test("39. an `escalate_to_deep_research` shadow answer invokes NOTHING", async () => {
  const provider = escalationProvider();
  const before = await metadataSnapshot(path.join(REPO, ".evolve"));

  const result = await runExternalIntelligenceShadowDecision({
    externalPacket: ctx.externalPacket,
    provider,
    budget: createJevRunBudget(1),
    cacheEnabled: false,
    persist: true,
    experimentRootBase: ctx.jevBase,
    now: () => NOW,
    salt: "escalation-isolation",
  });

  // The answer is recorded verbatim...
  assertEqual(result.run.status, JEV_STATUS.OK, "the decision succeeded");
  assertEqual(
    result.decision.researchDisposition.choice,
    "escalate_to_deep_research",
    "the shadow answer IS escalate_to_deep_research",
  );
  assertEqual(result.decisionRecord.answers.researchDisposition.choice, "escalate_to_deep_research", "and it is persisted");
  // ...but it is only a recorded hypothetical.
  assertEqual(provider.calls.length, 1, "exactly one provider call (the shadow call itself)");
  assertEqual(result.decisionRecord.deterministicComparators.externalEvidenceQuality, ctx.externalPacket.evidenceQuality, "comparators recorded");
  assertEqual(result.decisionRecord.status, JEV_STATUS.OK, "status recorded");
  assertEqual(JEV_ROUTING_ACTIVE, false, "JEV_ROUTING_ACTIVE is still false");
  assertEqual(DEEPSEEK_ROUTING_ACTIVE, false, "DEEPSEEK_ROUTING_ACTIVE is still false");

  // Zero filesystem mutations outside the temp Jev experiment root.
  const after = await metadataSnapshot(path.join(REPO, ".evolve"));
  assertDeepEqual(after, before, "no repository `.evolve` artifact changed while the escalation decision ran");

  // The temp base holds ONLY the new experiment directory.
  const entries = (await readdir(ctx.jevBase, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  assertEqual(entries.some((entry) => entry.name === result.experimentId), true, "the new experiment exists in the temp base");
});

test("40. no Agent-Reach, research, Arena or DeepSeek code is reachable from the bridge or the CLI", async () => {
  const bridge = ctx.bridgeSources.get("scripts/jev-external-bridge.mjs");
  const cli = ctx.bridgeSources.get("scripts/jev-external.mjs");
  assertTrue(typeof bridge === "string" && typeof cli === "string", "both source files were loaded");

  for (const [file, source] of [["jev-external-bridge.mjs", bridge], ["jev-external.mjs", cli]]) {
    const imports = importsOf(source);
    for (const forbidden of [/\/arena\//, /\/research\//, /agent-reach/, /deepseek/i, /child_process/]) {
      assertEqual(
        imports.some((specifier) => forbidden.test(specifier)),
        false,
        `${file} imports nothing matching ${forbidden}`,
      );
    }
    assertTrue(!/\bexecFileSync\b|\bspawnSync\b|\bspawn\s*\(|\bexecSync\b/.test(source), `${file} spawns no process`);
    assertTrue(!/deepseek\.com|api\.deepseek|EVOLVE_DEEPSEEK/i.test(source), `${file} names no DeepSeek endpoint or key`);
    assertTrue(!/EVOLVE_RESEARCH_PROVIDER/.test(source), `${file} never selects a research provider`);
  }
  assertEqual(/runCapture|probeReach|resolveReachBinary|executeReach/.test(cli), false, "the CLI can never take a capture or probe Agent-Reach");
  assertEqual(/from\s+"[^"]*intelligence\/provider/.test(cli), false, "the CLI reaches no intelligence provider");
});

test("41. the bridge and CLI contain no trading, signing, wallet or execution path", async () => {
  const forbiddenParts = [
    ["send", "Transaction"],
    ["sign", "Transaction"],
    ["private", "Key"],
    ["secret", "Key"],
    ["seed", "Phrase"],
    ["mnemo", "nic"],
    ["Key", "pair"],
    ["wallet", "-adapter"],
    ["@solana/", "web3.js"],
    ["new ", "Connection", "\\("],
    ["exec", "Sync"],
    ["child_", "process"],
  ];
  const patterns = forbiddenParts.map((parts) => new RegExp(parts.join(""), "i"));
  for (const [, source] of ctx.bridgeSources) {
    for (const pattern of patterns) assertTrue(!pattern.test(source), `the bridge/CLI must not contain ${pattern}`);
    assertTrue(/PAPER ONLY/i.test(source), "the source states the paper-only guarantee");
  }
});

/* ============================================================================
 * PART 7 — no live capture / no new subprocess / routing constants
 * ==========================================================================*/

test("42. no new live capture was taken, and the suite's own capture is synthetic", async () => {
  assertEqual(ctx.capture.manifest.provider, "mock", "the fixture capture used the offline mock provider");
  assertEqual(ctx.capture.manifest.providerDeterministic, true, "the mock provider is deterministic");
  assertEqual(ctx.capture.manifest.syntheticIntelligence, true, "the fixture capture is clearly synthetic");
  assertTrue(ctx.capture.manifest.provider !== "agent-reach", "no Agent-Reach capture was taken");
  assertEqual(ctx.capture.manifest.captureSchemaVersion, CAPTURE_SCHEMA_VERSION, "the capture is schema 2");
  const captures = await listCaptures(ctx.captureRoot);
  assertEqual(captures.length, 2, "exactly the two fixture captures exist in the temp root");
  const integrity = await verifyCapture(ctx.captureRoot, ctx.capture.captureId);
  assertEqual(integrity.ok, true, "the fixture capture verifies against its own manifest");
});

test("43. the routing constants and the external packet's routing block remain false", () => {
  assertEqual(JEV_ROUTING_ACTIVE, false, "JEV_ROUTING_ACTIVE === false");
  assertEqual(DEEPSEEK_ROUTING_ACTIVE, false, "DEEPSEEK_ROUTING_ACTIVE === false");
  assertEqual(ctx.externalPacket.routing.jevRoutingActive, false, "the external packet says Jev routing is inactive");
  assertEqual(ctx.externalPacket.routing.deepseekRoutingActive, false, "the external packet says DeepSeek routing is inactive");
  assertEqual(ctx.externalPacket.routing.disposition, null, "no disposition was routed");
  assertEqual(ctx.externalPacket.shadowOnly, true, "the packet is shadow only");
  assertEqual(ctx.externalPacket.paperOnly, true, "the packet is paper only");
  assertEqual(ctx.externalPacket.readOnly, true, "the packet is read only");
});

test("44. a replay performs no network call and the audit agrees", async () => {
  const replay = await replayCapture({ root: ctx.captureRoot, captureId: ctx.capture.captureId, asOf: null });
  assertEqual(replay.networkCalls, 0, "replay reports zero network calls");
  assertEqual(replay.live, false, "replay is not live");
  const audit = auditExternalIntelligencePacket(ctx.externalPacket);
  assertEqual(audit.ok, true, "the external packet audit passes");
  assertEqual(audit.digestOk, true, "the packet digest is self-consistent");
  assertEqual(audit.routingActive, false, "no routing is active");
  const determinism = await verifyReplayDeterminism({ root: ctx.captureRoot, captureId: ctx.capture.captureId });
  assertEqual(determinism.ok, true, "replay is byte-equivalent");
});

/* ============================================================================
 * PART 8 — identity barriers (real captures, waves, cohorts, datasets, contract)
 * ==========================================================================*/

test("45. the real V2 capture is byte-identical and replays to its pinned digests", async () => {
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
  assertEqual(integrity.manifestDigest, REAL_V2_PINS.manifestDigest, "integrity re-derives the pinned manifest digest");
  assertEqual(integrity.recordsDigest, REAL_V2_PINS.recordsDigest, "integrity re-derives the pinned records digest");

  const replay = await replayCapture({ root: REAL_CAPTURE_ROOT, captureId: REAL_V2_CAPTURE_ID, asOf: null });
  assertEqual(replay.replayDigest, REAL_V2_PINS.replayDigest, "the replay digest is EXACTLY the pinned value");
  assertEqual(replay.recordCount, 1, "the real V2 capture is the one-record infrastructure capture");
  assertEqual(replay.features.coordinationIndicators.count, 0, "no coordination indicator fires on one record");
  const packet = buildExternalIntelligencePacket({ replay });
  assertEqual(packet.packetDigest, REAL_V2_PINS.packetDigest, "the packet digest is EXACTLY the pinned value");
  assertEqual(packet.evidenceQuality, "WEAK", "the deterministic label is WEAK (infrastructure evidence only)");

  // The real V2 capture can be projected, but Jev never receives the label.
  const jevPacket = buildExternalIntelligenceJevPacket({ externalPacket: packet });
  assertTrue(!canonicalJson(jevPacket).includes("evidenceQuality"), "the WEAK label is withheld from the Jev projection");
  assertEqual(externalIntelligenceComparators(packet).externalEvidenceQuality, "WEAK", "and recorded as a comparator instead");
});

test("46. the legacy V1 capture replays to its pinned digest", async () => {
  if (!ctx.realCaptureAvailable) {
    skip(`the legacy capture ${LEGACY_V1_CAPTURE_ID} is not present — its pinned replay case was skipped`);
    return;
  }
  const manifest = await readCaptureManifest(REAL_CAPTURE_ROOT, LEGACY_V1_CAPTURE_ID);
  assertEqual(manifest.captureSchemaVersion, 1, "the legacy manifest is still schema 1");
  assertEqual(manifest.featureVersion, undefined, "the legacy manifest was NOT mutated to add a version pin");
  const integrity = await verifyCapture(REAL_CAPTURE_ROOT, LEGACY_V1_CAPTURE_ID);
  assertEqual(integrity.ok, true, "the legacy capture still verifies");
  const replay = await replayCapture({ root: REAL_CAPTURE_ROOT, captureId: LEGACY_V1_CAPTURE_ID, asOf: null });
  assertEqual(replay.replayDigest, LEGACY_V1_REPLAY_DIGEST, "the legacy replay digest is EXACTLY the pinned value");
  assertEqual(replay.featureVersion, "external-intelligence-features-v1", "the legacy transform is still V1");
});

test("47-50. Wave 1, Wave 2, the six replication datasets and the frozen cohorts are byte-identical", async () => {
  if (!ctx.evidenceAvailable) {
    skip("the .evolve replication/history evidence is not present — identity cases were skipped");
    return;
  }
  const waves = [
    { label: "Wave 1", ids: WAVE_1_DATASET_IDS, fingerprints: WAVE_1_DATASET_FINGERPRINTS },
    { label: "Wave 2", ids: WAVE_2_DATASET_IDS, fingerprints: WAVE_2_DATASET_FINGERPRINTS },
  ];
  let checked = 0;
  for (const wave of waves) {
    assertEqual(wave.ids.length, 3, `${wave.label} is three datasets`);
    for (const id of wave.ids) {
      assertEqual(await datasetFingerprint(id), wave.fingerprints[id], `${id} still matches its pinned fingerprint`);
      checked += 1;
    }
  }
  assertEqual(checked, 6, "exactly six replication datasets were verified byte-identical");

  const mock = await readFrozenCohort(path.join(REPO, ".evolve", "replication"), "mock");
  const deepseek = await readFrozenCohort(path.join(REPO, ".evolve", "replication"), "deepseek");
  assertTrue(mock !== null && deepseek !== null, "both frozen cohorts are readable");
  assertEqual(mock.cohortDigest, FROZEN_COHORT_DIGESTS.mock, "the Mock cohort digest is unchanged");
  assertEqual(deepseek.cohortDigest, FROZEN_COHORT_DIGESTS.deepseek, "the DeepSeek cohort digest is unchanged");
  assertEqual(mock.immutable, true, "the Mock cohort is still immutable");
  assertEqual(deepseek.frozen, true, "the DeepSeek cohort is still frozen");

  // Nothing this suite did touched a frozen artifact.
  assertDeepEqual(await metadataSnapshot(path.join(REPO, ".evolve", "replication", "waves")), ctx.evidenceBaseline.waves, "wave manifests unchanged");
  assertDeepEqual(await metadataSnapshot(path.join(REPO, ".evolve", "replication", "cohorts")), ctx.evidenceBaseline.cohorts, "cohorts unchanged");
  assertDeepEqual(await metadataSnapshot(path.join(REPO, ".evolve", "history")), ctx.evidenceBaseline.history, "recorded datasets unchanged");
  assertDeepEqual(await metadataSnapshot(path.join(REPO, ".evolve", "intelligence")), ctx.evidenceBaseline.intelligence, "the real captures' bytes did not change");
  assertDeepEqual(await metadataSnapshot(path.join(REPO, ".evolve", "jev")), ctx.evidenceBaseline.jev, "no existing Jev experiment was touched");
  assertEqual(CANONICAL_WAVE_1_REPLICATION_ID, "rep-66884de4e460", "the canonical Wave 1 replication id is unchanged");
  assertEqual(CANONICAL_HISTORICAL_FREEZE_PATH, "phase5c-freeze.json", "the canonical historical freeze path is unchanged");
});

test("51. the evaluation contract digest is EXACTLY the pinned value", async () => {
  assertEqual(
    CANONICAL_EVALUATION_CONTRACT_DIGEST,
    "4cf8ac1fa7db290acadeccf6043ec34c3239f8e3f848e9e50d8560826de85052",
    "the published contract pin is unchanged",
  );
  assertEqual(CANONICAL_EVALUATION_CONTRACT_DIGEST.length, 64, "the contract digest is a SHA-256 hex string");
  if (!ctx.evidenceAvailable) {
    skip("the stored Wave 1 freeze is not present — the derived-contract case was skipped");
    return;
  }
  const stored = await readFreeze({ root: path.join(REPO, ".evolve", "replication") });
  const first = evaluationContractDigest(stored);
  assertEqual(first, evaluationContractDigest(stored), "the derived contract digest is deterministic");
  assertEqual(first, CANONICAL_EVALUATION_CONTRACT_DIGEST, "the STORED freeze still derives the canonical contract digest");
});

/* ============================================================================
 * PART 9 — calibration is out of scope and never treated as a failure
 * ==========================================================================*/

test("52. the external decision carries no Arena outcome and calibration is not attempted", async () => {
  const result = await runExternalIntelligenceShadowDecision({
    externalPacket: ctx.externalPacket,
    provider: createMockJevProvider(),
    budget: createJevRunBudget(1),
    cacheEnabled: false,
    persist: true,
    experimentRootBase: ctx.jevBase,
    now: () => NOW,
    salt: "no-calibration",
  });
  const decision = result.decisionRecord;
  assertEqual("outcome" in decision, false, "the decision carries no outcome reference");
  assertEqual("arenaId" in decision, false, "the decision carries no Arena id");
  const outcomes = await readAllFiles(result.root);
  assertEqual(outcomes.some((file) => file.path.startsWith(`outcomes${path.sep}`)), false, "no outcome record was written");
  assertEqual(JEV_EXPERIMENTS_DIR, path.join(".evolve", "jev", "experiments"), "the standard Jev experiments dir is unchanged");
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
    console.error("could not build Phase 5F fixtures:", error?.stack ?? error);
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
  console.log("offline: no real Jev call, no live capture, no network call, no Agent-Reach call, no DeepSeek call, no Arena run.");
  if (skips.length > 0) {
    console.log(`skipped ${skips.length} optional case(s) whose evidence is absent here:`);
    for (const reason of skips) console.log(`  - ${reason}`);
  }
  console.log(`EVOLVE Phase 5F.0 external-intelligence → Jev bridge validation: ${passed}/${cases.length} checks passed`);

  if (failures.length > 0) {
    console.log("Failed checks:");
    for (const failure of failures) console.log(`  - ${failure.name}`);
    process.exitCode = 1;
  } else {
    console.log("All Phase 5F.0 checks passed. External intelligence reaches Jev ONLY through an explicit, bounded,");
    console.log("whitelisted SHADOW projection with a dedicated packet kind and a fixed question set. The deterministic");
    console.log("evidenceQuality label is withheld from Jev and recorded as a comparator instead, and an");
    console.log("`escalate_to_deep_research` shadow answer invokes nothing. Operational routing remains OFF.");
  }
}

run().catch((error) => {
  console.error("phase 5F.0 validation runner crashed:", error);
  process.exitCode = 1;
});
