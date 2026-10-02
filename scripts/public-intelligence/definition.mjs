// Phase 5K.0 - PUBLIC SOCIAL INTELLIGENCE: research governance specification.
//
// Governance + schemas + pure validators ONLY. This module deliberately
// contains NO network access, NO provider SDK, NO authentication, NO X client,
// NO scraping, NO storage and NO model inference. It opens no socket, reads no
// environment variable, starts no process and writes no file.
//
// POST-R4 BY CONSTRUCTION. R4 is closed. Nothing here mutates, reinterprets,
// extends, reseals or re-runs R4, and nothing here reaches the engine, paper
// execution, fitness, breeding, Arena, promotion, champion selection or any
// deployment gate.
//
// Canonical identity is an EXACT canonical Solana mint address and nothing
// else. An observation that cannot be bound to an exact mint stays
// UNASSOCIATED; it is never force-matched.
import { canonical, digest, mintIdentity } from '../market-intelligence/definition.mjs';

// ---------------------------------------------------------------------------
// 1. SCHEMA IDENTITY
// ---------------------------------------------------------------------------

export const PUBLIC_INTELLIGENCE_SCHEMA_VERSION = 1;

/** Every 5K artifact carries this classification block verbatim. */
export const PUBLIC_INTELLIGENCE_CLASSIFICATION = Object.freeze({
  developmentOnly: true,
  researchOnly: true,
  observerOnly: true,
  paperOnly: true,
  tradingAuthority: false,
  engineAuthority: false,
  arenaEligible: false,
  promotionEligible: false,
  profitabilityInferencePermitted: false,
});

/** Flags that may never read false. Absence is a governance violation. */
export const PUBLIC_INTELLIGENCE_ALWAYS_TRUE_FLAGS = Object.freeze([
  'developmentOnly', 'researchOnly', 'observerOnly', 'paperOnly',
]);

/** Flags that may never read true. This is the observer-only guarantee. */
export const PUBLIC_INTELLIGENCE_ALWAYS_FALSE_FLAGS = Object.freeze([
  'tradingAuthority', 'engineAuthority', 'arenaEligible', 'promotionEligible', 'profitabilityInferencePermitted',
]);

// ---------------------------------------------------------------------------
// 2. HARD BOUNDARY FROM R4
// ---------------------------------------------------------------------------

/**
 * R4 is CLOSED. Phase 5K is strictly post-R4 and lives entirely outside the R4
 * seal. R4's positive association is a research finding, never permission to
 * act, and no 5K result may retroactively change how R4 is read.
 */
export const PUBLIC_INTELLIGENCE_R4_BOUNDARY = Object.freeze({
  phase: 'PHASE_5K_0',
  r4Status: 'CLOSED',
  relationship: 'POST_R4',
  /** 5K evidence is its own class. It is NOT R4 evidence. */
  evidenceClass: 'PUBLIC_SOCIAL_RESEARCH_EVIDENCE',
  r4EvidenceIsDistinct: true,
  mayAlterR4Membership: false,
  mayAlterR4Outcomes: false,
  mayAlterR4Analysis: false,
  mayAlterR4Interpretation: false,
  isHiddenR4SensitivityAnalysis: false,
  retroactivelyChangesR4Reading: false,
  r4ResearchOnly: true,
  r4PaperOnly: true,
  r4ObserverOnly: true,
  r4TradingAuthority: false,
  r4ProfitabilityInferencePermitted: false,
  r4PositiveAssociationIsPermissionToAct: false,
  /** Carried verbatim from the completed R4 result; reference only. */
  r4CanonicalResult: Object.freeze({
    availabilityDenominator: 3516,
    resolvedReferences: 2341,
    distinctResolvedMints: 90,
    kendallTauB: 0.40163549403930066,
    bootstrapCi95: Object.freeze([0.2762661417066577, 0.4971652649589867]),
    bootstrapReplicates: 10000,
  }),
});

// ---------------------------------------------------------------------------
// 3. RECORD TYPES
// ---------------------------------------------------------------------------

export const PUBLIC_INTELLIGENCE_RECORD_TYPES = Object.freeze({
  RAW_SOCIAL_OBSERVATION: 'public_social_raw_observation',
  NORMALIZED_SOCIAL_OBSERVATION: 'public_social_normalized_observation',
  COLLECTION_SESSION: 'public_social_collection_session',
  MISSINGNESS_RECORD: 'public_social_missingness_record',
  ASSOCIATION_DECISION: 'public_social_association_decision',
});

export const PUBLIC_INTELLIGENCE_RECORD_TYPE_VALUES = Object.freeze(
  Object.values(PUBLIC_INTELLIGENCE_RECORD_TYPES),
);


// ---------------------------------------------------------------------------
// 4. CANONICAL SUBJECT IDENTITY AND ASSOCIATION
// ---------------------------------------------------------------------------

/** The only association method that can ever produce a canonical subject. */
export const PUBLIC_INTELLIGENCE_ASSOCIATION_METHODS = Object.freeze({
  EXACT_MINT_ADDRESS: 'EXACT_MINT_ADDRESS',
  UNASSOCIATED: 'UNASSOCIATED',
});

