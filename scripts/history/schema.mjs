/**
 * Historical dataset schema.
 *
 * The recorder stores exactly the normalized market representation that the
 * live engine feeds to agents (`feed.markets(at)`), plus feed health and mode
 * metadata. There is deliberately no second normalization pipeline: what an
 * agent saw live is what gets written, and what is read back is what an agent
 * sees during replay.
 *
 * Format: NDJSON, one record per line, append-only and stream-readable.
 *
 *   line 1            session header  { type: "session", v, rowFields: [...] }
 *   lines 2..n        snapshots       { type: "snapshot", v, seq, t, rows: [[...]] }
 *   interleaved       events          { type: "event", v, seq, t, kind, message }
 *
 * Snapshots use a columnar row layout: the field names live once in the session
 * header, and each snapshot carries bare arrays. That keeps a 150-token
 * snapshot roughly 40% smaller than the equivalent object-per-token JSON while
 * staying trivially readable by Node.
 */

import { sanitizeForPublic } from "../lib/sanitize.mjs";

export const HISTORY_SCHEMA_VERSION = 1;

export const RECORD_TYPE = Object.freeze({
  SESSION: "session",
  SNAPSHOT: "snapshot",
  EVENT: "event",
});

export const DATASET_CLASS = Object.freeze({
  LIVE_ONLY: "live-only",
  SYNTHETIC_ONLY: "synthetic-only",
  MIXED: "mixed",
  EMPTY: "empty",
});

export const DATASET_STATUS = Object.freeze({
  RECORDING: "recording",
  COMPLETE: "complete",
  INTERRUPTED: "interrupted",
});

/** Flat market fields written for every observed token. */
const MARKET_FIELDS = [
  "mint",
  "symbol",
  "name",
  "source",
  "verified",
  "synthetic",
  "endpoint",
  "launchpad",
  "price",
  "prevPrice",
  "prevObservedAt",
  "observedChangePct",
  "changePct",
  "liquidity",
  "liquidityChange",
  "mcap",
  "fdv",
  "volume5m",
  "buyVolume",
  "sellVolume",
  "buySellRatio",
  "organicBuySellRatio",
  "buyPressure",
  "numBuys",
  "numSells",
  "numTraders",
  "numOrganicBuyers",
  "numNetBuyers",
  "turnover",
  "organicScore",
  "organicScoreLabel",
  "holderCount",
  "holderChange",
  "topHoldersPercentage",
  "mintAuthorityDisabled",
  "freezeAuthorityDisabled",
  "poolCreatedAt",
  "poolAgeMs",
  "lastObservedAt",
  "fresh",
  "firstSeenAt",
  "observationCount",
];

/** Feature-vector keys written for every observed token. */
const FEATURE_FIELDS = [
  "momentum",
  "changeFraction",
  "changePct",
  "buyPressure",
  "volumeActivity",
  "turnover",
  "liquidityQuality",
  "mcapScale",
  "organicScore",
  "organicFlow",
  "orderFlow",
  "holderBase",
  "holderDistribution",
  "safety",
  "ageYouth",
  "poolAgeHours",
  "traderActivity",
  "organicBuyers",
  "liquidityTrend",
  "holderGrowth",
  "netBuyerPressure",
  "volatility",
];

/**
 * Row layout. `feature.*` entries are stored under a nested `features` object
 * when decoded, so decoded markets match the live representation exactly.
 */
export const ROW_FIELDS = Object.freeze([
  ...MARKET_FIELDS,
  ...FEATURE_FIELDS.map((key) => `feature.${key}`),
]);

export const FEATURE_KEYS = Object.freeze([...FEATURE_FIELDS]);

/** Compact health subset recorded with every snapshot. */
const HEALTH_FIELDS = [
  "requestedMode",
  "effectiveMode",
  "source",
  "provider",
  "healthy",
  "degraded",
  "stale",
  "entriesPaused",
  "allowNewEntries",
  "ageMs",
  "staleMs",
  "tokensTracked",
  "requestCount",
  "errorCount",
  "rateLimitCount",
  "authErrorCount",
  "timeoutCount",
  "consecutiveFailures",
  "lastSuccessAt",
  "lastErrorKind",
  "lastEndpoint",
];

