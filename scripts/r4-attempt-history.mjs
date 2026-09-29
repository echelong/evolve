// R4 canonical attempt history (enforcement only).
//
// Independent pre-capture review round 3 showed that a valid capability could
// be replayed (P1-1) and that attempts 2..8 could be authorized without any
// prior history (P1-2). This module is the SINGLE source of truth for attempt
// state and for the only legal next attempt:
//
//   loadR4AttemptHistory   strict read of the durable governance records
//   verifyR4AttemptHistory authenticate every record and every binding
//   deriveNextAttempt      the ONLY legal next attempt index (or a stop)
//
// Canonical per-attempt state machine (see `scripts/r4-capability.mjs`):
//
//   AUTHORIZED  attempt-N.json            immutable, O_EXCL, fsync'd
//   CLAIMED     attempt-N.claim.json      atomic single consumption, O_EXCL
//   COMPLETED | attempt-N.terminal.json   write-once terminal, O_EXCL
//   FAILED
//
// There is no CLAIMED -> AUTHORIZED transition, a terminal record can never be
// rewritten (COMPLETED <-> FAILED), and every authorization for attempt k >= 2
// binds the fingerprint of attempt k-1's terminal record, so the history is a
// hash chain: a missing, reordered or rewritten earlier record breaks it.
//
// Deterministic crash rule: an attempt that was CLAIMED but has no valid
// COMPLETED terminal record is a FAILED attempt for canonical cohort progress;
// an AUTHORIZED attempt that was never claimed is likewise FAILED
// (never-claimed). Neither can ever be reused. Because a claimed attempt may
// still be running, the NEXT attempt additionally requires an explicit terminal
// record for the previous one; after a runner crash that record is written only
// by the explicit, mechanical `recoverInterruptedAttempt` rule (always FAILED,
// never a reuse), after which D4 determines whether the next attempt may begin.
//
// No scientific value is chosen here. Ordering, not market state, determines
// eligibility: no clock rule for replacement attempts 2..8 exists in the frozen
// protocol, so none is invented; attempt 1 alone carries the frozen
// [T0, T0 + 5 min) start window.
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { digest, canonical } from './market-intelligence/definition.mjs';
import { R4_SPEC, captureSpecDigest } from './r4-protocol-spec.mjs';
import { isR4Excluded } from './r4-exclusions.mjs';
import {
  R4_REPO_ROOT, R4_ATTEMPT_AUTH_DIR, R4_ATTESTATION_DIR, R4_CLAIMANTS, attemptTerminalFile,
  assertAttemptAuthorization, assertAttemptClaim, assertClaimBindsAuthorization, claimAttemptAuthorization,
  readAttemptAuthorization, readAttemptClaim, writeDurableExclusive, deriveSessionId, R4_SESSION_RECEIPT_RECORD_TYPE,
} from './r4-capability.mjs';
import { R4_ATTESTATION_RECORD_TYPE, verifySessionAttestation } from './r4-attestation.mjs';

export const R4_ATTEMPT_TERMINAL_RECORD_TYPE = 'r4_attempt_terminal';
export const R4_TERMINAL_STATES = Object.freeze({ completed: 'COMPLETED', failed: 'FAILED' });
export const R4_ATTEMPT_STATES = Object.freeze({ authorized: 'AUTHORIZED', claimed: 'CLAIMED', completed: 'COMPLETED', failed: 'FAILED' });
/** Mechanical failure codes for nonterminal attempts in the canonical cohort view. */
export const R4_NONTERMINAL_FAILURE = Object.freeze({
  neverClaimed: 'R4_ATTEMPT_NEVER_CLAIMED',
  claimedWithoutTerminal: 'R4_ATTEMPT_CLAIMED_WITHOUT_TERMINAL',
  recoveredUnclaimed: 'R4_ATTEMPT_RECOVERED_UNCLAIMED',
  recoveredClaimed: 'R4_ATTEMPT_RECOVERED_CLAIMED_WITHOUT_TERMINAL',
});

