// Phase 5K FINAL - ACCEPTANCE AND CLOSURE: the definition module.
//
// WHAT THIS FILE IS
//
// Phase 5K feature development is COMPLETE. This module states, as data, the
// exact accepted implementation of the Phase 5K public-intelligence program and
// the two facts a closure record has to prove:
//
//   1. WHICH implementation was accepted - one deterministic governed-tree
//      inventory read from Git at the accepted commit, never from the working
//      filesystem, with one digest over it; and
//   2. WHAT was accepted - the complete phase inventory, the exact expected
//      validator results, the frozen boundaries, the frozen semantics of the
//      derived layers and the capabilities that are DEFERRED rather than
//      incomplete.
//
// It computes ONE deterministic identity - the authority fingerprint - over the
// whole record. There is no timestamp in that identity, no filesystem order, no
// object insertion-order dependence, no absolute path, no hostname, no username
// and no recursive dependency on the commit that carries the closure: the
// record is a function of the accepted implementation and the frozen governance
// constants only.
//
// ROLE SPLIT (kept deliberately small)
//
//   final-acceptance-definition.mjs  this file - pure data + pure functions
//   final-acceptance.mjs             the read-only acceptance runner (CLI)
//   final-acceptance-surface.mjs     the one-module re-export boundary
//   scripts/validate-phase5k-final.mjs  the >=100-check closure validator
//
// OFFLINE, READ-ONLY AND CLOCK-FREE BY IMPORT: this module opens no socket,
// reads no network, reads no environment, starts no process, writes no file and
// never reads a clock. Git access is INJECTED by the caller as a
// `(args) => Buffer` reader, so this module holds no host capability of its
// own. The only builtin it uses is `node:crypto`, for the one digest over blob
// BYTES that the governed inventory needs.
import { createHash } from 'node:crypto';
import {
  PUBLIC_INTELLIGENCE_CLASSIFICATION,
  PUBLIC_INTELLIGENCE_RAW_SCHEMA,
  PUBLIC_INTELLIGENCE_R4_BOUNDARY,
  PUBLIC_INTELLIGENCE_SCOPE,
  PUBLIC_INTELLIGENCE_COLLECTION_BOUNDS,
  canonical,
  digest,
} from './definition.mjs';
import {
  PUBLIC_INTELLIGENCE_5K5_TEMPORAL_CLASSIFICATIONS,
  PUBLIC_INTELLIGENCE_5K5_REVISION_EVIDENCE_SOURCES,
} from './revision-chain.mjs';
import {
  PUBLIC_INTELLIGENCE_5K7_PROVIDER_FAMILIES,
  PUBLIC_INTELLIGENCE_5K7_COVERAGE_STATUS,
  PUBLIC_INTELLIGENCE_5K7_COVERAGE_STATUS_VALUES,
  PUBLIC_INTELLIGENCE_5K7_COVERAGE_SEMANTICS,
  PUBLIC_INTELLIGENCE_5K7_INDEPENDENCE,
  PUBLIC_INTELLIGENCE_5K7_MARKET_LINKAGE,
} from './corroboration-definition.mjs';
import {
  PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS,
  PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS_VALUES,
  PUBLIC_INTELLIGENCE_5K8_TEXT_SEMANTICS,
  PUBLIC_INTELLIGENCE_5K8_DUPLICATION_SEMANTICS,
  PUBLIC_INTELLIGENCE_5K8_IDENTITY_RESOLUTION,
  PUBLIC_INTELLIGENCE_5K8_MARKET_LINKAGE,
} from './lineage-definition.mjs';
import {
  PUBLIC_INTELLIGENCE_5K9_FEATURE_SEMANTICS,
  PUBLIC_INTELLIGENCE_5K9_TIME_SEMANTICS,
  PUBLIC_INTELLIGENCE_5K9_ENGAGEMENT_SEMANTICS,
  PUBLIC_INTELLIGENCE_5K9_MARKET_LINKAGE,
  PUBLIC_INTELLIGENCE_5K9_LINEAGE_COVERAGE_STATUS_VALUES,
} from './feature-definition.mjs';
import { PROVIDER_HARD_CEILINGS } from './providers/common.mjs';

// ---------------------------------------------------------------------------
// 1. CLOSURE RECORD IDENTITY
// ---------------------------------------------------------------------------

export const PHASE_5K_FINAL_SCHEMA_VERSION = '5K.final.0';
export const PHASE_5K_FINAL_RECORD_TYPE = 'phase5k_final_authority';
export const PHASE_5K_FINAL_STATUS = 'CLOSED';
export const PHASE_5K_FINAL_PROGRAM_LABEL = 'PHASE_5K_PUBLIC_SOCIAL_INTELLIGENCE';

/** The accepted implementation. Recorded at the starting gate of the closure. */
export const PHASE_5K_ACCEPTED_IMPLEMENTATION_HEAD = 'ed56ed17e366cffb59d088820b69a007890b538a';

/** The R4 C1 authority commit. Read-only historical context; never re-run. */
export const PHASE_5K_FINAL_R4_AUTHORITY_HEAD = '1c30264fb87876eeaf229e25c5cdc5adca429b40';

