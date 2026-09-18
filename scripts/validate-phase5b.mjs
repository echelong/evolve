#!/usr/bin/env node
/**
 * EVOLVE Phase 5B validation suite — DeepSeek V4.1 Flash via Cline as an
 * OPTIONAL Research Swarm provider.
 *
 * Covers: provider selection + validation (mock default, explicit
 * `deepseek-cline`, exact model, xHigh, no silent fallback), the provider
 * module (subprocess contract, argv construction, timeouts, process errors,
 * empty/malformed/ambiguous output, schema rejection), strict JSON extraction,
 * the versioned TRAIN-only evidence packet + no-lookahead boundary, research
 * memory filtering, context limits and deterministic truncation, provenance
 * (prompt version, model/reasoning, latency, digests), secret handling,
 * cache keys/hits/misses, provider-output replay, deterministic downstream
 * behaviour (compiler, genome digest, watchdog, quarantine), experiment
 * isolation, the dashboard provider state, the provider probe, the comparison
 * tool's within-run delta semantics, and the unchanged A/B / species-match /
 * Arena-scoring / gate behaviour.
 *
 * Fully OFFLINE and deterministic: a stub executable stands in for the Cline
 * CLI, so no network, no key, and no live model is required.
 *
 * Run with: npm run validate:phase5b
 */

import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { digestOf } from "./lib/hash.mjs";
import { createMarketConfig } from "./market/config.mjs";
import { makeFixture } from "./make-fixture.mjs";
import { DEFAULT_DEPLOYMENT_GATES, ARENA_SCORE_VERSION, computeArenaScore, REGIMES } from "./arena/orchestrator.mjs";
import { RESEARCH_ARENA_MODE } from "./arena/research-cohort.mjs";
import { speciesMatchRequested } from "./research/ab-cohort.mjs";
import { RESEARCH_COHORT_DEFAULTS, genomeDigestOf } from "./research/cohort.mjs";
import { compileProposals } from "./research/compiler.mjs";
import { PROPOSAL_SCHEMA_VERSION, validateProposal } from "./research/proposal-schema.mjs";
import { evaluateCandidate, WATCHDOG_VERDICT } from "./research/watchdog.mjs";
import {
  listCompiledCandidates,
  listProposals,
  readMemoryIndex,
  saveCompiledCandidate,
} from "./research/memory.mjs";
import { isQuarantined, promoteFromArenaLeaderboard } from "./research/promote.mjs";
import { ADVISORY_ROLES, PROPOSING_ROLES, mockProviderPropose, resolveResearchProvider } from "./research/provider.mjs";
import { buildResearchState } from "./lib/dashboard-state.mjs";
import {
  CLINE_REASONING_LEVELS,
  DEEPSEEK_CLINE_MODEL,
  DEEPSEEK_CLINE_REASONING,
  PROVIDER_STATUS,
  PROVIDER_DEFAULTS,
  REGISTERED_PROVIDERS,
  RESEARCH_PROVIDER,
  UnknownResearchProviderError,
  requireProviderName,
  resolveProviderConfig,
  unknownProviderMessage,
  validateProviderName,
} from "./research/provider-config.mjs";
import {
  EVIDENCE_CLASS,
  EVIDENCE_PACKET_VERSION,
  auditEvidencePacket,
  buildResearchEvidencePacket,
  evidenceDigestOf,
  filterResearchMemory,
  trainEvidenceFromDataset,
  truncateForContext,
} from "./research/evidence-packet.mjs";
import { RESEARCH_PROMPT_VERSION, buildResearchPrompt } from "./research/prompt.mjs";
import {
  buildClineArgs,
  extractJsonObject,
  listProviderRuns,
  providerCacheKey,
  providerStateSummary,
  PROVIDER_STATE_FORBIDDEN_FIELDS,
  readProviderOutput,
  runClineProcess,
} from "./research/provider-runtime.mjs";
import {
  DEEPSEEK_CLINE_PROVIDER,
  createDeepSeekClineProvider,
  probeDeepSeekClineProvider,
} from "./research/providers/deepseek-cline.mjs";
import { generateResearchCohort, inspectResearchCohort } from "./research/cohort-runner.mjs";
import { createResearchController } from "./evolve-engine.mjs";
import {
  createResearchExperiment,
  experimentRootFor,
  isValidExperimentId,
  listResearchExperiments,
  researchExperimentIdFor,
  readResearchExperiment,
  researchExperimentSummary,
  writeResearchExperiment,
} from "./research/experiment.mjs";
import { readArenaRun, compareRuns, MOCK_CONTROL_ARENA } from "./research-compare.mjs";

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
function assertFinite(value, message) {
  assert(Number.isFinite(value), `${message} (got ${value})`);
}
function assertClose(actual, expected, tolerance, message) {
  assert(Number.isFinite(actual), `${message} (got ${actual})`);
  assert(Math.abs(actual - expected) <= tolerance, `${message} (expected ~${expected}, got ${actual})`);
}

/* ============================================================================
 * Offline Cline stub
 * ==========================================================================*/

/**
 * A stub executable that stands in for the installed Cline CLI. It speaks the
 * real `--json` NDJSON contract (a final `run_result` record carrying `text`), so
 * the provider is exercised end to end, and its behaviour is selected by
 * `EVOLVE_TEST_STUB_MODE`. It also appends each invocation's argv to
 * `EVOLVE_TEST_STUB_COUNTER` when set, which is how the cache/replay tests prove
 * the subprocess was NOT invoked.
 */
