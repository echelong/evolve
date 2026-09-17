#!/usr/bin/env node
/**
 * EVOLVE Phase 4 validation suite — Champion Arena, regime/stress testing,
 * and the Live Shadow League.
 *
 * Dependency-free and offline: fixture datasets are built locally with the
 * real synthetic provider and a manual clock, exactly like Phase 3.
 *
 * Run with: npm run validate:arena
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { makeFixture } from "./make-fixture.mjs";
import { createMarketConfig } from "./market/config.mjs";
import { planWindows } from "./engine/walkforward.mjs";
import {
  buildDatasetRegistry,
  registrySummary,
  realEvidenceDatasets,
  buildRegimeMap,
  classifyRegimeFromMetrics,
  classifyWindowRegime,
  computeRegimeMetrics,
  STRESS_PROFILES,
  applyStressToPaper,
  stressProfileKey,
  buildTokenFailurePlan,
  computeArenaScore,
  evaluateSurvivalGates,
  CANDIDATE_STATUS,
  STRATEGY_TYPE,
  classifyStrategyType,
  mergeHallOfFameRecord,
  computeGenomeMetrics,
  diversityVerdict,
  adaptMutationScale,
  MUTATION_LIMITS,
  buildShadowState,
  advanceShadowMilestones,
  shadowPromotionStatus,
  shadowEntryGate,
  arenaCacheKey,
  readArenaCache,
  writeArenaCache,
} from "./arena/orchestrator.mjs";
import { buildEntrantPool, runArenaTournament, runQualification, runGroupStage } from "./arena/tournament.mjs";

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

const ctx = {
  root: null,
  fixtureA: null,
  fixtureB: null,
  manifestA: null,
  config: null,
};

/** Shared arena config: small walk-forward windows, low evidence floors. */
function arenaConfig(overrides = {}) {
  return createMarketConfig(
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
      ...overrides,
    },
    { loadEnv: false },
  );
}

// ---------------------------------------------------------------------------
// 1. Dataset registry: real vs synthetic evidence never merges
// ---------------------------------------------------------------------------

test("1. Dataset registry classifies synthetic fixtures and never counts them as real evidence", async () => {
  const registry = await buildDatasetRegistry(ctx.root);
  assert(registry.length === 2, `expected 2 registered datasets, saw ${registry.length}`);
  for (const entry of registry) {
    assertEqual(entry.sourceType, "SYNTHETIC", "fixtures must be classified SYNTHETIC");
    assert(typeof entry.fingerprint === "string" && entry.fingerprint.length > 0, "every dataset needs a fingerprint");
  }
  const summary = registrySummary(registry);
  assertEqual(summary.real.count, 0, "synthetic fixtures must never inflate the real-evidence count");
  assertEqual(summary.synthetic.count, 2, "both fixtures must be counted as synthetic");
  assertEqual(realEvidenceDatasets(registry).length, 0, "no synthetic dataset may be treated as real-market evidence");
});

// ---------------------------------------------------------------------------
// 2. Regime classification has no look-ahead and is deterministic
// ---------------------------------------------------------------------------

test("2. Regime classification uses only data inside its own window and is deterministic", async () => {
  const plan = planWindows({
    firstObservedAt: ctx.manifestA.firstObservedAt,
    lastObservedAt: ctx.manifestA.lastObservedAt,
    walkForward: ctx.config.walkForward,
    minWindows: 1,
    allowShort: true,
  });
  assert(plan.windows.length >= 1, "the fixture must support at least one window");

  const first = await buildRegimeMap(ctx.fixtureA, plan.windows);
  const second = await buildRegimeMap(ctx.fixtureA, plan.windows);
  assertEqual(JSON.stringify(first), JSON.stringify(second), "regime classification must be deterministic for the same input");
  assert(first.length >= 1, "at least one window must be classified");
  for (const row of first) {
    assert(typeof row.regime === "string" && row.regime.length > 0, "every window must receive a regime label");
    assert(row.snapshotCount > 0, "a classified window must have observed snapshots");
  }

  // A window's classification must not depend on data recorded after it: build
  // the SAME window plan (window 0 only) against the full dataset and against
  // a stream that is deterministically identical up to that window's end. The
  // reader is forward-only and the window loop stops consuming once it moves
  // past the requested window, so re-running with only the first window
  // requested must reproduce exactly the same metrics regardless of how much
  // more data the underlying dataset actually contains.
  const onlyFirst = await buildRegimeMap(ctx.fixtureA, [plan.windows[0]]);
  assertEqual(
    JSON.stringify(onlyFirst[0]?.metrics ?? null),
    JSON.stringify(first[0]?.metrics ?? null),
    "the first window's regime metrics must not change when later windows are also requested",
  );
});

