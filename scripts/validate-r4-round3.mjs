#!/usr/bin/env node
// R4 independent pre-capture re-review ROUND 3 regression matrix.
//
// Every case maps to a round-3 blocker (P1-1 capability replay / double-spend,
// P1-2 out-of-order attempt authorization, P1-3 caller-forged A authority in the
// canonical analysis, P2-1 cached remote proof) or to the enforcement contract
// of the round-3 remediation (atomic claim, terminal records, canonical attempt
// history, live remote proof, closed canonical analysis, fail-closed order,
// package-lock binding, seal tamper sweep).
//
// Synthetic temporary fixtures only: real temporary Git repositories with a
// genuine P -> S -> A chain and a local bare `origin` (no network), synthetic
// evidence roots under `mkdtemp`, in-process or real child processes that stop
// at the claim/environment boundary. No .evolve evidence of this repository is
// read or written, no provider/network capture is started, no real cohort
// attempt, T0, approval or outcome is created.
import assert from 'node:assert/strict';
import { spawn as spawnAsync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { canonical, digest } from './market-intelligence/definition.mjs';
import { readSourceSession } from './market-outcomes/index.mjs';
import { buildSeal, verifyR4Seal, gitIdentity } from './r4-preregistration-seal.mjs';
import { R4_REQUIRED_BOUND_FILES, captureSpecDigest } from './r4-protocol-spec.mjs';
import { assertLiveRemoteMainEquals, liveRemoteMainSha } from './r4-authority.mjs';
import { resolveR4ExecutionAuthority } from './r4-approval.mjs';
import {
  createAttemptCapability, capabilityHash, createAttemptAuthorization, writeAttemptAuthorization, claimAttemptAuthorization,
  acquireRunnerCapability, proveCapability, readAttemptClaim, readAttemptAuthorization, assertClaimBindsAuthorization,
  deriveSessionId, R4_CLAIMANTS,
} from './r4-capability.mjs';
import { createSessionAttestation, finalizeSessionAttestation } from './r4-attestation.mjs';
import {
  loadR4AttemptHistory, verifyR4AttemptHistory, deriveNextAttempt, historyToCohortAttempts, historyAttestations,
  writeAttemptTerminal, R4_TERMINAL_STATES,
} from './r4-attempt-history.mjs';
import {
  main as runnerMain, authorizeSealedAttempt, issueSealedAttemptAuthorization, parseRunnerArgs, recoverSealedAttempts,
} from './r4-cohort-run.mjs';
import { runCanonicalR4Analysis, R4_CANONICAL_ANALYSIS_FORBIDDEN_INPUTS } from './r4-canonical-analysis.mjs';
import { buildCanonicalReferenceSet, buildOutcomeRunBinding, evaluateSealedCohortProgress, planSealedCohort } from './r4-enforcement.mjs';
import {
  syntheticAuthorityRepo, syntheticChildSpawn, buildSyntheticEvidenceSession, capabilityDescriptor, removeTree, makeWritable,
  SYNTHETIC_MINT,
} from './r4-synthetic-authority.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOUR = 3_600_000;
const CAPTURE_SCRIPT = path.join(REPO, 'scripts/market-intelligence.mjs');
const CAPABILITY_MODULE_URL = pathToFileURL(path.join(REPO, 'scripts/r4-capability.mjs')).href;

/* ------------------------------------------------------------ fixtures */

const cleanups = [];
const scratch = () => { const dir = mkdtempSync(path.join(tmpdir(), 'evolve-r4-round3-')); cleanups.push(dir); return dir; };
const synth = (options = {}) => { const fixture = syntheticAuthorityRepo(options); cleanups.push(fixture.root); return fixture; };

const CAPTURE = ['capture', '--execute'];
const attemptTime = (fixture, index) => (index === 1 ? fixture.t0 + 60_000 : fixture.t0 + (index - 1) * HOUR);

/** Run one attempt through the REAL runner with an in-process claiming child. */
function runAttempt(fixture, index, behaviour, { argv = CAPTURE } = {}) {
  const now = attemptTime(fixture, index);
  let capability = null;
  try {
    const result = runnerMain(argv, { env: {}, now, cwd: fixture.dir, clock: () => now + 1000,
      spawn: syntheticChildSpawn({ behaviour, now, sessionStartAt: now, onClaim: sealed => { capability = sealed.capability; } }) });
    return { result, error: null, capability, now };
  } catch (error) { return { result: null, error, capability, now }; }
}

/** Authorize + persist the next attempt, as the runner does right before it spawns. */
function issueNext(fixture, now, argv = CAPTURE) {
  const authorized = authorizeSealedAttempt({ argv, env: {}, now, cwd: fixture.dir });
  return { authorized, ...issueSealedAttemptAuthorization({ authorized, now }) };
}

/** The capture child's REAL claim primitive, delivered over a descriptor. */
function childClaim(fixture, capability, now, cwd = fixture.dir) {
  const descriptor = capabilityDescriptor(capability, scratch());
  try { return acquireRunnerCapability({ fd: descriptor.fd, cwd, now }); } finally { descriptor.close(); }
}

function verifiedHistory(fixture, evidenceRoot = fixture.dir) {
  const resolution = resolveR4ExecutionAuthority({ cwd: fixture.dir, requireApproval: true });
  return verifyR4AttemptHistory(loadR4AttemptHistory({ cwd: evidenceRoot }), { seal: resolution.seal, authority: resolution.authority,
    approvalCommit: resolution.approvalCommit, t0: resolution.t0 });
}

function persistentAttemptArtifacts(dir) {
  const out = [];
  for (const sub of ['.evolve/governance/r4-attempts', '.evolve/governance/r4-attestations', '.evolve/market-intelligence/sessions']) {
    try { for (const name of readdirSync(path.join(dir, sub))) out.push(`${sub}/${name}`); } catch { /* absent */ }
  }
  return out;
}

/** A writable scratch copy of a fixture's evidence root (for tamper cases). */
function evidenceCopy(fixture) {
  const dir = scratch();
  cpSync(path.join(fixture.dir, '.evolve'), path.join(dir, '.evolve'), { recursive: true });
  makeWritable(dir);
  return dir;
}

const attemptsDir = dir => path.join(dir, '.evolve/governance/r4-attempts');
const attestationsDir = dir => path.join(dir, '.evolve/governance/r4-attestations');
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file, value) => writeFileSync(file, canonical(value) + '\n');
const refingerprint = record => { const content = { ...record }; delete content.fingerprint; return { ...content, fingerprint: digest(content) }; };

/* ------------------------------------------------------------- matrix */

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const throwsCode = (fn, prefix) => assert.throws(fn, error => String(error?.message ?? error).startsWith(prefix), `expected ${prefix}`);
const codeOf = fn => { try { fn(); return null; } catch (error) { return String(error?.message ?? error); } };

/* ===================== CAPABILITY (P1-1) ===================== */

test('M1 / 2A: sequential replay of the same capability is rejected (first claim wins)', () => {
  const fixture = synth();
  const now = attemptTime(fixture, 1);
  const { capability, authorization } = issueNext(fixture, now);
  const first = childClaim(fixture, capability, now);
  assert.equal(first.attemptIndex, 1);
  assert.equal(first.claim.claimant, R4_CLAIMANTS.child);
  const claimBytes = readFileSync(path.join(attemptsDir(fixture.dir), 'attempt-1.claim.json'));
  throwsCode(() => childClaim(fixture, capability, now + 1), 'R4_CAPABILITY_ALREADY_CLAIMED');
  throwsCode(() => claimAttemptAuthorization({ record: authorization, capability, cwd: fixture.dir, now: now + 2 }), 'R4_CAPABILITY_ALREADY_CLAIMED');
  assert.deepEqual(readFileSync(path.join(attemptsDir(fixture.dir), 'attempt-1.claim.json')), claimBytes, 'claim is immutable');
  assert.equal(statSync(path.join(attemptsDir(fixture.dir), 'attempt-1.claim.json')).mode & 0o777, 0o400);
  assert.equal(statSync(path.join(attemptsDir(fixture.dir), 'attempt-1.json')).mode & 0o777, 0o400);
});

