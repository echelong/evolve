/**
 * Phase 5I-PS.2e — TEMPORALLY DISTRIBUTED LOCAL TEV SUPERVISOR SHADOW
 * (frozen protocol, precommitted before any live run).
 *
 * DEVELOPMENT SHADOW • ZERO AUTHORITY • PAPER ONLY. This is a NEW development
 * evidence class. It never reuses, relabels or reinterprets PS.2d TypeSafe
 * evidence, and it grants no trading, selection, evolution, Arena, deployment or
 * authority-promotion right to anything.
 *
 *   genuine EVOLVE production opportunity (unchanged engine tap)
 *           │
 *           ▼
 *   PS.2e zero-authority passive tap (copied facts only)
 *           │
 *           ▼
 *   PRECOMMITTED temporal admission scheduler (12 × 5 min, ≤10/bucket, ≤120/run)
 *           │
 *           ▼
 *   shared Local JEV client (decision-router `decision ask`, mode local-first)
 *           │
 *           ▼
 *   NobodyWho runtime + the Tev-style specialized option-token classifier
 *           │
 *           ▼
 *   SUPPORT / DO_NOT_SUPPORT / ABSTAIN (or an explicit FAILED/MALFORMED record)
 *           │
 *           ▼
 *   immutable PS.2e development evidence only
 *
 * TWO deliberate changes from PS.2d:
 *   1. the supervisor backend is the SHARED Local JEV architecture instead of a
 *      direct TypeSafe call;
 *   2. the primary decision model is the Tev-style specialized option-token
 *      classifier instead of a generic local decision LLM.
 *
 * HISTORY OF THE PRIMARY-MODEL BLOCKER (see `PS2E_PRIMARY_CLASSIFIER` and
 * `PS2e.md`): at precommit time the Local JEV installation found on this machine
 * exposed NO Tev-style specialist classifier — the
 * `togethercomputer/Tev1-4B-experimental` checkpoint has no published GGUF — so
 * PS.2e declared the primary classifier UNAVAILABLE and failed closed rather than
 * substitute a generic local model; the then-missing interface is retained in
 * `PS2E_MISSING_LOCAL_JEV_INTERFACE`. The shared installation now exposes a
 * genuine Tev-style specialist artifact of its own (fine-tuned Qwen3-0.6B, pinned
 * digest, worker-verified identity), so the pin is enabled against it. PS.2e
 * still fails closed on any identity mismatch and still never substitutes a
 * generic local model as the primary decision model.
 *
 * Nothing here may ever be flipped to an authority-bearing value.
 */

import { digestOf } from "../../lib/hash.mjs";

export const PS2E_PHASE = "5I-PS.2e";
export const PS2E_PROTOCOL_ID = "evolve-5i-ps2e-temporally-distributed-local-tev-shadow";
export const PS2E_PROTOCOL_VERSION = 1;
export const PS2E_SCHEMA_VERSION = 1;

export const PS2E_LABEL = "LOCAL TEV CROSS-ASSET SHADOW";
export const PS2E_AUTHORITY_TAG = "DEVELOPMENT SHADOW • ZERO AUTHORITY • PAPER ONLY";
export const PS2E_STATEMENT =
  "The shared Local JEV classifier passively observes a temporally bounded sample of genuine EVOLVE production " +
  "entry proposals across assets. It cannot approve, reject, resize, delay, reorder, replace, select or veto " +
  "anything. Development shadow evidence only: no profitability, trading, deployment or authority inference.";
export const PS2E_ISOLATION_STATEMENT =
  "Passive observer only: no wallet, no signer, no swap, no order, no write RPC, and no return value consumed by " +
  "any engine, evolution, selection, Arena or research code path. The engine never awaits a PS.2e result.";

/* ============================================================================
 * Evidence classification (never PS.2d's class, never CLEAN_JEV_DIRECTION_*)
 * ==========================================================================*/

export const PS2E_EVIDENCE_CLASSIFICATION = "DEVELOPMENT_CROSS_ASSET_TEV_SUPERVISOR_SHADOW";

/** Every PS.2e artifact carries exactly these flags. None may ever be flipped. */
export const PS2E_FLAGS = Object.freeze({
  evidenceClassification: PS2E_EVIDENCE_CLASSIFICATION,
  developmentOnly: true,
  paperOnly: true,
  shadowOnly: true,
  zeroAuthority: true,
  canonical: false,
  replication: false,
  temporalReplication: false,
  predictiveEvidence: false,
  noProfitabilityInference: true,
  noTradingInference: true,
  noDeploymentInference: true,
  noAuthorityPromotion: true,
  automaticPromotionPermitted: false,
  solDirectionEvidenceGeneralized: false,
  ps2dTypeSafeEvidenceReclassified: false,
  outcomeResolved: false,
  profitabilityClaim: false,
  winnerEmitted: false,
  assetsRanked: false,
});

/* ============================================================================
 * Genuine production opportunity (PS.2d definition, UNCHANGED)
 * ==========================================================================*/

/**
 * PS.2e does NOT define a second opportunity boundary. It reuses the frozen
 * PS.2d definition verbatim (imported at call time from
 * `cross-asset-packet.mjs#validateGenuineProductionEntry`) and the SAME engine
 * tap (`stepAgent → observeProductionEntry`, after `ctx.bestScore = bestScore`
 * and immediately before `openPosition`).
 */
export const PS2E_GENUINE_OPPORTUNITY_RULE =
  "identical to the frozen PS.2d boundary: one real call of the passive engine tap observeProductionEntry, " +
  "placed after ctx.bestScore = bestScore and immediately before openPosition(agent, best, ctx), with every PS.2d " +
  "genuineness requirement unchanged (flat agent, allowNewEntries, non-ABSTAIN posture, unchanged passesGates over " +
  "the unchanged scan, unchanged strict '>' argmax of unchanged scoreMarket, bestScore >= entryScoreThreshold)";

