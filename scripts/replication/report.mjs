/**
 * Phase 5C — human-readable reporting (PAPER ONLY).
 *
 * Plain-text renderers for the dataset registry, the frozen cohorts, the freeze
 * verification, and the replication summary. Every renderer is a pure function
 * of an artifact that already exists, so the text output and the JSON output
 * always describe the same numbers.
 */

import { consistencyTable } from "./aggregate.mjs";

function fmt(value, digits = 6) {
  if (!Number.isFinite(value)) return "n/a";
  return String(Number(value.toFixed(digits)));
}

function pct(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "n/a";
}

function line(char = "-", width = 72) {
  return char.repeat(width);
}

/* ============================================================================
 * Freeze
 * ==========================================================================*/

export function formatFreezeSummary(freeze) {
  const out = [];
  out.push(line("="));
  out.push("PHASE 5C EXPERIMENT FREEZE (PAPER ONLY)");
  out.push(line("="));
  out.push(`freezeVersion: ${freeze.freezeVersion}   digest: ${freeze.freezeDigest}`);
  out.push(`commit: ${freeze.commit ?? "n/a"}${freeze.dirtyWorkingTree ? " (dirty working tree)" : ""}   createdAt: ${freeze.createdAt}`);
  out.push(`arena: score v${freeze.arena.scoreVersion} · runner v${freeze.arena.runnerVersion} · cache v${freeze.arena.cacheVersion} · evaluator v${freeze.arena.evaluatorVersion}`);
  out.push(`arena run: population ${freeze.arena.population} · generations ${freeze.arena.generations} · workers ${freeze.arena.workers} · seeds ${freeze.arena.seeds.join(",")}`);
  out.push(`arena match: ${freeze.arena.speciesMatchMode} · no cloning ${freeze.arena.noCloning} · cross-cohort crossover ${freeze.arena.crossCohortCrossover}`);
  out.push(`stress profiles: ${freeze.arena.stressProfiles.join(", ")}`);
  out.push(`research: prompt v${freeze.research.promptVersion} · schema v${freeze.research.proposalSchemaVersion} · packet v${freeze.research.evidencePacketVersion} · compiler v${freeze.research.compilerVersion} · watchdog v${freeze.research.watchdogVersion}`);
  out.push(`providers: mock (deterministic, no subprocess) · deepseek ${freeze.providers.deepseek.provider} / ${freeze.providers.deepseek.model} (${freeze.providers.deepseek.reasoning})`);
  out.push(`replication: LLM calls required = ${freeze.replication.llmCallsRequired} · unit = ${freeze.replication.unit} · frozen cohorts = ${freeze.replication.cohortKeys.join(", ")}`);
  out.push(`gates: ${JSON.stringify(freeze.gates)}`);
  return out.join("\n");
}

export function formatFreezeVerification(verify, { frozenDigest = null } = {}) {
  const out = [];
  out.push(line("="));
  out.push("PHASE 5C FREEZE VERIFICATION");
  out.push(line("="));
  out.push(`stored freeze digest: ${frozenDigest ?? verify.freezeDigest ?? "none"}`);
  out.push(`current config digest: ${verify.currentDigest}`);
  out.push(`digest match: ${verify.digestMatches}`);
  out.push(`commit changed: ${verify.commitChanged} (frozen ${verify.frozenCommit ?? "n/a"} -> current ${verify.currentCommit ?? "n/a"})`);
  if (verify.criticalDrift.length > 0) {
    out.push("");
    out.push("CRITICAL DRIFT (this would be a different experiment):");
    for (const row of verify.criticalDrift) {
      out.push(`  ! ${row.path}: frozen ${JSON.stringify(row.frozen)} -> current ${JSON.stringify(row.current)}`);
    }
  }
  if (verify.advisoryDrift.length > 0) {
    out.push("");
    out.push("ADVISORY DRIFT (recorded, non-fatal):");
    for (const row of verify.advisoryDrift) out.push(`  ~ ${row.path}: frozen ${JSON.stringify(row.frozen)} -> current ${JSON.stringify(row.current)}`);
  }
  out.push("");
  out.push(verify.ok ? "RESULT: PASS — no critical configuration drift." : "RESULT: FAIL — critical configuration drift detected. Refusing to run a different experiment under the Phase 5C label.");
  return out.join("\n");
}

