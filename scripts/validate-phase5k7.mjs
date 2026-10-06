#!/usr/bin/env node
// Phase 5K.7 - CROSS-PROVIDER CORROBORATION semantics validator.
//
// COMPLETELY OFFLINE AND DETERMINISTIC. Provider responses are in-memory
// fixtures handed to a transport through an injected fetch; every clock is an
// injected counter. The global fetch and the socket connect primitive are
// replaced with tripwires and the suite asserts neither was ever called. Every
// run root and snapshot root is a temporary directory; the repository tree,
// `var/` and `.evolve` are never written. No provider call is made here.
//
// IMPORT BOUNDARY
//
// Every 5K.x validator asserts that nothing OUTSIDE `scripts/public-intelligence/`
// imports a protected phase module, and those checks enumerate `git ls-files`, so
// a TRACKED validator that imports one directly breaks them. This validator
// therefore reaches every earlier phase through the existing governed surface
// and nothing else, and the protected fragment names it needs come from that
// surface, so this file never spells a protected module path.
import assert from 'node:assert/strict';
import net from 'node:net';
import {
  chmodSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

let tripwireCalls = 0;
globalThis.fetch = () => { tripwireCalls += 1; throw new Error('TRIPWIRE: validator attempted a real fetch'); };
net.Socket.prototype.connect = function tripwire() { tripwireCalls += 1; throw new Error('TRIPWIRE: validator attempted a socket connect'); };

// The ONE project import.
const SURFACE = await import('./public-intelligence/corroboration-validation-surface.mjs');

const DEF = SURFACE.CORROBORATION_DEFINITION_5K7;
const INDEX = SURFACE.CORROBORATION_INDEX_5K7;
const SNAP = SURFACE.CORROBORATION_SNAPSHOT_5K7;
const VERIFY = SURFACE.CORROBORATION_VERIFY_5K7;
const QUERY = SURFACE.CORROBORATION_QUERY_5K7;
const CLASSIFICATION = SURFACE.PUBLIC_INTELLIGENCE_CLASSIFICATION;
const canonical = SURFACE.canonical;
const digest = SURFACE.digest;
const rawObservationFingerprint = SURFACE.rawObservationFingerprint;
const { buildCollectionPlan, executeCollectionRun, loadRunArtifacts } = SURFACE;
const createBlueskyRunAdapter = SURFACE.createBlueskyRunAdapter;
const buildRevisionEvidence = SURFACE.buildRevisionEvidence;
const POLICY = SURFACE.PUBLIC_INTELLIGENCE_5K4_DEFAULT_POLICY;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PI = 'scripts/public-intelligence';
const R4_HEAD = '1c30264fb87876eeaf229e25c5cdc5adca429b40';
// The validators of Phases 5K.0-5K.5 predate the surface discipline and are
// exempt by their OWN phase rules; every later validator reaches earlier phases
// through a governed surface instead.
const HISTORICAL_VALIDATORS = [
  'scripts/validate-phase5k.mjs', 'scripts/validate-phase5k1.mjs', 'scripts/validate-phase5k2.mjs',
  'scripts/validate-phase5k3.mjs', 'scripts/validate-phase5k4.mjs', 'scripts/validate-phase5k5.mjs',
];
const PI_SURFACE = './public-intelligence/corroboration-validation-surface.mjs';
const require = createRequire(import.meta.url);
const espree = require('espree');

// ---------------------------------------------------------------------------
// HARNESS
// ---------------------------------------------------------------------------
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const temporary = [];
const tempRoot = label => {
  const root = mkdtempSync(path.join(tmpdir(), `evolve-5k7-${label}-`));
  temporary.push(root);
  return root;
};
const gitOut = (...args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
const refusal = (fn, fragment) => {
  let thrown = null;
  try { fn(); } catch (error) { thrown = error; }
  assert.ok(thrown, `expected refusal containing ${fragment}`);
  assert.ok(String(thrown.message).includes(fragment), `expected ${fragment}, got ${thrown.message}`);
};
const existsFile = candidate => { try { return statSync(candidate).isFile(); } catch { return false; } };
function parseModule(relative) {
  const source = readFileSync(path.join(REPO_ROOT, relative), 'utf8');
  const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const found = { identifiers: [], stringLiterals: [], importSources: [] };
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === 'Identifier') found.identifiers.push(node.name);
    if (node.type === 'Literal' && typeof node.value === 'string') found.stringLiterals.push(node.value);
    if (['ImportDeclaration', 'ExportAllDeclaration', 'ExportNamedDeclaration', 'ImportExpression'].includes(node.type) && node.source?.value) {
      found.importSources.push(node.source.value);
    }
    for (const value of Object.values(node)) if (value && typeof value === 'object') walk(value);
  };
  walk(ast);
  return { source, found };
}

// ---------------------------------------------------------------------------
// FIXTURES (structural only: no handle, name, bio or credential)
// ---------------------------------------------------------------------------
const MINT_A = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MINT_B = 'So11111111111111111111111111111111111111112';
const MINT_C = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const MINT_D = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const MINT_E = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';
const MINT_F = 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So';
const IDENTITY_TEXT_C = `same public text about ${MINT_C} on two platforms`;

const T1 = Date.parse('2026-10-01T10:00:00.000Z');
const T2 = Date.parse('2026-10-01T11:00:00.000Z');
const T3 = Date.parse('2026-10-01T12:00:00.000Z');
const T4 = Date.parse('2026-10-01T13:00:00.000Z');
const T5 = Date.parse('2026-10-01T14:00:00.000Z');
const SPAN = 86_400_000;
const BOUNDS = Object.freeze({ maxPages: 2, maxRecords: 20, timeoutMs: 10_000, maxResponseBytes: 524_288, maxLookbackMs: SPAN });
const ALPHA = 'alpha.example';
const BETA = 'beta.example';
const DID = 'did:plc:abcdefghijklmnopqrst';
const CID_A = 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CID_B = 'bafyreibbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const BSKY_URI_B = `at://${DID}/app.bsky.feed.post/3kbbbbbbbbb`;
const BSKY_URI_C = `at://${DID}/app.bsky.feed.post/3kccccccccc`;

const iso = ms => new Date(ms).toISOString();
const status = (id, { content, likes = 0, createdAt = T1 } = {}) => ({
  id: String(id), visibility: 'public', created_at: iso(createdAt), url: `https://${ALPHA}/@author/${id}`,
  in_reply_to_id: null, language: 'en', content: `<p>${content}</p>`, tags: [{ name: 'solana' }],
  favourites_count: likes, replies_count: 0, reblogs_count: 0, account: { id: '42' },
});
const postView = (uri, { text, cid = CID_A, likes = 0, createdAt = T1 } = {}) => ({
  $type: 'app.bsky.feed.defs#postView', uri, cid, author: { did: DID },
  record: { $type: 'app.bsky.feed.post', text, createdAt: iso(createdAt) },
  likeCount: likes, replyCount: 0, repostCount: 0, quoteCount: 0,
});

const makeClock = start => { let t = start; return () => { t += 10; return t; }; };
const pagedFetch = pages => {
  let calls = 0;
  return async () => {
    const page = pages[Math.min(calls, pages.length - 1)];
    calls += 1;
    return new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json' } });
  };
};
const mastodonPlan = (instance, createdAt) => buildCollectionPlan({
  instance, hashtag: 'solana', bounds: { ...BOUNDS }, collectionMode: 'OFFLINE_FIXTURE', createdAt,
});
const blueskyPlan = createdAt => buildCollectionPlan({
  provider: 'bluesky', term: 'solana', bounds: { ...BOUNDS }, collectionMode: 'OFFLINE_FIXTURE', createdAt,
});

/** Executes the whole fixture workspace once: four authenticated runs. */
async function buildWorkspace() {
  const root = tempRoot('ws');
  const run = async (plan, pages, start, adapter) => {
    const result = await executeCollectionRun(plan, {
      clock: makeClock(start), fetchImpl: pagedFetch(pages), outputRoot: root, ...(adapter ? { adapter } : {}),
    });
    assert.equal(result.verification.ok, true, JSON.stringify(result.verification.failures));
    return result;
  };
  // Run 1: Mastodon alpha. A, C, unassociated, D, E (likes 1), F (version 1).
  const alpha1 = await run(mastodonPlan(ALPHA, T1), [[
    status(1001, { content: `mint A ${MINT_A}`, createdAt: T1 }),
    status(1002, { content: IDENTITY_TEXT_C, createdAt: T1 }),
    status(1003, { content: 'plain post with no mint', createdAt: T1 }),
    status(1004, { content: `mint D ${MINT_D}`, createdAt: T1 }),
    status(1005, { content: `mint E ${MINT_E}`, likes: 1, createdAt: T1 }),
    status(1006, { content: `mint F ${MINT_F} version one`, likes: 1, createdAt: T1 }),
  ], []], T1);
  // Run 2: Mastodon beta. D only (two instances of one family).
  const beta = await run(mastodonPlan(BETA, T2), [[
    status(2001, { content: `mint D ${MINT_D}`, createdAt: T2 }),
  ], []], T2);
  // Run 3: Bluesky. B, and C with IDENTICAL text to the Mastodon C post.
  const bluesky = await run(blueskyPlan(T3), [
    { posts: [
      postView(BSKY_URI_B, { text: `mint B ${MINT_B}`, cid: CID_A, createdAt: T3 }),
      postView(BSKY_URI_C, { text: IDENTITY_TEXT_C, cid: CID_B, createdAt: T3 }),
    ], cursor: 'blueskyPageTwo1' },
    { posts: [] },
  ], T3, createBlueskyRunAdapter());
  // Run 4: Mastodon alpha again. C repeated, E engagement changed, F revised.
  const alpha2 = await run(mastodonPlan(ALPHA, T4), [[
    status(1002, { content: IDENTITY_TEXT_C, createdAt: T1 }),
    status(1005, { content: `mint E ${MINT_E}`, likes: 9, createdAt: T1 }),
    status(1006, { content: `mint F ${MINT_F} version two`, likes: 1, createdAt: T1 }),
  ], []], T4);
  // Provider-declared revision sidecar, bound to the exact 1006 evidence in run 4.
  const run4Raw = loadRunArtifacts(alpha2.directory).raw;
  const revised = run4Raw.find(raw => raw.providerObservationId === '1006');
  assert.ok(revised, 'the revised observation is present in run 4');
  const revisionEvidence = [buildRevisionEvidence({
    provider: revised.provider,
    providerObservationId: revised.providerObservationId,
    rawObservationFingerprint: rawObservationFingerprint(revised),
    editedAt: T4 + 5_000,
  })];
  const runIds = [alpha1.runId, beta.runId, bluesky.runId, alpha2.runId];
  const content = SNAP.rebuildCorroborationSnapshot({ root, runIds, policy: POLICY, revisionEvidence });
  const snapshot = SNAP.buildAndStoreCorroborationSnapshot({ root, runIds, policy: POLICY, revisionEvidence, createdAt: T5 });
  return {
    root, runIds, revisionEvidence, content, snapshot,
    directories: [alpha1, beta, bluesky, alpha2].map(result => result.directory),
  };
}

