#!/usr/bin/env node
/**
 * EVOLVE Phase 5G.1a validation suite — OFFLINE.
 *
 * Operation-aware intelligence health + collision-proof capture IDs + correct
 * empty-capture provenance. This suite proves three fixes:
 *
 *   A. CAPABILITY PREFLIGHT
 *      health is exposed at the exact (channel, operation) capability level, not
 *      collapsed into one misleading channel status: `web` search needs
 *      `mcporter` while `web` read needs `curl`. A rendered deterministic query
 *      plan is resolved offline against the frozen capability map, and a plan
 *      that needs a locally-missing executable fails closed BEFORE any upstream
 *      call or capture artifact — with no install and no fallback backend.
 *
 *   B. COLLISION-PROOF CAPTURE IDS
 *      new capture ids carry UTC millisecond precision (`...T HHMMSSmmm Z`), so
 *      two independent captures in the same second no longer collide, while
 *      legacy second-resolution ids still parse and day derivation is unchanged.
 *
 *   C. CORRECT EMPTY-CAPTURE PROVENANCE
 *      synthetic provenance comes from the PROVIDER, never from
 *      `records.every(...)`: a zero-record real capture stays real and a
 *      zero-record mock capture stays synthetic. Mixed impossible provenance is
 *      refused rather than silently relabelled, and a legacy artifact's stored
 *      provenance is reported alongside the corrected behavior (never rewritten).
 *
 * Fully OFFLINE and deterministic: no network call, no real upstream tool is ever
 * executed (fixture stubs write a marker file if they were), no Agent-Reach / Jev
 * / DeepSeek call is made, no Arena is run, and nothing under the repository's
 * `.evolve/` is written — the identity barriers only READ frozen evidence.
 *
 * Run with: npm run validate:phase5g1a
 */

import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { canonicalJson, hashFileBuffered } from "./lib/hash.mjs";

import {
  REACH_CAPABILITY_MAP_V1,
  REACH_CAPABILITY_MAP_VERSION,
  REACH_EXECUTABLE_ALLOWLIST,
  REACH_HEALTH_EXECUTABLE,
  REACH_UPSTREAM_EXECUTABLES,
  ReachPlanUnavailableError,
  capabilityFor,
  evaluateReachPlanReadiness,
  inspectReachCapabilities,
  probeReachHealth,
  resolveCapabilityExecutable,
  runReachCall,
} from "./intelligence/agent-reach.mjs";
import {
  CaptureExistsError,
  IntelligenceProvenanceError,
  buildCaptureId,
  captureDayOf,
  captureDirFor,
  isValidCaptureId,
  listCaptures,
  readCaptureManifest,
  resolveCaptureSyntheticProvenance,
  runCapture,
  verifyCapture,
} from "./intelligence/capture.mjs";
import { resolveIntelligenceConfig, AGENT_REACH_PIN } from "./intelligence/config.mjs";
import { REACH_QUERY_SET_ID, buildQueryPlan } from "./intelligence/query-sets.mjs";
import { replayCapture } from "./intelligence/replay.mjs";
import { CLASSIFIER_EXPERIMENT_FILE } from "./intelligence/classifier-experiment.mjs";
import {
  CANONICAL_INFRASTRUCTURE_EXPERIMENT_ID,
  CANONICAL_INFRASTRUCTURE_RESULT_DIGEST,
} from "./intelligence/classifier-evaluation.mjs";
import { CLASSIFIER_ID, CLASSIFIER_VERSION } from "./intelligence/classifier-definition.mjs";
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
const NOW = Date.parse("2026-09-19T15:13:03.257Z");
const REAL_CAPTURE_ROOT = path.join(REPO, ".evolve", "intelligence");
const REAL_CLASSIFIER_ROOT = path.join(REPO, ".evolve", "classifier");
const REAL_CAPTURE_DAY = "2026-09-19";

