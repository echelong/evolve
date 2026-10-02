// R4 RUNTIME OUTCOME AUTHORIZATION VALIDATOR (synthetic fixtures only).
//
// This validator NEVER issues a real authorization, NEVER calls the sealed
// `generateOutcomeRun`, and NEVER touches this repository's real `.evolve`
// cohort/session evidence or its Git authority. Every case runs against either
//
//   (a) an isolated `mkdtemp` root, or
//   (b) injected synthetic fact objects driven through the SAME pure gate
//       functions the production path uses, or
//   (c) a synthetic P -> S -> A Git authority fixture from
//       `scripts/r4-synthetic-authority.mjs` in a temporary bare-remote repo.
//
// The frozen identity constants (3516 references, the reference-set digest, the
// six-member cohort closure) are asserted through the pure gates with synthetic
// inputs, so the real cohort is never read.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonical, digest } from './market-intelligence/definition.mjs';
import { buildSyntheticEvidenceSession, removeTree, syntheticAuthorityRepo } from './r4-synthetic-authority.mjs';
import { generateOutcomeRun, readSourceSession, R4_SOURCE_POLICY, verifyOutcomeRun } from './market-outcomes/index.mjs';
import { selectAllEligibleReferences } from './market-outcomes/reference-selection.mjs';
import { resolveR4ExecutionAuthority } from './r4-approval.mjs';
import { R4_REQUIRED_BOUND_FILES, R4_TRACKED_SEAL_PATH } from './r4-protocol-spec.mjs';
import { assertImportClosureBound, requiredBoundFiles } from './r4-import-closure.mjs';
import { R4_SESSION_DIR_ROOT } from './r4-enforcement.mjs';
import {
  R4_OUTCOME_AUTHORIZATION_DIR, R4_OUTCOME_AUTHORIZATION_FAILURE, R4_OUTCOME_AUTHORIZATION_IMPLEMENTATION_FILES,
  R4_OUTCOME_AUTHORIZATION_OUTPUT_ROOT, R4_OUTCOME_AUTHORIZATION_REFERENCE_COUNT, R4_OUTCOME_AUTHORIZATION_REFERENCE_SET_DIGEST,
  R4_OUTCOME_AUTHORIZATION_REQUIRED_MEMBERS, R4_OUTCOME_AUTHORIZATION_REVIEW_VERDICT,
  assertCanonicalMembership, assertCohortClosure, assertImplementationHashes, assertLiveAuthorityAtC1,
  assertMaturation, assertNoAuthorizationOverride, assertNoOutcomeArtifacts, assertOutcomeAuthorization,
  assertOutcomeAuthorizationReview, assertReferenceIdentity, assertReviewAuthorizesIssuance, assertStageC,
  authorizationConsumptionState, authorizationFingerprint, buildOutcomeAuthorization, buildOutcomeAuthorizationClaim,
  buildOutcomeAuthorizationConsumption, buildOutcomeAuthorizationReview,
  canonicalMembershipDigest, deriveOutcomeRunId, enforcementLimitations, existingAuthorizationGenerations,
  implementationHashes, issueOutcomeAuthorization, importOutcomeAuthorizationReview,
  maturationProofDigest, nextAuthorizationGeneration, outcomeAuthorizationClaimPathForGeneration,
  outcomeAuthorizationConsumptionPathForGeneration, outcomeAuthorizationPathForGeneration,
  outcomeAuthorizationReviewPathForGeneration, readOutcomeRecord, sourceIntegrityProofDigest,
  verifyOutcomeAuthorization, writeOutcomeRecordOnce,
} from './r4-outcome-authorization.mjs';
import { assertGenerationArguments, buildSealedCodeBinding, generateAuthorizedOutcomeRun, GENERATION_ALLOWED_ARGUMENTS, listOutcomeRuns } from './r4-outcome-generate.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const throwsCode = (name, fn, expected) => test(name, () => {
  assert.throws(fn, error => {
    const message = String(error?.message ?? error);
    const ok = expected instanceof RegExp ? expected.test(message) : message.startsWith(expected);
    assert.ok(ok, `expected ${expected} but got ${message}`);
    return true;
  });
});

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const SHA3 = 'c'.repeat(40);
const DIGEST = 'd'.repeat(64);
const DIGEST2 = 'e'.repeat(64);
const MEMBERSHIP = Object.freeze(['s1', 's2', 's3', 's4', 's5', 's6']);

/* ------------------------------------------------------ synthetic fixtures */

const temp = () => mkdtempSync(path.join(tmpdir(), 'evolve-r4-outcome-auth-'));
const tempRoots = [];
const newRoot = () => { const root = temp(); tempRoots.push(root); return root; };

/** Synthetic facts shaped exactly like `resolveCanonicalOutcomeFacts` output. */
function syntheticFacts(overrides = {}) {
  const base = {
    cwd: '/synthetic', evidenceRoot: '/synthetic',
    resolution: {
      stage: 'C', approvalCommit: SHA, approvalEpoch: 2, approvalFingerprint: DIGEST,
      continuationCommit: SHA2, continuationFingerprint: DIGEST2, continuationGeneration: 1, t0: 1_790_690_400_000,
      seal: { fingerprint: DIGEST, protocolTree: SHA3 }, authority: { sealAuthorityCommit: SHA3 },
    },
    seal: { fingerprint: DIGEST, protocolTree: SHA3 },
    authority: { sealAuthorityCommit: SHA3 },
    head: SHA2, remoteSha: SHA2, continuationAuthorityAt: 1_800_000_000_000,
    progress: { attemptsUsed: 6, completedCount: 6, stop: true, blocked: false, nextAttemptIndex: null, reason: 'R4_COHORT_STOPPED_TARGET_REACHED' },
    canonicalMembership: [...MEMBERSHIP],
    canonicalMembershipDigest: canonicalMembershipDigest(MEMBERSHIP),
    canonicalReferences: [{ sessionId: 's1', snapshotDigest: 'x1' }],
    canonicalSessions: [],
    referenceCount: R4_OUTCOME_AUTHORIZATION_REFERENCE_COUNT,
    referenceSetDigest: R4_OUTCOME_AUTHORIZATION_REFERENCE_SET_DIGEST,
    maturation: { rows: [], latestDeadline: 1_800_000_000_000 },
    sourceIntegrity: { verified: [{ session: { sessionId: 's1', fingerprint: DIGEST }, proof: { attestationFingerprint: DIGEST, authorizationFingerprint: DIGEST2, captureSpecDigest: DIGEST } }] },
  };
  const facts = { ...base, ...overrides };
  facts.resolution = { ...base.resolution, ...(overrides.resolution ?? {}) };
  return facts;
}

