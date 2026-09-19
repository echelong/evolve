#!/usr/bin/env node
/**
 * EVOLVE Phase 5G.1 validation suite — OFFLINE classifier taxonomy evaluation.
 *
 * Proves the whole chain
 *
 *   frozen capture → Phase 5G.0 classifier experiment
 *     → explicit immutable DEVELOPMENT cohort
 *     → OFFLINE descriptive taxonomy evaluation → evaluation artifact → STOP
 *
 * and everything around it: the frozen taxonomy/definition/projection, the
 * cohort rejection rules (duplicate / missing / mixed id / mixed version / mixed
 * projection / non-final / failed integrity / missing or tampered capture / the
 * canonical one-record infrastructure exclusion), the DEVELOPMENT evidence class,
 * the deterministic descriptive metrics (label distribution + diversity,
 * confidence stats + bands, per-label confidence, score margin + ambiguity bands,
 * score entropy, channel × label, noise, promotion, concentration), the absence
 * of any ground truth / accuracy / profitability / verdict metric, the text-free
 * artifact, the deterministic terminal-only audit views, offline replay and
 * stats, and the byte-identity of every frozen artifact.
 *
 * Fully OFFLINE and deterministic: `fetch` is a scripted stub, no real
 * classifier.dev request is ever made, no capture is taken, no Agent-Reach / Jev
 * / DeepSeek call is made, no Arena is run, and nothing under the repository's
 * `.evolve/` is written.
 *
 * Run with: npm run validate:phase5g1
 */

import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { canonicalJson } from "./lib/hash.mjs";

import { listCaptures, readCaptureManifest, runCapture, verifyCapture } from "./intelligence/capture.mjs";
import { resolveIntelligenceConfig } from "./intelligence/config.mjs";
import {
  DEFAULT_FEATURE_VERSION,
  INTELLIGENCE_FEATURE_VERSION,
  INTELLIGENCE_FEATURE_VERSION_V2,
  REGISTERED_FEATURE_VERSIONS,
} from "./intelligence/features.mjs";
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
  CLASSIFIER_ID,
  CLASSIFIER_INSTRUCTIONS_DIGEST,
  CLASSIFIER_LABELS,
  CLASSIFIER_VERSION,
  INPUT_PROJECTION_VERSION,
} from "./intelligence/classifier-definition.mjs";
import { createClassifierDevProvider } from "./intelligence/classifier-dev.mjs";
import {
  CLASSIFIER_EXPERIMENT_FILE,
  CLASSIFIER_RESULTS_FILE,
  classifierExperimentDir,
  experimentDigestOf,
  resultDigestOf,
  runClassification,
} from "./intelligence/classifier-experiment.mjs";
import {
  CANONICAL_INFRASTRUCTURE_EXPERIMENT_ID,
  CANONICAL_INFRASTRUCTURE_RESULT_DIGEST,
  COHORT_EVIDENCE_CLASS,
  CONFIDENCE_BANDS,
  AMBIGUITY_BANDS,
  ClassifierEvaluationJoinError,
  CohortCaptureIntegrityError,
  CohortCaptureMissingError,
  CohortClassifierMismatchError,
  CohortClassifierVersionMismatchError,
  CohortDuplicateExperimentError,
  CohortExperimentIntegrityError,
  CohortExperimentMissingError,
  CohortExperimentNotFinalError,
  CohortInfrastructureExperimentError,
  CohortNoExperimentsError,
  CohortProjectionMismatchError,
  auditArtifactTextFree,
  auditEvaluationArtifact,
  buildAuditSample,
  buildLowConfidenceAudit,
  collectCohortEvidence,
  computeEvaluationMetrics,
  evaluationStats,
  forbiddenVerdictKeys,
  freezeCohort,
  listCohorts,
  normalizeExperimentIds,
  replayEvaluation,
  runEvaluation,
  scoreEntropyOf,
  verifyCohort,
} from "./intelligence/classifier-evaluation.mjs";

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
const NOW_A = Date.parse("2026-09-19T15:00:00.000Z");
const NOW_B = Date.parse("2026-09-19T15:05:00.000Z");
const NOW_EVAL = Date.parse("2026-09-19T15:10:00.000Z");

const REAL_CAPTURE_ROOT = path.join(REPO, ".evolve", "intelligence");
const REAL_CLASSIFIER_ROOT = path.join(REPO, ".evolve", "classifier");
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
const PINNED_DEFINITION_DIGEST = "9b424862f800e651b04e881b5557a0be6dd52ef9f708fa0bd5f64ee3ec90c4ff";
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

const EVALUATION_SOURCE_FILES = [
  "scripts/intelligence/classifier-evaluation.mjs",
  "scripts/intelligence-classify-eval.mjs",
];

const CLASSIFIER_REFERENCE = /classifier-dev|classifier\.dev|reach-signal-type|intelligence-classify|classifier-definition|classifier-experiment|classifier-evaluation|classifierId/i;

const FORBIDDEN_TRANSACTION_API = [
  /\bsendTransaction\b/,
  /\bsignTransaction\b/,
  /\bKeypair\b/,
  /\bnew Connection\b/,
  /\bgetLatestBlockhash\b/,
  /\bsimulateTransaction\b/,
];

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
function assertClose(actual, expected, message, epsilon = 1e-6) {
  if (typeof actual !== "number" || Math.abs(actual - expected) > epsilon) {
    fail(`${message} (expected ~${expected}, got ${actual})`);
  }
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
  classifierRoot: null,
  experimentA: null,
  experimentB: null,
  captureA: null,
  captureB: null,
  cohort: null,
  evaluation: null,
  evidence: null,
  audit: null,
  realCaptureAvailable: false,
  evidenceAvailable: false,
  evidenceBaseline: {},
  sources: new Map(),
};

const PLAN_A = [
  { label: "technical_activity", confidence: 0.9, scores: { technical_activity: 0.9, unrelated_or_noise: 0.05 } },
  { label: "project_announcement", confidence: 0.6, scores: { project_announcement: 0.6, technical_activity: 0.55 } },
  { label: "unrelated_or_noise", confidence: 0.4, scores: { unrelated_or_noise: 0.4, promotion_or_marketing: 0.35 } },
];
const PLAN_B = [
  { label: "promotion_or_marketing", confidence: 0.55, scores: { promotion_or_marketing: 0.55, unrelated_or_noise: 0.5 } },
  { label: "technical_activity", confidence: 0.7, scores: { technical_activity: 0.7, project_announcement: 0.65 } },
  { label: "unrelated_or_noise", confidence: 0.3, scores: { unrelated_or_noise: 0.3, community_attention: 0.28 } },
];

const RAWS_A = [
  { id: "a0", url: "https://sentinel.example/a0", author: "AUTHOR-SENT-A0", title: "Repo update TITLE-SENT-A0", text: "Merged a pull request EXCERPT-SENT-A0" },
  { id: "a1", url: "https://sentinel.example/a1", author: "AUTHOR-SENT-A1", title: "Governance vote TITLE-SENT-A1", text: "Proposal scheduled EXCERPT-SENT-A1" },
  { id: "a2", url: "https://sentinel.example/a2", author: "AUTHOR-SENT-A2" },
  { id: "a3", url: "https://sentinel.example/a3", author: "AUTHOR-SENT-A3", text: "Exchange listing EXCERPT-SENT-A3" },
];
const RAWS_B = [
  { id: "b0", url: "https://sentinel.example/b0", author: "AUTHOR-SENT-B0", title: "Buy now TITLE-SENT-B0", text: "promo EXCERPT-SENT-B0" },
  { id: "b1", url: "https://sentinel.example/b1", author: "AUTHOR-SENT-B1", title: "Repo update TITLE-SENT-B1", text: "Merged a PR EXCERPT-SENT-B1" },
  { id: "b2", url: "https://sentinel.example/b2", author: "AUTHOR-SENT-B2", title: "Chatter TITLE-SENT-B2", text: "nothing notable EXCERPT-SENT-B2" },
];

function planFetch(plan) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    const results = body.inputs.map((_input, index) => {
      const entry = plan[index];
      if (!entry) throw new Error(`fixture plan is missing entry ${index}`);
      return { label: entry.label, confidence: entry.confidence, scores: entry.scores };
    });
    const payload = {
      tier: "fast",
      model: "fixture-model-1",
      results,
      usage: { classifications: results.length, escalated: 0, ms: 1 },
    };
    return new Response(JSON.stringify(payload), { status: 200, headers: {} });
  };
}

function makeProvider(plan) {
  return createClassifierDevProvider({
    fetchImpl: planFetch(plan),
    sleepImpl: async () => {},
    randomImpl: () => 0.5,
    now: () => NOW_A,
    settings: { maxAttempts: 1, backoffBaseMs: 0, backoffMaxMs: 0, timeoutMs: 5_000 },
  });
}

const CAPTURE_CANDIDATE = { symbol: "PHASE5G1", name: "Phase 5G.1 Fixture", mint: "G51Mint111111111111111111111111111111111", domain: "fixture.example", handle: "@phase5g1" };

