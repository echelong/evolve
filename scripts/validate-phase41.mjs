#!/usr/bin/env node
/**
 * EVOLVE Phase 4.1 correctness-pass regression suite.
 *
 * Covers the fixes made after the first genuine 1-hour Solana Arena run:
 *   - concentration (topMintShare) measured by pooled executed notional
 *   - the regime classifier actually wired into the arena entrypoint
 *   - evidence-aware live selection (survivor tier, min trades/observations)
 *   - species-specific, finite gene bounds (pool age in particular)
 *   - compact leaderboard elimination context (failedGates)
 *   - documented STRESS funnel semantics
 *
 * Dependency-free and offline, same convention as validate-arena.mjs.
 *
 * Run with: npm run validate:phase41
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { makeFixture } from "./make-fixture.mjs";
import { createMarketConfig } from "./market/config.mjs";
import { createMarketFeed } from "./market/feed.mjs";
import { createSeededRandom } from "./lib/random.mjs";
import {
  createSimulation,
  DEFAULT_EVOLUTION,
  hasSufficientEvidence,
  rankForSelection,
} from "./engine/simulation.mjs";
import {
  SPECIES,
  SPECIES_AGE_BOUNDS,
  GENE_BOUNDS,
  randomGenome,
  mutateGenome,
  crossoverGenomes,
} from "./engine/genome.mjs";
import {
  aggregateCandidateEvaluation,
  buildRegimeMap,
} from "./arena/orchestrator.mjs";
import { buildEntrantPool, runArenaTournament } from "./arena/tournament.mjs";
import { planWindows } from "./engine/walkforward.mjs";

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
  if (actual !== expected) fail(`${message} (expected ${expected}, got ${actual})`);
}
function assertClose(actual, expected, tolerance, message) {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    fail(`${message} (expected ~${expected}, got ${actual})`);
  }
}
function assertFinite(value, message) {
  assert(Number.isFinite(value), `${message} (got ${value})`);
}

function assertNoNonFinite(value, pathLabel = "root") {
  if (value === null || value === undefined) return;
  if (typeof value === "number") {
    assert(Number.isFinite(value), `non-finite number at ${pathLabel}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoNonFinite(item, `${pathLabel}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) assertNoNonFinite(item, `${pathLabel}.${key}`);
  }
}

/* ============================================================================
 * 1. Concentration (topMintShare) is pooled by executed notional
 * ==========================================================================*/

function fakeOosRun({ window, seed = 1, mintNotional, trades = 4 }) {
  const total = Object.values(mintNotional).reduce((a, b) => a + b, 0);
  return {
    seed,
    window,
    metrics: {
      netReturn: 0.01,
      trades,
      costs: 0.1,
      observations: 100,
      maxDrawdown: 0.05,
      distinctMints: Object.keys(mintNotional).length,
      mintNotional,
      totalNotional: total,
      robustnessDetail: { catastrophic: false },
    },
  };
}

test("1. Concentration: four equal-notional mints pool to ~0.25", () => {
  const evaluations = [
    {
      datasetDir: "d1",
      oosRuns: [
        fakeOosRun({ window: "W1", mintNotional: { A: 25, B: 25, C: 25, D: 25 } }),
      ],
      stressRuns: [],
    },
  ];
  const result = aggregateCandidateEvaluation({ digest: "x", species: "Momentum", evaluations });
  assertClose(result.components.topMintShare, 0.25, 0.01, "four equal mints must share ~0.25 each");
});

test("2. Concentration: one mint at 60% of notional reports ~0.60", () => {
  const evaluations = [
    {
      datasetDir: "d1",
      oosRuns: [
        fakeOosRun({ window: "W1", mintNotional: { A: 60, B: 20, C: 20 } }),
      ],
      stressRuns: [],
    },
  ];
  const result = aggregateCandidateEvaluation({ digest: "x", species: "Momentum", evaluations });
  assertClose(result.components.topMintShare, 0.6, 0.01, "dominant mint must report ~0.60");
});

test("3. Concentration: a single traded mint is exactly 1", () => {
  const evaluations = [
    { datasetDir: "d1", oosRuns: [fakeOosRun({ window: "W1", mintNotional: { A: 40 } })], stressRuns: [] },
  ];
  const result = aggregateCandidateEvaluation({ digest: "x", species: "Momentum", evaluations });
  assertEqual(result.components.topMintShare, 1, "one mint traded must report exactly 1");
});

