#!/usr/bin/env node
/**
 * Phase 5C — multi-dataset replication CLI (PAPER ONLY).
 *
 *   npm run replicate:research -- --write-freeze
 *   npm run replicate:research -- --verify-freeze
 *   npm run replicate:research -- --cohorts
 *   npm run replicate:research -- --plan
 *   npm run replicate:research -- --summary
 *   npm run replicate:research -- --freeze phase5c --datasets auto
 *   npm run replicate:research -- --datasets session-A,session-B
 *
 * DISPATCH
 * --------
 * Exactly ONE command mode runs per invocation, resolved by `resolveAction`
 * (`./replication/mode.mjs`) and dispatched through a single exclusive
 * `switch`:
 *
 *   --write-freeze   write/update the freeze artifact, print its digest/path,
 *                    and STOP. No cohort work, no dataset discovery, no plan,
 *                    no Arena subprocess, no replication unit.
 *   --verify-freeze  verify the stored freeze against the live code (read-only).
 *   --cohorts        inspect the frozen research cohorts (read-only once frozen).
 *   --plan           discover/select datasets and print the deterministic plan.
 *   --summary        print the summary of existing artifacts (read-only).
 *   (no action flag) NORMAL RUN — the ONLY mode that may execute replication
 *                    units, and it requires an already-written freeze.
 *
 * Two or more action flags together are a hard error, not a silent pick.
 * `--rerun` / `--dev` only apply to the normal run.
 *
 * For each eligible REAL dataset the normal run executes the SAME strict
 * species-matched A/B experiment twice: once with the frozen MOCK research
 * cohort, once with the frozen DEEPSEEK research cohort, each against its own
 * freshly generated deterministic conventional control.
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
  FROZEN_COHORT_KEYS,
  MIN_CLEAN_TO_RUN,
  REPLICATION_DIR,
  RUN_STATUS_FILE,
  RUN_SUMMARY_FILE,
} from "./replication/constants.mjs";
import {
  buildFreezeConfig,
  canonicalityVerdict,
  freezePath,
  readFreeze,
  readGitCommit,
  readWorkingTreeDirty,
  verifyFreeze,
  writeFreeze,
} from "./replication/freeze.mjs";
import { cohortDirFor, freezeCohorts, inspectCohort, readFrozenCohort } from "./replication/cohorts.mjs";
import {
  buildReplicationRegistry,
  collectArenaDatasetUsage,
  computeDatasetRegimes,
  discoverDatasetRecords,
} from "./replication/datasets.mjs";
import { evaluationKey, replicationIdFor } from "./replication/identity.mjs";
import { ACTION, resolveAction } from "./replication/mode.mjs";
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
    "Actions — mutually exclusive, exactly one per invocation:",
    "  npm run replicate:research -- --write-freeze     write/update the freeze artifact, print its digest, and STOP",
    "  npm run replicate:research -- --verify-freeze    verify the stored freeze against the live code (read-only)",
    "  npm run replicate:research -- --cohorts          inspect the frozen research cohorts",
    "  npm run replicate:research -- --plan             discover datasets, print the deterministic plan (no execution)",
    "  npm run replicate:research -- --summary          print the summary of existing artifacts (read-only)",
    "",
    "Normal replication run — the ONLY mode that executes replication units:",
    "  npm run replicate:research -- --freeze phase5c --datasets auto",
    "",
    "Options:",
    `  --freeze <name>       freeze version label (default ${DEFAULT_FREEZE_VERSION})`,
    "  --datasets <auto|ids> comma-separated dataset ids, or `auto` for every eligible dataset (run mode)",
    "  --providers <list>    providers to run (default mock,deepseek)",
    "  --out <dir>           replication root (default .evolve/replication)",
    "  --rerun               normal run only: explicitly re-execute units that already COMPLETED (labelled)",
    "  --dev                 normal run only: allow a run whose commit/tree does not match the freeze; evidence is labelled NON_CANONICAL",
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

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function providersFromArgs(args) {
  return String(args.providers ?? "mock,deepseek")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/* ============================================================================
 * Shared loaders
 * ==========================================================================*/

