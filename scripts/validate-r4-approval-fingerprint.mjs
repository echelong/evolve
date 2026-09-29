#!/usr/bin/env node
// R4 approval-fingerprint self-containment regression matrix (enforcement only).
//
// The missed-window renewal review left one provenance NOTE open: capture and
// governance artifacts bound `approvalCommit` + `approvalEpoch`, but the exact
// approval ARTIFACT was identified only indirectly. This validator proves the
// approval fingerprint is now carried and VERIFIED at every production boundary
// (authorization, claim, proof, receipt, terminal, attestation, attempt history,
// cohort plan / canonical membership, outcome-run binding, canonical analysis),
// and that a wrong fingerprint fails even when commit and epoch are correct.
//
// It also proves the fingerprint is never caller-controlled: on the production
// path it is always the fingerprint of the approval artifact located through the
// resolved Git authority, and no option key can replace it.
//
// Synthetic temporary fixtures only: real temporary Git repositories with a
// genuine P -> S -> A chain and a local bare `origin` (no network), synthetic
// evidence roots under `mkdtemp`. Nothing in this repository's `.evolve` is read
// or written, no capture is started, and no real approval, T0 or outcome is
// created.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, digest } from './market-intelligence/definition.mjs';
import { resolveR4ExecutionAuthority } from './r4-approval.mjs';
import {
  createAttemptAuthorization, writeAttemptAuthorization, acquireRunnerCapability, proveCapability, assertAttemptAuthorization,
  assertAttemptClaim, assertClaimBindsAuthorization, assertSessionReceipt, createSessionReceipt,
} from './r4-capability.mjs';
import { createSessionAttestation } from './r4-attestation.mjs';
import {
  loadR4AttemptHistory, verifyR4AttemptHistory, historyToCohortAttempts, historyAttestations,
} from './r4-attempt-history.mjs';
import { authorizeSealedAttempt, issueSealedAttemptAuthorization, parseRunnerArgs, main as runnerMain } from './r4-cohort-run.mjs';
import { runCanonicalR4Analysis, R4_CANONICAL_ANALYSIS_FORBIDDEN_INPUTS } from './r4-canonical-analysis.mjs';
import {
  buildOutcomeRunBinding, verifyOutcomeRunBinding, evaluateSealedCohortProgress, planSealedCohort, buildCanonicalReferenceSet,
} from './r4-enforcement.mjs';
import { readSourceSession } from './market-outcomes/index.mjs';
import {
  syntheticAuthorityRepo, syntheticChildSpawn, buildSyntheticEvidenceSession, capabilityDescriptor, makeWritable, removeTree,
  SYNTHETIC_MINT,
} from './r4-synthetic-authority.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOUR = 3_600_000;
const CAPTURE = ['capture', '--execute'];
/** A syntactically valid but WRONG approval fingerprint (never an artifact digest). */
const WRONG = 'a'.repeat(64);

const cleanups = [];
const scratch = () => { const dir = mkdtempSync(path.join(tmpdir(), 'evolve-r4-fingerprint-')); cleanups.push(dir); return dir; };
const synth = (options = {}) => { const fixture = syntheticAuthorityRepo(options); cleanups.push(fixture.root); return fixture; };
const attemptTime = (fixture, index) => (index === 1 ? fixture.t0 + 60_000 : fixture.t0 + (index - 1) * HOUR);
const attemptsDir = dir => path.join(dir, '.evolve/governance/r4-attempts');
const attestationsDir = dir => path.join(dir, '.evolve/governance/r4-attestations');
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file, value) => writeFileSync(file, canonical(value) + '\n');
/** Re-seal a mutated record so the mutation itself is the ONLY anomaly. */
const refingerprint = record => { const content = { ...record }; delete content.fingerprint; return { ...content, fingerprint: digest(content) }; };

function evidenceCopy(fixture) {
  const dir = scratch();
  cpSync(path.join(fixture.dir, '.evolve'), path.join(dir, '.evolve'), { recursive: true });
  makeWritable(dir);
  return dir;
}

