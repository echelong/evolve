#!/usr/bin/env node
// R4 preregistration seal validator and critical tamper gate.
//
// Positive path: the live modules still produce the canonical frozen protocol, a
// freshly built scratch seal verifies internally, and — once the canonical
// TRACKED seal exists — it verifies against the external Git two-commit
// authority chain (protocol commit P, seal authority commit S).
// Tamper gate: every critical protocol boundary, the exact required bound-file
// set, the canonical specification and the Git authority chain, when altered,
// must be rejected. A surviving critical tamper is a freeze failure.
//
// The historical Git-ignored `.evolve/governance/r4-preregistration-seal-*.json`
// runtime artifact is retained unchanged and is NOT authority; it is
// deliberately rejected by the canonical schema, which is itself a proof that
// authority cannot depend on an ignored file.
//
// Read-only with respect to evidence: this validator only reads files and Git;
// it writes nothing and starts nothing.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, digest } from './market-intelligence/definition.mjs';
import { buildSeal, verifyR4Seal, readProtocol, gitIdentity, R4_EXPECTED, R4_BOUND_FILES, R4_PREREGISTRATION_PATH, R4_SEAL_DIR, R4_EXCLUSIONS, R4_TRACKED_SEAL_PATH } from './r4-preregistration-seal.mjs';
import { verifyR4SealAuthority, loadCanonicalTrackedSeal } from './r4-authority.mjs';
import { R4_SPEC, R4_SPEC_DIGEST, captureSpecDigest, R4_REQUIRED_BOUND_FILES } from './r4-protocol-spec.mjs';
import { runE1MutationSuite } from './validate-r4-e1-mutation.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = file => readFileSync(path.join(REPO, file));
const treeIsClean = cwd => spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).stdout.trim() === '';
const clone = value => JSON.parse(JSON.stringify(value));
const refingerprint = seal => { const content = { ...seal }; delete content.fingerprint; seal.fingerprint = digest(content); };

let failed = 0;
const failures = [];

function check(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failed++; failures.push(name); console.error(`FAIL ${name}: ${String(e?.message ?? e).split('\n')[0]}`); }
}

/* ------------------------------------------------------------- positive path */

check('live modules produce the canonical frozen protocol and specification', () => {
  assert.equal(canonical(readProtocol()), canonical(R4_EXPECTED));
  assert.equal(R4_SPEC_DIGEST, R4_EXPECTED.specDigest);
  assert.equal(captureSpecDigest(), R4_EXPECTED.captureSpecDigest);
});

check('a freshly built seal verifies internally and binds the current commit', () => {
  const identity = gitIdentity(REPO);
  const seal = buildSeal({ ...identity, sealedAt: 1800000000000 });
  const result = verifyR4Seal(seal, { load });
  assert.equal(result.ok, true);
  assert.equal(result.boundFileCount, R4_BOUND_FILES.length);
  assert.equal(seal.protocolCommit, identity.baseSha);
  assert.equal(seal.protocolTree, identity.baseTree);
  assert.equal(seal.artifactAuthority.canonicalSealPath, R4_TRACKED_SEAL_PATH);
  assert.equal(seal.protocol.b1, 'E1_REFERENCE_LEVEL_MISSINGNESS');
  assert.equal(seal.protocol.maturation, 'COHORT_DRAIN_ONLY');
  assert.equal(seal.authority.tradingAuthority, false);
  assert.equal(canonical(seal.spec), canonical(R4_SPEC));
});

check('the canonical tracked seal verifies against the external Git authority chain', () => {
  const trackedPath = path.resolve(REPO, R4_TRACKED_SEAL_PATH);
  if (!existsSync(trackedPath)) { console.log('      (canonical tracked seal not generated yet — pre-S dry run)'); return; }
  const { seal, authority } = loadCanonicalTrackedSeal({ cwd: REPO, requireSealCommit: true, requireHead: true, requireRemote: false });
  assert.equal(authority.protocolCommit, seal.protocolCommit);
  assert(typeof authority.sealAuthorityCommit === 'string' && /^[0-9a-f]{40}$/.test(authority.sealAuthorityCommit));
  assert(Number.isSafeInteger(authority.sealCommitterTimestamp));
  assert.equal(canonical(seal.protocol), canonical(R4_EXPECTED));
});

