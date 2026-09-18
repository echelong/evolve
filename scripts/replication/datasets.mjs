/**
 * Phase 5C — dataset discovery, independence, eligibility, and the leakage
 * matrix (PAPER ONLY).
 *
 * The replication unit is a DATASET. This module answers, before anything is
 * evaluated and without looking at a single strategy metric:
 *
 *   * which historical datasets exist, and which are genuinely REAL;
 *   * which are invalid/incomplete (a `-live` directory is NOT automatically
 *     valid — its manifest and contents are validated);
 *   * which are fingerprint-identical duplicates (they count once);
 *   * how much every pair of REAL captures temporally overlaps (overlapping
 *     captures are never treated as independent replications);
 *   * which are eligible for the primary replication sample under criteria
 *     declared in `constants.mjs`;
 *   * which (cohort × dataset) pairs are DEVELOPMENT / CONTAMINATED /
 *     CLEAN_REPLICATION / UNKNOWN.
 *
 * `synthetic` evidence is never counted as real. `walk-forward windows` from one
 * capture are NOT independent datasets, and this module never manufactures extra
 * datasets by slicing one capture.
 *
 * Read-only. No provider call, no trading, no execution path.
 */

import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { listDatasets, readManifest, fingerprintDataset } from "../history/dataset.mjs";
import { digestOf } from "../lib/hash.mjs";
import {
  DATASET_CLASS,
  DATASET_ROLE,
  DEVELOPMENT_DATASET_IDS,
  ELIGIBILITY_CRITERIA,
  ELIGIBILITY_CRITERIA_TEXT,
  FROZEN_COHORT_KEYS,
  LEAKAGE_CLASS,
} from "./constants.mjs";

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

const HEX64 = /^[0-9a-f]{64}$/;

/** A valid, complete, REAL/eligible-agnostic dataset record candidate. */
export function emptyDatasetRecord(overrides = {}) {
  return {
    datasetId: null,
    dir: null,
    day: null,
    sessionId: null,
    manifestPresent: false,
    snapshotPresent: false,
    eventPresent: false,
    classification: DATASET_CLASS.INVALID,
    complete: false,
    valid: false,
    invalidReasons: [],
    fingerprint: null,
    fingerprintSource: null,
    fingerprintValid: false,
    source: null,
    requestedMode: null,
    effectiveMode: null,
    captureMs: null,
    engineVersion: null,
    gitCommit: null,
    status: null,
    dataClass: null,
    containsSynthetic: false,
    containsLive: false,
    usableForRealMarketReplay: false,
    startMs: null,
    endMs: null,
    durationMs: null,
    durationMinutes: null,
    snapshotCount: null,
    observations: null,
    uniqueMints: null,
    eventCount: null,
    feedErrors: null,
    rateLimits: null,
    stalePeriods: null,
    snapshotIntervalMs: null,
    ...overrides,
  };
}

/**
 * Build a rich dataset record from one session directory.
 *
 * Fingerprints are taken from the manifest when the recorder already wrote one
 * (fast) and computed only when they are missing.
 */
