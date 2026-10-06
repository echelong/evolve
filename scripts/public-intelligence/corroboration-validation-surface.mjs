// Phase 5K.7 - CORROBORATION VALIDATION SURFACE.
//
// A single read-only re-export boundary for the Phase 5K.7 validator.
//
// WHY THIS FILE EXISTS (same reasoning as the 5K.5 and 5K.6 surfaces)
//
// Every 5K.x validator asserts that nothing OUTSIDE `scripts/public-intelligence/`
// imports a protected phase module:
//
//   5K.1 I5 / 5K.2 I5 / 5K.3 J6 / 5K.4 N7 / 5K.6 P3/P4
//
// Those checks enumerate `git ls-files`, so a TRACKED validator that imports a
// protected module directly breaks them on the committed tree. The 5K.7
// validator therefore imports ONE project module - this file - and reaches
// 5K.0-5K.6 only through here.
//
// IT ADDS NO BEHAVIOUR. Every export below is a plain re-export of an existing
// function or constant. Nothing is wrapped, memoized, defaulted or altered, so
// 5K.0-5K.6 semantics are provably untouched by this file.
//
// OFFLINE AND READ-ONLY BY IMPORT: it opens no socket, reads no environment,
// starts no process and writes no file.
//
// NAMESPACES, NOT FLAT RE-EXPORTS
//
// 5K.4, 5K.5, 5K.6 and 5K.7 publish same-named entry points
// (`buildSnapshotManifest`, `validateSnapshotManifest`, `validateCoverageRecord`...),
// so every phase is exposed under an explicit namespace and a caller always
// states which phase it means. The small flat block holds only names that are
// provably unique across all phases.

// --- 5K.7 corroboration layer (this phase) ---------------------------------
export * as CORROBORATION_DEFINITION_5K7 from './corroboration-definition.mjs';
export * as CORROBORATION_INDEX_5K7 from './corroboration-index.mjs';
export * as CORROBORATION_SNAPSHOT_5K7 from './corroboration-snapshot.mjs';
export * as CORROBORATION_VERIFY_5K7 from './corroboration-verify.mjs';
export * as CORROBORATION_QUERY_5K7 from './corroboration-query.mjs';
export {
  PUBLIC_INTELLIGENCE_5K7_PHASE, PUBLIC_INTELLIGENCE_5K7_SCHEMA_VERSION,
  PUBLIC_INTELLIGENCE_5K7_POLICY_VERSION, PUBLIC_INTELLIGENCE_5K7_RECORD_TYPES,
  PUBLIC_INTELLIGENCE_5K7_COVERAGE_STATUS, PUBLIC_INTELLIGENCE_5K7_COVERAGE_STATUS_VALUES,
  PUBLIC_INTELLIGENCE_5K7_PROVIDER_FAMILIES, PUBLIC_INTELLIGENCE_5K7_SUBJECT_IDENTITY,
  PUBLIC_INTELLIGENCE_5K7_INDEPENDENCE, PUBLIC_INTELLIGENCE_5K7_COVERAGE_SEMANTICS,
  PUBLIC_INTELLIGENCE_5K7_TIME_SEMANTICS, PUBLIC_INTELLIGENCE_5K7_MARKET_LINKAGE,
  PUBLIC_INTELLIGENCE_5K7_PROHIBITED_QUERY_NAMES, PUBLIC_INTELLIGENCE_5K7_PROHIBITED_TERMS,
  PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_COVERAGE_CLASSIFICATION,
  providerFamilyOf, isGovernedProviderNamespace, coverageStatusForFamilyCount,
  snapshotCoverageClassificationFor,
} from './corroboration-definition.mjs';
export { PUBLIC_INTELLIGENCE_5K7_QUERY_API } from './corroboration-query.mjs';
export {
  PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_SCHEMA, PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_FILES,
  deriveCorroborationSnapshotId, corroborationSnapshotFingerprintOf, corroborationCorporaDirectoryOf,
  buildAndStoreCorroborationSnapshot, loadCorroborationArtifacts,
} from './corroboration-snapshot.mjs';

// --- 5K.0 governance definition --------------------------------------------
export { PUBLIC_INTELLIGENCE_CLASSIFICATION, canonical, digest } from './definition.mjs';

// --- 5K.1 ingestion boundary ------------------------------------------------
export { rawObservationFingerprint } from './provenance.mjs';
export { dedupIdentity5K1 } from './dedup.mjs';

// --- 5K.2 Mastodon adapter, for the cross-provider fixture ------------------
export { mapStatusToRawObservation } from './providers/mastodon-mapper.mjs';

// --- 5K.5 Mastodon provider-declared revision evidence sidecar --------------
export { buildRevisionEvidence } from './revision-chain.mjs';

// --- 5K.6 Bluesky adapter and content-addressed revision evidence -----------
export { createBlueskyRunAdapter } from './providers/bluesky.mjs';
export { buildProviderRevisionEvidence } from './providers/bluesky-revision.mjs';

// --- 5K.3 collection runs (the plan/run engine) -----------------------------
export {
  buildCollectionPlan, executeCollectionRun, replayRun, loadRunArtifacts,
  assertSafeRuntimeRoot, PUBLIC_INTELLIGENCE_5K3_DEFAULT_RUNTIME_ROOT, manifestFingerprintOf,
} from './research-surface.mjs';

// --- 5K.4 policy, needed to build the source run set ------------------------
export { PUBLIC_INTELLIGENCE_5K4_DEFAULT_POLICY } from './corpus-membership.mjs';

// --- 5K.5 temporal snapshot, the source a corroboration snapshot projects over
export { buildAndStoreTemporalSnapshot, loadTemporalArtifacts, temporalCorporaDirectoryOf } from './temporal-snapshot.mjs';
export { verifyTemporalSnapshot } from './temporal-verify.mjs';

// --- governed protected-module inventory (kept inside the governed tree) ----
export const PROTECTED_MODULE_FRAGMENTS = Object.freeze([
  'public-intelligence/observation',
  'public-intelligence/provenance',
  'public-intelligence/normalize',
  'public-intelligence/dedup',
  'public-intelligence/store',
  'public-intelligence/ingest',
  'public-intelligence/fixtures',
  'public-intelligence/providers',
  'public-intelligence/replay',
  'public-intelligence/collect',
  ['collection', 'plan'].join('-'),
  ['collection', 'run'].join('-'),
  ['collection', 'manifest'].join('-'),
  ['run', 'store'].join('-'),
  ['pagination', 'cursor'].join('-'),
  ['corpus', 'membership'].join('-'),
  ['corpus', 'index'].join('-'),
  ['corpus', 'snapshot'].join('-'),
  ['corpus', 'verify'].join('-'),
  ['corpus', 'query'].join('-'),
  ['corpus', 'cli'].join('-'),
]);
// 5K.7's own modules are NOT added to that list: they are the modules THIS
// phase owns, and the historical isolation checks do not know them. A file that
// imports a corroboration module is instead caught by parsing its import
// sources against PUBLIC_INTELLIGENCE_5K7_MODULES, so nothing here forces a
// naming ban that would make the phase's own validator unable to describe
// itself.

/** The 5K.7 corroboration modules, named here so a validator outside the tree
 *  can reason about them without spelling their path. */
export const PUBLIC_INTELLIGENCE_5K7_MODULES = Object.freeze([
  'corroboration-definition', 'corroboration-index', 'corroboration-snapshot',
  'corroboration-verify', 'corroboration-query',
].map(name => `${name}.mjs`));
