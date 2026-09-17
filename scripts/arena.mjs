#!/usr/bin/env node
/**
 * Champion Arena CLI.
 *
 *   npm run arena                          # registry sweep over .evolve/history
 *   npm run arena -- <dataset-dir>         # one dataset
 *   npm run arena -- <dir1> <dir2> ...     # several datasets
 *   EVOLVE_ARENA_POPULATION=500 EVOLVE_ARENA_WORKERS=8 npm run arena
 *
 * Runs the full tournament funnel over the requested datasets with the real
 * paper replay engine and writes outputs to .evolve/arenas/<arena-id>/.
 *
 * Everything is PAPER ONLY. No real-money execution exists in this repository.
 */

import path from "node:path";
import { access } from "node:fs/promises";

import { parseArgs } from "./make-fixture.mjs";
import { createMarketConfig } from "./market/config.mjs";
import {
  buildDatasetRegistry,
  registrySummary,
  realEvidenceDatasets,
  loadChampionCandidates,
  mergeHallOfFameRecord,
  ensureDir,
  buildRegimeMap,
  DEFAULT_ARENA_DIR,
  DEFAULT_HOF_DIR,
  ARENA_STAGE,
} from "./arena/orchestrator.mjs";
import { buildEntrantPool, runArenaTournament } from "./arena/tournament.mjs";
import { planDatasetWindows } from "./arena/evaluator.mjs";
import { digestOf } from "./lib/hash.mjs";
import { listCompiledCandidates, readMemoryIndex } from "./research/memory.mjs";
import { promoteFromArenaLeaderboard } from "./research/promote.mjs";