check('the historical .evolve seal is retained unchanged and is NOT canonical authority', () => {
  const historicalDir = path.resolve(REPO, R4_SEAL_DIR);
  assert(existsSync(historicalDir), 'the historical governance directory must exist');
  const files = readdirSync(historicalDir).filter(name => /^r4-preregistration-seal-.*\.json$/.test(name)).sort();
  if (!files.length) return;
  const historical = JSON.parse(readFileSync(path.join(historicalDir, files.at(-1)), 'utf8'));
  assert.equal(historical.recordType, 'r4_preregistration_seal');
  // It predates the enforcement schema and must never be promoted to authority.
  assert.throws(() => verifyR4Seal(historical), /R4_SEAL_PROTOCOL_DRIFT/);
  assert(R4_TrackedDiffersFrom(historical));
});

function R4_TrackedDiffersFrom(historical) {
  return historical.artifactAuthority === undefined || historical.artifactAuthority?.canonicalSealPath !== R4_TRACKED_SEAL_PATH;
}

/* --------------------------------------------------------------- tamper gate */

const baseSeal = buildSeal({ ...gitIdentity(REPO), sealedAt: 1800000000000 });

function tamper(name, mutate, expected, { refingerprintAfter = true, loadOverride = load } = {}) {
  const seal = clone(baseSeal);
  mutate(seal);
  if (refingerprintAfter) refingerprint(seal);
  assert.throws(() => verifyR4Seal(seal, { load: loadOverride }), error => String(error.message).startsWith(expected), `${name} must be rejected with ${expected}`);
  console.log(`PASS tamper ${name} -> ${expected}`);
}

const PROTOCOL_TAMPERS = [
  ['B1 session/ref boundary', s => { s.protocol.b1 = 'SESSION_LEVEL_CAPTURE_FAILURE'; }],
  ['session count 6', s => { s.protocol.d1.targetCompletedSessions = 8; }],
  ['max attempts 8', s => { s.protocol.d1.maxAttempts = 6; }],
  ['duration 45', s => { s.protocol.d1.durationMinutes = 30; }],
  ['capture mode', s => { s.protocol.d1.captureMode = 'passive'; }],
  ['provider configuration', s => { s.protocol.d1.providers.gmgn = 'ENABLED'; }],
  ['reference rule', s => { s.protocol.d2.referenceRule = 'DETERMINISTIC_TIME_THINNING'; }],
  ['estimand Kendall tau-b', s => { s.protocol.d3.estimand = 'spearman_rho'; }],
  ['exposure field', s => { s.protocol.d3.exposureField = 'crossSourceLiquidityRatio'; }],
  ['outcome field', s => { s.protocol.d3.outcomeField = 'logReturn300sBps'; }],
  ['bootstrap replicate count', s => { s.protocol.d3.bootstrapReplicates = 9999; }],
  ['cluster key', s => { s.protocol.d3.clusterKey = 'mint-hour'; }],
  ['seed derivation', s => { s.protocol.d3.seedDerivation = 'Math.random()'; }],
  ['sample floors', s => { s.protocol.d3.minResolvedReferences = 1; }],
  ['Policy A', s => { s.protocol.policyA = 'POLICY_B_OBSERVATION_IDENTITY'; }],
  ['Policy B status', s => { s.protocol.policyB.artifactMode = 'PERSISTED'; }],
  ['maturation mode', s => { s.protocol.maturation = 'SEPARATE_MATURATION_SESSION'; }],
  ['horizon', s => { s.protocol.frozenConstants.horizonMs = 1; }],
  ['tolerance', s => { s.protocol.frozenConstants.toleranceMs = 1; }],
  ['freshness', s => { s.protocol.frozenConstants.freshnessMs = 1; }],
  ['alignment', s => { s.protocol.frozenConstants.alignmentMs = 1; }],
];
for (const [name, mutate] of PROTOCOL_TAMPERS) tamper(name, mutate, 'R4_SEAL_PROTOCOL_DRIFT');

