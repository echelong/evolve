#!/usr/bin/env node
// Phase 5K.1 - Public Social Intelligence INGESTION + PROVENANCE validator.
//
// COMPLETELY OFFLINE AND DETERMINISTIC. This suite opens no socket, contacts no
// provider, holds no key and starts no network process. It proves that 5K.1 can
// ingest, canonicalize, fingerprint, deduplicate and store public social
// observations without ever inventing a mint, collapsing a provider, mutating
// raw evidence, or reaching the engine, Arena, promotion or R4.
//
// Capability and import audits use a real parse tree (espree), not fragile
// string matching. Tests write ONLY to temporary directories and never to the
// repository, R4 evidence, or any existing session. `.evolve` is never touched.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

import {
  PUBLIC_INTELLIGENCE_CLASSIFICATION, PUBLIC_INTELLIGENCE_ALWAYS_FALSE_FLAGS,
  PUBLIC_INTELLIGENCE_ALWAYS_TRUE_FLAGS, PUBLIC_INTELLIGENCE_MISSINGNESS,
  PUBLIC_INTELLIGENCE_NON_CANONICAL_IDENTITY_REJECTS_SYMBOL,
  PUBLIC_INTELLIGENCE_MISSINGNESS_RULE_ZERO_NEVER_MISSING,
  canonicalMintAddress, digest, isValidTimestamp, transactionSubmissionProhibited,
} from './public-intelligence/definition.mjs';
import {
  PUBLIC_INTELLIGENCE_5K1_RAW_SCHEMA, PUBLIC_INTELLIGENCE_5K1_RAW_METADATA_SCHEMA,
  PUBLIC_INTELLIGENCE_5K1_COLLECTION_CONTEXT_SCHEMA, PUBLIC_INTELLIGENCE_5K1_SOURCE_TYPES,
  PUBLIC_INTELLIGENCE_5K1_COLLECTOR_MODES, PUBLIC_INTELLIGENCE_5K1_REJECTED_IDENTITY_SIGNALS,
  canonicalizeRawObservation, rawEvidenceEquals, exactClaimedMint, claimedMintOf,
} from './public-intelligence/observation.mjs';
import {
  PUBLIC_INTELLIGENCE_5K1_FINGERPRINTING, PUBLIC_INTELLIGENCE_5K1_PROVENANCE_SCHEMA,
  rawObservationFingerprint, rawTextFingerprint, rawMetadataFingerprint,
  buildProvenance, verifyProvenance5K1,
} from './public-intelligence/provenance.mjs';
import {
  PUBLIC_INTELLIGENCE_5K1_DEDUP, PUBLIC_INTELLIGENCE_5K1_DEDUP_OUTCOMES,
  dedupIdentity5K1, decideDedup, isSameUpstreamObservation5K1, dedupAudit,
} from './public-intelligence/dedup.mjs';
import {
  PUBLIC_INTELLIGENCE_5K1_ASSOCIATION_STATUS, PUBLIC_INTELLIGENCE_5K1_ASSOCIATION_METHODS,
  PUBLIC_INTELLIGENCE_5K1_NORMALIZED_SCHEMA, PUBLIC_INTELLIGENCE_5K1_SCOPE,
  normalizeObservation5K1, normalizedFingerprint5K1, resolveAssetAssociation,
  resolveMissingness, resolveEngagement, isAvailableAt5K1, selectAvailableAt5K1,
} from './public-intelligence/normalize.mjs';
import {
  PUBLIC_INTELLIGENCE_5K1_STORAGE, PUBLIC_INTELLIGENCE_5K1_FORBIDDEN_WRITE_ROOTS,
  PUBLIC_INTELLIGENCE_5K1_RECORD_ENVELOPE, createMemoryStore, createNdjsonStore,
  assertSafeStoreDirectory,
} from './public-intelligence/store.mjs';
import {
  PUBLIC_INTELLIGENCE_5K1_INGEST, PUBLIC_INTELLIGENCE_5K1_INGEST_OUTCOMES,
  ingestPublicObservation,
} from './public-intelligence/ingest.mjs';
import * as FIXTURES from './public-intelligence/fixtures.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R4_HEAD = '1c30264fb87876eeaf229e25c5cdc5adca429b40';
const MODULES_5K1 = [
  'scripts/public-intelligence/observation.mjs',
  'scripts/public-intelligence/provenance.mjs',
  'scripts/public-intelligence/normalize.mjs',
  'scripts/public-intelligence/dedup.mjs',
  'scripts/public-intelligence/store.mjs',
  'scripts/public-intelligence/ingest.mjs',
  'scripts/public-intelligence/fixtures.mjs',
];

const require = createRequire(import.meta.url);
const espree = require('espree');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const {
  exactMintProviderAPost, exactMintProviderADuplicate, exactMintProviderARepost,
  exactMintProviderBSameText, symbolOnlyPost, nameOnlyPost, ambiguousMultipleMintsPost,
  invalidMintPost, lowercaseMintPost, missingPublishedAtPost, independentTimestampsPost,
  malformedTimestampPost, fractionalTimestampPost, fetchBeforeObservedPost,
  unknownSchemaFieldPost, unknownMetadataFieldPost, forbiddenFieldPost, mutatedRawEvidencePost,
  rawFixture, FIXTURE_MINT_EXACT, FIXTURE_MINT_SECOND, FIXTURE_MINT_LOWERCASE,
  FIXTURE_PROVIDER_A, FIXTURE_PROVIDER_B, FIXTURE_AT_FETCHED,
} = FIXTURES;

/** Asserts the callable throws, optionally matching a code fragment. */
function assertRefused(fn, fragment, label) {
  let thrown = null;
  try { fn(); } catch (error) { thrown = error; }
  assert.ok(thrown, `${label}: expected a refusal, got none`);
  if (fragment) {
    assert.ok(String(thrown.message).includes(fragment),
      `${label}: expected refusal containing "${fragment}", got "${thrown.message}"`);
  }
  return thrown;
}

const temporary = [];
function tempRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'evolve-5k1-'));
  temporary.push(root);
  return root;
}


// ---------------------------------------------------------------------------
// AST HELPERS (capability and import audits use a parse tree, not regex)
// ---------------------------------------------------------------------------

function parseModule(relative) {
  const source = readFileSync(path.join(REPO_ROOT, relative), 'utf8');
  const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const found = { identifiers: [], stringLiterals: [], importSources: [], dynamicImports: [], memberObjects: [] };
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === 'Identifier') found.identifiers.push(node.name);
    if (node.type === 'Literal' && typeof node.value === 'string') found.stringLiterals.push(node.value);
    if (node.type === 'ImportDeclaration' && node.source?.value) found.importSources.push(node.source.value);
    if (node.type === 'ImportExpression' && node.source?.value) found.dynamicImports.push(node.source.value);
    if (node.type === 'MemberExpression' && node.object?.type === 'Identifier') found.memberObjects.push(node.object.name);
    for (const value of Object.values(node)) if (value && typeof value === 'object') walk(value);
  };
  walk(ast);
  return { source, found };
}

/** The transitive static import closure of a module, repo-relative. */
function importClosure(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    if (!existsSafe(path.join(REPO_ROOT, current))) continue;
    seen.add(current);
    const { found } = parseModule(current);
    for (const source of [...found.importSources, ...found.dynamicImports]) {
      if (!source.startsWith('.')) continue;
      queue.push(path.normalize(path.join(path.dirname(current), source)));
    }
  }
  return [...seen].sort();
}

function existsSafe(candidate) {
  try { return statSync(candidate).isFile(); } catch { return false; }
}

/** The full 5K.1 module surface, closure included. */
const closure5K1 = [...new Set(MODULES_5K1.flatMap(importClosure))].sort();

// ===========================================================================
// A. CLASSIFICATION - 5K.0 governance is frozen and unchanged by 5K.1
// ===========================================================================

test('A1 5K.1 records remain researchOnly', () => {
  assert.equal(PUBLIC_INTELLIGENCE_CLASSIFICATION.researchOnly, true);
  const result = ingestPublicObservation(exactMintProviderAPost());
  assert.equal(result.classification.researchOnly, true);
  assert.equal(result.classification.paperOnly, true);
  assert.equal(result.classification.developmentOnly, true);
});

test('A2 5K.1 records remain observerOnly', () => {
  assert.equal(PUBLIC_INTELLIGENCE_CLASSIFICATION.observerOnly, true);
  assert.equal(ingestPublicObservation(exactMintProviderAPost()).classification.observerOnly, true);
});

test('A3 5K.1 records hold no trading authority', () => {
  assert.equal(PUBLIC_INTELLIGENCE_CLASSIFICATION.tradingAuthority, false);
  assert.equal(ingestPublicObservation(exactMintProviderAPost()).classification.tradingAuthority, false);
  assert.equal(transactionSubmissionProhibited(), true);
});

test('A4 5K.1 records hold no engine authority', () => {
  assert.equal(PUBLIC_INTELLIGENCE_CLASSIFICATION.engineAuthority, false);
  assert.equal(PUBLIC_INTELLIGENCE_5K1_SCOPE.engineAuthority, false);
  assert.equal(ingestPublicObservation(exactMintProviderAPost()).classification.engineAuthority, false);
});

test('A5 5K.1 records are not Arena eligible', () => {
  assert.equal(PUBLIC_INTELLIGENCE_CLASSIFICATION.arenaEligible, false);
  assert.equal(ingestPublicObservation(exactMintProviderAPost()).classification.arenaEligible, false);
});

test('A6 5K.1 records are not promotion eligible', () => {
  assert.equal(PUBLIC_INTELLIGENCE_CLASSIFICATION.promotionEligible, false);
  assert.equal(PUBLIC_INTELLIGENCE_5K1_SCOPE.affectsPromotion, false);
  assert.equal(ingestPublicObservation(exactMintProviderAPost()).classification.promotionEligible, false);
});