test("4. Concentration: zero trades reports 0, not NaN", () => {
  const evaluations = [
    {
      datasetDir: "d1",
      oosRuns: [
        {
          seed: 1,
          window: "W1",
          metrics: {
            netReturn: 0,
            trades: 0,
            costs: 0,
            observations: 50,
            maxDrawdown: 0,
            distinctMints: 0,
            mintNotional: {},
            totalNotional: 0,
            robustnessDetail: { catastrophic: false },
          },
        },
      ],
      stressRuns: [],
    },
  ];
  const result = aggregateCandidateEvaluation({ digest: "x", species: "Momentum", evaluations });
  assertEqual(result.components.topMintShare, 0, "no trades must report concentration 0");
  assertFinite(result.components.topMintShare, "concentration must be finite with no trades");
});

test("5. Concentration: pools correctly across multiple seeds/windows (no double counting, no max-of-per-run saturation)", () => {
  // Two runs that would each independently look 100% concentrated (one run
  // trades only mint A, the other only mint B) must pool to an even 50/50 —
  // NOT saturate to 1.0 the way max-of-per-run-shares did before the fix.
  const evaluations = [
    {
      datasetDir: "d1",
      oosRuns: [
        fakeOosRun({ window: "W1", seed: 1, mintNotional: { A: 50 } }),
        fakeOosRun({ window: "W1", seed: 2, mintNotional: { B: 50 } }),
        fakeOosRun({ window: "W2", seed: 1, mintNotional: { A: 20 } }),
        fakeOosRun({ window: "W2", seed: 2, mintNotional: { B: 20 } }),
      ],
      stressRuns: [
        {
          profile: "mild",
          window: "W2",
          metrics: {
            netReturn: 0.01,
            trades: 2,
            mintNotional: { A: 10, B: 10 },
            robustnessDetail: { catastrophic: false },
          },
        },
      ],
    },
  ];
  const result = aggregateCandidateEvaluation({ digest: "x", species: "Momentum", evaluations, stressProfiles: ["mild"] });
  assertClose(result.components.topMintShare, 0.5, 0.02, "pooled A vs B notional must land at ~0.5, not 1.0");
  assertEqual(result.components.distinctMints, 1, "distinctMints is per-run max, unaffected by pooling");
});

test("6. Concentration is always bounded 0..1 across randomized inputs", () => {
  const random = createSeededRandom("concentration-fuzz");
  for (let i = 0; i < 50; i += 1) {
    const mintCount = 1 + Math.floor(random() * 6);
    const mintNotional = {};
    for (let m = 0; m < mintCount; m += 1) mintNotional[`mint-${m}`] = random() * 1000;
    const evaluations = [{ datasetDir: "d1", oosRuns: [fakeOosRun({ window: "W1", mintNotional })], stressRuns: [] }];
    const result = aggregateCandidateEvaluation({ digest: "x", species: "Momentum", evaluations });
    assert(result.components.topMintShare >= 0 && result.components.topMintShare <= 1, `topMintShare out of [0,1]: ${result.components.topMintShare}`);
  }
});

/* ============================================================================
 * 2. Regime classifier: wired end to end, no-look-ahead, non-unknown on real
 *    shaped data
 * ==========================================================================*/

let ctx = {};

async function buildRegimeFixtures() {
  ctx.root = await mkdtemp(path.join(tmpdir(), "evolve-phase41-"));
  ctx.config = createMarketConfig(
    {
      EVOLVE_MARKET_MODE: "synthetic",
      EVOLVE_WF_TRAIN_MINUTES: "10",
      EVOLVE_WF_VALIDATE_MINUTES: "5",
      EVOLVE_WF_TEST_MINUTES: "5",
      EVOLVE_WF_STEP_MINUTES: "5",
      EVOLVE_MIN_TRADES: "1",
      EVOLVE_MIN_DISTINCT_MINTS: "1",
      EVOLVE_MIN_OBSERVATIONS: "1",
      EVOLVE_MIN_EXPOSURE_TICKS: "0",
      EVOLVE_SYNTHETIC_UNIVERSE: "12",
    },
    { loadEnv: false },
  );
  ctx.fixture = path.join(ctx.root, "fixture-regime");
  ctx.manifest = await makeFixture({
    dir: ctx.fixture,
    snapshots: 40,
    intervalMs: 60_000,
    seed: "phase41-regime",
    tokenCount: 12,
    startAt: Date.UTC(2026, 8, 17, 12, 0, 0),
  });
}