export const PUBLIC_INTELLIGENCE_ASSOCIATION_METHOD_VALUES = Object.freeze(
  Object.values(PUBLIC_INTELLIGENCE_ASSOCIATION_METHODS),
);

/** Methods that exist only to be permanently rejected. */
export const PUBLIC_INTELLIGENCE_REJECTED_ASSOCIATION_METHODS = Object.freeze([
  'SYMBOL_ONLY',
  'TOKEN_NAME_ONLY',
  'TICKER_GUESS',
  'FUZZY_TOKEN_MATCH',
  'FUZZY_MATCH',
  'PREFIX_MATCH',
  'EDIT_DISTANCE_MATCH',
  'EMBEDDING_SIMILARITY',
  'PROFILE_NAME_SIMILARITY',
  'NATURAL_LANGUAGE_SIMILARITY',
  'HEURISTIC_INFERENCE',
  'MANUAL_GUESS',
]);

/** Identity inputs that are never canonical, in any form. */
export const PUBLIC_INTELLIGENCE_NON_CANONICAL_IDENTITY = Object.freeze([
  'symbol',
  'tokenName',
  'ticker',
  'displayName',
  'profileName',
  'naturalLanguageSimilarity',
  'fuzzyTokenMatch',
]);

/** Canonical identity is EXACT mint address or nothing. */
export const PUBLIC_INTELLIGENCE_CANONICAL_IDENTITY_RULE = Object.freeze({
  requiresExactMintAddress: true,
  exactMintIsSoleCanonicalIdentity: true,
  forceMatchPermitted: false,
  unassociatedIsValidOutcome: true,
  reusesEvolvemintIdentity: true,
});

// ---------------------------------------------------------------------------
// 5. TIMESTAMPS
// ---------------------------------------------------------------------------

/**
 * Three distinct clocks. They are never collapsed into one ambiguous value and
 * none is ever derived from another at record time.
 *
 *   sourcePublishedAt  when the author/provider published the item (ms epoch)
 *   providerObservedAt when the provider first reported it (ms epoch)
 *   retrievedAt        when EVOLVE read it (ms epoch)
 *
 * Semantics: integer milliseconds since the UNIX epoch, UTC. A value that is
 * not a finite safe integer is a hard failure, never a default and never zero.
 * Absent is represented by explicit missingness, not by a sentinel timestamp.
 */
export const PUBLIC_INTELLIGENCE_TIMESTAMP_FIELDS = Object.freeze([
  'sourcePublishedAt',
  'providerObservedAt',
  'retrievedAt',
]);

/** The authoritative instant used for look-ahead and ordering decisions. */
export const PUBLIC_INTELLIGENCE_AVAILABILITY_TIMESTAMP = 'retrievedAt';

export const PUBLIC_INTELLIGENCE_CLOCK = Object.freeze({
  unit: 'MILLISECONDS',
  epoch: 'UNIX',
  timezone: 'UTC',
  finiteSafeIntegerRequired: true,
  collapsesDistinctClocks: false,
  zeroIsNeverADefault: true,
  defaultOnInvalid: null,
});

// ---------------------------------------------------------------------------
// 6. MISSINGNESS
// ---------------------------------------------------------------------------

/**
 * Missing is missing. These states are never converted into 0, 0.0, '', false,
 * an empty-but-successful reading or any other numeric stand-in.
 */
export const PUBLIC_INTELLIGENCE_MISSINGNESS = Object.freeze({
  OBSERVED: 'OBSERVED',
  NO_OBSERVATION: 'NO_OBSERVATION',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  ASSOCIATION_UNAVAILABLE: 'ASSOCIATION_UNAVAILABLE',
  RATE_LIMITED: 'RATE_LIMITED',
  UNKNOWN_MINT: 'UNKNOWN_MINT',
  NOT_YET_PUBLISHED: 'NOT_YET_PUBLISHED',
});

export const PUBLIC_INTELLIGENCE_MISSINGNESS_VALUES = Object.freeze(
  Object.values(PUBLIC_INTELLIGENCE_MISSINGNESS),
);

/** Only OBSERVED carries a real measurement. Everything else is absent. */
export const PUBLIC_INTELLIGENCE_OBSERVED_STATE = PUBLIC_INTELLIGENCE_MISSINGNESS.OBSERVED;

export const PUBLIC_INTELLIGENCE_MISSINGNESS_RULE = Object.freeze({
  zeroIsNeverMissing: true,
  falseIsNeverMissing: true,
  emptyStringIsNeverMissing: true,
  unknownMintIsExplicitState: true,
  observedStates: Object.freeze([PUBLIC_INTELLIGENCE_MISSINGNESS.OBSERVED]),
});

// ---------------------------------------------------------------------------
// 7. DEDUPLICATION
// ---------------------------------------------------------------------------

/**
 * Dedup identity is (provider, providerObservationId). Text equality alone is
 * never sufficient: two authors can post identical text, and one author can
 * repost. Cross-provider items stay DISTINCT until an explicit later research
 * rule says otherwise - this module never silently collapses them.
 */
export const PUBLIC_INTELLIGENCE_DEDUP = Object.freeze({
  identityFields: Object.freeze(['provider', 'providerObservationId']),
  providerObservationIdIsPreferred: true,
  textEqualityAloneIsIdentity: false,
  crossProviderCollapsePermitted: false,
  fallbackFields: Object.freeze(['provider', 'canonicalUrl']),
  fallbackRequiresProviderPrefix: true,
  deterministic: true,
});