// The closure surface. These files ARE the acceptance machinery and are the
// only files the closure commit may add inside the governed tree.
export const PHASE_5K_FINAL_AUTHORITY_PATH = 'docs/PHASE5K-FINAL-AUTHORITY.json';
export const PHASE_5K_FINAL_DOCUMENT_PATH = 'docs/PHASE5K-FINAL-ACCEPTANCE.md';
export const PHASE_5K_FINAL_VALIDATOR_PATH = 'scripts/validate-phase5k-final.mjs';
export const PHASE_5K_FINAL_DEFINITION_PATH = 'scripts/public-intelligence/final-acceptance-definition.mjs';
export const PHASE_5K_FINAL_RUNNER_PATH = 'scripts/public-intelligence/final-acceptance.mjs';
export const PHASE_5K_FINAL_SURFACE_PATH = 'scripts/public-intelligence/final-acceptance-surface.mjs';

export const PHASE_5K_FINAL_CLOSURE_FILES = Object.freeze([
  PHASE_5K_FINAL_DEFINITION_PATH,
  PHASE_5K_FINAL_SURFACE_PATH,
  PHASE_5K_FINAL_RUNNER_PATH,
  PHASE_5K_FINAL_VALIDATOR_PATH,
  PHASE_5K_FINAL_DOCUMENT_PATH,
  PHASE_5K_FINAL_AUTHORITY_PATH,
]);

// ---------------------------------------------------------------------------
// 2. GOVERNED TREE SELECTION
// ---------------------------------------------------------------------------

/**
 * The selection rules for the governed inventory. The inventory is built from
 * the TRACKED blobs of the accepted commit, so it can never pick up an
 * unrelated working-tree file, a runtime capture or a build artifact.
 */
export const PHASE_5K_FINAL_SELECTION_RULES = Object.freeze([
  'scripts/public-intelligence/**',
  'scripts/validate-phase5k*.mjs',
  'docs/PHASE5K*.md',
]);

/** True when a repository-relative path is part of the accepted 5K surface. */
export function isGovernedPhase5KPath(relative) {
  if (typeof relative !== 'string' || relative.length === 0) return false;
  if (relative.startsWith('scripts/public-intelligence/')) return true;
  if (/^scripts\/validate-phase5k[0-9.-]*\.mjs$/.test(relative)) return true;
  if (/^docs\/PHASE5K[A-Za-z0-9-]*\.md$/.test(relative)) return true;
  return false;
}

/** True when the path is one of the records the CLOSURE commit may add. */
export function isClosureSurfacePath(relative) {
  return PHASE_5K_FINAL_CLOSURE_FILES.includes(relative);
}

// ---------------------------------------------------------------------------
// 3. PHASE INVENTORY AND EXPECTED VALIDATOR RESULTS
// ---------------------------------------------------------------------------

/**
 * The complete Phase 5K phase inventory. Every accepted layer appears exactly
 * once, in the governed order, with the validator and the document that carry
 * it. There is no implied successor: the last accepted layer is 5K.9.
 */
export const PHASE_5K_FINAL_PHASES = Object.freeze([
  Object.freeze({ phase: '5K.0', title: 'Public social intelligence research governance', status: 'ACCEPTED', validator: 'scripts/validate-phase5k.mjs', document: 'docs/PHASE5K-PUBLIC-SOCIAL-INTELLIGENCE.md', expectedPassed: 32, expectedTotal: 32 }),
  Object.freeze({ phase: '5K.1', title: 'Ingestion boundary, provenance and normalization', status: 'ACCEPTED', validator: 'scripts/validate-phase5k1.mjs', document: 'docs/PHASE5K1-INGESTION-PROVENANCE.md', expectedPassed: 64, expectedTotal: 64 }),
  Object.freeze({ phase: '5K.2', title: 'First bounded public provider (Mastodon)', status: 'ACCEPTED', validator: 'scripts/validate-phase5k2.mjs', document: 'docs/PHASE5K2-FIRST-PROVIDER.md', expectedPassed: 70, expectedTotal: 70 }),
  Object.freeze({ phase: '5K.3', title: 'Bounded collection runs', status: 'ACCEPTED', validator: 'scripts/validate-phase5k3.mjs', document: 'docs/PHASE5K3-COLLECTION-RUNS.md', expectedPassed: 96, expectedTotal: 96 }),
  Object.freeze({ phase: '5K.4', title: 'Cross-run corpus construction', status: 'ACCEPTED', validator: 'scripts/validate-phase5k4.mjs', document: 'docs/PHASE5K4-CROSS-RUN-CORPUS.md', expectedPassed: 116, expectedTotal: 116 }),
  Object.freeze({ phase: '5K.5', title: 'Temporal evidence semantics', status: 'ACCEPTED', validator: 'scripts/validate-phase5k5.mjs', document: 'docs/PHASE5K5-TEMPORAL-REVISIONS.md', expectedPassed: 130, expectedTotal: 130 }),
  Object.freeze({ phase: '5K.5.1', title: 'Reproducible temporal revision evidence', status: 'ACCEPTED', validator: 'scripts/validate-phase5k5-1.mjs', document: 'docs/PHASE5K5-TEMPORAL-REVISIONS.md', expectedPassed: 27, expectedTotal: 27 }),
  Object.freeze({ phase: '5K.6', title: 'Second bounded public provider (Bluesky)', status: 'ACCEPTED', validator: 'scripts/validate-phase5k6.mjs', document: 'docs/PHASE5K6-BLUESKY-PROVIDER.md', expectedPassed: 166, expectedTotal: 166 }),
  Object.freeze({ phase: '5K.6.1', title: 'Provider-scoped collection bounds', status: 'ACCEPTED', validator: 'scripts/validate-phase5k6-1.mjs', document: 'docs/PHASE5K6-BLUESKY-PROVIDER.md', expectedPassed: 57, expectedTotal: 57 }),
  Object.freeze({ phase: '5K.6.2', title: 'Terminal exhaustion compatibility', status: 'ACCEPTED', validator: 'scripts/validate-phase5k6-2.mjs', document: 'docs/PHASE5K6-BLUESKY-PROVIDER.md', expectedPassed: 58, expectedTotal: 58 }),
  Object.freeze({ phase: '5K.6.3', title: 'Provider-neutral pagination cursors', status: 'ACCEPTED', validator: 'scripts/validate-phase5k6-3.mjs', document: 'docs/PHASE5K6-BLUESKY-PROVIDER.md', expectedPassed: 71, expectedTotal: 71 }),
  Object.freeze({ phase: '5K.7', title: 'Cross-provider corroboration as coverage', status: 'ACCEPTED', validator: 'scripts/validate-phase5k7.mjs', document: 'docs/PHASE5K7-CROSS-PROVIDER-CORROBORATION.md', expectedPassed: 153, expectedTotal: 153 }),
  Object.freeze({ phase: '5K.8', title: 'Content lineage and duplication semantics', status: 'ACCEPTED', validator: 'scripts/validate-phase5k8.mjs', document: 'docs/PHASE5K8-CONTENT-LINEAGE.md', expectedPassed: 164, expectedTotal: 164 }),
  Object.freeze({ phase: '5K.9', title: 'Descriptive evidence features', status: 'ACCEPTED', validator: 'scripts/validate-phase5k9.mjs', document: 'docs/PHASE5K9-DESCRIPTIVE-FEATURES.md', expectedPassed: 186, expectedTotal: 186 }),
]);

