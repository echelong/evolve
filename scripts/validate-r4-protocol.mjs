#!/usr/bin/env node
// R4 protocol validator: ALL_ELIGIBLE_REFERENCES builder, Kendall tau-b +
// mint-cluster bootstrap primary analysis, and the deterministic cohort plan.
//
// Synthetic temporary fixtures only. No .evolve evidence is read, no live
// capture is started and no real R4 outcome is generated.
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { aggregate } from './market-intelligence/aggregate.mjs';
import { observation } from './market-intelligence/normalize.mjs';
import { createStorage } from './market-intelligence/storage.mjs';
import { readSourceSession, generateOutcomeRun } from './market-outcomes/index.mjs';
import { selectAllEligibleReferences, collectAllEligibleReferences } from './market-outcomes/reference-selection.mjs';
import { kendallTauB, splitmix64, randomBelow, deriveAnalysisSeed, clusterBootstrap, percentileType7, assembleAnalysisRows,
  runPrimaryAnalysis, BOOTSTRAP_REPLICATES, MIN_RESOLVED_REFERENCES, MIN_RESOLVED_MINTS, PRIMARY_ANALYSIS_SPEC_VERSION,
  PRIMARY_EXPOSURE_FIELD, PRIMARY_OUTCOME_FIELD, PRIMARY_ESTIMAND, CLUSTER_KEY } from './market-outcomes/primary-analysis.mjs';
import { R4_COHORT_SPEC, R4_B1_RULE, buildCohortPlan, mechanicalT0, evaluateCohortProgress, sessionParameters } from './r4-cohort-plan.mjs';

const T = 1800000000000;
const MINT = 'So11111111111111111111111111111111111111112';
const SEAL = 'a'.repeat(64);
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const roots = [];
const tempRoot = () => { const root = mkdtempSync(path.join(tmpdir(), 'evolve-r4-protocol-')); roots.push(root); return root; };

function records(time, price = 2, mint = MINT) {
  return ['jupiter', 'dexscreener'].map(provider => {
    const normalized = { priceUsd: price, providerFixture: provider, liquidityUsd: null, volumes: { m5: null, h1: null },
      transactions: { m5: { buys: null, sells: null } }, priceChanges: { m5: null, h1: null }, pairCreatedAt: time };
    return observation({ provider, endpoint: '/' + provider, mint, payload: { provider, time, price }, normalized, receivedAt: time, staleMs: 60000 });
  });
}
function buildSession({ sessionId, times = [[T, 2]], reason = 'duration reached', endedAt = null }) {
  const root = tempRoot();
  const storage = createStorage({ root, sessionId, startedAt: times[0][0] });
  for (const [time, price] of times) {
    const rs = records(time, price);
    for (const record of rs) storage.writeObservation(record, { provider: record.provider, time, price });
    storage.writeSnapshot(aggregate(rs, { observedAt: time })[0]);
  }
  storage.finalize({ endedAt: endedAt ?? times.at(-1)[0] + 1000, reason });
  return { dir: storage.dir, role: 'cohort' };
}
function makeWritable(target) {
  let info; try { info = statSync(target); } catch { return; }
  if (info.isDirectory()) { try { for (const entry of readdirSync(target)) makeWritable(path.join(target, entry)); } catch { /* best effort */ } try { chmodSync(target, 0o755); } catch { /* best effort */ } }
  else { try { chmodSync(target, 0o644); } catch { /* best effort */ } }
}

/* ------------------------------------------------------- reference builder */

test('reference builder includes every valid snapshot and excludes invalid ones', () => {
  const verified = readSourceSession(buildSession({ sessionId: 's1', times: [[T, 2], [T + 1000, 0]] }));
  assert.equal(verified.snapshots.length, 2);
  assert.equal(verified.snapshots[0].validationReason, null);
  assert.equal(verified.snapshots[1].validationReason, 'INVALID_PRICE');
  assert.deepEqual(selectAllEligibleReferences([verified]), [{ sessionId: 's1', snapshotDigest: verified.snapshots[0].snapshotDigest }]);
});