test('M1b / 2A: a replayed capability is refused by the REAL capture process before any session/storage/provider', () => {
  const fixture = synth();
  const now = attemptTime(fixture, 1);
  const { capability, authorization } = issueNext(fixture, now);
  childClaim(fixture, capability, now); // the first (winning) consumer
  const descriptor = capabilityDescriptor(capability, scratch());
  let result;
  try {
    result = spawnSync(process.execPath, [CAPTURE_SCRIPT, 'capture', '--r4-revisits', '--minutes', '45'], {
      cwd: fixture.dir, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe', descriptor.fd],
      // Safety net: a sealed-value drift that would stop capture right after a
      // (wrongly) successful claim, before storage or network. It must never be
      // reached here because the claim itself is refused.
      env: { PATH: process.env.PATH, HOME: process.env.HOME, EVOLVE_INTELLIGENCE_ALIGNMENT_MS: '1' },
    });
  } finally { descriptor.close(); }
  assert.equal(result.status, 1);
  assert.match(result.stderr, /capture failed: OBSERVATION_FAILED/);
  assert.equal(existsSync(path.join(fixture.dir, '.evolve/market-intelligence')), false, 'loser never created storage');
  assert.equal(readAttemptClaim({ attemptIndex: 1, cwd: fixture.dir }).claimant, R4_CLAIMANTS.child);
  assert.equal(authorization.attemptIndex, 1);
});

const CONCURRENT_CHILD = `
const [moduleUrl, cwd, now, startAt] = process.argv.slice(2);
const { acquireRunnerCapability } = await import(moduleUrl);
while (Date.now() < Number(startAt)) { /* barrier */ }
try {
  const sealed = acquireRunnerCapability({ fd: 3, cwd, now: Number(now) });
  process.stdout.write(JSON.stringify({ ok: sealed !== null, claim: sealed?.claimFingerprint ?? null }));
} catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: String(error.message) })); }
`;

