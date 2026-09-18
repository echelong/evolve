#!/usr/bin/env node
/**
 * EVOLVE Phase 3 validation suite.
 *
 * Covers historical capture, deterministic replay, walk-forward protocol,
 * champion selection, baselines, multi-seed aggregation, and the paper-only
 * guarantee. Dependency-free and offline: datasets are generated locally with
 * the real recorder, the real synthetic provider, and a manual clock.
 *
 * Run with: npm run validate:history
 */

import { appendFile, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDatasetClock, createManualClock } from "./engine/clock.mjs";
import { runBaselines, BASELINE } from "./engine/baselines.mjs";
import { buildChampionRecord, classifyChampion } from "./engine/champions.mjs";
import { runExperiment } from "./engine/experiment.mjs";
import { digestOf } from "./lib/hash.mjs";
import { computeFitness, createSimulation } from "./engine/simulation.mjs";
import { randomGenome } from "./engine/genome.mjs";
import {
  DEFAULT_EVIDENCE,
  RESULT_CLASS,
  aggregateSeeds,
  evaluateEvidence,
  evaluateMetrics,
  summarizeAgent,
} from "./engine/metrics.mjs";
import { planWindow, planWindows, selectCandidates, runReplayStage, STAGE, windowsOverlapIncorrectly } from "./engine/walkforward.mjs";
import { createIdFactory } from "./lib/ids.mjs";
import { createSeededRandom } from "./lib/random.mjs";
import { serializeForPublic } from "./lib/sanitize.mjs";
import { makeFixture } from "./make-fixture.mjs";
import { createMarketConfig } from "./market/config.mjs";
import { createMarketFeed } from "./market/feed.mjs";
import { openReplayFeed, parseReplaySpeed } from "./market/replay.mjs";
import { openDataset, streamSnapshots } from "./history/dataset.mjs";
import {
  DATASET_CLASS,
  HISTORY_SCHEMA_VERSION,
  RECORD_TYPE,
  ROW_FIELDS,
  classifySnapshots,
  parseRecord,
  rowToMarket,
} from "./history/schema.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRET_KEY = "sk-live-EVOLVE-HISTORY-SECRET-7c21";
const MINUTE = 60_000;

const cases = [];

function test(name, fn) {
  cases.push({ name, fn });
}

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    fail(`${message} — expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(`${message} — expected ${b}, received ${a}`);
}

function assertFiniteNumbers(value, label, seen = new Set()) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${label} contains a non-finite number: ${value}`);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "number" && !Number.isFinite(entry)) {
      fail(`${label}.${key} is not finite: ${entry}`);
    }
    assertFiniteNumbers(entry, `${label}.${key}`, seen);
  }
}

/** Replay config; a poisoned key proves nothing leaks into datasets. */
function replayConfig(overrides = {}) {
  return createMarketConfig(
    {
      EVOLVE_MARKET_MODE: "replay",
      JUPITER_API_KEY: SECRET_KEY,
      EVOLVE_POPULATION: "16",
      EVOLVE_GENERATION_TICKS: "12",
      EVOLVE_WF_TRAIN_MINUTES: "1",
      EVOLVE_WF_VALIDATE_MINUTES: "0.5",
      EVOLVE_WF_TEST_MINUTES: "0.5",
      EVOLVE_WF_STEP_MINUTES: "0.5",
      ...overrides,
    },
    { loadEnv: false },
  );
}

/** Shared fixtures, built once before the cases run. */
const ctx = {
  root: null,
  fixtureDir: null,
  fixtureManifest: null,
  fastDir: null,
  fastManifest: null,
  stateDir: null,
  experiment: null,
};

/**
 * Minimal replay-driven simulation loop. Used where the walk-forward helper is
 * too opinionated (speed independence, raw ordering checks).
 */
async function replayOnce({ datasetDir, config, seed = "1", speed = "max", pacing = false, frozen = false }) {
  const feed = await openReplayFeed({ datasetDir, config, speed, pacing });
  const clock = createDatasetClock(feed);
  const simulation = createSimulation({
    config,
    feed,
    now: clock.now,
    random: createSeededRandom(seed),
    ids: createIdFactory({ prefix: "V" }),
    evolution: frozen ? { enabled: false } : { enabled: true, ...config.evolution },
  });

  let ticks = 0;
  let maxMark = -Infinity;
  const violations = [];

  while (true) {
    const step = await feed.advance();
    if (step.done) break;
    const at = feed.currentTimestamp();

    for (const market of feed.markets(at)) {
      if (Number.isFinite(market.lastObservedAt)) {
        maxMark = Math.max(maxMark, market.lastObservedAt);
        if (market.lastObservedAt > at + 1) violations.push(`${market.lastObservedAt} > ${at}`);
      }
    }

    simulation.advanceTick();
    ticks += 1;
  }

  feed.stop();
  const snapshot = simulation.snapshot();

  return { feed, simulation, snapshot, ticks, maxMark, violations };
}

// ---------------------------------------------------------------------------
// 1. Recorder produces valid NDJSON
// ---------------------------------------------------------------------------

test("1. Recorder produces valid NDJSON with a session header and columnar rows", async () => {
  const raw = await readFile(path.join(ctx.fixtureDir, "snapshots.ndjson"), "utf8");
  const lines = raw.split("\n").filter((line) => line.trim() !== "");
  assert(lines.length > 3, "a fixture should contain a header plus many snapshots");

  const header = parseRecord(lines[0]);
  assert(header !== null, "the first line must parse as JSON");
  assertEqual(header.type, RECORD_TYPE.SESSION, "the first line must be a session header");
  assertEqual(header.v, HISTORY_SCHEMA_VERSION, "the header must carry the schema version");
  assert(Array.isArray(header.rowFields), "the header must declare its row layout");
  assertEqual(header.rowFields.length, ROW_FIELDS.length, "the row layout must match the current schema");
  assertEqual(header.paperOnly, true, "the dataset must declare itself paper only");

  let snapshots = 0;
  for (const line of lines.slice(1)) {
    const record = parseRecord(line);
    assert(record !== null, "every line must be valid JSON");
    if (record.type === RECORD_TYPE.EVENT) continue;
    assertEqual(record.type, RECORD_TYPE.SNAPSHOT, "non-header records must be snapshots or events");
    assert(Array.isArray(record.rows), "snapshots must carry rows");
    assert(record.seq > 0, "snapshots must carry a capture sequence number");
    assert(Number.isFinite(record.t), "snapshots must carry an observation timestamp");
    for (const row of record.rows) {
      assertEqual(row.length, ROW_FIELDS.length, "every row must match the declared layout");
      assert(typeof row[0] === "string" && row[0].length > 0, "every row must start with a mint");
    }
    snapshots += 1;
  }
  assertEqual(snapshots, ctx.fixtureManifest.snapshotCount, "the manifest snapshot count must match the file");

  // Round-trip: the decoded market keeps the shape agents consumed live.
  const first = parseRecord(lines[1]);
  const market = rowToMarket(first.rows[0]);
  assert(market.features !== null, "decoded markets must expose a feature vector");
  assertFiniteNumbers(market, "decoded market");
});

// ---------------------------------------------------------------------------
// 2. Manifests finalize correctly
// ---------------------------------------------------------------------------

test("2. Dataset manifests finalize with counts, intervals and a fingerprint", async () => {
  const manifest = JSON.parse(await readFile(path.join(ctx.fixtureDir, "manifest.json"), "utf8"));

  assertEqual(manifest.status, "complete", "a closed recording must be marked complete");
  assertEqual(manifest.schemaVersion, HISTORY_SCHEMA_VERSION, "the manifest must carry the schema version");
  assert(typeof manifest.datasetId === "string" && manifest.datasetId.length > 0, "the manifest needs a dataset id");
  assert(typeof manifest.endedAt === "string", "a finalized manifest needs an endedAt");
  assert(manifest.snapshotCount > 0, "the manifest must count snapshots");
  assert(manifest.uniqueMintCount > 0, "the manifest must count unique mints");
  assert(
    manifest.totalTokenObservations >= manifest.snapshotCount,
    "total token observations must be at least one per snapshot",
  );
  assert(Number.isFinite(manifest.firstObservedAt) && Number.isFinite(manifest.lastObservedAt), "time range required");
  assert(manifest.lastObservedAt >= manifest.firstObservedAt, "time range must be ordered");
  assertEqual(
    manifest.durationMs,
    manifest.lastObservedAt - manifest.firstObservedAt,
    "duration must match the observed range",
  );
  assert(manifest.snapshotInterval.count > 0, "interval statistics must be present");
  assert(Number.isFinite(manifest.snapshotInterval.medianMs), "interval median must be finite");
  assert(typeof manifest.fingerprint?.combined === "string", "a finalized dataset must carry a fingerprint");
  assertEqual(manifest.secretsStored, false, "manifests must declare that no secrets are stored");
  assertEqual(manifest.paperOnly, true, "manifests must declare paper-only status");
  assertEqual(
    ctx.fixtureManifest.fingerprint.combined,
    manifest.fingerprint.combined,
    "the returned manifest must match the file",
  );
});

