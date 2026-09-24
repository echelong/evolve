/**
 * Phase 5I-PS.2d — deterministic bounded sampler + per-asset accounting.
 *
 * Pure, synchronous and allocation-bounded. Decisions depend ONLY on:
 *
 *   - the engine encounter order in which schema-eligible opportunities arrive,
 *   - the asset identity (mint-derived marketId),
 *   - the complete-input digest,
 *   - the engine proposal time (never the wall clock),
 *   - the frozen constants in `cross-asset-protocol.mjs`.
 *
 * There is no randomness and no score-, performance-, outcome- or Jev-dependent
 * input. Precedence (first match wins): duplicate admitted digest → per-asset
 * cap → per-asset cooldown → global cap → admit. Per-asset state depends only
 * on that asset's OWN admissions, so one asset can suppress another only
 * through the explicit global cap.
 *
 * Accounting keeps EVERY genuine asset (never only the sent ones), in ENCOUNTER
 * order, never ranked. Storage truncation is explicit: counts + digest.
 *
 * PAPER ONLY / SHADOW ONLY / DEVELOPMENT EVIDENCE ONLY.
 */

import { digestOf } from "../../lib/hash.mjs";
import {
  PS2D_MAX_PERSISTED_ASSET_ROWS,
  PS2D_MAX_SYMBOL_VARIANTS,
  PS2D_MAX_TRACKED_ASSETS,
  PS2D_NON_GENUINE_REASONS,
  PS2D_PER_ASSET_MAX_JEV_CALLS_PER_RUN,
  PS2D_PER_ASSET_MIN_SPACING_MS,
  PS2D_SAMPLING_RULE,
  PS2D_SCHEMA_INELIGIBLE_REASONS,
  PS2D_SUPPRESSION_PRECEDENCE,
  PS2D_SUPPRESSION_REASONS,
} from "./cross-asset-protocol.mjs";

export const PS2D_SAMPLER_VERSION = 1;

/** Numeric per-asset counters (also the shape of every aggregate row). */
export const PS2D_ASSET_COUNTER_KEYS = Object.freeze([
  "productionOpportunities",
  "schemaEligible",
  "schemaIneligible",
  "suppressedDuplicateDigest",
  "suppressedPerAssetCap",
  "suppressedAssetCooldown",
  "suppressedGlobalCap",
  "admitted",
  "queued",
  "queueDropped",
  "jevCalls",
  "jevOk",
  "jevFailures",
  "skippedPinMismatch",
  "skippedPolicyInvalid",
  "skippedCircuitOpen",
  "skippedTransportCooldown",
  "unsentAtFinalize",
  "inFlightAtFinalize",
]);

/** Downstream dispositions the observer may report back per admitted item. */
export const PS2D_DISPOSITION_KEYS = Object.freeze([
  "queued",
  "queueDropped",
  "jevCalls",
  "jevOk",
  "jevFailures",
  "skippedPinMismatch",
  "skippedPolicyInvalid",
  "skippedCircuitOpen",
  "skippedTransportCooldown",
  "unsentAtFinalize",
  "inFlightAtFinalize",
]);

function zeroCounters() {
  return Object.fromEntries(PS2D_ASSET_COUNTER_KEYS.map((name) => [name, 0]));
}

function zeroReasons(reasons) {
  return Object.fromEntries(reasons.map((reason) => [reason, 0]));
}

