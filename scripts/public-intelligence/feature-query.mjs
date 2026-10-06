// Phase 5K.9 - READ-ONLY DESCRIPTIVE FEATURE QUERY LAYER.
//
// Lookups over a VERIFIED feature snapshot. It exposes retrieval of explicit
// measurements only. There is deliberately NO ranking, scoring, top-N, "best"
// ordering, sentiment, momentum or recommendation anywhere in this API: every
// list is ordered LEXICALLY BY IDENTITY and never by a feature value.
import { canonical } from './definition.mjs';
import { failClosed } from './observation.mjs';
import { verifyFeatureSnapshot } from './feature-verify.mjs';
import { featureCorporaDirectoryOf, loadFeatureArtifacts } from './feature-snapshot.mjs';

const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(deepFreeze); }
  return value;
};
const frozenCopy = value => deepFreeze(JSON.parse(canonical(value)));
const asArray = value => Object.freeze([...(value ?? [])]);

/**
 * The complete public surface, stated as data so a test can assert nothing else
 * exists. Every name is retrieval; none is judgement.
 */
export const PUBLIC_INTELLIGENCE_5K9_QUERY_API = Object.freeze([
  'getFeaturesForMint', 'listFeatureMints', 'getFeatureSummary',
  'getProviderFamilyFeatures', 'getTemporalBucketsForMint',
  'getMissingnessForMint', 'getLineageFeaturesForMint', 'getRevisionFeaturesForMint',
]);

/** The aggregate summary. Structural counts only; no score, no ratio, no tier. */
function summaryFromManifest(manifest) {
  return {
    snapshotId: manifest.snapshotId,
    mintFeatureCount: manifest.mintFeatureCount,
    singleProviderFamilyMintCount: manifest.singleProviderFamilyMintCount,
    multiProviderFamilyMintCount: manifest.multiProviderFamilyMintCount,
    totalUpstreamObservationCount: manifest.totalUpstreamObservationCount,
    totalContentVersionCount: manifest.totalContentVersionCount,
    totalStateSnapshotCount: manifest.totalStateSnapshotCount,
    totalLineageCount: manifest.totalLineageCount,
    totalProviderFamilyCount: manifest.totalProviderFamilyCount,
    exactMintObservationCount: manifest.exactMintObservationCount,
    unassociatedObservationCount: manifest.unassociatedObservationCount,
    invalidMintObservationCount: manifest.invalidMintObservationCount,
    ambiguousObservationCount: manifest.ambiguousObservationCount,
    earliestObservedAt: manifest.earliestObservedAt,
    latestObservedAt: manifest.latestObservedAt,
    bucketPolicyVersion: manifest.bucketPolicyVersion,
    bucketWidthMs: manifest.bucketWidthMs,
    readOnly: true,
    descriptiveOnly: true,
    scoreComputed: false,
    rankComputed: false,
    weightApplied: false,
    orderingByFeatureValue: false,
    defaultOrderingIsLexical: true,
    sentimentComputed: false,
    momentumComputed: false,
    predictionMade: false,
    recommendationMade: false,
    marketDataAccessed: false,
  };
}

export function createFeatureQuery({ manifest, features }) {
  const man = frozenCopy(manifest);
  const records = frozenCopy(features);
  const byMint = new Map(records.map(record => [record.mint, record]));
  const requireString = (value, code) => {
    if (typeof value !== 'string' || !value) failClosed(code);
    return value;
  };
  const requireMint = mint => requireString(mint, 'PUBLIC_INTELLIGENCE_5K9_QUERY_MINT_REQUIRED');
  const requireFamily = family => requireString(family, 'PUBLIC_INTELLIGENCE_5K9_QUERY_FAMILY_REQUIRED');

  return Object.freeze({
    /** Exact mint string equality. Never case-folded, never inferred, never fuzzy. */
    getFeaturesForMint: mint => frozenCopy(byMint.get(requireMint(mint)) ?? null),
    /** Every mint, in LEXICAL order. Never ordered by a feature value. */
    listFeatureMints: () => asArray([...byMint.keys()].sort()),
    getFeatureSummary: () => frozenCopy(summaryFromManifest(man)),
    /** One provider family's block for one mint, or null. */
    getProviderFamilyFeatures: (mint, family) => frozenCopy(byMint.get(requireMint(mint))?.providerFamilies?.[requireFamily(family)] ?? null),
    /** The sparse observed temporal buckets, ordered by bucket start. */
    getTemporalBucketsForMint: mint => frozenCopy(byMint.get(requireMint(mint))?.temporalBuckets ?? null),
    /** The per-category availability counts. Missingness is first-class here. */
    getMissingnessForMint: mint => frozenCopy(byMint.get(requireMint(mint))?.missingness ?? null),
    /** The 5K.8 lineage measurements, verbatim. */
    getLineageFeaturesForMint: mint => {
      const record = byMint.get(requireMint(mint));
      if (!record) return null;
      return frozenCopy({
        mint: record.mint,
        contentLineageCount: record.contentLineageCount,
        exactRawMatchLineageCount: record.exactRawMatchLineageCount,
        canonicalMatchLineageCount: record.canonicalMatchLineageCount,
        explicitReferenceLineageCount: record.explicitReferenceLineageCount,
        distinctContentLineageCount: record.distinctContentLineageCount,
        unresolvedLineageCount: record.unresolvedLineageCount,
        lineageCoverageStatus: record.lineageCoverageStatus,
      });
    },
    /** The 5K.5 revision and state-change measurements, verbatim. */
    getRevisionFeaturesForMint: mint => {
      const record = byMint.get(requireMint(mint));
      if (!record) return null;
      return frozenCopy({
        mint: record.mint,
        contentVersionCount: record.contentVersionCount,
        providerDeclaredRevisionCount: record.providerDeclaredRevisionCount,
        unverifiedDivergenceCount: record.unverifiedDivergenceCount,
        stateChangeCount: record.stateChangeCount,
        observationStateSnapshotCount: record.observationStateSnapshotCount,
      });
    },
  });
}

/** Opens a snapshot for querying ONLY if it fully verifies against its runs. */
export function openVerifiedFeature(root, snapshotId) {
  const verification = verifyFeatureSnapshot(root, snapshotId);
  if (!verification.ok) failClosed(`PUBLIC_INTELLIGENCE_5K9_SNAPSHOT_NOT_VERIFIED:${verification.failures[0]}`);
  const artifacts = loadFeatureArtifacts(featureCorporaDirectoryOf(root, snapshotId));
  return createFeatureQuery({ manifest: artifacts.manifest, features: artifacts.features });
}
