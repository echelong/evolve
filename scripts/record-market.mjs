#!/usr/bin/env node
/**
 * Historical market recorder CLI.
 *
 * Runs the same market feed the engine uses and appends normalized snapshots to
 * a dataset:
 *
 *   npm run record:market
 *   EVOLVE_MARKET_MODE=live npm run record:market
 *   EVOLVE_MARKET_MODE=synthetic npm run record:market
 *   npm run record:market -- --minutes 30 --interval 5000
 *
 * Ctrl+C finalizes the manifest (status complete, with fingerprint) and exits
 * cleanly. No shell `exit` calls, no terminal takeover: the process flushes,
 * prints where the dataset landed, and returns.
 *
 * PAPER ONLY and observation-only: this command records market data. It cannot
 * trade, sign, or submit anything.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createRecorder, resolveDatasetDir } from "./history/recorder.mjs";
import { createMarketConfig } from "./market/config.mjs";
import { createMarketFeed } from "./market/feed.mjs";
import { parseArgs } from "./make-fixture.mjs";

function readGitCommit() {
  try {
    const head = readFileSync(path.join(".git", "HEAD"), "utf8").trim();
    if (head.startsWith("ref:")) {
      const ref = head.slice(4).trim();
      const sha = readFileSync(path.join(".git", ref), "utf8").trim();
      return sha.slice(0, 12);
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = createMarketConfig();

  const captureMs = Number(args.interval ?? config.recordCaptureMs);
  const minutes = args.minutes === undefined ? null : Number(args.minutes);
  const durationMs = minutes === null ? null : minutes * 60_000;

  const dir =
    typeof args.dir === "string"
      ? args.dir
      : resolveDatasetDir(config.historyRoot, { suffix: config.requestedMode });

  const feed = createMarketFeed({ config });

  const recorder = createRecorder({
    dir,
    feed,
    config,
    captureMs,
    engineVersion: `evolve@${readEngineVersion()}`,
    gitCommit: readGitCommit(),
    manifestEvery: config.recordManifestEvery,
    onLog: (line) => console.log(line),
  });

  await recorder.start();

  console.log(`[EVOLVE] PAPER ONLY recorder · mode=${config.requestedMode} · capture every ${captureMs}ms`);
  console.log(
    `[EVOLVE] api key ${config.apiKeyConfigured ? "configured (never recorded)" : "not configured (keyless live, or synthetic)"}`,
  );
  console.log(`[EVOLVE] dataset -> ${dir}`);
  if (durationMs !== null) console.log(`[EVOLVE] recording for ${minutes} minute(s)`);
  console.log("[EVOLVE] press Ctrl+C to finalize the dataset");

  // Poll on the same cadence the engine polls at, capture on the record cadence.
  let capturing = false;
  let stopping = false;
  let finalManifest = null;

  const pollTimer = setInterval(async () => {
    if (capturing || stopping) return;
    capturing = true;
    try {
      await feed.advance();
    } catch (error) {
      recorder.pushEvent("MARKET", `observation cycle failed: ${error?.message ?? "unknown"}`);
    } finally {
      capturing = false;
    }
  }, Math.min(1000, config.engine.tickMs));
  if (typeof pollTimer.unref === "function") pollTimer.unref();

  let captures = 0;
  const captureTimer = setInterval(async () => {
    if (stopping) return;
    try {
      const result = await recorder.capture();
      if (result) {
        captures += 1;
        const health = feed.health();
        process.stdout.write(
          `\r[EVOLVE] snapshots ${captures} · tokens ${result.count} · mode ${health.effectiveMode} · requests ${health.requestCount} · errors ${health.errorCount}   `,
        );
      }
    } catch (error) {
      recorder.pushEvent("SYSTEM", `capture failed: ${error?.message ?? "unknown"}`);
    }
  }, captureMs);
  if (typeof captureTimer.unref === "function") captureTimer.unref();

  const stopTimer = durationMs === null ? null : setTimeout(() => void shutdown("duration reached"), durationMs);
  if (stopTimer && typeof stopTimer.unref === "function") stopTimer.unref();

  let shuttingDown = false;

  async function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    stopping = true;
    clearInterval(pollTimer);
    clearInterval(captureTimer);
    if (stopTimer) clearTimeout(stopTimer);
    feed.stop();

    process.stdout.write("\n");
    finalManifest = await recorder.close({ reason, status: "complete" });

    console.log(`[EVOLVE] dataset finalized: ${finalManifest.snapshotCount} snapshots`);
    console.log(`[EVOLVE] mints ${finalManifest.uniqueMintCount} · class ${finalManifest.dataClass}`);
    console.log(`[EVOLVE] ${finalManifest.dataClassStatement}`);
    console.log(`[EVOLVE] fingerprint ${finalManifest.fingerprint?.combined ?? "n/a"}`);
    console.log(`[EVOLVE] replay with: EVOLVE_MARKET_MODE=replay EVOLVE_REPLAY_DATASET=${dir} npm run replay`);
    console.log("[EVOLVE] recorder stopped. Terminal is free.");
    process.exitCode = 0;
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Keep the process alive while timers run.
  await new Promise((resolve) => {
    const check = () => (shuttingDown ? resolve() : setTimeout(check, 250));
    check();
  });

  return finalManifest;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error) => {
    console.error("recorder failed:", error?.message ?? error);
    process.exitCode = 1;
  });
}