test('A7 5K.1 permits no profitability inference', () => {
  assert.equal(PUBLIC_INTELLIGENCE_CLASSIFICATION.profitabilityInferencePermitted, false);
  assert.equal(ingestPublicObservation(exactMintProviderAPost()).classification.profitabilityInferencePermitted, false);
});

// @@CHUNK2@@
test('A8 every always-true and always-false flag holds across a full ingest run', () => {
  const store = createMemoryStore();
  for (const fixture of [exactMintProviderAPost, symbolOnlyPost, nameOnlyPost, invalidMintPost]) {
    const normalized = normalizeObservation5K1(canonicalizeRawObservation(fixture()));
    for (const flag of PUBLIC_INTELLIGENCE_ALWAYS_TRUE_FLAGS) {
      assert.equal(normalized.classification[flag], true, `${flag} must be true`);
    }
    for (const flag of PUBLIC_INTELLIGENCE_ALWAYS_FALSE_FLAGS) {
      assert.equal(normalized.classification[flag], false, `${flag} must be false`);
    }
    ingestPublicObservation(fixture(), { store });
  }
  assert.equal(store.count(), 4);
});

test('A9 5K.1 scope declares no network, no provider, no engine, no arena', () => {
  assert.equal(PUBLIC_INTELLIGENCE_5K1_SCOPE.ingestionAndProvenanceOnly, true);
  assert.equal(PUBLIC_INTELLIGENCE_5K1_SCOPE.contactsNoProvider, true);
  assert.equal(PUBLIC_INTELLIGENCE_5K1_SCOPE.opensNoSocket, true);
  assert.equal(PUBLIC_INTELLIGENCE_5K1_SCOPE.networkAccessPermitted, false);
  assert.equal(PUBLIC_INTELLIGENCE_5K1_SCOPE.holdsNoCredential, true);
  assert.equal(PUBLIC_INTELLIGENCE_5K1_SCOPE.readsNoEnvironment, true);
  assert.equal(PUBLIC_INTELLIGENCE_5K1_SCOPE.providerAdapterImplemented, false);
  assert.equal(PUBLIC_INTELLIGENCE_5K1_SCOPE.affectsFitness, false);
  assert.equal(PUBLIC_INTELLIGENCE_5K1_SCOPE.affectsChampionSelection, false);
  assert.equal(PUBLIC_INTELLIGENCE_5K1_SCOPE.createsDeploymentGate, false);
  assert.equal(PUBLIC_INTELLIGENCE_5K1_SCOPE.touchesR4Seal, false);
});

test('A10 5K.1 declares no sentiment, no LLM interpretation and no trading signal', () => {
  assert.equal(PUBLIC_INTELLIGENCE_5K1_NORMALIZED_SCHEMA.sentimentImplemented, false);
  assert.equal(PUBLIC_INTELLIGENCE_5K1_NORMALIZED_SCHEMA.llmInterpretationImplemented, false);
  assert.equal(PUBLIC_INTELLIGENCE_5K1_NORMALIZED_SCHEMA.tradingSignalImplemented, false);
  assert.equal(PUBLIC_INTELLIGENCE_5K1_NORMALIZED_SCHEMA.fuzzyAssociationPermitted, false);
  assert.equal(PUBLIC_INTELLIGENCE_5K1_NORMALIZED_SCHEMA.fabricatesMint, false);
  assert.equal(PUBLIC_INTELLIGENCE_5K1_NORMALIZED_SCHEMA.mutatesRawEvidence, false);
  assert.equal(PUBLIC_INTELLIGENCE_NON_CANONICAL_IDENTITY_REJECTS_SYMBOL(), true);
  assert.equal(PUBLIC_INTELLIGENCE_MISSINGNESS_RULE_ZERO_NEVER_MISSING(), true);
});

// @@CHUNK2B@@

// ===========================================================================
// B. EXACT MINT ASSOCIATION
// ===========================================================================

test('B1 an exact valid base58 mint is accepted and bound', () => {
  const raw = canonicalizeRawObservation(exactMintProviderAPost());
  assert.equal(exactClaimedMint(raw), FIXTURE_MINT_EXACT);
  const association = resolveAssetAssociation(raw);
  assert.equal(association.status, PUBLIC_INTELLIGENCE_5K1_ASSOCIATION_STATUS.EXACT_MINT);
  assert.equal(association.mint, FIXTURE_MINT_EXACT);
  assert.equal(association.method, PUBLIC_INTELLIGENCE_5K1_ASSOCIATION_METHODS.EXACT_MINT_ADDRESS);
  assert.equal(association.evidence.reason, 'EXACT_BASE58_MINT_PRESENT_IN_EVIDENCE');
});

test('B2 a symbol-only post stays unassociated', () => {
  const raw = canonicalizeRawObservation(symbolOnlyPost());
  const association = resolveAssetAssociation(raw);
  assert.equal(association.status, PUBLIC_INTELLIGENCE_5K1_ASSOCIATION_STATUS.UNASSOCIATED);
  assert.equal(association.mint, null);
  assert.ok(association.evidence.refusedIdentitySignals.includes('SYMBOL_ONLY'),
    'the symbol must be recorded as a refused signal');
  assert.equal(association.evidence.reason, 'NO_EXACT_MINT_IN_EVIDENCE');
});

test('B3 a name-only post stays unassociated', () => {
  const raw = canonicalizeRawObservation(nameOnlyPost());
  const association = resolveAssetAssociation(raw);
  assert.equal(association.status, PUBLIC_INTELLIGENCE_5K1_ASSOCIATION_STATUS.UNASSOCIATED);
  assert.equal(association.mint, null);
  assert.ok(association.evidence.refusedIdentitySignals.includes('TOKEN_NAME_ONLY'));
  assert.ok(association.evidence.refusedIdentitySignals.includes('PROFILE_NAME_SIMILARITY'));
});

test('B4 fuzzy and similarity matching are structurally impossible', () => {
  // Every non-canonical identity signal 5K.0 prohibits is inert here: an
  // observation carrying all of them at once still binds nothing.
  const raw = canonicalizeRawObservation(rawFixture({
    providerObservationId: 'alpha-0200',
    claimedMint: null,
    rawText: '$FUZZY #FUZZY @handle token-name resemblance edit-distance near-match',
    rawMetadata: {
      language: 'en',
      claimedSymbol: 'FUZZY',
      claimedTokenName: 'Fuzzy Token',
      cashtags: ['$FUZZY'],
      hashtags: ['#FUZZY'],
      mentionedHandles: ['@handle'],
      candidateMintAddresses: [],
      similaritySignals: [
        'SYMBOL_ONLY', 'TOKEN_NAME_ONLY', 'TICKER_GUESS', 'FUZZY_TOKEN_MATCH',
        'FUZZY_MATCH', 'PREFIX_MATCH', 'EDIT_DISTANCE_MATCH',
        'EMBEDDING_SIMILARITY', 'PROFILE_NAME_SIMILARITY',
        'NATURAL_LANGUAGE_SIMILARITY', 'HEURISTIC_INFERENCE', 'MANUAL_GUESS',
      ],
      engagement: null,
      fixtureNote: 'every refused signal at once',
    },
  }));
  const association = resolveAssetAssociation(raw);
  assert.equal(association.status, PUBLIC_INTELLIGENCE_5K1_ASSOCIATION_STATUS.UNASSOCIATED);
  assert.equal(association.mint, null);
  assert.equal(association.evidence.exactCandidateCount, 0);
  // Every prohibited signal appears in the refusal ledger, and none bound a mint.
  for (const signal of PUBLIC_INTELLIGENCE_5K1_REJECTED_IDENTITY_SIGNALS) {
    assert.ok(association.evidence.refusedIdentitySignals.includes(signal), signal);
  }
});

test('B5 an invalid claimed mint is marked invalid and binds nothing', () => {
  const raw = canonicalizeRawObservation(invalidMintPost());
  const association = resolveAssetAssociation(raw);
  assert.equal(association.status, PUBLIC_INTELLIGENCE_5K1_ASSOCIATION_STATUS.INVALID_MINT);
  assert.equal(association.mint, null);
  assert.equal(association.method, PUBLIC_INTELLIGENCE_5K1_ASSOCIATION_METHODS.UNASSOCIATED);
  assert.equal(association.evidence.claimedMintIsExactBase58, false);
  assert.equal(association.evidence.reason, 'CLAIMED_MINT_NOT_EXACT_BASE58');
});

test('B6 no mint is ever fabricated, normalized or interpolated', () => {
  // Across every fixture, a non-EXACT_MINT status must carry a null mint, and
  // an EXACT_MINT status must carry a string that exists verbatim in evidence.
  const fixtures = [exactMintProviderAPost, symbolOnlyPost, nameOnlyPost,
    ambiguousMultipleMintsPost, invalidMintPost, lowercaseMintPost, missingPublishedAtPost];
  for (const fixture of fixtures) {
    const raw = canonicalizeRawObservation(fixture());
    const association = resolveAssetAssociation(raw);
    if (association.status === PUBLIC_INTELLIGENCE_5K1_ASSOCIATION_STATUS.EXACT_MINT) {
      assert.equal(canonicalMintAddress(association.mint), association.mint);
      assert.equal(association.mint, claimedMintOf(raw), 'mint must be the exact claimed string');
    } else {
      assert.equal(association.mint, null, `${association.status} must carry a null mint`);
    }
  }
  // Two distinct exact mints in one observation stay ambiguous; nothing is picked.
  const ambiguous = resolveAssetAssociation(canonicalizeRawObservation(ambiguousMultipleMintsPost()));
  assert.equal(ambiguous.status, PUBLIC_INTELLIGENCE_5K1_ASSOCIATION_STATUS.AMBIGUOUS);
  assert.equal(ambiguous.mint, null);
  assert.equal(ambiguous.evidence.exactCandidateCount, 2);
  assert.equal(ambiguous.evidence.reason, 'MULTIPLE_EXACT_CANDIDATES_NO_FORCE_MATCH');
});

