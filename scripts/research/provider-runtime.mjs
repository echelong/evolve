/**
 * Provider runtime (Phase 5B): subprocess execution, output extraction, cache,
 * replay, and provenance — shared by the DeepSeek provider, the probe, and the
 * validators.
 *
 * Security posture, in one sentence: model output is UNTRUSTED DATA, so this
 * module (a) never builds a shell command string, (b) never executes anything
 * found in the output, and (c) only ever hands a validated JSON object to the
 * deterministic schema.
 *
 * Concretely:
 *   - the CLI is spawned with `spawn(command, argsArray)`, never through a
 *     shell, so no quoting/injection path exists — model or evidence text lives
 *     in ONE argv element (the prompt) and can never become a command
 *   - the subprocess runs in a dedicated, EMPTY working directory with tool
 *     auto-approval disabled, so even if the model tries to use tools it has
 *     nothing to read and nothing to approve
 *   - timeouts, signals, missing executables, oversized output, and malformed
 *     JSON all become explicit statuses, never exceptions that escape into the
 *     trading/evolution engine
 *
 * PAPER ONLY research machinery.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { digestOf } from "../lib/hash.mjs";
import { redactSecrets } from "../lib/sanitize.mjs";
import { PROVIDER_STATUS, RESEARCH_PROVIDER_FORMAT_VERSION } from "./provider-config.mjs";

export const PROVIDER_RUNTIME_VERSION = 1;

/* ============================================================================
 * Output hygiene
 * ==========================================================================*/

const ANSI_PATTERN = /\u001B\[[0-9;?]*[A-Za-z]|\u001B\][^\u0007]*\u0007/g;

/** Strip terminal styling so extraction sees the model's actual characters. */
export function stripAnsi(text) {
  return String(text ?? "").replace(ANSI_PATTERN, "");
}

/** Last-resort secret scrub for anything we might persist or print. */
export function scrubOutput(text, extraSecrets = []) {
  return redactSecrets(stripAnsi(text), extraSecrets);
}

/* ============================================================================
 * Strict JSON extraction
 * ==========================================================================*/

function isPlainObjectValue(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Every top-level balanced `{...}` group in the text, as raw substrings.
 * String literals and escapes are respected, so braces inside a JSON string do
 * not end a candidate early.
 */
function balancedObjectCandidates(text) {
  const candidates = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char === "}") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          candidates.push(text.slice(start, index + 1));
          start = -1;
        }
      }
    }
  }

  return candidates;
}
/**
 * Extract exactly one JSON OBJECT from provider text.
 *
 * Order of attempts (no repair is ever attempted):
 *   1. the trimmed text parses directly as a JSON object
 *   2. a single fenced ```json block whose CONTENT parses as a JSON object and
 *      whose text outside the fence is blank
 *   3. the text contains exactly one parseable top-level JSON object
 *
 * Anything else is rejected: zero objects, more than one object, a JSON array at
 * the top level, or a truncated payload. We never invent missing strategy values
 * to make an invalid proposal valid.
 *
 * @returns {{ ok: boolean, value: object|null, method: string, reason: string|null, candidateCount: number }}
 */
