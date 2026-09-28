#!/usr/bin/env node
// R4 preregistration seal validator and critical tamper gate.
//
// Positive path: the live modules still produce the canonical frozen protocol,
// a freshly built seal verifies, and any on-disk seal verifies too.
// Tamper gate: every critical protocol boundary, when altered, must be
// rejected. A surviving critical tamper is a freeze failure.
//
// Read-only with respect to evidence: this validator only reads files and the
// newest seal artifact; it writes nothing and starts nothing.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, digest } from './market-intelligence/definition.mjs';
import { buildSeal, verifyR4Seal, readProtocol, gitIdentity, R4_EXPECTED, R4_BOUND_FILES, R4_PREREGISTRATION_PATH, R4_SEAL_DIR, R4_EXCLUSIONS } from './r4-preregistration-seal.mjs';
import { runE1MutationSuite } from './validate-r4-e1-mutation.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = file => readFileSync(path.join(REPO, file));
const clone = value => JSON.parse(JSON.stringify(value));
const refingerprint = seal => { const content = { ...seal }; delete content.fingerprint; seal.fingerprint = digest(content); };

let failed = 0;
const failures = [];

function check(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failed++; failures.push(name); console.error(`FAIL ${name}: ${String(e?.message ?? e).split('\n')[0]}`); }
}

/* ------------------------------------------------------------- positive path */

check('live modules produce the canonical frozen protocol', () => {
  assert.equal(canonical(readProtocol()), canonical(R4_EXPECTED));
});

check('a freshly built seal verifies', () => {
  const seal = buildSeal({ ...gitIdentity(REPO), sealedAt: 1800000000000 });
  const result = verifyR4Seal(seal, load);
  assert.equal(result.ok, true);
  assert.equal(result.boundFileCount, R4_BOUND_FILES.length);
  assert.equal(seal.protocol.b1, 'E1_REFERENCE_LEVEL_MISSINGNESS');
  assert.equal(seal.protocol.maturation, 'COHORT_DRAIN_ONLY');
  assert.equal(seal.authority.tradingAuthority, false);
});

check('the newest on-disk seal verifies and matches the frozen protocol', () => {
  const dir = path.resolve(REPO, R4_SEAL_DIR);
  assert(existsSync(dir), 'the governance directory must exist');
  const files = readdirSync(dir).filter(name => /^r4-preregistration-seal-.*\.json$/.test(name)).sort();
  if (!files.length) return; // pre-commit dry run: the seal artifact is written after the sealed commit
  const seal = JSON.parse(readFileSync(path.join(dir, files.at(-1)), 'utf8'));
  assert.equal(verifyR4Seal(seal, load).ok, true);
  assert.equal(canonical(seal.protocol), canonical(R4_EXPECTED));
});

/* --------------------------------------------------------------- tamper gate */

const baseSeal = buildSeal({ ...gitIdentity(REPO), sealedAt: 1800000000000 });

function tamper(name, mutate, expected, { refingerprintAfter = true, loadOverride = load } = {}) {
  const seal = clone(baseSeal);
  mutate(seal);
  if (refingerprintAfter) refingerprint(seal);
  assert.throws(() => verifyR4Seal(seal, loadOverride), error => String(error.message).startsWith(expected), `${name} must be rejected with ${expected}`);
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
tamper('removed bound file', () => {}, 'R4_SEAL_FILE_MISSING', { refingerprintAfter: false,
  loadOverride: file => (file === 'scripts/r4-cohort-plan.mjs' ? null : load(file)) });
tamper('preregistration path', s => { s.preregistration.path = 'docs/other.md'; }, 'R4_SEAL_PREREGISTRATION_PATH_INVALID');
tamper('preregistration excluded from the bound file set', s => { delete s.boundFiles[R4_PREREGISTRATION_PATH]; }, 'R4_SEAL_PREREGISTRATION_DIGEST_MISMATCH');
tamper('seal status', s => { s.status = 'DRAFT'; }, 'R4_SEAL_STATUS_INVALID');
tamper('seal record type', s => { s.recordType = 'other_seal'; }, 'R4_SEAL_INVALID');

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

console.log('');
console.log(`R4 preregistration seal: ${failures.length ? failures.length : 0} failure(s); tamper gate ran on a freshly built seal`);
if (failed) process.exitCode = 1;
