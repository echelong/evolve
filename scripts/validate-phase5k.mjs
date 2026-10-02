#!/usr/bin/env node
// Phase 5K.0 - Public Social Intelligence research governance validator.
//
// COMPLETELY OFFLINE. This suite opens no socket, contacts no provider, holds
// no key and starts no network process. It proves the 5K.0 governance layer is
// permanently research/observer-only, that canonical identity requires an exact
// Solana mint, that evidence is deterministic and non-mutable, and that no
// import path exists from 5K.0 into the engine, Arena, promotion or R4.
//
// Capability and import audits use a real parse tree (espree), not fragile
// string matching. Tests write only to temporary directories and never to the
// repository, R4 evidence, or any existing session.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  PUBLIC_INTELLIGENCE_SCHEMA_VERSION, PUBLIC_INTELLIGENCE_CLASSIFICATION,
  PUBLIC_INTELLIGENCE_ALWAYS_FALSE_FLAGS, PUBLIC_INTELLIGENCE_ALWAYS_TRUE_FLAGS,
  PUBLIC_INTELLIGENCE_RECORD_TYPES, PUBLIC_INTELLIGENCE_ASSOCIATION_METHODS,
  PUBLIC_INTELLIGENCE_REJECTED_ASSOCIATION_METHODS, PUBLIC_INTELLIGENCE_MISSINGNESS,
  PUBLIC_INTELLIGENCE_MISSINGNESS_VALUES, PUBLIC_INTELLIGENCE_TIMESTAMP_FIELDS,
  PUBLIC_INTELLIGENCE_R4_BOUNDARY, PUBLIC_INTELLIGENCE_DEDUP, PUBLIC_INTELLIGENCE_FRESHNESS,
  PUBLIC_INTELLIGENCE_LOOKAHEAD_RULE, PUBLIC_INTELLIGENCE_RAW_SCHEMA,
  PUBLIC_INTELLIGENCE_NORMALIZED_SCHEMA, PUBLIC_INTELLIGENCE_SCOPE,
  PUBLIC_INTELLIGENCE_PROVIDER_ISOLATION, PUBLIC_INTELLIGENCE_FORBIDDEN_CONSUMERS,
  PUBLIC_INTELLIGENCE_COLLECTION_BOUNDS, PUBLIC_INTELLIGENCE_PHASE_5K_0_SCOPE,
  PUBLIC_INTELLIGENCE_GOVERNANCE,
  assertObserverOnlyClassification, assertExactMintAssociation, assertMissingnessExplicit,
  assertTimestamp, assertClosedSchema, canonicalMintAddress, validateRawObservation,
  normalizeObservation, rawFingerprint, normalizedFingerprint, verifyProvenance,
  dedupIdentity, sameObservation, sessionFingerprint, isAvailableAt, selectAvailableAt,
  freshnessMetadata, canonical, digest,
  PUBLIC_INTELLIGENCE_NON_CANONICAL_IDENTITY_REJECTS_SYMBOL,
  PUBLIC_INTELLIGENCE_MISSINGNESS_RULE_ZERO_NEVER_MISSING,
  transactionSubmissionProhibited,
} from './public-intelligence/definition.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_REL = 'scripts/public-intelligence/definition.mjs';
const MODULE_PATH = path.join(REPO_ROOT, MODULE_REL);
const R4_HEAD = '1c30264fb87876eeaf229e25c5cdc5adca429b40';

const require = createRequire(import.meta.url);
const espree = require('espree');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const MINT_A = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MINT_B = 'So11111111111111111111111111111111111111112';
const at = 1800000000000;

const rawFixture = (overrides = {}) => ({
  schemaVersion: PUBLIC_INTELLIGENCE_SCHEMA_VERSION,
  recordType: PUBLIC_INTELLIGENCE_RECORD_TYPES.RAW_SOCIAL_OBSERVATION,
  provider: 'fixture_public_social',
  providerObservationId: '100200300',
  sourcePublishedAt: at - 120000,
  providerObservedAt: at - 60000,
  retrievedAt: at,
  canonicalUrl: 'https://example.invalid/i/status/100200300',
  authorPublicId: 'public-author-1',
  textDigest: digest({ text: 'fixture public observation' }),
  rawPayloadDigest: digest({ raw: 'fixture payload' }),
  candidateMintAddresses: [MINT_A],
  exactAssociatedMintAddresses: [MINT_A],
  associationMethod: PUBLIC_INTELLIGENCE_ASSOCIATION_METHODS.EXACT_MINT_ADDRESS,
  provenance: { normalizedTextDigest: digest({ text: 'fixture public observation normalized' }) },
  classification: { ...PUBLIC_INTELLIGENCE_CLASSIFICATION },
  ...overrides,
});

const unassociatedFixture = (overrides = {}) => rawFixture({
  candidateMintAddresses: [],
  exactAssociatedMintAddresses: [],
  associationMethod: PUBLIC_INTELLIGENCE_ASSOCIATION_METHODS.UNASSOCIATED,
  ...overrides,
});

/** Parse a module and return its AST plus a generic walker. */
function parseModule(relative = MODULE_REL) {
  const ast = espree.parse(readFileSync(path.join(REPO_ROOT, relative), 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' });
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
  return { ast, found };
}

/** The transitive static import closure of a module, repo-relative. */
function importClosure(entry = MODULE_REL) {
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

const temporary = [];
function tempRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'evolve-5k0-'));
  temporary.push(root);
  return root;
}

// ---------------------------------------------------------------------------
// 1-6:   PERMANENT CLASSIFICATION
// ---------------------------------------------------------------------------

