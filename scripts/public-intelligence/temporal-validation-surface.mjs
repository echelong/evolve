// Phase 5K.5 - TEMPORAL VALIDATION SURFACE.
//
// A single read-only re-export boundary for the Phase 5K.5 validator.
//
// WHY THIS FILE EXISTS
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
// 5K.4 respected this because it reached 5K.1-5K.3 exclusively through
// `research-surface.mjs`. Phase 5K.5 originally imported those modules directly,
// which broke all four isolation checks once the validator became a TRACKED
// file. (An untracked file escapes these checks, because they enumerate
// `git ls-files` - so this regression was invisible until the commit.)
//
// This module is the repair, and it is the same pattern 5K.4 already uses: the
// boundary modules themselves may reach 5K.1-5K.4 because they live INSIDE the
// governed `scripts/public-intelligence/` tree, while the validator reaches
// them only through here.
//
// IT ADDS NO BEHAVIOUR. Every export below is a plain re-export of an existing
// function or constant. Nothing is wrapped, memoized, defaulted or altered, so
// 5K.5 semantics - fingerprints, field classification, revision rules,
// engagement-state rules, snapshot accounting, query behavior, privacy and the
// exact-mint boundary - are provably untouched by this repair.
//
// OFFLINE AND READ-ONLY BY IMPORT: it opens no socket on import, reads no
// environment, starts no process and writes no file.

// NAMESPACES, NOT FLAT RE-EXPORTS
//
// 5K.4 and 5K.5 deliberately publish same-named entry points
// (`buildSnapshotManifest`, `validateSnapshotManifest`, `deriveSnapshotId`...).
// Flat re-exports would let one phase silently shadow the other inside this
// surface, so every phase is exposed under an explicit namespace instead. A
// caller always states which phase it means.
//
// The small flat block below holds only names that are provably unique across
// all phases, so it cannot shadow anything.

// --- 5K.0 governance definition ------------------------------------------
export { PUBLIC_INTELLIGENCE_CLASSIFICATION, canonical, digest } from './definition.mjs';

// --- 5K.1 ingestion boundary ----------------------------------------------
export {
  createMemoryStore, createNdjsonStore, ingestPublicObservation,
} from './index.mjs';
export { rawObservationFingerprint } from './provenance.mjs';
export { canonicalizeRawObservation, validateRawObservation5K1 } from './observation.mjs';
export { dedupIdentity5K1 } from './dedup.mjs';

// --- 5K.2 provider adapter (used to build fixture observations) ------------
export { mapStatusToRawObservation } from './providers/mastodon-mapper.mjs';

// --- 5K.3 collection runs -------------------------------------------------
export {
  buildCollectionPlan, executeCollectionRun, replayRun, loadRunArtifacts,
  assertSafeRuntimeRoot, PUBLIC_INTELLIGENCE_5K3_DEFAULT_RUNTIME_ROOT, manifestFingerprintOf,
} from './research-surface.mjs';

// --- phase namespaces ------------------------------------------------------
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

// --- 5K.4 policy, needed by the validator to build a 5K.4 corpus ---------
export { PUBLIC_INTELLIGENCE_5K4_DEFAULT_POLICY } from './corpus-membership.mjs';
