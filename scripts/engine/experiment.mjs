/**
 * Walk-forward experiment runner.
 *
 * Produces machine-readable research output for a historical dataset:
 *
 *   .evolve/experiments/<experiment-id>/
 *     manifest.json    dataset, fingerprint, config, seeds, windows, code version
 *     summary.json     headline aggregates, baselines, honest failure counts
 *     windows.json     per-window train / validation / test detail
 *     champions.json   the champion records written by this experiment
 *     *.csv            optional flat exports
 *
 * Protocol, per window:
 *   1. TRAIN     one independent evolutionary run per seed (fresh population)
 *   2. select    evidence gates -> train robustness -> species cap -> dedupe
 *   3. VALIDATE  every pooled candidate genome frozen, on unseen data
 *   4. select    validation robustness (median across seeds is reported, never
 *                the single luckiest seed)
 *   5. TEST      survivors frozen again, on data neither stage ever touched
 *   6. BASELINES no-trade / random / momentum / hold on the same windows
 *
 * Nothing in this module can trade real money; every number comes from the
 * simulated paper fill engine.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { shortId } from "../lib/ids.mjs";
import { openDataset } from "../history/dataset.mjs";
import { runBaselines } from "./baselines.mjs";
import {
  DEFAULT_CHAMPIONS_DIR,
  buildChampionRecord,
  championSpeciesDistribution,
  classifyChampion,
  saveChampion,
} from "./champions.mjs";
import { DEFAULT_EVIDENCE, RESULT_CLASS, aggregateSeeds, roundMetric } from "./metrics.mjs";
import { runReplayStage, selectCandidates, planWindows, resolveSeeds, STAGE } from "./walkforward.mjs";

export const EXPERIMENT_SCHEMA_VERSION = 1;

function median(values) {
  const usable = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (usable.length === 0) return null;
  return roundMetric(usable[Math.floor(usable.length / 2)], 6);
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows, columns = null) {
  if (!Array.isArray(rows) || rows.length === 0) return "";
  const keys = columns ?? [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const lines = [keys.join(",")];
  for (const row of rows) {
    lines.push(keys.map((key) => csvEscape(row[key])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

export function experimentIdFor({ datasetId, seeds, startedAt }) {
  const stamp = new Date(startedAt).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const seedTag = shortId("S", seeds.join("-"), 4);
  return `exp-${String(datasetId).slice(0, 24)}-${stamp}-${seedTag}`;
}

/**
 * Run a complete walk-forward experiment.
 *
 * @param {{
 *   datasetDir: string,
 *   config: object,
 *   seeds?: Array<number|string> | null,
 *   maxWindows?: number | null,
 *   minWindows?: number,
 *   write?: boolean,
 *   saveChampions?: boolean,
 *   experimentsDir?: string,
 *   championsDir?: string,
 *   onProgress?: ((info: object) => void) | null,
 *   evidence?: object,
 *   engineVersion?: string | null,
 *   gitCommit?: string | null,
 * }} options
 */
