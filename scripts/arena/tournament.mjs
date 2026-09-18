/**
 * Champion Arena tournament runner.
 *
 * Stage funnel:
 *   QUALIFICATION -> GROUP -> STRESS -> OUT-OF-SAMPLE -> CHAMPION LEAGUE -> DEPLOYMENT
 *
 * Every stage uses the same paper replay machinery; nothing here trades real
 * money and no stage can alter recorded market observations.
 *
 * Parallelism: bounded worker threads (EVOLVE_ARENA_WORKERS). Results are
 * identical regardless of worker count because every candidate/seed/window
 * slice is seeded independently and deterministically.
 */

import path from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { writeFile, mkdir } from "node:fs/promises";

import { digestOf, shortDigest } from "../lib/hash.mjs";
import { createSeededRandom } from "../lib/random.mjs";
import { randomGenome, mutateGenome, crossoverGenomes, SPECIES } from "../engine/genome.mjs";
import { runBaselines } from "../engine/baselines.mjs";
import {
  adaptMutationScale,
  ARENA_CACHE_VERSION,
  ARENA_SCORE_VERSION,
  ARENA_STAGE,
  GATE_STATUS,
  computeGenomeMetrics,
  diversityVerdict,
  DEFAULT_DEPLOYMENT_GATES,
  STRESS_PROFILES,
} from "./orchestrator.mjs";
import { EVALUATOR_VERSION } from "./evaluator.mjs";
import {
  descendantResearchMeta,
  researchProvenance,
  mergeResearchAncestry,
  summarizeResearchCohort,
} from "./research-cohort.mjs";
import { childLineage, immigrantLineage, seedLineageId } from "../research/ab-cohort.mjs";
import { buildAbComparison, summarizeAbForSummary } from "./ab-comparison.mjs";

export const ARENA_RUNNER_VERSION = 1;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const WORKER_PATH = path.join(__dirname, "arena-worker.mjs");

/* -------------------------------------------------------------------------- */
/* Population synthesis                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Build the arena entrant pool: evolved genomes, prior champions, random
 * immigrants, and mutated/crossover children of champions.
 * Deterministic given (champions, config, seed).
 */
/** Provenance fields carried verbatim from a parent entrant. */
function carriedMeta(source) {
  const meta = {};
  if (source?.origin) meta.origin = source.origin;
  if (source?.research) meta.research = source.research;
  if (source?.researchAncestry) meta.researchAncestry = source.researchAncestry;
  // Phase 5A.3: cohort + lineage identity travel with a re-entering genome, so
  // an unchanged seed is still an exact original of its cohort.
  if (source?.cohort) meta.cohort = source.cohort;
  if (source?.lineage) meta.lineage = source.lineage;
  if (source?.lineageId) meta.lineageId = source.lineageId;
  return meta;
}

/** Cohort/lineage metadata for a BRED child (empty outside A/B mode). */
function childLineageMeta(...parents) {
  const lineage = childLineage(...parents);
  if (!lineage) return {};
  return { cohort: lineage.cohort, lineageId: lineage.lineageId, lineage };
}

/**
 * A random immigrant inside one cohort's evolutionary budget. Outside A/B mode
 * (`cohort` null) this is exactly the old plain immigrant object — no cohort,
 * no lineage, no behavior change.
 */
function immigrantEntrant(genome, species, cohort) {
  if (!cohort) return { genome, species, origin: "immigrant" };
  const digest = digestOf(genome);
  return {
    genome,
    species,
    origin: "immigrant",
    digest,
    cohort,
    lineageId: seedLineageId(cohort, digest),
    lineage: immigrantLineage(cohort, digest),
  };
}

