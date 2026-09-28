// R4 canonical protocol specification — the single code-level source of truth
// for every scientifically relevant runtime value of the frozen R4 protocol.
//
// ENFORCEMENT ONLY. This module introduces no new scientific decision. Every
// value below is already frozen by docs/R4-PREREGISTRATION.md, the earlier
// outcome/Policy-A preregistrations, or the capture/revisit documents, and the
// module cross-checks the live implementation constants so a drift fails loudly
// instead of silently changing evidence semantics.
//
// Lifecycle:
//   * the canonical tracked R4 seal binds `specDigest` and `captureSpecDigest`;
//   * the sealed cohort runner derives every capture parameter from here;
//   * the primary-analysis and reference-set enforcement derive their inputs
//     from here, never from caller-supplied overrides;
//   * environment drift is detected by comparing live environment values with
//     the sealed values recorded below.
import { digest } from './market-intelligence/definition.mjs';
import { SESSION_CAPACITY_MIB, SESSION_FINALIZATION_RESERVE_BYTES } from './market-intelligence/storage.mjs';
import { PRIMARY_HORIZON_MS, RESOLUTION_TOLERANCE_MS, OUTCOME_DEFINITION_ID } from './market-outcomes/index.mjs';
import { REFERENCE_RULE } from './market-outcomes/reference-selection.mjs';
import {
  PRIMARY_ANALYSIS_SPEC_VERSION, PRIMARY_EXPOSURE_FIELD, PRIMARY_OUTCOME_FIELD, PRIMARY_ESTIMAND, CLUSTER_KEY,
  BOOTSTRAP_REPLICATES, MIN_RESOLVED_REFERENCES, MIN_RESOLVED_MINTS, MIN_DEFINED_REPLICATES, CI_LEVEL,
  QUANTILE_METHOD, SEED_DERIVATION,
} from './market-outcomes/primary-analysis.mjs';
import { PRIMARY_POLICY, SENSITIVITY_POLICY } from './market-outcomes/sensitivity.mjs';
import { R4_COHORT_SPEC, R4_B1_RULE } from './r4-cohort-plan.mjs';
import { R4_EXCLUSIONS } from './r4-exclusions.mjs';

const fail = code => { throw new Error(code); };
const frozen = value => Object.freeze(value);

// Canonical TRACKED authority locations. These are deliberately outside the
// Git-ignored `.evolve` tree: authority may never depend on an ignored file.
// The historical `.evolve/governance/...` seal remains runtime/historical
// evidence only and is not the committed authority.
export const R4_TRACKED_SEAL_PATH = 'governance/r4/r4-preregistration-seal.json';
export const R4_AUTHORITY_POINTER_PATH = 'governance/r4/AUTHORITY.json';

/* ------------------------------------------------------------------ cohort */

const R4_SPEC_COHORT = frozen({
  design: 'MULTI_SESSION_TARGETED',
  targetCompletedSessions: R4_COHORT_SPEC.targetCompletedSessions,
  maxAttempts: R4_COHORT_SPEC.maxAttempts,
  referenceMinutes: R4_COHORT_SPEC.durationMinutes,
  captureMode: 'r4-revisits',
  captureFlag: R4_COHORT_SPEC.captureMode,
  captureCommand: R4_COHORT_SPEC.captureCommand,
  maturationMode: R4_COHORT_SPEC.maturationMode,
  replacementRule: 'FIXED_REPLACEMENT_SESSION_RULE',
  t0Rule: R4_COHORT_SPEC.t0Rule,
  // Enforcement clarification: T0 is computed from the committer timestamp of
  // the seal authority commit S (the commit that adds the canonical tracked
  // seal), not from the protocol commit P.
  t0TimestampSource: 'SEAL_AUTHORITY_COMMIT_S_COMMITTER_TIMESTAMP',
  t0MinimumDelayMs: R4_COHORT_SPEC.t0MinimumDelayMs,
  discretionaryAttemptsPermitted: false,
  outcomeDependentExtensionPermitted: false,
  sessionParametersImmutable: true,
});

/* --------------------------------------------------------------- providers */

const R4_SPEC_PROVIDERS = frozen({ ...R4_COHORT_SPEC.providers });

/* ----------------------------------------------------------------- universe */