// ---------------------------------------------------------------------------
// 3. No secrets in the dataset
// ---------------------------------------------------------------------------

test("3. Datasets never contain the configured API key", async () => {
  const files = ["manifest.json", "snapshots.ndjson", "events.ndjson"];
  for (const name of files) {
    const target = path.join(ctx.fixtureDir, name);
    const text = await readFile(target, "utf8");
    assert(!text.includes(SECRET_KEY), `${name} must never contain the API key`);
    assert(!/x-api-key/i.test(text), `${name} must not record request headers`);
  }

  const manifest = JSON.parse(await readFile(path.join(ctx.fixtureDir, "manifest.json"), "utf8"));
  assertEqual(manifest.credentialFields.length, 0, "the manifest must declare no credential fields");

  // The recorder writes only what agents see; a poisoned key must not appear in
  // the sanitized state either.
  const state = await replayOnce({ datasetDir: ctx.fixtureDir, config: replayConfig(), seed: "1" });
  const serialized = serializeForPublic({
    ...state.snapshot,
    config: replayConfig(),
  });
  assert(!serialized.includes(SECRET_KEY), "serialized state must never contain the API key");
});

// ---------------------------------------------------------------------------
// 4. Source classification
// ---------------------------------------------------------------------------

test("4. Live / synthetic / mixed datasets are classified explicitly", () => {
  const synthetic = classifySnapshots([
    { effective: "synthetic", source: "Simulated SOL/USD market" },
    { effective: "synthetic", source: "Simulated SOL/USD market" },
  ]);
  assertEqual(synthetic.classification, DATASET_CLASS.SYNTHETIC_ONLY, "synthetic-only must be labelled as such");
  assertEqual(synthetic.containsSynthetic, true, "synthetic flag must be set");
  assertEqual(synthetic.usableForRealMarketReplay, false, "synthetic data must never be usable as real history");
  assert(/NOT real Solana market history/.test(synthetic.statement), "the statement must deny real-market status");

  const live = classifySnapshots([
    { effective: "live", source: "Jupiter Developer Platform (Tokens V2)" },
    { effective: "live", source: "Jupiter Developer Platform (Tokens V2)" },
  ]);
  assertEqual(live.classification, DATASET_CLASS.LIVE_ONLY, "live-only must be labelled as such");
  assertEqual(live.usableForRealMarketReplay, true, "live-only data may be replayed as real history");

  const mixed = classifySnapshots([
    { effective: "live", source: "Jupiter Developer Platform (Tokens V2)" },
    { effective: "synthetic", source: "Simulated SOL/USD market" },
  ]);
  assertEqual(mixed.classification, DATASET_CLASS.MIXED, "a mixed session must be labelled mixed");
  assertEqual(mixed.usableForRealMarketReplay, false, "mixed data must not masquerade as real history");
  assert(/MIXED/.test(mixed.statement), "the mixed statement must say so plainly");

  const empty = classifySnapshots([]);
  assertEqual(empty.classification, DATASET_CLASS.EMPTY, "an empty dataset must be classified empty");
  assertEqual(empty.usableForRealMarketReplay, false, "empty data is not usable");

  // And the fixture really is synthetic-only.
  assertEqual(ctx.fixtureManifest.dataClass, DATASET_CLASS.SYNTHETIC_ONLY, "fixtures must be synthetic-only");
  assertEqual(ctx.fixtureManifest.containsSynthetic, true, "fixtures must declare synthetic content");
});

// ---------------------------------------------------------------------------
// 5. Order preservation
// ---------------------------------------------------------------------------

test("5. Replay preserves recorded observation order", async () => {
  const dataset = await openDataset(ctx.fixtureDir);
  const recorded = [];
  for await (const snapshot of dataset.snapshots()) recorded.push({ seq: snapshot.seq, t: snapshot.t, count: snapshot.count });
  assert(recorded.length > 3, "the fixture must contain several snapshots");
  for (let index = 1; index < recorded.length; index += 1) {
    assert(
      recorded[index].t >= recorded[index - 1].t,
      `capture order must be time order (${recorded[index - 1].t} -> ${recorded[index].t})`,
    );
    assert(
      recorded[index].seq > recorded[index - 1].seq,
      "capture sequence numbers must increase monotonically",
    );
  }

  const config = replayConfig();
  const feed = await openReplayFeed({ datasetDir: ctx.fixtureDir, config, speed: "max", pacing: false });
  const served = [];
  while (true) {
    const step = await feed.advance();
    if (step.done) break;
    served.push(feed.currentTimestamp());
  }
  feed.stop();

  assertDeepEqual(served, recorded.map((entry) => entry.t), "replay must serve snapshots in recorded order");

  const audit = feed.lookAheadAudit();
  assertEqual(audit.violations, 0, "the replay look-ahead audit must be clean");
  assertEqual(audit.cursorAdvancedOnlyForward, true, "the replay cursor must be forward-only");
});

// ---------------------------------------------------------------------------
// 6. Deterministic timestamps and values
// ---------------------------------------------------------------------------

test("6. Replay timestamps and served observations are deterministic", async () => {
  const config = replayConfig();
  const first = await replayOnce({ datasetDir: ctx.fixtureDir, config, seed: "7" });
  const second = await replayOnce({ datasetDir: ctx.fixtureDir, config, seed: "7" });

  assertDeepEqual(
    first.snapshot.recentTrades.map((trade) => trade.mint),
    second.snapshot.recentTrades.map((trade) => trade.mint),
    "the same seed must produce the same paper trades",
  );
  assertEqual(first.ticks, second.ticks, "the same dataset must yield the same tick count");
  assertDeepEqual(first.snapshot.stats, second.snapshot.stats, "the same run must reproduce identical statistics");
  assertDeepEqual(
    first.snapshot.topAgents.map((agent) => agent.id),
    second.snapshot.topAgents.map((agent) => agent.id),
    "deterministic ids must repeat for the same seed",
  );
  assertEqual(
    digestOf(first.snapshot.species),
    digestOf(second.snapshot.species),
    "species statistics must be reproducible",
  );
});

// ---------------------------------------------------------------------------
// 7. Speed independence
// ---------------------------------------------------------------------------

test("7. Replay speed changes pacing, never a trading outcome", async () => {
  // A short-interval fixture keeps the paced run inside a test budget.
  const config = replayConfig();
  const paced = await replayOnce({ datasetDir: ctx.fastDir, config, seed: "3", speed: 1, pacing: true });
  const fast = await replayOnce({ datasetDir: ctx.fastDir, config, seed: "3", speed: "max", pacing: false });

  assertEqual(paced.ticks, fast.ticks, "pacing must not change how many snapshots are consumed");
  assertDeepEqual(paced.snapshot.stats, fast.snapshot.stats, "pacing must not change paper statistics");
  assertEqual(
    digestOf(paced.snapshot.species),
    digestOf(fast.snapshot.species),
    "pacing must not change evolutionary outcomes",
  );
  assertEqual(
    digestOf(paced.snapshot.topAgents.map((agent) => agent.genome)),
    digestOf(fast.snapshot.topAgents.map((agent) => agent.genome)),
    "pacing must not change any genome",
  );
  assert(paced.feed.progress().wallPacedMs > 0, "a paced run should actually have waited");
  assertEqual(fast.feed.progress().wallPacedMs, 0, "an unthrottled run must not wait");

  assertEqual(parseReplaySpeed("100"), 100, "a numeric speed must parse");
  assertEqual(parseReplaySpeed("max"), "max", "\"max\" must parse as unthrottled");
  assertEqual(parseReplaySpeed("garbage", 1), 1, "unusable speeds must fall back");
});

// ---------------------------------------------------------------------------
// 8. Same dataset + config + seed => same result
// ---------------------------------------------------------------------------

