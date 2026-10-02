#!/usr/bin/env node
// Phase 5K.4 - CROSS-RUN EVIDENCE CORPUS & SNAPSHOT INTEGRITY validator.
//
// COMPLETELY OFFLINE AND DETERMINISTIC. Runs are produced with injected counter
// clocks and in-memory fixture fetches; the global fetch and socket connect are
// replaced with tripwires and asserted never called. The corpus CLI is never
// invoked. Every run root and corpus root is a temporary directory; the
// repository tree, `var/` and `.evolve` are never written.
import assert from 'node:assert/strict';
import net from 'node:net';
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
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
const CORE = await import('./public-intelligence/index.mjs');
const RUNS = await import('./public-intelligence/research-surface.mjs');
const MEMBER = await import('./public-intelligence/corpus-membership.mjs');
const INDEX = await import('./public-intelligence/corpus-index.mjs');
const SNAP = await import('./public-intelligence/corpus-snapshot.mjs');
const VERIFY = await import('./public-intelligence/corpus-verify.mjs');
const QUERY = await import('./public-intelligence/corpus-query.mjs');
const CLI = await import('./public-intelligence/corpus-cli.mjs');
const { PUBLIC_INTELLIGENCE_CLASSIFICATION, canonical, digest } = DEF;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R4_HEAD = '1c30264fb87876eeaf229e25c5cdc5adca429b40';
const PI = 'scripts/public-intelligence';
const CORPUS_MODULES = ['corpus-membership', 'corpus-index', 'corpus-snapshot', 'corpus-verify', 'corpus-query', 'corpus-cli'].map(name => `${PI}/${name}.mjs`);
const require = createRequire(import.meta.url);
const espree = require('espree');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const temporary = [];
const tempRoot = () => { const root = mkdtempSync(path.join(tmpdir(), 'evolve-5k4-')); temporary.push(root); return root; };
const gitOut = (...args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MINT_2 = 'So11111111111111111111111111111111111111112';
const T0 = 1790000000000;
const HOST = 'fixture.example';
const BOUNDS = Object.freeze({ maxPages: 2, maxRecords: 10, timeoutMs: 5000, maxResponseBytes: 100_000, maxLookbackMs: 3 * 24 * 60 * 60 * 1000 });
const DEFAULT = MEMBER.PUBLIC_INTELLIGENCE_5K4_DEFAULT_POLICY;
const PARTIAL_OK = MEMBER.buildCorpusPolicy({ includePartial: true });

const status = (id, over = {}) => ({
  id: String(id), visibility: 'public', created_at: '2026-10-01T10:00:00.000Z', url: `https://${HOST}/@alice/${id}`,
  in_reply_to_id: null, reblog: null, language: 'en', content: `<p>post ${id} mint ${MINT}</p>`, tags: [{ name: 'solana' }],
  favourites_count: 3, replies_count: 0, reblogs_count: 1,
  account: { id: '42', acct: 'alice', display_name: 'Alice Real Name', note: '<p>private bio</p>', followers_count: 777 },
  ...over,
});
const s30 = (over = {}) => status(30, over);
const s29 = (over = {}) => status(29, { content: '<p>love $ALPHA token 29</p>', ...over });
const s28 = () => { const s = status(28, { content: `<p>post 28 mint ${MINT_2}</p>` }); delete s.favourites_count; delete s.replies_count; delete s.reblogs_count; delete s.created_at; return s; };
const s27 = () => status(27);

const makeClock = (start) => { let t = start; return () => { t += 10; return t; }; };
const json = (body, headers = {}, init = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers }, ...init });
const pagedFetch = pages => { let calls = 0; return async () => json(pages[calls++] ?? []); };

/** Produces ONE immutable 5K.3 run in `root`. */
async function makeRun(root, { start = T0, pages = [[s30(), s29(), s28()]], instance = HOST, fetchImpl = null, bounds = {} } = {}) {
  const plan = RUNS.buildCollectionPlan({
    instance, hashtag: 'solana', bounds: { ...BOUNDS, ...bounds }, collectionMode: 'OFFLINE_FIXTURE', createdAt: start,
  });
  const result = await RUNS.executeCollectionRun(plan, { clock: makeClock(start), fetchImpl: fetchImpl ?? pagedFetch(pages), outputRoot: root });
  return result;
}
const RUN_A = { start: T0, pages: [[s30(), s29(), s28()]] };
const RUN_B = { start: T0 + 100_000, pages: [[s30(), s29(), s27()]] };
const RUN_C = { start: T0 + 200_000, pages: [[s30({ content: '<p>post 30 EDITED</p>' })]] };

/** Root with runs A and B (the standard duplicate-bearing pair). */
async function standardRoot(extra = []) {
  const root = tempRoot();
  const a = await makeRun(root, RUN_A);
  const b = await makeRun(root, RUN_B);
  const more = [];
  for (const spec of extra) more.push(await makeRun(root, spec));
  return { root, a, b, more };
}
const build = (root, runs, options = {}) => SNAP.buildAndStoreSnapshot({
  root, runIds: runs.map(run => run.runId), policy: options.policy ?? DEFAULT, createdAt: options.createdAt ?? T0 + 1_000_000,
});
async function standardSnapshot(extra = []) {
  const ctx = await standardRoot(extra);
  const runs = [ctx.a, ctx.b, ...ctx.more];
  const result = build(ctx.root, runs);
  return { ...ctx, runs, result, id: result.snapshotId, dir: result.directory, manifest: result.manifest };
}

const file = (dir, name) => path.join(dir, name);
const readNd = target => readFileSync(target, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
function editNd(target, fn) {
  chmodSync(target, 0o644);
  const records = readNd(target);
  const out = fn(records) ?? records;
  writeFileSync(target, out.map(record => `${canonical(record)}\n`).join(''));
}
/** Edits snapshot.json; `resign` recomputes snapshotFingerprint so only deep verification can catch it. */
function editManifest(dir, fn, resign = true) {
  const target = file(dir, 'snapshot.json');
  chmodSync(target, 0o644);
  const manifest = JSON.parse(readFileSync(target, 'utf8'));
  fn(manifest);
  if (resign) manifest.snapshotFingerprint = SNAP.snapshotFingerprintOf(manifest);
  writeFileSync(target, `${canonical(manifest)}\n`);
}
const reseal = (record, field) => { const body = { ...record }; delete body[field]; return { ...body, [field]: digest(body) }; };
const verifyOf = ctx => VERIFY.verifySnapshot(ctx.root, ctx.id);
const hasFailure = (result, prefix) => result.failures.some(code => code.startsWith(prefix));
const refusal = (fn, fragment) => {
  let thrown = null;
  try { fn(); } catch (error) { thrown = error; }
  assert.ok(thrown, `expected refusal containing ${fragment}`);
  assert.ok(String(thrown.message).includes(fragment), `expected ${fragment}, got ${thrown.message}`);
};
const hashTree = directory => {
  const out = {};
  const walk = current => { for (const name of readdirSync(current).sort()) { const full = path.join(current, name); if (statSync(full).isDirectory()) walk(full); else out[path.relative(directory, full)] = digest(readFileSync(full, 'utf8')); } };
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
    for (const source of parseModule(current).found.importSources) if (source.startsWith('.')) queue.push(path.normalize(path.join(path.dirname(current), source)));
  }
  return [...seen].sort();
}
const NETWORK_BUILTINS = ['node:http', 'node:https', 'node:http2', 'node:net', 'node:tls', 'node:dgram', 'node:dns', 'node:child_process', 'node:worker_threads', 'http', 'https', 'net', 'tls', 'dgram', 'dns', 'child_process'];
const WALLET_MODULES = ['@solana/web3.js', '@solana/spl-token', 'solana', 'tweetnacl', 'ed25519-hd-keypairs', 'bs58'];
const SIGNING_OR_RPC_WRITE = ['sendRawTransaction', 'sendTransaction', 'sendAndConfirmTransaction', 'signTransaction', 'signAllTransactions', 'partialSign', 'Keypair',
  'VersionedTransaction', 'Transaction', 'SystemProgram', 'splToken', 'requestAirdrop', 'confirmTransaction', 'rpc'];
const closureAll = [...new Set(CORPUS_MODULES.flatMap(importClosure))].sort();
const OFFLINE_CORPUS = CORPUS_MODULES.filter(entry => !entry.endsWith('corpus-cli.mjs'));

// ===========================================================================
// A. GOVERNANCE
// ===========================================================================
test('A1 5K.0 classification is researchOnly and observerOnly', () => {
  assert.equal(PUBLIC_INTELLIGENCE_CLASSIFICATION.researchOnly, true);
  assert.equal(PUBLIC_INTELLIGENCE_CLASSIFICATION.observerOnly, true);
});
test('A2 every authority flag is false on snapshot, observation and membership-bearing output', async () => {
  const ctx = await standardSnapshot();
  const obs = readNd(file(ctx.dir, 'observations.ndjson'))[0];
  for (const classification of [ctx.manifest.classification, obs.classification]) {
    for (const flag of ['tradingAuthority', 'engineAuthority', 'arenaEligible', 'promotionEligible', 'profitabilityInferencePermitted']) assert.equal(classification[flag], false, flag);
  }
});
test('A3 a snapshot or observation cannot widen the classification', async () => {
  const ctx = await standardSnapshot();
  refusal(() => SNAP.validateSnapshotManifest({ ...ctx.manifest, classification: { ...ctx.manifest.classification, tradingAuthority: true } }), 'CLASSIFICATION_OVERRIDE_REFUSED');
  const obs = readNd(file(ctx.dir, 'observations.ndjson'))[0];
  refusal(() => INDEX.validateObservationRecord({ ...obs, classification: { ...obs.classification, profitabilityInferencePermitted: true } }), 'CLASSIFICATION_OVERRIDE_REFUSED');
});
test('A4 no corpus artifact carries a sentiment, score, rank, signal or profit field', async () => {
  const ctx = await standardSnapshot([RUN_C]);
  const words = /sentiment|score|rank|signal|profit|alpha|recommend|predict|confidence|momentum|popular|importance/i;
  const walk = value => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (value && typeof value === 'object') { for (const [key, inner] of Object.entries(value)) { if (key === 'classification') continue; assert.ok(!words.test(key), key); walk(inner); } }
    return undefined;
  };
  walk(ctx.manifest);
  for (const name of ['membership.ndjson', 'observations.ndjson', 'conflicts.ndjson']) readNd(file(ctx.dir, name)).forEach(walk);
});

