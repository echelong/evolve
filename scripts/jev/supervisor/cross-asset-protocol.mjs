/**
 * Phase 5I-PS.2d — CROSS-ASSET PRODUCTION OPPORTUNITY SHADOW (frozen protocol).
 *
 * DEVELOPMENT SHADOW • ZERO AUTHORITY. The ONE module that holds every constant
 * deciding what PS.2d observes, samples, sends and stores. Everything here was
 * frozen before any live PS.2d run and is never derived from a result, a score
 * distribution, a Jev answer or an outcome (see `PS2d.md`).
 *
 *   production decision/proposal finalized
 *           │
 *           ▼
 *   copied immutable shadow facts ──► normal engine continues (paper execution)
 *           │
 *           ▼
 *   genuineness → schema → deterministic bounded sampling → bounded queue
 *           │
 *           ▼
 *   asynchronous direct TypeSafe Jev (typed, fail closed) → descriptive record
 *
 * PS.2d is a NEW generalization context. SOL direction evidence is never
 * generalized to other assets, and nothing here may flip an authority flag.
 *
 * PAPER ONLY / SHADOW ONLY / DEVELOPMENT EVIDENCE ONLY.
 */

import { digestOf } from "../../lib/hash.mjs";

export const PS2D_PHASE = "5I-PS.2d";
export const PS2D_PROTOCOL_ID = "evolve-5i-ps2d-cross-asset-production-shadow";
export const PS2D_PROTOCOL_VERSION = 1;
export const PS2D_SCHEMA_VERSION = 1;

export const PS2D_LABEL = "CROSS-ASSET PRODUCTION SHADOW";
export const PS2D_AUTHORITY_TAG = "DEVELOPMENT SHADOW • ZERO AUTHORITY";
export const PS2D_STATEMENT =
  "Jev passively observes a bounded, deterministic sample of genuine EVOLVE production entry proposals across " +
  "assets. It cannot approve, reject, resize, delay, reorder, replace, select or veto anything. Development shadow " +
  "evidence only: no profitability, trading, deployment or authority inference.";

/* ============================================================================
 * Evidence classification (never CLEAN_JEV_DIRECTION_*)
 * ==========================================================================*/

export const PS2D_EVIDENCE_CLASSIFICATION = "DEVELOPMENT_CROSS_ASSET_SUPERVISOR_SHADOW";

/** Every PS.2d artifact carries exactly these flags. None may ever be flipped. */
export const PS2D_FLAGS = Object.freeze({
  evidenceClassification: PS2D_EVIDENCE_CLASSIFICATION,
  developmentOnly: true,
  paperOnly: true,
  shadowOnly: true,
  zeroAuthority: true,
  canonicalEvidence: false,
  replicationEvidence: false,
  temporalReplicationEvidence: false,
  noProfitabilityInference: true,
  noTradingInference: true,
  noDeploymentInference: true,
  noAuthorityPromotion: true,
  automaticPromotionPermitted: false,
  solDirectionEvidenceGeneralized: false,
  outcomeResolved: false,
});

/* ============================================================================
 * Genuine production opportunity (frozen boundary)
 * ==========================================================================*/

/**
 * Literal markers the engine's production-entry tap stamps on its copied facts.
 * The engine source carries the same literals (it may not import this module);
 * the validator asserts they match.
 */
export const PS2D_PRODUCTION_SOURCE = "PRODUCTION_ENTRY_PROPOSAL";
export const PS2D_PRODUCTION_ACTION = "ENTER_LONG";
export const PS2D_PRODUCTION_SELECTION = "PRODUCTION_BEST_SCORE";

