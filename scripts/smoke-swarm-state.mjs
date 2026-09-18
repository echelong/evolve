#!/usr/bin/env node
/**
 * EVOLVE offline swarm-state smoke run (Phase 5A.1).
 *
 * Proves, fully offline and deterministically, the three things the Phase 5A.1
 * correctness pass changed:
 *
 *   1. a 192-agent population initializes at approximately 32 per island, keeps
 *      `sum(island populations) == 192` for every generation, and islands
 *      genuinely DIVERGE from 32/32/32/32/32/32 as evidence differs — bounded by
 *      an explicit diversity floor and monoculture cap rather than a hard quota;
 *   2. a live Phase 5A research swarm (proposals -> compiled families ->
 *      injected candidates -> watchdog evaluations -> memory records) is visible
 *      through the *same* state contract the dashboard reads;
 *   3. a stale Phase 3 synthetic `session-demo` replay/experiment sitting in the
 *      same `.evolve/` directory cannot replace or masquerade as the current
 *      swarm: `auto` serves the live document, `researchSwarm` is the live
 *      swarm, and the old replay data appears only under `historicalResearch`.
 *
 * No network, no LLM key, no wallet, no execution path. PAPER ONLY.
 *
 * Run with: npm run smoke:swarm
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createMarketConfig, publicConfig } from "./market/config.mjs";
import { createMarketFeed } from "./market/feed.mjs";
import { createSimulation } from "./engine/simulation.mjs";
import { createSeededRandom } from "./lib/random.mjs";
import { createResearchController, persist } from "./evolve-engine.mjs";
import { readDashboardState } from "./lib/dashboard-state.mjs";

const POPULATION = 192;
const GENERATION_TICKS = 12;
const GENERATIONS = 40;
const ISLAND_COUNT = 6;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function writeJson(file, payload) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/** A fake, stale Phase 3 synthetic replay + experiment, exactly like the real one. */
async function writeStalePhase3Artifacts(root) {
  const dataset = {
    id: "session-demo",
    dir: ".evolve/history/2026-09-17/session-demo",
    dataClass: "synthetic-only",
    containsSynthetic: true,
    usableForRealMarketReplay: false,
    snapshotCount: 263,
    uniqueMints: 24,
    firstObservedAt: 1_789_634_081_485,
    lastObservedAt: 1_789_634_212_556,
    durationMinutes: 2.185,
    fingerprint: "a9a86168b8cc525a265fcab67d10f0a843e033d0d67d9149466923eff88ccd25",
    integrityVerified: true,
  };

  await writeJson(path.join(root, "replay-state.json"), {
    updatedAt: "2026-09-17T11:54:00.000Z",
    mode: "PAPER",
    paperOnly: true,
    stats: { population: 96, alive: 96 },
    research: {
      mode: "replay",
      banner: "HISTORICAL REPLAY • PAPER MONEY",
      stage: "TEST",
      dataset,
      replay: { finished: true, snapshotsRead: 263, speed: 1 },
      disclaimer: "Historical backtests and paper results do NOT guarantee future profitability.",
    },
  });

  const experimentId = "exp-session-demo-20260917T085106Z-S-a7km";
  await writeJson(path.join(root, "experiments", experimentId, "manifest.json"), {
    experimentId,
    createdAt: "2026-09-17T08:51:06.000Z",
    dataset: { id: dataset.id, dataClass: dataset.dataClass },
    paperOnly: true,
  });
  await writeJson(path.join(root, "experiments", experimentId, "summary.json"), {
    experimentId,
    dataset: { id: dataset.id, dataClass: dataset.dataClass },
    seeds: ["evolve"],
    windows: 1,
    champions: 0,
    paperOnly: true,
    datasetFingerprint: dataset.fingerprint,
  });
  return experimentId;
}

