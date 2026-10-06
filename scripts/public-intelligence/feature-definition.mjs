// Phase 5K.9 - DESCRIPTIVE SOCIAL EVIDENCE FEATURES: the definition module.
//
// PURE AND OFFLINE BY CONSTRUCTION. No socket, no clock, no environment, no
// filesystem, no credential, no provider SDK, no LLM, no embedding, no price
// feed. It opens no connection, reads no environment variable, starts no
// process and writes no file.
//
// FEATURE != SCORE
//
// Every output of this phase is an EXPLICIT MEASUREMENT of authenticated
// evidence. There is no weighting, no normalization into a quality scalar, no
// score, no rank, no confidence and no recommendation anywhere in it.
//
//   acceptable:   providerFamilyCount = 2
//                 upstreamObservationCount = 7
//                 contentLineageCount = 3
//                 observationWindowMs = 3600000
//
//   refused:      providerBreadthScore = 0.83
//                 socialMomentum = HIGH
//                 confidence = 72
//                 importanceRank = 4
//
// The layer DESCRIBES what was collected. It never interprets it, and it has no
// access to price, returns, market outcomes, the R4 result, the engine or Arena.
import { PUBLIC_INTELLIGENCE_CLASSIFICATION, canonical, digest } from './definition.mjs';
import { failClosed } from './observation.mjs';
import { PUBLIC_INTELLIGENCE_5K1_RAW_METADATA_SCHEMA } from './observation.mjs';
import {
  PUBLIC_INTELLIGENCE_5K7_COVERAGE_STATUS, PUBLIC_INTELLIGENCE_5K7_COVERAGE_STATUS_VALUES,
  PUBLIC_INTELLIGENCE_5K7_PROVIDER_FAMILIES,
} from './corroboration-definition.mjs';
import { PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS_VALUES } from './lineage-definition.mjs';

// ---------------------------------------------------------------------------
// 1. PHASE AND POLICY IDENTITY
// ---------------------------------------------------------------------------

export const PUBLIC_INTELLIGENCE_5K9_PHASE = 'PHASE_5K_9';
export const PUBLIC_INTELLIGENCE_5K9_SCHEMA_VERSION = '5K.9.0';

/**
 * The governed feature policy name. Any change to a governed measurement, to
 * the temporal bucket grid, to the missingness categories, to the record shape
 * or to the snapshot accounting is a NEW policy name, so a policy change can
 * never be silently absorbed by an old artifact.
 */
export const PUBLIC_INTELLIGENCE_5K9_POLICY_VERSION = 'feature-policy-1';

export const PUBLIC_INTELLIGENCE_5K9_RECORD_TYPES = Object.freeze({
  MINT_FEATURE: 'public_descriptive_mint_feature',
  SNAPSHOT: 'public_descriptive_feature_snapshot',
});

/**
 * THE FIXED TIME GRID.
 *
 * One conservative grid, fixed by policy: 15-minute buckets aligned to the UTC
 * epoch. Buckets are SPARSE - only buckets that actually contain authenticated
 * evidence are emitted - so no bucket is ever imputed, interpolated or
 * zero-filled. A bucket reports structural counts only.
 */
export const PUBLIC_INTELLIGENCE_5K9_BUCKET_POLICY = Object.freeze({
  bucketPolicyVersion: 'feature-buckets-15m-1',
  bucketWidthMs: 900_000,
  alignment: 'UTC_EPOCH_FLOOR',
  sparseObservedBucketsOnly: true,
  emptyBucketImputation: false,
  zeroFilledBuckets: false,
  interpolationApplied: false,
  movingAverageApplied: false,
  rateComputed: false,
});

/** The governed bucket width, in one place. */
export const PUBLIC_INTELLIGENCE_5K9_BUCKET_WIDTH_MS = PUBLIC_INTELLIGENCE_5K9_BUCKET_POLICY.bucketWidthMs;

// ---------------------------------------------------------------------------
// 2. SUBJECT IDENTITY: EXACT SOLANA MINT AND NOTHING ELSE
// ---------------------------------------------------------------------------