/** Run one attempt through the REAL runner with an in-process claiming child. */
function runAttempt(fixture, index, behaviour = 'complete') {
  const now = attemptTime(fixture, index);
  try {
    const result = runnerMain(CAPTURE, { env: {}, now, cwd: fixture.dir, clock: () => now + 1000,
      spawn: syntheticChildSpawn({ behaviour, now, sessionStartAt: now }) });
    return { result, error: null };
  } catch (error) { return { result: null, error }; }
}

function childClaim(fixture, capability, now, cwd = fixture.dir) {
  const descriptor = capabilityDescriptor(capability, scratch());
  try { return acquireRunnerCapability({ fd: descriptor.fd, cwd, now }); } finally { descriptor.close(); }
}

function resolution(fixture) {
  return resolveR4ExecutionAuthority({ cwd: fixture.dir, requireApproval: true });
}
function verifiedHistory(fixture, evidenceRoot = fixture.dir) {
  const r = resolution(fixture);
  return verifyR4AttemptHistory(loadR4AttemptHistory({ cwd: evidenceRoot }), { seal: r.seal, authority: r.authority,
    approvalCommit: r.approvalCommit, approvalEpoch: r.approvalEpoch ?? null,
    approvalFingerprint: r.approvalFingerprint ?? null, t0: r.t0 });
}

/* ------------------------------------------------------------- matrix */

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const throwsCode = (fn, prefix) => assert.throws(fn, error => String(error?.message ?? error).startsWith(prefix), `expected ${prefix}`);

/* ============ 1: the resolved authority carries the approval fingerprint ============ */

test('F1: the resolved authority carries the fingerprint of the approval artifact in Git', () => {
  const fixture = synth();
  const r = resolution(fixture);
  assert.match(r.approvalFingerprint, /^[0-9a-f]{64}$/);
  // It is the artifact's own content digest, recomputed from the artifact read
  // back out of Git — never a value the caller supplied.
  const onDisk = readJson(path.join(fixture.dir, 'governance/r4/r4-precapture-approval.json'));
  assert.equal(r.approvalFingerprint, onDisk.fingerprint);
  const content = { ...onDisk }; delete content.fingerprint;
  assert.equal(r.approvalFingerprint, digest(content));
  assert.equal(r.approvalEpoch, 1);
});

/* ============ 2: authorization ============ */

test('F2: an authorization carries the resolved approval fingerprint', () => {
  const fixture = synth();
  const r = resolution(fixture);
  const now = attemptTime(fixture, 1);
  const authorized = authorizeSealedAttempt({ argv: CAPTURE, env: {}, now, cwd: fixture.dir });
  const { authorization } = issueSealedAttemptAuthorization({ authorized, now });
  assert.equal(authorization.approvalFingerprint, r.approvalFingerprint);
  assert.equal(authorization.approvalCommit, r.approvalCommit);
  assert.equal(authorization.approvalEpoch, r.approvalEpoch);
  assertAttemptAuthorization(authorization);
});

test('F3: an authorization with a WRONG approval fingerprint is refused', () => {
  const fixture = synth();
  const now = attemptTime(fixture, 1);
  const authorized = authorizeSealedAttempt({ argv: CAPTURE, env: {}, now, cwd: fixture.dir });
  const { authorization } = issueSealedAttemptAuthorization({ authorized, now });
  // A differently bound authorization for the same index is write-once refused.
  throwsCode(() => writeAttemptAuthorization(authorization, { cwd: fixture.dir }), 'R4_ATTEMPT_AUTHORIZATION_EXISTS');
  // Re-sealing the persisted authorization with a wrong approval fingerprint is
  // refused by history, even though approvalCommit and approvalEpoch stay correct.
  const copy = evidenceCopy(fixture);
  writeJson(path.join(attemptsDir(copy), 'attempt-1.json'), refingerprint({ ...authorization, approvalFingerprint: WRONG }));
  throwsCode(() => verifiedHistory(fixture, copy), 'R4_HISTORY_APPROVAL_FINGERPRINT_MISMATCH');
  // The original, correctly bound authorization is untouched.
  assert.equal(verifiedHistory(fixture).attempts[0].state, 'AUTHORIZED');
});