test("7. Real-shaped fixture snapshots classify a non-unknown regime", async () => {
  const plan = planWindows({
    firstObservedAt: ctx.manifest.firstObservedAt,
    lastObservedAt: ctx.manifest.lastObservedAt,
    walkForward: ctx.config.walkForward,
    minWindows: 1,
    allowShort: true,
  });
  assert(plan.windows.length >= 1, "fixture must support at least one window");
  const rows = await buildRegimeMap(ctx.fixture, plan.windows);
  assert(rows.length >= 1, "at least one window must be classified");
  const nonUnknown = rows.filter((row) => row.regime !== "unknown");
  assert(
    nonUnknown.length > 0,
    `every window classified as unknown despite real market data (${JSON.stringify(rows.map((r) => ({ window: r.window, regime: r.regime, snapshotCount: r.snapshotCount })))})`,
  );
  for (const row of rows) {
    assert(SPECIES !== undefined, "sanity: module loaded");
    assert(typeof row.regime === "string", "every window gets a regime label");
  }
});

test("8. A window's regime is classified only from that window's own TEST-interval snapshots (no look-ahead, no train/validate bleed)", async () => {
  const plan = planWindows({
    firstObservedAt: ctx.manifest.firstObservedAt,
    lastObservedAt: ctx.manifest.lastObservedAt,
    walkForward: ctx.config.walkForward,
    minWindows: 1,
    allowShort: true,
  });
  const full = await buildRegimeMap(ctx.fixture, plan.windows);
  // Reclassifying using ONLY the first window's own plan entry must reproduce
  // that window's exact metrics, regardless of how many later windows exist
  // or how much train/validate data precedes it.
  const onlyFirst = await buildRegimeMap(ctx.fixture, [plan.windows[0]]);
  assertEqual(JSON.stringify(onlyFirst[0]), JSON.stringify(full[0]), "first window's classification must be independent of later windows");
  // snapshotCount must not exceed what actually fits in the test interval.
  const windowMs = plan.windows[0].test.end - plan.windows[0].test.start;
  const intervalMs = 60_000;
  const maxPossibleSnapshots = Math.floor(windowMs / intervalMs) + 2;
  assert(full[0].snapshotCount <= maxPossibleSnapshots, `window classified on more snapshots (${full[0].snapshotCount}) than its own test interval can contain (~${maxPossibleSnapshots}) — data from outside the window leaked in`);
});

test("9. buildRegimeMap output is deterministic", async () => {
  const plan = planWindows({
    firstObservedAt: ctx.manifest.firstObservedAt,
    lastObservedAt: ctx.manifest.lastObservedAt,
    walkForward: ctx.config.walkForward,
    minWindows: 1,
    allowShort: true,
  });
  const a = await buildRegimeMap(ctx.fixture, plan.windows);
  const b = await buildRegimeMap(ctx.fixture, plan.windows);
  assertEqual(JSON.stringify(a), JSON.stringify(b), "regime classification must be deterministic");
});

test("10. The arena entrypoint actually wires regimesByWindow through to regimePerformance (end to end, not just 'unknown')", async () => {
  const datasets = [
    { dir: ctx.fixture, id: "phase41-regime", fingerprint: ctx.manifest.fingerprint?.combined ?? null, sourceType: "SYNTHETIC" },
  ];
  const plan = planWindows({
    firstObservedAt: ctx.manifest.firstObservedAt,
    lastObservedAt: ctx.manifest.lastObservedAt,
    walkForward: ctx.config.walkForward,
    minWindows: 1,
    allowShort: true,
  });
  const regimeRows = await buildRegimeMap(ctx.fixture, plan.windows);
  datasets[0].regimesByWindow = Object.fromEntries(regimeRows.map((row) => [row.window, row]));

  const entrants = buildEntrantPool({ champions: [], population: 6, seed: "phase41-regime-arena" });
  const result = await runArenaTournament({
    datasets,
    config: ctx.config,
    entrants,
    seeds: ["s1"],
    stressProfiles: [],
    maxWindows: null,
    workers: 0,
    useCache: false,
    arenaId: null,
    arenasDir: null,
  });

  const regimesSeen = new Set();
  for (const detail of result.details.values()) {
    for (const regime of Object.keys(detail.regimePerformance ?? {})) regimesSeen.add(regime);
  }
  assert(regimesSeen.size > 0, "arena run must produce at least one regime label");
  assert(
    ![...regimesSeen].every((r) => r === "unknown"),
    `every candidate's regime came back "unknown" even with regimesByWindow attached — wiring regression (saw: ${[...regimesSeen].join(", ")})`,
  );
});

