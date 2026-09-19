/**
 * Phase 5H.0 — FROZEN deterministic classifier-derived feature definition (PAPER ONLY, DESCRIPTIVE).
 *
 * Phase 5H.0 is a pure DETERMINISTIC TRANSFORMATION over already-frozen evidence:
 *
 *   frozen 5G.1 cohort → verify → verify classifier experiments → verify source captures
 *     → classifier-feature-definition-v1 → record-level extraction → feature artifact → STOP
 *
 * This module owns the ONLY thing Phase 5H.0 may never make dynamic: the exact
 * feature names, their order, the frozen thresholds and the one-entry evidence
 * class mapping. It IMPORTS (never redeclares) the classifier identity from the
 * sealed Phase 5G.0 definition, so a future classifier version cannot silently
 * change what a 5H.0 feature means.
 *
 * The derived features are DESCRIPTIVE ONLY. They are NOT alpha, NOT signal
 * strength, NOT sentiment, NOT trading direction, NOT project quality, NOT
 * legitimacy, NOT fraud probability, NOT profitability, NOT expected return, NOT
 * market health and NOT buy/sell probability.
 *
 * There is NO routing from 5H.0: Jev, DeepSeek, Arena and trading stay false.
 */

import { digestOf } from "../lib/hash.mjs";
import {
  CLASSIFIER_DEFINITION_DIGEST,
  CLASSIFIER_ID,
  CLASSIFIER_INSTRUCTIONS_DIGEST,
  CLASSIFIER_LABELS,
  CLASSIFIER_VERSION,
  INPUT_PROJECTION_VERSION,
} from "./classifier-definition.mjs";

export const FEATURE_DEFINITION_VERSION = "classifier-feature-definition-v1";
export const FEATURE_PHASE = "5H.0";
export const FEATURE_SCHEMA_VERSION = 1;

/** Evidence in: DEVELOPMENT classifier evidence. Evidence out: DEVELOPMENT derived features. */
export const SOURCE_EVIDENCE_CLASS = "DEVELOPMENT_CLASSIFIER_EVIDENCE";
export const DERIVED_EVIDENCE_CLASS = "DEVELOPMENT_CLASSIFIER_DERIVED_FEATURES";

/** Entropy is normalized over the ENTIRE frozen taxonomy, never over observed labels. */
export const ENTROPY_NORMALIZATION_K = 9;
export const ENTROPY_LOG_BASE = "natural";

/** Fixed DESCRIPTIVE thresholds. `0.50` is NOT low; `0.90` IS high; `0.10` is NOT ambiguous. */
export const CONFIDENCE_LOW = Object.freeze({ comparator: "lt", threshold: 0.5 });
export const CONFIDENCE_HIGH = Object.freeze({ comparator: "gte", threshold: 0.9 });
export const MARGIN_AMBIGUOUS = Object.freeze({ comparator: "lt", threshold: 0.1 });

export const SCORE_VECTOR_COMPLETENESS = "all_nine_labels_present";
export const ROUNDING = "round6";
export const QUANTILE_METHOD = "linear_interpolation_sorted_ascending";
/**
 * Each record's margin is rounded to 6 decimals BEFORE aggregation, so the
 * persisted mean/median/ambiguous-fraction reproduce the sealed 5G.1 scoreMargin
 * diagnostics exactly.
 */
export const SCORE_MARGIN_ROUNDING = "round6_per_record_before_aggregation";
export const FEATURE_VALUE_DOMAIN = "number|null";

export const LABEL_FEATURE_PREFIX = "label_fraction_";

export function labelFeatureName(label) {
  return `${LABEL_FEATURE_PREFIX}${label}`;
}

/** The nine label-fraction features, in frozen taxonomy order. */
export const LABEL_FEATURES = Object.freeze(CLASSIFIER_LABELS.map(labelFeatureName));

/** Concentration features derived from the pooled label distribution. */
export const CONCENTRATION_FEATURES = Object.freeze([
  "observed_label_count",
  "label_entropy_normalized",
  "largest_label_fraction",
]);

/** Confidence features over the pooled classified records. */
export const CONFIDENCE_FEATURES = Object.freeze([
  "confidence_mean",
  "confidence_median",
  "confidence_low_fraction",
  "confidence_high_fraction",
]);

