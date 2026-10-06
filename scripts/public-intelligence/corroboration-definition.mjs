// Phase 5K.7 - CROSS-PROVIDER CORROBORATION SEMANTICS: the definition module.
//
// PURE AND OFFLINE BY CONSTRUCTION. No socket, no clock, no environment, no
// filesystem, no credential, no provider SDK. It opens no connection, reads no
// environment variable, starts no process and writes no file.
//
// WHAT THIS LAYER IS
//
// A READ-ONLY derived layer that describes CROSS-PROVIDER EVIDENCE COVERAGE for
// one governed subject identity: an EXACT SOLANA MINT. It answers structural
// questions only:
//
//   - was an exact mint observed on one provider family or more than one?
//   - which provider families and provider namespaces contributed evidence?
//   - how many distinct upstream observations contributed?
//   - how many authenticated content versions and observation-state snapshots
//     exist for that evidence?
//   - over what authenticated time window was it observed?
//   - where is exact-mint evidence absent?
//
// WHAT THIS LAYER IS NOT
//
// It does NOT decide which mint is better, trending, popular, important, likely
// to rise, whether providers "agree", whether a claim is true, or whether any
// trade should be made. There is deliberately NO score, NO rank, NO confidence
// tier, NO signal, NO momentum, NO conviction and NO recommendation anywhere in
// this phase. Two provenance layers describing the same mint is a statement
// about EVIDENCE COVERAGE, never about the mint.
//
// THE STRICT MEANING OF "CORROBORATION" USED HERE
//
// Invariant: the same EXACT GOVERNED SUBJECT IDENTITY appearing in
// authenticated evidence from more than one provider namespace.
//
// It does NOT mean the claims in the posts are true, and it does NOT mean the
// providers agree about anything. It is presence-in-more-than-one-place and
// nothing more.
import { PUBLIC_INTELLIGENCE_CLASSIFICATION, canonical, digest } from './definition.mjs';
import { failClosed } from './observation.mjs';

// ---------------------------------------------------------------------------
// 1. PHASE AND POLICY IDENTITY
// ---------------------------------------------------------------------------

export const PUBLIC_INTELLIGENCE_5K7_PHASE = 'PHASE_5K_7';
export const PUBLIC_INTELLIGENCE_5K7_SCHEMA_VERSION = '5K.7.0';

/**
 * The governed corroboration policy name.
 *
 * Any change to the subject identity rule, the provider-family rule, the
 * provider-namespace rule, the coverage-status rule, the coverage-record shape
 * or the snapshot accounting is a NEW policy name. The policy name participates
 * in both the deterministic snapshot identity and every derived fingerprint, so
 * a policy change can never be silently absorbed by an old artifact.
 */
export const PUBLIC_INTELLIGENCE_5K7_POLICY_VERSION = 'corroboration-policy-1';

export const PUBLIC_INTELLIGENCE_5K7_RECORD_TYPES = Object.freeze({
  COVERAGE_RECORD: 'public_corroboration_coverage_record',
  SNAPSHOT: 'public_corroboration_snapshot',
});

// ---------------------------------------------------------------------------
// 2. SUBJECT IDENTITY: EXACT SOLANA MINT AND NOTHING ELSE
// ---------------------------------------------------------------------------

/**
 * The ONLY canonical cross-provider subject identity is an EXACT SOLANA MINT.
 *
 * No other signal may create cross-provider equivalence in this phase. Listed
 * explicitly so the refusal is auditable rather than implicit:
 *
 *   ticker, symbol, cashtag, hashtag, project name, profile identity, domain,
 *   URL, similar text, embedding similarity, fuzzy matching.
 *
 * Only observations whose authenticated, already-verified normalized evidence
 * carries `assetAssociation.status === EXACT_MINT` may participate.
 */