test('F4: a malformed approval fingerprint is rejected structurally', () => {
  const fixture = synth();
  const now = attemptTime(fixture, 1);
  const authorized = authorizeSealedAttempt({ argv: CAPTURE, env: {}, now, cwd: fixture.dir });
  const { authorization } = issueSealedAttemptAuthorization({ authorized, now });
  for (const bad of ['not-a-digest', '', 'A'.repeat(64)]) {
    throwsCode(() => createAttemptAuthorization({ seal: authorized.resolution.seal, authority: authorized.resolution.authority,
      approvalCommit: authorized.resolution.approvalCommit, approvalEpoch: authorized.resolution.approvalEpoch,
      approvalFingerprint: bad, attemptIndex: 2, sessionId: authorization.sessionId, t0: authorized.resolution.t0,
      capabilityHash: authorization.capabilityHash, captureSpecDigest: authorized.resolution.seal.captureSpecDigest }),
    'R4_CAPABILITY_APPROVAL_FINGERPRINT_INVALID');
  }
});

/* ============ 3: claim / proof / receipt ============ */

test('F5: a claim and proof carry the authorization approval fingerprint', () => {
  const fixture = synth();
  const now = attemptTime(fixture, 1);
  const authorized = authorizeSealedAttempt({ argv: CAPTURE, env: {}, now, cwd: fixture.dir });
  const { capability, authorization } = issueSealedAttemptAuthorization({ authorized, now });
  const sealed = childClaim(fixture, capability, now);
  assert.equal(sealed.approvalFingerprint, authorization.approvalFingerprint);
  const claim = readJson(path.join(attemptsDir(fixture.dir), 'attempt-1.claim.json'));
  assert.equal(claim.approvalFingerprint, authorization.approvalFingerprint);
  assertAttemptClaim(claim);
  assertClaimBindsAuthorization(claim, authorization);
});

test('F6: a claim whose approval fingerprint differs from its authorization is refused', () => {
  const fixture = synth();
  const now = attemptTime(fixture, 1);
  const authorized = authorizeSealedAttempt({ argv: CAPTURE, env: {}, now, cwd: fixture.dir });
  const { capability, authorization } = issueSealedAttemptAuthorization({ authorized, now });
  const sealed = childClaim(fixture, capability, now);
  const claim = readJson(path.join(attemptsDir(fixture.dir), 'attempt-1.claim.json'));
  const tampered = refingerprint({ ...claim, approvalFingerprint: WRONG });
  assertAttemptClaim(tampered);
  throwsCode(() => assertClaimBindsAuthorization(tampered, authorization), 'R4_CLAIM_IDENTITY_MISMATCH');
  // The proof derived from the persisted record still carries the true value.
  assert.equal(sealed.approvalFingerprint, authorization.approvalFingerprint);
  const proof = proveCapability({ capability, record: authorization });
  assert.equal(proof.approvalFingerprint, authorization.approvalFingerprint);
});

/* ============ 4: terminal / attempt history ============ */

test('F7: a completed run writes a terminal record carrying the approval fingerprint', () => {
  const fixture = synth();
  const run = runAttempt(fixture, 1, 'complete');
  assert.equal(run.error, null, String(run.error?.message));
  const terminal = readJson(path.join(attemptsDir(fixture.dir), 'attempt-1.terminal.json'));
  const r = resolution(fixture);
  assert.equal(terminal.approvalFingerprint, r.approvalFingerprint);
  assert.equal(verifiedHistory(fixture).attempts[0].state, 'COMPLETED');
});

