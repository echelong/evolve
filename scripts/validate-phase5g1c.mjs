#!/usr/bin/env node
/**
 * EVOLVE Phase 5G.1c validation suite — OFFLINE.
 *
 * MCPorter / Exa DETERMINISTIC TEXT-RESULT EXTRACTION, published as an EXPLICIT
 * VERSIONED SUCCESSOR capability contract.
 *
 * PROVEN RUNTIME EVIDENCE THIS SUITE PINS
 * ---------------------------------------
 * MCPorter 0.13.13 against `https://mcp.exa.ai/mcp` tool `exa.web_search_exa`,
 * with the Phase 5G.1b argument contract, really works: a raw diagnostic returned
 * status 0 and 37422 bytes containing multiple actual Exa search results. What
 * did NOT work was the PRESENTATION: `--output raw` renders a Node/JavaScript
 * INSPECTION dump (`{ content: [ { type: 'text', text: 'Title: …' } ] }`), not
 * strict JSON, so no JSON parser can read it.
 *
 * THE DESIGN DECISION (never weakened here)
 * -----------------------------------------
 * EVOLVE does NOT parse Node `util.inspect` syntax, does NOT `eval`, does NOT use
 * `Function`/`vm`/dynamic import/AST execution. For V3 Exa/Web it simply switches
 * MCPorter's renderer from `--output raw` to `--output text` — Exa's own
 * deterministic textual search-result representation — and reads it with a
 * DEDICATED, bounded parser.
 *
 * WHAT IS PROVEN HERE
 * -------------------
 *   A. V1 + V2 FROZEN    `reach-capability-map-v1` and `-v2` keep their versions,
 *                        their twelve entries, their EXACT argv and their
 *                        semantics; V2's real canary is preserved.
 *   B. V3 EXPLICIT       `reach-capability-map-v3` is a published successor that
 *                        `extendsVersion` V2 and changes ONLY the MCPorter/Exa
 *                        OUTPUT RENDERING (raw -> text).
 *   C. ACTIVE MAP        new captures are bounded by V3 and persist it.
 *   D. ARGV              `mcporter call exa.web_search_exa query=<q>
 *                        numResults=<limit> objective=<frozen objective>
 *                        --output text` as an ARRAY, `shell: false`, one token
 *                        per argument, no `--query`, no `--limit`, no
 *                        interpolation, no caller-defined keys, no eval.
 *   E. OBJECTIVE         the frozen objective and its digest are unchanged.
 *   F. CLAMP             `numResults <= 25` is unchanged.
 *   G. TEXT PARSER       a dedicated `exa-text-v1` parser for `\n---\n`-separated
 *                        blocks with `Title:`/`URL:`/`Published:`/`Author:`/
 *                        `Highlights:` only, explicit bounds, the FIRST 25 records
 *                        deterministically, and no evaluation, fetch or follow.
 *   H. EMPTY SEMANTICS   empty stdout, unparseable non-empty stdout and valid
 *                        blocks stay THREE distinct outcomes; unparseable fails
 *                        CLOSED (`ReachResponseParseError`).
 *   I. DISPATCH          only V3 Exa/Web selects the text parser; GitHub and every
 *                        other capability keep the generic parser contract.
 *   J. PROVENANCE        bounded, content-free parser diagnostics are persisted.
 *   K. IDENTITIES        every frozen artifact is byte-identical.
 *
 * Fully OFFLINE and deterministic: no network call, no real upstream tool is ever
 * executed (fixture stubs touch a marker file if they were), no Exa/Web query is
 * made, no Agent-Reach / Jev / DeepSeek call is made, no Arena is run, nothing is
 * classified, and nothing under `.evolve/` is written.
 *
 * Run with: npm run validate:phase5g1c
 */

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { canonicalJson, digestOf, hashFileBuffered } from "./lib/hash.mjs";

import {
  EXA_SEARCH_OBJECTIVE_DIGEST,
  EXA_SEARCH_OBJECTIVE_V1,
  EXA_RESULT_COUNT_ARGUMENT,
  EXA_WEB_SEARCH_MAX_RESULTS,
  EXA_WEB_SEARCH_TOOL,
  REACH_ACTIVE_CAPABILITY_MAP,
  REACH_ACTIVE_CAPABILITY_MAP_VERSION,
  REACH_CAPABILITY_MAP_V1,
  REACH_CAPABILITY_MAP_V2,
  REACH_CAPABILITY_MAP_V3,
  REACH_CAPABILITY_MAP_VERSION,
  REACH_CAPABILITY_MAP_VERSION_V2,
  REACH_CAPABILITY_MAP_VERSION_V3,
  REACH_EXA_TEXT_PARSE_FORMAT,
  REACH_MCPORTER_APPROVED_OUTPUT_FORMATS,
  REACH_MCPORTER_OUTPUT_FLAG,
  REACH_MCPORTER_OUTPUT_FORMATS,
  REACH_MCPORTER_OUTPUT_FORMATS_V3,
  REACH_MCPORTER_OUTPUT_FORMAT_TEXT,
  ReachCommandError,
  buildReachArgv,
  capabilityFor,
  runReachCall,
} from "./intelligence/agent-reach.mjs";
import {
  EXA_TEXT_MAX_AUTHOR_CHARS,
  EXA_TEXT_MAX_HIGHLIGHTS_CHARS,
  EXA_TEXT_MAX_RESULT_BLOCKS,
  EXA_TEXT_MAX_TITLE_CHARS,
  EXA_TEXT_MAX_URL_CHARS,
  EXA_TEXT_PARSE_FORMAT,
  EXA_TEXT_RESULT_SEPARATOR,
  parseExaSearchText,
} from "./intelligence/providers/exa-text.mjs";
import {
  ReachResponseParseError,
  createAgentReachIntelligenceProvider,
  exaTextParseFailure,
  parseReachStdout,
  reachParseFailure,
} from "./intelligence/provider.mjs";
import { readCaptureManifest, runCapture, verifyCapture } from "./intelligence/capture.mjs";
import { resolveIntelligenceConfig } from "./intelligence/config.mjs";
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
const NOW = Date.parse("2026-09-19T17:00:00.000Z");
const REAL_CAPTURE_ROOT = path.join(REPO, ".evolve", "intelligence");
const REAL_CLASSIFIER_ROOT = path.join(REPO, ".evolve", "classifier");
const REAL_CAPTURE_DAY = "2026-09-19";

/* ---------------------------------------------------------------------------
 * Pinned identities (read from the frozen artifacts; nothing live).
 * -------------------------------------------------------------------------*/

/** The failed V1 Web canary that PROVES the MCPorter `--limit` mismatch. */
const FAILED_WEB_CANARY_ID = "capture-20260919T154517620Z";
const FAILED_WEB_CANARY_MANIFEST_DIGEST = "f8846da593194cd4e09552bc33d1ba817e683dac3c5c85ff8c393a82e77f2252";
const FAILED_WEB_CANARY_REPLAY_DIGEST = "dc90e9cfae521c0fad3b293526170c8a39ea99b6ccd6a8134eeaffe4d9d988c9";
/** The first real V2 Web canary: transport succeeded, parser produced zero records. */
const V2_WEB_CANARY_ID = "capture-20260919T160610944Z";
const V2_WEB_CANARY_MANIFEST_DIGEST = "dedf590f286046a9228706c8eddc58d22e7eb92001ecc45307f8a4168682ce2f";
const V2_WEB_CANARY_REPLAY_DIGEST = "45705a9c6c5ce7b05db975b8d48c672e14bbb3357affd10450eecf4ec3bc9c2c";
/** The first real GitHub development capture. */
const GITHUB_DEVELOPMENT_CAPTURE_ID = "capture-20260919T154222003Z";
const GITHUB_DEVELOPMENT_MANIFEST_DIGEST = "4edee0e38159cffeb72b34af358c132babc2966e18c1829db2bc2f72d3c42f29";
const GITHUB_DEVELOPMENT_RECORDS_DIGEST = "3774472ca3ad666537ebd193599b4ce9467fc8b1821da7b9c7597ea8917801f1";
const GITHUB_DEVELOPMENT_REPLAY_DIGEST = "f8e22359b8bf827a4ebd62ca4f83bc75ebf5eeefa0bc02f525984de5aa1bf080";
/** The canonical V2 capture (schema 2 / features v2). */
const CANONICAL_V2_CAPTURE_ID = "capture-20260919T130756Z";
const CANONICAL_V2_MANIFEST_DIGEST = "4e9b460fc190fc1bff793b3fea5f294fcdf1d76d51f19844db7b57431deba1ac";
const CANONICAL_V2_REPLAY_DIGEST = "14f8a36cd694060b76a58c37fad21be55752d3243bde7a982cea224239dcabf3";
/** The legacy schema-1 V1 capture. */
const LEGACY_V1_CAPTURE_ID = "capture-20260919T122601Z";
const LEGACY_V1_MANIFEST_DIGEST = "76241b868f7e2839b04cb6f1328172ce01c7fff9fa0a071f92bd7e69d01a2ce2";
const LEGACY_V1_REPLAY_DIGEST = "b3904fe25071bdb85c555b2f8138ca61f06edf29aaccbc06a037c711d4ef7f07";

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

/** V1 stays frozen: its exact argv, per entry. */
const V1_ARGV = Object.freeze({
  "version:-": ["version"],
  "health:-": ["doctor", "--json"],
  "search:x": ["search", "{query}", "--json", "--limit", "{limit}"],
  "read:x": ["tweet", "{url}", "--json"],
  "search:exa": ["call", "exa.web_search_exa", "--query", "{query}", "--limit", "{limit}"],
  "search:web": ["call", "exa.web_search_exa", "--query", "{query}", "--limit", "{limit}"],
  "read:web": ["-fsSL", "--max-time", "{timeoutSeconds}", "{readerUrl}"],
  "search:reddit": ["search", "{query}", "--json", "--limit", "{limit}"],
  "read:reddit": ["read", "{url}", "--json"],
  "read:rss": ["-fsSL", "--max-time", "{timeoutSeconds}", "{url}"],
  "search:github": ["search", "repos", "{query}", "--json", "name,owner,description,url,stargazersCount", "--limit", "{limit}"],
  "read:github": ["repo", "view", "{query}", "--json", "name,description,url,stargazersCount"],
});

