#!/usr/bin/env node
// R4 missed-window approval-epoch validator (MISSED ATTEMPT-1 WINDOW GOVERNANCE
// AMENDMENT, enforcement only).
//
// Positive path: a single canonical epoch-1 approval resolves exactly; a valid
// renewal epoch (with its independent reauthorization review) resolves as the
// LATEST epoch, derives its own mechanical T0 from its own committer timestamp
// and authorizes execution; a third epoch chains from the second.
//
// Negative path: every rejected renewal, fork, edit, skip, wrong predecessor,
// wrong protocol/seal, missing/wrong review, artifact-present renewal, remote
// mismatch and HEAD mismatch fails closed, and no CLI option can select a T0 or
// an approval epoch.
//
// Historical/current-chain proof: the REAL A1 remains immutable with its exact
// mechanical T0 and no A2 in A1's own tree; the tracked A2 is then recovered as
// epoch 2. Runtime attempt artifacts are deliberately irrelevant to structural
// approval-chain resolution after A2, while prospective renewal eligibility
// remains zero-artifact-gated by the dedicated tests above.
//
// Read-only with respect to evidence: synthetic chains live in fresh `mkdtemp`
// repositories that are removed again; nothing under this repository's `.evolve`
// is created, moved or removed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical } from './market-intelligence/definition.mjs';
import { buildSeal } from './r4-preregistration-seal.mjs';
import { R4_TRACKED_SEAL_PATH } from './r4-protocol-spec.mjs';
import { syntheticAuthorityRepo, commitAll, removeTree } from './r4-synthetic-authority.mjs';
import {
  R4_APPROVAL_PATH, R4_ATTEMPT1_WINDOW_MS, approvalT0, resolveR4ExecutionAuthority,
} from './r4-approval.mjs';
import {
  R4_APPROVAL_EPOCHS_DIR, R4_APPROVAL_EPOCH_FORBIDDEN_OPTION_KEYS, R4_RENEWAL_VERDICT,
  approvalPathForEpoch, renewalReviewPathForEpoch, approvalGovernancePathsForEpoch, buildRenewalApprovalRecord,
  buildRenewalReviewRecord, renewalReviewFingerprint, reviewerIdentityFromRenewalReview, reviewerIdentityFromApproval,
  assertNoRealR4AttemptArtifacts, listRealR4AttemptArtifacts, evaluateRenewalEligibility,
  assertRenewalEligible, resolveApprovalEpochChain, resolveLatestApprovalEpoch,
} from './r4-approval-epochs.mjs';
import { R4_ATTEMPT_AUTH_DIR, R4_ATTESTATION_DIR } from './r4-capability.mjs';
import { parseRunnerArgs } from './r4-cohort-run.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const A1_SHA = '9ae21e0a976a4f7ba363e04fa370eef23fd713af';
const A2_SHA = '9dc30de45ee0fc8c493c2582bae6378dae1fdc7b';
const S3_SHA = 'a0be84c55aba60ee7fdbc3c5eaecc3acb64bac25';
const A1_SEAL_FINGERPRINT = 'e788601471c4631e8752ee3611a29c6ced8b59e0d1516efa6dea1eb0def2da46';
const A1_T0 = Date.UTC(2026, 8, 29, 6, 0, 0); // 2026-09-29T06:00:00Z
// The REAL historical A1 reviewer identity, read from the A1 commit itself, so the
// same-reviewer+same-model negative fixture is bound to history rather than to a
// hand-copied string. Epoch 1 stores `reviewer` / `reviewerModel`.
const REAL_A1_APPROVAL = JSON.parse(
  spawnSync('git', ['show', `${A1_SHA}:${R4_APPROVAL_PATH}`], { cwd: REPO, encoding: 'utf8' }).stdout,
);
const REAL_A1_REVIEWER = REAL_A1_APPROVAL.reviewer;
const REAL_A1_REVIEWER_MODEL = REAL_A1_APPROVAL.reviewerModel;
const SYNTHETIC_A1_ISO = '2026-09-28T10:10:00Z';
const A2_ISO = '2026-09-28T12:00:00Z';
const CLEANUP = [];

let failed = 0;
let executed = 0;
const failures = [];

// The executed-case total is COUNTED, never declared. Every `test(...)` call —
// including the ones a `for` loop expands — increments `executed`, so the report
// can never disagree with what actually ran.
function test(name, fn) {
  executed++;
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failed++; failures.push(name); console.error(`FAIL ${name}: ${String(e?.message ?? e).split('\n')[0]}`); }
}

const codeOf = fn => { try { fn(); return null; } catch (e) { return String(e?.message ?? e); } };
function throwsCode(name, fn, prefix) {
  const code = codeOf(fn);
  assert(code !== null, `${name}: expected ${prefix}, but nothing was thrown`);
  assert(code.startsWith(prefix), `${name}: expected ${prefix}, got ${code}`);
}
const gitText = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout.trim();

/* --------------------------------------------------------- epoch fixture */

/**
 * Build a synthetic approval-epoch repository on top of the canonical synthetic
 * P/S/A fixture. `reseal` inserts an enforcement re-seal (P4 -> S4) between A1
 * and A2, exactly like the real amendment does. Every epoch-2 field can be
 * mutated to model one rejection case.
 */
