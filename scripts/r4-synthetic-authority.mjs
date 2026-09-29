// SYNTHETIC R4 authority fixtures for validators only (never runtime).
//
// Builds a real, temporary Git repository with a genuine P -> S -> A chain:
//
//   P  every canonical bound artifact, byte-identical to this checkout
//   S  adds only the canonical tracked seal (built over P)
//   A  adds only a synthetic approval artifact (direct parent S)
//
// plus a local BARE repository registered as `origin`, so the live remote proof
// (`git ls-remote origin refs/heads/main`) runs for real without any network.
// Variants model every round-3 negative case (stale cached tracking ref, remote
// behind/ahead/unrelated/unavailable, local-only A, wrong-parent A, A for a
// superseded seal, HEAD != A, ...).
//
// Nothing here touches this repository's `.evolve` evidence, creates a real
// approval, materializes a real T0 or starts a capture. Every artifact lives in
// a fresh `mkdtemp` directory the caller removes.
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical } from './market-intelligence/definition.mjs';
import { aggregate } from './market-intelligence/aggregate.mjs';
import { observation } from './market-intelligence/normalize.mjs';
import { createStorage } from './market-intelligence/storage.mjs';
import { R4_REQUIRED_BOUND_FILES, R4_TRACKED_SEAL_PATH } from './r4-protocol-spec.mjs';
import { buildSeal } from './r4-preregistration-seal.mjs';
import { buildApprovalRecord, approvalT0, R4_APPROVAL_PATH, R4_APPROVAL_VERDICT } from './r4-approval.mjs';
import { acquireRunnerCapability, createSessionReceipt, writeSessionReceipt } from './r4-capability.mjs';
import { main as runnerMain } from './r4-cohort-run.mjs';

export const R4_SYNTHETIC_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SYNTHETIC_MINT = 'So11111111111111111111111111111111111111112';
const P_ISO = '2026-09-28T10:00:00Z';
const S_ISO = '2026-09-28T10:05:00Z';
export const SYNTHETIC_APPROVAL_ISO = '2026-09-28T10:10:00Z';

const stampOf = iso => `${Math.floor(Date.parse(iso) / 1000)} +0000`;

export function makeWritable(target) {
  let info; try { info = statSync(target); } catch { return; }
  if (info.isDirectory()) {
    try { chmodSync(target, 0o755); } catch { /* best effort */ }
    try { for (const entry of readdirSync(target)) makeWritable(path.join(target, entry)); } catch { /* best effort */ }
  } else { try { chmodSync(target, 0o644); } catch { /* best effort */ } }
}

export function removeTree(target) { makeWritable(target); rmSync(target, { recursive: true, force: true }); }

export function gitRunner(dir) {
  return (args, env = {}) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', ...env } });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
}

export function commitAll(run, message, iso) {
  run(['add', '-A']);
  run(['commit', '-q', '--no-verify', '-m', message], { GIT_AUTHOR_DATE: stampOf(iso), GIT_COMMITTER_DATE: stampOf(iso) });
  return run(['rev-parse', 'HEAD']);
}

/**
 * Build a synthetic P -> S -> A repository.
 *
 * Options (each models one negative case; defaults are the valid chain):
 *   remoteMain          'A' | 'S' | 'P' | 'X' (commit after A) | 'unrelated' | 'none'
 *   trackingRef         cached refs/remotes/origin/main: 'A' | 'S' | null
 *   approvalCommitted   false: approval exists only in the worktree (no commit A)
 *   approvalParent      'S' | 'intermediate' (a commit between S and A)
 *   approvalSeal        'current' | 'superseded' (approval binds another seal)
 *   supersededSeal      true: the tracked seal no longer verifies (drifted spec)
 *   headAfterA          true: an extra local commit on top of A (HEAD != A)
 *   approvalIso         committer time of A (T0 derives from it)
 */