const WORKSPACE = await buildWorkspace();

/** Builds the corroboration content over the fixture workspace. */
function workspaceContent() {
  return WORKSPACE.content;
}

/** Synthetic temporal records, for the association states a provider run cannot produce. */
function syntheticRecord(identity, namespace, association, minutes = 0) {
  const fetchedAt = T1 + minutes * 60_000;
  return {
    contentRecord: { upstreamIdentity: identity, provider: namespace, assetAssociation: association },
    observationRecord: {
      upstreamIdentity: identity, provider: namespace, assetAssociation: association,
      contentFingerprint: digest({ identity, kind: 'synthetic-content' }).padEnd(64, '0').slice(0, 64),
      observationStateFingerprint: digest({ identity, kind: 'synthetic-state' }).padEnd(64, '0').slice(0, 64),
      fetchedAt, runId: `run-${'a'.repeat(32)}`,
    },
  };
}
function syntheticIndex(records) {
  return INDEX.buildCorroborationIndex(
    { contentRecords: records.map(record => record.contentRecord), observationRecords: records.map(record => record.observationRecord) },
    { sourceSnapshotIds: [`tsnap-${'a'.repeat(32)}`] },
  );
}
const EXACT = (mint) => ({ status: 'EXACT_MINT', mint, method: 'EXACT_MINT_ADDRESS' });
const NON_EXACT = status => ({ status, mint: null, method: 'UNASSOCIATED' });

// ===========================================================================
// A. GOVERNANCE
// ===========================================================================
test('A1 the phase identity is the governed 5K.7 vocabulary', () => {
  assert.equal(SURFACE.PUBLIC_INTELLIGENCE_5K7_PHASE, 'PHASE_5K_7');
  assert.equal(SURFACE.PUBLIC_INTELLIGENCE_5K7_SCHEMA_VERSION, '5K.7.0');
  assert.equal(SURFACE.PUBLIC_INTELLIGENCE_5K7_POLICY_VERSION, 'corroboration-policy-1');
});
test('A2 every artifact carries the frozen observer-only classification', () => {
  for (const flag of ['researchOnly', 'observerOnly', 'paperOnly', 'developmentOnly']) assert.equal(CLASSIFICATION[flag], true, flag);
  for (const flag of ['tradingAuthority', 'engineAuthority', 'arenaEligible', 'promotionEligible', 'profitabilityInferencePermitted']) {
    assert.equal(CLASSIFICATION[flag], false, flag);
  }
});
test('A3 the coverage semantics disclosure denies every judgement', () => {
  const S = DEF.PUBLIC_INTELLIGENCE_5K7_COVERAGE_SEMANTICS;
  for (const flag of ['readOnly', 'derivedLayer', 'subjectIsExactMintOnly']) assert.equal(S[flag], true, flag);
  for (const flag of ['scoreComputed', 'rankComputed', 'confidenceTierComputed', 'ordinalLevelAssigned', 'sentimentComputed',
    'momentumComputed', 'popularityComputed', 'importanceComputed', 'predictionMade', 'recommendationMade',
    'tradingInferenceMade', 'claimsTruthEvaluated', 'providerAgreementInferred', 'absenceInterpreted',
    'providerAgreementInferred', 'marketDataAccessed']) assert.equal(S[flag], false, flag);
});
test('A4 the coverage status vocabulary has exactly two values and no ordinal level', () => {
  assert.deepEqual([...SURFACE.PUBLIC_INTELLIGENCE_5K7_COVERAGE_STATUS_VALUES], ['SINGLE_PROVIDER_FAMILY', 'MULTI_PROVIDER_FAMILY']);
  for (const banned of ['LOW', 'MEDIUM', 'HIGH', 'NONE', 'WEAK', 'STRONG']) {
    assert.ok(!SURFACE.PUBLIC_INTELLIGENCE_5K7_COVERAGE_STATUS_VALUES.includes(banned), banned);
  }
});
test('A5 corroboration is defined strictly as presence in more than one provider namespace', () => {
  const semantics = DEF.PUBLIC_INTELLIGENCE_5K7_COVERAGE_SEMANTICS;
  assert.equal(semantics.crossProviderMergePerformed, false);
  assert.equal(semantics.underlyingEvidenceMergedAcrossProviders, false);
  assert.equal(semantics.providerAgreementInferred, false);
});
test('A6 the phase document exists and documents every required section and disclaimer', () => {
  const doc = readFileSync(path.join(REPO_ROOT, 'docs/PHASE5K7-CROSS-PROVIDER-CORROBORATION.md'), 'utf8').toLowerCase();
  for (const heading of ['purpose', 'corroboration definition', 'subject identity', 'provider family', 'provider namespace',
    'two mastodon instances', 'coverage status', 'single-provider-family', 'multi-provider-family', 'upstream observation accounting',
    'temporal and version accounting', 'missingness', 'coverage gaps', 'snapshot identity', 'query api', 'verification', 'privacy',
    'no market linkage', 'determinism', 'non-goals', 'coverage is not consensus', 'coverage is not importance',
    'coverage is not a signal', 'no trading inference is permitted']) {
    assert.ok(doc.includes(heading), `doc lacks "${heading}"`);
  }
});
test('A7 the phases 5K.0-5K.6 modules are untouched by 5K.7', () => {
  // 5K.7 may only ADD files: no earlier tracked file may be modified.
  const changed = gitOut('diff', '--name-only', 'HEAD').split('\n').filter(Boolean);
  for (const entry of changed) {
    assert.ok(!entry.startsWith(PI) || entry.includes('corroboration'), `an earlier module changed: ${entry}`);
  }
});
test('A8 the derivation is pure: no corroboration module reads a clock, environment or network', () => {
  for (const unit of SURFACE.PUBLIC_INTELLIGENCE_5K7_MODULES) {
    const relative = `${PI}/${unit}`;
    const { found, source } = parseModule(relative);
    assert.ok(!found.identifiers.includes('fetch'), `${unit} references fetch`);
    assert.ok(!/process\.env/.test(source), `${unit} reads the environment`);
    assert.ok(!/Date\.now/.test(source), `${unit} reads the clock`);
    for (const builtin of ['node:http', 'node:https', 'node:net', 'node:tls', 'node:dns', 'node:child_process']) {
      assert.ok(!found.importSources.includes(builtin), `${unit} imports ${builtin}`);
    }
  }
});

