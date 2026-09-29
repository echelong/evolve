// R4 cohort governance plan — deterministic schema and governor.
//
// This module only *describes* the frozen cohort protocol and evaluates
// recorded attempt outcomes. It never starts an attempt, never captures, never
// reads market data and has no trading authority. T0 is derived mechanically
// from the preregistration seal commit time; it may never be moved because of
// market conditions.
import { isR4Excluded } from './r4-exclusions.mjs';

export const R4_COHORT_SPEC = Object.freeze({
  targetCompletedSessions: 6,
  maxAttempts: 8,
  durationMinutes: 45,
  captureMode: '--r4-revisits',
  captureCommand: 'node scripts/market-intelligence.mjs capture --r4-revisits --minutes 45',
  referenceRule: 'ALL_ELIGIBLE_REFERENCES',
  referenceRole: 'cohort',
  maturationMode: 'COHORT_DRAIN_ONLY',
  providers: Object.freeze({ jupiter: 'ENABLED', dexscreener: 'ENABLED', gmgn: 'DISABLED_NO_KEY', launchObserver: 'DISABLED_UNVERIFIED_TRANSPORT' }),
  drainBoundMs: 360_000,
  horizonMs: 300_000,
  toleranceMs: 60_000,
  // PRE-CAPTURE GOVERNANCE ENFORCEMENT AMENDMENT (round 2). Real cohort T0 is
  // derived from the pre-capture APPROVAL commit A, not from the seal commit S.
  // The scientific values above are unchanged; only the governance start anchor
  // became executable so no already-expired or hand-picked market window exists.
  t0Rule: 'FIRST_WHOLE_UTC_HOUR_AT_LEAST_30_MINUTES_AFTER_PRECAPTURE_APPROVAL_COMMIT_A',
  authorizationChain: 'P_S_A',
  t0TimestampSource: 'PRECAPTURE_APPROVAL_COMMIT_A_COMMITTER_TIMESTAMP',
  t0MinimumDelayMs: 1_800_000,
  attempt1StartWindowMs: 300_000,
  sessionParametersImmutable: true,
  discretionaryAttemptsPermitted: false,
  outcomeDependentExtensionPermitted: false,
  attemptStatuses: Object.freeze(['PLANNED', 'COMPLETED', 'FAILED']),
});

export const R4_B1_RULE = 'E1_REFERENCE_LEVEL_MISSINGNESS';
export const R4_PLAN_VERSION = 'R4-COHORT-V1';

/**
 * First whole UTC hour at least 30 minutes after an authority commit timestamp.
 * Mechanical only. Real cohort execution feeds it the committer timestamp of the
 * pre-capture approval commit A; synthetic governance fixtures may feed any
 * timestamp. It never consults market state, prices or outcomes.
 */
export function mechanicalT0(authorityCommittedAtMs) {
  if (!Number.isSafeInteger(authorityCommittedAtMs) || authorityCommittedAtMs < 0) throw new Error('T0_INPUT_INVALID');
  return Math.ceil((authorityCommittedAtMs + R4_COHORT_SPEC.t0MinimumDelayMs) / 3_600_000) * 3_600_000;
}

/** Every attempt uses exactly these frozen session parameters — no variation. */
export function sessionParameters() {
  return Object.freeze({ durationMinutes: R4_COHORT_SPEC.durationMinutes, captureMode: R4_COHORT_SPEC.captureMode,
    command: R4_COHORT_SPEC.captureCommand, providers: R4_COHORT_SPEC.providers, referenceRule: R4_COHORT_SPEC.referenceRule });
}

/**
 * SYNTHETIC helper: build a plan from an explicit anchor timestamp. Canonical
 * real-R4 execution must use `buildAuthorizedCohortPlan`, which derives T0 only
 * from the verified pre-capture approval commit A.
 */
export function buildCohortPlan({ sealFingerprint, preregistrationDigest, sealCommittedAt, approvalCommit = null, approvalEpoch = null, t0 = null }) {
  if (typeof sealFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(sealFingerprint)) throw new Error('PLAN_SEAL_INVALID');
  if (typeof preregistrationDigest !== 'string' || !/^[0-9a-f]{64}$/.test(preregistrationDigest)) throw new Error('PLAN_PREREGISTRATION_INVALID');
  const resolvedT0 = t0 ?? mechanicalT0(sealCommittedAt);
  return {
    schemaVersion: 1, recordType: 'r4_cohort_plan', planVersion: R4_PLAN_VERSION, b1Rule: R4_B1_RULE,
    sealFingerprint, preregistrationDigest, spec: R4_COHORT_SPEC,
    t0: resolvedT0, t0Iso: new Date(resolvedT0).toISOString(), sealCommittedAt: sealCommittedAt ?? null,
    authorizationChain: R4_COHORT_SPEC.authorizationChain, approvalCommit: approvalCommit ?? null, approvalEpoch: approvalEpoch ?? null,
    attempts: Array.from({ length: R4_COHORT_SPEC.maxAttempts }, (_, i) => ({ index: i + 1, status: 'PLANNED', sessionId: null, failureCode: null, replacementOf: null })),
  };
}

