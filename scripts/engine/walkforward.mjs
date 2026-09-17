/**
 * Walk-forward evolution.
 *
 * The research question Phase 3 exists to answer is whether evolved behaviour
 * generalises to market periods the population never saw. The mechanism is a
 * strict three-stage protocol with a hard wall between stages:
 *
 *   TRAIN      the population trades, reproduces, mutates, crosses over, dies.
 *              Anything may adapt here.
 *   VALIDATE   candidate genomes are FROZEN and evaluated on unseen data.
 *              No breeding, no selection pressure, no parameter edits.
 *              Validation ranks lineages; it cannot change them.
 *   TEST       survivors are FROZEN again and evaluated on data that is unseen
 *              by both training and validation. Nothing adapts. Ever.
 *
 * Structural guarantees rather than good intentions:
 *   - each stage opens its own replay feed restricted to its own time interval,
 *     so a stage physically cannot read another stage's snapshots
 *   - the frozen stages run with `evolution.enabled = false`, which disables
 *     breeding in the simulation and is asserted by genome-digest comparison
 *   - the replay provider is forward-only and rejects future timestamps
 *   - genomes are identified by content digest, so "the same genome" is a fact,
 *     not a hope
 */

import { digestOf } from "../lib/hash.mjs";
import { createIdFactory, shortId } from "../lib/ids.mjs";
import { createSeededRandom } from "../lib/random.mjs";
import { createDatasetClock } from "./clock.mjs";
import { createGenealogy } from "./genealogy.mjs";
import { DEFAULT_EVIDENCE, evaluateMetrics, summarizeStage } from "./metrics.mjs";
import { createSimulation } from "./simulation.mjs";

export const STAGE = Object.freeze({
  TRAIN: "TRAIN",
  VALIDATE: "VALIDATE",
  TEST: "TEST",
});

const MINUTE_MS = 60_000;

/** Slot plan for one walk-forward window. */
export function planWindow({ start, index, trainMinutes, validateMinutes, testMinutes, stepMinutes }) {
  const trainStart = start;
  const trainEnd = trainStart + trainMinutes * MINUTE_MS;
  const validateEnd = trainEnd + validateMinutes * MINUTE_MS;
  const testEnd = validateEnd + testMinutes * MINUTE_MS;

  return {
    index,
    label: `W${index + 1}`,
    seed: shortId("WF", `${trainStart}:${index}`),
    train: { start: trainStart, end: trainEnd, minutes: trainMinutes },
    validate: { start: trainEnd, end: validateEnd, minutes: validateMinutes },
    test: { start: validateEnd, end: testEnd, minutes: testMinutes },
    stepMs: stepMinutes * MINUTE_MS,
  };
}

/**
 * Plan non-overlapping test windows that tile the dataset forward.
 *
 * Windows step by `stepMinutes`, so training periods overlap by design (that is
 * what walk-forward means) while each window's test period is data that later
 * windows may train on but earlier ones never saw — the "unseen" direction is
 * always forward in time.
 */
export function planWindows({ firstObservedAt, lastObservedAt, walkForward, minWindows = 1, allowShort = false }) {
  const duration = lastObservedAt - firstObservedAt;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("dataset has no usable time range; cannot plan walk-forward windows");
  }

  const windows = [];
  let start = firstObservedAt;
  let index = 0;

  while (true) {
    const window = planWindow({ start, index, ...{ trainMinutes: walkForward.trainMinutes, validateMinutes: walkForward.validateMinutes, testMinutes: walkForward.testMinutes, stepMinutes: walkForward.stepMinutes } });
    if (window.test.end > lastObservedAt) break;
    windows.push(window);
    start += window.stepMs;
    index += 1;
    if (index > 10_000) break;
  }

  const requiredMs =
    (walkForward.trainMinutes + walkForward.validateMinutes + walkForward.testMinutes) * MINUTE_MS;

  if (windows.length < minWindows) {
    const availableMinutes = duration / MINUTE_MS;
    const suggestion = suggestShortConfig(availableMinutes);
    const message = [
      `dataset is too short for the requested walk-forward windows.`,
      `  dataset duration : ${availableMinutes.toFixed(2)} minutes (${(duration / 3_600_000).toFixed(2)}h)`,
      `  required         : ${(requiredMs / MINUTE_MS).toFixed(2)} minutes for one window`,
      `  windows found    : ${windows.length} (need >= ${minWindows})`,
      `  suggested (development) config: EVOLVE_WF_TRAIN_MINUTES=${suggestion.trainMinutes} EVOLVE_WF_VALIDATE_MINUTES=${suggestion.validateMinutes} EVOLVE_WF_TEST_MINUTES=${suggestion.testMinutes} EVOLVE_WF_STEP_MINUTES=${suggestion.stepMinutes}`,
    ].join("\n");

    if (!allowShort) {
      const error = new Error(message);
      error.code = "WF_DATASET_TOO_SHORT";
      error.suggestion = suggestion;
      throw error;
    }

    // Explicit development mode: shrink the windows to what the data supports.
    const scaled = {
      trainMinutes: suggestion.trainMinutes,
      validateMinutes: suggestion.validateMinutes,
      testMinutes: suggestion.testMinutes,
      stepMinutes: suggestion.stepMinutes,
    };
    let cursor = firstObservedAt;
    let scaledIndex = 0;
    while (true) {
      const window = planWindow({ start: cursor, index: scaledIndex, ...scaled });
      if (window.test.end > lastObservedAt) break;
      windows.push(window);
      cursor += window.stepMs;
      scaledIndex += 1;
      if (scaledIndex > 10_000) break;
    }

    return { windows, durationMs: duration, scaled: true, requiredMs, note: message };
  }

  return { windows, durationMs: duration, scaled: false, requiredMs };
}

