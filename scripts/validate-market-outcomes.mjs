#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { aggregate } from './market-intelligence/aggregate.mjs';
import { observation } from './market-intelligence/normalize.mjs';
import { createStorage } from './market-intelligence/storage.mjs';
import { canonical, digest } from './market-intelligence/definition.mjs';
import { CLASSIFICATION, PRIMARY_HORIZON_MS, resolveReference, snapshotMissingReason, readSourceSession, generateOutcomeRun } from './market-outcomes/index.mjs';
const tests = [], test = (name, fn) => tests.push([name, fn]);
const roots = [], temp = () => { const r = mkdtempSync(path.join(tmpdir(), 'evolve-outcomes-')); roots.push(r); return r; };
const at = 1800000000000, mint = 'So11111111111111111111111111111111111111112', other = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
function records(time, price = 2, identity = mint) {
  return ['jupiter', 'dexscreener'].map(provider => {
    const normalized = { priceUsd: price, providerFixture: provider, liquidityUsd: null, volumes: { m5: null, h1: null }, transactions: { m5: { buys: null, sells: null } }, priceChanges: { m5: null, h1: null }, pairCreatedAt: null };
    return observation({ provider, endpoint: '/' + provider, mint: identity, payload: { provider, time, price }, normalized, receivedAt: time, staleMs: 60000 });
  });
}
const snapshot = (time = at, price = 2, identity = mint) => aggregate(records(time, price, identity), { observedAt: time })[0];
const entry = (s, sessionId = 'fixture') => ({ snapshot: s, snapshotDigest: digest(s), sessionId, role: 'cohort' });
const reference = () => entry(snapshot());
const resolve = (candidates, r = reference()) => resolveReference(r, candidates.map(s => entry(s)));
function refresh(s) {
  for (const p of s.staleness.sourceObservations) { const primitive = { ...p }; delete primitive.observationDigest; p.observationDigest = digest(primitive); }
  s.disagreement.normalizedPayloadDigest = digest(s.disagreement.metrics);
  s.contributors.crossSourcePriceRangeBps.disagreementDigest = s.disagreement.normalizedPayloadDigest;
  s.normalizedPayloadDigest = digest({ features: s.features, contributors: s.contributors, sourceObservations: s.staleness.sourceObservations });
  return s;
}
function fixture(id = 'fixture', times = [at, at + 300000], options = {}) {
  const s = createStorage({ root: temp(), sessionId: id, startedAt: times[0] });
  for (const t of times) {
    const rs = records(t); for (const r of rs) s.writeObservation(r, { provider: r.provider, time: t, price: 2 });
    s.writeSnapshot(aggregate(rs, { observedAt: t })[0]);
  }
  s.finalize({ endedAt: times.at(-1), reason: options.reason ?? 'duration reached' });
  return { dir: s.dir, role: options.role ?? 'cohort' };
}
const bytes = dir => Object.fromEntries(readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? Object.entries(bytes(path.join(dir, e.name))).map(([f, b]) => [e.name + '/' + f, b]) : [[e.name, readFileSync(path.join(dir, e.name)).toString('hex')]]));
function args(sources) {
  const r = readSourceSession(sources[0]).snapshots[0];
  return { sources, references: [{ sessionId: r.sessionId, snapshotDigest: r.snapshotDigest }], outputRoot: path.join(temp(), 'outcomes'), runId: 'run', createdAt: at + 600000, sealedCode: { sha: 'fixture-sha', tree: 'fixture-tree' } };
}
test('exact frozen 300-second target', () => assert.equal(resolve([]).targetAt, at + PRIMARY_HORIZON_MS));
for (const [lag, status] of [[0, 'resolved'], [60000, 'resolved'], [60001, 'unavailable'], [-1, 'unavailable']]) test(`window boundary ${lag}`, () => assert.equal(resolve([snapshot(at + 300000 + lag)]).status, status));
test('first valid candidate, skipping invalid', () => { const bad = snapshot(at + 300000); bad.disagreement.metrics.contributors.price.pop(); assert.equal(resolve([snapshot(at + 320000), bad, snapshot(at + 310000)]).resolvedAt, at + 310000); });
test('digest tie order independent of input order', () => { const a = snapshot(at + 300000, 3), b = snapshot(at + 300000, 4); const expected = [entry(a), entry(b)].sort((x, y) => x.snapshotDigest < y.snapshotDigest ? -1 : 1)[0]; assert.equal(resolve([a, b]).futureSnapshotDigest, expected.snapshotDigest); assert.deepEqual(resolve([a, b]), resolve([b, a])); });
test('same mint only', () => assert.equal(resolve([snapshot(at + 300000, 2, other)]).missingReason, 'NO_SAME_MINT_OBSERVATION_IN_WINDOW'));
test('exact contributors accepted independently', () => assert.equal(snapshotMissingReason(snapshot()), null));
for (const providers of [['jupiter'], ['dexscreener'], ['jupiter', 'gmgn'], ['jupiter', 'jupiter'], ['jupiter', 'dexscreener', 'gmgn']]) test(`reject contributor set ${providers.join('+')}`, () => {
  for (const future of [false, true]) {
    const s = snapshot(future ? at + 300000 : at); s.disagreement.metrics.contributors.price = providers.map(provider => ({ ...s.disagreement.metrics.contributors.price[0], provider }));
    assert.equal(snapshotMissingReason(s), 'INVALID_PRICE_CONTRIBUTORS');
    assert.equal((future ? resolve([s]) : resolve([], entry(s))).status, 'unavailable');
  }
});
for (const price of [NaN, Infinity, 0, -1]) test(`reject invalid reference and future price ${price}`, () => {
  const s = snapshot(); s.disagreement.metrics.priceMedianUsd = price;
  assert.equal(resolve([], { ...reference(), snapshot: s }).missingReason, 'REFERENCE_INVALID_PRICE');
  s.observedAt = at + 300000; assert.equal(resolveReference(reference(), [{ ...reference(), snapshot: s }]).missingReason, 'NO_VALID_FUTURE_TWO_SOURCE_OBSERVATION');
});
test('known signed log return: 2 to 4', () => assert.equal(resolve([snapshot(at + 300000, 4)]).logReturn300sBps, 6931.471805599453));
test('known absolute log return: 2 to 1', () => { const o = resolve([snapshot(at + 300000, 1)]); assert.equal(o.logReturn300sBps, -6931.471805599453); assert.equal(o.absLogReturn300sBps, 6931.471805599453); assert.equal(o.logReturn300sBpsRole, 'descriptive / provenance only'); });
test('unresolved exact reason and rejected counts', () => { const s = snapshot(at + 300000); s.disagreement.metrics.priceMedianUsd = 0; const o = resolve([s]); assert.equal(o.missingReason, 'NO_VALID_FUTURE_TWO_SOURCE_OBSERVATION'); assert.deepEqual(o.rejectedCandidatesByReason, { INVALID_PRICE: 1 }); assert.equal(o.absLogReturn300sBps, null); });
test('stale budget rejection', () => { const s = snapshot(at + 300000); s.staleness.sourceObservations[0].budgetMs = 0; s.observedAt++; s.disagreement.observedAt++; refresh(s); assert.equal(snapshotMissingReason(s), 'STALE_PRICE_CONTRIBUTOR'); });
test('recorded alignment rejection', () => { const s = snapshot(); const p = s.disagreement.metrics.contributors.price[0], src = s.staleness.sourceObservations.find(v => v.provider === p.provider); src.providerObservedAt -= 15001; p.providerObservedAt -= 15001; refresh(s); assert.equal(snapshotMissingReason(s), 'MISALIGNED_PRICE_CONTRIBUTOR'); });
test('reference contains no future timestamps', () => { const s = snapshot(); s.staleness.sourceObservations[0].receivedAt++; assert.equal(snapshotMissingReason(s), 'NO_LOOKAHEAD_VIOLATION'); });
test('duplicate provider masquerading with shared raw evidence rejected', () => { const s = snapshot(); const p = s.disagreement.metrics.contributors.price; p[1].rawResponseDigest = p[0].rawResponseDigest; s.staleness.sourceObservations.find(v => v.provider === p[1].provider).rawResponseDigest = p[0].rawResponseDigest; refresh(s); assert.equal(snapshotMissingReason(s), 'DUPLICATE_PRICE_EVIDENCE'); });
test('stored median retained without recomputing', () => { const s = snapshot(at + 300000); s.disagreement.metrics.priceMedianUsd = 7; refresh(s); assert.equal(resolve([s]).futurePriceUsd, 7); });
test('valid source manifest and fingerprint', () => { const s = readSourceSession(fixture()); assert.equal(s.snapshots.length, 2); assert.equal(s.fingerprint, digest(JSON.parse(readFileSync(path.join(s.dir, 'manifest.json'))).files)); });
test('tampered source file hash rejected', () => { const s = fixture(); writeFileSync(path.join(s.dir, 'normalized.ndjson'), '\n', { flag: 'a' }); assert.throws(() => readSourceSession(s), /SOURCE_FILE_HASH_MISMATCH/); });
test('tampered manifest fingerprint rejected', () => { const s = fixture(), f = path.join(s.dir, 'manifest.json'), m = JSON.parse(readFileSync(f)); m.fingerprint = '0'.repeat(64); writeFileSync(f, canonical(m)); assert.throws(() => readSourceSession(s), /SOURCE_FINGERPRINT_MISMATCH/); });
test('manifest-listed path traversal rejected', () => { const s = fixture(), f = path.join(s.dir, 'manifest.json'), m = JSON.parse(readFileSync(f)); m.files['../escape'] = 'x'; writeFileSync(f, canonical(m)); assert.throws(() => readSourceSession(s), /SOURCE_MANIFEST_PATH_INVALID/); });
test('source symlink rejected', () => { const s = fixture(); symlinkSync(path.join(s.dir, 'summary.json'), path.join(s.dir, 'link')); assert.throws(() => readSourceSession(s), /SYMLINK_FORBIDDEN/); });
test('explicit duration-complete policy rejects incomplete-duration session', () => { const s = fixture('fixture', [at], { reason: 'complete' }); assert.throws(() => readSourceSession(s), /SOURCE_STATUS_INELIGIBLE/); assert.equal(readSourceSession(s, { requireDurationComplete: false }).sessionId, 'fixture'); });
test('source byte identity and no outcomes in source', () => { const s = fixture(), before = bytes(s.dir); generateOutcomeRun(args([s])); assert.deepEqual(bytes(s.dir), before); assert(!Object.keys(bytes(s.dir)).some(f => f.includes('outcome'))); });
test('output bytes and fingerprint deterministic', () => { const s = fixture(), a = args([s]), first = generateOutcomeRun(a), second = generateOutcomeRun({ ...a, outputRoot: path.join(temp(), 'outcomes') }); assert.deepEqual(bytes(first.dir), bytes(second.dir)); assert.equal(first.manifest.fingerprint, second.manifest.fingerprint); const { fingerprint, ...content } = first.manifest; assert.equal(fingerprint, digest(content)); for (const [f, hash] of Object.entries(first.manifest.files)) assert.equal(createHash('sha256').update(readFileSync(path.join(first.dir, f))).digest('hex'), hash); });
test('exclusive finalized run no overwrite', () => { const a = args([fixture()]), first = generateOutcomeRun(a), before = bytes(first.dir); assert.throws(() => generateOutcomeRun(a), /EEXIST/); assert.deepEqual(bytes(first.dir), before); });
test('cross-session end-of-cohort reference with maturation future', () => { const a = fixture('cohort', [at]), b = fixture('maturation', [at + 300000], { role: 'maturation' }); const input = args([a, b]), o = generateOutcomeRun(input).outcomes[0]; assert.equal(o.referenceSessionId, 'cohort'); assert.equal(o.futureSessionId, 'maturation'); assert.equal(o.resolutionLagMs, 0); input.references = [{ sessionId: 'maturation', snapshotDigest: readSourceSession(b).snapshots[0].snapshotDigest }]; assert.throws(() => generateOutcomeRun(input), /REFERENCE_NOT_IN_COHORT/); });
test('cross-session cohort future and source ordering determinism', () => { const a = fixture('first', [at]), b = fixture('second', [at + 300000]), input = args([a, b]); const first = generateOutcomeRun(input), second = generateOutcomeRun({ ...input, sources: [b, a], outputRoot: temp() }); assert.equal(first.outcomes[0].futureSessionId, 'second'); assert.deepEqual(bytes(first.dir), bytes(second.dir)); });
test('unmatured resolution window rejected', () => { const input = args([fixture()]); input.createdAt = at + 300000; assert.throws(() => generateOutcomeRun(input), /RESOLUTION_WINDOW_NOT_MATURE/); });
test('output-source overlap rejected', () => { const s = fixture(), input = args([s]); input.outputRoot = path.join(s.dir, 'outcomes'); assert.throws(() => generateOutcomeRun(input), /OUTPUT_SOURCE_OVERLAP/); });
test('classification in every output artifact', () => { const result = generateOutcomeRun(args([fixture()])); for (const o of [result.manifest, JSON.parse(readFileSync(path.join(result.dir, 'summary.json'))), ...result.outcomes]) for (const [k, v] of Object.entries(CLASSIFICATION)) assert.equal(o[k], v); });
test('no network dependency or engine/trading authority import', () => { const code = readFileSync('scripts/market-outcomes/index.mjs', 'utf8'); const imports = [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1]); assert.deepEqual(imports, ['node:crypto', 'node:fs', 'node:path', '../market-intelligence/definition.mjs']); assert(!/\b(fetch|WebSocket|https?|engine|arena)\s*\(/.test(code)); const original = globalThis.fetch; globalThis.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); }; try { assert.equal(generateOutcomeRun(args([fixture()])).manifest.resolvedCount, 1); } finally { globalThis.fetch = original; } });
test('explicit future-outcome flag rejected', () => { const s = snapshot(); s.futureOutcomeIncluded = true; assert.equal(snapshotMissingReason(s), 'NO_LOOKAHEAD_VIOLATION'); });
test('malformed contributor rejected', () => { const s = snapshot(); s.disagreement.metrics.contributors.price[0] = null; assert.equal(snapshotMissingReason(s), 'INVALID_PRICE_CONTRIBUTORS'); });
test('future and reference freshness validated independently', () => { const s = snapshot(at + 300000); s.staleness.sourceObservations[0].budgetMs = 0; s.observedAt++; s.disagreement.observedAt++; refresh(s); assert.equal(resolve([s]).status, 'unavailable'); const ref = structuredClone(s); assert.equal(resolve([], entry(ref)).missingReason, 'REFERENCE_STALE_PRICE_CONTRIBUTOR'); });
test('all reference capture timestamps checked', () => { const s = snapshot(); s.capturedAt++; assert.equal(snapshotMissingReason(s), 'NO_LOOKAHEAD_VIOLATION'); });
test('tampered recorded payload digest rejected', () => { const s = snapshot(); s.normalizedPayloadDigest = '0'.repeat(64); assert.equal(snapshotMissingReason(s), 'INVALID_PAYLOAD_DIGEST'); });
test('nonfinite log-return explicitly unavailable', () => { const r = snapshot(at, Number.MIN_VALUE), f = snapshot(at + 300000, Number.MAX_VALUE / 2); assert.equal(resolve([f], entry(r)).missingReason, 'NONFINITE_LOG_RETURN'); });
test('bound-reached and absent storage are ineligible', () => {
  for (const storage of [{ sessionBoundReached: true }, undefined]) {
    const source = fixture(), file = path.join(source.dir, 'summary.json'), summary = JSON.parse(readFileSync(file));
    if (storage) summary.storage = storage; else delete summary.storage;
    const body = canonical(summary) + '\n'; writeFileSync(file, body);
    const manifestFile = path.join(source.dir, 'manifest.json'), manifest = JSON.parse(readFileSync(manifestFile));
    manifest.files['summary.json'] = createHash('sha256').update(body).digest('hex'); manifest.fingerprint = digest(manifest.files); writeFileSync(manifestFile, canonical(manifest));
    assert.throws(() => readSourceSession(source), /SOURCE_STATUS_INELIGIBLE/);
  }
});
test('complete status required', () => { const source = fixture('fixture', [at], { reason: 'capture failed' }); assert.throws(() => readSourceSession(source), /SOURCE_STATUS_INELIGIBLE/); });
test('unlisted evidence rejected', () => { const source = fixture(); writeFileSync(path.join(source.dir, 'extra.json'), '{}'); assert.throws(() => readSourceSession(source), /SOURCE_MANIFEST_FILE_SET_INVALID/); });
test('48-session cohort plus separate maturation session', () => {
  const sources = Array.from({ length: 48 }, (_, i) => fixture(`cohort-${String(i).padStart(2, '0')}`, [at + i * 1800000, at + i * 1800000 + 1500000]));
  const references = sources.map(source => { const verified = readSourceSession(source); return { sessionId: verified.sessionId, snapshotDigest: verified.snapshots[1].snapshotDigest }; });
  sources.push(fixture('post-cohort', [at + 48 * 1800000], { role: 'maturation' }));
  const result = generateOutcomeRun({ sources, references, outputRoot: temp(), runId: '48-plus-one', createdAt: at + 48 * 1800000 + 360000 });
  assert.equal(result.manifest.recordCount, 48); assert.equal(result.manifest.resolvedCount, 48);
  assert.equal(result.outcomes.at(-1).futureSessionId, 'post-cohort');
  assert(result.outcomes.every(o => o.referenceSessionId !== 'post-cohort'));
});
test('disagreement timestamps contain no future information', () => { const s = snapshot(); s.disagreement.staleness.sourceObservedAt.push(at + 1); assert.equal(snapshotMissingReason(s), 'NO_LOOKAHEAD_VIOLATION'); });
let failed = 0;
try { for (const [name, fn] of tests) { try { await fn(); console.log(`PASS ${name}`); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.stack}`); } } }
finally { for (const root of roots) { assert(root.startsWith(tmpdir() + path.sep)); rmSync(root, { recursive: true, force: true }); } }
console.log(`Market outcomes: ${tests.length - failed}/${tests.length} passed; synthetic temporary fixtures only`);
if (failed) process.exitCode = 1;