/**
 * CANONICAL plan builder. T0 is taken ONLY from the verified approval authority
 * (the committer timestamp of A). No caller-supplied time is accepted, and the
 * seal's own commit time is NOT used for real execution.
 */
export function buildAuthorizedCohortPlan({ seal, approvalAuthority }) {
  if (!seal || typeof seal.fingerprint !== 'string') throw new Error('PLAN_SEAL_INVALID');
  if (!approvalAuthority || !Number.isSafeInteger(approvalAuthority.t0)) throw new Error('PLAN_APPROVAL_AUTHORITY_INVALID');
  return buildCohortPlan({ sealFingerprint: seal.fingerprint, preregistrationDigest: seal.preregistration.sha256,
    t0: approvalAuthority.t0, approvalCommit: approvalAuthority.approvalCommit,
    approvalEpoch: approvalAuthority.approvalEpoch ?? null });
}

/**
 * Evaluate recorded attempts. Replacement linkage is mechanical: attempt k>1 is
 * a replacement (replacementOf = k-1) exactly when attempt k-1 failed.
 * A discretionary extra attempt beyond maxAttempts is rejected.
 *
 * Hardened by the independent pre-capture review (enforcement only — no
 * scientific value changes):
 *   * an excluded methods-only session id can never join the cohort;
 *   * a duplicate session id can never join twice;
 *   * once `targetCompletedSessions` completed sessions exist, no later attempt
 *     may be COMPLETED (the cohort is stopped);
 *   * attempt indexes are exactly 1..maxAttempts with no gaps.
 *
 * This low-level governor validates structure and membership. The authenticated
 * real-R4 governor in `scripts/r4-enforcement.mjs` additionally requires each
 * completed attempt to carry a seal-bound session attestation.
 */
export function evaluateCohortProgress(plan, attempts) {
  if (!plan || plan.recordType !== 'r4_cohort_plan') throw new Error('PLAN_INVALID');
  if (!Array.isArray(attempts)) throw new Error('ATTEMPTS_INVALID');
  if (attempts.length > plan.spec.maxAttempts) throw new Error('ATTEMPT_BUDGET_EXCEEDED');
  let completedSoFar = 0;
  const seenSessions = new Set();
  for (const [i, attempt] of attempts.entries()) {
    if (attempt.index !== i + 1) throw new Error('ATTEMPT_INDEX_INVALID');
    if (!plan.spec.attemptStatuses.includes(attempt.status)) throw new Error('ATTEMPT_STATUS_INVALID');
    if (attempt.status === 'COMPLETED') {
      if (typeof attempt.sessionId !== 'string' || !attempt.sessionId) throw new Error('ATTEMPT_SESSION_REQUIRED');
      if (isR4Excluded(attempt.sessionId)) throw new Error('R4_EXCLUDED_SESSION');
      if (seenSessions.has(attempt.sessionId)) throw new Error('ATTEMPT_DUPLICATE_SESSION');
      if (completedSoFar >= plan.spec.targetCompletedSessions) throw new Error('COHORT_ALREADY_STOPPED');
      seenSessions.add(attempt.sessionId);
      completedSoFar += 1;
    }
    if (attempt.status === 'FAILED' && !attempt.failureCode) throw new Error('ATTEMPT_FAILURE_CODE_REQUIRED');
    const expectedReplacement = i === 0 ? null : attempts[i - 1].status === 'FAILED' ? i : null;
    if ((attempt.replacementOf ?? null) !== expectedReplacement) throw new Error('ATTEMPT_REPLACEMENT_LINKAGE_INVALID');
  }
  const membership = attempts.filter(attempt => attempt.status === 'COMPLETED').map(attempt => attempt.sessionId);
  const cohortComplete = membership.length >= plan.spec.targetCompletedSessions;
  const exhausted = attempts.length >= plan.spec.maxAttempts;
  return { stop: cohortComplete || exhausted, cohortComplete, completedCount: membership.length, attemptsUsed: attempts.length,
    remainingAttempts: plan.spec.maxAttempts - attempts.length, membership, distinctSessions: true,
    shortfall: !cohortComplete && exhausted, discretionaryAttemptsPermitted: false, outcomeDependentExtensionPermitted: false };
}