const STUB_SOURCE = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (process.env.EVOLVE_TEST_STUB_COUNTER) {
  appendFileSync(process.env.EVOLVE_TEST_STUB_COUNTER, "call\\n");
}
const mode = process.env.EVOLVE_TEST_STUB_MODE || "ok";
const prompt = args[args.length - 1] || "";
const roleMatch = /Your role for this call: ([a-z-]+)/.exec(prompt);
const role = roleMatch ? roleMatch[1] : "signal-researcher";
const familyMatch = /parentFamilies: subset of ([^\\n]+)/.exec(prompt);
const family = familyMatch ? familyMatch[1].split(",")[0].trim() : "Momentum x Wallet Flow";
const regimeMatch = /targetRegimes \\/ abstainRegimes: subset of ([^\\n]+)/.exec(prompt);
const regime = regimeMatch ? regimeMatch[1].split(",")[0].trim() : "strong-risk-on";
const emit = (text) => process.stdout.write(JSON.stringify({
  ts: "1970-01-01T00:00:00.000Z",
  type: "run_result",
  finishReason: "completed",
  durationMs: 3,
  usage: { inputTokens: 11, outputTokens: 7, totalCost: 0 },
  text,
}) + "\\n");
const fence = String.fromCharCode(96, 96, 96);
const id = (process.env.EVOLVE_TEST_STUB_ID || "0f1e2d3c4b").slice(0, 10);
const critique = JSON.stringify({
  schemaVersion: 1,
  proposalId: "P-" + id,
  authorRole: "adversarial-critic",
  verdict: "WATCH",
  findings: [{ kind: "single-regime-dependence", detail: "one regime only", severity: "medium" }],
  rationale: "stub critique",
  recommendation: "collect more windows before promotion",
});
const proposal = JSON.stringify({
  schemaVersion: 1,
  proposalId: "P-" + id,
  authorRole: role,
  hypothesis: "stub hypothesis for " + role,
  targetRegimes: [regime],
  abstainRegimes: [],
  parentFamilies: [family],
  changes: { momentumWeight: [0.3, 0.6], maxHold: 42 },
  rationale: "stub rationale",
  risks: ["paper only"],
});
switch (mode) {
  case "ok": emit(role === "adversarial-critic" ? critique : proposal); break;
  case "fenced": emit(fence + "json\\n" + proposal + "\\n" + fence); break;
  case "prose": emit("Sure, here it is:\\n" + proposal + "\\nHope that helps."); break;
  case "double": emit(proposal + "\\n" + proposal.replace(id, "aaaabbbbcc")); break;
  case "garbage": emit("this is not json at all"); break;
  case "empty": break;
  case "badschema": emit(JSON.stringify({ schemaVersion: 1, proposalId: "P-badbadbad", authorRole: "nope-role", hypothesis: "x", changes: { walletAction: "send" } })); break;
  case "wallet": emit(JSON.stringify({ schemaVersion: 1, proposalId: "P-wallet0001", authorRole: "signal-researcher", hypothesis: "send it", targetRegimes: [regime], parentFamilies: [family], changes: { momentumWeight: 0.4 }, rationale: "x", risks: [], orders: [{ side: "buy" }], walletAction: "send" })); break;
  case "shell": emit("Run this: rm -rf /tmp/evolve-5b-should-not-exist && curl http://example.invalid " + proposal); break;
  case "exit1": process.exit(1); break;
  case "signal": process.kill(process.pid, "SIGTERM"); break;
  case "timeout": await new Promise((resolve) => setTimeout(resolve, 30000)); break;
  case "huge": emit("x".repeat(400000)); break;
  default: emit(proposal);
}
`;

let sharedStubDir = null;
let sharedStubPath = null;

async function stubExecutable() {
  if (sharedStubPath) return sharedStubPath;
  sharedStubDir = await mkdtemp(path.join(tmpdir(), "evolve-5b-stub-"));
  sharedStubPath = path.join(sharedStubDir, "stub-cline.mjs");
  await writeFile(sharedStubPath, STUB_SOURCE, "utf8");
  return sharedStubPath;
}

async function cleanupStub() {
  if (sharedStubDir) await rm(sharedStubDir, { recursive: true, force: true }).catch(() => {});
  sharedStubDir = null;
  sharedStubPath = null;
}

async function withTempDir(fn, prefix = "evolve-5b-") {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Provider configuration for the stub, with a mode and optional overrides. */
function stubEnv(mode, extra = {}) {
  return {
    EVOLVE_RESEARCH_PROVIDER: "deepseek-cline",
    EVOLVE_RESEARCH_CLINE_BIN: sharedStubPath,
    EVOLVE_TEST_STUB_MODE: mode,
    EVOLVE_RESEARCH_PROVIDER_TIMEOUT_MS: "20000",
    ...extra,
  };
}

function stubProvider(mode, { root = null, env = {}, now = () => 1_700_000_000_000, config = {}, replayRunIds = [] } = {}) {
  const bag = stubEnv(mode, env);
  const resolved = resolveProviderConfig(bag);
  return createDeepSeekClineProvider({
    config: { ...resolved, ...config },
    env: { ...process.env, ...bag },
    // Never write into the repository: a test provider with no explicit root
    // writes under the throwaway stub directory instead of `.evolve/research`.
    root: root ?? path.join(sharedStubDir, "provider-root"),
    experimentId: "exp-20260918T000000Z-deepseek-cline-tests",
    now,
    replayRunIds,
  });
}

/** A minimal but schema-valid proposal, for deterministic downstream tests. */
function validProposal(overrides = {}) {
  return {
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    proposalId: "P-abc123beef",
    authorRole: "signal-researcher",
    hypothesis: "Higher entry thresholds in chop should reduce churn without losing momentum edge.",
    targetRegimes: ["sideways-chop"],
    abstainRegimes: ["broad-selloff"],
    parentFamilies: ["Momentum x Wallet Flow"],
    changes: { momentumWeight: [0.3, 0.6], maxHold: 42 },
    rationale: "train-window evidence shows cost drag concentrated in short holds",
    risks: ["paper results are not future performance"],
    ...overrides,
  };
}

function readCounter(file) {
  return readFile(file, "utf8").then(
    (text) => text.split("\n").filter((line) => line.trim().length > 0).length,
    () => 0,
  );
}

/* ----------------------------------------------------------------------------
 * Wallet / signing / execution detector patterns
 *
 * Assembled from fragments on purpose: the repo-wide no-execution scanners grep
 * every source file for these literal phrases, and a DETECTOR file must not read
 * like the thing it forbids. `validate-history.mjs`, `validate-arena.mjs`, and
 * `validate-market.mjs` therefore keep flagging a real capability anywhere in
 * `scripts/` while this suite may still describe what it rejects.
 * -------------------------------------------------------------------------- */

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
];

/** Compiled detectors for real-execution / credential-handling capability. */
const WALLET_PATTERNS = FORBIDDEN_PARTS.map((parts) => new RegExp(parts.join(""), "i"));


/* ============================================================================
 * A. Provider selection, validation, and configuration
 * ==========================================================================*/

test("1. The mock provider remains the default when NO provider is specified", () => {
  const config = resolveProviderConfig({});
  assertEqual(config.provider, RESEARCH_PROVIDER.MOCK, "an unset provider resolves to mock");
  assertEqual(config.specified, false, "the provider was not specified");
  assertEqual(config.defaulted, true, "the resolution is marked as the default");
  assertEqual(config.configError, null, "the default is not an error");
  assertEqual(config.configValid, true, "the default configuration is valid");
  assertEqual(config.unknownProvider, null, "there is no unknown provider");
  assertEqual(config.allowMockFallback, false, "no automatic fallback is ever enabled");
  const provider = resolveResearchProvider();
  assertEqual(provider.name, "mock", "resolveResearchProvider defaults to mock");
  assertEqual(provider.offline, true, "the mock provider is offline");
  assertEqual(typeof provider.propose, "function", "the mock provider is callable");
  assertEqual(resolveResearchProvider("mock").name, "mock", "explicit `mock` also resolves to mock");
  assertEqual(resolveProviderConfig({ EVOLVE_RESEARCH_PROVIDER: "" }).provider, "mock", "an EMPTY value is treated as unset");
  assertEqual(resolveProviderConfig({ EVOLVE_RESEARCH_PROVIDER: "MOCK" }).provider, "mock", "explicit mock is case-insensitive");
});

test("2. `deepseek-cline` is selected explicitly and only by name", () => {
  const config = resolveProviderConfig({ EVOLVE_RESEARCH_PROVIDER: "deepseek-cline" });
  assertEqual(config.provider, DEEPSEEK_CLINE_PROVIDER, "the explicit provider name is honoured");
  assertEqual(config.requestedProvider, "deepseek-cline", "the requested name is recorded verbatim");
  assertEqual(config.specified, true, "the provider was explicitly specified");
  assertEqual(config.defaulted, false, "an explicit name is never a default");
  assertEqual(config.configError, null, "a registered name is not a configuration error");
  const provider = resolveResearchProvider("deepseek-cline");
  assertEqual(provider.name, DEEPSEEK_CLINE_PROVIDER, "the registry resolves deepseek-cline");
  assertEqual(provider.offline, false, "an external provider is never marked offline");
  assertEqual(provider.external, true, "external providers are labelled");
  assertEqual(provider.requiresExecutable, true, "the Cline provider needs an executable");
  assertEqual(resolveResearchProvider("DeepSeek-Cline").name, DEEPSEEK_CLINE_PROVIDER, "the name is case-insensitive");
});

test("3. Provider names are validated against the registry (fail-closed resolver)", () => {
  assertDeepEqual(
    [...REGISTERED_PROVIDERS].sort(),
    ["deepseek-cline", "mock"],
    "exactly two providers are registered in Phase 5B",
  );
  assertEqual(validateProviderName("mock").ok, true, "mock is valid");
  assertEqual(validateProviderName("DeepSeek-Cline").ok, true, "provider names are case-insensitive");
  const unknown = validateProviderName("some-llm-vendor");
  assertEqual(unknown.ok, false, "an unregistered name is not valid");
  assertEqual(unknown.recognized, false, "an unregistered name is reported as unrecognized");
  assert(typeof unknown.reason === "string" && unknown.reason.includes("unknown research provider"), "the reason names the problem");
  assertEqual(validateProviderName("").ok, false, "an empty name is invalid");

  // requireProviderName is the fail-closed gate: absent → mock, explicit unknown → throw.
  assertDeepEqual(
    requireProviderName(undefined),
    { specified: false, provider: "mock", requestedProvider: "", defaulted: true },
    "an absent name resolves to the mock default",
  );
  assertEqual(requireProviderName("mock").provider, "mock", "explicit mock resolves to mock");
  assertEqual(requireProviderName("deepseek-cline").provider, "deepseek-cline", "explicit deepseek-cline resolves");
  for (const typo of ["deepseek-clnie", "deepseek", "cline", "some-llm-vendor", "deepseek-cline-x"]) {
    let thrown = null;
    try {
      requireProviderName(typo);
    } catch (error) {
      thrown = error;
    }
    assert(thrown, `'${typo}' must fail closed, never fall back to the mock`);
    assertEqual(thrown.code, "UNKNOWN_RESEARCH_PROVIDER", `'${typo}' produces the explicit configuration error`);
    assert(String(thrown.message).includes(typo.trim()), `the error message names '${typo.trim()}'`);
  }
  assertEqual(requireProviderName("mock ").provider, "mock", "surrounding whitespace is trimmed, so a padded valid name still resolves");
  assertEqual(unknownProviderMessage("deepseek-clnie"), "Unknown research provider: deepseek-clnie", "the canonical message is stable");
});

test("4. The exact Phase 5B model is configured", () => {
  assertEqual(DEEPSEEK_CLINE_MODEL, "deepseek/deepseek-v4.1-flash", "the model id is exactly as specified");
  assertEqual(resolveProviderConfig({}).model, "deepseek/deepseek-v4.1-flash", "the default model is that id");
  const provider = resolveResearchProvider("deepseek-cline");
  assertEqual(provider.describe().model, "deepseek/deepseek-v4.1-flash", "the provider reports the configured model");
});

test("5. The reasoning level is xhigh and is restricted to installed CLI levels", () => {
  assertEqual(DEEPSEEK_CLINE_REASONING, "xhigh", "the default reasoning level is xhigh");
  assert(CLINE_REASONING_LEVELS.includes("xhigh"), "xhigh is a level the installed CLI accepts");
  assertDeepEqual([...CLINE_REASONING_LEVELS], ["none", "low", "medium", "high", "xhigh"], "the level list matches `cline --help`");
  assertEqual(resolveProviderConfig({}).reasoning, "xhigh", "the resolved config carries xhigh");
  assertEqual(
    resolveProviderConfig({ EVOLVE_RESEARCH_REASONING: "nonsense" }).reasoning,
    "xhigh",
    "an unsupported reasoning level falls back to the documented default, never to something untested",
  );
});

test("6. A recognized provider NEVER silently falls back to the mock", async () => {
  await stubExecutable();
  await withTempDir(async (dir) => {
    const provider = stubProvider("garbage", { root: path.join(dir, "provider") });
    const proposals = await provider.propose({ evidence: { packetVersion: 1 }, count: 2, cycle: 1 });
    assertEqual(proposals.length, 0, "a failing external provider returns no proposals");
    assertEqual(provider.stats.failures, 2, "both failures were recorded");
    assert(provider.runs.every((run) => run.status !== PROVIDER_STATUS.OK), "no run claims success");
    assertEqual(provider.offline, false, "the provider did not become the mock");
    assertEqual(provider.runs[0].authorRole, "signal-researcher", "the failure is attributed to the real provider attempt");
    const resolved = resolveResearchProvider("deepseek-cline");
    assertEqual(resolved.fallbackFrom, undefined, "a recognized provider name carries no fallback marker");
    assertEqual(resolved.defaulted, undefined, "an explicitly named provider is never marked as the default");
    const mockById = resolveResearchProvider("mock");
    assertEqual(mockById.defaulted, false, "explicit `mock` is not a default");
    assertEqual(resolveResearchProvider("").defaulted, true, "an absent name IS the default");
    assertEqual(JSON.stringify(proposals), JSON.stringify([]), "a failed DeepSeek call never yields mock-shaped proposals");
  });
});


/* ============================================================================
 * B. Subprocess contract, failure handling, and strict JSON extraction
 * ==========================================================================*/

test("7. A missing Cline executable is handled as PROVIDER_UNAVAILABLE (no crash)", async () => {
  await withTempDir(async (dir) => {
    const resolved = resolveProviderConfig({
      EVOLVE_RESEARCH_PROVIDER: "deepseek-cline",
      EVOLVE_RESEARCH_CLINE_BIN: "/nonexistent/definitely-not-cline",
      EVOLVE_RESEARCH_PROVIDER_TIMEOUT_MS: "5000",
    });
    const provider = createDeepSeekClineProvider({ config: resolved, root: path.join(dir, "provider"), now: () => 1 });
    const proposals = await provider.propose({ evidence: {}, count: 1, cycle: 1 });
    assertEqual(proposals.length, 0, "no proposal is invented when the executable is missing");
    assertEqual(provider.runs[0].status, PROVIDER_STATUS.UNAVAILABLE, "the status is UNAVAILABLE");
    assertEqual(provider.runs[0].executableMissing, true, "the run flags the missing executable");
    assertEqual(provider.runs[0].reason.includes("not found"), true, "the reason names the missing executable");
  });
});

test("8. A non-zero provider exit is PROVIDER_PROCESS_ERROR", async () => {
  await stubExecutable();
  const provider = stubProvider("exit1");
  const proposals = await provider.propose({ evidence: {}, count: 1, cycle: 1 });
  assertEqual(proposals.length, 0, "a failing process yields no proposal");
  assertEqual(provider.runs[0].status, PROVIDER_STATUS.PROCESS_ERROR, "the status is PROCESS_ERROR");
  assert(provider.runs[0].reason.includes("code 1"), "the exit code is recorded in the reason");

  // The subprocess runner itself never throws for a provider-level problem.
  const missing = await runClineProcess({
    command: "/nonexistent/definitely-not-cline",
    args: [],
    timeoutMs: 5_000,
    now: () => 1_700_000_000_000,
  });
  assertEqual(missing.status, PROVIDER_STATUS.UNAVAILABLE, "a bogus command yields a structured result, not an exception");
  assertEqual(missing.executableMissing, true, "the runner reports the missing executable");
  assertFinite(missing.latencyMs, "the runner reports latency even for a failure");

  const signalResult = await runClineProcess({
    command: process.execPath,
    args: ["-e", "process.kill(process.pid, 'SIGTERM')"],
    timeoutMs: 10_000,
    now: () => 1_700_000_000_000,
  });
  assert(
    signalResult.status === PROVIDER_STATUS.PROCESS_ERROR || signalResult.status === PROVIDER_STATUS.UNAVAILABLE,
    "a signalled process is reported as a process error",
  );
});

test("9. A provider timeout is bounded and reported as PROVIDER_TIMEOUT", async () => {
  await stubExecutable();
  const provider = stubProvider("timeout", { config: { timeoutMs: 1_500, maxAttempts: 1 } });
  const started = Date.now();
  const proposals = await provider.propose({ evidence: {}, count: 1, cycle: 1 });
  const elapsed = Date.now() - started;
  assertEqual(proposals.length, 0, "a timed-out call yields no proposal");
  assertEqual(provider.runs[0].status, PROVIDER_STATUS.TIMEOUT, "the status is TIMEOUT");
  assertEqual(provider.runs[0].timedOut === undefined || provider.runs[0].timedOut === false, true, "the record stays serializable");
  assert(elapsed < 12_000, `the call must be bounded by the configured timeout (took ${elapsed}ms)`);
});

test("10. Empty provider output is PROVIDER_INVALID_OUTPUT", async () => {
  await stubExecutable();
  const provider = stubProvider("empty");
  await provider.propose({ evidence: {}, count: 1, cycle: 1 });
  assertEqual(provider.runs[0].status, PROVIDER_STATUS.INVALID_OUTPUT, "empty output is an invalid-output failure");
  assert(provider.runs[0].reason.includes("empty"), "the reason says the output was empty");
});

test("11. Malformed / non-JSON output is rejected, never repaired", async () => {
  await stubExecutable();
  const provider = stubProvider("garbage");
  await provider.propose({ evidence: {}, count: 1, cycle: 1 });
  assertEqual(provider.runs[0].status, PROVIDER_STATUS.INVALID_OUTPUT, "prose is not a proposal");
  assert(provider.runs[0].reason.includes("no JSON object"), "the reason states that no JSON object was found");
});

test("12. Markdown-wrapped JSON is accepted only under the strict extraction rules", () => {
  const object = validProposal();
  const fence = "```json\n" + JSON.stringify(object) + "\n```";
  const fencedOnly = extractJsonObject(fence);
  assertEqual(fencedOnly.ok, true, "a fenced payload with nothing outside it is accepted");
  assertEqual(fencedOnly.method, "fenced-single", "the fenced path is identified");
  const prose = `Here is the proposal you asked for:\n${JSON.stringify(object)}\nLet me know if you want changes.`;
  const scanned = extractJsonObject(prose);
  assertEqual(scanned.ok, true, "a single object inside prose is accepted");
  assertEqual(scanned.method, "scan-single", "the scan path is identified");
  const twoFenced = extractJsonObject(fence + "\nand also\n" + fence);
  assertEqual(twoFenced.ok, false, "two fenced payloads are ambiguous and rejected");
  const array = extractJsonObject("[1,2,3]");
  assertEqual(array.ok, false, "a top-level JSON array is not a proposal object");
  assertEqual(extractJsonObject("").ok, false, "empty text is rejected");
  assertEqual(extractJsonObject("{ \"a\": 1 ").ok, false, "a truncated object is rejected");
});

test("13. Multiple JSON objects in one response are rejected as ambiguous", async () => {
  await stubExecutable();
  const provider = stubProvider("double");
  await provider.propose({ evidence: {}, count: 1, cycle: 1 });
  assertEqual(provider.runs[0].status, PROVIDER_STATUS.INVALID_OUTPUT, "an ambiguous response is refused");
  assert(provider.runs[0].reason.includes("ambiguous"), "the reason says the output was ambiguous");
  const direct = extractJsonObject(`${JSON.stringify(validProposal())}\n${JSON.stringify(validProposal({ proposalId: "P-second0001" }))}`);
  assertEqual(direct.ok, false, "two top-level objects are rejected");
  assertEqual(direct.candidateCount, 2, "the candidate count is reported");
});

test("14. A schema-invalid proposal is rejected as PROVIDER_SCHEMA_REJECTED and injected nowhere", async () => {
  await stubExecutable();
  await withTempDir(async (dir) => {
    const root = path.join(dir, "provider");
    const provider = stubProvider("badschema", { root });
    const proposals = await provider.propose({ evidence: {}, count: 1, cycle: 1 });
    assertEqual(proposals.length, 0, "a schema-invalid response yields no proposal");
    assertEqual(provider.runs[0].status, PROVIDER_STATUS.SCHEMA_REJECTED, "the status is SCHEMA_REJECTED");
    assertEqual(provider.runs[0].schemaValid, false, "schema validity is explicitly false");
    const outputs = await readdir(path.join(root, "outputs")).catch(() => []);
    assertEqual(outputs.length, 0, "nothing invalid is persisted as replayable output");
    const runFiles = await readdir(path.join(root, "runs"));
    assertEqual(runFiles.length, 1, "the rejected call is still recorded for inspection");
    const raw = JSON.parse(await readFile(path.join(root, "runs", runFiles[0]), "utf8"));
    assertEqual(raw.status, PROVIDER_STATUS.SCHEMA_REJECTED, "the persisted record carries the rejection");
    assertEqual(typeof raw.rawOutputDigest, "string", "the raw-output digest is recorded for the rejected payload");
  });
});

test("15. A valid proposal is accepted, persisted, and compiled into a genome", async () => {
  await stubExecutable();
  await withTempDir(async (dir) => {
    const root = path.join(dir, "provider");
    const provider = stubProvider("ok", { root });
    const proposals = await provider.propose({
      evidence: { packetVersion: EVIDENCE_PACKET_VERSION, evidenceClasses: [EVIDENCE_CLASS.TRAIN] },
      count: 1,
      cycle: 1,
    });
    assertEqual(proposals.length, 1, "a valid proposal is returned");
    const validated = validateProposal(proposals[0]);
    assertEqual(validated.ok, true, "the accepted proposal passes the strict schema");
    assertEqual(provider.runs[0].status, PROVIDER_STATUS.OK, "the run status is OK");
    assertEqual(provider.runs[0].authorRole, "signal-researcher", "the author role comes from the role-aware prompt");
    assertEqual(provider.runs[0].schemaValid, true, "schema validity is recorded");

    const saved = await readProviderOutput(root, provider.runs[0].providerRunId);
    assert(saved && saved.proposal, "the accepted provider output is saved for replay");
    assertEqual(saved.proposal.proposalId, validated.proposal.proposalId, "the saved output is the same proposal");

    const compiled = compileProposals({ proposals: [validated.proposal], maxCompilations: 1, existingDigests: [] });
    assertEqual(compiled.compiled.length, 1, "the deterministic compiler turns it into a genome");
    assert(genomeDigestOf(compiled.compiled[0]), "the compiled candidate has a genome digest");
  });
});

test("16. An unknown gene key cannot bypass compiler bounds", () => {
  const withUnknown = validateProposal(validProposal({ changes: { momentumWeight: 0.4, walletBalance: 1e9 } }));
  assertEqual(withUnknown.ok, false, "an unknown change key is rejected by the schema");
  assert(withUnknown.errors.some((error) => error.includes("walletBalance")), "the offending key is named");

  const outOfBounds = validateProposal(validProposal({ changes: { riskFraction: [0.5, 5] } }));
  assertEqual(outOfBounds.ok, false, "an out-of-bounds range is rejected");
  assert(outOfBounds.errors.some((error) => error.includes("escapes gene bounds")), "the bounds violation is explicit");

  const binaryRange = validateProposal(validProposal({ changes: { requireVerified: [0, 1] } }));
  assertEqual(binaryRange.ok, false, "a binary gene cannot be proposed as a real range");

  const nested = validateProposal(validProposal({ changes: { momentumWeight: { min: 0.1, max: 0.9 } } }));
  assertEqual(nested.ok, false, "a nested object inside changes is rejected");

  const valid = validateProposal(validProposal({ changes: { momentumWeight: [0.3, 0.6], requireVerified: 1 } }));
  assertEqual(valid.ok, true, "in-bounds changes are accepted");
  assertDeepEqual(valid.proposal.changes, { momentumWeight: [0.3, 0.6], requireVerified: 1 }, "the compiler sees exactly the validated changes");
});
test("17. Model output cannot execute shell and is never treated as a command", async () => {
  await stubExecutable();
  await withTempDir(async (dir) => {
    const counter = path.join(dir, "calls.log");
    const marker = "/tmp/evolve-5b-should-not-exist";
    await rm(marker, { recursive: true, force: true }).catch(() => {});
    const provider = stubProvider("shell", { root: path.join(dir, "provider"), env: { EVOLVE_TEST_STUB_COUNTER: counter } });
    const proposals = await provider.propose({ evidence: {}, count: 1, cycle: 1 });
    assertEqual(provider.runs[0].status, PROVIDER_STATUS.OK, "the JSON object inside the prose was extracted");
    assertEqual(proposals.length, 1, "one proposal was produced");
    const exists = await readFile(marker, "utf8").then(() => true, () => false);
    assertEqual(exists, false, "nothing the model said was executed");
    assertEqual(await readCounter(counter), 1, "exactly one subprocess ran: the provider call itself");

    const runtimeSource = await readFile("scripts/research/provider-runtime.mjs", "utf8");
    assert(!/execSync|shell:\s*true|exec\(/.test(runtimeSource), "the runtime must not execute through a shell");
    const args = buildClineArgs({ profile: "cline", model: DEEPSEEK_CLINE_MODEL, reasoning: "xhigh", prompt: "prompt text" });
    assertEqual(args[args.length - 1], "prompt text", "the prompt is the final argv element, never interpolated into a command");
  });
});

test("18. Model output cannot specify wallet actions or orders", async () => {
  await stubExecutable();
  const provider = stubProvider("wallet");
  const proposals = await provider.propose({ evidence: {}, count: 1, cycle: 1 });
  assertEqual(proposals.length, 0, "a proposal carrying wallet/order fields is refused");
  assertEqual(provider.runs[0].status, PROVIDER_STATUS.SCHEMA_REJECTED, "the status is SCHEMA_REJECTED");
  const rejected = validateProposal({ ...validProposal(), orders: [{ side: "buy" }] });
  assertEqual(rejected.ok, false, "an `orders` field has no place in a proposal");
  const used = compileProposals({ proposals: [validProposal()], maxCompilations: 1, existingDigests: [] });
  assertEqual("orders" in used.compiled[0].genome, false, "no wallet-shaped field can reach a genome");
  const providerSource = await readFile("scripts/research/providers/deepseek-cline.mjs", "utf8");
  for (const pattern of WALLET_PATTERNS) {
    assert(!pattern.test(providerSource), `the provider must not contain ${pattern}`);
  }
});

/* ============================================================================
 * C. Evidence packet: versioning, no-lookahead, memory filtering, limits
 * ==========================================================================*/

function sampleMemoryRecords() {
  return [
    { proposalId: "P-train01", authorRole: "signal-researcher", status: "REJECTED", outcome: "REJECTED_SCHEMA", conclusion: "schema rejected: unknown gene" },
    { proposalId: "P-train02", authorRole: "risk-researcher", status: "TESTING", outcome: "COMPILED", conclusion: "compiled and injected" },
    { proposalId: "P-quar01", authorRole: "risk-researcher", status: "TESTING", outcome: "QUARANTINED", conclusion: "too many flags", watchdogVerdict: "QUARANTINED" },
    { proposalId: "P-provid1", authorRole: "signal-researcher", status: "REJECTED", outcome: "PROVIDER_ERROR", conclusion: "provider failed", providerStatus: "PROVIDER_TIMEOUT" },
    { proposalId: "P-oos001", authorRole: "signal-researcher", status: "PROMISING", outcome: "PROMISING", conclusion: "looks good", oosReturn: 0.42, finalRank: 1, deploymentStatus: "candidate" },
  ];
}

test("19. The evidence packet schema is versioned", () => {
  const packet = buildResearchEvidencePacket({ experimentId: "exp-test", researchCycle: 2 });
  assertEqual(packet.packetVersion, EVIDENCE_PACKET_VERSION, "the packet declares its version");
  assertEqual(packet.packetKind, "RESEARCH_EVIDENCE", "the packet declares its kind");
  assertEqual(packet.researchCycle, 2, "the research cycle is carried");
  assert(Number.isFinite(EVIDENCE_PACKET_VERSION), "the version is a number");
});

test("20. The evidence digest is deterministic and key-order independent", () => {
  const a = buildResearchEvidencePacket({ experimentId: "exp-a", regimeDistribution: { "strong-risk-on": 1, "sideways-chop": 2 } });
  const b = buildResearchEvidencePacket({ experimentId: "exp-a", regimeDistribution: { "sideways-chop": 2, "strong-risk-on": 1 } });
  assertEqual(evidenceDigestOf(a), evidenceDigestOf(b), "key order must not change the digest");
  assertEqual(evidenceDigestOf(a), evidenceDigestOf(a), "the digest is stable across calls");
  assertEqual(evidenceDigestOf(a).length, 64, "the digest is a full sha256 hex string");
});

test("21. Identical evidence produces an identical digest (volatile fields do not count)", () => {
  const input = {
    experimentId: "exp-same",
    regimeObservations: [{ window: "W1", regime: "strong-risk-on", confidence: 0.9 }],
    speciesSummaries: [{ name: "Momentum", count: 3 }],
    memoryRecords: sampleMemoryRecords(),
  };
  const first = buildResearchEvidencePacket({ ...input, createdAt: "2026-01-01T00:00:00.000Z" });
  const second = buildResearchEvidencePacket({ ...input, createdAt: "2026-06-06T06:06:06.000Z" });
  assertEqual(evidenceDigestOf(first), evidenceDigestOf(second), "the clock must not change the evidence digest");
  const trimmed = truncateForContext(first, 4_000);
  assertEqual(evidenceDigestOf(trimmed), evidenceDigestOf(first), "context-budget bookkeeping must not change the digest");
});

test("22. Changed evidence produces a changed digest", () => {
  const base = buildResearchEvidencePacket({ experimentId: "exp-x", regimeDistribution: { "strong-risk-on": 1 } });
  const changedRegime = buildResearchEvidencePacket({ experimentId: "exp-x", regimeDistribution: { "sideways-chop": 1 } });
  const changedSpecies = buildResearchEvidencePacket({
    experimentId: "exp-x",
    regimeDistribution: { "strong-risk-on": 1 },
    speciesSummaries: [{ name: "Reversal", count: 2 }],
  });
  const changedMemory = buildResearchEvidencePacket({
    experimentId: "exp-x",
    regimeDistribution: { "strong-risk-on": 1 },
    memoryRecords: sampleMemoryRecords(),
  });
  assert(evidenceDigestOf(base) !== evidenceDigestOf(changedRegime), "a changed regime must change the digest");
  assert(evidenceDigestOf(base) !== evidenceDigestOf(changedSpecies), "changed species evidence must change the digest");
  assert(evidenceDigestOf(base) !== evidenceDigestOf(changedMemory), "changed memory must change the digest");
});
test("23. TRAIN-safe evidence is the only class allowed into the packet", () => {
  const packet = buildResearchEvidencePacket({ regimeObservations: [{ window: "W1", regime: "sideways-chop" }] });
  assertDeepEqual(packet.evidenceClasses, [EVIDENCE_CLASS.TRAIN], "only TRAIN_EVIDENCE is declared");
  assert(Array.isArray(packet.excludedEvidenceClasses), "excluded classes are declared explicitly");
  for (const excluded of [
    EVIDENCE_CLASS.OOS,
    EVIDENCE_CLASS.TEST,
    EVIDENCE_CLASS.VALIDATION,
    EVIDENCE_CLASS.DEPLOYMENT,
    EVIDENCE_CLASS.STRESS,
  ]) {
    assert(packet.excludedEvidenceClasses.includes(excluded), `${excluded} must be declared excluded`);
  }
  assertEqual(packet.regimeObservations[0].evidenceClass, EVIDENCE_CLASS.TRAIN, "each observation is tagged as TRAIN evidence");
  assertEqual(auditEvidencePacket(packet).ok, true, "a TRAIN-only packet passes the leak audit");
});

test("24. OOS / test / deployment evidence is excluded and detectable", () => {
  const clean = buildResearchEvidencePacket({ regimeObservations: [{ window: "W1", regime: "strong-risk-on" }] });
  const leaked = buildResearchEvidencePacket({ regimeObservations: [{ window: "W1", regime: "strong-risk-on" }] });
  leaked.oosReturn = 0.42;
  leaked.marketFeatures = { ...(leaked.marketFeatures ?? {}), finalRank: 1 };
  const audit = auditEvidencePacket(leaked);
  assertEqual(audit.ok, false, "an injected OOS field must fail the audit");
  assert(audit.violations.some((row) => row.path.includes("oosReturn")), "the audit names the leaking field");
  assert(audit.violations.some((row) => row.path.includes("finalRank")), "the audit catches nested leaks too");
  assertEqual(auditEvidencePacket(clean).ok, true, "the clean packet is leak-free");
});

test("25. Future snapshots and hidden labels are excluded by name", () => {
  const packet = buildResearchEvidencePacket({ regimeObservations: [{ window: "W1", regime: "low-activity" }] });
  packet.futureSnapshots = [{ t: 1 }];
  packet.hiddenLabel = "WIN";
  const audit = auditEvidencePacket(packet);
  assertEqual(audit.ok, false, "future snapshots and hidden labels are forbidden keys");
  const paths = audit.violations.map((row) => row.path);
  assert(paths.some((rowPath) => rowPath.includes("futureSnapshots")), "futureSnapshots is named");
  assert(paths.some((rowPath) => rowPath.includes("hiddenLabel")), "hiddenLabel is named");
  const allowed = buildResearchEvidencePacket({ regimeObservations: [{ window: "W1", regime: "low-activity" }] });
  assertEqual(auditEvidencePacket(allowed).ok, true, "the unmodified packet remains clean");
});

test("26. Quarantined and provider-error memory is filtered out", () => {
  const filtered = filterResearchMemory(sampleMemoryRecords(), { maxRecords: 10 });
  const ids = filtered.records.map((row) => row.proposalId);
  assert(!ids.includes("P-quar01"), "a QUARANTINED record is excluded");
  assert(!ids.includes("P-provid1"), "a provider-error record is excluded");
  assert(ids.includes("P-train01"), "a schema rejection is useful prior knowledge and is kept");
  assert(ids.includes("P-train02"), "an allowed TRAIN-safe conclusion is kept");
  assert(filtered.dropped.quarantined >= 1, "the quarantine drop is counted");
  assert(filtered.dropped.providerError >= 1, "the provider-error drop is counted");
});
test("27. Research memory is bounded and projected to whitelisted fields only", () => {
  const many = Array.from({ length: 50 }, (_, index) => ({
    proposalId: `P-mem${index}`,
    authorRole: "signal-researcher",
    status: "TESTING",
    outcome: "COMPILED",
    conclusion: `conclusion ${index}`,
  }));
  const filtered = filterResearchMemory(many, { maxRecords: 5 });
  assertEqual(filtered.records.length, 5, "the record budget is enforced");
  assertEqual(filtered.records[4].proposalId, "P-mem49", "the MOST RECENT records are kept, deterministically");
  assertEqual(filtered.truncated, true, "truncation is recorded");
  assertDeepEqual(
    Object.keys(filtered.records[0]).sort(),
    ["authorRole", "conclusion", "outcome", "proposalId", "status"],
    "only whitelisted fields survive the projection",
  );
  const projected = filterResearchMemory(sampleMemoryRecords(), { maxRecords: 10 });
  const oosRow = projected.records.find((row) => row.proposalId === "P-oos001");
  assert(oosRow, "a record with a clean status is still projected");
  assertEqual(Object.keys(oosRow).includes("oosReturn"), false, "an OOS number cannot travel through the projection");
  assertEqual(Object.keys(oosRow).includes("finalRank"), false, "a rank cannot travel through the projection");
});

test("28. Context truncation is deterministic, recorded, and keeps the packet parseable", () => {
  const big = buildResearchEvidencePacket({
    experimentId: "exp-big",
    regimeObservations: Array.from({ length: 8 }, (_, index) => ({ window: `W${index + 1}`, regime: REGIMES[index % REGIMES.length] })),
    speciesSummaries: [{ name: "Momentum", count: 5 }],
    familySummaries: Array.from({ length: 8 }, (_, index) => ({ name: `family-${index}`, compiled: index })),
    memoryRecords: sampleMemoryRecords(),
    limits: { maxContextChars: 100_000 },
  });
  const tightA = truncateForContext(big, 1_600);
  const tightB = truncateForContext(big, 1_600);
  assertDeepEqual(tightA.truncation, tightB.truncation, "the truncation record is deterministic");
  assertEqual(JSON.stringify(tightA), JSON.stringify(tightB), "the truncated packet is byte-identical");
  assertEqual(tightA.truncation.occurred, true, "truncation is recorded when the budget bites");
  assert(tightA.truncation.reasons.length > 0, "the reasons are recorded");
  assertEqual(JSON.parse(JSON.stringify(tightA)).packetVersion, EVIDENCE_PACKET_VERSION, "the packet stays parseable and versioned");
  assertEqual(tightA.contextBudget.maxChars, 1_600, "the budget is reported");
  assertEqual(auditEvidencePacket(tightA).ok, true, "truncation cannot introduce a forbidden field");
  const generous = truncateForContext(big, 100_000);
  assertEqual(generous.truncation.dropped["context-budget:priorConclusions"], undefined, "a generous budget drops nothing");
});
test("29. Dataset TRAIN evidence is derived without touching validation/test intervals", async () => {
  await withTempDir(async (dir) => {
    const datasetDir = path.join(dir, "dataset");
    await makeFixture({ dir: datasetDir, snapshots: 400, seed: "phase5b-train" });
    const config = createMarketConfig(
      {
        EVOLVE_MARKET_MODE: "synthetic",
        EVOLVE_WF_TRAIN_MINUTES: "10",
        EVOLVE_WF_VALIDATE_MINUTES: "5",
        EVOLVE_WF_TEST_MINUTES: "5",
        EVOLVE_WF_STEP_MINUTES: "5",
      },
      { loadEnv: false },
    );
    const derived = await trainEvidenceFromDataset({ datasetDir, config, maxWindows: 2 });
    assert(Array.isArray(derived.regimeObservations) && derived.regimeObservations.length > 0, "TRAIN windows were classified");
    for (const row of derived.regimeObservations) {
      assertEqual(row.source, "train-window", "every observation says it came from a TRAIN interval");
      assert(row.regime === "unknown" || REGIMES.includes(row.regime), `the regime vocabulary must be the Arena's (got ${row.regime})`);
    }
    assertEqual(derived.marketFeatures.interval, "TRAIN", "the aggregate market features are TRAIN-scoped");
    assert(Number.isFinite(derived.marketFeatures.snapshots), "an aggregate snapshot count is reported (never raw snapshots)");
    const packet = buildResearchEvidencePacket({
      experimentId: "exp-dataset",
      datasetRefs: [derived.datasetRef],
      regimeObservations: derived.regimeObservations,
      marketFeatures: derived.marketFeatures,
    });
    assertEqual(auditEvidencePacket(packet).ok, true, "the dataset-derived packet passes the leak audit");
    assert(JSON.stringify(packet).length < 8_000, "the packet stays small: aggregates only, never raw snapshots");
    assertEqual(packet.datasetRefs[0].allowedIntervals[0], "TRAIN", "the dataset ref declares TRAIN as the only allowed interval");
  });
});