export const PUBLIC_INTELLIGENCE_5K7_SUBJECT_IDENTITY = Object.freeze({
  kind: 'EXACT_SOLANA_MINT',
  exactOnly: true,
  caseSensitive: true,
  associationsThatMayParticipate: Object.freeze(['EXACT_MINT']),
  associationsThatMayNeverParticipate: Object.freeze(['UNASSOCIATED', 'INVALID_MINT', 'AMBIGUOUS']),
  rejectedEquivalenceSignals: Object.freeze([
    'TICKER', 'SYMBOL', 'CASHTAG', 'HASHTAG', 'PROJECT_NAME', 'PROFILE_IDENTITY',
    'DOMAIN', 'URL', 'SIMILAR_TEXT', 'EMBEDDING_SIMILARITY', 'FUZZY_MATCHING',
  ]),
  forceMatchPermitted: false,
  mintInferencePermitted: false,
  crossProviderMergePermitted: false,
});

// ---------------------------------------------------------------------------
// 3. PROVIDER FAMILY AND PROVIDER NAMESPACE
// ---------------------------------------------------------------------------

/**
 * The governed provider FAMILIES. A family is a platform, not an instance.
 *
 * Sorted, frozen, closed: an unknown family is a hard refusal, never a default.
 */
export const PUBLIC_INTELLIGENCE_5K7_PROVIDER_FAMILIES = Object.freeze(['bluesky', 'mastodon']);

/** The separator that binds a family to its scope inside one namespace string. */
export const PUBLIC_INTELLIGENCE_5K7_NAMESPACE_SEPARATOR = ':';

/**
 * PROVIDER INDEPENDENCE, STATED PRECISELY.
 *
 * Independence for 5K.7 means exactly one thing: a DIFFERENT GOVERNED PROVIDER
 * FAMILY. It never means two posts, two instances, two authors, two times or
 * two texts. Concretely:
 *
 *   - `mastodon:instanceA` and `bluesky:public-appview` are TWO families.
 *   - `mastodon:instanceA` and `mastodon:instanceB` are ONE family with TWO
 *     namespaces: two Mastodon instances are NOT cross-platform corroboration.
 *   - two different posts on Mastodon alone do NOT become cross-family.
 */
export const PUBLIC_INTELLIGENCE_5K7_INDEPENDENCE = Object.freeze({
  independenceUnit: 'PROVIDER_FAMILY',
  familySeparatesCrossPlatformCoverage: true,
  namespaceSeparatesInstances: true,
  twoInstancesOfOneFamilyAreOneFamily: true,
  twoPostsOfOneFamilyAreOneFamily: true,
  sameTextCountsAsIndependence: false,
  sameTimeCountsAsIndependence: false,
  sameMintCountsAsIndependence: false,
  timeSeparationImpliesIndependence: false,
  aggregatedReferenceLayer: true,
  mergesUnderlyingEvidence: false,
});

/**
 * The provider FAMILY of a governed provider namespace.
 *
 * The namespace is `<family>:<scope>`, e.g. `mastodon:mastodon.social` or
 * `bluesky:public-appview`. The family is the segment before the FIRST
 * separator. Anything unknown, malformed, or scoped by the wrong family fails
 * closed: there is no fallback family.
 */
export function providerFamilyOf(providerNamespace) {
  if (typeof providerNamespace !== 'string' || !providerNamespace) {
    failClosed('PUBLIC_INTELLIGENCE_5K7_PROVIDER_NAMESPACE_INVALID');
  }
  const separator = providerNamespace.indexOf(PUBLIC_INTELLIGENCE_5K7_NAMESPACE_SEPARATOR);
  if (separator <= 0) failClosed(`PUBLIC_INTELLIGENCE_5K7_PROVIDER_NAMESPACE_MALFORMED:${providerNamespace.slice(0, 48)}`);
  const family = providerNamespace.slice(0, separator);
  const scope = providerNamespace.slice(separator + 1);
  if (!PUBLIC_INTELLIGENCE_5K7_PROVIDER_FAMILIES.includes(family)) {
    failClosed(`PUBLIC_INTELLIGENCE_5K7_PROVIDER_FAMILY_UNKNOWN:${family.slice(0, 48)}`);
  }
  if (!scope) failClosed(`PUBLIC_INTELLIGENCE_5K7_PROVIDER_NAMESPACE_SCOPE_MISSING:${providerNamespace.slice(0, 48)}`);
  return family;
}