// ---------------------------------------------------------------------------
// 8. FRESHNESS (metadata only in 5K.0)
// ---------------------------------------------------------------------------

/**
 * Freshness is DESCRIPTIVE METADATA in 5K.0. No empirical threshold is chosen
 * here: none exists in committed authority, so none is invented. The gate
 * itself is Phase 5K.3.
 */
export const PUBLIC_INTELLIGENCE_FRESHNESS = Object.freeze({
  mode: 'METADATA_ONLY',
  thresholdMs: null,
  thresholdChosenInPhase5K0: false,
  gateImplementedIn: 'PHASE_5K_3',
  derivedFrom: PUBLIC_INTELLIGENCE_TIMESTAMP_FIELDS,
  measuredFields: Object.freeze([
    'retrievalLagMs',
    'publicationToRetrievalMs',
    'providerLagMs',
  ]),
});

/** Descriptive lag arithmetic only. It never decides anything. */
export function freshnessMetadata({ sourcePublishedAt, providerObservedAt, retrievedAt }) {
  const lag = (from, to) => (isValidTimestamp(from) && isValidTimestamp(to) ? to - from : null);
  return Object.freeze({
    mode: PUBLIC_INTELLIGENCE_FRESHNESS.mode,
    thresholdMs: null,
    retrievalLagMs: lag(providerObservedAt, retrievedAt),
    publicationToRetrievalMs: lag(sourcePublishedAt, retrievedAt),
    providerLagMs: lag(sourcePublishedAt, providerObservedAt),
  });
}

// ---------------------------------------------------------------------------
// 9. NO HIDDEN LOOK-AHEAD
// ---------------------------------------------------------------------------

/**
 * A study evaluated at a reference instant may only use evidence available at
 * or before it. Availability is judged on `retrievedAt` because that is the
 * only clock EVOLVE controls. Future evidence can never influence an earlier
 * reference.
 */
export const PUBLIC_INTELLIGENCE_LOOKAHEAD_RULE = Object.freeze({
  availabilityField: PUBLIC_INTELLIGENCE_AVAILABILITY_TIMESTAMP,
  inclusive: true,
  futureEvidenceAdmitted: false,
  studyReferenceField: 'studyReferenceAt',
  evaluationImplementedIn: 'PHASE_5K_4',
});

/** True when the record was available at or before the reference instant. */
export function isAvailableAt(record, referenceAt) {
  if (!isValidTimestamp(referenceAt)) return false;
  const available = record?.[PUBLIC_INTELLIGENCE_AVAILABILITY_TIMESTAMP];
  if (!isValidTimestamp(available)) return false;
  return available <= referenceAt;
}

/** Filtering helper that fails closed rather than admitting future evidence. */
export function selectAvailableAt(records, referenceAt) {
  if (!isValidTimestamp(referenceAt)) return Object.freeze([]);
  return Object.freeze(records.filter(record => isAvailableAt(record, referenceAt)));
}

// ---------------------------------------------------------------------------
// 10. RAW EVIDENCE MODEL (immutable, closed schema)
// ---------------------------------------------------------------------------

/**
 * The future raw social observation record. Storage is MINIMIZED: only what
 * reproducibility requires. No private-message content, no follower graphs, no
 * contact details, no real names, no location, no enriched identity. Free text
 * is retained only as a digest plus the bounded public body needed to justify
 * it; the digest is what binds the record.
 */
/** True when the given identifier is permanently non-canonical as a subject. */
export function isNonCanonicalIdentityField(name) {
  return PUBLIC_INTELLIGENCE_NON_CANONICAL_IDENTITY.includes(name);
}

export const PUBLIC_INTELLIGENCE_NON_CANONICAL_IDENTITY_REJECTS_SYMBOL = () => (
  PUBLIC_INTELLIGENCE_NON_CANONICAL_IDENTITY.includes('symbol')
  && PUBLIC_INTELLIGENCE_NON_CANONICAL_IDENTITY.includes('ticker')
  && PUBLIC_INTELLIGENCE_REJECTED_ASSOCIATION_METHODS.includes('SYMBOL_ONLY')
);

export const PUBLIC_INTELLIGENCE_MISSINGNESS_RULE_ZERO_NEVER_MISSING = () => (
  PUBLIC_INTELLIGENCE_MISSINGNESS_RULE.zeroIsNeverMissing === true
  && PUBLIC_INTELLIGENCE_MISSINGNESS_RULE.falseIsNeverMissing === true
  && PUBLIC_INTELLIGENCE_MISSINGNESS_RULE.emptyStringIsNeverMissing === true
);

/** True when transaction submission and key use are permanently out of scope. */
export function transactionSubmissionProhibited() {
  return PUBLIC_INTELLIGENCE_SCOPE.prohibited.includes('TRANSACTION_SUBMISSION')
    && PUBLIC_INTELLIGENCE_SCOPE.prohibited.includes('PRIVATE_KEY_USE')
    && PUBLIC_INTELLIGENCE_PHASE_5K_0_SCOPE.holdsNoKeys === true;
}

