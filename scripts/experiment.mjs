#!/usr/bin/env node
/**
 * Walk-forward experiment CLI.
 *
 *   npm run experiment -- <dataset-dir>
 *   EVOLVE_REPLAY_DATASET=<dataset-dir> EVOLVE_EVAL_SEEDS=11,22,33,44,55 npm run experiment
 *   npm run experiment -- <dataset-dir> --max-windows 2 --seeds 1,2
 *
 * Runs the full TRAIN → VALIDATE → TEST protocol over a recorded dataset, scores
 * every candidate with the robustness formula, compares against the trivial
 * baselines, writes machine-readable reports to `.evolve/experiments/<id>/`, and
 * archives any genome that cleared the evidence gates to `.evolve/champions/`.
 *
 * Everything is PAPER. Nothing is executed, signed, or submitted anywhere.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs } from "./make-fixture.mjs";
import { runExperiment } from "./engine/experiment.mjs";
import { createMarketConfig, publicConfig } from "./market/config.mjs";
import { planWindows } from "./engine/walkforward.mjs";
import { openDataset } from "./history/dataset.mjs";
import { evaluateEvidence } from "./engine/metrics.mjs";

const PAPER_NOTICE =
  "PAPER ONLY. Every number below is simulated paper accounting. Historical backtests and paper results do NOT guarantee future profitability.";

function readGitCommit() {
  try {
    const head = readFileSync(path.join(".git", "HEAD"), "utf8").trim();
    if (head.startsWith("ref:")) {
      const ref = head.slice(4).trim();
      return readFileSync(path.join(".git", ref), "utf8").trim().slice(0, 12);
    }
    return head.slice(0, 12);
  } catch {
    return null;
  }
}

function readEngineVersion() {
  try {
    return JSON.parse(readFileSync(path.join("package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

function parseSeeds(value) {
  if (value === undefined) return null;
  const text = Array.isArray(value) ? value.join(",") : String(value);
  const seeds = text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (/^-?\d+$/.test(part) ? Number(part) : part));
  return seeds.length > 0 ? seeds : null;
}

function pct(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : "n/a";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const positional = Array.isArray(args._) && args._.length > 0 ? args._[0] : null;
  const datasetArg =
    typeof args.dataset === "string"
      ? args.dataset
      : typeof args.src === "string"
        ? args.src
        : positional;

  const config = createMarketConfig(
    { ...process.env, EVOLVE_MARKET_MODE: "replay", ...(datasetArg ? { EVOLVE_REPLAY_DATASET: datasetArg } : {}) },
    { loadEnv: true },
  );

  const datasetDir = config.replay.dataset;
  if (!datasetDir) {
    console.error("[EVOLVE] experiment needs a dataset directory.");
    console.error("[EVOLVE]   npm run experiment -- .evolve/history/2026-09-17/session-…");
    process.exitCode = 1;
    return;
  }

  const seeds = parseSeeds(args.seeds) ?? (config.evalSeeds.length > 0 ? config.evalSeeds : null);
  const maxWindows = args["max-windows"] === undefined ? null : Number(args["max-windows"]);
  const allowShort = args["allow-short"] === true || config.walkForward.allowShortDataset;
  const write = args["no-write"] !== true;

  const dataset = await openDataset(datasetDir, { requireManifest: false });
  const integrity = await dataset.verifyFingerprint();
  const plan = planWindows({
    firstObservedAt: dataset.firstObservedAt,
    lastObservedAt: dataset.lastObservedAt,
    walkForward: config.walkForward,
    minWindows: config.walkForward.minWindows,
    allowShort,
  });

  console.log("[EVOLVE] HISTORICAL REPLAY • PAPER MONEY — walk-forward experiment");
  console.log(`[EVOLVE] dataset ${dataset.datasetId} (${dataset.classification ?? "unclassified"})`);
  console.log(
    `[EVOLVE] duration ${((dataset.durationMs ?? 0) / 60_000).toFixed(2)} min · ${dataset.snapshotCount ?? "?"} snapshots · ${dataset.manifest?.uniqueMintCount ?? "?"} mints`,
  );
  console.log(`[EVOLVE] fingerprint ${dataset.fingerprint?.combined ?? "n/a"} · integrity ${integrity.ok === null ? "unknown" : integrity.ok}`);
  console.log(
    `[EVOLVE] windows ${plan.windows.length} (train ${config.walkForward.trainMinutes}m / validate ${config.walkForward.validateMinutes}m / test ${config.walkForward.testMinutes}m · step ${config.walkForward.stepMinutes}m)`,
  );
  if (plan.scaled) console.log("[EVOLVE] window sizes scaled down to fit this dataset (development configuration)");
  console.log(`[EVOLVE] seeds ${(seeds ?? [config.seed]).join(", ")} · population ${config.engine.population}`);
  console.log("[EVOLVE] minimum evidence before champion status:");
  for (const check of evaluateEvidence({ trades: 0, distinctMints: 0, observations: 0, exposureTicks: 0 }, config.evidence).checks) {
    console.log(`[EVOLVE]   ${check.label}: >= ${check.required}`);
  }
  console.log(`[EVOLVE] ${PAPER_NOTICE}`);

  const result = await runExperiment({
    datasetDir,
    config,
    seeds,
    maxWindows,
    minWindows: config.walkForward.minWindows,
    write,
    saveChampions: write,
    experimentsDir: config.experimentsDir,
    championsDir: config.championsDir,
    engineVersion: `evolve@${readEngineVersion()}`,
    gitCommit: readGitCommit(),
    onProgress: ({ message }) => {
      if (typeof message === "string" && message.trim() !== "") console.log(message);
    },
  });

  const summary = result.summary;
  console.log("");
  console.log("[EVOLVE] HISTORICAL REPLAY • PAPER MONEY — experiment summary");
  console.log(`[EVOLVE] experiment   ${summary.experimentId}`);
  console.log(`[EVOLVE] windows run  ${summary.windows} (with candidates: ${summary.windowsWithCandidates})`);
  console.log(`[EVOLVE] champions    ${summary.champions}`);
  console.log(
    `[EVOLVE] classifications ${JSON.stringify(summary.resultCounts)}`,
  );
  console.log(
    `[EVOLVE] out-of-sample validation median ${pct(summary.outOfSample.validationMedianNetReturn)} (n=${summary.outOfSample.validationCount}) · ` +
      `test median ${pct(summary.outOfSample.testMedianNetReturn)} (n=${summary.outOfSample.testCount})`,
  );
  console.log(
    `[EVOLVE] test worst ${pct(summary.outOfSample.testWorstNetReturn)} · best ${pct(summary.outOfSample.testBestNetReturn)}`,
  );
  console.log(`[EVOLVE] baselines median ${pct(summary.baselines.medianNetReturn)} across ${summary.baselines.count} run(s)`);
  for (const row of summary.baselines.rows) {
    console.log(
      `[EVOLVE]   baseline ${row.id.padEnd(18)} ${String(row.window).padEnd(14)} net ${pct(row.netReturn)} · trades ${row.trades} · ${row.classification}`,
    );
  }
  console.log("[EVOLVE] species (out-of-sample view)");
  for (const entry of summary.species) {
    console.log(
      `[EVOLVE]   ${entry.name.padEnd(16)} births ${String(entry.births).padStart(4)} deaths ${String(entry.deaths).padStart(4)} ` +
        `val ${pct(entry.medianValidationReturn)} test ${pct(entry.medianTestReturn)} champions ${entry.championCount}`,
    );
  }
  if (result.reportDir) {
    console.log(`[EVOLVE] report -> ${result.reportDir}`);
  } else {
    console.log("[EVOLVE] report not written (--no-write)");
  }
  console.log(`[EVOLVE] ${PAPER_NOTICE}`);

  const publicSettings = publicConfig(config);
  console.log(`[EVOLVE] config seed ${publicSettings.seed} · replay ${JSON.stringify(publicSettings.replay)}`);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error) => {
    console.error("[EVOLVE] experiment failed:", error?.message ?? error);
    if (error?.suggestion) {
      console.error(
        `[EVOLVE] dataset too short — try: EVOLVE_WF_TRAIN_MINUTES=${error.suggestion.trainMinutes} EVOLVE_WF_VALIDATE_MINUTES=${error.suggestion.validateMinutes} EVOLVE_WF_TEST_MINUTES=${error.suggestion.testMinutes} EVOLVE_WF_STEP_MINUTES=${error.suggestion.stepMinutes} (or --allow-short)`,
      );
    }
    process.exitCode = 1;
  });
}
