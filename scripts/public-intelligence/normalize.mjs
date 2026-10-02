// Phase 5K.1 - NORMALIZATION: a deterministic projection of raw evidence.
//
// Normalization READS raw evidence and produces a NEW frozen record. It never
// writes back to raw, never mutates it, and never softens it. The raw
// fingerprint is computed before and after normalization and must be identical,
// which is what proves non-mutation rather than merely asserting it.
//
// THE IDENTITY RULE, in one sentence:
//
//   A canonical Solana mint is bound ONLY when the evidence carries that exact
//   base58 address. Symbol, ticker, token name, cashtag, hashtag, display name
//   and any similarity or fuzzy signal bind nothing, ever.
//
// An observation that names a token but carries no exact mint is UNASSOCIATED,
// and that is a valid, complete, expected outcome - not a defect to be patched
// by guessing. Nothing here can invent, infer or interpolate a mint.
//
// Deliberately NOT implemented in 5K.1: sentiment, toxicity, LLM interpretation,
// embeddings, topic modelling, bot detection, scoring, ranking, alpha, or any
// trading signal. Those are Phase 5K.4 at the earliest and remain research-only.
//
// OFFLINE BY CONSTRUCTION.
import {
  PUBLIC_INTELLIGENCE_CLASSIFICATION, PUBLIC_INTELLIGENCE_MISSINGNESS,
  PUBLIC_INTELLIGENCE_ASSOCIATION_METHODS, PUBLIC_INTELLIGENCE_RECORD_TYPES,
  PUBLIC_INTELLIGENCE_SCHEMA_VERSION, digest, isValidTimestamp,
  canonicalMintAddress,
} from './definition.mjs';
import {
  validateRawObservation5K1, claimedMintOf, exactClaimedMint, failClosed,
  PUBLIC_INTELLIGENCE_5K1_REJECTED_IDENTITY_SIGNALS,
} from './observation.mjs';
import { buildProvenance, rawObservationFingerprint, contentFingerprint } from './provenance.mjs';
import { dedupIdentity5K1 } from './dedup.mjs';

/**
 * Association status. Deliberately distinguishes "we bound an exact mint" from
 * "the evidence claimed one but it was malformed" from "the evidence offered
 * several and we refuse to guess", because those are different research facts.
 */
export const PUBLIC_INTELLIGENCE_5K1_ASSOCIATION_STATUS = Object.freeze({
  EXACT_MINT: 'EXACT_MINT',
  UNASSOCIATED: 'UNASSOCIATED',
  INVALID_MINT: 'INVALID_MINT',
  AMBIGUOUS: 'AMBIGUOUS',
});

/** The only method that can ever produce a canonical subject. */
export const PUBLIC_INTELLIGENCE_5K1_ASSOCIATION_METHODS = Object.freeze({
  EXACT_MINT_ADDRESS: PUBLIC_INTELLIGENCE_ASSOCIATION_METHODS.EXACT_MINT_ADDRESS,
  UNASSOCIATED: PUBLIC_INTELLIGENCE_ASSOCIATION_METHODS.UNASSOCIATED,
});

/** The complete normalized observation schema. Closed; unknown fields refused. */
export const PUBLIC_INTELLIGENCE_5K1_NORMALIZED_SCHEMA = Object.freeze({
  schemaVersion: PUBLIC_INTELLIGENCE_SCHEMA_VERSION,
  recordType: PUBLIC_INTELLIGENCE_RECORD_TYPES.NORMALIZED_SOCIAL_OBSERVATION,
  closed: true,
  fields: Object.freeze([
    'schemaVersion',
    'recordType',
    'phase',
    'rawObservationFingerprint',
    'raw',
    'provider',
    'providerObservationId',
    'providerAuthorId',
    'sourceType',
    'sourceUrl',
    'dedupIdentity',
    'canonicalText',
    'canonicalTextFingerprint',
    'normalizedAuthorIdentity',
    'publishedAt',
    'observedAt',
    'fetchedAt',
    'availabilityAt',
    'assetAssociation',
    'engagement',
    'missingness',
    'provenance',
    'classification',
  ]),
  mutatesRawEvidence: false,
  fabricatesMint: false,
  fuzzyAssociationPermitted: false,
  sentimentImplemented: false,
  llmInterpretationImplemented: false,
  tradingSignalImplemented: false,
  defersTo: 'PHASE_5K_2_PROVIDER_ADAPTER',
});