// ===========================================================================
// B. RUN ELIGIBILITY
// ===========================================================================
test('B1 a valid COMPLETED run is accepted under the default policy', async () => {
  const root = tempRoot(); const run = await makeRun(root, RUN_A);
  const auth = MEMBER.authenticateRun(root, run.runId);
  assert.equal(auth.ok, true);
  assert.equal(auth.status, 'COMPLETED');
  assert.deepEqual([...DEFAULT.eligibleStatuses], ['COMPLETED']);
});
test('B2 FAILED_INTEGRITY is never eligible, under any policy', async () => {
  const root = tempRoot(); let calls = 0;
  const run = await makeRun(root, { fetchImpl: async () => {
    calls += 1;
    if (calls === 2) writeFileSync(path.join(root, 'runs', readdirSync(path.join(root, 'runs'))[0], 'raw-evidence.ndjson'), '{"injected":true}\n');
    return json([[s30(), s29()], [s27()]][calls - 1] ?? []);
  } });
  assert.equal(run.status, 'FAILED_INTEGRITY');
  for (const policy of [DEFAULT, PARTIAL_OK]) {
    const auth = MEMBER.authenticateRun(root, run.runId, policy);
    assert.equal(auth.ok, false);
    assert.ok(auth.reasons.some(reason => reason.startsWith('RUN_STATUS_NOT_ELIGIBLE:FAILED_INTEGRITY')));
  }
});
test('B3 a PARTIAL run is refused by default and admitted only by an explicit, visibly-marked policy', async () => {
  const root = tempRoot();
  const partial = await makeRun(root, { start: T0, pages: [[s30()], [s30({ content: '<p>changed between pages</p>' })]] });
  assert.equal(partial.status, 'PARTIAL');
  const refused = MEMBER.authenticateRun(root, partial.runId);
  assert.equal(refused.ok, false);
  assert.ok(refused.reasons.includes('RUN_STATUS_NOT_ELIGIBLE:PARTIAL'));
  const admitted = MEMBER.authenticateRun(root, partial.runId, PARTIAL_OK);
  assert.equal(admitted.ok, true);
  assert.equal(MEMBER.buildMembershipRecord(admitted, PARTIAL_OK).partial, true);
});
test('B4 RATE_LIMITED, TIMEOUT and PROVIDER_ERROR runs are not silently equivalent to COMPLETED', async () => {
  const root = tempRoot();
  const limited = await makeRun(root, { start: T0, fetchImpl: async () => new Response('', { status: 429 }) });
  const failed = await makeRun(root, { start: T0 + 1000, fetchImpl: async () => new Response('', { status: 500 }) });
  const timedOut = await makeRun(root, { start: T0 + 2000, bounds: { timeoutMs: 20 }, fetchImpl: (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('a'), { name: 'AbortError' }))) ) });
  assert.deepEqual([limited.status, failed.status, timedOut.status], ['RATE_LIMITED', 'PROVIDER_ERROR', 'TIMEOUT']);
  for (const run of [limited, failed, timedOut]) {
    for (const policy of [DEFAULT, PARTIAL_OK]) assert.equal(MEMBER.authenticateRun(root, run.runId, policy).ok, false);
  }
});
test('B5 a policy can never list a never-eligible status, and must include COMPLETED', () => {
  for (const status of ['RATE_LIMITED', 'TIMEOUT', 'PROVIDER_ERROR', 'FAILED_INTEGRITY', 'REFUSED', 'BOGUS']) {
    refusal(() => MEMBER.validateCorpusPolicy({ corpusPolicyVersion: 'corpus-policy-1', eligibleStatuses: ['COMPLETED', status] }), 'NEVER_ELIGIBLE');
  }
  refusal(() => MEMBER.validateCorpusPolicy({ corpusPolicyVersion: 'corpus-policy-1', eligibleStatuses: ['PARTIAL'] }), 'MUST_INCLUDE_COMPLETED');
  refusal(() => MEMBER.validateCorpusPolicy({ corpusPolicyVersion: 'corpus-policy-1', eligibleStatuses: ['COMPLETED'], extra: 1 }), 'UNKNOWN_FIELD');
  refusal(() => MEMBER.validateCorpusPolicy({ corpusPolicyVersion: 'v2', eligibleStatuses: ['COMPLETED'] }), 'POLICY_VERSION_INVALID');
});
test('B6 a run with an invalid manifest is refused, even when the manifest is re-signed', async () => {
  const root = tempRoot(); const run = await makeRun(root, RUN_A);
  const target = path.join(run.directory, 'manifest.json');
  chmodSync(target, 0o644);
  const manifest = JSON.parse(readFileSync(target, 'utf8'));
  manifest.duplicates += 1; manifest.manifestFingerprint = RUNS.manifestFingerprintOf(manifest);
  writeFileSync(target, JSON.stringify(manifest));
  const auth = MEMBER.authenticateRun(root, run.runId);
  assert.equal(auth.ok, false);
  assert.ok(auth.reasons.some(reason => reason.startsWith('RUN_VERIFICATION:ACCOUNTING')));
});
test('B7 a run that fails offline replay is refused', async () => {
  const root = tempRoot(); const run = await makeRun(root, RUN_A);
  const target = path.join(run.directory, 'raw-evidence.ndjson');
  writeFileSync(target, readFileSync(target, 'utf8').replace('post 30', 'post 3X'));
  const auth = MEMBER.authenticateRun(root, run.runId);
  assert.equal(auth.ok, false);
  assert.ok(auth.reasons.some(reason => reason.includes('RAW_EVIDENCE_FINGERPRINT_MISMATCH')));
});
test('B8 directory names are not trusted: a copied run under another name is refused', async () => {
  const root = tempRoot(); const run = await makeRun(root, RUN_A);
  const fake = `run-${'a'.repeat(32)}`;
  cpSync(run.directory, path.join(root, 'runs', fake), { recursive: true });
  const auth = MEMBER.authenticateRun(root, fake);
  assert.equal(auth.ok, false);
  assert.ok(auth.reasons.includes('RUN_DIRECTORY_NAME_NE_MANIFEST_RUN_ID'));
});
test('B9 a missing run, a symlinked run and an unfinalized run are refused', async () => {
  const root = tempRoot(); const run = await makeRun(root, RUN_A);
  assert.deepEqual([...MEMBER.authenticateRun(root, `run-${'b'.repeat(32)}`).reasons], ['RUN_MISSING']);
  const link = `run-${'c'.repeat(32)}`;
  symlinkSync(run.directory, path.join(root, 'runs', link));
  assert.deepEqual([...MEMBER.authenticateRun(root, link).reasons], ['RUN_NOT_A_PLAIN_DIRECTORY']);
  rmSync(path.join(run.directory, 'manifest.json'), { force: true });
  assert.ok(MEMBER.authenticateRun(root, run.runId).reasons.includes('RUN_VERIFICATION:MANIFEST_MISSING_UNFINALIZED_RUN'));
});
test('B10 discovery is sorted, explicit about runs that fail, and ignores non-run entries', async () => {
  const root = tempRoot();
  const a = await makeRun(root, RUN_A); const b = await makeRun(root, RUN_B);
  const bad = await makeRun(root, { start: T0 + 5000 });
  writeFileSync(path.join(bad.directory, 'raw-evidence.ndjson'), 'garbage\n');
  const partial = await makeRun(root, { start: T0 + 6000, pages: [[s30()], [s30({ content: '<p>x</p>' })]] });
  writeFileSync(path.join(root, 'runs', '.manifest.tmp'), 'tmp');
  mkdirSync(path.join(root, 'runs', 'notes'));
  mkdirSync(path.join(root, 'runs', 'run-short'));
  const found = MEMBER.discoverRuns(root);
  assert.deepEqual(found.map(entry => entry.name), [...found.map(entry => entry.name)].sort());
  const by = Object.fromEntries(found.map(entry => [entry.name, entry.classification]));
  assert.equal(by[a.runId], 'ELIGIBLE'); assert.equal(by[b.runId], 'ELIGIBLE');
  assert.equal(by[bad.runId], 'INVALID');
  assert.equal(by[partial.runId], 'INELIGIBLE_STATUS');
  assert.equal(by['.manifest.tmp'], 'IGNORED'); assert.equal(by.notes, 'IGNORED');
  assert.equal(by['run-short'], 'INVALID');
  assert.equal(MEMBER.discoverRuns(root, PARTIAL_OK).find(entry => entry.name === partial.runId).classification, 'ELIGIBLE');
});

