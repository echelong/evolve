#!/usr/bin/env node
// R4 independent pre-capture re-review ROUND 2 regression matrix.
//
// Every case corresponds to a round-2 blocker (B1-B4), a round-2 P3 finding
// (P3-5..P3-9) or the new pre-capture governance freeze (P -> S -> A). Synthetic
// temporary fixtures only: no .evolve evidence is read or written, no capture is
// started, no cohort attempt is created, no real outcome is generated, no real T0
// is materialized and no approval commit A is created in this repository.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { canonical, digest } from './market-intelligence/definition.mjs';
import { aggregate } from './market-intelligence/aggregate.mjs';
import { observation } from './market-intelligence/normalize.mjs';
import { createStorage } from './market-intelligence/storage.mjs';
import { readSourceSession } from './market-outcomes/index.mjs';
import { buildSeal, verifyR4Seal, gitIdentity } from './r4-preregistration-seal.mjs';
import { R4_REQUIRED_BOUND_FILES, captureSpecDigest, classifyCaptureEnvironment, sanitizeSealedChildEnvironment, assertSealedChildEnvironment } from './r4-protocol-spec.mjs';
import { loadEffectiveEnvironment } from './lib/env.mjs';
import { assertLiveRemoteMainEquals, assertWorktreeIntegrity } from './r4-authority.mjs';
import {
  createAttemptCapability, capabilityHash, createAttemptAuthorization, proveCapability, assertAttemptProof,
  resolveCapabilityRecord, acquireRunnerCapability, writeAttemptAuthorization, claimAttemptAuthorization,
} from './r4-capability.mjs';
import { completedAttemptFixture, removeTree } from './r4-synthetic-authority.mjs';
import { resolveR4ExecutionAuthority } from './r4-approval.mjs';
import { createSessionAttestation, finalizeSessionAttestation } from './r4-attestation.mjs';
import {
  evaluateSealedCohortProgress, deriveCanonicalCohortMembership, planSealedCohort,
  buildCanonicalReferenceSet, buildCanonicalReferenceSetFromEvidence, verifyCanonicalReferenceSet,
  certifyExposureRows, certifyExposureRowsFromEvidence, assertNoAnalysisOverrides,
  buildOutcomeRunBinding, verifyOutcomeRunBinding,
} from './r4-enforcement.mjs';
import { runCanonicalR4Analysis } from './r4-canonical-analysis.mjs';
import { buildCohortPlan } from './r4-cohort-plan.mjs';
import {
  R4_APPROVAL_PATH, R4_APPROVAL_VERDICT, buildApprovalRecord, assertApprovalRecord, verifyApprovalGitContract,
  findApprovalCommit, approvalT0, evaluateAttemptStartWindow, assertAttemptStartAllowed, R4_START_WINDOW,
} from './r4-approval.mjs';
import { parseRunnerArgs } from './r4-cohort-run.mjs';
import { assertImportClosureBound } from './r4-import-closure.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = 1_800_000_000_000;
const MINT = 'So11111111111111111111111111111111111111112';
const SEAL_COMMIT_TIME = Date.UTC(2026, 8, 28, 10, 0, 0);
const APPROVAL_SHA = 'b'.repeat(40);
const T0 = approvalT0(SEAL_COMMIT_TIME);

const seal = buildSeal({ ...gitIdentity(REPO), sealedAt: T });
const authority = Object.freeze({ sealAuthorityCommit: 'a'.repeat(40), protocolCommit: seal.protocolCommit, protocolTree: seal.protocolTree, sealCommitterTimestamp: SEAL_COMMIT_TIME });
const approvalAuthority = Object.freeze({ approvalCommit: APPROVAL_SHA, t0: T0 });

const roots = [];
const tempRoot = () => { const root = mkdtempSync(path.join(tmpdir(), 'evolve-r4-round2-')); roots.push(root); return root; };
function makeWritable(target) {
  let info; try { info = statSync(target); } catch { return; }
  if (info.isDirectory()) { try { for (const entry of readdirSync(target)) makeWritable(path.join(target, entry)); } catch { /* best effort */ } try { chmodSync(target, 0o755); } catch { /* best effort */ } }
  else { try { chmodSync(target, 0o644); } catch { /* best effort */ } }
}

/* ----------------------------------------------------------- fixtures */

function records(time, price = 2, dexPrice = null) {
  return ['jupiter', 'dexscreener'].map(provider => {
    const providerPrice = provider === 'dexscreener' ? (dexPrice ?? price) : price;
    const normalized = { priceUsd: providerPrice, providerFixture: provider, liquidityUsd: null, volumes: { m5: null, h1: null },
      transactions: { m5: { buys: null, sells: null } }, priceChanges: { m5: null, h1: null }, pairCreatedAt: time };
    return observation({ provider, endpoint: '/' + provider, mint: MINT, payload: { provider, time, price: providerPrice }, normalized, receivedAt: time, staleMs: 60000 });
  });
}