/* ============================================================================
 * 3. Live selection: evidence-aware ranking, bounded churn, exact pop size
 * ==========================================================================*/

test("11. rankForSelection: a one-trade lucky winner cannot outrank a properly evidenced moderate performer", () => {
  const evidence = { minTradesForSelection: 3, minObservationsForSelection: 10 };
  const luckyWinner = { id: "lucky", trades: 1, observations: 50, fitness: 500 };
  const evidencedModerate = { id: "moderate", trades: 8, observations: 50, fitness: 12 };
  const ranked = rankForSelection([luckyWinner, evidencedModerate], evidence);
  assertEqual(ranked[0].id, "moderate", "the evidenced moderate performer must rank first despite lower raw fitness");
  assertEqual(ranked[1].id, "lucky", "the one-trade lucky winner must rank behind it");
});

test("12. rankForSelection: among agents with equal evidence status, fitness still decides", () => {
  const evidence = { minTradesForSelection: 3, minObservationsForSelection: 10 };
  const a = { id: "a", trades: 10, observations: 50, fitness: 5 };
  const b = { id: "b", trades: 10, observations: 50, fitness: 9 };
  const c = { id: "c", trades: 0, observations: 0, fitness: 999 }; // insufficient evidence
  const ranked = rankForSelection([a, b, c], evidence);
  assertEqual(ranked[0].id, "b", "higher fitness wins within the evidenced tier");
  assertEqual(ranked[1].id, "a", "lower fitness, still evidenced, ranks second");
  assertEqual(ranked[2].id, "c", "insufficient evidence always ranks last regardless of fitness");
});

test("13. hasSufficientEvidence requires both trades and observations thresholds", () => {
  const opts = { minTradesForSelection: 3, minObservationsForSelection: 10 };
  assert(!hasSufficientEvidence({ trades: 1, observations: 50 }, opts), "too few trades must fail the gate");
  assert(!hasSufficientEvidence({ trades: 5, observations: 2 }, opts), "too few observations must fail the gate");
  assert(hasSufficientEvidence({ trades: 5, observations: 50 }, opts), "meeting both thresholds must pass");
});

test("14. Default live-selection config is conservative: replacement stays well below the pre-fix ~90%", () => {
  const eliteFraction = DEFAULT_EVOLUTION.eliteFraction;
  const survivorFraction = DEFAULT_EVOLUTION.survivorFraction;
  assert(survivorFraction > eliteFraction, "survivor tier must be wider than the elite tier");
  const populationSize = 96;
  const survivorCount = Math.max(
    Math.max(1, Math.floor(populationSize * eliteFraction)),
    Math.round(populationSize * survivorFraction),
  );
  const replacementFraction = (populationSize - survivorCount) / populationSize;
  assert(replacementFraction <= 0.7, `default replacement fraction ${replacementFraction} exceeds the 70% target ceiling`);
  assert(replacementFraction >= 0.4, `default replacement fraction ${replacementFraction} is suspiciously low (population would barely turn over)`);
});

async function runLiveSimulationGenerations({ generations = 4, populationSize = 40, generationTicks = 20, evolutionOverrides = {} } = {}) {
  const config = createMarketConfig(
    {
      EVOLVE_MARKET_MODE: "synthetic",
      EVOLVE_POPULATION: String(populationSize),
      EVOLVE_GENERATION_TICKS: String(generationTicks),
      EVOLVE_SYNTHETIC_UNIVERSE: "16",
    },
    { loadEnv: false },
  );
  const random = createSeededRandom("phase41-live-selection");
  let clock = 1_760_000_000_000;
  const now = () => clock;
  const feed = createMarketFeed({
    config,
    fetchImpl: async () => {
      throw new Error("offline fixture only");
    },
    now,
    random,
  });
  const simulation = createSimulation({
    config,
    feed,
    now,
    random,
    evolution: { enabled: true, ...config.evolution, ...evolutionOverrides },
  });

  const ticks = generationTicks * generations + Math.ceil(generationTicks / 2);
  for (let i = 0; i < ticks; i += 1) {
    await feed.advance(clock);
    clock += config.engine.tickMs;
    simulation.advanceTick();
  }
  return simulation.snapshot();
}