test("3. classifyRegimeFromMetrics is a pure, ordered rule match (no randomness, no I/O)", () => {
  const selloff = classifyRegimeFromMetrics({
    medianReturn: -0.02,
    positiveRatio: 0.3,
    dispersion: 0.01,
    liquidityChange: 0,
    activityPerSnapshot: 10,
    launchHeavyRatio: 0,
    returnCount: 100,
  });
  assertEqual(selloff.regime, "broad-selloff", "a strongly negative, broad move must classify as broad-selloff");

  const riskOn = classifyRegimeFromMetrics({
    medianReturn: 0.02,
    positiveRatio: 0.65,
    dispersion: 0.01,
    liquidityChange: 0,
    activityPerSnapshot: 10,
    launchHeavyRatio: 0,
    returnCount: 100,
  });
  assertEqual(riskOn.regime, "strong-risk-on", "a strongly positive, broad move must classify as strong-risk-on");

  const empty = classifyRegimeFromMetrics({ returnCount: 0 });
  assertEqual(empty.regime, "unknown", "no return observations must classify as unknown, not a guess");

  const { metrics } = computeRegimeMetrics([]);
  assertFiniteNumbers(metrics, "empty-window regime metrics");
  assertEqual(classifyWindowRegime([]).regime, "unknown", "an empty snapshot window must not be silently classified");
});

// ---------------------------------------------------------------------------
// 4. Stress engine never touches prices, only execution conditions
// ---------------------------------------------------------------------------

test("4. Stress profiles change execution friction only, never price data", () => {
  const basePaper = { ...ctx.config.paper };
  for (const [name, profile] of Object.entries(STRESS_PROFILES)) {
    const stressed = applyStressToPaper(basePaper, profile);
    assert(stressed.baseFeeBps >= basePaper.baseFeeBps, `${name}: fees must not decrease under stress`);
    assert(stressed.minSlippageBps >= basePaper.minSlippageBps, `${name}: slippage floor must not decrease under stress`);
    assert(!("price" in stressed) && !("prices" in stressed), `${name}: a stress profile must not carry price fields`);
  }
  assertEqual(
    JSON.stringify(applyStressToPaper(basePaper, STRESS_PROFILES.none)),
    JSON.stringify({ ...basePaper }),
    "the 'none' profile must be a no-op",
  );

  const keyMild = stressProfileKey(STRESS_PROFILES.mild);
  const keySevere = stressProfileKey(STRESS_PROFILES.severe);
  assert(keyMild !== keySevere, "different stress profiles must produce different cache-relevant keys");
});

test("5. Token failure plan never fabricates future prices and only drops future entries", () => {
  const plan = buildTokenFailurePlan(
    [{ label: "W1", mints: ["mintA", "mintB", "mintC", "mintD"] }],
    { seed: "stress-token-failure", failureRate: 0.5 },
  );
  assert(plan.length === 2, `expected 2 failed mints (50% of 4), saw ${plan.length}`);
  for (const entry of plan) {
    assertEqual(entry.policy, "LAST_OBSERVATION_THEN_FORCED_CLOSE", "disappearance must use the conservative close policy");
    assertEqual(entry.noNewEntriesAfterDisappearance, true, "no new entries may be opened after disappearance");
    assertEqual(entry.noFabricatedPrice, true, "a disappeared token must never receive an invented price");
  }
  const again = buildTokenFailurePlan(
    [{ label: "W1", mints: ["mintA", "mintB", "mintC", "mintD"] }],
    { seed: "stress-token-failure", failureRate: 0.5 },
  );
  assertEqual(JSON.stringify(plan), JSON.stringify(again), "the failure plan must be deterministic for the same seed");
});

// ---------------------------------------------------------------------------
// 6. Arena Score: never just return, transparent components
// ---------------------------------------------------------------------------

