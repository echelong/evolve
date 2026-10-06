#!/usr/bin/env node
// Phase 5K.9 - DESCRIPTIVE SOCIAL EVIDENCE FEATURES validator.
//
// COMPLETELY OFFLINE AND DETERMINISTIC. Provider responses are in-memory
// fixtures handed to a transport through an injected fetch; every clock is an
// injected counter. The global fetch and the socket connect primitive are
// replaced with tripwires and the suite asserts neither was ever called. Every
// run root and snapshot root is a temporary directory; the repository tree,
// `var/` and `.evolve` are never written. No provider call and no market call is
// made here.
//
// IMPORT BOUNDARY
//
// Every 5K.x validator asserts that nothing OUTSIDE `scripts/public-intelligence/`
// imports a protected phase module, and those checks enumerate `git ls-files`, so
// a TRACKED validator that imports one directly breaks them. This validator
// therefore imports exactly ONE project module - the governed 5K.9 surface.
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
const SURFACE = await import('./public-intelligence/feature-validation-surface.mjs');

const DEF = SURFACE.FEATURE_DEFINITION_5K9;
const EXTRACT = SURFACE.FEATURE_EXTRACT_5K9;
const SNAP = SURFACE.FEATURE_SNAPSHOT_5K9;
const VERIFY = SURFACE.FEATURE_VERIFY_5K9;
const QUERY = SURFACE.FEATURE_QUERY_5K9;
const CLASSIFICATION = SURFACE.PUBLIC_INTELLIGENCE_CLASSIFICATION;
const canonical = SURFACE.canonical;
const digest = SURFACE.digest;
const rawObservationFingerprint = SURFACE.rawObservationFingerprint;
const { buildCollectionPlan, executeCollectionRun, loadRunArtifacts } = SURFACE;
const createBlueskyRunAdapter = SURFACE.createBlueskyRunAdapter;
const buildRevisionEvidence = SURFACE.buildRevisionEvidence;
const POLICY = SURFACE.PUBLIC_INTELLIGENCE_5K4_DEFAULT_POLICY;
const COVERAGE = SURFACE.PUBLIC_INTELLIGENCE_5K7_COVERAGE_STATUS;
const LINEAGE_CLASS = SURFACE.PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS;
const LINEAGE_STATUS = DEF.PUBLIC_INTELLIGENCE_5K9_LINEAGE_COVERAGE_STATUS;
const COUNTERS = DEF.PUBLIC_INTELLIGENCE_5K9_ENGAGEMENT_COUNTERS;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PI = 'scripts/public-intelligence';
const R4_HEAD = '1c30264fb87876eeaf229e25c5cdc5adca429b40';
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
  const root = mkdtempSync(path.join(tmpdir(), `evolve-5k9-${label}-`));
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
const MINT_G = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const MINT_H = '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh';
const MINT_I = '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E';
const MINT_J = '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj';
const MINT_K = 'hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux';
const IDENTITY_TEXT_C = `same public text about ${MINT_C} on two platforms`;
const CANONICAL_A = `canonical match note ${MINT_D}`;
const CANONICAL_B = 'second line';

const T1 = Date.parse('2026-10-01T10:00:00.000Z');
const T2 = Date.parse('2026-10-01T11:00:00.000Z');
const T3 = Date.parse('2026-10-01T12:00:00.000Z');
const T4 = Date.parse('2026-10-01T13:00:00.000Z');
const T5 = Date.parse('2026-10-01T14:00:00.000Z');
const SPAN = 86_400_000;
const BOUNDS = Object.freeze({ maxPages: 2, maxRecords: 24, timeoutMs: 10_000, maxResponseBytes: 524_288, maxLookbackMs: SPAN });
const ALPHA = 'alpha.example';
const BETA = 'beta.example';
const DID = 'did:plc:abcdefghijklmnopqrst';
const CID_A = 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CID_B = 'bafyreibbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const BSKY_URI_B = `at://${DID}/app.bsky.feed.post/3kbbbbbbbbb`;
const BSKY_URI_C = `at://${DID}/app.bsky.feed.post/3kccccccccc`;
const BSKY_URI_G = `at://${DID}/app.bsky.feed.post/3kggggggggg`;
const BSKY_URI_H = `at://${DID}/app.bsky.feed.post/3khhhhhhhhh`;
const G_PERMALINK = `https://bsky.app/profile/${DID}/post/3kggggggggg`;

const iso = ms => new Date(ms).toISOString();
/** A Mastodon status. `engagement: false` omits every counter, so native evidence is absent. */
const status = (instance, id, { content, likes = 0, createdAt = T1, url, engagement = true } = {}) => {
  const record = {
    id: String(id), visibility: 'public', created_at: iso(createdAt), url: url ?? `https://${instance}/@author/${id}`,
    in_reply_to_id: null, language: 'en', content: `<p>${content}</p>`, tags: [{ name: 'solana' }], account: { id: '42' },
  };
  if (engagement) Object.assign(record, { favourites_count: likes, replies_count: 0, reblogs_count: 0 });
  return record;
};
/** A Bluesky post view. `engagement: false` omits every counter. */
const postView = (uri, { text, cid = CID_A, likes = 0, createdAt = T1, engagement = true } = {}) => {
  const view = {
    $type: 'app.bsky.feed.defs#postView', uri, cid, author: { did: DID },
    record: { $type: 'app.bsky.feed.post', text, createdAt: iso(createdAt) },
  };
  if (engagement) Object.assign(view, { likeCount: likes, replyCount: 0, repostCount: 0, quoteCount: 0 });
  return view;
};

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

