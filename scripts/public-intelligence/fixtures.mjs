// Phase 5K.1 - FIXTURE PROVIDERS: synthetic, offline, entirely fictional.
//
// These fixtures stand in for two INVENTED providers. They are not X, Reddit,
// Telegram, Discord, Farcaster, Bluesky, Mastodon or any other real service,
// they contact nothing, and they exist only so the ingestion and provenance
// rules can be exercised offline and deterministically.
//
// The fixture set is chosen to attack the rules that matter: exact mint,
// duplicate id, same-text-new-id, cross-provider same text, symbol-only,
// name-only, ambiguous multiple mints, invalid mint, lowercase mint, missing
// publishedAt, independent timestamps, malformed timestamp, fractional
// timestamp, look-ahead, unknown schema field, forbidden field, mutated raw
// evidence.
//
// OFFLINE BY CONSTRUCTION: this module has no side effects at all.
import {
  PUBLIC_INTELLIGENCE_CLASSIFICATION, PUBLIC_INTELLIGENCE_SCHEMA_VERSION,
  PUBLIC_INTELLIGENCE_RECORD_TYPES,
} from './definition.mjs';

/** Fictional provider identities. Neither exists in the wild. */
export const FIXTURE_PROVIDER_A = 'fixture_alpha';
export const FIXTURE_PROVIDER_B = 'fixture_beta';

export const PUBLIC_INTELLIGENCE_5K1_FIXTURE_PROVIDERS = Object.freeze({
  [FIXTURE_PROVIDER_A]: Object.freeze({
    name: FIXTURE_PROVIDER_A,
    real: false,
    network: false,
    note: 'Synthetic provider. Invented for 5K.1 offline tests.',
  }),
  [FIXTURE_PROVIDER_B]: Object.freeze({
    name: FIXTURE_PROVIDER_B,
    real: false,
    network: false,
    note: 'Synthetic provider. Invented for 5K.1 offline tests.',
  }),
});

// Real, publicly known, case-sensitive Solana addresses used as inert test
// data. They are constants in a fixture file, not keys and not accounts.
export const FIXTURE_MINT_EXACT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const FIXTURE_MINT_SECOND = 'So11111111111111111111111111111111111111112';
export const FIXTURE_MINT_LOWERCASE = 'epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v';

// Fixed instants. Nothing here reads a clock: a fixture that read Date.now()
// could not be compared across runs.
export const FIXTURE_AT_PUBLISHED = 1800000000000;
export const FIXTURE_AT_OBSERVED = 1800000060000;
export const FIXTURE_AT_FETCHED = 1800000120000;

const COLLECTION_CONTEXT = Object.freeze({
  collectionRunId: 'fixture-run-5k1-0001',
  adapterName: 'offline_fixture_adapter',
  adapterVersion: '5k1.0.0',
  collectorMode: 'OFFLINE_FIXTURE',
});

const BASE_METADATA = Object.freeze({
  language: 'en',
  claimedSymbol: null,
  claimedTokenName: null,
  cashtags: [],
  hashtags: [],
  mentionedHandles: [],
  candidateMintAddresses: [FIXTURE_MINT_EXACT],
  similaritySignals: [],
  engagement: { likes: 12, replies: 1, reposts: 0 },
  fixtureNote: 'exact-mint provider A post',
});

/**
 * Builds a raw observation fixture. Overrides are applied LAST so a fixture can
 * deliberately violate a rule (to prove the rule refuses it).
 */