export function extractJsonObject(text) {
  const cleaned = stripAnsi(text ?? "").trim();
  if (cleaned.length === 0) {
    return { ok: false, value: null, method: "none", reason: "empty output", candidateCount: 0 };
  }

  try {
    const direct = JSON.parse(cleaned);
    if (isPlainObjectValue(direct)) {
      return { ok: true, value: direct, method: "direct", reason: null, candidateCount: 1 };
    }
    return {
      ok: false,
      value: null,
      method: "direct",
      reason: "output is valid JSON but not an object",
      candidateCount: 1,
    };
  } catch {
    // fall through to extraction
  }

  const fences = [...cleaned.matchAll(FENCE_PATTERN)];
  if (fences.length === 1) {
    const outside = cleaned.replace(FENCE_PATTERN, "").trim();
    if (outside.length === 0) {
      try {
        const fenced = JSON.parse(fences[0][1].trim());
        if (isPlainObjectValue(fenced)) {
          return { ok: true, value: fenced, method: "fenced-single", reason: null, candidateCount: 1 };
        }
        return {
          ok: false,
          value: null,
          method: "fenced-single",
          reason: "the fenced payload is not a JSON object",
          candidateCount: 1,
        };
      } catch {
        return {
          ok: false,
          value: null,
          method: "fenced-single",
          reason: "the fenced payload is not valid JSON",
          candidateCount: 1,
        };
      }
    }
  }

  const parsed = [];
  for (const candidate of balancedObjectCandidates(cleaned)) {
    try {
      const value = JSON.parse(candidate);
      if (isPlainObjectValue(value)) parsed.push(value);
    } catch {
      // A balanced group that is not valid JSON (an echoed prompt fragment, a set
      // notation, a code snippet) is simply not a candidate.
    }
  }

  if (parsed.length === 1) {
    return { ok: true, value: parsed[0], method: "scan-single", reason: null, candidateCount: 1 };
  }
  if (parsed.length === 0) {
    return { ok: false, value: null, method: "scan", reason: "no JSON object found in the output", candidateCount: 0 };
  }
  return {
    ok: false,
    value: null,
    method: "scan",
    reason: `ambiguous output: ${parsed.length} JSON objects found, exactly one is required`,
    candidateCount: parsed.length,
  };
}

/* ============================================================================
 * Cline NDJSON stream parsing (the `--json` output contract)
 * ==========================================================================*/

/**
 * Parse the CLI's NDJSON message stream.
 *
 * The installed CLI documents `--json` as "Output messages as JSON instead of
 * styled text"; observed contract (cline 3.0.62): one JSON object per line, with
 * a final `run_result` record that carries the assistant's complete text plus
 * model/usage/duration metadata. Parsing that record is far more robust than
 * scraping styled text, so it is the primary path — and a plain-text stdout
 * still works through the fallback below.
 *
 * @returns {{ finalText: string|null, events: number, usage: object|null, model: object|null, finishReason: string|null, durationMs: number|null }}
 */
export function parseClineJsonStream(stdout) {
  const lines = stripAnsi(stdout ?? "").split("\n");
  let finalText = null;
  let usage = null;
  let model = null;
  let finishReason = null;
  let durationMs = null;
  const streamed = [];
  let events = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed[0] !== "{") continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object") continue;
    events += 1;

    if (record.type === "run_result") {
      if (typeof record.text === "string") finalText = record.text;
      if (record.usage && typeof record.usage === "object") usage = record.usage;
      if (record.model && typeof record.model === "object") model = record.model;
      if (typeof record.finishReason === "string") finishReason = record.finishReason;
      if (Number.isFinite(record.durationMs)) durationMs = record.durationMs;
      continue;
    }

    const event = record.event;
    if (record.type === "agent_event" && event && typeof event === "object") {
      if (event.type === "content_end" && event.contentType === "text" && typeof event.text === "string") {
        streamed.push(event.text);
      }
    }
  }

  if (finalText === null && streamed.length > 0) finalText = streamed.join("");

  return { finalText, events, usage, model, finishReason, durationMs };
}

/**
 * Best-effort assistant text from raw provider stdout: the NDJSON `run_result`
 * when the CLI was asked for JSON, otherwise the raw text itself.
 */
export function extractAssistantText(stdout) {
  const parsed = parseClineJsonStream(stdout);
  if (parsed.finalText !== null) return { text: parsed.finalText, source: "json-stream", ...parsed };
  // If the output contained no NDJSON records at all, treat stdout as text.
  if (parsed.events === 0) return { ...parsed, text: stripAnsi(stdout ?? ""), source: "raw-text" };
  return { ...parsed, text: "", source: "json-stream" };
}
/* ============================================================================
 * Subprocess execution
 * ==========================================================================*/

/**
 * Resolve the spawn command. A `.mjs`/`.js` executable is run by the Node
 * binary — that is how the offline stub is wired in tests, and it keeps the
 * spawn free of any shell or shebang assumptions.
 */
