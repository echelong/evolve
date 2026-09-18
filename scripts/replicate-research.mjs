#!/usr/bin/env node
/**
 * Phase 5C — multi-dataset replication CLI (PAPER ONLY).
 *
 *   npm run replicate:research -- --freeze phase5c --datasets auto
 *   npm run replicate:research -- --cohorts
 *   npm run replicate:research -- --verify-freeze
 *   npm run replicate:research -- --summary
 *   npm run replicate:research -- --plan
 *   npm run replicate:research -- --datasets session-A,session-B
 *
 * For each eligible REAL dataset it runs the SAME strict species-matched A/B
 * experiment twice: once with the frozen MOCK research cohort, once with the
 * frozen DEEPSEEK research cohort, each against its own freshly generated
 * deterministic conventional control.
 *
 * The Mock and DeepSeek arms are never made species-identical to each other.
 * Research cohorts are frozen, so Phase 5C makes ZERO LLM calls. Execution is
 * synchronous and resumable; there is no daemon and no background process.
 *
 * Nothing here trades, signs, or executes anything.
 */

import path from "node:path";

import { parseArgs } from "./lib/args.mjs";
import { createMarketConfig } from "./market/config.mjs";
import { formatCaptureGuidance } from "./replication/guidance.mjs";
import {
  DEFAULT_FREEZE_VERSION,
  MIN_CLEAN_TO_RUN,
  REPLICATION_DIR,
  RUN_STATUS_FILE,
  RUN_SUMMARY_FILE,
} from "./replication/constants.mjs";
import {
  readFreeze,
  verifyFreeze,
  canonicalityVerdict,
  readGitCommit,
  readWorkingTreeDirty,
  writeFreeze,
} from "./replication/freeze.mjs";
import { freezeCohorts, inspectCohort, cohortDirFor } from "./replication/cohorts.mjs";
import {
  buildReplicationRegistry,
  collectArenaDatasetUsage,
  discoverDatasetRecords,
  computeDatasetRegimes,
} from "./replication/datasets.mjs";
import { evaluationKey, replicationIdFor } from "./replication/identity.mjs";
import { aggregateReplication } from "./replication/aggregate.mjs";
import {
  buildStatusArtifact,
  formatCohortInspection,
  formatDatasetRegistry,
  formatFreezeVerification,
  formatReplicationSummary,
} from "./replication/report.mjs";
import { loadRunManifest, planReplication, runReplication, writeRunManifest } from "./replication/runner.mjs";

const BOOLEAN_FLAGS = ["json", "verify-freeze", "cohorts", "summary", "plan", "rerun", "dev", "write-freeze", "help"];
const VALUE_FLAGS = ["freeze", "datasets", "providers", "out"];

function usage() {
  return [
    "EVOLVE Phase 5C multi-dataset replication (PAPER ONLY)",
    "",
    "  npm run replicate:research -- --datasets auto",
    "  npm run replicate:research -- --datasets session-A,session-B",
    "  npm run replicate:research -- --verify-freeze",
    "  npm run replicate:research -- --cohorts",
    "  npm run replicate:research -- --summary",
    "  npm run replicate:research -- --plan",
    "",
    "Options:",
    `  --freeze <name>       freeze version label (default ${DEFAULT_FREEZE_VERSION})`,
    "  --datasets <auto|ids> comma-separated dataset ids, or `auto` for every eligible dataset",
    "  --providers <list>    providers to run (default mock,deepseek)",
    "  --out <dir>           replication root (default .evolve/replication)",
    "  --plan                print the deterministic plan and exit (no arena is run)",
    "  --verify-freeze       compare the live code/config against the stored freeze; FAIL on critical drift",
    "  --cohorts             show the frozen cohort manifests (freezes them if not yet frozen)",
    "  --summary             print the cross-dataset replication summary",
    "  --rerun               explicitly re-execute units that already COMPLETED (labelled)",
    "  --dev                 allow a run whose commit/tree does not match the freeze; evidence is labelled NON_CANONICAL",
    "  --json                machine-readable output",
    "",
    "The unit of replication is the DATASET. Synthetic datasets are never counted",
    "as real, overlapping captures are never treated as independent, and no",
    "walk-forward window is ever counted as a separate dataset.",
  ].join("\n");
}

function fail(message) {
  console.error(`[replicate:research] ${message}`);
  process.exitCode = 1;
}

/** Load cohorts, freezing them on first use (idempotent, never mutating). */
async function loadCohorts(baseDir, freezeDigest) {
  const manifests = await freezeCohorts({ baseDir, freezeDigest, keys: ["mock", "deepseek"] });
  return manifests;
}