/* ============================================================================
 * Cohorts
 * ==========================================================================*/

export function formatCohortInspection(manifests = {}) {
  const out = [];
  out.push(line("="));
  out.push("PHASE 5C FROZEN RESEARCH COHORTS (PAPER ONLY)");
  out.push(line("="));
  for (const [key, manifest] of Object.entries(manifests)) {
    if (!manifest) {
      out.push(`${key}: NOT FROZEN`);
      continue;
    }
    out.push("");
    out.push(`${key} cohort — provider ${manifest.provider} · ${manifest.count} unique genome(s)`);
    out.push(`  cohortDigest: ${manifest.cohortDigest}`);
    out.push(`  freezeDigest: ${manifest.freezeDigest ?? "n/a"}`);
    out.push(`  source: ${manifest.origin?.root ?? "n/a"}${manifest.origin?.experimentId ? ` (experiment ${manifest.origin.experimentId})` : ""}`);
    out.push(`  species: ${JSON.stringify(manifest.speciesCounts ?? {})}`);
    out.push(`  families: ${JSON.stringify(manifest.familyCounts ?? {})}`);
    out.push(`  roles: ${JSON.stringify(manifest.roleCounts ?? {})}`);
    for (const entry of manifest.entries ?? []) {
      out.push(`    ${entry.genomeDigest.slice(0, 16)}  ${String(entry.species).padEnd(14)} ${String(entry.family ?? "").padEnd(24)} ${entry.authorRole ?? "n/a"}`);
    }
  }
  out.push("");
  out.push("Frozen cohorts are re-evaluated against independent datasets; the provider is never called again.");
  return out.join("\n");
}

/* ============================================================================
 * Dataset registry
 * ==========================================================================*/

export function formatDatasetRegistry(registry, { records = registry?.records ?? [] } = {}) {
  const out = [];
  out.push(line("="));
  out.push("PHASE 5C DATASET REGISTRY");
  out.push(line("="));
  out.push(
    `total ${records.length} · real ${records.filter((r) => r.classification === "REAL").length} · synthetic ${records.filter((r) => r.classification === "SYNTHETIC").length} · mixed ${records.filter((r) => r.classification === "MIXED").length} · invalid ${records.filter((r) => r.classification === "INVALID").length}`,
  );
  out.push(`roles: ${JSON.stringify(registry?.counts ?? {})}`);
  if (registry?.duplicates?.groups?.length > 0) {
    out.push(`duplicate fingerprints: ${registry.duplicates.groups.map((group) => group.datasetIds.join("=")).join(", ")}`);
  }
  out.push("");
  out.push(
    ["id".padEnd(34), "class".padEnd(10), "role".padEnd(14), "leak".padEnd(17), "min".padStart(7), "obs".padStart(7), "mints".padStart(6), "err".padStart(4), "elig"].join(" "),
  );
  for (const row of records) {
    out.push(
      [
        String(row.datasetId).slice(0, 34).padEnd(34),
        row.classification.padEnd(10),
        String(registry?.roles?.[row.datasetId] ?? "").padEnd(14),
        String(registry?.leakage?.[row.datasetId]?.overall ?? "").padEnd(17),
        fmt(row.durationMinutes, 1).padStart(7),
        String(row.observations ?? "n/a").padStart(7),
        String(row.uniqueMints ?? "n/a").padStart(6),
        String(row.feedErrors ?? "n/a").padStart(4),
        (registry?.eligibility?.[row.datasetId]?.eligible ? "yes" : "no").padStart(4),
      ].join(" "),
    );
    const reasons = registry?.eligibility?.[row.datasetId]?.reasons ?? [];
    if (reasons.length > 0 && registry?.roles?.[row.datasetId] !== "REPLICATION") {
      out.push(`    -> ${reasons.join("; ")}`);
    }
    const start = Number.isFinite(row.startMs) ? new Date(row.startMs).toISOString() : "?";
    const end = Number.isFinite(row.endMs) ? new Date(row.endMs).toISOString() : "?";
    if (row.fingerprint) out.push(`    fingerprint ${row.fingerprint.slice(0, 16)}…  ${start} → ${end}`);
  }
  out.push("");
  if (registry?.overlap?.length > 0) {
    out.push("Temporal overlap (REAL pairs):");
    for (const pair of registry.overlap) {
      out.push(
        `  ${pair.a} vs ${pair.b}: ${pair.status} overlap ${fmt((pair.overlapMs ?? 0) / 60000, 2)}min (A→B ${pct(pair.overlapFractionAtoB)}, B→A ${pct(pair.overlapFractionBtoA)})`,
      );
    }
    out.push("");
  }
  out.push(`Selected primary replication datasets: ${(registry?.selectedIds ?? []).join(", ") || "(none)"}`);
  return out.join("\n");
}

