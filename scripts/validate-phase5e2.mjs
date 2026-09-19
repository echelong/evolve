#!/usr/bin/env node
/**
 * EVOLVE Phase 5E.2 validation suite — VERSIONED FEATURE TRANSFORMS, SHADOW ONLY.
 *
 * Phase 5E captured bytes and froze them. It did NOT freeze the transform that
 * turns those bytes into a feature vector, so any later edit to `features.mjs`
 * could silently reinterpret an immutable capture and move its `featuresDigest`,
 * `replayDigest` and `packetDigest` without a single frozen byte changing. This
 * suite pins the fix:
 *
 *   * a VERSIONED feature registry (`external-intelligence-features-v1` / `-v2`)
 *     with `featureExtractorFor(version)`;
 *   * explicit BACKWARDS COMPATIBILITY: a schema-1 manifest with no pin is V1,
 *     never "latest";
 *   * FAIL-CLOSED on an unknown, empty or missing-where-required version;
 *   * V2 semantics that separate RECORD COUNT from OBSERVED-FIELD COUNT and
 *     DISTINCT-VALUE COUNT, so missing data is UNKNOWN rather than concentration;
 *   * a minimum RELEVANT SAMPLE before any coordination indicator may fire, so a
 *     one-record capture can never be described as coordination evidence.
 *
 * It also re-proves the identity barriers: the real first capture is byte
 * untouched and still replays to its pinned V1 digests; Wave 1, Wave 2, the six
 * replication datasets and the frozen cohorts are byte-identical; the evaluation
 * contract digest is unchanged; and nothing is routed to Jev, DeepSeek or the
 * Arena.
 *
 * Fully OFFLINE and deterministic: no live capture, no provider call, no network
 * call, no upstream tool executed, no Jev call, no DeepSeek call, no Arena run.
 * No file under `.evolve/` is ever written by this suite.
 *
 * Run with: npm run validate:phase5e2
 */

import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { canonicalJson } from "./lib/hash.mjs";
import {
  CAPTURE_SCHEMA_VERSION,
  LEGACY_CAPTURE_SCHEMA_VERSION,
  listCaptures,
  loadCaptureRecords,
  readCaptureManifest,
  runCapture,
  verifyCapture,
} from "./intelligence/capture.mjs";
import {
  INTELLIGENCE_REPLAY_VERSION,
  captureStats,
  replayCapture,
  resolveCaptureFeatureVersion,
  verifyReplayDeterminism,
} from "./intelligence/replay.mjs";
import {
  COORDINATION_MIN_OBSERVATIONS,
  COORDINATION_THRESHOLDS,
  DEFAULT_FEATURE_VERSION,
  FEATURE_CLOCK_FIELDS,
  INTELLIGENCE_FEATURE_VERSION,
  INTELLIGENCE_FEATURE_VERSION_V2,
  LEGACY_INTELLIGENCE_FEATURE_VERSION,
  REGISTERED_FEATURE_VERSIONS,
  UnknownFeatureVersionError,
  extractIntelligenceFeatures,
  extractIntelligenceFeaturesV2,
  featureExtractorFor,
  featuresDigest,
  featuresDigestSubject,
  isRegisteredFeatureVersion,
  observationCounts,
} from "./intelligence/features.mjs";
import {
  ALLOWED_PACKET_KEYS,
  DEEPSEEK_ROUTING_ACTIVE,
  JEV_ROUTING_ACTIVE,
  assertPacketAllowed,
  auditExternalIntelligencePacket,
  buildExternalIntelligencePacket,
} from "./intelligence/packet.mjs";
import { resolveIntelligenceConfig } from "./intelligence/config.mjs";
import {
  REACH_CAPABILITY_MAP_V1,
  REACH_EXECUTABLE_ALLOWLIST,
  REACH_UPSTREAM_EXECUTABLES,
} from "./intelligence/agent-reach.mjs";
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
const LATER = Date.parse("2026-09-19T12:00:00.000Z");

/* Pinned identities from the first real capture (infrastructure proof only). */
const REAL_CAPTURE_ROOT = path.join(REPO, ".evolve", "intelligence");
const REAL_CAPTURE_ID = "capture-20260919T122601Z";
const REAL_CAPTURE_PINS = Object.freeze({
  manifestDigest: "76241b868f7e2839b04cb6f1328172ce01c7fff9fa0a071f92bd7e69d01a2ce2",
  recordsDigest: "3774472ca3ad666537ebd193599b4ce9467fc8b1821da7b9c7597ea8917801f1",
  replayDigest: "b3904fe25071bdb85c555b2f8138ca61f06edf29aaccbc06a037c711d4ef7f07",
  packetDigest: "ce82b740ae7a350d6a433e3c84ceac26192171b2fd4d475468d4183831c27b84",
});

const FIXTURE_ROOT = path.join(REPO, "scripts", "intelligence", "fixtures", "legacy-capture-schema1");
const FIXTURE_CAPTURE_ID = "capture-20260101T000000Z";
const FIXTURE_EXPECTED = path.join(FIXTURE_ROOT, "expected-v1.json");

/* Pinned frozen-cohort identities (Phase 5C.3). */
const FROZEN_COHORT_DIGESTS = Object.freeze({
  mock: "b26d63a2a0787e954ed7e4e63e668fe4664e58059508145345214facc4e12858",
  deepseek: "13c7c93d707b26f8b92042d488ff0a63f5de3f9f81b8145be4eac7a70cc550a8",
});

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
  if (matcher instanceof RegExp) {
    if (!matcher.test(String(thrown?.message ?? thrown))) {
      fail(`${message} — thrown message ${JSON.stringify(String(thrown?.message ?? thrown))} does not match ${matcher}`);
    }
    return thrown;
  }
  if (typeof matcher === "function") {
    if (thrown?.name !== matcher.name && !(thrown instanceof matcher)) {
      fail(`${message} — expected ${matcher.name}, got ${thrown?.name}: ${thrown?.message ?? thrown}`);
    }
    return thrown;
  }
  return thrown;
}
/** A clearly-labelled skip: the evidence this assertion needs does not exist here. */
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
  v2Capture: null,
  fixtureExpected: null,
  realCaptureAvailable: false,
  evidenceAvailable: false,
  evidenceBaseline: {},
  intelligenceSources: new Map(),
};

/** The GitHub-shaped record the first real capture produced (no author, no clock). */
function githubShapedRecord(overrides = {}) {
  return {
    channel: "github",
    backend: "agent-reach",
    queryId: "mint-github",
    authorId: null,
    textExcerpt: "So11111111111111111111111111111111111111112",
    canonicalUrl: "https://github.com/alsaaeq91/Baby-btc",
    publishedAt: null,
    engagement: null,
    ...overrides,
  };
}

/**
 * A synthetic record builder for the V2 semantics cases.
 *
 * `index` alone drives every field, so the sets below are deterministic and the
 * expected denominators are obvious from the call site.
 */
function semanticRecords({ authors = [], texts = [], domains = [], published = [], engagements = [] } = {}) {
  const length = Math.max(authors.length, texts.length, domains.length, published.length, engagements.length);
  const rows = [];
  for (let index = 0; index < length; index += 1) {
    rows.push({
      channel: "x",
      backend: "mock-intelligence",
      queryId: `q${index % 3}`,
      authorId: authors[index] ?? null,
      textExcerpt: texts[index] ?? null,
      canonicalUrl: domains[index] ?? null,
      publishedAt: published[index] ?? null,
      engagement: engagements[index] ?? null,
    });
  }
  return rows;
}

function v2(records, extra = {}) {
  return extractIntelligenceFeaturesV2({ records, capturedAt: null, asOf: null, queryPlanCount: null, failureCount: 0, ...extra });
}

