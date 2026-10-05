#!/usr/bin/env node
// Phase 5K.3 - BOUNDED PUBLIC INTELLIGENCE COLLECTION RUNS validator.
//
// COMPLETELY OFFLINE AND DETERMINISTIC. Every provider response is an in-memory
// fixture handed to the transport through an injected fetch; every clock is an
// injected counter. The global fetch and the socket connect primitive are
// replaced with tripwires and the suite asserts neither was ever called. The
// live collection CLI is never invoked. Run stores live only in temporary
// directories; the repository tree and `.evolve` are never written.
import assert from 'node:assert/strict';
import net from 'node:net';
import {
  chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

let tripwireCalls = 0;
globalThis.fetch = () => { tripwireCalls += 1; throw new Error('TRIPWIRE: validator attempted a real fetch'); };
net.Socket.prototype.connect = function tripwire() { tripwireCalls += 1; throw new Error('TRIPWIRE: validator attempted a socket connect'); };

const DEF = await import('./public-intelligence/definition.mjs');
const PLAN = await import('./public-intelligence/collection-plan.mjs');
const MANIFEST = await import('./public-intelligence/collection-manifest.mjs');
const STORE = await import('./public-intelligence/run-store.mjs');
const RUN = await import('./public-intelligence/collection-run.mjs');
const REPLAY = await import('./public-intelligence/replay.mjs');
const CLI = await import('./public-intelligence/collect.mjs');
const COMMON = await import('./public-intelligence/index.mjs');
const { PUBLIC_INTELLIGENCE_CLASSIFICATION, canonical, digest } = DEF;
const { buildCollectionPlan, validateCollectionPlan, collectionPlanFingerprint } = PLAN;
const { executeCollectionRun } = RUN;
const { verifyRunArtifacts, replayRun } = REPLAY;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R4_HEAD = '1c30264fb87876eeaf229e25c5cdc5adca429b40';
const PI = 'scripts/public-intelligence';
const NEW_MODULES = ['collection-plan', 'collection-manifest', 'run-store', 'collection-run', 'replay', 'collect'].map(name => `${PI}/${name}.mjs`);
const require = createRequire(import.meta.url);
const espree = require('espree');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const temporary = [];
const tempRoot = () => { const root = mkdtempSync(path.join(tmpdir(), 'evolve-5k3-')); temporary.push(root); return root; };
const gitOut = (...args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MINT_2 = 'So11111111111111111111111111111111111111112';
const T0 = 1790000000000;
const HOST = 'fixture.example';
const BOUNDS = Object.freeze({ maxPages: 2, maxRecords: 10, timeoutMs: 5000, maxResponseBytes: 100_000, maxLookbackMs: 3 * 24 * 60 * 60 * 1000 });

const makeClock = (start = T0, step = 10) => { let t = start; return () => { t += step; return t; }; };
const mkPlan = (over = {}) => buildCollectionPlan({
  instance: HOST, hashtag: 'solana', bounds: { ...BOUNDS, ...(over.bounds ?? {}) },
  collectionMode: 'OFFLINE_FIXTURE', createdAt: T0, ...Object.fromEntries(Object.entries(over).filter(([key]) => key !== 'bounds')),
});
const status = (id, over = {}) => ({
  id: String(id), visibility: 'public', created_at: '2026-10-01T10:00:00.000Z',
  url: `https://${HOST}/@alice/${id}`, in_reply_to_id: null, reblog: null, language: 'en',
  content: `<p>post ${id} mint ${MINT}</p>`, tags: [{ name: 'solana' }],
  favourites_count: 1, replies_count: 0, reblogs_count: 0,
  account: { id: '42', acct: 'alice', display_name: 'Alice Real Name', note: '<p>private bio</p>', followers_count: 777 },
  ...over,
});
const json = (body, headers = {}, init = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { status: 200, headers: { 'content-type': 'application/json', ...headers }, ...init });

/** Serves pages[n] for the n-th request, then an empty page. Counts calls. */
function pagedFetch(pages, headers = {}) {
  let calls = 0;
  const impl = async () => { const page = pages[calls] ?? []; calls += 1; return json(page, headers); };
  impl.count = () => calls;
  return impl;
}
const STANDARD_PAGES = () => [
  [status(30), status(29, { content: '<p>love $ALPHA token</p>' }), status(28, { visibility: 'direct' })],
  [status(27, { content: `<p>other ${MINT_2}</p>` }), status(30)],
];

async function standardRun(over = {}) {
  const root = tempRoot();
  const result = await executeCollectionRun(over.plan ?? mkPlan(), {
    clock: over.clock ?? makeClock(), fetchImpl: over.fetchImpl ?? pagedFetch(STANDARD_PAGES()), outputRoot: root,
  });
  return { root, result, dir: result.directory };
}
const file = (dir, name) => path.join(dir, name);
const readLines = target => readFileSync(target, 'utf8').split('\n').filter(Boolean);
function mutateLines(target, fn) {
  const lines = readLines(target).map(line => JSON.parse(line));
  fn(lines);
  writeFileSync(target, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
}
function mutateJson(target, fn) {
  chmodSync(target, 0o644);
  const value = JSON.parse(readFileSync(target, 'utf8'));
  fn(value);
  writeFileSync(target, JSON.stringify(value));
}
const refusal = (fn, fragment) => {
  let thrown = null;
  try { fn(); } catch (error) { thrown = error; }
  assert.ok(thrown, `expected refusal containing ${fragment}`);
  assert.ok(String(thrown.message).includes(fragment), `expected ${fragment}, got ${thrown.message}`);
};
async function refusalAsync(promise, fragment) {
  let thrown = null;
  try { await promise; } catch (error) { thrown = error; }
  assert.ok(thrown && String(thrown.message).includes(fragment), `expected ${fragment}, got ${thrown?.message}`);
}

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
    if (['ImportDeclaration', 'ExportAllDeclaration', 'ExportNamedDeclaration', 'ImportExpression'].includes(node.type) && node.source?.value) {
      found.importSources.push(node.source.value);
    }
    if (node.type === 'MemberExpression' && node.object?.type === 'Identifier') found.memberObjects.push(node.object.name);
    for (const value of Object.values(node)) if (value && typeof value === 'object') walk(value);
  };
  walk(ast);
  return { source, found };
}
const existsFile = candidate => { try { return statSync(candidate).isFile(); } catch { return false; } };
function importClosure(entry) {
  const seen = new Set(); const queue = [entry];
  while (queue.length) {
    const current = queue.shift();
    if (seen.has(current) || !existsFile(path.join(REPO_ROOT, current))) continue;
    seen.add(current);
    for (const source of parseModule(current).found.importSources) {
      if (source.startsWith('.')) queue.push(path.normalize(path.join(path.dirname(current), source)));
    }
  }
  return [...seen].sort();
}
const NETWORK_BUILTINS = ['node:http', 'node:https', 'node:http2', 'node:net', 'node:tls', 'node:dgram', 'node:dns', 'node:child_process',
  'node:worker_threads', 'http', 'https', 'net', 'tls', 'dgram', 'dns', 'child_process'];
const WALLET_MODULES = ['@solana/web3.js', '@solana/spl-token', 'solana', 'tweetnacl', 'ed25519-hd-keypairs', 'bs58'];
const SIGNING_OR_RPC_WRITE = ['sendRawTransaction', 'sendTransaction', 'sendAndConfirmTransaction', 'signTransaction', 'signAllTransactions',
  'partialSign', 'Keypair', 'VersionedTransaction', 'Transaction', 'SystemProgram', 'splToken', 'requestAirdrop', 'confirmTransaction', 'rpc'];
const closureAll = [...new Set(NEW_MODULES.flatMap(importClosure))].sort();

// ===========================================================================
// A. GOVERNANCE
// ===========================================================================
test('A1 plans inherit the frozen research/observer-only classification', () => {
  const plan = mkPlan();
  assert.equal(canonical(plan.classification), canonical(PUBLIC_INTELLIGENCE_CLASSIFICATION));
  assert.equal(plan.classification.researchOnly, true);
  assert.equal(plan.classification.observerOnly, true);
});
test('A2 every authority flag is false in plan, manifest and stored raw evidence', async () => {
  const { result, dir } = await standardRun();
  const carriers = [mkPlan().classification, result.manifest.classification, JSON.parse(readLines(file(dir, 'raw-evidence.ndjson'))[0]).classification];
  for (const classification of carriers) {
    for (const flag of ['tradingAuthority', 'engineAuthority', 'arenaEligible', 'promotionEligible', 'profitabilityInferencePermitted']) {
      assert.equal(classification[flag], false, flag);
    }
  }
});
test('A3 a plan cannot override the classification', () => {
  for (const patch of [{ tradingAuthority: true }, { researchOnly: false }, { observerOnly: false }, { profitabilityInferencePermitted: true },
    { engineAuthority: true }, { arenaEligible: true }, { promotionEligible: true }]) {
    const plan = { ...mkPlan(), classification: { ...PUBLIC_INTELLIGENCE_CLASSIFICATION, ...patch } };
    refusal(() => validateCollectionPlan(plan), 'CLASSIFICATION_OVERRIDE_REFUSED');
  }
  // buildCollectionPlan has no classification parameter: a smuggled one is ignored.
  const smuggled = buildCollectionPlan({ instance: HOST, hashtag: 'solana', bounds: BOUNDS, collectionMode: 'OFFLINE_FIXTURE', createdAt: T0,
    classification: { ...PUBLIC_INTELLIGENCE_CLASSIFICATION, tradingAuthority: true } });
  assert.equal(smuggled.classification.tradingAuthority, false);
});
test('A4 a manifest cannot override the classification', async () => {
  const { result } = await standardRun();
  const forged = { ...result.manifest, classification: { ...result.manifest.classification, tradingAuthority: true } };
  refusal(() => MANIFEST.validateManifestShape(forged), 'CLASSIFICATION_OVERRIDE_REFUSED');
});
test('A5 manifests carry no sentiment, score, ranking, signal or profit field', async () => {
  const { result } = await standardRun();
  const keys = JSON.stringify(Object.keys(result.manifest)).toLowerCase();
  for (const word of ['sentiment', 'score', 'rank', 'signal', 'profit', 'alpha', 'recommend', 'prediction', 'confidence']) {
    assert.ok(!keys.includes(word), word);
  }
});

// ===========================================================================
// B. PLAN SCHEMA
// ===========================================================================
test('B1 a valid plan is accepted and deep-frozen', () => {
  const plan = mkPlan();
  assert.equal(plan.provider, 'mastodon');
  assert.deepEqual({ ...plan.query }, { type: 'HASHTAG', value: 'solana' });
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.bounds));
});
test('B2 unknown or missing keys are rejected at every level', () => {
  const base = mkPlan();
  refusal(() => validateCollectionPlan({ ...base, extra: 1 }), 'UNKNOWN_FIELD:extra');
  refusal(() => validateCollectionPlan({ ...base, query: { ...base.query, extra: 1 } }), 'UNKNOWN_FIELD:extra');
  refusal(() => validateCollectionPlan({ ...base, bounds: { ...base.bounds, maxRetries: 3 } }), 'UNKNOWN_FIELD:maxRetries');
  const missing = { ...base }; delete missing.createdAt;
  refusal(() => validateCollectionPlan(missing), 'FIELD_MISSING:createdAt');
  refusal(() => validateCollectionPlan({ ...base, bounds: { maxPages: 1 } }), 'FIELD_MISSING');
});
test('B3 only GOVERNED providers are accepted (no unregistered provider is added)', () => {
  // 5K.3 originally shipped with exactly one provider, `mastodon`, and this
  // test asserted that literal. Phase 5K.6 adds a SECOND provider, which makes
  // that literal false for all time and would make every future provider phase a
  // regression. The assertion is therefore SCOPED to its stated intent - "no
  // other provider is added" - and expressed as a property of the governed
  // registry rather than a hardcoded one-provider list. Mastodon stays in the
  // registry, so no Mastodon validation is weakened, and the registry itself is
  // still asserted to be small, sorted, duplicate-free and lower-case.
  for (const provider of ['x', 'twitter', 'reddit', 'telegram', 'discord', 'rss', 'Mastodon', '', null]) {
    refusal(() => validateCollectionPlan({ ...mkPlan(), provider }), 'PROVIDER_INVALID');
  }
  assert.ok(PLAN.PUBLIC_INTELLIGENCE_5K3_PROVIDERS.includes('mastodon'), 'mastodon must remain governed');
  const registry = [...PLAN.PUBLIC_INTELLIGENCE_5K3_PROVIDERS];
  assert.equal(registry.length, new Set(registry).size, 'the registry has no duplicates');
  assert.deepEqual(registry, [...registry].sort(), 'the registry is sorted');
  for (const provider of registry) {
    assert.equal(provider, provider.toLowerCase(), `${provider} is not canonical`);
    // Each governed provider is accepted with a plan that satisfies ITS OWN
    // governed query type and instance, so this cannot pass by accident.
    const governed = PLAN.PUBLIC_INTELLIGENCE_5K3_PROVIDER_DEFAULTS[provider];
    assert.ok(governed, `${provider} has no governed defaults`);
    const built = PLAN.buildCollectionPlan({
      provider,
      instance: governed.instance ?? HOST,
      ...(governed.queryType === 'HASHTAG' ? { hashtag: 'solana' } : { term: 'solana' }),
      bounds: BOUNDS, collectionMode: 'OFFLINE_FIXTURE', createdAt: T0,
    });
    assert.equal(built.provider, provider);
    assert.equal(built.query.type, governed.queryType);
  }
});
test('B4 invalid query types and values are rejected', () => {
  for (const type of ['URL', 'USER', 'SEARCH', 'hashtag', '']) refusal(() => validateCollectionPlan({ ...mkPlan(), query: { type, value: 'solana' } }), 'QUERY_TYPE_INVALID');
  for (const value of ['', 'a b', '#solana', 'a/b', '../x', 'https://x.example/tag', 'a?b=1', 'x'.repeat(65), 7]) {
    refusal(() => validateCollectionPlan({ ...mkPlan(), query: { type: 'HASHTAG', value } }), 'QUERY_VALUE_INVALID');
  }
});
test('B5 arbitrary URLs, endpoints, ports and IP hosts are rejected', () => {
  const base = mkPlan();
  refusal(() => validateCollectionPlan({ ...base, url: 'https://evil.example/x' }), 'UNKNOWN_FIELD:url');
  refusal(() => validateCollectionPlan({ ...base, endpoint: '/api/v1/accounts' }), 'UNKNOWN_FIELD:endpoint');
  for (const instance of ['https://fixture.example', 'fixture.example/api', 'fixture.example:8080', '127.0.0.1', 'localhost', 'a.internal',
    'user@fixture.example', 'Fixture.Example', '']) {
    refusal(() => validateCollectionPlan({ ...base, instance }), 'INSTANCE_');
  }
});
test('B6 every bound ceiling is enforced exactly, and the ceilings equal the 5K.2 hard ceilings', () => {
  assert.deepEqual({ ...PLAN.PUBLIC_INTELLIGENCE_5K3_BOUND_CEILINGS },
    { maxPages: 5, maxRecords: 200, timeoutMs: 20000, maxResponseBytes: 2097152, maxLookbackMs: 604_800_000 });
  for (const [key, ceiling] of Object.entries(PLAN.PUBLIC_INTELLIGENCE_5K3_BOUND_CEILINGS)) {
    assert.equal(mkPlan({ bounds: { [key]: ceiling } }).bounds[key], ceiling);
    refusal(() => mkPlan({ bounds: { [key]: ceiling + 1 } }), `BOUND_EXCEEDS_CEILING:${key}`);
  }
});
test('B7 zero, negative, fractional, non-finite and non-numeric bounds are rejected', () => {
  for (const key of Object.keys(BOUNDS)) {
    for (const value of [0, -1, 1.5, Infinity, -Infinity, NaN, '5', null, undefined, true]) {
      refusal(() => mkPlan({ bounds: { [key]: value } }), `BOUND_INVALID:${key}`);
    }
  }
});
test('B8 the plan fingerprint is deterministic and independent of key order', () => {
  const a = mkPlan(); const b = mkPlan();
  assert.equal(collectionPlanFingerprint(a), collectionPlanFingerprint(b));
  assert.match(collectionPlanFingerprint(a), /^[0-9a-f]{64}$/);
  const reordered = Object.fromEntries(Object.entries(a).reverse());
  assert.equal(collectionPlanFingerprint(reordered), collectionPlanFingerprint(a));
});
test('B9 changing provider-relevant fields, query, any bound, mode or time changes the fingerprint', () => {
  const base = collectionPlanFingerprint(mkPlan());
  const variants = [
    mkPlan({ instance: 'other.example' }), mkPlan({ hashtag: 'bitcoin' }), mkPlan({ collectionMode: 'LIVE_PUBLIC_PROVIDER' }), mkPlan({ createdAt: T0 + 1 }),
    ...Object.keys(BOUNDS).map(key => mkPlan({ bounds: { [key]: BOUNDS[key] - 1 } })),
  ];
  const seen = new Set([base]);
  for (const variant of variants) seen.add(collectionPlanFingerprint(variant));
  assert.equal(seen.size, variants.length + 1);
  const plan = mkPlan();
  refusal(() => collectionPlanFingerprint({ ...plan, provider: 'reddit' }), 'PROVIDER_INVALID');
  refusal(() => collectionPlanFingerprint({ ...plan, classification: { ...plan.classification, tradingAuthority: true } }), 'CLASSIFICATION_OVERRIDE');
});

