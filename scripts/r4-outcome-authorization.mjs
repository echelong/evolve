// R4 RUNTIME OUTCOME AUTHORIZATION (post-cohort governance; enforcement only).
//
// WHY THIS FILE EXISTS. `docs/R4-PREREGISTRATION.md` requires that "outcome
// generation requires the cohort to be closed, maturation to be complete, source
// integrity to verify and a separate authorization". The first three conditions
// are mechanically implemented by the existing sealed modules. This module
// implements the FOURTH condition, which had no canonical implementation.
//
// WHAT THIS IS NOT.
//   * It is NOT a new Git authority. It is not A3 and not C2. It creates no
//     commit, moves no ref, seals nothing and is bound by no seal.
//   * It is NOT sealed code. These scripts are deliberately UNBOUND: they are
//     absent from `R4_REQUIRED_BOUND_FILES`, `R4_RUNTIME_ROOTS`,
//     `R4_BOUND_VALIDATORS` and `R4_BOUND_NON_RUNTIME_ARTIFACTS`, and adding
//     them would invalidate the sealed bound set and therefore Stage C.
//   * It is HASH-ATTESTED, not sealed. The review and the authorization pin the
//     exact SHA-256 of the bytes of every file in the execution path, including
//     this file's own bytes, and both the generation wrapper and `verify`
//     recompute those hashes before anything else happens.
//   * Enforcement is therefore PROCEDURAL/GOVERNANCE enforcement layered on top
//     of a sealed scientific core, NOT a trusted execution environment. The bare
//     `generateOutcomeRun` export remains technically callable, and anyone with
//     filesystem authority over this checkout can remove or replace local
//     `.evolve` governance records. No scientific rule is introduced, changed or
//     selectable here: every scientific value remains in the pre-existing
//     sealed code, and this file adds no outcome science of any kind.
//
// ANTI-RESULT-SELECTION. Issuance and verification read ONLY authority,
// integrity, process and identity metadata: Git commits, seal/approval/
// continuation fingerprints, attempt authorization/claim/terminal/attestation
// fingerprints, canonical membership, the canonical reference SET IDENTITY and
// reference observation timestamps. They never read a price, a disagreement
// value, an outcome, a return, an effect size, a resolution rate, an exposure
// value or an analysis result. `createdAt` is taken from process time after the
// maturation windows are proven closed, never from market state.
//
// The governance object is the AUTHORIZATION ARTIFACT, not this script.
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, constants, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, digest } from './market-intelligence/definition.mjs';
import { R4_COHORT_SPEC } from './r4-cohort-plan.mjs';
import { R4_SESSION_DIR_ROOT, buildCanonicalReferenceSetFromEvidence, deriveCanonicalCohortMembership, planSealedCohort } from './r4-enforcement.mjs';
import { R4_OUTCOME_RUN_ROOTS } from './r4-approval-epochs.mjs';
import { PRIMARY_HORIZON_MS, RESOLUTION_TOLERANCE_MS, R4_SOURCE_POLICY } from './market-outcomes/index.mjs';
import { deriveNextAttempt, historyAttemptAuthorityIndex, historyAttestations, historyToCohortAttempts, loadR4AttemptHistory, verifyR4AttemptHistory } from './r4-attempt-history.mjs';
import { resolveR4ExecutionAuthority } from './r4-approval.mjs';
import { gitCommitterTimestamp, gitHead, liveRemoteMainSha, R4_REPO_ROOT } from './r4-authority.mjs';

const fail = code => { throw new Error(code); };
const isSha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const isDigest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const isStamp = value => Number.isSafeInteger(value) && value >= 0;
const isNonEmptyString = value => typeof value === 'string' && value.trim() !== '';
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/* -------------------------------------------------------------- record types */

export const R4_OUTCOME_AUTHORIZATION_DIR = '.evolve/governance/r4-outcome-authorizations';
export const R4_OUTCOME_AUTHORIZATION_RECORD_TYPE = 'r4_outcome_authorization';
export const R4_OUTCOME_AUTHORIZATION_REVIEW_RECORD_TYPE = 'r4_outcome_authorization_review';
export const R4_OUTCOME_AUTHORIZATION_CLAIM_RECORD_TYPE = 'r4_outcome_authorization_claim';
export const R4_OUTCOME_AUTHORIZATION_CONSUMPTION_RECORD_TYPE = 'r4_outcome_authorization_consumption';
export const R4_OUTCOME_AUTHORIZATION_SCHEMA_VERSION = 1;
export const R4_OUTCOME_AUTHORIZATION_REVIEW_SCHEMA_VERSION = 1;
export const R4_OUTCOME_AUTHORIZATION_CLAIM_SCHEMA_VERSION = 1;
export const R4_OUTCOME_AUTHORIZATION_CONSUMPTION_SCHEMA_VERSION = 1;
export const R4_OUTCOME_AUTHORIZATION_STATUS = 'AUTHORIZED';
/** The only verdict an independent review may return that permits issuance. */
export const R4_OUTCOME_AUTHORIZATION_REVIEW_VERDICT = 'READY_TO_GENERATE_OUTCOMES';
/** Canonical output root. Never caller-selectable. */
export const R4_OUTCOME_AUTHORIZATION_OUTPUT_ROOT = R4_OUTCOME_RUN_ROOTS[0];
export const R4_OUTCOME_AUTHORIZATION_MATURATION_MODE = R4_COHORT_SPEC.maturationMode;

/**
 * FROZEN IDENTITY ASSERTIONS. These are NOT sample-size thresholds, minima or
 * tolerances: the canonical R4 reference set IS this set, so there is no
 * fallback count, no lower bound, no upper bound and no alternative digest. A
 * cohort that produced 3515 or 3517 references is a DIFFERENT cohort and can
 * never be authorized.
 */
export const R4_OUTCOME_AUTHORIZATION_REFERENCE_COUNT = 3516;
export const R4_OUTCOME_AUTHORIZATION_REFERENCE_SET_DIGEST =
  '08fcf8b6f3a6d9d5498d41c981682185587204e9f648d8190ca42972027cbf94';
/** Frozen cohort-closure shape required at issuance. */
export const R4_OUTCOME_AUTHORIZATION_REQUIRED_ATTEMPTS_USED = 6;
export const R4_OUTCOME_AUTHORIZATION_REQUIRED_COMPLETED_COUNT = 6;
export const R4_OUTCOME_AUTHORIZATION_REQUIRED_STOP = true;
export const R4_OUTCOME_AUTHORIZATION_REQUIRED_BLOCKED = false;
export const R4_OUTCOME_AUTHORIZATION_REQUIRED_NEXT_ATTEMPT_INDEX = null;
export const R4_OUTCOME_AUTHORIZATION_REQUIRED_MEMBERS = R4_COHORT_SPEC.targetCompletedSessions;

/**
 * The exact files whose bytes this mechanism attests. `sealedOutcomeImplementation`
 * is the EXISTING SEALED outcome implementation whose authenticated identity is
 * bound here; the other three are this mechanism's own UNBOUND orchestration
 * code, which cannot be sealed without invalidating Stage C.
 */
export const R4_OUTCOME_AUTHORIZATION_IMPLEMENTATION_FILES = Object.freeze({
  issuerVerifier: 'scripts/r4-outcome-authorization.mjs',
  generatorWrapper: 'scripts/r4-outcome-generate.mjs',
  validator: 'scripts/validate-r4-outcome-authorization.mjs',
  sealedOutcomeImplementation: 'scripts/market-outcomes/index.mjs',
});

export const R4_OUTCOME_AUTHORIZATION_FAILURE = Object.freeze({
  stage: 'R4_OUTCOME_AUTHORIZATION_STAGE_NOT_C',
  head: 'R4_OUTCOME_AUTHORIZATION_HEAD_NOT_C1',
  remote: 'R4_OUTCOME_AUTHORIZATION_REMOTE_MAIN_NOT_C1',
  closure: 'R4_OUTCOME_AUTHORIZATION_COHORT_NOT_CLOSED',
  membership: 'R4_OUTCOME_AUTHORIZATION_CANONICAL_MEMBERSHIP_INVALID',
  references: 'R4_OUTCOME_AUTHORIZATION_REFERENCE_IDENTITY_MISMATCH',
  maturation: 'R4_OUTCOME_AUTHORIZATION_NOT_MATURED',
  artifacts: 'R4_OUTCOME_AUTHORIZATION_OUTCOME_ARTIFACTS_PRESENT',
  review: 'R4_OUTCOME_AUTHORIZATION_REVIEW_INVALID',
  exists: 'R4_OUTCOME_AUTHORIZATION_ALREADY_EXISTS',
  consumed: 'R4_OUTCOME_AUTHORIZATION_ALREADY_CONSUMED',
  implementation: 'R4_OUTCOME_AUTHORIZATION_IMPLEMENTATION_HASH_MISMATCH',
  override: 'R4_OUTCOME_AUTHORIZATION_OVERRIDE_FORBIDDEN',
  schema: 'R4_OUTCOME_AUTHORIZATION_UNKNOWN_FIELD',
  runDir: 'R4_OUTCOME_AUTHORIZATION_RUN_PATH_EXISTS',
});

