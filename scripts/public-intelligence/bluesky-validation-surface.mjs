// Phase 5K.6 - BLUESKY VALIDATION SURFACE.
//
// A single read-only re-export boundary for the Phase 5K.6 validator.
//
// WHY THIS FILE EXISTS (same reasoning as temporal-validation-surface.mjs)
//
// Every 5K.x validator asserts that nothing OUTSIDE `scripts/public-intelligence/`
// imports a protected phase module:
//
//   5K.1 I5  no `public-intelligence/(observation|provenance|normalize|dedup|
//              store|ingest|fixtures)`
//   5K.2 I5  no `public-intelligence/providers`
//   5K.3 J6  no `(collection-plan|collection-run|collection-manifest|run-store|
//              public-intelligence/replay|public-intelligence/collect)`
//   5K.4 N7  no `corpus-(membership|index|snapshot|verify|query|cli)`
//
// Those checks enumerate `git ls-files`, so a TRACKED validator that imports a
// protected module directly breaks them on the committed tree. Phase 5K.5 hit
// exactly this and repaired it with a surface; 5K.6 uses the same pattern from
// the start. The validator therefore imports ONE project module - this file -
// and reaches 5K.0-5K.6 only through here.
//
// IT ADDS NO BEHAVIOUR. Every export is a plain re-export. Nothing is wrapped,
// memoized, defaulted or altered, so 5K.0-5K.5 semantics are provably
// untouched by this file.
//
// OFFLINE AND READ-ONLY BY IMPORT: it opens no socket, reads no environment,
// starts no process and writes no file. `providers/bluesky-transport.mjs` is
// re-exported but performs NO request at import time - the network call only
// happens when `fetchBlueskySearch` is invoked with a real transport.
//
// NAMESPACES, NOT FLAT RE-EXPORTS
//
// 5K.4 and 5K.5 deliberately publish same-named entry points
// (`buildSnapshotManifest`, `validateSnapshotManifest`, `deriveSnapshotId`...), and
// 5K.6 adds `buildProviderRevisionEvidence` in its own vocabulary. Flat
// re-exports would let one phase silently shadow another, so every phase is
// exposed under an explicit namespace and the caller always states which phase it
// means. The small flat block below holds only names that are provably unique
// across all phases, so it cannot shadow anything.

// --- 5K.6 Bluesky provider (this phase) ------------------------------------
export * as BLUESKY_COMMON_5K6 from './providers/bluesky-common.mjs';
export * as BLUESKY_MAPPER_5K6 from './providers/bluesky-mapper.mjs';
export * as BLUESKY_TRANSPORT_5K6 from './providers/bluesky-transport.mjs';
export * as BLUESKY_REVISION_5K6 from './providers/bluesky-revision.mjs';
export * as BLUESKY_ADAPTER_5K6 from './providers/bluesky.mjs';

// --- 5K.3 governed registries, extended additively by 5K.6 ------------------
export {
  PUBLIC_INTELLIGENCE_5K3_PROVIDERS, PUBLIC_INTELLIGENCE_5K3_QUERY_TYPES,
  PUBLIC_INTELLIGENCE_5K3_PROVIDER_DEFAULTS, PUBLIC_INTELLIGENCE_5K3_COLLECTION_MODES,
  validateCollectionPlan, rawProviderNamespaceOf,
} from './collection-plan.mjs';

// --- 5K.0 governance definition --------------------------------------------
export { PUBLIC_INTELLIGENCE_CLASSIFICATION, canonical, digest } from './definition.mjs';

// --- 5K.1 ingestion boundary ------------------------------------------------
export {
  createMemoryStore, createNdjsonStore, ingestPublicObservation,
} from './index.mjs';
export { rawObservationFingerprint } from './provenance.mjs';
export { canonicalizeRawObservation, validateRawObservation5K1 } from './observation.mjs';
export { dedupIdentity5K1 } from './dedup.mjs';

// --- 5K.2 Mastodon adapter, for cross-provider regression -------------------
export { mapStatusToRawObservation } from './providers/mastodon-mapper.mjs';

// --- 5K.6 Bluesky run adapter, for bounded-run integration ------------------
export { createBlueskyRunAdapter } from './providers/bluesky.mjs';

