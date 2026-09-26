/**
 * Phase 5I-PS.2e — opportunity packet, temporal provenance and the COMPLETE
 * model-visible input digest.
 *
 * Pure and synchronous. It runs on facts the engine already COPIED through the
 * unchanged PS.2d passive tap; it never receives an engine reference and never
 * returns anything the engine reads.
 *
 * The genuineness boundary, asset identity, schema eligibility rules and packet
 * VALUE domain are the frozen PS.2d ones, imported unchanged from
 * `cross-asset-packet.mjs`. PS.2e adds ONLY a versioned packet shape (v2), the
 * engine-tick / opportunity-sequence provenance, and the precommitted temporal
 * scheduling block.
 *
 * TWO digests, both deterministic:
 *
 *   opportunityDigest   digest of the packet BEFORE scheduling provenance is
 *                       attached. It is the content key used for duplicate
 *                       suppression and for the within-tick ordering rule, so a
 *                       decision never depends on when a tick is flushed.
 *   jevInputDigest      digest of the COMPLETE model-visible payload: protocol,
 *                       runtime + classifier identity and configuration, routing
 *                       configuration, question set identity, question id and
 *                       text, option ids and descriptions (including the
 *                       reserved ABSTAIN description), allowAbstain, the frozen
 *                       request risk level, the effective sampling settings, the
 *                       specialist classifier configuration sub-block, the
 *                       finalized packet (including temporal provenance) and the
 *                       model-visible limitations.
 *
 * Any model-visible change changes `jevInputDigest`; no volatile receipt field is
 * inside either digest.
 *
 * PAPER ONLY / SHADOW ONLY / DEVELOPMENT EVIDENCE ONLY. ZERO AUTHORITY.
 */

import { canonicalJson, digestOf } from "../../lib/hash.mjs";
import { isPlainObject } from "../../lib/sanitize.mjs";
import {
  auditCrossAssetPacket,
  carriesCounterfactualData,
  crossAssetIdentityOf,
  descriptiveSymbolOf,
  packetValueProblems,
  validateGenuineProductionEntry,
} from "./cross-asset-packet.mjs";
import {
  PS2E_EVIDENCE_CLASSIFICATION,
  PS2E_PACKET_KIND,
  PS2E_PACKET_LIMITATIONS,
  PS2E_PACKET_VERSION,
  PS2E_PROTOCOL_ID,
  PS2E_SUPPRESSION_REASONS,
} from "./local-tev-protocol.mjs";
import { deepFreeze } from "./tap.mjs";

export const PS2E_PACKET_MODULE_VERSION = 1;

/* Re-exported so PS.2e readers import ONE module and so the validator can pin
 * the fact that the boundary is literally the PS.2d implementation. */
export { validateGenuineProductionEntry, carriesCounterfactualData, crossAssetIdentityOf, descriptiveSymbolOf };

/** PS.2d's production feature keys and nullability, reused verbatim. */
export {
  PS2D_FEATURE_KEYS as PS2E_FEATURE_KEYS,
  PS2D_NULLABLE_FEATURE_KEYS as PS2E_NULLABLE_FEATURE_KEYS,
} from "./cross-asset-protocol.mjs";

import { PS2D_FEATURE_KEYS, PS2D_NULLABLE_FEATURE_KEYS } from "./cross-asset-protocol.mjs";

function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

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

/* ============================================================================
 * Packet construction (pre-scheduling)
 * ==========================================================================*/

/**
 * Build the frozen model-visible packet from copied tap facts. Only GENUINE
 * facts may be passed (the caller validates genuineness first). The returned
 * packet carries no scheduling provenance; `attachTemporalProvenance` adds it
 * once the precommitted scheduler has admitted the opportunity.
 *
 * @returns {{ ok: boolean, reason: string|null, identity: object|null, packet: object|null }}
 */