/** Raw observation record. Closed schema; unknown fields are refused. */
export const PUBLIC_INTELLIGENCE_RAW_SCHEMA = Object.freeze({
  schemaVersion: PUBLIC_INTELLIGENCE_SCHEMA_VERSION,
  recordType: PUBLIC_INTELLIGENCE_RECORD_TYPES.RAW_SOCIAL_OBSERVATION,
  closed: true,
  fields: Object.freeze([
    'schemaVersion',
    'recordType',
    'provider',
    'providerObservationId',
    'sourcePublishedAt',
    'providerObservedAt',
    'retrievedAt',
    'canonicalUrl',
    'authorPublicId',
    'textDigest',
    'rawPayloadDigest',
    'candidateMintAddresses',
    'exactAssociatedMintAddresses',
    'associationMethod',
    'provenance',
    'classification',
  ]),
  optionalFields: Object.freeze(['sourcePublishedAt', 'authorPublicId']),
  // Deliberately absent: any handle beyond a public id, any contact field, any
  // private content, any engagement snapshot at raw level.
  forbiddenFields: Object.freeze([
    'email', 'phone', 'privateMessage', 'directMessage', 'ipAddress', 'realName',
    'legalName', 'homeAddress', 'geoLocation', 'birthDate', 'deviceId',
    'sessionCookie', 'accessToken', 'refreshToken', 'apiKey', 'bearerToken',
    'followerList', 'followingList', 'contactList', 'profileImageUrl',
  ]),
});

/**
 * Provenance block. A normalized record is always traceable to exactly one
 * immutable raw record by fingerprint. Nothing is ever silently rewritten.
 */
export const PUBLIC_INTELLIGENCE_PROVENANCE = Object.freeze({
  required: true,
  rawFingerprintField: 'rawEvidenceFingerprint',
  rawPayloadDigestField: 'rawPayloadDigest',
  sourceField: 'provider',
  sourceUrlField: 'canonicalUrl',
  retrievedAtField: 'retrievedAt',
  fingerprintAlgorithm: 'SHA-256',
  serialization: 'EVOLVE_CANONICAL_JSON',
  rewritePermitted: false,
  silentRewritePermitted: false,
  orphanNormalizedRecordPermitted: false,
});

// ---------------------------------------------------------------------------
// 11. NORMALIZED EVIDENCE MODEL (derived, never mutates raw)
// ---------------------------------------------------------------------------

/**
 * Deterministic normalized fields, kept strictly separate from raw evidence.
 * Normalization READS raw and produces a new record; it never writes back.
 *
 * Deliberately NOT implemented in 5K.0: sentiment, toxicity, LLM
 * interpretation, embeddings, topic models, engagement-weighted scores,
 * author reputation, bot detection and any trading signal.
 */
export const PUBLIC_INTELLIGENCE_NORMALIZED_SCHEMA = Object.freeze({
  schemaVersion: PUBLIC_INTELLIGENCE_SCHEMA_VERSION,
  recordType: PUBLIC_INTELLIGENCE_RECORD_TYPES.NORMALIZED_SOCIAL_OBSERVATION,
  closed: true,
  fields: Object.freeze([
    'schemaVersion',
    'recordType',
    'provider',
    'providerObservationId',
    'dedupIdentity',
    'canonicalUrl',
    'authorPublicId',
    'sourcePublishedAt',
    'providerObservedAt',
    'retrievedAt',
    'exactAssociatedMintAddresses',
    'associationMethod',
    'textDigest',
    'normalizedTextDigest',
    'engagementCounts',
    'missingness',
    'freshness',
    'provenance',
    'classification',
  ]),
  // Categories permitted in 5K.0. Everything else is deferred by construction.
  allowedCategories: Object.freeze([
    'observationIdentity',
    'exactMintAssociations',
    'timestamps',
    'publicEngagementCountsIfProviderSupplied',
    'deterministicTextDigest',
    'deterministicNormalizedTextDigest',
    'providerSourceIdentity',
    'freshnessMetadata',
  ]),
  deferredInPhase5K0: Object.freeze([
    'sentiment', 'toxicity', 'llmInterpretation', 'embeddings', 'topicModeling',
    'tradingSignal', 'scoring', 'ranking', 'recommendation', 'authorReputation',
    'botDetection', 'engagementWeightedScore', 'alphaScore',
  ]),
  mutatesRawEvidence: false,
  sentimentImplemented: false,
  llmInterpretationImplemented: false,
  tradingSignalImplemented: false,
});

/** Public engagement counts are provider-supplied or absent. Never inferred. */
export const PUBLIC_INTELLIGENCE_ENGAGEMENT = Object.freeze({
  allowed: Object.freeze(['likes', 'replies', 'reposts', 'quotes', 'views', 'bookmarks']),
  integersOnly: true,
  negativePermitted: false,
  zeroIsValidOnlyWhenProviderSuppliedZero: true,
  providerSuppliedOnly: true,
  inferredValuesPermitted: false,
  zeroImpliesMissingness: false,
});

// ---------------------------------------------------------------------------
// 12. PRIVACY / PUBLIC DATA SCOPE
// ---------------------------------------------------------------------------

/**
 * Publicly accessible observations only. Everything below is permanently out of
 * scope for Phase 5K and is enforced structurally, not by convention.
 */