test('1 classification is permanently research/observer-only', () => {
  for (const flag of PUBLIC_INTELLIGENCE_ALWAYS_TRUE_FLAGS) {
    assert.equal(PUBLIC_INTELLIGENCE_CLASSIFICATION[flag], true, flag);
  }
  assert.equal(assertObserverOnlyClassification(PUBLIC_INTELLIGENCE_CLASSIFICATION), true);
  assert.throws(() => { 'use strict'; PUBLIC_INTELLIGENCE_CLASSIFICATION.tradingAuthority = true; }, TypeError);
});
test('2 tradingAuthority is false and cannot be asserted true', () => {
  assert.equal(PUBLIC_INTELLIGENCE_CLASSIFICATION.tradingAuthority, false);
  assert.throws(() => assertObserverOnlyClassification({ ...PUBLIC_INTELLIGENCE_CLASSIFICATION, tradingAuthority: true }),
    { message: 'PUBLIC_INTELLIGENCE_CLASSIFICATION_FLAG_TRUE:tradingAuthority' });
});
test('3 engineAuthority is false and cannot be asserted true', () => {
  assert.equal(PUBLIC_INTELLIGENCE_CLASSIFICATION.engineAuthority, false);
  assert.throws(() => assertObserverOnlyClassification({ ...PUBLIC_INTELLIGENCE_CLASSIFICATION, engineAuthority: true }),
    { message: 'PUBLIC_INTELLIGENCE_CLASSIFICATION_FLAG_TRUE:engineAuthority' });
});
test('4 arenaEligible is false and cannot be asserted true', () => {
  assert.equal(PUBLIC_INTELLIGENCE_CLASSIFICATION.arenaEligible, false);
  assert.throws(() => assertObserverOnlyClassification({ ...PUBLIC_INTELLIGENCE_CLASSIFICATION, arenaEligible: true }),
    { message: 'PUBLIC_INTELLIGENCE_CLASSIFICATION_FLAG_TRUE:arenaEligible' });
});
test('5 promotionEligible is false and cannot be asserted true', () => {
  assert.equal(PUBLIC_INTELLIGENCE_CLASSIFICATION.promotionEligible, false);
  assert.throws(() => assertObserverOnlyClassification({ ...PUBLIC_INTELLIGENCE_CLASSIFICATION, promotionEligible: true }),
    { message: 'PUBLIC_INTELLIGENCE_CLASSIFICATION_FLAG_TRUE:promotionEligible' });
});
test('6 profitabilityInferencePermitted is false; no profitability claim permitted', () => {
  assert.equal(PUBLIC_INTELLIGENCE_CLASSIFICATION.profitabilityInferencePermitted, false);
  assert.throws(() => assertObserverOnlyClassification({ ...PUBLIC_INTELLIGENCE_CLASSIFICATION, profitabilityInferencePermitted: true }),
    { message: 'PUBLIC_INTELLIGENCE_CLASSIFICATION_FLAG_TRUE:profitabilityInferencePermitted' });
  assert.deepEqual(PUBLIC_INTELLIGENCE_ALWAYS_FALSE_FLAGS.slice().sort(),
    ['arenaEligible', 'engineAuthority', 'profitabilityInferencePermitted', 'promotionEligible', 'tradingAuthority']);
});

// ---------------------------------------------------------------------------
// 7-11:  CANONICAL SUBJECT IDENTITY
// ---------------------------------------------------------------------------