function buildEpochRepo(options = {}) {
  const { reseal = true, a2 = {}, a3 = {}, addA3 = false, a2Iso = A2_ISO, artifacts = [], duplicateA2 = false,
    editA1 = false, headAfterA2 = false, intermediate = false, remoteMain = 'A2', a1Identity = null } = options;
  const fixture = syntheticAuthorityRepo({ remoteMain: 'A',
    ...(a1Identity ? { approvalReviewer: a1Identity.reviewer, approvalReviewerModel: a1Identity.model } : {}) });
  CLEANUP.push(fixture.root);
  const { dir, run } = fixture;
  const state = { dir, run, fixture, a1: fixture.approvalCommit, s3: fixture.sealCommit, p3: fixture.protocolCommit,
    seal1: fixture.seal, approval1: fixture.approval, remoteDir: fixture.remoteDir };
  const a1Timestamp = Date.parse(SYNTHETIC_A1_ISO);
  state.t0_1 = approvalT0(a1Timestamp);
  state.windowEnd_1 = state.t0_1 + R4_ATTEMPT1_WINDOW_MS;

  if (reseal) {
    writeFileSync(path.join(dir, 'governance/r4/EPOCH-ENFORCEMENT.txt'), 'epoch enforcement re-seal\n');
    state.p4 = commitAll(run, 'P4: approval-epoch enforcement', '2026-09-28T11:30:00Z');
    const load = file => readFileSync(path.join(dir, file));
    state.seal4 = buildSeal({ baseSha: state.p4, baseTree: run(['rev-parse', `${state.p4}^{tree}`]),
      sealedAt: Date.parse('2026-09-28T11:35:00Z'), load });
    writeFileSync(path.join(dir, R4_TRACKED_SEAL_PATH), canonical(state.seal4) + '\n');
    state.s4 = commitAll(run, 'S4: approval-epoch seal', '2026-09-28T11:35:00Z');
  }
  const currentSealCommit = reseal ? state.s4 : state.s3;
  const currentSeal = reseal ? state.seal4 : state.seal1;
  state.sealCommit = currentSealCommit;
  state.seal = currentSeal;

  for (const artifact of artifacts) writeArtifact(dir, artifact);

  const o = a2;
  // `reviewExtraFields` and `reviewOmit` model schema-shaped negatives: a review
  // that supplies `reviewerModel` / `reauthorizationReviewerModel` INSTEAD of the
  // schema field `model`, or that omits `reviewer` / `model` entirely.
  const builtReview = buildRenewalReviewRecord({
    reviewer: o.reviewer ?? 'renewal-independent-reviewer',
    model: o.model ?? 'renewal-review-model',
    protocolCommit: currentSeal.protocolCommit, sealCommit: currentSealCommit, sealFingerprint: currentSeal.fingerprint,
    previousApprovalCommit: state.a1, previousApprovalFingerprint: state.approval1.fingerprint,
    verdict: o.reviewVerdict ?? R4_RENEWAL_VERDICT,
    reviewedAt: o.reviewedAt ?? Date.parse('2026-09-28T11:40:00Z'),
  });
  let review = builtReview;
  if (o.reviewMutate || o.reviewOmit?.length || o.reviewExtraFields) {
    const content = { ...builtReview };
    delete content.fingerprint;
    for (const field of o.reviewOmit ?? []) delete content[field];
    Object.assign(content, o.reviewExtraFields ?? {});
    // Re-seal so the modelled defect is the ONLY anomaly under test.
    review = { ...content, fingerprint: renewalReviewFingerprint(content) };
  }
  const approval = buildRenewalApprovalRecord({
    approvalEpoch: o.approvalEpoch ?? 2,
    protocolCommit: o.protocolCommit ?? currentSeal.protocolCommit,
    sealCommit: o.approvalSealCommit === 'PREVIOUS' ? state.s3 : (o.approvalSealCommit ?? currentSealCommit),
    sealFingerprint: o.approvalSealFingerprint ?? currentSeal.fingerprint,
    previousApprovalCommit: o.previousApprovalCommit ?? state.a1,
    previousApprovalFingerprint: o.previousApprovalFingerprint ?? state.approval1.fingerprint,
    previousT0: o.previousT0 ?? state.t0_1,
    previousWindowEnd: o.previousWindowEnd ?? state.windowEnd_1,
    reauthorizationReviewDigest: o.reviewDigest ?? review.fingerprint,
    reauthorizationReviewer: o.reviewer ?? review.reviewer,
    reauthorizationReviewerModel: o.model ?? review.model,
  });
  state.a2Record = approval;
  state.a2Review = review;

  if (intermediate) {
    writeFileSync(path.join(dir, 'governance/r4/INTERMEDIATE.txt'), 'unrelated intermediate commit\n');
    state.intermediate = commitAll(run, 'X: intermediate', '2026-09-28T11:45:00Z');
  }
  const writeEpoch2 = () => {
    writeEpochFile(dir, approvalPathForEpoch(2), approval);
    if (o.reviewMissing !== true) writeEpochFile(dir, renewalReviewPathForEpoch(2), review);
    return commitAll(run, 'A2: renewal approval', a2Iso);
  };
  state.a2 = writeEpoch2();
  if (duplicateA2) {
    writeEpochFile(dir, approvalPathForEpoch(2), { ...approval, approvedAt: 1 });
    state.a2Duplicate = commitAll(run, 'A2: rewritten renewal approval', '2026-09-28T12:05:00Z');
  }
  if (editA1) {
    writeEpochFile(dir, R4_APPROVAL_PATH, { ...fixture.approval, approvedAt: 2 });
    state.a1Edit = commitAll(run, 'A1: edited historical approval', '2026-09-28T12:10:00Z');
  }
  if (addA3) {
    const t0_2 = approvalT0(Date.parse(a2Iso));
    const windowEnd_2 = t0_2 + R4_ATTEMPT1_WINDOW_MS;
    const review3 = buildRenewalReviewRecord({
      reviewer: a3.reviewer ?? 'third-independent-reviewer', model: a3.model ?? 'third-review-model',
      protocolCommit: currentSeal.protocolCommit, sealCommit: currentSealCommit, sealFingerprint: currentSeal.fingerprint,
      previousApprovalCommit: state.a2, previousApprovalFingerprint: approval.fingerprint,
      reviewedAt: windowEnd_2 + 60_000,
    });
    const approval3 = buildRenewalApprovalRecord({
      approvalEpoch: 3, protocolCommit: currentSeal.protocolCommit, sealCommit: currentSealCommit,
      sealFingerprint: currentSeal.fingerprint, previousApprovalCommit: state.a2,
      previousApprovalFingerprint: approval.fingerprint, previousT0: t0_2, previousWindowEnd: windowEnd_2,
      reauthorizationReviewDigest: review3.fingerprint, reauthorizationReviewer: review3.reviewer,
      reauthorizationReviewerModel: review3.model,
    });
    writeEpochFile(dir, approvalPathForEpoch(3), approval3);
    writeEpochFile(dir, renewalReviewPathForEpoch(3), review3);
    state.a3Iso = new Date(windowEnd_2 + 120_000).toISOString().replace('.000Z', 'Z');
    state.a3 = commitAll(run, 'A3: second renewal approval', state.a3Iso);
    state.a3Record = approval3;
  }
  if (headAfterA2) {
    writeFileSync(path.join(dir, 'governance/r4/HEAD-NOTE.txt'), 'head moved after the latest approval\n');
    state.headAfter = commitAll(run, 'X: head moved after approval', '2026-09-28T12:20:00Z');
  }
  const remoteSha = remoteMain === 'A2' ? state.a2 : remoteMain === 'A1' ? state.a1 : remoteMain === 'S3' ? state.s3
    : remoteMain === 'S4' ? state.s4 : remoteMain === 'A3' ? state.a3 : state.a2;
  run(['push', '-q', '--force', state.remoteDir, `${remoteSha}:refs/heads/main`]);
  state.remoteSha = remoteSha;
  return state;
}