test('F8: a terminal record with a WRONG approval fingerprint fails history verification', () => {
  const fixture = synth();
  const run = runAttempt(fixture, 1, 'complete');
  assert.equal(run.error, null, String(run.error?.message));
  const copy = evidenceCopy(fixture);
  const file = path.join(attemptsDir(copy), 'attempt-1.terminal.json');
  writeJson(file, refingerprint({ ...readJson(file), approvalFingerprint: WRONG }));
  throwsCode(() => verifiedHistory(fixture, copy), 'R4_HISTORY_APPROVAL_FINGERPRINT_MISMATCH');
  // The untouched evidence still verifies.
  assert.equal(verifiedHistory(fixture).attempts[0].state, 'COMPLETED');
});

test('F9: an authorization record with a WRONG approval fingerprint fails history verification', () => {
  const fixture = synth();
  const run = runAttempt(fixture, 1, 'complete');
  assert.equal(run.error, null, String(run.error?.message));
  const copy = evidenceCopy(fixture);
  const file = path.join(attemptsDir(copy), 'attempt-1.json');
  writeJson(file, refingerprint({ ...readJson(file), approvalFingerprint: WRONG }));
  throwsCode(() => verifiedHistory(fixture, copy), 'R4_HISTORY_APPROVAL_FINGERPRINT_MISMATCH');
});

test('F10: history reports the approval fingerprint it verified against', () => {
  const fixture = synth();
  const run = runAttempt(fixture, 1, 'complete');
  assert.equal(run.error, null, String(run.error?.message));
  const r = resolution(fixture);
  assert.equal(verifiedHistory(fixture).authority.approvalFingerprint, r.approvalFingerprint);
});

/* ============ 5: attestation ============ */

test('F11: an attestation carries the resolved approval fingerprint', () => {
  const fixture = synth();
  const now = attemptTime(fixture, 1);
  const authorized = authorizeSealedAttempt({ argv: CAPTURE, env: {}, now, cwd: fixture.dir });
  const { capability } = issueSealedAttemptAuthorization({ authorized, now });
  const sealed = childClaim(fixture, capability, now);
  const open = createSessionAttestation({ seal: authorized.resolution.seal, authority: authorized.resolution.authority,
    approvalAuthority: authorized.resolution, proof: sealed });
  assert.equal(open.approvalFingerprint, authorized.resolution.approvalFingerprint);
});

test('F12: an attestation with a WRONG approval fingerprint is refused by the cohort governor', () => {
  const fixture = synth();
  const run = runAttempt(fixture, 1, 'complete');
  assert.equal(run.error, null, String(run.error?.message));
  const r = resolution(fixture);
  const history = verifiedHistory(fixture);
  const plan = planSealedCohort({ seal: r.seal, approvalAuthority: r });
  // Re-seal the persisted attestation with a wrong approval fingerprint and let the
  // governor authenticate it against the resolved authority. commit+epoch agree.
  const attestation = readJson(path.join(attestationsDir(fixture.dir), `${run.result.sessionId}.json`));
  const tampered = refingerprint({ ...attestation, approvalFingerprint: WRONG });
  const attempts = historyToCohortAttempts(history).map(attempt =>
    (attempt.status === 'COMPLETED' ? { ...attempt, attestationFingerprint: tampered.fingerprint } : attempt));
  throwsCode(() => evaluateSealedCohortProgress({ plan, attempts, seal: r.seal, authority: r.authority,
    attestations: [tampered], approvalAuthority: r }), 'R4_ATTESTATION_APPROVAL_FINGERPRINT_MISMATCH');
  // The genuine attestation still yields the canonical membership.
  const progress = evaluateSealedCohortProgress({ plan, attempts: historyToCohortAttempts(history), seal: r.seal,
    authority: r.authority, attestations: historyAttestations(history), approvalAuthority: r });
  assert.deepEqual(progress.canonicalMembership, [run.result.sessionId]);
});

