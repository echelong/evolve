// Phase 5K.5 - READ-ONLY TEMPORAL QUERY LAYER.
//
// PURE: it operates on an already-built, already-verified temporal index held
// in memory. It opens no socket, reads no file, reads no clock and writes
// nothing. Callers that want on-disk verification use the snapshot module.
//
// RETRIEVAL ONLY. There is deliberately NO ranking, scoring, sentiment,
// momentum, velocity, growth, recommendation, prediction or trading API, and
// none can be derived from what these functions return. The mint lookup is an
// exact string match against the association copied from verified normalized
// evidence; it never infers a mint.
//
// "LATEST" IS A QUERY, NOT A MUTATION. `latestProviderDeclaredVersion` is a
// deterministic temporal read over a revision chain. It never rewrites, prunes
// or supersedes any stored version: the full history remains addressable through
// `contentVersions` and `getObservationStateHistory` at all times.
import { canonical } from './definition.mjs';
import { failClosed } from './observation.mjs';
import { compareTemporal } from './temporal-corpus.mjs';

/**
 * The complete public surface, stated as data so a test can assert that nothing
 * else is exposed. Every name is retrieval; none is judgement.
 */
export const PUBLIC_INTELLIGENCE_5K5_QUERY_API = Object.freeze([
  'getContent', 'listContents', 'listByExactMint', 'listByProvider',
  'getObservation', 'listObservationsOf', 'getObservationsByIdentity',
  'getObservationStateHistory', 'getRevisionChain', 'getLatestProviderDeclaredVersion',
  'listAllVersions', 'listConflicts', 'listRevisions', 'accounting',
]);

const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
};
const frozenCopy = value => deepFreeze(JSON.parse(canonical(value)));

export function createTemporalQuery(index) {
  const contents = frozenCopy(index.contentRecords);
  const observations = frozenCopy(index.observationRecords);
  const states = frozenCopy(index.states);
  const revisions = frozenCopy(index.revisions);
  const accounting = frozenCopy(index.accounting);

  const byIdentity = new Map(contents.map(record => [record.upstreamIdentity, record]));
  const observationsByIdentity = new Map();
  for (const record of observations) {
    if (!observationsByIdentity.has(record.upstreamIdentity)) observationsByIdentity.set(record.upstreamIdentity, []);
    observationsByIdentity.get(record.upstreamIdentity).push(record);
  }
  const statesByIdentity = new Map();
  for (const record of states) {
    if (!statesByIdentity.has(record.upstreamIdentity)) statesByIdentity.set(record.upstreamIdentity, []);
    statesByIdentity.get(record.upstreamIdentity).push(record);
  }
  const revisionsByIdentity = new Map();
  for (const record of revisions) {
    if (!revisionsByIdentity.has(record.upstreamIdentity)) revisionsByIdentity.set(record.upstreamIdentity, []);
    revisionsByIdentity.get(record.upstreamIdentity).push(record);
  }

  const requireIdentity = value => {
    if (typeof value !== 'string' || !value) failClosed('PUBLIC_INTELLIGENCE_5K5_QUERY_IDENTITY_REQUIRED');
    return value;
  };

  return Object.freeze({
    getContent: identity => byIdentity.get(requireIdentity(identity)) ?? null,
    listContents: () => contents,
    /** Exact mint string equality. Never case-folded, never inferred, never fuzzy. */
    listByExactMint: mint => {
      if (typeof mint !== 'string' || !mint) failClosed('PUBLIC_INTELLIGENCE_5K5_QUERY_MINT_REQUIRED');
      return Object.freeze(contents.filter(record => record.assetAssociation.status === 'EXACT_MINT' && record.assetAssociation.mint === mint));
    },
    listByProvider: provider => {
      if (typeof provider !== 'string' || !provider) failClosed('PUBLIC_INTELLIGENCE_5K5_QUERY_PROVIDER_REQUIRED');
      return Object.freeze(contents.filter(record => record.provider === provider));
    },
    /** Exact upstream lookup: one canonical content record per identity. */
    getObservation: identity => byIdentity.get(requireIdentity(identity)) ?? null,
    listObservationsOf: identity => Object.freeze([...(observationsByIdentity.get(requireIdentity(identity)) ?? [])]),
    getObservationsByIdentity: identity => Object.freeze([...(observationsByIdentity.get(requireIdentity(identity)) ?? [])]),

    /**
     * Read-only observation-state history: every authenticated counter snapshot
     * for one upstream identity, in deterministic chronological order.
     * Returns raw structural counters only. No delta, score or trend.
     */
    getObservationStateHistory: identity => Object.freeze(
      [...(statesByIdentity.get(requireIdentity(identity)) ?? [])].sort(compareTemporal).map(record => frozenCopy(record)),
    ),

    /** The full revision chain, oldest first. Never pruned. */
    getRevisionChain: identity => Object.freeze([...(revisionsByIdentity.get(requireIdentity(identity)) ?? [])]),

    /**
     * All authenticated content versions for one identity, oldest first.
     * This is the non-destructive alternative to asking for "the" version.
     */
    listAllVersions: identity => Object.freeze(
      [...(byIdentity.get(requireIdentity(identity))?.contentVersions ?? [])].map(version => frozenCopy(version)),
    ),

    /**
     * Deterministic temporal read: the highest-index version that carries a
     * provider-declared revision timestamp. Returns null when the identity has
     * never been declared revised, and REFUSES outright for an identity that
     * also carries an unverified divergence, because "latest" is not a
     * well-defined notion of a conflicted record and must not be papered over.
     *
     * This function mutates nothing.
     */
    getLatestProviderDeclaredVersion: identity => {
      const record = byIdentity.get(requireIdentity(identity));
      if (!record) return null;
      if (record.contentVersions.length < 2) return null;
      const conflicted = record.revisionChain.some(entry => entry.supersedesContentFingerprint !== null && entry.providerRevisionTimestamp === null);
      if (conflicted) failClosed('PUBLIC_INTELLIGENCE_5K5_QUERY_LATEST_AMBIGUOUS_CONFLICT');
      const declared = record.revisionChain.filter(entry => entry.providerRevisionTimestamp !== null);
      if (declared.length === 0) return null;
      return frozenCopy(declared[declared.length - 1]);
    },

    /** Every identity carrying at least one UNVERIFIED_CONTENT_DIVERGENCE. */
    listConflicts: () => Object.freeze(contents.filter(record => record.contentVersions.length > 1
      && record.revisionChain.some(entry => entry.supersedesContentFingerprint !== null && entry.providerRevisionTimestamp === null))),

    listRevisions: () => revisions,
    accounting: () => accounting,
  });
}
