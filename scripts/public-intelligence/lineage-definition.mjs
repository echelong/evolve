// Phase 5K.8 - CROSS-PROVIDER CONTENT LINEAGE: the definition module.
//
// PURE AND OFFLINE BY CONSTRUCTION. No socket, no clock, no environment, no
// filesystem, no credential, no provider SDK, no LLM, no embedding, no vector
// store. It opens no connection, reads no environment variable, starts no
// process and writes no file.
//
// WHAT THIS LAYER IS
//
// Phase 5K.7 answers a STRUCTURAL COVERAGE question: was one exact mint seen in
// evidence from more than one provider family? That is true, and it is not the
// same question as "is the underlying content distinct?":
//
//   Mastodon: "Mint XYZ just launched..."
//   Bluesky:  the SAME TEXT, cross-posted by the same operator
//
// 5K.7 correctly reports MULTI_PROVIDER_FAMILY. 5K.8 adds a SEPARATE, read-only
// lineage layer that can describe, for the content behind that coverage:
//
//   - distinct content
//   - exact cross-provider duplicate content
//   - canonical-equivalent cross-provider content
//   - directly-declared cross-post references
//   - unresolved similarity
//
// WITHOUT claiming truth, independence of authors, consensus, confidence,
// importance, popularity, market relevance or any trading signal.
//
// THE PRINCIPLE THIS PHASE EXISTS TO PROTECT
//
//   PROVIDER DIVERSITY != CONTENT DIVERSITY.
//
// Both dimensions stay separately visible - providerFamilyCount AND
// contentLineageCount - and are never collapsed into one score.
//
// THE LANGUAGE RULE
//
// Even an exact text match across providers does NOT prove copying. The class
// EXACT_RAW_TEXT_MATCH means ONLY that the authenticated text payloads are
// identical. It never means one copied the other, never means the same human
// author, never means the same organization and never means the same claim
// source. There is no INDEPENDENT, ORIGINAL, COPIED or PLAGIARIZED class.
//
// NO SEMANTIC MATCHING. There is no LLM, no embedding, no vector or semantic
// similarity, no topic model, no fuzzy NLP and no sentiment model anywhere in
// this phase. Every match is an exact equality over authenticated, reproducible
// fingerprints.
import { PUBLIC_INTELLIGENCE_CLASSIFICATION, canonical, digest } from './definition.mjs';
import { failClosed } from './observation.mjs';
import { providerFamilyOf, PUBLIC_INTELLIGENCE_5K7_PROVIDER_FAMILIES } from './corroboration-definition.mjs';

// ---------------------------------------------------------------------------
// 1. PHASE AND POLICY IDENTITY
// ---------------------------------------------------------------------------

export const PUBLIC_INTELLIGENCE_5K8_PHASE = 'PHASE_5K_8';
export const PUBLIC_INTELLIGENCE_5K8_SCHEMA_VERSION = '5K.8.0';

/**
 * The governed lineage policy name.
 *
 * Any change to the lineage-class rule, the matching layer rule, the governed
 * permalink shapes, the content-version identity rule, the record shapes or the
 * snapshot accounting is a NEW policy name. The policy name participates in
 * every derived identity and fingerprint, so a policy change can never be
 * silently absorbed by an old artifact.
 */
export const PUBLIC_INTELLIGENCE_5K8_POLICY_VERSION = 'lineage-policy-1';

export const PUBLIC_INTELLIGENCE_5K8_RECORD_TYPES = Object.freeze({
  CONTENT_VERSION: 'public_lineage_content_version',
  LINEAGE: 'public_lineage_record',
  SNAPSHOT: 'public_lineage_snapshot',
});

// ---------------------------------------------------------------------------
// 2. THE CLOSED LINEAGE-CLASS VOCABULARY
// ---------------------------------------------------------------------------

/**
 * The closed lineage classes. There is no ordinal level, no strength and no
 * confidence anywhere in this enum, and no INDEPENDENT / ORIGINAL / COPIED /
 * PLAGIARIZED / CONSENSUS value: none of those is provable from presence.
 *
 * A lineage (one connected component of content versions) is classified by the
 * most STRUCTURAL mechanism its members share, never by how many members it has.
 * Precedence is about EVIDENCED MECHANISM, not about evidentiary weight:
 *
 *   DISTINCT_CONTENT              one member, and nothing else matches it
 *   EXACT_RAW_TEXT_MATCH          members share one authenticated raw-text digest
 *   CANONICAL_TEXT_MATCH          members share one canonical-text digest only
 *   EXPLICIT_CROSS_POST_REFERENCE members are joined by a directly-declared,
 *                                 structurally resolved governed post reference
 *   UNRESOLVED                    members are joined only by a mixture of the
 *                                 above mechanisms, so no single one describes
 *                                 the whole lineage
 */
