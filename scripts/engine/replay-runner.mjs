#!/usr/bin/env node
/**
 * Historical replay engine.
 *
 * Runs the same evolutionary paper simulation as the live engine, but the
 * environment is a recorded dataset instead of the live Solana market feed:
 *
 *   live engine      feed = Jupiter / synthetic      clock = wall clock
 *   replay engine    feed = recorded snapshots       clock = dataset timestamps
 *
 * Because `createSimulation` only ever talks to `feed.markets()` / `feed.health()`
 * and to a `now()` function, nothing in the evolutionary or paper-trading code
 * changes between the two — which is exactly the property that makes replay a
 * fair experiment rather than a second implementation.
 *
 * Determinism: randomness comes from `EVOLVE_SEED` through `createSeededRandom`,
 * ids come from a deterministic factory, and time comes from the dataset. The
 * process may run at 1x, 100x or unthrottled (`max`) without changing a single
 * decision, because speed only affects how long the process waits.
 *
 * PAPER ONLY. No wallet, no keys, no signing, no transaction submission.
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { openDataset } from "../history/dataset.mjs";
import { serializeForPublic } from "../lib/sanitize.mjs";
import { createIdFactory } from "../lib/ids.mjs";
import { createSeededRandom } from "../lib/random.mjs";
import { publicConfig } from "../market/config.mjs";
import { REPLAY_BANNER, openReplayFeed } from "../market/replay.mjs";
import { createDatasetClock } from "./clock.mjs";
import { createGenealogy } from "./genealogy.mjs";
import { createSimulation } from "./simulation.mjs";
import { planWindows } from "./walkforward.mjs";

export const REPLAY_STAGES = Object.freeze({
  TRAIN: "TRAIN",
  VALIDATE: "VALIDATE",
  TEST: "TEST",
});

export const DEFAULT_REPLAY_STATE_FILE = "replay-state.json";

/** Which stage a plain replay run represents, and whether evolution is frozen. */
export function resolveReplayStage(raw) {
  const value = String(raw ?? "train").trim().toLowerCase();
  if (value === "validate" || value === "validation") {
    return { stage: REPLAY_STAGES.VALIDATE, frozen: true, forced: true };
  }
  if (value === "test") return { stage: REPLAY_STAGES.TEST, frozen: true, forced: true };
  if (value === "frozen") return { stage: REPLAY_STAGES.TRAIN, frozen: true, forced: true };
  return { stage: REPLAY_STAGES.TRAIN, frozen: false, forced: false };
}

const MINUTE_MS = 60_000;

/**
 * Plan the walk-forward windows for a dataset so the replay display can show
 * where in the timeline the cursor is. A dataset that is too short is not an
 * error here: the plan is reported as unavailable with the reason.
 */
export function planReplayWindows({ dataset, config }) {
  try {
    const plan = planWindows({
      firstObservedAt: dataset.firstObservedAt,
      lastObservedAt: dataset.lastObservedAt,
      walkForward: config.walkForward,
      minWindows: config.walkForward?.minWindows ?? 1,
      allowShort: true,
    });
    return {
      ok: true,
      scaled: plan.scaled === true,
      note: plan.note ?? null,
      requiredMs: plan.requiredMs ?? null,
      windows: plan.windows.map((entry) => ({
        label: entry.label,
        index: entry.index,
        seed: entry.seed,
        train: { start: entry.train.start, end: entry.train.end },
        validate: { start: entry.validate.start, end: entry.validate.end },
        test: { start: entry.test.start, end: entry.test.end },
      })),
    };
  } catch (error) {
    return {
      ok: false,
      scaled: false,
      note: String(error?.message ?? error),
      requiredMs: null,
      windows: [],
    };
  }
}

