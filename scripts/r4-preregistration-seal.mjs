// R4 full preregistration seal — deterministic builder and verifier.
//
// The seal binds the frozen protocol constants, the canonical specification, the
// protocol-relevant source identities, the preregistration document digest, the
// excluded methods-only sessions and the process disclosures to one canonical
// fingerprint.
//
// AUTHORITY MODEL (enforcement only, no science changed):
//   PROTOCOL COMMIT P  contains all code, the preregistration, the enforcement
//                      modules and the validators. It does NOT contain the seal.
//   SEAL COMMIT S      adds ONLY the canonical TRACKED seal. S has P as its
//                      direct parent. The seal binds P, not S.
//   Runtime authority  = (protocol commit P, seal authority commit S).
//   T0 uses S's committer timestamp.
//
// The canonical tracked seal lives at `governance/r4/r4-preregistration-seal.json`
// (see R4_TRACKED_SEAL_PATH). The historical, Git-ignored
// `.evolve/governance/r4-preregistration-seal-*.json` runtime artifact is NOT
// authority: it is retained as historical/runtime evidence and is never the
// final committed seal.
//
// `buildSeal` asserts the live modules still produce the canonical frozen values
// before it will seal; `verifyR4Seal` re-checks the fingerprint, the canonical
// specification, every required bound-file digest, the exact required bound-file
// set, the preregistration digest, the exclusion set and the frozen protocol
// against a hand-written expectation table, so a mutated module cannot satisfy it
// by agreeing with itself. The Git two-commit external contract is enforced
// separately by `verifyR4SealAuthority` in `scripts/r4-authority.mjs`.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, digest } from './market-intelligence/definition.mjs';
import { createIntelligenceConfig } from './market-intelligence/config.mjs';
import { PRIMARY_HORIZON_MS, RESOLUTION_TOLERANCE_MS } from './market-outcomes/index.mjs';
import { REFERENCE_RULE } from './market-outcomes/reference-selection.mjs';
import { PRIMARY_ANALYSIS_SPEC_VERSION, PRIMARY_EXPOSURE_FIELD, PRIMARY_OUTCOME_FIELD, PRIMARY_ESTIMAND, CLUSTER_KEY,
  BOOTSTRAP_REPLICATES, MIN_RESOLVED_REFERENCES, MIN_RESOLVED_MINTS, MIN_DEFINED_REPLICATES, CI_LEVEL, QUANTILE_METHOD,
  SEED_DERIVATION } from './market-outcomes/primary-analysis.mjs';
import { SENSITIVITY_POLICY, PRIMARY_POLICY } from './market-outcomes/sensitivity.mjs';
import { R4_COHORT_SPEC, R4_B1_RULE, sessionParameters } from './r4-cohort-plan.mjs';
import { R4_SPEC, R4_SPEC_DIGEST, R4_CAPTURE_ENV_CLASSIFICATION, R4_REQUIRED_BOUND_FILES, R4_TRACKED_SEAL_PATH, captureSpecDigest } from './r4-protocol-spec.mjs';
import { R4_EXCLUSIONS } from './r4-exclusions.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const R4_SEAL_RECORD_TYPE = 'r4_preregistration_seal';
export const R4_SEAL_DIR = '.evolve/governance';
export const R4_PREREGISTRATION_PATH = 'docs/R4-PREREGISTRATION.md';
export { R4_EXCLUSIONS, R4_TRACKED_SEAL_PATH };

/** Canonical required bound-file set. The canonical spec defines it, not the seal. */
export const R4_BOUND_FILES = R4_REQUIRED_BOUND_FILES;