test('F13: an attestation whose proof carries a different approval fingerprint is refused', () => {
  const fixture = synth();
  const now = attemptTime(fixture, 1);
  const authorized = authorizeSealedAttempt({ argv: CAPTURE, env: {}, now, cwd: fixture.dir });
  const { capability } = issueSealedAttemptAuthorization({ authorized, now });
  const sealed = childClaim(fixture, capability, now);
  throwsCode(() => createSessionAttestation({ seal: authorized.resolution.seal, authority: authorized.resolution.authority,
    approvalAuthority: authorized.resolution, proof: { ...sealed, approvalFingerprint: WRONG } }),
  'R4_ATTESTATION_APPROVAL_FINGERPRINT_MISMATCH');
});

/* ============ 6: cohort plan / canonical membership ============ */

test('F14: the sealed cohort plan carries the approval fingerprint of the resolved authority', () => {
  const fixture = synth();
  const r = resolution(fixture);
  const plan = planSealedCohort({ seal: r.seal, approvalAuthority: r });
  assert.equal(plan.approvalFingerprint, r.approvalFingerprint);
  assert.equal(plan.approvalCommit, r.approvalCommit);
});

test('F15: a cohort plan with a WRONG approval fingerprint is refused', () => {
  const fixture = synth();
  const run = runAttempt(fixture, 1, 'complete');
  assert.equal(run.error, null, String(run.error?.message));
  const r = resolution(fixture);
  const history = verifiedHistory(fixture);
  const plan = { ...planSealedCohort({ seal: r.seal, approvalAuthority: r }), approvalFingerprint: WRONG };
  throwsCode(() => evaluateSealedCohortProgress({ plan, attempts: historyToCohortAttempts(history), seal: r.seal,
    authority: r.authority, attestations: historyAttestations(history), approvalAuthority: r }),
  'R4_PLAN_APPROVAL_FINGERPRINT_MISMATCH');
  // The correctly bound plan yields the canonical membership.
  const progress = evaluateSealedCohortProgress({ plan: planSealedCohort({ seal: r.seal, approvalAuthority: r }),
    attempts: historyToCohortAttempts(history), seal: r.seal, authority: r.authority,
    attestations: historyAttestations(history), approvalAuthority: r });
  assert.deepEqual(progress.canonicalMembership, [run.result.sessionId]);
});

/* ============ 7: outcome-run binding ============ */

function bindingInputs(fixture, sessionId, { approvalFingerprint } = {}) {
  const r = resolution(fixture);
  const session = readSourceSession({ dir: path.join(fixture.dir, '.evolve/market-intelligence/sessions', sessionId), role: 'cohort' });
  const { references } = buildCanonicalReferenceSet({ sessions: [session], canonicalMembership: [session.sessionId] });
  const binding = buildOutcomeRunBinding({ seal: r.seal, authority: r.authority,
    approvalAuthority: { approvalCommit: r.approvalCommit,
      approvalFingerprint: approvalFingerprint === undefined ? r.approvalFingerprint : approvalFingerprint },
    cohortMembership: [session.sessionId], references });
  const outcomes = references.map((reference, i) => ({ referenceSessionId: reference.sessionId,
    referenceSnapshotDigest: reference.snapshotDigest, status: 'resolved', absLogReturn300sBps: i + 1,
    mint: SYNTHETIC_MINT, referenceObservedAt: reference.referenceObservedAt ?? 0 }));
  return { binding, outcomes, references };
}

test('F16: an outcome-run binding carries the approval fingerprint', () => {
  const fixture = synth();
  const run = runAttempt(fixture, 1, 'complete');
  assert.equal(run.error, null, String(run.error?.message));
  const r = resolution(fixture);
  const { binding } = bindingInputs(fixture, run.result.sessionId);
  assert.equal(binding.approvalFingerprint, r.approvalFingerprint);
});

