/**
 * Phase 5C — cross-dataset replication aggregation (PAPER ONLY).
 *
 * The UNIT OF REPLICATION IS THE DATASET. Individual genome rows are never
 * pooled across datasets as though they were independent observations, and
 * walk-forward windows from one capture are never treated as separate datasets.
 *
 * For each dataset with BOTH providers completed, the paired comparison is:
 *
 *   mockDelta     = Mock     Research arm − its own matched Conventional arm
 *   deepseekDelta = DeepSeek Research arm − its own matched Conventional arm
 *   deltaOfDeltas = deepseekDelta − mockDelta        (SAME dataset)
 *
 * Cross-dataset aggregation then operates on those per-dataset delta-of-deltas.
 * Raw mathematics first: a lower-is-better metric keeps its raw sign, and
 * `direction` travels as metadata only. No significance test, no p-value, and
 * `verdict` stays `null`.
 */

import { createSeededRandom } from "../lib/random.mjs";
import { METRIC_PATHS } from "../research-compare.mjs";
import {
  DATASET_BOOTSTRAP_DEFAULTS,
  MIN_CLEAN_FOR_MULTI,
  MIN_CLEAN_TO_RUN,
  PHASE,
  REPLICATION_STATUS,
  REPLICATION_SCHEMA_VERSION,
} from "./constants.mjs";

/* ============================================================================
 * Descriptive statistics
 * ==========================================================================*/

export function medianOf(values = []) {
  const finite = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (finite.length === 0) return null;
  // Upper-median convention, matching `scripts/research/cohort.mjs`.
  return finite[Math.floor(finite.length / 2)];
}

export function meanOf(values = []) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

/** Nearest-rank quantile over a finite list (deterministic, order-independent). */
export function quantileOf(values = [], q = 0.5) {
  const finite = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (finite.length === 0) return null;
  const clamped = Math.min(1, Math.max(0, q));
  const index = Math.min(finite.length - 1, Math.max(0, Math.round(clamped * (finite.length - 1))));
  return finite[index];
}

export function round6(value) {
  return Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : null;
}

/** Sign-aware descriptive block. The number itself is never sign-flipped. */
export function describeValues(values = []) {
  const finite = values.filter((value) => Number.isFinite(value));
  const positive = finite.filter((value) => value > 0).length;
  const negative = finite.filter((value) => value < 0).length;
  const zero = finite.filter((value) => value === 0).length;
  const median = round6(medianOf(finite));
  const sign = median === null ? 0 : Math.sign(median);
  const agree = sign === 0 ? zero : sign > 0 ? positive : negative;
  return {
    n: finite.length,
    median,
    mean: round6(meanOf(finite)),
    min: finite.length > 0 ? Math.min(...finite) : null,
    max: finite.length > 0 ? Math.max(...finite) : null,
    q1: quantileOf(finite, 0.25),
    q3: quantileOf(finite, 0.75),
    positive,
    negative,
    zero,
    directionConsistency: finite.length > 0 ? agree / finite.length : null,
    unanimous: finite.length > 0 && (positive === finite.length || negative === finite.length || zero === finite.length),
  };
}

/**
 * Deterministic percentile bootstrap at the DATASET level.
 *
 * Resamples whole datasets with replacement — never individual genomes, and
 * never overlapping windows as if they were independent samples. Small n is
 * explicitly marked unstable and no significance claim is made.
 */
export function datasetBootstrap(values = [], { iterations = DATASET_BOOTSTRAP_DEFAULTS.iterations, seed = DATASET_BOOTSTRAP_DEFAULTS.seed } = {}) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) {
    return { available: false, reason: "no per-dataset values", significance: null };
  }
  const random = createSeededRandom(seed);
  const medians = [];
  for (let iteration = 0; iteration < Math.max(1, iterations); iteration += 1) {
    const sample = [];
    for (let draw = 0; draw < finite.length; draw += 1) {
      sample.push(finite[Math.floor(random() * finite.length)]);
    }
    medians.push(medianOf(sample));
  }
  return {
    available: true,
    unit: "dataset",
    iterations: Math.max(1, iterations),
    seed,
    point: round6(medianOf(finite)),
    medianDifferenceInterval: { low: round6(quantileOf(medians, 0.025)), high: round6(quantileOf(medians, 0.975)) },
    stable: finite.length >= 5,
    stabilityNote:
      finite.length >= 5
        ? "dataset-level resampling; the interval describes spread, not evidence"
        : `only ${finite.length} dataset(s): UNSTABLE estimate — the interval is not informative at this sample size`,
    significance: null,
    note: "DESCRIPTIVE ONLY. Resampling whole datasets, no significance test, no p-value, no multiple-comparison correction.",
  };
}