test("15. Population stays at exactly the configured size across generations", async () => {
  const snapshot = await runLiveSimulationGenerations({ populationSize: 32, generations: 3, generationTicks: 15 });
  assertEqual(snapshot.stats.population, 32, "configured population size must be preserved");
  assertEqual(snapshot.stats.alive, 32, "alive count must equal configured population size");
  assert(snapshot.generation >= 2, `expected multiple generations to elapse, got generation ${snapshot.generation}`);
});

test("16. Birth/death bookkeeping is internally consistent (terminatedTotal + population == bornTotal)", async () => {
  const snapshot = await runLiveSimulationGenerations({ populationSize: 24, generations: 4, generationTicks: 12 });
  const { bornTotal, terminatedTotal, population } = snapshot.stats;
  assertEqual(bornTotal - terminatedTotal, population, "born - terminated must equal the current population every tick");
});

test("17. Replacement per generation respects the configured survivor fraction (bounded, not ~90%)", async () => {
  const populationSize = 40;
  const generationTicks = 15;
  const snapshotShortRun = await runLiveSimulationGenerations({ populationSize, generations: 1, generationTicks });
  const snapshotLongRun = await runLiveSimulationGenerations({ populationSize, generations: 3, generationTicks });
  const gensElapsed = snapshotLongRun.generation - snapshotShortRun.generation;
  if (gensElapsed > 0) {
    const bornDelta = snapshotLongRun.stats.bornTotal - snapshotShortRun.stats.bornTotal;
    const perGenReplacement = bornDelta / gensElapsed / populationSize;
    assert(perGenReplacement <= 0.75, `replacement per generation ${perGenReplacement} exceeds the 75% ceiling`);
  }
});

/* ============================================================================
 * 4. Genome bounds: species-specific, sane, and mutation/crossover-stable
 * ==========================================================================*/

test("18. Genesis Hunter's initial and species age bounds are young-pool sane (not decades)", () => {
  const bounds = SPECIES_AGE_BOUNDS["Genesis Hunter"];
  assert(bounds.maxPoolAgeHours[1] <= 24 * 7, `Genesis Hunter maxPoolAgeHours ceiling ${bounds.maxPoolAgeHours[1]} is not young-pool sane`);
  assert(bounds.minPoolAgeHours[1] <= 24 * 2, `Genesis Hunter minPoolAgeHours ceiling ${bounds.minPoolAgeHours[1]} is not young-pool sane`);

  const random = createSeededRandom("genesis-bounds");
  for (let i = 0; i < 100; i += 1) {
    const genome = randomGenome("Genesis Hunter", random);
    assert(genome.maxPoolAgeHours <= bounds.maxPoolAgeHours[1], `initial genome maxPoolAgeHours ${genome.maxPoolAgeHours} exceeds species bound`);
    assert(genome.minPoolAgeHours <= genome.maxPoolAgeHours, "minPoolAgeHours must not exceed maxPoolAgeHours");
  }
});

test("19. Repeated mutation cannot walk pool-age genes outside a species' bounds (Genesis Hunter, 500 generations)", () => {
  const random = createSeededRandom("genesis-mutation-walk");
  const bounds = SPECIES_AGE_BOUNDS["Genesis Hunter"];
  let genome = randomGenome("Genesis Hunter", random);
  for (let gen = 0; gen < 500; gen += 1) {
    genome = mutateGenome(genome, { scale: 0.15, random, species: "Genesis Hunter" });
    assert(
      genome.maxPoolAgeHours >= bounds.maxPoolAgeHours[0] - 1e-9 && genome.maxPoolAgeHours <= bounds.maxPoolAgeHours[1] + 1e-9,
      `generation ${gen}: maxPoolAgeHours ${genome.maxPoolAgeHours} escaped species bound [${bounds.maxPoolAgeHours}]`,
    );
    assert(
      genome.minPoolAgeHours >= bounds.minPoolAgeHours[0] - 1e-9 && genome.minPoolAgeHours <= bounds.minPoolAgeHours[1] + 1e-9,
      `generation ${gen}: minPoolAgeHours ${genome.minPoolAgeHours} escaped species bound [${bounds.minPoolAgeHours}]`,
    );
    assert(genome.minPoolAgeHours <= genome.maxPoolAgeHours, `generation ${gen}: min exceeded max`);
  }
  assert(genome.maxPoolAgeHours < 1000, "sanity: nothing should be anywhere near the old absurd ~844,533h drift");
});