/** Top-1/top-2 score-margin features over COMPLETE score vectors only. */
export const SCORE_MARGIN_FEATURES = Object.freeze([
  "score_margin_mean",
  "score_margin_median",
  "score_margin_ambiguous_fraction",
]);

/** EXACTLY 19 canonical feature keys, in this order. Never extended dynamically. */
export const FEATURE_NAMES = Object.freeze([
  ...LABEL_FEATURES,
  ...CONCENTRATION_FEATURES,
  ...CONFIDENCE_FEATURES,
  ...SCORE_MARGIN_FEATURES,
]);

/**
 * Documentation-only families. These are NOT persisted features and NOT
 * aggregate "group" features: the definition carries `groups: {}` and the
 * artifact audit rejects persisted group-like keys.
 */
export const FEATURE_FAMILIES = Object.freeze({
  label_fraction: LABEL_FEATURES,
  concentration: CONCENTRATION_FEATURES,
  confidence: CONFIDENCE_FEATURES,
  score_margin: SCORE_MARGIN_FEATURES,
});

/**
 * Presentation aliases ONLY. They are the SAME features, never additional ones:
 *   noise_fraction     → label_fraction_unrelated_or_noise
 *   promotion_fraction → label_fraction_promotion_or_marketing
 */
export const FEATURE_ALIASES = Object.freeze({
  noise_fraction: "label_fraction_unrelated_or_noise",
  promotion_fraction: "label_fraction_promotion_or_marketing",
});

/** No grouped semantic features in v1. The artifact audit enforces this. */
export const FEATURE_GROUPS = Object.freeze({});

/** The frozen one-entry evidence-class transition. Anything else fails closed. */
export const EVIDENCE_CLASS_MAP = Object.freeze({
  [SOURCE_EVIDENCE_CLASS]: DERIVED_EVIDENCE_CLASS,
});

/**
 * Frozen semantic-smuggling pattern set (regex SOURCES, kept as data so the
 * definition digest covers them). A persisted feature key matching any of these
 * is refused — these are exactly the meanings 5H.0 must never claim.
 */
export const FORBIDDEN_FEATURE_NAME_PATTERNS = Object.freeze([
  "bullish",
  "bearish",
  "alpha",
  "signal_strength",
  "opportunity",
  "risk_score",
  "legitimacy",
  "quality",
  "fraud",
  "buy",
  "sell",
  "profit",
  "pnl",
  "expected_return",
  "market_health",
  "token_quality",
  "direction",
  "sentiment",
  "scam",
  "pump",
  "wallet",
  "swap",
  "rpc",
  "trade",
  "transaction",
  "signer",
  "accuracy",
  "precision",
  "recall",
  "roc_auc",
  "calibration",
  "verdict",
]);

/** The pattern set, compiled once, frozen. */
export const FORBIDDEN_FEATURE_NAME_REGEXES = Object.freeze(
  FORBIDDEN_FEATURE_NAME_PATTERNS.map((source) => new RegExp(source, "i")),
);

/** Aggregate "group" keys explicitly refused even if a name escapes the patterns. */
export const FORBIDDEN_GROUP_FEATURE_KEYS = Object.freeze([
  "technical_fraction",
  "market_structure_fraction",
  "governance_admin_fraction",
  "announcement_fraction",
]);

export class FeatureEvidenceClassError extends Error {
  constructor(sourceEvidenceClass) {
    super(
      `source evidence class '${String(sourceEvidenceClass)}' is not mapped by '${FEATURE_DEFINITION_VERSION}' — ` +
        `Phase 5H.0 accepts ONLY '${SOURCE_EVIDENCE_CLASS}' and maps it to '${DERIVED_EVIDENCE_CLASS}'`,
    );
    this.name = "FeatureEvidenceClassError";
    this.sourceEvidenceClass = sourceEvidenceClass;
  }
}

/** The frozen one-entry transition. Anything unmapped fails closed. */
export function mapEvidenceClass(sourceEvidenceClass) {
  const mapped = EVIDENCE_CLASS_MAP[sourceEvidenceClass];
  if (!mapped) throw new FeatureEvidenceClassError(sourceEvidenceClass);
  return mapped;
}