export const PUBLIC_INTELLIGENCE_SCOPE = Object.freeze({
  publicDataOnly: true,
  authenticationPermitted: false,
  authenticationBypassPermitted: false,
  privateAccountAccessPermitted: false,
  restrictedContentScrapingPermitted: false,
  privateMessageIngestionPermitted: false,
  identityEnrichmentPermitted: false,
  deanonymizationPermitted: false,
  contactDiscoveryPermitted: false,
  privatePersonProfilingPermitted: false,
  prohibited: Object.freeze([
    'PRIVATE_ACCOUNT_ACCESS',
    'AUTHENTICATION_BYPASS',
    'RESTRICTED_CONTENT_SCRAPING',
    'PRIVATE_MESSAGE_INGESTION',
    'IDENTITY_ENRICHMENT',
    'DEANONYMIZATION',
    'CONTACT_DISCOVERY',
    'PRIVATE_PERSON_PROFILING',
    'PRIVATE_KEY_USE',
    'TRANSACTION_SUBMISSION',
  ]),
});

// ---------------------------------------------------------------------------
// 13. BOUNDED COLLECTION (declared now, implemented in 5K.5)
// ---------------------------------------------------------------------------

/**
 * No unbounded crawler. Every future collection run must declare its bounds
 * before it starts. 5K.0 declares the shape and the closed bound field set; it
 * contacts nothing and therefore needs no real numbers.
 */
export const PUBLIC_INTELLIGENCE_COLLECTION_BOUNDS = Object.freeze({
  unboundedCollectionPermitted: false,
  requiredBoundFields: Object.freeze([
    'maxDurationMs',
    'maxResultsPerQuery',
    'maxPagesPerQuery',
    'maxStorageBytes',
    'maxRequestsPerRun',
    'providerCooldownMs',
    'rateLimitHandling',
  ]),
  rateLimitHandlingValues: Object.freeze(['FAIL_CLOSED', 'BACKOFF_WITHIN_BUDGET', 'STOP_RUN']),
  stoppingOnBudgetExhaustion: true,
  implementedIn: 'PHASE_5K_5',
  implementedInPhase5K0: false,
});

// ---------------------------------------------------------------------------
// 14. PROVIDER ISOLATION
// ---------------------------------------------------------------------------

/**
 * Provider-specific raw shapes never reach research calculations. Each
 * provider adapts into the one canonical normalized representation above, so
 * an upstream field rename cannot silently change a research number.
 */
export const PUBLIC_INTELLIGENCE_PROVIDER_ISOLATION = Object.freeze({
  rawLeaksIntoResearchCalculations: false,
  adapterBoundary: 'PROVIDER_ADAPTER_TO_CANONICAL_NORMALIZED',
  canonicalRepresentation: PUBLIC_INTELLIGENCE_RECORD_TYPES.NORMALIZED_SOCIAL_OBSERVATION,
  unknownFieldHandling: 'REJECT_UNKNOWN_FIELDS',
  providerIdentityAlwaysRetained: true,
});

// ---------------------------------------------------------------------------
// 15. NO SOCIAL-TO-TRADING PATH
// ---------------------------------------------------------------------------

/**
 * Phase 5K has no import path into any live decision surface. These consumers
 * are permanently unreachable from 5K.0 code.
 */
export const PUBLIC_INTELLIGENCE_FORBIDDEN_CONSUMERS = Object.freeze([
  'engineDecisions',
  'paperExecution',
  'fitness',
  'breeding',
  'arena',
  'championSelection',
  'deploymentGate',
  'liveEntryExit',
  'r4Analysis',
  'r4Evidence',
]);

/** The complete Phase 5K.0 module surface. Pure constants and pure functions. */
export const PUBLIC_INTELLIGENCE_PHASE_5K_0_SCOPE = Object.freeze({
  phase: 'PHASE_5K_0',
  governanceOnly: true,
  collectsNothing: true,
  contactsNoProvider: true,
  writesNothing: true,
  startsNoProcess: true,
  holdsNoKeys: true,
  readsNoEnvironment: true,
  networkAccessPermitted: false,
  tradingAuthority: false,
  affectsFitness: false,
  affectsPromotion: false,
  affectsChampionSelection: false,
  createsDeploymentGate: false,
  touchesR4Seal: false,
  roadmap: Object.freeze({
    '5K.0': 'Research Governance',
    '5K.1': 'Authority Benchmark',
    '5K.2': 'Public Intelligence Router',
    '5K.3': 'Evidence Freshness Gate',
    '5K.4': 'Research Math Core',
    '5K.5': 'Scheduled Research',
  }),
});

// ---------------------------------------------------------------------------
// 16. PURE VALIDATORS AND FINGERPRINTS
// ---------------------------------------------------------------------------

export { canonical, digest };

const fail = code => { throw new Error(code); };

/** A timestamp is a finite safe integer count of milliseconds. */
export function isValidTimestamp(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && Number.isFinite(value);
}

/**
 * Validates a clock value and fails closed. `null` is permitted ONLY where the
 * schema marks the field optional; NaN, Infinity, floats, strings and negative
 * values are always rejected rather than coerced.
 */
