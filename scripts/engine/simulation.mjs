/**
 * EVOLVE evolutionary paper simulation.
 *
 * The Phase 1 concept is preserved exactly: a population of agents with
 * individual genomes competes under identical conditions, fitness selects,
 * elites survive, breeders reproduce through mutation and crossover, weak
 * agents are terminated, and random immigrants keep exploration alive.
 *
 * What Phase 2 adds is the environment. Agents no longer see eight invented
 * tokens with an invented `momentum` number; they see normalized market
 * observations (pool age, organic score, holder concentration, authority
 * flags, 5m flow statistics, liquidity) from whichever provider is active, and
 * every decision produces a simulated accounting event — never a real trade.
 */

import {
  MAX_POOL_AGE_UNBOUNDED,
  SPECIES,
  SPECIES_ROLES,
  crossoverGenomes,
  genomeSummary,
  mutateGenome,
  randomGenome,
} from "./genome.mjs";
import { generateAgentId } from "../lib/ids.mjs";
import { ORIGIN, createGenealogy } from "./genealogy.mjs";
import { PAPER_ONLY, paperGuards, simulateEntry, simulateExit } from "./paper.mjs";
import {
  islandTargetCounts,
  allocateIslandBirths,
  islandDiversityPolicy,
  islandReproductiveWeights,
  islandSoftTargets,
  pickOtherIsland,
} from "./islands.mjs";
import { ABSTAIN_STATE, abstentionDecision, riskMultiplierFor } from "./families.mjs";
import { classifyWindowRegime } from "../arena/orchestrator.mjs";

const STATUS = Object.freeze({
  SCANNING: "SCANNING",
  HOLDING: "HOLDING",
  PAUSED: "PAUSED",
});

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

/** Significant-digit rounding: keeps micro-cap prices readable in JSON. */
function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function roundPrice(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed === 0) return 0;
  return Number(parsed.toPrecision(12));
}

/**
 * Fitness is NET: `equity` already reflects simulated fees and slippage, and
 * realised costs are penalised explicitly so the population cannot evolve
 * toward churning a paper account into dust.
 */
export function computeFitness(agent, startingCash) {
  const base = Number.isFinite(startingCash) && startingCash > 0 ? startingCash : 1;
  const netReturn = (finite(agent.equity, base) - base) / base;
  const winRate = agent.trades ? finite(agent.wins, 0) / agent.trades : 0;
  const activity = Math.min(finite(agent.trades, 0) / 12, 1);
  const costDrag = finite(agent.costs, 0) / base;

  const value =
    netReturn * 100 - finite(agent.maxDrawdown, 0) * 45 + winRate * 8 + activity * 2 - costDrag * 15;

  return Number.isFinite(value) ? value : -100;
}

/**
 * Selection-privilege evidence gate: has this agent traded/observed enough
 * *this generation* to trust its fitness number at all? Deliberately separate
 * from the death gate in breedGeneration — an agent short on evidence can
 * still survive, it just cannot rank into the elite/breeder tiers on a lucky
 * result.
 */
export function hasSufficientEvidence(agent, { minTradesForSelection = 0, minObservationsForSelection = 0 } = {}) {
  return (
    finite(agent?.trades, 0) >= minTradesForSelection &&
    finite(agent?.observations, 0) >= minObservationsForSelection
  );
}

/**
 * Evidence-aware selection ranking (pure, exported for direct testing).
 * Agents with sufficient evidence always rank ahead of those without,
 * fitness breaking ties within each tier — so a one-trade lucky winner
 * cannot outrank a properly evidenced agent no matter how large its raw
 * fitness number is; it can only compete with other unproven agents.
 */
export function rankForSelection(agents, evidenceOptions = {}) {
  return [...agents].sort((a, b) => {
    const aOk = hasSufficientEvidence(a, evidenceOptions);
    const bOk = hasSufficientEvidence(b, evidenceOptions);
    if (aOk !== bOk) return aOk ? -1 : 1;
    return finite(b?.fitness, -Infinity) - finite(a?.fitness, -Infinity);
  });
}

/** 0..1 composites that all agents share, so genomes stay comparable. */
export function marketComposites(market) {
  const f = market?.features ?? {};
  const netBuyers01 = (finite(f.netBuyerPressure, 0) + 1) / 2;

  return {
    momentum: finite(f.momentum, 0),
    flow:
      (finite(f.buyPressure, 0.5) + finite(f.orderFlow, 0.5) + finite(f.organicFlow, 0.5) + netBuyers01) / 4,
    traders: (finite(f.traderActivity, 0) + finite(f.organicBuyers, 0) + netBuyers01) / 3,
    liquidity: finite(f.liquidityQuality, 0),
    organic: finite(f.organicScore, 0),
    safety: finite(f.safety, 0),
    age: finite(f.ageYouth, 0.5),
    holders: (finite(f.holderDistribution, 0) + finite(f.holderBase, 0)) / 2,
    volume: finite(f.volumeActivity, 0),
    trend: ((finite(f.liquidityTrend, 0) + 1) / 2 + (1 - finite(f.volatility, 0))) / 2,
  };
}

const WEIGHT_FOR = Object.freeze({
  momentum: "momentumWeight",
  flow: "flowWeight",
  traders: "traderWeight",
  liquidity: "liquidityWeight",
  organic: "organicWeight",
  safety: "safetyWeight",
  age: "ageWeight",
  holders: "holderWeight",
  volume: "volumeWeight",
  trend: "trendWeight",
});

/** Weighted, bounded attractiveness of a market for one genome. */
export function scoreMarket(genome, market) {
  const composites = marketComposites(market);
  const momentumSignal = genome.contrarian === 1 ? -composites.momentum : composites.momentum;

  let total = 0;
  let weightSum = 1e-9;

  for (const [feature, composite] of Object.entries(composites)) {
    const weight = Math.max(0, finite(genome[WEIGHT_FOR[feature]], 0));
    if (weight === 0) continue;
    const value = feature === "momentum" ? momentumSignal : composite;
    total += weight * value;
    weightSum += weight;
  }

  const score = total / weightSum;
  return Number.isFinite(score) ? Math.max(-1, Math.min(1, score)) : 0;
}

/**
 * Hard eligibility: an agent's genome must explicitly allow a token before it
 * is ever scored. This is where species specialization bites.
 */
function* failedGateReasons(genome, market, { minLiquidityUsd = 0 } = {}) {
  const f = market?.features;
  if (!f) { yield "missing_features"; return; }
  if (market.fresh !== true) yield "market_not_fresh";
  if (!(finite(market.price, 0) > 0)) yield "invalid_price";
  if (!(finite(market.liquidity, -1) > 0)) yield "invalid_liquidity";
  if (market.liquidity < minLiquidityUsd) yield "below_global_min_liquidity";

  if (finite(f.liquidityQuality, 0) < genome.minLiquidityQuality) yield "liquidity_quality";
  if (finite(f.organicScore, 0) < genome.minOrganicScore) yield "organic_score";

  if (genome.requireConcentrationKnown === 1 && market.topHoldersPercentage === null) yield "concentration_unknown";
  if (market.topHoldersPercentage !== null && market.topHoldersPercentage > genome.maxTopHolderPct) {
    yield "top_holder_concentration";
  }

  if (genome.requireAuthoritySafe === 1) {
    if (market.mintAuthorityDisabled !== true) yield "mint_authority";
    if (market.freezeAuthorityDisabled !== true) yield "freeze_authority";
  }
  if (genome.requireVerified === 1 && market.verified !== true) yield "verification";

  if (market.poolAgeMs === null) {
    const ageAware =
      genome.minPoolAgeHours > 0 ||
      genome.maxPoolAgeHours < MAX_POOL_AGE_UNBOUNDED ||
      genome.ageWeight >= 0.15;
    if (ageAware) yield "pool_age_unknown";
  } else {
    const ageHours = market.poolAgeMs / 3_600_000;
    if (ageHours < genome.minPoolAgeHours) yield "pool_too_young";
    if (ageHours > genome.maxPoolAgeHours) yield "pool_too_old";
  }

  if (finite(f.buyPressure, 0) < genome.buyPressureThreshold) yield "buy_pressure";

  if (genome.momentumGateEnabled === 1) {
    const momentumSignal = genome.contrarian === 1 ? -f.momentum : f.momentum;
    if (finite(momentumSignal, 0) < genome.momentumThreshold) yield "momentum";
  }
}

// One ordered rule source. The trading predicate still stops on its FIRST
// failure. Diagnostics exhaust the same pure iterator, outside the decision.
export function passesGates(genome, market, options) {
  return failedGateReasons(genome, market, options).next().done;
}

export function assessGates(genome, market, options) {
  const failedGates = [...failedGateReasons(genome, market, options)];
  return { passes: failedGates.length === 0, firstFailedGate: failedGates[0] ?? null, failedGates };
}

// Phase 5I-PS.2c — DIAGNOSTIC COUNTERFACTUAL, NOT A TRADING RULE. Reuses the
// single shared assessment and removes ONLY `pool_too_old` from a copied
// failure list; every other failure is kept in original order. It is not a gate
// predicate: the engine never reads its result, it only hands copied scalars to
// the observer tap. `passesGates` above remains the sole production rule.
export const POOL_TOO_OLD_GATE = "pool_too_old";
export function assessPoolAgeCounterfactual(genome, market, options) {
  const { passes, failedGates } = assessGates(genome, market, options);
  const counterfactualFailedGates = failedGates.filter((gate) => gate !== POOL_TOO_OLD_GATE);
  const counterfactualPasses = counterfactualFailedGates.length === 0;
  return {
    productionPasses: passes,
    failedGates,
    counterfactualFailedGates,
    counterfactualPasses,
    counterfactualScore: counterfactualPasses ? scoreMarket(genome, market) : null,
    entryScoreThreshold: genome.entryScoreThreshold,
  };
}

