#!/usr/bin/env node
/**
 * LIVE SHADOW LEAGUE • PAPER MONEY
 *
 * Long-running paper evaluation of frozen Deployment Candidate genomes against
 * genuine current Solana market observations.
 *
 * Hard rules (enforced here, and by the validation suite):
 *   - shadow genomes are IMMUTABLE for the life of the run: no mutation, no
 *     crossover, no adaptive thresholds, no parameter tuning, no learning
 *   - paper execution only: no wallet, no keys, no signing, no orders
 *   - only DEPLOYMENT CANDIDATES are admitted; a development override is
 *     permanently labelled UNQUALIFIED SHADOW TEST
 *   - a degraded live feed blocks NEW entries (existing positions keep their
 *     last defensible observed mark; no price is ever fabricated)
 *
 *   npm run shadow                      # admit qualified candidates
 *   npm run shadow -- --dev <digest-or-genome.json>   # labelled dev override
 */

import path from "node:path";
import { access, readFile, readdir } from "node:fs/promises";

import { parseArgs } from "../make-fixture.mjs";
import { createMarketConfig } from "../market/config.mjs";
import { createMarketFeed } from "../market/feed.mjs";
import { createSimulation } from "../engine/simulation.mjs";
import { createWallClock } from "../engine/clock.mjs";
import { digestOf } from "../lib/hash.mjs";
import {
  buildShadowState,
  advanceShadowMilestones,
  shadowPromotionStatus,
  shadowEntryGate,
  persistShadowState,
  ensureDir,
  DEFAULT_SHADOW_DIR,
  CANDIDATE_STATUS,
} from "./orchestrator.mjs";