const R4_SPEC_UNIVERSE = frozen({
  marketMode: 'live',
  liveOnly: true,
  syntheticFallbackPermitted: false,
  jupiterBaseUrl: 'https://api.jup.ag',
  jupiterEndpoints: frozen([
    frozen({ id: 'recent', path: 'recent', category: 'recent', label: '/tokens/v2/recent' }),
    frozen({ id: 'toporganicscore', path: 'toporganicscore/5m', category: 'organic', label: '/tokens/v2/toporganicscore/5m' }),
    frozen({ id: 'toptrending', path: 'toptrending/5m', category: 'trending', label: '/tokens/v2/toptrending/5m' }),
  ]),
  includeToptraded: false,
  endpointRotation: 'ONE_ENDPOINT_PER_POLL_IN_ENDPOINT_ORDER',
  jupiterLimit: 100,
  universeMax: 150,
  tokenTtlMs: 300_000,
  minLiquidityUsd: 2500,
});

/* ------------------------------------------------------------------ capture */

const R4_SPEC_CAPTURE = frozen({
  pollMs: frozen({ jupiter: 3500, dexscreener: 30_000, gmgn: 30_000 }),
  spacingMs: frozen({ jupiter: 2000, dexscreener: 1200, gmgn: 1200 }),
  timeoutMs: frozen({ jupiter: 9000, dexscreener: 8000, gmgn: 8000 }),
  maxRequestsPerCycle: frozen({ jupiter: 1, dexscreener: 6, gmgn: 6 }),
  maxPassiveDexPerWindow: 2,
  concurrency: 1,
  loopSleepMs: 250,
  cacheMs: frozen({ dexscreener: 30_000, gmgn: 30_000 }),
  freshnessMs: frozen({ jupiter: 60_000, dexscreener: 60_000, gmgn: 90_000 }),
  alignmentMs: 15_000,
  referenceWindowMs: 45 * 60_000,
  drainBoundMs: R4_COHORT_SPEC.drainBoundMs,
  revisitSafetyMsFormula: '(timeoutMs + spacingMs + 5000)',
  dexRevisitSafeStartOffsetMs: 45_800,
  storage: frozen({
    defaultSessionMiB: SESSION_CAPACITY_MIB.default,
    // Sealed OPERATIONAL session cap. Provisioning the cap within the frozen
    // 64-2048 MiB clamp is explicitly a configuration-only change that alters no
    // science (docs/R4-PREREGISTRATION.md). The sealed value is chosen so the
    // worst-case sealed window + drain fits with positive headroom; it is never
    // silently altered at run time.
    sealedSessionMiB: 1024,
    minSessionMiB: SESSION_CAPACITY_MIB.min,
    maxSessionMiB: SESSION_CAPACITY_MIB.max,
    finalizationReserveBytes: SESSION_FINALIZATION_RESERVE_BYTES,
    maxRawBytes: 256 * 1024,
  }),
  // Documented methods-only high-water storage rate used by the pre-capture
  // storage preflight. Operational evidence only; it never changes duration.
  methodsOnlyHighWaterBytesPerMinute: 11 * 1024 * 1024,
});

/* ------------------------------------------------------------------ outcome */

const R4_SPEC_OUTCOME = frozen({
  definitionId: OUTCOME_DEFINITION_ID,
  primaryField: 'absLogReturn300sBps',
  horizonMs: PRIMARY_HORIZON_MS,
  toleranceMs: RESOLUTION_TOLERANCE_MS,
  policyA: PRIMARY_POLICY,
  policyB: SENSITIVITY_POLICY,
  policyBMode: 'COMPUTE_ONLY',
  policyBPrimary: false,
  missingnessDerivedFromEvidence: true,
});

/* ----------------------------------------------------------------- analysis */

const R4_SPEC_ANALYSIS = frozen({
  analysis: 'CONTINUOUS_RANK_ASSOCIATION',
  specVersion: PRIMARY_ANALYSIS_SPEC_VERSION,
  exposureField: PRIMARY_EXPOSURE_FIELD,
  outcomeField: PRIMARY_OUTCOME_FIELD,
  estimand: PRIMARY_ESTIMAND,
  clusterKey: CLUSTER_KEY,
  bootstrapReplicates: BOOTSTRAP_REPLICATES,
  ciLevel: CI_LEVEL,
  ciMethod: 'PERCENTILE',
  quantileMethod: QUANTILE_METHOD,
  minResolvedReferences: MIN_RESOLVED_REFERENCES,
  minResolvedMints: MIN_RESOLVED_MINTS,
  minDefinedReplicates: MIN_DEFINED_REPLICATES,
  seedDerivation: SEED_DERIVATION,
  seedScheme: 'OUTCOME_INDEPENDENT_SHA256_SEAL_BOUND',
});

/* ---------------------------------------------------------------- reference */

const R4_SPEC_REFERENCE = frozen({
  rule: REFERENCE_RULE,
  role: R4_COHORT_SPEC.referenceRole,
  ordering: 'sessionId ascending, then snapshotDigest ascending',
  thinningPermitted: false,
  mintDeduplicationPermitted: false,
  maturationRoleSuppliesReferences: false,
});