/** The canonical failed Web capture the first Phase 5G.1 run produced. */
const CANONICAL_FAILED_WEB_CAPTURE_ID = "capture-20260919T151303Z";
const CANONICAL_FAILED_WEB_MANIFEST_DIGEST = "a731818f61b1894820fcfd67cce43b34a543d9e0d3e02deb96fd0ed29f582c82";
const CANONICAL_INFRASTRUCTURE_EXPERIMENT_DIGEST = "58a2067270e0f4b343980f1c1ec2adf9896dfec407527abd6bdc7e55e36a619f";
const FROZEN_COHORT_DIGESTS = Object.freeze({
  mock: "b26d63a2a0787e954ed7e4e63e668fe4664e58059508145345214facc4e12858",
  deepseek: "13c7c93d707b26f8b92042d488ff0a63f5de3f9f81b8145be4eac7a70cc550a8",
});
/** The Phase 5G.1 evaluator sources — MUST stay byte-identical. */
const EVALUATOR_SOURCE_DIGESTS = Object.freeze({
  "scripts/intelligence/classifier-evaluation.mjs": "536223fc8be731204271fc63165816cefd13333495a4beb0f31e8d361c548f1c",
  "scripts/intelligence-classify-eval.mjs": "03cf62c21a11dda75e4693981a659509cfe4f4a4093e5cb92bd4a1b26b900aff",
});
const MODIFIED_SOURCE_FILES = Object.freeze([
  "scripts/intelligence/agent-reach.mjs",
  "scripts/intelligence/capture.mjs",
  "scripts/intelligence/replay.mjs",
  "scripts/intelligence/dashboard.mjs",
  "scripts/intelligence.mjs",
  "scripts/intelligence/classifier-experiment.mjs",
  "scripts/validate-phase5g1a.mjs",
]);
/** The runtime layer only — this validator's own text is never scanned as "runtime". */
const RUNTIME_SOURCE_FILES = Object.freeze(MODIFIED_SOURCE_FILES.filter((file) => !file.startsWith("scripts/validate-")));
const EXPECTED_TRIPLES = Object.freeze([
  "version:-:agent-reach",
  "health:-:agent-reach",
  "search:x:twitter",
  "read:x:twitter",
  "search:exa:mcporter",
  "search:web:mcporter",
  "read:web:curl",
  "search:reddit:rdt",
  "read:reddit:rdt",
  "read:rss:curl",
  "search:github:gh",
  "read:github:gh",
]);
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
async function listDirSafe(dir) {
  try {
    return (await readdir(dir, { recursive: true })).map(String).sort();
  } catch {
    return [];
  }
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

/* ============================================================================
 * Fixtures
 * ==========================================================================*/

const ctx = {
  tmp: null,
  marker: null,
  binAll: null,
  binCurlOnly: null,
  binGhOnly: null,
  binEmpty: null,
  roots: {},
  sources: new Map(),
  baseline: {},
  canonicalExperimentAvailable: false,
  evidenceAvailable: false,
};

const CANDIDATE = Object.freeze({
  symbol: "PHASE5G1A",
  name: "Phase 5G.1a Fixture",
  mint: "G51AMint111111111111111111111111111111111",
  domain: "fixture.example",
  handle: "@phase5g1a",
});

const RAW_SEED = Object.freeze({ id: "seed-1", url: "https://example.test/seed-1", text: "Seed body text", author: "seed-author" });

function agentConfig(overrides = {}) {
  return resolveIntelligenceConfig({
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    EVOLVE_INTELLIGENCE_PROVIDER: "agent-reach",
    ...overrides,
  });
}
function mockConfig(overrides = {}) {
  return resolveIntelligenceConfig({
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    EVOLVE_INTELLIGENCE_PROVIDER: "mock",
    ...overrides,
  });
}
function stubSpawn(handler) {
  const calls = [];
  const spawn = (binary, argv, options) => {
    calls.push({ binary, argv, options });
    return handler({ binary, argv, options, index: calls.length });
  };
  spawn.calls = calls;
  return spawn;
}
async function makeStubDir(dir, tools) {
  await mkdir(dir, { recursive: true });
  for (const tool of tools) {
    const target = path.join(dir, tool);
    // If a fixture stub were ever EXECUTED it would touch the marker file; a pure
    // inspection/readiness check must therefore leave the marker absent.
    await writeFile(target, `#!/bin/sh\ntouch "${ctx.marker}"\nexit 0\n`, "utf8");
    await chmod(target, 0o755);
  }
}
function planFor(channels, candidates = [CANDIDATE]) {
  return buildQueryPlan({ candidates, querySetId: REACH_QUERY_SET_ID, channels });
}
function root(name) {
  return path.join(ctx.tmp, name);
}
function runNode(args, { env = {} } = {}) {
  return spawnSync(process.execPath, args, {
    cwd: REPO,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, ...env },
  });
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

async function buildFixtures() {
  ctx.tmp = await mkdtemp(path.join(tmpdir(), "evolve-phase5g1a-"));
  ctx.marker = path.join(ctx.tmp, "executed.marker");
  ctx.binAll = path.join(ctx.tmp, "bin-all");
  ctx.binCurlOnly = path.join(ctx.tmp, "bin-curl");
  ctx.binGhOnly = path.join(ctx.tmp, "bin-gh");
  ctx.binEmpty = path.join(ctx.tmp, "bin-empty");
  await makeStubDir(ctx.binAll, ["gh", "twitter", "rdt", "mcporter", "curl"]);
  await makeStubDir(ctx.binCurlOnly, ["curl"]);
  await makeStubDir(ctx.binGhOnly, ["gh"]);
  await mkdir(ctx.binEmpty, { recursive: true });

  for (const name of [
    "plan",
    "health",
    "ids",
    "prov",
    "mixed",
    "misc",
  ]) {
    ctx.roots[name] = root(name);
    await mkdir(ctx.roots[name], { recursive: true });
  }

  for (const file of [...MODIFIED_SOURCE_FILES, ...Object.keys(EVALUATOR_SOURCE_DIGESTS)]) {
    ctx.sources.set(file, await readFile(file, "utf8").catch(() => ""));
  }

  const canonicalExperimentDir = path.join(REAL_CLASSIFIER_ROOT, "experiments", CANONICAL_INFRASTRUCTURE_EXPERIMENT_ID);
  ctx.canonicalExperimentAvailable = await exists(canonicalExperimentDir);
  ctx.evidenceAvailable = (await exists(path.join(REPO, ".evolve", "replication"))) && (await exists(path.join(REPO, ".evolve", "history")));
  ctx.baseline = {
    failedWebCapture: await metadataSnapshot(path.join(REAL_CAPTURE_ROOT, REAL_CAPTURE_DAY, CANONICAL_FAILED_WEB_CAPTURE_ID)),
    classifier: await metadataSnapshot(REAL_CLASSIFIER_ROOT),
    infraExperiment: await metadataSnapshot(canonicalExperimentDir),
    waves: await metadataSnapshot(path.join(REPO, ".evolve", "replication", "waves")),
    cohorts: await metadataSnapshot(path.join(REPO, ".evolve", "replication", "cohorts")),
    history: await metadataSnapshot(path.join(REPO, ".evolve", "history")),
  };
}

async function disposeFixtures() {
  if (ctx.tmp) await rm(ctx.tmp, { recursive: true, force: true });
}

/* ============================================================================
 * PART 1 — operation-aware capability inspection (1-10)
 * ==========================================================================*/

test("1. the frozen capability map is unchanged (version, size and every entry)", async () => {
  assertEqual(REACH_CAPABILITY_MAP_VERSION, "reach-capability-map-v1", "the capability map version is unchanged");
  assertEqual(REACH_CAPABILITY_MAP_V1.version, REACH_CAPABILITY_MAP_VERSION, "the published map declares its version");
  assertEqual(REACH_CAPABILITY_MAP_V1.entries.length, 12, "the map still has twelve entries");
  assertDeepEqual(
    REACH_CAPABILITY_MAP_V1.entries.map((entry) => `${entry.op}:${entry.channel ?? "-"}:${entry.binary}`),
    EXPECTED_TRIPLES,
    "every (operation, channel, executable) triple is unchanged",
  );
  // The distinction that makes this phase necessary is preserved, not flattened.
  assertEqual(capabilityFor("search", "web").binary, "mcporter", "web search stays on mcporter");
  assertEqual(capabilityFor("read", "web").binary, "curl", "web read stays on curl");
});

test("2. web search resolves to mcporter", async () => {
  assertEqual(capabilityFor("search", "web").binary, "mcporter", "the frozen entry names mcporter");
  const resolved = resolveCapabilityExecutable(capabilityFor("search", "web"), { path: ctx.binAll });
  assertEqual(resolved.basename, "mcporter", "resolution keeps mcporter");
  assertEqual(resolved.available, true, "mcporter is available in the fixture PATH");
  const inspection = inspectReachCapabilities({ path: ctx.binAll });
  assertEqual(inspection.byChannel.web.search.binary, "mcporter", "the inspection reports mcporter");
});

test("3. web read resolves to curl", async () => {
  assertEqual(capabilityFor("read", "web").binary, "curl", "the frozen entry names curl");
  const inspection = inspectReachCapabilities({ path: ctx.binAll });
  assertEqual(inspection.byChannel.web.read.binary, "curl", "the inspection reports curl");
  assertEqual(inspection.byChannel.web.read.available, true, "curl is available");
});

test("4. github search resolves to gh", async () => {
  assertEqual(capabilityFor("search", "github").binary, "gh", "the frozen entry names gh");
  const inspection = inspectReachCapabilities({ path: ctx.binGhOnly });
  assertEqual(inspection.byChannel.github.search.binary, "gh", "the inspection reports gh");
  assertEqual(inspection.byChannel.github.search.available, true, "gh is available");
});

test("5. rss read resolves to curl", async () => {
  assertEqual(capabilityFor("read", "rss").binary, "curl", "the frozen entry names curl");
  const inspection = inspectReachCapabilities({ path: ctx.binAll });
  assertEqual(inspection.byChannel.rss.read.binary, "curl", "the inspection reports curl");
  assertEqual(inspection.byChannel.rss.read.available, true, "curl is available");
});

test("6. capability inspection performs ZERO upstream calls", async () => {
  // The fixture stubs would touch a marker file if ANY were executed.
  assertEqual(await exists(ctx.marker), false, "no fixture stub has been executed");
  const inspection = inspectReachCapabilities({ path: ctx.binAll });
  const readiness = evaluateReachPlanReadiness(planFor(["x", "exa", "web", "reddit", "rss", "github"]), { path: ctx.binAll });
  assertEqual(inspection.subprocessesSpawned, 0, "the inspection reports zero subprocesses");
  assertEqual(inspection.networkCalls, 0, "the inspection reports zero network calls");
  assertEqual(readiness.networkCalls, 0, "the readiness check reports zero network calls");
  assertEqual(readiness.ready, true, "the fully-stocked fixture plan is ready");
  assertEqual(await exists(ctx.marker), false, "NOTHING was executed — the marker is still absent");
});

test("7. a missing mcporter makes web search unavailable", async () => {
  const inspection = inspectReachCapabilities({ path: ctx.binCurlOnly });
  assertEqual(inspection.byChannel.web.search.available, false, "web search is unavailable");
  assertEqual(inspection.byChannel.web.search.binary, "mcporter", "the required executable is still named");
  assertEqual(inspection.byChannel.web.search.executablePath, null, "no path was resolved");
  const report = inspectReachCapabilities({ path: ctx.binEmpty });
  assertEqual(report.byChannel.web.search.available, false, "an empty PATH also reports unavailable");
});

test("8. curl present means web read is available", async () => {
  const inspection = inspectReachCapabilities({ path: ctx.binCurlOnly });
  assertEqual(inspection.byChannel.web.read.available, true, "web read is available");
  assertEqual(inspection.byChannel.web.read.executablePath, path.join(ctx.binCurlOnly, "curl"), "the resolved path is the fixture curl");
  assertEqual(inspection.byChannel.rss.read.available, true, "rss read is available too (same executable)");
});

test("9. gh present means github search is available", async () => {
  const inspection = inspectReachCapabilities({ path: ctx.binGhOnly });
  assertEqual(inspection.byChannel.github.search.available, true, "github search is available");
  assertEqual(inspection.byChannel.github.read.available, true, "github read is available");
  assertEqual(inspection.byChannel.github.search.executablePath, path.join(ctx.binGhOnly, "gh"), "the resolved path is the fixture gh");
});

test("10. the doctor reports web read ready and web search unavailable SIMULTANEOUSLY", async () => {
  const out = root("health");
  const run = runNode(["scripts/intelligence.mjs", "doctor", "--json", "--out", out], {
    env: { PATH: ctx.binCurlOnly },
  });
  assertEqual(run.status, 0, `the doctor exits 0 (stderr: ${run.stderr})`);
  const payload = JSON.parse(run.stdout);
  const readiness = payload.capabilityReadiness;
  assertEqual(readiness.byChannel.web.read.available, true, "web read is ready (curl)");
  assertEqual(readiness.byChannel.web.search.available, false, "web search is unavailable (mcporter missing)");
  assertEqual(readiness.byChannel.web.search.binary, "mcporter", "the missing executable is named");
  assertEqual(readiness.byChannel.github.search.available, false, "github search is unavailable on this PATH");
  assertEqual(readiness.capabilityMapVersion, REACH_CAPABILITY_MAP_VERSION, "the readiness pins the capability map version");
  assertEqual(readiness.networkCalls, 0, "the doctor performed zero upstream calls");
  assertEqual(readiness.subprocessesSpawned, 0, "the doctor spawned nothing");
  assertEqual(await exists(ctx.marker), false, "no fixture stub was executed by the doctor");
  assertDeepEqual(await listDirSafe(out), [], "the doctor wrote nothing (no --save)");
});

/* ============================================================================
 * PART 2 — query-plan preflight (11-17)
 * ==========================================================================*/

test("11. a rendered Web search plan is marked unavailable", async () => {
  const plan = planFor(["web"]);
  assertTrue(plan.queries.length >= 1, "the web plan renders at least one query");
  assertTrue(plan.queries.every((query) => query.op === "search"), "every web template is a search");
  const readiness = evaluateReachPlanReadiness(plan, { path: ctx.binCurlOnly });
  assertEqual(readiness.ready, false, "the plan is NOT ready");
  assertEqual(readiness.unavailableQueries.length, plan.queries.length, "every query is unavailable");
  assertEqual(readiness.readyQueries.length, 0, "no query is ready");
  for (const row of readiness.unavailableQueries) {
    assertEqual(row.channel, "web", "the unavailable row names the channel");
    assertEqual(row.operation, "search", "the unavailable row names the operation");
    assertEqual(row.binary, "mcporter", "the unavailable row names the missing executable");
    assertEqual(row.available, false, "the row is flagged unavailable");
  }
});

test("12. a rendered GitHub search plan is ready when gh exists", async () => {
  const plan = planFor(["github"]);
  assertTrue(plan.queries.length >= 1, "the github plan renders at least one query");
  const readiness = evaluateReachPlanReadiness(plan, { path: ctx.binGhOnly });
  assertEqual(readiness.ready, true, "the plan is ready");
  assertEqual(readiness.unavailableQueries.length, 0, "nothing is unavailable");
  assertEqual(readiness.readyQueries.length, plan.queries.length, "every query is ready");
  assertDeepEqual([...new Set(readiness.readyQueries.map((row) => row.binary))], ["gh"], "every ready query uses gh");
});

test("13. an unavailable plan fails before ANY capture upstream call", async () => {
  const spawn = stubSpawn(() => ({ status: 0, stdout: "[]", stderr: "" }));
  const error = await runCapture({
    root: root("plan"),
    config: agentConfig({ EVOLVE_REACH_CHANNELS: "web" }),
    candidates: [CANDIDATE],
    provider: "agent-reach",
    now: NOW,
    env: { PATH: ctx.binCurlOnly },
    projectRoot: REPO,
    spawn,
  }).then(() => null).catch((thrown) => thrown);
  assertTrue(error instanceof ReachPlanUnavailableError, `the plan is refused with ReachPlanUnavailableError (got ${error?.name ?? error})`);
  assertEqual(spawn.calls.length, 0, "ZERO upstream calls were placed");
  assertTrue(error.unavailable.every((row) => row.available === false), "every diagnostic row is flagged available: false");
  assertTrue(error.unavailable.length === error.queryCount, "every rendered query is accounted for");
});

test("14. an unavailable plan writes NO capture artifact", async () => {
  const target = root("plan");
  assertDeepEqual(await listDirSafe(target), [], "the plan root is empty — no capture, no day bucket, no manifest");
  const error = await runCapture({
    root: target,
    config: agentConfig({ EVOLVE_REACH_CHANNELS: "web" }),
    candidates: [CANDIDATE],
    provider: "agent-reach",
    now: NOW,
    env: { PATH: ctx.binEmpty },
    projectRoot: REPO,
    spawn: stubSpawn(() => ({ status: 0, stdout: "[]", stderr: "" })),
  }).catch((thrown) => thrown);
  assertTrue(error instanceof ReachPlanUnavailableError, "the plan still fails closed");
  assertDeepEqual(await listCaptures(target), [], "no capture was recorded");
  assertDeepEqual(await listDirSafe(target), [], "still nothing was written");
});

test("15. no automatic install ever happens", async () => {
  for (const entry of REACH_CAPABILITY_MAP_V1.entries) {
    const label = `${entry.op}/${entry.channel ?? "-"}`;
    assertTrue(!/install|setup|upgrade|uninstall/i.test(entry.op), `${label} is not an installer operation`);
    assertTrue(!/install|setup|upgrade|pip|brew|apt/i.test(entry.binary), `${label} names no installer executable`);
    assertTrue(!entry.argv.some((token) => /install|setup|upgrade|pip|brew|apt/i.test(String(token))), `${label} carries no install token`);
  }
  const error = await runCapture({
    root: root("misc"),
    config: agentConfig({ EVOLVE_REACH_CHANNELS: "web" }),
    candidates: [CANDIDATE],
    provider: "agent-reach",
    now: NOW,
    env: { PATH: ctx.binEmpty },
    projectRoot: REPO,
  }).catch((thrown) => thrown);
  assertTrue(/never installs/.test(error.message), "the refusal states that nothing was installed");
  assertTrue(!/(pip|npm|brew|apt|choco|apt-get)\s+install|agent-reach\s+install/i.test(error.message), "no install command is proposed");
  assertEqual(await exists(ctx.marker), false, "nothing was executed while refusing");
});

test("16. no fallback backend is ever used", async () => {
  // The declared executable is reported even when it is missing — never a swap.
  const inspection = inspectReachCapabilities({ path: ctx.binCurlOnly });
  assertEqual(inspection.byChannel.web.search.binary, "mcporter", "web search still names mcporter, not curl");
  assertEqual(inspection.byChannel.web.search.available, false, "and it is honestly unavailable");
  const spawn = stubSpawn(() => ({ status: 0, stdout: "[]", stderr: "" }));
  const result = runReachCall({
    op: "search",
    channel: "web",
    values: { query: "evolve", limit: 2 },
    config: agentConfig(),
    env: { PATH: ctx.binCurlOnly },
    projectRoot: REPO,
    spawn,
  });
  assertEqual(result.unavailable, true, "the bounded call reports unavailable");
  assertEqual(result.spawned, false, "nothing was spawned");
  assertEqual(spawn.calls.length, 0, "no process ran");
  assertEqual(result.binary, "mcporter", "the declared binary is preserved (no fallback)");
  assertTrue(/never falls back/.test(result.error), "the failure states that no fallback happened");
});

test("17. no data operation is ever routed through the pinned Agent-Reach CLI", async () => {
  for (const entry of REACH_CAPABILITY_MAP_V1.entries) {
    if (entry.channel === null) continue;
    assertEqual(entry.binary === "agent-reach", false, `${entry.op}/${entry.channel} never names the router`);
  }
  const spawn = stubSpawn(() => ({ status: 0, stdout: "[]", stderr: "" }));
  const values = { query: "evolve", limit: 2, url: "https://example.test/x", timeoutSeconds: 20 };
  for (const entry of REACH_CAPABILITY_MAP_V1.entries) {
    if (entry.channel === null) continue;
    const result = runReachCall({ op: entry.op, channel: entry.channel, values, config: agentConfig(), env: { PATH: ctx.binAll }, projectRoot: REPO, spawn });
    assertEqual(path.basename(result.binary) === "agent-reach", false, `${entry.op}/${entry.channel} launches only its upstream tool`);
  }
  assertTrue(spawn.calls.every((call) => path.basename(call.binary) !== "agent-reach"), "no spawned process was the router");
});

test("18. the old health/version behavior is preserved", async () => {
  assertEqual(REACH_HEALTH_EXECUTABLE, "agent-reach", "exactly one health/router executable exists");
  assertDeepEqual(REACH_EXECUTABLE_ALLOWLIST, ["agent-reach", "gh", "twitter", "rdt", "mcporter", "curl"], "the allowlist is unchanged");
  assertDeepEqual(REACH_UPSTREAM_EXECUTABLES, ["gh", "twitter", "rdt", "mcporter", "curl"], "the upstream set is unchanged");
  assertEqual(capabilityFor("version").binary, "agent-reach", "version resolves the pinned CLI");
  assertEqual(capabilityFor("health").binary, "agent-reach", "health resolves the pinned CLI");
  assertEqual(capabilityFor("health").argv.join(" "), "doctor --json", "health still uses the non-installing JSON path");
  const spawn = stubSpawn(({ argv }) => (argv[0] === "version" ? { status: 0, stdout: "1.5.0", stderr: "" } : { status: 0, stdout: "{}", stderr: "" }));
  const probe = probeReachHealth({ config: agentConfig(), env: { PATH: ctx.binAll }, projectRoot: REPO, spawn });
  assertEqual(probe.upstreamCalls, 0, "the doctor places no upstream query");
  assertDeepEqual(spawn.calls.map((call) => call.argv.join(" ")), ["version", "doctor --json"], "only version and doctor --json run");
  assertDeepEqual(spawn.calls.map((call) => path.basename(call.binary)), ["agent-reach", "agent-reach"], "the pinned CLI is the only health executable");
});

/* ============================================================================
 * PART 3 — collision-proof capture ids (19-26)
 * ==========================================================================*/

test("19. a new capture id carries millisecond precision", async () => {
  const id = buildCaptureId(NOW);
  assertEqual(id, "capture-20260919T151303257Z", "the id encodes the injected millisecond");
  assertEqual(/^capture-\d{8}T\d{6}\d{3}Z$/.test(id), true, "the id has exactly six second digits followed by three millisecond digits");
  assertEqual(isValidCaptureId(id), true, "the new id is a valid capture id");
});

test("20. two milliseconds in the same second produce DISTINCT ids", async () => {
  assertEqual(buildCaptureId(NOW).slice(0, 23), buildCaptureId(NOW + 1).slice(0, 23), "the two ids share the same second");
  assertTrue(buildCaptureId(NOW) !== buildCaptureId(NOW + 1), "yet the ids differ");
  assertTrue(buildCaptureId(NOW + 999) !== buildCaptureId(NOW), "a millisecond later in the same second still differs");
});

test("21. capture ids remain lexicographically chronological", async () => {
  const a = buildCaptureId(NOW);
  const b = buildCaptureId(NOW + 1);
  const c = buildCaptureId(NOW + 999);
  const d = buildCaptureId(NOW + 1000);
  assertTrue(a < b && b < c && c < d, `ids sort in time order (${[a, b, c, d].join(" < ")})`);
  assertEqual([d, a, b, c].sort()[0], a, "a lexicographic sort recovers chronological order");
});

test("22. legacy second-resolution ids still parse", async () => {
  assertEqual(isValidCaptureId("capture-20260919T151303Z"), true, "the legacy shape is valid");
  assertEqual(captureDayOf("capture-20260919T151303Z"), REAL_CAPTURE_DAY, "its day bucket still derives");
  assertEqual(captureDirFor("/root", "capture-20260919T151303Z"), path.join("/root", REAL_CAPTURE_DAY, "capture-20260919T151303Z"), "its directory still derives");
});

test("23. new millisecond ids parse", async () => {
  const id = buildCaptureId(NOW);
  assertEqual(isValidCaptureId(id), true, "the millisecond shape is valid");
  assertEqual(captureDayOf(id), REAL_CAPTURE_DAY, "its day bucket derives");
  assertEqual(captureDirFor("/root", id), path.join("/root", REAL_CAPTURE_DAY, id), "its directory derives");
  assertEqual(isValidCaptureId("capture-20260919T15130325Z"), false, "a two-digit millisecond tail is refused");
  assertEqual(isValidCaptureId("capture-20260919T151303Z9"), false, "a trailing character is refused");
});

test("24. day derivation is unchanged", async () => {
  assertEqual(captureDayOf("capture-20260919T151303Z"), captureDayOf("capture-20260919T151303257Z"), "both resolutions derive the same day");
  assertEqual(captureDayOf("capture-20260101T000000Z"), "2026-01-01", "a different day still derives");
  // The real captures on disk still resolve to their bucket.
  assertEqual(captureDayOf(CANONICAL_FAILED_WEB_CAPTURE_ID), REAL_CAPTURE_DAY, "the canonical failed capture still derives its day");
});

test("25. an identical injected millisecond remains deterministic", async () => {
  assertEqual(buildCaptureId(NOW), buildCaptureId(NOW), "the same clock yields the same id");
  assertEqual(buildCaptureId(NOW), "capture-20260919T151303257Z", "and it is exactly the injected millisecond");
  // Determinism comes from clock precision alone — no randomness is used to hide a collision.
  assertTrue(!/Math\.random/.test(ctx.sources.get("scripts/intelligence/capture.mjs") ?? ""), "capture.mjs adds no randomness to an id");
});

test("26. an immutable collision STILL refuses to overwrite", async () => {
  const idsRoot = root("ids");
  const config = mockConfig();
  const first = await runCapture({ root: idsRoot, config, candidates: [CANDIDATE], provider: "mock", now: NOW, env: { PATH: process.env.PATH } });
  assertEqual(first.captureId, buildCaptureId(NOW), "the capture id matches the injected clock");
  const second = await runCapture({ root: idsRoot, config, candidates: [CANDIDATE], provider: "mock", now: NOW, env: { PATH: process.env.PATH } }).catch((error) => error);
  assertTrue(second instanceof CaptureExistsError, "the exact same millisecond is refused");
  assertTrue(/IMMUTABLE/.test(String(second?.message ?? "")), "the refusal explains immutability");
  assertEqual((await verifyCapture(idsRoot, first.captureId)).ok, true, "the original capture still verifies");
  // A capture one millisecond later does NOT collide.
  const third = await runCapture({ root: idsRoot, config, candidates: [CANDIDATE], provider: "mock", now: NOW + 1, env: { PATH: process.env.PATH } });
  assertTrue(third.captureId !== first.captureId, "a millisecond later is a distinct capture");
  assertEqual((await listCaptures(idsRoot)).length, 2, "two captures now exist");
});

/* ============================================================================
 * PART 4 — empty-capture provenance (27-30)
 * ==========================================================================*/

test("27. a real agent-reach zero-record capture is NOT synthetic", async () => {
  const capture = await runCapture({
    root: root("prov"),
    config: agentConfig({ EVOLVE_REACH_CHANNELS: "github" }),
    candidates: [CANDIDATE],
    provider: "agent-reach",
    now: NOW,
    env: { PATH: ctx.binAll },
    projectRoot: REPO,
    executor: async () => ({ ok: true, records: [], backendVersion: "fixture", syntheticIntelligence: false }),
  });
  assertEqual(capture.manifest.counts.records, 0, "the capture holds no records");
  assertEqual(capture.manifest.syntheticIntelligence, false, "an empty REAL capture stays real");
  const provenance = resolveCaptureSyntheticProvenance(capture.manifest);
  assertEqual(provenance.effective, false, "the effective provenance is real");
  assertEqual(provenance.source, "provider", "provenance comes from the provider");
});

test("28. a mock zero-record capture IS synthetic", async () => {
  const capture = await runCapture({
    root: root("prov"),
    config: mockConfig({ EVOLVE_REACH_CHANNELS: "github" }),
    candidates: [CANDIDATE],
    provider: "mock",
    now: NOW + 1_000,
    env: { PATH: process.env.PATH },
    executor: async () => ({ ok: true, records: [], backendVersion: "fixture", syntheticIntelligence: true }),
  });
  assertEqual(capture.manifest.counts.records, 0, "the capture holds no records");
  assertEqual(capture.manifest.syntheticIntelligence, true, "an empty MOCK capture stays synthetic");
  assertEqual(resolveCaptureSyntheticProvenance(capture.manifest).effective, true, "the effective provenance is synthetic");
});

test("29. a non-empty real capture is NOT synthetic", async () => {
  const capture = await runCapture({
    root: root("prov"),
    config: agentConfig({ EVOLVE_REACH_CHANNELS: "github" }),
    candidates: [CANDIDATE],
    provider: "agent-reach",
    now: NOW + 2_000,
    env: { PATH: ctx.binAll },
    projectRoot: REPO,
    executor: async () => ({ ok: true, records: [{ ...RAW_SEED }], backendVersion: "fixture", syntheticIntelligence: false }),
  });
  assertEqual(capture.manifest.counts.records, 1, "the capture holds a record");
  assertEqual(capture.manifest.syntheticIntelligence, false, "real evidence is never marked synthetic");
  assertEqual(capture.records[0].syntheticIntelligence, false, "the record agrees with its provider");
});

test("30. mixed / impossible provenance is refused, never silently relabelled", async () => {
  const mixedRoot = root("mixed");
  const error = await runCapture({
    root: mixedRoot,
    config: agentConfig({ EVOLVE_REACH_CHANNELS: "github" }),
    candidates: [CANDIDATE],
    provider: "agent-reach",
    now: NOW,
    env: { PATH: ctx.binAll },
    projectRoot: REPO,
    // The record's flags would claim synthetic while the provider is real.
    executor: async () => ({ ok: true, records: [{ ...RAW_SEED }], backendVersion: "fixture", syntheticIntelligence: true }),
  }).then(() => null).catch((thrown) => thrown);
  assertTrue(error instanceof IntelligenceProvenanceError, `the contradiction is refused (got ${error?.name ?? error})`);
  assertDeepEqual(await listDirSafe(mixedRoot), [], "no artifact was written for a contradictory provenance");

  // A legacy stored value that contradicts its provider is DETECTED (not rewritten).
  const legacyLike = { provider: "agent-reach", syntheticIntelligence: true };
  const resolved = resolveCaptureSyntheticProvenance(legacyLike);
  assertEqual(resolved.stored, true, "the stored value is preserved verbatim");
  assertEqual(resolved.corrected, false, "the corrected provider value is computed");
  assertEqual(resolved.effective, false, "the effective value prefers the provider");
  assertEqual(resolved.legacyMismatch, true, "the mismatch is flagged, not hidden");
});

/* ============================================================================
 * PART 5 — frozen artifacts + evaluator identity (31-34)
 * ==========================================================================*/

test("31. the canonical old Web failure capture is byte-untouched and self-consistent", async () => {
  const dir = path.join(REAL_CAPTURE_ROOT, REAL_CAPTURE_DAY, CANONICAL_FAILED_WEB_CAPTURE_ID);
  if (!(await exists(dir))) {
    skip(`the canonical failed Web capture ${CANONICAL_FAILED_WEB_CAPTURE_ID} is not present — its identity case was skipped`);
    return;
  }
  assertDeepEqual(await metadataSnapshot(dir), ctx.baseline.failedWebCapture, "no byte or mtime of the capture moved");
  const manifest = await readCaptureManifest(REAL_CAPTURE_ROOT, CANONICAL_FAILED_WEB_CAPTURE_ID);
  assertEqual(manifest.manifestDigest, CANONICAL_FAILED_WEB_MANIFEST_DIGEST, "the manifest digest is EXACTLY the pinned value");
  assertEqual(manifest.provider, "agent-reach", "it records its real provider");
  assertEqual(manifest.counts.records, 0, "it remains a zero-record capture");
  assertEqual(manifest.syntheticIntelligence, true, "its STORED (legacy) provenance is untouched");
  assertEqual((await verifyCapture(REAL_CAPTURE_ROOT, CANONICAL_FAILED_WEB_CAPTURE_ID)).ok, true, "its bytes still verify");

  const replay = await replayCapture({ root: REAL_CAPTURE_ROOT, captureId: CANONICAL_FAILED_WEB_CAPTURE_ID, asOf: null });
  assertEqual(replay.recordCount, 0, "the replay reports zero records");
  assertEqual(replay.provenance.storedSyntheticIntelligence, true, "the replay reports the stored legacy provenance");
  assertEqual(replay.provenance.correctedSyntheticIntelligence, false, "and the corrected provider provenance");
  assertEqual(replay.provenance.legacyProvenanceMismatch, true, "the two are distinguished, not conflated");
  assertEqual(replay.syntheticIntelligence, false, "the displayed provenance is corrected (no longer SYNTHETIC)");
});

test("32. the canonical Phase 5G.0 classifier experiment is untouched", async () => {
  const dir = path.join(REAL_CLASSIFIER_ROOT, "experiments", CANONICAL_INFRASTRUCTURE_EXPERIMENT_ID);
  if (!(await exists(dir))) {
    skip("the canonical classifier experiment is not present here — its identity case was skipped");
    return;
  }
  const experiment = JSON.parse(await readFile(path.join(dir, CLASSIFIER_EXPERIMENT_FILE), "utf8"));
  assertEqual(experiment.experimentId, CANONICAL_INFRASTRUCTURE_EXPERIMENT_ID, "the experiment id is unchanged");
  assertEqual(experiment.resultDigest, CANONICAL_INFRASTRUCTURE_RESULT_DIGEST, "the pinned result digest is unchanged");
  assertEqual(experiment.experimentDigest, CANONICAL_INFRASTRUCTURE_EXPERIMENT_DIGEST, "the pinned experiment digest is unchanged");
  assertEqual(experiment.classifierId, CLASSIFIER_ID, "it uses the frozen taxonomy");
  assertEqual(experiment.classifierVersion, CLASSIFIER_VERSION, "and the frozen version");
  assertDeepEqual(await metadataSnapshot(dir), ctx.baseline.infraExperiment, "the canonical experiment bytes are untouched");
});

test("33. the Phase 5G.1 evaluator sources are unchanged", async () => {
  for (const [file, expected] of Object.entries(EVALUATOR_SOURCE_DIGESTS)) {
    const digest = await hashFileBuffered(file);
    assertEqual(digest, expected, `${file} is byte-identical to the pinned evaluator`);
  }
});

test("34. the pinned Agent-Reach identity is unchanged", async () => {
  assertEqual(AGENT_REACH_PIN.repository, "https://github.com/Panniantong/Agent-Reach", "the repository is unchanged");
  assertEqual(AGENT_REACH_PIN.release, "v1.5.0", "the release is unchanged");
  assertEqual(AGENT_REACH_PIN.commit, "f65526cbaaad3879473acc1ba6dbefd195caf2be", "the commit is unchanged");
  assertEqual(AGENT_REACH_PIN.license, "MIT", "the license is unchanged");
  assertEqual(AGENT_REACH_PIN.localInstallDir, path.join(".tools", "agent-reach"), "the install target is still project-local");
  assertEqual(REACH_CAPABILITY_MAP_V1.pinned.commit, AGENT_REACH_PIN.commit, "the capability map pins the same commit");
});

/* ============================================================================
 * PART 6 — isolation barriers (35-39)
 * ==========================================================================*/

test("35. nothing in the changed layer calls the Jev decision model", async () => {
  for (const file of RUNTIME_SOURCE_FILES) {
    const source = ctx.sources.get(file) ?? "";
    assertTrue(!importSpecifiers(source).some((spec) => /jev/i.test(spec)), `${file} imports nothing from the Jev layer`);
    assertTrue(!/\bjevDecide\b|\bcreateVercelJevProvider\b|\bJEV_STATUS\b/.test(stripComments(source)), `${file} references no Jev API`);
  }
  const runtimeSources = [...ctx.sources].filter(([file]) => RUNTIME_SOURCE_FILES.includes(file));
  // Only imports of the Jev layer are forbidden — a prose disclaimer naming Jev is harmless.
  assertDeepEqual(scan(runtimeSources, /from\s+"[^"]*\/jev|from\s+"[^"]*jev[.-]/), [], "no runtime module imports the Jev layer");
});

