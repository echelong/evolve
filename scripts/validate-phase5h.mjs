#!/usr/bin/env node
/**
 * EVOLVE Phase 5H.0 validation suite — FULLY OFFLINE.
 *
 * DETERMINISTIC CLASSIFIER-DERIVED FEATURES:
 *
 *   frozen 5G.1 cohort → verify cohort → verify classifier experiments
 *     → verify source captures → classifier-feature-definition-v1
 *     → record-level deterministic extraction → feature artifact
 *     → offline replay / audit / stats → STOP
 *
 * Fully OFFLINE and deterministic: no network call, no classifier.dev, no
 * Agent-Reach, no Jev, no DeepSeek, no Arena, no trading, no capture. Fixtures
 * are built in a temp directory with the deterministic mock provider and a
 * scripted classifier fetch; nothing under `.evolve/` is ever written.
 *
 * PART N pins the ONE canonical operator-approved 5H.0 artifact
 * (`clfeat-20260919T173844Z-7a9193bb`) as a READ-ONLY research barrier when it
 * is present locally and skips those cases cleanly when it is absent.
 *
 * The derived features are DESCRIPTIVE ONLY. They are never alpha, signal
 * strength, sentiment, trading direction, project quality, legitimacy, fraud
 * probability, profitability, expected return, market health or buy/sell
 * probability.
 *
 * Run with: npm run validate:phase5h
 */

import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { canonicalJson, digestOf, hashFileBuffered } from "./lib/hash.mjs";

import {
  CLASSIFIER_DEFINITION_DIGEST,
  CLASSIFIER_ID,
  CLASSIFIER_INSTRUCTIONS_DIGEST,
  CLASSIFIER_LABELS,
  CLASSIFIER_VERSION,
  INPUT_PROJECTION_VERSION,
  projectClassifierInput,
} from "./intelligence/classifier-definition.mjs";
import { createClassifierDevProvider } from "./intelligence/classifier-dev.mjs";
import { CAPTURE_MANIFEST_FILE, CAPTURE_RECORDS_FILE, loadCaptureRecords, runCapture, withCaptureManifestDigest } from "./intelligence/capture.mjs";
import { resolveIntelligenceConfig } from "./intelligence/config.mjs";
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
  buildCohortId,
  cohortDigestOf,
  cohortIdentityDigest,
  cohortPathFor,
  collectCohortEvidence,
  evaluationDigestOf,
  freezeCohort,
  readCohort,
  readEvaluation,
  verifyCohort,
} from "./intelligence/classifier-evaluation.mjs";
import {
  CONFIDENCE_HIGH,
  CONFIDENCE_LOW,
  DERIVED_EVIDENCE_CLASS,
  ENTROPY_LOG_BASE,
  ENTROPY_NORMALIZATION_K,
  EVIDENCE_CLASS_MAP,
  FEATURE_ALIASES,
  FEATURE_DEFINITION,
  FEATURE_DEFINITION_DIGEST,
  FEATURE_DEFINITION_VERSION,
  FEATURE_FAMILIES,
  FEATURE_GROUPS,
  FEATURE_NAMES,
  FeatureEvidenceClassError,
  FORBIDDEN_FEATURE_NAME_PATTERNS,
  FORBIDDEN_GROUP_FEATURE_KEYS,
  LABEL_FEATURES,
  MARGIN_AMBIGUOUS,
  QUANTILE_METHOD,
  ROUNDING,
  SCORE_VECTOR_COMPLETENESS,
  SOURCE_EVIDENCE_CLASS,
  assertFeatureDefinitionIntegrity,
  isForbiddenFeatureName,
  labelFeatureName,
  mapEvidenceClass,
} from "./intelligence/classifier-feature-definition.mjs";
import {
  AGGREGATION_MODE,
  AGGREGATION_UNIT,
  FEATURE_ARTIFACT_FIELDS,
  FeatureExistsError,
  FeatureNoEvidenceError,
  FeatureOutputRootError,
  FeatureTimelineError,
  auditClassifierFeatureArtifact,
  buildClassifierFeature,
  buildFeatureId,
  classifierFeatureStats,
  extractClassifierFeatures,
  featureDigestOf,
  featureIdentityDigest,
  featureIdentitySubject,
  isValidFeatureId,
  readFeatureArtifact,
  replayClassifierFeature,
} from "./intelligence/classifier-features.mjs";
import { evaluationContractDigest } from "./replication/contract.mjs";
import { readFreeze } from "./replication/freeze.mjs";
import { readFrozenCohort } from "./replication/cohorts.mjs";
import {
  CANONICAL_EVALUATION_CONTRACT_DIGEST,
  CANONICAL_WAVE_1_REPLICATION_ID,
  WAVE_1_DATASET_FINGERPRINTS,
  WAVE_1_DATASET_IDS,
  WAVE_2_DATASET_FINGERPRINTS,
  WAVE_2_DATASET_IDS,
} from "./replication/waves.mjs";

const REPO = process.cwd();
const REAL_CLASSIFIER_ROOT = path.join(REPO, ".evolve", "classifier");
const REAL_CAPTURE_ROOT = path.join(REPO, ".evolve", "intelligence");
const CAPTURE_DAY = "2026-09-19";

/* Pinned canonical identities (read from the frozen artifacts; nothing live). */
const CANONICAL_COHORT_ID = "clcohort-20260919T163609Z-4d7c6dd9";
const CANONICAL_COHORT_DIGEST = "2a8b9ca38f6f1f9dad7a46426c9a42cece2ca9fa3722815c430d42098b9e1a04";
const CANONICAL_EVALUATION_ID = "cleval-20260919T163609Z-9a7f434a";
const CANONICAL_EVALUATION_DIGEST = "57cd1e53c56fce7a6f6688f296cf0e0816bbe3d4f38f363e28b7e43a1590a870";
const CANONICAL_EXPERIMENT_A = "clexp-20260919T163411Z-52c4be11";
const CANONICAL_EXPERIMENT_A_DIGEST = "6efbd7ef6c2bd262b2b523d83888585dd37c49a985ae4c6c08b4d49fd5bfd3c4";
const CANONICAL_EXPERIMENT_A_RESULT = "52c4be110c371f3d1637c9fb322641dbe50efc8924dec9186dd0f9068dc56fdf";
const CANONICAL_EXPERIMENT_B = "clexp-20260919T163412Z-28f31a82";
const CANONICAL_EXPERIMENT_B_DIGEST = "d86661ae5c80cd0320c4e91aae8c6a6da17a7d69d9bdf5822c97e54196a3b91e";
const CANONICAL_EXPERIMENT_B_RESULT = "28f31a82e44e6933c35395ef8ca9a81724a06b98199cb29b70044c6556c5133c";
const CANONICAL_INFRASTRUCTURE_EXPERIMENT_DIGEST = "58a2067270e0f4b343980f1c1ec2adf9896dfec407527abd6bdc7e55e36a619f";
const CANONICAL_INFRASTRUCTURE_RESULT_DIGEST = "69170f5375168f9cadc2243fc50b74e282b6ab055ae738e5b7478b379d33655d";
const FROZEN_COHORT_DIGESTS = Object.freeze({
  mock: "b26d63a2a0787e954ed7e4e63e668fe4664e58059508145345214facc4e12858",
  deepseek: "13c7c93d707b26f8b92042d488ff0a63f5de3f9f81b8145be4eac7a70cc550a8",
});

/**
 * Canonical Phase 5H.0 research barrier: the ONE operator-approved feature
 * artifact. These are PINNED identities (never rewritten). The artifact itself
 * stays under the gitignored `.evolve/classifier/features/` tree and is NEVER
 * copied into Git; the cases in PART N inspect it READ-ONLY when it is present
 * locally and skip cleanly when it is not.
 */
const CANONICAL_FEATURE_ID = "clfeat-20260919T173844Z-7a9193bb";
const CANONICAL_FEATURE_DIGEST = "65218b38f80a344a99f12f8a98784a49250d0ec0b88cd88ea9cd795fab39312b";
const CANONICAL_FEATURE_DEFINITION_VERSION = "classifier-feature-definition-v1";
const CANONICAL_FEATURE_DEFINITION_DIGEST = "9227c8ef12414951bd48fe4c4c2a9ea2d1b69f4485f1019157912e32bc0093bd";
const CANONICAL_FEATURE_SOURCE_COHORT_ID = "clcohort-20260919T163609Z-4d7c6dd9";
const CANONICAL_FEATURE_SOURCE_COHORT_DIGEST = "2a8b9ca38f6f1f9dad7a46426c9a42cece2ca9fa3722815c430d42098b9e1a04";
const CANONICAL_FEATURE_EVIDENCE_CLASS = "DEVELOPMENT_CLASSIFIER_DERIVED_FEATURES";
const CANONICAL_FEATURE_SOURCE_EVIDENCE_CLASS = "DEVELOPMENT_CLASSIFIER_EVIDENCE";
const CANONICAL_FEATURE_EVIDENCE_AS_OF = "2026-09-19T16:34:12.867Z";

/** The exact 19 canonical values of the canonical artifact, typed independently. */
const CANONICAL_FEATURE_VALUES = Object.freeze({
  label_fraction_technical_activity: 0.15,
  label_fraction_project_announcement: 0.11,
  label_fraction_exchange_or_listing: 0.04,
  label_fraction_liquidity_or_market_structure: 0.25,
  label_fraction_security_or_risk: 0,
  label_fraction_governance_or_admin: 0.24,
  label_fraction_community_attention: 0,
  label_fraction_promotion_or_marketing: 0.14,
  label_fraction_unrelated_or_noise: 0.07,
  observed_label_count: 7,
  label_entropy_normalized: 0.822223,
  largest_label_fraction: 0.25,
  confidence_mean: 0.6304,
  confidence_median: 0.62,
  confidence_low_fraction: 0.33,
  confidence_high_fraction: 0.19,
  score_margin_mean: 0.4897,
  score_margin_median: 0.455,
  score_margin_ambiguous_fraction: 0.11,
});

/** EVERY sealed 5G.0 / 5G.1 (and adjacent) source: byte-identical forever. */
const SEALED_SOURCE_DIGESTS = Object.freeze({
  "scripts/intelligence/classifier-definition.mjs": "b6e1acc8439f2e623ec57d79c18075b2959fc5a6638e6570fb4a27b565415f57",
  "scripts/intelligence/classifier-dev.mjs": "f40abcc65abab82164c5fc2de2d2f225962130c025d4a3cc7c7dae2b188533d9",
  "scripts/intelligence/classifier-experiment.mjs": "10bcad15b83577f1984eb4f8d666c3a1435af5132c6af4d05b93ec771e345c03",
  "scripts/intelligence/classifier-evaluation.mjs": "536223fc8be731204271fc63165816cefd13333495a4beb0f31e8d361c548f1c",
  "scripts/intelligence-classify.mjs": "6c11ab8059768d8b42daa44058ca9f4b307eb0fe40502acce1505c7d3d237aec",
  "scripts/intelligence-classify-eval.mjs": "03cf62c21a11dda75e4693981a659509cfe4f4a4093e5cb92bd4a1b26b900aff",
  "scripts/intelligence/packet.mjs": "ff8a2e6a341bf48251d24ac064ca6da2a7e14791fe2b9956559e3948e5094bcd",
  "scripts/intelligence/features.mjs": "cceb08e03ca8a573c0b6303f0d8b0afe143610e92c35e695d117dc344a5d62ab",
  "scripts/intelligence/replay.mjs": "387ada485c5282a7be116073201d47e48d3c28be5be42547eb87ba014eedbc46",
  "scripts/intelligence/capture.mjs": "9e22b8ac4f70a0aca74150412ad1da2a65518165d4b52fa12e53602bb2509251",
  "scripts/intelligence/dashboard.mjs": "d8584c909bca20fd6328b4de2d3156910d11cc87154003a4f25890876fb69d51",
  "scripts/lib/dashboard-state.mjs": "90f069c35d46e4a5cfa881254262d1b1efedc2644476f2c641a4ca8286d92e49",
});

/** Every canonical Agent-Reach capture of the frozen day: manifest digest pins. */
const CANONICAL_CAPTURE_DIGESTS = Object.freeze({
  "capture-20260919T122601Z": "76241b868f7e2839b04cb6f1328172ce01c7fff9fa0a071f92bd7e69d01a2ce2",
  "capture-20260919T130756Z": "4e9b460fc190fc1bff793b3fea5f294fcdf1d76d51f19844db7b57431deba1ac",
  "capture-20260919T151303Z": "a731818f61b1894820fcfd67cce43b34a543d9e0d3e02deb96fd0ed29f582c82",
  "capture-20260919T154222003Z": "4edee0e38159cffeb72b34af358c132babc2966e18c1829db2bc2f72d3c42f29",
  "capture-20260919T154517620Z": "f8846da593194cd4e09552bc33d1ba817e683dac3c5c85ff8c393a82e77f2252",
  "capture-20260919T160610944Z": "dedf590f286046a9228706c8eddc58d22e7eb92001ecc45307f8a4168682ce2f",
  "capture-20260919T162813408Z": "7112aa4af6fd15bd052be0d05430b18fedd1fc27407658bdb31074d21142ff5d",
  "capture-20260919T163204542Z": "a829c9bad5b2ffa3b0ea675e094228018d98b4c1b4421305269ab0d8de7a0e81",
  "capture-20260919T163221722Z": "d0b85c95c06171fe74b362b2ba715a61ac8dfb499a057d1f6d78ac60a52b0d2f",
});

/** The exact canonical feature-key order, typed INDEPENDENTLY of the definition. */
const EXPECTED_FEATURE_NAMES = Object.freeze([
  "label_fraction_technical_activity",
  "label_fraction_project_announcement",
  "label_fraction_exchange_or_listing",
  "label_fraction_liquidity_or_market_structure",
  "label_fraction_security_or_risk",
  "label_fraction_governance_or_admin",
  "label_fraction_community_attention",
  "label_fraction_promotion_or_marketing",
  "label_fraction_unrelated_or_noise",
  "observed_label_count",
  "label_entropy_normalized",
  "largest_label_fraction",
  "confidence_mean",
  "confidence_median",
  "confidence_low_fraction",
  "confidence_high_fraction",
  "score_margin_mean",
  "score_margin_median",
  "score_margin_ambiguous_fraction",
]);

const RUNTIME_FILES = Object.freeze([
  "scripts/intelligence/classifier-feature-definition.mjs",
  "scripts/intelligence/classifier-features.mjs",
  "scripts/intelligence-classify-features.mjs",
]);

const FORBIDDEN_IMPORT_PATTERN = /jev|deepseek|research|arena|trading|replication/i;

/* ============================================================================
 * Harness
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
function assertThrows(fn, predicate, message) {
  let thrown = null;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  if (thrown === null) fail(`${message} — nothing was thrown`);
  const matched =
    typeof predicate === "function"
      ? predicate.prototype instanceof Error
        ? thrown instanceof predicate
        : Boolean(predicate(thrown))
      : thrown?.name === predicate;
  if (!matched) fail(`${message} — threw ${thrown?.name ?? "an error"}: ${thrown?.message ?? thrown}`);
  return thrown;
}
async function assertRejects(promise, predicate, message) {
  const thrown = await promise.then(
    () => null,
    (error) => error,
  );
  if (thrown === null) fail(`${message} — nothing was thrown`);
  const matched =
    typeof predicate === "function"
      ? predicate.prototype instanceof Error
        ? thrown instanceof predicate
        : Boolean(predicate(thrown))
      : thrown?.name === predicate;
  if (!matched) fail(`${message} — threw ${thrown?.name ?? "an error"}: ${thrown?.message ?? thrown}`);
  return thrown;
}
function skip(reason) {
  skips.push(reason);
}
async function exists(target) {
  return stat(target).then(() => true).catch(() => false);
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
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
function importSpecifiers(source) {
  const out = [];
  const pattern = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;
  for (const match of stripComments(source).matchAll(pattern)) out.push(match[1]);
  return out;
}
function scan(sources, pattern) {
  const hits = [];
  for (const [file, source] of sources) {
    const lines = stripComments(source).split("\n");
    lines.forEach((line, index) => {
      if (pattern.test(line)) hits.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  return hits;
}
function runCli(args, env = {}) {
  return spawnSync(process.execPath, [path.join(REPO, "scripts", "intelligence-classify-features.mjs"), ...args], {
    encoding: "utf8",
    cwd: REPO,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
  });
}
function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

/* ============================================================================
 * Fixture clock + deterministic evidence shapes
 * ==========================================================================*/

/** Base fixture clock: safely BEFORE any plausible "now", so the real CLI clock is later. */
const T = Date.parse("2026-09-19T08:00:00.000Z");
const BUILD_NOW = T + 3_600_000; // 09:00 — after every fixture evidence time
const CAPTURE_BIG_TIME = T;
const CAPTURE_SMALL_TIME = T + 60_000;
const CAPTURE_TINY_TIME = T + 1_800_000; // deliberately LATER than every fixture experiment
const EXPERIMENT_BIG_TIME = T + 120_000;
const EXPERIMENT_SEVEN_TIME = T + 180_000;
const EXPERIMENT_BIG2_TIME = T + 240_000;
const EXPERIMENT_SMALL_TIME = T + 300_000;
const EXPERIMENT_INCOMPLETE_TIME = T + 360_000;
const EXPERIMENT_TINY_TIME = T + 420_000;
const EXPERIMENT_ALL_INCOMPLETE_TIME = T + 480_000;
const CLI_EVIDENCE_AS_OF = Date.parse("2026-09-19T08:30:00.000Z");

const CLFEAT_PATTERN = /^clfeat-\d{8}T\d{6}Z-[0-9a-f]{8}$/;
const SEVEN_LABELS = CLASSIFIER_LABELS.slice(0, 7);
const SEVEN_COUNTS = Object.freeze([8, 8, 8, 7, 7, 6, 6]);

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

function scoresWithWinner(label, winner = 1, others = 0) {
  const scores = {};
  for (const name of CLASSIFIER_LABELS) scores[name] = name === label ? winner : others;
  return scores;
}

function bigRaw(index) {
  return {
    id: `big-${index}`,
    url: `https://sentinel.example/big/${index}`,
    publishedAt: "2026-09-19T07:00:00.000Z",
    author: `AUTHOR-BIG-${index}`,
    title: `Big fixture record ${index}`,
    text: `Observation ${index} of the big fixture capture.`,
    engagement: 100 + index,
  };
}

function smallRaw(index) {
  return {
    id: `small-${index}`,
    url: `https://sentinel.example/small/${index}`,
    author: `AUTHOR-SMALL-${index}`,
    title: `Small fixture record ${index}`,
    text: `Observation ${index} of the small fixture capture.`,
  };
}

/** Four records; the LAST one has no title/excerpt, so it is skipped by projection. */
function tinyRaws() {
  return [
    { id: "tiny-0", url: "https://sentinel.example/tiny/0", author: "AUTHOR-TINY-0", title: "Tiny fixture record 0", text: "Observation 0 of the tiny fixture capture." },
    { id: "tiny-1", url: "https://sentinel.example/tiny/1", author: "AUTHOR-TINY-1", title: "Tiny fixture record 1", text: "Observation 1 of the tiny fixture capture." },
    { id: "tiny-2", url: "https://sentinel.example/tiny/2", author: "AUTHOR-TINY-2", title: "Tiny fixture record 2", text: "Observation 2 of the tiny fixture capture." },
    { id: "tiny-empty", url: "https://sentinel.example/tiny/3", author: "AUTHOR-TINY-3", engagement: 7 },
  ];
}

/** 50 records, ALL label technical_activity, confidence 0.8, margin 1.0. */
function bigPlan() {
  return Array.from({ length: 50 }, () => ({ label: "technical_activity", confidence: 0.8, scores: scoresWithWinner("technical_activity") }));
}

/** 50 records over SEVEN labels with counts [8, 8, 8, 7, 7, 6, 6]. */
function sevenPlan() {
  const plan = [];
  SEVEN_COUNTS.forEach((count, index) => {
    for (let i = 0; i < count; i += 1) plan.push({ label: SEVEN_LABELS[index], confidence: 0.7, scores: scoresWithWinner(SEVEN_LABELS[index]) });
  });
  return plan;
}

/** 50 records, ALL label liquidity_or_market_structure (duplicate-capture cohort). */
function big2Plan() {
  return Array.from({ length: 50 }, () => ({ label: "liquidity_or_market_structure", confidence: 0.7, scores: scoresWithWinner("liquidity_or_market_structure") }));
}

/** 5 records, ALL label project_announcement, confidence 0.6, margin 1.0. */
function smallPlan() {
  return Array.from({ length: 5 }, () => ({ label: "project_announcement", confidence: 0.6, scores: scoresWithWinner("project_announcement") }));
}