function buildEvidenceSession({ cwd, sessionId, snapshots = [{ time: T, price: 2 }, { time: T + 300_000, price: 3 }], root = '.evolve/market-intelligence' }) {
  const storage = createStorage({ root: path.resolve(cwd, root), sessionId, startedAt: snapshots[0].time });
  for (const { time, price, dexPrice = null } of snapshots) {
    const rs = records(time, price, dexPrice);
    for (const record of rs) storage.writeObservation(record, { provider: record.provider, time, price: record.normalized.priceUsd });
    storage.writeSnapshot(aggregate(rs, { observedAt: time })[0]);
  }
  storage.finalize({ endedAt: snapshots.at(-1).time + 1000, reason: 'duration reached' });
  return { dir: storage.dir, sessionsRoot: path.resolve(cwd, root, 'sessions') };
}

function attestedFixture({ cwd = tempRoot(), sessionId = 'r4-round2', attemptIndex = 1 } = {}) {
  const { dir, sessionsRoot } = buildEvidenceSession({ cwd, sessionId });
  const session = readSourceSession({ dir, role: 'cohort' });
  const capability = createAttemptCapability();
  const hash = capabilityHash(capability);
  const authorization = createAttemptAuthorization({ seal, authority, approvalCommit: APPROVAL_SHA, attemptIndex,
    sessionId, t0: T0, capabilityHash: hash, captureSpecDigest: captureSpecDigest(), authorizedAt: T0 + 1000 });
  // Round 3: an attestation requires the durable capture-child claim.
  const governance = tempRoot();
  writeAttemptAuthorization(authorization, { cwd: governance });
  const claim = claimAttemptAuthorization({ record: authorization, capability, cwd: governance, now: T0 + 2000 });
  const proof = proveCapability({ capability, record: authorization });
  const open = createSessionAttestation({ seal, authority, approvalAuthority, proof });
  const attestation = finalizeSessionAttestation(open, { sessionFingerprint: session.fingerprint,
    revisitCoverage: { scheduled: 1, completed: 1, failed: 0, pending: 0 }, proof, claim });
  const plan = buildCohortPlan({ sealFingerprint: seal.fingerprint, preregistrationDigest: seal.preregistration.sha256,
    t0: T0, approvalCommit: APPROVAL_SHA });
  const attempts = [{ index: attemptIndex, status: 'COMPLETED', sessionId, failureCode: null, replacementOf: null, attestationFingerprint: attestation.fingerprint }];
  return { cwd, sessionsRoot, session, attestation, authorization, proof, plan, attempts };
}

function gitRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'evolve-r4-git-'));
  roots.push(dir);
  const run = (args, env = {}) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 'r4@example.test']);
  run(['config', 'user.name', 'R4 Round2']);
  run(['config', 'commit.gpgsign', 'false']);
  return { dir, run };
}

const seconds = iso => Math.floor(Date.parse(iso) / 1000);
function commit(repo, { message, iso, files }) {
  for (const [file, body] of Object.entries(files)) {
    const full = path.join(repo.dir, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  repo.run(['add', '-A']);
  const stamp = `${seconds(iso)} +0000`;
  repo.run(['commit', '-q', '-m', message], { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp });
  return repo.run(['rev-parse', 'HEAD']);
}

/**
 * Synthetic P -> S -> A history. The seal/approval content is a governance
 * fixture; no real canonical seal is produced and no real approval exists.
 */
function syntheticApprovalChain({ parentIsProtocol = false, modifySource = false, pushApproval = true } = {}) {
  const repo = gitRepo();
  const protocolCommit = commit(repo, { message: 'P: protocol', iso: '2026-09-28T10:00:00Z', files: { 'src/code.js': 'export const v = 1;\n' } });
  const sealCommit = commit(repo, { message: 'S: seal', iso: '2026-09-28T10:05:00Z', files: { 'governance/r4/r4-preregistration-seal.json': '{"recordType":"r4_preregistration_seal"}\n' } });
  const approval = buildApprovalRecord({ seal, authority: { protocolCommit, sealAuthorityCommit: sealCommit },
    reviewer: 'independent-reviewer', reviewerModel: 'independent-model', reviewVerdict: R4_APPROVAL_VERDICT, reviewReportDigest: 'd'.repeat(64) });
  if (parentIsProtocol) repo.run(['checkout', '-q', protocolCommit]);
  const files = { [R4_APPROVAL_PATH]: canonical(approval) + '\n' };
  if (modifySource) files['src/code.js'] = 'export const v = 2;\n';
  const approvalCommit = commit(repo, { message: 'A: approval', iso: '2026-09-28T10:10:00Z', files });
  // Round 3: remote authority is the LIVE remote main, so the fixture pushes to
  // a real local bare `origin` rather than writing a cached tracking ref.
  const remoteDir = mkdtempSync(path.join(tmpdir(), 'evolve-r4-origin-'));
  roots.push(remoteDir);
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remoteDir]);
  repo.run(['remote', 'add', 'origin', remoteDir]);
  repo.run(['push', '-q', 'origin', `${pushApproval ? approvalCommit : sealCommit}:refs/heads/main`]);
  return { repo, protocolCommit, sealCommit, approvalCommit, approval };
}

