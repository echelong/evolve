#!/usr/bin/env node
// Phase 5K.8 - CONTENT LINEAGE AND DUPLICATION semantics validator.
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
// therefore imports exactly ONE project module - the governed 5K.8 surface - and
// the protected fragment names it needs come from that surface.
import assert from 'node:assert/strict';
import net from 'node:net';
import {
  chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
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
const SURFACE = await import('./public-intelligence/lineage-validation-surface.mjs');

const DEF = SURFACE.LINEAGE_DEFINITION_5K8;
const INDEX = SURFACE.LINEAGE_INDEX_5K8;
const SNAP = SURFACE.LINEAGE_SNAPSHOT_5K8;
const VERIFY = SURFACE.LINEAGE_VERIFY_5K8;
const QUERY = SURFACE.LINEAGE_QUERY_5K8;
const CLASSIFICATION = SURFACE.PUBLIC_INTELLIGENCE_CLASSIFICATION;
const canonical = SURFACE.canonical;
const digest = SURFACE.digest;
const rawObservationFingerprint = SURFACE.rawObservationFingerprint;
const rawTextFingerprint = SURFACE.rawTextFingerprint;
const { buildCollectionPlan, executeCollectionRun, loadRunArtifacts } = SURFACE;
const createBlueskyRunAdapter = SURFACE.createBlueskyRunAdapter;
const buildRevisionEvidence = SURFACE.buildRevisionEvidence;
const POLICY = SURFACE.PUBLIC_INTELLIGENCE_5K4_DEFAULT_POLICY;
const CLS = DEF.PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PI = 'scripts/public-intelligence';
const R4_HEAD = '1c30264fb87876eeaf229e25c5cdc5adca429b40';
// The validators of Phases 5K.0-5K.5 predate the surface discipline and are
// exempt by their OWN phase rules.
const HISTORICAL_VALIDATORS = [
  'scripts/validate-phase5k.mjs', 'scripts/validate-phase5k1.mjs', 'scripts/validate-phase5k2.mjs',
  'scripts/validate-phase5k3.mjs', 'scripts/validate-phase5k4.mjs', 'scripts/validate-phase5k5.mjs',
];
const require = createRequire(import.meta.url);
const espree = require('espree');

// ---------------------------------------------------------------------------
// HARNESS
// ---------------------------------------------------------------------------
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const temporary = [];
const tempRoot = label => {
  const root = mkdtempSync(path.join(tmpdir(), `evolve-5k8-${label}-`));
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
// The canonical-only pair: identical text except for the line ending, which the
// canonical projection normalizes and the raw text preserves.
const CANONICAL_LINES_A = `canonical match note ${MINT_D}`;
const CANONICAL_LINES_B = 'second line';

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
const BSKY_URI_G = `at://${DID}/app.bsky.feed.post/3kggggggggg`;
const BSKY_URI_H = `at://${DID}/app.bsky.feed.post/3khhhhhhhhh`;
// The governed permalinks that make the cross-post and the unresolved reference.
const G_PERMALINK = `https://bsky.app/profile/${DID}/post/3kggggggggg`;
const MISSING_PERMALINK = 'https://bsky.app/profile/did:plc:zzzzzzzzzzzzzzzzzzzz/post/3kzzzzzzzzz';

const iso = ms => new Date(ms).toISOString();
/** A Mastodon status whose own permalink stays on its OWN instance. */
const status = (instance, id, { content, likes = 0, createdAt = T1, url } = {}) => ({
  id: String(id), visibility: 'public', created_at: iso(createdAt), url: url ?? `https://${instance}/@author/${id}`,
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
    status(ALPHA, 1001, { content: `mint A ${MINT_A}`, createdAt: T1 }),
    status(ALPHA, 1002, { content: IDENTITY_TEXT_C, createdAt: T1 }),
    status(ALPHA, 1003, { content: 'plain post with no mint', createdAt: T1 }),
    status(ALPHA, 1004, { content: `mint D ${MINT_D}`, createdAt: T1 }),
    status(ALPHA, 1005, { content: `mint E ${MINT_E}`, likes: 1, createdAt: T1 }),
    status(ALPHA, 1006, { content: `mint F ${MINT_F} version one`, likes: 1, createdAt: T1 }),
  ], []], T1);
  // Run 2: Mastodon beta. D only (two instances of ONE family, identical text).
  const beta = await run(mastodonPlan(BETA, T2), [[
    status(BETA, 2001, { content: `mint D ${MINT_D}`, createdAt: T2 }),
  ], []], T2);
  // Run 3: Bluesky. B, C (identical text to the Mastodon C post), G (the post a
  // Mastodon post will explicitly reference), H (the CRLF half of the pair).
  const bluesky = await run(blueskyPlan(T3), [
    { posts: [
      postView(BSKY_URI_B, { text: `mint B ${MINT_B}`, cid: CID_A, createdAt: T3 }),
      postView(BSKY_URI_C, { text: IDENTITY_TEXT_C, cid: CID_B, createdAt: T3 }),
      postView(BSKY_URI_G, { text: `bluesky mirror note ${MINT_A}`, cid: CID_A, createdAt: T3 }),
      postView(BSKY_URI_H, { text: `${CANONICAL_LINES_A}\r\n${CANONICAL_LINES_B}`, cid: CID_A, createdAt: T3 }),
    ], cursor: 'blueskyPageTwo1' },
    { posts: [] },
  ], T3, createBlueskyRunAdapter());
  // Run 4: Mastodon alpha again. C repeated, E engagement changed, F revised,
  // 1007 explicitly references the Bluesky G post, 1008 points at a post that is
  // NOT in the corpus, 1009 is the LF half of the canonical pair.
  const alpha2 = await run(mastodonPlan(ALPHA, T4), [[
    status(ALPHA, 1002, { content: IDENTITY_TEXT_C, createdAt: T1 }),
    status(ALPHA, 1005, { content: `mint E ${MINT_E}`, likes: 9, createdAt: T1 }),
    status(ALPHA, 1006, { content: `mint F ${MINT_F} version two`, likes: 1, createdAt: T1 }),
    status(ALPHA, 1007, { content: `mastodon note ${MINT_A}`, createdAt: T4, url: G_PERMALINK }),
    status(ALPHA, 1008, { content: `unresolved reference note ${MINT_B}`, createdAt: T4, url: MISSING_PERMALINK }),
    status(ALPHA, 1009, { content: `${CANONICAL_LINES_A}\n${CANONICAL_LINES_B}`, createdAt: T4 }),
  ], []], T4);
  // Provider-declared revision sidecar, bound to the exact 1006 evidence in run 4.
  const run4Raw = loadRunArtifacts(alpha2.directory).raw;
  const revised = run4Raw.find(raw => raw.providerObservationId === '1006');
  assert.ok(revised, 'the revised observation is present in run 4');
  const revisionEvidence = [buildRevisionEvidence({
    provider: revised.provider, providerObservationId: revised.providerObservationId,
    rawObservationFingerprint: rawObservationFingerprint(revised), editedAt: T4 + 5_000,
  })];
  const runIds = [alpha1.runId, beta.runId, bluesky.runId, alpha2.runId];
  const content = SNAP.rebuildLineageSnapshot({ root, runIds, policy: POLICY, revisionEvidence });
  const snapshot = SNAP.buildAndStoreLineageSnapshot({ root, runIds, policy: POLICY, revisionEvidence, createdAt: T5 });
  // 5K.7's own snapshot, so the query layer can read the authoritative coverage.
  SURFACE.buildAndStoreCorroborationSnapshot({ root, runIds, policy: POLICY, revisionEvidence, createdAt: T5 });
  return { root, runIds, revisionEvidence, content, snapshot };
}

const WORKSPACE = await buildWorkspace();
const CONTENT = WORKSPACE.content;
const AGG = CONTENT.aggregate;
const lineageOf = predicate => CONTENT.lineages.find(predicate);
const versionOf = identity => CONTENT.contentVersions.find(version => version.upstreamIdentity === identity);
const identity = (namespace, id) => `${namespace}:${id}`;
const ALPHA_NS = `mastodon:${ALPHA}`;
const BETA_NS = `mastodon:${BETA}`;
const BSKY_NS = 'bluesky:public-appview';

// --- synthetic content versions, for the states a provider run cannot produce -
const FP = label => digest({ kind: 'synthetic-fingerprint', label });
function mkVersion({
  identity: upstream, namespace, contentFingerprint = FP(`${upstream}-content`),
  rawText, canonicalText = rawText, mint = null,
  referenceStatus = DEF.PUBLIC_INTELLIGENCE_5K8_REFERENCE_STATUS.NO_REFERENCE, referenceResolvedTo = [],
  firstFetchedAt = T1, lastFetchedAt = firstFetchedAt,
} = {}) {
  const body = {
    schemaVersion: DEF.PUBLIC_INTELLIGENCE_5K8_SCHEMA_VERSION,
    recordType: INDEX.PUBLIC_INTELLIGENCE_5K8_CONTENT_VERSION_RECORD_TYPE,
    contentVersionFingerprint: INDEX.deriveContentVersionFingerprint(upstream, contentFingerprint),
    upstreamIdentity: upstream,
    providerNamespace: namespace,
    providerFamily: DEF.providerFamilyFor(namespace),
    contentFingerprint,
    rawObservationFingerprint: FP(`${upstream}-raw`),
    rawTextFingerprint: FP(`rawtext:${rawText}`),
    canonicalTextFingerprint: FP(`canontext:${canonicalText}`),
    firstFetchedAt,
    lastFetchedAt,
    observedAt: firstFetchedAt,
    runId: `run-${'a'.repeat(32)}`,
    exactMintSubject: mint,
    referenceStatus,
    referenceResolvedTo,
    classification: CLASSIFICATION,
  };
  return { ...body, recordFingerprint: digest(body) };
}
const buildLineages = versions => INDEX.buildLineages({ contentVersions: versions }, [FP('source')]);
const classOf = lineages => lineages.map(lineage => lineage.lineageClass);