function writeEpochFile(dir, file, record) {
  const target = path.join(dir, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, canonical(record) + '\n');
}

function writeArtifact(dir, kind) {
  if (kind === 'authorization') {
    mkdirSync(path.join(dir, R4_ATTEMPT_AUTH_DIR), { recursive: true });
    writeFileSync(path.join(dir, R4_ATTEMPT_AUTH_DIR, 'attempt-1.json'), '{"recordType":"r4_attempt_authorization"}\n');
  } else if (kind === 'claim') {
    mkdirSync(path.join(dir, R4_ATTEMPT_AUTH_DIR), { recursive: true });
    writeFileSync(path.join(dir, R4_ATTEMPT_AUTH_DIR, 'attempt-1.claim.json'), '{"recordType":"r4_attempt_claim"}\n');
  } else if (kind === 'session') {
    mkdirSync(path.join(dir, '.evolve/market-intelligence/sessions/r4-cohort-probe'), { recursive: true });
  } else if (kind === 'outcome') {
    mkdirSync(path.join(dir, '.evolve/market-outcomes/run-probe'), { recursive: true });
    writeFileSync(path.join(dir, '.evolve/market-outcomes/run-probe/manifest.json'), '{"recordType":"outcome_manifest"}\n');
  } else if (kind === 'attestation') {
    mkdirSync(path.join(dir, R4_ATTESTATION_DIR), { recursive: true });
    writeFileSync(path.join(dir, R4_ATTESTATION_DIR, 'r4-probe.json'), '{}\n');
  } else { throw new Error(`unknown artifact ${kind}`); }
}

/* ===================== 1-2: epoch 1 and renewal eligibility ===================== */

test('1: a valid epoch-1 approval resolves as epoch 1', () => {
  const fixture = syntheticAuthorityRepo({ remoteMain: 'A' });
  CLEANUP.push(fixture.root);
  const { chain, latest } = resolveApprovalEpochChain({ cwd: fixture.dir, verifySealBinding: true });
  assert.equal(chain.length, 1);
  assert.equal(latest.epoch, 1);
  assert.equal(latest.commit, fixture.approvalCommit);
  assert.equal(latest.path, R4_APPROVAL_PATH);
  assert.equal(latest.t0, approvalT0(Date.parse(SYNTHETIC_A1_ISO)));
  assert.equal(latest.fingerprint, fixture.approval.fingerprint);
  assert.equal(latest.sealCommit, fixture.sealCommit);
  const resolution = resolveR4ExecutionAuthority({ cwd: fixture.dir, requireApproval: true });
  assert.equal(resolution.approvalEpoch, 1);
  assert.equal(resolution.approvalCommit, fixture.approvalCommit);
  assert.equal(resolution.t0, approvalT0(Date.parse(SYNTHETIC_A1_ISO)));
});

test('2: an expired epoch-1 window with zero attempt artifacts is renewal eligible', () => {
  const fixture = syntheticAuthorityRepo({ remoteMain: 'A' });
  CLEANUP.push(fixture.root);
  const { latest } = resolveLatestApprovalEpoch({ cwd: fixture.dir });
  const eligibility = evaluateRenewalEligibility({ previousEpoch: latest, latestEpoch: latest,
    now: Date.parse('2026-09-28T12:00:00Z'), cwd: fixture.dir });
  assert.equal(eligibility.eligible, true);
  assert.equal(eligibility.requiredVerdict, R4_RENEWAL_VERDICT);
  assert.equal(assertRenewalEligible({ previousEpoch: latest, latestEpoch: latest,
    now: Date.parse('2026-09-28T12:00:00Z'), cwd: fixture.dir }).eligible, true);
});