export function assertTimestamp(value, field, { optional = false } = {}) {
  if (value === null || value === undefined) {
    if (optional) return null;
    return fail(`PUBLIC_INTELLIGENCE_TIMESTAMP_REQUIRED:${field}`);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return fail(`PUBLIC_INTELLIGENCE_TIMESTAMP_NOT_FINITE:${field}`);
  if (typeof value !== 'number') return fail(`PUBLIC_INTELLIGENCE_TIMESTAMP_NOT_A_NUMBER:${field}`);
  if (!Number.isSafeInteger(value)) return fail(`PUBLIC_INTELLIGENCE_TIMESTAMP_NOT_INTEGER_MS:${field}`);
  if (value < 0) return fail(`PUBLIC_INTELLIGENCE_TIMESTAMP_NEGATIVE:${field}`);
  return value;
}

/**
 * Canonical subject identity. An exact Solana mint address and nothing else.
 * Symbol, ticker, display name and any fuzzy/similarity signal are rejected.
 */
export function canonicalMintAddress(value) {
  if (typeof value !== 'string') return null;
  // Solana addresses are base58 and CASE-SENSITIVE. This function never folds
  // case: it returns the exact string or nothing, so a differently-cased string
  // is a DIFFERENT identity rather than a silent match to the same one.
  const mint = mintIdentity(value);
  return mint === null ? null : mint;
}

/** Rejects any association that is not an exact mint. */
export function assertExactMintAssociation(associationMethod, exactAssociatedMintAddresses) {
  if (!PUBLIC_INTELLIGENCE_ASSOCIATION_METHOD_VALUES.includes(associationMethod)) {
    return fail(`PUBLIC_INTELLIGENCE_ASSOCIATION_METHOD_INVALID:${String(associationMethod)}`);
  }
  if (PUBLIC_INTELLIGENCE_REJECTED_ASSOCIATION_METHODS.includes(associationMethod)) {
    return fail(`PUBLIC_INTELLIGENCE_ASSOCIATION_METHOD_REJECTED:${associationMethod}`);
  }
  if (!Array.isArray(exactAssociatedMintAddresses)) {
    return fail('PUBLIC_INTELLIGENCE_ASSOCIATION_ADDRESSES_INVALID');
  }
  for (const candidate of exactAssociatedMintAddresses) {
    if (canonicalMintAddress(candidate) === null) {
      return fail(`PUBLIC_INTELLIGENCE_MINT_NOT_EXACT:${String(candidate)}`);
    }
  }
  if (associationMethod === PUBLIC_INTELLIGENCE_ASSOCIATION_METHODS.UNASSOCIATED
    && exactAssociatedMintAddresses.length !== 0) {
    return fail('PUBLIC_INTELLIGENCE_UNASSOCIATED_WITH_ADDRESSES');
  }
  if (associationMethod === PUBLIC_INTELLIGENCE_ASSOCIATION_METHODS.EXACT_MINT_ADDRESS
    && exactAssociatedMintAddresses.length === 0) {
    return fail('PUBLIC_INTELLIGENCE_EXACT_MINT_REQUIRES_ADDRESS');
  }
  return true;
}

/** Rejects a classification that carries any authority, fitness or money claim. */
export function assertObserverOnlyClassification(classification) {
  if (!classification || typeof classification !== 'object') return fail('PUBLIC_INTELLIGENCE_CLASSIFICATION_MISSING');
  for (const flag of PUBLIC_INTELLIGENCE_ALWAYS_TRUE_FLAGS) {
    if (classification[flag] !== true) return fail(`PUBLIC_INTELLIGENCE_CLASSIFICATION_FLAG_FALSE:${flag}`);
  }
  for (const flag of PUBLIC_INTELLIGENCE_ALWAYS_FALSE_FLAGS) {
    if (classification[flag] !== false) return fail(`PUBLIC_INTELLIGENCE_CLASSIFICATION_FLAG_TRUE:${flag}`);
  }
  const expected = PUBLIC_INTELLIGENCE_CLASSIFICATION;
  if (canonical(classification) !== canonical(expected)) return fail('PUBLIC_INTELLIGENCE_CLASSIFICATION_MISMATCH');
  return true;
}

/** Rejects any field outside the closed schema, and any forbidden field. */
export function assertClosedSchema(record, schema) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return fail('PUBLIC_INTELLIGENCE_RECORD_INVALID');
  const allowed = new Set(schema.fields);
  for (const key of Object.keys(record)) {
    if (schema.forbiddenFields?.includes(key)) return fail(`PUBLIC_INTELLIGENCE_FIELD_FORBIDDEN:${key}`);
    if (!allowed.has(key)) return fail(`PUBLIC_INTELLIGENCE_UNKNOWN_FIELD:${key}`);
  }
  for (const key of schema.fields) {
    if (key.endsWith('At') && schema.optionalFields?.includes(key)) continue;
    if (record[key] === undefined) return fail(`PUBLIC_INTELLIGENCE_FIELD_MISSING:${key}`);
  }
  return true;
}

/**
 * Missingness is explicit. A missing state NEVER yields 0, false or ''. Only
 * OBSERVED may carry a measurement, and that measurement may legitimately be 0
 * (a post with zero likes is observed, not missing).
 */
