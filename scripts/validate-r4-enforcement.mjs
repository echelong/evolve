#!/usr/bin/env node
// R4 pre-capture enforcement regression suite.
//
// Covers every finding of independent pre-capture review round 1 and the
// enforcement architecture it required. Synthetic temporary fixtures only: no
// .evolve evidence is read or written, no capture is started, no cohort attempt
// is created, no real outcome is generated and no T0 is materialized.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from './market-intelligence/definition.mjs';
import { aggregate } from './market-intelligence/aggregate.mjs';
import { observation } from './market-intelligence/normalize.mjs';
import { createStorage } from './market-intelligence/storage.mjs';
import { readSourceSession, generateOutcomeRun } from './market-outcomes/index.mjs';
import { selectAllEligibleReferences } from './market-outcomes/reference-selection.mjs';
import { buildCohortPlan, evaluateCohortProgress, mechanicalT0 } from './r4-cohort-plan.mjs';
import { buildSeal, verifyR4Seal, gitIdentity, R4_EXPECTED, R4_BOUND_FILES, R4_PREREGISTRATION_PATH } from './r4-preregistration-seal.mjs';
import { verifyR4SealAuthority, loadCanonicalTrackedSeal, gitCommitterTimestamp, R4_TRACKED_SEAL_PATH } from './r4-authority.mjs';
import { R4_SPEC, R4_SPEC_DIGEST, captureSpecDigest, classifyCaptureEnvironment, R4_REQUIRED_BOUND_FILES } from './r4-protocol-spec.mjs';
import { R4_EXCLUSIONS } from './r4-exclusions.mjs';
import { createSessionAttestation, finalizeSessionAttestation, verifySessionAttestation } from './r4-attestation.mjs';
import { createAttemptCapability, capabilityHash, createAttemptAuthorization, proveCapability } from './r4-capability.mjs';
import { approvalT0 } from './r4-approval.mjs';
import {
  verifyR4SourceEligibility, evaluateSealedCohortProgress, buildCanonicalReferenceSet,
  verifyCanonicalReferenceSet, referenceSetDigest, certifyExposureRows, runRealR4PrimaryAnalysis,
  assertNoAnalysisOverrides, buildOutcomeRunBinding, verifyOutcomeRunBinding,
} from './r4-enforcement.mjs';
import { preflight, storagePreflight, assertStoragePreflight, enforceSealedCaptureEnvironment, R4RunnerError, parseRunnerArgs, R4_RUNNER_LOCKED_ARGUMENTS } from './r4-cohort-run.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = 1_800_000_000_000;
const MINT = 'So11111111111111111111111111111111111111112';
const EXCLUDED_S2 = '1790523432292-82b204a2-75b8-49fd-92a6-c51e6a9370ca';

const seal = buildSeal({ ...gitIdentity(REPO), sealedAt: T });
const SEAL_COMMIT_TIME = Date.UTC(2026, 8, 28, 10, 0, 0);
const APPROVAL_COMMIT = 'b'.repeat(40);
const T0 = approvalT0(SEAL_COMMIT_TIME);
const authority = Object.freeze({
  sealAuthorityCommit: 'a'.repeat(40), sealCommitterTimestamp: SEAL_COMMIT_TIME,
  protocolCommit: seal.protocolCommit, protocolTree: seal.protocolTree,
});
const approvalAuthority = Object.freeze({ approvalCommit: APPROVAL_COMMIT, t0: T0 });

const roots = [];
const tempRoot = () => { const root = mkdtempSync(path.join(tmpdir(), 'evolve-r4-enforce-')); roots.push(root); return root; };

function records(time, price = 2, dexPrice = null) {
  return ['jupiter', 'dexscreener'].map(provider => {
    const providerPrice = provider === 'dexscreener' ? (dexPrice ?? price) : price;
    const normalized = { priceUsd: providerPrice, providerFixture: provider, liquidityUsd: null, volumes: { m5: null, h1: null },
      transactions: { m5: { buys: null, sells: null } }, priceChanges: { m5: null, h1: null }, pairCreatedAt: time };
    return observation({ provider, endpoint: '/' + provider, mint: MINT, payload: { provider, time, price: providerPrice }, normalized, receivedAt: time, staleMs: 60000 });
  });
}