async function makeCapture({ now, channel, raws }) {
  return runCapture({
    root: ctx.captureRoot,
    config: resolveIntelligenceConfig({ EVOLVE_INTELLIGENCE_PROVIDER: "mock", EVOLVE_REACH_CHANNELS: channel }),
    candidates: [{ ...CAPTURE_CANDIDATE }],
    provider: "mock",
    now,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    executor: async () => ({ ok: true, records: raws, backendVersion: "fixture", syntheticIntelligence: true }),
  });
}

async function makeExperiment({ captureId, plan, now }) {
  const result = await runClassification({
    captureRoot: ctx.captureRoot,
    outRoot: ctx.classifierRoot,
    captureId,
    classifierId: CLASSIFIER_ID,
    provider: makeProvider(plan),
    save: true,
    now: () => now,
  });
  if (!result.ok) throw new Error(`fixture classification failed: ${result.reason}`);
  return result.experiment;
}

async function readExperimentJson(classifierRoot, experimentId) {
  return JSON.parse(await readFile(path.join(classifierExperimentDir(classifierRoot, experimentId), CLASSIFIER_EXPERIMENT_FILE), "utf8"));
}

async function writeExperimentJson(classifierRoot, experimentId, experiment) {
  await writeFile(path.join(classifierExperimentDir(classifierRoot, experimentId), CLASSIFIER_EXPERIMENT_FILE), `${JSON.stringify(experiment, null, 2)}\n`, "utf8");
}