/* ===================== 3: renewal before the window end ===================== */

test('3: an epoch-1 renewal committed before the previous window ends is rejected', () => {
  const state = buildEpochRepo({ a2Iso: '2026-09-28T11:02:00Z' });
  throwsCode('renewal before window end', () => resolveApprovalEpochChain({ cwd: state.dir }),
    'R4_APPROVAL_EPOCH_RENEWAL_BEFORE_WINDOW_END');
});

/* ===================== 4-7: attempt/session/outcome artifacts ===================== */

for (const [index, kind] of [[4, 'authorization'], [5, 'claim'], [6, 'session'], [7, 'outcome']]) {
  test(`${index}: an existing ${kind} artifact forbids approval renewal`, () => {
    const fixture = syntheticAuthorityRepo({ remoteMain: 'A' });
    CLEANUP.push(fixture.root);
    writeArtifact(fixture.dir, kind);
    const { latest } = resolveLatestApprovalEpoch({ cwd: fixture.dir });
    const artifacts = listRealR4AttemptArtifacts({ cwd: fixture.dir });
    assert(artifacts.length > 0, `expected a detected ${kind} artifact`);
    throwsCode(`${kind} artifact`, () => assertNoRealR4AttemptArtifacts({ cwd: fixture.dir }),
      'R4_APPROVAL_EPOCH_ATTEMPT_ARTIFACTS_PRESENT');
    const eligibility = evaluateRenewalEligibility({ previousEpoch: latest, latestEpoch: latest,
      now: Date.parse('2026-09-28T12:00:00Z'), cwd: fixture.dir });
    assert.equal(eligibility.eligible, false);
    assert.equal(eligibility.reason, 'R4_APPROVAL_EPOCH_ATTEMPT_ARTIFACTS_PRESENT');
  });
}

test('4b: a session attestation also forbids renewal', () => {
  const fixture = syntheticAuthorityRepo({ remoteMain: 'A' });
  CLEANUP.push(fixture.root);
  writeArtifact(fixture.dir, 'attestation');
  const { latest } = resolveLatestApprovalEpoch({ cwd: fixture.dir });
  const eligibility = evaluateRenewalEligibility({ previousEpoch: latest, latestEpoch: latest,
    now: Date.parse('2026-09-28T12:00:00Z'), cwd: fixture.dir });
  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.reason, 'R4_APPROVAL_EPOCH_ATTEMPT_ARTIFACTS_PRESENT');
});

test('7b: legitimate post-A2 attempt artifacts do not invalidate the immutable approval chain', () => {
  const state = buildEpochRepo({});
  writeArtifact(state.dir, 'authorization');
  const { chain, latest } = resolveApprovalEpochChain({ cwd: state.dir, verifySealBinding: true });
  assert.equal(chain.length, 2);
  assert.equal(latest.epoch, 2);
  assert.equal(latest.commit, state.a2);
});

/* ===================== 8-13: renewal chain binding rules ===================== */

test('8: an epoch-2 approval whose parent is neither the seal commit nor the previous approval is rejected', () => {
  const state = buildEpochRepo({ intermediate: true });
  assert.equal(gitText(state.dir, ['rev-parse', `${state.a2}^`]), state.intermediate);
  throwsCode('wrong parent', () => resolveApprovalEpochChain({ cwd: state.dir }),
    'R4_APPROVAL_APPROVAL_COMMIT_NOT_FOUND');
});

test('8b: a same-generation renewal (parent == previous approval) resolves as epoch 2', () => {
  const state = buildEpochRepo({ reseal: false });
  assert.equal(gitText(state.dir, ['rev-parse', `${state.a2}^`]), state.a1);
  const { chain, latest } = resolveApprovalEpochChain({ cwd: state.dir, verifySealBinding: true });
  assert.equal(chain.length, 2);
  assert.equal(latest.epoch, 2);
  assert.equal(latest.sealCommit, state.s3);
  const resolution = resolveR4ExecutionAuthority({ cwd: state.dir, requireApproval: true });
  assert.equal(resolution.approvalEpoch, 2);
  assert.equal(resolution.approvalCommit, state.a2);
});

test('9: an epoch-2 approval with the wrong previous fingerprint is rejected', () => {
  const state = buildEpochRepo({ a2: { previousApprovalFingerprint: '0'.repeat(64) } });
  throwsCode('wrong previous fingerprint', () => resolveApprovalEpochChain({ cwd: state.dir }),
    'R4_APPROVAL_EPOCH_PREVIOUS_FINGERPRINT_MISMATCH');
});

test('10: an epoch-2 approval declaring a skipped epoch number is rejected', () => {
  const state = buildEpochRepo({ a2: { approvalEpoch: 3 } });
  throwsCode('skipped epoch', () => resolveApprovalEpochChain({ cwd: state.dir }), 'R4_APPROVAL_EPOCH_NUMBER_INVALID');
});

test('11: an epoch-2 approval binding the wrong protocol commit is rejected', () => {
  const wrongP = buildEpochRepo({ a2: { protocolCommit: '0'.repeat(40) } });
  throwsCode('wrong protocol commit', () => resolveApprovalEpochChain({ cwd: wrongP.dir }),
    'R4_APPROVAL_EPOCH_AUTHORITY_INVALID');
});

