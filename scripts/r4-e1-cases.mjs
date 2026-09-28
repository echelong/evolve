// E1_REFERENCE_LEVEL_MISSINGNESS boundary cases.
//
// Parameterised by an injected API so the production validator and the E1
// mutation harness execute byte-identical assertions against the unmodified and
// the mutated modules respectively. This module builds its own synthetic
// fixtures in temporary directories only; it never reads .evolve evidence and
// never generates a real outcome.
//
// Frozen E1 rule under test:
//   A terminal per-reference revisit failure is a REFERENCE-LEVEL measurement
//   failure, not a session-level capture failure. It stays visible in the
//   authenticated telemetry, it does not remove an otherwise valid D2
//   reference, and it never assigns a scientific outcome missingness category.
//   Only unfinished work (pending after the complete bounded drain) or a broken
//   scheduler invariant keeps the session session-fatal.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { aggregate } from './market-intelligence/aggregate.mjs';
import { observation } from './market-intelligence/normalize.mjs';
import { canonical, digest } from './market-intelligence/definition.mjs';

export const E1_FIXTURE_TIME = 1800000000000;
export const E1_MINT = 'So11111111111111111111111111111111111111112';
export const E1_OTHER_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const mintAt = index => E1_OTHER_MINT.slice(0, 43) + BASE58[index % BASE58.length];

const roots = [];
function tempRoot() { const root = mkdtempSync(path.join(tmpdir(), 'evolve-r4-e1-')); roots.push(root); return root; }

function records(time, price = 2, mint = E1_MINT) {
  return ['jupiter', 'dexscreener'].map(provider => {
    const normalized = { priceUsd: price, providerFixture: provider, liquidityUsd: null, volumes: { m5: null, h1: null },
      transactions: { m5: { buys: null, sells: null } }, priceChanges: { m5: null, h1: null }, pairCreatedAt: time };
    return observation({ provider, endpoint: '/' + provider, mint, payload: { provider, time, price }, normalized, receivedAt: time, staleMs: 60000 });
  });
}
function failedEvent(mint, referenceObservedAt) {
  return { mint, targetAt: referenceObservedAt + 300000, deadlineAt: referenceObservedAt + 360000, result: 'failed',
    failureCode: 'REVISIT_DEADLINE_MISSED', queueDepth: 0, queueLagMs: 60000, coalescedEntryCount: 0 };
}

function rewriteSummary(dir, edit) {
  const file = path.join(dir, 'summary.json');
  const summary = JSON.parse(readFileSync(file, 'utf8'));
  edit(summary);
  const body = canonical(summary) + '\n';
  writeFileSync(file, body);
  const manifestFile = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  manifest.files['summary.json'] = createHash('sha256').update(body).digest('hex');
  manifest.fingerprint = digest(manifest.files);
  writeFileSync(manifestFile, canonical(manifest) + '\n');
}

// Emulates the capture exit: the bounded drain closes every due entry, then the
// frozen gate decides the session reason. The queue is the production queue.
function captureExit({ api, schedules = [], completes = [], interrupt = false }) {
  const queue = api.createRevisitQueue();
  for (const entry of schedules) queue.schedule(entry.mint, entry.observedAt);
  for (const entry of completes) queue.complete(entry.mint, entry.at, true, { requestStartedAt: entry.at, coalescedEntryCount: entry.coalescedEntryCount ?? 1, eligibleUntilAt: entry.at });
  if (!interrupt) queue.expire(E1_FIXTURE_TIME + 400000);
  const gate = api.revisitExitFailure(queue);
  return { queue, gate, reason: gate ? 'capture failed' : interrupt ? 'signal' : 'duration reached' };
}

function sessionFixture({ api, sessionId = 'e1-session', referenceObservedAt = E1_FIXTURE_TIME, endedAt = E1_FIXTURE_TIME + 400000, reason = 'duration reached', revisitEvents = [] }) {
  const root = tempRoot();
  const storage = api.createStorage({ root, sessionId, startedAt: referenceObservedAt });
  const rs = records(referenceObservedAt);
  for (const record of rs) storage.writeObservation(record, { provider: record.provider, time: referenceObservedAt, price: 2 });
  storage.writeSnapshot(aggregate(rs, { observedAt: referenceObservedAt })[0]);
  for (const event of revisitEvents) storage.writeRevisitEvent(event);
  storage.finalize({ endedAt, reason, metrics: { revisitCoverage: { scheduled: revisitEvents.length, completed: 0, failed: revisitEvents.filter(e => e.result === 'failed').length, pending: 0 } } });
  return { dir: storage.dir, role: 'cohort', sessionId, referenceObservedAt };
}

