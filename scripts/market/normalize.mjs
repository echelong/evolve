/**
 * Defensive normalization of Jupiter Tokens V2 payloads.
 *
 * Jupiter fields are frequently null, missing, or absent for brand new mints
 * (for example a token can have `stats5m.numBuys` but no `stats5m.priceChange`).
 * Nothing in the engine is allowed to touch a raw Jupiter payload: everything
 * goes through `normalizeJupiterToken` first.
 *
 * Unit notes verified against the live Tokens V2 API:
 *   - `stats5m.priceChange` / `volumeChange` / `liquidityChange` / `holderChange`
 *     are ALREADY percentages (SOL 5m priceChange 0.0112 means +0.0112%).
 *   - `audit.topHoldersPercentage` is on a 0-100 scale (SOL reports 0.58,
 *     which is 0.58% of supply, not 58%). Values are NOT rescaled.
 *   - `firstPool.createdAt` is the pool creation time, not the mint creation
 *     time. "Recent" therefore means "recently created first pool".
 */

export const MARKET_SOURCE_JUPITER = "Jupiter Tokens V2";
export const MARKET_SOURCE_SYNTHETIC = "Synthetic";

/**
 * A 5m move that saturates an agent's momentum feature.
 * Synthetic ticks are much smaller than 5m market moves, so each provider
 * supplies its own reference instead of pretending they are comparable.
 */
export const MOMENTUM_REFERENCE = Object.freeze({
  live: 0.15,
  synthetic: 0.02,
});

export const EMPTY_STATS_5M = Object.freeze({
  priceChange: null,
  liquidityChange: null,
  volumeChange: null,
  holderChange: null,
  buyVolume: null,
  sellVolume: null,
  buyOrganicVolume: null,
  sellOrganicVolume: null,
  numBuys: null,
  numSells: null,
  numTraders: null,
  numOrganicBuyers: null,
  numNetBuyers: null,
});

export function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function clamp01(value) {
  return clamp(value, 0, 1);
}

export function clampSigned(value) {
  return clamp(value, -1, 1);
}

/** Finite number or null. Numeric strings are accepted (holderCount arrives as either). */
export function toFiniteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function toFiniteInteger(value) {
  const parsed = toFiniteNumber(value);
  return parsed === null ? null : Math.round(parsed);
}