test('7 canonical identity requires an exact mint address', () => {
  assert.equal(canonicalMintAddress(MINT_A), MINT_A);
  assert.equal(canonicalMintAddress(MINT_B), MINT_B);
  assert.equal(assertExactMintAssociation(PUBLIC_INTELLIGENCE_ASSOCIATION_METHODS.EXACT_MINT_ADDRESS, [MINT_A]), true);
  assert.throws(() => assertExactMintAssociation(PUBLIC_INTELLIGENCE_ASSOCIATION_METHODS.EXACT_MINT_ADDRESS, []),
    { message: 'PUBLIC_INTELLIGENCE_EXACT_MINT_REQUIRES_ADDRESS' });
  assert.equal(PUBLIC_INTELLIGENCE_R4_BOUNDARY.evidenceClass, 'PUBLIC_SOCIAL_RESEARCH_EVIDENCE');
});
test('8 symbol-only association is rejected', () => {
  assert.equal(canonicalMintAddress('WIF'), null);
  assert.equal(canonicalMintAddress('SOL'), null);
  for (const method of ['SYMBOL_ONLY', 'TICKER_GUESS']) {
    assert.ok(PUBLIC_INTELLIGENCE_REJECTED_ASSOCIATION_METHODS.includes(method));
    assert.throws(() => assertExactMintAssociation(method, [MINT_A]), /PUBLIC_INTELLIGENCE_ASSOCIATION_METHOD_INVALID/);
  }
  assert.throws(() => assertExactMintAssociation(PUBLIC_INTELLIGENCE_ASSOCIATION_METHODS.EXACT_MINT_ADDRESS, ['WIF']),
    { message: 'PUBLIC_INTELLIGENCE_MINT_NOT_EXACT:WIF' });
  assert.equal(PUBLIC_INTELLIGENCE_NON_CANONICAL_IDENTITY_REJECTS_SYMBOL(), true);
});
test('9 name-only association is rejected', () => {
  assert.equal(canonicalMintAddress('dogwifhat'), null);
  assert.equal(canonicalMintAddress('Dog Wif Hat'), null);
  for (const method of ['TOKEN_NAME_ONLY', 'PROFILE_NAME_SIMILARITY']) {
    assert.ok(PUBLIC_INTELLIGENCE_REJECTED_ASSOCIATION_METHODS.includes(method));
    assert.throws(() => assertExactMintAssociation(method, [MINT_A]), /PUBLIC_INTELLIGENCE_ASSOCIATION_METHOD_INVALID/);
  }
});
test('10 fuzzy association is rejected as canonical identity', () => {
  for (const method of ['FUZZY_TOKEN_MATCH', 'FUZZY_MATCH', 'PREFIX_MATCH', 'EDIT_DISTANCE_MATCH',
    'EMBEDDING_SIMILARITY', 'NATURAL_LANGUAGE_SIMILARITY', 'HEURISTIC_INFERENCE', 'MANUAL_GUESS']) {
    assert.ok(PUBLIC_INTELLIGENCE_REJECTED_ASSOCIATION_METHODS.includes(method), method);
    assert.throws(() => assertExactMintAssociation(method, [MINT_A]), /PUBLIC_INTELLIGENCE_ASSOCIATION_METHOD_INVALID/);
  }
  // A prefix or near-miss is NEVER the same identity as the full address, even
  // when the truncated string is still syntactically base58. Exactness is what
  // makes the association canonical, so a prefix cannot stand in for the mint.
  assert.notEqual(canonicalMintAddress(MINT_A.slice(0, 40)), MINT_A);
  assert.notEqual(canonicalMintAddress(MINT_A.slice(0, 40)) + 'x', MINT_A);
  assert.throws(() => assertExactMintAssociation(PUBLIC_INTELLIGENCE_ASSOCIATION_METHODS.UNASSOCIATED, [MINT_A]),
    { message: 'PUBLIC_INTELLIGENCE_UNASSOCIATED_WITH_ADDRESSES' });
});
test('11 unassociated observations are valid and remain unassociated', () => {
  const raw = unassociatedFixture();
  assert.equal(validateRawObservation(raw), true);
  const normalized = normalizeObservation(raw);
  assert.equal(normalized.associationMethod, 'UNASSOCIATED');
  assert.deepEqual(normalized.exactAssociatedMintAddresses, []);
  assert.equal(normalized.missingness, PUBLIC_INTELLIGENCE_MISSINGNESS.NO_OBSERVATION);
  assert.equal(PUBLIC_INTELLIGENCE_MISSINGNESS_RULE_ZERO_NEVER_MISSING(), true);
});



// ---------------------------------------------------------------------------
// 12-16: EVIDENCE DETERMINISM, LOOK-AHEAD AND IMMUTABILITY
// ---------------------------------------------------------------------------