// ===========================================================================
// C. RUN IDENTITY
// ===========================================================================
test('C1 the manifest schema is closed: extra, missing and mistyped fields fail', async () => {
  const { result } = await standardRun();
  const m = JSON.parse(JSON.stringify(result.manifest));
  assert.doesNotThrow(() => MANIFEST.validateManifestShape(m));
  refusal(() => MANIFEST.validateManifestShape({ ...m, extra: 1 }), 'UNKNOWN_FIELD:extra');
  const noRun = { ...m }; delete noRun.runId;
  refusal(() => MANIFEST.validateManifestShape(noRun), 'FIELD_MISSING:runId');
  refusal(() => MANIFEST.validateManifestShape({ ...m, requestCount: -1 }), 'COUNT_INVALID');
  refusal(() => MANIFEST.validateManifestShape({ ...m, status: 'DONE' }), 'STATUS_INVALID');
  refusal(() => MANIFEST.validateManifestShape({ ...m, failureCounts: { MADE_UP: 1 } }), 'FAILURE_COUNTS_INVALID');
  refusal(() => MANIFEST.validateManifestShape({ ...m, providerCursorSummary: { ...m.providerCursorSummary, extra: 1 } }), 'UNKNOWN_FIELD:extra');
});
test('C2 run id is deterministic from (plan fingerprint, startedAt) and nothing else', () => {
  const fp = collectionPlanFingerprint(mkPlan());
  assert.equal(MANIFEST.deriveRunId(fp, T0), MANIFEST.deriveRunId(fp, T0));
  assert.match(MANIFEST.deriveRunId(fp, T0), /^run-[0-9a-f]{32}$/);
  assert.notEqual(MANIFEST.deriveRunId(fp, T0), MANIFEST.deriveRunId(fp, T0 + 1));
  assert.notEqual(MANIFEST.deriveRunId(fp, T0), MANIFEST.deriveRunId(collectionPlanFingerprint(mkPlan({ hashtag: 'other' })), T0));
  refusal(() => MANIFEST.deriveRunId('nope', T0), 'PLAN_FINGERPRINT_INVALID');
  refusal(() => MANIFEST.deriveRunId(fp, 1.5), 'STARTED_AT_INVALID');
  const { source } = parseModule(`${PI}/collection-manifest.mjs`);
  assert.ok(!/Math\.random|randomUUID|randomBytes/.test(source), 'run identity must not be random');
});
test('C3 scientific results never enter run identity: same plan+start, different results, same run id', async () => {
  const a = await standardRun();
  const b = await standardRun({ fetchImpl: pagedFetch([[status(5)], []]) });
  assert.equal(a.result.runId, b.result.runId);
  assert.notEqual(a.result.manifest.manifestFingerprint, b.result.manifest.manifestFingerprint);
});
test('C4 manifests are byte-deterministic for deterministic inputs', async () => {
  const a = await standardRun(); const b = await standardRun();
  assert.equal(canonical(a.result.manifest), canonical(b.result.manifest));
  assert.equal(readFileSync(file(a.dir, 'manifest.json'), 'utf8'), readFileSync(file(b.dir, 'manifest.json'), 'utf8'));
  assert.equal(readFileSync(file(a.dir, 'raw-evidence.ndjson'), 'utf8'), readFileSync(file(b.dir, 'raw-evidence.ndjson'), 'utf8'));
});
test('C5 the manifest fingerprint authenticates contents: any edit changes it', async () => {
  const { result } = await standardRun();
  const m = result.manifest;
  assert.equal(m.manifestFingerprint, MANIFEST.manifestFingerprintOf(m));
  for (const patch of [{ recordsIngested: m.recordsIngested + 1 }, { status: 'COMPLETED' === m.status ? 'PARTIAL' : 'COMPLETED' }, { completedAt: m.completedAt + 1 },
    { requestsFingerprint: '0'.repeat(64) }]) {
    assert.notEqual(MANIFEST.manifestFingerprintOf({ ...m, ...patch }), m.manifestFingerprint);
  }
});
test('C6 re-running the same execution identity is REFUSED and overwrites nothing', async () => {
  const first = await standardRun();
  const before = readFileSync(file(first.dir, 'manifest.json'), 'utf8');
  const second = await executeCollectionRun(mkPlan(), { clock: makeClock(), fetchImpl: pagedFetch(STANDARD_PAGES()), outputRoot: first.root });
  assert.equal(second.status, 'REFUSED');
  assert.equal(second.reason, 'RUN_ALREADY_EXISTS');
  assert.equal(second.manifest, null);
  assert.equal(readFileSync(file(first.dir, 'manifest.json'), 'utf8'), before);
});
test('C7 a run requires an injected clock; no lower module consumes a wall clock', async () => {
  await refusalAsync(executeCollectionRun(mkPlan(), { fetchImpl: pagedFetch([]), outputRoot: tempRoot() }), 'CLOCK_REQUIRED');
  for (const unit of NEW_MODULES.filter(entry => !entry.endsWith('collect.mjs'))) {
    const { found } = parseModule(unit);
    assert.ok(!found.identifiers.includes('Date'), `${unit} references Date`);
    assert.ok(!found.identifiers.includes('setTimeout'), `${unit} uses timers`);
  }
  assert.ok(parseModule(`${PI}/collect.mjs`).found.identifiers.includes('Date'));
});

