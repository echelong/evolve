/**
 * Rolling, deduplicated market universe.
 *
 * The three Jupiter categories overlap heavily (a token can be brand new,
 * trending, and organic at the same time), so observations are merged by mint
 * instead of appended. Properties:
 *
 *   - keys are mints, duplicates merge field-by-field (non-null wins)
 *   - the previous distinct observation is retained on each token so agents
 *     and the dashboard can compute observation-to-observation deltas without
 *     inventing any price movement
 *   - tokens that vanish from one polling result are kept until the TTL expires
 *   - the universe is hard-bounded: the least useful tokens are evicted first
 *   - no NaN / Infinity can enter: every numeric field is sanitized on ingest
 */

import { toFiniteNumber, toText } from "./normalize.mjs";

const NUMERIC_FIELDS = [
  "decimals",
  "holderCount",
  "topHoldersPercentage",
  "organicScore",
  "fdv",
  "mcap",
  "usdPrice",
  "liquidity",
  "poolCreatedAt",
  "tokenUpdatedAt",
];

/** Fields copied verbatim from an incoming observation. */
const PASSTHROUGH_FIELDS = [
  "mint",
  "name",
  "symbol",
  "icon",
  "firstPoolId",
  "organicScoreLabel",
  "launchpad",
  "endpoint",
  "source",
];

function sameObservation(a, b) {
  if (!a || !b) return false;
  return (
    a.usdPrice === b.usdPrice &&
    a.liquidity === b.liquidity &&
    a.holderCount === b.holderCount &&
    a.organicScore === b.organicScore
  );
}