/** Canonical frozen protocol. Hand-written; never derived from the modules. */
export const R4_EXPECTED = Object.freeze({
  d1: Object.freeze({
    design: 'MULTI_SESSION_TARGETED', captureMode: '--r4-revisits', durationMinutes: 45,
    targetCompletedSessions: 6, maxAttempts: 8,
    t0Rule: 'FIRST_WHOLE_UTC_HOUR_AT_LEAST_30_MINUTES_AFTER_SEAL_COMMIT',
    providers: Object.freeze({ jupiter: 'ENABLED', dexscreener: 'ENABLED', gmgn: 'DISABLED_NO_KEY', launchObserver: 'DISABLED_UNVERIFIED_TRANSPORT' }),
  }),
  d2: Object.freeze({ referenceRule: 'ALL_ELIGIBLE_REFERENCES', referenceRole: 'cohort' }),
  d3: Object.freeze({
    analysis: 'CONTINUOUS_RANK_ASSOCIATION', exposureField: 'crossSourcePriceRangeBps', outcomeField: 'absLogReturn300sBps',
    estimand: 'kendall_tau_b', clusterKey: 'mint', bootstrapReplicates: 10000, ciLevel: 0.95, quantileMethod: 'type7',
    minResolvedReferences: 100, minResolvedMints: 30, minDefinedReplicates: 1000, specVersion: 'R4-PRIMARY-TAU-B-V1',
    seedDerivation: SEED_DERIVATION,
  }),
  d4: Object.freeze({ rule: 'FIXED_REPLACEMENT_SESSION_RULE', targetCompletedSessions: 6, maxAttempts: 8 }),
  b1: 'E1_REFERENCE_LEVEL_MISSINGNESS',
  maturation: 'COHORT_DRAIN_ONLY',
  policyA: 'POLICY_A_CONTENT_UNIQUENESS',
  policyB: Object.freeze({ policy: 'POLICY_B_OBSERVATION_IDENTITY', artifactMode: 'COMPUTE_ONLY', primary: false }),
  frozenConstants: Object.freeze({ horizonMs: 300000, toleranceMs: 60000, freshnessMs: 60000, alignmentMs: 15000 }),
  exclusions: R4_EXCLUSIONS,
  // Hand-written canonical specification digests. A mutated spec module changes
  // R4_SPEC_DIGEST and therefore fails these literals.
  specDigest: '173383ba8c485998af91b4b990a9a090955e8e81167116836c7e0a754930a2a8',
  captureSpecDigest: '39f2bf6a1da9ac45d6b6b31dbfcc9db1d61b0229f59e613c037f9fa5be30b97f',
});

export const R4_SEAL_AUTHORITY = Object.freeze({ developmentOnly: true, researchOnly: true, paperOnly: true, observerOnly: true,
  tradingAuthority: false, engineAuthority: false, arenaEligible: false, promotionEligible: false, profitabilityInferencePermitted: false });

export const R4_ARTIFACT_AUTHORITY = Object.freeze({
  canonicalSealPath: R4_TRACKED_SEAL_PATH,
  authorityChain: 'TWO_COMMIT_P_S',
  protocolCommitRole: 'contains all code, preregistration, enforcement and validators; never contains the final seal',
  sealAuthorityCommitRole: 'adds only the canonical tracked seal; direct parent is the protocol commit',
  t0TimestampSource: 'SEAL_AUTHORITY_COMMIT_S_COMMITTER_TIMESTAMP',
  historicalRuntimeSeal: '.evolve/governance/r4-preregistration-seal-*.json (historical/runtime evidence only; NOT authority; Git-ignored)',
});

const sha256 = value => createHash('sha256').update(value).digest('hex');
const defaultLoad = file => readFileSync(path.resolve(REPO, file));
const isSha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);

