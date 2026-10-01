#!/usr/bin/env node
// R4 post-start continuation validator (enforcement only).
// Proves that pre-boundary attempts stay under historical authority while
// post-boundary attempts use the resealed runtime and C1.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { canonical, digest } from './market-intelligence/definition.mjs';
import { R4_SPEC_DIGEST, R4_TRACKED_SEAL_PATH, captureSpecDigest } from './r4-protocol-spec.mjs';
import { buildSeal, verifyR4Seal as verifyR4SealCurrent } from './r4-preregistration-seal.mjs';
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
  resolveContinuationChain, assertNoContinuationOverride,
  verifyHistoricalSealArtifact, readHistoricalSealArtifact,
  assertNoPreContinuationOutcomeArtifacts, assertCreationTimeOutcomeIndependence,
  R4_CONTINUATION_OUTCOME_ROOTS,
} from './r4-continuation.mjs';
import { runCanonicalR4Analysis } from './r4-canonical-analysis.mjs';
import { gitShowFile, R4_REPO_ROOT } from './r4-authority.mjs';
import {
  evaluateSealedCohortProgress, deriveCanonicalCohortMembership,
  buildCanonicalReferenceSetFromEvidence,
} from './r4-enforcement.mjs';
import { planSealedCohort } from './r4-enforcement.mjs';
import { historyAttemptAuthorityIndex } from './r4-attempt-history.mjs';

/* ---------------------------------------------------------------------------
 * REAL REPOSITORY HISTORY (the actual R4 authority chain, not a fixture).
 *
 * These constants are the immutable Git facts of the live cohort. The B1/B2 tests
 * below authenticate the REAL historical S5 seal from the REAL post-repair
 * checkout, which is the exact condition the pre-repair synthetic fixture
 * deliberately avoided: that fixture created its synthetic P6 without mutating a
 * bound file, so `verifyR4Seal` (which hashes bound files out of the CURRENT
 * worktree) happened to still accept the historical seal and B1 escaped.
 * ------------------------------------------------------------------------ */
const REAL_A2 = '9dc30de45ee0fc8c493c2582bae6378dae1fdc7b';
const REAL_A2_FINGERPRINT = 'a177be24986b0dfe511b40d16346a14b71c097db347f6d98fd622fa5d893c60d';
const REAL_S5 = 'e54488305d742624106e20e808b65c2c4fe94a15';
const REAL_S5_FINGERPRINT = '9bf7ee3be2821116bcd2596c06c3e2e75f06f3c0de68a7e85f656d33b0cb5269';
const REAL_P5 = 'b6aa11554022d309a8b8566d96e824f72dcacae3';
const REAL_P5_TREE = 'b32f03abf3f425754af90770e86ae931700976a5';

/** The real historical S5 seal, read from Git. */
function realHistoricalS5(cwd = R4_REPO_ROOT) {
  const bytes = gitShowFile(REAL_S5, R4_TRACKED_SEAL_PATH, cwd);
  assert.ok(bytes !== null, 'the real historical S5 seal must be readable from Git');
  return JSON.parse(bytes.toString('utf8'));
}

/** The `priorSeal` block C1 would bind for the real A2/S5 authority. */
function realPriorSealBlock() {
  return { sealCommit: REAL_S5, sealFingerprint: REAL_S5_FINGERPRINT,
    protocolCommit: REAL_P5, protocolTree: REAL_P5_TREE };
}

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

/** For codes that carry a `:<detail>` suffix, match on the prefix. */
function throwsCodePrefix(name, fn, expectedPrefix) {
  let code = null;
  try { fn(); } catch (error) { code = String(error?.message ?? error); }
  assert.ok(code !== null && code.startsWith(expectedPrefix),
    name + ': expected ' + expectedPrefix + '*, got ' + code);
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
  // Use a THROWAWAY fixture: a planted outcome manifest would otherwise poison the
  // shared stage-C fixture for every later test, because the resolution-time
  // outcome gate correctly refuses a continuation while a run exists.
  const { fixture } = completedAttemptFixture();
  CLEANUP.push(fixture.root);
  const target = path.join(fixture.dir, '.evolve/market-outcomes/synthetic-outcome');
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, 'manifest.json'), '{}\n');
  const result = assertContinuationEligibleInEvidenceRoot({
    verified: state.old.verified, cwd: fixture.dir, continuation: 1,
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, R4_CONTINUATION_INELIGIBLE.outcomeArtifacts);
});