// ===========================================================================
// C. MEMBERSHIP
// ===========================================================================
test('C1 membership is deterministic and bound to the run manifest', async () => {
  const root = tempRoot(); const run = await makeRun(root, RUN_A);
  const one = MEMBER.buildMembershipRecord(MEMBER.authenticateRun(root, run.runId));
  const two = MEMBER.buildMembershipRecord(MEMBER.authenticateRun(root, run.runId));
  assert.equal(canonical(one), canonical(two));
  assert.equal(one.runManifestFingerprint, run.manifest.manifestFingerprint);
  assert.equal(one.collectionPlanFingerprint, run.manifest.collectionPlanFingerprint);
  assert.deepEqual({ raw: one.rawRecordCount, norm: one.normalizedRecordCount, status: one.status, partial: one.partial }, { raw: 3, norm: 3, status: 'COMPLETED', partial: false });
  assert.doesNotThrow(() => MEMBER.validateMembershipRecord(one));
});
test('C2 the membership schema is closed: unknown, missing and mistyped fields fail', async () => {
  const root = tempRoot(); const run = await makeRun(root, RUN_A);
  const m = MEMBER.buildMembershipRecord(MEMBER.authenticateRun(root, run.runId));
  refusal(() => MEMBER.validateMembershipRecord({ ...m, extra: 1 }), 'UNKNOWN_FIELD:extra');
  const missing = { ...m }; delete missing.provider;
  refusal(() => MEMBER.validateMembershipRecord(missing), 'FIELD_MISSING:provider');
  refusal(() => MEMBER.validateMembershipRecord({ ...m, rawRecordCount: -1 }), 'COUNT_INVALID');
  refusal(() => MEMBER.validateMembershipRecord({ ...m, status: 'RATE_LIMITED' }), 'STATUS_NOT_ADMISSIBLE');
  refusal(() => MEMBER.validateMembershipRecord({ ...m, partial: true }), 'PARTIAL_MARK_INVALID');
});
test('C3 membership fingerprint binds every field: any edit invalidates it', async () => {
  const root = tempRoot(); const run = await makeRun(root, RUN_A);
  const m = MEMBER.buildMembershipRecord(MEMBER.authenticateRun(root, run.runId));
  for (const patch of [{ runManifestFingerprint: 'f'.repeat(64) }, { collectionPlanFingerprint: 'e'.repeat(64) }, { rawRecordCount: 4 }, { completedAt: m.completedAt + 1 }]) {
    refusal(() => MEMBER.validateMembershipRecord({ ...m, ...patch }), 'FINGERPRINT_MISMATCH');
  }
});
test('C4 a membership cannot be built for an unauthenticated run', async () => {
  const root = tempRoot();
  refusal(() => MEMBER.buildMembershipRecord(MEMBER.authenticateRun(root, `run-${'d'.repeat(32)}`)), 'REQUIRES_AUTHENTICATED_RUN');
  refusal(() => MEMBER.buildMembershipRecord(null), 'REQUIRES_AUTHENTICATED_RUN');
});
test('C5 a changed run manifest invalidates the membership and the snapshot', async () => {
  const ctx = await standardSnapshot();
  const target = path.join(ctx.a.directory, 'manifest.json');
  chmodSync(target, 0o644);
  const manifest = JSON.parse(readFileSync(target, 'utf8'));
  manifest.completedAt += 1; manifest.manifestFingerprint = RUNS.manifestFingerprintOf(manifest);
  writeFileSync(target, JSON.stringify(manifest));
  const result = verifyOf(ctx);
  assert.equal(result.ok, false);
  assert.ok(hasFailure(result, 'RUN_NOT_ADMITTED') || hasFailure(result, 'RUN_MANIFEST_FINGERPRINT_CHANGED'));
});
test('C6 a forged membership naming the wrong plan fingerprint is caught', async () => {
  const ctx = await standardSnapshot();
  editNd(file(ctx.dir, 'membership.ndjson'), records => { records[0] = reseal({ ...records[0], collectionPlanFingerprint: '0'.repeat(64) }, 'membershipFingerprint'); });
  assert.ok(hasFailure(verifyOf(ctx), 'MEMBERSHIP_MODIFIED'));
});

// ===========================================================================
// D. CROSS-RUN IDENTITY
// ===========================================================================
const obsOf = ctx => readNd(file(ctx.dir, 'observations.ndjson'));
test('D1 same provider + same providerObservationId is the same upstream identity across runs', async () => {
  const ctx = await standardSnapshot();
  const identity = CORE.dedupIdentity5K1({ provider: `mastodon:${HOST}`, providerObservationId: '30' });
  const obs = obsOf(ctx).find(record => record.upstreamIdentity === identity);
  assert.ok(obs);
  assert.deepEqual(obs.memberRunIds, [ctx.a.runId, ctx.b.runId].sort());
});
test('D2 the same id on a different provider is a different identity and never collapses', async () => {
  const root = tempRoot();
  const a = await makeRun(root, RUN_A);
  const d = await makeRun(root, { start: T0 + 300_000, instance: 'other.example', pages: [[s30()]] });
  const result = build(root, [a, d]);
  const obs = readNd(file(result.directory, 'observations.ndjson'));
  const thirty = obs.filter(record => record.providerObservationId === '30');
  assert.equal(thirty.length, 2);
  assert.notEqual(thirty[0].upstreamIdentity, thirty[1].upstreamIdentity);
  assert.deepEqual(thirty.map(record => record.appearanceCount), [1, 1]);
  assert.equal(result.manifest.conflictedUpstreamIdentities, 0);
});
test('D3 text is never identity: identical text under different ids stays distinct', async () => {
  const root = tempRoot();
  const a = await makeRun(root, { start: T0, pages: [[status(1, { content: '<p>same text</p>' }), status(2, { content: '<p>same text</p>' })]] });
  const result = build(root, [a]);
  assert.equal(result.manifest.canonicalObservationCount, 2);
});
test('D4 URL is never identity: same URL under different ids stays distinct; same id with a different URL conflicts', async () => {
  const root = tempRoot();
  const a = await makeRun(root, { start: T0, pages: [[status(1, { url: 'https://fixture.example/@a/shared' }), status(2, { url: 'https://fixture.example/@a/shared' })]] });
  assert.equal(build(root, [a]).manifest.canonicalObservationCount, 2);
  const b = await makeRun(root, { start: T0 + 5000, pages: [[status(1, { url: 'https://fixture.example/@a/moved' })]] });
  const c = build(root, [a, b]);
  assert.equal(c.manifest.conflictedUpstreamIdentities, 1);
});
test('D5 mint is never identity: the same mint under different ids stays distinct', async () => {
  const ctx = await standardSnapshot();
  assert.ok(obsOf(ctx).filter(record => record.assetAssociation.mint === MINT).length >= 2);
  assert.equal(new Set(obsOf(ctx).map(record => record.upstreamIdentity)).size, obsOf(ctx).length);
});
test('D6 the upstream identity is exactly the unchanged 5K.1 dedup identity', async () => {
  const ctx = await standardSnapshot();
  for (const record of obsOf(ctx)) {
    assert.equal(record.upstreamIdentity, CORE.dedupIdentity5K1({ provider: record.provider, providerObservationId: record.providerObservationId }));
  }
});

// ===========================================================================
// E. CROSS-RUN DEDUP AND CONFLICTS
// ===========================================================================
test('E1 identical evidence across runs collapses to ONE corpus observation with membership in both', async () => {
  const ctx = await standardSnapshot();
  const thirty = obsOf(ctx).filter(record => record.providerObservationId === '30');
  assert.equal(thirty.length, 1);
  assert.equal(thirty[0].appearanceCount, 2);
  assert.deepEqual(thirty[0].memberRunManifestFingerprints, [ctx.a.manifest.manifestFingerprint, ctx.b.manifest.manifestFingerprint].sort());
  assert.equal(thirty[0].appearances.length, 2);
});
test('E2 duplicate appearances increment with each additional run', async () => {
  const ctx = await standardSnapshot();
  assert.equal(ctx.manifest.duplicateAppearancesAcrossRuns, 2);
  const root = tempRoot();
  const runs = [await makeRun(root, RUN_A), await makeRun(root, RUN_B), await makeRun(root, { start: T0 + 400_000, pages: [[s30(), s29()]] })];
  const three = build(root, runs).manifest;
  assert.equal(three.duplicateAppearancesAcrossRuns, 4);
  assert.equal(obsOf({ dir: build(root, runs).directory }).find(record => record.providerObservationId === '30').appearanceCount, 3);
});
test('E3 the same identity with changed evidence is a CONFLICT, never a canonical observation', async () => {
  const ctx = await standardSnapshot([RUN_C]);
  const conflicts = readNd(file(ctx.dir, 'conflicts.ndjson'));
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].conflictType, 'UPSTREAM_IDENTITY_CONTENT_DIVERGENCE');
  assert.equal(conflicts[0].providerObservationId, '30');
  assert.ok(!obsOf(ctx).some(record => record.providerObservationId === '30'), 'a conflicted identity has no canonical record');
  assert.equal(ctx.manifest.conflictedUpstreamIdentities, 1);
});
test('E4 a conflict records every divergent version and run, and selects no winner', async () => {
  const ctx = await standardSnapshot([RUN_C]);
  const [conflict] = readNd(file(ctx.dir, 'conflicts.ndjson'));
  assert.equal(conflict.conflictingContentFingerprints.length, 2);
  assert.equal(conflict.conflictingRawFingerprints.length, 3);
  assert.deepEqual(conflict.runIds, [ctx.a.runId, ctx.b.runId, ctx.more[0].runId].sort());
  assert.equal(conflict.appearances.length, 3);
  assert.ok(!/winner|selected|chosen|newest|oldest|canonical|resolved/i.test(Object.keys(conflict).join(',')));
  const sorted = [...conflict.appearances].sort((x, y) => (x.fetchedAt - y.fetchedAt));
  assert.equal(canonical(conflict.appearances), canonical(sorted), 'appearances listed in deterministic order, not as a choice');
});
test('E5 even a change in an engagement counter alone is a conflict (no field merging)', async () => {
  const root = tempRoot();
  const a = await makeRun(root, { start: T0, pages: [[status(5)]] });
  const b = await makeRun(root, { start: T0 + 9000, pages: [[status(5, { favourites_count: 99 })]] });
  const result = build(root, [a, b]);
  assert.equal(result.manifest.conflictedUpstreamIdentities, 1);
  assert.equal(result.manifest.canonicalObservationCount, 0);
});
test('E6 evidence content comparison removes ONLY the acquisition context', async () => {
  const ctx = await standardSnapshot();
  const rawA = readNd(file(ctx.a.directory, 'raw-evidence.ndjson'))[0];
  const rawB = readNd(file(ctx.b.directory, 'raw-evidence.ndjson'))[0];
  assert.notEqual(rawA.fetchedAt, rawB.fetchedAt);
  assert.notEqual(rawA.collectionContext.collectionRunId, rawB.collectionContext.collectionRunId);
  assert.equal(INDEX.evidenceContentFingerprint(rawA), INDEX.evidenceContentFingerprint(rawB));
  for (const patch of [{ rawText: 'x' }, { publishedAt: 1 }, { sourceUrl: 'https://z.example/' }, { claimedMint: null }, { providerAuthorId: 'y' }]) {
    assert.notEqual(INDEX.evidenceContentFingerprint({ ...rawA, ...patch }), INDEX.evidenceContentFingerprint(rawA));
  }
  assert.deepEqual([...INDEX.PUBLIC_INTELLIGENCE_5K4_ACQUISITION_FIELDS], ['fetchedAt', 'collectionContext']);
});
test('E7 first/last seen derive from persisted fetchedAt and never from a clock or file time', async () => {
  const ctx = await standardSnapshot();
  const thirty = obsOf(ctx).find(record => record.providerObservationId === '30');
  const fetched = thirty.appearances.map(appearance => appearance.fetchedAt);
  assert.equal(thirty.firstSeenAt, Math.min(...fetched));
  assert.equal(thirty.lastSeenAt, Math.max(...fetched));
  assert.ok(thirty.firstSeenAt < thirty.lastSeenAt);
  const raw = readNd(file(ctx.a.directory, 'raw-evidence.ndjson'))[0];
  assert.equal(thirty.firstSeenAt, raw.fetchedAt);
  const { found } = parseModule(`${PI}/corpus-index.mjs`);
  assert.ok(!found.identifiers.includes('Date') && !found.identifiers.includes('statSync') && !found.identifiers.includes('mtimeMs'));
});
test('E8 appearances carry per-run fingerprints; reference fingerprints are the earliest appearance, selecting no content', async () => {
  const ctx = await standardSnapshot();
  const thirty = obsOf(ctx).find(record => record.providerObservationId === '30');
  assert.equal(thirty.rawObservationFingerprint, thirty.appearances[0].rawObservationFingerprint);
  assert.equal(thirty.normalizedObservationFingerprint, thirty.appearances[0].normalizedObservationFingerprint);
  assert.equal(thirty.provenanceFingerprint, thirty.appearances[0].provenanceFingerprint);
  assert.notEqual(thirty.appearances[0].rawObservationFingerprint, thirty.appearances[1].rawObservationFingerprint);
});

