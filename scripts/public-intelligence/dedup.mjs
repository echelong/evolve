// Phase 5K.1 - DEDUPLICATION: provider-aware, and never content-only.
//
// The rule is short and load-bearing:
//
//   An upstream observation is identified by (provider, providerObservationId).
//   That is the WHOLE identity rule.
//
// Consequences, each of which the validator enforces:
//
//   * Same provider + same provider observation id -> the SAME upstream
//     observation. Re-ingesting it is idempotent, never a second record.
//   * Same provider + DIFFERENT provider observation id -> a DIFFERENT
//     observation, even when the text is byte-identical. A repost is not a
//     duplicate of the original; collapsing them would destroy the fact that a
//     second author-post existed.
//   * DIFFERENT providers -> NEVER collapsed, under any circumstances,
//     including byte-identical text. Two platforms carrying the same words are
//     two pieces of evidence about two different platforms.
//   * Text equality alone is NEVER sufficient to establish identity, in any
//     direction.
//
// Cross-provider de-duplication is not deferred-to-later here; it is refused
// permanently by this module, because collapsing it would require a similarity
// judgement, and similarity judgements are exactly what 5K.0 prohibits as
// canonical identity.
//
// OFFLINE BY CONSTRUCTION.
import { digest } from './definition.mjs';
import { rawObservationFingerprint } from './provenance.mjs';
import { failClosed } from './observation.mjs';

/**
 * The dedup contract, stated as data.
 *
 * Note `textEqualityIsIdentity: false`. That single flag is what stops a
 * content-hash shortcut from quietly becoming a similarity matcher, since
 * content hashing and similarity matching are the same idea with different
 * thresholds.
 */
export const PUBLIC_INTELLIGENCE_5K1_DEDUP = Object.freeze({
  identityFields: Object.freeze(['provider', 'providerObservationId']),
  providerObservationIdRequired: true,
  providerAlwaysParticipates: true,
  textEqualityIsIdentity: false,
  crossProviderCollapsePermitted: false,
  sameTextDifferentProviderStaysDistinct: true,
  sameProviderDifferentObservationIdStaysDistinct: true,
  idempotentReingestion: true,
  conflictsRatherThanOverwrites: true,
  deterministic: true,
  fallbackToTextDigest: false,
  fallbackToUrl: false,
});

/** Outcome codes. A conflict is a refusal, not a silent overwrite. */
export const PUBLIC_INTELLIGENCE_5K1_DEDUP_OUTCOMES = Object.freeze({
  INSERTED: 'INSERTED',
  DUPLICATE: 'DUPLICATE',
  CONFLICT: 'CONFLICT',
});

/**
 * Deterministic provider-scoped identity.
 *
 * `provider` is part of the digest input, so the same observation id on two
 * providers yields two unrelated identities. Text is deliberately NOT an input:
 * identity must not be content-derived, because content-derived identity is
 * similarity matching with extra steps.
 */
export function dedupIdentity5K1({ provider, providerObservationId } = {}) {
  if (typeof provider !== 'string' || !provider.trim()) failClosed('PUBLIC_INTELLIGENCE_PROVIDER_REQUIRED');
  if (typeof providerObservationId !== 'string' || !providerObservationId.trim()) {
    failClosed('PUBLIC_INTELLIGENCE_5K1_PROVIDER_OBSERVATION_ID_REQUIRED');
  }
  return digest({ kind: 'publicSocialUpstreamObservation5K1', provider, providerObservationId });
}

/**
 * Classifies a candidate observation against what is already stored.
 *
 * `existing` is the stored record with this dedup identity, or null.
 *
 * The three outcomes:
 *   INSERTED  - no upstream record with this identity exists yet
 *   DUPLICATE - the same upstream identity, carrying byte-identical evidence.
 *               Re-ingestion is a no-op; the existing record is returned.
 *   CONFLICT  - the same upstream identity carrying DIFFERENT evidence. The
 *               upstream item was mutated, or one side is corrupt. This is
 *               refused and surfaced, never resolved by last-write-wins.
 *
 * Note what this does NOT do: it never compares text, never compares mints and
 * never compares anything but the provider-scoped identity and, for conflict
 * detection, the raw evidence fingerprint.
 */
export function decideDedup(candidate, existing) {
  if (!candidate || typeof candidate !== 'object') failClosed('PUBLIC_INTELLIGENCE_5K1_DEDUP_CANDIDATE_INVALID');
  if (!existing) return Object.freeze({ outcome: PUBLIC_INTELLIGENCE_5K1_DEDUP_OUTCOMES.INSERTED, conflicting: false });

  // A record from another provider can never be the same upstream observation,
  // regardless of content. Asserted rather than assumed.
  if (candidate.provider !== existing.provider) {
    return Object.freeze({
      outcome: PUBLIC_INTELLIGENCE_5K1_DEDUP_OUTCOMES.INSERTED,
      conflicting: false,
      reason: 'DIFFERENT_PROVIDER_NEVER_COLLAPSES',
    });
  }
  if (candidate.dedupIdentity !== existing.dedupIdentity) {
    return Object.freeze({
      outcome: PUBLIC_INTELLIGENCE_5K1_DEDUP_OUTCOMES.INSERTED,
      conflicting: false,
      reason: 'DIFFERENT_PROVIDER_OBSERVATION_ID_NEVER_COLLAPSES',
    });
  }
  const candidateFingerprint = candidate.rawObservationFingerprint ?? rawObservationFingerprint(candidate.raw);
  const existingFingerprint = existing.rawObservationFingerprint ?? rawObservationFingerprint(existing.raw);
  if (candidateFingerprint === existingFingerprint) {
    return Object.freeze({
      outcome: PUBLIC_INTELLIGENCE_5K1_DEDUP_OUTCOMES.DUPLICATE,
      conflicting: false,
      reason: 'IDENTICAL_EVIDENCE_IDEMPOTENT',
    });
  }
  return Object.freeze({
    outcome: PUBLIC_INTELLIGENCE_5K1_DEDUP_OUTCOMES.CONFLICT,
    conflicting: true,
    reason: 'SAME_UPSTREAM_IDENTITY_DIFFERENT_EVIDENCE',
  });
}

/** True only for two records that are genuinely the same upstream item. */
export function isSameUpstreamObservation5K1(a, b) {
  if (!a || !b) return false;
  return a.provider === b.provider
    && typeof a.dedupIdentity === 'string'
    && a.dedupIdentity === b.dedupIdentity;
}

/**
 * A human-auditable summary of the dedup decision over a set of records.
 * Purely descriptive: it decides nothing and influences nothing.
 */
export function dedupAudit(records) {
  const byIdentity = new Map();
  for (const record of records) {
    const key = `${record.provider}::${record.dedupIdentity}`;
    if (!byIdentity.has(key)) byIdentity.set(key, []);
    byIdentity.get(key).push(record);
  }
  const groups = [...byIdentity.entries()].map(([key, members]) => ({
    key,
    count: members.length,
    providers: [...new Set(members.map(m => m.provider))].sort(),
  }));
  return Object.freeze({
    totalRecords: records.length,
    distinctUpstreamIdentities: byIdentity.size,
    crossProviderIdentities: groups.filter(group => group.providers.length > 1).length,
    duplicateGroups: groups.filter(group => group.count > 1).length,
    crossProviderCollapsePerformed: false,
    auditDigest: digest({ groups: groups.map(group => ({ key: group.key, count: group.count })) }),
  });
}