export const PS2E_PS2C_EXCLUSION =
  "PS.2c counterfactual data can never enter PS.2e eligibility, packet, digest or evidence; any fact carrying a " +
  "counterfactual key or the age_counterfactual marker is rejected as non-genuine";

/** Re-exported for readers: PS.2e adds no new non-genuine reason vocabulary. */
export const PS2E_NON_GENUINE_REASON_SOURCE = "cross-asset-packet.mjs#validateGenuineProductionEntry (PS.2d, frozen)";

/* ============================================================================
 * Asset identity (mint authoritative, symbol descriptive, baseMint-first)
 * ==========================================================================*/

/**
 * PS.2e keeps the PS.2d mint-derived identity (`baseMint` = selected market
 * mint, `quoteMint` = USDC numeraire, `marketId = <baseMint>/<quoteMint>`).
 * Because authority comes from `baseMint`/`quoteMint`, PS.2e ALSO exposes the
 * unambiguous `baseMint` key on every record and asset row so no reader has to
 * parse a shortened or hash-derived marketId. Historical PS.2d artifacts are not
 * touched, and PS.2d semantics are not redefined.
 */
export const PS2E_IDENTITY_RULE =
  "marketId = <baseMint>/<quoteMint>; baseMint = selected market mint (authoritative key for PS.2e readers); " +
  "quoteMint = USDC numeraire; symbol is descriptive only and never identity; PS.2d artifacts are unmodified";

export const PS2E_ASSET_ROW_KEY = "baseMint";

/* ============================================================================
 * PRECOMMITTED temporal admission scheduler (frozen before any live run)
 * ==========================================================================*/

export const PS2E_BUCKET_COUNT = 12;
export const PS2E_BUCKET_MS = 300_000; // 5 minutes
export const PS2E_PER_BUCKET_MAX_ADMISSIONS = 10;
export const PS2E_RUN_WINDOW_MS = PS2E_BUCKET_COUNT * PS2E_BUCKET_MS; // 60 minutes
export const PS2E_GLOBAL_MAX_ADMISSIONS = PS2E_PER_BUCKET_MAX_ADMISSIONS * PS2E_BUCKET_COUNT; // 120

/**
 * The scheduler depends ONLY on time and deterministic encounter order:
 * `temporalBucketIndex = floor((proposalAt - runStartedAt) / bucketMs)` bounded to
 * the frozen window. An opportunity belongs to exactly its own bucket, so no
 * bucket can ever borrow another bucket's quota, in either direction.
 */
export const PS2E_SCHEDULER_RULE =
  "temporalBucketIndex = floor((proposalAt - runStartedAt) / 300000), valid only inside [runStartedAt, " +
  "runStartedAt + 3600000); ≤10 admissions per bucket; ≤120 admissions per run; first eligible genuine " +
  "opportunities win in deterministic encounter order; NO ranking, NO cross-bucket quota borrowing, NO score, " +
  "margin, asset-performance, outcome, prior-decision, confidence, logit, latency, profitability or " +
  "market-direction dependence";

export const PS2E_ENCOUNTER_ORDER_RULE =
  "opportunities are decided in the order the engine produces them; WITHIN one engine tick the one shared PS.2d " +
  "fix is retained: the tick is buffered and processed in ascending opportunity digest order, never in " +
  "population/fitness order";

export const PS2E_NO_RANKING_RULE =
  "the scheduler never sorts, ranks, scores or compares candidates against each other beyond the frozen " +
  "first-match-wins precedence chain; quota never moves between buckets";

/** Why an admitted slot was NOT given to a schema-eligible opportunity. */
export const PS2E_SUPPRESSION_REASONS = Object.freeze({
  DUPLICATE_DIGEST: "suppressedDuplicateOpportunityDigest",
  PER_ASSET_CAP: "suppressedPerAssetCap",
  ASSET_COOLDOWN: "suppressedAssetCooldown",
  BUCKET_CAP: "suppressedBucketCap",
  GLOBAL_CAP: "suppressedGlobalCap",
  OUTSIDE_WINDOW: "suppressedOutsideWindow",
});

/** First match wins. Frozen. */
export const PS2E_SUPPRESSION_PRECEDENCE = Object.freeze([
  PS2E_SUPPRESSION_REASONS.OUTSIDE_WINDOW,
  PS2E_SUPPRESSION_REASONS.DUPLICATE_DIGEST,
  PS2E_SUPPRESSION_REASONS.PER_ASSET_CAP,
  PS2E_SUPPRESSION_REASONS.ASSET_COOLDOWN,
  PS2E_SUPPRESSION_REASONS.BUCKET_CAP,
  PS2E_SUPPRESSION_REASONS.GLOBAL_CAP,
]);

/**
 * The PS.2d per-asset diversity protections are RETAINED unchanged. Analysis
 * (recorded before any live run): they are time- and identity-only, they never
 * rank candidates, and the bucket cap is an independent bound — the two rules
 * cannot borrow quota from each other. A single hot asset may therefore take up
 * to `perAssetMax` of one bucket's slots, exactly as in PS.2d, and is then
 * suppressed for the rest of the run; that is a structural property of the
 * frozen protocol, not a result-driven choice.
 */
export const PS2E_PER_ASSET_MAX_ADMISSIONS_PER_RUN = 10;
export const PS2E_PER_ASSET_MIN_SPACING_MS = 60_000;
export const PS2E_PER_ASSET_CONTROLS_RETAINED_FROM = "PS.2d (cross-asset-protocol.mjs)";
export const PS2E_PER_ASSET_CONFLICT_ANALYSIS =
  "no conflict: both rules are deterministic, identity/time-only and independent; neither can be satisfied by " +
  "borrowing the other's quota";

/* ============================================================================
 * Run profiles
 * ==========================================================================*/

