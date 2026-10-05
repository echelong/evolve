// Phase 5K.6 - BLUESKY PROVIDER REVISION EVIDENCE (content-addressed).
//
// PURE AND OFFLINE BY CONSTRUCTION. No socket, no clock, no environment.
//
// WHY THIS IS STRONGER THAN AN EDIT TIMESTAMP
//
// The AT Protocol repository spec states that a repository is a content-addressed
// Merkle tree whose paths are `<collection>/<record-key>`, and that "creating,
// updating, or deleting records ... changes the root hash value of the overall
// repository tree". For an individual record, the consequence is precise and is
// what this module relies on:
//
//   SAME AT URI + SAME CID  => the record at that path is byte-for-byte the
//                             same content. One content version.
//
//   SAME AT URI + DIFFERENT CID
//                          => the record at that path was UPDATED. The AT URI
//                             did not change (the path is stable); only the
//                             content address did. This is provider-declared,
//                             cryptographically self-certifying evidence of a
//                             content revision.
//
// No timestamp is needed, and none is invented. An update that produced CID Y
// necessarily happened at some instant strictly AFTER the acquisition that
// observed CID X, because at that earlier instant the record demonstrably still
// had CID X. The ordering proof is therefore implicit in the CIDs themselves and
// is strictly sound - it cannot be satisfied by two unrelated observations.
//
// WHAT IS NOT CLAIMED
//
// A CID difference is never inferred from text. The claim is made ONLY when the
// provider itself returned a different CID for the same AT URI. And because a
// single acquisition cannot produce two CIDs for one path, a CID change is only
// ever observed ACROSS two acquisitions - which is exactly the situation 5K.5's
// temporal classification operates on.
import { PUBLIC_INTELLIGENCE_CLASSIFICATION, canonical, digest } from '../definition.mjs';
import { failClosed } from '../observation.mjs';
import { PUBLIC_INTELLIGENCE_5K5_SCHEMA_VERSION } from '../temporal-projection.mjs';
import {
  PUBLIC_INTELLIGENCE_5K5_TEMPORAL_CLASSIFICATION, PUBLIC_INTELLIGENCE_5K5_TEMPORAL_CLASSIFICATIONS,
} from '../revision-chain.mjs';
import { assertProviderCid, isBlueskyPostUri, BLUESKY_PROVIDER_NAMESPACE } from './bluesky-common.mjs';

export { PUBLIC_INTELLIGENCE_5K5_SCHEMA_VERSION, PUBLIC_INTELLIGENCE_CLASSIFICATION };

// ---------------------------------------------------------------------------
// THE ADDITIVE, PROVIDER-NATIVE REVISION SIDECAR
// ---------------------------------------------------------------------------
// 5K.5's revision-evidence schema is CLOSED and keyed on a provider EDIT
// TIMESTAMP (`providerRevisionTimestamp`), because Mastodon publishes
// `edited_at`. Bluesky publishes no such field: its revision signal is the
// record's content address. The honest options were to edit the frozen 5K.1 raw
// schema or to add a provider-specific sidecar. This is the sidecar.
//
// It is additive, it never touches a 5K.1 record, it binds to the exact
// `rawObservationFingerprint` it describes, and it is a CLOSED schema of its own
// so no field can ever be smuggled through it.
export const BLUESKY_REVISION_EVIDENCE_RECORD_TYPE = 'public_bluesky_content_revision_evidence';
export const PUBLIC_INTELLIGENCE_5K6_SCHEMA_VERSION = '5K.6.0';
export const BLUESKY_REVISION_EVIDENCE_SOURCE = 'AT_PROTOCOL_RECORD_CID';

export const BLUESKY_REVISION_EVIDENCE_SCHEMA = Object.freeze({
  closed: true,
  fields: Object.freeze([
    'schemaVersion', 'recordType', 'provider', 'providerObservationId',
    'rawObservationFingerprint', 'providerContentCid', 'evidenceSource',
    'classification', 'revisionEvidenceFingerprint',
  ]),
});

const FINGERPRINT = /^[0-9a-f]{64}$/;

/**
 * Builds the sidecar for ONE observation. Pure: no clock, no network, no fs.
 *
 * The fingerprint digests everything EXCEPT itself, so the record is
 * self-verifying: tampering with the CID, the URI or the bound fingerprint
 * changes the digest and is refused by `validateBlueskyRevisionEvidence`.
 */