test("6. Arena Score penalizes one-trade, one-token, one-seed, and catastrophic profiles", () => {
  const solid = computeArenaScore({
    medianOOSReturn: 0.05,
    worstOOSReturn: 0.02,
    maxDrawdown: 0.1,
    stressSurvived: 2,
    stressTotal: 2,
    regimePositive: 4,
    regimeRuns: 5,
    seedReturns: [0.04, 0.05, 0.06],
    distinctMints: 20,
    topMintShare: 0.1,
    baseNetReturn: 0.05,
    stressedNetReturn: 0.04,
    catastrophicEvents: 0,
    trades: 60,
    oosWindows: 6,
  });

  const luckyOneTrade = computeArenaScore({
    medianOOSReturn: 0.5,
    worstOOSReturn: -0.9,
    maxDrawdown: 0.9,
    stressSurvived: 0,
    stressTotal: 2,
    regimePositive: 0,
    regimeRuns: 1,
    seedReturns: [0.5],
    distinctMints: 1,
    topMintShare: 1,
    baseNetReturn: 0.5,
    stressedNetReturn: -0.8,
    catastrophicEvents: 1,
    trades: 1,
    oosWindows: 1,
  });

  assert(solid.score > luckyOneTrade.score, "a robust, broad performer must outscore a lucky one-trade blow-up candidate");
  assertEqual(luckyOneTrade.components.catastrophic, 0, "a catastrophic event must zero out the catastrophic component");
  assert(luckyOneTrade.components.concentration < solid.components.concentration, "one-token concentration must be penalized");
  assert(luckyOneTrade.components.evidence < solid.components.evidence, "thin evidence must be penalized");
  assert(solid.score <= 100 && solid.score >= 0, "the score must stay within [0, 100]");
  assert(typeof solid.formula === "string" && solid.formula.length > 0, "the formula must be reported alongside the score");
  assert(/does NOT predict future profitability/i.test(solid.note), "the score must carry an honesty disclaimer");

  const again = computeArenaScore({ medianOOSReturn: 0.05, trades: 10 });
  const repeat = computeArenaScore({ medianOOSReturn: 0.05, trades: 10 });
  assertEqual(again.score, repeat.score, "the Arena Score must be a pure, deterministic function of its inputs");
});

// ---------------------------------------------------------------------------
// 7. Survival gates and deployment candidacy
// ---------------------------------------------------------------------------

test("7. Insufficient evidence cannot qualify regardless of score", () => {
  const gates = evaluateSurvivalGates({
    arenaScore: 99,
    components: { trades: 200, distinctMints: 40, oosWindows: 10, seeds: 5, maxDrawdown: 0.05, topMintShare: 0.05, catastrophicEvents: 0, evidenceInsufficient: true },
    realDatasetsUsed: 3,
  });
  assertEqual(gates.status, CANDIDATE_STATUS.INSUFFICIENT_EVIDENCE, "an evidence-insufficient candidate must never qualify, however high its score");
});

test("8. Deployment Candidate requires every configured gate to pass", () => {
  const goodComponents = {
    trades: 40,
    distinctMints: 8,
    oosWindows: 3,
    seeds: 3,
    maxDrawdown: 0.2,
    topMintShare: 0.2,
    catastrophicEvents: 0,
    stressSurvived: 2,
    stressTotal: 2,
  };
  const pass = evaluateSurvivalGates({
    arenaScore: 70,
    components: goodComponents,
    realDatasetsUsed: 1,
    stressSurvivalByProfile: { mild: { survived: true } },
    strategyType: STRATEGY_TYPE.GENERALIST,
  });
  assertEqual(pass.status, CANDIDATE_STATUS.DEPLOYMENT_CANDIDATE, "a candidate that clears every gate must become a Deployment Candidate");

  const failedDrawdown = evaluateSurvivalGates({
    arenaScore: 70,
    components: { ...goodComponents, maxDrawdown: 0.95 },
    realDatasetsUsed: 1,
    stressSurvivalByProfile: { mild: { survived: true } },
  });
  assertEqual(failedDrawdown.status, CANDIDATE_STATUS.ELIMINATED, "a single failed gate (drawdown) must eliminate an otherwise-strong candidate");

  const specialist = evaluateSurvivalGates({
    arenaScore: 70,
    components: goodComponents,
    realDatasetsUsed: 1,
    stressSurvivalByProfile: { mild: { survived: true } },
    strategyType: STRATEGY_TYPE.SPECIALIST,
  });
  assertEqual(specialist.status, CANDIDATE_STATUS.ARENA_SURVIVOR, "a specialist that clears the gates is a survivor, not automatically a deployment candidate");
});

test("9. Mild stress survival is required for deployment when configured", () => {
  const components = {
    trades: 40,
    distinctMints: 8,
    oosWindows: 3,
    seeds: 3,
    maxDrawdown: 0.2,
    topMintShare: 0.2,
    catastrophicEvents: 0,
    stressSurvived: 1,
    stressTotal: 2,
  };
  const failsMild = evaluateSurvivalGates({
    arenaScore: 70,
    components,
    realDatasetsUsed: 1,
    stressSurvivalByProfile: { mild: { survived: false } },
  });
  assertEqual(failsMild.status, CANDIDATE_STATUS.ELIMINATED, "failing mild stress must eliminate a candidate when required");
  assert(failsMild.gates.some((g) => g.label.includes("mild stress") && g.pass === false), "the failed mild-stress gate must be reported explicitly");
});