export function assertMissingnessExplicit(missingness, measurement) {
  if (!PUBLIC_INTELLIGENCE_MISSINGNESS_VALUES.includes(missingness)) {
    return fail(`PUBLIC_INTELLIGENCE_MISSINGNESS_INVALID:${String(missingness)}`);
  }
  if (missingness !== PUBLIC_INTELLIGENCE_MISSINGNESS.OBSERVED) {
    if (measurement === 0) return fail('PUBLIC_INTELLIGENCE_MISSINGNESS_ZERO_SUBSTITUTION');
    if (measurement === false) return fail('PUBLIC_INTELLIGENCE_MISSINGNESS_BOOLEAN_SUBSTITUTION');
    if (measurement === '') return fail('PUBLIC_INTELLIGENCE_MISSINGNESS_EMPTY_SUBSTITUTION');
    return true;
  }
  return true;
}

/**
 * Deterministic dedup identity. Provider always participates, so the same
 * provider observation id seen on two providers yields two identities. Text
 * equality alone is never an identity.
 */
export function dedupIdentity({ provider, providerObservationId, textDigest } = {}) {
  if (typeof provider !== 'string' || !provider) return fail('PUBLIC_INTELLIGENCE_PROVIDER_REQUIRED');
  if (typeof providerObservationId === 'string' && providerObservationId) {
    return digest({ kind: 'providerObservationId', provider, providerObservationId });
  }
  if (textDigest === undefined || textDigest === null) {
    // No provider observation id and no text digest: the item is not
    // identifiable. Identity is explicitly unknown, never text-derived.
    return digest({ kind: 'unidentifiable', provider, providerObservationId: null });
  }
  return digest({ kind: 'providerScopedText', provider, textDigest });
}

/** Cross-provider comparison stays explicit; nothing collapses implicitly. */
export function sameObservation(a, b) {
  if (!a || !b) return false;
  if (a.provider !== b.provider) return false;
  return dedupIdentity(a) === dedupIdentity(b);
}

// ---------------------------------------------------------------------------
// 17. RAW RECORD VALIDATION AND NORMALIZATION (pure, non-mutating)
// ---------------------------------------------------------------------------

/** Validates a raw observation against the closed schema and every rule. */
export function validateRawObservation(raw) {
  assertClosedSchema(raw, PUBLIC_INTELLIGENCE_RAW_SCHEMA);
  assertObserverOnlyClassification(raw.classification);
  if (raw.schemaVersion !== PUBLIC_INTELLIGENCE_SCHEMA_VERSION) fail('PUBLIC_INTELLIGENCE_SCHEMA_VERSION_INVALID');
  if (raw.recordType !== PUBLIC_INTELLIGENCE_RECORD_TYPES.RAW_SOCIAL_OBSERVATION) fail('PUBLIC_INTELLIGENCE_RECORD_TYPE_INVALID');
  if (typeof raw.provider !== 'string' || !raw.provider) fail('PUBLIC_INTELLIGENCE_PROVIDER_REQUIRED');
  for (const field of PUBLIC_INTELLIGENCE_TIMESTAMP_FIELDS) {
    assertTimestamp(raw[field], field, { optional: field === 'sourcePublishedAt' });
  }
  // Clocks must be independently supplied; a collapsed single value is a bug.
  const distinct = new Set(PUBLIC_INTELLIGENCE_TIMESTAMP_FIELDS
    .map(field => raw[field]).filter(value => value !== null && value !== undefined));
  if (distinct.size < 2) fail('PUBLIC_INTELLIGENCE_TIMESTAMPS_COLLAPSED');
  assertExactMintAssociation(raw.associationMethod, raw.exactAssociatedMintAddresses);
  if (!Array.isArray(raw.candidateMintAddresses)) fail('PUBLIC_INTELLIGENCE_CANDIDATES_INVALID');
  for (const candidate of raw.candidateMintAddresses) {
    if (canonicalMintAddress(candidate) === null) fail(`PUBLIC_INTELLIGENCE_CANDIDATE_MINT_NOT_EXACT:${String(candidate)}`);
  }
  if (!raw.provenance || typeof raw.provenance !== 'object') fail('PUBLIC_INTELLIGENCE_PROVENANCE_REQUIRED');
  if (typeof raw.textDigest !== 'string' || !/^[0-9a-f]{64}$/.test(raw.textDigest)) fail('PUBLIC_INTELLIGENCE_TEXT_DIGEST_INVALID');
  if (typeof raw.rawPayloadDigest !== 'string' || !/^[0-9a-f]{64}$/.test(raw.rawPayloadDigest)) fail('PUBLIC_INTELLIGENCE_RAW_DIGEST_INVALID');
  return true;
}

/** Canonical, deterministic raw fingerprint. */
export function rawFingerprint(raw) {
  return digest(raw);
}


/**
 * Pure normalization. Returns a NEW frozen object and deep-freezes nothing the
 * caller owns. The raw record is never written to; its fingerprint is carried
 * forward as provenance. No sentiment, no LLM, no scoring.
 */