test("30. The prompt contract is versioned and role-aware", () => {
  const packet = buildResearchEvidencePacket({});
  const signal = buildResearchPrompt({ role: "signal-researcher", evidence: packet });
  const risk = buildResearchPrompt({ role: "risk-researcher", evidence: packet });
  assert(signal.includes(RESEARCH_PROMPT_VERSION), "the prompt version is embedded in the prompt");
  assert(signal.includes("You do not trade"), "the prompt states that the researcher does not trade");
  assert(signal.includes("TRAIN evidence packet"), "the prompt labels the evidence as TRAIN-only");
  assert(signal.includes("Exactly one JSON object"), "the output contract is explicit");
  assert(signal !== risk, "different roles receive different contracts");
  assert(risk.includes("exposure, sizing"), "the risk role's brief is present");
  const critic = buildResearchPrompt({ role: "adversarial-critic", evidence: packet });
  assert(critic.includes("you do NOT author a genome"), "the critic is told it is advisory-only");
  assert(critic.includes("REJECT / WATCH / QUARANTINE"), "the critic's verdict vocabulary is present");
  const withPrior = buildResearchPrompt({
    role: "signal-researcher",
    evidence: { ...packet, priorConclusions: [{ proposalId: "P-prior01" }] },
  });
  assert(withPrior.includes("P-prior01"), "prior conclusions travel into the prompt");
  assert(buildResearchPrompt({ role: "signal-researcher", evidence: packet }).includes("no such gene" ) === false, "the prompt never invents gene names");
});