/* ------------------------------------------------------------- matrix */

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const throwsCode = (fn, prefix) => assert.throws(fn, error => String(error?.message ?? error).startsWith(prefix), `expected ${prefix}`);
const refingerprintWith = (record, hash) => {
  const content = { ...record };
  delete content.fingerprint;
  return { ...content, fingerprint: hash(content) };
};

/* P1 — capability replaces the env flag (B1) */

test('P1-1: R4_SEALED_RUNNER=yes cannot authorize a direct capture', async () => {
  const { main } = await import('./market-intelligence.mjs');
  const previous = process.env.R4_SEALED_RUNNER;
  process.env.R4_SEALED_RUNNER = 'yes';
  try {
    await assert.rejects(() => main(['capture', '--r4-revisits', '--minutes', '45']), /R4_SEALED_RUNNER_REQUIRED/);
  } finally { if (previous === undefined) delete process.env.R4_SEALED_RUNNER; else process.env.R4_SEALED_RUNNER = previous; }
  // The variable is not even classified: it is no longer part of the trust boundary.
  assert.equal(classifyCaptureEnvironment({ R4_SEALED_RUNNER: 'yes' }).drift.length, 0);
});

test('P1-2: a direct capture cannot obtain a valid runner capability', () => {
  assert.equal(acquireRunnerCapability({ root: tempRoot() }), null); // no inherited descriptor
  throwsCode(() => resolveCapabilityRecord({ capability: randomBytes(32), root: tempRoot() }), 'R4_CAPABILITY_NOT_AUTHORIZED');
});

test('P1-3: standalone public-field attestation mint is rejected', () => {
  throwsCode(() => createSessionAttestation({ seal, authority, approvalAuthority, attemptIndex: 1, sessionId: 'r4-forged' }), 'R4_ATTESTATION_CAPABILITY_REQUIRED');
  const fixture = attestedFixture();
  throwsCode(() => finalizeSessionAttestation({ ...fixture.attestation, status: 'OPEN', sessionFingerprint: null }, { sessionFingerprint: fixture.session.fingerprint }), 'R4_ATTESTATION_CAPABILITY_REQUIRED');
});

test('P1-4: a copied capability cannot authorize a different attempt or session', () => {
  const fixture = attestedFixture();
  throwsCode(() => assertAttemptProof(fixture.proof, { attemptIndex: 2 }), 'R4_CAPABILITY_ATTEMPT_MISMATCH');
  throwsCode(() => assertAttemptProof(fixture.proof, { sessionId: 'other-session' }), 'R4_CAPABILITY_SESSION_MISMATCH');
  throwsCode(() => createSessionAttestation({ seal, authority, approvalAuthority: { ...approvalAuthority, approvalCommit: 'c'.repeat(40) }, proof: fixture.proof }), 'R4_ATTESTATION_APPROVAL_COMMIT_MISMATCH');
  const open = createSessionAttestation({ seal, authority, approvalAuthority, proof: fixture.proof });
  // A SECOND capability authorized for the SAME attempt and session still cannot
  // finalize this attestation: the authorization fingerprint must match.
  const { session } = fixture;
  const capability2 = createAttemptCapability();
  const other = proveCapability({ capability: capability2, record: createAttemptAuthorization({ seal, authority, approvalCommit: APPROVAL_SHA,
    attemptIndex: 1, sessionId: session.sessionId, t0: T0, capabilityHash: capabilityHash(capability2), captureSpecDigest: captureSpecDigest() }) });
  throwsCode(() => finalizeSessionAttestation(open, { sessionFingerprint: session.fingerprint, proof: other }), 'R4_ATTESTATION_CAPABILITY_MISMATCH');
});

test('P1-5: a wrong capability is rejected', () => {
  const fixture = attestedFixture();
  throwsCode(() => proveCapability({ capability: randomBytes(32), record: fixture.authorization }), 'R4_CAPABILITY_MISMATCH');
  const { proof, ...withoutProof } = fixture;
  assert.equal(typeof proof.capabilityHash, 'string');
  throwsCode(() => assertAttemptProof(undefined), 'R4_CAPABILITY_PROOF_REQUIRED');
  throwsCode(() => assertAttemptProof(withoutProof), 'R4_CAPABILITY_PROOF_INVALID');
});

/* P2 — mandatory remote proof (B2) */