export function syntheticAuthorityRepo({
  remoteMain = 'A', trackingRef = null, approvalCommitted = true, approvalParent = 'S', approvalSeal = 'current',
  supersededSeal = false, headAfterA = false, approvalIso = SYNTHETIC_APPROVAL_ISO,
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'evolve-r4-synth-'));
  const dir = path.join(root, 'repo');
  const remoteDir = path.join(root, 'origin.git');
  mkdirSync(dir);
  const run = gitRunner(dir);
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 'r4-synthetic@example.test']);
  run(['config', 'user.name', 'R4 Synthetic Authority']);
  run(['config', 'commit.gpgsign', 'false']);
  for (const file of R4_REQUIRED_BOUND_FILES) {
    if (file === R4_TRACKED_SEAL_PATH) continue;
    const target = path.join(dir, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(path.join(R4_SYNTHETIC_REPO, file)));
  }
  writeFileSync(path.join(dir, '.gitignore'), '.evolve/\n');
  const protocolCommit = commitAll(run, 'P: synthetic protocol', P_ISO);
  const protocolTree = run(['rev-parse', `${protocolCommit}^{tree}`]);
  const load = file => readFileSync(path.join(dir, file));
  const seal = buildSeal({ baseSha: protocolCommit, baseTree: protocolTree, sealedAt: Date.parse(S_ISO), load });
  // A superseded seal: its recorded content no longer matches the canonical
  // specification of this revision, so it can never anchor execution.
  const tracked = supersededSeal ? { ...seal, specDigest: '0'.repeat(64) } : seal;
  mkdirSync(path.join(dir, path.dirname(R4_TRACKED_SEAL_PATH)), { recursive: true });
  writeFileSync(path.join(dir, R4_TRACKED_SEAL_PATH), canonical(tracked) + '\n');
  const sealCommit = commitAll(run, 'S: synthetic seal', S_ISO);
  let intermediateCommit = null;
  if (approvalParent === 'intermediate') {
    writeFileSync(path.join(dir, 'governance/r4/NOTE.txt'), 'intermediate\n');
    intermediateCommit = commitAll(run, 'X: intermediate', '2026-09-28T10:07:00Z');
  }
  const bindSeal = approvalSeal === 'superseded'
    ? buildSeal({ baseSha: protocolCommit, baseTree: protocolTree, sealedAt: Date.parse(S_ISO) - 86_400_000, load })
    : seal;
  const approval = buildApprovalRecord({ seal: bindSeal, authority: { protocolCommit, sealAuthorityCommit: sealCommit },
    reviewer: 'synthetic-independent-reviewer', reviewerModel: 'synthetic-model', reviewVerdict: R4_APPROVAL_VERDICT,
    reviewReportDigest: 'd'.repeat(64) });
  writeFileSync(path.join(dir, R4_APPROVAL_PATH), canonical(approval) + '\n');
  let approvalCommit = null;
  if (approvalCommitted) approvalCommit = commitAll(run, 'A: synthetic approval', approvalIso);
  let afterCommit = null;
  if (headAfterA) {
    writeFileSync(path.join(dir, 'governance/r4/AFTER.txt'), 'after A\n');
    afterCommit = commitAll(run, 'X: after approval', '2026-09-28T10:12:00Z');
  }
  // Live remote.
  const refs = { A: approvalCommit, S: sealCommit, P: protocolCommit, X: afterCommit };
  if (remoteMain !== 'none') {
    spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remoteDir], { encoding: 'utf8' });
    run(['remote', 'add', 'origin', remoteDir]);
    if (remoteMain === 'unrelated') {
      const orphan = path.join(root, 'orphan');
      mkdirSync(orphan);
      const orun = gitRunner(orphan);
      orun(['init', '-q', '-b', 'main']);
      orun(['config', 'user.email', 'r4-synthetic@example.test']);
      orun(['config', 'user.name', 'R4 Synthetic Authority']);
      orun(['config', 'commit.gpgsign', 'false']);
      writeFileSync(path.join(orphan, 'unrelated.txt'), 'unrelated\n');
      commitAll(orun, 'unrelated', '2026-09-28T10:20:00Z');
      orun(['push', '-q', remoteDir, 'HEAD:refs/heads/main']);
    } else {
      const target = refs[remoteMain];
      if (!target) throw new Error(`SYNTHETIC_REMOTE_TARGET_MISSING:${remoteMain}`);
      run(['push', '-q', 'origin', `${target}:refs/heads/main`]);
    }
  } else {
    // A configured-but-unreachable origin: the live query must fail closed.
    run(['remote', 'add', 'origin', path.join(root, 'missing-remote.git')]);
  }
  if (trackingRef) run(['update-ref', 'refs/remotes/origin/main', refs[trackingRef]]);
  else { try { run(['update-ref', '-d', 'refs/remotes/origin/main']); } catch { /* absent */ } }
  const approvalTimestamp = Date.parse(approvalIso);
  return {
    root, dir, remoteDir, run, protocolCommit, sealCommit, approvalCommit, intermediateCommit, afterCommit,
    seal, approval, t0: approvalT0(approvalTimestamp),
    // Pushing by PATH (not by the remote name) moves the live remote WITHOUT
    // refreshing the local `refs/remotes/origin/main` cache — i.e. it models
    // someone else moving the remote while this clone's tracking ref goes stale.
    setRemoteMain(sha) { run(['push', '-q', '--force', remoteDir, `${sha}:refs/heads/main`]); },
    setTrackingRef(sha) { run(['update-ref', 'refs/remotes/origin/main', sha]); },
    cleanup() { removeTree(root); },
  };
}

