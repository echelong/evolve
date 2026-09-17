import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const STATE_DIR = ".evolve";
const STATE_FILE = `${STATE_DIR}/state.json`;
const POPULATION = 96;
const STARTING_BALANCE = 1000;
const GENERATION_TICKS = 180;
const TICK_MS = 900;
const FEE_RATE = 0.0035;

const SPECIES = [
  "Genesis Hunter",
  "Momentum",
  "Reversal",
  "Wallet Flow",
  "Liquidity",
  "Experimental",
];

const TOKENS = [
  ["BONK", 0.000024, 5_800_000],
  ["WIF", 1.82, 8_100_000],
  ["POPCAT", 0.48, 2_900_000],
  ["MEW", 0.0041, 1_900_000],
  ["GOAT", 0.19, 1_550_000],
  ["PONKE", 0.082, 1_150_000],
  ["GIGA", 0.021, 980_000],
  ["MICHI", 0.13, 810_000],
];

let generation = 1;
let tick = 0;
let bornTotal = POPULATION;
let terminatedTotal = 0;
let marketRegime = "NEUTRAL";
let history = [];
let events = [];
let population = [];
let lastGenerationSummary = null;

const markets = TOKENS.map(([symbol, price, liquidity]) => ({
  symbol,
  price,
  prevPrice: price,
  liquidity,
  volume: liquidity * 0.08,
  momentum: 0,
  buyPressure: 0.5,
  uniqueBuyers: Math.round(80 + Math.random() * 400),
  volatility: 0.02,
}));

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const gaussian = () => {
  let u = 0;
  let v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const mutate = (value, scale, min, max) =>
  clamp(value * (1 + gaussian() * scale), min, max);

function randomGenome(species = pick(SPECIES)) {
  const bias = {
    "Genesis Hunter": [0.006, 0.55, 0.56, 0.16],
    Momentum: [0.012, 0.62, 0.58, 0.12],
    Reversal: [-0.008, 0.48, 0.46, 0.10],
    "Wallet Flow": [0.004, 0.56, 0.66, 0.11],
    Liquidity: [0.003, 0.70, 0.54, 0.08],
    Experimental: [0.0, 0.50, 0.50, 0.14],
  }[species];

  return {
    momentumThreshold: bias[0] + gaussian() * 0.01,
    volumeThreshold: clamp(bias[1] + gaussian() * 0.12, 0.2, 0.95),
    buyPressureThreshold: clamp(bias[2] + gaussian() * 0.10, 0.35, 0.90),
    stopLoss: clamp(0.035 + Math.random() * 0.11, 0.02, 0.18),
    takeProfit: clamp(0.06 + Math.random() * 0.28, 0.04, 0.42),
    maxHold: Math.round(8 + Math.random() * 52),
    riskFraction: clamp(bias[3] + Math.random() * 0.12, 0.04, 0.28),
    momentumWeight: clamp(0.4 + gaussian() * 0.15, 0.1, 0.8),
    volumeWeight: clamp(0.25 + gaussian() * 0.10, 0.05, 0.6),
    flowWeight: clamp(0.25 + gaussian() * 0.10, 0.05, 0.6),
    contrarian: species === "Reversal" ? 1 : 0,
  };
}

function makeAgent({ genome, species, parents = [], born = generation, id } = {}) {
  return {
    id: id ?? `A-${randomUUID().slice(0, 6).toUpperCase()}`,
    species: species ?? pick(SPECIES),
    parents,
    born,
    age: generation - born,
    genome: genome ?? randomGenome(species),
    cash: STARTING_BALANCE,
    equity: STARTING_BALANCE,
    maxEquity: STARTING_BALANCE,
    maxDrawdown: 0,
    realizedPnl: 0,
    trades: 0,
    wins: 0,
    losses: 0,
    fitness: 0,
    status: "SCANNING",
    position: null,
    lastAction: "Spawned",
  };
}

function seedPopulation() {
  population = Array.from({ length: POPULATION }, () => makeAgent());
}

function addEvent(type, message) {
  events.unshift({
    id: randomUUID(),
    at: new Date().toISOString(),
    type,
    message,
  });
  events = events.slice(0, 18);
}

function evolveMarket() {
  if (tick % 45 === 0) {
    marketRegime = pick(["RISK-ON", "NEUTRAL", "CHOP", "RISK-OFF"]);
  }

  const regimeDrift = {
    "RISK-ON": 0.0025,
    NEUTRAL: 0.0002,
    CHOP: -0.0001,
    "RISK-OFF": -0.0022,
  }[marketRegime];

  for (const m of markets) {
    m.prevPrice = m.price;
    const shock = gaussian() * m.volatility;
    const burst = Math.random() < 0.035 ? gaussian() * 0.09 : 0;
    const returnPct = clamp(regimeDrift + shock + burst, -0.18, 0.24);
    m.price = Math.max(0.0000001, m.price * (1 + returnPct));
    m.momentum = returnPct;
    m.buyPressure = clamp(
      0.5 + returnPct * 3.2 + gaussian() * 0.09,
      0.05,
      0.95,
    );
    m.volume = Math.max(
      m.liquidity * 0.01,
      m.volume * (0.82 + Math.random() * 0.38) * (1 + Math.abs(returnPct) * 4),
    );
    m.uniqueBuyers = Math.max(
      5,
      Math.round(m.uniqueBuyers * (0.88 + Math.random() * 0.26)),
    );
    m.liquidity = Math.max(
      120_000,
      m.liquidity * (1 + gaussian() * 0.008 + returnPct * 0.035),
    );
    m.volatility = clamp(
      m.volatility * 0.96 + Math.abs(returnPct) * 0.10,
      0.008,
      0.08,
    );
  }
}

function marketScore(agent, market) {
  const g = agent.genome;
  const normalizedVolume = clamp(market.volume / market.liquidity, 0, 1);
  const momentumSignal =
    g.contrarian === 1 ? -market.momentum : market.momentum;

  return (
    momentumSignal * 10 * g.momentumWeight +
    normalizedVolume * g.volumeWeight +
    market.buyPressure * g.flowWeight
  );
}

function closePosition(agent, reason) {
  const p = agent.position;
  if (!p) return;

  const market = markets.find((m) => m.symbol === p.symbol);
  if (!market) return;

  const gross = p.qty * market.price;
  const proceeds = gross * (1 - FEE_RATE);
  const pnl = proceeds - p.cost;
  agent.cash += proceeds;
  agent.realizedPnl += pnl;
  agent.trades += 1;
  if (pnl >= 0) agent.wins += 1;
  else agent.losses += 1;
  agent.lastAction = `${reason} ${p.symbol} ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`;
  agent.status = "SCANNING";
  agent.position = null;
}

function stepAgent(agent) {
  if (agent.position) {
    const p = agent.position;
    const market = markets.find((m) => m.symbol === p.symbol);
    p.held += 1;

    const move = market.price / p.entry - 1;
    if (move <= -agent.genome.stopLoss) closePosition(agent, "STOP");
    else if (move >= agent.genome.takeProfit) closePosition(agent, "TAKE");
    else if (p.held >= agent.genome.maxHold) closePosition(agent, "TIME");
    else {
      agent.status = "HOLDING";
      agent.lastAction = `Holding ${p.symbol} ${move >= 0 ? "+" : ""}${(move * 100).toFixed(1)}%`;
    }
  }

  if (!agent.position) {
    const ranked = markets
      .map((m) => ({ market: m, score: marketScore(agent, m) }))
      .sort((a, b) => b.score - a.score);

    const best = ranked[0];
    const g = agent.genome;
    const volumeRatio = best.market.volume / best.market.liquidity;
    const momentumOK =
      g.contrarian === 1
        ? best.market.momentum <= g.momentumThreshold
        : best.market.momentum >= g.momentumThreshold;

    if (
      momentumOK &&
      volumeRatio >= g.volumeThreshold * 0.1 &&
      best.market.buyPressure >= g.buyPressureThreshold &&
      best.score > 0.12
    ) {
      const spend = Math.min(agent.cash * g.riskFraction, agent.cash * 0.28);
      if (spend > 12) {
        const netSpend = spend * (1 - FEE_RATE);
        agent.cash -= spend;
        agent.position = {
          symbol: best.market.symbol,
          qty: netSpend / best.market.price,
          entry: best.market.price,
          cost: spend,
          held: 0,
        };
        agent.status = "HOLDING";
        agent.lastAction = `BUY ${best.market.symbol} $${spend.toFixed(0)}`;
      }
    } else {
      agent.status = "SCANNING";
      agent.lastAction = `Scanning ${best.market.symbol}`;
    }
  }

  const positionValue = agent.position
    ? agent.position.qty *
      markets.find((m) => m.symbol === agent.position.symbol).price
    : 0;

  agent.equity = agent.cash + positionValue;
  agent.maxEquity = Math.max(agent.maxEquity, agent.equity);
  const dd = agent.maxEquity
    ? (agent.maxEquity - agent.equity) / agent.maxEquity
    : 0;
  agent.maxDrawdown = Math.max(agent.maxDrawdown, dd);
}

function fitness(agent) {
  const ret = (agent.equity - STARTING_BALANCE) / STARTING_BALANCE;
  const winRate = agent.trades ? agent.wins / agent.trades : 0;
  const activity = Math.min(agent.trades / 12, 1);
  return ret * 100 - agent.maxDrawdown * 45 + winRate * 8 + activity * 2;
}

function mutateGenome(parent) {
  const g = parent.genome;
  return {
    momentumThreshold: clamp(
      g.momentumThreshold + gaussian() * 0.004,
      -0.04,
      0.07,
    ),
    volumeThreshold: mutate(g.volumeThreshold, 0.12, 0.15, 0.98),
    buyPressureThreshold: mutate(g.buyPressureThreshold, 0.08, 0.30, 0.94),
    stopLoss: mutate(g.stopLoss, 0.12, 0.015, 0.22),
    takeProfit: mutate(g.takeProfit, 0.14, 0.03, 0.55),
    maxHold: Math.round(mutate(g.maxHold, 0.18, 4, 90)),
    riskFraction: mutate(g.riskFraction, 0.11, 0.03, 0.30),
    momentumWeight: mutate(g.momentumWeight, 0.10, 0.05, 0.90),
    volumeWeight: mutate(g.volumeWeight, 0.12, 0.03, 0.75),
    flowWeight: mutate(g.flowWeight, 0.12, 0.03, 0.75),
    contrarian: Math.random() < 0.035 ? 1 - g.contrarian : g.contrarian,
  };
}

function crossover(a, b) {
  const genes = Object.keys(a.genome);
  const genome = {};
  for (const gene of genes) {
    genome[gene] = Math.random() < 0.5 ? a.genome[gene] : b.genome[gene];
  }
  return mutateGenome({ genome });
}

function resetSurvivor(agent) {
  return {
    ...agent,
    age: generation + 1 - agent.born,
    cash: STARTING_BALANCE,
    equity: STARTING_BALANCE,
    maxEquity: STARTING_BALANCE,
    maxDrawdown: 0,
    realizedPnl: 0,
    trades: 0,
    wins: 0,
    losses: 0,
    fitness: 0,
    status: "SCANNING",
    position: null,
    lastAction: "Elite survived",
  };
}

function breedGeneration() {
  for (const agent of population) {
    if (agent.position) closePosition(agent, "GEN-END");
    agent.fitness = fitness(agent);
  }

  population.sort((a, b) => b.fitness - a.fitness);
  const best = population[0];
  const averageReturn =
    population.reduce(
      (sum, a) => sum + (a.equity - STARTING_BALANCE) / STARTING_BALANCE,
      0,
    ) / population.length;

  lastGenerationSummary = {
    generation,
    bestId: best.id,
    bestSpecies: best.species,
    bestReturn: (best.equity - STARTING_BALANCE) / STARTING_BALANCE,
    averageReturn,
  };

  const eliteCount = Math.max(6, Math.floor(POPULATION * 0.1));
  const breederCount = Math.max(18, Math.floor(POPULATION * 0.28));
  const immigrantCount = Math.max(8, Math.floor(POPULATION * 0.1));
  const elites = population.slice(0, eliteCount);
  const breeders = population.slice(0, breederCount);
  const deaths = POPULATION - eliteCount;

  addEvent(
    "GENERATION",
    `Generation ${generation} ended. ${best.id} led at ${(lastGenerationSummary.bestReturn * 100).toFixed(1)}%.`,
  );
  addEvent("DEATH", `${deaths} weak agents terminated by selection.`);

  const next = elites.map(resetSurvivor);

  while (next.length < POPULATION - immigrantCount) {
    const a = pick(breeders);
    const b = pick(breeders);
    const genome = Math.random() < 0.48 ? crossover(a, b) : mutateGenome(a);
    const child = makeAgent({
      genome,
      species: Math.random() < 0.72 ? a.species : b.species,
      parents: a.id === b.id ? [a.id] : [a.id, b.id],
      born: generation + 1,
    });
    next.push(child);
  }

  while (next.length < POPULATION) {
    next.push(makeAgent({ born: generation + 1 }));
  }

  terminatedTotal += deaths;
  bornTotal += POPULATION - eliteCount;
  generation += 1;
  tick = 0;
  population = next;
  addEvent(
    "BIRTH",
    `${POPULATION - eliteCount} new agents entered generation ${generation}.`,
  );
}

function stateSnapshot() {
  for (const agent of population) {
    agent.fitness = fitness(agent);
  }

  const ranked = [...population].sort((a, b) => b.fitness - a.fitness);
  const totalEquity = population.reduce((sum, a) => sum + a.equity, 0);
  const avgReturn =
    totalEquity / (POPULATION * STARTING_BALANCE) - 1;
  const holding = population.filter((a) => a.position).length;

  const species = SPECIES.map((name) => {
    const members = population.filter((a) => a.species === name);
    const avg =
      members.length === 0
        ? 0
        : members.reduce(
            (s, a) => s + (a.equity - STARTING_BALANCE) / STARTING_BALANCE,
            0,
          ) / members.length;
    return { name, count: members.length, avgReturn: avg };
  }).sort((a, b) => b.count - a.count);

  history.push({
    t: Date.now(),
    generation,
    tick,
    avgReturn: Number((avgReturn * 100).toFixed(3)),
  });
  history = history.slice(-150);

  return {
    updatedAt: new Date().toISOString(),
    mode: "PAPER",
    generation,
    tick,
    generationTicks: GENERATION_TICKS,
    marketRegime,
    stats: {
      population: POPULATION,
      totalEquity,
      avgReturn,
      holding,
      scanning: POPULATION - holding,
      bornTotal,
      terminatedTotal,
      bestFitness: ranked[0]?.fitness ?? 0,
      bestReturn: ranked[0]
        ? (ranked[0].equity - STARTING_BALANCE) / STARTING_BALANCE
        : 0,
    },
    topAgents: ranked.slice(0, 18).map((a) => ({
      id: a.id,
      species: a.species,
      parents: a.parents,
      born: a.born,
      age: a.age,
      equity: a.equity,
      returnPct: ((a.equity - STARTING_BALANCE) / STARTING_BALANCE) * 100,
      fitness: a.fitness,
      trades: a.trades,
      winRate: a.trades ? a.wins / a.trades : 0,
      maxDrawdown: a.maxDrawdown,
      status: a.status,
      lastAction: a.lastAction,
      genome: a.genome,
    })),
    species,
    markets: [...markets]
      .sort((a, b) => Math.abs(b.momentum) - Math.abs(a.momentum))
      .map((m) => ({
        ...m,
        changePct: m.momentum * 100,
        volumeRatio: m.volume / m.liquidity,
      })),
    history,
    events,
    lastGenerationSummary,
  };
}

async function persist() {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(stateSnapshot()), "utf8");
}

async function main() {
  seedPopulation();
  addEvent("SYSTEM", `EVOLVE engine online with ${POPULATION} agents.`);
  addEvent("SYSTEM", "Paper mode enforced. No wallet or mainnet execution enabled.");
  await persist();

  setInterval(async () => {
    evolveMarket();
    for (const agent of population) stepAgent(agent);
    tick += 1;

    if (tick >= GENERATION_TICKS) breedGeneration();

    try {
      await persist();
    } catch (error) {
      console.error("[EVOLVE] state write failed:", error?.message ?? error);
    }
  }, TICK_MS);

  console.log(`[EVOLVE] Paper engine running: ${POPULATION} agents`);
  console.log("[EVOLVE] Dashboard state -> .evolve/state.json");
}

main().catch((error) => {
  console.error("[EVOLVE] fatal bootstrap error:", error);
  process.exitCode = 1;
});