test('12: an epoch-2 approval binding the wrong seal commit is rejected', () => {
  const wrongS = buildEpochRepo({ a2: { approvalSealCommit: 'PREVIOUS' } });
  throwsCode('wrong seal commit', () => resolveApprovalEpochChain({ cwd: wrongS.dir }),
    'R4_APPROVAL_EPOCH_AUTHORITY_INVALID');
  // The unmutated resealed chain does resolve.
  const valid = buildEpochRepo({});
  assert.equal(resolveApprovalEpochChain({ cwd: valid.dir }).latest.epoch, 2);
});

test('13: an epoch-2 approval binding the wrong seal fingerprint is rejected', () => {
  const state = buildEpochRepo({ a2: { approvalSealFingerprint: '0'.repeat(64) } });
  throwsCode('wrong seal fingerprint', () => resolveApprovalEpochChain({ cwd: state.dir }),
    'R4_APPROVAL_EPOCH_SEAL_MISMATCH');
});

/* ===================== 14-16: independent reauthorization review ===================== */

test('14: an epoch-2 approval without an independent renewal review is rejected', () => {
  const state = buildEpochRepo({ a2: { reviewMissing: true } });
  throwsCode('missing renewal review', () => resolveApprovalEpochChain({ cwd: state.dir }),
    'R4_APPROVAL_EPOCH_RENEWAL_REVIEW_MISSING');
});

test('15: an epoch-2 approval with a wrong renewal-review digest is rejected', () => {
  const state = buildEpochRepo({ a2: { reviewDigest: 'f'.repeat(64) } });
  throwsCode('wrong review digest', () => resolveApprovalEpochChain({ cwd: state.dir }),
    'R4_APPROVAL_EPOCH_RENEWAL_REVIEW_DIGEST_MISMATCH');
});

test('16: an epoch-2 approval with a wrong renewal verdict is rejected', () => {
  const state = buildEpochRepo({ a2: { reviewVerdict: 'CHANGES_REQUIRED' } });
  const code = codeOf(() => resolveApprovalEpochChain({ cwd: state.dir }));
  assert(code !== null && /R4_RENEWAL_REVIEW_VERDICT_INVALID|R4_APPROVAL_EPOCH_RENEWAL_VERDICT/.test(code),
    `expected a verdict rejection, got ${code}`);
});

/* ===== 16a-16k: reviewer INDEPENDENCE is the canonical (reviewer, model) pair ===== */

test('16a: a renewal review reusing the REAL A1 reviewer AND model is rejected', () => {
  // The predecessor is a synthetic A1 carrying the REAL historical A1 identity,
  // and the renewal review repeats that EXACT pair. This is the regression for
  // the P1 defect: the review schema stores `model`, so the previous guard read an
  // empty model segment and could never fire.
  const state = buildEpochRepo({
    a1Identity: { reviewer: REAL_A1_REVIEWER, model: REAL_A1_REVIEWER_MODEL },
    a2: { reviewer: REAL_A1_REVIEWER, model: REAL_A1_REVIEWER_MODEL },
  });
  assert.equal(JSON.parse(gitText(state.dir, ['show', `${state.a1}:${R4_APPROVAL_PATH}`])).reviewer, REAL_A1_REVIEWER);
  throwsCode('real A1 identity reused', () => resolveApprovalEpochChain({ cwd: state.dir }),
    'R4_APPROVAL_EPOCH_RENEWAL_REVIEWER_NOT_INDEPENDENT');
  // ...and with the seal/proof control: a DISTINCT pair on the same fixture shape
  // is accepted, so the rejection above is the identity rule and nothing else.
  const control = buildEpochRepo({
    a1Identity: { reviewer: REAL_A1_REVIEWER, model: REAL_A1_REVIEWER_MODEL },
    a2: { reviewer: 'a-different-independent-reviewer', model: REAL_A1_REVIEWER_MODEL },
  });
  assert.equal(resolveApprovalEpochChain({ cwd: control.dir }).latest.epoch, 2);
});

test('16b: A — the exact same reviewer AND the exact same model is rejected', () => {
  const state = buildEpochRepo({ a1Identity: { reviewer: 'shared-reviewer', model: 'shared-model' },
    a2: { reviewer: 'shared-reviewer', model: 'shared-model' } });
  throwsCode('identical pair', () => resolveApprovalEpochChain({ cwd: state.dir }),
    'R4_APPROVAL_EPOCH_RENEWAL_REVIEWER_NOT_INDEPENDENT');
});

test('16c: B — the same reviewer with a DIFFERENT model is a distinct pair and is accepted', () => {
  const state = buildEpochRepo({ a1Identity: { reviewer: 'shared-reviewer', model: 'model-one' },
    a2: { reviewer: 'shared-reviewer', model: 'model-two' } });
  assert.equal(resolveApprovalEpochChain({ cwd: state.dir }).latest.epoch, 2);
});

test('16d: C — a DIFFERENT reviewer with the exact same model is a distinct pair and is accepted', () => {
  const state = buildEpochRepo({ a1Identity: { reviewer: 'reviewer-one', model: 'shared-model' },
    a2: { reviewer: 'reviewer-two', model: 'shared-model' } });
  assert.equal(resolveApprovalEpochChain({ cwd: state.dir }).latest.epoch, 2);
});

test('16e: D — a different reviewer AND a different model is accepted when otherwise valid', () => {
  const state = buildEpochRepo({ a1Identity: { reviewer: 'reviewer-one', model: 'model-one' },
    a2: { reviewer: 'reviewer-two', model: 'model-two' } });
  assert.equal(resolveApprovalEpochChain({ cwd: state.dir }).latest.epoch, 2);
});