/** The governed phase order. Anything else - including a 5K.10 - is not 5K. */
export const PHASE_5K_FINAL_PHASE_ORDER = Object.freeze(
  PHASE_5K_FINAL_PHASES.map(entry => entry.phase),
);

/** The exact command set the acceptance run executes, one per phase. */
export const PHASE_5K_FINAL_VALIDATORS = Object.freeze(
  PHASE_5K_FINAL_PHASES.map(entry => entry.validator),
);

/** The exact historical assertion total pinned by this closure. */
export const PHASE_5K_FINAL_HISTORICAL_ASSERTION_TOTAL = 1390;

/** The exact report line a phase validator must print for its phase. */
export function expectedReportLine(entry) {
  return `Phase ${entry.phase}: ${entry.expectedPassed}/${entry.expectedTotal} passed`;
}

// ---------------------------------------------------------------------------
// 4. FROZEN SEMANTICS OF THE ACCEPTED DERIVED LAYERS
// ---------------------------------------------------------------------------

/**
 * The semantics actually declared by the accepted modules. The authority binds
 * these values, so a later phase cannot silently re-mean a 5K layer: changing
 * any of them changes the record's fingerprint. `livePhase5KSemantics()` is the
 * same read taken at verification time, which is what makes the binding a
 * check rather than a copy.
 */
export function livePhase5KSemantics() {
  return {
    temporal: {
      classifications: [...PUBLIC_INTELLIGENCE_5K5_TEMPORAL_CLASSIFICATIONS],
      revisionEvidenceSources: [...PUBLIC_INTELLIGENCE_5K5_REVISION_EVIDENCE_SOURCES],
    },
    corroboration: {
      coverageStatus: { ...PUBLIC_INTELLIGENCE_5K7_COVERAGE_STATUS },
      coverageStatusValues: [...PUBLIC_INTELLIGENCE_5K7_COVERAGE_STATUS_VALUES],
      independence: { ...PUBLIC_INTELLIGENCE_5K7_INDEPENDENCE },
      coverageSemantics: { ...PUBLIC_INTELLIGENCE_5K7_COVERAGE_SEMANTICS },
      marketLinkage: { ...PUBLIC_INTELLIGENCE_5K7_MARKET_LINKAGE },
    },
    lineage: {
      lineageClass: { ...PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS },
      lineageClassValues: [...PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS_VALUES],
      textSemantics: { ...PUBLIC_INTELLIGENCE_5K8_TEXT_SEMANTICS },
      duplicationSemantics: { ...PUBLIC_INTELLIGENCE_5K8_DUPLICATION_SEMANTICS },
      identityResolution: { ...PUBLIC_INTELLIGENCE_5K8_IDENTITY_RESOLUTION },
      marketLinkage: { ...PUBLIC_INTELLIGENCE_5K8_MARKET_LINKAGE },
    },
    features: {
      featureSemantics: { ...PUBLIC_INTELLIGENCE_5K9_FEATURE_SEMANTICS },
      timeSemantics: { ...PUBLIC_INTELLIGENCE_5K9_TIME_SEMANTICS },
      engagementSemantics: { ...PUBLIC_INTELLIGENCE_5K9_ENGAGEMENT_SEMANTICS },
      marketLinkage: { ...PUBLIC_INTELLIGENCE_5K9_MARKET_LINKAGE },
      lineageCoverageStatusValues: [...PUBLIC_INTELLIGENCE_5K9_LINEAGE_COVERAGE_STATUS_VALUES],
    },
    governance: {
      classification: { ...PUBLIC_INTELLIGENCE_CLASSIFICATION },
      r4Boundary: { ...PUBLIC_INTELLIGENCE_R4_BOUNDARY },
      scope: { ...PUBLIC_INTELLIGENCE_SCOPE, prohibited: [...PUBLIC_INTELLIGENCE_SCOPE.prohibited] },
      collectionBounds: {
        unboundedCollectionPermitted: PUBLIC_INTELLIGENCE_COLLECTION_BOUNDS.unboundedCollectionPermitted,
        requiredBoundFields: [...PUBLIC_INTELLIGENCE_COLLECTION_BOUNDS.requiredBoundFields],
      },
      personalData: { forbiddenFields: [...PUBLIC_INTELLIGENCE_RAW_SCHEMA.forbiddenFields] },
      providerFamilies: [...PUBLIC_INTELLIGENCE_5K7_PROVIDER_FAMILIES],
      providerHardCeilings: { ...PROVIDER_HARD_CEILINGS },
    },
  };
}

