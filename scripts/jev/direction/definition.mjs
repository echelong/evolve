/**
 * Phase 5I.0b — DIRECT TYPESAFE JEV SHORT-HORIZON PREDICTION BENCHMARK
 * (definition / freeze module).
 *
 * This phase answers exactly ONE scientific question, frozen here before any
 * code could measure anything:
 *
 *   "Does direct TypeSafe Jev contain short-horizon directional information
 *    about SOL/USDC price movement beyond deterministic baselines, using only
 *    information available before the outcome?"
 *
 * It measures PREDICTION QUALITY. It does NOT measure profitability, it does
 * NOT simulate execution, and it does NOT give Jev any trading authority.
 *
 * Everything that decides what an observation means is a FROZEN constant in
 * this file: the one benchmark market, the 30-second horizon, the resolution
 * tolerance, the required provider/model/transport, the evidence class, and the
 * market-feature families that EVOLVE genuinely cannot observe (which are
 * therefore OMITTED rather than approximated).
 *
 * PAPER ONLY / DEVELOPMENT EVIDENCE ONLY. No wallet, no signing, no swap, no
 * order, no Arena scoring change, no evolution change, no routing of any kind.
 */

import path from "node:path";

import { digestOf } from "../../lib/hash.mjs";

export const DIRECTION_PHASE = "5I.0b";
export const DIRECTION_SCHEMA_VERSION = 1;

/** Isolated research tree — deliberately NOT the Phase 5D risk-supervisor tree. */
export const DIRECTION_ROOT_DIR = path.join(".evolve", "jev-direction");
export const DIRECTION_EXPERIMENTS_DIR = path.join(DIRECTION_ROOT_DIR, "experiments");
export const DIRECTION_EXPERIMENT_FILE = "experiment.json";
export const DIRECTION_PREDICTIONS_DIR = "predictions";
export const DIRECTION_OUTCOMES_DIR = "outcomes";
export const DIRECTION_SUMMARY_FILE = "summary.json";
export const DIRECTION_PROGRESS_FILE = "progress.json";

/** The one and only evidence class this phase may produce. */
export const DIRECTION_EVIDENCE_CLASS = "DEVELOPMENT_JEV_DIRECTION_EVIDENCE";

/** Every 5I artifact carries these flags, verbatim. */
export const DIRECTION_DEVELOPMENT_FLAGS = Object.freeze({
  developmentOnly: true,
  noGroundTruthBeyondObservedFutureOutcome: true,
  noProfitabilityInference: true,
  noTradingInference: true,
  noDeploymentInference: true,
  paperOnly: true,
  shadowOnly: true,
});

/* ============================================================================
 * The one benchmark market
 * ==========================================================================*/

/**
 * SOL / USDC.
 *
 * REFERENCE-PRICE DEFINITION (frozen, and the ONLY honest one available from the
 * observation schema EVOLVE actually has):
 *
 *   referencePrice(t) = the `usdPrice` of wrapped SOL
 *                       (`So11111111111111111111111111111111111111112`) as
 *                       normalized by EVOLVE's EXISTING Jupiter Tokens V2
 *                       observation pipeline — i.e. `deriveMarket(...).price`.
 *
 * EVOLVE observes USD-denominated token prices; it does NOT observe a SOL/USDC
 * pool quote, a bid/ask spread, or a route price. USDC is treated as the USD
 * numeraire of the benchmark pair (the USDC peg), and that convention is
 * recorded on every packet and artifact. When the USDC mint also appears in the
 * same observation cycle, its observed price is recorded as provenance
 * (`quoteObservedPrice`) — it never rescales the reference price, because
 * inventing a synthetic SOL/USDC ratio EVOLVE did not observe would be exactly
 * the kind of fabrication this phase forbids.
 */
export const BENCHMARK_MARKET = Object.freeze({
  marketId: "SOL-USDC",
  displayName: "SOL / USDC",
  baseSymbol: "SOL",
  quoteSymbol: "USDC",
  baseMint: "So11111111111111111111111111111111111111112",
  quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  referencePriceSource: "Evolve Jupiter Tokens V2 observation (deriveMarket.price, USD-denominated)",
  quoteConvention:
    "USDC is the quote numeraire of the benchmark pair and is treated as the USD peg. EVOLVE's observed token " +
    "schema contains no SOL/USDC pool quote, so no synthetic pair quote is invented.",
});

export const SUPPORTED_MARKET_IDS = Object.freeze([BENCHMARK_MARKET.marketId]);