// ===========================================================================
// B. EXACT-MINT SUBJECT IDENTITY
// ===========================================================================
test('B1 only EXACT_MINT may participate in a cross-provider subject', () => {
  const S = DEF.PUBLIC_INTELLIGENCE_5K7_SUBJECT_IDENTITY;
  assert.deepEqual([...S.associationsThatMayParticipate], ['EXACT_MINT']);
  assert.deepEqual([...S.associationsThatMayNeverParticipate], ['UNASSOCIATED', 'INVALID_MINT', 'AMBIGUOUS']);
});
test('B2 every rejected equivalence signal is named, and fuzzy matching is refused', () => {
  const S = DEF.PUBLIC_INTELLIGENCE_5K7_SUBJECT_IDENTITY;
  for (const signal of ['TICKER', 'SYMBOL', 'CASHTAG', 'HASHTAG', 'PROJECT_NAME', 'PROFILE_IDENTITY', 'DOMAIN', 'URL',
    'SIMILAR_TEXT', 'EMBEDDING_SIMILARITY', 'FUZZY_MATCHING']) {
    assert.ok(S.rejectedEquivalenceSignals.includes(signal), signal);
  }
  assert.equal(S.forceMatchPermitted, false);
  assert.equal(S.mintInferencePermitted, false);
});
test('B3 an UNASSOCIATED observation produces no coverage record', () => {
  const index = syntheticIndex([syntheticRecord('mastodon:alpha.example:9001', 'mastodon:alpha.example', NON_EXACT('UNASSOCIATED'))]);
  assert.equal(index.coverageRecords.length, 0);
  assert.equal(index.aggregate.exactMintCount, 0);
  assert.equal(index.aggregate.unassociatedObservationCount, 1);
});
test('B4 an INVALID_MINT observation produces no coverage record', () => {
  const index = syntheticIndex([syntheticRecord('mastodon:alpha.example:9002', 'mastodon:alpha.example', NON_EXACT('INVALID_MINT'))]);
  assert.equal(index.coverageRecords.length, 0);
  assert.equal(index.aggregate.invalidMintObservationCount, 1);
});
test('B5 an AMBIGUOUS observation produces no coverage record', () => {
  const index = syntheticIndex([syntheticRecord('mastodon:alpha.example:9003', 'mastodon:alpha.example', NON_EXACT('AMBIGUOUS'))]);
  assert.equal(index.coverageRecords.length, 0);
  assert.equal(index.aggregate.ambiguousObservationCount, 1);
});
test('B6 non-exact evidence can never be promoted to an exact subject', () => {
  const index = syntheticIndex([
    syntheticRecord('mastodon:alpha.example:9101', 'mastodon:alpha.example', NON_EXACT('INVALID_MINT')),
    syntheticRecord('mastodon:beta.example:9102', 'mastodon:beta.example', NON_EXACT('AMBIGUOUS')),
  ]);
  assert.equal(index.aggregate.exactMintCount, 0);
  assert.deepEqual([...index.observationCoverageRecords].map(record => record.associationStatus).sort(), ['AMBIGUOUS', 'INVALID_MINT']);
});
test('B7 the mint in a coverage record is the exact string on the evidence', () => {
  const index = syntheticIndex([syntheticRecord('mastodon:alpha.example:1', 'mastodon:alpha.example', EXACT(MINT_A))]);
  assert.equal(index.coverageRecords[0].mint, MINT_A);
});
test('B8 a differently-cased mint is a different subject, never a match', () => {
  const lower = MINT_A.toLowerCase();
  const index = syntheticIndex([
    syntheticRecord('mastodon:alpha.example:1', 'mastodon:alpha.example', EXACT(MINT_A)),
    syntheticRecord('mastodon:beta.example:2', 'mastodon:beta.example', EXACT(lower)),
  ]);
  assert.equal(index.coverageRecords.length, 2, 'case is not folded');
  assert.notEqual(index.coverageRecords[0].mint, index.coverageRecords[1].mint);
});
test('B9 an exact-mint observation carries a non-null mint on its coverage record', () => {
  const record = syntheticIndex([syntheticRecord('mastodon:alpha.example:1', 'mastodon:alpha.example', EXACT(MINT_B))]).coverageRecords[0];
  assert.equal(typeof record.mint, 'string');
  assert.ok(record.mint.length > 0);
});
test('B10 the temporal index feeds the subject rule without inference', () => {
  const content = workspaceContent();
  const mintA = content.coverageRecords.find(record => record.mint === MINT_A);
  assert.ok(mintA, 'mint A is present');
  assert.equal(mintA.upstreamObservationCount, 1);
});

// ===========================================================================
// C. PROVIDER-FAMILY DERIVATION
// ===========================================================================
test('C1 the governed family registry is a closed sorted allowlist', () => {
  assert.deepEqual([...SURFACE.PUBLIC_INTELLIGENCE_5K7_PROVIDER_FAMILIES], ['bluesky', 'mastodon']);
});
test('C2 the family of a namespace is the segment before the first separator', () => {
  assert.equal(DEF.providerFamilyOf('mastodon:alpha.example'), 'mastodon');
  assert.equal(DEF.providerFamilyOf('mastodon:beta.example'), 'mastodon');
  assert.equal(DEF.providerFamilyOf('bluesky:public-appview'), 'bluesky');
});
test('C3 an unknown family fails closed with no fallback', () => {
  refusal(() => DEF.providerFamilyOf('twitter:api'), 'PROVIDER_FAMILY_UNKNOWN');
  refusal(() => DEF.providerFamilyOf('unknown:thing'), 'PROVIDER_FAMILY_UNKNOWN');
});
test('C4 a malformed or unscoped namespace is refused', () => {
  refusal(() => DEF.providerFamilyOf('mastodon'), 'NAMESPACE_MALFORMED');
  refusal(() => DEF.providerFamilyOf('mastodon:'), 'SCOPE_MISSING');
  refusal(() => DEF.providerFamilyOf(''), 'NAMESPACE_INVALID');
  refusal(() => DEF.providerFamilyOf(123), 'NAMESPACE_INVALID');
});
test('C5 the governed predicate accepts only governed namespaces', () => {
  assert.equal(SURFACE.isGovernedProviderNamespace('mastodon:alpha.example'), true);
  assert.equal(SURFACE.isGovernedProviderNamespace('bluesky:public-appview'), true);
  assert.equal(SURFACE.isGovernedProviderNamespace('reddit:api'), false);
});
test('C6 independence is defined by family and never by time', () => {
  const I = DEF.PUBLIC_INTELLIGENCE_5K7_INDEPENDENCE;
  assert.equal(I.independenceUnit, 'PROVIDER_FAMILY');
  assert.equal(I.familySeparatesCrossPlatformCoverage, true);
  assert.equal(I.timeSeparationImpliesIndependence, false);
  assert.equal(I.mergesUnderlyingEvidence, false);
});

// ===========================================================================
// D. PROVIDER-NAMESPACE DERIVATION
// ===========================================================================
test('D1 the scope of a namespace is the segment after the first separator', () => {
  assert.equal(DEF.providerNamespaceScopeOf('mastodon:alpha.example'), 'alpha.example');
  assert.equal(DEF.providerNamespaceScopeOf('bluesky:public-appview'), 'public-appview');
});
test('D2 two Mastodon instances are two namespaces of one family', () => {
  assert.equal(DEF.providerFamilyOf('mastodon:alpha.example'), DEF.providerFamilyOf('mastodon:beta.example'));
  assert.notEqual(DEF.providerNamespaceScopeOf('mastodon:alpha.example'), DEF.providerNamespaceScopeOf('mastodon:beta.example'));
});
test('D3 Mastodon and Bluesky are two distinct families', () => {
  assert.notEqual(DEF.providerFamilyOf('mastodon:alpha.example'), DEF.providerFamilyOf('bluesky:public-appview'));
});
test('D4 a coverage record lists sorted unique namespaces and their families', () => {
  const record = syntheticIndex([
    syntheticRecord('mastodon:beta.example:1', 'mastodon:beta.example', EXACT(MINT_A), 1),
    syntheticRecord('mastodon:alpha.example:2', 'mastodon:alpha.example', EXACT(MINT_A)),
  ]).coverageRecords[0];
  assert.deepEqual([...record.providerNamespaces], ['mastodon:alpha.example', 'mastodon:beta.example']);
  assert.deepEqual([...record.providerFamilies], ['mastodon']);
});
test('D5 the family list is exactly the projection of the namespace list', () => {
  const record = syntheticIndex([
    syntheticRecord('mastodon:alpha.example:1', 'mastodon:alpha.example', EXACT(MINT_A)),
    syntheticRecord(`bluesky:public-appview:${BSKY_URI_C}`, 'bluesky:public-appview', EXACT(MINT_A), 1),
  ]).coverageRecords[0];
  assert.deepEqual([...record.providerFamilies], ['bluesky', 'mastodon']);
});
test('D6 an ungoverned namespace in the evidence is a hard refusal, never a guess', () => {
  refusal(() => syntheticIndex([syntheticRecord('future:thing:1', 'future:thing', EXACT(MINT_A))]), 'PROVIDER_FAMILY_UNKNOWN');
});

