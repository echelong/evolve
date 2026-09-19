/**
 * Phase 5C.2 — cross-wave META-SUMMARY (PAPER ONLY).
 *
 * A read-only, descriptive roll-up of already-completed replication waves. It
 * reads the wave manifests and the `summary.json` artifacts those waves already
 * wrote; it NEVER re-runs a wave dataset, never touches a dataset capture, and
 * never calls a provider.
 *
 * THE UNIT OF REPLICATION REMAINS THE DATASET. Individual genomes are never
 * pooled as independent observations, and walk-forward windows inside one
 * capture are never counted as separate datasets. The meta-summary simply
 * concatenates each wave's DATASET-LEVEL delta-of-deltas and describes them
 * together (and per wave).
 *
 * This is NOT cross-validation. It is a descriptive meta-summary of two (or
 * more) named waves of a predeclared experiment. No significance test is
 * performed, no p-value is claimed, and `significance`/`verdict` stay `null`.
 *
 * PAPER ONLY. No wallet, no signing, no write-RPC, no provider call, and no
 * Phase 5D / Jev participation.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { METRIC_PATHS } from "../research-compare.mjs";
import {
  DATASET_BOOTSTRAP_DEFAULTS,
  MIN_CLEAN_FOR_MULTI,
  MIN_CLEAN_TO_RUN,
} from "./constants.mjs";
import { compareWaveEvaluationContracts } from "./contract.mjs";
import {
  datasetBootstrap,
  describeValues,
  leaveOneOut,
  meanOf,
  medianOf,
  round6,
} from "./aggregate.mjs";
import { WAVE_PHASE, listWaveManifests } from "./waves.mjs";

export const META_SUMMARY_SCHEMA_VERSION = 1;

/** Read a completed replication run's summary artifact (read-only). */
export async function readRunSummary(baseDir, replicationId) {
  if (!replicationId) return null;
  try {
    return JSON.parse(await readFile(path.join(baseDir, replicationId, "summary.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Read a run's canonicality label (`CANONICAL` / `NON_CANONICAL`) from its run
 * manifest. A missing/unreadable manifest is `UNKNOWN` — never silently
 * canonical. Read-only.
 */
export async function readRunCanonicality(baseDir, replicationId) {
  if (!replicationId) return { label: null, canonical: null, reason: "no replication id" };
  try {
    const manifest = JSON.parse(await readFile(path.join(baseDir, replicationId, "manifest.json"), "utf8"));
    const canonicality = manifest?.canonicality ?? null;
    return {
      label: canonicality?.label ?? null,
      canonical: canonicality?.canonical === true,
      devOverride: canonicality?.devOverride === true,
      reasons: canonicality?.reasons ?? [],
      reason: canonicality ? null : "the run manifest records no canonicality verdict",
    };
  } catch {
    return { label: null, canonical: null, reason: "no readable run manifest" };
  }
}

/**
 * Leave-one-WAVE-out descriptive sensitivity over dataset-level observations.
 * Never cross-validation — removing a wave leaves a smaller DESCRIPTION.
 */
export function leaveOneWaveOut(pairs = [], waveRows = []) {
  const waveIds = waveRows.filter((row) => pairs.some((pair) => pair.waveId === row.waveId)).map((row) => row.waveId);
  if (waveIds.length < 2) {
    return {
      available: false,
      required: 2,
      reason: `leave-one-wave-out sensitivity needs at least 2 waves with dataset-level observations (have ${waveIds.length})`,
      note: "This is descriptive sensitivity, not cross-validation, and not a significance test.",
    };
  }
  const rows = waveIds.map((waveId) => {
    const remaining = pairs.filter((pair) => pair.waveId !== waveId).map((pair) => pair.value);
    return {
      removedWave: waveId,
      remainingDatasets: remaining.length,
      median: round6(medianOf(remaining)),
      mean: round6(meanOf(remaining)),
    };
  });
  const medians = rows.map((row) => row.median).filter((value) => Number.isFinite(value));
  return {
    available: true,
    unit: "wave",
    rows,
    medianSpread: medians.length > 0 ? { min: Math.min(...medians), max: Math.max(...medians) } : null,
    note: "Leave-one-wave-out DESCRIPTIVE sensitivity — not cross-validation, and not a significance test.",
  };
}

/** Descriptive between-wave difference of the wave-level medians/means. */
export function betweenWaveDifferences(pairs = [], waveRows = []) {
  const waveIds = waveRows.filter((row) => pairs.some((pair) => pair.waveId === row.waveId)).map((row) => row.waveId);
  if (waveIds.length < 2) {
    return { available: false, reason: "fewer than two waves have dataset-level observations" };
  }
  const rows = [];
  for (let i = 0; i < waveIds.length; i += 1) {
    for (let j = i + 1; j < waveIds.length; j += 1) {
      const a = pairs.filter((pair) => pair.waveId === waveIds[i]).map((pair) => pair.value);
      const b = pairs.filter((pair) => pair.waveId === waveIds[j]).map((pair) => pair.value);
      const aMedian = round6(medianOf(a));
      const bMedian = round6(medianOf(b));
      const aMean = round6(meanOf(a));
      const bMean = round6(meanOf(b));
      rows.push({
        a: waveIds[i],
        b: waveIds[j],
        aMedian,
        bMedian,
        aMean,
        bMean,
        medianDifference: Number.isFinite(aMedian) && Number.isFinite(bMedian) ? round6(bMedian - aMedian) : null,
        meanDifference: Number.isFinite(aMean) && Number.isFinite(bMean) ? round6(bMean - aMean) : null,
      });
    }
  }
  return {
    available: true,
    rows,
    note: "Descriptive between-wave difference of dataset-level medians/means. Not a test, not cross-validation, and not a profitability claim.",
  };
}

/**
 * Build the meta-summary.
 *
 * @param {{
 *   waves: Array<{ manifest: object|null, summary: object|null }>,
 *   generatedAt?: number,
 * }} options
 */
export function buildMetaSummary({ waves = [], generatedAt = Date.now() } = {}) {
  const waveRows = [];
  const perDataset = [];

  for (const entry of waves) {
    const manifest = entry?.manifest ?? null;
    const summary = entry?.summary ?? null;
    const clean = Array.isArray(summary?.cleanDatasets) ? summary.cleanDatasets : [];
    const waveRow = {
      waveId: manifest?.waveId ?? summary?.replicationId ?? "unknown",
      replicationId: manifest?.replicationId ?? summary?.replicationId ?? null,
      manifestDigest: manifest?.manifestDigest ?? null,
      historical: manifest?.historical === true,
      status: manifest?.status ?? null,
      available: Boolean(summary),
      cleanDatasetCount: clean.length,
      declaredDatasetCount: Array.isArray(manifest?.datasetIds) ? manifest.datasetIds.length : null,
      // Phase 5C.3 identity: each wave is canonical against its OWN freeze.
      freezePath: manifest?.freezePath ?? null,
      freezeDigest: manifest?.freezeDigest ?? null,
      evaluationContractDigest: manifest?.evaluationContractDigest ?? null,
      mockCohortDigest: manifest?.mockCohortDigest ?? null,
      deepseekCohortDigest: manifest?.deepseekCohortDigest ?? null,
      canonical: entry?.canonicality?.canonical ?? null,
      canonicalityLabel: entry?.canonicality?.label ?? null,
      excludedFromAggregate: entry?.excludedFromAggregate === true,
    };
    waveRows.push(waveRow);
    if (!summary) continue;
    if (waveRow.excludedFromAggregate) continue;

    const byId = new Map((summary.perDataset ?? []).map((row) => [row.datasetId, row]));
    for (const datasetId of clean) {
      const row = byId.get(datasetId);
      if (!row) continue;
      perDataset.push({
        waveId: waveRow.waveId,
        replicationId: waveRow.replicationId,
        datasetId,
        datasetFingerprint: row.datasetFingerprint ?? null,
        clean: row.clean === true,
        paired: row.paired?.paired === true,
        mockResearchMinusControl: row.mock?.deltas ?? null,
        deepseekResearchMinusControl: row.deepseek?.deltas ?? null,
        deltaOfDeltas: row.paired?.deltaOfDeltas ?? {},
      });
    }
  }

  const metrics = {};
  for (const metric of METRIC_PATHS) {
    const pairs = perDataset
      .map((row) => ({ datasetId: row.datasetId, waveId: row.waveId, value: row.deltaOfDeltas?.[metric.key] ?? null }))
      .filter((pair) => Number.isFinite(pair.value));
    const values = pairs.map((pair) => pair.value);

    const waveLevel = {};
    for (const waveRow of waveRows) {
      const waveValues = pairs.filter((pair) => pair.waveId === waveRow.waveId).map((pair) => pair.value);
      waveLevel[waveRow.waveId] = {
        n: waveValues.length,
        median: round6(medianOf(waveValues)),
        mean: round6(meanOf(waveValues)),
        min: waveValues.length > 0 ? Math.min(...waveValues) : null,
        max: waveValues.length > 0 ? Math.max(...waveValues) : null,
        summary: describeValues(waveValues),
      };
    }

    metrics[metric.key] = {
      key: metric.key,
      group: metric.group,
      path: metric.path,
      direction: metric.direction,
      unit: "dataset",
      n: values.length,
      perDataset: pairs,
      waveLevel,
      allDatasets: describeValues(values),
      betweenWave: betweenWaveDifferences(pairs, waveRows),
      bootstrap: datasetBootstrap(values),
      leaveOneOut: leaveOneOut(values, pairs.map((pair) => pair.datasetId)),
      leaveOneWaveOut: leaveOneWaveOut(pairs, waveRows),
      directionNote:
        metric.direction === "lower-better"
          ? "lower is generally favourable — the raw delta keeps its own sign and is never rewritten"
          : metric.direction === "higher-better"
            ? "higher is generally favourable — reported as a raw difference"
            : "direction not ranked",
      significance: null,
      verdict: null,
    };
  }

  const datasetsPerWave = Object.fromEntries(waveRows.map((row) => [row.waveId, row.cleanDatasetCount]));
  const totalCleanDatasets = perDataset.length;

  // Phase 5C.3: cross-wave comparability is decided by the evaluation contract
  // and both frozen cohort digests — never by the full freeze digest, which is
  // EXPECTED to differ between waves (it includes the commit). Incomparable
  // waves are reported, never silently aggregated.
  // A wave participates in the comparability check as soon as it PINS an
  // evaluation contract (even before its own freeze is bound): the pin is what
  // the freeze is validated against, so an unbound-but-pinned wave must not be
  // invisible to a cross-wave comparison.
  const comparability = compareWaveEvaluationContracts(
    waveRows.filter((row) => !row.excludedFromAggregate && row.evaluationContractDigest),
  );
  const excludedNoncanonical = waveRows
    .filter((row) => row.excludedFromAggregate)
    .map((row) => ({
      waveId: row.waveId,
      replicationId: row.replicationId,
      canonicalityLabel: row.canonicalityLabel,
      reason: "NON_CANONICAL (--dev) evidence is excluded from the canonical meta-summary by default",
    }));

  return {
    schemaVersion: META_SUMMARY_SCHEMA_VERSION,
    phase: WAVE_PHASE,
    paperOnly: true,
    generatedAt: new Date(generatedAt).toISOString(),
    method: "meta-summary",
    crossValidation: false,
    unitOfReplication: "dataset",
    waves: waveRows,
    waveIds: waveRows.map((row) => row.waveId),
    aggregatedWaveIds: waveRows.filter((row) => !row.excludedFromAggregate).map((row) => row.waveId),
    excludedNoncanonical,
    includeNoncanonical: excludedNoncanonical.length > 0,
    comparability,
    totalCleanDatasets,
    datasetsPerWave,
    perDataset,
    metrics,
    statistics: {
      method:
        "concatenation of each wave's DATASET-level delta-of-deltas (paired DeepSeek − Mock per dataset), described per wave and together",
      unit: "dataset",
      significance: null,
      significanceNote:
        "No significance test is performed and no p-value is claimed. The dataset is the replication unit and n is tiny; this is a descriptive meta-summary, not cross-validation.",
      bootstrapIterations: DATASET_BOOTSTRAP_DEFAULTS.iterations,
      bootstrapSeed: DATASET_BOOTSTRAP_DEFAULTS.seed,
    },
    significance: null,
    verdict: null,
    limitations: buildMetaLimitations({ totalCleanDatasets, waveRows, perDataset, comparability, excludedNoncanonical }),
    note:
      "PAPER ONLY. A meta-summary is a descriptive statement about observed paper deltas across named replication waves — not cross-validation, not a winner, not a significance claim, and not a profitability claim.",
  };
}

export function buildMetaLimitations({
  totalCleanDatasets = 0,
  waveRows = [],
  perDataset = [],
  comparability = null,
  excludedNoncanonical = [],
} = {}) {
  const limitations = [
    "PAPER ONLY: every number is simulated paper accounting over historical observations; nothing here predicts profit.",
    "This is a descriptive meta-summary of named replication waves — it is NOT cross-validation.",
    "No significance test, no p-value, and no multiple-comparison correction is applied.",
    "The dataset is the replication unit; individual genomes are never treated as independent observations.",
    "Walk-forward windows inside a dataset overlap by design and are never counted as independent datasets.",
  ];
  const unpaired = perDataset.filter((row) => row.paired !== true).length;
  if (unpaired > 0) limitations.push(`${unpaired} dataset(s) are missing a paired provider comparison and are excluded from the delta-of-deltas.`);
  if (totalCleanDatasets < MIN_CLEAN_TO_RUN) {
    limitations.push(`Only ${totalCleanDatasets} CLEAN dataset(s) across all waves: no replication statement is made.`);
  } else if (totalCleanDatasets < MIN_CLEAN_FOR_MULTI) {
    limitations.push(`Only ${totalCleanDatasets} CLEAN dataset(s) across all waves: the combined description is limited.`);
  }
  const empty = waveRows.filter((row) => !row.available).map((row) => row.waveId);
  if (empty.length > 0) limitations.push(`Wave(s) ${empty.join(", ")} have no completed summary yet and contribute nothing to this meta-summary.`);
  const historical = waveRows.filter((row) => row.historical).map((row) => row.waveId);
  if (historical.length > 0) {
    limitations.push(
      `Wave(s) ${historical.join(", ")} are HISTORICAL and were evaluated before this phase; they are read from existing artifacts and never re-run.`,
    );
  }
  if (comparability && comparability.status === "INCOMPARABLE_WAVES") {
    limitations.push(
      `INCOMPARABLE_WAVES: the selected waves do not share one evaluation contract (differing field(s): ${comparability.differences
        .map((row) => row.field)
        .join(", ")}). The combination is REFUSED, not described.`,
    );
  }
  if (excludedNoncanonical.length > 0) {
    limitations.push(
      `Wave(s) ${excludedNoncanonical.map((row) => row.waveId).join(", ")} are NON_CANONICAL (--dev) and are excluded from the canonical meta-summary; ` +
        "they are listed for transparency and never counted.",
    );
  }
  return limitations;
}

/**
 * Read every (or a filtered subset of) wave manifest plus its completed summary.
 * Read-only: this never executes and never writes.
 */
export async function loadMetaSummary({
  baseDir,
  waveIds = null,
  generatedAt = Date.now(),
  includeNoncanonical = false,
} = {}) {
  const manifests = await listWaveManifests(baseDir);
  const selected = Array.isArray(waveIds) && waveIds.length > 0
    ? manifests.filter((manifest) => waveIds.includes(manifest.waveId))
    : manifests;

  const waves = [];
  const pending = [];
  for (const manifest of selected) {
    const replicationId = manifest.replicationId ?? null;
    const summary = await readRunSummary(baseDir, replicationId);
    const canonicality = await readRunCanonicality(baseDir, replicationId);
    // Phase 5C.3: `--dev` evidence is NON_CANONICAL and is excluded from the
    // canonical meta-summary by default. It is never silently counted.
    const excludedFromAggregate = canonicality.canonical === false && includeNoncanonical !== true;
    if (!summary) {
      pending.push({
        waveId: manifest.waveId,
        replicationId,
        reason: replicationId ? `no summary.json under ${replicationId}` : "the manifest records no replication id",
      });
    }
    waves.push({ manifest, summary, canonicality, excludedFromAggregate });
  }

  const meta = buildMetaSummary({ waves, generatedAt });
  meta.pendingWaves = pending;
  meta.includeNoncanonical = includeNoncanonical === true;
  meta.requestedWaveIds = Array.isArray(waveIds) ? [...waveIds] : null;
  meta.unknownWaveIds = Array.isArray(waveIds)
    ? waveIds.filter((id) => !manifests.some((manifest) => manifest.waveId === id))
    : [];
  return meta;
}

/* ============================================================================
 * Human-readable rendering
 * ==========================================================================*/

function fmt(value) {
  return Number.isFinite(value) ? String(Number(value.toFixed(6))) : "n/a";
}

const KEY_METRICS = ["medianArenaScore", "medianNetPaperReturn", "medianCostDrag", "medianDrawdown", "championLeagueCount"];

export function formatMetaSummary(meta) {
  const out = [];
  out.push("=".repeat(72));
  out.push("PHASE 5C.2/5C.3 CROSS-WAVE META-SUMMARY (PAPER ONLY)");
  out.push("=".repeat(72));
  out.push(`waves: ${(meta.waveIds ?? []).join(", ") || "none"}`);
  out.push(`aggregated waves: ${(meta.aggregatedWaveIds ?? []).join(", ") || "none"}`);
  out.push(`total clean datasets: ${meta.totalCleanDatasets}`);
  out.push(`datasets per wave: ${JSON.stringify(meta.datasetsPerWave)}`);
  out.push("NOT cross-validation. Descriptive meta-summary of named replication waves.");
  out.push("");

  // Phase 5C.3: comparability and canonicality are stated explicitly, never
  // implied by an aggregate.
  const comparability = meta.comparability ?? null;
  if (comparability) {
    out.push("## Cross-wave comparability (Phase 5C.3)");
    out.push(`  status: ${comparability.status}`);
    for (const row of comparability.waves ?? []) {
      out.push(
        `  ${String(row.waveId).padEnd(8)} freeze ${String(row.freezeDigest ?? "unbound").slice(0, 12)} · contract ${String(row.evaluationContractDigest ?? "none").slice(0, 12)}`,
      );
    }
    if (comparability.status === "INCOMPARABLE_WAVES") {
      for (const row of comparability.differences) {
        out.push(`  INCOMPARABLE ${row.field}: ${row.a ?? "none"} (${row.between?.[0]}) vs ${row.b ?? "none"} (${row.between?.[1]})`);
      }
      out.push("  REFUSED: waves with different evaluation contracts are never combined.");
    } else if (comparability.status === "SINGLE_WAVE") {
      out.push("  only one wave is selected: nothing is combined across waves.");
    } else {
      out.push("  different full freeze digests are allowed; the evaluation contract and both frozen cohort digests match.");
    }
    out.push("");
  }

  if ((meta.excludedNoncanonical ?? []).length > 0) {
    out.push("## Excluded NON_CANONICAL waves");
    for (const row of meta.excludedNoncanonical) {
      out.push(`  ${String(row.waveId).padEnd(8)} ${row.replicationId ?? "—"} (${row.canonicalityLabel ?? "unknown"}) — excluded from the canonical aggregate`);
    }
    out.push("");
  }

  out.push("## Per-dataset delta-of-deltas (DeepSeek − Mock, same dataset)");
  for (const row of meta.perDataset ?? []) {
    out.push(
      `  ${String(row.waveId).padEnd(8)} ${String(row.datasetId).padEnd(34)} score ${fmt(row.deltaOfDeltas?.medianArenaScore)} net ${fmt(row.deltaOfDeltas?.medianNetPaperReturn)}`,
    );
  }
  out.push("");

  for (const key of KEY_METRICS) {
    const metric = meta.metrics?.[key];
    if (!metric) continue;
    out.push(`## ${key} (${metric.group}, ${metric.direction})`);
    for (const [waveId, row] of Object.entries(metric.waveLevel ?? {})) {
      out.push(`  ${String(waveId).padEnd(8)} n ${row.n} · median ${fmt(row.median)} · mean ${fmt(row.mean)}`);
    }
    const all = metric.allDatasets ?? {};
    out.push(
      `  ALL datasets: n ${all.n} · median ${fmt(all.median)} · mean ${fmt(all.mean)} · min ${fmt(all.min)} · max ${fmt(all.max)} · q1 ${fmt(all.q1)} · q3 ${fmt(all.q3)} · +${all.positive}/-${all.negative}/0 ${all.zero}`,
    );
    if (metric.bootstrap?.available) {
      out.push(`  dataset bootstrap: median [${fmt(metric.bootstrap.medianDifferenceInterval.low)}, ${fmt(metric.bootstrap.medianDifferenceInterval.high)}]${metric.bootstrap.stable ? "" : " — UNSTABLE at this n"}`);
    }
    if (metric.leaveOneWaveOut?.available) {
      for (const row of metric.leaveOneWaveOut.rows) {
        out.push(`  without ${String(row.removedWave).padEnd(8)} median ${fmt(row.median)} · mean ${fmt(row.mean)} (n ${row.remainingDatasets})`);
      }
    }
    out.push("");
  }

  out.push("## Between-wave descriptive difference");
  const between = meta.metrics?.medianArenaScore?.betweenWave;
  if (between?.available) {
    for (const row of between.rows) {
      out.push(`  ${row.a} vs ${row.b}: median ${fmt(row.aMedian)} → ${fmt(row.bMedian)} (difference ${fmt(row.medianDifference)})`);
    }
  } else {
    out.push(`  ${between?.reason ?? "unavailable"}`);
  }
  out.push("");

  out.push("## Limitations");
  for (const limitation of meta.limitations ?? []) out.push(`  - ${limitation}`);
  out.push("");
  out.push(`significance: ${meta.significance === null ? "null (no significance claim)" : meta.significance}`);
  out.push(`verdict: ${meta.verdict === null ? "null (no winner)" : meta.verdict}`);
  out.push("not cross-validation: this is a descriptive meta-summary only.");
  return out.join("\n");
}