/* =============================================================================
 * B1 — HISTORICAL SEAL VERIFICATION AGAINST THE SNAPSHOT IT SEALED
 *
 * Run against the REAL repository history from the REAL post-repair checkout
 * (this file mutates bound files, so the current worktree's bound files and
 * artifactAuthority schema both differ from S5's). This is precisely the
 * condition the synthetic fixture avoided, and precisely why B1 was invisible.
 * ========================================================================== */

test('B1: the real historical S5 authenticates against its own P5 tree from the post-repair checkout', () => {
  const s5 = realHistoricalS5();
  assert.equal(s5.fingerprint, REAL_S5_FINGERPRINT);
  assert.equal(s5.protocolCommit, REAL_P5);
  const proof = verifyHistoricalSealArtifact(s5, {
    cwd: R4_REPO_ROOT, sealPath: R4_TRACKED_SEAL_PATH, expected: realPriorSealBlock() });
  assert.equal(proof.ok, true);
  assert.equal(proof.fingerprint, REAL_S5_FINGERPRINT);
  assert.equal(proof.protocolCommit, REAL_P5);
  assert.equal(proof.protocolTree, REAL_P5_TREE);
  // The Git-discovered seal authority commit IS the real S5.
  assert.equal(proof.sealAuthorityCommit, REAL_S5);
  // It used the HISTORICAL seal's own bound-file set, not the current one.
  assert.equal(proof.boundFileCount, Object.keys(s5.boundFiles).length);
  assert.ok(proof.boundFileCount > 0);
});

test('B1: readHistoricalSealArtifact returns the real S5 for the real priorSeal block', () => {
  const artifact = readHistoricalSealArtifact({
    cwd: R4_REPO_ROOT, sealPath: R4_TRACKED_SEAL_PATH, record: { priorSeal: realPriorSealBlock() } });
  assert.equal(artifact.fingerprint, REAL_S5_FINGERPRINT);
  assert.equal(artifact.protocolCommit, REAL_P5);
  assert.equal(artifact.protocolTree, REAL_P5_TREE);
});

test('B1: the CURRENT verifier still rejects the historical S5 (generations stay separate)', () => {
  // Proves the current canonical verifier was NOT weakened: S5 is still invalid
  // under the current schema, which is why a separate historical verifier is
  // required rather than relaxing `verifyR4Seal`.
  let code = null;
  try { verifyR4SealCurrent(realHistoricalS5()); } catch (error) { code = String(error.message); }
  assert.ok(code !== null, 'the current verifier must still refuse the historical S5');
  assert.match(code, /R4_SEAL_(ARTIFACT_AUTHORITY_DRIFT|BOUND_FILE_SET_DRIFT|FILE_DIGEST_MISMATCH)/);
});

test('B1: an altered historical seal fingerprint fails closed', () => {
  const tampered = { ...realHistoricalS5(), fingerprint: 'f'.repeat(64) };
  throwsCode('altered historical fingerprint',
    () => verifyHistoricalSealArtifact(tampered, { cwd: R4_REPO_ROOT }),
    'R4_HISTORICAL_SEAL_FINGERPRINT_MISMATCH');
});

test('B1: a wrong historical seal commit fails closed', () => {
  throwsCode('wrong historical seal commit',
    () => verifyHistoricalSealArtifact(realHistoricalS5(), {
      cwd: R4_REPO_ROOT, expected: { ...realPriorSealBlock(), sealCommit: '0'.repeat(40) } }),
    'R4_HISTORICAL_SEAL_COMMIT_MISMATCH');
});

test('B1: a wrong historical protocol commit fails closed', () => {
  throwsCode('wrong historical protocol commit',
    () => verifyHistoricalSealArtifact(realHistoricalS5(), {
      cwd: R4_REPO_ROOT, expected: { ...realPriorSealBlock(), protocolCommit: '1'.repeat(40) } }),
    'R4_HISTORICAL_SEAL_PROTOCOL_MISMATCH');
});