/**
 * The only canonical asset subject remains an EXACT SOLANA MINT. Only
 * observations whose already-verified association is `EXACT_MINT` may form a
 * per-mint feature record. UNASSOCIATED, INVALID_MINT and AMBIGUOUS stay visible
 * at snapshot/coverage level and are NEVER assigned to a mint. No symbol, name,
 * ticker or fuzzy signal can create a subject.
 */
export const PUBLIC_INTELLIGENCE_5K9_SUBJECT_IDENTITY = Object.freeze({
  kind: 'EXACT_SOLANA_MINT',
  associationsThatMayFormFeatures: Object.freeze(['EXACT_MINT']),
  associationsThatMayNeverFormFeatures: Object.freeze(['UNASSOCIATED', 'INVALID_MINT', 'AMBIGUOUS']),
  symbolOrNameCreatesSubject: false,
  tickerCreatesSubject: false,
  fuzzyMatchCreatesSubject: false,
  mintInferred: false,
  crossProviderMergePerformed: false,
});

// ---------------------------------------------------------------------------
// 3. COVERAGE AND LINEAGE COVERAGE
// ---------------------------------------------------------------------------

/**
 * Provider coverage reuses 5K.7's governed facts UNCHANGED. No new tier is
 * invented: there is no WEAK, STRONG, HIGH, LOW or TRENDING anywhere.
 */
export const PUBLIC_INTELLIGENCE_5K9_COVERAGE_STATUS = PUBLIC_INTELLIGENCE_5K7_COVERAGE_STATUS;
export const PUBLIC_INTELLIGENCE_5K9_COVERAGE_STATUS_VALUES = PUBLIC_INTELLIGENCE_5K7_COVERAGE_STATUS_VALUES;
export const PUBLIC_INTELLIGENCE_5K9_PROVIDER_FAMILIES = PUBLIC_INTELLIGENCE_5K7_PROVIDER_FAMILIES;

/**
 * Lineage coverage is a PURE COUNT PARTITION of `contentLineageCount`:
 * 0, exactly 1, or 2 or more. It carries NO ordinal meaning and is never a
 * strength statement; it exists so a reader can see at a glance whether the
 * mint's evidence is one lineage or several. Every lineage CLASS named in a
 * feature record is a governed 5K.8 value, reused verbatim.
 */
export const PUBLIC_INTELLIGENCE_5K9_LINEAGE_COVERAGE_STATUS = Object.freeze({
  NO_LINEAGE: 'NO_LINEAGE',
  SINGLE_LINEAGE: 'SINGLE_LINEAGE',
  MULTIPLE_LINEAGES: 'MULTIPLE_LINEAGES',
});

export const PUBLIC_INTELLIGENCE_5K9_LINEAGE_COVERAGE_STATUS_VALUES = Object.freeze(
  Object.values(PUBLIC_INTELLIGENCE_5K9_LINEAGE_COVERAGE_STATUS),
);

/** The governed lineage classes, re-exported so a caller cannot invent one. */
export const PUBLIC_INTELLIGENCE_5K9_LINEAGE_CLASS_VALUES = PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS_VALUES;

/** The count partition of a lineage count. Structurally exhaustive, never ordinal. */
export function lineageCoverageStatusFor(lineageCount) {
  if (!Number.isSafeInteger(lineageCount) || lineageCount < 0) failClosed('PUBLIC_INTELLIGENCE_5K9_LINEAGE_COUNT_INVALID');
  if (lineageCount === 0) return PUBLIC_INTELLIGENCE_5K9_LINEAGE_COVERAGE_STATUS.NO_LINEAGE;
  if (lineageCount === 1) return PUBLIC_INTELLIGENCE_5K9_LINEAGE_COVERAGE_STATUS.SINGLE_LINEAGE;
  return PUBLIC_INTELLIGENCE_5K9_LINEAGE_COVERAGE_STATUS.MULTIPLE_LINEAGES;
}

// ---------------------------------------------------------------------------
// 4. ENGAGEMENT COUNTERS (provider-defined measurements, kept separated)
// ---------------------------------------------------------------------------

/**
 * The governed provider-supplied counter names, taken from the 5K.1 metadata
 * schema so the two can never drift apart. They are PROVIDER-DEFINED
 * MEASUREMENTS: a Mastodon favourite and a Bluesky like may look structurally
 * similar and are still not the same measurement, so every engagement summary is
 * reported PER PROVIDER FAMILY and FIELD BY FIELD. Nothing is aggregated across
 * incomparable counter types.
 */