/**
 * Load the STORED freeze artifact. Read-only: no mode except `--write-freeze`
 * ever writes one, so a normal run can never self-certify against a freeze it
 * just created.
 */
async function requireFreeze({ baseDir, freezeVersion, action }) {
  const freeze = await readFreeze({ root: baseDir });
  if (!freeze) {
    fail(
      `no freeze artifact at ${freezePath(baseDir)} — run \`npm run replicate:research -- --write-freeze\` first ` +
        `(--${action} never writes one)`,
    );
    return null;
  }
  if (freeze.freezeVersion !== freezeVersion) {
    console.warn(
      `[replicate:research] WARNING: stored freeze is '${freeze.freezeVersion}' but '${freezeVersion}' was requested — using the stored artifact.`,
    );
  }
  return freeze;
}

/** Freeze (idempotently) or load the frozen research cohorts. */
async function loadCohorts({ baseDir, freezeDigest }) {
  return freezeCohorts({ baseDir, freezeDigest, keys: [...FROZEN_COHORT_KEYS] });
}

/** READ-ONLY cohort load: never creates and never refreshes a cohort artifact. */
async function readCohorts(baseDir) {
  const manifests = {};
  for (const key of FROZEN_COHORT_KEYS) manifests[key] = await readFrozenCohort(baseDir, key);
  return manifests;
}

function cohortDigestsOf(cohorts) {
  return Object.fromEntries(
    Object.entries(cohorts).map(([key, manifest]) => [key, manifest?.cohortDigest ?? null]),
  );
}

/**
 * Resolve the identity inputs needed by `--cohorts`, `--plan`, `--summary` and
 * the normal run: the stored freeze, the frozen cohorts, and the deterministic
 * replication id. Never discovers datasets and never builds a plan.
 */
async function resolveContext({ baseDir, freezeVersion, providers, action, ensureCohorts = true }) {
  const freeze = await requireFreeze({ baseDir, freezeVersion, action });
  if (!freeze) return null;

  const cohorts = ensureCohorts
    ? await loadCohorts({ baseDir, freezeDigest: freeze.freezeDigest })
    : await readCohorts(baseDir);

  if (!ensureCohorts) {
    const missing = FROZEN_COHORT_KEYS.filter((key) => !cohorts[key]);
    if (missing.length > 0) {
      fail(
        `no frozen cohort manifest for ${missing.join(", ")} under ${path.join(baseDir, "cohorts")} — ` +
          `--${action} only reads existing artifacts; run \`--cohorts\` first.`,
      );
      return null;
    }
  }

  const cohortDigests = cohortDigestsOf(cohorts);
  const replicationId = replicationIdFor({
    freezeDigest: freeze.freezeDigest,
    cohortDigests,
    providers,
    evaluation: evaluationKey(freeze),
  });
  return { freeze, cohorts, cohortDigests, replicationId, frozen: { ...freeze, replicationId, cohortDigests } };
}

/** Dataset registry discovery. Only `--plan`, `--summary` and the run use it. */
async function buildRegistryFor({ baseDir, cohorts }) {
  const config = createMarketConfig(
    { ...process.env, EVOLVE_MARKET_MODE: process.env.EVOLVE_MARKET_MODE ?? "synthetic" },
    { loadEnv: true },
  );
  const historyRoot = config.historyRoot ?? path.join(".evolve", "history");
  const arenasDir = process.env.EVOLVE_ARENAS_DIR ?? path.join(".evolve", "arenas");
  const [records, arenaUsage] = await Promise.all([
    discoverDatasetRecords(historyRoot),
    collectArenaDatasetUsage(arenasDir),
  ]);
  const registry = buildReplicationRegistry({ records, cohorts, arenaUsage });
  registry.baseDir = baseDir;
  registry.freezeDigest = null;
  registry.historyRoot = historyRoot;
  return { registry, config, historyRoot, arenasDir };
}