test('reference builder ordering is deterministic and source-order independent', () => {
  const a = readSourceSession(buildSession({ sessionId: 'a', times: [[T, 2]] }));
  const b = readSourceSession(buildSession({ sessionId: 'b', times: [[T + 1000, 3]] }));
  const forward = selectAllEligibleReferences([a, b]);
  const reverse = selectAllEligibleReferences([b, a]);
  assert.deepEqual(forward, reverse);
  assert.deepEqual(forward.map(r => r.sessionId), ['a', 'b']);
});

test('reference builder excludes maturation-role sessions', () => {
  const source = buildSession({ sessionId: 'm1', times: [[T, 2]] });
  const maturation = readSourceSession({ dir: source.dir, role: 'maturation' });
  assert.throws(() => selectAllEligibleReferences([maturation]), /REFERENCE_SELECTION_EMPTY/);
});

test('reference builder rejects duplicate identities', () => {
  const verified = readSourceSession(buildSession({ sessionId: 'd1', times: [[T, 2]] }));
  assert.throws(() => selectAllEligibleReferences([verified, verified]), /REFERENCE_DUPLICATE_IDENTITY/);
});

test('collectAllEligibleReferences reads eligible cohort sessions only', () => {
  const cohort = buildSession({ sessionId: 'c1', times: [[T, 2]] });
  const maturation = buildSession({ sessionId: 'm2', times: [[T + 1000, 3]] });
  const selected = collectAllEligibleReferences({ sources: [cohort, { ...maturation, role: 'maturation' }] });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].sessionId, 'c1');
});

test('reference builder feeds the canonical resolver and joins into analysis rows', () => {
  const fixture = buildSession({ sessionId: 'join', times: [[T, 2], [T + 300000, 4]], endedAt: T + 400000 });
  const verified = readSourceSession(fixture);
  const references = selectAllEligibleReferences([verified]);
  assert.equal(references.length, 2);
  const outcomes = generateOutcomeRun({ sources: [fixture], references, outputRoot: path.join(tempRoot(), 'outcomes'),
    runId: 'join-run', createdAt: T + 700000, sealedCode: { sha: 'fixture-sha', tree: 'fixture-tree' } }).outcomes;
  assert.equal(outcomes.filter(row => row.status === 'resolved').length, 1);
  const rows = assembleAnalysisRows({ references: references.map((reference, i) => ({ ...reference, exposureValue: i === 0 ? 12.5 : 3 }) ), outcomes });
  assert.equal(rows.length, 2);
  assert.equal(rows.filter(row => row.status === 'resolved' && Number.isFinite(row.outcomeValue)).length, 1);
  assert.equal(rows.filter(row => row.status !== 'resolved' && row.outcomeValue === null).length, 1);
});

/* ---------------------------------------------------------- primary analysis */

test('kendall tau-b known answers and tie handling', () => {
  assert.equal(kendallTauB([1, 2, 3, 4], [1, 2, 3, 4]).tauB, 1);
  assert.equal(kendallTauB([1, 2, 3, 4], [4, 3, 2, 1]).tauB, -1);
  assert.equal(kendallTauB([1, 1, 2, 2], [1, 2, 1, 2]).tauB, 0);
  assert.deepEqual(kendallTauB([1, 1, 1], [1, 2, 3]), { defined: false, reason: 'DEGENERATE_TIES', n: 3, numerator: 0, n0: 3, n1: 3, n2: 0, effectivePairs: 0 });
  assert.equal(kendallTauB([1], [1]).defined, false);
});