const V1_TRIPLES = Object.freeze([
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

/** The frozen V2 MCPorter argv (historical identity). */
const V2_MCP_ARGV = Object.freeze([
  "call",
  EXA_WEB_SEARCH_TOOL,
  "query={query}",
  "numResults={limit}",
  "objective={objective}",
  REACH_MCPORTER_OUTPUT_FLAG,
  REACH_MCPORTER_OUTPUT_FORMATS[0],
]);
/** The V3 MCPorter argv: identical except the renderer. */
const V3_MCP_ARGV = Object.freeze([
  "call",
  EXA_WEB_SEARCH_TOOL,
  "query={query}",
  "numResults={limit}",
  "objective={objective}",
  REACH_MCPORTER_OUTPUT_FLAG,
  REACH_MCPORTER_OUTPUT_FORMAT_TEXT,
]);

/** The modules whose isolation this suite re-proves. */
const RUNTIME_SOURCE_FILES = Object.freeze([
  "scripts/intelligence/agent-reach.mjs",
  "scripts/intelligence/provider.mjs",
  "scripts/intelligence/providers/exa-text.mjs",
  "scripts/intelligence/capture.mjs",
  "scripts/intelligence/records.mjs",
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

/* ============================================================================
 * Fixtures
 * ==========================================================================*/

const ctx = {
  tmp: null,
  marker: null,
  binAll: null,
  binCurlOnly: null,
  roots: {},
  sources: new Map(),
  baseline: {},
  captures: {},
  evidenceAvailable: false,
};

const CANDIDATE = Object.freeze({
  symbol: "SOLANA",
  name: "Solana",
  mint: "G51BMint111111111111111111111111111111111",
  domain: "solana.com",
  handle: "@solana",
});

/** The exact textual result shape Exa emits through MCPorter `--output text`. */
const EXA_TEXT_RESULT = [
  "Title: Assets on Solana",
  "URL: https://solana.com/docs/tokens",
  "Published: N/A",
  "Author: N/A",
  "Highlights:",
  "Assets on Solana are represented as SPL tokens.",
  "",
  EXA_TEXT_RESULT_SEPARATOR,
  "",
  "Title: Solana Tokenization for Stablecoins and Real-World Assets | Solana",
  "URL: https://solana.com/docs/tokenization",
  "Published: N/A",
  "Author: N/A",
  "Highlights:",
  "Tokenization brings real-world assets on-chain.",
  "Line two of the same highlight.",
].join("\n");

function agentConfig(overrides = {}) {
  return resolveIntelligenceConfig({
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    EVOLVE_INTELLIGENCE_PROVIDER: "agent-reach",
    ...overrides,
  });
}
function v1Entry(channel) {
  return capabilityFor("search", channel, REACH_CAPABILITY_MAP_V1);
}
function v2Entry(channel) {
  return capabilityFor("search", channel, REACH_CAPABILITY_MAP_V2);
}
function v3Entry(channel) {
  return capabilityFor("search", channel, REACH_CAPABILITY_MAP_V3);
}
function activeEntry(channel) {
  return capabilityFor("search", channel, REACH_ACTIVE_CAPABILITY_MAP);
}
function v3Values(overrides = {}) {
  return { query: '"Solana" token', limit: 5, ...overrides };
}
function stubSpawn(handler) {
  const calls = [];
  const spawn = (binary, argv, options) => {
    calls.push({ binary, argv, options, bin: path.basename(binary) });
    return handler({ binary, argv, options, index: calls.length });
  };
  spawn.calls = calls;
  return spawn;
}
function exaTextSpawn(text) {
  return stubSpawn(({ binary }) =>
    path.basename(binary) === "mcporter"
      ? { status: 0, stdout: text, stderr: "" }
      : { status: 0, stdout: "[]", stderr: "" },
  );
}
async function makeStubDir(dir, tools) {
  await mkdir(dir, { recursive: true });
  for (const tool of tools) {
    const target = path.join(dir, tool);
    // If a fixture stub were ever EXECUTED it would touch the marker file.
    await writeFile(target, `#!/bin/sh\ntouch "${ctx.marker}"\nexit 0\n`, "utf8");
    await chmod(target, 0o755);
  }
}
function root(name) {
  return path.join(ctx.tmp, name);
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
function runNode(args, { env = {} } = {}) {
  return spawnSync(process.execPath, args, {
    cwd: REPO,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, ...env },
  });
}

async function buildFixtures() {
  ctx.tmp = await mkdtemp(path.join(tmpdir(), "evolve-phase5g1c-"));
  ctx.marker = path.join(ctx.tmp, "executed.marker");
  ctx.binAll = path.join(ctx.tmp, "bin-all");
  ctx.binCurlOnly = path.join(ctx.tmp, "bin-curl");
  await makeStubDir(ctx.binAll, ["gh", "twitter", "rdt", "mcporter", "curl"]);
  await makeStubDir(ctx.binCurlOnly, ["curl"]);

  for (const name of ["capture", "doctor"]) {
    ctx.roots[name] = root(name);
    await mkdir(ctx.roots[name], { recursive: true });
  }

  for (const file of [...RUNTIME_SOURCE_FILES, ...Object.keys(EVALUATOR_SOURCE_DIGESTS)]) {
    ctx.sources.set(file, await readFile(file, "utf8").catch(() => ""));
  }

  const canonicalExperimentDir = path.join(REAL_CLASSIFIER_ROOT, "experiments", CANONICAL_INFRASTRUCTURE_EXPERIMENT_ID);
  ctx.evidenceAvailable = (await exists(path.join(REPO, ".evolve", "replication"))) && (await exists(path.join(REPO, ".evolve", "history")));
  ctx.baseline = {
    v2WebCanary: await metadataSnapshot(path.join(REAL_CAPTURE_ROOT, REAL_CAPTURE_DAY, V2_WEB_CANARY_ID)),
    failedWebCanary: await metadataSnapshot(path.join(REAL_CAPTURE_ROOT, REAL_CAPTURE_DAY, FAILED_WEB_CANARY_ID)),
    githubDevelopment: await metadataSnapshot(path.join(REAL_CAPTURE_ROOT, REAL_CAPTURE_DAY, GITHUB_DEVELOPMENT_CAPTURE_ID)),
    canonicalV2: await metadataSnapshot(path.join(REAL_CAPTURE_ROOT, REAL_CAPTURE_DAY, CANONICAL_V2_CAPTURE_ID)),
    legacyV1: await metadataSnapshot(path.join(REAL_CAPTURE_ROOT, REAL_CAPTURE_DAY, LEGACY_V1_CAPTURE_ID)),
    classifier: await metadataSnapshot(REAL_CLASSIFIER_ROOT),
    infraExperiment: await metadataSnapshot(canonicalExperimentDir),
    waves: await metadataSnapshot(path.join(REPO, ".evolve", "replication", "waves")),
    cohorts: await metadataSnapshot(path.join(REPO, ".evolve", "replication", "cohorts")),
    history: await metadataSnapshot(path.join(REPO, ".evolve", "history")),
  };

  ctx.captures.text = await runCapture({
    root: ctx.roots.capture,
    config: agentConfig({ EVOLVE_REACH_CHANNELS: "web" }),
    candidates: [CANDIDATE],
    provider: "agent-reach",
    now: NOW,
    env: { PATH: ctx.binAll },
    projectRoot: REPO,
    spawn: exaTextSpawn(EXA_TEXT_RESULT),
  });
  ctx.captures.unparseable = await runCapture({
    root: ctx.roots.capture,
    config: agentConfig({ EVOLVE_REACH_CHANNELS: "web" }),
    candidates: [CANDIDATE],
    provider: "agent-reach",
    now: NOW + 1_000,
    env: { PATH: ctx.binAll },
    projectRoot: REPO,
    spawn: exaTextSpawn("nothing recognizable here, just prose"),
  });
  ctx.captures.empty = await runCapture({
    root: ctx.roots.capture,
    config: agentConfig({ EVOLVE_REACH_CHANNELS: "web" }),
    candidates: [CANDIDATE],
    provider: "agent-reach",
    now: NOW + 2_000,
    env: { PATH: ctx.binAll },
    projectRoot: REPO,
    spawn: exaTextSpawn(""),
  });
}

async function disposeFixtures() {
  if (ctx.tmp) await rm(ctx.tmp, { recursive: true, force: true });
}

/* ============================================================================
 * PART A — capability map versioning (1-15)
 * ==========================================================================*/

test("1. reach-capability-map-v1 is byte/semantic frozen", async () => {
  assertEqual(REACH_CAPABILITY_MAP_VERSION, "reach-capability-map-v1", "the V1 version string is unchanged");
  assertEqual(REACH_CAPABILITY_MAP_V1.version, REACH_CAPABILITY_MAP_VERSION, "V1 declares its version");
  assertEqual(REACH_CAPABILITY_MAP_V1.entries.length, 12, "V1 still has twelve entries");
  assertDeepEqual(
    REACH_CAPABILITY_MAP_V1.entries.map((entry) => `${entry.op}:${entry.channel ?? "-"}:${entry.binary}`),
    V1_TRIPLES,
    "every V1 triple is unchanged",
  );
  for (const entry of REACH_CAPABILITY_MAP_V1.entries) {
    const key = `${entry.op}:${entry.channel ?? "-"}`;
    assertDeepEqual([...entry.argv], V1_ARGV[key], `V1 entry ${key} keeps its EXACT argv`);
    assertEqual(entry.parseFormat, undefined, `V1 entry ${key} pins no parse format`);
  }
  assertDeepEqual(
    buildReachArgv({ op: "search", channel: "web", values: { query: "q", limit: 5 } }).argv,
    ["call", "exa.web_search_exa", "--query", "q", "--limit", "5"],
    "the low-level default is still the frozen V1 contract",
  );
  assertDeepEqual(await metadataSnapshot(path.join(REAL_CAPTURE_ROOT, REAL_CAPTURE_DAY, LEGACY_V1_CAPTURE_ID)), ctx.baseline.legacyV1, "no V1-era byte moved");
});

test("2. reach-capability-map-v2 is byte/semantic frozen", async () => {
  assertEqual(REACH_CAPABILITY_MAP_VERSION_V2, "reach-capability-map-v2", "the V2 version string is unchanged");
  assertEqual(REACH_CAPABILITY_MAP_V2.version, REACH_CAPABILITY_MAP_VERSION_V2, "V2 declares its version");
  assertEqual(REACH_CAPABILITY_MAP_V2.extendsVersion, REACH_CAPABILITY_MAP_VERSION, "V2 still names V1 as its parent");
  assertEqual(REACH_CAPABILITY_MAP_V2.entries.length, 12, "V2 keeps twelve entries");
  assertDeepEqual(
    REACH_CAPABILITY_MAP_V2.entries.map((entry) => `${entry.op}:${entry.channel ?? "-"}:${entry.binary}`),
    V1_TRIPLES,
    "V2 keeps every (operation, channel, executable) triple",
  );
  for (const channel of ["exa", "web"]) {
    assertDeepEqual([...v2Entry(channel).argv], V2_MCP_ARGV, `V2 ${channel} keeps its EXACT argv (--output raw)`);
    assertEqual(v2Entry(channel).parseFormat, undefined, `V2 ${channel} pins no V3 parser`);
  }
  assertEqual(REACH_CAPABILITY_MAP_V2.mcpSearch.outputFormat, "raw", "V2's published rendering is still raw");
  assertEqual(REACH_CAPABILITY_MAP_V2.mcpSearch.parseFormat, undefined, "V2's published contract names no text parser");
  // The ONLY difference between V1 and V2 is the MCPorter search invocation.
  const changed = REACH_CAPABILITY_MAP_V2.entries
    .filter((entry, index) => canonicalJson(entry) !== canonicalJson(REACH_CAPABILITY_MAP_V1.entries[index]))
    .map((entry) => `${entry.op}:${entry.channel ?? "-"}`);
  assertDeepEqual(changed, ["search:exa", "search:web"], "exactly the two MCPorter search entries differ from V1");
});

test("3. reach-capability-map-v3 exists explicitly", async () => {
  assertEqual(REACH_CAPABILITY_MAP_VERSION_V3, "reach-capability-map-v3", "the V3 version string is explicit");
  assertEqual(REACH_CAPABILITY_MAP_V3.version, REACH_CAPABILITY_MAP_VERSION_V3, "the published V3 map declares its version");
  assertEqual(REACH_CAPABILITY_MAP_V3.entries.length, 12, "V3 keeps twelve entries");
  assertDeepEqual(
    REACH_CAPABILITY_MAP_V3.entries.map((entry) => `${entry.op}:${entry.channel ?? "-"}:${entry.binary}`),
    V1_TRIPLES,
    "V3 keeps every (operation, channel, executable) triple",
  );
  assertTrue(REACH_CAPABILITY_MAP_V3.version !== REACH_CAPABILITY_MAP_V2.version, "V3 never reuses the V2 version string");
  for (const channel of ["exa", "web"]) {
    assertDeepEqual([...v3Entry(channel).argv], V3_MCP_ARGV, `${channel}: the V3 argv template is EXACTLY the published one`);
  }
});

test("4. reach-capability-map-v3 extends V2", async () => {
  assertEqual(REACH_CAPABILITY_MAP_V3.extendsVersion, REACH_CAPABILITY_MAP_VERSION_V2, "V3 names V2 as its parent");
  assertEqual(REACH_CAPABILITY_MAP_V3.pinned, REACH_CAPABILITY_MAP_V2.pinned, "V3 pins the same Agent-Reach release");
  assertEqual(REACH_CAPABILITY_MAP_V3.mcpSearch.objectiveDigest, REACH_CAPABILITY_MAP_V2.mcpSearch.objectiveDigest, "V3 inherits V2's objective digest");
  assertEqual(REACH_CAPABILITY_MAP_V3.mcpSearch.maxResults, REACH_CAPABILITY_MAP_V2.mcpSearch.maxResults, "V3 inherits V2's max results");
});

test("5. the ACTIVE map is V3", async () => {
  assertEqual(REACH_ACTIVE_CAPABILITY_MAP, REACH_CAPABILITY_MAP_V3, "the active contract is the V3 map");
  assertEqual(REACH_ACTIVE_CAPABILITY_MAP_VERSION, REACH_CAPABILITY_MAP_VERSION_V3, "the active version is reported");
  const provider = createAgentReachIntelligenceProvider({ config: agentConfig(), env: { PATH: ctx.binAll }, projectRoot: REPO, spawn: exaTextSpawn(EXA_TEXT_RESULT) });
  assertEqual(provider.capabilityMapVersion, REACH_CAPABILITY_MAP_VERSION_V3, "the provider declares the V3 contract");
  assertEqual(ctx.captures.text.manifest.capabilityMapVersion, REACH_CAPABILITY_MAP_VERSION_V3, "a NEW capture persists V3");
  assertEqual(ctx.captures.text.manifest.schemaVersion, 2, "the provenance is additive on capture schema 2");
  assertEqual(ctx.captures.text.manifest.featureVersion, "external-intelligence-features-v2", "the feature pin is untouched");
  assertEqual((await verifyCapture(ctx.roots.capture, ctx.captures.text.captureId)).ok, true, "the V3 capture verifies");
  const onDisk = await readCaptureManifest(ctx.roots.capture, ctx.captures.text.captureId);
  assertEqual(onDisk.capabilityMapVersion, REACH_CAPABILITY_MAP_VERSION_V3, "the frozen manifest on disk carries V3");
});

test("6. exactly the Exa/Web output rendering differs between V2 and V3", async () => {
  const changed = REACH_CAPABILITY_MAP_V3.entries
    .filter((entry, index) => canonicalJson(entry) !== canonicalJson(REACH_CAPABILITY_MAP_V2.entries[index]))
    .map((entry) => `${entry.op}:${entry.channel ?? "-"}`);
  assertDeepEqual(changed, ["search:exa", "search:web"], "exactly the two MCPorter search entries changed");
  for (const channel of ["exa", "web"]) {
    const v2 = v2Entry(channel);
    const v3 = v3Entry(channel);
    // Everything except the final renderer token is byte-identical.
    assertDeepEqual([...v3.argv].slice(0, -1), [...v2.argv].slice(0, -1), `${channel}: every non-renderer token is inherited`);
    assertEqual(v2.argv.at(-1), "raw", `${channel}: V2 renders raw`);
    assertEqual(v3.argv.at(-1), "text", `${channel}: V3 renders text`);
    assertEqual(v3.parseFormat, REACH_EXA_TEXT_PARSE_FORMAT, `${channel}: V3 pins the dedicated parser`);
    assertEqual(v2.parseFormat, undefined, `${channel}: V2 pins none`);
    assertEqual(v3.namedArguments, v2.namedArguments, `${channel}: the named-argument contract is inherited`);
  }
  // The published mcpSearch contract differs in exactly two fields.
  const diff = Object.keys(REACH_CAPABILITY_MAP_V3.mcpSearch).filter(
    (key) => canonicalJson(REACH_CAPABILITY_MAP_V3.mcpSearch[key]) !== canonicalJson(REACH_CAPABILITY_MAP_V2.mcpSearch[key]),
  );
  assertDeepEqual(diff.sort(), ["outputFormat", "parseFormat"], "the published contract changes only rendering + parser pin");
});

test("7. V3 requests `--output text`", async () => {
  assertEqual(REACH_MCPORTER_OUTPUT_FORMAT_TEXT, "text", "the V3 format literal is `text`");
  assertDeepEqual([...REACH_MCPORTER_OUTPUT_FORMATS_V3], ["text"], "V3 publishes exactly one format");
  assertEqual(REACH_MCPORTER_APPROVED_OUTPUT_FORMATS.includes("text"), true, "`text` is an approved output format");
  for (const channel of ["exa", "web"]) {
    assertDeepEqual([...v3Entry(channel).argv].slice(-2), ["--output", "text"], `${channel}: the V3 template ends with --output text`);
  }
  const spawn = exaTextSpawn(EXA_TEXT_RESULT);
  const result = runReachCall({ op: "search", channel: "web", values: v3Values(), config: agentConfig(), env: { PATH: ctx.binAll }, projectRoot: REPO, spawn, capabilityMap: REACH_ACTIVE_CAPABILITY_MAP });
  assertDeepEqual(spawn.calls[0].argv.slice(-2), ["--output", "text"], "the LAUNCHED argv requests text output");
  assertDeepEqual(result.argv.slice(-2), ["--output", "text"], "the reported argv requests text output");
  // The exception stays bounded: `text` is still refused for any other tool.
  assertThrows(() => buildReachArgv({ op: "read", channel: "web", entry: { op: "read", channel: "web", binary: "curl", argv: ["-fsSL", "--output", "text", "{url}"] }, values: { url: "https://example.test/x" } }), ReachCommandError, "`--output text` is refused for curl");
});

test("8. V3 never requests `--output raw`", async () => {
  assertEqual(REACH_MCPORTER_OUTPUT_FORMATS.includes("raw"), true, "the frozen V2 format list still names raw");
  assertEqual(REACH_MCPORTER_OUTPUT_FORMATS_V3.includes("raw"), false, "the V3 format list never names raw");
  for (const channel of ["exa", "web"]) {
    assertEqual(v3Entry(channel).argv.includes("raw"), false, `${channel}: the V3 template carries no raw`);
    assertEqual(v3Entry(channel).argv.at(-2), "--output", `${channel}: the renderer flag is still explicit`);
  }
  const spawn = exaTextSpawn(EXA_TEXT_RESULT);
  runReachCall({ op: "search", channel: "web", values: v3Values(), config: agentConfig(), env: { PATH: ctx.binAll }, projectRoot: REPO, spawn, capabilityMap: REACH_ACTIVE_CAPABILITY_MAP });
  assertEqual(spawn.calls[0].argv.includes("raw"), false, "the LAUNCHED argv never carries raw");
});

test("9. the Exa tool target is unchanged", async () => {
  assertEqual(EXA_WEB_SEARCH_TOOL, "exa.web_search_exa", "the frozen tool target is exact");
  for (const channel of ["exa", "web"]) {
    assertEqual(v3Entry(channel).tool, "exa.web_search_exa", `${channel}: V3 declares the exact MCP tool`);
    assertEqual(v3Entry(channel).argv[0], "call", `${channel}: V3 still uses MCPorter's \`call\``);
    assertEqual(v3Entry(channel).argv[1], "exa.web_search_exa", `${channel}: V3 passes the tool as its OWN argv element`);
  }
  assertEqual(REACH_CAPABILITY_MAP_V3.mcpSearch.tool, "exa.web_search_exa", "the published V3 contract names the tool");
  const spawn = exaTextSpawn(EXA_TEXT_RESULT);
  const result = runReachCall({ op: "search", channel: "web", values: v3Values(), config: agentConfig(), env: { PATH: ctx.binAll }, projectRoot: REPO, spawn, capabilityMap: REACH_ACTIVE_CAPABILITY_MAP });
  assertEqual(result.tool, "exa.web_search_exa", "the runtime diagnostic reports the tool");
  assertEqual(spawn.calls[0].argv[1], "exa.web_search_exa", "the launched argv targets exactly that tool");
});

test("10. the query named argument is unchanged", async () => {
  assertDeepEqual([...v3Entry("web").argv].slice(2, 3), ["query={query}"], "the V3 query template is unchanged");
  assertEqual(REACH_CAPABILITY_MAP_V3.mcpSearch.queryArgument, "query", "the published query argument is unchanged");
  const query = '"Solana" token OR "solana.com"';
  const spawn = exaTextSpawn(EXA_TEXT_RESULT);
  const result = runReachCall({ op: "search", channel: "web", values: v3Values({ query }), config: agentConfig(), env: { PATH: ctx.binAll }, projectRoot: REPO, spawn, capabilityMap: REACH_ACTIVE_CAPABILITY_MAP });
  assertEqual(spawn.calls[0].argv[2], `query=${query}`, "the whole quoted query stays ONE argv element");
  assertEqual(result.argv[2], `query=${query}`, "the reported argv agrees");
  assertEqual(spawn.calls[0].argv.includes(query), false, "the raw query never appears as a separate element");
});

test("11. numResults is unchanged", async () => {
  assertEqual(EXA_RESULT_COUNT_ARGUMENT, "numResults", "the Exa argument name is unchanged");
  assertEqual(REACH_CAPABILITY_MAP_V3.mcpSearch.resultCountArgument, "numResults", "the published V3 contract agrees");
  const spawn = exaTextSpawn(EXA_TEXT_RESULT);
  const result = runReachCall({ op: "search", channel: "web", values: v3Values({ limit: 5 }), config: agentConfig(), env: { PATH: ctx.binAll }, projectRoot: REPO, spawn, capabilityMap: REACH_ACTIVE_CAPABILITY_MAP });
  assertEqual(spawn.calls[0].argv[3], "numResults=5", "argv[3] is the named result-count argument");
  assertEqual(result.argv[3], "numResults=5", "the reported argv agrees");
  assertEqual(spawn.calls[0].argv.includes("--limit"), false, "no --limit is ever passed to MCPorter");
});

test("12. the fixed objective is unchanged", async () => {
  assertEqual(REACH_CAPABILITY_MAP_V3.mcpSearch.objectiveArgument, "objective", "the published objective argument is unchanged");
  assertEqual(REACH_CAPABILITY_MAP_V3.mcpSearch.objectiveVersion, 1, "the objective version is unchanged");
  const spawn = exaTextSpawn(EXA_TEXT_RESULT);
  const result = runReachCall({ op: "search", channel: "web", values: v3Values(), config: agentConfig(), env: { PATH: ctx.binAll }, projectRoot: REPO, spawn, capabilityMap: REACH_ACTIVE_CAPABILITY_MAP });
  assertEqual(spawn.calls[0].argv[4], `objective=${EXA_SEARCH_OBJECTIVE_V1}`, "argv[4] carries the frozen objective");
  assertEqual(result.argv[4], `objective=${EXA_SEARCH_OBJECTIVE_V1}`, "the reported argv agrees");
  assertThrows(
    () => buildReachArgv({ op: "search", channel: "web", values: { query: "q", limit: 5, objective: "rank by profitability" }, capabilityMap: REACH_CAPABILITY_MAP_V3 }),
    ReachCommandError,
    "a caller-supplied objective is still refused",
  );
  const definitions = ctx.captures.text.manifest.queries.definitions ?? [];
  assertTrue(definitions.length > 0, "the capture executed a rendered query plan");
  assertEqual(definitions.every((row) => row.op === "search"), true, "every rendered query is the frozen search operation");
});

test("13. the objective digest is unchanged", async () => {
  assertEqual(EXA_SEARCH_OBJECTIVE_DIGEST, "6b1aa57a1d6afa8dec975487e432041d20dd750adeb1a1cc7aeb606cc56eaaae", "the digest is the pinned value");
  assertEqual(EXA_SEARCH_OBJECTIVE_DIGEST, digestOf({ version: 1, objective: EXA_SEARCH_OBJECTIVE_V1 }), "the digest is recomputable from the frozen text");
  assertEqual(REACH_CAPABILITY_MAP_V3.mcpSearch.objectiveDigest, EXA_SEARCH_OBJECTIVE_DIGEST, "V3 publishes the same digest");
});

test("14. the numResults clamp is unchanged", async () => {
  assertEqual(EXA_WEB_SEARCH_MAX_RESULTS, 25, "the Exa transport cap is 25");
  assertEqual(REACH_CAPABILITY_MAP_V3.mcpSearch.maxResults, 25, "V3 pins the cap too");
  const big = buildReachArgv({ op: "search", channel: "web", values: { query: "q", limit: 50 }, capabilityMap: REACH_CAPABILITY_MAP_V3 });
  assertEqual(big.argv[3], "numResults=25", "a request for 50 is clamped to 25");
  assertDeepEqual(big.boundedArguments, [{ argument: "numResults", requested: 50, effective: 25, max: 25, clamped: true }], "the requested/effective pair is reported");
  assertEqual(buildReachArgv({ op: "search", channel: "web", values: { query: "q", limit: 0 }, capabilityMap: REACH_CAPABILITY_MAP_V3 }).argv[3], "numResults=1", "0 is clamped up to at least one");
  assertEqual(buildReachArgv({ op: "search", channel: "exa", values: { query: "q", limit: 50 }, capabilityMap: REACH_CAPABILITY_MAP_V3 }).argv[3], "numResults=25", "the exa channel is clamped identically");
  const github = buildReachArgv({ op: "search", channel: "github", values: { query: "evolve", limit: 50 }, capabilityMap: REACH_CAPABILITY_MAP_V3 });
  assertDeepEqual(github.argv.slice(-2), ["--limit", "50"], "non-Exa capabilities are untouched by the Exa clamp");
  assertDeepEqual(github.boundedArguments, [], "no clamp is recorded for a non-Exa capability");
});

test("15. shell:false and the argv discipline are unchanged", async () => {
  const spawn = exaTextSpawn(EXA_TEXT_RESULT);
  const result = runReachCall({ op: "search", channel: "web", values: v3Values(), config: agentConfig(), env: { PATH: ctx.binAll }, projectRoot: REPO, spawn, capabilityMap: REACH_ACTIVE_CAPABILITY_MAP });
  const call = spawn.calls[0];
  assertEqual(call.options.shell, false, "shell is false");
  assertEqual(call.options.windowsHide, true, "windowsHide is set");
  assertDeepEqual(call.options.stdio, ["ignore", "pipe", "pipe"], "stdio is non-interactive");
  assertEqual(Array.isArray(call.argv), true, "argv is an ARRAY (never a command string)");
  assertEqual(result.spawned, true, "the call was spawned");
  assertEqual(call.bin, "mcporter", "exactly one mcporter process was requested");
  assertEqual(call.argv.length, 7, "the V3 argv has exactly seven elements (one per argument)");
  assertEqual(call.argv.filter((token) => token.includes("=")).length, 3, "three and only three named arguments exist");
  assertEqual(call.argv.some((token) => /[{}]/.test(token)), false, "no template placeholder survives into the argv");
  for (const file of RUNTIME_SOURCE_FILES) {
    assertDeepEqual(scan([[file, ctx.sources.get(file) ?? ""]], /shell\s*:\s*true|os\.system|execSync\(|spawn\(\s*"/), [], `${file} has no shell-string execution`);
  }
});

/* ============================================================================
 * PART B — the dedicated Exa TEXT parser (16-40)
 * ==========================================================================*/

/** A minimal, well-formed block. */
function block({ title = "T", url = "https://a.test/x", published = "N/A", author = "N/A", highlights = "H" } = {}) {
  const lines = [];
  if (title !== null) lines.push(`Title: ${title}`);
  if (url !== null) lines.push(`URL: ${url}`);
  if (published !== null) lines.push(`Published: ${published}`);
  if (author !== null) lines.push(`Author: ${author}`);
  if (highlights !== null) lines.push("Highlights:", highlights);
  return lines.join("\n");
}

test("16. the text parser parses one result", async () => {
  const parsed = parseExaSearchText(
    "Title: Assets on Solana\nURL: https://solana.com/docs/tokens\nPublished: N/A\nAuthor: N/A\nHighlights:\nSome highlight.",
  );
  assertEqual(parsed.format, EXA_TEXT_PARSE_FORMAT, "the format is exa-text-v1");
  assertEqual(parsed.records.length, 1, "exactly one record was extracted");
  assertEqual(parsed.recordsExtracted, 1, "the count is reported");
  assertEqual(parsed.blocksSeen, 1, "one block was seen");
  assertEqual(parsed.blocksDiscarded, 0, "nothing was discarded");
  assertEqual(parsed.explicitEmpty, false, "non-empty output is never flagged empty");
});

test("17. the text parser parses multiple `---`-separated results", async () => {
  const parsed = parseExaSearchText(EXA_TEXT_RESULT);
  assertEqual(parsed.records.length, 2, "both results were extracted");
  assertEqual(parsed.blocksSeen, 2, "two blocks were seen");
  assertDeepEqual(parsed.records.map((row) => row.title), ["Assets on Solana", "Solana Tokenization for Stablecoins and Real-World Assets | Solana"], "titles are preserved in order");
  assertDeepEqual(parsed.records.map((row) => row.url), ["https://solana.com/docs/tokens", "https://solana.com/docs/tokenization"], "URLs are preserved in order");
});

test("18. the separator must occupy its own line", async () => {
  const inline = parseExaSearchText("Title: A\nURL: https://a.test/x\nHighlights:\nfoo --- bar");
  assertEqual(inline.records.length, 1, "an inline `---` never splits");
  assertEqual(inline.records[0].text.includes("foo --- bar"), true, "the inline separator stays part of the highlight");
  assertEqual(parseExaSearchText("Title: A\nURL: https://a.test/x\nHighlights:\nfoo\n----------\nbar").records.length, 1, "a longer dash run never splits");
  const spaced = parseExaSearchText("Title: A\nURL: https://a.test/x\nHighlights:\nfoo\n   ---   \nbar");
  assertEqual(spaced.records.length, 1, "a separator line with surrounding whitespace still splits");
  assertEqual(spaced.blocksSeen, 2, "and the second (prose) block is seen");
  assertEqual(spaced.blocksDiscarded, 1, "the prose block is discarded");
  assertEqual(EXA_TEXT_RESULT_SEPARATOR, "---", "the separator literal is frozen");
});

test("19. Title is parsed", async () => {
  const parsed = parseExaSearchText(block({ title: "Assets on Solana" }));
  assertEqual(parsed.records[0].title, "Assets on Solana", "the title is bounded and preserved");
});

test("20. `Title: N/A` maps to null", async () => {
  const parsed = parseExaSearchText(block({ title: "N/A" }));
  assertEqual(parsed.records[0].title, null, "an explicit N/A title is null");
  assertEqual(parsed.records.length, 1, "the block is still recognizable through its URL/highlights");
  const uppercase = parseExaSearchText(block({ title: "n/a" }));
  assertEqual(uppercase.records[0].title, null, "the N/A literal is matched case-insensitively");
});

test("21. URL is parsed", async () => {
  const parsed = parseExaSearchText(block({ url: "https://solana.com/docs/tokens" }));
  assertEqual(parsed.records[0].url, "https://solana.com/docs/tokens", "the https URL is kept verbatim");
});

test("22. a non-https URL is rejected", async () => {
  for (const url of ["http://a.test/x", "ftp://a.test/x", "//a.test/x", "a.test/x", "/docs/tokens", "javascript:alert(1)", "data:text/html,x"]) {
    const parsed = parseExaSearchText(block({ url }));
    assertEqual(parsed.records[0].url, null, `the non-https URL ${JSON.stringify(url)} is rejected`);
  }
});

test("23. `URL: N/A` maps to null", async () => {
  const parsed = parseExaSearchText(block({ url: "N/A" }));
  assertEqual(parsed.records[0].url, null, "an explicit N/A URL is null");
  assertEqual(parsed.records.length, 1, "the block is still recognizable through its title/highlights");
});

test("24. Published is parsed", async () => {
  const parsed = parseExaSearchText(block({ published: "2024-01-02" }));
  assertEqual(parsed.records[0].publishedAt, "2024-01-02", "the published string is kept for the record normalizer");
});

test("25. `Published: N/A` maps to null", async () => {
  const parsed = parseExaSearchText(block({ published: "N/A" }));
  assertEqual(parsed.records[0].publishedAt, null, "an explicit N/A publication is null, never invented");
});

test("26. Author is parsed", async () => {
  const parsed = parseExaSearchText(block({ author: "Solana Foundation" }));
  assertEqual(parsed.records[0].author, "Solana Foundation", "the author is bounded and preserved");
});

test("27. `Author: N/A` maps to null", async () => {
  const parsed = parseExaSearchText(block({ author: "N/A" }));
  assertEqual(parsed.records[0].author, null, "an explicit N/A author is null");
});

test("28. multiline Highlights are parsed in order", async () => {
  const parsed = parseExaSearchText(block({ highlights: "first line\nsecond line\nthird line" }));
  assertEqual(parsed.records[0].text, "first line\nsecond line\nthird line", "every highlight line is preserved, in order");
  // A heading-looking line INSIDE the highlight body stays part of the highlight.
  const inside = parseExaSearchText(block({ highlights: "body\nURL: https://evil.test/x" }));
  assertEqual(inside.records[0].text.includes("URL: https://evil.test/x"), true, "a heading-looking highlight line is not re-parsed");
  assertEqual(inside.records[0].url, "https://a.test/x", "and it never overwrites the block's real URL");
});

test("29. unknown headings are ignored and no dynamic key is created", async () => {
  const parsed = parseExaSearchText(
    ["Title: A", "URL: https://a.test/x", "Score: 12", "Foo: bar", "Published: N/A", "Author: N/A", "Highlights:", "H", "Extra: ignored"].join("\n"),
  );
  assertEqual(parsed.records.length, 1, "the block is still recognized");
  assertDeepEqual(Object.keys(parsed.records[0]).sort(), ["author", "publishedAt", "text", "title", "url"], "the record carries exactly the five canonical fields");
  assertEqual("Score" in parsed.records[0], false, "an unknown heading never becomes a key");
  assertEqual("Extra" in parsed.records[0], false, "nor does a post-Highlights heading");
  assertEqual(parsed.records[0].text.includes("Extra: ignored"), true, "no unknown heading is dynamically recognized");
});

test("30. arbitrary prose is never treated as a record", async () => {
  for (const prose of ["Hello world.\nThis is prose, not a result.", "No results found.", "---", "- - -"]) {
    const parsed = parseExaSearchText(prose);
    assertEqual(parsed.records.length, 0, `the prose ${JSON.stringify(prose.slice(0, 24))} yields no record`);
    assertEqual(parsed.explicitEmpty, false, "prose is not the explicit-empty case");
  }
  // A block with a Title heading but NO usable value is not evidence either.
  const headingOnly = parseExaSearchText("Title: N/A\nURL: N/A\nHighlights:");
  assertEqual(headingOnly.records.length, 0, "a heading-only block with no usable value is discarded");
  assertEqual(headingOnly.blocksDiscarded, 1, "and it is counted as discarded");
});

test("31. code inside Highlights is never executed", async () => {
  const marker = path.join(ctx.tmp, "parsed-code.marker");
  const payload = [
    "Title: A",
    "URL: https://a.test/x",
    "Highlights:",
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "pwned"); process.exit(1);`,
    "globalThis.__pwned__ = true;",
    "```js",
    "eval('1+1')",
    "```",
  ].join("\n");
  const parsed = parseExaSearchText(payload);
  assertEqual(parsed.records.length, 1, "the block is still read as TEXT");
  assertEqual(parsed.records[0].text.includes("writeFileSync"), true, "the code is preserved as inert data");
  assertEqual(await exists(marker), false, "nothing ran: the marker file was never written");
  assertEqual(globalThis.__pwned__, undefined, "nothing was evaluated");
  // The parser source contains no execution primitive at all.
  const source = ctx.sources.get("scripts/intelligence/providers/exa-text.mjs") ?? "";
  assertDeepEqual(
    scan([["exa-text.mjs", source]], /\beval\s*\(|new Function\b|\bvm\s*\.|import\s*\(|child_process|\bspawn\s*\(|\bfork\s*\(|execSync|execFileSync/),
    [],
    "the parser has no eval / Function / vm / dynamic import / process primitive",
  );
  assertEqual(importSpecifiers(source).some((spec) => /child_process|worker_threads|node:vm/.test(spec)), false, "and it imports none of them");
});

test("32. a result URL is never fetched or followed", async () => {
  const parserSource = ctx.sources.get("scripts/intelligence/providers/exa-text.mjs") ?? "";
  const providerSource = ctx.sources.get("scripts/intelligence/provider.mjs") ?? "";
  const NETWORK = /\bfetch\s*\(|require\(["']https?["']\)|from\s+["'](?:node:)?https?["']|undici|axios|got\(|dns\.|net\.connect|XMLHttpRequest/;
  assertDeepEqual(scan([["exa-text.mjs", parserSource]], NETWORK), [], "the parser has no HTTP or DNS primitive");
  assertDeepEqual(scan([["provider.mjs", providerSource]], NETWORK), [], "nor does the provider module");
  assertDeepEqual(scan([["exa-text.mjs", parserSource]], /\bfetch\s*\(|\bopen\s*\(|createReadStream|readFile/), [], "the parser reads no file and fetches nothing");
  // Direct proof: fetch is poisoned while the parser runs and is never called.
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = () => {
    fetchCalls += 1;
    throw new Error("the parser must never fetch");
  };
  let parsed;
  try {
    parsed = parseExaSearchText(block({ url: "https://evil.test/follow-me" }));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assertEqual(fetchCalls, 0, "fetch was never called while parsing");
  assertEqual(parsed.records[0].url, "https://evil.test/follow-me", "the URL is kept as DATA");
  // And the provider places exactly ONE bounded process per query: no secondary read.
  const spawn = exaTextSpawn(block({ url: "https://evil.test/follow-me" }));
  const provider = createAgentReachIntelligenceProvider({ config: agentConfig(), env: { PATH: ctx.binAll }, projectRoot: REPO, spawn });
  provider.execute({ op: "search", channel: "web", query: "q", limit: 5 });
  assertEqual(spawn.calls.length, 1, "exactly one upstream call was placed");
  assertEqual(await exists(ctx.marker), false, "no fixture stub was executed");
});

test("33. at most 25 records are returned, deterministically", async () => {
  assertEqual(EXA_TEXT_MAX_RESULT_BLOCKS, 25, "the record cap is 25");
  const blocks = Array.from({ length: 30 }, (_value, index) => block({ title: `T${index}`, url: `https://a.test/${index}`, highlights: `H${index}` }));
  const parsed = parseExaSearchText(blocks.join("\n\n---\n\n"));
  assertEqual(parsed.records.length, 25, "exactly 25 records are returned");
  assertDeepEqual(parsed.records.map((row) => row.title), Array.from({ length: 25 }, (_value, index) => `T${index}`), "the FIRST 25 are taken, in order");
  assertEqual(JSON.stringify(parsed.records) === JSON.stringify(parseExaSearchText(blocks.join("\n\n---\n\n")).records), true, "parsing is deterministic");
});

test("34. the title bound is enforced", async () => {
  const long = "T".repeat(700);
  const parsed = parseExaSearchText(block({ title: long }));
  assertEqual(parsed.records[0].title.length, EXA_TEXT_MAX_TITLE_CHARS, "the title is truncated to the bound");
  assertEqual(EXA_TEXT_MAX_TITLE_CHARS, 500, "the title bound is 500");
});

test("35. the URL bound is enforced", async () => {
  const oversized = `https://a.test/${"x".repeat(2_100)}`;
  assertEqual(parseExaSearchText(block({ url: oversized })).records[0].url, null, "an oversized URL is rejected, never truncated");
  const max = `https://a.test/${"x".repeat(EXA_TEXT_MAX_URL_CHARS - "https://a.test/".length)}`;
  assertEqual(max.length, EXA_TEXT_MAX_URL_CHARS, "the fixture is exactly at the bound");
  assertEqual(parseExaSearchText(block({ url: max })).records[0].url, max, "a URL inside the bound is kept");
  assertEqual(EXA_TEXT_MAX_URL_CHARS, 2_048, "the URL bound is 2048");
});

test("36. the author bound is enforced", async () => {
  const parsed = parseExaSearchText(block({ author: "A".repeat(700) }));
  assertEqual(parsed.records[0].author.length, EXA_TEXT_MAX_AUTHOR_CHARS, "the author is truncated to the bound");
  assertEqual(EXA_TEXT_MAX_AUTHOR_CHARS, 500, "the author bound is 500");
});

test("37. the highlights bound is enforced", async () => {
  const parsed = parseExaSearchText(block({ highlights: "H".repeat(9_000) }));
  assertEqual(parsed.records[0].text.length, EXA_TEXT_MAX_HIGHLIGHTS_CHARS, "the highlights are truncated to the bound");
  assertEqual(EXA_TEXT_MAX_HIGHLIGHTS_CHARS, 8_000, "the highlights bound is 8000");
});

test("38. empty stdout is a deterministic zero-record call", async () => {
  for (const empty of ["", "   ", "\n\n", " \n \t "]) {
    const parsed = parseExaSearchText(empty);
    assertEqual(parsed.records.length, 0, "an empty output yields zero records");
    assertEqual(parsed.explicitEmpty, true, "the emptiness is explicit");
    assertEqual(parsed.blocksSeen, 0, "no block was seen");
    assertEqual(parsed.outputBytes >= 0, true, "the byte count is reported");
    assertEqual(exaTextParseFailure(parsed), null, "and it is NOT a parse failure");
  }
  const spawn = exaTextSpawn("");
  const provider = createAgentReachIntelligenceProvider({ config: agentConfig(), env: { PATH: ctx.binAll }, projectRoot: REPO, spawn });
  const outcome = provider.execute({ op: "search", channel: "web", query: "q", limit: 5 });
  assertEqual(outcome.ok, true, "the call is a SUCCESS");
  assertEqual(outcome.records.length, 0, "with zero records");
  assertEqual(outcome.error, null, "and no error");
  assertEqual(outcome.call.parse.format, EXA_TEXT_PARSE_FORMAT, "the parse format is recorded");
  assertEqual(ctx.captures.empty.manifest.counts.records, 0, "the capture is a legitimate zero-record capture");
  assertEqual(ctx.captures.empty.manifest.counts.failures, 0, "with NO failures recorded");
  assertEqual(ctx.captures.empty.manifest.health.web.status, "ok", "the channel is healthy");
});

test("39. non-empty, unparseable stdout fails closed", async () => {
  const parsed = parseExaSearchText("Some prose that is not an Exa result block at all.");
  assertEqual(parsed.records.length, 0, "no record could be extracted");
  assertEqual(parsed.explicitEmpty, false, "the output was NOT empty");
  const error = exaTextParseFailure(parsed);
  assertEqual(error?.name, "ReachResponseParseError", "the parser fails closed");
  assertTrue(error instanceof ReachResponseParseError, "through the exported error class");
  assertTrue(/PARSE FAILURE/.test(error.message), "the message is explicit about the parse failure");
  assertEqual(exaTextParseFailure(parseExaSearchText("")), null, "an EMPTY output is not a parse failure");
  assertEqual(exaTextParseFailure(parseExaSearchText(block({}))), null, "a valid block is not a parse failure");

  const spawn = exaTextSpawn("Some prose that is not an Exa result block at all.");
  const provider = createAgentReachIntelligenceProvider({ config: agentConfig(), env: { PATH: ctx.binAll }, projectRoot: REPO, spawn });
  const outcome = provider.execute({ op: "search", channel: "web", query: "q", limit: 5 });
  assertEqual(spawn.calls.length, 1, "the call really was placed");
  assertEqual(outcome.ok, false, "exit 0 is NOT enough: the parse failure wins");
  assertEqual(outcome.errorName, "ReachResponseParseError", "the status is the bounded parse error");
  assertEqual(outcome.parseFailed, true, "the parse failure flag is set");
  assertEqual(outcome.call.parse.format, EXA_TEXT_PARSE_FORMAT, "the recognised format is reported");
  assertEqual(outcome.call.parse.extractedRecords, 0, "zero records were extractable");
  assertDeepEqual(outcome.records, [], "no record is invented");

  const manifest = ctx.captures.unparseable.manifest;
  assertEqual(manifest.counts.records, 0, "the capture has no records");
  assertEqual(manifest.counts.failures, manifest.counts.calls, "EVERY call is recorded as a failure");
  assertEqual(manifest.failures.every((row) => /PARSE FAILURE/.test(row.error)), true, "every recorded failure names the parse failure");
  assertEqual(manifest.health.web.status, "error", "the channel health is an error (never a quiet ok)");
});

test("40. partially malformed blocks are handled deterministically", async () => {
  const text = [block({ title: "good-1" }), "junk block with no headings", block({ title: "N/A", url: "N/A", highlights: "" }), "URL: N/A"].join("\n\n---\n\n");
  const first = parseExaSearchText(text);
  const second = parseExaSearchText(text);
  assertEqual(first.records.length, 1, "only the well-formed block is evidence");
  assertDeepEqual(first.records.map((row) => row.title), ["good-1"], "the recognizable block is kept");
  assertEqual(first.blocksSeen, 4, "every block was examined");
  assertEqual(first.blocksDiscarded, 3, "the malformed blocks are counted");
  assertEqual(canonicalJson(first), canonicalJson(second), "the outcome is byte-identical on a second parse");
});

/* ============================================================================
 * PART C — dispatch, provenance, metadata hygiene (41-44)
 * ==========================================================================*/

test("41. only V3 Exa/Web selects the Exa text parser", async () => {
  assertEqual(REACH_EXA_TEXT_PARSE_FORMAT, "exa-text-v1", "the parse format identifier is frozen");
  for (const channel of ["exa", "web"]) {
    assertEqual(activeEntry(channel).parseFormat, REACH_EXA_TEXT_PARSE_FORMAT, `active ${channel} pins the text parser`);
    assertEqual(v3Entry(channel).parseFormat, REACH_EXA_TEXT_PARSE_FORMAT, `V3 ${channel} pins the text parser`);
    assertEqual(v2Entry(channel).parseFormat, undefined, `V2 ${channel} pins none`);
    assertEqual(v1Entry(channel).parseFormat, undefined, `V1 ${channel} pins none`);
  }
  // Every NON-Exa/Web active capability keeps the generic contract.
  for (const entry of REACH_ACTIVE_CAPABILITY_MAP.entries) {
    if (entry.op === "search" && (entry.channel === "exa" || entry.channel === "web")) continue;
    assertEqual(entry.parseFormat, undefined, `${entry.op}:${entry.channel ?? "-"} still pins no Exa parser`);
  }
  const textSpawn = exaTextSpawn(EXA_TEXT_RESULT);
  const textOutcome = createAgentReachIntelligenceProvider({ config: agentConfig(), env: { PATH: ctx.binAll }, projectRoot: REPO, spawn: textSpawn }).execute({ op: "search", channel: "web", query: "q", limit: 5 });
  assertEqual(textOutcome.call.parse.format, EXA_TEXT_PARSE_FORMAT, "the web call used the Exa text parser");
  assertEqual(textOutcome.ok, true, "and it succeeded");
  assertEqual(textOutcome.records.length, 2, "with two bounded records");
  const githubSpawn = stubSpawn(() => ({ status: 0, stdout: JSON.stringify({ results: [{ url: "https://g.test/1" }] }), stderr: "" }));
  const githubOutcome = createAgentReachIntelligenceProvider({ config: agentConfig(), env: { PATH: ctx.binAll }, projectRoot: REPO, spawn: githubSpawn }).execute({ op: "search", channel: "github", query: "evolve", limit: 5 });
  assertTrue(githubOutcome.call.parse.format !== EXA_TEXT_PARSE_FORMAT, "the github call did NOT use the Exa text parser");
});

test("42. the GitHub capability and its parser are unaffected", async () => {
  assertDeepEqual([...activeEntry("github").argv], [...v1Entry("github").argv], "the active github SEARCH argv is byte-identical to V1");
  assertDeepEqual(
    [...capabilityFor("read", "github", REACH_ACTIVE_CAPABILITY_MAP).argv],
    [...capabilityFor("read", "github", REACH_CAPABILITY_MAP_V1).argv],
    "the active github READ argv is byte-identical to V1",
  );
  const spawn = stubSpawn(() => ({ status: 0, stdout: JSON.stringify({ results: [{ url: "https://github.test/1", title: "E", description: "D" }] }), stderr: "" }));
  const outcome = createAgentReachIntelligenceProvider({ config: agentConfig(), env: { PATH: ctx.binAll }, projectRoot: REPO, spawn }).execute({ op: "search", channel: "github", query: "evolve", limit: 5 });
  assertEqual(outcome.ok, true, "the github call succeeds on the generic shape");
  assertEqual(outcome.call.parse.format, "json-results", "through the generic parser");
  assertEqual(outcome.records.length, 1, "and it extracts its record");
  assertEqual(outcome.call.parse.blocksSeen, 0, "no Exa text block diagnostics are fabricated");
  assertEqual(reachParseFailure(parseReachStdout(JSON.stringify({ results: [] }))), null, "the generic fail-closed rule is unweakened");
  assertEqual(reachParseFailure(parseReachStdout(JSON.stringify({ content: [{ type: "text", text: "prose" }] }))).name, "ReachResponseParseError", "the generic parser still fails closed on unparseable prose");
});

test("43. parse metadata carries no raw text", async () => {
  const markerText = "ZZ-RAW-SECRET-EXCERPT-9f2a";
  const text = block({ title: `T ${markerText}`, url: "https://secret.test/path", author: `A ${markerText}`, highlights: `H ${markerText}` });
  const spawn = exaTextSpawn(text);
  const outcome = createAgentReachIntelligenceProvider({ config: agentConfig(), env: { PATH: ctx.binAll }, projectRoot: REPO, spawn }).execute({ op: "search", channel: "web", query: "q", limit: 5 });
  const serialized = JSON.stringify(outcome.call.parse);
  assertEqual(serialized.includes(markerText), false, "no raw excerpt leaks into the parse metadata");
  assertEqual(serialized.includes("secret.test"), false, "no URL leaks into the parse metadata");
  assertEqual(serialized.includes("https"), false, "not even the scheme leaks");
  for (const value of Object.values(outcome.call.parse)) {
    assertTrue(["string", "number", "boolean"].includes(typeof value), "every metadata value is a scalar");
  }
  // The persisted manifest provenance is content-free too.
  const [call] = ctx.captures.text.manifest.providerCalls ?? [];
  assertTrue(call !== undefined, "the capture persisted a provider call");
  assertEqual(call.parse.format, EXA_TEXT_PARSE_FORMAT, "the persisted parse format is recorded");
  assertEqual(call.parse.blocksSeen, 2, "the persisted block count is recorded");
  assertEqual(call.parse.recordsExtracted, 2, "the persisted record count is recorded");
  assertEqual(call.parse.blocksDiscarded, 0, "the persisted discard count is recorded");
  assertEqual(Number.isFinite(call.parse.outputBytes), true, "the persisted output size is recorded");
});

test("44. parse metadata carries no URL, title, author or highlight", async () => {
  const spawn = exaTextSpawn(EXA_TEXT_RESULT);
  const outcome = createAgentReachIntelligenceProvider({ config: agentConfig(), env: { PATH: ctx.binAll }, projectRoot: REPO, spawn }).execute({ op: "search", channel: "web", query: "q", limit: 5 });
  const serialized = JSON.stringify(outcome.call.parse);
  for (const secret of ["solana.com", "Assets on Solana", "Tokenization", "SPL tokens", "Line two"]) {
    assertEqual(serialized.includes(secret), false, `the parse metadata never contains ${JSON.stringify(secret)}`);
  }
  const manifestSerialized = JSON.stringify(ctx.captures.text.manifest.providerCalls);
  for (const secret of ["solana.com", "Assets on Solana", "Tokenization", "SPL tokens", "Line two"]) {
    assertEqual(manifestSerialized.includes(secret), false, `the persisted provenance never contains ${JSON.stringify(secret)}`);
  }
  assertDeepEqual(
    Object.keys(ctx.captures.text.manifest.providerCalls[0]).sort(),
    ["binary", "capabilityMapVersion", "channel", "operation", "parse", "queryId", "spawned", "unavailable"],
    "the provenance keys are fixed (no field is ever created from content)",
  );
});

/* ============================================================================
 * PART D — frozen identities (45-61) and further invariants
 * ==========================================================================*/

test("45. the V2 Web canary is byte-untouched", async () => {
  const dir = path.join(REAL_CAPTURE_ROOT, REAL_CAPTURE_DAY, V2_WEB_CANARY_ID);
  if (!(await exists(dir))) {
    skip(`the V2 Web canary ${V2_WEB_CANARY_ID} is not present — its identity case was skipped`);
    return;
  }
  assertDeepEqual(await metadataSnapshot(dir), ctx.baseline.v2WebCanary, "no byte or mtime of the canary moved");
  const manifest = await readCaptureManifest(REAL_CAPTURE_ROOT, V2_WEB_CANARY_ID);
  assertEqual(manifest.captureId, V2_WEB_CANARY_ID, "the capture id is unchanged");
  assertEqual(manifest.manifestDigest, V2_WEB_CANARY_MANIFEST_DIGEST, "the manifest digest is EXACTLY the pinned value");
  assertEqual(manifest.capabilityMapVersion, REACH_CAPABILITY_MAP_VERSION_V2, "it is historical V2 evidence");
  assertEqual(manifest.counts.records, 0, "it still records the V2 zero-result outcome");
  assertEqual(manifest.counts.failures, 0, "and no failure was retroactively recorded");
  assertEqual((await verifyCapture(REAL_CAPTURE_ROOT, V2_WEB_CANARY_ID)).ok, true, "its bytes still verify");
  const replay = await replayCapture({ root: REAL_CAPTURE_ROOT, captureId: V2_WEB_CANARY_ID, asOf: null });
  assertEqual(replay.replayDigest, V2_WEB_CANARY_REPLAY_DIGEST, "the replay digest is EXACTLY the pinned value");
  assertEqual(replay.recordCount, 0, "the replay still reports zero records");
});

test("46. the failed V1 Web canary is byte-untouched", async () => {
  const dir = path.join(REAL_CAPTURE_ROOT, REAL_CAPTURE_DAY, FAILED_WEB_CANARY_ID);
  if (!(await exists(dir))) {
    skip(`the failed Web canary ${FAILED_WEB_CANARY_ID} is not present — its identity case was skipped`);
    return;
  }
  assertDeepEqual(await metadataSnapshot(dir), ctx.baseline.failedWebCanary, "no byte or mtime moved");
  const manifest = await readCaptureManifest(REAL_CAPTURE_ROOT, FAILED_WEB_CANARY_ID);
  assertEqual(manifest.manifestDigest, FAILED_WEB_CANARY_MANIFEST_DIGEST, "the manifest digest is EXACTLY the pinned value");
  assertEqual(manifest.capabilityMapVersion, undefined, "it predates the capability-map provenance (never rewritten)");
  assertEqual(manifest.counts.records, 0, "it remains a zero-record capture");
  assertEqual(manifest.failures[0].error.includes("Unknown flag '--limit'"), true, "and still records the EXACT V1 MCPorter mismatch");
  const replay = await replayCapture({ root: REAL_CAPTURE_ROOT, captureId: FAILED_WEB_CANARY_ID, asOf: null });
  assertEqual(replay.replayDigest, FAILED_WEB_CANARY_REPLAY_DIGEST, "the replay digest is EXACTLY the pinned value");
});

test("47. the GitHub development capture is byte-untouched", async () => {
  const dir = path.join(REAL_CAPTURE_ROOT, REAL_CAPTURE_DAY, GITHUB_DEVELOPMENT_CAPTURE_ID);
  if (!(await exists(dir))) {
    skip(`the GitHub development capture ${GITHUB_DEVELOPMENT_CAPTURE_ID} is not present — its identity case was skipped`);
    return;
  }
  assertDeepEqual(await metadataSnapshot(dir), ctx.baseline.githubDevelopment, "no byte or mtime moved");
  const manifest = await readCaptureManifest(REAL_CAPTURE_ROOT, GITHUB_DEVELOPMENT_CAPTURE_ID);
  assertEqual(manifest.manifestDigest, GITHUB_DEVELOPMENT_MANIFEST_DIGEST, "the manifest digest is EXACTLY the pinned value");
  assertEqual(manifest.digests.recordsDigest, GITHUB_DEVELOPMENT_RECORDS_DIGEST, "the records digest is EXACTLY the pinned value");
  assertEqual(manifest.counts.records, 1, "it still holds its one record");
  const replay = await replayCapture({ root: REAL_CAPTURE_ROOT, captureId: GITHUB_DEVELOPMENT_CAPTURE_ID, asOf: null });
  assertEqual(replay.replayDigest, GITHUB_DEVELOPMENT_REPLAY_DIGEST, "the replay digest is EXACTLY the pinned value");
});

test("48. the canonical V2 capture is byte-untouched", async () => {
  const dir = path.join(REAL_CAPTURE_ROOT, REAL_CAPTURE_DAY, CANONICAL_V2_CAPTURE_ID);
  if (!(await exists(dir))) {
    skip(`the canonical V2 capture ${CANONICAL_V2_CAPTURE_ID} is not present — its identity case was skipped`);
    return;
  }
  assertDeepEqual(await metadataSnapshot(dir), ctx.baseline.canonicalV2, "no byte or mtime moved");
  const manifest = await readCaptureManifest(REAL_CAPTURE_ROOT, CANONICAL_V2_CAPTURE_ID);
  assertEqual(manifest.manifestDigest, CANONICAL_V2_MANIFEST_DIGEST, "the manifest digest is EXACTLY the pinned value");
  assertEqual(manifest.schemaVersion, 2, "it is a schema-2 capture");
  assertEqual(manifest.featureVersion, "external-intelligence-features-v2", "its feature pin is untouched");
  const replay = await replayCapture({ root: REAL_CAPTURE_ROOT, captureId: CANONICAL_V2_CAPTURE_ID, asOf: null });
  assertEqual(replay.replayDigest, CANONICAL_V2_REPLAY_DIGEST, "the replay digest is EXACTLY the pinned value");
});

test("49. the legacy V1 capture is byte-untouched", async () => {
  const dir = path.join(REAL_CAPTURE_ROOT, REAL_CAPTURE_DAY, LEGACY_V1_CAPTURE_ID);
  if (!(await exists(dir))) {
    skip(`the legacy V1 capture ${LEGACY_V1_CAPTURE_ID} is not present — its identity case was skipped`);
    return;
  }
  assertDeepEqual(await metadataSnapshot(dir), ctx.baseline.legacyV1, "no byte or mtime moved");
  const manifest = await readCaptureManifest(REAL_CAPTURE_ROOT, LEGACY_V1_CAPTURE_ID);
  assertEqual(manifest.manifestDigest, LEGACY_V1_MANIFEST_DIGEST, "the manifest digest is EXACTLY the pinned value");
  assertEqual(manifest.schemaVersion, 1, "it stays a legacy schema-1 manifest");
  const replay = await replayCapture({ root: REAL_CAPTURE_ROOT, captureId: LEGACY_V1_CAPTURE_ID, asOf: null });
  assertEqual(replay.replayDigest, LEGACY_V1_REPLAY_DIGEST, "the legacy replay digest is EXACTLY the pinned value");
  assertEqual(replay.featureVersion, "external-intelligence-features-v1", "it still resolves the frozen V1 transform");
});

test("50. the classifier experiment is untouched", async () => {
  const dir = path.join(REAL_CLASSIFIER_ROOT, "experiments", CANONICAL_INFRASTRUCTURE_EXPERIMENT_ID);
  if (!(await exists(dir))) {
    skip("the canonical classifier experiment is not present here — its identity case was skipped");
    return;
  }
  const experiment = JSON.parse(await readFile(path.join(dir, CLASSIFIER_EXPERIMENT_FILE), "utf8"));
  assertEqual(experiment.experimentId, CANONICAL_INFRASTRUCTURE_EXPERIMENT_ID, "the experiment id is unchanged");
  assertEqual(experiment.resultDigest, CANONICAL_INFRASTRUCTURE_RESULT_DIGEST, "the pinned result digest matches the constant");
  assertEqual(experiment.resultDigest, "69170f5375168f9cadc2243fc50b74e282b6ab055ae738e5b7478b379d33655d", "and the literal digest is unchanged");
  assertEqual(experiment.experimentDigest, CANONICAL_INFRASTRUCTURE_EXPERIMENT_DIGEST, "the pinned experiment digest is unchanged");
  assertEqual(experiment.classifierId, CLASSIFIER_ID, "it uses the frozen taxonomy");
  assertEqual(experiment.classifierVersion, CLASSIFIER_VERSION, "and the frozen version");
  assertDeepEqual(await metadataSnapshot(dir), ctx.baseline.infraExperiment, "the experiment bytes are untouched");
});

test("51. the Phase 5G.1 evaluator is untouched", async () => {
  for (const [file, expected] of Object.entries(EVALUATOR_SOURCE_DIGESTS)) {
    assertEqual(await hashFileBuffered(file), expected, `${file} is byte-identical to the pinned evaluator`);
  }
});

test("52. nothing in the changed layer calls classifier.dev", async () => {
  for (const file of RUNTIME_SOURCE_FILES) {
    const source = ctx.sources.get(file) ?? "";
    assertTrue(!importSpecifiers(source).some((spec) => /classifier/i.test(spec)), `${file} imports no classifier module`);
    assertDeepEqual(scan([[file, source]], /classifier\.dev|createClassifierDevProvider|classification_/), [], `${file} references no classifier endpoint`);
  }
});

test("53. nothing in the changed layer calls Jev", async () => {
  for (const file of RUNTIME_SOURCE_FILES) {
    const source = ctx.sources.get(file) ?? "";
    assertTrue(!importSpecifiers(source).some((spec) => /jev/i.test(spec)), `${file} imports nothing from the Jev layer`);
    assertDeepEqual(scan([[file, source]], /\bjevDecide\b|\bcreateVercelJevProvider\b|\bJEV_STATUS\b/), [], `${file} references no Jev API`);
  }
});

test("54. nothing in the changed layer calls DeepSeek", async () => {
  for (const file of RUNTIME_SOURCE_FILES) {
    const source = ctx.sources.get(file) ?? "";
    assertTrue(!importSpecifiers(source).some((spec) => /research|deepseek|cline/i.test(spec)), `${file} imports no research/DeepSeek module`);
    assertDeepEqual(scan([[file, source]], /deepseek-cline|api\.deepseek|deepseek\.com/), [], `${file} references no DeepSeek endpoint`);
  }
});

test("55. nothing in the changed layer runs the Arena or the engine", async () => {
  for (const file of RUNTIME_SOURCE_FILES) {
    const source = ctx.sources.get(file) ?? "";
    assertTrue(!importSpecifiers(source).some((spec) => /arena|champion|replication|\/engine|market|wallet|signer|solana|jupiter|rpc|trade/i.test(spec)), `${file} imports no Arena/market module`);
    assertDeepEqual(scan([[file, source]], /\brunArena\b|\brunTournament\b|\bevolveGeneration\b/), [], `${file} runs no Arena code`);
  }
});

test("56. nothing in the changed layer can trade", async () => {
  for (const file of RUNTIME_SOURCE_FILES) {
    const code = stripComments(ctx.sources.get(file) ?? "");
    for (const pattern of FORBIDDEN_TRANSACTION_API) assertTrue(!pattern.test(code), `${file} references no transaction API (${pattern})`);
  }
});

test("57. Wave 1 is byte-identical", async () => {
  if (!ctx.evidenceAvailable) {
    skip("the .evolve replication/history evidence is not present — the Wave 1 case was skipped");
    return;
  }
  assertEqual(WAVE_1_DATASET_IDS.length, 3, "Wave 1 is three datasets");
  for (const id of WAVE_1_DATASET_IDS) assertEqual(await datasetFingerprint(id), WAVE_1_DATASET_FINGERPRINTS[id], `${id} still matches its pinned fingerprint`);
  assertEqual(CANONICAL_WAVE_1_REPLICATION_ID, "rep-66884de4e460", "the canonical Wave 1 replication id is unchanged");
  assertDeepEqual(await metadataSnapshot(path.join(REPO, ".evolve", "replication", "waves")), ctx.baseline.waves, "wave manifests unchanged");
});

test("58. Wave 2 is byte-identical", async () => {
  if (!ctx.evidenceAvailable) {
    skip("the .evolve replication/history evidence is not present — the Wave 2 case was skipped");
    return;
  }
  assertEqual(WAVE_2_DATASET_IDS.length, 3, "Wave 2 is three datasets");
  for (const id of WAVE_2_DATASET_IDS) assertEqual(await datasetFingerprint(id), WAVE_2_DATASET_FINGERPRINTS[id], `${id} still matches its pinned fingerprint`);
});

test("59. the frozen replication cohorts are unchanged", async () => {
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

test("60. the six sealed replication datasets are unchanged", async () => {
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

test("61. the evaluation contract digest is EXACTLY the pinned value", async () => {
  assertEqual(CANONICAL_EVALUATION_CONTRACT_DIGEST, "4cf8ac1fa7db290acadeccf6043ec34c3239f8e3f848e9e50d8560826de85052", "the published contract pin is unchanged");
  if (!ctx.evidenceAvailable) {
    skip("the stored Wave 1 freeze is not present — the derived-contract case was skipped");
    return;
  }
  const stored = await readFreeze({ root: path.join(REPO, ".evolve", "replication") });
  assertEqual(evaluationContractDigest(stored), CANONICAL_EVALUATION_CONTRACT_DIGEST, "the STORED freeze still derives the canonical digest");
});

/* --- further invariants ---------------------------------------------------- */

test("62. every V3 capture records bounded, content-free parser provenance", async () => {
  const manifest = ctx.captures.text.manifest;
  const expectedCalls = manifest.queries.definitions.length;
  assertTrue(expectedCalls >= 1, "the capture rendered at least one query");
  assertEqual(manifest.counts.calls, expectedCalls, "the capture placed exactly one call per rendered query");
  assertEqual(manifest.counts.records, expectedCalls * 2, "and extracted both textual results of each call");
  assertEqual(manifest.counts.failures, 0, "with no failure");
  assertEqual(manifest.health.web.status, "ok", "the channel is healthy");
  assertEqual(manifest.providerCalls.length, expectedCalls, "every provider call was recorded");
  const [call] = manifest.providerCalls;
  assertEqual(call.binary, "mcporter", "the provenance names the executable");
  assertEqual(call.capabilityMapVersion, REACH_CAPABILITY_MAP_VERSION_V3, "and the contract it ran under");
  assertEqual(call.parse.format, EXA_TEXT_PARSE_FORMAT, "and the parser that read the output");
  assertEqual(call.spawned, true, "and that a process really ran");
  // The capture writes only its own immutable directory (day bucket → capture).
  const days = (await readdir(ctx.roots.capture, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  assertDeepEqual(days, ["2026-09-19"], "captures are bucketed by day only");
  const dirs = (await readdir(path.join(ctx.roots.capture, days[0]), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assertDeepEqual(dirs, [ctx.captures.text.captureId, ctx.captures.unparseable.captureId, ctx.captures.empty.captureId].sort(), "only the three fixture captures exist");
});

test("63. the doctor names the V3 contract and stays zero-network", async () => {
  const out = root("doctor");
  const run = runNode(["scripts/intelligence.mjs", "doctor", "--json", "--out", out], { env: { PATH: ctx.binAll } });
  assertEqual(run.status, 0, `the doctor exits 0 (stderr: ${run.stderr})`);
  const payload = JSON.parse(run.stdout);
  assertEqual(payload.capabilityReadiness.activeCapabilityMapVersion, REACH_CAPABILITY_MAP_VERSION_V3, "the ACTIVE contract is V3");
  assertDeepEqual(payload.capabilityMaps, { active: REACH_CAPABILITY_MAP_VERSION_V3, historical: REACH_CAPABILITY_MAP_VERSION }, "both maps are reported");
  assertEqual(payload.capabilityReadiness.networkCalls, 0, "zero network calls");
  assertEqual(payload.capabilityReadiness.subprocessesSpawned, 0, "zero subprocesses");
  assertEqual(await exists(ctx.marker), false, "no fixture stub was executed by the doctor");
});

test("64. the V3 and V2 maps never share a mutable entry", async () => {
  assertTrue(Object.isFrozen(REACH_CAPABILITY_MAP_V3), "V3 is frozen");
  assertTrue(Object.isFrozen(REACH_CAPABILITY_MAP_V2), "V2 is frozen");
  for (const entry of REACH_CAPABILITY_MAP_V3.entries) assertTrue(Object.isFrozen(entry), "every V3 entry is frozen");
  // A mutating attempt must not be able to rewrite a frozen entry's argv.
  const before = canonicalJson(v3Entry("web"));
  try {
    v3Entry("web").argv = ["mutated"];
  } catch {
    // strict mode: the assignment throws, which is the desired fail-closed behavior
  }
  assertEqual(canonicalJson(v3Entry("web")), before, "the frozen V3 entry is immutable");
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
    console.error("could not build Phase 5G.1c fixtures:", error?.stack ?? error);
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
  console.log("offline: no Exa/Web query, no upstream tool executed, no network call, no capture written under .evolve/, no");
  console.log("Agent-Reach / Jev / DeepSeek call, no classification, no Arena run.");
  if (skips.length > 0) {
    console.log(`skipped ${skips.length} optional case(s) whose evidence is absent here:`);
    for (const reason of skips) console.log(`  - ${reason}`);
  }
  console.log(`EVOLVE Phase 5G.1c MCPorter/Exa text-extraction validation: ${passed}/${cases.length} checks passed`);

  if (failures.length > 0) {
    console.log("Failed checks:");
    for (const failure of failures) console.log(`  - ${failure.name}`);
    process.exitCode = 1;
  } else {
    console.log("All Phase 5G.1c checks passed. `reach-capability-map-v1` and `-v2` are byte/semantic frozen; the ACTIVE");
    console.log("`reach-capability-map-v3` renders `mcporter call exa.web_search_exa query=<q> numResults=<limit>");
    console.log("objective=<frozen objective> --output text` as an ARRAY with shell:false, and a dedicated bounded");
    console.log("`exa-text-v1` parser extracts at most 25 records without evaluating, fetching or following anything.");
  }
}

run().catch((error) => {
  console.error("phase 5G.1c validation runner crashed:", error);
  process.exitCode = 1;
});