/* ============================================================================
 * The reference price (versioned + digested)
 *
 * ONE deterministic definition, used IDENTICALLY for the current price (inside
 * the frozen state) and for the future price (the outcome observation). It was
 * chosen BEFORE any 5I outcome existed, it is derived only from the frozen
 * observation, it is reproducible offline from the persisted input projection,
 * and it is NEVER optimized against 5I outcomes.
 * ==========================================================================*/

export const REFERENCE_PRICE_DEFINITION_VERSION = 1;

export const REFERENCE_PRICE_DEFINITION = Object.freeze({
  version: REFERENCE_PRICE_DEFINITION_VERSION,
  marketId: BENCHMARK_MARKET.marketId,
  baseMint: BENCHMARK_MARKET.baseMint,
  quoteMint: BENCHMARK_MARKET.quoteMint,
  formula: "referencePrice(t) = deriveMarket(wrappedSolObservationReceivedAtOrBefore(t)).price",
  basePriceField: "Jupiter Tokens V2 token.usdPrice, coerced by toFiniteNumber",
  normalization: "EVOLVE's existing normalizeJupiterToken -> MarketUniverse -> deriveMarket pipeline",
  quoteNumeraire: "USDC (treated as the USD peg of the pair; verified per cycle when USDC is observed)",
  sameDefinitionForCurrentAndFuture: true,
  derivedOnlyFromFrozenObservation: true,
  reproducibleOfflineFromPersistedProjection: true,
  optimizedAgainstPhase5IOutcomes: false,
  quoteObservedPriceUsedForRescaling: false,
  rejectedAlternatives: [
    {
      alternative: "synthesized SOL/USDC pool ratio (basePrice / quoteObservedPrice)",
      reason:
        "EVOLVE never observes a SOL/USDC pool quote. Dividing two separate USD-denominated observations would " +
        "manufacture a pair price the venue never published.",
    },
    {
      alternative: "venue stats5m.priceChange compounded onto a previous price",
      reason:
        "A 5m aggregate is not a price stamp; reconstructing a level from it would be a derived guess, not an observation.",
    },
    {
      alternative: "mid/last from a bid/ask or route quote",
      reason: "No quote, bid, ask, spread or route data exists anywhere in EVOLVE's observed schema.",
    },
  ],
});

export const REFERENCE_PRICE_DEFINITION_DIGEST = digestOf(REFERENCE_PRICE_DEFINITION);

/* ============================================================================
 * Horizon + resolution (frozen; never optimized, never moved)
 * ==========================================================================*/

/**
 * ONE primary horizon. No horizon optimization exists in this phase: the
 * horizon is not a parameter of the runner, it is a constant of the phase.
 */
export const HORIZON_SECONDS = 30;
export const HORIZON_MS = HORIZON_SECONDS * 1_000;

/**
 * THE FROZEN TARGET BASIS (multi-timestamp provenance, Phase 5I §25).
 *
 *   targetAt = stateFrozenAt + horizonSeconds
 *
 * `stateFrozenAt` is the instant the complete Jev input state was finalized and
 * digested. That is the ONLY definition this phase uses; `stateObservedAt`
 * (receipt of the reference observation) remains a distinct, recorded timestamp.
 * A slow Jev call NEVER moves `targetAt`.
 */
export const TARGET_AT_BASIS = "stateFrozenAt + horizonSeconds";

/**
 * How late the future reference observation may be RECEIVED relative to
 * `targetAt` before the observation is refused. The future price is the first
 * genuine observation received at or after `targetAt`; its real lag is recorded.
 * A lag beyond this bound fails closed — it is NEVER resolved by moving
 * `targetAt`.
 */
export const RESOLUTION_TOLERANCE_MS = 5_000;
/**
 * Policy-v2 bound. Observed live infrastructure delivered valid post-target
 * wrapped-SOL observations at approximately +6 s, so the v1 5 s bound excluded
 * 4/5 of the first real canary's observations purely on data-delivery timing.
 * 10 s keeps one additional bounded refresh margin and remains ~3x smaller than
 * the frozen 30 s prediction horizon. It is chosen from observed delivery timing
 * ONLY — never from prediction correctness, Brier, accuracy or direction.
 */
export const RESOLUTION_TOLERANCE_MS_V2 = 10_000;
export const RESOLUTION_TOLERANCE_BOUNDS = Object.freeze({ min: 1_000, max: 60_000 });

/* ============================================================================
 * Multi-timestamp provenance + staleness (frozen BEFORE any canonical evidence)
 * ==========================================================================*/

/**
 * Every measured/declared instant, kept SEPARATE. A single collapsed timestamp
 * is exactly what makes latency-aware provenance useless, so each one is its own
 * field, and an unavailable SOURCE timestamp is persisted as `null` — never
 * replaced with a local receipt time.
 */