test('16f: E — a renewal review with a MISSING reviewer is a schema rejection', () => {
  // The approval record stays well-formed (`reauthorizationReviewer` pinned), so
  // the ONLY anomaly under test is the review's missing `reviewer`.
  const state = buildEpochRepo({ a2: { reviewer: 'pin-reviewer', model: 'pin-model', reviewOmit: ['reviewer'] } });
  const onDisk = JSON.parse(gitText(state.dir, ['show', `${state.a2}:${renewalReviewPathForEpoch(2)}`]));
  assert.equal(onDisk.reviewer, undefined, 'the schema field really is absent');
  assert.equal(onDisk.reauthorizationReviewer, undefined, 'the approval-shaped field is not a review fallback');
  throwsCode('missing reviewer', () => resolveApprovalEpochChain({ cwd: state.dir }), 'R4_RENEWAL_REVIEW_REVIEWER_INVALID');
  throwsCode('missing reviewer (identity helper)', () => reviewerIdentityFromRenewalReview(onDisk), 'R4_RENEWAL_REVIEW_REVIEWER_INVALID');
});

test('16g: F — a renewal review with a MISSING model is a schema rejection', () => {
  const state = buildEpochRepo({ a2: { reviewer: 'pin-reviewer', model: 'pin-model', reviewOmit: ['model'] } });
  const onDisk = JSON.parse(gitText(state.dir, ['show', `${state.a2}:${renewalReviewPathForEpoch(2)}`]));
  assert.equal(onDisk.model, undefined);
  throwsCode('missing model', () => resolveApprovalEpochChain({ cwd: state.dir }), 'R4_RENEWAL_REVIEW_MODEL_INVALID');
  throwsCode('missing model (identity helper)', () => reviewerIdentityFromRenewalReview(onDisk), 'R4_RENEWAL_REVIEW_MODEL_INVALID');
});

test('16h: G — a renewal review with an EMPTY reviewer is a schema rejection', () => {
  const state = buildEpochRepo({ a2: { reviewer: 'pin-reviewer', model: 'pin-model', reviewExtraFields: { reviewer: '' } } });
  throwsCode('empty reviewer', () => resolveApprovalEpochChain({ cwd: state.dir }), 'R4_RENEWAL_REVIEW_REVIEWER_INVALID');
  throwsCode('empty reviewer (identity helper)', () => reviewerIdentityFromRenewalReview(state.a2Review), 'R4_RENEWAL_REVIEW_REVIEWER_INVALID');
});

test('16i: H — a renewal review with an EMPTY model is a schema rejection', () => {
  const state = buildEpochRepo({ a2: { reviewer: 'pin-reviewer', model: 'pin-model', reviewExtraFields: { model: '   ' } } });
  throwsCode('empty model', () => resolveApprovalEpochChain({ cwd: state.dir }), 'R4_RENEWAL_REVIEW_MODEL_INVALID');
  throwsCode('empty model (identity helper)', () => reviewerIdentityFromRenewalReview(state.a2Review), 'R4_RENEWAL_REVIEW_MODEL_INVALID');
});

test('16j: I — `reviewerModel` instead of the schema field `model` does NOT bypass the review schema', () => {
  const state = buildEpochRepo({ a2: { reviewer: 'pin-reviewer', model: 'pin-model',
    reviewOmit: ['model'], reviewExtraFields: { reviewerModel: 'bypass-model' } } });
  const onDisk = JSON.parse(gitText(state.dir, ['show', `${state.a2}:${renewalReviewPathForEpoch(2)}`]));
  assert.equal(onDisk.reviewerModel, 'bypass-model', 'the misleading field really is present');
  assert.equal(onDisk.model, undefined, 'the schema field really is absent');
  throwsCode('reviewerModel instead of model', () => resolveApprovalEpochChain({ cwd: state.dir }), 'R4_RENEWAL_REVIEW_MODEL_INVALID');
  throwsCode('reviewerModel is not an identity', () => reviewerIdentityFromRenewalReview(onDisk), 'R4_RENEWAL_REVIEW_MODEL_INVALID');
});

test('16k: J — `reauthorizationReviewerModel` instead of `model` does NOT bypass the review schema', () => {
  const state = buildEpochRepo({ a2: { reviewer: 'pin-reviewer', model: 'pin-model',
    reviewOmit: ['model'], reviewExtraFields: { reauthorizationReviewerModel: 'bypass-model' } } });
  const onDisk = JSON.parse(gitText(state.dir, ['show', `${state.a2}:${renewalReviewPathForEpoch(2)}`]));
  assert.equal(onDisk.reauthorizationReviewerModel, 'bypass-model');
  assert.equal(onDisk.model, undefined);
  throwsCode('reauthorizationReviewerModel instead of model', () => resolveApprovalEpochChain({ cwd: state.dir }), 'R4_RENEWAL_REVIEW_MODEL_INVALID');
  throwsCode('reauthorizationReviewerModel is not an identity', () => reviewerIdentityFromRenewalReview(onDisk), 'R4_RENEWAL_REVIEW_MODEL_INVALID');
});