export const PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS = Object.freeze({
  DISTINCT_CONTENT: 'DISTINCT_CONTENT',
  EXACT_RAW_TEXT_MATCH: 'EXACT_RAW_TEXT_MATCH',
  CANONICAL_TEXT_MATCH: 'CANONICAL_TEXT_MATCH',
  EXPLICIT_CROSS_POST_REFERENCE: 'EXPLICIT_CROSS_POST_REFERENCE',
  UNRESOLVED: 'UNRESOLVED',
});

export const PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS_VALUES = Object.freeze(
  Object.values(PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS),
);

/**
 * The governed matching layers. Two layers compare AUTHENTICATED TEXT
 * FINGERPRINTS, and the third compares a DECLARED, structurally resolved post
 * reference. Nothing else may join two content versions.
 *
 * RAW_TEXT       exact character-for-character equality of authenticated rawText
 *                (5K.1's `rawTextFingerprint`, imported unchanged)
 * CANONICAL_TEXT equality of 5K.1's deterministic `canonicalText`, whose ONLY
 *                transformation is line-ending normalization (CRLF/CR -> LF)
 * EXPLICIT_REFERENCE a governed provider permalink carried by authenticated
 *                evidence that resolves to another post present in the corpus
 */
export const PUBLIC_INTELLIGENCE_5K8_MATCH_LAYERS = Object.freeze([
  'RAW_TEXT', 'CANONICAL_TEXT', 'EXPLICIT_REFERENCE',
]);

/**
 * The canonical-text semantics, restated as data. This phase adds NO new
 * normalization: it reuses 5K.1's `canonicalText`, whose semantics are frozen
 * and deliberately minimal. Nothing is lowercased, stemmed, lemmatized,
 * translated, tokenized, stop-word removed or semantically normalized, and no
 * arbitrary words are removed.
 */
export const PUBLIC_INTELLIGENCE_5K8_TEXT_SEMANTICS = Object.freeze({
  reusesCanonicalText5K1: true,
  newNormalizationIntroduced: false,
  rawTextPreservedCharacterForCharacter: true,
  lineEndingNormalizationOnly: true,
  aggressiveNormalizationApplied: false,
  lowercasingApplied: false,
  stemmingApplied: false,
  lemmatizationApplied: false,
  translationApplied: false,
  tokenizationApplied: false,
  stopWordRemovalApplied: false,
  semanticNormalizationApplied: false,
  arbitraryWordRemovalApplied: false,
  llmUsed: false,
  embeddingUsed: false,
  vectorSimilarityUsed: false,
  semanticSimilarityUsed: false,
  topicModelUsed: false,
  fuzzyNlpUsed: false,
  sentimentModelUsed: false,
  characterEditDistanceUsed: false,
  approximateMatchingUsed: false,
  rawTextFingerprintReusedFrom5K1: true,
  canonicalTextFingerprintReusedFrom5K1: true,
  alternateRawFingerprintCreated: false,
});

/** The duplication language rule, stated as data so a test asserts it directly. */
export const PUBLIC_INTELLIGENCE_5K8_DUPLICATION_SEMANTICS = Object.freeze({
  exactTextMatchEvaluated: true,
  exactTextMatchProvesCopying: false,
  exactTextMatchProvesSameAuthor: false,
  exactTextMatchProvesSameOrganization: false,
  exactTextMatchProvesSameClaimSource: false,
  originalityInferred: false,
  copyingInferred: false,
  plagiarismInferred: false,
  truthEvaluated: false,
  authorIndependenceInferred: false,
  crossProviderMergePerformed: false,
  underlyingEvidenceMergedAcrossProviders: false,
  sameTextCountsAsIndependence: false,
  runAppearanceCountedAsNewContentVersion: false,
  engagementChangeCountedAsNewContentVersion: false,
  engagementUsedAsEvidenceOfAnything: false,
});

// ---------------------------------------------------------------------------
// 3. PROVIDER FAMILY / NAMESPACE (one rule, inherited from 5K.7)
// ---------------------------------------------------------------------------