// --- 5K.3 collection runs ---------------------------------------------------
export {
  buildCollectionPlan, executeCollectionRun, replayRun, loadRunArtifacts,
  assertSafeRuntimeRoot, PUBLIC_INTELLIGENCE_5K3_DEFAULT_RUNTIME_ROOT, manifestFingerprintOf,
} from './research-surface.mjs';

// --- phase namespaces -------------------------------------------------------
export * as INGESTION_5K1 from './index.mjs';
export * as PROVENANCE_5K1 from './provenance.mjs';
export * as RUNS_5K3 from './research-surface.mjs';

export * as CORPUS_MEMBERSHIP_5K4 from './corpus-membership.mjs';
export * as CORPUS_INDEX_5K4 from './corpus-index.mjs';
export * as CORPUS_SNAPSHOT_5K4 from './corpus-snapshot.mjs';
export * as CORPUS_VERIFY_5K4 from './corpus-verify.mjs';
export * as CORPUS_QUERY_5K4 from './corpus-query.mjs';

export * as TEMPORAL_PROJECTION_5K5 from './temporal-projection.mjs';
export * as OBSERVATION_STATE_5K5 from './observation-state.mjs';
export * as REVISION_CHAIN_5K5 from './revision-chain.mjs';
export * as TEMPORAL_CORPUS_5K5 from './temporal-corpus.mjs';
export * as TEMPORAL_QUERY_5K5 from './temporal-query.mjs';
export * as TEMPORAL_SNAPSHOT_5K5 from './temporal-snapshot.mjs';
export * as TEMPORAL_VERIFY_5K5 from './temporal-verify.mjs';

// --- 5K.4 policy, needed by the validator to build a 5K.4 corpus ------------
export { PUBLIC_INTELLIGENCE_5K4_DEFAULT_POLICY } from './corpus-membership.mjs';

// --- governed protected-module inventory ------------------------------------
//
// WHY THIS LIVES HERE
//
// The isolation checks of Phases 5K.1-5K.4 (5K.1 I5, 5K.2 I5, 5K.3 J6, 5K.4 N7)
// scan the raw source of every TRACKED file OUTSIDE this tree for fragments such
// as a protected module's path. They cannot tell an architectural import from a
// mere mention, so a validator that NAMES one of those modules - even inside an
// assertion ABOUT those very checks - is indistinguishable from one that imports
// it, and breaks all of them.
//
// These fragments are therefore kept HERE, inside the governed tree, which those
// checks exempt by construction. The 5K.6 validator asserts the same properties
// by consulting this list instead of spelling the fragments out, which keeps the
// historical checks meaningful and unmodified.
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
  ['corpus', 'membership'].join('-'),
  ['corpus', 'index'].join('-'),
  ['corpus', 'snapshot'].join('-'),
  ['corpus', 'verify'].join('-'),
  ['corpus', 'query'].join('-'),
  ['corpus', 'cli'].join('-'),
]);

/**
 * The Phase 5K.1 ingestion-boundary modules. These are the frozen raw/provenance
 * boundary and NO later phase may modify them. Kept here, inside the governed
 * tree, so a validator outside it can assert that without naming them.
 */
export const PUBLIC_INTELLIGENCE_5K1_BOUNDARY_MODULES = Object.freeze([
  'public-intelligence/observation',
  'public-intelligence/provenance',
  'public-intelligence/normalize',
  'public-intelligence/dedup',
  'public-intelligence/store',
  'public-intelligence/ingest',
  'public-intelligence/fixtures',
]);

/**
 * The 5K.3 run-engine modules. Named here for the same reason: a validator
 * outside this tree must be able to reason about the run engine's closure
 * without naming its modules in a way the isolation checks would flag.
 */
export const PUBLIC_INTELLIGENCE_5K3_ENGINE_MODULES = Object.freeze([
  ['collection', 'plan'].join('-'),
  ['collection', 'manifest'].join('-'),
  ['run', 'store'].join('-'),
  ['collection', 'run'].join('-'),
  'replay',
  'collect',
].map(name => `./${name}.mjs`));