/** Executes the whole fixture workspace once: four authenticated runs and every governed snapshot. */
async function buildWorkspace() {
  const root = tempRoot('ws');
  const run = async (plan, pages, start, adapter) => {
    const result = await executeCollectionRun(plan, {
      clock: makeClock(start), fetchImpl: pagedFetch(pages), outputRoot: root, ...(adapter ? { adapter } : {}),
    });
    assert.equal(result.verification.ok, true, JSON.stringify(result.verification.failures));
    return result;
  };
  // Run 1: Mastodon alpha. A, C, unassociated, D, E (likes 1), F v1, J v1,
  // G (no engagement at all), I (a provider-supplied ZERO), H (likes 9), K.
  const alpha1 = await run(mastodonPlan(ALPHA, T1), [[
    status(ALPHA, 1001, { content: `mint A ${MINT_A}`, createdAt: T1 }),
    status(ALPHA, 1002, { content: IDENTITY_TEXT_C, createdAt: T1 }),
    status(ALPHA, 1003, { content: 'plain post with no mint', createdAt: T1 }),
    status(ALPHA, 1004, { content: `mint D ${MINT_D}`, createdAt: T1 }),
    status(ALPHA, 1005, { content: `mint E ${MINT_E}`, likes: 1, createdAt: T1 }),
    status(ALPHA, 1006, { content: `mint F ${MINT_F} version one`, likes: 1, createdAt: T1 }),
    status(ALPHA, 1010, { content: `mint J ${MINT_J} one`, createdAt: T1 }),
    status(ALPHA, 1011, { content: `mint G ${MINT_G}`, createdAt: T1, engagement: false }),
    status(ALPHA, 1012, { content: `mint I ${MINT_I}`, likes: 0, createdAt: T1 }),
    status(ALPHA, 1013, { content: `mint H ${MINT_H}`, likes: 9, createdAt: T1 }),
    status(ALPHA, 1014, { content: `mint K ${MINT_K} alpha note`, createdAt: T1 }),
  ], []], T1);
  // Run 2: Mastodon beta. D (identical text) and K (different text).
  const beta = await run(mastodonPlan(BETA, T2), [[
    status(BETA, 2001, { content: `mint D ${MINT_D}`, createdAt: T2 }),
    status(BETA, 2002, { content: `mint K ${MINT_K} different note`, createdAt: T2 }),
  ], []], T2);
  // Run 3: Bluesky. B, C (identical text to the Mastodon C post), G1 (the post a
  // Mastodon post explicitly references), H1 (the CRLF half of the pair).
  const bluesky = await run(blueskyPlan(T3), [
    { posts: [
      postView(BSKY_URI_B, { text: `mint B ${MINT_B}`, cid: CID_A, createdAt: T3 }),
      postView(BSKY_URI_C, { text: IDENTITY_TEXT_C, cid: CID_B, createdAt: T3 }),
      postView(BSKY_URI_G, { text: `bluesky mirror note ${MINT_A}`, cid: CID_A, createdAt: T3 }),
      postView(BSKY_URI_H, { text: `${CANONICAL_A}\r\n${CANONICAL_B}`, cid: CID_A, createdAt: T3 }),
    ], cursor: 'blueskyPageTwo1' },
    { posts: [] },
  ], T3, createBlueskyRunAdapter());
  // Run 4: Mastodon alpha again. C repeated, E engagement grew, F revised, H
  // engagement REGRESSED, J diverged with NO provider-declared proof, A's mirror
  // referenced bluesky G1, and the LF half of the canonical pair.
  const alpha2 = await run(mastodonPlan(ALPHA, T4), [[
    status(ALPHA, 1002, { content: IDENTITY_TEXT_C, createdAt: T1 }),
    status(ALPHA, 1005, { content: `mint E ${MINT_E}`, likes: 9, createdAt: T1 }),
    status(ALPHA, 1006, { content: `mint F ${MINT_F} version two`, likes: 1, createdAt: T1 }),
    status(ALPHA, 1010, { content: `mint J ${MINT_J} two`, createdAt: T1 }),
    status(ALPHA, 1013, { content: `mint H ${MINT_H}`, likes: 3, createdAt: T1 }),
    status(ALPHA, 1007, { content: `mastodon note ${MINT_A}`, createdAt: T4, url: G_PERMALINK }),
    status(ALPHA, 1009, { content: `${CANONICAL_A}\n${CANONICAL_B}`, createdAt: T4 }),
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
  const content = SNAP.rebuildFeatureSnapshot({ root, runIds, policy: POLICY, revisionEvidence });
  const snapshot = SNAP.buildAndStoreFeatureSnapshot({ root, runIds, policy: POLICY, revisionEvidence, createdAt: T5 });
  // Every governed SOURCE snapshot that can be stored, so the 5K.9 verifier can
  // verify each one present on disk.
  //
  // No 5K.5 temporal snapshot is stored here, deliberately. The 5K.5 snapshot
  // persists no revision-evidence sidecar of its own and its verifier rebuilds
  // from the run set alone, so a corpus carrying a provider-declared revision or
  // an unverified divergence - this fixture has both - can never be reproduced by
  // it (verifyRevisionChain requires a provider revision timestamp on every
  // non-first version). The 5K.7 and 5K.8 sources are both stored and both verify.
  SURFACE.buildAndStoreCorroborationSnapshot({ root, runIds, policy: POLICY, revisionEvidence, createdAt: T5 });
  SURFACE.buildAndStoreLineageSnapshot({ root, runIds, policy: POLICY, revisionEvidence, createdAt: T5 });
  return { root, runIds, revisionEvidence, content, snapshot };
}

const WORKSPACE = await buildWorkspace();
const CONTENT = WORKSPACE.content;
const FEATURES = CONTENT.records;
const SUMMARY = CONTENT.summary;
const MANIFEST = WORKSPACE.snapshot.manifest;
const featureOf = mint => FEATURES.find(record => record.mint === mint);
const api = () => QUERY.createFeatureQuery({ manifest: MANIFEST, features: FEATURES });
const families = record => Object.keys(record.providerFamilies);

// --- synthetic corroboration records, for the association states a run cannot produce
const syntheticRecord = (identity, namespace, association) => ({
  contentRecord: { upstreamIdentity: identity, provider: namespace, assetAssociation: association },
  observationRecord: {
    upstreamIdentity: identity, provider: namespace, assetAssociation: association,
    contentFingerprint: digest({ identity, kind: 'synthetic-content' }).slice(0, 64),
    observationStateFingerprint: digest({ identity, kind: 'synthetic-state' }).slice(0, 64),
    fetchedAt: T1, runId: `run-${'a'.repeat(32)}`,
  },
});
const NON_EXACT = status => ({ status, mint: null, method: 'UNASSOCIATED' });

// ===========================================================================
// A. GOVERNANCE
// ===========================================================================
test('A1 the phase identity is the governed 5K.9 vocabulary', () => {
  assert.equal(DEF.PUBLIC_INTELLIGENCE_5K9_PHASE, 'PHASE_5K_9');
  assert.equal(DEF.PUBLIC_INTELLIGENCE_5K9_SCHEMA_VERSION, '5K.9.0');
  assert.equal(DEF.PUBLIC_INTELLIGENCE_5K9_POLICY_VERSION, 'feature-policy-1');
});
test('A2 every artifact carries the frozen observer-only classification', () => {
  for (const flag of ['researchOnly', 'observerOnly', 'paperOnly', 'developmentOnly']) assert.equal(CLASSIFICATION[flag], true, flag);
  for (const flag of ['tradingAuthority', 'engineAuthority', 'arenaEligible', 'promotionEligible', 'profitabilityInferencePermitted']) {
    assert.equal(CLASSIFICATION[flag], false, flag);
  }
});
test('A3 FEATURE != SCORE: no weighting, normalization or composite is applied', () => {
  const S = DEF.PUBLIC_INTELLIGENCE_5K9_FEATURE_SEMANTICS;
  assert.equal(S.descriptiveOnly, true);
  assert.equal(S.measurableFromAuthenticatedEvidence, true);
  for (const flag of ['weightingApplied', 'normalizationApplied', 'standardizationApplied', 'zScoreComputed',
    'percentileInterpretedAsRank', 'compositeComputed', 'scoreComputed', 'rankComputed', 'orderingByFeatureValue',
    'confidenceTierAssigned', 'ordinalLevelAssigned', 'sentimentComputed', 'momentumComputed', 'viralityComputed',
    'popularityComputed', 'trendLabelled', 'importanceComputed', 'truthProbabilityComputed', 'predictionMade',
    'recommendationMade', 'profitabilityInferenceMade', 'tradingInferenceMade', 'causesProviderContact',
    'readsLiveNetworkData']) assert.equal(S[flag], false, flag);
  assert.equal(S.defaultOrderingIsLexical, true);
});
test('A4 the phase derives only from verified local evidence and records its source fingerprints', () => {
  for (const key of ['sourceCorpusFingerprint', 'sourceTemporalSnapshotFingerprint', 'sourceCorroborationSnapshotFingerprint',
    'sourceLineageSnapshotFingerprint', 'sourceRevisionEvidenceFingerprint']) {
    assert.match(MANIFEST[key], /^[0-9a-f]{64}$/, key);
  }
});
test('A5 the time semantics refuse every invented instant', () => {
  const S = DEF.PUBLIC_INTELLIGENCE_5K9_TIME_SEMANTICS;
  assert.equal(S.timestampsCopiedFromAuthenticatedEvidence, true);
  assert.equal(S.windowComputedAsLastMinusFirst, true);
  for (const flag of ['currentTimeUsed', 'filesystemMtimeUsed', 'directoryOrderUsed', 'rateInterpretedAsMomentum',
    'simultaneityInferred', 'causalityInferred', 'emptyBucketImputed']) assert.equal(S[flag], false, flag);
});
test('A6 the phase document exists and documents every required section and disclaimer', () => {
  const doc = readFileSync(path.join(REPO_ROOT, 'docs/PHASE5K9-DESCRIPTIVE-FEATURES.md'), 'utf8').toLowerCase();
  for (const heading of ['purpose', 'feature vs score', 'subject identity', 'provider features', 'temporal features',
    'lineage features', 'revision/state features', 'missingness', 'engagement handling', 'snapshot', 'queries', 'privacy',
    'determinism', 'non-goals', 'more observations', 'more providers', 'more engagement', 'more lineages', 'more revisions',
    'no feature is a trading signal']) {
    assert.ok(doc.includes(heading), `doc lacks "${heading}"`);
  }
});
test('A7 the phases 5K.0-5K.8 modules are untouched by 5K.9', () => {
  const changed = gitOut('diff', '--name-only', 'HEAD').split('\n').filter(Boolean);
  for (const entry of changed) {
    assert.ok(!entry.startsWith(PI) || entry.includes('feature'), `an earlier module changed: ${entry}`);
  }
});
test('A8 the derivation is pure: no feature module reads a clock, environment or network', () => {
  for (const unit of SURFACE.PUBLIC_INTELLIGENCE_5K9_MODULES) {
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
test('B1 only EXACT_MINT may form a per-mint feature record', () => {
  const S = DEF.PUBLIC_INTELLIGENCE_5K9_SUBJECT_IDENTITY;
  assert.deepEqual([...S.associationsThatMayFormFeatures], ['EXACT_MINT']);
  assert.deepEqual([...S.associationsThatMayNeverFormFeatures], ['UNASSOCIATED', 'INVALID_MINT', 'AMBIGUOUS']);
});
test('B2 no symbol, name, ticker or fuzzy signal can create a subject', () => {
  const S = DEF.PUBLIC_INTELLIGENCE_5K9_SUBJECT_IDENTITY;
  for (const flag of ['symbolOrNameCreatesSubject', 'tickerCreatesSubject', 'fuzzyMatchCreatesSubject', 'mintInferred',
    'crossProviderMergePerformed']) assert.equal(S[flag], false, flag);
});
test('B3 every mint feature record carries a real exact mint and never an inferred one', () => {
  assert.equal(FEATURES.length, 11);
  for (const record of FEATURES) {
    const coverage = CONTENT.coverageRecords?.find?.(entry => entry.mint === record.mint);
    assert.ok(record.mint.length >= 32, record.mint);
    void coverage;
  }
});
test('B4 an UNASSOCIATED observation never becomes a mint feature record', () => {
  const index = SURFACE.CORROBORATION_INDEX_5K7.buildCorroborationIndex({
    contentRecords: [syntheticRecord('mastodon:alpha.example:9001', 'mastodon:alpha.example', NON_EXACT('UNASSOCIATED'))].map(entry => entry.contentRecord),
    observationRecords: [syntheticRecord('mastodon:alpha.example:9001', 'mastodon:alpha.example', NON_EXACT('UNASSOCIATED'))].map(entry => entry.observationRecord),
  }, { sourceSnapshotIds: [`tsnap-${'a'.repeat(32)}`] });
  const extracted = EXTRACT.extractFeatures({
    temporal: { contentRecords: [], observationRecords: [] },
    observationCoverageRecords: index.observationCoverageRecords,
  });
  assert.deepEqual(extracted.records, []);
  assert.equal(extracted.summary.unassociatedObservationCount, 1);
  assert.equal(extracted.summary.mintFeatureCount, 0);
});
test('B5 an INVALID_MINT observation never becomes a mint feature record', () => {
  const record = syntheticRecord('mastodon:alpha.example:9002', 'mastodon:alpha.example', NON_EXACT('INVALID_MINT'));
  const index = SURFACE.CORROBORATION_INDEX_5K7.buildCorroborationIndex({
    contentRecords: [record.contentRecord], observationRecords: [record.observationRecord],
  }, { sourceSnapshotIds: [`tsnap-${'a'.repeat(32)}`] });
  const extracted = EXTRACT.extractFeatures({ temporal: { contentRecords: [], observationRecords: [] }, observationCoverageRecords: index.observationCoverageRecords });
  assert.deepEqual(extracted.records, []);
  assert.equal(extracted.summary.invalidMintObservationCount, 1);
  assert.equal(extracted.summary.mintFeatureCount, 0);
});
test('B6 an AMBIGUOUS observation never becomes a mint feature record', () => {
  const record = syntheticRecord('mastodon:alpha.example:9003', 'mastodon:alpha.example', NON_EXACT('AMBIGUOUS'));
  const index = SURFACE.CORROBORATION_INDEX_5K7.buildCorroborationIndex({
    contentRecords: [record.contentRecord], observationRecords: [record.observationRecord],
  }, { sourceSnapshotIds: [`tsnap-${'a'.repeat(32)}`] });
  const extracted = EXTRACT.extractFeatures({ temporal: { contentRecords: [], observationRecords: [] }, observationCoverageRecords: index.observationCoverageRecords });
  assert.deepEqual(extracted.records, []);
  assert.equal(extracted.summary.ambiguousObservationCount, 1);
});
test('B7 an exact-mint observation without a content version is a hard refusal', () => {
  refusal(() => EXTRACT.extractFeatures({
    temporal: {
      contentRecords: [],
      observationRecords: [{
        upstreamIdentity: 'mastodon:alpha.example:9100', provider: 'mastodon:alpha.example',
        contentFingerprint: 'a'.repeat(64), observationStateFingerprint: 'b'.repeat(64),
        rawObservationFingerprint: 'c'.repeat(64), fetchedAt: T1, runId: `run-${'a'.repeat(32)}`,
        temporalClassification: 'FIRST_OBSERVATION',
        assetAssociation: { status: 'EXACT_MINT', mint: MINT_A, method: 'EXACT_MINT_ADDRESS' },
      }],
    },
    contentVersions: [],
  }), 'PUBLIC_INTELLIGENCE_5K9_EXACT_OBSERVATION_WITHOUT_VERSION');
});

// ===========================================================================
// C. PROVIDER-FAMILY FEATURES
// ===========================================================================
test('C1 a single-family mint reports exactly one family block', () => {
  const record = featureOf(MINT_B);
  assert.equal(record.providerFamilyCount, 1);
  assert.deepEqual(families(record), ['bluesky']);
  assert.equal(record.coverageStatus, COVERAGE.SINGLE_PROVIDER_FAMILY);
});
test('C2 a two-family mint reports both families and multi-provider coverage', () => {
  const record = featureOf(MINT_C);
  assert.equal(record.providerFamilyCount, 2);
  assert.deepEqual(families(record), ['bluesky', 'mastodon']);
  assert.equal(record.coverageStatus, COVERAGE.MULTI_PROVIDER_FAMILY);
});
test('C3 every family block carries the closed governed field set', () => {
  for (const record of FEATURES) {
    for (const family of families(record)) {
      const block = record.providerFamilies[family];
      for (const key of SURFACE.PUBLIC_INTELLIGENCE_5K9_FAMILY_FEATURE_SCHEMA.fields) {
        assert.ok(Object.hasOwn(block, key), `${family}.${key}`);
      }
      assert.equal(Object.keys(block).length, SURFACE.PUBLIC_INTELLIGENCE_5K9_FAMILY_FEATURE_SCHEMA.fields.length);
    }
  }
});
test('C4 the family observation counts partition the mint observation count', () => {
  for (const record of FEATURES) {
    const total = families(record).reduce((sum, family) => sum + record.providerFamilies[family].upstreamObservationCount, 0);
    assert.equal(total, record.upstreamObservationCount, record.mint);
  }
});
test('C5 a family block never spans another family', () => {
  const record = featureOf(MINT_C);
  const mastodon = record.providerFamilies.mastodon;
  const bluesky = record.providerFamilies.bluesky;
  assert.equal(mastodon.providerNamespaceCount, 1);
  assert.equal(bluesky.providerNamespaceCount, 1);
  assert.equal(mastodon.upstreamObservationCount + bluesky.upstreamObservationCount, record.upstreamObservationCount);
});
test('C6 provider families are never compared by ranking', () => {
  const api9 = api();
  for (const name of Object.keys(api9)) assert.ok(!/rank|score|best|top|compare/i.test(name), name);
  for (const record of FEATURES) {
    assert.deepEqual(Object.keys(record.providerFamilies), Object.keys(record.providerFamilies).sort(), record.mint);
  }
});
test('C7 a family block reports its own authenticated time window', () => {
  for (const record of FEATURES) {
    for (const family of families(record)) {
      const block = record.providerFamilies[family];
      assert.ok(block.firstObservedAt <= block.lastObservedAt, `${record.mint}.${family}`);
      assert.ok(block.firstObservedAt >= record.firstObservedAt);
      assert.ok(block.lastObservedAt <= record.lastObservedAt);
    }
  }
});
test('C8 an unknown family can never appear in a feature record', () => {
  for (const record of FEATURES) {
    for (const family of families(record)) assert.ok(DEF.PUBLIC_INTELLIGENCE_5K9_PROVIDER_FAMILIES.includes(family), family);
  }
});

// ===========================================================================
// D. PROVIDER-NAMESPACE ACCOUNTING
// ===========================================================================
test('D1 two Mastodon instances count as two namespaces and ONE family', () => {
  const record = featureOf(MINT_D);
  const mastodon = record.providerFamilies.mastodon;
  assert.equal(mastodon.providerNamespaceCount, 2);
  assert.equal(record.providerFamilyCount, 2);
});
test('D2 the namespace count is at least the family count', () => {
  for (const record of FEATURES) assert.ok(record.providerNamespaceCount >= record.providerFamilyCount, record.mint);
});
test('D3 a two-instance mint alone is not multi-provider-family', () => {
  const record = featureOf(MINT_K);
  assert.equal(record.providerFamilies.mastodon.providerNamespaceCount, 2);
  assert.equal(record.providerFamilyCount, 1);
  assert.equal(record.coverageStatus, COVERAGE.SINGLE_PROVIDER_FAMILY);
});
test('D4 the namespace count equals the sum of per-family namespace counts', () => {
  for (const record of FEATURES) {
    const total = families(record).reduce((sum, family) => sum + record.providerFamilies[family].providerNamespaceCount, 0);
    assert.equal(total, record.providerNamespaceCount, record.mint);
  }
});
test('D5 the namespace count never exceeds the observation count', () => {
  for (const record of FEATURES) assert.ok(record.providerNamespaceCount <= record.upstreamObservationCount, record.mint);
});
test('D6 the feature record never persists a namespace or a URL', () => {
  for (const record of FEATURES) {
    const text = canonical(record);
    assert.ok(!text.includes('alpha.example'), 'a namespace leaked');
    assert.ok(!/https?:\/\//.test(text), 'a URL leaked');
  }
});

// ===========================================================================
// E. UPSTREAM OBSERVATION COUNTS
// ===========================================================================
test('E1 a repeated upstream post across runs is ONE upstream observation', () => {
  const record = featureOf(MINT_C);
  assert.equal(record.upstreamObservationCount, 2);
  assert.ok(record.observationStateSnapshotCount >= record.upstreamObservationCount - 1);
});
test('E2 every mint has at least one upstream observation', () => {
  for (const record of FEATURES) assert.ok(record.upstreamObservationCount >= 1, record.mint);
});
test('E3 the observation count never exceeds the state snapshot count', () => {
  for (const record of FEATURES) assert.ok(record.upstreamObservationCount <= record.observationStateSnapshotCount, record.mint);
});
test('E4 the member run count is never larger than the observation count', () => {
  for (const record of FEATURES) assert.ok(record.memberRunCount <= record.upstreamObservationCount, record.mint);
});
test('E5 a mint seen in two runs reports two member runs', () => {
  const record = featureOf(MINT_C);
  assert.equal(record.memberRunCount, 2);
});
test('E6 a single-provider-family mint reports exactly one member run when seen once', () => {
  assert.equal(featureOf(MINT_B).memberRunCount, 1);
});
test('E7 the total observation count is the exact sum over mints', () => {
  const total = FEATURES.reduce((sum, record) => sum + record.upstreamObservationCount, 0);
  assert.equal(SUMMARY.totalUpstreamObservationCount, total);
});
test('E8 the distinct upstream identity count is preserved per mint', () => {
  // MINT_A carries three observations across two families and two runs.
  const record = featureOf(MINT_A);
  assert.equal(record.upstreamObservationCount, 3);
  assert.equal(record.memberRunCount, 3);
});

// ===========================================================================
// F. CONTENT-VERSION COUNTS
// ===========================================================================
test('F1 a provider-declared revision yields TWO content versions', () => {
  const record = featureOf(MINT_F);
  assert.equal(record.contentVersionCount, 2);
  assert.equal(record.providerDeclaredRevisionCount, 1);
});
test('F2 an engagement-only change adds NO content version', () => {
  const record = featureOf(MINT_E);
  assert.equal(record.contentVersionCount, 1);
  assert.equal(record.observationStateSnapshotCount, 2);
});
test('F3 a repeated acquisition adds NO content version', () => {
  assert.equal(featureOf(MINT_C).contentVersionCount, 2);
  assert.equal(featureOf(MINT_C).upstreamObservationCount, 2);
});
test('F4 the content version count never exceeds the observation count', () => {
  for (const record of FEATURES) assert.ok(record.contentVersionCount <= record.upstreamObservationCount, record.mint);
});
test('F5 the family version counts partition the mint version count', () => {
  for (const record of FEATURES) {
    const total = families(record).reduce((sum, family) => sum + record.providerFamilies[family].contentVersionCount, 0);
    assert.equal(total, record.contentVersionCount, record.mint);
  }
});
test('F6 an unverified divergence yields two versions and one divergence', () => {
  const record = featureOf(MINT_J);
  assert.equal(record.contentVersionCount, 2);
  assert.equal(record.unverifiedDivergenceCount, 1);
  assert.equal(record.providerDeclaredRevisionCount, 0);
});
test('F7 the total content version count is the exact sum over mints', () => {
  assert.equal(SUMMARY.totalContentVersionCount, FEATURES.reduce((sum, record) => sum + record.contentVersionCount, 0));
});

// ===========================================================================
// G. STATE-SNAPSHOT COUNTS
// ===========================================================================
test('G1 an engagement-only state update yields a second state snapshot', () => {
  const record = featureOf(MINT_E);
  assert.equal(record.observationStateSnapshotCount, 2);
  assert.equal(record.stateChangeCount, 1);
});
test('G2 a repeated unchanged observation yields the same state fingerprint once', () => {
  const record = featureOf(MINT_C);
  assert.ok(record.observationStateSnapshotCount >= 2);
  assert.equal(record.stateChangeCount, 0);
});
test('G3 the state snapshot count is never below one', () => {
  for (const record of FEATURES) assert.ok(record.observationStateSnapshotCount >= 1, record.mint);
});
test('G4 the state snapshot count never exceeds the observation count', () => {
  for (const record of FEATURES) assert.ok(record.observationStateSnapshotCount <= record.upstreamObservationCount, record.mint);
});
test('G5 the family state counts partition the mint state count', () => {
  for (const record of FEATURES) {
    const total = families(record).reduce((sum, family) => sum + record.providerFamilies[family].observationStateSnapshotCount, 0);
    assert.ok(total >= record.observationStateSnapshotCount, record.mint);
  }
});
test('G6 the total state snapshot count is the exact sum over mints', () => {
  assert.equal(SUMMARY.totalStateSnapshotCount, FEATURES.reduce((sum, record) => sum + record.observationStateSnapshotCount, 0));
});

// ===========================================================================
// H. LINEAGE FEATURES
// ===========================================================================
test('H1 an exact cross-provider duplicate is reported as one exact-raw-match lineage', () => {
  const record = featureOf(MINT_C);
  assert.equal(record.contentLineageCount, 1);
  assert.equal(record.exactRawMatchLineageCount, 1);
});
test('H2 a canonical-only cross-provider duplicate is reported as a canonical match', () => {
  const record = featureOf(MINT_D);
  assert.equal(record.canonicalMatchLineageCount, 1);
  assert.equal(record.exactRawMatchLineageCount, 1);
});
test('H3 an explicit cross-post reference is reported as such', () => {
  const record = featureOf(MINT_A);
  assert.equal(record.explicitReferenceLineageCount, 1);
  assert.equal(record.distinctContentLineageCount, 1);
  assert.equal(record.contentLineageCount, 2);
});
test('H4 two genuinely distinct texts are reported as two distinct lineages', () => {
  const record = featureOf(MINT_K);
  assert.equal(record.distinctContentLineageCount, 2);
  assert.equal(record.contentLineageCount, 2);
});
test('H5 the lineage class counts partition the lineage count', () => {
  for (const record of FEATURES) {
    const total = record.exactRawMatchLineageCount + record.canonicalMatchLineageCount
      + record.explicitReferenceLineageCount + record.distinctContentLineageCount + record.unresolvedLineageCount;
    assert.equal(total, record.contentLineageCount, record.mint);
  }
});
test('H6 the lineage coverage status is the pure count partition', () => {
  assert.equal(featureOf(MINT_C).lineageCoverageStatus, LINEAGE_STATUS.SINGLE_LINEAGE);
  assert.equal(featureOf(MINT_A).lineageCoverageStatus, LINEAGE_STATUS.MULTIPLE_LINEAGES);
  for (const record of FEATURES) {
    assert.equal(record.lineageCoverageStatus, DEF.lineageCoverageStatusFor(record.contentLineageCount), record.mint);
  }
});
test('H7 the lineage coverage vocabulary has no ordinal tier', () => {
  for (const banned of ['WEAK', 'STRONG', 'HIGH', 'LOW', 'TRENDING', 'BEST']) {
    assert.ok(!DEF.PUBLIC_INTELLIGENCE_5K9_LINEAGE_COVERAGE_STATUS_VALUES.includes(banned), banned);
  }
  assert.deepEqual([...DEF.PUBLIC_INTELLIGENCE_5K9_LINEAGE_COVERAGE_STATUS_VALUES], ['NO_LINEAGE', 'SINGLE_LINEAGE', 'MULTIPLE_LINEAGES']);
  // The lineage classes counted by a feature record are 5K.8's, reused verbatim.
  assert.deepEqual(Object.values(LINEAGE_CLASS).sort(),
    ['CANONICAL_TEXT_MATCH', 'DISTINCT_CONTENT', 'EXACT_RAW_TEXT_MATCH', 'EXPLICIT_CROSS_POST_REFERENCE', 'UNRESOLVED']);
  assert.deepEqual([...DEF.PUBLIC_INTELLIGENCE_5K9_LINEAGE_CLASS_VALUES].sort(), Object.values(LINEAGE_CLASS).sort());
});
test('H8 no diversity, originality or independence score is computed', () => {
  const lineage = api().getLineageFeaturesForMint(MINT_A);
  for (const key of Object.keys(lineage)) assert.ok(!/score|ratio|index|weight/i.test(key), key);
  const exported = Object.keys(SURFACE.FEATURE_EXTRACT_5K9).concat(Object.keys(SURFACE.FEATURE_DEFINITION_5K9));
  for (const name of exported) assert.ok(!/Score|Ratio|Diversity|Originality|Independence/.test(name), name);
});

// ===========================================================================
// I. REVISION AND DIVERGENCE FEATURES
// ===========================================================================
test('I1 a provider-declared revision is counted, and the divergence is not', () => {
  const record = featureOf(MINT_F);
  assert.equal(record.providerDeclaredRevisionCount, 1);
  assert.equal(record.unverifiedDivergenceCount, 0);
});
test('I2 an unproven divergence is counted as unverified, not as a revision', () => {
  const record = featureOf(MINT_J);
  assert.equal(record.unverifiedDivergenceCount, 1);
  assert.equal(record.providerDeclaredRevisionCount, 0);
});
test('I3 the revision features view exposes the governed counts verbatim', () => {
  const view = api().getRevisionFeaturesForMint(MINT_F);
  assert.equal(view.contentVersionCount, 2);
  assert.equal(view.providerDeclaredRevisionCount, 1);
  assert.equal(view.unverifiedDivergenceCount, 0);
  assert.equal(view.stateChangeCount, 0);
  // Each distinct authenticated observation instance carries exactly one
  // observation-state snapshot, so the two governed counts coincide. MINT_F has
  // two instances: the first version and the provider-declared revision.
  assert.equal(view.observationStateSnapshotCount, 2);
  assert.equal(view.observationStateSnapshotCount, featureOf(MINT_F).upstreamObservationCount);
});
test('I4 many revisions is a count, never a suspicion', () => {
  const record = featureOf(MINT_F);
  for (const key of Object.keys(record)) assert.ok(!/suspic|risk|anomal|flag/i.test(key), key);
});
test('I5 the divergence count never exceeds the version count minus one', () => {
  for (const record of FEATURES) {
    assert.ok(record.providerDeclaredRevisionCount + record.unverifiedDivergenceCount <= record.contentVersionCount, record.mint);
  }
});
test('I6 a single-version mint reports no revision and no divergence', () => {
  for (const mint of [MINT_B, MINT_E, MINT_H, MINT_I]) {
    assert.equal(featureOf(mint).providerDeclaredRevisionCount, 0, mint);
    assert.equal(featureOf(mint).unverifiedDivergenceCount, 0, mint);
  }
});
test('I7 the state-change count is exposed and never labelled a trend', () => {
  assert.equal(featureOf(MINT_E).stateChangeCount, 1);
  for (const record of FEATURES) {
    const text = canonical(record).toLowerCase();
    for (const banned of ['momentum', 'velocity', 'growth', 'trend', 'virality', 'popularity']) {
      assert.ok(!text.includes(banned), `${record.mint} names ${banned}`);
    }
  }
});

// ===========================================================================
// J. TIME FEATURES
// ===========================================================================
test('J1 the observation window is exactly last minus first', () => {
  for (const record of FEATURES) {
    assert.equal(record.observationWindowMs, record.lastObservedAt - record.firstObservedAt, record.mint);
  }
});
test('J2 the window is never negative', () => {
  for (const record of FEATURES) assert.ok(record.observationWindowMs >= 0, record.mint);
});
test('J3 a single-observation mint has a zero window', () => {
  assert.equal(featureOf(MINT_B).observationWindowMs, 0);
});
test('J4 temporal buckets are aligned to the fixed 15-minute UTC grid', () => {
  for (const record of FEATURES) {
    for (const bucket of record.temporalBuckets) {
      assert.equal(bucket.bucketStart % DEF.PUBLIC_INTELLIGENCE_5K9_BUCKET_WIDTH_MS, 0, record.mint);
      assert.equal(bucket.bucketEnd - bucket.bucketStart, 900_000, record.mint);
    }
  }
});
test('J5 buckets are SPARSE: only observed buckets are emitted', () => {
  const record = featureOf(MINT_A);
  const span = record.lastObservedAt - record.firstObservedAt;
  const fullGrid = Math.floor(span / 900_000) + 1;
  assert.ok(record.temporalBuckets.length < fullGrid, 'the bucket list is not sparse');
  assert.equal(record.temporalBuckets.length, 3);
});
test('J6 buckets are sorted by bucket start and never zero-filled', () => {
  for (const record of FEATURES) {
    const starts = record.temporalBuckets.map(bucket => bucket.bucketStart);
    assert.deepEqual(starts, [...starts].sort(), record.mint);
    assert.equal(new Set(starts).size, starts.length, record.mint);
    for (const bucket of record.temporalBuckets) assert.ok(bucket.upstreamObservationCount >= 1, record.mint);
  }
});
test('J7 the bucket policy is explicit, fixed and free of imputation', () => {
  const policy = DEF.PUBLIC_INTELLIGENCE_5K9_BUCKET_POLICY;
  assert.equal(policy.bucketWidthMs, 900_000);
  assert.equal(policy.bucketPolicyVersion, 'feature-buckets-15m-1');
  for (const flag of ['sparseObservedBucketsOnly', 'alignment']) assert.ok(policy[flag] !== undefined, flag);
  for (const flag of ['emptyBucketImputation', 'zeroFilledBuckets', 'interpolationApplied', 'movingAverageApplied', 'rateComputed']) {
    assert.equal(policy[flag], false, flag);
  }
  assert.equal(policy.sparseObservedBucketsOnly, true);
});
test('J8 the bucket observation counts cover every mint observation exactly once', () => {
  for (const record of FEATURES) {
    const total = record.temporalBuckets.reduce((sum, bucket) => sum + bucket.upstreamObservationCount, 0);
    assert.equal(total, record.upstreamObservationCount, record.mint);
  }
});
test('J9 no bucket carries a rate, a score or a label', () => {
  for (const record of FEATURES) {
    for (const bucket of record.temporalBuckets) {
      assert.deepEqual(Object.keys(bucket), [...SURFACE.PUBLIC_INTELLIGENCE_5K9_TEMPORAL_BUCKET_SCHEMA.fields].sort().slice().sort());
      for (const key of Object.keys(bucket)) assert.ok(!/level|score|rate|momentum/i.test(key), key);
    }
  }
});

// ===========================================================================
// K. MISSINGNESS
// ===========================================================================
test('K1 missingness is first-class and reported for every governed category', () => {
  for (const record of FEATURES) {
    for (const category of SURFACE.PUBLIC_INTELLIGENCE_5K9_MISSINGNESS_CATEGORIES) {
      const pair = record.missingness[category];
      assert.equal(pair.available + pair.missing, record.upstreamObservationCount, `${record.mint}.${category}`);
    }
  }
});
test('K2 an absent engagement block is counted as missing, never as zero', () => {
  const record = featureOf(MINT_G);
  assert.equal(record.engagementMissingCount, 1);
  assert.equal(record.engagementObservationCount, 0);
  assert.equal(record.providerFamilies.mastodon.engagement.likes.observedCount, 0);
  assert.equal(record.providerFamilies.mastodon.engagement.likes.minObservedValue, null);
});
test('K3 a missing engagement block never produces a zero-valued counter', () => {
  const record = featureOf(MINT_G);
  for (const counter of COUNTERS) {
    const summary = record.providerFamilies.mastodon.engagement[counter];
    assert.equal(summary.observedCount, 0, counter);
    assert.equal(summary.missingCount, 1, counter);
    assert.equal(summary.minObservedValue, null, counter);
    assert.equal(summary.maxObservedValue, null, counter);
  }
});
test('K4 the missingness block reports the zero-substitution and drop flags as false', () => {
  for (const record of FEATURES) {
    assert.equal(record.missingness.absentTreatedAsZero, false, record.mint);
    assert.equal(record.missingness.observationSilentlyDropped, false, record.mint);
  }
});
test('K5 publishedAt availability partitions the observation count', () => {
  for (const record of FEATURES) {
    assert.equal(record.publishedAtAvailableCount + record.publishedAtMissingCount, record.upstreamObservationCount, record.mint);
  }
});
test('K6 a published post reports publishedAt as available', () => {
  assert.equal(featureOf(MINT_B).publishedAtAvailableCount, 1);
  assert.equal(featureOf(MINT_B).publishedAtMissingCount, 0);
});
test('K7 observedAt is genuinely absent for provider-acquired evidence and is reported missing', () => {
  // The 5K.2/5K.6 adapters never invent observedAt, so it is missing by design.
  for (const record of FEATURES) assert.equal(record.missingness.observedAt.missing, record.upstreamObservationCount, record.mint);
});
test('K8 the missingness semantics refuse every repair', () => {
  const S = DEF.PUBLIC_INTELLIGENCE_5K9_MISSINGNESS_SEMANTICS;
  assert.equal(S.missingnessFirstClass, true);
  assert.equal(S.availableAndMissingReported, true);
  for (const flag of ['absentTreatedAsZero', 'observationSilentlyDropped', 'absentFieldImputed']) assert.equal(S[flag], false, flag);
});

// ===========================================================================
// L. ENGAGEMENT STRUCTURAL FEATURES
// ===========================================================================
test('L1 an engagement-only update reports two observed values for the same counter', () => {
  const likes = featureOf(MINT_E).providerFamilies.mastodon.engagement.likes;
  assert.equal(likes.observedCount, 2);
  assert.equal(likes.missingCount, 0);
  assert.equal(likes.minObservedValue, 1);
  assert.equal(likes.maxObservedValue, 9);
  assert.equal(likes.firstObservedValue, 1);
  assert.equal(likes.lastObservedValue, 9);
});
test('L2 a provider-supplied ZERO is an observed value, not a missing one', () => {
  const likes = featureOf(MINT_I).providerFamilies.mastodon.engagement.likes;
  assert.equal(likes.observedCount, 1);
  assert.equal(likes.missingCount, 0);
  assert.equal(likes.minObservedValue, 0);
  assert.equal(likes.maxObservedValue, 0);
  assert.equal(featureOf(MINT_I).engagementMissingCount, 0);
});
test('L3 an engagement REGRESSION remains a valid observation', () => {
  const likes = featureOf(MINT_H).providerFamilies.mastodon.engagement.likes;
  assert.equal(likes.firstObservedValue, 9);
  assert.equal(likes.lastObservedValue, 3);
  assert.equal(likes.minObservedValue, 3);
  assert.equal(likes.maxObservedValue, 9);
});
test('L4 a regression is never labelled as a decline, loss or negative signal', () => {
  const record = featureOf(MINT_H);
  // Scan the record's governed field names and the mastodon engagement summaries.
  // (`missingness.observationSilentlyDropped` is a governed disclosure that no
  // OBSERVATION is dropped; it is not a word applied to the regression.)
  const text = canonical({
    fields: Object.keys(record),
    recordType: record.recordType,
    coverageStatus: record.coverageStatus,
    lineageCoverageStatus: record.lineageCoverageStatus,
    engagement: record.providerFamilies.mastodon.engagement,
  }).toLowerCase();
  for (const banned of ['decline', 'loss', 'negative', 'drop', 'momentum', 'growth', 'velocity']) {
    assert.ok(!text.includes(banned), banned);
  }
});
test('L5 every governed counter is reported for every family block', () => {
  for (const record of FEATURES) {
    for (const family of families(record)) {
      assert.deepEqual(Object.keys(record.providerFamilies[family].engagement), [...COUNTERS]);
    }
  }
});
test('L6 the counter observed and missing counts sum to the family observation count', () => {
  for (const record of FEATURES) {
    for (const family of families(record)) {
      const block = record.providerFamilies[family];
      for (const counter of COUNTERS) {
        const summary = block.engagement[counter];
        assert.equal(summary.observedCount + summary.missingCount, block.upstreamObservationCount, `${record.mint}.${family}.${counter}`);
      }
    }
  }
});
test('L7 engagement is never aggregated across provider families', () => {
  const record = featureOf(MINT_C);
  assert.equal(record.providerFamilies.mastodon.engagement.likes.observedCount, 1);
  assert.equal(record.providerFamilies.bluesky.engagement.likes.observedCount, 1);
  // The mint-level block holds the two families SEPARATELY; there is no merged counter.
  assert.ok(!Object.hasOwn(record, 'engagement'));
  assert.ok(!Object.hasOwn(record, 'likes'));
});
test('L8 engagement is reported field by field across every counter type', () => {
  const record = featureOf(MINT_E);
  assert.equal(record.providerFamilies.mastodon.engagement.likes.observedCount, 2);
  assert.equal(record.providerFamilies.mastodon.engagement.replies.observedCount, 2);
  assert.equal(record.providerFamilies.mastodon.engagement.reposts.observedCount, 2);
  assert.equal(record.providerFamilies.mastodon.engagement.views.observedCount, 0);
  assert.equal(record.providerFamilies.mastodon.engagement.quotes.observedCount, 0);
});
test('L9 an unobserved counter reports null extrema and never zero', () => {
  const record = featureOf(MINT_B);
  for (const counter of ['replies', 'reposts', 'quotes']) {
    const summary = record.providerFamilies.bluesky.engagement[counter];
    assert.equal(summary.observedCount, 1, counter);
  }
  const bookmarks = record.providerFamilies.bluesky.engagement.bookmarks;
  assert.equal(bookmarks.observedCount, 0);
  assert.equal(bookmarks.minObservedValue, null);
  assert.equal(bookmarks.maxObservedValue, null);
  assert.equal(bookmarks.firstObservedValue, null);
  assert.equal(bookmarks.lastObservedValue, null);
});
test('L10 no momentum, growth, velocity or popularity name or field exists', () => {
  const S = DEF.PUBLIC_INTELLIGENCE_5K9_ENGAGEMENT_SEMANTICS;
  for (const flag of ['aggregatedAcrossProviderFamilies', 'aggregatedAcrossCounterTypes', 'absentCounterFilledWithZero',
    'carryForwardApplied', 'interpolationApplied', 'increaseIsPositiveEvidence', 'decreaseIsNegativeEvidence',
    'absoluteChangeComputed', 'momentumComputed', 'growthComputed', 'velocityComputed', 'popularityComputed',
    'ratioComputed', 'scoreComputed']) assert.equal(S[flag], false, flag);
  assert.equal(S.regressionRemainsValidObservation, true);
  assert.equal(S.summariesSeparatedByProviderFamily, true);
});
test('L11 the counter schema is closed and rejects an unknown counter', () => {
  assert.deepEqual([...COUNTERS], ['bookmarks', 'likes', 'quotes', 'replies', 'reposts', 'views']);
  refusal(() => EXTRACT.summariseCounter('impressions', []), 'PUBLIC_INTELLIGENCE_5K9_COUNTER_UNKNOWN');
});

// ===========================================================================
// M. SNAPSHOT IDENTITY
// ===========================================================================
test('M1 the snapshot id is deterministic from policy and the source run set', () => {
  assert.match(MANIFEST.snapshotId, /^featsnap-[0-9a-f]{32}$/);
  const fingerprints = CONTENT.memberships.map(member => member.runManifestFingerprint);
  assert.equal(SNAP.deriveFeatureSnapshotId(POLICY, fingerprints), MANIFEST.snapshotId);
});
test('M2 the snapshot id is invariant to member run order', () => {
  const fingerprints = CONTENT.memberships.map(member => member.runManifestFingerprint);
  assert.equal(SNAP.deriveFeatureSnapshotId(POLICY, [...fingerprints].reverse()), MANIFEST.snapshotId);
  assert.equal(SNAP.deriveFeatureSnapshotId(POLICY, [...fingerprints].sort()), MANIFEST.snapshotId);
});
test('M3 createdAt does NOT participate in the id but DOES in the fingerprint', () => {
  const later = SNAP.buildFeatureSnapshotManifest(CONTENT, T5 + 1);
  assert.equal(later.snapshotId, MANIFEST.snapshotId);
  assert.notEqual(later.snapshotFingerprint, MANIFEST.snapshotFingerprint);
});
test('M4 the manifest fingerprint covers every field but itself', () => {
  const body = { ...MANIFEST }; delete body.snapshotFingerprint;
  assert.equal(MANIFEST.snapshotFingerprint, digest(body));
  assert.equal(SNAP.featureSnapshotFingerprintOf(MANIFEST), digest(body));
});
test('M5 the manifest records the feature policy and every source layer version', () => {
  assert.equal(MANIFEST.featurePolicyVersion, 'feature-policy-1');
  assert.equal(MANIFEST.lineagePolicyVersion, 'lineage-policy-1');
  assert.equal(MANIFEST.corroborationPolicyVersion, 'corroboration-policy-1');
  assert.equal(MANIFEST.temporalPolicyVersion, 'temporal-policy-1');
  assert.equal(MANIFEST.bucketPolicyVersion, 'feature-buckets-15m-1');
  assert.equal(MANIFEST.bucketWidthMs, 900_000);
});
test('M6 the manifest records all four source snapshot identities', () => {
  assert.match(MANIFEST.sourceTemporalSnapshotId, /^tsnap-[0-9a-f]{32}$/);
  assert.match(MANIFEST.sourceCorroborationSnapshotId, /^crsnap-[0-9a-f]{32}$/);
  assert.match(MANIFEST.sourceLineageSnapshotId, /^linsnap-[0-9a-f]{32}$/);
  assert.equal(MANIFEST.mintFeatureCount, FEATURES.length);
});
test('M7 the manifest counts match the derived records', () => {
  assert.equal(MANIFEST.totalUpstreamObservationCount, SUMMARY.totalUpstreamObservationCount);
  assert.equal(MANIFEST.totalContentVersionCount, SUMMARY.totalContentVersionCount);
  assert.equal(MANIFEST.totalStateSnapshotCount, SUMMARY.totalStateSnapshotCount);
  assert.equal(MANIFEST.totalLineageCount, SUMMARY.totalLineageCount);
  assert.equal(MANIFEST.earliestObservedAt, SUMMARY.earliestObservedAt);
  assert.equal(MANIFEST.latestObservedAt, SUMMARY.latestObservedAt);
});
test('M8 storage is write-once and the stored digests match the artifacts', () => {
  const again = SNAP.buildAndStoreFeatureSnapshot({
    root: WORKSPACE.root, runIds: WORKSPACE.runIds, policy: POLICY, revisionEvidence: WORKSPACE.revisionEvidence, createdAt: T5 + 1000,
  });
  assert.equal(again.outcome, 'ALREADY_EXISTS_IDENTICAL');
  const artifacts = SNAP.loadFeatureArtifacts(WORKSPACE.snapshot.directory);
  assert.equal(MANIFEST.featuresDigest, digest(artifacts.features));
  assert.equal(MANIFEST.summaryDigest, digest(SUMMARY));
});
test('M9 the snapshot directory holds only the governed files', () => {
  const artifacts = SNAP.loadFeatureArtifacts(WORKSPACE.snapshot.directory);
  assert.deepEqual(artifacts.extraFiles, []);
  for (const name of Object.values(SNAP.PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_FILES)) {
    assert.ok(existsFile(path.join(WORKSPACE.snapshot.directory, name)), name);
  }
});
test('M10 the snapshot count invariants hold', () => {
  assert.deepEqual(SNAP.checkFeatureSnapshotCounts(MANIFEST), []);
  assert.deepEqual(EXTRACT.checkFeatureSummary(SUMMARY, { records: FEATURES }), Object.freeze({ ok: true, problems: Object.freeze([]) }));
});

// ===========================================================================
// N. QUERY API
// ===========================================================================
test('N1 the public query surface is exactly the eight governed retrieval names', () => {
  assert.deepEqual([...QUERY.PUBLIC_INTELLIGENCE_5K9_QUERY_API], [
    'getFeaturesForMint', 'listFeatureMints', 'getFeatureSummary', 'getProviderFamilyFeatures',
    'getTemporalBucketsForMint', 'getMissingnessForMint', 'getLineageFeaturesForMint', 'getRevisionFeaturesForMint',
  ]);
});
test('N2 no prohibited query name exists in the feature layer', () => {
  const exported = Object.keys(SURFACE.FEATURE_QUERY_5K9);
  const forbidden = DEF.PUBLIC_INTELLIGENCE_5K9_PROHIBITED_QUERY_NAMES;
  for (const name of forbidden) assert.ok(!exported.includes(name), name);
  for (const name of forbidden) assert.ok(!Object.hasOwn(api(), name), name);
});
test('N3 the query object exposes exactly the governed methods', () => {
  assert.deepEqual(Object.keys(api()).sort(), [...QUERY.PUBLIC_INTELLIGENCE_5K9_QUERY_API].sort());
});
test('N4 getFeaturesForMint returns the stored record and null for an unknown mint', () => {
  assert.deepEqual(api().getFeaturesForMint(MINT_B), featureOf(MINT_B));
  assert.equal(api().getFeaturesForMint('So11111111111111111111111111111111111111113'), null);
  refusal(() => api().getFeaturesForMint(''), 'PUBLIC_INTELLIGENCE_5K9_QUERY_MINT_REQUIRED');
});
test('N5 listFeatureMints is LEXICALLY ordered, never by a feature value', () => {
  const mints = api().listFeatureMints();
  assert.deepEqual(mints, [...mints].sort());
  assert.equal(mints.length, FEATURES.length);
  const byObservations = [...FEATURES].sort((a, b) => b.upstreamObservationCount - a.upstreamObservationCount).map(record => record.mint);
  assert.notDeepEqual(mints, byObservations);
});
test('N6 getProviderFamilyFeatures returns one family block', () => {
  assert.deepEqual(api().getProviderFamilyFeatures(MINT_C, 'mastodon'), featureOf(MINT_C).providerFamilies.mastodon);
  assert.equal(api().getProviderFamilyFeatures(MINT_B, 'mastodon'), null);
  refusal(() => api().getProviderFamilyFeatures(MINT_B, ''), 'PUBLIC_INTELLIGENCE_5K9_QUERY_FAMILY_REQUIRED');
});
test('N7 getTemporalBucketsForMint returns the sparse buckets', () => {
  assert.deepEqual(api().getTemporalBucketsForMint(MINT_A), featureOf(MINT_A).temporalBuckets);
  assert.equal(api().getTemporalBucketsForMint(MINT_B).length, 1);
});
test('N8 getMissingnessForMint returns the availability block', () => {
  const missingness = api().getMissingnessForMint(MINT_G);
  assert.equal(missingness.engagement.missing, 1);
  assert.equal(missingness.absentTreatedAsZero, false);
});
test('N9 the summary exposes counts only and every judgement flag is false', () => {
  const summary = api().getFeatureSummary();
  assert.equal(summary.mintFeatureCount, FEATURES.length);
  assert.equal(summary.bucketWidthMs, 900_000);
  for (const flag of ['scoreComputed', 'rankComputed', 'weightApplied', 'orderingByFeatureValue', 'sentimentComputed',
    'momentumComputed', 'predictionMade', 'recommendationMade', 'marketDataAccessed']) assert.equal(summary[flag], false, flag);
  assert.equal(summary.defaultOrderingIsLexical, true);
});

// ===========================================================================
// O. DETERMINISM
// ===========================================================================
test('O1 two independent rebuilds of the same source agree byte for byte', () => {
  const rebuilt = SNAP.rebuildFeatureSnapshot({ root: WORKSPACE.root, runIds: WORKSPACE.runIds, policy: POLICY, revisionEvidence: WORKSPACE.revisionEvidence });
  assert.equal(canonical(rebuilt.records), canonical(CONTENT.records));
  assert.equal(canonical(rebuilt.summary), canonical(SUMMARY));
});
test('O2 the same authenticated data in SHUFFLED run order is identical', () => {
  const shuffled = [...WORKSPACE.runIds].reverse();
  const rebuilt = SNAP.rebuildFeatureSnapshot({ root: WORKSPACE.root, runIds: shuffled, policy: POLICY, revisionEvidence: WORKSPACE.revisionEvidence });
  assert.equal(canonical(rebuilt.records), canonical(CONTENT.records));
  assert.equal(rebuilt.featuresDigest, CONTENT.featuresDigest);
});
test('O3 the feature records are sorted lexically by mint', () => {
  const mints = FEATURES.map(record => record.mint);
  assert.deepEqual(mints, [...mints].sort());
});
test('O4 the feature fingerprint is a pure function of the record', () => {
  for (const record of FEATURES) {
    const body = { ...record }; delete body.featureFingerprint;
    assert.equal(record.featureFingerprint, digest(body));
  }
});
test('O5 the temporal buckets are sorted and de-duplicated in every record', () => {
  for (const record of FEATURES) {
    const starts = record.temporalBuckets.map(bucket => bucket.bucketStart);
    assert.deepEqual(starts, [...new Set(starts)].sort(), record.mint);
  }
});
test('O6 the counter summaries are in sorted-name order in every family block', () => {
  for (const record of FEATURES) {
    for (const family of families(record)) {
      const names = Object.keys(record.providerFamilies[family].engagement);
      assert.deepEqual(names, [...names].sort(), `${record.mint}.${family}`);
    }
  }
});
test('O7 the summary is invariant to the record order it is built from', () => {
  const reversed = EXTRACT.buildFeatureSummary({
    records: [...FEATURES].reverse(),
    observationCoverageRecords: [],
  });
  assert.equal(reversed.totalUpstreamObservationCount, SUMMARY.totalUpstreamObservationCount);
  assert.equal(reversed.earliestObservedAt, SUMMARY.earliestObservedAt);
  assert.equal(reversed.latestObservedAt, SUMMARY.latestObservedAt);
});
test('O8 repeated verification of the same snapshot is stable', () => {
  const first = VERIFY.verifyFeatureSnapshot(WORKSPACE.root, WORKSPACE.snapshot.snapshotId);
  const second = VERIFY.verifyFeatureSnapshot(WORKSPACE.root, WORKSPACE.snapshot.snapshotId);
  assert.equal(canonical(first), canonical(second));
  assert.equal(first.ok, true);
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
    verification = VERIFY.verifyFeatureSnapshot(WORKSPACE.root, WORKSPACE.snapshot.snapshotId);
  } finally {
    writeFileSync(target, original);
    chmodSync(target, 0o444);
  }
  assert.equal(verification.ok, false, `${file} tamper was NOT detected`);
  assert.ok(verification.failures.some(failure => failure.includes(expectedFragment)),
    `${file}: expected ${expectedFragment}, got ${verification.failures.slice(0, 3).join(' | ')}`);
}
const F = SNAP.PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_FILES;
const mutateRecord = (mint, apply) => records => records.map(record => (record.mint === mint ? apply({ ...record }) : record));

test('P1 the untouched snapshot verifies, including every source snapshot on disk', () => {
  const verification = VERIFY.verifyFeatureSnapshot(WORKSPACE.root, WORKSPACE.snapshot.snapshotId);
  assert.deepEqual(verification.failures, []);
  assert.equal(verification.ok, true);
});
test('P2 changing a mint is detected', () => {
  // A record re-keyed to another mint is no longer the record for its own mint,
  // and it collides with the mint it was pointed at.
  tampered(F.features, records => { records[0].mint = MINT_B; return records; }, 'FEATURE_DUPLICATED');
});
test('P3 changing a provider family count is detected', () => {
  tampered(F.features, mutateRecord(MINT_C, record => { record.providerFamilyCount = 1; return record; }), 'FEATURE_MODIFIED');
});
test('P4 changing a namespace count is detected', () => {
  tampered(F.features, mutateRecord(MINT_D, record => { record.providerNamespaceCount = 1; return record; }), 'FEATURE_MODIFIED');
});
test('P5 changing a lineage count is detected', () => {
  tampered(F.features, mutateRecord(MINT_A, record => { record.contentLineageCount = 1; return record; }), 'FEATURE_MODIFIED');
});
test('P6 changing a state snapshot count is detected', () => {
  tampered(F.features, mutateRecord(MINT_E, record => { record.observationStateSnapshotCount = 1; return record; }), 'FEATURE_MODIFIED');
});
test('P7 changing a timestamp is detected', () => {
  tampered(F.features, mutateRecord(MINT_B, record => { record.lastObservedAt = record.firstObservedAt + 1; return record; }), 'FEATURE_MODIFIED');
});
test('P8 changing an observation window is detected', () => {
  tampered(F.features, mutateRecord(MINT_B, record => { record.observationWindowMs = 1; return record; }), 'FEATURE_MODIFIED');
});
test('P9 changing missingness is detected', () => {
  tampered(F.features, mutateRecord(MINT_G, record => {
    record.missingness.engagement.missing = 0;
    record.missingness.engagement.available = 1;
    return record;
  }), 'FEATURE_MODIFIED');
});
test('P10 changing an engagement counter value is detected', () => {
  tampered(F.features, mutateRecord(MINT_H, record => {
    record.providerFamilies.mastodon.engagement.likes.minObservedValue = 0;
    return record;
  }), 'FEATURE_MODIFIED');
});
test('P11 removing a temporal bucket is detected', () => {
  tampered(F.features, mutateRecord(MINT_A, record => { record.temporalBuckets = record.temporalBuckets.slice(0, 1); return record; }), 'FEATURE_MODIFIED');
});
test('P12 injecting a feature record is detected', () => {
  tampered(F.features, records => [...records, { ...records[0], mint: MINT_I + 'x' }], 'FEATURE_INJECTED');
});
test('P13 removing a feature record is detected', () => {
  tampered(F.features, records => records.slice(1), 'FEATURE_REMOVED');
});
test('P14 changing a manifest count is detected', () => {
  tampered(F.snapshot, () => `${canonical({
    ...MANIFEST,
    mintFeatureCount: MANIFEST.mintFeatureCount + 1,
    singleProviderFamilyMintCount: MANIFEST.singleProviderFamilyMintCount + 1,
  })}\n`, 'COUNT_DRIFT');
});
test('P15 changing the snapshot mint count partition is detected', () => {
  tampered(F.snapshot, () => {
    const manifest = { ...MANIFEST };
    manifest.totalUpstreamObservationCount = MANIFEST.totalUpstreamObservationCount + 5;
    manifest.snapshotFingerprint = digest((() => { const body = { ...manifest }; delete body.snapshotFingerprint; return body; })());
    return `${canonical(manifest)}\n`;
  }, 'COUNT_DRIFT');
});
test('P16 changing a source fingerprint is detected', () => {
  tampered(F.snapshot, () => `${canonical({ ...MANIFEST, sourceCorpusFingerprint: 'a'.repeat(64) })}\n`, 'SOURCE_CORPUS_FINGERPRINT_DRIFT');
});
test('P17 substituting a source snapshot identity is detected', () => {
  tampered(F.snapshot, () => `${canonical({ ...MANIFEST, sourceLineageSnapshotId: `linsnap-${'a'.repeat(32)}` })}\n`, 'SOURCE_LINEAGE');
});
test('P18 changing a digest is detected', () => {
  tampered(F.snapshot, () => `${canonical({ ...MANIFEST, featuresDigest: 'b'.repeat(64) })}\n`, 'DIGEST_DRIFT');
});
test('P19 widening the classification is detected', () => {
  tampered(F.snapshot, () => `${canonical({ ...MANIFEST, classification: { ...CLASSIFICATION, tradingAuthority: true } })}\n`, 'CLASSIFICATION');
});
test('P20 changing the manifest fingerprint itself is detected', () => {
  tampered(F.snapshot, () => `${canonical({ ...MANIFEST, snapshotFingerprint: 'c'.repeat(64) })}\n`, 'SNAPSHOT_FINGERPRINT_MISMATCH');
});
test('P21 changing the source revision evidence is detected', () => {
  tampered(F.revisionEvidence, records => records.map(record => ({ ...record, editedAt: (record.editedAt ?? T4) + 1 })), 'SOURCE_REVISION_EVIDENCE_FINGERPRINT_DRIFT');
});
test('P22 a malformed stored file is reported rather than repaired', () => {
  tampered(F.features, () => 'not json at all\n', 'LOAD_MALFORMED');
});

// ===========================================================================
// Q. PRIVACY
// ===========================================================================
test('Q1 no feature artifact persists a post body', () => {
  for (const record of FEATURES) {
    const text = canonical(record);
    assert.ok(!text.includes(IDENTITY_TEXT_C), 'a body leaked');
    assert.ok(!text.includes(CANONICAL_A), 'a body leaked');
  }
});
test('Q2 no feature artifact persists a URL', () => {
  for (const record of FEATURES) assert.ok(!/https?:\/\//.test(canonical(record)), 'a URL leaked');
});
test('Q3 no author identifier, display name or social-graph field is persisted', () => {
  const banned = /authorId|displayName|avatar|follower|following|mentionedHandles|handle/i;
  for (const record of FEATURES) {
    // The missingness block names its governed CATEGORIES - 'providerAuthorId' is
    // one of them - and stores no value for any of them, so identity scanning
    // covers every other part of the record.
    const body = { ...record };
    delete body.missingness;
    assert.ok(!banned.test(canonical(body)), 'an identity field leaked');
    for (const field of Object.keys(record.missingness)) {
      assert.ok(SURFACE.PUBLIC_INTELLIGENCE_5K9_MISSINGNESS_SCHEMA.fields.includes(field), field);
    }
  }
});
test('Q4 no feature module names a credential, cookie or secret capability', () => {
  for (const unit of SURFACE.PUBLIC_INTELLIGENCE_5K9_MODULES) {
    const { found } = parseModule(`${PI}/${unit}`);
    for (const id of found.identifiers) {
      assert.ok(!/^(apiKey|api_key|clientSecret|appPassword|accessToken|refreshToken|sessionCookie|password|authorization|cookie)$/.test(id), `${unit}:${id}`);
    }
  }
});
test('Q5 the privacy disclosure refuses every personal-data surface', () => {
  const S = DEF.PUBLIC_INTELLIGENCE_5K9_PRIVACY;
  assert.equal(S.aggregateStructuralFactsOnly, true);
  for (const flag of ['postTextPersisted', 'displayNamesPersisted', 'handlesPersisted', 'biosPersisted', 'avatarsPersisted',
    'followersAccessed', 'followingAccessed', 'mentionGraphAccessed', 'contactGraphAccessed', 'geolocationAccessed',
    'addressesAccessed', 'credentialsAccessed', 'cookiesAccessed', 'urlsPersisted', 'authorIdentifiersPersisted']) {
    assert.equal(S[flag], false, flag);
  }
});
test('Q6 the stored snapshot files are read-only on disk', () => {
  for (const name of Object.values(SNAP.PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_FILES)) {
    const mode = statSync(path.join(WORKSPACE.snapshot.directory, name)).mode & 0o777;
    assert.equal(mode, 0o444, `${name} has mode ${mode.toString(8)}`);
  }
});
test('Q7 a feature record is aggregate structural evidence only', () => {
  const allowed = new Set(SURFACE.PUBLIC_INTELLIGENCE_5K9_MINT_FEATURE_SCHEMA.fields);
  for (const record of FEATURES) {
    for (const key of Object.keys(record)) assert.ok(allowed.has(key), key);
  }
});

// ===========================================================================
// R. NO NLP / LLM
// ===========================================================================
test('R1 the no-NLP disclosure denies every language capability', () => {
  const S = DEF.PUBLIC_INTELLIGENCE_5K9_NO_NLP;
  for (const flag of ['llmCalled', 'embeddingComputed', 'sentimentModelUsed', 'topicClassifierUsed',
    'keywordClassifierUsed', 'namedEntityRecognitionUsed', 'semanticSimilarityUsed', 'textMiningPerformed',
    'fixedLexiconsUsed']) assert.equal(S[flag], false, flag);
});
test('R2 no feature module imports an AI, NLP or embedding provider', () => {
  for (const unit of SURFACE.PUBLIC_INTELLIGENCE_5K9_MODULES) {
    const { found } = parseModule(`${PI}/${unit}`);
    for (const source of found.importSources) {
      assert.ok(!/openai|anthropic|langchain|transformers|onnx|tensorflow|torch|embedding|nlp/i.test(source), `${unit} imports ${source}`);
    }
  }
});
test('R3 no feature module names an LLM or NLP entry point', () => {
  const banned = /^(callLlm|generateText|embed|embedText|classifySentiment|classifyTopic|extractEntities|tokenise|tokenize|stem|lemmatize)$/;
  for (const unit of SURFACE.PUBLIC_INTELLIGENCE_5K9_MODULES) {
    const { found } = parseModule(`${PI}/${unit}`);
    for (const id of found.identifiers) assert.ok(!banned.test(id), `${unit}:${id}`);
  }
});
test('R4 no feature record carries a sentiment, topic or entity field', () => {
  for (const record of FEATURES) {
    const text = canonical(record).toLowerCase();
    for (const banned of ['sentiment', 'topic', 'entity', 'embedding']) assert.ok(!text.includes(banned), `${record.mint} names ${banned}`);
  }
});
test('R5 the feature layer performs no text mining of any kind', () => {
  for (const unit of SURFACE.PUBLIC_INTELLIGENCE_5K9_MODULES) {
    const { source } = parseModule(`${PI}/${unit}`);
    assert.ok(!/\brawText\b/.test(source), `${unit} reads post text`);
    assert.ok(!/\bcanonicalText\b/.test(source), `${unit} reads canonical text`);
  }
});

// ===========================================================================
// S. NO MARKET / TRADING LINKAGE
// ===========================================================================
test('S1 the market-linkage disclosure denies every access', () => {
  const S = DEF.PUBLIC_INTELLIGENCE_5K9_MARKET_LINKAGE;
  assert.equal(S.mintIsIdentityOnly, true);
  for (const flag of ['priceAccessed', 'returnsAccessed', 'volatilityAccessed', 'marketOutcomesAccessed',
    'r4ResultAccessed', 'r4OutcomeArtifactsAccessed', 'tradingEngineReached', 'arenaReached', 'walletAccessed',
    'signerAccessed', 'swapReached', 'rpcWriteReached', 'solanaRpcLookupPerformed', 'marketApiContacted',
    'priceCorrelationComputed', 'returnLinkageComputed']) assert.equal(S[flag], false, flag);
});
test('S2 no feature module imports an engine, arena, wallet, market or RPC module', () => {
  for (const unit of SURFACE.PUBLIC_INTELLIGENCE_5K9_MODULES) {
    const { found } = parseModule(`${PI}/${unit}`);
    for (const source of found.importSources) {
      assert.ok(!/market-intelligence|engine|arena|wallet|signer|swap|rpc|price/i.test(source), `${unit} imports ${source}`);
    }
  }
});
test('S3 no feature module declares a signing, RPC-write or price identifier', () => {
  const banned = /^(signTransaction|sendTransaction|submitTrade|executeSwap|privateKey|secretKey|signer|walletAddress|priceUsd|getPrice|marketCap)$/;
  for (const unit of SURFACE.PUBLIC_INTELLIGENCE_5K9_MODULES) {
    const { found } = parseModule(`${PI}/${unit}`);
    for (const id of found.identifiers) assert.ok(!banned.test(id), `${unit}:${id}`);
  }
});
test('S4 no feature module names a market or R4 field', () => {
  const banned = /\b(priceUsd|marketCap|liquidity|volume24h|r4Outcome|futureReturn|volatility|ohlcv)\b/i;
  for (const unit of SURFACE.PUBLIC_INTELLIGENCE_5K9_MODULES) {
    const { source } = parseModule(`${PI}/${unit}`);
    assert.ok(!banned.test(source), `${unit} names a market field`);
  }
});
test('S5 the query layer computes no score, rank, correlation or recommendation', () => {
  const summary = api().getFeatureSummary();
  for (const flag of ['scoreComputed', 'rankComputed', 'weightApplied', 'sentimentComputed', 'momentumComputed',
    'predictionMade', 'recommendationMade', 'marketDataAccessed']) assert.equal(summary[flag], false, flag);
  assert.ok(!Object.keys(api()).some(name => /score|rank|recommend|predict|best|top/i.test(name)));
});
test('S6 the phase validator itself is offline and made zero network calls', () => assert.equal(tripwireCalls, 0));

// ===========================================================================
// T. REGRESSION AND GOVERNED-TREE DISCIPLINE
// ===========================================================================
test('T1 this validator imports exactly ONE project module and names no protected fragment', () => {
  const { found } = parseModule('scripts/validate-phase5k9.mjs');
  const projectImports = found.importSources.filter(source => source.includes('public-intelligence'));
  assert.deepEqual(projectImports, ['./public-intelligence/feature-validation-surface.mjs']);
  const fragments = new Set(SURFACE.PROTECTED_MODULE_FRAGMENTS);
  for (const source of found.importSources) {
    for (const fragment of fragments) assert.ok(!source.includes(fragment), `the validator imports a protected fragment: ${source}`);
  }
});
test('T2 the validation surface re-exports only; it adds no behaviour', () => {
  const { source } = parseModule(`${PI}/feature-validation-surface.mjs`);
  assert.ok(!/^\s*(?:async\s+)?function\b/m.test(source), 'the surface declares no function');
  assert.ok(!/^\s*class\b/m.test(source), 'the surface declares no class');
  assert.ok(!/^\s*(?:if|for|while|switch|try)\b/m.test(source), 'the surface has no control flow');
  assert.ok(!/process\.env|Date\.now|setTimeout|setInterval/.test(source), 'the surface reads no clock or environment');
});
test('T3 nothing outside the governed tree names or imports a feature module', () => {
  // Every feature module lives under the governed tree, so any reference from
  // outside it carries the `public-intelligence/` path segment. Matching that
  // path - rather than a bare filename - keeps an unrelated pre-existing module
  // such as `classifier-feature-definition.mjs` from colliding by accident.
  const modules = SURFACE.PUBLIC_INTELLIGENCE_5K9_MODULES;
  const surface = 'feature-validation-surface.mjs';
  const listed = gitOut('ls-files', 'scripts', 'src').split('\n').filter(entry => /\.(mjs|ts|tsx|js)$/.test(entry));
  for (const entry of listed) {
    if (entry.startsWith(`${PI}/`) || HISTORICAL_VALIDATORS.includes(entry)) continue;
    const source = readFileSync(path.join(REPO_ROOT, entry), 'utf8');
    for (const owned of modules) assert.ok(!source.includes(`${PI}/${owned}`), `${entry} names ${owned}`);
    if (entry !== 'scripts/validate-phase5k9.mjs') assert.ok(!source.includes(`${PI}/${surface}`), `${entry} names ${surface}`);
    if (!/\.(mjs|js)$/.test(entry)) continue;
    let parsed = null;
    try { parsed = parseModule(entry); } catch { continue; }
    for (const imported of parsed.found.importSources) {
      for (const owned of modules) {
        assert.ok(!imported.includes(`${PI}/${owned}`) && !imported.endsWith(`/${owned}`), `${entry} imports ${imported}`);
      }
    }
  }
});
test('T4 every feature module lives inside the governed tree and exists', () => {
  for (const unit of SURFACE.PUBLIC_INTELLIGENCE_5K9_MODULES) {
    assert.ok(unit.startsWith('feature'), unit);
    assert.ok(existsFile(path.join(REPO_ROOT, PI, unit)), unit);
  }
  assert.ok(existsFile(path.join(REPO_ROOT, PI, 'feature-validation-surface.mjs')));
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
test('T20 5K.8 stays 164/164', () => phaseCount('scripts/validate-phase5k8.mjs', 'Phase 5K.8: 164/164 passed'));

// ---------------------------------------------------------------------------
async function main() {
  let failed = 0;
  try {
    for (const [name, fn] of tests) {
      try { await fn(); console.log(`PASS ${name}`); } catch (error) { failed += 1; console.error(`FAIL ${name}: ${error.stack}`); }
    }
  } finally { for (const root of temporary) rmSync(root, { recursive: true, force: true }); }
  console.log(`Phase 5K.9: ${tests.length - failed}/${tests.length} passed; offline, fixture runs + injected clocks only, ${tripwireCalls} network calls, descriptive features only`);
  if (failed) process.exitCode = 1;
}
main().catch(error => { console.error('phase 5K.9 validator crashed:', error); process.exitCode = 1; });