// ===========================================================================
// D. ACCOUNTING
// ===========================================================================
test('D1 a real mixed run satisfies every accounting invariant with exact counts', async () => {
  const { result } = await standardRun();
  const m = result.manifest;
  assert.deepEqual({ seen: m.providerRecordsSeen, mapped: m.recordsMapped, ingested: m.recordsIngested, dup: m.duplicates,
    conflicts: m.conflicts, refused: m.refused, raw: m.rawEvidenceRecordsWritten, norm: m.normalizedRecordsWritten },
  { seen: 5, mapped: 4, ingested: 3, dup: 1, conflicts: 0, refused: 1, raw: 3, norm: 3 });
  assert.equal(m.providerRecordsSeen, m.recordsMapped + m.refused);
  assert.equal(m.recordsMapped, m.recordsIngested + m.duplicates + m.conflicts + m.ingestFailures);
  assert.deepEqual({ ...m.refusedReasons }, { NON_PUBLIC_VISIBILITY: 1 });
  assert.equal(m.status, 'COMPLETED');
  assert.deepEqual(MANIFEST.checkAccounting(m, JSON.parse(JSON.stringify((await loadRequests(result)))), mkPlan()), []);
});
async function loadRequests(result) { return readLines(file(result.directory, 'requests.ndjson')).map(line => JSON.parse(line)); }
const driftCodes = async patch => {
  const { result } = await standardRun();
  const requests = await loadRequests(result);
  return MANIFEST.checkAccounting({ ...JSON.parse(JSON.stringify(result.manifest)), ...patch }, requests, mkPlan());
};
test('D2 seen/mapped/refused inconsistencies fail', async () => {
  assert.ok((await driftCodes({ providerRecordsSeen: 6 })).includes('ACCOUNTING_SEEN_NE_MAPPED_PLUS_REFUSED'));
  assert.ok((await driftCodes({ recordsMapped: 5 })).includes('ACCOUNTING_SEEN_NE_MAPPED_PLUS_REFUSED'));
  assert.ok((await driftCodes({ providerRecordsSeen: 50, recordsMapped: 49 })).includes('ACCOUNTING_SEEN_EXCEEDS_RETURNED'));
});
test('D3 mapped/ingested/duplicate inconsistencies fail', async () => {
  assert.ok((await driftCodes({ recordsIngested: 4 })).includes('ACCOUNTING_MAPPED_NE_OUTCOMES'));
  assert.ok((await driftCodes({ duplicates: 0 })).includes('ACCOUNTING_MAPPED_NE_OUTCOMES'));
  assert.ok((await driftCodes({ duplicates: 2 })).includes('ACCOUNTING_MAPPED_NE_OUTCOMES'));
});
test('D4 refused count drift fails', async () => {
  assert.ok((await driftCodes({ refused: 0 })).includes('ACCOUNTING_MAPPING_REFUSED_COUNT_DRIFT'));
  assert.ok((await driftCodes({ refusedReasons: { NON_PUBLIC_VISIBILITY: 2 } })).includes('ACCOUNTING_REFUSED_REASONS_DRIFT'));
});
test('D5 request/page count drift fails', async () => {
  assert.ok((await driftCodes({ requestCount: 3 })).includes('ACCOUNTING_REQUEST_COUNT_NE_RECORDS'));
  assert.ok((await driftCodes({ pageCount: 1 })).includes('ACCOUNTING_PAGE_COUNT_NE_OK_REQUESTS'));
});
test('D6 raw/normalized write counts must equal ingested', async () => {
  assert.ok((await driftCodes({ rawEvidenceRecordsWritten: 2 })).includes('ACCOUNTING_RAW_WRITTEN_NE_INGESTED'));
  assert.ok((await driftCodes({ normalizedRecordsWritten: 4 })).includes('ACCOUNTING_NORMALIZED_WRITTEN_NE_INGESTED'));
});
test('D7 conflict and integrity counters must agree with failureCounts', async () => {
  assert.ok((await driftCodes({ conflicts: 1, recordsMapped: 4, duplicates: 0 })).includes('ACCOUNTING_CONFLICT_COUNT_DRIFT'));
  assert.ok((await driftCodes({ ingestFailures: 1, duplicates: 0 })).includes('ACCOUNTING_INTEGRITY_COUNT_DRIFT'));
});
test('D8 a kinder terminal status than the counts support is rejected', async () => {
  const codes = await driftCodes({ status: 'COMPLETED', conflicts: 1, duplicates: 0, failureCounts: { INGEST_CONFLICT: 1, MAPPING_REFUSED: 1 } });
  assert.ok(codes.some(code => code.startsWith('STATUS_INCONSISTENT')));
  assert.ok((await driftCodes({ status: 'PARTIAL' })).some(code => code.startsWith('STATUS_INCONSISTENT')));
});
test('D9 bounds are part of accounting: records and requests may not exceed the plan', async () => {
  const { result } = await standardRun();
  const requests = await loadRequests(result);
  const tight = mkPlan({ bounds: { maxPages: 1, maxRecords: 2 } });
  const codes = MANIFEST.checkAccounting(JSON.parse(JSON.stringify(result.manifest)), requests, tight);
  assert.ok(codes.includes('ACCOUNTING_REQUESTS_EXCEED_PLAN_MAX_PAGES'));
  assert.ok(codes.includes('ACCOUNTING_SEEN_EXCEEDS_PLAN_MAX_RECORDS'));
});
test('D10 an inconsistent manifest cannot even be built', () => {
  const requests = [];
  const counts = { providerRecordsSeen: 3, recordsMapped: 1, recordsIngested: 1, duplicates: 0, conflicts: 0, refused: 0, ingestFailures: 0,
    rawEvidenceRecordsWritten: 1, normalizedRecordsWritten: 1 };
  refusal(() => MANIFEST.buildRunManifest({ plan: mkPlan(), startedAt: T0, completedAt: T0 + 1, status: 'COMPLETED', requests, counts,
    failureCounts: {}, refusedReasons: {}, stopReason: 'END_OF_TIMELINE', rawEvidenceFingerprint: digest([]), observationsFingerprint: digest([]) }),
  'ACCOUNTING_INCONSISTENT');
});