/** The governed namespace scope (the segment after the first separator). */
export function providerNamespaceScopeOf(providerNamespace) {
  providerFamilyOf(providerNamespace);
  return providerNamespace.slice(providerNamespace.indexOf(PUBLIC_INTELLIGENCE_5K7_NAMESPACE_SEPARATOR) + 1);
}

/** True when a provider namespace is governed by 5K.7. Never throws. */
export function isGovernedProviderNamespace(providerNamespace) {
  try {
    providerFamilyOf(providerNamespace);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 4. COVERAGE STATUS (CLOSED; NO ORDINAL LEVELS, NO SCORE)
// ---------------------------------------------------------------------------

/**
 * The closed coverage status for one exact-mint coverage record.
 *
 * MULTI_PROVIDER_FAMILY requires AT LEAST TWO DISTINCT PROVIDER FAMILIES. Two
 * instances of the same family are SINGLE_PROVIDER_FAMILY, however many
 * namespaces contribute.
 *
 * There is deliberately NO LOW / MEDIUM / HIGH and NO numeric level: an ordinal
 * tier would read as strength of evidence, which is precisely what this phase
 * refuses to express.
 */
export const PUBLIC_INTELLIGENCE_5K7_COVERAGE_STATUS = Object.freeze({
  SINGLE_PROVIDER_FAMILY: 'SINGLE_PROVIDER_FAMILY',
  MULTI_PROVIDER_FAMILY: 'MULTI_PROVIDER_FAMILY',
});

export const PUBLIC_INTELLIGENCE_5K7_COVERAGE_STATUS_VALUES = Object.freeze(
  Object.values(PUBLIC_INTELLIGENCE_5K7_COVERAGE_STATUS),
);

/** The status implied by a family count. Two or more families => MULTI. */
export function coverageStatusForFamilyCount(familyCount) {
  if (!Number.isSafeInteger(familyCount) || familyCount < 1) {
    failClosed('PUBLIC_INTELLIGENCE_5K7_COVERAGE_FAMILY_COUNT_INVALID');
  }
  return familyCount >= 2
    ? PUBLIC_INTELLIGENCE_5K7_COVERAGE_STATUS.MULTI_PROVIDER_FAMILY
    : PUBLIC_INTELLIGENCE_5K7_COVERAGE_STATUS.SINGLE_PROVIDER_FAMILY;
}

// ---------------------------------------------------------------------------
// 5. SNAPSHOT-LEVEL COVERAGE CLASSIFICATION
// ---------------------------------------------------------------------------

/**
 * A SNAPSHOT-level classification, never a per-record status. It records only
 * whether the snapshot observed ANY exact-mint evidence at all. It is not a
 * quality judgement and it is not a tier.
 */
export const PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_COVERAGE_CLASSIFICATION = Object.freeze({
  NO_EXACT_MINT_EVIDENCE: 'NO_EXACT_MINT_EVIDENCE',
  HAS_EXACT_MINT_EVIDENCE: 'HAS_EXACT_MINT_EVIDENCE',
});

export const PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_COVERAGE_CLASSIFICATION_VALUES = Object.freeze(
  Object.values(PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_COVERAGE_CLASSIFICATION),
);

export function snapshotCoverageClassificationFor(exactMintCount) {
  if (!Number.isSafeInteger(exactMintCount) || exactMintCount < 0) {
    failClosed('PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_EXACT_MINT_COUNT_INVALID');
  }
  return exactMintCount === 0
    ? PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_COVERAGE_CLASSIFICATION.NO_EXACT_MINT_EVIDENCE
    : PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_COVERAGE_CLASSIFICATION.HAS_EXACT_MINT_EVIDENCE;
}

// ---------------------------------------------------------------------------
// 6. NON-GOALS AND PROHIBITED SEMANTICS (STATED AS DATA)
// ---------------------------------------------------------------------------

/**
 * Concepts this phase deliberately does NOT compute. Declared so a reviewer can
 * read the whole rule set in one place instead of inferring it from code, and so
 * a test can assert that no prohibited name is exported.
 */
export const PUBLIC_INTELLIGENCE_5K7_PROHIBITED_TERMS = Object.freeze([
  'consensus', 'confidence', 'signal', 'score', 'rank', 'ranking', 'strength',
  'conviction', 'momentum', 'importance', 'popularity', 'virality', 'sentiment',
  'recommendation', 'prediction', 'forecast', 'alpha', 'profit', 'return',
  'trend', 'weight', 'tier', 'level', 'quality',
]);

/**
 * Query entry points this phase explicitly does NOT expose. The validator
 * inspects the exported query API names and refuses any of these.
 */
export const PUBLIC_INTELLIGENCE_5K7_PROHIBITED_QUERY_NAMES = Object.freeze([
  'rankByProviderCount', 'rankByObservationCount', 'rankByEngagement',
  'scoreMint', 'scoreCorroboration', 'recommendMint', 'predictMint',
  'selectTradeCandidate', 'rankMints', 'sortByStrength', 'scoreCoverage',
]);

/** The semantics disclosure, stated as data. Every field is a declaration. */
export const PUBLIC_INTELLIGENCE_5K7_COVERAGE_SEMANTICS = Object.freeze({
  readOnly: true,
  derivedLayer: true,
  subjectIsExactMintOnly: true,
  crossProviderMergePerformed: false,
  underlyingEvidenceMergedAcrossProviders: false,
  claimsTruthEvaluated: false,
  providerAgreementInferred: false,
  independenceInferredFromTime: false,
  simultaneityInferred: false,
  absenceInterpreted: false,
  absenceFromOneProviderImpliesAbsence: false,
  scoreComputed: false,
  rankComputed: false,
  confidenceTierComputed: false,
  ordinalLevelAssigned: false,
  sentimentComputed: false,
  momentumComputed: false,
  popularityComputed: false,
  importanceComputed: false,
  predictionMade: false,
  recommendationMade: false,
  tradingInferenceMade: false,
  marketDataAccessed: false,
  clockRead: false,
  filesystemMtimeUsed: false,
  directoryOrderUsed: false,
  repeatedAcquisitionCountedAsNewUpstreamEvidence: false,
  engagementUsedAsEvidenceOfAnything: false,
  containsPostBodies: false,
  containsAuthorProfiles: false,
  containsCredentials: false,
});

/**
 * The wall-clock / ordering rule, stated as data. Every timestamp in this phase
 * is COPIED from an authenticated source record; none is invented.
 */
export const PUBLIC_INTELLIGENCE_5K7_TIME_SEMANTICS = Object.freeze({
  timestampsCopiedFromAuthenticatedEvidence: true,
  currentTimeUsed: false,
  filesystemMtimeUsed: false,
  directoryOrderUsed: false,
  simultaneityInferred: false,
  timeSeparationImpliesIndependence: false,
  observedAtField: 'fetchedAt',
  deterministicOrderingKey: 'fetchedAt',
});

/** The closed disclosure that no market or trading surface is reachable here. */
export const PUBLIC_INTELLIGENCE_5K7_MARKET_LINKAGE = Object.freeze({
  priceDataAccessed: false,
  returnsAccessed: false,
  volatilityAccessed: false,
  r4OutcomeDataAccessed: false,
  tradingEngineReached: false,
  arenaReached: false,
  walletAccessed: false,
  signerAccessed: false,
  swapReached: false,
  rpcWriteReached: false,
  futureMovementAssociated: false,
});

/** One canonical deterministic fingerprint over any JSON value. */
export function corroborationFingerprint(value) {
  return digest(value);
}

/** Canonical JSON, re-exported so callers do not reach into another phase. */
export { canonical };

/** Re-exported so a caller cannot accidentally import a second classification. */
export { PUBLIC_INTELLIGENCE_CLASSIFICATION };