test('B1: a wrong historical protocol tree fails closed', () => {
  throwsCode('wrong historical protocol tree',
    () => verifyHistoricalSealArtifact(realHistoricalS5(), {
      cwd: R4_REPO_ROOT, expected: { ...realPriorSealBlock(), protocolTree: '2'.repeat(40) } }),
    'R4_HISTORICAL_SEAL_PROTOCOL_TREE_MISMATCH');
});

test('B1: an altered recorded historical bound-file digest fails closed', () => {
  // Re-fingerprint so the failure is attributable to the Git blob check, not the
  // self-fingerprint check: the recorded digest no longer matches the blob at P5.
  const tampered = { ...realHistoricalS5(),
    boundFiles: { ...realHistoricalS5().boundFiles, 'package.json': { sha256: 'a'.repeat(64) } } };
  delete tampered.fingerprint;
  tampered.fingerprint = digest(tampered);
  let code = null;
  try { verifyHistoricalSealArtifact(tampered, { cwd: R4_REPO_ROOT }); } catch (error) { code = String(error.message); }
  assert.ok(code !== null && code.startsWith('R4_HISTORICAL_SEAL_UNVERIFIABLE:'),
    'an altered historical bound-file digest must fail closed, got ' + code);
  assert.match(code, /BOUND_FILE/);
});

test('B1: a historical seal with a non-canonical record type or status fails closed', () => {
  for (const [field, value, expected] of [
    ['recordType', 'not_a_seal', 'R4_HISTORICAL_SEAL_RECORD_TYPE_INVALID'],
    ['status', 'DRAFT', 'R4_HISTORICAL_SEAL_STATUS_INVALID'],
  ]) {
    const tampered = { ...realHistoricalS5(), [field]: value };
    delete tampered.fingerprint;
    tampered.fingerprint = digest(tampered);
    throwsCode(`historical seal ${field}`, () => verifyHistoricalSealArtifact(tampered, { cwd: R4_REPO_ROOT }), expected);
  }
});

/* =============================================================================
 * PROGRAMMATIC OVERRIDE GUARD
 * ========================================================================== */

test('override: the programmatic resolver refuses a caller-supplied continuation generation', () => {
  throwsCodePrefix('programmatic generation override',
    () => resolveContinuationChain({ cwd: R4_REPO_ROOT, continuation: 1 }),
    'R4_CONTINUATION_OVERRIDE_FORBIDDEN:continuation');
});

test('override: the programmatic resolver refuses every selection/T0/reset key', () => {
  for (const key of ['continuationGeneration', 'continuationCommit', 'continuationFingerprint', 'generation',
    'attemptAllowlist', 'grandfatheredAttempts', 'includeAttempts', 'excludeAttempts', 'attemptSelection',
    'selectedAttempts', 't0', 'T0', 't0Iso', 'window', 'windowStart', 'windowEnd', 'startAt', 'date', 'hour',
    'offset', 't0OffsetMs', 'anchorAt', 'reset', 'restart', 'attemptsUsed', 'completedCount']) {
    throwsCodePrefix(`programmatic override ${key}`,
      () => resolveContinuationChain({ cwd: R4_REPO_ROOT, [key]: 1 }),
      `R4_CONTINUATION_OVERRIDE_FORBIDDEN:${key}`);
  }
});

test('override: the construction path still refuses T0/offset/reset and attempt selection', () => {
  for (const key of ['t0', 'offset', 'reset', 'restart', 'attemptAllowlist', 'excludeAttempts', 'attemptsUsed']) {
    throwsCodePrefix(`construction override ${key}`,
      () => assertContinuationEligibleInEvidenceRoot({ verified: state.old.verified, cwd: state.fixture.dir, [key]: 1 }),
      `R4_CONTINUATION_OVERRIDE_FORBIDDEN:${key}`);
  }
});

test('override: assertNoContinuationOverride is reachable and strict', () => {
  assert.equal(assertNoContinuationOverride({ cwd: R4_REPO_ROOT, sealPath: 'x' }), true);
  throwsCodePrefix('direct guard', () => assertNoContinuationOverride({ t0: 1 }), 'R4_CONTINUATION_OVERRIDE_FORBIDDEN:t0');
});