/** Leave-one-dataset-out sensitivity (NOT cross-validation). */
export function leaveOneOut(values = [], labels = [], { minDatasets = MIN_CLEAN_FOR_MULTI } = {}) {
  const pairs = values
    .map((value, index) => ({ value, label: labels[index] ?? String(index) }))
    .filter((row) => Number.isFinite(row.value));
  if (pairs.length < minDatasets) {
    return {
      available: false,
      required: minDatasets,
      reason: `leave-one-dataset-out sensitivity needs at least ${minDatasets} datasets (have ${pairs.length})`,
      note: "This is sensitivity analysis, not cross-validation.",
    };
  }
  const rows = pairs.map((row, index) => {
    const remaining = pairs.filter((_, other) => other !== index).map((entry) => entry.value);
    return {
      removed: row.label,
      remaining: remaining.length,
      median: round6(medianOf(remaining)),
      mean: round6(meanOf(remaining)),
    };
  });
  const medians = rows.map((row) => row.median);
  return {
    available: true,
    unit: "dataset",
    rows,
    medianSpread: { min: Math.min(...medians), max: Math.max(...medians) },
    note: "Leave-one-dataset-out SENSITIVITY analysis of the aggregated delta-of-deltas — not cross-validation, and not a significance test.",
  };
}

/* ============================================================================
 * Paired provider comparison
 * ==========================================================================*/

/**
 * Join one dataset's mock and deepseek unit results.
 *
 * A delta-of-deltas REQUIRES the same dataset on both sides (matching id AND,
 * when both are present, matching fingerprint). A mismatched join produces no
 * DoD rather than a fabricated one.
 */
export function pairUnits(mockUnit, deepseekUnit) {
  if (!mockUnit || !deepseekUnit) {
    return { paired: false, reason: "both provider results are required", deltaOfDeltas: {} };
  }
  if (mockUnit.datasetId !== deepseekUnit.datasetId) {
    return { paired: false, reason: "provider results belong to different datasets", deltaOfDeltas: {} };
  }
  const fpA = mockUnit.datasetFingerprint ?? null;
  const fpB = deepseekUnit.datasetFingerprint ?? null;
  if (fpA && fpB && fpA !== fpB) {
    return { paired: false, reason: "dataset fingerprints differ for the same dataset id", deltaOfDeltas: {} };
  }
  const deltaOfDeltas = {};
  for (const metric of METRIC_PATHS) {
    const a = mockUnit.metrics?.deltas?.[metric.key];
    const b = deepseekUnit.metrics?.deltas?.[metric.key];
    deltaOfDeltas[metric.key] = Number.isFinite(a) && Number.isFinite(b) ? round6(b - a) : null;
  }
  return {
    paired: true,
    reason: null,
    datasetId: mockUnit.datasetId,
    datasetFingerprint: fpA ?? fpB ?? null,
    sameDataset: true,
    deltaOfDeltas,
  };
}

/* ============================================================================
 * Status vocabulary
 * ==========================================================================*/

export function replicationStatusFor(cleanCount) {
  if (!Number.isFinite(cleanCount) || cleanCount <= 0) return REPLICATION_STATUS.NO_REPLICATION_EVIDENCE;
  if (cleanCount === 1) return REPLICATION_STATUS.SINGLE_REPLICATION;
  if (cleanCount === 2) return REPLICATION_STATUS.LIMITED_REPLICATION;
  return REPLICATION_STATUS.MULTI_DATASET_REPLICATION;
}

/* ============================================================================
 * Aggregation
 * ==========================================================================*/