export const PS2D_GENUINE_OPPORTUNITY_DEFINITION = Object.freeze({
  tap: "stepAgent → observeProductionEntry, after ctx.bestScore = bestScore and immediately before openPosition",
  requires: Object.freeze([
    "agent is flat (no open position)",
    "ctx.allowNewEntries is true",
    "research posture is not ABSTAIN",
    "unchanged passesGates evaluated every scanned market",
    "best = unchanged strict '>' argmax of unchanged scoreMarket over gate-passing markets",
    "bestScore >= genome.entryScoreThreshold (unchanged production '>=')",
  ]),
  oneToOneWith: "PS.2 ENTER_LONG / ENTRY_SIGNAL execution proposal (openPosition has exactly one caller)",
  proposalFinalBeforeExecution: true,
  blockedPaperEntriesRemainGenuine: true,
  executionResultInEligibility: false,
  executionResultInPacket: false,
  excludes: Object.freeze([
    "every exit (SIGNAL, STOP, TAKE, TIME, GEN-END, STAGE-END)",
    "markets scored but not selected",
    "selections below the entry threshold",
    "any production gate failure",
    "PS.2a SOL opportunities",
    "PS.2b funnel facts",
    "PS.2c counterfactual passes",
    "paused or abstaining agents",
    "facts from a non-engine caller that fail genuineness validation",
  ]),
});

/** Why a tap fact is NOT a genuine production opportunity (checked in order). */
export const PS2D_NON_GENUINE_REASONS = Object.freeze([
  "malformed_facts",
  "fact_copy_failed",
  "counterfactual_input_rejected",
  "not_production_source",
  "not_entry_action",
  "not_production_selection",
  "production_gates_failed",
  "non_finite_score_or_threshold",
  "below_entry_threshold",
  "missing_market",
]);

/** Any fact key matching this is PS.2c-style counterfactual data and is refused. */
export const PS2D_COUNTERFACTUAL_KEY_PATTERN = /counterfactual/i;

/* ============================================================================
 * Prospective asset identity (generic; no allowlist, no SOL special case)
 * ==========================================================================*/

/**
 * The USD numeraire. EVOLVE observes Jupiter USD prices; USDC is the existing
 * Phase 5I numeraire convention. It is the QUOTE side of every PS.2d identity and
 * never an allowlist.
 */
export const PS2D_QUOTE_NUMERAIRE_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const PS2D_QUOTE_NUMERAIRE_SYMBOL = "USDC";
export const PS2D_IDENTITY_RULE =
  "marketId = <baseMint>/<quoteMint>; baseMint = selected market mint; quoteMint = USDC numeraire; " +
  "symbol is descriptive only and never part of the identity";

/** Base58 alphabet (no 0, O, I, l), 32–44 characters: a well-formed Solana mint. */
export const PS2D_MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const PS2D_MAX_SYMBOL_LENGTH = 32;
export const PS2D_MAX_SYMBOL_VARIANTS = 4;

/* ============================================================================
 * Schema eligibility (pre-outcome only, checked in this fixed order)
 * ==========================================================================*/

export const PS2D_SCHEMA_INELIGIBLE_REASONS = Object.freeze([
  "invalid_base_mint",
  "base_equals_quote_numeraire",
  "synthetic_market",
  "market_not_fresh",
  "invalid_reference_price",
  "invalid_liquidity",
  "invalid_proposal_time",
  "missing_market_observed_at",
  "observed_after_proposal",
  "missing_agent_identity",
  "non_finite_feature",
  "packet_audit_failed",
  "packet_build_error",
]);

/**
 * The production scoring/gate features carried into the packet. Exactly the
 * `deriveFeatures` outputs read by `marketComposites`/`scoreMarket` and the
 * production gates. `poolAgeHours` alone is nullable (unknown pool age is a
 * legitimate production state).
 */
export const PS2D_FEATURE_KEYS = Object.freeze([
  "momentum",
  "buyPressure",
  "orderFlow",
  "organicFlow",
  "netBuyerPressure",
  "traderActivity",
  "organicBuyers",
  "liquidityQuality",
  "organicScore",
  "safety",
  "ageYouth",
  "holderDistribution",
  "holderBase",
  "volumeActivity",
  "liquidityTrend",
  "volatility",
  "poolAgeHours",
]);
export const PS2D_NULLABLE_FEATURE_KEYS = Object.freeze(["poolAgeHours"]);