// ---------------------------------------------------------------------------
// 5. BOUNDARY FLAGS
// ---------------------------------------------------------------------------

/**
 * The frozen Phase 5K boundary. Every flag is stated positively once, so a
 * missing flag is a failure rather than an admission: the validator compares
 * the whole block, not individual reads.
 */
export const PHASE_5K_FINAL_BOUNDARY_FLAGS = Object.freeze({
  // What the program IS.
  researchOnly: true,
  observerOnly: true,
  paperOnly: true,
  developmentOnly: true,
  // What it must never become.
  tradingAuthority: false,
  engineAuthority: false,
  arenaEligible: false,
  promotionEligible: false,
  // Market surface.
  priceDataPermitted: false,
  marketOutcomeLinkagePermitted: false,
  profitabilityInferencePermitted: false,
  // Interpretation surface.
  predictionPermitted: false,
  recommendationPermitted: false,
  rankingPermitted: false,
  assetScoringPermitted: false,
  // Financial authority.
  walletAuthority: false,
  signerAuthority: false,
  swapAuthority: false,
  rpcWriteAuthority: false,
  // Identity surface.
  crossProviderIdentityResolutionPermitted: false,
  // Live surface at acceptance time.
  providerContactPermittedDuringAcceptance: false,
  liveNetworkDependencyInDerivedLayers: false,
  // Data surface.
  personalDataSurfaceExpansionPermitted: false,
  // Historical surface.
  r4MutationPermitted: false,
  evolveStorageWritePermitted: false,
  runtimeCapturePermittedInClosure: false,
  // How the authority itself behaves.
  authorityIsDeterministic: true,
  authorityIsSelfVerifying: true,
});

/** The boundary block, as a canonical string, for equality checks. */
export function boundaryFlagsIdentity(flags = PHASE_5K_FINAL_BOUNDARY_FLAGS) {
  return canonical(flags);
}

// ---------------------------------------------------------------------------
// 6. DEFERRED CAPABILITIES
// ---------------------------------------------------------------------------

/**
 * Capabilities that are OUT OF SCOPE for Phase 5K. They are recorded as
 * DEFERRED - a decision, not a defect - and each one requires a separately
 * governed future program before it may begin. No such program is created here,
 * and the successor is deliberately unnamed.
 */
export const PHASE_5K_FINAL_DEFERRED_CAPABILITIES = Object.freeze({
  status: 'DEFERRED',
  reason: 'OUT_OF_SCOPE_FOR_PHASE_5K',
  requiresSeparateGovernedProgram: true,
  requiresGovernanceDecision: true,
  successorProgramDeclared: false,
  impliedSuccessorPhase: null,
  capabilities: Object.freeze([
    Object.freeze({ id: 'MARKET_PRICE_LINKAGE', capability: 'Linking public observations to price data' }),
    Object.freeze({ id: 'RETURN_CORRELATION', capability: 'Correlating social evidence with subsequent returns' }),
    Object.freeze({ id: 'VOLATILITY_LINKAGE', capability: 'Linking social evidence to volatility measures' }),
    Object.freeze({ id: 'PREDICTIVE_MODELLING', capability: 'Any predictive model over social evidence' }),
    Object.freeze({ id: 'PROFITABILITY_RESEARCH', capability: 'Any profitability or alpha inference' }),
    Object.freeze({ id: 'RANKING', capability: 'Ranking subjects, authors, posts or content by any measure' }),
    Object.freeze({ id: 'RECOMMENDATION', capability: 'Recommending any subject or action' }),
    Object.freeze({ id: 'TRADE_CANDIDATE_SELECTION', capability: 'Selecting trade candidates from public evidence' }),
    Object.freeze({ id: 'EXECUTION', capability: 'Any execution, order submission or transaction construction' }),
    Object.freeze({ id: 'WALLET_OR_SIGNING', capability: 'Any wallet, signer or key custody capability' }),
    Object.freeze({ id: 'ARENA_INTEGRATION', capability: 'Any Arena eligibility or exposure' }),
    Object.freeze({ id: 'ENGINE_PROMOTION', capability: 'Any engine promotion or fitness influence' }),
  ]),
});

