/**
 * Phase 5C — plan/status semantics (PAPER ONLY).
 *
 * Phase 5C reporting used to answer ONE question with ONE field:
 *
 *   summary.datasetAvailability.status = INSUFFICIENT_INDEPENDENT_REAL_DATASETS
 *
 * and that field was derived from the number of CLEAN datasets with BOTH
 * providers COMPLETED. That is the right question for a FINISHED run, but it is
 * the wrong question for a PLAN: `--plan` deliberately executes zero units, so
 * the completed count is always 0 and a three-dataset plan was reported as
 * INSUFFICIENT — while the very same command printed "Clean independent real
 * replication datasets available: 3". The defect was a conflation, not a
 * threshold: READINESS (did we select enough eligible datasets?) was being
 * answered from EXECUTION (how many units have completed?).
 *
 * This module keeps the three questions separate, and never lets one answer for
 * another:
 *
 *   DATASET READINESS — "are enough ELIGIBLE CLEAN_REPLICATION datasets
 *                       SELECTED for this experiment?" Derived ONLY from the
 *                       selection, never from execution. It reuses the existing
 *                       descriptive vocabulary: 3+ selected datasets is
 *                       MULTI_DATASET_REPLICATION, 2 is LIMITED_REPLICATION,
 *                       and fewer than MIN_CLEAN_TO_RUN is
 *                       INSUFFICIENT_INDEPENDENT_REAL_DATASETS.
 *
 *   EXECUTION STATUS  — "how far has execution got?" PLANNED while every
 *                       planned unit is still PENDING (a plan executes
 *                       nothing), then the EXISTING run-status vocabulary
 *                       derived from the recorded COMPLETED / FAILED / RUNNING /
 *                       PENDING unit counts (`runStatusFromUnits`). A plan
 *                       against a replication id that has already run reports
 *                       the recorded counts, so a resumed plan is described
 *                       honestly rather than as "planned".
 *
 *   EVIDENCE STATUS   — "how much COMPLETED replication evidence exists?" The
 *                       descriptive status of completed clean datasets
 *                       (NO_REPLICATION_EVIDENCE with none, then SINGLE_…,
 *                       LIMITED_…, MULTI_DATASET_REPLICATION as they complete).
 *                       INSUFFICIENT_INDEPENDENT_REAL_DATASETS appears here ONLY
 *                       when the SELECTION itself was insufficient — never
 *                       because "zero units have completed yet".
 *
 * Nothing here weakens a gate. MIN_CLEAN_TO_RUN / MIN_CLEAN_FOR_MULTI are the
 * unchanged constants, a genuinely short selection still reports
 * INSUFFICIENT_INDEPENDENT_REAL_DATASETS (with the capture guidance), and a
 * COMPLETED run keeps reporting exactly what `aggregateReplication` reported
 * before: this module describes a PLAN, it never rewrites the summary.
 *
 * Pure: no filesystem, no clock, no randomness, no network, no provider, no
 * Jev, no Arena, no subprocess.
 */

import { MIN_CLEAN_FOR_MULTI, MIN_CLEAN_TO_RUN, REPLICATION_STATUS, UNIT_STATUS } from "./constants.mjs";
import { replicationStatusFor } from "./aggregate.mjs";
import { runStatusFromUnits } from "./runner.mjs";

/**
 * Lifecycle/execution vocabulary for a plan. The values after PLANNED are the
 * EXISTING `runStatusFromUnits` vocabulary, so a plan and the run manifest that
 * follows it describe execution with the same words.
 */
export const EXECUTION_STATUS = Object.freeze({
  PLANNED: "PLANNED",
  NO_UNITS_PLANNED: "NO_UNITS_PLANNED",
  RUNNING: "RUNNING",
  PARTIAL_RUNNING: "PARTIAL_RUNNING",
  PARTIAL_FAILED: "PARTIAL_FAILED",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  SKIPPED: "SKIPPED",
});

const UNIT_STATUSES = Object.values(UNIT_STATUS);