test('P2-6: S not pushed to the live remote main fails remote authority', () => {
  const repo = gitRepo();
  const head = commit(repo, { message: 'local only', iso: '2026-09-28T09:00:00Z', files: { 'a.txt': 'a\n' } });
  throwsCode(() => assertLiveRemoteMainEquals(head, { cwd: repo.dir, what: 'SEAL_COMMIT_S' }), 'R4_AUTHORITY_REMOTE_UNAVAILABLE');
  // Round 3: a cached tracking ref is NOT remote proof.
  repo.run(['update-ref', 'refs/remotes/origin/main', head]);
  throwsCode(() => assertLiveRemoteMainEquals(head, { cwd: repo.dir, what: 'SEAL_COMMIT_S' }), 'R4_AUTHORITY_REMOTE_UNAVAILABLE');
  const remoteDir = mkdtempSync(path.join(tmpdir(), 'evolve-r4-origin-'));
  roots.push(remoteDir);
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remoteDir]);
  repo.run(['remote', 'add', 'origin', remoteDir]);
  repo.run(['push', '-q', 'origin', `${head}:refs/heads/main`]);
  assert.equal(assertLiveRemoteMainEquals(head, { cwd: repo.dir }).ok, true);
});

test('P2-7: an approval commit A that is not pushed fails', () => {
  const chain = syntheticApprovalChain({ pushApproval: false });
  throwsCode(() => verifyApprovalGitContract({ sealAuthorityCommit: chain.sealCommit, approval: chain.approval, cwd: chain.repo.dir, requireRemote: true, requireHead: false }), 'R4_AUTHORITY_REMOTE_MAIN_MISMATCH:APPROVAL_COMMIT_A');
});

test('P2-8b (section 8): a tracked working-tree runtime modification is rejected', () => {
  const repo = gitRepo();
  const head = commit(repo, { message: 'bound', iso: '2026-09-28T09:00:00Z', files: { 'a.js': 'export const a = 1;\n', 'b.js': 'export const b = 1;\n' } });
  assert.equal(assertWorktreeIntegrity({ cwd: repo.dir, requiredCommit: head, files: ['a.js', 'b.js'] }).ok, true);
  writeFileSync(path.join(repo.dir, 'a.js'), 'export const a = 2; // tampered\n');
  throwsCode(() => assertWorktreeIntegrity({ cwd: repo.dir, requiredCommit: head, files: ['a.js', 'b.js'] }), 'R4_WORKTREE_RUNTIME_MODIFIED');
  throwsCode(() => assertWorktreeIntegrity({ cwd: repo.dir, requiredCommit: 'e'.repeat(40), files: ['a.js'] }), 'R4_WORKTREE_HEAD_NOT_AUTHORITY_COMMIT');
});

test('P2-8: no flag disables remote proof', () => {
  throwsCode(() => parseRunnerArgs(['capture', '--require-remote']), 'R4_RUNNER_ARGUMENT_UNSUPPORTED');
  throwsCode(() => parseRunnerArgs(['capture', '--t0', '123']), 'R4_RUNNER_ARGUMENT_UNSUPPORTED');
});

/* P2 — complete bound-file set (B3) */

const BOUND_TAMPERS = [
  ['P2-9 recorder modification', 'scripts/market-intelligence/recorder.mjs'],
  ['P2-10 normalize modification', 'scripts/market-intelligence/normalize.mjs'],
  ['P2-11 provider modification', 'scripts/market-intelligence/providers/gmgn.mjs'],
  ['P2-12 definition/canonical modification', 'scripts/market-intelligence/definition.mjs'],
  ['P2-13 lib/env modification', 'scripts/lib/env.mjs'],
  ['P2-14 seal-verifier modification', 'scripts/r4-preregistration-seal.mjs'],
  ['P2-14b disagreement modification', 'scripts/market-intelligence/disagreement.mjs'],
  ['P2-14c approval-validator modification', 'scripts/r4-approval.mjs'],
  ['P2-14d capability-verifier modification', 'scripts/r4-capability.mjs'],
  ['P2-14e canonical-orchestrator modification', 'scripts/r4-canonical-analysis.mjs'],
  ['P2-14f runner modification', 'scripts/r4-cohort-run.mjs'],
];
for (const [name, file] of BOUND_TAMPERS) {
  test(`${name} is rejected by the canonical seal`, () => {
    assert(R4_REQUIRED_BOUND_FILES.includes(file), `${file} must be bound`);
    const scratch = buildSeal({ ...gitIdentity(REPO), sealedAt: T });
    const load = target => (target === file ? Buffer.from('Tampered runtime module\n') : readFileSync(path.join(REPO, target)));
    throwsCode(() => verifyR4Seal(scratch, { load }), 'R4_SEAL_FILE_DIGEST_MISMATCH');
  });
}