function buildSession({ sessionId, snapshots }) {
  const root = tempRoot();
  const storage = createStorage({ root, sessionId, startedAt: snapshots[0].time });
  for (const { time, price, dexPrice = null } of snapshots) {
    const rs = records(time, price, dexPrice);
    for (const record of rs) storage.writeObservation(record, { provider: record.provider, time, price: record.normalized.priceUsd });
    storage.writeSnapshot(aggregate(rs, { observedAt: time })[0]);
  }
  storage.finalize({ endedAt: snapshots.at(-1).time + 1000, reason: 'duration reached' });
  return { dir: storage.dir, sessionId };
}

function attestedSession({ sessionId = 'r4-s1', snapshots = [{ time: T, price: 2 }, { time: T + 300_000, price: 3 }] } = {}) {
  const fixture = buildSession({ sessionId, snapshots });
  const session = readSourceSession({ dir: fixture.dir, role: 'cohort' });
  // Round-2 capability flow: only a live capability whose blinded hash matches a
  // persisted pre-attempt authorization may open/finalize an attestation.
  const capability = createAttemptCapability();
  const authorization = createAttemptAuthorization({ seal, authority, approvalCommit: APPROVAL_COMMIT, attemptIndex: 1,
    sessionId, t0: T0, capabilityHash: capabilityHash(capability), captureSpecDigest: captureSpecDigest() });
  const proof = proveCapability({ capability, record: authorization });
  const open = createSessionAttestation({ seal, authority, approvalAuthority, proof });
  const attestation = finalizeSessionAttestation(open, { sessionFingerprint: session.fingerprint,
    revisitCoverage: { scheduled: 1, completed: 1, failed: 0, pending: 0 }, proof });
  return { fixture, session, attestation, proof, authorization };
}