export async function runExperiment({
  datasetDir,
  config,
  seeds = null,
  maxWindows = null,
  minWindows = null,
  write = true,
  saveChampions = true,
  experimentsDir = null,
  championsDir = DEFAULT_CHAMPIONS_DIR,
  onProgress = null,
  evidence = null,
  engineVersion = null,
  gitCommit = null,
} = {}) {
  const startedAt = Date.now();
  const log = (message, detail = null) => {
    if (typeof onProgress === "function") onProgress({ message, detail, at: Date.now() });
  };

  const dataset = await openDataset(datasetDir, { requireManifest: false });
  const integrity = await dataset.verifyFingerprint();
  const firstObservedAt = dataset.firstObservedAt;
  const lastObservedAt = dataset.lastObservedAt;

  if (!Number.isFinite(firstObservedAt) || !Number.isFinite(lastObservedAt)) {
    throw new Error(
      `dataset ${datasetDir} has no usable time range; a finalized manifest with first/last observation timestamps is required`,
    );
  }

  const seedList = seeds && seeds.length > 0 ? seeds : resolveSeeds(config);
  const evidenceThresholds = evidence ?? config.evidence ?? DEFAULT_EVIDENCE;

  const plan = planWindows({
    firstObservedAt,
    lastObservedAt,
    walkForward: config.walkForward,
    minWindows: minWindows ?? config.walkForward?.minWindows ?? 1,
    allowShort: config.walkForward?.allowShortDataset === true,
  });

  log(
    `dataset ${dataset.datasetId} (${dataset.classification ?? "unclassified"}) · ${plan.windows.length} walk-forward window(s) · seeds ${seedList.join(", ")}`,
  );

  const windows = maxWindows ? plan.windows.slice(0, maxWindows) : plan.windows;
  const windowResults = [];
  const championRecords = [];
  const speciesAccumulator = new Map();
  const baselineAccumulator = [];

  for (const wfWindow of windows) {
    log(`\n=== ${wfWindow.label} ===`);
    log(
      `train ${new Date(wfWindow.train.start).toISOString()} → ${new Date(wfWindow.train.end).toISOString()} | ` +
        `validate → ${new Date(wfWindow.validate.end).toISOString()} | test → ${new Date(wfWindow.test.end).toISOString()}`,
    );

    // --- TRAIN: independent evolutionary run per seed ------------------------
    const pool = new Map();
    const trainRuns = [];

    for (const seed of seedList) {
      const run = await runReplayStage({
        datasetDir,
        config,
        interval: wfWindow.train,
        stage: STAGE.TRAIN,
        seed,
        windowLabel: wfWindow.label,
        evidence: evidenceThresholds,
      });

      const selection = selectCandidates(run.candidates, {
        maxCandidates: config.walkForward?.maxCandidates ?? 8,
      });

      log(
        `seed ${seed}: train ${run.ticks} ticks · generation ${run.simulation.generation} · ` +
          `${selection.eligible}/${selection.considered} eligible · ${selection.candidates.length} candidate(s) selected` +
          (selection.excludedForEvidence > 0
            ? ` · ${selection.excludedForEvidence} INSUFFICIENT SAMPLE`
            : ""),
      );

      for (const entry of selection.candidates) {
        // `candidateId` rather than `key`: the public sanitizer drops any field
        // named like a credential, and this identifier must survive to the
        // dashboard and the experiment report.
        const candidateId = `${seed}:${entry.agentId}`;
        const record = {
          candidateId,
          seed,
          digest: entry.genomeDigest,
          genome: entry.genome,
          species: entry.species,
          lineageId: entry.lineageId,
          parents: entry.parents,
          generation: entry.generation,
          sourceAgentId: entry.agentId,
          trainMetrics: entry.metrics,
          trainFitness: entry.fitness,
          genealogy: run.genealogy,
        };
        pool.set(candidateId, record);
      }

      const trainSnapshot = run.simulation.snapshot();

      trainRuns.push({
        seed,
        ticks: run.ticks,
        generations: run.simulation.generation,
        generationTicks: config.engine.generationTicks,
        candidates: selection.candidates.length,
        eligible: selection.eligible,
        considered: selection.considered,
        excludedForEvidence: selection.excludedForEvidence,
        selectionRule: selection.rule,
        populationMetrics: aggregateSeeds(run.candidates.map((entry) => entry.metrics)),
        bestTrainRobustness: selection.candidates[0]?.metrics.robustness ?? null,
        genealogy: run.genealogy.stats({ alive: run.simulation.population.map((agent) => agent.id) }),
        freezeAudit: run.freezeAudit,
        audit: run.audit,
        generationSnapshots: run.generationSnapshots,
        species: trainSnapshot.species,
      });

      for (const speciesEntry of trainSnapshot.species) {
        const current = speciesAccumulator.get(speciesEntry.name) ?? {
          name: speciesEntry.name,
          role: speciesEntry.role,
          births: 0,
          deaths: 0,
          extinctionEvents: 0,
          populationPeak: 0,
          trainReturns: [],
          validationReturns: [],
          testReturns: [],
          championCount: 0,
        };
        current.births += speciesEntry.births ?? 0;
        current.deaths += speciesEntry.deaths ?? 0;
        current.extinctionEvents += speciesEntry.extinctionEvents ?? 0;
        current.populationPeak = Math.max(current.populationPeak, speciesEntry.peakCount ?? 0);
        current.trainReturns.push(speciesEntry.medianReturn ?? 0);
        speciesAccumulator.set(speciesEntry.name, current);
      }
    }

    const seededCandidates = [...pool.values()];
    if (seededCandidates.length === 0) {
      log("no candidate cleared the evidence gates in training for this window");
      windowResults.push({
        label: wfWindow.label,
        index: wfWindow.index,
        window: wfWindow,
        trainRuns,
        candidates: [],
        baselines: [],
        note: "NO CANDIDATES: every trained agent failed the minimum evidence gates",
      });
      continue;
    }

    const deduped = dedupeByDigest(seededCandidates);
    log(`pooled ${seededCandidates.length} candidate(s) from ${seedList.length} seed(s) → ${deduped.length} unique genome(s)`);

    // --- VALIDATE: frozen genomes on unseen data ----------------------------
    const validateStage = await runReplayStage({
      datasetDir,
      config,
      interval: wfWindow.validate,
      stage: STAGE.VALIDATE,
      seed: seedList[0],
      windowLabel: wfWindow.label,
      candidates: deduped.map((candidate) => ({
        genome: candidate.genome,
        species: candidate.species,
        lineageId: candidate.lineageId,
        label: candidate.candidateId,
      })),
      evidence: evidenceThresholds,
    });

    assertFrozen(validateStage, wfWindow.label, STAGE.VALIDATE);

    const byLabel = new Map(
      validateStage.candidates.map((entry) => [entry.label, entry]),
    );

    const evaluated = deduped.map((candidate) => {
      const validation = byLabel.get(candidate.candidateId) ?? null;
      const perSeed = seededCandidates
        .filter((entry) => entry.digest === candidate.digest)
        .map((entry) => ({
          seed: entry.seed,
          trainMetrics: entry.trainMetrics,
        }));

      return {
        ...candidate,
        perSeed,
        validation: validation?.metrics ?? null,
      };
    });

    // --- select survivors by VALIDATION robustness --------------------------
    const survivors = selectValidationSurvivors(evaluated, {
      maxCandidates: config.walkForward?.maxCandidates ?? 8,
      minValidationRobustness: config.walkForward?.minValidationRobustness ?? 0,
    });

    log(
      `validate ${validateStage.ticks} ticks · ${evaluated.length} genome(s) evaluated · ` +
        `${survivors.length} survived validation`,
    );

    let testStage = null;
    if (survivors.length > 0) {
      // --- TEST: frozen survivors on truly unseen data ---------------------
      testStage = await runReplayStage({
        datasetDir,
        config,
        interval: wfWindow.test,
        stage: STAGE.TEST,
        seed: seedList[0],
        windowLabel: wfWindow.label,
        candidates: survivors.map((candidate) => ({
          genome: candidate.genome,
          species: candidate.species,
          lineageId: candidate.lineageId,
          label: candidate.candidateId,
        })),
        evidence: evidenceThresholds,
      });

      assertFrozen(testStage, wfWindow.label, STAGE.TEST);
      log(`test ${testStage.ticks} ticks · ${testStage.candidates.length} frozen genome(s) evaluated`);
    }

    const testByLabel = new Map(
      (testStage?.candidates ?? []).map((entry) => [entry.label, entry]),
    );

    // --- baselines on the same validate + test windows ----------------------
    const baselines = config.baselines?.enabled === false
      ? []
      : [
          ...(await runBaselines({
            datasetDir,
            config,
            interval: wfWindow.validate,
            seed: seedList[0],
            windowLabel: `${wfWindow.label}:validate`,
            evidence: evidenceThresholds,
          })),
          ...(await runBaselines({
            datasetDir,
            config,
            interval: wfWindow.test,
            seed: seedList[0],
            windowLabel: `${wfWindow.label}:test`,
            evidence: evidenceThresholds,
          })),
        ];
    baselineAccumulator.push(...baselines);

    // --- champions ----------------------------------------------------------
    const windowCandidates = evaluated.map((candidate) => {
      const test = testByLabel.get(candidate.candidateId)?.metrics ?? null;
      const validation = candidate.validation;
      const classification = classifyChampion({
        evidence: candidate.trainMetrics?.evidence,
        validation,
        test,
        minValidationRobustness: config.walkForward?.minValidationRobustness ?? 0,
      });

      const trainAggregate = aggregateSeeds(candidate.perSeed.map((entry) => entry.trainMetrics));

      return {
        candidateId: candidate.candidateId,
        digest: candidate.digest,
        species: candidate.species,
        lineageId: candidate.lineageId,
        seeds: candidate.perSeed.map((entry) => entry.seed),
        train: candidate.trainMetrics,
        trainAggregate,
        validation,
        test,
        classification: classification.classification,
        reason: classification.reason,
        overfitWarning:
          classification.testCompleted &&
          Number.isFinite(validation?.robustness) &&
          Number.isFinite(test?.robustness) &&
          test.robustness < validation.robustness - (config.walkForward?.overfitMargin ?? 0.25),
      };
    });

    for (const candidate of windowCandidates) {
      const speciesEntry = speciesAccumulator.get(candidate.species);
      if (speciesEntry) {
        if (Number.isFinite(candidate.validation?.netReturn)) {
          speciesEntry.validationReturns.push(candidate.validation.netReturn);
        }
        if (Number.isFinite(candidate.test?.netReturn)) {
          speciesEntry.testReturns.push(candidate.test.netReturn);
        }
      }
    }

    const survivorKeys = new Set(survivors.map((candidate) => candidate.candidateId));
    for (const candidate of windowCandidates) {
      if (!survivorKeys.has(candidate.candidateId)) continue;

      const source = deduped.find((entry) => entry.candidateId === candidate.candidateId);
      const lineageChain = buildLineageChain(source, wfWindow);

      const record = buildChampionRecord({
        candidate: {
          genome: source.genome,
          species: source.species,
          lineageId: source.lineageId,
          parents: source.parents,
          generation: source.generation,
          agentId: source.sourceAgentId,
          metrics: source.trainMetrics,
        },
        window: wfWindow,
        dataset: {
          datasetId: dataset.datasetId,
          fingerprint: dataset.fingerprint?.combined ?? integrity.computed,
          classification: dataset.classification,
        },
        seeds: candidate.seeds,
        trainAggregate: candidate.trainAggregate,
        validation: candidate.validation,
        test: candidate.test,
        config,
        lineageChain,
      });

      championRecords.push(record);
      const speciesEntry = speciesAccumulator.get(record.species);
      if (speciesEntry) speciesEntry.championCount += 1;

      if (saveChampions && write) {
        await saveChampion(record, { dir: championsDir });
      }
    }

    windowResults.push({
      label: wfWindow.label,
      index: wfWindow.index,
      window: wfWindow,
      trainRuns,
      candidates: windowCandidates,
      survivors: [...survivorKeys],
      baselines,
      freezeAudit: {
        validate: validateStage.freezeAudit,
        test: testStage?.freezeAudit ?? null,
      },
      lookAheadAudit: {
        validate: validateStage.audit,
        test: testStage?.audit ?? null,
      },
    });
  }

  // --- aggregation -----------------------------------------------------------
  const testReturns = windowResults
    .flatMap((entry) => entry.candidates ?? [])
    .map((candidate) => candidate.test?.netReturn)
    .filter(Number.isFinite);
  const validationReturns = windowResults
    .flatMap((entry) => entry.candidates ?? [])
    .map((candidate) => candidate.validation?.netReturn)
    .filter(Number.isFinite);
  const validationRobustness = windowResults
    .flatMap((entry) => entry.candidates ?? [])
    .map((candidate) => candidate.validation?.robustness)
    .filter(Number.isFinite);

  const species = [...speciesAccumulator.values()].map((entry) => ({
    name: entry.name,
    role: entry.role,
    births: entry.births,
    deaths: entry.deaths,
    extinctionEvents: entry.extinctionEvents,
    populationPeak: entry.populationPeak,
    medianTrainReturn: median(entry.trainReturns),
    medianValidationReturn: median(entry.validationReturns),
    medianTestReturn: median(entry.testReturns),
    championCount: entry.championCount,
  }));

  const experimentId = experimentIdFor({ datasetId: dataset.datasetId, seeds: seedList, startedAt });
  const endedAt = Date.now();

  const manifest = {
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    experimentId,
    createdAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationMs: endedAt - startedAt,
    dataset: {
      datasetId: dataset.datasetId,
      dir: datasetDir,
      dataClass: dataset.classification,
      containsSynthetic: dataset.containsSynthetic,
      usableForRealMarketReplay: dataset.manifest?.usableForRealMarketReplay ?? null,
      snapshotCount: dataset.snapshotCount,
      firstObservedAt,
      lastObservedAt,
      durationMinutes: roundMetric((lastObservedAt - firstObservedAt) / 60_000, 3),
      fingerprint: dataset.fingerprint?.combined ?? integrity.computed,
      fingerprintVerified: integrity.ok,
    },
    seeds: seedList,
    config: {
      walkForward: { ...config.walkForward },
      evidence: { ...evidenceThresholds },
      evolution: { ...config.evolution },
      paper: { ...config.paper },
      engine: { ...config.engine },
      baselines: { ...config.baselines },
      minLiquidityUsd: config.minLiquidityUsd,
      universeMax: config.universeMax,
    },
    windowsPlanned: plan.windows.length,
    windowsRun: windowResults.length,
    windowPlanScaled: plan.scaled,
    windowPlanNote: plan.note ?? null,
    engineVersion: engineVersion ?? null,
    gitCommit: gitCommit ?? null,
    paperOnly: true,
    lookAheadPolicy:
      "forward-only replay; each stage reads only its own interval; frozen stages cannot breed",
    reproducibility:
      "same dataset fingerprint + config + seeds reproduce these runs (see scripts/validate-history.mjs)",
  };

  const summary = {
    experimentId,
    dataset: {
      datasetId: dataset.datasetId,
      dataClass: dataset.classification,
      containsSynthetic: dataset.containsSynthetic,
      fingerprint: manifest.dataset.fingerprint,
      snapshotCount: dataset.snapshotCount,
      durationMinutes: manifest.dataset.durationMinutes,
    },
    seeds: seedList,
    windows: windowResults.length,
    windowsWithCandidates: windowResults.filter((entry) => (entry.candidates ?? []).length > 0).length,
    candidatesEvaluated: windowResults.reduce((sum, entry) => sum + (entry.candidates?.length ?? 0), 0),
    champions: championRecords.length,
    championSpecies: championSpeciesDistribution(championRecords),
    classifications: countBy(windowResults.flatMap((entry) => entry.candidates ?? []), "classification"),
    resultCounts: {
      insufficientSample: windowResults
        .flatMap((entry) => entry.candidates ?? [])
        .filter((candidate) => candidate.classification === RESULT_CLASS.INSUFFICIENT_SAMPLE).length,
      failedValidation: windowResults
        .flatMap((entry) => entry.candidates ?? [])
        .filter((candidate) => candidate.classification === RESULT_CLASS.FAILED_VALIDATION).length,
      passedValidation: windowResults
        .flatMap((entry) => entry.candidates ?? [])
        .filter((candidate) => candidate.classification === RESULT_CLASS.PASSED_VALIDATION).length,
      testCompleted: windowResults
        .flatMap((entry) => entry.candidates ?? [])
        .filter((candidate) => candidate.classification === RESULT_CLASS.TEST_COMPLETED).length,
      overfitWarnings: windowResults
        .flatMap((entry) => entry.candidates ?? [])
        .filter((candidate) => candidate.overfitWarning === true).length,
    },
    outOfSample: {
      validationMedianNetReturn: median(validationReturns),
      validationCount: validationReturns.length,
      testMedianNetReturn: median(testReturns),
      testCount: testReturns.length,
      validationMedianRobustness: median(validationRobustness),
      testWorstNetReturn: testReturns.length > 0 ? Math.min(...testReturns) : null,
      testBestNetReturn: testReturns.length > 0 ? Math.max(...testReturns) : null,
    },
    baselines: {
      count: baselineAccumulator.length,
      rows: baselineAccumulator.map((entry) => ({
        id: entry.id,
        window: entry.windowLabel,
        netReturn: entry.metrics.netReturn,
        robustness: entry.metrics.robustness,
        trades: entry.metrics.trades,
        maxDrawdown: entry.metrics.maxDrawdown,
        classification: entry.metrics.classification,
      })),
      medianNetReturn: median(baselineAccumulator.map((entry) => entry.metrics.netReturn)),
    },
    species,
    integrity: {
      fingerprint: manifest.dataset.fingerprint,
      verified: integrity.ok,
    },
    paperOnly: true,
    disclaimer:
      "Historical backtests and paper results do NOT guarantee future profitability. Every number here is simulated paper accounting.",
  };

  const report = {
    experimentId,
    manifest,
    summary,
    windows: windowResults,
    champions: championRecords,
    datasets: { dir: datasetDir, fingerprint: manifest.dataset.fingerprint },
  };

  let reportDir = null;
  if (write) {
    const root = experimentsDir ?? config.experimentsDir ?? path.join(".evolve", "experiments");
    reportDir = path.join(root, experimentId);
    await writeExperimentReport(report, { dir: reportDir });
  }

  log(`\nexperiment ${experimentId} complete`);
  log(
    `champions ${championRecords.length} · test median ${summary.outOfSample.testMedianNetReturn} · ` +
      `insufficient-sample ${summary.resultCounts.insufficientSample}`,
  );

  return { ...report, reportDir };
}