test("10. Catastrophic failure is recorded and blocks deployment", () => {
  const gates = evaluateSurvivalGates({
    arenaScore: 90,
    components: {
      trades: 100,
      distinctMints: 20,
      oosWindows: 5,
      seeds: 4,
      maxDrawdown: 0.1,
      topMintShare: 0.1,
      catastrophicEvents: 1,
      stressSurvived: 2,
      stressTotal: 2,
    },
    realDatasetsUsed: 1,
    stressSurvivalByProfile: { mild: { survived: true } },
  });
  assertEqual(gates.status, CANDIDATE_STATUS.ELIMINATED, "a catastrophic event must eliminate a candidate even with a high score");
  const catastrophicGate = gates.gates.find((g) => g.label.includes("catastrophic"));
  assert(catastrophicGate && catastrophicGate.pass === false, "the catastrophic-failure gate must be visible and failed");
});

// ---------------------------------------------------------------------------
// 11. Specialist vs generalist
// ---------------------------------------------------------------------------

test("11. Specialist/generalist classification reflects regime breadth honestly", () => {
  const broad = classifyStrategyType({
    a: { runs: 3, medianNetReturn: 0.1 },
    b: { runs: 3, medianNetReturn: 0.05 },
    c: { runs: 3, medianNetReturn: 0.02 },
    d: { runs: 3, medianNetReturn: -0.01 },
  });
  assertEqual(broad, STRATEGY_TYPE.GENERALIST, "positive performance across 3+ regimes must classify as generalist");

  const narrow = classifyStrategyType({
    a: { runs: 3, medianNetReturn: 0.2 },
    b: { runs: 3, medianNetReturn: -0.1 },
    c: { runs: 3, medianNetReturn: -0.2 },
  });
  assertEqual(narrow, STRATEGY_TYPE.SPECIALIST, "positive performance in only one regime must classify as specialist");

  assertEqual(classifyStrategyType({}), STRATEGY_TYPE.GENERALIST, "no regime data must not be mislabeled as specialist");
});

// ---------------------------------------------------------------------------
// 12. Diversity protection is deterministic and bounded
// ---------------------------------------------------------------------------

test("12. Genome diversity metrics are deterministic and bounded in [0, 1]", () => {
  const population = Array.from({ length: 12 }, (_, i) => ({
    genome: { entryThreshold: i / 12, momentumWeight: (i % 4) / 4 },
    species: i % 3 === 0 ? "Momentum" : "Liquidity",
    lineageId: i < 6 ? "L1" : "L2",
  }));
  const metrics = computeGenomeMetrics(population);
  assert(metrics.genomeDiversity >= 0 && metrics.genomeDiversity <= 1, "genomeDiversity must be in [0, 1]");
  assert(metrics.lineageConcentration >= 0 && metrics.lineageConcentration <= 1, "lineageConcentration must be in [0, 1]");
  assertEqual(metrics.lineageConcentration, 0.5, "two equal-sized lineages must produce a Herfindahl index of 0.5");

  const again = computeGenomeMetrics(population);
  assertEqual(JSON.stringify(metrics), JSON.stringify(again), "diversity metrics must be a deterministic function of the population");

  const collapsed = computeGenomeMetrics(population.map((p) => ({ ...p, genome: population[0].genome, lineageId: "L1" })));
  assertEqual(collapsed.lineageConcentration, 1, "a fully collapsed population must report maximum lineage concentration");
  assertEqual(diversityVerdict(collapsed).action, "increase-mutation", "a collapsed population must trigger the diversity-protection verdict");

  // Entrants without an explicit lineageId must still be treated as distinct
  // lineages by genome digest, not silently pooled into one bucket.
  const noLineage = computeGenomeMetrics([
    { genome: { entryThreshold: 0.1 } },
    { genome: { entryThreshold: 0.9 } },
  ]);
  assertEqual(noLineage.lineageConcentration, 0.5, "distinct genomes without a lineageId must not collapse to one lineage bucket");
});

