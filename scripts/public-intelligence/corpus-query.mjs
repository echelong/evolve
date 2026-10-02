// Phase 5K.4 - READ-ONLY CORPUS QUERY LAYER.
//
// Lookups over a verified snapshot. It exposes retrieval and coverage counts
// only. There is deliberately NO ranking, scoring, sentiment, momentum,
// recommendation, selection or prediction API, and no mint inference: a mint
// query is an exact string match on the association copied from verified
// normalized evidence.
import { canonical } from './definition.mjs';
import { failClosed } from './observation.mjs';
import { verifySnapshot } from './corpus-verify.mjs';
import { corporaDirectoryOf, loadSnapshotArtifacts } from './corpus-snapshot.mjs';

const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(deepFreeze); }
  return value;
};
const frozenCopy = value => deepFreeze(JSON.parse(canonical(value)));

/** The complete public surface, stated as data so a test can assert nothing else exists. */
export const PUBLIC_INTELLIGENCE_5K4_QUERY_API = Object.freeze([
  'getObservation', 'listObservations', 'listByExactMint', 'listUnassociated', 'listByAssociationStatus', 'listByProvider',
  'membershipRunsOf', 'getConflict', 'listConflicts', 'listMemberships', 'coverage', 'manifest',
]);

export function createCorpusQuery({ manifest, memberships, observations, conflicts }) {
  const obs = frozenCopy(observations);
  const conf = frozenCopy(conflicts);
  const members = frozenCopy(memberships);
  const man = frozenCopy(manifest);
  const byIdentity = new Map(obs.map(record => [record.upstreamIdentity, record]));
  const conflictByIdentity = new Map(conf.map(record => [record.upstreamIdentity, record]));
  const requireString = (value, code) => { if (typeof value !== 'string' || !value) failClosed(code); return value; };
  return Object.freeze({
    getObservation: identity => byIdentity.get(requireString(identity, 'PUBLIC_INTELLIGENCE_5K4_QUERY_IDENTITY_REQUIRED')) ?? null,
    listObservations: () => obs,
    listByExactMint: mint => Object.freeze(obs.filter(record => record.assetAssociation.mint === requireString(mint, 'PUBLIC_INTELLIGENCE_5K4_QUERY_MINT_REQUIRED'))),
    listUnassociated: () => Object.freeze(obs.filter(record => record.assetAssociation.status === 'UNASSOCIATED')),
    listByAssociationStatus: status => Object.freeze(obs.filter(record => record.assetAssociation.status === requireString(status, 'PUBLIC_INTELLIGENCE_5K4_QUERY_STATUS_REQUIRED'))),
    listByProvider: provider => Object.freeze(obs.filter(record => record.provider === requireString(provider, 'PUBLIC_INTELLIGENCE_5K4_QUERY_PROVIDER_REQUIRED'))),
    membershipRunsOf: identity => byIdentity.get(identity)?.memberRunIds ?? conflictByIdentity.get(identity)?.runIds ?? Object.freeze([]),
    getConflict: identity => conflictByIdentity.get(requireString(identity, 'PUBLIC_INTELLIGENCE_5K4_QUERY_IDENTITY_REQUIRED')) ?? null,
    listConflicts: () => conf,
    listMemberships: () => members,
    coverage: () => man.coverage,
    manifest: () => man,
  });
}

/** Opens a snapshot for querying ONLY if it fully verifies against its runs. */
export function openVerifiedCorpus(root, snapshotId) {
  const verification = verifySnapshot(root, snapshotId);
  if (!verification.ok) failClosed(`PUBLIC_INTELLIGENCE_5K4_SNAPSHOT_NOT_VERIFIED:${verification.failures[0]}`);
  return createCorpusQuery(loadSnapshotArtifacts(corporaDirectoryOf(root, snapshotId)));
}
