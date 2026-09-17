#!/usr/bin/env node
/**
 * Historical replay CLI.
 *
 *   npm run replay -- <dataset-dir>
 *   EVOLVE_REPLAY_DATASET=.evolve/history/2026-09-17/session-x npm run replay
 *   EVOLVE_REPLAY_SPEED=100 npm run replay -- .evolve/history/.../session-x
 *   EVOLVE_REPLAY_SPEED=max EVOLVE_SEED=12345 npm run replay -- <dataset>
 *
 * Replays a recorded dataset through the evolutionary paper simulation using the
 * dataset's own timestamps as the simulation clock. Speed only changes wall-clock
 * pacing; it never changes a decision, a fill, or a generation.
 *
 * Ctrl+C stops the replay, finalizes `.evolve/replay-state.json`, prints the
 * summary, and leaves the terminal free. Nothing here trades, signs, or submits.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs } from "./make-fixture.mjs";
import { publicConfig, createMarketConfig } from "./market/config.mjs";
import { REPLAY_BANNER } from "./market/replay.mjs";
import { DEFAULT_REPLAY_STATE_FILE, runReplay } from "./engine/replay-runner.mjs";

const PAPER_NOTICE =
  "PAPER ONLY. Simulated fills from observed/recorded prices. Historical backtests and paper results do NOT guarantee future profitability.";

/** Config with replay forced on, so `npm run replay` never needs the mode env. */
export function replayConfig(env = process.env, overrides = {}) {
  return createMarketConfig({ ...env, ...overrides, EVOLVE_MARKET_MODE: "replay" }, { loadEnv: true });
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

  const config = replayConfig(process.env, datasetArg ? { EVOLVE_REPLAY_DATASET: datasetArg } : {});
  const datasetDir = config.replay.dataset;

  if (!datasetDir) {
    console.error("[EVOLVE] replay needs a dataset directory.");
    console.error("[EVOLVE]   npm run replay -- .evolve/history/2026-09-17/session-…");
    console.error("[EVOLVE]   npm run record:market     (to create one)");
    process.exitCode = 1;
    return;
  }

  const speed = typeof args.speed === "string" ? args.speed : config.replay.speed;
  const limit = args.limit === undefined ? 0 : Number(args.limit);
  const dir = typeof args.stateDir === "string" ? args.stateDir : ".evolve";

  let stopping = false;
  process.once("SIGINT", () => {
    stopping = true;
    console.log("\n[EVOLVE] Ctrl+C — stopping replay and finalizing state.");
  });
  process.once("SIGTERM", () => {
    stopping = true;
  });

  const publicSettings = publicConfig(config);

  console.log(`[EVOLVE] ${REPLAY_BANNER}`);
  console.log(`[EVOLVE] dataset   ${datasetDir}`);
  console.log(`[EVOLVE] speed     ${speed}`);
  console.log(`[EVOLVE] seed      ${config.seed}${config.evalSeeds.length > 0 ? ` · eval seeds ${config.evalSeeds.join(", ")}` : ""}`);
  console.log(
    `[EVOLVE] population ${publicSettings.engine.population} · generation every ${publicSettings.engine.generationTicks} ticks`,
  );
  console.log(`[EVOLVE] paper cash $${publicSettings.paper.startingCash} · fee ${publicSettings.paper.baseFeeBps}bps · min slippage ${publicSettings.paper.minSlippageBps}bps`);
  console.log(`[EVOLVE] ${PAPER_NOTICE}`);

  let lastLine = "";
  const result = await runReplay({
    config,
    datasetDir,
    dir,
    speed,
    limit,
    shouldStop: () => stopping,
    onProgress: (info) => {
      if (info.type === "start") {
        console.log(
          `[EVOLVE] dataset class ${info.dataClass ?? "unknown"} · ${info.windows} walk-forward window(s) planned`,
        );
        return;
      }
      if (info.type === "tick") {
        const pct = info.progress === null || info.progress === undefined ? "?" : `${info.progress.toFixed(1)}%`;
        const stamp = Number.isFinite(info.timestamp) ? new Date(info.timestamp).toISOString() : "n/a";
        lastLine = `\r[EVOLVE] ${stamp} · ${info.stage} · ${pct} · ticks ${info.ticks}   `;
        process.stdout.write(lastLine);
      }
    },
  });

  if (lastLine) process.stdout.write("\n");

  const research = result.state.research;
  const stats = result.state.stats;
  const paper = result.state.paper;

  console.log("");
  console.log(`[EVOLVE] ${REPLAY_BANNER}`);
  console.log(`[EVOLVE] dataset class   ${result.classification ?? "unknown"}`);
  console.log(
    `[EVOLVE] ticks ${result.ticks} · snapshots ${research.replay.snapshotsRead}/${research.replay.totalSnapshots ?? "?"} · generations ${result.state.generation}`,
  );
  console.log(
    `[EVOLVE] paper equity $${paper.totalEquity} · net $${paper.netPnl} · costs $${paper.costs} · trades ${stats.trades}`,
  );
  console.log(
    `[EVOLVE] best agent return ${(stats.bestReturn * 100).toFixed(2)}% · population return ${(stats.avgReturn * 100).toFixed(2)}% (PAPER)`,
  );
  if (result.state.research.evolutionFrozen) {
    console.log("[EVOLVE] evolution FROZEN for this run (no breeding, no selection pressure)");
  }
  console.log(`[EVOLVE] replay state -> ${result.statePath}`);
  console.log(
    `[EVOLVE] fingerprint ${research.dataset.fingerprint ?? "n/a"} · integrity ${research.dataset.integrityVerified ?? "not verified"}`,
  );
  console.log(`[EVOLVE] ${PAPER_NOTICE}`);
  if (result.interrupted) {
    console.log("[EVOLVE] replay stopped early by request; state written for the partial run.");
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error) => {
    console.error("[EVOLVE] replay failed:", error?.message ?? error);
    if (error?.suggestion) {
      console.error(
        `[EVOLVE] try: EVOLVE_WF_TRAIN_MINUTES=${error.suggestion.trainMinutes} EVOLVE_WF_VALIDATE_MINUTES=${error.suggestion.validateMinutes} EVOLVE_WF_TEST_MINUTES=${error.suggestion.testMinutes} EVOLVE_WF_STEP_MINUTES=${error.suggestion.stepMinutes}`,
      );
    }
    process.exitCode = 1;
  });
}

export { DEFAULT_REPLAY_STATE_FILE, PAPER_NOTICE };