test("20. Repeated crossover between differently-bounded species stays inside the child's species bounds", () => {
  const random = createSeededRandom("crossover-walk");
  let genomeA = randomGenome("Genesis Hunter", random);
  let genomeB = randomGenome("Liquidity", random); // deliberately the widest-bounded species
  const bounds = SPECIES_AGE_BOUNDS["Genesis Hunter"];
  for (let gen = 0; gen < 100; gen += 1) {
    const child = crossoverGenomes(genomeA, genomeB, { random, species: "Genesis Hunter" });
    assert(
      child.maxPoolAgeHours <= bounds.maxPoolAgeHours[1] + 1e-9,
      `crossover child maxPoolAgeHours ${child.maxPoolAgeHours} exceeds Genesis Hunter bound even though one parent was Liquidity`,
    );
    genomeA = child;
    genomeB = randomGenome("Liquidity", random);
  }
});

test("21. Every species has a distinct, finite pool-age niche (bounds are not identical across species)", () => {
  const boxes = SPECIES.map((species) => JSON.stringify(SPECIES_AGE_BOUNDS[species]));
  const unique = new Set(boxes);
  assert(unique.size === SPECIES.length, `expected ${SPECIES.length} distinct species age boxes, got ${unique.size}`);
  for (const species of SPECIES) {
    const bounds = SPECIES_AGE_BOUNDS[species];
    assert(Number.isFinite(bounds.maxPoolAgeHours[1]) && bounds.maxPoolAgeHours[1] < 1_000_000, `${species} maxPoolAgeHours must be finite and sane, got ${bounds.maxPoolAgeHours[1]}`);
  }
  // Directional ordering the task asked for: Genesis Hunter narrowest, Liquidity widest.
  assert(
    SPECIES_AGE_BOUNDS["Genesis Hunter"].maxPoolAgeHours[1] < SPECIES_AGE_BOUNDS.Liquidity.maxPoolAgeHours[1],
    "Genesis Hunter must stay narrower than Liquidity",
  );
});

test("22. Non-age gene bounds (risk, thresholds) still hold after repeated mutation for every species", () => {
  const random = createSeededRandom("non-age-bounds-walk");
  for (const species of SPECIES) {
    let genome = randomGenome(species, random);
    for (let gen = 0; gen < 200; gen += 1) {
      genome = mutateGenome(genome, { scale: 0.2, random, species });
    }
    for (const [key, [min, max]] of Object.entries(GENE_BOUNDS)) {
      if (key === "maxPoolAgeHours" || key === "minPoolAgeHours") continue; // species-specific, checked separately
      const value = genome[key];
      assert(Number.isFinite(value), `${species}.${key} is non-finite after mutation`);
      assert(value >= min - 1e-9 && value <= max + 1e-9, `${species}.${key} = ${value} escaped [${min}, ${max}]`);
    }
  }
});

/* ============================================================================
 * 5. Leaderboard schema + stress funnel semantics
 * ==========================================================================*/

