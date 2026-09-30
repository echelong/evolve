#!/usr/bin/env node
// R4 post-start continuation validator (enforcement only).
// Proves that pre-boundary attempts stay under historical authority while
// post-boundary attempts use the resealed runtime and C1.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { canonical, digest } from './market-intelligence/definition.mjs';
import { R4_SPEC_DIGEST, R4_TRACKED_SEAL_PATH, captureSpecDigest } from './r4-protocol-spec.mjs';
import { buildSeal } from './r4-preregistration-seal.mjs';
import { resolveR4ExecutionAuthority } from './r4-approval.mjs';
import { loadR4AttemptHistory, verifyR4AttemptHistory } from './r4-attempt-history.mjs';
import { main as runnerMain, canonicalAttemptHistory, parseRunnerArgs } from './r4-cohort-run.mjs';
import {
  completedAttemptFixture, syntheticChildSpawn, commitAll, removeTree,
} from './r4-synthetic-authority.mjs';
import {
  assertContinuationRecord, assertContinuationReviewRecord,
  assertContinuationEligibleInEvidenceRoot, buildContinuationRecord,
  buildContinuationReviewRecord, continuationPathForGeneration,
  continuationReviewPathForGeneration, providerBaselineDigest,
  verifyContinuationBinding, R4_CONTINUATION_INELIGIBLE,
} from './r4-continuation.mjs';

const P6_ISO = '2026-09-28T12:30:00Z';
const S6_ISO = '2026-09-28T12:35:00Z';
const REVIEW_AT = Date.parse('2026-09-28T12:40:00Z');
const C1_ISO = '2026-09-28T12:45:00Z';
const ATTEMPT2_AT = Date.parse('2026-09-28T13:00:00Z');

let executed = 0;
let failed = 0;
const failures = [];
const CLEANUP = [];

function test(name, fn) {
  executed++;
  try { fn(); console.log('PASS ' + name); }
  catch (error) {
    failed++;
    failures.push(name);
    console.error('FAIL ' + name + ': ' + (error?.message ?? error));
  }
}

function throwsCode(name, fn, expected) {
  let code = null;
  try { fn(); } catch (error) { code = String(error?.message ?? error).split(':')[0]; }
  assert.equal(code, expected, name + ': expected ' + expected + ', got ' + code);
}

function verifyUnderA(fixture) {
  const resolution = resolveR4ExecutionAuthority({ cwd: fixture.dir, requireApproval: true });
  assert.equal(resolution.stage, 'A');
  const history = loadR4AttemptHistory({ cwd: fixture.dir });
  const verified = verifyR4AttemptHistory(history, {
    seal: resolution.seal, authority: resolution.authority,
    approvalCommit: resolution.approvalCommit, approvalEpoch: resolution.approvalEpoch,
    approvalFingerprint: resolution.approvalFingerprint, t0: resolution.t0,
  });
  return { resolution, verified };
}

