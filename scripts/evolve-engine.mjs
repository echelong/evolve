#!/usr/bin/env node
/**
 * EVOLVE engine entry point.
 *
 * PAPER TRADING ONLY. This process observes Solana market data, runs an
 * evolutionary population of paper agents against it, and writes a dashboard
 * snapshot to `.evolve/state.json`.
 *
 * It has no wallet, no private keys, no signer, no RPC write path, and no
 * order-submission code. A "trade" is an internal simulated accounting event
 * priced from observed market data.
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createSimulation } from "./engine/simulation.mjs";
import { serializeForPublic } from "./lib/sanitize.mjs";
import { createMarketConfig, publicConfig } from "./market/config.mjs";
import { createMarketFeed } from "./market/feed.mjs";

export const STATE_DIR = ".evolve";
export const STATE_FILE = "state.json";

export function statePaths(dir = STATE_DIR) {
  return {
    dir,
    file: path.join(dir, STATE_FILE),
    tempFile: path.join(dir, `${STATE_FILE}.tmp`),
  };
}

/**
 * Build a running engine (no timers started).
 * Useful for tests, smoke runs, and embedding.
 */
export function createEngine({ config = createMarketConfig(), now, random } = {}) {
  let simulation = null;

  const feed = createMarketFeed({
    config,
    now,
    random,
    onEvent: ({ type, message }) => simulation?.addEvent(type, message),
  });

  simulation = createSimulation({ config, feed, now, random });

  return { config, feed, simulation };
}

function startupLines({ config }) {
  const lines = [];
  lines.push(`[EVOLVE] PAPER ONLY engine — ${config.engine.population} agents, no wallet, no keys, no on-chain execution.`);
  lines.push(
    `[EVOLVE] market mode request=${config.requestedMode} key=${config.apiKeyConfigured ? "configured" : "not configured"} provider=${config.provider}`,
  );
  if (!config.apiKeyConfigured) {
    lines.push(
      `[EVOLVE] JUPITER_API_KEY is not set. ${
        config.requestedMode === "live"
          ? "Live mode will report DEGRADED and pause new entries."
          : config.keylessAllowed
            ? "Trying keyless live observations, then synthetic fallback."
            : "Falling back to the synthetic paper market."
      }`,
    );
  }
  if (config.loadedEnvFiles.length > 0) {
    lines.push(`[EVOLVE] env files loaded: ${config.loadedEnvFiles.join(", ")}`);
  }
  lines.push(
    `[EVOLVE] endpoints: ${config.endpoints.map((endpoint) => endpoint.label).join(", ")}`,
  );
  lines.push(
    `[EVOLVE] paper cash $${config.paper.startingCash} · fee ${config.paper.baseFeeBps}bps · min slippage ${config.paper.minSlippageBps}bps · universe max ${config.universeMax}`,
  );
  return lines;
}

/** Persist the snapshot atomically so the dashboard never reads a partial file. */
export async function persist(state, { dir = STATE_DIR } = {}) {
  const paths = statePaths(dir);
  await mkdir(paths.dir, { recursive: true });
  const payload = serializeForPublic(state);
  await writeFile(paths.tempFile, payload, "utf8");
  await rename(paths.tempFile, paths.file);
}

export async function startEngine({ config = createMarketConfig(), dir = STATE_DIR } = {}) {
  const { feed, simulation } = createEngine({ config });

  for (const line of startupLines({ config })) console.log(line);

  simulation.addEvent("SYSTEM", `EVOLVE engine online with ${config.engine.population} paper agents.`);
  simulation.addEvent(
    "SYSTEM",
    "Paper mode enforced. No wallet keys are loaded and no on-chain execution path exists.",
  );

  const snapshotWithConfig = () => ({
    ...simulation.snapshot(),
    config: publicConfig(config),
  });

  await persist(snapshotWithConfig(), { dir });

  feed.start({ intervalMs: Math.min(1000, config.engine.tickMs) });

  let ticking = false;

  const timer = setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      simulation.advanceTick();
      await persist(snapshotWithConfig(), { dir });
    } catch (error) {
      console.error("[EVOLVE] tick failed:", error?.message ?? error);
    } finally {
      ticking = false;
    }
  }, config.engine.tickMs);

  const shutdown = async (signal) => {
    console.log(`[EVOLVE] ${signal} received — flushing state and exiting.`);
    clearInterval(timer);
    feed.stop();
    try {
      await persist(snapshotWithConfig(), { dir });
    } catch {
      // best effort on shutdown
    }
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  console.log(`[EVOLVE] dashboard state -> ${path.join(dir, STATE_FILE)}`);
  console.log(`[EVOLVE] paper engine running: ${config.engine.population} agents`);

  return { feed, simulation, timer };
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  startEngine().catch((error) => {
    console.error("[EVOLVE] fatal bootstrap error:", error);
    process.exitCode = 1;
  });
}