test('B7 mint identity is case-sensitive and never case-folded', () => {
  const raw = canonicalizeRawObservation(lowercaseMintPost());
  assert.equal(exactClaimedMint(raw), FIXTURE_MINT_LOWERCASE);
  // The lowercase string is its own identity and is NOT the uppercase address.
  assert.notEqual(canonicalMintAddress(FIXTURE_MINT_LOWERCASE), FIXTURE_MINT_EXACT);
  assert.equal(canonicalMintAddress(FIXTURE_MINT_LOWERCASE), FIXTURE_MINT_LOWERCASE);
});

// @@CHUNK3@@

// ===========================================================================
// C. RAW EVIDENCE INTEGRITY
// ===========================================================================

test('C1 raw text is preserved character-for-character through the whole pipeline', () => {
  const tricky = 'line one\n  indented\ttab\n\ntrailing spaces   \nemoji \u{1F680} and $CASHTAG\n';
  const input = rawFixture({ providerObservationId: 'alpha-0300', rawText: tricky });
  const canonical = canonicalizeRawObservation(input);
  assert.equal(canonical.rawText, tricky, 'canonicalization must not alter rawText');
  assert.equal(canonical.rawText.length, tricky.length);
  const normalized = normalizeObservation5K1(canonical);
  assert.equal(normalized.raw.rawText, tricky, 'the normalized record carries raw evidence verbatim');
  // Canonical text differs only by CRLF normalization, which this input lacks.
  assert.equal(normalized.canonicalText, tricky);
  const stored = createMemoryStore();
  ingestPublicObservation(input, { store: stored });
  assert.equal(stored.list()[0].raw.rawText, tricky, 'storage preserves raw evidence exactly');
});

test('C2 raw metadata is preserved and deep-frozen after ingestion', () => {
  const input = rawFixture({ providerObservationId: 'alpha-0301' });
  const canonical = canonicalizeRawObservation(input);
  assert.equal(rawEvidenceEquals(canonical.rawMetadata, input.rawMetadata), true);
  assert.equal(Object.isFrozen(canonical), true);
  assert.equal(Object.isFrozen(canonical.rawMetadata), true);
  assert.equal(Object.isFrozen(canonical.rawMetadata.engagement), true);
  assert.equal(Object.isFrozen(canonical.collectionContext), true);
  assert.throws(() => { 'use strict'; canonical.rawMetadata.language = 'mutated'; });
  assert.throws(() => { 'use strict'; canonical.rawText = 'mutated'; });
  assert.equal(canonical.rawMetadata.language, 'en');
  assert.equal(canonical.rawText, input.rawText);
});

test('C3 normalization provably does not mutate raw evidence', () => {
  for (const fixture of [exactMintProviderAPost, symbolOnlyPost, nameOnlyPost,
    invalidMintPost, ambiguousMultipleMintsPost, missingPublishedAtPost]) {
    const canonical = canonicalizeRawObservation(fixture());
    const before = rawObservationFingerprint(canonical);
    const snapshot = JSON.stringify(canonical);
    normalizeObservation5K1(canonical);
    assert.equal(rawObservationFingerprint(canonical), before, 'fingerprint changed: raw was mutated');
    assert.equal(JSON.stringify(canonical), snapshot, 'raw object changed during normalization');
  }
});

test('C4 the raw fingerprint changes whenever raw evidence changes', () => {
  const base = canonicalizeRawObservation(exactMintProviderAPost());
  const baseline = rawObservationFingerprint(base);
  // Mutating any evidence field - by a single character - must change identity.
  const mutations = [
    ['rawText', { rawText: `${base.rawText} ` }],
    ['rawMetadata', { rawMetadata: { ...base.rawMetadata, language: 'fr' } }],
    ['claimedMint', { claimedMint: FIXTURE_MINT_SECOND }],
    ['provider', { provider: FIXTURE_PROVIDER_B }],
    ['providerObservationId', { providerObservationId: 'alpha-9999' }],
    ['fetchedAt', { fetchedAt: base.fetchedAt + 1 }],
    ['sourceUrl', { sourceUrl: 'https://fixture.invalid/alpha/changed' }],
  ];
  for (const [label, override] of mutations) {
    const mutated = canonicalizeRawObservation({ ...exactMintProviderAPost(), ...override });
    assert.notEqual(rawObservationFingerprint(mutated), baseline, `${label} must change the fingerprint`);
  }
});

test('C5 unknown raw fields are rejected, at the top level and inside metadata', () => {
  assertRefused(() => canonicalizeRawObservation(unknownSchemaFieldPost()),
    'PUBLIC_INTELLIGENCE_UNKNOWN_FIELD:sentimentScore', 'unknown top-level field');
  assertRefused(() => canonicalizeRawObservation(unknownMetadataFieldPost()),
    'PUBLIC_INTELLIGENCE_5K1_RAW_METADATA_UNKNOWN_FIELD', 'unknown metadata field');
  // Both schemas are declared closed, and the declarations say so.
  assert.equal(PUBLIC_INTELLIGENCE_5K1_RAW_SCHEMA.closed, true);
  assert.equal(PUBLIC_INTELLIGENCE_5K1_RAW_METADATA_SCHEMA.closed, true);
  assert.equal(PUBLIC_INTELLIGENCE_5K1_COLLECTION_CONTEXT_SCHEMA.closed, true);
});

// @@CHUNK3B@@

test('C6 privacy-breaching fields are refused even when nested in raw metadata', () => {
  assertRefused(() => canonicalizeRawObservation(forbiddenFieldPost()),
    'PUBLIC_INTELLIGENCE_5K1_FORBIDDEN_FIELD_PRESENT:accessToken', 'accessToken in metadata');
  // Every declared forbidden field is refused, not just the one exercised above.
  const forbidden = PUBLIC_INTELLIGENCE_5K1_RAW_SCHEMA.forbiddenFields;
  assert.ok(forbidden.includes('privateMessage'));
  assert.ok(forbidden.includes('sessionCookie'));
  assert.ok(forbidden.includes('privateKey'));
  for (const field of forbidden) {
    assertRefused(
      () => canonicalizeRawObservation(rawFixture({
        providerObservationId: 'alpha-0400',
        rawMetadata: { language: 'en', engagement: null, fixtureNote: 'probe', [field]: 'probe' },
      })),
      `PUBLIC_INTELLIGENCE_5K1_FORBIDDEN_FIELD_PRESENT:${field}`,
      `forbidden field ${field}`,
    );
  }
});

test('C7 non-representable raw values are refused rather than coerced', () => {
  assertRefused(() => canonicalizeRawObservation(rawFixture({
    providerObservationId: 'alpha-0500',
    rawMetadata: { language: 'en', engagement: null, fixtureNote: Number.POSITIVE_INFINITY },
  })), 'PUBLIC_INTELLIGENCE_5K1_NON_FINITE_NUMBER', 'Infinity in metadata');
  assertRefused(() => canonicalizeRawObservation(rawFixture({
    providerObservationId: 'alpha-0501',
    rawMetadata: { language: 'en', engagement: null, fixtureNote: undefined },
  })), 'PUBLIC_INTELLIGENCE_5K1_UNDEFINED_VALUE', 'undefined in metadata');
  // Negative engagement is not a plausible public count and is refused.
  assertRefused(() => canonicalizeRawObservation(rawFixture({
    providerObservationId: 'alpha-0502',
    rawMetadata: { language: 'en', engagement: { likes: -1 }, fixtureNote: 'negative' },
  })), 'PUBLIC_INTELLIGENCE_5K1_ENGAGEMENT_NEGATIVE', 'negative engagement');
});

test('C8 source type and collector mode are closed vocabularies', () => {
  // 5K.1 has no live provider: the collector mode is pinned to OFFLINE_FIXTURE,
  // so a live adapter cannot appear behind an unchanged schema version.
  assert.deepEqual([...PUBLIC_INTELLIGENCE_5K1_COLLECTOR_MODES], ['OFFLINE_FIXTURE']);
  for (const sourceType of PUBLIC_INTELLIGENCE_5K1_SOURCE_TYPES) {
    const raw = canonicalizeRawObservation(rawFixture({
      sourceType, providerObservationId: `alpha-src-${sourceType}` }));
    assert.equal(raw.sourceType, sourceType);
  }
  // An undeclared source type or collector mode is refused, never defaulted.
  assertRefused(() => canonicalizeRawObservation(rawFixture({
    providerObservationId: 'alpha-0800', sourceType: 'DIRECT_MESSAGE',
  })), 'PUBLIC_INTELLIGENCE_5K1_SOURCE_TYPE_INVALID', 'private-message source type');
  assertRefused(() => canonicalizeRawObservation(rawFixture({
    providerObservationId: 'alpha-0801',
    collectionContext: { ...rawFixture().collectionContext, collectorMode: 'LIVE_API' },
  })), 'PUBLIC_INTELLIGENCE_5K1_COLLECTOR_MODE_INVALID', 'live collector mode');
  // The collection context is itself a closed schema.
  assertRefused(() => canonicalizeRawObservation(rawFixture({
    providerObservationId: 'alpha-0802',
    collectionContext: { ...rawFixture().collectionContext, apiToken: 'probe' },
  })), 'PUBLIC_INTELLIGENCE_5K1_COLLECTION_CONTEXT', 'unknown collection-context field');
});

// ===========================================================================
// D. PROVENANCE
// ===========================================================================

