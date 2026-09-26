/**
 * Phase 5I-PS.2e — PRECOMMITTED temporal admission scheduler + accounting.
 *
 * Pure, synchronous and allocation-bounded. A decision depends ONLY on:
 *
 *   - the engine encounter order in which schema-eligible opportunities arrive,
 *   - the asset identity (mint-derived; `baseMint` is the authoritative key),
 *   - the per-opportunity content digest,
 *   - the opportunity's OWN engine proposal time,
 *   - the frozen window start and the frozen constants in `local-tev-protocol.mjs`.
 *
 * There is no randomness, no wall clock read inside a decision, and no score-,
 * performance-, outcome-, prior-decision-, confidence-, logit-, latency- or
 * market-direction-dependent input.
 *
 * Precedence (first match wins, frozen):
 *   outside window → duplicate opportunity digest → per-asset cap →
 *   per-asset cooldown → bucket cap → global cap → ADMIT
 *
 * A bucket can NEVER be filled from another bucket: an opportunity belongs to
 * exactly the bucket that contains its own `proposalAt`, and unused quota is
 * never moved forward or backward.
 *
 * PAPER ONLY / SHADOW ONLY / DEVELOPMENT EVIDENCE ONLY. ZERO AUTHORITY.
 */

import { digestOf } from "../../lib/hash.mjs";
import {
  PS2E_BUCKET_COUNT,
  PS2E_MAX_PERSISTED_ASSET_ROWS,
  PS2E_MAX_TRACKED_ASSETS,
  PS2E_PER_ASSET_MAX_ADMISSIONS_PER_RUN,
  PS2E_PER_ASSET_MIN_SPACING_MS,
  PS2E_SCHEDULER_RULE,
  PS2E_SUPPRESSION_PRECEDENCE,
  PS2E_SUPPRESSION_REASONS,
} from "./local-tev-protocol.mjs";

export const PS2E_SCHEDULER_VERSION = 1;
export const PS2E_MAX_SYMBOL_VARIANTS = 4;

/** Result counters, applied identically to asset rows and bucket rows. */
export const PS2E_RESULT_COUNTER_KEYS = Object.freeze([
  "logicalCalls",
  "primaryResults",
  "escalatedResults",
  "fallbackResults",
  "abstainResults",
  "failures",
  "malformed",
  "unavailable",
  "unsentAtFinalize",
  "inFlightAtFinalize",
]);

/** Per-asset counters (also the shape of every aggregate row). */
export const PS2E_ASSET_COUNTER_KEYS = Object.freeze([
  "productionOpportunities",
  "schemaEligible",
  "schemaIneligible",
  "suppressedOutsideWindow",
  "suppressedDuplicateOpportunityDigest",
  "suppressedPerAssetCap",
  "suppressedAssetCooldown",
  "suppressedBucketCap",
  "suppressedGlobalCap",
  "admitted",
  "queued",
  "queueDropped",
  ...PS2E_RESULT_COUNTER_KEYS,
]);

/** Per-bucket counters. */
export const PS2E_BUCKET_COUNTER_KEYS = Object.freeze([
  "eligibleOpportunities",
  "admitted",
  "suppressedOutsideWindow",
  "suppressedDuplicateOpportunityDigest",
  "suppressedPerAssetCap",
  "suppressedAssetCooldown",
  "suppressedBucketCap",
  "suppressedGlobalCap",
  ...PS2E_RESULT_COUNTER_KEYS,
]);

/** Downstream dispositions the observer reports back. */
export const PS2E_DISPOSITION_KEYS = Object.freeze([
  "queued",
  "queueDropped",
  "logicalCalls",
  "primaryResults",
  "escalatedResults",
  "fallbackResults",
  "abstainResults",
  "failures",
  "malformed",
  "unavailable",
  "unsentAtFinalize",
  "inFlightAtFinalize",
]);

/** The suppression reason -> per-asset / per-bucket counter key. */
const SUPPRESSION_COUNTER_KEY = Object.freeze({
  [PS2E_SUPPRESSION_REASONS.OUTSIDE_WINDOW]: "suppressedOutsideWindow",
  [PS2E_SUPPRESSION_REASONS.DUPLICATE_DIGEST]: "suppressedDuplicateOpportunityDigest",
  [PS2E_SUPPRESSION_REASONS.PER_ASSET_CAP]: "suppressedPerAssetCap",
  [PS2E_SUPPRESSION_REASONS.ASSET_COOLDOWN]: "suppressedAssetCooldown",
  [PS2E_SUPPRESSION_REASONS.BUCKET_CAP]: "suppressedBucketCap",
  [PS2E_SUPPRESSION_REASONS.GLOBAL_CAP]: "suppressedGlobalCap",
});