export function toText(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** ISO string or epoch (s/ms) to epoch milliseconds. */
export function timestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? Math.round(value) : Math.round(value * 1000);
  }
  const text = toText(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Divide-by-zero-safe ratio. Returns `fallback` when the denominator is unusable. */
export function safeRatio(numerator, denominator, fallback = null) {
  const n = toFiniteNumber(numerator);
  const d = toFiniteNumber(denominator);
  if (n === null || d === null || d === 0) return fallback;
  const ratio = n / d;
  return Number.isFinite(ratio) ? ratio : fallback;
}

/** Log-scaled 0..1 feature so that both micro caps and majors land in the unit range. */
function logScale(value, divisor, offset = 1) {
  const parsed = toFiniteNumber(value);
  if (parsed === null || parsed < 0) return 0;
  return clamp01(Math.log10(offset + parsed) / divisor);
}

function normalizeStats5m(stats) {
  const source = stats && typeof stats === "object" ? stats : {};
  const result = {};
  for (const key of Object.keys(EMPTY_STATS_5M)) {
    result[key] = toFiniteNumber(source[key]);
  }
  return result;
}

/**
 * Map a raw Jupiter Tokens V2 token into the internal MarketToken shape.
 * Returns null when the payload has no usable mint id.
 */
export function normalizeJupiterToken(raw, { at = Date.now(), endpoint = null } = {}) {
  if (!raw || typeof raw !== "object") return null;

  const mint = toText(raw.id);
  if (!mint) return null;

  const audit = raw.audit && typeof raw.audit === "object" ? raw.audit : {};
  const firstPool = raw.firstPool && typeof raw.firstPool === "object" ? raw.firstPool : {};
  const poolCreatedAt = timestampMs(firstPool.createdAt);
  const tags = Array.isArray(raw.tags) ? raw.tags.filter((tag) => typeof tag === "string") : [];

  const usdPrice = toFiniteNumber(raw.usdPrice);
  const liquidity = toFiniteNumber(raw.liquidity);

  return {
    mint,
    source: MARKET_SOURCE_JUPITER,
    synthetic: false,
    endpoint,
    name: toText(raw.name) ?? mint.slice(0, 6),
    symbol: toText(raw.symbol) ?? mint.slice(0, 4).toUpperCase(),
    icon: toText(raw.icon),
    decimals: toFiniteInteger(raw.decimals),
    firstPoolId: toText(firstPool.id),
    poolCreatedAt,
    holderCount: toFiniteInteger(raw.holderCount),
    // Jupiter sometimes omits `audit.mintAuthorityDisabled` and instead exposes
    // a null `mintAuthority`, which means the same thing: no mint authority.
    mintAuthorityDisabled:
      audit.mintAuthorityDisabled === true || raw.mintAuthority === null,
    freezeAuthorityDisabled:
      audit.freezeAuthorityDisabled === true || raw.freezeAuthority === null,
    authorityDataKnown:
      audit.mintAuthorityDisabled !== undefined ||
      audit.freezeAuthorityDisabled !== undefined ||
      raw.mintAuthority !== undefined ||
      raw.freezeAuthority !== undefined,
    // Documented as a 0-100 scale. Never rescaled.
    topHoldersPercentage: toFiniteNumber(audit.topHoldersPercentage),
    organicScore: toFiniteNumber(raw.organicScore),
    organicScoreLabel: toText(raw.organicScoreLabel),
    isVerified: raw.isVerified === true,
    tags,
    fdv: toFiniteNumber(raw.fdv),
    mcap: toFiniteNumber(raw.mcap),
    usdPrice,
    liquidity,
    stats5m: normalizeStats5m(raw.stats5m),
    tokenUpdatedAt: timestampMs(raw.updatedAt),
    launchpad: toText(raw.launchpad),
    observedAt: at,
  };
}

/**
 * Derive the agent-facing feature vector for a normalized token.
 * Every value is bounded so a single wild field cannot dominate a genome.
 */
export function deriveFeatures(token, { momentumReference = MOMENTUM_REFERENCE.live, at = Date.now() } = {}) {
  const stats = token.stats5m ?? EMPTY_STATS_5M;
  const liquidity = toFiniteNumber(token.liquidity);
  const priceChangePct = toFiniteNumber(stats.priceChange);
  const changeFraction =
    priceChangePct === null ? null : priceChangePct / 100;

  const buyVolume = toFiniteNumber(stats.buyVolume) ?? 0;
  const sellVolume = toFiniteNumber(stats.sellVolume) ?? 0;
  const totalVolume = buyVolume + sellVolume;
  const buyOrganicVolume = toFiniteNumber(stats.buyOrganicVolume) ?? 0;
  const sellOrganicVolume = toFiniteNumber(stats.sellOrganicVolume) ?? 0;

  const turnover = safeRatio(totalVolume, liquidity, 0) ?? 0;
  const poolAgeMs =
    token.poolCreatedAt === null ? null : Math.max(0, at - token.poolCreatedAt);
  const ageHours = poolAgeMs === null ? null : poolAgeMs / 3_600_000;

  const safetyScore =
    (token.mintAuthorityDisabled ? 0.5 : 0.15) +
    (token.freezeAuthorityDisabled ? 0.35 : 0.05) +
    (token.isVerified ? 0.15 : 0);

  return {
    // signed, -1..1
    momentum: changeFraction === null ? 0 : clampSigned(changeFraction / momentumReference),
    hasMomentum: changeFraction !== null,
    changeFraction,
    changePct: priceChangePct,
    // 0..1
    buyPressure: safeRatio(buyVolume, totalVolume, 0.5) ?? 0.5,
    volumeActivity: clamp01(Math.log10(1 + turnover * 100) / 2.5),
    turnover,
    // Divisors are chosen so that a unit-scale gate is meaningful on Solana:
    // liquidityQuality 0.5 ~ $2K, 0.8 ~ $180K, 1.0 ~ $3M+.
    liquidityQuality: logScale(liquidity, 6.5),
    mcapScale: logScale(token.mcap, 10),
    organicScore: clamp01((token.organicScore ?? 0) / 100),
    organicFlow: safeRatio(buyOrganicVolume, buyOrganicVolume + sellOrganicVolume, 0.5) ?? 0.5,
    orderFlow: safeRatio(stats.numBuys, (stats.numBuys ?? 0) + (stats.numSells ?? 0), 0.5) ?? 0.5,
    holderBase: logScale(token.holderCount, 6),
    holderDistribution: clamp01(
      1 - (toFiniteNumber(token.topHoldersPercentage) ?? 100) / 100 * 1.6,
    ),
    safety: clamp01(safetyScore),
    ageYouth: ageHours === null ? 0.5 : clamp01(1 - Math.log10(1 + ageHours) / 3),
    poolAgeHours: ageHours,
    traderActivity: logScale(stats.numTraders, 4),
    organicBuyers: logScale(stats.numOrganicBuyers, 3),
    // signed, -1..1
    liquidityTrend: clampSigned((toFiniteNumber(stats.liquidityChange) ?? 0) / 10),
    holderGrowth: clampSigned((toFiniteNumber(stats.holderChange) ?? 0) / 5),
    netBuyerPressure: clampSigned((toFiniteNumber(stats.numNetBuyers) ?? 0) / 500),
    volatility: clamp01(
      Math.abs(changeFraction ?? 0) * 2 + Math.abs(toFiniteNumber(stats.volumeChange) ?? 0) / 200,
    ),
  };
}

/**
 * Build the market record consumed by agents, fitness, and the dashboard.
 *
 * `prev` is the previous observation of the same mint, used only for
 * observation-to-observation deltas. No synthetic movement is ever invented
 * for a live token: prices are always the last value actually observed.
 */
export function deriveMarket(
  token,
  {
    prev = null,
    at = Date.now(),
    staleMs = 60_000,
    momentumReference = MOMENTUM_REFERENCE.live,
  } = {},
) {
  const stats = token.stats5m ?? EMPTY_STATS_5M;
  const features = deriveFeatures(token, { momentumReference, at });

  const buyVolume = toFiniteNumber(stats.buyVolume);
  const sellVolume = toFiniteNumber(stats.sellVolume);
  const buyOrganicVolume = toFiniteNumber(stats.buyOrganicVolume);
  const sellOrganicVolume = toFiniteNumber(stats.sellOrganicVolume);

  const price = toFiniteNumber(token.usdPrice);
  const prevPrice = toFiniteNumber(prev?.usdPrice);
  const observedChangePct =
    price !== null && prevPrice !== null && prevPrice !== 0
      ? (price / prevPrice - 1) * 100
      : null;

  // Prefer the venue's own 5m statistic, fall back to our own observation delta.
  const changePct = features.changePct ?? observedChangePct ?? 0;
  const lastObservedAt = token.observedAt ?? at;
  const ageMs = Math.max(0, at - lastObservedAt);

  const buySellRatio = safeRatio(buyVolume, sellVolume, null);
  const organicBuySellRatio = safeRatio(buyOrganicVolume, sellOrganicVolume, null);
  const totalVolume =
    buyVolume === null && sellVolume === null ? null : (buyVolume ?? 0) + (sellVolume ?? 0);

  return {
    mint: token.mint,
    symbol: token.symbol,
    name: token.name,
    icon: token.icon,
    source: token.source,
    synthetic: token.synthetic === true,
    verified: token.isVerified === true,
    endpoint: token.endpoint ?? null,
    launchpad: token.launchpad ?? null,
    tags: token.tags ?? [],

    // pricing
    price,
    prevPrice,
    prevObservedAt: prev?.observedAt ?? null,
    observedChangePct,
    changePct,
    changeFraction: features.changeFraction,

    // size and flow
    liquidity: toFiniteNumber(token.liquidity),
    liquidityChange: toFiniteNumber(stats.liquidityChange),
    mcap: toFiniteNumber(token.mcap),
    fdv: toFiniteNumber(token.fdv),
    volume5m: totalVolume,
    buyVolume,
    sellVolume,
    buySellRatio,
    buySellRatioSafe: buySellRatio ?? 0,
    organicBuySellRatio,
    organicBuySellRatioSafe: organicBuySellRatio ?? 0,
    buyPressure: features.buyPressure,
    numBuys: toFiniteNumber(stats.numBuys),
    numSells: toFiniteNumber(stats.numSells),
    numTraders: toFiniteNumber(stats.numTraders),
    numOrganicBuyers: toFiniteNumber(stats.numOrganicBuyers),
    numNetBuyers: toFiniteNumber(stats.numNetBuyers),
    turnover: features.turnover,

    // quality / safety
    organicScore: toFiniteNumber(token.organicScore),
    organicScoreLabel: token.organicScoreLabel ?? null,
    holderCount: toFiniteNumber(token.holderCount),
    holderChange: toFiniteNumber(stats.holderChange),
    topHoldersPercentage: toFiniteNumber(token.topHoldersPercentage),
    mintAuthorityDisabled: token.mintAuthorityDisabled === true,
    freezeAuthorityDisabled: token.freezeAuthorityDisabled === true,

    // age (first pool creation, NOT mint creation)
    poolCreatedAt: token.poolCreatedAt ?? null,
    poolAgeMs: features.poolAgeHours === null ? null : features.poolAgeHours * 3_600_000,

    // observation bookkeeping
    lastObservedAt,
    ageMs,
    fresh: ageMs <= staleMs,
    firstSeenAt: prev?.firstSeenAt ?? token.firstSeenAt ?? lastObservedAt,
    observationCount: (prev?.observationCount ?? 0) + 1,

    features,

    // legacy Phase 1 field names kept so the existing UI keeps working
    momentum: features.changeFraction ?? 0,
    uniqueBuyers: toFiniteNumber(stats.numTraders),
    volume: totalVolume,
    volumeRatio: features.turnover,
  };
}