export function buildEntrantPool({
  champions = [],
  population = 24,
  seed = "arena",
  championShare = 0.2,
  immigrantShare = 0.15,
  eliteCarryover = [],
  // Phase 5A.3: when supplied, random immigrants are tagged with this cohort
  // (and its own lineage) so every A/B entrant stays attributable. Null keeps
  // the pre-5A.3 behavior byte-for-byte.
  cohort = null,
} = {}) {
  const random = createSeededRandom(`pool:${seed}`);
  const entrants = [];

  const championSlots = Math.min(champions.length, Math.floor(population * championShare));
  const immigrantSlots = Math.max(1, Math.floor(population * immigrantShare));
  const evolvedSlots = Math.max(0, population - championSlots - immigrantSlots);

  // Existing champions re-enter and must be able to lose. Their provenance is
  // carried verbatim: an unchanged research seed is still an exact original
  // research genome, not a descendant of one.
  for (let i = 0; i < championSlots; i += 1) {
    const champ = champions[i % Math.max(1, champions.length)];
    if (!champ) break;
    entrants.push({
      genome: champ.genome,
      species: champ.species ?? "Champion",
      digest: champ.digest,
      ...carriedMeta(champ),
      origin: champ.origin ?? "champion",
    });
  }

  // "Evolved" slots: deterministic children of champions (crossover+mutation)
  // or fresh species-preset genomes when no champions exist yet. Research
  // ancestry survives breeding, but a bred child is labelled a DESCENDANT —
  // never as an exact original research genome (Phase 5A.2 fair mode).
  for (let i = 0; i < evolvedSlots; i += 1) {
    if (champions.length >= 2) {
      const a = champions[Math.floor(random() * champions.length)];
      const b = champions[Math.floor(random() * champions.length)];
      const child = mutateGenome(crossoverGenomes(a.genome, b.genome, { random }), { scale: 0.08, random });
      const ancestry = mergeResearchAncestry(a, b);
      const descendant = descendantResearchMeta(ancestry);
      entrants.push({
        genome: child,
        species: a.species ?? "Experimental",
        origin: "evolved",
        ...(descendant ? { research: descendant, researchAncestry: ancestry } : {}),
        ...childLineageMeta(a, b),
      });
    } else if (champions.length === 1) {
      const child = mutateGenome(champions[0].genome, { scale: 0.08, random });
      const ancestry = mergeResearchAncestry(champions[0]);
      const descendant = descendantResearchMeta(ancestry);
      entrants.push({
        genome: child,
        species: champions[0].species ?? "Experimental",
        origin: "evolved",
        ...(descendant ? { research: descendant, researchAncestry: ancestry } : {}),
        ...childLineageMeta(champions[0]),
      });
    } else {
      const species = SPECIES[i % SPECIES.length];
      entrants.push(immigrantEntrant(randomGenome(species, random), species, cohort));
    }
  }

  // Random immigrants keep exploration alive no matter how strong the champions are.
  for (let i = 0; i < immigrantSlots; i += 1) {
    const species = SPECIES[Math.floor(random() * SPECIES.length)];
    entrants.push(immigrantEntrant(randomGenome(species, random), species, cohort));
  }

  for (const entrant of eliteCarryover ?? []) {
    if (entrant?.genome) entrants.push({ ...entrant, origin: entrant.origin ?? "carryover" });
  }

  return entrants.slice(0, population);
}

/* -------------------------------------------------------------------------- */
/* Funnel stages                                                              */
/* -------------------------------------------------------------------------- */

/** QUALIFICATION: cheap screen — single seed, single window per dataset. */
export function runQualification({ entrants, scores, minScore }) {
  const scored = entrants
    .map((entrant) => ({ entrant, score: scores.get(entrant) ?? -Infinity }))
    .filter((row) => Number.isFinite(row.score));
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const survivors = sorted.filter((row) => row.score >= minScore);
  const kept = survivors.length >= 2 ? survivors : sorted.slice(0, Math.max(2, Math.ceil(sorted.length * 0.5)));
  return {
    stage: "QUALIFICATION",
    entered: entrants.length,
    survivors: kept.map((row) => row.entrant),
    scores: kept.map((row) => round2(row.score)),
    eliminated: entrants.length - kept.length,
    rule: `arena score >= ${minScore} (or top 50% if too few pass)`,
  };
}

/** GROUP: rank survivors and keep the top fraction. */
export function runGroupStage({ survivors, scores, keepFraction = 0.25, minKeep = 4 }) {
  const sorted = [...survivors].sort((a, b) => (scores.get(b) ?? -Infinity) - (scores.get(a) ?? -Infinity));
  const keep = Math.max(minKeep, Math.ceil(sorted.length * keepFraction));
  const kept = sorted.slice(0, keep);
  return {
    stage: "GROUP",
    entered: survivors.length,
    survivors: kept,
    eliminated: survivors.length - kept.length,
    rule: `top ${Math.round(keepFraction * 100)}% by arena score (min ${minKeep})`,
  };
}

/** STRESS: cull candidates that collapse under mild+ stress overlays. */
export function runStressCull({ candidates, stressResults, minSurvived = 1 }) {
  const kept = candidates.filter((candidate) => {
    const row = stressResults.get(candidate);
    if (!row) return false;
    return row.stressSurvived >= minSurvived;
  });
  return {
    stage: "STRESS",
    entered: candidates.length,
    survivors: kept,
    eliminated: candidates.length - kept.length,
    rule: `survived >= ${minSurvived} stress profile(s)`,
  };
}