async function buildFixtures() {
  ctx.tmp = await mkdtemp(path.join(tmpdir(), "evolve-phase5e2-"));
  ctx.captureRoot = path.join(ctx.tmp, "captures");
  await mkdir(ctx.captureRoot, { recursive: true });

  // A NEW capture: schema 2, and it MUST explicitly pin the V2 transform.
  ctx.v2Capture = await runCapture({
    root: ctx.captureRoot,
    config: resolveIntelligenceConfig({ EVOLVE_INTELLIGENCE_PROVIDER: "mock" }),
    candidates: [{ symbol: "FIXTURE", name: "Fixture Token", mint: "FixtureMint1111111111111111111111111111111" }],
    provider: "mock",
    now: NOW,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });

  // The committed schema-1 compatibility fixture (no featureVersion pin).
  ctx.fixtureExpected = JSON.parse(await readFile(FIXTURE_EXPECTED, "utf8"));
  ctx.realCaptureAvailable = await exists(path.join(REAL_CAPTURE_ROOT, "2026-09-19", REAL_CAPTURE_ID));
  ctx.evidenceAvailable = (await exists(path.join(REPO, ".evolve", "replication"))) && (await exists(path.join(REPO, ".evolve", "history")));

  if (ctx.evidenceAvailable) {
    ctx.evidenceBaseline = {
      waves: await metadataSnapshot(path.join(REPO, ".evolve", "replication", "waves")),
      cohorts: await metadataSnapshot(path.join(REPO, ".evolve", "replication", "cohorts")),
      replication: await metadataSnapshot(path.join(REPO, ".evolve", "replication")),
      history: await metadataSnapshot(path.join(REPO, ".evolve", "history")),
      intelligence: await metadataSnapshot(REAL_CAPTURE_ROOT),
    };
  }
  ctx.intelligenceSources = await loadIntelligenceSources();
}

async function disposeFixtures() {
  if (ctx.tmp) await rm(ctx.tmp, { recursive: true, force: true });
}

/* ============================================================================
 * Static scanning helpers
 * ==========================================================================*/

async function walkMjs(dir, out = []) {
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walkMjs(full, out);
    else if (entry.name.endsWith(".mjs")) out.push(full);
  }
  return out;
}

async function loadIntelligenceSources() {
  const map = new Map();
  for (const file of await walkMjs(path.join(REPO, "scripts", "intelligence"))) {
    map.set(path.relative(REPO, file), await readFile(file, "utf8"));
  }
  map.set(path.join("scripts", "intelligence.mjs"), await readFile(path.join(REPO, "scripts", "intelligence.mjs"), "utf8"));
  return map;
}