export const PS2E_PROFILES = Object.freeze({
  development: Object.freeze({
    profile: "development",
    bucketCount: PS2E_BUCKET_COUNT,
    bucketMs: PS2E_BUCKET_MS,
    perBucketMaxAdmissions: PS2E_PER_BUCKET_MAX_ADMISSIONS,
    runWindowMs: PS2E_RUN_WINDOW_MS,
    globalMaxAdmissions: PS2E_GLOBAL_MAX_ADMISSIONS,
    queueCapacity: PS2E_GLOBAL_MAX_ADMISSIONS,
    minimumMinutes: 60,
    recommendedMinutes: 60,
    purpose: "frozen 60-minute temporally distributed development shadow protocol",
  }),
});

/**
 * Offline validation only (never CLI-selectable): proves queue-full safety with a
 * capacity SMALLER than the admission ceiling. The CLI profiles keep
 * `queueCapacity === globalMaxAdmissions`, so in a real run an admitted
 * observation is never lost to a full queue.
 */
export const PS2E_OFFLINE_VALIDATION_PROFILE = Object.freeze({
  profile: "offline-validation",
  bucketCount: PS2E_BUCKET_COUNT,
  bucketMs: PS2E_BUCKET_MS,
  perBucketMaxAdmissions: PS2E_PER_BUCKET_MAX_ADMISSIONS,
  runWindowMs: PS2E_RUN_WINDOW_MS,
  globalMaxAdmissions: PS2E_GLOBAL_MAX_ADMISSIONS,
  queueCapacity: 2,
  minimumMinutes: 0,
  recommendedMinutes: 0,
  purpose: "offline validation of queue-full behaviour and bucket boundaries; refused by the CLI",
});

export const PS2E_CLI_PROFILES = Object.freeze(["development"]);

/** Resolve a profile by name. Unknown names are refused (fail closed). */
export function localTevProfileFor(name, { allowOfflineValidation = false } = {}) {
  if (name === PS2E_OFFLINE_VALIDATION_PROFILE.profile) {
    return allowOfflineValidation ? PS2E_OFFLINE_VALIDATION_PROFILE : null;
  }
  return Object.hasOwn(PS2E_PROFILES, name) ? PS2E_PROFILES[name] : null;
}

/* ============================================================================
 * Primary classifier policy — the Tev-style specialist
 * ==========================================================================*/

export const PS2E_CLASSIFIER_RUNTIME = "nobodywho";
export const PS2E_CLASSIFIER_PROVIDER = "nobodywho";
export const PS2E_LOCAL_JEV_MODE = "local-first";
export const PS2E_PRIMARY_TIER = "1";
export const PS2E_ESCALATION_TIERS = Object.freeze(["2"]);
export const PS2E_TYPESAFE_FALLBACK_TIER = "3";
export const PS2E_TYPESAFE_FALLBACK_PROVIDER = "jev";

/**
 * THINKING IS OFF. The shared Local JEV NobodyWho provider renders the state,
 * the question and the option ids, decodes every sample under a GBNF grammar
 * whose only sentences are the option ids (plus ABSTAIN when allowed), and stops
 * as soon as the text can only become one option id. The worker also passes
 * `enable_thinking: False` to the model template. PS.2e asks for no essay, no
 * chain of thought and no free-form reasoning.
 */
export const PS2E_THINKING_RULE =
  "off: option-token GBNF grammar constrains the entire completion to the allowed option ids (plus ABSTAIN when " +
  "allowed), and the shared local worker sets enable_thinking=false; no reasoning text is requested or possible";

/**
 * THE PRIMARY CLASSIFIER PIN.
 *
 * `available: true` is a measured statement about the Local JEV installation on
 * this machine: the shared decision-router exposes the genuine Tev-style
 * specialist `local-jev-tev-specialist-v1` on local-first tier 1 — a Qwen3-0.6B
 * base fine-tuned through the shared `specialist/` pipeline (LoRA r16, epoch
 * selected on the validation split only), exported as a distinct GGUF artifact
 * whose SHA-256 is pinned below. The shared installation verifies that artifact
 * cryptographically before any answer counts as a specialist answer: the worker
 * hashes the file it loads and the router records `loaded_artifact_digest`
 * evidence, failing closed with `PRIMARY_IDENTITY_MISMATCH` on any disagreement.
 *
 * DEVELOPMENT PROVENANCE PIN vs RUNTIME IDENTITY VERIFICATION: the
 * `localJevCompatibilityBaseline` below records WHICH shared Local JEV source
 * state this integration was completed against (development provenance only —
 * the shared CLI exposes no repository commit identity, so no runtime code may
 * require it). Runtime identity authority always comes from the classifier
 * identity, the artifact digest and the worker receipt the shared Local JEV
 * exposes per answer, checked against `pinnedModel` / `pinnedModelSha256`.
 *
 * History: this pin was precommitted with `available: false` because no Tev
 * specialist existed then (the `togethercomputer/Tev1-4B-experimental`
 * checkpoint has no published GGUF); `PS2E_MISSING_LOCAL_JEV_INTERFACE` retains
 * that record. A Tev-style specialist is now available, and the
 * governance-reviewed change contemplated at precommit time supplies
 * `pinnedModel` / `pinnedModelSha256` and sets `available: true`; nothing else
 * about the protocol changes.
 */
