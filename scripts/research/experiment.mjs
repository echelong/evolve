/**
 * Research experiment identity (Phase 5B).
 *
 * An experiment is the unit that keeps provider runs from mixing:
 *
 *   .evolve/research/experiments/<experiment-id>/      provider-isolated root
 *     experiment.json                                  metadata + counters
 *     proposals/  compiled/  memory/  conclusions.json  the usual research memory
 *     provider/   runs/  outputs/  cache/  workdir/     provider artifacts
 *
 * The canonical mock baseline (`.evolve/arenas/arena-20260918T081727Z`) and the
 * existing `.evolve/research` memory are never touched by this module: a
 * provider experiment gets its own root, and the Arena reads it by pointing
 * `EVOLVE_RESEARCH_ROOT` at that root. Nothing is reinterpreted retrospectively.
 *
 * PAPER ONLY research machinery.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { digestOf } from "../lib/hash.mjs";
import { sanitizeForPublic } from "../lib/sanitize.mjs";
import { ALLOWED_RESEARCH_EVIDENCE_CLASSES, EXCLUDED_RESEARCH_EVIDENCE_CLASSES } from "./evidence-packet.mjs";

export const RESEARCH_EXPERIMENT_VERSION = 1;
export const RESEARCH_EXPERIMENTS_DIR = path.join(".evolve", "research", "experiments");
export const EXPERIMENT_FILE = "experiment.json";

/** Compact UTC stamp: 20260918T101530Z (matches the Arena id convention). */
export function compactStamp(ms = Date.now()) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Deterministic, filesystem-safe experiment id. */
export function researchExperimentIdFor({ provider = "mock", startedAt = Date.now(), datasetIds = [] } = {}) {
  const stamp = compactStamp(startedAt);
  const datasetTag = (Array.isArray(datasetIds) ? datasetIds : []).filter(Boolean).join(",");
  const suffix = digestOf({ provider, datasetTag }).slice(0, 6);
  return `exp-${stamp}-${provider}-${suffix}`;
}