export const STATE_TIMESTAMP_FIELDS = Object.freeze([
  "sourceEventAt",
  "receivedAt",
  "stateObservedAt",
  "stateFrozenAt",
  "predictionStartedAt",
  "predictionCompletedAt",
  "predictionFinalizedAt",
  "targetAt",
]);

export const OUTCOME_TIMESTAMP_FIELDS = Object.freeze([
  "outcomeResolutionStartedAt",
  "outcomeSourceEventAt",
  "outcomeReceivedAt",
  "outcomeObservedAt",
]);

/**
 * Meaning of every timestamp. A collapsed single clock would make latency-aware
 * provenance useless, so each instant is its own field and an unavailable SOURCE
 * timestamp is `null` — never back-filled with a local receipt time.
 */
export const TIMESTAMP_SEMANTICS = Object.freeze({
  sourceEventAt: "the venue's own timestamp for the reference observation, when the payload supplied one; otherwise null",
  receivedAt: "when EVOLVE received the reference observation (never presented as source time)",
  stateObservedAt: "the reference observation's own stamp, i.e. the instant the frozen state's reference price belongs to",
  stateFrozenAt: "when EVOLVE completed and digested the immutable model/baseline input state",
  predictionStartedAt: "when the one logical direct-TypeSafe Jev call began",
  predictionCompletedAt: "when a valid typed Jev response completed (or the attempt failed)",
  predictionFinalizedAt: "when the prediction artifact was written and its digest frozen",
  targetAt: "stateFrozenAt + horizonSeconds",
  outcomeResolutionStartedAt: "when the outcome resolver began (only after targetAt)",
  outcomeSourceEventAt: "the venue's own timestamp for the selected future observation, or null",
  outcomeReceivedAt: "when EVOLVE received the selected future observation",
  outcomeObservedAt: "when EVOLVE finalized the outcome artifact",
});

/** The causal ordering every 5I observation must satisfy. */
export const TIMESTAMP_CAUSAL_ORDER = Object.freeze([
  "sourceEventAt <= receivedAt",
  "receivedAt <= stateFrozenAt",
  "stateObservedAt <= stateFrozenAt",
  "stateFrozenAt <= predictionStartedAt",
  "predictionStartedAt <= predictionCompletedAt",
  "predictionCompletedAt <= predictionFinalizedAt",
  "predictionCompletedAt < targetAt",
  "predictionFinalizedAt <= outcomeResolutionStartedAt",
  "targetAt <= outcomeReceivedAt",
  "outcomeReceivedAt <= outcomeObservedAt",
]);

/**
 * Machine-readable form of the ordering above. Each entry names two fields and
 * whether the relationship is required (`hard`). Relationships that need a
 * SOURCE timestamp are skipped when that timestamp is null — but the local
 * relationships are never skipped.
 */
export const TIMESTAMP_CAUSAL_CHECKS = Object.freeze([
  { left: "sourceEventAt", op: "<=", right: "receivedAt", requiresSourceTimestamp: true, label: "sourceEventAt <= receivedAt" },
  { left: "receivedAt", op: "<=", right: "stateFrozenAt", requiresSourceTimestamp: false, label: "receivedAt <= stateFrozenAt" },
  { left: "stateObservedAt", op: "<=", right: "stateFrozenAt", requiresSourceTimestamp: false, label: "stateObservedAt <= stateFrozenAt" },
  { left: "stateFrozenAt", op: "<=", right: "predictionStartedAt", requiresSourceTimestamp: false, label: "stateFrozenAt <= predictionStartedAt" },
  { left: "predictionStartedAt", op: "<=", right: "predictionCompletedAt", requiresSourceTimestamp: false, label: "predictionStartedAt <= predictionCompletedAt" },
  { left: "predictionCompletedAt", op: "<=", right: "predictionFinalizedAt", requiresSourceTimestamp: false, label: "predictionCompletedAt <= predictionFinalizedAt" },
  { left: "predictionCompletedAt", op: "<", right: "targetAt", requiresSourceTimestamp: false, label: "predictionCompletedAt < targetAt" },
  { left: "predictionFinalizedAt", op: "<=", right: "outcomeResolutionStartedAt", requiresSourceTimestamp: false, label: "predictionFinalizedAt <= outcomeResolutionStartedAt" },
  { left: "targetAt", op: "<=", right: "outcomeReceivedAt", requiresSourceTimestamp: false, label: "targetAt <= outcomeReceivedAt" },
  { left: "outcomeReceivedAt", op: "<=", right: "outcomeObservedAt", requiresSourceTimestamp: false, label: "outcomeReceivedAt <= outcomeObservedAt" },
]);