// ===========================================================================
// F. SNAPSHOT
// ===========================================================================
test('F1 snapshotId is deterministic for the same run set and policy', async () => {
  const ctx = await standardSnapshot();
  const again = build(ctx.root, ctx.runs, { createdAt: T0 + 7 });
  assert.equal(again.snapshotId, ctx.id);
  assert.match(ctx.id, /^snap-[0-9a-f]{32}$/);
});
test('F2 run order does not affect snapshotId', async () => {
  const ctx = await standardSnapshot();
  assert.equal(build(ctx.root, [ctx.b, ctx.a]).snapshotId, ctx.id);
  assert.equal(SNAP.deriveSnapshotId(DEFAULT, [ctx.b.manifest.manifestFingerprint, ctx.a.manifest.manifestFingerprint]), SNAP.deriveSnapshotId(DEFAULT, [ctx.a.manifest.manifestFingerprint, ctx.b.manifest.manifestFingerprint]));
});
test('F3 a policy change affects snapshotId', async () => {
  const ctx = await standardSnapshot();
  assert.notEqual(SNAP.deriveSnapshotId(PARTIAL_OK, ctx.runs.map(run => run.manifest.manifestFingerprint)), ctx.id);
  const widened = build(ctx.root, ctx.runs, { policy: PARTIAL_OK });
  assert.notEqual(widened.snapshotId, ctx.id);
  assert.equal(widened.manifest.partialRunCount, 0);
});
test('F4 a run change affects snapshotId', async () => {
  const ctx = await standardSnapshot([RUN_C]);
  assert.notEqual(ctx.id, build(ctx.root, [ctx.a, ctx.b]).snapshotId);
  assert.notEqual(SNAP.deriveSnapshotId(DEFAULT, [ctx.a.manifest.manifestFingerprint]), SNAP.deriveSnapshotId(DEFAULT, [ctx.a.manifest.manifestFingerprint, ctx.b.manifest.manifestFingerprint]));
});
test('F5 createdAt is execution metadata: it never changes snapshotId or content digests, only the fingerprint', async () => {
  const ctx = await standardSnapshot();
  const root2 = tempRoot();
  cpSync(path.join(ctx.root, 'runs'), path.join(root2, 'runs'), { recursive: true });
  const other = SNAP.buildAndStoreSnapshot({ root: root2, runIds: ctx.runs.map(run => run.runId), createdAt: T0 + 9_999_999 });
  assert.equal(other.snapshotId, ctx.id);
  for (const field of ['membershipDigest', 'observationIndexDigest', 'conflictDigest']) assert.equal(other.manifest[field], ctx.manifest[field]);
  assert.notEqual(other.manifest.snapshotFingerprint, ctx.manifest.snapshotFingerprint);
  assert.notEqual(other.manifest.createdAt, ctx.manifest.createdAt);
});
test('F6 snapshotFingerprint covers the complete manifest: a tampered fingerprint or field is rejected', async () => {
  const ctx = await standardSnapshot();
  assert.equal(ctx.manifest.snapshotFingerprint, SNAP.snapshotFingerprintOf(ctx.manifest));
  editManifest(ctx.dir, manifest => { manifest.createdAt += 1; }, false);
  assert.ok(verifyOf(ctx).failures.includes('SNAPSHOT_FINGERPRINT_MISMATCH'));
});
test('F7 the snapshot manifest is a closed schema with every required field', async () => {
  const ctx = await standardSnapshot();
  assert.deepEqual(Object.keys(ctx.manifest).sort(), [...SNAP.PUBLIC_INTELLIGENCE_5K4_SNAPSHOT_SCHEMA.fields].sort());
  refusal(() => SNAP.validateSnapshotManifest({ ...ctx.manifest, extra: 1 }), 'UNKNOWN_FIELD:extra');
  const missing = { ...ctx.manifest }; delete missing.conflictDigest;
  refusal(() => SNAP.validateSnapshotManifest(missing), 'FIELD_MISSING:conflictDigest');
  refusal(() => SNAP.validateSnapshotManifest({ ...ctx.manifest, rawRecordsReferenced: -1 }), 'COUNT_INVALID');
});
test('F8 snapshot count invariants hold exactly and are enforced', async () => {
  const ctx = await standardSnapshot([RUN_C]);
  const m = ctx.manifest;
  assert.equal(m.rawRecordsReferenced, m.canonicalObservationCount + m.duplicateAppearancesAcrossRuns + m.conflictedAppearances);
  assert.equal(m.uniqueUpstreamObservations, m.canonicalObservationCount + m.conflictedUpstreamIdentities);
  assert.equal(m.normalizedRecordsReferenced, m.rawRecordsReferenced);
  assert.deepEqual(SNAP.checkSnapshotCounts(m), []);
  assert.ok(SNAP.checkSnapshotCounts({ ...m, duplicateAppearancesAcrossRuns: m.duplicateAppearancesAcrossRuns + 1 }).includes('COUNT_INVARIANT_RAW_REFERENCED'));
  assert.ok(SNAP.checkSnapshotCounts({ ...m, associatedObservationCount: m.associatedObservationCount + 1 }).includes('COUNT_INVARIANT_ASSOCIATION'));
});
test('F9 a snapshot with no runs or duplicate run ids is refused', async () => {
  const ctx = await standardSnapshot();
  refusal(() => SNAP.buildAndStoreSnapshot({ root: ctx.root, runIds: [], createdAt: T0 }), 'RUN_SET_EMPTY');
  refusal(() => SNAP.buildAndStoreSnapshot({ root: ctx.root, runIds: [ctx.a.runId, ctx.a.runId], createdAt: T0 }), 'DUPLICATE_RUN_ID');
  refusal(() => SNAP.buildAndStoreSnapshot({ root: ctx.root, runIds: [ctx.a.runId], createdAt: 1.5 }), 'CREATED_AT_INVALID');
});
test('F10 a snapshot is all-or-nothing: one ineligible run refuses the whole build and writes nothing', async () => {
  const ctx = await standardSnapshot();
  const limited = await makeRun(ctx.root, { start: T0 + 800_000, fetchImpl: async () => new Response('', { status: 429 }) });
  refusal(() => build(ctx.root, [ctx.a, limited]), 'RUN_NOT_ADMITTED');
  assert.deepEqual(readdirSync(path.join(ctx.root, 'corpora')), [ctx.id]);
});