function isoOrNull(ms) {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * @param {{ profile: { profile: string, globalMaxJevCallsPerRun: number },
 *   perAssetMax?: number, spacingMs?: number, maxTrackedAssets?: number, maxPersistedRows?: number }} options
 */
export function createCrossAssetSampler({
  profile,
  perAssetMax = PS2D_PER_ASSET_MAX_JEV_CALLS_PER_RUN,
  spacingMs = PS2D_PER_ASSET_MIN_SPACING_MS,
  maxTrackedAssets = PS2D_MAX_TRACKED_ASSETS,
  maxPersistedRows = PS2D_MAX_PERSISTED_ASSET_ROWS,
} = {}) {
  if (!profile || !Number.isInteger(profile.globalMaxJevCallsPerRun) || profile.globalMaxJevCallsPerRun <= 0) {
    throw new Error("a frozen PS.2d profile with a positive integer global maximum is required");
  }
  const globalMax = profile.globalMaxJevCallsPerRun;

  const counters = {
    productionEntryFactsReceived: 0,
    nonGenuineRejected: 0,
    genuineProductionOpportunitiesObserved: 0,
    schemaEligible: 0,
    schemaIneligible: 0,
    schemaIneligibleWithoutIdentity: 0,
    suppressedDuplicateDigest: 0,
    suppressedAssetCooldown: 0,
    suppressedPerAssetCap: 0,
    suppressedGlobalCap: 0,
    admittedBySampler: 0,
  };
  const nonGenuineReasonCounts = zeroReasons(PS2D_NON_GENUINE_REASONS);
  const schemaIneligibleReasonCounts = zeroReasons(PS2D_SCHEMA_INELIGIBLE_REASONS);

  /** Descriptive rows, insertion (= encounter) order, bounded. */
  const rows = new Map();
  /** Genuine opportunities of assets beyond the tracking ceiling (explicit). */
  const overflow = { ...zeroCounters(), assetEncounters: 0 };
  let overflowActive = false;
  /** Sampler state for ADMITTED assets only (bounded by the global maximum). */
  const admission = new Map();
  /** Admitted complete-input digests (bounded by the global maximum). */
  const admittedDigests = new Set();

  function rowFor(identity, atMs) {
    const existing = rows.get(identity.marketId);
    if (existing !== undefined) {
      if (identity.symbol !== null && !existing.symbolVariants.includes(identity.symbol)) {
        if (existing.symbolVariants.length < PS2D_MAX_SYMBOL_VARIANTS) existing.symbolVariants.push(identity.symbol);
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
      marketId: identity.marketId,
      baseMint: identity.baseMint,
      quoteMint: identity.quoteMint,
      symbol: identity.symbol,
      symbolVariants: identity.symbol === null ? [] : [identity.symbol],
      symbolVariantsTruncated: false,
      firstSeenAt: isoOrNull(atMs),
      lastAdmittedAt: null,
      ...zeroCounters(),
    };
    rows.set(identity.marketId, row);
    return row;
  }

  /** Every tap fact the observer receives, genuine or not. */
  function noteFactReceived() {
    counters.productionEntryFactsReceived += 1;
  }

  function noteNonGenuine(reason) {
    counters.nonGenuineRejected += 1;
    const label = Object.hasOwn(nonGenuineReasonCounts, reason) ? reason : "malformed_facts";
    nonGenuineReasonCounts[label] += 1;
  }

  /** A genuine opportunity that is NOT schema-eligible. */
  function noteSchemaIneligible({ identity = null, reason, atMs = null } = {}) {
    counters.genuineProductionOpportunitiesObserved += 1;
    counters.schemaIneligible += 1;
    const label = Object.hasOwn(schemaIneligibleReasonCounts, reason) ? reason : "packet_build_error";
    schemaIneligibleReasonCounts[label] += 1;
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
   * THE deterministic sampling decision for one schema-eligible opportunity.
   *
   * @returns {{ admitted: boolean, reason: string|null, admissionOrdinal: number|null }}
   */
  function decide({ identity, jevInputDigest, atMs }) {
    counters.genuineProductionOpportunitiesObserved += 1;
    counters.schemaEligible += 1;
    const row = rowFor(identity, atMs);
    row.productionOpportunities += 1;
    row.schemaEligible += 1;

    const state = admission.get(identity.marketId) ?? null;
    let reason = null;
    if (admittedDigests.has(jevInputDigest)) reason = PS2D_SUPPRESSION_REASONS.DUPLICATE_DIGEST;
    else if (state !== null && state.count >= perAssetMax) reason = PS2D_SUPPRESSION_REASONS.PER_ASSET_CAP;
    else if (state !== null && atMs - state.lastAdmittedAtMs < spacingMs) reason = PS2D_SUPPRESSION_REASONS.ASSET_COOLDOWN;
    else if (counters.admittedBySampler >= globalMax) reason = PS2D_SUPPRESSION_REASONS.GLOBAL_CAP;

    if (reason !== null) {
      counters[reason] += 1;
      row[reason] += 1;
      return { admitted: false, reason, admissionOrdinal: null };
    }
    counters.admittedBySampler += 1;
    admittedDigests.add(jevInputDigest);
    admission.set(identity.marketId, { count: (state?.count ?? 0) + 1, lastAdmittedAtMs: atMs });
    row.admitted += 1;
    if (row !== overflow) row.lastAdmittedAt = isoOrNull(atMs);
    return { admitted: true, reason: null, admissionOrdinal: counters.admittedBySampler };
  }

  /** Downstream per-asset disposition of an admitted item (queue / Jev). */
  function noteDisposition(marketId, disposition) {
    if (!PS2D_DISPOSITION_KEYS.includes(disposition)) return;
    const row = rows.get(marketId) ?? (overflowActive ? overflow : null);
    if (row !== null) row[disposition] += 1;
  }

  function sumRows(list) {
    const total = zeroCounters();
    for (const row of list) for (const name of PS2D_ASSET_COUNTER_KEYS) total[name] += row[name];
    return total;
  }

  function copyRow(row) {
    return { ...row, symbolVariants: [...row.symbolVariants] };
  }

  /** Bounded, deterministic, JSON-safe snapshot. Rows stay in encounter order. */
  function snapshot({ maxRows = maxPersistedRows } = {}) {
    const allRows = [...rows.values()].map(copyRow);
    const rowLimit = Number.isInteger(maxRows) && maxRows >= 0 ? Math.min(maxRows, maxPersistedRows) : maxPersistedRows;
    const stored = allRows.slice(0, rowLimit);
    const truncated = allRows.slice(rowLimit);
    const overflowCopy = { ...overflow };
    return {
      samplerVersion: PS2D_SAMPLER_VERSION,
      profile: profile.profile,
      globalMaxJevCallsPerRun: globalMax,
      perAssetMaxJevCallsPerRun: perAssetMax,
      perAssetMinSpacingMs: spacingMs,
      samplingRule: PS2D_SAMPLING_RULE,
      suppressionPrecedence: [...PS2D_SUPPRESSION_PRECEDENCE],
      counters: {
        ...counters,
        callsEligibleBeforeBounds: counters.schemaEligible,
        uniqueAssetsObserved: rows.size + (overflowActive ? overflow.assetEncounters : 0),
        uniqueAssetsObservedIsUpperBound: overflowActive,
      },
      nonGenuineReasonCounts: { ...nonGenuineReasonCounts },
      schemaIneligibleReasonCounts: { ...schemaIneligibleReasonCounts },
      assetRowOrder: "ENCOUNTER_ORDER_NOT_RANKED",
      totalAssetCount: rows.size,
      rowsStored: stored.length,
      rowsTruncated: truncated.length,
      assetRows: stored,
      truncatedRowsAggregate: sumRows(truncated),
      overflowActive,
      overflowAggregate: overflowCopy,
      aggregateDigest: digestOf({ rows: allRows, overflow: overflowCopy }),
    };
  }

  return {
    version: PS2D_SAMPLER_VERSION,
    profile: profile.profile,
    globalMax,
    noteFactReceived,
    noteNonGenuine,
    noteSchemaIneligible,
    decide,
    noteDisposition,
    snapshot,
    get admittedCount() {
      return counters.admittedBySampler;
    },
  };
}