export async function loadDatasetRecord({ dir, day = null, sessionId = null, manifest = undefined } = {}) {
  const manifestPresent = await exists(path.join(dir, "manifest.json"));
  const snapshotPresent = await exists(path.join(dir, "snapshots.ndjson"));
  const eventPresent = await exists(path.join(dir, "events.ndjson"));

  const resolved = manifest !== undefined ? manifest : await readManifest(dir);
  const invalidReasons = [];

  let fingerprint = typeof resolved?.fingerprint?.combined === "string" ? resolved.fingerprint.combined : null;
  let fingerprintSource = fingerprint ? "manifest" : null;
  if (!fingerprint) {
    const computed = await fingerprintDataset(dir).catch(() => null);
    if (typeof computed?.combined === "string") {
      fingerprint = computed.combined;
      fingerprintSource = "computed";
    }
  }

  if (!manifestPresent) invalidReasons.push("no manifest.json");
  if (!snapshotPresent) invalidReasons.push("no snapshots.ndjson");

  const startMs = Number.isFinite(resolved?.firstObservedAt) ? resolved.firstObservedAt : null;
  const endMs = Number.isFinite(resolved?.lastObservedAt) ? resolved.lastObservedAt : null;
  const durationMs = Number.isFinite(resolved?.durationMs)
    ? resolved.durationMs
    : startMs !== null && endMs !== null
      ? Math.max(0, endMs - startMs)
      : null;
  const snapshotCount = Number.isFinite(resolved?.snapshotCount) ? resolved.snapshotCount : null;
  const observations = Number.isFinite(resolved?.totalTokenObservations)
    ? resolved.totalTokenObservations
    : snapshotCount;
  const uniqueMints = Number.isFinite(resolved?.uniqueMintCount) ? resolved.uniqueMintCount : null;

  const containsSynthetic = resolved?.containsSynthetic === true;
  const usableForRealMarketReplay = resolved?.usableForRealMarketReplay === true;
  let classification = DATASET_CLASS.REAL;
  if (containsSynthetic) classification = usableForRealMarketReplay ? DATASET_CLASS.MIXED : DATASET_CLASS.SYNTHETIC;
  else if (!manifestPresent) classification = DATASET_CLASS.INVALID;

  const status = typeof resolved?.status === "string" ? resolved.status : null;
  const complete = status === "complete";
  if (status && !complete) invalidReasons.push(`capture status is '${status}', not 'complete'`);

  const fingerprintValid = typeof fingerprint === "string" && HEX64.test(fingerprint);
  if (!fingerprintValid) invalidReasons.push("no valid SHA-256 fingerprint");

  if (startMs === null || endMs === null) invalidReasons.push("missing observation timestamps");
  if (durationMs !== null && durationMs <= 0) invalidReasons.push("non-positive duration");
  if (snapshotCount !== null && snapshotCount <= 0) invalidReasons.push("no snapshots");

  const structurallyValid = manifestPresent && snapshotPresent && fingerprintValid;
  const valid = structurallyValid && classification !== DATASET_CLASS.INVALID;
  if (classification === DATASET_CLASS.INVALID) invalidReasons.push("manifest is missing or unreadable");

  return emptyDatasetRecord({
    datasetId: resolved?.datasetId ?? sessionId ?? path.basename(dir),
    dir,
    day,
    sessionId: sessionId ?? path.basename(dir),
    manifestPresent,
    snapshotPresent,
    eventPresent,
    classification,
    complete,
    valid,
    invalidReasons,
    fingerprint: fingerprintValid ? fingerprint : null,
    fingerprintSource: fingerprintValid ? fingerprintSource : null,
    fingerprintValid,
    source: resolved?.source ?? null,
    requestedMode: resolved?.requestedMode ?? null,
    effectiveMode: resolved?.effectiveMode ?? null,
    captureMs: Number.isFinite(resolved?.captureMs) ? resolved.captureMs : null,
    engineVersion: resolved?.engineVersion ?? null,
    gitCommit: resolved?.gitCommit ?? null,
    status,
    dataClass: resolved?.dataClass ?? null,
    containsSynthetic,
    containsLive: resolved?.containsLive === true,
    usableForRealMarketReplay,
    startMs,
    endMs,
    durationMs,
    durationMinutes: Number.isFinite(durationMs) ? durationMs / 60_000 : null,
    snapshotCount,
    observations,
    uniqueMints,
    eventCount: Number.isFinite(resolved?.eventCount) ? resolved.eventCount : null,
    feedErrors: Number.isFinite(resolved?.feedErrors) ? resolved.feedErrors : null,
    rateLimits: Number.isFinite(resolved?.rateLimits) ? resolved.rateLimits : null,
    stalePeriods: Number.isFinite(resolved?.stalePeriods) ? resolved.stalePeriods : null,
    snapshotIntervalMs: Number.isFinite(resolved?.snapshotInterval?.medianMs)
      ? resolved.snapshotInterval.medianMs
      : null,
  });
}

/** Discover every session directory under a history root. Read-only. */
export async function discoverDatasetRecords(root = path.join(".evolve", "history")) {
  const entries = await listDatasets(root);
  const records = [];
  for (const entry of entries) {
    records.push(
      await loadDatasetRecord({
        dir: entry.dir,
        day: entry.day ?? null,
        sessionId: entry.sessionId ?? null,
        manifest: entry.manifest ?? undefined,
      }),
    );
  }
  records.sort((a, b) => String(a.datasetId).localeCompare(String(b.datasetId)));
  return records;
}