// ===========================================================================
// E. SINGLE-PROVIDER-FAMILY COVERAGE
// ===========================================================================
test('E1 one observation on one family is SINGLE_PROVIDER_FAMILY', () => {
  const record = syntheticIndex([syntheticRecord('mastodon:alpha.example:1', 'mastodon:alpha.example', EXACT(MINT_A))]).coverageRecords[0];
  assert.equal(record.coverageStatus, 'SINGLE_PROVIDER_FAMILY');
  assert.equal(record.providerFamilyCount, 1);
  assert.equal(record.providerNamespaceCount, 1);
});
test('E2 two observations on the SAME Mastodon instance are still SINGLE', () => {
  const index = syntheticIndex([
    syntheticRecord('mastodon:alpha.example:1', 'mastodon:alpha.example', EXACT(MINT_A)),
    syntheticRecord('mastodon:alpha.example:2', 'mastodon:alpha.example', EXACT(MINT_A), 1),
  ]);
  assert.equal(index.coverageRecords[0].coverageStatus, 'SINGLE_PROVIDER_FAMILY');
  assert.equal(index.coverageRecords[0].upstreamObservationCount, 2);
});
test('E3 TWO Mastodon instances are SINGLE_PROVIDER_FAMILY with namespaceCount 2', () => {
  const record = syntheticIndex([
    syntheticRecord('mastodon:alpha.example:1', 'mastodon:alpha.example', EXACT(MINT_D)),
    syntheticRecord('mastodon:beta.example:2', 'mastodon:beta.example', EXACT(MINT_D), 1),
  ]).coverageRecords[0];
  assert.equal(record.providerNamespaceCount, 2);
  assert.equal(record.providerFamilyCount, 1);
  assert.equal(record.coverageStatus, 'SINGLE_PROVIDER_FAMILY');
});
test('E4 the run-level mint D is single-family and NOT cross-family corroborated', () => {
  const record = WORKSPACE.content.coverageRecords.find(entry => entry.mint === MINT_D);
  assert.equal(record.providerNamespaceCount, 2);
  assert.equal(record.providerFamilyCount, 1);
  assert.equal(record.coverageStatus, 'SINGLE_PROVIDER_FAMILY');
  assert.deepEqual([...record.providerFamilies], ['mastodon']);
});
test('E5 the run-level mint A is single-family (Mastodon only)', () => {
  const record = WORKSPACE.content.coverageRecords.find(entry => entry.mint === MINT_A);
  assert.equal(record.coverageStatus, 'SINGLE_PROVIDER_FAMILY');
  assert.deepEqual([...record.providerFamilies], ['mastodon']);
});
test('E6 the run-level mint B is single-family (Bluesky only)', () => {
  const record = WORKSPACE.content.coverageRecords.find(entry => entry.mint === MINT_B);
  assert.equal(record.coverageStatus, 'SINGLE_PROVIDER_FAMILY');
  assert.deepEqual([...record.providerFamilies], ['bluesky']);
});
test('E7 a single-family mint is never counted as multi-family', () => {
  const aggregate = workspaceContent().aggregate;
  assert.equal(aggregate.multiProviderFamilyMintCount, 1);
  assert.equal(aggregate.singleProviderFamilyMintCount, aggregate.exactMintCount - 1);
});
test('E8 the coverage status is derived, and a forged status is refused', () => {
  const record = syntheticIndex([syntheticRecord('mastodon:alpha.example:1', 'mastodon:alpha.example', EXACT(MINT_A))]).coverageRecords[0];
  refusal(() => INDEX.validateCoverageRecord({ ...record, coverageStatus: 'MULTI_PROVIDER_FAMILY' }), 'STATUS_NE_FAMILY_COUNT');
});

// ===========================================================================
// F. MULTI-PROVIDER-FAMILY COVERAGE
// ===========================================================================
test('F1 two families on one mint is MULTI_PROVIDER_FAMILY', () => {
  const record = syntheticIndex([
    syntheticRecord('mastodon:alpha.example:1', 'mastodon:alpha.example', EXACT(MINT_C)),
    syntheticRecord(`bluesky:public-appview:${BSKY_URI_C}`, 'bluesky:public-appview', EXACT(MINT_C), 1),
  ]).coverageRecords[0];
  assert.equal(record.coverageStatus, 'MULTI_PROVIDER_FAMILY');
  assert.equal(record.providerFamilyCount, 2);
  assert.equal(record.providerNamespaceCount, 2);
});
test('F2 the run-level mint C is multi-family across Mastodon and Bluesky', () => {
  const record = WORKSPACE.content.coverageRecords.find(entry => entry.mint === MINT_C);
  assert.equal(record.coverageStatus, 'MULTI_PROVIDER_FAMILY');
  assert.deepEqual([...record.providerFamilies], ['bluesky', 'mastodon']);
  assert.equal(record.upstreamObservationCount, 2);
});
test('F3 identical text on two providers does NOT merge the evidence', () => {
  const record = WORKSPACE.content.coverageRecords.find(entry => entry.mint === MINT_C);
  assert.equal(record.upstreamObservationCount, 2, 'two provider-scoped upstream observations');
  assert.equal(new Set(record.upstreamObservationIdentities).size, 2);
});
test('F4 identical text on two providers still counts as two families', () => {
  const record = WORKSPACE.content.coverageRecords.find(entry => entry.mint === MINT_C);
  assert.equal(record.providerFamilyCount, 2);
});
test('F5 a multi-family record lists both families once each', () => {
  const record = WORKSPACE.content.coverageRecords.find(entry => entry.mint === MINT_C);
  assert.deepEqual([...record.providerFamilies], [...new Set(record.providerFamilies)]);
  assert.equal(record.providerFamilies.length, 2);
});
test('F6 the multi-family count is exactly one in the fixture', () => {
  assert.equal(WORKSPACE.content.aggregate.multiProviderFamilyMintCount, 1);
});
test('F7 the query layer lists exactly the multi-family mints', () => {
  const query = QUERY.createCorroborationQuery(SNAP.loadCorroborationArtifacts(WORKSPACE.snapshot.directory));
  assert.deepEqual([...query.listMultiProviderFamilyMints()], [MINT_C]);
});
test('F8 the multi-family mint is absent from the single-family list', () => {
  const single = QUERY.createCorroborationQuery(SNAP.loadCorroborationArtifacts(WORKSPACE.snapshot.directory)).listSingleProviderFamilyMints();
  assert.ok(!single.includes(MINT_C));
});

// ===========================================================================
// G. UPSTREAM OBSERVATION ACCOUNTING
// ===========================================================================
test('G1 a post seen in several runs is one upstream observation', () => {
  const record = WORKSPACE.content.coverageRecords.find(entry => entry.mint === MINT_C);
  assert.equal(record.upstreamObservationCount, 2, 'one Mastodon identity and one Bluesky identity');
});
test('G2 an upstream observation repeated across runs is not double-counted', () => {
  const record = WORKSPACE.content.coverageRecords.find(entry => entry.mint === MINT_A);
  assert.equal(record.upstreamObservationCount, 1);
});
test('G3 the repeated observation appears in several member runs', () => {
  const record = WORKSPACE.content.coverageRecords.find(entry => entry.mint === MINT_C);
  assert.ok(record.memberRunIds.length >= 2, JSON.stringify(record.memberRunIds));
});
test('G4 the coverage record carries the exact upstream identity strings', () => {
  const record = WORKSPACE.content.coverageRecords.find(entry => entry.mint === MINT_C);
  assert.ok(record.upstreamObservationIdentities.includes(`mastodon:${ALPHA}:1002`));
  assert.ok(record.upstreamObservationIdentities.includes(`bluesky:public-appview:${BSKY_URI_C}`));
});
test('G5 upstream observation identities are sorted and unique', () => {
  for (const record of WORKSPACE.content.coverageRecords) {
    assert.deepEqual([...record.upstreamObservationIdentities], [...new Set(record.upstreamObservationIdentities)].sort(), record.mint);
  }
});
test('G6 two instances of one family are two namespaces in the observation count', () => {
  const record = WORKSPACE.content.coverageRecords.find(entry => entry.mint === MINT_D);
  assert.equal(record.upstreamObservationCount, 2);
  assert.deepEqual([...record.providerNamespaces], [`mastodon:${ALPHA}`, `mastodon:${BETA}`]);
});
test('G7 the aggregate upstream identity count equals the observation coverage records', () => {
  const content = WORKSPACE.content;
  assert.equal(content.aggregate.upstreamIdentityCount, content.observationCoverageRecords.length);
});
test('G8 the missingness partition exhausts the upstream identities', () => {
  const A = WORKSPACE.content.aggregate;
  assert.equal(A.exactMintObservationCount + A.unassociatedObservationCount + A.invalidMintObservationCount + A.ambiguousObservationCount,
    A.upstreamIdentityCount);
});

// ===========================================================================
// H. TEMPORAL / VERSION / STATE ACCOUNTING
// ===========================================================================
test('H1 a revised post yields two authenticated content versions', () => {
  const record = WORKSPACE.content.coverageRecords.find(entry => entry.mint === MINT_F);
  assert.equal(record.contentVersionCount, 2);
});
test('H2 a repeated identical observation yields one content version', () => {
  const record = WORKSPACE.content.coverageRecords.find(entry => entry.mint === MINT_C);
  assert.equal(record.contentVersionCount, 2, 'one version per provider-scoped observation');
});
test('H3 an engagement-state change yields two state snapshots for the same content', () => {
  const record = WORKSPACE.content.coverageRecords.find(entry => entry.mint === MINT_E);
  assert.equal(record.observationStateSnapshotCount, 2);
  assert.equal(record.contentVersionCount, 1);
});
test('H4 an unchanged repeat yields one state snapshot', () => {
  const record = WORKSPACE.content.coverageRecords.find(entry => entry.mint === MINT_A);
  assert.equal(record.observationStateSnapshotCount, 1);
});
test('H5 firstObservedAt and lastObservedAt come from authenticated acquisition instants', () => {
  const record = WORKSPACE.content.coverageRecords.find(entry => entry.mint === MINT_C);
  // The earliest contribution is from the first run and the latest from the
  // fourth: deterministic from the injected clocks, never from the wall clock.
  assert.ok(record.firstObservedAt >= T1 && record.firstObservedAt < T2, String(record.firstObservedAt));
  assert.ok(record.lastObservedAt >= T4 && record.lastObservedAt < T5, String(record.lastObservedAt));
  assert.ok(record.firstObservedAt < record.lastObservedAt);
});
test('H6 the observed window is never inverted', () => {
  for (const record of WORKSPACE.content.coverageRecords) assert.ok(record.firstObservedAt <= record.lastObservedAt, record.mint);
});
test('H7 the version count is at least the distinct-identity count per mint', () => {
  for (const record of WORKSPACE.content.coverageRecords) {
    assert.ok(record.contentVersionCount >= 1, record.mint);
  }
});
test('H8 the state snapshot count is a positive integer for every coverage record', () => {
  for (const record of WORKSPACE.content.coverageRecords) {
    assert.ok(Number.isSafeInteger(record.observationStateSnapshotCount) && record.observationStateSnapshotCount >= 1, record.mint);
  }
});