tamper('excluded-session list', s => { s.exclusions = []; }, 'R4_SEAL_EXCLUSIONS_DRIFT');
tamper('cohort plan spec', s => { s.cohortPlan.spec.targetCompletedSessions = 7; }, 'R4_SEAL_COHORT_SPEC_DRIFT');
tamper('cohort attempt indexes', s => { s.cohortPlan.attemptIndexes = [1, 2]; }, 'R4_SEAL_ATTEMPT_INDEX_DRIFT');
tamper('authority flags', s => { s.authority.tradingAuthority = true; }, 'R4_SEAL_AUTHORITY_INVALID');
tamper('seal digest', s => { s.fingerprint = '0'.repeat(64); }, 'R4_SEAL_FINGERPRINT_MISMATCH', { refingerprintAfter: false });
tamper('bound code identity record', s => { s.boundFiles['scripts/r4-cohort-plan.mjs'].sha256 = '0'.repeat(64); }, 'R4_SEAL_FILE_DIGEST_MISMATCH');
tamper('preregistration digest record', s => { s.preregistration.sha256 = '0'.repeat(64); }, 'R4_SEAL_PREREGISTRATION_DIGEST_MISMATCH');
tamper('bound file content', () => {}, 'R4_SEAL_FILE_DIGEST_MISMATCH', { refingerprintAfter: false,
  loadOverride: file => (file === 'scripts/r4-cohort-plan.mjs' ? Buffer.from('tampered') : load(file)) });
tamper('removed bound file from disk', () => {}, 'R4_SEAL_FILE_MISSING', { refingerprintAfter: false,
  loadOverride: file => (file === 'scripts/r4-cohort-plan.mjs' ? null : load(file)) });
tamper('preregistration path', s => { s.preregistration.path = 'docs/other.md'; }, 'R4_SEAL_PREREGISTRATION_PATH_INVALID');
tamper('preregistration excluded from the bound file set', s => { delete s.boundFiles[R4_PREREGISTRATION_PATH]; }, 'R4_SEAL_BOUND_FILE_SET_DRIFT');
tamper('omitted required analysis file', s => { delete s.boundFiles['scripts/market-outcomes/primary-analysis.mjs']; }, 'R4_SEAL_BOUND_FILE_SET_DRIFT');
tamper('added unrequired bound file', s => { s.boundFiles['scripts/not-required.mjs'] = { sha256: '0'.repeat(64) }; }, 'R4_SEAL_BOUND_FILE_SET_DRIFT');
tamper('canonical spec record', s => { s.spec = { ...s.spec, cohort: { ...s.spec.cohort, targetCompletedSessions: 8 } }; }, 'R4_SEAL_SPEC_DRIFT');
tamper('canonical spec digest', s => { s.specDigest = '0'.repeat(64); }, 'R4_SEAL_SPEC_DIGEST_DRIFT');
tamper('capture spec digest', s => { s.captureSpecDigest = '0'.repeat(64); }, 'R4_SEAL_CAPTURE_SPEC_DIGEST_DRIFT');
tamper('capture environment classification', s => { s.captureEnvironment = []; }, 'R4_SEAL_CAPTURE_ENV_DRIFT');
tamper('canonical seal path', s => { s.artifactAuthority.canonicalSealPath = '.evolve/governance/r4.json'; }, 'R4_SEAL_ARTIFACT_AUTHORITY_INVALID');
tamper('protocol commit identity', s => { s.protocolCommit = 'not-a-sha'; }, 'R4_SEAL_PROTOCOL_COMMIT_INVALID');
tamper('git identity drift', s => { s.git = { ...s.git, protocolTree: 'b'.repeat(40) }; }, 'R4_SEAL_GIT_IDENTITY_DRIFT');
tamper('seal status', s => { s.status = 'DRAFT'; }, 'R4_SEAL_STATUS_INVALID');
tamper('seal record type', s => { s.recordType = 'other_seal'; }, 'R4_SEAL_INVALID');