/* ============================================================================
 * Independence / overlap
 * ==========================================================================*/

/**
 * Temporal overlap of two captures. `null` when either has no interval.
 * `independent` is FALSE whenever ANY overlap exists — overlapping captures are
 * never silently treated as independent replications.
 */
export function temporalOverlap(a, b) {
  if (!a || !b || a.datasetId === b.datasetId) return null;
  if (!Number.isFinite(a.startMs) || !Number.isFinite(a.endMs) || !Number.isFinite(b.startMs) || !Number.isFinite(b.endMs)) {
    return {
      a: a.datasetId ?? null,
      b: b.datasetId ?? null,
      overlapMs: null,
      overlapFractionAtoB: null,
      overlapFractionBtoA: null,
      independent: null,
      reason: "one or both captures have no observation interval",
    };
  }
  const overlapMs = Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));
  const durA = Math.max(0, a.endMs - a.startMs);
  const durB = Math.max(0, b.endMs - b.startMs);
  return {
    a: a.datasetId ?? null,
    b: b.datasetId ?? null,
    overlapMs,
    overlapFractionAtoB: durA > 0 ? overlapMs / durA : null,
    overlapFractionBtoA: durB > 0 ? overlapMs / durB : null,
    independent: overlapMs === 0,
    reason: overlapMs === 0 ? "no temporal overlap" : "captures overlap in time",
  };
}

/** Every REAL pair's overlap, plus the NOT_INDEPENDENT label. */
export function overlapMatrix(records = []) {
  const real = records.filter((record) => record.classification === DATASET_CLASS.REAL && record.valid);
  const pairs = [];
  for (let i = 0; i < real.length; i += 1) {
    for (let j = i + 1; j < real.length; j += 1) {
      const row = temporalOverlap(real[i], real[j]);
      if (row) pairs.push({ ...row, status: row.independent === true ? "INDEPENDENT" : row.independent === false ? "NOT_INDEPENDENT" : "UNKNOWN" });
    }
  }
  return pairs;
}