/* ============================================================================
 * Packet + complete input digest
 * ==========================================================================*/

export const PS2D_PACKET_VERSION = 1;
export const PS2D_PACKET_KIND = "EVOLVE_CROSS_ASSET_PRODUCTION_PROPOSAL";

export const PS2D_PACKET_LIMITATIONS = Object.freeze([
  "Pre-outcome facts only: every value was available to the EVOLVE paper engine at or before proposalAt.",
  "USD reference prices from EVOLVE's observation feed; no order book, spread, route, L2 or L3 data exists here.",
  "The proposal is EVOLVE's own finalized paper entry; this request has zero authority over it.",
]);

/**
 * PS.2d-specific key audit (in addition to the existing Jev decision-packet
 * audit): no outcome, future, execution or counterfactual field may exist in a
 * model-visible packet.
 */
export const PS2D_FORBIDDEN_PACKET_KEY_PATTERN =
  /future|outcome|forward|horizon|realized|pnl|profit|return|fill|executed|execution|proceeds|counterfactual|exitprice|settle/i;

export const PS2D_DIGEST_RULE =
  "jevInputDigest = digestOf({ provider, model, questionSetId, questionSetVersion, questions, packet }) over the " +
  "COMPLETE model-visible payload; no partial-state digest and no volatile-field exclusion";

/* ============================================================================
 * Deterministic bounded sampling (frozen before any live run)
 * ==========================================================================*/

export const PS2D_PER_ASSET_MAX_JEV_CALLS_PER_RUN = 10;
export const PS2D_PER_ASSET_MIN_SPACING_MS = 60_000;

export const PS2D_SUPPRESSION_REASONS = Object.freeze({
  DUPLICATE_DIGEST: "suppressedDuplicateDigest",
  PER_ASSET_CAP: "suppressedPerAssetCap",
  ASSET_COOLDOWN: "suppressedAssetCooldown",
  GLOBAL_CAP: "suppressedGlobalCap",
});

/** First match wins. Frozen. */
export const PS2D_SUPPRESSION_PRECEDENCE = Object.freeze([
  PS2D_SUPPRESSION_REASONS.DUPLICATE_DIGEST,
  PS2D_SUPPRESSION_REASONS.PER_ASSET_CAP,
  PS2D_SUPPRESSION_REASONS.ASSET_COOLDOWN,
  PS2D_SUPPRESSION_REASONS.GLOBAL_CAP,
]);

export const PS2D_SAMPLING_RULE =
  "schema-eligible opportunities in engine tick order (within one tick: ascending complete-input digest); " +
  "duplicate admitted digest → per-asset cap → per-asset cooldown on engine time since the asset's last admission " +
  "→ global cap → admit; no randomness and no score, performance, outcome or Jev dependence";

/**
 * WITHIN-TICK ORDER. The engine steps its population in array order, and after
 * every generation that array is fitness-ranked (elites first). Using raw
 * population order would therefore let past fitness decide which of several
 * same-tick proposals wins a per-asset cooldown or the last global-cap slots.
 * PS.2d instead buffers exactly one engine tick (keyed by generation +
 * generationTick) and applies the sampler in ascending complete-input digest
 * order: fully content-determined, no RNG, independent of fitness and of how
 * the population happens to be ordered. Ticks are processed in engine order.
 */
export const PS2D_WITHIN_TICK_ORDER = "ascending jevInputDigest (content-determined; never population/fitness order)";
export const PS2D_TICK_KEY_RULE = "tick = (generation, generationTick) of the copied production facts";
/** Defensive bound on one tick's buffered eligible opportunities (population-sized in practice). */
export const PS2D_TICK_BUFFER_LIMIT = 4_096;

/**
 * Run profiles. Only `canary` and `full` are CLI-selectable. The queue capacity
 * equals the global maximum, so in the CLI profiles an admitted observation is
 * never lost to a full queue.
 */