export function buildTevOpportunityPacket(facts) {
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
    // Observer-assigned provenance (the engine exposes generation/generationTick
    // only). Both ordinals are deterministic functions of encounter order, so a
    // missing one is a build failure, never a silently omitted field.
    const engineTick = Number.isInteger(facts.engineTick) && facts.engineTick >= 1 ? facts.engineTick : null;
    const opportunitySequence =
      Number.isInteger(facts.opportunitySequence) && facts.opportunitySequence >= 1 ? facts.opportunitySequence : null;
    if (engineTick === null || opportunitySequence === null) return ineligible("packet_build_error", identity);
    const features = featuresOf(market.features);
    if (features === null) return ineligible("non_finite_feature", identity);
    const eligibleMarketCount = Number.isInteger(facts.eligibleMarketCount) ? facts.eligibleMarketCount : null;
    const tradeableMarketCount = Number.isInteger(facts.tradeableMarketCount) ? facts.tradeableMarketCount : null;

    const packet = {
      packetVersion: PS2E_PACKET_VERSION,
      packetKind: PS2E_PACKET_KIND,
      protocolId: PS2E_PROTOCOL_ID,
      evidenceClassification: PS2E_EVIDENCE_CLASSIFICATION,
      proposal: {
        action: "ENTER_LONG",
        source: "PRODUCTION_ENTRY_PROPOSAL",
        selection: "PRODUCTION_BEST_SCORE",
        proposalAt: iso(proposalAtMs),
        generation,
        generationTick,
        engineTick,
        opportunitySequence,
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
        gates: {
          allPassed: facts.gateAssessment.passes === true,
          failedGates: [...facts.gateAssessment.failedGates],
        },
        eligibleMarketCount,
        tradeableMarketCount,
        engineRegime: typeof facts.engineRegime === "string" ? facts.engineRegime.slice(0, 32) : null,
        features,
      },
      limitations: [...PS2E_PACKET_LIMITATIONS],
    };

    const audit = auditTevPacket(packet);
    if (!audit.ok) return ineligible("packet_audit_failed", identity);
    return { ok: true, reason: null, identity, packet: deepFreeze(packet) };
  } catch {
    return ineligible("packet_build_error", identity);
  }
}

/**
 * The PS.2d decision-packet audit + PS.2d outcome/counterfactual key audit + the
 * value-domain check, PLUS one PS.2e rule: `scheduling` may exist only as the
 * frozen temporal provenance block and may never be present before admission.
 */
export function auditTevPacket(packet) {
  const violations = [...auditCrossAssetPacket(packet).violations];
  if (!isPlainObject(packet)) violations.push({ path: "packet", kind: "value", detail: "packet must be an object" });
  for (const problem of packetValueProblems(packet)) {
    if (!violations.some((entry) => entry.path === problem && entry.kind === "value")) {
      violations.push({ path: problem, kind: "value", detail: "value domain" });
    }
  }
  return { ok: violations.length === 0, violations };
}

/** Digest of the packet BEFORE scheduling provenance is attached. */
export function tevOpportunityDigestOf(packet) {
  return digestOf(packet ?? null);
}

/* ============================================================================
 * Temporal provenance (sampling provenance only)
 * ==========================================================================*/

/**
 * Attach the precommitted temporal provenance block. Returns a NEW frozen packet;
 * the input packet is never mutated.
 *
 * @param {object} packet the pre-scheduling packet
 * @param {{ bucketIndex: number|null, bucketStartMs: number|null, bucketEndMs: number|null,
 *   bucketAdmissionIndex: number, globalAdmissionIndex: number, bucketCount: number,
 *   admissionRule: string }} schedule
 */