export function resolveClineCommand({ executable = "cline", executableIsScript = false } = {}) {
  if (executableIsScript) return { command: process.execPath, baseArgs: [String(executable)] };
  return { command: String(executable), baseArgs: [] };
}

/**
 * Build the argv array for one research call.
 *
 * `--auto-approve false` is not cosmetic: it is the difference between "a model
 * that returns text" and "a model that can act on the machine". The prompt is a
 * single trailing argv element and is never shell-interpreted.
 */
export function buildClineArgs({
  profile = "cline",
  model,
  reasoning = null,
  prompt,
  timeoutSeconds = null,
  cwd = null,
  json = true,
} = {}) {
  if (typeof prompt !== "string" || prompt.length === 0) throw new Error("buildClineArgs requires a prompt string");
  const args = ["-P", String(profile), "-m", String(model)];
  if (reasoning) args.push("--thinking", String(reasoning));
  args.push("--auto-approve", "false");
  if (json) args.push("--json");
  if (Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) args.push("-t", String(Math.round(timeoutSeconds)));
  if (typeof cwd === "string" && cwd.length > 0) args.push("-c", cwd);
  args.push(prompt);
  return args;
}

/** A per-call isolated, empty working directory for the subprocess. */
export async function ensureProviderWorkdir(root) {
  const dir = path.join(root, "workdir");
  await mkdir(dir, { recursive: true });
  return dir;
}
/**
 * Run one CLI invocation under a hard wall-clock bound.
 *
 * Never throws for a provider-level problem: every failure mode becomes a status
 * on the returned record so the research cycle can report it and continue.
 *
 * @param {{
 *   command: string,
 *   args: string[],
 *   timeoutMs?: number,
 *   cwd?: string,
 *   env?: object,
 *   maxOutputChars?: number,
 *   spawnImpl?: Function,
 *   killGraceMs?: number,
 *   now?: () => number,
 * }} options
 */