test("23. Leaderboard rows carry compact failedGates context, not the full candidate object", async () => {
  const entrants = buildEntrantPool({ champions: [], population: 6, seed: "phase41-leaderboard" });
  const result = await runArenaTournament({
    datasets: [{ dir: ctx.fixture, id: "phase41-regime", fingerprint: null, sourceType: "SYNTHETIC" }],
    config: ctx.config,
    entrants,
    seeds: ["s1"],
    stressProfiles: [],
    maxWindows: 1,
    workers: 0,
    useCache: false,
    arenaId: null,
    arenasDir: null,
  });
  assert(result.summary.leaderboard.length > 0, "leaderboard must have rows");
  for (const row of result.summary.leaderboard) {
    assert(Array.isArray(row.failedGates), "every leaderboard row must carry a failedGates array");
    assert(!("gates" in row), "leaderboard rows must stay compact — full gate detail belongs in candidates.json, not here");
    assert(!("components" in row), "leaderboard rows must not duplicate the full candidate object");
  }
  const eliminated = result.summary.leaderboard.find((row) => row.status === "ELIMINATED");
  if (eliminated) {
    assert(eliminated.failedGates.length > 0, "an ELIMINATED row must name at least one failed gate");
  }
});

test("24. STRESS funnel semantics are documented and self-consistent: rule text is present on every stage", async () => {
  const entrants = buildEntrantPool({ champions: [], population: 6, seed: "phase41-funnel" });
  const result = await runArenaTournament({
    datasets: [{ dir: ctx.fixture, id: "phase41-regime", fingerprint: null, sourceType: "SYNTHETIC" }],
    config: ctx.config,
    entrants,
    seeds: ["s1"],
    stressProfiles: ["mild"],
    maxWindows: 1,
    workers: 0,
    useCache: false,
    arenaId: null,
    arenasDir: null,
  });
  for (const [stage, row] of Object.entries(result.summary.funnel)) {
    assert(typeof row.rule === "string" && row.rule.length > 0, `funnel stage ${stage} is missing its rule text`);
    assert(row.survivors <= row.entered, `funnel stage ${stage} reports more survivors than entrants`);
  }
  // STRESS must actually be able to cull: any candidate stored in candidates
  // with stressSurvived 0 must not count among STRESS's survivors, which is
  // implied by GROUP.survivors >= STRESS.survivors when at least one
  // candidate failed every stress profile.
  assert(result.summary.funnel.STRESS.entered === result.summary.funnel.GROUP.survivors, "STRESS must be entered exactly by GROUP's survivors");
});

/* ============================================================================
 * 6. No NaN/Infinity anywhere in arena or live-engine output
 * ==========================================================================*/

test("25. A full arena run's summary and candidates contain no NaN/Infinity", async () => {
  const entrants = buildEntrantPool({ champions: [], population: 8, seed: "phase41-nan-check" });
  const result = await runArenaTournament({
    datasets: [{ dir: ctx.fixture, id: "phase41-regime", fingerprint: null, sourceType: "SYNTHETIC" }],
    config: ctx.config,
    entrants,
    seeds: ["s1", "s2"],
    stressProfiles: ["mild", "moderate"],
    maxWindows: 2,
    workers: 0,
    useCache: false,
    arenaId: null,
    arenasDir: null,
  });
  assertNoNonFinite(result.summary, "summary");
  for (const detail of result.details.values()) assertNoNonFinite(detail.components, "components");
});

test("26. A live simulation snapshot contains no NaN/Infinity after several generations", async () => {
  const snapshot = await runLiveSimulationGenerations({ populationSize: 24, generations: 3, generationTicks: 12 });
  assertNoNonFinite(snapshot.stats, "stats");
  assertNoNonFinite(snapshot.evolution, "evolution");
});

async function run() {
  const failures = [];
  let passed = 0;
  const started = Date.now();

  try {
    await buildRegimeFixtures();
  } catch (error) {
    console.error("could not build phase 4.1 validation fixtures:", error?.stack ?? error);
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

  console.log(`\nfixtures built in ${fixtureMs}ms`);
  console.log(`EVOLVE Phase 4.1 correctness validation: ${passed}/${cases.length} checks passed`);

  if (failures.length > 0) {
    console.log("Failed checks:");
    for (const failure of failures) console.log(`  - ${failure.name}`);
    process.exitCode = 1;
  } else {
    console.log("All Phase 4.1 checks passed.");
    console.log("Arena Scores and shadow results do NOT guarantee future profitability.");
  }

  if (process.env.EVOLVE_KEEP_FIXTURES !== "1") {
    await rm(ctx.root, { recursive: true, force: true }).catch(() => {});
  } else {
    console.log(`fixtures kept at ${ctx.root}`);
  }
}

run().catch((error) => {
  console.error("phase 4.1 validation runner crashed:", error);
  process.exitCode = 1;
});