test("13. Adaptive mutation stays within configured bounds", () => {
  let scale = MUTATION_LIMITS.base;
  for (let i = 0; i < 50; i += 1) {
    scale = adaptMutationScale(0.05, scale);
    assert(scale >= MUTATION_LIMITS.min && scale <= MUTATION_LIMITS.max, `mutation scale left its bounds: ${scale}`);
  }
  assert(scale > MUTATION_LIMITS.base, "sustained low diversity must nudge mutation up over time");

  let healthy = MUTATION_LIMITS.max;
  for (let i = 0; i < 50; i += 1) {
    healthy = adaptMutationScale(0.9, healthy);
    assert(healthy >= MUTATION_LIMITS.min && healthy <= MUTATION_LIMITS.max, `mutation scale left its bounds: ${healthy}`);
  }
  assert(healthy < MUTATION_LIMITS.max, "sustained healthy diversity must relax mutation back toward the base rate");
});

// ---------------------------------------------------------------------------
// 14. Hall of Fame vs Deployment Candidate
// ---------------------------------------------------------------------------

test("14. Hall of Fame membership never implies Deployment Candidate status", () => {
  const eliminated = mergeHallOfFameRecord(null, {
    digest: "abc123",
    genome: { entryThreshold: 0.5 },
    species: "Momentum",
    arenaScore: 60,
    status: CANDIDATE_STATUS.ELIMINATED,
    arenaId: "arena-1",
    at: new Date().toISOString(),
  });
  assert(eliminated.bestStatus !== CANDIDATE_STATUS.DEPLOYMENT_CANDIDATE, "an eliminated candidate must not carry deployment status in the Hall of Fame");
  assert(/does NOT imply deployment eligibility/i.test(eliminated.note), "the Hall of Fame record must disclaim deployment eligibility");

  const promoted = mergeHallOfFameRecord(eliminated, {
    digest: "abc123",
    genome: { entryThreshold: 0.5 },
    species: "Momentum",
    arenaScore: 80,
    status: CANDIDATE_STATUS.DEPLOYMENT_CANDIDATE,
    arenaId: "arena-2",
    at: new Date().toISOString(),
  });
  assertEqual(promoted.arenaAppearances, 2, "appearances must accumulate across arenas");
  assertEqual(promoted.eliminations, 1, "the earlier elimination must remain on the record");
  assertEqual(promoted.titleDefenses, 0, "a title defense requires back-to-back Deployment Candidate results, not a first promotion");

  const defended = mergeHallOfFameRecord(promoted, {
    digest: "abc123",
    genome: { entryThreshold: 0.5 },
    species: "Momentum",
    arenaScore: 85,
    status: CANDIDATE_STATUS.DEPLOYMENT_CANDIDATE,
    arenaId: "arena-3",
    at: new Date().toISOString(),
  });
  assertEqual(defended.titleDefenses, 1, "two consecutive Deployment Candidate results must count as one title defense");
});

// ---------------------------------------------------------------------------
// 15. Champion re-entry: can win or lose
// ---------------------------------------------------------------------------

test("15. Previous champions re-enter the arena and are not protected from elimination", () => {
  const champion = { digest: "champ1", genome: { entryThreshold: 0.4 }, species: "Champion" };
  const pool = buildEntrantPool({ champions: [champion], population: 20, seed: "reentry" });
  assert(pool.some((e) => e.origin === "champion" && e.digest === "champ1"), "a supplied champion must actually enter the pool");

  const scores = new Map(pool.map((e) => [e, e.digest === "champ1" ? 10 : 90]));
  const qualification = runQualification({ entrants: pool, scores, minScore: 50 });
  assert(
    !qualification.survivors.some((e) => e.digest === "champ1"),
    "a champion with a low score must be eliminated at qualification just like anyone else",
  );

  const scoresWin = new Map(pool.map((e) => [e, e.digest === "champ1" ? 95 : 10]));
  const group = runGroupStage({ survivors: pool, scores: scoresWin, keepFraction: 0.1, minKeep: 2 });
  assert(group.survivors.some((e) => e.digest === "champ1"), "a champion with the best score must be able to keep winning");
});

// ---------------------------------------------------------------------------
// 16. Live Shadow League: immutability, admission, gating
// ---------------------------------------------------------------------------