async function main() {
  const workdir = await mkdtemp(path.join(tmpdir(), "evolve-smoke-swarm-"));
  const evolveDir = path.join(workdir, ".evolve");
  const experimentId = await writeStalePhase3Artifacts(evolveDir);

  const config = createMarketConfig(
    {
      EVOLVE_MARKET_MODE: "synthetic",
      EVOLVE_POPULATION_SIZE: String(POPULATION),
      EVOLVE_GENERATION_TICKS: String(GENERATION_TICKS),
      EVOLVE_SYNTHETIC_UNIVERSE: "16",
      EVOLVE_SEED: "swarm-smoke",
      EVOLVE_RESEARCH_ENABLED: "true",
      EVOLVE_RESEARCH_CYCLE_EVERY_GENERATIONS: "2",
      EVOLVE_RESEARCH_ROOT: path.join(evolveDir, "research"),
    },
    { loadEnv: false },
  );

  const random = createSeededRandom("swarm-smoke");
  let clock = 1_760_000_000_000;
  const now = () => clock;
  const feed = createMarketFeed({
    config,
    fetchImpl: async () => {
      throw new Error("offline smoke only");
    },
    now,
    random,
  });
  const simulation = createSimulation({
    config,
    feed,
    now,
    random,
    evolution: { enabled: true, ...config.evolution },
  });
  const research = createResearchController({ config, simulation });
  const snapshot = () => ({
    ...simulation.snapshot(),
    config: publicConfig(config),
    researchSwarm: research.summary(),
  });

  // 1. Initialization: approximately even (32 each at 192).
  const initial = simulation.snapshot();
  const initialSum = initial.islands.reduce((sum, island) => sum + island.population, 0);
  const initialSpread = Math.max(...initial.islands.map((island) => island.population)) -
    Math.min(...initial.islands.map((island) => island.population));
  assert(initial.islands.length === ISLAND_COUNT, `expected ${ISLAND_COUNT} islands`);
  assert(initialSum === POPULATION, `initial island sum must be ${POPULATION}, got ${initialSum}`);
  assert(initialSpread <= 1, `initialization must be approximately even (32 each), spread was ${initialSpread}`);
  const initialCounts = Object.fromEntries(initial.islands.map((island) => [island.name, island.population]));

  await persist(snapshot(), { dir: evolveDir });

  // 2. Evolve, driving the research cycle exactly as the live engine does.
  for (let generation = 0; generation < GENERATIONS; generation += 1) {
    for (let tick = 0; tick < GENERATION_TICKS; tick += 1) {
      await feed.advance(clock);
      clock += config.engine.tickMs;
      simulation.advanceTick();
    }
    await research.runIfDue();
    const mid = simulation.snapshot();
    const midSum = mid.islands.reduce((sum, island) => sum + island.population, 0);
    assert(midSum === POPULATION, `island sum must stay exactly ${POPULATION} at generation ${mid.generation}, got ${midSum}`);
    assert(mid.stats.alive === POPULATION, `alive must stay exactly ${POPULATION}, got ${mid.stats.alive}`);
    for (const island of mid.islands) {
      assert(island.population >= island.floor, `${island.name} fell below its diversity floor (${island.population} < ${island.floor})`);
      assert(island.population <= island.cap, `${island.name} exceeded its cap (${island.population} > ${island.cap})`);
    }
  }

  const state = snapshot();
  await persist(state, { dir: evolveDir });

  const finalSum = state.islands.reduce((sum, island) => sum + island.population, 0);
  const finalCounts = Object.fromEntries(state.islands.map((island) => [island.name, island.population]));
  const divergedFromEven = state.islands.filter((island) => island.population !== initialCounts[island.name]);
  const distinct = new Set(state.islands.map((island) => island.population));

  assert(finalSum === POPULATION, `final island sum must be ${POPULATION}, got ${finalSum}`);
  assert(
    state.stats.bornTotal - state.stats.terminatedTotal === state.stats.population,
    "born - terminated must equal the population",
  );
  assert(divergedFromEven.length > 0, "at least one island must have diverged from its initialization count");
  assert(distinct.size > 1, "island populations must be able to differ from one another");

  // 3. Research swarm activity (offline mock provider, deterministic).
  const swarm = state.researchSwarm;
  assert(swarm && swarm.enabled === true, "the snapshot must carry an enabled researchSwarm summary");
  assert(swarm.cycle >= 1, `the research swarm must have run at least one cycle, got ${swarm.cycle}`);
  assert(swarm.proposalsGenerated > 0, "the swarm must have generated proposals");
  assert(swarm.compiledFamilies > 0, "the swarm must have compiled at least one candidate family");
  assert(swarm.memoryRecords > 0, "the swarm must have written research memory records");
  assert(swarm.watchdog && typeof swarm.watchdog.normal === "number", "the swarm must expose watchdog counts");

  // 4. The dashboard contract: live swarm + stale Phase 3 history, never merged.
  const { status, body } = await readDashboardState({ root: evolveDir, requested: "auto" });
  assert(status === 200, `the dashboard state must be served, got status ${status}`);
  assert(body.stateSource === "live", `auto must serve the live document, got ${body.stateSource}`);
  assert(body.researchSwarm, "the contract must expose researchSwarm");
  assert(body.researchSwarm.source === "live", "the swarm summary must come from the live document");
  assert(body.researchSwarm.cycle === swarm.cycle, "the exposed swarm cycle must match the live snapshot");
  assert(body.researchSwarm.compiledFamilies > 0, "the exposed swarm must report compiled families");
  assert(body.researchSwarm.memoryRecords > 0, "the exposed swarm must report memory records");
  assert(
    typeof body.researchSwarm.researcherRoles === "object" && Object.keys(body.researchSwarm.researcherRoles).length > 0,
    "the exposed swarm must report researcher-role counts",
  );
  assert(body.historicalResearch, "the contract must still expose historical research data");
  assert(body.historicalResearch.kind === "historical", "historical research data must be labelled historical");
  assert(
    body.historicalResearch.experiment?.id === experimentId,
    "the stale Phase 3 experiment must remain available as historical data",
  );
  assert(
    JSON.stringify(body.researchSwarm).includes("session-demo") === false,
    "the stale Phase 3 replay must never leak into the current swarm summary",
  );

  // A serialized response must never carry a non-finite number.
  const serialized = JSON.stringify(body);
  assert(!/\bNaN\b|\bInfinity\b/.test(serialized), "the dashboard state must contain no NaN/Infinity");

  const counts = state.islands
    .slice()
    .sort((a, b) => b.population - a.population)
    .map((island) => `${island.name} ${island.population} (${(island.share * 100).toFixed(1)}%) [weight ${island.reproductiveWeight.toFixed(2)}, floor ${island.floor}, cap ${island.cap}]`);

  console.log("[EVOLVE] SWARM STATE SMOKE — PAPER ONLY");
  console.log(`[EVOLVE] population        ${state.stats.population} agents · ${state.islands.length} islands · generation ${state.generation}`);
  console.log(`[EVOLVE] initial split     ${Object.entries(initialCounts).map(([name, count]) => `${name} ${count}`).join(", ")}`);
  console.log("[EVOLVE] final split       ");
  for (const line of counts) console.log(`            ${line}`);
  console.log(`[EVOLVE] island sum        ${finalSum} (exact) · born-dead ${state.stats.bornTotal - state.stats.terminatedTotal}`);
  console.log(
    `[EVOLVE] research swarm    cycle ${swarm.cycle} · proposals ${swarm.proposalsGenerated} (accepted ${swarm.proposalsAccepted}, rejected ${swarm.proposalsRejected}) · compiled families ${swarm.compiledFamilies}`,
  );
  console.log(
    `[EVOLVE] watchdog          NORMAL ${swarm.watchdog.normal} · WATCH ${swarm.watchdog.watch} · QUARANTINED ${swarm.watchdog.quarantined} · evaluated ${swarm.watchdog.evaluated}`,
  );
  console.log(
    `[EVOLVE] memory            records ${swarm.memoryRecords} · conclusions ${swarm.conclusions} · roles ${JSON.stringify(swarm.researcherRoles)}`,
  );
  console.log(`[EVOLVE] state contract    researchSwarm(cycle ${body.researchSwarm.cycle}, source ${body.researchSwarm.source}) + historicalResearch(${body.historicalResearch.experiment?.id})`);
  console.log(`[EVOLVE] final counts      ${JSON.stringify(finalCounts)}`);
  console.log("[EVOLVE] PAPER ONLY — no wallet, no keys, no execution path. Nothing here is a profitability claim.");

  await rm(workdir, { recursive: true, force: true }).catch(() => {});
  return { finalCounts, swarm: { cycle: swarm.cycle, watchdog: swarm.watchdog } };
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error) => {
    console.error("[EVOLVE] swarm state smoke failed:", error?.message ?? error);
    process.exitCode = 1;
  });