/**
 * Provider independence for 5K.8 is the SAME rule 5K.7 froze: a different
 * governed provider FAMILY. It is never two posts, two instances, two authors,
 * two times or two texts. 5K.8 imports 5K.7's derivation rather than restating
 * it, so the two phases cannot drift apart.
 */
export const PUBLIC_INTELLIGENCE_5K8_PROVIDER_SEMANTICS = Object.freeze({
  independenceUnit: 'PROVIDER_FAMILY',
  twoInstancesOfOneFamilyAreOneFamily: true,
  twoPostsOfOneFamilyAreOneFamily: true,
  sameTextAcrossFamiliesIsOneLineage: true,
  sameFamilyDuplicationIsCrossProviderCorroboration: false,
  providerFamilyDerivationReusedFrom5K7: true,
});

/** The governed families, re-exported so a caller cannot invent a second list. */
export const PUBLIC_INTELLIGENCE_5K8_PROVIDER_FAMILIES = PUBLIC_INTELLIGENCE_5K7_PROVIDER_FAMILIES;

/** The governed provider family of a namespace. Fails closed on anything else. */
export function providerFamilyFor(providerNamespace) {
  return providerFamilyOf(providerNamespace);
}

// ---------------------------------------------------------------------------
// 4. EXPLICIT REFERENCE SEMANTICS (declared, never inferred)
// ---------------------------------------------------------------------------

/**
 * A reference is EXPLICIT only when authenticated source evidence carries a
 * governed provider permalink that resolves to a DIFFERENT post identity which
 * is itself present in the authenticated corpus.
 *
 * It is never inferred from matching text, a close timestamp, a similar handle,
 * a similar display name or any similarity score, and this phase never resolves
 * a human identity across providers.
 */
export const PUBLIC_INTELLIGENCE_5K8_REFERENCE_STATUS = Object.freeze({
  NO_REFERENCE: 'NO_REFERENCE',
  REFERENCE_RESOLVED: 'REFERENCE_RESOLVED',
  REFERENCE_UNRESOLVED: 'REFERENCE_UNRESOLVED',
});

export const PUBLIC_INTELLIGENCE_5K8_REFERENCE_STATUS_VALUES = Object.freeze(
  Object.values(PUBLIC_INTELLIGENCE_5K8_REFERENCE_STATUS),
);

/**
 * The governed permalink shapes. A URL becomes a candidate reference ONLY when
 * it matches one of these forms exactly; every other URL stays ordinary
 * evidence. Nothing is crawled and nothing is fetched: resolution is a lookup
 * against the authenticated corpus that is already in memory.
 */
export const PUBLIC_INTELLIGENCE_5K8_GOVERNED_PERMALINK_SHAPES = Object.freeze([
  Object.freeze({ family: 'bluesky', scheme: 'https', host: 'bsky.app', path: '/profile/<did>/post/<rkey>' }),
  Object.freeze({ family: 'mastodon', scheme: 'https', host: '<instance>', path: '/@<user>/<statusId>' }),
]);

export const PUBLIC_INTELLIGENCE_5K8_REFERENCE_SEMANTICS = Object.freeze({
  explicitOnlyWhenDirectlyEvidenced: true,
  arbitraryUrlTurnedIntoContentIdentity: false,
  resolvedOnlyAgainstAuthenticatedCorpus: true,
  targetMustExistInAuthenticatedCorpus: true,
  structurallyVerifiableOnly: true,
  crawlingPerformed: false,
  refetchPerformed: false,
  textSimilarityCreatesReference: false,
  timestampProximityCreatesReference: false,
  handleSimilarityCreatesReference: false,
  displayNameSimilarityCreatesReference: false,
  crossProviderIdentityResolutionPerformed: false,
  sameProviderReferenceCreatesCrossProviderEdge: false,
  selfPermalinkCountedAsReference: false,
});

// ---------------------------------------------------------------------------
// 5. CONTENT VERSION AND TEMPORAL SEMANTICS
// ---------------------------------------------------------------------------

/**
 * A CONTENT VERSION is 5K.5's own identity: one upstream identity plus one
 * distinct authenticated content fingerprint. Every version is retained; there
 * is no latest-wins rewriting. A provider-declared revision is a separate
 * version, and a version that matched before a later edit keeps matching:
 * version 1 lineage and version 2 lineage are both preserved.
 */