export function runClineProcess({
  command,
  args = [],
  timeoutMs = 180_000,
  cwd = null,
  env = process.env,
  maxOutputChars = 200_000,
  spawnImpl = null,
  killGraceMs = 2_000,
  now = () => Date.now(),
} = {}) {
  const spawner = spawnImpl ?? spawn;
  return new Promise((resolve) => {
    const startedMs = now();
    const startedAt = new Date(startedMs).toISOString();
    let child;
    try {
      child = spawner(command, args, { cwd: cwd ?? undefined, env, stdio: ["ignore", "pipe", "pipe"], shell: false });
    } catch (error) {
      const completedMs = now();
      resolve({
        status: PROVIDER_STATUS.UNAVAILABLE,
        stdout: "",
        stderr: "",
        exitCode: null,
        signal: null,
        timedOut: false,
        oversized: false,
        startedAt,
        completedAt: new Date(completedMs).toISOString(),
        latencyMs: Math.max(0, completedMs - startedMs),
        failureDetail: `spawn failed: ${error?.message ?? error}`,
        executableMissing: /ENOENT|not found/i.test(String(error?.message ?? "")),
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let oversized = false;
    let timedOut = false;
    let settled = false;
    let spawnError = null;
    let killTimer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      clearTimeout(timer);
      const completedMs = now();
      resolve({
        ...result,
        startedAt,
        completedAt: new Date(completedMs).toISOString(),
        latencyMs: Math.max(0, completedMs - startedMs),
      });
    };

    const capAppend = (current, chunk) => {
      if (oversized) return current;
      const next = current + chunk;
      if (next.length > maxOutputChars) {
        oversized = true;
        try {
          child.kill("SIGTERM");
        } catch {
          /* already gone */
        }
        return next.slice(0, maxOutputChars);
      }
      return next;
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, killGraceMs);
      killTimer.unref?.();
    }, Math.max(1_000, Math.round(timeoutMs)));
    timer.unref?.();

    child.stdout?.on("data", (chunk) => {
      stdout = capAppend(stdout, chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk) => {
      stderr = capAppend(stderr, chunk.toString("utf8"));
    });

    child.on("error", (error) => {
      spawnError = error;
    });

    child.on("close", (exitCode, signal) => {
      const missing = spawnError && /ENOENT|not found/i.test(String(spawnError?.message ?? ""));

      if (timedOut) {
        finish({
          status: PROVIDER_STATUS.TIMEOUT,
          stdout,
          stderr,
          exitCode: exitCode ?? null,
          signal: signal ?? null,
          timedOut: true,
          oversized,
          failureDetail: `provider timed out after ${Math.round(timeoutMs)}ms`,
          executableMissing: false,
        });
        return;
      }
      if (spawnError) {
        finish({
          status: PROVIDER_STATUS.UNAVAILABLE,
          stdout,
          stderr,
          exitCode: exitCode ?? null,
          signal: signal ?? null,
          timedOut: false,
          oversized,
          failureDetail: missing
            ? `provider executable not found: ${command}`
            : `provider process error: ${spawnError?.message ?? spawnError}`,
          executableMissing: Boolean(missing),
        });
        return;
      }
      if (oversized) {
        finish({
          status: PROVIDER_STATUS.INVALID_OUTPUT,
          stdout: "",
          stderr: "",
          exitCode: exitCode ?? null,
          signal: signal ?? null,
          timedOut: false,
          oversized: true,
          failureDetail: `provider response exceeded ${maxOutputChars} characters`,
          executableMissing: false,
        });
        return;
      }
      if (signal) {
        finish({
          status: PROVIDER_STATUS.PROCESS_ERROR,
          stdout,
          stderr,
          exitCode: exitCode ?? null,
          signal,
          timedOut: false,
          oversized,
          failureDetail: `provider process terminated by signal ${signal}`,
          executableMissing: false,
        });
        return;
      }
      if (exitCode !== 0) {
        finish({
          status: PROVIDER_STATUS.PROCESS_ERROR,
          stdout,
          stderr,
          exitCode: exitCode ?? null,
          signal: null,
          timedOut: false,
          oversized,
          failureDetail: `provider exited with code ${exitCode}`,
          executableMissing: false,
        });
        return;
      }
      finish({
        status: PROVIDER_STATUS.OK,
        stdout,
        stderr,
        exitCode: 0,
        signal: null,
        timedOut: false,
        oversized: false,
        failureDetail: null,
        executableMissing: false,
      });
    });
  });
}
/* ============================================================================
 * Cache, replay store, and provenance
 * ==========================================================================*/

export const PROVIDER_RUNS_DIR = "runs";
export const PROVIDER_OUTPUTS_DIR = "outputs";
export const PROVIDER_CACHE_DIR = "cache";

async function writeJsonAtomic(target, value) {
  const { mkdir: mkdirFn, writeFile: writeFileFn, rename } = await import("node:fs/promises");
  await mkdirFn(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  await writeFileFn(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, target);
}

async function readJson(target, fallback = null) {
  try {
    return JSON.parse(await readFile(target, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Cache key: provider + model + reasoning + role + prompt version + evidence
 * packet version + EVIDENCE DIGEST + proposal schema version.
 *
 * The evidence digest is what makes the cache safe: a different evidence packet
 * can never hit an entry produced for another one, so a cached proposal can
 * never be replayed into a context it was not written for.
 */
export function providerCacheKey({
  provider,
  model = null,
  reasoning = null,
  role,
  promptVersion,
  evidencePacketVersion,
  evidenceDigest,
  schemaVersion = 1,
}) {
  return digestOf({
    provider: provider ?? null,
    model: model ?? null,
    reasoning: reasoning ?? null,
    role: role ?? null,
    promptVersion: promptVersion ?? null,
    evidencePacketVersion: evidencePacketVersion ?? null,
    evidenceDigest: evidenceDigest ?? null,
    schemaVersion,
  });
}

export async function readProviderCache(root, cacheKey) {
  if (!root || !cacheKey) return null;
  return readJson(path.join(root, PROVIDER_CACHE_DIR, `${cacheKey}.json`), null);
}

export async function writeProviderCache(root, cacheKey, entry) {
  if (!root || !cacheKey) return null;
  await writeJsonAtomic(path.join(root, PROVIDER_CACHE_DIR, `${cacheKey}.json`), entry);
  return entry;
}

/** Persist one provider run record (provenance only: no prompt, no output). */
export async function writeProviderRun(root, record) {
  if (!root || !record?.providerRunId) return null;
  await writeJsonAtomic(path.join(root, PROVIDER_RUNS_DIR, `${record.providerRunId}.json`), record);
  return record;
}

export async function readProviderRun(root, providerRunId) {
  if (!root || !providerRunId) return null;
  return readJson(path.join(root, PROVIDER_RUNS_DIR, `${providerRunId}.json`), null);
}

/**
 * Persist the ACCEPTED provider output so an exact proposal can be replayed
 * later without asking the model again. This is what makes it possible to tell
 * "the LLM varied" apart from "EVOLVE evaluated differently".
 */
export async function writeProviderOutput(root, { runId, proposal = null, role = null, experimentId = null, meta = {} }) {
  if (!root || !runId) return null;
  const record = {
    schemaVersion: PROVIDER_RUNTIME_VERSION,
    runId,
    experimentId,
    authorRole: role,
    proposal,
    proposalDigest: digestOf(proposal ?? null),
    savedAt: meta.savedAt ?? new Date().toISOString(),
    replayable: proposal !== null,
    note: "Saved provider output. Replaying it never calls the provider and never mutates the original artifact.",
    ...meta,
  };
  await writeJsonAtomic(path.join(root, PROVIDER_OUTPUTS_DIR, `${runId}.json`), record);
  return record;
}

export async function readProviderOutput(root, runId) {
  if (!root || !runId) return null;
  return readJson(path.join(root, PROVIDER_OUTPUTS_DIR, `${runId}.json`), null);
}

/** List persisted provider runs (id order; bounded). */
export async function listProviderRuns(root, { limit = 200 } = {}) {
  const { readdir } = await import("node:fs/promises");
  const dir = path.join(root ?? "", PROVIDER_RUNS_DIR);
  let files = [];
  try {
    files = (await readdir(dir)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const name of files.slice(0, Math.max(0, limit))) {
    const record = await readJson(path.join(dir, name), null);
    if (record) out.push(record);
  }
  return out;
}
/**
 * Build the canonical provenance record for one provider call.
 *
 * What is recorded: identity, versions, digests, timing, status, and usage.
 * What is never recorded: credentials, environment values, the raw prompt, or
 * the raw response body.
 */
export function createProviderRunRecord({
  providerRunId,
  experimentId = null,
  provider,
  model = null,
  reasoning = null,
  authorRole,
  promptVersion,
  evidencePacketVersion,
  evidenceDigest,
  promptDigest,
  rawOutputDigest = null,
  status,
  reason = null,
  cacheHit = false,
  replay = false,
  attempts = 1,
  requestStartedAt = null,
  requestCompletedAt = null,
  latencyMs = null,
  schemaValid = null,
  proposalId = null,
  usage = null,
  contextTruncated = null,
  executableMissing = false,
  oversized = false,
}) {
  return {
    schemaVersion: PROVIDER_RUNTIME_VERSION,
    providerRunId,
    experimentId,
    provider,
    model,
    reasoning,
    authorRole,
    promptVersion,
    evidencePacketVersion,
    evidenceDigest,
    promptDigest,
    rawOutputDigest,
    status,
    reason,
    cacheHit: cacheHit === true,
    replay: replay === true,
    attempts,
    requestStartedAt,
    requestCompletedAt,
    latencyMs,
    schemaValid,
    proposalId,
    usage: usage
      ? {
          inputTokens: Number.isFinite(usage.inputTokens) ? usage.inputTokens : null,
          outputTokens: Number.isFinite(usage.outputTokens) ? usage.outputTokens : null,
          totalCost: Number.isFinite(usage.totalCost) ? usage.totalCost : null,
          durationMs: Number.isFinite(usage.durationMs) ? usage.durationMs : null,
        }
      : null,
    contextTruncated: contextTruncated === true,
    executableMissing: executableMissing === true,
    oversized: oversized === true,
  };
}

/** Fields that must never appear in a dashboard/provider-state summary. */
export const PROVIDER_STATE_FORBIDDEN_FIELDS = Object.freeze([
  "prompt",
  "prompts",
  "systemPrompt",
  "rawPrompt",
  "rawOutput",
  "stdout",
  "stderr",
  "apiKey",
  "apikey",
  "key",
  "secret",
  "token",
  "authorization",
  "env",
  "environment",
]);

/**
 * Aggregate provider state for `/api/state` and the dashboard: counts and
 * identity only. The summary is derived from RUN RECORDS, which carry digests
 * rather than payloads, so there is nothing secret or enormous to leak.
 */
export function providerStateSummary({
  identity = {},
  experimentId = null,
  cacheEnabled = false,
  runs = [],
  experiment = null,
} = {}) {
  const byStatus = {};
  let cacheHits = 0;
  let schemaRejects = 0;
  let accepted = 0;
  let failures = 0;
  let latencyTotal = 0;
  let latencyCount = 0;
  const list = Array.isArray(runs) ? runs : [];

  for (const run of list) {
    const status = typeof run?.status === "string" ? run.status : "UNKNOWN";
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    if (run?.cacheHit === true) cacheHits += 1;
    if (status === PROVIDER_STATUS.SCHEMA_REJECTED) schemaRejects += 1;
    if (status === PROVIDER_STATUS.OK) accepted += 1;
    if (status !== PROVIDER_STATUS.OK) failures += 1;
    if (Number.isFinite(run?.latencyMs)) {
      latencyTotal += run.latencyMs;
      latencyCount += 1;
    }
  }

  const calls = list.length;
  return {
    provider: identity.provider ?? null,
    model: identity.model ?? null,
    reasoning: identity.reasoning ?? null,
    external: identity.external === true,
    health:
      calls === 0 ? "NO_CALLS" : failures === 0 ? "HEALTHY" : accepted === 0 ? "FAILING" : "DEGRADED",
    experimentId,
    cacheEnabled: cacheEnabled === true,
    calls,
    failures,
    cacheHits,
    acceptedProposals: experiment?.accepted ?? accepted,
    schemaRejects: experiment?.schemaRejections ?? schemaRejects,
    duplicateGenomes: experiment?.duplicateGenomes ?? null,
    lastStatus: calls > 0 ? (list[calls - 1]?.status ?? null) : null,
    lastReason: calls > 0 ? (list[calls - 1]?.reason ?? null) : null,
    meanLatencyMs: latencyCount > 0 ? Math.round(latencyTotal / latencyCount) : null,
    byStatus,
    sample: list.slice(-3).map((run) => ({
      providerRunId: run?.providerRunId ?? null,
      authorRole: run?.authorRole ?? null,
      status: run?.status ?? null,
      latencyMs: run?.latencyMs ?? null,
      cacheHit: run?.cacheHit === true,
      evidenceDigest: run?.evidenceDigest ?? null,
    })),
    watchdog: experiment?.watchdog ?? null,
    note: "Provider state is counts and identity only: no prompts, no raw output, no credentials.",
    formatVersion: RESEARCH_PROVIDER_FORMAT_VERSION,
  };
}

/** True when a provider status means the call did not produce a proposal. */
export function isProviderFailure(status) {
  return !status || status !== PROVIDER_STATUS.OK;
}

/** Redact any candidate secret from text destined for a log or an artifact. */
export function safeDiagnostic(text, secrets = []) {
  return scrubOutput(text ?? "", secrets).slice(0, 2_000);
}

const FENCE_PATTERN = /```(?:json|JSON)?\s*\n([\s\S]*?)```/g;