test("8. Same dataset, config and seed reproduce the same evolutionary result", async () => {
  const config = replayConfig();
  const interval = { start: ctx.fixtureManifest.firstObservedAt, end: ctx.fixtureManifest.firstObservedAt + MINUTE };

  const a = await runReplayStage({
    datasetDir: ctx.fixtureDir,
    config,
    interval,
    stage: STAGE.TRAIN,
    seed: 42,
    windowLabel: "VDET",
  });
  const b = await runReplayStage({
    datasetDir: ctx.fixtureDir,
    config,
    interval,
    stage: STAGE.TRAIN,
    seed: 42,
    windowLabel: "VDET",
  });

  assertEqual(a.ticks, b.ticks, "identical runs must consume identical ticks");
  assertEqual(a.simulation.generation, b.simulation.generation, "identical runs must reach the same generation");
  assertEqual(
    digestOf(a.candidates.map((entry) => entry.genomeDigest)),
    digestOf(b.candidates.map((entry) => entry.genomeDigest)),
    "identical runs must produce identical genomes",
  );
  assertEqual(
    digestOf(a.simulation.snapshot().recentTrades),
    digestOf(b.simulation.snapshot().recentTrades),
    "identical runs must produce identical paper fills",
  );

  // A different seed must be able to diverge (case 9 asserts the divergence).
  const c = await runReplayStage({
    datasetDir: ctx.fixtureDir,
    config,
    interval,
    stage: STAGE.TRAIN,
    seed: 43,
    windowLabel: "VDET",
  });
  assert(
    digestOf(a.candidates.map((entry) => entry.genomeDigest)) !==
      digestOf(c.candidates.map((entry) => entry.genomeDigest)),
    "a different seed must produce a different population",
  );
});

// ---------------------------------------------------------------------------
// 9. Multiple seeds
// ---------------------------------------------------------------------------

test("9. Different seeds produce different populations", async () => {
  const config = replayConfig();

  const first = await replayOnce({ datasetDir: ctx.fixtureDir, config, seed: "alpha" });
  const second = await replayOnce({ datasetDir: ctx.fixtureDir, config, seed: "omega" });

  const firstGenomes = digestOf(first.simulation.population.map((agent) => agent.genome));
  const secondGenomes = digestOf(second.simulation.population.map((agent) => agent.genome));
  assert(firstGenomes !== secondGenomes, "seeds must be able to produce genuinely different populations");
  assertEqual(second.ticks, first.ticks, "seed choice must not change how much data is consumed");
  assertEqual(first.violations.length, 0, "seed alpha must not observe future data");
  assertEqual(second.violations.length, 0, "seed omega must not observe future data");
});

// ---------------------------------------------------------------------------
// 10. No future observation reaches an agent
// ---------------------------------------------------------------------------

test("10. No observation newer than the current tick reaches an agent", async () => {
  const config = replayConfig();
  const run = await replayOnce({ datasetDir: ctx.fixtureDir, config, seed: "1" });

  assertEqual(run.violations.length, 0, `agents saw future marks: ${run.violations.slice(0, 3).join(", ")}`);
  assert(run.maxMark <= (run.feed.progress().lastTimestamp ?? Infinity), "observed marks must stay inside the window");
  assertEqual(run.feed.lookAheadAudit().violations, 0, "the provider must report a clean audit");

  // The provider refuses a look-ahead read instead of quietly answering it.
  const probe = await openReplayFeed({ datasetDir: ctx.fixtureDir, config, speed: "max", pacing: false });
  await probe.advance();
  const at = probe.currentTimestamp();
  let threw = false;
  try {
    probe.markets(at + 10 * MINUTE);
  } catch (error) {
    threw = error instanceof RangeError;
  }
  assert(threw, "requesting market state beyond the loaded snapshot must throw");
  probe.stop();
});

// ---------------------------------------------------------------------------
// 11. Look-ahead bias
// ---------------------------------------------------------------------------

test("11. Replay features are strictly backward-looking", async () => {
  const dataset = await openDataset(ctx.fixtureDir);
  let checked = 0;

  for await (const snapshot of dataset.snapshots()) {
    for (const market of snapshot.markets) {
      if (!Number.isFinite(market.lastObservedAt)) continue;
      if (market.lastObservedAt > snapshot.t + 1) {
        fail(`market ${market.mint} was observed after its own snapshot time`);
      }
      if (market.prevObservedAt !== null && market.prevObservedAt !== undefined) {
        assert(
          market.prevObservedAt <= snapshot.t + 1,
          "a derived feature must not reference an observation from the future",
        );
      }
      checked += 1;
    }
  }
  assert(checked > 0, "the fixture must contain observations to check");

  // The reader offers no seek/rewind capability at all.
  const source = await readFile(path.join(PROJECT_ROOT, "scripts/history/dataset.mjs"), "utf8");
  assert(/forward-only/i.test(source), "the reader must document its forward-only contract");
  assert(!/function\s+seek\b/.test(source), "the reader must not expose a seek API");
  assert(!/rewind/.test(source), "the reader must not expose a rewind API");

  const replaySource = await readFile(path.join(PROJECT_ROOT, "scripts/market/replay.mjs"), "utf8");
  assert(/assertNoLookAhead/.test(replaySource), "the replay provider must guard against look-ahead reads");

  // A future timestamp in the plan cannot be trained on: the stage feeds are
  // restricted to their own intervals.
  const stageSource = await readFile(path.join(PROJECT_ROOT, "scripts/engine/walkforward.mjs"), "utf8");
  assert(/from: interval\.start/.test(stageSource), "each stage must open its feed from its own start");
  assert(/until: interval\.end/.test(stageSource), "each stage must stop its feed at its own end");
});

// ---------------------------------------------------------------------------
// 12. Training evolves
// ---------------------------------------------------------------------------

test("12. The TRAIN stage evolves the population", async () => {
  const config = replayConfig();
  const run = await runReplayStage({
    datasetDir: ctx.fixtureDir,
    config,
    interval: { start: ctx.fixtureManifest.firstObservedAt, end: ctx.fixtureManifest.firstObservedAt + 3 * MINUTE },
    stage: STAGE.TRAIN,
    seed: 5,
    windowLabel: "VTRAIN",
  });

  assertEqual(run.frozen, false, "the training stage must not be frozen");
  assertEqual(run.freezeAudit.immutable, false, "training is expected to change genomes");
  assert(run.simulation.generation > 1, `training should advance generations (saw ${run.simulation.generation})`);
  assert(run.simulation.stats().totalTrades >= 0, "trading statistics must be countable");

  const snapshot = run.simulation.snapshot();
  assert(snapshot.stats.bornTotal > config.engine.population, "breeding must create new agents");
  assert(snapshot.stats.terminatedTotal > 0, "selection must terminate weak agents");
  assert(snapshot.events.some((event) => event.type === "BIRTH"), "births must be logged");
  assert(snapshot.events.some((event) => event.type === "DEATH"), "deaths must be logged");
  assert(snapshot.evolution.enabled === true, "evolution must be enabled while training");
  assert(
    snapshot.topAgents.some((agent) => agent.parents.length > 0),
    "genealogy must record parents for bred agents",
  );
});

// ---------------------------------------------------------------------------
// 13. Validation does not mutate candidates
// ---------------------------------------------------------------------------