function finiteOrNull(value) {
  if (typeof value === "boolean") return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Market record -> flat row aligned with ROW_FIELDS. */
export function marketToRow(market) {
  const row = new Array(ROW_FIELDS.length);

  for (let index = 0; index < MARKET_FIELDS.length; index += 1) {
    const key = MARKET_FIELDS[index];
    const value = market?.[key];
    if (typeof value === "boolean") row[index] = value;
    else if (value === null || value === undefined) row[index] = null;
    else if (typeof value === "string") row[index] = value;
    else row[index] = finiteOrNull(value);
  }

  const offset = MARKET_FIELDS.length;
  for (let index = 0; index < FEATURE_FIELDS.length; index += 1) {
    row[offset + index] = finiteOrNull(market?.features?.[FEATURE_FIELDS[index]]);
  }

  return row;
}

/** Flat row -> market record. The inverse of `marketToRow`. */
export function rowToMarket(row) {
  if (!Array.isArray(row)) return null;

  const mint = row[0];
  if (typeof mint !== "string" || mint.length === 0) return null;

  const market = {};
  for (let index = 0; index < MARKET_FIELDS.length; index += 1) {
    market[MARKET_FIELDS[index]] = row[index] ?? null;
  }

  const features = {};
  const offset = MARKET_FIELDS.length;
  for (let index = 0; index < FEATURE_FIELDS.length; index += 1) {
    features[FEATURE_FIELDS[index]] = row[offset + index] ?? null;
  }

  market.features = features;
  market.tags = [];
  market.icon = null;
  market.buySellRatioSafe = Number.isFinite(market.buySellRatio) ? market.buySellRatio : 0;
  market.organicBuySellRatioSafe = Number.isFinite(market.organicBuySellRatio)
    ? market.organicBuySellRatio
    : 0;
  market.momentum = Number.isFinite(features.changeFraction) ? features.changeFraction : 0;
  market.uniqueBuyers = market.numTraders;
  market.volume = market.volume5m;
  market.volumeRatio = features.turnover;
  market.ageMs = null;

  return market;
}

export function buildSessionRecord({
  datasetId,
  createdAt,
  source,
  requestedMode,
  effectiveMode,
  captureMs,
  engineVersion,
  gitCommit,
  classifySource = "normalized-market-snapshot",
}) {
  return {
    v: HISTORY_SCHEMA_VERSION,
    type: RECORD_TYPE.SESSION,
    datasetId,
    createdAt,
    source,
    requestedMode,
    effectiveMode,
    captureMs,
    engineVersion: engineVersion ?? null,
    gitCommit: gitCommit ?? null,
    rowFields: [...ROW_FIELDS],
    classifySource,
    paperOnly: true,
    note: "Normalized market observations only. No credentials are recorded.",
  };
}

export function compactHealth(health, at) {
  const out = {};
  for (const key of HEALTH_FIELDS) {
    const value = health?.[key];
    if (value === undefined) continue;
    if (typeof value === "boolean" || typeof value === "string") out[key] = value;
    else out[key] = finiteOrNull(value);
  }
  out.recordedAt = at;
  return out;
}

export function buildSnapshotRecord({ seq, t, capturedAt, markets, health }) {
  return {
    v: HISTORY_SCHEMA_VERSION,
    type: RECORD_TYPE.SNAPSHOT,
    seq,
    t,
    capturedAt,
    mode: {
      requested: health?.requestedMode ?? null,
      effective: health?.effectiveMode ?? null,
      source: health?.source ?? null,
      degraded: health?.degraded === true,
      stale: health?.stale === true,
      entriesPaused: health?.entriesPaused === true,
    },
    health: compactHealth(health, t),
    count: markets.length,
    rows: markets.map(marketToRow),
  };
}

export function buildEventRecord({ seq, t, at, kind, message, detail = null }) {
  return {
    v: HISTORY_SCHEMA_VERSION,
    type: RECORD_TYPE.EVENT,
    seq,
    t,
    at,
    kind,
    message: sanitizeForPublic(String(message ?? ""), {}),
    detail: detail ? sanitizeForPublic(detail, {}) : null,
  };
}

/** Parse one NDJSON line. Returns null for blank or unreadable lines. */
export function parseRecord(line) {
  const trimmed = String(line ?? "").trim();
  if (trimmed === "") return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** Serialize a record with non-finite values and secrets stripped. */
export function serializeRecord(record) {
  return `${JSON.stringify(sanitizeForPublic(record))}\n`;
}

/**
 * Classify a dataset from the modes observed in its snapshots.
 *
 * A dataset that contains synthetic observations can never pretend to be a real
 * Solana historical dataset: the classification is explicit and the manifest
 * repeats it in plain words.
 */
export function classifySnapshots(snapshotModes) {
  let live = 0;
  let synthetic = 0;

  for (const mode of snapshotModes) {
    const source = String(mode?.source ?? "").toLowerCase();
    const effective = String(mode?.effective ?? "").toLowerCase();
    const isSynthetic = source.includes("synthetic") || effective === "synthetic";
    if (isSynthetic) synthetic += 1;
    else live += 1;
  }

  const total = live + synthetic;
  if (total === 0) {
    return {
      classification: DATASET_CLASS.EMPTY,
      containsLive: false,
      containsSynthetic: false,
      liveSnapshots: 0,
      syntheticSnapshots: 0,
      usableForRealMarketReplay: false,
      statement: "No observations recorded.",
    };
  }

  if (synthetic === 0) {
    return {
      classification: DATASET_CLASS.LIVE_ONLY,
      containsLive: true,
      containsSynthetic: false,
      liveSnapshots: live,
      syntheticSnapshots: 0,
      usableForRealMarketReplay: true,
      statement: "Live-only observations. Contains no synthetic data.",
    };
  }

  if (live === 0) {
    return {
      classification: DATASET_CLASS.SYNTHETIC_ONLY,
      containsLive: false,
      containsSynthetic: true,
      liveSnapshots: live,
      syntheticSnapshots: synthetic,
      usableForRealMarketReplay: false,
      statement: "Synthetic-only observations. NOT real Solana market history.",
    };
  }

  return {
    classification: DATASET_CLASS.MIXED,
    containsLive: true,
    containsSynthetic: true,
    liveSnapshots: live,
    syntheticSnapshots: synthetic,
    usableForRealMarketReplay: false,
    statement:
      "MIXED observations (live and synthetic in the same session). Results must not be presented as real-market evidence.",
  };
}

/** Interval statistics between consecutive snapshot timestamps. */
export function summarizeIntervals(timestamps) {
  if (!Array.isArray(timestamps) || timestamps.length < 2) {
    return { count: 0, minMs: null, maxMs: null, meanMs: null, medianMs: null };
  }

  const deltas = [];
  for (let index = 1; index < timestamps.length; index += 1) {
    const delta = timestamps[index] - timestamps[index - 1];
    if (Number.isFinite(delta) && delta >= 0) deltas.push(delta);
  }

  if (deltas.length === 0) {
    return { count: 0, minMs: null, maxMs: null, meanMs: null, medianMs: null };
  }

  const sorted = [...deltas].sort((a, b) => a - b);
  const sum = deltas.reduce((total, value) => total + value, 0);

  return {
    count: deltas.length,
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    meanMs: sum / deltas.length,
    medianMs: sorted[Math.floor(sorted.length / 2)],
  };
}

/** Assemble the finalized manifest for a recording session. */
export function buildManifest({
  datasetId,
  status,
  createdAt,
  endedAt,
  source,
  requestedMode,
  effectiveMode,
  captureMs,
  engineVersion,
  gitCommit,
  snapshots,
  mints,
  events,
  feedErrors,
  rateLimits,
  stalePeriods,
  fingerprint,
  extra = {},
}) {
  const timestamps = snapshots.map((snapshot) => snapshot.t).filter(Number.isFinite);
  const classification = classifySnapshots(snapshots.map((snapshot) => snapshot.mode));

  return {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    datasetId,
    status,
    createdAt,
    endedAt: endedAt ?? null,
    source,
    requestedMode,
    effectiveMode,
    captureMs,
    engineVersion: engineVersion ?? null,
    gitCommit: gitCommit ?? null,

    snapshotCount: snapshots.length,
    eventCount: events.length,
    uniqueMintCount: mints.size,
    totalTokenObservations: snapshots.reduce((sum, snapshot) => sum + (snapshot.count ?? 0), 0),
    firstObservedAt: timestamps.length > 0 ? timestamps[0] : null,
    lastObservedAt: timestamps.length > 0 ? timestamps[timestamps.length - 1] : null,
    durationMs:
      timestamps.length > 1 ? timestamps[timestamps.length - 1] - timestamps[0] : 0,
    snapshotInterval: summarizeIntervals(timestamps),

    feedErrors,
    rateLimits,
    stalePeriods,

    dataClass: classification.classification,
    containsLive: classification.containsLive,
    containsSynthetic: classification.containsSynthetic,
    liveSnapshots: classification.liveSnapshots,
    syntheticSnapshots: classification.syntheticSnapshots,
    usableForRealMarketReplay: classification.usableForRealMarketReplay,
    dataClassStatement: classification.statement,

    featureSchema: [...FEATURE_KEYS],
    rowFields: [...ROW_FIELDS],
    fingerprint: fingerprint ?? null,
    secretsStored: false,
    credentialFields: [],
    paperOnly: true,
    ...extra,
  };
}