/**
 * Aggregate a replication run.
 *
 * @param {{
 *   replicationId: string,
 *   freezeDigest: string|null,
 *   units: object[],
 *   registry?: object|null,
 *   datasetRegimes?: Record<string, object>,
 *   providers?: string[],
 *   generatedAt?: number,
 * }} options
 */
export function aggregateReplication({
  replicationId,
  freezeDigest = null,
  units = [],
  registry = null,
  datasetRegimes = {},
  providers = ["mock", "deepseek"],
  generatedAt = Date.now(),
} = {}) {
  const completed = units.filter((unit) => unit.status === "COMPLETED");
  const roleOf = (datasetId) => registry?.roles?.[datasetId] ?? null;
  const leakageOf = (datasetId) => registry?.leakage?.[datasetId]?.overall ?? null;

  // A dataset is CLEAN for aggregation only if: it is a selected REPLICATION
  // dataset, its leakage is CLEAN_REPLICATION, and BOTH providers completed.
  const cleanDatasetIds = [];
  const perDataset = [];
  const byDataset = new Map();
  for (const unit of completed) {
    const list = byDataset.get(unit.datasetId) ?? {};
    list[unit.provider] = unit;
    byDataset.set(unit.datasetId, list);
  }

  for (const datasetId of [...byDataset.keys()].sort()) {
    const row = byDataset.get(datasetId);
    const role = roleOf(datasetId);
    const leakage = leakageOf(datasetId);
    const bothComplete = providers.every((provider) => row[provider]?.status === "COMPLETED");
    const clean = bothComplete && role === "REPLICATION" && leakage === "CLEAN_REPLICATION";
    if (clean) cleanDatasetIds.push(datasetId);

    const mockUnit = row.mock ?? null;
    const deepseekUnit = row.deepseek ?? null;
    const paired = providers.length >= 2 ? pairUnits(mockUnit, deepseekUnit) : { paired: false, deltaOfDeltas: {} };

    perDataset.push({
      datasetId,
      datasetFingerprint: mockUnit?.datasetFingerprint ?? deepseekUnit?.datasetFingerprint ?? null,
      role,
      leakage,
      regimeComposition: datasetRegimes?.[datasetId]?.composition ?? null,
      clean,
      cleanReasons: clean
        ? ["REPLICATION role", "CLEAN_REPLICATION leakage", "both providers completed"]
        : [
            row.mock?.status !== "COMPLETED" ? "mock arm incomplete" : null,
            row.deepseek?.status !== "COMPLETED" ? "deepseek arm incomplete" : null,
            role !== "REPLICATION" ? `role ${role}` : null,
            leakage !== "CLEAN_REPLICATION" ? `leakage ${leakage}` : null,
          ].filter(Boolean),
      mock: mockUnit
        ? { status: mockUnit.status, arenaId: mockUnit.arenaId, deltas: mockUnit.metrics?.deltas ?? null, cohort: mockUnit.metrics?.cohort ?? null, speciesMatched: mockUnit.metrics?.speciesMatched ?? null }
        : null,
      deepseek: deepseekUnit
        ? { status: deepseekUnit.status, arenaId: deepseekUnit.arenaId, deltas: deepseekUnit.metrics?.deltas ?? null, cohort: deepseekUnit.metrics?.cohort ?? null, speciesMatched: deepseekUnit.metrics?.speciesMatched ?? null }
        : null,
      paired,
    });
  }

  // ---- per-metric cross-dataset aggregation over CLEAN datasets ------------
  const metrics = {};
  for (const metric of METRIC_PATHS) {
    const rows = perDataset.filter((row) => row.clean && row.paired.paired);
    const mockDeltas = rows.map((row) => ({ datasetId: row.datasetId, value: row.mock?.deltas?.[metric.key] ?? null }));
    const deepseekDeltas = rows.map((row) => ({ datasetId: row.datasetId, value: row.deepseek?.deltas?.[metric.key] ?? null }));
    const dodRows = rows.map((row) => ({ datasetId: row.datasetId, value: row.paired.deltaOfDeltas?.[metric.key] ?? null }));
    const dodValues = dodRows.map((row) => row.value).filter((value) => Number.isFinite(value));
    const labels = dodRows.filter((row) => Number.isFinite(row.value)).map((row) => row.datasetId);

    metrics[metric.key] = {
      key: metric.key,
      group: metric.group,
      path: metric.path,
      direction: metric.direction,
      unit: "dataset",
      n: dodValues.length,
      perDataset: {
        mockResearchMinusControl: mockDeltas,
        deepseekResearchMinusControl: deepseekDeltas,
        deltaOfDeltas: dodRows,
      },
      mock: describeValues(mockDeltas.map((row) => row.value)),
      deepseek: describeValues(deepseekDeltas.map((row) => row.value)),
      deltaOfDeltas: describeValues(dodValues),
      consistency: {
        deepseekGreaterThanMock: dodValues.filter((value) => value > 0).length,
        deepseekLessThanMock: dodValues.filter((value) => value < 0).length,
        equal: dodValues.filter((value) => value === 0).length,
        total: dodValues.length,
        statement: `${dodValues.filter((value) => value > 0).length}/${dodValues.length} clean datasets show DeepSeek > Mock, ${dodValues.filter((value) => value < 0).length}/${dodValues.length} show DeepSeek < Mock, ${dodValues.filter((value) => value === 0).length}/${dodValues.length} equal`,
      },
      bootstrap: datasetBootstrap(dodValues),
      leaveOneOut: leaveOneOut(dodValues, labels),
      directionNote:
        metric.direction === "lower-better"
          ? "lower is generally favourable — the raw delta keeps its own sign and is never rewritten"
          : metric.direction === "higher-better"
            ? "higher is generally favourable — reported as a raw difference"
            : "direction not ranked",
    };
  }

  const eligibleCleanCount = registry ? registry.selectedIds?.length ?? 0 : null;
  const sufficientDatasets = cleanDatasetIds.length >= MIN_CLEAN_TO_RUN;

  const regimeContext = perDataset.map((row) => ({
    datasetId: row.datasetId,
    regimes: row.regimeComposition,
    regimesAvailable: row.regimeComposition !== null,
    deltaOfDeltas: {
      medianArenaScore: row.paired?.deltaOfDeltas?.medianArenaScore ?? null,
      medianNetPaperReturn: row.paired?.deltaOfDeltas?.medianNetPaperReturn ?? null,
      medianCostDrag: row.paired?.deltaOfDeltas?.medianCostDrag ?? null,
      medianDrawdown: row.paired?.deltaOfDeltas?.medianDrawdown ?? null,
    },
    note: "Descriptive cross-reference only: no threshold is fitted, and the regime classifier is unchanged.",
  }));

  const failed = units.filter((unit) => unit.status === "FAILED");
  const pending = units.filter((unit) => unit.status === "PENDING" || unit.status === "RUNNING");
  const skipped = units.filter((unit) => unit.status === "SKIPPED" || unit.status === "INVALID_DATASET" || unit.status === "CONTAMINATED");

  return {
    schemaVersion: REPLICATION_SCHEMA_VERSION,
    phase: PHASE,
    replicationId,
    freezeDigest,
    generatedAt: new Date(generatedAt).toISOString(),
    paperOnly: true,
    unitOfReplication: "dataset",
    providers: [...providers],
    datasetCoverage: {
      registryTotal: registry?.records?.length ?? null,
      real: registry ? registry.records.filter((record) => record.classification === "REAL").length : null,
      synthetic: registry ? registry.records.filter((record) => record.classification === "SYNTHETIC").length : null,
      mixed: registry ? registry.records.filter((record) => record.classification === "MIXED").length : null,
      invalid: registry ? registry.records.filter((record) => record.classification === "INVALID").length : null,
      development: registry ? (registry.counts?.DEVELOPMENT ?? 0) : null,
      contaminated: registry ? (registry.counts?.CONTAMINATED ?? 0) : null,
      unknownLeakage: registry ? (registry.counts?.UNKNOWN ?? 0) : null,
      eligibleReplication: eligibleCleanCount,
      selected: registry?.selectedIds ?? [],
      duplicateFingerprints: registry?.duplicates?.groups?.length ?? null,
      completedUnits: completed.length,
      failedUnits: failed.length,
      pendingUnits: pending.length,
      skippedUnits: skipped.length,
      cleanCompletedDatasets: cleanDatasetIds.length,
    },
    cleanDatasets: cleanDatasetIds,
    perDataset,
    metrics,
    regimeContext,
    replicationStatus: replicationStatusFor(cleanDatasetIds.length),
    datasetAvailability: {
      eligibleCleanDatasets: eligibleCleanCount,
      completedCleanDatasets: cleanDatasetIds.length,
      minimumRequiredToRun: MIN_CLEAN_TO_RUN,
      minimumForMultiDatasetClaim: MIN_CLEAN_FOR_MULTI,
      sufficient: sufficientDatasets,
      status: sufficientDatasets ? replicationStatusFor(cleanDatasetIds.length) : REPLICATION_STATUS.INSUFFICIENT_INDEPENDENT_REAL_DATASETS,
      note: sufficientDatasets
        ? "enough independent CLEAN real datasets are available for a descriptive replication summary"
        : `only ${cleanDatasetIds.length} CLEAN independent real dataset(s) completed: Phase 5C reports INSUFFICIENT_INDEPENDENT_REAL_DATASETS rather than slicing one capture into pseudo-independent datasets`,
    },
    statistics: {
      method: "per-dataset within-run A/B deltas, paired across providers, then descriptive cross-dataset aggregation (median/mean/quantiles) with a deterministic DATASET-level bootstrap",
      unit: "dataset",
      significance: null,
      significanceNote:
        "No significance test is performed and no p-value is claimed. n is tiny, the dataset is the replication unit, and the walk-forward windows inside each dataset overlap by design.",
      bootstrapIterations: DATASET_BOOTSTRAP_DEFAULTS.iterations,
      bootstrapSeed: DATASET_BOOTSTRAP_DEFAULTS.seed,
    },
    significance: null,
    verdict: null,
    noTuningFromOutcomes: true,
    limitations: buildLimitations({ cleanCount: cleanDatasetIds.length, perDataset, registry }),
    note: "PAPER ONLY. A replication status is a descriptive statement about observed paper deltas — not a winner, not a significance claim, and not a profitability claim.",
  };
}