/** A smaller configuration that the dataset can actually support. */
export function suggestShortConfig(availableMinutes) {
  const perWindow = availableMinutes / 2.5;
  const round2 = (value) => Math.max(0.01, Math.round(value * 100) / 100);
  return {
    trainMinutes: round2(perWindow * 0.5),
    validateMinutes: round2(perWindow * 0.25),
    testMinutes: round2(perWindow * 0.25),
    stepMinutes: round2(perWindow * 0.25),
  };
}

export function windowsOverlapIncorrectly(a, b) {
  // Test periods must never overlap; steps smaller than the test window would do that.
  return a.test.start < b.test.end && b.test.start < a.test.end;
}

/**
 * Resolve the seed set for an experiment.
 * One seed is not evidence, so the default is a small deliberate fan-out.
 */
export function resolveSeeds(config) {
  const configured = Array.isArray(config.evalSeeds) ? config.evalSeeds : [];
  if (configured.length > 0) return configured;
  if (config.seed === undefined || config.seed === null || config.seed === "") return [1, 2, 3];
  return [config.seed];
}

/**
 * Run one stage over one interval.
 *
 * @param {{
 *   datasetDir: string,
 *   config: object,
 *   interval: { start: number, end: number },
 *   stage: string,
 *   seed: number | string,
 *   windowLabel?: string,
 *   candidates?: object[] | null,
 *   evolution?: object | null,
 *   genealogy?: object | null,
 *   recordTrades?: boolean,
 *   onProgress?: ((info: object) => void) | null,
 *   evidence?: object,
 * }} options
 */