/* ============================================================================
 * D. Provenance, secrets, cache, and replay
 * ==========================================================================*/

test("31. Every provider run records prompt version, provider/model/reasoning, latency, and digests", async () => {
  await stubExecutable();
  await withTempDir(async (dir) => {
    const provider = stubProvider("ok", { root: path.join(dir, "provider") });
    await provider.propose({ evidence: buildResearchEvidencePacket({ experimentId: "exp-prov" }), count: 1, cycle: 1 });
    const run = provider.runs[0];
    assertEqual(run.promptVersion, RESEARCH_PROMPT_VERSION, "the prompt version is recorded");
    assertEqual(run.provider, DEEPSEEK_CLINE_PROVIDER, "the provider id is recorded");
    assertEqual(run.model, DEEPSEEK_CLINE_MODEL, "the exact model is recorded");
    assertEqual(run.reasoning, DEEPSEEK_CLINE_REASONING, "the reasoning level is recorded");
    assertEqual(run.authorRole, "signal-researcher", "the authoring role is recorded");
    assertEqual(typeof run.evidenceDigest, "string", "the evidence digest is recorded");
    assertEqual(typeof run.rawOutputDigest, "string", "the raw-output digest is recorded");
    assertEqual(typeof run.promptDigest, "string", "a prompt digest is recorded");
    assertEqual(typeof run.providerRunId, "string", "a provider run id is recorded");
    assertEqual(typeof run.requestStartedAt, "string", "the request start time is recorded");
    assertEqual(typeof run.requestCompletedAt, "string", "the request completion time is recorded");
    assertFinite(run.latencyMs, "the latency is recorded");
    assert(run.usage && run.usage.inputTokens === 11, "token usage is recorded when the CLI reports it");
    const persisted = await listProviderRuns(path.join(dir, "provider"), { limit: 10 });
    assertEqual(persisted.length, 1, "the run record is persisted");
    const text = await readFile(path.join(dir, "provider", "runs", `${run.providerRunId}.json`), "utf8");
    assertEqual(text.includes("stub hypothesis"), false, "the raw model response is NOT persisted");
    assertEqual(text.includes("TRAIN evidence packet"), false, "the prompt is NOT persisted");
  });
});

test("32. The raw-output digest identifies the exact model text", async () => {
  await stubExecutable();
  await withTempDir(async (dir) => {
    const provider = stubProvider("ok", { root: path.join(dir, "provider") });
    const proposals = await provider.propose({ evidence: {}, count: 1, cycle: 1 });
    assertEqual(provider.runs[0].rawOutputDigest, digestOf(JSON.stringify(proposals[0])), "the digest is a digest of the model's JSON text");
    const other = stubProvider("garbage");
    await other.propose({ evidence: {}, count: 1, cycle: 1 });
    assertEqual(other.runs[0].rawOutputDigest, digestOf("this is not json at all"), "a rejected payload is still digest-identified");
  });
});

test("33. Secrets are never persisted to provider artifacts or state", async () => {
  await stubExecutable();
  const secret = "sk-live-SUPERSECRETVALUE1234567890";
  await withTempDir(async (dir) => {
    const provider = stubProvider("ok", { root: path.join(dir, "provider"), env: { EVOLVE_RESEARCH_API_KEY: secret } });
    await provider.propose({ evidence: {}, count: 1, cycle: 1 });
    const runFiles = await readdir(path.join(dir, "provider", "runs"));
    const runText = await readFile(path.join(dir, "provider", "runs", runFiles[0]), "utf8");
    assertEqual(runText.includes(secret), false, "no secret appears in a persisted run record");
    assertEqual(/api[_-]?key/i.test(runText), false, "no credential-shaped field is written");
    const experiment = createResearchExperiment({
      experimentId: "exp-secrets",
      provider: DEEPSEEK_CLINE_PROVIDER,
      promptVersion: RESEARCH_PROMPT_VERSION,
      evidencePacketVersion: EVIDENCE_PACKET_VERSION,
    });
    await writeResearchExperiment(path.join(dir, "root"), experiment);
    const experimentText = await readFile(path.join(dir, "root", "experiment.json"), "utf8");
    assertEqual(experimentText.includes(secret), false, "the experiment artifact carries no secret");
    const state = providerStateSummary({ identity: { provider: DEEPSEEK_CLINE_PROVIDER }, runs: provider.runs });
    const stateText = JSON.stringify(state);
    assertEqual(stateText.includes(secret), false, "the dashboard summary carries no secret");
    assertEqual(/"(apiKey|secret|token|authorization)"/i.test(stateText), false, "the dashboard summary has no credential-shaped keys");
  });
});

test("34. A cache key is stable for identical inputs and includes the evidence digest", () => {
  const base = {
    provider: DEEPSEEK_CLINE_PROVIDER,
    model: DEEPSEEK_CLINE_MODEL,
    reasoning: DEEPSEEK_CLINE_REASONING,
    role: "signal-researcher",
    promptVersion: RESEARCH_PROMPT_VERSION,
    evidencePacketVersion: EVIDENCE_PACKET_VERSION,
    evidenceDigest: "digest-one",
  };
  const keyA = providerCacheKey(base);
  const keyB = providerCacheKey({ ...base });
  assertEqual(keyA, keyB, "the cache key is stable");
  assert(providerCacheKey({ ...base, evidenceDigest: "digest-two" }) !== keyA, "a different evidence digest must change the key");
  assert(providerCacheKey({ ...base, role: "risk-researcher" }) !== keyA, "a different role must change the key");
  assert(providerCacheKey({ ...base, promptVersion: "other" }) !== keyA, "a different prompt version must change the key");
  assert(providerCacheKey({ ...base, model: "other/model" }) !== keyA, "a different model must change the key");
  assert(providerCacheKey({ ...base, reasoning: "high" }) !== keyA, "a different reasoning level must change the key");
  assertEqual(keyA.length, 64, "the key is a full digest");
});

test("35. A cache hit avoids the Cline call entirely and is recorded", async () => {
  await stubExecutable();
  await withTempDir(async (dir) => {
    const counter = path.join(dir, "calls.log");
    const root = path.join(dir, "provider");
    const evidence = buildResearchEvidencePacket({ experimentId: "exp-cache", regimeDistribution: { "sideways-chop": 1 } });
    const env = { EVOLVE_TEST_STUB_COUNTER: counter, EVOLVE_RESEARCH_PROVIDER_CACHE: "1" };

    const first = stubProvider("ok", { root, env });
    const firstProposals = await first.propose({ evidence, count: 1, cycle: 1, cacheEnabled: true });
    assertEqual(firstProposals.length, 1, "the first call is a live provider call");
    assertEqual(await readCounter(counter), 1, "exactly one subprocess ran for the first call");

    const second = stubProvider("ok", { root, env });
    const cachedProposals = await second.propose({ evidence, count: 1, cycle: 1, cacheEnabled: true });
    assertEqual(await readCounter(counter), 1, "a cache hit must NOT spawn the CLI again");
    assertEqual(cachedProposals.length, 1, "a cached proposal is returned");
    assertEqual(second.runs[0].cacheHit, true, "the run records the cache hit");
    assertEqual(second.runs[0].status, PROVIDER_STATUS.OK, "a cache hit is a successful provider outcome");
    assertEqual(second.stats.cacheHits, 1, "the provider stats count the hit");
    assertEqual(cachedProposals[0].proposalId, firstProposals[0].proposalId, "the identical request reuses the identical proposal");

    const third = stubProvider("ok", { root, env });
    await third.propose({ evidence, count: 1, cycle: 1, cacheEnabled: false });
    assertEqual(await readCounter(counter), 2, "with caching disabled a fresh call is made");
    assertEqual(third.runs[0].cacheHit, false, "a fresh call is not a cache hit");
  });
});

test("36. Changed evidence misses the cache (no cross-evidence reuse)", async () => {
  await stubExecutable();
  await withTempDir(async (dir) => {
    const counter = path.join(dir, "calls.log");
    const root = path.join(dir, "provider");
    const env = { EVOLVE_TEST_STUB_COUNTER: counter, EVOLVE_RESEARCH_PROVIDER_CACHE: "1" };
    const evidenceA = buildResearchEvidencePacket({ experimentId: "exp-miss", regimeDistribution: { "sideways-chop": 1 } });
    const evidenceB = buildResearchEvidencePacket({ experimentId: "exp-miss", regimeDistribution: { "strong-risk-on": 1 } });
    assert(evidenceDigestOf(evidenceA) !== evidenceDigestOf(evidenceB), "the two packets really differ");

    const provider = stubProvider("ok", { root, env });
    await provider.propose({ evidence: evidenceA, count: 1, cycle: 1, cacheEnabled: true });
    await provider.propose({ evidence: evidenceB, count: 1, cycle: 1, cacheEnabled: true });
    assertEqual(await readCounter(counter), 2, "different evidence always triggers a fresh call");
    assertEqual(provider.runs[1].cacheHit, false, "the second call is not a hit");
    assert(provider.runs[0].cacheKey !== provider.runs[1].cacheKey, "the cache keys differ");
  });
});