/** Read the frozen protocol values from the live modules. */
export function readProtocol() {
  const config = createIntelligenceConfig({ env: {} });
  return {
    d1: { design: 'MULTI_SESSION_TARGETED', captureMode: R4_COHORT_SPEC.captureMode, durationMinutes: R4_COHORT_SPEC.durationMinutes,
      targetCompletedSessions: R4_COHORT_SPEC.targetCompletedSessions, maxAttempts: R4_COHORT_SPEC.maxAttempts,
      t0Rule: R4_COHORT_SPEC.t0Rule, providers: { ...R4_COHORT_SPEC.providers } },
    d2: { referenceRule: REFERENCE_RULE, referenceRole: R4_COHORT_SPEC.referenceRole },
    d3: { analysis: 'CONTINUOUS_RANK_ASSOCIATION', exposureField: PRIMARY_EXPOSURE_FIELD, outcomeField: PRIMARY_OUTCOME_FIELD,
      estimand: PRIMARY_ESTIMAND, clusterKey: CLUSTER_KEY, bootstrapReplicates: BOOTSTRAP_REPLICATES, ciLevel: CI_LEVEL,
      quantileMethod: QUANTILE_METHOD, minResolvedReferences: MIN_RESOLVED_REFERENCES, minResolvedMints: MIN_RESOLVED_MINTS,
      minDefinedReplicates: MIN_DEFINED_REPLICATES, specVersion: PRIMARY_ANALYSIS_SPEC_VERSION, seedDerivation: SEED_DERIVATION },
    d4: { rule: 'FIXED_REPLACEMENT_SESSION_RULE', targetCompletedSessions: R4_COHORT_SPEC.targetCompletedSessions, maxAttempts: R4_COHORT_SPEC.maxAttempts },
    b1: R4_B1_RULE,
    maturation: R4_COHORT_SPEC.maturationMode,
    policyA: PRIMARY_POLICY,
    policyB: { policy: SENSITIVITY_POLICY, artifactMode: 'COMPUTE_ONLY', primary: false },
    frozenConstants: { horizonMs: PRIMARY_HORIZON_MS, toleranceMs: RESOLUTION_TOLERANCE_MS, freshnessMs: config.jupiterStaleMs, alignmentMs: config.alignmentMs },
    exclusions: [...R4_EXCLUSIONS],
    specDigest: R4_SPEC_DIGEST,
    captureSpecDigest: captureSpecDigest(),
  };
}

export function gitIdentity(cwd = REPO) {
  const run = args => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const head = run(['rev-parse', 'HEAD']);
  const tree = run(['rev-parse', 'HEAD^{tree}']);
  return { baseSha: head.status === 0 ? head.stdout.trim() : null, baseTree: tree.status === 0 ? tree.stdout.trim() : null };
}

export function sealContent({ baseSha, baseTree, sealedAt, boundFiles, protocol, preregistrationSha }) {
  return {
    schemaVersion: 1, recordType: R4_SEAL_RECORD_TYPE, phase: 'R4', status: 'SEALED', sealedAt,
    authority: R4_SEAL_AUTHORITY,
    protocolCommit: baseSha ?? null, protocolTree: baseTree ?? null,
    git: { protocolCommit: baseSha ?? null, protocolTree: baseTree ?? null, contentBound: true },
    artifactAuthority: R4_ARTIFACT_AUTHORITY,
    preregistration: { path: R4_PREREGISTRATION_PATH, sha256: preregistrationSha },
    spec: R4_SPEC, specDigest: R4_SPEC_DIGEST, captureSpecDigest: captureSpecDigest(),
    captureEnvironment: R4_CAPTURE_ENV_CLASSIFICATION,
    protocol,
    cohortPlan: { planVersion: 'R4-COHORT-V1', module: 'scripts/r4-cohort-plan.mjs', spec: R4_COHORT_SPEC,
      sessionParameters: sessionParameters(), attemptIndexes: Array.from({ length: R4_COHORT_SPEC.maxAttempts }, (_, i) => i + 1),
      note: 'The concrete attempt plan is built at cohort start from this seal fingerprint via buildCohortPlan; no attempt has been started.' },
    boundFiles,
    exclusions: [...R4_EXCLUSIONS],
    processNotes: {
      policyA: 'primary and unchanged', policyB: 'compute-only sensitivity and unchanged',
      b1: 'E1_REFERENCE_LEVEL_MISSINGNESS: terminal reference-level revisit failures are reference-level missingness only; pending work and scheduler invariant violations remain session-fatal.',
      twentyFourHours: 'NOT prior authority; the cohort uses 6 x 45-minute targeted sessions.',
      phase5jScopeEvolution: 'The passive fixed-duration cohort recommended by Phase 5J was replaced by an opt-in targeted revisit cohort because the methods-only passive shakedown produced zero otherwise-valid post-target two-source future candidates.',
      staleSchedulerWording: 'The shakedown completion wording naming P3-C as the only remaining blocker is scoped to the live revisit scheduler and is stale; it is not global R4 authority.',
      directoryMtime: 'AUTHORITY_NOT_FOUND: no authoritative record of a .evolve directory-mtime observation exists; date, scope, cause and byte-change status are unknown; no scientific-evidence impact is asserted and the uncertainty is carried forward.',
      storageHeadroom: 'A 45-minute targeted session uses roughly 77-88% of the default 512 MiB cap at observed methods-only volume.',
      enforcement: 'Pre-capture enforcement controls only: canonical tracked seal, two-commit P/S authority chain, sealed capture mode, hard exclusion enforcement, authenticated session attestation, canonical reference-set enforcement, authenticated exposure provenance, locked primary-analysis interface and outcome/cohort/reference binding. No scientific rule was reopened.',
    },
  };
}