const fail = code => { throw new Error(code); };
const isDigest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const isStamp = value => Number.isSafeInteger(value) && value >= 0;
const MAX_ATTEMPTS = R4_SPEC.cohort.maxAttempts;
const TARGET_COMPLETED = R4_SPEC.cohort.targetCompletedSessions;
const WINDOW_MS = R4_SPEC.cohort.attempt1StartWindowMs;

/* ------------------------------------------------------ terminal records */

export function assertAttemptTerminal(terminal) {
  if (!terminal || terminal.recordType !== R4_ATTEMPT_TERMINAL_RECORD_TYPE || terminal.schemaVersion !== 1) fail('R4_TERMINAL_RECORD_INVALID');
  const { fingerprint, ...content } = terminal;
  if (digest(content) !== fingerprint) fail('R4_TERMINAL_FINGERPRINT_MISMATCH');
  if (!Object.values(R4_TERMINAL_STATES).includes(terminal.state)) fail('R4_TERMINAL_STATE_INVALID');
  if (!isDigest(terminal.authorizationFingerprint) || !isDigest(terminal.claimFingerprint) || !isDigest(terminal.capabilityHash)) fail('R4_TERMINAL_RECORD_INVALID');
  if (!Number.isInteger(terminal.attemptIndex) || terminal.attemptIndex < 1 || !isStamp(terminal.terminatedAt)) fail('R4_TERMINAL_RECORD_INVALID');
  if (terminal.state === R4_TERMINAL_STATES.completed) {
    if (!isDigest(terminal.attestationFingerprint) || !isDigest(terminal.sessionFingerprint) || terminal.failureCode !== null) fail('R4_TERMINAL_STATE_INVALID');
  } else if (terminal.attestationFingerprint !== null || terminal.sessionFingerprint !== null
    || typeof terminal.failureCode !== 'string' || !/^[A-Z0-9_:]{1,120}$/.test(terminal.failureCode)) fail('R4_TERMINAL_STATE_INVALID');
  return true;
}

/**
 * Terminal transition CLAIMED -> COMPLETED | FAILED. Write-once: the record is
 * created with O_CREAT|O_EXCL and fsync'd, so a second terminal write for the
 * same attempt (in either direction) fails with `R4_ATTEMPT_TERMINAL_EXISTS`.
 * COMPLETED requires the capture-child claim and the finalized attestation that
 * binds that exact claim.
 */
export function writeAttemptTerminal({
  authorization, claim, state, attestation = null, failureCode = null, terminatedAt = Date.now(),
  root = R4_ATTEMPT_AUTH_DIR, cwd = R4_REPO_ROOT,
} = {}) {
  const file = path.join(path.resolve(cwd, root), attemptTerminalFile(authorization?.attemptIndex));
  // Write-once in either direction (COMPLETED <-> FAILED). The O_EXCL create
  // below is the actual guarantee; this early check only reports it first.
  if (existsSync(file)) fail('R4_ATTEMPT_TERMINAL_EXISTS');
  assertClaimBindsAuthorization(claim, authorization);
  const persistedAuthorization = readAttemptAuthorization({ attemptIndex: authorization.attemptIndex, root, cwd });
  const persistedClaim = readAttemptClaim({ attemptIndex: authorization.attemptIndex, root, cwd });
  if (!persistedAuthorization || canonical(persistedAuthorization) !== canonical(authorization)) fail('R4_TERMINAL_AUTHORIZATION_NOT_PERSISTED');
  if (!persistedClaim || canonical(persistedClaim) !== canonical(claim)) fail('R4_TERMINAL_CLAIM_NOT_PERSISTED');
  let attestationFingerprint = null;
  let sessionFingerprint = null;
  if (state === R4_TERMINAL_STATES.completed) {
    if (claim.claimant !== R4_CLAIMANTS.child) fail('R4_TERMINAL_COMPLETED_REQUIRES_CAPTURE_CHILD_CLAIM');
    if (!attestation || attestation.recordType !== R4_ATTESTATION_RECORD_TYPE || attestation.status !== 'FINALIZED') fail('R4_TERMINAL_COMPLETED_REQUIRES_ATTESTATION');
    const { fingerprint, ...content } = attestation;
    if (digest(content) !== fingerprint) fail('R4_TERMINAL_ATTESTATION_INVALID');
    if (attestation.claimFingerprint !== claim.fingerprint || attestation.authorizationFingerprint !== authorization.fingerprint
      || attestation.sessionId !== authorization.sessionId || attestation.attemptIndex !== authorization.attemptIndex) fail('R4_TERMINAL_ATTESTATION_MISMATCH');
    if (failureCode !== null) fail('R4_TERMINAL_STATE_INVALID');
    attestationFingerprint = attestation.fingerprint;
    sessionFingerprint = attestation.sessionFingerprint;
  } else if (state !== R4_TERMINAL_STATES.failed) fail('R4_TERMINAL_STATE_INVALID');
  const content = {
    schemaVersion: 1, recordType: R4_ATTEMPT_TERMINAL_RECORD_TYPE, state, attemptIndex: authorization.attemptIndex,
    sessionId: authorization.sessionId, authorizationFingerprint: authorization.fingerprint, claimFingerprint: claim.fingerprint,
    capabilityHash: authorization.capabilityHash, claimant: claim.claimant, attestationFingerprint, sessionFingerprint,
    failureCode: state === R4_TERMINAL_STATES.failed ? failureCode : null, terminatedAt,
  };
  const terminal = { ...content, fingerprint: digest(content) };
  assertAttemptTerminal(terminal);
  try { writeDurableExclusive(file, canonical(terminal) + '\n'); }
  catch (error) { if (error?.code === 'EEXIST') fail('R4_ATTEMPT_TERMINAL_EXISTS'); throw error; }
  return Object.freeze(terminal);
}