export function buildProviderRevisionEvidence({
  provider, providerObservationId, rawObservationFingerprint, providerContentCid,
}) {
  if (provider !== BLUESKY_PROVIDER_NAMESPACE) failClosed('PUBLIC_INTELLIGENCE_5K6_REVISION_PROVIDER_INVALID');
  if (!isBlueskyPostUri(providerObservationId)) failClosed('PUBLIC_INTELLIGENCE_5K6_REVISION_NOT_A_POST_URI');
  if (!FINGERPRINT.test(String(rawObservationFingerprint))) failClosed('PUBLIC_INTELLIGENCE_5K6_REVISION_FINGERPRINT_INVALID');
  const cid = assertProviderCid(providerContentCid);
  const record = {
    schemaVersion: PUBLIC_INTELLIGENCE_5K6_SCHEMA_VERSION,
    recordType: BLUESKY_REVISION_EVIDENCE_RECORD_TYPE,
    provider,
    providerObservationId,
    rawObservationFingerprint,
    providerContentCid: cid,
    evidenceSource: BLUESKY_REVISION_EVIDENCE_SOURCE,
    classification: PUBLIC_INTELLIGENCE_CLASSIFICATION,
classification: PUBLIC_INTELLIGENCE_CLASSIFICATION,
  };
  return Object.freeze({ ...record, revisionEvidenceFingerprint: digest(record) });
}
/** Bluesky revision evidence carries a CID and never an edit timestamp. */
export const BLUESKY_REVISION_SEMANTICS = Object.freeze({
  provider: BLUESKY_PROVIDER_NAMESPACE,
  proofKind: 'CONTENT_ADDRESS_CHANGE',
  proofSource: 'AT_PROTOCOL_RECORD_CID',
  requiresProviderDeclaration: true,
  requiresEditTimestamp: false,
  editTimestampAvailable: false,
  inferredFromTextChange: false,
  inferredFromCounterChange: false,
  contentAddressIsCryptographic: true,
  sameUriSameCidIsSameVersion: true,
  sameUriDifferentCidIsRevision: true,
  historicalVersionsRetained: true,
  latestWinsMutation: false,
  classifiesAs: PUBLIC_INTELLIGENCE_5K5_TEMPORAL_CLASSIFICATIONS,
});

/** Validates a sidecar: closed schema plus self-verifying digest. */
export function validateBlueskyRevisionEvidence(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) failClosed('PUBLIC_INTELLIGENCE_5K6_REV_EVIDENCE_NOT_AN_OBJECT');
  for (const key of Object.keys(record)) {
    if (!BLUESKY_REVISION_EVIDENCE_SCHEMA.fields.includes(key)) failClosed(`PUBLIC_INTELLIGENCE_5K6_REV_EVIDENCE_UNKNOWN_FIELD:${String(key).slice(0, 40)}`);
  }
  for (const key of BLUESKY_REVISION_EVIDENCE_SCHEMA.fields) {
    if (!Object.hasOwn(record, key)) failClosed(`PUBLIC_INTELLIGENCE_5K6_REV_EVIDENCE_FIELD_MISSING:${key}`);
  }
  if (record.schemaVersion !== PUBLIC_INTELLIGENCE_5K6_SCHEMA_VERSION
    || record.recordType !== BLUESKY_REVISION_EVIDENCE_RECORD_TYPE) {
    failClosed('PUBLIC_INTELLIGENCE_5K6_REV_EVIDENCE_TYPE_INVALID');
  }
  if (record.provider !== BLUESKY_PROVIDER_NAMESPACE) failClosed('PUBLIC_INTELLIGENCE_5K6_REV_EVIDENCE_PROVIDER_INVALID');
  if (!isBlueskyPostUri(record.providerObservationId)) failClosed('PUBLIC_INTELLIGENCE_5K6_REVISION_NOT_A_POST_URI');
  for (const key of ['rawObservationFingerprint', 'revisionEvidenceFingerprint']) {
    if (!FINGERPRINT.test(record[key])) failClosed(`PUBLIC_INTELLIGENCE_5K6_REV_EVIDENCE_FINGERPRINT_INVALID:${key}`);
  }
  assertProviderCid(record.providerContentCid);
  if (record.evidenceSource !== BLUESKY_REVISION_EVIDENCE_SOURCE) failClosed('PUBLIC_INTELLIGENCE_5K6_REV_EVIDENCE_SOURCE_INVALID');
  if (canonical(record.classification) !== canonical(PUBLIC_INTELLIGENCE_CLASSIFICATION)) {
    failClosed('PUBLIC_INTELLIGENCE_5K6_REV_EVIDENCE_CLASSIFICATION_OVERRIDE_REFUSED');
  }
  const expected = digest((() => { const b = { ...record }; delete b.revisionEvidenceFingerprint; return b; })());
  if (record.revisionEvidenceFingerprint !== expected) failClosed('PUBLIC_INTELLIGENCE_5K6_REV_EVIDENCE_FINGERPRINT_MISMATCH');
  return record;
}