/** True when a feature key carries a meaning 5H.0 must never claim. */
export function isForbiddenFeatureName(name) {
  const key = String(name ?? "");
  if (FORBIDDEN_GROUP_FEATURE_KEYS.includes(key)) return true;
  return FORBIDDEN_FEATURE_NAME_REGEXES.some((pattern) => pattern.test(key));
}

/**
 * Fail-closed self-check of the frozen definition. Returns the list of problems
 * (empty means the definition is intact). Called by the core module before any
 * extraction, so a changed taxonomy can never be silently reinterpreted.
 */
export function assertFeatureDefinitionIntegrity() {
  const problems = [];
  if (FEATURE_NAMES.length !== 19) problems.push(`v1 requires exactly 19 feature names (got ${FEATURE_NAMES.length})`);
  if (new Set(FEATURE_NAMES).size !== FEATURE_NAMES.length) problems.push("feature names must be unique");
  if (CLASSIFIER_LABELS.length !== ENTROPY_NORMALIZATION_K) {
    problems.push(`entropyNormalizationK must equal the frozen taxonomy size (${CLASSIFIER_LABELS.length})`);
  }
  if (Object.keys(FEATURE_GROUPS).length !== 0) problems.push("v1 must not define any feature group");
  if (Object.keys(EVIDENCE_CLASS_MAP).length !== 1) problems.push("the evidence class map must have exactly one entry");
  if (EVIDENCE_CLASS_MAP[SOURCE_EVIDENCE_CLASS] !== DERIVED_EVIDENCE_CLASS) problems.push("the evidence class transition is not frozen");
  for (const name of FEATURE_NAMES) {
    if (isForbiddenFeatureName(name)) problems.push(`canonical feature name '${name}' matches a forbidden pattern`);
  }
  for (const [alias, target] of Object.entries(FEATURE_ALIASES)) {
    if (FEATURE_NAMES.includes(alias)) problems.push(`alias '${alias}' must not be a persisted feature`);
    if (!FEATURE_NAMES.includes(target)) problems.push(`alias '${alias}' must point at a canonical feature`);
  }
  if (!Object.isFrozen(FEATURE_NAMES) || !Object.isFrozen(FEATURE_GROUPS) || !Object.isFrozen(EVIDENCE_CLASS_MAP)) {
    problems.push("the frozen definition containers must be frozen");
  }
  return { ok: problems.length === 0, problems };
}

/**
 * The FROZEN definition of `classifier-feature-definition-v1`. Its digest is the
 * pin every artifact carries; it is computed, never hard-coded.
 */
export const FEATURE_DEFINITION = Object.freeze({
  definitionVersion: FEATURE_DEFINITION_VERSION,
  phase: FEATURE_PHASE,
  classifierId: CLASSIFIER_ID,
  classifierVersion: CLASSIFIER_VERSION,
  taxonomyLabels: CLASSIFIER_LABELS,
  classifierDefinitionDigest: CLASSIFIER_DEFINITION_DIGEST,
  instructionsDigest: CLASSIFIER_INSTRUCTIONS_DIGEST,
  inputProjectionVersion: INPUT_PROJECTION_VERSION,
  entropyNormalizationK: ENTROPY_NORMALIZATION_K,
  entropyLogBase: ENTROPY_LOG_BASE,
  confidenceLow: CONFIDENCE_LOW,
  confidenceHigh: CONFIDENCE_HIGH,
  marginAmbiguous: MARGIN_AMBIGUOUS,
  scoreVectorCompleteness: SCORE_VECTOR_COMPLETENESS,
  rounding: ROUNDING,
  quantileMethod: QUANTILE_METHOD,
  scoreMarginRounding: SCORE_MARGIN_ROUNDING,
  featureNames: FEATURE_NAMES,
  featureFamilies: FEATURE_FAMILIES,
  featureValueDomain: FEATURE_VALUE_DOMAIN,
  aliases: FEATURE_ALIASES,
  groups: FEATURE_GROUPS,
  evidenceClassMap: EVIDENCE_CLASS_MAP,
  forbiddenFeatureNamePatterns: FORBIDDEN_FEATURE_NAME_PATTERNS,
});

/** Canonical digest of the frozen definition (computed at import, never hard-coded). */
export const FEATURE_DEFINITION_DIGEST = digestOf(FEATURE_DEFINITION);