/** CHAMPION LEAGUE: ranked final; keep the top candidates for deployment review. */
export function runChampionLeague({ candidates, scores, maxChampions = 8 }) {
  const sorted = [...candidates].sort(
    (a, b) => (scores.get(b) ?? -Infinity) - (scores.get(a) ?? -Infinity),
  );
  const kept = sorted.slice(0, maxChampions);
  return {
    stage: "CHAMPION LEAGUE",
    entered: candidates.length,
    survivors: kept,
    eliminated: candidates.length - kept.length,
    rule: `top ${maxChampions} by arena score`,
  };
}

/* -------------------------------------------------------------------------- */
/* Worker orchestration                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Run the full arena.
 *
 * @param {{
 *   datasets: Array<{ dir: string, id: string, fingerprint: string|null, sourceType: string }>,
 *   config: object,
 *   entrants: Array<{ genome: object, species?: string, origin?: string, digest?: string }>,
 *   seeds: Array<number|string>,
 *   stressProfiles?: string[],
 *   maxWindows?: number|null,
 *   workers?: number,
 *   cacheDir?: string|null,
 *   useCache?: boolean,
 *   evidence?: object,
 *   qualificationMinScore?: number,
 *   groupKeepFraction?: number,
 *   championLeagueSize?: number,
 *   onProgress?: ((info: object) => void) | null,
 *   arenaId?: string|null,
 *   arenasDir?: string|null,
 * }} options
 */