/** Retry-free protocol assertion: frozen stages must not mutate genomes. */
function assertFrozen(stage, windowLabel, stageName) {
  if (!stage.freezeAudit?.immutable) {
    throw new Error(
      `protocol violation: ${stageName} stage for ${windowLabel} mutated ${stage.freezeAudit?.genomesMutated} genome(s)`,
    );
  }
}

function dedupeByDigest(candidates) {
  const byDigest = new Map();
  for (const candidate of candidates) {
    const existing = byDigest.get(candidate.digest);
    if (!existing) {
      byDigest.set(candidate.digest, candidate);
      continue;
    }
    // Prefer the higher-ranked representative but keep both seed attributions.
    if ((candidate.trainMetrics?.robustness ?? -Infinity) > (existing.trainMetrics?.robustness ?? -Infinity)) {
      byDigest.set(candidate.digest, candidate);
    }
  }
  return [...byDigest.values()];
}

function selectValidationSurvivors(evaluated, { maxCandidates, minValidationRobustness }) {
  const eligible = evaluated.filter(
    (candidate) =>
      candidate.validation?.evidence?.sufficient === true &&
      Number.isFinite(candidate.validation.robustness) &&
      candidate.validation.robustness >= minValidationRobustness,
  );

  const ranked = [...eligible].sort(
    (a, b) => (b.validation.robustness ?? -Infinity) - (a.validation.robustness ?? -Infinity),
  );

  const cap = Math.max(2, Math.ceil(maxCandidates / 2));
  const picked = [];
  const speciesCount = new Map();

  for (const candidate of ranked) {
    if (picked.length >= maxCandidates) break;
    const used = speciesCount.get(candidate.species) ?? 0;
    if (used >= cap) continue;
    picked.push(candidate);
    speciesCount.set(candidate.species, used + 1);
  }

  return picked;
}