test("36. the preflight / capture-id / provenance code never calls the classifier transport", async () => {
  const files = [
    "scripts/intelligence/agent-reach.mjs",
    "scripts/intelligence/capture.mjs",
    "scripts/intelligence/replay.mjs",
    "scripts/intelligence/dashboard.mjs",
    "scripts/intelligence.mjs",
  ];
  for (const file of files) {
    const source = ctx.sources.get(file) ?? "";
    assertTrue(!importSpecifiers(source).some((spec) => /classifier/i.test(spec)), `${file} imports no classifier module`);
    assertTrue(!/classifier\.dev|createClassifierDevProvider/i.test(stripComments(source)), `${file} references no classifier endpoint`);
  }
  // The Phase 5G.0 experiment runner legitimately uses the frozen classifier
  // transport: its only classifier import is the versioned provider, unchanged.
  assertTrue(
    importSpecifiers(ctx.sources.get("scripts/intelligence/classifier-experiment.mjs") ?? "").includes("./classifier-dev.mjs"),
    "the experiment runner still uses the frozen classifier provider",
  );
});

test("37. nothing in the changed layer calls DeepSeek", async () => {
  for (const file of RUNTIME_SOURCE_FILES) {
    const source = ctx.sources.get(file) ?? "";
    assertTrue(!importSpecifiers(source).some((spec) => /research|deepseek|cline/i.test(spec)), `${file} imports no research/DeepSeek module`);
    assertTrue(!/deepseek-cline/i.test(stripComments(source)), `${file} references no DeepSeek provider`);
    assertTrue(!/api\.deepseek|deepseek\.com/i.test(stripComments(source)), `${file} references no DeepSeek endpoint`);
  }
});