/**
 * FROZEN MAXIMUM STALENESS RULE (§26). Chosen BEFORE the canonical development
 * experiment and never tuned against outcomes.
 *
 *   RECEIPT age  — stateFrozenAt - receivedAt. This is EVOLVE-measured and is
 *                  normally sub-second; it is the strict guard.
 *   SOURCE age   — stateFrozenAt - sourceEventAt, computed ONLY when the venue
 *                  supplied its own timestamp. The venue's update cadence is not
 *                  under EVOLVE's control, so this bound is deliberately coarse.
 *
 * Source age and receipt age are NEVER mixed, and a state that fails either rule
 * is a NON-SCORABLE observation — never a refreshed timestamp, never a
 * substituted observation.
 */
export const MAX_RECEIPT_STATE_AGE_MS = 15_000;
export const MAX_SOURCE_STATE_AGE_MS = 900_000;

export const STALENESS_RULES = Object.freeze({
  maxReceiptStateAgeMs: MAX_RECEIPT_STATE_AGE_MS,
  maxSourceStateAgeMs: MAX_SOURCE_STATE_AGE_MS,
  sourceAgeAppliedOnlyWhenSourceTimestampExists: true,
  staleStateIsNonScorable: true,
  staleStateIsRefreshed: false,
});

/**
 * The staleness POLICY, as a separately digested object, so an experiment pins
 * the rule itself and not merely the two numbers.
 */
export const STALENESS_POLICY = Object.freeze({
  version: 1,
  receiptAgeFormula: "receiptAgeAtFreezeMs = stateFrozenAt - receivedAt",
  sourceAgeFormula: "sourceAgeAtFreezeMs = stateFrozenAt - latestSourceEventAt",
  sourceAgeUnavailableValue: null,
  sourceAgeAndReceiptAgeAreNeverMixed: true,
  maxReceiptStateAgeMs: MAX_RECEIPT_STATE_AGE_MS,
  maxSourceStateAgeMs: MAX_SOURCE_STATE_AGE_MS,
  receiptStaleInvalidReason: "state_receipt_stale",
  sourceStaleInvalidReason: "state_source_stale",
  staleObservationIsRefused: true,
  staleObservationIsScored: false,
  staleObservationIsSilentlyReplaced: false,
  cutoffChosenFrom: "engineering data-freshness reasoning (an observation cycle is bounded and must be far shorter than the 30-second horizon)",
  cutoffTunedAgainstOutcomes: false,
});

export const STALENESS_POLICY_DIGEST = digestOf(STALENESS_POLICY);

/* ============================================================================
 * Outcome resolution (versioned + digested)
 * ==========================================================================*/

export const OUTCOME_RESOLUTION_POLICY_VERSION_V1 = 1;
export const OUTCOME_RESOLUTION_POLICY_VERSION_V2 = 2;

/**
 * The version NEW experiments pin. The frozen `targetAt` semantics
 * (`targetAt = stateFrozenAt + 30 s`) are UNCHANGED across versions — only the
 * bounded maximum outcome offset differs.
 */
export const CURRENT_OUTCOME_RESOLUTION_POLICY_VERSION = OUTCOME_RESOLUTION_POLICY_VERSION_V2;

/** Reason recorded when no acceptable future observation exists in the window. */
export const OUTCOME_UNAVAILABLE_REASON = "OUTCOME_UNAVAILABLE";

/** The deterministic selection rule, shared verbatim by every policy version. */
const OUTCOME_SELECTION_RULE =
  "the FIRST genuine wrapped-SOL observation RECEIVED at or after targetAt (endpoint walk stops as soon as the base " +
  "mint appears, so the resolution lag is as small as the venue allows)";

/**
 * POLICY V1 — FROZEN HISTORICAL IDENTITY, deliberately preserved byte-for-byte.
 * `maximumOffsetMs = 5000`. Never edited in place: any change requires a NEW
 * version, so every experiment pinned to v1 keeps replaying under exactly this
 * rule and reproduces its existing scorable/non-scorable outcomes.
 */
export const OUTCOME_RESOLUTION_POLICY_V1 = Object.freeze({
  version: OUTCOME_RESOLUTION_POLICY_VERSION_V1,
  selectionRule: OUTCOME_SELECTION_RULE,
  selectionIsLexicographicInTime: true,
  selectionDependsOnPredictionOrOutcomeQuality: false,
  maximumOffsetMs: RESOLUTION_TOLERANCE_MS,
  unavailableReason: OUTCOME_UNAVAILABLE_REASON,
  offsetField: "outcomeOffsetMs = outcomeReceivedAt - targetAt",
  offsetPersisted: true,
  earlierThanTargetRejected: true,
  earlierThanTargetInvalidReason: "future_reference_before_target",
  earlierThanTargetUsesEarlierPrice: false,
  unresolvedInvalidReasonPrefix: "unresolved_",
  neverMovesTargetAt: true,
  neverSubstitutesALaterScheduledObservationForAFailedOne: true,
});

