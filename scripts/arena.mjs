#!/usr/bin/env node
/**
 * Champion Arena CLI.
 *
 *   npm run arena                              # registry sweep over .evolve/history
 *   npm run arena -- <dataset-dir>             # one dataset
 *   npm run arena -- <dir1> <dir2> ...         # several datasets
 *   npm run arena -- --research <dataset-dir>    # include the persisted research cohort
 *   npm run arena -- --research-mode fair <dir>  # equal-treatment cohort comparison
 *   npm run arena -- --research-mode ab <dir>    # matched research-vs-conventional A/B
 *
 * Runs the full tournament funnel over the requested datasets with the real
 * paper replay engine and writes outputs to .evolve/arenas/<arena-id>/.
 *
 * Everything is PAPER ONLY. No real-money execution exists in this repository.
 *
 * Research modes (Phase 5A.3 keeps all three separate):
 *   challenger  can fresh research challengers beat mature incumbents?
 *   fair        what happens when research ancestry participates under equal
 *               evolutionary rules in one mixed cohort?
 *   ab          does research-guided INITIALIZATION beat a MATCHED conventional
 *               control that receives identical resources, identical
 *               evolutionary rules, identical datasets/windows/seeds/stress,
 *               identical scoring and identical gates?
 *
 * A/B mode is matched by construction: both cohorts get the same number of
 * starting slots, and a shortfall shrinks BOTH cohorts symmetrically. A
genome is never cloned to fill a cohort, and cross-cohort crossover is disabled.

 * Phase 5A.2 notes:
 *   - `--research` is a BOOLEAN flag: `--research DATASET`, `DATASET --research`,
 *     and `--research=true DATASET` all mean the same thing and all leave the
 *     dataset positional (see lib/args.mjs). The old parser consumed the dataset
 *     as the flag's value, which silently ran a registry sweep over everything.
 *   - the research cohort is de-duplicated by genome digest before it consumes
 *     an Arena slot, and `researchSummary` reports uniqueness, species
 *     concentration, provenance, and role-level metrics.
 */

import path from "node:path";
import { access, readFile, writeFile } from "node:fs/promises";

import { parseArgs } from "./lib/args.mjs";
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
import { buildEntrantPool, buildSpeciesPreservingPool, runArenaTournament } from "./arena/tournament.mjs";
import { planDatasetWindows } from "./arena/evaluator.mjs";
import { digestOf } from "./lib/hash.mjs";
import {
  listCompiledCandidates,
  listProposals,
  readMemoryIndex,
  readResearchMemorySummary,
  roleResearchMetrics,
} from "./research/memory.mjs";
import { promoteFromArenaLeaderboard } from "./research/promote.mjs";
import {
  RESEARCH_COHORT_DEFAULTS,
  cohortUniquenessVerdict,
  ratioEnv,
  speciesConcentrationVerdict,
  speciesDistribution,
} from "./research/cohort.mjs";
import {
  RESEARCH_ARENA_MODE,
  buildResearchCohort,
  composeFairCohort,
  researchEntrantsFromCohort,
} from "./arena/research-cohort.mjs";
import {
  AB_COHORT,
  AB_DEFAULTS,
  buildMatchedAbCohort,
  describeAbCohorts,
  describeSpeciesCounts,
  enforceSpeciesMatchInvariant,
  planSpeciesMatchedCohort,
  scaleSpeciesCounts,
  speciesCountsOf,
  speciesMatchRequested,
} from "./research/ab-cohort.mjs";
import { ADVISORY_ROLES, PROPOSING_ROLES } from "./research/provider.mjs";
import { readResearchExperiment, researchExperimentSummary } from "./research/experiment.mjs";

const PAPER_NOTICE =
  "PAPER ONLY. Every number is simulated paper accounting over historical observations. Arena results do NOT predict future profitability.";

/** Boolean-only flags. Everything else takes a value when one follows. */
const BOOLEAN_FLAGS = ["research", "no-cache", "strict-research-uniqueness"];
const VALUE_FLAGS = ["research-mode", "max-windows"];

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** Compact display helper for the console report (never prints NaN). */
function fmt(value) {
  if (!Number.isFinite(value)) return "n/a";
  return String(Math.round(value * 1000) / 1000);
}

function intEnv(value, fallback, { min = 1, max = 1_000_000 } = {}) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * One pre-evolution round: a cheap, single-seed, no-stress screen whose top
 * scorers seed the next round's pool. Identical for challenger and fair mode —
 * that equality is the whole point of fair mode.
 */