test('splitmix64 and rejection sampling are deterministic and seed-sensitive', () => {
  const a = splitmix64(SEAL), b = splitmix64(SEAL), c = splitmix64('b'.repeat(64));
  const seqA = [a(), a(), a()], seqB = [b(), b(), b()], seqC = [c(), c(), c()];
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
  const gen = splitmix64(SEAL);
  for (let i = 0; i < 1000; i++) { const value = randomBelow(gen, 7); assert(value >= 0 && value < 7); }
});

test('analysis seed is outcome-independent and seal-bound', () => {
  const identities = ['s1/aa', 's1/bb'];
  const first = deriveAnalysisSeed({ sealFingerprint: SEAL, referenceIdentities: identities, horizonMs: 300000, toleranceMs: 60000 });
  const second = deriveAnalysisSeed({ sealFingerprint: SEAL, referenceIdentities: [...identities].reverse(), horizonMs: 300000, toleranceMs: 60000 });
  assert.equal(first, second, 'reference identity order must not change the seed');
  assert.notEqual(first, deriveAnalysisSeed({ sealFingerprint: 'b'.repeat(64), referenceIdentities: identities, horizonMs: 300000, toleranceMs: 60000 }));
  assert(/^[0-9a-f]{64}$/.test(first));
});

test('percentile type-7 known values', () => {
  const sorted = [1, 2, 3, 4];
  assert.equal(percentileType7(sorted, 0.5), 2.5);
  assert.equal(percentileType7(sorted, 0.025), 1.075);
  assert.equal(percentileType7(sorted, 1), 4);
  assert.equal(percentileType7([7], 0.5), 7);
});

test('cluster bootstrap is deterministic and resamples mints as clusters', () => {
  const rows = [];
  for (let m = 0; m < 12; m++) for (let k = 0; k < 3; k++) rows.push({ mint: `mint-${m}`, exposureValue: (m * 7 + k * 3) % 11, outcomeValue: (m * 5 + k * 2) % 7 });
  const seed = deriveAnalysisSeed({ sealFingerprint: SEAL, referenceIdentities: ['x'], horizonMs: 300000, toleranceMs: 60000 });
  const first = clusterBootstrap({ rows, seedHex: seed, replicates: 200 });
  const second = clusterBootstrap({ rows, seedHex: seed, replicates: 200 });
  assert.deepEqual(first.values, second.values);
  assert.equal(first.requested, 200);
  assert(first.definedCount > 0);
  const other = clusterBootstrap({ rows, seedHex: deriveAnalysisSeed({ sealFingerprint: 'b'.repeat(64), referenceIdentities: ['x'], horizonMs: 300000, toleranceMs: 60000 }), replicates: 200 });
  assert.notDeepEqual(first.values, other.values);
});

test('primary analysis is descriptive-only below the sample floors', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ mint: `mint-${i % 10}`, status: 'resolved', exposureValue: i, outcomeValue: i * 2, referenceObservedAt: T, missingReason: null }));
  const result = runPrimaryAnalysis({ rows, referenceIdentities: ['s/1'], sealFingerprint: SEAL });
  assert.equal(result.floorsMet, false);
  assert.equal(result.descriptiveOnly, true);
  assert.equal(result.inferentialClaimMade, false);
  assert.equal(result.ciLower, null);
  assert.equal(result.intervalStatus, 'NOT_COMPUTED_FLOORS_NOT_MET');
});