export const PUBLIC_INTELLIGENCE_5K8_VERSION_SEMANTICS = Object.freeze({
  contentVersionIdentity: 'UPSTREAM_IDENTITY_PLUS_CONTENT_FINGERPRINT',
  everyVersionRetained: true,
  latestWinsRewriting: false,
  providerDeclaredRevisionIsSeparateVersion: true,
  engagementOnlyChangeIsSeparateVersion: false,
  repeatedAcquisitionIsSeparateVersion: false,
  versionsMergedAcrossProviders: false,
  versionsMergedAcrossIdentities: false,
});

/** Time is COPIED from authenticated evidence; it is never invented or inferred. */
export const PUBLIC_INTELLIGENCE_5K8_TIME_SEMANTICS = Object.freeze({
  timestampsCopiedFromAuthenticatedEvidence: true,
  currentTimeUsed: false,
  filesystemMtimeUsed: false,
  directoryOrderUsed: false,
  simultaneityInferred: false,
  causalityInferred: false,
  originInferred: false,
  earlierObservationImpliesLaterCopied: false,
  deterministicOrderingKey: 'fetchedAt',
});

// ---------------------------------------------------------------------------
// 6. MISSINGNESS
// ---------------------------------------------------------------------------

/**
 * Missingness is explicit and is NEVER repaired. The 5K.1 raw schema requires
 * `rawText` to be a string, so absent text is not representable in
 * authenticated evidence: this layer cannot fabricate matchability because it
 * cannot receive a text-free observation. What remains representable is an
 * unresolved REFERENCE, which is reported as such and creates no edge.
 */
export const PUBLIC_INTELLIGENCE_5K8_MISSINGNESS_SEMANTICS = Object.freeze({
  rawTextRequiredBySchema: true,
  canonicalTextRequiredBySchema: true,
  missingTextRepresentable: false,
  absentTextTreatedAsEmptyString: false,
  matchabilityFabricatedWhenTextAbsent: false,
  unresolvedReferenceReportedExplicitly: true,
  unresolvedReferenceCreatesEdge: false,
  absenceInterpreted: false,
  absenceFromOneProviderImpliesAbsence: false,
  coverageGapInterpreted: false,
});

// ---------------------------------------------------------------------------
// 7. CONTENT DIVERSITY (discrete structural facts, never a score)
// ---------------------------------------------------------------------------

/**
 * The content-diversity disclosure. Both dimensions stay visible: provider
 * diversity (5K.7) and content diversity (5K.8) are separate structural facts
 * and are never collapsed, weighted or combined.
 *
 * The two named interpretation traps are refused explicitly:
 *
 *   MULTI_PROVIDER_FAMILY + ONE lineage   does NOT mean false corroboration
 *   MULTI_PROVIDER_FAMILY + TWO lineages  does NOT mean stronger truth
 *
 * Both are provenance/coverage descriptors only.
 */
export const PUBLIC_INTELLIGENCE_5K8_DIVERSITY_SEMANTICS = Object.freeze({
  providerDiversityReported: true,
  contentDiversityReported: true,
  dimensionsCollapsed: false,
  singleScoreComputed: false,
  ratioInterpretedAsQuality: false,
  ratioExposed: false,
  scoreComputed: false,
  rankComputed: false,
  confidenceTierAssigned: false,
  ordinalLevelAssigned: false,
  oneLineageMeansFalseCorroboration: false,
  twoLineagesMeansStrongerTruth: false,
  lineageCountIsImportance: false,
  moreProvidersIsMoreImportant: false,
  predictionMade: false,
  recommendationMade: false,
  tradingInferenceMade: false,
});

// ---------------------------------------------------------------------------
// 8. PRIVACY, IDENTITY AND MARKET NON-GOALS (stated as data)
// ---------------------------------------------------------------------------

/** No new personal-data surface is introduced by this phase. */
export const PUBLIC_INTELLIGENCE_5K8_PRIVACY = Object.freeze({
  derivedReferencesOnly: true,
  postBodiesPersisted: false,
  displayNamesPersisted: false,
  handlesPersisted: false,
  biosPersisted: false,
  avatarsPersisted: false,
  followerDataAccessed: false,
  contactGraphAccessed: false,
  mentionGraphAccessed: false,
  geolocationAccessed: false,
  addressesAccessed: false,
  credentialsAccessed: false,
  cookiesAccessed: false,
  urlsPersisted: false,
});

/**
 * CONTENT LINEAGE IS NOT IDENTITY RESOLUTION. A Mastodon account and a Bluesky
 * DID remain separate identities forever: no same-handle, same-display-name,
 * same-bio, same-domain, same-avatar or same-text inference is permitted.
 */