/* =============================================================================
 * OUTCOME-INDEPENDENCE CREATION GATE (creation-time AND resolution-time)
 * ========================================================================== */

/** Write a canonical-shaped outcome manifest (process metadata only). */
function writeOutcomeManifest(root, runId, createdAt) {
  const dir = path.join(root, runId);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    schemaVersion: 1, recordType: 'outcome_manifest', status: 'finalized', runId, createdAt,
    outcomeDefinitionId: 'SYNTHETIC', horizonSeconds: 300, horizonMs: 300000,
    resolutionToleranceMs: 60000, primaryField: 'absLogReturn300sBps', outcomeType: 'continuous',
    classification: 'SYNTHETIC', sourcePolicy: 'SYNTHETIC', sealedCode: null,
    sources: [], recordCount: 0, resolvedCount: 0, unresolvedCount: 0, unresolvedByReason: {},
    files: { 'outcomes.ndjson': 'a'.repeat(64), 'summary.json': 'b'.repeat(64) },
  };
  writeFileSync(path.join(dir, 'manifest.json'), canonical(manifest) + '\n');
  return manifest;
}

/** A fresh evidence root with no outcome artifacts at all. */
function cleanOutcomeFixture() {
  const { fixture } = completedAttemptFixture();
  CLEANUP.push(fixture.root);
  return fixture.dir;
}

const C1_AUTHORITY_TIME = 1_800_000_000_000;

test('outcome gate: no outcomes => the creation-time gate is satisfied', () => {
  const dir = cleanOutcomeFixture();
  const result = assertContinuationEligibleInEvidenceRoot({ verified: state.old.verified, cwd: dir, continuation: 1 });
  assert.equal(result.eligible, true, 'with no outcome runs a continuation may be constructed');
  assert.equal(assertNoPreContinuationOutcomeArtifacts({ cwd: dir, continuationAuthorityAt: C1_AUTHORITY_TIME }).ok, true);
});

test('outcome gate: a PRE-C1 outcome run invalidates the continuation', () => {
  const dir = cleanOutcomeFixture();
  // createdAt strictly BEFORE the C1 authority time => the run predates C1.
  writeOutcomeManifest(path.join(dir, R4_CONTINUATION_OUTCOME_ROOTS[0]), 'pre-c1-run', C1_AUTHORITY_TIME - 1);
  const result = assertNoPreContinuationOutcomeArtifacts({ cwd: dir, continuationAuthorityAt: C1_AUTHORITY_TIME });
  assert.equal(result.ok, false);
  assert.equal(result.reason, R4_CONTINUATION_INELIGIBLE.outcomeArtifacts);
  assert.deepEqual(result.outcomeRuns, [`${R4_CONTINUATION_OUTCOME_ROOTS[0]}/pre-c1-run`]);
  // And a continuation cannot be CONSTRUCTED while it exists.
  const built = assertContinuationEligibleInEvidenceRoot({ verified: state.old.verified, cwd: dir, continuation: 1 });
  assert.equal(built.eligible, false);
  assert.equal(built.reason, R4_CONTINUATION_INELIGIBLE.outcomeArtifacts);
});

test('outcome gate: a POST-C1 outcome run does NOT retroactively invalidate the continuation', () => {
  const dir = cleanOutcomeFixture();
  // createdAt strictly AFTER the C1 authority time => a legitimate post-C1 product.
  writeOutcomeManifest(path.join(dir, R4_CONTINUATION_OUTCOME_ROOTS[0]), 'post-c1-run', C1_AUTHORITY_TIME + 1);
  const result = assertNoPreContinuationOutcomeArtifacts({ cwd: dir, continuationAuthorityAt: C1_AUTHORITY_TIME });
  assert.equal(result.ok, true, 'a post-C1 outcome must keep an existing C1 resolvable');
  assert.equal(result.outcomeRuns.length, 1);
});

test('outcome gate: an outcome created exactly at the C1 authority time is treated as pre-C1', () => {
  const dir = cleanOutcomeFixture();
  writeOutcomeManifest(path.join(dir, R4_CONTINUATION_OUTCOME_ROOTS[0]), 'boundary-run', C1_AUTHORITY_TIME);
  const result = assertNoPreContinuationOutcomeArtifacts({ cwd: dir, continuationAuthorityAt: C1_AUTHORITY_TIME });
  assert.equal(result.ok, false, 'createdAt <= C1 authority time must fail closed');
});