export function buildSeal({ baseSha, baseTree, sealedAt, load = defaultLoad }) {
  if (!isSha(baseSha) || !isSha(baseTree)) throw new Error('R4_SEAL_PROTOCOL_COMMIT_REQUIRED');
  const protocol = readProtocol();
  if (canonical(protocol) !== canonical(R4_EXPECTED)) throw new Error('R4_SEAL_PROTOCOL_DRIFT_AT_BUILD');
  const boundFiles = Object.fromEntries(R4_BOUND_FILES.map(file => [file, { sha256: sha256(load(file)) }]));
  const content = sealContent({ baseSha, baseTree, sealedAt, boundFiles, protocol,
    preregistrationSha: boundFiles[R4_PREREGISTRATION_PATH].sha256 });
  return { ...content, fingerprint: digest(content) };
}

export function verifyR4Seal(seal, { load = defaultLoad } = {}) {
  if (!seal || typeof seal !== 'object') throw new Error('R4_SEAL_INVALID');
  const { fingerprint, ...content } = seal;
  if (digest(content) !== fingerprint) throw new Error('R4_SEAL_FINGERPRINT_MISMATCH');
  if (seal.recordType !== R4_SEAL_RECORD_TYPE || seal.schemaVersion !== 1) throw new Error('R4_SEAL_INVALID');
  if (seal.status !== 'SEALED') throw new Error('R4_SEAL_STATUS_INVALID');
  if (canonical(seal.authority) !== canonical(R4_SEAL_AUTHORITY)) throw new Error('R4_SEAL_AUTHORITY_INVALID');
  if (canonical(seal.protocol) !== canonical(R4_EXPECTED)) throw new Error('R4_SEAL_PROTOCOL_DRIFT');
  if (canonical(seal.spec) !== canonical(R4_SPEC)) throw new Error('R4_SEAL_SPEC_DRIFT');
  if (seal.specDigest !== R4_SPEC_DIGEST || seal.specDigest !== R4_EXPECTED.specDigest) throw new Error('R4_SEAL_SPEC_DIGEST_DRIFT');
  if (seal.captureSpecDigest !== captureSpecDigest() || seal.captureSpecDigest !== R4_EXPECTED.captureSpecDigest) throw new Error('R4_SEAL_CAPTURE_SPEC_DIGEST_DRIFT');
  if (canonical(seal.captureEnvironment) !== canonical(R4_CAPTURE_ENV_CLASSIFICATION)) throw new Error('R4_SEAL_CAPTURE_ENV_DRIFT');
  if (canonical(seal.exclusions) !== canonical(R4_EXCLUSIONS)) throw new Error('R4_SEAL_EXCLUSIONS_DRIFT');
  if (canonical(seal.cohortPlan.spec) !== canonical(R4_COHORT_SPEC)) throw new Error('R4_SEAL_COHORT_SPEC_DRIFT');
  if (canonical(seal.cohortPlan.attemptIndexes) !== canonical(Array.from({ length: R4_COHORT_SPEC.maxAttempts }, (_, i) => i + 1))) throw new Error('R4_SEAL_ATTEMPT_INDEX_DRIFT');
  if (seal.preregistration?.path !== R4_PREREGISTRATION_PATH) throw new Error('R4_SEAL_PREREGISTRATION_PATH_INVALID');
  if (!isSha(seal.protocolCommit) || !isSha(seal.protocolTree)) throw new Error('R4_SEAL_PROTOCOL_COMMIT_INVALID');
  if (seal.git?.protocolCommit !== seal.protocolCommit || seal.git?.protocolTree !== seal.protocolTree) throw new Error('R4_SEAL_GIT_IDENTITY_DRIFT');
  if (seal.artifactAuthority?.canonicalSealPath !== R4_TRACKED_SEAL_PATH) throw new Error('R4_SEAL_ARTIFACT_AUTHORITY_INVALID');
  if (canonical(seal.artifactAuthority) !== canonical(R4_ARTIFACT_AUTHORITY)) throw new Error('R4_SEAL_ARTIFACT_AUTHORITY_DRIFT');
  // The canonical spec defines the required set; the seal may not shrink it.
  const required = [...R4_BOUND_FILES].sort();
  const recorded = Object.keys(seal.boundFiles ?? {}).sort();
  if (canonical(recorded) !== canonical(required)) throw new Error('R4_SEAL_BOUND_FILE_SET_DRIFT');
  for (const file of required) {
    let bytes;
    try { bytes = load(file); } catch { throw new Error(`R4_SEAL_FILE_UNREADABLE:${file}`); }
    if (bytes === null || bytes === undefined) throw new Error(`R4_SEAL_FILE_MISSING:${file}`);
    if (sha256(bytes) !== seal.boundFiles[file].sha256) throw new Error(`R4_SEAL_FILE_DIGEST_MISMATCH:${file}`);
  }
  if (seal.boundFiles[R4_PREREGISTRATION_PATH]?.sha256 !== seal.preregistration.sha256) throw new Error('R4_SEAL_PREREGISTRATION_DIGEST_MISMATCH');
  return { ok: true, boundFileCount: required.length, fingerprint: seal.fingerprint,
    protocolCommit: seal.protocolCommit, protocolTree: seal.protocolTree };
}