/* ------------------------------------------- external authority tamper gate */

function authorityTamper(name, mutate, expected) {
  const seal = clone(baseSeal);
  mutate(seal);
  refingerprint(seal);
  assert.throws(() => verifyR4SealAuthority(seal, { cwd: REPO, requireSealCommit: false, requireHead: false }),
    error => String(error.message).startsWith(expected), `${name} must be rejected with ${expected}`);
  console.log(`PASS authority tamper ${name} -> ${expected}`);
}
authorityTamper('changed protocol SHA', s => { s.protocolCommit = 'b'.repeat(40); }, 'R4_AUTHORITY_PROTOCOL_COMMIT_MISSING');
authorityTamper('changed protocol tree', s => { s.protocolTree = 'b'.repeat(40); }, 'R4_AUTHORITY_PROTOCOL_TREE_MISMATCH');
authorityTamper('changed bound file digest record', s => { s.boundFiles['scripts/r4-cohort-plan.mjs'].sha256 = '0'.repeat(64); }, 'R4_AUTHORITY_BOUND_FILE_MISMATCH');
check('authority contract accepts the unaltered scratch seal when the tree matches HEAD', () => {
  // A dirty working tree legitimately differs from the protocol commit, so the
  // acceptance path is only exercised once the tree is clean (i.e. after P).
  if (!treeIsClean(REPO)) return;
  const result = verifyR4SealAuthority(baseSeal, { cwd: REPO, requireSealCommit: false, requireHead: false });
  assert.equal(result.ok, true);
  assert.equal(result.protocolCommit, baseSeal.protocolCommit);
});

/* ------------------------------- failed-vs-pending and reference boundary ---- */

let e1Summary = null;
try { e1Summary = await runE1MutationSuite({ log: () => {} }); }
catch (e) { failed++; failures.push('E1 mutation suite'); console.error(`FAIL E1 mutation suite: ${e.message}`); }
check('failed-vs-pending semantics survive no critical E1 mutation', () => {
  assert(e1Summary, 'the E1 mutation suite must run');
  assert.equal(e1Summary.criticalSurvivors.length, 0, `survivors: ${e1Summary.criticalSurvivors.join(', ')}`);
  assert.equal(e1Summary.criticalKilled, e1Summary.criticalTotal);
  assert.equal(e1Summary.controlsSurviving, e1Summary.controlsTotal);
  console.log(`      E1 mutation: ${e1Summary.criticalKilled}/${e1Summary.criticalTotal} critical killed, ${e1Summary.controlsSurviving}/${e1Summary.controlsTotal} controls surviving`);
});

check('frozen exclusion set is the five methods-only sessions', () => {
  assert.equal(R4_EXCLUSIONS.length, 5);
  assert.equal(new Set(R4_EXCLUSIONS).size, 5);
});

check('the required bound-file set is defined by the canonical spec, not the seal', () => {
  assert.equal(R4_BOUND_FILES.length, R4_REQUIRED_BOUND_FILES.length);
  assert.equal(canonical([...R4_BOUND_FILES].sort()), canonical([...R4_REQUIRED_BOUND_FILES].sort()));
});

console.log('');
console.log(`R4 preregistration seal: ${failures.length ? failures.length : 0} failure(s); tamper gate ran on a freshly built scratch seal`);
if (failed) process.exitCode = 1;