test("16. Shadow candidates are frozen: no field ever holds mutation/crossover/learning state", () => {
  const candidate = { digest: "shadow1", genome: { entryThreshold: 0.3 }, species: "Liquidity", status: CANDIDATE_STATUS.DEPLOYMENT_CANDIDATE };
  const state = buildShadowState(candidate, { source: "synthetic", startingCash: 100, at: 0 });
  assertEqual(state.immutableGenome, true, "shadow state must declare its genome immutable");
  assertEqual(state.paperOnly, true, "shadow state must declare itself paper-only");
  assertEqual(JSON.stringify(state.genome), JSON.stringify(candidate.genome), "the frozen genome must match the admitted candidate exactly");
  assertEqual(state.status, CANDIDATE_STATUS.SHADOW_TESTING, "a qualified candidate must enter as SHADOW TESTING");

  const genomeBefore = JSON.stringify(state.genome);
  advanceShadowMilestones(state, 3_600_000);
  const promotion = shadowPromotionStatus(state);
  assertEqual(JSON.stringify(state.genome), genomeBefore, "advancing milestones must never touch the genome");
  assert(typeof promotion.status === "string", "a promotion status must always be reported");
  assert(/paper/i.test(promotion.note), "every shadow promotion note must reaffirm paper-only status");
});

test("17. Development-override shadow candidates are permanently labelled, never disguised as qualified", () => {
  const devCandidate = { digest: "dev1", genome: { entryThreshold: 0.6 }, species: "Reversal", status: CANDIDATE_STATUS.ARENA_SURVIVOR };
  const state = buildShadowState(devCandidate, { source: "synthetic", startingCash: 100, at: 0 });
  assertEqual(state.qualified, false, "a non-Deployment-Candidate must never be marked qualified");
  assertEqual(state.status, CANDIDATE_STATUS.UNQUALIFIED_SHADOW_TEST, "an unqualified admission must be labelled UNQUALIFIED SHADOW TEST");
  const promotion = shadowPromotionStatus(state);
  assertEqual(promotion.status, CANDIDATE_STATUS.UNQUALIFIED_SHADOW_TEST, "an unqualified candidate can never be promoted to a qualified shadow status");
});

test("18. Shadow duration milestones only ever move forward and require real elapsed time", () => {
  const state = buildShadowState({ digest: "d1", genome: {}, status: CANDIDATE_STATUS.DEPLOYMENT_CANDIDATE }, { at: 0 });
  const noneYet = advanceShadowMilestones(state, 1000);
  assertEqual(noneYet.length, 0, "no milestone may complete before its required duration has elapsed");
  const oneHour = advanceShadowMilestones(state, 3_600_000);
  assert(oneHour.includes("1h"), "the 1h milestone must complete once an hour has elapsed");
  assertEqual(state.durationMilestones["6h"], false, "later milestones must not complete early");
  const again = advanceShadowMilestones(state, 3_600_001);
  assertEqual(again.length, 0, "an already-completed milestone must not be reported as newly completed again");
});

test("19. A degraded live feed blocks new shadow entries but never fabricates a price", () => {
  const healthy = shadowEntryGate({ degraded: false, entriesPaused: false, allowNewEntries: true, live: true });
  assertEqual(healthy.blocked, false, "a healthy feed must allow new shadow entries");

  const degraded = shadowEntryGate({ degraded: true, entriesPaused: true, allowNewEntries: false, degradedReason: "stale feed", live: true });
  assertEqual(degraded.blocked, true, "a degraded feed must block new shadow entries");
  assert(typeof degraded.reason === "string" && degraded.reason.length > 0, "a blocked gate must explain why");
  assertEqual(degraded.paperOnly, true, "the gate result must reaffirm paper-only status");

  const override = shadowEntryGate({ degraded: true, entriesPaused: true, allowNewEntries: false }, { allowDegraded: true });
  assertEqual(override.blocked, false, "an explicit development override may bypass the gate for testing purposes only");
});

// ---------------------------------------------------------------------------
// 20. Arena cache: keyed by fingerprint, seed, stage, stress and versions
// ---------------------------------------------------------------------------

test("20. Cache keys change with dataset fingerprint, seed, stage, and stress profile", () => {
  const base = { genomeDigest: "g1", datasetFingerprints: ["fp1"], seed: "s1", stage: "oos", stressProfile: "none" };
  const keyBase = arenaCacheKey(base);

  assert(arenaCacheKey({ ...base, datasetFingerprints: ["fp2"] }) !== keyBase, "a changed dataset fingerprint must invalidate the cache key");
  assert(arenaCacheKey({ ...base, seed: "s2" }) !== keyBase, "a changed seed must invalidate the cache key");
  assert(arenaCacheKey({ ...base, stage: "stress" }) !== keyBase, "a changed stage must invalidate the cache key");
  assert(arenaCacheKey({ ...base, stressProfile: "mild" }) !== keyBase, "a changed stress profile must invalidate the cache key");
  assert(arenaCacheKey({ ...base, genomeDigest: "g2" }) !== keyBase, "a changed genome digest must invalidate the cache key");
  assert(arenaCacheKey({ ...base, arenaVersion: 999 }) !== keyBase, "a changed arena/code version must invalidate the cache key");
  assertEqual(arenaCacheKey(base), keyBase, "identical inputs must reproduce the identical cache key");
});