// ===========================================================================
// I. MISSINGNESS AND COVERAGE GAPS
// ===========================================================================
test('I1 an unassociated post appears in observation coverage but in no coverage record', () => {
  const content = WORKSPACE.content;
  const unassociated = content.observationCoverageRecords.filter(record => record.associationStatus === 'UNASSOCIATED');
  assert.equal(unassociated.length, 1);
  assert.equal(content.aggregate.unassociatedObservationCount, 1);
});
test('I2 the unassociated observation is listed by the query layer', () => {
  const query = QUERY.createCorroborationQuery(SNAP.loadCorroborationArtifacts(WORKSPACE.snapshot.directory));
  const listed = query.listUnassociatedCoverage();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].associationStatus, 'UNASSOCIATED');
  assert.equal(listed[0].exactMint, null);
});
test('I3 the gap view names the governed families with and without evidence', () => {
  const query = QUERY.createCorroborationQuery(SNAP.loadCorroborationArtifacts(WORKSPACE.snapshot.directory));
  const gaps = query.listCoverageGaps();
  assert.deepEqual([...gaps.providerFamiliesWithExactMintEvidence], ['bluesky', 'mastodon']);
  assert.deepEqual([...gaps.providerFamiliesWithoutExactMintEvidence], []);
});
test('I4 the gap view reports mints with no evidence from one family', () => {
  const gaps = QUERY.createCorroborationQuery(SNAP.loadCorroborationArtifacts(WORKSPACE.snapshot.directory)).listCoverageGaps();
  assert.ok(gaps.mintsWithoutMastodonEvidence.includes(MINT_B));
  assert.ok(gaps.mintsWithoutBlueskyEvidence.includes(MINT_A));
});
test('I5 absence from one provider is never interpreted as absence', () => {
  const gaps = QUERY.createCorroborationQuery(SNAP.loadCorroborationArtifacts(WORKSPACE.snapshot.directory)).listCoverageGaps();
  assert.equal(gaps.absenceImpliesAbsence, false);
  assert.equal(gaps.gapInterpreted, false);
  assert.equal(gaps.gapScored, false);
});
test('I6 invalid-mint evidence is represented as coverage state and never exact', () => {
  const index = syntheticIndex([syntheticRecord('mastodon:alpha.example:9200', 'mastodon:alpha.example', NON_EXACT('INVALID_MINT'))]);
  assert.equal(index.observationCoverageRecords[0].associationStatus, 'INVALID_MINT');
  assert.equal(index.observationCoverageRecords[0].exactMint, null);
  assert.equal(index.aggregate.invalidMintObservationCount, 1);
});
test('I7 ambiguous evidence is represented as coverage state and never exact', () => {
  const index = syntheticIndex([syntheticRecord('mastodon:alpha.example:9201', 'mastodon:alpha.example', NON_EXACT('AMBIGUOUS'))]);
  assert.equal(index.observationCoverageRecords[0].associationStatus, 'AMBIGUOUS');
  assert.equal(index.observationCoverageRecords[0].exactMint, null);
  assert.equal(index.aggregate.ambiguousObservationCount, 1);
});
test('I8 a snapshot with no exact-mint evidence is classified NO_EXACT_MINT_EVIDENCE', () => {
  const index = syntheticIndex([syntheticRecord('mastodon:alpha.example:9300', 'mastodon:alpha.example', NON_EXACT('UNASSOCIATED'))]);
  assert.equal(SURFACE.snapshotCoverageClassificationFor(index.aggregate.exactMintCount), 'NO_EXACT_MINT_EVIDENCE');
});
test('I9 a snapshot with exact-mint evidence is classified HAS_EXACT_MINT_EVIDENCE', () => {
  assert.equal(WORKSPACE.snapshot.manifest.coverageClassification, 'HAS_EXACT_MINT_EVIDENCE');
  assert.equal(SURFACE.snapshotCoverageClassificationFor(0), 'NO_EXACT_MINT_EVIDENCE');
});

// ===========================================================================
// J. SNAPSHOT IDENTITY
// ===========================================================================
test('J1 the snapshot identity is deterministic from the run manifest fingerprints and policy', () => {
  const fingerprints = WORKSPACE.content.memberships.map(member => member.runManifestFingerprint);
  const first = SNAP.deriveCorroborationSnapshotId(POLICY, fingerprints);
  const second = SNAP.deriveCorroborationSnapshotId(POLICY, [...fingerprints].reverse());
  assert.equal(first, second, 'run order does not participate');
  assert.match(first, /^crsnap-[0-9a-f]{32}$/);
  refusal(() => SNAP.deriveCorroborationSnapshotId(POLICY, ['nope']), 'FINGERPRINT_INVALID');
});
test('J2 createdAt does not participate in the snapshot identity', () => {
  const manifest = SNAP.buildSnapshotManifest(WORKSPACE.content, T5);
  const manifestLater = SNAP.buildSnapshotManifest(WORKSPACE.content, T5 + 1000);
  assert.equal(manifest.snapshotId, manifestLater.snapshotId);
  assert.notEqual(manifest.snapshotFingerprint, manifestLater.snapshotFingerprint, 'the fingerprint covers createdAt');
  assert.equal(manifest.snapshotId, WORKSPACE.snapshot.snapshotId);
});
test('J3 the manifest records the source temporal snapshot identity and fingerprint', () => {
  const manifest = WORKSPACE.snapshot.manifest;
  assert.match(manifest.sourceTemporalSnapshotId, /^tsnap-[0-9a-f]{32}$/);
  assert.match(manifest.sourceTemporalFingerprint, /^[0-9a-f]{64}$/);
  assert.match(manifest.sourceCorpusFingerprint, /^[0-9a-f]{64}$/);
});
test('J4 the manifest records the sorted member run set', () => {
  const manifest = WORKSPACE.snapshot.manifest;
  assert.deepEqual([...manifest.memberRunIds], [...manifest.memberRunIds].sort());
  assert.equal(manifest.memberRunIds.length, 4);
  assert.equal(manifest.sourceRunManifestFingerprints.length, 4);
});
test('J5 the snapshot fingerprint covers the whole artifact', () => {
  const manifest = WORKSPACE.snapshot.manifest;
  assert.equal(manifest.snapshotFingerprint, SNAP.corroborationSnapshotFingerprintOf(manifest));
});
test('J6 the records digest authenticates the coverage records', () => {
  const loaded = SNAP.loadCorroborationArtifacts(WORKSPACE.snapshot.directory);
  assert.equal(loaded.manifest.recordsDigest, digest(loaded.coverageRecords));
  assert.equal(loaded.manifest.observationCoverageDigest, digest(loaded.observationCoverageRecords));
});
test('J7 the coverage digest authenticates the aggregate', () => {
  assert.equal(WORKSPACE.snapshot.manifest.coverageDigest, digest(WORKSPACE.content.aggregate));
});
test('J8 re-storing the same source set is idempotent and order-independent', () => {
  const first = SNAP.buildAndStoreCorroborationSnapshot({ root: WORKSPACE.root, runIds: WORKSPACE.runIds, policy: POLICY, revisionEvidence: WORKSPACE.revisionEvidence, createdAt: T5 });
  const second = SNAP.buildAndStoreCorroborationSnapshot({ root: WORKSPACE.root, runIds: [...WORKSPACE.runIds].reverse(), policy: POLICY, revisionEvidence: WORKSPACE.revisionEvidence, createdAt: T5 + 5 });
  assert.equal(first.snapshotId, WORKSPACE.snapshot.snapshotId);
  assert.equal(first.outcome, 'ALREADY_EXISTS_IDENTICAL');
  assert.equal(second.snapshotId, first.snapshotId);
  assert.equal(second.outcome, 'ALREADY_EXISTS_IDENTICAL');
});
test('J9 the snapshot count invariants hold', () => {
  assert.deepEqual(SNAP.checkSnapshotCounts(WORKSPACE.snapshot.manifest), []);
});
test('J10 a malformed snapshot id is refused', () => {
  refusal(() => SNAP.corroborationCorporaDirectoryOf(WORKSPACE.root, 'crsnap-not-hex'), 'SNAPSHOT_ID_INVALID');
});