test('outcome gate: a malformed outcome manifest fails closed', () => {
  for (const [label, body] of [
    ['unparseable', 'not json at all'],
    ['wrong record type', canonical({ schemaVersion: 1, recordType: 'other', status: 'finalized', createdAt: C1_AUTHORITY_TIME + 1 })],
    ['not finalized', canonical({ schemaVersion: 1, recordType: 'outcome_manifest', status: 'running', createdAt: C1_AUTHORITY_TIME + 1 })],
    ['missing createdAt', canonical({ schemaVersion: 1, recordType: 'outcome_manifest', status: 'finalized' })],
  ]) {
    const dir = cleanOutcomeFixture();
    const target = path.join(dir, R4_CONTINUATION_OUTCOME_ROOTS[0], 'bad-run');
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, 'manifest.json'), body + '\n');
    let code = null;
    try { assertNoPreContinuationOutcomeArtifacts({ cwd: dir, continuationAuthorityAt: C1_AUTHORITY_TIME }); }
    catch (error) { code = String(error.message); }
    assert.ok(code !== null && code.startsWith('R4_CONTINUATION_OUTCOME_MANIFEST_'),
      `a ${label} manifest must fail closed, got ${code}`);
  }
});

test('outcome gate: a non-integer C1 authority time is refused', () => {
  throwsCode('non-integer C1 time',
    () => assertNoPreContinuationOutcomeArtifacts({ cwd: R4_REPO_ROOT, continuationAuthorityAt: 'now' }),
    'R4_CONTINUATION_OUTCOME_GATE_TIME_INVALID');
});

test('outcome gate: the creation-time condition is bound into the authenticated record', () => {
  // The record states its creation-time outcome state, and that statement is covered
  // by the record fingerprint, so it cannot be edited without detection.
  assert.equal(state.record.outcomeArtifactsPresentAtCreation, false);
  assert.deepEqual(state.record.outcomeRootsInspectedAtCreation, [...R4_CONTINUATION_OUTCOME_ROOTS]);
  assert.equal(assertCreationTimeOutcomeIndependence(state.record), true);
  for (const [label, mutate, expected] of [
    ['claims outcomes present', r => ({ ...r, outcomeArtifactsPresentAtCreation: true }), R4_CONTINUATION_INELIGIBLE.outcomeArtifacts],
    ['wrong outcome roots', r => ({ ...r, outcomeRootsInspectedAtCreation: ['.evolve/elsewhere'] }), 'R4_CONTINUATION_OUTCOME_ROOTS_MISMATCH'],
  ]) {
    const bad = mutate(state.record);
    throwsCode(label, () => assertCreationTimeOutcomeIndependence(bad), expected);
    // And it cannot pass full record validation either.
    const content = { ...bad };
    delete content.fingerprint;
    bad.fingerprint = digest(content);
    throwsCode(`${label} (full record)`, () => assertContinuationRecord(bad), expected);
  }
});

/* =============================================================================
 * MIXED HISTORICAL/CURRENT AUTHORITY COHORT GOVERNANCE
 *
 * The shared fixture now holds a grandfathered Attempt 1 (historical S5/A2) and a
 * post-C1 Attempt 2 (current S6/C1). These tests prove both enter canonical cohort
 * membership simultaneously, each under its OWN authority, and that authority
 * cannot be forged, swapped or replayed.
 * ========================================================================== */

/** Project verified history into the cohort-attempt shape the governor consumes. */
function project(verified, mutateAuthority = null) {
  return verified.attempts.map((attempt, i) => ({
    index: attempt.index, status: attempt.cohortStatus,
    sessionId: attempt.cohortStatus === 'COMPLETED' ? attempt.sessionId : null,
    failureCode: attempt.failureCode,
    replacementOf: i === 0 ? null : verified.attempts[i - 1].cohortStatus === 'FAILED' ? i : null,
    attestationFingerprint: attempt.attestation?.fingerprint ?? null,
    attemptAuthority: mutateAuthority
      ? mutateAuthority(Object.isFrozen(attempt.authority) ? attempt.authority : null, i)
      : (Object.isFrozen(attempt.authority) ? attempt.authority : null),
  }));
}