const PAPER_NOTICE =
  "PAPER ONLY. Every number is simulated paper accounting over historical observations. Arena results do NOT predict future profitability.";

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function intEnv(value, fallback, { min = 1, max = 1_000_000 } = {}) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = createMarketConfig(
    { ...process.env, EVOLVE_MARKET_MODE: process.env.EVOLVE_MARKET_MODE ?? "synthetic" },
    { loadEnv: true },
  );

  // ---- Dataset selection --------------------------------------------------
  const positional = (args._ ?? []).map(String).filter(Boolean);
  const registry = await buildDatasetRegistry(config.historyRoot ?? ".evolve/history");
  let datasets = [];

  if (positional.length > 0) {
    for (const target of positional) {
      const dir = path.resolve(target);
      if (!(await exists(dir))) {
        console.error(`[arena] dataset not found: ${target}`);
        process.exitCode = 1;
        return;
      }
      const match = registry.find((entry) => path.resolve(entry.dir) === dir);
      datasets.push(
        match ?? {
          datasetId: path.basename(dir),
          dir,
          fingerprint: null,
          sourceType: "REAL",
          usableForRealMarketReplay: true,
        },
      );
    }
  } else {
    datasets = registry;
  }

  if (datasets.length === 0) {
    console.error("[arena] no datasets available. Record one first:  npm run record:market");
    console.error("[arena] or generate a synthetic fixture:            npm run fixture:market");
    process.exitCode = 1;
    return;
  }

  const summary = registrySummary(datasets);
  console.log(`[arena] datasets: ${datasets.length} (real ${summary.real.count}, synthetic ${summary.synthetic.count}, mixed ${summary.mixed.count})`);
  for (const dataset of datasets) {
    console.log(
      `[arena]   ${dataset.datasetId}  ${dataset.sourceType}  ${(dataset.durationMinutes ?? 0).toFixed(1)}min  ${dataset.snapshotCount ?? "?"} snapshots`,
    );
  }
  if (realEvidenceDatasets(datasets).length === 0) {
    console.log("[arena] no genuine live-Solana datasets in this run — Deployment Candidate status is unreachable until at least one real dataset is included.");
  }

  // ---- Entrants -----------------------------------------------------------
  const population = intEnv(process.env.EVOLVE_ARENA_POPULATION, 24, { min: 4, max: 100_000 });
  const workers = intEnv(process.env.EVOLVE_ARENA_WORKERS, 0, { min: 0, max: 64 });
  const generations = intEnv(process.env.EVOLVE_ARENA_GENERATIONS, 1, { min: 1, max: 10_000 });
  const seeds =
    (config.evalSeeds?.length ?? 0) > 0
      ? config.evalSeeds
      : [config.seed ?? "arena", `${config.seed ?? "arena"}-2`];

  const champions = await loadChampionCandidates(config.championsDir ?? ".evolve/champions");
  console.log(`[arena] population=${population} seeds=${seeds.length} champions re-entering=${champions.length} workers=${workers || "auto"} generations=${generations}`);

  const cacheDir = path.join(".evolve", "arena-cache");
  const useCache = args["no-cache"] !== true;
  const maxWindows = args["max-windows"] ? Number(args["max-windows"]) : null;

  // Precompute each window's market regime from its own TEST-interval
  // snapshots (deterministic, no look-ahead) so the tournament can group OOS
  // performance by regime instead of every window reporting "unknown".
  const datasetRefs = [];
  for (const d of datasets) {
    const ref = { dir: d.dir, id: d.datasetId, fingerprint: d.fingerprint, sourceType: d.sourceType, regimesByWindow: {} };
    try {
      const { windows } = await planDatasetWindows(d.dir, config, { maxWindows, allowShort: true });
      const regimeRows = await buildRegimeMap(d.dir, windows);
      ref.regimesByWindow = Object.fromEntries(regimeRows.map((row) => [row.window, row]));
    } catch (error) {
      console.error(`[arena] regime classification failed for ${d.datasetId}: ${error?.message ?? error}`);
    }
    datasetRefs.push(ref);
  }

  let entrants = buildEntrantPool({
    champions,
    population,
    seed: `arena:${[...seeds].join(",")}`,
    championShare: 0.2,
    immigrantShare: 0.15,
  });

  // EVOLVE_ARENA_GENERATIONS > 1: pre-evolve the pool with cheap, single-seed,
  // no-stress screening rounds before the final generation runs the full
  // funnel (stress, OOS, baselines, output). Every round reuses the same
  // paper replay machinery — nothing here is a shortcut around it.
  for (let gen = 1; gen < generations; gen += 1) {
    console.log(`[arena] generation ${gen}/${generations - 1}: pre-evolving population (cheap screen, no stress)`);
    const screen = await runArenaTournament({
      datasets: datasetRefs,
      config,
      entrants,
      seeds: [seeds[0]],
      stressProfiles: [],
      maxWindows: 1,
      workers,
      cacheDir,
      useCache,
      arenaId: null,
      arenasDir: null,
      onProgress: ({ message }) => {
        if (message) console.log(`[arena]   gen${gen}: ${message}`);
      },
    });
    const survivorCount = Math.max(2, Math.ceil(population * 0.3));
    const survivors = screen.summary.leaderboard.slice(0, survivorCount).map((row) => {
      const entrant = entrants.find((e) => (e.digest ?? digestOf(e.genome)) === row.digest);
      return entrant ? { digest: row.digest, genome: entrant.genome, species: entrant.species } : null;
    }).filter(Boolean);
    entrants = buildEntrantPool({
      champions: survivors.length > 0 ? survivors : champions,
      population,
      seed: `arena:gen${gen}:${[...seeds].join(",")}`,
      championShare: 0.35,
      immigrantShare: 0.15,
    });
  }
  // ---- Phase 5A: optional research candidates -----------------------------
  // Off by default: a real arena run's population is a fixed, requested size,
  // and research candidates are additive on top of it, never a silent
  // substitute for the existing champion/evolved/immigrant mix. Matching back
  // to research memory afterward is by genome digest (promote.mjs) — no
  // special-case identity needs to flow through the tournament itself.
  const includeResearch = args.research === true || process.env.EVOLVE_ARENA_INCLUDE_RESEARCH === "1";
  const researchRoot = config.research?.root ?? ".evolve/research";
  if (includeResearch) {
    const compiledCandidates = await listCompiledCandidates(researchRoot);
    for (const candidate of compiledCandidates) {
      if (!candidate?.genome) continue;
      entrants.push({ genome: candidate.genome, species: candidate.species ?? "Experimental", origin: "research", digest: digestOf(candidate.genome) });
    }
    console.log(`[arena] research candidates added: ${compiledCandidates.length} (from ${researchRoot})`);
  }

  console.log(`[arena] entrants: ${entrants.length} (champions ${entrants.filter((e) => e.origin === "champion").length}, evolved ${entrants.filter((e) => e.origin === "evolved").length}, immigrants ${entrants.filter((e) => e.origin === "immigrant").length}, research ${entrants.filter((e) => e.origin === "research").length})`);

  const arenaId = `arena-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
  const stressProfiles = ["mild", "moderate"];

  const result = await runArenaTournament({
    datasets: datasetRefs,
    config,
    entrants,
    seeds,
    stressProfiles,
    maxWindows,
    workers,
    cacheDir,
    useCache,
    arenaId,
    arenasDir: DEFAULT_ARENA_DIR,
    onProgress: ({ message }) => {
      if (message) console.log(`[arena] ${message}`);
    },
  });

  // ---- Phase 5A: promote research memory from this Arena's real result ----
  // The ONLY place a research proposal can reach PROMISING/ARENA_SURVIVOR/
  // SHADOW_ELIGIBLE — never the research cycle itself. Runs unconditionally
  // (cheap no-op when no compiled candidates exist), independent of whether
  // this run's entrants were told to include research candidates, so an
  // operator can promote against an arena run from research candidates added
  // in a previous invocation too.
  try {
    const memoryRecords = await readMemoryIndex(researchRoot, { limit: 2000 });
    const promotion = await promoteFromArenaLeaderboard({
      root: researchRoot,
      leaderboardRows: result.summary.leaderboard,
      memoryRecords,
    });
    if (promotion.promoted.length > 0) {
      console.log(`[arena] research memory promoted: ${promotion.promoted.map((p) => `${p.familyId}->${p.to}`).join(", ")}`);
    }
  } catch (error) {
    console.error(`[arena] research promotion skipped: ${error?.message ?? error}`);
  }

  // ---- Hall of Fame merge -------------------------------------------------
  const hofDir = config.hallOfFameDir ?? DEFAULT_HOF_DIR;
  await ensureDir(hofDir);
  const hofFile = path.join(hofDir, "index.json");
  let hof = { members: [] };
  try {
    hof = JSON.parse(await (await import("node:fs/promises")).readFile(hofFile, "utf8"));
  } catch {
    // first run
  }
  const membersByDigest = new Map((hof.members ?? []).map((m) => [m.digest, m]));
  for (const entrant of entrants) {
    const digest = entrant.digest ?? digestOf(entrant.genome);
    const detail = result.details.get(entrant);
    if (!detail) continue;
    const existing = membersByDigest.get(digest) ?? null;
    // Only interesting genomes enter the Hall of Fame: survivors or high scorers.
    const isInteresting =
      detail.status === "ARENA SURVIVOR" ||
      detail.status === "DEPLOYMENT CANDIDATE" ||
      (detail.arenaScore?.score ?? 0) >= 55;
    if (!isInteresting) continue;
    membersByDigest.set(
      digest,
      mergeHallOfFameRecord(existing, {
        digest,
        genome: entrant.genome,
        species: entrant.species,
        strategyType: detail.strategyType,
        arenaScore: detail.arenaScore.score,
        status: detail.status,
        arenaId,
        at: new Date().toISOString(),
        regimeCoverage: Object.fromEntries(
          Object.entries(detail.regimePerformance ?? {}).map(([k, v]) => [k, v.medianNetReturn]),
        ),
        stressSurvival: Object.fromEntries(
          Object.entries(detail.stressSurvival ?? {}).map(([k, v]) => [k, v.survived]),
        ),
      }),
    );
  }
  hof = {
    ...hof,
    updated: new Date().toISOString(),
    arenaId,
    members: [...membersByDigest.values()].sort((a, b) => (b.bestArenaScore ?? -1) - (a.bestArenaScore ?? -1)),
    note: "Hall of Fame membership is historical interest only. It does NOT imply deployment eligibility, profitability, or safety.",
  };
  await (await import("node:fs/promises")).writeFile(hofFile, `${JSON.stringify(hof, null, 2)}\n`, "utf8");

  // ---- Report -------------------------------------------------------------
  console.log("");
  console.log("=".repeat(72));
  console.log(`CHAMPION ARENA COMPLETE — ${arenaId}`);
  console.log("=".repeat(72));
  console.log(PAPER_NOTICE);
  console.log("");
  console.log("Tournament funnel:");
  for (const [stage, row] of Object.entries(result.summary.funnel)) {
    console.log(`  ${stage.padEnd(16)} ${String(row.entered).padStart(6)} -> ${String(row.survivors).padStart(6)}`);
  }
  console.log("");
  console.log("Top of leaderboard (paper scores, not profit):");
  for (const row of result.summary.leaderboard.slice(0, 8)) {
    console.log(`  ${row.score.toFixed(1).padStart(6)}  ${row.status?.padEnd(22) ?? ""} ${row.species}  ${row.digest.slice(0, 12)}`);
  }
  console.log("");
  console.log(`Deployment candidates: ${result.summary.deploymentCandidates.length}`);
  for (const row of result.summary.deploymentCandidates.slice(0, 8)) {
    console.log(`  ${row.score.toFixed(1).padStart(6)}  ${row.species}  ${row.digest.slice(0, 12)}`);
  }
  console.log("");
  console.log(`Diversity: unique ${(result.summary.diversity.uniqueGenomes / Math.max(1, result.summary.diversity.populationSize) * 100).toFixed(0)}% · lineage concentration ${result.summary.diversity.lineageConcentration.toFixed(2)} · verdict: ${result.summary.diversityVerdict.action}`);
  console.log(`Adaptive mutation: ${result.summary.adaptiveMutation.previousScale.toFixed(3)} -> ${result.summary.adaptiveMutation.scale.toFixed(3)} (${result.summary.adaptiveMutation.reason})`);
  console.log("");
  console.log(`Real-market evidence: ${summary.real.count} dataset(s), ${summary.real.realDataHours.toFixed(1)}h · synthetic evidence: ${summary.synthetic.count} dataset(s), ${summary.synthetic.syntheticDataHours.toFixed(1)}h (never counted as real)`);
  console.log(`Hall of Fame members: ${hof.members.length} (interest only, not deployment eligibility)`);
  console.log(`Outputs: ${path.join(DEFAULT_ARENA_DIR, arenaId)}`);
  console.log("");
  console.log(`Stages: ${Object.values(ARENA_STAGE).join(" -> ")}`);
}

main().catch((error) => {
  console.error("[arena] failed:", error?.message ?? error);
  if (process.env.EVOLVE_DEBUG === "1") console.error(error);
  process.exitCode = 1;
});