async function buildRegistry({ config, baseDir, cohorts }) {
  const historyRoot = config.historyRoot ?? path.join(".evolve", "history");
  const arenasDir = process.env.EVOLVE_ARENAS_DIR ?? path.join(".evolve", "arenas");
  const [records, arenaUsage] = await Promise.all([
    discoverDatasetRecords(historyRoot),
    collectArenaDatasetUsage(arenasDir),
  ]);
  const registry = buildReplicationRegistry({
    records,
    cohorts,
    arenaUsage,
  });
  registry.baseDir = baseDir;
  registry.freezeDigest = null;
  registry.historyRoot = historyRoot;
  return registry;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { booleanFlags: BOOLEAN_FLAGS, valueFlags: VALUE_FLAGS });
  if (args.help === true) {
    console.log(usage());
    return;
  }

  const baseDir = path.resolve(String(args.out ?? process.env.EVOLVE_REPLICATION_DIR ?? REPLICATION_DIR));
  const freezeVersion = String(args.freeze ?? DEFAULT_FREEZE_VERSION);
  const providers = String(args.providers ?? "mock,deepseek")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const config = createMarketConfig(
    { ...process.env, EVOLVE_MARKET_MODE: process.env.EVOLVE_MARKET_MODE ?? "synthetic" },
    { loadEnv: true },
  );

  // ---- Freeze ------------------------------------------------------------
  const existingFreeze = await readFreeze({ root: baseDir });
  let freeze = existingFreeze;
  if (args["write-freeze"] === true || !existingFreeze) {
    freeze = await writeFreeze(
      (await import("./replication/freeze.mjs")).buildFreezeConfig({
        freezeVersion,
        commit: readGitCommit(),
        dirty: readWorkingTreeDirty(),
      }),
      { root: baseDir },
    );
    if (!existingFreeze) console.log(`[replicate:research] wrote freeze artifact: ${path.join(baseDir, "phase5c-freeze.json")}`);
  }

  if (args["verify-freeze"] === true) {
    const verify = verifyFreeze(freeze);
    if (args.json === true) {
      console.log(JSON.stringify(verify, null, 2));
    } else {
      console.log(formatFreezeVerification(verify, { frozenDigest: freeze?.freezeDigest ?? null }));
    }
    if (!verify.ok) process.exitCode = 1;
    return;
  }

  if (!freeze) {
    fail("no freeze artifact could be loaded or created");
    return;
  }
  if (freeze.freezeVersion !== freezeVersion) {
    console.warn(
      `[replicate:research] WARNING: stored freeze is '${freeze.freezeVersion}' but '${freezeVersion}' was requested — using the stored artifact.`,
    );
  }

  // ---- Cohorts -----------------------------------------------------------
  const cohorts = await loadCohorts(baseDir, freeze.freezeDigest);
  const cohortDigests = Object.fromEntries(Object.entries(cohorts).map(([key, manifest]) => [key, manifest?.cohortDigest ?? null]));

  const replicationId = replicationIdFor({
    freezeDigest: freeze.freezeDigest,
    cohortDigests,
    providers,
    evaluation: evaluationKey(freeze),
  });
  freeze = { ...freeze, replicationId, cohortDigests };

  if (args.cohorts === true) {
    if (args.json === true) {
      console.log(JSON.stringify({ replicationId, cohorts: Object.fromEntries(Object.entries(cohorts).map(([key, manifest]) => [key, inspectCohort(manifest)])) }, null, 2));
    } else {
      console.log(formatCohortInspection(cohorts));
    }
    return;
  }

  // ---- Registry ----------------------------------------------------------
  const registry = await buildRegistry({ config, baseDir, cohorts });
  registry.freezeDigest = freeze.freezeDigest;

  const runDir = path.join(baseDir, replicationId);
  const requestedIds = args.datasets === undefined ? "auto" : String(args.datasets);
  const explicit = requestedIds.trim().toLowerCase() === "auto" ? null : requestedIds.split(",").map((value) => value.trim()).filter(Boolean);
  const selection = explicit
    ? {
        mode: "explicit",
        datasetIds: explicit.filter((id) => registry.roles[id] === "REPLICATION"),
        datasets: registry.records.filter((record) => explicit.includes(record.datasetId) && registry.roles[record.datasetId] === "REPLICATION"),
        unknown: explicit.filter((id) => !registry.records.some((record) => record.datasetId === id)),
        ineligible: explicit
          .filter((id) => registry.records.some((record) => record.datasetId === id) && registry.roles[id] !== "REPLICATION")
          .map((id) => ({ datasetId: id, role: registry.roles[id], reasons: registry.eligibility[id]?.reasons ?? [] })),
      }
    : { mode: "auto", datasetIds: [...registry.selectedIds], datasets: [...registry.selected], unknown: [], ineligible: [] };

  if (selection.unknown.length > 0) fail(`unknown dataset id(s): ${selection.unknown.join(", ")}`);
  const noEligible = selection.datasets.length === 0;
  if (!noEligible && selection.datasets.length < MIN_CLEAN_TO_RUN) {
    console.warn(
      `[replicate:research] only ${selection.datasets.length} eligible CLEAN dataset(s): primary multi-dataset replication requires ${MIN_CLEAN_TO_RUN}.`,
    );
  }

  // ---- Plan --------------------------------------------------------------
  const plan = planReplication({ freeze, cohorts, datasets: selection.datasets, providers });

  if (args.summary === true || args.plan === true || noEligible || selection.datasets.length < MIN_CLEAN_TO_RUN) {
    const existingManifest = await loadRunManifest(runDir);
    const summary = aggregateReplication({
      replicationId,
      freezeDigest: freeze.freezeDigest,
      units: existingManifest?.units ?? [],
      registry,
      datasetRegimes: existingManifest?.regimes ?? {},
      providers: providers.length >= 2 ? ["mock", "deepseek"] : providers,
    });
    if (args.plan === true && args.summary !== true) {
      if (args.json === true) {
        console.log(JSON.stringify({ replicationId, freezeDigest: freeze.freezeDigest, units: plan.units, datasetAvailability: summary.datasetAvailability }, null, 2));
      } else {
        console.log(formatDatasetRegistry(registry));
        console.log("");
        console.log(`Planned replication ${replicationId} — ${plan.units.length} unit(s):`);
        for (const unit of plan.units) console.log(`  ${unit.unitId}  ${unit.provider.padEnd(9)} ${unit.datasetId}`);
        console.log("");
        console.log(`Replication status: ${summary.datasetAvailability.status}`);
        console.log(`  ${summary.datasetAvailability.note}`);
        if (summary.datasetAvailability.status === "INSUFFICIENT_INDEPENDENT_REAL_DATASETS") {
          console.log("");
          console.log(formatCaptureGuidance(registry));
        }
      }
      return;
    }
    if (args.json === true) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(formatReplicationSummary(summary));
      if (summary.datasetAvailability.status === "INSUFFICIENT_INDEPENDENT_REAL_DATASETS") {
        console.log("");
        console.log(formatCaptureGuidance(registry));
      }
    }
    return;
  }

  // ---- Run ---------------------------------------------------------------
  const canonicality = canonicalityVerdict({
    frozen: existingFreeze ?? freeze,
    commit: readGitCommit(),
    dirty: readWorkingTreeDirty(),
    devOverride: args.dev === true,
  });
  if (!canonicality.clean && args.dev !== true) {
    console.error(`[replicate:research] NON-CANONICAL RUN REFUSED: ${canonicality.reasons.join("; ")}`);
    console.error("[replicate:research] pass --dev to run anyway; the resulting evidence is permanently labelled NON_CANONICAL.");
    process.exitCode = 1;
    return;
  }

  const existingManifest = await loadRunManifest(runDir);
  if (existingManifest?.replicationId === replicationId) {
    const allTerminal = plan.units.every((unit) =>
      (existingManifest.units ?? []).some((row) => row.unitId === unit.unitId && ["COMPLETED", "FAILED", "SKIPPED", "INVALID_DATASET", "CONTAMINATED"].includes(row.status)),
    );
    if (allTerminal && args.rerun !== true) {
      console.log(`[replicate:research] existing identical run detected: ${replicationId} — resuming (nothing to do). Use --rerun to re-execute completed units.`);
    }
  }

  const regimes = {};
  if (process.env.EVOLVE_REPLICATION_REGIMES === "1") {
    for (const dataset of selection.datasets) {
      try {
        regimes[dataset.datasetId] = await computeDatasetRegimes(dataset.dir, config);
      } catch (error) {
        regimes[dataset.datasetId] = { datasetId: dataset.datasetId, composition: null, unavailable: String(error?.message ?? error) };
      }
    }
  }

  const frozenCohortDirs = Object.fromEntries(Object.keys(cohorts).map((key) => [key, cohortDirFor(baseDir, key)]));
  const result = await runReplication({
    runDir,
    freeze,
    replicationId,
    units: plan.units,
    frozenCohortDirs,
    rerun: args.rerun === true,
    canonicality,
    onProgress: (message) => console.log(message),
  });

  if (Object.keys(regimes).length > 0) {
    await writeRunManifest(runDir, { ...result.manifest, regimes });
    result.manifest.regimes = regimes;
  }

  const summary = aggregateReplication({
    replicationId,
    freezeDigest: freeze.freezeDigest,
    units: result.manifest.units,
    registry,
    datasetRegimes: regimes,
    providers: ["mock", "deepseek"],
  });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(runDir, RUN_SUMMARY_FILE), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  // A tiny projection of the same numbers, so the dashboard never has to load
  // the full summary artifact.
  await writeFile(
    path.join(runDir, RUN_STATUS_FILE),
    `${JSON.stringify(buildStatusArtifact(summary, { manifest: result.manifest }), null, 2)}\n`,
    "utf8",
  );

  if (args.json === true) {
    console.log(JSON.stringify({ manifest: result.manifest, summary }, null, 2));
  } else {
    console.log("");
    console.log(formatReplicationSummary(summary));
    console.log("");
    console.log(`Run manifest: ${path.join(runDir, "manifest.json")}`);
    console.log(`Summary:      ${path.join(runDir, RUN_SUMMARY_FILE)}`);
  }
}

main().catch((error) => {
  console.error(`[replicate:research] failed: ${error?.message ?? error}`);
  process.exitCode = 1;
});
