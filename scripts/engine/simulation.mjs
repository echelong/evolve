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
import { PAPER_ONLY, paperGuards, simulateEntry, simulateExit } from "./paper.mjs";

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
export function passesGates(genome, market, { minLiquidityUsd = 0 } = {}) {
  const f = market?.features;
  if (!f) return false;
  if (market.fresh !== true) return false;
  if (!(finite(market.price, 0) > 0)) return false;
  if (!(finite(market.liquidity, -1) > 0)) return false;
  if (market.liquidity < minLiquidityUsd) return false;

  if (finite(f.liquidityQuality, 0) < genome.minLiquidityQuality) return false;
  if (finite(f.organicScore, 0) < genome.minOrganicScore) return false;

  if (genome.requireConcentrationKnown === 1 && market.topHoldersPercentage === null) return false;
  if (market.topHoldersPercentage !== null && market.topHoldersPercentage > genome.maxTopHolderPct) {
    return false;
  }

  if (genome.requireAuthoritySafe === 1) {
    if (market.mintAuthorityDisabled !== true || market.freezeAuthorityDisabled !== true) return false;
  }
  if (genome.requireVerified === 1 && market.verified !== true) return false;

  if (market.poolAgeMs === null) {
    const ageAware =
      genome.minPoolAgeHours > 0 ||
      genome.maxPoolAgeHours < MAX_POOL_AGE_UNBOUNDED ||
      genome.ageWeight >= 0.15;
    if (ageAware) return false;
  } else {
    const ageHours = market.poolAgeMs / 3_600_000;
    if (ageHours < genome.minPoolAgeHours) return false;
    if (ageHours > genome.maxPoolAgeHours) return false;
  }

  if (finite(f.buyPressure, 0) < genome.buyPressureThreshold) return false;

  if (genome.momentumGateEnabled === 1) {
    const momentumSignal = genome.contrarian === 1 ? -f.momentum : f.momentum;
    if (finite(momentumSignal, 0) < genome.momentumThreshold) return false;
  }

  return true;
}

/**
 * Create the runnable simulation.
 * @param {{ config: object, feed: object, now?: () => number, random?: () => number }} options
 */