/**
 * No caller may supply an identity, a timing or a scientific input. The issuer
 * resolves every canonical fact internally; the generation wrapper accepts only
 * `--execute`.
 */
export const R4_OUTCOME_AUTHORIZATION_FORBIDDEN_OPTION_KEYS = Object.freeze([
  'sessionIds', 'sessions', 'membership', 'canonicalMembership', 'references', 'canonicalReferences',
  'referenceCount', 'referenceSetDigest', 'referenceSet', 'runId', 'createdAt', 'outputRoot', 't0', 'T0',
  'approval', 'approvalCommit', 'approvalEpoch', 'approvalFingerprint', 'seal', 'sealCommit', 'sealFingerprint',
  'continuation', 'continuationCommit', 'continuationFingerprint', 'continuationGeneration',
  'sourcePolicy', 'sealedCode', 'outcomeValues', 'outcomes', 'prices', 'price', 'effectSizes',
  'resolvedCount', 'resolutionRate', 'marketConditions', 'maturation', 'horizonMs', 'toleranceMs',
  'sourceIntegrityProofDigest', 'maturationProofDigest', 'implementationHashes', 'reviewFingerprint',
  'outcomeArtifactsPresentAtIssuance', 'startAt', 'start-at', 'offset', 'window', 'clock',
  'generation', 'authorizationGeneration', 'attempt', 'attemptIndex', 'expect',
]);

/** Reject every forbidden caller-supplied key. There is no permissive subset. */
export function assertNoAuthorizationOverride(options = {}) {
  for (const key of Object.keys(options ?? {})) {
    if (R4_OUTCOME_AUTHORIZATION_FORBIDDEN_OPTION_KEYS.includes(key)) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.override}:${key}`);
  }
  return true;
}

/* ------------------------------------------------------------------- paths */

const pad4 = generation => String(generation).padStart(4, '0');
export const assertAuthorizationGeneration = generation => {
  if (!Number.isInteger(generation) || generation < 1) fail('R4_OUTCOME_AUTHORIZATION_GENERATION_INVALID');
  return generation;
};

export function outcomeAuthorizationPathForGeneration(generation) {
  return `${R4_OUTCOME_AUTHORIZATION_DIR}/outcome-authorization-${pad4(assertAuthorizationGeneration(generation))}.json`;
}
export function outcomeAuthorizationReviewPathForGeneration(generation) {
  return `${R4_OUTCOME_AUTHORIZATION_DIR}/outcome-authorization-${pad4(assertAuthorizationGeneration(generation))}.review.json`;
}
export function outcomeAuthorizationClaimPathForGeneration(generation) {
  return `${R4_OUTCOME_AUTHORIZATION_DIR}/outcome-authorization-${pad4(assertAuthorizationGeneration(generation))}.claim.json`;
}
export function outcomeAuthorizationConsumptionPathForGeneration(generation) {
  return `${R4_OUTCOME_AUTHORIZATION_DIR}/outcome-authorization-${pad4(assertAuthorizationGeneration(generation))}.consumption.json`;
}

/* ----------------------------------------------------------- fingerprints */

/** Deterministic canonical content digest, excluding the `fingerprint` field. */
export const authorizationFingerprint = record => {
  const content = { ...record };
  delete content.fingerprint;
  return digest(content);
};
export const outcomeAuthorizationReviewFingerprint = record => {
  const content = { ...record };
  delete content.fingerprint;
  return digest(content);
};
export const outcomeAuthorizationSidecarFingerprint = record => {
  const content = { ...record };
  delete content.fingerprint;
  return digest(content);
};

/** Closed-schema policy: an unknown field is a failure, never ignored. */
export function assertClosedSchema(record, allowed) {
  if (!isPlainObject(record)) fail('R4_OUTCOME_AUTHORIZATION_RECORD_INVALID');
  const unknown = Object.keys(record).filter(key => !allowed.includes(key));
  if (unknown.length) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.schema}:${unknown.sort().join(',')}`);
  const missing = allowed.filter(key => !(key in record));
  if (missing.length) fail(`R4_OUTCOME_AUTHORIZATION_FIELD_MISSING:${missing.sort().join(',')}`);
  return true;
}

export const R4_OUTCOME_AUTHORIZATION_FIELDS = Object.freeze([
  'schemaVersion', 'recordType', 'status', 'authorizationGeneration',
  'scientificApprovalCommit', 'scientificApprovalEpoch', 'scientificApprovalFingerprint',
  'runtimeSealCommit', 'runtimeSealFingerprint',
  'continuationCommit', 'continuationFingerprint', 'continuationGeneration',
  't0', 'maxAttempts', 'targetCompletedSessions', 'attemptsUsed', 'completedCount', 'stop', 'blocked', 'nextAttemptIndex',
  'canonicalMembership', 'canonicalMembershipDigest', 'referenceCount', 'referenceSetDigest',
  'outcomeArtifactsPresentAtIssuance', 'outcomeRootsInspected',
  'maturationMode', 'maturationProofDigest', 'sourceIntegrityProofDigest',
  'runId', 'createdAt', 'createdAtIso', 'outputRoot', 'sourcePolicy',
  'implementationHashes', 'reviewFingerprint', 'issuedAt', 'issuedAtIso',
  'enforcementLimitations', 'fingerprint',
]);

export const R4_OUTCOME_AUTHORIZATION_REVIEW_FIELDS = Object.freeze([
  'schemaVersion', 'recordType', 'verdict', 'reviewer', 'model', 'reviewedAt', 'reviewedAtIso',
  'authorizationGeneration', 'scientificApprovalCommit', 'scientificApprovalEpoch', 'scientificApprovalFingerprint',
  'runtimeSealCommit', 'runtimeSealFingerprint',
  'continuationCommit', 'continuationFingerprint', 'continuationGeneration', 't0',
  'canonicalMembershipDigest', 'referenceCount', 'referenceSetDigest', 'implementationHashes',
  'outcomeValuesInspected', 'returnsInspected', 'effectSizesInspected', 'resolutionRatesInspected', 'marketStateInspected',
  'blockers', 'fingerprint',
]);

/* ----------------------------------------------- implementation hash pinning */

/** SHA-256 of the exact bytes of every file in the execution path. */
export function implementationHashes({ cwd = R4_REPO_ROOT, files = R4_OUTCOME_AUTHORIZATION_IMPLEMENTATION_FILES, readFile = defaultReadFile } = {}) {
  const hashes = {};
  for (const [role, file] of Object.entries(files)) {
    const bytes = readFile(path.resolve(cwd, file));
    if (bytes === null || bytes === undefined) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.implementation}:MISSING:${file}`);
    hashes[role] = createHash('sha256').update(bytes).digest('hex');
  }
  return hashes;
}
function defaultReadFile(absolute) {
  try { return readFileSync(absolute); } catch { return null; }
}

/**
 * Compare a declared hash set against the live bytes. ANY missing role, unknown
 * role, malformed digest or differing digest fails closed — including the
 * generator wrapper's and this module's own hashes.
 */
export function assertImplementationHashes({ declared, actual }) {
  if (!isPlainObject(declared) || !isPlainObject(actual)) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.implementation}:MISSING`);
  const roles = Object.keys(R4_OUTCOME_AUTHORIZATION_IMPLEMENTATION_FILES);
  if (canonical(Object.keys(declared).sort()) !== canonical([...roles].sort())) {
    fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.implementation}:ROLES`);
  }
  for (const role of roles) {
    if (!isDigest(declared[role])) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.implementation}:MALFORMED:${role}`);
    if (declared[role] !== actual[role]) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.implementation}:${role}`);
  }
  return true;
}

/* ------------------------------------------------------------ write-once IO */

/** fsync a directory so a just-created entry survives a crash. */
export function fsyncOutcomeDirectory(dir) {
  const fd = openSync(dir, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * Write-once (`O_CREAT | O_EXCL`), fsync the file, fsync the directory, then
 * `chmod 0444`, then IMMEDIATELY re-read and verify. There is no overwrite, no
 * repair-in-place and no discretionary cleanup: a torn or missing write leaves
 * the file absent and the next attempt fails closed.
 */
export function writeOutcomeRecordOnce(file, body, { mode = 0o444 } = {}) {
  const absolute = path.resolve(file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  let fd;
  try { fd = openSync(absolute, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode); }
  catch (error) { if (error?.code === 'EEXIST') fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.exists}:${path.basename(absolute)}`); throw error; }
  try {
    const bytes = Buffer.from(body, 'utf8');
    for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  chmodSync(absolute, mode);
  fsyncOutcomeDirectory(path.dirname(absolute));
  // IMMEDIATE READ-BACK VERIFICATION.
  if (readFileSync(absolute, 'utf8') !== body) fail(`R4_OUTCOME_AUTHORIZATION_WRITE_VERIFY_FAILED:${path.basename(absolute)}`);
  return { file: absolute, bytes: Buffer.byteLength(body, 'utf8'), mode };
}