/** Everything the cohort governor needs, resolved from the stage-C authority. */
function cohortInputs() {
  const { resolution } = state;
  const { verified } = canonicalAttemptHistory({ resolution, cwd: state.fixture.dir });
  const attestations = verified.attempts.filter(a => a.cohortStatus === 'COMPLETED').map(a => a.attestation);
  const approvalAuthority = { approvalCommit: resolution.approvalCommit, approvalEpoch: resolution.approvalEpoch,
    approvalFingerprint: resolution.approvalFingerprint, t0: resolution.t0 };
  return { resolution, verified, attestations, approvalAuthority,
    plan: planSealedCohort({ seal: resolution.seal, approvalAuthority }) };
}

function govern(resolution, plan, attempts, attestations, approvalAuthority) {
  return deriveCanonicalCohortMembership({ plan, attempts, seal: resolution.seal,
    authority: resolution.authority, attestations, approvalAuthority, continuation: resolution.continuationContext });
}

test('cohort: Attempt 1 (S5/A2) and Attempt 2 (S6/C1) both enter canonical membership', () => {
  const { resolution, verified, attestations, approvalAuthority, plan } = cohortInputs();
  assert.equal(verified.attemptsUsed, 2);
  assert.equal(verified.completedCount, 2);
  assert.deepEqual(verified.grandfatheredAttempts, [1]);

  const authorities = historyAttemptAuthorityIndex(verified);
  assert.equal(authorities.length, 2, 'one authenticated authority per COMPLETED attempt');
  const [first, second] = authorities;
  // Attempt 1 keeps the HISTORICAL identity and carries no continuation.
  assert.equal(first.index, 1);
  assert.equal(first.grandfathered, true);
  assert.equal(first.sealFingerprint, state.fixture.seal.fingerprint);
  assert.equal(first.continuationFingerprint, null);
  // Attempt 2 carries the CURRENT identity and the C1 fingerprint.
  assert.equal(second.index, 2);
  assert.equal(second.grandfathered, false);
  assert.equal(second.sealFingerprint, state.seal6.fingerprint);
  assert.equal(second.continuationFingerprint, state.record.fingerprint);
  // BOTH share the same scientific approval A2 and the same original T0.
  assert.equal(first.approvalCommit, second.approvalCommit);
  assert.equal(first.t0, second.t0);

  const { canonicalMembership } = govern(resolution, plan, project(verified), attestations, approvalAuthority);
  assert.equal(canonicalMembership.length, 2, 'both attempts are canonical cohort members');
});

test('cohort: a forged Attempt 1 S6 identity fails closed', () => {
  const { resolution, verified, attestations, approvalAuthority, plan } = cohortInputs();
  const forged = project(verified, (authority, i) => i === 0 && authority
    // FORGERY: relabel the grandfathered Attempt 1 with the CURRENT S6 identity.
    ? Object.freeze({ ...authority, sealFingerprint: state.seal6.fingerprint,
        protocolCommit: state.seal6.protocolCommit, protocolTree: state.seal6.protocolTree,
        sealAuthorityCommit: state.s6, continuationFingerprint: state.record.fingerprint })
    : authority);
  let code = null;
  try { govern(resolution, plan, forged, attestations, approvalAuthority); } catch (error) { code = String(error.message); }
  assert.ok(code !== null && /SEAL_MISMATCH/.test(code), 'a forged Attempt 1 S6 identity must fail closed, got ' + code);
});

test('cohort: a forged Attempt 2 S5 identity fails closed', () => {
  const { resolution, verified, attestations, approvalAuthority, plan } = cohortInputs();
  const forged = project(verified, (authority, i) => i === 1 && authority
    // FORGERY: relabel the post-C1 Attempt 2 with the HISTORICAL S5 identity.
    ? Object.freeze({ ...authority, sealFingerprint: state.fixture.seal.fingerprint,
        protocolCommit: state.fixture.seal.protocolCommit, protocolTree: state.fixture.seal.protocolTree,
        sealAuthorityCommit: state.fixture.sealCommit, continuationFingerprint: null })
    : authority);
  let code = null;
  try { govern(resolution, plan, forged, attestations, approvalAuthority); } catch (error) { code = String(error.message); }
  assert.ok(code !== null && /SEAL_MISMATCH/.test(code), 'a forged Attempt 2 S5 identity must fail closed, got ' + code);
});