test('P2-15: a new runtime import not in the bound set fails the closure validator', () => {
  const readFile = file => file === 'scripts/lib/new-unbound-runtime-module.mjs' ? 'export const x = 1;\n'
    : (file === 'scripts/r4-protocol-spec.mjs' ? `import './lib/new-unbound-runtime-module.mjs';\n${readFileSync(path.join(REPO, file), 'utf8')}` : readFileSync(path.join(REPO, file), 'utf8'));
  throwsCode(() => assertImportClosureBound({ rootDir: REPO, required: R4_REQUIRED_BOUND_FILES, readFile }), 'R4_IMPORT_CLOSURE_UNBOUND');
});

/* P2 — effective environment before classification (B4) */

function envDir(content, name = '.env') {
  const dir = tempRoot();
  writeFileSync(path.join(dir, name), content);
  return dir;
}

test('P2-16: a class-A mismatch injected by .env is rejected', () => {
  const dir = envDir('EVOLVE_MARKET_MODE=auto\n');
  const { env, loaded } = loadEffectiveEnvironment({ dir, base: {} });
  assert.deepEqual(loaded, ['.env']);
  const { drift } = classifyCaptureEnvironment(env);
  assert.equal(drift[0].reason, 'SEALED_VALUE_MISMATCH');
  assert.throws(() => assertSealedChildEnvironment(env), /R4_CAPTURE_ENV_DRIFT/);
});

test('P2-17: an unknown EVOLVE_* variable injected by .env is rejected', () => {
  const dir = envDir('EVOLVE_TOTALLY_NEW_KNOB=1\nEVOLVE_SEED=42\n');
  const { env } = loadEffectiveEnvironment({ dir, base: {} });
  const { drift } = classifyCaptureEnvironment(env);
  assert.equal(drift.length, 2);
  assert(drift.every(entry => entry.reason === 'UNCLASSIFIED_CAPTURE_VARIABLE'));
});

test('P2-18: a credential injected by .env is accepted and stays class C', () => {
  const dir = envDir('JUPITER_API_KEY=secret-value\nEVOLVE_JEV_PROVIDER=typesafe-jev\n');
  const { env } = loadEffectiveEnvironment({ dir, base: {} });
  const { drift, table } = classifyCaptureEnvironment(env);
  assert.equal(drift.length, 0);
  assert.equal(table.find(entry => entry.name === 'JUPITER_API_KEY').class, 'C');
  assert.equal(table.find(entry => entry.name === 'EVOLVE_JEV_PROVIDER').class, 'B');
});

test('P2-19: the child cannot load a post-gate scientific override', () => {
  const poisoned = { EVOLVE_MARKET_MODE: 'synthetic', EVOLVE_SYNTHETIC_UNIVERSE: '12', EVOLVE_SEED: '1', R4_SEALED_RUNNER: 'yes', JUPITER_API_KEY: 'k', EVOLVE_JEV_PROVIDER: 'typesafe-jev', PATH: '/usr/bin' };
  const sanitized = sanitizeSealedChildEnvironment(poisoned);
  assert.equal(sanitized.EVOLVE_MARKET_MODE, 'live');
  assert.equal(sanitized.EVOLVE_SYNTHETIC_UNIVERSE, undefined);
  assert.equal(sanitized.EVOLVE_SEED, undefined);
  assert.equal(sanitized.R4_SEALED_RUNNER, undefined);
  assert.equal(sanitized.JUPITER_API_KEY, 'k');
  assert.equal(sanitized.EVOLVE_JEV_PROVIDER, 'typesafe-jev');
  assert.equal(sanitized.PATH, '/usr/bin');
  assertSealedChildEnvironment(sanitized);
  // A post-gate overlay is refused on the actual child environment.
  throwsCode(() => assertSealedChildEnvironment({ ...sanitized, EVOLVE_INTELLIGENCE_ALIGNMENT_MS: '1' }), 'R4_CAPTURE_ENV_DRIFT');
});

/* P3 — canonical composition (P3-5..P3-9) */

function tamperCopy(session, mutate) {
  const entry = [...session.snapshotsByDigest][0];
  const tampered = mutate(entry[1][0]);
  return { ...session, snapshotsByDigest: new Map([[entry[0], [{ ...entry[1][0], ...tampered }]]]) };
}

test('P3-20 (P3-5): caller-mutated exposure is rejected', () => {
  const fixture = attestedFixture();
  const references = buildCanonicalReferenceSet({ sessions: [fixture.session], canonicalMembership: [fixture.session.sessionId] }).references;
  const altered = tamperCopy(fixture.session, entry => ({ snapshot: { ...entry.snapshot, exposure: { ...entry.snapshot.exposure, value: 999 } } }));
  throwsCode(() => certifyExposureRows({ references, sessions: [altered] }), 'R4_EXPOSURE_SESSION_NOT_AUTHENTICATED');
  // Evidence objects are frozen: an in-place field overwrite cannot happen.
  const digestKey = references[0].snapshotDigest;
  assert.throws(() => { fixture.session.snapshotsByDigest.get(digestKey)[0].snapshot.exposure.value = 1; });
});