function compareStats(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/** Merge a new observation onto the stored one. Non-null incoming values win. */
export function mergeToken(previous, incoming) {
  const merged = { ...previous };

  for (const field of PASSTHROUGH_FIELDS) {
    if (incoming[field] !== undefined && incoming[field] !== null) {
      merged[field] = incoming[field];
    }
  }

  for (const field of NUMERIC_FIELDS) {
    const next = toFiniteNumber(incoming[field]);
    if (next !== null) merged[field] = next;
    else if (!Number.isFinite(previous?.[field])) merged[field] = null;
  }

  merged.mint = incoming.mint;
  merged.synthetic = incoming.synthetic === true;
  merged.isVerified = incoming.isVerified === true;

  merged.mintAuthorityDisabled =
    incoming.authorityDataKnown === true
      ? incoming.mintAuthorityDisabled === true
      : previous?.mintAuthorityDisabled === true;
  merged.freezeAuthorityDisabled =
    incoming.authorityDataKnown === true
      ? incoming.freezeAuthorityDisabled === true
      : previous?.freezeAuthorityDisabled === true;
  merged.authorityDataKnown =
    incoming.authorityDataKnown === true || previous?.authorityDataKnown === true;

  merged.tags = Array.isArray(incoming.tags) ? [...incoming.tags] : (previous?.tags ?? []);

  const incomingStats = incoming.stats5m ?? {};
  const previousStats = previous?.stats5m ?? {};
  merged.stats5m = {};
  for (const key of new Set([...Object.keys(previousStats), ...Object.keys(incomingStats)])) {
    const next = toFiniteNumber(incomingStats[key]);
    merged.stats5m[key] = next !== null ? next : toFiniteNumber(previousStats[key]);
  }

  const changed = !sameObservation(previous, merged) || !compareStats(previous?.stats5m, merged.stats5m);

  if (changed) {
    merged.prevObservation = previous
      ? {
          usdPrice: previous.usdPrice ?? null,
          liquidity: previous.liquidity ?? null,
          observedAt: previous.observedAt ?? null,
        }
      : previous?.prevObservation ?? null;
    merged.observationCount = (previous?.observationCount ?? 0) + 1;
    merged.observedAt = incoming.observedAt ?? Date.now();
  } else {
    merged.observationCount = previous?.observationCount ?? 1;
    merged.prevObservation = previous?.prevObservation ?? null;
    merged.observedAt = previous?.observedAt ?? incoming.observedAt ?? Date.now();
  }

  merged.firstSeenAt = previous?.firstSeenAt ?? incoming.observedAt ?? merged.observedAt;
  merged.lastSeenAt = Math.max(previous?.lastSeenAt ?? 0, incoming.observedAt ?? Date.now());

  const categories = new Set(previous?.categories ?? []);
  if (incoming.endpoint) categories.add(incoming.endpoint);
  merged.categories = [...categories];

  return merged;
}

export class MarketUniverse {
  /**
   * @param {{ max?: number, ttlMs?: number, staleMs?: number, minLiquidityUsd?: number,
   *           now?: () => number }} [options]
   */
  constructor({ max = 150, ttlMs = 300_000, staleMs = 60_000, minLiquidityUsd = 0, now = () => Date.now() } = {}) {
    this.max = Math.max(1, Math.round(max));
    this.ttlMs = Math.max(1000, Math.round(ttlMs));
    this.staleMs = Math.max(1000, Math.round(staleMs));
    this.minLiquidityUsd = Number.isFinite(minLiquidityUsd) ? minLiquidityUsd : 0;
    this.now = now;
    /** @type {Map<string, object>} */
    this.tokens = new Map();
    this.evicted = 0;
    this.merged = 0;
    this.lastIngestAt = null;
  }

  get size() {
    return this.tokens.size;
  }

  /** Ingest a batch of normalized observations. Returns the number of mints seen. */
  ingest(tokens, { category = null, at = this.now() } = {}) {
    if (!Array.isArray(tokens)) return 0;

    let seen = 0;
    for (const token of tokens) {
      const mint = toText(token?.mint ?? token?.id);
      if (!mint) continue;

      const incoming = { ...token, mint, endpoint: category ?? token.endpoint ?? null };
      const previous = this.tokens.get(mint);
      if (previous) this.merged += 1;

      this.tokens.set(mint, mergeToken(previous, incoming));
      seen += 1;
    }

    this.lastIngestAt = at;
    this.prune(at);
    return seen;
  }

  /** Drop expired tokens, then enforce the hard bound. */
  prune(at = this.now()) {
    for (const [mint, token] of this.tokens) {
      const lastSeen = token.lastSeenAt ?? token.observedAt ?? at;
      if (at - lastSeen > this.ttlMs) {
        this.tokens.delete(mint);
        this.evicted += 1;
      }
    }

    if (this.tokens.size <= this.max) return this.tokens.size;

    const ranked = [...this.tokens.values()].sort(
      (a, b) => this.usefulness(b, at) - this.usefulness(a, at),
    );
    for (const token of ranked.slice(this.max)) {
      this.tokens.delete(token.mint);
      this.evicted += 1;
    }

    return this.tokens.size;
  }

  /**
   * Preference order: usable live data (price + liquidity) first, then
   * freshness, then depth. This keeps the ~150 slots for tokens agents can
   * actually reason about.
   */
  usefulness(token, at = this.now()) {
    const price = toFiniteNumber(token.usdPrice);
    const liquidity = toFiniteNumber(token.liquidity);
    const age = Math.max(0, at - (token.lastSeenAt ?? token.observedAt ?? at));

    let score = 0;
    if (price !== null && price > 0) score += 4;
    if (liquidity !== null && liquidity > 0) score += 3;
    if (liquidity !== null && liquidity >= this.minLiquidityUsd) score += 1;
    if (age <= this.staleMs) score += 2;
    score += Math.min(1.5, Math.log10(1 + Math.max(0, liquidity ?? 0)) / 4);
    score += Math.min(1, Math.max(0, toFiniteNumber(token.organicScore) ?? 0) / 100);
    if (token.isVerified === true) score += 0.25;
    score -= Math.min(2, age / Math.max(1, this.ttlMs));

    return score;
  }

  /** Ordered token list, best first. */
  values(at = this.now()) {
    return [...this.tokens.values()].sort(
      (a, b) => this.usefulness(b, at) - this.usefulness(a, at),
    );
  }

  get(mint) {
    return this.tokens.get(mint) ?? null;
  }

  clear() {
    this.tokens.clear();
  }

  summary(at = this.now()) {
    let usable = 0;
    let fresh = 0;
    for (const token of this.tokens.values()) {
      const price = toFiniteNumber(token.usdPrice);
      const liquidity = toFiniteNumber(token.liquidity);
      if (price !== null && price > 0 && liquidity !== null && liquidity > 0) usable += 1;
      if (at - (token.lastSeenAt ?? at) <= this.staleMs) fresh += 1;
    }

    return {
      tracked: this.tokens.size,
      max: this.max,
      usable,
      fresh,
      evicted: this.evicted,
      mergedObservations: this.merged,
      lastIngestAt: this.lastIngestAt,
    };
  }
}