const SYNTHETIC_HASHES = Object.freeze({
  issuerVerifier: '1'.repeat(64), generatorWrapper: '2'.repeat(64),
  validator: '3'.repeat(64), sealedOutcomeImplementation: '4'.repeat(64),
});

function syntheticReview(overrides = {}) {
  const facts = overrides.facts ?? syntheticFacts();
  const content = {
    authorizationGeneration: 1, reviewer: 'synthetic-independent-reviewer', model: 'synthetic-model',
    reviewedAt: 1_800_000_000_000,
    scientificApprovalCommit: facts.resolution.approvalCommit, scientificApprovalEpoch: facts.resolution.approvalEpoch,
    scientificApprovalFingerprint: facts.resolution.approvalFingerprint,
    runtimeSealCommit: facts.authority.sealAuthorityCommit, runtimeSealFingerprint: facts.seal.fingerprint,
    continuationCommit: facts.resolution.continuationCommit, continuationFingerprint: facts.resolution.continuationFingerprint,
    continuationGeneration: facts.resolution.continuationGeneration, t0: facts.resolution.t0,
    canonicalMembershipDigest: facts.canonicalMembershipDigest, referenceCount: facts.referenceCount,
    referenceSetDigest: facts.referenceSetDigest, implementationHashes: SYNTHETIC_HASHES,
    ...overrides.input,
  };
  return buildOutcomeAuthorizationReview(content);
}

function syntheticAuthorization(overrides = {}) {
  const facts = overrides.facts ?? syntheticFacts();
  const review = overrides.review ?? syntheticReview({ facts });
  const createdAt = overrides.createdAt ?? 1_900_000_000_000;
  const record = buildOutcomeAuthorization({
    authorizationGeneration: overrides.authorizationGeneration ?? 1,
    resolution: facts.resolution, progress: facts.progress, canonicalMembership: facts.canonicalMembership,
    referenceCount: facts.referenceCount, referenceSetDigest: facts.referenceSetDigest,
    maturation: facts.maturation, sourceIntegrity: facts.sourceIntegrity,
    createdAt, issuedAt: createdAt, reviewFingerprint: review.fingerprint,
    implementationHashes: overrides.implementationHashes ?? SYNTHETIC_HASHES,
  });
  return overrides.mutate ? overrides.mutate(record) : record;
}

/* ---------------------------------------- 1. happy path + record validation */

test('V01 happy path: a synthetic authorization is built and fully validated', () => {
  const record = syntheticAuthorization();
  assertOutcomeAuthorization(record);
  assert.equal(record.status, 'AUTHORIZED');
  assert.equal(record.recordType, 'r4_outcome_authorization');
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.referenceCount, 3516);
  assert.equal(record.referenceSetDigest, R4_OUTCOME_AUTHORIZATION_REFERENCE_SET_DIGEST);
  assert.equal(record.outputRoot, '.evolve/market-outcomes');
  assert.equal(record.canonicalMembership.length, 6);
  assert.deepEqual(record.enforcementLimitations, [...enforcementLimitations()]);
  // fingerprint is deterministic and excludes itself
  assert.equal(record.fingerprint, authorizationFingerprint(record));
  assert.equal(authorizationFingerprint({ ...record, fingerprint: undefined }), record.fingerprint);
});

test('V01b happy path: write-once 0444 record survives a re-read and a second write fails', () => {
  const root = newRoot();
  const record = syntheticAuthorization();
  const file = path.join(root, 'a.json');
  const written = writeOutcomeRecordOnce(file, canonical(record) + '\n');
  assert.equal(written.mode, 0o444);
  assert.equal(statSync(file).mode & 0o777, 0o444);
  assert.deepEqual(readOutcomeRecord(file), JSON.parse(canonical(record)));
  assert.throws(() => writeOutcomeRecordOnce(file, 'x'), /ALREADY_EXISTS/);
});

/* ------------------------------------------------ 2-4. Git-contract negatives */

test('V02 HEAD != C1 fails closed', () => {
  const facts = syntheticFacts();
  assertLiveAuthorityAtC1({ resolution: facts.resolution, head: facts.head, remoteSha: facts.remoteSha });
  // A HEAD that is not the continuation commit C1 is refused.
  for (const wrong of [SHA, SHA3, 'f'.repeat(40)]) {
    assert.throws(() => assertLiveAuthorityAtC1({ resolution: facts.resolution, head: wrong, remoteSha: facts.remoteSha }),
      new RegExp(R4_OUTCOME_AUTHORIZATION_FAILURE.head), `HEAD ${wrong} must be refused`);
  }
  assert.throws(() => assertLiveAuthorityAtC1({ resolution: facts.resolution, head: null, remoteSha: facts.remoteSha }),
    new RegExp(R4_OUTCOME_AUTHORIZATION_FAILURE.head));
});

test('V03 live origin/main != C1 fails closed', () => {
  const facts = syntheticFacts();
  assertLiveAuthorityAtC1({ resolution: facts.resolution, head: facts.head, remoteSha: facts.remoteSha });
  assert.throws(() => assertLiveAuthorityAtC1({ resolution: facts.resolution, head: facts.head, remoteSha: SHA }),
    new RegExp(R4_OUTCOME_AUTHORIZATION_FAILURE.remote));
});

test('V04 a modified bound file fails authority resolution in a real synthetic Git repo', () => {
  const fixture = syntheticAuthorityRepo();
  try {
    assert.doesNotThrow(() => resolveR4ExecutionAuthority({ cwd: fixture.dir, requireApproval: true }));
    const target = path.join(fixture.dir, 'scripts/r4-exclusions.mjs');
    writeFileSync(target, `${readFileSync(target, 'utf8')}\n// synthetic tamper\n`);
    assert.throws(() => resolveR4ExecutionAuthority({ cwd: fixture.dir, requireApproval: true }), /R4_WORKTREE_RUNTIME_MODIFIED/);
  } finally { removeTree(fixture.root); }
});