test('12 raw and normalized identities are deterministic and reproducible', () => {
  const a = rawFixture();
  const b = rawFixture();
  assert.equal(rawFingerprint(a), rawFingerprint(b));
  assert.equal(normalizedFingerprint(normalizeObservation(a)), normalizedFingerprint(normalizeObservation(b)));
  // Key order in the source object never changes the digest: canonical JSON.
  const reordered = Object.fromEntries(Object.entries(a).reverse());
  assert.equal(rawFingerprint(reordered), rawFingerprint(a));
  // Different content yields a different identity.
  assert.notEqual(rawFingerprint(rawFixture({ providerObservationId: '999' })), rawFingerprint(a));
  assert.match(rawFingerprint(a), /^[0-9a-f]{64}$/);
});
test('13 no hidden look-ahead: only evidence available at the reference instant is admissible', () => {
  const early = { provider: 'p', providerObservationId: '1', retrievedAt: at - 60000 };
  const late = { provider: 'p', providerObservationId: '2', retrievedAt: at + 60000 };
  // A post retrieved AFTER the reference instant can never influence it.
  assert.equal(isAvailableAt(early, at), true);
  assert.equal(isAvailableAt(late, at), false);
  assert.deepEqual(selectAvailableAt([early, late], at).map(r => r.providerObservationId), ['1']);
  // An invalid reference fails closed and admits nothing.
  assert.deepEqual(selectAvailableAt([early], Number.NaN).length, 0);
  assert.equal(PUBLIC_INTELLIGENCE_LOOKAHEAD_RULE.futureEvidenceAdmitted, false);
  assert.equal(PUBLIC_INTELLIGENCE_LOOKAHEAD_RULE.availabilityField, 'retrievedAt');
});
test('14 raw evidence cannot be mutated by normalization', () => {
  const raw = rawFixture();
  const before = JSON.stringify(raw);
  const fingerprintBefore = rawFingerprint(raw);
  const normalized = normalizeObservation(raw);
  // Normalization is pure: the raw object is byte-identical afterwards.
  assert.equal(JSON.stringify(raw), before);
  assert.equal(rawFingerprint(raw), fingerprintBefore);
  // The normalized record is a separate, frozen object.
  assert.notEqual(normalized, raw);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(normalized.provenance.rawEvidenceFingerprint, fingerprintBefore);
  assert.equal(normalized.provenance.rewritten, false);
  // Normalization cannot write through its own output either.
  assert.throws(() => { 'use strict'; normalized.provider = 'tampered'; }, TypeError);
});
test('15 timestamp fields remain distinct and are never collapsed', () => {
  assert.deepEqual(PUBLIC_INTELLIGENCE_TIMESTAMP_FIELDS, ['sourcePublishedAt', 'providerObservedAt', 'retrievedAt']);
  const raw = rawFixture();
  for (const field of PUBLIC_INTELLIGENCE_TIMESTAMP_FIELDS) {
    assert.equal(typeof raw[field], 'number', field);
  }
  assert.equal(new Set(PUBLIC_INTELLIGENCE_TIMESTAMP_FIELDS.map(f => raw[f])).size, 3);
  // Collapsing all three clocks into one value is refused.
  assert.throws(() => validateRawObservation(rawFixture({ sourcePublishedAt: at, providerObservedAt: at, retrievedAt: at })),
    { message: 'PUBLIC_INTELLIGENCE_TIMESTAMPS_COLLAPSED' });
  // Freshness metadata is descriptive only and never picks a threshold.
  const freshness = freshnessMetadata(raw);
  assert.equal(freshness.thresholdMs, null);
  assert.equal(freshness.retrievalLagMs, 60000);
  assert.equal(freshness.publicationToRetrievalMs, 120000);
  assert.equal(PUBLIC_INTELLIGENCE_FRESHNESS.thresholdChosenInPhase5K0, false);
  assert.equal(PUBLIC_INTELLIGENCE_FRESHNESS.gateImplementedIn, 'PHASE_5K_3');
});
test('16 invalid and non-finite timestamps fail closed', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5, -1, '1800000000000']) {
    assert.throws(() => assertTimestamp(bad, 'retrievedAt'), /PUBLIC_INTELLIGENCE_TIMESTAMP_/, `value ${String(bad)}`);
    assert.throws(() => validateRawObservation(rawFixture({ retrievedAt: bad })), /PUBLIC_INTELLIGENCE_TIMESTAMP_/, `value ${String(bad)}`);
  }
  // An absent clock is a schema failure, never a silently defaulted timestamp.
  for (const absent of [null, undefined]) {
    assert.throws(() => assertTimestamp(absent, 'retrievedAt'), /PUBLIC_INTELLIGENCE_TIMESTAMP_/);
    assert.throws(() => validateRawObservation(rawFixture({ retrievedAt: absent })), /PUBLIC_INTELLIGENCE_(TIMESTAMP|FIELD_MISSING)/);
  }
  // A missing REQUIRED clock is a failure, never a silent default.
  assert.throws(() => assertTimestamp(undefined, 'retrievedAt', { optional: false }),
    { message: 'PUBLIC_INTELLIGENCE_TIMESTAMP_REQUIRED:retrievedAt' });
  // sourcePublishedAt is the one optional clock: absent is null, never zero.
  assert.equal(assertTimestamp(null, 'sourcePublishedAt', { optional: true }), null);
  assert.equal(assertTimestamp(0, 'sourcePublishedAt', { optional: true }), 0);
  assert.equal(validateRawObservation(rawFixture({ sourcePublishedAt: null })), true);
  // A negative clock is impossible, not a sentinel.
  assert.throws(() => validateRawObservation(rawFixture({ sourcePublishedAt: -1 })), /PUBLIC_INTELLIGENCE_TIMESTAMP_/);
  // A non-integer or non-number clock is refused outright.
  for (const bad of [1.5, '1800000000000', Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => validateRawObservation(rawFixture({ sourcePublishedAt: bad })), /PUBLIC_INTELLIGENCE_TIMESTAMP_/);
  }
});

// ---------------------------------------------------------------------------
// 17-20: DEDUPLICATION AND MISSINGNESS
// ---------------------------------------------------------------------------