const PAPER_NOTICE = "LIVE SHADOW LEAGUE • PAPER MONEY — genomes frozen, results simulated, not money earned.";

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function loadDeploymentCandidates(championsDir) {
  const dir = path.join(championsDir, "deployment");
  if (!(await exists(dir))) {
    // Fall back to champions whose latest status was DEPLOYMENT CANDIDATE.
    const file = path.join(championsDir, "index.json");
    if (!(await exists(file))) return [];
    try {
      const index = JSON.parse(await readFile(file, "utf8"));
      return (index.members ?? [])
        .filter((member) => member.bestStatus === CANDIDATE_STATUS.DEPLOYMENT_CANDIDATE)
        .map((member) => ({
          digest: member.digest,
          genome: member.genome,
          species: member.species ?? "Champion",
          status: CANDIDATE_STATUS.DEPLOYMENT_CANDIDATE,
        }));
    } catch {
      return [];
    }
  }
  const files = (await readdir(dir)).filter((name) => name.endsWith(".json"));
  const out = [];
  for (const name of files) {
    try {
      const record = JSON.parse(await readFile(path.join(dir, name), "utf8"));
      if (record?.genome && record?.status === CANDIDATE_STATUS.DEPLOYMENT_CANDIDATE) {
        out.push(record);
      }
    } catch {
      // skip unreadable candidate files
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = createMarketConfig(
    { ...process.env, EVOLVE_MARKET_MODE: process.env.EVOLVE_MARKET_MODE ?? "auto" },
    { loadEnv: true },
  );

  console.log("========================================");
  console.log(" LIVE SHADOW LEAGUE • PAPER MONEY");
  console.log("========================================");
  console.log(PAPER_NOTICE);
  console.log(`market mode: ${config.requestedMode} (shadow uses LIVE observations; paper execution only)`);

  // ---- Candidate admission ------------------------------------------------
  let candidates = [];
  let devOverride = false;

  if (args.dev) {
    devOverride = true;
    const source = String(args.dev);
    let genome = null;
    let species = "DevOverride";
    if (await exists(source)) {
      const parsed = JSON.parse(await readFile(source, "utf8"));
      genome = parsed.genome ?? parsed;
      species = parsed.species ?? species;
    } else {
      // Interpret as a genome JSON literal.
      try {
        genome = JSON.parse(source);
      } catch {
        console.error("[shadow] --dev expects a genome JSON file or literal");
        process.exitCode = 1;
        return;
      }
    }
    const digest = digestOf(genome);
    candidates = [{ digest, genome, species, status: CANDIDATE_STATUS.UNQUALIFIED_SHADOW_TEST }];
    console.log("[shadow] DEVELOPMENT OVERRIDE: candidate is NOT deployment-qualified and will be labelled UNQUALIFIED SHADOW TEST.");
  } else {
    candidates = await loadDeploymentCandidates(config.championsDir ?? ".evolve/champions");
    console.log(`[shadow] deployment candidates admitted: ${candidates.length}`);
  }

  if (candidates.length === 0) {
    console.log("[shadow] no candidates to shadow. Run an arena first:  npm run arena");
    return;
  }

  // ---- Feed + simulation --------------------------------------------------
  const feed = createMarketFeed({ config, now: () => Date.now() });
  const clock = createWallClock(() => Date.now());

  const states = candidates.map((candidate) =>
    buildShadowState(candidate, {
      source: config.requestedMode,
      startingCash: config.paper.startingCash,
      at: Date.now(),
    }),
  );

  await ensureDir(DEFAULT_SHADOW_DIR);

  const simulations = new Map();
  for (let i = 0; i < candidates.length; i += 1) {
    const simulation = createSimulation({
      config,
      feed,
      now: clock.now,
      fixedPopulation: [
        {
          genome: candidates[i].genome,
          species: candidates[i].species,
          label: states[i].candidateId,
        },
      ],
      evolution: { enabled: false },
      recordTrades: true,
    });
    simulations.set(states[i].candidateId, simulation);
  }

  feed.start({ intervalMs: Math.min(1000, config.engine.tickMs) });

  const PERSIST_EVERY_MS = 30_000;
  let lastPersist = 0;
  let stopped = false;

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    console.log("\n[shadow] stopping; final persist...");
    clearInterval(tickTimer);
    feed.stop();
    for (const state of states) {
      const simulation = simulations.get(state.candidateId);
      const settled = simulation?.settle?.({ reason: "SHADOW-STOP" }) ?? null;
      updateStateFromSimulation(state, simulation, settled);
      const promotion = shadowPromotionStatus(state);
      state.status = promotion.status;
      state.promotionNote = promotion.note;
      await persistShadowState(state);
      printCandidate(state);
    }
    console.log("[shadow] genomes were frozen the entire run; no parameter was ever modified.");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.log(`[shadow] shadowing ${states.length} frozen candidate(s). Ctrl+C to stop and persist.`);

  const tickTimer = setInterval(async () => {
    try {
      const now = Date.now();
      const health = feed.health();
      const gate = shadowEntryGate(health, { allowDegraded: devOverride === false ? false : false });
      // The gate only blocks NEW entries; the simulation already refuses entries
      // when feed health pauses them. We record gate outcomes for transparency.

      for (const state of states) {
        const simulation = simulations.get(state.candidateId);
        simulation.advanceTick();
        updateStateFromSimulation(state, simulation, null);
        advanceShadowMilestones(state, now);
        state.gateBlockedTicks = (state.gateBlockedTicks ?? 0) + (gate.blocked ? 1 : 0);
      }

      if (now - lastPersist >= PERSIST_EVERY_MS) {
        lastPersist = now;
        for (const state of states) {
          const promotion = shadowPromotionStatus(state);
          state.status = promotion.status;
          state.promotionNote = promotion.note;
          await persistShadowState(state);
        }
      }
    } catch (error) {
      console.error("[shadow] tick failed:", error?.message ?? error);
    }
  }, config.engine.tickMs);

  // Keep the process alive; stop() is the only exit path.
  await new Promise(() => {});
}

function updateStateFromSimulation(state, simulation, settled) {
  if (!simulation) return;
  const agent = simulation.population[0];
  if (!agent) return;
  state.bankroll = agent.equity;
  state.grossPnl = agent.grossPnl ?? 0;
  state.netPnl = agent.netPnl ?? 0;
  state.drawdown = agent.maxDrawdown ?? 0;
  state.costs = agent.costs ?? 0;
  state.trades = agent.trades ?? 0;
  const mints = new Set((agent.ledger ?? []).map((row) => row.mint));
  state.distinctMints = mints.size;
  state.activePositions = agent.position ? 1 : 0;
  state.runtimeMs = Date.now() - state.startTimestamp;
  const health = simulation.feed?.health?.() ?? null;
  if (health) {
    state.feedHealthExposure = {
      degradedSnapshots: (state.feedHealthExposure?.degradedSnapshots ?? 0) + (health.degraded ? 1 : 0),
      entriesPausedTicks: (state.feedHealthExposure?.entriesPausedTicks ?? 0) + (health.entriesPaused ? 1 : 0),
      totalSnapshots: (state.feedHealthExposure?.totalSnapshots ?? 0) + 1,
    };
  }
  if (settled) state.lastSettlement = { reason: settled.reason ?? "settle", at: Date.now() };
}

function printCandidate(state) {
  const money = (value) => `$${(Number.isFinite(value) ? value : 0).toFixed(2)}`;
  console.log(
    `  ${state.candidateId}  status=${state.status}  bankroll=${money(state.bankroll)}  net=${money(state.netPnl)}  DD=${(state.drawdown * 100).toFixed(1)}%  trades=${state.trades}  mints=${state.distinctMints}`,
  );
}

main().catch((error) => {
  console.error("[shadow] failed:", error?.message ?? error);
  process.exitCode = 1;
});