export const readOutcomeRecord = file => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
};

/** Generations already present in the governance store (sorted ascending). */
export function existingAuthorizationGenerations({ cwd = R4_REPO_ROOT, dir = R4_OUTCOME_AUTHORIZATION_DIR } = {}) {
  let names;
  try { names = readdirSync(path.resolve(cwd, dir)); } catch { return []; }
  const generations = [];
  for (const name of names) {
    const match = /^outcome-authorization-(\d{4})\.json$/.exec(name);
    if (match) generations.push(Number(match[1]));
  }
  return generations.sort((a, b) => a - b);
}

/** The next canonical authorization generation. Never caller-selectable. */
export function nextAuthorizationGeneration(options = {}) {
  const generations = existingAuthorizationGenerations(options);
  return generations.length ? generations[generations.length - 1] + 1 : 1;
}

/* ------------------------------------------------------------ pure gates */

/** Stage must be C: the post-start continuation runtime, resolved from Git. */
export function assertStageC(resolution) {
  if (!isPlainObject(resolution) || resolution.stage !== 'C') fail(R4_OUTCOME_AUTHORIZATION_FAILURE.stage);
  if (!isSha(resolution.continuationCommit) || !isDigest(resolution.continuationFingerprint)) fail(R4_OUTCOME_AUTHORIZATION_FAILURE.stage);
  if (!Number.isInteger(resolution.continuationGeneration) || resolution.continuationGeneration < 1) fail(R4_OUTCOME_AUTHORIZATION_FAILURE.stage);
  return true;
}

/** HEAD and LIVE origin/main must both equal the continuation commit C1. */
export function assertLiveAuthorityAtC1({ resolution, head, remoteSha }) {
  if (!isSha(head) || head !== resolution.continuationCommit) fail(R4_OUTCOME_AUTHORIZATION_FAILURE.head);
  if (!isSha(remoteSha) || remoteSha !== resolution.continuationCommit) fail(R4_OUTCOME_AUTHORIZATION_FAILURE.remote);
  return true;
}

/** The cohort must be closed at exactly the frozen terminal shape. */
export function assertCohortClosure(progress) {
  if (!isPlainObject(progress)) fail(R4_OUTCOME_AUTHORIZATION_FAILURE.closure);
  if (progress.attemptsUsed !== R4_OUTCOME_AUTHORIZATION_REQUIRED_ATTEMPTS_USED) fail(R4_OUTCOME_AUTHORIZATION_FAILURE.closure);
  if (progress.completedCount !== R4_OUTCOME_AUTHORIZATION_REQUIRED_COMPLETED_COUNT) fail(R4_OUTCOME_AUTHORIZATION_FAILURE.closure);
  if (progress.stop !== R4_OUTCOME_AUTHORIZATION_REQUIRED_STOP) fail(R4_OUTCOME_AUTHORIZATION_FAILURE.closure);
  if (progress.blocked !== R4_OUTCOME_AUTHORIZATION_REQUIRED_BLOCKED) fail(R4_OUTCOME_AUTHORIZATION_FAILURE.closure);
  if ((progress.nextAttemptIndex ?? null) !== R4_OUTCOME_AUTHORIZATION_REQUIRED_NEXT_ATTEMPT_INDEX) fail(R4_OUTCOME_AUTHORIZATION_FAILURE.closure);
  return true;
}

/**
 * Canonical membership is an evaluator OUTPUT, mechanically derived from
 * authenticated attempt history. Exactly the frozen member count is required
 * with no duplicates. The authorization stores it in DERIVED ORDER so a
 * reordered record cannot pass the verification path, while the bound digest is
 * order-independent.
 */
export function assertCanonicalMembership(canonicalMembership) {
  if (!Array.isArray(canonicalMembership)) fail(R4_OUTCOME_AUTHORIZATION_FAILURE.membership);
  if (canonicalMembership.length !== R4_OUTCOME_AUTHORIZATION_REQUIRED_MEMBERS) fail(R4_OUTCOME_AUTHORIZATION_FAILURE.membership);
  if (new Set(canonicalMembership).size !== canonicalMembership.length) fail(R4_OUTCOME_AUTHORIZATION_FAILURE.membership);
  for (const sessionId of canonicalMembership) if (!isNonEmptyString(sessionId)) fail(R4_OUTCOME_AUTHORIZATION_FAILURE.membership);
  return true;
}

export const canonicalMembershipDigest = canonicalMembership => digest([...canonicalMembership].sort());

/** STRICT reference-set identity equality. Not a threshold, not a minimum. */
export function assertReferenceIdentity({ referenceCount, referenceSetDigest: setDigest }) {
  if (referenceCount !== R4_OUTCOME_AUTHORIZATION_REFERENCE_COUNT) fail(R4_OUTCOME_AUTHORIZATION_FAILURE.references);
  if (setDigest !== R4_OUTCOME_AUTHORIZATION_REFERENCE_SET_DIGEST) fail(R4_OUTCOME_AUTHORIZATION_FAILURE.references);
  return true;
}

/**
 * Frozen maturation mode: COHORT_DRAIN_ONLY, no separate maturation session.
 * Every authorized reference must be matured at the authorized `createdAt`:
 *
 *     createdAt >= referenceObservedAt + 300000 (horizon) + 60000 (tolerance)
 *
 * Only the reference OBSERVATION TIMESTAMP is read. No price, disagreement,
 * return, outcome or effect value is inspected.
 */
export function assertMaturation({ references, sessions, createdAt }) {
  if (!isStamp(createdAt)) fail(R4_OUTCOME_AUTHORIZATION_FAILURE.maturation);
  if (!Array.isArray(references) || references.length === 0) fail(R4_OUTCOME_AUTHORIZATION_FAILURE.maturation);
  const bySession = new Map();
  for (const session of Array.isArray(sessions) ? sessions : []) bySession.set(session.sessionId, session);
  const rows = [];
  let latestDeadline = 0;
  for (const reference of references) {
    const session = bySession.get(reference.sessionId);
    if (!session) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.maturation}:SESSION_MISSING`);
    const matches = session.snapshotsByDigest?.get(reference.snapshotDigest) ?? [];
    if (matches.length !== 1) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.maturation}:REFERENCE_NOT_UNIQUE`);
    const observedAt = matches[0].snapshot?.observedAt;
    if (!isStamp(observedAt)) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.maturation}:OBSERVED_AT_INVALID`);
    const deadline = observedAt + PRIMARY_HORIZON_MS + RESOLUTION_TOLERANCE_MS;
    if (!Number.isSafeInteger(deadline)) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.maturation}:DEADLINE_INVALID`);
    latestDeadline = Math.max(latestDeadline, deadline);
    if (createdAt < deadline) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.maturation}:${reference.sessionId}/${reference.snapshotDigest}`);
    rows.push({ sessionId: reference.sessionId, snapshotDigest: reference.snapshotDigest, referenceObservedAt: observedAt, maturedAt: deadline });
  }
  rows.sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0)
    || (a.snapshotDigest < b.snapshotDigest ? -1 : a.snapshotDigest > b.snapshotDigest ? 1 : 0));
  return { rows, latestDeadline };
}

/** Digest binding the maturation proof. No outcome value is part of it. */
export function maturationProofDigest({ rows, latestDeadline, createdAt, mode = R4_OUTCOME_AUTHORIZATION_MATURATION_MODE }) {
  return digest({
    purpose: 'R4_OUTCOME_MATURATION_PROOF', mode, horizonMs: PRIMARY_HORIZON_MS, toleranceMs: RESOLUTION_TOLERANCE_MS,
    createdAt, latestMaturedDeadlineAt: latestDeadline, referenceCount: rows.length, references: rows,
  });
}

/**
 * ZERO existing outcome runs/artifacts across every canonical outcome root R4
 * recognizes. Only existence is inspected; if anything is present, issuance is
 * refused outright (no date comparison, no discretion).
 */
export function assertNoOutcomeArtifacts({ cwd = R4_REPO_ROOT, roots = R4_OUTCOME_RUN_ROOTS } = {}) {
  const present = [];
  for (const root of roots) {
    let entries;
    try { entries = readdirSync(path.resolve(cwd, root)); } catch { continue; }
    for (const entry of entries) present.push(`${root}/${entry}`);
  }
  if (present.length) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.artifacts}:${present.sort().join(',')}`);
  return true;
}