/* ------------------------------------------------------------- loading */

const NAME = Object.freeze({
  authorization: /^attempt-([1-9][0-9]*)\.json$/,
  claim: /^attempt-([1-9][0-9]*)\.claim\.json$/,
  terminal: /^attempt-([1-9][0-9]*)\.terminal\.json$/,
  receipt: /^receipt-([a-zA-Z0-9_-]{1,100})\.json$/,
  attestation: /^([a-zA-Z0-9_-]{1,100})\.json$/,
});

function readDirStrict(dir) {
  let names;
  try { names = readdirSync(dir).sort(); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  return names.map(name => {
    const file = path.join(dir, name);
    const info = lstatSync(file);
    if (!info.isFile()) return { name, file, regular: false, record: null };
    let record = null;
    try { record = JSON.parse(readFileSync(file, 'utf8')); } catch { record = undefined; }
    return { name, file, regular: true, record };
  });
}

/**
 * Strict read of the durable attempt governance records under an evidence root.
 * Reads only; never creates the directories. Every entry is classified; an
 * unknown, non-regular or unreadable entry is reported (and fails verification).
 */
export function loadR4AttemptHistory({ cwd = R4_REPO_ROOT, root = R4_ATTEMPT_AUTH_DIR, attestationRoot = R4_ATTESTATION_DIR } = {}) {
  const history = { cwd: path.resolve(cwd), authorizations: [], claims: [], terminals: [], receipts: [], attestations: [], unknown: [], unreadable: [] };
  for (const entry of readDirStrict(path.resolve(cwd, root)) ?? []) {
    if (!entry.regular) { history.unknown.push(entry.name); continue; }
    if (entry.record === undefined) { history.unreadable.push(entry.name); continue; }
    let match;
    if ((match = NAME.authorization.exec(entry.name))) history.authorizations.push({ name: entry.name, index: Number(match[1]), record: entry.record });
    else if ((match = NAME.claim.exec(entry.name))) history.claims.push({ name: entry.name, index: Number(match[1]), record: entry.record });
    else if ((match = NAME.terminal.exec(entry.name))) history.terminals.push({ name: entry.name, index: Number(match[1]), record: entry.record });
    else if ((match = NAME.receipt.exec(entry.name))) history.receipts.push({ name: entry.name, sessionId: match[1], record: entry.record });
    else history.unknown.push(entry.name);
  }
  for (const entry of readDirStrict(path.resolve(cwd, attestationRoot)) ?? []) {
    if (!entry.regular) { history.unknown.push(`attestations/${entry.name}`); continue; }
    if (entry.record === undefined) { history.unreadable.push(`attestations/${entry.name}`); continue; }
    const match = NAME.attestation.exec(entry.name);
    if (!match) { history.unknown.push(`attestations/${entry.name}`); continue; }
    history.attestations.push({ name: entry.name, sessionId: match[1], record: entry.record });
  }
  return history;
}

/* ------------------------------------------------------------ verification */

const guard = (fn, code) => { try { return fn(); } catch { return fail(code); } };

/**
 * Authenticate a loaded history against the INTERNALLY resolved execution
 * authority `{ seal, authority, approvalCommit, t0 }` (the A-stage output of
 * `resolveR4ExecutionAuthority`). Throws a stable `R4_HISTORY_*` code on any
 * anomaly; returns the per-attempt canonical view otherwise.
 */
export function verifyR4AttemptHistory(history, { seal, authority, approvalCommit, t0, approvalEpoch = null } = {}) {
  if (!history || !Array.isArray(history.authorizations)) fail('R4_HISTORY_INVALID');
  if (!seal || typeof seal.fingerprint !== 'string' || !authority || typeof authority.sealAuthorityCommit !== 'string') fail('R4_HISTORY_AUTHORITY_REQUIRED');
  if (typeof approvalCommit !== 'string' || !isStamp(t0)) fail('R4_HISTORY_AUTHORITY_REQUIRED');
  if (history.unknown.length) fail('R4_HISTORY_UNKNOWN_ARTIFACT');
  if (history.unreadable.length) fail('R4_HISTORY_RECORD_UNREADABLE');
  const expectedCaptureSpec = captureSpecDigest();

  // Authorizations ---------------------------------------------------------
  const byIndex = new Map();
  const seenHashes = new Set();
  const seenSessions = new Set();
  for (const { name, index, record } of history.authorizations) {
    guard(() => assertAttemptAuthorization(record), 'R4_HISTORY_RECORD_TAMPERED');
    if (record.attemptIndex !== index) fail('R4_HISTORY_RECORD_NAME_MISMATCH');
    if (byIndex.has(index) || seenHashes.has(record.capabilityHash) || seenSessions.has(record.sessionId)) fail('R4_HISTORY_DUPLICATE_AUTHORIZATION');
    if (index > MAX_ATTEMPTS) fail('R4_HISTORY_ATTEMPT_OUT_OF_RANGE');
    // Index continuity is checked as records are admitted, so a missing index is
    // reported as a gap before any later per-record binding rule.
    if (index !== byIndex.size + 1) fail('R4_HISTORY_INDEX_GAP');
    if (record.sealFingerprint !== seal.fingerprint || record.protocolCommit !== seal.protocolCommit
      || record.protocolTree !== seal.protocolTree || record.sealAuthorityCommit !== authority.sealAuthorityCommit
      || record.approvalCommit !== approvalCommit || record.t0 !== t0 || record.captureSpecDigest !== expectedCaptureSpec) fail('R4_HISTORY_AUTHORITY_MISMATCH');
    // Approval EPOCH binding is enforced whenever the resolved authority carries
    // one: a record authorized under a different approval epoch is refused.
    if (approvalEpoch !== null && (record.approvalEpoch ?? null) !== approvalEpoch) fail('R4_HISTORY_AUTHORITY_MISMATCH');
    if (record.sessionId !== deriveSessionId({ sealFingerprint: record.sealFingerprint, approvalCommit: record.approvalCommit,
      attemptIndex: record.attemptIndex, capabilityHash: record.capabilityHash })) fail('R4_HISTORY_IDENTITY_MISMATCH');
    if (isR4Excluded(record.sessionId)) fail('R4_HISTORY_EXCLUDED_SESSION');
    byIndex.set(index, { name, record });
    seenHashes.add(record.capabilityHash);
    seenSessions.add(record.sessionId);
  }
  const indexes = [...byIndex.keys()].sort((a, b) => a - b);
  indexes.forEach((index, i) => { if (index !== i + 1) fail('R4_HISTORY_INDEX_GAP'); });

  // Claims -----------------------------------------------------------------
  const claims = new Map();
  for (const { index, record } of history.claims) {
    guard(() => assertAttemptClaim(record), 'R4_HISTORY_RECORD_TAMPERED');
    if (record.attemptIndex !== index) fail('R4_HISTORY_RECORD_NAME_MISMATCH');
    if (claims.has(index)) fail('R4_HISTORY_DUPLICATE_CLAIM');
    const authorization = byIndex.get(index)?.record;
    if (!authorization) fail('R4_HISTORY_CLAIM_WITHOUT_AUTHORIZATION');
    guard(() => assertClaimBindsAuthorization(record, authorization), 'R4_HISTORY_IDENTITY_MISMATCH');
    if (record.claimant === R4_CLAIMANTS.child && index === 1 && (record.claimedAt < t0 || record.claimedAt >= t0 + WINDOW_MS)) fail('R4_HISTORY_ATTEMPT1_OUTSIDE_START_WINDOW');
    if (record.claimedAt < authorization.authorizedAt) fail('R4_HISTORY_OUT_OF_ORDER');
    claims.set(index, record);
  }

  // Attestations (bound to a claim, never free-standing) ---------------------
  const attestationsBySession = new Map();
  for (const { sessionId, record } of history.attestations) {
    if (!record || record.recordType !== R4_ATTESTATION_RECORD_TYPE) fail('R4_HISTORY_RECORD_TAMPERED');
    const { fingerprint, ...content } = record;
    if (digest(content) !== fingerprint) fail('R4_HISTORY_RECORD_TAMPERED');
    if (record.sessionId !== sessionId) fail('R4_HISTORY_RECORD_NAME_MISMATCH');
    if (attestationsBySession.has(sessionId)) fail('R4_HISTORY_DUPLICATE_ATTESTATION');
    const claim = claims.get(record.attemptIndex);
    if (!claim || claim.sessionId !== sessionId || claim.fingerprint !== record.claimFingerprint) fail('R4_HISTORY_ATTESTATION_WITHOUT_CLAIM');
    if (record.authorizationFingerprint !== claim.authorizationFingerprint || record.capabilityHash !== claim.capabilityHash) fail('R4_HISTORY_IDENTITY_MISMATCH');
    attestationsBySession.set(sessionId, record);
  }

  // Receipts (bound to a claim, never free-standing) -------------------------
  const receiptsBySession = new Map();
  for (const { sessionId, record } of history.receipts) {
    if (!record || record.recordType !== R4_SESSION_RECEIPT_RECORD_TYPE) fail('R4_HISTORY_RECORD_TAMPERED');
    const { fingerprint, ...content } = record;
    if (digest(content) !== fingerprint) fail('R4_HISTORY_RECORD_TAMPERED');
    if (record.sessionId !== sessionId) fail('R4_HISTORY_RECORD_NAME_MISMATCH');
    const claim = [...claims.values()].find(entry => entry.sessionId === sessionId);
    if (!claim || record.claimFingerprint !== claim.fingerprint) fail('R4_HISTORY_RECEIPT_WITHOUT_CLAIM');
    if (record.authorizationFingerprint !== claim.authorizationFingerprint || record.capabilityHash !== claim.capabilityHash) fail('R4_HISTORY_IDENTITY_MISMATCH');
    receiptsBySession.set(sessionId, record);
  }

  // Terminals ----------------------------------------------------------------
  const terminals = new Map();
  for (const { index, record } of history.terminals) {
    guard(() => assertAttemptTerminal(record), 'R4_HISTORY_RECORD_TAMPERED');
    if (record.attemptIndex !== index) fail('R4_HISTORY_RECORD_NAME_MISMATCH');
    if (terminals.has(index)) fail('R4_HISTORY_DUPLICATE_TERMINAL');
    const claim = claims.get(index);
    if (!claim) fail('R4_HISTORY_TERMINAL_WITHOUT_CLAIM');
    if (record.claimFingerprint !== claim.fingerprint || record.authorizationFingerprint !== claim.authorizationFingerprint
      || record.capabilityHash !== claim.capabilityHash || record.sessionId !== claim.sessionId || record.claimant !== claim.claimant) fail('R4_HISTORY_IDENTITY_MISMATCH');
    if (record.terminatedAt < claim.claimedAt) fail('R4_HISTORY_OUT_OF_ORDER');
    if (record.state === R4_TERMINAL_STATES.completed) {
      if (claim.claimant !== R4_CLAIMANTS.child) fail('R4_HISTORY_TERMINAL_STATE_INVALID');
      const attestation = attestationsBySession.get(claim.sessionId);
      if (!attestation || attestation.fingerprint !== record.attestationFingerprint || attestation.sessionFingerprint !== record.sessionFingerprint) fail('R4_HISTORY_TERMINAL_STATE_INVALID');
      guard(() => verifySessionAttestation({ attestation, session: { sessionId: claim.sessionId, fingerprint: attestation.sessionFingerprint },
        seal, authority, approvalAuthority: { approvalCommit, t0, approvalEpoch }, authorizationRecord: byIndex.get(index).record, claimRecord: claim,
        attemptIndex: index }), 'R4_HISTORY_TERMINAL_STATE_INVALID');
    }
    terminals.set(index, record);
  }

  // Canonical per-attempt view, hash chain, ordering and stop rule ----------
  const attempts = [];
  let completed = 0;
  for (const index of indexes) {
    const authorization = byIndex.get(index).record;
    const previous = attempts.at(-1) ?? null;
    if (index === 1) {
      if (authorization.previousTerminalFingerprint !== null) fail('R4_HISTORY_CHAIN_BROKEN');
      if (authorization.authorizedAt < t0 || authorization.authorizedAt >= t0 + WINDOW_MS) fail('R4_HISTORY_ATTEMPT1_OUTSIDE_START_WINDOW');
    } else {
      if (!previous?.terminal) fail('R4_HISTORY_OUT_OF_ORDER');
      if (authorization.previousTerminalFingerprint !== previous.terminal.fingerprint) fail('R4_HISTORY_CHAIN_BROKEN');
      if (authorization.authorizedAt < previous.terminal.terminatedAt) fail('R4_HISTORY_OUT_OF_ORDER');
    }
    if (completed >= TARGET_COMPLETED) fail('R4_HISTORY_ATTEMPT_AFTER_COHORT_STOPPED');
    const claim = claims.get(index) ?? null;
    const terminal = terminals.get(index) ?? null;
    const attestation = claim ? attestationsBySession.get(claim.sessionId) ?? null : null;
    const receipt = claim ? receiptsBySession.get(claim.sessionId) ?? null : null;
    let state;
    let cohortStatus;
    let failureCode = null;
    if (!claim) { state = R4_ATTEMPT_STATES.authorized; cohortStatus = 'FAILED'; failureCode = R4_NONTERMINAL_FAILURE.neverClaimed; }
    else if (!terminal) { state = R4_ATTEMPT_STATES.claimed; cohortStatus = 'FAILED'; failureCode = R4_NONTERMINAL_FAILURE.claimedWithoutTerminal; }
    else if (terminal.state === R4_TERMINAL_STATES.completed) { state = R4_ATTEMPT_STATES.completed; cohortStatus = 'COMPLETED'; completed += 1; }
    else { state = R4_ATTEMPT_STATES.failed; cohortStatus = 'FAILED'; failureCode = terminal.failureCode; }
    // `orphanAttestation`: an attestation written before a crash that prevented
    // its COMPLETED terminal. It is authenticated as bound to the claim but is
    // inert — it never contributes cohort membership or evidence.
    attempts.push(Object.freeze({ index, sessionId: authorization.sessionId, state, isTerminal: terminal !== null, cohortStatus, failureCode,
      authorization, claim, terminal, receipt,
      attestation: cohortStatus === 'COMPLETED' ? attestation : null,
      orphanAttestation: cohortStatus === 'COMPLETED' ? null : attestation }));
  }
  return Object.freeze({ attempts: Object.freeze(attempts), completedCount: completed, attemptsUsed: attempts.length,
    authority: Object.freeze({ sealFingerprint: seal.fingerprint, sealAuthorityCommit: authority.sealAuthorityCommit, approvalCommit, approvalEpoch, t0 }) });
}

/**
 * The ONLY legal next attempt, derived mechanically from verified history.
 * Nobody may skip an index or choose among alternatives: at most one index is
 * ever legal, and none while the previous attempt is not terminal, after six
 * completed sessions, or after attempt 8.
 */
export function deriveNextAttempt(verified) {
  if (!verified || !Array.isArray(verified.attempts)) fail('R4_HISTORY_NOT_VERIFIED');
  const last = verified.attempts.at(-1) ?? null;
  const base = { completedCount: verified.completedCount, attemptsUsed: verified.attemptsUsed };
  if (last && !last.isTerminal) return Object.freeze({ ...base, nextAttemptIndex: null, stop: false, blocked: true, reason: 'R4_PREVIOUS_ATTEMPT_NOT_TERMINAL', blockingAttempt: last.index, blockingState: last.state });
  if (verified.completedCount >= TARGET_COMPLETED) return Object.freeze({ ...base, nextAttemptIndex: null, stop: true, blocked: false, reason: 'R4_COHORT_STOPPED_TARGET_REACHED' });
  if (verified.attemptsUsed >= MAX_ATTEMPTS) return Object.freeze({ ...base, nextAttemptIndex: null, stop: true, blocked: false, reason: 'R4_COHORT_ATTEMPT_BUDGET_EXHAUSTED' });
  return Object.freeze({ ...base, nextAttemptIndex: verified.attemptsUsed + 1, stop: false, blocked: false, reason: null,
    previousTerminalFingerprint: last?.terminal?.fingerprint ?? null,
    replacementOf: last && last.cohortStatus === 'FAILED' ? last.index : null });
}

/**
 * Canonical cohort attempts for `evaluateSealedCohortProgress`: derived from
 * verified history only, never caller-authored. Nonterminal attempts are
 * mechanically FAILED here (never-claimed / claimed-without-terminal).
 */
export function historyToCohortAttempts(verified) {
  if (!verified || !Array.isArray(verified.attempts)) fail('R4_HISTORY_NOT_VERIFIED');
  return verified.attempts.map((attempt, i) => ({
    index: attempt.index, status: attempt.cohortStatus,
    sessionId: attempt.cohortStatus === 'COMPLETED' ? attempt.sessionId : null,
    failureCode: attempt.failureCode,
    replacementOf: i === 0 ? null : verified.attempts[i - 1].cohortStatus === 'FAILED' ? i : null,
    attestationFingerprint: attempt.attestation?.fingerprint ?? null,
  }));
}

/** Attestations of COMPLETED attempts only (the only ones that may carry evidence). */
export function historyAttestations(verified) {
  return verified.attempts.filter(attempt => attempt.cohortStatus === 'COMPLETED').map(attempt => attempt.attestation);
}

/**
 * Deterministic crash recovery (explicit, mechanical, never a reuse): the last
 * nonterminal attempt becomes FAILED. An AUTHORIZED attempt that no child
 * claimed is first consumed by an atomic RECOVERY claim (a racing child that
 * claims first wins, and the attempt is then terminalized as a claimed attempt
 * without terminal). Running this during a live capture aborts that attempt as
 * FAILED, exactly like interrupting it; it can never make any attempt reusable.
 */
export function recoverInterruptedAttempt({ verified, now = Date.now(), root = R4_ATTEMPT_AUTH_DIR, cwd = R4_REPO_ROOT } = {}) {
  const last = verified?.attempts?.at(-1) ?? null;
  if (!last || last.isTerminal) return { recovered: null };
  let claim = last.claim;
  let failureCode = R4_NONTERMINAL_FAILURE.recoveredClaimed;
  if (!claim) {
    try {
      claim = claimAttemptAuthorization({ record: last.authorization, claimant: R4_CLAIMANTS.recovery, now, root, cwd });
      failureCode = R4_NONTERMINAL_FAILURE.recoveredUnclaimed;
    } catch (error) {
      if (String(error?.message) !== 'R4_CAPABILITY_ALREADY_CLAIMED') throw error;
      claim = readAttemptClaim({ attemptIndex: last.index, root, cwd });
    }
  }
  const terminal = writeAttemptTerminal({ authorization: last.authorization, claim, state: R4_TERMINAL_STATES.failed, failureCode, terminatedAt: now, root, cwd });
  return { recovered: last.index, terminal };
}
