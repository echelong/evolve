#!/usr/bin/env node
/**
 * Arena smoke run — small, deterministic, fully offline.
 *
 *   npm run smoke:arena
 *
 * Demonstrates the complete funnel
 *   qualification -> groups -> stress -> unseen evaluation -> champion selection
 * using two synthetic fixture datasets, 24 entrants, 2 seeds, and 2 stress
 * profiles. Also verifies: identical results without workers, identical results
 * on the second run (cache), and that a champion re-entering can be eliminated.
 *
 * Everything is PAPER ONLY.
 */

import path from "node:path";
import { rm } from "node:fs/promises";

import { makeFixture } from "./make-fixture.mjs";
import { createMarketConfig } from "./market/config.mjs";
import { buildDatasetRegistry, registrySummary, digestOf } from "./arena/orchestrator.mjs";
import { buildEntrantPool, runArenaTournament } from "./arena/tournament.mjs";

const START = Date.UTC(2026, 8, 17, 12, 0, 0);

function assert(condition, label) {
  if (!condition) {
    console.error(`  ✗ ${label}`);
    failures += 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
}
let failures = 0;

async function main() {
  const rootConfig = createMarketConfig(
    {
      EVOLVE_MARKET_MODE: "synthetic",
      EVOLVE_WF_TRAIN_MINUTES: "10",
      EVOLVE_WF_VALIDATE_MINUTES: "5",
      EVOLVE_WF_TEST_MINUTES: "5",
      EVOLVE_WF_STEP_MINUTES: "5",
      EVOLVE_MIN_TRADES: "2",
      EVOLVE_MIN_DISTINCT_MINTS: "1",
      EVOLVE_MIN_OBSERVATIONS: "10",
      EVOLVE_MIN_EXPOSURE_TICKS: "5",
      EVOLVE_SYNTHETIC_UNIVERSE: "12",
    },
    { loadEnv: false },
  );

  const tmpRoot = path.join(".evolve", "history", "smoke-arena");
  await rm(tmpRoot, { recursive: true, force: true });

  const dirA = path.join(tmpRoot, "fixture-a");
  const dirB = path.join(tmpRoot, "fixture-b");
  console.log("[smoke] building synthetic fixture datasets (offline)...");
  await makeFixture({ dir: dirA, snapshots: 40, intervalMs: 60_000, seed: "smoke-arena-a", tokenCount: 12, startAt: START });
  await makeFixture({ dir: dirB, snapshots: 40, intervalMs: 60_000, seed: "smoke-arena-b", tokenCount: 12, startAt: START + 3_600_000 });
  console.log("[smoke] fixtures ready");

  const registry = await buildDatasetRegistry(tmpRoot);
  assert(registry.length === 2, `registry lists 2 fixtures (got ${registry.length})`);
  const summary = registrySummary(registry);
  assert(summary.real.count === 0 && summary.synthetic.count === 2, "synthetic fixtures not counted as real evidence");

  const datasets = registry.map((entry) => ({
    dir: entry.dir,
    id: entry.datasetId,
    fingerprint: entry.fingerprint,
    sourceType: entry.sourceType,
  }));

  const champions = []; // first run: no champions yet
  const pool1 = buildEntrantPool({ champions, population: 24, seed: "smoke:1" });
  assert(pool1.length === 24, `entrant pool has 24 genomes (got ${pool1.length})`);

  const cacheDir = path.join(".evolve", "arena-cache-smoke");

  const tournamentConfig = {
    ...rootConfig,
    arena: { gates: { minTrades: 2, minDistinctMints: 1, minRealDatasets: 0, minOosWindows: 2, minSeeds: 2, minStressSurvived: 1, maxDrawdown: 0.95, maxTopMintShare: 1, minArenaScore: 0, requireNoCatastrophic: false, requireMildStressSurvival: false } },
  };

  console.log("[smoke] running arena (inline, run 1, cold cache)...");
  const run1 = await runArenaTournament({
    datasets,
    config: tournamentConfig,
    entrants: pool1,
    seeds: ["s1", "s2"],
    stressProfiles: ["mild", "moderate"],
    maxWindows: 2,
    workers: 0,
    cacheDir,
    useCache: true,
    arenaId: null,
    arenasDir: null,
  });

  assert(run1.summary.funnel.QUALIFICATION.entered === 24, "qualification entered 24");
  assert(run1.summary.funnel.QUALIFICATION.survivors > 0, "qualification produced survivors");
  assert(run1.summary.funnel.GROUP.survivors <= run1.summary.funnel.QUALIFICATION.survivors, "group stage narrows the field");
  assert(run1.summary.leaderboard.length > 0, "leaderboard produced");
  assert(run1.summary.baselines.length === datasets.length, "baselines ran per dataset");
  assert(Number.isFinite(run1.summary.diversity.genomeDiversity), "diversity metrics finite");

  const finiteScores = [...run1.scored.values()].every((score) => Number.isFinite(score));
  assert(finiteScores, "all arena scores finite");

  console.log("[smoke] running arena again (warm cache)...");
  const run2 = await runArenaTournament({
    datasets,
    config: tournamentConfig,
    entrants: pool1,
    seeds: ["s1", "s2"],
    stressProfiles: ["mild", "moderate"],
    maxWindows: 2,
    workers: 0,
    cacheDir,
    useCache: true,
    arenaId: null,
    arenasDir: null,
  });

  const scores1 = pool1.map((e) => run1.scored.get(e)).map((s) => Math.round(s * 1000));
  const scores2 = pool1.map((e) => run2.scored.get(e)).map((s) => Math.round(s * 1000));
  assert(JSON.stringify(scores1) === JSON.stringify(scores2), "warm cache reproduces identical scores");

  console.log("[smoke] running arena with workers...");
  const run3 = await runArenaTournament({
    datasets,
    config: tournamentConfig,
    entrants: pool1,
    seeds: ["s1", "s2"],
    stressProfiles: ["mild", "moderate"],
    maxWindows: 2,
    workers: 2,
    cacheDir,
    useCache: false,
    arenaId: null,
    arenasDir: null,
  });

  const scores3 = pool1.map((e) => run3.scored.get(e)).map((s) => Math.round(s * 1000));
  assert(JSON.stringify(scores1) === JSON.stringify(scores3), "worker count does not alter results");

  console.log("[smoke] champion re-entry + possible elimination...");
  // Take the top scorer as a "champion" and re-run with it re-entering against
  // a fresh field; the champion must participate and may lose status.
  const topDigest = run1.summary.leaderboard[0]?.digest;
  assert(typeof topDigest === "string", "leaderboard exposes a digest");

  const championEntrant = pool1.find((e) => (e.digest ?? digestOf(e.genome)) === topDigest);
  const pool2 = buildEntrantPool({
    champions: [
      {
        digest: topDigest,
        genome: championEntrant.genome,
        species: championEntrant.species,
        arenaAppearances: 1,
        titleDefenses: 1,
        bestArenaScore: run1.scored.get(championEntrant),
        latestArenaScore: run1.scored.get(championEntrant),
      },
    ],
    population: 24,
    seed: "smoke:2",
  });
  assert(pool2.some((e) => (e.digest ?? digestOf(e.genome)) === topDigest), "previous champion re-enters the arena");

  const run4 = await runArenaTournament({
    datasets,
    config: tournamentConfig,
    entrants: pool2,
    seeds: ["s1", "s2"],
    stressProfiles: ["mild", "moderate"],
    maxWindows: 2,
    workers: 0,
    cacheDir,
    useCache: true,
    arenaId: null,
    arenasDir: null,
  });
  assert(run4.summary.funnel.QUALIFICATION.entered === 24, "re-entry run has a full field");
  const champInPool2 = pool2.find((e) => (e.digest ?? digestOf(e.genome)) === topDigest);
  const champStatus = run4.statuses.get(champInPool2)?.status ?? null;
  assert(champStatus !== null, "re-entered champion receives a status (can win or be eliminated)");

  await rm(tmpRoot, { recursive: true, force: true });
  await rm(cacheDir, { recursive: true, force: true });

  console.log("");
  if (failures > 0) {
    console.error(`[smoke] arena smoke FAILED with ${failures} assertion(s).`);
    process.exitCode = 1;
  } else {
    console.log("[smoke] arena smoke passed: qualification -> groups -> stress -> OOS -> champion selection (PAPER ONLY).");
  }
}

main().catch((error) => {
  console.error("[smoke] arena smoke crashed:", error?.message ?? error);
  process.exitCode = 1;
});