test('17 provider IDs participate in dedup identity', () => {
  const a = { provider: 'provider_one', providerObservationId: '42', textDigest: digest('same text') };
  const b = { provider: 'provider_two', providerObservationId: '42', textDigest: digest('same text') };
  // Same provider + same id => same identity (true duplicate).
  assert.equal(dedupIdentity(a), dedupIdentity({ ...a }));
  // Different provider => DIFFERENT identity even with identical id and text.
  assert.notEqual(dedupIdentity(a), dedupIdentity(b));
  assert.equal(sameObservation(a, { ...a }), true);
  assert.equal(sameObservation(a, b), false);
  // Text equality alone is not an identity: two posts, same text, different ids.
  assert.notEqual(dedupIdentity({ provider: 'p', providerObservationId: '1', textDigest: digest('t') }),
    dedupIdentity({ provider: 'p', providerObservationId: '2', textDigest: digest('t') }));
  assert.deepEqual(PUBLIC_INTELLIGENCE_DEDUP.identityFields, ['provider', 'providerObservationId']);
  assert.equal(PUBLIC_INTELLIGENCE_DEDUP.textEqualityAloneIsIdentity, false);
});
test('18 different providers do not silently collapse into one observation', () => {
  const rawA = rawFixture({ provider: 'provider_one', providerObservationId: '100200300' });
  const rawB = rawFixture({ provider: 'provider_two', providerObservationId: '100200300' });
  const normA = normalizeObservation(rawA);
  const normB = normalizeObservation(rawB);
  // Identical text and identical provider observation id, still two records.
  assert.equal(normA.textDigest, normB.textDigest);
  assert.notEqual(normA.dedupIdentity, normB.dedupIdentity);
  assert.equal(sameObservation(normA, normB), false);
  assert.equal(PUBLIC_INTELLIGENCE_DEDUP.crossProviderCollapsePermitted, false);
  // A missing provider observation id is explicitly unidentifiable, never text-derived.
  const unidentifiable = dedupIdentity({ provider: 'provider_one', providerObservationId: null, textDigest: null });
  assert.match(unidentifiable, /^[0-9a-f]{64}$/);
  assert.throws(() => dedupIdentity({ provider: '', providerObservationId: '1' }),
    { message: 'PUBLIC_INTELLIGENCE_PROVIDER_REQUIRED' });
});
test('19 missing evidence remains missing and is never converted to zero', () => {
  for (const state of ['NO_OBSERVATION', 'PROVIDER_UNAVAILABLE', 'ASSOCIATION_UNAVAILABLE',
    'RATE_LIMITED', 'UNKNOWN_MINT', 'NOT_YET_PUBLISHED']) {
    assert.ok(PUBLIC_INTELLIGENCE_MISSINGNESS_VALUES.includes(state), state);
    assert.throws(() => assertMissingnessExplicit(state, 0), { message: 'PUBLIC_INTELLIGENCE_MISSINGNESS_ZERO_SUBSTITUTION' });
    assert.throws(() => assertMissingnessExplicit(state, false), { message: 'PUBLIC_INTELLIGENCE_MISSINGNESS_BOOLEAN_SUBSTITUTION' });
    assert.throws(() => assertMissingnessExplicit(state, ''), { message: 'PUBLIC_INTELLIGENCE_MISSINGNESS_EMPTY_SUBSTITUTION' });
    // An explicit null measurement is the correct representation.
    assert.equal(assertMissingnessExplicit(state, null), true);
  }
  // OBSERVED may legitimately carry a real zero: zero likes is observed, not missing.
  assert.equal(assertMissingnessExplicit(PUBLIC_INTELLIGENCE_MISSINGNESS.OBSERVED, 0), true);
  assert.throws(() => assertMissingnessExplicit('NOT_A_STATE', 0), /PUBLIC_INTELLIGENCE_MISSINGNESS_INVALID/);
});
test('20 unknown mint remains explicit missing/unknown, never a fabricated match', () => {
  assert.ok(PUBLIC_INTELLIGENCE_MISSINGNESS_VALUES.includes('UNKNOWN_MINT'));
  // An unresolvable subject is UNASSOCIATED with explicit missingness.
  const raw = unassociatedFixture();
  const normalized = normalizeObservation(raw);
  assert.deepEqual(normalized.exactAssociatedMintAddresses, []);
  assert.equal(normalized.missingness, PUBLIC_INTELLIGENCE_MISSINGNESS.NO_OBSERVATION);
  // A malformed candidate address is refused outright.
  for (const bad of ['not-a-mint', '0OIl', 'WIF', '', 42, `${MINT_A} `]) {
    assert.throws(() => validateRawObservation(rawFixture({ candidateMintAddresses: [bad] })),
      /PUBLIC_INTELLIGENCE_(CANDIDATE_MINT_NOT_EXACT|MINT_NOT_EXACT)/, `candidate ${String(bad)}`);
  }
  assert.throws(() => validateRawObservation(rawFixture({ candidateMintAddresses: MINT_A })),
    { message: 'PUBLIC_INTELLIGENCE_CANDIDATES_INVALID' });
});

// ---------------------------------------------------------------------------
// 21-24: PROVENANCE, CLOSED SCHEMA, MINT IDENTITY, FINGERPRINTS
// ---------------------------------------------------------------------------