function buildContinuationFixture() {
  const { fixture, result: attempt1 } = completedAttemptFixture();
  CLEANUP.push(fixture.root);
  const old = verifyUnderA(fixture);
  assert.equal(old.verified.attemptsUsed, 1);
  assert.equal(old.verified.completedCount, 1);

  const eligibility = assertContinuationEligibleInEvidenceRoot({
    verified: old.verified, cwd: fixture.dir, continuation: 1,
  });
  assert.equal(eligibility.eligible, true);
  const boundHistory = eligibility.boundHistory;

  // The validator's fixture already contains the continuation-capable runtime.
  // Advance to a distinct synthetic P6 without mutating a bound file, so the
  // live validator can still verify both historical and current seal contents
  // byte-for-byte against this checkout. Real P6 changes the bound enforcement
  // files and is separately sealed/verified by the canonical seal validators.
  const repairMarker = path.join(fixture.dir, 'governance/r4/SYNTHETIC-P6.txt');
  writeFileSync(repairMarker, 'synthetic post-start enforcement repair\n');
  const p6 = commitAll(fixture.run, 'P6: synthetic post-start enforcement repair', P6_ISO);
  const p6Tree = fixture.run(['rev-parse', p6 + '^{tree}']);

  const load = file => readFileSync(path.join(fixture.dir, file));
  const seal6 = buildSeal({
    baseSha: p6, baseTree: p6Tree, sealedAt: Date.parse(S6_ISO), load,
  });
  writeFileSync(path.join(fixture.dir, R4_TRACKED_SEAL_PATH), canonical(seal6) + '\n');
  const s6 = commitAll(fixture.run, 'S6: synthetic continuation seal', S6_ISO);

  const review = buildContinuationReviewRecord({
    continuation: 1,
    protocolCommit: p6, protocolTree: p6Tree,
    sealCommit: s6, sealFingerprint: seal6.fingerprint,
    priorApprovalEpoch: old.resolution.approvalEpoch,
    priorApprovalCommit: old.resolution.approvalCommit,
    priorApprovalFingerprint: old.resolution.approvalFingerprint,
    priorSealCommit: fixture.sealCommit, priorSealFingerprint: fixture.seal.fingerprint,
    boundHistoryDigest: boundHistory.historyDigest,
    attemptsUsed: boundHistory.attemptsUsed,
    completedCount: boundHistory.completedCount,
    nextAttemptIndex: boundHistory.nextAttemptIndex,
    reviewer: 'synthetic-independent-continuation-reviewer',
    model: 'synthetic-independent-model',
    reviewedAt: REVIEW_AT,
  });
  assertContinuationReviewRecord(review);

  const record = buildContinuationRecord({
    continuation: 1,
    protocolCommit: p6, protocolTree: p6Tree,
    sealCommit: s6, sealFingerprint: seal6.fingerprint,
    priorApprovalEpoch: old.resolution.approvalEpoch,
    priorApprovalCommit: old.resolution.approvalCommit,
    priorApprovalFingerprint: old.resolution.approvalFingerprint,
    priorSealCommit: fixture.sealCommit, priorSealFingerprint: fixture.seal.fingerprint,

    priorSealProtocolCommit: fixture.seal.protocolCommit,
    priorSealProtocolTree: fixture.seal.protocolTree,
    specDigest: R4_SPEC_DIGEST, captureSpecDigest: captureSpecDigest(),
    providers: providerBaselineDigest(), boundHistory,
    reviewDigest: review.fingerprint,
    continuationReviewer: review.reviewer,
    continuationReviewerModel: review.model,
    t0: old.resolution.t0,
  });
  assertContinuationRecord(record);

  for (const [file, value] of [
    [continuationReviewPathForGeneration(1), review],
    [continuationPathForGeneration(1), record],
  ]) {
    const target = path.join(fixture.dir, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, canonical(value) + '\n');
  }
  const c1 = commitAll(fixture.run, 'C1: synthetic post-start continuation', C1_ISO);
  fixture.setRemoteMain(c1);

  const resolution = resolveR4ExecutionAuthority({ cwd: fixture.dir, requireApproval: true });
  assert.equal(resolution.stage, 'C');
  return {
    fixture, attempt1, old, eligibility, boundHistory,
    p6, p6Tree, seal6, s6, review, record, c1, resolution,
  };
}

const state = buildContinuationFixture();

test('C1 binds the complete one-attempt boundary with no reset', () => {
  assert.equal(state.record.boundHistory.attemptsUsed, 1);
  assert.equal(state.record.boundHistory.completedCount, 1);
  assert.equal(state.record.boundHistory.nextAttemptIndex, 2);
  assert.equal(state.record.boundHistory.attemptIdentities.length, 1);
  assert.equal(
    state.record.boundHistory.attemptIdentities[0].authorizationFingerprint,
    state.old.verified.attempts[0].authorization.fingerprint,
  );
});

test('C1 preserves the scientific approval and original T0', () => {
  assert.equal(state.resolution.approvalCommit, state.old.resolution.approvalCommit);
  assert.equal(state.resolution.approvalFingerprint, state.old.resolution.approvalFingerprint);
  assert.equal(state.resolution.approvalEpoch, state.old.resolution.approvalEpoch);
  assert.equal(state.resolution.t0, state.old.resolution.t0);
  assert.equal(state.record.reanchorsT0, false);
});

test('C1 preserves frozen science and adds no attempt budget', () => {
  assert.equal(state.record.specDigest, state.fixture.seal.specDigest);
  assert.equal(state.record.captureSpecDigest, state.fixture.seal.captureSpecDigest);
  assert.equal(state.record.maxAttempts, 8);
  assert.equal(state.record.targetCompletedSessions, 6);
  assert.equal(state.record.newAttemptBudget, 0);
});