/**
 * 5 records: THREE complete score vectors with margins [1, 0.05, 0.5] and TWO
 * incomplete vectors (one label key removed) that must be excluded from the
 * margin denominator only.
 */
function incompletePlan() {
  const first = { label: "technical_activity", confidence: 0.75, scores: scoresWithWinner("technical_activity") };
  const second = { label: "exchange_or_listing", confidence: 0.75, scores: scoresWithWinner("exchange_or_listing") };
  delete second.scores.unrelated_or_noise;
  const third = { label: "technical_activity", confidence: 0.75, scores: { ...scoresWithWinner(null, 0, 0), technical_activity: 0.7, project_announcement: 0.65 } };
  const fourth = { label: "exchange_or_listing", confidence: 0.75, scores: scoresWithWinner("exchange_or_listing") };
  delete fourth.scores.community_attention;
  const fifth = { label: "technical_activity", confidence: 0.75, scores: { ...scoresWithWinner(null, 0, 0), technical_activity: 0.9, project_announcement: 0.4 } };
  return [first, second, third, fourth, fifth];
}

/** 3 hand-computable records: confidences [0.5, 0.9, 0.9] and margins [0.1, 0.1, 0.05]. */
function tinyPlan() {
  return [
    { label: "technical_activity", confidence: 0.5, scores: { ...scoresWithWinner(null, 0, 0), technical_activity: 0.9, project_announcement: 0.8 } },
    { label: "project_announcement", confidence: 0.9, scores: { ...scoresWithWinner(null, 0, 0), project_announcement: 0.7, technical_activity: 0.6 } },
    { label: "project_announcement", confidence: 0.9, scores: { ...scoresWithWinner(null, 0, 0), project_announcement: 0.5, technical_activity: 0.45 } },
  ];
}

/** 3 records, EVERY score vector incomplete: the margin features must be null. */
function allIncompletePlan() {
  return Array.from({ length: 3 }, () => {
    const scores = scoresWithWinner("technical_activity", 1, 0);
    delete scores.community_attention;
    return { label: "technical_activity", confidence: 0.5, scores };
  });
}

function planFetch(plan) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    const results = body.inputs.map((_input, index) => {
      const entry = plan[index];
      if (!entry) throw new Error(`fixture plan is missing entry ${index}`);
      return { label: entry.label, confidence: entry.confidence, scores: entry.scores };
    });
    const payload = { tier: "fast", model: "fixture-model-1", results, usage: { classifications: results.length, escalated: 0, ms: 1 } };
    return new Response(JSON.stringify(payload), { status: 200, headers: {} });
  };
}

function makeProvider(plan, now) {
  return createClassifierDevProvider({
    fetchImpl: planFetch(plan),
    sleepImpl: async () => {},
    randomImpl: () => 0.5,
    now: () => now,
    settings: { maxAttempts: 1, backoffBaseMs: 0, backoffMaxMs: 0, timeoutMs: 5_000 },
  });
}

/* ============================================================================
 * Fixtures
 * ==========================================================================*/

const ctx = {
  tmp: null,
  captureRoot: null,
  classifierRoot: null,
  cliRoot: null,
  captureIds: {},
  experiments: {},
  cohorts: {},
  features: {},
  refusal: {},
  sources: new Map(),
  baseline: {},
  canonical: {},
};

const CANDIDATE = Object.freeze({ symbol: "PHASE5H", name: "Phase 5H Fixture", mint: "P5HMint111111111111111111111111111111111", domain: "fixture.example", handle: "@phase5h" });

function captureExecutor(raws, perCall) {
  let calls = 0;
  return async () => {
    const slice = raws.slice(calls * perCall, (calls + 1) * perCall);
    calls += 1;
    return { ok: true, records: slice, backendVersion: "fixture", syntheticIntelligence: true };
  };
}

async function makeCapture({ name, raws, perCall, now }) {
  const result = await runCapture({
    root: ctx.captureRoot,
    config: resolveIntelligenceConfig({ EVOLVE_INTELLIGENCE_PROVIDER: "mock", EVOLVE_REACH_CHANNELS: "web" }),
    candidates: [{ ...CANDIDATE }],
    provider: "mock",
    now,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    executor: captureExecutor(raws, perCall),
  });
  ctx.captureIds[name] = result.manifest.captureId;
  // `runCapture` stamps endedAt/finalizedAt from the WALL clock. For a fully
  // deterministic fixture timeline the manifest times are pinned to the injected
  // clock and the manifest digest is recomputed with the SEALED helper — the
  // capture then verifies exactly as it would in production.
  const dir = path.join(ctx.captureRoot, CAPTURE_DAY, result.manifest.captureId);
  const manifest = JSON.parse(await readFile(path.join(dir, CAPTURE_MANIFEST_FILE), "utf8"));
  const iso = new Date(now).toISOString();
  manifest.startedAt = iso;
  manifest.endedAt = iso;
  manifest.finalizedAt = iso;
  await writeFile(path.join(dir, CAPTURE_MANIFEST_FILE), `${JSON.stringify(withCaptureManifestDigest(manifest), null, 2)}\n`, "utf8");
  return result;
}

async function makeExperiment({ name, captureId, plan, now }) {
  const result = await runClassification({
    captureRoot: ctx.captureRoot,
    outRoot: ctx.classifierRoot,
    captureId,
    classifierId: CLASSIFIER_ID,
    provider: makeProvider(plan, now),
    save: true,
    now: () => now,
  });
  if (!result.ok) throw new Error(`fixture classification failed: ${result.reason}`);
  ctx.experiments[name] = result.experiment.experimentId;
  return result.experiment;
}

async function readExperimentJson(experimentId, classifierRoot = ctx.classifierRoot) {
  return JSON.parse(await readFile(path.join(classifierExperimentDir(classifierRoot, experimentId), CLASSIFIER_EXPERIMENT_FILE), "utf8"));
}

async function writeExperimentJson(experimentId, experiment, classifierRoot = ctx.classifierRoot) {
  await writeFile(path.join(classifierExperimentDir(classifierRoot, experimentId), CLASSIFIER_EXPERIMENT_FILE), `${JSON.stringify(experiment, null, 2)}\n`, "utf8");
}