test("38. nothing in the changed layer runs the Arena or the engine", async () => {
  for (const file of RUNTIME_SOURCE_FILES) {
    const source = ctx.sources.get(file) ?? "";
    const code = stripComments(source);
    assertTrue(!importSpecifiers(source).some((spec) => /arena|champion|replication|\/engine|market|wallet|signer|solana|jupiter|rpc|trade/i.test(spec)), `${file} imports no Arena/market module`);
    assertTrue(!/\brunArena\b|\brunTournament\b|\bevolveGeneration\b/.test(code), `${file} runs no Arena code`);
  }
});

test("39. nothing in the changed layer can trade", async () => {
  for (const file of RUNTIME_SOURCE_FILES) {
    const code = stripComments(ctx.sources.get(file) ?? "");
    for (const pattern of FORBIDDEN_TRANSACTION_API) assertTrue(!pattern.test(code), `${file} references no transaction API (${pattern})`);
  }
});

/* ============================================================================
 * PART 7 — sealed replication identity (40-44)
 * ==========================================================================*/

test("40. Wave 1 is byte-identical", async () => {
  if (!ctx.evidenceAvailable) {
    skip("the .evolve replication/history evidence is not present — the Wave 1 case was skipped");
    return;
  }
  assertEqual(WAVE_1_DATASET_IDS.length, 3, "Wave 1 is three datasets");
  for (const id of WAVE_1_DATASET_IDS) assertEqual(await datasetFingerprint(id), WAVE_1_DATASET_FINGERPRINTS[id], `${id} still matches its pinned fingerprint`);
  assertEqual(CANONICAL_WAVE_1_REPLICATION_ID, "rep-66884de4e460", "the canonical Wave 1 replication id is unchanged");
  assertDeepEqual(await metadataSnapshot(path.join(REPO, ".evolve", "replication", "waves")), ctx.baseline.waves, "wave manifests unchanged");
});