test('16l: K — epoch 3 compares against A2 `reauthorizationReviewer{,Model}`, not A1', () => {
  // Reusing A1's identity at epoch 3 is fine: the rule is against the IMMEDIATE
  // predecessor, not against all of history.
  const againstA1 = buildEpochRepo({ a1Identity: { reviewer: 'first-reviewer', model: 'first-model' },
    a2: { reviewer: 'second-reviewer', model: 'second-model' },
    a3: { reviewer: 'first-reviewer', model: 'first-model' }, addA3: true });
  assert.equal(resolveApprovalEpochChain({ cwd: againstA1.dir }).latest.epoch, 3);
  // Reusing A2's reauthorization identity at epoch 3 is NOT independent.
  const againstA2 = buildEpochRepo({ a1Identity: { reviewer: 'first-reviewer', model: 'first-model' },
    a2: { reviewer: 'second-reviewer', model: 'second-model' },
    a3: { reviewer: 'second-reviewer', model: 'second-model' }, addA3: true });
  throwsCode('A2 identity reused at A3', () => resolveApprovalEpochChain({ cwd: againstA2.dir }),
    'R4_APPROVAL_EPOCH_RENEWAL_REVIEWER_NOT_INDEPENDENT');
  // The compared pair is exactly A2's reauthorization identity, and the epoch-1
  // and renewal-approvals extract through their OWN schema fields.
  assert.equal(reviewerIdentityFromApproval(againstA2.a2Record).key,
    `second-reviewer\u0000second-model`);
  assert.equal(reviewerIdentityFromApproval(againstA2.a3Record).key, 'second-reviewer\u0000second-model');
  assert.equal(reviewerIdentityFromApproval(againstA1.a3Record).key, 'first-reviewer\u0000first-model');
});

test('16m: the real A1 extracts its identity from the epoch-1 schema fields', () => {
  assert.equal(REAL_A1_REVIEWER, 'Buffy (Freebuff independent adversarial reviewer)');
  assert.equal(REAL_A1_REVIEWER_MODEL, 'deepseek/deepseek-v4-flash');
  assert.equal(reviewerIdentityFromApproval(REAL_A1_APPROVAL).key, `${REAL_A1_REVIEWER}\u0000${REAL_A1_REVIEWER_MODEL}`);
  // A renewal-review record exposes the same pair through `model`.
  const asReview = buildRenewalReviewRecord({ reviewer: REAL_A1_REVIEWER, model: REAL_A1_REVIEWER_MODEL,
    protocolCommit: REAL_A1_APPROVAL.protocolCommit, sealCommit: REAL_A1_APPROVAL.sealCommit,
    sealFingerprint: REAL_A1_APPROVAL.sealFingerprint, previousApprovalCommit: REAL_A1_APPROVAL.sealCommit,
    previousApprovalFingerprint: REAL_A1_APPROVAL.fingerprint, reviewedAt: A1_T0 });
  assert.equal(reviewerIdentityFromRenewalReview(asReview).key, `${REAL_A1_REVIEWER}\u0000${REAL_A1_REVIEWER_MODEL}`);
});

/* ===================== 17-18: only the latest epoch authorizes; its own T0 ===================== */

test('17: the old A1 cannot authorize once A2 exists', () => {
  const state = buildEpochRepo({ remoteMain: 'A2' });
  const resolution = resolveR4ExecutionAuthority({ cwd: state.dir, requireApproval: true });
  assert.equal(resolution.approvalEpoch, 2);
  assert.equal(resolution.approvalCommit, state.a2);
  assert.notEqual(resolution.approvalCommit, state.a1);
  // The live remote still pointing at A1 cannot be used to execute A1's expired
  // window: the LIVE remote main must equal the LATEST approval.
  state.run(['push', '-q', '--force', state.remoteDir, `${state.a1}:refs/heads/main`]);
  throwsCode('A1 remote', () => resolveR4ExecutionAuthority({ cwd: state.dir, requireApproval: true }),
    'R4_AUTHORITY_REMOTE_MAIN_MISMATCH:APPROVAL_COMMIT_A');
});

test('18: the epoch-2 T0 is derived from the epoch-2 committer timestamp', () => {
  const state = buildEpochRepo({ a2Iso: A2_ISO });
  const { latest } = resolveLatestApprovalEpoch({ cwd: state.dir });
  assert.equal(latest.epoch, 2);
  assert.equal(latest.t0, Date.UTC(2026, 8, 28, 13, 0, 0)); // 12:00Z + 30min -> 13:00Z
  assert.equal(latest.committerTimestamp, Date.parse(A2_ISO));
  const resolution = resolveR4ExecutionAuthority({ cwd: state.dir, requireApproval: true });
  assert.equal(resolution.t0, Date.UTC(2026, 8, 28, 13, 0, 0));
});

/* ===================== 19-20: anti-hand-picking ===================== */

test('19: a caller T0 override is rejected', () => {
  for (const forbidden of ['--t0', '--window', '--date', '--hour', '--offset']) {
    throwsCode(`forbidden ${forbidden}`, () => parseRunnerArgs(['capture', '--execute', forbidden, '123']),
      'R4_RUNNER_ARGUMENT_UNSUPPORTED');
  }
});

test('20: a caller approval-epoch override is rejected', () => {
  for (const forbidden of ['--epoch', '--approval-epoch', '--approvalEpoch']) {
    throwsCode(`forbidden ${forbidden}`, () => parseRunnerArgs(['capture', '--execute', forbidden, '1']),
      'R4_RUNNER_ARGUMENT_UNSUPPORTED');
  }
  assert(R4_APPROVAL_EPOCH_FORBIDDEN_OPTION_KEYS.includes('t0'));
  throwsCode('resolver override', () => resolveLatestApprovalEpoch({ cwd: REPO, t0: 0 }),
    'R4_APPROVAL_EPOCH_OVERRIDE_FORBIDDEN');
});

/* ===================== 21-23: chaining, forks, edits ===================== */

test('21: a third epoch correctly chains from the second', () => {
  const state = buildEpochRepo({ addA3: true });
  const { chain, latest } = resolveLatestApprovalEpoch({ cwd: state.dir, verifySealBinding: true });
  assert.equal(chain.length, 3);
  assert.equal(latest.epoch, 3);
  assert.equal(latest.commit, state.a3);
  assert.equal(latest.record.previousApprovalCommit, state.a2);
  assert.equal(latest.record.previousApprovalFingerprint, state.a2Record.fingerprint);
  assert.equal(latest.t0, approvalT0(Date.parse(state.a3Iso)));
});