test('P3-21 (P3-5): caller-mutated mint is rejected', () => {
  const fixture = attestedFixture();
  const references = buildCanonicalReferenceSet({ sessions: [fixture.session], canonicalMembership: [fixture.session.sessionId] }).references;
  const altered = tamperCopy(fixture.session, entry => ({ snapshot: { ...entry.snapshot, mint: 'FakeMint1111111111111111111111111111111111' } }));
  throwsCode(() => certifyExposureRows({ references, sessions: [altered] }), 'R4_EXPOSURE_SESSION_NOT_AUTHENTICATED');
  // REAL path: the on-disk mint change invalidates the authenticated manifest.
  const poisoned = attestedFixture({ cwd: tempRoot(), sessionId: 'r4-mint-tamper' });
  writeFileSync(path.join(poisoned.session.dir, 'normalized.ndjson'), '{"mint":"FakeMint1111111111111111111111111111111111"}\n');
  throwsCode(() => certifyExposureRowsFromEvidence({ seal, authority, approvalAuthority, canonicalMembership: [poisoned.session.sessionId],
    references: buildCanonicalReferenceSet({ sessions: [poisoned.session], canonicalMembership: [poisoned.session.sessionId] }).references,
    attestations: [poisoned.attestation], sessionRoot: poisoned.sessionsRoot, cwd: poisoned.cwd }), 'SOURCE_FILE_HASH_MISMATCH');
});

test('P3-22 (P3-5): caller-mutated reference timestamp is rejected', () => {
  const fixture = attestedFixture();
  const references = buildCanonicalReferenceSet({ sessions: [fixture.session], canonicalMembership: [fixture.session.sessionId] }).references;
  const altered = tamperCopy(fixture.session, entry => ({ snapshot: { ...entry.snapshot, observedAt: entry.snapshot.observedAt + 1 } }));
  throwsCode(() => certifyExposureRows({ references, sessions: [altered] }), 'R4_EXPOSURE_SESSION_NOT_AUTHENTICATED');
  const { rows } = certifyExposureRows({ references, sessions: [fixture.session] });
  const evidence = fixture.session.snapshotsByDigest.get(references[0].snapshotDigest)[0];
  assert.equal(rows[0].referenceObservedAt, evidence.snapshot.observedAt);
});

// Round 3 (P1-3): the canonical orchestrator resolves A from Git itself, so these
// cases run over a real synthetic P -> S -> A repository with a live bare
// remote and an attempt completed through the real runner lifecycle.
let synthetic = null;
const completedSynthetic = () => {
  if (!synthetic) synthetic = completedAttemptFixture();
  return synthetic;
};

test('P3-23 (P3-6): canonical analysis without a verified outcome binding is rejected', () => {
  const { fixture } = completedSynthetic();
  throwsCode(() => runCanonicalR4Analysis({ repoRoot: fixture.dir }), 'R4_CANONICAL_ANALYSIS_OUTCOME_BINDING_REQUIRED');
});

test('P3-24 (P3-6): forged sourceSessionIds are rejected', () => {
  const fixture = attestedFixture();
  const { references } = buildCanonicalReferenceSet({ sessions: [fixture.session], canonicalMembership: [fixture.session.sessionId] });
  const binding = buildOutcomeRunBinding({ seal, authority, approvalAuthority, cohortMembership: [fixture.session.sessionId], references });
  const added = { ...binding, sourceSessionIds: [...binding.sourceSessionIds, 'added-session'] };
  throwsCode(() => verifyOutcomeRunBinding({ binding: refingerprintWith(added, digest), seal, authority, approvalAuthority, cohortMembership: [fixture.session.sessionId], references }), 'R4_BINDING_SESSION_IDS_MISMATCH');
  throwsCode(() => verifyOutcomeRunBinding({ binding, seal, authority, approvalAuthority, cohortMembership: ['other'], references }), 'R4_BINDING_COHORT_MISMATCH');
  const refingerprinted = refingerprintWith({ ...binding, cohortMembershipDigest: digest(['other']) }, digest);
  throwsCode(() => verifyOutcomeRunBinding({ binding: refingerprinted, seal, authority, approvalAuthority, cohortMembership: ['other'], references }), 'R4_BINDING_SESSION_NOT_IN_MEMBERSHIP');
  assert.equal(verifyOutcomeRunBinding({ binding, seal, authority, approvalAuthority, cohortMembership: [fixture.session.sessionId], references }).ok, true);
});