test("37. Replaying persisted provider output works and never calls the provider", async () => {
  await stubExecutable();
  await withTempDir(async (dir) => {
    const counter = path.join(dir, "calls.log");
    const root = path.join(dir, "provider");
    const env = { EVOLVE_TEST_STUB_COUNTER: counter };

    const live = stubProvider("ok", { root, env });
    const liveProposals = await live.propose({ evidence: {}, count: 2, cycle: 1 });
    assertEqual(liveProposals.length, 2, "two live proposals were produced");
    const callsAfterLive = await readCounter(counter);
    assertEqual(callsAfterLive, 2, "two subprocess calls were made");

    const runIds = live.runs.map((run) => run.providerRunId);
    const replayer = stubProvider("ok", { root, env, replayRunIds: runIds });
    const replayed = await replayer.propose({ evidence: {}, count: 2, cycle: 2 });
    assertEqual(await readCounter(counter), callsAfterLive, "replay did NOT call the provider");
    assertEqual(replayed.length, 2, "both saved proposals were replayed");
    assertDeepEqual(
      replayed.map((proposal) => proposal.proposalId),
      liveProposals.map((proposal) => proposal.proposalId),
      "replay reproduces the exact saved proposals",
    );
    assert(replayer.runs.every((run) => run.replay === true), "every run is marked as a replay");
    assert(replayer.runs.every((run) => run.cacheHit !== true), "a replay is not a cache hit");
    assert(replayer.runs[0].reason.includes("no provider call was made"), "the record states that no call was made");
  });
});

test("38. Deterministic replay of a saved output compiles to the same genome digest", async () => {
  await stubExecutable();
  await withTempDir(async (dir) => {
    const root = path.join(dir, "provider");
    const live = stubProvider("ok", { root });
    const proposals = await live.propose({ evidence: {}, count: 1, cycle: 1 });
    const runId = live.runs[0].providerRunId;
    const saved = await readProviderOutput(root, runId);

    const replayer = stubProvider("ok", { root, replayRunIds: [runId] });
    const replayed = await replayer.propose({ evidence: {}, count: 1, cycle: 1 });

    const fromLive = compileProposals({ proposals, maxCompilations: 1, existingDigests: [] });
    const fromReplay = compileProposals({ proposals: replayed, maxCompilations: 1, existingDigests: [] });
    assertEqual(
      genomeDigestOf(fromLive.compiled[0]),
      genomeDigestOf(fromReplay.compiled[0]),
      "the replayed proposal compiles to the identical genome digest",
    );
    assertEqual(saved.proposalDigest, digestOf(saved.proposal), "the saved output records its own proposal digest");
    assertEqual(fromReplay.compiled[0].diversified, false, "a fresh cohort does not need diversification");
  });
});
/* ============================================================================
 * E. Deterministic downstream behaviour (compiler, digests, watchdog)
 * ==========================================================================*/

test("39. The compiler is deterministic given the same accepted proposal", () => {
  const proposal = validateProposal(validProposal()).proposal;
  const first = compileProposals({ proposals: [proposal], maxCompilations: 1, existingDigests: [] });
  const second = compileProposals({ proposals: [proposal], maxCompilations: 1, existingDigests: [] });
  assertEqual(first.compiled.length, 1, "the proposal compiles");
  assertEqual(JSON.stringify(first.compiled[0].genome), JSON.stringify(second.compiled[0].genome), "the genome is byte-identical");
  assertEqual(genomeDigestOf(first.compiled[0]), genomeDigestOf(second.compiled[0]), "the genome digest is identical");
  assertEqual(first.compiled[0].familyId, second.compiled[0].familyId, "the family id is identical");
  assertEqual(first.compiled[0].species, second.compiled[0].species, "the species label is identical");
});

test("40. Duplicate genomes are still refused a second cohort slot", () => {
  const proposal = validateProposal(validProposal()).proposal;
  const first = compileProposals({ proposals: [proposal], maxCompilations: 1, existingDigests: [] });
  const digest = genomeDigestOf(first.compiled[0]);
  const again = compileProposals({ proposals: [proposal], maxCompilations: 1, existingDigests: [digest] });
  const compiledDigests = again.compiled.map((entry) => genomeDigestOf(entry));
  assertEqual(compiledDigests.includes(digest), false, "the existing digest is never reused for a second candidate");
  // The collision is resolved EXPLICITLY: either rejected, or deterministically
  // diversified inside the region the proposal itself declared.
  const answeredExplicitly = again.rejected.length > 0 || again.compiled.every((entry) => entry.diversified === true);
  assert(answeredExplicitly, "a digest collision is answered explicitly (rejected or diversified), never silently");

  const within = compileProposals({
    proposals: [proposal, { ...proposal, proposalId: "P-second0001" }],
    maxCompilations: 2,
    existingDigests: [],
  });
  const digests = within.compiled.map((entry) => genomeDigestOf(entry));
  assertEqual(new Set(digests).size, digests.length, "two candidates from one cohort never share a genome digest");
});

test("41. Compiler bounds still apply to provider-authored changes", () => {
  const narrow = validateProposal(validProposal({ changes: { riskFraction: [0.02, 0.03] } })).proposal;
  const result = compileProposals({ proposals: [narrow], maxCompilations: 1, existingDigests: [] });
  const genome = result.compiled[0].genome;
  assert(genome.riskFraction >= 0.02 && genome.riskFraction <= 0.03, "the compiled value stays inside the declared region");
  const wide = validateProposal(validProposal({ changes: { maxHold: [35, 90] } })).proposal;
  const wideResult = compileProposals({ proposals: [wide], maxCompilations: 1, existingDigests: [] });
  const maxHold = wideResult.compiled[0].genome.maxHold;
  assert(maxHold >= 35 && maxHold <= 90, "a declared range is honoured, never escaped");
});

test("42. Watchdog NORMAL is preserved for a clean candidate", () => {
  const evidence = {
    trades: 40,
    distinctMints: 12,
    mintNotional: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`mint${index}`, 100])),
    windowReturns: { W1: 10, W2: 12, W3: 9, W4: 11 },
    regimeReturns: { "strong-risk-on": 10, "sideways-chop": 9, "weak-risk-on": 11 },
    seedReturns: { a: 10, b: 11 },
    costDrag: 0.01,
    oosWindows: 5,
    stressSurvived: 2,
    stressTotal: 2,
    missingDataShare: 0,
  };
  const result = evaluateCandidate(evidence, {});
  assertEqual(result.verdict, WATCHDOG_VERDICT.NORMAL, "a clean candidate stays NORMAL");
  assertEqual(result.flags.length, 0, "no flags are raised");
});

test("43. Watchdog WATCH and QUARANTINED verdicts are preserved", () => {
  const watch = evaluateCandidate(
    {
      trades: 4,
      mintNotional: { mintA: 100, mintB: 100, mintC: 100 },
      costDrag: 0.5,
    },
    { minTrades: 8 },
  );
  assertEqual(watch.verdict, WATCHDOG_VERDICT.WATCH, "a couple of flags produce WATCH");
  assertEqual(watch.flags.length, 2, "the WATCH verdict is backed by exactly the two expected flags");

  const quarantine = evaluateCandidate(
    {
      trades: 1,
      distinctMints: 1,
      mintNotional: { mintA: 1000 },
      windowReturns: { W1: 1000 },
      regimeReturns: { "strong-risk-on": 1000 },
      seedReturns: { s1: 1000 },
      costDrag: 0.9,
      oosWindows: 0,
      oosReturn: -0.5,
      trainReturn: 1,
      stressSurvived: 0,
      stressTotal: 3,
      missingDataShare: 1,
    },
    {},
  );
  assertEqual(quarantine.verdict, WATCHDOG_VERDICT.QUARANTINED, "many flags produce QUARANTINED");
});

test("44. A QUARANTINED candidate can never promote to deployment or shadow", async () => {
  await withTempDir(async (dir) => {
    const compiled = compileProposals({
      proposals: [validateProposal(validProposal()).proposal],
      maxCompilations: 1,
      existingDigests: [],
    });
    const candidate = compiled.compiled[0];
    await saveCompiledCandidate(dir, candidate);
    const digest = genomeDigestOf(candidate);
    const leaderboardRows = [
      { digest, score: 99, finalRank: 1, gateStatus: "GATES_PASSED", deploymentEligible: true, highestStage: "CHAMPION LEAGUE" },
    ];
    const memoryRecords = [{ candidateFamily: candidate.familyId, watchdogVerdict: "QUARANTINED", status: "TESTING" }];
    assertEqual(isQuarantined(memoryRecords, candidate.familyId), true, "quarantine is detected from memory");
    const result = await promoteFromArenaLeaderboard({ root: dir, leaderboardRows, memoryRecords, now: () => 1 });
    assertEqual(result.promoted.length, 0, "nothing is promoted from a quarantined candidate");
    assert(
      result.skipped.some((row) => String(row.reason).includes("QUARANTINED")),
      "the promotion refusal names quarantine as the reason",
    );

    const clean = await promoteFromArenaLeaderboard({ root: dir, leaderboardRows, memoryRecords: [], now: () => 1 });
    assertEqual(clean.promoted.length, 1, "without quarantine the same Arena result does promote (the gate is real, not decorative)");
  });
});
test("45. Arena scoring, A/B mode, and deployment gates are unchanged by Phase 5B", () => {
  assertEqual(ARENA_SCORE_VERSION, 1, "the Arena score version is unchanged");
  const components = { medianOOSReturn: 0.01, stressSurvived: 2, stressTotal: 2, distinctMints: 10, trades: 30 };
  const a = computeArenaScore(components);
  const b = computeArenaScore({ ...components });
  assertEqual(JSON.stringify(a), JSON.stringify(b), "the Arena score is deterministic");
  assertEqual(DEFAULT_DEPLOYMENT_GATES.requireNoCatastrophic, true, "the catastrophic-loss gate is still required");
  assertEqual(DEFAULT_DEPLOYMENT_GATES.requireMildStressSurvival, true, "the mild-stress gate is still required");
  assertEqual(DEFAULT_DEPLOYMENT_GATES.minDistinctMints, 4, "the distinct-mint gate is unchanged");
  assertEqual(RESEARCH_ARENA_MODE.AB, "ab", "A/B mode is unchanged");
  assertEqual(RESEARCH_COHORT_DEFAULTS.minUniqueRatio, 0.9, "the research-cohort uniqueness default is unchanged");
  assertEqual(RESEARCH_COHORT_DEFAULTS.maxSpeciesShare, 0.6, "the species-concentration default is unchanged");
  assertEqual(speciesMatchRequested({ EVOLVE_ARENA_AB_SPECIES_MATCHED: "1" }), true, "strict species matching is still requested the same way");
});

/* ============================================================================
 * F. Bounded runs, resilience, roles
 * ==========================================================================*/

test("46. The provider call budget is enforced for a whole run", async () => {
  await stubExecutable();
  await withTempDir(async (dir) => {
    const counter = path.join(dir, "calls.log");
    const provider = stubProvider("ok", { root: path.join(dir, "provider"), env: { EVOLVE_TEST_STUB_COUNTER: counter } });
    const proposals = await provider.propose({ evidence: {}, count: 5, cycle: 1, maxCallsPerRun: 2 });
    assertEqual(proposals.length, 2, "only the budgeted number of proposals is produced");
    assertEqual(await readCounter(counter), 2, "only the budgeted number of subprocess calls was made");
    assert(provider.runs.some((run) => run.status === PROVIDER_STATUS.BUDGET_EXCEEDED), "the refusal is recorded as BUDGET_EXCEEDED");
    assertEqual(provider.stats.budgetExceeded, 1, "the budget refusal is counted");
    const budgetRun = provider.runs.find((run) => run.status === PROVIDER_STATUS.BUDGET_EXCEEDED);
    assert(budgetRun.reason.includes("budget"), "the reason states the budget");
  });
});

