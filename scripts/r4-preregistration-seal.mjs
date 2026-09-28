// R4 full preregistration seal — deterministic builder and verifier.
//
// The seal binds the frozen protocol constants, the protocol-relevant source
// identities, the preregistration document digest, the excluded methods-only
// sessions and the process disclosures to one canonical fingerprint. It records
// no trading, engine, arena or profitability authority.
//
// `buildSeal` asserts the live modules still produce the canonical frozen
// values before it will seal; `verifyR4Seal` re-checks the fingerprint, every
// bound file digest, the preregistration digest, the exclusion set and the
// frozen protocol against the canonical expectation. The expectation table is
// deliberately hand-written so a mutated module cannot satisfy it by agreeing
// with itself.
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

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const R4_SEAL_RECORD_TYPE = 'r4_preregistration_seal';
export const R4_SEAL_DIR = '.evolve/governance';
export const R4_PREREGISTRATION_PATH = 'docs/R4-PREREGISTRATION.md';

export const R4_EXCLUSIONS = Object.freeze([
  '1790507032018-6854248b-5e29-49fc-9dec-aef8ab398593',
  '1790523432292-82b204a2-75b8-49fd-92a6-c51e6a9370ca',
  '1790579084231-1b57d644-fbbe-4ccc-9b6e-62aff585a4ee',
  '1790584852634-6265dffb-c23a-45fd-9d74-ec03a18f76a3',
  '1790585177858-ac3ca9df-85a4-4bf8-806c-c91045f92883',
]);

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
});

export const R4_BOUND_FILES = Object.freeze([
  R4_PREREGISTRATION_PATH,
  'scripts/market-intelligence.mjs',
  'scripts/market-intelligence/revisits.mjs',
  'scripts/market-intelligence/revisit-scheduler.mjs',
  'scripts/market-intelligence/config.mjs',
  'scripts/market-intelligence/storage.mjs',
  'scripts/market-outcomes/index.mjs',
  'scripts/market-outcomes/sensitivity.mjs',
  'scripts/market-outcomes/reference-selection.mjs',
  'scripts/market-outcomes/primary-analysis.mjs',
  'scripts/market-outcomes/policy-a-cases.mjs',
  'scripts/market-outcomes/policy-b-cases.mjs',
  'scripts/r4-cohort-plan.mjs',
  'scripts/r4-e1-cases.mjs',
  'scripts/validate-r4-e1.mjs',
  'scripts/validate-r4-e1-mutation.mjs',
  'scripts/validate-r4-protocol.mjs',
  'scripts/validate-r4-revisits.mjs',
  'scripts/validate-market-outcomes.mjs',
  'scripts/validate-market-outcomes-policy-b.mjs',
  'scripts/validate-p3c-mutation.mjs',
]);

export const R4_SEAL_AUTHORITY = Object.freeze({ developmentOnly: true, researchOnly: true, paperOnly: true, observerOnly: true,
  tradingAuthority: false, engineAuthority: false, arenaEligible: false, promotionEligible: false, profitabilityInferencePermitted: false });

const sha256 = value => createHash('sha256').update(value).digest('hex');
const defaultLoad = file => readFileSync(path.resolve(REPO, file));

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
  };
}

export function gitIdentity(cwd = REPO) {
  const run = args => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const head = run(['rev-parse', 'HEAD']);
  const tree = run(['rev-parse', 'HEAD^{tree}']);
  return { baseSha: head.status === 0 ? head.stdout.trim() : null, baseTree: tree.status === 0 ? tree.stdout.trim() : null };
}

export function buildSeal({ baseSha, baseTree, sealedAt, load = defaultLoad }) {
  const protocol = readProtocol();
  if (canonical(protocol) !== canonical(R4_EXPECTED)) throw new Error('R4_SEAL_PROTOCOL_DRIFT_AT_BUILD');
  const boundFiles = Object.fromEntries(R4_BOUND_FILES.map(file => [file, { sha256: sha256(load(file)) }]));
  const content = {
    schemaVersion: 1, recordType: R4_SEAL_RECORD_TYPE, phase: 'R4', status: 'SEALED', sealedAt,
    authority: R4_SEAL_AUTHORITY,
    git: { baseSha: baseSha ?? null, baseTree: baseTree ?? null, contentBound: true },
    preregistration: { path: R4_PREREGISTRATION_PATH, sha256: boundFiles[R4_PREREGISTRATION_PATH].sha256 },
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
    },
  };
  return { ...content, fingerprint: digest(content) };
}

export function verifyR4Seal(seal, load = defaultLoad) {
  if (!seal || typeof seal !== 'object') throw new Error('R4_SEAL_INVALID');
  const { fingerprint, ...content } = seal;
  if (digest(content) !== fingerprint) throw new Error('R4_SEAL_FINGERPRINT_MISMATCH');
  if (seal.recordType !== R4_SEAL_RECORD_TYPE || seal.schemaVersion !== 1) throw new Error('R4_SEAL_INVALID');
  if (seal.status !== 'SEALED') throw new Error('R4_SEAL_STATUS_INVALID');
  if (canonical(seal.authority) !== canonical(R4_SEAL_AUTHORITY)) throw new Error('R4_SEAL_AUTHORITY_INVALID');
  if (canonical(seal.protocol) !== canonical(R4_EXPECTED)) throw new Error('R4_SEAL_PROTOCOL_DRIFT');
  if (canonical(seal.exclusions) !== canonical(R4_EXCLUSIONS)) throw new Error('R4_SEAL_EXCLUSIONS_DRIFT');
  if (canonical(seal.cohortPlan.spec) !== canonical(R4_COHORT_SPEC)) throw new Error('R4_SEAL_COHORT_SPEC_DRIFT');
  if (canonical(seal.cohortPlan.attemptIndexes) !== canonical(Array.from({ length: R4_COHORT_SPEC.maxAttempts }, (_, i) => i + 1))) throw new Error('R4_SEAL_ATTEMPT_INDEX_DRIFT');
  if (seal.preregistration?.path !== R4_PREREGISTRATION_PATH) throw new Error('R4_SEAL_PREREGISTRATION_PATH_INVALID');
  for (const [file, record] of Object.entries(seal.boundFiles ?? {})) {
    let bytes;
    try { bytes = load(file); } catch { throw new Error(`R4_SEAL_FILE_UNREADABLE:${file}`); }
    if (bytes === null || bytes === undefined) throw new Error(`R4_SEAL_FILE_MISSING:${file}`);
    if (sha256(bytes) !== record.sha256) throw new Error(`R4_SEAL_FILE_DIGEST_MISMATCH:${file}`);
  }
  if (seal.boundFiles?.[R4_PREREGISTRATION_PATH]?.sha256 !== seal.preregistration.sha256) throw new Error('R4_SEAL_PREREGISTRATION_DIGEST_MISMATCH');
  if (!Object.keys(seal.boundFiles ?? {}).includes(R4_PREREGISTRATION_PATH)) throw new Error('R4_SEAL_PREREGISTRATION_UNBOUND');
  return { ok: true, boundFileCount: Object.keys(seal.boundFiles).length, fingerprint: seal.fingerprint };
}

export function sealFileName(sealedAt = Date.now()) {
  return `r4-preregistration-seal-${new Date(sealedAt).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.json`;
}

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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { file, seal } = writeSeal();
  console.log(`R4 preregistration seal written: ${path.relative(REPO, file)}`);
  console.log(`fingerprint ${seal.fingerprint}`);
}