test('cohort: a cross-continuation replay fails closed', () => {
  const { resolution, verified, attestations, approvalAuthority, plan } = cohortInputs();
  const replayed = project(verified, (authority, i) => i === 1 && authority
    // REPLAY: Attempt 2 claims a DIFFERENT continuation fingerprint.
    ? Object.freeze({ ...authority, continuationFingerprint: 'b'.repeat(64) })
    : authority);
  let code = null;
  try { govern(resolution, plan, replayed, attestations, approvalAuthority); } catch (error) { code = String(error.message); }
  assert.ok(code !== null && /CONTINUATION/.test(code), 'a cross-continuation replay must fail closed, got ' + code);
});

test('cohort: governance refuses a completed attempt with no authenticated per-attempt authority', () => {
  const { resolution, verified, attestations, approvalAuthority, plan } = cohortInputs();
  // Under a continuation the per-attempt authority is mandatory: a caller may not
  // drop it and silently fall back to the current seal for every attempt.
  const stripped = project(verified, () => null);
  throwsCode('missing per-attempt authority',
    () => govern(resolution, plan, stripped, attestations, approvalAuthority),
    'R4_GOVERNANCE_ATTEMPT_AUTHORITY_MISSING');
});

/* =============================================================================
 * CANONICAL ANALYSIS AT STAGE C
 *
 * The pre-repair code required `resolution.stage === 'A'`, so after C1 the final
 * canonical analysis would have been impossible even with a working continuation.
 * These tests prove stage A and C are the only accepted stages, that the stage-C
 * authority keeps A2 as the scientific approval identity, and that the canonical
 * reference/source verification runs over the mixed cohort under per-attempt
 * authority.
 * ========================================================================== */

test('analysis: only stages A and C are accepted by the canonical analysis', () => {
  // The guard itself. Read the AUTHORITY module (not this test file) so the
  // assertion cannot be self-fulfilling, and pin BOTH the accepted stages and the
  // frozen refusal code for any other stage (notably pre-approval stage S).
  const source = readFileSync(new URL('./r4-canonical-analysis.mjs', import.meta.url), 'utf8');
  assert.match(source, /if \(resolution\.stage !== 'A' && resolution\.stage !== 'C'\) fail\('R4_CANONICAL_ANALYSIS_REQUIRES_APPROVAL_AUTHORITY'\);/);
  // Stage C is genuinely reachable end-to-end: the fixture below resolves at C and
  // its authority drives the canonical reference/source verification. Stage A
  // remains reachable: `validate:r4-approval-fingerprint` F18-F20 exercise the full
  // analysis at stage A. No other stage is accepted.
  assert.equal(state.resolution.stage, 'C');
});

test('analysis: a stage-C authority carries A2 as the scientific approval identity', () => {
  // Re-resolve the CURRENT stage-C authority (the cached fixture resolution predates
  // Attempt 2) so the assertions describe the live runtime.
  const resolution = resolveR4ExecutionAuthority({ cwd: state.fixture.dir, requireApproval: true });
  assert.equal(resolution.stage, 'C', 'the post-repair fixture resolves at stage C');
  // The RUNTIME authority is the continuation runtime.
  assert.equal(resolution.seal.fingerprint, state.seal6.fingerprint);
  assert.equal(resolution.continuationFingerprint, state.record.fingerprint);
  // The SCIENTIFIC approval identity is unchanged A2 with its original T0.
  assert.equal(resolution.approvalCommit, state.old.resolution.approvalCommit);
  assert.equal(resolution.approvalEpoch, state.old.resolution.approvalEpoch);
  assert.equal(resolution.approvalFingerprint, state.old.resolution.approvalFingerprint);
  assert.equal(resolution.t0, state.old.resolution.t0);
  // The continuation record itself proves no re-anchor and no extra budget.
  assert.equal(resolution.continuation.t0Source, 'INHERITED_FROM_BOUND_APPROVAL_EPOCH_T0');
  assert.equal(resolution.continuation.reanchorsT0, false);
  assert.equal(resolution.continuation.newAttemptBudget, 0);
  assert.equal(resolution.continuation.maxAttempts, 8);
  assert.equal(resolution.continuation.targetCompletedSessions, 6);
  assert.equal(resolution.continuation.priorApproval.approvalCommit, state.old.resolution.approvalCommit);
});