export const DEFAULT_EVOLUTION = Object.freeze({
  enabled: true,
  mutationScale: 0.07,
  crossoverRate: 0.48,
  immigrantRate: 0.1,
  eliteFraction: 0.1,
  breederFraction: 0.28,
  speciesPull: true,
  // Live selection pressure (see EVOLVE_LIVE_* in market/config.mjs). These
  // are deliberately separate from the Arena's deployment gates: they govern
  // who reproduces in the live/replay swarm, not who becomes a Deployment
  // Candidate.
  survivorFraction: 0.35,
  minTradesForSelection: 3,
  minObservationsForSelection: 30,
  // A no-op floor by default (below every generationTicks value used anywhere
  // in this codebase, including fast test/smoke configs) — it only bites when
  // an operator explicitly raises EVOLVE_LIVE_MIN_GENERATION_TICKS above
  // whatever config.engine.generationTicks is set to.
  minGenerationTicks: 10,
});

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Create the runnable simulation.
 *
 * @param {{
 *   config: object,
 *   feed: object,
 *   now?: () => number,
 *   random?: () => number,
 *   ids?: ((kind: string) => string) | null,
 *   evolution?: object | null,
 *   fixedPopulation?: Array<{ genome: object, species?: string, lineageId?: string, label?: string }> | null,
 *   marketScanLimit?: number,
 *   recordTrades?: boolean,
 *   genealogy?: object | null,
 *   proposalObserver?: object | null,
 * }} options
 *
 * `proposalObserver` is the Phase 5I-PS.2 PASSIVE PROPOSAL TAP. It is optional
 * and completely inert when absent. When supplied it must expose
 * `freezeProposal(facts)` and `recordExecution(handle, execution)`:
 *
 *   - `freezeProposal` is called SYNCHRONOUSLY, immediately BEFORE the paper
 *     execution attempt, with immutable proposal facts (who/what/why, the
 *     observed market, the cash and intended notional). It returns an opaque
 *     handle that only ever travels back into `recordExecution`.
 *   - `recordExecution` is called SYNCHRONOUSLY, immediately AFTER the paper
 *     execution attempt completed, with the fill/block facts.
 *
 * Neither call is ever awaited, neither may block, and NOTHING either one
 * returns is read by any decision, execution, scoring, selection or evolution
 * code path. The tap observes a decision that has already been made and can
 * therefore never influence it. The CONSUMER is deliberately never named here:
 * the engine knows exactly one thing about it, namely that it may never
 * influence a decision.
 */