export async function runArenaTournament({
  datasets,
  config,
  entrants,
  seeds,
  stressProfiles = ["mild", "moderate"],
  maxWindows = null,
  workers = 0,
  cacheDir = null,
  useCache = true,
  evidence = null,
  qualificationMinScore = 35,
  groupKeepFraction = 0.4,
  championLeagueSize = 8,
  onProgress = null,
  arenaId = null,
  arenasDir = null,
  researchCohort = null,
  researchMode = null,
  researchAccounting = null,
  researchRoleMetrics = null,
  minUniqueRatio = null,
  maxSpeciesShare = null,
  researchEnabled = null,
  // Phase 5A.3 A/B benchmark: when `abAccounting` is supplied the tournament
  // emits a matched-cohort comparison artifact. The evaluation, scoring, gates,
  // stress profiles and datasets above are IDENTICAL for every entrant — the
  // only thing cohort identity does is split the reporting.
  abAccounting = null,
  abConfig = null,
  abRoles = null,
  abSpeciesMatched = false,
  abBootstrapIterations = null,
  abBootstrapSeed = null,
}) {
  const startedAt = Date.now();
  const log = (message, detail = null) => {
    if (typeof onProgress === "function") onProgress({ message, detail, at: Date.now() });
  };

  // ---------------- Phase A: evaluate EVERY entrant on every dataset --------
  log(`evaluating ${entrants.length} entrants across ${datasets.length} dataset(s)`);
  const evaluations = await evaluateAllEntrants({
    entrants,
    datasets,
    config,
    seeds,
    stressProfiles,
    maxWindows,
    workers,
    cacheDir,
    useCache,
    evidence,
    onProgress,
  });

  // ---------------- Score + classify ---------------------------------------
  const regimesByDataset = {};
  for (const dataset of datasets) {
    regimesByDataset[dataset.dir] = dataset.regimesByWindow ?? {};
  }

  const scored = new Map();
  const details = new Map();
  for (const entrant of entrants) {
    const digest = entrant.digest ?? digestOf(entrant.genome);
    const evaluation = evaluations.get(entrant) ?? { oosRuns: [], stressRuns: [] };
    const { aggregateArenaResult } = await import("./orchestrator.mjs");
    const result = aggregateArenaResult({
      digest,
      species: entrant.species,
      origin: entrant.origin,
      evaluations: [evaluation],
      regimesByDataset,
      stressProfiles,
      realDatasetsUsed: datasets.filter((d) => d.sourceType === "REAL").length,
      gatesConfig: config.arena?.gates ?? {},
    });
    scored.set(entrant, result.arenaScore.score);
    details.set(entrant, result);
  }

  // ---------------- Funnel --------------------------------------------------
  const qualification = runQualification({ entrants, scores: scored, minScore: qualificationMinScore });
  const group = runGroupStage({ survivors: qualification.survivors, scores: scored, keepFraction: groupKeepFraction });
  const stressResults = new Map();
  for (const candidate of group.survivors) {
    const detail = details.get(candidate);
    stressResults.set(candidate, {
      stressSurvived: detail?.components?.stressSurvived ?? 0,
      stressTotal: detail?.components?.stressTotal ?? 0,
      survival: detail?.stressSurvival ?? {},
    });
  }
  const stress = runStressCull({ candidates: group.survivors, stressResults, minSurvived: 1 });
  const championLeague = runChampionLeague({ candidates: stress.survivors, scores: scored, maxChampions: championLeagueSize });

  // ---------------- Deployment gates + statuses -----------------------------
  const statuses = new Map();
  for (const entrant of entrants) {
    const detail = details.get(entrant);
    if (!detail) continue;
    statuses.set(entrant, {
      status: detail.status,
      gateStatus: detail.gateStatus ?? null,
      deploymentGateStatus: detail.deploymentGateStatus ?? null,
      deploymentEligible: detail.deploymentEligible === true,
      reason: detail.reason,
      gates: detail.gates,
      arenaScore: detail.arenaScore.score,
    });
  }

  const deploymentCandidates = [...statuses.entries()]
    .filter(([, row]) => row.deploymentEligible === true)
    .map(([entrant, row]) => ({ entrant, ...row }))
    .sort((a, b) => b.arenaScore - a.arenaScore);

  // ---------------- Tournament stage accounting (Phase 5A.2) ----------------
  // The funnel stages are sets of entrants. For every entrant we record the
  // HIGHEST stage it survived and, when it was culled, WHICH stage culled it,
  // plus its overall rank. "The final eight" is therefore an explicit list
  // (`championLeague`), never something inferred from a status string.
  const qualificationSet = new Set(qualification.survivors);
  const groupSet = new Set(group.survivors);
  const stressSet = new Set(stress.survivors);
  const championSet = new Set(championLeague.survivors);

  const stageFor = (entrant) => {
    if (championSet.has(entrant)) {
      return { highestStage: ARENA_STAGE.CHAMPION_LEAGUE, eliminatedAtStage: null };
    }
    if (stressSet.has(entrant)) {
      return { highestStage: ARENA_STAGE.STRESS, eliminatedAtStage: ARENA_STAGE.CHAMPION_LEAGUE };
    }
    if (groupSet.has(entrant)) {
      return { highestStage: ARENA_STAGE.GROUP, eliminatedAtStage: ARENA_STAGE.STRESS };
    }
    if (qualificationSet.has(entrant)) {
      return { highestStage: ARENA_STAGE.QUALIFICATION, eliminatedAtStage: ARENA_STAGE.GROUP };
    }
    return { highestStage: null, eliminatedAtStage: ARENA_STAGE.QUALIFICATION };
  };

  const digestFor = (entrant) => entrant.digest ?? digestOf(entrant.genome);
  const rankedEntrants = [...entrants].sort((a, b) => {
    const sa = scored.get(a) ?? -Infinity;
    const sb = scored.get(b) ?? -Infinity;
    if (sb !== sa) return sb - sa;
    return String(digestFor(a)).localeCompare(String(digestFor(b)));
  });
  const rankByEntrant = new Map(rankedEntrants.map((entrant, index) => [entrant, index + 1]));

  const candidateRows = rankedEntrants.map((entrant) => {
    const detail = details.get(entrant) ?? null;
    const entry = statuses.get(entrant) ?? {};
    const stage = stageFor(entrant);
    const rank = rankByEntrant.get(entrant) ?? null;
    return {
      digest: digestFor(entrant),
      species: entrant.species ?? null,
      origin: entrant.origin ?? null,
      score: round2(scored.get(entrant) ?? 0),
      finalRank: rank,
      highestStage: stage.highestStage,
      eliminatedAtStage: stage.eliminatedAtStage,
      status: entry.status ?? null,
      gateStatus: entry.gateStatus ?? null,
      deploymentGateStatus: entry.deploymentGateStatus ?? null,
      deploymentEligible: entry.deploymentEligible === true,
      isChampionLeagueFinalist: championSet.has(entrant),
      failedGates: (entry.gates ?? []).filter((gate) => !gate.pass).map((gate) => gate.label),
      reason: entry.reason ?? null,
      // Phase 5A.2: first-class research provenance (exact identity vs ancestry).
      research: researchProvenance(entrant),
      // Phase 5A.3: cohort + lineage identity for the A/B benchmark, plus the
      // compact paper evidence every comparison metric is derived from.
      cohort: entrant.cohort ?? null,
      lineage: entrant.lineage ?? null,
      lineageId: entrant.lineageId ?? entrant.lineage?.lineageId ?? null,
      paperEvidence: summarizePaperEvidence(evaluations.get(entrant), detail),
      distinctMintDiagnostics: detail?.distinctMintDiagnostics ?? null,
    };
  });

  // Role-level research metrics need this run's rows, so the caller may pass a
  // provider function resolved once, after the rows exist.
  const resolvedRoleMetrics =
    typeof researchRoleMetrics === "function"
      ? await researchRoleMetrics({ candidateRows, entrants })
      : researchRoleMetrics;

  // ---------------- Phase 5A.3: matched A/B comparison ----------------------
  // Computed AFTER the single shared evaluation, from this run's own rows. The
  // cohorts consumed identical datasets, seeds, windows, stress profiles,
  // scoring and gates by construction — this only splits the reporting.
  const abArtifact =
    abAccounting != null
      ? buildAbComparison({
          arenaId,
          candidateRows,
          entrants,
          accounting: { ...abAccounting, speciesMatched: abSpeciesMatched === true },
          config: abConfig ?? {},
          datasets,
          seeds,
          stressProfiles,
          knownRoles: abRoles?.known ?? [],
          advisoryRoles: abRoles?.advisory ?? [],
          bootstrapIterations:
            Number.isFinite(Number(abBootstrapIterations)) && Number(abBootstrapIterations) > 0
              ? Number(abBootstrapIterations)
              : undefined,
          bootstrapSeed: abBootstrapSeed ?? undefined,
        })
      : null;

  // Explicit stage membership, written to rounds.json so a stage artifact can
  // be inspected without recomputing the funnel.
  const stageMembers = {
    [ARENA_STAGE.QUALIFICATION]: qualification.survivors.map(digestFor),
    [ARENA_STAGE.GROUP]: group.survivors.map(digestFor),
    [ARENA_STAGE.STRESS]: stress.survivors.map(digestFor),
    [ARENA_STAGE.CHAMPION_LEAGUE]: championLeague.survivors.map(digestFor),
    [ARENA_STAGE.DEPLOYMENT]: deploymentCandidates.map(
      (row) => row.entrant.digest ?? digestOf(row.entrant.genome),
    ),
  };

  // Every stage's `rule` documents exactly what "survivors" means there.
  // STRESS genuinely culls (candidates.json still carries full stress detail
  // for every entrant, survivor or not, so a candidate that failed stress can
  // always be found and inspected even though it never reached this count).
  const funnel = {
    QUALIFICATION: { entered: qualification.entered, survivors: qualification.survivors.length, rule: qualification.rule },
    GROUP: { entered: group.entered, survivors: group.survivors.length, rule: group.rule },
    STRESS: { entered: stress.entered, survivors: stress.survivors.length, rule: stress.rule },
    "OUT-OF-SAMPLE": {
      entered: championLeague.entered,
      survivors: championLeague.survivors.length,
      rule: "carried forward from STRESS survivors; out-of-sample windows were already evaluated for every entrant in phase A",
    },
    "CHAMPION LEAGUE": { entered: championLeague.entered, survivors: championLeague.survivors.length, rule: championLeague.rule },
    DEPLOYMENT: {
      entered: entrants.length,
      survivors: deploymentCandidates.length,
      rule: "passed every configured deployment gate (evaluateSurvivalGates) — see candidates[].gates for per-candidate detail",
    },
  };

  // ---------------- Diversity + adaptive mutation ---------------------------
  const diversity = computeGenomeMetrics(
    entrants.map((entrant) => ({ genome: entrant.genome, species: entrant.species, digest: entrant.digest, lineageId: entrant.lineageId })),
  );
  const verdict = diversityVerdict(diversity);
  const mutationScale = adaptMutationScale(diversity.genomeDiversity, config.evolution?.mutationScale ?? 0.07);

  // ---------------- Baselines (mandatory) ----------------------------------
  log("running baselines");
  const baselines = [];
  for (const dataset of datasets) {
    const { windows } = await import("./evaluator.mjs").then((m) => m.planDatasetWindows(dataset.dir, config, { maxWindows, allowShort: true }));
    if (windows.length === 0) continue;
    const rows = await runBaselines({
      datasetDir: dataset.dir,
      config,
      interval: windows[windows.length - 1].test,
      seed: String(seeds[0] ?? "baseline"),
    });
    baselines.push({
      datasetId: dataset.id,
      rows: rows.map((row) => ({
        id: row.id,
        netReturn: row.metrics?.netReturn ?? null,
        robustness: row.metrics?.robustness ?? null,
        trades: row.metrics?.trades ?? null,
      })),
    });
  }

  const summary = {
    arenaId,
    startedAt,
    endedAt: Date.now(),
    durationMs: Date.now() - startedAt,
    entrants: entrants.length,
    datasets: datasets.map((d) => ({ id: d.id, sourceType: d.sourceType, fingerprint: d.fingerprint })),
    seeds: [...seeds],
    stressProfiles: [...stressProfiles],
    funnel,
    leaderboard: candidateRows.slice(0, 50).map((row) => ({
      digest: row.digest,
      species: row.species,
      origin: row.origin,
      score: row.score,
      status: row.status,
      gateStatus: row.gateStatus,
      deploymentGateStatus: row.deploymentGateStatus,
      deploymentEligible: row.deploymentEligible,
      finalRank: row.finalRank,
      highestStage: row.highestStage,
      eliminatedAtStage: row.eliminatedAtStage,
      isChampionLeagueFinalist: row.isChampionLeagueFinalist,
      // Compact elimination context: which named gates this candidate failed,
      // not the whole candidate/gate-detail object (see candidates.json for
      // full per-gate pass/fail + numbers).
      failedGates: row.failedGates,
      research: row.research,
    })),
    // The Champion League final eight, explicitly identified.
    championLeague: candidateRows
      .filter((row) => row.isChampionLeagueFinalist)
      .sort((a, b) => a.finalRank - b.finalRank)
      .map((row, index) => ({
        leagueRank: index + 1,
        digest: row.digest,
        species: row.species,
        origin: row.origin,
        score: row.score,
        finalRank: row.finalRank,
        research: row.research,
      })),
    deploymentCandidates: deploymentCandidates.map((row) => ({
      digest: row.entrant.digest ?? digestOf(row.entrant.genome),
      species: row.entrant.species,
      score: round2(row.arenaScore),
      gateStatus: row.gateStatus ?? GATE_STATUS.GATES_PASSED,
      research: researchProvenance(row.entrant),
    })),
    researchSummary: summarizeResearchCohort({
      enabled: researchEnabled ?? Boolean(researchCohort),
      mode: researchMode ?? null,
      cohort: researchCohort,
      candidates: candidateRows,
      championLeagueDigests: [...championSet].map((entrant) => digestFor(entrant)),
      deploymentDigests: deploymentCandidates.map((row) => row.entrant.digest ?? digestOf(row.entrant.genome)),
      minUniqueRatio: minUniqueRatio ?? undefined,
      maxSpeciesShare: maxSpeciesShare ?? undefined,
      accounting: researchAccounting,
      roleMetrics: resolvedRoleMetrics,
    }),
    // Phase 5A.3: compact A/B section (the full artifact is written alongside).
    abComparison: summarizeAbForSummary(abArtifact),
    baselines,
    diversity,
    diversityVerdict: verdict,
    adaptiveMutation: { scale: mutationScale, previousScale: config.evolution?.mutationScale ?? 0.07, reason: verdict.reason },
    paperOnly: true,
    note: "Arena results are PAPER research outputs. They do not predict future profitability.",
  };

  if (arenasDir && arenaId) {
    await writeArenaOutputs({
      arenasDir,
      arenaId,
      summary,
      details,
      statuses,
      entrants,
      scored,
      config,
      evidence,
      stressProfiles,
      gatesConfig: config.arena?.gates ?? {},
      candidateRows,
      stageMembers,
      abArtifact,
    });
  }

  return { summary, details, statuses, scored, evaluations, candidateRows, championLeague, stageMembers, abArtifact };
}