export const PUBLIC_INTELLIGENCE_5K8_IDENTITY_RESOLUTION = Object.freeze({
  crossProviderHumanIdentityResolutionPerformed: false,
  authorIdentityComparedAcrossProviders: false,
  authorIdentifiersPersisted: false,
  sameHandleImpliesSamePerson: false,
  sameDisplayNameImpliesSamePerson: false,
  sameBioImpliesSamePerson: false,
  sameDomainImpliesSamePerson: false,
  sameAvatarImpliesSamePerson: false,
  sameTextImpliesSamePerson: false,
  mastodonAndBlueskyIdentitiesRemainSeparate: true,
});

/** The closed denial of any market, trading or outcome linkage. */
export const PUBLIC_INTELLIGENCE_5K8_MARKET_LINKAGE = Object.freeze({
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
  corroborationScoreComputed: false,
  tradeCandidateSelected: false,
});

/** Concepts this phase deliberately does NOT compute, declared so it is auditable. */
export const PUBLIC_INTELLIGENCE_5K8_PROHIBITED_TERMS = Object.freeze([
  'consensus', 'confidence', 'signal', 'score', 'rank', 'ranking', 'strength',
  'conviction', 'momentum', 'importance', 'popularity', 'virality', 'sentiment',
  'recommendation', 'prediction', 'forecast', 'alpha', 'profit', 'return',
  'trend', 'weight', 'tier', 'level', 'quality', 'original', 'plagiarized',
  'independent', 'copied', 'diversity', 'similarity',
]);

/** Query entry points this phase explicitly does NOT expose. */
export const PUBLIC_INTELLIGENCE_5K8_PROHIBITED_QUERY_NAMES = Object.freeze([
  'scoreDiversity', 'scoreCorroboration', 'rankMints', 'rankLineages', 'confidenceFor',
  'recommendMint', 'predictMint', 'selectTradeCandidate', 'rankByLineageCount',
  'rankByContentVersionCount', 'originalityOf', 'copiedFrom', 'similarityScore',
  'resolveAuthorIdentity', 'diversityScore',
]);

// ---------------------------------------------------------------------------
// 9. HELPERS
// ---------------------------------------------------------------------------

/** One canonical deterministic fingerprint over any JSON value. */
export function lineageFingerprint(value) {
  return digest(value);
}

/**
 * The lineage class implied by a group's evidenced mechanisms.
 *
 * `hasExplicitReference` is true when any member pair is joined by a directly
 * declared, structurally resolved cross-post reference. `rawTextFingerprints`
 * and `canonicalTextFingerprints` are the distinct authenticated digests of the
 * group's members.
 */
export function lineageClassFor({ memberCount, hasExplicitReference, rawTextFingerprints, canonicalTextFingerprints }) {
  if (!Number.isSafeInteger(memberCount) || memberCount < 1) {
    failClosed('PUBLIC_INTELLIGENCE_5K8_LINEAGE_MEMBER_COUNT_INVALID');
  }
  if (!Array.isArray(rawTextFingerprints) || !Array.isArray(canonicalTextFingerprints)) {
    failClosed('PUBLIC_INTELLIGENCE_5K8_LINEAGE_FINGERPRINT_LISTS_INVALID');
  }
  if (memberCount === 1) return PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS.DISTINCT_CONTENT;
  if (hasExplicitReference) return PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS.EXPLICIT_CROSS_POST_REFERENCE;
  if (new Set(rawTextFingerprints).size === 1) return PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS.EXACT_RAW_TEXT_MATCH;
  if (new Set(canonicalTextFingerprints).size === 1) return PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS.CANONICAL_TEXT_MATCH;
  return PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS.UNRESOLVED;
}

/** The lineage class implied by a membership count, for disclosure purposes. */
export function isDuplicateClass(lineageClass) {
  return lineageClass === PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS.EXACT_RAW_TEXT_MATCH
    || lineageClass === PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS.CANONICAL_TEXT_MATCH;
}

/** True when a lineage spans more than one governed provider family. */
export function isMultiProviderFamilyLineage(providerFamilies) {
  if (!Array.isArray(providerFamilies)) failClosed('PUBLIC_INTELLIGENCE_5K8_LINEAGE_FAMILY_LIST_INVALID');
  return providerFamilies.length >= 2;
}

/** Canonical JSON and the frozen classification, re-exported for one import rule. */
export { canonical, PUBLIC_INTELLIGENCE_CLASSIFICATION };