export function rawFixture(overrides = {}) {
  return {
    schemaVersion: PUBLIC_INTELLIGENCE_SCHEMA_VERSION,
    recordType: PUBLIC_INTELLIGENCE_RECORD_TYPES.RAW_SOCIAL_OBSERVATION,
    provider: FIXTURE_PROVIDER_A,
    providerObservationId: 'alpha-0001',
    providerAuthorId: 'alpha-author-1',
    sourceType: 'POST',
    sourceUrl: 'https://fixture.invalid/alpha/alpha-0001',
    publishedAt: FIXTURE_AT_PUBLISHED,
    observedAt: FIXTURE_AT_OBSERVED,
    fetchedAt: FIXTURE_AT_FETCHED,
    rawText: `fixture alpha post referencing ${FIXTURE_MINT_EXACT}`,
    rawMetadata: { ...BASE_METADATA },
    claimedMint: FIXTURE_MINT_EXACT,
    collectionContext: { ...COLLECTION_CONTEXT },
    classification: PUBLIC_INTELLIGENCE_CLASSIFICATION,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// FIXTURE CATALOGUE
// ---------------------------------------------------------------------------

/** A provider A post carrying an exact, valid base58 mint. */
export const exactMintProviderAPost = () => rawFixture();

/** The SAME provider and observation id, byte-identical. Must dedup. */
export const exactMintProviderADuplicate = () => rawFixture();

/** Same provider, DIFFERENT observation id, byte-identical text. Stays distinct. */
export const exactMintProviderARepost = () => rawFixture({
  providerObservationId: 'alpha-0002',
  sourceUrl: 'https://fixture.invalid/alpha/alpha-0002',
  rawMetadata: {
    ...BASE_METADATA,
    fixtureNote: 'provider A repost: identical text, new upstream id',
  },
});

/** Provider B carrying byte-identical text to provider A. Stays distinct. */
export const exactMintProviderBSameText = () => rawFixture({
  provider: FIXTURE_PROVIDER_B,
  providerObservationId: 'beta-0001',
  providerAuthorId: 'beta-author-1',
  sourceUrl: 'https://fixture.invalid/beta/beta-0001',
  rawMetadata: {
    ...BASE_METADATA,
    fixtureNote: 'provider B same text, different provider',
  },
});

/** A symbol-only post: names a ticker, carries no exact mint. Must stay UNASSOCIATED. */
export const symbolOnlyPost = () => rawFixture({
  providerObservationId: 'alpha-0100',
  providerAuthorId: null,
  sourceUrl: null,
  rawText: 'fixture post about $ALPHATOKEN with no address at all',
  rawMetadata: {
    language: 'en',
    claimedSymbol: 'ALPHATOKEN',
    claimedTokenName: null,
    cashtags: ['$ALPHATOKEN'],
    hashtags: [],
    mentionedHandles: [],
    candidateMintAddresses: [],
    similaritySignals: ['SYMBOL_ONLY'],
    engagement: null,
    fixtureNote: 'symbol only, no exact mint',
  },
  claimedMint: null,
});

/** A name-only post: names the token, carries no exact mint. Must stay UNASSOCIATED. */
export const nameOnlyPost = () => rawFixture({
  providerObservationId: 'alpha-0101',
  providerAuthorId: null,
  sourceUrl: null,
  rawText: 'fixture post naming the project only, no ticker and no address',
  rawMetadata: {
    language: 'en',
    claimedSymbol: null,
    claimedTokenName: 'Alpha Token Project',
    cashtags: [],
    hashtags: ['#solana'],
    mentionedHandles: ['@alphatokenhandle'],
    candidateMintAddresses: [],
    similaritySignals: ['TOKEN_NAME_ONLY', 'PROFILE_NAME_SIMILARITY'],
    engagement: null,
    fixtureNote: 'name and handle only, no exact mint',
  },
  claimedMint: null,
});

/** Two distinct exact mints in one observation. Must be AMBIGUOUS, never guessed. */
export const ambiguousMultipleMintsPost = () => rawFixture({
  providerObservationId: 'alpha-0102',
  rawText: `fixture post citing both ${FIXTURE_MINT_EXACT} and ${FIXTURE_MINT_SECOND}`,
  rawMetadata: {
    ...BASE_METADATA,
    candidateMintAddresses: [FIXTURE_MINT_EXACT, FIXTURE_MINT_SECOND],
    fixtureNote: 'two exact candidates, refuse to force a match',
  },
});

/** A claimed mint that is not a valid base58 Solana address. */
export const invalidMintPost = () => rawFixture({
  providerObservationId: 'alpha-0103',
  rawText: 'fixture post claiming a malformed address',
  rawMetadata: {
    ...BASE_METADATA,
    candidateMintAddresses: ['not-a-real-solana-mint-address'],
    fixtureNote: 'claimed mint is not exact base58',
  },
  claimedMint: 'not-a-real-solana-mint-address',
});

/**
 * A lowercase address. Solana addresses are case-sensitive, so this string is a
 * DIFFERENT identity from the uppercase form - it is never treated as a match
 * for it. It is included to pin that behaviour: case folding is not performed,
 * and no canonicalization step repairs a differently-cased address.
 */
export const lowercaseMintPost = () => rawFixture({
  providerObservationId: 'alpha-0104',
  rawText: `fixture post citing ${FIXTURE_MINT_LOWERCASE} in lowercase`,
  rawMetadata: {
    ...BASE_METADATA,
    candidateMintAddresses: [FIXTURE_MINT_LOWERCASE],
    fixtureNote: 'lowercase address is a different identity, not a match',
  },
  claimedMint: FIXTURE_MINT_LOWERCASE,
});

/** publishedAt absent. It must stay null, never become fetchedAt. */
export const missingPublishedAtPost = () => rawFixture({
  providerObservationId: 'alpha-0105',
  rawMetadata: { ...BASE_METADATA, fixtureNote: 'provider supplied no publication time' },
  publishedAt: null,
});

/** Three genuinely independent clocks, in causal order. */
export const independentTimestampsPost = () => rawFixture({
  providerObservationId: 'alpha-0106',
  publishedAt: 1799990000000,
  observedAt: 1799995000000,
  fetchedAt: 1800000000000,
  rawMetadata: { ...BASE_METADATA, fixtureNote: 'three distinct clocks' },
});

/** A non-finite timestamp. Validation must refuse it. */
export const malformedTimestampPost = () => rawFixture({
  providerObservationId: 'alpha-0107',
  observedAt: Number.NaN,
});

/** A float epoch value. Integer milliseconds are required. */
export const fractionalTimestampPost = () => rawFixture({
  providerObservationId: 'alpha-0108',
  observedAt: FIXTURE_AT_OBSERVED + 0.5,
});

/** Fetched before it was observed. Look-ahead; must be refused. */
export const fetchBeforeObservedPost = () => rawFixture({
  providerObservationId: 'alpha-0109',
  observedAt: FIXTURE_AT_FETCHED + 60000,
  fetchedAt: FIXTURE_AT_FETCHED,
});

/** An unknown top-level field. The closed schema must refuse it. */
export const unknownSchemaFieldPost = () => ({
  ...rawFixture(),
  providerObservationId: 'alpha-0110',
  sentimentScore: 0.97,
});

/** An unknown field nested inside rawMetadata. Also refused. */
export const unknownMetadataFieldPost = () => rawFixture({
  providerObservationId: 'alpha-0111',
  rawMetadata: { ...BASE_METADATA, botScore: 0.12 },
});

/** A privacy-breaching field. Refused even though it is inside rawMetadata. */
export const forbiddenFieldPost = () => rawFixture({
  providerObservationId: 'alpha-0112',
  rawMetadata: { ...BASE_METADATA, accessToken: 'fixture-not-a-real-token' },
});

/**
 * MUTATED evidence: same provider, same observation id, different bytes.
 * This is the tamper/conflict case and must never silently overwrite.
 */
export const mutatedRawEvidencePost = () => rawFixture({
  providerObservationId: 'alpha-0001',
  rawText: 'MUTATED fixture alpha post text, same upstream id, different bytes',
  rawMetadata: { ...BASE_METADATA, fixtureNote: 'mutated evidence' },
});

/** Every fixture, addressable by name. */
export const PUBLIC_INTELLIGENCE_5K1_FIXTURES = Object.freeze({
  exactMintProviderAPost,
  exactMintProviderADuplicate,
  exactMintProviderARepost,
  exactMintProviderBSameText,
  symbolOnlyPost,
  nameOnlyPost,
  ambiguousMultipleMintsPost,
  invalidMintPost,
  lowercaseMintPost,
  missingPublishedAtPost,
  independentTimestampsPost,
  malformedTimestampPost,
  fractionalTimestampPost,
  fetchBeforeObservedPost,
  unknownSchemaFieldPost,
  unknownMetadataFieldPost,
  forbiddenFieldPost,
  mutatedRawEvidencePost,
});

/** The synthetic-provider declaration, for the validator and for reviewers. */
export const PUBLIC_INTELLIGENCE_5K1_FIXTURE_DECLARATION = Object.freeze({
  providers: Object.freeze([FIXTURE_PROVIDER_A, FIXTURE_PROVIDER_B]),
  anyProviderIsReal: false,
  anyNetworkIsContacted: false,
  anyCredentialIsUsed: false,
  realServicesReferenced: false,
  dependencies: Object.freeze([]),
});