test('primary analysis computes the interval above the sample floors with the frozen schema', () => {
  const rows = [];
  for (let m = 0; m < 40; m++) { const n = m < 20 ? 3 : 4; for (let k = 0; k < n; k++) rows.push({ mint: `mint-${m}`, status: 'resolved', exposureValue: m + k * 0.5, outcomeValue: m * 3 + k, referenceObservedAt: T, missingReason: null }); }
  rows.push({ mint: 'mint-0', status: 'unavailable', exposureValue: null, outcomeValue: null, referenceObservedAt: T, missingReason: 'NO_SAME_MINT_OBSERVATION_IN_WINDOW' });
  const result = runPrimaryAnalysis({ rows, referenceIdentities: ['s/1', 's/2'], sealFingerprint: SEAL, replicates: 300 });
  assert.equal(result.floorsMet, true);
  assert.equal(result.descriptiveOnly, false);
  assert.equal(result.recordType, 'r4_primary_analysis');
  assert.equal(result.specVersion, PRIMARY_ANALYSIS_SPEC_VERSION);
  assert.equal(result.exposureField, PRIMARY_EXPOSURE_FIELD);
  assert.equal(result.outcomeField, PRIMARY_OUTCOME_FIELD);
  assert.equal(result.estimand, PRIMARY_ESTIMAND);
  assert.equal(result.clusterKey, CLUSTER_KEY);
  assert.equal(result.bootstrapReplicates, 300);
  assert.equal(result.quantileMethod, 'type7');
  assert.equal(result.tradingAuthority, false);
  assert.equal(result.profitabilityInferencePermitted, false);
  assert.equal(result.availabilityDenominator, rows.length);
  assert(result.intervalStatus === 'COMPUTED' || result.intervalStatus === 'INSUFFICIENT_DEFINED_REPLICATES');
  if (result.intervalStatus === 'COMPUTED') assert(result.ciLower <= result.ciUpper);
  assert.equal(typeof result.seedDigest, 'string');
});

/* --------------------------------------------------------------- cohort plan */

test('mechanical T0 is the first whole UTC hour at least 30 minutes after the seal commit', () => {
  assert.equal(mechanicalT0(Date.UTC(2026, 8, 28, 10, 0, 0)), Date.UTC(2026, 8, 28, 11, 0, 0));
  assert.equal(mechanicalT0(Date.UTC(2026, 8, 28, 10, 29, 59)), Date.UTC(2026, 8, 28, 11, 0, 0));
  assert.equal(mechanicalT0(Date.UTC(2026, 8, 28, 10, 30, 0)), Date.UTC(2026, 8, 28, 11, 0, 0));
  assert.equal(mechanicalT0(Date.UTC(2026, 8, 28, 10, 30, 1)), Date.UTC(2026, 8, 28, 12, 0, 0));
  assert.equal(mechanicalT0(Date.UTC(2026, 8, 28, 23, 45, 0)), Date.UTC(2026, 8, 29, 1, 0, 0));
});

