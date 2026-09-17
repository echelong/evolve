#!/usr/bin/env node
/**
 * Deterministic fixture dataset generator.
 *
 * Tests and dry runs must not depend on the internet or on live Jupiter data, so
 * this script records a small synthetic dataset using the real recorder and the
 * real synthetic market provider — driven by a manual clock instead of the wall
 * clock, which makes the output byte-stable for a given seed.
 *
 * The dataset it produces is explicitly classified `synthetic-only`: it is a
 * development fixture, never evidence about Solana.
 *
 * Usage:
 *   node scripts/make-fixture.mjs --dir .evolve/history/2026-09-17/session-fixture \
 *     --snapshots 60 --interval 5000 --seed fixture-1 --tokens 16
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { createRecorder } from "./history/recorder.mjs";
import { createManualClock } from "./engine/clock.mjs";
import { createSeededRandom } from "./lib/random.mjs";
import { createMarketConfig } from "./market/config.mjs";
import { createMarketFeed } from "./market/feed.mjs";

export function parseArgs(argv) {
  // Positional arguments (a dataset path, for example) land in `args._`.
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

/**
 * Build a synthetic-only fixture dataset.
 * Returns the finalized manifest.
 */
export async function makeFixture({
  dir,
  snapshots = 60,
  intervalMs = 5000,
  seed = "fixture",
  tokenCount = 16,
  startAt = Date.UTC(2026, 8, 17, 12, 0, 0),
  config = null,
  feeOverride = null,
} = {}) {
  const random = createSeededRandom(seed);
  const clock = createManualClock(startAt);

  const fixtureConfig =
    config ??
    createMarketConfig(
      {
        EVOLVE_MARKET_MODE: "synthetic",
        EVOLVE_SYNTHETIC_UNIVERSE: String(tokenCount),
        EVOLVE_SYNTHETIC_RETRY_MS: "1000",
      },
      { loadEnv: false },
    );

  const feed = createMarketFeed({
    config: fixtureConfig,
    fetchImpl: async () => {
      // The fixture never talks to a provider, by construction.
      throw new Error("fixture mode is offline");
    },
    now: clock.now,
    random,
  });

  const recorder = createRecorder({
    dir,
    feed,
    config: fixtureConfig,
    now: clock.now,
    captureMs: intervalMs,
    engineVersion: `fixture@${seed}`,
    onLog: () => {},
  });

  await recorder.start();
  recorder.pushEvent("SYSTEM", `Deterministic fixture (seed ${seed}).`);

  for (let index = 0; index < snapshots; index += 1) {
    // The synthetic provider advances on its own tick cadence, so step the
    // manual clock beyond it each capture to keep the market moving.
    clock.advance(Math.max(intervalMs, fixtureConfig.engine.tickMs + 1));
    await feed.advance(clock.now());
    await recorder.capture(clock.now());
  }

  const manifest = await recorder.close({ reason: "fixture-complete" });

  if (feeOverride) {
    // Only used by tests that want a paper-cost sensitivity check.
    void feeOverride;
  }

  return manifest;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  const dir =
    typeof args.dir === "string"
      ? args.dir
      : path.join(".evolve", "history", "2026-09-17", `session-fixture-${args.seed ?? "1"}`);

  makeFixture({
    dir,
    snapshots: Number(args.snapshots ?? 60),
    intervalMs: Number(args.interval ?? 5000),
    seed: args.seed ?? "fixture",
    tokenCount: Number(args.tokens ?? 16),
  })
    .then((manifest) => {
      console.log(`[EVOLVE] fixture dataset written to ${dir}`);
      console.log(
        `[EVOLVE] ${manifest.snapshotCount} snapshots · ${manifest.uniqueMintCount} mints · class ${manifest.dataClass}`,
      );
      console.log(`[EVOLVE] fingerprint ${manifest.fingerprint?.combined ?? "n/a"}`);
      console.log(`[EVOLVE] replay with: EVOLVE_MARKET_MODE=replay EVOLVE_REPLAY_DATASET=${dir} npm run replay`);
    })
    .catch((error) => {
      console.error("fixture generation failed:", error?.message ?? error);
      process.exitCode = 1;
    });
}