/** Explicit `--datasets <ids>` selection or `auto` over the eligible sample. */
function selectDatasets(registry, args) {
  const requestedIds = args.datasets === undefined ? "auto" : String(args.datasets);
  const explicit = requestedIds.trim().toLowerCase() === "auto"
    ? null
    : requestedIds.split(",").map((value) => value.trim()).filter(Boolean);
  const selection = explicit
    ? {
        mode: "explicit",
        datasetIds: explicit.filter((id) => registry.roles[id] === "REPLICATION"),
        datasets: registry.records.filter(
          (record) => explicit.includes(record.datasetId) && registry.roles[record.datasetId] === "REPLICATION",
        ),
        unknown: explicit.filter((id) => !registry.records.some((record) => record.datasetId === id)),
        ineligible: explicit
          .filter((id) => registry.records.some((record) => record.datasetId === id) && registry.roles[id] !== "REPLICATION")
          .map((id) => ({ datasetId: id, role: registry.roles[id], reasons: registry.eligibility[id]?.reasons ?? [] })),
      }
    : { mode: "auto", datasetIds: [...registry.selectedIds], datasets: [...registry.selected], unknown: [], ineligible: [] };

  if (selection.unknown.length > 0) fail(`unknown dataset id(s): ${selection.unknown.join(", ")}`);
  return selection;
}

/** Aggregate the EXISTING run artifacts for a replication id. Read-only. */
async function summarizeExisting({ baseDir, context, registry, providers }) {
  const runDir = path.join(baseDir, context.replicationId);
  const existingManifest = await loadRunManifest(runDir);
  const summary = aggregateReplication({
    replicationId: context.replicationId,
    freezeDigest: context.freeze.freezeDigest,
    units: existingManifest?.units ?? [],
    registry,
    datasetRegimes: existingManifest?.regimes ?? {},
    providers: providers.length >= 2 ? ["mock", "deepseek"] : providers,
  });
  return { runDir, existingManifest, summary };
}

/* ============================================================================
 * Actions
 * ==========================================================================*/

/**
 * `--write-freeze`: build/update the freeze artifact, print it, and STOP.
 *
 * It deliberately does NOT: freeze cohorts, discover datasets, build a plan,
 * spawn an Arena subprocess, or execute a single replication unit.
 */
async function writeFreezeOnly({ args, baseDir, freezeVersion }) {
  const target = freezePath(baseDir);
  const previous = await readFreeze({ root: baseDir });
  const freeze = await writeFreeze(
    buildFreezeConfig({
      freezeVersion,
      commit: readGitCommit(),
      dirty: readWorkingTreeDirty(),
    }),
    { root: baseDir },
  );

  if (args.json === true) {
    printJson({
      action: ACTION.WRITE_FREEZE,
      path: target,
      freezeVersion: freeze.freezeVersion,
      freezeDigest: freeze.freezeDigest,
      previousFreezeDigest: previous?.freezeDigest ?? null,
      digestChanged: Boolean(previous) && previous.freezeDigest !== freeze.freezeDigest,
      commit: freeze.commit,
      dirtyWorkingTree: freeze.dirtyWorkingTree,
      unitsExecuted: 0,
    });
  } else {
    console.log(`[replicate:research] freeze artifact: ${target}`);
    console.log(`[replicate:research] freeze digest:   ${freeze.freezeDigest}`);
    if (previous && previous.freezeDigest !== freeze.freezeDigest) {
      console.log(
        `[replicate:research] note: the stored freeze digest changed (${previous.freezeDigest} -> ${freeze.freezeDigest})`,
      );
    }
    console.log(
      "[replicate:research] freeze written — stopping. No cohorts were frozen, no datasets were discovered, " +
        "no plan was built, and no replication unit was executed.",
    );
  }
  // `--write-freeze` is an ACTION, not a modifier. This is the end of the command.
  return;
}

/** `--verify-freeze`: verify only. Read-only, zero replication execution. */
async function verifyFreezeOnly({ args, baseDir, freezeVersion }) {
  const freeze = await requireFreeze({ baseDir, freezeVersion, action: ACTION.VERIFY_FREEZE });
  if (!freeze) return;
  const verify = verifyFreeze(freeze);
  if (args.json === true) {
    printJson({ ...verify, action: ACTION.VERIFY_FREEZE, unitsExecuted: 0 });
  } else {
    console.log(formatFreezeVerification(verify, { frozenDigest: freeze?.freezeDigest ?? null }));
  }
  if (!verify.ok) process.exitCode = 1;
  return;
}