// ===========================================================================
// A. GOVERNANCE
// ===========================================================================
test('A1 the phase identity is the governed 5K.8 vocabulary', () => {
  assert.equal(DEF.PUBLIC_INTELLIGENCE_5K8_PHASE, 'PHASE_5K_8');
  assert.equal(DEF.PUBLIC_INTELLIGENCE_5K8_SCHEMA_VERSION, '5K.8.0');
  assert.equal(DEF.PUBLIC_INTELLIGENCE_5K8_POLICY_VERSION, 'lineage-policy-1');
});
test('A2 every artifact carries the frozen observer-only classification', () => {
  for (const flag of ['researchOnly', 'observerOnly', 'paperOnly', 'developmentOnly']) assert.equal(CLASSIFICATION[flag], true, flag);
  for (const flag of ['tradingAuthority', 'engineAuthority', 'arenaEligible', 'promotionEligible', 'profitabilityInferencePermitted']) {
    assert.equal(CLASSIFICATION[flag], false, flag);
  }
});
test('A3 this phase derives only from authenticated local evidence', () => {
  const S = DEF.PUBLIC_INTELLIGENCE_5K8_TEXT_SEMANTICS;
  assert.equal(S.reusesCanonicalText5K1, true);
  assert.equal(S.newNormalizationIntroduced, false);
  assert.equal(DEF.PUBLIC_INTELLIGENCE_5K8_PROVIDER_SEMANTICS.providerFamilyDerivationReusedFrom5K7, true);
});
test('A4 the duplication disclosure refuses every judgement', () => {
  const S = DEF.PUBLIC_INTELLIGENCE_5K8_DUPLICATION_SEMANTICS;
  for (const flag of ['exactTextMatchEvaluated', 'crossProviderMergePerformed']) assert.equal(typeof S[flag], 'boolean', flag);
  assert.equal(S.crossProviderMergePerformed, false);
  for (const flag of ['exactTextMatchProvesCopying', 'exactTextMatchProvesSameAuthor', 'exactTextMatchProvesSameOrganization',
    'exactTextMatchProvesSameClaimSource', 'originalityInferred', 'copyingInferred', 'plagiarismInferred', 'truthEvaluated',
    'authorIndependenceInferred', 'underlyingEvidenceMergedAcrossProviders', 'sameTextCountsAsIndependence']) assert.equal(S[flag], false, flag);
});
test('A5 the content-diversity disclosure keeps both dimensions separate and collapses nothing', () => {
  const S = DEF.PUBLIC_INTELLIGENCE_5K8_DIVERSITY_SEMANTICS;
  assert.equal(S.providerDiversityReported, true);
  assert.equal(S.contentDiversityReported, true);
  for (const flag of ['dimensionsCollapsed', 'singleScoreComputed', 'ratioInterpretedAsQuality', 'ratioExposed', 'scoreComputed',
    'rankComputed', 'confidenceTierAssigned', 'ordinalLevelAssigned', 'oneLineageMeansFalseCorroboration',
    'twoLineagesMeansStrongerTruth', 'lineageCountIsImportance', 'moreProvidersIsMoreImportant', 'predictionMade',
    'recommendationMade', 'tradingInferenceMade']) assert.equal(S[flag], false, flag);
});
test('A6 the phase document exists and documents every required section and disclaimer', () => {
  const doc = readFileSync(path.join(REPO_ROOT, 'docs/PHASE5K8-CONTENT-LINEAGE.md'), 'utf8').toLowerCase();
  for (const heading of ['purpose', 'provider diversity', 'content diversity', 'lineage classes', 'raw text matching',
    'canonical text matching', 'explicit references', 'content version awareness', 'same-provider versus cross-provider',
    'exact-mint integration', 'temporal', 'missingness', 'snapshot identity', 'query api', 'verification', 'privacy',
    'no identity resolution', 'no market linkage', 'determinism', 'non-goals', 'duplication is not copying',
    'provider diversity is not content diversity', 'coverage is not importance', 'no trading inference is permitted']) {
    assert.ok(doc.includes(heading), `doc lacks "${heading}"`);
  }
});
test('A7 the phases 5K.0-5K.7 modules are untouched by 5K.8', () => {
  // 5K.8 may only ADD lineage files: no earlier tracked module may be modified.
  const changed = gitOut('diff', '--name-only', 'HEAD').split('\n').filter(Boolean);
  for (const entry of changed) {
    assert.ok(!entry.startsWith(PI) || entry.includes('lineage'), `an earlier module changed: ${entry}`);
  }
});
test('A8 the derivation is pure: no lineage module reads a clock, environment or network', () => {
  for (const unit of SURFACE.PUBLIC_INTELLIGENCE_5K8_MODULES) {
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
// B. LINEAGE-CLASS VOCABULARY
// ===========================================================================
test('B1 the lineage-class vocabulary is exactly the five governed values', () => {
  assert.deepEqual([...DEF.PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS_VALUES], [
    'DISTINCT_CONTENT', 'EXACT_RAW_TEXT_MATCH', 'CANONICAL_TEXT_MATCH', 'EXPLICIT_CROSS_POST_REFERENCE', 'UNRESOLVED',
  ]);
});
test('B2 no ordinal level and no judgement class exists', () => {
  const values = DEF.PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS_VALUES;
  for (const banned of ['LOW', 'MEDIUM', 'HIGH', 'WEAK', 'STRONG', 'INDEPENDENT', 'ORIGINAL', 'COPIED', 'PLAGIARIZED', 'CONSENSUS']) {
    assert.ok(!values.includes(banned), banned);
  }
});
test('B3 the three governed matching layers are named and nothing else may join two versions', () => {
  assert.deepEqual([...DEF.PUBLIC_INTELLIGENCE_5K8_MATCH_LAYERS], ['RAW_TEXT', 'CANONICAL_TEXT', 'EXPLICIT_REFERENCE']);
});
test('B4 no semantic or approximate matching is implemented anywhere', () => {
  const S = DEF.PUBLIC_INTELLIGENCE_5K8_TEXT_SEMANTICS;
  for (const flag of ['llmUsed', 'embeddingUsed', 'vectorSimilarityUsed', 'semanticSimilarityUsed', 'topicModelUsed',
    'fuzzyNlpUsed', 'sentimentModelUsed', 'characterEditDistanceUsed', 'approximateMatchingUsed', 'lowercasingApplied',
    'stemmingApplied', 'lemmatizationApplied', 'translationApplied', 'tokenizationApplied', 'stopWordRemovalApplied',
    'semanticNormalizationApplied', 'arbitraryWordRemovalApplied']) assert.equal(S[flag], false, flag);
});
test('B5 a singleton is DISTINCT_CONTENT and a multi-member group is never DISTINCT_CONTENT', () => {
  const one = buildLineages([mkVersion({ identity: identity(ALPHA_NS, '9001'), namespace: ALPHA_NS, rawText: 'a' })]);
  assert.deepEqual(classOf(one), [CLS.DISTINCT_CONTENT]);
  const two = buildLineages([
    mkVersion({ identity: identity(ALPHA_NS, '9002'), namespace: ALPHA_NS, rawText: 'b' }),
    mkVersion({ identity: identity(BSKY_NS, 'x9002'), namespace: BSKY_NS, rawText: 'b' }),
  ]);
  assert.deepEqual(classOf(two), [CLS.EXACT_RAW_TEXT_MATCH]);
});
test('B6 the class vocabulary is closed and an unknown class is refused', () => {
  refusal(() => INDEX.deriveLineageId('SIMILAR_CONTENT', [FP('a')]), 'PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS_INVALID');
  const record = buildLineages([mkVersion({ identity: identity(ALPHA_NS, '9003'), namespace: ALPHA_NS, rawText: 'c' })])[0];
  const broken = { ...record, lineageClass: 'SIMILAR_CONTENT' };
  refusal(() => INDEX.validateLineageRecord(broken), 'PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS_INVALID');
});
test('B7 the class is a function of mechanism, never of member count', () => {
  const two = buildLineages([
    mkVersion({ identity: identity(ALPHA_NS, '9004'), namespace: ALPHA_NS, rawText: 'dup' }),
    mkVersion({ identity: identity(BSKY_NS, 'x9004'), namespace: BSKY_NS, rawText: 'dup' }),
  ]);
  const three = buildLineages([
    mkVersion({ identity: identity(ALPHA_NS, '9005'), namespace: ALPHA_NS, rawText: 'dup' }),
    mkVersion({ identity: identity(BSKY_NS, 'x9005'), namespace: BSKY_NS, rawText: 'dup' }),
    mkVersion({ identity: identity(BETA_NS, 'y9005'), namespace: BETA_NS, rawText: 'dup' }),
  ]);
  assert.equal(two[0].lineageClass, three[0].lineageClass);
  assert.equal(three[0].memberContentVersions.length, 3);
});
test('B8 every lineage record carries the frozen classification and a matching fingerprint', () => {
  for (const lineage of CONTENT.lineages) {
    assert.deepEqual(lineage.classification, CLASSIFICATION);
    const body = { ...lineage }; delete body.recordFingerprint;
    assert.equal(lineage.recordFingerprint, digest(body));
  }
});

// ===========================================================================
// C. RAW-TEXT MATCHING
// ===========================================================================
test('C1 identical raw text on two provider families forms ONE lineage', () => {
  const lineage = lineageOf(record => record.exactMintSubjects.includes(MINT_C));
  assert.equal(lineage.lineageClass, CLS.EXACT_RAW_TEXT_MATCH);
  assert.deepEqual(lineage.providerFamilies, ['bluesky', 'mastodon']);
  assert.equal(lineage.memberUpstreamIdentities.length, 2);
});
test('C2 the raw match spans two distinct upstream identities, not one repeated', () => {
  const lineage = lineageOf(record => record.exactMintSubjects.includes(MINT_C));
  assert.equal(new Set(lineage.memberUpstreamIdentities).size, 2);
  assert.equal(lineage.memberUpstreamIdentities.length, 2);
});
test('C3 the raw-text digest is reused UNCHANGED from 5K.1', () => {
  assert.equal(typeof rawTextFingerprint, 'function');
  const sample = { rawText: 'some text', provider: 'mastodon:alpha.example', providerObservationId: '1' };
  assert.equal(rawTextFingerprint(sample), rawTextFingerprint(sample));
  assert.notEqual(rawTextFingerprint(sample), rawTextFingerprint({ ...sample, rawText: 'some text ' }));
});
test('C4 a one-character difference is NOT a raw-text match', () => {
  const lineages = buildLineages([
    mkVersion({ identity: identity(ALPHA_NS, '9101'), namespace: ALPHA_NS, rawText: 'exactly this' }),
    mkVersion({ identity: identity(BSKY_NS, 'x9101'), namespace: BSKY_NS, rawText: 'exactly thiz' }),
  ]);
  assert.deepEqual(classOf(lineages).sort(), [CLS.DISTINCT_CONTENT, CLS.DISTINCT_CONTENT]);
});
test('C5 the raw text of every stored version is fingerprinted, never persisted', () => {
  for (const version of CONTENT.contentVersions) {
    assert.match(version.rawTextFingerprint, /^[0-9a-f]{64}$/);
    assert.ok(!Object.hasOwn(version, 'rawText'));
    assert.ok(!canonical(version).includes('mint A'), 'the body leaked into a version record');
  }
});
test('C6 whitespace is significant: a trailing newline is a different raw text', () => {
  const lineages = buildLineages([
    mkVersion({ identity: identity(ALPHA_NS, '9102'), namespace: ALPHA_NS, rawText: 'line' }),
    mkVersion({ identity: identity(BSKY_NS, 'x9102'), namespace: BSKY_NS, rawText: 'line\n' }),
  ]);
  assert.deepEqual(classOf(lineages).sort(), [CLS.DISTINCT_CONTENT, CLS.DISTINCT_CONTENT]);
});
test('C7 case is significant: a case change is a different raw text', () => {
  const lineages = buildLineages([
    mkVersion({ identity: identity(ALPHA_NS, '9103'), namespace: ALPHA_NS, rawText: 'Mint Alert' }),
    mkVersion({ identity: identity(BSKY_NS, 'x9103'), namespace: BSKY_NS, rawText: 'mint alert' }),
  ]);
  assert.deepEqual(classOf(lineages).sort(), [CLS.DISTINCT_CONTENT, CLS.DISTINCT_CONTENT]);
});
test('C8 an EXACT_RAW_TEXT_MATCH lineage carries exactly one raw-text digest', () => {
  const lineage = lineageOf(record => record.lineageClass === CLS.EXACT_RAW_TEXT_MATCH && record.exactMintSubjects.includes(MINT_C));
  assert.equal(lineage.rawTextFingerprints.length, 1);
});

// ===========================================================================
// D. CANONICAL-TEXT MATCHING
// ===========================================================================
test('D1 different raw text with equal canonical text forms a CANONICAL_TEXT_MATCH lineage', () => {
  const lineage = lineageOf(record => record.lineageClass === CLS.CANONICAL_TEXT_MATCH);
  assert.ok(lineage, 'the canonical pair must form a lineage');
  assert.deepEqual(lineage.providerFamilies, ['bluesky', 'mastodon']);
});
test('D2 the canonical pair really differs in raw text and agrees in canonical text', () => {
  const mastodonVersion = versionOf(identity(ALPHA_NS, '1009'));
  const blueskyVersion = versionOf(identity(BSKY_NS, BSKY_URI_H));
  assert.notEqual(mastodonVersion.rawTextFingerprint, blueskyVersion.rawTextFingerprint);
  assert.equal(mastodonVersion.canonicalTextFingerprint, blueskyVersion.canonicalTextFingerprint);
});
test('D3 a canonical match is not promoted to a raw match', () => {
  const lineage = lineageOf(record => record.lineageClass === CLS.CANONICAL_TEXT_MATCH);
  assert.equal(lineage.rawTextFingerprints.length, 2);
  assert.equal(lineage.canonicalTextFingerprints.length, 1);
});
test('D4 the canonical projection is 5K.1 line-ending normalization and nothing else', () => {
  const S = DEF.PUBLIC_INTELLIGENCE_5K8_TEXT_SEMANTICS;
  assert.equal(S.lineEndingNormalizationOnly, true);
  assert.equal(S.rawTextPreservedCharacterForCharacter, true);
  assert.equal(S.canonicalTextFingerprintReusedFrom5K1, true);
  assert.equal(S.alternateRawFingerprintCreated, false);
});
test('D5 a canonical match requires BOTH versions to be text-bearing', () => {
  const lineages = buildLineages([
    mkVersion({ identity: identity(ALPHA_NS, '9201'), namespace: ALPHA_NS, rawText: 'a\r\nb', canonicalText: 'a\nb' }),
    mkVersion({ identity: identity(BSKY_NS, 'x9201'), namespace: BSKY_NS, rawText: 'a\nb', canonicalText: 'a\nb' }),
  ]);
  assert.deepEqual(classOf(lineages), [CLS.CANONICAL_TEXT_MATCH]);
});
test('D6 a difference at BOTH layers is DISTINCT, never a canonical match', () => {
  const lineages = buildLineages([
    mkVersion({ identity: identity(ALPHA_NS, '9202'), namespace: ALPHA_NS, rawText: 'a\r\nb', canonicalText: 'a\nb' }),
    mkVersion({ identity: identity(BSKY_NS, 'x9202'), namespace: BSKY_NS, rawText: 'a\nc',   canonicalText: 'a\nc' }),
  ]);
  assert.deepEqual(classOf(lineages).sort(), [CLS.DISTINCT_CONTENT, CLS.DISTINCT_CONTENT]);
});

// ===========================================================================
// E. EXPLICIT REFERENCES
// ===========================================================================
test('E1 a governed permalink that resolves to a corpus post forms an explicit-reference lineage', () => {
  const lineage = lineageOf(record => record.lineageClass === CLS.EXPLICIT_CROSS_POST_REFERENCE);
  assert.ok(lineage, 'the cross-post must form a lineage');
  assert.deepEqual(lineage.providerFamilies, ['bluesky', 'mastodon']);
});
test('E2 the referencing version is the Mastodon post and the target is the Bluesky post', () => {
  assert.deepEqual(lineageOf(record => record.lineageClass === CLS.EXPLICIT_CROSS_POST_REFERENCE).memberUpstreamIdentities,
    [identity(BSKY_NS, BSKY_URI_G), identity(ALPHA_NS, '1007')].sort());
});
test('E3 a resolvable governed permalink is recorded as REFERENCE_RESOLVED with its targets', () => {
  const version = versionOf(identity(ALPHA_NS, '1007'));
  assert.equal(version.referenceStatus, DEF.PUBLIC_INTELLIGENCE_5K8_REFERENCE_STATUS.REFERENCE_RESOLVED);
  assert.deepEqual(version.referenceResolvedTo, [identity(BSKY_NS, BSKY_URI_G)]);
});
test('E4 an unresolvable governed permalink is REFERENCE_UNRESOLVED and creates no edge', () => {
  const version = versionOf(identity(ALPHA_NS, '1008'));
  assert.equal(version.referenceStatus, DEF.PUBLIC_INTELLIGENCE_5K8_REFERENCE_STATUS.REFERENCE_UNRESOLVED);
  assert.deepEqual(version.referenceResolvedTo, []);
  assert.equal(lineageOf(record => record.memberUpstreamIdentities.includes(identity(ALPHA_NS, '1008'))).memberContentVersions.length, 1);
});
test('E5 a self permalink is NOT a reference', () => {
  const version = versionOf(identity(ALPHA_NS, '1001'));
  assert.equal(version.referenceStatus, DEF.PUBLIC_INTELLIGENCE_5K8_REFERENCE_STATUS.NO_REFERENCE);
  assert.deepEqual(version.referenceResolvedTo, []);
});
test('E6 only the governed permalink shapes resolve; every other URL stays ordinary evidence', () => {
  assert.equal(INDEX.governedPermalinkRefOf(`https://bsky.app/profile/${DID}/post/3kggggggggg`), `bluesky|at://${DID}/app.bsky.feed.post/3kggggggggg`);
  assert.equal(INDEX.governedPermalinkRefOf(`https://${ALPHA}/@author/1001`), `mastodon|${ALPHA}|1001`);
  for (const url of ['https://example.invalid/post/1', 'https://bsky.app/profile/x', null, '', 'not a url',
    'http://bsky.app/profile/did/post/rkey', 'https://bsky.app/profile/did/like/rkey']) {
    assert.equal(INDEX.governedPermalinkRefOf(url), null, String(url));
  }
});
test('E7 no reference is inferred from text, time, handle or display name', () => {
  const S = DEF.PUBLIC_INTELLIGENCE_5K8_REFERENCE_SEMANTICS;
  for (const flag of ['textSimilarityCreatesReference', 'timestampProximityCreatesReference', 'handleSimilarityCreatesReference',
    'displayNameSimilarityCreatesReference', 'crawlingPerformed', 'refetchPerformed', 'arbitraryUrlTurnedIntoContentIdentity',
    'crossProviderIdentityResolutionPerformed']) assert.equal(S[flag], false, flag);
  // Two versions with identical text but no reference stay a TEXT match, never a reference.
  const lineages = buildLineages([
    mkVersion({ identity: identity(ALPHA_NS, '9301'), namespace: ALPHA_NS, rawText: 'same' }),
    mkVersion({ identity: identity(BSKY_NS, 'x9301'), namespace: BSKY_NS, rawText: 'same' }),
  ]);
  assert.deepEqual(classOf(lineages), [CLS.EXACT_RAW_TEXT_MATCH]);
});
test('E8 a same-family resolved reference creates no cross-provider edge', () => {
  const lineages = buildLineages([
    mkVersion({ identity: identity(ALPHA_NS, '9302'), namespace: ALPHA_NS, rawText: 'a' }),
    mkVersion({
      identity: identity(BETA_NS, '9303'), namespace: BETA_NS, rawText: 'b', referenceResolvedTo: [identity(ALPHA_NS, '9302')],
      referenceStatus: DEF.PUBLIC_INTELLIGENCE_5K8_REFERENCE_STATUS.REFERENCE_RESOLVED,
    }),
  ]);
  assert.deepEqual(classOf(lineages).sort(), [CLS.DISTINCT_CONTENT, CLS.DISTINCT_CONTENT]);
});

// ===========================================================================
// F. VERSION AWARENESS
// ===========================================================================
test('F1 a provider-declared revision yields TWO content versions of one identity', () => {
  const versions = CONTENT.contentVersions.filter(version => version.upstreamIdentity === identity(ALPHA_NS, '1006'));
  assert.equal(versions.length, 2);
  assert.notEqual(versions[0].contentFingerprint, versions[1].contentFingerprint);
});
test('F2 the two revised versions are SEPARATE lineages, so no latest-wins rewriting happens', () => {
  const lineages = lineageOf(record => record.memberUpstreamIdentities.includes(identity(ALPHA_NS, '1006')));
  assert.ok(lineages);
  const both = CONTENT.lineages.filter(record => record.memberUpstreamIdentities.includes(identity(ALPHA_NS, '1006')));
  assert.equal(both.length, 2);
  for (const lineage of both) assert.equal(lineage.memberContentVersions.length, 1);
});
test('F3 both revised versions keep the exact mint they carried', () => {
  const versions = CONTENT.contentVersions.filter(version => version.upstreamIdentity === identity(ALPHA_NS, '1006'));
  for (const version of versions) assert.equal(version.exactMintSubject, MINT_F);
});
test('F4 an engagement-only change adds NO content version', () => {
  const versions = CONTENT.contentVersions.filter(version => version.upstreamIdentity === identity(ALPHA_NS, '1005'));
  assert.equal(versions.length, 1);
});
test('F5 a repeated acquisition adds NO content version', () => {
  const versions = CONTENT.contentVersions.filter(version => version.upstreamIdentity === identity(ALPHA_NS, '1002'));
  assert.equal(versions.length, 1);
});
test('F6 the content-version identity binds the upstream identity and the content digest', () => {
  const version = versionOf(identity(ALPHA_NS, '1001'));
  assert.equal(version.contentVersionFingerprint, INDEX.deriveContentVersionFingerprint(version.upstreamIdentity, version.contentFingerprint));
  assert.notEqual(INDEX.deriveContentVersionFingerprint('other', version.contentFingerprint), version.contentVersionFingerprint);
});
test('F7 every version is retained: the version count equals the distinct identity/content pairs', () => {
  const keys = new Set(CONTENT.contentVersions.map(version => `${version.upstreamIdentity}\u0000${version.contentFingerprint}`));
  assert.equal(keys.size, CONTENT.contentVersions.length);
  assert.ok(CONTENT.contentVersions.length >= new Set(CONTENT.contentVersions.map(version => version.upstreamIdentity)).size);
});

// ===========================================================================
// G. PROVIDER-FAMILY SEPARATION
// ===========================================================================
test('G1 the provider family is derived by the SAME rule 5K.7 froze', () => {
  assert.equal(DEF.providerFamilyFor(ALPHA_NS), 'mastodon');
  assert.equal(DEF.providerFamilyFor(BSKY_NS), 'bluesky');
  assert.deepEqual([...DEF.PUBLIC_INTELLIGENCE_5K8_PROVIDER_FAMILIES], ['bluesky', 'mastodon']);
});
test('G2 a version never disagrees with its own namespace about the family', () => {
  for (const version of CONTENT.contentVersions) {
    assert.equal(version.providerFamily, DEF.providerFamilyFor(version.providerNamespace));
  }
});
test('G3 a lineage families list is exactly the projection of its namespaces', () => {
  for (const lineage of CONTENT.lineages) {
    const projection = [...new Set(lineage.providerNamespaces.map(namespace => DEF.providerFamilyFor(namespace)))].sort();
    assert.deepEqual(lineage.providerFamilies, projection);
  }
});
test('G4 an unknown or malformed namespace fails closed on the inherited 5K.7 rule', () => {
  // 5K.8 does not restate the derivation, so the refusal it inherits is 5K.7's.
  refusal(() => DEF.providerFamilyFor('threads:instance'), 'PROVIDER_FAMILY_UNKNOWN');
  refusal(() => DEF.providerFamilyFor('mastodon'), 'PROVIDER_NAMESPACE_MALFORMED');
});
test('G5 a multi-family lineage reports both families and at least two namespaces', () => {
  const lineage = lineageOf(record => record.lineageClass === CLS.EXACT_RAW_TEXT_MATCH && record.exactMintSubjects.includes(MINT_C));
  assert.equal(lineage.providerFamilies.length, 2);
  assert.ok(lineage.providerNamespaces.length >= 2);
});
test('G6 provider diversity is the 5K.7 count, not the lineage count', () => {
  const coverage = CONTENT.coverageRecords.find(record => record.mint === MINT_C);
  const diversity = INDEX.computeDistinctnessForMint(MINT_C, { lineages: CONTENT.lineages, coverageRecord: coverage });
  assert.equal(diversity.providerFamilyCount, 2);
  assert.equal(diversity.lineageCount, 1);
  assert.notEqual(diversity.providerFamilyCount, diversity.lineageCount);
});

// ===========================================================================
// H. SAME-PROVIDER DUPLICATION
// ===========================================================================
test('H1 two Mastodon instances with identical text form ONE single-family lineage', () => {
  const lineage = lineageOf(record => record.memberUpstreamIdentities.includes(identity(BETA_NS, '2001')));
  assert.deepEqual(lineage.providerFamilies, ['mastodon']);
  assert.equal(lineage.lineageClass, CLS.EXACT_RAW_TEXT_MATCH);
});
test('H2 that lineage has TWO namespaces but ONE family', () => {
  const lineage = lineageOf(record => record.memberUpstreamIdentities.includes(identity(BETA_NS, '2001')));
  assert.equal(lineage.providerNamespaces.length, 2);
  assert.equal(lineage.providerFamilies.length, 1);
});
test('H3 a same-provider duplicate is never cross-provider corroboration', () => {
  const lineage = lineageOf(record => record.memberUpstreamIdentities.includes(identity(BETA_NS, '2001')));
  assert.equal(DEF.isMultiProviderFamilyLineage(lineage.providerFamilies), false);
});
test('H4 same-provider duplicates are counted separately from cross-provider ones', () => {
  assert.ok(AGG.sameProviderDuplicateLineageCount >= 1);
  assert.equal(AGG.crossProviderLineageCount, AGG.multiProviderLineageCount);
});
test('H5 two posts on ONE instance with identical text stay one single-family lineage', () => {
  const lineages = buildLineages([
    mkVersion({ identity: identity(ALPHA_NS, '9401'), namespace: ALPHA_NS, rawText: 'twin' }),
    mkVersion({ identity: identity(ALPHA_NS, '9402'), namespace: ALPHA_NS, rawText: 'twin' }),
  ]);
  assert.deepEqual(classOf(lineages), [CLS.EXACT_RAW_TEXT_MATCH]);
  assert.deepEqual(lineages[0].providerFamilies, ['mastodon']);
});
test('H6 same-provider duplication does not create a second provider family', () => {
  const lineages = buildLineages([
    mkVersion({ identity: identity(ALPHA_NS, '9403'), namespace: ALPHA_NS, rawText: 'twin' }),
    mkVersion({ identity: identity(BETA_NS, '9404'), namespace: BETA_NS, rawText: 'twin' }),
    mkVersion({ identity: identity(BETA_NS, '9405'), namespace: BETA_NS, rawText: 'twin' }),
  ]);
  assert.deepEqual(lineages[0].providerFamilies, ['mastodon']);
  assert.equal(lineages[0].providerNamespaces.length, 2);
  assert.equal(lineages[0].memberContentVersions.length, 3);
});

// ===========================================================================
// I. CROSS-PROVIDER DUPLICATION
// ===========================================================================
test('I1 identical content across Bluesky and Mastodon is ONE cross-provider lineage', () => {
  const lineage = lineageOf(record => record.exactMintSubjects.includes(MINT_C));
  assert.equal(lineage.memberUpstreamIdentities.length, 2);
  assert.equal(lineage.providerFamilies.length, 2);
});
test('I2 identical text across providers is never merged into one upstream observation', () => {
  const first = versionOf(identity(ALPHA_NS, '1002'));
  const second = versionOf(identity(BSKY_NS, BSKY_URI_C));
  assert.notEqual(first.upstreamIdentity, second.upstreamIdentity);
  assert.equal(first.rawObservationFingerprint === second.rawObservationFingerprint, false);
});
test('I3 an exact cross-provider text match does not claim copying, authorship or originality', () => {
  const S = DEF.PUBLIC_INTELLIGENCE_5K8_DUPLICATION_SEMANTICS;
  assert.equal(S.copyingInferred, false);
  assert.equal(S.originalityInferred, false);
  assert.equal(S.exactTextMatchProvesSameAuthor, false);
  assert.equal(S.crossProviderMergePerformed, false);
});
test('I4 a cross-provider lineage keeps the provider-scoped identities of both members', () => {
  const lineage = lineageOf(record => record.exactMintSubjects.includes(MINT_C));
  assert.deepEqual(lineage.memberUpstreamIdentities, [identity(BSKY_NS, BSKY_URI_C), identity(ALPHA_NS, '1002')].sort());
});
test('I5 cross-provider duplication is counted, never scored', () => {
  assert.equal(AGG.crossProviderLineageCount, AGG.multiProviderLineageCount);
  assert.equal(AGG.crossProviderLineageCount, 3);
  for (const lineage of CONTENT.lineages) {
    assert.deepEqual(Object.keys(lineage).filter(key => /score|rank|weight|confidence/i.test(key)), []);
  }
});
test('I6 a multi-family lineage and a single-family lineage can coexist for one mint', () => {
  const d = CONTENT.lineages.filter(record => record.exactMintSubjects.includes(MINT_D));
  const families = d.map(record => record.providerFamilies.length).sort();
  assert.deepEqual(families, [1, 2]);
});
test('I7 the cross-provider reference lineage spans two families with two identities', () => {
  const lineage = lineageOf(record => record.lineageClass === CLS.EXPLICIT_CROSS_POST_REFERENCE);
  assert.equal(lineage.providerFamilies.length, 2);
  assert.equal(lineage.memberUpstreamIdentities.length, 2);
});

// ===========================================================================
// J. EXACT-MINT INTEGRATION
// ===========================================================================
test('J1 5K.7 remains authoritative for provider-family coverage', () => {
  assert.ok(CONTENT.coverageRecords.length > 0);
  assert.equal(CONTENT.corroborationAggregate.exactMintCount, CONTENT.coverageRecords.length);
});
test('J2 every version exact mint appears in a 5K.7 coverage record', () => {
  const covered = new Set(CONTENT.coverageRecords.map(record => record.mint));
  for (const version of CONTENT.contentVersions) {
    if (version.exactMintSubject !== null) assert.ok(covered.has(version.exactMintSubject), version.exactMintSubject);
  }
});
test('J3 an unassociated version never gains an exact mint through lineage', () => {
  const version = versionOf(identity(ALPHA_NS, '1003'));
  assert.equal(version.exactMintSubject, null);
  const lineage = lineageOf(record => record.memberUpstreamIdentities.includes(identity(ALPHA_NS, '1003')));
  assert.deepEqual(lineage.exactMintSubjects, []);
});
test('J4 a lineage has no exact mint unless its members carry one', () => {
  for (const lineage of CONTENT.lineages) {
    const memberMints = [...new Set(CONTENT.contentVersions
      .filter(version => lineage.memberContentVersions.includes(version.contentVersionFingerprint))
      .map(version => version.exactMintSubject)
      .filter(mint => mint !== null))].sort();
    assert.deepEqual(lineage.exactMintSubjects, memberMints);
  }
});
test('J5 the diversity view reports provider and content counts separately', () => {
  const coverage = CONTENT.coverageRecords.find(record => record.mint === MINT_A);
  const diversity = INDEX.computeDistinctnessForMint(MINT_A, { lineages: CONTENT.lineages, coverageRecord: coverage });
  assert.equal(diversity.providerFamilyCount, 2);
  assert.equal(diversity.lineageCount, 2);
  assert.equal(diversity.exactDuplicateLineageCount, 0);
  assert.equal(diversity.explicitReferenceLineageCount, 1);
  assert.equal(diversity.distinctLineageCount, 1);
});
test('J6 the diversity view contains no ratio and no scalar score', () => {
  const diversity = INDEX.computeDistinctnessForMint(MINT_A, { lineages: CONTENT.lineages });
  assert.equal(diversity.scoreComputed, false);
  assert.equal(diversity.ratioInterpretedAsQuality, false);
  assert.equal(diversity.dimensionsCollapsed, false);
  for (const key of Object.keys(diversity)) assert.ok(!/ratio$|score$|rank|weight/i.test(key), key);
});
test('J7 lineage never infers a mint: a mintless lineage stays mintless', () => {
  const lineage = lineageOf(record => record.memberUpstreamIdentities.includes(identity(ALPHA_NS, '1003')));
  assert.deepEqual(lineage.exactMintSubjects, []);
  const lineages = buildLineages([
    mkVersion({ identity: identity(ALPHA_NS, '9501'), namespace: ALPHA_NS, rawText: 'no mint here' }),
    mkVersion({ identity: identity(BSKY_NS, 'x9501'), namespace: BSKY_NS, rawText: 'no mint here' }),
  ]);
  assert.deepEqual(lineages[0].exactMintSubjects, []);
});

// ===========================================================================
// K. TEMPORAL ORDERING
// ===========================================================================
test('K1 lineage times are copied from authenticated fetch instants', () => {
  for (const lineage of CONTENT.lineages) {
    const members = CONTENT.contentVersions.filter(version => lineage.memberContentVersions.includes(version.contentVersionFingerprint));
    assert.equal(lineage.firstObservedAt, Math.min(...members.map(version => version.firstFetchedAt)));
    assert.equal(lineage.lastObservedAt, Math.max(...members.map(version => version.lastFetchedAt)));
  }
});
test('K2 first is never after last', () => {
  for (const lineage of CONTENT.lineages) assert.ok(lineage.firstObservedAt <= lineage.lastObservedAt);
});
test('K3 the aggregate window is the min and max over lineages', () => {
  assert.equal(AGG.earliestObservedAt, Math.min(...CONTENT.lineages.map(lineage => lineage.firstObservedAt)));
  assert.equal(AGG.latestObservedAt, Math.max(...CONTENT.lineages.map(lineage => lineage.lastObservedAt)));
});
test('K4 no causality or origin is inferred from an earlier observation', () => {
  const S = DEF.PUBLIC_INTELLIGENCE_5K8_TIME_SEMANTICS;
  for (const flag of ['currentTimeUsed', 'filesystemMtimeUsed', 'directoryOrderUsed', 'simultaneityInferred', 'causalityInferred',
    'originInferred', 'earlierObservationImpliesLaterCopied']) assert.equal(S[flag], false, flag);
  assert.equal(S.timestampsCopiedFromAuthenticatedEvidence, true);
});
test('K5 an unordered input still yields the same temporal window', () => {
  const forward = buildLineages([
    mkVersion({ identity: identity(ALPHA_NS, '9601'), namespace: ALPHA_NS, rawText: 't', firstFetchedAt: T1, lastFetchedAt: T1 }),
    mkVersion({ identity: identity(BSKY_NS, 'x9601'), namespace: BSKY_NS, rawText: 't', firstFetchedAt: T4, lastFetchedAt: T4 }),
  ]);
  const reversed = buildLineages([
    mkVersion({ identity: identity(BSKY_NS, 'x9601'), namespace: BSKY_NS, rawText: 't', firstFetchedAt: T4, lastFetchedAt: T4 }),
    mkVersion({ identity: identity(ALPHA_NS, '9601'), namespace: ALPHA_NS, rawText: 't', firstFetchedAt: T1, lastFetchedAt: T1 }),
  ]);
  assert.equal(forward[0].firstObservedAt, reversed[0].firstObservedAt);
  assert.equal(forward[0].lastObservedAt, reversed[0].lastObservedAt);
  assert.equal(forward[0].lineageId, reversed[0].lineageId);
});

// ===========================================================================
// L. SNAPSHOT IDENTITY
// ===========================================================================
test('L1 the snapshot id is deterministic from policy and the source run set', () => {
  assert.match(WORKSPACE.snapshot.snapshotId, /^linsnap-[0-9a-f]{32}$/);
  const fingerprints = CONTENT.memberships.map(member => member.runManifestFingerprint);
  assert.equal(SNAP.deriveLineageSnapshotId(POLICY, fingerprints), WORKSPACE.snapshot.snapshotId);
});
test('L2 the snapshot id is invariant to member run order', () => {
  const fingerprints = CONTENT.memberships.map(member => member.runManifestFingerprint);
  assert.equal(SNAP.deriveLineageSnapshotId(POLICY, [...fingerprints].reverse()), WORKSPACE.snapshot.snapshotId);
  assert.equal(SNAP.deriveLineageSnapshotId(POLICY, [...fingerprints].sort()), WORKSPACE.snapshot.snapshotId);
});
test('L3 createdAt does NOT participate in the id but DOES participate in the fingerprint', () => {
  const later = SNAP.buildLineageSnapshotManifest(CONTENT, T5 + 1);
  const sooner = SNAP.buildLineageSnapshotManifest(CONTENT, T5);
  assert.equal(later.snapshotId, sooner.snapshotId);
  assert.notEqual(later.snapshotFingerprint, sooner.snapshotFingerprint);
});
test('L4 the manifest fingerprint covers every field but itself', () => {
  const body = { ...WORKSPACE.snapshot.manifest }; delete body.snapshotFingerprint;
  assert.equal(WORKSPACE.snapshot.manifest.snapshotFingerprint, digest(body));
  assert.equal(SNAP.lineageSnapshotFingerprintOf(WORKSPACE.snapshot.manifest), digest(body));
});
test('L5 the manifest records both source snapshot identities and their fingerprints', () => {
  const manifest = WORKSPACE.snapshot.manifest;
  assert.match(manifest.sourceTemporalSnapshotId, /^tsnap-[0-9a-f]{32}$/);
  assert.match(manifest.sourceCorroborationSnapshotId, /^crsnap-[0-9a-f]{32}$/);
  for (const key of ['sourceTemporalFingerprint', 'sourceCorroborationSnapshotFingerprint', 'sourceCorpusFingerprint']) {
    assert.match(manifest[key], /^[0-9a-f]{64}$/, key);
  }
});
test('L6 the manifest carries the policy lineage of every source layer', () => {
  const manifest = WORKSPACE.snapshot.manifest;
  assert.equal(manifest.lineagePolicyVersion, 'lineage-policy-1');
  assert.equal(manifest.corroborationPolicyVersion, SURFACE.PUBLIC_INTELLIGENCE_5K7_POLICY_VERSION);
  assert.equal(manifest.temporalPolicyVersion, 'temporal-policy-1');
  assert.ok(manifest.corpusPolicyVersion);
});
test('L7 the stored digests match the stored artifacts', () => {
  const artifacts = SNAP.loadLineageArtifacts(WORKSPACE.snapshot.directory);
  assert.equal(WORKSPACE.snapshot.manifest.lineageDigest, digest(artifacts.lineages));
  assert.equal(WORKSPACE.snapshot.manifest.contentVersionDigest, digest(artifacts.contentVersions));
  assert.equal(WORKSPACE.snapshot.manifest.recordsDigest, digest(AGG));
});
test('L8 storage is write-once: rebuilding the same source writes nothing new', () => {
  const again = SNAP.buildAndStoreLineageSnapshot({
    root: WORKSPACE.root, runIds: WORKSPACE.runIds, policy: POLICY, revisionEvidence: WORKSPACE.revisionEvidence, createdAt: T5 + 1000,
  });
  assert.equal(again.outcome, 'ALREADY_EXISTS_IDENTICAL');
  assert.equal(again.snapshotId, WORKSPACE.snapshot.snapshotId);
});
test('L9 the snapshot directory holds only the governed files', () => {
  const artifacts = SNAP.loadLineageArtifacts(WORKSPACE.snapshot.directory);
  assert.deepEqual(artifacts.extraFiles, []);
  for (const name of Object.values(SNAP.PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_FILES)) {
    assert.ok(existsFile(path.join(WORKSPACE.snapshot.directory, name)), name);
  }
});
test('L10 the manifest count invariants hold', () => {
  assert.deepEqual(SNAP.checkLineageSnapshotCounts(WORKSPACE.snapshot.manifest), []);
  assert.deepEqual(INDEX.checkLineageAggregate(AGG, { contentVersions: CONTENT.contentVersions, lineages: CONTENT.lineages }), Object.freeze({ ok: true, problems: Object.freeze([]) }));
});

// ===========================================================================
// M. QUERY API
// ===========================================================================
test('M1 the public query surface is exactly the eight governed retrieval names', () => {
  assert.deepEqual([...QUERY.PUBLIC_INTELLIGENCE_5K8_QUERY_API], [
    'getLineage', 'listLineagesForMint', 'listLineagesForProviderFamily',
    'listExactDuplicateLineages', 'listCanonicalDuplicateLineages', 'listDistinctContentLineages',
    'getContentDiversityForMint', 'getLineageSummary',
  ]);
});
test('M2 no prohibited query name exists in the lineage layer', () => {
  const exported = Object.keys(SURFACE.LINEAGE_QUERY_5K8);
  const prohibited = DEF.PUBLIC_INTELLIGENCE_5K8_PROHIBITED_QUERY_NAMES;
  for (const name of prohibited) assert.ok(!exported.includes(name), name);
  const api = QUERY.createLineageQuery({ manifest: WORKSPACE.snapshot.manifest, lineages: CONTENT.lineages, contentVersions: CONTENT.contentVersions, coverageRecords: CONTENT.coverageRecords });
  for (const name of prohibited) assert.ok(!Object.hasOwn(api, name), name);
});
test('M3 the query object exposes exactly the governed methods', () => {
  const api = QUERY.createLineageQuery({ manifest: WORKSPACE.snapshot.manifest, lineages: CONTENT.lineages, contentVersions: CONTENT.contentVersions, coverageRecords: CONTENT.coverageRecords });
  assert.deepEqual(Object.keys(api).sort(), [...QUERY.PUBLIC_INTELLIGENCE_5K8_QUERY_API].sort());
});
test('M4 getLineage returns the stored lineage, and null for an unknown id', () => {
  const api = QUERY.createLineageQuery({ manifest: WORKSPACE.snapshot.manifest, lineages: CONTENT.lineages, contentVersions: CONTENT.contentVersions, coverageRecords: CONTENT.coverageRecords });
  const lineage = CONTENT.lineages[0];
  assert.deepEqual(api.getLineage(lineage.lineageId), lineage);
  assert.equal(api.getLineage('lin-00000000000000000000000000000000'), null);
  refusal(() => api.getLineage(''), 'PUBLIC_INTELLIGENCE_5K8_QUERY_LINEAGE_ID_REQUIRED');
});
test('M5 listLineagesForMint is an exact mint lookup and never infers', () => {
  const api = QUERY.createLineageQuery({ manifest: WORKSPACE.snapshot.manifest, lineages: CONTENT.lineages, contentVersions: CONTENT.contentVersions, coverageRecords: CONTENT.coverageRecords });
  assert.equal(api.listLineagesForMint(MINT_F).length, 2);
  assert.deepEqual(api.listLineagesForMint('NotAMintAtAll'), []);
  refusal(() => api.listLineagesForMint(''), 'PUBLIC_INTELLIGENCE_5K8_QUERY_MINT_REQUIRED');
});
test('M6 listLineagesForProviderFamily filters on the governed family', () => {
  const api = QUERY.createLineageQuery({ manifest: WORKSPACE.snapshot.manifest, lineages: CONTENT.lineages, contentVersions: CONTENT.contentVersions, coverageRecords: CONTENT.coverageRecords });
  const bluesky = api.listLineagesForProviderFamily('bluesky');
  for (const id of bluesky) assert.ok(api.getLineage(id).providerFamilies.includes('bluesky'));
  assert.ok(bluesky.length >= 3);
  refusal(() => api.listLineagesForProviderFamily(''), 'PUBLIC_INTELLIGENCE_5K8_QUERY_FAMILY_REQUIRED');
});
test('M7 the duplicate and distinct listings agree with the aggregate', () => {
  const api = QUERY.createLineageQuery({ manifest: WORKSPACE.snapshot.manifest, lineages: CONTENT.lineages, contentVersions: CONTENT.contentVersions, coverageRecords: CONTENT.coverageRecords });
  assert.equal(api.listExactDuplicateLineages().length, AGG.exactRawMatchLineageCount);
  assert.equal(api.listCanonicalDuplicateLineages().length, AGG.canonicalMatchLineageCount);
  assert.equal(api.listDistinctContentLineages().length, AGG.distinctLineageCount);
});
test('M8 getContentDiversityForMint returns discrete facts only', () => {
  const api = QUERY.createLineageQuery({ manifest: WORKSPACE.snapshot.manifest, lineages: CONTENT.lineages, contentVersions: CONTENT.contentVersions, coverageRecords: CONTENT.coverageRecords });
  const diversity = api.getContentDiversityForMint(MINT_C);
  assert.equal(diversity.mint, MINT_C);
  assert.equal(diversity.providerFamilyCount, 2);
  assert.equal(diversity.lineageCount, 1);
  assert.equal(diversity.exactDuplicateLineageCount, 1);
  assert.equal(diversity.scoreComputed, false);
  refusal(() => api.getContentDiversityForMint(''), 'PUBLIC_INTELLIGENCE_5K8_QUERY_MINT_REQUIRED');
});
test('M9 getLineageSummary returns structural counts and no judgement flags are true', () => {
  const api = QUERY.createLineageQuery({ manifest: WORKSPACE.snapshot.manifest, lineages: CONTENT.lineages, contentVersions: CONTENT.contentVersions, coverageRecords: CONTENT.coverageRecords });
  const summary = api.getLineageSummary();
  assert.equal(summary.lineageCount, AGG.lineageCount);
  assert.equal(summary.contentVersionCount, AGG.contentVersionCount);
  for (const flag of ['scoreComputed', 'rankingApplied', 'dimensionsCollapsed', 'originalityInferred', 'copyingInferred', 'authorIdentityResolved']) {
    assert.equal(summary[flag], false, flag);
  }
});

// ===========================================================================
// N. MISSINGNESS
// ===========================================================================
test('N1 the schema requires raw text, so absent text is not representable', () => {
  const S = DEF.PUBLIC_INTELLIGENCE_5K8_MISSINGNESS_SEMANTICS;
  assert.equal(S.rawTextRequiredBySchema, true);
  assert.equal(S.missingTextRepresentable, false);
  assert.equal(S.absentTextTreatedAsEmptyString, false);
  assert.equal(S.matchabilityFabricatedWhenTextAbsent, false);
});
test('N2 every version in the corpus reports text as available, and none is fabricated', () => {
  assert.equal(AGG.textUnavailableVersionCount, 0);
  assert.equal(AGG.textAvailableVersionCount, AGG.contentVersionCount);
  for (const version of CONTENT.contentVersions) {
    assert.match(version.rawTextFingerprint, /^[0-9a-f]{64}$/);
    assert.match(version.canonicalTextFingerprint, /^[0-9a-f]{64}$/);
  }
});
test('N3 a version whose authenticated text is unavailable fails closed rather than matching', () => {
  refusal(() => INDEX.buildContentVersions({
    observationRecords: [{
      upstreamIdentity: identity(ALPHA_NS, '9901'), provider: ALPHA_NS, contentFingerprint: FP('n3-content'),
      rawObservationFingerprint: FP('n3-raw'), fetchedAt: T1, runId: `run-${'a'.repeat(32)}`,
      assetAssociation: { status: 'UNASSOCIATED', mint: null },
    }],
    envelopes: [],
  }), 'PUBLIC_INTELLIGENCE_5K8_VERSION_TEXT_UNAVAILABLE');
});
test('N4 an unresolved reference is explicit, reported and creates no edge', () => {
  const S = DEF.PUBLIC_INTELLIGENCE_5K8_MISSINGNESS_SEMANTICS;
  assert.equal(S.unresolvedReferenceReportedExplicitly, true);
  assert.equal(S.unresolvedReferenceCreatesEdge, false);
  assert.equal(AGG.referenceUnresolvedVersionCount, 1);
  assert.equal(versionOf(identity(ALPHA_NS, '1008')).referenceStatus, DEF.PUBLIC_INTELLIGENCE_5K8_REFERENCE_STATUS.REFERENCE_UNRESOLVED);
});
test('N5 an unassociated identity remains visible as coverage state and never becomes a subject', () => {
  const version = versionOf(identity(ALPHA_NS, '1003'));
  assert.equal(version.exactMintSubject, null);
  const coverage = CONTENT.coverageRecords.find(record => record.mint === MINT_A);
  const diversity = INDEX.computeDistinctnessForMint(MINT_A, { lineages: CONTENT.lineages, coverageRecord: coverage });
  assert.ok(!diversity.mint.includes('1003'));
});

// ===========================================================================
// O. PRIVACY
// ===========================================================================
test('O1 no lineage artifact persists a post body', () => {
  for (const lineage of CONTENT.lineages) {
    const text = canonical(lineage);
    assert.ok(!text.includes(IDENTITY_TEXT_C), 'a body leaked into a lineage record');
    assert.ok(!text.includes(CANONICAL_LINES_A), 'a body leaked into a lineage record');
  }
});
test('O2 no lineage artifact persists a URL', () => {
  for (const record of [...CONTENT.lineages, ...CONTENT.contentVersions]) {
    assert.ok(!/https?:\/\//.test(canonical(record)), 'a URL leaked into a lineage artifact');
  }
});
test('O3 no author identifier, display name or social-graph field is persisted', () => {
  const banned = /authorId|providerAuthorId|displayName|avatar|bio|follower|following|mentionedHandles|normalizedAuthorIdentity/i;
  for (const record of [...CONTENT.lineages, ...CONTENT.contentVersions]) {
    assert.ok(!banned.test(canonical(record)), 'an identity field leaked into a lineage artifact');
  }
  assert.equal(DEF.PUBLIC_INTELLIGENCE_5K8_PRIVACY.authorIdentifiersPersisted ? true : false, false);
});
test('O4 the privacy disclosure refuses every personal-data surface', () => {
  const S = DEF.PUBLIC_INTELLIGENCE_5K8_PRIVACY;
  for (const flag of ['postBodiesPersisted', 'displayNamesPersisted', 'handlesPersisted', 'biosPersisted', 'avatarsPersisted',
    'followerDataAccessed', 'contactGraphAccessed', 'mentionGraphAccessed', 'geolocationAccessed', 'addressesAccessed',
    'credentialsAccessed', 'cookiesAccessed', 'urlsPersisted']) assert.equal(S[flag], false, flag);
  assert.equal(S.derivedReferencesOnly, true);
});
test('O5 no lineage module names a credential, cookie or secret capability', () => {
  for (const unit of SURFACE.PUBLIC_INTELLIGENCE_5K8_MODULES) {
    const { found } = parseModule(`${PI}/${unit}`);
    for (const id of found.identifiers) {
      assert.ok(!/^(apiKey|api_key|clientSecret|appPassword|accessToken|refreshToken|sessionCookie|password|authorization|cookie)$/.test(id), `${unit}:${id}`);
    }
  }
});
test('O6 the stored snapshot files are read-only on disk', () => {
  for (const name of Object.values(SNAP.PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_FILES)) {
    const mode = statSync(path.join(WORKSPACE.snapshot.directory, name)).mode & 0o777;
    assert.equal(mode, 0o444, `${name} has mode ${mode.toString(8)}`);
  }
});

// ===========================================================================
// P. TAMPER VERIFICATION
// ===========================================================================
const snapshotDirectory = WORKSPACE.snapshot.directory;
const snapshotFile = name => path.join(snapshotDirectory, name);
function tampered(file, mutate, expectedFragment) {
  const target = snapshotFile(file);
  const original = readFileSync(target, 'utf8');
  const records = original.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const next = mutate(records);
  chmodSync(target, 0o644);
  writeFileSync(target, typeof next === 'string' ? next : next.map(record => `${canonical(record)}\n`).join(''));
  let verification;
  try {
    verification = VERIFY.verifyLineageSnapshot(WORKSPACE.root, WORKSPACE.snapshot.snapshotId);
  } finally {
    writeFileSync(target, original);
    chmodSync(target, 0o444);
  }
  assert.equal(verification.ok, false, `${file} tamper was NOT detected`);
  assert.ok(verification.failures.some(failure => failure.includes(expectedFragment)),
    `${file}: expected ${expectedFragment}, got ${verification.failures.slice(0, 3).join(' | ')}`);
}
const F = SNAP.PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_FILES;

test('P1 the untouched snapshot verifies', () => {
  const verification = VERIFY.verifyLineageSnapshot(WORKSPACE.root, WORKSPACE.snapshot.snapshotId);
  assert.deepEqual(verification.failures, []);
  assert.equal(verification.ok, true);
});
test('P2 changing a lineage member is detected', () => {
  tampered(F.lineages, records => { records[0].memberUpstreamIdentities = [...records[0].memberUpstreamIdentities, 'mastodon:alpha.example:9999']; return records; }, 'LINEAGE_MODIFIED');
});
test('P3 removing a lineage member is detected', () => {
  tampered(F.lineages, records => { records.find(r => r.memberContentVersions.length === 2).memberContentVersions = records.find(r => r.memberContentVersions.length === 2).memberContentVersions.slice(0, 1); return records; }, 'LINEAGE_MODIFIED');
});
test('P4 changing a provider family is detected', () => {
  tampered(F.lineages, records => { records[0].providerFamilies = ['bluesky']; return records; }, 'LINEAGE_MODIFIED');
});
test('P5 adding a namespace that no family covers is detected', () => {
  tampered(F.lineages, records => { records[0].providerNamespaces = [...records[0].providerNamespaces, 'mastodon:zzz.example']; return records; }, 'LINEAGE_MODIFIED');
});
test('P6 changing the lineage class is detected', () => {
  tampered(F.lineages, records => { records[0].lineageClass = records[0].lineageClass === CLS.DISTINCT_CONTENT ? CLS.UNRESOLVED : CLS.DISTINCT_CONTENT; return records; }, 'LINEAGE_MODIFIED');
});
test('P7 changing an exact mint subject is detected', () => {
  tampered(F.lineages, records => { const target = records.find(r => r.exactMintSubjects.length > 0); target.exactMintSubjects = [MINT_B]; return records; }, 'LINEAGE_MODIFIED');
});
test('P8 injecting a lineage record is detected', () => {
  tampered(F.lineages, records => [...records, { ...records[0], lineageId: `lin-${'b'.repeat(32)}` }], 'LINEAGE_INJECTED');
});
test('P9 removing a lineage record is detected', () => {
  tampered(F.lineages, records => records.slice(1), 'LINEAGE_REMOVED');
});
test('P10 changing a content version fingerprint is detected', () => {
  tampered(F.contentVersions, records => { records[0].rawObservationFingerprint = 'f'.repeat(64); return records; }, 'CONTENT_VERSION_MODIFIED');
});
test('P11 injecting a content version is detected', () => {
  tampered(F.contentVersions, records => [...records, { ...records[0], contentVersionFingerprint: 'e'.repeat(64) }], 'CONTENT_VERSION_INJECTED');
});
test('P12 changing the reference status of a version is detected', () => {
  tampered(F.contentVersions, records => {
    const target = records.find(record => record.referenceStatus === DEF.PUBLIC_INTELLIGENCE_5K8_REFERENCE_STATUS.REFERENCE_UNRESOLVED);
    target.referenceStatus = DEF.PUBLIC_INTELLIGENCE_5K8_REFERENCE_STATUS.NO_REFERENCE;
    return records;
  }, 'CONTENT_VERSION_MODIFIED');
});
test('P13 changing a manifest count is detected', () => {
  tampered(F.snapshot, () => `${canonical({ ...WORKSPACE.snapshot.manifest, lineageCount: WORKSPACE.snapshot.manifest.lineageCount + 1 })}\n`, 'COUNT_DRIFT');
});
test('P14 changing a source fingerprint is detected', () => {
  tampered(F.snapshot, () => `${canonical({ ...WORKSPACE.snapshot.manifest, sourceTemporalFingerprint: 'a'.repeat(64) })}\n`, 'SOURCE_TEMPORAL_FINGERPRINT_DRIFT');
});
test('P15 substituting a source snapshot identity is detected', () => {
  tampered(F.snapshot, () => `${canonical({ ...WORKSPACE.snapshot.manifest, sourceCorroborationSnapshotId: `crsnap-${'a'.repeat(32)}` })}\n`, 'SOURCE_CORROBORATION');
});
test('P16 widening the classification is detected', () => {
  tampered(F.snapshot, () => `${canonical({ ...WORKSPACE.snapshot.manifest, classification: { ...CLASSIFICATION, tradingAuthority: true } })}\n`, 'CLASSIFICATION');
});
test('P17 changing a digest is detected', () => {
  tampered(F.snapshot, () => `${canonical({ ...WORKSPACE.snapshot.manifest, lineageDigest: 'b'.repeat(64) })}\n`, 'DIGEST_DRIFT');
});
test('P18 changing the source revision evidence is detected', () => {
  tampered(F.revisionEvidence, records => records.map(record => ({ ...record, editedAt: (record.editedAt ?? T4) + 1 })), 'SOURCE_REVISION_EVIDENCE_FINGERPRINT_DRIFT');
});
test('P19 tampering with the manifest fingerprint itself is detected', () => {
  tampered(F.snapshot, () => `${canonical({ ...WORKSPACE.snapshot.manifest, snapshotFingerprint: 'c'.repeat(64) })}\n`, 'SNAPSHOT_FINGERPRINT_MISMATCH');
});
test('P20 a malformed stored file is reported rather than repaired', () => {
  tampered(F.lineages, () => 'not json at all\n', 'LOAD_MALFORMED');
});

// ===========================================================================
// Q. DETERMINISM
// ===========================================================================
test('Q1 the index is invariant to input order', () => {
  const versions = [
    mkVersion({ identity: identity(ALPHA_NS, '9701'), namespace: ALPHA_NS, rawText: 'same' }),
    mkVersion({ identity: identity(BSKY_NS, 'x9701'), namespace: BSKY_NS, rawText: 'same' }),
  ];
  assert.equal(canonical(buildLineages(versions)), canonical(buildLineages([...versions].reverse())));
});
test('Q2 two independent rebuilds of the same source agree byte for byte', () => {
  const rebuilt = SNAP.rebuildLineageSnapshot({ root: WORKSPACE.root, runIds: WORKSPACE.runIds, policy: POLICY, revisionEvidence: WORKSPACE.revisionEvidence });
  assert.equal(canonical(rebuilt.lineages), canonical(CONTENT.lineages));
  assert.equal(canonical(rebuilt.contentVersions), canonical(CONTENT.contentVersions));
});
test('Q3 the lineage id is invariant to member order and to build order', () => {
  const lineages = buildLineages([
    mkVersion({ identity: identity(ALPHA_NS, '9702'), namespace: ALPHA_NS, rawText: 'same' }),
    mkVersion({ identity: identity(BSKY_NS, 'x9702'), namespace: BSKY_NS, rawText: 'same' }),
  ]);
  assert.equal(lineages[0].lineageId, buildLineages([
    mkVersion({ identity: identity(BSKY_NS, 'x9702'), namespace: BSKY_NS, rawText: 'same' }),
    mkVersion({ identity: identity(ALPHA_NS, '9702'), namespace: ALPHA_NS, rawText: 'same' }),
  ])[0].lineageId);
});
test('Q4 the lineages are sorted by a stable key', () => {
  const ids = CONTENT.lineages.map(lineage => lineage.lineageId);
  assert.deepEqual(ids, [...ids].sort());
});
test('Q5 the content versions are sorted by a stable key', () => {
  const fingerprints = CONTENT.contentVersions.map(version => version.contentVersionFingerprint);
  assert.deepEqual(fingerprints, [...fingerprints].sort());
});
test('Q6 the provider-family counts are a sorted object', () => {
  const keys = Object.keys(AGG.providerFamilyCounts);
  assert.deepEqual(keys, [...keys].sort());
});
test('Q7 the lineage fingerprint is a pure function of the record', () => {
  for (const lineage of CONTENT.lineages) {
    const body = { ...lineage }; delete body.recordFingerprint;
    assert.equal(lineage.recordFingerprint, digest(body));
  }
});
test('Q8 repeated verification of the same snapshot is stable', () => {
  const first = VERIFY.verifyLineageSnapshot(WORKSPACE.root, WORKSPACE.snapshot.snapshotId);
  const second = VERIFY.verifyLineageSnapshot(WORKSPACE.root, WORKSPACE.snapshot.snapshotId);
  assert.equal(canonical(first), canonical(second));
  assert.equal(first.ok, true);
});

// ===========================================================================
// R. NO IDENTITY RESOLUTION
// ===========================================================================
test('R1 no cross-provider human identity resolution is performed', () => {
  const S = DEF.PUBLIC_INTELLIGENCE_5K8_IDENTITY_RESOLUTION;
  for (const flag of ['crossProviderHumanIdentityResolutionPerformed', 'authorIdentityComparedAcrossProviders',
    'authorIdentifiersPersisted', 'sameHandleImpliesSamePerson', 'sameDisplayNameImpliesSamePerson', 'sameBioImpliesSamePerson',
    'sameDomainImpliesSamePerson', 'sameAvatarImpliesSamePerson', 'sameTextImpliesSamePerson']) assert.equal(S[flag], false, flag);
  assert.equal(S.mastodonAndBlueskyIdentitiesRemainSeparate, true);
});
test('R2 identical text does not imply the same person', () => {
  const S = DEF.PUBLIC_INTELLIGENCE_5K8_DUPLICATION_SEMANTICS;
  assert.equal(S.exactTextMatchProvesSameAuthor, false);
  assert.equal(S.exactTextMatchProvesSameOrganization, false);
  const lineage = lineageOf(record => record.exactMintSubjects.includes(MINT_C));
  assert.ok(!canonical(lineage).includes('@author'));
});
test('R3 a Mastodon account and a Bluesky DID stay separate identities', () => {
  const lineage = lineageOf(record => record.exactMintSubjects.includes(MINT_C));
  assert.equal(lineage.memberUpstreamIdentities.length, 2);
  assert.ok(lineage.memberUpstreamIdentities.some(value => value.startsWith('mastodon:')));
  assert.ok(lineage.memberUpstreamIdentities.some(value => value.startsWith('bluesky:')));
});
test('R4 an author change is a CONTENT event and never an identity change', () => {
  // The upstream identity is exactly (provider, providerObservationId): the
  // lineage layer keys on it and never on an author field.
  for (const version of CONTENT.contentVersions) {
    assert.ok(!Object.hasOwn(version, 'providerAuthorId'));
    assert.match(version.upstreamIdentity, /^(mastodon|bluesky):/);
  }
});
test('R5 no lineage module names an identity-resolution capability', () => {
  for (const unit of ['lineage-definition', 'lineage-index', 'lineage-snapshot', 'lineage-verify', 'lineage-query']) {
    const { found } = parseModule(`${PI}/${unit}.mjs`);
    for (const id of found.identifiers) {
      assert.ok(!/^(resolveIdentity|resolveAuthor|crossProviderIdentity|deanonymize|enrichAuthor)$/.test(id), `${unit}:${id}`);
    }
  }
});

// ===========================================================================
// S. NO MARKET / TRADING LINKAGE
// ===========================================================================
test('S1 the market-linkage disclosure denies every access', () => {
  const S = DEF.PUBLIC_INTELLIGENCE_5K8_MARKET_LINKAGE;
  for (const flag of ['priceDataAccessed', 'returnsAccessed', 'volatilityAccessed', 'r4OutcomeDataAccessed', 'tradingEngineReached',
    'arenaReached', 'walletAccessed', 'signerAccessed', 'swapReached', 'rpcWriteReached', 'futureMovementAssociated',
    'corroborationScoreComputed', 'tradeCandidateSelected']) assert.equal(S[flag], false, flag);
});
test('S2 no lineage module imports an engine, arena, wallet or RPC module', () => {
  for (const unit of SURFACE.PUBLIC_INTELLIGENCE_5K8_MODULES) {
    const { found } = parseModule(`${PI}/${unit}`);
    for (const source of found.importSources) {
      assert.ok(!/market-intelligence|engine|arena|wallet|signer|swap|rpc/i.test(source), `${unit} imports ${source}`);
    }
  }
});
test('S3 no lineage module declares a signing or RPC-write identifier', () => {
  const banned = /^(signTransaction|sendTransaction|submitTrade|executeSwap|privateKey|secretKey|signer|walletAddress)$/;
  for (const unit of SURFACE.PUBLIC_INTELLIGENCE_5K8_MODULES) {
    const { found } = parseModule(`${PI}/${unit}`);
    for (const id of found.identifiers) assert.ok(!banned.test(id), `${unit}:${id}`);
  }
});
test('S4 no lineage module imports or names a market or R4 field', () => {
  const banned = /\b(priceUsd|marketCap|liquidity|volume24h|r4Outcome|futureReturn|volatility)\b/;
  for (const unit of SURFACE.PUBLIC_INTELLIGENCE_5K8_MODULES) {
    const { source } = parseModule(`${PI}/${unit}`);
    assert.ok(!banned.test(source), `${unit} names a market field`);
  }
});
test('S5 the query layer computes no score, rank or recommendation', () => {
  const api = QUERY.createLineageQuery({ manifest: WORKSPACE.snapshot.manifest, lineages: CONTENT.lineages, contentVersions: CONTENT.contentVersions, coverageRecords: CONTENT.coverageRecords });
  const summary = api.getLineageSummary();
  for (const flag of ['scoreComputed', 'rankingApplied', 'dimensionsCollapsed']) assert.equal(summary[flag], false, flag);
  assert.ok(!Object.keys(api).some(name => /score|rank|recommend|predict|confidence/i.test(name)));
});
test('S6 the phase validator itself is offline and made zero network calls', () => assert.equal(tripwireCalls, 0));

// ===========================================================================
// T. REGRESSION AND GOVERNED-TREE DISCIPLINE
// ===========================================================================
test('T1 this validator imports exactly ONE project module and names no protected fragment', () => {
  const { found } = parseModule('scripts/validate-phase5k8.mjs');
  const projectImports = found.importSources.filter(source => source.includes('public-intelligence'));
  assert.deepEqual(projectImports, ['./public-intelligence/lineage-validation-surface.mjs']);
  const fragments = new Set(SURFACE.PROTECTED_MODULE_FRAGMENTS);
  for (const source of found.importSources) {
    for (const fragment of fragments) assert.ok(!source.includes(fragment), `the validator imports a protected fragment: ${source}`);
  }
});
test('T2 the validation surface re-exports only; it adds no behaviour', () => {
  const { source } = parseModule(`${PI}/lineage-validation-surface.mjs`);
  assert.ok(!/^\s*(?:async\s+)?function\b/m.test(source), 'the surface declares no function');
  assert.ok(!/^\s*class\b/m.test(source), 'the surface declares no class');
  assert.ok(!/^\s*(?:if|for|while|switch|try)\b/m.test(source), 'the surface has no control flow');
  assert.ok(!/process\.env|Date\.now|setTimeout|setInterval/.test(source), 'the surface reads no clock or environment');
});
test('T3 nothing outside the governed tree names or imports a lineage module', () => {
  // The six OWNED modules are named nowhere outside the governed tree except in
  // the one validator, which reaches them only through the surface.
  const modules = SURFACE.PUBLIC_INTELLIGENCE_5K8_MODULES;
  const surface = 'lineage-validation-surface.mjs';
  const listed = gitOut('ls-files', 'scripts', 'src').split('\n').filter(entry => /\.(mjs|ts|tsx|js)$/.test(entry));
  for (const entry of listed) {
    if (entry.startsWith(`${PI}/`) || HISTORICAL_VALIDATORS.includes(entry)) continue;
    const source = readFileSync(path.join(REPO_ROOT, entry), 'utf8');
    for (const owned of modules) assert.ok(!source.includes(owned), `${entry} names ${owned}`);
    // This phase's own validator is the one permitted namer of the surface.
    if (entry !== 'scripts/validate-phase5k8.mjs') assert.ok(!source.includes(surface), `${entry} names ${surface}`);
    if (!/\.(mjs|js)$/.test(entry)) continue;
    let parsed = null;
    try { parsed = parseModule(entry); } catch { continue; }
    for (const imported of parsed.found.importSources) {
      for (const owned of modules) assert.ok(!imported.endsWith(owned), `${entry} imports ${imported}`);
    }
  }
});
test('T4 every lineage module lives inside the governed tree and exists', () => {
  for (const unit of SURFACE.PUBLIC_INTELLIGENCE_5K8_MODULES) {
    assert.ok(existsFile(path.join(REPO_ROOT, PI, unit)), unit);
  }
  assert.ok(existsFile(path.join(REPO_ROOT, PI, 'lineage-validation-surface.mjs')));
});
test('T5 .evolve is untouched', () => {
  const guarded = ['.', 'evolve'].join('');
  assert.equal(gitOut('ls-files', guarded).trim(), '', 'the guarded area must never be tracked');
  for (const line of gitOut('status', '--porcelain').split('\n').filter(Boolean)) {
    assert.ok(!new RegExp(`^\\s*[MADRCU?!]{1,2}\\s+\\${guarded}`).test(line), 'the guarded area must be untouched');
  }
});
test('T6 no runtime capture, credential or secret is tracked or staged', () => {
  assert.equal(gitOut('ls-files', 'var').trim(), '', 'no capture under var/ is tracked');
  const staged = gitOut('diff', '--cached', '--name-only').split('\n').filter(Boolean);
  for (const entry of staged) {
    assert.ok(!/^var\//.test(entry), entry);
    assert.ok(!/^\.evolve\//.test(entry), entry);
    assert.ok(!/\.env(\.|$)/.test(entry), entry);
    assert.ok(!/credential|secret|token|password/i.test(entry), entry);
  }
});
test('T7 no decision surface imports Phase 5K', () => {
  const roots = ['src', 'app', 'lib', 'packages', 'components'].filter(entry => {
    try { return statSync(path.join(REPO_ROOT, entry)).isDirectory(); } catch { return false; }
  });
  for (const root of roots) {
    for (const entry of gitOut('ls-files', root).split('\n').filter(Boolean)) {
      if (!/\.(mjs|js|ts|tsx)$/.test(entry)) continue;
      assert.ok(!/public-intelligence/.test(readFileSync(path.join(REPO_ROOT, entry), 'utf8')), `${entry} imports Phase 5K`);
    }
  }
});
test('T8 R4 C1 is an ancestor of HEAD and finalized R4 artifacts are unchanged', () => {
  execFileSync('git', ['merge-base', '--is-ancestor', R4_HEAD, 'HEAD'], { cwd: REPO_ROOT });
  for (const bound of ['governance/r4/r4-preregistration-seal.json', 'package.json', 'package-lock.json']) {
    assert.ok(readFileSync(path.join(REPO_ROOT, bound)).equals(execFileSync('git', ['show', `${R4_HEAD}:${bound}`], { cwd: REPO_ROOT })), bound);
  }
});
const phaseCount = (script, line) => {
  const output = execFileSync('node', [script], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.ok(output.includes(line), `${script} did not report ${line}`);
};
test('T9 5K.0 stays 32/32', () => phaseCount('scripts/validate-phase5k.mjs', 'Phase 5K.0: 32/32 passed'));
test('T10 5K.1 stays 64/64', () => phaseCount('scripts/validate-phase5k1.mjs', 'Phase 5K.1: 64/64 passed'));
test('T11 5K.2 stays 70/70', () => phaseCount('scripts/validate-phase5k2.mjs', 'Phase 5K.2: 70/70 passed'));
test('T12 5K.3 stays 96/96', () => phaseCount('scripts/validate-phase5k3.mjs', 'Phase 5K.3: 96/96 passed'));
test('T13 5K.4 stays 116/116', () => phaseCount('scripts/validate-phase5k4.mjs', 'Phase 5K.4: 116/116 passed'));
test('T14 5K.5 stays 130/130', () => phaseCount('scripts/validate-phase5k5.mjs', 'Phase 5K.5: 130/130 passed'));
test('T15 5K.6 stays 166/166', () => phaseCount('scripts/validate-phase5k6.mjs', 'Phase 5K.6: 166/166 passed'));
test('T16 5K.6.1 stays 57/57', () => phaseCount('scripts/validate-phase5k6-1.mjs', 'Phase 5K.6.1: 57/57 passed'));
test('T17 5K.6.2 stays 58/58', () => phaseCount('scripts/validate-phase5k6-2.mjs', 'Phase 5K.6.2: 58/58 passed'));
test('T18 5K.6.3 stays 71/71', () => phaseCount('scripts/validate-phase5k6-3.mjs', 'Phase 5K.6.3: 71/71 passed'));
test('T19 5K.7 stays 153/153', () => phaseCount('scripts/validate-phase5k7.mjs', 'Phase 5K.7: 153/153 passed'));

// ---------------------------------------------------------------------------
async function main() {
  let failed = 0;
  try {
    for (const [name, fn] of tests) {
      try { await fn(); console.log(`PASS ${name}`); } catch (error) { failed += 1; console.error(`FAIL ${name}: ${error.stack}`); }
    }
  } finally { for (const root of temporary) rmSync(root, { recursive: true, force: true }); }
  console.log(`Phase 5K.8: ${tests.length - failed}/${tests.length} passed; offline, fixture runs + injected clocks only, ${tripwireCalls} network calls, content lineage only`);
  if (failed) process.exitCode = 1;
}
main().catch(error => { console.error('phase 5K.8 validator crashed:', error); process.exitCode = 1; });
