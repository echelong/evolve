#!/usr/bin/env node
/**
 * Engine smoke run — synthetic market, no network, deterministic seed.
 *
 * Verifies the Phase 1 evolutionary loop still works end to end on top of the
 * Phase 2 market abstraction: generations advance, agents are born and culled,
 * species stay populated, paper trades clear with costs, and nothing in the
 * snapshot is non-finite.
 *
 * Run with: npm run smoke:engine
 */

import { createSimulation } from "./engine/simulation.mjs";
import { createSeededRandom } from "./lib/random.mjs";
import { serializeForPublic } from "./lib/sanitize.mjs";
import { createMarketConfig } from "./market/config.mjs";
import { createMarketFeed } from "./market/feed.mjs";

const SEED = process.env.EVOLVE_SMOKE_SEED ?? "evolve-phase-2";
const POPULATION = Number(process.env.EVOLVE_SMOKE_POPULATION ?? 96);
const GENERATION_TICKS = Number(process.env.EVOLVE_SMOKE_GENERATION_TICKS ?? 40);
const GENERATIONS = Number(process.env.EVOLVE_SMOKE_GENERATIONS ?? 3);

function pct(value) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(2)}%`;
}

function money(value) {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

async function main() {
  const config = createMarketConfig(
    {
      EVOLVE_MARKET_MODE: "synthetic",
      EVOLVE_POPULATION: String(POPULATION),
      EVOLVE_GENERATION_TICKS: String(GENERATION_TICKS),
    },
    { loadEnv: false },
  );

  const random = createSeededRandom(SEED);
  let clock = 1_760_000_000_000;
  const now = () => clock;

  const feed = createMarketFeed({
    config,
    fetchImpl: async () => {
      throw new Error("smoke run is offline by design");
    },
    now,
    random,
  });
  const simulation = createSimulation({ config, feed, now, random });

  // Run the requested generations plus a partial one, so the report reflects
  // trading activity inside the newest generation rather than the instant a
  // breeding event reset everyone's per-generation stats.
  const ticks = GENERATION_TICKS * GENERATIONS + Math.ceil(GENERATION_TICKS / 2);
  const started = Date.now();

  for (let tick = 0; tick < ticks; tick += 1) {
    await feed.advance(clock);
    clock += config.engine.tickMs;
    simulation.advanceTick();
  }

  const snapshot = simulation.snapshot();
  const serialized = serializeForPublic(snapshot, { secrets: config.secretValues });
  const problems = [];

  if (snapshot.generation !== GENERATIONS + 1) {
    problems.push(`expected generation ${GENERATIONS + 1}, got ${snapshot.generation}`);
  }
  if (snapshot.stats.alive !== POPULATION) problems.push("population did not stay full");
  if (!(snapshot.stats.terminatedTotal > 0)) problems.push("no agents were terminated");
  if (!(snapshot.stats.bornTotal > POPULATION)) problems.push("no agents were born");
  const extinct = snapshot.species.filter((species) => species.count === 0);
  if (extinct.length > 1) {
    problems.push(`selection wiped out ${extinct.map((species) => species.name).join(", ")}`);
  }
  if (!(snapshot.stats.trades > 0)) problems.push("no paper trades were executed");
  if (!(snapshot.paper.costs > 0)) problems.push("no simulated costs were charged");
  if (/NaN|Infinity|undefined/.test(serialized)) problems.push("state contains non-finite values");
  if (snapshot.marketFeed.effectiveMode !== "synthetic") {
    problems.push("smoke run must stay in synthetic mode");
  }
  if (!/SYNTHETIC MARKET/.test(snapshot.marketFeed.banner)) problems.push("banner is not synthetic");

  console.log("EVOLVE engine smoke run (synthetic market, paper only)");
  console.log(`  seed                 ${SEED}`);
  console.log(`  ticks                ${ticks} in ${Date.now() - started}ms`);
  console.log(`  generation           ${snapshot.generation}`);
  console.log(`  population           ${snapshot.stats.alive} alive / ${snapshot.stats.terminatedTotal} terminated / ${snapshot.stats.bornTotal} born`);
  console.log(`  banner               ${snapshot.marketFeed.banner}`);
  console.log(`  markets              ${snapshot.markets.length} observed (${snapshot.markets.filter((market) => market.synthetic).length} synthetic)`);
  console.log(`  paper trades         ${snapshot.stats.trades}`);
  console.log(`  population return    ${pct(snapshot.stats.avgReturn)} (paper)`);
  console.log(`  gross / net P&L      ${money(snapshot.paper.grossPnl)} gross / ${money(snapshot.paper.netPnl)} net (after $${Math.abs(snapshot.paper.costs).toFixed(2)} of simulated fees + slippage)`);
  console.log(`  best fitness         ${snapshot.stats.bestFitness.toFixed(2)}`);
  console.log("  species:");
  for (const species of snapshot.species) {
    console.log(`    ${species.name.padEnd(16)} ${String(species.count).padStart(3)} members  avg ${pct(species.avgReturn)}`);
  }

  if (problems.length > 0) {
    console.error("\nsmoke run FAILED:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }

  console.log("\nSmoke run passed: evolution, selection, and paper execution are healthy.");
}

main().catch((error) => {
  console.error("smoke run crashed:", error);
  process.exitCode = 1;
});