async function readResultLines(experimentId) {
  const text = await readFile(path.join(classifierExperimentDir(ctx.classifierRoot, experimentId), CLASSIFIER_RESULTS_FILE), "utf8");
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

async function writeResultLines(experimentId, lines) {
  await writeFile(path.join(classifierExperimentDir(ctx.classifierRoot, experimentId), CLASSIFIER_RESULTS_FILE), `${lines.join("\n")}\n`, "utf8");
}

/** Copy an experiment directory and apply a mutation (digest recomputed by default). */
async function cloneExperiment({ fromName, toId, mutate = (experiment) => experiment, resultLines = null, recomputeDigest = true }) {
  const from = classifierExperimentDir(ctx.classifierRoot, ctx.experiments[fromName]);
  const to = classifierExperimentDir(ctx.classifierRoot, toId);
  await cp(from, to, { recursive: true });
  if (resultLines) await writeResultLines(toId, resultLines);
  const experiment = await readExperimentJson(toId);
  const next = { ...experiment, ...mutate(experiment), experimentId: toId };
  if (resultLines) next.resultDigest = resultDigestOf(resultLines.map((line) => JSON.parse(line)));
  if (recomputeDigest) next.experimentDigest = experimentDigestOf(next);
  await writeExperimentJson(toId, next);
  return next;
}

/** Handcrafted cohort manifest (used ONLY for refusal fixtures). */
async function writeCohortFixture({ name, experimentIds, evidenceClass = SOURCE_EVIDENCE_CLASS, cohortDigestOverride = null }) {
  const experimentDigests = {};
  const resultDigests = {};
  const recordCounts = {};
  const captureIds = new Set();
  for (const experimentId of experimentIds) {
    const experiment = await readExperimentJson(experimentId);
    experimentDigests[experimentId] = experiment.experimentDigest;
    resultDigests[experimentId] = experiment.resultDigest;
    recordCounts[experimentId] = experiment.recordCount;
    captureIds.add(experiment.captureId);
  }
  const createdAt = new Date(BUILD_NOW - 600_000).toISOString();
  const subject = {
    purpose: "DEVELOPMENT",
    evidenceClass,
    classifierId: CLASSIFIER_ID,
    classifierVersion: CLASSIFIER_VERSION,
    inputProjectionVersion: INPUT_PROJECTION_VERSION,
    experimentIds: [...experimentIds].sort(),
    sourceCaptureIds: [...captureIds].sort(),
    experimentDigests,
    resultDigests,
    recordCounts,
    createdAt,
    immutable: true,
    note: "Phase 5H.0 refusal fixture (never a canonical artifact).",
  };
  const cohortId = buildCohortId({ now: Date.parse(createdAt), identityDigest: cohortIdentityDigest(subject) });
  const cohort = { ...subject, cohortId, cohortDigest: cohortDigestOverride ?? cohortDigestOf({ ...subject, cohortId }) };
  await mkdir(path.join(ctx.classifierRoot, "cohorts"), { recursive: true });
  await writeFile(cohortPathFor(ctx.classifierRoot, cohortId), `${JSON.stringify(cohort, null, 2)}\n`, "utf8");
  ctx.cohorts[name] = cohortId;
  return cohortId;
}

async function buildFeature(name, cohortId, now = BUILD_NOW) {
  const result = await buildClassifierFeature({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, cohortId, now: () => now, save: true });
  ctx.features[name] = result.feature;
  return result;
}

async function cloneFixture(name) {
  const base = path.join(ctx.tmp, "clones", name);
  await mkdir(base, { recursive: true });
  const classifierRoot = path.join(base, "classifier");
  const captureRoot = path.join(base, "captures");
  await cp(ctx.classifierRoot, classifierRoot, { recursive: true });
  await cp(ctx.captureRoot, captureRoot, { recursive: true });
  return { classifierRoot, captureRoot };
}

async function eligibleCount(captureId) {
  const records = await loadCaptureRecords(ctx.captureRoot, captureId);
  return records.filter((record) => projectClassifierInput(record).ok).length;
}

async function buildFixtures() {
  ctx.tmp = await mkdtemp(path.join(tmpdir(), "evolve-phase5h-"));
  ctx.captureRoot = path.join(ctx.tmp, "captures");
  ctx.classifierRoot = path.join(ctx.tmp, "classifier");
  ctx.cliRoot = path.join(ctx.tmp, "cli-classifier");
  await mkdir(ctx.captureRoot, { recursive: true });

  await makeCapture({ name: "big", raws: Array.from({ length: 50 }, (_, index) => bigRaw(index)), perCall: 25, now: CAPTURE_BIG_TIME });
  await makeCapture({ name: "small", raws: Array.from({ length: 5 }, (_, index) => smallRaw(index)), perCall: 3, now: CAPTURE_SMALL_TIME });
  await makeCapture({ name: "tiny", raws: tinyRaws(), perCall: 2, now: CAPTURE_TINY_TIME });

  // The deterministic plans must line up EXACTLY with the projected eligible records.
  const expectations = [
    ["big", bigPlan().length],
    ["small", smallPlan().length],
    ["tiny", tinyPlan().length],
  ];
  for (const [name, planned] of expectations) {
    const eligible = await eligibleCount(ctx.captureIds[name]);
    if (eligible !== planned) throw new Error(`fixture capture '${name}' has ${eligible} eligible records but the plan has ${planned}`);
  }

  await makeExperiment({ name: "big", captureId: ctx.captureIds.big, plan: bigPlan(), now: EXPERIMENT_BIG_TIME });
  await makeExperiment({ name: "seven", captureId: ctx.captureIds.big, plan: sevenPlan(), now: EXPERIMENT_SEVEN_TIME });
  await makeExperiment({ name: "big2", captureId: ctx.captureIds.big, plan: big2Plan(), now: EXPERIMENT_BIG2_TIME });
  await makeExperiment({ name: "small", captureId: ctx.captureIds.small, plan: smallPlan(), now: EXPERIMENT_SMALL_TIME });
  await makeExperiment({ name: "incomplete", captureId: ctx.captureIds.small, plan: incompletePlan(), now: EXPERIMENT_INCOMPLETE_TIME });
  await makeExperiment({ name: "tiny", captureId: ctx.captureIds.tiny, plan: tinyPlan(), now: EXPERIMENT_TINY_TIME });
  await makeExperiment({ name: "allIncomplete", captureId: ctx.captureIds.tiny, plan: allIncompletePlan(), now: EXPERIMENT_ALL_INCOMPLETE_TIME });

  await freezeCohort({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, experimentIds: [ctx.experiments.big, ctx.experiments.small], now: () => BUILD_NOW - 300_000 });
  await freezeCohort({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, experimentIds: [ctx.experiments.big], now: () => BUILD_NOW - 290_000 });
  await freezeCohort({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, experimentIds: [ctx.experiments.seven], now: () => BUILD_NOW - 280_000 });
  await freezeCohort({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, experimentIds: [ctx.experiments.big, ctx.experiments.big2], now: () => BUILD_NOW - 270_000 });
  await freezeCohort({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, experimentIds: [ctx.experiments.small, ctx.experiments.tiny], now: () => BUILD_NOW - 260_000 });
  await freezeCohort({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, experimentIds: [ctx.experiments.tiny], now: () => BUILD_NOW - 250_000 });
  await freezeCohort({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, experimentIds: [ctx.experiments.incomplete], now: () => BUILD_NOW - 240_000 });
  await freezeCohort({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, experimentIds: [ctx.experiments.allIncomplete], now: () => BUILD_NOW - 230_000 });

  const cohortFiles = (await readdir(path.join(ctx.classifierRoot, "cohorts"))).filter((name) => name.endsWith(".json")).sort();
  const frozen = [];
  for (const file of cohortFiles) frozen.push(JSON.parse(await readFile(path.join(ctx.classifierRoot, "cohorts", file), "utf8")));
  const cohortByExperimentCount = {};
  for (const cohort of frozen) cohortByExperimentCount[cohort.experimentIds.join(",")] = cohort.cohortId;
  ctx.cohorts.weight = cohortByExperimentCount[[ctx.experiments.big, ctx.experiments.small].join(",")];
  ctx.cohorts.single = cohortByExperimentCount[[ctx.experiments.big].join(",")];
  ctx.cohorts.seven = cohortByExperimentCount[[ctx.experiments.seven].join(",")];
  ctx.cohorts.dup = cohortByExperimentCount[[ctx.experiments.big, ctx.experiments.big2].join(",")];
  ctx.cohorts.mixed = cohortByExperimentCount[[ctx.experiments.small, ctx.experiments.tiny].join(",")];
  ctx.cohorts.tiny = cohortByExperimentCount[[ctx.experiments.tiny].join(",")];
  ctx.cohorts.incomplete = cohortByExperimentCount[[ctx.experiments.incomplete].join(",")];
  ctx.cohorts.null = cohortByExperimentCount[[ctx.experiments.allIncomplete].join(",")];

  await buildFeature("weight", ctx.cohorts.weight);
  await buildFeature("single", ctx.cohorts.single);
  await buildFeature("seven", ctx.cohorts.seven);
  await buildFeature("dup", ctx.cohorts.dup);
  await buildFeature("mixed", ctx.cohorts.mixed);
  await buildFeature("tiny", ctx.cohorts.tiny);
  await buildFeature("incomplete", ctx.cohorts.incomplete);
  await buildFeature("null", ctx.cohorts.null);

  // Refusal fixtures: cloned, deliberately-broken experiment evidence.
  await cloneExperiment({ fromName: "tiny", toId: "clexp-20260919T080700Z-00000001", resultLines: [], mutate: () => ({ classifiedCount: 0, recordCount: 4, skippedEmptyCount: 4 }) });
  await cloneExperiment({ fromName: "tiny", toId: "clexp-20260919T080700Z-00000002", mutate: () => ({ classifierId: "other-classifier-v1" }) });
  await cloneExperiment({ fromName: "tiny", toId: "clexp-20260919T080700Z-00000003", mutate: () => ({ classifierVersion: 2 }) });
  await cloneExperiment({ fromName: "tiny", toId: "clexp-20260919T080700Z-00000004", mutate: () => ({ classifierVersion: 3 }) });
  await cloneExperiment({ fromName: "tiny", toId: "clexp-20260919T080700Z-00000005", mutate: () => ({ inputProjectionVersion: "classifier-input-projection-v2" }) });
  await cloneExperiment({ fromName: "tiny", toId: "clexp-20260919T080700Z-00000006", mutate: () => ({ inputProjectionVersion: "classifier-input-projection-v3" }) });
  await cloneExperiment({ fromName: "tiny", toId: "clexp-20260919T080700Z-00000007", mutate: () => ({ classifierDefinitionDigest: "a".repeat(64) }) });
  await cloneExperiment({ fromName: "tiny", toId: "clexp-20260919T080700Z-00000008", mutate: () => ({ classifierDefinitionDigest: "b".repeat(64) }) });
  await cloneExperiment({ fromName: "tiny", toId: "clexp-20260919T080700Z-00000009", mutate: () => ({ instructionsDigest: "c".repeat(64) }) });
  await cloneExperiment({ fromName: "tiny", toId: "clexp-20260919T080700Z-00000010", mutate: () => ({ instructionsDigest: "d".repeat(64) }) });
  const badLabelLines = await readResultLines(ctx.experiments.tiny);
  const badLabelFirst = JSON.parse(badLabelLines[0]);
  badLabelFirst.label = "not_a_frozen_label";
  badLabelLines[0] = JSON.stringify(badLabelFirst);
  await cloneExperiment({ fromName: "tiny", toId: "clexp-20260919T080700Z-00000011", resultLines: badLabelLines });

  await writeCohortFixture({ name: "zero", experimentIds: ["clexp-20260919T080700Z-00000001"] });
  await writeCohortFixture({ name: "wrongId", experimentIds: ["clexp-20260919T080700Z-00000002"] });
  await writeCohortFixture({ name: "version2", experimentIds: ["clexp-20260919T080700Z-00000003"] });
  await writeCohortFixture({ name: "mixedVersions", experimentIds: ["clexp-20260919T080700Z-00000003", "clexp-20260919T080700Z-00000004"] });
  await writeCohortFixture({ name: "mixedProjections", experimentIds: ["clexp-20260919T080700Z-00000005", "clexp-20260919T080700Z-00000006"] });
  await writeCohortFixture({ name: "mixedDefinitions", experimentIds: ["clexp-20260919T080700Z-00000007", "clexp-20260919T080700Z-00000008"] });
  await writeCohortFixture({ name: "mixedInstructions", experimentIds: ["clexp-20260919T080700Z-00000009", "clexp-20260919T080700Z-00000010"] });
  await writeCohortFixture({ name: "badLabel", experimentIds: ["clexp-20260919T080700Z-00000011"] });
  await writeCohortFixture({ name: "badDigest", experimentIds: [ctx.experiments.tiny], cohortDigestOverride: "0".repeat(64) });
  await writeCohortFixture({ name: "wrongEvidenceClass", experimentIds: [ctx.experiments.tiny], evidenceClass: "CLEAN_REPLICATION" });

  // Canonical evidence availability + read-only baselines (never written).
  ctx.canonical.cohortPresent = await exists(path.join(REAL_CLASSIFIER_ROOT, "cohorts", `${CANONICAL_COHORT_ID}.json`));
  ctx.canonical.evaluationPresent = await exists(path.join(REAL_CLASSIFIER_ROOT, "evaluations", CANONICAL_EVALUATION_ID, "evaluation.json"));
  ctx.canonical.experimentsPresent = await exists(path.join(REAL_CLASSIFIER_ROOT, "experiments", CANONICAL_EXPERIMENT_A, CLASSIFIER_EXPERIMENT_FILE));
  ctx.canonical.capturesPresent = await exists(path.join(REAL_CAPTURE_ROOT, CAPTURE_DAY));
  ctx.canonical.replicationPresent = await exists(path.join(REPO, ".evolve", "replication"));
  ctx.canonical.featuresAbsent = !(await exists(path.join(REAL_CLASSIFIER_ROOT, "features")));
  // The canonical Phase 5H.0 barrier artifact is detected READ-ONLY. Its presence
  // is recorded (together with the exact clfeat directory set) so PART N can pin
  // it and K10 can prove this suite created nothing new.
  ctx.canonical.featurePresent = await exists(path.join(REAL_CLASSIFIER_ROOT, "features", CANONICAL_FEATURE_ID, "feature.json"));
  ctx.canonical.clfeatDirs = (await readdir(path.join(REAL_CLASSIFIER_ROOT, "features")).catch(() => []))
    .filter((name) => name.startsWith("clfeat-"))
    .sort();
  ctx.baseline.classifier = await metadataSnapshot(REAL_CLASSIFIER_ROOT);
  ctx.baseline.intelligence = await metadataSnapshot(REAL_CAPTURE_ROOT);
  ctx.baseline.replication = await metadataSnapshot(path.join(REPO, ".evolve", "replication"));

  for (const file of RUNTIME_FILES) ctx.sources.set(file, await readFile(path.join(REPO, file), "utf8").catch(() => ""));
}

async function disposeFixtures() {
  if (ctx.tmp) await rm(ctx.tmp, { recursive: true, force: true });
}

/* ============================================================================
 * PART A — definition
 * ==========================================================================*/

test("A1. the definition pins classifier-feature-definition-v1 at Phase 5H.0", async () => {
  assertEqual(FEATURE_DEFINITION_VERSION, "classifier-feature-definition-v1", "the published definition version");
  assertEqual(FEATURE_DEFINITION.definitionVersion, "classifier-feature-definition-v1", "the definition carries its version");
  assertEqual(FEATURE_DEFINITION.phase, "5H.0", "the definition carries the phase");
});

test("A2. the frozen classifier identity is IMPORTED, not redeclared", async () => {
  assertEqual(FEATURE_DEFINITION.classifierId, CLASSIFIER_ID, "classifierId is imported");
  assertEqual(FEATURE_DEFINITION.classifierId, "reach-signal-type-v1", "and is the frozen classifier");
  assertEqual(FEATURE_DEFINITION.classifierVersion, CLASSIFIER_VERSION, "classifierVersion is imported");
  assertEqual(FEATURE_DEFINITION.classifierVersion, 1, "and is version 1");
  assertDeepEqual(FEATURE_DEFINITION.taxonomyLabels, CLASSIFIER_LABELS, "taxonomyLabels are imported verbatim");
  assertEqual(FEATURE_DEFINITION.classifierDefinitionDigest, CLASSIFIER_DEFINITION_DIGEST, "the classifier definition digest is imported");
  assertEqual(FEATURE_DEFINITION.instructionsDigest, CLASSIFIER_INSTRUCTIONS_DIGEST, "the instructions digest is imported");
  assertEqual(FEATURE_DEFINITION.inputProjectionVersion, INPUT_PROJECTION_VERSION, "the input projection version is imported");
});

test("A3. the taxonomy is exactly nine labels and entropy normalizes over K = 9 with the natural log", async () => {
  assertEqual(CLASSIFIER_LABELS.length, 9, "nine frozen taxonomy labels");
  assertEqual(ENTROPY_NORMALIZATION_K, 9, "entropyNormalizationK is 9");
  assertEqual(FEATURE_DEFINITION.entropyNormalizationK, 9, "and the definition freezes it");
  assertEqual(ENTROPY_LOG_BASE, "natural", "the log base is declared natural");
  assertEqual(FEATURE_DEFINITION.entropyLogBase, "natural", "and frozen in the definition");
  assertEqual(FEATURE_DEFINITION.taxonomyLabels.length, 9, "the entropy normalizer is the ENTIRE taxonomy size");
});

test("A4. the confidence and margin thresholds are frozen with exact boundary semantics", async () => {
  assertDeepEqual(CONFIDENCE_LOW, { comparator: "lt", threshold: 0.5 }, "confidenceLow is lt 0.5 (0.50 is NOT low)");
  assertDeepEqual(CONFIDENCE_HIGH, { comparator: "gte", threshold: 0.9 }, "confidenceHigh is gte 0.9 (0.90 IS high)");
  assertDeepEqual(MARGIN_AMBIGUOUS, { comparator: "lt", threshold: 0.1 }, "marginAmbiguous is lt 0.1 (0.10 is NOT ambiguous)");
  assertDeepEqual(FEATURE_DEFINITION.confidenceLow, { comparator: "lt", threshold: 0.5 }, "the definition freezes confidenceLow");
  assertDeepEqual(FEATURE_DEFINITION.confidenceHigh, { comparator: "gte", threshold: 0.9 }, "the definition freezes confidenceHigh");
  assertDeepEqual(FEATURE_DEFINITION.marginAmbiguous, { comparator: "lt", threshold: 0.1 }, "the definition freezes marginAmbiguous");
});

test("A5. rounding, quantile, completeness and value-domain semantics are frozen", async () => {
  assertEqual(ROUNDING, "round6", "round6 rounding");
  assertEqual(FEATURE_DEFINITION.rounding, "round6", "and frozen");
  assertEqual(QUANTILE_METHOD, "linear_interpolation_sorted_ascending", "the quantile method");
  assertEqual(FEATURE_DEFINITION.quantileMethod, QUANTILE_METHOD, "and frozen");
  assertEqual(SCORE_VECTOR_COMPLETENESS, "all_nine_labels_present", "score-vector completeness");
  assertEqual(FEATURE_DEFINITION.featureValueDomain, "number|null", "the value domain is number|null");
  assertEqual(round6(1.0000004), 1, "round6 rounds away sub-1e-6 noise");
  assertEqual(round6(0.1234565), 0.123457, "round6 rounds at the 6th decimal");
});

test("A6. the feature set is EXACTLY 19 canonical keys in canonical order", async () => {
  assertDeepEqual(FEATURE_NAMES, EXPECTED_FEATURE_NAMES, "the canonical feature order");
  assertEqual(FEATURE_NAMES.length, 19, "exactly 19 features");
  assertEqual(new Set(FEATURE_NAMES).size, 19, "no duplicate feature name");
  assertDeepEqual(FEATURE_DEFINITION.featureNames, EXPECTED_FEATURE_NAMES, "the definition carries them in order");
  assertEqual(LABEL_FEATURES.length, 9, "nine label fractions");
  assertDeepEqual(
    LABEL_FEATURES,
    EXPECTED_FEATURE_NAMES.slice(0, 9),
    "label fractions lead the canonical order",
  );
  const familyUnion = Object.values(FEATURE_FAMILIES).flat();
  assertDeepEqual([...familyUnion].sort(), [...EXPECTED_FEATURE_NAMES].sort(), "the documentation families cover exactly the 19 features");
});

test("A7. the definition declares NO grouped semantic features and is frozen", async () => {
  assertDeepEqual(FEATURE_GROUPS, {}, "groups is empty");
  assertDeepEqual(FEATURE_DEFINITION.groups, {}, "the definition carries an empty groups block");
  assertTrue(Object.isFrozen(FEATURE_GROUPS), "the groups block is frozen");
  assertTrue(Object.isFrozen(FEATURE_NAMES), "the feature names are frozen");
  assertTrue(Object.isFrozen(FEATURE_DEFINITION), "the definition is frozen");
  for (const group of FORBIDDEN_GROUP_FEATURE_KEYS) assertTrue(!FEATURE_NAMES.includes(group), `'${group}' is not a v1 feature`);
});

test("A8. the definition digest is computed, stable and reported", async () => {
  assertEqual(FEATURE_DEFINITION_DIGEST, digestOf(FEATURE_DEFINITION), "the digest is digestOf(the definition subject)");
  assertEqual(FEATURE_DEFINITION_DIGEST, digestOf(FEATURE_DEFINITION), "and is stable inside the process");
  assertTrue(/^[0-9a-f]{64}$/.test(FEATURE_DEFINITION_DIGEST), "the digest is a sha256 hex string");
  console.log(`      definition digest: ${FEATURE_DEFINITION_DIGEST}`);
});

test("A9. the definition carries no trading/quality/profitability semantics in its features", async () => {
  const surface = [...EXPECTED_FEATURE_NAMES, ...Object.keys(FEATURE_ALIASES)].join(" ");
  const forbidden = /bullish|bearish|\balpha\b|signal_strength|opportunity|risk_score|legitimacy|quality|fraud|profit|pnl|expected_return|market_health|direction|sentiment|scam|wallet|\btrade\b|buy|sell/i;
  assertTrue(!forbidden.test(surface), `no feature name carries a trading/quality meaning (got '${surface.match(forbidden)?.[0]}')`);
  for (const name of EXPECTED_FEATURE_NAMES) assertTrue(!isForbiddenFeatureName(name), `'${name}' is a descriptive name`);
});

test("A10. the two presentation aliases are not additional features", async () => {
  assertDeepEqual(Object.keys(FEATURE_ALIASES).sort(), ["noise_fraction", "promotion_fraction"], "exactly two aliases");
  assertEqual(FEATURE_ALIASES.noise_fraction, "label_fraction_unrelated_or_noise", "noise_fraction aliases the noise fraction");
  assertEqual(FEATURE_ALIASES.promotion_fraction, "label_fraction_promotion_or_marketing", "promotion_fraction aliases the promotion fraction");
  for (const [alias, target] of Object.entries(FEATURE_ALIASES)) {
    assertTrue(!FEATURE_NAMES.includes(alias), `'${alias}' is not a persisted feature`);
    assertTrue(FEATURE_NAMES.includes(target), `'${alias}' points at the canonical feature '${target}'`);
  }
});

test("A11. the one-entry evidence class map is exact and everything else fails closed", async () => {
  assertDeepEqual(EVIDENCE_CLASS_MAP, { DEVELOPMENT_CLASSIFIER_EVIDENCE: "DEVELOPMENT_CLASSIFIER_DERIVED_FEATURES" }, "the frozen transition");
  assertEqual(SOURCE_EVIDENCE_CLASS, "DEVELOPMENT_CLASSIFIER_EVIDENCE", "the source class");
  assertEqual(DERIVED_EVIDENCE_CLASS, "DEVELOPMENT_CLASSIFIER_DERIVED_FEATURES", "the derived class");
  assertEqual(mapEvidenceClass(SOURCE_EVIDENCE_CLASS), DERIVED_EVIDENCE_CLASS, "the mapping resolves");
  for (const rejected of ["CLEAN_REPLICATION", "VALIDATION", "TEST", "OOS", "PRODUCTION", "DEVELOPMENT", "", undefined, null]) {
    assertThrows(
      () => mapEvidenceClass(rejected),
      (error) => error instanceof FeatureEvidenceClassError,
      `evidence class '${String(rejected)}' must fail closed`,
    );
  }
});

test("A12. the forbidden feature-name pattern set rejects semantic smuggling", async () => {
  assertTrue(FORBIDDEN_FEATURE_NAME_PATTERNS.length >= 20, "the frozen pattern set is populated");
  for (const smuggled of ["bullish", "bearish_signal", "alpha_score", "signal_strength", "opportunity", "risk_score", "legitimacy", "quality_score", "fraud_probability", "buy_probability", "sell_probability", "profit", "pnl", "expected_return", "market_health", "token_quality", "direction", "sentiment", "scam_score", "pump_probability", "wallet_count", "trade_direction", "transaction_count", "signer_count", "accuracy", "calibration"]) {
    assertTrue(isForbiddenFeatureName(smuggled), `'${smuggled}' is rejected`);
  }
  for (const group of FORBIDDEN_GROUP_FEATURE_KEYS) assertTrue(isForbiddenFeatureName(group), `'${group}' is rejected as a grouped aggregate`);
  for (const name of EXPECTED_FEATURE_NAMES) assertTrue(!isForbiddenFeatureName(name), `'${name}' is allowed`);
  assertTrue(!isForbiddenFeatureName("label_fraction_security_or_risk"), "the taxonomy's own 'risk' label is allowed");
});

test("A13. assertFeatureDefinitionIntegrity reports a clean definition", async () => {
  const report = assertFeatureDefinitionIntegrity();
  assertTrue(report.ok, `the definition is intact: ${report.problems.join("; ")}`);
  assertDeepEqual(report.problems, [], "no problems");
});

/* ============================================================================
 * PART B — identity
 * ==========================================================================*/

test("B1. feature ids are clfeat-<stamp>-<8 hex> and deterministic given the clock and digest", async () => {
  const identityDigest = "a".repeat(64);
  const id = buildFeatureId({ now: Date.parse("2026-09-19T08:00:00.000Z"), identityDigest });
  assertEqual(id, "clfeat-20260919T080000Z-aaaaaaaa", "the deterministic id shape");
  assertTrue(CLFEAT_PATTERN.test(id), "the id matches the published clfeat pattern");
  assertEqual(id, buildFeatureId({ now: Date.parse("2026-09-19T08:00:00.000Z"), identityDigest }), "and is deterministic");
  assertTrue(id !== buildFeatureId({ now: Date.parse("2026-09-19T08:00:00.000Z"), identityDigest: "b".repeat(64) }), "a different digest yields a different id");
  assertTrue(id !== buildFeatureId({ now: Date.parse("2026-09-19T08:00:01.000Z"), identityDigest }), "a different clock yields a different id");
});

test("B2. featureId and featureDigest rederive from a stored artifact", async () => {
  const feature = ctx.features.tiny;
  assertTrue(CLFEAT_PATTERN.test(feature.featureId), "the stored id matches the published pattern");
  assertEqual(feature.featureId, buildFeatureId({ now: Date.parse(feature.createdAt), identityDigest: featureIdentityDigest(feature) }), "the id rederives from the identity subject");
  assertEqual(feature.featureDigest, featureDigestOf(feature), "the digest rederives from the artifact body");
  const stored = await readFeatureArtifact(ctx.classifierRoot, feature.featureId);
  assertEqual(stored.featureDigest, feature.featureDigest, "the bytes on disk carry the same digest");
});

test("B3. malformed feature ids are rejected", async () => {
  for (const bad of ["clfeat-", "clfeat", "clfeat id", "cleval-20260919T163609Z-9a7f434a", "clcohort-x", "", null, undefined, 42]) {
    assertTrue(!isValidFeatureId(bad), `'${String(bad)}' is not a valid feature id`);
  }
  assertTrue(isValidFeatureId("clfeat-20260919T080000Z-aaaaaaaa"), "a valid id is accepted");
  await assertRejects(readFeatureArtifact(ctx.classifierRoot, "clfeat-"), (error) => error.message.includes("invalid feature id"), "reading an invalid id fails closed");
});

test("B4. the identity subject excludes EXACTLY featureId + featureDigest; the digest subject excludes only featureDigest", async () => {
  const feature = ctx.features.tiny;
  const subject = featureIdentitySubject(feature);
  assertTrue(!Object.hasOwn(subject, "featureId"), "featureId is excluded from the identity subject");
  assertTrue(!Object.hasOwn(subject, "featureDigest"), "featureDigest is excluded from the identity subject");
  assertEqual(Object.keys(subject).length, FEATURE_ARTIFACT_FIELDS.length - 2, "and nothing else is excluded");
  const digestSubject = jsonClone(feature);
  delete digestSubject.featureDigest;
  assertEqual(digestOf(digestSubject), feature.featureDigest, "featureDigest covers every other field (including featureId)");
  const renamed = jsonClone(feature);
  renamed.featureId = "clfeat-20260919T080000Z-bbbbbbbb";
  assertEqual(featureIdentityDigest(renamed), featureIdentityDigest(feature), "featureId does not feed the identity digest");
  assertTrue(featureDigestOf(renamed) !== feature.featureDigest, "but featureId DOES feed the featureDigest");
});

test("B5. a different createdAt yields a different featureId (the clock is part of the identity)", async () => {
  const feature = ctx.features.weight;
  const shifted = buildFeatureId({ now: Date.parse(feature.createdAt) + 1_000, identityDigest: featureIdentityDigest(feature) });
  assertTrue(shifted !== feature.featureId, "the id moves with the frozen clock");
  assertEqual(Date.parse(feature.timeline.featureCreatedAt), Date.parse(feature.createdAt), "timeline.featureCreatedAt mirrors createdAt");
});

/* ============================================================================
 * PART C — aggregation (record-weighted, reconstructed record by record)
 * ==========================================================================*/

function entropyOfCounts(counts, normalizer) {
  const total = counts.reduce((sum, count) => sum + count, 0);
  let entropy = 0;
  for (const count of counts) {
    if (count > 0) {
      const p = count / total;
      entropy -= p * Math.log(p);
    }
  }
  return entropy / Math.log(normalizer);
}

test("C1. the weighting cohort pools counts across a 50-record and a 5-record experiment", async () => {
  const feature = ctx.features.weight;
  assertEqual(feature.experimentCount, 2, "two experiments");
  assertEqual(feature.captureCount, 2, "two source captures");
  assertEqual(feature.classifiedCount, 55, "C = 50 + 5 = 55 pooled classified records");
  assertEqual(feature.recordCount, 55, "and 55 pooled source records");
  assertEqual(feature.counts.labelCounts.technical_activity, 50, "the 50-record experiment contributes 50");
  assertEqual(feature.counts.labelCounts.project_announcement, 5, "the 5-record experiment contributes 5");
  assertEqual(
    Object.values(feature.counts.labelCounts).reduce((sum, count) => sum + count, 0),
    55,
    "the label counts sum to the pooled classified count",
  );
  assertEqual(feature.experimentRecordCounts[ctx.experiments.big], 50, "per-experiment record count: 50");
  assertEqual(feature.experimentRecordCounts[ctx.experiments.small], 5, "per-experiment record count: 5");
});

test("C2. pooled fractions use TOTAL counts, not per-experiment fractions", async () => {
  const feature = ctx.features.weight;
  assertEqual(feature.features.label_fraction_technical_activity, round6(50 / 55), "technical_activity = 50/55");
  assertEqual(feature.features.label_fraction_technical_activity, 0.909091, "and rounds to 0.909091");
  assertEqual(feature.features.label_fraction_project_announcement, round6(5 / 55), "project_announcement = 5/55");
  assertEqual(feature.features.label_fraction_project_announcement, 0.090909, "and rounds to 0.090909");
  assertEqual(feature.features.largest_label_fraction, round6(50 / 55), "the modal fraction is the pooled one");
});

test("C3. equal experiment weighting would give a DIFFERENT answer", async () => {
  const feature = ctx.features.weight;
  // Equal weighting would average per-experiment fractions: (1 + 0) / 2 = 0.5.
  const equalWeightedTechnical = (1 + 0) / 2;
  const equalWeightedProject = (0 + 1) / 2;
  assertEqual(equalWeightedTechnical, 0.5, "equal weighting would report 0.5");
  assertTrue(feature.features.label_fraction_technical_activity !== equalWeightedTechnical, "the pooled answer DIFFERS from equal weighting");
  assertTrue(feature.features.label_fraction_project_announcement !== equalWeightedProject, "for the second label too");
  assertEqual(feature.features.label_fraction_technical_activity + feature.features.label_fraction_project_announcement, 1, "the pooled fractions sum to 1 here");
});

test("C4. the artifact carries the pooled answer and NO per-experiment feature vectors", async () => {
  const feature = ctx.features.weight;
  assertDeepEqual(Object.keys(feature.features), EXPECTED_FEATURE_NAMES, "exactly the 19 canonical features");
  const serialized = JSON.stringify(feature.features);
  for (const experimentId of Object.values(ctx.experiments)) assertTrue(!serialized.includes(experimentId), `no experiment id leaks into features (${experimentId})`);
  assertTrue(!Object.hasOwn(feature, "perExperiment" || "experimentFeatures"), "no per-experiment feature block exists");
  assertTrue(!serialized.includes("_per_experiment"), "no per-experiment feature name exists");
});

test("C5. the hand-computable fixture reproduces its label counts and fractions", async () => {
  const feature = ctx.features.tiny;
  assertEqual(feature.classifiedCount, 3, "three classified records");
  assertEqual(feature.recordCount, 4, "four source records");
  assertEqual(feature.skippedEmptyCount, 1, "one empty record was skipped");
  assertEqual(feature.counts.labelCounts.technical_activity, 1, "technical_activity = 1");
  assertEqual(feature.counts.labelCounts.project_announcement, 2, "project_announcement = 2");
  assertEqual(feature.features.label_fraction_technical_activity, round6(1 / 3), "1/3 = 0.333333");
  assertEqual(feature.features.label_fraction_project_announcement, round6(2 / 3), "2/3 = 0.666667");
  assertEqual(feature.features.largest_label_fraction, round6(2 / 3), "the modal label holds 2/3");
});

test("C6. the hand-computable fixture reproduces observed_label_count, entropy and the largest label", async () => {
  const feature = ctx.features.tiny;
  assertEqual(feature.features.observed_label_count, 2, "two labels observed");
  assertEqual(feature.features.label_entropy_normalized, round6(entropyOfCounts([1, 2], 9)), "entropy matches the independent computation");
  assertEqual(feature.counts.largestLabel, "project_announcement", "the modal label");
  assertEqual(feature.counts.largestLabelCount, 2, "with count 2");
});

test("C7. the aggregation block is exactly record-weighted/cohort/experimentsAveraged=false", async () => {
  assertDeepEqual(ctx.features.weight.aggregation, { mode: "record-weighted", unit: "cohort", experimentsAveraged: false }, "the frozen aggregation block");
  assertEqual(AGGREGATION_MODE, "record-weighted", "the published mode");
  assertEqual(AGGREGATION_UNIT, "cohort", "the published unit");
  for (const name of Object.keys(ctx.features)) assertDeepEqual(ctx.features[name].aggregation, ctx.features.weight.aggregation, `artifact ${name} carries the same block`);
});

test("C8. the mixed fixture pools record/classified/skipped counts across experiments", async () => {
  const feature = ctx.features.mixed;
  assertEqual(feature.recordCount, 9, "4 + 5 source records");
  assertEqual(feature.classifiedCount, 8, "3 + 5 classified records");
  assertEqual(feature.skippedEmptyCount, 1, "only the tiny capture had an empty record");
  assertEqual(feature.recordCount, feature.classifiedCount + feature.skippedEmptyCount, "recordCount = classified + skipped");
  assertEqual(feature.counts.labelCounts.technical_activity, 1, "one technical_activity record");
  assertEqual(feature.counts.labelCounts.project_announcement, 7, "two + five project_announcement records");
  assertEqual(feature.experimentCount, 2, "two experiments");
});

/* ============================================================================
 * PART D — feature math
 * ==========================================================================*/

test("D1. every label fraction matches n_l / C for the pooled fixture", async () => {
  const feature = ctx.features.weight;
  for (const label of CLASSIFIER_LABELS) {
    const count = feature.counts.labelCounts[label];
    assertEqual(feature.features[labelFeatureName(label)], round6(count / feature.classifiedCount), `${label} fraction = count / C`);
  }
});

test("D2. a label with zero observations is a TRUE ZERO, never null", async () => {
  const feature = ctx.features.weight;
  for (const label of ["security_or_risk", "community_attention", "exchange_or_listing", "liquidity_or_market_structure", "governance_or_admin", "unrelated_or_noise"]) {
    assertEqual(feature.counts.labelCounts[label], 0, `${label} has zero observations`);
    assertTrue(feature.features[labelFeatureName(label)] === 0, `${label} fraction is exactly 0`);
    assertTrue(feature.features[labelFeatureName(label)] !== null, `${label} fraction is not null`);
  }
});

test("D3. observed_label_count counts only labels with a nonzero count", async () => {
  assertEqual(ctx.features.weight.features.observed_label_count, 2, "weight fixture: 2 observed labels");
  assertEqual(ctx.features.seven.features.observed_label_count, 7, "seven fixture: 7 observed labels");
  assertEqual(ctx.features.tiny.features.observed_label_count, 2, "tiny fixture: 2 observed labels");
  assertEqual(ctx.features.single.features.observed_label_count, 1, "single fixture: 1 observed label");
  assertTrue(Number.isInteger(ctx.features.weight.features.observed_label_count), "it is an integer");
});

test("D4. label entropy is the ln(9)-normalized Shannon entropy", async () => {
  assertEqual(ctx.features.weight.features.label_entropy_normalized, round6(entropyOfCounts([50, 5], 9)), "weight fixture entropy");
  assertEqual(ctx.features.seven.features.label_entropy_normalized, round6(entropyOfCounts([...SEVEN_COUNTS], 9)), "seven fixture entropy");
  const weight = round6(entropyOfCounts([50, 5], 9));
  assertTrue(weight > 0 && weight < 1, "a skewed distribution sits strictly inside (0, 1)");
});

test("D5. a single observed label yields entropy EXACTLY 0", async () => {
  assertEqual(ctx.features.single.features.observed_label_count, 1, "one observed label");
  assertTrue(ctx.features.single.features.label_entropy_normalized === 0, "entropy is exactly 0");
  assertEqual(ctx.features.single.features.label_fraction_technical_activity, 1, "and that label holds 100%");
  const pure = extractClassifierFeatures({ records: Array.from({ length: 4 }, () => ({ label: "unrelated_or_noise", confidence: 0.5, scores: scoresWithWinner(null, 0, 0) })) });
  assertTrue(pure.features.label_entropy_normalized === 0, "and the pure extractor agrees");
});

test("D6. a seven-label distribution is normalized by ln(9), NOT by ln(observed labels)", async () => {
  const feature = ctx.features.seven;
  const withNine = round6(entropyOfCounts([...SEVEN_COUNTS], 9));
  const withSeven = round6(entropyOfCounts([...SEVEN_COUNTS], 7));
  assertEqual(feature.features.label_entropy_normalized, withNine, "the stored entropy uses K = 9");
  assertTrue(feature.features.label_entropy_normalized !== withSeven, "and differs from a K = 7 normalization");
  assertTrue(withNine < withSeven, "because ln(9) > ln(7)");
});

test("D7. largest-label ties resolve in frozen taxonomy order", async () => {
  const records = [
    { label: "exchange_or_listing", confidence: 0.5, scores: scoresWithWinner(null, 0, 0) },
    { label: "technical_activity", confidence: 0.5, scores: scoresWithWinner(null, 0, 0) },
  ];
  const extracted = extractClassifierFeatures({ records });
  assertEqual(extracted.largestLabelCount, 1, "both labels tie at 1");
  assertEqual(extracted.largestLabel, "technical_activity", "the earlier taxonomy label wins the tie");
  assertEqual(extracted.features.largest_label_fraction, 0.5, "the tied fraction is 1/2");
});

test("D8. confidence mean and median match the hand-computable fixture", async () => {
  const feature = ctx.features.tiny;
  assertEqual(feature.features.confidence_mean, round6((0.5 + 0.9 + 0.9) / 3), "mean = 2.3 / 3");
  assertEqual(feature.features.confidence_mean, 0.766667, "and rounds to 0.766667");
  assertEqual(feature.features.confidence_median, 0.9, "median = 0.9");
});

test("D9. 0.50 is NOT low (exact boundary)", async () => {
  assertEqual(ctx.features.tiny.features.confidence_low_fraction, 0, "a 0.50 confidence is not counted as low");
  const extracted = extractClassifierFeatures({
    records: [
      { label: "technical_activity", confidence: 0.49, scores: scoresWithWinner(null, 0, 0) },
      { label: "technical_activity", confidence: 0.5, scores: scoresWithWinner(null, 0, 0) },
    ],
  });
  assertEqual(extracted.features.confidence_low_fraction, 0.5, "0.49 is low, 0.50 is not");
});

test("D10. 0.90 IS high (exact boundary)", async () => {
  assertEqual(ctx.features.tiny.features.confidence_high_fraction, round6(2 / 3), "both 0.90 confidences count as high");
  const extracted = extractClassifierFeatures({
    records: [
      { label: "technical_activity", confidence: 0.89, scores: scoresWithWinner(null, 0, 0) },
      { label: "technical_activity", confidence: 0.9, scores: scoresWithWinner(null, 0, 0) },
    ],
  });
  assertEqual(extracted.features.confidence_high_fraction, 0.5, "0.89 is not high, 0.90 is");
});

test("D11. score-margin mean and median match the hand-computable fixture", async () => {
  const feature = ctx.features.tiny;
  assertEqual(feature.scoreVectorCompleteCount, 3, "three complete score vectors");
  assertEqual(feature.features.score_margin_mean, round6((0.1 + 0.1 + 0.05) / 3), "mean margin = 0.25 / 3");
  assertEqual(feature.features.score_margin_mean, 0.083333, "and rounds to 0.083333");
  assertEqual(feature.features.score_margin_median, 0.1, "median margin = 0.1");
});

test("D12. a margin of exactly 0.10 is NOT ambiguous; 0.05 is", async () => {
  assertEqual(ctx.features.tiny.features.score_margin_ambiguous_fraction, round6(1 / 3), "only the 0.05 margin is ambiguous");
  const extracted = extractClassifierFeatures({
    records: [
      { label: "technical_activity", confidence: 0.5, scores: { ...scoresWithWinner(null, 0, 0), technical_activity: 0.6, project_announcement: 0.5 } },
      { label: "technical_activity", confidence: 0.5, scores: { ...scoresWithWinner(null, 0, 0), technical_activity: 0.55, project_announcement: 0.5 } },
    ],
  });
  assertEqual(extracted.features.score_margin_ambiguous_fraction, 0.5, "0.10 is not ambiguous, 0.05 is");
});

test("D13. evaluation-only diagnostics are NOT persisted", async () => {
  const feature = ctx.features.weight;
  for (const evaluationOnly of [
    "p10",
    "p25",
    "p75",
    "p90",
    "min",
    "max",
    "score_entropy",
    "score_entropy_mean",
    "observed_label_fraction",
    "hhi",
    "noise_fraction",
    "promotion_fraction",
    "technical_fraction",
    "market_structure_fraction",
    "governance_admin_fraction",
    "announcement_fraction",
    "below_0_05",
    "below_0_20",
    "below_0_70",
  ]) {
    assertTrue(!Object.hasOwn(feature.features, evaluationOnly), `'${evaluationOnly}' is not a persisted feature`);
  }
  assertDeepEqual(Object.keys(feature.features), EXPECTED_FEATURE_NAMES, "exactly the 19 canonical keys");
  assertTrue(!JSON.stringify(feature).includes("scoreEntropy"), "score entropy stays evaluation-only");
});

/* ============================================================================
 * PART E — missing / null semantics
 * ==========================================================================*/

test("E1. an incomplete score vector is counted, never invented", async () => {
  const feature = ctx.features.incomplete;
  assertEqual(feature.classifiedCount, 5, "five classified records");
  assertEqual(feature.scoreVectorCompleteCount, 3, "three COMPLETE score vectors");
  assertEqual(feature.scoreVectorIncompleteCount, 2, "two INCOMPLETE score vectors");
  assertEqual(feature.scoreVectorCompleteCount + feature.scoreVectorIncompleteCount, feature.classifiedCount, "complete + incomplete = classified");
});

test("E2. the margin denominator is the COMPLETE-vector count, not classifiedCount", async () => {
  const feature = ctx.features.incomplete;
  assertEqual(feature.features.score_margin_mean, round6((1 + 0.05 + 0.5) / 3), "mean over the THREE complete margins");
  assertEqual(feature.features.score_margin_mean, 0.516667, "0.516667");
  assertEqual(feature.features.score_margin_median, 0.5, "median over the three complete margins");
  assertEqual(feature.features.score_margin_ambiguous_fraction, round6(1 / 3), "one of THREE complete margins is ambiguous");
  assertTrue(feature.features.score_margin_ambiguous_fraction !== round6(1 / 5), "the denominator is NOT classifiedCount");
});

test("E3. when NO score vector is complete the margin features are null, NEVER 0", async () => {
  const feature = ctx.features.null;
  assertEqual(feature.scoreVectorCompleteCount, 0, "no complete score vector");
  assertEqual(feature.scoreVectorIncompleteCount, feature.classifiedCount, "all classified records are incomplete");
  for (const name of ["score_margin_mean", "score_margin_median", "score_margin_ambiguous_fraction"]) {
    assertTrue(feature.features[name] === null, `${name} is null`);
    assertTrue(feature.features[name] !== 0, `${name} is never 0`);
  }
  assertEqual(feature.nullFeatureCount, 3, "exactly three null features");
  assertTrue(auditClassifierFeatureArtifact(feature).ok, "and the artifact still audits clean");
});

test("E4. nullFeatureCount is 0 for complete evidence and 3 for the all-incomplete fixture", async () => {
  for (const name of ["weight", "tiny", "single", "seven", "dup", "mixed"]) {
    assertEqual(ctx.features[name].nullFeatureCount, 0, `${name} has no null feature`);
    assertEqual(ctx.features[name].scoreVectorIncompleteCount, 0, `${name} has complete score vectors throughout`);
  }
  assertEqual(ctx.features.null.nullFeatureCount, 3, "the all-incomplete fixture carries three nulls");
});

test("E5. missing confidence is refused", async () => {
  assertThrows(
    () => extractClassifierFeatures({ records: [{ label: "technical_activity", confidence: undefined, scores: scoresWithWinner(null, 0, 0) }] }),
    (error) => error.name === "FeatureRecordIntegrityError",
    "a missing confidence fails closed",
  );
  assertThrows(
    () => extractClassifierFeatures({ records: [{ label: "technical_activity", scores: scoresWithWinner(null, 0, 0) }] }),
    (error) => error.name === "FeatureRecordIntegrityError",
    "an absent confidence fails closed",
  );
});

test("E6. NaN confidence is refused", async () => {
  assertThrows(
    () => extractClassifierFeatures({ records: [{ label: "technical_activity", confidence: Number.NaN, scores: scoresWithWinner(null, 0, 0) }] }),
    (error) => error.name === "FeatureRecordIntegrityError",
    "NaN confidence fails closed",
  );
  assertThrows(
    () => extractClassifierFeatures({ records: [{ label: "technical_activity", confidence: Number.POSITIVE_INFINITY, scores: scoresWithWinner(null, 0, 0) }] }),
    (error) => error.name === "FeatureRecordIntegrityError",
    "Infinity confidence fails closed",
  );
});

test("E7. confidence below 0 is refused", async () => {
  assertThrows(
    () => extractClassifierFeatures({ records: [{ label: "technical_activity", confidence: -0.000001, scores: scoresWithWinner(null, 0, 0) }] }),
    (error) => error.name === "FeatureRecordIntegrityError",
    "a negative confidence fails closed",
  );
});

test("E8. confidence above 1 is refused", async () => {
  assertThrows(
    () => extractClassifierFeatures({ records: [{ label: "technical_activity", confidence: 1.000001, scores: scoresWithWinner(null, 0, 0) }] }),
    (error) => error.name === "FeatureRecordIntegrityError",
    "a confidence above 1 fails closed",
  );
});

test("E9. an out-of-range or non-numeric score is refused, never coerced", async () => {
  const scores = scoresWithWinner("technical_activity", 1, 0);
  scores.project_announcement = 1.5;
  assertThrows(
    () => extractClassifierFeatures({ records: [{ label: "technical_activity", confidence: 0.5, scores }] }),
    (error) => error.name === "FeatureRecordIntegrityError",
    "a score above 1 fails closed",
  );
  const textual = scoresWithWinner("technical_activity", 1, 0);
  textual.project_announcement = "0.5";
  assertThrows(
    () => extractClassifierFeatures({ records: [{ label: "technical_activity", confidence: 0.5, scores: textual }] }),
    (error) => error.name === "FeatureRecordIntegrityError",
    "a non-numeric score fails closed",
  );
  assertThrows(
    () => extractClassifierFeatures({ records: [{ label: "not_a_label", confidence: 0.5, scores: scoresWithWinner(null, 0, 0) }] }),
    (error) => error.name === "FeatureRecordIntegrityError",
    "a label outside the taxonomy fails closed",
  );
});

test("E10. a null score means UNAVAILABLE (incomplete), not zero", async () => {
  const nulled = scoresWithWinner("technical_activity", 1, 0);
  nulled.project_announcement = null;
  const extracted = extractClassifierFeatures({
    records: [
      { label: "technical_activity", confidence: 0.5, scores: scoresWithWinner("technical_activity", 1, 0) },
      { label: "technical_activity", confidence: 0.5, scores: nulled },
    ],
  });
  assertEqual(extracted.scoreVectorCompleteCount, 1, "only the complete vector counts");
  assertEqual(extracted.scoreVectorIncompleteCount, 1, "the null score makes the vector incomplete");
  assertEqual(extracted.features.score_margin_mean, 1, "and the margin uses only the complete vector");
  assertEqual(extracted.nullFeatureCount, 0, "a null score never becomes a null FEATURE here");
});

test("E11. the build refuses an artifact when a stored confidence is out of range", async () => {
  const featuresDir = path.join(ctx.classifierRoot, "features");
  const before = (await readdir(featuresDir)).sort();
  const lines = await readResultLines(ctx.experiments.tiny);
  const first = JSON.parse(lines[0]);
  first.confidence = 1.5;
  lines[0] = JSON.stringify(first);
  const toId = "clexp-20260919T080700Z-00000012";
  await cloneExperiment({ fromName: "tiny", toId, resultLines: lines });
  const cohortId = await writeCohortFixture({ name: "badConfidence", experimentIds: [toId] });
  await assertRejects(
    buildClassifierFeature({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, cohortId, now: () => BUILD_NOW, save: true }),
    () => true,
    "an out-of-range stored confidence fails the build closed",
  );
  assertDeepEqual((await readdir(featuresDir)).sort(), before, "and nothing was written");
});

/* ============================================================================
 * PART F — refusals (fail closed, no fallback, nothing written)
 * ==========================================================================*/

async function refusalError(cohortId) {
  return assertRejects(
    buildClassifierFeature({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, cohortId, now: () => BUILD_NOW, save: true }),
    () => true,
    `cohort '${cohortId}' must be refused`,
  );
}

test("F1. classifiedCount 0 fails closed with FeatureNoEvidenceError", async () => {
  const error = await refusalError(ctx.cohorts.zero);
  assertTrue(error instanceof FeatureNoEvidenceError, `FeatureNoEvidenceError (got ${error.name}: ${error.message})`);
  assertThrows(() => extractClassifierFeatures({ records: [], context: "empty" }), (e) => e instanceof FeatureNoEvidenceError, "the pure extractor refuses an empty record set");
  assertThrows(() => extractClassifierFeatures({}), (e) => e instanceof FeatureNoEvidenceError, "and refuses no record set at all");
});

test("F2. a wrong classifier id is refused", async () => {
  const error = await refusalError(ctx.cohorts.wrongId);
  assertTrue(/other-classifier-v1/.test(error.message), `the error names the wrong classifier (got ${error.message})`);
});

test("F3. a wrong classifier version is refused (no fallback to latest)", async () => {
  const error = await refusalError(ctx.cohorts.version2);
  assertTrue(/frozen version/.test(error.message), `the error names the frozen version (got ${error.message})`);
});

test("F4. mixed classifier versions are refused", async () => {
  const error = await refusalError(ctx.cohorts.mixedVersions);
  assertTrue(error.name === "FeatureMixedEvidenceError", `FeatureMixedEvidenceError (got ${error.name})`);
  assertTrue(/MULTIPLE classifier versions/.test(error.message), `the error names the mixture (got ${error.message})`);
});

test("F5. mixed input projection versions are refused", async () => {
  const error = await refusalError(ctx.cohorts.mixedProjections);
  assertTrue(error.name === "FeatureMixedEvidenceError", `FeatureMixedEvidenceError (got ${error.name})`);
  assertTrue(/MULTIPLE input projection versions/.test(error.message), `the error names the mixture (got ${error.message})`);
});

test("F6. mixed classifier definition digests are refused", async () => {
  const error = await refusalError(ctx.cohorts.mixedDefinitions);
  assertTrue(error.name === "FeatureMixedEvidenceError", `FeatureMixedEvidenceError (got ${error.name})`);
  assertTrue(/MULTIPLE classifier definition digests/.test(error.message), `the error names the mixture (got ${error.message})`);
});

test("F7. mixed instructions digests are refused", async () => {
  const error = await refusalError(ctx.cohorts.mixedInstructions);
  assertTrue(error.name === "FeatureMixedEvidenceError", `FeatureMixedEvidenceError (got ${error.name})`);
  assertTrue(/MULTIPLE instructions digests/.test(error.message), `the error names the mixture (got ${error.message})`);
});

test("F8. a label outside the frozen taxonomy is refused", async () => {
  const error = await refusalError(ctx.cohorts.badLabel);
  assertTrue(/taxonomy/.test(error.message), `the error names the taxonomy violation (got ${error.message})`);
});

test("F9. a cohort whose manifest digest is wrong is refused", async () => {
  const error = await refusalError(ctx.cohorts.badDigest);
  assertTrue(/cohortDigest/.test(error.message), `the error names the digest (got ${error.message})`);
});

test("F10. an unmapped source evidence class is refused", async () => {
  const error = await refusalError(ctx.cohorts.wrongEvidenceClass);
  assertTrue(error instanceof FeatureEvidenceClassError, `FeatureEvidenceClassError (got ${error.name})`);
  assertTrue(/CLEAN_REPLICATION/.test(error.message), "the error names the refused class");
});

test("F11. a build earlier than evidenceAsOf is refused (FeatureTimelineError)", async () => {
  const error = await assertRejects(
    buildClassifierFeature({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, cohortId: ctx.cohorts.tiny, now: () => T, save: true }),
    (e) => e instanceof FeatureTimelineError,
    "backdating fails closed",
  );
  assertTrue(Date.parse(error.featureCreatedAt) < Date.parse(error.evidenceAsOf), "the error carries both timestamps");
  assertEqual(error.evidenceAsOf, "2026-09-19T08:30:00.000Z", "evidenceAsOf is the later capture time");
});

test("F12. an explicit cohort id is required and invalid feature ids are refused", async () => {
  await assertRejects(
    buildClassifierFeature({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, cohortId: "", now: () => BUILD_NOW, save: true }),
    (error) => /EXPLICIT cohort id/.test(error.message),
    "an empty cohort id fails closed",
  );
  await assertRejects(
    buildClassifierFeature({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, cohortId: "cleval-20260919T163609Z-9a7f434a", now: () => BUILD_NOW, save: true }),
    (error) => error.message.includes("invalid cohort id"),
    "an evaluation id is not a cohort id",
  );
});

test("F13. a feature output root inside the capture root is refused", async () => {
  await assertRejects(
    buildClassifierFeature({ classifierRoot: path.join(ctx.captureRoot, "nested-classifier"), captureRoot: ctx.captureRoot, cohortId: ctx.cohorts.tiny, now: () => BUILD_NOW, save: true }),
    (error) => error instanceof FeatureOutputRootError,
    "an output root inside the capture root fails closed",
  );
  await assertRejects(
    buildClassifierFeature({ classifierRoot: ctx.classifierRoot, captureRoot: path.join(ctx.classifierRoot, "nested-captures"), cohortId: ctx.cohorts.tiny, now: () => BUILD_NOW, save: true }),
    (error) => error instanceof FeatureOutputRootError,
    "a capture root inside the output root fails closed",
  );
});

test("F14. a refused build writes nothing", async () => {
  const featuresDir = path.join(ctx.classifierRoot, "features");
  const before = (await readdir(featuresDir)).sort();
  for (const name of ["zero", "wrongId", "version2", "mixedVersions", "mixedProjections", "mixedDefinitions", "mixedInstructions", "badLabel", "badDigest", "wrongEvidenceClass"]) {
    await refusalError(ctx.cohorts[name]);
  }
  assertDeepEqual((await readdir(featuresDir)).sort(), before, "the refused builds wrote no artifact");
  assertTrue(!(await exists(path.join(ctx.classifierRoot, "nested-classifier"))), "the refused output root was never created");
});

/* ============================================================================
 * PART G — artifact audit
 * ==========================================================================*/

function collectKeys(value, out = new Set()) {
  if (Array.isArray(value)) for (const entry of value) collectKeys(entry, out);
  else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      out.add(key);
      collectKeys(entry, out);
    }
  }
  return out;
}