export const PS2E_PRIMARY_CLASSIFIER = Object.freeze({
  classifierId: "local-jev-tev-specialist-v1",
  classifierFamily: "tev-style-specialist",
  classifierKind: "specialized-option-token-classifier",
  classifierRuntime: PS2E_CLASSIFIER_RUNTIME,
  classifierProvider: PS2E_CLASSIFIER_PROVIDER,
  classifierMode: PS2E_LOCAL_JEV_MODE,
  primaryTier: PS2E_PRIMARY_TIER,
  thinkingEnabled: false,
  thinkingRule: PS2E_THINKING_RULE,
  grammarConstrainedOptionTokens: true,
  abstainIsProtocolOutcome: true,
  pinnedModel: "local-jev-tev-specialist-v1",
  pinnedModelSha256: "4b3fbb5e8ca29bca4e6982ff1cad49b7b2a9d0039241fad19bd474c7cdffc348",
  available: true,
  unavailableReason: null,
  // DEVELOPMENT PROVENANCE ONLY (never a runtime requirement): the shared Local
  // JEV source state this integration was verified against.
  localJevCompatibilityBaseline: "5454aa9ddb5aaa7217b1e05b4c2b1f412894f4a0",
  source:
    "the shared Local JEV decision-router (nobodywho fork, branch decision-router-dev) specialist pipeline and the " +
    "effective local config at $XDG_CONFIG_HOME/decision-router/config.json: tier 1 registers the Tev-style " +
    "specialist artifact (local-jev-tev-specialist-v1.gguf, sha256 " +
    "4b3fbb5e8ca29bca4e6982ff1cad49b7b2a9d0039241fad19bd474c7cdffc348, 1198182080 bytes) behind a provenance " +
    "manifest, and the worker-measured loaded artifact digest is verified against it on every answer",
});

/**
 * The Local JEV interface PS.2e was blocked on at precommit time — RETAINED as
 * the historical record of that blocker (it is now satisfied by the shared
 * installation; see `PS2E_PRIMARY_CLASSIFIER`). Never presented as a current
 * state claim.
 */
export const PS2E_MISSING_LOCAL_JEV_INTERFACE = Object.freeze([
  "a callable Tev-style specialist classifier served by the shared Local JEV (decision-router) local-first tier 1",
  "a stable classifier identity: classifier id, runtime (nobodywho), provider (nobodywho), tier name and a pinned model digest",
  "the Tev GGUF itself (public weights plus a pinned sha256) registered in the shared Local JEV config as tier 1",
  "a declared option-token vocabulary for the classifier (documented SUPPORT / DO_NOT_SUPPORT / ABSTAIN tokens) " +
    "so EVOLVE never has to infer tokens from a generic model's behavior",
]);

/**
 * Validation-only classifier policy. It is NEVER used by the CLI: it exists so
 * the offline validator can exercise the complete PS.2e contract against a
 * deterministic fixture transport without ever calling a live model. The
 * validator asserts that `scripts/jev-supervisor.mjs` references only
 * `PS2E_PRIMARY_CLASSIFIER`.
 */
export const PS2E_VALIDATION_CLASSIFIER_POLICY = Object.freeze({
  ...PS2E_PRIMARY_CLASSIFIER,
  validationOnly: true,
  available: true,
  unavailableReason: null,
  pinnedModel: "Tev1-4B-PS2E-VALIDATION-FIXTURE",
  pinnedModelSha256: "fixture-never-a-live-model-digest",
});

/** Fail-closed policy problems for a classifier policy object. */
export function classifierPolicyProblems(policy) {
  const problems = [];
  if (!policy || typeof policy !== "object") return ["classifier policy is missing"];
  if (policy.classifierRuntime !== PS2E_CLASSIFIER_RUNTIME) problems.push("classifierRuntime must be nobodywho");
  if (policy.classifierProvider !== PS2E_CLASSIFIER_PROVIDER) problems.push("classifierProvider must be nobodywho");
  if (policy.classifierMode !== PS2E_LOCAL_JEV_MODE) problems.push("classifierMode must be local-first");
  if (policy.primaryTier !== PS2E_PRIMARY_TIER) problems.push("primaryTier must be 1");
  if (policy.classifierKind !== "specialized-option-token-classifier") {
    problems.push("classifierKind must be specialized-option-token-classifier");
  }
  if (policy.thinkingEnabled !== false) problems.push("thinkingEnabled must be false");
  if (policy.grammarConstrainedOptionTokens !== true) problems.push("grammarConstrainedOptionTokens must be true");
  if (policy.abstainIsProtocolOutcome !== true) problems.push("abstainIsProtocolOutcome must be true");
  if (policy.available === true) {
    if (typeof policy.pinnedModel !== "string" || policy.pinnedModel.length === 0) {
      problems.push("an available classifier policy must pin pinnedModel");
    }
    if (typeof policy.pinnedModelSha256 !== "string" || !/^[0-9a-f]{16,64}$/.test(policy.pinnedModelSha256)) {
      if (!(policy.validationOnly === true)) problems.push("an available classifier policy must pin a model sha256");
    }
  }
  return problems;
}

/* ============================================================================
 * Decision vocabulary and provenance
 * ==========================================================================*/

/** The three classification outcomes a valid classifier answer may produce. */
export const PS2E_DECISIONS = Object.freeze({
  SUPPORT: "SUPPORT",
  DO_NOT_SUPPORT: "DO_NOT_SUPPORT",
  ABSTAIN: "ABSTAIN",
});

/** Non-classification record outcomes. NEVER converted into SUPPORT/DO_NOT_SUPPORT. */
export const PS2E_OUTCOMES = Object.freeze({
  FAILED: "FAILED",
  MALFORMED: "MALFORMED",
  UNAVAILABLE: "UNAVAILABLE",
});

export const PS2E_DECISION_VALUES = Object.freeze([
  PS2E_DECISIONS.SUPPORT,
  PS2E_DECISIONS.DO_NOT_SUPPORT,
  PS2E_DECISIONS.ABSTAIN,
  PS2E_OUTCOMES.FAILED,
  PS2E_OUTCOMES.MALFORMED,
  PS2E_OUTCOMES.UNAVAILABLE,
]);