// ===========================================================================
// K. QUERY API
// ===========================================================================
const loadedSnapshot = SNAP.loadCorroborationArtifacts(WORKSPACE.snapshot.directory);
const queryLayer = QUERY.createCorroborationQuery(loadedSnapshot);
test('K1 the query API is exactly the governed read-only surface', () => {
  assert.deepEqual([...SURFACE.PUBLIC_INTELLIGENCE_5K7_QUERY_API], [
    'getCoverageForExactMint', 'listMultiProviderFamilyMints', 'listSingleProviderFamilyMints',
    'listProviderFamiliesForMint', 'listProviderNamespacesForMint', 'listUpstreamObservationsForMint',
    'getCoverageSummary', 'listUnassociatedCoverage', 'listCoverageGaps',
  ]);
  for (const name of SURFACE.PUBLIC_INTELLIGENCE_5K7_QUERY_API) assert.equal(typeof queryLayer[name], 'function', name);
});
test('K2 the query layer exposes exactly the governed names and nothing else', () => {
  assert.deepEqual(Object.keys(queryLayer).sort(), [...SURFACE.PUBLIC_INTELLIGENCE_5K7_QUERY_API].sort());
});
test('K3 getCoverageForExactMint returns the record for an exact mint', () => {
  const record = queryLayer.getCoverageForExactMint(MINT_D);
  assert.equal(record.mint, MINT_D);
  assert.equal(record.coverageStatus, 'SINGLE_PROVIDER_FAMILY');
});
test('K4 getCoverageForExactMint returns null for an unknown mint', () => {
  assert.equal(queryLayer.getCoverageForExactMint('11111111111111111111111111111111'), null);
});
test('K5 getCoverageForExactMint requires a mint string', () => {
  refusal(() => queryLayer.getCoverageForExactMint(''), 'MINT_REQUIRED');
  refusal(() => queryLayer.getCoverageForExactMint(null), 'MINT_REQUIRED');
});
test('K6 listProviderFamiliesForMint and listProviderNamespacesForMint agree with the record', () => {
  assert.deepEqual([...queryLayer.listProviderFamiliesForMint(MINT_C)], ['bluesky', 'mastodon']);
  assert.deepEqual([...queryLayer.listProviderNamespacesForMint(MINT_C)], [`bluesky:public-appview`, `mastodon:${ALPHA}`]);
});
test('K7 listProviderFamiliesForMint returns an empty list for an unknown mint', () => {
  assert.deepEqual([...queryLayer.listProviderFamiliesForMint('11111111111111111111111111111111')], []);
});
test('K8 listUpstreamObservationsForMint returns the provider-scoped identities', () => {
  const identities = queryLayer.listUpstreamObservationsForMint(MINT_D);
  assert.deepEqual([...identities], [`mastodon:${ALPHA}:1004`, `mastodon:${BETA}:2001`]);
});
test('K9 getCoverageSummary reports counts and denies judgement', () => {
  const summary = queryLayer.getCoverageSummary();
  assert.equal(summary.exactMintCount, 6);
  assert.equal(summary.multiProviderFamilyMintCount, 1);
  assert.equal(summary.scoringApplied, false);
  assert.equal(summary.rankingApplied, false);
  assert.equal(summary.confidenceTierAssigned, false);
});
test('K10 no prohibited query name is exported', () => {
  for (const banned of DEF.PUBLIC_INTELLIGENCE_5K7_PROHIBITED_QUERY_NAMES) {
    assert.ok(!SURFACE.PUBLIC_INTELLIGENCE_5K7_QUERY_API.includes(banned), banned);
    assert.equal(Object.hasOwn(queryLayer, banned), false, banned);
  }
});
test('K11 no query name carries prohibited judgement vocabulary', () => {
  const banned = /^(rank|score|sort|recommend|predict|forecast|select|weight|tier|signal|strength|momentum|confidence)/i;
  for (const name of SURFACE.PUBLIC_INTELLIGENCE_5K7_QUERY_API) assert.ok(!banned.test(name), name);
});
test('K12 opening a snapshot requires it to verify first', () => {
  const opened = QUERY.openVerifiedCorroboration(WORKSPACE.root, WORKSPACE.snapshot.snapshotId);
  assert.equal(typeof opened.getCoverageSummary, 'function');
  refusal(() => QUERY.openVerifiedCorroboration(WORKSPACE.root, `crsnap-${'b'.repeat(32)}`), 'NOT_VERIFIED');
});
test('K13 a query result is frozen and cannot be mutated in place', () => {
  const record = queryLayer.getCoverageForExactMint(MINT_C);
  assert.ok(Object.isFrozen(record));
  assert.throws(() => { 'use strict'; record.mint = 'x'; });
});

// ===========================================================================
// L. TAMPER DETECTION
// ===========================================================================
const coverageFileName = SNAP.PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_FILES.coverage;
const observationCoverageFileName = SNAP.PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_FILES.observationCoverage;
const manifestFileName = SNAP.PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_FILES.snapshot;

function withTamperedFile(directory, fileName, transform, fn) {
  const target = path.join(directory, fileName);
  const original = readFileSync(target, 'utf8');
  chmodSync(target, 0o644);
  writeFileSync(target, transform(original), 'utf8');
  try { return fn(); } finally {
    writeFileSync(target, original, 'utf8');
    chmodSync(target, 0o444);
  }
}
const verifyStored = () => VERIFY.verifyCorroborationSnapshot(WORKSPACE.root, WORKSPACE.snapshot.snapshotId);
const expectTamperFails = (result, fragment) => {
  assert.equal(result.ok, false, 'tamper was not detected');
  assert.ok(result.failures.some(code => code.includes(fragment)), `expected ${fragment}, got ${JSON.stringify(result.failures)}`);
};
const mutateCoverage = (mutator) => original => {
  const records = original.split('\n').filter(Boolean).map(line => JSON.parse(line));
  mutator(records);
  return `${records.map(record => canonical(record)).join('\n')}\n`;
};
const mutateManifest = (mutator) => original => {
  const manifest = JSON.parse(original);
  mutator(manifest);
  return `${canonical(manifest)}\n`;
};

test('L1 the untampered snapshot verifies', () => assert.equal(verifyStored().ok, true, JSON.stringify(verifyStored().failures)));
test('L2 changing a mint is detected', () => {
  expectTamperFails(withTamperedFile(WORKSPACE.snapshot.directory, coverageFileName,
    mutateCoverage(records => { records[0].mint = '11111111111111111111111111111111'; }), verifyStored), 'COVERAGE_');
});
test('L3 changing a provider family is detected', () => {
  expectTamperFails(withTamperedFile(WORKSPACE.snapshot.directory, coverageFileName,
    mutateCoverage(records => { records[0].providerFamilies = ['bluesky']; records[0].providerFamilyCount = 1; }), verifyStored), 'COVERAGE_');
});
test('L4 removing a provider namespace is detected', () => {
  expectTamperFails(withTamperedFile(WORKSPACE.snapshot.directory, coverageFileName,
    mutateCoverage(records => {
      const target = records.find(record => record.providerNamespaces.length > 1);
      target.providerNamespaces = target.providerNamespaces.slice(0, 1);
      target.providerNamespaceCount = 1;
    }), verifyStored), 'COVERAGE_');
});
test('L5 adding a provider namespace is detected', () => {
  expectTamperFails(withTamperedFile(WORKSPACE.snapshot.directory, coverageFileName,
    mutateCoverage(records => {
      const target = records.find(record => record.providerFamilies.length === 1);
      target.providerNamespaces = [...target.providerNamespaces, 'mastodon:gamma.example'];
      target.providerNamespaceCount = target.providerNamespaces.length;
    }), verifyStored), 'COVERAGE_');
});
test('L6 removing an upstream observation is detected', () => {
  expectTamperFails(withTamperedFile(WORKSPACE.snapshot.directory, coverageFileName,
    mutateCoverage(records => {
      const target = records.find(record => record.upstreamObservationCount > 1);
      target.upstreamObservationIdentities = target.upstreamObservationIdentities.slice(0, 1);
      target.upstreamObservationCount = 1;
    }), verifyStored), 'COVERAGE_');
});
test('L7 injecting an upstream observation is detected', () => {
  expectTamperFails(withTamperedFile(WORKSPACE.snapshot.directory, coverageFileName,
    mutateCoverage(records => {
      records[0].upstreamObservationIdentities = [...records[0].upstreamObservationIdentities, 'mastodon:alpha.example:9999'];
      records[0].upstreamObservationCount = records[0].upstreamObservationIdentities.length;
    }), verifyStored), 'COVERAGE_');
});
test('L8 removing an observation-coverage record is detected', () => {
  expectTamperFails(withTamperedFile(WORKSPACE.snapshot.directory, observationCoverageFileName,
    original => original.split('\n').filter(Boolean).slice(1).join('\n') + '\n', verifyStored), 'OBSERVATION_COVERAGE_');
});
test('L9 injecting an observation-coverage record is detected', () => {
  expectTamperFails(withTamperedFile(WORKSPACE.snapshot.directory, observationCoverageFileName, original => {
    const records = original.split('\n').filter(Boolean).map(line => JSON.parse(line));
    const clone = JSON.parse(JSON.stringify(records[0]));
    clone.upstreamIdentity = 'mastodon:alpha.example:8888';
    records.push(clone);
    return `${records.map(record => canonical(record)).join('\n')}\n`;
  }, verifyStored), 'OBSERVATION_COVERAGE_');
});
test('L10 changing a count is detected', () => {
  expectTamperFails(withTamperedFile(WORKSPACE.snapshot.directory, manifestFileName,
    mutateManifest(manifest => { manifest.exactMintCount += 1; }), verifyStored), 'COUNT_DRIFT');
});
test('L11 changing the source corpus fingerprint is detected', () => {
  expectTamperFails(withTamperedFile(WORKSPACE.snapshot.directory, manifestFileName,
    mutateManifest(manifest => { manifest.sourceCorpusFingerprint = 'a'.repeat(64); }), verifyStored), 'SOURCE_CORPUS_FINGERPRINT_DRIFT');
});
test('L12 changing the source temporal fingerprint is detected', () => {
  expectTamperFails(withTamperedFile(WORKSPACE.snapshot.directory, manifestFileName,
    mutateManifest(manifest => { manifest.sourceTemporalFingerprint = 'b'.repeat(64); }), verifyStored), 'SOURCE_TEMPORAL_FINGERPRINT_DRIFT');
});
test('L13 changing a coverage status is detected', () => {
  expectTamperFails(withTamperedFile(WORKSPACE.snapshot.directory, coverageFileName,
    mutateCoverage(records => {
      const single = records.find(record => record.coverageStatus === 'SINGLE_PROVIDER_FAMILY');
      single.coverageStatus = 'MULTI_PROVIDER_FAMILY';
    }), verifyStored), 'COVERAGE_RECORD_INVALID');
});
test('L14 changing the records digest is detected', () => {
  expectTamperFails(withTamperedFile(WORKSPACE.snapshot.directory, manifestFileName,
    mutateManifest(manifest => { manifest.recordsDigest = 'c'.repeat(64); }), verifyStored), 'DIGEST_DRIFT');
});
test('L15 widening the classification is detected', () => {
  expectTamperFails(withTamperedFile(WORKSPACE.snapshot.directory, manifestFileName,
    mutateManifest(manifest => { manifest.classification = { ...manifest.classification, tradingAuthority: true }; }), verifyStored), 'CLASSIFICATION');
});
test('L16 changing the coverage classification is detected', () => {
  expectTamperFails(withTamperedFile(WORKSPACE.snapshot.directory, manifestFileName,
    mutateManifest(manifest => { manifest.coverageClassification = 'NO_EXACT_MINT_EVIDENCE'; }), verifyStored), 'COVERAGE_CLASSIFICATION');
});
test('L17 removing a member run is detected', () => {
  expectTamperFails(withTamperedFile(WORKSPACE.snapshot.directory, manifestFileName,
    mutateManifest(manifest => { manifest.memberRunIds = manifest.memberRunIds.slice(0, 3); }), verifyStored), 'MEMBER_RUN_SET_SIZE_MISMATCH');
});
test('L18 changing the snapshot fingerprint is detected', () => {
  expectTamperFails(withTamperedFile(WORKSPACE.snapshot.directory, manifestFileName,
    mutateManifest(manifest => { manifest.snapshotFingerprint = 'd'.repeat(64); }), verifyStored), 'SNAPSHOT_FINGERPRINT_MISMATCH');
});
test('L19 an extra file in the snapshot directory is detected', () => {
  const extra = path.join(WORKSPACE.snapshot.directory, 'extra.txt');
  writeFileSync(extra, 'x', 'utf8');
  try {
    expectTamperFails(verifyStored(), 'EXTRA_FILES');
  } finally { unlinkSync(extra); }
});
test('L20 a tampered snapshot is restored and verifies again', () => {
  assert.equal(verifyStored().ok, true, JSON.stringify(verifyStored().failures));
});

