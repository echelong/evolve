/**
 * Phase 5I.0b — deterministic PRE-OUTCOME feature extraction for the SOL/USDC
 * directional benchmark.
 *
 * Every feature here is derived from data EVOLVE GENUINELY OBSERVES through its
 * existing Jupiter Tokens V2 observation pipeline, plus the benchmark's OWN
 * prior observations of the same market (which were themselves observed before
 * `t0`, so using them is not look-ahead).
 *
 * Rules that are not negotiable:
 *
 *   - NO future information. The history used here is strictly prior to the
 *     observation being described, and `audit.mjs` PROVES it by recomputation.
 *   - NO invented microstructure. Order-book imbalance, CVD, queue depth, maker
 *     flow, quote spread, quote price impact and route counts are NOT derivable
 *     from the observed schema and are declared unavailable in `definition.mjs`
 *     instead of being approximated from 5m aggregates.
 *   - NAMES SAY WHAT THE DATA IS (§34). A quantity built from the venue's 5m
 *     aggregated volumes is named `observed5mVolumeFlowImbalance`, never
 *     `orderBookImbalance` or `CVD`. A quantity derived from our own reference
 *     observations is named `recentReferenceReturn`, never "microstructure".
 *   - NO zero-for-unknown. A feature that was not observed is `null`. `0` is a
 *     real observed value and is never overloaded to mean "missing".
 *   - WARMUP IS DECLARED, NOT INVENTED. Every recursive feature pins the minimum
 *     number of strictly-prior observations it needs; an observation without that
 *     warmup is reported as warmup-incomplete instead of being filled in.
 *   - Deterministic. Same inputs -> byte-identical feature object, and the exact
 *     input projection is persisted so anyone can recompute it offline.
 *
 * PAPER ONLY / DEVELOPMENT EVIDENCE ONLY.
 */

import { digestOf } from "../../lib/hash.mjs";
import { classifyWindowRegime, computeRegimeMetrics } from "../../arena/orchestrator.mjs";
import { deriveFeatures, toFiniteNumber } from "../../market/normalize.mjs";
import {
  DIRECTION_PHASE,
  FORBIDDEN_GRANULARITY_PHRASES,
  FORBIDDEN_GRANULARITY_TOKENS,
  OBSERVATION_HISTORY_LIMIT,
} from "./definition.mjs";

export const DIRECTION_FEATURE_DEFINITION_VERSION = 1;

/* ============================================================================
 * Data-granularity integrity (§32)
 *
 * Static + behavioural validation that NO 5I feature or state field implies a
 * market concept EVOLVE does not observe. A Jupiter quote/aggregate is NOT an
 * order book, so a name like `orderBookImbalance` is refused outright rather
 * than quietly approximated from 5m aggregates.
 * ==========================================================================*/

/** Split a camelCase / snake_case / kebab-case identifier into lowercase words. */
export function tokenizeIdentifier(name) {
  return String(name ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 0);
}

/**
 * Report every identifier that names (or implies) unsupported high-granularity
 * market data. Only IDENTIFIERS are inspected — never free-text reasons, because
 * the packet legitimately DECLARES the unavailable families in prose.
 *
 * @param {string[]} names
 * @returns {{ ok: boolean, violations: Array<{ name: string, kind: string, detail: string }>, checked: number }}
 */
export function auditGranularityNames(names = []) {
  const violations = [];
  for (const name of names) {
    const tokens = tokenizeIdentifier(name);
    for (const token of tokens) {
      if (FORBIDDEN_GRANULARITY_TOKENS.includes(token)) {
        violations.push({ name: String(name), kind: "token", detail: token });
      }
    }
    const phrase = tokens.join(" ");
    for (const forbidden of FORBIDDEN_GRANULARITY_PHRASES) {
      if (phrase.includes(forbidden)) {
        violations.push({ name: String(name), kind: "phrase", detail: forbidden });
      }
    }
  }
  return { ok: violations.length === 0, violations, checked: names.length };
}