/** Digest binding per-member source/session + attestation integrity identities. */
export function sourceIntegrityProofDigest({ verified }) {
  if (!Array.isArray(verified) || verified.length === 0) fail('R4_OUTCOME_AUTHORIZATION_SOURCE_INTEGRITY_INVALID');
  const rows = verified.map(({ session, proof }) => ({
    sessionId: session.sessionId,
    sessionFingerprint: session.fingerprint,
    attestationFingerprint: proof.attestationFingerprint,
    authorizationFingerprint: proof.authorizationFingerprint,
    captureSpecDigest: proof.captureSpecDigest,
  })).sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
  return digest({ purpose: 'R4_OUTCOME_SOURCE_INTEGRITY_PROOF', members: rows });
}

/* ---------------------------------------------------------- record builders */

/**
 * Build the review record. It is normally AUTHORED BY THE INDEPENDENT REVIEWER
 * and imported; this builder exists so a reviewer can produce a structurally
 * valid record, and the importer NEVER invents a reviewer identity.
 */
export function buildOutcomeAuthorizationReview(input = {}) {
  const {
    authorizationGeneration, reviewer, model, reviewedAt,
    scientificApprovalCommit, scientificApprovalEpoch, scientificApprovalFingerprint,
    runtimeSealCommit, runtimeSealFingerprint,
    continuationCommit, continuationFingerprint, continuationGeneration, t0,
    canonicalMembershipDigest: membershipDigest, referenceCount, referenceSetDigest: setDigest,
    implementationHashes: hashes,
    verdict = R4_OUTCOME_AUTHORIZATION_REVIEW_VERDICT, blockers = [],
  } = input;
  if (!Number.isInteger(authorizationGeneration) || authorizationGeneration < 1) fail(R4_OUTCOME_AUTHORIZATION_FAILURE.review);
  if (!isNonEmptyString(reviewer) || !isNonEmptyString(model)) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:REVIEWER_IDENTITY`);
  if (!isStamp(reviewedAt)) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:REVIEWED_AT`);
  if (!isSha(scientificApprovalCommit) || !Number.isInteger(scientificApprovalEpoch) || !isDigest(scientificApprovalFingerprint)) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:A2`);
  if (!isSha(runtimeSealCommit) || !isDigest(runtimeSealFingerprint)) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:S6`);
  if (!isSha(continuationCommit) || !isDigest(continuationFingerprint) || !Number.isInteger(continuationGeneration)) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:C1`);
  if (!isStamp(t0) || !isDigest(membershipDigest)) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:IDENTITY`);
  if (!isDigest(setDigest)) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:REFERENCE_SET`);
  if (referenceCount !== R4_OUTCOME_AUTHORIZATION_REFERENCE_COUNT) fail(R4_OUTCOME_AUTHORIZATION_FAILURE.review);
  if (verdict !== R4_OUTCOME_AUTHORIZATION_REVIEW_VERDICT) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:VERDICT`);
  if (!Array.isArray(blockers) || blockers.length !== 0) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:BLOCKERS_PRESENT`);
  if (!isPlainObject(hashes)) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:IMPLEMENTATION_HASHES`);
  const content = {
    schemaVersion: R4_OUTCOME_AUTHORIZATION_REVIEW_SCHEMA_VERSION,
    recordType: R4_OUTCOME_AUTHORIZATION_REVIEW_RECORD_TYPE,
    verdict, reviewer, model, reviewedAt, reviewedAtIso: new Date(reviewedAt).toISOString(),
    authorizationGeneration,
    scientificApprovalCommit, scientificApprovalEpoch, scientificApprovalFingerprint,
    runtimeSealCommit, runtimeSealFingerprint,
    continuationCommit, continuationFingerprint, continuationGeneration, t0,
    canonicalMembershipDigest: membershipDigest, referenceCount, referenceSetDigest: setDigest,
    implementationHashes: { ...hashes },
    // Explicit reviewer declarations. Each MUST be false: a reviewer who inspected
    // any of these cannot authorize generation, and the assertion refuses.
    outcomeValuesInspected: false,
    returnsInspected: false,
    effectSizesInspected: false,
    resolutionRatesInspected: false,
    marketStateInspected: false,
    blockers: [],
  };
  return { ...content, fingerprint: outcomeAuthorizationReviewFingerprint(content) };
}

/** Structural + self-consistency validation of an imported review record. */
export function assertOutcomeAuthorizationReview(record) {
  assertClosedSchema(record, R4_OUTCOME_AUTHORIZATION_REVIEW_FIELDS);
  if (record.schemaVersion !== R4_OUTCOME_AUTHORIZATION_REVIEW_SCHEMA_VERSION) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:SCHEMA_VERSION`);
  if (record.recordType !== R4_OUTCOME_AUTHORIZATION_REVIEW_RECORD_TYPE) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:RECORD_TYPE`);
  if (record.verdict !== R4_OUTCOME_AUTHORIZATION_REVIEW_VERDICT) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:VERDICT`);
  if (!Array.isArray(record.blockers) || record.blockers.length !== 0) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:BLOCKERS_PRESENT`);
  if (!isNonEmptyString(record.reviewer) || !isNonEmptyString(record.model)) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:REVIEWER_IDENTITY`);
  if (!isStamp(record.reviewedAt) || record.reviewedAtIso !== new Date(record.reviewedAt).toISOString()) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:REVIEWED_AT`);
  for (const declaration of ['outcomeValuesInspected', 'returnsInspected', 'effectSizesInspected', 'resolutionRatesInspected', 'marketStateInspected']) {
    if (record[declaration] !== false) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:DECLARATION:${declaration}`);
  }
  if (!Number.isInteger(record.authorizationGeneration) || record.authorizationGeneration < 1) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:GENERATION`);
  if (!isSha(record.scientificApprovalCommit) || !Number.isInteger(record.scientificApprovalEpoch) || !isDigest(record.scientificApprovalFingerprint)) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:A2`);
  if (!isSha(record.runtimeSealCommit) || !isDigest(record.runtimeSealFingerprint)) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:S6`);
  if (!isSha(record.continuationCommit) || !isDigest(record.continuationFingerprint) || !Number.isInteger(record.continuationGeneration)) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:C1`);
  if (record.referenceCount !== R4_OUTCOME_AUTHORIZATION_REFERENCE_COUNT) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:REFERENCE_COUNT`);
  if (record.referenceSetDigest !== R4_OUTCOME_AUTHORIZATION_REFERENCE_SET_DIGEST) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:REFERENCE_SET`);
  if (!isStamp(record.t0) || !isDigest(record.canonicalMembershipDigest)) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:IDENTITY`);
  if (!isPlainObject(record.implementationHashes)) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:IMPLEMENTATION_HASHES`);
  if (!isDigest(record.fingerprint) || outcomeAuthorizationReviewFingerprint(record) !== record.fingerprint) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:FINGERPRINT_MISMATCH`);
  return true;
}

/** Honest, non-overclaiming disclosure of what this mechanism does NOT provide. */
export function enforcementLimitations() {
  return Object.freeze([
    'UNBOUND_CODE_NOT_SEALED: this authorization/review mechanism is NOT part of S6 and is bound by no canonical seal; adding it to the bound set would invalidate Stage C.',
    'HASH_ATTESTED_NOT_SEALED: the issuer, the generator wrapper and the validator are pinned by SHA-256 in the review and the authorization, not sealed by Git.',
    'BARE_EXPORT_CALLABLE: the sealed generateOutcomeRun export remains technically callable directly, bypassing this wrapper.',
    'PROCEDURAL_ENFORCEMENT_ONLY: this is governance/procedural enforcement layered on a sealed scientific core, NOT a trusted execution environment.',
    'FILESYSTEM_AUTHORITY_ASSUMED: anyone with filesystem authority over this checkout can remove or replace local .evolve governance records.',
    'NO_SCIENTIFIC_RULE_ADDED: all scientific rules remain in the pre-existing sealed code; this mechanism adds no outcome science.',
  ]);
}