async function preEvolve({
  entrants,
  rounds,
  population,
  seeds,
  datasetRefs,
  config,
  workers,
  cacheDir,
  useCache,
  label = "challenger",
}) {
  let pool = entrants;
  for (let gen = 1; gen < rounds; gen += 1) {
    console.log(`[arena] ${label} generation ${gen}/${rounds - 1}: pre-evolving population (cheap screen, no stress)`);
    const screen = await runArenaTournament({
      datasets: datasetRefs,
      config,
      entrants: pool,
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
    const survivorCount = Math.max(2, Math.ceil(pool.length * 0.3));
    const survivors = screen.summary.leaderboard.slice(0, survivorCount).map((row) => {
      const entrant = pool.find((e) => (e.digest ?? digestOf(e.genome)) === row.digest);
      return entrant
        ? {
            digest: row.digest,
            genome: entrant.genome,
            species: entrant.species,
            origin: entrant.origin,
            ...(entrant.research ? { research: entrant.research } : {}),
            ...(entrant.researchAncestry ? { researchAncestry: entrant.researchAncestry } : {}),
          }
        : null;
    }).filter(Boolean);
    pool = buildEntrantPool({
      champions: survivors.length > 0 ? survivors : pool,
      population,
      seed: `arena:${label}:gen${gen}:${[...seeds].join(",")}`,
      championShare: 0.35,
      immigrantShare: 0.15,
    });
  }
  return pool;
}

/**
 * Phase 5A.3: pre-evolve ONE cohort in complete isolation.
 *
 * Identical in every respect to `preEvolve` — same survivor fraction, same
 * breeder share, same mutation scale, same immigrant treatment, same number of
 * rounds — except that it only ever sees its own cohort's genomes, which is
 * how cross-cohort crossover is disabled for the benchmark. Both cohorts call
 * this with the same arguments (only the RNG seed label differs, so the two
 * cohorts are not forced to draw the same random numbers).
 */
async function preEvolveCohort({
  entrants,
  rounds,
  population,
  seeds,
  datasetRefs,
  config,
  workers,
  cacheDir,
  useCache,
  label,
  // Phase 5A.3.1: when supplied (strict species-matched A/B), every generation
  // is rebuilt at EXACTLY these per-species quotas using
  // `buildSpeciesPreservingPool`, so the species distribution cannot drift.
  // Both cohorts receive the same quotas and the same resources.
  speciesMatch = null,
}) {
  let pool = entrants;
  const survivorFraction = 0.3;
  const championShare = 0.35;
  const immigrantShare = 0.15;
  const quotas = speciesMatch?.quotas ?? null;

  // Descendant expansion (opt-in): grow the starting seed cohort to its target
  // size using the ordinary entrant-pool builder. This is evolution, not
  // cloning — ancestry is preserved — and it is applied identically to both
  // cohorts. Under strict species matching the expansion is quota-preserving
  // too, so the expanded cohorts stay species-identical.
  if (population !== pool.length) {
    console.log(`[arena] ab: ${label} expanding ${pool.length} seed genome(s) -> ${population} via ordinary ${quotas ? "species-preserving " : ""}entrant-pool breeding`);
    pool = quotas
      ? buildSpeciesPreservingPool({
          champions: pool,
          members: pool,
          quotas,
          seed: `arena:ab:${label}:expand:${[...seeds].join(",")}`,
          championShare,
          immigrantShare,
          cohort: label,
        })
      : buildEntrantPool({
          champions: pool,
          population,
          seed: `arena:ab:${label}:expand:${[...seeds].join(",")}`,
          championShare,
          immigrantShare,
          cohort: label,
        });
  }

  for (let gen = 1; gen < rounds; gen += 1) {
    console.log(`[arena] ab: ${label} generation ${gen}/${rounds - 1}: pre-evolving cohort (cheap screen, no stress)`);
    const screen = await runArenaTournament({
      datasets: datasetRefs,
      config,
      entrants: pool,
      seeds: [seeds[0]],
      stressProfiles: [],
      maxWindows: 1,
      workers,
      cacheDir,
      useCache,
      arenaId: null,
      arenasDir: null,
      onProgress: ({ message }) => {
        if (message) console.log(`[arena]   ${label} gen${gen}: ${message}`);
      },
    });
    const survivorCount = Math.max(2, Math.ceil(pool.length * survivorFraction));
    const survivors = screen.summary.leaderboard
      .slice(0, survivorCount)
      .map((row) => {
        const entrant = pool.find((e) => (e.digest ?? digestOf(e.genome)) === row.digest);
        return entrant
          ? {
              digest: row.digest,
              genome: entrant.genome,
              species: entrant.species,
              origin: entrant.origin,
              ...(entrant.cohort ? { cohort: entrant.cohort } : {}),
              ...(entrant.lineage ? { lineage: entrant.lineage } : {}),
              ...(entrant.lineageId ? { lineageId: entrant.lineageId } : {}),
              ...(entrant.research ? { research: entrant.research } : {}),
              ...(entrant.researchAncestry ? { researchAncestry: entrant.researchAncestry } : {}),
            }
          : null;
      })
      .filter(Boolean);
    const breeders = survivors.length > 0 ? survivors : pool;
    if (quotas) {
      // Strict species matching: rebuild the cohort at the same per-species
      // quotas. A species whose members all lost this screen falls back to its
      // own previous members (quota preservation), never to another species.
      pool = buildSpeciesPreservingPool({
        champions: breeders,
        members: pool,
        quotas,
        seed: `arena:ab:${label}:gen${gen}:${[...seeds].join(",")}`,
        championShare,
        immigrantShare,
        cohort: label,
      });
    } else {
      // Breeders are drawn only from THIS cohort's own survivors.
      pool = buildEntrantPool({
        champions: breeders,
        population,
        seed: `arena:ab:${label}:gen${gen}:${[...seeds].join(",")}`,
        championShare,
        immigrantShare,
        cohort: label,
      });
    }
  }
  return pool;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { booleanFlags: BOOLEAN_FLAGS, valueFlags: VALUE_FLAGS });
  const config = createMarketConfig(
    { ...process.env, EVOLVE_MARKET_MODE: process.env.EVOLVE_MARKET_MODE ?? "synthetic" },
    { loadEnv: true },
  );

  // ---- Dataset selection --------------------------------------------------
  // A positional dataset is ALWAYS positional: `--research` is boolean, so it
  // can never swallow the dataset that follows it.
  const positional = (args._ ?? []).map(String).filter(Boolean);
  const registry = await buildDatasetRegistry(config.historyRoot ?? ".evolve/history");
  let datasets = [];

  if (positional.length > 0) {
    for (const target of positional) {
      const dir = path.resolve(target);
      if (!(await exists(dir))) {
        console.error(`[arena] dataset not found: ${target}`);
        console.error(`[arena] requested ${positional.length} dataset(s): ${positional.join(", ")}`);
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

  if (positional.length > 0 && datasets.length !== positional.length) {
    console.error(`[arena] dataset selection mismatch: ${positional.length} requested, ${datasets.length} selected`);
    process.exitCode = 1;
    return;
  }

  const summary = registrySummary(datasets);
  console.log(`[arena] datasets selected: ${datasets.length} (real ${summary.real.count}, synthetic ${summary.synthetic.count}, mixed ${summary.mixed.count})`);
  for (const dataset of datasets) {
    console.log(
      `[arena]   ${dataset.datasetId}  ${dataset.sourceType}  ${(dataset.durationMinutes ?? 0).toFixed(1)}min  ${dataset.snapshotCount ?? "?"} snapshots`,
    );
  }
  if (realEvidenceDatasets(datasets).length === 0) {
    console.log("[arena] no genuine live-Solana datasets in this run — Deployment Candidate status is unreachable until at least one real dataset is included.");
  }

  // ---- Configuration ------------------------------------------------------
  const population = intEnv(process.env.EVOLVE_ARENA_POPULATION, 24, { min: 4, max: 100_000 });
  const workers = intEnv(process.env.EVOLVE_ARENA_WORKERS, 0, { min: 0, max: 64 });
  const generations = intEnv(process.env.EVOLVE_ARENA_GENERATIONS, 1, { min: 1, max: 10_000 });
  const seeds =
    (config.evalSeeds?.length ?? 0) > 0
      ? config.evalSeeds
      : [config.seed ?? "arena", `${config.seed ?? "arena"}-2`];

  const researchRoot = config.research?.root ?? ".evolve/research";
  const requestedMode = args["research-mode"] != null ? String(args["research-mode"]).toLowerCase() : null;
  if (requestedMode && !Object.values(RESEARCH_ARENA_MODE).includes(requestedMode)) {
    console.error(
      `[arena] invalid --research-mode '${requestedMode}'. Expected one of: ${Object.values(RESEARCH_ARENA_MODE).join(", ")}`,
    );
    process.exitCode = 1;
    return;
  }
  const researchMode =
    requestedMode ??
    (process.env.EVOLVE_ARENA_RESEARCH_MODE
      ? String(process.env.EVOLVE_ARENA_RESEARCH_MODE).toLowerCase()
      : RESEARCH_ARENA_MODE.CHALLENGER);
  const includeResearch =
    args.research === true ||
    process.env.EVOLVE_ARENA_INCLUDE_RESEARCH === "1" ||
    requestedMode !== null ||
    Boolean(process.env.EVOLVE_ARENA_RESEARCH_MODE);

  const minUniqueRatio = ratioEnv(
    process.env.EVOLVE_RESEARCH_MIN_UNIQUE_RATIO,
    RESEARCH_COHORT_DEFAULTS.minUniqueRatio,
  );
  const maxSpeciesShare = ratioEnv(
    process.env.EVOLVE_RESEARCH_MAX_SPECIES_SHARE,
    RESEARCH_COHORT_DEFAULTS.maxSpeciesShare,
  );
  const strictUniqueness =
    args["strict-research-uniqueness"] === true || process.env.EVOLVE_RESEARCH_STRICT_UNIQUENESS === "1";
  // Phase 5A.3 A/B knobs. Descendant expansion is opt-in: by default a matched
  // cohort is exactly as large as the smaller side's unique seed count.
  const abExpandDescendants = process.env.EVOLVE_ARENA_AB_EXPAND === "1";
  const abSpeciesMatched = speciesMatchRequested(process.env);
  const abBootstrapIterations = intEnv(
    process.env.EVOLVE_ARENA_AB_BOOTSTRAP_ITERATIONS,
    AB_DEFAULTS.bootstrapIterations,
    { min: 0, max: 200_000 },
  );
  const abBootstrapSeed = process.env.EVOLVE_ARENA_AB_BOOTSTRAP_SEED ?? AB_DEFAULTS.bootstrapSeed;

  const champions = await loadChampionCandidates(config.championsDir ?? ".evolve/champions");
  console.log(`[arena] requested arena population: ${population}`);
  console.log(`[arena] research enabled: ${includeResearch} (mode=${includeResearch ? researchMode : "none"})`);
  console.log(
    `[arena] guards: min unique ratio ${minUniqueRatio.toFixed(2)}${strictUniqueness ? " (strict)" : ""}, max species share ${maxSpeciesShare.toFixed(2)}`,
  );
  console.log(`[arena] seeds=${seeds.length} champions re-entering=${champions.length} workers=${workers || "auto"} generations=${generations}`);

  const cacheDir = path.join(".evolve", "arena-cache");
  // Phase 5C: the replication runner keeps its per-dataset arenas inside its own
  // run directory (`EVOLVE_ARENA_DIR`), so the shared `.evolve/arenas` registry
  // is never polluted with replication output. Default behavior is unchanged.
  const arenasDir = process.env.EVOLVE_ARENA_DIR ?? DEFAULT_ARENA_DIR;
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

  // ---- Phase 5A.2: the research cohort ------------------------------------
  let researchCohort = null;
  let researchEntrants = [];
  if (includeResearch) {
    researchCohort = await buildResearchCohort(researchRoot);
    const uniqueness = cohortUniquenessVerdict({
      uniqueDigests: researchCohort.uniqueCompiledGenomes,
      acceptedEntrants: researchCohort.compiledArtifacts,
      minUniqueRatio,
      strict: strictUniqueness,
    });
    if (!uniqueness.ok) {
      const line = `[arena] RESEARCH COHORT WARNING: ${uniqueness.warning} (${uniqueness.code})`;
      if (strictUniqueness) {
        console.error(line);
        console.error("[arena] strict uniqueness is enabled — refusing to run with a degraded research cohort.");
        process.exitCode = 1;
        return;
      }
      console.warn(line);
    }
    const concentration = speciesConcentrationVerdict({
      entries: researchCohort.unique,
      total: researchCohort.uniqueCompiledGenomes,
      maxSpeciesShare,
    });
    if (!concentration.ok) {
      console.warn(`[arena] RESEARCH CONCENTRATION WARNING: ${concentration.warning}`);
    }
    researchEntrants = researchEntrantsFromCohort(researchCohort.unique);
    console.log(
      `[arena] research candidates discovered: ${researchCohort.compiledArtifacts} compiled artifacts -> ${researchCohort.uniqueCompiledGenomes} unique genomes (${researchCohort.duplicateCompiledGenomes} duplicate digest(s) excluded)`,
    );
    console.log(
      `[arena] research cohort: proposals=${researchCohort.proposalsAvailable} species=${JSON.stringify(speciesDistribution(researchCohort.unique))} uniqueRatio=${uniqueness.ratio.toFixed(3)}`,
    );
  }

  // ---- Conventional pool + cohort assembly --------------------------------
  const conventionalPool = buildEntrantPool({
    champions,
    population,
    seed: `arena:${[...seeds].join(",")}`,
    championShare: 0.2,
    immigrantShare: 0.15,
  });

  let entrants;
  let researchAccounting = null;
  let abContext = null;

  if (includeResearch && researchMode === RESEARCH_ARENA_MODE.AB) {
    // ---- Phase 5A.3: matched research-vs-conventional A/B cohort ----------
    const shareRaw =
      process.env.EVOLVE_ARENA_RESEARCH_SHARE != null
        ? Number(process.env.EVOLVE_ARENA_RESEARCH_SHARE)
        : AB_DEFAULTS.researchShare;
    const abShare = Number.isFinite(shareRaw) ? Math.min(1, Math.max(0, shareRaw)) : AB_DEFAULTS.researchShare;
    const requestedPerCohort = Math.max(
      0,
      Math.min(Math.round(population * abShare), Math.round(population * (1 - abShare))),
    );
    // Conventional control construction. Default: the ordinary Arena entrant
    // pool (archived champions re-entering, mutated/crossover children, random
    // species immigrants). STRICT species-matched mode instead builds fresh
    // standard species/genome controls whose species counts equal the Research
    // cohort's EXACTLY, and then evolves BOTH cohorts species-preserving so the
    // distribution cannot drift before the formal freeze.
    let conventionalSeeds;
    let speciesPlan = null;
    if (abSpeciesMatched) {
      // ---- Phase 5A.3.1: strict species matching --------------------------
      // The reference distribution is the Research cohort AS NATURALLY
      // PRODUCED by the research pipeline. It is never reshaped to look nicer,
      // never sorted by performance, and never substituted.
      console.log("[arena] A/B species-match requested: true");
      speciesPlan = planSpeciesMatchedCohort({
        researchSeeds: researchEntrants,
        requestedPerCohort,
        seed: `arena:ab:${[...seeds].join(",")}`,
      });
      if (!speciesPlan.ok) {
        console.error(`[arena] A/B SPECIES-MATCH FAILED: ${speciesPlan.error}`);
        console.error(
          "[arena] a species-matched control was requested, so this run refuses to build an unmatched A/B baseline. No genome is cloned and no species is substituted.",
        );
        process.exitCode = 1;
        return;
      }
      console.log(
        `[arena] A/B species-match reference (research cohort as produced): ${describeSpeciesCounts(speciesPlan.requestedCounts)}`,
      );
      console.log(
        `[arena] A/B species-match conventional controls: ${describeSpeciesCounts(speciesCountsOf(speciesPlan.conventional))} (${speciesPlan.conventional.length} fresh species/genome seed(s))`,
      );
      if (speciesPlan.symmetricShrink) {
        console.warn(
          `[arena] A/B SPECIES-MATCH SHORTAGE: ${describeSpeciesCounts(speciesPlan.shortfall)} could not be produced as unique controls — BOTH cohorts were shrunk symmetrically to ${describeSpeciesCounts(speciesPlan.counts)} (never cloned, never substituted).`,
        );
      }
      conventionalSeeds = speciesPlan.conventional;
    } else {
      conventionalSeeds = buildEntrantPool({
        champions,
        population: Math.max(1, requestedPerCohort),
        seed: `arena:ab:conventional:${[...seeds].join(",")}`,
        championShare: 0.2,
        immigrantShare: 0.15,
      });
    }

    const abBuilt = buildMatchedAbCohort({
      requestedPopulation: population,
      researchShare: abShare,
      // Strict mode feeds the identical (deduped, species-trimmed) reference
      // list that the controls were generated from, so both arms carry the same
      // per-species counts into evolution.
      researchSeeds: speciesPlan ? speciesPlan.research : researchEntrants,
      conventionalSeeds,
      expandDescendants: abExpandDescendants,
    });
    if (!abBuilt.ok) {
      console.error(`[arena] A/B MODE FAILED: ${abBuilt.error}`);
      console.error(
        "[arena] A/B mode refuses to run an unmatched population: a matched cohort needs at least one unique research seed and one unique conventional seed, and nothing is cloned to work around a shortage.",
      );
      process.exitCode = 1;
      return;
    }

    const account = abBuilt.accounting;
    console.log(`[arena] A/B cohorts: ${describeAbCohorts(account)} (requested ${account.requestedPerCohort} per cohort)`);
    console.log(
      `[arena] A/B unique seeds: research ${account.uniqueResearchSeeds} (${account.seedDuplicatesRejected.research} duplicate digest(s) rejected) conventional ${account.uniqueConventionalSeeds} (${account.seedDuplicatesRejected.conventional} duplicate digest(s) rejected)`,
    );
    if (account.downgraded) {
      console.warn(
        `[arena] A/B SHORTAGE: matched cohort downgraded to ${account.matchedPerCohort} per cohort. ${account.shortageReason}`,
      );
      console.warn("[arena] A/B shortage handling: BOTH cohorts were reduced symmetrically — never 42 vs 158, and never by cloning.");
    }
    if (account.expandDescendants) {
      console.log(
        `[arena] A/B descendant expansion ON: each cohort evolves from ${account.matchedPerCohort} matched seed(s) to ${account.targetPerCohort} entrant(s) under identical rules (ancestry preserved).`,
      );
    }
    console.log(
      `[arena] A/B parity: identical datasets, seeds, windows, stress profiles, scoring, gates, generations (${generations}), survivor/breeder/mutation/crossover rules; cross-cohort crossover DISABLED; no cohort bonus.`,
    );

    const perCohortTarget = account.targetPerCohort;
    // Strict species matching: the same per-species quotas drive BOTH cohorts'
    // evolution (identical resources per species in each arm).
    const speciesQuotas = speciesPlan ? scaleSpeciesCounts(speciesPlan.counts, perCohortTarget) : null;
    const speciesMatchConfig = speciesQuotas ? { quotas: speciesQuotas } : null;
    let researchPool = abBuilt.research;
    let conventionalPoolAb = abBuilt.conventional;
    if (generations > 1 || perCohortTarget !== researchPool.length) {
      // Each cohort is pre-evolved in complete isolation: research breeds only
      // with research, conventional only with conventional.
      researchPool = await preEvolveCohort({
        entrants: researchPool,
        rounds: generations,
        population: perCohortTarget,
        seeds,
        datasetRefs,
        config,
        workers,
        cacheDir,
        useCache,
        label: AB_COHORT.RESEARCH,
        speciesMatch: speciesMatchConfig,
      });
      conventionalPoolAb = await preEvolveCohort({
        entrants: conventionalPoolAb,
        rounds: generations,
        population: perCohortTarget,
        seeds,
        datasetRefs,
        config,
        workers,
        cacheDir,
        useCache,
        label: AB_COHORT.CONVENTIONAL,
        speciesMatch: speciesMatchConfig,
      });
    }
    entrants = [...researchPool, ...conventionalPoolAb];
    console.log(
      `[arena] A/B final pools: research=${researchPool.length} conventional=${conventionalPoolAb.length} total=${entrants.length}`,
    );

    // ---- Phase 5A.3.1: strict species-match invariant -----------------------
    // Checked at the FORMAL EVALUATION FREEZE, immediately before the shared
    // tournament. On failure the run stops here: no evaluation, no artifact, and
    // never a species-matched claim.
    let speciesMatchRecord = null;
    if (speciesMatchConfig) {
      const freeze = enforceSpeciesMatchInvariant({
        research: researchPool,
        conventional: conventionalPoolAb,
        expectedCounts: speciesQuotas,
        requested: true,
      });
      console.log(`[arena] A/B species counts at freeze — research: ${describeSpeciesCounts(freeze.researchCounts)}`);
      console.log(`[arena] A/B species counts at freeze — conventional: ${describeSpeciesCounts(freeze.conventionalCounts)}`);
      console.log(`[arena] A/B species quotas: ${describeSpeciesCounts(speciesQuotas)}`);
      if (!freeze.ok) {
        console.error(`[arena] species match invariant: FAIL — ${freeze.reason}`);
        console.error(
          "[arena] refusing to evaluate: this run would NOT be a valid species-controlled A/B baseline. Nothing is cloned, no species is substituted, and no approval is implied.",
        );
        process.exitCode = 1;
        return;
      }
      console.log("[arena] species match invariant: PASS");
      speciesMatchRecord = {
        requested: true,
        matched: true,
        referenceCounts: speciesPlan.requestedCounts,
        conventionalControlCounts: speciesCountsOf(speciesPlan.conventional),
        quotas: speciesQuotas,
        researchCounts: freeze.researchCounts,
        conventionalCounts: freeze.conventionalCounts,
        shortfall: speciesPlan.shortfall,
        symmetricShrink: speciesPlan.symmetricShrink,
        noCloning: true,
        substitutedSpecies: 0,
        enforcement: "independent per-species sub-cohorts, equal quotas/resources in both arms",
      };
    }

    researchAccounting = {
      mode: RESEARCH_ARENA_MODE.AB,
      ...account,
      speciesMatch: speciesMatchRecord,
      requestedMatchMode: abSpeciesMatched ? "species-matched" : "unmatched",
      effectiveMatchMode: speciesMatchRecord ? "species-matched" : "unmatched",
    };
    abContext = {
      accounting: researchAccounting,
      perCohortTarget,
      speciesMatched: abSpeciesMatched,
      speciesMatch: speciesMatchRecord,
    };
  } else if (includeResearch && researchMode === RESEARCH_ARENA_MODE.FAIR) {
    // FAIR COHORT: one mixed cohort, identical pre-evolution for every lineage.
    const shareOverride =
      process.env.EVOLVE_ARENA_RESEARCH_SHARE != null
        ? Number(process.env.EVOLVE_ARENA_RESEARCH_SHARE)
        : process.env.EVOLVE_ARENA_RESEARCH_COUNT != null
          ? Number(process.env.EVOLVE_ARENA_RESEARCH_COUNT) / Math.max(1, population)
          : 0.5;
    const composed = composeFairCohort({
      population,
      researchEntrants,
      conventionalEntrants: conventionalPool,
      researchShare: Number.isFinite(shareOverride) ? shareOverride : 0.5,
    });
    entrants = composed.entrants;
    researchAccounting = { mode: RESEARCH_ARENA_MODE.FAIR, ...composed.accounting };
    if (researchAccounting.researchShortage > 0) {
      console.warn(
        `[arena] FAIR COHORT SHORTAGE: ${researchAccounting.researchShortage} research seed slot(s) could not be filled by a UNIQUE research genome. The shortfall stays conventional; no genome was cloned.`,
      );
    }
  } else {
    entrants = conventionalPool;
    researchAccounting = {
      mode: RESEARCH_ARENA_MODE.CHALLENGER,
      requestedPopulation: population,
      startingResearchSeeds: 0,
      startingConventionalSeeds: conventionalPool.length,
      researchShortage: 0,
      clonedToFillQuota: 0,
      note: "CHALLENGER: conventional entrants are pre-evolved, then fresh research candidates are appended.",
    };
  }

  // ---- Pre-evolution ------------------------------------------------------
  // A/B mode pre-evolves its two cohorts separately (above) so that research
  // and conventional lineages can never cross.
  if (generations > 1 && researchMode !== RESEARCH_ARENA_MODE.AB) {
    entrants = await preEvolve({
      entrants,
      rounds: generations,
      population,
      seeds,
      datasetRefs,
      config,
      workers,
      cacheDir,
      useCache,
      label: includeResearch ? researchMode : "conventional",
    });
  }

  // ---- Phase 5A.2: append research candidates (challenger mode) -----------
  // Off by default: a real arena run's population is a fixed, requested size,
  // and research candidates are additive on top of it, never a silent
  // substitute for the existing champion/evolved/immigrant mix. Each entrant
  // now carries first-class provenance, so promotion and reporting no longer
  // need to reconstruct research identity from a genome digest.
  if (includeResearch && researchMode === RESEARCH_ARENA_MODE.CHALLENGER) {
    for (const entrant of researchEntrants) entrants.push(entrant);
    researchAccounting.startingResearchSeeds = researchEntrants.length;
    console.log(`[arena] research candidates appended: ${researchEntrants.length} (unique genomes, from ${researchRoot})`);
  }

  const researchEntrantCount = entrants.filter((e) => e.origin === "research").length;
  const researchLineageCount = entrants.filter(
    (e) => e.origin === "research" || Boolean(e.research) || Boolean(e.researchAncestry),
  ).length;
  const conventionalCount = entrants.length - researchLineageCount;
  console.log(
    `[arena] conventional entrants: ${conventionalCount} (champions ${entrants.filter((e) => e.origin === "champion").length}, evolved ${entrants.filter((e) => e.origin === "evolved").length}, immigrants ${entrants.filter((e) => e.origin === "immigrant").length})`,
  );
  console.log(
    `[arena] total entrants: ${entrants.length} (conventional ${conventionalCount} + research ${researchEntrantCount}; research-lineage incl. born descendants ${researchLineageCount})`,
  );
  if (entrants.length === 0) {
    console.error("[arena] no entrants to evaluate");
    process.exitCode = 1;
    return;
  }

  const arenaId = `arena-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
  const stressProfiles = ["mild", "moderate"];

  // Role-level metrics need this run's rows, so they are provided as a
  // provider the tournament calls once the rows exist.
  const researchRoleMetricsProvider = includeResearch
    ? async ({ candidateRows }) => {
        const [memoryRecords, proposals, compiled] = await Promise.all([
          readMemoryIndex(researchRoot, { limit: 2000 }),
          listProposals(researchRoot, { limit: 500 }),
          listCompiledCandidates(researchRoot, { limit: 500 }),
        ]);
        return roleResearchMetrics({
          proposals,
          compiled,
          memoryRecords,
          arenaRows: (candidateRows ?? []).filter((row) => row?.research?.isResearch),
        });
      }
    : null;

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
    arenasDir,
    researchCohort,
    researchMode: includeResearch ? researchMode : null,
    researchAccounting,
    researchRoleMetrics: researchRoleMetricsProvider,
    minUniqueRatio,
    maxSpeciesShare,
    researchEnabled: includeResearch,
    // Phase 5A.3: matched A/B reporting (identical evaluation for everyone).
    abAccounting: abContext?.accounting ?? null,
    abConfig: abContext
      ? {
          generations,
          workers,
          survivorFraction: 0.3,
          breederShare: 0.35,
          mutationScale: config.evolution?.mutationScale ?? null,
          crossoverRate: config.evolution?.crossoverRate ?? null,
          immigrantRate: config.evolution?.immigrantRate ?? null,
          randomImmigrantShare: 0.15,
          championShare: 0.35,
          immigrantShare: 0.15,
        }
      : null,
    abRoles: abContext
      ? { known: [...PROPOSING_ROLES, ...ADVISORY_ROLES], advisory: [...ADVISORY_ROLES] }
      : null,
    abSpeciesMatched: abContext?.speciesMatched === true,
    abSpeciesMatch: abContext?.speciesMatch ?? null,
    abBootstrapIterations,
    abBootstrapSeed,
    onProgress: ({ message }) => {
      if (message) console.log(`[arena] ${message}`);
    },
  });

  // ---- Phase 5A: promote research memory from this Arena's real result ----
  // The ONLY place a research proposal can reach PROMISING/ARENA_SURVIVOR/
  // SHADOW_ELIGIBLE — never the research cycle itself. Runs unconditionally
  // (cheap no-op when no compiled candidates exist), independent of whether
  // this run's entrants were told to include research candidates.
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
  // Phase 5C: `EVOLVE_HALL_OF_FAME_DIR` lets the replication runner keep its
  // runs from writing into the shared historical Hall of Fame. Default
  // behavior is unchanged.
  const hofDir = process.env.EVOLVE_HALL_OF_FAME_DIR ?? config.hallOfFameDir ?? DEFAULT_HOF_DIR;
  await ensureDir(hofDir);
  const hofFile = path.join(hofDir, "index.json");
  let hof = { members: [] };
  try {
    hof = JSON.parse(await readFile(hofFile, "utf8"));
  } catch {
    // first run
  }
  const membersByDigest = new Map((hof.members ?? []).map((m) => [m.digest, m]));
  for (const entrant of entrants) {
    const digest = entrant.digest ?? digestOf(entrant.genome);
    const detail = result.details.get(entrant);
    if (!detail) continue;
    const existing = membersByDigest.get(digest) ?? null;
    // Only interesting genomes enter the Hall of Fame: gate-passing candidates
    // or high scorers.
    const isInteresting =
      detail.deploymentEligible === true ||
      detail.gateStatus === "GATES_PASSED" ||
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
  await writeFile(hofFile, `${JSON.stringify(hof, null, 2)}\n`, "utf8");

  // ---- Report -------------------------------------------------------------
  // The research summary is written by the tournament; the memory roll-up is
  // re-read here so the printed report matches what is actually on disk.
  let memorySummary = null;
  try {
    memorySummary = await readResearchMemorySummary(researchRoot, { limit: 2000 });
  } catch {
    memorySummary = null;
  }

  const researchSummary = result.summary.researchSummary;

  // ---- Phase 5B: research-provider provenance for this run -----------------
  // When the research cohort came from an isolated provider experiment
  // (`EVOLVE_RESEARCH_ROOT=.evolve/research/experiments/<id>`), copy the
  // experiment's compact metadata next to the Arena artifacts so the
  // comparison tool can attribute the run to a provider/model WITHOUT reading
  // the research memory itself. This never mutates the tournament output and
  // never rewrites research state.
  if (includeResearch) {
    try {
      const experiment = await readResearchExperiment(researchRoot);
      if (experiment) {
        const summary = researchExperimentSummary(experiment);
        await writeFile(
          path.join(arenasDir, arenaId, "research-experiment.json"),
          `${JSON.stringify({ ...summary, researchRoot }, null, 2)}\n`,
          "utf8",
        );
        console.log(
          `[arena] research provider: ${summary.provider}${summary.model ? ` / ${summary.model}` : ""}${summary.reasoning ? ` (${summary.reasoning})` : ""} · experiment ${summary.experimentId}`,
        );
      }
    } catch (error) {
      console.warn(`[arena] could not record research-provider provenance: ${error?.message ?? error}`);
    }
  }
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
    const researchTag = row.research?.isResearch ? " [research]" : "";
    console.log(
      `  ${row.score.toFixed(1).padStart(6)}  ${(row.gateStatus ?? row.status ?? "").padEnd(20)} ${row.species}  ${row.digest.slice(0, 12)}${researchTag}`,
    );
  }
  console.log("");
  console.log(`Champion League final ${result.summary.championLeague.length} (explicit, no inference):`);
  for (const row of result.summary.championLeague) {
    const researchTag = row.research?.isResearch ? ` [research:${row.research.identity}]` : "";
    console.log(`  #${String(row.leagueRank).padStart(2)}  ${row.score.toFixed(1).padStart(6)}  ${row.species}  ${row.digest.slice(0, 12)}${researchTag}`);
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
  if (researchSummary) {
    console.log("Research cohort (PAPER hypotheses, same funnel and gates as everyone else):");
    console.log(`  enabled ${researchSummary.enabled} · mode ${researchSummary.mode} · proposals ${researchSummary.proposalsAvailable} · compiled ${researchSummary.compiledArtifacts} · unique genomes ${researchSummary.uniqueCompiledGenomes} · duplicate genomes ${researchSummary.duplicateCompiledGenomes}`);
    if (researchSummary.researchExperimentId) {
      console.log(
        `  research experiment ${researchSummary.researchExperimentId} · provider ${researchSummary.researchProvider ?? "n/a"}${researchSummary.researchModel ? ` / ${researchSummary.researchModel}` : ""}${researchSummary.researchReasoning ? ` (${researchSummary.researchReasoning})` : ""}`,
      );
    }
    // NOTE: everything below labelled "ancestry" answers "how many entrants
    // still carry TRACEABLE RESEARCH-PROPOSAL ANCESTRY" (Phase 5A.2) — a
    // DIFFERENT question from A/B ARM MEMBERSHIP (`armResearch` below, Phase
    // 5A.3.2). In A/B mode these two numbers can legitimately differ: an arm
    // entrant may have lost its ancestry to generations of selection and
    // random immigration while still correctly belonging to that arm.
    console.log(`  ancestry entrants ${researchSummary.researchEntrants} (unique ${researchSummary.uniqueResearchEntrants}, ratio ${researchSummary.uniqueRatio.toFixed(3)} vs min ${researchSummary.uniquenessThreshold.toFixed(2)})`);
    console.log(`  ancestry species ${JSON.stringify(researchSummary.speciesDistribution)} · ancestry roles ${JSON.stringify(researchSummary.roleDistribution)}`);
    console.log(`  ancestry best rank ${researchSummary.bestResearchRank ?? "n/a"} · median rank ${researchSummary.medianResearchRank ?? "n/a"} · best score ${researchSummary.bestResearchScore ?? "n/a"} · median score ${researchSummary.medianResearchScore ?? "n/a"}`);
    console.log(`  ancestry Champion League ${researchSummary.researchChampionLeagueCount}/${result.summary.championLeague.length} · top50 ${researchSummary.researchTop50Count} · reached GROUP ${researchSummary.researchGroupCount}`);
    console.log(`  exact original survivors ${researchSummary.exactOriginalResearchSurvivors} · descendant survivors ${researchSummary.descendantResearchSurvivors} · deployments ${researchSummary.researchDeploymentCount}`);
    console.log(`  failed gates ${JSON.stringify(researchSummary.failedGateCounts)}`);
    if (researchSummary.armResearch) {
      console.log(
        `  A/B ARM (research)      entrants ${researchSummary.armResearch.entrants} (${researchSummary.armResearch.withResearchAncestryCount} with ancestry, ${researchSummary.armResearch.withoutResearchAncestryCount} without) · Champion League ${researchSummary.armResearch.championLeagueCount} · top50 ${researchSummary.armResearch.top50Count} · best rank ${researchSummary.armResearch.bestRank ?? "n/a"}`,
      );
      console.log(`  A/B ARM (research)      species ${JSON.stringify(researchSummary.armResearch.speciesDistribution)}`);
    }
    if (researchSummary.armConventional) {
      console.log(
        `  A/B ARM (conventional)  entrants ${researchSummary.armConventional.entrants} · Champion League ${researchSummary.armConventional.championLeagueCount} · top50 ${researchSummary.armConventional.top50Count} · best rank ${researchSummary.armConventional.bestRank ?? "n/a"}`,
      );
    }
    if (researchSummary.uniquenessWarning) console.warn(`  WARNING: ${researchSummary.uniquenessWarning}`);
    if (researchSummary.concentration?.warning) console.warn(`  WARNING: ${researchSummary.concentration.warning}`);
    if (researchSummary.accounting?.researchShortage > 0) {
      console.warn(`  WARNING: fair-cohort research shortage ${researchSummary.accounting.researchShortage} (never filled by cloning)`);
    }
    if (researchSummary.roleMetrics) {
      const roles = Object.entries(researchSummary.roleMetrics);
      console.log(`  role metrics (${roles.length} role(s)):`);
      for (const [role, m] of roles) {
        console.log(
          `    ${role.padEnd(22)} proposals ${m.proposalsGenerated} · compiled ${m.compilationAccepted} · unique ${m.uniqueGenomes} · dup-rejected ${m.duplicateRejected} · entrants ${m.arenaEntrants} · watchdog ${m.watchdog.NORMAL}/${m.watchdog.WATCH}/${m.watchdog.QUARANTINED}`,
        );
      }
    }
    if (memorySummary) {
      console.log(`  research memory: ${memorySummary.memoryRecords} records · ${memorySummary.conclusions} conclusions · watchdog NORMAL/WATCH/QUARANTINED ${memorySummary.watchdog.NORMAL}/${memorySummary.watchdog.WATCH}/${memorySummary.watchdog.QUARANTINED}`);
    }
  }

  // ---- Phase 5A.3: compact matched A/B report ----------------------------
  const ab = result.summary.abComparison;
  if (ab) {
    console.log("");
    console.log("Matched A/B comparison (research vs conventional, PAPER ONLY):");
    console.log(
      `  cohort construction: requested ${fmt(ab.cohortConstruction.requestedPerCohort)} per cohort · actual ${fmt(ab.cohortConstruction.actualPerCohort)} per cohort · total ${fmt(ab.cohortConstruction.actualTotal)}`,
    );
    console.log(
      `  unique seeds: research ${ab.cohortConstruction.uniqueResearchSeeds} · conventional ${ab.cohortConstruction.uniqueConventionalSeeds} · shortage research ${ab.cohortConstruction.shortage.research} conventional ${ab.cohortConstruction.shortage.conventional} · cloned-to-fill ${ab.cohortConstruction.clonedToFillQuota}`,
    );
    console.log(
      `  cohort size: research ${ab.cohortSize.research} · conventional ${ab.cohortSize.conventional} · equal=${ab.cohortSize.equalSize} · unique final genomes research ${ab.cohortSize.researchUniqueFinalGenomes} / conventional ${ab.cohortSize.conventionalUniqueFinalGenomes}`,
    );
    for (const [name, cohort] of [
      ["research", ab.research],
      ["conventional", ab.conventional],
    ]) {
      if (!cohort) continue;
      console.log(
        `  ${name.padEnd(13)} best ${fmt(cohort.bestScore)} · median score ${fmt(cohort.medianScore)} · best rank ${fmt(cohort.bestRank)} · median rank ${fmt(cohort.medianRank)} · top10 ${cohort.top10Count} top25 ${cohort.top25Count} top50 ${cohort.top50Count} · GROUP ${cohort.groupCount} STRESS ${cohort.stressCount} CL ${cohort.championLeagueCount} deploy ${cohort.deploymentCount}`,
      );
      console.log(
        `  ${" ".repeat(13)} median trades ${fmt(cohort.medianTrades)} · mints ${fmt(cohort.medianDistinctMints)} · drawdown ${fmt(cohort.medianDrawdown)} · net paper ${fmt(cohort.medianNetPaperReturn)} · diversity ${fmt(cohort.genomeDiversity)} · stress survival ${cohort.stressSurvivalCount}`,
      );
    }
    const cmp = ab.comparison?.arenaScore ?? null;
    if (cmp) {
      const interval = cmp.medianDifferenceInterval
        ? ` · bootstrap 95% [${fmt(cmp.medianDifferenceInterval.low)}, ${fmt(cmp.medianDifferenceInterval.high)}] (deterministic, descriptive only)`
        : "";
      console.log(
        `  arena score: research median ${fmt(cmp.researchMedian)} vs conventional median ${fmt(cmp.conventionalMedian)} · median difference ${fmt(cmp.medianDifference)}${interval}`,
      );
    }
    console.log(
      `  species matched: ${ab.species?.matched === true} (requested ${ab.species?.requestedMatchMode ?? "unmatched"} · effective ${ab.species?.effectiveMatchMode ?? ab.species?.matchMode ?? "unmatched"}) · no significance claim is made`,
    );
    console.log(
      "  PAPER ONLY. Research cohort higher/lower/equal on the observed paper metrics above — a difference is an observation, not proof, and not a profitability claim.",
    );
  }
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