/* -------------------------------------------------------------- frozen spec */

export const R4_SPEC = frozen({
  specVersion: 'R4-PROTOCOL-SPEC-V1',
  cohort: R4_SPEC_COHORT,
  providers: R4_SPEC_PROVIDERS,
  universe: R4_SPEC_UNIVERSE,
  capture: R4_SPEC_CAPTURE,
  outcome: R4_SPEC_OUTCOME,
  analysis: R4_SPEC_ANALYSIS,
  reference: R4_SPEC_REFERENCE,
  b1: R4_B1_RULE,
  policyA: PRIMARY_POLICY,
  policyB: frozen({ policy: SENSITIVITY_POLICY, artifactMode: 'COMPUTE_ONLY', primary: false }),
  maturation: R4_COHORT_SPEC.maturationMode,
  exclusions: R4_EXCLUSIONS,
});

export const R4_SPEC_DIGEST = digest(R4_SPEC);

/** Digest of the capture-relevant specification slice. Bound by the seal and by
 * every real R4 session attestation. */
export function captureSpecDigest() {
  return digest({ cohort: R4_SPEC.cohort, providers: R4_SPEC.providers, universe: R4_SPEC.universe, capture: R4_SPEC.capture });
}

export const R4_CAPTURE_SPEC_DIGEST = captureSpecDigest();

/* --------------------------------------------- canonical required bound files */

// The canonical validator/spec defines the required bound-file set. A seal may
// not define or shrink its own list.
export const R4_REQUIRED_BOUND_FILES = Object.freeze([
  'docs/R4-PREREGISTRATION.md',
  'scripts/market-intelligence.mjs',
  'scripts/market-intelligence/aggregate.mjs',
  'scripts/market-intelligence/config.mjs',
  'scripts/market-intelligence/revisits.mjs',
  'scripts/market-intelligence/revisit-scheduler.mjs',
  'scripts/market-intelligence/storage.mjs',
  'scripts/market/config.mjs',
  'scripts/market/feed.mjs',
  'scripts/market/jupiter.mjs',
  'scripts/market/universe.mjs',
  'scripts/market-outcomes/index.mjs',
  'scripts/market-outcomes/policy-a-cases.mjs',
  'scripts/market-outcomes/policy-b-cases.mjs',
  'scripts/market-outcomes/primary-analysis.mjs',
  'scripts/market-outcomes/reference-selection.mjs',
  'scripts/market-outcomes/sensitivity.mjs',
  'scripts/r4-attestation.mjs',
  'scripts/r4-authority.mjs',
  'scripts/r4-cohort-plan.mjs',
  'scripts/r4-cohort-run.mjs',
  'scripts/r4-e1-cases.mjs',
  'scripts/r4-enforcement.mjs',
  'scripts/r4-exclusions.mjs',
  'scripts/r4-protocol-spec.mjs',
  'scripts/validate-market-outcomes-policy-b.mjs',
  'scripts/validate-market-outcomes.mjs',
  'scripts/validate-p3c-mutation.mjs',
  'scripts/validate-r4-e1-mutation.mjs',
  'scripts/validate-r4-e1.mjs',
  'scripts/validate-r4-enforcement.mjs',
  'scripts/validate-r4-preregistration-seal.mjs',
  'scripts/validate-r4-protocol.mjs',
  'scripts/validate-r4-revisits.mjs',
]);

/* --------------------------------------------------- capture env classification */