/**
 * Indexes sidecars by the raw fingerprint each one is bound to.
 *
 * No latest-wins and no overwrite: two sidecars for the SAME raw fingerprint is
 * a hard refusal, and each distinct raw fingerprint keeps its own entry, so
 * every historical version survives rather than collapsing.
 */
export function indexBlueskyRevisionEvidence(records, knownRawFingerprints) {
  const index = new Map();
  for (const record of records ?? []) {
    validateBlueskyRevisionEvidence(record);
    if (knownRawFingerprints && !knownRawFingerprints.has(record.rawObservationFingerprint)) {
      failClosed(`PUBLIC_INTELLIGENCE_5K6_REV_EVIDENCE_BOUND_TO_UNKNOWN_EVIDENCE:${record.rawObservationFingerprint.slice(0, 16)}`);
    }
    if (index.has(record.rawObservationFingerprint)) failClosed('PUBLIC_INTELLIGENCE_5K6_REV_EVIDENCE_DUPLICATE_BINDING');
    index.set(record.rawObservationFingerprint, record.providerContentCid);
  }
  return index;
}

/** The provider content address bound to one observation, or null if unproven. */
export function providerContentCidOf(index, rawObservationFingerprint) {
  return index?.get(rawObservationFingerprint) ?? null;
}

/**
 * Bluesky content-version decision for one authenticated acquisition.
 *
 * This deliberately does NOT rewrite 5K.5 `classifyTemporal`, which reasons over
 * a provider edit TIMESTAMP and stays byte-untouched for Mastodon. Bluesky
 * reasons over the content address instead:
 *
 *   same URI + same CID      => the same content version
 *   same URI + different CID => a genuine provider-declared revision
 *   no CID declared          => no proof, so UNVERIFIED_CONTENT_DIVERGENCE
 *
 * A text change alone is never sufficient; only a provider-declared CID
 * difference is.
 */
export function classifyBlueskyRevision({ previousProviderContentCid, currentProviderContentCid, currentContentFingerprint, previousContentFingerprint }) {
  if (currentContentFingerprint === previousContentFingerprint) {
    return PUBLIC_INTELLIGENCE_5K5_TEMPORAL_CLASSIFICATION.SAME_CONTENT_SAME_STATE;
  }
  if (typeof currentProviderContentCid !== 'string' || typeof previousProviderContentCid !== 'string') {
    return PUBLIC_INTELLIGENCE_5K5_TEMPORAL_CLASSIFICATION.UNVERIFIED_CONTENT_DIVERGENCE;
  }
  if (currentProviderContentCid === previousProviderContentCid) {
    // The provider says this is ONE content version, so EVOLVE cannot call the
    // differing fingerprint a revision.
    return PUBLIC_INTELLIGENCE_5K5_TEMPORAL_CLASSIFICATION.UNVERIFIED_CONTENT_DIVERGENCE;
  }
  return PUBLIC_INTELLIGENCE_5K5_TEMPORAL_CLASSIFICATION.PROVIDER_DECLARED_CONTENT_REVISION;
}

/** Re-derives the CID for one view and builds the sidecar for it. */
export function blueskyRevisionEvidenceFor(view, raw) {
  if (!isBlueskyPostUri(view?.uri)) failClosed('PUBLIC_INTELLIGENCE_5K6_REVISION_NOT_A_POST_URI');
  return buildProviderRevisionEvidence({
    provider: raw.provider,
    providerObservationId: raw.providerObservationId,
    rawObservationFingerprint: raw.rawObservationFingerprint,
    providerContentCid: assertProviderCid(view?.cid),
  });
}