test("41. Wave 2 is byte-identical", async () => {
  if (!ctx.evidenceAvailable) {
    skip("the .evolve replication/history evidence is not present — the Wave 2 case was skipped");
    return;
  }
  assertEqual(WAVE_2_DATASET_IDS.length, 3, "Wave 2 is three datasets");
  for (const id of WAVE_2_DATASET_IDS) assertEqual(await datasetFingerprint(id), WAVE_2_DATASET_FINGERPRINTS[id], `${id} still matches its pinned fingerprint`);
});

test("42. the frozen replication cohorts are unchanged", async () => {
  if (!ctx.evidenceAvailable) {
    skip("the .evolve replication evidence is not present — the cohort case was skipped");
    return;
  }
  const mock = await readFrozenCohort(path.join(REPO, ".evolve", "replication"), "mock");
  const deepseek = await readFrozenCohort(path.join(REPO, ".evolve", "replication"), "deepseek");
  assertEqual(mock.cohortDigest, FROZEN_COHORT_DIGESTS.mock, "the Mock cohort digest is unchanged");
  assertEqual(deepseek.cohortDigest, FROZEN_COHORT_DIGESTS.deepseek, "the DeepSeek cohort digest is unchanged");
  assertDeepEqual(await metadataSnapshot(path.join(REPO, ".evolve", "replication", "cohorts")), ctx.baseline.cohorts, "cohort files unchanged");
});