// ===========================================================================
// E. REQUESTS
// ===========================================================================
test('E1 request records are ordered, contiguous and time-monotone', async () => {
  const { result } = await standardRun();
  const requests = await loadRequests(result);
  assert.deepEqual(requests.map(request => request.requestIndex), [0, 1]);
  assert.equal(requests[0].cursor, null);
  assert.equal(requests[1].cursor, '28');
  assert.ok(requests[0].completedAt <= requests[1].requestedAt);
  assert.deepEqual(requests.map(request => request.recordsReturned), [3, 2]);
  assert.ok(requests.every(request => request.outcome === 'OK' && request.httpStatus === 200 && request.responseBytes > 0));
  assert.equal(result.manifest.requestsFingerprint, MANIFEST.requestsFingerprint(requests));
});
test('E2 a duplicate request index fails verification', async () => {
  const { dir } = await standardRun();
  mutateLines(file(dir, 'requests.ndjson'), lines => { lines[1].requestIndex = 0; });
  assert.ok(replayRun(dir).failures.includes('REQUEST_SEQUENCE_GAP_OR_DUPLICATE'));
});
test('E3 a missing request record fails verification', async () => {
  const { dir } = await standardRun();
  mutateLines(file(dir, 'requests.ndjson'), lines => { lines.pop(); });
  const failures = replayRun(dir).failures;
  assert.ok(failures.includes('REQUEST_COUNT_MISMATCH') && failures.includes('REQUESTS_FINGERPRINT_MISMATCH'));
});
test('E4 the response-byte ceiling is enforced in the transport and in verification', async () => {
  const root = tempRoot();
  const result = await executeCollectionRun(mkPlan({ bounds: { maxResponseBytes: 300 } }), { clock: makeClock(), fetchImpl: pagedFetch(STANDARD_PAGES()), outputRoot: root });
  assert.equal(result.status, 'PROVIDER_ERROR');
  assert.deepEqual({ ...result.manifest.failureCounts }, { OVERSIZED_RESPONSE: 1 });
  const { dir } = await standardRun();
  mutateLines(file(dir, 'requests.ndjson'), lines => { lines[0].responseBytes = 100_001; });
  assert.ok(replayRun(dir).failures.some(code => code.startsWith('REQUEST_INVALID')));
});
test('E5 rate-limit metadata is structural only and whitelisted to four fields', async () => {
  const record = MANIFEST.buildRequestRecord(mkPlan(), {
    requestIndex: 0, requestedAt: T0, completedAt: T0 + 1, cursor: null, outcome: 'OK', httpStatus: 200, recordsReturned: 1, responseBytes: 10,
    rateLimit: { retryAfterSeconds: 5, rateLimitLimit: 300, rateLimitRemaining: 299, rateLimitReset: '2026-10-01T12:05:00.000Z', setCookie: 'S3CRET', authorization: 'Bearer S3CRET' },
    nextCursor: null,
  });
  assert.deepEqual(Object.keys(record.rateLimit).sort(), ['rateLimitLimit', 'rateLimitRemaining', 'rateLimitReset', 'retryAfterSeconds']);
  assert.ok(!JSON.stringify(record).includes('S3CRET'));
  refusal(() => MANIFEST.validateRequestRecord({ ...record, rateLimit: { ...record.rateLimit, cookie: 'x' } }), 'UNKNOWN_FIELD:cookie');
  refusal(() => MANIFEST.validateRequestRecord({ ...record, headers: { a: 'b' } }), 'UNKNOWN_FIELD:headers');
  assert.equal(MANIFEST.PUBLIC_INTELLIGENCE_5K3_REQUEST_SCHEMA.persistsHeaders, false);
  assert.equal(MANIFEST.PUBLIC_INTELLIGENCE_5K3_REQUEST_SCHEMA.persistsBody, false);
});
test('E6 secrets in response headers and bodies never reach any run file', async () => {
  const fetchImpl = pagedFetch([[status(9, { access_token: 'TOKENVALUE-123', content: '<p>Bearer abcdefghijklmnop1234567890</p>' }), status(8)], []],
    { 'set-cookie': 'sid=COOKIEVALUE-456; HttpOnly', authorization: 'Bearer HEADERVALUE-789', 'x-ratelimit-remaining': '290' });
  const { dir, result } = await standardRun({ fetchImpl });
  assert.equal(result.manifest.refused, 1);
  for (const name of readdirSync(dir)) {
    const text = readFileSync(file(dir, name), 'utf8');
    for (const secret of ['TOKENVALUE-123', 'COOKIEVALUE-456', 'HEADERVALUE-789', 'abcdefghijklmnop1234567890']) assert.ok(!text.includes(secret), `${name} leaks ${secret}`);
  }
  assert.equal((await loadRequests(result))[0].rateLimit.rateLimitRemaining, 290);
});