/** `--cohorts`: inspect the frozen cohorts. Never plans or executes a unit. */
async function cohortsOnly({ args, baseDir, freezeVersion, providers }) {
  const context = await resolveContext({ baseDir, freezeVersion, providers, action: ACTION.COHORTS });
  if (!context) return;
  if (args.json === true) {
    printJson({
      action: ACTION.COHORTS,
      replicationId: context.replicationId,
      cohorts: Object.fromEntries(
        Object.entries(context.cohorts).map(([key, manifest]) => [key, inspectCohort(manifest)]),
      ),
      unitsExecuted: 0,
    });
  } else {
    console.log(formatCohortInspection(context.cohorts));
  }
  return;
}

/** `--plan`: discover/select datasets and print the deterministic plan. */
async function planOnly({ args, baseDir, freezeVersion, providers }) {
  const context = await resolveContext({ baseDir, freezeVersion, providers, action: ACTION.PLAN });
  if (!context) return;

  const { registry } = await buildRegistryFor({ baseDir, cohorts: context.cohorts });
  registry.freezeDigest = context.freeze.freezeDigest;
  const selection = selectDatasets(registry, args);
  const plan = planReplication({
    freeze: context.frozen,
    cohorts: context.cohorts,
    datasets: selection.datasets,
    providers,
  });
  const { summary } = await summarizeExisting({ baseDir, context, registry, providers });

  if (args.json === true) {
    printJson({
      action: ACTION.PLAN,
      replicationId: context.replicationId,
      freezeDigest: context.freeze.freezeDigest,
      datasetIds: selection.datasetIds,
      units: plan.units,
      datasetAvailability: summary.datasetAvailability,
      unitsExecuted: 0,
    });
  } else {
    console.log(formatDatasetRegistry(registry));
    console.log("");
    console.log(`Planned replication ${context.replicationId} — ${plan.units.length} unit(s):`);
    for (const unit of plan.units) console.log(`  ${unit.unitId}  ${unit.provider.padEnd(9)} ${unit.datasetId}`);
    console.log("");
    console.log(`Replication status: ${summary.datasetAvailability.status}`);
    console.log(`  ${summary.datasetAvailability.note}`);
    console.log("");
    console.log("[replicate:research] plan only — no Arena subprocess was started and no unit was executed.");
    if (summary.datasetAvailability.status === "INSUFFICIENT_INDEPENDENT_REAL_DATASETS") {
      console.log("");
      console.log(formatCaptureGuidance(registry));
    }
  }
  return;
}

/** `--summary`: read existing artifacts only. Zero Arena execution. */
async function summaryOnly({ args, baseDir, freezeVersion, providers }) {
  const context = await resolveContext({
    baseDir,
    freezeVersion,
    providers,
    action: ACTION.SUMMARY,
    ensureCohorts: false,
  });
  if (!context) return;

  const { registry } = await buildRegistryFor({ baseDir, cohorts: context.cohorts });
  registry.freezeDigest = context.freeze.freezeDigest;
  const { summary } = await summarizeExisting({ baseDir, context, registry, providers });

  if (args.json === true) {
    printJson({ ...summary, action: ACTION.SUMMARY, unitsExecuted: 0 });
  } else {
    console.log(formatReplicationSummary(summary));
    if (summary.datasetAvailability.status === "INSUFFICIENT_INDEPENDENT_REAL_DATASETS") {
      console.log("");
      console.log(formatCaptureGuidance(registry));
    }
    console.log("");
    console.log("[replicate:research] summary only — no Arena subprocess was started and no unit was executed.");
  }
  return;
}

/**
 * NORMAL RUN — the only mode that may execute replication units. Requires the
 * freeze artifact to already exist (written by `--write-freeze`), so a run can
 * never certify itself against a freeze it just created.
 */