export const PS2D_PROFILES = Object.freeze({
  canary: Object.freeze({
    profile: "canary",
    globalMaxJevCallsPerRun: 20,
    queueCapacity: 20,
    recommendedMinutes: 30,
    purpose: "infrastructure verification only; nothing is tuned from canary results",
  }),
  full: Object.freeze({
    profile: "full",
    globalMaxJevCallsPerRun: 120,
    queueCapacity: 120,
    recommendedMinutes: 60,
    purpose: "frozen development shadow protocol",
  }),
});
export const PS2D_CLI_PROFILES = Object.freeze(["canary", "full"]);

/** Offline validation only (never CLI-selectable): proves queue-full safety. */
export const PS2D_OFFLINE_VALIDATION_PROFILE = Object.freeze({
  profile: "offline-validation",
  globalMaxJevCallsPerRun: 8,
  queueCapacity: 2,
  recommendedMinutes: 0,
  purpose: "offline validation of queue-full behaviour; refused by the CLI",
});

/** Resolve a profile by name. Unknown names are refused (fail closed). */
export function crossAssetProfileFor(name, { allowOfflineValidation = false } = {}) {
  if (name === PS2D_OFFLINE_VALIDATION_PROFILE.profile) {
    return allowOfflineValidation ? PS2D_OFFLINE_VALIDATION_PROFILE : null;
  }
  return Object.hasOwn(PS2D_PROFILES, name) ? PS2D_PROFILES[name] : null;
}

/* ============================================================================
 * Question contract identity (the question itself lives in cross-asset-questions.mjs)
 * ==========================================================================*/

export const PS2D_QUESTION_SET_ID = "jev-cross-asset-production-proposal-v1";
export const PS2D_QUESTION_SET_VERSION = 1;
export const PS2D_QUESTION_NAME = "productionProposalSupported";

export const PS2D_STANCES = Object.freeze({
  SUPPORTS: "SUPPORTS_PROPOSAL",
  DOES_NOT_SUPPORT: "DOES_NOT_SUPPORT_PROPOSAL",
  EXACTLY_HALF: "EXACTLY_HALF",
});

/* ============================================================================
 * External-call policy (Governance v1, evidence-bearing shadow)
 * ==========================================================================*/

export const PS2D_TIMEOUT_MS = 20_000;
/**
 * The COMPLETE transport policy of the dedicated PS.2d provider instance. The CLI
 * spreads it AFTER the environment configuration, so no EVOLVE_JEV_* variable can
 * change PS.2d attempts, backoff or transport cooldown. Retries happen only for
 * transient failures (never for malformed output).
 */
export const PS2D_TRANSPORT_SETTINGS = Object.freeze({
  maxAttemptsPerCall: 2,
  backoffBaseMs: 1_000,
  backoffMaxMs: 10_000,
  cooldownMs: 60_000,
  cooldownMaxMs: 900_000,
});
export const PS2D_MAX_TRANSPORT_ATTEMPTS = PS2D_TRANSPORT_SETTINGS.maxAttemptsPerCall;
export const PS2D_RETRY_CAP = PS2D_MAX_TRANSPORT_ATTEMPTS - 1;
/** The transport's existing hard ceiling on a server-supplied Retry-After (ms). */
export const PS2D_RETRY_AFTER_CEILING_MS = 60_000;
/** Worst-case wall time of ONE logical PS.2d call: 2 × timeout + one bounded wait. */
export const PS2D_WORST_CASE_CALL_MS =
  PS2D_MAX_TRANSPORT_ATTEMPTS * PS2D_TIMEOUT_MS + Math.max(PS2D_TRANSPORT_SETTINGS.backoffMaxMs, PS2D_RETRY_AFTER_CEILING_MS);
export const PS2D_CIRCUIT_BREAKER = Object.freeze({ failureThreshold: 5, cooldownMs: 300_000 });
export const PS2D_PROVIDER_HEALTH_DIR = "provider-health-cross-asset";