export function buildLimitations({ cleanCount = 0, perDataset = [], registry = null } = {}) {
  const limitations = [
    "PAPER ONLY: every number is simulated paper accounting over historical observations; nothing here predicts profit.",
    "No significance test, no p-value, and no multiple-comparison correction is applied.",
    "The dataset is the replication unit; individual genomes are never treated as independent observations.",
    "Walk-forward windows inside a dataset overlap by design and are never counted as independent datasets.",
  ];
  if (cleanCount < MIN_CLEAN_TO_RUN) {
    limitations.push(
      `Only ${cleanCount} CLEAN independent real dataset(s) completed — the correct result is INSUFFICIENT_INDEPENDENT_REAL_DATASETS, not a replication claim.`,
    );
  } else if (cleanCount < MIN_CLEAN_FOR_MULTI) {
    limitations.push(`Only ${cleanCount} CLEAN datasets: replication status is ${replicationStatusFor(cleanCount)} and leave-one-out sensitivity is unavailable.`);
  }
  const unmatched = perDataset.filter((row) => row.clean && (row.mock?.speciesMatched !== true || row.deepseek?.speciesMatched !== true));
  if (unmatched.length > 0) {
    limitations.push(`${unmatched.length} dataset(s) completed without a verified strict species match on both providers.`);
  }
  if (registry && (registry.counts?.DEVELOPMENT ?? 0) > 0) {
    limitations.push("The development/original-benchmark dataset is reported separately and is excluded from the primary replication sample.");
  }
  limitations.push("Research cohorts are frozen: Phase 5C tests generalization of an ALREADY-CREATED cohort, not fresh market-adaptive research.");
  return limitations;
}

/** Rank-free descriptive direction table across every metric (section R). */
export function consistencyTable(summary) {
  return Object.values(summary.metrics ?? {}).map((metric) => ({
    metric: metric.key,
    group: metric.group,
    direction: metric.direction,
    n: metric.n,
    medianDeltaOfDeltas: metric.deltaOfDeltas.median,
    deepseekGreater: metric.consistency.deepseekGreaterThanMock,
    deepseekLess: metric.consistency.deepseekLessThanMock,
    equal: metric.consistency.equal,
    statement: metric.consistency.statement,
  }));
}