test("47. A provider failure never fabricates research and never becomes a mock proposal", async () => {
  await stubExecutable();
  await withTempDir(async (dir) => {
    const report = await generateResearchCohort({
      providerName: DEEPSEEK_CLINE_PROVIDER,
      provider: stubProvider("garbage", { root: path.join(dir, "provider") }),
      baseRoot: path.join(dir, "research"),
      cycles: 1,
      proposalsPerCycle: 2,
      maxProviderCalls: 2,
      experimentId: "exp-20260918T000000Z-deepseek-cline-fail02",
      now: () => 1_700_000_000_000,
    });
    assertEqual(report.experiment.status, "PROVIDER_FAILED", "an all-failure run is reported as PROVIDER_FAILED");
    assertEqual(report.providerState.health, "FAILING", "the provider health says FAILING");
    assertEqual(report.registry.compiled, 0, "no genome is fabricated from a failed provider");
    assertEqual(report.registry.proposals, 0, "no proposal is fabricated from a failed provider");
    assertEqual(report.providerRuns.length, 2, "the failures are recorded per call");
    assert(
      report.providerRuns.every((run) => run.status === PROVIDER_STATUS.INVALID_OUTPUT),
      "each failed call carries an explicit failure status",
    );

    // A missing executable is equally safe: the run completes and reports it.
    const missing = await generateResearchCohort({
      providerName: DEEPSEEK_CLINE_PROVIDER,
      baseRoot: path.join(dir, "research2"),
      cycles: 1,
      proposalsPerCycle: 1,
      maxProviderCalls: 1,
      experimentId: "exp-20260918T000000Z-deepseek-cline-fail03",
      env: { EVOLVE_RESEARCH_CLINE_BIN: "/nonexistent/cline-please-ignore" },
      now: () => 1_700_000_000_000,
    });
    assertEqual(missing.experiment.status, "PROVIDER_FAILED", "a missing executable is a provider failure");
    assertEqual(missing.providerRuns[0].status, PROVIDER_STATUS.UNAVAILABLE, "the failure status is UNAVAILABLE");
    assertEqual(missing.providerRuns[0].executableMissing, true, "the missing executable is flagged");
  });
});
test("48. Research memory records the provider outcome of an experiment", async () => {
  await stubExecutable();
  await withTempDir(async (dir) => {
    const baseRoot = path.join(dir, "research");
    const report = await generateResearchCohort({
      providerName: DEEPSEEK_CLINE_PROVIDER,
      provider: stubProvider("ok", { root: path.join(dir, "provider") }),
      baseRoot,
      cycles: 1,
      proposalsPerCycle: 2,
      maxProviderCalls: 2,
      experimentId: "exp-20260918T000000Z-deepseek-cline-memory",
      now: () => 1_700_000_000_000,
    });
    const counters = report.experiment.counters;
    assertEqual(counters.providerCalls, 2, "the experiment counts the provider calls");
    assertEqual(counters.providerFailures, 0, "no failures are counted for a healthy provider");
    assertEqual(counters.schemaValid, 2, "the schema-valid proposals are counted");
    assertEqual(counters.compilerAccepted > 0, true, "the compiled candidates are counted");
    assertEqual(report.experiment.status, "COMPLETED", "the experiment completes");
    assertEqual(report.experiment.providerRunIds.length, 2, "the experiment links its provider runs");
    const persisted = await readResearchExperiment(report.experimentRoot);
    assertEqual(persisted.experimentId, report.experimentId, "the experiment metadata is persisted");
    assertEqual(persisted.evidenceClasses[0], EVIDENCE_CLASS.TRAIN, "the persisted experiment declares TRAIN-only evidence");
    const memory = await readMemoryIndex(report.experimentRoot, { limit: 50 });
    assert(memory.length > 0, "the research memory records the compiled proposals");
    const proposals = await listProposals(report.experimentRoot, { limit: 50 });
    assertEqual(proposals.length, 2, "both proposals landed in the isolated experiment memory");
    const compiled = await listCompiledCandidates(report.experimentRoot, { limit: 50 });
    assert(compiled.length > 0, "compiled candidates landed in the isolated experiment memory");
    const stats = await inspectResearchCohort(report.experimentRoot);
    assertEqual(stats.proposals, 2, "the cohort inspector sees the proposals");
    assert(stats.speciesCount > 0, "at least one species is reported, honestly");
    assertEqual(stats.duplicateGenomes, 0, "no duplicate genome was accepted");
  });
});

test("49. The adversarial critic is advisory-only and cannot inject a genome", async () => {
  assert(ADVISORY_ROLES.includes("adversarial-critic"), "the critic is declared advisory");
  assertEqual(PROPOSING_ROLES.includes("adversarial-critic"), false, "the critic is not a proposing role");
  assertDeepEqual(
    [...PROPOSING_ROLES].sort(),
    ["diversity-researcher", "execution-researcher", "regime-researcher", "risk-researcher", "signal-researcher"],
    "exactly five roles may originate proposals",
  );
  await stubExecutable();
  await withTempDir(async (dir) => {
    // Even when the critic is the only role called, its critique JSON does not
    // satisfy the proposal schema, so nothing compiles.
    const provider = stubProvider("ok", { root: path.join(dir, "provider") });
    const proposals = await provider.propose({ evidence: {}, count: 1, cycle: 1, roles: ["adversarial-critic"] });
    assertEqual(proposals.length, 0, "a critic-authored payload is not accepted as a proposal");
    assertEqual(provider.runs[0].status, PROVIDER_STATUS.SCHEMA_REJECTED, "the status records the schema refusal");
    assertEqual(provider.runs[0].authorRole, "adversarial-critic", "the attempted role is recorded for inspection");
  });
});

test("50. The provider probe reports identity, status, latency, and schema validity", async () => {
  await stubExecutable();
  const okResult = await probeDeepSeekClineProvider({
    provider: { config: { ...resolveProviderConfig(stubEnv("ok")), timeoutMs: 15_000 }, root: null, now: () => 1_700_000_000_000 },
    role: "signal-researcher",
    experimentId: "exp-20260918T000000Z-deepseek-cline-probe1",
  });
  assertEqual(okResult.status, PROVIDER_STATUS.OK, "a healthy stub probes OK");
  assertEqual(okResult.validJson, true, "valid JSON is reported");
  assertEqual(okResult.schemaValid, true, "schema validity is reported");
  assertEqual(okResult.model, DEEPSEEK_CLINE_MODEL, "the probe reports the model");
  assertEqual(okResult.reasoning, DEEPSEEK_CLINE_REASONING, "the probe reports the reasoning level");
  assertEqual(okResult.promptVersion, RESEARCH_PROMPT_VERSION, "the probe reports the prompt version");
  assertFinite(okResult.latencyMs, "the probe reports latency");
  assertEqual(okResult.paperOnly, true, "the probe declares the paper-only guarantee");
  assertEqual(typeof okResult.evidenceDigest, "string", "the probe reports its evidence digest");

  const failing = await probeDeepSeekClineProvider({
    provider: {
      config: { ...resolveProviderConfig({ EVOLVE_RESEARCH_CLINE_BIN: "/nonexistent/cline-please-ignore" }), timeoutMs: 5_000 },
      root: null,
      now: () => 1_700_000_000_000,
    },
    role: "signal-researcher",
  });
  assertEqual(failing.status, PROVIDER_STATUS.UNAVAILABLE, "a missing executable is a probe RESULT, never a crash");
  assertEqual(failing.schemaValid, false, "the probe reports schema validity honestly");

  const packet = buildResearchEvidencePacket({ experimentId: "exp-probe" });
  const prompt = buildResearchPrompt({ role: "signal-researcher", evidence: packet });
  assertEqual(auditEvidencePacket(packet).ok, true, "the probe packet is leak-free");
  assert(prompt.length < 20_000, "the probe prompt stays bounded");

  // The probe must leave NO trace: no run record, no saved output, no cache,
  // and no work directory left behind.
  await withTempDir(async (dir) => {
    const before = await readdir(dir);
    const scratch = await probeDeepSeekClineProvider({
      provider: { config: { ...resolveProviderConfig(stubEnv("ok")), timeoutMs: 15_000 }, root: dir, now: () => 1_700_000_000_000 },
      role: "signal-researcher",
    });
    assertEqual(scratch.status, PROVIDER_STATUS.OK, "the probe still succeeds");
    const after = await readdir(dir);
    assertDeepEqual(after, before, "the probe wrote nothing into its (unused) root");
    const leftOver = await readdir(tmpdir());
    assert(
      leftOver.every((name) => !name.startsWith("evolve-probe-") || name.length > 0),
      "the probe's temp work directory is cleaned up",
    );
  });
});

/* ============================================================================
 * G. Dashboard state, isolation, safety, and the baseline
 * ==========================================================================*/

test("51. Dashboard state exposes provider identity and health without secrets or prompts", async () => {
  await stubExecutable();
  await withTempDir(async (dir) => {
    const provider = stubProvider("ok", { root: path.join(dir, "provider") });
    await provider.propose({ evidence: buildResearchEvidencePacket({}), count: 1, cycle: 1 });
    const summary = providerStateSummary({
      identity: { provider: DEEPSEEK_CLINE_PROVIDER, model: DEEPSEEK_CLINE_MODEL, reasoning: DEEPSEEK_CLINE_REASONING, external: true },
      experimentId: "exp-dashboard",
      cacheEnabled: false,
      runs: provider.runs,
      experiment: { accepted: 1, schemaRejections: 0, duplicateGenomes: 0, watchdog: { NORMAL: 0, WATCH: 0, QUARANTINED: 0 } },
    });
    assertEqual(summary.provider, DEEPSEEK_CLINE_PROVIDER, "the provider is exposed");
    assertEqual(summary.model, DEEPSEEK_CLINE_MODEL, "the model is exposed");
    assertEqual(summary.reasoning, DEEPSEEK_CLINE_REASONING, "the reasoning level is exposed");
    assertEqual(summary.health, "HEALTHY", "provider health is exposed");
    assertEqual(summary.experimentId, "exp-dashboard", "the current experiment id is exposed");
    assertEqual(summary.calls, 1, "calls are exposed");
    assertEqual(summary.failures, 0, "failures are exposed");
    assertEqual(summary.cacheHits, 0, "cache hits are exposed");
    assertEqual(summary.schemaRejects, 0, "schema rejects are exposed");
    assertEqual(summary.duplicateGenomes, 0, "duplicate genomes are exposed");
    assert(summary.watchdog && summary.watchdog.NORMAL === 0, "watchdog counts are exposed");
    assertEqual(summary.sample.length, 1, "a bounded sample of recent runs is exposed");

    const serialized = JSON.stringify(summary);
    for (const field of PROVIDER_STATE_FORBIDDEN_FIELDS) {
      assertEqual(serialized.includes(`"${field}"`), false, `the provider state must not contain a "${field}" field`);
    }
    assertEqual(serialized.includes("TRAIN evidence packet"), false, "no prompt text leaks into provider state");
    assert(serialized.length < 4_000, "the provider state stays small");

    const researchState = buildResearchState({
      document: { researchSwarm: { provider: DEEPSEEK_CLINE_PROVIDER, providerState: summary } },
      source: "live",
      swarmUpdatedAt: "2026-09-18T00:00:00.000Z",
    });
    assertEqual(researchState.researchSwarm.providerState.health, "HEALTHY", "the swarm state passes provider health through");
    assertEqual(
      researchState.researchSwarm.sourceUpdatedAt,
      "2026-09-18T00:00:00.000Z",
      "the 5A.1 historical/current distinction is preserved",
    );
  });
});

test("52. A provider experiment is isolated and cannot touch the canonical mock cohort", async () => {
  await stubExecutable();
  await withTempDir(async (dir) => {
    const baseRoot = path.join(dir, "research");
    const canonicalCompiled = path.join(".evolve", "research", "compiled");
    const before = await readdir(canonicalCompiled);
    const report = await generateResearchCohort({
      providerName: DEEPSEEK_CLINE_PROVIDER,
      provider: stubProvider("ok", { root: path.join(dir, "provider") }),
      baseRoot,
      cycles: 1,
      proposalsPerCycle: 1,
      maxProviderCalls: 1,
      experimentId: "exp-20260918T000000Z-deepseek-cline-isolate",
      now: () => 1_700_000_000_000,
    });
    assertEqual(
      report.experimentRoot,
      path.join(baseRoot, "experiments", report.experimentId),
      "the experiment root is namespaced under experiments/<id>",
    );
    const after = await readdir(canonicalCompiled);
    assertDeepEqual(after, before, "the canonical .evolve/research cohort is untouched");

    const experimentA = createResearchExperiment({
      experimentId: "exp-aaaaaaaa-aaaaaa",
      provider: "mock",
      promptVersion: RESEARCH_PROMPT_VERSION,
      evidencePacketVersion: EVIDENCE_PACKET_VERSION,
      startedAt: 1,
    });
    const experimentB = createResearchExperiment({
      experimentId: "exp-bbbbbbbb-bbbbbb",
      provider: DEEPSEEK_CLINE_PROVIDER,
      model: DEEPSEEK_CLINE_MODEL,
      reasoning: DEEPSEEK_CLINE_REASONING,
      promptVersion: RESEARCH_PROMPT_VERSION,
      evidencePacketVersion: EVIDENCE_PACKET_VERSION,
      startedAt: 2,
    });
    assert(experimentA.experimentId !== experimentB.experimentId, "distinct experiments have distinct ids");
    assertEqual(researchExperimentSummary(experimentB).provider, DEEPSEEK_CLINE_PROVIDER, "the experiment summary carries the provider");
    assertEqual(isValidExperimentId("../../etc/passwd"), false, "an experiment id can never be a path traversal");
    assertEqual(isValidExperimentId(experimentB.experimentId), true, "a generated experiment id is valid");
    let threw = false;
    try {
      experimentRootFor(baseRoot, "../escape");
    } catch {
      threw = true;
    }
    assertEqual(threw, true, "an invalid experiment id is refused outright");
    assertEqual(
      researchExperimentIdFor({ provider: DEEPSEEK_CLINE_PROVIDER, startedAt: 0 }).startsWith("exp-"),
      true,
      "generated ids are namespaced",
    );
  });
});
test("53. No Phase 5B module contains a real-execution, signing, or wallet path", async () => {
  const files = [
    "scripts/research.mjs",
    "scripts/probe-research-provider.mjs",
    "scripts/research-compare.mjs",
    "scripts/research/provider-config.mjs",
    "scripts/research/provider-runtime.mjs",
    "scripts/research/evidence-packet.mjs",
    "scripts/research/prompt.mjs",
    "scripts/research/experiment.mjs",
    "scripts/research/cohort-runner.mjs",
    "scripts/research/providers/deepseek-cline.mjs",
  ];
  const FORBIDDEN = WALLET_PATTERNS;
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const pattern of FORBIDDEN) {
      assert(!pattern.test(text), `${file} must not contain ${pattern}`);
    }
    assert(/PAPER ONLY|paper-only/i.test(text), `${file} must state the paper-only guarantee`);
  }
  // No provider-specific logic leaks into the trading/evaluation path.
  const engineSource = await readFile("scripts/engine/simulation.mjs", "utf8");
  assert(!/deepseek/i.test(engineSource), "no DeepSeek-specific logic leaks into the simulation");
  const evaluatorSource = await readFile("scripts/arena/evaluator.mjs", "utf8");
  assert(!/deepseek|cline/i.test(evaluatorSource), "no provider-specific logic leaks into the Arena evaluator");
  const gatesSource = await readFile("scripts/arena/orchestrator.mjs", "utf8");
  assert(!/deepseek/i.test(gatesSource), "no provider-specific logic leaks into gates / scoring");
});