// ===========================================================================
// F. PERSISTENCE
// ===========================================================================
test('F1 safe runtime roots are accepted (temp area and the gitignored default)', () => {
  assert.ok(STORE.assertSafeRuntimeRoot(tempRoot()));
  assert.ok(STORE.assertSafeRuntimeRoot(STORE.PUBLIC_INTELLIGENCE_5K3_DEFAULT_RUNTIME_ROOT));
  assert.equal(STORE.PUBLIC_INTELLIGENCE_5K3_DEFAULT_RUNTIME_ROOT, path.join(REPO_ROOT, 'var', 'public-intelligence'));
});
test('F2 any root under .evolve is rejected', () => {
  refusal(() => STORE.assertSafeRuntimeRoot(path.join(REPO_ROOT, '.evolve', 'public-intelligence')), 'FORBIDDEN');
  refusal(() => STORE.assertSafeRuntimeRoot(path.join(tempRoot(), '.evolve', 'x')), 'FORBIDDEN');
});
test('F3 traversal, relative and outside-area roots are rejected', () => {
  refusal(() => STORE.assertSafeRuntimeRoot(`${tempRoot()}/../../etc`), 'TRAVERSAL_REFUSED');
  refusal(() => STORE.assertSafeRuntimeRoot('relative/dir'), 'MUST_BE_ABSOLUTE');
  refusal(() => STORE.assertSafeRuntimeRoot(''), 'REQUIRED');
  refusal(() => STORE.assertSafeRuntimeRoot('/etc/evolve-runs'), 'OUTSIDE_ALLOWED_AREAS');
  refusal(() => STORE.assertSafeRuntimeRoot(path.join(REPO_ROOT, 'scripts')), 'OUTSIDE_ALLOWED_AREAS');
  refusal(() => STORE.assertSafeRuntimeRoot(REPO_ROOT), 'OUTSIDE_ALLOWED_AREAS');
});
test('F4 a symlink cannot smuggle a root out of the allowed areas', () => {
  const root = tempRoot();
  symlinkSync('/usr', path.join(root, 'escape'));
  refusal(() => STORE.assertSafeRuntimeRoot(path.join(root, 'escape', 'runs')), 'OUTSIDE_ALLOWED_AREAS');
});
test('F5 the run directory has the documented layout', async () => {
  const { dir, root } = await standardRun();
  assert.equal(path.dirname(dir), path.join(root, 'runs'));
  assert.deepEqual(readdirSync(dir).sort(), ['manifest.json', 'observations.ndjson', 'plan.json', 'raw-evidence.ndjson', 'requests.ndjson']);
});
test('F6 the finalized manifest is write-once, atomic and read-only', async () => {
  const { dir, result } = await standardRun();
  const target = file(dir, 'manifest.json');
  const before = readFileSync(target, 'utf8');
  refusal(() => STORE.writeManifestOnce(dir, { ...result.manifest, status: 'COMPLETED' }), 'ALREADY_FINALIZED');
  assert.equal(readFileSync(target, 'utf8'), before);
  assert.equal(statSync(target).mode & 0o222, 0, 'manifest must be read-only');
  assert.equal(readdirSync(dir).filter(name => name.startsWith('.manifest')).length, 0, 'no temp file left behind');
  if (process.getuid?.() !== 0) assert.throws(() => writeFileSync(target, 'tamper'));
});
test('F7 plan.json is write-once and read-only', async () => {
  const { dir } = await standardRun();
  refusal(() => STORE.writePlanOnce(dir, mkPlan()), 'EEXIST');
  assert.equal(statSync(file(dir, 'plan.json')).mode & 0o222, 0);
});
test('F8 stored raw evidence round-trips byte-for-byte to what was ingested', async () => {
  const { dir } = await standardRun();
  const raws = readLines(file(dir, 'raw-evidence.ndjson')).map(line => JSON.parse(line));
  assert.equal(raws.length, 3);
  assert.deepEqual(raws.map(raw => raw.providerObservationId), ['30', '29', '27']);
  const text = readFileSync(file(dir, 'raw-evidence.ndjson'), 'utf8');
  assert.equal(text, raws.map(raw => `${canonical(raw)}\n`).join(''), 'stored bytes are the canonical serialization');
  assert.equal(raws[0].claimedMint, MINT);
  assert.equal(raws[1].claimedMint, null);
  assert.equal(raws[0].collectionContext.collectionRunId, readdirSync(path.dirname(dir))[0]);
});
test('F9 stored observations round-trip: envelope.raw equals the raw stream, in order', async () => {
  const { dir } = await standardRun();
  const raws = readLines(file(dir, 'raw-evidence.ndjson')).map(line => JSON.parse(line));
  const envelopes = readLines(file(dir, 'observations.ndjson')).map(line => JSON.parse(line));
  assert.equal(envelopes.length, raws.length);
  envelopes.forEach((envelope, index) => assert.equal(canonical(envelope.raw), canonical(raws[index])));
  assert.equal(envelopes[1].normalized.assetAssociation.status, 'UNASSOCIATED');
});
test('F10 no runtime artifact is tracked by Git and var/ is ignored', () => {
  assert.equal(gitOut('ls-files', 'var').trim(), '');
  execFileSync('git', ['check-ignore', '-q', 'var/public-intelligence/runs/run-x/manifest.json'], { cwd: REPO_ROOT });
  assert.ok(!existsSync(path.join(REPO_ROOT, 'var')), 'validator must not create var/');
});
test('F11 an unfinalized run directory is reported, never promoted to COMPLETED', async () => {
  const { dir } = await standardRun();
  rmSync(file(dir, 'manifest.json'), { force: true });
  assert.deepEqual([...replayRun(dir).failures], ['MANIFEST_MISSING_UNFINALIZED_RUN']);
});

// ===========================================================================
// G. REPLAY AND TAMPER DETECTION
// ===========================================================================
test('G1 replay makes zero network calls and imports no transport', async () => {
  const { dir } = await standardRun();
  const before = tripwireCalls;
  assert.equal(replayRun(dir).ok, true);
  assert.equal(tripwireCalls, before);
  const closure = importClosure(`${PI}/replay.mjs`);
  assert.ok(!closure.some(entry => /transport|mastodon\.mjs|mastodon-mapper|collection-run|collect\.mjs/.test(entry)), closure.join(','));
  for (const entry of closure) {
    const { found } = parseModule(entry);
    assert.ok(!found.identifiers.includes('fetch'), `${entry} references fetch`);
    for (const source of found.importSources) assert.ok(!NETWORK_BUILTINS.includes(source));
  }
});
test('G2 replay is deterministic and a clean run verifies', async () => {
  const { dir } = await standardRun();
  const a = replayRun(dir); const b = replayRun(dir);
  assert.deepEqual([...a.failures], []);
  assert.equal(canonical(a), canonical(b));
  assert.doesNotThrow(() => REPLAY.assertRunVerified(dir));
});
test('G3 a tampered raw observation invalidates the run', async () => {
  const { dir } = await standardRun();
  const target = file(dir, 'raw-evidence.ndjson');
  writeFileSync(target, readFileSync(target, 'utf8').replace('post 30', 'post 3X'));
  const failures = replayRun(dir).failures;
  assert.ok(failures.includes('RAW_EVIDENCE_FINGERPRINT_MISMATCH'));
  assert.ok(failures.includes('OBSERVATION_RAW_DIFFERS_FROM_RAW_STREAM'));
});
test('G4 a tampered provenance block invalidates the run', async () => {
  const { dir } = await standardRun();
  mutateLines(file(dir, 'observations.ndjson'), lines => { lines[0].normalized.provenance.rawTextFingerprint = 'f'.repeat(64); });
  assert.ok(replayRun(dir).failures.some(code => code.startsWith('PROVENANCE')));
});
test('G5 a tampered normalized record invalidates the run', async () => {
  const { dir } = await standardRun();
  mutateLines(file(dir, 'observations.ndjson'), lines => { lines[1].normalized.canonicalText = 'forged text'; });
  assert.ok(replayRun(dir).failures.includes('NORMALIZED_FINGERPRINT_MISMATCH'));
});
test('G6 a tampered dedup identity or envelope fingerprint invalidates the run', async () => {
  const a = await standardRun();
  mutateLines(file(a.dir, 'observations.ndjson'), lines => { lines[0].dedupIdentity = 'forged'; });
  assert.ok(replayRun(a.dir).failures.includes('DEDUP_IDENTITY_MISMATCH'));
  const b = await standardRun();
  mutateLines(file(b.dir, 'observations.ndjson'), lines => { lines[0].rawObservationFingerprint = '0'.repeat(64); });
  assert.ok(replayRun(b.dir).failures.includes('ENVELOPE_RAW_FINGERPRINT_MISMATCH'));
});
test('G7 a missing raw or observation record invalidates the run', async () => {
  const a = await standardRun();
  mutateLines(file(a.dir, 'raw-evidence.ndjson'), lines => { lines.pop(); });
  assert.ok(replayRun(a.dir).failures.includes('RAW_COUNT_MISMATCH'));
  const b = await standardRun();
  mutateLines(file(b.dir, 'observations.ndjson'), lines => { lines.shift(); });
  assert.ok(replayRun(b.dir).failures.includes('OBSERVATION_COUNT_MISMATCH'));
});
test('G8 an injected extra record invalidates the run', async () => {
  const { dir } = await standardRun();
  const lines = readLines(file(dir, 'raw-evidence.ndjson'));
  writeFileSync(file(dir, 'raw-evidence.ndjson'), [...lines, lines[0]].join('\n') + '\n');
  assert.ok(replayRun(dir).failures.includes('RAW_COUNT_MISMATCH'));
});
test('G9 a count edited in the manifest is caught, even when the manifest is re-signed', async () => {
  const a = await standardRun();
  mutateJson(file(a.dir, 'manifest.json'), manifest => { manifest.recordsIngested += 1; });
  assert.ok(replayRun(a.dir).failures.includes('MANIFEST_FINGERPRINT_MISMATCH'));
  const b = await standardRun();
  mutateJson(file(b.dir, 'manifest.json'), manifest => {
    manifest.duplicates += 1;
    manifest.manifestFingerprint = MANIFEST.manifestFingerprintOf(manifest);
  });
  const failures = replayRun(b.dir).failures;
  assert.ok(!failures.includes('MANIFEST_FINGERPRINT_MISMATCH'));
  assert.ok(failures.includes('ACCOUNTING_MAPPED_NE_OUTCOMES'));
});
test('G10 a downgraded terminal status is caught, even when re-signed', async () => {
  const { dir } = await standardRun({ fetchImpl: pagedFetch([[status(1)], [status(1, { content: '<p>changed</p>' })]]) });
  assert.equal(JSON.parse(readFileSync(file(dir, 'manifest.json'), 'utf8')).status, 'PARTIAL');
  mutateJson(file(dir, 'manifest.json'), manifest => { manifest.status = 'COMPLETED'; manifest.manifestFingerprint = MANIFEST.manifestFingerprintOf(manifest); });
  assert.ok(replayRun(dir).failures.some(code => code.startsWith('STATUS_INCONSISTENT')));
});
test('G11 a tampered plan or run id invalidates the run', async () => {
  const a = await standardRun();
  mutateJson(file(a.dir, 'plan.json'), plan => { plan.bounds.maxRecords = 11; });
  assert.ok(replayRun(a.dir).failures.includes('PLAN_FINGERPRINT_MISMATCH'));
  const b = await standardRun();
  mutateJson(file(b.dir, 'manifest.json'), manifest => { manifest.startedAt += 1; manifest.manifestFingerprint = MANIFEST.manifestFingerprintOf(manifest); });
  assert.ok(replayRun(b.dir).failures.includes('RUN_ID_MISMATCH'));
});
test('G12 malformed artifact files are reported, never guessed at', async () => {
  const { dir } = await standardRun();
  writeFileSync(file(dir, 'raw-evidence.ndjson'), '{not json\n');
  assert.ok(replayRun(dir).failures.includes('LOAD_MALFORMED:raw'));
});
test('G13 replay re-derives every stored record from raw evidence alone', async () => {
  const { dir } = await standardRun();
  const artifacts = JSON.parse(JSON.stringify(STORE.loadRunArtifacts(dir)));
  assert.equal(verifyRunArtifacts(artifacts).ok, true);
  artifacts.observations = artifacts.observations.slice(0, 2);
  assert.equal(verifyRunArtifacts(artifacts).ok, false);
});