export function createSimulation({
  config,
  feed,
  now = () => Date.now(),
  random = Math.random,
  ids = null,
  evolution = null,
  fixedPopulation = null,
  marketScanLimit = 0,
  recordTrades = false,
  genealogy = null,
  proposalObserver = null,
} = {}) {
  const nextId = typeof ids === "function" ? ids : (kind) => generateAgentId(kind);
  const ancestry = genealogy ?? createGenealogy({});
  const evolutionOptions = {
    ...DEFAULT_EVOLUTION,
    ...(evolution ?? {}),
  };
  const evolutionEnabled = evolutionOptions.enabled !== false;
  const mutationScale = clampNumber(evolutionOptions.mutationScale, 0.001, 2, 0.07);
  const crossoverRate = clampNumber(evolutionOptions.crossoverRate, 0, 1, 0.48);
  const immigrantRate = clampNumber(evolutionOptions.immigrantRate, 0, 0.5, 0.1);
  const eliteFraction = clampNumber(evolutionOptions.eliteFraction, 0.01, 0.5, 0.1);
  const breederFraction = clampNumber(evolutionOptions.breederFraction, 0.05, 1, 0.28);
  const survivorFraction = Math.max(
    eliteFraction,
    clampNumber(evolutionOptions.survivorFraction, 0.05, 0.9, 0.35),
  );
  const minTradesForSelection = clampNumber(evolutionOptions.minTradesForSelection, 0, 10_000, 3);
  const minObservationsForSelection = clampNumber(
    evolutionOptions.minObservationsForSelection,
    0,
    10_000_000,
    30,
  );
  const minGenerationTicks = clampNumber(evolutionOptions.minGenerationTicks, 10, 100_000, 120);
  const scanLimit = Math.max(0, Math.round(marketScanLimit));

  // --- Phase 5I-PS.2: passive proposal observer tap --------------------------
  // A single, optional, synchronous callback pair. The simulation freezes a
  // proposal immediately before it attempts a paper execution and reports the
  // execution result immediately after; both calls are wrapped so that a
  // throwing/slow/malformed observer can never change engine behaviour.
  // Deliberately NO extra `now()` call, NO extra id-factory call, and NO
  // extra randomness: observer-on and observer-off runs therefore produce
  // byte-identical engine output.
  const proposalTap =
    proposalObserver && typeof proposalObserver.freezeProposal === "function" ? proposalObserver : null;

  function freezeProposalForObserver(facts) {
    if (proposalTap === null) return null;
    try {
      return proposalTap.freezeProposal(facts);
    } catch {
      // Observer-only evidence. The paper engine continues untouched.
      return null;
    }
  }

  function recordProposalExecutionForObserver(handle, execution) {
    if (proposalTap === null || handle === null || handle === undefined) return;
    try {
      proposalTap.recordExecution(handle, execution);
    } catch {
      // Observer-only evidence. The paper engine continues untouched.
    }
  }

  // --- Phase 5I-PS.2a: passive SOL opportunity tap ---------------------------
  // The ONE market identity the attached observer declares it may sample for
  // "this agent independently considered SOL actionable" evidence. Read ONCE,
  // here, and used only as a pure filter inside the market-scoring loop. When
  // no observer is attached, or it declares no sample identity, this is inert.
  const solOpportunityMint =
    proposalTap !== null && typeof proposalTap.solMint === "string" && proposalTap.solMint.length > 0
      ? proposalTap.solMint
      : null;

  function freezeSolOpportunityForObserver(facts) {
    if (proposalTap === null || solOpportunityMint === null) return null;
    try {
      return typeof proposalTap.observeSolOpportunity === "function" ? proposalTap.observeSolOpportunity(facts) : null;
    } catch {
      // Observer-only evidence. The paper engine continues untouched.
      return null;
    }
  }

  function recordSolSelectionForObserver(handle, selection) {
    if (proposalTap === null || handle === null || handle === undefined) return;
    try {
      if (typeof proposalTap.recordSolSelection === "function") proposalTap.recordSolSelection(handle, selection);
    } catch {
      // Observer-only evidence. The paper engine continues untouched.
    }
  }

  // --- Phase 5I-PS.2d: passive production-entry tap --------------------------
  // Fires once per FINALIZED production entry proposal (see stepAgent), for any
  // asset. Inert unless the attached tap declares the method. The facts are
  // built lazily from COPIES (scalars, a fresh gate assessment from the one
  // shared rule source, a structured clone of the selected market), so the
  // consumer never holds an engine reference. The call is protected and its
  // return value is discarded. No clock, randomness, IDs or asynchronous work.
  const productionEntryTap =
    proposalTap !== null && typeof proposalTap.observeProductionEntry === "function" ? proposalTap : null;

  function observeProductionEntry(makeFacts) {
    if (productionEntryTap === null) return;
    let facts;
    try {
      facts = makeFacts();
    } catch {
      facts = { factCopyFailed: true };
    }
    try {
      productionEntryTap.observeProductionEntry(facts);
    } catch {
      // Observer-only evidence. The paper engine continues untouched.
    }
  }

  // PS.2b facts contain only copied scalars/diagnostic arrays. No engine
  // references, return values, clocks, randomness, IDs or asynchronous work.
  function observeSolFunnel(kind, makeFacts) {
    if (proposalTap === null || solOpportunityMint === null) return;
    try {
      if (typeof proposalTap.observeSolFunnel === "function") {
        proposalTap.observeSolFunnel({ kind, ...makeFacts() });
      }
    } catch {
      // Diagnostic failures cannot affect the scan or the PS.2a opportunity.
    }
  }

  // --- Phase 5A: strategy islands -------------------------------------------
  // An island is the species label used as a breeding boundary (see
  // engine/islands.mjs) rather than a new taxonomy. Disabled falls back to
  // the pre-5A behavior: every island's target is 0, so the island-aware
  // birth path below always takes the "no positive deficit" even-split
  // fallback, which reduces to the old global breeder pool in practice.
  const islandsConfig = config.islands ?? {};
  const islandsEnabled = islandsConfig.enabled !== false;
  const islandNames = [...SPECIES];
  const islandMigrationRate = clampNumber(islandsConfig.migrationRate, 0, 0.25, 0.04);
  const islandMaxMigrations = clampNumber(islandsConfig.maxMigrationsPerGeneration, 0, 10_000, 12);
  const crossSpeciesCrossoverRate = clampNumber(islandsConfig.crossSpeciesCrossoverRate, 0, 1, 0.05);
  const islandRandomImmigrantRate = clampNumber(islandsConfig.randomImmigrantRate, 0, 0.25, 0.03);
  const islandReviveExtinct = islandsConfig.reviveExtinct !== false;

  const { population: populationSize, generationTicks: configuredGenerationTicks } = config.engine;

  // Phase 5A.1: soft diversity-protected islands. `floor`/`cap` are explicit
  // diversity bounds (never a hard equal quota), and `maxShareDelta` bounds how
  // far one island's share may move per generation, so a single lucky
  // generation cannot hand the population to one island. `EVOLVE_ISLAND_MIN_SHARE=0`
  // opts back into the pre-5A.1 "an island may go extinct" behaviour.
  const islandPolicy = islandDiversityPolicy(populationSize, islandNames, {
    minShare: islandsConfig.minShare,
    maxShare: islandsConfig.maxShare,
    maxShareDelta: islandsConfig.maxShareDelta,
  });
  const islandFloor = islandsEnabled ? islandPolicy.floor : 0;
  const islandCap = islandsEnabled ? islandPolicy.cap : populationSize;
  const islandMaxShareDelta = islandsEnabled ? islandPolicy.maxShareDelta : 0;

  // Last generation's evidence-adjusted targets/weights, exposed on the
  // snapshot so the dashboard can show *why* an island is growing or shrinking.
  let lastIslandTargets = null;
  let lastIslandWeights = null;

  /** Base (initialization) split — a weight, never a per-generation quota. */
  function islandTargets() {
    return islandsEnabled
      ? islandTargetCounts(populationSize, islandNames, islandsConfig.targetCounts ?? {})
      : Object.fromEntries(islandNames.map((name) => [name, 0]));
  }
  // A generation cannot end before agents have had a chance to accumulate
  // evidence, regardless of how short config.engine.generationTicks is set.
  const generationTicks = Math.max(configuredGenerationTicks, minGenerationTicks);
  const startingCash = config.paper.startingCash;
  const minOrderUsd = Math.max(0.5, startingCash * 0.02);
  const maxHistory = 150;
  const maxEvents = 18;
  const maxStateMarkets = 40;
  const maxPositions = 24;
  const maxRecentTrades = 14;

  let generation = 1;
  let generationTick = 0;
  let bornTotal = populationSize;
  let terminatedTotal = 0;
  let population = [];
  let history = [];
  let events = [];
  let recentTrades = [];
  let lastGenerationSummary = null;
  let totalTrades = 0;
  const startedAt = now();

  // Phase 5A: research-injected candidates carry a lightweight evidence
  // ledger (bounded by distinct-mint count, never by trade count) so the
  // research cycle can watchdog-evaluate them without a full per-trade
  // history. `researchLedger` retains a FINAL snapshot for any research
  // candidate that was culled or replaced, so evidence is not lost the
  // moment an agent leaves the live population.
  let researchLedger = new Map(); // familyId -> evidence record
  let tickSnapshotBuffer = [];
  let currentRegimeLabel = null;
  const REGIME_BUFFER_SIZE = 24;
  const speciesStats = new Map(
    SPECIES.map((name) => [
      name,
      {
        births: 0,
        deaths: 0,
        peakCount: 0,
        extinctionEvents: 0,
        wasPresent: false,
        // Phase 5A: island bookkeeping, tracked on the same per-species entry
        // since an island *is* a species label used as a breeding boundary.
        migrationsIn: 0,
        migrationsOut: 0,
        revivals: 0,
      },
    ]),
  );

  function islandEntry(name) {
    if (!speciesStats.has(name)) {
      speciesStats.set(name, {
        births: 0,
        deaths: 0,
        peakCount: 0,
        extinctionEvents: 0,
        wasPresent: false,
        migrationsIn: 0,
        migrationsOut: 0,
        revivals: 0,
      });
    }
    return speciesStats.get(name);
  }

  function trackBirth(species) {
    islandEntry(species).births += 1;
  }

  function trackMigration(from, to) {
    islandEntry(from).migrationsOut += 1;
    islandEntry(to).migrationsIn += 1;
  }

  function trackRevival(island) {
    islandEntry(island).revivals += 1;
  }

  function trackDeaths(agents) {
    for (const agent of agents) {
      const entry = speciesStats.get(agent.species);
      if (entry) entry.deaths += 1;
      // A research candidate's evidence must not vanish just because it lost
      // the generation's selection — freeze what it did before it is gone.
      if (agent.researchMeta) captureResearchEvidence(agent);
    }
  }

  function trackCensus() {
    for (const [name, entry] of speciesStats) {
      const count = population.filter((agent) => agent.species === name).length;
      entry.peakCount = Math.max(entry.peakCount, count);
      if (count === 0 && entry.wasPresent) entry.extinctionEvents += 1;
      entry.wasPresent = count > 0;
    }
  }

  function addEvent(type, message) {
    // `nextId` is the seeded factory during replay/experiments, so events are
    // reproducible run to run; live runs keep the random-but-readable ids.
    events.unshift({ id: nextId("E"), at: new Date(now()).toISOString(), type, message });
    events = events.slice(0, maxEvents);
  }

  function makeAgent({
    genome,
    species,
    parents = [],
    born = generation,
    origin = ORIGIN.FOUNDER,
    lineageId = null,
    label = null,
  } = {}) {
    const resolvedSpecies = species ?? SPECIES[Math.floor(random() * SPECIES.length)];
    const id = nextId("A");
    const lineage = ancestry.record({
      id,
      generation: born,
      species: resolvedSpecies,
      parents,
      origin,
      lineageId,
    });
    trackBirth(resolvedSpecies);

    return {
      id,
      label,
      species: resolvedSpecies,
      parents,
      born,
      origin,
      lineageId: lineage,
      age: generation - born,
      // Per-generation accounting (what selection acts on).
      ledger: recordTrades ? [] : null,
      periodCosts: 0,
      exposureTicks: 0,
      observations: 0,
      // Cumulative stage accounting: survives generation resets so evidence
      // (trades, mints, costs) is not erased every time a bankroll resets.
      stageLedger: recordTrades ? [] : null,
      stageTrades: 0,
      stageWins: 0,
      stageLosses: 0,
      stageCosts: 0,
      stagePnl: 0,
      stageExposureTicks: 0,
      stageObservations: 0,
      stageMaxDrawdown: 0,
      genome: genome ?? randomGenome(resolvedSpecies, random),
      cash: startingCash,
      equity: startingCash,
      maxEquity: startingCash,
      maxDrawdown: 0,
      realizedPnl: 0,
      grossPnl: 0,
      costs: 0,
      trades: 0,
      wins: 0,
      losses: 0,
      fitness: 0,
      status: STATUS.SCANNING,
      position: null,
      lastAction: "Spawned",
      lastActionAt: now(),
    };
  }

  function seedPopulation() {
    if (Array.isArray(fixedPopulation) && fixedPopulation.length > 0) {
      // Frozen evaluation: one paper portfolio per supplied candidate genome.
      population = fixedPopulation.map((candidate) =>
        makeAgent({
          genome: candidate.genome,
          species: candidate.species ?? SPECIES[0],
          parents: candidate.parents ?? [],
          origin: candidate.origin ?? ORIGIN.FROZEN,
          lineageId: candidate.lineageId ?? null,
          label: candidate.label ?? null,
          born: generation,
        }),
      );
      trackCensus();
      return;
    }

    population = Array.from({ length: populationSize }, () => makeAgent({}));
    population.forEach((agent, index) => {
      agent.species = SPECIES[index % SPECIES.length];
      agent.genome = randomGenome(agent.species, random);
    });
    trackCensus();
  }

  function markToMarket(agent, ctx) {
    const position = agent.position;
    if (!position) {
      agent.equity = agent.cash;
      agent.unrealizedPnl = 0;
    } else {
      const market = ctx.byMint.get(position.mint);
      const mark = market && market.price > 0 ? market.price : position.lastMarkPrice;
      position.markPrice = mark;
      const value = finite(mark, position.entryRefPrice) * position.qty;
      agent.equity = agent.cash + value;
      agent.unrealizedPnl = value - position.cost;
    }

    agent.maxEquity = Math.max(agent.maxEquity, agent.equity);
    const drawdown =
      agent.maxEquity > 0 ? Math.max(0, (agent.maxEquity - agent.equity) / agent.maxEquity) : 0;
    agent.maxDrawdown = Math.max(agent.maxDrawdown, drawdown);
    agent.netPnl = agent.equity - startingCash;
    agent.grossPnl = agent.netPnl + agent.costs;
  }

  function closePosition(agent, reason, ctx) {
    const position = agent.position;
    if (!position) return false;

    const market = ctx.byMint.get(position.mint) ?? null;
    const price = market && market.price > 0 ? market.price : position.lastMarkPrice;
    const liquidity = market?.liquidity ?? position.entryLiquidity;

    // Phase 5I-PS.2: freeze the EXIT proposal BEFORE the paper execution
    // attempt. The existing deterministic exit reason is passed through
    // verbatim (SIGNAL / STOP / TAKE / TIME / GEN-END / STAGE-END).
    const exitHandle = freezeProposalForObserver({
      action: "EXIT_LONG",
      reason,
      at: ctx.at,
      generation,
      generationTick,
      agentId: agent.id,
      species: agent.species,
      lineageId: agent.lineageId ?? null,
      researchFamilyId: agent.researchMeta?.familyId ?? null,
      market: market ?? null,
      universeToken: feed.universe?.get?.(position.mint) ?? null,
      byMint: ctx.byMint,
      agentScore: null,
      entryScoreThreshold: agent.genome.entryScoreThreshold,
      paperCashBefore: agent.cash,
      intendedPaperNotional: null,
      referencePrice: price,
      liquidityUsd: liquidity,
      position: {
        mint: position.mint,
        symbol: position.symbol,
        qty: position.qty,
        cost: position.cost,
        entryRefPrice: position.entryRefPrice,
        entryPrice: position.entryPrice,
        entryLiquidity: position.entryLiquidity,
        heldTicks: position.held,
        entryAt: position.entryAt,
        entryScore: position.entryScore ?? null,
      },
    });

    const fill = simulateExit({
      qty: position.qty,
      price,
      liquidityUsd: liquidity,
      referencePrice: position.entryRefPrice,
      friction: config.paper,
    });

    if (!fill.ok) {
      // Keep the position and its last observed mark: never invent a price.
      agent.lastAction = `Exit blocked (${fill.reason})`;
      recordProposalExecutionForObserver(exitHandle, {
        executed: false,
        blocked: true,
        blockedReason: fill.reason,
        fillSide: null,
        referencePrice: finite(price, null),
        executedPrice: null,
        notional: null,
        qty: position.qty,
        feesUsd: null,
        frictionUsd: null,
        costBps: null,
      });
      markToMarket(agent, ctx);
      return false;
    }

    recordProposalExecutionForObserver(exitHandle, {
      executed: true,
      blocked: false,
      blockedReason: null,
      fillSide: "SELL",
      referencePrice: fill.referencePrice,
      executedPrice: fill.executedPrice,
      notional: fill.grossProceeds,
      netProceeds: fill.netProceeds,
      qty: fill.qty,
      feesUsd: fill.feeUsd,
      frictionUsd: fill.frictionUsd,
      costBps: fill.costBps,
    });

    agent.cash += fill.netProceeds;
    agent.realizedPnl += fill.netProceeds - position.cost;
    agent.costs += Math.max(0, fill.frictionUsd);
    agent.trades += 1;
    totalTrades += 1;

    const net = fill.netProceeds - position.cost;
    const tradeCost = position.costFriction + fill.frictionUsd;

    if (net >= 0) agent.wins += 1;
    else agent.losses += 1;

    const row = {
      mint: position.mint,
      symbol: position.symbol,
      reason,
      net,
      gross: fill.grossPnl,
      cost: tradeCost,
      // Entry notional (cash committed, including fee) — the executed size of
      // this trade. Used to measure mint concentration by actual exposure
      // rather than by which trades happened to be profitable.
      notional: position.cost,
      heldTicks: position.held,
      openedAt: position.entryAt,
      closedAt: ctx.at,
    };

    if (Array.isArray(agent.ledger)) agent.ledger.push(row);

    // Cumulative view: never reset by selection, so a candidate can be judged
    // on everything it did rather than on its final partial generation.
    if (Array.isArray(agent.stageLedger)) agent.stageLedger.push(row);
    if (agent.researchMeta) {
      // Bounded by distinct-mint count (not trade count) so a long-lived
      // research candidate cannot grow this without limit — no full ledger
      // is kept, only the aggregates the watchdog actually needs.
      agent.researchMintNotional = agent.researchMintNotional ?? {};
      agent.researchMintNotional[row.mint] = (agent.researchMintNotional[row.mint] ?? 0) + Math.max(0, row.notional);
      agent.researchMaxSingleTradeReturn = Math.max(agent.researchMaxSingleTradeReturn ?? 0, net);
      agent.researchTotalPositiveReturn = (agent.researchTotalPositiveReturn ?? 0) + Math.max(0, net);
    }
    agent.stageTrades = (agent.stageTrades ?? 0) + 1;
    agent.stageCosts = (agent.stageCosts ?? 0) + Math.max(0, fill.frictionUsd);
    agent.stagePnl = (agent.stagePnl ?? 0) + net;
    agent.stageMaxDrawdown = Math.max(agent.stageMaxDrawdown ?? 0, agent.maxDrawdown ?? 0);
    if (net >= 0) agent.stageWins = (agent.stageWins ?? 0) + 1;
    else agent.stageLosses = (agent.stageLosses ?? 0) + 1;

    agent.lastAction = `${reason} ${position.symbol} ${net >= 0 ? "+" : "-"}$${Math.abs(net).toFixed(2)}`;
    agent.lastActionAt = ctx.at;
    // Flat agents are only 'scanning' when the feed currently allows entries.
    agent.status = ctx.allowNewEntries ? STATUS.SCANNING : STATUS.PAUSED;
    agent.position = null;

    recentTrades.unshift({
      id: nextId("T"),
      at: new Date(ctx.at).toISOString(),
      agentId: agent.id,
      species: agent.species,
      symbol: position.symbol,
      mint: position.mint,
      reason,
      netPnl: round(net, 2),
      grossPnl: round(fill.grossPnl, 2),
      costUsd: round(position.costFriction + fill.frictionUsd, 2),
      heldTicks: position.held,
      paper: true,
    });
    recentTrades = recentTrades.slice(0, maxRecentTrades);

    markToMarket(agent, ctx);
    return true;
  }

  function openPosition(agent, market, ctx) {
    const genome = agent.genome;
    // Phase 5A: a research candidate's declared REDUCED_RISK posture scales
    // its position size down (ABSTAIN never reaches here — stepAgent returns
    // before scanning for entries). Every other agent's multiplier is 1, so
    // this is a no-op for the entire pre-5A population.
    const riskMultiplier = Number.isFinite(agent.researchRiskMultiplier) ? agent.researchRiskMultiplier : 1;
    const notional = Math.min(
      agent.cash * genome.riskFraction * riskMultiplier,
      agent.cash * config.paper.maxPositionFraction,
      market.liquidity * config.paper.maxLiquidityFraction,
    );

    // Phase 5I-PS.2: freeze the ENTRY proposal BEFORE the paper execution
    // attempt. `market`/`universeToken`/`byMint` are handed over as observed
    // references; the observer snapshots whatever it needs and returns at most
    // an opaque handle.
    const entryHandle = freezeProposalForObserver({
      action: "ENTER_LONG",
      reason: "ENTRY_SIGNAL",
      at: ctx.at,
      generation,
      generationTick,
      agentId: agent.id,
      species: agent.species,
      lineageId: agent.lineageId ?? null,
      researchFamilyId: agent.researchMeta?.familyId ?? null,
      market,
      universeToken: feed.universe?.get?.(market.mint) ?? null,
      byMint: ctx.byMint,
      agentScore: ctx.bestScore,
      entryScoreThreshold: genome.entryScoreThreshold,
      paperCashBefore: agent.cash,
      intendedPaperNotional: Number.isFinite(notional) ? notional : null,
      referencePrice: market.price,
      liquidityUsd: market.liquidity,
      riskMultiplier: riskMultiplier === 1 ? null : riskMultiplier,
      position: null,
    });

    if (!Number.isFinite(notional) || notional < minOrderUsd) {
      agent.lastAction = `Size too small for ${market.symbol}`;
      recordProposalExecutionForObserver(entryHandle, {
        executed: false,
        blocked: true,
        blockedReason: "size_below_minimum_order",
        fillSide: null,
        referencePrice: finite(market.price, null),
        executedPrice: null,
        notional: Number.isFinite(notional) ? notional : null,
        qty: null,
        feesUsd: null,
        frictionUsd: null,
        costBps: null,
      });
      return false;
    }

    const fill = simulateEntry({
      price: market.price,
      notionalUsd: notional,
      liquidityUsd: market.liquidity,
      friction: config.paper,
    });

    if (!fill.ok) {
      agent.lastAction = `Entry blocked (${fill.reason})`;
      recordProposalExecutionForObserver(entryHandle, {
        executed: false,
        blocked: true,
        blockedReason: fill.reason,
        fillSide: null,
        referencePrice: finite(market.price, null),
        executedPrice: null,
        notional,
        qty: null,
        feesUsd: null,
        frictionUsd: null,
        costBps: null,
      });
      return false;
    }

    recordProposalExecutionForObserver(entryHandle, {
      executed: true,
      blocked: false,
      blockedReason: null,
      fillSide: "BUY",
      referencePrice: fill.referencePrice,
      executedPrice: fill.executedPrice,
      notional: fill.cashSpent,
      qty: fill.qty,
      feesUsd: fill.feeUsd,
      frictionUsd: fill.frictionUsd,
      costBps: fill.costBps,
    });

    agent.cash -= fill.cashSpent;
    agent.costs += fill.frictionUsd;
    agent.periodCosts = (agent.periodCosts ?? 0) + fill.frictionUsd;
    agent.position = {
      mint: market.mint,
      symbol: market.symbol,
      qty: fill.qty,
      cost: fill.cashSpent,
      entryRefPrice: fill.referencePrice,
      entryPrice: fill.executedPrice,
      entryLiquidity: market.liquidity,
      entryAt: ctx.at,
      entryTick: generationTick,
      entryScore: ctx.bestScore ?? null,
      costFriction: fill.frictionUsd,
      markPrice: market.price,
      lastMarkPrice: market.price,
      lastMarkAt: ctx.at,
      held: 0,
      paper: true,
    };
    agent.status = STATUS.HOLDING;
    agent.lastAction = `BUY ${market.symbol} $${fill.cashSpent.toFixed(2)} paper`;
    agent.lastActionAt = ctx.at;
    return true;
  }

  function stepAgent(agent, ctx) {
    if (agent.position) {
      const position = agent.position;
      const market = ctx.byMint.get(position.mint) ?? null;

      position.held += 1;
      agent.exposureTicks += 1;
      agent.stageExposureTicks = (agent.stageExposureTicks ?? 0) + 1;
      agent.stageMaxDrawdown = Math.max(agent.stageMaxDrawdown ?? 0, agent.maxDrawdown ?? 0);
      if (market && market.price > 0) {
        position.lastMarkPrice = market.price;
        position.lastMarkAt = ctx.at;
      }

      const mark = finite(position.lastMarkPrice, position.entryRefPrice);
      const move = position.entryRefPrice > 0 ? mark / position.entryRefPrice - 1 : 0;

      if (move <= -agent.genome.stopLoss) {
        closePosition(agent, "STOP", ctx);
      } else if (move >= agent.genome.takeProfit) {
        closePosition(agent, "TAKE", ctx);
      } else if (position.held >= Math.max(3, Math.round(agent.genome.maxHold))) {
        closePosition(agent, "TIME", ctx);
      } else if (market && market.fresh && scoreMarket(agent.genome, market) < agent.genome.entryScoreThreshold - 0.25) {
        closePosition(agent, "SIGNAL", ctx);
      } else {
        agent.status = STATUS.HOLDING;
        agent.lastAction = `Holding ${position.symbol} ${move >= 0 ? "+" : ""}${(move * 100).toFixed(1)}%`;
      }

      markToMarket(agent, ctx);
      return;
    }

    if (!ctx.allowNewEntries) {
      agent.status = STATUS.PAUSED;
      // Phase 5A.2 diagnostic: ticks where no entry was even possible.
      agent.stagePausedTicks = (agent.stagePausedTicks ?? 0) + 1;
      agent.lastAction = "Entries paused — market feed degraded";
      markToMarket(agent, ctx);
      return;
    }

    // Phase 5A: ACTIVE / REDUCED_RISK / ABSTAIN. Deterministic and regime-
    // driven, scoped to research-injected candidates only (agents that
    // declare abstainRegimes/targetRegimes) — every pre-5A agent has neither
    // array set, so this block is a complete no-op for them and behavior is
    // byte-for-byte unchanged. No external research model makes this call at
    // runtime: it is the same rule table every replay of the same data
    // reproduces (see engine/families.mjs).
    agent.researchRiskMultiplier = 1;
    if (Array.isArray(agent.abstainRegimes) && agent.abstainRegimes.length > 0) {
      const posture = abstentionDecision({
        regime: ctx.regime ?? currentRegimeLabel,
        allowNewEntries: ctx.allowNewEntries,
        hasPosition: false,
        eligibleCount: ctx.tradeable.length,
        abstainRegimes: agent.abstainRegimes,
      });
      agent.researchPosture = posture.state;
      agent.researchRiskMultiplier = riskMultiplierFor(posture.state);
      if (posture.state === ABSTAIN_STATE.ABSTAIN) {
        agent.status = STATUS.SCANNING;
        // Phase 5A.2 diagnostic: declared abstention is a legitimate choice,
        // but it must be visible when explaining a thin distinct-mint count.
        agent.stageAbstainedTicks = (agent.stageAbstainedTicks ?? 0) + 1;
        agent.lastAction = `Abstaining — ${posture.reason}`;
        markToMarket(agent, ctx);
        return;
      }
    }

    let best = null;
    let bestScore = -Infinity;
    let eligibleCount = 0;
    let solOpportunityHandle = null;

    observeSolFunnel("scan", () => ({}));
    for (const market of ctx.tradeable) {
      const gatesPass = passesGates(agent.genome, market, ctx);
      if (market.mint === solOpportunityMint) {
        observeSolFunnel("evaluation", () => ({
          species: agent.species,
          ...assessGates(agent.genome, market, ctx),
        }));
        // PS.2c: a separate protected call, so a counterfactual failure can
        // neither alter the PS.2b fact above nor any decision below.
        observeSolFunnel("age_counterfactual", () => ({
          species: agent.species,
          ...assessPoolAgeCounterfactual(agent.genome, market, ctx),
        }));
      }
      if (!gatesPass) continue;
      eligibleCount += 1;
      // Phase 5A.2 diagnostics: WHY a candidate traded too few distinct
      // mints. Bounded by distinct-mint count, never by tick count, so a
      // long-lived agent cannot grow this without limit.
      agent.stageEligibleMints = agent.stageEligibleMints ?? {};
      agent.stageEligibleMints[market.mint] = (agent.stageEligibleMints[market.mint] ?? 0) + 1;
      const score = scoreMarket(agent.genome, market);
      if (market.mint === solOpportunityMint) {
        observeSolFunnel("score", () => ({
          species: agent.species, solScore: score,
          entryScoreThreshold: agent.genome.entryScoreThreshold,
        }));
      }

      // Phase 5I-PS.2a: the EXACT observation point. After gates and scoring,
      // if the market mint is the declared SOL identity and the genome's
      // EXISTING entry threshold is met, freeze a passive SOL opportunity.
      // This reads `score` and the existing threshold only: `best`, `bestScore`,
      // the comparison below and all execution are untouched, so EVOLVE's own
      // market selection is byte-for-byte unchanged.
      if (
        solOpportunityHandle === null &&
        solOpportunityMint !== null &&
        market.mint === solOpportunityMint &&
        score >= agent.genome.entryScoreThreshold
      ) {
        solOpportunityHandle = freezeSolOpportunityForObserver({
          at: ctx.at,
          generation,
          generationTick,
          agentId: agent.id,
          species: agent.species,
          lineageId: agent.lineageId ?? null,
          researchFamilyId: agent.researchMeta?.familyId ?? null,
          market,
          universeToken: feed.universe?.get?.(market.mint) ?? null,
          byMint: ctx.byMint,
          solScore: score,
          agentEntryThreshold: agent.genome.entryScoreThreshold,
        });
      }

      if (score > bestScore) {
        bestScore = score;
        best = market;
      }
    }

    // The actual selection is now frozen. Report it to the observer (which by
    // construction only ever sees `best`), then continue exactly as before.
    recordSolSelectionForObserver(solOpportunityHandle, {
      actualSelectedMint: best !== null ? best.mint : null,
      actualSelectedSymbol: best !== null ? best.symbol : null,
      actualSelectedScore: Number.isFinite(bestScore) ? bestScore : null,
    });

    agent.stageOpportunities = (agent.stageOpportunities ?? 0) + ctx.tradeable.length;
    agent.stageEligibleTicks = (agent.stageEligibleTicks ?? 0) + eligibleCount;

    agent.status = STATUS.SCANNING;

    if (!best || bestScore < agent.genome.entryScoreThreshold) {
      if (!best) agent.stageNoEligibleTicks = (agent.stageNoEligibleTicks ?? 0) + 1;
      else agent.stageBelowThresholdTicks = (agent.stageBelowThresholdTicks ?? 0) + 1;
      agent.lastAction = best
        ? `Scanning ${best.symbol} ${bestScore.toFixed(2)} < ${agent.genome.entryScoreThreshold.toFixed(2)}`
        : "Scanning — no eligible token";
      markToMarket(agent, ctx);
      return;
    }

    ctx.bestScore = bestScore;
    // Phase 5I-PS.2d: the production entry decision is FINAL here (gates passed,
    // unchanged argmax selection, unchanged `>=` threshold). Hand copied facts to
    // the passive tap, then continue exactly as before. Nothing is read back.
    observeProductionEntry(() => ({
      source: "PRODUCTION_ENTRY_PROPOSAL",
      action: "ENTER_LONG",
      selection: "PRODUCTION_BEST_SCORE",
      at: ctx.at,
      generation,
      generationTick,
      agentId: agent.id,
      species: agent.species,
      lineageId: agent.lineageId ?? null,
      researchFamilyId: agent.researchMeta?.familyId ?? null,
      productionScore: bestScore,
      entryScoreThreshold: agent.genome.entryScoreThreshold,
      gateAssessment: assessGates(agent.genome, best, ctx),
      eligibleMarketCount: eligibleCount,
      tradeableMarketCount: ctx.tradeable.length,
      engineRegime: typeof ctx.regime === "string" ? ctx.regime : null,
      market: structuredClone(best),
    }));
    if (!openPosition(agent, best, ctx)) {
      ctx.bestScore = null;
      agent.stageBlockedEntries = (agent.stageBlockedEntries ?? 0) + 1;
    }
    markToMarket(agent, ctx);
  }

  /** Fitness is NET: equity already includes simulated fees and slippage. */
  function fitness(agent) {
    return computeFitness(agent, startingCash);
  }

  const evidenceOptions = { minTradesForSelection, minObservationsForSelection };

  function resetSurvivor(agent) {
    return {
      ...agent,
      age: generation + 1 - agent.born,
      cash: startingCash,
      equity: startingCash,
      maxEquity: startingCash,
      maxDrawdown: 0,
      realizedPnl: 0,
      grossPnl: 0,
      costs: 0,
      periodCosts: 0,
      unrealizedPnl: 0,
      trades: 0,
      wins: 0,
      losses: 0,
      fitness: 0,
      status: STATUS.SCANNING,
      position: null,
      lastAction: "Elite survived",
      lastActionAt: now(),
    };
  }

  /**
   * Compact watchdog-ready evidence for one research candidate, derived from
   * its cumulative stage accounting (never reset by survivor rollover). Null
   * for any agent that is not a research candidate.
   */
  function evidenceFromAgent(agent) {
    const meta = agent?.researchMeta;
    if (!meta) return null;
    const mintNotional = { ...(agent.researchMintNotional ?? {}) };
    return {
      familyId: meta.familyId,
      proposalId: meta.proposalId,
      authorRole: meta.authorRole ?? null,
      species: agent.species,
      agentId: agent.id,
      alive: true,
      generation,
      trades: agent.stageTrades ?? 0,
      distinctMints: Object.keys(mintNotional).length,
      mintNotional,
      costDrag: startingCash > 0 ? (agent.stageCosts ?? 0) / startingCash : 0,
      maxSingleTradeReturn: agent.researchMaxSingleTradeReturn ?? 0,
      totalPositiveReturn: agent.researchTotalPositiveReturn ?? 0,
      maxDrawdown: agent.stageMaxDrawdown ?? 0,
      observations: agent.stageObservations ?? 0,
      netReturn: startingCash > 0 ? (agent.stagePnl ?? 0) / startingCash : 0,
      // Phase 5A.2 distinct-mint diagnostics: the reasons a candidate may
      // have traded too few mints, exposed as evidence rather than guessed.
      opportunitiesObserved: agent.stageOpportunities ?? 0,
      eligibleTicks: agent.stageEligibleTicks ?? 0,
      eligibleMints: Object.keys(agent.stageEligibleMints ?? {}).length,
      blockedEntries: agent.stageBlockedEntries ?? 0,
      abstainedTicks: agent.stageAbstainedTicks ?? 0,
      noEligibleTicks: agent.stageNoEligibleTicks ?? 0,
      belowThresholdTicks: agent.stageBelowThresholdTicks ?? 0,
      pausedTicks: agent.stagePausedTicks ?? 0,
    };
  }

  /** Freeze a research candidate's evidence before it leaves the population. */
  function captureResearchEvidence(agent) {
    const evidence = evidenceFromAgent(agent);
    if (!evidence) return;
    researchLedger.set(evidence.familyId, { ...evidence, alive: false });
  }

  /** Current evidence for every tracked research candidate, alive or culled. */
  function getResearchEvidence() {
    const merged = new Map(researchLedger);
    for (const agent of population) {
      const evidence = evidenceFromAgent(agent);
      if (evidence) merged.set(evidence.familyId, evidence);
    }
    return [...merged.values()];
  }

  /** Drop finalized evidence records once the research cycle has consumed them. */
  function clearResearchEvidence(familyIds) {
    for (const id of familyIds ?? []) researchLedger.delete(id);
  }

  /**
   * Inject one deterministically-compiled research candidate into the live
   * population, replacing the current lowest-fitness agent. Population size
   * is invariant by construction (a replace, never an append). The injected
   * agent is an ordinary genome from the moment it exists — it competes,
   * survives, or dies under the exact same rules as any other agent; nothing
   * here grants it special selection privilege.
   */
  function injectResearchCandidate({
    genome,
    species = null,
    familyId,
    proposalId,
    authorRole = null,
    targetRegimes = [],
    abstainRegimes = [],
  } = {}) {
    if (!genome || population.length === 0 || !familyId) return null;

    for (const agent of population) agent.fitness = fitness(agent);
    let worstIdx = 0;
    for (let i = 1; i < population.length; i += 1) {
      if (population[i].fitness < population[worstIdx].fitness) worstIdx = i;
    }
    const victim = population[worstIdx];
    if (victim.researchMeta) captureResearchEvidence(victim);

    const resolvedSpecies = SPECIES.includes(species) ? species : SPECIES[Math.floor(random() * SPECIES.length)];
    const agent = makeAgent({
      genome,
      species: resolvedSpecies,
      parents: [],
      origin: ORIGIN.RESEARCH,
      born: generation,
      label: familyId,
    });
    agent.researchMeta = { familyId, proposalId: proposalId ?? null, authorRole };
    agent.targetRegimes = Array.isArray(targetRegimes) ? [...targetRegimes] : [];
    agent.abstainRegimes = Array.isArray(abstainRegimes) ? [...abstainRegimes] : [];
    population[worstIdx] = agent;
    return agent.id;
  }

  function breedGeneration(explicitCtx = null) {
    if (!evolutionEnabled) {
      // Frozen mode (validation / test): rank for reporting only. Genomes must
      // not change, so nothing is bred, culled, or reset.
      for (const agent of population) {
        agent.fitness = fitness(agent);
      }
      const rankedFrozen = [...population].sort((a, b) => b.fitness - a.fitness);
      lastGenerationSummary = {
        generation,
        bestId: rankedFrozen[0]?.id ?? null,
        bestSpecies: rankedFrozen[0]?.species ?? null,
        bestReturn: rankedFrozen[0]
          ? averageReturnSafe((rankedFrozen[0].equity - startingCash) / startingCash)
          : 0,
        averageReturn: averageReturnSafe(
          population.reduce((sum, agent) => sum + (agent.equity - startingCash) / startingCash, 0) /
            Math.max(1, population.length),
        ),
        bestFitness: round(rankedFrozen[0]?.fitness ?? 0, 3),
        trades: population.reduce((sum, agent) => sum + agent.trades, 0),
        frozen: true,
      };
      return;
    }

    const at = now();
    const markets = feed.markets(at);
    const ctx =
      explicitCtx ?? {
        at,
        byMint: new Map(markets.map((market) => [market.mint, market])),
        tradeable: [],
        allowNewEntries: false,
        minLiquidityUsd: config.minLiquidityUsd,
        friction: config.paper,
        bestScore: null,
      };

    for (const agent of population) {
      if (agent.position) closePosition(agent, "GEN-END", ctx);
      agent.fitness = fitness(agent);
    }

    // Evidence-sufficient agents are always ranked ahead of everything else,
    // fitness breaking ties within each tier. This is what stops a one-trade
    // lucky winner from dominating selection: no matter how large its raw
    // fitness number is, it cannot outrank a properly evidenced agent — it
    // can only compete with other unproven agents. See rankForSelection.
    population = rankForSelection(population, evidenceOptions);
    const best = population[0];
    const averageReturn =
      population.reduce((sum, agent) => sum + (agent.equity - startingCash) / startingCash, 0) /
      population.length;

    lastGenerationSummary = {
      generation,
      bestId: best.id,
      bestSpecies: best.species,
      bestReturn: averageReturnSafe((best.equity - startingCash) / startingCash),
      averageReturn: averageReturnSafe(averageReturn),
      bestFitness: round(best.fitness, 3),
      trades: population.reduce((sum, agent) => sum + agent.trades, 0),
    };

    const eliteCount = Math.max(1, Math.floor(populationSize * eliteFraction));
    // Survivors: a wider, evidence-ranked tier that lives on unculled beyond
    // just the elites, so replacement per generation stays well below the
    // ~90% a pure elites-only-survive policy produces at the default 10%
    // elite fraction. Insufficient-evidence agents may still occupy a
    // survivor slot (they are not killed for lack of evidence) — they are
    // just never able to out-rank evidenced agents to get there.
    const survivorCount = Math.max(
      eliteCount,
      Math.min(populationSize, Math.round(populationSize * survivorFraction)),
    );
    const immigrantCount = Math.max(0, Math.floor(populationSize * immigrantRate));
    // Phase 5A.1: the island populations this generation started from (before
    // any culling). The soft diversity policy measures share movement against
    // *this*, so an island can gain/lose real share across generations without
    // one lucky generation being able to hand it the whole population.
    const startCounts = Object.fromEntries(islandNames.map((name) => [name, 0]));
    for (const agent of population) {
      if (startCounts[agent.species] !== undefined) startCounts[agent.species] += 1;
    }

    const elites = population.slice(0, eliteCount);
    const survivorPool = population.slice(0, survivorCount);
    // Phase 5A.1: the ending generation's per-agent evidence is captured here,
    // before `resetSurvivor` zeroes this generation's accounting, so the island
    // reproductive weights below are computed from what the agents actually did
    // (trades / observations / fitness) rather than a fresh, empty ledger.
    const endingEvidence = new Map();
    for (const agent of survivorPool) endingEvidence.set(agent.id, agent);
    const deaths = populationSize - survivorCount;
    const culled = population.slice(survivorCount);
    trackDeaths(culled);

    addEvent(
      "GENERATION",
      `Generation ${generation} ended. ${best.id} led at ${(averageReturnSafe(lastGenerationSummary.bestReturn) * 100).toFixed(1)}% net paper return.`,
    );
    addEvent("DEATH", `${deaths} weak agents terminated by selection.`);

    const next = survivorPool.map(resetSurvivor);

    // --- Phase 5A: island migration -----------------------------------------
    // A bounded fraction of this generation's survivors emigrate to a
    // different island (their genome carries over unchanged; only the label
    // that governs future breeding changes). Bounded by both a rate and an
    // absolute per-generation cap so migration informs without homogenizing.
    if (islandsEnabled && islandMigrationRate > 0 && islandMaxMigrations > 0) {
      let migrations = 0;
      for (const agent of next) {
        if (migrations >= islandMaxMigrations) break;
        if (random() >= islandMigrationRate) continue;
        const destination = pickOtherIsland(islandNames, agent.species, random);
        if (!destination) continue;
        trackMigration(agent.species, destination);
        agent.species = destination;
        agent.origin = ORIGIN.SURVIVOR;
        migrations += 1;
      }
    }

    // --- Phase 5A: island-scoped births --------------------------------------
    // First, the long-standing global exploration floor: a fixed fraction of
    // every generation's births are pure random immigrants, species picked
    // uniformly (unchanged from pre-5A behavior — EVOLVE_IMMIGRANT_RATE).
    for (let i = 0; i < immigrantCount && next.length < populationSize; i += 1) {
      const species = SPECIES[Math.floor(random() * SPECIES.length)];
      next.push(
        makeAgent({ genome: randomGenome(species, random), species, parents: [], origin: ORIGIN.IMMIGRANT, born: generation + 1 }),
      );
    }

    // Remaining births follow the Phase 5A.1 soft diversity model. Each
    // island's *evidence-adjusted reproductive weight* becomes a desired
    // share; movement toward that share is bounded per generation, and the
    // resulting soft target is clamped into [diversity floor, monoculture cap].
    // Births fill the floor first, then move each island toward its soft
    // target, and their exact sum is always `remainingBirths` — so island
    // populations may diverge substantially while the global population stays
    // exact. An island's weight cannot be bought with one lucky agent, because
    // the fitness advantage is damped by how much of that island's surviving
    // population actually has sufficient evidence.
    const targets = islandTargets();
    function currentIslandCounts() {
      const counts = Object.fromEntries(islandNames.map((name) => [name, 0]));
      for (const agent of next) counts[agent.species] = (counts[agent.species] ?? 0) + 1;
      return counts;
    }

    // Breeder pools are a fixed snapshot taken once, before any of this
    // generation's births are added — never recomputed mid-loop. Otherwise a
    // just-born (fitness-0) sibling could become eligible to breed later in
    // the same generation's island loop, diluting "breed from proven
    // survivors" into "breed from whatever was added first."
    const breederPools = new Map(
      islandNames.map((name) => {
        const local = next
          .filter((agent) => agent.species === name)
          .sort((a, b) => (b.fitness ?? -Infinity) - (a.fitness ?? -Infinity));
        const count = local.length === 0 ? 0 : Math.max(1, Math.round(local.length * breederFraction));
        return [name, local.slice(0, count)];
      }),
    );
    function breedersForIsland(name) {
      return breederPools.get(name) ?? [];
    }

    const remainingBirths = Math.max(0, populationSize - next.length);
    const counts = currentIslandCounts();

    // Per-island evidence for this generation's weights (post-migration labels,
    // pre-reset measurement — a migrant's evidence follows it to its new island).
    const islandStats = Object.fromEntries(
      islandNames.map((name) => [name, { population: 0, trades: 0, evidenceSufficientCount: 0, fitness: [] }]),
    );
    for (const agent of next) {
      const stats = islandStats[agent.species];
      if (!stats) continue;
      const measured = endingEvidence.get(agent.id) ?? agent;
      stats.population += 1;
      stats.trades += finite(measured.trades, 0);
      stats.fitness.push(finite(measured.fitness, 0));
      if (hasSufficientEvidence(measured, evidenceOptions)) stats.evidenceSufficientCount += 1;
    }
    for (const stats of Object.values(islandStats)) {
      const sorted = stats.fitness.sort((a, b) => a - b);
      stats.meanFitness = sorted.length > 0 ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
      stats.medianFitness = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;
    }

    const islandWeights = islandsEnabled
      ? islandReproductiveWeights(islandStats, {
          baseWeights: targets,
          advantageStrength: islandsConfig.advantageStrength,
          fitnessScale: islandsConfig.fitnessScale,
        })
      : Object.fromEntries(islandNames.map((name) => [name, 1]));
    const softTargets = islandSoftTargets({
      startCounts,
      weights: islandWeights,
      // Shares are measured against the configured population size, not the
      // interim post-cull count.
      total: populationSize,
      floor: islandFloor,
      cap: islandCap,
      maxShareDelta: islandMaxShareDelta,
    });
    const allocation = islandsEnabled
      ? allocateIslandBirths({
          counts,
          targets: softTargets,
          weights: islandWeights,
          birthsNeeded: remainingBirths,
          floor: islandFloor,
          cap: islandCap,
        })
      : { [islandNames[0]]: remainingBirths };
    if (islandsEnabled) {
      lastIslandTargets = softTargets;
      lastIslandWeights = islandWeights;
    }

    for (const name of islandNames) {
      const slots = allocation[name] ?? 0;
      if (slots <= 0) continue;
      const wasExtinctBeforeThisGeneration = counts[name] === 0;
      for (let i = 0; i < slots; i += 1) {
        if (islandRandomImmigrantRate > 0 && random() < islandRandomImmigrantRate) {
          next.push(
            makeAgent({ genome: randomGenome(name, random), species: name, parents: [], origin: ORIGIN.IMMIGRANT, born: generation + 1 }),
          );
          continue;
        }

        const localBreeders = breedersForIsland(name);
        if (localBreeders.length === 0) {
          // Extinct island: revive with a fresh random genome rather than
          // leaving the target permanently unfilled. Not the same as
          // protecting a poor island — a revived island still has to earn
          // its way back through ordinary fitness selection from here.
          if (islandReviveExtinct) {
            next.push(
              makeAgent({ genome: randomGenome(name, random), species: name, parents: [], origin: ORIGIN.IMMIGRANT, born: generation + 1 }),
            );
            if (wasExtinctBeforeThisGeneration) trackRevival(name);
          }
          continue;
        }

        const useCrossIsland = islandsEnabled && random() < crossSpeciesCrossoverRate;
        const otherIsland = useCrossIsland ? pickOtherIsland(islandNames, name, random) : null;
        const otherBreeders = otherIsland ? breedersForIsland(otherIsland) : [];

        const a = localBreeders[Math.floor(random() * localBreeders.length)];
        const b = otherBreeders.length > 0 ? otherBreeders[Math.floor(random() * otherBreeders.length)] : localBreeders[Math.floor(random() * localBreeders.length)];

        const useCrossover = random() < crossoverRate;
        const genome = useCrossover
          ? crossoverGenomes(a.genome, b.genome, { random, species: evolutionOptions.speciesPull ? name : null })
          : mutateGenome(a.genome, { scale: mutationScale, random, species: evolutionOptions.speciesPull ? name : null });

        next.push(
          makeAgent({
            genome,
            species: name,
            parents: a.id === b.id ? [a.id] : [a.id, b.id],
            origin: useCrossover ? ORIGIN.CROSSOVER : ORIGIN.MUTATION,
            lineageId: a.lineageId,
            born: generation + 1,
          }),
        );
      }
    }

    // Deterministic backstop: rounding inside allocateBirths/migration can
    // leave the population a handful of agents short in edge configurations
    // (e.g. every island simultaneously extinct with revival disabled) —
    // fill any remainder with plain random immigrants so populationSize is
    // always exact, never a best-effort approximation.
    while (next.length < populationSize) {
      const species = SPECIES[Math.floor(random() * SPECIES.length)];
      next.push(
        makeAgent({ genome: randomGenome(species, random), species, parents: [], origin: ORIGIN.IMMIGRANT, born: generation + 1 }),
      );
    }
    if (next.length > populationSize) next.length = populationSize;

    for (const agent of next.slice(0, elites.length)) {
      agent.origin = ORIGIN.ELITE;
    }
    for (const agent of next.slice(elites.length, survivorPool.length)) {
      agent.origin = ORIGIN.SURVIVOR;
    }

    terminatedTotal += deaths;
    bornTotal += next.length - survivorCount;
    generation += 1;
    generationTick = 0;
    population = next;
    trackCensus();
    addEvent("BIRTH", `${populationSize - survivorCount} new agents entered generation ${generation}.`);
  }

  function averageReturnSafe(value) {
    return Number.isFinite(value) ? value : 0;
  }

  /**
   * Settle every open paper position at the last observed price.
   *
   * Used at the end of a replay stage so the measured period is realized rather
   * than left floating: no price is invented, an agent whose token vanished
   * settles at its own last mark, and every resulting fill flows through the
   * same friction model as any other exit.
   */
  function settle({ reason = "STAGE-END" } = {}) {
    const at = now();
    const markets = feed.markets(at);
    const ctx = {
      at,
      markets,
      byMint: new Map(markets.map((market) => [market.mint, market])),
      tradeable: [],
      allowNewEntries: false,
      minLiquidityUsd: config.minLiquidityUsd,
      friction: config.paper,
      bestScore: null,
    };

    let closed = 0;
    for (const agent of population) {
      if (!agent.position) continue;
      if (closePosition(agent, reason, ctx)) closed += 1;
      markToMarket(agent, ctx);
    }
    return closed;
  }

  /** One simulation step. Reads the feed, never advances it. */
  function advanceTick() {
    const at = now();
    const markets = feed.markets(at);
    const health = feed.health(at);

    const byMint = new Map();
    const tradeable = [];
    for (const market of markets) {
      byMint.set(market.mint, market);
      if (market.fresh !== true) continue;
      if (!(market.price > 0) || !(market.liquidity > 0)) continue;
      tradeable.push(market);
    }

    // Optional scan cap: agents consider the most liquid N markets per tick.
    // Never enabled for live mode by default; used to keep long replays tractable.
    const scanned =
      scanLimit > 0 && tradeable.length > scanLimit
        ? [...tradeable]
            .sort((a, b) => b.liquidity - a.liquidity || (a.mint < b.mint ? -1 : 1))
            .slice(0, scanLimit)
        : tradeable;

    // Phase 5A: live regime classification. The same deterministic classifier
    // the Arena uses on historical windows (arena/orchestrator.mjs
    // classifyWindowRegime) over a small bounded rolling buffer of
    // already-observed ticks (REGIME_BUFFER_SIZE), so replaying the same data
    // reproduces the same regime sequence and therefore the same activation
    // states. Computed every tick regardless of whether any agent currently
    // uses it: cost is bounded by the buffer size, not by population, and the
    // research evidence packet needs a regime label even in the very first
    // cycle, before any research candidate exists to read it back.
    tickSnapshotBuffer.push({ t: at, markets });
    if (tickSnapshotBuffer.length > REGIME_BUFFER_SIZE) tickSnapshotBuffer.shift();
    try {
      currentRegimeLabel = classifyWindowRegime(tickSnapshotBuffer)?.regime ?? null;
    } catch {
      currentRegimeLabel = null;
    }

    const ctx = {
      at,
      markets,
      tradeable: scanned,
      byMint,
      allowNewEntries: health.allowNewEntries === true && scanned.length > 0,
      minLiquidityUsd: config.minLiquidityUsd,
      friction: config.paper,
      bestScore: null,
      regime: currentRegimeLabel,
    };

    observeSolFunnel("tick", () => {
      const sol = byMint.get(solOpportunityMint);
      return {
        at, inByMint: byMint.has(solOpportunityMint),
        inFeedUniverse: feed.universe?.has?.(solOpportunityMint) === true,
        inTradeable: scanned.some((market) => market.mint === solOpportunityMint),
        fresh: sol?.fresh === true,
        referencePrice: Number.isFinite(sol?.price) ? sol.price : null,
        liquidity: Number.isFinite(sol?.liquidity) ? sol.liquidity : null,
        allowNewEntries: ctx.allowNewEntries,
      };
    });
    for (const agent of population) {
      ctx.bestScore = null;
      agent.observations += 1;
      agent.stageObservations = (agent.stageObservations ?? 0) + 1;
      stepAgent(agent, ctx);
    }

    generationTick += 1;

    if (evolutionEnabled) {
      if (generationTick >= generationTicks) breedGeneration(ctx);
    } else {
      // Frozen evaluation: keep ranking for reporting, never mutate anything.
      for (const agent of population) agent.fitness = fitness(agent);
    }

    return { at, health, marketCount: markets.length, tradeable: scanned.length };
  }

  function regime(markets) {
    if (feed.effectiveMode === "synthetic") return feed.synthetic.regime;
    if (markets.length === 0) return "NO DATA";
    const up = markets.filter((market) => finite(market.changePct, 0) > 0).length;
    const share = up / markets.length;
    if (share >= 0.62) return "RISK-ON";
    if (share >= 0.45) return "NEUTRAL";
    if (share >= 0.3) return "CHOP";
    return "RISK-OFF";
  }

  function compactMarket(market) {
    return {
      mint: market.mint,
      shortMint: `${market.mint.slice(0, 4)}…${market.mint.slice(-4)}`,
      symbol: market.symbol,
      name: market.name,
      price: roundPrice(market.price),
      changePct: round(market.changePct, 3),
      liquidity: round(market.liquidity, 2),
      liquidityChange: round(market.liquidityChange, 2),
      mcap: round(market.mcap, 2),
      fdv: round(market.fdv, 2),
      volume5m: round(market.volume5m, 2),
      buySellRatio: round(finite(market.buySellRatio, 0), 3),
      organicBuySellRatio: round(finite(market.organicBuySellRatio, 0), 3),
      organicScore: round(market.organicScore, 2),
      organicScoreLabel: market.organicScoreLabel,
      holderCount: market.holderCount === null ? null : Math.round(finite(market.holderCount, 0)),
      topHoldersPercentage: round(market.topHoldersPercentage, 3),
      poolAgeMs: market.poolAgeMs === null ? null : Math.round(finite(market.poolAgeMs, 0)),
      numTraders: market.numTraders === null ? null : Math.round(finite(market.numTraders, 0)),
      numBuys: market.numBuys === null ? null : Math.round(finite(market.numBuys, 0)),
      numSells: market.numSells === null ? null : Math.round(finite(market.numSells, 0)),
      numOrganicBuyers:
        market.numOrganicBuyers === null ? null : Math.round(finite(market.numOrganicBuyers, 0)),
      numNetBuyers: market.numNetBuyers === null ? null : Math.round(finite(market.numNetBuyers, 0)),
      organicBuyers: market.numOrganicBuyers === null ? null : Math.round(finite(market.numOrganicBuyers, 0)),
      verified: market.verified === true,
      mintAuthorityDisabled: market.mintAuthorityDisabled === true,
      freezeAuthorityDisabled: market.freezeAuthorityDisabled === true,
      synthetic: market.synthetic === true,
      fresh: market.fresh === true,
      ageMs: Math.round(finite(market.ageMs, 0)),
      observedAt: market.lastObservedAt ?? null,
      source: market.source,
      endpoint: market.endpoint ?? null,
    };
  }

  function snapshot() {
    const at = now();
    const markets = feed.markets(at);
    const health = feed.health(at);

    for (const agent of population) {
      markToMarket(agent, {
        at,
        byMint: new Map(markets.map((market) => [market.mint, market])),
      });
      agent.fitness = fitness(agent);
    }

    const ranked = [...population].sort((a, b) => b.fitness - a.fitness);
    const totalEquity = population.reduce((sum, agent) => sum + agent.equity, 0);
    const totalCash = population.reduce((sum, agent) => sum + agent.cash, 0);
    const totalCosts = population.reduce((sum, agent) => sum + agent.costs, 0);
    const totalNet = totalEquity - populationSize * startingCash;
    const holding = population.filter((agent) => agent.position).length;
    const paused = population.filter((agent) => agent.status === STATUS.PAUSED).length;
    const trades = population.reduce((sum, agent) => sum + agent.trades, 0);
    const avgReturn = populationSize ? totalEquity / (populationSize * startingCash) - 1 : 0;
    const netPnl = totalNet;

    const species = SPECIES.map((name) => {
      const members = population.filter((agent) => agent.species === name);
      const avg =
        members.length === 0
          ? 0
          : members.reduce((sum, agent) => sum + (agent.equity - startingCash) / startingCash, 0) /
            members.length;
      const avgFitness =
        members.length === 0
          ? 0
          : members.reduce((sum, agent) => sum + agent.fitness, 0) / members.length;
      const stats = speciesStats.get(name) ?? {
        births: 0,
        deaths: 0,
        peakCount: 0,
        extinctionEvents: 0,
      };
      const returns = members
        .map((agent) => (agent.equity - startingCash) / startingCash)
        .sort((a, b) => a - b);

      return {
        name,
        role: SPECIES_ROLES[name] ?? "",
        count: members.length,
        avgReturn: averageReturnSafe(avg),
        medianReturn: returns.length > 0 ? averageReturnSafe(returns[Math.floor(returns.length / 2)]) : 0,
        avgFitness: averageReturnSafe(avgFitness),
        trades: members.reduce((sum, agent) => sum + agent.trades, 0),
        births: stats.births,
        deaths: stats.deaths,
        peakCount: stats.peakCount,
        extinctionEvents: stats.extinctionEvents,
        extinct: members.length === 0,
      };
    }).sort((a, b) => b.count - a.count || b.avgReturn - a.avgReturn);

    // Phase 5A: strategy islands. An island IS a species label used as a
    // breeding boundary (see engine/islands.mjs) — this reuses the same
    // per-species membership as `species` above but reports the numbers that
    // actually describe island *behavior* (target, migration, revival,
    // evidence sufficiency) rather than just a dashboard grouping.
    const currentIslandTargets = islandTargets();
    const islands = islandNames
      .map((name) => {
        const members = population.filter((agent) => agent.species === name);
        const stats = speciesStats.get(name) ?? {
          births: 0,
          deaths: 0,
          migrationsIn: 0,
          migrationsOut: 0,
          revivals: 0,
          extinctionEvents: 0,
        };
        const avgReturn =
          members.length === 0
            ? 0
            : members.reduce((sum, agent) => sum + (agent.equity - startingCash) / startingCash, 0) /
              members.length;
        const avgFitness =
          members.length === 0 ? 0 : members.reduce((sum, agent) => sum + agent.fitness, 0) / members.length;
        const fitnessValues = members.map((agent) => finite(agent.fitness, 0)).sort((a, b) => a - b);
        const medianFitness =
          fitnessValues.length === 0 ? 0 : fitnessValues[Math.floor(fitnessValues.length / 2)];
        const sufficientCount = members.filter((agent) => hasSufficientEvidence(agent, evidenceOptions)).length;
        const populationShare = populationSize > 0 ? members.length / populationSize : 0;
        return {
          name,
          // `target` is the *initialization / base* split (what an even or
          // explicitly-configured start looks like), never a hard quota.
          target: currentIslandTargets[name] ?? 0,
          // `softTarget` is this generation's evidence-adjusted, inertia-bounded
          // aim, clamped into [floor, cap].
          softTarget: Math.round(finite(lastIslandTargets?.[name], currentIslandTargets[name] ?? 0)),
          reproductiveWeight: Number.isFinite(lastIslandWeights?.[name])
            ? round(lastIslandWeights[name], 4)
            : 1,
          floor: islandFloor,
          cap: islandCap,
          population: members.length,
          share: round(populationShare, 6),
          births: stats.births,
          deaths: stats.deaths,
          migrationsIn: stats.migrationsIn,
          migrationsOut: stats.migrationsOut,
          revivals: stats.revivals,
          extinctionEvents: stats.extinctionEvents,
          avgReturn: averageReturnSafe(avgReturn),
          paperReturn: averageReturnSafe(avgReturn),
          avgFitness: averageReturnSafe(avgFitness),
          meanFitness: averageReturnSafe(avgFitness),
          medianFitness: averageReturnSafe(medianFitness),
          trades: members.reduce((sum, agent) => sum + agent.trades, 0),
          evidenceSufficientCount: sufficientCount,
          evidenceShare: members.length > 0 ? round(sufficientCount / members.length, 6) : 0,
          overCap: members.length > islandCap,
          extinct: members.length === 0,
        };
      })
      .sort((a, b) => b.population - a.population || a.name.localeCompare(b.name));

    history.push({
      t: at,
      generation,
      tick: generationTick,
      avgReturn: round(avgReturn * 100, 3),
      netPnl: round(netPnl, 2),
    });
    history = history.slice(-maxHistory);

    const upShare =
      markets.length > 0
        ? markets.filter((market) => finite(market.changePct, 0) > 0).length / markets.length
        : 0;

    const positions = population
      .filter((agent) => agent.position)
      .sort((a, b) => (b.unrealizedPnl ?? 0) - (a.unrealizedPnl ?? 0))
      .slice(0, maxPositions)
      .map((agent) => {
        const position = agent.position;
        const mark = finite(position.markPrice, position.entryRefPrice);
        const unrealizedPct =
          position.entryRefPrice > 0 ? mark / position.entryRefPrice - 1 : 0;
        return {
          agentId: agent.id,
          species: agent.species,
          symbol: position.symbol,
          mint: position.mint,
          shortMint: `${position.mint.slice(0, 4)}…${position.mint.slice(-4)}`,
          qty: round(position.qty, 6),
          cost: round(position.cost, 2),
          value: round(position.qty * mark, 2),
          entryPrice: roundPrice(position.entryPrice),
          markPrice: roundPrice(mark),
          unrealizedPnl: round(agent.unrealizedPnl ?? 0, 2),
          unrealizedPct: round(unrealizedPct * 100, 2),
          heldTicks: position.held,
          openedAt: new Date(position.entryAt ?? at).toISOString(),
          paper: true,
        };
      });

    return {
      updatedAt: new Date(at).toISOString(),
      mode: "PAPER",
      modeLabel: "PAPER ONLY",
      paperOnly: PAPER_ONLY,
      guards: paperGuards(),
      marketFeed: health,
      paper: {
        startingCash,
        baseFeeBps: config.paper.baseFeeBps,
        minSlippageBps: config.paper.minSlippageBps,
        adverseBufferBps: config.paper.adverseBufferBps,
        slippageCapBps: config.paper.slippageCapBps,
        maxLiquidityFraction: config.paper.maxLiquidityFraction,
        grossPnl: round(totalNet + totalCosts, 2),
        netPnl: round(netPnl, 2),
        costs: round(totalCosts, 2),
        costDragBps: round((totalCosts / Math.max(1, populationSize * startingCash)) * 10_000, 2),
        totalEquity: round(totalEquity, 2),
        note: "Simulated fills only. No wallet, no keys, no on-chain execution.",
      },
      generation,
      tick: generationTick,
      generationTicks,
      marketRegime: regime(markets),
      // Phase 5A: the Arena-vocabulary regime label (REGIMES in
      // arena/orchestrator.mjs — "broad-selloff", "liquidity-expansion", etc.),
      // distinct from the coarse `marketRegime` label above. This is what the
      // research evidence packet and any research candidate's abstention
      // decision actually key off; `null` until enough ticks have
      // accumulated to classify anything.
      researchRegime: currentRegimeLabel,
      marketBreadth: round(upShare * 100, 2),
      stats: {
        population: populationSize,
        alive: population.length,
        holding,
        scanning: population.length - holding - paused,
        paused,
        bornTotal,
        terminatedTotal,
        trades,
        totalEquity: round(totalEquity, 2),
        totalCash: round(totalCash, 2),
        startingCash,
        avgReturn: averageReturnSafe(avgReturn),
        netPnl: round(netPnl, 2),
        bestFitness: round(ranked[0]?.fitness ?? 0, 3),
        bestReturn: ranked[0]
          ? averageReturnSafe((ranked[0].equity - startingCash) / startingCash)
          : 0,
        // Alias of `population` above, named for the dashboard's "current vs
        // target" population readout (Phase 5A: EVOLVE_POPULATION_SIZE).
        populationTarget: populationSize,
      },
      evolution: {
        enabled: evolutionEnabled,
        frozen: !evolutionEnabled,
        generationTicks,
        mutationScale,
        crossoverRate,
        immigrantRate,
        eliteFraction,
        breederFraction,
        survivorFraction,
        minTradesForSelection,
        minObservationsForSelection,
        marketScanLimit: scanLimit,
        trackTrades: recordTrades,
      },
      genealogy: ancestry.stats({ alive: population.map((agent) => agent.id) }),
      topAgents: ranked.slice(0, 18).map((agent) => ({
        id: agent.id,
        label: agent.label ?? null,
        species: agent.species,
        parents: agent.parents,
        origin: agent.origin ?? null,
        lineageId: agent.lineageId ?? null,
        ancestryDepth: ancestry.ancestryDepth(agent.id),
        born: agent.born,
        age: generation - agent.born,
        equity: round(agent.equity, 2),
        returnPct: round(((agent.equity - startingCash) / startingCash) * 100, 3),
        netPnl: round(agent.netPnl ?? 0, 2),
        grossPnl: round(agent.grossPnl ?? 0, 2),
        costs: round(agent.costs, 2),
        fitness: round(agent.fitness, 3),
        trades: agent.trades,
        winRate: agent.trades ? agent.wins / agent.trades : 0,
        // Cumulative stage evidence: what the agent did across every generation
        // it lived through, not just its final partial one.
        stage: {
          trades: agent.stageTrades ?? 0,
          wins: agent.stageWins ?? 0,
          costs: round(agent.stageCosts ?? 0, 2),
          netPnl: round(agent.stagePnl ?? 0, 2),
          exposureTicks: agent.stageExposureTicks ?? 0,
          observations: agent.stageObservations ?? 0,
        },
        maxDrawdown: agent.maxDrawdown,
        status: agent.status,
        lastAction: agent.lastAction,
        position: agent.position
          ? {
              symbol: agent.position.symbol,
              mint: agent.position.mint,
              qty: round(agent.position.qty, 6),
              entryPrice: roundPrice(agent.position.entryPrice),
              markPrice: roundPrice(agent.position.markPrice),
              heldTicks: agent.position.held,
            }
          : null,
        genome: genomeSummary(agent.genome),
        // Phase 5A: present only for research-compiled candidates.
        research: agent.researchMeta
          ? {
              familyId: agent.researchMeta.familyId,
              proposalId: agent.researchMeta.proposalId,
              authorRole: agent.researchMeta.authorRole,
              targetRegimes: [...(agent.targetRegimes ?? [])],
              abstainRegimes: [...(agent.abstainRegimes ?? [])],
              posture: agent.researchPosture ?? ABSTAIN_STATE.ACTIVE,
            }
          : null,
      })),
      positions,
      species,
      islands,
      markets: markets.slice(0, maxStateMarkets).map(compactMarket),
      marketSummary: {
        observed: markets.length,
        tradeable: markets.filter(
          (market) => market.fresh === true && market.price > 0 && market.liquidity > 0,
        ).length,
        shown: Math.min(markets.length, maxStateMarkets),
        source: health.source,
      },
      history,
      events,
      recentTrades,
      lastGenerationSummary,
      universe: health.universe,
      runtime: {
        uptimeMs: Math.max(0, at - startedAt),
        startedAt: new Date(startedAt).toISOString(),
        paperStartingCash: startingCash,
        speciesCount: SPECIES.length,
        totalTrades,
        frozen: !evolutionEnabled,
      },
    };
  }

  seedPopulation();

  return {
    advanceTick,
    snapshot,
    settle,
    breedGeneration,
    addEvent,
    genealogy: ancestry,
    evolutionOptions: Object.freeze({ ...evolutionOptions, enabled: evolutionEnabled }),
    frozen: !evolutionEnabled,
    config,
    get population() {
      return population;
    },
    get generation() {
      return generation;
    },
    get generationTick() {
      return generationTick;
    },
    addEventPublic: addEvent,
    stats: () => ({ totalTrades }),
    speciesRoles: SPECIES_ROLES,
    // Phase 5A: research-swarm integration surface. Islands need no new
    // methods — they are visible through snapshot().islands — but injection
    // and evidence collection are driven from outside this module (the async
    // research cycle in evolve-engine.mjs), so they are exposed here.
    injectResearchCandidate,
    getResearchEvidence,
    clearResearchEvidence,
    islandNames: Object.freeze([...islandNames]),
  };
}