/* ------------------------------------------------------- evidence sessions */

function records(time, price = 2, dexPrice = null) {
  return ['jupiter', 'dexscreener'].map(provider => {
    const providerPrice = provider === 'dexscreener' ? (dexPrice ?? price) : price;
    const normalized = { priceUsd: providerPrice, providerFixture: provider, liquidityUsd: null, volumes: { m5: null, h1: null },
      transactions: { m5: { buys: null, sells: null } }, priceChanges: { m5: null, h1: null }, pairCreatedAt: time };
    return observation({ provider, endpoint: '/' + provider, mint: SYNTHETIC_MINT, payload: { provider, time, price: providerPrice }, normalized, receivedAt: time, staleMs: 60000 });
  });
}

/** A finalized, authenticated synthetic capture session under `<cwd>/.evolve/market-intelligence`. */
export function buildSyntheticEvidenceSession({ cwd, sessionId, startAt, snapshots = null }) {
  const points = snapshots ?? [{ time: startAt, price: 2 }, { time: startAt + 300_000, price: 3 }];
  const storage = createStorage({ root: path.resolve(cwd, '.evolve/market-intelligence'), sessionId, startedAt: points[0].time });
  for (const { time, price, dexPrice = null } of points) {
    const rs = records(time, price, dexPrice);
    for (const record of rs) storage.writeObservation(record, { provider: record.provider, time, price: record.normalized.priceUsd });
    storage.writeSnapshot(aggregate(rs, { observedAt: time })[0]);
  }
  const manifest = storage.finalize({ endedAt: points.at(-1).time + 1000, reason: 'duration reached' });
  return { dir: storage.dir, manifest };
}

/**
 * In-process stand-in for the capture CHILD, for the runner's injectable
 * `spawn`. It exercises the REAL capture-side primitive: it reads the raw
 * capability from the inherited descriptor and atomically claims it with
 * `acquireRunnerCapability`, exactly as `scripts/market-intelligence.mjs` does.
 *
 *   behaviour 'complete'    claim, write an authenticated session + receipt, exit 0
 *   behaviour 'fail'        claim, exit 1 (capture failure after the claim)
 *   behaviour 'no-claim'    exit 1 without claiming
 */
export function syntheticChildSpawn({ behaviour = 'complete', now, sessionStartAt, onClaim = null } = {}) {
  return (execPath, args, options) => {
    if (behaviour === 'no-claim') return { status: 1 };
    const fd = options.stdio[3];
    const sealed = acquireRunnerCapability({ fd, cwd: options.cwd, now });
    onClaim?.(sealed);
    if (behaviour === 'fail') return { status: 1 };
    const { manifest } = buildSyntheticEvidenceSession({ cwd: options.cwd, sessionId: sealed.sessionId, startAt: sessionStartAt ?? now });
    writeSessionReceipt(createSessionReceipt({ authorizationFingerprint: sealed.authorizationFingerprint, capabilityHash: sealed.capabilityHash,
      claimFingerprint: sealed.claimFingerprint, sessionId: manifest.sessionId, sessionFingerprint: manifest.fingerprint,
      revisitCoverage: { scheduled: 1, completed: 1, failed: 0, pending: 0 } }), { cwd: options.cwd });
    return { status: 0 };
  };
}

/**
 * A valid synthetic chain whose attempt 1 ran through the REAL runner
 * (`main(['capture', '--execute'])`) inside the [T0, T0+5min) window with an
 * in-process child that claimed the capability and produced an authenticated
 * session. Leaves a COMPLETED attempt 1 in the synthetic evidence root.
 */
export function completedAttemptFixture(options = {}) {
  const fixture = syntheticAuthorityRepo(options);
  const now = fixture.t0 + 60_000;
  const result = runnerMain(['capture', '--execute'], { env: {}, now, cwd: fixture.dir, clock: () => now + 1000,
    spawn: syntheticChildSpawn({ behaviour: 'complete', now, sessionStartAt: now }) });
  return { fixture, result, now };
}

/** Open a descriptor holding `capability` (the runner's delivery form) for a test child. */
export function capabilityDescriptor(capability, scratchDir) {
  const file = path.join(scratchDir, `capability-${process.pid}-${Math.random().toString(16).slice(2)}.bin`);
  writeFileSync(file, capability, { mode: 0o600, flag: 'wx' });
  const fd = openSync(file, 'r');
  rmSync(file);
  return { fd, close() { try { closeSync(fd); } catch { /* closed */ } } };
}