test('D1 fingerprints are deterministic and reproducible', () => {
  const first = rawObservationFingerprint(canonicalizeRawObservation(exactMintProviderAPost()));
  const second = rawObservationFingerprint(canonicalizeRawObservation(exactMintProviderAPost()));
  assert.equal(first, second, 'the same evidence must always fingerprint identically');
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, digest(JSON.parse(JSON.stringify(
    canonicalizeRawObservation(exactMintProviderAPost())))), 'canonical JSON + SHA-256, as declared');
});

test('D2 provenance is anchored to raw evidence, not to normalized content', () => {
  const raw = canonicalizeRawObservation(exactMintProviderAPost());
  const provenance = buildProvenance(raw);
  assert.equal(provenance.rawObservationFingerprint, rawObservationFingerprint(raw));
  assert.equal(provenance.rawTextFingerprint, rawTextFingerprint(raw));
  assert.equal(provenance.rawMetadataFingerprint, rawMetadataFingerprint(raw));
  assert.equal(PUBLIC_INTELLIGENCE_5K1_FINGERPRINTING.anchoredToRawEvidence, true);
  assert.equal(PUBLIC_INTELLIGENCE_5K1_FINGERPRINTING.hashesNormalizedContentOnly, false);
  // A single space in rawText moves the raw fingerprint and the text fingerprint.
  const nudged = canonicalizeRawObservation({ ...exactMintProviderAPost(), rawText: `${raw.rawText} ` });
  assert.notEqual(rawTextFingerprint(nudged), provenance.rawTextFingerprint);
  assert.notEqual(rawObservationFingerprint(nudged), provenance.rawObservationFingerprint);
});

test('D3 provider, observation id and fetch instant all participate in provenance', () => {
  const base = canonicalizeRawObservation(exactMintProviderAPost());
  const baseline = rawObservationFingerprint(base);
  assert.notEqual(rawObservationFingerprint(canonicalizeRawObservation({
    ...exactMintProviderAPost(), provider: FIXTURE_PROVIDER_B })), baseline, 'provider must participate');
  assert.notEqual(rawObservationFingerprint(canonicalizeRawObservation({
    ...exactMintProviderAPost(), providerObservationId: 'alpha-0002' })), baseline, 'observation id must participate');
  assert.notEqual(rawObservationFingerprint(canonicalizeRawObservation({
    ...exactMintProviderAPost(), fetchedAt: base.fetchedAt + 1 })), baseline, 'fetchedAt must participate');
  assert.equal(PUBLIC_INTELLIGENCE_5K1_FINGERPRINTING.providerParticipates, true);
  assert.equal(PUBLIC_INTELLIGENCE_5K1_FINGERPRINTING.providerObservationIdParticipates, true);
  assert.equal(PUBLIC_INTELLIGENCE_5K1_FINGERPRINTING.fetchedAtParticipates, true);
  assert.equal(PUBLIC_INTELLIGENCE_5K1_FINGERPRINTING.excludesMutableRuntimeFields, true);
});

test('D4 provenance round-trips: it verifies against exactly the raw it claims', () => {
  const raw = canonicalizeRawObservation(exactMintProviderAPost());
  const provenance = buildProvenance(raw);
  assert.equal(verifyProvenance5K1(provenance, raw), true);
  // Provenance describes source identity, and nothing more.
  for (const field of PUBLIC_INTELLIGENCE_5K1_PROVENANCE_SCHEMA.fields) {
    assert.ok(provenance[field] !== undefined, `provenance must carry ${field}`);
  }
  assert.equal(provenance.provider, FIXTURE_PROVIDER_A);
  assert.equal(provenance.providerObservationId, 'alpha-0001');
  assert.equal(provenance.fetchedAt, FIXTURE_AT_FETCHED);
  assert.equal(provenance.algorithm, 'SHA-256');
  assert.equal(provenance.serialization, 'EVOLVE_CANONICAL_JSON');
});

// @@CHUNK4@@

test('D5 provenance tamper fails closed, field by field', () => {
  const raw = canonicalizeRawObservation(exactMintProviderAPost());
  const provenance = buildProvenance(raw);
  const tampers = [
    ['provider', { provider: FIXTURE_PROVIDER_B }],
    ['providerObservationId', { providerObservationId: 'alpha-6666' }],
    ['fetchedAt', { fetchedAt: provenance.fetchedAt + 1 }],
    ['publishedAt', { publishedAt: provenance.publishedAt + 1 }],
    ['sourceUrl', { sourceUrl: 'https://fixture.invalid/forged' }],
    ['rawObservationFingerprint', { rawObservationFingerprint: 'f'.repeat(64) }],
    ['rawTextFingerprint', { rawTextFingerprint: 'e'.repeat(64) }],
    ['rawMetadataFingerprint', { rawMetadataFingerprint: 'd'.repeat(64) }],
    ['collectionContext', { collectionContext: { ...provenance.collectionContext, adapterName: 'forged' } }],
  ];
  for (const [field, override] of tampers) {
    assertRefused(() => verifyProvenance5K1({ ...provenance, ...override }, raw),
      `PUBLIC_INTELLIGENCE_5K1_PROVENANCE_MISMATCH:${field}`, `tampered ${field}`);
  }
  // The declared algorithm and serialization are pinned, not merely recorded.
  assertRefused(() => verifyProvenance5K1({ ...provenance, algorithm: 'MD5' }, raw),
    'PUBLIC_INTELLIGENCE_5K1_PROVENANCE_ALGORITHM_MISMATCH', 'tampered algorithm');
  assertRefused(() => verifyProvenance5K1({ ...provenance, serialization: 'JSON.stringify' }, raw),
    'PUBLIC_INTELLIGENCE_5K1_PROVENANCE_SERIALIZATION_MISMATCH', 'tampered serialization');
  // A provenance record cannot smuggle in an extra field either.
  assertRefused(() => verifyProvenance5K1({ ...provenance, sentimentScore: 1 }, raw),
    'PUBLIC_INTELLIGENCE_5K1_PROVENANCE_UNKNOWN_FIELD', 'extra provenance field');
});

test('D6 provenance verification fails against the wrong raw evidence', () => {
  const raw = canonicalizeRawObservation(exactMintProviderAPost());
  const provenance = buildProvenance(raw);
  // Verifying real provenance against someone else's raw evidence must fail.
  const other = canonicalizeRawObservation(exactMintProviderARepost());
  assertRefused(() => verifyProvenance5K1(provenance, other),
    'PUBLIC_INTELLIGENCE_5K1_PROVENANCE_MISMATCH', 'provenance bound to foreign raw evidence');
  assertRefused(() => verifyProvenance5K1(null, raw),
    'PUBLIC_INTELLIGENCE_5K1_PROVENANCE_MISSING', 'missing provenance');
  // Mutated evidence under an identical identity is refused by the pipeline.
  const store = createMemoryStore();
  ingestPublicObservation(exactMintProviderAPost(), { store });
  assertRefused(() => ingestPublicObservation(mutatedRawEvidencePost(), { store }),
    'PUBLIC_INTELLIGENCE_5K1_INGEST_CONFLICT_REFUSED', 'mutated raw evidence under a used identity');
});

// ===========================================================================
// E. DEDUPLICATION
// ===========================================================================

test('E1 same provider plus same observation id deduplicates', () => {
  const store = createMemoryStore();
  const first = ingestPublicObservation(exactMintProviderAPost(), { store });
  const second = ingestPublicObservation(exactMintProviderADuplicate(), { store });
  assert.equal(first.outcome, PUBLIC_INTELLIGENCE_5K1_INGEST_OUTCOMES.INGESTED);
  assert.equal(second.outcome, PUBLIC_INTELLIGENCE_5K1_INGEST_OUTCOMES.ALREADY_PRESENT);
  assert.equal(second.stored, false, 'a duplicate must not be stored twice');
  assert.equal(first.dedupIdentity, second.dedupIdentity);
  assert.equal(store.count(), 1);
  assert.equal(second.rawObservationFingerprint, first.rawObservationFingerprint);
});

test('E2 same provider plus a different observation id never silently collapses', () => {
  const store = createMemoryStore();
  const first = ingestPublicObservation(exactMintProviderAPost(), { store });
  const repost = ingestPublicObservation(exactMintProviderARepost(), { store });
  assert.equal(repost.outcome, PUBLIC_INTELLIGENCE_5K1_INGEST_OUTCOMES.INGESTED);
  assert.notEqual(repost.dedupIdentity, first.dedupIdentity, 'a repost is a distinct upstream item');
  assert.equal(store.count(), 2);
  // The text really is byte-identical, which is exactly why it must not matter.
  assert.equal(exactMintProviderAPost().rawText, exactMintProviderARepost().rawText);
  assert.equal(PUBLIC_INTELLIGENCE_5K1_DEDUP.sameProviderDifferentObservationIdStaysDistinct, true);
});

test('E3 different providers never collapse, even for byte-identical text', () => {
  const store = createMemoryStore();
  const a = ingestPublicObservation(exactMintProviderAPost(), { store });
  const b = ingestPublicObservation(exactMintProviderBSameText(), { store });
  assert.equal(a.rawText, b.rawText, 'the two providers really do carry identical text');
  assert.equal(rawTextFingerprint(canonicalizeRawObservation(exactMintProviderAPost())),
    rawTextFingerprint(canonicalizeRawObservation(exactMintProviderBSameText())),
    'identical text fingerprints identically, and is still not an identity');
  assert.notEqual(a.dedupIdentity, b.dedupIdentity, 'provider-scoped identities must differ');
  assert.equal(b.outcome, PUBLIC_INTELLIGENCE_5K1_INGEST_OUTCOMES.INGESTED);
  assert.equal(store.count(), 2);
  assert.deepEqual(store.providers(), [FIXTURE_PROVIDER_A, FIXTURE_PROVIDER_B]);
  assert.equal(PUBLIC_INTELLIGENCE_5K1_DEDUP.crossProviderCollapsePermitted, false);
  assert.equal(PUBLIC_INTELLIGENCE_5K1_DEDUP.sameTextDifferentProviderStaysDistinct, true);
});

