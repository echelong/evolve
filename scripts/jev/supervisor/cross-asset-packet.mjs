/**
 * Phase 5I-PS.2d — genuineness validation, generic asset identity, the
 * versioned cross-asset packet, and the COMPLETE model-visible input digest.
 *
 * Pure and synchronous. Called from the observer's passive tap on facts the
 * engine already COPIED; it never receives an engine reference and never
 * returns anything the engine reads.
 *
 * The PS.2a dedup bug proved partial-state digests are unsafe, so the digest
 * here covers the complete payload the provider receives (packet + questions)
 * plus the pinned provider/model identity, with no volatile-field exclusion.
 *
 * PAPER ONLY / SHADOW ONLY / DEVELOPMENT EVIDENCE ONLY.
 */

import { digestOf } from "../../lib/hash.mjs";
import { isPlainObject } from "../../lib/sanitize.mjs";
import { auditJevDecisionPacket } from "../decision-packet.mjs";
import {
  PS2D_COUNTERFACTUAL_KEY_PATTERN,
  PS2D_EVIDENCE_CLASSIFICATION,
  PS2D_FEATURE_KEYS,
  PS2D_FORBIDDEN_PACKET_KEY_PATTERN,
  PS2D_MAX_SYMBOL_LENGTH,
  PS2D_MINT_PATTERN,
  PS2D_NULLABLE_FEATURE_KEYS,
  PS2D_PACKET_KIND,
  PS2D_PACKET_LIMITATIONS,
  PS2D_PACKET_VERSION,
  PS2D_PRODUCTION_ACTION,
  PS2D_PRODUCTION_SELECTION,
  PS2D_PRODUCTION_SOURCE,
  PS2D_PROTOCOL_ID,
  PS2D_QUOTE_NUMERAIRE_MINT,
} from "./cross-asset-protocol.mjs";
import { deepFreeze } from "./tap.mjs";

export const PS2D_PACKET_MODULE_VERSION = 1;

function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

/* ============================================================================
 * Genuineness (production semantics, never counterfactual)
 * ==========================================================================*/

/** True when any key (bounded depth) looks like PS.2c counterfactual data. */
export function carriesCounterfactualData(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => carriesCounterfactualData(entry, depth + 1));
  if (value.kind === "age_counterfactual") return true;
  for (const [key, entry] of Object.entries(value)) {
    if (PS2D_COUNTERFACTUAL_KEY_PATTERN.test(key)) return true;
    if (carriesCounterfactualData(entry, depth + 1)) return true;
  }
  return false;
}

/**
 * Is this tap fact a GENUINE production entry opportunity? Checked in the
 * frozen `PS2D_NON_GENUINE_REASONS` order; the first failure is the reason.
 *
 * @returns {{ genuine: boolean, reason: string|null }}
 */
export function validateGenuineProductionEntry(facts) {
  if (!isPlainObject(facts)) return { genuine: false, reason: "malformed_facts" };
  if (facts.factCopyFailed === true) return { genuine: false, reason: "fact_copy_failed" };
  if (carriesCounterfactualData(facts)) return { genuine: false, reason: "counterfactual_input_rejected" };
  if (facts.source !== PS2D_PRODUCTION_SOURCE) return { genuine: false, reason: "not_production_source" };
  if (facts.action !== PS2D_PRODUCTION_ACTION) return { genuine: false, reason: "not_entry_action" };
  if (facts.selection !== PS2D_PRODUCTION_SELECTION) return { genuine: false, reason: "not_production_selection" };
  const gates = facts.gateAssessment;
  if (
    !isPlainObject(gates) ||
    gates.passes !== true ||
    !Array.isArray(gates.failedGates) ||
    gates.failedGates.length !== 0
  ) {
    return { genuine: false, reason: "production_gates_failed" };
  }
  const score = facts.productionScore;
  const threshold = facts.entryScoreThreshold;
  if (typeof score !== "number" || !Number.isFinite(score) || typeof threshold !== "number" || !Number.isFinite(threshold)) {
    return { genuine: false, reason: "non_finite_score_or_threshold" };
  }
  // The unchanged production entry test is `>=`; equality is actionable.
  if (!(score >= threshold)) return { genuine: false, reason: "below_entry_threshold" };
  if (!isPlainObject(facts.market)) return { genuine: false, reason: "missing_market" };
  return { genuine: true, reason: null };
}

/* ============================================================================
 * Generic identity (mint-authoritative; symbol descriptive only)
 * ==========================================================================*/