function featureFilePath(classifierRoot, featureId) {
  return path.join(classifierRoot, "features", featureId, "feature.json");
}

async function readFeatureText(classifierRoot, featureId) {
  return readFile(featureFilePath(classifierRoot, featureId), "utf8");
}

test("G1. the artifact top-level keys are exactly the frozen whitelist, in order", async () => {
  const feature = ctx.features.tiny;
  assertDeepEqual(Object.keys(feature).sort(), [...FEATURE_ARTIFACT_FIELDS].sort(), "set equality with the whitelist — no extra key");
  const onDisk = JSON.parse(await readFeatureText(ctx.classifierRoot, feature.featureId));
  assertDeepEqual(Object.keys(onDisk), [...FEATURE_ARTIFACT_FIELDS], "the FILE key order matches the frozen schema order");
  assertDeepEqual(onDisk, feature, "the file is exactly the audited artifact");
});

test("G2. features are exactly the 19 canonical keys in canonical order", async () => {
  const feature = ctx.features.tiny;
  assertDeepEqual(Object.keys(feature.features), EXPECTED_FEATURE_NAMES, "canonical feature order");
  assertDeepEqual(Object.keys(feature.counts.labelCounts), CLASSIFIER_LABELS, "all nine taxonomy labels, in order");
  assertDeepEqual(Object.keys(feature.counts).sort(), ["labelCounts", "largestLabel", "largestLabelCount"], "the counts block is exact");
});