/** Is this a well-formed experiment id (no paths, no traversal)? */
export function isValidExperimentId(experimentId) {
  return typeof experimentId === "string" && /^exp-[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(experimentId);
}

/** Resolve an experiment's isolated research root. */
export function experimentRootFor(baseRoot, experimentId) {
  if (!isValidExperimentId(experimentId)) throw new Error(`invalid research experiment id '${experimentId}'`);
  return path.join(baseRoot ?? path.join(".evolve", "research"), "experiments", experimentId);
}

/**
 * Create the experiment metadata object. Provider runs are NOT embedded here —
 * only their ids — so the metadata stays small.
 */
export function createResearchExperiment({
  experimentId,
  provider,
  model = null,
  reasoning = null,
  providerFormatVersion = null,
  promptVersion,
  evidencePacketVersion,
  evidenceDigest = null,
  datasetRefs = [],
  seed = null,
  startedAt = Date.now(),
  limits = {},
  rolePlan = [],
}) {
  return {
    schemaVersion: RESEARCH_EXPERIMENT_VERSION,
    experimentId,
    provider,
    model,
    reasoning,
    providerFormatVersion,
    promptVersion,
    evidencePacketVersion,
    evidenceDigest,
    evidenceClasses: [...ALLOWED_RESEARCH_EVIDENCE_CLASSES],
    excludedEvidenceClasses: [...EXCLUDED_RESEARCH_EVIDENCE_CLASSES],
    datasetIds: (Array.isArray(datasetRefs) ? datasetRefs : []).map((row) => row?.id ?? null).filter(Boolean),
    datasetFingerprints: (Array.isArray(datasetRefs) ? datasetRefs : [])
      .map((row) => row?.fingerprint ?? null)
      .filter(Boolean),
    seed,
    rolePlan: [...(Array.isArray(rolePlan) ? rolePlan : [])],
    startedAt: new Date(startedAt).toISOString(),
    updatedAt: null,
    completedAt: null,
    status: "RUNNING",
    limits: {
      maxContextChars: limits.maxContextChars ?? null,
      maxMemoryRecords: limits.maxMemoryRecords ?? null,
      maxProviderCalls: limits.maxProviderCalls ?? null,
      cacheEnabled: limits.cacheEnabled === true,
      timeoutMs: limits.timeoutMs ?? null,
      maxAttemptsPerCall: limits.maxAttemptsPerCall ?? null,
    },
    request: null,
    counters: {
      cyclesRequested: 0,
      cyclesCompleted: 0,
      proposalsRequested: 0,
      proposalsReturned: 0,
      schemaValid: 0,
      schemaRejections: 0,
      compilerAccepted: 0,
      compilerRejections: 0,
      duplicateGenomes: 0,
      uniqueGenomes: 0,
      // `providerCalls` (kept for backward compatibility) and its clearer
      // synonym `providerSlots` both count every RUN RECORD — a live
      // subprocess attempt, a cache hit, AND a BUDGET_EXCEEDED refusal each
      // add one. `providerFailures` here likewise counts every non-OK
      // record, refusals included. None of these three distinguish "the
      // subprocess actually ran" from "a cache entry answered instead" —
      // that is what `attemptedProviderCalls`/`successfulProviderCalls`/
      // `failedProviderCalls` below are for (Phase 5B.1), and `cacheHits`
      // is what explains any gap between `providerSlots` and
      // `attemptedProviderCalls` (Phase 5B.2).
      providerCalls: 0,
      providerSlots: 0,
      providerFailures: 0,
      cacheHits: 0,
      // Phase 5B.1: the precise, unambiguous run-level call accounting — set at
      // finalize by `generateResearchCohort` from the shared run budget.
      // These count ONLY real subprocess attempts: never a cache hit, a
      // replay, or a BUDGET_EXCEEDED refusal.
      attemptedProviderCalls: 0,
      successfulProviderCalls: 0,
      failedProviderCalls: 0,
      budgetRemaining: null,
      callsByCycle: {},
      providerStatuses: {},
      speciesDistribution: {},
      familyDistribution: {},
      roleDistribution: {},
      watchdog: { NORMAL: 0, WATCH: 0, QUARANTINED: 0 },
    },
    providerRunIds: [],
    notes: [],
  };
}

function bump(map, key, count = 1) {
  if (typeof key !== "string" || key.length === 0) return;
  map[key] = (map[key] ?? 0) + count;
}

/**
 * Merge cycle results and the provider runs they produced into the experiment
 * counters. Pure: returns a new counters object.
 */
export function accumulateExperimentCounters({
  counters,
  cycleResults = [],
  providerRuns = [],
  proposalsReturned = 0,
  proposalsRequested = 0,
} = {}) {
  const next = JSON.parse(JSON.stringify(counters ?? {}));
  next.providerStatuses = next.providerStatuses ?? {};
  next.speciesDistribution = next.speciesDistribution ?? {};
  next.familyDistribution = next.familyDistribution ?? {};
  next.roleDistribution = next.roleDistribution ?? {};
  next.watchdog = next.watchdog ?? { NORMAL: 0, WATCH: 0, QUARANTINED: 0 };

  next.proposalsRequested = (next.proposalsRequested ?? 0) + Math.max(0, proposalsRequested);
  next.proposalsReturned = (next.proposalsReturned ?? 0) + Math.max(0, proposalsReturned);

  for (const run of Array.isArray(providerRuns) ? providerRuns : []) {
    next.providerCalls = (next.providerCalls ?? 0) + 1;
    // `providerSlots` is the unambiguous name for the same count (Phase
    // 5B.2): one entry per LOGICAL proposal slot attempted — live call,
    // cache hit, or budget refusal alike. Kept alongside `providerCalls`
    // (not instead of it) so nothing that already reads `providerCalls`
    // breaks; new code should prefer `providerSlots` for clarity.
    next.providerSlots = (next.providerSlots ?? 0) + 1;
    const status = typeof run?.status === "string" ? run.status : "UNKNOWN";
    bump(next.providerStatuses, status);
    if (status !== "PROVIDER_OK") next.providerFailures = (next.providerFailures ?? 0) + 1;
    if (run?.cacheHit === true) next.cacheHits = (next.cacheHits ?? 0) + 1;
  }

  for (const result of Array.isArray(cycleResults) ? cycleResults : []) {
    next.cyclesCompleted = (next.cyclesCompleted ?? 0) + 1;
    next.schemaValid = (next.schemaValid ?? 0) + (result?.accepted ?? 0);
    next.schemaRejections = (next.schemaRejections ?? 0) + (result?.rejectedSchema?.length ?? 0);
    next.compilerAccepted = (next.compilerAccepted ?? 0) + (result?.compiled?.length ?? 0);
    next.compilerRejections =
      (next.compilerRejections ?? 0) +
      (result?.rejectedCompile ?? []).filter((row) => row?.code !== "DUPLICATE_GENOME").length;
    next.duplicateGenomes = (next.duplicateGenomes ?? 0) + (result?.rejectedDuplicates ?? 0);
    next.uniqueGenomes = (next.uniqueGenomes ?? 0) + (result?.uniqueGenomes ?? 0);
    for (const [species, count] of Object.entries(result?.speciesDistribution ?? {})) {
      bump(next.speciesDistribution, species, count);
    }
    for (const [role, count] of Object.entries(result?.roleDistribution ?? {})) {
      bump(next.roleDistribution, role, count);
    }
    for (const entry of result?.compiled ?? []) bump(next.familyDistribution, entry?.family ?? null);
    for (const [verdict, count] of Object.entries(result?.watchdogVerdicts ?? {})) {
      if (next.watchdog[verdict] !== undefined) next.watchdog[verdict] += count;
    }
  }

  return next;
}

/** Deterministic digest of an experiment's research content (not its clock). */
export function experimentDigest(experiment) {
  return digestOf({
    experimentId: experiment?.experimentId ?? null,
    provider: experiment?.provider ?? null,
    model: experiment?.model ?? null,
    reasoning: experiment?.reasoning ?? null,
    promptVersion: experiment?.promptVersion ?? null,
    evidenceDigest: experiment?.evidenceDigest ?? null,
    counters: experiment?.counters ?? null,
  });
}

/* ============================================================================
 * Persistence
 * ==========================================================================*/

async function writeJsonAtomic(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  const { rename } = await import("node:fs/promises");
  await rename(tmp, target);
}

/** Write experiment metadata (sanitized: no secrets can reach the artifact). */
export async function writeResearchExperiment(root, experiment) {
  if (!root || !experiment?.experimentId) return null;
  const record = sanitizeForPublic({ ...experiment, updatedAt: new Date().toISOString() });
  await writeJsonAtomic(path.join(root, EXPERIMENT_FILE), record);
  return record;
}

export async function readResearchExperiment(root) {
  try {
    return JSON.parse(await readFile(path.join(root ?? "", EXPERIMENT_FILE), "utf8"));
  } catch {
    return null;
  }
}

/** Compact experiment block used by Arena summaries and dashboards. */
export function researchExperimentSummary(experiment) {
  if (!experiment) return null;
  return {
    experimentId: experiment.experimentId ?? null,
    provider: experiment.provider ?? null,
    model: experiment.model ?? null,
    reasoning: experiment.reasoning ?? null,
    promptVersion: experiment.promptVersion ?? null,
    evidencePacketVersion: experiment.evidencePacketVersion ?? null,
    evidenceDigest: experiment.evidenceDigest ?? null,
    evidenceClasses: [...(experiment.evidenceClasses ?? [])],
    datasetIds: [...(experiment.datasetIds ?? [])],
    status: experiment.status ?? null,
    startedAt: experiment.startedAt ?? null,
    completedAt: experiment.completedAt ?? null,
    counters: experiment.counters ? { ...experiment.counters } : null,
  };
}

/** List persisted experiments under a base research root (id-sorted). */
export async function listResearchExperiments(baseRoot = path.join(".evolve", "research")) {
  const dir = path.join(baseRoot, "experiments");
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const experiment = await readResearchExperiment(path.join(dir, entry.name));
    if (experiment) out.push(experiment);
  }
  return out;
}