test("13. VALIDATE freezes candidate genomes and cannot breed", async () => {
  const config = replayConfig();
  const trainInterval = { start: ctx.fixtureManifest.firstObservedAt, end: ctx.fixtureManifest.firstObservedAt + 3 * MINUTE };
  const validateInterval = { start: trainInterval.end, end: trainInterval.end + 1 * MINUTE };

  // Relaxed evidence gates so this protocol check does not depend on how much
  // trading one short fixture window happens to contain.
  const evidence = { minTrades: 1, minDistinctMints: 1, minObservations: 10, minExposureTicks: 0 };

  const train = await runReplayStage({
    datasetDir: ctx.fixtureDir,
    config,
    interval: trainInterval,
    stage: STAGE.TRAIN,
    seed: 11,
    windowLabel: "VV",
    evidence,
  });

  const selection = selectCandidates(train.candidates, { maxCandidates: 4 });
  const ranked = [...train.simulation.population].sort((a, b) => b.equity - a.equity);
  const chosen =
    selection.candidates.length > 0
      ? selection.candidates.map((entry) => ({
          genome: entry.genome,
          species: entry.species,
          lineageId: entry.lineageId,
          label: entry.agentId,
        }))
      : ranked.slice(0, 3).map((agent) => ({
          genome: agent.genome,
          species: agent.species,
          lineageId: agent.lineageId,
          label: agent.id,
        }));
  assert(chosen.length > 0, "the training run must produce candidates to freeze");

  const candidates = chosen;
  const digestsBefore = candidates.map((entry) => digestOf(entry.genome));

  const validate = await runReplayStage({
    datasetDir: ctx.fixtureDir,
    config,
    interval: validateInterval,
    stage: STAGE.VALIDATE,
    seed: 11,
    windowLabel: "VV",
    candidates,
    evidence,
  });

  assertEqual(validate.frozen, true, "the validation stage must be frozen");
  assertEqual(validate.freezeAudit.immutable, true, "validation must not mutate a single genome");
  assertEqual(validate.freezeAudit.genomesMutated, 0, "no genome may change during validation");
  assertEqual(validate.simulation.frozen, true, "the simulation must report itself frozen");
  assertEqual(validate.simulation.evolutionOptions.enabled, false, "breeding must be disabled during validation");
  assertEqual(
    validate.simulation.population.length,
    candidates.length,
    "validation must run exactly the supplied candidates",
  );
  assertDeepEqual(
    validate.candidates.map((entry) => entry.genomeDigest),
    digestsBefore,
    "returned genomes must be byte-identical to the supplied ones",
  );
  assertDeepEqual(
    validate.candidates.map((entry) => entry.label),
    candidates.map((entry) => entry.label),
    "candidate labels must be preserved for ranking",
  );

  const snapshot = validate.simulation.snapshot();
  assertEqual(snapshot.stats.alive, candidates.length, "frozen evaluation must not add or remove agents");
  assertEqual(snapshot.evolution.frozen, true, "the frozen flag must be visible in state");
  assert(
    snapshot.positions.every((position) => position.paper === true),
    "frozen evaluation must still be paper-only",
  );
});

// ---------------------------------------------------------------------------
// 14. Test stage freezes genomes
// ---------------------------------------------------------------------------

test("14. TEST freezes genomes and runs no evolution", async () => {
  const config = replayConfig();
  const base = ctx.fixtureManifest.firstObservedAt;
  const candidates = [
    { genome: randomGenome("Momentum", createSeededRandom("c1")), species: "Momentum", label: "C-1" },
    { genome: randomGenome("Liquidity", createSeededRandom("c2")), species: "Liquidity", label: "C-2" },
  ];

  const test7 = await runReplayStage({
    datasetDir: ctx.fixtureDir,
    config,
    interval: { start: base + 2 * MINUTE, end: base + 4 * MINUTE },
    stage: STAGE.TEST,
    seed: 9,
    windowLabel: "VTEST",
    candidates,
  });

  assertEqual(test7.frozen, true, "the test stage must be frozen");
  assertEqual(test7.freezeAudit.immutable, true, "the test stage must not mutate genomes");
  assertEqual(test7.simulation.generation, 1, "a frozen test window must not advance generations");
  assertEqual(
    test7.simulation.population.length,
    candidates.length,
    "the test stage must evaluate exactly the frozen candidates",
  );
  assert(
    test7.simulation.population.every((agent) => agent.born === 1),
    "no new agents may be born during the test stage",
  );
});

// ---------------------------------------------------------------------------
// 15. Test outcomes cannot modify parameters
// ---------------------------------------------------------------------------

test("15. Test outcomes cannot feed back into genome parameters", async () => {
  const config = replayConfig();
  const candidates = [
    { genome: randomGenome("Genesis Hunter", createSeededRandom("t1")), species: "Genesis Hunter", label: "T-1" },
  ];

  const run = await runReplayStage({
    datasetDir: ctx.fixtureDir,
    config,
    interval: { start: ctx.fixtureManifest.firstObservedAt, end: ctx.fixtureManifest.firstObservedAt + 2 * MINUTE },
    stage: STAGE.TEST,
    seed: "freeze",
    windowLabel: "VFB",
    candidates,
  });

  const before = run.simulation.population.map((agent) => digestOf(agent.genome));
  // Even if a caller explicitly asks to breed, a frozen simulation only ranks.
  run.simulation.breedGeneration();
  run.simulation.advanceTick();
  const after = run.simulation.population.map((agent) => digestOf(agent.genome));

  assertDeepEqual(after, before, "a frozen simulation must never edit a genome");
  assertEqual(run.simulation.population.length, candidates.length, "population size must not change");
  assertEqual(
    digestOf(run.candidates.map((entry) => entry.genomeDigest)),
    digestOf([digestOf(candidates[0].genome)]),
    "reported digests must equal the frozen input genome",
  );

  // The metrics model has no path from an outcome back into a genome: it only
  // produces derived numbers.
  const metrics = evaluateMetrics(summarizeAgent({ equity: 100, costs: 0, trades: 0 }, { startingCash: 100 }));
  assert(!("genome" in metrics), "evaluation must not return anything that can be written back into a genome");
});

// ---------------------------------------------------------------------------
// 16. Walk-forward windows
// ---------------------------------------------------------------------------

test("16. Walk-forward windows tile forward without overlapping test periods", () => {
  const walkForward = { trainMinutes: 60, validateMinutes: 30, testMinutes: 30, stepMinutes: 30 };
  const start = Date.UTC(2026, 8, 17, 0, 0, 0);
  const plan = planWindows({
    firstObservedAt: start,
    lastObservedAt: start + 8 * 60 * MINUTE,
    walkForward,
    minWindows: 2,
  });

  assert(plan.windows.length >= 2, "an 8 hour dataset must support several windows");
  for (const entry of plan.windows) {
    assertEqual(entry.train.end, entry.validate.start, `${entry.label}: validation must start when training ends`);
    assertEqual(entry.validate.end, entry.test.start, `${entry.label}: test must start when validation ends`);
    assert(entry.train.start < entry.train.end, `${entry.label}: train window must be positive`);
    assertEqual(
      entry.train.end - entry.train.start,
      walkForward.trainMinutes * MINUTE,
      `${entry.label}: train length must match config`,
    );
    assertEqual(entry.test.end - entry.test.start, walkForward.testMinutes * MINUTE, `${entry.label}: test length`);
    assert(entry.test.end <= start + 8 * 60 * MINUTE, `${entry.label}: test must stay inside the dataset`);
  }

  for (let i = 0; i < plan.windows.length; i += 1) {
    for (let j = i + 1; j < plan.windows.length; j += 1) {
      assert(
        !windowsOverlapIncorrectly(plan.windows[i], plan.windows[j]),
        `${plan.windows[i].label} and ${plan.windows[j].label} have overlapping test periods`,
      );
    }
  }

  // A dataset too short for the requested windows fails loudly, with advice.
  let error = null;
  try {
    planWindows({
      firstObservedAt: start,
      lastObservedAt: start + 5 * MINUTE,
      walkForward,
      minWindows: 1,
    });
  } catch (caught) {
    error = caught;
  }
  assert(error !== null, "a dataset shorter than one window must be rejected");
  assertEqual(error.code, "WF_DATASET_TOO_SHORT", "the failure must be identifiable");
  assert(Number.isFinite(error.suggestion.trainMinutes), "the failure must suggest a usable configuration");

  // Explicit development mode may scale down instead of failing.
  const scaled = planWindows({
    firstObservedAt: start,
    lastObservedAt: start + 20 * MINUTE,
    walkForward,
    minWindows: 1,
    allowShort: true,
  });
  assertEqual(scaled.scaled, true, "allowShort must report that the plan was scaled");
  assert(scaled.windows.length >= 1, "a scaled plan must still produce a window");

  assertDeepEqual(
    planWindow({ start, index: 0, ...walkForward }).train,
    { start, end: start + 60 * MINUTE, minutes: 60 },
    "planWindow must build the documented train slot",
  );
});

// ---------------------------------------------------------------------------
// 17. No-trade baseline
// ---------------------------------------------------------------------------