/** The 5K.1 scope boundary, stated as data. */
export const PUBLIC_INTELLIGENCE_5K1_SCOPE = Object.freeze({
  phase: 'PHASE_5K_1',
  ingestionAndProvenanceOnly: true,
  contactsNoProvider: true,
  opensNoSocket: true,
  holdsNoCredential: true,
  readsNoEnvironment: true,
  requiresNoDatabase: true,
  writesOnlyToCallerSuppliedDirectory: true,
  writesNothingUnderEvolve: true,
  networkAccessPermitted: false,
  providerAdapterImplemented: false,
  tradingAuthority: false,
  engineAuthority: false,
  affectsFitness: false,
  affectsPromotion: false,
  affectsChampionSelection: false,
  createsDeploymentGate: false,
  touchesR4Seal: false,
});


// ---------------------------------------------------------------------------
// ASSET ASSOCIATION
// ---------------------------------------------------------------------------

/**
 * Exact-mint association. This is the single place a canonical subject can be
 * bound anywhere in 5K.1.
 *
 * Decision table, total over every possible input:
 *
 *   no claimed mint at all                     -> UNASSOCIATED, mint null
 *   claimed mint is exact base58               -> EXACT_MINT,     mint = that exact string
 *   claimed mint is present but malformed      -> INVALID_MINT,   mint null
 *   >1 distinct exact candidate mints claimed  -> AMBIGUOUS,      mint null
 *
 * Nothing else reaches EXACT_MINT. In particular a symbol, ticker, token name,
 * cashtag, hashtag, display name or similarity score cannot promote an
 * observation to EXACT_MINT, because none of those is consulted here.
 */
export function resolveAssetAssociation(raw) {
  validateRawObservation5K1(raw);
  const claimed = claimedMintOf(raw);
  const exact = exactClaimedMint(raw);
  const candidates = Array.isArray(raw.rawMetadata.candidateMintAddresses)
    ? raw.rawMetadata.candidateMintAddresses
    : [];
  const exactCandidates = [...new Set(candidates.filter(candidate => canonicalMintAddress(candidate) !== null))];

  // Evidence of *what was refused* is recorded, so a reviewer can see that a
  // symbol was present and deliberately not treated as identity.
  const refusedSignals = detectRefusedIdentitySignals(raw);

  if (claimed !== null && exact === null) {
    return Object.freeze({
      status: PUBLIC_INTELLIGENCE_5K1_ASSOCIATION_STATUS.INVALID_MINT,
      mint: null,
      method: PUBLIC_INTELLIGENCE_5K1_ASSOCIATION_METHODS.UNASSOCIATED,
      evidence: Object.freeze({
        claimedMintPresent: true,
        claimedMint: claimed,
        claimedMintIsExactBase58: false,
        exactCandidateCount: 0,
        refusedIdentitySignals: refusedSignals,
        reason: 'CLAIMED_MINT_NOT_EXACT_BASE58',
      }),
    });
  }

  if (claimed !== null && exactCandidates.length > 1) {
    // Several distinct exact addresses in one observation. We refuse to pick.
    return Object.freeze({
      status: PUBLIC_INTELLIGENCE_5K1_ASSOCIATION_STATUS.AMBIGUOUS,
      mint: null,
      method: PUBLIC_INTELLIGENCE_5K1_ASSOCIATION_METHODS.UNASSOCIATED,
      evidence: Object.freeze({
        claimedMintPresent: true,
        claimedMint: claimed,
        claimedMintIsExactBase58: true,
        exactCandidateCount: exactCandidates.length,
        refusedIdentitySignals: refusedSignals,
        reason: 'MULTIPLE_EXACT_CANDIDATES_NO_FORCE_MATCH',
      }),
    });
  }

  if (claimed !== null) {
    return Object.freeze({
      status: PUBLIC_INTELLIGENCE_5K1_ASSOCIATION_STATUS.EXACT_MINT,
      mint: exact,
      method: PUBLIC_INTELLIGENCE_5K1_ASSOCIATION_METHODS.EXACT_MINT_ADDRESS,
      evidence: Object.freeze({
        claimedMintPresent: true,
        claimedMint: claimed,
        claimedMintIsExactBase58: true,
        exactCandidateCount: 1,
        refusedIdentitySignals: refusedSignals,
        reason: 'EXACT_BASE58_MINT_PRESENT_IN_EVIDENCE',
      }),
    });
  }

  return Object.freeze({
    status: PUBLIC_INTELLIGENCE_5K1_ASSOCIATION_STATUS.UNASSOCIATED,
    mint: null,
    method: PUBLIC_INTELLIGENCE_5K1_ASSOCIATION_METHODS.UNASSOCIATED,
    evidence: Object.freeze({
      claimedMintPresent: false,
      claimedMint: null,
      claimedMintIsExactBase58: false,
      exactCandidateCount: exactCandidates.length,
      refusedIdentitySignals: refusedSignals,
      reason: exactCandidates.length > 0
        ? 'EXACT_CANDIDATES_PRESENT_BUT_NOT_CLAIMED'
        : 'NO_EXACT_MINT_IN_EVIDENCE',
    }),
  });
}