test('F17: an outcome-run binding with a WRONG approval fingerprint is refused', () => {
  const fixture = synth();
  const run = runAttempt(fixture, 1, 'complete');
  assert.equal(run.error, null, String(run.error?.message));
  const r = resolution(fixture);
  const good = bindingInputs(fixture, run.result.sessionId);
  const { binding } = bindingInputs(fixture, run.result.sessionId, { approvalFingerprint: WRONG });
  const history = verifiedHistory(fixture);
  const plan = planSealedCohort({ seal: r.seal, approvalAuthority: r });
  const args = { seal: r.seal, authority: r.authority, approvalAuthority: r, cohortMembership: [run.result.sessionId], references: good.references };
  throwsCode(() => verifyOutcomeRunBinding({ ...args, binding }), 'R4_BINDING_APPROVAL_FINGERPRINT_MISMATCH');
  // The correctly bound one still verifies.
  assert.equal(verifyOutcomeRunBinding({ ...args, binding: good.binding }).ok, true);
  assert.equal(history.attempts[0].state, 'COMPLETED');
  assert.equal(plan.approvalFingerprint, r.approvalFingerprint);
});

/* ============ 8: canonical analysis ============ */

test('F18: the canonical analysis result identity carries the resolved approval fingerprint', () => {
  const fixture = synth();
  const run = runAttempt(fixture, 1, 'complete');
  assert.equal(run.error, null, String(run.error?.message));
  const r = resolution(fixture);
  const { binding, outcomes } = bindingInputs(fixture, run.result.sessionId);
  const result = runCanonicalR4Analysis({ repoRoot: fixture.dir, outcomeRunBinding: binding, outcomes });
  assert.equal(result.identity.approvalFingerprint, r.approvalFingerprint);
  assert.equal(result.identity.approvalCommit, r.approvalCommit);
  assert.equal(result.identity.approvalEpoch, r.approvalEpoch);
});

test('F19: a canonical analysis whose binding carries a WRONG approval fingerprint is refused', () => {
  const fixture = synth();
  const run = runAttempt(fixture, 1, 'complete');
  assert.equal(run.error, null, String(run.error?.message));
  const { binding, outcomes } = bindingInputs(fixture, run.result.sessionId, { approvalFingerprint: WRONG });
  // The binding itself is refused first, at the internal-authority boundary.
  throwsCode(() => runCanonicalR4Analysis({ repoRoot: fixture.dir, outcomeRunBinding: binding, outcomes }),
    'R4_BINDING_APPROVAL_FINGERPRINT_MISMATCH');
});

test('F20: a canonical analysis whose EVIDENCE carries a wrong approval fingerprint is refused', () => {
  const fixture = synth();
  const run = runAttempt(fixture, 1, 'complete');
  assert.equal(run.error, null, String(run.error?.message));
  const r = resolution(fixture);
  const { binding, outcomes } = bindingInputs(fixture, run.result.sessionId);
  // Re-point the analysis at a scratch evidence root whose attempt-1 authorization
  // was re-sealed with a wrong approval fingerprint. commit+epoch stay correct.
  const copy = evidenceCopy(fixture);
  const file = path.join(attemptsDir(copy), 'attempt-1.json');
  writeJson(file, refingerprint({ ...readJson(file), approvalFingerprint: WRONG }));
  assert.equal(r.approvalFingerprint, resolution(fixture).approvalFingerprint);
  throwsCode(() => runCanonicalR4Analysis({ repoRoot: fixture.dir, evidenceRoot: copy, outcomeRunBinding: binding, outcomes }),
    'R4_HISTORY_APPROVAL_FINGERPRINT_MISMATCH');
});

/* ============ 9: no caller can override the canonical fingerprint ============ */

test('F21: a caller cannot supply the approval fingerprint to the canonical analysis', () => {
  assert(R4_CANONICAL_ANALYSIS_FORBIDDEN_INPUTS.includes('approvalFingerprint'),
    'approvalFingerprint is a forbidden canonical-analysis input');
  assert(R4_CANONICAL_ANALYSIS_FORBIDDEN_INPUTS.includes('approvalAuthority'));
  for (const key of ['approvalFingerprint', 'approvalAuthority', 'approvalCommit']) {
    throwsCode(() => runCanonicalR4Analysis({ repoRoot: REPO, [key]: WRONG }),
      'R4_CANONICAL_ANALYSIS_AUTHORITY_INPUT_FORBIDDEN');
  }
});