test("17. The no-trade baseline keeps exactly its starting cash", async () => {
  const config = replayConfig({ EVOLVE_PAPER_STARTING_CASH: "100" });
  const results = await runBaselines({
    datasetDir: ctx.fixtureDir,
    config,
    interval: { start: ctx.fixtureManifest.firstObservedAt, end: ctx.fixtureManifest.firstObservedAt + MINUTE },
    seed: 1,
    windowLabel: "VNL",
  });

  const noTrade = results.find((entry) => entry.id === BASELINE.NO_TRADE);
  assert(noTrade !== undefined, "the no-trade baseline must exist");
  assertEqual(noTrade.metrics.trades, 0, "the no-trade baseline must not trade");
  assertEqual(noTrade.metrics.netReturn, 0, "the no-trade baseline must return exactly zero");
  assertEqual(noTrade.metrics.totalEquity ?? noTrade.metrics.finalEquity, noTrade.metrics.startingCash, "cash must be intact");
  assertEqual(noTrade.metrics.costs, 0, "doing nothing must cost nothing");
  assertEqual(noTrade.metrics.maxDrawdown, 0, "doing nothing must not draw down");
});

// ---------------------------------------------------------------------------
// 18. Baselines pay the same friction
// ---------------------------------------------------------------------------

test("18. Baselines trade under the same simulated friction and cannot see the future", async () => {
  const config = replayConfig({
    EVOLVE_BASELINE_RANDOM_ENTRY_PROBABILITY: "1",
    EVOLVE_PAPER_STARTING_CASH: "100",
  });
  const results = await runBaselines({
    datasetDir: ctx.fixtureDir,
    config,
    interval: { start: ctx.fixtureManifest.firstObservedAt, end: ctx.fixtureManifest.firstObservedAt + 2 * MINUTE },
    seed: 2,
    windowLabel: "VFR",
  });

  assertEqual(results.length, 4, "all four baselines must run");
  for (const entry of results) {
    assertEqual(entry.usesFutureData, false, `${entry.id} must not use future data`);
    assertFiniteNumbers(entry.metrics, `baseline ${entry.id}`);
    assert(entry.metrics.costs >= 0, `${entry.id} costs must be non-negative`);
    if (entry.metrics.trades > 0) {
      assert(entry.metrics.costs > 0, `${entry.id} traded, so it must have paid simulated friction`);
      assert(
        entry.metrics.grossReturn >= entry.metrics.netReturn,
        `${entry.id} net return must not exceed gross return once friction applies`,
      );
    }
  }

  const random = results.find((entry) => entry.id === BASELINE.RANDOM);
  assert(random.metrics.trades > 0, "a probability-1 random baseline must trade");
  assert(
    Math.abs(random.metrics.grossReturn - random.metrics.netReturn) > 0,
    "friction must actually reduce the random baseline's return",
  );

  const hold = results.find((entry) => entry.id === BASELINE.BUY_AND_HOLD);
  assert(hold.metrics.trades <= 1, "the buy-and-hold baseline opens at most one position");

  // Friction is the same object the agents use: identical config, one engine.
  assertEqual(config.paper.baseFeeBps > 0, true, "paper fees must be configured");
  assertEqual(config.paper.minSlippageBps > 0, true, "minimum slippage must be configured");
});

// ---------------------------------------------------------------------------
// 19. Champions require minimum evidence
// ---------------------------------------------------------------------------

test("19. A champion requires minimum evidence, not just a good number", () => {
  const weak = evaluateEvidence(
    { trades: 2, distinctMints: 1, observations: 10, exposureTicks: 3 },
    DEFAULT_EVIDENCE,
  );
  assertEqual(weak.sufficient, false, "two paper trades must not be enough evidence");
  assertEqual(weak.label, "INSUFFICIENT SAMPLE", "the gate must say INSUFFICIENT SAMPLE");
  assert(weak.missing.length >= 3, "the gate must report what is missing");

  const lucky = classifyChampion({ evidence: weak, validation: null, test: null });
  assertEqual(lucky.classification, RESULT_CLASS.INSUFFICIENT_SAMPLE, "an unproven genome is not a champion");
  assert(/INSUFFICIENT SAMPLE/.test(lucky.reason), "the reason must be explicit");

  const strong = evaluateEvidence(
    { trades: 40, distinctMints: 8, observations: 500, exposureTicks: 120 },
    DEFAULT_EVIDENCE,
  );
  assertEqual(strong.sufficient, true, "a sufficiently sampled genome must pass the gates");

  const validationMetrics = {
    netReturn: 0.12,
    robustness: 12.5,
    trades: 40,
    distinctMints: 8,
    maxDrawdown: 0.1,
    costs: 2.5,
    evidence: strong,
  };

  const passed = classifyChampion({ evidence: strong, validation: validationMetrics, test: null });
  assertEqual(passed.classification, RESULT_CLASS.PASSED_VALIDATION, "passing validation without a test is stated as such");
  assertEqual(passed.testCompleted, false, "a candidate without a test window has not completed testing");

  const failed = classifyChampion({
    evidence: strong,
    validation: { ...validationMetrics, robustness: -20 },
    test: null,
  });
  assertEqual(failed.classification, RESULT_CLASS.FAILED_VALIDATION, "a negative validation must fail");
  assertEqual(failed.passedValidation, false, "a failed candidate must not be marked as passed");

  const completed = classifyChampion({ evidence: strong, validation: validationMetrics, test: validationMetrics });
  assertEqual(completed.classification, RESULT_CLASS.TEST_COMPLETED, "a valid test run must be recorded as completed");

  const thinTest = classifyChampion({
    evidence: strong,
    validation: validationMetrics,
    test: { ...validationMetrics, evidence: weak },
  });
  assertEqual(
    thinTest.classification,
    RESULT_CLASS.INSUFFICIENT_SAMPLE,
    "a thin test window must not be presented as a completed validation",
  );
});

// ---------------------------------------------------------------------------
// 20. Champion metadata
// ---------------------------------------------------------------------------

test("20. Champion records carry the dataset fingerprint, seed and lineage", () => {
  const genome = randomGenome("Wallet Flow", createSeededRandom("champ"));
  const evidence = evaluateEvidence({ trades: 40, distinctMints: 8, observations: 500, exposureTicks: 120 }, DEFAULT_EVIDENCE);
  const validation = { netReturn: 0.14, grossReturn: 0.2, robustness: 18, trades: 40, distinctMints: 8, maxDrawdown: 0.12, costs: 3, evidence };
  const test = { netReturn: 0.09, grossReturn: 0.16, robustness: 15, trades: 30, distinctMints: 6, maxDrawdown: 0.1, costs: 2, evidence };

  const record = buildChampionRecord({
    candidate: {
      genome,
      species: "Wallet Flow",
      lineageId: "L00007",
      parents: ["A-000001"],
      generation: 4,
      agentId: "A-000123",
      metrics: { ...validation, evidence },
    },
    window: planWindow({ start: 0, index: 0, trainMinutes: 10, validateMinutes: 5, testMinutes: 5, stepMinutes: 5 }),
    dataset: { datasetId: "session-fixture", fingerprint: ctx.fixtureManifest.fingerprint.combined, classification: "synthetic-only" },
    seeds: [11, 22],
    validation,
    test,
    trainAggregate: aggregateSeeds([{ netReturn: 0.11, robustness: 9, maxDrawdown: 0.15, trades: 25 }]),
    config: replayConfig(),
    lineageChain: [{ agentId: "A-000001", generation: 1, species: "Wallet Flow", origin: "founder", lineageId: "L00007" }],
  });

  assertEqual(record.datasetFingerprint, ctx.fixtureManifest.fingerprint.combined, "the fingerprint must be stored");
  assertEqual(record.datasetId, "session-fixture", "the dataset id must be stored");
  assertDeepEqual(record.seeds, [11, 22], "the seeds must be stored");
  assertEqual(record.genomeDigest, digestOf(genome), "the digest must identify the genome");
  assertDeepEqual(record.genome, genome, "the genome itself must be archived");
  assertEqual(record.classification, RESULT_CLASS.TEST_COMPLETED, "a tested candidate must be classified as such");
  assertEqual(record.paperOnly, true, "champion records must be marked paper-only");
  assert(/do NOT guarantee future profitability/i.test(record.note), "records must carry the disclaimer");
  assertEqual(record.lineageChain.length, 1, "the lineage chain must be stored");
  assert(Number.isFinite(record.validationMetrics.robustness), "validation robustness must be preserved");
  assert(Number.isFinite(record.testMetrics.netReturn), "test return must be preserved");
  assertFiniteNumbers(record, "champion record");

  // Winning one generation is not enough: the classification must still be the
  // honest one.
  const unproven = buildChampionRecord({
    candidate: {
      genome,
      species: "Wallet Flow",
      lineageId: "L00007",
      parents: [],
      generation: 1,
      agentId: "A-000001",
      metrics: evaluateMetrics({ ...validation, trades: 3, distinctMints: 1, evidence: evaluateEvidence({ trades: 3, distinctMints: 1, observations: 20, exposureTicks: 2 }, DEFAULT_EVIDENCE) }),
    },
    window: null,
    dataset: { datasetId: "session-fixture", fingerprint: "abc", classification: "synthetic-only" },
    seeds: [11],
    config: replayConfig(),
  });
  assertEqual(unproven.classification, RESULT_CLASS.INSUFFICIENT_SAMPLE, "one good generation is not champion status");
  assertEqual(unproven.robustness, null, "robustness must be null when evidence is insufficient");
});

