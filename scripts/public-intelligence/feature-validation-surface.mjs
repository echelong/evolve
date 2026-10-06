// Phase 5K.9 - DESCRIPTIVE FEATURE VALIDATION SURFACE.
//
// A single read-only re-export boundary for the Phase 5K.9 validator.
//
// WHY THIS FILE EXISTS (same reasoning as the 5K.5-5K.8 surfaces)
//
// Every 5K.x validator asserts that nothing OUTSIDE `scripts/public-intelligence/`
// imports a protected phase module, and those checks enumerate `git ls-files`, so
// a TRACKED validator that imports one directly breaks them on the committed
// tree. The 5K.9 validator therefore imports ONE project module - this file.
//
// IT ADDS NO BEHAVIOUR. Every export below is a plain re-export of an existing
// function or constant. Nothing is wrapped, memoized, defaulted or altered.
//
// OFFLINE AND READ-ONLY BY IMPORT: it opens no socket, reads no environment,
// starts no process and writes no file.

// --- everything the 5K.8 surface already governs (5K.0-5K.8) ---------------
export * from './lineage-validation-surface.mjs';

// --- 5K.9 descriptive feature layer (this phase) ---------------------------
export * as FEATURE_DEFINITION_5K9 from './feature-definition.mjs';
export * as FEATURE_EXTRACT_5K9 from './feature-extract.mjs';
export * as FEATURE_SNAPSHOT_5K9 from './feature-snapshot.mjs';
export * as FEATURE_VERIFY_5K9 from './feature-verify.mjs';
export * as FEATURE_QUERY_5K9 from './feature-query.mjs';
export {
  PUBLIC_INTELLIGENCE_5K9_PHASE, PUBLIC_INTELLIGENCE_5K9_SCHEMA_VERSION,
  PUBLIC_INTELLIGENCE_5K9_POLICY_VERSION, PUBLIC_INTELLIGENCE_5K9_RECORD_TYPES,
  PUBLIC_INTELLIGENCE_5K9_SUBJECT_IDENTITY, PUBLIC_INTELLIGENCE_5K9_COVERAGE_STATUS,
  PUBLIC_INTELLIGENCE_5K9_COVERAGE_STATUS_VALUES, PUBLIC_INTELLIGENCE_5K9_PROVIDER_FAMILIES,
  PUBLIC_INTELLIGENCE_5K9_LINEAGE_COVERAGE_STATUS, PUBLIC_INTELLIGENCE_5K9_LINEAGE_COVERAGE_STATUS_VALUES,
  PUBLIC_INTELLIGENCE_5K9_LINEAGE_CLASS_VALUES, PUBLIC_INTELLIGENCE_5K9_ENGAGEMENT_COUNTERS,
  PUBLIC_INTELLIGENCE_5K9_ENGAGEMENT_SEMANTICS, PUBLIC_INTELLIGENCE_5K9_FEATURE_SEMANTICS,
  PUBLIC_INTELLIGENCE_5K9_TIME_SEMANTICS, PUBLIC_INTELLIGENCE_5K9_MISSINGNESS_SEMANTICS,
  PUBLIC_INTELLIGENCE_5K9_ORDERING_SEMANTICS, PUBLIC_INTELLIGENCE_5K9_PRIVACY,
  PUBLIC_INTELLIGENCE_5K9_NO_NLP, PUBLIC_INTELLIGENCE_5K9_MARKET_LINKAGE,
  PUBLIC_INTELLIGENCE_5K9_PROHIBITED_TERMS, PUBLIC_INTELLIGENCE_5K9_PROHIBITED_QUERY_NAMES,
  PUBLIC_INTELLIGENCE_5K9_BUCKET_POLICY, PUBLIC_INTELLIGENCE_5K9_BUCKET_WIDTH_MS,
  lineageCoverageStatusFor, bucketStartOf, bucketEndOf, featureFingerprint,
} from './feature-definition.mjs';
export {
  PUBLIC_INTELLIGENCE_5K9_MINT_FEATURE_SCHEMA, PUBLIC_INTELLIGENCE_5K9_FAMILY_FEATURE_SCHEMA,
  PUBLIC_INTELLIGENCE_5K9_ENGAGEMENT_COUNTER_SCHEMA, PUBLIC_INTELLIGENCE_5K9_TEMPORAL_BUCKET_SCHEMA,
  PUBLIC_INTELLIGENCE_5K9_MISSINGNESS_SCHEMA, PUBLIC_INTELLIGENCE_5K9_MISSINGNESS_CATEGORIES,
  PUBLIC_INTELLIGENCE_5K9_MINT_FEATURE_RECORD_TYPE, buildAvailabilityIndex, summariseCounter,
  summariseEngagement, extractFeatures, buildFeatureSummary, checkFeatureSummary,
  validateMintFeature, featureProviderFamilies,
} from './feature-extract.mjs';
export {
  PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_SCHEMA, PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_FILES,
  PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_RECORD_TYPE, deriveFeatureSnapshotId, featureSnapshotFingerprintOf,
  featureCorporaDirectoryOf, assembleFeatureContent, rebuildFeatureSnapshot, buildFeatureSnapshotManifest,
  validateFeatureSnapshotManifest, checkFeatureSnapshotCounts, loadFeatureArtifacts,
  buildAndStoreFeatureSnapshot, envelopesOf,
} from './feature-snapshot.mjs';
export { verifyFeatureSnapshot } from './feature-verify.mjs';
export { PUBLIC_INTELLIGENCE_5K9_QUERY_API, createFeatureQuery, openVerifiedFeature } from './feature-query.mjs';
// 5K.5's temporal classification vocabulary, used to count revisions and state changes.
export { PUBLIC_INTELLIGENCE_5K5_TEMPORAL_CLASSIFICATION } from './revision-chain.mjs';

/** The 5K.9 feature modules, named here so a validator can reason about them
 *  without spelling their path. */
export const PUBLIC_INTELLIGENCE_5K9_MODULES = Object.freeze([
  'feature-definition', 'feature-extract', 'feature-snapshot', 'feature-verify', 'feature-query',
].map(name => `${name}.mjs`));