export const PUBLIC_INTELLIGENCE_5K9_ENGAGEMENT_COUNTERS = Object.freeze(
  [...PUBLIC_INTELLIGENCE_5K1_RAW_METADATA_SCHEMA.engagementFields].sort(),
);

/**
 * The engagement rules, stated as data. A counter regression is a VALID
 * observation: nothing here asserts that an increase is positive evidence, and
 * an absent counter is NEVER filled with zero.
 */
export const PUBLIC_INTELLIGENCE_5K9_ENGAGEMENT_SEMANTICS = Object.freeze({
  countersAreProviderDefined: true,
  summariesSeparatedByProviderFamily: true,
  summariesSeparatedFieldByField: true,
  aggregatedAcrossProviderFamilies: false,
  aggregatedAcrossCounterTypes: false,
  absentCounterFilledWithZero: false,
  absentCounterTreatedAsEmptyString: false,
  carryForwardApplied: false,
  interpolationApplied: false,
  increaseIsPositiveEvidence: false,
  decreaseIsNegativeEvidence: false,
  regressionRemainsValidObservation: true,
  absoluteChangeComputed: false,
  momentumComputed: false,
  growthComputed: false,
  velocityComputed: false,
  popularityComputed: false,
  ratioComputed: false,
  scoreComputed: false,
});

// ---------------------------------------------------------------------------
// 5. FEATURE SEMANTICS (no score, ever)
// ---------------------------------------------------------------------------

export const PUBLIC_INTELLIGENCE_5K9_FEATURE_SEMANTICS = Object.freeze({
  readOnly: true,
  derivedLayer: true,
  descriptiveOnly: true,
  measurableFromAuthenticatedEvidence: true,
  weightingApplied: false,
  normalizationApplied: false,
  standardizationApplied: false,
  zScoreComputed: false,
  percentileInterpretedAsRank: false,
  compositeComputed: false,
  scoreComputed: false,
  rankComputed: false,
  orderingByFeatureValue: false,
  defaultOrderingIsLexical: true,
  confidenceTierAssigned: false,
  ordinalLevelAssigned: false,
  sentimentComputed: false,
  momentumComputed: false,
  viralityComputed: false,
  popularityComputed: false,
  trendLabelled: false,
  importanceComputed: false,
  truthProbabilityComputed: false,
  predictionMade: false,
  recommendationMade: false,
  profitabilityInferenceMade: false,
  tradingInferenceMade: false,
  causesProviderContact: false,
  readsLiveNetworkData: false,
});

/** Time is copied from authenticated evidence and never invented. */
export const PUBLIC_INTELLIGENCE_5K9_TIME_SEMANTICS = Object.freeze({
  timestampsCopiedFromAuthenticatedEvidence: true,
  currentTimeUsed: false,
  filesystemMtimeUsed: false,
  directoryOrderUsed: false,
  windowComputedAsLastMinusFirst: true,
  rateInterpretedAsMomentum: false,
  simultaneityInferred: false,
  causalityInferred: false,
  emptyBucketImputed: false,
});

/**
 * Missingness is FIRST-CLASS: every governed category reports available and
 * missing counts, an absent counter is never converted to zero, and no
 * observation is silently dropped.
 */
export const PUBLIC_INTELLIGENCE_5K9_MISSINGNESS_SEMANTICS = Object.freeze({
  missingnessFirstClass: true,
  availableAndMissingReported: true,
  unknownReportedSeparately: true,
  absentTreatedAsZero: false,
  observationSilentlyDropped: false,
  absentFieldImputed: false,
  missingCountIsAnExplicitMeasurement: true,
  zeroSuppliedValueIsObserved: true,
});

/** Deterministic ordering: lexical by identity, never "best" first. */
export const PUBLIC_INTELLIGENCE_5K9_ORDERING_SEMANTICS = Object.freeze({
  mintFeaturesSortedByMint: true,
  providerFamiliesSortedByName: true,
  temporalBucketsSortedByBucketStart: true,
  engagementCountersSortedByName: true,
  descendingByFeatureValue: false,
  bestFirstOrdering: false,
});