/** Population standard deviation of a numeric array (order independent). */
export function populationStdDev(values) {
  const list = (values ?? []).filter((value) => Number.isFinite(value));
  if (list.length === 0) return null;
  const mean = list.reduce((sum, value) => sum + value, 0) / list.length;
  return Math.sqrt(list.reduce((sum, value) => sum + (value - mean) ** 2, 0) / list.length);
}

/** Deterministic median of a numeric array (sorts a copy; never mutates input). */
export function medianOf(values) {
  const list = (values ?? []).filter((value) => Number.isFinite(value)).slice().sort((a, b) => a - b);
  if (list.length === 0) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 === 1 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

/** Log returns between consecutive genuinely observed prices of the same market. */
export function logReturnsFromHistory(history) {
  const out = [];
  for (let index = 1; index < (history?.length ?? 0); index += 1) {
    const previous = toFiniteNumber(history[index - 1]?.priceUsd);
    const current = toFiniteNumber(history[index]?.priceUsd);
    if (previous === null || current === null || previous <= 0 || current <= 0) continue;
    out.push(Math.log(current / previous));
  }
  return out;
}

/**
 * FROZEN FEATURE LIST. `minimumWarmup` is the number of strictly-prior
 * observations this feature needs to be non-null; it is a DECLARED requirement,
 * never tuned against outcomes.
 */
export const DIRECTION_FEATURE_DEFINITIONS = Object.freeze([
  {
    name: "referencePriceUsd",
    unit: "usd",
    minimumWarmup: 0,
    definition: "SOL usdPrice of THIS observation, as normalized by deriveMarket(). The benchmark reference price.",
  },
  {
    name: "priorObservationCount",
    unit: "count",
    minimumWarmup: 0,
    definition: "Number of strictly-prior SOL observations carried into this state.",
  },
  {
    name: "recentReferenceReturn1",
    unit: "fraction",
    minimumWarmup: 1,
    definition: "referencePriceUsd / previousObservedReferencePrice - 1 (null without one prior observation).",
  },
  {
    name: "recentReferenceReturn3",
    unit: "fraction",
    minimumWarmup: 3,
    definition: "referencePriceUsd / reference price three observations back - 1 (null without three).",
  },
  {
    name: "recentReferenceLogReturnMean",
    unit: "log-fraction",
    minimumWarmup: 1,
    definition: "Mean of the log returns over the carried pre-t0 history (null without one).",
  },
  {
    name: "recentReferenceDispersion",
    unit: "log-fraction",
    minimumWarmup: 2,
    definition: "Population standard deviation of the pre-t0 log returns (null without two).",
  },
  {
    name: "recentReferenceDirectionRatio",
    unit: "fraction",
    minimumWarmup: 1,
    definition: "Share of strictly positive pre-t0 log returns (null without one).",
  },
  {
    name: "observed5mPriceChangePct",
    unit: "percent",
    minimumWarmup: 0,
    definition: "Jupiter Tokens V2 stats5m.priceChange (venue 5m aggregate, not rescaled).",
  },
  {
    name: "observedLiquidityChangePct",
    unit: "percent",
    minimumWarmup: 0,
    definition: "Jupiter Tokens V2 stats5m.liquidityChange (venue 5m aggregate).",
  },
  {
    name: "observed5mVolumeChangePct",
    unit: "percent",
    minimumWarmup: 0,
    definition: "Jupiter Tokens V2 stats5m.volumeChange (venue 5m aggregate).",
  },
  {
    name: "observed5mHolderChangePct",
    unit: "percent",
    minimumWarmup: 0,
    definition: "Jupiter Tokens V2 stats5m.holderChange (venue 5m aggregate).",
  },
  {
    name: "observedLiquidityUsd",
    unit: "usd",
    minimumWarmup: 0,
    definition: "Observed pool liquidity (deriveMarket.liquidity).",
  },
  {
    name: "observedLiquidityQuality",
    unit: "0..1",
    minimumWarmup: 0,
    definition: "deriveFeatures.liquidityQuality over the observed liquidity (existing versioned transform).",
  },
  {
    name: "observed5mTurnoverRatio",
    unit: "ratio",
    minimumWarmup: 0,
    definition: "deriveFeatures.turnover = observed 5m volume / observed liquidity (existing versioned transform).",
  },
  {
    name: "observed5mBuyVolumeUsd",
    unit: "usd",
    minimumWarmup: 0,
    definition: "Observed stats5m.buyVolume (venue 5m aggregate).",
  },
  {
    name: "observed5mSellVolumeUsd",
    unit: "usd",
    minimumWarmup: 0,
    definition: "Observed stats5m.sellVolume (venue 5m aggregate).",
  },
  {
    name: "observed5mVolumeFlowImbalance",
    unit: "-1..1",
    minimumWarmup: 0,
    definition:
      "(buyVolume - sellVolume) / (buyVolume + sellVolume) over the venue's 5m aggregates. It is a VOLUME FLOW " +
      "imbalance: NOT order-book imbalance, NOT CVD, NOT queue depth.",
  },
  {
    name: "observed5mBuySellVolumeRatio",
    unit: "ratio",
    minimumWarmup: 0,
    definition: "buyVolume / sellVolume from the venue's 5m aggregates when sellVolume > 0 (null otherwise).",
  },
  {
    name: "observed5mOrganicBuySellVolumeRatio",
    unit: "ratio",
    minimumWarmup: 0,
    definition: "stats5m.buyOrganicVolume / stats5m.sellOrganicVolume when the denominator is > 0.",
  },
  {
    name: "observed5mBuyPressure",
    unit: "0..1",
    minimumWarmup: 0,
    definition: "deriveFeatures.buyPressure over the observed 5m aggregates (existing versioned transform).",
  },
  {
    name: "observed5mBuyCount",
    unit: "count",
    minimumWarmup: 0,
    definition: "Observed stats5m.numBuys.",
  },
  {
    name: "observed5mSellCount",
    unit: "count",
    minimumWarmup: 0,
    definition: "Observed stats5m.numSells.",
  },
  {
    name: "observed5mTraderCount",
    unit: "count",
    minimumWarmup: 0,
    definition: "Observed stats5m.numTraders.",
  },
  {
    name: "observed5mNetBuyerCount",
    unit: "count",
    minimumWarmup: 0,
    definition: "Observed stats5m.numNetBuyers.",
  },
  {
    name: "observed5mOrganicBuyerCount",
    unit: "count",
    minimumWarmup: 0,
    definition: "Observed stats5m.numOrganicBuyers.",
  },
  {
    name: "observedOrganicScore",
    unit: "0..100",
    minimumWarmup: 0,
    definition: "Observed organic score as published by the venue.",
  },
  {
    name: "observedMarketCapUsd",
    unit: "usd",
    minimumWarmup: 0,
    definition: "Observed market cap.",
  },
  {
    name: "observedFdvUsd",
    unit: "usd",
    minimumWarmup: 0,
    definition: "Observed fully diluted valuation.",
  },
  {
    name: "observedHolderCount",
    unit: "count",
    minimumWarmup: 0,
    definition: "Observed holder count.",
  },
  {
    name: "observedTopHoldersPct",
    unit: "percent",
    minimumWarmup: 0,
    definition: "Observed audit.topHoldersPercentage (0-100 scale, not rescaled).",
  },
  {
    name: "observed5mVolatilityProxy",
    unit: "0..1",
    minimumWarmup: 0,
    definition:
      "deriveFeatures.volatility over the observed 5m price change and volume change. A bounded PROXY built from 5m " +
      "aggregates — not realised volatility, not future volatility.",
  },
  {
    name: "observedPoolAgeHours",
    unit: "hours",
    minimumWarmup: 0,
    definition: "Age of the observed first pool at stateObservedAt (null when the venue does not report one).",
  },
  {
    name: "observedQuoteReferencePriceUsd",
    unit: "usd",
    minimumWarmup: 0,
    definition:
      "Observed usdPrice of the USDC mint in the SAME observation cycle (null when USDC was not observed). " +
      "Provenance only; it never rescales the reference price.",
  },
]);

export const DIRECTION_FEATURE_NAMES = Object.freeze(DIRECTION_FEATURE_DEFINITIONS.map((entry) => entry.name));

/**
 * The frozen feature vocabulary, audited here so importing this module is itself
 * a granularity check. `auditDirectionFeatures` re-runs it on the live vector.
 */
export const FEATURE_GRANULARITY_AUDIT = auditGranularityNames(DIRECTION_FEATURE_NAMES);

/** Frozen minimum-warmup map (feature -> strictly-prior observations required). */
export const MINIMUM_WARMUP = Object.freeze(
  Object.fromEntries(DIRECTION_FEATURE_DEFINITIONS.map((entry) => [entry.name, entry.minimumWarmup])),
);

/** The largest declared warmup: an observation is warmup-complete at or above this. */
export const MAX_DECLARED_WARMUP = Math.max(...Object.values(MINIMUM_WARMUP));

/** Minimum warmup a baseline needs, per its required inputs. */
export function warmupRequiredForInputs(inputNames = []) {
  return inputNames.reduce((max, name) => Math.max(max, MINIMUM_WARMUP[name] ?? 0), 0);
}

export const DIRECTION_FEATURE_DEFINITION = Object.freeze({
  phase: DIRECTION_PHASE,
  definitionVersion: DIRECTION_FEATURE_DEFINITION_VERSION,
  marketId: "SOL-USDC",
  features: DIRECTION_FEATURE_DEFINITIONS,
  minimumWarmup: MINIMUM_WARMUP,
  missingValueConvention: "null",
  zeroIsRealValue: true,
  orderBookFeaturesIncluded: false,
  cvdIncluded: false,
  classifierDerivedFeaturesInjected: false,
  preOutcomeInputProjectionVersion: 1,
  note:
    "Pre-outcome market-state features only. Phase 5H classifier-derived features are deliberately NOT injected into " +
    "this first 5I benchmark: 5I.0b isolates market-state prediction first.",
});

export const DIRECTION_FEATURE_DEFINITION_DIGEST = digestOf(DIRECTION_FEATURE_DEFINITION);

/** Regime metrics whitelisted into the packet (existing deterministic classifier, pre-t0 snapshots only). */
export const REGIME_METRIC_KEYS = Object.freeze([
  "medianReturn",
  "meanReturn",
  "dispersion",
  "liquidityChange",
  "volumeChange",
  "positiveRatio",
  "buySellRatio",
  "organicRatio",
  "activeTokens",
  "launchHeavyRatio",
  "activityPerSnapshot",
  "meanLiquidityUsd",
  "returnCount",
  "snapshots",
]);

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function ratioOrNull(numerator, denominator) {
  const n = toFiniteNumber(numerator);
  const d = toFiniteNumber(denominator);
  if (n === null || d === null || d === 0) return null;
  const value = n / d;
  return Number.isFinite(value) ? value : null;
}

const STATS_KEYS = Object.freeze([
  "priceChange",
  "liquidityChange",
  "volumeChange",
  "holderChange",
  "buyVolume",
  "sellVolume",
  "buyOrganicVolume",
  "sellOrganicVolume",
  "numBuys",
  "numSells",
  "numTraders",
  "numOrganicBuyers",
  "numNetBuyers",
]);

/**
 * The EXACT, bounded pre-outcome input projection every feature (and therefore
 * every baseline) is a pure function of. Persisting it makes offline
 * recomputation — including the Phase 5I lookahead audit — possible without
 * touching a provider, and makes "baselines and Jev consumed the same state"
 * mechanically checkable.
 */
export function buildPreOutcomeInputs({ market, token, history = [], observedAt, quoteMarket = null } = {}) {
  const stats = token?.stats5m ?? {};
  const boundedStats = {};
  for (const key of STATS_KEYS) boundedStats[key] = finiteOrNull(toFiniteNumber(stats[key]));

  return {
    projectionVersion: 1,
    observedAt: finiteOrNull(observedAt),
    history: (Array.isArray(history) ? history : [])
      .slice(-OBSERVATION_HISTORY_LIMIT)
      .map((entry) => ({
        observedAt: typeof entry?.observedAt === "string" ? entry.observedAt.slice(0, 40) : null,
        observedAtMs: finiteOrNull(toFiniteNumber(entry?.observedAtMs ?? Date.parse(entry?.observedAt))),
        priceUsd: finiteOrNull(toFiniteNumber(entry?.priceUsd)),
      })),
    market: {
      price: finiteOrNull(toFiniteNumber(market?.price)),
      liquidity: finiteOrNull(toFiniteNumber(market?.liquidity)),
      mcap: finiteOrNull(toFiniteNumber(market?.mcap)),
      fdv: finiteOrNull(toFiniteNumber(market?.fdv)),
      holderCount: finiteOrNull(toFiniteNumber(market?.holderCount)),
      topHoldersPercentage: finiteOrNull(toFiniteNumber(market?.topHoldersPercentage)),
      organicScore: finiteOrNull(toFiniteNumber(market?.organicScore)),
    },
    token: {
      stats5m: boundedStats,
      liquidity: finiteOrNull(toFiniteNumber(token?.liquidity)),
      mcap: finiteOrNull(toFiniteNumber(token?.mcap)),
      organicScore: finiteOrNull(toFiniteNumber(token?.organicScore)),
      holderCount: finiteOrNull(toFiniteNumber(token?.holderCount)),
      topHoldersPercentage: finiteOrNull(toFiniteNumber(token?.topHoldersPercentage)),
      poolCreatedAt: finiteOrNull(toFiniteNumber(token?.poolCreatedAt)),
    },
    quoteMarket: { price: finiteOrNull(toFiniteNumber(quoteMarket?.price)) },
  };
}

export const PRE_OUTCOME_INPUT_PROJECTION_VERSION = 1;

/**
 * Digest of the EXACT input projection a feature vector was computed from. It is
 * persisted with every prediction so the lookahead audit, the replay and the
 * validator can all recompute from the same frozen bytes offline.
 */
export function preOutcomeInputDigestOf(inputs) {
  return digestOf(inputs ?? null);
}

/**
 * HARD NO-LOOKAHEAD CUTOFF (§27).
 *
 * The feature function does NOT trust its caller to hand it a tidy pre-t0
 * window: every history entry is filtered against the observation's own cutoff
 * time, so a caller (or a future edit) that passes data newer than `t0` changes
 * NOTHING. This is what makes the Phase 5I lookahead audit a real behavioural
 * test rather than a source-code scan, and it is why appending future
 * observations to a stored input projection is provably inert.
 */
export function historyUpToCutoff(history, cutoffMs, limit = OBSERVATION_HISTORY_LIMIT) {
  const list = Array.isArray(history) ? history : [];
  const cutoff = Number.isFinite(cutoffMs) ? cutoffMs : null;
  const bounded = cutoff === null
    ? list
    : list.filter((entry) => {
        const at = toFiniteNumber(entry?.observedAtMs ?? Date.parse(entry?.observedAt));
        // An entry with no usable timestamp cannot be proven to be pre-t0, so it
        // is EXCLUDED rather than assumed safe.
        return at !== null && at <= cutoff;
      });
  return bounded.slice(-limit);
}

/**
 * Recompute the feature vector from a persisted pre-outcome input projection.
 * This is the ONLY place features are computed, so the audit, the replay and the
 * live run can never disagree about what a feature is.
 */
export function extractDirectionFeaturesFromInputs(inputs = {}) {
  const stats = inputs.token?.stats5m ?? {};
  const observedAt = Number.isFinite(inputs.observedAt) ? inputs.observedAt : 0;
  const tokenLike = {
    stats5m: stats,
    liquidity: inputs.token?.liquidity ?? null,
    mcap: inputs.token?.mcap ?? null,
    organicScore: inputs.token?.organicScore ?? null,
    holderCount: inputs.token?.holderCount ?? null,
    topHoldersPercentage: inputs.token?.topHoldersPercentage ?? null,
    poolCreatedAt: inputs.token?.poolCreatedAt ?? null,
  };
  const derived = deriveFeatures(tokenLike, { at: observedAt });

  // Cutoff-filtered: anything newer than this observation is discarded here, not
  // silently used. See `historyUpToCutoff`.
  const prior = historyUpToCutoff(inputs.history, inputs.observedAt);
  const priorPrices = prior.map((entry) => toFiniteNumber(entry?.priceUsd)).filter((value) => value !== null && value > 0);
  const logReturns = logReturnsFromHistory(prior);

  const referencePrice = toFiniteNumber(inputs.market?.price);
  const previousPrice = priorPrices.length > 0 ? priorPrices[priorPrices.length - 1] : null;
  const threeBack = priorPrices.length >= 3 ? priorPrices[priorPrices.length - 3] : null;

  const buyVolume = toFiniteNumber(stats.buyVolume);
  const sellVolume = toFiniteNumber(stats.sellVolume);
  const totalFlow = buyVolume === null && sellVolume === null ? null : (buyVolume ?? 0) + (sellVolume ?? 0);

  const features = {
    referencePriceUsd: finiteOrNull(referencePrice),
    priorObservationCount: prior.length,
    recentReferenceReturn1:
      referencePrice === null || previousPrice === null || previousPrice <= 0 ? null : referencePrice / previousPrice - 1,
    recentReferenceReturn3: threeBack === null || referencePrice === null ? null : referencePrice / threeBack - 1,
    recentReferenceLogReturnMean:
      logReturns.length > 0 ? logReturns.reduce((sum, value) => sum + value, 0) / logReturns.length : null,
    recentReferenceDispersion: populationStdDev(logReturns),
    recentReferenceDirectionRatio: logReturns.length > 0 ? logReturns.filter((value) => value > 0).length / logReturns.length : null,
    observed5mPriceChangePct: finiteOrNull(toFiniteNumber(stats.priceChange)),
    observedLiquidityChangePct: finiteOrNull(toFiniteNumber(stats.liquidityChange)),
    observed5mVolumeChangePct: finiteOrNull(toFiniteNumber(stats.volumeChange)),
    observed5mHolderChangePct: finiteOrNull(toFiniteNumber(stats.holderChange)),
    observedLiquidityUsd: finiteOrNull(toFiniteNumber(inputs.market?.liquidity)),
    observedLiquidityQuality: finiteOrNull(derived.liquidityQuality),
    observed5mTurnoverRatio: finiteOrNull(derived.turnover),
    observed5mBuyVolumeUsd: finiteOrNull(buyVolume),
    observed5mSellVolumeUsd: finiteOrNull(sellVolume),
    observed5mVolumeFlowImbalance: totalFlow === null || totalFlow === 0 ? null : ((buyVolume ?? 0) - (sellVolume ?? 0)) / totalFlow,
    observed5mBuySellVolumeRatio: ratioOrNull(buyVolume, sellVolume),
    observed5mOrganicBuySellVolumeRatio: ratioOrNull(stats.buyOrganicVolume, stats.sellOrganicVolume),
    observed5mBuyPressure: finiteOrNull(derived.buyPressure),
    observed5mBuyCount: finiteOrNull(toFiniteNumber(stats.numBuys)),
    observed5mSellCount: finiteOrNull(toFiniteNumber(stats.numSells)),
    observed5mTraderCount: finiteOrNull(toFiniteNumber(stats.numTraders)),
    observed5mNetBuyerCount: finiteOrNull(toFiniteNumber(stats.numNetBuyers)),
    observed5mOrganicBuyerCount: finiteOrNull(toFiniteNumber(stats.numOrganicBuyers)),
    observedOrganicScore: finiteOrNull(toFiniteNumber(inputs.market?.organicScore)),
    observedMarketCapUsd: finiteOrNull(toFiniteNumber(inputs.market?.mcap)),
    observedFdvUsd: finiteOrNull(toFiniteNumber(inputs.market?.fdv)),
    observedHolderCount: finiteOrNull(toFiniteNumber(inputs.market?.holderCount)),
    observedTopHoldersPct: finiteOrNull(toFiniteNumber(inputs.market?.topHoldersPercentage)),
    observed5mVolatilityProxy: finiteOrNull(derived.volatility),
    observedPoolAgeHours: finiteOrNull(derived.poolAgeHours),
    observedQuoteReferencePriceUsd: finiteOrNull(toFiniteNumber(inputs.quoteMarket?.price)),
  };

  return { features, historyUsed: prior };
}

/**
 * Extract the frozen feature vector for ONE observation from live normalized
 * objects. Internally identical to `extractDirectionFeaturesFromInputs`.
 *
 * @param {{
 *   market: object,        // deriveMarket() output for the benchmark base mint
 *   token: object,         // normalized token record from the existing universe
 *   history: Array<{ observedAt: string|number, priceUsd: number }>,  // strictly pre-t0
 *   observedAt: number,
 *   quoteMarket?: object|null,
 * }} input
 */
export function extractDirectionFeatures(input) {
  const inputs = buildPreOutcomeInputs(input ?? {});
  const computed = extractDirectionFeaturesFromInputs(inputs);
  return { ...computed, inputs };
}

/** Whether the declared minimum warmup is satisfied for the features that need it. */
export function warmupStatus(features = {}) {
  const prior = Number.isFinite(features.priorObservationCount) ? features.priorObservationCount : 0;
  const missing = DIRECTION_FEATURE_DEFINITIONS.filter(
    (entry) => entry.minimumWarmup > prior && (features[entry.name] === null || features[entry.name] === undefined),
  ).map((entry) => entry.name);
  const requiredWarmup = warmupRequiredForInputs(DIRECTION_FEATURE_NAMES);
  return {
    priorObservationCount: prior,
    requiredWarmupObservations: requiredWarmup,
    warmupComplete: prior >= requiredWarmup,
    warmupIncompleteFeatures: missing,
  };
}

/** Deterministic structural audit of a feature vector. */
export function auditDirectionFeatures(features) {
  const problems = [];
  if (!features || typeof features !== "object" || Array.isArray(features)) {
    return { ok: false, problems: ["features is not a plain object"] };
  }
  const allowed = new Set(DIRECTION_FEATURE_NAMES);
  for (const key of Object.keys(features)) {
    if (!allowed.has(key)) problems.push(`unknown feature key '${key}'`);
  }
  for (const name of DIRECTION_FEATURE_NAMES) {
    if (!Object.hasOwn(features, name)) {
      problems.push(`missing feature '${name}'`);
      continue;
    }
    const value = features[name];
    if (value !== null && !Number.isFinite(value)) problems.push(`feature '${name}' is neither finite nor null`);
  }
  // Unknown keys AND the frozen vocabulary both go through the granularity guard,
  // so a future edit that adds `orderBookImbalance` is refused at freeze time.
  const granularity = auditGranularityNames([...DIRECTION_FEATURE_NAMES, ...Object.keys(features)]);
  for (const violation of granularity.violations) {
    problems.push(`feature name '${violation.name}' implies unsupported ${violation.kind} '${violation.detail}'`);
  }
  return { ok: problems.length === 0, problems, granularity };
}

/**
 * Deterministic regime classification for the observation, computed with
 * EVOLVE's EXISTING regime classifier over PRE-t0 universe snapshots only.
 *
 * `snapshots` are the observation cycles this benchmark has itself already
 * performed (each one is a `{ markets: deriveMarket[] }` snapshot). The
 * classifier's own rules, metrics and vocabulary are reused verbatim — nothing
 * here invents a new regime vocabulary, and nothing here reads a snapshot that
 * was not observed before `stateFrozenAt`.
 */
export function classifyDirectionRegime(snapshots) {
  const classification = classifyWindowRegime(Array.isArray(snapshots) ? snapshots : []);
  const { metrics } = computeRegimeMetrics(Array.isArray(snapshots) ? snapshots : []);
  const boundedMetrics = {};
  for (const key of REGIME_METRIC_KEYS) boundedMetrics[key] = finiteOrNull(metrics?.[key]);

  // NOTE: the field is `regimeName`, never `label` — "label" is on the packet's
  // forbidden-key list so the OUTCOME label can never be smuggled in later.
  return {
    regimeName: classification?.regime ?? "unknown",
    confidence: Number.isFinite(classification?.confidence) ? classification.confidence : null,
    reason: typeof classification?.reason === "string" ? classification.reason.slice(0, 200) : null,
    metrics: boundedMetrics,
    derivedFrom: "pre-t0 benchmark universe snapshots",
  };
}