/** Fingerprint-identical datasets: each group counts as ONE dataset. */
export function duplicateFingerprints(records = []) {
  const byFingerprint = new Map();
  for (const record of records) {
    if (!record.fingerprintValid || !record.fingerprint) continue;
    const list = byFingerprint.get(record.fingerprint) ?? [];
    list.push(record.datasetId);
    byFingerprint.set(record.fingerprint, list);
  }
  const groups = [];
  for (const [fingerprint, datasetIds] of [...byFingerprint.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (datasetIds.length > 1) groups.push({ fingerprint, datasetIds: datasetIds.sort(), count: datasetIds.length });
  }
  return { groups, duplicateDatasetIds: groups.flatMap((group) => group.datasetIds.slice(1)) };
}

/* ============================================================================
 * Leakage matrix
 * ==========================================================================*/

/**
 * Which datasets each historical (non-replication) arena evaluated.
 *
 * Used to detect datasets that were involved in Arena/gate tuning. This is a
 * conservative scan: ANY previously-evaluated dataset is treated as having been
 * available to earlier tuning decisions. Phase 5C's own replication arenas live
 * under `.evolve/replication/...`, so they are never scanned here.
 */
export async function collectArenaDatasetUsage(arenasDir = path.join(".evolve", "arenas")) {
  const usage = new Map(); // datasetId -> [{arenaId, source}]
  const fingerprints = new Map(); // fingerprint -> [{arenaId, source}]
  const recordsAvailable = await exists(arenasDir);
  if (!recordsAvailable) return { recordsAvailable: false, usage, fingerprints, arenaIds: [] };

  const { readdir } = await import("node:fs/promises");
  let dirs = [];
  try {
    dirs = (await readdir(arenasDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return { recordsAvailable: false, usage, fingerprints, arenaIds: [] };
  }

  for (const arenaId of dirs) {
    for (const file of ["ab-comparison.json", "summary.json"]) {
      const target = path.join(arenasDir, arenaId, file);
      if (!(await exists(target))) continue;
      let parsed = null;
      try {
        parsed = JSON.parse(await readFile(target, "utf8"));
      } catch {
        continue;
      }
      const refs = [
        ...(Array.isArray(parsed?.datasets) ? parsed.datasets : []),
        ...(parsed?.dataset ? [parsed.dataset] : []),
      ];
      for (const ref of refs) {
        const id = typeof ref?.id === "string" ? ref.id : typeof ref?.datasetId === "string" ? ref.datasetId : null;
        const fp = typeof ref?.fingerprint === "string" ? ref.fingerprint : null;
        if (id) usage.set(id, [...(usage.get(id) ?? []), { arenaId, source: file }]);
        if (fp) fingerprints.set(fp, [...(fingerprints.get(fp) ?? []), { arenaId, source: file }]);
      }
    }
  }
  return { recordsAvailable: true, usage, fingerprints, arenaIds: dirs };
}

/**
 * The leakage matrix: for every (frozen cohort × dataset) pair, decide whether
 * the dataset could have contaminated that cohort's evaluation.
 *
 * Conservative by construction: when the provenance records needed to make the
 * determination cannot be read, the pair is UNKNOWN — and UNKNOWN is never
 * eligible for a primary replication claim.
 */
export function buildLeakageMatrix({
  records = [],
  cohorts = {},
  generationDatasetIds = {},
  arenaUsage = { recordsAvailable: true, usage: new Map(), fingerprints: new Map() },
  developmentDatasetIds = DEVELOPMENT_DATASET_IDS,
  priorDecisionDatasetIds = {},
} = {}) {
  const devSet = new Set(developmentDatasetIds);
  const matrix = {};

  for (const record of records) {
    const perCohort = {};
    for (const key of FROZEN_COHORT_KEYS) {
      const cohort = cohorts[key] ?? null;
      const flags = {
        contributedTrainEvidence: false,
        usedWhileCreatingCohort: false,
        usedForCompilerTuning: null,
        usedForArenaGateTuning: false,
        usedForPriorManualDecisions: null,
      };
      const reasons = [];

      const ids = generationDatasetIds[key] ?? cohortGenerationDatasetIds(cohort);
      const generationIds = new Set(Array.isArray(ids) ? ids : []);
      const decisionIds = new Set(Array.isArray(priorDecisionDatasetIds[key]) ? priorDecisionDatasetIds[key] : []);

      const arenaTuneRefs = [
        ...(arenaUsage.usage?.get(record.datasetId) ?? []),
        ...(record.fingerprint ? arenaUsage.fingerprints?.get(record.fingerprint) ?? [] : []),
      ];
      const arenaIds = [...new Set(arenaTuneRefs.map((row) => row.arenaId))];
      if (arenaIds.length > 0) {
        flags.usedForArenaGateTuning = true;
        reasons.push(`evaluated by prior arena(s): ${arenaIds.join(", ")}`);
      }

      let classification = LEAKAGE_CLASS.CLEAN_REPLICATION;

      if (devSet.has(record.datasetId)) {
        classification = LEAKAGE_CLASS.DEVELOPMENT;
        flags.usedWhileCreatingCohort = true;
        flags.contributedTrainEvidence = true;
        reasons.unshift("development / original-benchmark dataset for this phase");
      } else if (generationIds.has(record.datasetId)) {
        classification = LEAKAGE_CLASS.CONTAMINATED;
        flags.contributedTrainEvidence = true;
        flags.usedWhileCreatingCohort = true;
        reasons.unshift(`used as TRAIN evidence / cohort-generation material for the ${key} cohort`);
      } else if (decisionIds.has(record.datasetId)) {
        classification = LEAKAGE_CLASS.CONTAMINATED;
        flags.usedForPriorManualDecisions = true;
        reasons.unshift(`recorded as used in a prior manual development decision for the ${key} cohort`);
      } else if (flags.usedForArenaGateTuning) {
        classification = LEAKAGE_CLASS.CONTAMINATED;
      } else if (!record.valid || !arenaUsage.recordsAvailable) {
        classification = LEAKAGE_CLASS.UNKNOWN;
        reasons.push(
          arenaUsage.recordsAvailable
            ? "dataset is invalid/incomplete, so contamination cannot be ruled out"
            : "prior-arena provenance records are unavailable, so contamination cannot be ruled out",
        );
      } else {
        reasons.push("no recorded use by research generation, compiler/arena/gate tuning, or a prior manual decision");
      }

      if (classification === LEAKAGE_CLASS.CLEAN_REPLICATION) {
        flags.usedForCompilerTuning = false;
        flags.usedForPriorManualDecisions = false;
      }

      perCohort[key] = {
        cohortKey: key,
        provider: cohort?.provider ?? null,
        classification,
        reasons,
        flags,
        clean: classification === LEAKAGE_CLASS.CLEAN_REPLICATION,
        arenaIds,
        generationDatasetIds: [...generationIds].sort(),
      };
    }
    // The overall class is the most conservative across cohorts.
    const overall = mostConservativeLeakage(Object.values(perCohort).map((row) => row.classification));
    matrix[record.datasetId] = { datasetId: record.datasetId, fingerprint: record.fingerprint, overall, perCohort };
  }

  return matrix;
}

const LEAKAGE_SEVERITY = {
  [LEAKAGE_CLASS.UNKNOWN]: 3,
  [LEAKAGE_CLASS.CONTAMINATED]: 2,
  [LEAKAGE_CLASS.DEVELOPMENT]: 1,
  [LEAKAGE_CLASS.CLEAN_REPLICATION]: 0,
};

export function mostConservativeLeakage(classes = []) {
  let worst = LEAKAGE_CLASS.CLEAN_REPLICATION;
  for (const value of classes) {
    if (!value) continue;
    if ((LEAKAGE_SEVERITY[value] ?? 0) > (LEAKAGE_SEVERITY[worst] ?? 0)) worst = value;
  }
  return worst;
}

/** TRAIN-evidence dataset ids recorded by a frozen cohort (if any). */
export function cohortGenerationDatasetIds(cohort) {
  const ids = cohort?.experiment?.datasetIds;
  return Array.isArray(ids) ? ids.filter(Boolean) : [];
}

/* ============================================================================
 * Eligibility
 * ==========================================================================*/

/**
 * Quality-only eligibility (no overlap check — that needs the whole selection).
 * Never receives a metric: selection is performance-blind by construction.
 */
export function baseEligibility(record, { criteria = ELIGIBILITY_CRITERIA } = {}) {
  const reasons = [];
  if (criteria.requireReal && record.classification !== DATASET_CLASS.REAL) {
    reasons.push(`not REAL market data (classification ${record.classification})`);
  }
  if (!record.valid) reasons.push(...record.invalidReasons.map((reason) => `invalid/incomplete: ${reason}`));
  if (criteria.requireComplete && !record.complete) reasons.push("capture is not complete");
  if (criteria.requireFingerprint && !record.fingerprintValid) reasons.push("no valid fingerprint");
  if (Number.isFinite(record.feedErrors) && record.feedErrors > criteria.maxFeedErrors) {
    reasons.push(`feed errors ${record.feedErrors} > ${criteria.maxFeedErrors}`);
  }
  if (Number.isFinite(record.rateLimits) && record.rateLimits > criteria.maxRateLimits) {
    reasons.push(`rate limits ${record.rateLimits} > ${criteria.maxRateLimits}`);
  }
  if (!Number.isFinite(record.durationMs) || record.durationMs < criteria.minDurationMs) {
    reasons.push(`duration below ${criteria.minDurationMs / 60000} minutes`);
  }
  if (!Number.isFinite(record.observations) || record.observations < criteria.minObservations) {
    reasons.push(`observations below ${criteria.minObservations}`);
  }
  if (!Number.isFinite(record.uniqueMints) || record.uniqueMints < criteria.minUniqueMints) {
    reasons.push(`unique mints below ${criteria.minUniqueMints}`);
  }
  return { eligible: reasons.length === 0, reasons, criteria };
}

/**
 * Build the full Phase 5C replication registry: classification, overlap,
 * duplicates, leakage, eligibility, and roles.
 *
 * Selection order is deterministic (dataset id ascending) and ignores every
 * strategy metric, so the sample cannot be steered by an outcome.
 */
export function buildReplicationRegistry({
  records = [],
  cohorts = {},
  generationDatasetIds = {},
  arenaUsage = { recordsAvailable: true, usage: new Map(), fingerprints: new Map() },
  criteria = ELIGIBILITY_CRITERIA,
  developmentDatasetIds = DEVELOPMENT_DATASET_IDS,
  priorDecisionDatasetIds = {},
} = {}) {
  const overlap = overlapMatrix(records);
  const duplicates = duplicateFingerprints(records);
  const duplicateIds = new Set(duplicates.duplicateDatasetIds);
  const leakage = buildLeakageMatrix({
    records,
    cohorts,
    generationDatasetIds,
    arenaUsage,
    developmentDatasetIds,
    priorDecisionDatasetIds,
  });

  const ordered = [...records].sort((a, b) => String(a.datasetId).localeCompare(String(b.datasetId)));
  const selected = [];
  const selectedIds = [];
  const selectedFingerprints = [];
  const eligibility = {};
  const roles = {};

  for (const record of ordered) {
    const base = baseEligibility(record, { criteria });
    const reasons = [...base.reasons];
    const leak = leakage[record.datasetId]?.overall ?? LEAKAGE_CLASS.UNKNOWN;

    const isDevelopment = new Set(developmentDatasetIds).has(record.datasetId);
    if (criteria.excludeDevelopmentDatasets === true && isDevelopment) reasons.push("development/original-benchmark dataset");
    if (criteria.requireCleanLeakage === true && leak !== LEAKAGE_CLASS.CLEAN_REPLICATION) {
      reasons.push(`leakage class ${leak} is not CLEAN_REPLICATION`);
    }
    if (criteria.excludeDuplicateFingerprints === true && duplicateIds.has(record.datasetId)) {
      reasons.push("fingerprint-identical to another dataset (counts once)");
    }

    // Overlap against ALREADY-SELECTED primary replication datasets only.
    let overlapConflict = null;
    if (criteria.requireNoOverlapWithSelected === true && base.eligible && reasons.length === 0) {
      for (const chosen of selected) {
        const row = temporalOverlap(record, chosen);
        if (row && row.independent !== true) {
          overlapConflict = { with: chosen.datasetId, overlapMs: row.overlapMs, status: "NOT_INDEPENDENT" };
          break;
        }
      }
      if (overlapConflict) reasons.push(`temporal overlap with selected dataset ${overlapConflict.with}`);
    }

    const eligible = base.eligible && reasons.length === 0;
    eligibility[record.datasetId] = {
      datasetId: record.datasetId,
      eligible,
      reasons,
      overlapConflict,
      criteria: ELIGIBILITY_CRITERIA_TEXT,
    };

    if (eligible) {
      selected.push(record);
      selectedIds.push(record.datasetId);
      if (record.fingerprint) selectedFingerprints.push(record.fingerprint);
    }

    roles[record.datasetId] = assignRole({ record, eligible, base, leak, isDevelopment, reasons });
  }

  return {
    records: ordered,
    overlap,
    duplicates,
    leakage,
    eligibility,
    roles,
    selectedIds,
    selectedFingerprints,
    selected,
    criteria,
    criteriaText: ELIGIBILITY_CRITERIA_TEXT,
    counts: countRoles(roles),
    recordsAvailable: arenaUsage.recordsAvailable,
  };
}

function assignRole({ record, eligible, base, leak, isDevelopment, reasons }) {
  if (!record.valid) return DATASET_ROLE.INVALID;
  if (record.classification !== DATASET_CLASS.REAL) return DATASET_ROLE.NON_REAL;
  if (isDevelopment) return DATASET_ROLE.DEVELOPMENT;
  if (leak === LEAKAGE_CLASS.CONTAMINATED && !base.eligible) return DATASET_ROLE.CONTAMINATED;
  if (leak === LEAKAGE_CLASS.CONTAMINATED) return DATASET_ROLE.CONTAMINATED;
  if (leak === LEAKAGE_CLASS.UNKNOWN) return DATASET_ROLE.UNKNOWN;
  if (eligible) return DATASET_ROLE.REPLICATION;
  return reasons.length > 0 ? DATASET_ROLE.INELIGIBLE : DATASET_ROLE.INELIGIBLE;
}

export function countRoles(roles = {}) {
  const out = {};
  for (const role of Object.values(roles)) out[role] = (out[role] ?? 0) + 1;
  return out;
}

/** Resolve a requested selection (`auto` | explicit ids) against the registry. */
export function selectReplicationDatasets(registry, { mode = "auto", ids = [] } = {}) {
  const byId = new Map(registry.records.map((record) => [record.datasetId, record]));
  if (mode === "auto") {
    return { mode, datasetIds: [...registry.selectedIds], datasets: [...registry.selected], unknown: [], ineligible: [] };
  }
  const unknown = [];
  const ineligible = [];
  const datasets = [];
  const datasetIds = [];
  for (const id of ids) {
    const record = byId.get(id);
    if (!record) {
      unknown.push(id);
      continue;
    }
    const decision = registry.eligibility[id];
    if (registry.roles[id] !== DATASET_ROLE.REPLICATION) {
      ineligible.push({ datasetId: id, role: registry.roles[id], reasons: decision?.reasons ?? [] });
      continue;
    }
    datasets.push(record);
    datasetIds.push(id);
  }
  return { mode, datasetIds, datasets, unknown, ineligible };
}

/** Compact per-dataset row for reports/JSON. */
export function datasetRow(record, registry) {
  return {
    datasetId: record.datasetId,
    path: record.dir,
    classification: record.classification,
    role: registry.roles?.[record.datasetId] ?? null,
    leakage: registry.leakage?.[record.datasetId]?.overall ?? null,
    leakageByCohort: Object.fromEntries(
      Object.entries(registry.leakage?.[record.datasetId]?.perCohort ?? {}).map(([key, row]) => [key, row.classification]),
    ),
    eligible: registry.eligibility?.[record.datasetId]?.eligible ?? false,
    ineligibleReasons: registry.eligibility?.[record.datasetId]?.reasons ?? [],
    fingerprint: record.fingerprint,
    startMs: record.startMs,
    endMs: record.endMs,
    start: Number.isFinite(record.startMs) ? new Date(record.startMs).toISOString() : null,
    end: Number.isFinite(record.endMs) ? new Date(record.endMs).toISOString() : null,
    durationMinutes: record.durationMinutes,
    snapshotCount: record.snapshotCount,
    observations: record.observations,
    uniqueMints: record.uniqueMints,
    feedSource: record.source,
    captureIntervalMs: record.captureMs,
    status: record.status,
    complete: record.complete,
    feedErrors: record.feedErrors,
  };
}

/**
 * Regime composition of a dataset, using the EXISTING classifier only
 * (planDatasetWindows + buildRegimeMap). Never fits new thresholds, never
 * mutates the classifier, and is optional/bounded because it reads snapshots.
 */
export async function computeDatasetRegimes(dir, config, { maxWindows = null } = {}) {
  const [{ planDatasetWindows }, { buildRegimeMap }] = await Promise.all([
    import("../arena/evaluator.mjs"),
    import("../arena/orchestrator.mjs"),
  ]);
  const { windows } = await planDatasetWindows(dir, config, { maxWindows, allowShort: true });
  const rows = await buildRegimeMap(dir, windows);
  const composition = {};
  for (const row of rows) {
    const label = row?.regime ?? "unknown";
    composition[label] = (composition[label] ?? 0) + 1;
  }
  return {
    datasetId: path.basename(dir),
    windows: rows.map((row) => ({ window: row.window, regime: row.regime, testStart: row.testStart ?? null, testEnd: row.testEnd ?? null })),
    composition,
    readOnly: true,
    note: "Regime composition is descriptive context only. The classifier is unchanged and no threshold is fitted to any outcome.",
  };
}

/** Digest of a deterministic, secret-free registry view (traceability). */
export function registryDigest(registry) {
  return digestOf({
    selected: [...registry.selectedIds],
    roles: registry.roles,
    fingerprints: registry.records.map((record) => [record.datasetId, record.fingerprint]),
  });
}