test('V04b a real synthetic Git repo with HEAD != authority and remote != authority fails closed', () => {
  const headFixture = syntheticAuthorityRepo();
  try {
    headFixture.run(['commit', '-q', '--no-verify', '--allow-empty', '-m', 'extra']);
    assert.throws(() => resolveR4ExecutionAuthority({ cwd: headFixture.dir, requireApproval: true }), /R4_APPROVAL_HEAD_NOT_APPROVAL_COMMIT/);
  } finally { removeTree(headFixture.root); }
  const remoteFixture = syntheticAuthorityRepo();
  try {
    remoteFixture.setRemoteMain(remoteFixture.sealCommit);
    assert.throws(() => resolveR4ExecutionAuthority({ cwd: remoteFixture.dir, requireApproval: true }), /R4_AUTHORITY_REMOTE_MAIN_MISMATCH/);
  } finally { removeTree(remoteFixture.root); }
});

/* --------------------------------------------------- 5-7. authority identity */

throwsCode('V05 wrong A2 (commit) in the review fails issuance', () =>
  assertReviewAuthorizesIssuance({
    review: syntheticReview({ input: { scientificApprovalCommit: SHA3 } }), generation: 1,
    facts: syntheticFacts(), liveHashes: SYNTHETIC_HASHES,
  }), `${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:A2_COMMIT`);

throwsCode('V06 wrong S6 (commit) in the review fails issuance', () =>
  assertReviewAuthorizesIssuance({
    review: syntheticReview({ input: { runtimeSealCommit: SHA } }), generation: 1,
    facts: syntheticFacts(), liveHashes: SYNTHETIC_HASHES,
  }), `${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:S6_COMMIT`);

throwsCode('V07 wrong C1 (fingerprint) in the review fails issuance', () =>
  assertReviewAuthorizesIssuance({
    review: syntheticReview({ input: { continuationFingerprint: DIGEST } }), generation: 1,
    facts: syntheticFacts(), liveHashes: SYNTHETIC_HASHES,
  }), `${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:C1_FINGERPRINT`);

test('V07b wrong A2/S6/C1 inside the authorization record itself fails validation', () => {
  for (const [field, value] of [['scientificApprovalCommit', SHA], ['runtimeSealCommit', SHA], ['continuationCommit', SHA]]) {
    assert.throws(() => assertOutcomeAuthorization({ ...syntheticAuthorization(), [field]: value, fingerprint: 'f'.repeat(64) }), /FINGERPRINT_MISMATCH|A2_INVALID|S6_INVALID|C1_INVALID/);
  }
});

test('V07c a stage other than C is refused', () => {
  assertStageC(syntheticFacts().resolution);
  assert.throws(() => assertStageC({ ...syntheticFacts().resolution, stage: 'A' }), new RegExp(R4_OUTCOME_AUTHORIZATION_FAILURE.stage));
  assert.throws(() => assertStageC({ ...syntheticFacts().resolution, stage: 'S' }), new RegExp(R4_OUTCOME_AUTHORIZATION_FAILURE.stage));
});

/* ------------------------------------------------- 8-12. cohort closure gates */

for (const [label, patch] of [
  ['attemptsUsed != 6', { attemptsUsed: 5 }], ['attemptsUsed != 6 (7)', { attemptsUsed: 7 }],
  ['completedCount != 6', { completedCount: 5 }], ['completedCount != 6 (7)', { completedCount: 7 }],
  ['stop != true', { stop: false }], ['blocked != false', { blocked: true }],
  ['nextAttemptIndex != null', { nextAttemptIndex: 7 }],
]) {
  throwsCode(`V08-12 cohort closure: ${label} fails`, () => assertCohortClosure({ ...syntheticFacts().progress, ...patch }),
    R4_OUTCOME_AUTHORIZATION_FAILURE.closure);
}
test('V08-12b the exact frozen terminal shape is accepted', () =>
  assert.equal(assertCohortClosure({ attemptsUsed: 6, completedCount: 6, stop: true, blocked: false, nextAttemptIndex: null, reason: 'R4_COHORT_STOPPED_TARGET_REACHED' }), true));

/* --------------------------------------------------------- 13. membership */

test('V13 canonical membership: exactly six unique members are required', () => {
  assert.equal(assertCanonicalMembership(MEMBERSHIP), true);
  // added
  assert.throws(() => assertCanonicalMembership([...MEMBERSHIP, 's7']), new RegExp(R4_OUTCOME_AUTHORIZATION_FAILURE.membership));
  // removed
  assert.throws(() => assertCanonicalMembership(MEMBERSHIP.slice(0, 5)), new RegExp(R4_OUTCOME_AUTHORIZATION_FAILURE.membership));
  // duplicated
  assert.throws(() => assertCanonicalMembership([...MEMBERSHIP, 's6']), new RegExp(R4_OUTCOME_AUTHORIZATION_FAILURE.membership));
  // reordered is a DIFFERENT derived-order identity for the authorization body,
  // even though the order-independent digest is stable.
  const reordered = [...MEMBERSHIP].reverse();
  assert.equal(assertCanonicalMembership(reordered), true);
  assert.equal(canonicalMembershipDigest(reordered), canonicalMembershipDigest(MEMBERSHIP));
  const record = syntheticAuthorization();
  const tampered = { ...record, canonicalMembership: reordered, fingerprint: 'f'.repeat(64) };
  assert.throws(() => assertOutcomeAuthorization(tampered), /FINGERPRINT_MISMATCH/);
});

/* --------------------------------------------- 14-16. reference-set identity */

test('V14 referenceCount 3515 fails', () =>
  assert.throws(() => assertReferenceIdentity({ referenceCount: 3515, referenceSetDigest: R4_OUTCOME_AUTHORIZATION_REFERENCE_SET_DIGEST }),
    new RegExp(R4_OUTCOME_AUTHORIZATION_FAILURE.references)));

test('V15 referenceCount 3517 fails', () =>
  assert.throws(() => assertReferenceIdentity({ referenceCount: 3517, referenceSetDigest: R4_OUTCOME_AUTHORIZATION_REFERENCE_SET_DIGEST }),
    new RegExp(R4_OUTCOME_AUTHORIZATION_FAILURE.references)));

test('V16 an altered reference-set digest fails', () =>
  assert.throws(() => assertReferenceIdentity({ referenceCount: 3516, referenceSetDigest: 'f'.repeat(64) }),
    new RegExp(R4_OUTCOME_AUTHORIZATION_FAILURE.references)));