// ---------------------------------------------------------------------------
// 6. NON-GOALS STATED AS DATA
// ---------------------------------------------------------------------------

/** No personal-data expansion: aggregate structural evidence facts only. */
export const PUBLIC_INTELLIGENCE_5K9_PRIVACY = Object.freeze({
  aggregateStructuralFactsOnly: true,
  postTextPersisted: false,
  displayNamesPersisted: false,
  handlesPersisted: false,
  biosPersisted: false,
  avatarsPersisted: false,
  followersAccessed: false,
  followingAccessed: false,
  mentionGraphAccessed: false,
  contactGraphAccessed: false,
  geolocationAccessed: false,
  addressesAccessed: false,
  credentialsAccessed: false,
  cookiesAccessed: false,
  urlsPersisted: false,
  authorIdentifiersPersisted: false,
});

/** No language model and no natural-language processing of any kind. */
export const PUBLIC_INTELLIGENCE_5K9_NO_NLP = Object.freeze({
  llmCalled: false,
  embeddingComputed: false,
  sentimentModelUsed: false,
  topicClassifierUsed: false,
  keywordClassifierUsed: false,
  namedEntityRecognitionUsed: false,
  semanticSimilarityUsed: false,
  textMiningPerformed: false,
  fixedLexiconsUsed: false,
});

/** The closed denial of any market, trading or outcome linkage. */
export const PUBLIC_INTELLIGENCE_5K9_MARKET_LINKAGE = Object.freeze({
  priceAccessed: false,
  returnsAccessed: false,
  volatilityAccessed: false,
  marketOutcomesAccessed: false,
  r4ResultAccessed: false,
  r4OutcomeArtifactsAccessed: false,
  tradingEngineReached: false,
  arenaReached: false,
  walletAccessed: false,
  signerAccessed: false,
  swapReached: false,
  rpcWriteReached: false,
  solanaRpcLookupPerformed: false,
  marketApiContacted: false,
  priceCorrelationComputed: false,
  returnLinkageComputed: false,
  mintIsIdentityOnly: true,
});

/** Concepts this phase deliberately does NOT compute, declared so it is auditable. */
export const PUBLIC_INTELLIGENCE_5K9_PROHIBITED_TERMS = Object.freeze([
  'consensus', 'confidence', 'signal', 'score', 'rank', 'ranking', 'strength',
  'conviction', 'momentum', 'importance', 'popularity', 'virality', 'sentiment',
  'recommendation', 'prediction', 'forecast', 'alpha', 'profit', 'return',
  'trend', 'weight', 'tier', 'level', 'quality', 'growth', 'velocity',
  'activityLevel', 'breadth',
]);

/** Query entry points this phase explicitly does NOT expose. */
export const PUBLIC_INTELLIGENCE_5K9_PROHIBITED_QUERY_NAMES = Object.freeze([
  'rankMints', 'topMints', 'scoreMint', 'recommendMint', 'predictMint',
  'compareBestMint', 'socialSignal', 'momentum', 'sentiment', 'scoreFeatures',
  'rankByFeature', 'rankByObservationCount', 'rankByEngagement', 'bestMint',
  'sortByScore', 'confidenceFor', 'importanceOf',
]);

// ---------------------------------------------------------------------------
// 7. HELPERS
// ---------------------------------------------------------------------------

/** One canonical deterministic fingerprint over any JSON value. */
export function featureFingerprint(value) {
  return digest(value);
}

/** The UTC-aligned start of the fixed bucket that contains `timestamp`. */
export function bucketStartOf(timestamp) {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) failClosed('PUBLIC_INTELLIGENCE_5K9_BUCKET_TIMESTAMP_INVALID');
  return Math.floor(timestamp / PUBLIC_INTELLIGENCE_5K9_BUCKET_WIDTH_MS) * PUBLIC_INTELLIGENCE_5K9_BUCKET_WIDTH_MS;
}

/** The exclusive end of the bucket that contains `timestamp`. */
export function bucketEndOf(timestamp) {
  return bucketStartOf(timestamp) + PUBLIC_INTELLIGENCE_5K9_BUCKET_WIDTH_MS;
}

/** Canonical JSON and the frozen classification, re-exported for one import rule. */
export { canonical, PUBLIC_INTELLIGENCE_CLASSIFICATION };