// ===========================================================================
// G. STORAGE
// ===========================================================================
test('G1 the snapshot directory has the documented layout and no build leftovers', async () => {
  const ctx = await standardSnapshot();
  assert.equal(path.dirname(ctx.dir), path.join(ctx.root, 'corpora'));
  assert.deepEqual(readdirSync(ctx.dir).sort(), ['conflicts.ndjson', 'membership.ndjson', 'observations.ndjson', 'snapshot.json']);
  assert.deepEqual(readdirSync(path.dirname(ctx.dir)).filter(name => name.startsWith('.')), []);
});
test('G2 finalized artifacts are read-only', async () => {
  const ctx = await standardSnapshot();
  for (const name of readdirSync(ctx.dir)) assert.equal(statSync(file(ctx.dir, name)).mode & 0o222, 0, name);
  if (process.getuid?.() !== 0) assert.throws(() => writeFileSync(file(ctx.dir, 'snapshot.json'), 'tamper'));
});
test('G3 building the same snapshot again reports ALREADY_EXISTS_IDENTICAL and overwrites nothing', async () => {
  const ctx = await standardSnapshot();
  const before = hashTree(ctx.dir);
  const again = build(ctx.root, [ctx.b, ctx.a], { createdAt: T0 + 31337 });
  assert.equal(again.outcome, 'ALREADY_EXISTS_IDENTICAL');
  assert.equal(again.manifest.createdAt, ctx.manifest.createdAt);
  assert.deepEqual(hashTree(ctx.dir), before);
  assert.equal(ctx.result.outcome, 'CREATED');
});
test('G4 a stored snapshot that differs from a rebuild is refused, never overwritten', async () => {
  const ctx = await standardSnapshot();
  editNd(file(ctx.dir, 'observations.ndjson'), records => records.slice(1));
  const before = hashTree(ctx.dir);
  refusal(() => build(ctx.root, ctx.runs), 'SNAPSHOT_EXISTS_DIFFERENT');
  assert.deepEqual(hashTree(ctx.dir), before);
});
test('G5 a stale build directory makes a build refuse instead of clobbering', async () => {
  const { root, a, b } = await standardRoot();
  const id = SNAP.deriveSnapshotId(DEFAULT, [a.manifest.manifestFingerprint, b.manifest.manifestFingerprint]);
  mkdirSync(path.join(root, 'corpora', `.building-${id}`), { recursive: true });
  assert.throws(() => build(root, [a, b]), /EEXIST/);
  assert.ok(!existsSync(path.join(root, 'corpora', id)));
});
test('G6 corpus build never modifies any finalized run', async () => {
  const { root, a, b } = await standardRoot();
  const before = { a: hashTree(a.directory), b: hashTree(b.directory) };
  build(root, [a, b]);
  VERIFY.verifySnapshot(root, SNAP.deriveSnapshotId(DEFAULT, [a.manifest.manifestFingerprint, b.manifest.manifestFingerprint]));
  assert.deepEqual({ a: hashTree(a.directory), b: hashTree(b.directory) }, before);
  for (const run of [a, b]) {
    for (const name of ['plan.json', 'manifest.json']) assert.equal(statSync(path.join(run.directory, name)).mode & 0o222, 0);
  }
});
test('G7 only safe runtime roots are accepted for corpus storage', async () => {
  const ctx = await standardSnapshot();
  refusal(() => build(path.join(REPO_ROOT, '.evolve', 'x'), ctx.runs), 'FORBIDDEN');
  refusal(() => build(path.join(tempRoot(), '.evolve', 'y'), ctx.runs), 'FORBIDDEN');
  refusal(() => build(`${tempRoot()}/../../etc`, ctx.runs), 'TRAVERSAL_REFUSED');
  refusal(() => build('relative/dir', ctx.runs), 'MUST_BE_ABSOLUTE');
  refusal(() => build('/etc/evolve', ctx.runs), 'OUTSIDE_ALLOWED_AREAS');
  refusal(() => VERIFY.verifySnapshot('/etc/evolve', ctx.id) && (() => { throw new Error('unreachable'); })(), 'unreachable');
});
test('G8 a symlink cannot smuggle corpus storage out of the allowed areas', async () => {
  const ctx = await standardSnapshot();
  const root = tempRoot();
  symlinkSync('/usr', path.join(root, 'escape'));
  refusal(() => build(path.join(root, 'escape', 'x'), ctx.runs), 'OUTSIDE_ALLOWED_AREAS');
  assert.equal(existsSync('/usr/corpora'), false);
});
test('G9 the validator used temporary fixtures only and created no var/ directory', () => {
  assert.ok(temporary.length > 10);
  for (const root of temporary) assert.ok(root.startsWith(tmpdir()) && !root.startsWith(REPO_ROOT), root);
  assert.ok(!existsSync(path.join(REPO_ROOT, 'var')));
  assert.equal(gitOut('ls-files', 'var').trim(), '');
});

// ===========================================================================
// H. RECONSTRUCTION
// ===========================================================================
test('H1 rebuilding from the same runs reproduces the stored content exactly', async () => {
  const ctx = await standardSnapshot([RUN_C]);
  const content = SNAP.rebuildCorpusSnapshot({ root: ctx.root, runIds: ctx.runs.map(run => run.runId) });
  assert.equal(canonical(content.memberships), canonical(readNd(file(ctx.dir, 'membership.ndjson'))));
  assert.equal(canonical(content.observations), canonical(readNd(file(ctx.dir, 'observations.ndjson'))));
  assert.equal(canonical(content.conflicts), canonical(readNd(file(ctx.dir, 'conflicts.ndjson'))));
  assert.equal(content.observationIndexDigest, ctx.manifest.observationIndexDigest);
});
test('H2 filesystem and request ordering cannot change the result', async () => {
  const one = tempRoot(); const two = tempRoot();
  const a1 = await makeRun(one, RUN_A); const b1 = await makeRun(one, RUN_B); const c1 = await makeRun(one, RUN_C);
  const c2 = await makeRun(two, RUN_C); const b2 = await makeRun(two, RUN_B); const a2 = await makeRun(two, RUN_A);
  const s1 = build(one, [a1, b1, c1]); const s2 = build(two, [c2, a2, b2]);
  assert.equal(s1.snapshotId, s2.snapshotId);
  for (const name of ['membership.ndjson', 'observations.ndjson', 'conflicts.ndjson']) {
    assert.equal(readFileSync(file(s1.directory, name), 'utf8'), readFileSync(file(s2.directory, name), 'utf8'), name);
  }
});
test('H3 a clean second root reproduces identical corpus content from copied runs', async () => {
  const ctx = await standardSnapshot([RUN_C]);
  const clean = tempRoot();
  cpSync(path.join(ctx.root, 'runs'), path.join(clean, 'runs'), { recursive: true });
  const rebuilt = SNAP.buildAndStoreSnapshot({ root: clean, runIds: ctx.runs.map(run => run.runId), createdAt: T0 + 55 });
  assert.equal(rebuilt.snapshotId, ctx.id);
  for (const name of ['membership.ndjson', 'observations.ndjson', 'conflicts.ndjson']) assert.equal(readFileSync(file(rebuilt.directory, name), 'utf8'), readFileSync(file(ctx.dir, name), 'utf8'));
  assert.equal(VERIFY.verifySnapshot(clean, rebuilt.snapshotId).ok, true);
});
test('H4 verification is deterministic', async () => {
  const ctx = await standardSnapshot([RUN_C]);
  assert.equal(canonical(verifyOf(ctx)), canonical(verifyOf(ctx)));
  assert.deepEqual([...verifyOf(ctx).failures], []);
});
test('H5 a missing member run fails verification and rebuild', async () => {
  const ctx = await standardSnapshot();
  rmSync(ctx.b.directory, { recursive: true, force: true });
  assert.ok(hasFailure(verifyOf(ctx), 'RUN_NOT_ADMITTED'));
  refusal(() => SNAP.rebuildCorpusSnapshot({ root: ctx.root, runIds: ctx.runs.map(run => run.runId) }), 'RUN_NOT_ADMITTED');
});
test('H6 a changed member run fails verification', async () => {
  const ctx = await standardSnapshot();
  const target = path.join(ctx.a.directory, 'requests.ndjson');
  writeFileSync(target, readFileSync(target, 'utf8').replace('"httpStatus":200', '"httpStatus":201'));
  assert.equal(verifyOf(ctx).ok, false);
});
test('H7 a replay mismatch inside a member run fails verification', async () => {
  const ctx = await standardSnapshot();
  const target = path.join(ctx.b.directory, 'raw-evidence.ndjson');
  writeFileSync(target, readFileSync(target, 'utf8').replace('post 27', 'post 2X'));
  const result = verifyOf(ctx);
  assert.ok(hasFailure(result, 'RUN_NOT_ADMITTED') && result.failures.join().includes('RAW_EVIDENCE_FINGERPRINT_MISMATCH'));
});