test("G3. every feature value is a finite number or null", async () => {
  for (const name of Object.keys(ctx.features)) {
    const feature = ctx.features[name];
    for (const key of EXPECTED_FEATURE_NAMES) {
      const value = feature.features[key];
      assertTrue(value === null || (typeof value === "number" && Number.isFinite(value)), `${name}.${key} is a finite number or null`);
    }
  }
});

test("G4. a semantic-smuggling feature key is rejected", async () => {
  const tampered = jsonClone(ctx.features.tiny);
  tampered.features.bullish_direction = 1;
  const audit = auditClassifierFeatureArtifact(tampered);
  assertTrue(!audit.ok, "the audit fails");
  assertTrue(audit.categories.forbiddenNames.length > 0, "the forbidden-name category is populated");
  assertTrue(audit.categories.forbiddenNames.some((problem) => /bullish_direction|forbidden feature name/.test(problem)), "the smuggled name is named");
  const second = jsonClone(ctx.features.tiny);
  second.features.signal_strength = 0.5;
  assertTrue(auditClassifierFeatureArtifact(second).categories.forbiddenNames.length > 0, "signal_strength is refused too");
});

test("G5. a grouped-semantic feature key is rejected", async () => {
  const tampered = jsonClone(ctx.features.tiny);
  tampered.features.technical_fraction = 0.5;
  const audit = auditClassifierFeatureArtifact(tampered);
  assertTrue(!audit.ok, "the audit fails");
  assertTrue(audit.categories.groupKeys.length > 0, "the group-key category is populated");
  for (const group of FORBIDDEN_GROUP_FEATURE_KEYS) {
    const clone = jsonClone(ctx.features.tiny);
    clone.features[group] = 0.25;
    assertTrue(auditClassifierFeatureArtifact(clone).categories.groupKeys.length > 0, `'${group}' is refused`);
  }
  const container = jsonClone(ctx.features.tiny);
  container.groups = {};
  assertTrue(auditClassifierFeatureArtifact(container).categories.groupKeys.length > 0, "a 'groups' container is refused");
});

test("G6. raw text keys are rejected", async () => {
  const tampered = jsonClone(ctx.features.tiny);
  tampered.text = "some raw source text";
  const audit = auditClassifierFeatureArtifact(tampered);
  assertTrue(!audit.ok, "the audit fails");
  assertTrue(audit.categories.textFree.some((problem) => /text/.test(problem)), "the raw-text key is named");
  const excerpt = jsonClone(ctx.features.tiny);
  excerpt.excerpt = "some excerpt";
  assertTrue(auditClassifierFeatureArtifact(excerpt).categories.textFree.length > 0, "excerpts are refused too");
});

test("G7. URL-like strings are rejected", async () => {
  const tampered = jsonClone(ctx.features.tiny);
  tampered.note = "see https://example.com/raw for the source";
  const audit = auditClassifierFeatureArtifact(tampered);
  assertTrue(!audit.ok, "the audit fails");
  assertTrue(audit.categories.textFree.some((problem) => /URL-like/.test(problem)), "the URL is named");
  const www = jsonClone(ctx.features.tiny);
  www.note = "see www.example.com for the source";
  assertTrue(auditClassifierFeatureArtifact(www).categories.textFree.length > 0, "bare www URLs are refused too");
});

test("G8. author keys are rejected", async () => {
  const tampered = jsonClone(ctx.features.tiny);
  tampered.author = "AUTHOR-SENTINEL";
  const audit = auditClassifierFeatureArtifact(tampered);
  assertTrue(!audit.ok, "the audit fails");
  assertTrue(audit.categories.textFree.some((problem) => /author/.test(problem)), "the author key is named");
});

test("G9. query and credential keys are rejected", async () => {
  for (const key of ["query", "queryId", "apiKey", "authorization", "headers", "rawDigest"]) {
    const tampered = jsonClone(ctx.features.tiny);
    tampered[key] = "sentinel-value";
    const audit = auditClassifierFeatureArtifact(tampered);
    assertTrue(!audit.ok, `the audit fails for '${key}'`);
    assertTrue(audit.categories.textFree.length > 0, `'${key}' is refused`);
  }
});

test("G10. all four routing flags must be strictly false", async () => {
  const feature = ctx.features.tiny;
  assertDeepEqual(
    feature.routing,
    { jevRoutingActive: false, deepseekRoutingActive: false, arenaRoutingActive: false, tradingRoutingActive: false, note: feature.routing.note },
    "all four routing flags are false",
  );
  for (const flag of ["jevRoutingActive", "deepseekRoutingActive", "arenaRoutingActive", "tradingRoutingActive"]) {
    const tampered = jsonClone(feature);
    tampered.routing[flag] = true;
    const audit = auditClassifierFeatureArtifact(tampered);
    assertTrue(!audit.ok, `the audit fails when ${flag} is true`);
    assertTrue(audit.categories.routing.some((problem) => problem.includes(flag)), `${flag} is named`);
  }
});

test("G11. the frozen flags must all be true", async () => {
  for (const flag of ["immutable", "finalized", "descriptiveOnly", "developmentOnly", "noGroundTruth", "noProfitabilityInference"]) {
    assertEqual(ctx.features.tiny[flag], true, `'${flag}' is true`);
    const tampered = jsonClone(ctx.features.tiny);
    tampered[flag] = false;
    assertTrue(auditClassifierFeatureArtifact(tampered).categories.flags.length > 0, `the audit rejects '${flag}: false'`);
  }
  const tampered = jsonClone(ctx.features.tiny);
  tampered.evidenceClass = "CLEAN_REPLICATION";
  assertTrue(auditClassifierFeatureArtifact(tampered).categories.definitionPin.length > 0, "the audit rejects a truthy evidence class");
});

test("G12. the definition pin must match", async () => {
  const tampered = jsonClone(ctx.features.tiny);
  tampered.featureDefinitionVersion = "classifier-feature-definition-v2";
  assertTrue(auditClassifierFeatureArtifact(tampered).categories.definitionPin.length > 0, "a future definition version is rejected");
  tampered.featureDefinitionVersion = FEATURE_DEFINITION_VERSION;
  tampered.featureDefinitionDigest = "0".repeat(64);
  assertTrue(auditClassifierFeatureArtifact(tampered).categories.definitionPin.length > 0, "a wrong definition digest is rejected");
  const projection = jsonClone(ctx.features.tiny);
  projection.inputProjectionVersion = "classifier-input-projection-v2";
  assertTrue(auditClassifierFeatureArtifact(projection).categories.definitionPin.length > 0, "a wrong projection pin is rejected");
});

test("G13. arithmetic: Σ labelCounts must equal classifiedCount", async () => {
  const tampered = jsonClone(ctx.features.weight);
  tampered.counts.labelCounts.technical_activity += 1;
  const audit = auditClassifierFeatureArtifact(tampered);
  assertTrue(audit.categories.arithmetic.some((problem) => problem.includes("labelCounts")), "the count sum is checked");
});

test("G14. arithmetic: label fractions must sum to 1", async () => {
  const tampered = jsonClone(ctx.features.tiny);
  tampered.features.label_fraction_technical_activity = 0.999;
  const audit = auditClassifierFeatureArtifact(tampered);
  assertTrue(audit.categories.arithmetic.some((problem) => problem.includes("sum to 1")), "the fraction sum is checked");
  const range = jsonClone(ctx.features.tiny);
  range.features.label_fraction_project_announcement = 1.5;
  assertTrue(auditClassifierFeatureArtifact(range).categories.arithmetic.some((problem) => problem.includes("[0, 1]")), "the fraction range is checked");
});

test("G15. arithmetic: observed_label_count, largestLabelCount and entropy invariants", async () => {
  const observed = jsonClone(ctx.features.seven);
  observed.features.observed_label_count = 6;
  assertTrue(auditClassifierFeatureArtifact(observed).categories.arithmetic.some((problem) => problem.includes("observed_label_count")), "the observed count is checked");
  const largest = jsonClone(ctx.features.seven);
  largest.counts.largestLabelCount = 99;
  assertTrue(auditClassifierFeatureArtifact(largest).categories.arithmetic.some((problem) => problem.includes("largestLabelCount")), "the modal count is checked");
  const entropyRange = jsonClone(ctx.features.seven);
  entropyRange.features.label_entropy_normalized = 1.5;
  assertTrue(auditClassifierFeatureArtifact(entropyRange).categories.arithmetic.some((problem) => problem.includes("entropy")), "the entropy range is checked");
  const single = jsonClone(ctx.features.single);
  single.features.label_entropy_normalized = 0.5;
  assertTrue(auditClassifierFeatureArtifact(single).categories.arithmetic.some((problem) => problem.includes("single observed label")), "a single label must keep entropy 0");
});

test("G16. arithmetic: complete + incomplete must equal classifiedCount", async () => {
  const tampered = jsonClone(ctx.features.incomplete);
  tampered.scoreVectorCompleteCount += 1;
  assertTrue(auditClassifierFeatureArtifact(tampered).categories.arithmetic.some((problem) => problem.includes("scoreVectorCompleteCount")), "the vector counts are checked");
  const margin = jsonClone(ctx.features.null);
  margin.features.score_margin_mean = 0;
  assertTrue(auditClassifierFeatureArtifact(margin).categories.arithmetic.some((problem) => problem.includes("must be null when no score vector is complete")), "a missing margin must stay null");
});

test("G17. arithmetic: recordCount, digest counts and nullFeatureCount invariants", async () => {
  const recordCount = jsonClone(ctx.features.tiny);
  recordCount.recordCount += 1;
  assertTrue(auditClassifierFeatureArtifact(recordCount).categories.arithmetic.some((problem) => problem.includes("recordCount")), "the record count is checked");
  const digests = jsonClone(ctx.features.tiny);
  digests.duplicateRecordDigestCount = 5;
  assertTrue(auditClassifierFeatureArtifact(digests).categories.arithmetic.some((problem) => problem.includes("duplicateRecordDigestCount")), "the digest counts are checked");
  const nulls = jsonClone(ctx.features.tiny);
  nulls.nullFeatureCount = 1;
  assertTrue(auditClassifierFeatureArtifact(nulls).categories.arithmetic.some((problem) => problem.includes("nullFeatureCount")), "the null count is checked");
  const hidden = jsonClone(ctx.features.tiny);
  hidden.features.score_margin_mean = null;
  assertTrue(auditClassifierFeatureArtifact(hidden).categories.arithmetic.some((problem) => problem.includes("nullFeatureCount")), "a hidden null is caught");
});

test("G18. the artifact carries no forbidden 5G.1 metric keys and no evaluation-only diagnostics", async () => {
  const keys = collectKeys(ctx.features.weight);
  for (const forbidden of ["pnl", "profit", "expectedReturn", "accuracy", "precision", "recall", "calibration", "verdict", "passed", "signalQuality", "qualityScore", "arenaScore", "correlation"]) {
    assertTrue(!keys.has(forbidden), `'${forbidden}' is not an artifact key`);
  }
  assertTrue(!keys.has("p10") && !keys.has("p90") && !keys.has("min") && !keys.has("max"), "percentile diagnostics are not persisted");
  const audit = auditClassifierFeatureArtifact(ctx.features.weight);
  assertTrue(audit.ok, `the built artifact audits clean: ${audit.problems.join("; ")}`);
});

test("G19. write-once: a repeated build throws FeatureExistsError and leaves the bytes unchanged", async () => {
  const feature = ctx.features.tiny;
  const before = await readFeatureText(ctx.classifierRoot, feature.featureId);
  const beforeStat = await stat(featureFilePath(ctx.classifierRoot, feature.featureId));
  const error = await assertRejects(
    buildClassifierFeature({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, cohortId: ctx.cohorts.tiny, now: () => BUILD_NOW, save: true }),
    (e) => e instanceof FeatureExistsError,
    "a byte-identical rebuild is still refused",
  );
  assertEqual(error.featureId, feature.featureId, "the error names the existing artifact");
  const after = await readFeatureText(ctx.classifierRoot, feature.featureId);
  const afterStat = await stat(featureFilePath(ctx.classifierRoot, feature.featureId));
  assertEqual(after, before, "the bytes are unchanged");
  assertEqual(afterStat.size, beforeStat.size, "and the size is unchanged");
});

/* ============================================================================
 * PART H — replay
 * ==========================================================================*/

async function replayIn(roots, featureId) {
  return replayClassifierFeature({ classifierRoot: roots.classifierRoot, captureRoot: roots.captureRoot, featureId });
}

async function tamperFeatureFile(classifierRoot, featureId, mutate) {
  const file = featureFilePath(classifierRoot, featureId);
  const feature = JSON.parse(await readFile(file, "utf8"));
  mutate(feature);
  await writeFile(file, `${JSON.stringify(feature, null, 2)}\n`, "utf8");
  return feature;
}

test("H1. replay verifies a stored artifact offline and reproduces both digests", async () => {
  const feature = ctx.features.tiny;
  const report = await replayClassifierFeature({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, featureId: feature.featureId });
  assertTrue(report.ok, `replay passes: ${report.problems.join(" | ")}`);
  assertEqual(report.featureId, feature.featureId, "the feature id is reported");
  assertEqual(report.cohortId, feature.cohortId, "the cohort id is reported");
  assertEqual(report.featureDefinitionVersion, FEATURE_DEFINITION_VERSION, "the definition version is reported");
  assertEqual(report.evidenceClass, DERIVED_EVIDENCE_CLASS, "the derived evidence class is reported");
  assertEqual(report.classifiedCount, 3, "the classified count is reported");
  assertEqual(report.featureDigest, feature.featureDigest, "featureDigest: the stored digest");
  assertEqual(report.recomputedFeatureDigest, feature.featureDigest, "featureDigest: reproduced exactly");
  for (const [name, ok] of Object.entries(report.checks)) assertTrue(ok, `check '${name}' passed`);
  for (const name of [
    "featureReadable",
    "featureId",
    "featureDigest",
    "featureIdentity",
    "definitionPin",
    "frozenFlags",
    "evidenceClass",
    "sourceEvidenceClass",
    "noRawText",
    "noForbiddenKeys",
    "noForbiddenNames",
    "featuresNumericOnly",
    "noGroupKeys",
    "routingInactive",
    "timeline",
    "cohortPresent",
    "cohortIdentity",
    "cohortDigest",
    "cohortEvidenceClass",
    "cohortClassifier",
    "cohortProjection",
    "experimentsIntegrity",
    "capturesIntegrity",
    "counts",
    "labelDistribution",
    "confidence",
    "scoreMargin",
    "featureDigestReproduced",
  ]) {
    assertTrue(Object.hasOwn(report.checks, name), `the replay reports the '${name}' check`);
  }
});

test("H2. replay is zero-network and never reclassifies", async () => {
  const report = await replayClassifierFeature({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, featureId: ctx.features.weight.featureId });
  assertTrue(report.ok, "replay passes");
  assertEqual(report.networkCalls, 0, "zero network calls");
  assertTrue(!JSON.stringify(report).includes("classifier.dev"), "no provider endpoint appears");
});

test("H3. replay is READ-ONLY", async () => {
  const beforeClassifier = await metadataSnapshot(ctx.classifierRoot);
  const beforeCaptures = await metadataSnapshot(ctx.captureRoot);
  const report = await replayClassifierFeature({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, featureId: ctx.features.tiny.featureId });
  assertTrue(report.ok, "replay passes");
  assertDeepEqual(await metadataSnapshot(ctx.classifierRoot), beforeClassifier, "no classifier byte moved");
  assertDeepEqual(await metadataSnapshot(ctx.captureRoot), beforeCaptures, "no capture byte moved");
});

test("H4. replay fails closed when one feature changes", async () => {
  const roots = await cloneFixture("h4");
  await tamperFeatureFile(roots.classifierRoot, ctx.features.tiny.featureId, (feature) => {
    feature.features.label_fraction_technical_activity = 0.42;
  });
  const report = await replayIn(roots, ctx.features.tiny.featureId);
  assertTrue(!report.ok, "replay fails");
  assertTrue(report.checks.featureDigest === false, "the featureDigest no longer matches");
  assertTrue(report.checks.labelDistribution === false, "the label distribution no longer recomputes");
});

test("H5. replay fails closed when featureDigest changes", async () => {
  const roots = await cloneFixture("h5");
  await tamperFeatureFile(roots.classifierRoot, ctx.features.tiny.featureId, (feature) => {
    feature.featureDigest = "0".repeat(64);
  });
  const report = await replayIn(roots, ctx.features.tiny.featureId);
  assertTrue(!report.ok, "replay fails");
  assertTrue(report.checks.featureDigest === false, "the stored digest is inconsistent");
  assertTrue(report.checks.featureDigestReproduced === false, "and cannot be reproduced");
});

test("H6. replay fails closed when the cohort digest changes", async () => {
  const roots = await cloneFixture("h6");
  const cohort = await readCohort(roots.classifierRoot, ctx.cohorts.tiny);
  cohort.cohortDigest = "0".repeat(64);
  await writeFile(path.join(roots.classifierRoot, "cohorts", `${ctx.cohorts.tiny}.json`), `${JSON.stringify(cohort, null, 2)}\n`, "utf8");
  const report = await replayIn(roots, ctx.features.tiny.featureId);
  assertTrue(!report.ok, "replay fails");
  assertTrue(report.checks.cohortIdentity === false, "the cohort no longer matches its own identity");
  assertTrue(report.checks.cohortDigest === false, "and no longer matches the artifact");
});

