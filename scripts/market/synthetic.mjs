/**
 * Synthetic market provider.
 *
 * This is the Phase 1 simulator, preserved: eight recognizable paper tokens
 * plus generated ones, random-walking under a rotating market regime. The only
 * change is that it now emits the *same normalized token shape* the live
 * Jupiter provider does, so agent genomes, paper execution, fitness, and the
 * dashboard all share exactly one code path.
 *
 * Everything here is fake by construction and is always labelled synthetic.
 * Synthetic mode needs no network access and no API key.
 */

import { MARKET_SOURCE_SYNTHETIC } from "./normalize.mjs";

const REGIMES = ["RISK-ON", "NEUTRAL", "CHOP", "RISK-OFF"];

const REGIME_DRIFT = {
  "RISK-ON": 0.0026,
  NEUTRAL: 0.0002,
  CHOP: -0.0001,
  "RISK-OFF": -0.0023,
};

/** Phase 1's hunting ground, kept so the dashboard looks familiar. */
const SEED_TOKENS = [
  ["BONK", 0.000024, 5_800_000, 8.6],
  ["WIF", 1.82, 8_100_000, 21.4],
  ["POPCAT", 0.48, 2_900_000, 12.1],
  ["MEW", 0.0041, 1_900_000, 9.8],
  ["GOAT", 0.19, 1_550_000, 7.2],
  ["PONKE", 0.082, 1_150_000, 6.4],
  ["GIGA", 0.021, 980_000, 5.1],
  ["MICHI", 0.13, 810_000, 4.7],
];

function gaussian(random) {
  let u = 0;
  let v = 0;
  while (!u) u = random();
  while (!v) v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Deterministic pseudo-mint so a mint keeps its identity between restarts. */
export function syntheticMint(symbol, salt = 0) {
  const seed = `${symbol}:${salt}`;
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 0xffffffff;
  }
  const body = hash.toString(36).padStart(8, "0").toUpperCase();
  return `SYN${body}${"0".repeat(Math.max(0, 32 - 3 - body.length))}`;
}