test('pre-boundary Attempt 1 verifies against its historical seal', () => {
  const { verified, next } = canonicalAttemptHistory({
    resolution: state.resolution, cwd: state.fixture.dir,
  });
  assert.deepEqual(verified.grandfatheredAttempts, [1]);
  assert.equal(
    verified.attempts[0].authorization.sealFingerprint,
    state.fixture.seal.fingerprint,
  );
  assert.equal(verified.attempts[0].continuationFingerprint, null);
  assert.equal(next.nextAttemptIndex, 2);
});

test('stage-C preflight reports Attempt 2 as the mechanical next attempt', () => {
  const result = runnerMain(['preflight'], {
    cwd: state.fixture.dir, env: {}, now: ATTEMPT2_AT,
  });
  assert.equal(result.report.authorityStage, 'C');
  assert.equal(result.report.attemptHistory.attemptsUsed, 1);
  assert.equal(result.report.attemptHistory.completedCount, 1);
  assert.equal(result.report.attemptHistory.next.nextAttemptIndex, 2);
});

test('caller cannot select a continuation generation', () => {
  throwsCode(
    'continuation override',
    () => parseRunnerArgs(['capture', '--continuation', '1', '--execute']),
    'R4_RUNNER_ARGUMENT_UNSUPPORTED',
  );
});

test('a continuation cannot re-anchor T0', () => {
  const bad = {
    ...state.record,
    t0: state.record.t0 + 1,
    t0Iso: new Date(state.record.t0 + 1).toISOString(),
  };
  const content = { ...bad };
  delete content.fingerprint;
  bad.fingerprint = digest(content);
  assertContinuationRecord(bad);
  throwsCode(
    'T0 reanchor',
    () => verifyContinuationBinding({
      record: bad, review: state.review, commit: state.c1, cwd: state.fixture.dir,
    }),
    R4_CONTINUATION_INELIGIBLE.t0Reanchor,
  );
});

test('Attempt 2 completes under C1/S6 without changing A2', () => {
  const result = runnerMain(['capture', '--attempt', '2', '--execute'], {
    cwd: state.fixture.dir, env: {}, now: ATTEMPT2_AT,
    clock: () => ATTEMPT2_AT + 1000,
    spawn: syntheticChildSpawn({
      behaviour: 'complete', now: ATTEMPT2_AT, sessionStartAt: ATTEMPT2_AT,
    }),
  });
  assert.equal(result.attemptIndex, 2);
  assert.equal(result.exitCode, 0);
  const { verified, next } = canonicalAttemptHistory({
    resolution: state.resolution, cwd: state.fixture.dir,
  });

  assert.equal(verified.attemptsUsed, 2);
  assert.equal(verified.completedCount, 2);
  assert.deepEqual(verified.grandfatheredAttempts, [1]);
  const second = verified.attempts[1];
  assert.equal(second.authorization.sealFingerprint, state.seal6.fingerprint);
  assert.equal(second.authorization.approvalCommit, state.old.resolution.approvalCommit);
  assert.equal(second.authorization.t0, state.old.resolution.t0);
  assert.equal(second.authorization.continuationFingerprint, state.record.fingerprint);
  assert.equal(second.claim.continuationFingerprint, state.record.fingerprint);
  assert.equal(second.receipt.continuationFingerprint, state.record.fingerprint);
  assert.equal(second.attestation.continuationFingerprint, state.record.fingerprint);
  assert.equal(second.terminal.continuationFingerprint, state.record.fingerprint);
  assert.equal(next.nextAttemptIndex, 3);
});

test('outcome artifacts make continuation ineligible', () => {
  const target = path.join(
    state.fixture.dir, '.evolve/market-outcomes/synthetic-outcome',
  );
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, 'manifest.json'), '{}\n');
  const result = assertContinuationEligibleInEvidenceRoot({
    verified: state.old.verified, cwd: state.fixture.dir, continuation: 1,
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, R4_CONTINUATION_INELIGIBLE.outcomeArtifacts);
});

for (const root of CLEANUP) {
  try { removeTree(root); } catch { /* best effort */ }
}

console.log('');
console.log(
  'R4 continuation: ' + (executed - failed) + '/' + executed
    + ' executed case(s) passed, ' + failed
    + ' failure(s); synthetic temporary fixtures only',
);
if (failed) {
  console.error('failures: ' + failures.join(', '));
  process.exitCode = 1;
}