export function e1Cases(api) {
  const { revisitExitFailure, createRevisitQueue, readSourceSession, generateOutcomeRun } = api;
  for (const [name, value] of Object.entries({ revisitExitFailure, createRevisitQueue, readSourceSession, generateOutcomeRun })) {
    if (typeof value !== 'function') throw new Error(`E1_API_INVALID:${name}`);
  }
  const cases = [];
  const test = (name, fn) => cases.push([name, fn]);

  // A — a single terminal reference-level failure with pending = 0 is not session-fatal.
  test('E1 A failed=1 pending=0 keeps the session complete', () => {
    const { queue, gate, reason } = captureExit({ api, schedules: [{ mint: E1_MINT, observedAt: E1_FIXTURE_TIME }] });
    assert.equal(queue.status().failed, 1);
    assert.equal(queue.status().pending, 0);
    assert.equal(gate, null);
    assert.equal(reason, 'duration reached');
    assert.deepEqual(queue.invariants(), []);
    assert.deepEqual(queue.status().failuresByCode, { REVISIT_DEADLINE_MISSED: 1 });
  });

  // B — N terminal reference-level failures with pending = 0 are not session-fatal.
  test('E1 B failed=N pending=0 keeps the session complete', () => {
    const schedules = Array.from({ length: 5 }, (_, i) => ({ mint: i % 2 ? E1_MINT : E1_OTHER_MINT, observedAt: E1_FIXTURE_TIME + i * 1000 }));
    const { queue, gate, reason } = captureExit({ api, schedules });
    assert.equal(queue.status().failed, 5);
    assert.equal(queue.status().pending, 0);
    assert.equal(gate, null);
    assert.equal(reason, 'duration reached');
  });

  // C — one pending entry is session-fatal.
  test('E1 C pending=1 is session-fatal', () => {
    const { queue, gate, reason } = captureExit({ api, schedules: [{ mint: E1_MINT, observedAt: E1_FIXTURE_TIME }], interrupt: true });
    assert.equal(queue.status().pending, 1);
    assert.equal(gate?.message, 'REVISIT_COVERAGE_FAILED');
    assert.equal(reason, 'capture failed');
  });

  // D — many pending entries are session-fatal.
  test('E1 D pending=N is session-fatal', () => {
    const schedules = Array.from({ length: 4 }, (_, i) => ({ mint: mintAt(i), observedAt: E1_FIXTURE_TIME }));
    const { queue, gate, reason } = captureExit({ api, schedules, interrupt: true });
    assert.equal(queue.status().pending, 4);
    assert.equal(gate?.message, 'REVISIT_COVERAGE_FAILED');
    assert.equal(reason, 'capture failed');
  });

  // E — provider unavailable for one reference, lifecycle completes: complete, telemetry preserved.
  test('E1 E provider-unavailable reference completes the session and keeps the failure visible', () => {
    const { queue, gate, reason } = captureExit({ api,
      schedules: [{ mint: E1_MINT, observedAt: E1_FIXTURE_TIME }, { mint: E1_OTHER_MINT, observedAt: E1_FIXTURE_TIME }],
      completes: [{ mint: E1_MINT, at: E1_FIXTURE_TIME + 305000 }] });
    assert.equal(queue.status().completed, 1);
    assert.equal(queue.status().failed, 1);
    assert.equal(queue.status().pending, 0);
    assert.equal(gate, null);
    assert.equal(reason, 'duration reached');
    assert.equal(queue.status().failuresByCode.REVISIT_DEADLINE_MISSED, 1);
    assert.equal(queue.status().failures.at(-1).mint, E1_OTHER_MINT);
  });

  // F — Jupiter mint no longer present is the same reference-level class.
  test('E1 F jupiter-missing reference is a reference-level failure only', () => {
    const queue = createRevisitQueue();
    queue.schedule(E1_MINT, E1_FIXTURE_TIME);
    queue.expire(E1_FIXTURE_TIME + 360001);
    assert.equal(queue.status().failuresByCode.REVISIT_DEADLINE_MISSED, 1);
    assert.equal(revisitExitFailure(queue), null);
  });

  // G — a scheduler invariant violation stays session-fatal.
  test('E1 G scheduler invariant failure is session-fatal', () => {
    const consistent = createRevisitQueue();
    consistent.schedule(E1_MINT, E1_FIXTURE_TIME);
    assert.deepEqual(consistent.invariants(), []);
    assert.equal(revisitExitFailure({ status: () => ({ pending: 0 }), invariants: () => ['REVISIT_LEDGER_INCONSISTENT'] })?.message, 'REVISIT_COVERAGE_FAILED');
    assert.equal(revisitExitFailure({ status: () => ({ pending: 0 }), invariants: () => [] }), null);
  });

  // H — storage bound and a bound-reached summary stay source-ineligible.
  test('E1 H storage-bound session is source-ineligible', () => {
    const failed = sessionFixture({ api, sessionId: 'e1-storage-bound', reason: 'capture failed' });
    assert.throws(() => readSourceSession(failed), /SOURCE_STATUS_INELIGIBLE/);
    const completeButBound = sessionFixture({ api, sessionId: 'e1-bound-reached' });
    rewriteSummary(completeButBound.dir, summary => { summary.storage.sessionBoundReached = true; });
    assert.throws(() => readSourceSession(completeButBound), /SOURCE_STATUS_INELIGIBLE/);
  });

  // I — signal interruption stays source-ineligible.
  test('E1 I signal-interrupted session is source-ineligible', () => {
    const interrupted = sessionFixture({ api, sessionId: 'e1-signal', reason: 'signal' });
    assert.throws(() => readSourceSession(interrupted), /SOURCE_STATUS_INELIGIBLE/);
  });

  // J — crash / unfinalized source stays source-ineligible.
  test('E1 J unfinalized source is rejected', () => {
    const dir = path.join(tempRoot(), 'crashed');
    mkdirSync(dir);
    assert.throws(() => readSourceSession({ dir, role: 'cohort' }), /SOURCE_MANIFEST_MISSING/);
  });

  // K — a completed session carrying reference-level failures passes the frozen R4 source policy.
  test('E1 K complete session with reference-level failures passes the frozen R4 source policy', () => {
    const fixture = sessionFixture({ api, sessionId: 'e1-complete-with-failures', revisitEvents: [failedEvent(E1_MINT, E1_FIXTURE_TIME)] });
    const verified = readSourceSession(fixture);
    assert.equal(verified.sessionId, 'e1-complete-with-failures');
    assert.equal(verified.snapshots.length, 1);
    assert.equal(verified.snapshots[0].validationReason, null, 'the valid reference survives the failed revisit telemetry');
    assert(fixture.dir.startsWith(tmpdir()));
    assert(verified.before['revisit-scheduler.ndjson'], 'failed telemetry remains authenticated in the manifest');
  });

  // L — outcome generation preserves the valid reference and derives missingness from evidence.
  test('E1 L outcome generation preserves the reference and derives the missingness state from evidence', () => {
    const fixture = sessionFixture({ api, sessionId: 'e1-outcome', revisitEvents: [failedEvent(E1_MINT, E1_FIXTURE_TIME)] });
    const verified = readSourceSession(fixture);
    const result = generateOutcomeRun({
      sources: [fixture],
      references: [{ sessionId: verified.sessionId, snapshotDigest: verified.snapshots[0].snapshotDigest }],
      outputRoot: path.join(tempRoot(), 'outcomes'), runId: 'e1-run',
      createdAt: E1_FIXTURE_TIME + 400000, sealedCode: { sha: 'fixture-sha', tree: 'fixture-tree' },
    });
    assert.equal(result.manifest.recordCount, 1);
    const row = result.outcomes[0];
    assert.equal(row.referenceSessionId, 'e1-outcome');
    assert.equal(row.referenceSnapshotDigest, verified.snapshots[0].snapshotDigest);
    assert.equal(row.status, 'unavailable');
    assert.equal(row.missingReason, 'NO_SAME_MINT_OBSERVATION_IN_WINDOW');
    assert.equal(row.absLogReturn300sBps, null);
  });

  // M — reference-level telemetry can never manufacture a price, outcome or missingness code.
  test('E1 M reference-level telemetry cannot manufacture a price, outcome or missingness code', () => {
    const fixture = sessionFixture({ api, sessionId: 'e1-no-manufacture', revisitEvents: [failedEvent(E1_MINT, E1_FIXTURE_TIME)] });
    const verified = readSourceSession(fixture);
    const result = generateOutcomeRun({
      sources: [fixture],
      references: [{ sessionId: verified.sessionId, snapshotDigest: verified.snapshots[0].snapshotDigest }],
      outputRoot: path.join(tempRoot(), 'outcomes'), runId: 'e1-run-m',
      createdAt: E1_FIXTURE_TIME + 400000, sealedCode: { sha: 'fixture-sha', tree: 'fixture-tree' },
    });
    const row = result.outcomes[0];
    const serialized = canonical(row);
    for (const code of ['REVISIT_DEADLINE_MISSED', 'REVISIT_TWO_SOURCE_UNAVAILABLE']) assert(!serialized.includes(code), `telemetry code ${code} must not appear in an outcome row`);
    assert.equal(row.absLogReturn300sBps, null);
    assert.equal(row.futurePriceUsd, undefined);
    assert.equal(row.referencePriceUsd, 2, 'the reference price comes from stored evidence, not telemetry');
  });

  return cases;
}

// Outcome runs are deliberately published read-only (0444 files, 0555 directory),
// so a recursive delete needs the modes relaxed first.
function makeWritable(target) {
  let info;
  try { info = statSync(target); } catch { return; }
  if (info.isDirectory()) {
    try { for (const entry of readdirSync(target)) makeWritable(path.join(target, entry)); } catch { /* unreadable directory */ }
    try { chmodSync(target, 0o755); } catch { /* best effort */ }
  } else { try { chmodSync(target, 0o644); } catch { /* best effort */ } }
}
export function cleanupE1Roots() {
  while (roots.length) { const root = roots.pop(); makeWritable(root); rmSync(root, { recursive: true, force: true }); }
}