test('21 provenance fingerprint mismatch fails closed', () => {
  const raw = rawFixture();
  const normalized = normalizeObservation(raw);
  assert.equal(verifyProvenance(normalized, raw), true);
  // A normalized record that claims a different raw record is refused.
  const other = rawFixture({ providerObservationId: 'other' });
  assert.throws(() => verifyProvenance(normalized, other),
    { message: 'PUBLIC_INTELLIGENCE_PROVENANCE_FINGERPRINT_MISMATCH' });
  // A silently rewritten raw record no longer matches the bound fingerprint.
  const rewrittenRaw = { ...raw, textDigest: digest('rewritten after the fact') };
  assert.throws(() => verifyProvenance(normalized, rewrittenRaw),
    { message: 'PUBLIC_INTELLIGENCE_PROVENANCE_FINGERPRINT_MISMATCH' });
  // A fabricated provenance block is refused too.
  assert.throws(() => verifyProvenance({ ...normalized, provenance: { ...normalized.provenance, rawEvidenceFingerprint: digest('forged') } }, raw),
    { message: 'PUBLIC_INTELLIGENCE_PROVENANCE_FINGERPRINT_MISMATCH' });
  // Payload digest, provider and orphan records are all checked.
  assert.throws(() => verifyProvenance({ ...normalized, provenance: { ...normalized.provenance, rawPayloadDigest: digest('other') } }, raw),
    { message: 'PUBLIC_INTELLIGENCE_PROVENANCE_PAYLOAD_DIGEST_MISMATCH' });
  assert.throws(() => verifyProvenance({ ...normalized, provenance: { ...normalized.provenance, provider: 'other' } }, raw),
    { message: 'PUBLIC_INTELLIGENCE_PROVENANCE_PROVIDER_MISMATCH' });
  assert.throws(() => verifyProvenance(normalized, null), { message: 'PUBLIC_INTELLIGENCE_PROVENANCE_RAW_MISSING' });
});
test('22 unknown schema fields fail when the closed schema is used', () => {
  assert.equal(PUBLIC_INTELLIGENCE_RAW_SCHEMA.closed, true);
  assert.equal(PUBLIC_INTELLIGENCE_NORMALIZED_SCHEMA.closed, true);
  // An unknown field on a raw record is refused.
  assert.throws(() => validateRawObservation(rawFixture({ sentimentScore: 0.9 })),
    { message: 'PUBLIC_INTELLIGENCE_UNKNOWN_FIELD:sentimentScore' });
  assert.throws(() => validateRawObservation(rawFixture({ buySignal: true })),
    { message: 'PUBLIC_INTELLIGENCE_UNKNOWN_FIELD:buySignal' });
  // Explicitly forbidden personal/private fields are refused by name.
  for (const field of PUBLIC_INTELLIGENCE_RAW_SCHEMA.forbiddenFields) {
    assert.throws(() => validateRawObservation(rawFixture({ [field]: 'x' })),
      { message: `PUBLIC_INTELLIGENCE_FIELD_FORBIDDEN:${field}` }, field);
  }
  // A required field may not be dropped.
  assert.throws(() => validateRawObservation(rawFixture({ retrievedAt: undefined })),
    { message: 'PUBLIC_INTELLIGENCE_FIELD_MISSING:retrievedAt' });
  // A normalized record with an unknown field is refused too.
  const normalized = normalizeObservation(rawFixture());
  assert.throws(() => assertClosedSchema({ ...normalized, extra: 1 }, PUBLIC_INTELLIGENCE_NORMALIZED_SCHEMA),
    { message: 'PUBLIC_INTELLIGENCE_UNKNOWN_FIELD:extra' });
});
test('23 malformed Solana mint identity fails', () => {
  // Non-base58 characters, wrong length, wrong type, and padded values all fail.
  for (const bad of ['0OIl', 'has space', 'a'.repeat(45), 'a'.repeat(31), '', null, undefined, 42, {}, []]) {
    assert.equal(canonicalMintAddress(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
  // Solana addresses are case-sensitive and 5K.0 never folds case: a
  // lowercased address is a DIFFERENT string, so it must not be reported as the
  // same canonical identity.
  const lowercased = MINT_A.toLowerCase();
  assert.notEqual(canonicalMintAddress(lowercased), MINT_A);
  assert.notEqual(canonicalMintAddress(MINT_A), lowercased);
  assert.equal(validateRawObservation(rawFixture()), true);
  // A valid second mint proves the rule is not hardcoded to one address.
  assert.equal(validateRawObservation(rawFixture({ candidateMintAddresses: [MINT_B], exactAssociatedMintAddresses: [MINT_B] })), true);
  // 5K.0 validates IDENTITY FORMAT, not on-chain existence. A 43-char base58
  // string is format-valid, so it is accepted as a syntactically exact address;
  // what is refused is any string that is not exactly a canonical mint form.
  const truncated = MINT_A.slice(0, -1);
  assert.equal(canonicalMintAddress(truncated), truncated);
  assert.notEqual(truncated, MINT_A);
  // Case is never folded: the lowercased form is a different identity string.
  assert.notEqual(canonicalMintAddress(MINT_A.toLowerCase()), MINT_A);
  // Any deviation from the base58 32-44 character form is refused.
  for (const malformed of [MINT_A.slice(0, -1) + '0', MINT_A.slice(0, -1) + 'O', MINT_A + 'l', MINT_A + 'I']) {
    assert.equal(canonicalMintAddress(malformed), null, malformed);
  }
});
test('24 deterministic canonical fingerprints reproduce exactly', () => {
  const raw = rawFixture();
  const session = {
    providerConfig: { fixture: { enabled: true } },
    collectionBounds: { maxDurationMs: 1000, maxRequestsPerRun: 1 },
    rawFingerprints: [rawFingerprint(raw)],
    normalizedFingerprints: [normalizedFingerprint(normalizeObservation(raw))],
    exactMintAssociations: [MINT_A],
    sourceTimestamps: [at],
  };
  const first = sessionFingerprint(session);
  // Same input, different key order and array order => identical fingerprint.
  const second = sessionFingerprint({
    sourceTimestamps: [at], exactMintAssociations: [MINT_A],
    normalizedFingerprints: session.normalizedFingerprints, rawFingerprints: session.rawFingerprints,
    collectionBounds: session.collectionBounds, providerConfig: session.providerConfig,
  });
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
  // Any bound input changing changes the fingerprint.
  assert.notEqual(first, sessionFingerprint({ ...session, exactMintAssociations: [MINT_B] }));
  assert.notEqual(first, sessionFingerprint({ ...session, rawFingerprints: [digest('other')] }));
  // The fingerprint also binds software identity and the classification block.
  assert.notEqual(first, sessionFingerprint({ ...session, softwareIdentity: { project: 'evolve', phase: 'PHASE_5K_0' } }));
});

// ---------------------------------------------------------------------------
// 25-31: CAPABILITY, IMPORT AND R4 AUDITS (AST-based, not string matching)
// ---------------------------------------------------------------------------

/** Identifiers/literals that would indicate a live capability. */
const FORBIDDEN_CAPABILITY = /^(fetch|XMLHttpRequest|WebSocket|EventSource|signTransaction|signAllTransactions|sign|signer|Keypair|sendTransaction|sendRawTransaction|submitTransaction|swap|executeTrade|placeOrder|submitOrder|createConnection|http|https|request|axios)$/;
const FORBIDDEN_NETWORK_MODULE = /^(node:)?(http|https|http2|net|tls|dgram|dns|inspector|cluster|worker_threads)$/;
const FORBIDDEN_SIGNING_LITERAL = /(privateKey|secretKey|mnemonic|seedPhrase|keypair|signTransaction|sendTransaction|sendRawTransaction|sendAndConfirm|signAndSend|executeSwap)/i;
const ENGINE_OR_ARENA_MODULE = /(^|\/)(engine|arena|champions|evolve-engine|evolve-governance|jev)(\/|\.|$)/;

test('25 no network imports or network access exist in the 5K.0 module', () => {
  const { found } = parseModule(MODULE_REL);
  for (const source of found.importSources) {
    assert.ok(!FORBIDDEN_NETWORK_MODULE.test(source), `network import: ${source}`);
    // The only permitted import is the local canonical-hashing helper.
    assert.equal(source, '../market-intelligence/definition.mjs', `unexpected import: ${source}`);
  }
  assert.deepEqual(found.dynamicImports, [], 'no dynamic import may hide a provider client');
  for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'navigator', 'http', 'https']) {
    assert.ok(!found.identifiers.includes(name), `network global referenced: ${name}`);
    assert.ok(!found.memberObjects.includes(name), `network member referenced: ${name}`);
  }
  assert.equal(PUBLIC_INTELLIGENCE_PHASE_5K_0_SCOPE.networkAccessPermitted, false);
  assert.equal(PUBLIC_INTELLIGENCE_PHASE_5K_0_SCOPE.contactsNoProvider, true);
  assert.equal(PUBLIC_INTELLIGENCE_PHASE_5K_0_SCOPE.collectsNothing, true);
  for (const literal of found.stringLiterals) {
    assert.ok(!/twitter|api\.x|apify|brightdata|scrapy|playwright|puppeteer/i.test(literal),
      `provider/scraper literal present: ${literal}`);
  }
});
test('26 no wallet, signing, swap or RPC-write capability exists', () => {
  const { found } = parseModule(MODULE_REL);
  for (const name of [...found.identifiers, ...found.memberObjects]) {
    assert.ok(!FORBIDDEN_CAPABILITY.test(name), `forbidden capability: ${name}`);
  }
  for (const literal of found.stringLiterals) {
    assert.ok(!FORBIDDEN_SIGNING_LITERAL.test(literal), `signing/trading literal: ${literal}`);
  }
  for (const forbidden of ['process', 'execSync', 'spawn', 'spawnSync', 'execFile',
    'writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync']) {
    assert.ok(!found.identifiers.includes(forbidden), `side-effect identifier: ${forbidden}`);
  }
  assert.equal(PUBLIC_INTELLIGENCE_PHASE_5K_0_SCOPE.startsNoProcess, true);
  assert.equal(PUBLIC_INTELLIGENCE_PHASE_5K_0_SCOPE.writesNothing, true);
  assert.equal(PUBLIC_INTELLIGENCE_PHASE_5K_0_SCOPE.holdsNoKeys, true);
  assert.equal(transactionSubmissionProhibited(), true);
});

test('27 no import path from 5K.0 into engine or market decision surfaces', () => {
  const closure = importClosure(MODULE_REL);
  // The entire static import closure is the module plus the pure hashing helper.
  assert.deepEqual(closure, ['scripts/market-intelligence/definition.mjs', 'scripts/public-intelligence/definition.mjs']);
  for (const entry of closure) {
    assert.ok(!ENGINE_OR_ARENA_MODULE.test(entry), `forbidden decision-surface import: ${entry}`);
  }
  // The canonical hashing module is itself pure: node:crypto only, no engine.
  const hashing = parseModule('scripts/market-intelligence/definition.mjs');
  assert.deepEqual(hashing.found.importSources, ['node:crypto']);
  assert.deepEqual(hashing.found.dynamicImports, []);
  for (const consumer of ['engineDecisions', 'paperExecution', 'fitness', 'breeding',
    'championSelection', 'deploymentGate', 'liveEntryExit']) {
    assert.ok(PUBLIC_INTELLIGENCE_FORBIDDEN_CONSUMERS.includes(consumer), consumer);
  }
});
test('28 no import path from 5K.0 into Arena, promotion or champion selection', () => {
  for (const entry of importClosure(MODULE_REL)) {
    assert.ok(!/(^|\/)(arena|champions|hall-of-fame|promote|shadow)(\/|\.|$)/.test(entry),
      `Arena/promotion import: ${entry}`);
  }
  assert.equal(PUBLIC_INTELLIGENCE_CLASSIFICATION.arenaEligible, false);
  assert.equal(PUBLIC_INTELLIGENCE_CLASSIFICATION.promotionEligible, false);
  assert.equal(PUBLIC_INTELLIGENCE_PHASE_5K_0_SCOPE.affectsFitness, false);
  assert.equal(PUBLIC_INTELLIGENCE_PHASE_5K_0_SCOPE.affectsPromotion, false);
  assert.equal(PUBLIC_INTELLIGENCE_PHASE_5K_0_SCOPE.affectsChampionSelection, false);
  assert.equal(PUBLIC_INTELLIGENCE_PHASE_5K_0_SCOPE.createsDeploymentGate, false);
  // The direction is also closed: no live surface may import 5K.0.
  for (const consumer of ['scripts/evolve-engine.mjs', 'scripts/arena.mjs', 'scripts/champions.mjs',
    'scripts/jev-paper.mjs', 'scripts/evolve-governance.mjs', 'scripts/market-outcomes/primary-analysis.mjs']) {
    if (!existsSafe(path.join(REPO_ROOT, consumer))) continue;
    const { found } = parseModule(consumer);
    for (const source of [...found.importSources, ...found.dynamicImports]) {
      assert.ok(!/public-intelligence/.test(source), `${consumer} imports 5K.0: ${source}`);
    }
  }
});
test('29 R4 modules and evidence are not imported as mutable targets', () => {
  for (const entry of importClosure(MODULE_REL)) {
    assert.ok(!/(^|\/)(governance\/r4|market-outcomes|r4-[^/]*)(\/|\.|$)/.test(entry),
      `R4 module imported by 5K.0: ${entry}`);
  }
  assert.equal(PUBLIC_INTELLIGENCE_PHASE_5K_0_SCOPE.touchesR4Seal, false);
  for (const key of ['mayAlterR4Membership', 'mayAlterR4Outcomes', 'mayAlterR4Analysis',
    'mayAlterR4Interpretation', 'isHiddenR4SensitivityAnalysis', 'retroactivelyChangesR4Reading',
    'r4PositiveAssociationIsPermissionToAct']) {
    assert.equal(PUBLIC_INTELLIGENCE_R4_BOUNDARY[key], false, key);
  }
  assert.equal(PUBLIC_INTELLIGENCE_R4_BOUNDARY.r4Status, 'CLOSED');
  assert.equal(PUBLIC_INTELLIGENCE_R4_BOUNDARY.r4EvidenceIsDistinct, true);
  assert.equal(PUBLIC_INTELLIGENCE_R4_BOUNDARY.relationship, 'POST_R4');
});
test('30 no existing R4 artifact changes and HEAD descends from the R4 authority commit', () => {
  // The live-main C1 pin is released post-R4: HEAD may advance, but only as a descendant of C1.
  execFileSync('git', ['merge-base', '--is-ancestor', R4_HEAD, 'HEAD'], { cwd: REPO_ROOT });
  // The tracked R4 seal and the R4-bound manifest files are byte-identical to C1.
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
  // The 5K.0 files are new and untracked, which is the only permitted change.
  for (const created of ['docs/PHASE5K-PUBLIC-SOCIAL-INTELLIGENCE.md', MODULE_REL, 'scripts/validate-phase5k.mjs']) {
    assert.ok(existsSafe(path.join(REPO_ROOT, created)), `missing 5K.0 artifact: ${created}`);
  }
});
test('31 privacy scope, bounded collection and provider isolation are declared, not implemented', () => {
  // Public-data-only scope, with every prohibited capability named.
  for (const prohibited of ['PRIVATE_ACCOUNT_ACCESS', 'AUTHENTICATION_BYPASS', 'RESTRICTED_CONTENT_SCRAPING',
    'PRIVATE_MESSAGE_INGESTION', 'IDENTITY_ENRICHMENT', 'DEANONYMIZATION', 'CONTACT_DISCOVERY',
    'PRIVATE_PERSON_PROFILING', 'PRIVATE_KEY_USE', 'TRANSACTION_SUBMISSION']) {
    assert.ok(PUBLIC_INTELLIGENCE_SCOPE.prohibited.includes(prohibited), prohibited);
  }
  assert.equal(PUBLIC_INTELLIGENCE_SCOPE.publicDataOnly, true);
  assert.equal(PUBLIC_INTELLIGENCE_SCOPE.authenticationPermitted, false);
  // Bounded collection is declared as a required shape; 5K.0 collects nothing.
  for (const bound of PUBLIC_INTELLIGENCE_COLLECTION_BOUNDS.requiredBoundFields) {
    assert.equal(typeof bound, 'string', bound);
  }
  assert.equal(PUBLIC_INTELLIGENCE_COLLECTION_BOUNDS.unboundedCollectionPermitted, false);
  assert.equal(PUBLIC_INTELLIGENCE_COLLECTION_BOUNDS.implementedInPhase5K0, false);
  // Provider isolation: raw provider shapes never reach research calculations.
  assert.equal(PUBLIC_INTELLIGENCE_PROVIDER_ISOLATION.rawLeaksIntoResearchCalculations, false);
  assert.equal(PUBLIC_INTELLIGENCE_PROVIDER_ISOLATION.unknownFieldHandling, 'REJECT_UNKNOWN_FIELDS');
  // The canonical serialization used for every digest is the shared EVOLVE one.
  assert.equal(PUBLIC_INTELLIGENCE_GOVERNANCE.canonicalizationSource, 'scripts/market-intelligence/definition.mjs');
  assert.deepEqual(PUBLIC_INTELLIGENCE_GOVERNANCE.externalDependencies, []);
  assert.equal(canonical({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(MODULE_PATH.endsWith('scripts/public-intelligence/definition.mjs'), true);
});
test('32 validation writes only to temporary fixtures and leaves the tree unchanged', () => {
  const before = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
  const root = tempRoot();
  assert.ok(root.startsWith(tmpdir()), 'fixture root is a temp directory');
  for (const created of temporary) {
    assert.ok(!created.startsWith(REPO_ROOT), `temp fixture inside repo: ${created}`);
  }
  // Re-running the whole 5K.0 surface must not change any repository state.
  normalizeObservation(rawFixture());
  normalizeObservation(unassociatedFixture());
  sessionFingerprint({});
  verifyProvenance(normalizeObservation(rawFixture()), rawFixture());
  const after = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(after, before, 'repository status unchanged by validation');
});

async function run() {
  let failed = 0;
  try {
    for (const [name, fn] of tests) {
      try { await fn(); console.log(`PASS ${name}`); } catch (error) { failed++; console.error(`FAIL ${name}: ${error.stack}`); }
    }
  } finally { for (const root of temporary) rmSync(root, { recursive: true, force: true }); }
  console.log(`Phase 5K.0: ${tests.length - failed}/${tests.length} passed; offline, governance-only, no provider contact`);
  if (failed) process.exitCode = 1;
}

run().catch(error => { console.error('phase 5K.0 validator crashed:', error); process.exitCode = 1; });