export const OUTCOME_RESOLUTION_POLICY_V1_DIGEST = digestOf(OUTCOME_RESOLUTION_POLICY_V1);

/**
 * POLICY V2 — the SAME deterministic selection rule with the bounded maximum
 * outcome offset widened to 10000 ms. Rationale: the first real canary showed
 * valid post-target observations arriving at ~+6 s, so the v1 5 s bound refused
 * 4/5 of them on infrastructure timing alone. 10 s is one extra bounded refresh
 * margin and stays far below the 30 s horizon. The bound is NOT selected from
 * prediction performance of any kind.
 */
export const OUTCOME_RESOLUTION_POLICY_V2 = Object.freeze({
  version: OUTCOME_RESOLUTION_POLICY_VERSION_V2,
  selectionRule: OUTCOME_SELECTION_RULE,
  selectionIsLexicographicInTime: true,
  selectionDependsOnPredictionOrOutcomeQuality: false,
  maximumOffsetMs: RESOLUTION_TOLERANCE_MS_V2,
  unavailableReason: OUTCOME_UNAVAILABLE_REASON,
  offsetField: "outcomeOffsetMs = outcomeReceivedAt - targetAt",
  offsetPersisted: true,
  earlierThanTargetRejected: true,
  earlierThanTargetInvalidReason: "future_reference_before_target",
  earlierThanTargetUsesEarlierPrice: false,
  unresolvedInvalidReasonPrefix: "unresolved_",
  neverMovesTargetAt: true,
  neverSubstitutesALaterScheduledObservationForAFailedOne: true,
  supersedesPolicyVersion: OUTCOME_RESOLUTION_POLICY_VERSION_V1,
  offsetBoundChosenFrom:
    "observed live infrastructure data-delivery timing (valid post-target wrapped-SOL observations arriving at ~+6 s)",
  offsetBoundTunedAgainstPredictionOutcomes: false,
  offsetBoundBelowHorizonMs: HORIZON_MS,
});

export const OUTCOME_RESOLUTION_POLICY_V2_DIGEST = digestOf(OUTCOME_RESOLUTION_POLICY_V2);

/** Version -> frozen policy. Every version ever pinned stays resolvable forever. */
export const OUTCOME_RESOLUTION_POLICIES = Object.freeze({
  [OUTCOME_RESOLUTION_POLICY_VERSION_V1]: OUTCOME_RESOLUTION_POLICY_V1,
  [OUTCOME_RESOLUTION_POLICY_VERSION_V2]: OUTCOME_RESOLUTION_POLICY_V2,
});

export const OUTCOME_RESOLUTION_POLICY_DIGESTS = Object.freeze({
  [OUTCOME_RESOLUTION_POLICY_VERSION_V1]: OUTCOME_RESOLUTION_POLICY_V1_DIGEST,
  [OUTCOME_RESOLUTION_POLICY_VERSION_V2]: OUTCOME_RESOLUTION_POLICY_V2_DIGEST,
});

/** The policy NEW experiments pin (v2). */
export const DEFAULT_OUTCOME_RESOLUTION_POLICY = OUTCOME_RESOLUTION_POLICY_V2;
export const DEFAULT_OUTCOME_RESOLUTION_POLICY_DIGEST = OUTCOME_RESOLUTION_POLICY_V2_DIGEST;

/** Resolve a frozen policy by version. Unknown versions resolve to `null` (fail closed). */
export function outcomeResolutionPolicyFor(version) {
  const resolved = OUTCOME_RESOLUTION_POLICIES[Number(version)];
  return resolved ?? null;
}

export function outcomeResolutionPolicyDigestFor(version) {
  const resolved = OUTCOME_RESOLUTION_POLICY_DIGESTS[Number(version)];
  return resolved ?? null;
}

/** The registered policy whose bound equals `maximumOffsetMs`, or `null`. */
export function outcomeResolutionPolicyForOffset(maximumOffsetMs) {
  for (const policy of Object.values(OUTCOME_RESOLUTION_POLICIES)) {
    if (policy.maximumOffsetMs === maximumOffsetMs) return policy;
  }
  return null;
}

/**
 * PURE offset classifier — the ONE implementation of the bounded-window rule.
 * It depends ONLY on timestamps and the policy bound: never on the Jev
 * probability, the model intent, or the actual direction.
 *
 * @returns {{ outcomeOffsetMs: number|null, invalidReason: string|null, withinWindow: boolean }}
 */
