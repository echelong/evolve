// Phase 5K.7 - READ-ONLY CORROBORATION QUERY LAYER.
//
// Lookups over a VERIFIED corroboration snapshot. It exposes retrieval and
// coverage counts only. There is deliberately NO ranking, scoring, sentiment,
// momentum, recommendation, selection or prediction API, and no mint inference:
// a mint query is an exact string match on the mint carried by verified
// evidence. Nothing here interprets a coverage gap.
import { canonical } from './definition.mjs';
import { failClosed } from './observation.mjs';
import { verifyCorroborationSnapshot } from './corroboration-verify.mjs';
import { corroborationCorporaDirectoryOf, loadCorroborationArtifacts } from './corroboration-snapshot.mjs';
import { computeCoverageGaps } from './corroboration-index.mjs';

const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(deepFreeze); }
  return value;
};
const frozenCopy = value => deepFreeze(JSON.parse(canonical(value)));
const asArray = value => Object.freeze([...(value ?? [])]);

/**
 * The complete public surface, stated as data so a test can assert nothing else
 * exists. Every name is retrieval; none is judgement. The validator also inspects
 * the exported names for the prohibited vocabulary.
 */
export const PUBLIC_INTELLIGENCE_5K7_QUERY_API = Object.freeze([
  'getCoverageForExactMint', 'listMultiProviderFamilyMints', 'listSingleProviderFamilyMints',
  'listProviderFamiliesForMint', 'listProviderNamespacesForMint', 'listUpstreamObservationsForMint',
  'getCoverageSummary', 'listUnassociatedCoverage', 'listCoverageGaps',
]);

/** The summary an aggregate view exposes. Counts only; no score, no tier. */
function summaryFromManifest(manifest) {
  return {
    snapshotId: manifest.snapshotId,
    upstreamIdentityCount: manifest.upstreamIdentityCount,
    exactMintCount: manifest.exactMintCount,
    singleProviderFamilyMintCount: manifest.singleProviderFamilyMintCount,
    multiProviderFamilyMintCount: manifest.multiProviderFamilyMintCount,
    providerFamilyCounts: manifest.providerFamilyCounts,
    providerNamespaceCounts: manifest.providerNamespaceCounts,
    exactMintObservationCount: manifest.exactMintObservationCount,
    unassociatedObservationCount: manifest.unassociatedObservationCount,
    invalidMintObservationCount: manifest.invalidMintObservationCount,
    ambiguousObservationCount: manifest.ambiguousObservationCount,
    earliestObservedAt: manifest.earliestObservedAt,
    latestObservedAt: manifest.latestObservedAt,
    coverageClassification: manifest.coverageClassification,
    readOnly: true,
    scoringApplied: false,
    rankingApplied: false,
    confidenceTierAssigned: false,
    absenceInterpreted: false,
    providerAgreementInferred: false,
  };
}

/** The aggregate view of the manifest, in the index's aggregate vocabulary. */
function aggregateFromManifest(manifest) {
  return {
    upstreamIdentityCount: manifest.upstreamIdentityCount,
    exactMintCount: manifest.exactMintCount,
    singleProviderFamilyMintCount: manifest.singleProviderFamilyMintCount,
    multiProviderFamilyMintCount: manifest.multiProviderFamilyMintCount,
    providerFamilyCounts: manifest.providerFamilyCounts,
    providerNamespaceCounts: manifest.providerNamespaceCounts,
    exactMintObservationCount: manifest.exactMintObservationCount,
    unassociatedObservationCount: manifest.unassociatedObservationCount,
    invalidMintObservationCount: manifest.invalidMintObservationCount,
    ambiguousObservationCount: manifest.ambiguousObservationCount,
    earliestObservedAt: manifest.earliestObservedAt,
    latestObservedAt: manifest.latestObservedAt,
  };
}

export function createCorroborationQuery({ manifest, coverageRecords, observationCoverageRecords }) {
  const man = frozenCopy(manifest);
  const coverage = frozenCopy(coverageRecords);
  const observationCoverage = frozenCopy(observationCoverageRecords ?? []);
  const byMint = new Map(coverage.map(record => [record.mint, record]));
  const requireString = (value, code) => {
    if (typeof value !== 'string' || !value) failClosed(code);
    return value;
  };
  const requireMint = mint => requireString(mint, 'PUBLIC_INTELLIGENCE_5K7_QUERY_MINT_REQUIRED');
  const aggregate = aggregateFromManifest(man);

  return Object.freeze({
    /** Exact mint string equality. Never case-folded, never inferred, never fuzzy. */
    getCoverageForExactMint: mint => frozenCopy(byMint.get(requireMint(mint)) ?? null),
    listMultiProviderFamilyMints: () => asArray(coverage
      .filter(record => record.coverageStatus === 'MULTI_PROVIDER_FAMILY').map(record => record.mint)),
    listSingleProviderFamilyMints: () => asArray(coverage
      .filter(record => record.coverageStatus === 'SINGLE_PROVIDER_FAMILY').map(record => record.mint)),
    listProviderFamiliesForMint: mint => asArray(byMint.get(requireMint(mint))?.providerFamilies),
    listProviderNamespacesForMint: mint => asArray(byMint.get(requireMint(mint))?.providerNamespaces),
    listUpstreamObservationsForMint: mint => asArray(byMint.get(requireMint(mint))?.upstreamObservationIdentities),
    getCoverageSummary: () => frozenCopy(summaryFromManifest(man)),
    /** Upstream identities whose HEAD evidence carries no exact mint. */
    listUnassociatedCoverage: () => asArray(observationCoverage
      .filter(record => record.associationStatus === 'UNASSOCIATED')),
    /**
     * Where exact-mint evidence is absent. This interprets nothing: absence from
     * one provider is never treated as evidence of absence.
     */
    listCoverageGaps: () => frozenCopy(computeCoverageGaps({ coverageRecords: coverage, aggregate })),
  });
}

/** Opens a snapshot for querying ONLY if it fully verifies against its runs. */
export function openVerifiedCorroboration(root, snapshotId) {
  const verification = verifyCorroborationSnapshot(root, snapshotId);
  if (!verification.ok) failClosed(`PUBLIC_INTELLIGENCE_5K7_SNAPSHOT_NOT_VERIFIED:${verification.failures[0]}`);
  return createCorroborationQuery(loadCorroborationArtifacts(corroborationCorporaDirectoryOf(root, snapshotId)));
}
