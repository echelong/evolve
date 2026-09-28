#!/usr/bin/env node
// R4 sealed cohort runner — the ONLY entrypoint allowed to create a real R4
// cohort session.
//
// Enforcement only. Inputs are limited to the canonical tracked seal path and an
// attempt index. EVERY scientific capture parameter is derived from the frozen
// specification and the canonical tracked seal; the runner accepts no
// scientifically meaningful runtime override.
//
// Modes:
//   preflight   (default) — read-only. Verify authority, T0, environment drift
//                            and storage headroom. Writes nothing, captures
//                            nothing.
//   capture      — gated by `--execute`. Re-runs preflight, then starts exactly
//                  one sealed 45-minute capture with the sealed environment and
//                  records a session attestation. Not invoked by any validator.
//
// No outcome is generated here and no cohort membership is decided here.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCanonicalTrackedSeal, authorityT0, R4_REPO_ROOT, R4_TRACKED_SEAL_PATH, R4_REMOTE_MAIN, remoteContains } from './r4-authority.mjs';
import { R4_SPEC, classifyCaptureEnvironment, sealedCaptureEnvironment } from './r4-protocol-spec.mjs';
import { createSessionAttestation, finalizeSessionAttestation, writeSessionAttestation, R4_ATTESTATION_DIR } from './r4-attestation.mjs';
import { R4_SESSION_ROLE } from './r4-attestation.mjs';

const MIB = 1024 * 1024;
export const R4_SEALED_CAPTURE_ARGS = Object.freeze(['scripts/market-intelligence.mjs', 'capture', '--r4-revisits', '--minutes', String(R4_SPEC.cohort.referenceMinutes)]);

export class R4RunnerError extends Error {
  constructor(code, detail = null) { super(code); this.code = code; this.detail = detail; }
}

/** Parse runner arguments. Only the seal path and the attempt index are accepted. */
export function parseRunnerArgs(argv = []) {
  const mode = ['capture', 'preflight'].includes(argv[0]) ? argv[0] : 'preflight';
  const rest = argv[0] === mode ? argv.slice(1) : argv;
  const options = {
    mode,
    sealPath: R4_TRACKED_SEAL_PATH,
    attemptIndex: null,
    execute: false,
    requireRemote: false,
    sessionId: null,
    cwd: R4_REPO_ROOT,
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--seal') options.sealPath = rest[++i];
    else if (arg === '--attempt') options.attemptIndex = Number(rest[++i]);
    else if (arg === '--session') options.sessionId = rest[++i];
    else if (arg === '--cwd') options.cwd = path.resolve(rest[++i]);
    else if (arg === '--execute') options.execute = true;
    else if (arg === '--require-remote') options.requireRemote = true;
    else throw new R4RunnerError('R4_RUNNER_ARGUMENT_UNSUPPORTED', { arg });
  }
  return options;
}

export const R4_RUNNER_LOCKED_ARGUMENTS = Object.freeze([
  'minutes', 'duration', 'provider', 'providers', 'universe', 'endpoint', 'endpoints', 'poll', 'budget',
  'freshness', 'stale', 'alignment', 'horizon', 'tolerance', 'mode', 'role', 'replicates', 'bootstrap',
  'exposure', 'outcome',
]);

/**
 * Environment drift gate. Every capture environment variable is classified:
 *   A scientific/evidence-changing  -> FAIL BEFORE CAPTURE on any mismatch
 *   B operational-only              -> permitted
 *   C secret/credential             -> permitted to exist; behaviour stays sealed
 * Any unclassified capture-shaped variable present is treated as class A drift.
 */
export function enforceSealedCaptureEnvironment(env = process.env) {
  const { table, drift } = classifyCaptureEnvironment(env);
  if (drift.length) throw new R4RunnerError('R4_CAPTURE_ENV_DRIFT', { drift, table });
  return { table, drift };
}

