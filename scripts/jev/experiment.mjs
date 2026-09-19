/**
 * Jev experiment storage (Phase 5D).
 *
 * An isolated root per experiment, entirely separate from every other EVOLVE
 * artifact tree:
 *
 *   .evolve/jev/experiments/<experiment-id>/
 *     experiment.json          metadata + counters (provider, model, mode, versions)
 *     decisions/*.json         one immutable prediction per candidate/window,
 *                              timestamped BEFORE any outcome exists
 *     outcomes/*.json          later deterministic Arena outcomes, joined to a
 *                              decision by id only (never re-derived from Jev)
 *     calibration.json         the most recent offline calibration report
 *     provider/runs/*.json     raw call provenance (see scripts/jev/runtime.mjs)
 *     provider/cache/*.json    cached answers, keyed by full cache identity
 *
 * This module never writes into `.evolve/research/` and never mutates a prior
 * Arena artifact — it only ever creates files under its own `.evolve/jev/`
 * root.
 *
 * PAPER ONLY.
 */

import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { digestOf } from "../lib/hash.mjs";
import { sanitizeForPublic } from "../lib/sanitize.mjs";
import { boundedProviderAttempts } from "./transport.mjs";

export const JEV_EXPERIMENT_VERSION = 1;
export const JEV_ROOT_DIR = path.join(".evolve", "jev");
export const JEV_EXPERIMENTS_DIR = path.join(JEV_ROOT_DIR, "experiments");
export const JEV_EXPERIMENT_FILE = "experiment.json";
export const JEV_DECISIONS_SUBDIR = "decisions";
export const JEV_OUTCOMES_SUBDIR = "outcomes";
export const JEV_CALIBRATION_FILE = "calibration.json";

/** Compact UTC stamp, matching the Arena/research experiment id convention. */
export function compactStamp(ms = Date.now()) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/**
 * Deterministic, filesystem-safe Jev experiment id. Distinct prefix
 * (`jexp-`) so it can never collide with, or be mistaken for, a research
 * experiment id (`exp-...`) or an Arena id.
 */
export function jevExperimentIdFor({ provider = "disabled", startedAt = Date.now(), salt = "" } = {}) {
  const stamp = compactStamp(startedAt);
  const suffix = digestOf({ provider, salt }).slice(0, 6);
  return `jexp-${stamp}-${provider}-${suffix}`;
}

export function isValidJevExperimentId(experimentId) {
  return typeof experimentId === "string" && /^jexp-[A-Za-z0-9][A-Za-z0-9._-]{0,140}$/.test(experimentId);
}

/** Resolve an experiment's isolated root. Never resolves outside `.evolve/jev/experiments/`. */
export function jevExperimentRootFor(baseRoot, experimentId) {
  if (!isValidJevExperimentId(experimentId)) throw new Error(`invalid Jev experiment id '${experimentId}'`);
  return path.join(baseRoot ?? JEV_EXPERIMENTS_DIR, experimentId);
}

export function createJevExperiment({
  experimentId,
  provider,
  model = null,
  mode = "shadow",
  decisionPacketVersion,
  questionSetId,
  questionSetVersion,
  cacheEnabled = false,
  maxCallsPerRun = null,
  startedAt = Date.now(),
}) {
  return {
    schemaVersion: JEV_EXPERIMENT_VERSION,
    experimentId,
    provider,
    model,
    mode,
    decisionPacketVersion,
    questionSetId,
    questionSetVersion,
    cacheEnabled: cacheEnabled === true,
    maxCallsPerRun,
    startedAt: new Date(startedAt).toISOString(),
    updatedAt: null,
    status: "RUNNING",
    counters: {
      decisionsRequested: 0,
      decisionsOk: 0,
      decisionsFailed: 0,
      cacheHits: 0,
      byStatus: {},
      outcomesJoined: 0,
    },
    note:
      "SHADOW ONLY. Jev has zero authority over trading, genome construction, research compilation, evolution, " +
      "Arena scoring, gates, species matching, DeepSeek calls, deployment eligibility, or replication.",
  };
}

/** Merge one decision's run status into experiment counters. Pure. */
export function accumulateJevCounters(counters, run) {
  const next = JSON.parse(JSON.stringify(counters ?? {}));
  next.byStatus = next.byStatus ?? {};
  next.decisionsRequested = (next.decisionsRequested ?? 0) + 1;
  const status = typeof run?.status === "string" ? run.status : "UNKNOWN";
  next.byStatus[status] = (next.byStatus[status] ?? 0) + 1;
  if (status === "JEV_OK") next.decisionsOk = (next.decisionsOk ?? 0) + 1;
  else next.decisionsFailed = (next.decisionsFailed ?? 0) + 1;
  if (run?.cacheHit === true) next.cacheHits = (next.cacheHits ?? 0) + 1;
  return next;
}

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

export async function writeJevExperiment(root, experiment) {
  if (!root || !experiment?.experimentId) return null;
  const record = sanitizeForPublic({ ...experiment, updatedAt: new Date().toISOString() });
  await writeJsonAtomic(path.join(root, JEV_EXPERIMENT_FILE), record);
  return record;
}

