// Phase 5K.8 - READ-ONLY CONTENT LINEAGE QUERY LAYER.
//
// Lookups over a VERIFIED lineage snapshot. It exposes retrieval and structural
// counts only. There is deliberately NO diversity score, no ranking, no
// originality or copying inference, no author-identity resolution, no
// recommendation, no selection and no prediction anywhere in this API, and no
// mint inference: a mint query is an exact string match on the mint carried by
// verified evidence.
import { canonical } from './definition.mjs';
import { failClosed } from './observation.mjs';
import { PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS } from './lineage-definition.mjs';
import { computeDistinctnessForMint } from './lineage-index.mjs';
import { verifyLineageSnapshot } from './lineage-verify.mjs';
import { lineageCorporaDirectoryOf, loadLineageArtifacts } from './lineage-snapshot.mjs';
import { corroborationCorporaDirectoryOf, loadCorroborationArtifacts } from './corroboration-snapshot.mjs';

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
export const PUBLIC_INTELLIGENCE_5K8_QUERY_API = Object.freeze([
  'getLineage', 'listLineagesForMint', 'listLineagesForProviderFamily',
  'listExactDuplicateLineages', 'listCanonicalDuplicateLineages', 'listDistinctContentLineages',
  'getContentDiversityForMint', 'getLineageSummary',
]);

/** The summary an aggregate view exposes. Counts only; no score, no ratio, no tier. */
function summaryFromManifest(manifest) {
  return {
    snapshotId: manifest.snapshotId,
    contentVersionCount: manifest.contentVersionCount,
    upstreamIdentityCount: manifest.upstreamIdentityCount,
    lineageCount: manifest.lineageCount,
    singleProviderLineageCount: manifest.singleProviderLineageCount,
    multiProviderLineageCount: manifest.multiProviderLineageCount,
    crossProviderLineageCount: manifest.crossProviderLineageCount,
    exactRawMatchLineageCount: manifest.exactRawMatchLineageCount,
    canonicalMatchLineageCount: manifest.canonicalMatchLineageCount,
    explicitReferenceLineageCount: manifest.explicitReferenceLineageCount,
    distinctLineageCount: manifest.distinctLineageCount,
    unresolvedLineageCount: manifest.unresolvedLineageCount,
    referenceResolvedVersionCount: manifest.referenceResolvedVersionCount,
    referenceUnresolvedVersionCount: manifest.referenceUnresolvedVersionCount,
    providerFamilyCounts: manifest.providerFamilyCounts,
    earliestObservedAt: manifest.earliestObservedAt,
    latestObservedAt: manifest.latestObservedAt,
    readOnly: true,
    scoreComputed: false,
    rankingApplied: false,
    dimensionsCollapsed: false,
    originalityInferred: false,
    copyingInferred: false,
    authorIdentityResolved: false,
  };
}

export function createLineageQuery({ manifest, lineages, coverageRecords }) {
  const man = frozenCopy(manifest);
  const records = frozenCopy(lineages);
  const coverage = frozenCopy(coverageRecords ?? []);
  const byId = new Map(records.map(record => [record.lineageId, record]));
  const byMint = new Map();
  for (const record of records) {
    for (const mint of record.exactMintSubjects) {
      if (!byMint.has(mint)) byMint.set(mint, []);
      byMint.get(mint).push(record);
    }
  }
  const coverageByMint = new Map(coverage.map(record => [record.mint, record]));
  const requireString = (value, code) => {
    if (typeof value !== 'string' || !value) failClosed(code);
    return value;
  };
  const requireMint = mint => requireString(mint, 'PUBLIC_INTELLIGENCE_5K8_QUERY_MINT_REQUIRED');
  const requireFamily = family => requireString(family, 'PUBLIC_INTELLIGENCE_5K8_QUERY_FAMILY_REQUIRED');
  const listByClass = name => asArray(records.filter(record => record.lineageClass === name).map(record => record.lineageId));

  return Object.freeze({
    /** Exact lineage-id lookup. */
    getLineage: lineageId => frozenCopy(byId.get(requireString(lineageId, 'PUBLIC_INTELLIGENCE_5K8_QUERY_LINEAGE_ID_REQUIRED')) ?? null),
    /** Lineages whose verified evidence carries this exact mint. Never inferred. */
    listLineagesForMint: mint => asArray((byMint.get(requireMint(mint)) ?? []).map(record => record.lineageId)),
    /** Lineages with at least one member in this governed provider family. */
    listLineagesForProviderFamily: family => asArray(records
      .filter(record => record.providerFamilies.includes(requireFamily(family))).map(record => record.lineageId)),
    listExactDuplicateLineages: () => listByClass(PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS.EXACT_RAW_TEXT_MATCH),
    listCanonicalDuplicateLineages: () => listByClass(PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS.CANONICAL_TEXT_MATCH),
    listDistinctContentLineages: () => listByClass(PUBLIC_INTELLIGENCE_5K8_LINEAGE_CLASS.DISTINCT_CONTENT),
    /**
     * Discrete structural facts for one mint, with provider diversity (5K.7) and
     * content diversity (5K.8) reported SEPARATELY. No ratio, no scalar score.
     */
    getContentDiversityForMint: mint => frozenCopy(computeDistinctnessForMint(requireMint(mint), {
      lineages: records, coverageRecord: coverageByMint.get(mint) ?? null,
    })),
    getLineageSummary: () => frozenCopy(summaryFromManifest(man)),
  });
}

/**
 * Opens a snapshot for querying ONLY if it fully verifies against its runs.
 *
 * 5K.7 remains authoritative for provider-family coverage, so the coverage
 * records are read from the SOURCE corroboration snapshot when it is present on
 * disk, and the diversity view falls back to a lineage-derived count when it is
 * not. Nothing is copied or mutated.
 */
export function openVerifiedLineage(root, snapshotId) {
  const verification = verifyLineageSnapshot(root, snapshotId);
  if (!verification.ok) failClosed(`PUBLIC_INTELLIGENCE_5K8_SNAPSHOT_NOT_VERIFIED:${verification.failures[0]}`);
  const artifacts = loadLineageArtifacts(lineageCorporaDirectoryOf(root, snapshotId));
  let coverageRecords = [];
  try {
    const source = loadCorroborationArtifacts(corroborationCorporaDirectoryOf(root, artifacts.manifest.sourceCorroborationSnapshotId));
    coverageRecords = source.coverageRecords;
  } catch { coverageRecords = []; }
  return createLineageQuery({
    manifest: artifacts.manifest,
    lineages: artifacts.lineages,
    contentVersions: artifacts.contentVersions,
    coverageRecords,
  });
}

/** The content versions of one lineage, for a caller that wants the members. */
export function contentVersionsOfLineage(lineage, contentVersions) {
  const wanted = new Set(lineage.memberContentVersions);
  return asArray((contentVersions ?? []).filter(version => wanted.has(version.contentVersionFingerprint)));
}