/** Where the recorded decision actually came from. */
export const PS2E_DECISION_SOURCES = Object.freeze({
  PRIMARY_TEV_CLASSIFIER: "PRIMARY_TEV_CLASSIFIER",
  ESCALATED_LOCAL_TIER: "ESCALATED_LOCAL_TIER",
  FALLBACK_TYPESAFE_JEV: "FALLBACK_TYPESAFE_JEV",
  PRIMARY_IDENTITY_MISMATCH: "PRIMARY_IDENTITY_MISMATCH",
  PRIMARY_CLASSIFIER_UNAVAILABLE: "PRIMARY_CLASSIFIER_UNAVAILABLE",
  LOCAL_JEV_UNAVAILABLE: "LOCAL_JEV_UNAVAILABLE",
  FAILED: "FAILED",
  MALFORMED: "MALFORMED",
  ABSTAINED_WITHOUT_ACCEPTED_TIER: "ABSTAINED_WITHOUT_ACCEPTED_TIER",
  SKIPPED_POLICY_INVALID: "SKIPPED_POLICY_INVALID",
  SKIPPED_PRIMARY_CLASSIFIER_UNAVAILABLE: "SKIPPED_PRIMARY_CLASSIFIER_UNAVAILABLE",
  SKIPPED_LOCAL_JEV_UNAVAILABLE: "SKIPPED_LOCAL_JEV_UNAVAILABLE",
  SKIPPED_CIRCUIT_OPEN: "SKIPPED_CIRCUIT_OPEN",
  SKIPPED_REQUEST_TOO_LARGE: "SKIPPED_REQUEST_TOO_LARGE",
});

/** Record dispositions (one per admitted observation; bounded set). */
export const PS2E_DISPOSITIONS = Object.freeze({
  SUPPORT: "SUPPORT",
  DO_NOT_SUPPORT: "DO_NOT_SUPPORT",
  ABSTAIN: "ABSTAIN",
  FAILED: "FAILED",
  MALFORMED: "MALFORMED",
  UNAVAILABLE: "UNAVAILABLE",
  SKIPPED_POLICY_INVALID: "SKIPPED_POLICY_INVALID",
  SKIPPED_PRIMARY_CLASSIFIER_UNAVAILABLE: "SKIPPED_PRIMARY_CLASSIFIER_UNAVAILABLE",
  SKIPPED_LOCAL_JEV_UNAVAILABLE: "SKIPPED_LOCAL_JEV_UNAVAILABLE",
  SKIPPED_CIRCUIT_OPEN: "SKIPPED_CIRCUIT_OPEN",
  SKIPPED_REQUEST_TOO_LARGE: "SKIPPED_REQUEST_TOO_LARGE",
  QUEUE_DROPPED: "QUEUE_DROPPED",
  UNSENT_AT_FINALIZE: "UNSENT_AT_FINALIZE",
  IN_FLIGHT_AT_FINALIZE: "IN_FLIGHT_AT_FINALIZE",
});

/** Latency groups the report separates (never merged into one number). */
export const PS2E_LATENCY_GROUPS = Object.freeze([
  "primaryTevResults",
  "escalatedLocalResults",
  "typesafeFallbackResults",
  "allLogicalRequests",
]);

export const PS2E_LATENCY_METRICS = Object.freeze([
  "queueWaitMs",
  "packetBuildMs",
  "localClientDispatchMs",
  "localJevReportedLatencyMs",
  "primaryAttemptLatencyMs",
  "escalationLatencyMs",
  "fallbackLatencyMs",
  "totalE2EMs",
]);

/** Measurements the runtime does NOT provide. Recorded as null, never invented. */
export const PS2E_UNAVAILABLE_MEASUREMENTS = Object.freeze([
  "nobodyWhoDispatchMs",
  "classifierInferenceMs",
  "inputTokens",
  "outputTokens",
]);

export const PS2E_COLD_OR_WARM_RULE =
  "coldOrWarm is reported only when the shared local worker states it honestly (persistent worker and model_reused " +
  "flags in the accepted decision's details); otherwise null";

/* ============================================================================
 * Local JEV client boundary (shared implementation, no fork)
 * ==========================================================================*/

/** The shared Local JEV CLI boundary: `decision ask`, JSON on stdin, JSON out. */
export const PS2E_LOCAL_JEV_CLI_COMMAND = "decision";
export const PS2E_LOCAL_JEV_CLI_SUBCOMMAND = "ask";
export const PS2E_LOCAL_JEV_CALLER = "evolve";
export const PS2E_LOCAL_JEV_EXECUTABLE_ENV = "EVOLVE_LOCAL_JEV_BIN";

/** The complete request contract the shared implementation accepts. */
export const PS2E_LOCAL_JEV_CONTRACT = Object.freeze({
  interface: "decision ask (JSON on stdin, one JSON object on stdout)",
  mode: PS2E_LOCAL_JEV_MODE,
  caller: PS2E_LOCAL_JEV_CALLER,
  minChoices: 2,
  maxChoices: 12,
  choiceIdPattern: "^[a-z][a-z0-9_]{0,47}$",
  reservedChoice: "ABSTAIN",
  allowAbstainSupported: true,
  maxStateChars: 16_000,
  maxQuestionChars: 1_000,
  risks: Object.freeze(["low", "medium", "high"]),
  unknownRequestFields: "rejected by the shared implementation",
});

/** Frozen logical-call bound. Derived worst case must fit inside it. */
export const PS2E_LOGICAL_CALL_TIMEOUT_MS = 180_000;

/**
 * THREE distinct time bounds, never conflated (readiness reports all three):
 *
 *   router theoretical worst case  the shared Local JEV's own worst-case logical
 *                                  call AFTER effective/default tier timeouts,
 *                                  per-tier retries and any enabled provider
 *                                  fallback are resolved. Readiness derives it
 *                                  and fails closed when it exceeds the bound
 *                                  below.
 *   EVOLVE child hard timeout      PS2E_LOGICAL_CALL_TIMEOUT_MS — the child
 *                                  process group is terminated at this bound.
 *   PS.2e finalization budget      this budget: finalization drains in-flight and
 *                                  queued work within it and then records an
 *                                  honest timed-out finalize / in-flight record;
 *                                  a late answer is ignored, never awaited.
 */