/* -------------------------------------------------------------------------- */
/* Evaluation via workers or inline                                           */
/* -------------------------------------------------------------------------- */

async function evaluateAllEntrants({
  entrants,
  datasets,
  config,
  seeds,
  stressProfiles,
  maxWindows,
  workers,
  cacheDir,
  useCache,
  evidence,
  onProgress,
}) {
  const results = new Map();
  const workerCount = clampWorkers(workers, entrants.length);

  if (workerCount <= 1) {
    // Inline path: same code, deterministic.
    const { evaluateCandidateOnDataset, planDatasetWindows } = await import("./evaluator.mjs");
    const windowsCache = new Map();
    for (const dataset of datasets) {
      const planned = await planDatasetWindows(dataset.dir, config, { maxWindows, allowShort: true });
      windowsCache.set(dataset.dir, planned.windows);
    }
    for (const entrant of entrants) {
      const evals = [];
      for (const dataset of datasets) {
        evals.push(
          await evaluateCandidateOnDataset({
            candidate: entrant,
            datasetDir: dataset.dir,
            config,
            seeds,
            stressProfiles,
            windowsOverride: windowsCache.get(dataset.dir),
            evidence,
            cacheDir,
            useCache,
          }),
        );
      }
      results.set(entrant, { oosRuns: evals.flatMap((e) => e.oosRuns), stressRuns: evals.flatMap((e) => e.stressRuns) });
      if (onProgress) onProgress({ message: `evaluated ${results.size}/${entrants.length}`, at: Date.now() });
    }
    return results;
  }

  // Worker path: each entrant is an independent, deterministic unit of work.
  const plainConfig = JSON.parse(JSON.stringify(config)); // drops non-enumerable apiKey
  const tasks = [];
  for (const entrant of entrants) {
    tasks.push({
      candidate: { genome: entrant.genome, species: entrant.species, digest: entrant.digest },
      datasets: datasets.map((d) => ({ dir: d.dir, maxWindows })),
      config: plainConfig,
      seeds,
      stressProfiles,
      cacheDir,
      useCache,
    });
  }

  const workerResults = await runWorkerPool({
    workerPath: WORKER_PATH,
    tasks,
    workerCount,
    onProgress,
  });

  for (let i = 0; i < entrants.length; i += 1) {
    const payload = workerResults[i];
    results.set(entrants[i], {
      oosRuns: payload?.oosRuns ?? [],
      stressRuns: payload?.stressRuns ?? [],
    });
  }
  return results;
}