// @@CHUNK5@@

test('E4 identical text alone is never sufficient to establish identity', () => {
  assert.equal(PUBLIC_INTELLIGENCE_5K1_DEDUP.textEqualityIsIdentity, false);
  assert.equal(PUBLIC_INTELLIGENCE_5K1_DEDUP.fallbackToTextDigest, false);
  assert.equal(PUBLIC_INTELLIGENCE_5K1_DEDUP.fallbackToUrl, false);
  assert.deepEqual(PUBLIC_INTELLIGENCE_5K1_DEDUP.identityFields, ['provider', 'providerObservationId']);
  // Six different upstream identities, all carrying the same text.
  const store = createMemoryStore();
  const inputs = [
    exactMintProviderAPost,
    exactMintProviderARepost,
    exactMintProviderBSameText,
    symbolOnlyPost,
    nameOnlyPost,
    missingPublishedAtPost,
  ];
  const identities = new Set();
  for (const fixture of inputs) {
    ingestPublicObservation(fixture(), { store });
    identities.add(dedupIdentity5K1(fixture()));
  }
  assert.equal(store.count(), inputs.length, 'no observation collapsed on text');
  assert.equal(identities.size, inputs.length, 'every upstream identity is distinct');
  // And the dedup audit confirms nothing was collapsed across providers.
  const audit = dedupAudit(store.list());
  assert.equal(audit.crossProviderCollapsePerformed, false);
  assert.equal(audit.duplicateGroups, 0);
  assert.equal(audit.distinctUpstreamIdentities, inputs.length);
});

test('E5 repeated ingestion is idempotent and never mutates a stored record', () => {
  const store = createMemoryStore();
  const first = ingestPublicObservation(exactMintProviderAPost(), { store });
  const storedSnapshot = JSON.stringify(store.list()[0]);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const again = ingestPublicObservation(exactMintProviderAPost(), { store });
    assert.equal(again.outcome, PUBLIC_INTELLIGENCE_5K1_INGEST_OUTCOMES.ALREADY_PRESENT);
    assert.equal(again.stored, false);
    assert.equal(again.dedupIdentity, first.dedupIdentity);
    assert.equal(again.rawObservationFingerprint, first.rawObservationFingerprint);
  }
  assert.equal(store.count(), 1, 'five re-ingestions must not create five records');
  assert.equal(JSON.stringify(store.list()[0]), storedSnapshot, 'the stored record is unchanged');
  // The decision function agrees with the pipeline.
  const decision = decideDedup(normalizeObservation5K1(canonicalizeRawObservation(exactMintProviderAPost())), store.list()[0].normalized);
  assert.equal(decision.outcome, PUBLIC_INTELLIGENCE_5K1_DEDUP_OUTCOMES.DUPLICATE);
  assert.equal(decision.conflicting, false);
});

test('E6 a mutated upstream identity is refused, never overwritten', () => {
  const store = createMemoryStore();
  ingestPublicObservation(exactMintProviderAPost(), { store });
  const before = JSON.stringify(store.list()[0]);
  assertRefused(() => ingestPublicObservation(mutatedRawEvidencePost(), { store }),
    'PUBLIC_INTELLIGENCE_5K1_INGEST_CONFLICT_REFUSED', 'mutated evidence');
  assert.equal(JSON.stringify(store.list()[0]), before, 'the original record survives untouched');
  assert.equal(store.count(), 1);
  assert.equal(PUBLIC_INTELLIGENCE_5K1_DEDUP.conflictsRatherThanOverwrites, true);
  // Two providers carrying the SAME observation id are distinct upstream items,
  // not a conflict and not a duplicate.
  const alpha = normalizeObservation5K1(canonicalizeRawObservation(exactMintProviderAPost()));
  const betaSameId = normalizeObservation5K1(canonicalizeRawObservation(rawFixture({
    provider: FIXTURE_PROVIDER_B,
    providerObservationId: 'alpha-0001',
  })));
  assert.equal(betaSameId.providerObservationId, alpha.providerObservationId);
  assert.notEqual(betaSameId.provider, alpha.provider);
  assert.notEqual(betaSameId.dedupIdentity, alpha.dedupIdentity);
  assert.equal(decideDedup(betaSameId, alpha).outcome, PUBLIC_INTELLIGENCE_5K1_DEDUP_OUTCOMES.INSERTED);
  assert.equal(decideDedup(betaSameId, alpha).reason, 'DIFFERENT_PROVIDER_NEVER_COLLAPSES');
  assert.equal(isSameUpstreamObservation5K1(alpha, betaSameId), false);
  assert.equal(isSameUpstreamObservation5K1(alpha, alpha), true);
  // Same provider, same id, different bytes: the genuine conflict case.
  const mutated = normalizeObservation5K1(canonicalizeRawObservation(mutatedRawEvidencePost()));
  assert.equal(decideDedup(mutated, alpha).outcome, PUBLIC_INTELLIGENCE_5K1_DEDUP_OUTCOMES.CONFLICT);
  assert.equal(decideDedup(mutated, alpha).conflicting, true);
});

// ===========================================================================
// F. TIMESTAMP DISCIPLINE
// ===========================================================================

test('F1 publishedAt, observedAt and fetchedAt remain three distinct clocks', () => {
  const raw = canonicalizeRawObservation(independentTimestampsPost());
  const normalized = normalizeObservation5K1(raw);
  assert.equal(normalized.publishedAt, 1799990000000);
  assert.equal(normalized.observedAt, 1799995000000);
  assert.equal(normalized.fetchedAt, 1800000000000);
  // Three distinct values: none was collapsed into, or derived from, another.
  assert.equal(new Set([normalized.publishedAt, normalized.observedAt, normalized.fetchedAt]).size, 3);
  assert.notEqual(normalized.publishedAt, normalized.fetchedAt);
  assert.notEqual(normalized.observedAt, normalized.fetchedAt);
  // Availability is the fetch instant: the only clock EVOLVE controls.
  assert.equal(normalized.availabilityAt, normalized.fetchedAt);
  for (const value of [normalized.publishedAt, normalized.observedAt, normalized.fetchedAt]) {
    assert.equal(isValidTimestamp(value), true);
  }
});

// @@CHUNK6@@

test('F2 a missing publishedAt stays missing and is never replaced by fetchedAt', () => {
  const raw = canonicalizeRawObservation(missingPublishedAtPost());
  assert.equal(raw.publishedAt, null);
  const normalized = normalizeObservation5K1(raw);
  assert.equal(normalized.publishedAt, null, 'publishedAt must remain null');
  assert.notEqual(normalized.publishedAt, normalized.fetchedAt);
  assert.equal(normalized.provenance.publishedAt, null, 'provenance carries the absence too');
  assert.equal(normalized.missingness.publishedAt, PUBLIC_INTELLIGENCE_MISSINGNESS.NOT_YET_PUBLISHED);
  assert.equal(normalized.missingness.publishedAt !== PUBLIC_INTELLIGENCE_MISSINGNESS.OBSERVED, true);
  // The normalized fingerprint of a missing-publishedAt record differs from the
  // same record with a synthesized one: the absence is itself evidence.
  const synthesized = canonicalizeRawObservation(rawFixture({
    providerObservationId: raw.providerObservationId,
    rawText: raw.rawText,
    publishedAt: raw.fetchedAt,
  }));
  assert.notEqual(normalizedFingerprint5K1(normalized), normalizedFingerprint5K1(normalizeObservation5K1(synthesized)));
});

test('F3 invalid and non-finite timestamps are refused, never coerced', () => {
  assertRefused(() => canonicalizeRawObservation(malformedTimestampPost()),
    'PUBLIC_INTELLIGENCE_TIMESTAMP_NOT_FINITE:observedAt', 'NaN observedAt');
  for (const bad of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assertRefused(() => canonicalizeRawObservation(rawFixture({
      providerObservationId: 'alpha-0600', fetchedAt: bad,
    })), 'PUBLIC_INTELLIGENCE_TIMESTAMP_NOT_FINITE:fetchedAt', `non-finite ${bad}`);
  }
  assertRefused(() => canonicalizeRawObservation(fractionalTimestampPost()),
    'PUBLIC_INTELLIGENCE_TIMESTAMP_NOT_INTEGER_MS:observedAt', 'fractional observedAt');
  assertRefused(() => canonicalizeRawObservation(rawFixture({
    providerObservationId: 'alpha-0601', fetchedAt: -1,
  })), 'PUBLIC_INTELLIGENCE_TIMESTAMP_NEGATIVE:fetchedAt', 'negative fetchedAt');
  assertRefused(() => canonicalizeRawObservation(rawFixture({
    providerObservationId: 'alpha-0602', publishedAt: '1800000000000',
  })), 'PUBLIC_INTELLIGENCE_TIMESTAMP_NOT_A_NUMBER:publishedAt', 'string publishedAt');
  // fetchedAt is mandatory: it is EVOLVE's own clock and is never defaulted.
  assertRefused(() => canonicalizeRawObservation(rawFixture({
    providerObservationId: 'alpha-0603', fetchedAt: null,
  })), 'PUBLIC_INTELLIGENCE_TIMESTAMP_REQUIRED:fetchedAt', 'absent fetchedAt');
});