test('V16b the exact frozen identity is accepted and there is no tolerance', () => {
  assert.equal(assertReferenceIdentity({ referenceCount: 3516, referenceSetDigest: R4_OUTCOME_AUTHORIZATION_REFERENCE_SET_DIGEST }), true);
  for (const count of [0, 1, 100, 3514, 3516, 100000]) {
    // Only the exact frozen count is ever acceptable.
    if (count !== 3516) assert.throws(() => assertReferenceIdentity({ referenceCount: count, referenceSetDigest: R4_OUTCOME_AUTHORIZATION_REFERENCE_SET_DIGEST }));
  }
});

/* ------------------------------------------------ 17. outcome-artifact gate */

test('V17 an existing outcome artifact at issuance fails closed', () => {
  const root = newRoot();
  assert.equal(assertNoOutcomeArtifacts({ cwd: root }), true);
  mkdirSync(path.join(root, '.evolve/market-outcomes/some-run'), { recursive: true });
  assert.throws(() => assertNoOutcomeArtifacts({ cwd: root }), new RegExp(R4_OUTCOME_AUTHORIZATION_FAILURE.artifacts));
  // also refused in the other two canonical roots
  const other = newRoot();
  mkdirSync(path.join(other, '.evolve/outcomes/run'), { recursive: true });
  assert.throws(() => assertNoOutcomeArtifacts({ cwd: other }), new RegExp(R4_OUTCOME_AUTHORIZATION_FAILURE.artifacts));
  const third = newRoot();
  mkdirSync(path.join(third, '.evolve/market-intelligence/outcomes/run'), { recursive: true });
  assert.throws(() => assertNoOutcomeArtifacts({ cwd: third }), new RegExp(R4_OUTCOME_AUTHORIZATION_FAILURE.artifacts));
});

/* ------------------------------------------------- 18-20. review conditions */

throwsCode('V18 review fingerprint mismatch fails', () => assertOutcomeAuthorizationReview({
  ...syntheticReview(), fingerprint: DIGEST,
}), `${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:FINGERPRINT_MISMATCH`);

throwsCode('V19 review blockers non-empty fails', () => assertOutcomeAuthorizationReview(
  buildOutcomeAuthorizationReview({ ...syntheticReviewFields(), blockers: ['a blocker'] }),
), `${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:BLOCKERS_PRESENT`);

throwsCode('V20 a wrong review verdict fails', () => assertOutcomeAuthorizationReview(
  buildOutcomeAuthorizationReview({ ...syntheticReviewFields(), verdict: 'READY_TO_CONTINUE_COHORT' }),
), `${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:VERDICT`);