test("H7. replay fails closed when an experiment digest changes", async () => {
  const roots = await cloneFixture("h7");
  const experiment = await readExperimentJson(ctx.experiments.tiny, roots.classifierRoot);
  experiment.experimentDigest = "0".repeat(64);
  await writeExperimentJson(ctx.experiments.tiny, experiment, roots.classifierRoot);
  const report = await replayIn(roots, ctx.features.tiny.featureId);
  assertTrue(!report.ok, "replay fails");
  assertTrue(report.checks.experimentsIntegrity === false, "the experiment no longer verifies");
});

test("H8. replay fails closed when a classifier result record changes", async () => {
  const roots = await cloneFixture("h8");
  const file = path.join(classifierExperimentDir(roots.classifierRoot, ctx.experiments.tiny), CLASSIFIER_RESULTS_FILE);
  const lines = (await readFile(file, "utf8")).split("\n").filter((line) => line.trim().length > 0);
  const record = JSON.parse(lines[0]);
  record.confidence = 0.123;
  lines[0] = JSON.stringify(record);
  await writeFile(file, `${lines.join("\n")}\n`, "utf8");
  const report = await replayIn(roots, ctx.features.tiny.featureId);
  assertTrue(!report.ok, "replay fails");
  assertTrue(report.checks.experimentsIntegrity === false, "the frozen result no longer matches its resultDigest");
});

test("H9. replay fails closed when a source capture record changes", async () => {
  const roots = await cloneFixture("h9");
  const file = path.join(roots.captureRoot, CAPTURE_DAY, ctx.captureIds.tiny, CAPTURE_RECORDS_FILE);
  const lines = (await readFile(file, "utf8")).split("\n").filter((line) => line.trim().length > 0);
  const record = JSON.parse(lines[0]);
  record.textExcerpt = `${record.textExcerpt ?? ""} tampered`;
  lines[0] = JSON.stringify(record);
  await writeFile(file, `${lines.join("\n")}\n`, "utf8");
  const report = await replayIn(roots, ctx.features.tiny.featureId);
  assertTrue(!report.ok, "replay fails");
  assertTrue(report.checks.capturesIntegrity === false, "the capture no longer verifies");
});

test("H10. a missing feature artifact fails closed", async () => {
  const report = await replayClassifierFeature({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, featureId: "clfeat-20260919T000000Z-00000000" });
  assertTrue(!report.ok, "replay fails");
  assertTrue(report.checks.featureReadable === false, "the artifact is not readable");
  assertEqual(report.networkCalls, 0, "still zero network calls");
});

test("H11. a missing cohort fails closed", async () => {
  const roots = await cloneFixture("h11");
  await rm(path.join(roots.classifierRoot, "cohorts", `${ctx.cohorts.tiny}.json`));
  const report = await replayIn(roots, ctx.features.tiny.featureId);
  assertTrue(!report.ok, "replay fails");
  assertTrue(report.checks.cohortPresent === false, "the cohort is missing");
  assertTrue(report.checks.experimentsIntegrity === false, "and the evidence cannot be re-read");
});

test("H12. replay preserves the stored timeline", async () => {
  const feature = ctx.features.tiny;
  const report = await replayClassifierFeature({ classifierRoot: ctx.classifierRoot, captureRoot: ctx.captureRoot, featureId: feature.featureId });
  assertTrue(report.ok, "replay passes");
  assertEqual(report.evidenceAsOf, feature.timeline.evidenceAsOf, "evidenceAsOf is preserved");
  assertEqual(report.checks.timeline, true, "the timeline recomputes exactly");
  assertTrue(Date.parse(feature.timeline.featureCreatedAt) >= Date.parse(feature.timeline.evidenceAsOf), "createdAt is never earlier than evidenceAsOf");
});

/* ============================================================================
 * PART I — stats + CLI
 * ==========================================================================*/

test("I1. stats work offline WITHOUT a capture root", async () => {
  const stats = await classifierFeatureStats({ classifierRoot: ctx.classifierRoot, featureId: ctx.features.weight.featureId });
  assertEqual(stats.networkCalls, 0, "zero network calls");
  assertEqual(stats.featureId, ctx.features.weight.featureId, "the feature id is reported");
  assertEqual(stats.featureDefinitionVersion, FEATURE_DEFINITION_VERSION, "the definition version is reported");
  assertEqual(stats.featureDefinitionDigestOk, true, "the definition digest matches the pin");
  assertEqual(stats.evidenceClass, DERIVED_EVIDENCE_CLASS, "the derived evidence class");
  assertEqual(stats.sourceEvidenceClass, SOURCE_EVIDENCE_CLASS, "the source evidence class");
  assertEqual(stats.cohortId, ctx.cohorts.weight, "the cohort id is reported");
  assertEqual(stats.cohortOk, true, "the cohort verifies");
  assertEqual(stats.cohortDigestOk, true, "and matches the artifact cohort digest");
  assertEqual(stats.experimentCount, 2, "two experiments");
  assertEqual(stats.captureCount, 2, "two captures");
  assertEqual(stats.recordCount, 55, "55 records");
  assertEqual(stats.classifiedCount, 55, "55 classified");
  assertEqual(stats.skippedCount, 0, "no skipped records");
  assertEqual(stats.featureDigest, ctx.features.weight.featureDigest, "the feature digest is reported");
  assertEqual(stats.featureDigestOk, true, "and matches the bytes");
  assertEqual(stats.auditOk, true, "the artifact audits clean");
  assertEqual(stats.evidenceAsOf, ctx.features.weight.timeline.evidenceAsOf, "evidenceAsOf is reported");
  assertEqual(stats.createdAt, ctx.features.weight.createdAt, "createdAt is reported");
});

test("I2. stats expose the aliases as DISPLAY ONLY", async () => {
  const stats = await classifierFeatureStats({ classifierRoot: ctx.classifierRoot, featureId: ctx.features.tiny.featureId });
  assertEqual(stats.noiseFraction, stats.features.label_fraction_unrelated_or_noise, "noiseFraction aliases the canonical noise fraction");
  assertEqual(stats.promotionFraction, stats.features.label_fraction_promotion_or_marketing, "promotionFraction aliases the canonical promotion fraction");
  assertDeepEqual(Object.keys(stats.features), EXPECTED_FEATURE_NAMES, "the features block is exactly the 19 canonical keys");
  assertTrue(!Object.hasOwn(stats.features, "noise_fraction"), "the alias is NOT an additional feature");
  assertTrue(!Object.hasOwn(stats.features, "promotion_fraction"), "neither is the promotion alias");
});

test("I3. stats report counts, distribution, digest statuses, routing flags and NO verdict", async () => {
  const stats = await classifierFeatureStats({ classifierRoot: ctx.classifierRoot, featureId: ctx.features.weight.featureId });
  assertEqual(stats.labelCounts.technical_activity, 50, "label counts are reported");
  assertEqual(stats.labelFractions.technical_activity, 0.909091, "label fractions are reported");
  assertEqual(stats.observedLabelCount, 2, "the observed label count is reported");
  assertEqual(stats.labelEntropyNormalized, ctx.features.weight.features.label_entropy_normalized, "entropy is reported");
  assertEqual(stats.largestLabel, "technical_activity", "the largest label is reported");
  assertEqual(stats.largestLabelCount, 50, "with its raw count");
  assertEqual(stats.largestLabelFraction, 0.909091, "and its fraction");
  assertEqual(stats.confidenceMean, 0.781818, "confidence mean");
  assertEqual(stats.confidenceMedian, 0.8, "confidence median");
  assertEqual(stats.confidenceLowFraction, 0, "low-confidence fraction");
  assertEqual(stats.confidenceHighFraction, 0, "high-confidence fraction");
  assertEqual(stats.scoreMarginMean, 1, "margin mean");
  assertEqual(stats.scoreMarginMedian, 1, "margin median");
  assertEqual(stats.scoreMarginAmbiguousFraction, 0, "ambiguous margin fraction");
  assertEqual(stats.scoreVectorCompleteCount, 55, "complete score vectors");
  assertEqual(stats.scoreVectorIncompleteCount, 0, "incomplete score vectors");
  assertEqual(stats.nullFeatureCount, 0, "no null feature");
  assertEqual(stats.distinctRecordDigestCount, 55, "distinct record digests");
  assertEqual(stats.duplicateRecordDigestCount, 0, "no duplicate record digest");
  for (const flag of ["jevRoutingActive", "deepseekRoutingActive", "arenaRoutingActive", "tradingRoutingActive"]) {
    assertEqual(stats[flag], false, `${flag} is false`);
  }
  for (const verdict of ["verdict", "passed", "rank", "score", "signal", "confidence"]) assertTrue(!Object.hasOwn(stats, verdict), `no '${verdict}' verdict field`);
});

