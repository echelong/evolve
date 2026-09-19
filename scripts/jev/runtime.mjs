/**
 * Jev provider runtime (Phase 5D): HTTP call wrapper, answer normalization,
 * cache, run budget, and provenance. Shared by both providers (`mock-jev`,
 * `typesafe-jev`), the probe, the CLI, and the validators.
 *
 * Security posture, in one sentence: Jev is ONLY an HTTPS decision-API client.
 * This module never spawns a process, never touches the filesystem outside its
 * own `.evolve/jev/` artifacts, never reads a wallet/key, and never executes
 * anything Jev returns — an answer is normalized into a plain typed record,
 * nothing more.
 *
 * PAPER ONLY.
 */

import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { digestOf } from "../lib/hash.mjs";
import { redactSecrets } from "../lib/sanitize.mjs";
import { JEV_STATUS } from "./config.mjs";

export const JEV_RUNTIME_VERSION = 1;

/* ============================================================================
 * Cache identity
 * ==========================================================================*/

/**
 * Cache identity: provider + model + decisionPacketVersion + questionSetVersion
 * + stateDigest + questionDigest. This is what makes the cache SAFE: a
 * different packet or a different question wording can never hit an entry
 * produced for another one (the Phase 5B.2 slot-identity bug is exactly the
 * class of mistake this guards against — see provider-runtime.mjs there).
 */
export function jevCacheKey({
  provider,
  model = null,
  decisionPacketVersion,
  questionSetId,
  questionSetVersion,
  stateDigest,
  questionDigest,
}) {
  return digestOf({
    provider: provider ?? null,
    model: model ?? null,
    decisionPacketVersion: decisionPacketVersion ?? null,
    questionSetId: questionSetId ?? null,
    questionSetVersion: questionSetVersion ?? null,
    stateDigest: stateDigest ?? null,
    questionDigest: questionDigest ?? null,
  });
}

/* ============================================================================
 * Run budget
 * ==========================================================================*/

/**
 * A run-level maximum call budget. Failures consume ATTEMPTED-call budget
 * (they still went to the network); cache hits do NOT (zero network calls).
 */
export function createJevRunBudget(max) {
  const limit = Math.max(1, Math.round(Number(max) || 1));
  let used = 0;
  return {
    max: limit,
    get used() {
      return used;
    },
    get remaining() {
      return Math.max(0, limit - used);
    },
    exhausted() {
      return used >= limit;
    },
    /** Call exactly once per ATTEMPTED live call (never for a cache hit). */
    consume() {
      used += 1;
      return used <= limit;
    },
  };
}

/* ============================================================================
 * Answer normalization
 * ==========================================================================*/

/**
 * Normalize one SDK-shaped answer (`NoulResponse` / `ChoiceResponse` /
 * `ScoreResponse`) into EVOLVE's persisted internal shape. The mock provider
 * produces this SAME shape directly, so downstream code never branches on
 * which provider answered.
 */
export function normalizeAnswer(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.type === "noul") {
    return {
      type: "noul",
      probability: Number.isFinite(raw.noul) ? raw.noul : null,
    };
  }
  if (raw.type === "choice") {
    return {
      type: "choice",
      choice: typeof raw.choice === "string" ? raw.choice : null,
      confidence: Number.isFinite(raw.confidence) ? raw.confidence : null,
      probabilities: raw.probabilities && typeof raw.probabilities === "object" ? { ...raw.probabilities } : {},
    };
  }
  if (raw.type === "score") {
    return {
      type: "score",
      score: Number.isFinite(raw.score) ? raw.score : null,
      confidence: Number.isFinite(raw.confidence) ? raw.confidence : null,
      legend: raw.legend && typeof raw.legend === "object" ? { ...raw.legend } : {},
      probabilities: raw.probabilities && typeof raw.probabilities === "object" ? { ...raw.probabilities } : {},
    };
  }
  return null;
}

/** Normalize every answer in a `{ name: answer }` map. Unknown/malformed entries become `null`. */
export function normalizeAnswers(rawAnswers) {
  const out = {};
  for (const [name, raw] of Object.entries(rawAnswers ?? {})) out[name] = normalizeAnswer(raw);
  return out;
}

/**
 * Structural validation: does this look like a well-formed answer set for the
 * given question names? Never throws — a malformed response is a STATUS
 * (`JEV_INVALID_RESPONSE`), never an unhandled exception reaching the caller.
 */
export function validateAnswers(answers, expectedNames) {
  if (!answers || typeof answers !== "object") return { ok: false, reason: "answers is not an object" };
  for (const name of expectedNames) {
    const answer = answers[name];
    if (!answer || typeof answer !== "object") return { ok: false, reason: `missing answer for '${name}'` };
    if (answer.type === "noul" && !Number.isFinite(answer.probability)) {
      return { ok: false, reason: `'${name}' noul answer has no finite probability` };
    }
    if (answer.type === "choice" && typeof answer.choice !== "string") {
      return { ok: false, reason: `'${name}' choice answer has no selected label` };
    }
    if (answer.type === "score" && !Number.isFinite(answer.score)) {
      return { ok: false, reason: `'${name}' score answer has no finite score` };
    }
    if (!["noul", "choice", "score"].includes(answer.type)) {
      return { ok: false, reason: `'${name}' answer has an unrecognized type '${answer?.type}'` };
    }
  }
  return { ok: true, reason: null };
}

/* ============================================================================
 * Provenance
 * ==========================================================================*/

/**
 * Build the canonical provenance record for one Jev provider call.
 *
 * What is recorded: identity, versions, digests, timing, status, answers, and
 * usage. What is NEVER recorded: the API key, Authorization headers, unbounded
 * raw application state, or any other secret.
 */