export async function readJevExperiment(root) {
  return readJson(path.join(root ?? "", JEV_EXPERIMENT_FILE), null);
}

export async function listJevExperiments(baseRoot = JEV_EXPERIMENTS_DIR) {
  let entries = [];
  try {
    entries = await readdir(baseRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const experiment = await readJevExperiment(path.join(baseRoot, entry.name));
    if (experiment) out.push(experiment);
  }
  return out;
}

/* ============================================================================
 * Decisions (immutable predictions, timestamped BEFORE any outcome exists)
 * ==========================================================================*/

export function jevDecisionIdFor({ experimentId, packetKind, subjectDigest, questionSetId }) {
  const digest = digestOf({ experimentId, packetKind, subjectDigest, questionSetId }).slice(0, 16);
  return `JD-${digest}`;
}

/**
 * Build the persisted decision record: everything calibration will later need
 * to join against an outcome, and NOTHING that could only be known afterward.
 */
export function buildJevDecisionRecord({
  decisionId,
  experimentId,
  packetKind,
  subjectDigest,
  questionSetId,
  questionSetVersion,
  decisionPacketVersion,
  stateDigest,
  jevRunId,
  provider,
  model,
  status,
  answers,
  syntheticDecision = false,
  deterministicComparators = {},
  predictedAt,
  providerAttempts = null,
  providerAttemptCount = null,
}) {
  // Transport provenance travels WITH the decision, so a later offline
  // calibration can stratify by transport ("Vercel Gateway → TypeSafe Jev" is
  // NOT byte-identical provenance to "direct TypeSafe API → Jev") without ever
  // re-reading the provider run logs.
  const attempts = Array.isArray(providerAttempts) ? boundedProviderAttempts(providerAttempts) : null;
  return {
    schemaVersion: JEV_EXPERIMENT_VERSION,
    decisionId,
    experimentId,
    packetKind,
    subjectDigest,
    questionSetId,
    questionSetVersion,
    decisionPacketVersion,
    stateDigest,
    jevRunId,
    provider,
    model,
    status,
    answers,
    syntheticDecision: syntheticDecision === true,
    // Fields EVOLVE already knows deterministically at prediction time (e.g. the
    // classifier's regime label for the market question set) — recorded here so
    // an offline shadow comparison never needs to re-derive them later, but
    // NEVER anything that depends on an outcome that has not happened yet.
    deterministicComparators: { ...deterministicComparators },
    predictedAt,
    providerAttemptCount: attempts
      ? attempts.length
      : Number.isFinite(providerAttemptCount)
        ? Math.max(0, Math.round(providerAttemptCount))
        : null,
    providerAttempts: attempts,
    immutable: true,
  };
}

export async function writeJevDecision(root, decision) {
  if (!root || !decision?.decisionId) return null;
  await writeJsonAtomic(path.join(root, JEV_DECISIONS_SUBDIR, `${decision.decisionId}.json`), decision);
  return decision;
}

export async function readJevDecision(root, decisionId) {
  return readJson(path.join(root ?? "", JEV_DECISIONS_SUBDIR, `${decisionId}.json`), null);
}

export async function listJevDecisions(root) {
  const dir = path.join(root ?? "", JEV_DECISIONS_SUBDIR);
  let files = [];
  try {
    files = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const name of files) {
    const decision = await readJson(path.join(dir, name), null);
    if (decision) out.push(decision);
  }
  return out;
}

/* ============================================================================
 * Outcomes (later deterministic results, joined by decisionId only)
 * ==========================================================================*/

export function buildJevOutcomeRecord({ decisionId, arenaId = null, gateResult = null, recordedAt, note = null }) {
  return {
    schemaVersion: JEV_EXPERIMENT_VERSION,
    decisionId,
    arenaId,
    // `gateResult` is whatever `evaluateSurvivalGates()` produced for this
    // candidate: { status, gates: [{label, pass, detail}], passed, failed, total }.
    gateResult,
    recordedAt,
    note,
  };
}

export async function writeJevOutcome(root, outcome) {
  if (!root || !outcome?.decisionId) return null;
  await writeJsonAtomic(path.join(root, JEV_OUTCOMES_SUBDIR, `${outcome.decisionId}.json`), outcome);
  return outcome;
}

export async function readJevOutcome(root, decisionId) {
  return readJson(path.join(root ?? "", JEV_OUTCOMES_SUBDIR, `${decisionId}.json`), null);
}

export async function listJevOutcomes(root) {
  const dir = path.join(root ?? "", JEV_OUTCOMES_SUBDIR);
  let files = [];
  try {
    files = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const name of files) {
    const outcome = await readJson(path.join(dir, name), null);
    if (outcome) out.push(outcome);
  }
  return out;
}

/* ============================================================================
 * Calibration report persistence
 * ==========================================================================*/

export async function writeJevCalibration(root, calibration) {
  if (!root) return null;
  await writeJsonAtomic(path.join(root, JEV_CALIBRATION_FILE), calibration);
  return calibration;
}

export async function readJevCalibration(root) {
  return readJson(path.join(root ?? "", JEV_CALIBRATION_FILE), null);
}