function scan(sources, pattern) {
  const hits = [];
  for (const [file, text] of sources) {
    text.split("\n").forEach((line, index) => {
      if (pattern.test(line)) hits.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  return hits;
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
 * PART 1 — the versioned feature registry
 * ==========================================================================*/

test("1. the feature registry contains v1 and v2", async () => {
  assertDeepEqual(
    REGISTERED_FEATURE_VERSIONS,
    ["external-intelligence-features-v1", "external-intelligence-features-v2"],
    "exactly two feature transforms are registered, oldest first",
  );
  assertEqual(INTELLIGENCE_FEATURE_VERSION, "external-intelligence-features-v1", "V1 is the frozen original version string");
  assertEqual(LEGACY_INTELLIGENCE_FEATURE_VERSION, INTELLIGENCE_FEATURE_VERSION, "the legacy alias names V1");
  assertEqual(INTELLIGENCE_FEATURE_VERSION_V2, "external-intelligence-features-v2", "V2 is the observation-aware version string");
  assertEqual(DEFAULT_FEATURE_VERSION, INTELLIGENCE_FEATURE_VERSION_V2, "a NEW capture pins V2 explicitly");
  assertEqual(isRegisteredFeatureVersion(INTELLIGENCE_FEATURE_VERSION), true, "V1 is registered");
  assertEqual(isRegisteredFeatureVersion(INTELLIGENCE_FEATURE_VERSION_V2), true, "V2 is registered");
  const v1 = featureExtractorFor(INTELLIGENCE_FEATURE_VERSION);
  const v2Extractor = featureExtractorFor(INTELLIGENCE_FEATURE_VERSION_V2);
  assertEqual(v1.version, INTELLIGENCE_FEATURE_VERSION, "V1 resolves to itself");
  assertEqual(v2Extractor.version, INTELLIGENCE_FEATURE_VERSION_V2, "V2 resolves to itself");
  assertEqual(typeof v1.extract, "function", "V1 has an extractor");
  assertEqual(typeof v2Extractor.extract, "function", "V2 has an extractor");
  assertEqual(v1.extract === v2Extractor.extract, false, "V1 and V2 are DIFFERENT implementations");
});

test("2. an unknown feature version fails closed (never mapped to latest)", async () => {
  for (const version of ["external-intelligence-features-v3", "external-intelligence-features-v0", "latest", "v2", "V2", "", "   "]) {
    assertThrows(() => featureExtractorFor(version), UnknownFeatureVersionError, `'${version}' is refused`);
  }
  assertThrows(() => featureExtractorFor(null), UnknownFeatureVersionError, "null is refused");
  assertThrows(() => featureExtractorFor(undefined), UnknownFeatureVersionError, "undefined is refused");
  assertEqual(isRegisteredFeatureVersion("external-intelligence-features-v3"), false, "an unregistered version is not registered");
  assertEqual(isRegisteredFeatureVersion(null), false, "null is not registered");
  const error = assertThrows(() => featureExtractorFor("external-intelligence-features-v3"), UnknownFeatureVersionError, "unknown version throws");
  assertEqual(error.featureVersion, "external-intelligence-features-v3", "the error names the version");
  assertTrue(/FAIL-CLOSED/.test(error.message), "the error states fail-closed behaviour");
  assertTrue(/external-intelligence-features-v1/.test(error.message), "the error lists the registered versions");
});

test("3. a legacy manifest without featureVersion resolves to V1 (compatibility rule)", async () => {
  assertEqual(
    resolveCaptureFeatureVersion({ schemaVersion: 1, captureSchemaVersion: 1 }),
    INTELLIGENCE_FEATURE_VERSION,
    "schema 1 with no pin is V1",
  );
  assertEqual(resolveCaptureFeatureVersion({ schemaVersion: 1 }), INTELLIGENCE_FEATURE_VERSION, "a schema-1 manifest without captureSchemaVersion is V1");
  assertEqual(resolveCaptureFeatureVersion({}), INTELLIGENCE_FEATURE_VERSION, "a manifest with no schema information at all is treated as legacy V1");
  assertEqual(
    resolveCaptureFeatureVersion({ captureSchemaVersion: LEGACY_CAPTURE_SCHEMA_VERSION }),
    INTELLIGENCE_FEATURE_VERSION,
    "the legacy schema constant resolves to V1",
  );
  assertEqual(
    resolveCaptureFeatureVersion({ captureSchemaVersion: CAPTURE_SCHEMA_VERSION, featureVersion: INTELLIGENCE_FEATURE_VERSION_V2 }),
    INTELLIGENCE_FEATURE_VERSION_V2,
    "a schema-2 manifest pinned to V2 resolves to V2",
  );
  assertEqual(
    resolveCaptureFeatureVersion({ captureSchemaVersion: CAPTURE_SCHEMA_VERSION, featureVersion: INTELLIGENCE_FEATURE_VERSION }),
    INTELLIGENCE_FEATURE_VERSION,
    "a manifest explicitly pinned to V1 resolves to V1",
  );
  assertThrows(
    () => resolveCaptureFeatureVersion({ captureSchemaVersion: CAPTURE_SCHEMA_VERSION, featureVersion: "external-intelligence-features-v9" }),
    UnknownFeatureVersionError,
    "an unknown pin fails closed",
  );
  const malformed = assertThrows(
    () => resolveCaptureFeatureVersion({ captureSchemaVersion: CAPTURE_SCHEMA_VERSION }),
    UnknownFeatureVersionError,
    "a schema-2 manifest that pins nothing fails closed",
  );
  assertTrue(/requires an explicit registered/.test(malformed.message), "the malformed-manifest refusal explains what is missing");
  assertThrows(() => resolveCaptureFeatureVersion({ captureSchemaVersion: CAPTURE_SCHEMA_VERSION, featureVersion: "   " }), UnknownFeatureVersionError, "a whitespace pin fails closed");
  assertTrue(CAPTURE_SCHEMA_VERSION > LEGACY_CAPTURE_SCHEMA_VERSION, "the current capture schema is newer than the legacy one");
});

test("4. a new capture explicitly pins V2 and records capture schema 2", async () => {
  const manifest = ctx.v2Capture.manifest;
  assertEqual(manifest.schemaVersion, CAPTURE_SCHEMA_VERSION, "the manifest is written at the current schema");
  assertEqual(manifest.schemaVersion, 2, "the current schema is 2");
  assertEqual(manifest.captureSchemaVersion, 2, "the explicit capture schema field is 2");
  assertEqual(manifest.featureVersion, DEFAULT_FEATURE_VERSION, "the manifest pins the default (V2) transform");
  assertEqual(manifest.featureVersion, INTELLIGENCE_FEATURE_VERSION_V2, "the pin is V2, not V1 and not 'latest'");
  assertEqual(resolveCaptureFeatureVersion(manifest), INTELLIGENCE_FEATURE_VERSION_V2, "replay resolves the new capture to V2");
  const reread = await readCaptureManifest(ctx.captureRoot, ctx.v2Capture.captureId);
  assertEqual(reread.featureVersion, INTELLIGENCE_FEATURE_VERSION_V2, "the pin survives a round-trip through disk");
  const integrity = await verifyCapture(ctx.captureRoot, ctx.v2Capture.captureId);
  assertEqual(integrity.ok, true, "the new capture verifies against its own manifest");
});

test("5. the V1 algorithm is byte/number compatible with the frozen fixture", async () => {
  const records = await loadCaptureRecords(FIXTURE_ROOT, FIXTURE_CAPTURE_ID);
  assertEqual(records.length, 5, "the fixture has five records");
  const features = extractIntelligenceFeatures({
    records,
    capturedAt: new Date(Date.parse("2026-01-01T00:00:00.000Z")).toISOString(),
    asOf: null,
    queryPlanCount: 5,
    failureCount: 0,
  });
  assertDeepEqual(features, ctx.fixtureExpected.features, "the V1 output is byte-identical to the frozen expectation");
  assertEqual(featuresDigest(features), ctx.fixtureExpected.featuresDigest, "the V1 feature digest is identical");
  assertEqual(features.repeatedAuthorRatio, 0.6, "V1 divides by mentionCount: 1 - 2/5");
  assertEqual(features.duplicateTextRatio, 0.8, "V1 divides by mentionCount: 4/5");
  assertEqual(features.sourceDiversity, 0.4, "V1 divides by mentionCount: 2/5");
  assertDeepEqual(
    features.coordinationIndicators.indicators.map((row) => row.id),
    ["repeatedText", "singleLinkDomain"],
    "the V1 indicators are unchanged (V1 has NO minimum-sample rule — that is why V2 exists)",
  );
  // The exact documented sample from Phase 5E must still produce its exact numbers.
  const sample = [
    { channel: "x", backend: "mock", queryId: "q1", authorId: "a1", textExcerpt: "t1", canonicalUrl: "https://d1.test/1", publishedAt: "2026-09-19T09:58:00.000Z", engagement: 10 },
    { channel: "x", backend: "mock", queryId: "q1", authorId: "a2", textExcerpt: "t1", canonicalUrl: "https://d1.test/2", publishedAt: "2026-09-19T09:59:00.000Z", engagement: 20 },
    { channel: "reddit", backend: "mock", queryId: "q2", authorId: "a1", textExcerpt: "t2", canonicalUrl: "https://d2.test/1", publishedAt: "2026-09-19T10:00:00.000Z", engagement: null },
    { channel: "web", backend: "web", queryId: "q3", authorId: null, textExcerpt: "t3", canonicalUrl: null, publishedAt: null, engagement: 5 },
  ];
  const legacy = extractIntelligenceFeatures({ records: sample, capturedAt: new Date(NOW).toISOString(), asOf: LATER, queryPlanCount: 4, failureCount: 1 });
  assertEqual(legacy.uniqueAuthors, 2, "V1 uniqueAuthors is unchanged");
  assertEqual(legacy.repeatedAuthorRatio, 0.5, "V1 repeatedAuthorRatio is unchanged");
  assertEqual(legacy.accountConcentration, 0.666667, "V1 accountConcentration is unchanged");
  assertEqual(legacy.duplicateTextRatio, 0.5, "V1 duplicateTextRatio is unchanged");
  assertEqual(legacy.sourceDiversity, 0.5, "V1 sourceDiversity is unchanged");
  assertEqual(legacy.postsPerMinute, 2, "V1 postsPerMinute is unchanged");
  assertEqual(legacy.fetchFailureRate, 0.25, "V1 fetchFailureRate is unchanged");
  assertEqual(legacy.featureVersion, "external-intelligence-features-v1", "V1 keeps its version string");
  assertEqual(extractIntelligenceFeatures === featureExtractorFor(INTELLIGENCE_FEATURE_VERSION).extract, true, "the exported V1 function IS the registered V1 extractor");
});

test("6-8. the real first capture stays V1 with its pinned replay and packet digests", async () => {
  if (!ctx.realCaptureAvailable) {
    skip(`the real capture ${REAL_CAPTURE_ID} is not present in this workspace — pinned-digest cases were skipped`);
    return;
  }
  const manifest = await readCaptureManifest(REAL_CAPTURE_ROOT, REAL_CAPTURE_ID);
  assertEqual(manifest.captureSchemaVersion, 1, "the real capture's manifest is still schema 1");
  assertEqual(manifest.featureVersion, undefined, "the real capture's manifest was NOT mutated to add a version pin");
  assertEqual(resolveCaptureFeatureVersion(manifest), INTELLIGENCE_FEATURE_VERSION, "it resolves to the frozen V1 transform");

  const integrity = await verifyCapture(REAL_CAPTURE_ROOT, REAL_CAPTURE_ID);
  assertEqual(integrity.ok, true, `the real capture still verifies (${integrity.reason ?? "ok"})`);
  assertEqual(integrity.manifestDigest, REAL_CAPTURE_PINS.manifestDigest, "the manifest digest is unchanged");
  assertEqual(integrity.recordsDigest, REAL_CAPTURE_PINS.recordsDigest, "the records digest is unchanged");

  const replay = await replayCapture({ root: REAL_CAPTURE_ROOT, captureId: REAL_CAPTURE_ID, asOf: null });
  assertEqual(replay.featureVersion, INTELLIGENCE_FEATURE_VERSION, "the replay reports V1");
  assertEqual(replay.captureSchemaVersion, 1, "the replay reports capture schema 1");
  assertEqual(replay.replayDigest, REAL_CAPTURE_PINS.replayDigest, "the replay digest is EXACTLY the pinned value");
  assertEqual(replay.features.featureVersion, INTELLIGENCE_FEATURE_VERSION, "the feature vector is the V1 vector");
  assertEqual(replay.features.coordinationIndicators.count, 2, "the V1 interpretation is unchanged (this is WHY V2 exists)");

  const packet = buildExternalIntelligencePacket({ replay });
  assertEqual(packet.packetDigest, REAL_CAPTURE_PINS.packetDigest, "the packet digest is EXACTLY the pinned value");
  assertEqual(packet.featureVersion, INTELLIGENCE_FEATURE_VERSION, "the packet carries the V1 provenance");
});

/* ============================================================================
 * PART 2 — V2 observation and denominator semantics
 * ==========================================================================*/

test("9-11. an authorless single record has no author observations and no concentration", async () => {
  const features = v2([githubShapedRecord()]);
  assertEqual(features.mentionCount, 1, "one record was observed");
  assertEqual(features.authorObservedCount, 0, "no author was observed");
  assertEqual(features.uniqueAuthors, 0, "no distinct author was observed");
  assertEqual(features.repeatedAuthorRatio, null, "repeatedAuthorRatio is UNKNOWN, not 1");
  assertEqual(features.accountConcentration, null, "accountConcentration is UNKNOWN, not 1");
  assertEqual(features.authorCoverage, 0, "author coverage is an honest zero");
});

test("12. a single authored record has repeatedAuthorRatio 0 (no repetition observed)", async () => {
  const features = v2([githubShapedRecord({ authorId: "solo" })]);
  assertEqual(features.authorObservedCount, 1, "one author observation");
  assertEqual(features.uniqueAuthors, 1, "one distinct author");
  assertEqual(features.repeatedAuthorRatio, 0, "a single observed author is not a repeat");
  assertEqual(features.accountConcentration, 1, "the only observed author holds 100% of the OBSERVED authors");
  assertEqual(features.authorCoverage, 1, "coverage is complete for this record");
});

test("13. missing authors are excluded from the author denominator", async () => {
  // 4 records, 3 of them author-bearing, authors [a, a, b].
  const features = v2(semanticRecords({ authors: ["a", "a", "b", null] }));
  assertEqual(features.mentionCount, 4, "the record count is 4");
  assertEqual(features.authorObservedCount, 3, "only 3 records carried an author");
  assertEqual(features.uniqueAuthors, 2, "two distinct authors");
  assertEqual(features.repeatedAuthorRatio, 0.333333, "1 - uniqueAuthors/authorObservedCount, rounded to 6 places");
  assertEqual(features.repeatedAuthorRatio, v2(semanticRecords({ authors: ["a", "a", "b", null] })).repeatedAuthorRatio, "the ratio is deterministic");
  assertEqual(features.authorCoverage, 0.75, "75% of records carried an author");
  assertTrue(features.repeatedAuthorRatio < 0.7, "this sample does not reach the fewAuthors threshold");
});

test("14. missing text is excluded from the text denominator", async () => {
  const features = v2(semanticRecords({ texts: ["t", "t", "u", null] }));
  assertEqual(features.mentionCount, 4, "the record count is 4");
  assertEqual(features.textObservedCount, 3, "only 3 records carried bounded text");
  assertEqual(features.uniqueTexts, 2, "two distinct texts");
  assertEqual(features.duplicateTextRatio, 0.666667, "2 of the 3 OBSERVED texts repeat");
  assertEqual(features.textCoverage, 0.75, "75% of records carried text");
});

test("15. missing links are excluded from the diversity denominator", async () => {
  const features = v2(semanticRecords({ domains: ["https://d1.test/a", "https://d1.test/b", "https://d2.test/a", null] }));
  assertEqual(features.mentionCount, 4, "the record count is 4");
  assertEqual(features.linkObservedCount, 3, "only 3 records carried a link");
  assertEqual(features.uniqueLinkDomains, 2, "two distinct domains");
  assertEqual(features.sourceDiversity, 0.666667, "distinctDomains / linkObservedCount, NOT / record count");
  assertEqual(features.linkDomainConcentration, 0.666667, "concentration is computed over the OBSERVED domains only");
  assertEqual(features.linkCoverage, 0.75, "75% of records carried a link");
});

test("16. no authors means author coverage 0 (an honest zero, not a ratio)", async () => {
  const features = v2([githubShapedRecord(), githubShapedRecord()]);
  assertEqual(features.authorObservedCount, 0, "no author observations");
  assertEqual(features.authorCoverage, 0, "coverage is 0");
  assertEqual(features.accountConcentration, null, "with nothing observed there is no concentration to report");
  const empty = v2([]);
  assertEqual(empty.authorCoverage, null, "with no records at all coverage is null, not 0");
  assertEqual(empty.mentionCount, 0, "the empty capture has no records");
});

test("17. no bounded text means duplicateTextRatio is null", async () => {
  const features = v2([githubShapedRecord({ textExcerpt: null })]);
  assertEqual(features.textObservedCount, 0, "no text was observed");
  assertEqual(features.duplicateTextRatio, null, "the duplicate ratio is UNKNOWN, not 0 and not 1");
  assertEqual(features.textCoverage, 0, "text coverage is an honest zero");
});

test("18. no links means sourceDiversity is null", async () => {
  const features = v2([githubShapedRecord({ canonicalUrl: null })]);
  assertEqual(features.linkObservedCount, 0, "no link was observed");
  assertEqual(features.sourceDiversity, null, "diversity is UNKNOWN, not 0");
  assertEqual(features.linkCoverage, 0, "link coverage is an honest zero");
});

test("19. no links means linkDomainConcentration is null", async () => {
  const features = v2([githubShapedRecord({ canonicalUrl: null })]);
  assertEqual(features.linkDomainConcentration, null, "concentration is UNKNOWN when nothing was observed");
  assertEqual(v2([]).linkDomainConcentration, null, "an empty capture has no concentration");
});

test("20. the engagement observation count is correct", async () => {
  const features = v2(semanticRecords({ engagements: [10, 20, null, 5, null] }));
  assertEqual(features.mentionCount, 5, "five records");
  assertEqual(features.engagementObservedCount, 3, "three engagements were observed");
  assertEqual(features.engagementCoverage, 0.6, "60% coverage");
  assertEqual(features.engagementTotal, 35, "the total ignores missing engagement");
  assertEqual(features.engagementMedian, 10, "the median ignores missing engagement");
  const none = v2(semanticRecords({ engagements: [null, null] }));
  assertEqual(none.engagementObservedCount, 0, "no engagement was observed");
  assertEqual(none.engagementTotal, null, "no total exists without observations");
  assertEqual(none.engagementCoverage, 0, "coverage is an honest zero");
});

test("21. the publication observation count is correct", async () => {
  const features = v2(
    semanticRecords({
      published: ["2026-09-19T09:00:00.000Z", "2026-09-19T09:00:30.000Z", null, "2026-09-19T09:02:00.000Z", null],
    }),
  );
  assertEqual(features.publishedAtObservedCount, 3, "three publication timestamps exist");
  assertEqual(features.publishedAtCoverage, 0.6, "60% coverage");
  assertEqual(features.postsPerMinute, 1.5, "3 observed publications over a 2-minute span");
  const single = v2(semanticRecords({ published: ["2026-09-19T09:00:00.000Z", null] }));
  assertEqual(single.publishedAtObservedCount, 1, "one timestamp");
  assertEqual(single.postsPerMinute, null, "one timestamp cannot define a span");
  assertEqual(v2(semanticRecords({ published: [null, null] })).postsPerMinute, null, "no timestamps means no rate");
});

test("22. fewAuthors cannot fire below the minimum observed-author sample", async () => {
  // Every record repeats ONE author, but only 4 records are author-bearing.
  const features = v2(semanticRecords({ authors: ["a", "a", "a", "a"] }));
  assertEqual(features.authorObservedCount, 4, "four author observations");
  assertEqual(features.repeatedAuthorRatio, 0.75, "the ratio is genuinely above the threshold");
  assertTrue(features.repeatedAuthorRatio >= COORDINATION_THRESHOLDS.fewAuthors, "the ratio threshold is met");
  assertTrue(features.authorObservedCount < COORDINATION_MIN_OBSERVATIONS, "but the sample is below the minimum");
  assertEqual(features.coordinationIndicators.count, 0, "no indicator fires");
  assertEqual(features.coordinationIndicators.indicators.some((row) => row.id === "fewAuthors"), false, "fewAuthors did not fire");
});

test("23. repeatedText cannot fire below the minimum observed-text sample", async () => {
  const features = v2(semanticRecords({ texts: ["t", "t", "t", "t"] }));
  assertEqual(features.textObservedCount, 4, "four text observations");
  assertEqual(features.duplicateTextRatio, 1, "every observed text repeats");
  assertEqual(features.coordinationIndicators.count, 0, "no indicator fires below the minimum sample");
  assertEqual(features.coordinationIndicators.indicators.some((row) => row.id === "repeatedText"), false, "repeatedText did not fire");
});

test("24. singleLinkDomain cannot fire below the minimum observed-link sample", async () => {
  const features = v2(semanticRecords({ domains: ["https://d1.test/a", "https://d1.test/b", "https://d1.test/c", "https://d1.test/d"] }));
  assertEqual(features.linkObservedCount, 4, "four link observations");
  assertEqual(features.linkDomainConcentration, 1, "one domain holds every observed link");
  assertEqual(features.coordinationIndicators.count, 0, "no indicator fires below the minimum sample");
  assertEqual(features.coordinationIndicators.indicators.some((row) => row.id === "singleLinkDomain"), false, "singleLinkDomain did not fire");
});

test("25. burstRate cannot fire below the minimum observed-timestamp sample", async () => {
  const published = Array.from({ length: 4 }, (_unused, index) => new Date(Date.parse("2026-09-19T09:00:00.000Z") + index * 1000).toISOString());
  const features = v2(semanticRecords({ published }));
  assertEqual(features.publishedAtObservedCount, 4, "four timestamps");
  assertTrue(Number.isFinite(features.postsPerMinute), "a rate is computable");
  assertEqual(features.coordinationIndicators.count, 0, "no indicator fires below the minimum sample");
  assertEqual(features.coordinationIndicators.indicators.some((row) => row.id === "burstRate"), false, "burstRate did not fire");
});

test("26. every indicator CAN still fire when the sample minimum and threshold are legitimately met", async () => {
  // 5 author-bearing records, all the same author => ratio 0.8.
  const authors = v2(semanticRecords({ authors: ["a", "a", "a", "a", "a"] }));
  assertEqual(authors.authorObservedCount, COORDINATION_MIN_OBSERVATIONS, "the sample meets the minimum exactly");
  assertEqual(authors.repeatedAuthorRatio, 0.8, "the ratio is 0.8");
  assertDeepEqual(authors.coordinationIndicators.indicators.map((row) => row.id), ["fewAuthors"], "fewAuthors fires");

  // 5 observed texts, 3 of them repeats => ratio 0.6.
  const texts = v2(semanticRecords({ texts: ["t", "u", "t", "v", "t"] }));
  assertEqual(texts.textObservedCount, 5, "five observed texts");
  assertEqual(texts.duplicateTextRatio, 0.6, "three of five observed texts repeat");
  assertDeepEqual(texts.coordinationIndicators.indicators.map((row) => row.id), ["repeatedText"], "repeatedText fires");

  // 5 observed links, 4 on one domain => concentration 0.8.
  const domains = v2(
    semanticRecords({
      domains: ["https://d1.test/a", "https://d1.test/b", "https://d1.test/c", "https://d1.test/d", "https://d2.test/a"],
    }),
  );
  assertEqual(domains.linkObservedCount, 5, "five observed links");
  assertEqual(domains.linkDomainConcentration, 0.8, "one domain holds four of five");
  assertDeepEqual(domains.coordinationIndicators.indicators.map((row) => row.id), ["singleLinkDomain"], "singleLinkDomain fires");

  // 30 publications inside one minute => 30 posts/minute.
  const published = Array.from({ length: 30 }, (_unused, index) => new Date(Date.parse("2026-09-19T09:00:00.000Z") + index * 1000).toISOString());
  const burst = v2(semanticRecords({ published }));
  assertEqual(burst.publishedAtObservedCount, 30, "thirty timestamps");
  assertEqual(burst.postsPerMinute, 30, "thirty publications per minute");
  assertTrue(burst.postsPerMinute >= COORDINATION_THRESHOLDS.burstRate, "the burst threshold is met");
  assertDeepEqual(burst.coordinationIndicators.indicators.map((row) => row.id), ["burstRate"], "burstRate fires");
  for (const row of [
    ...authors.coordinationIndicators.indicators,
    ...texts.coordinationIndicators.indicators,
    ...domains.coordinationIndicators.indicators,
    ...burst.coordinationIndicators.indicators,
  ]) {
    assertEqual(row.kind, "coordination", "an indicator is a coordination observation");
    assertTrue(Number.isFinite(row.observed[Object.keys(row.observed)[0]]), "the observed payload is numeric and bounded");
  }
  assertEqual(authors.coordinationIndicators.claim, "deterministic observations over the frozen capture — NOT a bot probability", "no bot-probability claim is ever made");
  assertEqual(authors.coordinationIndicators.minRelevantObservations, COORDINATION_MIN_OBSERVATIONS, "the minimum is reported on the indicator block");
  assertEqual(COORDINATION_MIN_OBSERVATIONS, 5, "the documented minimum is 5");
  assertDeepEqual(
    COORDINATION_THRESHOLDS,
    { repeatedText: 0.5, fewAuthors: 0.7, singleLinkDomain: 0.6, burstRate: 30 },
    "the documented thresholds are unchanged (and were NOT tuned against the first live capture)",
  );
});

test("27. the one-record GitHub-shaped capture produces ZERO V2 coordination indicators", async () => {
  const features = v2([githubShapedRecord()], { queryPlanCount: 1, failureCount: 0 });
  assertEqual(features.mentionCount, 1, "one record");
  assertEqual(features.authorObservedCount, 0, "no author observation");
  assertEqual(features.repeatedAuthorRatio, null, "no repeated-author ratio");
  assertEqual(features.accountConcentration, null, "no account concentration");
  assertEqual(features.textObservedCount, 1, "one text observation");
  assertEqual(features.linkObservedCount, 1, "one link observation");
  assertEqual(features.coordinationIndicators.count, 0, "no coordination indicator can fire on a single record");
  assertDeepEqual(features.coordinationIndicators.indicators, [], "the indicator list is empty");
  for (const id of ["fewAuthors", "singleLinkDomain", "repeatedText", "burstRate"]) {
    assertEqual(features.coordinationIndicators.indicators.some((row) => row.id === id), false, `${id} did not fire`);
  }
  // The very same bytes under V1 DID produce indicators — the difference is the transform.
  const legacy = extractIntelligenceFeatures({ records: [githubShapedRecord()], capturedAt: null, asOf: null, queryPlanCount: 1, failureCount: 0 });
  assertEqual(legacy.coordinationIndicators.count, 2, "V1 (frozen) still reports its two indicators");
  assertDeepEqual(legacy.coordinationIndicators.indicators.map((row) => row.id), ["fewAuthors", "singleLinkDomain"], "V1's output is unchanged and V2's is different");
});

/* ============================================================================
 * PART 3 — determinism, digests and the packet
 * ==========================================================================*/

test("28. the V2 feature digest is deterministic and clock-independent", async () => {
  const records = [githubShapedRecord({ authorId: "a" }), githubShapedRecord({ authorId: "a" }), githubShapedRecord()];
  const first = v2(records, { capturedAt: new Date(NOW).toISOString(), asOf: LATER, queryPlanCount: 2, failureCount: 0 });
  const second = v2(records, { capturedAt: new Date(NOW).toISOString(), asOf: LATER, queryPlanCount: 2, failureCount: 0 });
  assertDeepEqual(first, second, "two V2 extractions are byte-identical");
  assertEqual(featuresDigest(first), featuresDigest(second), "the V2 feature digest is stable");
  assertEqual(first.featureVersion, INTELLIGENCE_FEATURE_VERSION_V2, "the vector is tagged V2");
  assertEqual(featuresDigest(first).length, 64, "the digest is a SHA-256 hex string");
  assertTrue(featuresDigest(first) !== featuresDigest(extractIntelligenceFeatures({ records, capturedAt: new Date(NOW).toISOString(), asOf: LATER, queryPlanCount: 2, failureCount: 0 })), "a V2 vector digests differently from the V1 vector over the same records");
});

test("29. V2 replay is deterministic and reports its provenance", async () => {
  const first = await replayCapture({ root: ctx.captureRoot, captureId: ctx.v2Capture.captureId, asOf: LATER });
  const second = await replayCapture({ root: ctx.captureRoot, captureId: ctx.v2Capture.captureId, asOf: LATER });
  assertEqual(first.replayDigest, second.replayDigest, "two replays of a V2 capture produce the same digest");
  assertEqual(canonicalJson(first.features), canonicalJson(second.features), "the reconstructed features are byte-identical");
  const determinism = await verifyReplayDeterminism({ root: ctx.captureRoot, captureId: ctx.v2Capture.captureId });
  assertEqual(determinism.ok, true, "the determinism helper agrees");
  assertEqual(first.featureVersion, INTELLIGENCE_FEATURE_VERSION_V2, "the replay reports V2");
  assertEqual(first.captureSchemaVersion, 2, "the replay reports capture schema 2");
  assertEqual(first.replayVersion, INTELLIGENCE_REPLAY_VERSION, "the replay version is reported");
  assertEqual(INTELLIGENCE_REPLAY_VERSION, "external-intelligence-replay-v2", "replay moved to v2 because it now has version-selection semantics");
  assertEqual(first.features.featureVersion, INTELLIGENCE_FEATURE_VERSION_V2, "the vector is a V2 vector");
  const stats = captureStats(first);
  assertEqual(stats.featureVersion, INTELLIGENCE_FEATURE_VERSION_V2, "the compact stats carry the feature version");
  assertEqual(stats.captureSchemaVersion, 2, "the compact stats carry the capture schema version");
  assertEqual(stats.replayDigest, first.replayDigest, "the compact stats carry the replay digest");
});

test("30. V1 replay is deterministic and matches the frozen fixture expectation", async () => {
  const first = await replayCapture({ root: FIXTURE_ROOT, captureId: FIXTURE_CAPTURE_ID, asOf: null });
  const second = await replayCapture({ root: FIXTURE_ROOT, captureId: FIXTURE_CAPTURE_ID, asOf: null });
  assertEqual(first.featureVersion, INTELLIGENCE_FEATURE_VERSION, "the fixture resolves to V1");
  assertEqual(first.replayDigest, second.replayDigest, "two replays produce the same digest");
  assertEqual(first.replayDigest, ctx.fixtureExpected.replayDigest, "the V1 replay digest is EXACTLY the frozen expectation");
  assertEqual(featuresDigest(first.features), ctx.fixtureExpected.featuresDigest, "the V1 feature digest is the frozen one");
  assertDeepEqual(first.features, ctx.fixtureExpected.features, "the whole V1 vector is frozen");
  assertEqual(first.captureSchemaVersion, 1, "the fixture is a schema-1 capture");
  const determinism = await verifyReplayDeterminism({ root: FIXTURE_ROOT, captureId: FIXTURE_CAPTURE_ID });
  assertEqual(determinism.ok, true, "the fixture replay is verifiably deterministic");
  assertEqual(featuresDigest(featureExtractorFor(INTELLIGENCE_FEATURE_VERSION).extract({ records: first.records, capturedAt: first.capturedAt, asOf: null, queryPlanCount: 5, failureCount: 0 })), ctx.fixtureExpected.featuresDigest, "the registered V1 extractor reproduces the frozen digest");
});

test("31. clock-derived fields are still excluded from the feature digest (V1 and V2)", async () => {
  assertDeepEqual(FEATURE_CLOCK_FIELDS, ["captureAgeMs"], "exactly the clock field is excluded");
  const records = [githubShapedRecord({ authorId: "a" })];
  const options = { capturedAt: new Date(NOW).toISOString(), queryPlanCount: 1, failureCount: 0 };
  const legacyEarly = extractIntelligenceFeatures({ ...options, records, asOf: NOW });
  const legacyLate = extractIntelligenceFeatures({ ...options, records, asOf: LATER });
  assertDeepEqual(featuresDigestSubject(legacyEarly), featuresDigestSubject(legacyLate), "the V1 digested subject is clock-independent");
  assertEqual(featuresDigest(legacyEarly), featuresDigest(legacyLate), "the V1 feature digest is clock-independent");
  assertTrue(legacyLate.captureAgeMs > legacyEarly.captureAgeMs, "captureAgeMs is still reported as a presentation field");

  const nextEarly = v2(records, { ...options, asOf: NOW });
  const nextLate = v2(records, { ...options, asOf: LATER });
  assertDeepEqual(featuresDigestSubject(nextEarly), featuresDigestSubject(nextLate), "the V2 digested subject is clock-independent");
  assertEqual(featuresDigest(nextEarly), featuresDigest(nextLate), "the V2 feature digest is clock-independent");
  assertEqual(featuresDigestSubject(nextEarly).captureAgeMs, undefined, "captureAgeMs never enters the digested subject");
  assertEqual(nextEarly.captureAgeMs, 0, "the V2 vector still reports the presentation field");
});

test("32-34. the packet still audits, and carries no raw text and no URL", async () => {
  const replay = await replayCapture({ root: ctx.captureRoot, captureId: ctx.v2Capture.captureId, asOf: LATER });
  const packet = buildExternalIntelligencePacket({ replay });
  const audit = auditExternalIntelligencePacket(packet);
  assertEqual(audit.ok, true, `the V2 packet passes its own audit (${JSON.stringify(audit.nestedForbiddenKeys)})`);
  assertEqual(audit.digestOk, true, "the packet digest is self-consistent");
  assertEqual(audit.routingActive, false, "no routing is active");
  assertEqual(assertPacketAllowed(packet) === packet, true, "the throwing guard accepts it");
  assertEqual(packet.featureVersion, INTELLIGENCE_FEATURE_VERSION_V2, "the packet carries the V2 feature version");
  for (const key of Object.keys(packet)) assertTrue(ALLOWED_PACKET_KEYS.includes(key), `'${key}' is on the packet whitelist`);
  const text = canonicalJson(packet);
  for (const forbidden of ["textExcerpt", "canonicalUrl", "https://", "http://", "github.com", "cookie", "apiKey", "privateKey", "Seed body"]) {
    assertTrue(!text.includes(forbidden), `the packet never contains '${forbidden}'`);
  }
  assertEqual(/\b(https?|ftp):\/\//.test(text), false, "no URL of any scheme appears in the packet");
  assertEqual(packet.features.captureAgeMs, undefined, "clock-derived features never enter the packet");
});

test("35. routing remains inactive (Jev false, DeepSeek false)", async () => {
  assertEqual(JEV_ROUTING_ACTIVE, false, "Jev routing is a hard-coded false");
  assertEqual(DEEPSEEK_ROUTING_ACTIVE, false, "DeepSeek routing is a hard-coded false");
  const replay = await replayCapture({ root: ctx.captureRoot, captureId: ctx.v2Capture.captureId, asOf: LATER });
  const packet = buildExternalIntelligencePacket({ replay });
  assertEqual(packet.routing.jevRoutingActive, false, "the packet says Jev routing is inactive");
  assertEqual(packet.routing.deepseekRoutingActive, false, "the packet says DeepSeek routing is inactive");
  assertEqual(packet.routing.disposition, null, "no disposition was decided");
  assertEqual(replay.routing, undefined, "a replay routes nothing");
  assertDeepEqual(resolveIntelligenceConfig({}).mode && [resolveIntelligenceConfig({}).mode], ["shadow"], "only the shadow mode exists");
});

/* ============================================================================
 * PART 4 — behavioural and isolation barriers
 * ==========================================================================*/

test("36-37. provider behaviour and the upstream executable mapping are unchanged", async () => {
  assertEqual(REACH_UPSTREAM_EXECUTABLES.length, 5, "five upstream tools exist");
  assertDeepEqual(REACH_UPSTREAM_EXECUTABLES, ["gh", "twitter", "rdt", "mcporter", "curl"], "the upstream executable set is exact");
  assertDeepEqual(
    EXPECTED_EXECUTABLE_MAP,
    Object.fromEntries(REACH_CAPABILITY_MAP_V1.entries.map((entry) => [`${entry.op}:${entry.channel ?? "-"}`, entry.binary])),
    "every frozen capability entry still resolves its declared executable",
  );
  assertEqual(REACH_EXECUTABLE_ALLOWLIST.includes("agent-reach"), true, "the pinned CLI is still allowlisted");
  for (const entry of REACH_CAPABILITY_MAP_V1.entries) {
    assertEqual(REACH_EXECUTABLE_ALLOWLIST.includes(entry.binary), true, `${entry.op}/${entry.channel ?? "-"} stays on the allowlist`);
    assertEqual(path.isAbsolute(entry.binary), false, "a capability never names an absolute path");
  }
  assertEqual(REACH_CAPABILITY_MAP_V1.entries.length, 12, "the capability map is unchanged in size");
  assertEqual(ctx.v2Capture.manifest.provider, "mock", "the fixture capture used the offline mock provider");
  assertEqual(ctx.v2Capture.manifest.providerDeterministic, true, "the mock provider is still declared deterministic");
  assertEqual(resolveIntelligenceConfig({}).provider, "disabled", "the default provider is still disabled (fail-closed)");
  // Replay writes nothing: the capture root still holds exactly the one capture
  // this suite created, and no health/ side directory was produced.
  const captures = await listCaptures(ctx.captureRoot);
  assertEqual(captures.length, 1, "exactly one capture exists in the fixture root");
  assertDeepEqual((await readdir(ctx.captureRoot)).sort(), ["2026-09-19"], "no extra artifact was written beside the capture day bucket");
  assertEqual(captures[0].captureId, ctx.v2Capture.captureId, "the capture is the one this suite took");
});

const EXPECTED_EXECUTABLE_MAP = Object.freeze({
  "version:-": "agent-reach",
  "health:-": "agent-reach",
  "search:x": "twitter",
  "read:x": "twitter",
  "search:exa": "mcporter",
  "search:web": "mcporter",
  "read:web": "curl",
  "search:reddit": "rdt",
  "read:reddit": "rdt",
  "read:rss": "curl",
  "search:github": "gh",
  "read:github": "gh",
});

test("38. a replay performs no network call and no provider call", async () => {
  const replay = await replayCapture({ root: ctx.captureRoot, captureId: ctx.v2Capture.captureId, asOf: LATER });
  assertEqual(replay.networkCalls, 0, "the replay reports zero network calls");
  assertEqual(replay.live, false, "the replay is not live");
  assertEqual(replay.mode, "replay", "the mode is explicitly replay");
  const offline = ["replay.mjs", "features.mjs", "records.mjs", "packet.mjs", "capture.mjs", "config.mjs"];
  for (const name of offline) {
    const text = ctx.intelligenceSources.get(path.join("scripts", "intelligence", name));
    assertEqual(typeof text, "string", `${name} was scanned`);
    assertTrue(!/from\s+"node:(http|https|net|dns|tls)"/.test(text), `${name} imports no network module`);
    assertTrue(!/\bfetch\s*\(/.test(text), `${name} calls no fetch()`);
    assertTrue(!/undici|node-fetch|axios|got\b/.test(text), `${name} uses no HTTP client`);
  }
  const fixtureReplay = await replayCapture({ root: FIXTURE_ROOT, captureId: FIXTURE_CAPTURE_ID, asOf: null });
  assertEqual(fixtureReplay.networkCalls, 0, "a legacy fixture replay also makes no network call");
  const replayText = ctx.intelligenceSources.get(path.join("scripts", "intelligence", "replay.mjs")) ?? "";
  const featuresText = ctx.intelligenceSources.get(path.join("scripts", "intelligence", "features.mjs")) ?? "";
  assertEqual(replayText.length > 0 && featuresText.length > 0, true, "both offline modules were loaded for the static check");
  assertEqual(/child_process|execFile|spawn|agent-reach|provider\.mjs/.test(replayText), false, "the replay path can spawn no process and reaches no provider");
  assertEqual(/child_process|spawn|fetch\s*\(/.test(featuresText), false, "the feature path can spawn no process and calls no fetch");
});

test("39-41. no Jev call, no DeepSeek call and no Arena run is possible from the intelligence layer", async () => {
  assertDeepEqual(
    scan(ctx.intelligenceSources, /resolveJevProvider|createTypeSafeJevProvider|probe-jev|EVOLVE_JEV|jev\.mjs/),
    [],
    "no Jev provider is reachable",
  );
  // The one legitimate mention of these names is the env DENYLIST itself, which is
  // the guard that keeps such variables out of a child process (same exemption the
  // Phase 5E suite documents).
  assertDeepEqual(
    scan(ctx.intelligenceSources, /deepseek\.com|api\.deepseek|EVOLVE_DEEPSEEK|typesafe|cline|openai|anthropic/i).filter(
      (hit) => !/WALLET\|MNEMONIC/.test(hit),
    ),
    [],
    "no LLM endpoint or key is referenced",
  );
  assertDeepEqual(
    scan(ctx.intelligenceSources, /from\s+"[^"]*(\/arena\/|orchestrator|simulation|watchdog|compiler|\/jev\/)/),
    [],
    "no Arena/engine/compiler/Jev import exists",
  );
  assertDeepEqual(
    scan(ctx.intelligenceSources, /from\s+"[^"]*(\/replication\/|\/research\/)/),
    [],
    "no replication/research import exists",
  );
  assertEqual(JEV_ROUTING_ACTIVE, false, "Jev routing is inactive");
  assertEqual(DEEPSEEK_ROUTING_ACTIVE, false, "DeepSeek routing is inactive");
  // In this suite, capturing used ONLY the offline mock provider: no subprocess,
  // no network and no provider call happened.
  assertEqual(ctx.v2Capture.manifest.syntheticIntelligence, true, "the only capture taken here is clearly synthetic");
  assertEqual(ctx.v2Capture.calls, ctx.v2Capture.manifest.queries.count, "the mock provider counted exactly one call per query");
  assertTrue(ctx.v2Capture.manifest.provider !== "agent-reach", "no Agent-Reach capture was taken");
});

/* ============================================================================
 * PART 5 — the identity barriers (Wave 1, Wave 2, cohorts, datasets, contract)
 * ==========================================================================*/

test("42-45. Wave 1, Wave 2, the six replication datasets and the frozen cohorts are byte-identical", async () => {
  if (!ctx.evidenceAvailable) {
    skip("the .evolve replication/history evidence is not present in this workspace — identity cases were skipped");
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
  assertEqual(Object.keys(WAVE_1_DATASET_FINGERPRINTS).length + Object.keys(WAVE_2_DATASET_FINGERPRINTS).length, 6, "the pinned fingerprint table holds six datasets");

  const mock = await readFrozenCohort(path.join(REPO, ".evolve", "replication"), "mock");
  const deepseek = await readFrozenCohort(path.join(REPO, ".evolve", "replication"), "deepseek");
  assertTrue(mock !== null && deepseek !== null, "both frozen cohorts are readable");
  assertEqual(mock.cohortDigest, FROZEN_COHORT_DIGESTS.mock, "the Mock cohort digest is unchanged");
  assertEqual(deepseek.cohortDigest, FROZEN_COHORT_DIGESTS.deepseek, "the DeepSeek cohort digest is unchanged");
  assertEqual(mock.immutable, true, "the Mock cohort is still marked immutable");
  assertEqual(deepseek.immutable, true, "the DeepSeek cohort is still marked immutable");
  assertEqual(mock.frozen, true, "the Mock cohort is still marked frozen");
  assertEqual(deepseek.frozen, true, "the DeepSeek cohort is still marked frozen");

  // Nothing this suite did touched a single frozen artifact.
  assertDeepEqual(await metadataSnapshot(path.join(REPO, ".evolve", "replication", "waves")), ctx.evidenceBaseline.waves, "the wave manifests did not change while the suite ran");
  assertDeepEqual(await metadataSnapshot(path.join(REPO, ".evolve", "replication", "cohorts")), ctx.evidenceBaseline.cohorts, "the frozen cohorts did not change while the suite ran");
  assertDeepEqual(await metadataSnapshot(path.join(REPO, ".evolve", "history")), ctx.evidenceBaseline.history, "the recorded datasets did not change while the suite ran");
  if (ctx.realCaptureAvailable) {
    assertDeepEqual(await metadataSnapshot(REAL_CAPTURE_ROOT), ctx.evidenceBaseline.intelligence, "the real capture's bytes did not change while the suite ran");
  }
  assertEqual(CANONICAL_WAVE_1_REPLICATION_ID, "rep-66884de4e460", "the canonical Wave 1 replication id is unchanged");
  assertEqual(CANONICAL_HISTORICAL_FREEZE_PATH, "phase5c-freeze.json", "the canonical historical freeze path is unchanged");
});

test("46. the evaluation contract digest is EXACTLY the pinned value", async () => {
  assertEqual(
    CANONICAL_EVALUATION_CONTRACT_DIGEST,
    "4cf8ac1fa7db290acadeccf6043ec34c3239f8e3f848e9e50d8560826de85052",
    "the published Wave 1 contract pin is unchanged",
  );
  assertEqual(CANONICAL_EVALUATION_CONTRACT_DIGEST.length, 64, "the contract digest is a SHA-256 hex string");
  if (!ctx.evidenceAvailable) {
    skip("the stored Wave 1 freeze is not present in this workspace — the derived-contract case was skipped");
    return;
  }
  const stored = await readFreeze({ root: path.join(REPO, ".evolve", "replication") });
  const first = evaluationContractDigest(stored);
  const second = evaluationContractDigest(stored);
  assertEqual(first, second, "the derived contract digest is deterministic");
  assertEqual(first, CANONICAL_EVALUATION_CONTRACT_DIGEST, "the STORED freeze still derives the canonical contract digest");
});

/* ============================================================================
 * PART 6 — the frozen compatibility fixture itself
 * ==========================================================================*/

test("the frozen schema-1 fixture is pinned, committed, and version-less", async () => {
  const manifest = JSON.parse(await readFile(path.join(FIXTURE_ROOT, "2026-01-01", FIXTURE_CAPTURE_ID, "manifest.json"), "utf8"));
  assertEqual(manifest.schemaVersion, 1, "the fixture manifest is schema 1");
  assertEqual(manifest.captureSchemaVersion, 1, "the fixture capture schema is 1");
  assertEqual("featureVersion" in manifest, false, "the fixture manifest pins NO featureVersion (legacy interpretation must happen in code)");
  assertEqual(manifest.captureId, FIXTURE_CAPTURE_ID, "the fixture capture id is stable");
  assertEqual(ctx.fixtureExpected.featureVersion, "external-intelligence-features-v1", "the frozen expectation is V1");
  assertEqual(ctx.fixtureExpected.manifestDigest, manifest.manifestDigest, "the fixture manifest digest is self-consistent");
  assertEqual(ctx.fixtureExpected.recordsDigest, manifest.digests.recordsDigest, "the fixture records digest is self-consistent");
  assertEqual(ctx.fixtureExpected.replayDigest.length, 64, "the fixture's frozen replay digest is a SHA-256 hex string");
  const integrity = await verifyCapture(FIXTURE_ROOT, FIXTURE_CAPTURE_ID);
  assertEqual(integrity.ok, true, `the fixture verifies against its own manifest (${integrity.reason ?? "ok"})`);
  // And the fixture's V1 vector is observably DIFFERENT under V2 over the same bytes.
  const records = await loadCaptureRecords(FIXTURE_ROOT, FIXTURE_CAPTURE_ID);
  assertEqual(records.length, 5, "the fixture has five records");
  const nextGen = extractIntelligenceFeaturesV2({ records, capturedAt: new Date(Date.parse("2026-01-01T00:00:00.000Z")).toISOString(), asOf: null, queryPlanCount: 5, failureCount: 0 });
  assertEqual(nextGen.authorObservedCount, 3, "V2 reports three author observations (2 records had none)");
  assertEqual(nextGen.repeatedAuthorRatio, 0.333333, "V2 divides by the OBSERVED author count");
  assertEqual(nextGen.textObservedCount, 4, "V2 reports four text observations (1 record had none)");
  assertEqual(nextGen.linkObservedCount, 4, "V2 reports four link observations (1 record had none)");
  assertEqual(nextGen.sourceDiversity, 0.5, "V2 divides distinct domains by OBSERVED links");
  assertEqual(nextGen.coordinationIndicators.count, 0, "V2 fires no indicator on this small sample");
  assertEqual(extractIntelligenceFeatures({ records, capturedAt: null, asOf: null, queryPlanCount: 5, failureCount: 0 }).repeatedAuthorRatio, 0.6, "V1's (different) interpretation is preserved");
});

test("the observation-count helper is consistent with both transforms", async () => {
  const records = semanticRecords({ authors: ["a", "a", "b"], texts: ["t", "t"], domains: ["https://d1.test/a"], published: [], engagements: [1, 2, 3] });
  const counts = observationCounts(records);
  assertEqual(counts.authorObservedCount, 3, "three author observations");
  assertEqual(counts.textObservedCount, 2, "two text observations");
  assertEqual(counts.linkObservedCount, 1, "one link observation");
  assertEqual(counts.publishedAtObservedCount, 0, "no publication timestamps");
  assertEqual(counts.engagementObservedCount, 3, "three engagement observations");
  const features = v2(records);
  assertEqual(features.authorObservedCount, counts.authorObservedCount, "the helper agrees with V2");
  assertEqual(features.uniqueAuthors, counts.authors.size, "the distinct-value count agrees with V2");
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
    console.error("could not build Phase 5E.2 fixtures:", error?.stack ?? error);
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
  console.log("offline: no live capture, no provider call, no network call, no Jev call, no DeepSeek call, no Arena run.");
  if (skips.length > 0) {
    console.log(`skipped ${skips.length} optional case(s) whose evidence is absent here:`);
    for (const reason of skips) console.log(`  - ${reason}`);
  }
  console.log(`EVOLVE Phase 5E.2 feature-version validation: ${passed}/${cases.length} checks passed`);

  if (failures.length > 0) {
    console.log("Failed checks:");
    for (const failure of failures) console.log(`  - ${failure.name}`);
    process.exitCode = 1;
  } else {
    console.log("All Phase 5E.2 checks passed. Capture bytes and feature interpretation are SEPARATELY versioned:");
    console.log("legacy schema-1 manifests resolve to the frozen V1 transform, new captures pin V2 explicitly,");
    console.log("missing data is UNKNOWN rather than concentration, and coordination indicators require a minimum relevant sample.");
    console.log("Nothing was routed to Jev, DeepSeek or the Arena.");
  }
}

run().catch((error) => {
  console.error("phase 5E.2 validation runner crashed:", error);
  process.exitCode = 1;
});