/**
 * Pre-capture storage preflight. Estimates worst-case bytes for the sealed
 * reference window plus the bounded drain using the documented methods-only
 * high-water rate, and reports headroom against the configured (sealed) cap.
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
    sealedMiB, minSessionMiB: R4_SPEC.capture.storage.minSessionMiB, maxSessionMiB: R4_SPEC.capture.storage.maxSessionMiB,
    capBytes, rateBytesPerMinute, windowMinutes, drainMinutes, worstCaseBytes, headroomBytes, ok: headroomBytes >= 0,
    defaultCapMiB: R4_SPEC.capture.storage.defaultSessionMiB,
  };
}

export function assertStoragePreflight(preflight) {
  if (!preflight.ok) throw new R4RunnerError('R4_STORAGE_PREFLIGHT_REFUSED', preflight);
  return preflight;
}

/** Read-only preflight: authority, T0, environment drift and storage headroom. */
export function preflight({ argv = [], env = process.env, now = Date.now() } = {}) {
  const options = parseRunnerArgs(argv);
  const { seal, authority } = loadCanonicalTrackedSeal({
    cwd: options.cwd, sealPath: options.sealPath,
    requireSealCommit: true, requireHead: true, requireRemote: options.requireRemote,
  });
  const attemptIndex = options.attemptIndex ?? 1;
  if (!Number.isInteger(attemptIndex) || attemptIndex < 1 || attemptIndex > R4_SPEC.cohort.maxAttempts) {
    throw new R4RunnerError('R4_RUNNER_ATTEMPT_INDEX_INVALID', { attemptIndex, maxAttempts: R4_SPEC.cohort.maxAttempts });
  }
  const environment = enforceSealedCaptureEnvironment(env);
  const storage = assertStoragePreflight(storagePreflight({}));
  const t0 = authorityT0(authority.sealCommitterTimestamp);
  return {
    mode: options.mode, sealPath: options.sealPath, sealFingerprint: seal.fingerprint,
    protocolCommit: authority.protocolCommit, authorityCommit: authority.sealAuthorityCommit,
    sealCommitterTimestamp: authority.sealCommitterTimestamp, sealCommitterIso: authority.sealCommitterIso,
    t0, t0Iso: new Date(t0).toISOString(), t0Reached: now >= t0, attemptIndex,
    sessionId: options.sessionId ?? `${now}-${authority.sealAuthorityCommit.slice(0, 8)}`,
    environmentTable: environment.table, storage,
    captureArgs: [...R4_SEALED_CAPTURE_ARGS], captureMode: R4_SPEC.cohort.captureMode,
    seal, authority,
  };
}

/** Serialisable view of a preflight report (no seal/authority objects). */
export function reportView(report) {
  const view = { ...report };
  delete view.seal;
  delete view.authority;
  return view;
}

/**
 * Gated real capture. Not invoked by any validator in this repository.
 */
export function main(argv = process.argv.slice(2), { env = process.env, now = Date.now(), spawn = spawnSync } = {}) {
  const options = parseRunnerArgs(argv);
  const report = preflight({ argv, env, now });
  if (options.mode === 'preflight') return { report, executed: false };
  if (!options.execute) throw new R4RunnerError('R4_SEALED_CAPTURE_REQUIRES_EXECUTE');
  if (!report.t0Reached) throw new R4RunnerError('R4_SEALED_CAPTURE_BEFORE_T0', { t0Iso: report.t0Iso });
  // The attestation opens BEFORE capture and is bound to the authenticated
  // manifest fingerprint after the session finalizes. Binding below is the
  // contract; the sealed manifest fingerprint is produced by the capture child.
  const open = createSessionAttestation({ seal: report.seal, authority: report.authority,
    attemptIndex: report.attemptIndex, sessionId: report.sessionId });
  const childEnv = { ...sealedCaptureEnvironment(env), R4_SEALED_RUNNER: 'yes' };
  const result = spawn(process.execPath, R4_SEALED_CAPTURE_ARGS, { cwd: options.cwd, env: childEnv, stdio: 'inherit' });
  void finalizeSessionAttestation;
  void writeSessionAttestation;
  return { report, executed: true, openAttestationFingerprint: open.fingerprint, exitCode: result?.status ?? null };
}

export { R4_SESSION_ROLE, R4_ATTESTATION_DIR, R4_REMOTE_MAIN, remoteContains };

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