/** Governance external-call policy for one profile (validated by the validator). */
export function crossAssetExternalCallPolicy(profile, { provider, model } = {}) {
  return {
    timeoutMs: PS2D_TIMEOUT_MS,
    retryCap: PS2D_RETRY_CAP,
    maxCallsPerRun: profile.globalMaxJevCallsPerRun,
    provider,
    model,
    fallback: "none",
    cache:
      "session-record-replay: no provider-response cache or cross-run reuse; complete-input digests are never " +
      "re-sent within a run; every typed response is persisted with its complete-input digest",
    authorityLevel: "SHADOW",
    circuitBreaker: { ...PS2D_CIRCUIT_BREAKER },
    failClosed: true,
    evidenceBearing: true,
    evidenceReference: null,
    pricingKnown: false,
    costAccounting:
      "provider usage fields are recorded per judgment when reported; no pricing table is known, so no cost is inferred",
  };
}

/* ============================================================================
 * Bounded storage
 * ==========================================================================*/

export const PS2D_OBSERVATIONS_FILE = "cross-asset-observations.ndjson";
export const PS2D_MAX_TRACKED_ASSETS = 2_048;
export const PS2D_MAX_PERSISTED_ASSET_ROWS = 128;
export const PS2D_MAX_DASHBOARD_ASSET_ROWS = 32;
export const PS2D_RECENT_ROW_LIMIT = 16;
export const PS2D_MAX_FAILURE_REASON_LENGTH = 240;

/* ============================================================================
 * Frozen protocol digest (persisted with every PS.2d session)
 * ==========================================================================*/

export const PS2D_PROTOCOL_DEFINITION = Object.freeze({
  phase: PS2D_PHASE,
  protocolId: PS2D_PROTOCOL_ID,
  protocolVersion: PS2D_PROTOCOL_VERSION,
  flags: PS2D_FLAGS,
  genuineOpportunity: PS2D_GENUINE_OPPORTUNITY_DEFINITION,
  nonGenuineReasons: PS2D_NON_GENUINE_REASONS,
  identityRule: PS2D_IDENTITY_RULE,
  quoteNumeraireMint: PS2D_QUOTE_NUMERAIRE_MINT,
  schemaIneligibleReasons: PS2D_SCHEMA_INELIGIBLE_REASONS,
  featureKeys: PS2D_FEATURE_KEYS,
  packetVersion: PS2D_PACKET_VERSION,
  packetKind: PS2D_PACKET_KIND,
  digestRule: PS2D_DIGEST_RULE,
  samplingRule: PS2D_SAMPLING_RULE,
  withinTickOrder: PS2D_WITHIN_TICK_ORDER,
  tickKeyRule: PS2D_TICK_KEY_RULE,
  tickBufferLimit: PS2D_TICK_BUFFER_LIMIT,
  suppressionPrecedence: PS2D_SUPPRESSION_PRECEDENCE,
  perAssetMaxJevCallsPerRun: PS2D_PER_ASSET_MAX_JEV_CALLS_PER_RUN,
  perAssetMinSpacingMs: PS2D_PER_ASSET_MIN_SPACING_MS,
  profiles: PS2D_PROFILES,
  questionSetId: PS2D_QUESTION_SET_ID,
  questionSetVersion: PS2D_QUESTION_SET_VERSION,
  stances: PS2D_STANCES,
  timeoutMs: PS2D_TIMEOUT_MS,
  retryCap: PS2D_RETRY_CAP,
  transportSettings: PS2D_TRANSPORT_SETTINGS,
  worstCaseCallMs: PS2D_WORST_CASE_CALL_MS,
  circuitBreaker: PS2D_CIRCUIT_BREAKER,
  maxTrackedAssets: PS2D_MAX_TRACKED_ASSETS,
  maxPersistedAssetRows: PS2D_MAX_PERSISTED_ASSET_ROWS,
});

export const PS2D_PROTOCOL_DIGEST = digestOf(PS2D_PROTOCOL_DEFINITION);