/**
 * Deterministic canonical run id. Derived ONLY from authorization/process
 * identity: the generation, the frozen approval/seal/continuation identities, the
 * canonical membership digest, the canonical reference-set digest and the
 * authorized `createdAt`. It contains NO market data, no price, no outcome and no
 * user-supplied descriptive name.
 */
export function deriveOutcomeRunId({ authorizationGeneration, scientificApprovalFingerprint: approvalFingerprint, runtimeSealFingerprint, continuationFingerprint, membershipDigest, referenceSetDigest: setDigest, createdAt }) {
  const precursor = digest({
    purpose: 'R4_OUTCOME_RUN_ID', authorizationGeneration,
    scientificApprovalFingerprint: approvalFingerprint, runtimeSealFingerprint, continuationFingerprint,
    canonicalMembershipDigest: membershipDigest, referenceSetDigest: setDigest, createdAt,
  });
  const runId = `r4-outcome-${pad4(assertAuthorizationGeneration(authorizationGeneration))}-${precursor.slice(0, 32)}`;
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(runId)) fail('R4_OUTCOME_AUTHORIZATION_RUN_ID_INVALID');
  return runId;
}

export function buildOutcomeAuthorization(input = {}) {
  const {
    authorizationGeneration, resolution, progress, canonicalMembership: membership,
    referenceCount, referenceSetDigest: setDigest, maturation, sourceIntegrity,
    createdAt, issuedAt, reviewFingerprint: reviewPrint, implementationHashes: hashes,
  } = input;
  const membershipPrint = canonicalMembershipDigest(membership);
  const runId = deriveOutcomeRunId({
    authorizationGeneration, scientificApprovalFingerprint: resolution.approvalFingerprint,
    runtimeSealFingerprint: resolution.seal.fingerprint, continuationFingerprint: resolution.continuationFingerprint,
    membershipDigest: membershipPrint, referenceSetDigest: setDigest, createdAt,
  });
  const content = {
    schemaVersion: R4_OUTCOME_AUTHORIZATION_SCHEMA_VERSION,
    recordType: R4_OUTCOME_AUTHORIZATION_RECORD_TYPE,
    status: R4_OUTCOME_AUTHORIZATION_STATUS,
    authorizationGeneration,
    scientificApprovalCommit: resolution.approvalCommit,
    scientificApprovalEpoch: resolution.approvalEpoch ?? null,
    scientificApprovalFingerprint: resolution.approvalFingerprint,
    runtimeSealCommit: resolution.authority.sealAuthorityCommit,
    runtimeSealFingerprint: resolution.seal.fingerprint,
    continuationCommit: resolution.continuationCommit,
    continuationFingerprint: resolution.continuationFingerprint,
    continuationGeneration: resolution.continuationGeneration,
    t0: resolution.t0,
    maxAttempts: R4_COHORT_SPEC.maxAttempts,
    targetCompletedSessions: R4_COHORT_SPEC.targetCompletedSessions,
    attemptsUsed: progress.attemptsUsed,
    completedCount: progress.completedCount,
    stop: progress.stop,
    blocked: progress.blocked,
    nextAttemptIndex: progress.nextAttemptIndex ?? null,
    canonicalMembership: [...membership],
    canonicalMembershipDigest: membershipPrint,
    referenceCount,
    referenceSetDigest: setDigest,
    outcomeArtifactsPresentAtIssuance: false,
    outcomeRootsInspected: [...R4_OUTCOME_RUN_ROOTS],
    maturationMode: R4_OUTCOME_AUTHORIZATION_MATURATION_MODE,
    maturationProofDigest: maturationProofDigest({ ...maturation, createdAt }),
    sourceIntegrityProofDigest: sourceIntegrityProofDigest(sourceIntegrity),
    runId, createdAt, createdAtIso: new Date(createdAt).toISOString(),
    outputRoot: R4_OUTCOME_AUTHORIZATION_OUTPUT_ROOT,
    sourcePolicy: canonical(R4_SOURCE_POLICY),
    implementationHashes: { ...hashes },
    reviewFingerprint: reviewPrint,
    issuedAt, issuedAtIso: new Date(issuedAt).toISOString(),
    enforcementLimitations: [...enforcementLimitations()],
  };
  return { ...content, fingerprint: authorizationFingerprint(content) };
}

