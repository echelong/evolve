// Phase 5K FINAL - CLOSURE VALIDATION SURFACE.
//
// A single read-only re-export boundary for the Phase 5K closure validator.
//
// WHY THIS FILE EXISTS (same reasoning as the 5K.5-5K.9 surfaces)
//
// Every 5K.x validator asserts that nothing OUTSIDE `scripts/public-intelligence/`
// imports or names a protected phase module, and those checks enumerate
// `git ls-files`, so a TRACKED validator that reaches a phase module directly
// breaks them. The closure validator therefore imports ONE project module -
// this file - and reaches every phase through it.
//
// IT ADDS NO BEHAVIOUR. Every export below is a plain re-export. Nothing is
// wrapped, memoized, defaulted or altered.
//
// OFFLINE AND READ-ONLY BY IMPORT: it opens no socket, reads no environment,
// starts no process and writes no file.

// --- the closure definition and the acceptance runner (this phase) ----------
export * from './final-acceptance-definition.mjs';
export * as FINAL_ACCEPTANCE_5K from './final-acceptance.mjs';

// --- 5K.0 governance definition ---------------------------------------------
export {
  PUBLIC_INTELLIGENCE_CLASSIFICATION,
  PUBLIC_INTELLIGENCE_R4_BOUNDARY,
  PUBLIC_INTELLIGENCE_RAW_SCHEMA,
  PUBLIC_INTELLIGENCE_SCOPE,
  PUBLIC_INTELLIGENCE_COLLECTION_BOUNDS,
} from './definition.mjs';

// --- 5K.5 temporal revision evidence ----------------------------------------
export {
  PUBLIC_INTELLIGENCE_5K5_TEMPORAL_CLASSIFICATIONS,
  PUBLIC_INTELLIGENCE_5K5_REVISION_EVIDENCE_SOURCES,
} from './revision-chain.mjs';

// --- 5K.7 corroboration semantics -------------------------------------------
export {
  PUBLIC_INTELLIGENCE_5K7_PROVIDER_FAMILIES,
  PUBLIC_INTELLIGENCE_5K7_COVERAGE_STATUS,
  PUBLIC_INTELLIGENCE_5K7_COVERAGE_STATUS_VALUES,
  PUBLIC_INTELLIGENCE_5K7_COVERAGE_SEMANTICS,
  PUBLIC_INTELLIGENCE_5K7_INDEPENDENCE,
  PUBLIC_INTELLIGENCE_5K7_MARKET_LINKAGE,
} from './corroboration-definition.mjs';

// --- 5K.8 content-lineage semantics -----------------------------------------
export {
  PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS,
  PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS_VALUES,
  PUBLIC_INTELLIGENCE_5K8_TEXT_SEMANTICS,
  PUBLIC_INTELLIGENCE_5K8_DUPLICATION_SEMANTICS,
  PUBLIC_INTELLIGENCE_5K8_IDENTITY_RESOLUTION,
  PUBLIC_INTELLIGENCE_5K8_MARKET_LINKAGE,
} from './lineage-definition.mjs';

// --- 5K.9 descriptive-feature semantics -------------------------------------
export {
  PUBLIC_INTELLIGENCE_5K9_FEATURE_SEMANTICS,
  PUBLIC_INTELLIGENCE_5K9_TIME_SEMANTICS,
  PUBLIC_INTELLIGENCE_5K9_ENGAGEMENT_SEMANTICS,
  PUBLIC_INTELLIGENCE_5K9_MARKET_LINKAGE,
  PUBLIC_INTELLIGENCE_5K9_LINEAGE_COVERAGE_STATUS_VALUES,
} from './feature-definition.mjs';

// --- provider boundary ------------------------------------------------------
export { PROVIDER_HARD_CEILINGS } from './providers/common.mjs';

// --- governed protected-module inventory (kept inside the governed tree) ----
export { PROTECTED_MODULE_FRAGMENTS } from './corroboration-validation-surface.mjs';