/** Which walk-forward window and stage a dataset timestamp falls into. */
export function locateInPlan(plan, timestamp) {
  if (!plan?.ok || !Number.isFinite(timestamp)) {
    return { windowIndex: null, windowLabel: null, stage: null, totalWindows: plan?.windows?.length ?? 0 };
  }

  const total = plan.windows.length;
  for (const entry of plan.windows) {
    if (timestamp < entry.train.end) {
      return { windowIndex: entry.index, windowLabel: entry.label, stage: REPLAY_STAGES.TRAIN, totalWindows: total, window: entry };
    }
    if (timestamp < entry.validate.end) {
      return { windowIndex: entry.index, windowLabel: entry.label, stage: REPLAY_STAGES.VALIDATE, totalWindows: total, window: entry };
    }
    if (timestamp < entry.test.end) {
      return { windowIndex: entry.index, windowLabel: entry.label, stage: REPLAY_STAGES.TEST, totalWindows: total, window: entry };
    }
  }

  const last = plan.windows[total - 1] ?? null;
  return {
    windowIndex: last ? last.index : null,
    windowLabel: last ? last.label : null,
    stage: last ? REPLAY_STAGES.TEST : null,
    totalWindows: total,
    window: last,
  };
}

/**
 * Build a replay engine (no loop started). Useful for validation and embedding.
 */
export async function createReplayEngine({
  config,
  datasetDir = null,
  speed = undefined,
  from = null,
  until = null,
  limit = 0,
  writing = true,
} = {}) {
  const target = datasetDir ?? config.replay.dataset;
  if (!target) {
    throw new Error(
      "replay mode needs a dataset: set EVOLVE_REPLAY_DATASET=/path/to/session or pass one on the command line",
    );
  }

  const dataset = await openDataset(target, { requireManifest: false });
  const stageInfo = resolveReplayStage(process.env.EVOLVE_REPLAY_STAGE);

  const feed = await openReplayFeed({
    datasetDir: target,
    config,
    speed: speed ?? config.replay.speed,
    from,
    until,
    limit: limit || config.replay.limit,
    now: () => Date.now(),
    pacing: config.replay.pacing !== false,
    verifyFingerprint: config.replay.verifyFingerprint === true,
    onEvent: null,
  });

  const clock = createDatasetClock(feed);
  const genealogy = createGenealogy({});
  const simulation = createSimulation({
    config,
    feed,
    now: clock.now,
    random: createSeededRandom(config.seed),
    ids: createIdFactory({ prefix: "R" }),
    evolution: stageInfo.frozen ? { enabled: false } : { enabled: true, ...config.evolution },
    marketScanLimit: config.replay.marketScanLimit,
    recordTrades: true,
    genealogy,
  });

  const windowPlan = planReplayWindows({ dataset, config });

  return {
    config,
    dataset,
    datasetDir: target,
    feed,
    clock,
    simulation,
    stageInfo,
    windowPlan,
    speed: speed ?? config.replay.speed,
    writing,
  };
}

/**
 * Run a full replay to the end of the dataset window.
 *
 * @param {{
 *   config: object,
 *   datasetDir?: string | null,
 *   dir?: string,
 *   stateFile?: string | null,
 *   speed?: number | "max",
 *   limit?: number,
 *   onProgress?: ((info: object) => void) | null,
 *   persistEvery?: number,
 *   maxTicks?: number,
 *   shouldStop?: (() => boolean) | null,
 * }} options
 */