test('analysis: the continuation context identifies stage C without collapsing attempt authority', () => {
  const { resolution, verified } = cohortInputs();
  const authorities = historyAttemptAuthorityIndex(verified);
  assert.equal(resolution.continuationContext.generation, 1);
  assert.equal(resolution.continuationContext.fingerprint, state.record.fingerprint);
  assert.equal(authorities.length, 2);
  assert.equal(authorities[0].sealFingerprint, state.fixture.seal.fingerprint);
  assert.equal(authorities[1].sealFingerprint, state.seal6.fingerprint);
  // Both share the unchanged A2 approval identity and T0.
  assert.equal(new Set(authorities.map(a => a.approvalCommit)).size, 1);
  assert.equal(new Set(authorities.map(a => a.t0)).size, 1);
});

test('analysis: canonical reference/source verification accepts the mixed cohort under per-attempt authority', () => {
  // Drive the real reference-set builder over BOTH sessions with the authenticated
  // per-session authority index, proving the grandfathered session is verified
  // under historical S5/A2 while the post-C1 session is verified under S6/C1.
  const { resolution, verified } = cohortInputs();
  const authorities = historyAttemptAuthorityIndex(verified);
  const attestations = verified.attempts.filter(a => a.cohortStatus === 'COMPLETED').map(a => a.attestation);
  const approvalAuthority = { approvalCommit: resolution.approvalCommit, approvalEpoch: resolution.approvalEpoch,
    approvalFingerprint: resolution.approvalFingerprint, t0: resolution.t0 };
  const membership = verified.attempts.filter(a => a.cohortStatus === 'COMPLETED').map(a => a.sessionId).sort();
  const set = buildCanonicalReferenceSetFromEvidence({
    seal: resolution.seal, authority: resolution.authority, approvalAuthority,
    canonicalMembership: membership, attestations, sessionRoot: '.evolve/market-intelligence/sessions',
    cwd: state.fixture.dir, attemptAuthorities: authorities, continuation: resolution.continuationContext });
  assert.equal(set.sessionIds.length, 2, 'both the historical and the post-C1 session are canonical sources');
  assert.deepEqual([...set.canonicalMembership].sort(), membership);
  // Every source was verified under a real per-attempt authority (a proof came back).
  assert.equal(set.verified.length, 2);
  for (const entry of set.verified) assert.ok(entry.proof);
});

test('analysis: reference verification refuses a membership entry with no authenticated authority', () => {
  const { resolution, verified } = cohortInputs();
  const attestations = verified.attempts.filter(a => a.cohortStatus === 'COMPLETED').map(a => a.attestation);
  const approvalAuthority = { approvalCommit: resolution.approvalCommit, approvalEpoch: resolution.approvalEpoch,
    approvalFingerprint: resolution.approvalFingerprint, t0: resolution.t0 };
  const membership = verified.attempts.filter(a => a.cohortStatus === 'COMPLETED').map(a => a.sessionId).sort();
  const base = { seal: resolution.seal, authority: resolution.authority, approvalAuthority,
    canonicalMembership: membership, attestations, sessionRoot: '.evolve/market-intelligence/sessions',
    cwd: state.fixture.dir, continuation: resolution.continuationContext };
  // A continuation with no authority index at all is refused outright.
  throwsCode('membership without authority index',
    () => buildCanonicalReferenceSetFromEvidence({ ...base, attemptAuthorities: null }),
    'R4_ATTEMPT_AUTHORITY_INDEX_REQUIRED');
  // A partially-populated index is refused per session, never silently defaulted to
  // the current seal for the missing one.
  throwsCode('membership with partial authority index',
    () => buildCanonicalReferenceSetFromEvidence({ ...base, attemptAuthorities: historyAttemptAuthorityIndex(verified).slice(0, 1) }),
    'R4_ATTEMPT_AUTHORITY_MISSING_FOR_SESSION');
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