// ===========================================================================
// M. PRIVACY
// ===========================================================================
const FORBIDDEN_FIELDS = ['rawText', 'text', 'displayName', 'handle', 'bio', 'note', 'avatar', 'email', 'accessToken', 'cookie', 'authorId', 'providerAuthorId'];
test('M1 no coverage record schema field is a body, profile or credential field', () => {
  const fields = INDEX.PUBLIC_INTELLIGENCE_5K7_COVERAGE_RECORD_SCHEMA.fields;
  for (const banned of FORBIDDEN_FIELDS) assert.ok(!fields.includes(banned), banned);
});
test('M2 no observation-coverage schema field is a body, profile or credential field', () => {
  const fields = INDEX.PUBLIC_INTELLIGENCE_5K7_OBSERVATION_COVERAGE_SCHEMA.fields;
  for (const banned of FORBIDDEN_FIELDS) assert.ok(!fields.includes(banned), banned);
});
test('M3 the coverage records contain no post body from the fixtures', () => {
  for (const record of loadedSnapshot.coverageRecords) {
    assert.ok(!canonical(record).includes(IDENTITY_TEXT_C), 'a fixture post body leaked');
  }
});
test('M4 the observation-coverage records carry reference identity only', () => {
  for (const record of loadedSnapshot.observationCoverageRecords) {
    assert.deepEqual(Object.keys(record).sort(), [...INDEX.PUBLIC_INTELLIGENCE_5K7_OBSERVATION_COVERAGE_SCHEMA.fields].sort());
  }
});
test('M5 no corroboration module mentions a forbidden credential key', () => {
  const bannedKeys = ['password', 'privateKey', 'seedPhrase', 'accessToken', 'refreshToken', 'apiKey', 'clientSecret'];
  for (const unit of SURFACE.PUBLIC_INTELLIGENCE_5K7_MODULES) {
    const { found } = parseModule(`${PI}/${unit}`);
    for (const key of bannedKeys) assert.ok(!found.stringLiterals.includes(key), `${unit}: ${key}`);
  }
});
test('M6 the snapshot artifacts never write under .evolve', () => {
  for (const unit of SURFACE.PUBLIC_INTELLIGENCE_5K7_MODULES) {
    for (const literal of parseModule(`${PI}/${unit}`).found.stringLiterals) {
      assert.ok(!literal.includes('.evolve'), `${unit}: ${literal}`);
    }
  }
  assert.equal(existsFile(path.join(REPO_ROOT, '.evolve', 'public-intelligence')), false);
});

// ===========================================================================
// N. NO MARKET / TRADING LINKAGE
// ===========================================================================
test('N1 the market-linkage disclosure denies every access', () => {
  const M = DEF.PUBLIC_INTELLIGENCE_5K7_MARKET_LINKAGE;
  for (const flag of ['priceDataAccessed', 'returnsAccessed', 'volatilityAccessed', 'r4OutcomeDataAccessed', 'tradingEngineReached',
    'arenaReached', 'walletAccessed', 'signerAccessed', 'swapReached', 'rpcWriteReached', 'futureMovementAssociated']) {
    assert.equal(M[flag], false, flag);
  }
});
test('N2 no corroboration module imports an engine, arena, wallet or RPC module', () => {
  const forbidden = /(^|\/)(engine|arena|champion|promotion|wallet|signer|swap|r4|market-outcomes|governance)(\/|$|\.)/i;
  for (const unit of SURFACE.PUBLIC_INTELLIGENCE_5K7_MODULES) {
    const { found } = parseModule(`${PI}/${unit}`);
    for (const source of found.importSources) {
      assert.ok(!forbidden.test(source), `${unit} imports ${source}`);
      assert.ok(!source.startsWith('@solana'), `${unit} imports a wallet library`);
    }
  }
});
test('N3 no corroboration module declares a signing or RPC-write identifier', () => {
  const banned = ['sendRawTransaction', 'sendTransaction', 'signTransaction', 'Keypair', 'VersionedTransaction', 'requestAirdrop'];
  for (const unit of SURFACE.PUBLIC_INTELLIGENCE_5K7_MODULES) {
    const { found } = parseModule(`${PI}/${unit}`);
    for (const id of banned) assert.ok(!found.identifiers.includes(id), `${unit} declares ${id}`);
  }
});
test('N4 no corroboration module imports or names a market or R4 field', () => {
  // Scan IMPORT SOURCES and STRING LITERALS, not object keys: the disclosure
  // constants legitimately NAME the fields this phase denies touching, and an
  // identifier scan would confuse the disclaimer with the offence.
  const bannedImport = /(market|outcome|\br4\b|price|wallet|engine|arena|governance)/i;
  const bannedLiteral = /^(kendallTauB|bootstrapCi|r4CanonicalResult|priceUsd|marketCap|volatility|resolvedReferences|distinctResolvedMints)$/;
  for (const unit of SURFACE.PUBLIC_INTELLIGENCE_5K7_MODULES) {
    const { found } = parseModule(`${PI}/${unit}`);
    for (const source of found.importSources) assert.ok(!bannedImport.test(source), `${unit} imports ${source}`);
    for (const literal of found.stringLiterals) assert.ok(!bannedLiteral.test(literal), `${unit} names ${literal}`);
  }
});
test('N5 the query layer computes no score, rank or recommendation', () => {
  const { found, source } = parseModule(`${PI}/corroboration-query.mjs`);
  for (const banned of ['scoreMint', 'rankMints', 'recommend', 'predict', 'selectTradeCandidate']) {
    assert.ok(!found.identifiers.includes(banned), banned);
  }
  assert.ok(!/scoringApplied:\s*true/.test(source));
});
test('N6 the phase validator itself is offline and made zero network calls', () => assert.equal(tripwireCalls, 0));