// Every environment variable able to reach a live R4 capture is classified:
//
//   A  scientific / evidence-changing. If the variable is present and differs
//      from `sealedValue` (or is present at all when `sealedValue` is null), the
//      attempt FAILS BEFORE CAPTURE. It is never silently overridden.
//   B  operational-only. Permitted; cannot alter reference/evidence semantics.
//   C  secret / credential. Permitted to exist; provider enablement and every
//      capture-relevant behaviour remain exactly sealed (they are forced from
//      R4_SPEC, so a credential cannot change cadence or evidence semantics).
export const R4_CAPTURE_ENV_CLASSIFICATION = frozen([
  frozen({ name: 'EVOLVE_MARKET_MODE', class: 'A', sealedValue: 'live' }),
  frozen({ name: 'EVOLVE_ALLOW_SYNTHETIC_FALLBACK', class: 'A', sealedValue: 'false' }),
  frozen({ name: 'EVOLVE_JUPITER_ENDPOINTS', class: 'A', sealedValue: 'recent,toporganicscore,toptrending' }),
  frozen({ name: 'EVOLVE_JUPITER_INCLUDE_TOPTRADED', class: 'A', sealedValue: 'false' }),
  frozen({ name: 'EVOLVE_JUPITER_LIMIT', class: 'A', sealedValue: '100' }),
  frozen({ name: 'EVOLVE_MARKET_UNIVERSE_MAX', class: 'A', sealedValue: '150' }),
  frozen({ name: 'EVOLVE_JUPITER_POLL_MS', class: 'A', sealedValue: '3500' }),
  frozen({ name: 'EVOLVE_JUPITER_SPACING_MS', class: 'A', sealedValue: '2000' }),
  frozen({ name: 'EVOLVE_JUPITER_TIMEOUT_MS', class: 'A', sealedValue: '9000' }),
  frozen({ name: 'EVOLVE_JUPITER_BASE_URL', class: 'A', sealedValue: 'https://api.jup.ag' }),
  frozen({ name: 'EVOLVE_LIVE_STALE_MS', class: 'A', sealedValue: '60000' }),
  frozen({ name: 'EVOLVE_MARKET_STALE_MS', class: 'A', sealedValue: '60000' }),
  frozen({ name: 'EVOLVE_MARKET_TOKEN_TTL_MS', class: 'A', sealedValue: '300000' }),
  frozen({ name: 'EVOLVE_MIN_LIQUIDITY_USD', class: 'A', sealedValue: '2500' }),
  frozen({ name: 'EVOLVE_INTELLIGENCE_MAX_SESSION_MIB', class: 'A', sealedValue: '1024' }),
  frozen({ name: 'EVOLVE_INTELLIGENCE_JUPITER_STALE_MS', class: 'A', sealedValue: '60000' }),
  frozen({ name: 'EVOLVE_INTELLIGENCE_ALIGNMENT_MS', class: 'A', sealedValue: '15000' }),
  frozen({ name: 'EVOLVE_DEXSCREENER_ENABLED', class: 'A', sealedValue: 'true' }),
  frozen({ name: 'EVOLVE_DEXSCREENER_POLL_MS', class: 'A', sealedValue: '30000' }),
  frozen({ name: 'EVOLVE_DEXSCREENER_MAX_REQUESTS_PER_CYCLE', class: 'A', sealedValue: '6' }),
  frozen({ name: 'EVOLVE_DEXSCREENER_CACHE_MS', class: 'A', sealedValue: '30000' }),
  frozen({ name: 'EVOLVE_DEXSCREENER_STALE_MS', class: 'A', sealedValue: '60000' }),
  frozen({ name: 'EVOLVE_DEXSCREENER_TIMEOUT_MS', class: 'A', sealedValue: '8000' }),
  frozen({ name: 'EVOLVE_GMGN_ENABLED', class: 'A', sealedValue: 'false' }),
  frozen({ name: 'EVOLVE_GMGN_BASE_URL', class: 'A', sealedValue: 'https://openapi.gmgn.ai' }),
  frozen({ name: 'EVOLVE_GMGN_TIMEOUT_MS', class: 'A', sealedValue: '8000' }),
  frozen({ name: 'EVOLVE_GMGN_POLL_MS', class: 'A', sealedValue: '30000' }),
  frozen({ name: 'EVOLVE_GMGN_MAX_REQUESTS_PER_CYCLE', class: 'A', sealedValue: '6' }),
  frozen({ name: 'EVOLVE_GMGN_CACHE_MS', class: 'A', sealedValue: '30000' }),
  frozen({ name: 'EVOLVE_GMGN_STALE_MS', class: 'A', sealedValue: '90000' }),
  frozen({ name: 'EVOLVE_LAUNCH_STALE_MS', class: 'A', sealedValue: '300000' }),
  frozen({ name: 'JUPITER_API_KEY', class: 'C', sealedValue: null }),
  frozen({ name: 'EVOLVE_JUPITER_API_KEY', class: 'C', sealedValue: null }),
  frozen({ name: 'EVOLVE_GMGN_API_KEY', class: 'C', sealedValue: null }),
  frozen({ name: 'GMGN_API_KEY', class: 'C', sealedValue: null }),
  frozen({ name: 'EVOLVE_SOLANA_RPC_URL', class: 'C', sealedValue: null }),
  frozen({ name: 'EVOLVE_SOLANA_WSS_URL', class: 'C', sealedValue: null }),
  frozen({ name: 'EVOLVE_MARKET_PROBE_ONLY', class: 'B', sealedValue: null }),
  frozen({ name: 'EVOLVE_DISABLE_STDOUT_PROGRESS', class: 'B', sealedValue: null }),
  frozen({ name: 'EVOLVE_JEV_SKIP', class: 'B', sealedValue: null }),
  frozen({ name: 'EVOLVE_DECISION_ROUTER', class: 'B', sealedValue: null }),
  frozen({ name: 'R4_SEALED_RUNNER', class: 'B', sealedValue: null }),
]);