export const PS2E_FINALIZATION_BUDGET_MS = 5_000;

export const PS2E_LOCAL_JEV_MAX_STDOUT_BYTES = 1 << 20;
export const PS2E_LOCAL_JEV_MAX_STDERR_BYTES = 1 << 16;

/** The shared router's own bounds, used to derive the physical-attempt ceiling. */
export const PS2E_LOCAL_TIER_COUNT_CEILING = 2; // tier 1 (primary), tier 2 (escalation)
export const PS2E_MAX_LOCAL_RETRIES_CEILING = 3; // acceptance.max_local_retries is bounded to 0..3 by Local JEV
export const PS2E_FALLBACK_TIER_CEILING = 1; // tier 3 TypeSafe, only when the shared system enables it
export const PS2E_PHYSICAL_ATTEMPT_CEILING_PER_LOGICAL_CALL =
  PS2E_LOCAL_TIER_COUNT_CEILING * (1 + PS2E_MAX_LOCAL_RETRIES_CEILING) + PS2E_FALLBACK_TIER_CEILING; // 9

/**
 * The whitespace the shared interpreter's `int(...)` AND `float(...)` strip
 * around a numeral, measured on the pinned router's own Python (the
 * `decision-router` venv interpreter, Python 3.14): ASCII \t \n \v \f \r and
 * space, U+0085, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F
 * and U+3000. This is NOT JavaScript's `trim()` set in EITHER direction:
 * U+FEFF is not Python whitespace (`int("\uFEFF3")` and `float("\uFEFF0.5")`
 * both raise) although `trim()` would strip it, and U+001C–U+001F are not
 * stripped by either (the pinned Python raises on them). This is the single
 * shared whitespace-strip helper for the integer AND float mirrors.
 */
const PYTHON_WHITESPACE = "[\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const PYTHON_WHITESPACE_TRIM = new RegExp(`^${PYTHON_WHITESPACE}+|${PYTHON_WHITESPACE}+$`, "g");

/** Strip exactly the whitespace Python's `int(...)`/`float(...)` coerce strips. */
export function stripPythonWhitespace(text) {
  return text.replace(PYTHON_WHITESPACE_TRIM, "");
}

/**
 * Mirror of the shared implementation's `int(...)` coercion over JSON values
 * (`acceptance.Policy.from_config` and the local provider's settings both call
 * Python `int(...)` on config values). The shared semantics, verbatim:
 *
 *   - booleans coerce to 1 / 0 (`int(True)` / `int(False)`);
 *   - finite numbers truncate toward zero (`int(1.5)` == 1, `int(-0.5)` == 0);
 *   - decimal integer strings coerce (`int("3")` == 3, `int(" 3 ")` == 3,
 *     `int("+2")` == 2, single underscores between digits allowed), with
 *     leading/trailing whitespace stripped EXACTLY as the shared interpreter
 *     strips it (`stripPythonWhitespace`): the pinned Python whitespace set,
 *     never JavaScript's `trim()` set. U+FEFF is therefore refused here just
 *     as `int("\uFEFF3")` raises there — a BOM-wrapped integer is NEVER a
 *     valid value — and U+0085-wrapped integers coerce exactly like Python;
 *   - anything else raises there (fractional strings like "1.5", floats'
 *     NaN/Infinity representations, null, objects) and is rejected here.
 *
 * Returns the coerced value, or `null` when the shared `int(...)` would raise
 * (an EXPLICIT invalid result every caller reports as a config refusal — never
 * silently normalized to 0 or null-as-default). Two conservative refusals fail
 * closed where Python would still produce an integer:
 *
 *   - a string of non-ASCII decimal digits (the two runtimes' Unicode digit
 *     tables need not agree);
 *   - an effective integer outside JavaScript's exact safe-integer range
 *     (`Number.isSafeInteger`, |n| <= 2^53 - 1): Python keeps such integers
 *     exactly, a JavaScript Number cannot, so EVOLVE never accepts — and never
 *     persists or digests — a rounded integer. `9007199254740991` is accepted;
 *     `9007199254740992` and beyond are refused.
 *
 * Rejection is always the conservative direction.
 */
export function sharedIntegerValue(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const truncated = Math.trunc(value);
    if (!Number.isSafeInteger(truncated)) return null; // exact-representability refusal
    return truncated === 0 ? 0 : truncated;
  }
  if (typeof value === "string") {
    const text = stripPythonWhitespace(value);
    if (!/^[+-]?[0-9](?:_?[0-9])*$/.test(text)) return null;
    const parsed = Number.parseInt(text.replace(/_/g, ""), 10);
    // Any integer above 2^53 - 1 parses to >= 2^53, so the check never admits a rounded value.
    return Number.isSafeInteger(parsed) ? (parsed === 0 ? 0 : parsed) : null;
  }
  return null;
}

/**
 * The EFFECTIVE shared `acceptance.max_local_retries` value — the exact
 * normalization the shared Local JEV applies before routing
 * (`acceptance.Policy.from_config`: `int(a.get("max_local_retries", 0))`, then
 * `0 <= value <= 3` or the config is refused):
 *
 *   - missing (never stored) resolves to the shared default 0;
 *   - `0..3`, `"0".."3"`, `1.0`, `1.5` -> 1, `2.9` -> 2, `true` -> 1,
 *     `false` -> 0 all resolve like the shared `int(...)`;
 *   - null, fractional strings ("1.5"), non-numeric strings, NaN/Infinity,
 *     negatives and values above 3 make the shared router raise on EVERY call
 *     (`router_error`), so EVOLVE reports them as unnormalizable and readiness
 *     fails closed — never as zero retries.
 *
 * @returns {{ ok: boolean, effectiveRetries: number|null, problem: string|null }}
 */