/** Compact ancestry chain for a champion: newest first, bounded length. */
function buildLineageChain(candidate, wfWindow) {
  const genealogy = candidate?.genealogy ?? null;
  if (!genealogy || typeof genealogy.chain !== "function" || !candidate.sourceAgentId) return [];

  return genealogy.chain(candidate.sourceAgentId, { maxDepth: 12 }).map((step) => ({
    agentId: step.agentId,
    generation: step.generation,
    species: step.species,
    origin: step.origin,
    lineageId: step.lineageId,
    parents: step.parents,
    window: wfWindow.label,
  }));
}

function countBy(rows, key) {
  const counts = {};
  for (const row of rows) {
    const value = row?.[key] ?? "unknown";
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

/** Write the full experiment report set to disk. */
export async function writeExperimentReport(report, { dir }) {
  await mkdir(dir, { recursive: true });

  const files = {
    "manifest.json": report.manifest,
    "summary.json": report.summary,
    "windows.json": report.windows,
    "champions.json": report.champions,
  };

  for (const [name, value] of Object.entries(files)) {
    await writeFile(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  const windowRows = report.windows.flatMap((entry) =>
    (entry.candidates ?? []).map((candidate) => ({
      window: entry.label,
      candidateId: candidate.candidateId,
      digest: candidate.digest,
      species: candidate.species,
      seeds: candidate.seeds.join("|"),
      trainNetReturn: candidate.train?.netReturn ?? null,
      trainRobustness: candidate.train?.robustness ?? null,
      validationNetReturn: candidate.validation?.netReturn ?? null,
      validationRobustness: candidate.validation?.robustness ?? null,
      testNetReturn: candidate.test?.netReturn ?? null,
      testRobustness: candidate.test?.robustness ?? null,
      testDrawdown: candidate.test?.maxDrawdown ?? null,
      trades: candidate.validation?.trades ?? null,
      distinctMints: candidate.validation?.distinctMints ?? null,
      classification: candidate.classification,
      overfitWarning: candidate.overfitWarning === true,
    })),
  );

  const championRows = report.champions.map((champion) => ({
    id: champion.id,
    species: champion.species,
    lineageId: champion.lineageId,
    window: champion.window?.label ?? null,
    seeds: (champion.seeds ?? []).join("|"),
    classification: champion.classification,
    validationRobustness: champion.validationMetrics?.robustness ?? null,
    validationNetReturn: champion.validationMetrics?.netReturn ?? null,
    testNetReturn: champion.testMetrics?.netReturn ?? null,
    testDrawdown: champion.testMetrics?.maxDrawdown ?? null,
    tradeCount: champion.tradeCount,
    distinctMints: champion.distinctMints,
    costs: champion.costs,
    overfitWarning: champion.overfitWarning === true,
    genomeDigest: champion.genomeDigest,
  }));

  const baselineRows = report.summary.baselines.rows.map((row) => ({
    id: row.id,
    window: row.window,
    netReturn: row.netReturn,
    robustness: row.robustness,
    trades: row.trades,
    maxDrawdown: row.maxDrawdown,
    classification: row.classification,
  }));

  await writeFile(path.join(dir, "windows.csv"), toCsv(windowRows), "utf8");
  await writeFile(path.join(dir, "champions.csv"), toCsv(championRows), "utf8");
  await writeFile(path.join(dir, "baselines.csv"), toCsv(baselineRows), "utf8");

  return dir;
}