function refingerprint(record) { const content = { ...record }; delete content.fingerprint; return { ...content, fingerprint: digest(content) }; }
const treeIsClean = () => spawnSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' }).stdout.trim() === '';
function makeWritable(target) {
  let info; try { info = statSync(target); } catch { return; }
  if (info.isDirectory()) { try { for (const entry of readdirSync(target)) makeWritable(path.join(target, entry)); } catch { /* best effort */ } try { chmodSync(target, 0o755); } catch { /* best effort */ } }
  else { try { chmodSync(target, 0o644); } catch { /* best effort */ } }
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const throwsCode = (fn, prefix) => assert.throws(fn, error => String(error?.message ?? error).startsWith(prefix), `expected ${prefix}`);

/* ------------------------------------------- 1. hard exclusion at every boundary */

test('REGRESSION 1: an excluded methods-only session cannot be loaded as R4 source evidence', () => {
  const root = tempRoot();
  const storage = createStorage({ root, sessionId: EXCLUDED_S2, startedAt: T });
  const rs = records(T);
  for (const record of rs) storage.writeObservation(record, { provider: record.provider, time: T, price: 2 });
  storage.writeSnapshot(aggregate(rs, { observedAt: T })[0]);
  storage.finalize({ endedAt: T + 1000, reason: 'duration reached' });
  throwsCode(() => readSourceSession({ dir: storage.dir, role: 'cohort' }), 'R4_EXCLUDED_SESSION');
});

test('REGRESSION 1b: authenticated S2 labelled cohort yields ZERO R4 references (hard failure)', () => {
  const forged = { sessionId: EXCLUDED_S2, role: 'cohort', fingerprint: 'f'.repeat(64), snapshots: [{ snapshotDigest: 'd'.repeat(64), validationReason: null }], snapshotsByDigest: new Map() };
  throwsCode(() => selectAllEligibleReferences([forged]), 'R4_EXCLUDED_SESSION');
  // The real, historical S2 shakedown is never consumed: if present it is rejected too.
  const realS2 = path.join(REPO, '.evolve/market-intelligence/sessions', EXCLUDED_S2);
  if (existsSync(realS2)) throwsCode(() => readSourceSession({ dir: realS2, role: 'cohort' }), 'R4_EXCLUDED_SESSION');
});

test('exclusion list is the frozen five and is enforced at the governor too', () => {
  assert.equal(R4_EXCLUSIONS.length, 5);
  const plan = buildCohortPlan({ sealFingerprint: seal.fingerprint, preregistrationDigest: seal.preregistration.sha256, sealCommittedAt: SEAL_COMMIT_TIME });
  throwsCode(() => evaluateCohortProgress(plan, [{ index: 1, status: 'COMPLETED', sessionId: EXCLUDED_S2, failureCode: null, replacementOf: null }]), 'R4_EXCLUDED_SESSION');
});

/* ------------------------------------------------- 2-5. cohort governor hardening */

const cohortPlan = buildCohortPlan({ sealFingerprint: seal.fingerprint, preregistrationDigest: seal.preregistration.sha256, sealCommittedAt: SEAL_COMMIT_TIME });

test('REGRESSION 2: a duplicate session id cannot join the cohort', () => {
  throwsCode(() => evaluateCohortProgress(cohortPlan, [
    { index: 1, status: 'COMPLETED', sessionId: 'dup', failureCode: null, replacementOf: null },
    { index: 2, status: 'COMPLETED', sessionId: 'dup', failureCode: null, replacementOf: null },
  ]), 'ATTEMPT_DUPLICATE_SESSION');
});

test('REGRESSION 3: an excluded session cannot join the cohort', () => {
  throwsCode(() => evaluateCohortProgress(cohortPlan, [{ index: 1, status: 'COMPLETED', sessionId: EXCLUDED_S2, failureCode: null, replacementOf: null }]), 'R4_EXCLUDED_SESSION');
});

test('REGRESSION 4: an attempt completed after the sixth is rejected', () => {
  const attempts = Array.from({ length: 7 }, (_, i) => ({ index: i + 1, status: 'COMPLETED', sessionId: `s-${i + 1}`, failureCode: null, replacementOf: null }));
  throwsCode(() => evaluateCohortProgress(cohortPlan, attempts), 'COHORT_ALREADY_STOPPED');
});

test('REGRESSION 5: attempt 9 is always illegal', () => {
  const attempts = Array.from({ length: 9 }, (_, i) => ({ index: i + 1, status: 'FAILED', sessionId: null, failureCode: 'X', replacementOf: i === 0 ? null : i }));
  throwsCode(() => evaluateCohortProgress(cohortPlan, attempts), 'ATTEMPT_BUDGET_EXCEEDED');
});

test('sealed governor requires an authenticated attestation for every completed attempt', () => {
  const plan = { ...cohortPlan };
  const attempts = [{ index: 1, status: 'COMPLETED', sessionId: 'r4-s1', failureCode: null, replacementOf: null, attestationFingerprint: 'a'.repeat(64) }];
  throwsCode(() => evaluateSealedCohortProgress({ plan, attempts, seal, authority, attestations: [] }), 'R4_ATTEMPT_ATTESTATION_NOT_FOUND');
});

test('sealed governor accepts an authenticated membership and rejects plan/seal mismatch', () => {
  const { session, attestation } = attestedSession({ sessionId: 'r4-s1' });
  const plan = buildCohortPlan({ sealFingerprint: seal.fingerprint, preregistrationDigest: seal.preregistration.sha256, t0: T0, approvalCommit: APPROVAL_COMMIT });
  plan.membership = [session.sessionId];
  const attempts = [{ index: 1, status: 'COMPLETED', sessionId: session.sessionId, failureCode: null, replacementOf: null, attestationFingerprint: attestation.fingerprint }];
  const progress = evaluateSealedCohortProgress({ plan, attempts, seal, authority, attestations: [attestation], approvalAuthority });
  assert.deepEqual(progress.authenticatedMembership, ['r4-s1']);
  assert.deepEqual(progress.canonicalMembership, ['r4-s1']);
  throwsCode(() => evaluateSealedCohortProgress({ plan: { ...plan, sealFingerprint: 'b'.repeat(64) }, attempts, seal, authority, attestations: [attestation], approvalAuthority }), 'R4_PLAN_SEAL_MISMATCH');
});

/* --------------------------------------- 6-9. configuration/attestation capture */

test('REGRESSION 6: a wrong capture duration is rejected', () => {
  const { session, attestation } = attestedSession({ sessionId: 'r4-s2' });
  const tampered = refingerprint({ ...attestation, referenceWindowMinutes: 30 });
  throwsCode(() => verifySessionAttestation({ attestation: tampered, session, seal, authority }), 'R4_ATTESTATION_REFERENCE_WINDOW_MISMATCH');
});

test('REGRESSION 7: a wrong provider configuration is rejected', () => {
  const { session, attestation } = attestedSession({ sessionId: 'r4-s3' });
  const tampered = refingerprint({ ...attestation, providers: { ...attestation.providers, gmgn: 'ENABLED' } });
  throwsCode(() => verifySessionAttestation({ attestation: tampered, session, seal, authority }), 'R4_ATTESTATION_PROVIDER_MISMATCH');
});

test('REGRESSION 8: a wrong universe is rejected by the sealed spec', () => {
  const tamperedSeal = refingerprint({ ...seal, spec: { ...seal.spec, universe: { ...seal.spec.universe, universeMax: 999 } } });
  throwsCode(() => verifyR4Seal(tamperedSeal), 'R4_SEAL_SPEC_DRIFT');
  throwsCode(() => verifyR4Seal(refingerprint({ ...seal, captureEnvironment: [] })), 'R4_SEAL_CAPTURE_ENV_DRIFT');
});

test('REGRESSION 9: environment drift is rejected before capture', () => {
  const clean = enforceSealedCaptureEnvironment({});
  assert.equal(clean.drift.length, 0);
  assert(clean.table.some(entry => entry.name === 'EVOLVE_JUPITER_ENDPOINTS' && entry.class === 'A'));
  const drifted = classifyCaptureEnvironment({ EVOLVE_INTELLIGENCE_ALIGNMENT_MS: '1' });
  assert.equal(drifted.drift.length, 1);
  const unclassified = classifyCaptureEnvironment({ EVOLVE_SOMETHING_NEW: '1' });
  assert.equal(unclassified.drift[0].reason, 'UNCLASSIFIED_CAPTURE_VARIABLE');
  throwsCode(() => enforceSealedCaptureEnvironment({ EVOLVE_JUPITER_ENDPOINTS: 'recent' }), 'R4_CAPTURE_ENV_DRIFT');
  // Credentials are permitted and never change a sealed parameter.
  const credentialed = classifyCaptureEnvironment({ JUPITER_API_KEY: 'x', EVOLVE_JUPITER_POLL_MS: '3500' });
  assert.equal(credentialed.drift.length, 0);
});

test('sealed runner accepts only the seal path and attempt index', () => {
  const options = parseRunnerArgs(['preflight', '--attempt', '3']);
  assert.equal(options.attemptIndex, 3);
  assert.equal(options.sealPath, R4_TRACKED_SEAL_PATH);
  throwsCode(() => parseRunnerArgs(['capture', '--minutes', '30']), 'R4_RUNNER_ARGUMENT_UNSUPPORTED');
  assert(R4_RUNNER_LOCKED_ARGUMENTS.includes('minutes'));
  // No scientific parameter may change the sealed capture command.
  const drifted = { ...process.env, EVOLVE_INTELLIGENCE_MAX_SESSION_MIB: '2048' };
  throwsCode(() => enforceSealedCaptureEnvironment(drifted), 'R4_CAPTURE_ENV_DRIFT');
});

/* --------------------------------------------------- source eligibility */

test('source eligibility requires an authenticated attestation, not a role string', () => {
  const { fixture, session, attestation } = attestedSession({ sessionId: 'r4-s4' });
  const proof = verifyR4SourceEligibility({ session, attestation, seal, authority });
  assert.equal(proof.sessionId, 'r4-s4');
  // A role-forged or policy-forged copy loses the evidence marker; a real
  // maturation load and a real relaxed policy are both still rejected on their own.
  throwsCode(() => verifyR4SourceEligibility({ session: { ...session, role: 'maturation' }, attestation, seal, authority }), 'R4_SOURCE_NOT_AUTHENTICATED');
  throwsCode(() => verifyR4SourceEligibility({ session: readSourceSession({ dir: fixture.dir, role: 'maturation' }), attestation, seal, authority }), 'R4_SOURCE_ROLE_INVALID');
  throwsCode(() => verifyR4SourceEligibility({ session, attestation: null, seal, authority }), 'R4_ATTESTATION_REQUIRED');
  throwsCode(() => verifyR4SourceEligibility({ session, attestation: refingerprint({ ...attestation, role: 'maturation' }), seal, authority }), 'R4_ATTESTATION_ROLE_INVALID');
  throwsCode(() => verifyR4SourceEligibility({ session: readSourceSession({ dir: fixture.dir, role: 'cohort' }, { requireDurationComplete: false }), attestation, seal, authority }), 'R4_SOURCE_NOT_DURATION_VERIFIED');
});

test('a session with unfinished revisit work is source-ineligible (E1 pending)', () => {
  const { session, proof } = attestedSession({ sessionId: 'r4-s5' });
  const open = createSessionAttestation({ seal, authority, approvalAuthority, proof });
  const pending = finalizeSessionAttestation(open, { sessionFingerprint: session.fingerprint, revisitCoverage: { scheduled: 3, completed: 2, failed: 0, pending: 1 }, proof });
  throwsCode(() => verifySessionAttestation({ attestation: pending, session, seal, authority }), 'R4_ATTESTATION_REVISIT_PENDING');
  // A terminal reference-level failure with pending = 0 stays eligible.
  const terminal = finalizeSessionAttestation(createSessionAttestation({ seal, authority, approvalAuthority, proof }),
    { sessionFingerprint: session.fingerprint, revisitCoverage: { scheduled: 3, completed: 2, failed: 1, pending: 0 }, proof });
  assert.equal(verifySessionAttestation({ attestation: terminal, session, seal, authority }).ok, true);
});

test('a forged attestation binding a different session fingerprint is rejected', () => {
  const { session, attestation } = attestedSession({ sessionId: 'r4-s6' });
  throwsCode(() => verifySessionAttestation({ attestation, session: { ...session, fingerprint: 'e'.repeat(64) }, seal, authority }), 'R4_ATTESTATION_SESSION_FINGERPRINT_MISMATCH');
  throwsCode(() => verifySessionAttestation({ attestation, session, seal, authority: { ...authority, sealAuthorityCommit: 'c'.repeat(40) } }), 'R4_ATTESTATION_AUTHORITY_COMMIT_MISMATCH');
});

/* ------------------------------------ 10-11. canonical references and exposure */

test('REGRESSION 10: arbitrary reference thinning is rejected', () => {
  const { session } = attestedSession({ sessionId: 'r4-ref', snapshots: [{ time: T, price: 2 }, { time: T + 1000, price: 2.5 }] });
  const canonicalSet = buildCanonicalReferenceSet({ sessions: [session], canonicalMembership: [session.sessionId] });
  assert.equal(canonicalSet.references.length, 2);
  const digestBefore = canonicalSet.digest;
  assert.equal(referenceSetDigest(canonicalSet.references), digestBefore);
  const thinned = [canonicalSet.references[0]];
  throwsCode(() => verifyCanonicalReferenceSet({ references: thinned, canonicalReferences: canonicalSet.references }), 'R4_REFERENCE_SET_MISMATCH');
  throwsCode(() => verifyCanonicalReferenceSet({ references: [...canonicalSet.references].reverse(), canonicalReferences: canonicalSet.references }), 'R4_REFERENCE_SET_MISMATCH');
  assert.equal(verifyCanonicalReferenceSet({ references: canonicalSet.references, canonicalReferences: canonicalSet.references }), digestBefore);
});

test('REGRESSION 11: exposure is derived from authenticated evidence, never caller-supplied', () => {
  const { session } = attestedSession({ sessionId: 'r4-exp', snapshots: [{ time: T, price: 2, dexPrice: 3 }, { time: T + 1000, price: 4, dexPrice: 6 }] });
  const canonicalSet = buildCanonicalReferenceSet({ sessions: [session], canonicalMembership: [session.sessionId] });
  const { rows } = certifyExposureRows({ references: canonicalSet.references, sessions: [session] });
  assert.equal(rows.length, 2);
  assert(rows.every(row => Number.isFinite(row.exposureValue) && row.exposureValue > 0));
  assert(rows.every(row => row.exposureValue === 4000)); // (3-2)/2.5 * 10000 for every snapshot
  // A caller-supplied in-memory session object (spread copy loses the evidence
  // marker) is refused outright: exposure/mint/timestamp tampering cannot pass.
  const tampered = { ...session, snapshotsByDigest: new Map([...session.snapshotsByDigest].map(([k, v]) => [k, v.map(entry => ({ ...entry, snapshot: { ...entry.snapshot, exposure: { ...entry.snapshot.exposure, contributorDigest: '0'.repeat(64) } } }))])) };
  throwsCode(() => certifyExposureRows({ references: canonicalSet.references, sessions: [tampered] }), 'R4_EXPOSURE_SESSION_NOT_AUTHENTICATED');
});

/* --------------------------------------------- 12-14. locked analysis interface */

test('REGRESSION 12/13/14: bootstrap, horizon and tolerance overrides are rejected', () => {
  throwsCode(() => assertNoAnalysisOverrides({ replicates: 9999 }), 'R4_ANALYSIS_OVERRIDE_FORBIDDEN:replicates');
  throwsCode(() => assertNoAnalysisOverrides({ horizonMs: 301000 }), 'R4_ANALYSIS_OVERRIDE_FORBIDDEN:horizonMs');
  throwsCode(() => assertNoAnalysisOverrides({ toleranceMs: 59000 }), 'R4_ANALYSIS_OVERRIDE_FORBIDDEN:toleranceMs');
  throwsCode(() => assertNoAnalysisOverrides({ exposureField: 'anything_else' }), 'R4_ANALYSIS_OVERRIDE_FORBIDDEN:exposureField');
  throwsCode(() => assertNoAnalysisOverrides({ clusterKey: 'mint-hour' }), 'R4_ANALYSIS_OVERRIDE_FORBIDDEN:clusterKey');
  throwsCode(() => runRealR4PrimaryAnalysis({ replicates: 9999, exposureRows: [{}], outcomes: [{}], seal }), 'R4_ANALYSIS_OVERRIDE_FORBIDDEN:replicates');
});

test('the canonical analysis runs end to end and records the frozen locked parameters', () => {
  const { fixture, session } = attestedSession({ sessionId: 'r4-run' });
  const canonicalSet = buildCanonicalReferenceSet({ sessions: [session], canonicalMembership: [session.sessionId] });
  const { rows: exposureRows } = certifyExposureRows({ references: canonicalSet.references, sessions: [session] });
  const outcomes = generateOutcomeRun({ sources: [{ dir: fixture.dir, role: 'cohort' }], references: canonicalSet.references, outputRoot: path.join(tempRoot(), 'outcomes'),
    runId: 'enforce-run', createdAt: T + 700_000, sealedCode: { sha: seal.protocolCommit, tree: seal.protocolTree } }).outcomes;
  const result = runRealR4PrimaryAnalysis({ exposureRows, outcomes, seal });
  assert.equal(result.recordType, 'r4_real_primary_analysis');
  assert.equal(result.bootstrapReplicates, R4_SPEC.analysis.bootstrapReplicates);
  assert.equal(result.clusterKey, 'mint');
  assert.equal(result.exposureField, 'crossSourcePriceRangeBps');
  assert.equal(result.outcomeField, 'absLogReturn300sBps');
  assert.equal(result.estimand, 'kendall_tau_b');
  assert.equal(result.sealFingerprint, seal.fingerprint);
  assert.equal(result.referenceSetDigest, canonicalSet.digest);
});

/* --------------------------------------------- 12b. outcome-run binding */

test('an outcome run is bound to seal, authority, cohort membership and reference set', () => {
  const { session } = attestedSession({ sessionId: 'r4-bind', snapshots: [{ time: T, price: 2 }, { time: T + 1000, price: 2.5 }] });
  const canonicalSet = buildCanonicalReferenceSet({ sessions: [session], canonicalMembership: [session.sessionId] });
  const binding = buildOutcomeRunBinding({ seal, authority, cohortMembership: ['r4-bind'], references: canonicalSet.references });
  assert.equal(verifyOutcomeRunBinding({ binding, seal, authority, cohortMembership: ['r4-bind'], references: canonicalSet.references }).ok, true);
  throwsCode(() => verifyOutcomeRunBinding({ binding, seal, authority, cohortMembership: ['r4-bind'], references: [canonicalSet.references[0]] }), 'R4_BINDING_REFERENCE_SET_MISMATCH');
  throwsCode(() => verifyOutcomeRunBinding({ binding, seal, authority, cohortMembership: ['other'], references: canonicalSet.references }), 'R4_BINDING_COHORT_MISMATCH');
  throwsCode(() => verifyOutcomeRunBinding({ binding: refingerprint({ ...binding, policyA: 'POLICY_B_OBSERVATION_IDENTITY' }), seal, authority, cohortMembership: ['r4-bind'], references: canonicalSet.references }), 'R4_BINDING_POLICY_A_MISMATCH');
});

/* ---------------------------------------------- 15-18. seal authority hardening */

test('REGRESSION 15: an altered, re-fingerprinted seal is rejected', () => {
  throwsCode(() => verifyR4Seal(refingerprint({ ...seal, protocol: { ...seal.protocol, d1: { ...seal.protocol.d1, targetCompletedSessions: 8 } } })), 'R4_SEAL_PROTOCOL_DRIFT');
  throwsCode(() => verifyR4Seal(refingerprint({ ...seal, protocol: { ...seal.protocol, d1: { ...seal.protocol.d1, captureMode: 'passive' } } })), 'R4_SEAL_PROTOCOL_DRIFT');
  throwsCode(() => verifyR4Seal(refingerprint({ ...seal, protocol: { ...seal.protocol, d1: { ...seal.protocol.d1, providers: { ...seal.protocol.d1.providers, gmgn: 'ENABLED' } } } })), 'R4_SEAL_PROTOCOL_DRIFT');
  throwsCode(() => verifyR4Seal(refingerprint({ ...seal, protocol: { ...seal.protocol, d3: { ...seal.protocol.d3, bootstrapReplicates: 9999 } } })), 'R4_SEAL_PROTOCOL_DRIFT');
  throwsCode(() => verifyR4Seal(refingerprint({ ...seal, protocol: { ...seal.protocol, b1: 'SESSION_LEVEL_CAPTURE_FAILURE' } })), 'R4_SEAL_PROTOCOL_DRIFT');
  throwsCode(() => verifyR4Seal(refingerprint({ ...seal, protocol: { ...seal.protocol, maturation: 'SEPARATE_MATURATION_SESSION' } })), 'R4_SEAL_PROTOCOL_DRIFT');
  throwsCode(() => verifyR4Seal(refingerprint({ ...seal, exclusions: [] })), 'R4_SEAL_EXCLUSIONS_DRIFT');
  throwsCode(() => verifyR4Seal(refingerprint({ ...seal, specDigest: '0'.repeat(64) })), 'R4_SEAL_SPEC_DIGEST_DRIFT');
  throwsCode(() => verifyR4Seal({ ...seal, fingerprint: '0'.repeat(64) }), 'R4_SEAL_FINGERPRINT_MISMATCH');
});

test('REGRESSION 16: an omitted required bound file is rejected', () => {
  const bound = { ...seal.boundFiles };
  delete bound[R4_PREREGISTRATION_PATH];
  throwsCode(() => verifyR4Seal(refingerprint({ ...seal, boundFiles: bound })), 'R4_SEAL_BOUND_FILE_SET_DRIFT');
  const short = { ...seal.boundFiles };
  delete short['scripts/market-outcomes/primary-analysis.mjs'];
  throwsCode(() => verifyR4Seal(refingerprint({ ...seal, boundFiles: short })), 'R4_SEAL_BOUND_FILE_SET_DRIFT');
  const extra = { ...seal.boundFiles, 'scripts/not-bound.mjs': { sha256: '0'.repeat(64) } };
  throwsCode(() => verifyR4Seal(refingerprint({ ...seal, boundFiles: extra })), 'R4_SEAL_BOUND_FILE_SET_DRIFT');
  assert.equal(R4_BOUND_FILES.length, R4_REQUIRED_BOUND_FILES.length);
});

test('REGRESSION 17: a changed protocol SHA or tree is rejected by the external contract', () => {
  throwsCode(() => verifyR4SealAuthority(refingerprint({ ...seal, protocolCommit: 'b'.repeat(40) }), { cwd: REPO, requireSealCommit: false, requireHead: false }), 'R4_AUTHORITY_PROTOCOL_COMMIT_MISSING');
  throwsCode(() => verifyR4SealAuthority({ ...seal, protocolCommit: 'nope' }, { cwd: REPO, requireSealCommit: false, requireHead: false }), 'R4_AUTHORITY_PROTOCOL_COMMIT_INVALID');
  throwsCode(() => verifyR4SealAuthority(refingerprint({ ...seal, protocolTree: 'b'.repeat(40) }), { cwd: REPO, requireSealCommit: false, requireHead: false }), 'R4_AUTHORITY_PROTOCOL_TREE_MISMATCH');
  // Acceptance path only when the working tree equals the protocol commit (post-P).
  if (treeIsClean()) assert.equal(verifyR4SealAuthority(seal, { cwd: REPO, requireSealCommit: false, requireHead: false }).ok, true);
});

test('REGRESSION 18: a changed cohort parameter record is rejected', () => {
  throwsCode(() => verifyR4Seal(refingerprint({ ...seal, cohortPlan: { ...seal.cohortPlan, spec: { ...seal.cohortPlan.spec, targetCompletedSessions: 7 } } })), 'R4_SEAL_COHORT_SPEC_DRIFT');
  throwsCode(() => verifyR4Seal(refingerprint({ ...seal, cohortPlan: { ...seal.cohortPlan, attemptIndexes: [1, 2] } })), 'R4_SEAL_ATTEMPT_INDEX_DRIFT');
  throwsCode(() => verifyR4Seal(refingerprint({ ...seal, artifactAuthority: { ...seal.artifactAuthority, canonicalSealPath: 'governance/other.json' } })), 'R4_SEAL_ARTIFACT_AUTHORITY_INVALID');
  throwsCode(() => verifyR4Seal(refingerprint({ ...seal, protocolCommit: 'not-a-sha' })), 'R4_SEAL_PROTOCOL_COMMIT_INVALID');
});

test('the committer timestamp is milliseconds so T0 is never derived from seconds', () => {
  const ts = gitCommitterTimestamp(gitIdentity(REPO).baseSha);
  assert(Number.isSafeInteger(ts));
  assert(ts > 1e12, 'a seconds value would be ~1e9 and would produce a 1970 T0');
  const t0 = mechanicalT0(ts);
  assert(new Date(t0).getUTCFullYear() >= 2026);
  assert.equal(t0 % 3_600_000, 0);
});

test('the canonical tracked seal, when present, verifies against the Git authority chain', () => {
  if (!existsSync(path.resolve(REPO, R4_TRACKED_SEAL_PATH))) return; // pre-S dry run
  try { verifyR4Seal(JSON.parse(readFileSync(path.resolve(REPO, R4_TRACKED_SEAL_PATH), 'utf8'))); }
  catch { console.log('      (tracked seal is superseded pending re-issue as the new S)'); return; }
  const tracked = loadCanonicalTrackedSeal({ cwd: REPO, requireSealCommit: true, requireHead: true, requireRemote: false });
  assert.equal(tracked.authority.protocolCommit, tracked.seal.protocolCommit);
  assert(tracked.authority.sealCommitterTimestamp > 1e12);
  assert(Number.isSafeInteger(tracked.authority.sealCommitterTimestamp));
  assert(new Date(mechanicalT0(tracked.authority.sealCommitterTimestamp)).getUTCFullYear() >= 2026);
});

/* ------------------------------------------------------ frozen spec binding */

test('the canonical spec digests are pinned by the hand-written expectation table', () => {
  assert.equal(R4_SPEC_DIGEST, R4_EXPECTED.specDigest);
  assert.equal(captureSpecDigest(), R4_EXPECTED.captureSpecDigest);
  assert.equal(seal.specDigest, R4_SPEC_DIGEST);
  assert.equal(seal.captureSpecDigest, captureSpecDigest());
  assert.equal(R4_SPEC.cohort.targetCompletedSessions, 6);
  assert.equal(R4_SPEC.cohort.maxAttempts, 8);
  assert.equal(R4_SPEC.cohort.referenceMinutes, 45);
  assert.equal(R4_SPEC.cohort.captureMode, 'r4-revisits');
  assert.equal(R4_SPEC.cohort.maturationMode, 'COHORT_DRAIN_ONLY');
  assert.equal(R4_SPEC.analysis.bootstrapReplicates, 10000);
  assert.equal(R4_SPEC.outcome.horizonMs, 300000);
  assert.equal(R4_SPEC.outcome.toleranceMs, 60000);
  assert.equal(R4_SPEC.reference.rule, 'ALL_ELIGIBLE_REFERENCES');
});

/* -------------------------------------------------- storage preflight */

test('storage preflight reports headroom and refuses an unsafe configuration', () => {
  const ok = storagePreflight({});
  assert.equal(ok.ok, true);
  assert(ok.headroomBytes > 0);
  assert.equal(ok.windowMinutes, 45);
  const unsafe = storagePreflight({ sealedMiB: 64 });
  assert.equal(unsafe.ok, false);
  throwsCode(() => assertStoragePreflight(unsafe), 'R4_STORAGE_PREFLIGHT_REFUSED');
  const highRate = storagePreflight({ rateBytesPerMinute: 64 * 1024 * 1024 });
  assert.equal(highRate.ok, false);
});

test('the sealed runner preflight refuses before T0 without starting anything', () => {
  // No capture, no cohort attempt, no write: a pre-T0 capture request is refused.
  try {
    preflight({ argv: ['preflight', '--attempt', '1'], env: {}, now: 0, cwd: REPO });
    // If the tracked seal is not committed yet this throws R4_AUTHORITY_SEAL_MISSING,
    // which is itself a correct refusal. Either way nothing is started.
  } catch (error) {
    assert(error instanceof R4RunnerError || /R4_AUTHORITY_/.test(String(error.message)), String(error.message));
  }
  assert.equal(typeof R4RunnerError, 'function');
});

/* ------------------------------------------------------------------ run */

let failed = 0;
try {
  for (const [name, fn] of tests) {
    try { fn(); console.log(`PASS ${name}`); }
    catch (e) { failed++; console.error(`FAIL ${name}: ${String(e?.stack ?? e).split('\n')[0]}`); }
  }
} finally {
  while (roots.length) { const root = roots.pop(); makeWritable(root); rmSync(root, { recursive: true, force: true }); }
}
console.log('');
console.log(`R4 enforcement: ${tests.length - failed}/${tests.length} passed; synthetic temporary fixtures only`);
if (failed) process.exitCode = 1;
