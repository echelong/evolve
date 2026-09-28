#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs, { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync, mkdirSync, chmodSync, statSync, copyFileSync, existsSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { aggregate } from './market-intelligence/aggregate.mjs';
import { observation } from './market-intelligence/normalize.mjs';
import { createStorage } from './market-intelligence/storage.mjs';
import { canonical, digest } from './market-intelligence/definition.mjs';
import { CLASSIFICATION, PRIMARY_HORIZON_MS, resolveReference, snapshotMissingReason, readSourceSession, generateOutcomeRun, verifyOutcomeRun } from './market-outcomes/index.mjs';
import { policyACases } from './market-outcomes/policy-a-cases.mjs';
const tests = [], test = (name, fn) => tests.push([name, fn]);
const roots = [], temp = () => { const r = mkdtempSync(path.join(tmpdir(), 'evolve-outcomes-')); roots.push(r); return r; };
const at = 1800000000000, mint = 'So11111111111111111111111111111111111111112', other = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
function records(time, price = 2, identity = mint) {
  return ['jupiter', 'dexscreener'].map(provider => {
    const normalized = { priceUsd: price, providerFixture: provider, liquidityUsd: null, volumes: { m5: null, h1: null }, transactions: { m5: { buys: null, sells: null } }, priceChanges: { m5: null, h1: null }, pairCreatedAt: time };
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
    const rs = records(t, 2, options.identity ?? mint); for (const r of rs) s.writeObservation(r, { provider: r.provider, time: t, price: 2 });
    s.writeSnapshot(aggregate(rs, { observedAt: t })[0]);
  }
  if (options.revisitEvent) s.writeRevisitEvent(options.revisitEvent);
  s.finalize({ endedAt: times.at(-1), reason: options.reason ?? 'duration reached' });
  return { dir: s.dir, role: options.role ?? 'cohort' };
}
const bytes = dir => Object.fromEntries(readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? Object.entries(bytes(path.join(dir, e.name))).map(([f, b]) => [e.name + '/' + f, b]) : [[e.name, readFileSync(path.join(dir, e.name)).toString('hex')]]));
function withFsHooks(hooks, fn) {
  const original = Object.fromEntries(Object.keys(hooks).map(name => [name, fs[name]]));
  for (const [name, hook] of Object.entries(hooks)) fs[name] = (...values) => hook(original[name], ...values);
  syncBuiltinESMExports();
  try { return fn(); }
  finally { Object.assign(fs, original); syncBuiltinESMExports(); }
}
function assertUnpublished(input) {
  const dir = path.join(input.outputRoot, input.runId);
  assert(!existsSync(path.join(dir, 'manifest.json')));
  if (existsSync(dir)) assert.throws(() => verifyOutcomeRun(dir), /OUTCOME_MANIFEST_MISSING/);
}
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
test('revisit timing telemetry is authenticated but does not change source snapshots', () => {
  const event = { mint, targetAt: at + 300000, deadlineAt: at + 360000, result: 'completed', failureCode: null,
    requestStartedAt: at + 300100, requestReceivedAt: at + 300200, snapshotAt: at + 300300, queueLagMs: 100, queueDepth: 0, coalescedEntryCount: 1 };
  const source = fixture('with-telemetry', [at, at + 300000], { revisitEvent: event });
  const manifest = JSON.parse(readFileSync(path.join(source.dir, 'manifest.json')));
  assert.equal(manifest.files['revisit-scheduler.ndjson'], createHash('sha256').update(readFileSync(path.join(source.dir, 'revisit-scheduler.ndjson'))).digest('hex'));
  assert.equal(readSourceSession(source).snapshots.length, 2);
  rewriteSource(source, 'revisit-scheduler.ndjson', rows => { rows[0].deadlineAt++; });
  assert.throws(() => readSourceSession(source), /SOURCE_REVISIT_TELEMETRY_INVALID/);
});
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
test('indexed identical future snapshots use ascending session ID independent of source order', () => {
  const cohort = fixture('cohort', [at]);
  const z = fixture('z-future', [at + 300000], { role: 'maturation' });
  const a = fixture('a-future', [at + 300000], { role: 'maturation' });
  assert.equal(readSourceSession(a).snapshots[0].snapshotDigest, readSourceSession(z).snapshots[0].snapshotDigest);
  const input = args([cohort, z, a]);
  const first = generateOutcomeRun(input), reversed = generateOutcomeRun({ ...input, sources: [a, z, cohort], outputRoot: temp() });
  assert.equal(first.outcomes[0].futureSessionId, 'a-future');
  assert.deepEqual(bytes(first.dir), bytes(reversed.dir));
});
test('indexed different-digest future ties use digest before session ID independent of source order', () => {
  const cohort = fixture('cohort', [at]);
  const a = fixture('a-future', [at + 300000], { role: 'maturation' });
  const z = fixture('z-future', [at + 300000], { role: 'maturation' });
  rewriteSource(z, 'normalized.ndjson', rows => { for (const row of rows) if (row.recordType === 'intelligence_snapshot') row.extra = 'different digest'; });
  const candidates = [a, z].map(source => readSourceSession(source).snapshots[0]);
  const expected = candidates.sort((x, y) => x.snapshotDigest < y.snapshotDigest ? -1 : 1)[0];
  const input = args([cohort, z, a]);
  const first = generateOutcomeRun(input), reversed = generateOutcomeRun({ ...input, sources: [a, z, cohort], outputRoot: temp() });
  assert.equal(first.outcomes[0].futureSessionId, expected.sessionId);
  assert.equal(first.outcomes[0].futureSnapshotDigest, expected.snapshotDigest);
  assert.deepEqual(bytes(first.dir), bytes(reversed.dir));
});
test('indexed resolution accepts exactly +60000 ms and rejects +60001 ms', () => {
  const cohort = fixture('cohort', [at]);
  const edge = fixture('edge', [at + 360000], { role: 'maturation' });
  const late = fixture('late', [at + 360001], { role: 'maturation' });
  const input = args([cohort, late, edge]);
  const first = generateOutcomeRun(input).outcomes[0];
  assert.equal(first.status, 'resolved'); assert.equal(first.futureSessionId, 'edge'); assert.equal(first.resolutionLagMs, 60000);
  const onlyLate = generateOutcomeRun({ ...input, sources: [cohort, late], outputRoot: temp() }).outcomes[0];
  assert.equal(onlyLate.status, 'unavailable'); assert.equal(onlyLate.futureSessionId, undefined);
});
test('unmatured resolution window rejected', () => { const input = args([fixture()]); input.createdAt = at + 300000; assert.throws(() => generateOutcomeRun(input), /RESOLUTION_WINDOW_NOT_MATURE/); });
test('exact maturation boundary is permitted', () => { const input=args([fixture()]); input.createdAt=at+360000; assert.equal(generateOutcomeRun(input).manifest.recordCount,1); });
test('output-source overlap rejected', () => { const s = fixture(), input = args([s]); input.outputRoot = path.join(s.dir, 'outcomes'); assert.throws(() => generateOutcomeRun(input), /OUTPUT_SOURCE_OVERLAP/); });
test('classification in every output artifact', () => { const result = generateOutcomeRun(args([fixture()])); for (const o of [result.manifest, JSON.parse(readFileSync(path.join(result.dir, 'summary.json'))), ...result.outcomes]) for (const [k, v] of Object.entries(CLASSIFICATION)) assert.equal(o[k], v); });
test('no network dependency or engine/trading authority import', () => { const code = readFileSync('scripts/market-outcomes/index.mjs', 'utf8'); const imports = [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1]); assert.deepEqual(imports, ['node:crypto', 'node:fs', 'node:path', 'node:url', '../market-intelligence/definition.mjs', '../r4-exclusions.mjs']); assert(!/\b(fetch|WebSocket|https?|engine|arena)\s*\(/.test(code)); const original = globalThis.fetch; globalThis.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); }; try { assert.equal(generateOutcomeRun(args([fixture()])).manifest.resolvedCount, 1); } finally { globalThis.fetch = original; } });
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

