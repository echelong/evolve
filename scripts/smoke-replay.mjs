#!/usr/bin/env node
/**
 * Historical replay smoke test.
 *
 * Fully offline. Builds a small deterministic synthetic fixture, replays it
 * through the evolutionary paper engine, then runs a one-window walk-forward
 * experiment (train → validate → test) and checks the observable invariants:
 *
 *   - the fixture is recorded and classified, never presented as real history
 *   - replay consumes every snapshot and stays inside the dataset timeline
 *   - the run is reproducible for a fixed seed
 *   - frozen stages do not mutate genomes
 *   - the experiment writes reports and leaks no credentials
 *
 * Run with: npm run smoke:replay
 */

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runExperiment } from "./engine/experiment.mjs";
import { digestOf } from "./lib/hash.mjs";
import { serializeForPublic } from "./lib/sanitize.mjs";
import { runReplay } from "./engine/replay-runner.mjs";
import { makeFixture } from "./make-fixture.mjs";
import { createMarketConfig } from "./market/config.mjs";

const MINUTE = 60_000;
const SECRET = "sk-live-SMOKE-SECRET-should-never-appear";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function makeConfig(overrides = {}) {
  return createMarketConfig(
    {
      EVOLVE_MARKET_MODE: "replay",
      JUPITER_API_KEY: SECRET,
      EVOLVE_POPULATION: "14",
      EVOLVE_GENERATION_TICKS: "10",
      EVOLVE_WF_TRAIN_MINUTES: "2",
      EVOLVE_WF_VALIDATE_MINUTES: "1",
      EVOLVE_WF_TEST_MINUTES: "1",
      EVOLVE_WF_STEP_MINUTES: "2",
      EVOLVE_MIN_TRADES: "1",
      EVOLVE_MIN_DISTINCT_MINTS: "1",
      EVOLVE_MIN_OBSERVATIONS: "10",
      EVOLVE_MIN_EXPOSURE_TICKS: "0",
      ...overrides,
    },
    { loadEnv: false },
  );
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), "evolve-smoke-replay-"));
  const started = Date.now();

  try {
    console.log("[EVOLVE] HISTORICAL REPLAY • PAPER MONEY — offline smoke test");

    // --- 1. Record a deterministic fixture -------------------------------
    const fixtureDir = path.join(root, "session-smoke");
    const manifest = await makeFixture({
      dir: fixtureDir,
      snapshots: 120,
      intervalMs: 5000,
      seed: "smoke",
      tokenCount: 12,
      config: createMarketConfig(
        { EVOLVE_MARKET_MODE: "synthetic", EVOLVE_SYNTHETIC_UNIVERSE: "12", EVOLVE_SYNTHETIC_RETRY_MS: "1000" },
        { loadEnv: false },
      ),
    });

    assert(manifest.status === "complete", "the fixture manifest must finalize");
    assert(manifest.dataClass === "synthetic-only", "the fixture must be classified synthetic-only");
    assert(manifest.fingerprint?.combined, "the fixture must carry a fingerprint");
    console.log(
      `[EVOLVE] fixture: ${manifest.snapshotCount} snapshots · ${manifest.uniqueMintCount} mints · ${manifest.dataClass} · ${(manifest.durationMs / MINUTE).toFixed(2)} min`,
    );

    // --- 2. Replay it twice and compare ----------------------------------
    const stateDir = path.join(root, "state");
    const config = makeConfig();
    const first = await runReplay({ config, datasetDir: fixtureDir, dir: stateDir, speed: "max", persistEvery: 999 });
    const second = await runReplay({ config, datasetDir: fixtureDir, dir: stateDir, speed: "max", persistEvery: 999 });

    assert(first.ticks === manifest.snapshotCount, `replay must consume every snapshot (${first.ticks})`);
    assert(first.state.research.mode === "replay", "the state must describe a historical replay");
    assert(
      first.state.research.banner === "HISTORICAL REPLAY • PAPER MONEY",
      "the replay banner must be explicit",
    );
    assert(first.state.research.dataset.dataClass === "synthetic-only", "the dataset class must be visible");
    assert(first.state.research.replay.finished === true, "a finished replay must say so");
    assert(first.state.paperOnly === true, "state must declare paper-only");
    assert(
      digestOf(first.state.stats) === digestOf(second.state.stats),
      "the same seed must reproduce identical paper statistics",
    );
    assert(
      digestOf(first.state.recentTrades) === digestOf(second.state.recentTrades),
      "the same seed must reproduce identical paper fills",
    );
    assert(first.state.stats.trades >= 0, "trade accounting must be countable");
    assert(
      first.state.research.dataset.fingerprint === manifest.fingerprint.combined,
      "the replay must record the dataset fingerprint",
    );
    assert(first.state.research.evolutionFrozen === false, "a default replay trains");
    console.log(
      `[EVOLVE] replay: ${first.ticks} snapshots · gen ${first.state.generation} · paper equity $${first.state.paper.totalEquity} · net $${first.state.paper.netPnl} · trades ${first.state.stats.trades}`,
    );

    const rawState = await readFile(path.join(stateDir, "replay-state.json"), "utf8");
    assert(!rawState.includes(SECRET), "replay state must never contain the API key");
    assert(
      JSON.parse(serializeForPublic(first.state)).mode === "PAPER",
      "state must serialize cleanly for the dashboard",
    );

    // --- 3. One-window walk-forward experiment ---------------------------
    const experiment = await runExperiment({
      datasetDir: fixtureDir,
      config: makeConfig({ EVOLVE_EVAL_SEEDS: "5,6" }),
      seeds: [5, 6],
      maxWindows: 1,
      write: true,
      saveChampions: true,
      experimentsDir: path.join(root, "experiments"),
      championsDir: path.join(root, "champions"),
      onProgress: ({ message }) => {
        if (typeof message === "string" && message.trim() !== "") console.log(`[EVOLVE] ${message}`);
      },
    });

    const windowResult = experiment.windows[0];
    assert(windowResult, "the experiment must produce a window result");
    assert(windowResult.trainRuns.length === 2, "both seeds must train");
    assert(windowResult.trainRuns[0].freezeAudit.frozen === false, "training must not be frozen");
    if (windowResult.freezeAudit.validate) {
      assert(windowResult.freezeAudit.validate.immutable === true, "validation must not mutate genomes");
    }
    if (windowResult.freezeAudit.test) {
      assert(windowResult.freezeAudit.test.immutable === true, "the test stage must not mutate genomes");
    }
    assert(experiment.manifest.paperOnly === true, "experiment manifests must be paper-only");
    assert(
      experiment.manifest.dataset.fingerprint === manifest.fingerprint.combined,
      "the experiment must record the dataset fingerprint",
    );
    assert(experiment.summary.outOfSample !== null, "out-of-sample aggregates must exist");
    console.log(
      `[EVOLVE] experiment ${experiment.experimentId}: champions ${experiment.summary.champions} · ` +
        `validation median ${experiment.summary.outOfSample.validationMedianNetReturn} · ` +
        `test median ${experiment.summary.outOfSample.testMedianNetReturn} · ` +
        `insufficient-sample ${experiment.summary.resultCounts.insufficientSample}`,
    );
    console.log(
      `[EVOLVE] baselines: ${experiment.summary.baselines.rows
        .map((row) => `${row.id}=${row.netReturn}`)
        .join(" · ")}`,
    );

    const files = await readdir(experiment.reportDir);
    for (const name of ["manifest.json", "summary.json", "windows.json", "champions.json"]) {
      assert(files.includes(name), `the report must include ${name}`);
    }

    const reportText = await readFile(path.join(experiment.reportDir, "manifest.json"), "utf8");
    assert(!reportText.includes(SECRET), "reports must never contain the API key");

    console.log(`[EVOLVE] report -> ${experiment.reportDir}`);
    console.log(`[EVOLVE] smoke replay passed in ${Date.now() - started}ms — paper-only, no network used`);
    console.log(
      "[EVOLVE] Historical backtests and paper results do NOT guarantee future profitability.",
    );
  } finally {
    if (process.env.EVOLVE_KEEP_FIXTURES === "1") {
      console.log(`[EVOLVE] fixtures kept at ${root}`);
    } else {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error("replay smoke test failed:", error?.stack ?? error);
  process.exitCode = 1;
});