test('cohort plan freezes 6 targets, 8 attempts and identical session parameters', () => {
  const plan = buildCohortPlan({ sealFingerprint: SEAL, preregistrationDigest: 'c'.repeat(64), sealCommittedAt: Date.UTC(2026, 8, 28, 10, 0, 0) });
  assert.equal(plan.spec.targetCompletedSessions, 6);
  assert.equal(plan.spec.maxAttempts, 8);
  assert.equal(plan.spec.durationMinutes, 45);
  assert.equal(plan.spec.captureMode, '--r4-revisits');
  assert.equal(plan.spec.maturationMode, 'COHORT_DRAIN_ONLY');
  assert.equal(plan.spec.discretionaryAttemptsPermitted, false);
  assert.equal(plan.spec.outcomeDependentExtensionPermitted, false);
  assert.equal(plan.b1Rule, R4_B1_RULE);
  assert.equal(plan.attempts.length, 8);
  assert.deepEqual(plan.attempts.map(a => a.index), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert(plan.attempts.every(a => a.status === 'PLANNED' && a.replacementOf === null));
  assert.deepEqual(sessionParameters().providers, R4_COHORT_SPEC.providers);
});

test('cohort progress stops at six completed sessions and links replacements mechanically', () => {
  const plan = buildCohortPlan({ sealFingerprint: SEAL, preregistrationDigest: 'c'.repeat(64), sealCommittedAt: T });
  const attempts = [];
  for (let i = 1; i <= 6; i++) attempts.push({ index: i, status: 'COMPLETED', sessionId: `session-${i}`, failureCode: null, replacementOf: null });
  const done = evaluateCohortProgress(plan, attempts);
  assert.equal(done.stop, true);
  assert.equal(done.cohortComplete, true);
  assert.equal(done.completedCount, 6);
  assert.deepEqual(done.membership, ['session-1', 'session-2', 'session-3', 'session-4', 'session-5', 'session-6']);

  const withFailure = [
    { index: 1, status: 'FAILED', sessionId: null, failureCode: 'SOURCE_STATUS_INELIGIBLE', replacementOf: null },
    { index: 2, status: 'COMPLETED', sessionId: 'session-2', failureCode: null, replacementOf: 1 },
  ];
  const partial = evaluateCohortProgress(plan, withFailure);
  assert.equal(partial.stop, false);
  assert.equal(partial.shortfall, false);
  assert.deepEqual(partial.membership, ['session-2']);
  assert.throws(() => evaluateCohortProgress(plan, [withFailure[0], { ...withFailure[1], replacementOf: null }]), /ATTEMPT_REPLACEMENT_LINKAGE_INVALID/);
});

test('cohort progress rejects discretionary attempts and reports an eight-attempt shortfall', () => {
  const plan = buildCohortPlan({ sealFingerprint: SEAL, preregistrationDigest: 'c'.repeat(64), sealCommittedAt: T });
  const attempts = Array.from({ length: 8 }, (_, i) => ({ index: i + 1, status: 'COMPLETED', sessionId: `session-${i + 1}`, failureCode: null, replacementOf: null })).slice(0, 3);
  assert.equal(evaluateCohortProgress(plan, attempts).stop, false);
  assert.throws(() => evaluateCohortProgress(plan, [...attempts, { index: 4, status: 'FAILED', sessionId: null, failureCode: null, replacementOf: null }]), /ATTEMPT_FAILURE_CODE_REQUIRED/);
  // A completed attempt must not claim it replaced a successful attempt.
  assert.throws(() => evaluateCohortProgress(plan, [...attempts, { index: 4, status: 'COMPLETED', sessionId: 'session-4', failureCode: null, replacementOf: 3 }]), /ATTEMPT_REPLACEMENT_LINKAGE_INVALID/);
  const exhausted = Array.from({ length: 8 }, (_, i) => ({ index: i + 1, status: 'FAILED', sessionId: null, failureCode: 'SOURCE_STATUS_INELIGIBLE', replacementOf: i === 0 ? null : i }));
  const closed = evaluateCohortProgress(plan, exhausted);
  assert.equal(closed.stop, true);
  assert.equal(closed.cohortComplete, false);
  assert.equal(closed.shortfall, true);
  assert.deepEqual(closed.membership, []);
  assert.throws(() => evaluateCohortProgress(plan, [...exhausted, { index: 9, status: 'FAILED', sessionId: null, failureCode: 'X', replacementOf: 8 }]), /ATTEMPT_BUDGET_EXCEEDED/);
});

test('frozen constants match the preregistration', () => {
  assert.equal(BOOTSTRAP_REPLICATES, 10000);
  assert.equal(MIN_RESOLVED_REFERENCES, 100);
  assert.equal(MIN_RESOLVED_MINTS, 30);
  assert.equal(R4_COHORT_SPEC.horizonMs, 300000);
  assert.equal(R4_COHORT_SPEC.toleranceMs, 60000);
});

let failed = 0;
try {
  for (const [name, fn] of tests) {
    try { fn(); console.log(`PASS ${name}`); }
    catch (e) { failed++; console.error(`FAIL ${name}: ${String(e?.stack ?? e).split('\n')[0]}`); }
  }
} finally {
  while (roots.length) { const root = roots.pop(); makeWritable(root); rmSync(root, { recursive: true, force: true }); }
}
console.log('');
console.log(`R4 protocol: ${tests.length - failed}/${tests.length} passed; synthetic temporary fixtures only`);
if (failed) process.exitCode = 1;