function rewriteSource(source, file, transform) {
  const target = path.join(source.dir, file), value = file.endsWith('.ndjson') ? readFileSync(target, 'utf8').trimEnd().split('\n').map(JSON.parse) : JSON.parse(readFileSync(target));
  transform(value); const changed = value;
  const body = file.endsWith('.ndjson') ? changed.map(v => canonical(v)).join('\n') + '\n' : canonical(changed) + '\n';
  writeFileSync(target, body);
  const mfile = path.join(source.dir, 'manifest.json'), m = JSON.parse(readFileSync(mfile));
  m.files[file] = createHash('sha256').update(body).digest('hex'); m.fingerprint = digest(m.files); writeFileSync(mfile, canonical(m) + '\n');
}
const evidenceCase = (name, change, code = /SOURCE_PRICE_EVIDENCE_INVALID/) => test(name, () => {
  const source = fixture(); rewriteSource(source, 'normalized.ndjson', rows => { change(rows); });
  assert.throws(() => readSourceSession(source), code);
});
evidenceCase('duplicate matching market observation', rows => { rows.push(structuredClone(rows.find(r => r.recordType === 'market_observation'))); });
evidenceCase('missing matching market observation', rows => { rows.splice(rows.findIndex(r => r.recordType === 'market_observation'), 1); });
for (const [field, value] of [['provider','gmgn'],['sourceEndpoint','/wrong'],['providerObservedAt',at-1],['rawResponseDigest','0'.repeat(64)],['normalizedPayloadDigest','0'.repeat(64)]])
  evidenceCase(`market observation ${field} mismatch`, rows => { rows.find(r => r.recordType === 'market_observation')[field] = value; });