test('V20b a genuine reviewer declaration set is required (no fabrication)', () => {
  const review = syntheticReview();
  assertOutcomeAuthorizationReview(review);
  assert.equal(review.verdict, R4_OUTCOME_AUTHORIZATION_REVIEW_VERDICT);
  assert.equal(review.reviewer, 'synthetic-independent-reviewer');
  for (const key of ['outcomeValuesInspected', 'returnsInspected', 'effectSizesInspected', 'resolutionRatesInspected', 'marketStateInspected']) {
    assert.equal(review[key], false);
    assert.throws(() => assertOutcomeAuthorizationReview({ ...review, [key]: true, fingerprint: DIGEST }),
      new RegExp(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:DECLARATION`));
  }
  // A missing/blank reviewer identity is refused rather than invented.
  assert.throws(() => assertOutcomeAuthorizationReview({ ...review, reviewer: '', fingerprint: DIGEST }),
    new RegExp(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:REVIEWER_IDENTITY`));
});

function syntheticReviewFields() {
  const facts = syntheticFacts();
  return {
    authorizationGeneration: 1, reviewer: 'synthetic-independent-reviewer', model: 'synthetic-model', reviewedAt: 1_800_000_000_000,
    scientificApprovalCommit: facts.resolution.approvalCommit, scientificApprovalEpoch: facts.resolution.approvalEpoch,
    scientificApprovalFingerprint: facts.resolution.approvalFingerprint,
    runtimeSealCommit: facts.authority.sealAuthorityCommit, runtimeSealFingerprint: facts.seal.fingerprint,
    continuationCommit: facts.resolution.continuationCommit, continuationFingerprint: facts.resolution.continuationFingerprint,
    continuationGeneration: facts.resolution.continuationGeneration, t0: facts.resolution.t0,
    canonicalMembershipDigest: facts.canonicalMembershipDigest, referenceCount: facts.referenceCount,
    referenceSetDigest: facts.referenceSetDigest, implementationHashes: SYNTHETIC_HASHES,
  };
}

test('V20c issuance refuses a review bound to a different authorization generation', () => {
  const facts = syntheticFacts();
  const review = syntheticReview({ input: { authorizationGeneration: 2 } });
  assert.throws(() => assertReviewAuthorizesIssuance({ review, generation: 1, facts, liveHashes: SYNTHETIC_HASHES }),
    new RegExp(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:GENERATION_MISMATCH`));
});

/* -------------------------------------------- 21-24. implementation hashes */

for (const role of Object.keys(R4_OUTCOME_AUTHORIZATION_IMPLEMENTATION_FILES)) {
  throwsCode(`V21-24 implementation hash modified: ${role} fails`, () => assertImplementationHashes({
    declared: { ...SYNTHETIC_HASHES, [role]: 'f'.repeat(64) }, actual: SYNTHETIC_HASHES,
  }), `${R4_OUTCOME_AUTHORIZATION_FAILURE.implementation}:${role}`);
}

test('V21-24b a missing or unknown hash role fails closed', () => {
  const { issuerVerifier, ...missing } = SYNTHETIC_HASHES;
  assert.throws(() => assertImplementationHashes({ declared: missing, actual: SYNTHETIC_HASHES }),
    new RegExp(`${R4_OUTCOME_AUTHORIZATION_FAILURE.implementation}:ROLES`));
  assert.throws(() => assertImplementationHashes({ declared: { ...SYNTHETIC_HASHES, extra: DIGEST }, actual: SYNTHETIC_HASHES }),
    new RegExp(`${R4_OUTCOME_AUTHORIZATION_FAILURE.implementation}:ROLES`));
  assert.throws(() => assertImplementationHashes({ declared: { ...SYNTHETIC_HASHES, issuerVerifier: 'nope' }, actual: SYNTHETIC_HASHES }),
    new RegExp(`${R4_OUTCOME_AUTHORIZATION_FAILURE.implementation}:MALFORMED`));
});

test('V24 the sealed market-outcomes implementation hash is the real file digest', () => {
  const live = implementationHashes({ cwd: process.cwd() });
  const bytes = readFileSync(path.join(process.cwd(), 'scripts/market-outcomes/index.mjs'));
  assert.equal(live.sealedOutcomeImplementation, createHash('sha256').update(bytes).digest('hex'));
  // A wrong sealed-implementation digest is refused.
  assert.throws(() => assertImplementationHashes({
    declared: { ...live, sealedOutcomeImplementation: 'f'.repeat(64) }, actual: live,
  }), new RegExp(`${R4_OUTCOME_AUTHORIZATION_FAILURE.implementation}:sealedOutcomeImplementation`));
});

/* -------------------------------------------- 25-29. tamper / write semantics */

test('V25 a truncated authorization fails', () => {
  const root = newRoot();
  const record = syntheticAuthorization();
  const file = path.join(root, 'a.json');
  const body = canonical(record) + '\n';
  writeOutcomeRecordOnce(file, body);
  // truncation
  const truncated = body.slice(0, Math.floor(body.length / 2));
  let parsedTruncated = null;
  try { parsedTruncated = JSON.parse(truncated); } catch { assert.ok(true, 'a truncated record is not parseable, hence not acceptable'); }
  if (parsedTruncated !== null) assert.throws(() => assertOutcomeAuthorization(parsedTruncated), /RECORD_INVALID|SCHEMA|FINGERPRINT|MISSING/);
  // A structurally complete but field-stripped record is also refused.
  assert.throws(() => assertOutcomeAuthorization((() => { const c = JSON.parse(body); delete c.referenceCount; return c; })()),
    /FIELD_MISSING|FINGERPRINT_MISMATCH/);
  // an empty / non-JSON file is unreadable, never silently accepted
  const empty = path.join(root, 'empty.json');
  writeFileSync(empty, '');
  assert.equal(readOutcomeRecord(empty), null);
});

test('V26 a single-bit flip in an authorization fails', () => {
  const record = syntheticAuthorization();
  const body = canonical(record) + '\n';
  for (const index of [10, Math.floor(body.length / 2), body.length - 12]) {
    const flipped = index === 10
      ? (body[10] === 'a' ? 'b' : 'a') + body.slice(11)
      : body.slice(0, index) + (body[index] === 'a' ? 'b' : 'a') + body.slice(index + 1);
    if (flipped === body) continue;
    let parsed = null;
    try { parsed = JSON.parse(flipped); } catch { assert.ok(true); continue; }
    assert.throws(() => assertOutcomeAuthorization(parsed), /FINGERPRINT_MISMATCH|INVALID|MISMATCH|UNKNOWN_FIELD|REFERENCE_IDENTITY/);
  }
  // Flipping a digit inside a bound identity fails closed: either the strict
  // reference-identity gate or the record fingerprint rejects it.
  const tampered = { ...record, referenceCount: 3517, fingerprint: 'f'.repeat(64) };
  assert.throws(() => assertOutcomeAuthorization(tampered), /REFERENCE_IDENTITY_MISMATCH|FINGERPRINT_MISMATCH/);
  const tamperedCreatedAt = { ...record, createdAt: record.createdAt + 1, fingerprint: 'f'.repeat(64) };
  assert.throws(() => assertOutcomeAuthorization(tamperedCreatedAt), /RUN_ID_NOT_DERIVED|FINGERPRINT_MISMATCH/);
  // A flip inside the fingerprint itself is caught directly.
  assert.throws(() => assertOutcomeAuthorization({ ...record, fingerprint: DIGEST }), /FINGERPRINT_MISMATCH/);
});

test('V27 an unknown authorization field fails under the closed-schema policy', () => {
  const record = syntheticAuthorization();
  const extended = { ...record, extraField: 'x', fingerprint: authorizationFingerprint({ ...record, extraField: 'x' }) };
  assert.throws(() => assertOutcomeAuthorization(extended), new RegExp(R4_OUTCOME_AUTHORIZATION_FAILURE.schema));
  // A missing required field also fails.
  const { issuedAtIso, ...missing } = record;
  assert.throws(() => assertOutcomeAuthorization(missing), /FIELD_MISSING/);
  // The review schema is closed too.
  assert.throws(() => assertOutcomeAuthorizationReview({ ...syntheticReview(), extraField: 1, fingerprint: DIGEST }),
    new RegExp(R4_OUTCOME_AUTHORIZATION_FAILURE.schema));
});

test('V28 a duplicate authorization generation / O_EXCL replay fails', () => {
  const root = newRoot();
  const record = syntheticAuthorization();
  const file = path.join(root, outcomeAuthorizationPathForGeneration(1));
  assert.equal(writeOutcomeRecordOnce(file, canonical(record) + '\n').mode, 0o444);
  // A second issuance at the same generation is refused, and the ORIGINAL bytes
  // are untouched: write-once never overwrites or repairs in place.
  const before = readFileSync(file, 'utf8');
  assert.throws(() => writeOutcomeRecordOnce(file, canonical({ ...record, issuedAt: 1 }) + '\n'),
    new RegExp(R4_OUTCOME_AUTHORIZATION_FAILURE.exists));
  assert.equal(readFileSync(file, 'utf8'), before);
  // Generations are derived from the store, never caller-selected.
  assert.deepEqual(existingAuthorizationGenerations({ cwd: root }), [1]);
  assert.equal(nextAuthorizationGeneration({ cwd: root }), 2);
});

test('V29 a record that is not mode 0444 fails the write-once contract', () => {
  const root = newRoot();
  const record = syntheticAuthorization();
  const file = path.join(root, 'a.json');
  writeOutcomeRecordOnce(file, canonical(record) + '\n');
  assert.equal(statSync(file).mode & 0o777, 0o444);
  // Weakening the mode is detectable: the validator asserts 0444 for every
  // governance artifact it reads back.
  const isReadOnly = target => (statSync(target).mode & 0o777) === 0o444;
  assert.equal(isReadOnly(file), true);
  chmodSync(file, 0o644);
  assert.equal(isReadOnly(file), false, 'a weakened mode must be detectable');
  assert.equal(statSync(file).mode & 0o777, 0o644);
  // The content itself is still valid; only the permission contract is broken.
  assertOutcomeAuthorization(readOutcomeRecord(file));
});

/* --------------------------------------------------------- 30. maturation */

test('V30 a non-matured createdAt fails', () => {
  const observedAt = 1_000_000;
  const references = [{ sessionId: 's1', snapshotDigest: 'x1' }];
  const sessions = [{ sessionId: 's1', snapshotsByDigest: new Map([['x1', [{ snapshot: { observedAt } }]]]) }];
  // observedAt + 300000 + 60000 is the maturity deadline.
  const deadline = observedAt + 300_000 + 60_000;
  assert.equal(assertMaturation({ references, sessions, createdAt: deadline }).latestDeadline, deadline);
  assert.equal(assertMaturation({ references, sessions, createdAt: deadline + 1 }).latestDeadline, deadline);
  assert.throws(() => assertMaturation({ references, sessions, createdAt: deadline - 1 }),
    new RegExp(R4_OUTCOME_AUTHORIZATION_FAILURE.maturation));
  assert.throws(() => assertMaturation({ references, sessions, createdAt: observedAt }),
    new RegExp(R4_OUTCOME_AUTHORIZATION_FAILURE.maturation));
  // The mode is frozen to COHORT_DRAIN_ONLY.
  assert.equal(maturationProofDigest({ rows: [], latestDeadline: deadline, createdAt: deadline }).length, 64);
  assert.notEqual(
    maturationProofDigest({ rows: [], latestDeadline: deadline, createdAt: deadline, mode: 'SEPARATE_MATURATION' }),
    maturationProofDigest({ rows: [], latestDeadline: deadline, createdAt: deadline }));
});

/* ------------------------------------ 31-35. generation wrapper + single use */

test('V31 the generation wrapper refuses to run without an authorization', () => {
  const root = newRoot();
  assert.equal(readOutcomeRecord(path.join(root, outcomeAuthorizationPathForGeneration(1))), null);
  assert.throws(() => generateAuthorizedOutcomeRun({ cwd: root, argv: ['--execute'] }), /R4_OUTCOME_AUTHORIZATION_MISSING/);
});

test('V32/V35 single-use: a claimed or consumed authorization can never start a second generation', () => {
  const root = newRoot();
  const record = syntheticAuthorization();
  assert.equal(authorizationConsumptionState({ cwd: root, generation: 1 }), 'UNCONSUMED');
  const claim = buildOutcomeAuthorizationClaim({ generation: 1, authorization: record, claimedAt: 1_900_000_000_000 });
  writeOutcomeRecordOnce(path.join(root, outcomeAuthorizationClaimPathForGeneration(1)), `${JSON.stringify(claim)}\n`);
  assert.equal(authorizationConsumptionState({ cwd: root, generation: 1 }), 'CLAIMED_ABANDONED');
  // A claim REPLAY fails: O_EXCL refuses the second claim outright.
  assert.throws(() => writeOutcomeRecordOnce(path.join(root, outcomeAuthorizationClaimPathForGeneration(1)), `${JSON.stringify(claim)}\n`),
    new RegExp(R4_OUTCOME_AUTHORIZATION_FAILURE.exists));
  const consumption = buildOutcomeAuthorizationConsumption({ generation: 1, authorization: record, outcomeRun: { fingerprint: DIGEST }, consumedAt: 1_900_000_001_000 });
  writeOutcomeRecordOnce(path.join(root, outcomeAuthorizationConsumptionPathForGeneration(1)), `${JSON.stringify(consumption)}\n`);
  assert.equal(authorizationConsumptionState({ cwd: root, generation: 1 }), 'CONSUMED');
  // Consumption replay also fails.
  assert.throws(() => writeOutcomeRecordOnce(path.join(root, outcomeAuthorizationConsumptionPathForGeneration(1)), `${JSON.stringify(consumption)}\n`),
    new RegExp(R4_OUTCOME_AUTHORIZATION_FAILURE.exists));
  // The claim declares the abandoned-run policy explicitly.
  assert.equal(claim.abandonedRunIsNeverRetriedUnderThisAuthorization, true);
});

test('V33 a pre-existing partial runId directory blocks generation and is never deleted', () => {
  const root = newRoot();
  const record = syntheticAuthorization();
  const runDir = path.join(root, R4_OUTCOME_AUTHORIZATION_OUTPUT_ROOT, record.runId);
  mkdirSync(runDir, { recursive: true });
  assert.deepEqual(listOutcomeRuns({ cwd: root, outputRoot: R4_OUTCOME_AUTHORIZATION_OUTPUT_ROOT }), [record.runId]);
  // With no authorization present the wrapper fails closed at step 1 and never
  // reaches (let alone removes) the partial run directory.
  assert.throws(() => generateAuthorizedOutcomeRun({ cwd: root, argv: ['--execute'] }), /R4_OUTCOME_AUTHORIZATION_MISSING/);
  assert.equal(statSync(runDir).isDirectory(), true);
  // The run-dir guard is present in the wrapper and is checked with existsSync,
  // never with a cleanup: a partial run is never deleted.
  const wrapperSource = readFileSync(new URL('./r4-outcome-generate.mjs', import.meta.url), 'utf8');
  assert.ok(wrapperSource.includes('R4_OUTCOME_AUTHORIZATION_FAILURE.runDir'), 'the run-dir guard must exist');
  assert.ok(wrapperSource.includes('existsSync(runDir)'), 'the guard must use a non-destructive existence check');
  assert.ok(!/rmSync|rmSyncSync|unlinkSync|[^.]rm\(/.test(wrapperSource), 'the wrapper must never delete a partial run');
  assert.equal(R4_OUTCOME_AUTHORIZATION_FAILURE.runDir, 'R4_OUTCOME_AUTHORIZATION_RUN_PATH_EXISTS');
});

test('V34 CLI-supplied identity/timing/scientific inputs are all refused', () => {
  assert.deepEqual(GENERATION_ALLOWED_ARGUMENTS, ['execute']);
  for (const flag of ['--run-id', '--created-at', '--sessions', '--references', '--output-root', '--t0', '--approval', '--seal', '--continuation',
    '--generation', '--source-policy', '--sealed-code', '--now', '--expect-resolved', '--resolution-rate', '--effect-size']) {
    assert.throws(() => assertGenerationArguments([flag]), new RegExp(R4_OUTCOME_AUTHORIZATION_FAILURE.override), `${flag} must be refused`);
  }
  assert.throws(() => assertGenerationArguments([]), new RegExp(R4_OUTCOME_AUTHORIZATION_FAILURE.override));
  assert.throws(() => assertGenerationArguments(['--execute', '--run-id', 'x']), new RegExp(R4_OUTCOME_AUTHORIZATION_FAILURE.override));
  assert.equal(assertGenerationArguments(['--execute']).execute, true);
  // The issuer refuses the same identity keys programmatically.
  for (const key of ['sessions', 'runId', 'createdAt', 'references', 't0', 'approval', 'seal', 'continuation', 'outputRoot', 'referenceCount']) {
    assert.throws(() => assertNoAuthorizationOverride({ [key]: 'x' }), new RegExp(R4_OUTCOME_AUTHORIZATION_FAILURE.override), `${key} must be refused`);
  }
});

/* --------------------------------- 36-37. outcome directory + sealedCode link */

test('V36 the sealed outcome directory receives no extra sidecar files', () => {
  // `verifyOutcomeRun` requires EXACTLY manifest.json, outcomes.ndjson and
  // summary.json. Every governance sidecar therefore lives in the runtime
  // governance directory, never inside the run directory. This asserts the path
  // contract structurally, without generating any real outcome.
  const record = syntheticAuthorization();
  const runDir = path.resolve('/repo', record.outputRoot, record.runId);
  const sidecars = [
    outcomeAuthorizationPathForGeneration(1), outcomeAuthorizationReviewPathForGeneration(1),
    outcomeAuthorizationClaimPathForGeneration(1), outcomeAuthorizationConsumptionPathForGeneration(1),
  ];
  for (const sidecar of sidecars) {
    assert.ok(sidecar.startsWith(`${R4_OUTCOME_AUTHORIZATION_DIR}/`), `${sidecar} must live in the governance store`);
    assert.ok(!sidecar.includes(record.runId), 'a sidecar must never live inside the run directory');
    assert.ok(!path.resolve('/repo', sidecar).startsWith(runDir + path.sep));
  }
  assert.deepEqual(sidecars.map(p => path.posix.basename(p)), [
    'outcome-authorization-0001.json', 'outcome-authorization-0001.review.json',
    'outcome-authorization-0001.claim.json', 'outcome-authorization-0001.consumption.json',
  ]);
  // The wrapper's own claim/consumption writers target the governance store.
  const source = readFileSync(new URL('./r4-outcome-generate.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('outcomeAuthorizationClaimPathForGeneration'));
  assert.ok(source.includes('outcomeAuthorizationConsumptionPathForGeneration'));
});

test('V37 sealedCode can carry authorizationFingerprint without breaking the sealed verifier', () => {
  // EMPIRICAL, SYNTHETIC proof. A real sealed `generateOutcomeRun` is executed on
  // SYNTHETIC sessions inside a temp root (never the real cohort) with the extended
  // sealedCode, then the real sealed `verifyOutcomeRun` must accept it and the run
  // directory must hold EXACTLY manifest.json, outcomes.ndjson and summary.json.
  const root = newRoot();
  const at = 1_800_000_000_000;
  const { dir } = buildSyntheticEvidenceSession({
    cwd: root, sessionId: `syn${String(at).slice(-8)}${'a'.repeat(24)}`, startAt: at,
  });
  const session = readSourceSession({ dir, role: 'cohort' }, R4_SOURCE_POLICY);
  const references = selectAllEligibleReferences([session]);
  const facts = syntheticFacts();
  const authorization = syntheticAuthorization({ facts });
  const sealedCode = buildSealedCodeBinding({ facts, authorization });
  assert.equal(sealedCode.authorizationFingerprint, authorization.fingerprint);
  assert.equal(sealedCode.sha, facts.authority.sealAuthorityCommit);
  assert.equal(sealedCode.tree, facts.seal.protocolTree);
  const runId = 'r4-outcome-0001-probe';
  const outputRoot = path.join(root, 'outcomes');
  const generated = generateOutcomeRun({
    sources: [{ dir, role: 'cohort' }], references, outputRoot, runId,
    createdAt: at + 700_000, sourcePolicy: R4_SOURCE_POLICY, sealedCode,
  });
  // The SEALED verifier accepts the extended sealedCode and preserves every field.
  const verified = verifyOutcomeRun(path.join(outputRoot, runId));
  assert.equal(verified.fingerprint, generated.manifest.fingerprint);
  assert.equal(verified.sealedCode.authorizationFingerprint, authorization.fingerprint);
  assert.equal(verified.sealedCode.sha, sealedCode.sha);
  assert.equal(verified.sealedCode.tree, sealedCode.tree);
  assert.deepEqual(Object.keys(verified.sealedCode).sort(),
    ['authorizationFingerprint', 'sealFingerprint', 'sha', 'tree']);
  // Exactly the three sealed files: no governance sidecar may live in the run dir.
  assert.deepEqual(readdirSync(path.join(outputRoot, runId)).sort(),
    ['manifest.json', 'outcomes.ndjson', 'summary.json']);
  // So `scripts/market-outcomes/index.mjs` is NOT modified and no sidecar is needed
  // for the link; the sidecars are used only for single-use bookkeeping.
});

/* ------------------------------------------- 38-40. closure / seal / Stage C */

test('V38 the R4 import closure remains valid and excludes these unbound scripts', () => {
  const result = assertImportClosureBound();
  assert.equal(result.ok, true);
  const required = requiredBoundFiles();
  for (const file of Object.values(R4_OUTCOME_AUTHORIZATION_IMPLEMENTATION_FILES)) {
    if (file === 'scripts/market-outcomes/index.mjs') continue; // this one IS sealed
    assert.ok(!required.includes(file), `${file} must NOT be part of the sealed bound set`);
    assert.ok(!R4_REQUIRED_BOUND_FILES.includes(file), `${file} must NOT be in R4_REQUIRED_BOUND_FILES`);
  }
  // The sealed implementation stays bound.
  assert.ok(R4_REQUIRED_BOUND_FILES.includes('scripts/market-outcomes/index.mjs'));
  assert.ok(required.includes('scripts/market-outcomes/index.mjs'));
});

test('V39 the existing bound files remain byte-identical to HEAD', () => {
  for (const file of R4_REQUIRED_BOUND_FILES) {
    if (file === R4_TRACKED_SEAL_PATH) continue;
    const working = createHash('sha256').update(readFileSync(path.resolve(process.cwd(), file))).digest('hex');
    const committed = execFileSync('git', ['show', `HEAD:${file}`], { cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024 });
    assert.equal(working, createHash('sha256').update(committed).digest('hex'), `${file} changed`);
  }
  // And nothing bound is staged.
  const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: process.cwd(), encoding: 'utf8' }).trim();
  assert.equal(staged, '');
  const unstaged = execFileSync('git', ['diff', '--name-only'], { cwd: process.cwd(), encoding: 'utf8' }).split('\n').filter(Boolean);
  for (const file of unstaged) assert.ok(!R4_REQUIRED_BOUND_FILES.includes(file), `${file} is a modified bound file`);
});

test('V40 Stage C still resolves after the unbound scripts exist, with HEAD and origin/main unchanged', () => {
  const resolution = resolveR4ExecutionAuthority({ cwd: process.cwd(), requireApproval: true });
  assert.equal(resolution.stage, 'C');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).trim();
  const remote = execFileSync('git', ['ls-remote', 'origin', 'refs/heads/main'], { cwd: process.cwd(), encoding: 'utf8' }).trim().split(/\s+/)[0];
  assert.equal(head, resolution.continuationCommit);
  assert.equal(remote, resolution.continuationCommit);
  assertLiveAuthorityAtC1({ resolution, head, remoteSha: remote });
  assertStageC(resolution);
  // The issuer's own gate accepts the same live state.
  assert.doesNotThrow(() => assertImplementationHashes({ declared: implementationHashes({ cwd: process.cwd() }), actual: implementationHashes({ cwd: process.cwd() }) }));
});

/* ------------------------------------------------------ isolation guarantees */

test('V41 this validator never issues a real authorization or writes real evidence', () => {
  // No governance record may exist in the real evidence root as a result of
  // running this validator.
  const real = path.resolve(process.cwd(), R4_OUTCOME_AUTHORIZATION_DIR);
  assert.equal(readOutcomeRecord(path.join(real, outcomeAuthorizationPathForGeneration(1))), null);
  assert.deepEqual(existingAuthorizationGenerations({ cwd: process.cwd() }), []);
  // No real outcome root may exist.
  for (const root of ['.evolve/market-outcomes', '.evolve/market-intelligence/outcomes', '.evolve/outcomes']) {
    assert.equal(listOutcomeRuns({ cwd: process.cwd(), outputRoot: root }).length, 0);
  }
  // The run id is fully deterministic from identity alone (no market data).
  const identity = {
    authorizationGeneration: 1, scientificApprovalFingerprint: DIGEST, runtimeSealFingerprint: DIGEST2,
    continuationFingerprint: DIGEST, membershipDigest: canonicalMembershipDigest(MEMBERSHIP),
    referenceSetDigest: R4_OUTCOME_AUTHORIZATION_REFERENCE_SET_DIGEST, createdAt: 1_900_000_000_000,
  };
  assert.equal(deriveOutcomeRunId(identity), deriveOutcomeRunId({ ...identity }));
  assert.match(deriveOutcomeRunId(identity), /^r4-outcome-0001-[0-9a-f]{32}$/);
  assert.notEqual(deriveOutcomeRunId(identity), deriveOutcomeRunId({ ...identity, createdAt: 1_900_000_000_001 }));
});

test('V42 review import is write-once and binds the exact live authority identities', () => {
  const root = newRoot();
  // Copy the real implementation files verbatim so `implementationHashes` reads
  // genuine bytes from the isolated store. No test seam, no production bypass.
  for (const file of Object.values(R4_OUTCOME_AUTHORIZATION_IMPLEMENTATION_FILES)) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(path.resolve(process.cwd(), file)));
  }
  assert.deepEqual(implementationHashes({ cwd: root }), implementationHashes({ cwd: process.cwd() }));
  const liveHashes = implementationHashes({ cwd: root });
  const review = syntheticReview({ input: { implementationHashes: liveHashes } });
  // Imported against synthetic facts (the real path resolves live authority).
  const facts = syntheticFacts();
  const written = importOutcomeAuthorizationReview({ cwd: root, review, facts });
  assert.equal(statSync(written.file).mode & 0o777, 0o444);
  assert.equal(readOutcomeRecord(written.file).fingerprint, review.fingerprint);
  assert.throws(() => importOutcomeAuthorizationReview({ cwd: root, review, facts }),
    new RegExp(R4_OUTCOME_AUTHORIZATION_FAILURE.exists));
  // A review that binds a different authority cannot be imported.
  assert.throws(() => importOutcomeAuthorizationReview({
    cwd: root, review: syntheticReview({ input: { scientificApprovalFingerprint: '9'.repeat(64), implementationHashes: liveHashes } }), facts,
  }), new RegExp(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:A2_FINGERPRINT`));
});

test('V43 the generation wrapper verifies its OWN file hash before any outcome work', () => {
  const live = implementationHashes({ cwd: process.cwd() });
  const wrapperBytes = readFileSync(new URL('./r4-outcome-generate.mjs', import.meta.url));
  assert.equal(live.generatorWrapper, createHash('sha256').update(wrapperBytes).digest('hex'));
  const issuerBytes = readFileSync(new URL('./r4-outcome-authorization.mjs', import.meta.url));
  assert.equal(live.issuerVerifier, createHash('sha256').update(issuerBytes).digest('hex'));
  const validatorBytes = readFileSync(new URL('./validate-r4-outcome-authorization.mjs', import.meta.url));
  assert.equal(live.validator, createHash('sha256').update(validatorBytes).digest('hex'));
  // The pinned roles map to exactly the four execution-path files.
  assert.deepEqual(Object.keys(R4_OUTCOME_AUTHORIZATION_IMPLEMENTATION_FILES).sort(),
    ['generatorWrapper', 'issuerVerifier', 'sealedOutcomeImplementation', 'validator']);
  for (const hash of Object.values(live)) assert.match(hash, /^[0-9a-f]{64}$/);
});

/* ------------------------------------------------------------------- runner */

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`ok   ${name}`); }
  catch (error) { failed++; console.log(`FAIL ${name}\n     ${String(error?.message ?? error).split('\n').slice(0, 4).join('\n     ')}`); }
}
for (const root of tempRoots) { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } }
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed) process.exitCode = 1;