// ===========================================================================
// H. FAILURE STATES
// ===========================================================================
const failingRun = (impl, bounds = {}) => executeCollectionRun(mkPlan({ bounds }), { clock: makeClock(), fetchImpl: impl, outputRoot: tempRoot() });
test('H1 a rate limit is RATE_LIMITED, records retry metadata, keeps earlier evidence, and never retries', async () => {
  let calls = 0;
  const impl = async () => {
    calls += 1;
    if (calls === 1) return json(STANDARD_PAGES()[0]);
    return new Response('', { status: 429, headers: { 'retry-after': '90', 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '300', 'x-ratelimit-reset': '2026-10-01T12:05:00.000Z' } });
  };
  const result = await failingRun(impl);
  assert.equal(result.status, 'RATE_LIMITED');
  assert.equal(calls, 2, 'no retry');
  assert.deepEqual({ ...result.manifest.failureCounts, }, { MAPPING_REFUSED: 1, RATE_LIMITED: 1 });
  assert.equal(result.manifest.recordsIngested, 2, 'evidence before the 429 is kept');
  assert.equal(result.manifest.pageCount, 1);
  assert.equal(result.manifest.requestCount, 2);
  const requests = await loadRequests(result);
  assert.deepEqual({ ...requests[1].rateLimit }, { retryAfterSeconds: 90, rateLimitLimit: 300, rateLimitRemaining: 0, rateLimitReset: '2026-10-01T12:05:00.000Z' });
  assert.equal(requests[1].outcome, 'RATE_LIMITED');
  assert.equal(replayRun(result.directory).ok, true);
  assert.notEqual(result.status, 'COMPLETED');
});
test('H2 a timeout is TIMEOUT and is not retried', async () => {
  let calls = 0;
  const impl = (url, init) => new Promise((resolve, reject) => {
    calls += 1;
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const result = await failingRun(impl, { timeoutMs: 20 });
  assert.equal(result.status, 'TIMEOUT');
  assert.equal(calls, 1);
  assert.deepEqual({ ...result.manifest.failureCounts }, { TIMEOUT: 1 });
  assert.equal(result.manifest.providerCursorSummary.stopReason, 'REQUEST_FAILED');
  assert.equal(replayRun(result.directory).ok, true);
});
test('H3 provider errors map to explicit failure classes under PROVIDER_ERROR', async () => {
  const cases = [
    [() => new Response('', { status: 500 }), 'PROVIDER_5XX'], [() => new Response('', { status: 503 }), 'PROVIDER_5XX'],
    [() => new Response('', { status: 401 }), 'PROVIDER_AUTH_REQUIRED'], [() => new Response('', { status: 403 }), 'PROVIDER_AUTH_REQUIRED'],
    [() => new Response('', { status: 404 }), 'PROVIDER_4XX'], [() => { throw new TypeError('fetch failed'); }, 'NETWORK_ERROR'],
  ];
  for (const [responder, failure] of cases) {
    const result = await failingRun(async () => responder());
    assert.equal(result.status, 'PROVIDER_ERROR', failure);
    assert.deepEqual({ ...result.manifest.failureCounts }, { [failure]: 1 });
    assert.equal(result.manifest.recordsIngested, 0);
    assert.equal(replayRun(result.directory).ok, true);
  }
});
test('H4 invalid and oversized provider responses are explicit, and no body is persisted', async () => {
  for (const [responder, failure] of [
    [() => json('{broken'), 'INVALID_PROVIDER_RESPONSE'], [() => json({ not: 'an array' }), 'INVALID_PROVIDER_RESPONSE'],
    [() => new Response('<html>CAPTCHA-PAGE</html>', { status: 200, headers: { 'content-type': 'text/html' } }), 'INVALID_PROVIDER_RESPONSE'],
    [() => json('[]', { 'content-length': '99999999' }), 'OVERSIZED_RESPONSE'],
  ]) {
    const result = await failingRun(async () => responder());
    assert.equal(result.status, 'PROVIDER_ERROR');
    assert.deepEqual({ ...result.manifest.failureCounts }, { [failure]: 1 });
    for (const name of readdirSync(result.directory)) assert.ok(!readFileSync(file(result.directory, name), 'utf8').includes('CAPTCHA-PAGE'));
  }
});
test('H5 mapper refusals are counted by reason and do not abort the run', async () => {
  const result = (await standardRun({ fetchImpl: pagedFetch([[status(5, { visibility: 'private' }), status(4, { created_at: 'bad' }), status(3, { id: 'x' }), status(2)], []]) })).result;
  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual({ ...result.manifest.refusedReasons }, { NON_PUBLIC_VISIBILITY: 1, PROVIDER_TIMESTAMP_MALFORMED: 1, PROVIDER_ID_MISSING_OR_INVALID: 1 });
  assert.equal(result.manifest.failureCounts.MAPPING_REFUSED, 3);
  assert.equal(result.manifest.recordsIngested, 1);
});
test('H6 an ingest conflict (same id, different evidence) is PARTIAL and never overwrites', async () => {
  const { result, dir } = await standardRun({ fetchImpl: pagedFetch([[status(1)], [status(1, { content: '<p>edited later</p>' })]]) });
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.manifest.conflicts, 1);
  assert.deepEqual({ ...result.manifest.failureCounts }, { INGEST_CONFLICT: 1 });
  assert.ok(readFileSync(file(dir, 'raw-evidence.ndjson'), 'utf8').includes('post 1 mint'));
  assert.ok(!readFileSync(file(dir, 'raw-evidence.ndjson'), 'utf8').includes('edited later'));
  assert.equal(replayRun(dir).ok, true);
});
test('H7 an unusable pagination cursor is PARTIAL, not COMPLETED', async () => {
  const { result } = await standardRun({ fetchImpl: pagedFetch([[status(1), { ...status(2), id: 'not-a-cursor' }]]) });
  assert.equal(result.manifest.providerCursorSummary.stopReason, 'PAGINATION_CURSOR_UNUSABLE');
  assert.equal(result.status, 'PARTIAL');
});
test('H8 an integrity failure is FAILED_INTEGRITY, is persisted as such, and never verifies', async () => {
  const root = tempRoot();
  let calls = 0;
  const impl = async () => {
    calls += 1;
    if (calls === 2) { // corrupt the run's own raw stream between pages
      const runDir = path.join(root, 'runs', readdirSync(path.join(root, 'runs'))[0]);
      writeFileSync(path.join(runDir, 'raw-evidence.ndjson'), '{"injected":true}\n');
    }
    return json(STANDARD_PAGES()[calls - 1] ?? []);
  };
  const result = await executeCollectionRun(mkPlan(), { clock: makeClock(), fetchImpl: impl, outputRoot: root });
  assert.equal(result.status, 'FAILED_INTEGRITY');
  assert.equal(result.verification.ok, false);
  assert.ok(result.manifest.failureCounts.INTEGRITY_FAILURE >= 1);
  assert.equal(JSON.parse(readFileSync(file(result.directory, 'manifest.json'), 'utf8')).status, 'FAILED_INTEGRITY');
  assert.equal(replayRun(result.directory).ok, false);
});
test('H9 REFUSED covers fixture/live misuse before any contact, and dry runs persist nothing', async () => {
  await refusalAsync(executeCollectionRun(mkPlan(), { clock: makeClock(), outputRoot: tempRoot() }), 'FIXTURE_MODE_REQUIRES_INJECTED_TRANSPORT');
  await refusalAsync(executeCollectionRun(mkPlan({ collectionMode: 'LIVE_PUBLIC_PROVIDER' }), { clock: makeClock(), fetchImpl: pagedFetch([]), outputRoot: tempRoot() }),
    'LIVE_MODE_FORBIDS_INJECTED_TRANSPORT');
  await refusalAsync(executeCollectionRun(mkPlan(), { clock: makeClock(), fetchImpl: pagedFetch([]) }), 'OUTPUT_ROOT_REQUIRED');
  await refusalAsync(executeCollectionRun(mkPlan(), { clock: makeClock(), fetchImpl: pagedFetch([]), outputRoot: path.join(REPO_ROOT, '.evolve', 'x') }), 'FORBIDDEN');
  const dry = await executeCollectionRun(mkPlan(), { clock: makeClock(), fetchImpl: pagedFetch(STANDARD_PAGES()), dryRun: true });
  assert.equal(dry.directory, null);
  assert.equal(dry.verification.ok, true);
  assert.equal(dry.manifest.recordsIngested, 3);
  await refusalAsync(executeCollectionRun(mkPlan(), { clock: makeClock(), fetchImpl: pagedFetch([]), dryRun: true, outputRoot: tempRoot() }), 'DRY_RUN_PERSISTS_NOTHING');
});

// ===========================================================================
// I. PRIVACY
// ===========================================================================
const FORBIDDEN_MANIFEST_WORDS = /handle|displayname|display_name|acct|bio|follower|following|geo|address|mention|contact|cookie|header|authorization|token|password|secret|email/i;
test('I1 manifests and request records contain no forbidden personal-data or credential field names', async () => {
  const { result } = await standardRun();
  const walk = (value, trail) => {
    if (Array.isArray(value)) return value.forEach((entry, i) => walk(entry, `${trail}[${i}]`));
    if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        assert.ok(!FORBIDDEN_MANIFEST_WORDS.test(key), `${trail}.${key}`);
        walk(inner, `${trail}.${key}`);
      }
    }
  };
  walk(result.manifest, 'manifest');
  for (const request of await loadRequests(result)) walk(request, 'request');
});
test('I2 personal values from provider records never appear in manifest or request files', async () => {
  const { dir } = await standardRun();
  for (const name of ['manifest.json', 'requests.ndjson', 'plan.json']) {
    const text = readFileSync(file(dir, name), 'utf8');
    for (const personal of ['alice', 'Alice Real Name', 'private bio', '777']) assert.ok(!text.includes(personal), `${name} contains ${personal}`);
  }
});
test('I3 manifests are aggregate-only: every string leaf is an enum, id, fingerprint, host or query value', async () => {
  const { result } = await standardRun();
  const allowed = [/^[0-9a-f]{64}$/, /^run-[0-9a-f]{32}$/, /^[A-Z][A-Z0-9_]*$/, /^[0-9]{1,32}$/, /^[a-z0-9.-]+$/, /^[A-Za-z0-9_]+$/, /^[a-z_]+$/, /^5K\.3\.0$/];
  const walk = value => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (value && typeof value === 'object') return Object.values(value).forEach(walk);
    if (typeof value === 'string') assert.ok(allowed.some(pattern => pattern.test(value)), `free-text leaf: ${value}`);
    return undefined;
  };
  walk(result.manifest);
});
test('I4 the 5K.1/5K.2 privacy filter still governs raw evidence: personal fields and credential-bearing records never reach disk', async () => {
  const { dir, result } = await standardRun({ fetchImpl: pagedFetch([[status(7, { geoLocation: { lat: 1 } }), status(6, { cookie: 'x' }), status(5)], []]) });
  assert.equal(result.manifest.refused, 2);
  const raw = readFileSync(file(dir, 'raw-evidence.ndjson'), 'utf8');
  // (the public status URL legitimately contains the author's path under 5K.1; profile fields do not)
  for (const personal of ['Alice Real Name', 'private bio', '777', 'geoLocation']) assert.ok(!raw.includes(personal), personal);
});
test('I5 the failure vocabulary carries codes and counts only, never messages or evidence', async () => {
  const result = await failingRun(async () => json('{"secret":"LEAK-ME-123"'));
  const text = JSON.stringify(result.manifest) + readLines(file(result.directory, 'requests.ndjson')).join('');
  assert.ok(!text.includes('LEAK-ME-123'));
  for (const key of Object.keys(result.manifest.failureCounts)) assert.ok(MANIFEST.PUBLIC_INTELLIGENCE_5K3_FAILURE_VALUES.includes(key));
});