test('F22: the runner derives the fingerprint from the resolved authority, not from its arguments', () => {
  const fixture = synth();
  const now = attemptTime(fixture, 1);
  const r = resolution(fixture);
  // No runner option can carry a fingerprint; the authorization still binds the
  // fingerprint of the approval located through the resolved Git authority.
  for (const argv of [[...CAPTURE], [...CAPTURE, '--attempt', '1']]) {
    const authorized = authorizeSealedAttempt({ argv, env: {}, now, cwd: fixture.dir });
    assert.equal(authorized.resolution.approvalFingerprint, r.approvalFingerprint);
  }
  const authorized = authorizeSealedAttempt({ argv: CAPTURE, env: {}, now, cwd: fixture.dir });
  const { authorization } = issueSealedAttemptAuthorization({ authorized, now });
  assert.equal(authorization.approvalFingerprint, r.approvalFingerprint);
  // ...and no option may try to select one.
  for (const option of ['--approval-fingerprint', '--approvalFingerprint', '--approval-commit', '--seal-fingerprint']) {
    throwsCode(() => parseRunnerArgs([...CAPTURE, option, WRONG]), 'R4_RUNNER_ARGUMENT_UNSUPPORTED');
  }
});

test('F23: a receipt must agree with the authorization approval fingerprint', () => {
  const fixture = synth();
  const now = attemptTime(fixture, 1);
  const authorized = authorizeSealedAttempt({ argv: CAPTURE, env: {}, now, cwd: fixture.dir });
  const { capability, authorization } = issueSealedAttemptAuthorization({ authorized, now });
  const sealed = childClaim(fixture, capability, now);
  const { manifest } = buildSyntheticEvidenceSession({ cwd: fixture.dir, sessionId: sealed.sessionId, startAt: now });
  const receipt = createSessionReceipt({ authorizationFingerprint: authorization.fingerprint, capabilityHash: sealed.capabilityHash,
    claimFingerprint: sealed.claimFingerprint, sessionId: manifest.sessionId, sessionFingerprint: manifest.fingerprint,
    approvalFingerprint: authorization.approvalFingerprint });
  assert.equal(receipt.approvalFingerprint, authorization.approvalFingerprint);
  assertSessionReceipt(receipt, { proof: sealed, record: authorization, claim: sealed.claim });
  // A receipt restating a different approval is refused.
  const forged = refingerprint({ ...receipt, approvalFingerprint: WRONG });
  throwsCode(() => assertSessionReceipt(forged, { proof: sealed, record: authorization, claim: sealed.claim }),
    'R4_RECEIPT_APPROVAL_FINGERPRINT_MISMATCH');
  // A receipt omitting the approval fingerprint is also refused.
  const stripped = { ...receipt };
  delete stripped.fingerprint;
  delete stripped.approvalFingerprint;
  throwsCode(() => assertSessionReceipt({ ...stripped, fingerprint: digest(stripped) }, { proof: sealed, record: authorization, claim: sealed.claim }),
    'R4_RECEIPT_APPROVAL_FINGERPRINT_MISMATCH');
});

/* ------------------------------------------------------------- report */

let failed = 0;
let executed = 0;
const failures = [];
for (const [name, fn] of tests) {
  executed++;
  try { fn(); console.log(`PASS ${name}`); }
  catch (error) { failed++; failures.push(name); console.error(`FAIL ${name}: ${String(error?.message ?? error).split('\n')[0]}`); }
}
for (const root of cleanups) { try { removeTree(root); } catch { /* best effort */ } }

console.log('');
console.log(`R4 approval fingerprint: ${executed - failed}/${executed} executed case(s) passed, ${failed} failure(s); synthetic temporary fixtures only`);
if (failed) { console.error(`failures: ${failures.join(', ')}`); process.exitCode = 1; }