/**
 * Records which non-canonical identity signals the evidence contained. This is
 * deliberately inert: it labels what was refused so the refusal is auditable,
 * and it can never influence status or mint.
 */
function detectRefusedIdentitySignals(raw) {
  const metadata = raw.rawMetadata;
  const text = typeof raw.rawText === 'string' ? raw.rawText : '';
  const refused = [];
  if (typeof metadata.claimedSymbol === 'string' && metadata.claimedSymbol.trim()) {
    refused.push('SYMBOL_ONLY');
  }
  if (typeof metadata.claimedTokenName === 'string' && metadata.claimedTokenName.trim()) {
    refused.push('TOKEN_NAME_ONLY');
  }
  if (Array.isArray(metadata.cashtags) && metadata.cashtags.length > 0) {
    refused.push('SYMBOL_ONLY');
  }
  if (Array.isArray(metadata.mentionedHandles) && metadata.mentionedHandles.length > 0) {
    refused.push('PROFILE_NAME_SIMILARITY');
  }
  if (Array.isArray(metadata.similaritySignals) && metadata.similaritySignals.length > 0) {
    for (const signal of metadata.similaritySignals) {
      if (PUBLIC_INTELLIGENCE_5K1_REJECTED_IDENTITY_SIGNALS.includes(signal)) refused.push(signal);
    }
  }
  // A cashtag or hashtag in free text is a symbol mention, never an address.
  if (/[$#][A-Za-z0-9]{1,10}/.test(text)) refused.push('SYMBOL_ONLY');
  return Object.freeze([...new Set(refused)].sort());
}

// ---------------------------------------------------------------------------
// MISSINGNESS
// ---------------------------------------------------------------------------

/**
 * Missingness is explicit and per-field. Every optional field is reported as an
 * OBSERVED value or an explicit missing state; nothing is coerced to 0, '',
 * false, or the current clock.
 *
 * Note the asymmetry that keeps this honest: a provider-supplied engagement
 * count of 0 is OBSERVED (a post with zero likes is a real measurement), while
 * an absent engagement count is NO_OBSERVATION and stays null.
 */
export function resolveMissingness(raw, assetAssociation) {
  const M = PUBLIC_INTELLIGENCE_MISSINGNESS;
  const metadata = raw.rawMetadata;
  const engagement = metadata.engagement ?? null;

  const fields = {
    publishedAt: raw.publishedAt === null ? M.NOT_YET_PUBLISHED : M.OBSERVED,
    observedAt: raw.observedAt === null ? M.NO_OBSERVATION : M.OBSERVED,
    providerAuthorId: raw.providerAuthorId === null ? M.NO_OBSERVATION : M.OBSERVED,
    sourceUrl: raw.sourceUrl === null ? M.NO_OBSERVATION : M.OBSERVED,
    engagement: engagement === null ? M.NO_OBSERVATION : M.OBSERVED,
    // An unassociated observation is not missing evidence; it is a complete
    // observation that simply carries no exact mint. Naming it NO_OBSERVATION
    // would overstate what we know, so it gets its own explicit state.
    assetAssociation: assetAssociation.status === PUBLIC_INTELLIGENCE_5K1_ASSOCIATION_STATUS.EXACT_MINT
      ? M.OBSERVED
      : M.ASSOCIATION_UNAVAILABLE,
    metadata: M.OBSERVED,
  };
  return Object.freeze({ ...fields, allExplicit: true, zeroSubstitution: false });
}

/**
 * Public engagement counts: exactly the provider supplied them, or nothing.
 * A partially supplied object is carried with its absent keys simply absent;
 * absent keys are NOT filled with 0.
 */
export function resolveEngagement(raw) {
  const engagement = raw.rawMetadata.engagement ?? null;
  if (engagement === null) {
    return Object.freeze({
      status: PUBLIC_INTELLIGENCE_MISSINGNESS.NO_OBSERVATION,
      values: null,
      providerSupplied: false,
      zeroFillingApplied: false,
    });
  }
  const values = {};
  for (const key of Object.keys(engagement).sort()) values[key] = engagement[key];
  return Object.freeze({
    status: PUBLIC_INTELLIGENCE_MISSINGNESS.OBSERVED,
    values: Object.freeze(values),
    providerSupplied: true,
    zeroFillingApplied: false,
  });
}

// ---------------------------------------------------------------------------
// CANONICAL TEXT
// ---------------------------------------------------------------------------

/**
 * A deterministic, purely structural projection of the raw text. It is NOT
 * evidence: the preserved rawText travels alongside it untouched. Only line
 * endings are normalized, because CRLF and LF denote the same line and their
 * difference is a transport artifact rather than content.
 *
 * No lowercasing, stemming, truncation, tokenization, stop-word removal or
 * anything else that would discard information.
 */
export function canonicalTextOf(raw) {
  return Object.freeze({
    value: raw.rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n'),
    derived: true,
    rawPreserved: true,
    lossy: false,
    lineEndingNormalizationOnly: true,
  });
}

// ---------------------------------------------------------------------------
// NORMALIZATION (pure, non-mutating)
// ---------------------------------------------------------------------------

/**
 * Normalizes one canonical raw observation into the frozen normalized record.
 *
 * Non-mutation is PROVEN, not asserted: the raw fingerprint is taken before
 * and after normalization and the two must be identical, or the call throws.
 * A normalization bug therefore cannot silently corrupt evidence.
 *
 * Deterministic: identical raw input always yields an identical normalized
 * record, because every derived value is a pure function of raw evidence.
 */
export function normalizeObservation5K1(raw) {
  validateRawObservation5K1(raw);
  const fingerprintBefore = rawObservationFingerprint(raw);

  const assetAssociation = resolveAssetAssociation(raw);
  const provenance = buildProvenance(raw);
  const canonicalText = canonicalTextOf(raw);
  const engagement = resolveEngagement(raw);
  const missingness = resolveMissingness(raw, assetAssociation);

  // Availability for look-ahead purposes is the fetch instant: the only clock
  // EVOLVE actually controls. Reused from 5K.0's no-hidden-look-ahead rule.
  if (!isValidTimestamp(raw.fetchedAt)) failClosed('PUBLIC_INTELLIGENCE_5K1_AVAILABILITY_UNDETERMINED');

  const normalized = {
    schemaVersion: PUBLIC_INTELLIGENCE_SCHEMA_VERSION,
    recordType: PUBLIC_INTELLIGENCE_RECORD_TYPES.NORMALIZED_SOCIAL_OBSERVATION,
    phase: 'PHASE_5K_1',
    rawObservationFingerprint: fingerprintBefore,
    // Raw evidence travels with the normalized record. It is the same frozen
    // object, carried by reference - never a rewritten copy of it.
    raw,
    provider: raw.provider,
    providerObservationId: raw.providerObservationId,
    providerAuthorId: raw.providerAuthorId,
    sourceType: raw.sourceType,
    sourceUrl: raw.sourceUrl,
    dedupIdentity: dedupIdentity5K1(raw),
    canonicalText: canonicalText.value,
    canonicalTextFingerprint: contentFingerprint(canonicalText.value),
    normalizedAuthorIdentity: Object.freeze({
      status: raw.providerAuthorId === null
        ? PUBLIC_INTELLIGENCE_MISSINGNESS.NO_OBSERVATION
        : PUBLIC_INTELLIGENCE_MISSINGNESS.OBSERVED,
      value: raw.providerAuthorId,
      // Never enriched, never resolved to a real name, never deanonymized.
      enriched: false,
      deanonymized: false,
    }),
    publishedAt: raw.publishedAt,
    observedAt: raw.observedAt,
    fetchedAt: raw.fetchedAt,
    availabilityAt: raw.fetchedAt,
    assetAssociation,
    engagement,
    missingness,
    provenance,
    classification: PUBLIC_INTELLIGENCE_CLASSIFICATION,
  };

  assertClosedNormalized5K1(normalized);

  // PROOF of non-mutation: raw evidence is bit-identical after normalization.
  const fingerprintAfter = rawObservationFingerprint(raw);
  if (fingerprintAfter !== fingerprintBefore) {
    failClosed('PUBLIC_INTELLIGENCE_5K1_NORMALIZATION_MUTATED_RAW');
  }
  return deepFreezeNormalized(normalized);
}

function assertClosedNormalized5K1(normalized) {
  const allowed = new Set(PUBLIC_INTELLIGENCE_5K1_NORMALIZED_SCHEMA.fields);
  for (const key of Object.keys(normalized)) {
    if (!allowed.has(key)) failClosed(`PUBLIC_INTELLIGENCE_5K1_NORMALIZED_UNKNOWN_FIELD:${key}`);
  }
  for (const key of PUBLIC_INTELLIGENCE_5K1_NORMALIZED_SCHEMA.fields) {
    if (normalized[key] === undefined) failClosed(`PUBLIC_INTELLIGENCE_5K1_NORMALIZED_FIELD_MISSING:${key}`);
  }
  // An EXACT_MINT association must carry a mint, and only an EXACT_MINT
  // association may carry one. This is checked in both directions.
  const association = normalized.assetAssociation;
  if (association.status === PUBLIC_INTELLIGENCE_5K1_ASSOCIATION_STATUS.EXACT_MINT) {
    if (canonicalMintAddress(association.mint) === null) {
      failClosed('PUBLIC_INTELLIGENCE_5K1_EXACT_MINT_WITHOUT_MINT');
    }
    if (association.method !== PUBLIC_INTELLIGENCE_5K1_ASSOCIATION_METHODS.EXACT_MINT_ADDRESS) {
      failClosed('PUBLIC_INTELLIGENCE_5K1_EXACT_MINT_BAD_METHOD');
    }
  } else if (association.mint !== null) {
    failClosed('PUBLIC_INTELLIGENCE_5K1_NON_EXACT_ASSOCIATION_CARRIES_MINT');
  }
  return true;
}

function deepFreezeNormalized(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreezeNormalized(entry);
  }
  return value;
}

/** Canonical, deterministic fingerprint over the whole normalized record. */
export function normalizedFingerprint5K1(normalized) {
  return digest(normalized);
}

/**
 * A normalized record must trace back to exactly the raw evidence it claims.
 * Delegates to the provenance verifier so both modules agree on one rule.
 */
export { verifyProvenance5K1 } from './provenance.mjs';

/** True when the record was available at or before the reference instant. */
export function isAvailableAt5K1(record, referenceAt) {
  if (!isValidTimestamp(referenceAt)) return false;
  const available = record?.availabilityAt;
  if (!isValidTimestamp(available)) return false;
  return available <= referenceAt;
}

/** Fails closed rather than admitting future evidence. */
export function selectAvailableAt5K1(records, referenceAt) {
  if (!isValidTimestamp(referenceAt)) return Object.freeze([]);
  return Object.freeze(records.filter(record => isAvailableAt5K1(record, referenceAt)));
}

/** True when two records denote the same upstream observation. */
export function sameUpstreamObservation5K1(a, b) {
  if (!a || !b) return false;
  return a.provider === b.provider && a.dedupIdentity === b.dedupIdentity;
}