evidenceCase('market observation normalized body digest mismatch', rows => { rows.find(r => r.recordType === 'market_observation').normalized.priceUsd = 9; });
for (const field of ['observedAt','receivedAt','capturedAt']) evidenceCase(`market observation ${field} after snapshot`, rows => { rows.find(r => r.recordType === 'market_observation')[field] = at+1; });
test('future contributor timestamps must reach target independently', () => {
  for (const lag of [0,60000]) assert.equal(resolve([snapshot(at+300000+lag)]).status, 'resolved');
  for (const provider of ['jupiter','dexscreener']) {
    const f = snapshot(at+300000), p = f.disagreement.metrics.contributors.price.find(x => x.provider === provider), src = f.staleness.sourceObservations.find(x => x.provider === provider);
    p.providerObservedAt = src.providerObservedAt = at+299999; src.budgetMs = 1000000; refresh(f);
    assert.deepEqual(resolve([f]).rejectedCandidatesByReason, { PRE_TARGET_PRICE_EVIDENCE: 1 });
  }
});
test('reference evidence cannot be reused as future price', () => {
  for (const key of ['rawResponseDigest','normalizedPayloadDigest']) { const r = snapshot(), f = snapshot(at+300000); f.disagreement.metrics.contributors.price[0][key] = r.disagreement.metrics.contributors.price[0][key]; f.staleness.sourceObservations.find(x=>x.provider===f.disagreement.metrics.contributors.price[0].provider)[key] = r.disagreement.metrics.contributors.price[0][key]; refresh(f); assert.deepEqual(resolve([f],entry(r)).rejectedCandidatesByReason,{REUSED_REFERENCE_PRICE_EVIDENCE:1}); }
});
test('exact freshness and alignment boundaries', () => {
  for (const delta of [0,1]) { const s = snapshot(); const p=s.disagreement.metrics.contributors.price[0], src=s.staleness.sourceObservations.find(x=>x.provider===p.provider); src.providerObservedAt-=60000+delta; p.providerObservedAt-=60000+delta; src.budgetMs=60000; s.disagreement.alignmentMs=s.disagreement.staleness.alignmentMs=70000; refresh(s); assert.equal(snapshotMissingReason(s),delta?'STALE_PRICE_CONTRIBUTOR':null); }
  for (const delta of [0,1]) { const s=snapshot(), p=s.disagreement.metrics.contributors.price[0], src=s.staleness.sourceObservations.find(x=>x.provider===p.provider); src.providerObservedAt-=15000+delta; p.providerObservedAt-=15000+delta; refresh(s); assert.equal(snapshotMissingReason(s),delta?'MISALIGNED_PRICE_CONTRIBUTOR':null); }
});
test('session ID ascending tie after identical timestamp and digest', () => { const s=snapshot(at+300000), a=entry(s,'a'), z=entry(s,'z'); assert.equal(resolveReference(reference(),[z,a]).futureSessionId,'a'); });
for (const value of [-1, Infinity]) test(`reject budget ${value}`, () => { const s=snapshot(); s.staleness.sourceObservations[0].budgetMs=value; if(Number.isFinite(value))refresh(s); assert.equal(snapshotMissingReason(s),'INVALID_SOURCE_BUDGET'); });
test('observation digest required', () => { const s=snapshot(); s.staleness.sourceObservations[0].observationDigest='0'.repeat(64); assert.equal(snapshotMissingReason(s),'INVALID_SOURCE_PROVENANCE'); });
test('disagreement metrics digest required', () => { const s=snapshot(); s.disagreement.normalizedPayloadDigest='0'.repeat(64); assert.equal(snapshotMissingReason(s),'INVALID_PAYLOAD_DIGEST'); });
test('coherent future source timestamps cannot look ahead',()=>{const s=snapshot();for(const k of ['providerObservedAt','receivedAt','capturedAt','observedAt'])s.staleness.sourceObservations[0][k]=at+1;refresh(s);assert.equal(snapshotMissingReason(s),'NO_LOOKAHEAD_VIOLATION');});
test('provider timestamp cannot look ahead', () => { const s=snapshot(); s.staleness.sourceObservations[0].providerObservedAt=at+1; refresh(s); assert.equal(snapshotMissingReason(s),'NO_LOOKAHEAD_VIOLATION'); });
for (const providers of [['dexscreener','gmgn'],['dexscreener','dexscreener'],['Jupiter','dexscreener']]) test(`reject set ${providers.join('+')}`,()=>{ const s=snapshot(); s.disagreement.metrics.contributors.price=providers.map((provider,i)=>({...s.disagreement.metrics.contributors.price[i],provider})); assert.equal(snapshotMissingReason(s),'INVALID_PRICE_CONTRIBUTORS'); });
for (const [label,edit] of [['status',s=>s.status='incomplete'],['reason signal',s=>s.reason='signal'],['reason capture failed',s=>s.reason='capture failed'],['missing storage',s=>delete s.storage],['bound reached',s=>s.storage.sessionBoundReached=true]]) test(`session policy ${label}`,()=>{const source=fixture();rewriteSource(source,'summary.json',edit);assert.throws(()=>readSourceSession(source),/SOURCE_STATUS_INELIGIBLE/);});
test('exclusive create flag is an explicit publication guard',()=>{const code=readFileSync('scripts/market-outcomes/index.mjs','utf8');assert.match(code,/writeFileSync\(file, body, \{ flag: 'wx', mode: 0o444 \}\)/);});
test('final permissions, verifier, and exclusive individual paths',()=>{ const a=args([fixture()]), result=generateOutcomeRun(a); for(const name of ['outcomes.ndjson','summary.json','manifest.json']) assert.equal(statSync(path.join(result.dir,name)).mode&0o777,0o444); assert.equal(statSync(result.dir).mode&0o777,0o555); assert.equal(verifyOutcomeRun(result.dir).fingerprint,result.manifest.fingerprint); assert.throws(()=>generateOutcomeRun(a),/EEXIST/); });
test('partial and malformed runs do not verify',()=>{ const root=temp(), dir=path.join(root,'partial'); mkdirSync(dir); writeFileSync(path.join(dir,'outcomes.ndjson'),'x'); assert.throws(()=>verifyOutcomeRun(dir),/OUTCOME_MANIFEST_MISSING/); writeFileSync(path.join(dir,'summary.json'),'{}');writeFileSync(path.join(dir,'manifest.json'),'{'); assert.throws(()=>verifyOutcomeRun(dir),/SOURCE_FORMAT_INVALID/); });
test('body, manifest and extra-file tampering fail verification',()=>{for(const kind of ['body','manifest','extra']){const r=generateOutcomeRun(args([fixture()]));chmodSync(r.dir,0o755);if(kind==='body'){chmodSync(path.join(r.dir,'summary.json'),0o644);writeFileSync(path.join(r.dir,'summary.json'),'bad');}if(kind==='manifest'){chmodSync(path.join(r.dir,'manifest.json'),0o644);writeFileSync(path.join(r.dir,'manifest.json'),'{}');}if(kind==='extra')writeFileSync(path.join(r.dir,'extra'),'x');assert.throws(()=>verifyOutcomeRun(r.dir));}});
test('resolved row retains rejected candidate audit',()=>{const bad=snapshot(at+300000);bad.disagreement.metrics.priceMedianUsd=0;const o=resolve([bad,snapshot(at+300001)]);assert.deepEqual(o.rejectedCandidatesByReason,{INVALID_PRICE:1});});
test('source coverage gap differs from covered mint absence',()=>{const a=fixture('a',[at]), b=fixture('b',[at+300000,at+360000],{identity:other});let input=args([a]);assert.equal(generateOutcomeRun(input).outcomes[0].missingReason,'SOURCE_COVERAGE_GAP');input=args([a,b]);assert.equal(generateOutcomeRun(input).outcomes[0].missingReason,'NO_SAME_MINT_OBSERVATION_IN_WINDOW');});
test('missing and ambiguous disagreement joins structural',()=>{for(const kind of ['missing','ambiguous']){const s=fixture();rewriteSource(s,'disagreement.ndjson',rows=>{if(kind==='missing')rows.shift();else rows.push({...rows[0], extra:'duplicate'});});assert.throws(()=>readSourceSession(s),kind==='missing'?/MISSING_DISAGREEMENT_JOIN/:/AMBIGUOUS_DISAGREEMENT_JOIN/);}});
test('invalid source policy has stable code',()=>assert.throws(()=>readSourceSession(fixture(),null),/SOURCE_POLICY_INVALID/));
test('unlisted source directory rejected',()=>{const s=fixture();mkdirSync(path.join(s.dir,'empty'));assert.throws(()=>readSourceSession(s),/SOURCE_MANIFEST_FILE_SET_INVALID/);});
test('malformed authenticated source JSON has stable code',()=>{const s=fixture(),file=path.join(s.dir,'summary.json'),mfile=path.join(s.dir,'manifest.json');writeFileSync(file,'{');const m=JSON.parse(readFileSync(mfile));m.files['summary.json']=createHash('sha256').update('{').digest('hex');m.fingerprint=digest(m.files);writeFileSync(mfile,canonical(m)+'\n');assert.throws(()=>readSourceSession(s),/SOURCE_FORMAT_INVALID/);});
test('equal and extreme prices',()=>{assert.equal(resolve([snapshot(at+300000)]).absLogReturn300sBps,0);assert.equal(resolve([snapshot(at+300000,Number.MAX_VALUE/4)],entry(snapshot(at,Number.MIN_VALUE))).missingReason,'NONFINITE_LOG_RETURN');});