// ===========================================================================
// M. MINT-ASSOCIATION BOUNDARY (orchestration has zero authority)
// ===========================================================================
test('M1 orchestration contains no mint, symbol, registry or association logic', () => {
  for (const unit of NEW_MODULES) {
    const { found } = parseModule(unit);
    for (const word of ['canonicalMintAddress', 'claimedMint', 'claimedSymbol', 'candidateMintAddresses', 'resolveAssetAssociation', 'tokenRegistry', 'lookupToken', 'levenshtein']) {
      assert.ok(!found.identifiers.includes(word), `${unit} references ${word}`);
    }
  }
});
test('M2 exact-mint semantics are unchanged through a run: exact claims, symbols never', async () => {
  const { dir } = await standardRun({ fetchImpl: pagedFetch([[
    status(10), status(9, { content: '<p>$BONK to the moon #bonk</p>' }), status(8, { content: `<p>${MINT} and ${MINT_2}</p>` }),
  ], []]) });
  const [exact, symbol, ambiguous] = readLines(file(dir, 'raw-evidence.ndjson')).map(line => JSON.parse(line));
  assert.equal(exact.claimedMint, MINT);
  assert.equal(symbol.claimedMint, null);
  assert.equal(ambiguous.claimedMint, null);
  const envelopes = readLines(file(dir, 'observations.ndjson')).map(line => JSON.parse(line));
  assert.deepEqual(envelopes.map(e => e.normalized.assetAssociation.status), ['EXACT_MINT', 'UNASSOCIATED', 'UNASSOCIATED']);
});

// ===========================================================================
// J. ARCHITECTURAL ISOLATION
// ===========================================================================
test('J1 no 5K.3 module reaches trading, engine, Arena, promotion or R4 code', () => {
  for (const entry of closureAll) {
    assert.ok(entry.startsWith(`${PI}/`) || entry === 'scripts/market-intelligence/definition.mjs', `unexpected closure member ${entry}`);
    assert.ok(!/(engine|arena|champion|promotion|governance\/r4|r4-|market-outcomes)/.test(entry.replace(`${PI}/`, '')), entry);
  }
});
test('J2 no wallet, signer, swap or RPC-write capability exists in the 5K.3 closure', () => {
  for (const entry of closureAll) {
    const { found } = parseModule(entry);
    for (const source of found.importSources) assert.ok(!WALLET_MODULES.includes(source), `${entry} ${source}`);
    for (const id of [...found.identifiers, ...found.memberObjects]) assert.ok(!SIGNING_OR_RPC_WRITE.includes(id), `${entry} ${id}`);
  }
});
test('J3 only the 5K.2 transport (and the CLI/orchestrator through it) can reach the network', () => {
  const holders = closureAll.filter(entry => parseModule(entry).found.identifiers.includes('fetch'));
  assert.deepEqual(holders, [`${PI}/providers/mastodon-transport.mjs`]);
  for (const unit of ['collection-plan', 'collection-manifest', 'run-store', 'replay'].map(name => `${PI}/${name}.mjs`)) {
    assert.ok(!importClosure(unit).some(entry => entry.endsWith('mastodon-transport.mjs')), `${unit} can reach the transport`);
  }
  for (const entry of closureAll) for (const source of parseModule(entry).found.importSources) assert.ok(!NETWORK_BUILTINS.includes(source), `${entry} ${source}`);
});
test('J4 filesystem writes exist only in run-store.mjs among the 5K.3 modules', () => {
  const writers = /^(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|rm|rmSync|unlinkSync|linkSync|chmodSync|renameSync)$/;
  for (const unit of NEW_MODULES) {
    const hit = parseModule(unit).found.identifiers.filter(id => writers.test(id));
    if (unit.endsWith('run-store.mjs')) assert.ok(hit.length > 0); else assert.deepEqual(hit, [], unit);
  }
});
test('J5 no 5K.3 module writes under .evolve or mentions it beyond the refusal constant', () => {
  for (const unit of NEW_MODULES) {
    for (const literal of parseModule(unit).found.stringLiterals) {
      if (literal.includes('.evolve')) assert.ok(unit.endsWith('run-store.mjs') && literal === '.evolve', `${unit}: ${literal}`);
    }
  }
  assert.equal(existsSync(path.join(REPO_ROOT, '.evolve', 'public-intelligence')), false);
});
test('J6 nothing outside scripts/public-intelligence imports a 5K.3 module', () => {
  const listed = gitOut('ls-files', 'scripts', 'src').split('\n').filter(entry => /\.(mjs|ts|tsx|js)$/.test(entry));
  for (const entry of listed) {
    if (entry === 'scripts/validate-phase5k3.mjs' || entry.startsWith(`${PI}/`)) continue;
    assert.ok(!/(collection-plan|collection-run|collection-manifest|run-store|public-intelligence\/replay|public-intelligence\/collect)/.test(readFileSync(path.join(REPO_ROOT, entry), 'utf8')), entry);
  }
});