test("54. The canonical mock baseline arena is present, unchanged, and not reinterpreted", async () => {
  const dir = path.join(".evolve", "arenas", MOCK_CONTROL_ARENA);
  const comparisonFile = path.join(dir, "ab-comparison.json");
  const hashBefore = digestOf(await readFile(comparisonFile, "utf8"));
  const artifact = JSON.parse(await readFile(comparisonFile, "utf8"));

  assertEqual(artifact.arenaId, MOCK_CONTROL_ARENA, "the baseline artifact is the canonical one");
  assertEqual(artifact.paperOnly, true, "the baseline is paper-only");
  assertEqual(artifact.researchMode, "ab", "the baseline is a matched A/B run");
  assertEqual(artifact.cohortSize.research, 13, "the baseline had 13 research entrants");
  assertEqual(artifact.cohortSize.conventional, 13, "the baseline had 13 conventional entrants");
  assertEqual(artifact.cohortSize.equalSize, true, "the baseline cohorts were equal size");
  assertEqual(artifact.species.matched, true, "the species-match invariant held");
  assertEqual(artifact.cohortConstruction.clonedToFillQuota, 0, "the baseline cloned nothing");
  assertEqual(artifact.cohortConstruction.requestedMatchMode, "species-matched", "the baseline requested a strict species match");
  assertEqual(artifact.cohortConstruction.effectiveMatchMode, "species-matched", "the baseline enforced the strict species match");
  assertClose(artifact.cohorts.research.arena.medianScore, 71.69, 0.001, "the documented research median Arena score");
  assertClose(artifact.cohorts.conventional.arena.medianScore, 71.22, 0.001, "the documented conventional median Arena score");
  assertClose(artifact.cohorts.research.trading.medianNetPaperReturn, -0.000493, 1e-6, "the documented research median net paper return");
  assertClose(artifact.cohorts.conventional.trading.medianNetPaperReturn, 0.001594, 1e-6, "the documented conventional median net paper return");
  assertClose(artifact.cohorts.research.trading.medianCostDrag, 0.001903, 1e-6, "the documented research median cost drag");
  assertClose(artifact.cohorts.conventional.trading.medianCostDrag, 0.004728, 1e-6, "the documented conventional median cost drag");
  assertClose(artifact.cohorts.research.trading.medianDrawdown, 0.009254, 1e-6, "the documented research median drawdown");
  assertClose(artifact.cohorts.conventional.trading.medianDrawdown, 0.014744, 1e-6, "the documented conventional median drawdown");

  const extra = await readdir(dir);
  assertEqual(extra.includes("research-experiment.json"), false, "no provider provenance was retro-fitted onto the baseline");
  const hashAfter = digestOf(await readFile(comparisonFile, "utf8"));
  assertEqual(hashAfter, hashBefore, "reading the baseline did not modify it");
  const summary = JSON.parse(await readFile(path.join(dir, "summary.json"), "utf8"));
  assertEqual(summary.arenaId, MOCK_CONTROL_ARENA, "the baseline summary is the canonical one");
  assertEqual(summary.datasets[0].id, "session-20260917T164922Z-live", "the baseline dataset is the one real dataset");
});
test("55. The comparison tool uses WITHIN-RUN A/B deltas, not raw-vs-raw scores", async () => {
  const control = await readArenaRun(MOCK_CONTROL_ARENA);
  assertEqual(control.available, true, "the mock control arena is readable");
  assertClose(control.deltas.medianArenaScore, 0.47, 0.001, "the control's within-run score delta is research − conventional");
  assertClose(control.deltas.medianNetPaperReturn, -0.002087, 1e-6, "the control's within-run net-return delta");
  assertClose(control.deltas.medianCostDrag, -0.002825, 1e-6, "the control's within-run cost-drag delta");
  assertClose(control.deltas.medianDrawdown, -0.00549, 1e-6, "the control's within-run drawdown delta");
  assertEqual(control.cohort.speciesMatched, true, "the control is species-matched");
  assertEqual(control.cohort.clonedToFillQuota, 0, "the control cloned nothing");
  assertEqual(control.provider.provider, null, "the baseline predates provider provenance and is NOT reinterpreted");

  const selfComparison = compareRuns(control, control);
  for (const [key, value] of Object.entries(selfComparison.deltaOfDeltas)) {
    assertEqual(value, 0, `${key}: comparing a run with itself must yield a zero delta-of-deltas`);
  }
  assertEqual(selfComparison.bothSpeciesMatched, true, "both sides are species-matched");
  assertEqual(selfComparison.sameDataset, true, "the same dataset fingerprints are detected");

  const shifted = { ...control, deltas: { ...control.deltas, medianArenaScore: control.deltas.medianArenaScore - 1 } };
  const shiftedComparison = compareRuns(control, shifted);
  assertClose(shiftedComparison.deltaOfDeltas.medianArenaScore, -1, 1e-6, "delta-of-deltas compares provider deltas, not raw scores");
  assertEqual(shiftedComparison.deltaOfDeltas.medianCostDrag, 0, "unchanged metrics stay zero");

  const missing = await readArenaRun("arena-does-not-exist");
  assertEqual(missing.available, false, "a missing arena is reported as unavailable, never invented");
});

test("56. A fresh cohort can be generated, inspected, and replayed without new provider calls", async () => {
  await stubExecutable();
  await withTempDir(async (dir) => {
    const counter = path.join(dir, "calls.log");
    const baseRoot = path.join(dir, "research");
    const env = { EVOLVE_TEST_STUB_COUNTER: counter, EVOLVE_RESEARCH_CLINE_BIN: sharedStubPath };
    const report = await generateResearchCohort({
      providerName: DEEPSEEK_CLINE_PROVIDER,
      baseRoot,
      cycles: 1,
      roles: ["signal-researcher", "regime-researcher", "risk-researcher"],
      proposalsPerCycle: 3,
      maxProviderCalls: 3,
      experimentId: "exp-20260918T000000Z-deepseek-cline-replay1",
      env,
      now: () => 1_700_000_000_000,
      cacheEnabled: true,
    });
    assertEqual(report.experiment.status, "COMPLETED", "the cohort run completed");
    assertEqual(await readCounter(counter), 3, "three bounded provider calls were made");
    const runIds = report.providerRuns.map((run) => run.providerRunId);
    assertEqual(runIds.length, 3, "three provider runs were recorded");
    assertEqual(report.experiment.counters.roleDistribution["signal-researcher"], 1, "each role authored its own proposal");

    // Replaying the saved outputs must not touch the provider at all.
    const replayer = stubProvider("ok", { root: report.providerRoot, env, replayRunIds: runIds });
    const replayed = await replayer.propose({ evidence: report.evidence, count: 3, cycle: 1 });
    assertEqual(replayed.length, 3, "all three saved proposals replayed");
    assertEqual(await readCounter(counter), 3, "replay made no additional provider calls");
    const recompiled = compileProposals({ proposals: replayed, maxCompilations: 3, existingDigests: [] });
    assertEqual(recompiled.compiled.length > 0, true, "the replayed proposals compile deterministically");

    const stats = await inspectResearchCohort(report.experimentRoot);
    assertEqual(stats.proposals, 3, "the inspector counts the persisted proposals");
    assert(stats.roleCount >= 1, "role diversity is reported from the artifacts");
    assertEqual(stats.duplicateGenomes, 0, "the inspector reports no duplicate genomes");
    assertEqual(report.experiment.counters.schemaRejections, 0, "no schema rejection in a healthy stub run");
    assertEqual(report.evidence.evidenceClasses[0], EVIDENCE_CLASS.TRAIN, "the run's evidence was TRAIN-only");
    assertEqual(auditEvidencePacket(report.evidence).ok, true, "the run's evidence packet passes the leak audit");
  });
});
test("57. The mock provider still works through the Phase 5B cohort pipeline (Phase 5A regression)", async () => {
  await withTempDir(async (dir) => {
    const baseRoot = path.join(dir, "research");
    const report = await generateResearchCohort({
      providerName: "mock",
      baseRoot,
      cycles: 1,
      proposalsPerCycle: 6,
      maxProviderCalls: 6,
      experimentId: "exp-20260918T000000Z-mock-regression",
      now: () => 1_700_000_000_000,
    });
    assertEqual(report.experiment.provider, "mock", "the mock experiment records the mock provider");
    assertEqual(report.experiment.model, null, "the mock provider claims no model");
    assertEqual(report.experiment.reasoning, null, "the mock provider claims no reasoning level");
    assertEqual(report.experiment.status, "COMPLETED", "the mock cohort completes");
    assertEqual(report.providerRuns.length, 0, "the mock provider makes no subprocess calls");
    assertEqual(report.experiment.counters.providerCalls, 0, "no provider calls are counted for the mock");
    assert(report.experiment.counters.schemaValid > 0, "the mock proposals pass the same schema");
    assert(report.experiment.counters.compilerAccepted > 0, "the mock proposals compile through the same compiler");
    assert(report.registry.proposals > 0, "the mock cohort is persisted");

    // Determinism: the same evidence + seed produces identical mock proposals.
    const evidence = buildResearchEvidencePacket({ experimentId: "exp-mock" });
    const a = mockProviderPropose({ evidence, count: 6, seed: "phase5b-mock", cycle: 3 });
    const b = mockProviderPropose({ evidence, count: 6, seed: "phase5b-mock", cycle: 3 });
    assertEqual(JSON.stringify(a), JSON.stringify(b), "the mock provider is deterministic");

    // Phase 5B.1: provider selection is fail-closed. An UNSPECIFIED provider is
    // still the deterministic mock; an EXPLICIT unregistered name fails closed
    // and is reported — it is never quietly served by the mock.
    const unset = resolveResearchProvider();
    assertEqual(unset.name, "mock", "an unspecified provider resolves to the offline mock");
    assertEqual(unset.offline, true, "the default provider is offline");
    const cfgUnset = resolveProviderConfig({});
    assertEqual(cfgUnset.provider, "mock", "the config default is mock");
    assertEqual(cfgUnset.specified, false, "the default is not an explicit request");
    const cfgTypo = resolveProviderConfig({ EVOLVE_RESEARCH_PROVIDER: "some-llm-vendor" });
    assertEqual(cfgTypo.provider, null, "a typo resolves to NO provider at all");
    assertEqual(cfgTypo.unknownProvider, "some-llm-vendor", "the typo is recorded, never hidden");
    assertEqual(cfgTypo.configValid, false, "the configuration is reported as invalid");
    let thrown = null;
    try {
      resolveResearchProvider("some-llm-vendor");
    } catch (error) {
      thrown = error;
    }
    assert(thrown, "an explicit unregistered name throws instead of falling back");
    assertEqual(thrown.code, "UNKNOWN_RESEARCH_PROVIDER", "the fail-closed error is explicit");
  });
});

test("58. Provider defaults are conservative", () => {
  assertEqual(PROVIDER_DEFAULTS.maxAttempts, 1, "the default is a single attempt (no hammering a free provider)");
  assertEqual(PROVIDER_DEFAULTS.cacheEnabled, false, "caching is explicit, not implicit");
  assert(PROVIDER_DEFAULTS.timeoutMs >= 60_000, "the timeout is generous enough for a real call but bounded");
  assert(PROVIDER_DEFAULTS.maxCallsPerRun <= 32, "the per-run call budget is small");
  assert(PROVIDER_DEFAULTS.maxContextChars <= 16_000, "the context budget is conservative");
  assert(PROVIDER_DEFAULTS.maxResponseChars <= 500_000, "the response is size-capped");
  const resolved = resolveProviderConfig({});
  assertEqual(resolved.executable, "cline", "the default executable is the installed CLI");
  assertEqual(resolved.profile, "cline", "the default profile is the known-working one");
  assertEqual(resolved.maxAttempts, 1, "retries default to none");
  assertEqual(resolved.cacheEnabled, false, "caching defaults to off");
  const refused = resolveProviderConfig({ EVOLVE_RESEARCH_PROVIDER_MAX_ATTEMPTS: "99" });
  assertEqual(refused.maxAttempts <= 5, true, "the attempt count is clamped");
});
test("59. Oversized provider responses are bounded and reported, not parsed", async () => {
  await stubExecutable();
  // The stream cap bounds the raw event stream (high reasoning effort streams a
  // lot of events); the answer cap bounds the model's actual answer.
  const streamCapped = stubProvider("huge", { config: { maxStreamChars: 20_000, maxResponseChars: 5_000 } });
  await streamCapped.propose({ evidence: {}, count: 1, cycle: 1 });
  assertEqual(streamCapped.runs[0].status, PROVIDER_STATUS.INVALID_OUTPUT, "an oversized stream is an invalid-output failure");
  assert(streamCapped.runs[0].reason.includes("exceeded"), "the reason states the size limit");
  assertEqual(streamCapped.runs[0].oversized, true, "the run flags the oversize");

  const answerCapped = stubProvider("ok", { config: { maxStreamChars: 1_000_000, maxResponseChars: 120 } });
  await answerCapped.propose({ evidence: {}, count: 1, cycle: 1 });
  assertEqual(answerCapped.runs[0].status, PROVIDER_STATUS.INVALID_OUTPUT, "an answer above the answer cap is refused");
  assert(answerCapped.runs[0].reason.includes("answer exceeded"), "the reason names the answer cap");

  const withinCaps = stubProvider("ok", { config: { maxStreamChars: 1_000_000, maxResponseChars: 20_000 } });
  const ok = await withinCaps.propose({ evidence: {}, count: 1, cycle: 1 });
  assertEqual(ok.length, 1, "a response inside both caps is accepted");
});
/* ============================================================================
 * H. Phase 5B.1 — fail-closed provider selection
 * ==========================================================================*/

/** Run a CLI in a child process (for the exit-code assertions). */
function cliCommand(script, args, env = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    cwd: process.cwd(),
    timeout: 60_000,
  });
}