/** Descriptive symbol: bounded, control characters removed, never identity. */
export function descriptiveSymbolOf(symbol) {
  if (typeof symbol !== "string") return null;
  const cleaned = [...symbol]
    .filter((char) => char.charCodeAt(0) > 0x1f && char.charCodeAt(0) !== 0x7f)
    .join("")
    .trim()
    .slice(0, PS2D_MAX_SYMBOL_LENGTH);
  return cleaned.length > 0 ? cleaned : null;
}

export function crossAssetMarketIdFor(baseMint, quoteMint = PS2D_QUOTE_NUMERAIRE_MINT) {
  return `${baseMint}/${quoteMint}`;
}

/**
 * @returns {{ ok: boolean, reason: string|null, marketId: string|null, baseMint: string|null,
 *   quoteMint: string, symbol: string|null }}
 */
export function crossAssetIdentityOf(market) {
  const baseMint = typeof market?.mint === "string" ? market.mint : null;
  const symbol = descriptiveSymbolOf(market?.symbol);
  if (baseMint === null || !PS2D_MINT_PATTERN.test(baseMint)) {
    return { ok: false, reason: "invalid_base_mint", marketId: null, baseMint: null, quoteMint: PS2D_QUOTE_NUMERAIRE_MINT, symbol };
  }
  const identity = {
    ok: true,
    reason: null,
    marketId: crossAssetMarketIdFor(baseMint),
    baseMint,
    quoteMint: PS2D_QUOTE_NUMERAIRE_MINT,
    symbol,
  };
  if (baseMint === PS2D_QUOTE_NUMERAIRE_MINT) return { ...identity, ok: false, reason: "base_equals_quote_numeraire" };
  return identity;
}

/* ============================================================================
 * Packet audit + value-domain validation
 * ==========================================================================*/

/** Only null, booleans, finite numbers, strings, arrays and plain objects. */
export function packetValueProblems(value, trail = "packet", problems = []) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return problems;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) problems.push(`${trail}: non-finite number`);
    return problems;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => packetValueProblems(entry, `${trail}[${index}]`, problems));
    return problems;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) packetValueProblems(entry, `${trail}.${key}`, problems);
    return problems;
  }
  problems.push(`${trail}: unsupported ${typeof value} value`);
  return problems;
}