// ===========================================================================
// K. REGRESSION
// ===========================================================================
const phaseCount = (script, line) => assert.ok(execFileSync('node', [script], { cwd: REPO_ROOT, encoding: 'utf8' }).includes(line), `${script} did not report ${line}`);
test('K1 5K.0 stays 32/32', () => phaseCount('scripts/validate-phase5k.mjs', 'Phase 5K.0: 32/32 passed'));
test('K2 5K.1 stays 64/64', () => phaseCount('scripts/validate-phase5k1.mjs', 'Phase 5K.1: 64/64 passed'));
test('K3 5K.2 stays 70/70', () => phaseCount('scripts/validate-phase5k2.mjs', 'Phase 5K.2: 70/70 passed'));
test('K4 R4 C1 is an ancestor of HEAD and finalized R4 files are unchanged', () => {
  execFileSync('git', ['merge-base', '--is-ancestor', R4_HEAD, 'HEAD'], { cwd: REPO_ROOT });
  for (const bound of ['governance/r4/r4-preregistration-seal.json', 'package.json', 'package-lock.json']) {
    assert.ok(readFileSync(path.join(REPO_ROOT, bound)).equals(execFileSync('git', ['show', `${R4_HEAD}:${bound}`], { cwd: REPO_ROOT })), bound);
  }
});
test('K5 frozen 5K.0/5K.1 code, the 5K.2 mapper and all earlier phase docs/validators are unmodified', () => {
  const frozen = ['definition', 'observation', 'provenance', 'normalize', 'dedup', 'store', 'ingest', 'fixtures'].map(name => `${PI}/${name}.mjs`);
  frozen.push(`${PI}/providers/mastodon-mapper.mjs`, `${PI}/providers/mastodon.mjs`, 'scripts/validate-phase5k.mjs', 'scripts/validate-phase5k1.mjs', 'scripts/validate-phase5k2.mjs',
    'docs/PHASE5K-PUBLIC-SOCIAL-INTELLIGENCE.md', 'docs/PHASE5K1-INGESTION-PROVENANCE.md', 'docs/PHASE5K2-FIRST-PROVIDER.md');
  for (const entry of frozen) assert.equal(gitOut('diff', '--name-only', 'HEAD', '--', entry).trim(), '', `${entry} modified`);
});
test('K6 the 5K.2 hard ceilings and error vocabulary are unchanged', () => {
  assert.deepEqual({ ...COMMON.PROVIDER_HARD_CEILINGS }, { maxPages: 5, maxRecords: 200, maxResponseBytes: 2097152, timeoutMs: 20000, lookbackMs: 604800000, maxRetries: 0 });
  assert.equal(Object.keys(COMMON.PROVIDER_ERROR_CODES).length, 13);
});
test('K7 the phase document exists and covers every required section', () => {
  const doc = readFileSync(path.join(REPO_ROOT, 'docs/PHASE5K3-COLLECTION-RUNS.md'), 'utf8').toLowerCase();
  for (const heading of ['collection-plan schema', 'run lifecycle', 'manifest schema', 'request records', 'bounds', 'accounting invariants', 'failure states',
    'storage layout', 'replay', 'tamper verification', 'privacy', 'mint-association boundary', 'cli', 'non-goals', 'roadmap label']) {
    assert.ok(doc.includes(heading), `doc lacks "${heading}"`);
  }
});

// ===========================================================================
// L. LIVE ISOLATION
// ===========================================================================
test('L1 the CLI parser is strict: unknown flags, bad numbers and unsafe combinations are refused', () => {
  const ok = CLI.parseCollectArgs(['collect', '--instance', 'a.example', '--hashtag', 'solana', '--max-pages', '1', '--max-records', '10', '--dry-run']);
  assert.equal(ok.bounds.maxPages, 1);
  assert.equal(ok.dryRun, true);
  for (const argv of [['bogus'], ['collect', '--url', 'x'], ['collect', '--max-pages', 'abc'], ['collect', '--max-pages', '-1'], ['collect', '--max-pages', '1e3'],
    ['collect', '--hashtag'], ['collect', '--fetch'], []]) {
    assert.throws(() => CLI.parseCollectArgs(argv), /CLI_/, JSON.stringify(argv));
  }
  assert.deepEqual({ ...CLI.COLLECT_DEFAULT_BOUNDS }, { maxPages: 1, maxRecords: 10, timeoutMs: 10000, maxResponseBytes: 524288, maxLookbackMs: 86400000 });
});
test('L2 CLI defaults can never exceed the hard ceilings, and an over-ceiling request fails plan validation', () => {
  const parsed = CLI.parseCollectArgs(['collect', '--max-records', '201']);
  refusal(() => buildCollectionPlan({ instance: 'a.example', hashtag: 'x', bounds: parsed.bounds, collectionMode: 'LIVE_PUBLIC_PROVIDER', createdAt: T0 }), 'BOUND_EXCEEDS_CEILING:maxRecords');
  assert.doesNotThrow(() => buildCollectionPlan({ instance: 'a.example', hashtag: 'x', bounds: CLI.COLLECT_DEFAULT_BOUNDS, collectionMode: 'LIVE_PUBLIC_PROVIDER', createdAt: T0 }));
});
test('L3 the live collection command is never invoked by the validator', () => {
  const self = parseModule('scripts/validate-phase5k3.mjs').found;
  const { source: own } = parseModule('scripts/validate-phase5k3.mjs');
  assert.equal((own.match(/execFileSync\('node'/g) ?? []).length, 1, 'the only node child process is the phaseCount helper');
  const targets = [...own.matchAll(/phaseCount\('([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(targets, ['scripts/validate-phase5k.mjs', 'scripts/validate-phase5k1.mjs', 'scripts/validate-phase5k2.mjs']);
  assert.ok(!self.importSources.some(entry => /spawn|child_process/.test(entry) && entry !== 'node:child_process'));
  const { source } = parseModule(`${PI}/collect.mjs`);
  assert.ok(/import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/.test(source));
  const { found: cliFound } = parseModule(`${PI}/collect.mjs`);
  for (const id of ['setInterval', 'setTimeout', 'setImmediate', 'fork', 'spawn', 'exec']) assert.ok(!cliFound.identifiers.includes(id), id);
  assert.ok(!/while \(true\)|for \(;;\)/.test(source));
});
test('L4 all validator run stores are temporary directories outside the repository', () => {
  assert.ok(temporary.length > 20);
  for (const root of temporary) assert.ok(root.startsWith(tmpdir()) && !root.startsWith(REPO_ROOT), root);
});
test('L5 the validator made zero real network calls', () => assert.equal(tripwireCalls, 0));
test('L6 .evolve and the working tree are untouched by validation', () => {
  for (const line of gitOut('status', '--porcelain').split('\n').filter(Boolean)) assert.equal(/^\s*[MADRCU?!]{1,2}\s+\.evolve/.test(line), false);
  assert.ok(!existsSync(path.join(REPO_ROOT, 'var')));
});

// ---------------------------------------------------------------------------
async function main() {
  let failed = 0;
  try {
    for (const [name, fn] of tests) {
      try { await fn(); console.log(`PASS ${name}`); } catch (error) { failed++; console.error(`FAIL ${name}: ${error.stack}`); }
    }
  } finally { for (const root of temporary) rmSync(root, { recursive: true, force: true }); }
  console.log(`Phase 5K.3: ${tests.length - failed}/${tests.length} passed; offline, fixtures + injected clocks only, ${tripwireCalls} network calls, collection CLI never invoked`);
  if (failed) process.exitCode = 1;
}
main().catch(error => { console.error('phase 5K.3 validator crashed:', error); process.exitCode = 1; });
