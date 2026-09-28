#!/usr/bin/env node
// R4 sealed cohort runner — the ONLY entrypoint allowed to create a real R4
// cohort session.
//
// Enforcement only. Inputs are limited to the canonical tracked seal path, the
// canonical approval path and an attempt index. EVERY scientific capture
// parameter is derived from the frozen specification and the canonical tracked
// seal; the runner accepts no scientifically meaningful runtime override and no
// flag can disable any authority check.
//
// Modes:
//   preflight   (default) — read-only. Verify the authority chain, the effective
//                            environment, T0 and storage headroom. Writes nothing,
//                            captures nothing.
//   capture      — gated by `--execute`. Re-runs preflight, requires the verified
//                  pre-capture approval commit A, enforces the [T0, T0+5min)
//                  attempt-1 start window, draws a random capability, persists
//                  only its SHA-256, hands the raw capability to capture over an
//                  inherited descriptor, then finalizes exactly one sealed
//                  45-minute session attestation. Not invoked by any validator.
//
// No outcome is generated here and no cohort membership is decided here.
import { spawnSync } from 'node:child_process';
import { openSync, closeSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from './market-intelligence/definition.mjs';
import { loadEffectiveEnvironment } from './lib/env.mjs';
import { R4_SPEC, classifyCaptureEnvironment, sanitizeSealedChildEnvironment, captureSpecDigest, R4_TRACKED_SEAL_PATH, R4_PRECAPTURE_APPROVAL_PATH } from './r4-protocol-spec.mjs';
import {
  createAttemptCapability, capabilityHash, createAttemptAuthorization, writeAttemptAuthorization,
  proveCapability, readSessionReceipt, assertSessionReceipt, R4_CAPABILITY_FD, R4_ATTEMPT_AUTH_DIR,
} from './r4-capability.mjs';
import { createSessionAttestation, finalizeSessionAttestation, writeSessionAttestation, R4_ATTESTATION_DIR, R4_SESSION_ROLE } from './r4-attestation.mjs';
import { resolveR4ExecutionAuthority, evaluateAttemptStartWindow, assertAttemptStartAllowed, R4_ATTEMPT1_WINDOW_MS, R4_APPROVAL_PATH } from './r4-approval.mjs';
import { R4_REPO_ROOT, R4_REMOTE_MAIN, remoteContains } from './r4-authority.mjs';

const MIB = 1024 * 1024;
export const R4_SEALED_CAPTURE_ARGS = Object.freeze(['scripts/market-intelligence.mjs', 'capture', '--r4-revisits', '--minutes', String(R4_SPEC.cohort.referenceMinutes)]);
export const R4_SESSION_DIR_ROOT = '.evolve/market-intelligence/sessions';

export class R4RunnerError extends Error {
  constructor(code, detail = null) { super(code); this.code = code; this.detail = detail; }
}

/** Parse runner arguments. Only the seam/approval paths and attempt index are accepted. */
export function parseRunnerArgs(argv = []) {
  const mode = ['capture', 'preflight'].includes(argv[0]) ? argv[0] : 'preflight';
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

/**
 * Read-only preflight: authority chain, effective environment, T0/window and
 * storage headroom. Never writes, never captures.
 */
export function preflight({ argv = [], env = process.env, now = Date.now(), cwd = null } = {}) {
  const options = parseRunnerArgs(argv);
  const workdir = cwd ?? options.cwd;
  const attemptIndex = options.attemptIndex ?? 1;
  if (!Number.isInteger(attemptIndex) || attemptIndex < 1 || attemptIndex > R4_SPEC.cohort.maxAttempts) {
    throw new R4RunnerError('R4_RUNNER_ATTEMPT_INDEX_INVALID', { attemptIndex, maxAttempts: R4_SPEC.cohort.maxAttempts });
  }
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
    if (String(error?.message) !== 'R4_APPROVAL_MISSING' && String(error?.message) !== 'R4_AUTHORITY_APPROVAL_COMMIT_NOT_FOUND') throw error;
    authorityResolution = resolveR4ExecutionAuthority({ cwd: workdir, sealPath: options.sealPath, approvalPath: options.approvalPath, requireApproval: false });
  }
  const { seal, authority } = authorityResolution;
  const t0 = authorityResolution.t0;
  const startWindow = t0 === null ? null : evaluateAttemptStartWindow({ t0, now });
  return {
    mode: options.mode, sealPath: options.sealPath, sealFingerprint: seal.fingerprint,
    protocolCommit: authority.protocolCommit, authorityCommit: authority.sealAuthorityCommit,
    sealCommitterTimestamp: authority.sealCommitterTimestamp, sealCommitterIso: authority.sealCommitterIso,
    authorityStage: authorityResolution.stage, approvalCommit: authorityResolution.approvalCommit,
    approvalCommitterTimestamp: authorityResolution.approvalCommitterTimestamp ?? null,
    t0, t0Iso: t0 === null ? null : new Date(t0).toISOString(), startWindow,
    t0Reached: t0 === null ? false : now >= t0, attemptIndex,
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

/** Deterministic capability-bound session id: unpredictable and manifest-authenticated. */
export function deriveSessionId({ sealFingerprint, approvalCommit, attemptIndex, capabilityHash: hash }) {
  return digest({ purpose: 'R4_ATTEMPT_SESSION', sealFingerprint, approvalCommit, attemptIndex, capabilityHash: hash }).slice(0, 32);
}

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
 * Every authority/window gate that must pass before a real attempt may start,
 * with no child process spawned. This is the acceptance point the round-2
 * synthetic no-network fixture exercises.
 */
export function authorizeSealedAttempt({ argv = [], env = process.env, now = Date.now(), cwd = null } = {}) {
  const options = parseRunnerArgs(argv);
  const workdir = cwd ?? options.cwd;
  const report = preflight({ argv, env, now, cwd: workdir });
  if (options.mode !== 'capture') throw new R4RunnerError('R4_SEALED_CAPTURE_MODE_REQUIRED');
  if (!options.execute) throw new R4RunnerError('R4_SEALED_CAPTURE_REQUIRES_EXECUTE');
  if (report.authorityStage !== 'A') throw new R4RunnerError('R4_SEALED_CAPTURE_REQUIRES_APPROVAL_COMMIT');
  // The [T0, T0+5min) window is evaluated here and never recomputed or rolled
  // forward. A missed window is terminal for this authorization.
  const startWindow = assertAttemptStartAllowed({ attemptIndex: report.attemptIndex, t0: report.t0, now });
  const resolution = resolveR4ExecutionAuthority({ cwd: workdir, sealPath: options.sealPath, approvalPath: options.approvalPath, requireApproval: true });
  return { options, workdir, report, startWindow, resolution };
}

/**
 * Gated real capture. Not invoked by any validator in this repository.
 */
export function main(argv = process.argv.slice(2), { env = process.env, now = Date.now(), spawn = spawnSync, cwd = null } = {}) {
  const options = parseRunnerArgs(argv);
  const workdir = cwd ?? options.cwd;
  if (options.mode === 'preflight') return { report: preflight({ argv, env, now, cwd: workdir }), executed: false };
  const { report, startWindow, resolution } = authorizeSealedAttempt({ argv, env, now, cwd: workdir });

  const capability = createAttemptCapability();
  const hash = capabilityHash(capability);
  const sessionId = deriveSessionId({ sealFingerprint: resolution.seal.fingerprint, approvalCommit: resolution.approvalCommit, attemptIndex: report.attemptIndex, capabilityHash: hash });
  const authorization = createAttemptAuthorization({
    seal: resolution.seal, authority: resolution.authority, approvalCommit: resolution.approvalCommit,
    attemptIndex: report.attemptIndex, sessionId, t0: resolution.t0, capabilityHash: hash, captureSpecDigest: captureSpecDigest(),
  });
  writeAttemptAuthorization(authorization, { cwd: workdir });
  const proof = proveCapability({ capability, record: authorization });
  const open = createSessionAttestation({ seal: resolution.seal, authority: resolution.authority, approvalAuthority: resolution, proof });

  const childEnv = sanitizeSealedChildEnvironment(report.effectiveEnvironment);
  const sandbox = mkdtempSync(path.join(tmpdir(), 'evolve-r4-capability-'));
  const capabilityFile = path.join(sandbox, 'capability.bin');
  let exitCode = null;
  try {
    writeFileSync(capabilityFile, capability, { mode: 0o600 });
    const fd = openSync(capabilityFile, 'r');
    try {
      const result = spawn(process.execPath, R4_SEALED_CAPTURE_ARGS, { cwd: workdir, env: childEnv, stdio: ['ignore', 'inherit', 'inherit', fd] });
      exitCode = result?.status ?? null;
    } finally { closeSync(fd); }
  } finally {
    // The raw capability exists only inside the child descriptor and this
    // short-lived 0600 file, which is removed immediately.
    try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  if (exitCode !== 0) throw new R4RunnerError('R4_SEALED_CAPTURE_CHILD_FAILED', { exitCode });

  const receipt = readSessionReceipt(sessionId, { cwd: workdir });
  if (!receipt) throw new R4RunnerError('R4_SESSION_RECEIPT_MISSING');
  assertSessionReceipt(receipt, { proof, record: authorization });
  verifySessionManifest({ cwd: workdir, sessionId, expectedFingerprint: receipt.sessionFingerprint });
  const finalized = finalizeSessionAttestation(open, { sessionFingerprint: receipt.sessionFingerprint, revisitCoverage: receipt.revisitCoverage, proof });
  const written = writeSessionAttestation(finalized, { root: path.resolve(workdir, R4_ATTESTATION_DIR) });
  return { report, executed: true, sessionId, attemptIndex: report.attemptIndex, startWindow,
    openAttestationFingerprint: open.fingerprint, attestationFingerprint: finalized.fingerprint,
    attestationFile: written.file, receiptFingerprint: receipt.fingerprint, exitCode };
}

export { R4_SESSION_ROLE, R4_ATTESTATION_DIR, R4_ATTEMPT_AUTH_DIR, R4_CAPABILITY_FD, R4_REMOTE_MAIN, R4_TRACKED_SEAL_PATH, R4_PRECAPTURE_APPROVAL_PATH, R4_ATTEMPT1_WINDOW_MS, remoteContains };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { report, executed } = main();
    console.log(JSON.stringify({ executed, ...reportView(report) }, null, 2));
  } catch (error) {
    console.error(`[R4] sealed cohort runner refused: ${error.code ?? 'R4_RUNNER_ERROR'}`);
    if (error.detail) console.error(JSON.stringify(error.detail, null, 2));
    process.exitCode = 1;
  }
}