/** Full structural + self-consistency + closed-schema validation. */
export function assertOutcomeAuthorization(record) {
  assertClosedSchema(record, R4_OUTCOME_AUTHORIZATION_FIELDS);
  if (record.schemaVersion !== R4_OUTCOME_AUTHORIZATION_SCHEMA_VERSION) fail('R4_OUTCOME_AUTHORIZATION_SCHEMA_INVALID');
  if (record.recordType !== R4_OUTCOME_AUTHORIZATION_RECORD_TYPE) fail('R4_OUTCOME_AUTHORIZATION_RECORD_TYPE_INVALID');
  if (record.status !== R4_OUTCOME_AUTHORIZATION_STATUS) fail('R4_OUTCOME_AUTHORIZATION_STATUS_INVALID');
  if (!Number.isInteger(record.authorizationGeneration) || record.authorizationGeneration < 1) fail('R4_OUTCOME_AUTHORIZATION_GENERATION_INVALID');
  if (!isSha(record.scientificApprovalCommit) || !Number.isInteger(record.scientificApprovalEpoch) || !isDigest(record.scientificApprovalFingerprint)) fail('R4_OUTCOME_AUTHORIZATION_A2_INVALID');
  if (!isSha(record.runtimeSealCommit) || !isDigest(record.runtimeSealFingerprint)) fail('R4_OUTCOME_AUTHORIZATION_S6_INVALID');
  if (!isSha(record.continuationCommit) || !isDigest(record.continuationFingerprint) || !Number.isInteger(record.continuationGeneration)) fail('R4_OUTCOME_AUTHORIZATION_C1_INVALID');
  if (!isStamp(record.t0)) fail('R4_OUTCOME_AUTHORIZATION_T0_INVALID');
  if (record.maxAttempts !== R4_COHORT_SPEC.maxAttempts || record.targetCompletedSessions !== R4_COHORT_SPEC.targetCompletedSessions) fail('R4_OUTCOME_AUTHORIZATION_BUDGET_DRIFT');
  assertCohortClosure(record);
  assertCanonicalMembership(record.canonicalMembership);
  if (record.canonicalMembershipDigest !== canonicalMembershipDigest(record.canonicalMembership)) fail('R4_OUTCOME_AUTHORIZATION_MEMBERSHIP_DIGEST_MISMATCH');
  assertReferenceIdentity(record);
  if (record.outcomeArtifactsPresentAtIssuance !== false) fail(R4_OUTCOME_AUTHORIZATION_FAILURE.artifacts);
  if (canonical(record.outcomeRootsInspected) !== canonical([...R4_OUTCOME_RUN_ROOTS])) fail('R4_OUTCOME_AUTHORIZATION_OUTCOME_ROOTS_MISMATCH');
  if (record.maturationMode !== R4_OUTCOME_AUTHORIZATION_MATURATION_MODE) fail('R4_OUTCOME_AUTHORIZATION_MATURATION_MODE_DRIFT');
  if (!isDigest(record.maturationProofDigest) || !isDigest(record.sourceIntegrityProofDigest)) fail('R4_OUTCOME_AUTHORIZATION_PROOF_INVALID');
  if (typeof record.runId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(record.runId)) fail('R4_OUTCOME_AUTHORIZATION_RUN_ID_INVALID');
  if (record.runId !== deriveOutcomeRunId({
    authorizationGeneration: record.authorizationGeneration, scientificApprovalFingerprint: record.scientificApprovalFingerprint,
    runtimeSealFingerprint: record.runtimeSealFingerprint, continuationFingerprint: record.continuationFingerprint,
    membershipDigest: record.canonicalMembershipDigest, referenceSetDigest: record.referenceSetDigest, createdAt: record.createdAt,
  })) fail('R4_OUTCOME_AUTHORIZATION_RUN_ID_NOT_DERIVED');
  if (!isStamp(record.createdAt) || record.createdAtIso !== new Date(record.createdAt).toISOString()) fail('R4_OUTCOME_AUTHORIZATION_CREATED_AT_INVALID');
  if (record.outputRoot !== R4_OUTCOME_AUTHORIZATION_OUTPUT_ROOT) fail('R4_OUTCOME_AUTHORIZATION_OUTPUT_ROOT_DRIFT');
  if (record.sourcePolicy !== canonical(R4_SOURCE_POLICY)) fail('R4_OUTCOME_AUTHORIZATION_SOURCE_POLICY_DRIFT');
  if (!isPlainObject(record.implementationHashes)) fail('R4_OUTCOME_AUTHORIZATION_IMPLEMENTATION_HASHES_MISSING');
  if (!isDigest(record.reviewFingerprint)) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:FINGERPRINT_MISSING`);
  if (!isStamp(record.issuedAt) || record.issuedAtIso !== new Date(record.issuedAt).toISOString()) fail('R4_OUTCOME_AUTHORIZATION_ISSUED_AT_INVALID');
  if (!Array.isArray(record.enforcementLimitations) || record.enforcementLimitations.length !== enforcementLimitations().length) fail('R4_OUTCOME_AUTHORIZATION_LIMITATIONS_MISSING');
  if (!isDigest(record.fingerprint) || authorizationFingerprint(record) !== record.fingerprint) fail('R4_OUTCOME_AUTHORIZATION_FINGERPRINT_MISMATCH');
  return true;
}

/* --------------------------------------------- canonical facts resolution */

/**
 * Resolve EVERY canonical fact internally, from Git and from authenticated
 * evidence on disk. Nothing here is caller-supplied: `cwd`/`evidenceRoot` are
 * concrete locations only, exactly as in `runCanonicalR4Analysis`.
 *
 * Read-only: it never writes, never generates an outcome and never inspects an
 * outcome value, price, disagreement, return, effect size or analysis result.
 */
export function resolveCanonicalOutcomeFacts({ cwd = R4_REPO_ROOT, evidenceRoot = null, resolveAuthority = resolveR4ExecutionAuthority } = {}) {
  const evidence = evidenceRoot ?? cwd;
  // 1. Sealed authority resolution (P -> S -> A -> C, live remote, worktree).
  const resolution = resolveAuthority({ cwd, requireApproval: true });
  // 2 + 3. Stage C, HEAD == C1, live origin/main == C1.
  assertStageC(resolution);
  const head = gitHead(cwd);
  const live = liveRemoteMainSha({ cwd });
  if (live?.available !== true) fail(R4_OUTCOME_AUTHORIZATION_FAILURE.remote);
  assertLiveAuthorityAtC1({ resolution, head, remoteSha: live.sha });
  const { seal, authority } = resolution;
  const approvalAuthority = Object.freeze({
    approvalCommit: resolution.approvalCommit, approvalEpoch: resolution.approvalEpoch ?? null,
    approvalFingerprint: resolution.approvalFingerprint, t0: resolution.t0,
  });
  const continuation = resolution.continuationContext ?? null;
  // 4 + 5. Authenticated attempt history, verified against the resolved authority.
  const verifiedHistory = verifyR4AttemptHistory(loadR4AttemptHistory({ cwd: evidence }), {
    seal, authority, approvalCommit: approvalAuthority.approvalCommit, approvalEpoch: approvalAuthority.approvalEpoch,
    approvalFingerprint: approvalAuthority.approvalFingerprint, t0: approvalAuthority.t0, continuation,
  });
  // 6 + 7. Canonical membership derived mechanically by the sealed governor.
  const plan = planSealedCohort({ seal, approvalAuthority });
  const attempts = historyToCohortAttempts(verifiedHistory);
  const attestations = historyAttestations(verifiedHistory);
  const attemptAuthorities = historyAttemptAuthorityIndex(verifiedHistory);
  const { canonicalMembership } = deriveCanonicalCohortMembership({ plan, attempts, seal, authority, attestations, approvalAuthority, continuation });
  assertCanonicalMembership(canonicalMembership);
  // The ONLY legal cohort terminal state (mechanical, from verified history).
  const progress = deriveNextAttempt(verifiedHistory);
  assertCohortClosure(progress);
  // 8 + 9 + 10. Authenticated canonical reference set, strict identity equality.
  const canonicalSet = buildCanonicalReferenceSetFromEvidence({
    seal, authority, approvalAuthority, canonicalMembership, attestations,
    sessionRoot: R4_SESSION_DIR_ROOT, cwd: evidence, attemptAuthorities, continuation,
  });
  assertReferenceIdentity({ referenceCount: canonicalSet.references.length, referenceSetDigest: canonicalSet.digest });
  // 11. Mechanical maturation deadline; `createdAt` is applied later from process time.
  const maturation = assertMaturation({ references: canonicalSet.references, sessions: canonicalSet.sessions, createdAt: Number.MAX_SAFE_INTEGER });
  // 12. Source integrity: every canonical member was reloaded from authenticated
  // evidence on disk and its seal-bound attestation verified above.
  const sourceIntegrity = { verified: canonicalSet.verified };
  // 13. ZERO existing outcome runs/artifacts.
  assertNoOutcomeArtifacts({ cwd: evidence });
  // The C1 authority time; the authorized `createdAt` must be strictly after it.
  const continuationAuthorityAt = gitCommitterTimestamp(resolution.continuationCommit, cwd);
  if (!isStamp(continuationAuthorityAt)) fail('R4_OUTCOME_AUTHORIZATION_C1_TIME_UNAVAILABLE');
  return Object.freeze({
    cwd, evidenceRoot: evidence, resolution, seal, authority, approvalAuthority, continuation,
    head, remoteSha: live.sha, progress, canonicalMembership, canonicalReferences: canonicalSet.references,
    canonicalSessions: canonicalSet.sessions,
    referenceCount: canonicalSet.references.length, referenceSetDigest: canonicalSet.digest,
    canonicalMembershipDigest: canonicalMembershipDigest(canonicalMembership),
    maturation, sourceIntegrity, continuationAuthorityAt,
  });
}

/**
 * Authorization-fixed review check. The review must be the already-imported
 * record for the SAME generation, must bind the exact authority identities and
 * the exact implementation hashes this process just measured, must have an
 * empty blocker list and the exact required verdict.
 */
export function assertReviewAuthorizesIssuance({ review, generation, facts, liveHashes }) {
  assertOutcomeAuthorizationReview(review);
  if (review.authorizationGeneration !== generation) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:GENERATION_MISMATCH`);
  if (review.scientificApprovalCommit !== facts.resolution.approvalCommit) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:A2_COMMIT`);
  if (review.scientificApprovalEpoch !== (facts.resolution.approvalEpoch ?? null)) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:A2_EPOCH`);
  if (review.scientificApprovalFingerprint !== facts.resolution.approvalFingerprint) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:A2_FINGERPRINT`);
  if (review.runtimeSealCommit !== facts.authority.sealAuthorityCommit) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:S6_COMMIT`);
  if (review.runtimeSealFingerprint !== facts.seal.fingerprint) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:S6_FINGERPRINT`);
  if (review.continuationCommit !== facts.resolution.continuationCommit) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:C1_COMMIT`);
  if (review.continuationFingerprint !== facts.resolution.continuationFingerprint) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:C1_FINGERPRINT`);
  if (review.continuationGeneration !== facts.resolution.continuationGeneration) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:C1_GENERATION`);
  if (review.t0 !== facts.resolution.t0) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:T0`);
  if (review.canonicalMembershipDigest !== facts.canonicalMembershipDigest) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:MEMBERSHIP_DIGEST`);
  if (review.referenceCount !== facts.referenceCount) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:REFERENCE_COUNT`);
  if (review.referenceSetDigest !== facts.referenceSetDigest) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:REFERENCE_SET`);
  assertImplementationHashes({ declared: review.implementationHashes, actual: liveHashes });
  return true;
}

/* ------------------------------------------- single-use consumption records */

/**
 * The exclusive claim (reservation) that consumes the authorization. Written
 * O_EXCL BEFORE generation starts, so a crash after claiming can never silently
 * reuse the same authorization: the claim's existence alone permanently blocks a
 * second generation under this authorization. The run is then ABANDONED /
 * CONSUMED-FAILED for governance purposes, and a retry requires a NEW numbered
 * authorization and review.
 */