const CLASS_BY_NAME = new Map(R4_CAPTURE_ENV_CLASSIFICATION.map(entry => [entry.name, entry]));

/**
 * Classify a live environment against the sealed capture spec.
 *
 * Fail closed: any `EVOLVE_*` / `JUPITER*` / `GMGN*` variable that is not
 * explicitly classified is treated as scientific drift when it is present.
 */
export function classifyCaptureEnvironment(env = {}) {
  const table = [];
  const drift = [];
  for (const entry of R4_CAPTURE_ENV_CLASSIFICATION) {
    const present = env[entry.name] !== undefined && env[entry.name] !== null && String(env[entry.name]).trim() !== '';
    const value = present ? String(env[entry.name]) : null;
    // An ABSENT scientific variable is not drift: the sealed runner supplies the
    // sealed value itself. Only a PRESENT value that differs is drift.
    let matches = true;
    if (entry.class === 'A' && present) matches = entry.sealedValue !== null && value === entry.sealedValue;
    table.push({ name: entry.name, class: entry.class, sealedValue: entry.sealedValue, present, value, matches });
    if (entry.class === 'A' && !matches) drift.push({ name: entry.name, sealedValue: entry.sealedValue, value, reason: 'SEALED_VALUE_MISMATCH' });
  }
  for (const name of Object.keys(env)) {
    if (!/^(EVOLVE_|JUPITER|GMGN)/.test(name)) continue;
    if (CLASS_BY_NAME.has(name)) continue;
    if (env[name] === undefined || env[name] === null || String(env[name]).trim() === '') continue;
    table.push({ name, class: 'A', sealedValue: null, present: true, value: String(env[name]), matches: false });
    drift.push({ name, sealedValue: null, value: String(env[name]), reason: 'UNCLASSIFIED_CAPTURE_VARIABLE' });
  }
  return { table: table.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)), drift };
}

/**
 * Build the exact, sealed capture environment. The runner passes this to the
 * capture feed so no live environment value can change a scientific parameter.
 */
export function sealedCaptureEnvironment(base = {}) {
  const env = { ...base };
  for (const entry of R4_CAPTURE_ENV_CLASSIFICATION) {
    if (entry.class === 'A' && entry.sealedValue !== null) env[entry.name] = entry.sealedValue;
  }
  env.EVOLVE_MARKET_MODE = 'live';
  env.EVOLVE_ALLOW_SYNTHETIC_FALLBACK = 'false';
  return env;
}

/* ------------------------------------------------------------- consistency */

/** Cross-check the live implementation constants against this spec. */
export function assertSpecConsistency() {
  if (R4_COHORT_SPEC.targetCompletedSessions !== 6) fail('R4_SPEC_COHORT_TARGET_DRIFT');
  if (R4_COHORT_SPEC.maxAttempts !== 8) fail('R4_SPEC_COHORT_ATTEMPT_DRIFT');
  if (R4_COHORT_SPEC.durationMinutes !== 45) fail('R4_SPEC_COHORT_DURATION_DRIFT');
  if (R4_COHORT_SPEC.captureMode !== '--r4-revisits') fail('R4_SPEC_CAPTURE_MODE_DRIFT');
  if (R4_COHORT_SPEC.maturationMode !== 'COHORT_DRAIN_ONLY') fail('R4_SPEC_MATURATION_DRIFT');
  if (PRIMARY_HORIZON_MS !== 300_000 || RESOLUTION_TOLERANCE_MS !== 60_000) fail('R4_SPEC_OUTCOME_DRIFT');
  if (BOOTSTRAP_REPLICATES !== 10_000) fail('R4_SPEC_BOOTSTRAP_DRIFT');
  if (MIN_RESOLVED_REFERENCES !== 100 || MIN_RESOLVED_MINTS !== 30 || MIN_DEFINED_REPLICATES !== 1000) fail('R4_SPEC_FLOOR_DRIFT');
  if (REFERENCE_RULE !== 'ALL_ELIGIBLE_REFERENCES') fail('R4_SPEC_REFERENCE_DRIFT');
  if (SESSION_CAPACITY_MIB.default !== 512) fail('R4_SPEC_STORAGE_DRIFT');
  if (R4_EXCLUSIONS.length !== 5) fail('R4_SPEC_EXCLUSIONS_DRIFT');
  return true;
}

assertSpecConsistency();