async function runWorkerPool({ workerPath, tasks, workerCount, onProgress }) {
  const results = new Array(tasks.length).fill(null);
  let nextTask = 0;
  let completed = 0;
  let failed = 0;

  async function spawn() {
    return new Promise((resolve) => {
      const worker = new Worker(workerPath);
      const pump = () => {
        const index = nextTask;
        if (index >= tasks.length) {
          worker.terminate();
          resolve();
          return;
        }
        nextTask += 1;
        worker.postMessage({ type: "start", task: tasks[index], index });
      };
      worker.on("message", (message) => {
        if (message.type === "result") {
          results[message.index] = message.value;
          completed += 1;
          if (typeof onProgress === "function") {
            onProgress({ message: `workers: ${completed}/${tasks.length} entrants evaluated`, at: Date.now() });
          }
          pump();
        } else if (message.type === "error") {
          failed += 1;
          console.error(`[arena] worker task ${message.index} failed: ${message.error}`);
          pump();
        }
      });
      worker.on("error", (error) => {
        failed += 1;
        console.error(`[arena] worker crashed: ${error?.message ?? error}`);
        resolve();
      });
      pump();
    });
  }

  await Promise.all(Array.from({ length: Math.min(workerCount, tasks.length) }, spawn));
  // Inline fallback for any task a worker could not complete.
  if (failed > 0) {
    const { evaluateCandidateOnDataset } = await import("./evaluator.mjs");
    for (let i = 0; i < tasks.length; i += 1) {
      if (results[i]) continue;
      const task = tasks[i];
      const evals = [];
      for (const dataset of task.datasets) {
        evals.push(
          await evaluateCandidateOnDataset({
            candidate: task.candidate,
            datasetDir: dataset.dir,
            config: task.config,
            seeds: task.seeds,
            stressProfiles: task.stressProfiles,
            maxWindows: dataset.maxWindows,
            cacheDir: task.cacheDir,
            useCache: task.useCache,
          }),
        );
      }
      results[i] = { oosRuns: evals.flatMap((e) => e.oosRuns), stressRuns: evals.flatMap((e) => e.stressRuns) };
    }
  }
  return results;
}