test('F4 no pipeline stage substitutes an implicit Date.now() for canonical data', () => {
  // No 5K.1 module may read a clock. Proof is structural, over the AST.
  for (const relative of MODULES_5K1) {
    const { found } = parseModule(relative);
    for (const identifier of found.identifiers) {
      assert.ok(!['Date', 'performance', 'hrtime'].includes(identifier),
        `${relative} references a clock API: ${identifier}`);
    }
    for (const literal of found.stringLiterals) {
      assert.ok(!/Date\.now|new Date\(/.test(literal), `${relative} embeds a clock read: ${literal}`);
    }
  }
  // And the pipeline reads no environment either: it cannot source a clock.
  for (const relative of MODULES_5K1) {
    const { found } = parseModule(relative);
    for (const source of [...found.importSources, ...found.dynamicImports]) {
      assert.ok(!source.includes('node:process'), `${relative} imports ${source}`);
    }
    const { found: members } = parseModule(relative);
    assert.ok(!members.memberObjects.includes('process'), `${relative} touches process`);
  }
  assert.equal(PUBLIC_INTELLIGENCE_5K1_INGEST.readsClock, false);
  assert.equal(PUBLIC_INTELLIGENCE_5K1_INGEST.fetchedAtSuppliedByCaller, true);
});

test('F5 no look-ahead: evidence is admitted only at or before the reference instant', () => {
  // `older` was fetched before `newer`, so the availability ordering is
  // genuinely different from the fixture declaration order.
  const newer = normalizeObservation5K1(canonicalizeRawObservation(exactMintProviderAPost()));
  const older = normalizeObservation5K1(canonicalizeRawObservation(independentTimestampsPost()));
  assert.ok(older.fetchedAt < newer.fetchedAt, 'fixtures must straddle the reference instant');
  assert.equal(isAvailableAt5K1(newer, newer.fetchedAt), true, 'the boundary is inclusive');
  assert.equal(isAvailableAt5K1(older, older.fetchedAt), true, 'the boundary is inclusive');
  // Evaluating one millisecond before an item was fetched must exclude it.
  assert.equal(isAvailableAt5K1(newer, newer.fetchedAt - 1), false);
  assert.equal(isAvailableAt5K1(older, newer.fetchedAt), true);
  assert.deepEqual(selectAvailableAt5K1([newer, older], older.fetchedAt), [older]);
  assert.deepEqual(selectAvailableAt5K1([newer, older], newer.fetchedAt), [newer, older]);
  // A non-finite reference fails closed and admits nothing.
  assert.deepEqual(selectAvailableAt5K1([newer, older], Number.NaN), []);
  assert.equal(isAvailableAt5K1(newer, Number.NaN), false);
  assert.equal(isAvailableAt5K1(null, newer.fetchedAt), false);
  // Fetching before observing is refused outright.
  assertRefused(() => canonicalizeRawObservation(fetchBeforeObservedPost()),
    'PUBLIC_INTELLIGENCE_5K1_TIMESTAMP_FETCH_BEFORE_OBSERVED', 'fetch before observe');
});

// @@CHUNK7@@

// ===========================================================================
// G. MISSINGNESS
// ===========================================================================

test('G1 a missing author stays explicitly missing', () => {
  const raw = canonicalizeRawObservation(symbolOnlyPost());
  assert.equal(raw.providerAuthorId, null);
  const normalized = normalizeObservation5K1(raw);
  assert.equal(normalized.providerAuthorId, null);
  assert.equal(normalized.missingness.providerAuthorId, PUBLIC_INTELLIGENCE_MISSINGNESS.NO_OBSERVATION);
  assert.equal(normalized.normalizedAuthorIdentity.status, PUBLIC_INTELLIGENCE_MISSINGNESS.NO_OBSERVATION);
  assert.equal(normalized.normalizedAuthorIdentity.value, null);
  // A missing author is never enriched into a name, handle or identity.
  assert.equal(normalized.normalizedAuthorIdentity.enriched, false);
  assert.equal(normalized.normalizedAuthorIdentity.deanonymized, false);
  // An observed author is carried verbatim, without enrichment.
  const observed = normalizeObservation5K1(canonicalizeRawObservation(exactMintProviderAPost()));
  assert.equal(observed.missingness.providerAuthorId, PUBLIC_INTELLIGENCE_MISSINGNESS.OBSERVED);
  assert.equal(observed.normalizedAuthorIdentity.value, 'alpha-author-1');
});

test('G2 a missing source URL stays explicitly missing', () => {
  const normalized = normalizeObservation5K1(canonicalizeRawObservation(symbolOnlyPost()));
  assert.equal(normalized.sourceUrl, null);
  assert.equal(normalized.provenance.sourceUrl, null);
  assert.equal(normalized.missingness.sourceUrl, PUBLIC_INTELLIGENCE_MISSINGNESS.NO_OBSERVATION);
  // Never synthesized from the provider and observation id.
  assert.ok(!String(normalized.sourceUrl ?? '').includes('fixture.invalid'));
});

test('G3 a missing mint stays explicitly missing and is never invented', () => {
  const normalized = normalizeObservation5K1(canonicalizeRawObservation(symbolOnlyPost()));
  assert.equal(normalized.assetAssociation.mint, null);
  assert.equal(normalized.assetAssociation.status, PUBLIC_INTELLIGENCE_5K1_ASSOCIATION_STATUS.UNASSOCIATED);
  assert.equal(normalized.missingness.assetAssociation, PUBLIC_INTELLIGENCE_MISSINGNESS.ASSOCIATION_UNAVAILABLE);
  // An unassociated observation is a complete observation, not a broken one:
  // the raw text, provider, identity and fingerprints are all fully present.
  assert.equal(typeof normalized.raw.rawText, 'string');
  assert.equal(normalized.provider, FIXTURE_PROVIDER_A);
  assert.match(normalized.rawObservationFingerprint, /^[0-9a-f]{64}$/);
});

test('G4 missing engagement never becomes zero', () => {
  const normalized = normalizeObservation5K1(canonicalizeRawObservation(symbolOnlyPost()));
  assert.equal(normalized.engagement.status, PUBLIC_INTELLIGENCE_MISSINGNESS.NO_OBSERVATION);
  assert.equal(normalized.engagement.values, null, 'absent engagement must not be an object of zeros');
  assert.equal(normalized.engagement.providerSupplied, false);
  assert.equal(normalized.engagement.zeroFillingApplied, false);
  assert.equal(normalized.missingness.engagement, PUBLIC_INTELLIGENCE_MISSINGNESS.NO_OBSERVATION);
  // A provider-supplied 0 is OBSERVED, not missing: zero is a real reading.
  const observed = normalizeObservation5K1(canonicalizeRawObservation(exactMintProviderAPost()));
  assert.equal(observed.engagement.status, PUBLIC_INTELLIGENCE_MISSINGNESS.OBSERVED);
  assert.equal(observed.engagement.values.reposts, 0, 'a supplied zero is preserved as zero');
  assert.equal(observed.missingness.engagement, PUBLIC_INTELLIGENCE_MISSINGNESS.OBSERVED);
  // A partially supplied object is carried as-is; absent keys stay absent.
  const partial = normalizeObservation5K1(canonicalizeRawObservation(rawFixture({
    providerObservationId: 'alpha-0700',
    rawMetadata: { language: 'en', engagement: { likes: 5 }, fixtureNote: 'partial engagement' },
  })));
  assert.deepEqual(Object.keys(partial.engagement.values), ['likes']);
  assert.equal('reposts' in partial.engagement.values, false, 'absent keys must not be filled with 0');
  assert.equal(resolveEngagement(canonicalizeRawObservation(symbolOnlyPost())).values, null);
});

test('G5 unknown values remain unknown and missingness is always explicit', () => {
  const normalized = normalizeObservation5K1(canonicalizeRawObservation(nameOnlyPost()));
  assert.equal(normalized.missingness.allExplicit, true);
  assert.equal(normalized.missingness.zeroSubstitution, false);
  // Every reported missingness state is one 5K.0 explicitly defines.
  const allowed = new Set(Object.values(PUBLIC_INTELLIGENCE_MISSINGNESS));
  for (const [field, state] of Object.entries(normalized.missingness)) {
    if (!['allExplicit', 'zeroSubstitution'].includes(field)) {
      assert.ok(allowed.has(state), `${field} has an undeclared missingness state: ${state}`);
    }
  }
  // A non-EXACT_MINT association is reported as ASSOCIATION_UNAVAILABLE, never
  // as a fabricated success and never as an undeclared state.
  const unassociated = resolveMissingness(
    canonicalizeRawObservation(symbolOnlyPost()),
    resolveAssetAssociation(canonicalizeRawObservation(symbolOnlyPost())),
  );
  assert.equal(unassociated.assetAssociation, PUBLIC_INTELLIGENCE_MISSINGNESS.ASSOCIATION_UNAVAILABLE);
  const exact = resolveMissingness(
    canonicalizeRawObservation(exactMintProviderAPost()),
    resolveAssetAssociation(canonicalizeRawObservation(exactMintProviderAPost())),
  );
  assert.equal(exact.assetAssociation, PUBLIC_INTELLIGENCE_MISSINGNESS.OBSERVED);
  for (const state of Object.values(unassociated)) {
    if (typeof state === 'string') assert.ok(allowed.has(state), `undeclared state ${state}`);
  }
});

// @@CHUNK8@@

// ===========================================================================
// H. STORAGE
// ===========================================================================

test('H1 write and read are deterministic and round-trip byte-for-byte', () => {
  const root = tempRoot();
  const store = createNdjsonStore(root);
  const input = exactMintProviderAPost();
  const expected = ingestPublicObservation(input, { store });
  assert.equal(expected.outcome, PUBLIC_INTELLIGENCE_5K1_INGEST_OUTCOMES.INGESTED);
  assert.equal(expected.stored, true);
  assert.equal(store.count(), 1);

  // Raw evidence survives the round trip intact.
  const [record] = store.list();
  assert.equal(record.dedupIdentity, expected.dedupIdentity);
  assert.equal(record.rawObservationFingerprint, expected.rawObservationFingerprint);
  assert.equal(record.raw.rawText, input.rawText);
  assert.equal(record.raw.rawMetadata.fixtureNote, input.rawMetadata.fixtureNote);
  assert.equal(record.normalized.raw.rawText, input.rawText);
  assert.equal(record.classification.tradingAuthority, false);

  // Re-reading from disk yields byte-identical content.
  const reopened = createNdjsonStore(root);
  assert.equal(JSON.stringify(reopened.list()), JSON.stringify(store.list()));
  assert.equal(reopened.get(expected.dedupIdentity).raw.rawText, input.rawText);
  assert.equal(PUBLIC_INTELLIGENCE_5K1_STORAGE.deterministicRecordIdentity, true);
});

test('H2 a duplicate ingestion appends nothing to durable storage', () => {
  const root = tempRoot();
  const store = createNdjsonStore(root);
  ingestPublicObservation(exactMintProviderAPost(), { store });
  const afterFirst = readFileSync(store.filePath, 'utf8');
  ingestPublicObservation(exactMintProviderADuplicate(), { store });
  ingestPublicObservation(exactMintProviderADuplicate(), { store });
  assert.equal(readFileSync(store.filePath, 'utf8'), afterFirst, 'the file must not change');
  assert.equal(store.count(), 1);
  assert.equal(PUBLIC_INTELLIGENCE_5K1_STORAGE.idempotentIngest, true);
  // The same holds in memory.
  const memory = createMemoryStore();
  ingestPublicObservation(exactMintProviderAPost(), { store: memory });
  ingestPublicObservation(exactMintProviderADuplicate(), { store: memory });
  assert.equal(memory.count(), 1);
});

test('H3 raw evidence is written before and alongside normalization', () => {
  const root = tempRoot();
  const store = createNdjsonStore(root);
  ingestPublicObservation(exactMintProviderAPost(), { store });
  // Raw evidence is written to its own append-only stream FIRST, then the
  // envelope that carries the normalization. Both streams hold the record.
  assert.equal(store.rawList().length, 1, 'raw evidence stream must hold the record');
  assert.equal(store.count(), 1, 'envelope stream must hold the record');
  assert.equal(store.rawList()[0].rawText, exactMintProviderAPost().rawText);
  // Raw evidence survives independently of the normalized projection.
  assert.equal(store.rawList()[0].rawText, store.list()[0].normalized.raw.rawText);
  assert.equal(
    rawObservationFingerprint(canonicalizeRawObservation(store.rawList()[0])),
    store.list()[0].rawObservationFingerprint,
    'the standalone raw stream re-fingerprints to the stored identity');
  assert.equal(PUBLIC_INTELLIGENCE_5K1_STORAGE.rawWrittenBeforeNormalization, true);
  assert.equal(PUBLIC_INTELLIGENCE_5K1_STORAGE.rawPreserved, true);
  assert.equal(PUBLIC_INTELLIGENCE_5K1_INGEST.rawWrittenBeforeNormalization, true);
  for (const field of PUBLIC_INTELLIGENCE_5K1_RECORD_ENVELOPE.fields) {
    assert.ok(readFileSync(store.filePath, 'utf8').includes(`"${field}":`), `envelope must carry ${field}`);
  }
});

test('H4 storage is append-only: no record is ever mutated in place', () => {
  const root = tempRoot();
  const store = createNdjsonStore(root);
  ingestPublicObservation(exactMintProviderAPost(), { store });
  ingestPublicObservation(symbolOnlyPost(), { store });
  ingestPublicObservation(nameOnlyPost(), { store });
  const snapshot = readFileSync(store.filePath, 'utf8');
  const linesBefore = snapshot.split('\n').filter(Boolean);
  assert.equal(linesBefore.length, 3);
  // Any further ingestion only ever appends, and never rewrites an earlier line.
  ingestPublicObservation(exactMintProviderARepost(), { store });
  const after = readFileSync(store.filePath, 'utf8').split('\n').filter(Boolean);
  assert.equal(after.length, 4);
  for (let index = 0; index < linesBefore.length; index += 1) {
    assert.equal(after[index], linesBefore[index], `line ${index} was rewritten in place`);
  }
  assert.equal(PUBLIC_INTELLIGENCE_5K1_STORAGE.inPlaceMutationPermitted, false);
  assert.equal(PUBLIC_INTELLIGENCE_5K1_STORAGE.appendOnly, true);
  // Stored records are frozen snapshots, not live views onto the pipeline.
  const record = store.list()[0];
  assert.equal(Object.isFrozen(record), true);
});

test('H5 the store refuses to write anywhere under .evolve', () => {
  assert.deepEqual([...PUBLIC_INTELLIGENCE_5K1_FORBIDDEN_WRITE_ROOTS], ['.evolve']);
  assert.equal(PUBLIC_INTELLIGENCE_5K1_STORAGE.writesUnderEvolvePermitted, false);
  assert.equal(PUBLIC_INTELLIGENCE_5K1_STORAGE.refusesEvolvePaths, true);
  assert.equal(PUBLIC_INTELLIGENCE_5K1_INGEST.networkCalls, 0);
  // Direct, relative, and traversal paths into .evolve are all refused.
  for (const forbidden of [
    path.join(REPO_ROOT, '.evolve'),
    path.join(REPO_ROOT, '.evolve', 'public-intelligence'),
    path.join(REPO_ROOT, 'scripts', '..', '.evolve', 'x'),
    path.join(tempRoot(), '.evolve'),
  ]) {
    assertRefused(() => assertSafeStoreDirectory(forbidden),
      'PUBLIC_INTELLIGENCE_5K1_STORE_PATH_FORBIDDEN', forbidden);
    assertRefused(() => createNdjsonStore(forbidden),
      'PUBLIC_INTELLIGENCE_5K1_STORE_PATH_FORBIDDEN', `createNdjsonStore ${forbidden}`);
  }
  assertRefused(() => assertSafeStoreDirectory(''),
    'PUBLIC_INTELLIGENCE_5K1_STORE_DIRECTORY_REQUIRED', 'empty directory');
  // And nothing under .evolve was created while proving that.
  assert.equal(existsSafe(path.join(REPO_ROOT, '.evolve', 'public-intelligence')), false);
});

// @@CHUNK9@@

// ===========================================================================
// I. ARCHITECTURAL ISOLATION
// ===========================================================================

/** Module specifiers that would grant network reach, signing or RPC writes. */
const NETWORK_MODULES = [
  'node:http', 'node:https', 'node:net', 'node:dgram', 'node:tls', 'undici',
  'axios', 'node-fetch', 'got', 'superagent', 'http', 'https',
];
const WALLET_MODULES = [
  '@solana/web3.js', '@solana/spl-token', 'solana', 'solana-web3.js',
  'tweetnacl', 'ed25519-hd-keypairs', 'bs58',
];
const SIGNING_OR_RPC_WRITE = [
  'sendRawTransaction', 'sendTransaction', 'sendAndConfirmTransaction', 'signTransaction',
  'signAllTransactions', 'partialSign', 'Keypair', 'VersionedTransaction', 'Transaction',
  'SystemProgram', 'splToken', 'requestAirdrop', 'confirmTransaction', 'rpc',
];

test('I1 no 5K.1 module imports a network capability', () => {
  for (const relative of closure5K1) {
    const { found } = parseModule(relative);
    for (const source of [...found.importSources, ...found.dynamicImports]) {
      assert.ok(!NETWORK_MODULES.includes(source), `${relative} imports network module ${source}`);
      assert.ok(!/^https?:/.test(source), `${relative} imports a URL: ${source}`);
    }
    for (const member of found.memberObjects) {
      assert.ok(!['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'].includes(member),
        `${relative} references network member ${member}`);
    }
  }
});

test('I2 no 5K.1 module uses fetch, axios or any provider SDK', () => {
  for (const relative of closure5K1) {
    const { found } = parseModule(relative);
    for (const identifier of found.identifiers) {
      assert.ok(!['fetch', 'axios', 'XMLHttpRequest', 'WebSocket', 'navigator', 'Headers', 'Request', 'Response'].includes(identifier),
        `${relative} references network identifier ${identifier}`);
    }
  }
  // No live provider client is named anywhere in the 5K.1 surface.
  const providerClients = ['twitter', 'x-api', 'reddit', 'telegram', 'discord',
    'farcaster', 'bluesky', 'mastodon', 'nitter', 'snscrape', 'puppeteer', 'playwright'];
  for (const relative of closure5K1) {
    const { source } = parseModule(relative);
    for (const client of providerClients) {
      assert.ok(!new RegExp(`from ['"][^'"]*${client}`, 'i').test(source),
        `${relative} imports a provider client`);
    }
  }
});

test('I3 no 5K.1 module can hold a key, sign, or write to an RPC', () => {
  for (const relative of closure5K1) {
    const { found } = parseModule(relative);
    for (const source of [...found.importSources, ...found.dynamicImports]) {
      assert.ok(!WALLET_MODULES.includes(source), `${relative} imports wallet module ${source}`);
    }
    for (const identifier of found.identifiers) {
      assert.ok(!SIGNING_OR_RPC_WRITE.includes(identifier),
        `${relative} references wallet/RPC-write identifier ${identifier}`);
    }
    for (const member of found.memberObjects) {
      assert.ok(!SIGNING_OR_RPC_WRITE.includes(member),
        `${relative} references wallet/RPC-write member ${member}`);
    }
  }
  // The only Node builtins 5K.1 may touch are filesystem and path, for local
  // bounded storage. Nothing else opens a capability.
  const allowedBuiltins = new Set(['node:fs', 'node:path', 'node:crypto']);
  for (const relative of closure5K1) {
    const { found } = parseModule(relative);
    for (const source of found.importSources) {
      if (!source.startsWith('node:')) continue;
      assert.ok(allowedBuiltins.has(source), `${relative} imports disallowed builtin ${source}`);
    }
  }
});

test('I4 no 5K.1 module imports the engine or any market decision surface', () => {
  for (const entry of closure5K1) {
    assert.ok(!/(^|\/)(engine|arena|governance)(\/|$)/.test(entry), `engine/arena path in closure: ${entry}`);
    assert.ok(!/(^|\/)scripts\/engine\//.test(entry), `engine module in closure: ${entry}`);
    assert.ok(!/(^|\/)scripts\/arena(\/|\.mjs$)/.test(entry), `arena module in closure: ${entry}`);
  }
  // The 5K.1 closure reaches only itself, 5K.0 governance and the shared
  // canonical-JSON helper. Nothing decision-making is even on the path.
  const unexpected = closure5K1.filter(entry => !(
    entry.startsWith('scripts/public-intelligence/')
    || entry === 'scripts/market-intelligence/definition.mjs'
  ));
  assert.deepEqual(unexpected, [], '5K.1 closure reaches an unexpected module');
});

// @@CHUNK10@@

test('I5 no Arena, promotion or champion-selection surface imports 5K.1', () => {
  // The isolation is symmetric: 5K.1 does not reach decision surfaces, and
  // decision surfaces do not reach 5K.1.
  const consumers = [
    'scripts/evolve-engine.mjs', 'scripts/evolve-governance.mjs', 'scripts/arena.mjs',
    'scripts/champions.mjs', 'scripts/experiment.mjs', 'scripts/intelligence.mjs',
  ];
  for (const consumer of consumers) {
    if (!existsSafe(path.join(REPO_ROOT, consumer))) continue;
    const source = readFileSync(path.join(REPO_ROOT, consumer), 'utf8');
    assert.ok(!/public-intelligence/.test(source), `${consumer} imports Phase 5K`);
  }
  // And nothing in the repository outside 5K.1 itself imports the 5K.1 modules.
  const listed = execFileSync('git', ['ls-files', 'scripts'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean)
    .filter(file => file.endsWith('.mjs'));
  for (const file of listed) {
    if (file === 'scripts/validate-phase5k1.mjs' || file.startsWith('scripts/public-intelligence/')) continue;
    if (file === 'scripts/validate-phase5k.mjs') continue;
    const source = readFileSync(path.join(REPO_ROOT, file), 'utf8');
    assert.ok(!/public-intelligence\/(observation|provenance|normalize|dedup|store|ingest|fixtures)/.test(source),
      `${file} imports a 5K.1 module`);
  }
});

test('I6 no R4 module or R4 evidence path is imported or mutated by 5K.1', () => {
  for (const entry of closure5K1) {
    assert.ok(!/(^|\/)(governance\/r4|r4-[^/]*)(\/|\.|$)/.test(entry),
      `5K.1 closure reaches an R4 module: ${entry}`);
    assert.ok(!/(^|\/)market-outcomes(\/|\.|$)/.test(entry),
      `5K.1 closure reaches R4 market outcomes: ${entry}`);
  }
  assert.equal(PUBLIC_INTELLIGENCE_5K1_SCOPE.touchesR4Seal, false);
  assert.equal(PUBLIC_INTELLIGENCE_5K1_STORAGE.writesUnderEvolvePermitted, false);
});

test('I7 no 5K.1 artifact path writes under .evolve', () => {
  for (const relative of closure5K1) {
    const { found } = parseModule(relative);
    for (const literal of found.stringLiterals) {
      // The only .evolve mention allowed is the refusal constant itself.
      if (literal.includes('.evolve')) {
        assert.ok(relative.endsWith('store.mjs'),
          `${relative} mentions .evolve outside the store refusal boundary`);
        assert.ok(literal === '.evolve', `unexpected .evolve literal: ${literal}`);
      }
    }
    for (const source of found.importSources) {
      assert.ok(!source.includes('.evolve'), `${relative} imports from .evolve`);
    }
  }
  // And the repository's .evolve directory is untouched by everything above.
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
  for (const line of status.split('\n').filter(Boolean)) {
    assert.equal(/^\s*[MADRCU?!]{1,2}\s+\.evolve/.test(line), false, '.evolve must be untouched');
  }
  assert.equal(existsSafe(path.join(REPO_ROOT, '.evolve', 'public-intelligence')), false);
});

// @@CHUNK10@@

// ===========================================================================
// J. PHASE ANCESTRY AND INTEGRITY
// ===========================================================================

test('J1 HEAD descends from the finalized R4 C1 authority commit', () => {
  execFileSync('git', ['merge-base', '--is-ancestor', R4_HEAD, 'HEAD'], { cwd: REPO_ROOT });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  assert.match(head, /^[0-9a-f]{40}$/);
  assert.equal(R4_HEAD, '1c30264fb87876eeaf229e25c5cdc5adca429b40');
});

test('J2 existing R4 bound artifacts remain byte-identical to C1', () => {
  for (const bound of ['governance/r4/r4-preregistration-seal.json', 'package.json', 'package-lock.json']) {
    const now = readFileSync(path.join(REPO_ROOT, bound));
    const was = execFileSync('git', ['show', `${R4_HEAD}:${bound}`], { cwd: REPO_ROOT });
    assert.ok(now.equals(was), `R4 bound file modified: ${bound}`);
  }
  // No R4 governance, attempt, attestation, authorization or outcome path is dirty.
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
  for (const line of status.split('\n').filter(Boolean)) {
    assert.ok(!/(governance\/r4|\.evolve\/governance\/r4-|\.evolve\/market-outcomes|\.evolve\/market-intelligence)/.test(line),
      `R4 artifact path is dirty: ${line}`);
  }
});

test('J3 the 5K.0 governance definition remains intact and unmodified by 5K.1', () => {
  // 5K.1 extends 5K.0; it never rewrites it. The 5K.0 module is untouched in
  // the working tree, and its frozen classification is what 5K.1 carries.
  const definition = path.join(REPO_ROOT, 'scripts/public-intelligence/definition.mjs');
  assert.ok(existsSafe(definition), '5K.0 definition must still exist');
  const committed = execFileSync('git', ['show', 'HEAD:scripts/public-intelligence/definition.mjs'], { cwd: REPO_ROOT });
  assert.ok(readFileSync(definition).equals(committed), '5K.0 definition must be unmodified');
  assert.equal(PUBLIC_INTELLIGENCE_CLASSIFICATION.researchOnly, true);
  assert.equal(PUBLIC_INTELLIGENCE_CLASSIFICATION.observerOnly, true);
  assert.equal(PUBLIC_INTELLIGENCE_CLASSIFICATION.tradingAuthority, false);
  assert.equal(PUBLIC_INTELLIGENCE_CLASSIFICATION.engineAuthority, false);
  assert.equal(PUBLIC_INTELLIGENCE_CLASSIFICATION.arenaEligible, false);
  assert.equal(PUBLIC_INTELLIGENCE_CLASSIFICATION.promotionEligible, false);
  assert.equal(PUBLIC_INTELLIGENCE_CLASSIFICATION.profitabilityInferencePermitted, false);
  // Every 5K artifact this phase declares actually exists.
  for (const created of [
    'docs/PHASE5K-PUBLIC-SOCIAL-INTELLIGENCE.md',
    'docs/PHASE5K1-INGESTION-PROVENANCE.md',
    'scripts/validate-phase5k.mjs',
    'scripts/validate-phase5k1.mjs',
    ...MODULES_5K1,
  ]) {
    assert.ok(existsSafe(path.join(REPO_ROOT, created)), `missing 5K artifact: ${created}`);
  }
});

test('J4 the 5K.0 validator still passes at full strength after 5K.1', () => {
  const output = execFileSync('node', ['scripts/validate-phase5k.mjs'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.ok(output.includes('Phase 5K.0: 32/32 passed'),
    `5K.0 governance must remain 32/32, got: ${output.split('\n').pop()}`);
  assert.equal(output.includes('FAIL'), false, 'no 5K.0 assertion may fail');
});

test('J5 validation writes only to temporary fixtures and leaves the tree unchanged', () => {
  const before = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
  const root = tempRoot();
  assert.ok(root.startsWith(tmpdir()), 'fixture root is a temp directory');
  for (const created of temporary) {
    assert.ok(!created.startsWith(REPO_ROOT), `temp fixture inside repo: ${created}`);
  }
  // Re-running the whole 5K.1 surface must not change any repository state.
  const store = createMemoryStore();
  for (const fixture of [exactMintProviderAPost, exactMintProviderADuplicate, exactMintProviderARepost,
    exactMintProviderBSameText, symbolOnlyPost, nameOnlyPost, invalidMintPost, missingPublishedAtPost]) {
    ingestPublicObservation(fixture(), { store });
  }
  dedupAudit(store.list());
  const after = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(after, before, 'repository status unchanged by validation');
});

// ---------------------------------------------------------------------------
// RUNNER
// ---------------------------------------------------------------------------

async function run() {
  let failed = 0;
  try {
    for (const [name, fn] of tests) {
      try { await fn(); console.log(`PASS ${name}`); } catch (error) { failed++; console.error(`FAIL ${name}: ${error.stack}`); }
    }
  } finally { for (const root of temporary) rmSync(root, { recursive: true, force: true }); }
  console.log(`Phase 5K.1: ${tests.length - failed}/${tests.length} passed; offline, ingestion+provenance only, no provider contact`);
  if (failed) process.exitCode = 1;
}

run().catch(error => { console.error('phase 5K.1 validator crashed:', error); process.exitCode = 1; });