test("43. the six sealed replication datasets are unchanged", async () => {
  if (!ctx.evidenceAvailable) {
    skip("the .evolve history evidence is not present — the dataset case was skipped");
    return;
  }
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
  assertDeepEqual(await metadataSnapshot(path.join(REPO, ".evolve", "history")), ctx.baseline.history, "recorded datasets unchanged (no byte or mtime moved)");
});

test("44. the evaluation contract digest is EXACTLY the pinned value", async () => {
  assertEqual(CANONICAL_EVALUATION_CONTRACT_DIGEST, "4cf8ac1fa7db290acadeccf6043ec34c3239f8e3f848e9e50d8560826de85052", "the published contract pin is unchanged");
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
    console.error("could not build Phase 5G.1a fixtures:", error?.stack ?? error);
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
  console.log("offline: no live capture, no upstream tool executed, no network call, no Agent-Reach / Jev / DeepSeek call, no Arena run.");
  if (skips.length > 0) {
    console.log(`skipped ${skips.length} optional case(s) whose evidence is absent here:`);
    for (const reason of skips) console.log(`  - ${reason}`);
  }
  console.log(`EVOLVE Phase 5G.1a operation-aware preflight / capture-id / provenance validation: ${passed}/${cases.length} checks passed`);

  if (failures.length > 0) {
    console.log("Failed checks:");
    for (const failure of failures) console.log(`  - ${failure.name}`);
    process.exitCode = 1;
  } else {
    console.log("All Phase 5G.1a checks passed. Health is exposed at the exact (channel, operation) capability level, an");
    console.log("unavailable rendered plan fails closed BEFORE any upstream call or artifact (no install, no fallback), new");
    console.log("capture ids carry millisecond precision while legacy ids still parse, and synthetic provenance comes from the");
    console.log("provider — so an empty real capture is never mislabelled synthetic and mixed provenance is refused.");
  }
}

run().catch((error) => {
  console.error("phase 5G.1a validation runner crashed:", error);
  process.exitCode = 1;
});
