/**
 * Arena evaluation engine.
 *
 * Evaluates candidate genomes across datasets x windows x seeds x stress
 * profiles using the SAME replay feed and paper fill engine as Phase 3 — the
 * arena adds friction overlays and aggregation, not new market data.
 *
 * Hard rules:
 *   - agents never alter simulated market prices
 *   - stressed runs change execution friction only, never observations
 *   - results are deterministic for a given (dataset, genome, seed, stress)
 *   - caches are keyed by all of those inputs plus code versions
 *
 * Everything is PAPER ONLY.
 */

import { digestOf } from "../lib/hash.mjs";
import { planWindows, runReplayStage, STAGE } from "../engine/walkforward.mjs";
import { openDataset } from "../history/dataset.mjs";
import { DEFAULT_EVIDENCE } from "../engine/metrics.mjs";
import {
  arenaCacheKey,
  readArenaCache,
  writeArenaCache,
  applyStressToPaper,
  getStressProfile,
  aggregateCandidateEvaluation,
  STRESS_PROFILES,
} from "./orchestrator.mjs";

export const EVALUATOR_VERSION = 1;

/** Deep-freeze a plain object (used for stress overlay configs). */
function freezeDeep(value) {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) freezeDeep(value[key]);
    Object.freeze(value);
  }
  return value;
}

/**
 * Build a stress-aware evaluation config from the engine config + a profile.
 * Paper starting cash is preserved; friction fields are overwritten by the
 * overlay; observation delay / missing snapshots are recorded separately so the
 * runner can apply them without touching price data.
 */
export function buildStressedConfig(config, profileName) {
  const profile = getStressProfile(profileName);
  const paper = applyStressToPaper(config.paper, profile);
  const stressed = {
    ...config,
    paper: freezeDeep({ ...config.paper, ...paper }),
  };
  return { config: stressed, profile };
}

/** Canonical genome digest used in cache keys. */
export function genomeDigestOf(candidate) {
  if (candidate?.digest) return candidate.digest;
  return digestOf(candidate?.genome ?? {});
}

/** Plan test windows for one dataset (no look-ahead; forward-tiling). */
export async function planDatasetWindows(datasetDir, config, { maxWindows = null, minWindows = 1, allowShort = false } = {}) {
  const dataset = await openDataset(datasetDir, { requireManifest: false });
  if (!Number.isFinite(dataset.firstObservedAt) || !Number.isFinite(dataset.lastObservedAt)) {
    return { windows: [], dataset, error: "dataset has no usable time range" };
  }
  const plan = planWindows({
    firstObservedAt: dataset.firstObservedAt,
    lastObservedAt: dataset.lastObservedAt,
    walkForward: config.walkForward,
    minWindows,
    allowShort,
  });
  const windows = maxWindows ? plan.windows.slice(0, maxWindows) : plan.windows;
  return { windows, dataset, scaled: plan.scaled === true, error: null };
}


/**
 * Evaluate one candidate genome on one dataset.
 *
 * @param {{
 *   candidate: { genome: object, species?: string, digest?: string, label?: string },
 *   datasetDir: string,
 *   config: object,
 *   seeds: Array<number|string>,
 *   stressProfiles?: string[],
 *   maxWindows?: number|null,
 *   windowsOverride?: Array<object>|null,
 *   evidence?: object,
 *   cacheDir?: string|null,
 *   useCache?: boolean,
 *   onProgress?: ((info: object) => void) | null,
 * }} options
 */