/* ============================================================================
 * Compact status (dashboard + CLI)
 * ==========================================================================*/

/**
 * A TINY, secret-free status artifact for the dashboard. Deliberately smaller
 * than `summary.json`: it carries counts and the freeze digest only, never the
 * full per-dataset metric tables.
 */
export function buildStatusArtifact(summary, { manifest = null } = {}) {
  const coverage = summary?.datasetCoverage ?? {};
  const units = manifest?.units ?? [];
  const countBy = (status) => units.filter((unit) => unit.status === status).length;
  return {
    schemaVersion: 1,
    phase: "5C",
    paperOnly: true,
    replicationId: summary?.replicationId ?? null,
    freezeDigest: summary?.freezeDigest ?? null,
    generatedAt: summary?.generatedAt ?? null,
    status: summary?.datasetAvailability?.status ?? summary?.replicationStatus ?? null,
    replicationStatus: summary?.replicationStatus ?? null,
    realDatasets: coverage.real ?? null,
    cleanReplicationDatasets: coverage.cleanCompletedDatasets ?? 0,
    developmentDatasets: coverage.development ?? null,
    contaminatedDatasets: coverage.contaminated ?? null,
    unknownLeakageDatasets: coverage.unknownLeakage ?? null,
    syntheticDatasets: coverage.synthetic ?? null,
    duplicateFingerprintGroups: coverage.duplicateFingerprints ?? null,
    eligibleReplicationDatasets: coverage.eligibleReplication ?? null,
    units: {
      total: units.length,
      completed: countBy("COMPLETED"),
      pending: countBy("PENDING") + countBy("RUNNING"),
      failed: countBy("FAILED"),
      skipped: countBy("SKIPPED") + countBy("INVALID_DATASET") + countBy("CONTAMINATED"),
    },
    significance: null,
    verdict: null,
    note: "Descriptive replication status only. No winner, no significance claim, no profitability claim.",
  };
}

/* ============================================================================
 * Replication summary
 * ==========================================================================*/