export function effectiveLocalRetries(value) {
  if (value === undefined) {
    // The shared config merge resolves a missing key to its default of 0.
    return { ok: true, effectiveRetries: 0, problem: null };
  }
  const coerced = sharedIntegerValue(value);
  if (coerced === null) {
    return {
      ok: false,
      effectiveRetries: null,
      problem:
        "acceptance.max_local_retries is not coercible with the shared `int(...)` semantics, or is outside the exact safe-integer range",
    };
  }
  if (coerced < 0 || coerced > PS2E_MAX_LOCAL_RETRIES_CEILING) {
    return {
      ok: false,
      effectiveRetries: null,
      problem: `acceptance.max_local_retries must be within 0..${PS2E_MAX_LOCAL_RETRIES_CEILING} after shared coercion (the shared Policy refuses the config)`,
    };
  }
  return { ok: true, effectiveRetries: coerced === 0 ? 0 : coerced, problem: null };
}

/**
 * The physical-attempt ceiling actually derived from the SHARED router's exact
 * local-first semantics (no retry/escalation policy is invented by EVOLVE):
 *
 *   - the shared router always iterates its fixed decision-tier slots
 *     (PS2E_LOCAL_TIER_COUNT_CEILING of them: tier 1 primary, tier 2 escalation)
 *     on every logical call, in order, stopping at the first accepted answer;
 *   - a slot whose tier is model-configured can consume up to
 *     `1 + max_local_retries` physical attempts (retries only for retryable
 *     rejections: stability/below-margin, abstain, no valid choice);
 *   - an unconfigured slot records exactly ONE failed physical attempt when it
 *     is reached (a non-retryable failure is never retried);
 *   - the optional TypeSafe fallback tier adds exactly one physical attempt.
 *
 * `maxLocalRetries` MUST be the normalized effective retry count
 * (`effectiveLocalRetries`); a value the shared parser would reject yields
 * `null` — fail closed, never a smaller number.
 */
export function physicalAttemptCeilingFor({ configuredLocalTiers, maxLocalRetries, typesafeFallbackEnabled } = {}) {
  const retryResolution = effectiveLocalRetries(maxLocalRetries);
  if (!retryResolution.ok) return null;
  const retries = retryResolution.effectiveRetries;
  const configured =
    Number.isInteger(configuredLocalTiers) && configuredLocalTiers >= 0
      ? Math.min(configuredLocalTiers, PS2E_LOCAL_TIER_COUNT_CEILING)
      : PS2E_LOCAL_TIER_COUNT_CEILING;
  const unconfiguredSlots = PS2E_LOCAL_TIER_COUNT_CEILING - configured;
  const fallback = typesafeFallbackEnabled === true ? PS2E_FALLBACK_TIER_CEILING : 0;
  return configured * (1 + retries) + unconfiguredSlots + fallback;
}

export const PS2E_MAX_LOGICAL_CALLS_PER_RUN = PS2E_GLOBAL_MAX_ADMISSIONS;
export const PS2E_MAX_PHYSICAL_ATTEMPTS_PER_RUN =
  PS2E_GLOBAL_MAX_ADMISSIONS * PS2E_PHYSICAL_ATTEMPT_CEILING_PER_LOGICAL_CALL;

/** Circuit breaker for the LOCAL client processes (never for a remote model). */
export const PS2E_CIRCUIT_BREAKER = Object.freeze({ failureThreshold: 5, cooldownMs: 120_000 });

/**
 * The Governance v1 external-call policy of the PS.2e classifier boundary.
 *
 * EVOLVE adds NO retry of its own (`retryCap: 0`): the shared Local JEV router
 * owns its own bounded retry/escalation policy, which is why the physical-attempt
 * ceiling is derived from the shared configuration rather than declared here.
 * `fallback: "none"` describes THIS boundary — PS.2e never routes to another
 * provider of its own; any escalation to a generic local tier or to the TypeSafe
 * fallback happens INSIDE the shared implementation and is recorded per
 * observation with its actual route.
 */
export function localTevExternalCallPolicy({ policy, profile } = {}) {
  return {
    timeoutMs: PS2E_LOGICAL_CALL_TIMEOUT_MS,
    retryCap: 0,
    maxCallsPerRun: profile?.globalMaxAdmissions ?? PS2E_GLOBAL_MAX_ADMISSIONS,
    provider: `local-jev:${policy?.classifierId ?? PS2E_PRIMARY_CLASSIFIER.classifierId}`,
    model: policy?.pinnedModel ?? "unavailable-no-classifier",
    fallback: "none",
    cache:
      "none: every admitted observation is sent exactly once; no provider-response cache and no cross-run reuse; the " +
      "shared implementation's own receipt ledger is its own record and is never read back as a decision",
    authorityLevel: "SHADOW",
    circuitBreaker: { ...PS2E_CIRCUIT_BREAKER },
    failClosed: true,
    evidenceBearing: true,
    evidenceReference: null,
    pricingKnown: false,
    costAccounting:
      "local inference only: a local NobodyWho tier charges no API fee; the shared implementation may escalate to " +
      "its TypeSafe fallback tier, whose pricing is unknown, so no cost is inferred",
  };
}

/* ============================================================================
 * Question set identity (the question itself lives in local-tev-questions.mjs)
 * ==========================================================================*/

export const PS2E_QUESTION_SET_ID = "jev-cross-asset-production-opportunity-tev-v1";
export const PS2E_QUESTION_SET_VERSION = 1;
export const PS2E_QUESTION_ID = "evolve_production_opportunity_classification";
export const PS2E_QUESTION_NAME = "productionOpportunityClassification";