function zeroCounters(keys) {
  return Object.fromEntries(keys.map((name) => [name, 0]));
}

function isoOrNull(ms) {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function boundedSet(values, limit) {
  const out = [];
  for (const value of values) {
    if (out.length >= limit) break;
    out.push(value);
  }
  return out.sort();
}

/**
 * @param {{ profile: object, runStartedAtMs?: number, perAssetMax?: number,
 *   spacingMs?: number, maxTrackedAssets?: number, maxPersistedRows?: number }} options
 */
export function createLocalTevScheduler({
  profile,
  runStartedAtMs = null,
  perAssetMax = PS2E_PER_ASSET_MAX_ADMISSIONS_PER_RUN,
  spacingMs = PS2E_PER_ASSET_MIN_SPACING_MS,
  maxTrackedAssets = PS2E_MAX_TRACKED_ASSETS,
  maxPersistedRows = PS2E_MAX_PERSISTED_ASSET_ROWS,
} = {}) {
  if (!profile || !Number.isInteger(profile.globalMaxAdmissions) || profile.globalMaxAdmissions <= 0) {
    throw new Error("a frozen PS.2e profile with a positive integer admission ceiling is required");
  }
  if (profile.bucketCount !== PS2E_BUCKET_COUNT) {
    throw new Error(`the frozen PS.2e schedule is ${PS2E_BUCKET_COUNT} buckets; refusing '${profile.bucketCount}'`);
  }

  const globalMax = profile.globalMaxAdmissions;
  const bucketCount = profile.bucketCount;
  const bucketMs = profile.bucketMs;
  const perBucketMax = profile.perBucketMaxAdmissions;
  const windowMs = profile.runWindowMs;

  const counters = {
    productionEntryFactsReceived: 0,
    nonGenuineRejected: 0,
    genuineProductionOpportunitiesObserved: 0,
    schemaEligible: 0,
    schemaIneligible: 0,
    schemaIneligibleWithoutIdentity: 0,
    suppressedOutsideWindow: 0,
    suppressedDuplicateOpportunityDigest: 0,
    suppressedPerAssetCap: 0,
    suppressedAssetCooldown: 0,
    suppressedBucketCap: 0,
    suppressedGlobalCap: 0,
    admitted: 0,
  };

  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    bucketIndex: index,
    startMs: Number.isFinite(runStartedAtMs) ? runStartedAtMs + index * bucketMs : null,
    endMs: Number.isFinite(runStartedAtMs) ? runStartedAtMs + (index + 1) * bucketMs : null,
    assetKeys: new Set(),
    ...zeroCounters(PS2E_BUCKET_COUNTER_KEYS),
  }));

  const rows = new Map();
  const overflow = { ...zeroCounters(PS2E_ASSET_COUNTER_KEYS), assetEncounters: 0 };
  let overflowActive = false;
  const admission = new Map();
  const admittedDigests = new Set();

  /** Admitted-observation diagnostics for the temporal coverage report. */
  const admitted = {
    firstProposalAtMs: null,
    lastProposalAtMs: null,
    minGeneration: null,
    maxGeneration: null,
    minGenerationTick: null,
    maxGenerationTick: null,
    minEngineTick: null,
    maxEngineTick: null,
    minOpportunitySequence: null,
    maxOpportunitySequence: null,
    within10s: 0,
    within30s: 0,
    within60s: 0,
    within300s: 0,
    assetKeySet: new Set(),
  };
  const assetKeySetTruncated = { value: false };
  const MAX_UNIQUE_ADMITTED_ASSETS = 4_096;

  function noteRange(name, value) {
    if (!Number.isInteger(value) || value < 0) return;
    admitted[name] = admitted[name] === null ? value : Math.min(admitted[name], value);
    const maxName = `max${name.slice(3)}`;
    admitted[maxName] = admitted[maxName] === null ? value : Math.max(admitted[maxName], value);
  }

  function rowFor(identity, atMs) {
    const key = identity.baseMint ?? identity.marketId;
    const existing = rows.get(key);
    if (existing !== undefined) {
      if (identity.symbol !== null && !existing.symbolVariants.includes(identity.symbol)) {
        if (existing.symbolVariants.length < PS2E_MAX_SYMBOL_VARIANTS) existing.symbolVariants.push(identity.symbol);
        else existing.symbolVariantsTruncated = true;
      }
      return existing;
    }
    if (rows.size >= maxTrackedAssets) {
      overflowActive = true;
      overflow.assetEncounters += 1;
      return overflow;
    }
    const row = {
      ordinal: rows.size + 1,
      assetKey: key,
      baseMint: identity.baseMint ?? null,
      quoteMint: identity.quoteMint ?? null,
      marketId: identity.marketId ?? null,
      symbol: identity.symbol,
      symbolVariants: identity.symbol === null ? [] : [identity.symbol],
      symbolVariantsTruncated: false,
      firstSeenAt: isoOrNull(atMs),
      lastAdmittedAt: null,
      ...zeroCounters(PS2E_ASSET_COUNTER_KEYS),
    };
    rows.set(key, row);
    return row;
  }

  /** A bucket never owns an opportunity from outside the frozen window. */
  function bucketIndexOf(atMs) {
    if (!Number.isFinite(runStartedAtMs) || !Number.isFinite(atMs)) return null;
    const offset = atMs - runStartedAtMs;
    if (offset < 0 || offset >= windowMs) return null;
    const index = Math.floor(offset / bucketMs);
    return index >= 0 && index < bucketCount ? index : null;
  }

  function noteFactReceived() {
    counters.productionEntryFactsReceived += 1;
  }

  function noteNonGenuine() {
    counters.nonGenuineRejected += 1;
  }

  function noteSchemaIneligible({ identity = null, atMs = null } = {}) {
    counters.genuineProductionOpportunitiesObserved += 1;
    counters.schemaIneligible += 1;
    if (!identity || typeof identity.marketId !== "string") {
      counters.schemaIneligibleWithoutIdentity += 1;
      return null;
    }
    const row = rowFor(identity, atMs);
    row.productionOpportunities += 1;
    row.schemaIneligible += 1;
    return row;
  }

  /**
   * THE deterministic admission decision for one schema-eligible opportunity.
   *
   * @returns {{ admitted: boolean, reason: string|null, bucketIndex: number|null,
   *   bucketAdmissionIndex: number|null, globalAdmissionIndex: number|null }}
   */
  function decide({ identity, opportunityDigest, atMs }) {
    counters.genuineProductionOpportunitiesObserved += 1;
    counters.schemaEligible += 1;
    const row = rowFor(identity, atMs);
    row.productionOpportunities += 1;
    row.schemaEligible += 1;

    const bucketIndex = bucketIndexOf(atMs);
    const bucket = bucketIndex === null ? null : buckets[bucketIndex];
    if (bucket !== null) bucket.eligibleOpportunities += 1;

    const state = admission.get(identity.baseMint ?? identity.marketId) ?? null;
    let reason = null;
    if (bucket === null) reason = PS2E_SUPPRESSION_REASONS.OUTSIDE_WINDOW;
    else if (admittedDigests.has(opportunityDigest)) reason = PS2E_SUPPRESSION_REASONS.DUPLICATE_DIGEST;
    else if (state !== null && state.count >= perAssetMax) reason = PS2E_SUPPRESSION_REASONS.PER_ASSET_CAP;
    else if (state !== null && atMs - state.lastAdmittedAtMs < spacingMs) {
      reason = PS2E_SUPPRESSION_REASONS.ASSET_COOLDOWN;
    } else if (bucket.admitted >= perBucketMax) reason = PS2E_SUPPRESSION_REASONS.BUCKET_CAP;
    else if (counters.admitted >= globalMax) reason = PS2E_SUPPRESSION_REASONS.GLOBAL_CAP;

    if (reason !== null) {
      const key = SUPPRESSION_COUNTER_KEY[reason];
      counters[key] += 1;
      row[key] += 1;
      if (bucket !== null) bucket[key] += 1;
      return { admitted: false, reason, bucketIndex, bucketAdmissionIndex: null, globalAdmissionIndex: null };
    }

    counters.admitted += 1;
    const assetKey = identity.baseMint ?? identity.marketId;
    admittedDigests.add(opportunityDigest);
    admission.set(assetKey, { count: (state?.count ?? 0) + 1, lastAdmittedAtMs: atMs });
    row.admitted += 1;
    if (row !== overflow) row.lastAdmittedAt = isoOrNull(atMs);
    bucket.admitted += 1;
    bucket.assetKeys.add(assetKey);
    if (!admitted.assetKeySet.has(assetKey) && admitted.assetKeySet.size < MAX_UNIQUE_ADMITTED_ASSETS) {
      admitted.assetKeySet.add(assetKey);
    } else if (!admitted.assetKeySet.has(assetKey)) {
      assetKeySetTruncated.value = true;
    }
    return {
      admitted: true,
      reason: null,
      bucketIndex,
      bucketAdmissionIndex: bucket.admitted,
      globalAdmissionIndex: counters.admitted,
    };
  }

  /** Admitted-observation provenance for the temporal coverage report. */
  function noteAdmissionProvenance({ atMs, generation = null, generationTick = null, engineTick = null, opportunitySequence = null }) {
    if (admitted.firstProposalAtMs === null || atMs < admitted.firstProposalAtMs) admitted.firstProposalAtMs = atMs;
    if (admitted.lastProposalAtMs === null || atMs > admitted.lastProposalAtMs) admitted.lastProposalAtMs = atMs;
    noteRange("minGeneration", Number.isInteger(generation) ? generation : null);
    noteRange("minGenerationTick", Number.isInteger(generationTick) ? generationTick : null);
    noteRange("minEngineTick", Number.isInteger(engineTick) ? engineTick : null);
    noteRange("minOpportunitySequence", Number.isInteger(opportunitySequence) ? opportunitySequence : null);
    if (!Number.isFinite(runStartedAtMs)) return;
    const offset = atMs - runStartedAtMs;
    if (offset <= 10_000) admitted.within10s += 1;
    if (offset <= 30_000) admitted.within30s += 1;
    if (offset <= 60_000) admitted.within60s += 1;
    if (offset <= 300_000) admitted.within300s += 1;
  }

  /** Downstream per-asset and per-bucket disposition of an admitted item. */
  function noteDisposition({ baseMint = null, bucketIndex = null, disposition, count = 1 }) {
    if (!PS2E_DISPOSITION_KEYS.includes(disposition)) return;
    const row = baseMint !== null ? rows.get(baseMint) ?? (overflowActive ? overflow : null) : null;
    if (row !== null) row[disposition] += count;
    const bucket = Number.isInteger(bucketIndex) && bucketIndex >= 0 && bucketIndex < bucketCount ? buckets[bucketIndex] : null;
    if (bucket !== null) bucket[disposition] += count;
  }

  function sumCounters(list, keys) {
    const total = zeroCounters(keys);
    for (const row of list) for (const name of keys) total[name] += row[name];
    return total;
  }

  function copyRow(row) {
    return { ...row, symbolVariants: [...row.symbolVariants] };
  }

  function bucketRows() {
    return buckets.map((bucket) => {
      const row = { ...bucket };
      delete row.assetKeys;
      return {
        ...row,
        start: isoOrNull(bucket.startMs),
        end: isoOrNull(bucket.endMs),
        uniqueAssets: bucket.assetKeys.size,
        assetKeysSample: boundedSet(bucket.assetKeys, 8),
        reachedCap: bucket.admitted >= perBucketMax,
        empty: bucket.admitted === 0,
      };
    });
  }

  /** Bounded, deterministic, JSON-safe snapshot. Rows stay in encounter order. */
  function snapshot({ maxRows = maxPersistedRows } = {}) {
    const allRows = [...rows.values()].map(copyRow);
    const rowLimit = Number.isInteger(maxRows) && maxRows >= 0 ? Math.min(maxRows, maxPersistedRows) : maxPersistedRows;
    const stored = allRows.slice(0, rowLimit);
    const truncated = allRows.slice(rowLimit);
    const overflowCopy = { ...overflow };
    return {
      schedulerVersion: PS2E_SCHEDULER_VERSION,
      profile: profile.profile,
      runStartedAtMs,
      runStartedAt: isoOrNull(runStartedAtMs),
      runWindowMs: windowMs,
      bucketCount,
      bucketMs,
      perBucketMaxAdmissions: perBucketMax,
      globalMaxAdmissions: globalMax,
      perAssetMaxAdmissionsPerRun: perAssetMax,
      perAssetMinSpacingMs: spacingMs,
      schedulerRule: PS2E_SCHEDULER_RULE,
      suppressionPrecedence: [...PS2E_SUPPRESSION_PRECEDENCE],
      counters: {
        ...counters,
        callsEligibleBeforeBounds: counters.schemaEligible,
        uniqueAssetsObserved: rows.size + (overflowActive ? overflow.assetEncounters : 0),
        uniqueAssetsObservedIsUpperBound: overflowActive,
      },
      assetRowKey: "baseMint",
      assetRowOrder: "ENCOUNTER_ORDER_NOT_RANKED",
      totalAssetCount: rows.size,
      rowsStored: stored.length,
      rowsTruncated: truncated.length,
      assetRows: stored,
      truncatedRowsAggregate: sumCounters(truncated, PS2E_ASSET_COUNTER_KEYS),
      overflowActive,
      overflowAggregate: overflowCopy,
      aggregateDigest: digestOf({ rows: allRows, overflow: overflowCopy, buckets: bucketRows() }),
    };
  }

  /**
   * TEMPORAL COVERAGE REPORT — a first-class description of where in the frozen
   * 60-minute window the admissions actually happened. It never claims temporal
   * representativeness.
   */
  function temporalReport() {
    const admittedCount = counters.admitted;
    const share = (value) => (admittedCount > 0 ? Number((value / admittedCount).toFixed(6)) : null);
    const rows = bucketRows();
    const spanSeconds =
      admitted.firstProposalAtMs !== null && admitted.lastProposalAtMs !== null
        ? Number(((admitted.lastProposalAtMs - admitted.firstProposalAtMs) / 1000).toFixed(3))
        : null;
    return {
      runStartedAt: isoOrNull(runStartedAtMs),
      runWindowEnd: Number.isFinite(runStartedAtMs) ? isoOrNull(runStartedAtMs + windowMs) : null,
      bucketCount,
      bucketMs,
      bucketMinutes: bucketMs / 60_000,
      perBucketMaxAdmissions: perBucketMax,
      globalMaxAdmissions: globalMax,
      firstAdmittedProposalAt: isoOrNull(admitted.firstProposalAtMs),
      lastAdmittedProposalAt: isoOrNull(admitted.lastProposalAtMs),
      admissionSpanMs:
        admitted.firstProposalAtMs !== null && admitted.lastProposalAtMs !== null
          ? admitted.lastProposalAtMs - admitted.firstProposalAtMs
          : null,
      admissionSpanSeconds: spanSeconds,
      generationRange: { min: admitted.minGeneration, max: admitted.maxGeneration },
      generationTickRange: { min: admitted.minGenerationTick, max: admitted.maxGenerationTick },
      engineTickRange: { min: admitted.minEngineTick, max: admitted.maxEngineTick },
      opportunitySequenceRange: { min: admitted.minOpportunitySequence, max: admitted.maxOpportunitySequence },
      uniqueAdmittedAssets: admitted.assetKeySet.size,
      uniqueAdmittedAssetsIsUpperBound: assetKeySetTruncated.value,
      sharesWithinFirst: {
        admitted: admittedCount,
        within10s: { count: admitted.within10s, share: share(admitted.within10s) },
        within30s: { count: admitted.within30s, share: share(admitted.within30s) },
        within60s: { count: admitted.within60s, share: share(admitted.within60s) },
        within300s: { count: admitted.within300s, share: share(admitted.within300s) },
      },
      occupancy: {
        emptyBuckets: rows.filter((row) => row.empty).length,
        bucketsWithAdmissions: rows.filter((row) => !row.empty).length,
        bucketsAtCap: rows.filter((row) => row.reachedCap).length,
        bucketOccupancy: rows.map((row) => ({ bucketIndex: row.bucketIndex, admitted: row.admitted, cap: perBucketMax })),
      },
      buckets: rows,
      temporallyRepresentative: null,
      representationClaim: "none",
      temporalRepresentativenessClaimed: false,
      predictiveEdgeClaimed: false,
      profitabilityClaimed: false,
    };
  }

  return {
    version: PS2E_SCHEDULER_VERSION,
    profile: profile.profile,
    globalMax,
    perBucketMax,
    bucketCount,
    bucketIndexOf,
    noteFactReceived,
    noteNonGenuine,
    noteSchemaIneligible,
    noteAdmissionProvenance,
    decide,
    noteDisposition,
    snapshot,
    temporalReport,
    get counters() {
      return { ...counters };
    },
    get admittedCount() {
      return counters.admitted;
    },
    get bucketCounters() {
      return buckets.map((bucket) => ({ bucketIndex: bucket.bucketIndex, admitted: bucket.admitted }));
    },
  };
}