// ===========================================================================
// I. VERIFICATION
// ===========================================================================
test('I0 a clean snapshot verifies', async () => {
  const ctx = await standardSnapshot([RUN_C]);
  assert.deepEqual([...verifyOf(ctx).failures], []);
});
test('I1 a removed membership record fails', async () => {
  const ctx = await standardSnapshot();
  editNd(file(ctx.dir, 'membership.ndjson'), records => records.slice(1));
  assert.ok(hasFailure(verifyOf(ctx), 'MEMBERSHIP_REMOVED'));
});
test('I2 an injected membership record fails (even re-fingerprinted)', async () => {
  const ctx = await standardSnapshot();
  editNd(file(ctx.dir, 'membership.ndjson'), records => [...records, reseal({ ...records[0], runId: `run-${'9'.repeat(32)}` }, 'membershipFingerprint')].sort((x, y) => (x.runId < y.runId ? -1 : 1)));
  assert.ok(hasFailure(verifyOf(ctx), 'MEMBERSHIP_INJECTED'));
});
test('I3 a removed observation fails', async () => {
  const ctx = await standardSnapshot();
  editNd(file(ctx.dir, 'observations.ndjson'), records => records.slice(1));
  assert.ok(hasFailure(verifyOf(ctx), 'OBSERVATION_REMOVED'));
  assert.ok(hasFailure(verifyOf(ctx), 'DIGEST_DRIFT:observationIndexDigest:artifact'));
});
test('I4 an injected observation fails (even re-fingerprinted and with a re-signed manifest)', async () => {
  const ctx = await standardSnapshot();
  editNd(file(ctx.dir, 'observations.ndjson'), records => [...records, reseal({ ...records[0], upstreamIdentity: 'f'.repeat(64) }, 'observationFingerprint')].sort((x, y) => (x.upstreamIdentity < y.upstreamIdentity ? -1 : 1)));
  editManifest(ctx.dir, manifest => { manifest.observationIndexDigest = digest(readNd(file(ctx.dir, 'observations.ndjson'))); });
  assert.ok(hasFailure(verifyOf(ctx), 'OBSERVATION_INJECTED'));
});
test('I5 a modified observation (association, raw fingerprint, normalized fingerprint, membership) fails', async () => {
  for (const mutate of [
    record => ({ ...record, assetAssociation: { ...record.assetAssociation, status: 'EXACT_MINT', mint: MINT_2 } }),
    record => ({ ...record, rawObservationFingerprint: '1'.repeat(64) }),
    record => ({ ...record, normalizedObservationFingerprint: '2'.repeat(64) }),
    record => ({ ...record, memberRunIds: record.memberRunIds.slice(0, 1) }),
    record => ({ ...record, firstSeenAt: record.firstSeenAt - 1 }),
  ]) {
    const ctx = await standardSnapshot();
    editNd(file(ctx.dir, 'observations.ndjson'), records => { records[0] = reseal(mutate(records[0]), 'observationFingerprint'); });
    assert.ok(hasFailure(verifyOf(ctx), 'OBSERVATION_MODIFIED'), JSON.stringify(mutate.toString()).slice(0, 60));
  }
});
test('I6 a modified observation without re-fingerprinting fails its own integrity check', async () => {
  const ctx = await standardSnapshot();
  editNd(file(ctx.dir, 'observations.ndjson'), records => { records[0].appearanceCount += 1; });
  assert.ok(hasFailure(verifyOf(ctx), 'OBSERVATION_RECORD_INVALID'));
});
test('I7 a hidden conflict fails: removing it and re-signing digests and manifest is still caught', async () => {
  const ctx = await standardSnapshot([RUN_C]);
  editNd(file(ctx.dir, 'conflicts.ndjson'), () => []);
  editManifest(ctx.dir, manifest => { manifest.conflictDigest = digest([]); });
  const result = verifyOf(ctx);
  assert.ok(hasFailure(result, 'CONFLICT_SUPPRESSED'));
});
test('I8 an injected conflict fails', async () => {
  const ctx = await standardSnapshot();
  editNd(file(ctx.dir, 'conflicts.ndjson'), () => [reseal({ schemaVersion: '5K.4.0', recordType: 'public_corpus_conflict', conflictType: 'UPSTREAM_IDENTITY_CONTENT_DIVERGENCE', upstreamIdentity: 'a'.repeat(64),
    provider: 'mastodon:fixture.example', providerObservationId: '999', conflictingContentFingerprints: [], conflictingRawFingerprints: [], runIds: [], appearances: [] }, 'conflictFingerprint')]);
  assert.ok(hasFailure(verifyOf(ctx), 'CONFLICT_INJECTED'));
});
test('I9 count drift fails, even when the manifest is re-signed', async () => {
  for (const field of ['uniqueUpstreamObservations', 'duplicateAppearancesAcrossRuns', 'unassociatedObservationCount', 'rawRecordsReferenced', 'membershipCount']) {
    const ctx = await standardSnapshot();
    editManifest(ctx.dir, manifest => { manifest[field] += 1; });
    assert.ok(hasFailure(verifyOf(ctx), `COUNT_DRIFT:${field}`) || hasFailure(verifyOf(ctx), 'COUNT_INVARIANT'), field);
  }
});
test('I10 digest drift fails, even when the manifest is re-signed', async () => {
  for (const field of ['membershipDigest', 'observationIndexDigest', 'conflictDigest']) {
    const ctx = await standardSnapshot();
    editManifest(ctx.dir, manifest => { manifest[field] = 'c'.repeat(64); });
    assert.ok(hasFailure(verifyOf(ctx), `DIGEST_DRIFT:${field}`), field);
  }
});
test('I11 classification widening is caught even when re-signed', async () => {
  const ctx = await standardSnapshot();
  editManifest(ctx.dir, manifest => { manifest.classification.tradingAuthority = true; });
  assert.ok(hasFailure(verifyOf(ctx), 'SNAPSHOT_MANIFEST_INVALID'));
});
test('I12 a swapped run list, snapshot id or policy is caught', async () => {
  const a = await standardSnapshot();
  editManifest(a.dir, manifest => { manifest.runIds = [manifest.runIds[0]]; manifest.runManifestFingerprints = [manifest.runManifestFingerprints[0]]; manifest.membershipCount = 1; });
  assert.ok(hasFailure(verifyOf(a), 'SNAPSHOT_ID_NE_DERIVED'));
  const b = await standardSnapshot();
  editManifest(b.dir, manifest => { manifest.eligibleStatuses = ['COMPLETED', 'PARTIAL']; });
  assert.ok(hasFailure(verifyOf(b), 'SNAPSHOT_ID_NE_DERIVED'));
  const c = await standardSnapshot();
  editManifest(c.dir, manifest => { manifest.eligibleStatuses = ['COMPLETED', 'RATE_LIMITED']; });
  assert.ok(hasFailure(verifyOf(c), 'SNAPSHOT_MANIFEST_INVALID'));
});
test('I13 extra files, missing files and malformed files are reported', async () => {
  const a = await standardSnapshot();
  writeFileSync(file(a.dir, 'notes.txt'), 'x');
  assert.ok(hasFailure(verifyOf(a), 'EXTRA_FILES'));
  const b = await standardSnapshot();
  rmSync(file(b.dir, 'snapshot.json'));
  assert.deepEqual([...verifyOf(b).failures], ['SNAPSHOT_MANIFEST_MISSING']);
  const c = await standardSnapshot();
  chmodSync(file(c.dir, 'observations.ndjson'), 0o644);
  writeFileSync(file(c.dir, 'observations.ndjson'), '{not json\n');
  assert.ok(hasFailure(verifyOf(c), 'LOAD_MALFORMED:observations.ndjson'));
});

// ===========================================================================
// J. COVERAGE
// ===========================================================================
test('J1 run, provider, query and status counts are exact', async () => {
  const ctx = await standardSnapshot();
  const c = ctx.manifest.coverage;
  assert.equal(c.runCount, 2); assert.equal(c.completedRuns, 2); assert.equal(c.partialRuns, 0);
  assert.deepEqual({ ...c.statusCounts }, { COMPLETED: 2 });
  assert.deepEqual({ ...c.queryCounts }, { 'HASHTAG:solana': 2 });
  assert.deepEqual({ ...c.providerCounts }, { [`mastodon:${HOST}`]: { appearances: 6, canonicalObservations: 4, conflictedIdentities: 0, runs: 2 } });
  assert.deepEqual({ ...ctx.manifest.providerCounts }, { ...c.providerCounts });
});
test('J2 unique observation, duplicate appearance, conflict and record counts are exact', async () => {
  const ctx = await standardSnapshot();
  const m = ctx.manifest;
  assert.deepEqual({ unique: m.uniqueUpstreamObservations, canonical: m.canonicalObservationCount, dup: m.duplicateAppearancesAcrossRuns, conflicts: m.conflictedUpstreamIdentities,
    raw: m.rawRecordsReferenced, norm: m.normalizedRecordsReferenced, seen: m.coverage.providerRecordsSeen }, { unique: 4, canonical: 4, dup: 2, conflicts: 0, raw: 6, norm: 6, seen: 6 });
  const withConflict = (await standardSnapshot([RUN_C])).manifest;
  assert.deepEqual({ unique: withConflict.uniqueUpstreamObservations, canonical: withConflict.canonicalObservationCount, dup: withConflict.duplicateAppearancesAcrossRuns,
    conflicts: withConflict.conflictedUpstreamIdentities, confApp: withConflict.conflictedAppearances, raw: withConflict.rawRecordsReferenced },
  { unique: 4, canonical: 3, dup: 1, conflicts: 1, confApp: 3, raw: 7 });
});
test('J3 association-status counts are exact and sum to the canonical observations', async () => {
  const ctx = await standardSnapshot();
  const m = ctx.manifest;
  assert.deepEqual({ exact: m.associatedObservationCount, none: m.unassociatedObservationCount, invalid: m.invalidMintObservationCount, ambiguous: m.ambiguousObservationCount }, { exact: 3, none: 1, invalid: 0, ambiguous: 0 });
  const root = tempRoot();
  const run = await makeRun(root, { pages: [[status(1, { content: `<p>${MINT} and ${MINT_2}</p>` })]] });
  const result = build(root, [run]);
  assert.equal(result.manifest.unassociatedObservationCount, 1, 'two exact mints stay UNASSOCIATED (no claimed mint) per 5K.1/5K.2');
});
test('J4 time coverage is a deterministic function of persisted timestamps, with null when none exist', async () => {
  const ctx = await standardSnapshot();
  const c = ctx.manifest.coverage;
  assert.equal(c.earliestPublishedAt, Date.parse('2026-10-01T10:00:00.000Z'));
  assert.equal(c.latestPublishedAt, c.earliestPublishedAt);
  const rawA = readNd(file(ctx.a.directory, 'raw-evidence.ndjson'));
  const rawB = readNd(file(ctx.b.directory, 'raw-evidence.ndjson'));
  assert.equal(c.earliestFetchedAt, Math.min(...[...rawA, ...rawB].map(raw => raw.fetchedAt)));
  assert.equal(c.latestFetchedAt, Math.max(...[...rawA, ...rawB].map(raw => raw.fetchedAt)));
  const root = tempRoot();
  const run = await makeRun(root, { pages: [[s28()]] });
  const only = build(root, [run]).manifest.coverage;
  assert.equal(only.earliestPublishedAt, null);
  assert.equal(only.latestPublishedAt, null);
});
test('J5 a partial run is counted and visibly marked only under an explicit policy', async () => {
  const { root, a } = await standardRoot();
  const partial = await makeRun(root, { start: T0 + 900_000, pages: [[status(1)], [status(1, { content: '<p>changed</p>' })]] });
  const result = build(root, [a, partial], { policy: PARTIAL_OK });
  assert.equal(result.manifest.coverage.partialRuns, 1);
  assert.equal(result.manifest.partialRunCount, 1);
  assert.deepEqual({ ...result.manifest.statusCounts }, { COMPLETED: 1, PARTIAL: 1 });
  assert.equal(readNd(file(result.directory, 'membership.ndjson')).filter(member => member.partial).length, 1);
  assert.deepEqual([...result.manifest.eligibleStatuses], ['COMPLETED', 'PARTIAL']);
});
test('J6 coverage output contains no interpretation fields', async () => {
  const ctx = await standardSnapshot();
  const keys = JSON.stringify(Object.keys(ctx.manifest.coverage)).toLowerCase();
  for (const word of ['popular', 'important', 'sentiment', 'relevan', 'trend', 'score', 'rank']) assert.ok(!keys.includes(word), word);
});