export function attachTemporalProvenance(packet, schedule) {
  if (!isPlainObject(packet)) throw new Error("a packet is required");
  const scheduling = {
    temporalBucketIndex: Number.isInteger(schedule?.bucketIndex) ? schedule.bucketIndex : null,
    temporalBucketCount: Number.isInteger(schedule?.bucketCount) ? schedule.bucketCount : null,
    temporalBucketStart: finiteOrNull(schedule?.bucketStartMs) === null ? null : iso(schedule.bucketStartMs),
    temporalBucketEnd: finiteOrNull(schedule?.bucketEndMs) === null ? null : iso(schedule.bucketEndMs),
    bucketAdmissionIndex: Number.isInteger(schedule?.bucketAdmissionIndex) ? schedule.bucketAdmissionIndex : null,
    globalAdmissionIndex: Number.isInteger(schedule?.globalAdmissionIndex) ? schedule.globalAdmissionIndex : null,
    admissionRule: typeof schedule?.admissionRule === "string" ? schedule.admissionRule : null,
  };
  const finalized = { ...packet, scheduling };
  const audit = auditTevPacket(finalized);
  if (!audit.ok) throw new Error(`PS.2e packet with temporal provenance failed its audit: ${audit.violations[0]?.path}`);
  return deepFreeze(finalized);
}

/** True when a packet carries the frozen temporal provenance block. */
export function hasTemporalProvenance(packet) {
  return isPlainObject(packet?.scheduling);
}

/* ============================================================================
 * Complete model-visible input + digest
 * ==========================================================================*/

/**
 * The COMPLETE input identity: everything the shared Local JEV classifier
 * receives, plus the pinned runtime/classifier/routing configuration that
 * decides how it is treated. This includes EVERY model-visible value (`risk`,
 * the question id and text, every option description including the reserved
 * ABSTAIN description) and every setting that materially alters the inference
 * request (the EFFECTIVE sampling/inference settings — samples, seed,
 * temperature, n_ctx, early_stop, resolved per decision tier with the shared
 * precedence semantics — and the specialist classifier configuration sub-block).
 * The `sampling` projection carries effective values only: two raw configs that
 * resolve to the same effective settings produce the same projection.
 */
export function localTevCompleteInput({
  protocol = null,
  classifier = null,
  routing = null,
  questionSetId = null,
  questionSetVersion = null,
  questionId = null,
  question = null,
  options = null,
  allowAbstain = null,
  abstainDescription = null,
  risk = null,
  sampling = null,
  classifierConfig = null,
  packet = null,
  limitations = null,
}) {
  return {
    protocol: protocol ?? null,
    classifier: classifier ?? null,
    routing: routing ?? null,
    questionSetId: questionSetId ?? null,
    questionSetVersion: questionSetVersion ?? null,
    questionId: questionId ?? null,
    question: question ?? null,
    options: options ?? null,
    allowAbstain: allowAbstain === true,
    abstainDescription: abstainDescription ?? null,
    risk: risk ?? null,
    sampling: sampling ?? null,
    classifierConfig: classifierConfig ?? null,
    packet: packet ?? null,
    limitations: limitations ?? null,
  };
}

export function localTevInputDigestOf(completeInput) {
  return digestOf(completeInput ?? null);
}

/**
 * The bounded, pre-response descriptor persisted with every record so
 * `jevInputDigest` can be independently recomputed from stored evidence: the
 * COMPLETE input minus the packet, which the record already stores in full.
 * No post-response field is ever part of it.
 */
export function modelInputDescriptorOf(completeInput) {
  if (!isPlainObject(completeInput)) return null;
  const { packet: _packet, ...descriptor } = completeInput;
  return descriptor;
}

/**
 * Replay a stored record: recompute `jevInputDigest` from the persisted
 * pre-response descriptor plus the persisted packet. Exact match required.
 */
export function jevInputDigestFromEvidence(record) {
  const descriptor = isPlainObject(record?.modelInputDescriptor) ? record.modelInputDescriptor : null;
  if (descriptor === null) return null;
  return localTevInputDigestOf({ ...descriptor, packet: record?.packet ?? null });
}

/**
 * Canonical request state length, measured exactly the way the shared Local JEV
 * contract measures it (canonical JSON of the state value).
 */
export function requestStateLength(packet) {
  return canonicalJson(packet ?? null).length;
}

export const PS2E_PACKET_SUPPRESSION_REASONS = Object.freeze({ ...PS2E_SUPPRESSION_REASONS });