export class SyntheticMarketProvider {
  /**
   * @param {{ tokenCount?: number, now?: () => number, random?: () => number,
   *           staleMs?: number, tickMs?: number }} [options]
   */
  constructor({ tokenCount = 24, now = () => Date.now(), random = Math.random, staleMs = 60_000, tickMs = 900 } = {}) {
    this.now = now;
    this.random = random;
    this.staleMs = staleMs;
    this.tickMs = Math.max(1, tickMs);
    this.regime = "NEUTRAL";
    this.stepCount = 0;
    this.lastStepAt = null;
    this.startedAt = now();

    const extra = Math.max(0, tokenCount - SEED_TOKENS.length);
    const seeds = [...SEED_TOKENS];

    // The synthetic hunting ground mixes mature pools with fresh launches so
    // that every species has prey: conservative genomes need deep, seasoned,
    // low-concentration tokens; launch genomes need young thin ones.
    for (let index = 0; index < extra; index += 1) {
      const blueChip = index % 2 === 0;
      const symbol = `${blueChip ? "MAJOR" : "DEGEN"}${String(index + 1).padStart(2, "0")}`;

      if (blueChip) {
        seeds.push([symbol, 0.35 + random() * 22, 2_600_000 + random() * 22_000_000, 40 + random() * 460]);
      } else {
        seeds.push([symbol, 0.00008 + random() * 0.4, 70_000 + random() * 850_000, 0.5 + random() * 11]);
      }
    }

    this.tokens = seeds.map(([symbol, price, liquidity, ageHours], index) => {
      const volatility = 0.008 + random() * 0.04;
      // Blue-chip shaped tokens: deep, seasoned, safe authorities, low
      // concentration. Identified by symbol prefix only.
      const blueChip = /^MAJOR\d+$/.test(symbol);
      const degen = /^DEGEN\d+$/.test(symbol);
      return {
        mint: syntheticMint(symbol, index),
        name: `${symbol} Paper Token`,
        symbol,
        icon: null,
        decimals: 6,
        synthetic: true,
        source: MARKET_SOURCE_SYNTHETIC,
        endpoint: "/synthetic/seed",
        price,
        prevPrice: price,
        liquidity,
        liquidityStart: liquidity,
        volume: liquidity * 0.08,
        volumePrev: liquidity * 0.08,
        buyPressure: 0.5,
        organicScore: blueChip ? 55 + random() * 42 : degen ? 4 + random() * 52 : 20 + random() * 70,
        holderCount: blueChip ? Math.round(9_000 + random() * 900_000) : Math.round(120 + random() * 9_000),
        holderChange: 0,
        holderStart: 0,
        topHoldersPercentage: blueChip ? clamp(2 + random() * 18, 0.5, 22) : clamp(4 + random() * 60, 0.5, 96),
        volatility: blueChip ? volatility * 0.4 : volatility,
        numBuys: 20 + Math.round(random() * 300),
        numSells: 20 + Math.round(random() * 300),
        numTraders: 40 + Math.round(random() * 420),
        numOrganicBuyers: 4 + Math.round(random() * 60),
        numNetBuyers: Math.round(gaussian(random) * 80),
        buyOrganicShare: clamp(0.3 + random() * 0.5, 0.05, 0.95),
        mintAuthorityDisabled: blueChip ? true : random() < 0.7,
        freezeAuthorityDisabled: blueChip ? true : random() < 0.6,
        isVerified: blueChip ? true : random() < 0.35,
        poolAgeHours: ageHours,
        profile: blueChip ? "mature" : degen ? "launch" : "mixed",
        momentum: 0,
        liquidityChange5m: 0,
        volumeChange5m: 0,
      };
    }).map((token) => {
      token.holderStart = token.holderCount;
      return token;
    });
  }

  /** Advance the simulated market by one tick. */
  step(at = this.now()) {
    if (this.lastStepAt !== null && at - this.lastStepAt < this.tickMs) return false;

    this.lastStepAt = at;
    this.stepCount += 1;

    if (this.stepCount % 45 === 1) {
      this.regime = REGIMES[Math.floor(this.random() * REGIMES.length)];
    }

    const drift = REGIME_DRIFT[this.regime] ?? 0;

    for (const token of this.tokens) {
      token.prevPrice = token.price;
      token.volumePrev = token.volume;

      const shock = gaussian(this.random) * token.volatility;
      const burst = this.random() < 0.035 ? gaussian(this.random) * 0.09 : 0;
      const returnPct = clamp(drift + shock + burst, -0.18, 0.24);

      token.price = Math.max(1e-9, token.price * (1 + returnPct));
      token.momentum = returnPct;
      token.buyPressure = clamp(0.5 + returnPct * 3.2 + gaussian(this.random) * 0.09, 0.03, 0.97);
      token.volume = Math.max(
        token.liquidity * 0.01,
        token.volume * (0.82 + this.random() * 0.38) * (1 + Math.abs(returnPct) * 4),
      );
      token.numTraders = Math.max(4, Math.round(token.numTraders * (0.9 + this.random() * 0.22)));
      token.numOrganicBuyers = Math.max(
        0,
        Math.round(token.numOrganicBuyers * (0.9 + this.random() * 0.24)),
      );
      token.numBuys = Math.max(1, Math.round(token.numBuys * (0.88 + this.random() * 0.3)));
      token.numSells = Math.max(1, Math.round(token.numSells * (0.88 + this.random() * 0.3)));
      token.numNetBuyers = Math.round(token.numBuys - token.numSells + gaussian(this.random) * 12);
      token.buyOrganicShare = clamp(
        0.5 + returnPct * 4 + gaussian(this.random) * 0.08,
        0.03,
        0.97,
      );

      const priorLiquidity = token.liquidity;
      token.liquidity = Math.max(
        90_000,
        token.liquidity * (1 + gaussian(this.random) * 0.008 + returnPct * 0.035),
      );
      token.liquidityChange5m = (token.liquidity / priorLiquidity - 1) * 100;
      token.volumeChange5m = (token.volume / Math.max(1, token.volumePrev) - 1) * 100;

      const holderDelta = Math.round(gaussian(this.random) * Math.max(2, token.holderCount * 0.002));
      token.holderCount = Math.max(10, token.holderCount + holderDelta);
      token.holderChange = (token.holderCount / Math.max(1, token.holderCount - holderDelta) - 1) * 100;
      token.topHoldersPercentage = clamp(
        token.topHoldersPercentage * (1 + gaussian(this.random) * 0.01),
        0.5,
        98,
      );

      token.volatility = clamp(
        token.volatility * 0.96 + Math.abs(returnPct) * 0.1,
        0.008,
        0.08,
      );
    }

    return true;
  }