// ===========================================================================
// K. MISSINGNESS
// ===========================================================================
test('K1 a missing publishedAt stays null in the corpus', async () => {
  const root = tempRoot(); const run = await makeRun(root, { pages: [[s28()]] });
  const [obs] = readNd(file(build(root, [run]).directory, 'observations.ndjson'));
  assert.equal(obs.publishedAt, null);
  assert.notEqual(obs.publishedAt, 0);
  assert.equal(obs.missingness.publishedAt, 'NOT_YET_PUBLISHED');
});
test('K2 missing engagement stays missing: no zero is ever substituted', async () => {
  const root = tempRoot(); const run = await makeRun(root, { pages: [[s28()]] });
  const [obs] = readNd(file(build(root, [run]).directory, 'observations.ndjson'));
  assert.equal(obs.engagement.values, null);
  assert.equal(obs.engagement.zeroFillingApplied, false);
  assert.equal(obs.engagement.status, obs.missingness.engagement);
  assert.ok(!JSON.stringify(obs.engagement).includes(':0'));
});
test('K3 provider-supplied zero engagement stays an observed zero, distinct from missing', async () => {
  const root = tempRoot(); const run = await makeRun(root, { pages: [[status(1, { favourites_count: 0, replies_count: 0, reblogs_count: 0 })]] });
  const [obs] = readNd(file(build(root, [run]).directory, 'observations.ndjson'));
  assert.deepEqual({ ...obs.engagement.values }, { likes: 0, replies: 0, reposts: 0 });
  assert.equal(obs.engagement.providerSupplied, true);
});
test('K4 unassociated observations remain present corpus evidence with a null mint', async () => {
  const ctx = await standardSnapshot();
  const none = obsOf(ctx).filter(record => record.assetAssociation.status === 'UNASSOCIATED');
  assert.equal(none.length, 1);
  assert.equal(none[0].assetAssociation.mint, null);
  assert.equal(none[0].providerObservationId, '29');
});
test('K5 null author and URL are not defaulted anywhere in the corpus index', async () => {
  const root = tempRoot(); const run = await makeRun(root, { pages: [[status(1, { account: undefined, url: null, uri: null })]] });
  const result = build(root, [run]);
  const [obs] = readNd(file(result.directory, 'observations.ndjson'));
  assert.equal(obs.missingness.providerAuthorId, 'NO_OBSERVATION');
  assert.equal(obs.missingness.sourceUrl, 'NO_OBSERVATION');
  const walk = value => { if (value && typeof value === 'object') Object.values(value).forEach(walk); else assert.notEqual(value, undefined); };
  walk(obs);
});

// ===========================================================================
// L. QUERY API
// ===========================================================================
async function openStandard(extra = []) {
  const ctx = await standardSnapshot(extra);
  return { ...ctx, q: QUERY.openVerifiedCorpus(ctx.root, ctx.id) };
}
test('L1 exact upstream lookup', async () => {
  const { q } = await openStandard();
  const identity = CORE.dedupIdentity5K1({ provider: `mastodon:${HOST}`, providerObservationId: '27' });
  assert.equal(q.getObservation(identity).providerObservationId, '27');
  assert.equal(q.getObservation('0'.repeat(64)), null);
  assert.throws(() => q.getObservation(''), /IDENTITY_REQUIRED/);
});
test('L2 exact mint lookup is an exact string match with no inference', async () => {
  const { q } = await openStandard();
  assert.deepEqual(q.listByExactMint(MINT).map(record => record.providerObservationId).sort(), ['27', '30']);
  assert.deepEqual(q.listByExactMint(MINT_2).map(record => record.providerObservationId), ['28']);
  assert.deepEqual([...q.listByExactMint(MINT.toLowerCase())], []);
  assert.deepEqual([...q.listByExactMint('ALPHA')], []);
});
test('L3 provider, unassociated and association-status lookups', async () => {
  const { q } = await openStandard();
  assert.equal(q.listByProvider(`mastodon:${HOST}`).length, 4);
  assert.equal(q.listByProvider('mastodon:other.example').length, 0);
  assert.deepEqual(q.listUnassociated().map(record => record.providerObservationId), ['29']);
  assert.equal(q.listByAssociationStatus('EXACT_MINT').length, 3);
});
test('L4 membership runs lookup', async () => {
  const { q, a, b } = await openStandard();
  const id30 = CORE.dedupIdentity5K1({ provider: `mastodon:${HOST}`, providerObservationId: '30' });
  const id28 = CORE.dedupIdentity5K1({ provider: `mastodon:${HOST}`, providerObservationId: '28' });
  assert.deepEqual([...q.membershipRunsOf(id30)], [a.runId, b.runId].sort());
  assert.deepEqual([...q.membershipRunsOf(id28)], [a.runId]);
  assert.deepEqual([...q.membershipRunsOf('nope')], []);
  assert.equal(q.listMemberships().length, 2);
});
test('L5 conflict lookup', async () => {
  const { q } = await openStandard([RUN_C]);
  const id30 = CORE.dedupIdentity5K1({ provider: `mastodon:${HOST}`, providerObservationId: '30' });
  assert.equal(q.listConflicts().length, 1);
  assert.equal(q.getConflict(id30).conflictType, 'UPSTREAM_IDENTITY_CONTENT_DIVERGENCE');
  assert.equal(q.getObservation(id30), null);
  assert.equal(q.membershipRunsOf(id30).length, 3);
});
test('L6 coverage lookup and manifest access', async () => {
  const { q, manifest } = await openStandard();
  assert.equal(canonical(q.coverage()), canonical(manifest.coverage));
  assert.equal(q.manifest().snapshotId, manifest.snapshotId);
});
test('L7 the query API surface is exactly the declared retrieval set: no ranking, scoring or prediction', async () => {
  const { q } = await openStandard();
  assert.deepEqual(Object.keys(q).sort(), [...QUERY.PUBLIC_INTELLIGENCE_5K4_QUERY_API].sort());
  const banned = /rank|score|sentiment|momentum|recommend|predict|select|best|top|trend|popular|signal|forecast|buy|sell/i;
  for (const name of [...Object.keys(q), ...Object.keys(QUERY)]) assert.ok(!banned.test(name), name);
  const { found } = parseModule(`${PI}/corpus-query.mjs`);
  for (const id of found.identifiers) assert.ok(!banned.test(id) || id === 'requireString' && false, id);
});
test('L8 query results are immutable', async () => {
  const { q } = await openStandard();
  const [first] = q.listObservations();
  assert.throws(() => { first.assetAssociation.mint = 'forged'; });
  assert.throws(() => q.listObservations().push({}));
  assert.ok(Object.isFrozen(q.manifest()));
});
test('L9 a snapshot opens for querying only if it verifies against its runs', async () => {
  const ctx = await standardSnapshot();
  editNd(file(ctx.dir, 'observations.ndjson'), records => records.slice(1));
  refusal(() => QUERY.openVerifiedCorpus(ctx.root, ctx.id), 'SNAPSHOT_NOT_VERIFIED');
});