export function sealFileName(sealedAt = Date.now()) {
  return `r4-preregistration-seal-${new Date(sealedAt).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.json`;
}

/** Historical runtime artifact under the Git-ignored `.evolve` tree (not authority). */
export function writeSeal({ cwd = REPO, sealedAt = Date.now() } = {}) {
  const identity = gitIdentity(cwd);
  const seal = buildSeal({ ...identity, sealedAt });
  verifyR4Seal(seal);
  const dir = path.resolve(cwd, R4_SEAL_DIR);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, sealFileName(sealedAt));
  writeFileSync(file, canonical(seal) + '\n');
  return { file, seal };
}

/** Write the canonical TRACKED seal at the authority path. Run only after P exists. */
export function writeTrackedSeal({ cwd = REPO, sealedAt = Date.now() } = {}) {
  const identity = gitIdentity(cwd);
  const seal = buildSeal({ ...identity, sealedAt });
  verifyR4Seal(seal);
  const file = path.resolve(cwd, R4_TRACKED_SEAL_PATH);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, canonical(seal) + '\n');
  return { file, seal };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tracked = process.argv.includes('--tracked') || process.argv.includes('--authority');
  const { file, seal } = tracked ? writeTrackedSeal() : writeSeal();
  console.log(`R4 preregistration seal written: ${path.relative(REPO, file)}${tracked ? ' (canonical tracked authority)' : ' (historical runtime artifact; NOT authority)'}`);
  console.log(`fingerprint ${seal.fingerprint}`);
}