export function normalizeObservation(raw) {
  validateRawObservation(raw);
  const before = rawFingerprint(raw);
  const normalized = {
    schemaVersion: PUBLIC_INTELLIGENCE_SCHEMA_VERSION,
    recordType: PUBLIC_INTELLIGENCE_RECORD_TYPES.NORMALIZED_SOCIAL_OBSERVATION,
    provider: raw.provider,
    providerObservationId: raw.providerObservationId,
    dedupIdentity: dedupIdentity(raw),
    canonicalUrl: raw.canonicalUrl,
    authorPublicId: raw.authorPublicId,
    sourcePublishedAt: raw.sourcePublishedAt ?? null,
    providerObservedAt: raw.providerObservedAt,
    retrievedAt: raw.retrievedAt,
    exactAssociatedMintAddresses: [...raw.exactAssociatedMintAddresses],
    associationMethod: raw.associationMethod,
    textDigest: raw.textDigest,
    normalizedTextDigest: raw.provenance?.normalizedTextDigest ?? null,
    engagementCounts: null,
    missingness: raw.associationMethod === PUBLIC_INTELLIGENCE_ASSOCIATION_METHODS.UNASSOCIATED
      ? PUBLIC_INTELLIGENCE_MISSINGNESS.NO_OBSERVATION
      : PUBLIC_INTELLIGENCE_MISSINGNESS.OBSERVED,
    freshness: freshnessMetadata(raw),
    provenance: {
      rawEvidenceFingerprint: before,
      rawPayloadDigest: raw.rawPayloadDigest,
      provider: raw.provider,
      canonicalUrl: raw.canonicalUrl,
      retrievedAt: raw.retrievedAt,
      rewritten: false,
    },
    classification: { ...PUBLIC_INTELLIGENCE_CLASSIFICATION },
  };
  assertClosedSchema(normalized, PUBLIC_INTELLIGENCE_NORMALIZED_SCHEMA);
  if (rawFingerprint(raw) !== before) fail('PUBLIC_INTELLIGENCE_NORMALIZATION_MUTATED_RAW');
  return Object.freeze(normalized);
}

/** A normalized record must trace back to exactly the raw record it claims. */
export function verifyProvenance(normalized, raw) {
  if (!raw) return fail('PUBLIC_INTELLIGENCE_PROVENANCE_RAW_MISSING');
  validateRawObservation(raw);
  const expected = rawFingerprint(raw);
  const claimed = normalized?.provenance?.rawEvidenceFingerprint;
  if (claimed !== expected) return fail('PUBLIC_INTELLIGENCE_PROVENANCE_FINGERPRINT_MISMATCH');
  if (normalized.provenance.rawPayloadDigest !== raw.rawPayloadDigest) {
    return fail('PUBLIC_INTELLIGENCE_PROVENANCE_PAYLOAD_DIGEST_MISMATCH');
  }
  if (normalized.provenance.provider !== raw.provider) return fail('PUBLIC_INTELLIGENCE_PROVENANCE_PROVIDER_MISMATCH');
  return true;
}

// ---------------------------------------------------------------------------
// 18. REPRODUCIBILITY: SESSION BINDING
// ---------------------------------------------------------------------------

/** Software/version identity a future session must bind. */
export const PUBLIC_INTELLIGENCE_SOFTWARE_IDENTITY = Object.freeze({
  project: 'evolve',
  phase: 'PHASE_5K_0',
  module: 'scripts/public-intelligence/definition.mjs',
  schemaVersion: PUBLIC_INTELLIGENCE_SCHEMA_VERSION,
  classification: PUBLIC_INTELLIGENCE_CLASSIFICATION,
  r4Boundary: PUBLIC_INTELLIGENCE_R4_BOUNDARY,
});

/**
 * Deterministic session fingerprint. A future research session binds provider
 * configuration, collection bounds, raw and normalized fingerprints, exact mint
 * associations, source timestamps and software identity. Nothing here contacts
 * a provider; it only digests what the caller already has.
 */
export function sessionFingerprint({
  providerConfig = {},
  collectionBounds = {},
  rawFingerprints = [],
  normalizedFingerprints = [],
  exactMintAssociations = [],
  sourceTimestamps = [],
  softwareIdentity = PUBLIC_INTELLIGENCE_SOFTWARE_IDENTITY,
} = {}) {
  return digest({
    schemaVersion: PUBLIC_INTELLIGENCE_SCHEMA_VERSION,
    softwareIdentity,
    providerConfig,
    collectionBounds,
    rawFingerprints: [...rawFingerprints].sort(),
    normalizedFingerprints: [...normalizedFingerprints].sort(),
    exactMintAssociations: [...exactMintAssociations].sort(),
    sourceTimestamps: [...sourceTimestamps].sort(),
    classification: PUBLIC_INTELLIGENCE_CLASSIFICATION,
  });
}

/** Phase 5K.0 self-description, used by the validator and by reviewers. */
export const PUBLIC_INTELLIGENCE_GOVERNANCE = Object.freeze({
  specification: 'docs/PHASE5K-PUBLIC-SOCIAL-INTELLIGENCE.md',
  module: 'scripts/public-intelligence/definition.mjs',
  validator: 'scripts/validate-phase5k.mjs',
  hashAlgorithm: 'SHA-256',
  canonicalization: 'EVOLVE_CANONICAL_JSON',
  canonicalizationSource: 'scripts/market-intelligence/definition.mjs',
  externalDependencies: Object.freeze([]),
});

/** Canonical, deterministic normalized fingerprint. */
export function normalizedFingerprint(normalized) {
  return digest(normalized);
}