test("I4. the CLI prints the frozen definition", async () => {
  const run = runCli(["--definition"]);
  assertEqual(run.status, 0, `the definition action exits 0 (stderr: ${run.stderr})`);
  assertTrue(run.stdout.includes(FEATURE_DEFINITION_VERSION), "the version is printed");
  assertTrue(run.stdout.includes(FEATURE_DEFINITION_DIGEST), "the ACTUAL definition digest is printed");
  assertTrue(run.stdout.includes("observed_label_count"), "the canonical feature list is printed");
  assertTrue(!/https?:\/\//.test(run.stdout), "no URL is printed");
  const json = runCli(["--definition", "--json"]);
  assertEqual(json.status, 0, "the JSON definition action exits 0");
  const payload = JSON.parse(json.stdout);
  assertEqual(payload.definitionDigest, FEATURE_DEFINITION_DIGEST, "the JSON carries the ACTUAL digest");
  assertEqual(payload.definitionVersion, FEATURE_DEFINITION_VERSION, "and the version");
});

test("I5. the CLI builds ONE artifact from an explicit cohort", async () => {
  if (Date.now() < CLI_EVIDENCE_AS_OF) {
    skip("the wall clock is earlier than the fixture evidence — the CLI build case was skipped");
    return;
  }
  await mkdir(ctx.cliRoot, { recursive: true });
  await cp(path.join(ctx.classifierRoot, "cohorts"), path.join(ctx.cliRoot, "cohorts"), { recursive: true });
  await cp(path.join(ctx.classifierRoot, "experiments"), path.join(ctx.cliRoot, "experiments"), { recursive: true });
  const run = runCli(["--cohort", ctx.cohorts.tiny, "--out", ctx.cliRoot, "--captures", ctx.captureRoot]);
  assertEqual(run.status, 0, `the build action exits 0 (stderr: ${run.stderr})`);
  assertTrue(run.stdout.includes("[classify-features] feature clfeat-"), "the built id is printed");
  assertTrue(run.stdout.includes("routing:"), "the routing flags are printed");
  assertTrue(!/https?:\/\//.test(run.stdout), "no URL is printed");
  const dirs = (await readdir(path.join(ctx.cliRoot, "features"))).sort();
  assertEqual(dirs.length, 1, "exactly one artifact was created");
  assertTrue(CLFEAT_PATTERN.test(dirs[0]), "with a canonical clfeat id");
  const built = JSON.parse(await readFile(featureFilePath(ctx.cliRoot, dirs[0]), "utf8"));
  assertEqual(built.cohortId, ctx.cohorts.tiny, "pinned to the requested cohort");
  assertEqual(built.classifiedCount, 3, "and to its evidence");
  assertDeepEqual(Object.keys(built), [...FEATURE_ARTIFACT_FIELDS], "the CLI build writes the frozen schema order");
  assertTrue(auditClassifierFeatureArtifact(built).ok, "the CLI-built artifact audits clean");
  ctx.cliFeatureId = built.featureId;
});

test("I6. the CLI replays a stored artifact", async () => {
  const run = runCli(["--replay", "--feature", ctx.features.tiny.featureId, "--out", ctx.classifierRoot, "--captures", ctx.captureRoot]);
  assertEqual(run.status, 0, `the replay action exits 0 (stderr: ${run.stderr})`);
  assertTrue(run.stdout.includes("integrity OK"), "the replay reports integrity");
  assertTrue(run.stdout.includes(ctx.features.tiny.featureDigest), "the digest is printed");
  assertTrue(run.stdout.includes("featureDigestReproduced"), "the reproduced-digest check is printed");
});

test("I7. the CLI reports stats WITHOUT a capture root", async () => {
  const run = runCli(["--stats", "--feature", ctx.features.tiny.featureId, "--out", ctx.classifierRoot]);
  assertEqual(run.status, 0, `the stats action exits 0 (stderr: ${run.stderr})`);
  assertTrue(run.stdout.includes("networkCalls:   0"), "zero network calls are reported");
  assertTrue(run.stdout.includes("display aliases only"), "the aliases are labelled as display only");
  const json = runCli(["--stats", "--feature", ctx.features.tiny.featureId, "--out", ctx.classifierRoot, "--json"]);
  assertEqual(json.status, 0, "the JSON stats action exits 0");
  assertEqual(JSON.parse(json.stdout).networkCalls, 0, "the JSON stats report zero network calls");
});

test("I8. the CLI refuses conflicting actions", async () => {
  const both = runCli(["--replay", "--stats", "--feature", ctx.features.tiny.featureId, "--out", ctx.classifierRoot, "--captures", ctx.captureRoot]);
  assertEqual(both.status, 1, "replay + stats fails");
  assertTrue(/mutually exclusive/.test(both.stderr), "and says so");
  const withCohort = runCli(["--replay", "--cohort", ctx.cohorts.tiny, "--out", ctx.classifierRoot, "--captures", ctx.captureRoot]);
  assertEqual(withCohort.status, 1, "replay + cohort fails");
  assertTrue(/takes --feature, not --cohort/.test(withCohort.stderr), "and names the mistake");
  const definition = runCli(["--definition", "--cohort", ctx.cohorts.tiny]);
  assertEqual(definition.status, 1, "definition + cohort fails");
  assertTrue(/takes neither --cohort nor --feature/.test(definition.stderr), "and says so");
});

test("I9. the CLI refuses missing required arguments", async () => {
  const replay = runCli(["--replay", "--out", ctx.classifierRoot, "--captures", ctx.captureRoot]);
  assertEqual(replay.status, 1, "replay without --feature fails");
  assertTrue(/requires --feature/.test(replay.stderr), "and says so");
  const stats = runCli(["--stats", "--out", ctx.classifierRoot]);
  assertEqual(stats.status, 1, "stats without --feature fails");
  const nothing = runCli([]);
  assertEqual(nothing.status, 1, "no arguments fails");
  assertTrue(/nothing to do/.test(nothing.stderr), "and explains the required inputs");
  const featureOnly = runCli(["--feature", ctx.features.tiny.featureId, "--out", ctx.classifierRoot]);
  assertEqual(featureOnly.status, 1, "--feature without an action fails");
  const unknown = runCli(["--stats", "--feature", "clfeat-20260919T000000Z-00000000", "--out", ctx.classifierRoot]);
  assertEqual(unknown.status, 1, "an unknown feature fails");
  assertTrue(/was not found/.test(unknown.stderr), "and fails closed");
});

test("I10. the CLI NEVER overwrites an existing artifact (write-once)", async () => {
  if (Date.now() < CLI_EVIDENCE_AS_OF || !ctx.cliFeatureId) {
    skip("the CLI build case did not run — the write-once case was skipped");
    return;
  }
  const beforeBytes = await readFeatureText(ctx.cliRoot, ctx.cliFeatureId);
  const featuresDir = path.join(ctx.cliRoot, "features");
  const beforeFiles = await metadataSnapshot(featuresDir);
  const run = runCli(["--cohort", ctx.cohorts.tiny, "--out", ctx.cliRoot, "--captures", ctx.captureRoot]);
  assertTrue(run.status === 0 || run.status === 1, `the rebuild either freezes or refuses (status ${run.status})`);
  assertEqual(await readFeatureText(ctx.cliRoot, ctx.cliFeatureId), beforeBytes, "the ORIGINAL artifact's bytes are unchanged");
  const dirs = (await readdir(featuresDir)).sort();
  assertTrue(dirs.includes(ctx.cliFeatureId), "the original artifact still exists");
  const afterFiles = await metadataSnapshot(featuresDir);
  for (const [file, meta] of Object.entries(beforeFiles)) assertEqual(afterFiles[file], meta, `${file} is byte-unchanged`);
  if (run.status === 1) {
    assertTrue(/already exists/.test(run.stderr), "a refusal names the immutable artifact");
    return;
  }
  // A later freeze is a NEW immutable record carrying the SAME evidence — never a mutation.
  const freshId = dirs.find((name) => name !== ctx.cliFeatureId);
  assertTrue(Boolean(freshId), "the rebuild produced a distinct clfeat id");
  const fresh = JSON.parse(await readFeatureText(ctx.cliRoot, freshId));
  assertDeepEqual(fresh.features, JSON.parse(beforeBytes).features, "the new artifact carries the same features");
  assertEqual(fresh.classifiedCount, 3, "and the same evidence");
  assertTrue(fresh.featureDigest !== JSON.parse(beforeBytes).featureDigest, "but its own digest");
});

test("I11. the CLI has NO provider/network/routing/classification option and no latest", async () => {
  for (const flag of ["--provider", "--network", "--routing", "--classify", "--classification", "--classifier", "--model", "--latest", "--all", "--arena", "--trading", "--jev", "--deepseek", "--capture", "--experiments"]) {
    const run = runCli([flag, "x", "--out", ctx.classifierRoot, "--captures", ctx.captureRoot]);
    assertEqual(run.status, 1, `${flag} is refused`);
    assertTrue(/does not exist|unknown option/.test(run.stderr), `${flag} is refused with an explicit error`);
  }
  const source = ctx.sources.get("scripts/intelligence-classify-features.mjs");
  const declaredList = (name) => {
    const match = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(source);
    assertTrue(Boolean(match), `${name} is declared`);
    return match[1].split(",").map((token) => token.trim().replace(/^"|"$/g, "")).filter((token) => token.length > 0);
  };
  assertDeepEqual(declaredList("BOOLEAN_FLAGS"), ["json", "replay", "stats", "definition", "help"], "the CLI declares only supported boolean flags");
  assertDeepEqual(declaredList("VALUE_FLAGS"), ["cohort", "feature", "out", "captures"], "the CLI declares only supported value flags");
});

test("I12. the CLI refuses positionals and unknown options", async () => {
  const positional = runCli([ctx.cohorts.tiny, "--out", ctx.classifierRoot, "--captures", ctx.captureRoot]);
  assertEqual(positional.status, 1, "a positional cohort is refused");
  assertTrue(/unexpected positional argument/.test(positional.stderr), "and says so");
  const unknown = runCli(["--frobnicate", "x", "--out", ctx.classifierRoot]);
  assertEqual(unknown.status, 1, "an unknown option is refused");
  assertTrue(/unknown option/.test(unknown.stderr), "and names it");
});

/* ============================================================================
 * PART J — timeline / no lookahead
 * ==========================================================================*/

async function captureManifestJson(captureId) {
  return JSON.parse(await readFile(path.join(ctx.captureRoot, CAPTURE_DAY, captureId, "manifest.json"), "utf8"));
}

test("J1. evidenceAsOf is the LATER of the latest capture and the latest experiment (experiment branch)", async () => {
  const feature = ctx.features.weight;
  const bigManifest = await captureManifestJson(ctx.captureIds.big);
  const smallManifest = await captureManifestJson(ctx.captureIds.small);
  const captureTimes = [bigManifest.finalizedAt, smallManifest.finalizedAt].sort();
  const experimentBig = await readExperimentJson(ctx.experiments.big);
  const experimentSmall = await readExperimentJson(ctx.experiments.small);
  assertEqual(feature.timeline.earliestCaptureAt, captureTimes[0], "earliestCaptureAt is the earliest capture time");
  assertEqual(feature.timeline.latestCaptureAt, captureTimes[1], "latestCaptureAt is the latest capture time");
  assertEqual(feature.timeline.latestExperimentAt, experimentSmall.createdAt, "latestExperimentAt is the latest experiment creation time");
  assertEqual(feature.timeline.evidenceAsOf, experimentSmall.createdAt, "evidenceAsOf follows the later EXPERIMENT");
  assertTrue(Date.parse(feature.timeline.evidenceAsOf) >= Date.parse(experimentBig.createdAt), "and dominates every experiment");
  assertEqual(feature.timeline.featureCreatedAt, new Date(BUILD_NOW).toISOString(), "featureCreatedAt is the frozen build clock");
});

test("J2. evidenceAsOf selects the CAPTURE when the capture is later", async () => {
  const feature = ctx.features.tiny;
  const manifest = await captureManifestJson(ctx.captureIds.tiny);
  const experiment = await readExperimentJson(ctx.experiments.tiny);
  assertTrue(Date.parse(manifest.finalizedAt) > Date.parse(experiment.createdAt), "the fixture really has a later capture");
  assertEqual(feature.timeline.latestCaptureAt, manifest.finalizedAt, "latestCaptureAt is the capture time");
  assertEqual(feature.timeline.evidenceAsOf, manifest.finalizedAt, "evidenceAsOf follows the later CAPTURE");
  assertTrue(Date.parse(feature.timeline.evidenceAsOf) >= Date.parse(feature.timeline.latestExperimentAt), "and dominates the experiment too");
});

test("J3. the timeline boundary is exact: createdAt == evidenceAsOf is accepted, one millisecond earlier is refused", async () => {
  const evidenceAsOf = ctx.features.tiny.timeline.evidenceAsOf;
  const boundary = await buildClassifierFeature({
    classifierRoot: ctx.classifierRoot,
    captureRoot: ctx.captureRoot,
    cohortId: ctx.cohorts.tiny,
    now: () => Date.parse(evidenceAsOf),
    save: false,
  });
  assertEqual(boundary.feature.timeline.featureCreatedAt, evidenceAsOf, "equality is allowed (no backdating beyond evidence)");
  const error = await assertRejects(
    buildClassifierFeature({
      classifierRoot: ctx.classifierRoot,
      captureRoot: ctx.captureRoot,
      cohortId: ctx.cohorts.tiny,
      now: () => Date.parse(evidenceAsOf) - 1,
      save: true,
    }),
    (e) => e instanceof FeatureTimelineError,
    "one millisecond earlier fails closed",
  );
  assertEqual(Date.parse(error.evidenceAsOf) - Date.parse(error.featureCreatedAt), 1, "the error reports the exact gap");
});

test("J4. every built artifact preserves the ordering featureCreatedAt >= evidenceAsOf >= its sources", async () => {
  for (const name of Object.keys(ctx.features)) {
    const feature = ctx.features[name];
    assertTrue(Date.parse(feature.timeline.featureCreatedAt) >= Date.parse(feature.timeline.evidenceAsOf), `${name}: createdAt >= evidenceAsOf`);
    assertTrue(Date.parse(feature.timeline.evidenceAsOf) >= Date.parse(feature.timeline.latestCaptureAt), `${name}: evidenceAsOf >= latestCaptureAt`);
    assertTrue(Date.parse(feature.timeline.evidenceAsOf) >= Date.parse(feature.timeline.latestExperimentAt), `${name}: evidenceAsOf >= latestExperimentAt`);
    assertTrue(Date.parse(feature.timeline.latestCaptureAt) >= Date.parse(feature.timeline.earliestCaptureAt), `${name}: ordered capture bounds`);
  }
});

/* ============================================================================
 * PART K — existing barriers stay intact
 * ==========================================================================*/

async function datasetFingerprint(datasetId) {
  const stamp = datasetId.slice("session-".length, "session-".length + 8);
  const day = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
  const manifest = JSON.parse(await readFile(path.join(REPO, ".evolve", "history", day, datasetId, "manifest.json"), "utf8"));
  return manifest?.fingerprint?.combined ?? null;
}

test("K1. every sealed 5G.0 / 5G.1 source is byte-unchanged", async () => {
  for (const [file, expected] of Object.entries(SEALED_SOURCE_DIGESTS)) {
    assertEqual(await hashFileBuffered(path.join(REPO, file)), expected, `${file} is byte-identical`);
  }
});

test("K2. the canonical cohort keeps its identity and digest", async () => {
  if (!ctx.canonical.cohortPresent) {
    skip("the canonical 5G.1 cohort is not present here — the cohort barrier case was skipped");
    return;
  }
  const cohort = await readCohort(REAL_CLASSIFIER_ROOT, CANONICAL_COHORT_ID);
  assertEqual(cohort.cohortId, CANONICAL_COHORT_ID, "the canonical cohort id");
  assertEqual(cohort.cohortDigest, CANONICAL_COHORT_DIGEST, "the canonical cohort digest");
  assertEqual(cohort.evidenceClass, SOURCE_EVIDENCE_CLASS, "DEVELOPMENT_CLASSIFIER_EVIDENCE");
  assertDeepEqual(verifyCohort(cohort), { ok: true, problems: [] }, "the canonical cohort still verifies");
});

test("K3. the canonical evaluation keeps its identity and digest", async () => {
  if (!ctx.canonical.evaluationPresent) {
    skip("the canonical 5G.1 evaluation is not present here — the evaluation barrier case was skipped");
    return;
  }
  const evaluation = await readEvaluation(REAL_CLASSIFIER_ROOT, CANONICAL_EVALUATION_ID);
  assertEqual(evaluation.evaluationId, CANONICAL_EVALUATION_ID, "the canonical evaluation id");
  assertEqual(evaluation.evaluationDigest, CANONICAL_EVALUATION_DIGEST, "the canonical evaluation digest");
  assertEqual(evaluationDigestOf(evaluation), CANONICAL_EVALUATION_DIGEST, "and it still matches its own digest");
  assertEqual(evaluation.cohortDigest, CANONICAL_COHORT_DIGEST, "pinned to the canonical cohort digest");
  assertEqual(evaluation.evidenceClass, SOURCE_EVIDENCE_CLASS, "DEVELOPMENT classifier evidence only");
});

test("K4. the canonical classifier experiments keep their digests and verify offline", async () => {
  if (!ctx.canonical.experimentsPresent || !ctx.canonical.cohortPresent) {
    skip("the canonical classifier experiments are not present here — the experiment barrier case was skipped");
    return;
  }
  const experimentA = JSON.parse(await readFile(path.join(REAL_CLASSIFIER_ROOT, "experiments", CANONICAL_EXPERIMENT_A, CLASSIFIER_EXPERIMENT_FILE), "utf8"));
  const experimentB = JSON.parse(await readFile(path.join(REAL_CLASSIFIER_ROOT, "experiments", CANONICAL_EXPERIMENT_B, CLASSIFIER_EXPERIMENT_FILE), "utf8"));
  assertEqual(experimentA.experimentDigest, CANONICAL_EXPERIMENT_A_DIGEST, "experiment A digest");
  assertEqual(experimentA.resultDigest, CANONICAL_EXPERIMENT_A_RESULT, "experiment A result digest");
  assertEqual(experimentDigestOf(experimentA), CANONICAL_EXPERIMENT_A_DIGEST, "experiment A still matches its own digest");
  assertEqual(experimentB.experimentDigest, CANONICAL_EXPERIMENT_B_DIGEST, "experiment B digest");
  assertEqual(experimentB.resultDigest, CANONICAL_EXPERIMENT_B_RESULT, "experiment B result digest");
  assertEqual(experimentDigestOf(experimentB), CANONICAL_EXPERIMENT_B_DIGEST, "experiment B still matches its own digest");
  if (!(await exists(path.join(REAL_CAPTURE_ROOT, CAPTURE_DAY, experimentA.captureId)))) {
    skip("the canonical source captures are not present here — the offline cohort verification was skipped");
    return;
  }
  const cohort = await readCohort(REAL_CLASSIFIER_ROOT, CANONICAL_COHORT_ID);
  const evidence = await collectCohortEvidence({ classifierRoot: REAL_CLASSIFIER_ROOT, captureRoot: REAL_CAPTURE_ROOT, cohort, verifyIntegrity: true });
  assertEqual(evidence.experiments.length, 2, "both canonical experiments verify offline");
  assertEqual(evidence.observations.length, 100, "with 100 pooled classified records");
  assertEqual(new Set(evidence.observations.map((row) => row.recordDigest)).size, 100, "and 100 distinct record digests");
});

test("K5. the canonical infrastructure experiment is unchanged", async () => {
  const file = path.join(REAL_CLASSIFIER_ROOT, "experiments", CANONICAL_INFRASTRUCTURE_EXPERIMENT_ID, CLASSIFIER_EXPERIMENT_FILE);
  if (!(await exists(file))) {
    skip("the canonical one-record infrastructure experiment is not present here — its case was skipped");
    return;
  }
  const experiment = JSON.parse(await readFile(file, "utf8"));
  assertEqual(experiment.experimentDigest, CANONICAL_INFRASTRUCTURE_EXPERIMENT_DIGEST, "the infrastructure experiment digest");
  assertEqual(experiment.resultDigest, CANONICAL_INFRASTRUCTURE_RESULT_DIGEST, "the infrastructure result digest");
  assertEqual(experimentDigestOf(experiment), CANONICAL_INFRASTRUCTURE_EXPERIMENT_DIGEST, "and it still matches its own digest");
});

test("K6. every canonical Agent-Reach capture keeps its manifest digest", async () => {
  if (!ctx.canonical.capturesPresent) {
    skip("the canonical capture day is not present here — the capture barrier case was skipped");
    return;
  }
  for (const [captureId, expected] of Object.entries(CANONICAL_CAPTURE_DIGESTS)) {
    const manifest = JSON.parse(await readFile(path.join(REAL_CAPTURE_ROOT, CAPTURE_DAY, captureId, "manifest.json"), "utf8"));
    assertEqual(manifest.manifestDigest, expected, `${captureId} keeps its manifest digest`);
    assertEqual(manifest.immutable, true, `${captureId} is immutable`);
    assertEqual(manifest.finalized, true, `${captureId} is finalized`);
  }
});

test("K7. Wave 1 and Wave 2 datasets keep their pinned fingerprints", async () => {
  if (!ctx.canonical.replicationPresent || !(await exists(path.join(REPO, ".evolve", "history")))) {
    skip("the replication evidence is not present here — the dataset barrier case was skipped");
    return;
  }
  let checked = 0;
  for (const [ids, fingerprints] of [
    [WAVE_1_DATASET_IDS, WAVE_1_DATASET_FINGERPRINTS],
    [WAVE_2_DATASET_IDS, WAVE_2_DATASET_FINGERPRINTS],
  ]) {
    for (const datasetId of ids) {
      if (!(await exists(path.join(REPO, ".evolve", "history")))) continue;
      const fingerprint = await datasetFingerprint(datasetId).catch(() => null);
      if (fingerprint === null) continue;
      assertEqual(fingerprint, fingerprints[datasetId], `${datasetId} keeps its pinned fingerprint`);
      checked += 1;
    }
  }
  assertEqual(CANONICAL_WAVE_1_REPLICATION_ID, "rep-66884de4e460", "the canonical Wave 1 replication id");
  if (checked === 0) skip("no frozen dataset manifest is present here — the fingerprint comparison was skipped");
});

test("K8. the frozen replication cohorts keep their digests", async () => {
  if (!ctx.canonical.replicationPresent) {
    skip("the replication evidence is not present here — the frozen-cohort case was skipped");
    return;
  }
  const mock = await readFrozenCohort(path.join(REPO, ".evolve", "replication"), "mock").catch(() => null);
  const deepseek = await readFrozenCohort(path.join(REPO, ".evolve", "replication"), "deepseek").catch(() => null);
  if (!mock || !deepseek) {
    skip("the frozen Mock/DeepSeek cohorts are not present here — the case was skipped");
    return;
  }
  assertEqual(mock.cohortDigest, FROZEN_COHORT_DIGESTS.mock, "the Mock cohort digest is unchanged");
  assertEqual(deepseek.cohortDigest, FROZEN_COHORT_DIGESTS.deepseek, "the DeepSeek cohort digest is unchanged");
});

test("K9. the evaluation contract digest is unchanged", async () => {
  assertEqual(CANONICAL_EVALUATION_CONTRACT_DIGEST, "4cf8ac1fa7db290acadeccf6043ec34c3239f8e3f848e9e50d8560826de85052", "the published contract pin");
  if (!ctx.canonical.replicationPresent) {
    skip("the stored Wave 1 freeze is not present here — the derived-contract case was skipped");
    return;
  }
  const stored = await readFreeze({ root: path.join(REPO, ".evolve", "replication") }).catch(() => null);
  if (!stored) {
    skip("the stored freeze could not be read here — the derived-contract case was skipped");
    return;
  }
  assertEqual(evaluationContractDigest(stored), CANONICAL_EVALUATION_CONTRACT_DIGEST, "the STORED freeze still derives the canonical digest");
});

test("K10. nothing under .evolve/ changed during this suite", async () => {
  assertDeepEqual(await metadataSnapshot(REAL_CLASSIFIER_ROOT), ctx.baseline.classifier, "the canonical classifier tree is byte-identical");
  assertDeepEqual(await metadataSnapshot(REAL_CAPTURE_ROOT), ctx.baseline.intelligence, "the canonical capture tree is byte-identical");
  assertDeepEqual(await metadataSnapshot(path.join(REPO, ".evolve", "replication")), ctx.baseline.replication, "the replication tree is byte-identical");
  // The suite must create NO new feature artifact. The exact clfeat directory set
  // is captured before the suite runs (empty when the operator has not frozen one)
  // and must be byte-for-byte unchanged afterwards — the canonical barrier
  // artifact, when present, is inspected READ-ONLY and never rewritten.
  const clfeatDirs = (await readdir(path.join(REAL_CLASSIFIER_ROOT, "features")).catch(() => []))
    .filter((name) => name.startsWith("clfeat-"))
    .sort();
  assertDeepEqual(clfeatDirs, ctx.canonical.clfeatDirs, "the canonical clfeat-* directory set is unchanged (this suite wrote nothing)");
  if (ctx.canonical.featuresAbsent) assertEqual(clfeatDirs.length, 0, "no canonical feature artifact exists here and none was created");
});

/* ============================================================================
 * PART L — no-downstream scan (static, comments stripped)
 * ==========================================================================*/

test("L1. no network primitive exists in the new 5H runtime code", async () => {
  for (const file of RUNTIME_FILES) assertTrue(ctx.sources.get(file).length > 0, `${file} was readable for the scan`);
  const hits = scan(ctx.sources, /\bfetch\s*\(|node:https?\b|\baxios\b|\bundici\b|node-fetch|XMLHttpRequest|WebSocket/);
  assertDeepEqual(hits, [], "no network primitive in the 5H runtime code");
});

test("L2. no subprocess, eval, Function or VM execution exists in the new 5H runtime code", async () => {
  const hits = scan(ctx.sources, /child_process|spawnSync|execFileSync|execSync|\bspawn\s*\(|\beval\s*\(|new Function|node:vm|\bvm\.(run|createContext)|import\s*\(/);
  assertDeepEqual(hits, [], "no code execution primitive in the 5H runtime code");
});

test("L3. no wallet/signer/swap/transaction/RPC code exists in the new 5H runtime code", async () => {
  const hits = scan(
    ctx.sources,
    /\bKeypair\b|sendTransaction|signTransaction|simulateTransaction|getLatestBlockhash|sendRawTransaction|new Connection\s*\(|@solana\/web3|solanaWeb3|createSigner\s*\(|getSigner\s*\(|signMessage\s*\(|\bnew Wallet\b|\.sendAndConfirmTransaction\s*\(|\bswap\s*\(/,
  );
  assertDeepEqual(hits, [], "no wallet/signer/swap/transaction/RPC call exists in the 5H runtime code");
  // The frozen denylist still NAMES the meanings 5H.0 refuses (as data, never as code).
  for (const word of ["wallet", "signer", "swap", "transaction", "rpc"]) {
    assertTrue(ctx.sources.get("scripts/intelligence/classifier-feature-definition.mjs").includes(word), `the frozen denylist names '${word}'`);
  }
});

test("L4. no Jev/DeepSeek/research/Arena/trading module is imported by the new 5H runtime code", async () => {
  for (const file of RUNTIME_FILES) {
    for (const specifier of importSpecifiers(ctx.sources.get(file))) {
      assertTrue(!FORBIDDEN_IMPORT_PATTERN.test(specifier), `${file} must not import '${specifier}'`);
    }
  }
});

test("L5. the new 5H modules declare NO routing activation", async () => {
  const hits = scan(ctx.sources, /RoutingActive\s*:\s*true/);
  assertDeepEqual(hits, [], "no routing flag is ever set true");
  for (const flag of ["jevRoutingActive", "deepseekRoutingActive", "arenaRoutingActive", "tradingRoutingActive"]) {
    assertTrue(ctx.sources.get("scripts/intelligence/classifier-features.mjs").includes(flag), `${flag} is declared explicitly`);
  }
});

/* ============================================================================
 * PART M — canonical cross-check against the frozen 5G.1 evaluation
 * ==========================================================================*/

const CROSS_CHECK_NOW = Date.parse("2026-09-19T18:00:00.000Z");

test("M1. the canonical 5G.1 evidence is available for a cross-check", async () => {
  if (!ctx.canonical.cohortPresent || !ctx.canonical.evaluationPresent || !ctx.canonical.experimentsPresent || !ctx.canonical.capturesPresent) {
    skip("the canonical 5G.1 cohort/evaluation is absent here — the cross-check was skipped cleanly");
    return;
  }
  const cohort = await readCohort(REAL_CLASSIFIER_ROOT, CANONICAL_COHORT_ID);
  assertEqual(cohort.cohortId, CANONICAL_COHORT_ID, "the cross-check targets the pinned cohort");
  assertEqual(cohort.cohortDigest, CANONICAL_COHORT_DIGEST, "and its pinned digest");
  // The cross-check derives 5H values WITHOUT saving. The canonical feature tree is
  // captured before the cross-check (whatever its state: absent, or the ONE pinned
  // operator artifact) and must be byte-for-byte unchanged afterwards.
  ctx.crossCheckFeatureDirsBefore = (await readdir(path.join(REAL_CLASSIFIER_ROOT, "features")).catch(() => []))
    .filter((name) => name.startsWith("clfeat-"))
    .sort();
  if (ctx.canonical.featurePresent) {
    assertDeepEqual(ctx.crossCheckFeatureDirsBefore, [CANONICAL_FEATURE_ID], "only the pinned canonical artifact exists under the canonical root");
  }
  ctx.crossCheckReady = true;
});

test("M2. computing 5H values from the real frozen evidence writes NOTHING", async () => {
  if (!ctx.crossCheckReady) {
    skip("the canonical evidence is absent — the no-write cross-check was skipped");
    return;
  }
  const beforeClassifier = await metadataSnapshot(REAL_CLASSIFIER_ROOT);
  const beforeCaptures = await metadataSnapshot(REAL_CAPTURE_ROOT);
  const result = await buildClassifierFeature({
    classifierRoot: REAL_CLASSIFIER_ROOT,
    captureRoot: REAL_CAPTURE_ROOT,
    cohortId: CANONICAL_COHORT_ID,
    now: () => CROSS_CHECK_NOW,
    save: false,
  });
  ctx.crossCheckFeature = result.feature;
  assertEqual(result.saved, false, "nothing was saved");
  assertEqual(result.dir, null, "no directory was claimed");
  assertEqual(result.feature.classifiedCount, 100, "100 pooled classified records");
  assertEqual(result.feature.scoreVectorCompleteCount, 100, "100 complete score vectors");
  assertTrue(result.audit.ok, `the derived artifact audits clean: ${result.audit.problems.join("; ")}`);
  assertDeepEqual(await metadataSnapshot(REAL_CLASSIFIER_ROOT), beforeClassifier, "the canonical classifier tree did not move");
  assertDeepEqual(await metadataSnapshot(REAL_CAPTURE_ROOT), beforeCaptures, "nor the capture tree");
  const afterDirs = (await readdir(path.join(REAL_CLASSIFIER_ROOT, "features")).catch(() => []))
    .filter((name) => name.startsWith("clfeat-"))
    .sort();
  assertDeepEqual(afterDirs, ctx.crossCheckFeatureDirsBefore, "the cross-check created NO feature artifact");
});

test("M3. every 5H label fraction, entropy, concentration and confidence value equals the frozen 5G.1 evaluation", async () => {
  if (!ctx.crossCheckFeature) {
    skip("the canonical cross-check did not run — the label/confidence comparison was skipped");
    return;
  }
  const evaluation = await readEvaluation(REAL_CLASSIFIER_ROOT, CANONICAL_EVALUATION_ID);
  const metrics = evaluation.metrics;
  const feature = ctx.crossCheckFeature;
  assertEqual(evaluation.evaluationDigest, CANONICAL_EVALUATION_DIGEST, "the frozen 5G.1 evaluation digest");
  assertEqual(feature.cohortDigest, evaluation.cohortDigest, "both reference the same cohort digest");
  assertEqual(feature.classifiedCount, metrics.labelDistribution.totalClassified, "the same classified count");
  assertDeepEqual(Object.keys(feature.counts.labelCounts), CLASSIFIER_LABELS, "all nine labels are present");
  for (const entry of metrics.labelDistribution.labels) {
    assertEqual(feature.counts.labelCounts[entry.label], entry.count, `${entry.label} count agrees`);
    assertEqual(feature.features[labelFeatureName(entry.label)], entry.fraction, `${entry.label} fraction agrees EXACTLY`);
  }
  assertEqual(feature.features.label_entropy_normalized, metrics.labelDistribution.labelDiversity, "entropy === the sealed 5G.1 labelDiversity");
  assertEqual(feature.features.observed_label_count, metrics.labelDistribution.labelsObserved, "the observed label count agrees");
  assertEqual(feature.counts.largestLabel, metrics.concentration.largestLabel, "the largest label agrees");
  assertEqual(feature.counts.largestLabelCount, metrics.concentration.largestLabelCount, "the largest label count agrees");
  assertEqual(feature.features.largest_label_fraction, metrics.concentration.largestLabelFraction, "the largest label fraction agrees");
  assertEqual(feature.features.confidence_mean, metrics.confidence.mean, "the confidence mean agrees");
  assertEqual(feature.features.confidence_median, metrics.confidence.median, "the confidence median agrees");
  assertEqual(feature.features.confidence_low_fraction, metrics.confidence.bands.below_0_50.fraction, "the <0.50 confidence fraction agrees");
  assertEqual(feature.features.confidence_high_fraction, metrics.confidence.bands.at_least_0_90.fraction, "the >=0.90 confidence fraction agrees");
  assertEqual(feature.nullFeatureCount, 0, "no null feature on complete canonical evidence");
});

test("M4. every 5H margin value and both aliases equal the frozen 5G.1 evaluation", async () => {
  if (!ctx.crossCheckFeature) {
    skip("the canonical cross-check did not run — the margin/alias comparison was skipped");
    return;
  }
  const evaluation = await readEvaluation(REAL_CLASSIFIER_ROOT, CANONICAL_EVALUATION_ID);
  const metrics = evaluation.metrics;
  const feature = ctx.crossCheckFeature;
  assertEqual(feature.features.score_margin_mean, metrics.scoreMargin.mean, "the margin mean agrees");
  assertEqual(feature.features.score_margin_median, metrics.scoreMargin.median, "the margin median agrees");
  assertEqual(feature.features.score_margin_ambiguous_fraction, metrics.scoreMargin.bands.below_0_10.fraction, "the <0.10 margin fraction agrees");
  assertEqual(feature.features.label_fraction_unrelated_or_noise, metrics.noise.fraction, "the noise alias agrees with the sealed noise fraction");
  assertEqual(feature.features.label_fraction_promotion_or_marketing, metrics.promotion.fraction, "the promotion alias agrees");
  assertEqual(feature.duplicateRecordDigestCount, 0, "no canonical record digest is duplicated across the two captures");
  assertEqual(feature.distinctRecordDigestCount, 100, "100 distinct record digests");
  assertEqual(feature.evidenceClass, DERIVED_EVIDENCE_CLASS, "the artifact declares DEVELOPMENT_CLASSIFIER_DERIVED_FEATURES");
  assertEqual(feature.sourceEvidenceClass, SOURCE_EVIDENCE_CLASS, "and pins its DEVELOPMENT classifier source");
  assertEqual(feature.featureDefinitionDigest, FEATURE_DEFINITION_DIGEST, "and the frozen definition digest");
  const experimentB = JSON.parse(await readFile(path.join(REAL_CLASSIFIER_ROOT, "experiments", CANONICAL_EXPERIMENT_B, CLASSIFIER_EXPERIMENT_FILE), "utf8"));
  assertEqual(feature.timeline.evidenceAsOf, experimentB.createdAt, "evidenceAsOf is the latest canonical experiment time");
  assertTrue(Date.parse(feature.timeline.featureCreatedAt) >= Date.parse(feature.timeline.evidenceAsOf), "the derived clock never precedes the evidence");
  for (const flag of ["jevRoutingActive", "deepseekRoutingActive", "arenaRoutingActive", "tradingRoutingActive"]) {
    assertEqual(feature.routing[flag], false, `${flag} is false on the canonical evidence too`);
  }
});

/* ============================================================================
 * PART N — canonical Phase 5H.0 barrier (the ONE operator-approved artifact)
 * ==========================================================================*
 * The operator froze exactly ONE canonical 5H.0 artifact locally:
 *
 *   clfeat-20260919T173844Z-7a9193bb
 *   65218b38f80a344a99f12f8a98784a49250d0ec0b88cd88ea9cd795fab39312b
 *
 * It lives under the gitignored `.evolve/classifier/features/` tree and is NEVER
 * copied into Git. Every case here is READ ONLY: it inspects the artifact when it
 * is present locally and skips cleanly (rather than failing CI) when it is not.
 * Nothing is ever created, rewritten or reclassified.
 * ==========================================================================*/

const CANONICAL_FEATURE_FILE = path.join(REAL_CLASSIFIER_ROOT, "features", CANONICAL_FEATURE_ID, "feature.json");

function skipCanonical(reason) {
  skip(reason);
}

async function readCanonicalFeature() {
  return readFeatureArtifact(REAL_CLASSIFIER_ROOT, CANONICAL_FEATURE_ID);
}

test("N1. the canonical barrier constants are internally consistent with the frozen 5H.0 pins", async () => {
  assertEqual(CANONICAL_FEATURE_DEFINITION_VERSION, FEATURE_DEFINITION_VERSION, "the barrier pins the published definition version");
  assertEqual(CANONICAL_FEATURE_DEFINITION_DIGEST, FEATURE_DEFINITION_DIGEST, "the barrier pins the ACTUAL computed definition digest");
  assertEqual(CANONICAL_FEATURE_SOURCE_COHORT_ID, CANONICAL_COHORT_ID, "the barrier's cohort id is the canonical 5G.1 cohort");
  assertEqual(CANONICAL_FEATURE_SOURCE_COHORT_DIGEST, CANONICAL_COHORT_DIGEST, "the barrier's cohort digest is the canonical 5G.1 cohort digest");
  assertEqual(CANONICAL_FEATURE_EVIDENCE_CLASS, DERIVED_EVIDENCE_CLASS, "the barrier derives DEVELOPMENT_CLASSIFIER_DERIVED_FEATURES");
  assertEqual(CANONICAL_FEATURE_SOURCE_EVIDENCE_CLASS, SOURCE_EVIDENCE_CLASS, "from DEVELOPMENT_CLASSIFIER_EVIDENCE");
  assertEqual(CANONICAL_FEATURE_EVIDENCE_AS_OF, "2026-09-19T16:34:12.867Z", "the barrier pins the exact evidenceAsOf");
  assertTrue(isValidFeatureId(CANONICAL_FEATURE_ID), "the barrier feature id is a valid clfeat id");
  assertTrue(/^[0-9a-f]{64}$/.test(CANONICAL_FEATURE_DIGEST), "the barrier feature digest is a sha256 hex string");
  assertDeepEqual(Object.keys(CANONICAL_FEATURE_VALUES), EXPECTED_FEATURE_NAMES, "the barrier pins exactly the 19 canonical values in canonical order");
});

test("N2. the canonical feature artifact is DETECTED locally (or skipped cleanly)", async () => {
  if (!ctx.canonical.featurePresent) {
    skipCanonical("the canonical Phase 5H.0 feature artifact is absent here — the canonical barrier cases were skipped cleanly");
    return;
  }
  assertTrue(await exists(CANONICAL_FEATURE_FILE), "the canonical feature.json exists on disk");
  const raw = JSON.parse(await readFile(CANONICAL_FEATURE_FILE, "utf8"));
  assertEqual(raw.featureId, CANONICAL_FEATURE_ID, "the file names the pinned canonical feature id");
  assertEqual(raw.featureDigest, CANONICAL_FEATURE_DIGEST, "and carries the pinned canonical feature digest");
  assertEqual(CANONICAL_FEATURE_ID, buildFeatureId({ now: Date.parse(raw.createdAt), identityDigest: featureIdentityDigest(raw) }), "its id rederives from the stored clock + identity");
  assertEqual(featureDigestOf(raw), CANONICAL_FEATURE_DIGEST, "its featureDigest recomputes from the artifact body");
});

test("N3. the canonical artifact pins its exact identity, definition and source cohort", async () => {
  if (!ctx.canonical.featurePresent) {
    skipCanonical("the canonical feature artifact is absent here — the identity barrier case was skipped");
    return;
  }
  const feature = await readCanonicalFeature();
  assertEqual(feature.phase, "5H.0", "the artifact is a Phase 5H.0 artifact");
  assertEqual(feature.featureId, CANONICAL_FEATURE_ID, "exact feature id");
  assertEqual(feature.featureDigest, CANONICAL_FEATURE_DIGEST, "exact feature digest");
  assertEqual(featureDigestOf(feature), CANONICAL_FEATURE_DIGEST, "the feature digest recomputes");
  const identitySubject = featureIdentitySubject(feature);
  assertTrue(!Object.hasOwn(identitySubject, "featureId") && !Object.hasOwn(identitySubject, "featureDigest"), "the identity subject excludes featureId + featureDigest");
  assertTrue(/^[0-9a-f]{64}$/.test(featureIdentityDigest(feature)), "the identity digest is a sha256 hex string");
  assertEqual(feature.featureId, buildFeatureId({ now: Date.parse(feature.createdAt), identityDigest: featureIdentityDigest(feature) }), "the feature identity recomputes");
  assertEqual(feature.featureDefinitionVersion, CANONICAL_FEATURE_DEFINITION_VERSION, "exact feature-definition version");
  assertEqual(feature.featureDefinitionDigest, CANONICAL_FEATURE_DEFINITION_DIGEST, "exact feature-definition digest");
  assertEqual(feature.cohortId, CANONICAL_FEATURE_SOURCE_COHORT_ID, "exact source cohort id");
  assertEqual(feature.cohortDigest, CANONICAL_FEATURE_SOURCE_COHORT_DIGEST, "exact source cohort digest");
  assertEqual(feature.evidenceClass, CANONICAL_FEATURE_EVIDENCE_CLASS, "evidence class is DEVELOPMENT_CLASSIFIER_DERIVED_FEATURES");
  assertEqual(feature.sourceEvidenceClass, CANONICAL_FEATURE_SOURCE_EVIDENCE_CLASS, "source evidence class is DEVELOPMENT_CLASSIFIER_EVIDENCE");
  assertEqual(feature.timeline.evidenceAsOf, CANONICAL_FEATURE_EVIDENCE_AS_OF, "exact evidenceAsOf");
  assertEqual(feature.createdAt, feature.timeline.featureCreatedAt, "createdAt mirrors the timeline");
  assertTrue(Date.parse(feature.timeline.featureCreatedAt) >= Date.parse(feature.timeline.evidenceAsOf), "the build clock never precedes the evidence");
});

test("N4. the canonical artifact pins the exact records, digests, vectors and null counts", async () => {
  if (!ctx.canonical.featurePresent) {
    skipCanonical("the canonical feature artifact is absent here — the counts barrier case was skipped");
    return;
  }
  const feature = await readCanonicalFeature();
  assertEqual(feature.recordCount, 100, "100 records");
  assertEqual(feature.classifiedCount, 100, "100 classified");
  assertEqual(feature.skippedEmptyCount, 0, "zero skipped");
  assertEqual(feature.distinctRecordDigestCount, 100, "100 distinct record digests");
  assertEqual(feature.duplicateRecordDigestCount, 0, "zero duplicate record digests");
  assertEqual(feature.scoreVectorCompleteCount, 100, "100 complete score vectors");
  assertEqual(feature.scoreVectorIncompleteCount, 0, "zero incomplete score vectors");
  assertEqual(feature.nullFeatureCount, 0, "zero null features");
  assertEqual(feature.recordCount, feature.classifiedCount + feature.skippedEmptyCount, "recordCount = classified + skipped");
  assertEqual(feature.distinctRecordDigestCount + feature.duplicateRecordDigestCount, feature.recordCount, "distinct + duplicate = recordCount");
  assertEqual(feature.scoreVectorCompleteCount + feature.scoreVectorIncompleteCount, feature.classifiedCount, "complete + incomplete = classified");
  assertEqual(feature.experimentCount, 2, "two frozen classifier experiments");
  assertEqual(feature.captureCount, 2, "two frozen source captures");
  assertEqual(feature.infrastructureExperimentPresent, false, "the one-record infrastructure experiment is absent");
  assertDeepEqual(feature.counts.labelCounts, {
    technical_activity: 15,
    project_announcement: 11,
    exchange_or_listing: 4,
    liquidity_or_market_structure: 25,
    security_or_risk: 0,
    governance_or_admin: 24,
    community_attention: 0,
    promotion_or_marketing: 14,
    unrelated_or_noise: 7,
  }, "the exact pooled label counts");
  assertEqual(feature.counts.largestLabel, "liquidity_or_market_structure", "the modal label");
  assertEqual(feature.counts.largestLabelCount, 25, "with count 25");
});

test("N5. the canonical artifact pins the exact 19 canonical feature values", async () => {
  if (!ctx.canonical.featurePresent) {
    skipCanonical("the canonical feature artifact is absent here — the feature-value barrier case was skipped");
    return;
  }
  const feature = await readCanonicalFeature();
  assertDeepEqual(Object.keys(feature.features), EXPECTED_FEATURE_NAMES, "exactly the 19 canonical keys in canonical order");
  assertDeepEqual(feature.features, CANONICAL_FEATURE_VALUES, "the exact canonical feature values");
  assertEqual(feature.features.observed_label_count, 7, "observed_label_count is 7");
  assertEqual(feature.features.label_entropy_normalized, 0.822223, "label_entropy_normalized is 0.822223");
  assertEqual(feature.features.score_margin_mean, 0.4897, "score_margin_mean is 0.4897");
  assertEqual(feature.features.score_margin_median, 0.455, "score_margin_median is 0.455");
  assertEqual(feature.features.score_margin_ambiguous_fraction, 0.11, "score_margin_ambiguous_fraction is 0.11");
  for (const [name, value] of Object.entries(CANONICAL_FEATURE_VALUES)) assertEqual(feature.features[name], value, `${name} equals the pinned canonical value`);
});

test("N6. the canonical artifact is record-weighted, non-averaged, routing-free and descriptive only", async () => {
  if (!ctx.canonical.featurePresent) {
    skipCanonical("the canonical feature artifact is absent here — the aggregation/routing barrier case was skipped");
    return;
  }
  const feature = await readCanonicalFeature();
  assertDeepEqual(feature.aggregation, { mode: "record-weighted", unit: "cohort", experimentsAveraged: false }, "record-weighted cohort aggregation, experimentsAveraged === false");
  const experimentIds = Object.values(feature.experimentRecordCounts ?? {});
  assertEqual(experimentIds.reduce((sum, count) => sum + count, 0), feature.classifiedCount, "the per-experiment record counts pool to the classified count");
  for (const flag of ["jevRoutingActive", "deepseekRoutingActive", "arenaRoutingActive", "tradingRoutingActive"]) {
    assertEqual(feature.routing[flag], false, `routing flag ${flag} is strictly false`);
  }
  for (const flag of ["immutable", "finalized", "descriptiveOnly", "developmentOnly", "noGroundTruth", "noProfitabilityInference"]) {
    assertEqual(feature[flag], true, `frozen flag '${flag}' is true`);
  }
  assertTrue(feature.descriptiveOnly === true && feature.developmentOnly === true, "descriptiveOnly and developmentOnly are strictly true");
  assertTrue(feature.noGroundTruth === true && feature.noProfitabilityInference === true, "noGroundTruth and noProfitabilityInference are strictly true");
});

test("N7. the canonical artifact audits clean", async () => {
  if (!ctx.canonical.featurePresent) {
    skipCanonical("the canonical feature artifact is absent here — the audit barrier case was skipped");
    return;
  }
  const audit = auditClassifierFeatureArtifact(await readCanonicalFeature());
  assertTrue(audit.ok, `the canonical artifact audits clean: ${audit.problems.join("; ")}`);
  assertDeepEqual(audit.problems, [], "no audit problems");
});

test("N8. offline replay of the canonical artifact returns integrity OK and the exact feature digest", async () => {
  if (!ctx.canonical.featurePresent) {
    skipCanonical("the canonical feature artifact is absent here — the replay barrier case was skipped");
    return;
  }
  if (!ctx.canonical.cohortPresent || !ctx.canonical.experimentsPresent || !ctx.canonical.capturesPresent) {
    skipCanonical("the canonical cohort/experiments/captures are absent here — the canonical replay was skipped cleanly");
    return;
  }
  const before = await metadataSnapshot(REAL_CLASSIFIER_ROOT);
  const beforeCaptures = await metadataSnapshot(REAL_CAPTURE_ROOT);
  const report = await replayClassifierFeature({ classifierRoot: REAL_CLASSIFIER_ROOT, captureRoot: REAL_CAPTURE_ROOT, featureId: CANONICAL_FEATURE_ID });
  assertTrue(report.ok, `the canonical replay reports integrity OK: ${report.problems.join(" | ")}`);
  assertEqual(report.featureId, CANONICAL_FEATURE_ID, "the replay targets the canonical feature id");
  assertEqual(report.featureDigest, CANONICAL_FEATURE_DIGEST, "the replay reports the exact canonical feature digest");
  assertEqual(report.recomputedFeatureDigest, CANONICAL_FEATURE_DIGEST, "and reproduces the exact feature digest");
  assertEqual(report.checks.featureDigestReproduced, true, "the featureDigestReproduced check passes");
  assertEqual(report.evidenceClass, CANONICAL_FEATURE_EVIDENCE_CLASS, "the replay reports the derived evidence class");
  assertEqual(report.classifiedCount, 100, "the replay reports 100 classified records");
  assertEqual(report.networkCalls, 0, "zero network calls during the canonical replay");
  assertTrue(!/https?:\/\//.test(JSON.stringify(report)), "no URL appears in the replay report");
  assertDeepEqual(await metadataSnapshot(REAL_CLASSIFIER_ROOT), before, "the canonical replay REWROTE nothing (READ ONLY)");
  assertDeepEqual(await metadataSnapshot(REAL_CAPTURE_ROOT), beforeCaptures, "and touched no capture byte");
});

test("N9. the canonical artifact was never rewritten or duplicated during this suite", async () => {
  const clfeatDirs = (await readdir(path.join(REAL_CLASSIFIER_ROOT, "features")).catch(() => []))
    .filter((name) => name.startsWith("clfeat-"))
    .sort();
  assertDeepEqual(clfeatDirs, ctx.canonical.clfeatDirs, "the canonical clfeat-* directory set is byte-for-byte unchanged");
  if (!ctx.canonical.featurePresent) {
    assertEqual(clfeatDirs.length, 0, "no canonical feature artifact exists here and none was created");
    return;
  }
  assertDeepEqual(clfeatDirs, [CANONICAL_FEATURE_ID], "the ONE canonical artifact is exactly the pinned id");
  const raw = JSON.parse(await readFile(CANONICAL_FEATURE_FILE, "utf8"));
  assertEqual(raw.featureDigest, CANONICAL_FEATURE_DIGEST, "the on-disk feature digest is still the canonical barrier digest");
  assertEqual(featureDigestOf(raw), CANONICAL_FEATURE_DIGEST, "and the artifact bytes still recompute to it");
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
    console.error("could not build Phase 5H.0 fixtures:", error?.stack ?? error);
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

  await disposeFixtures().catch(() => {});

  console.log(`\nfixtures built in ${fixtureMs}ms`);
  console.log("offline: no network call, no classifier.dev request, no Agent-Reach call, no capture, no Jev, no DeepSeek, no");
  console.log("Arena run, no trading, and nothing written under .evolve/.");
  if (skips.length > 0) {
    console.log(`skipped ${skips.length} optional case(s) whose canonical evidence is absent here:`);
    for (const reason of skips) console.log(`  - ${reason}`);
  }
  console.log(`EVOLVE Phase 5H.0 deterministic classifier-derived feature validation: ${passed}/${cases.length} checks passed`);

  if (failures.length > 0) {
    console.log("Failed checks:");
    for (const failure of failures) console.log(`  - ${failure.name}`);
    process.exitCode = 1;
  } else {
    console.log("All Phase 5H.0 checks passed. `classifier-feature-definition-v1` is frozen, the 19 canonical features are");
    console.log("extracted record-by-record from ONE frozen cohort, every artifact is audited before write and reproduced on");
    console.log("replay, `0` never stands for unknown, and all four routing flags stay false.");
    console.log(`canonical barrier: ${CANONICAL_FEATURE_ID} (${CANONICAL_FEATURE_DIGEST}) — ${ctx.canonical.featurePresent ? "detected locally and verified READ-ONLY" : "absent here (barrier cases skipped cleanly)"}`);
  }
}

run().catch((error) => {
  console.error("phase 5H.0 validation runner crashed:", error);
  process.exitCode = 1;
});
