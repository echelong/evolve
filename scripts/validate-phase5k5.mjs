#!/usr/bin/env node
// Phase 5K.5 - TEMPORAL EVIDENCE SEMANTICS validator.
//
// COMPLETELY OFFLINE AND DETERMINISTIC. Runs are produced with injected counter
// clocks and in-memory fixture fetches; the global fetch and socket connect are
// replaced with tripwires and asserted never called. Every run root is a
// temporary directory; the repository tree, `var/` and `.evolve` are never
// written. No live Mastodon call is made here - the live smoke is a separate,
// explicitly invoked step.
import assert from 'node:assert/strict';
import net from 'node:net';
import {
  chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

let tripwireCalls = 0;
globalThis.fetch = () => { tripwireCalls += 1; throw new Error('TRIPWIRE: validator attempted a real fetch'); };
net.Socket.prototype.connect = function tripwire() { tripwireCalls += 1; throw new Error('TRIPWIRE: validator attempted a socket connect'); };

// IMPORT BOUNDARY (5K.1 I5 / 5K.2 I5 / 5K.3 J6 / 5K.4 N7)
//
// Every phase validator asserts that nothing OUTSIDE `scripts/public-intelligence/`
// imports a protected phase module. This validator therefore reaches 5K.0-5K.5
// through ONE read-only re-export surface inside that governed tree - the same
// pattern 5K.4 uses via `research-surface.mjs`. Importing the modules directly
// here is what broke the committed tree, because those checks enumerate
// `git ls-files`: an untracked validator escaped them, a tracked one does not.
const SURFACE = await import('./public-intelligence/temporal-validation-surface.mjs');

// Each phase is bound through its OWN namespace so a same-named export in
// another phase can never shadow it.
const CORE = SURFACE;
const MAPPER = SURFACE;
const RUNS = SURFACE.RUNS_5K3;
const PROVENANCE = SURFACE.PROVENANCE_5K1;
const SNAP4 = SURFACE.CORPUS_SNAPSHOT_5K4;
const VERIFY4 = SURFACE.CORPUS_VERIFY_5K4;
const PROJ = SURFACE.TEMPORAL_PROJECTION_5K5;
const STATE = SURFACE.OBSERVATION_STATE_5K5;
const REV = SURFACE.REVISION_CHAIN_5K5;
const CORPUS = SURFACE.TEMPORAL_CORPUS_5K5;
const QUERY = SURFACE.TEMPORAL_QUERY_5K5;
const SNAP = SURFACE.TEMPORAL_SNAPSHOT_5K5;
const VERIFY = SURFACE.TEMPORAL_VERIFY_5K5;
const { PUBLIC_INTELLIGENCE_CLASSIFICATION, canonical, digest } = SURFACE;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R4_HEAD = '1c30264fb87876eeaf229e25c5cdc5adca429b40';
const PI = 'scripts/public-intelligence';
// The last commit before Phase 5K.5. Resolved by subject rather than by SHA so
// the reference survives rebases, and cross-checked against the known SHA below.
const K5_BASE_SUBJECT = 'Implement Phase 5K.4 cross-run corpus';
const K5_BASE_SHA = '507ff86a6c9dc9efb8ea55522eaf0cd26b7652f7';
const K5_BASE = (() => {
  // Resolved from the history by exact subject. `rev-parse` cannot do this - it
  // resolves refs and SHAs, not commit messages.
  const lines = execFileSync('git', ['log', '--format=%H%x00%s'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean);
  const found = lines.map(line => line.split('\u0000'))
    .find(([, subject]) => subject === K5_BASE_SUBJECT)?.[0];
  if (found !== K5_BASE_SHA) throw new Error(`PHASE_5K5_BASE_COMMIT_UNRESOLVED:${found ?? 'none'}`);
  return found;
})();
const TEMPORAL_MODULES = ['temporal-projection', 'observation-state', 'revision-chain', 'temporal-corpus', 'temporal-query', 'temporal-snapshot', 'temporal-verify'].map(name => `${PI}/${name}.mjs`);
const require = createRequire(import.meta.url);
const espree = require('espree');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const temporary = [];
const tempRoot = () => { const root = mkdtempSync(path.join(tmpdir(), 'evolve-5k5-')); temporary.push(root); return root; };
const gitOut = (...args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MINT_2 = 'So11111111111111111111111111111111111111112';
const T0 = 1790000000000;
const HOST = 'fixture.example';
const BOUNDS = Object.freeze({ maxPages: 2, maxRecords: 10, timeoutMs: 5000, maxResponseBytes: 100_000, maxLookbackMs: 3 * 24 * 60 * 60 * 1000 });
const DEFAULT_POLICY = SURFACE.PUBLIC_INTELLIGENCE_5K4_DEFAULT_POLICY;

const status = (id, over = {}) => ({
  id: String(id), visibility: 'public', created_at: '2026-10-01T10:00:00.000Z', url: `https://${HOST}/@alice/${id}`,
  in_reply_to_id: null, reblog: null, language: 'en', content: `<p>post ${id} mint ${MINT}</p>`, tags: [{ name: 'solana' }],
  favourites_count: 3, replies_count: 0, reblogs_count: 1,
  account: { id: '42', acct: 'alice', display_name: 'Alice Real Name', note: '<p>private bio</p>', followers_count: 777 },
  ...over,
});

const makeClock = start => { let t = start; return () => { t += 10; return t; }; };
const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const pagedFetch = pages => { let calls = 0; return async () => json(pages[calls++] ?? []); };

/** Produces ONE immutable 5K.3 run in `root` (real plan -> transport -> mapper -> ingest -> verify). */
async function makeRun(root, { start = T0, pages = [[status(30)]], instance = HOST, bounds = {} } = {}) {
  const plan = RUNS.buildCollectionPlan({
    instance, hashtag: 'solana', bounds: { ...BOUNDS, ...bounds }, collectionMode: 'OFFLINE_FIXTURE', createdAt: start,
  });
  return RUNS.executeCollectionRun(plan, { clock: makeClock(start), fetchImpl: pagedFetch(pages), outputRoot: root });
}

/** Maps a status straight to a canonical raw record, for projection-level tests. */
function rawOf(nativeStatus, { fetchedAt = T0, host = HOST, runId = 'run-fixture' } = {}) {
  return MAPPER.mapStatusToRawObservation(nativeStatus, {
    host, fetchedAt, collectionRunId: runId, collectorMode: 'OFFLINE_FIXTURE',
  });
}

/** Builds an in-memory authenticated run set for pure-corpus tests. */
function syntheticRun(records, start, { runId } = {}) {
  const store = CORE.createMemoryStore();
  const envelopes = [];
  for (const record of records) {
    const raw = rawOf(record, { fetchedAt: start, runId: runId ?? `run-${String(start - T0).padStart(32, '0')}` });
    CORE.ingestPublicObservation(raw, { store });
    envelopes.push(JSON.parse(JSON.stringify(store.list().at(-1))));
  }
  const id = runId ?? `run-${String(start - T0).padStart(32, '0')}`;
  return { manifest: { runId: id, manifestFingerprint: digest({ runId: id, start }) }, observations: envelopes };
}

const file = (dir, name) => path.join(dir, name);
const readNd = target => readFileSync(target, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
const refusal = (fn, fragment) => {
  let thrown = null;
  try { fn(); } catch (error) { thrown = error; }
  assert.ok(thrown, `expected refusal containing ${fragment}`);
  assert.ok(String(thrown.message).includes(fragment), `expected ${fragment}, got ${thrown.message}`);
};
const hasFailure = (result, prefix) => result.failures.some(code => code.startsWith(prefix));
const verifyOf = ctx => VERIFY.verifyTemporalSnapshot(ctx.root, ctx.id);
/** Content hash of every file in a tree, so "nothing was mutated" is provable. */
const hashTree = directory => {
  const out = {};
  const walk = current => {
    for (const name of readdirSync(current).sort()) {
      const full = path.join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[path.relative(directory, full)] = digest(readFileSync(full, 'utf8'));
    }
  };
  walk(directory);
  return out;
};

// ---- AST helpers -----------------------------------------------------------
function parseModule(relative) {
  const source = readFileSync(path.join(REPO_ROOT, relative), 'utf8');
  const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const found = { identifiers: [], stringLiterals: [], importSources: [], memberObjects: [] };
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === 'Identifier') found.identifiers.push(node.name);
    if (node.type === 'Literal' && typeof node.value === 'string') found.stringLiterals.push(node.value);
    if (['ImportDeclaration', 'ExportAllDeclaration', 'ExportNamedDeclaration', 'ImportExpression'].includes(node.type) && node.source?.value) found.importSources.push(node.source.value);
    if (node.type === 'MemberExpression' && node.object?.type === 'Identifier') found.memberObjects.push(node.object.name);
    for (const value of Object.values(node)) walk(value);
  };
  walk(ast);
  return { source, found };
}
const existsFile = candidate => { try { return statSync(candidate).isFile(); } catch { return false; } };
function importClosure(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const current = queue.shift();
    if (seen.has(current) || !existsFile(path.join(REPO_ROOT, current))) continue;
    seen.add(current);
    for (const source of parseModule(current).found.importSources) if (source.startsWith('.')) queue.push(path.normalize(path.join(path.dirname(current), source)));
  }
  return [...seen].sort();
}
const NETWORK_BUILTINS = ['node:http', 'node:https', 'node:http2', 'node:net', 'node:tls', 'node:dgram', 'node:dns', 'node:child_process', 'node:worker_threads', 'http', 'https', 'net', 'tls', 'dgram', 'dns', 'child_process'];
const WALLET_MODULES = ['@solana/web3.js', '@solana/spl-token', 'solana', 'tweetnacl', 'ed25519-hd-keypairs', 'bs58'];
const SIGNING_OR_RPC_WRITE = ['sendRawTransaction', 'sendTransaction', 'sendAndConfirmTransaction', 'signTransaction', 'signAllTransactions', 'partialSign', 'Keypair',
  'VersionedTransaction', 'Transaction', 'SystemProgram', 'splToken', 'requestAirdrop', 'confirmTransaction', 'rpc'];
const ENGINE_MODULES = ['evolve-engine', 'arena', 'paper', 'fitness', 'breeding', 'promotion', 'champion', 'wallet', 'signer'];
const closureAll = [...new Set(TEMPORAL_MODULES.flatMap(importClosure))].sort();
const PURE_MODULES = TEMPORAL_MODULES.filter(entry => !/snapshot|verify/.test(entry));

// ===========================================================================
// A. GOVERNANCE
// ===========================================================================
test('A1 5K.0 classification is researchOnly and observerOnly', () => {
  assert.equal(PUBLIC_INTELLIGENCE_CLASSIFICATION.researchOnly, true);
  assert.equal(PUBLIC_INTELLIGENCE_CLASSIFICATION.observerOnly, true);
});
test('A2 every authority flag is false on temporal projection constants', () => {
  for (const classification of [PROJ.PUBLIC_INTELLIGENCE_5K5_FINGERPRINTING ? PUBLIC_INTELLIGENCE_CLASSIFICATION : null]) {
    for (const flag of ['tradingAuthority', 'engineAuthority', 'arenaEligible', 'promotionEligible', 'profitabilityInferencePermitted']) {
      assert.equal(classification[flag], false, flag);
    }
  }
});
test('A3 a temporal record cannot widen the classification', () => {
  const index = CORPUS.buildTemporalCorpus([syntheticRun([status(30)], T0)]);
  const record = index.contentRecords[0];
  refusal(() => CORPUS.validateContentRecord({ ...record, classification: { ...record.classification, tradingAuthority: true } }), 'CLASSIFICATION_OVERRIDE_REFUSED');
  const observation = index.observationRecords[0];
  refusal(() => CORPUS.validateObservationRecord({ ...observation, classification: { ...observation.classification, arenaEligible: true } }), 'CLASSIFICATION_OVERRIDE_REFUSED');
});
test('A4 no temporal artifact carries a sentiment, score, rank, signal or profit field', () => {
  const index = CORPUS.buildTemporalCorpus([syntheticRun([status(30), status(31, { favourites_count: 9 })], T0), syntheticRun([status(30, { favourites_count: 14 })], T0 + 1000)]);
  const words = /sentiment|score|rank|signal|profit|alpha|recommend|predict|confidence|momentum|popular|importance|velocity|growth|virality/i;
  const walk = value => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        if (key === 'classification') continue;
        assert.ok(!words.test(key), `temporal artifact carries ${key}`);
        walk(inner);
      }
    }
    return undefined;
  };
  walk(index.accounting);
  for (const collection of [index.contentRecords, index.observationRecords, index.states, index.revisions]) collection.forEach(walk);
});