export async function runReplayStage({
  datasetDir,
  config,
  interval,
  stage,
  seed,
  windowLabel = "W1",
  candidates = null,
  evolution = null,
  genealogy = null,
  recordTrades = true,
  onProgress = null,
  evidence = DEFAULT_EVIDENCE,
}) {
  const { openReplayFeed } = await import("../market/replay.mjs");

  const random = createSeededRandom(`${seed}:${stage}:${windowLabel}:${interval.start}`);
  const ids = createIdFactory({ prefix: stage === STAGE.TRAIN ? "A" : "C" });
  const ancestry = genealogy ?? createGenealogy({});

  const feed = await openReplayFeed({
    datasetDir,
    config,
    speed: "max",
    from: interval.start,
    until: interval.end,
    now: () => Date.now(),
    pacing: false,
    verifyFingerprint: false,
  });

  const clock = createDatasetClock(feed);
  const frozen = stage !== STAGE.TRAIN;

  const simulation = createSimulation({
    config,
    feed,
    now: clock.now,
    random,
    ids,
    evolution: frozen
      ? { ...(evolution ?? {}), enabled: false }
      : { enabled: true, ...(config.evolution ?? {}), ...(evolution ?? {}) },
    fixedPopulation: frozen ? candidates : null,
    marketScanLimit: frozen ? 0 : (config.replay?.marketScanLimit ?? 0),
    recordTrades,
    genealogy: ancestry,
  });

  const genomeDigestsBefore = new Map(
    simulation.population.map((agent) => [agent.id, digestOf(agent.genome)]),
  );

  let ticks = 0;
  let firstTimestamp = null;
  let lastTimestamp = null;

  const generationSnapshots = [];

  while (true) {
    const step = await feed.advance();
    if (step.done) break;

    firstTimestamp ??= feed.currentTimestamp();
    lastTimestamp = feed.currentTimestamp();

    const generationBefore = simulation.generation;
    simulation.advanceTick();
    ticks += 1;

    if (simulation.generation > generationBefore) {
      // Harvest the best agents of each completed generation for lineage depth.
      const ranked = [...simulation.population].sort((a, b) => b.equity - a.equity);
      generationSnapshots.push({
        generation: generationBefore,
        bestAgentId: ranked[0]?.id ?? null,
        bestLineageId: ranked[0]?.lineageId ?? null,
        bestSpecies: ranked[0]?.species ?? null,
        equity: ranked[0]?.equity ?? null,
      });
    }

    if (onProgress && ticks % 25 === 0) {
      onProgress({ stage, ticks, timestamp: feed.currentTimestamp(), progress: feed.progress() });
    }
  }

  // Realize the measured period: settle open paper positions at their last
  // observed mark so the stage's P&L is closed, not floating.
  const settled = simulation.settle({ reason: "STAGE-END" });

  feed.stop();

  if (ticks === 0) {
    throw new Error(
      `${stage} stage for ${windowLabel} saw no snapshots in [${new Date(interval.start).toISOString()} .. ${new Date(interval.end).toISOString()}]`,
    );
  }

  const startingCash = config.paper.startingCash;
  const evaluated = simulation.population.map((agent) => {
    // Stage accounting: current-generation net equity (fitness basis) combined
    // with cumulative trades/mints/costs/exposure over the whole stage.
    const metrics = summarizeStage(agent, { startingCash });
    const scored = evaluateMetrics(metrics, { evidence });

    const digest = digestOf(agent.genome);
    return {
      agentId: agent.id,
      label: agent.label,
      species: agent.species,
      lineageId: agent.lineageId,
      origin: agent.origin,
      parents: agent.parents,
      generation: agent.born,
      genomeDigest: digest,
      genome: agent.genome,
      fitness: Number.isFinite(agent.fitness) ? Number(agent.fitness.toFixed(6)) : 0,
      metrics: scored,
      stage: {
        trades: agent.stageTrades ?? 0,
        costs: Number((agent.stageCosts ?? 0).toFixed(4)),
        netPnl: Number((agent.stagePnl ?? 0).toFixed(4)),
        exposureTicks: agent.stageExposureTicks ?? 0,
        observations: agent.stageObservations ?? 0,
      },
    };
  });

  const mutated = evaluated.filter(
    (entry) => genomeDigestsBefore.get(entry.agentId) !== entry.genomeDigest,
  );

  return {
    stage,
    seed,
    windowLabel,
    interval,
    frozen,
    ticks,
    settled,
    firstTimestamp,
    lastTimestamp,
    simulation,
    feed,
    genealogy: ancestry,
    candidates: evaluated,
    generationSnapshots,
    freezeAudit: {
      stage,
      frozen,
      genomesChecked: evaluated.length,
      genomesMutated: mutated.length,
      immutable: mutated.length === 0,
      note: frozen
        ? "frozen stage: no breeding, no selection pressure, no parameter edits"
        : "training stage: evolution is expected and allowed",
    },
    progress: feed.progress(),
    audit: feed.lookAheadAudit(),
  };
}

/**
 * Rank training agents into candidate genomes.
 *
 * Selection rule (transparent, and not purely P&L):
 *   1. evidence gates must pass (trades, distinct mints, observations, exposure)
 *   2. rank by TRAIN robustness score, which already penalises drawdown,
 *      cost drag, concentration and single-trade luck
 *   3. cap how many candidates one species may contribute, so a lucky species
 *      cannot fill the shortlist
 *   4. drop duplicate genomes by content digest
 */
export function selectCandidates(evaluated, { maxCandidates = 8, perSpeciesCap = null } = {}) {
  const cap = perSpeciesCap ?? Math.max(2, Math.ceil(maxCandidates / 2));
  const eligible = evaluated.filter(
    (entry) => entry.metrics?.evidence?.sufficient === true && Number.isFinite(entry.metrics.robustness),
  );

  const ranked = [...eligible].sort((a, b) => {
    const score = b.metrics.robustness - a.metrics.robustness;
    if (score !== 0) return score;
    return b.fitness - a.fitness;
  });

  const picked = [];
  const seenDigests = new Set();
  const speciesCount = new Map();
  const skipped = [];

  for (const entry of ranked) {
    if (picked.length >= maxCandidates) break;
    if (seenDigests.has(entry.genomeDigest)) {
      skipped.push({ agentId: entry.agentId, reason: "duplicate-genome" });
      continue;
    }
    const used = speciesCount.get(entry.species) ?? 0;
    if (used >= cap) {
      skipped.push({ agentId: entry.agentId, reason: "species-cap" });
      continue;
    }
    picked.push(entry);
    seenDigests.add(entry.genomeDigest);
    speciesCount.set(entry.species, used + 1);
  }

  const excludedForEvidence = evaluated.filter(
    (entry) => entry.metrics?.evidence?.sufficient !== true,
  ).length;

  return {
    candidates: picked,
    skipped,
    considered: evaluated.length,
    eligible: eligible.length,
    excludedForEvidence,
    rule: "evidence gates -> train robustness rank -> species cap -> dedupe by genome digest",
  };
}