export function resolveOutcomeOffset({ outcomeReceivedAtMs, targetAtMs, maximumOffsetMs }) {
  const outcomeOffsetMs =
    Number.isFinite(outcomeReceivedAtMs) && Number.isFinite(targetAtMs) ? outcomeReceivedAtMs - targetAtMs : null;
  let invalidReason = null;
  if (outcomeOffsetMs === null) invalidReason = "outcome_timestamp_unavailable";
  else if (outcomeOffsetMs < 0) invalidReason = "future_reference_before_target";
  else if (!Number.isFinite(maximumOffsetMs) || outcomeOffsetMs > maximumOffsetMs) invalidReason = OUTCOME_UNAVAILABLE_REASON;
  return { outcomeOffsetMs, invalidReason, withinWindow: invalidReason === null };
}

/* ============================================================================
 * Isolation: zero routing authority anywhere in Phase 5I
 * ==========================================================================*/

export const DIRECTION_ROUTING_FLAGS = Object.freeze({
  // Jev IS called — as the benchmark predictor, nothing else.
  jevPredictionActive: true,
  jevTradingRoutingActive: false,
  arenaRoutingActive: false,
  deepseekRoutingActive: false,
  classifierRoutingActive: false,
  agentReachRoutingActive: false,
  tradingRoutingActive: false,
});

/**
 * Recommended observation-endpoint order for the benchmark. This is the SAME
 * `EVOLVE_JUPITER_ENDPOINTS` configuration the engine already uses — only the
 * order changes, and the order matters for measurement quality:
 *
 *   toptrending, toporganicscore  — the two lists a major pair like SOL/USDC can
 *                                   actually appear in, polled FIRST so the
 *                                   reference-price stamp is as close to the
 *                                   cycle start as the venue allows;
 *   recent                        — recently CREATED pools, which cannot contain
 *                                   wrapped SOL, kept last for the regime
 *                                   feature's universe breadth.
 */
export const RECOMMENDED_ENDPOINT_ORDER = Object.freeze(["toptrending", "toporganicscore", "recent"]);

/** Default sampling: 30s cadence, 30s horizon (non-overlapping scheduled t0s). */
export const DEFAULT_CADENCE_SECONDS = 30;
export const DEFAULT_MAX_OBSERVATIONS = 120;
export const MAX_OBSERVATIONS_BOUNDS = Object.freeze({ min: 1, max: 1_000 });
export const CADENCE_SECONDS_BOUNDS = Object.freeze({ min: 5, max: 3_600 });
export const DEFAULT_MAX_RUNTIME_MINUTES = 90;
export const MAX_RUNTIME_MINUTES_BOUNDS = Object.freeze({ min: 1, max: 1_440 });

/** Bounded pre-t0 observation history carried in every packet. */
export const OBSERVATION_HISTORY_LIMIT = 8;

/* ============================================================================
 * Required provider / model / transport (direct TypeSafe only)
 * ==========================================================================*/

export const REQUIRED_PROVIDER = "typesafe-jev";
export const REQUIRED_UPSTREAM_PROVIDER = "typesafe-ai";
export const REQUIRED_MODEL = "jev-1.13.0";
export const REQUIRED_GATEWAY_USED = false;

/** Routes that may NEVER be used for canonical 5I evidence. */
export const FORBIDDEN_CANONICAL_PROVIDERS = Object.freeze(["vercel-jev", "mock-jev"]);

/** Moving model aliases may never be pinned as the canonical 5I model. */
export const FORBIDDEN_MODEL_ALIASES = Object.freeze(["jev-latest", "jev-preview"]);

/** The offline mock is allowed ONLY for offline development/validation runs. */
export const MOCK_PROVIDER = "mock-jev";

/**
 * `--allow-mock` runs are served by a 5I-DEDICATED deterministic offline fixture
 * provider (it answers ONLY the direction question set and refuses every other
 * one). The recorded provider name is the honest top-level `mock-jev`, and the
 * exact implementation is recorded alongside it, so an offline run can never be
 * mistaken for direct-TypeSafe evidence.
 */
export const OFFLINE_FIXTURE_PROVIDER = "mock-jev";
export const OFFLINE_FIXTURE_IMPLEMENTATION = "direction-fixture-jev-v1";

/**
 * There is NO Jev confidence threshold in this phase. Every valid probability is
 * retained. These names are listed only so validators can assert they are never
 * recreated anywhere in the 5I subsystem.
 */
export const FORBIDDEN_THRESHOLD_NAMES = Object.freeze(["EVOLVE_JEV_MIN_CONFIDENCE", "minConfidence"]);