async function readResultLines(classifierRoot, experimentId) {
  const text = await readFile(path.join(classifierExperimentDir(classifierRoot, experimentId), CLASSIFIER_RESULTS_FILE), "utf8");
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

async function writeResultLines(classifierRoot, experimentId, lines) {
  await writeFile(path.join(classifierExperimentDir(classifierRoot, experimentId), CLASSIFIER_RESULTS_FILE), `${lines.join("\n")}\n`, "utf8");
}

/** Copy an experiment directory and apply a mutation to experiment.json (digest recomputed unless asked otherwise). */
async function cloneExperiment({ fromId, toId, mutate = (experiment) => experiment, recomputeDigest = true }) {
  const from = classifierExperimentDir(ctx.classifierRoot, fromId);
  const to = classifierExperimentDir(ctx.classifierRoot, toId);
  await cp(from, to, { recursive: true });
  const experiment = await readExperimentJson(ctx.classifierRoot, toId);
  const next = { ...experiment, ...mutate(experiment), experimentId: toId };
  if (recomputeDigest) next.experimentDigest = experimentDigestOf(next);
  await writeExperimentJson(ctx.classifierRoot, toId, next);
  return next;
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
  return spawnSync(process.execPath, [path.join(REPO, "scripts", "intelligence-classify-eval.mjs"), ...args], {
    encoding: "utf8",
    cwd: REPO,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
  });
}

async function buildFixtures() {
  ctx.tmp = await mkdtemp(path.join(tmpdir(), "evolve-phase5g1-"));
  ctx.captureRoot = path.join(ctx.tmp, "captures");
  ctx.classifierRoot = path.join(ctx.tmp, "classifier");
  await mkdir(ctx.captureRoot, { recursive: true });

  ctx.captureA = await makeCapture({ now: NOW_A, channel: "github", raws: RAWS_A });
  ctx.captureB = await makeCapture({ now: NOW_B, channel: "x", raws: RAWS_B });
  ctx.experimentA = await makeExperiment({ captureId: ctx.captureA.captureId, plan: PLAN_A, now: NOW_A });
  ctx.experimentB = await makeExperiment({ captureId: ctx.captureB.captureId, plan: PLAN_B, now: NOW_B });

  const frozen = await freezeCohort({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, experimentIds: [ctx.experimentA.experimentId, ctx.experimentB.experimentId], now: () => NOW_EVAL });
  ctx.cohort = frozen.cohort;
  const ran = await runEvaluation({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, cohortId: ctx.cohort.cohortId, now: () => NOW_EVAL, save: true });
  ctx.evaluation = ran.evaluation;
  ctx.evidence = await collectCohortEvidence({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, cohort: ctx.cohort, verifyIntegrity: true });
  ctx.audit = await buildAuditSample({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, cohortId: ctx.cohort.cohortId });

  ctx.realCaptureAvailable = await exists(path.join(REAL_CAPTURE_ROOT, "2026-09-19", REAL_V2_CAPTURE_ID));
  ctx.evidenceAvailable = (await exists(path.join(REPO, ".evolve", "replication"))) && (await exists(path.join(REPO, ".evolve", "history")));
  ctx.evidenceBaseline = {
    waves: await metadataSnapshot(path.join(REPO, ".evolve", "replication", "waves")),
    cohorts: await metadataSnapshot(path.join(REPO, ".evolve", "replication", "cohorts")),
    history: await metadataSnapshot(path.join(REPO, ".evolve", "history")),
    intelligence: await metadataSnapshot(REAL_CAPTURE_ROOT),
    jev: await metadataSnapshot(path.join(REPO, ".evolve", "jev")),
    jevHealth: await metadataSnapshot(path.join(REPO, ".evolve", "jev", "provider-health")),
    classifier: await metadataSnapshot(REAL_CLASSIFIER_ROOT),
    infraExperiment: await metadataSnapshot(path.join(REAL_CLASSIFIER_ROOT, "experiments", CANONICAL_INFRASTRUCTURE_EXPERIMENT_ID)),
  };

  for (const file of [
    ...EVALUATION_SOURCE_FILES,
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

/** Run an async fn with `globalThis.fetch` replaced by a counting, always-throwing stub. */
async function withOfflineFetch(fn) {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("evaluation must be offline");
  };
  try {
    const result = await fn();
    return { result, calls };
  } finally {
    globalThis.fetch = realFetch;
  }
}

/* ============================================================================
 * Reference math (independent of the module under test)
 * ==========================================================================*/

const LN9 = Math.log(9);
function refEntropy(values) {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) return null;
  let h = 0;
  for (const value of values) {
    if (value > 0) {
      const p = value / total;
      h -= p * Math.log(p);
    }
  }
  return h / LN9;
}
function refQuantile(sorted, q) {
  const n = sorted.length;
  if (n === 0) return null;
  if (n === 1) return sorted[0];
  const pos = q * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] * (1 - (pos - lo)) + sorted[hi] * (pos - lo);
}
const round6 = (value) => (Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : null);
function nineScoresOf(scores) {
  return PINNED_LABELS.map((label) => (typeof scores?.[label] === "number" ? scores[label] : 0));
}

/* ============================================================================
 * PART 1 — frozen taxonomy / definition / projection (1-4)
 * ==========================================================================*/

test("1. the frozen taxonomy v1 is unchanged", async () => {
  assertEqual(CLASSIFIER_ID, "reach-signal-type-v1", "the classifier id");
  assertEqual(CLASSIFIER_VERSION, 1, "the classifier version");
  assertDeepEqual([...CLASSIFIER_LABELS], PINNED_LABELS, "the nine labels, in order");
  assertEqual(CLASSIFIER_LABELS.length, 9, "exactly nine labels");
  assertTrue(Object.isFrozen(CLASSIFIER_LABELS), "the label list is frozen");
});

test("2. the classifier definition digest is unchanged", async () => {
  assertEqual(CLASSIFIER_DEFINITION_DIGEST, PINNED_DEFINITION_DIGEST, "the frozen definition digest");
  assertEqual(CLASSIFIER_INSTRUCTIONS_DIGEST, PINNED_INSTRUCTIONS_DIGEST, "the frozen instructions digest");
  if (ctx.realCaptureAvailable) {
    const experiment = await readExperimentJson(REAL_CLASSIFIER_ROOT, CANONICAL_INFRASTRUCTURE_EXPERIMENT_ID).catch(() => null);
    if (experiment) {
      assertEqual(experiment.classifierDefinitionDigest, PINNED_DEFINITION_DIGEST, "the infra experiment pins the same definition");
    }
  }
});

test("3. the input projection version is unchanged", async () => {
  assertEqual(INPUT_PROJECTION_VERSION, "classifier-input-projection-v1", "the projection version");
  assertEqual(ctx.experimentA.inputProjectionVersion, INPUT_PROJECTION_VERSION, "the fixture experiment pins it");
});

test("4. the canonical infrastructure classifier experiment is untouched", async () => {
  const dir = path.join(REAL_CLASSIFIER_ROOT, "experiments", CANONICAL_INFRASTRUCTURE_EXPERIMENT_ID);
  if (!(await exists(dir))) return skip("the canonical infrastructure experiment is not present here — pinned-digest cases were skipped");
  const experiment = JSON.parse(await readFile(path.join(dir, CLASSIFIER_EXPERIMENT_FILE), "utf8"));
  assertEqual(experiment.experimentId, CANONICAL_INFRASTRUCTURE_EXPERIMENT_ID, "the canonical experiment id");
  assertEqual(experiment.resultDigest, CANONICAL_INFRASTRUCTURE_RESULT_DIGEST, "the pinned result digest");
  assertEqual(experiment.experimentDigest, "58a2067270e0f4b343980f1c1ec2adf9896dfec407527abd6bdc7e55e36a619f", "the pinned experiment digest");
  assertEqual(experiment.classifierId, CLASSIFIER_ID, "it uses the frozen taxonomy");
  assertEqual(experiment.classifierVersion, CLASSIFIER_VERSION, "and the frozen version");
  assertDeepEqual(await metadataSnapshot(dir), ctx.evidenceBaseline.infraExperiment, "the canonical experiment bytes/mtimes are untouched");
});

/* ============================================================================
 * PART 2 — cohort construction + rejection rules (5-17)
 * ==========================================================================*/

test("5. a cohort requires EXPLICIT experiment ids", async () => {
  await assertThrows(() => normalizeExperimentIds([]), CohortNoExperimentsError, "an empty id list is refused");
  await assertThrows(() => normalizeExperimentIds(""), CohortNoExperimentsError, "an empty string is refused");
  await assertThrows(() => freezeCohort({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, experimentIds: [] }), CohortNoExperimentsError, "a cohort with no experiments is refused");
  await assertThrows(() => freezeCohort({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, experimentIds: undefined }), CohortNoExperimentsError, "a cohort with no ids at all is refused");
  assertEqual(runCli(["intelligence-classify-eval", "--freeze-cohort"]).status, 1, "the CLI refuses a freeze with no --experiments");
});

test("6. a duplicate experiment id is rejected", async () => {
  await assertThrows(() => normalizeExperimentIds([ctx.experimentA.experimentId, ctx.experimentA.experimentId]), CohortDuplicateExperimentError, "a duplicate id is refused");
  await assertThrows(
    () => freezeCohort({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, experimentIds: [ctx.experimentA.experimentId, ctx.experimentA.experimentId] }),
    CohortDuplicateExperimentError,
    "freeze refuses a duplicate",
  );
});

test("7. a missing experiment is rejected", async () => {
  await assertThrows(
    () => freezeCohort({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, experimentIds: ["clexp-20260919T000000Z-deadbeef"] }),
    CohortExperimentMissingError,
    "a nonexistent experiment id is refused",
  );
});

test("8. failed experiment integrity is rejected", async () => {
  const cloneId = "clexp-20260919T000000Z-00000008";
  await cloneExperiment({ fromId: ctx.experimentA.experimentId, toId: cloneId, mutate: () => ({}) });
  const lines = await readResultLines(ctx.classifierRoot, cloneId);
  const first = JSON.parse(lines[0]);
  first.confidence = 0.123;
  lines[0] = JSON.stringify(first);
  await writeResultLines(ctx.classifierRoot, cloneId, lines);
  await assertThrows(
    () => freezeCohort({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, experimentIds: [cloneId] }),
    CohortExperimentIntegrityError,
    "a tampered record set is refused",
  );
});

test("9. a mixed classifier id is rejected", async () => {
  const cloneId = "clexp-20260919T000000Z-00000009";
  await cloneExperiment({ fromId: ctx.experimentA.experimentId, toId: cloneId, mutate: () => ({ classifierId: "reach-signal-type-v2" }) });
  await assertThrows(
    () => freezeCohort({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, experimentIds: [cloneId] }),
    CohortClassifierMismatchError,
    "a different classifier id is refused",
  );
});

test("10. a mixed classifier version is rejected", async () => {
  const cloneId = "clexp-20260919T000000Z-00000010";
  await cloneExperiment({ fromId: ctx.experimentA.experimentId, toId: cloneId, mutate: () => ({ classifierVersion: 2 }) });
  await assertThrows(
    () => freezeCohort({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, experimentIds: [cloneId] }),
    CohortClassifierVersionMismatchError,
    "a different classifier version is refused",
  );
});

test("11. a mixed projection version is rejected", async () => {
  const cloneId = "clexp-20260919T000000Z-00000011";
  await cloneExperiment({ fromId: ctx.experimentA.experimentId, toId: cloneId, mutate: () => ({ inputProjectionVersion: "classifier-input-projection-v0" }) });
  await assertThrows(
    () => freezeCohort({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, experimentIds: [cloneId] }),
    CohortProjectionMismatchError,
    "a different input projection is refused",
  );
});

test("12. a non-finalized experiment is rejected", async () => {
  const cloneId = "clexp-20260919T000000Z-00000012";
  await cloneExperiment({ fromId: ctx.experimentA.experimentId, toId: cloneId, mutate: () => ({ immutable: false }) });
  await assertThrows(
    () => freezeCohort({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, experimentIds: [cloneId] }),
    CohortExperimentNotFinalError,
    "a non-immutable experiment is refused",
  );
});

test("13. a missing source capture is rejected", async () => {
  const cloneId = "clexp-20260919T000000Z-00000013";
  await cloneExperiment({ fromId: ctx.experimentA.experimentId, toId: cloneId, mutate: () => ({ captureId: "capture-20260919T000000Z" }) });
  await assertThrows(
    () => freezeCohort({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, experimentIds: [cloneId] }),
    CohortCaptureMissingError,
    "a missing capture is refused",
  );
});

test("14. a source capture integrity failure is rejected", async () => {
  const tamperedRoot = path.join(ctx.tmp, "captures-tampered");
  await cp(ctx.captureRoot, tamperedRoot, { recursive: true });
  const recordsPath = path.join(tamperedRoot, "2026-09-19", ctx.captureA.captureId, "records.ndjson");
  const original = await readFile(recordsPath, "utf8");
  await writeFile(recordsPath, original.replace("EXCERPT-SENT-A0", "EXCERPT-SENT-A0!"), "utf8");
  await assertThrows(
    () => freezeCohort({ classifierRoot: ctx.classifierRoot, captureRoot: tamperedRoot, experimentIds: [ctx.experimentA.experimentId] }),
    CohortCaptureIntegrityError,
    "a tampered capture is refused",
  );
  await writeFile(recordsPath, original, "utf8");
  assertEqual((await verifyCapture(tamperedRoot, ctx.captureA.captureId)).ok, true, "restoring the capture bytes makes it verify again");
});

test("15. the canonical infrastructure experiment is excluded by default", async () => {
  await assertThrows(
    () => freezeCohort({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, experimentIds: [CANONICAL_INFRASTRUCTURE_EXPERIMENT_ID] }),
    CohortInfrastructureExperimentError,
    "the infrastructure experiment is refused by default",
  );
  assertEqual(runCli(["--freeze-cohort", "--experiments", CANONICAL_INFRASTRUCTURE_EXPERIMENT_ID]).status, 1, "the CLI refuses it too");
});

test("16. every cohort is pinned to the DEVELOPMENT evidence class", async () => {
  assertEqual(ctx.cohort.evidenceClass, COHORT_EVIDENCE_CLASS, "the cohort evidence class");
  assertEqual(COHORT_EVIDENCE_CLASS, "DEVELOPMENT_CLASSIFIER_EVIDENCE", "the pinned evidence class constant");
  assertEqual(ctx.cohort.purpose, "DEVELOPMENT", "the cohort purpose");
  for (const forbidden of ["CLEAN_REPLICATION", "VALIDATION", "TEST", "OOS", "PRODUCTION"]) {
    assertTrue(!canonicalJson(ctx.cohort).includes(forbidden), `the cohort never claims '${forbidden}'`);
    assertTrue(!canonicalJson(ctx.evaluation).includes(forbidden), `the evaluation never claims '${forbidden}'`);
  }
  assertEqual(ctx.evaluation.evidenceClass, COHORT_EVIDENCE_CLASS, "the evaluation evidence class");
});

test("17. the cohort is immutable and self-consistent", async () => {
  assertEqual(ctx.cohort.immutable, true, "immutable");
  assertEqual(verifyCohort(ctx.cohort).ok, true, "the cohort verifies");
  assertEqual(ctx.cohort.experimentIds.length, 2, "two experiments");
  assertEqual(ctx.cohort.sourceCaptureIds.length, 2, "two captures");
  const tampered = { ...ctx.cohort, note: "changed" };
  assertEqual(verifyCohort(tampered).ok, false, "a modified cohort fails verification");
});

test("18. the cohort carries no raw text, URL or author", async () => {
  assertTrue(auditArtifactTextFree(ctx.cohort).length === 0, `the cohort artifact is clean (${auditArtifactTextFree(ctx.cohort).join("; ")})`);
  const text = canonicalJson(ctx.cohort);
  for (const sentinel of ["TITLE-SENT", "EXCERPT-SENT", "AUTHOR-SENT", "sentinel.example", "https://"]) {
    assertTrue(!text.includes(sentinel), `'${sentinel}' never appears in the cohort`);
  }
  assertDeepEqual(
    Object.keys(ctx.cohort).sort(),
    ["classifierId", "classifierVersion", "cohortDigest", "cohortId", "createdAt", "evidenceClass", "experimentDigests", "experimentIds", "immutable", "inputProjectionVersion", "note", "purpose", "recordCounts", "resultDigests", "sourceCaptureIds"],
    "the cohort carries exactly the frozen key set",
  );
});

/* ============================================================================
 * PART 3 — offline evaluation (19-24)
 * ==========================================================================*/

test("19. the evaluation layer is offline-only (no network imports)", async () => {
  for (const file of EVALUATION_SOURCE_FILES) {
    const source = ctx.sources.get(file);
    const specs = importSpecifiers(source);
    assertTrue(!specs.some((spec) => /classifier-dev|agent-reach|providers\/|\/provider\.mjs|child_process|query-sets|research|arena|market|wallet|solana|jupiter/.test(spec)), `${file} imports no network/provider module`);
    const code = stripComments(source);
    assertTrue(!/\brunCapture\b|\bresolveIntelligenceProvider\b|\bspawn(?:Sync)?\s*\(|\bexecFile(?:Sync)?\s*\(|\bexec(?:Sync)?\s*\(/.test(code), `${file} never calls a capture/provider/subprocess`);
    assertTrue(!/\bcreateClassifierDevProvider\b|\bglobalThis\.fetch\b|\bfetchImpl\b|\bfetch\s*\(/.test(code), `${file} never calls the classifier transport`);
  }
});

test("20. the evaluation makes ZERO classifier.dev calls", async () => {
  const { result, calls } = await withOfflineFetch(async () => {
    const ran = await runEvaluation({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, cohortId: ctx.cohort.cohortId, now: () => NOW_EVAL, save: false });
    return ran;
  });
  assertEqual(calls, 0, "zero fetch calls during evaluation");
  assertEqual(result.evaluation.classifierId, CLASSIFIER_ID, "the evaluation still computed its metrics");
});

test("21. the evaluation makes ZERO Agent-Reach calls (and takes no capture)", async () => {
  const before = await listCaptures(ctx.captureRoot);
  const { calls } = await withOfflineFetch(() => runEvaluation({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, cohortId: ctx.cohort.cohortId, now: () => NOW_EVAL, save: false }));
  assertEqual(calls, 0, "zero fetch calls");
  assertDeepEqual(await listCaptures(ctx.captureRoot), before, "no capture appeared");
  for (const file of EVALUATION_SOURCE_FILES) {
    assertTrue(!importSpecifiers(ctx.sources.get(file)).some((spec) => /agent-reach|capture\.mjs.*runCapture/.test(spec)), `${file} never imports the capture runner`);
  }
});

test("22. the evaluation never calls Jev", async () => {
  for (const file of EVALUATION_SOURCE_FILES) {
    const source = ctx.sources.get(file);
    assertTrue(!importSpecifiers(source).some((spec) => /jev/i.test(spec)), `${file} imports nothing from Jev`);
    assertTrue(!/\bjevDecide\b|\bcreateVercelJevProvider\b|\bJEV_STATUS\b/.test(stripComments(source)), `${file} references no Jev API`);
  }
  for (const [file, source] of ctx.sources) {
    if (!file.includes("jev")) continue;
    assertTrue(!CLASSIFIER_REFERENCE.test(source), `${file} does not reference the classifier`);
  }
});

test("23. the evaluation never calls DeepSeek", async () => {
  for (const file of EVALUATION_SOURCE_FILES) {
    const source = ctx.sources.get(file);
    assertTrue(!importSpecifiers(source).some((spec) => /research|deepseek|cline/i.test(spec)), `${file} imports no research/DeepSeek module`);
    assertTrue(!/\brunResearch\b|deepseek-cline/i.test(stripComments(source)), `${file} references no DeepSeek API`);
  }
});

test("24. the evaluation never calls the Arena or trading code", async () => {
  for (const file of EVALUATION_SOURCE_FILES) {
    const source = ctx.sources.get(file);
    const code = stripComments(source);
    assertTrue(!importSpecifiers(source).some((spec) => /arena|champion|replication|\/engine|market|wallet|signer|solana|jupiter|rpc|trade/i.test(spec)), `${file} imports no Arena/market module`);
    assertTrue(!/\brunArena\b|\brunTournament\b|\bevolveGeneration\b/.test(code), `${file} runs no Arena code`);
    for (const pattern of FORBIDDEN_TRANSACTION_API) assertTrue(!pattern.test(code), `${file} references no transaction API (${pattern})`);
  }
});

/* ============================================================================
 * PART 4 — descriptive metrics (25-47)
 * ==========================================================================*/

test("25. the label counts are correct", async () => {
  const labels = Object.fromEntries((ctx.evaluation.metrics.labelDistribution.labels ?? []).map((entry) => [entry.label, entry.count]));
  assertEqual(labels.technical_activity, 2, "technical_activity");
  assertEqual(labels.project_announcement, 1, "project_announcement");
  assertEqual(labels.unrelated_or_noise, 2, "unrelated_or_noise");
  assertEqual(labels.promotion_or_marketing, 1, "promotion_or_marketing");
  assertEqual(labels.exchange_or_listing, 0, "exchange_or_listing");
  assertEqual(ctx.evaluation.metrics.labelDistribution.totalClassified, 6, "totalClassified");
  assertEqual(ctx.evaluation.metrics.labelDistribution.labelsObserved, 4, "labelsObserved");
});

test("26. the label fractions are correct", async () => {
  const fractions = Object.fromEntries((ctx.evaluation.metrics.labelDistribution.labels ?? []).map((entry) => [entry.label, entry.fraction]));
  assertEqual(fractions.technical_activity, round6(2 / 6), "technical_activity fraction");
  assertEqual(fractions.project_announcement, round6(1 / 6), "project_announcement fraction");
  assertEqual(fractions.unrelated_or_noise, round6(2 / 6), "unrelated_or_noise fraction");
  assertEqual(fractions.exchange_or_listing, 0, "an unobserved label is 0");
});

test("27. the label fractions sum to 1", async () => {
  const sum = (ctx.evaluation.metrics.labelDistribution.labels ?? []).reduce((total, entry) => total + entry.fraction, 0);
  assertClose(sum, 1, "the nine fractions sum to 1", 1e-5);
  assertEqual(ctx.evaluation.metrics.labelDistribution.labels.length, 9, "all nine labels are reported");
});

test("28. the normalized label entropy is correct", async () => {
  const expected = refEntropy([2, 1, 0, 0, 0, 0, 0, 1, 2]);
  assertEqual(ctx.evaluation.metrics.labelDistribution.labelDiversity, round6(expected), "the normalized label diversity");
  assertClose(ctx.evaluation.metrics.labelDistribution.labelDiversity, 0.605155, "the expected value", 1e-5);
  assertTrue(ctx.evaluation.metrics.labelDistribution.labelDiversity > 0 && ctx.evaluation.metrics.labelDistribution.labelDiversity < 1, "between 0 and 1");
});

test("29. the confidence mean is correct", async () => {
  assertEqual(ctx.evaluation.metrics.confidence.count, 6, "six observations");
  assertClose(ctx.evaluation.metrics.confidence.mean, 0.575, "the mean of [0.30,0.40,0.55,0.60,0.70,0.90]");
});

test("30. the confidence median is correct", async () => {
  assertClose(ctx.evaluation.metrics.confidence.median, 0.575, "the median (average of the two middle values)");
  assertClose(ctx.evaluation.metrics.confidence.min, 0.3, "the minimum");
  assertClose(ctx.evaluation.metrics.confidence.max, 0.9, "the maximum");
});

test("31. the confidence quantiles are deterministic", async () => {
  const sorted = [0.3, 0.4, 0.55, 0.6, 0.7, 0.9];
  assertClose(ctx.evaluation.metrics.confidence.p10, round6(refQuantile(sorted, 0.1)), "p10");
  assertClose(ctx.evaluation.metrics.confidence.p25, round6(refQuantile(sorted, 0.25)), "p25");
  assertClose(ctx.evaluation.metrics.confidence.p75, round6(refQuantile(sorted, 0.75)), "p75");
  assertClose(ctx.evaluation.metrics.confidence.p90, round6(refQuantile(sorted, 0.9)), "p90");
  assertClose(ctx.evaluation.metrics.confidence.p10, 0.35, "p10 value");
  assertClose(ctx.evaluation.metrics.confidence.p25, 0.4375, "p25 value");
  assertClose(ctx.evaluation.metrics.confidence.p75, 0.675, "p75 value");
  assertClose(ctx.evaluation.metrics.confidence.p90, 0.8, "p90 value");
});

test("32. the fixed confidence bands are correct", async () => {
  const bands = ctx.evaluation.metrics.confidence.bands;
  assertEqual(bands.below_0_50.count, 2, "< 0.50 count");
  assertEqual(bands.below_0_50.fraction, round6(2 / 6), "< 0.50 fraction");
  assertEqual(bands.below_0_70.count, 4, "< 0.70 count");
  assertEqual(bands.below_0_70.fraction, round6(4 / 6), "< 0.70 fraction");
  assertEqual(bands.at_least_0_90.count, 1, ">= 0.90 count");
  assertEqual(bands.at_least_0_90.fraction, round6(1 / 6), ">= 0.90 fraction");
  assertEqual(CONFIDENCE_BANDS.length, 3, "exactly three descriptive bands");
  assertEqual(bands.below_0_50.threshold, 0.5, "the band threshold is data, not a gate");
});

test("33. the per-label confidence stats are correct", async () => {
  const per = ctx.evaluation.metrics.perLabelConfidence;
  assertEqual(per.technical_activity.count, 2, "technical_activity count");
  assertClose(per.technical_activity.mean, 0.8, "technical_activity mean");
  assertClose(per.technical_activity.median, 0.8, "technical_activity median");
  assertClose(per.technical_activity.p25, 0.75, "technical_activity p25");
  assertClose(per.technical_activity.p75, 0.85, "technical_activity p75");
  assertClose(per.unrelated_or_noise.mean, 0.35, "unrelated_or_noise mean");
  assertClose(per.project_announcement.mean, 0.6, "project_announcement mean");
  assertEqual(Object.keys(per).length, 4, "only observed labels have stats");
  assertTrue(!("exchange_or_listing" in per), "an unobserved label has no entry");
});

test("34. the top1 / top2 score extraction is correct", async () => {
  const evidence = await collectCohortEvidence({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, cohort: ctx.cohort, verifyIntegrity: true });
  const first = evidence.observations.find((row) => row.confidence === 0.9);
  assertEqual(first.scores.technical_activity, 0.9, "the top score");
  assertEqual(first.scores.unrelated_or_noise, 0.05, "the second score");
  const metrics = computeEvaluationMetrics(evidence.observations);
  assertClose(metrics.scoreMargin.max, 0.85, "the largest margin is 0.90 - 0.05");
});

test("35. the score margin is correct", async () => {
  const evidence = await collectCohortEvidence({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, cohort: ctx.cohort, verifyIntegrity: true });
  const margins = evidence.observations.map((row) => nineScoresOf(row.scores).sort((a, b) => b - a)).map((sorted) => round6(sorted[0] - sorted[1]));
  assertEqual(ctx.evaluation.metrics.scoreMargin.count, 6, "six margins");
  assertClose(ctx.evaluation.metrics.scoreMargin.mean, round6(margins.reduce((a, b) => a + b, 0) / margins.length), "the mean margin");
  assertClose(ctx.evaluation.metrics.scoreMargin.mean, 0.178333, "the expected mean margin");
  assertClose(ctx.evaluation.metrics.scoreMargin.median, 0.05, "the median margin");
  assertClose(ctx.evaluation.metrics.scoreMargin.min, 0.02, "the minimum margin");
});

test("36. the margin quantiles are deterministic", async () => {
  const sorted = [0.02, 0.05, 0.05, 0.05, 0.05, 0.85];
  assertClose(ctx.evaluation.metrics.scoreMargin.p10, round6(refQuantile(sorted, 0.1)), "p10");
  assertClose(ctx.evaluation.metrics.scoreMargin.p25, round6(refQuantile(sorted, 0.25)), "p25");
  assertClose(ctx.evaluation.metrics.scoreMargin.p75, round6(refQuantile(sorted, 0.75)), "p75");
  assertClose(ctx.evaluation.metrics.scoreMargin.p90, round6(refQuantile(sorted, 0.9)), "p90");
  assertClose(ctx.evaluation.metrics.scoreMargin.p10, 0.035, "p10 value");
  assertClose(ctx.evaluation.metrics.scoreMargin.p90, 0.45, "p90 value");
});

test("37. the fixed ambiguity bands are correct", async () => {
  const bands = ctx.evaluation.metrics.scoreMargin.bands;
  assertEqual(bands.below_0_05.count, 1, "< 0.05 count");
  assertEqual(bands.below_0_05.fraction, round6(1 / 6), "< 0.05 fraction");
  assertEqual(bands.below_0_10.count, 5, "< 0.10 count");
  assertEqual(bands.below_0_10.fraction, round6(5 / 6), "< 0.10 fraction");
  assertEqual(bands.below_0_20.count, 5, "< 0.20 count");
  assertEqual(bands.below_0_20.fraction, round6(5 / 6), "< 0.20 fraction");
  assertEqual(AMBIGUITY_BANDS.length, 3, "exactly three descriptive ambiguity bands");
});

test("38. the score entropy is correct", async () => {
  const evidence = await collectCohortEvidence({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, cohort: ctx.cohort, verifyIntegrity: true });
  const entropies = evidence.observations.map((row) => refEntropy(nineScoresOf(row.scores)));
  const sorted = [...entropies].sort((a, b) => a - b);
  const stats = ctx.evaluation.metrics.scoreEntropy;
  assertEqual(stats.count, 6, "all six normalized");
  assertEqual(stats.nullCount, 0, "none null");
  assertClose(stats.mean, round6(entropies.reduce((a, b) => a + b, 0) / entropies.length), "the mean score entropy");
  assertClose(stats.median, round6(refQuantile(sorted, 0.5)), "the median score entropy");
  assertClose(stats.p25, round6(refQuantile(sorted, 0.25)), "the p25 score entropy");
  assertClose(stats.p75, round6(refQuantile(sorted, 0.75)), "the p75 score entropy");
});

test("39. zero-sum scores produce a null entropy (never invented)", async () => {
  assertEqual(scoreEntropyOf({}), null, "an empty score object is null");
  assertEqual(scoreEntropyOf({ technical_activity: 0, unrelated_or_noise: 0 }), null, "a zero-sum vector is null");
  assertEqual(scoreEntropyOf({ technical_activity: -1 }), null, "a negative score is null");
  const metrics = computeEvaluationMetrics([
    { recordDigest: "d1", label: "unrelated_or_noise", confidence: 0, scores: {}, channel: "x" },
    { recordDigest: "d2", label: "technical_activity", confidence: 0.9, scores: { technical_activity: 0.9 }, channel: "x" },
  ]);
  assertEqual(metrics.scoreEntropy.count, 1, "only the valid record contributes");
  assertEqual(metrics.scoreEntropy.nullCount, 1, "the invalid record is reported as null");
});

test("40. the channel join uses recordDigest only", async () => {
  const records = ctx.experimentA ? await readResultLines(ctx.classifierRoot, ctx.experimentA.experimentId) : [];
  for (const line of records) {
    const record = JSON.parse(line);
    assertTrue(!("channel" in record), "a classification record never carries a channel");
    assertTrue(!("title" in record) && !("textExcerpt" in record), "a classification record never carries text");
  }
  for (const observation of ctx.evidence.observations) {
    const source = ctx.evidence.sourceByDigest.get(observation.recordDigest);
    assertTrue(Boolean(source), "every observation joins to a frozen source record by digest");
    assertEqual(observation.channel, source.channel, "the channel comes from the frozen source record");
  }
  assertEqual(ctx.evidence.observations.length, 6, "six observations joined");
});

test("41. a missing source record fails closed", async () => {
  const cloneId = "clexp-20260919T000000Z-00000041";
  await cloneExperiment({ fromId: ctx.experimentA.experimentId, toId: cloneId, mutate: () => ({}) });
  const lines = await readResultLines(ctx.classifierRoot, cloneId);
  const first = JSON.parse(lines[0]);
  first.recordDigest = "f".repeat(64);
  lines[0] = JSON.stringify(first);
  await writeResultLines(ctx.classifierRoot, cloneId, lines);
  const experiment = await readExperimentJson(ctx.classifierRoot, cloneId);
  experiment.resultDigest = resultDigestOf(lines.map((line) => JSON.parse(line)));
  experiment.experimentDigest = experimentDigestOf(experiment);
  await writeExperimentJson(ctx.classifierRoot, cloneId, experiment);

  const syntheticCohort = {
    experimentIds: [cloneId],
    sourceCaptureIds: [ctx.captureA.captureId],
  };
  await assertThrows(
    () => collectCohortEvidence({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, cohort: syntheticCohort, verifyIntegrity: false }),
    ClassifierEvaluationJoinError,
    "a classification with no matching source record is refused",
  );
});

test("42. the channel counts are correct", async () => {
  assertDeepEqual(ctx.evaluation.channelCounts, { github: 3, x: 3 }, "github and x each carry three observations");
  assertDeepEqual(ctx.evaluation.metrics.channelCoverage.channels, ["github", "x"], "the channels represented, sorted");
  assertEqual(ctx.evaluation.metrics.channelCoverage.countPerChannel.github, 3, "github count");
  assertEqual(ctx.evaluation.metrics.channelCoverage.fractionPerChannel.github, round6(3 / 6), "github fraction");
  assertEqual(ctx.evaluation.metrics.channelCoverage.fractionPerChannel.x, round6(3 / 6), "x fraction");
});

test("43. the channel × label matrix is correct", async () => {
  const github = ctx.evaluation.metrics.channels.github;
  const x = ctx.evaluation.metrics.channels.x;
  assertEqual(github.labelCounts.technical_activity, 1, "github technical_activity");
  assertEqual(github.labelCounts.project_announcement, 1, "github project_announcement");
  assertEqual(github.labelCounts.unrelated_or_noise, 1, "github unrelated_or_noise");
  assertEqual(github.labelFractions.technical_activity, round6(1 / 3), "github fraction");
  assertEqual(x.labelCounts.promotion_or_marketing, 1, "x promotion_or_marketing");
  assertEqual(x.labelCounts.technical_activity, 1, "x technical_activity");
  assertEqual(x.labelCounts.unrelated_or_noise, 1, "x unrelated_or_noise");
  assertDeepEqual(Object.keys(github.labelCounts), PINNED_LABELS, "the matrix reports all nine labels per channel");
});

test("44. the channel confidence stats are correct", async () => {
  const github = ctx.evaluation.metrics.channels.github;
  const x = ctx.evaluation.metrics.channels.x;
  assertClose(github.meanConfidence, round6((0.9 + 0.6 + 0.4) / 3), "github mean confidence");
  assertClose(github.medianConfidence, 0.6, "github median confidence");
  assertClose(github.meanScoreMargin, round6((0.85 + 0.05 + 0.05) / 3), "github mean margin");
  assertClose(github.medianScoreMargin, 0.05, "github median margin");
  assertClose(x.meanConfidence, round6((0.55 + 0.7 + 0.3) / 3), "x mean confidence");
  assertClose(x.medianConfidence, 0.55, "x median confidence");
  assertClose(x.meanScoreMargin, round6((0.05 + 0.05 + 0.02) / 3), "x mean margin");
  assertClose(x.medianScoreMargin, 0.05, "x median margin");
});

test("45. the noise fraction is correct", async () => {
  assertEqual(ctx.evaluation.metrics.noise.label, "unrelated_or_noise", "the noise label");
  assertEqual(ctx.evaluation.metrics.noise.count, 2, "noise count");
  assertEqual(ctx.evaluation.metrics.noise.fraction, round6(2 / 6), "noise fraction");
  // Phase 5G.1 does NOT discard noise records: they remain in the denominator.
  assertEqual(ctx.evaluation.metrics.labelDistribution.totalClassified, 6, "noise records are still counted");
});

test("46. the promotion fraction is correct (descriptive only)", async () => {
  assertEqual(ctx.evaluation.metrics.promotion.label, "promotion_or_marketing", "the promotion label");
  assertEqual(ctx.evaluation.metrics.promotion.count, 1, "promotion count");
  assertEqual(ctx.evaluation.metrics.promotion.fraction, round6(1 / 6), "promotion fraction");
  const text = canonicalJson(ctx.evaluation).toLowerCase();
  for (const forbidden of ["scam", "fraud", "bot", "manipulation", "spam", "malicious"]) {
    assertTrue(!text.includes(forbidden), `promotion is never framed as '${forbidden}'`);
  }
});

test("47. the largest-label concentration is correct (no verdict)", async () => {
  const concentration = ctx.evaluation.metrics.concentration;
  assertEqual(concentration.largestLabelCount, 2, "the largest label count");
  assertEqual(concentration.largestLabelFraction, round6(2 / 6), "the largest label fraction");
  assertEqual(concentration.largestLabel, "technical_activity", "ties break deterministically by taxonomy order");
});

/* ============================================================================
 * PART 5 — statistical restraint + artifact hygiene (48-53)
 * ==========================================================================*/

test("48. there is NO automated pass/fail verdict anywhere", async () => {
  assertDeepEqual(forbiddenVerdictKeys(ctx.evaluation), [], "no verdict/profitability key anywhere in the artifact");
  for (const key of ["ok", "passed", "failed", "verdict", "status", "recommendation", "taxonomyPassed", "taxonomyFailed"]) {
    assertTrue(!Object.hasOwn(ctx.evaluation, key), `the artifact has no '${key}' field`);
  }
  assertTrue(!/taxonomy (?:passed|failed|is good|is bad)/i.test(canonicalJson(ctx.evaluation)), "no prose verdict");
  const keys = [...new Set([...forbiddenVerdictKeys(ctx.evaluation)])];
  assertDeepEqual(keys, [], "no verdict-shaped key is reachable from the artifact");
});

test("49. there is NO accuracy / truth metric", async () => {
  const keys = [];
  const collect = (value) => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") for (const [key, entry] of Object.entries(value)) { keys.push(key); collect(entry); }
  };
  collect(ctx.evaluation.metrics);
  for (const banned of ["accuracy", "precision", "recall", "f1", "f1Score", "roc", "rocAuc", "auc", "calibration", "calibrationError", "groundTruth", "truth", "correct"]) {
    assertTrue(!keys.includes(banned), `no '${banned}' metric exists`);
  }
  assertEqual(ctx.evaluation.noGroundTruth, true, "the artifact declares noGroundTruth");
  assertTrue(!/accuracy|precision|recall|roc|f1/i.test(canonicalJson(ctx.evaluation.metrics)), "no truth metric appears anywhere in metrics");
});

test("50. there is NO profitability / Arena correlation", async () => {
  assertEqual(ctx.evaluation.noProfitabilityInference, true, "the artifact declares noProfitabilityInference");
  const keys = [];
  const collect = (value) => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") for (const [key, entry] of Object.entries(value)) { keys.push(key); collect(entry); }
  };
  collect(ctx.evaluation);
  for (const banned of ["pnl", "profit", "profitability", "expectedReturn", "arenaScore", "survival", "gateOutcome", "sharpe", "correlation", "returns"]) {
    assertTrue(!keys.includes(banned), `no '${banned}' field exists`);
  }
  for (const file of EVALUATION_SOURCE_FILES) {
    assertTrue(!/\bcorrelate\b|\bpearson\b|\bspearman\b/i.test(stripComments(ctx.sources.get(file))), `${file} never correlates labels against anything`);
  }
});

test("51. the evaluation artifact contains no raw text", async () => {
  assertTrue(auditEvaluationArtifact(ctx.evaluation).length === 0, `the artifact is clean (${auditEvaluationArtifact(ctx.evaluation).join("; ")})`);
  const text = canonicalJson(ctx.evaluation);
  for (const sentinel of ["TITLE-SENT", "EXCERPT-SENT", "Merged a pull request", "Buy now", "nothing notable"]) {
    assertTrue(!text.includes(sentinel), `'${sentinel}' never appears in the evaluation`);
  }
  const disk = await readFile(path.join(ctx.classifierRoot, "evaluations", ctx.evaluation.evaluationId, "evaluation.json"), "utf8");
  assertTrue(!/TITLE-SENT|EXCERPT-SENT/.test(disk), "the persisted bytes carry no excerpt text");
});

test("52. no URLs are persisted", async () => {
  const text = canonicalJson(ctx.evaluation);
  assertTrue(!/https?:\/\//.test(text), "no URL scheme appears");
  assertTrue(!text.includes("sentinel.example"), "no source host appears");
  const disk = await readFile(path.join(ctx.classifierRoot, "evaluations", ctx.evaluation.evaluationId, "evaluation.json"), "utf8");
  assertTrue(!/(?:https?:\/\/|www\.)/.test(disk), "the persisted bytes carry no URL");
});

test("53. no authors are persisted", async () => {
  const text = canonicalJson(ctx.evaluation) + canonicalJson(ctx.cohort);
  assertTrue(!text.includes("AUTHOR-SENT"), "no author id appears");
  assertTrue(!text.includes("authorId") && !text.includes("\"author\""), "no author field appears");
});

/* ============================================================================
 * PART 6 — audit views (54-56)
 * ==========================================================================*/

test("54. the deterministic audit sample is stable", async () => {
  const first = await buildAuditSample({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, cohortId: ctx.cohort.cohortId });
  const second = await buildAuditSample({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, cohortId: ctx.cohort.cohortId });
  assertDeepEqual(first, second, "two audit builds are byte-identical");
  assertEqual(first.perLabel, 3, "up to three observations per label by default");
  // Every label here has at most two observations, so each is fully sampled.
  assertEqual(first.rows.length, 6, "one row per observation");
  const labels = first.rows.map((row) => row.label);
  assertDeepEqual([...new Set(labels)], ["technical_activity", "project_announcement", "promotion_or_marketing", "unrelated_or_noise"], "observed labels in taxonomy order");
  for (const row of first.rows) {
    assertTrue(row.recordDigest.length === 12, "the digest is shortened");
    assertTrue(row.excerpt === null || !/https?:\/\//.test(row.excerpt), "the excerpt carries no URL");
    assertTrue(row.excerpt === null || !row.excerpt.includes("AUTHOR-SENT"), "the excerpt carries no author");
    assertTrue(Array.isArray(row.topScores) && row.topScores.length === 2, "two top scores are shown");
  }
});

test("55. the audit view creates no artifact", async () => {
  const beforeEvals = await readdir(path.join(ctx.classifierRoot, "evaluations")).catch(() => []);
  const beforeCohorts = await readdir(path.join(ctx.classifierRoot, "cohorts")).catch(() => []);
  const beforeTree = await metadataSnapshot(ctx.classifierRoot);
  await buildAuditSample({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, cohortId: ctx.cohort.cohortId });
  await buildLowConfidenceAudit({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, cohortId: ctx.cohort.cohortId, limit: 3 });
  assertDeepEqual(await metadataSnapshot(ctx.classifierRoot), beforeTree, "no file was written or touched");
  assertDeepEqual(await readdir(path.join(ctx.classifierRoot, "evaluations")).catch(() => []), beforeEvals, "no evaluation was added");
  assertDeepEqual(await readdir(path.join(ctx.classifierRoot, "cohorts")).catch(() => []), beforeCohorts, "no cohort was added");
});

test("56. the low-confidence audit is deterministic and clamped", async () => {
  const first = await buildLowConfidenceAudit({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, cohortId: ctx.cohort.cohortId, limit: 3 });
  const second = await buildLowConfidenceAudit({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, cohortId: ctx.cohort.cohortId, limit: "3" });
  assertDeepEqual(first, second, "two low-confidence builds are byte-identical");
  assertEqual(first.limit, 3, "the limit is honoured");
  assertEqual(first.rows[0].confidence, 0.3, "the lowest confidence comes first");
  assertTrue(first.rows[0].confidence <= first.rows[1].confidence, "ascending confidence order");
  const clampedLow = await buildLowConfidenceAudit({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, cohortId: ctx.cohort.cohortId, limit: 0 });
  assertEqual(clampedLow.limit, 1, "a limit below 1 is clamped to 1");
  const clampedHigh = await buildLowConfidenceAudit({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, cohortId: ctx.cohort.cohortId, limit: 1_000 });
  assertEqual(clampedHigh.limit, 100, "a limit above 100 is clamped to 100");
  const defaulted = await buildLowConfidenceAudit({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, cohortId: ctx.cohort.cohortId });
  assertEqual(defaulted.limit, 20, "the default limit is 20");
});

/* ============================================================================
 * PART 7 — offline replay + stats (57-61)
 * ==========================================================================*/

test("57. replay makes ZERO network calls", async () => {
  const { result, calls } = await withOfflineFetch(() => replayEvaluation({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, evaluationId: ctx.evaluation.evaluationId }));
  assertEqual(calls, 0, "zero fetch calls during replay");
  assertEqual(result.networkCalls, 0, "the report says zero network calls");
  assertEqual(result.ok, true, "the replay verified");
});

test("58. replay recomputes the evaluationDigest", async () => {
  const report = await replayEvaluation({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, evaluationId: ctx.evaluation.evaluationId });
  assertEqual(report.ok, true, "replay integrity OK");
  assertEqual(report.evaluationDigest, ctx.evaluation.evaluationDigest, "the stored digest");
  assertEqual(report.checks.metrics, true, "every metric recomputed");
  assertEqual(report.checks.evaluationDigestReproduced, true, "the digest was reproduced");
  assertEqual(report.checks.experimentsIntegrity, true, "every experiment verified");
  assertEqual(report.checks.capturesIntegrity, true, "every capture verified");
});

test("59. one changed stored label breaks replay integrity", async () => {
  const root = path.join(ctx.tmp, "classifier-changed-label");
  await cp(ctx.classifierRoot, root, { recursive: true });
  const lines = await readResultLines(root, ctx.experimentA.experimentId);
  const first = JSON.parse(lines[0]);
  first.label = "community_attention";
  lines[0] = JSON.stringify(first);
  await writeResultLines(root, ctx.experimentA.experimentId, lines);
  const report = await replayEvaluation({ classifierRoot: root, captureRoot: ctx.captureRoot, evaluationId: ctx.evaluation.evaluationId });
  assertEqual(report.ok, false, "the replay FAILED after a label was changed");
  assertEqual(report.checks.evaluationDigest, true, "the artifact itself still matches its own digest");
  assertEqual(report.checks.experimentsIntegrity, false, "the changed experiment was caught");
});

test("60. one changed confidence breaks replay integrity", async () => {
  const root = path.join(ctx.tmp, "classifier-changed-confidence");
  await cp(ctx.classifierRoot, root, { recursive: true });
  const lines = await readResultLines(root, ctx.experimentB.experimentId);
  const first = JSON.parse(lines[0]);
  first.confidence = 0.58;
  first.scores = { ...first.scores, promotion_or_marketing: 0.58 };
  lines[0] = JSON.stringify(first);
  await writeResultLines(root, ctx.experimentB.experimentId, lines);
  const report = await replayEvaluation({ classifierRoot: root, captureRoot: ctx.captureRoot, evaluationId: ctx.evaluation.evaluationId });
  assertEqual(report.ok, false, "the replay FAILED after a confidence was changed");
  assertEqual(report.checks.experimentsIntegrity, false, "the changed confidence was caught");
});

test("61. stats make ZERO network calls", async () => {
  const { result, calls } = await withOfflineFetch(() => evaluationStats({ classifierRoot: ctx.classifierRoot, evaluationId: ctx.evaluation.evaluationId }));
  assertEqual(calls, 0, "zero fetch calls during stats");
  assertEqual(result.networkCalls, 0, "the stats report says zero network calls");
  assertEqual(result.evaluationDigestOk, true, "the digest still matches");
  assertEqual(result.evaluationDigest, ctx.evaluation.evaluationDigest, "the reported digest");
  assertEqual(result.recordCount, 6, "six records");
  assertEqual(result.labelCounts.unrelated_or_noise, 2, "the noise count");
  assertEqual(result.noiseFraction, round6(2 / 6), "the noise fraction");
  assertEqual(result.labelDiversity, ctx.evaluation.metrics.labelDistribution.labelDiversity, "the label diversity");
});

/* ============================================================================
 * PART 8 — CLI behaviour is offline (extra)
 * ==========================================================================*/

test("61b. the CLI runs the whole chain offline", async () => {
  const out = path.join(ctx.tmp, "cli-classifier");
  await mkdir(out, { recursive: true });
  await cp(path.join(ctx.classifierRoot, "experiments"), path.join(out, "experiments"), { recursive: true });
  const frozen = runCli(["--freeze-cohort", "--experiments", ctx.experimentA.experimentId, "--out", out, "--captures", ctx.captureRoot, "--json"]);
  assertEqual(frozen.status, 0, `the CLI froze a cohort (${frozen.stderr})`);
  const cohortId = JSON.parse(frozen.stdout).cohort.cohortId;
  const evaluated = runCli(["--cohort", cohortId, "--out", out, "--captures", ctx.captureRoot, "--json"]);
  assertEqual(evaluated.status, 0, `the CLI evaluated the cohort offline (${evaluated.stderr})`);
  const evaluationId = JSON.parse(evaluated.stdout).evaluation.evaluationId;
  const stats = runCli(["--stats", "--evaluation", evaluationId, "--out", out, "--json"]);
  assertEqual(stats.status, 0, `the CLI printed stats (${stats.stderr})`);
  assertEqual(JSON.parse(stats.stdout).networkCalls, 0, "stats report zero network calls");
  const audit = runCli(["--cohort", cohortId, "--out", out, "--captures", ctx.captureRoot, "--audit", "--json"]);
  assertEqual(audit.status, 0, `the CLI printed the audit (${audit.stderr})`);
  const replay = runCli(["--replay", "--evaluation", evaluationId, "--out", out, "--captures", ctx.captureRoot, "--json"]);
  assertEqual(replay.status, 0, `the CLI replayed the evaluation (${replay.stderr})`);
  assertEqual(JSON.parse(replay.stdout).ok, true, "the CLI replay verified");
  assertEqual(runCli([]).status, 1, "the CLI refuses to run with no action");
});

/* ============================================================================
 * PART 9 — preservation of the rest of the frozen system (62-73)
 * ==========================================================================*/

test("62. the existing external-intelligence packet is unchanged", async () => {
  assertDeepEqual([...ALLOWED_PACKET_KEYS], PINNED_PACKET_KEYS, "the packet key whitelist is byte-for-byte the pinned one");
  const replay = await replayCapture({ root: ctx.captureRoot, captureId: ctx.captureA.captureId, asOf: null });
  const packet = buildExternalIntelligencePacket({ replay });
  assertTrue(Object.keys(packet).every((key) => PINNED_PACKET_KEYS.includes(key)), "a packet built AFTER evaluation has only whitelisted keys");
  assertTrue(!/classif/i.test(JSON.stringify(packet)), "no classifier field in the packet");
  assertEqual(auditExternalIntelligencePacket(packet).routingActive, false, "and no routing is active");
  assertTrue(!/classif/i.test(ctx.sources.get("scripts/intelligence/packet.mjs")), "packet.mjs never mentions the classifier");
  if (ctx.realCaptureAvailable) {
    const real = await replayCapture({ root: REAL_CAPTURE_ROOT, captureId: REAL_V2_CAPTURE_ID, asOf: null });
    assertEqual(buildExternalIntelligencePacket({ replay: real }).packetDigest, REAL_V2_PINS.packetDigest, "the real V2 packet digest is EXACTLY the pinned value");
  } else skip(`the real capture ${REAL_V2_CAPTURE_ID} is not present — the pinned packet digest was skipped`);
});

test("63. the external feature versions are unchanged", async () => {
  assertEqual(DEFAULT_FEATURE_VERSION, "external-intelligence-features-v2", "new captures still pin V2");
  assertEqual(INTELLIGENCE_FEATURE_VERSION, "external-intelligence-features-v1", "V1 is unchanged");
  assertEqual(INTELLIGENCE_FEATURE_VERSION_V2, "external-intelligence-features-v2", "V2 is unchanged");
  assertDeepEqual([...REGISTERED_FEATURE_VERSIONS], ["external-intelligence-features-v1", "external-intelligence-features-v2"], "no third version was registered");
  assertTrue(!/classif/i.test(ctx.sources.get("scripts/intelligence/features.mjs")), "features.mjs never mentions the classifier");
  assertEqual((await readCaptureManifest(ctx.captureRoot, ctx.captureA.captureId)).featureVersion, DEFAULT_FEATURE_VERSION, "the fixture capture pins V2");
});

test("64. the Jev external projection is unchanged", async () => {
  assertEqual(JEV_EXTERNAL_INTELLIGENCE_QUESTION_SET_ID, "jev-external-intelligence-v1", "the Jev question set id is unchanged");
  assertTrue(!/classif/i.test(ctx.sources.get("scripts/jev-external-bridge.mjs")), "the Jev projection never mentions the classifier");
  assertTrue(!/classif/i.test(ctx.sources.get("scripts/jev-external.mjs")), "the Jev external CLI never mentions the classifier");
});

test("65. JEV_ROUTING_ACTIVE is still false", async () => {
  assertEqual(JEV_ROUTING_ACTIVE, false, "JEV_ROUTING_ACTIVE is still false");
  const replay = await replayCapture({ root: ctx.captureRoot, captureId: ctx.captureA.captureId, asOf: null });
  assertEqual(buildExternalIntelligencePacket({ replay }).routing.jevRoutingActive, false, "the packet's Jev routing flag is still false");
  assertTrue(!CLASSIFIER_REFERENCE.test(ctx.sources.get("scripts/jev/questions.mjs")), "the Jev question set never references classifier.dev");
});

test("66. DEEPSEEK_ROUTING_ACTIVE is still false", async () => {
  assertEqual(DEEPSEEK_ROUTING_ACTIVE, false, "DEEPSEEK_ROUTING_ACTIVE is still false");
  const replay = await replayCapture({ root: ctx.captureRoot, captureId: ctx.captureA.captureId, asOf: null });
  assertEqual(buildExternalIntelligencePacket({ replay }).routing.deepseekRoutingActive, false, "the packet's DeepSeek routing flag is still false");
});

test("67. existing Jev experiments are unchanged", async () => {
  assertDeepEqual(await metadataSnapshot(path.join(REPO, ".evolve", "jev")), ctx.evidenceBaseline.jev, "no existing Jev experiment (or any .evolve/jev file) was touched");
});

test("68. Phase 5F.1 provider-health state is unchanged", async () => {
  assertDeepEqual(await metadataSnapshot(path.join(REPO, ".evolve", "jev", "provider-health")), ctx.evidenceBaseline.jevHealth, "the provider-health artifacts are byte-for-byte untouched");
  for (const file of EVALUATION_SOURCE_FILES) assertTrue(!/provider-health|writeProviderHealth|applyTransientExhaustion/.test(ctx.sources.get(file)), `${file} never touches the Jev provider-health store`);
  assertDeepEqual(await metadataSnapshot(REAL_CLASSIFIER_ROOT), ctx.evidenceBaseline.classifier, "and this suite wrote nothing into the repository's .evolve/classifier");
});

test("69. Wave 1 is byte-identical", async () => {
  if (!ctx.evidenceAvailable) return skip("the .evolve replication/history evidence is not present — the Wave 1 case was skipped");
  assertEqual(WAVE_1_DATASET_IDS.length, 3, "Wave 1 is three datasets");
  for (const id of WAVE_1_DATASET_IDS) assertEqual(await datasetFingerprint(id), WAVE_1_DATASET_FINGERPRINTS[id], `${id} still matches its pinned fingerprint`);
  assertEqual(CANONICAL_WAVE_1_REPLICATION_ID, "rep-66884de4e460", "the canonical Wave 1 replication id is unchanged");
  assertEqual(CANONICAL_HISTORICAL_FREEZE_PATH, "phase5c-freeze.json", "the canonical historical freeze path is unchanged");
  assertDeepEqual(await metadataSnapshot(path.join(REPO, ".evolve", "replication", "waves")), ctx.evidenceBaseline.waves, "wave manifests unchanged");
});

test("70. Wave 2 is byte-identical", async () => {
  if (!ctx.evidenceAvailable) return skip("the .evolve replication/history evidence is not present — the Wave 2 case was skipped");
  assertEqual(WAVE_2_DATASET_IDS.length, 3, "Wave 2 is three datasets");
  for (const id of WAVE_2_DATASET_IDS) assertEqual(await datasetFingerprint(id), WAVE_2_DATASET_FINGERPRINTS[id], `${id} still matches its pinned fingerprint`);
});

test("71. the frozen replication cohorts are unchanged", async () => {
  if (!ctx.evidenceAvailable) return skip("the .evolve replication evidence is not present — the cohort case was skipped");
  const mock = await readFrozenCohort(path.join(REPO, ".evolve", "replication"), "mock");
  const deepseek = await readFrozenCohort(path.join(REPO, ".evolve", "replication"), "deepseek");
  assertEqual(mock.cohortDigest, FROZEN_COHORT_DIGESTS.mock, "the Mock cohort digest is unchanged");
  assertEqual(deepseek.cohortDigest, FROZEN_COHORT_DIGESTS.deepseek, "the DeepSeek cohort digest is unchanged");
  assertEqual(mock.immutable, true, "the Mock cohort is still immutable");
  assertEqual(deepseek.frozen, true, "the DeepSeek cohort is still frozen");
  assertDeepEqual(await metadataSnapshot(path.join(REPO, ".evolve", "replication", "cohorts")), ctx.evidenceBaseline.cohorts, "cohort files unchanged");
  assertEqual((await listCohorts(ctx.classifierRoot)).length, 1, "the fixture built exactly one classifier cohort");
});

test("72. the six replication datasets are unchanged", async () => {
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

test("73. the evaluation contract digest is EXACTLY the pinned value", async () => {
  assertEqual(CANONICAL_EVALUATION_CONTRACT_DIGEST, "4cf8ac1fa7db290acadeccf6043ec34c3239f8e3f848e9e50d8560826de85052", "the published contract pin is unchanged");
  if (!ctx.evidenceAvailable) return skip("the stored Wave 1 freeze is not present — the derived-contract case was skipped");
  const stored = await readFreeze({ root: path.join(REPO, ".evolve", "replication") });
  assertEqual(evaluationContractDigest(stored), CANONICAL_EVALUATION_CONTRACT_DIGEST, "the STORED freeze still derives the canonical digest");
});

test("74. the real V2 and legacy V1 captures are unchanged", async () => {
  if (!ctx.realCaptureAvailable) return skip("the real captures are not present — pinned-digest cases were skipped");
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
 * Runner
 * ==========================================================================*/

async function run() {
  let passed = 0;
  const failures = [];
  const started = Date.now();

  try {
    await buildFixtures();
  } catch (error) {
    console.error("could not build Phase 5G.1 fixtures:", error?.stack ?? error);
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
  console.log(`EVOLVE Phase 5G.1 classifier taxonomy evaluation validation: ${passed}/${cases.length} checks passed`);

  if (failures.length > 0) {
    console.log("Failed checks:");
    for (const failure of failures) console.log(`  - ${failure.name}`);
    process.exitCode = 1;
  } else {
    console.log("All Phase 5G.1 checks passed. Frozen classifier experiments are grouped into an explicit immutable");
    console.log("DEVELOPMENT cohort and evaluated OFFLINE into a descriptive, text-free artifact: label distribution and");
    console.log("diversity, confidence statistics and fixed descriptive bands, per-label confidence, score margins and");
    console.log("ambiguity bands, score entropy, channel × label, noise, promotion and concentration — with NO ground truth,");
    console.log("NO accuracy/precision/recall, NO profitability correlation and NO automated verdict.");
  }
}

run().catch((error) => {
  console.error("phase 5G.1 validation runner crashed:", error);
  process.exitCode = 1;
});