  /** True when this provider has produced an observation recently. */
  isFresh(at = this.now()) {
    if (this.lastStepAt === null) return true;
    return at - this.lastStepAt <= this.staleMs;
  }

  /**
   * Normalized token observations, shaped exactly like the Jupiter ones so
   * `deriveFeatures` / `deriveMarket` treat both providers identically.
   */
  tokensAt(at = this.now()) {
    this.step(at);

    return this.tokens.map((token) => {
      const buyVolume = token.volume * token.buyPressure;
      const sellVolume = token.volume * (1 - token.buyPressure);

      return {
        mint: token.mint,
        source: MARKET_SOURCE_SYNTHETIC,
        synthetic: true,
        endpoint: "/synthetic/tick",
        name: token.name,
        symbol: token.symbol,
        icon: token.icon,
        decimals: token.decimals,
        firstPoolId: `SYN-POOL-${token.symbol}`,
        poolCreatedAt: this.startedAt - token.poolAgeHours * 3_600_000,
        holderCount: token.holderCount,
        mintAuthorityDisabled: token.mintAuthorityDisabled,
        freezeAuthorityDisabled: token.freezeAuthorityDisabled,
        authorityDataKnown: true,
        topHoldersPercentage: token.topHoldersPercentage,
        organicScore: token.organicScore,
        organicScoreLabel: token.organicScore >= 70 ? "high" : token.organicScore >= 40 ? "medium" : "low",
        isVerified: token.isVerified,
        tags: ["synthetic", token.profile],
        fdv: token.price * 1_000_000_000,
        mcap: token.price * 400_000_000,
        usdPrice: token.price,
        liquidity: token.liquidity,
        launchpad: "synthetic",
        tokenUpdatedAt: at,
        observedAt: at,
        firstSeenAt: this.startedAt,
        lastSeenAt: at,
        observationCount: this.stepCount,
        prevObservation: { usdPrice: token.prevPrice, liquidity: null, observedAt: this.lastStepAt - this.tickMs },
        stats5m: {
          priceChange: token.momentum * 100,
          liquidityChange: token.liquidityChange5m,
          volumeChange: token.volumeChange5m,
          holderChange: token.holderChange,
          buyVolume,
          sellVolume,
          buyOrganicVolume: buyVolume * token.buyOrganicShare,
          sellOrganicVolume: sellVolume * (1 - token.buyOrganicShare),
          numBuys: token.numBuys,
          numSells: token.numSells,
          numTraders: token.numTraders,
          numOrganicBuyers: token.numOrganicBuyers,
          numNetBuyers: token.numNetBuyers,
        },
      };
    });
  }

  summary(at = this.now()) {
    return {
      tokenCount: this.tokens.length,
      steps: this.stepCount,
      regime: this.regime,
      fresh: this.isFresh(at),
      lastStepAt: this.lastStepAt,
    };
  }
}