export async function evaluateCandidateOnDataset({
  candidate,
  datasetDir,
  config,
  seeds,
  stressProfiles = ["none"],
  maxWindows = null,
  windowsOverride = null,
  evidence = null,
  cacheDir = null,
  useCache = true,
  onProgress = null,
}) {
  const digest = genomeDigestOf(candidate);
  const evidenceGates = evidence ?? DEFAULT_EVIDENCE;
  let windows;
  if (windowsOverride && windowsOverride.length > 0) {
    windows = windowsOverride;
  } else {
    const planned = await planDatasetWindows(datasetDir, config, { maxWindows, allowShort: true });
    windows = planned.windows;
  }
  if (maxWindows && windows.length > maxWindows) windows = windows.slice(0, maxWindows);

  if (windows.length === 0) {
    return {
      datasetDir,
      digest,
      windows: [],
      seedRuns: [],
      stressRuns: [],
      error: "no usable windows",
    };
  }

  const windowPlan = windows.map((w) => ({ label: w.label, start: w.test.start, end: w.test.end }));

  // ---- OOS evaluation: each seed x window, on the TEST interval, frozen. ----
  const oosRuns = [];
  for (const seed of seeds) {
    for (const window of windows) {
      const key = arenaCacheKey({
        genomeDigest: digest,
        datasetFingerprints: [await datasetFingerprint(datasetDir)],
        seed,
        stage: "oos",
        stressProfile: "none",
        windowPlan: [window.label],
      });

      let run = useCache && cacheDir ? await readArenaCache(cacheDir, key) : null;
      if (!run) {
        const { config: stageConfig } = buildStressedConfig(config, "none");
        const stage = await runReplayStage({
          datasetDir,
          config: stageConfig,
          interval: window.test,
          stage: STAGE.TEST,
          seed: `${seed}:${window.label}`,
          candidates: [{ genome: candidate.genome, species: candidate.species ?? "Arena" }],
          recordTrades: true,
          evidence: evidenceGates,
        });
        const agent = stage.candidates[0];
        run = {
          seed,
          window: window.label,
          metrics: agent?.metrics ?? null,
          ticks: stage.ticks,
          fromCache: false,
        };
        if (useCache && cacheDir) await writeArenaCache(cacheDir, key, run);
      } else {
        run = { ...run, fromCache: true };
      }
      // Tagged per-run (not just on the wrapping evaluation object): the
      // caller flattens oosRuns/stressRuns from every dataset into one array
      // per candidate, so the regime lookup in aggregateCandidateEvaluation
      // needs each run to know which dataset — and therefore which window's
      // regime map — it belongs to.
      run.datasetDir = datasetDir;

      oosRuns.push(run);
      if (onProgress) onProgress({ stage: "OOS", seed, window: window.label, ticks: run.ticks });
    }
  }

  // ---- Stress evaluation: TEST interval of the LAST window per profile. ----
  const stressRuns = [];
  const stressWindow = windows[windows.length - 1];
  for (const seed of seeds) {
    for (const profileName of stressProfiles) {
      if (profileName === "none") continue;
      const key = arenaCacheKey({
        genomeDigest: digest,
        datasetFingerprints: [await datasetFingerprint(datasetDir)],
        seed,
        stage: "stress",
        stressProfile: profileName,
        windowPlan: [stressWindow.label],
      });

      let run = useCache && cacheDir ? await readArenaCache(cacheDir, key) : null;
      if (!run) {
        const { config: stageConfig } = buildStressedConfig(config, profileName);
        const stage = await runReplayStage({
          datasetDir,
          config: stageConfig,
          interval: stressWindow.test,
          stage: STAGE.TEST,
          seed: `${seed}:${profileName}:${stressWindow.label}`,
          candidates: [{ genome: candidate.genome, species: candidate.species ?? "Arena" }],
          recordTrades: true,
          evidence: evidenceGates,
        });
        const agent = stage.candidates[0];
        run = {
          seed,
          profile: profileName,
          window: stressWindow.label,
          metrics: agent?.metrics ?? null,
          ticks: stage.ticks,
          fromCache: false,
        };
        if (useCache && cacheDir) await writeArenaCache(cacheDir, key, run);
      } else {
        run = { ...run, fromCache: true };
      }
      run.datasetDir = datasetDir;

      stressRuns.push(run);
      if (onProgress) onProgress({ stage: "STRESS", seed, profile: profileName, ticks: run.ticks });
    }
  }

  return { datasetDir, digest, windows: windowPlan, oosRuns, stressRuns, error: null };
}

let fingerprintCache = new Map();
export async function datasetFingerprint(datasetDir) {
  if (fingerprintCache.has(datasetDir)) return fingerprintCache.get(datasetDir);
  const { fingerprintDataset } = await import("../history/dataset.mjs");
  const computed = await fingerprintDataset(datasetDir);
  const combined = computed.combined ?? datasetDir;
  fingerprintCache.set(datasetDir, combined);
  return combined;
}

/**
 * Aggregate one candidate's evaluation into Arena Score components.
 * Owned by the orchestrator (pure function); re-exported for convenience.
 */
export { aggregateCandidateEvaluation, STRESS_PROFILES };