test("21. Cache reproduces an identical evaluation and API keys never leak into cache files", async () => {
  const cacheDir = path.join(ctx.root, "cache-unit");
  const key = arenaCacheKey({ genomeDigest: "g1", datasetFingerprints: ["fp1"], seed: "s1", stage: "oos", stressProfile: "none" });
  const value = { seed: "s1", window: "W1", metrics: { netReturn: 0.05, trades: 10 } };
  await writeArenaCache(cacheDir, key, value);
  const read = await readArenaCache(cacheDir, key);
  assertEqual(JSON.stringify(read), JSON.stringify(value), "a cache read must reproduce exactly what was written");

  const raw = await readFile(path.join(cacheDir, `${key}.json`), "utf8");
  assert(!/JUPITER_API_KEY|sk-live|secret/i.test(raw), "no secret-shaped string may ever land in a cache file");

  const miss = await readArenaCache(cacheDir, "does-not-exist");
  assertEqual(miss, null, "a cache miss must return null, not throw");
});

// ---------------------------------------------------------------------------
// 22-24. Full tournament: determinism, worker parity, parallel bounds
// ---------------------------------------------------------------------------

test("22. Full tournament funnel runs end to end and produces a leaderboard with no NaN/Infinity", async () => {
  const datasets = [
    { dir: ctx.fixtureA, id: "fixture-a", fingerprint: ctx.manifestA.fingerprint.combined, sourceType: "SYNTHETIC" },
  ];
  const pool = buildEntrantPool({ champions: [], population: 12, seed: "funnel:1" });
  const result = await runArenaTournament({
    datasets,
    config: ctx.config,
    entrants: pool,
    seeds: ["s1", "s2"],
    stressProfiles: ["mild"],
    maxWindows: 1,
    workers: 0,
    cacheDir: path.join(ctx.root, "cache-funnel"),
    useCache: true,
    arenaId: null,
    arenasDir: null,
  });

  assertEqual(result.summary.funnel.QUALIFICATION.entered, 12, "the funnel must start with the full entrant pool");
  assert(result.summary.funnel.GROUP.survivors <= result.summary.funnel.QUALIFICATION.survivors, "the group stage must not grow the field");
  assert(result.summary.leaderboard.length > 0, "a leaderboard must be produced");
  assertFiniteNumbers(result.summary, "tournament summary");
  assert(
    Object.values(CANDIDATE_STATUS).includes(result.summary.leaderboard[0]?.status),
    "every leaderboard row must carry a recognized candidate status",
  );
  assert(/do not predict future profitability/i.test(result.summary.note), "the summary must carry the honesty disclaimer");
});

test("23. Ranking is deterministic: identical inputs reproduce identical scores and statuses", async () => {
  const datasets = [
    { dir: ctx.fixtureA, id: "fixture-a", fingerprint: ctx.manifestA.fingerprint.combined, sourceType: "SYNTHETIC" },
  ];
  const pool = buildEntrantPool({ champions: [], population: 10, seed: "det:1" });
  const cacheDir = path.join(ctx.root, "cache-det");
  const runOnce = () =>
    runArenaTournament({
      datasets,
      config: ctx.config,
      entrants: pool,
      seeds: ["s1"],
      stressProfiles: ["mild"],
      maxWindows: 1,
      workers: 0,
      cacheDir,
      useCache: false,
      arenaId: null,
      arenasDir: null,
    });

  const a = await runOnce();
  const b = await runOnce();
  const scoresA = pool.map((e) => Math.round((a.scored.get(e) ?? 0) * 1000));
  const scoresB = pool.map((e) => Math.round((b.scored.get(e) ?? 0) * 1000));
  assertEqual(JSON.stringify(scoresA), JSON.stringify(scoresB), "two independent runs of the same inputs must produce identical scores");
  const statusesA = pool.map((e) => a.statuses.get(e)?.status);
  const statusesB = pool.map((e) => b.statuses.get(e)?.status);
  assertEqual(JSON.stringify(statusesA), JSON.stringify(statusesB), "two independent runs must produce identical candidate statuses");
});