export function formatReplicationSummary(summary, { labelFor = (provider) => provider } = {}) {
  const out = [];
  const coverage = summary.datasetCoverage ?? {};
  out.push(line("="));
  out.push(`PHASE 5C REPLICATION SUMMARY — ${summary.replicationId ?? "n/a"}`);
  out.push(line("="));
  out.push(`freezeDigest: ${summary.freezeDigest ?? "n/a"}`);
  out.push("PAPER ONLY. Descriptive replication observation — no winner, no significance claim, no profitability claim.");
  out.push("");

  out.push("## Dataset coverage");
  out.push(`  registry datasets: ${coverage.registryTotal ?? "n/a"} (real ${coverage.real ?? "n/a"}, synthetic ${coverage.synthetic ?? "n/a"}, mixed ${coverage.mixed ?? "n/a"}, invalid ${coverage.invalid ?? "n/a"})`);
  out.push(`  development ${coverage.development ?? "n/a"} · contaminated ${coverage.contaminated ?? "n/a"} · unknown leakage ${coverage.unknownLeakage ?? "n/a"} · duplicate fingerprints ${coverage.duplicateFingerprints ?? "n/a"}`);
  out.push(`  eligible clean replication datasets: ${coverage.eligibleReplication ?? "n/a"} · datasets with both providers complete: ${coverage.cleanCompletedDatasets ?? 0}`);
  out.push(`  units: ${coverage.completedUnits ?? 0} completed · ${coverage.failedUnits ?? 0} failed · ${coverage.pendingUnits ?? 0} pending · ${coverage.skippedUnits ?? 0} skipped`);
  out.push("");

  const keyMetrics = ["medianArenaScore", "medianNetPaperReturn", "medianCostDrag", "medianDrawdown", "championLeagueCount"];
  for (const key of keyMetrics) {
    const metric = summary.metrics?.[key];
    if (!metric) continue;
    out.push(`## ${key} (${metric.group}, ${metric.direction})`);
    out.push(`  per-dataset delta-of-deltas (${labelFor("deepseek")} − ${labelFor("mock")}, same dataset):`);
    for (const row of metric.perDataset.deltaOfDeltas) {
      out.push(`    ${String(row.datasetId).padEnd(34)} ${fmt(row.value)}`);
    }
    out.push(`  Mock     A/B delta: median ${fmt(metric.mock.median)} (n ${metric.mock.n}, +${metric.mock.positive}/-${metric.mock.negative}/0 ${metric.mock.zero})`);
    out.push(`  DeepSeek A/B delta: median ${fmt(metric.deepseek.median)} (n ${metric.deepseek.n}, +${metric.deepseek.positive}/-${metric.deepseek.negative}/0 ${metric.deepseek.zero})`);
    out.push(`  delta-of-deltas: median ${fmt(metric.deltaOfDeltas.median)} · mean ${fmt(metric.deltaOfDeltas.mean)} · min ${fmt(metric.deltaOfDeltas.min)} · max ${fmt(metric.deltaOfDeltas.max)} · q1 ${fmt(metric.deltaOfDeltas.q1)} · q3 ${fmt(metric.deltaOfDeltas.q3)}`);
    out.push(`  consistency: ${metric.consistency.statement}`);
    if (metric.bootstrap?.available) {
      out.push(`  dataset-level bootstrap (${metric.bootstrap.iterations} iterations, seed ${metric.bootstrap.seed}): median [${fmt(metric.bootstrap.medianDifferenceInterval.low)}, ${fmt(metric.bootstrap.medianDifferenceInterval.high)}]${metric.bootstrap.stable ? "" : " — UNSTABLE at this n"}`);
    }
    out.push(`  raw sign preserved: ${metric.directionNote}`);
    out.push("");
  }

  out.push("## Consistency (all metrics, descriptive)");
  for (const row of consistencyTable(summary)) {
    out.push(`  ${row.metric.padEnd(30)} n ${String(row.n).padStart(2)} · DoD median ${String(fmt(row.medianDeltaOfDeltas)).padStart(12)} · ${row.deepseekGreater}/${row.n} greater`);
  }
  out.push("");

  out.push("## Leave-one-dataset-out sensitivity");
  const arenaLoo = summary.metrics?.medianArenaScore?.leaveOneOut;
  if (arenaLoo?.available) {
    for (const row of arenaLoo.rows) out.push(`  without ${String(row.removed).padEnd(34)} median ${fmt(row.median)} mean ${fmt(row.mean)}`);
    out.push(`  spread of the leave-one-out medians: ${fmt(arenaLoo.medianSpread.min)} … ${fmt(arenaLoo.medianSpread.max)}`);
    out.push(`  ${arenaLoo.note}`);
  } else {
    out.push(`  ${arenaLoo?.reason ?? "unavailable"}`);
  }
  out.push("");

  out.push("## Regime context (read-only)");
  for (const row of summary.regimeContext ?? []) {
    out.push(
      `  ${String(row.datasetId).padEnd(34)} regimes ${row.regimesAvailable ? JSON.stringify(row.regimes) : "not computed"} · DoD arenaScore ${fmt(row.deltaOfDeltas.medianArenaScore)} net ${fmt(row.deltaOfDeltas.medianNetPaperReturn)}`,
    );
  }
  out.push("");

  out.push("## Limitations");
  for (const limitation of summary.limitations ?? []) out.push(`  - ${limitation}`);
  out.push("");

  out.push("## Replication status");
  out.push(`  status: ${summary.datasetAvailability?.status ?? summary.replicationStatus}`);
  out.push(`  descriptive replication status: ${summary.replicationStatus}`);
  out.push(`  ${summary.datasetAvailability?.note ?? ""}`);
  out.push(`  significance: ${summary.significance === null ? "null (no significance claim)" : summary.significance}`);
  out.push(`  verdict: ${summary.verdict === null ? "null (no winner)" : summary.verdict}`);
  return out.join("\n");
}