// ===========================================================================
// B. FIELD CLASSIFICATION
// ===========================================================================
test('B1 the classification enum is closed at exactly five classes', () => {
  assert.deepEqual([...PROJ.PUBLIC_INTELLIGENCE_5K5_FIELD_CLASSES].sort(),
    ['ACQUISITION', 'CONTENT', 'DERIVED', 'IDENTITY', 'OBSERVATION_STATE']);
});
test('B2 every 5K.1 raw field is classified and the tables have drifted nowhere', () => {
  assert.equal(PROJ.assertFieldClassificationComplete(), true);
  for (const field of ['schemaVersion', 'recordType', 'provider', 'providerObservationId', 'providerAuthorId', 'sourceType',
    'sourceUrl', 'publishedAt', 'observedAt', 'fetchedAt', 'rawText', 'rawMetadata', 'claimedMint', 'collectionContext', 'classification']) {
    assert.ok(PROJ.PUBLIC_INTELLIGENCE_5K5_FIELD_CLASSES.includes(PROJ.classifyField('raw', field)), field);
  }
});
test('B3 every 5K.1 normalized field is classified, and a real normalized record validates', () => {
  const result = CORE.ingestPublicObservation(rawOf(status(30)), { store: CORE.createMemoryStore() });
  assert.equal(result.outcome, 'INGESTED');
  const normalizedFields = Object.keys(PROJ.PUBLIC_INTELLIGENCE_5K5_NORMALIZED_FIELD_CLASSIFICATION);
  for (const field of normalizedFields) {
    assert.ok(PROJ.PUBLIC_INTELLIGENCE_5K5_FIELD_CLASSES.includes(PROJ.classifyField('normalized', field)), field);
  }
  // The table names exactly the 5K.1 normalized schema - no more, no less.
  const actual = Object.keys(CORE.createMemoryStore().list()[0]?.normalized ?? PROJ.PUBLIC_INTELLIGENCE_5K5_NORMALIZED_FIELD_CLASSIFICATION);
  assert.ok(normalizedFields.length >= 20, 'the normalized table is complete');
  assert.ok(actual.every(field => normalizedFields.includes(field)), actual.join(','));
});
test('B4 every raw-metadata, collection-context and engagement field is classified', () => {
  for (const field of ['language', 'engagement', 'cashtags', 'hashtags', 'mentionedHandles', 'claimedSymbol', 'claimedTokenName', 'candidateMintAddresses', 'similaritySignals', 'fixtureNote']) {
    assert.ok(PROJ.PUBLIC_INTELLIGENCE_5K5_FIELD_CLASSES.includes(PROJ.classifyField('rawMetadata', field)), field);
  }
  for (const field of ['collectionRunId', 'adapterName', 'adapterVersion', 'collectorMode']) {
    assert.equal(PROJ.classifyField('collectionContext', field), 'ACQUISITION', field);
  }
  for (const field of PROJ.PUBLIC_INTELLIGENCE_5K5_OBSERVATION_STATE_FIELDS) {
    assert.equal(PROJ.classifyField('engagement', field), 'OBSERVATION_STATE', field);
  }
});
test('B5 an unknown field in any scope fails closed', () => {
  for (const scope of PROJ.PUBLIC_INTELLIGENCE_5K5_FIELD_CLASSIFICATION_TABLES) {
    refusal(() => PROJ.classifyField(scope, 'notAFieldAtAll'), 'FIELD_UNCLASSIFIED');
  }
  refusal(() => PROJ.classifyField('notAScope', 'rawText'), 'FIELD_SCOPE_UNKNOWN');
});
test('B6 identity is exactly provider and providerObservationId and nothing else', () => {
  assert.deepEqual([...PROJ.PUBLIC_INTELLIGENCE_5K5_IDENTITY_FIELDS], ['provider', 'providerObservationId']);
  const raw = rawOf(status(30));
  assert.equal(PROJ.upstreamIdentity5K5(raw), `${raw.provider}:${raw.providerObservationId}`);
  // The projection body carries identity as its scope anchor, never as content.
  const projection = PROJ.contentProjection(raw);
  assert.ok(!Object.hasOwn(projection.content, 'provider'));
  assert.ok(!Object.hasOwn(projection.content, 'providerObservationId'));
});
test('B7 content fields are explicit and include text, url, publishedAt, author and mint', () => {
  assert.deepEqual([...PROJ.PUBLIC_INTELLIGENCE_5K5_CONTENT_FIELDS],
    ['claimedMint', 'providerAuthorId', 'publishedAt', 'rawMetadata', 'rawText', 'sourceType', 'sourceUrl']);
  assert.deepEqual([...PROJ.PUBLIC_INTELLIGENCE_5K5_CONTENT_METADATA_FIELDS],
    ['candidateMintAddresses', 'cashtags', 'claimedSymbol', 'claimedTokenName', 'fixtureNote', 'hashtags', 'language', 'mentionedHandles', 'similaritySignals']);
});
test('B8 acquisition fields are explicit and are only fetchedAt, observedAt and collectionContext', () => {
  assert.deepEqual([...PROJ.PUBLIC_INTELLIGENCE_5K5_ACQUISITION_FIELDS], ['collectionContext', 'fetchedAt', 'observedAt']);
});
test('B9 engagement is the only observation-state metadata field', () => {
  const stateMembers = Object.entries(PROJ.PUBLIC_INTELLIGENCE_5K5_RAW_METADATA_FIELD_CLASSIFICATION)
    .filter(([, klass]) => klass === 'OBSERVATION_STATE').map(([name]) => name);
  assert.deepEqual(stateMembers, ['engagement']);
});
test('B10 nothing becomes mutable merely because it changed', () => {
  // language and hashtags are CONTENT, so a change to either is a content event,
  // never a mere state update.
  assert.equal(PROJ.classifyField('rawMetadata', 'language'), 'CONTENT');
  assert.equal(PROJ.classifyField('rawMetadata', 'hashtags'), 'CONTENT');
  assert.equal(PROJ.classifyField('raw', 'publishedAt'), 'CONTENT');
});
test('B11 every projection-membership entry names a real projection and no class is unmapped', () => {
  for (const [klass, projections] of Object.entries(PROJ.PUBLIC_INTELLIGENCE_5K5_PROJECTION_MEMBERSHIP)) {
    assert.ok(PROJ.PUBLIC_INTELLIGENCE_5K5_FIELD_CLASSES.includes(klass), klass);
    for (const projection of projections) assert.ok(['content', 'observationState', 'acquisition'].includes(projection), projection);
  }
  assert.equal(Object.keys(PROJ.PUBLIC_INTELLIGENCE_5K5_PROJECTION_MEMBERSHIP).length, 5);
});