export function buildOutcomeAuthorizationClaim({ generation, authorization, claimedAt }) {
  const content = {
    schemaVersion: R4_OUTCOME_AUTHORIZATION_CLAIM_SCHEMA_VERSION,
    recordType: R4_OUTCOME_AUTHORIZATION_CLAIM_RECORD_TYPE,
    status: 'CLAIMED',
    authorizationGeneration: assertAuthorizationGeneration(generation),
    authorizationFingerprint: authorization.fingerprint,
    runId: authorization.runId,
    outputRoot: authorization.outputRoot,
    claimedAt, claimedAtIso: new Date(claimedAt).toISOString(),
    abandonedRunIsNeverRetriedUnderThisAuthorization: true,
  };
  return { ...content, fingerprint: outcomeAuthorizationSidecarFingerprint(content) };
}

export function assertOutcomeAuthorizationClaim(record) {
  if (!isPlainObject(record)) fail('R4_OUTCOME_AUTHORIZATION_CLAIM_INVALID');
  if (record.schemaVersion !== R4_OUTCOME_AUTHORIZATION_CLAIM_SCHEMA_VERSION || record.recordType !== R4_OUTCOME_AUTHORIZATION_CLAIM_RECORD_TYPE) fail('R4_OUTCOME_AUTHORIZATION_CLAIM_INVALID');
  if (record.status !== 'CLAIMED') fail('R4_OUTCOME_AUTHORIZATION_CLAIM_INVALID');
  if (!isDigest(record.authorizationFingerprint) || typeof record.runId !== 'string') fail('R4_OUTCOME_AUTHORIZATION_CLAIM_INVALID');
  if (record.outputRoot !== R4_OUTCOME_AUTHORIZATION_OUTPUT_ROOT) fail('R4_OUTCOME_AUTHORIZATION_CLAIM_OUTPUT_ROOT_DRIFT');
  if (record.abandonedRunIsNeverRetriedUnderThisAuthorization !== true) fail('R4_OUTCOME_AUTHORIZATION_CLAIM_RETRY_POLICY_MISSING');
  if (!isDigest(record.fingerprint) || outcomeAuthorizationSidecarFingerprint(record) !== record.fingerprint) fail('R4_OUTCOME_AUTHORIZATION_CLAIM_FINGERPRINT_MISMATCH');
  return true;
}

/**
 * The finalized consumption record binding the authorization to the outcome run
 * it produced. It lives in the runtime governance directory and NEVER inside the
 * outcome-run directory, because `verifyOutcomeRun` requires that directory to
 * contain exactly manifest.json, outcomes.ndjson and summary.json.
 */
export function buildOutcomeAuthorizationConsumption({ generation, authorization, outcomeRun, consumedAt }) {
  const content = {
    schemaVersion: R4_OUTCOME_AUTHORIZATION_CONSUMPTION_SCHEMA_VERSION,
    recordType: R4_OUTCOME_AUTHORIZATION_CONSUMPTION_RECORD_TYPE,
    status: 'CONSUMED',
    authorizationGeneration: assertAuthorizationGeneration(generation),
    authorizationFingerprint: authorization.fingerprint,
    runId: authorization.runId,
    outputRoot: authorization.outputRoot,
    outcomeManifestFingerprint: outcomeRun.fingerprint,
    outcomeRunFingerprint: outcomeRun.fingerprint,
    consumedAt, consumedAtIso: new Date(consumedAt).toISOString(),
  };
  return { ...content, fingerprint: outcomeAuthorizationSidecarFingerprint(content) };
}

export function assertOutcomeAuthorizationConsumption(record) {
  if (!isPlainObject(record)) fail('R4_OUTCOME_AUTHORIZATION_CONSUMPTION_INVALID');
  if (record.schemaVersion !== R4_OUTCOME_AUTHORIZATION_CONSUMPTION_SCHEMA_VERSION || record.recordType !== R4_OUTCOME_AUTHORIZATION_CONSUMPTION_RECORD_TYPE) fail('R4_OUTCOME_AUTHORIZATION_CONSUMPTION_INVALID');
  if (record.status !== 'CONSUMED') fail('R4_OUTCOME_AUTHORIZATION_CONSUMPTION_INVALID');
  if (!isDigest(record.authorizationFingerprint) || typeof record.runId !== 'string') fail('R4_OUTCOME_AUTHORIZATION_CONSUMPTION_INVALID');
  if (record.outputRoot !== R4_OUTCOME_AUTHORIZATION_OUTPUT_ROOT) fail('R4_OUTCOME_AUTHORIZATION_CONSUMPTION_OUTPUT_ROOT_DRIFT');
  if (!isDigest(record.outcomeManifestFingerprint) || !isDigest(record.outcomeRunFingerprint)) fail('R4_OUTCOME_AUTHORIZATION_CONSUMPTION_OUTCOME_FINGERPRINT_MISSING');
  if (!isDigest(record.fingerprint) || outcomeAuthorizationSidecarFingerprint(record) !== record.fingerprint) fail('R4_OUTCOME_AUTHORIZATION_CONSUMPTION_FINGERPRINT_MISMATCH');
  return true;
}

/** Consumption state derived from the governance store alone. */
export function authorizationConsumptionState({ cwd = R4_REPO_ROOT, generation } = {}) {
  const claim = readOutcomeRecord(path.resolve(cwd, outcomeAuthorizationClaimPathForGeneration(generation)));
  const consumption = readOutcomeRecord(path.resolve(cwd, outcomeAuthorizationConsumptionPathForGeneration(generation)));
  if (consumption) assertOutcomeAuthorizationConsumption(consumption);
  if (claim) assertOutcomeAuthorizationClaim(claim);
  if (consumption) return 'CONSUMED';
  if (claim) return 'CLAIMED_ABANDONED';
  return 'UNCONSUMED';
}

/* ---------------------------------------------------------- review import */

/**
 * Import a GENUINE EXTERNAL review record into the runtime governance store,
 * write-once. The reviewer identity is NEVER fabricated here: the record must be
 * authored elsewhere and is only structurally validated and bound to the exact
 * authority identities this repository currently resolves.
 */
export function importOutcomeAuthorizationReview({ cwd = R4_REPO_ROOT, review, facts = null } = {}) {
  assertOutcomeAuthorizationReview(review);
  const resolved = facts ?? resolveCanonicalOutcomeFacts({ cwd });
  const generation = review.authorizationGeneration;
  assertReviewAuthorizesIssuance({ review, generation, facts: resolved, liveHashes: implementationHashes({ cwd }) });
  const written = writeOutcomeRecordOnce(path.resolve(cwd, outcomeAuthorizationReviewPathForGeneration(generation)), canonical(review) + '\n');
  return { generation, file: written.file, fingerprint: review.fingerprint };
}

/* ------------------------------------------------------------------- issue */

/**
 * Issue ONE outcome authorization. Accepts no session ids, membership, reference
 * list, reference count/digest, T0, A2/S6/C1 identity, outcome value, price,
 * effect size, expected resolved count, resolution rate, market condition or run
 * timing override: every canonical fact is resolved internally first.
 */