test('P3-25 (P3-6): canonical reference build with an unattested source is rejected', () => {
  const fixture = attestedFixture({ cwd: tempRoot(), sessionId: 'r4-unattested' });
  throwsCode(() => buildCanonicalReferenceSetFromEvidence({ seal, authority, approvalAuthority,
    canonicalMembership: [fixture.session.sessionId], attestations: [], sessionRoot: fixture.sessionsRoot, cwd: fixture.cwd }), 'R4_ATTESTATION_REQUIRED');
  throwsCode(() => buildCanonicalReferenceSet({ sessions: [fixture.session], canonicalMembership: [] }), 'R4_CANONICAL_MEMBERSHIP_REQUIRED');
  const { session } = fixture;
  throwsCode(() => buildCanonicalReferenceSet({ sessions: [{ ...session }], canonicalMembership: [session.sessionId] }), 'R4_REFERENCE_SOURCE_NOT_AUTHENTICATED');
  // A thinned canonical set is rejected against the built set.
  const full = buildCanonicalReferenceSet({ sessions: [session], canonicalMembership: [session.sessionId] });
  throwsCode(() => verifyCanonicalReferenceSet({ references: [full.references[0]], canonicalReferences: full.references }), 'R4_REFERENCE_SET_MISMATCH');
});

test('P3-26 (P3-7): a caller-authored plan.membership cannot affect canonical membership', () => {
  const fixture = attestedFixture();
  const forgedPlan = { ...fixture.plan, membership: ['forged-session'] };
  const { canonicalMembership } = deriveCanonicalCohortMembership({ plan: forgedPlan, attempts: fixture.attempts, seal, authority, attestations: [fixture.attestation], approvalAuthority });
  assert.deepEqual(canonicalMembership, [fixture.session.sessionId]);
  const progress = evaluateSealedCohortProgress({ plan: forgedPlan, attempts: fixture.attempts, seal, authority, attestations: [fixture.attestation], approvalAuthority });
  assert.deepEqual(progress.canonicalMembership, [fixture.session.sessionId]);
});

test('P3-27 (P3-8/P3-9): caller-supplied T0 cannot affect canonical T0', () => {
  const fixture = attestedFixture();
  throwsCode(() => evaluateSealedCohortProgress({ plan: { ...fixture.plan, t0: T0 + 3_600_000 }, attempts: fixture.attempts, seal, authority, attestations: [fixture.attestation], approvalAuthority }), 'R4_PLAN_T0_MISMATCH');
  // The canonical builder takes T0 ONLY from the verified approval authority.
  const plan = planSealedCohort({ seal, approvalAuthority });
  assert.equal(plan.t0, T0);
  assert.equal(plan.approvalCommit, APPROVAL_SHA);
});

test('P3-28: an unknown analysis option is rejected', () => {
  throwsCode(() => assertNoAnalysisOverrides({ unexplainedKnob: 1 }), 'R4_ANALYSIS_UNKNOWN_OPTION:unexplainedKnob');
  throwsCode(() => assertNoAnalysisOverrides({ replicates: 1 }), 'R4_ANALYSIS_OVERRIDE_FORBIDDEN:replicates');
});

test('canonical analysis orchestrator runs end to end over authenticated evidence and Git-resolved A', () => {
  const { fixture, result: run } = completedSynthetic();
  // The test derives the binding inputs itself; the orchestrator receives only
  // locations plus the binding/outcomes and resolves authority on its own.
  const resolved = resolveR4ExecutionAuthority({ cwd: fixture.dir, requireApproval: true });
  const session = readSourceSession({ dir: path.join(fixture.dir, '.evolve/market-intelligence/sessions', run.sessionId), role: 'cohort' });
  const { references } = buildCanonicalReferenceSet({ sessions: [session], canonicalMembership: [session.sessionId] });
  const binding = buildOutcomeRunBinding({ seal: resolved.seal, authority: resolved.authority, approvalAuthority: resolved, cohortMembership: [session.sessionId], references });
  const outcomes = references.map((reference, i) => ({ referenceSessionId: reference.sessionId, referenceSnapshotDigest: reference.snapshotDigest,
    status: 'resolved', absLogReturn300sBps: i + 1, mint: MINT, referenceObservedAt: T }));
  const result = runCanonicalR4Analysis({ repoRoot: fixture.dir, outcomeRunBinding: binding, outcomes });
  assert.equal(result.recordType, 'r4_canonical_analysis_result');
  assert.equal(result.analysis.sealFingerprint, fixture.seal.fingerprint);
  assert.deepEqual(result.identity.canonicalMembership, [session.sessionId]);
  assert.equal(result.identity.approvalCommit, fixture.approvalCommit);
  assert.equal(result.identity.liveRemoteMain, fixture.approvalCommit);
});

/* Approval commit A and the start window */