// ---------------------------------------------------------------------------
// 7. WHAT 5K PROVIDES AND WHAT IT NEVER CLAIMS
// ---------------------------------------------------------------------------

/** What the accepted program actually provides. None of it is a signal. */
export const PHASE_5K_FINAL_PROVIDED_CAPABILITIES = Object.freeze([
  'authenticated public observation evidence',
  'provider-scoped provenance',
  'bounded collection',
  'offline replay',
  'cross-run corpus construction',
  'temporal content and state semantics',
  'provider-declared revision evidence',
  'Mastodon and Bluesky support',
  'provider-family coverage accounting',
  'cross-provider content lineage',
  'deterministic descriptive evidence features',
  'explicit missingness',
  'tamper verification',
  'deterministic snapshots',
  'read-only research query surfaces',
]);

/** The frozen non-claims. "More" is never "better" anywhere in Phase 5K. */
export const PHASE_5K_FINAL_NON_CLAIMS = Object.freeze([
  'More observations != more truth.',
  'More providers != more confidence.',
  'More engagement != importance.',
  'More lineages != stronger truth.',
  'More revisions != suspicion.',
  'Multi-provider presence != consensus.',
  'Identical cross-provider content != proof of copying.',
  'Distinct content != independent human authorship.',
  'Temporal ordering != causality.',
  'Descriptive feature != predictive feature.',
  'Exact mint identity != investment relevance.',
  'No Phase 5K output is a trading signal.',
]);

// ---------------------------------------------------------------------------
// 8. DETERMINISM HELPERS
// ---------------------------------------------------------------------------

/** SHA-256 over raw BYTES. Used for governed blob content digests. */
export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The canonical identity string of a closure record: the WHOLE record minus
 * `authorityFingerprint`, in canonical JSON (sorted keys, no whitespace). Every
 * property of the record is therefore bound by the fingerprint, and key order
 * in the source object is irrelevant.
 */
export function canonicalAuthorityIdentity(record) {
  const { authorityFingerprint, ...rest } = record;
  void authorityFingerprint;
  return canonical(rest);
}

/** The authority fingerprint of a closure record. */
export function authorityFingerprintOf(record) {
  return sha256Hex(Buffer.from(canonicalAuthorityIdentity(record), 'utf8'));
}

// ---------------------------------------------------------------------------
// 9. GOVERNED TREE INVENTORY (from Git, never from the filesystem)
// ---------------------------------------------------------------------------

/** Parse `git ls-tree -r -z` output into blob entries. */
export function parseTreeEntries(output) {
  return output.split('\0').filter(Boolean).map(line => {
    const tab = line.indexOf('\t');
    const [mode, type, objectId] = line.slice(0, tab).split(' ');
    return { mode, type, objectId, path: line.slice(tab + 1) };
  });
}

/**
 * Build the governed inventory from the accepted commit's tracked blobs.
 *
 * `git` is injected: `(args: string[]) => Buffer`. The closure never reads the
 * working filesystem, so an untracked file, a runtime capture or a build
 * artifact can never enter the inventory.
 */