function runChild(args, fd, { script = null, env = process.env } = {}) {
  return new Promise(resolve => {
    const child = spawnAsync(process.execPath, script ? [script, ...args] : args, { stdio: ['ignore', 'pipe', 'pipe', fd], env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

test('M2 / 2B: concurrent double-spend of the same capability has EXACTLY ONE winner (real processes)', async () => {
  const seal = buildSeal({ ...gitIdentity(REPO), sealedAt: 1_800_000_000_000 });
  const authority = { protocolCommit: seal.protocolCommit, protocolTree: seal.protocolTree, sealAuthorityCommit: 'a'.repeat(40) };
  const childScript = path.join(scratch(), 'claim-child.mjs');
  writeFileSync(childScript, CONCURRENT_CHILD);
  const ROUNDS = 12;
  const RACERS = 4;
  let winners = 0;
  for (let round = 0; round < ROUNDS; round++) {
    const cwd = scratch();
    const capability = createAttemptCapability();
    const hash = capabilityHash(capability);
    const t0 = 1_900_000_000_000;
    const record = createAttemptAuthorization({ seal, authority, approvalCommit: 'b'.repeat(40), attemptIndex: 2,
      sessionId: deriveSessionId({ sealFingerprint: seal.fingerprint, approvalCommit: 'b'.repeat(40), attemptIndex: 2, capabilityHash: hash }),
      t0, capabilityHash: hash, captureSpecDigest: captureSpecDigest(), authorizedAt: t0 + HOUR, previousTerminalFingerprint: 'c'.repeat(64) });
    writeAttemptAuthorization(record, { cwd });
    const descriptors = Array.from({ length: RACERS }, () => capabilityDescriptor(capability, scratch()));
    const startAt = Date.now() + 400;
    try {
      const results = await Promise.all(descriptors.map(descriptor => runChild([CAPABILITY_MODULE_URL, cwd, String(t0 + HOUR + 1), String(startAt)], descriptor.fd, { script: childScript })));
      const parsed = results.map(result => JSON.parse(result.stdout));
      const ok = parsed.filter(entry => entry.ok);
      assert.equal(ok.length, 1, `round ${round}: exactly one winner, got ${JSON.stringify(parsed)}`);
      assert(parsed.filter(entry => !entry.ok).every(entry => entry.code === 'R4_CAPABILITY_ALREADY_CLAIMED'), JSON.stringify(parsed));
      assert.equal(readAttemptClaim({ attemptIndex: 2, cwd }).fingerprint, ok[0].claim);
      winners += ok.length;
    } finally { for (const descriptor of descriptors) descriptor.close(); }
  }
  assert.equal(winners, ROUNDS);
  console.log(`      concurrent double-spend: ${ROUNDS} rounds x ${RACERS} racing processes -> ${winners} winners, ${ROUNDS * (RACERS - 1)} rejected`);
});

test('M2b / 2B: two REAL capture processes racing one capability: one claim, zero sessions, zero storage', async () => {
  const fixture = synth();
  runAttempt(fixture, 1, 'fail');
  const now = attemptTime(fixture, 2);
  const { capability, authorization } = issueNext(fixture, now);
  const descriptors = [capabilityDescriptor(capability, scratch()), capabilityDescriptor(capability, scratch())];
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, EVOLVE_INTELLIGENCE_ALIGNMENT_MS: '1' };
  let results;
  try {
    results = await Promise.all(descriptors.map(descriptor => new Promise(resolve => {
      const child = spawnAsync(process.execPath, [CAPTURE_SCRIPT, 'capture', '--r4-revisits', '--minutes', '45'],
        { cwd: fixture.dir, env, stdio: ['ignore', 'pipe', 'pipe', descriptor.fd] });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('close', status => resolve({ status, stderr }));
    })));
  } finally { for (const descriptor of descriptors) descriptor.close(); }
  assert(results.every(result => result.status === 1), JSON.stringify(results));
  const claims = readdirSync(attemptsDir(fixture.dir)).filter(name => name.endsWith('.claim.json'));
  assert.deepEqual(claims.sort(), ['attempt-1.claim.json', 'attempt-2.claim.json']);
  assert.equal(readAttemptClaim({ attemptIndex: 2, cwd: fixture.dir }).claimant, R4_CLAIMANTS.child);
  assert.equal(existsSync(path.join(fixture.dir, '.evolve/market-intelligence')), false);
  assert.equal(authorization.attemptIndex, 2);
});

test('M3 / 2C: a crash immediately after the atomic claim leaves the capability non-replayable', () => {
  const fixture = synth();
  const now = attemptTime(fixture, 1);
  const { capability, authorization } = issueNext(fixture, now);
  childClaim(fixture, capability, now); // ... and the process dies here
  throwsCode(() => childClaim(fixture, capability, now + 10), 'R4_CAPABILITY_ALREADY_CLAIMED');
  throwsCode(() => claimAttemptAuthorization({ record: authorization, claimant: R4_CLAIMANTS.recovery, cwd: fixture.dir, now: now + 20 }), 'R4_CAPABILITY_ALREADY_CLAIMED');
  const history = verifiedHistory(fixture);
  assert.equal(history.attempts[0].state, 'CLAIMED');
  assert.equal(history.attempts[0].cohortStatus, 'FAILED');
  const next = deriveNextAttempt(history);
  assert.equal(next.blocked, true);
  assert.equal(next.reason, 'R4_PREVIOUS_ATTEMPT_NOT_TERMINAL');
});

test('M4 / 2D: a claim without a session root counts as a consumed, FAILED attempt', () => {
  const fixture = synth();
  const now = attemptTime(fixture, 1);
  const { capability } = issueNext(fixture, now);
  const sealed = childClaim(fixture, capability, now);
  assert.equal(existsSync(path.join(fixture.dir, '.evolve/market-intelligence/sessions', sealed.sessionId)), false);
  const history = verifiedHistory(fixture);
  assert.deepEqual(historyToCohortAttempts(history).map(({ index, status, failureCode }) => ({ index, status, failureCode })),
    [{ index: 1, status: 'FAILED', failureCode: 'R4_ATTEMPT_CLAIMED_WITHOUT_TERMINAL' }]);
  // Deterministic recovery: terminal FAILED, never a reuse; D4 then allows attempt 2.
  const recovery = recoverSealedAttempts({ argv: ['recover', '--execute'], now: now + 5000, cwd: fixture.dir });
  assert.equal(recovery.recovered, 1);
  assert.equal(recovery.terminal.state, 'FAILED');
  assert.equal(recovery.terminal.failureCode, 'R4_ATTEMPT_RECOVERED_CLAIMED_WITHOUT_TERMINAL');
  assert.equal(recovery.next.nextAttemptIndex, 2);
  assert.equal(recovery.next.replacementOf, 1);
  throwsCode(() => childClaim(fixture, capability, now + 6000), 'R4_CAPABILITY_ALREADY_CLAIMED');
});

test('M5 / 2E: a claim whose session exists but whose attestation is absent counts as FAILED', () => {
  const fixture = synth();
  const now = attemptTime(fixture, 1);
  const { capability } = issueNext(fixture, now);
  const sealed = childClaim(fixture, capability, now);
  buildSyntheticEvidenceSession({ cwd: fixture.dir, sessionId: sealed.sessionId, startAt: now });
  // Runner crashed before settling: no attestation, no terminal.
  const history = verifiedHistory(fixture);
  assert.equal(history.attempts[0].state, 'CLAIMED');
  assert.equal(history.attempts[0].attestation, null);
  const plan = planSealedCohort({ seal: fixture.seal, approvalAuthority: { approvalCommit: fixture.approvalCommit, t0: fixture.t0 } });
  const resolution = resolveR4ExecutionAuthority({ cwd: fixture.dir, requireApproval: true });
  const progress = evaluateSealedCohortProgress({ plan, attempts: historyToCohortAttempts(history), seal: resolution.seal,
    authority: resolution.authority, attestations: historyAttestations(history), approvalAuthority: resolution });
  assert.deepEqual(progress.canonicalMembership, []);
  assert.equal(progress.completedCount, 0);
  throwsCode(() => childClaim(fixture, capability, now + 1), 'R4_CAPABILITY_ALREADY_CLAIMED');
});

test('M6 / 2F: replay of a COMPLETED attempt capability is rejected', () => {
  const fixture = synth();
  const run = runAttempt(fixture, 1, 'complete');
  assert.equal(run.error, null, String(run.error?.message));
  assert.equal(verifiedHistory(fixture).attempts[0].state, 'COMPLETED');
  throwsCode(() => childClaim(fixture, run.capability, run.now + 10), 'R4_CAPABILITY_ALREADY_CLAIMED');
});

test('M7 / 2G: replay of a FAILED attempt capability is rejected', () => {
  const fixture = synth();
  const run = runAttempt(fixture, 1, 'fail');
  assert.match(String(run.error?.message), /R4_SEALED_CAPTURE_CHILD_FAILED/);
  const history = verifiedHistory(fixture);
  assert.equal(history.attempts[0].state, 'FAILED');
  assert.equal(history.attempts[0].terminal.failureCode, 'R4_SEALED_CAPTURE_CHILD_FAILED');
  throwsCode(() => childClaim(fixture, run.capability, run.now + 10), 'R4_CAPABILITY_ALREADY_CLAIMED');
});

test('2H: deleting or mutating a claim in a scratch evidence copy fails integrity verification', () => {
  const fixture = synth();
  const run = runAttempt(fixture, 1, 'complete');
  assert.equal(run.error, null);
  const deleted = evidenceCopy(fixture);
  rmSync(path.join(attemptsDir(deleted), 'attempt-1.claim.json'));
  throwsCode(() => verifiedHistory(fixture, deleted), 'R4_HISTORY_ATTESTATION_WITHOUT_CLAIM');
  // Even with the claim deleted, the same capability cannot be claimed again:
  // downstream consumption evidence (terminal/session/receipt/attestation) exists.
  throwsCode(() => childClaim(fixture, run.capability, run.now + 10, deleted), 'R4_CAPABILITY_ALREADY_CLAIMED');
  const mutated = evidenceCopy(fixture);
  const claimFile = path.join(attemptsDir(mutated), 'attempt-1.claim.json');
  writeJson(claimFile, { ...readJson(claimFile), claimedAt: readJson(claimFile).claimedAt + 1 });
  throwsCode(() => verifiedHistory(fixture, mutated), 'R4_HISTORY_RECORD_TAMPERED');
  const refingerprinted = evidenceCopy(fixture);
  const refFile = path.join(attemptsDir(refingerprinted), 'attempt-1.claim.json');
  writeJson(refFile, refingerprint({ ...readJson(refFile), claimedAt: readJson(refFile).claimedAt + 1 }));
  throwsCode(() => verifiedHistory(fixture, refingerprinted), 'R4_HISTORY_ATTESTATION_WITHOUT_CLAIM');
  // The untouched original still verifies.
  assert.equal(verifiedHistory(fixture).attempts[0].state, 'COMPLETED');
});

test('2I: a capability for another attempt cannot claim or prove it', () => {
  const fixture = synth();
  const first = runAttempt(fixture, 1, 'fail');
  const now = attemptTime(fixture, 2);
  const { authorization: second } = issueNext(fixture, now);
  throwsCode(() => claimAttemptAuthorization({ record: second, capability: first.capability, cwd: fixture.dir, now }), 'R4_CAPABILITY_MISMATCH');
  throwsCode(() => proveCapability({ capability: first.capability, record: second }), 'R4_CAPABILITY_MISMATCH');
  throwsCode(() => childClaim(fixture, first.capability, now), 'R4_CAPABILITY_ALREADY_CLAIMED');
});

test('2J: a wrong capability is rejected', () => {
  const fixture = synth();
  const now = attemptTime(fixture, 1);
  const { authorization } = issueNext(fixture, now);
  throwsCode(() => childClaim(fixture, randomBytes(32), now), 'R4_CAPABILITY_NOT_AUTHORIZED');
  throwsCode(() => claimAttemptAuthorization({ record: authorization, capability: randomBytes(32), cwd: fixture.dir, now }), 'R4_CAPABILITY_MISMATCH');
  throwsCode(() => claimAttemptAuthorization({ record: authorization, capability: randomBytes(31), cwd: fixture.dir, now }), 'R4_CAPABILITY_LENGTH_INVALID');
  assert.equal(readAttemptClaim({ attemptIndex: 1, cwd: fixture.dir }), null, 'a wrong capability consumes nothing');
});

test('crash semantics: an authorization no child claimed is consumed by the runner and FAILED', () => {
  const fixture = synth();
  const run = runAttempt(fixture, 1, 'no-claim');
  assert.match(String(run.error?.message), /R4_ATTEMPT_NEVER_CLAIMED/);
  const history = verifiedHistory(fixture);
  assert.equal(history.attempts[0].claim.claimant, R4_CLAIMANTS.runnerAbandon);
  assert.equal(history.attempts[0].terminal.failureCode, 'R4_ATTEMPT_NEVER_CLAIMED');
  assert.equal(deriveNextAttempt(history).nextAttemptIndex, 2);
});

test('crash semantics: runner crash before spawn -> recover consumes the authorization; the capability stays dead', () => {
  const fixture = synth();
  const now = attemptTime(fixture, 1);
  const { capability } = issueNext(fixture, now);
  throwsCode(() => authorizeSealedAttempt({ argv: CAPTURE, env: {}, now: now + 1, cwd: fixture.dir }), 'R4_PREVIOUS_ATTEMPT_NOT_TERMINAL');
  throwsCode(() => recoverSealedAttempts({ argv: ['recover'], now: now + 2, cwd: fixture.dir }), 'R4_RECOVER_REQUIRES_EXECUTE');
  const recovery = recoverSealedAttempts({ argv: ['recover', '--execute'], now: now + 3, cwd: fixture.dir });
  assert.equal(recovery.terminal.failureCode, 'R4_ATTEMPT_RECOVERED_UNCLAIMED');
  assert.equal(readAttemptClaim({ attemptIndex: 1, cwd: fixture.dir }).claimant, R4_CLAIMANTS.recovery);
  throwsCode(() => childClaim(fixture, capability, now + 4), 'R4_CAPABILITY_ALREADY_CLAIMED');
  assert.equal(recoverSealedAttempts({ argv: ['recover', '--execute'], now: now + 5, cwd: fixture.dir }).recovered, null);
});

test('crash semantics: an attempt-1 child claim outside [T0, T0+5min) is refused and the attempt FAILS', () => {
  const fixture = synth();
  const now = attemptTime(fixture, 1);
  const { capability } = issueNext(fixture, now);
  throwsCode(() => childClaim(fixture, capability, fixture.t0 + 300_000), 'R4_CLAIM_ATTEMPT1_START_WINDOW_MISSED');
  throwsCode(() => childClaim(fixture, capability, fixture.t0 - 1), 'R4_CLAIM_BEFORE_T0');
  assert.equal(readAttemptClaim({ attemptIndex: 1, cwd: fixture.dir }), null);
});

/* ===================== ATTEMPT ORDER (P1-2) ===================== */

test('M8: attempt 2 before attempt 1 is rejected (inside the window and at T0-1ms), zero artifacts', () => {
  const fixture = synth();
  throwsCode(() => authorizeSealedAttempt({ argv: [...CAPTURE, '--attempt', '2'], env: {}, now: fixture.t0 + 60_000, cwd: fixture.dir }), 'R4_ATTEMPT_NOT_NEXT');
  throwsCode(() => authorizeSealedAttempt({ argv: [...CAPTURE, '--attempt', '2'], env: {}, now: fixture.t0 - 1, cwd: fixture.dir }), 'R4_COHORT_BEFORE_T0');
  throwsCode(() => runnerMain([...CAPTURE, '--attempt', '2'], { env: {}, now: fixture.t0 + 60_000, cwd: fixture.dir, spawn: () => { throw new Error('SPAWN_REACHED'); } }), 'R4_ATTEMPT_NOT_NEXT');
  assert.deepEqual(persistentAttemptArtifacts(fixture.dir), []);
});

test('M9: attempt 8 before attempt 1 is rejected (inside the window and at T0-1ms), zero artifacts', () => {
  const fixture = synth();
  throwsCode(() => authorizeSealedAttempt({ argv: [...CAPTURE, '--attempt', '8'], env: {}, now: fixture.t0 + 60_000, cwd: fixture.dir }), 'R4_ATTEMPT_NOT_NEXT');
  throwsCode(() => authorizeSealedAttempt({ argv: [...CAPTURE, '--attempt', '8'], env: {}, now: fixture.t0 - 1, cwd: fixture.dir }), 'R4_COHORT_BEFORE_T0');
  assert.deepEqual(persistentAttemptArtifacts(fixture.dir), []);
});

test('M10: attempt 2 while attempt 1 is nonterminal (AUTHORIZED, then CLAIMED) is rejected', () => {
  const fixture = synth();
  const now = attemptTime(fixture, 1);
  const { capability } = issueNext(fixture, now);
  for (const argv of [CAPTURE, [...CAPTURE, '--attempt', '2']]) throwsCode(() => authorizeSealedAttempt({ argv, env: {}, now: now + 1000, cwd: fixture.dir }), 'R4_PREVIOUS_ATTEMPT_NOT_TERMINAL');
  childClaim(fixture, capability, now);
  throwsCode(() => authorizeSealedAttempt({ argv: CAPTURE, env: {}, now: now + HOUR, cwd: fixture.dir }), 'R4_PREVIOUS_ATTEMPT_NOT_TERMINAL');
  assert.equal(readAttemptAuthorization({ attemptIndex: 2, cwd: fixture.dir }), null);
});

test('M11: a missing attempt 3 followed by attempt 4 is rejected', () => {
  const fixture = synth();
  runAttempt(fixture, 1, 'fail');
  runAttempt(fixture, 2, 'fail');
  throwsCode(() => authorizeSealedAttempt({ argv: [...CAPTURE, '--attempt', '4'], env: {}, now: attemptTime(fixture, 3), cwd: fixture.dir }), 'R4_ATTEMPT_NOT_NEXT');
  // A forged attempt-4 record (valid shape, chained to attempt 2) creates a gap.
  const history = verifiedHistory(fixture);
  const capability = createAttemptCapability();
  const hash = capabilityHash(capability);
  const forged = createAttemptAuthorization({ seal: fixture.seal, authority: { protocolCommit: fixture.protocolCommit, protocolTree: fixture.seal.protocolTree, sealAuthorityCommit: fixture.sealCommit },
    approvalCommit: fixture.approvalCommit, attemptIndex: 4, sessionId: deriveSessionId({ sealFingerprint: fixture.seal.fingerprint, approvalCommit: fixture.approvalCommit, attemptIndex: 4, capabilityHash: hash }),
    t0: fixture.t0, capabilityHash: hash, captureSpecDigest: captureSpecDigest(), authorizedAt: attemptTime(fixture, 4), previousTerminalFingerprint: history.attempts[1].terminal.fingerprint });
  writeAttemptAuthorization(forged, { cwd: fixture.dir });
  throwsCode(() => verifiedHistory(fixture), 'R4_HISTORY_INDEX_GAP');
  throwsCode(() => authorizeSealedAttempt({ argv: CAPTURE, env: {}, now: attemptTime(fixture, 5), cwd: fixture.dir }), 'R4_HISTORY_INDEX_GAP');
});

test('M12: duplicate attempt authorization is rejected (O_EXCL write, racing runners, forged duplicate)', () => {
  const fixture = synth();
  const now = attemptTime(fixture, 1);
  const authorized = authorizeSealedAttempt({ argv: CAPTURE, env: {}, now, cwd: fixture.dir });
  const first = issueSealedAttemptAuthorization({ authorized, now });
  // A second runner that passed the same gates cannot authorize the same index.
  throwsCode(() => issueSealedAttemptAuthorization({ authorized, now }), 'R4_ATTEMPT_AUTHORIZATION_EXISTS');
  throwsCode(() => writeAttemptAuthorization(first.authorization, { cwd: fixture.dir }), 'R4_ATTEMPT_AUTHORIZATION_EXISTS');
  // A forged second record reusing the same capability hash is a duplicate.
  const copy = evidenceCopy(fixture);
  const dup = refingerprint({ ...first.authorization, attemptIndex: 2,
    sessionId: deriveSessionId({ sealFingerprint: fixture.seal.fingerprint, approvalCommit: fixture.approvalCommit, attemptIndex: 2, capabilityHash: first.authorization.capabilityHash }) });
  writeJson(path.join(attemptsDir(copy), 'attempt-2.json'), dup);
  throwsCode(() => verifiedHistory(fixture, copy), 'R4_HISTORY_DUPLICATE_AUTHORIZATION');
  const misnamed = evidenceCopy(fixture);
  writeJson(path.join(attemptsDir(misnamed), 'attempt-2.json'), first.authorization);
  throwsCode(() => verifiedHistory(fixture, misnamed), 'R4_HISTORY_RECORD_NAME_MISMATCH');
});

test('M13: the next legal replacement attempt is accepted in a synthetic fixture (D4 ordering)', () => {
  const fixture = synth();
  runAttempt(fixture, 1, 'fail');
  const next = deriveNextAttempt(verifiedHistory(fixture));
  assert.equal(next.nextAttemptIndex, 2);
  assert.equal(next.replacementOf, 1);
  // Explicit assertion of the derived index is accepted; no clock rule applies
  // to replacements (ordering, not market state, determines eligibility).
  const authorized = authorizeSealedAttempt({ argv: [...CAPTURE, '--attempt', '2'], env: {}, now: attemptTime(fixture, 2), cwd: fixture.dir });
  assert.equal(authorized.attemptIndex, 2);
  assert.equal(authorized.startWindow.rule, 'ORDERING_NOT_MARKET_STATE');
  const run = runAttempt(fixture, 2, 'complete', { argv: [...CAPTURE, '--attempt', '2'] });
  assert.equal(run.error, null, String(run.error?.message));
  const history = verifiedHistory(fixture);
  assert.deepEqual(history.attempts.map(attempt => attempt.state), ['FAILED', 'COMPLETED']);
  const cohortAttempts = historyToCohortAttempts(history);
  assert.equal(cohortAttempts[1].replacementOf, 1);
  const resolution = resolveR4ExecutionAuthority({ cwd: fixture.dir, requireApproval: true });
  const progress = evaluateSealedCohortProgress({ plan: planSealedCohort({ seal: resolution.seal, approvalAuthority: resolution }),
    attempts: cohortAttempts, seal: resolution.seal, authority: resolution.authority, attestations: historyAttestations(history), approvalAuthority: resolution });
  assert.deepEqual(progress.canonicalMembership, [history.attempts[1].sessionId]);
  assert.equal(history.attempts[1].authorization.previousTerminalFingerprint, history.attempts[0].terminal.fingerprint);
});

test('M14: an attempt after six completed sessions is rejected', () => {
  const fixture = synth();
  for (let index = 1; index <= 6; index++) { const run = runAttempt(fixture, index, 'complete'); assert.equal(run.error, null, `${index}: ${run.error?.message}`); }
  const history = verifiedHistory(fixture);
  assert.equal(history.completedCount, 6);
  const next = deriveNextAttempt(history);
  assert.equal(next.stop, true);
  assert.equal(next.reason, 'R4_COHORT_STOPPED_TARGET_REACHED');
  throwsCode(() => authorizeSealedAttempt({ argv: CAPTURE, env: {}, now: attemptTime(fixture, 7), cwd: fixture.dir }), 'R4_COHORT_STOPPED');
  const capability = createAttemptCapability();
  const hash = capabilityHash(capability);
  const forged = createAttemptAuthorization({ seal: fixture.seal, authority: { protocolCommit: fixture.protocolCommit, protocolTree: fixture.seal.protocolTree, sealAuthorityCommit: fixture.sealCommit },
    approvalCommit: fixture.approvalCommit, attemptIndex: 7, sessionId: deriveSessionId({ sealFingerprint: fixture.seal.fingerprint, approvalCommit: fixture.approvalCommit, attemptIndex: 7, capabilityHash: hash }),
    t0: fixture.t0, capabilityHash: hash, captureSpecDigest: captureSpecDigest(), authorizedAt: attemptTime(fixture, 7), previousTerminalFingerprint: history.attempts[5].terminal.fingerprint });
  writeAttemptAuthorization(forged, { cwd: fixture.dir });
  throwsCode(() => verifiedHistory(fixture), 'R4_HISTORY_ATTEMPT_AFTER_COHORT_STOPPED');
});

test('M15: attempt 9 is rejected (argument, budget exhausted, forged record)', () => {
  throwsCode(() => parseRunnerArgs([...CAPTURE, '--attempt', '9']), 'R4_RUNNER_ATTEMPT_INDEX_INVALID');
  throwsCode(() => parseRunnerArgs([...CAPTURE, '--attempt', '0']), 'R4_RUNNER_ATTEMPT_INDEX_INVALID');
  const fixture = synth();
  for (let index = 1; index <= 8; index++) runAttempt(fixture, index, 'fail');
  const history = verifiedHistory(fixture);
  assert.equal(history.attemptsUsed, 8);
  assert.equal(deriveNextAttempt(history).reason, 'R4_COHORT_ATTEMPT_BUDGET_EXHAUSTED');
  throwsCode(() => authorizeSealedAttempt({ argv: CAPTURE, env: {}, now: attemptTime(fixture, 9), cwd: fixture.dir }), 'R4_COHORT_STOPPED');
  const capability = createAttemptCapability();
  const hash = capabilityHash(capability);
  const forged = createAttemptAuthorization({ seal: fixture.seal, authority: { protocolCommit: fixture.protocolCommit, protocolTree: fixture.seal.protocolTree, sealAuthorityCommit: fixture.sealCommit },
    approvalCommit: fixture.approvalCommit, attemptIndex: 9, sessionId: deriveSessionId({ sealFingerprint: fixture.seal.fingerprint, approvalCommit: fixture.approvalCommit, attemptIndex: 9, capabilityHash: hash }),
    t0: fixture.t0, capabilityHash: hash, captureSpecDigest: captureSpecDigest(), authorizedAt: attemptTime(fixture, 9), previousTerminalFingerprint: history.attempts[7].terminal.fingerprint });
  writeAttemptAuthorization(forged, { cwd: fixture.dir });
  throwsCode(() => verifiedHistory(fixture), 'R4_HISTORY_ATTEMPT_OUT_OF_RANGE');
});

/* ===================== REMOTE (P2-1) ===================== */

test('M16 / 7B: a stale cached origin/main == A cannot authorize when the LIVE remote == S', () => {
  const fixture = synth({ remoteMain: 'S', trackingRef: 'A' });
  throwsCode(() => resolveR4ExecutionAuthority({ cwd: fixture.dir, requireApproval: true }), 'R4_AUTHORITY_REMOTE_MAIN_MISMATCH:APPROVAL_COMMIT_A');
  throwsCode(() => authorizeSealedAttempt({ argv: CAPTURE, env: {}, now: fixture.t0 + 60_000, cwd: fixture.dir }), 'R4_AUTHORITY_REMOTE_MAIN_MISMATCH:APPROVAL_COMMIT_A');
  assert.deepEqual(persistentAttemptArtifacts(fixture.dir), []);
  // The reviewer's demonstration: live remote moves while the tracking ref stays.
  const moving = synth({ remoteMain: 'A', trackingRef: 'A' });
  assert.equal(resolveR4ExecutionAuthority({ cwd: moving.dir, requireApproval: true }).remoteSha, moving.approvalCommit);
  moving.setRemoteMain(moving.sealCommit);
  assert.equal(moving.run(['rev-parse', 'refs/remotes/origin/main']), moving.approvalCommit, 'the cache is stale');
  throwsCode(() => resolveR4ExecutionAuthority({ cwd: moving.dir, requireApproval: true }), 'R4_AUTHORITY_REMOTE_MAIN_MISMATCH');
});

test('7C: cached origin/main == S but LIVE remote == A behaves by the exact expected authority', () => {
  const fixture = synth({ remoteMain: 'A', trackingRef: 'S' });
  assert.equal(resolveR4ExecutionAuthority({ cwd: fixture.dir, requireApproval: true }).remoteSha, fixture.approvalCommit);
  // At the S stage the expected authority is S, and the live remote is A.
  throwsCode(() => assertLiveRemoteMainEquals(fixture.sealCommit, { cwd: fixture.dir, what: 'SEAL_COMMIT_S' }), 'R4_AUTHORITY_REMOTE_MAIN_MISMATCH:SEAL_COMMIT_S');
});

test('M17 / 7D / 7E: live remote with the wrong SHA (backwards, ahead, unrelated) is rejected', () => {
  for (const remoteMain of ['P', 'unrelated']) {
    const fixture = synth({ remoteMain });
    throwsCode(() => resolveR4ExecutionAuthority({ cwd: fixture.dir, requireApproval: true }), 'R4_AUTHORITY_REMOTE_MAIN_MISMATCH:APPROVAL_COMMIT_A');
  }
  const ahead = synth({ headAfterA: true, remoteMain: 'X' });
  throwsCode(() => resolveR4ExecutionAuthority({ cwd: ahead.dir, requireApproval: true }), 'R4_AUTHORITY_REMOTE_MAIN_MISMATCH:APPROVAL_COMMIT_A');
  const backwards = synth();
  backwards.setRemoteMain(backwards.sealCommit);
  throwsCode(() => resolveR4ExecutionAuthority({ cwd: backwards.dir, requireApproval: true }), 'R4_AUTHORITY_REMOTE_MAIN_MISMATCH:APPROVAL_COMMIT_A');
});

test('M18 / 7F: an unavailable live remote fails closed', () => {
  const fixture = synth({ remoteMain: 'none', trackingRef: 'A' });
  assert.equal(liveRemoteMainSha({ cwd: fixture.dir }).available, false);
  throwsCode(() => resolveR4ExecutionAuthority({ cwd: fixture.dir, requireApproval: true }), 'R4_AUTHORITY_REMOTE_UNAVAILABLE');
  throwsCode(() => authorizeSealedAttempt({ argv: CAPTURE, env: {}, now: fixture.t0 + 60_000, cwd: fixture.dir }), 'R4_AUTHORITY_REMOTE_UNAVAILABLE');
  throwsCode(() => assertLiveRemoteMainEquals(fixture.approvalCommit, { cwd: fixture.dir, query: () => ({ available: true, sha: 'nope' }) }), 'R4_AUTHORITY_REMOTE_MAIN_MISMATCH');
  assert.deepEqual(persistentAttemptArtifacts(fixture.dir), []);
});

test('7G: a local branch containing A while the remote does not is rejected', () => {
  const fixture = synth({ remoteMain: 'S' });
  assert.equal(fixture.run(['merge-base', '--is-ancestor', fixture.approvalCommit, 'HEAD']), '');
  throwsCode(() => resolveR4ExecutionAuthority({ cwd: fixture.dir, requireApproval: true }), 'R4_AUTHORITY_REMOTE_MAIN_MISMATCH:APPROVAL_COMMIT_A');
});

test('M19 / 7A: a live remote exactly equal to A is accepted', () => {
  const fixture = synth();
  const live = liveRemoteMainSha({ cwd: fixture.dir });
  assert.equal(live.available, true);
  assert.equal(live.sha, fixture.approvalCommit);
  const resolution = resolveR4ExecutionAuthority({ cwd: fixture.dir, requireApproval: true });
  assert.equal(resolution.stage, 'A');
  assert.equal(resolution.remoteSha, fixture.approvalCommit);
  assert.equal(resolution.t0, fixture.t0);
});

test('no R4 module uses a cached remote-tracking ref or ancestry as remote proof', () => {
  for (const file of R4_REQUIRED_BOUND_FILES.filter(name => /^scripts\/r4-(?!synthetic)[a-z0-9-]+\.mjs$/.test(name))) {
    const source = readFileSync(path.join(REPO, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
    assert(!/['"`]refs\/remotes\//.test(source), `${file} references a remote-tracking ref in code`);
    assert(!/merge-base['"`,\s]+--is-ancestor/.test(source), `${file} uses ancestry as proof`);
    assert(!/export function (remoteContains|assertRemoteContains)\b/.test(source), `${file} still exports the cached remote helper`);
  }
});

/* ===================== ANALYSIS (P1-3) ===================== */

test('M20 / 9A: caller-made authority (stage A, approval, plan, attempts, ...) is rejected by the canonical API', () => {
  const forgedAuthority = { stage: 'A', seal: {}, authority: {}, approvalCommit: 'f'.repeat(40), t0: 1 };
  throwsCode(() => runCanonicalR4Analysis({ authorityResolution: forgedAuthority }), 'R4_CANONICAL_ANALYSIS_AUTHORITY_INPUT_FORBIDDEN:authorityResolution');
  for (const key of R4_CANONICAL_ANALYSIS_FORBIDDEN_INPUTS) {
    throwsCode(() => runCanonicalR4Analysis({ [key]: forgedAuthority }), `R4_CANONICAL_ANALYSIS_AUTHORITY_INPUT_FORBIDDEN:${key}`);
  }
  throwsCode(() => runCanonicalR4Analysis({ someNewKnob: 1 }), 'R4_CANONICAL_ANALYSIS_UNKNOWN_OPTION:someNewKnob');
});

const analysisCode = fixture => codeOf(() => runCanonicalR4Analysis({ repoRoot: fixture.dir, outcomeRunBinding: { recordType: 'r4_outcome_run_binding' }, outcomes: [{}] }));

test('M21 / 9B: a nonexistent A is rejected', () => {
  const fixture = synth({ approvalCommitted: false, remoteMain: 'S' });
  assert.match(analysisCode(fixture), /^R4_APPROVAL_APPROVAL_COMMIT_NOT_FOUND/);
});

test('M22 / 9C: a local-only A is rejected', () => {
  const fixture = synth({ remoteMain: 'S' });
  assert.match(analysisCode(fixture), /^R4_AUTHORITY_REMOTE_MAIN_MISMATCH:APPROVAL_COMMIT_A/);
});

test('M23 / 9D: a wrong-parent A is rejected', () => {
  const fixture = synth({ approvalParent: 'intermediate' });
  assert.match(analysisCode(fixture), /^R4_APPROVAL_APPROVAL_COMMIT_NOT_FOUND/);
});

test('9E: an A bound to a superseded seal is rejected (and a superseded tracked seal too)', () => {
  assert.match(analysisCode(synth({ approvalSeal: 'superseded' })), /^R4_APPROVAL_SEAL_MISMATCH/);
  assert.match(analysisCode(synth({ supersededSeal: true })), /^R4_AUTHORITY_SEAL_SUPERSEDED/);
});

test('M24 / 9F: HEAD != A is rejected', () => {
  const fixture = synth({ headAfterA: true, remoteMain: 'A' });
  assert.match(analysisCode(fixture), /^R4_APPROVAL_HEAD_NOT_APPROVAL_COMMIT/);
});

test('M25 / 9G: live remote != A is rejected', () => {
  const fixture = synth({ headAfterA: true, remoteMain: 'X' });
  assert.match(analysisCode(fixture), /^R4_AUTHORITY_REMOTE_MAIN_MISMATCH:APPROVAL_COMMIT_A/);
  const behind = synth();
  behind.setRemoteMain(behind.sealCommit);
  assert.match(analysisCode(behind), /^R4_AUTHORITY_REMOTE_MAIN_MISMATCH:APPROVAL_COMMIT_A/);
});

function analysisInputs(fixture, sessionId, { approvalCommit = null } = {}) {
  const resolution = resolveR4ExecutionAuthority({ cwd: fixture.dir, requireApproval: true });
  const session = readSourceSession({ dir: path.join(fixture.dir, '.evolve/market-intelligence/sessions', sessionId), role: 'cohort' });
  const { references } = buildCanonicalReferenceSet({ sessions: [session], canonicalMembership: [session.sessionId] });
  const binding = buildOutcomeRunBinding({ seal: resolution.seal, authority: resolution.authority,
    approvalAuthority: { approvalCommit: approvalCommit ?? resolution.approvalCommit }, cohortMembership: [session.sessionId], references });
  const outcomes = references.map((reference, i) => ({ referenceSessionId: reference.sessionId, referenceSnapshotDigest: reference.snapshotDigest,
    status: 'resolved', absLogReturn300sBps: i + 1, mint: SYNTHETIC_MINT, referenceObservedAt: reference.referenceObservedAt ?? 0 }));
  return { binding, outcomes, references };
}

test('M26 / 9H: a valid synthetic Git P/S/A chain lets the canonical analysis proceed', () => {
  const fixture = synth();
  const run = runAttempt(fixture, 1, 'complete');
  assert.equal(run.error, null, String(run.error?.message));
  const { binding, outcomes } = analysisInputs(fixture, run.result.sessionId);
  const result = runCanonicalR4Analysis({ repoRoot: fixture.dir, outcomeRunBinding: binding, outcomes });
  assert.equal(result.recordType, 'r4_canonical_analysis_result');
  assert.equal(result.identity.authoritySource, 'RESOLVED_FROM_GIT_LIVE_REMOTE');
  assert.equal(result.identity.approvalCommit, fixture.approvalCommit);
  assert.equal(result.identity.authorityCommit, fixture.sealCommit);
  assert.equal(result.identity.protocolCommit, fixture.protocolCommit);
  assert.equal(result.identity.liveRemoteMain, fixture.approvalCommit);
  assert.equal(result.identity.t0, fixture.t0);
  assert.deepEqual(result.canonicalMembership, [run.result.sessionId]);
});

test('section 10: the outcome binding is verified against the INTERNALLY resolved authority', () => {
  const fixture = synth();
  const run = runAttempt(fixture, 1, 'complete');
  const forged = analysisInputs(fixture, run.result.sessionId, { approvalCommit: 'e'.repeat(40) });
  throwsCode(() => runCanonicalR4Analysis({ repoRoot: fixture.dir, outcomeRunBinding: forged.binding, outcomes: forged.outcomes }), 'R4_BINDING_APPROVAL_COMMIT_MISMATCH');
  // A failed attempt contributes no membership: analysis of a cohort with no
  // completed attempt is refused before any binding/analysis work.
  const empty = synth();
  runAttempt(empty, 1, 'fail');
  throwsCode(() => runCanonicalR4Analysis({ repoRoot: empty.dir, outcomeRunBinding: forged.binding, outcomes: forged.outcomes }), 'R4_CANONICAL_MEMBERSHIP_EMPTY');
});

/* ===================== STATE ===================== */

test('M27: a claim without an authorization is rejected', () => {
  const fixture = synth();
  runAttempt(fixture, 1, 'fail');
  const copy = evidenceCopy(fixture);
  rmSync(path.join(attemptsDir(copy), 'attempt-1.json'));
  throwsCode(() => verifiedHistory(fixture, copy), 'R4_HISTORY_CLAIM_WITHOUT_AUTHORIZATION');
  // The claim primitive refuses a record that is not the persisted authorization.
  const capability = createAttemptCapability();
  const hash = capabilityHash(capability);
  const unpersisted = createAttemptAuthorization({ seal: fixture.seal, authority: { protocolCommit: fixture.protocolCommit, protocolTree: fixture.seal.protocolTree, sealAuthorityCommit: fixture.sealCommit },
    approvalCommit: fixture.approvalCommit, attemptIndex: 2, sessionId: deriveSessionId({ sealFingerprint: fixture.seal.fingerprint, approvalCommit: fixture.approvalCommit, attemptIndex: 2, capabilityHash: hash }),
    t0: fixture.t0, capabilityHash: hash, captureSpecDigest: captureSpecDigest(), authorizedAt: attemptTime(fixture, 2) });
  throwsCode(() => claimAttemptAuthorization({ record: unpersisted, capability, cwd: fixture.dir, now: attemptTime(fixture, 2) }), 'R4_CLAIM_AUTHORIZATION_NOT_PERSISTED');
});

test('M28: a terminal record without a claim is rejected', () => {
  const fixture = synth();
  runAttempt(fixture, 1, 'fail');
  const copy = evidenceCopy(fixture);
  rmSync(path.join(attemptsDir(copy), 'attempt-1.claim.json'));
  throwsCode(() => verifiedHistory(fixture, copy), 'R4_HISTORY_TERMINAL_WITHOUT_CLAIM');
  // The terminal primitive refuses a claim that is not persisted.
  const now = attemptTime(fixture, 2);
  const { authorization } = issueNext(fixture, now);
  const phantom = { ...readAttemptClaim({ attemptIndex: 1, cwd: fixture.dir }) };
  const fakeClaim = refingerprint({ ...phantom, authorizationFingerprint: authorization.fingerprint, capabilityHash: authorization.capabilityHash,
    attemptIndex: 2, sessionId: authorization.sessionId, claimedAt: now });
  throwsCode(() => writeAttemptTerminal({ authorization, claim: fakeClaim, state: R4_TERMINAL_STATES.failed, failureCode: 'X', terminatedAt: now, cwd: fixture.dir }), 'R4_TERMINAL_CLAIM_NOT_PERSISTED');
});

test('M29: an attestation without a claim is rejected (history and finalization)', () => {
  const fixture = synth();
  const run = runAttempt(fixture, 1, 'complete');
  const copy = evidenceCopy(fixture);
  rmSync(path.join(attemptsDir(copy), 'attempt-1.claim.json'));
  throwsCode(() => verifiedHistory(fixture, copy), 'R4_HISTORY_ATTESTATION_WITHOUT_CLAIM');
  // A free-standing attestation for an unclaimed session is rejected too.
  const stray = evidenceCopy(fixture);
  const attestation = readJson(path.join(attestationsDir(stray), `${run.result.sessionId}.json`));
  writeJson(path.join(attestationsDir(stray), 'stray-session.json'), refingerprint({ ...attestation, sessionId: 'stray-session' }));
  throwsCode(() => verifiedHistory(fixture, stray), 'R4_HISTORY_ATTESTATION_WITHOUT_CLAIM');
  // Finalization requires a durable CAPTURE_CHILD claim.
  const resolution = resolveR4ExecutionAuthority({ cwd: fixture.dir, requireApproval: true });
  const other = synth();
  const now = attemptTime(other, 1);
  const { capability, authorization } = issueNext(other, now);
  const proof = proveCapability({ capability, record: authorization });
  const open = createSessionAttestation({ seal: resolution.seal, authority: { ...resolution.authority, sealAuthorityCommit: other.sealCommit },
    approvalAuthority: { approvalCommit: other.approvalCommit, t0: other.t0 }, proof });
  throwsCode(() => finalizeSessionAttestation(open, { sessionFingerprint: 'f'.repeat(64), proof }), 'R4_ATTESTATION_CLAIM_REQUIRED');
  const recoveryClaim = claimAttemptAuthorization({ record: authorization, claimant: R4_CLAIMANTS.recovery, cwd: other.dir, now });
  throwsCode(() => finalizeSessionAttestation(open, { sessionFingerprint: 'f'.repeat(64), proof, claim: recoveryClaim }), 'R4_ATTESTATION_CLAIM_NOT_CAPTURE_CHILD');
});

test('M30: rewriting attempt state is rejected (write-once terminal, tamper, hash chain)', () => {
  const fixture = synth();
  runAttempt(fixture, 1, 'complete');
  const history = verifiedHistory(fixture);
  const { authorization, claim } = history.attempts[0];
  throwsCode(() => writeAttemptTerminal({ authorization, claim, state: R4_TERMINAL_STATES.failed, failureCode: 'R4_REWRITE', terminatedAt: attemptTime(fixture, 1) + 5000, cwd: fixture.dir }), 'R4_ATTEMPT_TERMINAL_EXISTS');
  const failed = synth();
  runAttempt(failed, 1, 'fail');
  const failedHistory = verifiedHistory(failed);
  throwsCode(() => writeAttemptTerminal({ authorization: failedHistory.attempts[0].authorization, claim: failedHistory.attempts[0].claim,
    state: R4_TERMINAL_STATES.completed, attestation: { recordType: 'r4_cohort_session_attestation', status: 'FINALIZED' }, cwd: failed.dir }), 'R4_ATTEMPT_TERMINAL_EXISTS');
  // COMPLETED can never be written for a claim the capture child did not make.
  const recoveryFixture = synth();
  const recoveryNow = attemptTime(recoveryFixture, 1);
  const { authorization: unclaimed } = issueNext(recoveryFixture, recoveryNow);
  const recoveryClaim = claimAttemptAuthorization({ record: unclaimed, claimant: R4_CLAIMANTS.recovery, cwd: recoveryFixture.dir, now: recoveryNow });
  throwsCode(() => writeAttemptTerminal({ authorization: unclaimed, claim: recoveryClaim, state: R4_TERMINAL_STATES.completed,
    attestation: { recordType: 'r4_cohort_session_attestation', status: 'FINALIZED' }, terminatedAt: recoveryNow, cwd: recoveryFixture.dir }), 'R4_TERMINAL_COMPLETED_REQUIRES_CAPTURE_CHILD_CLAIM');
  // In-place state flip without re-fingerprinting.
  const flipped = evidenceCopy(fixture);
  const terminalFile = path.join(attemptsDir(flipped), 'attempt-1.terminal.json');
  writeJson(terminalFile, { ...readJson(terminalFile), state: 'FAILED' });
  throwsCode(() => verifiedHistory(fixture, flipped), 'R4_HISTORY_RECORD_TAMPERED');
  // A re-fingerprinted rewrite of attempt 1 after attempt 2 exists breaks the chain.
  runAttempt(fixture, 2, 'fail');
  const chained = evidenceCopy(fixture);
  const chainedFile = path.join(attemptsDir(chained), 'attempt-1.terminal.json');
  writeJson(chainedFile, refingerprint({ ...readJson(chainedFile), terminatedAt: readJson(chainedFile).terminatedAt + 1 }));
  throwsCode(() => verifiedHistory(fixture, chained), 'R4_HISTORY_CHAIN_BROKEN');
  // Records bound to a different A are rejected.
  const resolution = resolveR4ExecutionAuthority({ cwd: fixture.dir, requireApproval: true });
  throwsCode(() => verifyR4AttemptHistory(loadR4AttemptHistory({ cwd: fixture.dir }), { seal: resolution.seal, authority: resolution.authority,
    approvalCommit: 'e'.repeat(40), t0: resolution.t0 }), 'R4_HISTORY_AUTHORITY_MISMATCH');
  // Unknown files in the governance store fail closed.
  const unknown = evidenceCopy(fixture);
  writeFileSync(path.join(attemptsDir(unknown), 'attempt-1.json.bak'), '{}');
  throwsCode(() => verifiedHistory(fixture, unknown), 'R4_HISTORY_UNKNOWN_ARTIFACT');
});

test('M31: an attempt identity mismatch is rejected', () => {
  const fixture = synth();
  runAttempt(fixture, 1, 'fail');
  const history = verifiedHistory(fixture);
  const { authorization, claim } = history.attempts[0];
  throwsCode(() => assertClaimBindsAuthorization(refingerprint({ ...claim, sessionId: 'other-session' }), authorization), 'R4_CLAIM_IDENTITY_MISMATCH');
  const claimCopy = evidenceCopy(fixture);
  const claimFile = path.join(attemptsDir(claimCopy), 'attempt-1.claim.json');
  writeJson(claimFile, refingerprint({ ...readJson(claimFile), sessionId: 'other-session' }));
  throwsCode(() => verifiedHistory(fixture, claimCopy), 'R4_HISTORY_IDENTITY_MISMATCH');
  const authCopy = evidenceCopy(fixture);
  const authFile = path.join(attemptsDir(authCopy), 'attempt-1.json');
  writeJson(authFile, refingerprint({ ...readJson(authFile), sessionId: 'not-derived-session' }));
  throwsCode(() => verifiedHistory(fixture, authCopy), 'R4_HISTORY_IDENTITY_MISMATCH');
});

/* ============= FAIL-CLOSED AUTHORIZATION ORDER (section 11) ============= */

test('section 11: every failure before step 14 leaves ZERO persistent attempt artifacts', () => {
  const cases = [];
  const before = synth();
  cases.push([before, () => authorizeSealedAttempt({ argv: CAPTURE, env: {}, now: before.t0 - 1, cwd: before.dir }), 'R4_COHORT_BEFORE_T0']);
  const missed = synth();
  cases.push([missed, () => authorizeSealedAttempt({ argv: CAPTURE, env: {}, now: missed.t0 + 300_000, cwd: missed.dir }), 'R4_ATTEMPT1_START_WINDOW_MISSED']);
  const drift = synth();
  writeFileSync(path.join(drift.dir, '.env.local'), 'EVOLVE_MARKET_MODE=auto\n');
  cases.push([drift, () => authorizeSealedAttempt({ argv: CAPTURE, env: {}, now: drift.t0 + 60_000, cwd: drift.dir }), 'R4_CAPTURE_ENV_DRIFT']);
  const head = synth({ headAfterA: true, remoteMain: 'A' });
  cases.push([head, () => authorizeSealedAttempt({ argv: CAPTURE, env: {}, now: head.t0 + 60_000, cwd: head.dir }), 'R4_APPROVAL_HEAD_NOT_APPROVAL_COMMIT']);
  const worktree = synth();
  writeFileSync(path.join(worktree.dir, 'scripts/r4-attempt-history.mjs'), '// tampered\n');
  cases.push([worktree, () => authorizeSealedAttempt({ argv: CAPTURE, env: {}, now: worktree.t0 + 60_000, cwd: worktree.dir }), 'R4_WORKTREE_RUNTIME_MODIFIED']);
  const lock = synth();
  writeFileSync(path.join(lock.dir, 'package-lock.json'), '{}\n');
  cases.push([lock, () => authorizeSealedAttempt({ argv: CAPTURE, env: {}, now: lock.t0 + 60_000, cwd: lock.dir }), 'R4_WORKTREE_RUNTIME_MODIFIED']);
  const mode = synth();
  cases.push([mode, () => authorizeSealedAttempt({ argv: ['capture'], env: {}, now: mode.t0 + 60_000, cwd: mode.dir }), 'R4_SEALED_CAPTURE_REQUIRES_EXECUTE']);
  // Authority is checked before the environment: a remote failure wins over drift.
  const ordered = synth({ remoteMain: 'S' });
  writeFileSync(path.join(ordered.dir, '.env.local'), 'EVOLVE_MARKET_MODE=auto\n');
  cases.push([ordered, () => authorizeSealedAttempt({ argv: CAPTURE, env: {}, now: ordered.t0 + 60_000, cwd: ordered.dir }), 'R4_AUTHORITY_REMOTE_MAIN_MISMATCH']);
  for (const [fixture, fn, code] of cases) {
    throwsCode(fn, code);
    assert.deepEqual(persistentAttemptArtifacts(fixture.dir), [], `${code} left attempt artifacts`);
  }
});

test('the preflight is read-only and reports the derived next attempt at the A stage', () => {
  const fixture = synth();
  const before = persistentAttemptArtifacts(fixture.dir);
  const report = runnerMain(['preflight'], { env: {}, now: fixture.t0 + 60_000, cwd: fixture.dir }).report;
  assert.equal(report.authorityStage, 'A');
  assert.equal(report.liveRemoteMain, fixture.approvalCommit);
  assert.equal(report.attemptHistory.next.nextAttemptIndex, 1);
  assert.deepEqual(persistentAttemptArtifacts(fixture.dir), before);
});

/* ===================== SEAL / TAMPER (section 18) ===================== */

test('section 18: altering ANY bound artifact is rejected by the canonical seal (zero survivors)', () => {
  const scratchSeal = buildSeal({ ...gitIdentity(REPO), sealedAt: 1_800_000_000_000 });
  let killed = 0;
  const survivors = [];
  for (const file of R4_REQUIRED_BOUND_FILES) {
    const load = target => (target === file ? Buffer.from(`${readFileSync(path.join(REPO, target), 'utf8')}\n// tampered\n`) : readFileSync(path.join(REPO, target)));
    const code = codeOf(() => verifyR4Seal(scratchSeal, { load }));
    if (code?.startsWith(`R4_SEAL_FILE_DIGEST_MISMATCH:${file}`)) killed++;
    else survivors.push(`${file}:${code}`);
  }
  assert.deepEqual(survivors, []);
  for (const required of ['scripts/r4-capability.mjs', 'scripts/r4-attempt-history.mjs', 'scripts/r4-authority.mjs', 'scripts/r4-approval.mjs',
    'scripts/r4-canonical-analysis.mjs', 'scripts/r4-cohort-run.mjs', 'scripts/r4-protocol-spec.mjs', 'scripts/r4-exclusions.mjs',
    'scripts/r4-cohort-plan.mjs', 'scripts/r4-enforcement.mjs', 'scripts/market-outcomes/index.mjs', 'scripts/market-outcomes/reference-selection.mjs',
    'scripts/market-outcomes/primary-analysis.mjs', 'scripts/market-intelligence.mjs', 'package-lock.json', 'docs/R4-PREREGISTRATION.md']) {
    assert(R4_REQUIRED_BOUND_FILES.includes(required), `${required} must be bound`);
  }
  console.log(`      seal tamper sweep: ${killed}/${R4_REQUIRED_BOUND_FILES.length} bound artifacts killed, 0 survivors`);
});

/* ---------------------------------------------------------------- run */

let failed = 0;
let count = 0;
try {
  for (const [name, fn] of tests) {
    count++;
    try { await fn(); console.log(`PASS ${name}`); }
    catch (e) { failed++; console.error(`FAIL ${name}: ${String(e?.stack ?? e).split('\n').slice(0, 4).join(' | ')}`); }
  }
} finally {
  while (cleanups.length) removeTree(cleanups.pop());
}
console.log('');
console.log(`R4 round-3 regression: ${count - failed}/${count} passed; synthetic temporary fixtures only`);
if (failed) process.exitCode = 1;