function wholeCount(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/**
 * DATASET READINESS — a statement about the SELECTION, never about execution.
 *
 * @param {{
 *   selectedCleanDatasets?: number,
 *   minimumRequired?: number,
 *   multiDatasetThreshold?: number,
 * }} [options] selected eligible CLEAN_REPLICATION datasets for this command
 */
export function datasetReadinessFor({
  selectedCleanDatasets = 0,
  minimumRequired = MIN_CLEAN_TO_RUN,
  multiDatasetThreshold = MIN_CLEAN_FOR_MULTI,
} = {}) {
  const count = wholeCount(selectedCleanDatasets);
  const sufficient = count >= minimumRequired;
  return {
    selectedCleanDatasets: count,
    minimumRequired,
    multiDatasetThreshold,
    sufficient,
    multiDatasetReady: count >= multiDatasetThreshold,
    status: sufficient ? replicationStatusFor(count) : REPLICATION_STATUS.INSUFFICIENT_INDEPENDENT_REAL_DATASETS,
    note: sufficient
      ? `${count} eligible CLEAN independent real dataset(s) selected: enough to run a descriptive cross-dataset replication (${minimumRequired} required; ${multiDatasetThreshold}+ for the multi-dataset claim)`
      : `only ${count} eligible CLEAN independent real dataset(s) selected: Phase 5C requires at least ${minimumRequired} before it will run, and never slices one capture into pseudo-independent datasets`,
  };
}

/** Per-status unit counts. `executedUnits` counts every terminal unit. */
export function unitCounts(units = []) {
  const count = (statuses) => units.filter((unit) => statuses.includes(unit?.status)).length;
  const completedUnits = count([UNIT_STATUS.COMPLETED]);
  const failedUnits = count([UNIT_STATUS.FAILED]);
  const skippedUnits = count([UNIT_STATUS.SKIPPED, UNIT_STATUS.INVALID_DATASET, UNIT_STATUS.CONTAMINATED]);
  const runningUnits = count([UNIT_STATUS.RUNNING]);
  const pendingUnits = count([UNIT_STATUS.PENDING]);
  return {
    plannedUnits: units.length,
    executedUnits: completedUnits + failedUnits + skippedUnits,
    completedUnits,
    failedUnits,
    skippedUnits,
    runningUnits,
    pendingUnits,
    unknownUnits: units.length - (completedUnits + failedUnits + skippedUnits + runningUnits + pendingUnits),
  };
}

/**
 * EXECUTION STATUS — PLANNED until something actually starts, then the existing
 * run-status vocabulary driven by the units' own recorded statuses.
 */
export function executionStatusFor(units = []) {
  if (units.length === 0) return EXECUTION_STATUS.NO_UNITS_PLANNED;
  if (units.every((unit) => !UNIT_STATUSES.includes(unit?.status) || unit.status === UNIT_STATUS.PENDING)) {
    return EXECUTION_STATUS.PLANNED;
  }
  return runStatusFromUnits(units);
}

/**
 * Project the status of a PLAN.
 *
 * @param {{
 *   selectedDatasetIds?: string[],
 *   units?: object[],           the planned units (all PENDING before a run)
 *   recordedUnits?: object[],   units already recorded for this replication id
 *   completedCleanDatasets?: number,
 *   minimumRequired?: number,
 *   multiDatasetThreshold?: number,
 * }} [options]
 */
export function buildPlanStatus({
  selectedDatasetIds = [],
  units = [],
  recordedUnits = [],
  completedCleanDatasets = 0,
  minimumRequired = MIN_CLEAN_TO_RUN,
  multiDatasetThreshold = MIN_CLEAN_FOR_MULTI,
} = {}) {
  const datasetIds = [...selectedDatasetIds];
  const readiness = datasetReadinessFor({
    selectedCleanDatasets: datasetIds.length,
    minimumRequired,
    multiDatasetThreshold,
  });

  // The EXECUTION view of the same plan: a unit that this replication id already
  // recorded keeps its recorded status (a resumed plan), otherwise it is still
  // PENDING — which is exactly what PLANNED means.
  const recordedById = new Map((recordedUnits ?? []).map((unit) => [unit?.unitId, unit?.status]));
  const executionUnits = units.map((unit) => ({ ...unit, status: recordedById.get(unit?.unitId) ?? UNIT_STATUS.PENDING }));
  const counts = unitCounts(executionUnits);
  const executionStatus = executionStatusFor(executionUnits);

  const completedDatasets = wholeCount(completedCleanDatasets);
  // Evidence is a statement about RESULTS. INSUFFICIENT_INDEPENDENT_REAL_DATASETS
  // belongs to READINESS only: a sufficient selection with nothing completed yet
  // has NO_REPLICATION_EVIDENCE, not "insufficient data".
  const evidenceStatus = readiness.sufficient
    ? replicationStatusFor(completedDatasets)
    : REPLICATION_STATUS.INSUFFICIENT_INDEPENDENT_REAL_DATASETS;

  return {
    // In a plan projection `replicationStatus` is the lifecycle/execution status
    // (a plan has not replicated anything yet); the descriptive result of
    // completed unit pairs travels as `evidenceStatus`, and the completed-run
    // summary keeps its own descriptive `replicationStatus`.
    replicationStatus: executionStatus,
    executionStatus,
    datasetReadiness: readiness.status,
    evidenceStatus,
    completedDatasets,
    selectedCleanDatasets: readiness.selectedCleanDatasets,
    minimumRequired: readiness.minimumRequired,
    multiDatasetThreshold: readiness.multiDatasetThreshold,
    sufficientSelectedDatasets: readiness.sufficient,
    sufficientCompletedDatasets: readiness.sufficient && completedDatasets >= minimumRequired,
    multiDatasetClaimAvailable: completedDatasets >= multiDatasetThreshold,
    datasetIds,
    execution: { status: executionStatus, ...counts },
    note:
      `${readiness.note}. Execution is ${executionStatus} ` +
      `(${counts.plannedUnits} unit(s) planned, ${counts.executedUnits} executed: ${counts.completedUnits} completed, ` +
      `${counts.pendingUnits} pending, ${counts.failedUnits} failed, ${counts.skippedUnits} skipped). ` +
      `Evidence: ${evidenceStatus} from ${completedDatasets} dataset(s) with both providers complete.`,
  };
}
