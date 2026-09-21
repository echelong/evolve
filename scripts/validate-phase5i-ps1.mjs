#!/usr/bin/env node
/** Offline deterministic forensic validation. Never analyzes the real capture. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

let networkAttempts = 0;
const denyNetwork = () => { networkAttempts++; throw new Error('network forbidden in forensic validation'); };
globalThis.fetch = denyNetwork;
http.request = http.get = https.request = https.get = net.connect = net.createConnection = tls.connect = denyNetwork;
net.Socket.prototype.connect = denyNetwork;
syncBuiltinESMExports();
for (const name of ['JEV_API_KEY', 'TYPESAFE_API_KEY', 'JUPITER_API_KEY']) delete process.env[name];

const { analyzePaperShadowSession } = await import('./jev/paper-forensics/analysis.mjs');
const { loadSourceSession, verifySourceIntegrity, scanForSecrets } = await import('./jev/paper-forensics/source.mjs');
const { analyzeSignal, buildProbabilityHistogram, probabilityBinFor } = await import('./jev/paper-forensics/signal.mjs');
const { analyzeHorizons, scoreProbabilitySamples } = await import('./jev/paper-forensics/horizons.mjs');
const { replayPolicy } = await import('./jev/paper-forensics/counterfactuals.mjs');
const { reconstructEpisodes, decomposeFriction } = await import('./jev/paper-forensics/episodes.mjs');
const { frozenPaperFriction } = await import('./jev/paper-forensics/friction.mjs');
const { snapshotTree, snapshotPreservationTargets, preservationProof } = await import('./jev/paper-forensics/preservation.mjs');
const { ensurePaperForensicsDir } = await import('./jev/paper-forensics/storage.mjs');
const { buildPaperForensicsCliSettings, runPaperForensicsCli, formatForensicsSummary } = await import('./jev/paper-forensics/cli.mjs');
const { PAPER_FORENSICS_POLICY_IDS, PAPER_FORENSICS_FILES, PAPER_FORENSICS_CLASSIFICATION, PAPER_FORENSICS_FORBIDDEN_RESULT_KEYS, assertPaperForensicsWriteTarget } = await import('./jev/paper-forensics/definition.mjs');
const { applyPaperEntry, applyPaperExit, createPaperAccount, markAccount, compactPaperFill } = await import('./jev/paper-shadow/account.mjs');
const { decidePaperAction } = await import('./jev/paper-shadow/policy.mjs');
const { PAPER_SHADOW_CLASSIFICATION, paperShadowUpstreamFor } = await import('./jev/paper-shadow/definition.mjs');
const { paperShadowSummaryDigestOf } = await import('./jev/paper-shadow/storage.mjs');
const { runPaperShadow, buildPaperShadowSummary } = await import('./jev/paper-shadow/runner.mjs');
const { buildDirectionQuestions } = await import('./jev/direction/questions.mjs');

const FORBIDDEN_CAPABILITIES = /\bfetch\s*\(|\bcreateJevProvider\s*\(|\bKeypair\b|\bsendTransaction\s*\(|\bsignTransaction\s*\(/;

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
}
const close = (a, b, eps = 1e-9) => assert.ok(Number.isFinite(a) && Math.abs(a - b) <= eps, `${a} != ${b}`);
const realId = 'jpaper-20260920T154342Z-4734bb';
const preservationBefore = await snapshotPreservationTargets({ sessionId: realId });
const temp = await mkdtemp(path.join(tmpdir(), 'evolve-ps1-fixture-'));
await mkdir('.evolve/jev-paper-forensics', { recursive: true });
const output = await mkdtemp(path.resolve('.evolve/jev-paper-forensics/fixture-validation-'));
const id = 'jpaper-20260101T000000Z-fixture';
const epoch = Date.parse('2026-01-01T00:00:00Z');
const friction = frozenPaperFriction();
const pStream = [0.5, 0.6, 0.4, 0.3, 0.6, 0.7, 0.4, 0.3, null, 0.45, 0.4, 0.4];
function fixture(probabilities = pStream) {
  let account = createPaperAccount({ startingCash: 100 });
  const events = probabilities.map((pHigher, i) => {
    const price = 100 + (i % 4) - i * 0.1;
    const modelIntent = pHigher === null ? null : pHigher >= 0.5 ? 'HIGHER' : 'LOWER';
    const action = decidePaperAction({ hasPosition: account.positionQty > 0, modelIntent, feedOk: true, price }).action;
    let paperFill = null;
    if (action === 'ENTER' || action === 'EXIT') {
      const result = action === 'ENTER' ? applyPaperEntry({ account, price, liquidityUsd: 5e6, friction, positionFraction: 0.25 }) : applyPaperExit({ account, price, liquidityUsd: 5e6, friction });
      assert.equal(result.ok, true);
      account = result.account;
      paperFill = compactPaperFill(result.fill, action === 'ENTER' ? 'BUY' : 'SELL');
    } else account = markAccount(account, { markPrice: price });
    // Match actual runner schema, which does NOT persist realizedGrossPnl.
    const { realizedGrossPnl: omitted, ...snapshot } = account;
    void omitted;
    return { ...snapshot, sequence: i + 1, sessionId: id, observedAt: new Date(epoch + i * 30_000).toISOString(), referencePrice: price, liquidityUsd: 5e6, pHigher, modelIntent, action, paperFill, marketFeedHealth: 'LIVE', status: pHigher === null ? 'JEV_ERROR' : 'JEV_OK', jevCallAttempted: true };
  });
  const session = { ...PAPER_SHADOW_CLASSIFICATION, sessionId: id, status: 'COMPLETE', decisions: events.length, startingCash: 100, positionFraction: 0.25, intentThreshold: 0.5, startedAt: new Date(epoch).toISOString(), provider: 'typesafe-jev', model: 'jev-1.13.0', upstream: null };
  const count = (field, value) => events.filter(e => e[field] === value).length;
  const counters = { decisions: events.length, jevOk: count('status', 'JEV_OK'), jevFailures: count('status', 'JEV_ERROR'), higherCount: count('modelIntent', 'HIGHER'), lowerCount: count('modelIntent', 'LOWER'), enterCount: count('action', 'ENTER'), exitCount: count('action', 'EXIT'), holdCount: count('action', 'HOLD'), cashCount: count('action', 'CASH') };
  const summary = buildPaperShadowSummary({ session, account, counters, status: 'COMPLETE' });
  summary.finalizedAt = new Date(epoch + probabilities.length * 30_000).toISOString();
  summary.summaryDigest = paperShadowSummaryDigestOf(summary);
  summary.updatedAt = new Date(epoch + probabilities.length * 30_000).toISOString();
  return { session, events, summary };
}
const original = fixture();
async function save(data = original, raw = null) {
  const root = path.join(temp, id);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'session.json'), JSON.stringify(data.session));
  await writeFile(path.join(root, 'summary.json'), JSON.stringify(data.summary));
  await writeFile(path.join(root, 'events.ndjson'), raw ?? data.events.map(e => JSON.stringify(e)).join('\n') + '\n');
}
await save();
const loaded = await loadSourceSession({ sessionId: id, sourceRoot: temp });
const integrity = (data = loaded) => verifySourceIntegrity({ ...data, loadProblems: data.problems });
const options = { sessionId: id, sourceRoot: temp, out: output, createdAt: epoch };
let result;
await test('valid source loading and actual runner summary schema', () => assert.equal(integrity().status, 'PASS'));
await test('raw SHA-256 of all three source files', async () => {
  for (const [key, filename] of Object.entries({ session: 'session.json', summary: 'summary.json', events: 'events.ndjson' })) assert.equal(loaded.digests[key], createHash('sha256').update(await readFile(path.join(temp, id, filename))).digest('hex'));
});
for (const [name, change] of [
  ['missing recorded fill', d => d.events[0].paperFill = null],
  ['wrong fill side', d => d.events[0].paperFill.side = 'SELL'],
  ['summary self digest', d => d.summary.summaryDigest = 'tampered'],
  ['sequence gap', d => d.events[2].sequence++],
  ['duplicate sequence', d => d.events[2].sequence = 2],
  ['timestamp regression', d => d.events[2].observedAt = d.events[0].observedAt],
  ['decision summary mismatch', d => d.summary.decisions++],
  ['Jev counts mismatch', d => d.summary.jevFailures++],
  ['intent counts mismatch', d => d.summary.higherCount++],
  ['action counts mismatch', d => d.summary.enterCount++],
  ['ending account mismatch', d => d.summary.endingCash++],
  ['missing ending position value', d => delete d.summary.endingPositionValue],
  ['source id mismatch', d => d.session.sessionId = 'jpaper-wrong'],
  ['event id mismatch', d => d.events[0].sessionId = 'jpaper-wrong'],
  ['incomplete session', d => d.session.status = 'RUNNING'],
  ['canonical source rejected', d => d.session.canonicalEvidence = true],
  ['out of range probability', d => d.events[0].pHigher = 1.1],
  ['nonfinite event', d => d.events[0].cash = Infinity],
  ['nonfinite summary', d => d.summary.endingEquity = NaN],
  ['credentials', d => d.session.secret = 'fixture-not-a-real-secret'],
]) await test(`fail closed: ${name}`, () => { const d = structuredClone(loaded); change(d); assert.equal(integrity(d).status, 'FAIL'); });
await test('malformed NDJSON rejects without writing', async () => {
  await save(original, '{broken\n');
  const bad = await analyzePaperShadowSession(options);
  assert.equal(bad.ok, false); assert.equal(bad.artifactsWritten, false);
  assert.deepEqual(await readdir(output), []);
  await save();
});
await test('required source file missing', async () => {
  await rm(path.join(temp, id, 'summary.json'));
  assert.equal((await analyzePaperShadowSession(options)).ok, false); await save();
});
await test('full fixture analysis writes nine classified artifacts', async () => {
  result = await analyzePaperShadowSession(options);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual((await readdir(result.root)).sort(), Object.values(PAPER_FORENSICS_FILES).sort());
  for (const [key, value] of Object.entries(PAPER_FORENSICS_CLASSIFICATION)) assert.equal(result.manifest[key], value);
  assert.match(result.analysisId, /^jforensic-20260101T000000Z-[a-f0-9]{6}$/);
});
await test('existing analysis cannot be overwritten', async () => assert.rejects(analyzePaperShadowSession(options), /EEXIST/));
await test('probability statistics exclude null and report sample stddev', () => {
  const s = analyzeSignal({ events: [0.4, 0.5, 0.6, null].map(pHigher => ({ pHigher })) });
  assert.equal(s.probabilityCount, 3); close(s.mean, .5); close(s.median, .5); close(s.stddev, .1); close(s.min, .4); close(s.max, .6); assert.equal(s.pHigherEqualsHalfCount, 1);
});
await test('frozen histogram endpoints and full precision membership', () => {
  const h = buildProbabilityHistogram([.39, .4, .43, .45, .47, .49, .5, .50000001, .52, .55]);
  assert.equal(h.bins.length, 10); assert.deepEqual(h.bins.map(b => b.count), Array(10).fill(1)); assert.equal(probabilityBinFor(null), null);
});
await test('null breaks consecutive signal runs and boundary crossings', () => {
  const s = analyzeSignal({ events: [.6, null, .6, .4].map(pHigher => ({ pHigher, modelIntent: pHigher === null ? null : pHigher >= .5 ? 'HIGHER' : 'LOWER' })) });
  assert.deepEqual(s.consecutiveHigherRuns.lengths, [1, 1]); assert.equal(s.intentFlips, 1); assert.equal(s.boundaryCrossings, 1);
});
const horizonEvents = [0, 20, 45, 75, 400].map((s, i) => ({ sequence: i + 1, observedAt: new Date(epoch + s * 1000).toISOString(), referencePrice: [100, 200, 110, 90, 100][i], pHigher: .6, modelIntent: 'HIGHER' }));
await test('horizon first event at/after target, no interpolation', () => {
  const h = analyzeHorizons({ events: horizonEvents });
  assert.deepEqual(h.horizonsSeconds, [30, 60, 90, 120, 300]);
  assert.equal(h.decisions[0].horizons['30'].futureSequence, 3);
  assert.equal(h.decisions[0].horizons['30'].actualHorizonMs, 45000);
  close(h.decisions[0].horizons['30'].forwardReturn, .1);
  assert.equal(h.decisions[0].horizons['60'].futureSequence, 4);
  assert.equal(h.decisions.at(-1).horizons['30'].available, false);
});
await test('missing first horizon price stays unavailable, never skips ahead', () => {
  const events = structuredClone(horizonEvents); events[2].referencePrice = null;
  assert.equal(analyzeHorizons({ events }).decisions[0].horizons['30'].available, false);
});
await test('Brier known value', () => close(scoreProbabilitySamples([{ pHigher: .8, actualOutcome: 'HIGHER' }, { pHigher: .2, actualOutcome: 'LOWER' }]).brierScore, .04));
await test('log loss known value and finite clipping', () => {
  close(scoreProbabilitySamples([{ pHigher: .8, actualOutcome: 'HIGHER' }]).logLoss, -Math.log(.8));
  assert.ok(Number.isFinite(scoreProbabilitySamples([{ pHigher: 0, actualOutcome: 'HIGHER' }]).logLoss));
});
await test('TIE explicit, scored as not HIGHER and direction not correct', () => {
  const row = analyzeHorizons({ events: horizonEvents }).decisions[0].horizons['300'];
  assert.equal(row.actualOutcome, 'TIE'); assert.equal(row.correctDirection, false);
  close(scoreProbabilitySamples([{ pHigher: .6, actualOutcome: 'TIE' }]).brierScore, .36);
});
await test('probability bucket diagnostics frozen and descriptive', () => {
  assert.equal(result.horizons.probabilityBuckets.buckets.length, 10);
  assert.equal(result.horizons.probabilityBuckets.thresholdDerivationPermitted, false);
});
await test('episode reconstruction uses real event schema and accounting identity', () => {
  const episodes = reconstructEpisodes(original);
  assert.equal(episodes.length, 2);
  assert.equal(episodes[0].entrySequence, 1); assert.equal(episodes[0].exitSequence, 3);
  assert.equal(episodes[0].holdingMs, 60000); assert.equal(episodes[0].decisionsHeld, 2);
  for (const e of episodes) { close(e.grossPnl - e.totalCosts, e.netPnl); close(e.priceOnlyGrossPnl, e.grossPnl); }
});
await test('friction decomposition fees, execution costs and bankroll ratios', () => {
  const d = decomposeFriction({ ...original, episodes: reconstructEpisodes(original) });
  close(d.totalGrossPnl - d.totalSimulatedCosts, d.totalNetPnl);
  close(d.fees + d.executionSlippageAdverseCost, d.totalSimulatedCosts);
  close(d.costOverStartingBankroll, d.totalSimulatedCosts / 100);
  assert.equal(d.disagreementWithSourceAccounting, false);
  assert.equal(d.observedBreakEvenMovement.notARecommendedThreshold, true);
});
await test('open episode is not fabricated into a round trip; mark and costs retained', () => {
  const f = fixture([.6, .6]); const es = reconstructEpisodes(f); const d = decomposeFriction({ ...f, episodes: es });
  assert.equal(es[0].status, 'OPEN_AT_SESSION_END'); assert.equal(d.closedRoundTrips, 0);
  close(d.totalGrossPnl - d.totalSimulatedCosts, d.totalNetPnl); assert.ok(d.totalSimulatedCosts > 0);
});
await test('complete no-fill capture analyzes without inventing friction observations', async () => {
  await save(fixture([.4, .4]));
  const r = await analyzePaperShadowSession({ ...options, write: false });
  assert.equal(r.ok, true); assert.equal(r.summary.roundTrips, 0); assert.equal(r.summary.costs, 0); await save();
});
await test('complete capture with open position has complete episode mapping', async () => {
  await save(fixture([.6, .6]));
  const r = await analyzePaperShadowSession({ ...options, write: false });
  assert.equal(r.ok, true); assert.equal(r.episodes.mappingComplete, true); await save();
});
const replay = (policyId, events = original.events) => replayPolicy({ policyId, events, friction, positionFraction: .25, startingCash: 100 });
await test('RECORDED_BINARY reproduces every action and account', () => assert.equal(result.counterfactuals.replayIntegrity.ok, true));
await test('NO_TRADE stays cash', () => { const r = replay('NO_TRADE'); assert.equal(r.entries, 0); assert.equal(r.endingCash, 100); assert.equal(r.costs, 0); assert.equal(r.timeInMarketMs, 0); });
const short = fixture([.6, .6, .4, .4, .4]).events;
for (const [policy, expected] of [
  ['TWO_SIGNAL_CONFIRMATION', ['CASH', 'ENTER', 'HOLD', 'EXIT', 'CASH']],
  ['MIN_HOLD_60S', ['ENTER', 'HOLD', 'EXIT', 'CASH', 'CASH']],
  ['TWO_SIGNAL_PLUS_60S', ['CASH', 'ENTER', 'HOLD', 'EXIT', 'CASH']],
]) await test(`${policy} exact chronological actions`, () => assert.deepEqual(replay(policy, short).actions.map(a => a.action), expected));
await test('minimum hold blocks a LOWER before 60 seconds', () => {
  const e = fixture([.6, .4, .4]).events;
  assert.deepEqual(replay('MIN_HOLD_60S', e).actions.map(a => a.action), ['ENTER', 'HOLD', 'EXIT']);
});
await test('combined policy requires both confirmation and elapsed hold time', () => {
  const events = fixture([.6, .6, .4, .4, .4, .4, .4, .4]).events;
  events.forEach((event, index) => { event.observedAt = new Date(epoch + index * 10000).toISOString(); });
  assert.deepEqual(replay('TWO_SIGNAL_PLUS_60S', events).actions.map(a => a.action), ['CASH', 'ENTER', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD', 'EXIT']);
});
for (const policy of PAPER_FORENSICS_POLICY_IDS) await test(`no lookahead prefix/suffix invariance: ${policy}`, () => {
  for (let cut = 1; cut < original.events.length; cut++) {
    const altered = structuredClone(original.events);
    for (let i = cut; i < altered.length; i++) { altered[i].pHigher = .99; altered[i].referencePrice *= 4; altered[i].paperFill = null; }
    assert.deepEqual(replay(policy, original.events.slice(0, cut)).actions, replay(policy).actions.slice(0, cut));
    assert.deepEqual(replay(policy, altered).actions.slice(0, cut), replay(policy).actions.slice(0, cut));
  }
});
await test('material intermediate account tampering fails closed', async () => {
  const bad = structuredClone(original); bad.events[1].cash += .01; await save(bad);
  const r = await analyzePaperShadowSession({ ...options, write: false }); assert.equal(r.ok, false); assert.equal(r.reason, 'recorded_replay_integrity_failed'); await save();
});
await test('unsupported captured friction fails closed rather than fitting', async () => {
  const bad = structuredClone(original); bad.events[0].paperFill.executedPrice += 1; await save(bad);
  assert.equal((await analyzePaperShadowSession({ ...options, write: false })).ok, false); await save();
});
await test('no automatic ranking/winner/threshold search in results', () => {
  assert.deepEqual(result.counterfactuals.policyIds, ['NO_TRADE', 'RECORDED_BINARY', 'TWO_SIGNAL_CONFIRMATION', 'MIN_HOLD_60S', 'TWO_SIGNAL_PLUS_60S']);
  const walk = value => { if (!value || typeof value !== 'object') return; for (const [key, child] of Object.entries(value)) { assert.ok(!PAPER_FORENSICS_FORBIDDEN_RESULT_KEYS.includes(key.toLowerCase()), key); walk(child); } };
  walk(result.summary); walk(result.counterfactuals); assert.throws(() => replay('GENERATED_POLICY'));
});
await test('CLI requires explicit session, rejects latest and unknown search flags', () => {
  for (const args of [[], ['--latest'], ['--session', id, '--latest'], ['--session', id, '--threshold', '.6']]) assert.ok(buildPaperForensicsCliSettings(args).problems.length);
});
await test('keyless CLI JSON and human summary using fixture', async () => {
  const logs = []; const code = await runPaperForensicsCli(['--session', id, '--json'], { log: s => logs.push(s), analyze: async () => result });
  assert.equal(code, 0); assert.equal(JSON.parse(logs[0]).integrity, 'PASS');
  assert.match(formatForensicsSummary(result), /NO WINNER \/ NO PARAMETER SELECTION/);
});
await test('all outputs use counterfactual disclaimers', () => {
  for (const p of result.counterfactuals.policies) assert.deepEqual(p.banner, result.counterfactuals.banner);
});
await test('write isolation rejects source/canonical/arbitrary paths', () => {
  for (const target of [path.join(temp, 'bad'), '.evolve/jev-direction/bad', '.evolve/jev-paper-shadow/bad']) assert.throws(() => assertPaperForensicsWriteTarget(target, target));
});
await test('symlink cannot redirect forensic writes', async () => {
  const link = path.join(output, 'linked'); await symlink(temp, link);
  await assert.rejects(ensurePaperForensicsDir(path.join(link, 'jforensic-test'), output), /symlink/);
});
await test('source fixture bytes preserved after successful analysis', async () => {
  const after = await loadSourceSession({ sessionId: id, sourceRoot: temp }); assert.deepEqual(after.digests, loaded.digests);
});
await test('digest audit confirms intentional shared canonical object', () => {
  assert.equal(result.digestAudit.conclusion, 'INTENTIONAL_SHARED_CANONICAL_OBJECT');
  assert.equal(result.digestAudit.dynamicEquality.equalForSameObject, true);
  assert.equal(result.digestAudit.dynamicEquality.sensitiveToContent, true);
  assert.equal(result.digestAudit.fixApplied, false);
});
await test('upstream registry direct identity and future runner persistence', async () => {
  assert.equal(paperShadowUpstreamFor('typesafe-jev'), 'typesafe-ai');
  let now = epoch;
  const sessionId = 'jpaper-upstream-fixture';
  await runPaperShadow({
    settings: { sessionId, startingCash: 100, positionFraction: .25, intentThreshold: .5, durationMs: 30000, cadenceMs: 30000, durationMinutes: .5 },
    provider: { name: 'typesafe-jev', model: 'jev-1.13.0', evaluate: denyNetwork },
    source: { observeState: async () => ({ ok: false, reason: 'fixture missing feed', health: { degraded: true } }) },
    questions: buildDirectionQuestions(), friction, baseRoot: temp,
    now: () => now, sleep: async ms => { now += ms; },
  });
  const session = JSON.parse(await readFile(path.join(temp, sessionId, 'session.json'), 'utf8'));
  const summary = JSON.parse(await readFile(path.join(temp, sessionId, 'summary.json'), 'utf8'));
  assert.equal(session.upstream, 'typesafe-ai'); assert.equal(summary.upstream, 'typesafe-ai');
});
await test('analyzer dependency graph has no providers/network/wallet/signing/RPC writes', async () => {
  const visited = new Set();
  async function walk(file) {
    file = path.resolve(file); if (visited.has(file)) return; visited.add(file);
    const source = await readFile(file, 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, FORBIDDEN_CAPABILITIES, file);
    for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g)) {
      const spec = match[1];
      assert.doesNotMatch(spec, /providers\/|node:(?:http|https|net|tls)|@solana|typesafe-sdk/);
      if (spec.startsWith('.')) await walk(path.resolve(path.dirname(file), spec));
      else assert.ok(spec.startsWith('node:'), spec);
    }
  }
  await walk('scripts/jev-paper-forensics.mjs');
  assert.ok(visited.has(path.resolve('scripts/engine/paper.mjs')), 'must directly reuse engine');
});
await test('zero network calls and no API key requirement', () => assert.equal(networkAttempts, 0));
const after = await snapshotPreservationTargets({ sessionId: realId });
const proof = preservationProof({ before: preservationBefore, after });
await test('real Paper Shadow entire tree byte preservation (hash only, no analysis)', () => assert.equal(proof.sourceSession.identical, true));
await test('full canonical 5I tree byte preservation', () => assert.equal(proof.canonicalTree.identical, true));
await test('named replication and temporal artifacts preserved', () => {
  for (const entry of proof.sealedSessions) { assert.equal(entry.unchanged, true); if (preservationBefore.canonical.exists) assert.equal(entry.present, true); }
});
await test('binary byte hash preservation includes non-UTF8 bytes', async () => {
  const binary = path.join(temp, 'binary'); await mkdir(binary); await writeFile(path.join(binary, 'data'), Buffer.from([255, 254]));
  const a = await snapshotTree(binary); await writeFile(path.join(binary, 'data'), Buffer.from([254, 255]));
  const b = await snapshotTree(binary); assert.notEqual(a.entries[0].digest, b.entries[0].digest);
});
await test('credential scanner traverses nested values', () => assert.ok(scanForSecrets({ nested: { authorization: 'fixture' } }).length));
await rm(temp, { recursive: true, force: true });
await rm(output, { recursive: true, force: true });
console.log(`\nPhase 5I-PS.1: ${passed} passed, ${failed} failed`);
console.log(JSON.stringify(proof, null, 2));
process.exitCode = failed ? 1 : 0;