export function createSimulation({ config, feed, now = () => Date.now(), random = Math.random } = {}) {
  const { population: populationSize, generationTicks } = config.engine;
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

  function addEvent(type, message) {
    events.unshift({ id: generateAgentId("E"), at: new Date(now()).toISOString(), type, message });
    events = events.slice(0, maxEvents);
  }

  function makeAgent({ genome, species, parents = [], born = generation } = {}) {
    const resolvedSpecies = species ?? SPECIES[Math.floor(random() * SPECIES.length)];
    return {
      id: generateAgentId("A"),
      species: resolvedSpecies,
      parents,
      born,
      age: generation - born,
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
    population = Array.from({ length: populationSize }, () => makeAgent({}));
    population.forEach((agent, index) => {
      agent.species = SPECIES[index % SPECIES.length];
      agent.genome = randomGenome(agent.species, random);
    });
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
      markToMarket(agent, ctx);
      return false;
    }

    agent.cash += fill.netProceeds;
    agent.realizedPnl += fill.netProceeds - position.cost;
    agent.costs += Math.max(0, fill.frictionUsd);
    agent.trades += 1;
    totalTrades += 1;
    if (fill.netProceeds - position.cost >= 0) agent.wins += 1;
    else agent.losses += 1;

    const net = fill.netProceeds - position.cost;
    agent.lastAction = `${reason} ${position.symbol} ${net >= 0 ? "+" : "-"}$${Math.abs(net).toFixed(2)}`;
    agent.lastActionAt = ctx.at;
    // Flat agents are only 'scanning' when the feed currently allows entries.
    agent.status = ctx.allowNewEntries ? STATUS.SCANNING : STATUS.PAUSED;
    agent.position = null;

    recentTrades.unshift({
      id: generateAgentId("T"),
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
    const notional = Math.min(
      agent.cash * genome.riskFraction,
      agent.cash * config.paper.maxPositionFraction,
      market.liquidity * config.paper.maxLiquidityFraction,
    );

    if (!Number.isFinite(notional) || notional < minOrderUsd) {
      agent.lastAction = `Size too small for ${market.symbol}`;
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
      return false;
    }

    agent.cash -= fill.cashSpent;
    agent.costs += fill.frictionUsd;
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
      agent.lastAction = "Entries paused — market feed degraded";
      markToMarket(agent, ctx);
      return;
    }

    let best = null;
    let bestScore = -Infinity;

    for (const market of ctx.tradeable) {
      if (!passesGates(agent.genome, market, ctx)) continue;
      const score = scoreMarket(agent.genome, market);
      if (score > bestScore) {
        bestScore = score;
        best = market;
      }
    }

    agent.status = STATUS.SCANNING;

    if (!best || bestScore < agent.genome.entryScoreThreshold) {
      agent.lastAction = best
        ? `Scanning ${best.symbol} ${bestScore.toFixed(2)} < ${agent.genome.entryScoreThreshold.toFixed(2)}`
        : "Scanning — no eligible token";
      markToMarket(agent, ctx);
      return;
    }

    ctx.bestScore = bestScore;
    if (!openPosition(agent, best, ctx)) {
      ctx.bestScore = null;
    }
    markToMarket(agent, ctx);
  }

  /** Fitness is NET: equity already includes simulated fees and slippage. */
  function fitness(agent) {
    return computeFitness(agent, startingCash);
  }

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

  function breedGeneration(explicitCtx = null) {
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

    population.sort((a, b) => b.fitness - a.fitness);
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

    const eliteCount = Math.max(6, Math.floor(populationSize * 0.1));
    const breederCount = Math.max(18, Math.floor(populationSize * 0.28));
    const immigrantCount = Math.max(8, Math.floor(populationSize * 0.1));
    const elites = population.slice(0, eliteCount);
    const breeders = population.slice(0, breederCount);
    const deaths = populationSize - eliteCount;

    addEvent(
      "GENERATION",
      `Generation ${generation} ended. ${best.id} led at ${(averageReturnSafe(lastGenerationSummary.bestReturn) * 100).toFixed(1)}% net paper return.`,
    );
    addEvent("DEATH", `${deaths} weak agents terminated by selection.`);

    const next = elites.map(resetSurvivor);

    while (next.length < populationSize - immigrantCount) {
      const a = breeders[Math.floor(random() * breeders.length)];
      const b = breeders[Math.floor(random() * breeders.length)];
      const childSpecies = random() < 0.72 ? a.species : b.species;
      const genome =
        random() < 0.48
          ? crossoverGenomes(a.genome, b.genome, { random, species: childSpecies })
          : mutateGenome(a.genome, { scale: 0.07, random, species: childSpecies });

      next.push(
        makeAgent({
          genome,
          species: childSpecies,
          parents: a.id === b.id ? [a.id] : [a.id, b.id],
          born: generation + 1,
        }),
      );
    }

    while (next.length < populationSize) {
      const species = SPECIES[Math.floor(random() * SPECIES.length)];
      next.push(
        makeAgent({
          genome: randomGenome(species, random),
          species,
          parents: [],
          born: generation + 1,
        }),
      );
    }

    terminatedTotal += deaths;
    bornTotal += populationSize - eliteCount;
    generation += 1;
    generationTick = 0;
    population = next;
    addEvent("BIRTH", `${populationSize - eliteCount} new agents entered generation ${generation}.`);
  }

  function averageReturnSafe(value) {
    return Number.isFinite(value) ? value : 0;
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

    const ctx = {
      at,
      markets,
      byMint,
      tradeable,
      allowNewEntries: health.allowNewEntries === true && tradeable.length > 0,
      minLiquidityUsd: config.minLiquidityUsd,
      friction: config.paper,
      bestScore: null,
    };

    for (const agent of population) {
      ctx.bestScore = null;
      stepAgent(agent, ctx);
    }

    generationTick += 1;
    if (generationTick >= generationTicks) breedGeneration(ctx);

    return { at, health, marketCount: markets.length, tradeable: tradeable.length };
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
      return {
        name,
        role: SPECIES_ROLES[name] ?? "",
        count: members.length,
        avgReturn: averageReturnSafe(avg),
        avgFitness: averageReturnSafe(avgFitness),
        trades: members.reduce((sum, agent) => sum + agent.trades, 0),
      };
    }).sort((a, b) => b.count - a.count || b.avgReturn - a.avgReturn);

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
      },
      topAgents: ranked.slice(0, 18).map((agent) => ({
        id: agent.id,
        species: agent.species,
        parents: agent.parents,
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
      })),
      positions,
      species,
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
      },
    };
  }

  seedPopulation();

  return {
    advanceTick,
    snapshot,
    breedGeneration,
    addEvent,
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
  };
}