export function clampWorkers(requested, taskCount) {
  const max = Math.max(1, Math.min(requested || 0, 64));
  const cpu = typeof navigator !== "undefined" && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 8;
  const byCpu = Math.max(1, Math.floor(cpu * 0.75));
  return Math.max(1, Math.min(max, byCpu, Math.max(1, taskCount)));
}

function round2(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

/** Median of the finite entries in a list (null when there are none). */
function medianOf(values) {
  const sorted = (values ?? []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Compact per-candidate paper evidence used by the Phase 5A.3 A/B comparison.
 * Every value is a median over this candidate's own OOS runs, so a cohort
 * median is a median of medians — descriptive only, never a return forecast.
 */
export function summarizePaperEvidence(evaluation, detail = null) {
  const oosRuns = (evaluation?.oosRuns ?? []).filter((run) => run?.metrics);
  const stressRuns = (evaluation?.stressRuns ?? []).filter((run) => run?.metrics);
  const pick = (selector) => oosRuns.map((run) => selector(run.metrics));
  const regimePerformance = detail?.regimePerformance ?? {};
  return {
    oosRunCount: oosRuns.length,
    stressRunCount: stressRuns.length,
    medianNetReturn: medianOf(pick((metrics) => metrics.netReturn)),
    medianGrossReturn: medianOf(pick((metrics) => metrics.grossReturn)),
    medianCostDrag: medianOf(pick((metrics) => metrics.costDrag)),
    medianTrades: medianOf(pick((metrics) => metrics.trades)),
    medianDistinctMints: medianOf(pick((metrics) => metrics.distinctMints)),
    medianTopMintNotionalShare: medianOf(pick((metrics) => metrics.mintDiagnostics?.topMintNotionalShare)),
    medianDrawdown: medianOf(pick((metrics) => metrics.maxDrawdown)),
    catastrophicEvents: (detail?.components?.catastrophicEvents ?? 0),
    stressSurvived: detail?.components?.stressSurvived ?? 0,
    stressTotal: detail?.components?.stressTotal ?? 0,
    stressSurvival: detail?.stressSurvival ?? {},
    regimeRuns: Object.keys(regimePerformance).length,
    regimePositive: Object.values(regimePerformance).filter((row) => (row?.medianNetReturn ?? 0) > 0).length,
    regimeCoverage: Object.fromEntries(
      Object.entries(regimePerformance).map(([regime, row]) => [regime, row?.medianNetReturn ?? null]),
    ),
    oosWindows: detail?.components?.oosWindows ?? 0,
    seeds: detail?.components?.seeds ?? 0,
    observations: detail?.components?.observations ?? 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Output writing                                                             */
/* -------------------------------------------------------------------------- */

async function writeArenaOutputs({
  arenasDir,
  arenaId,
  summary,
  details,
  statuses,
  entrants,
  scored,
  config = {},
  evidence = null,
  stressProfiles = [],
  gatesConfig = {},
  candidateRows = null,
  stageMembers = null,
  abArtifact = null,
}) {
  const dir = path.join(arenasDir, arenaId);
  await mkdir(dir, { recursive: true });

  // Phase 5A.2: candidates.json carries first-class provenance (origin,
  // familyId, proposalId, authorRole, research family, regimes, genome digest,
  // ancestry), explicit gate/champion-league status, and the distinct-mint
  // diagnostics — no digest reconstruction required downstream.
  const byDigest = new Map();
  for (const entrant of entrants) byDigest.set(entrant.digest ?? digestOf(entrant.genome), entrant);

  const candidates = Array.isArray(candidateRows) && candidateRows.length > 0
    ? candidateRows.map((row) => {
        const entrant = byDigest.get(row.digest);
        const detail = entrant ? details.get(entrant) : null;
        return {
          ...row,
          components: detail?.components ?? null,
          regimePerformance: detail?.regimePerformance ?? null,
          stressSurvival: detail?.stressSurvival ?? null,
          gates: detail?.gates ?? null,
        };
      })
    : entrants.map((entrant) => {
        const digest = entrant.digest ?? digestOf(entrant.genome);
        const detail = details.get(entrant);
        return {
          digest,
          species: entrant.species,
          origin: entrant.origin,
          score: round2(scored.get(entrant) ?? 0),
          status: statuses.get(entrant)?.status ?? null,
          gateStatus: statuses.get(entrant)?.gateStatus ?? null,
          reason: statuses.get(entrant)?.reason ?? null,
          research: researchProvenance(entrant),
          components: detail?.components ?? null,
          regimePerformance: detail?.regimePerformance ?? null,
          stressSurvival: detail?.stressSurvival ?? null,
          gates: detail?.gates ?? null,
        };
      });

  const files = {
    "summary.json": summary,
    "candidates.json": candidates,
    "leaderboard.json": summary.leaderboard,
    "champion-league.json": summary.championLeague ?? [],
    "deployment-candidates.json": summary.deploymentCandidates,
    "rounds.json": { funnel: summary.funnel, stageMembers: stageMembers ?? null },
    // Phase 5A.3: dedicated matched-cohort A/B artifact (written only in A/B mode).
    ...(abArtifact ? { "ab-comparison.json": abArtifact } : {}),
  };

  for (const [name, payload] of Object.entries(files)) {
    await writeFile(path.join(dir, name), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  // Reproducibility record: everything needed to re-run this exact arena and
  // get the same result — scoring/evaluator code versions, the walk-forward
  // and evidence config actually used, the deployment gates actually applied,
  // and the exact stress-profile overlay parameters (not just their names, in
  // case defaults change later). Datasets/fingerprints/seeds already live in
  // summary.json, so they are not duplicated here.
  await writeFile(
    path.join(dir, "manifest.json"),
    `${JSON.stringify(
      {
        arenaId,
        schemaVersion: 2,
        arenaRunnerVersion: ARENA_RUNNER_VERSION,
        arenaCacheVersion: ARENA_CACHE_VERSION,
        arenaScoreVersion: ARENA_SCORE_VERSION,
        evaluatorVersion: EVALUATOR_VERSION,
        createdAt: new Date().toISOString(),
        walkForward: config.walkForward ?? null,
        evidenceThresholds: evidence ?? config.evidence ?? null,
        deploymentGates: { ...DEFAULT_DEPLOYMENT_GATES, ...gatesConfig },
        stressProfileDefinitions: Object.fromEntries(
          (stressProfiles.length > 0 ? stressProfiles : Object.keys(STRESS_PROFILES))
            .filter((name) => STRESS_PROFILES[name])
            .map((name) => [name, STRESS_PROFILES[name]]),
        ),
        paperOnly: true,
        note: "Paper research output. No real-money execution exists in this repository.",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return dir;
}

export { shortDigest };