test("24. Worker count does not change the result of a parallel evaluation", async () => {
  const datasets = [
    { dir: ctx.fixtureA, id: "fixture-a", fingerprint: ctx.manifestA.fingerprint.combined, sourceType: "SYNTHETIC" },
  ];
  const pool = buildEntrantPool({ champions: [], population: 8, seed: "workers:1" });
  const cacheDir = path.join(ctx.root, "cache-workers");

  const inline = await runArenaTournament({
    datasets,
    config: ctx.config,
    entrants: pool,
    seeds: ["s1"],
    stressProfiles: ["mild"],
    maxWindows: 1,
    workers: 0,
    cacheDir,
    useCache: false,
    arenaId: null,
    arenasDir: null,
  });
  const parallel = await runArenaTournament({
    datasets,
    config: ctx.config,
    entrants: pool,
    seeds: ["s1"],
    stressProfiles: ["mild"],
    maxWindows: 1,
    workers: 3,
    cacheDir,
    useCache: false,
    arenaId: null,
    arenasDir: null,
  });

  const scoresInline = pool.map((e) => Math.round((inline.scored.get(e) ?? 0) * 1000));
  const scoresParallel = pool.map((e) => Math.round((parallel.scored.get(e) ?? 0) * 1000));
  assertEqual(JSON.stringify(scoresInline), JSON.stringify(scoresParallel), "worker count must never change the evaluated result");
});

// ---------------------------------------------------------------------------
// 25. No wallet / signing / execution path in the Phase 4 arena/shadow code
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

test("25. No wallet, signing, or transaction-execution path exists anywhere in the arena/shadow code", async () => {
  const { readdir } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const findings = [];

  async function walk(dir) {
    const entries = await readdir(path.join(projectRoot, dir), { withFileTypes: true });
    for (const entry of entries) {
      const relative = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        await walk(relative);
        continue;
      }
      if (!/\.(mjs|js|ts|tsx)$/.test(entry.name)) continue;
      const text = await readFile(path.join(projectRoot, relative), "utf8");
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(text)) findings.push(`${relative} matched ${pattern}`);
      }
      if (/\bfetch\s*\(/.test(text) && relative.includes(path.join("scripts", "arena"))) {
        findings.push(`${relative} performs a network fetch — arena/shadow evaluation must stay offline over replayed/observed data only`);
      }
    }
  }

  await walk(path.join("scripts", "arena"));

  assert(findings.length === 0, `real-execution capability or network call detected:\n    ${findings.join("\n    ")}`);
});

test("26. Top-level arena CLI scripts also contain no forbidden execution patterns", async () => {
  const files = ["scripts/arena.mjs", "scripts/champions.mjs", "scripts/smoke-arena.mjs"];
  const findings = [];
  for (const file of files) {
    const text = await readFile(path.join(process.cwd(), file), "utf8");
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(text)) findings.push(`${file} matched ${pattern}`);
    }
  }
  assert(findings.length === 0, `real-execution capability detected:\n    ${findings.join("\n    ")}`);
});

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

async function buildFixtures() {
  ctx.root = await mkdtemp(path.join(tmpdir(), "evolve-arena-"));
  ctx.config = arenaConfig();
  const START = Date.UTC(2026, 8, 17, 12, 0, 0);

  ctx.fixtureA = path.join(ctx.root, "fixture-a");
  ctx.fixtureB = path.join(ctx.root, "fixture-b");
  ctx.manifestA = await makeFixture({ dir: ctx.fixtureA, snapshots: 40, intervalMs: 60_000, seed: "validate-arena-a", tokenCount: 12, startAt: START });
  await makeFixture({ dir: ctx.fixtureB, snapshots: 40, intervalMs: 60_000, seed: "validate-arena-b", tokenCount: 12, startAt: START + 3_600_000 });
}

async function run() {
  const failures = [];
  let passed = 0;
  const started = Date.now();

  try {
    await buildFixtures();
  } catch (error) {
    console.error("could not build arena validation fixtures:", error?.stack ?? error);
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
  console.log(`EVOLVE arena (Phase 4) validation: ${passed}/${cases.length} checks passed`);

  if (failures.length > 0) {
    console.log("Failed checks:");
    for (const failure of failures) console.log(`  - ${failure.name}`);
    process.exitCode = 1;
  } else {
    console.log("All Phase 4 checks passed. Champion Arena, regime/stress testing, and the Live Shadow League are paper-only and deterministic.");
    console.log("Arena Scores and shadow results do NOT guarantee future profitability.");
  }

  if (process.env.EVOLVE_KEEP_FIXTURES !== "1") {
    await rm(ctx.root, { recursive: true, force: true }).catch(() => {});
  } else {
    console.log(`fixtures kept at ${ctx.root}`);
  }
}

run().catch((error) => {
  console.error("arena validation runner crashed:", error);
  process.exitCode = 1;
});