test('A-29: an approval commit whose parent is not S is rejected', () => {
  const chain = syntheticApprovalChain({ parentIsProtocol: true });
  const found = findApprovalCommit({ sealAuthorityCommit: chain.sealCommit, approval: chain.approval, cwd: chain.repo.dir });
  assert.equal(found.found, false);
  throwsCode(() => verifyApprovalGitContract({ sealAuthorityCommit: chain.sealCommit, approval: chain.approval, cwd: chain.repo.dir, requireRemote: false, requireHead: false }), 'R4_APPROVAL_APPROVAL_COMMIT_NOT_FOUND');
});

test('A-30: an approval commit that modifies source code is rejected', () => {
  const chain = syntheticApprovalChain({ modifySource: true });
  throwsCode(() => verifyApprovalGitContract({ sealAuthorityCommit: chain.sealCommit, approval: chain.approval, cwd: chain.repo.dir, requireRemote: false, requireHead: false }), 'R4_APPROVAL_GOVERNANCE_SCOPE_VIOLATION');
});

test('A-31: an approval with a non-READY verdict is rejected', () => {
  throwsCode(() => assertApprovalRecord({ ...buildApprovalRecord({ seal, authority, reviewer: 'r', reviewerModel: 'm', reviewVerdict: R4_APPROVAL_VERDICT, reviewReportDigest: 'd'.repeat(64) }), reviewVerdict: 'CHANGES_REQUIRED' }), 'R4_APPROVAL_VERDICT_INVALID');
});

test('A-32: an approval commit that is not the live remote main is rejected', () => {
  const chain = syntheticApprovalChain({ pushApproval: false });
  throwsCode(() => verifyApprovalGitContract({ sealAuthorityCommit: chain.sealCommit, approval: chain.approval, cwd: chain.repo.dir, requireRemote: true, requireHead: true }), 'R4_AUTHORITY_REMOTE_MAIN_MISMATCH:APPROVAL_COMMIT_A');
});

test('A-33: starting before T0 is refused', () => {
  throwsCode(() => assertAttemptStartAllowed({ attemptIndex: 1, t0: T0, now: T0 - 1 }), 'R4_COHORT_BEFORE_T0');
  assert.equal(evaluateAttemptStartWindow({ t0: T0, now: T0 - 1 }).state, R4_START_WINDOW.before);
});

test('A-34: the T0+5min boundary is refused', () => {
  assert.equal(evaluateAttemptStartWindow({ t0: T0, now: T0 + 299_999 }).state, R4_START_WINDOW.open);
  assert.equal(evaluateAttemptStartWindow({ t0: T0, now: T0 + 300_000 }).state, R4_START_WINDOW.expired);
  throwsCode(() => assertAttemptStartAllowed({ attemptIndex: 1, t0: T0, now: T0 + 300_000 }), 'R4_ATTEMPT1_START_WINDOW_MISSED');
  // No re-anchoring: a later check at the same T0 stays refused.
  throwsCode(() => assertAttemptStartAllowed({ attemptIndex: 1, t0: T0, now: T0 + 86_400_000 }), 'R4_ATTEMPT1_START_WINDOW_MISSED');
});

test('A-35: a valid start inside the window is accepted in a synthetic no-network fixture', () => {
  const chain = syntheticApprovalChain();
  const contract = verifyApprovalGitContract({ sealAuthorityCommit: chain.sealCommit, approval: chain.approval, cwd: chain.repo.dir, requireRemote: true, requireHead: true });
  assert.equal(contract.ok, true);
  assert.equal(contract.approvalCommit, chain.approvalCommit);
  // A's committer timestamp (10:10 UTC) -> T0 = 11:00 UTC.
  assert.equal(contract.approvalCommitterTimestamp, Date.UTC(2026, 8, 28, 10, 10, 0));
  const t0 = approvalT0(contract.approvalCommitterTimestamp);
  assert.equal(t0, Date.UTC(2026, 8, 28, 11, 0, 0));
  const at = t0 + 60_000;
  const window = assertAttemptStartAllowed({ attemptIndex: 1, t0, now: at });
  assert.equal(window.state, R4_START_WINDOW.open);
  assert.deepEqual(contract.changed, [R4_APPROVAL_PATH]);
});

/* ---------------------------------------------------------------- run */

let failed = 0;
let count = 0;
try {
  for (const [name, fn] of tests) {
    count++;
    try { await fn(); console.log(`PASS ${name}`); }
    catch (e) { failed++; console.error(`FAIL ${name}: ${String(e?.stack ?? e).split('\n').slice(0, 3).join(' | ')}`); }
  }
} finally {
  while (roots.length) { const root = roots.pop(); makeWritable(root); rmSync(root, { recursive: true, force: true }); }
  if (synthetic) removeTree(synthetic.fixture.root);
}
console.log('');
console.log(`R4 round-2 regression: ${count - failed}/${count} passed; synthetic temporary fixtures only`);
if (failed) process.exitCode = 1;