/* ============================================================================
 * Event lifecycle (§27)
 * ==========================================================================*/

/**
 * FROZEN EVENT LIFECYCLE. The outcome resolver may never run before the
 * prediction artifact is finalized, and baselines + Jev must consume the SAME
 * frozen state (proved by `stateDigest`).
 */
export const EVENT_ORDERING = Object.freeze([
  "market observation received",
  "deterministic market state updated",
  "historical window selected",
  "state snapshot constructed",
  "state snapshot frozen",
  "state digest computed",
  "deterministic baseline outputs computed from that exact state",
  "predictionStartedAt",
  "direct TypeSafe Jev call",
  "prediction response frozen",
  "prediction digest frozen",
  "wait until target horizon",
  "future observation selected",
  "outcome artifact written",
  "prediction digest verified unchanged",
  "joined metrics computed offline",
]);

/* ============================================================================
 * Data-granularity integrity guard
 *
 * EVOLVE observes Jupiter Tokens V2 AGGREGATES. Nothing in 5I may name (or
 * imply) a market concept that requires a genuine CLOB / L2 / L3 / per-trade
 * feed. This is enforced on the FEATURE VOCABULARY at runtime, not merely
 * documented, so a future edit that introduces `orderBookImbalance` fails.
 *
 * Note this guard deliberately does NOT forbid the word "imbalance":
 * `observed5mVolumeFlowImbalance` is a real, honestly named aggregate. It
 * forbids the ORDER-BOOK sense of imbalance via the phrase list.
 * ==========================================================================*/

export const FORBIDDEN_GRANULARITY_TOKENS = Object.freeze([
  "orderbook",
  "l2",
  "l3",
  "queue",
  "cvd",
  "maker",
  "taker",
  "aggressive",
  "bid",
  "ask",
  "depth",
  "tick",
  "fill",
  "cancel",
]);

export const FORBIDDEN_GRANULARITY_PHRASES = Object.freeze([
  "order book",
  "order book imbalance",
  "book imbalance",
  "queue depth",
  "queue position",
  "maker queue",
  "maker flow",
  "aggressive buy",
  "aggressive sell",
  "bid ask",
  "bid ask spread",
  "quote spread",
  "traded through",
  "partial fill",
  "cumulative volume delta",
]);

/** The honest name for the one aggregate flow field 5I does use. */
export const AGGREGATE_FLOW_FIELD_NAME = "observed5mVolumeFlowImbalance";

/* ============================================================================
 * Model intent (§28)
 * ==========================================================================*/

/**
 * The raw probability stays primary; this is a reporting lean, NOT an order
 * side, NOT a trade decision, and it is NEVER overwritten by a later layer.
 * Phase 5I.0b has no execution at all, so `executedAction` and `overrideReason`
 * are always null — a future execution layer must ADD its own fields rather than
 * rewrite these.
 */
export const MODEL_INTENT_DEFINITION =
  "modelIntent = 'HIGHER' when modelProbabilityHigher >= 0.5, else 'LOWER'; null when no valid probability exists. " +
  "It is a probability-implied directional lean recorded for provenance only: not an order side, not a trade, and " +
  "never mutated once frozen.";
export const EXECUTED_ACTION_IN_5I_0B = null;
export const OVERRIDE_REASON_IN_5I_0B = null;

/* ============================================================================
 * Future Phase 5I.2 execution boundary (§33) — DOCUMENTATION ONLY
 * ==========================================================================*/

/**
 * A maker/execution simulator may only be introduced once EVOLVE has genuine,
 * sufficiently granular market data. L2/L3 state must never be manufactured from
 * Jupiter quotes, and a fill is never assumed merely because a price touched an
 * order. NOTHING in this phase implements any of it.
 */
export const FUTURE_EXECUTION_BOUNDARY = Object.freeze({
  phase: "5I.2",
  implementationApproved: false,
  implementedInThisPhase: false,
  requiredMarketData: ["genuine L2/L3 price levels", "bid/ask depth", "queue-ahead information"],
  requiredConcepts: [
    "real L2/L3 price levels when available",
    "bid/ask depth",
    "queue-ahead estimate",
    "order placement timestamp",
    "exchange/source event timestamp",
    "cancel-request timestamp",
    "cancel-effective timestamp",
    "latency",
    "partial fills",
    "price-touch behavior",
    "traded-through volume",
    "queue depletion",
    "fees",
    "maker/taker distinction",
    "slippage where applicable",
  ],
  requiredFillStates: [
    "TOUCHED",
    "TRADED_THROUGH",
    "QUEUE_AHEAD_CONSUMED",
    "PARTIAL_FILL",
    "FULL_FILL",
    "CANCELLED",
    "CANCEL_RACE_FILL",
    "EXPIRED",
  ],
  forbiddenNow: [
    "manufacturing L2/L3 state from Jupiter quotes",
    "assuming a fill because a price touched an order",
    "any execution simulator before explicit Phase 5I.2 approval",
  ],
});