async function runReplicationCommand({ args, baseDir, freezeVersion, providers }) {
  const context = await resolveContext({ baseDir, freezeVersion, providers, action: ACTION.RUN });
  if (!context) return;
  const { freeze, cohorts, replicationId } = context;

  const { registry, config } = await buildRegistryFor({ baseDir, cohorts });
  registry.freezeDigest = freeze.freezeDigest;
  const selection = selectDatasets(registry, args);

  const noEligible = selection.datasets.length === 0;
  if (!noEligible && selection.datasets.length < MIN_CLEAN_TO_RUN) {
    console.warn(
      `[replicate:research] only ${selection.datasets.length} eligible CLEAN dataset(s): primary multi-dataset replication requires ${MIN_CLEAN_TO_RUN}.`,
    );
  }

  const plan = planReplication({ freeze, cohorts, datasets: selection.datasets, providers });

  // Not enough independent evidence: report instead of executing anything.
  if (noEligible || selection.datasets.length < MIN_CLEAN_TO_RUN) {
    const { summary } = await summarizeExisting({ baseDir, context, registry, providers });
    if (args.json === true) {
      printJson({ ...summary, action: ACTION.RUN, ran: false, unitsExecuted: 0 });
    } else {
      console.log(formatReplicationSummary(summary));
      if (summary.datasetAvailability.status === "INSUFFICIENT_INDEPENDENT_REAL_DATASETS") {
        console.log("");
        console.log(formatCaptureGuidance(registry));
      }
    }
    console.log("");
    console.log(
      `[replicate:research] not running: ${selection.datasets.length} eligible CLEAN dataset(s) is below the required ${MIN_CLEAN_TO_RUN}. No unit was executed.`,
    );
    return;
  }

  const runDir = path.join(baseDir, replicationId);

  const canonicality = canonicalityVerdict({
    frozen: freeze,
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
      (existingManifest.units ?? []).some(
        (row) =>
          row.unitId === unit.unitId &&
          ["COMPLETED", "FAILED", "SKIPPED", "INVALID_DATASET", "CONTAMINATED"].includes(row.status),
      ),
    );
    if (allTerminal && args.rerun !== true) {
      console.log(
        `[replicate:research] existing identical run detected: ${replicationId} — resuming (nothing to do). Use --rerun to re-execute completed units.`,
      );
    }
  }

  const regimes = {};
  if (process.env.EVOLVE_REPLICATION_REGIMES === "1") {
    for (const dataset of selection.datasets) {
      try {
        regimes[dataset.datasetId] = await computeDatasetRegimes(dataset.dir, config);
      } catch (error) {
        regimes[dataset.datasetId] = {
          datasetId: dataset.datasetId,
          composition: null,
          unavailable: String(error?.message ?? error),
        };
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

/* ============================================================================
 * Dispatch
 * ==========================================================================*/

async function main() {
  const args = parseArgs(process.argv.slice(2), { booleanFlags: BOOLEAN_FLAGS, valueFlags: VALUE_FLAGS });
  if (args.help === true) {
    console.log(usage());
    return;
  }

  // One action per invocation. Ambiguous or impossible combinations fail here,
  // before anything is written or executed.
  const resolved = resolveAction(args);
  if (!resolved.ok) {
    fail(resolved.error);
    console.error("");
    console.error(usage());
    return;
  }

  const context = {
    args,
    baseDir: path.resolve(String(args.out ?? process.env.EVOLVE_REPLICATION_DIR ?? REPLICATION_DIR)),
    freezeVersion: String(args.freeze ?? DEFAULT_FREEZE_VERSION),
    providers: providersFromArgs(args),
  };

  switch (resolved.action) {
    case ACTION.WRITE_FREEZE:
      return writeFreezeOnly(context);
    case ACTION.VERIFY_FREEZE:
      return verifyFreezeOnly(context);
    case ACTION.COHORTS:
      return cohortsOnly(context);
    case ACTION.PLAN:
      return planOnly(context);
    case ACTION.SUMMARY:
      return summaryOnly(context);
    case ACTION.RUN:
      return runReplicationCommand(context);
    default:
      fail(`unknown command mode '${resolved.action}'`);
      return;
  }
}

main().catch((error) => {
  console.error(`[replicate:research] failed: ${error?.message ?? error}`);
  process.exitCode = 1;
});