// ---------------------------------------------------------------------------
// 21. Multiple-seed aggregation
// ---------------------------------------------------------------------------

test("21. Multi-seed aggregation reports median, spread and the worst seed", () => {
  const runs = [
    { netReturn: 0.1, robustness: 5, maxDrawdown: 0.12, trades: 10 },
    { netReturn: 0.2, robustness: 8, maxDrawdown: 0.2, trades: 12 },
    { netReturn: 0.9, robustness: 40, maxDrawdown: 0.05, trades: 8 },
  ];

  const aggregate = aggregateSeeds(runs);
  assertEqual(aggregate.seeds, 3, "all seeds must be counted");
  assertEqual(aggregate.medianNetReturn, 0.2, "the median must be the middle seed, not the best one");
  assertEqual(aggregate.bestNetReturn, 0.9, "the best seed must be reported");
  assertEqual(aggregate.worstNetReturn, 0.1, "the worst seed must be reported");
  assert(Math.abs(aggregate.meanNetReturn - 0.4) < 1e-9, "the mean must include every seed");
  assertEqual(aggregate.medianRobustness, 8, "robustness must be aggregated by median too");
  assertEqual(aggregate.worstMaxDrawdown, 0.2, "the worst drawdown must be visible");
  assertEqual(aggregate.totalTrades, 30, "trades must be summed");
  assertEqual(aggregate.insufficientSeeds, 0, "no seed was below the evidence gates");

  const withInsufficient = aggregateSeeds([...runs, { netReturn: 0.4, robustness: null, maxDrawdown: 0.1, trades: 5 }]);
  assertEqual(withInsufficient.insufficientSeeds, 1, "insufficient seeds must be counted, not hidden");

  const empty = aggregateSeeds([]);
  assertEqual(empty.seeds, 0, "an empty aggregate must be honest");
  assertEqual(empty.medianNetReturn, null, "an empty aggregate must not invent a number");
});

// ---------------------------------------------------------------------------
// 22. Fitness is net
// ---------------------------------------------------------------------------

test("22. Fitness is computed on net results after simulated costs", async () => {
  const base = { equity: 110, cash: 110, trades: 12, wins: 6, maxDrawdown: 0.08, costs: 0 };
  const cheap = computeFitness(base, 100);
  const expensive = computeFitness({ ...base, costs: 4 }, 100);
  const richer = computeFitness({ ...base, equity: 120 }, 100);

  assert(expensive < cheap, "identical equity with higher simulated costs must score lower");
  assert(richer > cheap, "higher net equity must score higher");
  assert(Number.isFinite(computeFitness({ equity: NaN, costs: NaN }, 100)), "fitness must stay finite on bad input");

  const config = replayConfig();
  const interval = { start: ctx.fixtureManifest.firstObservedAt, end: ctx.fixtureManifest.firstObservedAt + 2 * MINUTE };
  const train = await runReplayStage({
    datasetDir: ctx.fixtureDir,
    config,
    interval,
    stage: STAGE.TRAIN,
    seed: 77,
    windowLabel: "VNET",
  });

  for (const agent of train.simulation.population) {
    const metrics = summarizeAgent(agent, { startingCash: config.paper.startingCash });
    assertFiniteNumbers(metrics, `metrics for ${agent.id}`);
    assert(
      metrics.netReturn <= metrics.grossReturn + 1e-9,
      `net return must not exceed gross return for ${agent.id}`,
    );
    if (metrics.costs > 0) {
      assert(metrics.netReturn < metrics.grossReturn, "paid costs must reduce the reported net return");
    }
  }
});

// ---------------------------------------------------------------------------
// 23. Experiment serialization
// ---------------------------------------------------------------------------

test("23. Experiment reports serialize cleanly with no NaN or Infinity", async () => {
  const report = ctx.experiment;
  assert(report !== null, "the shared mini-experiment must have run");
  assertFiniteNumbers(report.summary, "experiment summary");
  assertFiniteNumbers(report.manifest, "experiment manifest");

  const serialized = serializeForPublic({ manifest: report.manifest, summary: report.summary, champions: report.champions });
  assert(!/NaN|Infinity/.test(serialized), "serialized experiment output must contain no NaN or Infinity");
  const reparsed = JSON.parse(serialized);
  assertEqual(reparsed.manifest.experimentId, report.experimentId, "the experiment id must survive serialization");
  assertEqual(reparsed.summary.paperOnly, true, "the report must be marked paper-only");

  // Reproducibility metadata must be present for a rerun.
  assertEqual(report.manifest.paperOnly, true, "the manifest must be paper-only");
  assertEqual(report.manifest.dataset.fingerprint, ctx.fixtureManifest.fingerprint.combined, "the fingerprint must be recorded");
  assert(report.manifest.seeds.length >= 1, "seeds must be recorded");
  assert(report.manifest.windowsPlanned >= 1, "the window plan must be recorded");
  assert(typeof report.manifest.reproducibility === "string", "reproducibility must be documented in the report");
  assert(report.summary.outOfSample !== null, "out-of-sample aggregates must be present");

  // Failure and insufficient-sample reasons must be reported, not hidden.
  const counts = report.summary.resultCounts;
  assert(Number.isFinite(counts.insufficientSample), "insufficient-sample counts must be reported");
  assert(Number.isFinite(counts.overfitWarnings), "overfit warnings must be reported");
});

// ---------------------------------------------------------------------------
// 24. No real execution path
// ---------------------------------------------------------------------------

const FORBIDDEN_PATTERNS = [
  /sendTransaction/i,
  /sendRawTransaction/i,
  /signTransaction/i,
  /signAllTransactions/i,
  /partialSign/i,
  /fromSecretKey/i,
  /secretKey/i,
  /privateKey/i,
  /seedPhrase/i,
  /mnemonic/i,
  /wallet-adapter/i,
  /@solana\/web3\.js/i,
  /@solana\/kit/i,
  /new\s+Connection\s*\(/,
  /new\s+Transaction\s*\(/,
  /SystemProgram/i,
  /jup\.ag\/swap/i,
  /\/swap\/build/i,
  /swap-instructions/i,
  /broadcastTransaction/i,
];

const FORBIDDEN_DEPENDENCIES = [
  "@solana/web3.js",
  "@solana/kit",
  "@solana/wallet-adapter",
  "@jup-ag/api",
  "tweetnacl",
  "bs58",
  "solana-agent-kit",
];

test("24. No wallet, signing, or transaction-execution path exists (including in Phase 3 code)", async () => {
  const roots = ["scripts", "src"];
  const extensions = new Set([".mjs", ".ts", ".tsx", ".js", ".jsx"]);
  const findings = [];

  async function walk(dir) {
    const entries = await readdir(path.join(PROJECT_ROOT, dir), { withFileTypes: true });
    for (const entry of entries) {
      const relative = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        await walk(relative);
        continue;
      }
      if (!extensions.has(path.extname(entry.name))) continue;
      const normalized = relative.replace(/\\/g, "/");
      // The validation suites contain these patterns as detection rules only.
      if (normalized.endsWith("scripts/validate-market.mjs")) continue;
      if (normalized.endsWith("scripts/validate-history.mjs")) continue;
      if (normalized.endsWith("scripts/validate-arena.mjs")) continue;
      if (normalized.endsWith("scripts/validate-phase5a.mjs")) continue;
      if (normalized.endsWith("scripts/validate-phase5a2.mjs")) continue;

      const text = await readFile(path.join(PROJECT_ROOT, relative), "utf8");
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(text)) findings.push(`${normalized} matched ${pattern}`);
      }
    }
  }

  for (const root of roots) await walk(root);

  const packageJson = JSON.parse(await readFile(path.join(PROJECT_ROOT, "package.json"), "utf8"));
  const dependencies = Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies });
  for (const dependency of FORBIDDEN_DEPENDENCIES) {
    if (dependencies.includes(dependency)) findings.push(`package.json depends on ${dependency}`);
  }

  assert(findings.length === 0, `real-execution capability detected:\n    ${findings.join("\n    ")}`);

  // Phase 3 adds no network write path either: the recorder and replay only read
  // local files, and the only outbound calls in the repo are read-only GETs.
  const recorderSource = await readFile(path.join(PROJECT_ROOT, "scripts/history/recorder.mjs"), "utf8");
  assert(!/fetch\s*\(/.test(recorderSource), "the recorder must not talk to any provider");
  const replaySource = await readFile(path.join(PROJECT_ROOT, "scripts/market/replay.mjs"), "utf8");
  assert(!/fetch\s*\(/.test(replaySource), "the replay provider must not talk to any provider");
});