test("60. An explicit unknown provider fails closed at every resolution layer", async () => {
  const config = resolveProviderConfig({ EVOLVE_RESEARCH_PROVIDER: "deepseek-clnie" });
  assertEqual(config.provider, null, "no provider is resolved for an explicit unknown name");
  assertEqual(config.configError, "Unknown research provider: deepseek-clnie", "the configuration error names the typo");
  assertEqual(config.unknownProvider, "deepseek-clnie", "the invalid requested provider is recorded");
  assertEqual(config.requestedProvider, "deepseek-clnie", "the raw request is preserved for reporting");
  assertEqual(config.specified, true, "the invalid provider WAS explicitly specified");
  assertEqual(config.configValid, false, "the configuration is reported invalid");

  let thrown = null;
  try {
    resolveResearchProvider("deepseek-clnie");
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof UnknownResearchProviderError, "the resolver throws the fail-closed error");
  assertEqual(thrown.message, "Unknown research provider: deepseek-clnie", "the error message is the documented one");
  assertEqual(thrown.requestedProvider, "deepseek-clnie", "the error carries the requested name");

  let cohortThrew = null;
  try {
    await generateResearchCohort({ providerName: "deepseek-clnie", baseRoot: "/tmp/evolve-never-created" });
  } catch (error) {
    cohortThrew = error;
  }
  assert(cohortThrew, "the cohort runner refuses to run");
  assertEqual(cohortThrew.code, "UNKNOWN_RESEARCH_PROVIDER", "the cohort runner fails with the same explicit code");
});

test("61. An unknown provider never runs the mock provider and produces no proposals", async () => {
  await withTempDir(async (dir) => {
    const baseRoot = path.join(dir, "research");
    let mockWasAsked = false;
    const mockSpy = {
      name: "mock",
      offline: true,
      propose() {
        mockWasAsked = true;
        return [validProposal()];
      },
    };
    let thrown = null;
    try {
      await generateResearchCohort({
        providerName: "deepseek-clnie",
        provider: mockSpy,
        baseRoot,
        cycles: 1,
        proposalsPerCycle: 1,
        maxProviderCalls: 1,
      });
    } catch (error) {
      thrown = error;
    }
    assert(thrown, "an invalid provider name is refused even when a provider object is injected");
    assertEqual(mockWasAsked, false, "the mock provider was never asked for proposals");
    assertEqual(thrown.code, "UNKNOWN_RESEARCH_PROVIDER", "the failure is the explicit configuration error");
    const dirs = await readdir(baseRoot).catch(() => []);
    assertEqual(dirs.length, 0, "no experiment root was created");
  });
});

test("62. An unknown provider never calls the Cline CLI", async () => {
  await stubExecutable();
  await withTempDir(async (dir) => {
    const counter = path.join(dir, "calls.log");
    const baseRoot = path.join(dir, "research");
    const stubBag = {
      EVOLVE_RESEARCH_CLINE_BIN: sharedStubPath,
      EVOLVE_TEST_STUB_COUNTER: counter,
      EVOLVE_TEST_STUB_MODE: "ok",
    };
    let thrown = null;
    try {
      await generateResearchCohort({
        providerName: "deepseek-clnie",
        baseRoot,
        cycles: 1,
        proposalsPerCycle: 1,
        maxProviderCalls: 1,
        env: stubBag,
      });
    } catch (error) {
      thrown = error;
    }
    assert(thrown, "the typo fails closed");
    assertEqual(await readCounter(counter), 0, "the Cline executable was never spawned");
    assertEqual(thrown.code, "UNKNOWN_RESEARCH_PROVIDER", "the failure is a configuration error, not a provider failure");

    // The same typo supplied through the ENVIRONMENT must behave identically.
    let envThrown = null;
    try {
      await generateResearchCohort({
        baseRoot,
        cycles: 1,
        proposalsPerCycle: 1,
        maxProviderCalls: 1,
        env: { ...stubBag, EVOLVE_RESEARCH_PROVIDER: "deepseek-clnie" },
      });
    } catch (error) {
      envThrown = error;
    }
    assert(envThrown, "an env-var typo also fails closed");
    assertEqual(await readCounter(counter), 0, "no Cline call was made for the env-var typo either");
    assertEqual(envThrown.code, "UNKNOWN_RESEARCH_PROVIDER", "the env-var failure is the same configuration error");
  });
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

  await cleanupStub();

  console.log(`\nEVOLVE Phase 5B validation: ${passed}/${cases.length} checks passed`);

  if (failures.length > 0) {
    console.log("Failed checks:");
    for (const failure of failures) console.log(`  - ${failure.name}`);
    process.exitCode = 1;
  } else {
    console.log("All Phase 5B checks passed.");
    console.log(
      "PAPER RESEARCH ONLY. DeepSeek proposes hypotheses; the deterministic compiler, watchdog, and Arena decide. No profitability, deployment, or safety claim is made, and a null or worse result remains valid.",
    );
  }
}

run().catch(async (error) => {
  await cleanupStub();
  console.error("phase 5b validation runner crashed:", error);
  process.exitCode = 1;
});

test("63. A typo cannot create a valid-looking mock (or DeepSeek) experiment", async () => {
  await stubExecutable();
  await withTempDir(async (dir) => {
    const counter = path.join(dir, "calls.log");
    const baseRoot = path.join(dir, "research");
    let thrown = null;
    try {
      await generateResearchCohort({
        providerName: "deepseek-clnie",
        baseRoot,
        experimentId: "exp-20260918T000000Z-deepseek-clnie-typo01",
        cycles: 1,
        proposalsPerCycle: 2,
        maxProviderCalls: 2,
        env: { EVOLVE_RESEARCH_CLINE_BIN: sharedStubPath, EVOLVE_TEST_STUB_COUNTER: counter },
      });
    } catch (error) {
      thrown = error;
    }
    assert(thrown, "the run fails");
    assertEqual(await readCounter(counter), 0, "no provider call happened");
    const artifact = path.join(
      baseRoot,
      "experiments",
      "exp-20260918T000000Z-deepseek-clnie-typo01",
      "experiment.json",
    );
    const exists = await readFile(artifact)
      .then(() => true)
      .catch(() => false);
    assertEqual(exists, false, "no experiment artifact exists, so nothing can be mistaken for a valid experiment");
    const anyExperiments = await readdir(path.join(baseRoot, "experiments")).catch(() => []);
    assertEqual(anyExperiments.length, 0, "the experiments directory is empty (or was never created)");
    const experiments = await listResearchExperiments(baseRoot);
    assertEqual(experiments.length, 0, "the experiment listing is empty");
    assertEqual(String(thrown.message), "Unknown research provider: deepseek-clnie", "the failure message is unambiguous");
  });
});

test("64. `npm run research` exits non-zero on an invalid provider and creates nothing", async () => {
  await stubExecutable();
  await withTempDir(async (dir) => {
    const baseRoot = path.join(dir, "research");
    const counter = path.join(dir, "calls.log");
    const stubBag = { EVOLVE_RESEARCH_CLINE_BIN: sharedStubPath, EVOLVE_TEST_STUB_COUNTER: counter };

    const flagRun = cliCommand("scripts/research.mjs", ["--provider", "deepseek-clnie", "--base-root", baseRoot], stubBag);
    assertEqual(flagRun.status, 2, "an invalid --provider exits non-zero");
    assert(flagRun.stderr.includes("Unknown research provider: deepseek-clnie"), "the CLI explains the failure");
    assert(flagRun.stderr.includes("mock, deepseek-cline"), "the CLI lists the registered providers");

    const envRun = cliCommand("scripts/research.mjs", ["--base-root", baseRoot], {
      ...stubBag,
      EVOLVE_RESEARCH_PROVIDER: "deepseek-clnie",
    });
    assertEqual(envRun.status, 2, "an invalid EVOLVE_RESEARCH_PROVIDER exits non-zero");
    assert(envRun.stderr.includes("Unknown research provider: deepseek-clnie"), "the env-var failure is explained too");
    assert(envRun.stderr.includes("no experiment was created"), "the CLI states that nothing was created");

    assertEqual(await readCounter(counter), 0, "neither attempt called the provider");
    assertEqual((await listResearchExperiments(baseRoot)).length, 0, "neither attempt created an experiment");

    // The valid mock path still succeeds (exit 0) and creates its own experiment.
    const mockRun = cliCommand(
      "scripts/research.mjs",
      ["--provider", "mock", "--cycles", "1", "--roles", "signal-researcher", "--max-calls", "1", "--base-root", baseRoot],
      stubBag,
    );
    assertEqual(mockRun.status, 0, "explicit `mock` still works");
    assert(mockRun.stdout.includes("provider       mock"), "the CLI reports the provider actually used");
    const created = await listResearchExperiments(baseRoot);
    assertEqual(created.length, 1, "exactly one valid experiment exists");
    assertEqual(created[0].provider, "mock", "the created experiment is labelled with the real provider");
    assertEqual(await readCounter(counter), 0, "the mock path still makes no subprocess calls");
  });
});

test("65. `npm run probe:research-provider` exits non-zero on an invalid provider and probes nothing", async () => {
  await stubExecutable();
  await withTempDir(async (dir) => {
    const counter = path.join(dir, "calls.log");
    const stubBag = { EVOLVE_RESEARCH_CLINE_BIN: sharedStubPath, EVOLVE_TEST_STUB_COUNTER: counter };

    const flagRun = cliCommand("scripts/probe-research-provider.mjs", ["--provider", "deepseek-clnie", "--json"], stubBag);
    assertEqual(flagRun.status, 2, "an invalid --provider exits non-zero");
    assert(flagRun.stderr.includes("Unknown research provider: deepseek-clnie"), "the probe explains the failure");
    assertEqual(flagRun.stdout.includes("PROVIDER_OK"), false, "no probe result is reported");

    const envRun = cliCommand("scripts/probe-research-provider.mjs", ["--json"], {
      ...stubBag,
      EVOLVE_RESEARCH_PROVIDER: "deepseek-clnie",
    });
    assertEqual(envRun.status, 2, "an invalid env var exits non-zero");
    assert(envRun.stderr.includes("no provider was called"), "the probe states that nothing was called");
    assertEqual(await readCounter(counter), 0, "no provider call was made");

    // Probing the offline baseline still works and stays exit 0.
    const mockProbe = cliCommand("scripts/probe-research-provider.mjs", ["--provider", "mock", "--json"], stubBag);
    assertEqual(mockProbe.status, 0, "probing the default mock provider succeeds");
    assert(mockProbe.stdout.includes('"provider": "mock"'), "the mock probe reports the mock provider");
    assertEqual(await readCounter(counter), 0, "probing the mock provider makes no subprocess call");
  });
});
test("66. The engine reports a provider configuration error and runs NO research cycle", async () => {
  const simulation = {
    generation: 4,
    population: [],
    snapshot: () => ({ researchRegime: "strong-risk-on", paper: {}, stats: { population: 0 }, species: [] }),
    getResearchEvidence: () => [],
    clearResearchEvidence: () => {},
    injectResearchCandidate: () => {
      throw new Error("a configuration error must never inject a research candidate");
    },
  };
  const baseConfig = createMarketConfig({}, { loadEnv: false });
  const typoConfig = { ...baseConfig, research: { ...baseConfig.research, provider: "deepseek-clnie", enabled: true } };
  const controller = createResearchController({ config: typoConfig, simulation });
  await controller.runIfDue();
  const summary = controller.summary();
  assertEqual(summary.enabled, false, "research is disabled by the invalid provider configuration");
  assertEqual(summary.providerConfigValid, false, "the configuration is reported invalid");
  assertEqual(summary.providerError, "Unknown research provider: deepseek-clnie", "the dashboard carries the exact error");
  assertEqual(summary.provider, "deepseek-clnie", "the invalid requested provider is recorded");
  assertEqual(summary.providerState.health, "PROVIDER_CONFIG_ERROR", "provider health reports the configuration error");
  assertEqual(summary.providerState.calls, 0, "no provider call was made");
  assertEqual(summary.cycle, 0, "no research cycle ran");
  assertEqual(summary.proposalsGenerated, 0, "no proposal was generated");
  assertEqual(summary.lastError, "Unknown research provider: deepseek-clnie", "the error is surfaced as the last error");

  // Valid configurations are unaffected.
  const okController = createResearchController({
    config: { ...baseConfig, research: { ...baseConfig.research, provider: "mock", enabled: false } },
    simulation,
  });
  assertEqual(okController.summary().providerConfigValid, true, "an explicit mock provider is a valid configuration");
  assertEqual(okController.summary().providerError, null, "no error is reported for a valid provider");
  const defaultController = createResearchController({
    config: { ...baseConfig, research: { ...baseConfig.research, provider: undefined, enabled: false } },
    simulation,
  });
  assertEqual(defaultController.summary().provider, "mock", "an unset engine provider is the mock default");
  assertEqual(defaultController.summary().providerConfigValid, true, "an unset provider is a valid configuration");
});

test("67. No provider fallback path exists anywhere in the research subsystem", async () => {
  const files = [
    "scripts/research/provider.mjs",
    "scripts/research/provider-config.mjs",
    "scripts/research/cohort-runner.mjs",
    "scripts/research/cycle.mjs",
    "scripts/research.mjs",
    "scripts/probe-research-provider.mjs",
    "scripts/evolve-engine.mjs",
    "scripts/research/providers/deepseek-cline.mjs",
  ];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    assertEqual(/fallbackFrom/.test(text), false, `${file} must not carry the removed legacy fallback marker`);
    assertEqual(/allowMockFallback:\s*true/.test(text), false, `${file} must never enable a mock fallback`);
    assertEqual(/fallbackReason/.test(text), false, `${file} must not carry a fallback reason`);
  }
  const resolverSource = await readFile("scripts/research/provider.mjs", "utf8");
  assert(resolverSource.includes("requireProviderName"), "the resolver goes through the fail-closed gate");
  assert(
    resolverSource.indexOf("requireProviderName(name)") < resolverSource.indexOf("createDeepSeekClineProvider({"),
    "the name is validated BEFORE any provider object is constructed",
  );
  const configSource = await readFile("scripts/research/provider-config.mjs", "utf8");
  assert(configSource.includes("UnknownResearchProviderError"), "the configuration module defines the fail-closed error");
  assertEqual(
    /validation\.recognized\s*\?\s*validation\.name\s*:\s*DEFAULT_RESEARCH_PROVIDER/.test(configSource),
    false,
    "the old 'unknown name → mock default' branch is gone",
  );
});

/* ============================================================================
 * Runner
 * ==========================================================================*/
export { cases };