test('22: an approval fork (the same epoch artifact introduced twice) is rejected', () => {
  const state = buildEpochRepo({ duplicateA2: true });
  throwsCode('approval fork', () => resolveApprovalEpochChain({ cwd: state.dir }),
    'R4_APPROVAL_EPOCH_HISTORY_MODIFIED');
});

test('23: editing an older approval artifact is rejected', () => {
  const state = buildEpochRepo({ editA1: true });
  throwsCode('edited A1', () => resolveApprovalEpochChain({ cwd: state.dir }),
    'R4_APPROVAL_EPOCH_HISTORY_MODIFIED');
});

/* ===================== 24-25: latest approval remote / HEAD ===================== */

test('24: a latest approval that is not the live remote main is rejected', () => {
  const state = buildEpochRepo({ remoteMain: 'S4' });
  throwsCode('remote behind', () => resolveR4ExecutionAuthority({ cwd: state.dir, requireApproval: true }),
    'R4_AUTHORITY_REMOTE_MAIN_MISMATCH:APPROVAL_COMMIT_A');
});

test('25: a latest approval that is not HEAD is rejected', () => {
  const state = buildEpochRepo({ headAfterA2: true, remoteMain: 'A2' });
  assert.equal(gitText(state.dir, ['rev-parse', 'HEAD']), state.headAfter);
  assert.equal(resolveLatestApprovalEpoch({ cwd: state.dir }).latest.epoch, 2);
  throwsCode('HEAD after A2', () => resolveR4ExecutionAuthority({ cwd: state.dir, requireApproval: true }),
    'R4_APPROVAL_HEAD_NOT_APPROVAL_COMMIT');
});

/* ===================== positive renewal + mechanics ===================== */

test('a valid resealed renewal authorizes execution with its own epoch and T0', () => {
  const state = buildEpochRepo({});
  const resolution = resolveR4ExecutionAuthority({ cwd: state.dir, requireApproval: true });
  assert.equal(resolution.stage, 'A');
  assert.equal(resolution.approvalEpoch, 2);
  assert.equal(resolution.approvalFingerprint, state.a2Record.fingerprint);
  assert.equal(resolution.approvalCommit, state.a2);
  assert.equal(resolution.remoteSha, state.a2);
  assert.equal(resolution.t0, approvalT0(Date.parse(A2_ISO)));
  assert.deepEqual(approvalGovernancePathsForEpoch(2), [approvalPathForEpoch(2), renewalReviewPathForEpoch(2)].sort());
  assert.equal(approvalPathForEpoch(1), R4_APPROVAL_PATH);
  assert.equal(renewalReviewPathForEpoch(2), `${R4_APPROVAL_EPOCHS_DIR}/approval-0002.review.json`);
});

/* ===================== 10 (migration): real A1 -> tracked A2 ===================== */

test('migration: historical A1 remains immutable with its exact T0 and contains no A2', () => {
  assert.equal(gitText(REPO, ['rev-parse', `${A1_SHA}^{commit}`]), A1_SHA);
  assert.equal(REAL_A1_APPROVAL.sealCommit, S3_SHA);
  assert.equal(REAL_A1_APPROVAL.sealFingerprint, A1_SEAL_FINGERPRINT);
  const a1CommittedAt = Number(gitText(REPO, ['show', '-s', '--format=%ct', A1_SHA])) * 1000;
  assert.equal(approvalT0(a1CommittedAt), A1_T0,
    'A1 T0 must remain exactly 2026-09-29T06:00:00Z');
  const a2AtA1 = spawnSync('git', ['cat-file', '-e',
    `${A1_SHA}:${approvalPathForEpoch(2)}`], { cwd: REPO, encoding: 'utf8' });
  assert.notEqual(a2AtA1.status, 0, 'A1 tree must not contain a future A2');
});

test('migration: the tracked real chain resolves A1 -> A2 even after cohort artifacts may exist', () => {
  const { chain, latest } = resolveApprovalEpochChain({ cwd: REPO, verifySealBinding: true });
  assert.equal(chain.length, 2);
  assert.equal(chain[0].epoch, 1);
  assert.equal(chain[0].commit, A1_SHA);
  assert.equal(chain[0].t0, A1_T0);
  assert.equal(latest.epoch, 2);
  assert.equal(latest.commit, A2_SHA);
  assert.equal(latest.record.previousApprovalCommit, A1_SHA);
  assert.equal(latest.record.realAttemptsUsed, 0);
  assert.equal(latest.record.realSessionsCreated, 0);
  assert.equal(latest.record.realOutcomesCreated, 0);
});

test('migration: A1 is permanently superseded by tracked epoch 2', () => {
  const { chain, latest } = resolveLatestApprovalEpoch({ cwd: REPO });
  assert.equal(chain.length, 2);
  assert.equal(latest.epoch, 2);
  assert.equal(latest.commit, A2_SHA);
  assert.notEqual(latest.commit, A1_SHA);
});

/* ===================== report ===================== */

for (const root of CLEANUP) { try { removeTree(root); } catch { /* best effort */ } }

console.log('');
const passed = executed - failed;
console.log(`R4 approval epochs: ${passed}/${executed} executed case(s) passed, ${failed} failure(s); every synthetic chain lived in a disposable repository`);
if (failed) {
  console.error(`failures: ${failures.join(', ')}`);
  process.exitCode = 1;
}