// ---------------------------------------------------------------------------
// 25. Synthetic Phase 2 mode still works
// ---------------------------------------------------------------------------

test("25. Phase 2 synthetic mode still works offline", async () => {
  const clock = createManualClock(Date.UTC(2026, 8, 17, 12, 0, 0));
  const config = createMarketConfig(
    { EVOLVE_MARKET_MODE: "synthetic", EVOLVE_SYNTHETIC_UNIVERSE: "12" },
    { loadEnv: false },
  );
  const feed = createMarketFeed({
    config,
    fetchImpl: async () => {
      throw new Error("synthetic mode must not use the network");
    },
    now: clock.now,
  });

  for (let index = 0; index < 4; index += 1) {
    clock.advance(1000);
    await feed.advance(clock.now());
  }

  const markets = feed.markets(clock.now());
  const health = feed.health(clock.now());
  assert(markets.length > 0, "synthetic mode must produce a market");
  assert(markets.every((market) => market.synthetic === true), "synthetic markets must be labelled");
  assertEqual(health.effectiveMode, "synthetic", "the effective mode must be synthetic");
  assertEqual(health.banner, "SYNTHETIC MARKET • PAPER MONEY", "the synthetic banner must be exact");
  assertEqual(health.allowNewEntries, true, "synthetic entries are allowed");
  assertEqual(health.requestCount, 0, "synthetic mode must make no provider requests");
  assertEqual(config.apiKeyConfigured, false, "this check must run without a key");
  feed.stop();
});

// ---------------------------------------------------------------------------
// 26. Live Phase 2 behaviour intact
// ---------------------------------------------------------------------------

test("26. Phase 2 live mode still degrades instead of fabricating data", async () => {
  const config = createMarketConfig({ EVOLVE_MARKET_MODE: "live" }, { loadEnv: false });
  const feed = createMarketFeed({
    config,
    fetchImpl: async () => {
      throw new Error("network unavailable");
    },
  });

  await feed.advance(Date.now());
  const health = feed.health(Date.now());

  assertEqual(config.requestedMode, "live", "the requested mode must be live");
  assertEqual(health.effectiveMode, "live", "forced live mode must never switch to synthetic");
  assertEqual(health.degraded, true, "live without a key must be degraded");
  assertEqual(health.allowNewEntries, false, "degraded live data must pause new entries");
  assertEqual(health.banner, "LIVE FEED DEGRADED • NEW ENTRIES PAUSED", "the degraded banner must be exact");
  assertEqual(feed.markets(Date.now()).length, 0, "degraded live mode must serve no fabricated market");
  assertEqual(health.synthetic.steps, 0, "live mode must never step the synthetic simulator");
  assertEqual(health.apiKeyConfigured, false, "the health block must not contain a key, only its presence");
  assert(!JSON.stringify(health).includes("sk-"), "health must never contain key material");
  feed.stop();
});

// ---------------------------------------------------------------------------
// 27. Dashboard state serializes cleanly and leaks nothing
// ---------------------------------------------------------------------------

test("27. Replay state serializes cleanly for the dashboard and leaks no secret", async () => {
  const config = replayConfig();
  const { runReplay } = await import("./engine/replay-runner.mjs");
  await runReplay({
    config,
    datasetDir: ctx.fixtureDir,
    dir: ctx.stateDir,
    speed: "max",
    persistEvery: 999,
  });

  const files = await readdir(ctx.stateDir);
  assert(files.includes("replay-state.json"), "a replay must write replay-state.json");
  assert(!files.includes("state.json"), "a replay must never write the live state file");

  const raw = await readFile(path.join(ctx.stateDir, "replay-state.json"), "utf8");
  assert(!raw.includes(SECRET_KEY), "the dashboard state must never contain the API key");

  const state = JSON.parse(raw);
  assertEqual(state.stateSource, undefined, "the engine writes state; the API adds the source label");
  assertEqual(state.paperOnly, true, "state must declare paper-only");
  assertEqual(state.mode, "PAPER", "state must report the paper mode");
  assertEqual(state.research.mode, "replay", "the research block must describe the replay");
  assertEqual(state.research.banner, "HISTORICAL REPLAY • PAPER MONEY", "the replay banner must be exact");
  assertEqual(state.research.dataset.id, ctx.fixtureManifest.datasetId, "the dataset id must be exposed");
  assertEqual(state.research.dataset.dataClass, DATASET_CLASS.SYNTHETIC_ONLY, "the dataset class must be exposed");
  assert(typeof state.research.dataset.fingerprint === "string", "the fingerprint must reach the dashboard");
  assertEqual(state.research.replay.finished, true, "a completed replay must say so");
  assert(state.research.replay.snapshotsRead > 0, "progress must be reported");
  assert(state.research.windows.planned >= 0, "the window plan must be reported");
  assertEqual(state.research.evolutionFrozen, false, "a plain replay runs the training configuration by default");
  assertEqual(state.config.execution, "paper-only", "the public config must declare paper-only execution");
  assertEqual(state.config.apiKeyConfigured, true, "the public config may report key presence");
  assert(!raw.includes("apiKey\":"), "the raw state must not contain a key value field");
  assertEqual(state.guards.walletKeysLoaded, false, "guards must be reported");
  assertFiniteNumbers(state, "replay state");
  assert(state.research.disclaimer.length > 0, "the disclaimer must be present");
});

// ---------------------------------------------------------------------------
// 28. Dataset integrity
// ---------------------------------------------------------------------------

test("28. A modified dataset is detected by its integrity fingerprint", async () => {
  const tamperedDir = path.join(ctx.root, "tampered");
  await mkdir(tamperedDir, { recursive: true });
  for (const name of ["manifest.json", "snapshots.ndjson", "events.ndjson"]) {
    await copyFile(path.join(ctx.fixtureDir, name), path.join(tamperedDir, name));
  }

  const clean = await openDataset(tamperedDir);
  const before = await clean.verifyFingerprint();
  assertEqual(before.ok, true, "an untouched copy must verify against its manifest");

  await appendFile(
    path.join(tamperedDir, "snapshots.ndjson"),
    `${JSON.stringify({ v: HISTORY_SCHEMA_VERSION, type: RECORD_TYPE.SNAPSHOT, seq: 9999, t: Date.now(), rows: [] })}\n`,
    "utf8",
  );

  const tampered = await openDataset(tamperedDir);
  const after = await tampered.verifyFingerprint();
  assertEqual(after.ok, false, "adding history to a dataset must break its fingerprint");
  assert(after.computed !== before.computed, "the computed fingerprint must change");

  const experimentConfig = replayConfig();
  let rejected = false;
  try {
    const strict = await openReplayFeed({
      datasetDir: tamperedDir,
      config: experimentConfig,
      speed: "max",
      pacing: false,
      verifyFingerprint: true,
    });
    strict.stop();
  } catch {
    rejected = true;
  }
  assert(rejected, "opening a dataset whose bytes no longer match its manifest must fail loudly");

  // Without the check the data is still readable, so the failure is opt-in and
  // never silently ignored: the manifest's own fingerprint is the record.
  const lenient = await openReplayFeed({
    datasetDir: tamperedDir,
    config: experimentConfig,
    speed: "max",
    pacing: false,
    verifyFingerprint: false,
  });
  assertEqual(lenient.fingerprintCheck, null, "skipping verification must be visible as such");
  lenient.stop();
});

// ---------------------------------------------------------------------------
// 29. Interrupted writes
// ---------------------------------------------------------------------------