// ===========================================================================
// O. DETERMINISM
// ===========================================================================
test('O1 the index is invariant to input order', () => {
  const content = WORKSPACE.content;
  const shuffled = INDEX.buildCorroborationIndex(
    {
      contentRecords: [...content.temporalRecords.contentRecords].reverse(),
      observationRecords: [...content.temporalRecords.observationRecords].reverse(),
    },
    { sourceSnapshotIds: [WORKSPACE.snapshot.manifest.sourceTemporalSnapshotId] },
  );
  assert.equal(canonical(shuffled.coverageRecords), canonical(content.coverageRecords));
  assert.equal(canonical(shuffled.aggregate), canonical(content.aggregate));
});
test('O2 the aggregate key order is stable', () => {
  const A = WORKSPACE.content.aggregate;
  const B = INDEX.computeCorroborationAggregate({ coverageRecords: WORKSPACE.content.coverageRecords, observationCoverageRecords: WORKSPACE.content.observationCoverageRecords });
  assert.equal(canonical(A), canonical(B));
});
test('O3 two independent builds of the same source set agree byte for byte', () => {
  const first = workspaceContent();
  const second = workspaceContent();
  assert.equal(canonical(first.coverageRecords), canonical(second.coverageRecords));
  assert.equal(first.recordsDigest, second.recordsDigest);
  assert.equal(first.sourceTemporalSnapshotId, second.sourceTemporalSnapshotId);
});
test('O4 the coverage records are sorted by mint', () => {
  const mints = WORKSPACE.content.coverageRecords.map(record => record.mint);
  assert.deepEqual([...mints], [...mints].sort());
});
test('O5 the observation-coverage records are sorted by upstream identity', () => {
  const identities = WORKSPACE.content.observationCoverageRecords.map(record => record.upstreamIdentity);
  assert.deepEqual([...identities], [...identities].sort());
});
test('O6 provider-family and namespace counts are sorted objects', () => {
  const A = WORKSPACE.content.aggregate;
  assert.deepEqual(Object.keys(A.providerFamilyCounts), [...Object.keys(A.providerFamilyCounts)].sort());
  assert.deepEqual(Object.keys(A.providerNamespaceCounts), [...Object.keys(A.providerNamespaceCounts)].sort());
});
test('O7 the rebuild is stable across repeated verification runs', () => {
  const first = verifyStored();
  const second = verifyStored();
  assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)));
});
test('O8 the snapshot id is invariant to member run order', () => {
  const fingerprints = WORKSPACE.content.memberships.map(member => member.runManifestFingerprint);
  assert.equal(SNAP.deriveCorroborationSnapshotId(POLICY, fingerprints), SNAP.deriveCorroborationSnapshotId(POLICY, [...fingerprints].sort()));
  assert.match(SNAP.deriveCorroborationSnapshotId(POLICY, fingerprints), /^crsnap-/);
});
test('O9 the coverage record fingerprint is a pure function of the record', () => {
  const record = WORKSPACE.content.coverageRecords[0];
  const body = { ...record };
  delete body.recordFingerprint;
  assert.equal(record.recordFingerprint, digest(body));
});

// ===========================================================================
// P. REGRESSION AND ARCHITECTURAL ISOLATION
// ===========================================================================
test('P1 this validator imports exactly ONE project module and names no protected fragment', () => {
  const { found } = parseModule('scripts/validate-phase5k7.mjs');
  assert.deepEqual(found.importSources.filter(source => source.startsWith('.')), [PI_SURFACE]);
  for (const source of found.importSources) {
    for (const fragment of SURFACE.PROTECTED_MODULE_FRAGMENTS) assert.ok(!source.includes(fragment), `an import source names ${fragment}`);
  }
  for (const literal of found.stringLiterals) {
    for (const fragment of SURFACE.PROTECTED_MODULE_FRAGMENTS) assert.ok(!literal.includes(fragment), `a literal names ${fragment}`);
  }
});
test('P2 the validation surface re-exports only; it adds no behaviour', () => {
  const { source } = parseModule(`${PI}/corroboration-validation-surface.mjs`);
  assert.ok(!/^\s*(?:async\s+)?function\b/m.test(source), 'the surface declares no function');
  assert.ok(!/^\s*class\b/m.test(source), 'the surface declares no class');
  assert.ok(!/^\s*(?:if|for|while|switch|try)\b/m.test(source), 'the surface has no control flow');
  assert.ok(!/\bnew\s+[A-Z]/.test(source), 'the surface constructs nothing');
  assert.ok(!/process\.env|Date\.now|setTimeout|setInterval/.test(source), 'the surface reads no clock or environment');
});
test('P3 nothing outside the governed tree imports a corroboration module', () => {
  const modules = new Set(SURFACE.PUBLIC_INTELLIGENCE_5K7_MODULES);
  const listed = gitOut('ls-files', 'scripts', 'src').split('\n').filter(entry => /\.(mjs|ts|tsx|js)$/.test(entry));
  for (const entry of listed) {
    if (entry.startsWith(`${PI}/`)) continue;
    if (HISTORICAL_VALIDATORS.includes(entry)) continue;
    const source = readFileSync(path.join(REPO_ROOT, entry), 'utf8');
    for (const fragment of SURFACE.PROTECTED_MODULE_FRAGMENTS) {
      assert.ok(!source.includes(fragment), `${entry} names ${fragment}`);
    }
    if (!/\.(mjs|js)$/.test(entry)) continue;
    let parsed = null;
    try { parsed = parseModule(entry); } catch { continue; }
    for (const imported of parsed.found.importSources) {
      for (const governed of modules) assert.ok(!imported.endsWith(governed), `${entry} imports ${governed}`);
    }
  }
});
test('P4 every corroboration module lives inside the governed tree and exists', () => {
  for (const unit of SURFACE.PUBLIC_INTELLIGENCE_5K7_MODULES) {
    assert.ok(unit.startsWith('corroboration'), unit);
    assert.ok(existsFile(path.join(REPO_ROOT, `${PI}/${unit}`)), unit);
  }
  assert.equal(gitOut('ls-files', 'var').trim(), '', 'no runtime capture is tracked');
});
test('P5 .evolve is untouched', () => {
  for (const line of gitOut('status', '--porcelain').split('\n').filter(Boolean)) {
    assert.equal(/^\s*[MADRCU?!]{1,2}\s+\.evolve/.test(line), false, '.evolve must be untouched');
  }
  assert.equal(existsFile(path.join(REPO_ROOT, '.evolve', 'public-intelligence')), false);
});
test('P6 no runtime capture, credential or secret is tracked or staged', () => {
  for (const line of gitOut('status', '--porcelain').split('\n').filter(Boolean)) {
    const entry = line.slice(3).trim();
    assert.ok(!/^var\//.test(entry), `a runtime capture is present: ${entry}`);
    assert.ok(!/^\.evolve\//.test(entry), `the guarded area is present: ${entry}`);
    assert.ok(!/\.env(\.|$)/.test(entry), `an environment file is present: ${entry}`);
  }
});
test('P7 no decision surface imports Phase 5K', () => {
  const consumers = ['scripts/evolve-engine.mjs', 'scripts/evolve-governance.mjs', 'scripts/arena.mjs',
    'scripts/champions.mjs', 'scripts/experiment.mjs', 'scripts/intelligence.mjs'];
  for (const consumer of consumers) {
    if (!existsFile(path.join(REPO_ROOT, consumer))) continue;
    assert.ok(!/public-intelligence/.test(readFileSync(path.join(REPO_ROOT, consumer), 'utf8')), `${consumer} imports Phase 5K`);
  }
});
test('P8 R4 C1 is an ancestor of HEAD and finalized R4 artifacts are unchanged', () => {
  execFileSync('git', ['merge-base', '--is-ancestor', R4_HEAD, 'HEAD'], { cwd: REPO_ROOT });
  for (const bound of ['governance/r4/r4-preregistration-seal.json', 'package.json', 'package-lock.json']) {
    assert.ok(readFileSync(path.join(REPO_ROOT, bound)).equals(execFileSync('git', ['show', `${R4_HEAD}:${bound}`], { cwd: REPO_ROOT })), bound);
  }
});
const phaseCount = (script, line) => {
  const output = execFileSync('node', [script], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.ok(output.includes(line), `${script} did not report ${line}`);
};
test('P9 5K.0 stays 32/32', () => phaseCount('scripts/validate-phase5k.mjs', 'Phase 5K.0: 32/32 passed'));
test('P10 5K.1 stays 64/64', () => phaseCount('scripts/validate-phase5k1.mjs', 'Phase 5K.1: 64/64 passed'));
test('P11 5K.2 stays 70/70', () => phaseCount('scripts/validate-phase5k2.mjs', 'Phase 5K.2: 70/70 passed'));
test('P12 5K.3 stays 96/96', () => phaseCount('scripts/validate-phase5k3.mjs', 'Phase 5K.3: 96/96 passed'));
test('P13 5K.4 stays 116/116', () => phaseCount('scripts/validate-phase5k4.mjs', 'Phase 5K.4: 116/116 passed'));
test('P14 5K.5 stays 130/130', () => phaseCount('scripts/validate-phase5k5.mjs', 'Phase 5K.5: 130/130 passed'));
test('P15 5K.6 stays 166/166', () => phaseCount('scripts/validate-phase5k6.mjs', 'Phase 5K.6: 166/166 passed'));
test('P16 5K.6.1 stays 57/57', () => phaseCount('scripts/validate-phase5k6-1.mjs', 'Phase 5K.6.1: 57/57 passed'));
test('P17 5K.6.2 stays 58/58', () => phaseCount('scripts/validate-phase5k6-2.mjs', 'Phase 5K.6.2: 58/58 passed'));
test('P18 5K.6.3 stays 71/71', () => phaseCount('scripts/validate-phase5k6-3.mjs', 'Phase 5K.6.3: 71/71 passed'));

// ---------------------------------------------------------------------------
async function main() {
  let failed = 0;
  try {
    for (const [name, fn] of tests) {
      try { await fn(); console.log(`PASS ${name}`); } catch (error) { failed += 1; console.error(`FAIL ${name}: ${error.stack}`); }
    }
  } finally { for (const root of temporary) rmSync(root, { recursive: true, force: true }); }
  console.log(`Phase 5K.7: ${tests.length - failed}/${tests.length} passed; offline, fixture runs + injected clocks only, ${tripwireCalls} network calls, exact-mint coverage only`);
  if (failed) process.exitCode = 1;
}
main().catch(error => { console.error('phase 5K.7 validator crashed:', error); process.exitCode = 1; });