export function buildGovernedInventory({ git, commit = PHASE_5K_ACCEPTED_IMPLEMENTATION_HEAD } = {}) {
  if (typeof git !== 'function') throw new Error('PHASE_5K_FINAL_GIT_READER_REQUIRED');
  const entries = parseTreeEntries(git(['ls-tree', '-r', '-z', commit]).toString('utf8'));
  const files = entries
    .filter(entry => entry.type === 'blob' && isGovernedPhase5KPath(entry.path))
    .map(entry => ({
      path: entry.path,
      gitMode: entry.mode,
      gitBlobObjectId: entry.objectId,
      contentDigest: sha256Hex(git(['cat-file', 'blob', entry.objectId])),
    }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { commit, files };
}

/** The exact members the governed-tree digest is computed over. */
export function governedInventoryMembers(files) {
  return files.map(entry => [entry.path, entry.gitMode, entry.gitBlobObjectId, entry.contentDigest]);
}

/** One digest over the whole governed inventory, deterministically ordered. */
export function governedTreeDigestOf(files, commit = PHASE_5K_ACCEPTED_IMPLEMENTATION_HEAD) {
  return digest({
    schemaVersion: PHASE_5K_FINAL_SCHEMA_VERSION,
    inventorySource: 'GIT_TREE_AT_ACCEPTED_COMMIT',
    acceptedImplementationHead: commit,
    members: governedInventoryMembers(files),
  });
}

// ---------------------------------------------------------------------------
// 10. THE CLOSURE RECORD
// ---------------------------------------------------------------------------

/** The exact top-level key set of the closure record, in build order. */
export const PHASE_5K_FINAL_AUTHORITY_KEYS = Object.freeze([
  'schemaVersion',
  'recordType',
  'status',
  'programLabel',
  'acceptedImplementationHead',
  'acceptanceScope',
  'classification',
  'phaseInventory',
  'validatorExpectations',
  'governedInventory',
  'providerBoundary',
  'semantics',
  'providedCapabilities',
  'nonClaims',
  'boundaryFlags',
  'deferredCapabilities',
  'closureSurface',
  'authorityFingerprint',
]);

/**
 * Keys that would make the record runtime data rather than a governance
 * artifact. None may appear anywhere in the record, at any depth.
 */
export const PHASE_5K_FINAL_FORBIDDEN_AUTHORITY_FIELDS = Object.freeze([
  'generatedAt', 'createdAt', 'updatedAt', 'currentTime', 'timestamp', 'checkedAt',
  'ranAt', 'startedAt', 'finishedAt', 'host', 'hostname', 'username', 'user',
  'machine', 'cwd', 'repoRoot', 'absolutePath', 'temporaryPath', 'log', 'logs',
  'credentials', 'credential', 'token', 'secret', 'password', 'apiKey',
  'networkCapture', 'marketData', 'postBodies', 'displayNames', 'avatars',
]);

/**
 * Build the complete deterministic closure record for the accepted
 * implementation. Every value is either a frozen governance constant or read
 * from the accepted commit's tracked blobs; nothing is read from the clock, the
 * environment, the host or the working tree.
 */
export function buildAuthorityRecord({ git, commit = PHASE_5K_ACCEPTED_IMPLEMENTATION_HEAD } = {}) {
  const inventory = buildGovernedInventory({ git, commit });
  const semantics = livePhase5KSemantics();
  const record = {
    schemaVersion: PHASE_5K_FINAL_SCHEMA_VERSION,
    recordType: PHASE_5K_FINAL_RECORD_TYPE,
    status: PHASE_5K_FINAL_STATUS,
    programLabel: PHASE_5K_FINAL_PROGRAM_LABEL,
    acceptedImplementationHead: PHASE_5K_ACCEPTED_IMPLEMENTATION_HEAD,
    acceptanceScope: {
      recordIsAcceptanceOnly: true,
      addsPublicIntelligenceFunctionality: false,
      computesNewScientificResult: false,
      reinterpretsR4: false,
      createsSuccessorProgram: false,
      impliedSuccessorPhase: null,
    },
    classification: {
      developmentOnly: PUBLIC_INTELLIGENCE_CLASSIFICATION.developmentOnly,
      researchOnly: PUBLIC_INTELLIGENCE_CLASSIFICATION.researchOnly,
      observerOnly: PUBLIC_INTELLIGENCE_CLASSIFICATION.observerOnly,
      paperOnly: PUBLIC_INTELLIGENCE_CLASSIFICATION.paperOnly,
      tradingAuthority: PUBLIC_INTELLIGENCE_CLASSIFICATION.tradingAuthority,
      engineAuthority: PUBLIC_INTELLIGENCE_CLASSIFICATION.engineAuthority,
      arenaEligible: PUBLIC_INTELLIGENCE_CLASSIFICATION.arenaEligible,
      promotionEligible: PUBLIC_INTELLIGENCE_CLASSIFICATION.promotionEligible,
      profitabilityInferencePermitted: PUBLIC_INTELLIGENCE_CLASSIFICATION.profitabilityInferencePermitted,
      evidenceClass: PUBLIC_INTELLIGENCE_R4_BOUNDARY.evidenceClass,
      programStatus: PHASE_5K_FINAL_STATUS,
    },
    phaseInventory: PHASE_5K_FINAL_PHASES.map(entry => ({ ...entry })),
    validatorExpectations: {
      execution: 'ONE_NODE_PROCESS_PER_PHASE_VALIDATOR',
      successSignal: 'REPORTED_EXACT_PASS_COUNT',
      exitCodeAloneIsInsufficient: true,
      expectedHistoricalAssertions: PHASE_5K_FINAL_HISTORICAL_ASSERTION_TOTAL,
      order: [...PHASE_5K_FINAL_PHASE_ORDER],
      phases: PHASE_5K_FINAL_PHASES.map(entry => ({
        phase: entry.phase,
        validator: entry.validator,
        expectedPassed: entry.expectedPassed,
        expectedTotal: entry.expectedTotal,
      })),
    },
    governedInventory: {
      source: 'GIT_TREE_AT_ACCEPTED_COMMIT',
      selectionRules: [...PHASE_5K_FINAL_SELECTION_RULES],
      hashing: {
        canonicalization: 'CANONICAL_JSON_SORTED_KEYS',
        digest: 'SHA-256',
        memberFields: ['path', 'gitMode', 'gitBlobObjectId', 'contentDigest'],
      },
      fileCount: inventory.files.length,
      governedTreeDigest: governedTreeDigestOf(inventory.files, commit),
      files: inventory.files.map(entry => ({ ...entry })),
    },
    providerBoundary: {
      providerFamilies: [...PUBLIC_INTELLIGENCE_5K7_PROVIDER_FAMILIES],
      publicDataOnly: PUBLIC_INTELLIGENCE_SCOPE.publicDataOnly,
      authenticationPermitted: PUBLIC_INTELLIGENCE_SCOPE.authenticationPermitted,
      unboundedCollectionPermitted: PUBLIC_INTELLIGENCE_COLLECTION_BOUNDS.unboundedCollectionPermitted,
      providerContactDuringAcceptance: false,
      hardCeilings: { ...PROVIDER_HARD_CEILINGS },
    },
    semantics,
    providedCapabilities: [...PHASE_5K_FINAL_PROVIDED_CAPABILITIES],
    nonClaims: [...PHASE_5K_FINAL_NON_CLAIMS],
    boundaryFlags: { ...PHASE_5K_FINAL_BOUNDARY_FLAGS },
    deferredCapabilities: {
      status: PHASE_5K_FINAL_DEFERRED_CAPABILITIES.status,
      reason: PHASE_5K_FINAL_DEFERRED_CAPABILITIES.reason,
      requiresSeparateGovernedProgram: PHASE_5K_FINAL_DEFERRED_CAPABILITIES.requiresSeparateGovernedProgram,
      requiresGovernanceDecision: PHASE_5K_FINAL_DEFERRED_CAPABILITIES.requiresGovernanceDecision,
      successorProgramDeclared: PHASE_5K_FINAL_DEFERRED_CAPABILITIES.successorProgramDeclared,
      impliedSuccessorPhase: PHASE_5K_FINAL_DEFERRED_CAPABILITIES.impliedSuccessorPhase,
      capabilities: PHASE_5K_FINAL_DEFERRED_CAPABILITIES.capabilities.map(entry => ({ ...entry })),
    },
    closureSurface: {
      files: [...PHASE_5K_FINAL_CLOSURE_FILES],
      modifiesAcceptedImplementation: false,
      addsProviders: false,
      addsNetworkCapability: false,
      addsMarketAuthority: false,
      addsScientificClaim: false,
    },
  };
  return { ...record, authorityFingerprint: authorityFingerprintOf(record) };
}

/** The exact bytes of the source-controlled authority artifact. */
export function authorityArtifactBytes(record) {
  return Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// 11. VERIFICATION (pure: the record in, failures out)
// ---------------------------------------------------------------------------

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Collect every object key at any depth. */
function collectKeys(value, out = []) {
  if (Array.isArray(value)) { for (const item of value) collectKeys(item, out); return out; }
  if (!isPlainObject(value)) return out;
  for (const [key, inner] of Object.entries(value)) { out.push(key); collectKeys(inner, out); }
  return out;
}

/** Verify the closure record against the frozen closure constants. */
export function verifyAuthorityRecord(record, { commit = PHASE_5K_ACCEPTED_IMPLEMENTATION_HEAD } = {}) {
  const failures = [];
  const fail = code => failures.push(code);
  if (!isPlainObject(record)) return { ok: false, failures: ['AUTHORITY_RECORD_INVALID'] };

  if (record.schemaVersion !== PHASE_5K_FINAL_SCHEMA_VERSION) fail('AUTHORITY_SCHEMA_VERSION_INVALID');
  if (record.recordType !== PHASE_5K_FINAL_RECORD_TYPE) fail('AUTHORITY_RECORD_TYPE_INVALID');
  if (record.status !== PHASE_5K_FINAL_STATUS) fail('AUTHORITY_STATUS_NOT_CLOSED');
  if (record.programLabel !== PHASE_5K_FINAL_PROGRAM_LABEL) fail('AUTHORITY_PROGRAM_LABEL_INVALID');
  if (record.acceptedImplementationHead !== PHASE_5K_ACCEPTED_IMPLEMENTATION_HEAD) fail('AUTHORITY_ACCEPTED_HEAD_INVALID');

  const keys = Object.keys(record);
  if (canonical([...keys].sort()) !== canonical([...PHASE_5K_FINAL_AUTHORITY_KEYS].sort())) fail('AUTHORITY_KEY_SET_INVALID');

  const allKeys = collectKeys(record);
  for (const forbidden of PHASE_5K_FINAL_FORBIDDEN_AUTHORITY_FIELDS) {
    if (allKeys.includes(forbidden)) fail(`AUTHORITY_FORBIDDEN_FIELD:${forbidden}`);
  }
  const strings = [];
  const collectStrings = value => {
    if (typeof value === 'string') { strings.push(value); return; }
    if (Array.isArray(value)) { for (const item of value) collectStrings(item); return; }
    if (isPlainObject(value)) { for (const inner of Object.values(value)) collectStrings(inner); }
  };
  collectStrings(record);
  // The governed personal-data REFUSAL list legitimately names the fields it
  // refuses (`apiKey`, `bearerToken`, ...). Those names are declarations, not
  // credentials, so they are exempt from the credential-shape scan while every
  // other string in the record is not.
  const refusalList = new Set(record.semantics?.governance?.personalData?.forbiddenFields ?? []);
  for (const value of strings) {
    if (value.startsWith('/') || /(^|[/\\])(home|Users)[/\\]/.test(value)) fail('AUTHORITY_ABSOLUTE_PATH_PRESENT');
    if (/^[a-z]+:\/\//i.test(value)) fail('AUTHORITY_URL_PRESENT');
    if (!refusalList.has(value) && /bearer|authorization|password|secret|api[_-]?key/i.test(value)) fail('AUTHORITY_CREDENTIAL_SHAPE_PRESENT');
  }

  if (record.phaseInventory.map(entry => entry.phase).join(',') !== PHASE_5K_FINAL_PHASE_ORDER.join(',')) {
    fail('AUTHORITY_PHASE_INVENTORY_MISMATCH');
  }
  if (record.validatorExpectations?.phases?.length !== PHASE_5K_FINAL_PHASES.length) fail('AUTHORITY_VALIDATOR_EXPECTATIONS_INCOMPLETE');
  const expectedTotal = record.validatorExpectations?.phases?.reduce((sum, entry) => sum + entry.expectedPassed, 0);
  if (expectedTotal !== PHASE_5K_FINAL_HISTORICAL_ASSERTION_TOTAL) fail('AUTHORITY_HISTORICAL_ASSERTION_TOTAL_MISMATCH');
  if (record.validatorExpectations?.expectedHistoricalAssertions !== PHASE_5K_FINAL_HISTORICAL_ASSERTION_TOTAL) {
    fail('AUTHORITY_DECLARED_HISTORICAL_TOTAL_MISMATCH');
  }

  const files = record.governedInventory?.files;
  if (!Array.isArray(files) || files.length === 0) fail('AUTHORITY_GOVERNED_INVENTORY_EMPTY');
  else {
    if (record.governedInventory.fileCount !== files.length) fail('AUTHORITY_FILE_COUNT_MISMATCH');
    for (const entry of files) {
      if (typeof entry.path !== 'string' || !isGovernedPhase5KPath(entry.path)) fail('AUTHORITY_GOVERNED_PATH_INVALID');
      if (!/^100(644|755)$/.test(entry.gitMode)) fail('AUTHORITY_GIT_MODE_INVALID');
      if (!/^[0-9a-f]{40}$/.test(entry.gitBlobObjectId)) fail('AUTHORITY_BLOB_IDENTITY_INVALID');
      if (!/^[0-9a-f]{64}$/.test(entry.contentDigest)) fail('AUTHORITY_CONTENT_DIGEST_INVALID');
    }
    if (canonical(files.map(entry => entry.path)) !== canonical([...files.map(entry => entry.path)].sort())) {
      fail('AUTHORITY_GOVERNED_INVENTORY_UNSORTED');
    }
    if (governedTreeDigestOf(files, commit) !== record.governedInventory.governedTreeDigest) fail('AUTHORITY_GOVERNED_TREE_DIGEST_MISMATCH');
  }

  if (boundaryFlagsIdentity(record.boundaryFlags) !== boundaryFlagsIdentity()) fail('AUTHORITY_BOUNDARY_FLAGS_WEAKENED');
  if (record.deferredCapabilities?.status !== 'DEFERRED') fail('AUTHORITY_DEFERRED_STATUS_INVALID');
  if (record.deferredCapabilities?.requiresSeparateGovernedProgram !== true) fail('AUTHORITY_DEFERRED_REQUIRES_PROGRAM_FALSE');
  if (record.deferredCapabilities?.successorProgramDeclared !== false) fail('AUTHORITY_SUCCESSOR_PROGRAM_DECLARED');
  for (const required of PHASE_5K_FINAL_DEFERRED_CAPABILITIES.capabilities) {
    if (!record.deferredCapabilities?.capabilities?.some(entry => entry.id === required.id)) fail(`AUTHORITY_DEFERRED_CAPABILITY_MISSING:${required.id}`);
  }
  if (canonical(record.nonClaims) !== canonical(PHASE_5K_FINAL_NON_CLAIMS)) fail('AUTHORITY_NON_CLAIMS_MISMATCH');
  if (canonical(record.providedCapabilities) !== canonical(PHASE_5K_FINAL_PROVIDED_CAPABILITIES)) fail('AUTHORITY_PROVIDED_CAPABILITIES_MISMATCH');
  if (canonical(record.semantics) !== canonical(livePhase5KSemantics())) fail('AUTHORITY_SEMANTICS_MISMATCH');
  if (canonical(record.closureSurface?.files) !== canonical(PHASE_5K_FINAL_CLOSURE_FILES)) fail('AUTHORITY_CLOSURE_SURFACE_MISMATCH');
  if (record.closureSurface?.modifiesAcceptedImplementation !== false) fail('AUTHORITY_CLOSURE_MODIFIES_ACCEPTED_IMPLEMENTATION');

  if (record.authorityFingerprint !== authorityFingerprintOf(record)) fail('AUTHORITY_FINGERPRINT_MISMATCH');
  if (!/^[0-9a-f]{64}$/.test(String(record.authorityFingerprint))) fail('AUTHORITY_FINGERPRINT_FORMAT_INVALID');

  return { ok: failures.length === 0, failures };
}

// The canonical serialization and digest used by every binding above are the
// shared EVOLVE ones, re-exported so a validator outside the governed tree can
// recompute a fingerprint without naming their module.
export { canonical, digest };

/** Compare a stored record against the record the accepted commit rebuilds. */
export function verifyAuthorityAgainstGit(record, { git, commit = PHASE_5K_ACCEPTED_IMPLEMENTATION_HEAD } = {}) {
  const rebuilt = buildAuthorityRecord({ git, commit });
  const failures = [];
  if (canonical(rebuilt) !== canonical(record)) failures.push('AUTHORITY_ARTIFACT_NOT_REPRODUCIBLE_FROM_ACCEPTED_COMMIT');
  const fromGit = buildGovernedInventory({ git, commit });
  const declared = record.governedInventory?.files ?? [];
  if (canonical(fromGit.files) !== canonical(declared)) failures.push('AUTHORITY_GOVERNED_INVENTORY_NOT_REPRODUCIBLE_FROM_GIT');
  const verification = verifyAuthorityRecord(record, { commit });
  failures.push(...verification.failures);
  return { ok: failures.length === 0, failures };
}