/* ============================================================================
 * Market-feature families EVOLVE genuinely CANNOT observe
 *
 * Reported, never approximated. Every one of these requires a feed EVOLVE does
 * not have (a genuine CLOB/order-book feed or a per-trade/route feed). They are
 * deliberately absent from the packet instead of being faked from 5m aggregates.
 * ==========================================================================*/

export const UNAVAILABLE_FEATURE_FAMILIES = Object.freeze([
  {
    family: "orderBookImbalance",
    reason: "EVOLVE observes Jupiter Tokens V2 aggregates only; no order book (bids/asks/levels) exists in the schema.",
  },
  {
    family: "queueDepth",
    reason: "No order-book feed exists, so no queue depth is observable.",
  },
  {
    family: "cvd",
    reason:
      "Cumulative volume delta needs per-trade aggressor data. EVOLVE observes 5m buy/sell volume aggregates, which " +
      "are NOT a CVD and are never labelled as one.",
  },
  {
    family: "makerFlow",
    reason: "No maker/taker identity is observable from the aggregate schema.",
  },
  {
    family: "quoteSpread",
    reason: "No quote or bid/ask feed exists, so no spread can be observed (or derived) for SOL/USDC.",
  },
  {
    family: "routePriceImpact",
    reason:
      "EVOLVE performs observation GETs only; it never builds or simulates a swap route, so `quote_price_impact` is " +
      "not derivable. If a route were ever simulated, the honest name would be quote_price_impact, never a " +
      "microstructure label.",
  },
  {
    family: "routeCount",
    reason: "No quote/route request is ever made by 5I, so `quote_route_count` does not exist in this evidence.",
  },
  {
    family: "cancelReplaceMicrostructure",
    reason: "No CLOB message feed exists.",
  },
]);

/** Deterministic digest of the omitted-family declaration (provenance for the omission itself). */
export const UNAVAILABLE_FEATURE_FAMILIES_DIGEST = digestOf(UNAVAILABLE_FEATURE_FAMILIES);

/* ============================================================================
 * CLI shape
 * ==========================================================================*/

export const DIRECTION_ACTIONS = Object.freeze(["start", "resume", "resolve", "replay", "stats"]);

/**
 * Options this phase deliberately does NOT have. Supplying one is a hard error
 * rather than a silently ignored flag — a benchmark that could be nudged toward
 * looking better is not a benchmark.
 */
export const DIRECTION_FORBIDDEN_FLAGS = Object.freeze([
  "threshold",
  "min-confidence",
  "confidence",
  "horizon-optimize",
  "optimize-horizon",
  "trade",
  "trades",
  "wallet",
  "sign",
  "signer",
  "swap",
  "order",
  "execute",
  "arena",
  "arena-score",
  "deepseek",
  "route",
  "routing",
  "agent",
  "agents",
  "pnl",
  "profit",
  "profitability",
  "sharpe",
  "position",
  "position-size",
  "signal",
  "alpha",
  "latest",
]);

export const DIRECTION_BOOLEAN_FLAGS = Object.freeze([
  "start",
  "resume",
  "resolve",
  "replay",
  "stats",
  "definition",
  "json",
  "help",
  "allow-mock",
  "allow-unsafe-model",
]);

export const DIRECTION_VALUE_FLAGS = Object.freeze([
  "market",
  "experiment",
  "max-observations",
  "cadence-seconds",
  "horizon-seconds",
  "tolerance-ms",
  "max-runtime-minutes",
  "provider",
  "model",
  "timeout-ms",
  "out",
]);

/** Resolve which single action an invocation selected. Never more than one. */
export function resolveDirectionAction(flags = {}) {
  const selected = DIRECTION_ACTIONS.filter((action) => flags?.[action] === true);
  if (selected.length === 0) return { action: null, error: "exactly one of --start | --resume | --resolve | --replay | --stats is required" };
  if (selected.length > 1) return { action: null, error: `exactly ONE action may be selected, got: ${selected.join(", ")}` };
  return { action: selected[0], error: null };
}

/**
 * Actions that operate on an EXISTING experiment. `--start` is the only action
 * allowed to create one, and there is deliberately no "latest" shortcut: every
 * other action needs an explicit experiment id.
 */
export function requiresExplicitExperimentId(action) {
  return action !== null && action !== "start";
}
