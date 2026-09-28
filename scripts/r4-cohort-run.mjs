#!/usr/bin/env node
// R4 sealed cohort runner — the ONLY entrypoint allowed to create a real R4
// cohort session.
//
// Enforcement only. Inputs are limited to the canonical tracked seal path, the
// canonical approval path and an OPTIONAL attempt-index assertion. EVERY
// scientific capture parameter is derived from the frozen specification and the
// canonical tracked seal; the runner accepts no scientifically meaningful runtime
// override and no flag can disable any authority check.
//
// Modes:
//   preflight   (default) — read-only. Verify the authority chain, the effective
//                            environment, T0, storage headroom and the canonical
//                            attempt history. Writes nothing, captures nothing.
//   capture      — gated by `--execute`. Runs the full fail-closed authorization
//                  order (round-3 section 11), derives the ONLY legal next attempt
//                  from authenticated history, persists an immutable authorization
//                  holding only SHA-256(capability), hands the raw capability to
//                  capture over an inherited descriptor, and always settles the
//                  attempt with exactly one write-once terminal record
//                  (COMPLETED or FAILED). Not invoked by any validator.
//   recover      — gated by `--execute`. Deterministic crash recovery: the last
//                  nonterminal attempt becomes FAILED (never reused).
//
// No outcome is generated here and no cohort membership is decided here.
import { spawnSync } from 'node:child_process';
import { openSync, closeSync, mkdtempSync, rmSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from './market-intelligence/definition.mjs';
import { loadEffectiveEnvironment } from './lib/env.mjs';
import { R4_SPEC, classifyCaptureEnvironment, sanitizeSealedChildEnvironment, captureSpecDigest, R4_TRACKED_SEAL_PATH, R4_PRECAPTURE_APPROVAL_PATH } from './r4-protocol-spec.mjs';
import {
  createAttemptCapability, capabilityHash, createAttemptAuthorization, writeAttemptAuthorization, deriveSessionId,
  proveCapability, readSessionReceipt, assertSessionReceipt, readAttemptClaim, claimAttemptAuthorization,
  assertClaimBindsAuthorization, R4_CAPABILITY_FD, R4_ATTEMPT_AUTH_DIR, R4_CLAIMANTS,
} from './r4-capability.mjs';
import { createSessionAttestation, finalizeSessionAttestation, writeSessionAttestation, R4_ATTESTATION_DIR, R4_SESSION_ROLE } from './r4-attestation.mjs';
import { resolveR4ExecutionAuthority, evaluateAttemptStartWindow, assertAttemptStartAllowed, R4_ATTEMPT1_WINDOW_MS, R4_APPROVAL_PATH } from './r4-approval.mjs';
import { R4_REPO_ROOT, R4_REMOTE_MAIN } from './r4-authority.mjs';
import {
  loadR4AttemptHistory, verifyR4AttemptHistory, deriveNextAttempt, writeAttemptTerminal, recoverInterruptedAttempt,
  R4_TERMINAL_STATES,
} from './r4-attempt-history.mjs';

const MIB = 1024 * 1024;
export const R4_SEALED_CAPTURE_ARGS = Object.freeze(['scripts/market-intelligence.mjs', 'capture', '--r4-revisits', '--minutes', String(R4_SPEC.cohort.referenceMinutes)]);
export const R4_SESSION_DIR_ROOT = '.evolve/market-intelligence/sessions';

export class R4RunnerError extends Error {
  constructor(code, detail = null) { super(code); this.code = code; this.detail = detail; }
}

/**
 * Parse runner arguments. Only the seal/approval paths, the working directory
 * and an optional attempt-index ASSERTION are accepted. The attempt index is
 * never a selector: the only legal attempt is derived from authenticated
 * history, and a supplied `--attempt` that differs from it is refused.
 */
export function parseRunnerArgs(argv = []) {
  const mode = ['capture', 'preflight', 'recover'].includes(argv[0]) ? argv[0] : 'preflight';
  const rest = argv[0] === mode ? argv.slice(1) : argv;
  const options = {
    mode,
    sealPath: R4_TRACKED_SEAL_PATH,
    approvalPath: R4_APPROVAL_PATH,
    attemptIndex: null,
    execute: false,
    cwd: R4_REPO_ROOT,
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--seal') options.sealPath = rest[++i];
    else if (arg === '--approval') options.approvalPath = rest[++i];
    else if (arg === '--attempt') options.attemptIndex = Number(rest[++i]);
    else if (arg === '--cwd') options.cwd = path.resolve(rest[++i]);
    else if (arg === '--execute') options.execute = true;
    // `--require-remote` is deliberately NOT accepted: remote authority is
    // mandatory and no argument may make it optional.
    else throw new R4RunnerError('R4_RUNNER_ARGUMENT_UNSUPPORTED', { arg });
  }
  if (options.attemptIndex !== null && (!Number.isInteger(options.attemptIndex) || options.attemptIndex < 1 || options.attemptIndex > R4_SPEC.cohort.maxAttempts)) {
    throw new R4RunnerError('R4_RUNNER_ATTEMPT_INDEX_INVALID', { attemptIndex: options.attemptIndex, maxAttempts: R4_SPEC.cohort.maxAttempts });
  }
  return options;
}

export const R4_RUNNER_LOCKED_ARGUMENTS = Object.freeze([
  'minutes', 'duration', 'provider', 'providers', 'universe', 'endpoint', 'endpoints', 'poll', 'budget',
  'freshness', 'stale', 'alignment', 'horizon', 'tolerance', 'mode', 'role', 'replicates', 'bootstrap',
  'exposure', 'outcome', 'require-remote', 't0',
]);

/**
 * Environment drift gate. Every capture environment variable is classified:
 *   A scientific/evidence-changing  -> FAIL BEFORE CAPTURE on any mismatch
 *   B operational-only              -> permitted
 *   C secret/credential             -> permitted to exist; behaviour stays sealed
 * Any unclassified capture-shaped variable present is treated as class A drift.
 */
export function enforceSealedCaptureEnvironment(env = {}) {
  const { table, drift } = classifyCaptureEnvironment(env);
  if (drift.length) throw new R4RunnerError('R4_CAPTURE_ENV_DRIFT', { drift, table });
  return { table, drift };
}

/** The FULL effective environment capture would observe, using capture's loader. */
export function effectiveSealedEnvironment({ cwd = R4_REPO_ROOT, env = process.env } = {}) {
  const { env: effective, loaded } = loadEffectiveEnvironment({ dir: cwd, base: env });
  return { effective, loaded };
}

/**
 * Pre-capture storage preflight. Estimates worst-case bytes for the sealed
 * reference window plus the bounded drain using the documented methods-only
 * high-water rate, and reports headroom against the sealed operational cap.
 * Duration is never altered; an unsafe configuration refuses the attempt.
 */
export function storagePreflight({
  sealedMiB = R4_SPEC.capture.storage.sealedSessionMiB,
  rateBytesPerMinute = R4_SPEC.capture.methodsOnlyHighWaterBytesPerMinute,
  windowMinutes = R4_SPEC.cohort.referenceMinutes,
  drainMinutes = R4_SPEC.capture.drainBoundMs / 60_000,
} = {}) {
  const capBytes = sealedMiB * MIB;
  const worstCaseBytes = Math.ceil(rateBytesPerMinute * (windowMinutes + drainMinutes));
  const headroomBytes = capBytes - worstCaseBytes;
  return {
    sealedMiB, implementationDefaultMiB: R4_SPEC.capture.storage.defaultSessionMiB,
    minSessionMiB: R4_SPEC.capture.storage.minSessionMiB, maxSessionMiB: R4_SPEC.capture.storage.maxSessionMiB,
    capBytes, rateBytesPerMinute, windowMinutes, drainMinutes, worstCaseBytes, headroomBytes, ok: headroomBytes >= 0,
  };
}

export function assertStoragePreflight(preflight) {
  if (!preflight.ok) throw new R4RunnerError('R4_STORAGE_PREFLIGHT_REFUSED', preflight);
  return preflight;
}

/** Load and authenticate the canonical attempt history against resolved authority A. */
export function canonicalAttemptHistory({ resolution, cwd }) {
  if (!resolution || resolution.stage !== 'A') throw new R4RunnerError('R4_HISTORY_REQUIRES_APPROVAL_AUTHORITY');
  const history = loadR4AttemptHistory({ cwd });
  const verified = verifyR4AttemptHistory(history, { seal: resolution.seal, authority: resolution.authority,
    approvalCommit: resolution.approvalCommit, t0: resolution.t0 });
  return { verified, next: deriveNextAttempt(verified) };
}

/**
 * Read-only preflight: authority chain, effective environment, T0/window,
 * storage headroom and (at the A stage) the canonical attempt history and the
 * derived next attempt. Never writes, never captures.
 */
export function preflight({ argv = [], env = process.env, now = Date.now(), cwd = null } = {}) {
  const options = parseRunnerArgs(argv);
  const workdir = cwd ?? options.cwd;
  const { effective, loaded } = effectiveSealedEnvironment({ cwd: workdir, env });
  const environment = enforceSealedCaptureEnvironment(effective);
  const storage = assertStoragePreflight(storagePreflight({}));
  // Prefer the full A-stage authority. A missing approval is the expected
  // pre-authorization state and degrades to the S stage; every other authority
  // failure propagates.
  let authorityResolution;
  try {
    authorityResolution = resolveR4ExecutionAuthority({ cwd: workdir, sealPath: options.sealPath, approvalPath: options.approvalPath, requireApproval: true });
  } catch (error) {
    if (String(error?.message) !== 'R4_APPROVAL_MISSING' && String(error?.message) !== 'R4_APPROVAL_APPROVAL_COMMIT_NOT_FOUND') throw error;
    authorityResolution = resolveR4ExecutionAuthority({ cwd: workdir, sealPath: options.sealPath, approvalPath: options.approvalPath, requireApproval: false });
  }
  const { seal, authority } = authorityResolution;
  const t0 = authorityResolution.t0;
  const startWindow = t0 === null ? null : evaluateAttemptStartWindow({ t0, now });
  let attemptHistory = null;
  if (authorityResolution.stage === 'A') {
    const { verified, next } = canonicalAttemptHistory({ resolution: authorityResolution, cwd: workdir });
    attemptHistory = { attemptsUsed: verified.attemptsUsed, completedCount: verified.completedCount,
      states: verified.attempts.map(attempt => ({ index: attempt.index, state: attempt.state })), next };
  }
  return {
    mode: options.mode, sealPath: options.sealPath, sealFingerprint: seal.fingerprint,
    protocolCommit: authority.protocolCommit, authorityCommit: authority.sealAuthorityCommit,
    sealCommitterTimestamp: authority.sealCommitterTimestamp, sealCommitterIso: authority.sealCommitterIso,
    authorityStage: authorityResolution.stage, approvalCommit: authorityResolution.approvalCommit,
    approvalCommitterTimestamp: authorityResolution.approvalCommitterTimestamp ?? null,
    liveRemoteMain: authorityResolution.remoteSha ?? null, remoteAuthority: R4_REMOTE_MAIN,
    t0, t0Iso: t0 === null ? null : new Date(t0).toISOString(), startWindow,
    t0Reached: t0 === null ? false : now >= t0, requestedAttemptIndex: options.attemptIndex, attemptHistory,
    environmentFiles: loaded, environmentTable: environment.table, storage,
    captureArgs: [...R4_SEALED_CAPTURE_ARGS], captureMode: R4_SPEC.cohort.captureMode,
    effectiveEnvironment: effective,
    seal, authority,
  };
}

/** Serialisable view of a preflight report (no seal/authority/effective env). */
export function reportView(report) {
  const view = { ...report };
  delete view.seal;
  delete view.authority;
  delete view.effectiveEnvironment;
  return view;
}

export { deriveSessionId };

/** Verify the capture child's authenticated manifest fingerprint from disk. */
export function verifySessionManifest({ cwd = R4_REPO_ROOT, sessionId, expectedFingerprint }) {
  const dir = path.resolve(cwd, R4_SESSION_DIR_ROOT, sessionId);
  const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  if (manifest.recordType !== 'manifest' || manifest.sessionId !== sessionId) throw new R4RunnerError('R4_SESSION_MANIFEST_IDENTITY_INVALID');
  if (digest(manifest.files) !== manifest.fingerprint) throw new R4RunnerError('R4_SESSION_MANIFEST_FINGERPRINT_INVALID');
  if (manifest.fingerprint !== expectedFingerprint) throw new R4RunnerError('R4_SESSION_MANIFEST_FINGERPRINT_MISMATCH');
  return manifest;
}

/**
 * Every gate that must pass before an attempt authorization may be persisted,
 * in the round-3 fail-closed order. Writes NOTHING: a failure here leaves zero
 * persistent attempt artifacts.
 *
 *    1-6  canonical Git authority, LIVE remote == A, HEAD == A, worktree
 *         integrity, approval A, canonical T0     (resolveR4ExecutionAuthority)
 *    7    effective environment
 *    8    storage preflight
 *    9    authenticated attempt history
 *   10    nextAttemptIndex (the only legal attempt)
 *   11    cohort not stopped / previous attempt terminal
 *   12    attempt 1 only: now in [T0, T0 + 5 min)
 *   13    a supplied --attempt must equal nextAttemptIndex
 */
export function authorizeSealedAttempt({ argv = [], env = process.env, now = Date.now(), cwd = null } = {}) {
  const options = parseRunnerArgs(argv);
  const workdir = cwd ?? options.cwd;
  if (options.mode !== 'capture') throw new R4RunnerError('R4_SEALED_CAPTURE_MODE_REQUIRED');
  if (!options.execute) throw new R4RunnerError('R4_SEALED_CAPTURE_REQUIRES_EXECUTE');
  // 1-6
  const resolution = resolveR4ExecutionAuthority({ cwd: workdir, sealPath: options.sealPath, approvalPath: options.approvalPath, requireApproval: true });
  if (resolution.stage !== 'A') throw new R4RunnerError('R4_SEALED_CAPTURE_REQUIRES_APPROVAL_COMMIT');
  // 7
  const { effective, loaded } = effectiveSealedEnvironment({ cwd: workdir, env });
  const environment = enforceSealedCaptureEnvironment(effective);
  // 8
  const storage = assertStoragePreflight(storagePreflight({}));
  // 9-10
  const { verified, next } = canonicalAttemptHistory({ resolution, cwd: workdir });
  // 11
  if (next.blocked) throw new R4RunnerError('R4_PREVIOUS_ATTEMPT_NOT_TERMINAL', { blockingAttempt: next.blockingAttempt, state: next.blockingState });
  if (next.stop) throw new R4RunnerError('R4_COHORT_STOPPED', { reason: next.reason, completedCount: next.completedCount, attemptsUsed: next.attemptsUsed });
  const attemptIndex = next.nextAttemptIndex;
  // 12 — the [T0, T0+5min) window is evaluated here and never recomputed or
  // rolled forward; a missed window is terminal for this approval A.
  const startWindow = attemptIndex === 1
    ? assertAttemptStartAllowed({ attemptIndex, t0: resolution.t0, now })
    : { state: 'REPLACEMENT_ORDERED', rule: 'ORDERING_NOT_MARKET_STATE', t0: resolution.t0 };
  // 13
  if (options.attemptIndex !== null && options.attemptIndex !== attemptIndex) {
    throw new R4RunnerError('R4_ATTEMPT_NOT_NEXT', { requested: options.attemptIndex, nextAttemptIndex: attemptIndex });
  }
  return { options, workdir, resolution, environment, environmentFiles: loaded, effectiveEnvironment: effective, storage,
    history: verified, next, attemptIndex, startWindow };
}

/**
 * Step 14: create and persist the IMMUTABLE authorization for the derived next
 * attempt. Only reachable after `authorizeSealedAttempt` passed every gate.
 * The authorization binds the previous attempt's terminal fingerprint, so the
 * history is a hash chain. The authorization file is created O_EXCL: two
 * runners can never both authorize the same index.
 */
export function issueSealedAttemptAuthorization({ authorized, now = Date.now(), capability = createAttemptCapability() }) {
  const { resolution, attemptIndex, next, workdir } = authorized;
  const hash = capabilityHash(capability);
  const sessionId = deriveSessionId({ sealFingerprint: resolution.seal.fingerprint, approvalCommit: resolution.approvalCommit, attemptIndex, capabilityHash: hash });
  const authorization = createAttemptAuthorization({
    seal: resolution.seal, authority: resolution.authority, approvalCommit: resolution.approvalCommit,
    attemptIndex, sessionId, t0: resolution.t0, capabilityHash: hash, captureSpecDigest: captureSpecDigest(),
    authorizedAt: now, previousTerminalFingerprint: next.previousTerminalFingerprint ?? null,
  });
  writeAttemptAuthorization(authorization, { cwd: workdir });
  return { capability, authorization, sessionId };
}

/**
 * Hand the raw capability to the capture child over an inherited descriptor.
 * The capability exists on disk only between `writeFileSync` and `unlinkSync`
 * (inside a fresh 0700 directory); the child receives an open descriptor to an
 * already-unlinked file.
 */
function spawnCaptureChild({ capability, workdir, childEnv, spawn }) {
  const sandbox = mkdtempSync(path.join(tmpdir(), 'evolve-r4-capability-'));
  const capabilityFile = path.join(sandbox, 'capability.bin');
  let fd = null;
  try {
    writeFileSync(capabilityFile, capability, { mode: 0o600, flag: 'wx' });
    fd = openSync(capabilityFile, 'r');
    unlinkSync(capabilityFile);
    const result = spawn(process.execPath, R4_SEALED_CAPTURE_ARGS, { cwd: workdir, env: childEnv, stdio: ['ignore', 'inherit', 'inherit', fd] });
    return result?.status ?? null;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } }
    try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function failAttempt({ authorization, claim, failureCode, workdir, now = Date.now() }) {
  try { return writeAttemptTerminal({ authorization, claim, state: R4_TERMINAL_STATES.failed, failureCode, terminatedAt: now, cwd: workdir }); }
  catch (error) { if (String(error?.message) === 'R4_ATTEMPT_TERMINAL_EXISTS') return null; throw error; }
}

/**
 * Settle an attempt after the child exits. EVERY outcome writes exactly one
 * write-once terminal record:
 *   no claim            -> runner consumes it (RUNNER_UNCLAIMED_ABANDON) -> FAILED
 *   non-child claim     -> FAILED
 *   child exit != 0     -> FAILED
 *   verified completion -> attestation (write-once) -> COMPLETED
 */
export function settleSealedAttempt({ authorization, proof, open, exitCode, workdir, clock = Date.now }) {
  let claim = readAttemptClaim({ attemptIndex: authorization.attemptIndex, cwd: workdir });
  if (!claim) {
    try { claim = claimAttemptAuthorization({ record: authorization, claimant: R4_CLAIMANTS.runnerAbandon, cwd: workdir, now: clock() }); }
    catch (error) {
      if (String(error?.message) !== 'R4_CAPABILITY_ALREADY_CLAIMED') throw error;
      claim = readAttemptClaim({ attemptIndex: authorization.attemptIndex, cwd: workdir });
    }
    if (claim?.claimant !== R4_CLAIMANTS.child) {
      failAttempt({ authorization, claim, failureCode: 'R4_ATTEMPT_NEVER_CLAIMED', workdir, now: clock() });
      throw new R4RunnerError('R4_ATTEMPT_NEVER_CLAIMED', { exitCode });
    }
  }
  assertClaimBindsAuthorization(claim, authorization);
  if (claim.claimant !== R4_CLAIMANTS.child) {
    failAttempt({ authorization, claim, failureCode: 'R4_ATTEMPT_NOT_CLAIMED_BY_CAPTURE_CHILD', workdir, now: clock() });
    throw new R4RunnerError('R4_ATTEMPT_NOT_CLAIMED_BY_CAPTURE_CHILD');
  }
  if (exitCode !== 0) {
    failAttempt({ authorization, claim, failureCode: 'R4_SEALED_CAPTURE_CHILD_FAILED', workdir, now: clock() });
    throw new R4RunnerError('R4_SEALED_CAPTURE_CHILD_FAILED', { exitCode });
  }
  try {
    const receipt = readSessionReceipt(authorization.sessionId, { cwd: workdir });
    if (!receipt) throw new R4RunnerError('R4_SESSION_RECEIPT_MISSING');
    assertSessionReceipt(receipt, { proof, record: authorization, claim });
    verifySessionManifest({ cwd: workdir, sessionId: authorization.sessionId, expectedFingerprint: receipt.sessionFingerprint });
    const finalized = finalizeSessionAttestation(open, { sessionFingerprint: receipt.sessionFingerprint, revisitCoverage: receipt.revisitCoverage, proof, claim });
    const written = writeSessionAttestation(finalized, { root: path.resolve(workdir, R4_ATTESTATION_DIR) });
    const terminal = writeAttemptTerminal({ authorization, claim, state: R4_TERMINAL_STATES.completed, attestation: finalized, terminatedAt: clock(), cwd: workdir });
    return { receipt, attestation: finalized, attestationFile: written.file, terminal };
  } catch (error) {
    const code = String(error?.code ?? error?.message ?? '').split(':')[0];
    failAttempt({ authorization, claim, failureCode: /^R4_[A-Z0-9_]{1,100}$/.test(code) ? code : 'R4_ATTEMPT_FINALIZATION_FAILED', workdir, now: clock() });
    throw error;
  }
}

/** Explicit deterministic crash recovery. Full A-stage authority required. */
export function recoverSealedAttempts({ argv = [], now = Date.now(), cwd = null } = {}) {
  const options = parseRunnerArgs(argv);
  const workdir = cwd ?? options.cwd;
  if (options.mode !== 'recover') throw new R4RunnerError('R4_RECOVER_MODE_REQUIRED');
  if (!options.execute) throw new R4RunnerError('R4_RECOVER_REQUIRES_EXECUTE');
  const resolution = resolveR4ExecutionAuthority({ cwd: workdir, sealPath: options.sealPath, approvalPath: options.approvalPath, requireApproval: true });
  const { verified } = canonicalAttemptHistory({ resolution, cwd: workdir });
  const result = recoverInterruptedAttempt({ verified, now, cwd: workdir });
  const after = canonicalAttemptHistory({ resolution, cwd: workdir });
  return { recovered: result.recovered, terminal: result.terminal ?? null, next: after.next };
}

/**
 * Gated real capture. Not invoked by any validator in this repository.
 */
export function main(argv = process.argv.slice(2), { env = process.env, now = Date.now(), spawn = spawnSync, cwd = null, clock = Date.now } = {}) {
  const options = parseRunnerArgs(argv);
  const workdir = cwd ?? options.cwd;
  if (options.mode === 'preflight') return { report: preflight({ argv, env, now, cwd: workdir }), executed: false };
  if (options.mode === 'recover') return { recovery: recoverSealedAttempts({ argv, now, cwd: workdir }), executed: false };
  const authorized = authorizeSealedAttempt({ argv, env, now, cwd: workdir });
  const { resolution, effectiveEnvironment, attemptIndex, startWindow } = authorized;
  const { capability, authorization, sessionId } = issueSealedAttemptAuthorization({ authorized, now });
  const proof = proveCapability({ capability, record: authorization });
  const open = createSessionAttestation({ seal: resolution.seal, authority: resolution.authority, approvalAuthority: resolution, proof });
  const childEnv = sanitizeSealedChildEnvironment(effectiveEnvironment);
  let exitCode = null;
  try { exitCode = spawnCaptureChild({ capability, workdir, childEnv, spawn }); }
  catch { exitCode = null; }
  const settled = settleSealedAttempt({ authorization, proof, open, exitCode, workdir, clock });
  return { executed: true, sessionId, attemptIndex, startWindow,
    openAttestationFingerprint: open.fingerprint, attestationFingerprint: settled.attestation.fingerprint,
    attestationFile: settled.attestationFile, receiptFingerprint: settled.receipt.fingerprint,
    terminalFingerprint: settled.terminal.fingerprint, exitCode };
}

export { R4_SESSION_ROLE, R4_ATTESTATION_DIR, R4_ATTEMPT_AUTH_DIR, R4_CAPABILITY_FD, R4_REMOTE_MAIN, R4_TRACKED_SEAL_PATH, R4_PRECAPTURE_APPROVAL_PATH, R4_ATTEMPT1_WINDOW_MS };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = main();
    const view = result.report ? { executed: result.executed, ...reportView(result.report) } : result;
    console.log(JSON.stringify(view, null, 2));
  } catch (error) {
    console.error(`[R4] sealed cohort runner refused: ${error.code ?? String(error?.message ?? 'R4_RUNNER_ERROR').split(':')[0]}`);
    if (error.detail) console.error(JSON.stringify(error.detail, null, 2));
    process.exitCode = 1;
  }
}