export async function runReplay({
  config,
  datasetDir = null,
  dir = ".evolve",
  stateFile = null,
  speed = undefined,
  limit = 0,
  onProgress = null,
  persistEvery = null,
  maxTicks = 0,
  shouldStop = null,
} = {}) {
  const engine = await createReplayEngine({ config, datasetDir, speed, limit });
  const { feed, simulation, dataset, windowPlan, stageInfo } = engine;

  const file = stateFile ?? config.replay.stateFile ?? DEFAULT_REPLAY_STATE_FILE;
  const writeEvery = Math.max(1, persistEvery ?? config.replay.writeStateEveryTicks ?? 20);

  let ticks = 0;
  let stopping = false;
  let lastProgress = null;

  const buildState = (extra = {}) => {
    const timestamp = feed.currentTimestamp();
    const location = locateInPlan(windowPlan, timestamp);
    const snapshot = simulation.snapshot();
    const progress = feed.progress();

    return {
      ...snapshot,
      config: publicConfig(config),
      research: {
        ...snapshot.research,
        mode: "replay",
        banner: REPLAY_BANNER,
        stage: stageInfo.forced ? stageInfo.stage : location.stage ?? stageInfo.stage,
        stageForced: stageInfo.forced,
        evolutionFrozen: stageInfo.frozen,
        seed: config.seed,
        seeds: config.evalSeeds.length > 0 ? config.evalSeeds : [config.seed],
        dataset: {
          id: dataset.datasetId,
          dir: engine.datasetDir,
          dataClass: dataset.classification,
          containsSynthetic: dataset.containsSynthetic,
          usableForRealMarketReplay: dataset.manifest?.usableForRealMarketReplay ?? null,
          snapshotCount: dataset.snapshotCount,
          uniqueMints: dataset.manifest?.uniqueMintCount ?? null,
          firstObservedAt: dataset.firstObservedAt,
          lastObservedAt: dataset.lastObservedAt,
          durationMinutes: Number.isFinite(dataset.durationMs)
            ? Math.round((dataset.durationMs / MINUTE_MS) * 1000) / 1000
            : null,
          fingerprint: dataset.fingerprint?.combined ?? null,
          integrityVerified: engine.feed.fingerprintCheck?.ok ?? null,
        },
        windows: {
          planned: windowPlan.windows.length,
          scaled: windowPlan.scaled,
          note: windowPlan.note,
          current: location.windowIndex === null ? null : location.windowIndex + 1,
          currentLabel: location.windowLabel,
          stage: location.stage,
          total: windowPlan.windows.length,
          detail: windowPlan.windows,
        },
        replay: {
          timestamp,
          speed: engine.speed,
          snapshotsRead: progress.snapshotsRead,
          totalSnapshots: progress.totalSnapshots,
          progressPct: progress.percent,
          firstTimestamp: progress.firstTimestamp,
          lastTimestamp: progress.lastTimestamp,
          wallPacedMs: progress.wallPacedMs,
          ticks,
          finished: feed.finished === true,
        },
        note:
          "Historical replay of recorded paper observations. Backtests and paper results do NOT guarantee future profitability.",
        disclaimer:
          "PAPER ONLY. Historical backtests and paper results do NOT guarantee future profitability. Every value here is simulated paper accounting.",
        ...extra,
      },
    };
  };

  const persist = async (extra = {}) => {
    // `serializeForPublic` both strips non-finite numbers/secrets and produces
    // the exact bytes the dashboard route will read back.
    const state = buildState(extra);
    const payload = serializeForPublic(state);
    await mkdir(dir, { recursive: true });
    const target = path.join(dir, file);
    const temp = `${target}.tmp`;
    await writeFile(temp, payload, "utf8");
    await rename(temp, target);
    return state;
  };

  const report = (info) => {
    if (typeof onProgress === "function") onProgress(info);
  };

  await persist();

  report({
    type: "start",
    datasetId: dataset.datasetId,
    dataClass: dataset.classification,
    windows: windowPlan.windows.length,
    speed: engine.speed,
  });

  const interrupted = () => (typeof shouldStop === "function" ? shouldStop() === true : false);

  while (!stopping && !interrupted()) {
    const step = await feed.advance();
    if (step.done) break;

    simulation.advanceTick();
    ticks += 1;

    if (ticks % writeEvery === 0) {
      const payload = await persist();
      lastProgress = payload.research.replay.progressPct;
      report({
        type: "tick",
        ticks,
        timestamp: feed.currentTimestamp(),
        progress: lastProgress,
        stage: payload.research.stage,
      });
    }

    if (maxTicks > 0 && ticks >= maxTicks) {
      stopping = true;
    }
  }

  const interruptedEarly = interrupted() && feed.finished !== true;
  feed.stop();
  const payload = await persist({
    completedAt: new Date().toISOString(),
    interrupted: interruptedEarly,
  });

  return {
    state: payload,
    ticks,
    dataset,
    datasetDir: engine.datasetDir,
    simulation,
    feed,
    stageInfo,
    windowPlan,
    statePath: path.join(dir, file),
    classification: dataset.classification,
    interrupted: interruptedEarly,
  };
}