// ===========================================================================
// M. PRIVACY AND MINT BOUNDARY
// ===========================================================================
const corpusText = ctx => ['membership.ndjson', 'observations.ndjson', 'conflicts.ndjson', 'snapshot.json'].map(name => readFileSync(file(ctx.dir, name), 'utf8')).join('\n');
test('M1 no profile enrichment from provider records reaches the corpus', async () => {
  const ctx = await standardSnapshot([RUN_C]);
  const text = corpusText(ctx);
  for (const personal of ['Alice Real Name', 'private bio', 'alice"', 'display_name', 'followers_count']) assert.ok(!text.includes(personal), personal);
});
test('M2 no credential, cookie or token field names or values appear', async () => {
  let served = 0;
  const fetchImpl = async () => json(served++ ? [] : [s30(), s27()], { 'set-cookie': 'sid=COOKIEVALUE-1', authorization: 'Bearer HEADERVALUE-2' });
  const root = tempRoot(); const run = await makeRun(root, { fetchImpl });
  const result = build(root, [run]);
  const text = readdirSync(result.directory).map(name => readFileSync(file(result.directory, name), 'utf8')).join('\n');
  for (const secret of ['COOKIEVALUE-1', 'HEADERVALUE-2']) assert.ok(!text.includes(secret));
  assert.ok(!/"(cookie|authorization|accessToken|access_token|password|apiKey|privateKey|bearer)/i.test(text));
});
test('M3 no location or address enrichment', async () => {
  const root = tempRoot(); const run = await makeRun(root, { pages: [[status(1, { location: 'Berlin', geo: { lat: 52.5 }, address: '1 Main St' })]] });
  const result = build(root, [run]);
  const text = readdirSync(result.directory).map(name => readFileSync(file(result.directory, name), 'utf8')).join('\n');
  for (const word of ['Berlin', '52.5', 'Main St']) assert.ok(!text.includes(word), word);
});
test('M4 corpus records are structural: every observation key belongs to the closed schema', async () => {
  const ctx = await standardSnapshot([RUN_C]);
  for (const record of obsOf(ctx)) assert.deepEqual(Object.keys(record).sort(), [...INDEX.PUBLIC_INTELLIGENCE_5K4_OBSERVATION_SCHEMA.fields].sort());
  for (const record of readNd(file(ctx.dir, 'conflicts.ndjson'))) assert.deepEqual(Object.keys(record).sort(), [...INDEX.PUBLIC_INTELLIGENCE_5K4_CONFLICT_SCHEMA.fields].sort());
  assert.ok(!Object.keys(obsOf(ctx)[0]).includes('rawText'));
  assert.ok(!corpusText(ctx).includes('post 29'), 'post bodies are referenced by fingerprint, never copied');
});
test('M5 the corpus has zero mint inference authority', async () => {
  for (const unit of OFFLINE_CORPUS.concat(CORPUS_MODULES)) {
    const { found } = parseModule(unit);
    for (const word of ['canonicalMintAddress', 'claimedMint', 'claimedSymbol', 'candidateMintAddresses', 'resolveAssetAssociation', 'tokenRegistry', 'lookupToken', 'levenshtein', 'normalizeObservation5K1']) {
      assert.ok(!found.identifiers.includes(word), `${unit} references ${word}`);
    }
  }
});
test('M6 the corpus never changes UNASSOCIATED to EXACT_MINT and copies association verbatim', async () => {
  const ctx = await standardSnapshot();
  for (const record of obsOf(ctx)) {
    const run = ctx.runs.find(candidate => candidate.runId === record.appearances[0].runId);
    const envelope = readNd(file(run.directory, 'observations.ndjson')).find(item => item.dedupIdentity === record.upstreamIdentity);
    assert.equal(record.assetAssociation.status, envelope.normalized.assetAssociation.status);
    assert.equal(record.assetAssociation.mint, envelope.normalized.assetAssociation.mint);
  }
  editNd(file(ctx.dir, 'observations.ndjson'), records => { const i = records.findIndex(r => r.assetAssociation.status === 'UNASSOCIATED'); records[i] = reseal({ ...records[i], assetAssociation: { status: 'EXACT_MINT', mint: MINT, method: 'EXACT_MINT_ADDRESS' } }, 'observationFingerprint'); });
  assert.ok(hasFailure(verifyOf(ctx), 'OBSERVATION_MODIFIED'));
});

// ===========================================================================
// N. ARCHITECTURAL ISOLATION AND CLI
// ===========================================================================
test('N1 corpus verification and reconstruction are offline: no transport, fetch, timers or network builtin in their closure', () => {
  for (const unit of OFFLINE_CORPUS) {
    for (const entry of importClosure(unit)) {
      assert.ok(!entry.includes('transport'), `${unit} reaches ${entry}`);
      const { found } = parseModule(entry);
      for (const id of ['fetch', 'XMLHttpRequest', 'WebSocket', 'AbortController', 'setTimeout']) assert.ok(!found.identifiers.includes(id), `${entry} references ${id}`);
      for (const source of found.importSources) assert.ok(!NETWORK_BUILTINS.includes(source), `${entry} imports ${source}`);
    }
  }
  const cli = importClosure(`${PI}/corpus-cli.mjs`);
  assert.ok(!cli.some(entry => entry.includes('transport')), 'even the corpus CLI cannot reach the transport');
});
test('N2 no trading, engine, Arena, promotion, champion or R4 module is reachable', () => {
  for (const entry of closureAll) {
    assert.ok(entry.startsWith(`${PI}/`) || entry === 'scripts/market-intelligence/definition.mjs', `unexpected closure member ${entry}`);
    assert.ok(!/(engine|arena|champion|promotion|governance\/r4|r4-|market-outcomes)/.test(entry.replace(`${PI}/`, '')), entry);
  }
});
test('N3 no wallet, signer, swap or RPC-write capability exists in the corpus closure', () => {
  for (const entry of closureAll) {
    const { found } = parseModule(entry);
    for (const source of found.importSources) assert.ok(!WALLET_MODULES.includes(source), `${entry} ${source}`);
    for (const id of [...found.identifiers, ...found.memberObjects]) assert.ok(!SIGNING_OR_RPC_WRITE.includes(id), `${entry} ${id}`);
  }
});
test('N4 among corpus modules, filesystem writes exist only in corpus-snapshot.mjs', () => {
  const writers = /^(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|rm|rmSync|unlinkSync|linkSync|chmodSync|renameSync|cpSync)$/;
  for (const unit of CORPUS_MODULES) {
    const hit = parseModule(unit).found.identifiers.filter(id => writers.test(id));
    if (unit.endsWith('corpus-snapshot.mjs')) assert.ok(hit.length > 0); else assert.deepEqual(hit, [], unit);
  }
});
test('N5 no corpus module writes under .evolve', () => {
  for (const unit of CORPUS_MODULES) for (const literal of parseModule(unit).found.stringLiterals) assert.ok(!literal.includes('.evolve'), `${unit}: ${literal}`);
  assert.equal(existsSync(path.join(REPO_ROOT, '.evolve', 'public-intelligence')), false);
  for (const line of gitOut('status', '--porcelain').split('\n').filter(Boolean)) assert.equal(/^\s*[MADRCU?!]{1,2}\s+\.evolve/.test(line), false);
});
test('N6 the wall clock is read only by the corpus CLI; reconstruction never reads time', () => {
  for (const unit of OFFLINE_CORPUS) {
    const { found } = parseModule(unit);
    assert.ok(!found.identifiers.includes('Date'), `${unit} references Date`);
    assert.ok(!found.identifiers.includes('mtimeMs') && !found.identifiers.includes('statSync') && !found.identifiers.includes('mtime'), `${unit} reads file times`);
  }
  assert.ok(parseModule(`${PI}/corpus-cli.mjs`).found.identifiers.includes('Date'));
});
test('N7 nothing outside scripts/public-intelligence imports a corpus module', () => {
  const listed = gitOut('ls-files', 'scripts', 'src').split('\n').filter(entry => /\.(mjs|ts|tsx|js)$/.test(entry));
  for (const entry of listed) {
    if (entry === 'scripts/validate-phase5k4.mjs' || entry.startsWith(`${PI}/`)) continue;
    assert.ok(!/corpus-(membership|index|snapshot|verify|query|cli)/.test(readFileSync(path.join(REPO_ROOT, entry), 'utf8')), entry);
  }
});
test('N8 the corpus CLI is strict, requires explicit run ids, and is never invoked by the validator', () => {
  const ok = CLI.parseCorpusArgs(['build', '--root', '/tmp/x', '--runs', `run-${'a'.repeat(32)},run-${'b'.repeat(32)}`, '--include-partial']);
  assert.equal(ok.includePartial, true);
  assert.equal(ok.runIds.length, 2);
  for (const argv of [[], ['bogus'], ['build'], ['build', '--runs', 'all'], ['build', '--runs', 'run-xyz'], ['verify'], ['inspect', '--bad', '1'], ['discover', '--root']]) {
    assert.throws(() => CLI.parseCorpusArgs(argv), /CLI_/, JSON.stringify(argv));
  }
  const { source } = parseModule('scripts/validate-phase5k4.mjs');
  assert.equal((source.match(/execFileSync\('node'/g) ?? []).length, 1, 'the only node child process is the phaseCount helper');
  const targets = [...source.matchAll(/phaseCount\('([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(targets, ['scripts/validate-phase5k.mjs', 'scripts/validate-phase5k1.mjs', 'scripts/validate-phase5k2.mjs', 'scripts/validate-phase5k3.mjs']);
  const cli = parseModule(`${PI}/corpus-cli.mjs`);
  assert.ok(/import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/.test(cli.source));
  for (const id of ['setInterval', 'setTimeout', 'fork', 'spawn', 'exec']) assert.ok(!cli.found.identifiers.includes(id), id);
});
test('N9 the validator made zero real network calls', () => assert.equal(tripwireCalls, 0));

// ===========================================================================
// O. REGRESSION
// ===========================================================================
const phaseCount = (script, line) => assert.ok(execFileSync('node', [script], { cwd: REPO_ROOT, encoding: 'utf8' }).includes(line), `${script} did not report ${line}`);
test('O1 5K.0 stays 32/32', () => phaseCount('scripts/validate-phase5k.mjs', 'Phase 5K.0: 32/32 passed'));
test('O2 5K.1 stays 64/64', () => phaseCount('scripts/validate-phase5k1.mjs', 'Phase 5K.1: 64/64 passed'));
test('O3 5K.2 stays 70/70', () => phaseCount('scripts/validate-phase5k2.mjs', 'Phase 5K.2: 70/70 passed'));
test('O4 5K.3 stays 96/96', () => phaseCount('scripts/validate-phase5k3.mjs', 'Phase 5K.3: 96/96 passed'));
test('O5 R4 C1 is an ancestor of HEAD and finalized R4 files are unchanged', () => {
  execFileSync('git', ['merge-base', '--is-ancestor', R4_HEAD, 'HEAD'], { cwd: REPO_ROOT });
  for (const bound of ['governance/r4/r4-preregistration-seal.json', 'package.json', 'package-lock.json']) {
    assert.ok(readFileSync(path.join(REPO_ROOT, bound)).equals(execFileSync('git', ['show', `${R4_HEAD}:${bound}`], { cwd: REPO_ROOT })), bound);
  }
});
test('O6 every earlier phase module, validator and document is unmodified by 5K.4', () => {
  // Any tracked file under scripts/ or docs/ (and .gitignore) that differs from HEAD would show here.
  assert.equal(gitOut('diff', '--name-only', 'HEAD', '--', 'scripts', 'docs', '.gitignore', 'package.json').trim(), '', 'a tracked file was modified');
  const tracked = gitOut('ls-files', PI, 'docs').split('\n').filter(Boolean);
  for (const must of ['definition', 'observation', 'ingest', 'store', 'dedup', 'provenance', 'normalize']) assert.ok(tracked.includes(`${PI}/${must}.mjs`), must);
});
test('O7 the phase document exists and covers every required section and disclaimer', () => {
  const doc = readFileSync(path.join(REPO_ROOT, 'docs/PHASE5K4-CROSS-RUN-CORPUS.md'), 'utf8').toLowerCase();
  for (const heading of ['purpose', 'run eligibility', 'membership', 'cross-run identity', 'dedup', 'conflicts', 'snapshot identity', 'storage', 'verification',
    'reconstruction', 'coverage accounting', 'missingness', 'query api', 'privacy boundary', 'mint boundary', 'non-goals', 'roadmap label',
    'corpus coverage is not sentiment', 'corpus frequency is not importance', 'duplicate appearances are not popularity', 'no trading inference is permitted']) {
    assert.ok(doc.includes(heading), `doc lacks "${heading}"`);
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
  console.log(`Phase 5K.4: ${tests.length - failed}/${tests.length} passed; offline, fixture runs + injected clocks only, ${tripwireCalls} network calls, corpus CLI never invoked`);
  if (failed) process.exitCode = 1;
}
main().catch(error => { console.error('phase 5K.4 validator crashed:', error); process.exitCode = 1; });