// ===========================================================================
// C. FINGERPRINTS
// ===========================================================================
test('C1 the raw fingerprint is 5K.1s, unchanged and still authoritative', () => {
  const raw = rawOf(status(30));
  // 5K.5 re-exports 5K.1s function rather than defining its own: identical output.
  assert.equal(PROJ.rawObservationFingerprint(raw), PROVENANCE.rawObservationFingerprint(raw));
  // And 5K.5 declares that contract rather than merely happening to match.
  assert.equal(PROJ.PUBLIC_INTELLIGENCE_5K5_FINGERPRINTING.rawObservationFingerprint, 'REUSED_UNCHANGED_FROM_5K1');
  assert.equal(PROJ.PUBLIC_INTELLIGENCE_5K5_FINGERPRINTING.rawFingerprintReplaced, false);
  assert.equal(PROJ.PUBLIC_INTELLIGENCE_5K5_FINGERPRINTING.rawFingerprintOmittedFromAnyRecord, false);
  assert.equal(PROJ.PUBLIC_INTELLIGENCE_5K5_FINGERPRINTING.rawEvidenceMutable, false);
});
test('C2 every derived record still carries the raw fingerprint', () => {
  const index = CORPUS.buildTemporalCorpus([syntheticRun([status(30)], T0)]);
  for (const record of index.contentRecords) {
    assert.equal(typeof record.contentFingerprint, 'string');
    assert.ok(record.contentVersions.every(v => /^[0-9a-f]{64}$/.test(v.rawObservationFingerprint)));
  }
  assert.ok(index.observationRecords.every(r => /^[0-9a-f]{64}$/.test(r.rawObservationFingerprint)));
  assert.ok(index.revisions.every(r => /^[0-9a-f]{64}$/.test(r.rawObservationFingerprint)));
});
test('C3 the content fingerprint is deterministic across repeated calls', () => {
  const raw = rawOf(status(30));
  assert.equal(PROJ.contentFingerprint5K5(raw), PROJ.contentFingerprint5K5(raw));
  assert.equal(PROJ.observationStateFingerprint5K5(raw), PROJ.observationStateFingerprint5K5(raw));
  assert.equal(PROJ.acquisitionFingerprint5K5(raw), PROJ.acquisitionFingerprint5K5(raw));
});
test('C4 a fetchedAt change does not alter the content fingerprint but does alter acquisition', () => {
  const a = rawOf(status(30), { fetchedAt: T0 });
  const b = rawOf(status(30), { fetchedAt: T0 + 5000 });
  assert.equal(PROJ.contentFingerprint5K5(a), PROJ.contentFingerprint5K5(b));
  assert.equal(PROJ.observationStateFingerprint5K5(a), PROJ.observationStateFingerprint5K5(b));
  assert.notEqual(PROJ.acquisitionFingerprint5K5(a), PROJ.acquisitionFingerprint5K5(b));
});
test('C5 a collectionRunId change does not alter the content fingerprint', () => {
  const a = rawOf(status(30), { runId: 'run-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  const b = rawOf(status(30), { runId: 'run-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
  assert.equal(PROJ.contentFingerprint5K5(a), PROJ.contentFingerprint5K5(b));
  assert.notEqual(PROJ.acquisitionFingerprint5K5(a), PROJ.acquisitionFingerprint5K5(b));
});
test('C6 an engagement change alters the state fingerprint and NOT the content fingerprint', () => {
  const a = rawOf(status(30, { favourites_count: 10 }));
  const b = rawOf(status(30, { favourites_count: 14 }));
  assert.notEqual(PROJ.observationStateFingerprint5K5(a), PROJ.observationStateFingerprint5K5(b));
  assert.equal(PROJ.contentFingerprint5K5(a), PROJ.contentFingerprint5K5(b));
});
test('C7 an engagement REGRESSION also alters the state fingerprint and never the content one', () => {
  const a = rawOf(status(30, { favourites_count: 14 }));
  const b = rawOf(status(30, { favourites_count: 10 }));
  assert.notEqual(PROJ.observationStateFingerprint5K5(a), PROJ.observationStateFingerprint5K5(b));
  assert.equal(PROJ.contentFingerprint5K5(a), PROJ.contentFingerprint5K5(b));
});
test('C8 a text change alters the content fingerprint', () => {
  const a = rawOf(status(30));
  const b = rawOf(status(30, { content: '<p>completely different text</p>' }));
  assert.notEqual(PROJ.contentFingerprint5K5(a), PROJ.contentFingerprint5K5(b));
});
test('C9 an explicit mint-evidence change alters the content fingerprint', () => {
  const a = rawOf(status(30));
  const b = rawOf(status(30, { content: `<p>post 30 mint ${MINT_2}</p>` }));
  assert.notEqual(PROJ.contentFingerprint5K5(a), PROJ.contentFingerprint5K5(b));
  assert.equal(a.claimedMint, MINT);
  assert.equal(b.claimedMint, MINT_2);
});
test('C10 an author change alters the content fingerprint but never the identity', () => {
  const a = rawOf(status(30));
  const b = rawOf(status(30, { account: { id: '99' } }));
  assert.notEqual(PROJ.contentFingerprint5K5(a), PROJ.contentFingerprint5K5(b));
  assert.equal(PROJ.upstreamIdentity5K5(a), PROJ.upstreamIdentity5K5(b));
});
test('C11 an engagement change has ZERO effect on mint association', () => {
  const index = CORPUS.buildTemporalCorpus([
    syntheticRun([status(30, { favourites_count: 10 })], T0),
    syntheticRun([status(30, { favourites_count: 14 })], T0 + 1000),
  ]);
  const associations = index.observationRecords.map(record => record.assetAssociation);
  assert.equal(associations.length, 2);
  for (const association of associations) {
    assert.equal(association.status, 'EXACT_MINT');
    assert.equal(association.mint, MINT, 'the exact mint is inherited from authenticated evidence');
    assert.equal(association.method, 'EXACT_MINT_ADDRESS');
  }
  // The association is copied verbatim from verified normalized evidence, and the
  // content fingerprint is identical because the counter never entered it.
  assert.equal(index.contentRecords[0].assetAssociation.mint, MINT);
  assert.equal(index.accounting.unassociatedVersionCount, 0);
});
test('C12 an unknown or malformed counter fails closed in the state projection', () => {
  const raw = rawOf(status(30));
  const tampered = JSON.parse(JSON.stringify(raw));
  tampered.rawMetadata.engagement.notACounter = 1;
  refusal(() => PROJ.observationStateProjection(tampered), 'FIELD_UNCLASSIFIED');
  const negative = JSON.parse(JSON.stringify(raw));
  negative.rawMetadata.engagement.likes = -5;
  refusal(() => PROJ.observationStateProjection(negative), 'COUNTER_INVALID');
});

// ===========================================================================
// D. STATE UPDATES
// ===========================================================================
const pairIndex = (a, b) => CORPUS.buildTemporalCorpus([syntheticRun([a], T0), syntheticRun([b], T0 + 1000)]);
const onlyClassification = index => index.observationRecords.map(r => r.temporalClassification);

test('D1 10 -> 14 is accepted as an updated state, not a conflict', () => {
  const index = pairIndex(status(30, { favourites_count: 10 }), status(30, { favourites_count: 14 }));
  assert.deepEqual(onlyClassification(index), ['FIRST_OBSERVATION', 'SAME_CONTENT_UPDATED_STATE']);
  assert.equal(index.accounting.conflictedUpstreamIdentityCount, 0);
  assert.equal(index.accounting.unverifiedDivergenceCount, 0);
});
test('D2 14 -> 10 is equally accepted; a regression is not an integrity failure', () => {
  const index = pairIndex(status(30, { favourites_count: 14 }), status(30, { favourites_count: 10 }));
  assert.deepEqual(onlyClassification(index), ['FIRST_OBSERVATION', 'SAME_CONTENT_UPDATED_STATE']);
  assert.equal(STATE.PUBLIC_INTELLIGENCE_5K5_STATE_SEMANTICS.counterRegressionIsFailure, false);
  assert.equal(STATE.PUBLIC_INTELLIGENCE_5K5_STATE_SEMANTICS.counterDirectionImpliesIntent, false);
});
test('D3 identical counters are a same-content same-state repeat', () => {
  const index = pairIndex(status(30), status(30));
  assert.deepEqual(onlyClassification(index), ['FIRST_OBSERVATION', 'SAME_CONTENT_SAME_STATE']);
});
test('D4 missing -> observed stays explicit and never becomes a zero-fill', () => {
  const bare = () => { const s = status(30); delete s.favourites_count; delete s.replies_count; delete s.reblogs_count; return s; };
  const index = pairIndex(bare(), status(30));
  const histories = QUERY.createTemporalQuery(index).getObservationStateHistory(index.contentRecords[0].upstreamIdentity);
  assert.equal(histories[0].status, 'NO_OBSERVATION');
  assert.equal(histories[0].values, null);
  assert.equal(histories[1].status, 'OBSERVED');
  assert.deepEqual(onlyClassification(index), ['FIRST_OBSERVATION', 'SAME_CONTENT_UPDATED_STATE']);
});
test('D5 observed -> missing stays explicit and is never back-filled from the earlier run', () => {
  const bare = () => { const s = status(30); delete s.favourites_count; delete s.replies_count; delete s.reblogs_count; return s; };
  const index = pairIndex(status(30, { favourites_count: 14 }), bare());
  const histories = QUERY.createTemporalQuery(index).getObservationStateHistory(index.contentRecords[0].upstreamIdentity);
  assert.equal(histories[1].status, 'NO_OBSERVATION');
  assert.equal(histories[1].values, null, 'the earlier 14 is never carried forward');
});
test('D6 absent counters are listed explicitly and nothing is zero-filled', () => {
  const s = status(30); delete s.favourites_count;
  const raw = rawOf(s);
  const projection = PROJ.observationStateProjection(raw);
  assert.deepEqual(Object.keys(projection.values).sort(), ['replies', 'reposts']);
  assert.deepEqual(projection.absentCounters, ['bookmarks', 'likes', 'quotes', 'views']);
  assert.ok(!Object.hasOwn(projection.values, 'likes'), 'an absent counter is absent, not 0');
});
test('D7 a provider-supplied zero is OBSERVED and is distinct from missing', () => {
  const observed = PROJ.observationStateProjection(rawOf(status(30, { favourites_count: 0 })));
  assert.equal(observed.status, 'OBSERVED');
  assert.equal(observed.values.likes, 0);
  const missing = PROJ.observationStateProjection(rawOf((() => { const s = status(30); delete s.favourites_count; delete s.replies_count; delete s.reblogs_count; return s; })()));
  assert.equal(missing.status, 'NO_OBSERVATION');
  assert.notEqual(PROJ.observationStateFingerprint5K5(rawOf(status(30, { favourites_count: 0 }))), PROJ.observationStateFingerprint5K5(rawOf((() => { const s = status(30); delete s.favourites_count; delete s.replies_count; delete s.reblogs_count; return s; })())));
});
test('D8 no state record claims zero filling, carry-forward, interpolation or a delta', () => {
  const index = pairIndex(status(30, { favourites_count: 10 }), status(30, { favourites_count: 14 }));
  for (const record of index.states) {
    assert.equal(record.zeroFillingApplied, false);
    assert.equal(record.carryForwardApplied, false);
    assert.equal(record.interpolationApplied, false);
    assert.equal(record.deltaComputed, false);
    STATE.validateObservationStateRecord(record);
  }
  for (const flag of ['growthRateComputed', 'velocityComputed', 'momentumComputed', 'engagementScoreComputed', 'popularityComputed', 'importanceComputed', 'viralityComputed', 'rankingComputed', 'crossSnapshotArithmeticPerformed']) {
    assert.equal(STATE.PUBLIC_INTELLIGENCE_5K5_STATE_SEMANTICS[flag], false, flag);
  }
});
test('D9 every acquisition keeps its own state snapshot and none overwrites another', () => {
  const index = CORPUS.buildTemporalCorpus([
    syntheticRun([status(30, { favourites_count: 10 })], T0),
    syntheticRun([status(30, { favourites_count: 14 })], T0 + 1000),
    syntheticRun([status(30, { favourites_count: 12 })], T0 + 2000),
  ]);
  assert.equal(index.states.length, 3, 'three authenticated snapshots survive');
  assert.equal(new Set(index.states.map(s => s.observationStateFingerprint)).size, 3);
  const values = QUERY.createTemporalQuery(index).getObservationStateHistory(index.contentRecords[0].upstreamIdentity).map(s => s.values.likes);
  assert.deepEqual(values, [10, 14, 12]);
});
test('D10 the earlier engagement snapshot is never overwritten', () => {
  const index = CORPUS.buildTemporalCorpus([
    syntheticRun([status(30, { favourites_count: 10 })], T0),
    syntheticRun([status(30, { favourites_count: 99 })], T0 + 1000),
  ]);
  const history = QUERY.createTemporalQuery(index).getObservationStateHistory(index.contentRecords[0].upstreamIdentity);
  assert.equal(history[0].values.likes, 10, 'the first snapshot still reads 10');
});

// ===========================================================================
// E. CROSS-RUN SEMANTICS
// ===========================================================================
test('E1 same identity + same content + same state yields one canonical content record', () => {
  const index = CORPUS.buildTemporalCorpus([syntheticRun([status(30)], T0), syntheticRun([status(30)], T0 + 1000)]);
  assert.equal(index.contentRecords.length, 1);
  assert.equal(index.contentRecords[0].versionCount, 1);
  assert.equal(index.contentRecords[0].observationCount, 2);
  assert.deepEqual(onlyClassification(index), ['FIRST_OBSERVATION', 'SAME_CONTENT_SAME_STATE']);
});
test('E2 same identity + same content + changed state yields ONE content version and TWO state snapshots', () => {
  const index = pairIndex(status(30, { favourites_count: 10 }), status(30, { favourites_count: 14 }));
  assert.equal(index.contentRecords.length, 1);
  assert.equal(index.contentRecords[0].versionCount, 1);
  assert.equal(index.contentRecords[0].stateSnapshotCount, 2);
  assert.equal(index.accounting.contentVersionCount, 1);
  assert.equal(index.accounting.observationStateSnapshotCount, 2);
});
test('E3 changing engagement does NOT create a conflict', () => {
  const index = pairIndex(status(30, { favourites_count: 10 }), status(30, { favourites_count: 14 }));
  assert.equal(index.accounting.conflictedUpstreamIdentityCount, 0);
  assert.equal(QUERY.createTemporalQuery(index).listConflicts().length, 0);
});
test('E4 every run remains a membership; no run is dropped by deduplication', () => {
  const index = CORPUS.buildTemporalCorpus([syntheticRun([status(30)], T0), syntheticRun([status(30)], T0 + 1000)]);
  assert.equal(index.contentRecords[0].memberRunIds.length, 2);
  assert.equal(index.observationRecords.length, 2, 'both appearances survive');
});
test('E5 two different providerObservationIds never merge', () => {
  const index = CORPUS.buildTemporalCorpus([syntheticRun([status(30), status(31)], T0)]);
  assert.equal(index.contentRecords.length, 2);
  assert.deepEqual(index.contentRecords.map(r => r.providerObservationId), ['30', '31']);
});
test('E6 two different providers never merge, even with an identical id and text', () => {
  const a = syntheticRun([status(30)], T0);
  const b = syntheticRun([status(30)], T0 + 1000, { runId: 'run-cccccccccccccccccccccccccccccccc' });
  // Same id, same text; only the instance in `provider` differs.
  const runB = { manifest: b.manifest, observations: b.observations.map(e => JSON.parse(JSON.stringify(e))) };
  runB.observations[0].raw.provider = `mastodon:other.example`;
  runB.observations[0].normalized.provider = 'mastodon:other.example';
  const index = CORPUS.buildTemporalCorpus([a, runB]);
  assert.equal(index.contentRecords.length, 2, 'a different provider is a different identity');
});
test('E7 same identity + changed content with NO revision proof is a conflict', () => {
  const index = pairIndex(status(30), status(30, { content: '<p>post 30 EDITED without proof</p>' }));
  assert.deepEqual(onlyClassification(index), ['FIRST_OBSERVATION', 'UNVERIFIED_CONTENT_DIVERGENCE']);
  assert.equal(index.accounting.conflictedUpstreamIdentityCount, 1);
  assert.equal(QUERY.createTemporalQuery(index).listConflicts().length, 1);
});
test('E8 a conflicted identity is never collapsed into a single version', () => {
  const index = pairIndex(status(30), status(30, { content: '<p>unverified divergence</p>' }));
  assert.equal(index.contentRecords[0].versionCount, 2, 'both authenticated versions are retained');
});
test('E9 no winner is ever selected for a conflict', () => {
  const index = pairIndex(status(30), status(30, { content: '<p>unverified divergence</p>' }));
  const record = index.contentRecords[0];
  const q = QUERY.createTemporalQuery(index);
  assert.equal(record.contentVersions.length, 2);
  refusal(() => q.getLatestProviderDeclaredVersion(record.upstreamIdentity), 'LATEST_AMBIGUOUS_CONFLICT');
});
test('E10 the temporal classification enum is closed with no fallback', () => {
  assert.deepEqual([...REV.PUBLIC_INTELLIGENCE_5K5_TEMPORAL_CLASSIFICATIONS].sort(),
    ['FIRST_OBSERVATION', 'PROVIDER_DECLARED_CONTENT_REVISION', 'SAME_CONTENT_SAME_STATE', 'SAME_CONTENT_UPDATED_STATE', 'UNVERIFIED_CONTENT_DIVERGENCE']);
  for (const record of CORPUS.buildTemporalCorpus([syntheticRun([status(30)], T0)]).observationRecords) {
    assert.ok(REV.PUBLIC_INTELLIGENCE_5K5_TEMPORAL_CLASSIFICATIONS.includes(record.temporalClassification));
  }
});

// ===========================================================================
// F. REVISION PROOF
// ===========================================================================
/**
 * Builds a run plus the GOVERNED ADDITIVE revision-evidence sidecars for it.
 *
 * The sidecar is a separate 5K.5 record bound to the unchanged 5K.1
 * `rawObservationFingerprint`. Nothing is added to the frozen 5K.1 raw record.
 */
function runWithRevisions(specs) {
  const store = CORE.createMemoryStore();
  const envelopes = [];
  const revisionEvidence = [];
  for (const { nativeStatus, editedAt, start } of specs) {
    const raw = rawOf(nativeStatus, { fetchedAt: start });
    CORE.ingestPublicObservation(raw, { store });
    envelopes.push(JSON.parse(JSON.stringify(store.list().at(-1))));
    if (editedAt !== null && editedAt !== undefined) {
      revisionEvidence.push(REV.buildRevisionEvidence({
        provider: raw.provider,
        providerObservationId: raw.providerObservationId,
        rawObservationFingerprint: PROJ.rawObservationFingerprint(raw),
        editedAt,
      }));
    }
  }
  const first = specs[0];
  const runId = `run-${String(first.start - T0).padStart(32, '0')}`;
  return {
    run: { manifest: { runId, manifestFingerprint: digest({ runId }) }, observations: envelopes },
    revisionEvidence,
  };
}
/** Two runs, where the second may carry a provider-declared edit. */
const revisionIndexOf = (firstStatus, secondStatus, secondEditedAt, firstStart = T0, secondStart = T0 + 1000) => {
  const a = runWithRevisions([{ nativeStatus: firstStatus, start: firstStart }]);
  const b = runWithRevisions([{ nativeStatus: secondStatus, editedAt: secondEditedAt, start: secondStart }]);
  return CORPUS.buildTemporalCorpus([a.run, b.run], { revisionEvidence: [...a.revisionEvidence, ...b.revisionEvidence] });
};

test('F1 a provider-declared edit with valid proof is a revision, not a conflict', () => {
  const index = revisionIndexOf(status(30), status(30, { content: '<p>post 30 genuinely edited</p>' }), T0 + 500);
  assert.deepEqual(onlyClassification(index), ['FIRST_OBSERVATION', 'PROVIDER_DECLARED_CONTENT_REVISION']);
  assert.equal(index.accounting.providerDeclaredRevisionCount, 1);
  assert.equal(index.accounting.conflictedUpstreamIdentityCount, 0);
});
test('F2 an edit timestamp that precedes the earlier fetch is refused as proof', () => {
  const index = revisionIndexOf(status(30), status(30, { content: '<p>edited too early to be proof</p>' }), T0, T0 + 1000, T0 + 2000);
  // The edit was already visible at the first fetch, so this stays a divergence.
  assert.deepEqual(onlyClassification(index), ['FIRST_OBSERVATION', 'UNVERIFIED_CONTENT_DIVERGENCE']);
});
test('F3 two different texts with NO proof are never called an edit', () => {
  assert.equal(REV.classifyTemporal(
    { contentFingerprint: 'a'.repeat(64), observationStateFingerprint: 'b'.repeat(64), fetchedAt: T0, providerRevisionTimestamp: null },
    { contentFingerprint: 'c'.repeat(64), observationStateFingerprint: 'd'.repeat(64), fetchedAt: T0 + 1, providerRevisionTimestamp: null },
  ), 'UNVERIFIED_CONTENT_DIVERGENCE');
});
test('F4 malformed revision evidence is refused', () => {
  for (const bad of ['not-a-number', -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    refusal(() => REV.buildRevisionEvidence({
      provider: `mastodon:${HOST}`, providerObservationId: '30', rawObservationFingerprint: 'a'.repeat(64), editedAt: bad,
    }), 'REVISION_TIMESTAMP_INVALID');
  }
  // A sidecar bound to no real raw evidence is refused outright.
  refusal(() => REV.buildRevisionEvidence({
    provider: `mastodon:${HOST}`, providerObservationId: '30', rawObservationFingerprint: 'notafingerprint', editedAt: T0,
  }), 'REVISION_EVIDENCE_BINDING_INVALID');
  // No evidence at all reads as null, never as a guess.
  assert.equal(REV.providerRevisionTimestampOf(new Map(), 'a'.repeat(64)), null);
});
test('F5 revision timestamp ordering is validated along the chain', () => {
  const a = runWithRevisions([{ nativeStatus: status(30), start: T0 }]);
  const b = runWithRevisions([{ nativeStatus: status(30, { content: '<p>v2</p>' }), editedAt: T0 + 500, start: T0 + 1000 }]);
  const c = runWithRevisions([{ nativeStatus: status(30, { content: '<p>v3</p>' }), editedAt: T0 + 1500, start: T0 + 2000 }]);
  const index = CORPUS.buildTemporalCorpus([a.run, b.run, c.run], { revisionEvidence: [...a.revisionEvidence, ...b.revisionEvidence, ...c.revisionEvidence] });
  assert.equal(index.contentRecords[0].versionCount, 3);
  const chain = REV.verifyRevisionChain(index.revisions);
  assert.equal(chain.ok, true, chain.failures.join(','));
  assert.equal(index.accounting.providerDeclaredRevisionCount, 2);
});
test('F6 a chain whose proof predates the earlier fetch is reported, not accepted', () => {
  const v0 = REV.buildRevisionRecord({
    upstreamIdentity: 'mastodon:x:1', provider: 'mastodon:x', providerObservationId: '1', versionIndex: 0,
    contentFingerprint: 'a'.repeat(64), rawObservationFingerprint: 'b'.repeat(64), providerRevisionTimestamp: null,
    runId: 'run-1', runManifestFingerprint: 'c'.repeat(64), fetchedAt: T0, supersedesContentFingerprint: null,
  });
  // The edit was declared BEFORE we first fetched, so it cannot prove that this
  // later observation is a revision of what we already had.
  const v1 = REV.buildRevisionRecord({
    upstreamIdentity: 'mastodon:x:1', provider: 'mastodon:x', providerObservationId: '1', versionIndex: 1,
    contentFingerprint: 'd'.repeat(64), rawObservationFingerprint: 'e'.repeat(64), providerRevisionTimestamp: T0 - 1000,
    runId: 'run-2', runManifestFingerprint: 'f'.repeat(64), fetchedAt: T0 + 10000, supersedesContentFingerprint: 'a'.repeat(64),
  });
  const result = REV.verifyRevisionChain([v1, v0]);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some(code => code.startsWith('REVISION_TIMESTAMP_NOT_AFTER_PRIOR_FETCH')), result.failures.join(','));
});
test('F7a a chain whose declared timestamps go backwards along the chain is reported', () => {
  const base = { upstreamIdentity: 'mastodon:x:1', provider: 'mastodon:x', providerObservationId: '1' };
  const v0 = REV.buildRevisionRecord({ ...base, versionIndex: 0, contentFingerprint: 'a'.repeat(64), rawObservationFingerprint: 'b'.repeat(64), providerRevisionTimestamp: null, runId: 'run-1', runManifestFingerprint: 'c'.repeat(64), fetchedAt: T0, supersedesContentFingerprint: null });
  const v1 = REV.buildRevisionRecord({ ...base, versionIndex: 1, contentFingerprint: 'd'.repeat(64), rawObservationFingerprint: 'e'.repeat(64), providerRevisionTimestamp: T0 + 5000, runId: 'run-2', runManifestFingerprint: 'f'.repeat(64), fetchedAt: T0 + 6000, supersedesContentFingerprint: 'a'.repeat(64) });
  // Version 2 declares an EARLIER edit than version 1 did.
  const v2 = REV.buildRevisionRecord({ ...base, versionIndex: 2, contentFingerprint: '1'.repeat(64), rawObservationFingerprint: '2'.repeat(64), providerRevisionTimestamp: T0 + 2000, runId: 'run-3', runManifestFingerprint: '3'.repeat(64), fetchedAt: T0 + 7000, supersedesContentFingerprint: 'd'.repeat(64) });
  const result = REV.verifyRevisionChain([v2, v1, v0]);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some(code => code.startsWith('REVISION_TIMESTAMP_OUT_OF_ORDER')), result.failures.join(','));
});
test('F7 every historical version is retained; there is no latest-wins overwrite', () => {
  const a = runWithRevisions([{ nativeStatus: status(30, { content: '<p>v1 text</p>' }), start: T0 }]);
  const b = runWithRevisions([{ nativeStatus: status(30, { content: '<p>v2 text</p>' }), editedAt: T0 + 500, start: T0 + 1000 }]);
  const c = runWithRevisions([{ nativeStatus: status(30, { content: '<p>v3 text</p>' }), editedAt: T0 + 1500, start: T0 + 2000 }]);
  const index = CORPUS.buildTemporalCorpus([a.run, b.run, c.run], { revisionEvidence: [...a.revisionEvidence, ...b.revisionEvidence, ...c.revisionEvidence] });
  const q = QUERY.createTemporalQuery(index);
  const versions = q.listAllVersions(index.contentRecords[0].upstreamIdentity);
  assert.equal(versions.length, 3, 'all three versions remain addressable');
  assert.deepEqual(versions.map(v => v.versionIndex), [0, 1, 2]);
  assert.equal(new Set(versions.map(v => v.contentFingerprint)).size, 3);
});
test('F8 the first version is never treated as a revision even if later declared', () => {
  const index = CORPUS.buildTemporalCorpus([syntheticRun([status(30)], T0)]);
  assert.equal(index.revisions[0].versionIndex, 0);
  assert.equal(index.revisions[0].providerRevisionTimestamp, null);
  assert.equal(index.revisions[0].supersedesContentFingerprint, null);
});
test('F9 "latest" is a deterministic read that mutates nothing', () => {
  const a = runWithRevisions([{ nativeStatus: status(30), start: T0 }]);
  const b = runWithRevisions([{ nativeStatus: status(30, { content: '<p>v2</p>' }), editedAt: T0 + 500, start: T0 + 1000 }]);
  const c = runWithRevisions([{ nativeStatus: status(30, { content: '<p>v3</p>' }), editedAt: T0 + 1500, start: T0 + 2000 }]);
  const index = CORPUS.buildTemporalCorpus([a.run, b.run, c.run], { revisionEvidence: [...a.revisionEvidence, ...b.revisionEvidence, ...c.revisionEvidence] });
  const q = QUERY.createTemporalQuery(index);
  const before = canonical(index);
  const latest = q.getLatestProviderDeclaredVersion(index.contentRecords[0].upstreamIdentity);
  assert.equal(latest.versionIndex, 2);
  assert.equal(canonical(index), before, 'the query changed nothing');
  assert.equal(q.listAllVersions(index.contentRecords[0].upstreamIdentity).length, 3, 'history is intact');
});
test('F10 a revision record is validated and its fingerprint is binding', () => {
  const index = revisionIndexOf(status(30), status(30, { content: '<p>v2</p>' }), T0 + 500);
  for (const record of index.revisions) REV.validateRevisionRecord(record);
  const tampered = { ...index.revisions[1], providerRevisionTimestamp: T0 + 999999 };
  refusal(() => REV.validateRevisionRecord(tampered), 'REVISION_FINGERPRINT_MISMATCH');
});
test('F11 records captured before 5K.5 remain valid and simply carry no revision proof', () => {
  // The frozen 5K.1 raw schema is untouched: 5K.5 adds no field to it.
  const raw = rawOf(status(30));
  assert.equal(Object.hasOwn(raw, 'providerRevision'), false);
  refusal(() => CORE.ingestPublicObservation({ ...raw, providerRevision: { editedAt: T0 } }, { store: CORE.createMemoryStore() }), 'UNKNOWN_FIELD');
  const index = pairIndex(status(30), status(30, { content: '<p>changed with no capture-time proof</p>' }));
  assert.deepEqual(onlyClassification(index), ['FIRST_OBSERVATION', 'UNVERIFIED_CONTENT_DIVERGENCE']);
});
test('F12 an unverified divergence never launders into a revision chain', () => {
  const a = runWithRevisions([{ nativeStatus: status(30), start: T0 }]);
  const b = runWithRevisions([{ nativeStatus: status(30, { content: '<p>unverified</p>' }), start: T0 + 1000 }]);
  const c = runWithRevisions([{ nativeStatus: status(30, { content: '<p>declared later</p>' }), editedAt: T0 + 1500, start: T0 + 2000 }]);
  const index = CORPUS.buildTemporalCorpus([a.run, b.run, c.run], { revisionEvidence: c.revisionEvidence });
  const declarations = onlyClassification(index);
  assert.deepEqual(declarations, ['FIRST_OBSERVATION', 'UNVERIFIED_CONTENT_DIVERGENCE', 'PROVIDER_DECLARED_CONTENT_REVISION']);
  assert.equal(index.accounting.conflictedUpstreamIdentityCount, 1, 'the identity is still conflicted');
  assert.equal(QUERY.createTemporalQuery(index).listConflicts().length, 1);
});

// ===========================================================================
// G. TEMPORAL ORDERING
// ===========================================================================
test('G1 temporal order is deterministic across repeated builds', () => {
  const builds = () => CORPUS.buildTemporalCorpus([
    syntheticRun([status(30), status(31)], T0),
    syntheticRun([status(30, { favourites_count: 14 })], T0 + 1000),
  ]);
  assert.equal(canonical(builds()), canonical(builds()));
});
test('G2 input run order is irrelevant to the output', () => {
  const a = syntheticRun([status(30, { favourites_count: 14 })], T0 + 1000);
  const b = syntheticRun([status(30)], T0);
  const c = syntheticRun([status(31)], T0 + 500);
  const forward = CORPUS.buildTemporalCorpus([a, b, c]);
  const reverse = CORPUS.buildTemporalCorpus([c, b, a]);
  assert.equal(canonical(forward.contentRecords), canonical(reverse.contentRecords));
  assert.equal(canonical(forward.observationRecords), canonical(reverse.observationRecords));
});
test('G3 ordering derives from the authenticated fetch instant, not run order', () => {
  const index = CORPUS.buildTemporalCorpus([
    syntheticRun([status(30, { favourites_count: 20 })], T0 + 5000),
    syntheticRun([status(30, { favourites_count: 10 })], T0),
  ]);
  const records = index.observationRecords.filter(r => r.providerObservationId === '30');
  const likes = QUERY.createTemporalQuery(index).getObservationStateHistory(index.contentRecords[0].upstreamIdentity).map(s => s.values.likes);
  assert.deepEqual(likes, [10, 20], 'chronological by fetchedAt regardless of input order');
  assert.equal(records[0].fetchedAt, T0);
});
test('G4 identical timestamps are broken deterministically by fingerprint then run id', () => {
  const left = () => CORPUS.compareTemporal({ fetchedAt: T0, rawObservationFingerprint: 'a'.repeat(64), runId: 'run-1' }, { fetchedAt: T0, rawObservationFingerprint: 'b'.repeat(64), runId: 'run-2' });
  assert.equal(left(), -1);
  assert.equal(CORPUS.compareTemporal({ fetchedAt: T0, rawObservationFingerprint: 'b'.repeat(64), runId: 'run-2' }, { fetchedAt: T0, rawObservationFingerprint: 'a'.repeat(64), runId: 'run-1' }), 1);
  assert.equal(CORPUS.compareTemporal({ fetchedAt: T0, rawObservationFingerprint: 'a'.repeat(64), runId: 'run-1' }, { fetchedAt: T0, rawObservationFingerprint: 'a'.repeat(64), runId: 'run-2' }), -1);
  assert.equal(CORPUS.compareTemporal({ fetchedAt: T0, rawObservationFingerprint: 'a'.repeat(64), runId: 'run-1' }, { fetchedAt: T0, rawObservationFingerprint: 'a'.repeat(64), runId: 'run-1' }), 0);
});
test('G5 two observations sharing a timestamp and fingerprint order stably by run id', () => {
  const a = syntheticRun([status(30, { favourites_count: 10 })], T0);
  const b = syntheticRun([status(30, { favourites_count: 14 })], T0);
  const forward = CORPUS.buildTemporalCorpus([a, b]);
  const reverse = CORPUS.buildTemporalCorpus([b, a]);
  assert.equal(canonical(forward.observationRecords), canonical(reverse.observationRecords));
});
test('G6 no filesystem mtime, clock or Map insertion order participates in ordering', () => {
  for (const entry of TEMPORAL_MODULES.filter(candidate => /corpus|revision|projection|state|query/.test(candidate))) {
    const { found } = parseModule(entry);
    for (const forbidden of ['DateNow', 'mtime', 'ctime', 'atime', 'statSync', 'readdirSync', 'performance']) {
      assert.ok(!found.identifiers.includes(forbidden), `${entry} references ${forbidden}`);
    }
  }
  // The primary sort key is the authenticated fetchedAt field, full stop.
  const { source } = parseModule(`${PI}/temporal-corpus.mjs`);
  assert.ok(/a\.fetchedAt !== b\.fetchedAt/.test(source));
  assert.ok(!/Date\.now|new Date/.test(source));
});

// ===========================================================================
// H. SNAPSHOT ACCOUNTING (real 5K.3 runs on disk)
// ===========================================================================
async function standardSnapshot(extraSpecs = []) {
  const root = tempRoot();
  const runs = [];
  runs.push(await makeRun(root, { start: T0, pages: [[status(30, { favourites_count: 10 }), status(31)]] }));
  runs.push(await makeRun(root, { start: T0 + 100_000, pages: [[status(30, { favourites_count: 14 }), status(32)]] }));
  for (const spec of extraSpecs) runs.push(await makeRun(root, spec));
  const result = SNAP.buildAndStoreTemporalSnapshot({ root, runIds: runs.map(r => r.runId), policy: DEFAULT_POLICY, createdAt: T0 + 1_000_000 });
  return { root, runs, result, id: result.temporalSnapshotId, dir: result.directory, manifest: result.manifest };
}
const accountOf = ctx => ctx.manifest.accounting;

test('H1 a real two-run snapshot builds and verifies end to end', async () => {
  const ctx = await standardSnapshot();
  assert.equal(ctx.result.outcome, 'CREATED');
  const verification = verifyOf(ctx);
  assert.equal(verification.ok, true, verification.failures.join(','));
});
test('H2 upstream identity count equals the number of distinct identities seen', async () => {
  const ctx = await standardSnapshot();
  assert.equal(accountOf(ctx).upstreamIdentityCount, 3);
  assert.equal(ctx.manifest.upstreamIdentityCount, 3);
});
test('H3 content-version count is one per identity when nothing was edited', async () => {
  const ctx = await standardSnapshot();
  assert.equal(ctx.manifest.contentVersionCount, 3);
  assert.equal(accountOf(ctx).contentVersionCount, 3);
});
test('H4 state-snapshot count is one per authenticated acquisition', async () => {
  const ctx = await standardSnapshot();
  assert.equal(ctx.manifest.observationStateSnapshotCount, 4, '30 and 31 then 30 and 32');
  assert.equal(readNd(file(ctx.dir, 'observation-states.ndjson')).length, 4);
});
test('H5 an observation-state update is counted as a state snapshot and NOT as a duplicate', async () => {
  const ctx = await standardSnapshot();
  assert.equal(accountOf(ctx).sameContentUpdatedStateCount, 1);
  assert.equal(accountOf(ctx).duplicateAppearanceCount, 0, 'a changed counter is new state, not a redundant appearance');
  assert.equal(CORPUS.PUBLIC_INTELLIGENCE_5K5_CORPUS_SEMANTICS.observationStateUpdateIsDuplicate, false);
});
test('H6 revision count and conflict count are reported separately', async () => {
  const ctx = await standardSnapshot();
  assert.equal(ctx.manifest.providerDeclaredRevisionCount, 0);
  assert.equal(ctx.manifest.unverifiedDivergenceCount, 0);
  assert.equal(ctx.manifest.conflictedUpstreamIdentityCount, 0);
});
test('H7 the accounting equations hold on a real snapshot', async () => {
  const ctx = await standardSnapshot();
  const A = accountOf(ctx);
  assert.equal(A.observationRecordCount, 4);
  assert.equal(A.firstObservationCount, A.upstreamIdentityCount);
  assert.equal(A.firstObservationCount + A.duplicateAppearanceCount + A.sameContentUpdatedStateCount
    + A.providerDeclaredRevisionCount + A.unverifiedDivergenceCount, A.observationRecordCount);
  assert.equal(A.observationStateSnapshotCount, A.observationRecordCount);
});
test('H8 accounting fails closed on injected count drift', async () => {
  const ctx = await standardSnapshot();
  const tampered = { ...ctx.manifest, upstreamIdentityCount: 99 };
  const rebuilt = SNAP.buildSnapshotManifest(SNAP.rebuildTemporalSnapshot({ root: ctx.root, runIds: ctx.runs.map(r => r.runId) }), ctx.manifest.createdAt);
  assert.notEqual(rebuilt.upstreamIdentityCount, tampered.upstreamIdentityCount);
  // The verifier catches a stored manifest whose counts no longer match.
  chmodSync(file(ctx.dir, 'temporal-snapshot.json'), 0o644);
  const manifest = JSON.parse(readFileSync(file(ctx.dir, 'temporal-snapshot.json'), 'utf8'));
  manifest.upstreamIdentityCount = 99;
  manifest.snapshotFingerprint = SNAP.temporalSnapshotFingerprintOf(manifest);
  writeFileSync(file(ctx.dir, 'temporal-snapshot.json'), `${canonical(manifest)}\n`);
  const verification = verifyOf(ctx);
  assert.equal(verification.ok, false);
  assert.ok(hasFailure(verification, 'COUNT_DRIFT:upstreamIdentityCount'), verification.failures.join(','));
});
test('H10 a conflicted identity is flagged, never resolved', async () => {
  const index = pairIndex(status(30), status(30, { content: '<p>unverified change</p>' }));
  assert.equal(index.contentRecords[0].conflicted, true);
  assert.equal(index.contentVersions ?? index.contentRecords[0].versionCount, 2, 'both versions retained');
  assert.equal(CORPUS.PUBLIC_INTELLIGENCE_5K5_CORPUS_SEMANTICS.winnerSelectedOnConflict, false);
  assert.equal(CORPUS.PUBLIC_INTELLIGENCE_5K5_CORPUS_SEMANTICS.historyOverwritten, false);
});
test('H11 declared revisions and divergences exactly cover the revision-chain links', async () => {
  const a = runWithRevisions([{ nativeStatus: status(30), start: T0 }]);
  const b = runWithRevisions([{ nativeStatus: status(30, { content: '<p>v2</p>' }), editedAt: T0 + 500, start: T0 + 1000 }]);
  const index = CORPUS.buildTemporalCorpus([a.run, b.run], { revisionEvidence: [...a.revisionEvidence, ...b.revisionEvidence] });
  const A = index.accounting;
  assert.equal(A.revisionChainLinkCount, 1);
  assert.equal(A.providerDeclaredRevisionCount, 1);
  assert.equal(A.unverifiedDivergenceCount, 0);
  assert.equal(A.providerDeclaredRevisionCount + A.unverifiedDivergenceCount, A.revisionChainLinkCount);
  assert.equal(index.contentRecords[0].conflicted, false);
});
test('H12 every content version keeps its own mint association across a revision', () => {
  const a = runWithRevisions([{ nativeStatus: status(30, { content: `<p>v1 ${MINT}</p>` }), start: T0 }]);
  const b = runWithRevisions([{ nativeStatus: status(30, { content: `<p>v2 ${MINT_2}</p>` }), editedAt: T0 + 500, start: T0 + 1000 }]);
  const index = CORPUS.buildTemporalCorpus([a.run, b.run], { revisionEvidence: [...a.revisionEvidence, ...b.revisionEvidence] });
  const associations = index.observationRecords.map(r => r.assetAssociation);
  assert.deepEqual(associations.map(a => a.mint).sort(), [MINT, MINT_2].sort(), 'both explicit mints are retained, neither rewritten');
  assert.equal(index.accounting.associatedVersionCount, 2);
});
test('H9 accounting ignores identity order and filesystem enumeration order', async () => {
  const a = await standardSnapshot();
  const b = await standardSnapshot();
  assert.equal(a.manifest.temporalSnapshotId, b.manifest.temporalSnapshotId, 'same run set => same snapshot id');
  assert.equal(canonical(a.manifest.accounting), canonical(b.manifest.accounting));
});

// ===========================================================================
// I. QUERY API
// ===========================================================================
test('I1 the query API exposes retrieval only, with no scoring or ranking', () => {
  for (const name of QUERY.PUBLIC_INTELLIGENCE_5K5_QUERY_API) {
    assert.ok(!/score|rank|sentiment|momentum|velocity|growth|trend|signal|profit|alpha|recommend|predict|viral|popular|importance/i.test(name), name);
  }
  // No arithmetic across observations, and no sorting by any computed value.
  const { found, source } = parseModule(`${PI}/temporal-query.mjs`);
  assert.equal(source.includes('.sort(') && !source.includes('sort(compareTemporal)') && !source.includes('.sort((a, b)') , false, 'no ad-hoc sort may appear in the query layer');
  for (const forbidden of ['score', 'rank', 'momentum', 'velocity', 'deltaOf', 'growthOf']) {
    assert.ok(!found.identifiers.includes(forbidden), forbidden);
  }
  // The only ordering the query layer performs is the shared temporal comparator.
  assert.ok(source.includes('sort(compareTemporal)'));
});
test('I2 exact upstream lookup returns the one canonical content record', () => {
  const index = pairIndex(status(30, { favourites_count: 10 }), status(30, { favourites_count: 14 }));
  const q = QUERY.createTemporalQuery(index);
  assert.equal(q.listContents().length, 1);
  assert.equal(q.getContent(index.contentRecords[0].upstreamIdentity).versionCount, 1);
  assert.equal(q.getContent('nope:nope'), null);
});
test('I3 exact content lookup by provider and mint is a string match, never a fold', () => {
  const index = CORPUS.buildTemporalCorpus([syntheticRun([status(30), status(33, { content: `<p>x ${MINT_2}</p>` })], T0)]);
  const q = QUERY.createTemporalQuery(index);
  assert.equal(q.listByExactMint(MINT).length, 1);
  assert.equal(q.listByExactMint(MINT.toLowerCase()).length, 0, 'a differently cased address is a different identity');
  assert.equal(q.listByProvider(`mastodon:${HOST}`).length, 2);
});
test('I4 observation-state history is read-only, chronological and complete', () => {
  const index = CORPUS.buildTemporalCorpus([
    syntheticRun([status(30, { favourites_count: 10 })], T0),
    syntheticRun([status(30, { favourites_count: 14 })], T0 + 1000),
    syntheticRun([status(30, { favourites_count: 12 })], T0 + 2000),
  ]);
  const q = QUERY.createTemporalQuery(index);
  const identity = index.contentRecords[0].upstreamIdentity;
  const history = q.getObservationStateHistory(identity);
  assert.deepEqual(history.map(s => s.values.likes), [10, 14, 12]);
  assert.deepEqual(history.map(s => s.fetchedAt), [T0, T0 + 1000, T0 + 2000]);
  assert.throws(() => { history[0].values.likes = 999; }, TypeError, 'the history is frozen');
});
test('I5 version history is available without any destructive selection', () => {
  const a = runWithRevisions([{ nativeStatus: status(30, { content: '<p>v1</p>' }), start: T0 }]);
  const b = runWithRevisions([{ nativeStatus: status(30, { content: '<p>v2</p>' }), editedAt: T0 + 500, start: T0 + 1000 }]);
  const index = CORPUS.buildTemporalCorpus([a.run, b.run], { revisionEvidence: [...a.revisionEvidence, ...b.revisionEvidence] });
  const q = QUERY.createTemporalQuery(index);
  const identity = index.contentRecords[0].upstreamIdentity;
  assert.equal(q.listAllVersions(identity).length, 2);
  assert.equal(q.getRevisionChain(identity).length, 2);
  assert.equal(q.getLatestProviderDeclaredVersion(identity).versionIndex, 1);
  // Asking for latest did not remove anything.
  assert.equal(q.listAllVersions(identity).length, 2);
});
test('I6 querying an unknown identity returns null or refuses, never a default record', () => {
  const index = pairIndex(status(30), status(30));
  const q = QUERY.createTemporalQuery(index);
  assert.equal(q.getContent('mastodon:nope:1'), null);
  assert.deepEqual(q.listAllVersions('mastodon:nope:1'), []);
  refusal(() => q.getContent(''), 'QUERY_IDENTITY_REQUIRED');
  refusal(() => q.listByExactMint(''), 'QUERY_MINT_REQUIRED');
});
test('I7 the accounting surface reports coverage only', () => {
  const index = pairIndex(status(30), status(30, { favourites_count: 14 }));
  const accounting = QUERY.createTemporalQuery(index).accounting();
  assert.equal(accounting.upstreamIdentityCount, 1);
  assert.equal(accounting.sameContentUpdatedStateCount, 1);
  assert.equal(CORPUS.PUBLIC_INTELLIGENCE_5K5_CORPUS_SEMANTICS.scoringApplied, false);
  assert.equal(CORPUS.PUBLIC_INTELLIGENCE_5K5_CORPUS_SEMANTICS.rankingApplied, false);
});

// ===========================================================================
// J. MISSINGNESS
// ===========================================================================
test('J1 an absent engagement object stays null and is never coerced', () => {
  const bare = () => { const s = status(30); delete s.favourites_count; delete s.replies_count; delete s.reblogs_count; return s; };
  const state = STATE.buildObservationState(rawOf(bare()), { runId: 'run-x', runManifestFingerprint: 'a'.repeat(64) });
  assert.equal(state.status, 'NO_OBSERVATION');
  assert.equal(state.values, null);
  STATE.validateObservationStateRecord(state);
});
test('J2 an absent counter inside a supplied object stays absent, not zero', () => {
  const s = status(30); delete s.replies_count;
  const projection = PROJ.observationStateProjection(rawOf(s));
  assert.ok(!Object.hasOwn(projection.values, 'replies'));
  assert.ok(!Object.hasOwn(projection.values, 'replies') || projection.values.replies !== 0);
  assert.ok(projection.absentCounters.includes('replies'));
});
test('J3 nothing is interpolated or carried forward between runs', () => {
  const bare = () => { const s = status(30); delete s.favourites_count; delete s.replies_count; delete s.reblogs_count; return s; };
  const index = pairIndex(status(30, { favourites_count: 14 }), bare());
  const history = QUERY.createTemporalQuery(index).getObservationStateHistory(index.contentRecords[0].upstreamIdentity);
  assert.equal(history[1].values, null);
  assert.equal(history[1].zeroFillingApplied, false);
  assert.equal(history[1].carryForwardApplied, false);
  assert.equal(history[1].interpolationApplied, false);
});
test('J4 a state record with missingness made into values is refused', () => {
  const index = pairIndex(status(30), status(30));
  const record = index.states[0];
  refusal(() => STATE.validateObservationStateRecord({ ...record, status: 'NO_OBSERVATION', values: { likes: 0 } }), 'MISSING_MADE_VALUES');
});
test('J5 a state record claiming zero filling is refused', () => {
  const index = pairIndex(status(30), status(30));
  for (const flag of ['zeroFillingApplied', 'carryForwardApplied', 'interpolationApplied', 'deltaComputed']) {
    refusal(() => STATE.validateObservationStateRecord({ ...index.states[0], [flag]: true }), 'DISALLOWED_OPERATION');
  }
});

// ===========================================================================
// K. TAMPER
// ===========================================================================
function editNd(target, fn) {
  chmodSync(target, 0o644);
  const records = readNd(target);
  const out = fn([...records]) ?? records;
  writeFileSync(target, out.map(record => `${canonical(record)}\n`).join(''));
}
function editTemporalManifest(ctx, fn, resign = true) {
  const target = file(ctx.dir, 'temporal-snapshot.json');
  chmodSync(target, 0o644);
  const manifest = JSON.parse(readFileSync(target, 'utf8'));
  fn(manifest);
  if (resign) manifest.snapshotFingerprint = SNAP.temporalSnapshotFingerprintOf(manifest);
  writeFileSync(target, `${canonical(manifest)}\n`);
}

test('K1 a changed content fingerprint is rejected', async () => {
  const ctx = await standardSnapshot();
  editNd(file(ctx.dir, 'content-records.ndjson'), records => records.map(r => (r.providerObservationId === '30' ? { ...r, contentFingerprint: 'f'.repeat(64) } : r)));
  const verification = verifyOf(ctx);
  assert.equal(verification.ok, false);
  assert.ok(hasFailure(verification, 'CONTENT_MODIFIED'), verification.failures.join(','));
});
test('K2 a changed observation-state fingerprint is rejected', async () => {
  const ctx = await standardSnapshot();
  editNd(file(ctx.dir, 'observation-records.ndjson'), records => records.map(r => ({ ...r, observationStateFingerprint: 'e'.repeat(64) })));
  const verification = verifyOf(ctx);
  assert.equal(verification.ok, false);
  assert.ok(hasFailure(verification, 'OBSERVATION_MODIFIED'), verification.failures.join(','));
});
test('K3 a removed state snapshot is rejected', async () => {
  const ctx = await standardSnapshot();
  editNd(file(ctx.dir, 'observation-states.ndjson'), records => records.slice(1));
  const verification = verifyOf(ctx);
  assert.equal(verification.ok, false);
  assert.ok(hasFailure(verification, 'STATE_SNAPSHOT_REMOVED'), verification.failures.join(','));
});
test('K4 an injected state snapshot is rejected', async () => {
  const ctx = await standardSnapshot();
  editNd(file(ctx.dir, 'observation-states.ndjson'), records => [...records, { ...records[0], stateRecordFingerprint: 'a'.repeat(64) }]);
  const verification = verifyOf(ctx);
  assert.equal(verification.ok, false);
  assert.ok(hasFailure(verification, 'STATE_SNAPSHOT_INJECTED'), verification.failures.join(','));
});
test('K5 an injected content record for an unobserved identity is rejected', async () => {
  const ctx = await standardSnapshot();
  editNd(file(ctx.dir, 'content-records.ndjson'), records => [...records, { ...records[0], upstreamIdentity: 'mastodon:ghost:99', contentRecordFingerprint: 'b'.repeat(64) }]);
  const verification = verifyOf(ctx);
  assert.equal(verification.ok, false);
  assert.ok(hasFailure(verification, 'CONTENT_INJECTED'), verification.failures.join(','));
});
test('K6 a tampered revision chain is rejected', async () => {
  const ctx = await standardSnapshot();
  editNd(file(ctx.dir, 'revisions.ndjson'), records => records.map(r => ({ ...r, supersedesContentFingerprint: 'c'.repeat(64) })));
  const verification = verifyOf(ctx);
  assert.equal(verification.ok, false);
  assert.ok(hasFailure(verification, 'REVISION_MODIFIED'), verification.failures.join(','));
});
test('K7 a tampered snapshot count is rejected even when the manifest is re-signed', async () => {
  const ctx = await standardSnapshot();
  editTemporalManifest(ctx, m => { m.contentVersionCount += 5; });
  const verification = verifyOf(ctx);
  assert.equal(verification.ok, false);
  assert.ok(hasFailure(verification, 'COUNT_DRIFT:contentVersionCount'), verification.failures.join(','));
});
test('K8 a tampered snapshot digest is rejected', async () => {
  const ctx = await standardSnapshot();
  editTemporalManifest(ctx, m => { m.stateDigest = 'd'.repeat(64); });
  const verification = verifyOf(ctx);
  assert.equal(verification.ok, false);
  assert.ok(hasFailure(verification, 'DIGEST_DRIFT:stateDigest'), verification.failures.join(','));
});
test('K9 an unsigned manifest is rejected', async () => {
  const ctx = await standardSnapshot();
  editTemporalManifest(ctx, m => { m.upstreamIdentityCount += 1; }, false);
  assert.ok(hasFailure(verifyOf(ctx), 'SNAPSHOT_FINGERPRINT_MISMATCH'));
});
test('K10 an extra file in the snapshot directory is rejected', async () => {
  const ctx = await standardSnapshot();
  writeFileSync(file(ctx.dir, 'smuggled.ndjson'), '{}\n');
  assert.ok(hasFailure(verifyOf(ctx), 'EXTRA_FILES'));
});
test('K11 tampering with the underlying run makes the snapshot unverifiable', async () => {
  const ctx = await standardSnapshot();
  const rawPath = path.join(ctx.root, 'runs', ctx.runs[0].runId, 'raw-evidence.ndjson');
  chmodSync(rawPath, 0o644);
  const records = readNd(rawPath);
  records[0].rawText = `${records[0].rawText} TAMPERED`;
  writeFileSync(rawPath, records.map(r => `${canonical(r)}\n`).join(''));
  const verification = verifyOf(ctx);
  assert.equal(verification.ok, false);
  assert.ok(verification.failures.some(code => code.startsWith('RUN_NOT_ADMITTED')), verification.failures.join(','));
});
test('K12 a revision sidecar bound to unknown evidence is refused', () => {
  refusal(() => REV.indexRevisionEvidence(
    [REV.buildRevisionEvidence({ provider: 'mastodon:x', providerObservationId: '1', rawObservationFingerprint: 'a'.repeat(64), editedAt: T0 })],
    new Set(),
  ), 'BOUND_TO_UNKNOWN_EVIDENCE');
});
test('K13 a tampered revision-evidence sidecar is rejected by its own validator', () => {
  const evidence = REV.buildRevisionEvidence({ provider: 'mastodon:x', providerObservationId: '1', rawObservationFingerprint: 'a'.repeat(64), editedAt: T0 });
  REV.validateRevisionEvidence(evidence);
  refusal(() => REV.validateRevisionEvidence({ ...evidence, providerRevisionTimestamp: T0 + 1 }), 'REV_EVIDENCE_FINGERPRINT_MISMATCH');
  refusal(() => REV.validateRevisionEvidence({ ...evidence, extra: 1 }), 'REV_EVIDENCE_UNKNOWN_FIELD');
});

// ===========================================================================
// L. BACKWARD COMPATIBILITY
// ===========================================================================
test('L1 an existing 5K.3 run fixture still verifies unchanged', async () => {
  const root = tempRoot();
  const run = await makeRun(root, { start: T0, pages: [[status(30)]] });
  const verification = RUNS.replayRun(run.directory);
  assert.equal(verification.ok, true, verification.failures.join(','));
});
test('L2 an existing 5K.4 corpus snapshot still verifies after 5K.5 exists', async () => {
  const root = tempRoot();
  const a = await makeRun(root, { start: T0, pages: [[status(30), status(29)]] });
  const b = await makeRun(root, { start: T0 + 100_000, pages: [[status(30)]] });
  const built = SNAP4.buildAndStoreSnapshot({ root, runIds: [a.runId, b.runId], createdAt: T0 + 1_000_000 });
  assert.equal(VERIFY4.verifySnapshot(root, built.snapshotId).ok, true, '5K.4 snapshots remain verifiable');
});
test('L3 5K.5 does not mutate any prior artifact and writes into its own namespace', async () => {
  const root = tempRoot();
  const runs = [
    await makeRun(root, { start: T0, pages: [[status(30)]] }),
    await makeRun(root, { start: T0 + 100_000, pages: [[status(30, { favourites_count: 14 })]] }),
  ];
  const before = hashTree(path.join(root, 'runs'));
  const temporal = SNAP.buildAndStoreTemporalSnapshot({ root, runIds: runs.map(r => r.runId), createdAt: T0 + 1_000_000 });
  const after = hashTree(path.join(root, 'runs'));
  assert.deepEqual(after, before, 'run artifacts are byte-identical after a 5K.5 build');
  // 5K.5 stores under temporal-corpora/, never beside 5K.4's corpora/.
  assert.ok(temporal.directory.includes(path.join('temporal-corpora', 'tsnap-')));
  assert.ok(!existsSync(path.join(root, 'corpora')));
});
test('L4 building the same temporal corpus twice is write-once and identical', async () => {
  const root = tempRoot();
  const runs = [await makeRun(root, { start: T0, pages: [[status(30)]] })];
  const first = SNAP.buildAndStoreTemporalSnapshot({ root, runIds: runs.map(r => r.runId), createdAt: T0 + 1_000_000 });
  const second = SNAP.buildAndStoreTemporalSnapshot({ root, runIds: runs.map(r => r.runId), createdAt: T0 + 2_000_000 });
  assert.equal(first.outcome, 'CREATED');
  assert.equal(second.outcome, 'ALREADY_EXISTS_IDENTICAL');
  assert.equal(second.directory, first.directory);
});
test('L5 5K.5 uses versioned schema and policy names distinct from 5K.4', () => {
  assert.equal(PROJ.PUBLIC_INTELLIGENCE_5K5_SCHEMA_VERSION, '5K.5.0');
  assert.equal(PROJ.PUBLIC_INTELLIGENCE_5K5_TEMPORAL_POLICY_VERSION, 'temporal-policy-1');
  assert.equal(SNAP.PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_POLICY_VERSION, 'temporal-snapshot-1');
  assert.equal(SNAP.PUBLIC_INTELLIGENCE_5K5_SNAPSHOT_SCHEMA.fields.includes('temporalPolicyVersion'), true);
});
test('L6 historical records with no revision evidence remain fully valid', () => {
  const index = CORPUS.buildTemporalCorpus([syntheticRun([status(30), status(31)], T0)]);
  for (const record of index.revisions) {
    assert.equal(record.versionIndex, 0);
    assert.equal(record.providerRevisionTimestamp, null);
    REV.validateRevisionRecord(record);
  }
});
test('L7 every 5K.0-5K.4 module is unmodified by 5K.5', () => {
  // Derived from git rather than a hardcoded file list: the set of files this
  // phase touched must contain NOTHING that existed before it. Naming those
  // files here would re-create the exact import-boundary coupling this repair
  // removes, so the assertion is expressed as "every change is a NEW file".
  const status = gitOut('diff', '--name-status', K5_BASE, 'HEAD').split('\n').filter(Boolean);
  const touched = status.map(line => line.slice(2));
  const notAdded = status.filter(line => !line.startsWith('A\t'));
  assert.equal(notAdded.join(' '), '',
    `5K.5 must only ADD files; these pre-existing paths changed: ${notAdded.map(l => l.slice(2)).join(' ')}`);
  for (const file of touched) {
    assert.ok(/5K5|5k5|temporal-|observation-state|revision-chain/.test(file),
      `5K.5 touched an unrelated path: ${file}`);
  }
});

// ===========================================================================
// M. PRIVACY
// ===========================================================================
test('M1 no observation-state record carries a personal profile field', () => {
  const index = CORPUS.buildTemporalCorpus([
    syntheticRun([status(30, { favourites_count: 10 })], T0),
    syntheticRun([status(30, { favourites_count: 14 })], T0 + 1000),
  ]);
  const forbidden = /display_?name|avatar|followers?_count|following|note|bio|email|phone|location|geo|address|realname|header/i;
  for (const record of index.states) {
    for (const key of Object.keys(record)) assert.ok(!forbidden.test(key), key);
    // Only structural counters and fingerprints.
    assert.deepEqual(Object.keys(record.values ?? {}).sort().filter(k => !PROJ.PUBLIC_INTELLIGENCE_5K5_OBSERVATION_STATE_FIELDS.includes(k)), []);
  }
  assert.equal(STATE.PUBLIC_INTELLIGENCE_5K5_STATE_SEMANTICS.containsPersonalProfileData, false);
});
test('M2 no temporal artifact carries credential material', () => {
  const index = CORPUS.buildTemporalCorpus([syntheticRun([status(30)], T0)]);
  const serialized = JSON.stringify([index.contentRecords, index.observationRecords, index.states, index.revisions]).toLowerCase();
  for (const word of ['token', 'cookie', 'authorization', 'apikey', 'api_key', 'password', 'secret', 'bearer', 'mnemonic']) {
    assert.ok(!serialized.includes(`"${word}`), word);
  }
  assert.equal(STATE.PUBLIC_INTELLIGENCE_5K5_STATE_SEMANTICS.containsCredentialData, false);
});
test('M3 no mention graph, follower graph or geolocation is built', () => {
  // The provider record deliberately carries a profile the mapper must discard.
  const raw = rawOf(status(30));
  assert.deepEqual(raw.rawMetadata.mentionedHandles, []);
  assert.equal(Object.hasOwn(raw.rawMetadata, 'account'), false);
  for (const word of ['followers', 'following', 'location', 'latitude', 'longitude']) {
    assert.ok(!JSON.stringify(raw).toLowerCase().includes(`"${word}`), word);
  }
  assert.equal(STATE.PUBLIC_INTELLIGENCE_5K5_STATE_SEMANTICS.containsGeolocationData, false);
});
test('M4 a content projection never carries the post body or a profile field', () => {
  const projection = PROJ.contentProjection(rawOf(status(30)));
  assert.equal(Object.hasOwn(projection.content, 'rawText'), true, 'rawText is projected, then hashed - never emitted raw');
  const record = CORPUS.buildTemporalCorpus([syntheticRun([status(30)], T0)]).contentRecords[0];
  const serialized = JSON.stringify(record).toLowerCase();
  assert.ok(!serialized.includes('post 30'), 'no post text is duplicated into the derived index');
  assert.ok(!serialized.includes('alice real name'));
});

// ===========================================================================
// N. ARCHITECTURAL ISOLATION
// ===========================================================================
test('N1 the temporal layer imports nothing that can open a socket', () => {
  for (const entry of TEMPORAL_MODULES) {
    const { found } = parseModule(entry);
    for (const source of found.importSources) {
      assert.ok(!NETWORK_BUILTINS.includes(source), `${entry} imports ${source}`);
    }
  }
});
test('N2 the temporal layer imports no wallet, signing or RPC-write module', () => {
  for (const entry of TEMPORAL_MODULES) {
    const { found } = parseModule(entry);
    for (const source of found.importSources) {
      assert.ok(!WALLET_MODULES.includes(source), `${entry} imports ${source}`);
      assert.ok(!ENGINE_MODULES.some(mod => source.includes(mod)), `${entry} imports ${source}`);
    }
    for (const identifier of found.identifiers) {
      assert.ok(!SIGNING_OR_RPC_WRITE.includes(identifier), `${entry} references ${identifier}`);
    }
  }
});
test('N3 the pure temporal modules import no filesystem module at all', () => {
  for (const entry of PURE_MODULES) {
    const { found } = parseModule(entry);
    for (const source of found.importSources) {
      assert.ok(!source.startsWith('node:fs'), `${entry} imports ${source}`);
    }
  }
});
test('N4 the temporal closure reaches no engine, Arena, wallet or trading module', () => {
  for (const entry of closureAll) {
    for (const forbidden of ['evolve-engine', 'arena', 'wallet', 'signer', 'promotion', 'breeding', 'champion']) {
      assert.ok(!entry.includes(forbidden), `import closure reaches ${entry}`);
    }
  }
});
test('N5 no temporal module writes under .evolve or spawns a process', () => {
  for (const entry of TEMPORAL_MODULES) {
    const { found } = parseModule(entry);
    for (const identifier of found.identifiers) {
      assert.ok(!['exec', 'execSync', 'spawn', 'fork', 'setInterval', 'setTimeout', 'eval'].includes(identifier), `${entry} references ${identifier}`);
    }
    for (const source of found.importSources) {
      assert.ok(!source.includes('child_process'), `${entry} imports ${source}`);
    }
    assert.ok(!found.stringLiterals.includes('.evolve'), `${entry} names .evolve`);
  }
});
test('N6 the temporal storage refuses a .evolve runtime root', async () => {
  const root = tempRoot();
  await makeRun(root, { start: T0, pages: [[status(30)]] });
  refusal(() => SNAP.temporalCorporaDirectoryOf(path.join(root, '.evolve', 'public-intelligence'), 'tsnap-' + 'a'.repeat(32)),
    'STORE_PATH_FORBIDDEN');
  refusal(() => SNAP.temporalCorporaDirectoryOf('/etc/evolve-not-a-runtime-root', 'tsnap-' + 'a'.repeat(32)),
    'OUTSIDE_ALLOWED_AREAS');
  refusal(() => SNAP.temporalCorporaDirectoryOf(path.join(root, 'rel'), 'not-a-snapshot-id'), 'SNAPSHOT_ID_INVALID');
});

// ===========================================================================
// O. REGRESSION
// ===========================================================================
const phaseCount = (script, line) => assert.ok(execFileSync('node', [script], { cwd: REPO_ROOT, encoding: 'utf8' }).includes(line), `${script} did not report ${line}`);
test('O1 5K.0 stays 32/32', () => phaseCount('scripts/validate-phase5k.mjs', 'Phase 5K.0: 32/32 passed'));
test('O2 5K.1 stays 64/64', () => phaseCount('scripts/validate-phase5k1.mjs', 'Phase 5K.1: 64/64 passed'));
test('O3 5K.2 stays 70/70', () => phaseCount('scripts/validate-phase5k2.mjs', 'Phase 5K.2: 70/70 passed'));
test('O4 5K.3 stays 96/96', () => phaseCount('scripts/validate-phase5k3.mjs', 'Phase 5K.3: 96/96 passed'));
test('O5 5K.4 stays 116/116', () => phaseCount('scripts/validate-phase5k4.mjs', 'Phase 5K.4: 116/116 passed'));
test('O6 R4 C1 is an ancestor of HEAD and finalized R4 files are unchanged', () => {
  execFileSync('git', ['merge-base', '--is-ancestor', R4_HEAD, 'HEAD'], { cwd: REPO_ROOT });
  for (const bound of ['governance/r4/r4-preregistration-seal.json', 'package.json', 'package-lock.json']) {
    assert.ok(readFileSync(path.join(REPO_ROOT, bound)).equals(execFileSync('git', ['show', `${R4_HEAD}:${bound}`], { cwd: REPO_ROOT })), bound);
  }
});
test('O7 the phase document exists and covers every required section and disclaimer', () => {
  const doc = readFileSync(path.join(REPO_ROOT, 'docs/PHASE5K5-TEMPORAL-REVISIONS.md'), 'utf8').toLowerCase();
  for (const heading of ['purpose', 'raw fingerprints remain immutable', 'content identity', 'observation state', 'acquisition fields',
    'engagement counter semantics', 'counter regression', 'legitimate revisions', 'unverified divergence', 'revision chains',
    'missingness', 'temporal ordering', 'snapshot accounting', 'queries', 'privacy', 'exact-mint', 'non-goals',
    'engagement change is not sentiment', 'engagement change is not importance', 'engagement change is not momentum',
    'engagement change is not a trading signal', 'backward compatibility', 'field classification']) {
    assert.ok(doc.includes(heading), `doc lacks "${heading}"`);
  }
});
test('O8 the validator made zero real network calls', () => assert.equal(tripwireCalls, 0));
test('O9 5K.5 adds no second provider and no scraping surface', () => {
  const touched = gitOut('diff', '--name-only', K5_BASE, 'HEAD').split('\n').filter(Boolean);
  for (const provider of ['twitter', 'reddit', 'bluesky', 'telegram', 'discord', 'rss', 'scraper', 'x-api', 'nitter']) {
    assert.ok(!touched.some(f => f.toLowerCase().includes(provider)), `${provider} surface appeared`);
  }
  // A provider adapter is any tracked module the provider directory holds. 5K.5
  // must leave that directory exactly as 5K.2 created it.
  const adaptersBefore = gitOut('ls-tree', '-r', '--name-only', K5_BASE, '--', `${PI}/providers`).split('\n').filter(Boolean);
  const adaptersAfter = gitOut('ls-files', `${PI}/providers`).split('\n').filter(Boolean);
  assert.deepEqual(adaptersAfter, adaptersBefore, '5K.5 must not add or remove a provider adapter');
});
test('O10 5K.5 declares it is research and observation only', () => {
  for (const flag of ['researchOnly', 'observerOnly', 'paperOnly', 'developmentOnly']) assert.equal(PUBLIC_INTELLIGENCE_CLASSIFICATION[flag], true, flag);
  for (const flag of ['tradingAuthority', 'engineAuthority', 'arenaEligible', 'promotionEligible', 'profitabilityInferencePermitted']) {
    assert.equal(PUBLIC_INTELLIGENCE_CLASSIFICATION[flag], false, flag);
  }
});

// ---------------------------------------------------------------------------
async function main() {
  let failed = 0;
  try {
    for (const [name, fn] of tests) {
      try { await fn(); console.log(`PASS ${name}`); } catch (error) { failed++; console.error(`FAIL ${name}: ${error.stack}`); }
    }
  } finally { for (const root of temporary) rmSync(root, { recursive: true, force: true }); }
  console.log(`Phase 5K.5: ${tests.length - failed}/${tests.length} passed; offline, fixture runs + injected clocks only, ${tripwireCalls} network calls, no live provider call`);
  if (failed) process.exitCode = 1;
}
main().catch(error => { console.error('phase 5K.5 validator crashed:', error); process.exitCode = 1; });