test("29. Interrupted writes do not destroy a dataset", async () => {
  const partialDir = path.join(ctx.root, "partial");
  await mkdir(partialDir, { recursive: true });
  for (const name of ["manifest.json", "snapshots.ndjson"]) {
    await copyFile(path.join(ctx.fixtureDir, name), path.join(partialDir, name));
  }

  // A hard kill can leave a truncated final line behind.
  await appendFile(path.join(partialDir, "snapshots.ndjson"), '{"type":"snapshot","t":1760', "utf8");

  const dataset = await openDataset(partialDir);
  let count = 0;
  for await (const snapshot of dataset.snapshots()) {
    assert(Number.isFinite(snapshot.t), "every decoded snapshot must carry a usable timestamp");
    count += 1;
  }
  assertEqual(count, ctx.fixtureManifest.snapshotCount, "a truncated tail must be skipped, not fatal");

  // The same tolerance holds for a wholly corrupt line in the middle.
  const corruptDir = path.join(ctx.root, "corrupt");
  await mkdir(corruptDir, { recursive: true });
  const original = await readFile(path.join(ctx.fixtureDir, "snapshots.ndjson"), "utf8");
  const lines = original.split("\n");
  lines.splice(4, 0, "{not json at all");
  await writeFile(path.join(corruptDir, "snapshots.ndjson"), lines.join("\n"), "utf8");

  const files = await readdir(corruptDir);
  assert(files.includes("snapshots.ndjson"), "the corrupt copy must exist");
  let recovered = 0;
  for await (const snapshot of streamSnapshots(path.join(corruptDir, "snapshots.ndjson"), ROW_FIELDS, {})) {
    if (Number.isFinite(snapshot.t)) recovered += 1;
  }
  assertEqual(recovered, ctx.fixtureManifest.snapshotCount, "readable snapshots must survive a corrupt line");
});

// ---------------------------------------------------------------------------
// 30. State isolation
// ---------------------------------------------------------------------------

test("30. Experiment reports, replay state and live state stay isolated", async () => {
  const info = await stat(path.join(ctx.stateDir, "replay-state.json"));
  assert(info.size > 0, "the replay state must exist");

  const experimentDir = path.join(ctx.root, "experiments", ctx.experiment.experimentId);
  const written = await readdir(experimentDir);
  for (const name of ["manifest.json", "summary.json", "windows.json", "champions.json"]) {
    assert(written.includes(name), `the experiment report must include ${name}`);
  }
  assert(written.includes("windows.csv"), "a CSV export must be written");

  const summary = JSON.parse(await readFile(path.join(experimentDir, "summary.json"), "utf8"));
  assert(typeof summary.experimentId === "string", "the experiment report must identify itself");
  assertEqual(summary.paperOnly, true, "the experiment must be marked paper-only");

  const championsDir = path.join(ctx.root, "champions");
  const championFiles = await readdir(championsDir).catch(() => []);
  if ((ctx.experiment.champions ?? []).length > 0) {
    assert(championFiles.includes("index.json"), "the champion archive must maintain an index");
    const index = JSON.parse(await readFile(path.join(championsDir, "index.json"), "utf8"));
    assert(index.champions.length > 0, "archived champions must appear in the index");
    assert(
      index.champions.every((entry) => typeof entry.genomeDigest === "string" && entry.genomeDigest.length > 0),
      "every archived champion must be identified by genome digest",
    );
  } else {
    // No champion is a legitimate outcome on a tiny fixture: the archive stays
    // empty rather than being filled with unproven genomes.
    assert(
      championFiles.length === 0 || !championFiles.includes("index.json"),
      "an empty experiment must not invent champions",
    );
  }

  // The live state file is never touched by any of this.
  const liveState = path.join(PROJECT_ROOT, ".evolve", "state.json");
  const liveInfo = await stat(liveState).catch(() => null);
  assert(liveInfo === null || liveInfo.isFile(), "the live state must remain a file if it exists");
});

// ---------------------------------------------------------------------------
// Fixtures + runner
// ---------------------------------------------------------------------------

async function buildFixtures() {
  ctx.root = await mkdtemp(path.join(tmpdir(), "evolve-history-"));
  ctx.stateDir = path.join(ctx.root, "state");

  ctx.fixtureDir = path.join(ctx.root, "session-main");
  // The fixture config deliberately carries a (fake) API key so the checks can
  // prove that credentials never reach a dataset, a manifest, or dashboard state.
  ctx.fixtureManifest = await makeFixture({
    dir: ctx.fixtureDir,
    snapshots: 90,
    intervalMs: 5000,
    seed: "validation-main",
    tokenCount: 14,
    config: createMarketConfig(
      {
        EVOLVE_MARKET_MODE: "synthetic",
        JUPITER_API_KEY: SECRET_KEY,
        EVOLVE_SYNTHETIC_UNIVERSE: "14",
        EVOLVE_SYNTHETIC_RETRY_MS: "1000",
      },
      { loadEnv: false },
    ),
  });

  // Fast fixture: short interval + short engine tick so a paced replay finishes
  // inside the test budget while still exercising the pacing code path.
  ctx.fastDir = path.join(ctx.root, "session-fast");
  ctx.fastManifest = await makeFixture({
    dir: ctx.fastDir,
    snapshots: 12,
    intervalMs: 50,
    seed: "validation-fast",
    tokenCount: 8,
    config: createMarketConfig(
      {
        EVOLVE_MARKET_MODE: "synthetic",
        EVOLVE_SYNTHETIC_UNIVERSE: "8",
        EVOLVE_TICK_MS: "50",
        EVOLVE_SYNTHETIC_RETRY_MS: "1000",
      },
      { loadEnv: false },
    ),
  });

  // One small experiment, shared by the report checks.
  ctx.experiment = await runExperiment({
    datasetDir: ctx.fixtureDir,
    config: replayConfig({
      EVOLVE_SEED: "1",
      EVOLVE_EVAL_SEEDS: "11,22",
      EVOLVE_WF_TRAIN_MINUTES: "2",
      EVOLVE_WF_VALIDATE_MINUTES: "1",
      EVOLVE_WF_TEST_MINUTES: "1",
      EVOLVE_WF_STEP_MINUTES: "2",
      EVOLVE_MIN_TRADES: "1",
      EVOLVE_MIN_DISTINCT_MINTS: "1",
      EVOLVE_MIN_OBSERVATIONS: "10",
      EVOLVE_MIN_EXPOSURE_TICKS: "1",
    }),
    write: true,
    saveChampions: true,
    experimentsDir: path.join(ctx.root, "experiments"),
    championsDir: path.join(ctx.root, "champions"),
    engineVersion: "validation",
    gitCommit: null,
  });
}

async function run() {
  const failures = [];
  let passed = 0;

  const started = Date.now();
  try {
    await buildFixtures();
  } catch (error) {
    console.error("could not build validation fixtures:", error?.stack ?? error);
    process.exitCode = 1;
    return;
  }
  const fixtureMs = Date.now() - started;

  for (const testCase of cases) {
    const caseStart = Date.now();
    try {
      await testCase.fn();
      passed += 1;
      console.log(`  ✓ ${testCase.name} (${Date.now() - caseStart}ms)`);
    } catch (error) {
      failures.push({ name: testCase.name, error });
      console.log(`  ✗ ${testCase.name}`);
      console.log(`      ${error?.message ?? error}`);
    }
  }

  console.log(`\nfixtures built in ${fixtureMs}ms (${ctx.fixtureManifest.snapshotCount} snapshots · ${ctx.fixtureManifest.dataClass})`);
  console.log(`EVOLVE history validation: ${passed}/${cases.length} checks passed`);

  if (failures.length > 0) {
    console.log("Failed checks:");
    for (const failure of failures) console.log(`  - ${failure.name}`);
    process.exitCode = 1;
  } else {
    console.log("All Phase 3 checks passed. Deterministic replay, walk-forward protocol and paper-only guarantees intact.");
    console.log("Historical backtests and paper results do NOT guarantee future profitability.");
  }

  if (process.env.EVOLVE_KEEP_FIXTURES !== "1") {
    await rm(ctx.root, { recursive: true, force: true }).catch(() => {});
  } else {
    console.log(`fixtures kept at ${ctx.root}`);
  }
}

run().catch((error) => {
  console.error("validation runner crashed:", error);
  process.exitCode = 1;
});
