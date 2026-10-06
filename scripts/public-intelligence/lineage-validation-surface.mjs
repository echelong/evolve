// Phase 5K.8 - CONTENT LINEAGE VALIDATION SURFACE.
//
// A single read-only re-export boundary for the Phase 5K.8 validator.
//
// WHY THIS FILE EXISTS (same reasoning as the 5K.5, 5K.6 and 5K.7 surfaces)
//
// Every 5K.x validator asserts that nothing OUTSIDE `scripts/public-intelligence/`
// imports a protected phase module:
//
//   5K.1 I5 / 5K.2 I5 / 5K.3 J6 / 5K.4 N7 / 5K.6 P3/P4
//
// Those checks enumerate `git ls-files`, so a TRACKED validator that imports a
// protected module directly breaks them on the committed tree. The 5K.8
// validator therefore imports ONE project module - this file - and reaches the
// earlier phases through the governed 5K.7 surface it re-exports.
//
// IT ADDS NO BEHAVIOUR. Every export below is a plain re-export of an existing
// function or constant. Nothing is wrapped, memoized, defaulted or altered.
//
// OFFLINE AND READ-ONLY BY IMPORT: it opens no socket, reads no environment,
// starts no process and writes no file.

// --- everything the 5K.7 surface already governs (5K.0-5K.7) ----------------
export * from './corroboration-validation-surface.mjs';

// --- 5K.8 lineage layer (this phase) ---------------------------------------
export * as LINEAGE_DEFINITION_5K8 from './lineage-definition.mjs';
export * as LINEAGE_INDEX_5K8 from './lineage-index.mjs';
export * as LINEAGE_SNAPSHOT_5K8 from './lineage-snapshot.mjs';
export * as LINEAGE_VERIFY_5K8 from './lineage-verify.mjs';
export * as LINEAGE_QUERY_5K8 from './lineage-query.mjs';
export {
  PUBLIC_INTELLIGENCE_5K8_PHASE, PUBLIC_INTELLIGENCE_5K8_SCHEMA_VERSION,
  PUBLIC_INTELLIGENCE_5K8_POLICY_VERSION, PUBLIC_INTELLIGENCE_5K8_RECORD_TYPES,
  PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS, PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS_VALUES,
  PUBLIC_INTELLIGENCE_5K8_MATCH_LAYERS, PUBLIC_INTELLIGENCE_5K8_REFERENCE_STATUS,
  PUBLIC_INTELLIGENCE_5K8_REFERENCE_STATUS_VALUES, PUBLIC_INTELLIGENCE_5K8_TEXT_SEMANTICS,
  PUBLIC_INTELLIGENCE_5K8_DUPLICATION_SEMANTICS, PUBLIC_INTELLIGENCE_5K8_PROVIDER_SEMANTICS,
  PUBLIC_INTELLIGENCE_5K8_PROVIDER_FAMILIES, PUBLIC_INTELLIGENCE_5K8_REFERENCE_SEMANTICS,
  PUBLIC_INTELLIGENCE_5K8_GOVERNED_PERMALINK_SHAPES, PUBLIC_INTELLIGENCE_5K8_VERSION_SEMANTICS,
  PUBLIC_INTELLIGENCE_5K8_TIME_SEMANTICS, PUBLIC_INTELLIGENCE_5K8_MISSINGNESS_SEMANTICS,
  PUBLIC_INTELLIGENCE_5K8_DIVERSITY_SEMANTICS, PUBLIC_INTELLIGENCE_5K8_PRIVACY,
  PUBLIC_INTELLIGENCE_5K8_IDENTITY_RESOLUTION, PUBLIC_INTELLIGENCE_5K8_MARKET_LINKAGE,
  PUBLIC_INTELLIGENCE_5K8_PROHIBITED_TERMS, PUBLIC_INTELLIGENCE_5K8_PROHIBITED_QUERY_NAMES,
  providerFamilyFor, lineageClassFor, isDuplicateClass, isMultiProviderFamilyLineage,
  lineageFingerprint,
} from './lineage-definition.mjs';
export {
  PUBLIC_INTELLIGENCE_5K8_LINEAGE_SCHEMA, PUBLIC_INTELLIGENCE_5K8_CONTENT_VERSION_SCHEMA,
  PUBLIC_INTELLIGENCE_5K8_LINEAGE_RECORD_TYPE, PUBLIC_INTELLIGENCE_5K8_CONTENT_VERSION_RECORD_TYPE,
  governedPermalinkRefOf, canonicalPostRefOf, deriveContentVersionFingerprint, deriveLineageId,
  buildContentVersions, buildLineages, computeLineageAggregate, checkLineageAggregate,
  computeDistinctnessForMint, validateLineageContentVersion, validateLineageRecord,
} from './lineage-index.mjs';
export {
  PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_SCHEMA, PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_FILES,
  PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_RECORD_TYPE, deriveLineageSnapshotId, lineageSnapshotFingerprintOf,
  lineageCorporaDirectoryOf, assembleLineageContent, rebuildLineageSnapshot, buildLineageSnapshotManifest,
  validateLineageSnapshotManifest, checkLineageSnapshotCounts, loadLineageArtifacts,
  buildAndStoreLineageSnapshot,
} from './lineage-snapshot.mjs';
export { verifyLineageSnapshot } from './lineage-verify.mjs';
export {
  PUBLIC_INTELLIGENCE_5K8_QUERY_API, createLineageQuery, openVerifiedLineage, contentVersionsOfLineage,
} from './lineage-query.mjs';
// 5K.1's text fingerprints, reused UNCHANGED by this phase's matching.
export { rawTextFingerprint } from './provenance.mjs';

/** The 5K.8 lineage modules, named here so a validator can reason about them
 *  without spelling their path. */
export const PUBLIC_INTELLIGENCE_5K8_MODULES = Object.freeze([
  'lineage-definition', 'lineage-index', 'lineage-snapshot', 'lineage-verify', 'lineage-query',
].map(name => `${name}.mjs`));