export function issueOutcomeAuthorization({ cwd = R4_REPO_ROOT, evidenceRoot = null, now = Date.now } = {}) {
  assertNoAuthorizationOverride({});
  // 14. A canonical authorization may never already exist at this generation.
  const generation = nextAuthorizationGeneration({ cwd });
  const target = path.resolve(cwd, outcomeAuthorizationPathForGeneration(generation));
  const reviewPath = path.resolve(cwd, outcomeAuthorizationReviewPathForGeneration(generation));
  // 1 - 13. Internal resolution of every canonical fact.
  const facts = resolveCanonicalOutcomeFacts({ cwd, evidenceRoot });
  const liveHashes = implementationHashes({ cwd });
  const review = readOutcomeRecord(reviewPath);
  if (!review) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:MISSING`);
  assertReviewAuthorizesIssuance({ review, generation, facts, liveHashes });
  // FIXED GENERATION INPUTS, authorized BEFORE generation. `createdAt` comes from
  // process time ONLY, after every maturation window is proven closed, and must be
  // strictly after the C1 authority time. Market state is never consulted.
  const createdAt = now();
  if (!isStamp(createdAt)) fail('R4_OUTCOME_AUTHORIZATION_CREATED_AT_INVALID');
  if (createdAt <= facts.continuationAuthorityAt) fail('R4_OUTCOME_AUTHORIZATION_CREATED_AT_NOT_AFTER_C1');
  if (createdAt < facts.maturation.latestDeadline) fail(R4_OUTCOME_AUTHORIZATION_FAILURE.maturation);
  const record = buildOutcomeAuthorization({
    authorizationGeneration: generation, resolution: facts.resolution, progress: facts.progress,
    canonicalMembership: facts.canonicalMembership, referenceCount: facts.referenceCount,
    referenceSetDigest: facts.referenceSetDigest, maturation: facts.maturation,
    sourceIntegrity: facts.sourceIntegrity, createdAt, issuedAt: createdAt,
    reviewFingerprint: review.fingerprint, implementationHashes: liveHashes,
  });
  assertOutcomeAuthorization(record);
  assertImplementationHashes({ declared: record.implementationHashes, actual: liveHashes });
  // WRITE-ONCE. Any pre-existing target (including a concurrent racer) fails.
  const written = writeOutcomeRecordOnce(target, canonical(record) + '\n');
  return { generation, record, file: written.file, reviewFingerprint: review.fingerprint };
}

/* ------------------------------------------------------------------ verify */

/**
 * Read-only, INDEPENDENT verification. Recomputes Stage C authority, HEAD and
 * live origin/main, the A2/S6/C1 identities, T0, cohort-history closure, canonical
 * membership, the reference count and digest, maturation, source integrity, the
 * record fingerprint, the review fingerprint and every implementation code hash.
 * It never generates an outcome and never writes anything.
 */
export function verifyOutcomeAuthorization({ cwd = R4_REPO_ROOT, evidenceRoot = null, generation = null } = {}) {
  const resolvedGeneration = generation ?? (existingAuthorizationGenerations({ cwd }).at(-1) ?? null);
  if (resolvedGeneration === null) fail('R4_OUTCOME_AUTHORIZATION_MISSING');
  const record = readOutcomeRecord(path.resolve(cwd, outcomeAuthorizationPathForGeneration(resolvedGeneration)));
  if (!record) fail('R4_OUTCOME_AUTHORIZATION_MISSING');
  assertOutcomeAuthorization(record);
  if (record.authorizationGeneration !== resolvedGeneration) fail('R4_OUTCOME_AUTHORIZATION_GENERATION_MISMATCH');
  const liveHashes = implementationHashes({ cwd });
  assertImplementationHashes({ declared: record.implementationHashes, actual: liveHashes });
  const review = readOutcomeRecord(path.resolve(cwd, outcomeAuthorizationReviewPathForGeneration(resolvedGeneration)));
  if (!review) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:MISSING`);
  assertOutcomeAuthorizationReview(review);
  if (review.fingerprint !== record.reviewFingerprint) fail(`${R4_OUTCOME_AUTHORIZATION_FAILURE.review}:FINGERPRINT_MISMATCH`);
  const facts = resolveCanonicalOutcomeFacts({ cwd, evidenceRoot });
  assertReviewAuthorizesIssuance({ review, generation: resolvedGeneration, facts, liveHashes });
  if (record.scientificApprovalCommit !== facts.resolution.approvalCommit
    || record.scientificApprovalEpoch !== (facts.resolution.approvalEpoch ?? null)
    || record.scientificApprovalFingerprint !== facts.resolution.approvalFingerprint) fail('R4_OUTCOME_AUTHORIZATION_A2_MISMATCH');
  if (record.runtimeSealCommit !== facts.authority.sealAuthorityCommit || record.runtimeSealFingerprint !== facts.seal.fingerprint) fail('R4_OUTCOME_AUTHORIZATION_S6_MISMATCH');
  if (record.continuationCommit !== facts.resolution.continuationCommit
    || record.continuationFingerprint !== facts.resolution.continuationFingerprint
    || record.continuationGeneration !== facts.resolution.continuationGeneration) fail('R4_OUTCOME_AUTHORIZATION_C1_MISMATCH');
  if (record.t0 !== facts.resolution.t0) fail('R4_OUTCOME_AUTHORIZATION_T0_MISMATCH');
  if (canonical(record.canonicalMembership) !== canonical(facts.canonicalMembership)
    || record.canonicalMembershipDigest !== facts.canonicalMembershipDigest) fail('R4_OUTCOME_AUTHORIZATION_MEMBERSHIP_MISMATCH');
  if (record.referenceCount !== facts.referenceCount || record.referenceSetDigest !== facts.referenceSetDigest) fail('R4_OUTCOME_AUTHORIZATION_REFERENCE_MISMATCH');
  if (record.attemptsUsed !== facts.progress.attemptsUsed || record.completedCount !== facts.progress.completedCount
    || record.stop !== facts.progress.stop || record.blocked !== facts.progress.blocked
    || (record.nextAttemptIndex ?? null) !== (facts.progress.nextAttemptIndex ?? null)) fail('R4_OUTCOME_AUTHORIZATION_CLOSURE_MISMATCH');
  const maturation = assertMaturation({ references: facts.canonicalReferences, sessions: facts.canonicalSessions, createdAt: record.createdAt });
  if (record.maturationProofDigest !== maturationProofDigest({ ...maturation, createdAt: record.createdAt })) fail('R4_OUTCOME_AUTHORIZATION_MATURATION_PROOF_MISMATCH');
  if (record.sourceIntegrityProofDigest !== sourceIntegrityProofDigest(facts.sourceIntegrity)) fail('R4_OUTCOME_AUTHORIZATION_SOURCE_INTEGRITY_MISMATCH');
  if (record.createdAt <= facts.continuationAuthorityAt) fail('R4_OUTCOME_AUTHORIZATION_CREATED_AT_NOT_AFTER_C1');
  return { generation: resolvedGeneration, record, review, facts, liveHashes, verified: true };
}

/* -------------------------------------------------------------------- CLI */

const USAGE = [
  'Usage:',
  '  node scripts/r4-outcome-authorization.mjs review <review.json>  import a genuine external review (write-once)',
  '  node scripts/r4-outcome-authorization.mjs issue                 issue one outcome authorization (write-once)',
  '  node scripts/r4-outcome-authorization.mjs verify                read-only independent verification',
  '',
  'No identity, timing, session, reference or scientific input is accepted on any command.',
].join('\n');

export async function main(argv = process.argv.slice(2), { cwd = R4_REPO_ROOT } = {}) {
  const [command, ...rest] = argv;
  if (command === 'review') {
    if (rest.length !== 1) { console.error(USAGE); return 2; }
    const review = readOutcomeRecord(path.resolve(cwd, rest[0]));
    if (!review) { console.error(`R4_OUTCOME_AUTHORIZATION_REVIEW_UNREADABLE:${rest[0]}`); return 1; }
    const result = importOutcomeAuthorizationReview({ cwd, review });
    console.log(JSON.stringify({ ok: true, command: 'review', ...result }, null, 2));
    return 0;
  }
  if (command === 'issue') {
    if (rest.length !== 0) { console.error(USAGE); return 2; }
    const result = issueOutcomeAuthorization({ cwd });
    console.log(JSON.stringify({
      ok: true, command: 'issue', generation: result.generation, file: result.file,
      recordFingerprint: result.record.fingerprint, runId: result.record.runId,
      createdAt: result.record.createdAt, outputRoot: result.record.outputRoot,
      implementationHashes: result.record.implementationHashes,
    }, null, 2));
    return 0;
  }
  if (command === 'verify') {
    if (rest.length !== 0) { console.error(USAGE); return 2; }
    const result = verifyOutcomeAuthorization({ cwd });
    console.log(JSON.stringify({
      ok: true, command: 'verify', verified: true, generation: result.generation,
      stage: result.facts.resolution.stage, head: result.facts.head, remoteMain: result.facts.remoteSha,
      scientificApprovalCommit: result.record.scientificApprovalCommit,
      scientificApprovalFingerprint: result.record.scientificApprovalFingerprint,
      runtimeSealCommit: result.record.runtimeSealCommit, runtimeSealFingerprint: result.record.runtimeSealFingerprint,
      continuationCommit: result.record.continuationCommit, continuationFingerprint: result.record.continuationFingerprint,
      t0: result.record.t0, attemptsUsed: result.record.attemptsUsed, completedCount: result.record.completedCount,
      stop: result.record.stop, blocked: result.record.blocked, nextAttemptIndex: result.record.nextAttemptIndex,
      canonicalMembershipDigest: result.record.canonicalMembershipDigest,
      referenceCount: result.record.referenceCount, referenceSetDigest: result.record.referenceSetDigest,
      maturationMode: result.record.maturationMode, runId: result.record.runId,
      recordFingerprint: result.record.fingerprint, reviewFingerprint: result.review.fingerprint,
      implementationHashes: result.liveHashes,
      consumptionState: authorizationConsumptionState({ cwd, generation: result.generation }),
    }, null, 2));
    return 0;
  }
  console.error(USAGE);
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(String(error?.message ?? error));
    process.exitCode = 1;
  });
}