test('failure paths leave source trees byte identical',()=>{
  for(const kind of ['bad reference','bad provenance','EEXIST','overlap']){
    const source=fixture(), input=args([source]);
    if(kind==='bad reference')input.references=[{sessionId:'absent',snapshotDigest:'0'.repeat(64)}];
    if(kind==='bad provenance')rewriteSource(source,'normalized.ndjson',rows=>{rows.find(r=>r.recordType==='market_observation').provider='gmgn';});
    if(kind==='EEXIST')mkdirSync(path.join(input.outputRoot,input.runId),{recursive:true});
    if(kind==='overlap')input.outputRoot=path.join(source.dir,'outcomes');
    const before=bytes(source.dir);assert.throws(()=>generateOutcomeRun(input));assert.deepEqual(bytes(source.dir),before);
  }
});
test('primary error survives cleanup source change',()=>{
  const source=fixture(),input=args([source]), file=path.join(source.dir,'summary.json');let changed=false;
  input.references=[{get sessionId(){if(!changed){writeFileSync(file,'mutated');changed=true;}return 'absent';},snapshotDigest:'0'.repeat(64)}];
  let caught;try{generateOutcomeRun(input);}catch(e){caught=e;}
  assert(caught instanceof AggregateError);assert.match(caught.errors[0].message,/REFERENCE_NOT_IN_COHORT/);assert.match(caught.errors[1].message,/SOURCE_CHANGED_AFTER_RESOLUTION/);
});
test('end-of-read source change is rejected before generation', () => {
  const source = fixture(), input = args([source]), normalized = path.join(source.dir, 'normalized.ndjson');
  const disagreement = path.join(source.dir, 'disagreement.ndjson');
  const original = readFileSync(normalized); let armed = false, changed = false;
  const sealedCode = { get sha() { return 'fixture-sha'; }, get tree() { if (changed) writeFileSync(normalized, original); return 'fixture-tree'; } };
  input.sealedCode = sealedCode;
  let fd, opens = 0;
  withFsHooks({
    openSync(real, file, ...rest) { const authenticatedRead = file === disagreement && ++opens === 2; const result = real(file, ...rest); if (authenticatedRead) fd = result; return result; },
    readSync(real, descriptor, ...rest) {
      const n = real(descriptor, ...rest);
      if (descriptor === fd && n === 0 && !armed) { writeFileSync(normalized, Buffer.concat([original, Buffer.from('\n')])); armed = changed = true; }
      return n;
    }
  }, () => assert.throws(() => generateOutcomeRun(input), /SOURCE_CHANGED_DURING_READ/));
  assert(armed); assertUnpublished(input);
});
test('source changed after interpretation fails before body publication', () => {
  const source = fixture(), input = args([source]), file = path.join(source.dir, 'summary.json');
  const original = readFileSync(file); let changed = false;
  input.sealedCode = { get sha() { if (!changed) { writeFileSync(file, Buffer.concat([original, Buffer.from(' ')])); changed = true; } return 'fixture-sha'; }, tree: 'fixture-tree' };
  try { assert.throws(() => generateOutcomeRun(input), /SOURCE_CHANGED_AFTER_RESOLUTION/); }
  finally { writeFileSync(file, original); }
  assert(changed); assertUnpublished(input);
});
test('source changed during output body writes fails before manifest publication', () => {
  const source = fixture(), input = args([source]), file = path.join(source.dir, 'summary.json');
  const original = readFileSync(file); let changed = false;
  try {
    withFsHooks({
      writeFileSync(real, target, ...rest) {
        const result = real(target, ...rest);
        if (target === path.join(input.outputRoot, input.runId, 'outcomes.ndjson')) { real(file, Buffer.concat([original, Buffer.from(' ')])); changed = true; }
        return result;
      },
      renameSync(real, from, to) { if (changed) writeFileSync(file, original); return real(from, to); }
    }, () => assert.throws(() => generateOutcomeRun(input), /SOURCE_CHANGED_AFTER_RESOLUTION/));
  } finally { writeFileSync(file, original); }
  assert(changed); assertUnpublished(input);
});
for (const [kind, file] of [['NDJSON', 'normalized.ndjson'], ['JSON', 'summary.json']]) test(`${kind} source swap during authenticated read fails after restoration`, () => {
  const source = fixture(), input = args([source]), target = path.join(source.dir, file);
  const original = readFileSync(target); let opens = 0, swapped = false, restored = false, fd;
  try {
    withFsHooks({
      openSync(real, opened, ...rest) {
        const authenticatedRead = opened === target && ++opens === 2;
        if (authenticatedRead) { writeFileSync(target, Buffer.concat([original, Buffer.from('\n')])); swapped = true; }
        const result = real(opened, ...rest);
        if (authenticatedRead) fd = result;
        return result;
      },
      readSync(real, descriptor, ...rest) {
        const n = real(descriptor, ...rest);
        if (kind === 'NDJSON' && descriptor === fd && n === 0 && !restored) { writeFileSync(target, original); restored = true; }
        return n;
      },
      readFileSync(real, descriptor, ...rest) {
        const value = real(descriptor, ...rest);
        if (kind === 'JSON' && descriptor === fd && !restored) { writeFileSync(target, original); restored = true; }
        return value;
      }
    }, () => assert.throws(() => generateOutcomeRun(input), /SOURCE_CHANGED_DURING_READ/));
  } finally { writeFileSync(target, original); }
  assert(swapped && restored); assertUnpublished(input);
});
test('protected output root is rejected without writing in mirrored temporary repository', async () => {
  const mirror = temp(), moduleFile = path.join(mirror, 'scripts', 'market-outcomes', 'index.mjs');
  mkdirSync(path.dirname(moduleFile), { recursive: true }); mkdirSync(path.join(mirror, 'scripts', 'market-intelligence'), { recursive: true });
  copyFileSync('scripts/market-outcomes/index.mjs', moduleFile);
  copyFileSync('scripts/market-intelligence/definition.mjs', path.join(mirror, 'scripts', 'market-intelligence', 'definition.mjs'));
  copyFileSync('scripts/r4-exclusions.mjs', path.join(mirror, 'scripts', 'r4-exclusions.mjs'));
  const isolated = await import(pathToFileURL(moduleFile).href);
  const source = fixture(), input = args([source]);
  input.outputRoot = path.join(mirror, '.evolve', 'market-intelligence', 'sessions', 'sibling-outcomes');
  const before = bytes(source.dir);
  assert.throws(() => isolated.generateOutcomeRun(input), /OUTPUT_PROTECTED_ROOT/);
  assert(!existsSync(input.outputRoot)); assert.deepEqual(bytes(source.dir), before);
});
test('FIFO source entry rejected without blocking',()=>{
  const source=fixture(), fifo=path.join(source.dir,'fifo');assert.equal(spawnSync('mkfifo',[fifo]).status,0);assert.throws(()=>readSourceSession(source),/SOURCE_NOT_REGULAR_FILE/);
});
test('pre-existing partial run and output path reject exclusive publication',()=>{
  for(const name of ['outcomes.ndjson','summary.json','manifest.json.tmp']){
    const input=args([fixture()]),dir=path.join(input.outputRoot,input.runId);mkdirSync(dir,{recursive:true});writeFileSync(path.join(dir,name),'reserved');
    assert.throws(()=>generateOutcomeRun(input),/EEXIST/);assert.equal(readFileSync(path.join(dir,name),'utf8'),'reserved');
  }
});
// Frozen P3-C Policy A boundary coverage. The same case module drives the
// mutation harness in scripts/validate-p3c-mutation.mjs, so both executables
// assert byte-identical Policy A behavior.
for (const [name, fn] of policyACases({ resolveReference, snapshotMissingReason })) test(name, fn);

let failed = 0;
try { for (const [name, fn] of tests) { try { await fn(); console.log(`PASS ${name}`); } catch (e) { failed++; console.error(`FAIL ${name}: ${e.stack}`); } } }
finally { for (const root of roots) { assert(root.startsWith(tmpdir() + path.sep)); const walk = p => { chmodSync(p, 0o755); for (const e of readdirSync(p, { withFileTypes: true })) if (e.isDirectory()) walk(path.join(p,e.name)); }; walk(root); rmSync(root, { recursive: true, force: true }); } }
console.log(`Market outcomes: ${tests.length - failed}/${tests.length} passed; synthetic temporary fixtures only`);
if (failed) process.exitCode = 1;