export function createJevRunRecord({
  jevRunId,
  experimentId = null,
  provider,
  model = null,
  requestId = null,
  decisionPacketVersion,
  questionSetId,
  questionSetVersion,
  stateDigest,
  questionDigest,
  startedAt,
  completedAt,
  latencyMs,
  status,
  reason = null,
  cacheHit = false,
  usage = null,
  answers = null,
  rawResponseDigest = null,
}) {
  return {
    schemaVersion: JEV_RUNTIME_VERSION,
    jevRunId,
    experimentId,
    provider,
    model,
    requestId,
    decisionPacketVersion,
    questionSetId,
    questionSetVersion,
    stateDigest,
    questionDigest,
    startedAt,
    completedAt,
    latencyMs: Number.isFinite(latencyMs) ? latencyMs : null,
    status,
    reason,
    cacheHit: cacheHit === true,
    usage: usage
      ? {
          inputTokens: Number.isFinite(usage.input_tokens ?? usage.inputTokens) ? usage.input_tokens ?? usage.inputTokens : null,
          outputTokens: Number.isFinite(usage.output_tokens ?? usage.outputTokens) ? usage.output_tokens ?? usage.outputTokens : null,
        }
      : null,
    answers,
    rawResponseDigest,
  };
}

/** True when a Jev status means no decision was produced. */
export function isJevFailure(status) {
  return !status || status !== JEV_STATUS.OK;
}

/** Redact any candidate secret from text destined for a log, artifact, or dashboard. */
export function safeDiagnostic(text, secrets = []) {
  return redactSecrets(String(text ?? ""), secrets).slice(0, 2_000);
}

/* ============================================================================
 * Persistence (atomic JSON, mirrors research/provider-runtime.mjs conventions)
 * ==========================================================================*/

export const JEV_RUNS_DIR = path.join("provider", "runs");
export const JEV_CACHE_DIR = path.join("provider", "cache");

async function writeJsonAtomic(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, target);
}

async function readJson(target, fallback = null) {
  try {
    return JSON.parse(await readFile(target, "utf8"));
  } catch {
    return fallback;
  }
}

export async function readJevCache(root, cacheKey) {
  if (!root || !cacheKey) return null;
  return readJson(path.join(root, JEV_CACHE_DIR, `${cacheKey}.json`), null);
}

export async function writeJevCache(root, cacheKey, entry) {
  if (!root || !cacheKey) return null;
  await writeJsonAtomic(path.join(root, JEV_CACHE_DIR, `${cacheKey}.json`), entry);
  return entry;
}

export async function writeJevProviderRun(root, record) {
  if (!root || !record?.jevRunId) return null;
  await writeJsonAtomic(path.join(root, JEV_RUNS_DIR, `${record.jevRunId}.json`), record);
  return record;
}

export async function readJevProviderRun(root, jevRunId) {
  if (!root || !jevRunId) return null;
  return readJson(path.join(root, JEV_RUNS_DIR, `${jevRunId}.json`), null);
}

/** List persisted Jev provider runs (bounded, id-sorted). */
export async function listJevProviderRuns(root, { limit = 500 } = {}) {
  const dir = path.join(root ?? "", JEV_RUNS_DIR);
  let files = [];
  try {
    files = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
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

/** Fields that must never appear in a dashboard/provider-state summary. */
export const JEV_STATE_FORBIDDEN_FIELDS = Object.freeze([
  "apiKey",
  "apikey",
  "key",
  "secret",
  "token",
  "authorization",
  "env",
  "environment",
  "state",
  "questions",
  "rawResponse",
]);

/**
 * Aggregate Jev provider state for `/api/state` and the dashboard: counts and
 * identity only. Derived from RUN RECORDS (which carry digests, never raw
 * state/prompts), so there is nothing secret or enormous to leak.
 */
export function jevStateSummary({ identity = {}, mode = "shadow", experimentId = null, cacheEnabled = false, runs = [], calibration = null } = {}) {
  const list = Array.isArray(runs) ? runs : [];
  const byStatus = {};
  let cacheHits = 0;
  let failures = 0;
  let latencyTotal = 0;
  let latencyCount = 0;

  for (const run of list) {
    const status = typeof run?.status === "string" ? run.status : "UNKNOWN";
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    if (run?.cacheHit === true) cacheHits += 1;
    if (status !== JEV_STATUS.OK) failures += 1;
    if (Number.isFinite(run?.latencyMs)) {
      latencyTotal += run.latencyMs;
      latencyCount += 1;
    }
  }

  const calls = list.length;
  const decisionCount = list.filter((run) => run?.status === JEV_STATUS.OK).length;

  return {
    provider: identity.provider ?? null,
    model: identity.model ?? null,
    mode,
    health: calls === 0 ? "NO_CALLS" : failures === 0 ? "HEALTHY" : decisionCount === 0 ? "FAILING" : "DEGRADED",
    experimentId,
    cacheEnabled: cacheEnabled === true,
    calls,
    failures,
    cacheHits,
    decisionCount,
    meanLatencyMs: latencyCount > 0 ? Math.round(latencyTotal / latencyCount) : null,
    byStatus,
    lastStatus: calls > 0 ? (list[calls - 1]?.status ?? null) : null,
    lastDecisionAt: calls > 0 ? (list[calls - 1]?.completedAt ?? null) : null,
    calibrationCount: calibration?.predictionCount ?? null,
    brierScore: calibration?.gateFailureRisk?.brierScore ?? null,
    note:
      "Jev is a SHADOW decision supervisor: counts and identity only, no prompts/state/API key. Jev has zero " +
      "authority over trading, evolution, Arena, or deployment.",
    formatVersion: JEV_RUNTIME_VERSION,
  };
}