/** Existing Jev decision-packet audit + the PS.2d outcome/counterfactual key audit. */
export function auditCrossAssetPacket(packet) {
  const violations = [...auditJevDecisionPacket(packet).violations];
  const walk = (value, trail) => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${trail}[${index}]`));
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      if (PS2D_FORBIDDEN_PACKET_KEY_PATTERN.test(key)) {
        violations.push({ path: `${trail}.${key}`, kind: "key", detail: "forbidden PS.2d packet field" });
      }
      walk(entry, `${trail}.${key}`);
    }
  };
  walk(packet, "packet");
  for (const problem of packetValueProblems(packet)) violations.push({ path: problem, kind: "value", detail: "value domain" });
  return { ok: violations.length === 0, violations };
}

/* ============================================================================
 * Packet construction (schema order is frozen in the protocol module)
 * ==========================================================================*/

function featuresOf(features) {
  const out = {};
  for (const name of PS2D_FEATURE_KEYS) {
    const value = features?.[name];
    if (PS2D_NULLABLE_FEATURE_KEYS.includes(name) && (value === null || value === undefined)) {
      out[name] = null;
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    out[name] = value;
  }
  return out;
}

function ineligible(reason, identity) {
  return { ok: false, reason, identity: identity?.marketId ? identity : null, packet: null };
}

/**
 * Build the frozen model-visible packet from copied tap facts. Only genuine
 * facts may be passed (the caller validates genuineness first).
 *
 * @returns {{ ok: boolean, reason: string|null, identity: object|null, packet: object|null }}
 */
export function buildCrossAssetPacket(facts) {
  const market = facts?.market ?? null;
  const identity = crossAssetIdentityOf(market);
  if (!identity.ok) return ineligible(identity.reason, identity);
  try {
    if (market.synthetic === true) return ineligible("synthetic_market", identity);
    if (market.fresh !== true) return ineligible("market_not_fresh", identity);
    const referencePriceUsd = finiteOrNull(market.price);
    if (referencePriceUsd === null || !(referencePriceUsd > 0)) return ineligible("invalid_reference_price", identity);
    const liquidityUsd = finiteOrNull(market.liquidity);
    if (liquidityUsd === null || !(liquidityUsd > 0)) return ineligible("invalid_liquidity", identity);
    const proposalAtMs = finiteOrNull(facts.at);
    if (proposalAtMs === null) return ineligible("invalid_proposal_time", identity);
    const observedAtMs = finiteOrNull(market.lastObservedAt);
    if (observedAtMs === null) return ineligible("missing_market_observed_at", identity);
    // No lookahead: a market state stamped after the proposal can never be sent.
    if (observedAtMs > proposalAtMs) return ineligible("observed_after_proposal", identity);
    const agentId = typeof facts.agentId === "string" && facts.agentId.length > 0 ? facts.agentId.slice(0, 64) : null;
    const species = typeof facts.species === "string" && facts.species.length > 0 ? facts.species.slice(0, 64) : null;
    const generation = Number.isInteger(facts.generation) && facts.generation >= 0 ? facts.generation : null;
    const generationTick = Number.isInteger(facts.generationTick) && facts.generationTick >= 0 ? facts.generationTick : null;
    if (agentId === null || species === null || generation === null || generationTick === null) {
      return ineligible("missing_agent_identity", identity);
    }
    const features = featuresOf(market.features);
    if (features === null) return ineligible("non_finite_feature", identity);
    const eligibleMarketCount = Number.isInteger(facts.eligibleMarketCount) ? facts.eligibleMarketCount : null;
    const tradeableMarketCount = Number.isInteger(facts.tradeableMarketCount) ? facts.tradeableMarketCount : null;

    const packet = {
      packetVersion: PS2D_PACKET_VERSION,
      packetKind: PS2D_PACKET_KIND,
      protocolId: PS2D_PROTOCOL_ID,
      evidenceClassification: PS2D_EVIDENCE_CLASSIFICATION,
      proposal: {
        action: PS2D_PRODUCTION_ACTION,
        source: PS2D_PRODUCTION_SOURCE,
        selection: PS2D_PRODUCTION_SELECTION,
        proposalAt: iso(proposalAtMs),
        generation,
        generationTick,
        agentId,
        species,
      },
      market: {
        marketId: identity.marketId,
        baseMint: identity.baseMint,
        quoteMint: identity.quoteMint,
        symbol: identity.symbol,
        referencePriceUsd,
        liquidityUsd,
        poolAgeMs: finiteOrNull(market.poolAgeMs),
        marketObservedAt: iso(observedAtMs),
        marketStateAgeMs: proposalAtMs - observedAtMs,
        priceChangePct: finiteOrNull(market.changePct),
        volume5mUsd: finiteOrNull(market.volume5m),
        buySellRatio: finiteOrNull(market.buySellRatio),
        organicBuySellRatio: finiteOrNull(market.organicBuySellRatio),
        holderCount: finiteOrNull(market.holderCount),
        topHoldersPercentage: finiteOrNull(market.topHoldersPercentage),
        verified: market.verified === true,
        mintAuthorityDisabled: market.mintAuthorityDisabled === true,
        freezeAuthorityDisabled: market.freezeAuthorityDisabled === true,
      },
      production: {
        productionScore: facts.productionScore,
        entryScoreThreshold: facts.entryScoreThreshold,
        scoreMargin: facts.productionScore - facts.entryScoreThreshold,
        thresholdComparison: ">=",
        // Copied from the engine's own assessment (genuineness already required
        // it to pass with no failures), never asserted by the observer.
        gates: { allPassed: facts.gateAssessment.passes === true, failedGates: [...facts.gateAssessment.failedGates] },
        eligibleMarketCount,
        tradeableMarketCount,
        engineRegime: typeof facts.engineRegime === "string" ? facts.engineRegime.slice(0, 32) : null,
        features,
      },
      limitations: [...PS2D_PACKET_LIMITATIONS],
    };

    const audit = auditCrossAssetPacket(packet);
    if (!audit.ok) return ineligible("packet_audit_failed", identity);
    return { ok: true, reason: null, identity, packet: deepFreeze(packet) };
  } catch {
    return ineligible("packet_build_error", identity);
  }
}

/* ============================================================================
 * Complete model-visible input + digest
 * ==========================================================================*/

/** The COMPLETE input identity: everything the provider receives plus pins. */
export function crossAssetCompleteInput({ provider, model, questionSetId, questionSetVersion, questions, packet }) {
  return {
    provider: provider ?? null,
    model: model ?? null,
    questionSetId: questionSetId ?? null,
    questionSetVersion: questionSetVersion ?? null,
    questions: questions ?? null,
    packet: packet ?? null,
  };
}

export function crossAssetInputDigestOf(completeInput) {
  return digestOf(completeInput ?? null);
}