/* ============================================================================
 * Packet + complete input digest
 * ==========================================================================*/

export const PS2E_PACKET_VERSION = 2;
export const PS2E_PACKET_KIND = "EVOLVE_CROSS_ASSET_PRODUCTION_PROPOSAL";

export const PS2E_PACKET_LIMITATIONS = Object.freeze([
  "Pre-outcome facts only: every value was available to the EVOLVE paper engine at or before proposalAt.",
  "USD reference prices come from EVOLVE's observation feed; no order book, spread, route, L2 or L3 data exists here.",
  "The proposal is EVOLVE's own finalized paper entry; this request has zero authority over it.",
  "No future price, execution result, outcome, horizon, PnL, fill or counterfactual field exists in this packet.",
  "The classification is a report about these frozen facts only: not correctness, not a forecast, not a signal.",
]);

export const PS2E_DIGEST_RULE =
  "jevInputDigest = digestOf({ protocol, provider(runtime+classifier identity+configuration), routing configuration, " +
  "questionSetId, questionSetVersion, question, options, allowAbstain, packet, limitations }) over the COMPLETE " +
  "model-visible payload; no partial-state digest and no volatile-field exclusion";

/** Diagnostics carried on the packet: sampling provenance only, never model input. */
export const PS2E_TEMPORAL_PROVENANCE_KEYS = Object.freeze([
  "temporalBucketIndex",
  "temporalBucketCount",
  "temporalBucketStart",
  "temporalBucketEnd",
  "bucketAdmissionIndex",
  "globalAdmissionIndex",
  "opportunitySequence",
  "engineTick",
]);

export const PS2E_ENGINE_TICK_RULE =
  "the engine exposes generation + generationTick but no global tick counter, so PS.2e derives the smallest " +
  "deterministic observer-safe ordinal: engineTick increments when the (generation, generationTick) key changes in " +
  "encounter order, and opportunitySequence counts genuine opportunities in encounter order; neither is read by " +
  "the engine and neither changes an engine decision";

/* ============================================================================
 * Bounded storage / dashboard
 * ==========================================================================*/

export const PS2E_OBSERVATIONS_FILE = "local-tev-observations.ndjson";
export const PS2E_MAX_TRACKED_ASSETS = 2_048;
export const PS2E_MAX_PERSISTED_ASSET_ROWS = 128;
export const PS2E_MAX_DASHBOARD_ASSET_ROWS = 32;
export const PS2E_MAX_PERSISTED_BUCKET_ROWS = PS2E_BUCKET_COUNT;
export const PS2E_MAX_PERSISTED_ATTEMPTS_PER_RECORD = 8;
export const PS2E_RECENT_ROW_LIMIT = 16;
export const PS2E_MAX_FAILURE_REASON_LENGTH = 240;
export const PS2E_TICK_BUFFER_LIMIT = 4_096;

/* ============================================================================
 * Frozen protocol digest (persisted with every PS.2e session)
 * ==========================================================================*/

export const PS2E_PROTOCOL_DEFINITION = Object.freeze({
  phase: PS2E_PHASE,
  protocolId: PS2E_PROTOCOL_ID,
  protocolVersion: PS2E_PROTOCOL_VERSION,
  flags: PS2E_FLAGS,
  genuineOpportunityRule: PS2E_GENUINE_OPPORTUNITY_RULE,
  ps2cExclusion: PS2E_PS2C_EXCLUSION,
  identityRule: PS2E_IDENTITY_RULE,
  schedulerRule: PS2E_SCHEDULER_RULE,
  encounterOrderRule: PS2E_ENCOUNTER_ORDER_RULE,
  noRankingRule: PS2E_NO_RANKING_RULE,
  bucketCount: PS2E_BUCKET_COUNT,
  bucketMs: PS2E_BUCKET_MS,
  perBucketMaxAdmissions: PS2E_PER_BUCKET_MAX_ADMISSIONS,
  runWindowMs: PS2E_RUN_WINDOW_MS,
  globalMaxAdmissions: PS2E_GLOBAL_MAX_ADMISSIONS,
  suppressionPrecedence: PS2E_SUPPRESSION_PRECEDENCE,
  perAssetMaxAdmissionsPerRun: PS2E_PER_ASSET_MAX_ADMISSIONS_PER_RUN,
  perAssetMinSpacingMs: PS2E_PER_ASSET_MIN_SPACING_MS,
  profiles: PS2E_PROFILES,
  classifier: PS2E_PRIMARY_CLASSIFIER,
  missingLocalJevInterface: PS2E_MISSING_LOCAL_JEV_INTERFACE,
  decisions: PS2E_DECISIONS,
  outcomes: PS2E_OUTCOMES,
  decisionSources: PS2E_DECISION_SOURCES,
  localJevContract: PS2E_LOCAL_JEV_CONTRACT,
  logicalCallTimeoutMs: PS2E_LOGICAL_CALL_TIMEOUT_MS,
  circuitBreaker: PS2E_CIRCUIT_BREAKER,
  physicalAttemptCeilingPerLogicalCall: PS2E_PHYSICAL_ATTEMPT_CEILING_PER_LOGICAL_CALL,
  questionSetId: PS2E_QUESTION_SET_ID,
  questionSetVersion: PS2E_QUESTION_SET_VERSION,
  packetVersion: PS2E_PACKET_VERSION,
  packetKind: PS2E_PACKET_KIND,
  digestRule: PS2E_DIGEST_RULE,
  engineTickRule: PS2E_ENGINE_TICK_RULE,
  thinkingRule: PS2E_THINKING_RULE,
  maxTrackedAssets: PS2E_MAX_TRACKED_ASSETS,
  maxPersistedAssetRows: PS2E_MAX_PERSISTED_ASSET_ROWS,
});

export const PS2E_PROTOCOL_DIGEST = digestOf(PS2E_PROTOCOL_DEFINITION);
